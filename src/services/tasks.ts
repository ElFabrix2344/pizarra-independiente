// Lógica del panel sobre TickTick: qué tareas se muestran y con qué forma.

import {
  TickTickClient,
  TickTickError,
  parseTickTickDate,
  taskDayKey,
  type TickTickColumn,
  type TickTickProject,
  type TickTickTask,
} from '../lib/ticktick';
import { ApiError } from '../lib/http';
import { addDays, dayKeyInZone, daysBetween, endOfDay, startOfDay } from '../lib/time';

/** Tarea normalizada que consume el frontend. */
export interface PanelTask {
  id: string;
  projectId: string;
  title: string;
  note: string;
  /** ISO 8601 UTC del vencimiento, o null. */
  due: string | null;
  allDay: boolean;
  /** "YYYY-MM-DD" del vencimiento en la zona del panel. */
  dayKey: string | null;
  priority: number;
  /** Nombre de la lista (proyecto). */
  list: string;
  /** Nombre de la columna (kanban), si TickTick la informa. */
  column: string | null;
  tags: string[];
  repeat: boolean;
  url: string;
}

export interface PanelEvaluation extends PanelTask {
  /** Título hasta el primer " — " (como en el panel original). */
  name: string;
  daysUntil: number;
}

export type Strategy = 'undone' | 'scan';

export const EVAL_RE =
  /^(PC\s?\d|PARCIAL|EXAMEN|Actividad\s+\d+\s+calificada|Trabajo\s+(final|grupal)|Entrega|\d+\S*\s+entrega|Presentaci[oó]n)/i;

export const OVERDUE_DAYS = 7;
export const WEEK_DAYS = 7;
export const EVAL_DAYS = 70;
export const EVAL_LIMIT = 6;

// ---------- metadatos (nombres de listas y columnas), caché en memoria del isolate ----------

interface Meta {
  projects: Map<string, TickTickProject>;
  columns: Map<string, string>; // columnId → nombre
  loadedAt: number;
  columnProjects: Set<string>;
}
const META_TTL_MS = 10 * 60 * 1000;
let metaCache: Meta | null = null;

/** Solo para tests. */
export function _resetMetaCache() {
  metaCache = null;
}

async function loadMeta(client: TickTickClient, now: number): Promise<Meta> {
  if (metaCache && now - metaCache.loadedAt < META_TTL_MS) return metaCache;
  const projects = await client.listProjects();
  metaCache = {
    projects: new Map(projects.map((p) => [p.id, p])),
    columns: metaCache?.columns ?? new Map(),
    columnProjects: metaCache?.columnProjects ?? new Set(),
    loadedAt: now,
  };
  return metaCache;
}

/** Carga columnas de los proyectos kanban que tengan tareas con columnId desconocido. */
async function ensureColumns(client: TickTickClient, meta: Meta, tasks: TickTickTask[]) {
  const missing = new Set<string>();
  for (const t of tasks) {
    if (t.columnId && !meta.columns.has(t.columnId) && !meta.columnProjects.has(t.projectId)) missing.add(t.projectId);
  }
  await Promise.all(
    [...missing].map(async (pid) => {
      meta.columnProjects.add(pid);
      try {
        for (const c of await client.listColumns(pid)) meta.columns.set(c.id, c.name);
      } catch (e) {
        console.warn('No se pudieron leer columnas de', pid, (e as Error).message);
      }
    }),
  );
}

function addColumns(meta: Meta, cols: TickTickColumn[] | undefined, projectId: string) {
  if (!cols) return;
  meta.columnProjects.add(projectId);
  for (const c of cols) meta.columns.set(c.id, c.name);
}

export function listName(projectId: string, meta: Pick<Meta, 'projects'>): string {
  if (projectId.startsWith('inbox')) return 'Bandeja de entrada';
  return meta.projects.get(projectId)?.name ?? '';
}

// ---------- normalización ----------

export function normalizeTask(
  t: TickTickTask,
  ctx: { timeZone: string; meta: Pick<Meta, 'projects' | 'columns'> },
): PanelTask {
  const due = parseTickTickDate(t.dueDate) ?? parseTickTickDate(t.startDate);
  const allDay = !!t.isAllDay;
  return {
    id: t.id,
    projectId: t.projectId,
    title: (t.title ?? '').trim() || '(sin título)',
    note: (t.content || t.desc || '').trim(),
    due: due ? due.toISOString() : null,
    allDay,
    dayKey: due ? taskDayKey(due, { isAllDay: allDay, taskTimeZone: t.timeZone, displayTimeZone: ctx.timeZone }) : null,
    priority: t.priority ?? 0,
    list: listName(t.projectId, ctx.meta),
    column: t.columnId ? (ctx.meta.columns.get(t.columnId) ?? null) : null,
    tags: t.tags ?? [],
    repeat: !!t.repeatFlag,
    url: `https://ticktick.com/webapp/#p/${encodeURIComponent(t.projectId)}/tasks/${encodeURIComponent(t.id)}`,
  };
}

/** Orden del panel: por día (sin fecha al final) y, dentro del día, prioridad descendente. */
export function sortTasks(a: PanelTask, b: PanelTask): number {
  const ka = a.dayKey ?? '9999-99-99';
  const kb = b.dayKey ?? '9999-99-99';
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return (a.due ?? '').localeCompare(b.due ?? '');
}

// ---------- lectura de tareas sin completar en un rango ----------

async function fetchUndone(
  client: TickTickClient,
  strategy: Strategy,
  from: Date,
  to: Date,
  meta: Meta,
): Promise<TickTickTask[]> {
  if (strategy === 'undone') {
    const tasks = await client.listUndoneInRange({ startDate: from, endDate: to });
    await ensureColumns(client, meta, tasks);
    return tasks;
  }
  // "scan": todos los proyectos + inbox con /project/{id}/data (devuelve solo las no completadas).
  const ids = ['inbox', ...[...meta.projects.values()].filter((p) => !p.closed && p.kind !== 'NOTE').map((p) => p.id)];
  const out: TickTickTask[] = [];
  for (let i = 0; i < ids.length; i += 6) {
    const batch = await Promise.all(ids.slice(i, i + 6).map((id) => client.getProjectData(id)));
    for (const d of batch) {
      if (!d || !Array.isArray(d.tasks)) throw new ApiError('bad_response', 502, 'TickTick: /project/{id}/data sin "tasks"', 'ticktick');
      if (d.project?.id) addColumns(meta, d.columns, d.project.id);
      out.push(...d.tasks);
    }
  }
  return out;
}

/** Traduce errores del cliente de TickTick a errores de la API del panel. */
export async function ttCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof TickTickError) {
      if (e.isAuthError) throw new ApiError('reauth_required', 409, 'TickTick rechazó el token. Vuelve a conectar TickTick.', 'ticktick');
      console.error(e.message, e.body);
      throw new ApiError('upstream_error', 502, `TickTick respondió con un error (${e.status || 'sin respuesta'}).`, 'ticktick');
    }
    throw e;
  }
}

// ---------- endpoints ----------

export interface TasksResult {
  generatedAt: string;
  timeZone: string;
  today: string;
  strategy: Strategy;
  tasks: PanelTask[];
}

/** Vencidas de los últimos 7 días + de hoy a hoy+7. */
export async function getPanelTasks(
  client: TickTickClient,
  opts: { now: Date; timeZone: string; strategy: Strategy },
): Promise<TasksResult> {
  const { now, timeZone: tz, strategy } = opts;
  const today = dayKeyInZone(now, tz);
  const firstDay = addDays(today, -OVERDUE_DAYS);
  const lastDay = addDays(today, WEEK_DAYS);

  return ttCall(async () => {
    const meta = await loadMeta(client, now.getTime());
    let raw: TickTickTask[];
    if (strategy === 'undone') {
      // Dos consultas de ≤14 días: [hoy-7, hoy) y [hoy, hoy+7].
      const [past, next] = await Promise.all([
        fetchUndone(client, strategy, startOfDay(firstDay, tz), new Date(startOfDay(today, tz).getTime() - 1000), meta),
        fetchUndone(client, strategy, startOfDay(today, tz), endOfDay(lastDay, tz), meta),
      ]);
      raw = dedupe([...past, ...next]);
    } else {
      raw = await fetchUndone(client, strategy, startOfDay(firstDay, tz), endOfDay(lastDay, tz), meta);
    }
    assertTaskArray(raw);

    const tasks = raw
      .filter((t) => t.status === undefined || t.status === 0)
      .map((t) => normalizeTask(t, { timeZone: tz, meta }))
      .filter((t) => t.dayKey !== null && t.dayKey >= firstDay && t.dayKey <= lastDay)
      .sort(sortTasks);

    return { generatedAt: now.toISOString(), timeZone: tz, today, strategy, tasks };
  });
}

export interface EvaluationsResult {
  generatedAt: string;
  timeZone: string;
  today: string;
  evaluations: PanelEvaluation[];
}

/** Tareas de hoy a hoy+70 cuyo título parece una evaluación; las `limit` más cercanas. */
export async function getEvaluations(
  client: TickTickClient,
  opts: { now: Date; timeZone: string; strategy: Strategy; limit?: number },
): Promise<EvaluationsResult> {
  const { now, timeZone: tz, strategy } = opts;
  const limit = opts.limit ?? EVAL_LIMIT;
  const today = dayKeyInZone(now, tz);
  const lastDay = addDays(today, EVAL_DAYS);

  return ttCall(async () => {
    const meta = await loadMeta(client, now.getTime());
    const raw = await fetchUndone(client, strategy, startOfDay(today, tz), endOfDay(lastDay, tz), meta);
    assertTaskArray(raw);
    const evaluations = dedupe(raw)
      .filter((t) => (t.status === undefined || t.status === 0) && EVAL_RE.test((t.title ?? '').trim()))
      .map((t) => normalizeTask(t, { timeZone: tz, meta }))
      .filter((t) => t.dayKey !== null && t.dayKey >= today && t.dayKey <= lastDay)
      .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))
      .slice(0, limit)
      .map((t) => ({
        ...t,
        name: t.title.split(' — ')[0]!.trim(),
        daysUntil: daysBetween(today, t.dayKey!),
      }));
    return { generatedAt: now.toISOString(), timeZone: tz, today, evaluations };
  });
}

function dedupe(tasks: TickTickTask[]): TickTickTask[] {
  const m = new Map<string, TickTickTask>();
  for (const t of tasks) m.set(t.id, t);
  return [...m.values()];
}

function assertTaskArray(x: unknown): asserts x is TickTickTask[] {
  if (!Array.isArray(x) || x.some((t) => !t || typeof t.id !== 'string' || typeof t.projectId !== 'string')) {
    throw new ApiError('bad_response', 502, 'TickTick devolvió tareas con un formato inesperado.', 'ticktick');
  }
}
