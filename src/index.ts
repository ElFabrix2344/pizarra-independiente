import { verifyAccess } from './auth/access';
import { isLocalDev, type Env } from './env';
import { ApiError, errorResponse, escapeHtml, htmlPage, json } from './lib/http';
import { GoogleError } from './lib/google';
import { handleOAuth } from './oauth';
import { connectionStatus, getGoogleAccessToken, getTickTickClient } from './providers';
import { getPanelCalendar } from './services/calendar';
import { getEvaluations, getPanelTasks, ttCall, type Strategy } from './services/tasks';

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
  async fetch(req: Request, rawEnv: Env, _ctx: ExecutionContext): Promise<Response> {
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
      res = (await route(req, env, url)) ?? (await env.ASSETS.fetch(req));
    } catch (e) {
      res = errorResponse(e);
    }
    return withSecurityHeaders(res);
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response | null> {
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
        return json(await getEvaluations(client, { now: new Date(), timeZone: tz, strategy, limit }));
      }

      case '/api/calendar':
        return json(await calendarWithRetry(env, url, tz));

      case '/api/debug/ticktick':
        return json(await debugTickTick(env, url, tz));
    }
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
    return json({ ok: true, projectId, taskId });
  }

  throw new ApiError('not_found', 404, 'Ruta no encontrada.');
}

/** Si el access token en caché fue revocado, Google responde 401: se descarta y se reintenta una vez. */
async function calendarWithRetry(env: Env, url: URL, tz: string) {
  for (let attempt = 0; ; attempt++) {
    const { token, fetch: f } = await getGoogleAccessToken(env, url);
    try {
      return await getPanelCalendar(token, { now: new Date(), timeZone: tz, fetch: f });
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
  // Todo es privado: nada en cachés compartidas; el HTML/JS se revalida siempre.
  if (!h.has('Cache-Control') || !h.get('Cache-Control')!.includes('no-store')) h.set('Cache-Control', 'private, no-cache');
  return r;
}
