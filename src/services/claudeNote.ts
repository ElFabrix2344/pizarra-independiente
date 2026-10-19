// Nota «resumen para Claude» en TickTick. La Bitácora la reescribe sola (tras cada cambio y cada
// 2 horas) para que los chats de Claude, con el conector de TickTick, sepan cómo van los estudios
// sin pegar nada a mano. En la memoria de Claude basta una línea: "lee primero esa nota".
//  - KV "claude:note":    dónde está la nota (lista y tarea), hash del contenido, revisión y error.
//  - KV "claude:context": texto libre que el usuario escribe en la Bitácora.

import { TickTickError, type TickTickClient, type TickTickTask } from '../lib/ticktick';
import { ApiError } from '../lib/http';
import { addDays, daysBetween } from '../lib/time';
import { buildResult, GradeStore, type CourseSummary, type GradesResult } from './grades';
import { getEvaluations, getIgnoredEvals, ttCall, type PanelEvaluation, type Strategy } from './tasks';
import { activeMs, getStudyDigest, StudyStore, type StudyDigest } from './study';

export const NOTE_TITLE = '📒 Bitácora — resumen para Claude';
export const NOTE_LIST = 'Bitácora';
export const CONTEXT_MAX = 1500;
const K_STATE = 'claude:note';
const K_CONTEXT = 'claude:context';

export interface NoteState {
  projectId?: string;
  taskId?: string;
  /** Hash del contenido sin la línea de fecha: si no cambia, no se reescribe. */
  hash?: string;
  /** Última revisión (ms), haya o no reescritura. */
  checkedAt?: number;
  /** Última vez que se escribió en TickTick (ms). */
  writtenAt?: number;
  error?: string | null;
  /** Lo último que se escribió (para "Ver lo que lee Claude" en la Bitácora). */
  content?: string;
}

export interface NoteContext {
  text: string;
  updatedAt: number | null;
}

// ---------- KV ----------

export async function getNoteState(kv: KVNamespace): Promise<NoteState> {
  return (await kv.get<NoteState>(K_STATE, 'json')) ?? {};
}

export async function getContext(kv: KVNamespace): Promise<NoteContext> {
  const c = await kv.get<NoteContext>(K_CONTEXT, 'json');
  return { text: c?.text ?? '', updatedAt: c?.updatedAt ?? null };
}

export async function saveContext(kv: KVNamespace, raw: unknown, now = Date.now()): Promise<NoteContext> {
  if (typeof raw !== 'string') throw new ApiError('bad_request', 400, 'Falta el texto del contexto.');
  const text = raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > CONTEXT_MAX) throw new ApiError('bad_request', 400, `El contexto puede tener hasta ${CONTEXT_MAX} caracteres.`);
  const c = { text, updatedAt: now };
  await kv.put(K_CONTEXT, JSON.stringify(c));
  return c;
}

/** Guarda el error de la última revisión (sin perder dónde está la nota). */
export async function recordNoteError(kv: KVNamespace, message: string, now = Date.now()) {
  const st = await getNoteState(kv);
  await kv.put(K_STATE, JSON.stringify({ ...st, checkedAt: now, error: message.slice(0, 300) }));
}

/** Lo que muestra la Bitácora: contexto, estado de la nota y su contenido. */
export async function noteStatus(kv: KVNamespace) {
  const [st, ctx] = await Promise.all([getNoteState(kv), getContext(kv)]);
  return {
    title: NOTE_TITLE,
    list: NOTE_LIST,
    context: ctx.text,
    contextUpdatedAt: ctx.updatedAt,
    checkedAt: st.checkedAt ?? null,
    writtenAt: st.writtenAt ?? null,
    error: st.error ?? null,
    url: st.projectId && st.taskId ? taskUrl(st.projectId, st.taskId) : null,
    content: st.content ?? null,
  };
}

const taskUrl = (projectId: string, taskId: string) =>
  `https://ticktick.com/webapp/#p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;

// ---------- datos ----------

export interface NoteInput {
  now: Date;
  timeZone: string;
  context: NoteContext;
  study: StudyDigest;
  evaluations: PanelEvaluation[];
  ignoredCount: number;
  grades: GradesResult | null;
}

export async function gatherNoteInput(
  client: TickTickClient,
  kv: KVNamespace,
  opts: { now: Date; timeZone: string; strategy: Strategy },
): Promise<NoteInput> {
  const { now, timeZone } = opts;
  return ttCall(async () => {
    const [study, ignored, context] = await Promise.all([
      getStudyDigest(client, new StudyStore(kv), { now, timeZone, weeks: 4 }),
      getIgnoredEvals(kv),
      getContext(kv),
    ]);
    const ev = await getEvaluations(client, { now, timeZone, strategy: opts.strategy, limit: 12, ignored });
    const book = await new GradeStore(kv).get(study.cycleStart);
    const grades = buildResult(book, study.courses.map((c) => c.name));
    return { now, timeZone, context, study, evaluations: ev.evaluations, ignoredCount: ev.ignoredCount, grades };
  });
}

// ---------- contenido ----------

const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DOW_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const dow = (k: string) => new Date(k + 'T12:00:00Z').getUTCDay();
const dm = (k: string) => `${k.slice(8, 10)}/${k.slice(5, 7)}`;
const dayLabel = (k: string) => `${DOW[dow(k)]} ${dm(k)}`;

export function fmtMinutes(m: number): string {
  m = Math.max(0, Math.round(m));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return `${h} h${r ? ' ' + String(r).padStart(2, '0') : ''}`;
}
const num = (x: number) => String(Number(x.toFixed(2)));

function weekdaysText(w: number[]): string {
  const key = [...w].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return 'de lunes a viernes';
  if (key === '1,2,3,4,5,6') return 'de lunes a sábado';
  if (key === '0,1,2,3,4,5,6') return 'todos los días';
  return 'los ' + w.map((x) => DOW_LONG[x]).join(', ');
}

/** Curso de una tarea: la columna en el inbox, o "lista · columna". */
function taskCourse(t: PanelEvaluation): string {
  if (t.column && t.projectId.startsWith('inbox')) return t.column;
  return [t.list, t.column].filter(Boolean).join(' · ');
}

/** Minutos por curso en orden de cursos visibles, con "Otros" al final; solo los que tienen tiempo. */
function breakdown(byCourse: Record<string, number>, other: number, order: string[]): string {
  const parts = order.filter((c) => (byCourse[c] ?? 0) > 0).map((c) => `${c} ${fmtMinutes(byCourse[c]!)}`);
  if (other > 0) parts.push(`Otros ${fmtMinutes(other)}`);
  return parts.join(' · ');
}

function gradeLine(c: CourseSummary): string | null {
  if (!c.items.length) return null;
  const cr = c.credits ? ` (${num(c.credits)} cr)` : '';
  if (c.final !== null) return `- ${c.name}${cr}: nota final ${c.final} (${c.final >= 11 ? 'aprobado' : 'desaprobado'}).`;
  if (c.average === null) return `- ${c.name}${cr}: aún sin notas (${num(c.totalWeight)} % por evaluar).`;
  let s = `- ${c.name}${cr}: promedio ${num(c.average)} en lo evaluado (${num(c.gradedWeight)} %); si sigue así, ${c.projected}.`;
  const need = (n: CourseSummary['pass'], what: string) =>
    n.status === 'possible' ? ` ${what}: necesita ${num(n.average!)} de promedio en lo que falta.`
      : n.status === 'secured' ? ` ${what}: asegurado.`
      : n.status === 'impossible' ? ` ${what}: ya no alcanza.` : '';
  s += need(c.pass, 'Para aprobar (11)');
  if (c.goal) s += need(c.goal, `Para su meta (${c.goal.target})`);
  if (!c.academic) s += ' No cuenta en el ponderado.';
  return s;
}

/**
 * Arma la nota. `body` es todo menos la línea con la fecha (se usa para saber si algo cambió);
 * `content` es lo que se escribe en TickTick.
 */
export function buildNote(input: NoteInput): { body: string; content: string } {
  const { study: d, timeZone: tz } = input;
  const order = d.courses.map((c) => c.name);
  const cur = d.weeks.at(-1)!;
  const L: string[] = [];

  L.push('## Contexto (escrito por mí en la Bitácora)');
  L.push(input.context.text || 'Sin contexto escrito.');

  // Semana actual
  const left = daysBetween(d.today, d.weekEnd) + 1;
  const goalTotal = d.courses.reduce((a, c) => a + (c.goalMinutes ?? 0), 0);
  L.push('', `## Esta semana: ${dayLabel(d.weekStart)} – ${dayLabel(d.weekEnd)} (hoy ${DOW_LONG[dow(d.today)]}; ${left === 1 ? 'queda 1 día' : `quedan ${left} días`} contando hoy)`);
  L.push(`Total: ${fmtMinutes(cur.total)}${goalTotal ? ` · meta ${fmtMinutes(goalTotal)} (suma de las metas por curso)` : ''}.`);
  const dg = d.daily;
  const dayTotal = (k: string) => Object.values(d.days[k] ?? {}).reduce((a, b) => a + b, 0);
  const goalDay = (k: string) => !!dg && dg.minutes > 0 && dg.weekdays.includes(dow(k));
  if (dg && dg.minutes > 0) {
    const t = dayTotal(d.today);
    L.push(`Meta diaria: ${fmtMinutes(dg.minutes)} ${weekdaysText(dg.weekdays)} (todo lo estudiado en el día). `
      + (!goalDay(d.today) ? 'Hoy es día libre.'
        : t >= dg.minutes ? `Hoy: ${fmtMinutes(t)} ✓ cumplida.` : `Hoy: ${fmtMinutes(t)} · faltan ${fmtMinutes(dg.minutes - t)}.`));
  }
  for (const c of d.courses) {
    const done = cur.byCourse[c.name] ?? 0;
    if (c.goalMinutes) {
      L.push(done >= c.goalMinutes
        ? `- ${c.name}: ${fmtMinutes(done)} de ${fmtMinutes(c.goalMinutes)} ✓ cumplida`
        : `- ${c.name}: ${fmtMinutes(done)} de ${fmtMinutes(c.goalMinutes)} · faltan ${fmtMinutes(c.goalMinutes - done)}`);
    } else {
      L.push(`- ${c.name}: ${fmtMinutes(done)} (sin meta)`);
    }
  }
  if (cur.other > 0) L.push(`- Otros / sin curso: ${fmtMinutes(cur.other)}`);
  if (d.active) {
    const since = new Intl.DateTimeFormat('es-PE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d.active.startedAt));
    L.push(`En curso ahora: ${d.active.course} desde las ${since} (${fmtMinutes(activeMs(d.active, input.now.getTime()) / 60000)}${d.active.pausedAt ? ', en pausa' : ''}; aún sin guardar).`);
  }
  L.push('', 'Por día:');
  for (let k = d.weekStart; k <= d.today; k = addDays(k, 1)) {
    const day = d.days[k] ?? {};
    const tot = Object.values(day).reduce((a, b) => a + b, 0);
    const label = dayLabel(k) + (k === d.today ? ' (hoy)' : '');
    const ok = goalDay(k) && tot >= dg.minutes ? ' ✓ meta diaria' : '';
    L.push(tot ? `- ${label}: ${fmtMinutes(tot)} (${breakdown(day, day[''] ?? 0, order)})${ok}` : `- ${label}: sin estudio`);
  }

  // Semanas anteriores (desde la primera con registros)
  const past = d.weeks.slice(0, -1);
  const firstData = past.findIndex((w) => w.total > 0);
  L.push('', '## Semanas anteriores');
  if (firstData < 0) L.push('Sin registros en las semanas anteriores.');
  else {
    const shown = past.slice(firstData);
    for (const w of shown) {
      L.push(w.total ? `- ${dm(w.start)} – ${dm(w.end)}: ${fmtMinutes(w.total)} (${breakdown(w.byCourse, w.other, order)})` : `- ${dm(w.start)} – ${dm(w.end)}: sin estudio`);
    }
    const avg = shown.reduce((a, w) => a + w.total, 0) / shown.length;
    L.push(`Promedio: ${fmtMinutes(avg)} por semana (${shown.length === 1 ? '1 semana' : `${shown.length} semanas`}).`);
  }

  // Evaluaciones
  L.push('', '## Próximas evaluaciones (70 días)');
  if (!input.evaluations.length) L.push('Ninguna registrada en TickTick.');
  const fTime = new Intl.DateTimeFormat('es-PE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  for (const e of input.evaluations) {
    const when = dayLabel(e.dayKey!) + (e.allDay || !e.due ? '' : ', ' + fTime.format(new Date(e.due)));
    const rel = e.daysUntil === 0 ? 'hoy' : e.daysUntil === 1 ? 'mañana' : `en ${e.daysUntil} días`;
    const course = taskCourse(e);
    L.push(`- ${when} — ${e.name}${course ? ` (${course})` : ''} · ${rel}`);
  }
  if (input.ignoredCount) L.push(`(${input.ignoredCount === 1 ? '1 tarea ocultada' : `${input.ignoredCount} tareas ocultadas`} a mano en la Bitácora por no ser evaluación.)`);

  // Notas
  const g = input.grades;
  const lines = g ? g.courses.map(gradeLine).filter((x): x is string => !!x) : [];
  if (g && (lines.length || g.prior.average !== null)) {
    L.push('', '## Notas del ciclo (escala 0–20, se aprueba con 11)');
    L.push(...lines);
    if (g.semester.semester !== null) {
      L.push(`Ponderado proyectado del ciclo: ${g.semester.semester.toFixed(2)}${g.semester.cumulative !== null ? ` · acumulado proyectado: ${g.semester.cumulative.toFixed(2)}` : ''}.`);
    }
  }

  L.push('', '## Cómo se calcula');
  L.push('- Horas: registros de enfoque de TickTick con la nota «Bitácora · <curso>» y pomodoros/cronómetros hechos sobre tareas del curso (por su columna). Semana de lunes a domingo, hora de Lima.');
  L.push('- Metas: horas por semana por curso, definidas en la Bitácora. «faltan» = meta − lo hecho en la semana.');
  L.push('- Evaluaciones: tareas de TickTick cuyo título empieza con PC, Parcial, Examen, Entrega, «Actividad N calificada», Trabajo final/grupal o Presentación.');
  L.push('- La Bitácora revisa esto cada 2 horas y después de cada cambio; si no hay nada nuevo, no reescribe la nota.');

  const body = L.join('\n');
  const stamp = new Intl.DateTimeFormat('es-PE', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(input.now).replace(',', ' a las');
  const head = [
    'Resumen automático de la Bitácora (mi app de estudio). Para Claude: es el estado actual de mis estudios; el detalle de tareas y sesiones está en TickTick.',
    'Se reescribe solo: no lo edites aquí. El contexto se cambia en la Bitácora (Estudio → «Resumen para Claude»).',
    `Escrito el ${DOW_LONG[dow(input.study.today)]} ${stamp} (hora de Lima).`,
  ];
  return { body, content: head.join('\n') + '\n\n' + body };
}

// ---------- escritura en TickTick ----------

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** La lista "Bitácora": la guardada si sigue abierta, una existente con ese nombre o una nueva. */
async function ensureList(client: TickTickClient, known?: string): Promise<string> {
  const projects = await client.listProjects();
  if (known && projects.some((p) => p.id === known && !p.closed)) return known;
  const same = projects.find((p) => p.name === NOTE_LIST && !p.closed);
  if (same) return same.id;
  const created = await client.createProject({ name: NOTE_LIST, viewMode: 'list', kind: 'TASK' });
  if (created?.id) return created.id;
  const again = (await client.listProjects()).find((p) => p.name === NOTE_LIST && !p.closed);
  if (!again) throw new Error('TickTick no devolvió la lista creada.');
  return again.id;
}

async function findNote(client: TickTickClient, projectId: string): Promise<TickTickTask | undefined> {
  const data = await client.getProjectData(projectId);
  return (data?.tasks ?? []).find((t) => t.title === NOTE_TITLE && (t.status === undefined || t.status === 0));
}

const isOpen = (t: TickTickTask | undefined) => !t || t.status === undefined || t.status === 0;

/** Actualiza la nota guardada o, si ya no está (borrada, completada, lista eliminada), la vuelve a crear. */
async function writeNote(client: TickTickClient, st: NoteState, content: string): Promise<{ projectId: string; taskId: string; created: boolean }> {
  if (st.projectId && st.taskId) {
    try {
      const t = await client.updateTask({ id: st.taskId, projectId: st.projectId, title: NOTE_TITLE, content });
      if (isOpen(t)) return { projectId: st.projectId, taskId: st.taskId, created: false };
      // La marcaron como hecha en TickTick: se crea otra (la completada queda donde está).
    } catch (e) {
      if (!(e instanceof TickTickError) || e.isAuthError) throw e;
      // 404 (la borraron o se fue la lista): se recrea abajo.
    }
  }
  const projectId = await ensureList(client, st.projectId);
  // Si se perdió el estado en KV pero la nota existe, se reutiliza en vez de duplicarla.
  const existing = await findNote(client, projectId);
  if (existing && existing.id !== st.taskId) {
    await client.updateTask({ id: existing.id, projectId, title: NOTE_TITLE, content });
    return { projectId, taskId: existing.id, created: false };
  }
  const made = await client.createTask({ projectId, title: NOTE_TITLE, content, priority: 0 });
  const taskId = made?.id ?? (await findNote(client, projectId))?.id;
  if (!taskId) throw new Error('TickTick no devolvió la nota creada.');
  return { projectId, taskId, created: true };
}

export type SyncResult = 'created' | 'updated' | 'unchanged';

/** Revisa los datos y reescribe la nota si cambiaron (o siempre, con `force`). */
export async function syncNote(
  client: TickTickClient,
  kv: KVNamespace,
  opts: { now: Date; timeZone: string; strategy: Strategy; force?: boolean },
): Promise<SyncResult> {
  const st = await getNoteState(kv);
  const input = await gatherNoteInput(client, kv, opts);
  const { body, content } = buildNote(input);
  const hash = await sha256(body);
  const now = opts.now.getTime();
  if (!opts.force && st.taskId && st.hash === hash) {
    await kv.put(K_STATE, JSON.stringify({ ...st, checkedAt: now, error: null }));
    return 'unchanged';
  }
  const where = await ttCall(() => writeNote(client, st, content));
  const next: NoteState = { projectId: where.projectId, taskId: where.taskId, hash, checkedAt: now, writtenAt: now, error: null, content };
  await kv.put(K_STATE, JSON.stringify(next));
  return where.created ? 'created' : 'updated';
}
