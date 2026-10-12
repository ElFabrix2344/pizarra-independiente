// Horas de estudio por curso, guardadas como registros de enfoque de TickTick.
//  - El botón de la pizarra crea registros de tipo cronómetro con la nota "Pizarra · <curso>".
//  - Lo que se cronometre desde la app de TickTick también cuenta: el curso sale de la
//    columna de la tarea asociada (o, si no, de su título).
//  - Cursos = columnas del inbox de TickTick (menos "Personal" / "Not Sectioned").
//  - El cronómetro en curso y las metas semanales viven en KV (no son secretos).

import {
  parseTickTickDate,
  TickTickError,
  type TickTickClient,
  type TickTickFocus,
  type TickTickFocusType,
} from '../lib/ticktick';
import { ApiError } from '../lib/http';
import { addDays, dayKeyInZone, endOfDay, startOfDay } from '../lib/time';

export const NOTE_PREFIX = 'Pizarra · ';
export const GENERAL = 'General';
const EXCLUDED_COLUMNS = /^(not sectioned|sin secci[oó]n|personal|hecho|done)$/i;
const MIN_SECONDS = 60;
const MAX_SECONDS = 12 * 3600;

// ---------- KV ----------

export interface ActiveTimer {
  course: string;
  /** epoch ms */
  startedAt: number;
}

export interface StudySettings {
  /** minutos por semana, por curso */
  goals: Record<string, number>;
  /** Columnas de TickTick que no se muestran como curso (p. ej. de un ciclo anterior). */
  hidden: string[];
  /** Cursos agregados a mano, que no son columnas de TickTick. */
  extra: string[];
}

/** Cursos visibles: columnas de TickTick no ocultas + los agregados a mano. */
export function visibleCourses(cat: { courses: string[] }, st: StudySettings): string[] {
  const hidden = new Set(st.hidden.map(fold));
  const fromCols = cat.courses.filter((c) => !hidden.has(fold(c)));
  const extra = st.extra.filter((e) => !fromCols.some((c) => fold(c) === fold(e)));
  return [...fromCols, ...extra];
}

const K_ACTIVE = 'study:active';
const K_SETTINGS = 'study:settings';

export class StudyStore {
  constructor(private readonly kv: KVNamespace) {}
  async getActive(): Promise<ActiveTimer | null> {
    return (await this.kv.get<ActiveTimer>(K_ACTIVE, 'json')) ?? null;
  }
  setActive(a: ActiveTimer) {
    return this.kv.put(K_ACTIVE, JSON.stringify(a));
  }
  clearActive() {
    return this.kv.delete(K_ACTIVE);
  }
  async getSettings(): Promise<StudySettings> {
    const s = await this.kv.get<StudySettings>(K_SETTINGS, 'json');
    return { goals: s?.goals ?? {}, hidden: s?.hidden ?? [], extra: s?.extra ?? [] };
  }
  setSettings(s: StudySettings) {
    return this.kv.put(K_SETTINGS, JSON.stringify(s));
  }
}

// ---------- utilidades ----------

/** Lunes (dayKey) de la semana de `key`. */
export function mondayOf(key: string): string {
  const dow = new Date(key + 'T12:00:00Z').getUTCDay(); // 0 = domingo
  return addDays(key, -((dow + 6) % 7));
}

export function weekRange(now: Date, tz: string) {
  const today = dayKeyInZone(now, tz);
  const monday = mondayOf(today);
  const sunday = addDays(monday, 6);
  return { today, monday, sunday, from: startOfDay(monday, tz), to: endOfDay(sunday, tz) };
}

/** Segundos de un registro: `duration`, o fin - inicio - pausas. */
export function focusSeconds(f: TickTickFocus): number {
  if (typeof f.duration === 'number' && f.duration > 0) return f.duration;
  const s = parseTickTickDate(f.startTime), e = parseTickTickDate(f.endTime);
  if (!s || !e) return 0;
  return Math.max(0, Math.round((e.getTime() - s.getTime()) / 1000) - (f.pauseDuration ?? 0));
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Curso escrito en la nota de un registro creado por la pizarra. */
export function courseFromNote(note: string | undefined, courses: string[]): string | null {
  if (!note?.startsWith(NOTE_PREFIX)) return null;
  const name = note.slice(NOTE_PREFIX.length).split(' · ')[0]!.trim();
  return courses.find((c) => fold(c) === fold(name)) ?? (name || null);
}

/** Curso cuyo nombre aparece como palabra en un título (p. ej. "Lectura HEE — …"). */
export function courseFromTitle(title: string | undefined, courses: string[]): string | null {
  if (!title) return null;
  const t = ' ' + fold(title).replace(/[^a-z0-9ñ]+/g, ' ') + ' ';
  // Primero los nombres más largos ("Estadística Aplicada" antes que una sigla corta).
  for (const c of [...courses].sort((a, b) => b.length - a.length)) {
    const n = fold(c).replace(/[^a-z0-9ñ]+/g, ' ').trim();
    if (n && t.includes(' ' + n + ' ')) return c;
  }
  return null;
}

export function fmtNote(course: string, extra?: string) {
  return NOTE_PREFIX + course + (extra ? ' · ' + extra : '');
}

// ---------- cursos ----------

interface CourseCatalog {
  courses: string[];
  inboxId: string | null;
  columnName: Map<string, string>;
}
let catalogCache: { at: number; v: CourseCatalog } | null = null;
const taskColumnCache = new Map<string, string | null>();

/** Solo para tests. */
export function _resetStudyCaches() {
  catalogCache = null;
  taskColumnCache.clear();
}

export async function loadCourses(client: TickTickClient, now = Date.now()): Promise<CourseCatalog> {
  if (catalogCache && now - catalogCache.at < 10 * 60 * 1000) return catalogCache.v;
  let cols = await client.listColumns('inbox').catch((e) => {
    if (e instanceof TickTickError && !e.isAuthError) return [];
    throw e;
  });
  // Respaldo: /project/inbox/data también trae las columnas.
  if (!cols.length) cols = (await client.getProjectData('inbox')).columns ?? [];
  const sorted = [...cols].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const v: CourseCatalog = {
    courses: sorted.map((c) => c.name.trim()).filter((n) => n && !EXCLUDED_COLUMNS.test(n)),
    inboxId: cols[0]?.projectId ?? null,
    columnName: new Map(cols.map((c) => [c.id, c.name.trim()])),
  };
  catalogCache = { at: now, v };
  return v;
}

/** Curso de un registro hecho desde la app de TickTick, por la columna de su tarea (o el título). */
async function courseFromTask(client: TickTickClient, f: TickTickFocus, cat: CourseCatalog): Promise<string | null> {
  const taskId = f.taskId ?? f.tasks?.find((t) => t.taskId)?.taskId;
  if (taskId && cat.inboxId) {
    if (!taskColumnCache.has(taskId)) {
      let col: string | null = null;
      try {
        const task = await client.getTask(cat.inboxId, taskId);
        col = task?.columnId ? (cat.columnName.get(task.columnId) ?? null) : null;
      } catch (e) {
        if (!(e instanceof TickTickError) || e.isAuthError) throw e; // 404: la tarea no está en el inbox
      }
      taskColumnCache.set(taskId, col);
    }
    const col = taskColumnCache.get(taskId);
    if (col && cat.courses.includes(col)) return col;
  }
  const title = f.tasks?.map((t) => t.title).filter(Boolean).join(' ') || f.note;
  return courseFromTitle(title, cat.courses);
}

// ---------- resumen ----------

export interface StudySession {
  id: string;
  type: TickTickFocusType;
  course: string | null;
  start: string;
  end: string | null;
  minutes: number;
  source: 'pizarra' | 'ticktick';
  label: string;
}

export interface StudyCourse {
  name: string;
  minutes: number;
  goalMinutes: number | null;
}

export interface StudyResult {
  generatedAt: string;
  timeZone: string;
  today: string;
  weekStart: string;
  weekEnd: string;
  courses: StudyCourse[];
  /** Minutos sin curso reconocido (incluye "General"). */
  otherMinutes: number;
  totalMinutes: number;
  goalTotalMinutes: number;
  active: ActiveTimer | null;
  sessions: StudySession[];
  /** Todos los cursos posibles, para la configuración (columnas + agregados). */
  courseOptions: Array<{ name: string; source: 'ticktick' | 'extra'; visible: boolean }>;
}

export async function getStudy(
  client: TickTickClient,
  store: StudyStore,
  opts: { now: Date; timeZone: string },
): Promise<StudyResult> {
  const { now, timeZone: tz } = opts;
  const w = weekRange(now, tz);
  const [cat, settings, active, pomos, timings] = await Promise.all([
    loadCourses(client, now.getTime()),
    store.getSettings(),
    store.getActive(),
    client.listFocuses({ from: w.from, to: w.to, type: 0 }),
    client.listFocuses({ from: w.from, to: w.to, type: 1 }),
  ]);
  const records: Array<TickTickFocus & { type: TickTickFocusType }> = [
    ...pomos.map((f) => ({ ...f, type: 0 as const })),
    ...timings.map((f) => ({ ...f, type: 1 as const })),
  ];

  const visible = visibleCourses(cat, settings);
  const known = [...new Set([...cat.courses, ...settings.extra])];
  const sessions: StudySession[] = [];
  for (const f of records) {
    const start = parseTickTickDate(f.startTime);
    if (!start || start < w.from || start > w.to) continue;
    const seconds = focusSeconds(f);
    if (seconds <= 0) continue;
    const fromPizarra = !!f.note?.startsWith(NOTE_PREFIX);
    const course = fromPizarra ? courseFromNote(f.note, known) : await courseFromTask(client, f, { ...cat, courses: known });
    sessions.push({
      id: f.id,
      type: f.type,
      course,
      start: start.toISOString(),
      end: parseTickTickDate(f.endTime)?.toISOString() ?? null,
      minutes: Math.round(seconds / 60),
      source: fromPizarra ? 'pizarra' : 'ticktick',
      label: fromPizarra ? (f.note!.includes(' · manual') ? 'manual' : 'pizarra') : (f.tasks?.[0]?.title ?? f.note ?? (f.type === 0 ? 'Pomodoro' : 'Cronómetro')),
    });
  }
  sessions.sort((a, b) => b.start.localeCompare(a.start));

  const byCourse = new Map<string, number>();
  let other = 0;
  for (const s of sessions) {
    if (s.course && visible.includes(s.course)) byCourse.set(s.course, (byCourse.get(s.course) ?? 0) + s.minutes);
    else other += s.minutes;
  }
  const courses = visible.map((name) => ({
    name,
    minutes: byCourse.get(name) ?? 0,
    goalMinutes: settings.goals[name] ?? null,
  }));
  return {
    generatedAt: now.toISOString(),
    timeZone: tz,
    today: w.today,
    weekStart: w.monday,
    weekEnd: w.sunday,
    courses,
    otherMinutes: other,
    totalMinutes: sessions.reduce((a, s) => a + s.minutes, 0),
    goalTotalMinutes: courses.reduce((a, c) => a + (c.goalMinutes ?? 0), 0),
    active,
    sessions,
    courseOptions: [
      ...cat.courses.map((name) => ({ name, source: 'ticktick' as const, visible: visible.includes(name) })),
      ...settings.extra.map((name) => ({ name, source: 'extra' as const, visible: true })),
    ],
  };
}

// ---------- acciones ----------

async function validCourse(client: TickTickClient, store: StudyStore, course: unknown): Promise<string> {
  if (typeof course !== 'string' || !course.trim()) throw new ApiError('bad_request', 400, 'Falta el curso.');
  const name = course.trim();
  if (name === GENERAL) return name;
  const courses = visibleCourses(await loadCourses(client), await store.getSettings());
  const match = courses.find((c) => fold(c) === fold(name));
  if (!match) throw new ApiError('bad_request', 400, `Curso desconocido: ${name}`);
  return match;
}

export async function startStudy(client: TickTickClient, store: StudyStore, course: unknown, now = Date.now()) {
  const name = await validCourse(client, store, course);
  const current = await store.getActive();
  if (current) throw new ApiError('bad_request', 409, `Ya hay un cronómetro en marcha (${current.course}).`);
  const active = { course: name, startedAt: now };
  await store.setActive(active);
  return { active };
}

export async function stopStudy(client: TickTickClient, store: StudyStore, now = Date.now()) {
  const active = await store.getActive();
  if (!active) throw new ApiError('bad_request', 409, 'No hay un cronómetro en marcha.');
  const seconds = Math.round((now - active.startedAt) / 1000);
  if (seconds < MIN_SECONDS) {
    await store.clearActive();
    return { saved: false as const, reason: 'Menos de 1 minuto: no se guardó.' };
  }
  const capped = Math.min(seconds, MAX_SECONDS);
  const focus = await client.createFocus({
    type: 1,
    startTime: new Date(active.startedAt),
    endTime: new Date(active.startedAt + capped * 1000),
    duration: capped,
    note: fmtNote(active.course),
  });
  await store.clearActive();
  return { saved: true as const, minutes: Math.round(capped / 60), course: active.course, id: focus?.id ?? null, capped: capped < seconds };
}

export async function addManual(
  client: TickTickClient,
  store: StudyStore,
  body: { course?: unknown; minutes?: unknown; date?: unknown },
  opts: { now: Date; timeZone: string },
) {
  const course = await validCourse(client, store, body.course);
  const minutes = Number(body.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 12 * 60) {
    throw new ApiError('bad_request', 400, 'La duración debe estar entre 1 minuto y 12 horas.');
  }
  const today = dayKeyInZone(opts.now, opts.timeZone);
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : today;
  if (date > today) throw new ApiError('bad_request', 400, 'No se pueden registrar sesiones en el futuro.');
  if (date < addDays(today, -60)) throw new ApiError('bad_request', 400, 'Solo se pueden agregar sesiones de los últimos 60 días.');
  // Hoy: termina ahora. Otro día: termina a las 20:00 de ese día.
  const end = date === today ? opts.now : new Date(startOfDay(date, opts.timeZone).getTime() + 20 * 3600 * 1000);
  const start = new Date(end.getTime() - Math.round(minutes) * 60000);
  const focus = await client.createFocus({ type: 1, startTime: start, endTime: end, duration: Math.round(minutes) * 60, note: fmtNote(course, 'manual') });
  return { saved: true, id: focus?.id ?? null, course, minutes: Math.round(minutes), date };
}

export async function saveGoals(client: TickTickClient, store: StudyStore, goals: unknown) {
  if (!goals || typeof goals !== 'object') throw new ApiError('bad_request', 400, 'Metas inválidas.');
  const settings = await store.getSettings();
  const courses = visibleCourses(await loadCourses(client), settings);
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(goals as Record<string, unknown>)) {
    const name = courses.find((c) => fold(c) === fold(k));
    const n = Number(v);
    if (!name || !Number.isFinite(n) || n <= 0) continue;
    clean[name] = Math.min(Math.round(n), 80 * 60);
  }
  await store.setSettings({ ...settings, goals: clean });
  return { goals: clean };
}

/** Qué columnas ocultar y qué cursos extra agregar. Las metas de cursos que dejan de verse se conservan. */
export async function saveCourses(client: TickTickClient, store: StudyStore, body: { hidden?: unknown; extra?: unknown }) {
  const cat = await loadCourses(client);
  const settings = await store.getSettings();
  const hiddenIn = Array.isArray(body.hidden) ? body.hidden : [];
  const hidden = cat.courses.filter((c) => hiddenIn.some((h) => typeof h === 'string' && fold(h) === fold(c)));
  const extra: string[] = [];
  for (const e of Array.isArray(body.extra) ? body.extra : []) {
    if (typeof e !== 'string') continue;
    const name = e.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 40) throw new ApiError('bad_request', 400, 'Cada curso debe tener entre 1 y 40 caracteres.');
    if (fold(name) === fold(GENERAL)) throw new ApiError('bad_request', 400, '«General» ya existe.');
    if (cat.courses.some((c) => fold(c) === fold(name))) throw new ApiError('bad_request', 400, `«${name}» ya es una columna de TickTick.`);
    if (!extra.some((x) => fold(x) === fold(name))) extra.push(name);
  }
  if (extra.length > 15) throw new ApiError('bad_request', 400, 'Máximo 15 cursos agregados.');
  const next = { ...settings, hidden, extra };
  await store.setSettings(next);
  return { hidden, extra, courses: visibleCourses(cat, next) };
}
