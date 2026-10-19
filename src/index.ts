import { verifyAccess } from './auth/access';
import { isLocalDev, type Env } from './env';
import { ApiError, errorResponse, escapeHtml, htmlPage, json } from './lib/http';
import { GoogleError } from './lib/google';
import { handleOAuth } from './oauth';
import { connectionStatus, getGoogleAccessToken, getTickTickClient } from './providers';
import { getPanelCalendar } from './services/calendar';
import { noteStatus, recordNoteError, saveContext, syncNote } from './services/claudeNote';
import { buildResult, GradeStore, validateCourse, validatePrior } from './services/grades';
import { getEvaluations, getIgnoredEvals, getPanelTasks, ignoreEval, restoreEvals, ttCall, type Strategy } from './services/tasks';
import {
  addManual,
  getHistory,
  getStudy,
  defaultCycleStart,
  loadCourses,
  visibleCourses,
  weekRange,
  pauseStudy,
  resumeStudy,
  saveCourses,
  saveCycleStart,
  saveGoals,
  startStudy,
  stopStudy,
  StudyStore,
  validCycleStart,
} from './services/study';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export default {
  async fetch(req: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
    const env = trimSecrets(rawEnv);
    const url = new URL(req.url);
    const local = isLocalDev(url, env);

    if (!local) {
      const auth = await verifyAccess(req, env);
      if (!auth.ok) {
        return withSecurityHeaders(htmlPage('Acceso restringido', `<p>${escapeHtml(auth.reason)}</p>`, auth.status));
      }
    }

    let res: Response;
    try {
      res = (await route(req, env, url, ctx)) ?? (await env.ASSETS.fetch(req));
    } catch (e) {
      res = errorResponse(e);
    }
    return withSecurityHeaders(res);
  },

  /** Cada 2 horas (wrangler.jsonc → triggers): revisa la nota de Claude por si hubo sesiones desde la app de TickTick. */
  async scheduled(_ctrl: ScheduledController, rawEnv: Env, ctx: ExecutionContext): Promise<void> {
    const env = trimSecrets(rawEnv);
    // En desarrollo local (DEV_MODE) se usa una URL de localhost para que MOCK_DATA aplique y nunca toque el TickTick real.
    const url = new URL(env.DEV_MODE === 'true' ? 'http://localhost/' : 'https://cron.invalid/');
    ctx.waitUntil(runNoteSync(env, url, env.TIMEZONE || 'America/Lima'));
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response | null> {
  const p = url.pathname;

  if (p.startsWith('/oauth/')) return handleOAuth(req, env, url);
  if (!p.startsWith('/api/')) return null;

  const tz = env.TIMEZONE || 'America/Lima';
  const strategy = pickStrategy(url, env);

  if (req.method === 'GET') {
    switch (p) {
      case '/api/status':
        return json({ ...(await connectionStatus(env, url)), timeZone: tz, now: new Date().toISOString() });

      case '/api/tasks': {
        const { client } = await getTickTickClient(env, url);
        return json(await getPanelTasks(client, { now: new Date(), timeZone: tz, strategy }));
      }

      case '/api/evaluations': {
        const { client } = await getTickTickClient(env, url);
        const limit = clampInt(url.searchParams.get('limit'), 1, 50, 6);
        const ignored = await getIgnoredEvals(env.TOKENS);
        return json(await getEvaluations(client, { now: new Date(), timeZone: tz, strategy, limit, ignored }));
      }

      case '/api/calendar':
        return json(await calendarWithRetry(env, url, tz));

      case '/api/debug/ticktick':
        return json(await debugTickTick(env, url, tz));

      case '/api/study': {
        const { client } = await getTickTickClient(env, url);
        const [study, note] = await Promise.all([
          ttCall(() => getStudy(client, studyStore(env, url), { now: new Date(), timeZone: tz })),
          noteStatus(env.TOKENS),
        ]);
        return json({ ...study, note });
      }

      case '/api/grades': {
        const g = await gradesContext(env, url, tz);
        const book = await g.store.get(g.cycleStart);
        return json(buildResult(book, g.courses));
      }

      case '/api/study/history': {
        const { client } = await getTickTickClient(env, url);
        return json(await ttCall(() => getHistory(client, studyStore(env, url), { now: new Date(), timeZone: tz })));
      }
    }
  }

  if (p.startsWith('/api/study/')) {
    const res = await studyAction(req, env, url, tz);
    syncLater(ctx, env, url, tz);
    return res;
  }

  // Nota «resumen para Claude» en TickTick: contexto escrito a mano y actualización inmediata.
  if (p === '/api/claude-note/context' || p === '/api/claude-note/sync') {
    if (req.method !== (p.endsWith('/sync') ? 'POST' : 'PUT')) throw new ApiError('bad_request', 405, 'Método no permitido.');
    assertSameOrigin(req, url);
    if (p.endsWith('/context')) await saveContext(env.TOKENS, (await readJson(req)).text);
    await runNoteSync(env, url, tz, true);
    return json(await noteStatus(env.TOKENS));
  }

  if (p === '/api/grades/course' || p === '/api/grades/prior') {
    if (req.method !== 'PUT') throw new ApiError('bad_request', 405, 'Usa PUT.');
    assertSameOrigin(req, url);
    const body = await readJson(req);
    const g = await gradesContext(env, url, tz);
    const book = await g.store.get(g.cycleStart);
    if (p.endsWith('/prior')) {
      book.prior = validatePrior(body);
    } else {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!g.courses.includes(name) && !book.courses[name]) throw new ApiError('bad_request', 400, `Curso desconocido: ${name}`);
      book.courses[name] = validateCourse(body);
    }
    await g.store.put(book);
    // Sin inicio de ciclo guardado, la fecha por defecto avanza cada lunes (y con ella el libro): se fija al guardar notas.
    if (!g.pinned) await saveCycleStart(g.study, g.cycleStart, { now: new Date(), timeZone: tz });
    syncLater(ctx, env, url, tz);
    return json(buildResult(book, g.courses));
  }

  // Ocultar una "evaluación" que no lo es (p. ej. una tarea de práctica) o restaurarlas todas.
  if (p === '/api/evaluations/ignore' || p === '/api/evaluations/restore') {
    if (req.method !== 'POST') throw new ApiError('bad_request', 405, 'Usa POST.');
    assertSameOrigin(req, url);
    if (p.endsWith('/restore')) {
      const r = await restoreEvals(env.TOKENS);
      syncLater(ctx, env, url, tz);
      return json(r);
    }
    const body = await readJson(req);
    const taskId = typeof body.taskId === 'string' ? body.taskId : '';
    if (!ID_RE.test(taskId)) throw new ApiError('bad_request', 400, 'Identificador inválido.');
    const r = await ignoreEval(env.TOKENS, taskId);
    syncLater(ctx, env, url, tz);
    return json(r);
  }

  const m = p.match(/^\/api\/tasks\/([^/]+)\/([^/]+)\/complete$/);
  if (m) {
    if (req.method !== 'POST') throw new ApiError('bad_request', 405, 'Usa POST.');
    assertSameOrigin(req, url);
    const projectId = decodeURIComponent(m[1]!);
    const taskId = decodeURIComponent(m[2]!);
    if (!ID_RE.test(projectId) || !ID_RE.test(taskId)) throw new ApiError('bad_request', 400, 'Identificador inválido.');
    const { client } = await getTickTickClient(env, url);
    await ttCall(() => client.completeTask(projectId, taskId));
    syncLater(ctx, env, url, tz);
    return json({ ok: true, projectId, taskId });
  }

  throw new ApiError('not_found', 404, 'Ruta no encontrada.');
}

/**
 * Revisa y reescribe la nota «resumen para Claude» en TickTick. Nunca lanza: si falla
 * (p. ej. TickTick desconectado), guarda el error para mostrarlo en la Bitácora.
 */
async function runNoteSync(env: Env, url: URL, tz: string, force = false): Promise<void> {
  try {
    const { client } = await getTickTickClient(env, url);
    await syncNote(client, env.TOKENS, { now: new Date(), timeZone: tz, strategy: pickStrategy(url, env), force });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('Nota para Claude:', msg);
    await recordNoteError(env.TOKENS, msg).catch(() => {});
  }
}

/** Después de una acción que cambia datos: la nota se actualiza en segundo plano, sin demorar la respuesta. */
function syncLater(ctx: ExecutionContext, env: Env, url: URL, tz: string) {
  ctx.waitUntil(runNoteSync(env, url, tz));
}

/** Ciclo actual y cursos visibles (los mismos de Estudio) para el registro de notas. */
async function gradesContext(env: Env, url: URL, tz: string) {
  const { client } = await getTickTickClient(env, url);
  const study = studyStore(env, url);
  const now = new Date();
  const [cat, settings] = await ttCall(() => Promise.all([loadCourses(client, now.getTime()), study.getSettings()]));
  return {
    store: new GradeStore(env.TOKENS),
    study,
    cycleStart: settings.cycleStart ?? defaultCycleStart(weekRange(now, tz).monday),
    /** ¿La fecha de inicio está guardada? Si no, es la de por defecto, que se mueve cada semana. */
    pinned: !!settings.cycleStart,
    courses: visibleCourses(cat, settings),
  };
}

/** Acciones de estudio (todas modifican estado: POST/PUT/DELETE con protección CSRF). */
async function studyAction(req: Request, env: Env, url: URL, tz: string): Promise<Response> {
  if (req.method === 'GET') throw new ApiError('bad_request', 405, 'Método no permitido.');
  assertSameOrigin(req, url);
  const { client } = await getTickTickClient(env, url);
  const store = studyStore(env, url);
  const p = url.pathname;
  const body = req.method === 'DELETE' ? {} : await readJson(req);

  if (p === '/api/study/start' && req.method === 'POST') return json(await ttCall(() => startStudy(client, store, body.course)));
  if (p === '/api/study/pause' && req.method === 'POST') return json(await pauseStudy(store));
  if (p === '/api/study/resume' && req.method === 'POST') return json(await resumeStudy(store));
  if (p === '/api/study/stop' && req.method === 'POST') return json(await ttCall(() => stopStudy(client, store)));
  if (p === '/api/study/cancel' && req.method === 'POST') {
    await store.clearActive();
    return json({ ok: true });
  }
  if (p === '/api/study/manual' && req.method === 'POST') return json(await ttCall(() => addManual(client, store, body, { now: new Date(), timeZone: tz })));
  if (p === '/api/study/cycle' && req.method === 'PUT') {
    // Las notas se guardan por inicio de ciclo: primero se mueve el libro (si es un ajuste) y luego se guarda la fecha.
    const opts = { now: new Date(), timeZone: tz };
    const start = validCycleStart(body.start, opts);
    const prev = (await store.getSettings()).cycleStart ?? defaultCycleStart(weekRange(opts.now, tz).monday);
    const grades = await new GradeStore(env.TOKENS).followCycle(prev, start);
    return json({ ...(await saveCycleStart(store, start, opts)), grades });
  }
  if (p === '/api/study/courses' && req.method === 'PUT') return json(await ttCall(() => saveCourses(client, store, body)));
  if (p === '/api/study/goals' && req.method === 'PUT') return json(await ttCall(() => saveGoals(client, store, body.goals, body.daily)));

  const m = p.match(/^\/api\/study\/sessions\/([01])\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    const id = decodeURIComponent(m[2]!);
    if (!ID_RE.test(id)) throw new ApiError('bad_request', 400, 'Identificador inválido.');
    await ttCall(() => client.deleteFocus(id, Number(m[1]) as 0 | 1));
    return json({ ok: true, id });
  }
  throw new ApiError('not_found', 404, 'Ruta no encontrada.');
}

/** Cronómetro activo y metas: en el mismo KV (en local, el KV simulado de wrangler dev). */
function studyStore(env: Env, _url: URL) {
  return new StudyStore(env.TOKENS);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 10_000) throw new ApiError('bad_request', 413, 'Cuerpo demasiado grande.');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* cae al error */
  }
  throw new ApiError('bad_request', 400, 'JSON inválido.');
}

/** Si el access token en caché fue revocado, Google responde 401: se descarta y se reintenta una vez. */
async function calendarWithRetry(env: Env, url: URL, tz: string) {
  for (let attempt = 0; ; attempt++) {
    const { token, fetch: f } = await getGoogleAccessToken(env, url);
    try {
      return await getPanelCalendar(token, { now: new Date(), timeZone: tz, fetch: f, calendarIds: env.CALENDAR_IDS });
    } catch (e) {
      if (e instanceof GoogleError) {
        if (e.status === 401 && attempt === 0) {
          await env.TOKENS.delete('google:access');
          continue;
        }
        if (e.status === 401 || e.status === 403) {
          throw new ApiError('reauth_required', 409, 'Google rechazó el acceso al calendario. Vuelve a conectar Google Calendar.', 'google');
        }
        console.error(e.message);
        throw new ApiError('upstream_error', 502, `Google Calendar respondió con un error (${e.status || 'sin respuesta'}).`, 'google');
      }
      throw e;
    }
  }
}

/**
 * Diagnóstico para validar con datos reales lo que la doc de TickTick no aclara:
 * si POST /task/undone filtra por dueDate o startDate (se compara con un recorrido
 * completo de proyectos) y qué campos/formatos de fecha llegan de verdad.
 */
async function debugTickTick(env: Env, url: URL, tz: string) {
  const { client, source } = await getTickTickClient(env, url);
  const now = new Date();
  const [undone, scan] = await Promise.all([
    getPanelTasks(client, { now, timeZone: tz, strategy: 'undone' }),
    getPanelTasks(client, { now, timeZone: tz, strategy: 'scan' }),
  ]);
  const a = new Set(undone.tasks.map((t) => t.id));
  const b = new Set(scan.tasks.map((t) => t.id));
  const raw = await ttCall(() => client.listUndone({ startDate: now, endDate: new Date(now.getTime() + 7 * 86400000) }));
  const keys = new Set<string>();
  for (const t of raw) Object.keys(t).forEach((k) => keys.add(k));
  return {
    source,
    counts: { undone: a.size, scan: b.size },
    onlyInUndone: undone.tasks.filter((t) => !b.has(t.id)).map((t) => ({ id: t.id, title: t.title, dayKey: t.dayKey })),
    onlyInScan: scan.tasks.filter((t) => !a.has(t.id)).map((t) => ({ id: t.id, title: t.title, dayKey: t.dayKey })),
    rawTaskFields: [...keys].sort(),
    rawDateSamples: raw.slice(0, 5).map((t) => ({ startDate: t.startDate, dueDate: t.dueDate, isAllDay: t.isAllDay, timeZone: t.timeZone, columnId: t.columnId })),
  };
}

/** Protección CSRF para POST: mismo origen y cabecera propia (fuerza preflight CORS desde otros sitios). */
function assertSameOrigin(req: Request, url: URL) {
  const origin = req.headers.get('Origin');
  if (origin !== url.origin || req.headers.get('X-Pizarra') !== '1') {
    throw new ApiError('forbidden', 403, 'Petición rechazada (origen no válido).');
  }
}

/** Quita espacios y saltos de línea pegados por accidente al cargar los secretos. */
function trimSecrets(env: Env): Env {
  const keys = [
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TICKTICK_CLIENT_ID', 'TICKTICK_CLIENT_SECRET',
    'TICKTICK_API_TOKEN', 'TOKEN_ENCRYPTION_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ALLOWED_EMAILS',
  ] as const;
  const out: Env = { ...env };
  for (const k of keys) if (typeof out[k] === 'string') out[k] = out[k]!.trim().replace(/^["']|["']$/g, '');
  return out;
}

function pickStrategy(url: URL, env: Env): Strategy {
  const q = url.searchParams.get('strategy') ?? env.TICKTICK_STRATEGY;
  return q === 'scan' ? 'scan' : 'undone';
}

function clampInt(v: string | null, min: number, max: number, dflt: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

function withSecurityHeaders(res: Response): Response {
  const r = new Response(res.body, res);
  const h = r.headers;
  h.set('Content-Security-Policy', CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Frame-Options', 'DENY');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  h.set('Strict-Transport-Security', 'max-age=31536000');
  // Hora del servidor (ms): el cronómetro de estudio la usa para no depender del reloj del dispositivo.
  h.set('X-Server-Time', String(Date.now()));
  // Todo es privado: nada en cachés compartidas; el HTML/JS se revalida siempre.
  if (!h.has('Cache-Control') || !h.get('Cache-Control')!.includes('no-store')) h.set('Cache-Control', 'private, no-cache');
  return r;
}
