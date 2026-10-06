// Cliente mínimo de la TickTick Open API v1 (https://api.ticktick.com/open/v1).
// No sabe nada del panel ni de dónde se guardan los tokens: recibe una función
// que devuelve el access token. Pensado para reutilizarse en otros proyectos.

import { formatTickTickDate } from './dates';
import { TickTickError } from './errors';
import type { TickTickColumn, TickTickProject, TickTickProjectData, TickTickTask } from './types';

export const TICKTICK_API_BASE = 'https://api.ticktick.com/open/v1';

/** Rango máximo que acepta POST /task/undone (la doc: "up to 14 days"). */
export const UNDONE_MAX_RANGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface TickTickClientOptions {
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface UndoneQuery {
  startDate: Date;
  endDate: Date;
  /** Omitir = todos los proyectos accesibles; usa "inbox" para la bandeja de entrada. */
  projectIds?: string[];
  taskIds?: string[];
}

export interface FilterQuery {
  projectIds?: string[];
  /** Filtra por startDate de la tarea ≥ startDate. */
  startDate?: Date;
  /** Filtra por startDate de la tarea ≤ endDate. */
  endDate?: Date;
  priority?: number[];
  tag?: string[];
  kind?: string[];
  status?: number[];
}

export class TickTickClient {
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: TickTickClientOptions) {
    this.getAccessToken = opts.getAccessToken;
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.baseUrl = (opts.baseUrl ?? TICKTICK_API_BASE).replace(/\/$/, '');
  }

  /** Petición genérica. Devuelve el JSON, o `undefined` si la respuesta no tiene cuerpo. */
  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new TickTickError(`Sin respuesta de TickTick: ${(e as Error).message}`, 0);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new TickTickError(`TickTick ${method} ${path} → ${res.status}`, res.status, text.slice(0, 300));
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TickTickError(`TickTick ${method} ${path}: respuesta no es JSON`, res.status, text.slice(0, 300));
    }
  }

  // ---------- proyectos ----------

  /** GET /project — no incluye la bandeja de entrada (inbox). */
  listProjects(): Promise<TickTickProject[]> {
    return this.request<TickTickProject[]>('GET', '/project').then((r) => r ?? []);
  }

  getProject(projectId: string): Promise<TickTickProject> {
    return this.request('GET', `/project/${enc(projectId)}`);
  }

  /** GET /project/{id}/data — proyecto, tareas no completadas y columnas. Acepta "inbox". */
  getProjectData(projectId: string): Promise<TickTickProjectData> {
    return this.request('GET', `/project/${enc(projectId)}/data`);
  }

  listColumns(projectId: string): Promise<TickTickColumn[]> {
    return this.request<TickTickColumn[]>('GET', `/project/${enc(projectId)}/column`).then((r) => r ?? []);
  }

  // ---------- tareas ----------

  getTask(projectId: string, taskId: string): Promise<TickTickTask> {
    return this.request('GET', `/project/${enc(projectId)}/task/${enc(taskId)}`);
  }

  /** POST /project/{projectId}/task/{taskId}/complete — 200 sin cuerpo. */
  async completeTask(projectId: string, taskId: string): Promise<void> {
    await this.request<void>('POST', `/project/${enc(projectId)}/task/${enc(taskId)}/complete`);
  }

  /** POST /task/undone — tareas sin completar en un rango de hasta 14 días. */
  listUndone(q: UndoneQuery): Promise<TickTickTask[]> {
    if (q.endDate.getTime() < q.startDate.getTime()) throw new RangeError('endDate < startDate');
    if (q.endDate.getTime() - q.startDate.getTime() > UNDONE_MAX_RANGE_MS) {
      throw new RangeError('POST /task/undone admite como máximo 14 días; usa listUndoneInRange');
    }
    const body: Record<string, unknown> = {
      startDate: formatTickTickDate(q.startDate),
      endDate: formatTickTickDate(q.endDate),
    };
    if (q.projectIds?.length) body.projectIds = q.projectIds;
    if (q.taskIds?.length) body.taskIds = q.taskIds;
    return this.request<TickTickTask[]>('POST', '/task/undone', body).then((r) => r ?? []);
  }

  /**
   * Igual que listUndone pero para rangos de cualquier longitud: parte el rango
   * en tramos de ≤14 días, los consulta en paralelo y quita duplicados por id.
   */
  async listUndoneInRange(q: UndoneQuery): Promise<TickTickTask[]> {
    const windows = splitRange(q.startDate, q.endDate, UNDONE_MAX_RANGE_MS);
    const pages = await Promise.all(
      windows.map(([startDate, endDate]) => this.listUndone({ ...q, startDate, endDate })),
    );
    const byId = new Map<string, TickTickTask>();
    for (const page of pages) for (const t of page) byId.set(t.id, t);
    return [...byId.values()];
  }

  /** POST /task/filter — hasta 200 tareas; el rango de fechas se aplica a startDate. */
  filterTasks(q: FilterQuery): Promise<TickTickTask[]> {
    const body: Record<string, unknown> = {};
    if (q.projectIds?.length) body.projectIds = q.projectIds;
    if (q.startDate) body.startDate = formatTickTickDate(q.startDate);
    if (q.endDate) body.endDate = formatTickTickDate(q.endDate);
    if (q.priority) body.priority = q.priority;
    if (q.tag) body.tag = q.tag;
    if (q.kind) body.kind = q.kind;
    if (q.status) body.status = q.status;
    return this.request<TickTickTask[]>('POST', '/task/filter', body).then((r) => r ?? []);
  }
}

/** Divide [start, end] en tramos contiguos de como mucho `maxMs` (el último puede ser más corto). */
export function splitRange(start: Date, end: Date, maxMs: number): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = [];
  let a = start.getTime();
  const z = end.getTime();
  if (z < a) return out;
  // Tramos de maxMs - 1 s para no rozar el límite si el servidor compara con "<".
  const step = maxMs - 1000;
  while (a <= z) {
    const b = Math.min(a + step, z);
    out.push([new Date(a), new Date(b)]);
    if (b === z) break;
    a = b + 1000;
  }
  return out;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
