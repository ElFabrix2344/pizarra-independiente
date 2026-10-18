// Datos inventados para desarrollo local (MOCK_DATA=true en localhost).
// Imitan las respuestas documentadas de TickTick y Google Calendar para que
// todo el pipeline (normalización, filtros, frontend) se pruebe sin cuentas reales.

import { formatTickTickDate, parseTickTickDate, type TickTickProject, type TickTickTask } from './lib/ticktick';
import { addDays, dayKeyInZone, startOfDay, toRfc3339InZone } from './lib/time';

const TZ = 'America/Lima';
const completed = new Set<string>();

// Listas y tareas creadas por la app (p. ej. la nota para Claude), en memoria.
const createdProjects: TickTickProject[] = [];
const appTasks: TickTickTask[] = [];
let appSeq = 0;
/** Solo para tests: las tareas creadas por la app (se pueden borrar o completar a mano). */
export function _mockAppTasks() {
  return appTasks;
}
/** Solo para tests: vacía listas y tareas creadas. */
export function _resetMockApp() {
  createdProjects.length = 0;
  appTasks.length = 0;
}

function at(key: string, h: number, m = 0): Date {
  return new Date(startOfDay(key, TZ).getTime() + (h * 60 + m) * 60000);
}

const projects: TickTickProject[] = [
  { id: 'p-cursoa', name: 'Curso A', viewMode: 'list', kind: 'TASK' },
  { id: 'p-cursob', name: 'Curso B', viewMode: 'kanban', kind: 'TASK' },
  { id: 'p-personal', name: 'Personal', viewMode: 'list', kind: 'TASK' },
];
const columns = [
  { id: 'c-hacer', projectId: 'p-cursob', name: 'Por hacer' },
  { id: 'c-curso', projectId: 'p-cursob', name: 'En curso' },
  { id: 'c-est', projectId: 'inbox1234', name: 'Estadística Aplicada', sortOrder: 0 },
  { id: 'c-epp', projectId: 'inbox1234', name: 'EPP', sortOrder: 100 },
  { id: 'c-hee', projectId: 'inbox1234', name: 'HEE', sortOrder: 200 },
  { id: 'c-per', projectId: 'inbox1234', name: 'Personal', sortOrder: 500 },
  { id: 'c-ns', projectId: 'inbox1234', name: 'Not Sectioned', sortOrder: 66036 },
];

// Registros de enfoque (pomodoro / cronómetro) en memoria.
interface MockFocus {
  id: string;
  type: 0 | 1;
  note?: string;
  taskId?: string;
  tasks?: Array<{ taskId?: string; title?: string }>;
  startTime: string;
  endTime: string;
  duration: number;
}
let focuses: MockFocus[] | null = null;
let focusSeq = 0;
function focusStore(now: Date): MockFocus[] {
  if (focuses) return focuses;
  const mk = (type: 0 | 1, startMinAgo: number, minutes: number, extra: Partial<MockFocus>): MockFocus => {
    const start = new Date(now.getTime() - startMinAgo * 60000);
    return {
      id: 'seed' + ++focusSeq,
      type,
      startTime: formatTickTickDate(start),
      endTime: formatTickTickDate(new Date(start.getTime() + minutes * 60000)),
      duration: minutes * 60000, // TickTick real devuelve milisegundos
      ...extra,
    };
  };
  focuses = [
    // Pomodoro desde la app de TickTick sobre una tarea de la columna HEE.
    mk(0, 300, 50, { taskId: 't-over2', tasks: [{ taskId: 't-over2', title: 'Responder correo del grupo' }] }),
    // Sesión creada por la app con el nombre anterior ("Pizarra · "): debe seguir contando.
    mk(1, 200, 90, { note: 'Pizarra · EPP' }),
    // Cronómetro de TickTick sin tarea: no se sabe el curso → "Otros".
    mk(1, 100, 25, { note: 'Estudio libre' }),
  ];
  // Historial: sesiones de la pizarra en las 9 semanas anteriores (valores deterministas).
  const courses = ['Estadística Aplicada', 'EPP', 'HEE'];
  for (let w = 1; w <= 9; w++) {
    courses.forEach((c, i) => {
      const minutes = ((w * 37 + i * 53) % 150) + 30;
      focuses!.push(mk(1, w * 7 * 24 * 60 + i * 24 * 60, minutes, { note: 'Bitácora · ' + c }));
    });
  }
  return focuses;
}

function tasks(now: Date): TickTickTask[] {
  const t = dayKeyInZone(now, TZ);
  const allDay = (id: string, projectId: string, title: string, k: string, priority: 0 | 1 | 3 | 5, extra: Partial<TickTickTask> = {}): TickTickTask => {
    const d = formatTickTickDate(startOfDay(k, TZ));
    return { id, projectId, title, isAllDay: true, startDate: d, dueDate: d, timeZone: TZ, priority, status: 0, content: '', kind: 'TEXT', ...extra };
  };
  const timed = (id: string, projectId: string, title: string, k: string, h: number, priority: 0 | 1 | 3 | 5, extra: Partial<TickTickTask> = {}): TickTickTask => {
    const d = formatTickTickDate(at(k, h));
    return { id, projectId, title, isAllDay: false, startDate: d, dueDate: d, timeZone: TZ, priority, status: 0, content: '', kind: 'TEXT', ...extra };
  };
  return [
    allDay('t-old', 'p-cursoa', 'Tarea vencida hace 10 días (no debe salir)', addDays(t, -10), 5),
    allDay('t-over1', 'p-cursoa', 'Entregar resumen de lectura', addDays(t, -1), 5, { content: 'Ejemplo de tarea vencida.' }),
    timed('t-over2', 'inbox1234', 'Responder correo del grupo', addDays(t, -3), 9, 1, { columnId: 'c-hee' }),
    timed('t-today1', 'p-cursob', 'Resolver práctica dirigida', t, 18, 3, { columnId: 'c-curso' }),
    allDay('t-today2', 'p-personal', 'Pagar recibo de luz', t, 1, { repeatFlag: 'RRULE:FREQ=MONTHLY;INTERVAL=1' }),
    allDay('t-today3', 'p-cursoa', 'Leer capítulo 3', t, 5),
    allDay('t-w1', 'p-cursob', 'Preparar exposición grupal', addDays(t, 3), 3, { columnId: 'c-hacer', content: 'Repartir diapositivas y ensayar.' }),
    allDay('t-w2', 'p-cursoa', 'Entrega del informe 1 — Curso A', addDays(t, 4), 5),
    allDay('t-w3', 'p-personal', 'Lectura de la semana', addDays(t, 5), 0),
    allDay('t-w4', 'p-cursob', 'Fuera de la semana (día +9)', addDays(t, 9), 1),
    allDay('e1', 'p-cursoa', 'PC2 — Curso A', addDays(t, 9), 5),
    timed('e2', 'p-cursob', 'Actividad 3 calificada — Curso B', addDays(t, 16), 23, 3),
    allDay('e3', 'p-cursoa', 'Examen parcial — Curso C', addDays(t, 23), 5),
    allDay('e4', 'p-cursob', '2da entrega del proyecto', addDays(t, 30), 3),
    allDay('e5', 'p-cursoa', 'Trabajo final — Curso A', addDays(t, 40), 3),
    allDay('e6', 'p-cursob', 'Presentación grupal — Curso B', addDays(t, 60), 3),
    allDay('e7', 'p-cursob', 'Parcial fuera de rango (día +80)', addDays(t, 80), 3),
    // Evaluación en una columna-curso del inbox (para enlazar con el registro de notas).
    allDay('e8', 'inbox1234', 'Parcial Aplicada', addDays(t, 45), 5, { columnId: 'c-est' }),
    allDay('n1', 'p-personal', 'Leer capítulo 4 (no es evaluación)', addDays(t, 12), 0),
  ].filter((x) => !completed.has(x.id));
}

interface MockEvent {
  id: string;
  iCalUID?: string;
  colorId?: string;
  status: string;
  summary: string;
  description?: string;
  htmlLink?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
}

function events(now: Date): MockEvent[] {
  const t = dayKeyInZone(now, TZ);
  const dt = (d: Date) => ({ dateTime: toRfc3339InZone(d, TZ), timeZone: TZ });
  const ev = (id: string, summary: string, s: Date, e: Date, extra: Record<string, unknown> = {}) => ({
    id, status: 'confirmed', summary, start: dt(s), end: dt(e), htmlLink: `https://www.google.com/calendar/event?eid=${id}`, ...extra,
  });
  const nowMin = new Date(Math.floor(now.getTime() / 60000) * 60000);
  return [
    ev('ev-am', 'Clase — Curso A', at(t, 7), at(t, 8, 30), { description: 'Aula 301' }),
    ev('ev-now', 'Biblioteca — bloque de estudio', new Date(nowMin.getTime() - 30 * 60000), new Date(nowMin.getTime() + 45 * 60000), {
      description: 'Ejercicios <b>antes</b> de la clase.<br>Llevar laptop.',
    }),
    ev('ev-next', 'Reunión de grupo', new Date(nowMin.getTime() + 2 * 3600000), new Date(nowMin.getTime() + 3 * 3600000)),
    { id: 'ev-cancel', status: 'cancelled', summary: 'Cancelado', start: dt(at(t, 20)), end: dt(at(t, 21)) },
    ev('ev-t1', 'Clase — Curso B', at(addDays(t, 1), 11), at(addDays(t, 1), 12, 30)),
    { id: 'ev-allday', status: 'confirmed', summary: 'Feriado', start: { date: addDays(t, 2) }, end: { date: addDays(t, 3) }, htmlLink: 'https://www.google.com/calendar/event?eid=ev-allday' },
    ev('ev-t4', 'Biblioteca — lectura', at(addDays(t, 4), 14, 30), at(addDays(t, 4), 16), {
      description: 'Ejemplo de descripción de dos líneas para ver cómo se corta el texto cuando es largo, con &amp; entidades HTML.',
    }),
    ev('ev-t6', 'Revisión semanal', at(addDays(t, 6), 19), at(addDays(t, 6), 19, 15)),
  ];
}

/** Calendario de clases (otro calendario propio, como "UP 26-1"). */
function classEvents(now: Date): MockEvent[] {
  const t = dayKeyInZone(now, TZ);
  const dt = (d: Date) => ({ dateTime: toRfc3339InZone(d, TZ), timeZone: TZ });
  const cls = (id: string, summary: string, s: Date, e: Date, extra: Partial<MockEvent> = {}): MockEvent => ({
    id, status: 'confirmed', summary, start: dt(s), end: dt(e), htmlLink: `https://www.google.com/calendar/event?eid=${id}`, ...extra,
  });
  return [
    cls('cl-hee', '📜 HEE — Clase', at(t, 9, 30), at(t, 11, 20), { description: 'Historia Económica · Aula A-408', colorId: '7' }),
    cls('cl-est', '📊 Estadística — Clase', at(t, 18, 30), at(t, 21, 20), { colorId: '2' }),
    cls('cl-eval', '📈 EvalPriv — Clase', at(addDays(t, 1), 9, 30), at(addDays(t, 1), 12, 20), { colorId: '3' }),
    // Mismo evento que "Clase — Curso B" del calendario principal: debe salir una sola vez.
    { ...cls('cl-dup', 'Clase — Curso B', at(addDays(t, 1), 11), at(addDays(t, 1), 12, 30)), iCalUID: 'ev-t1' },
  ];
}

const json = (data: unknown, status = 200) =>
  new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const mockFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const now = new Date();
  const p = url.pathname;

  if (url.host === 'api.ticktick.com') {
    if (p === '/open/v1/project' && req.method === 'GET') return json([...projects, ...createdProjects]);
    if (p === '/open/v1/project' && req.method === 'POST') {
      const b = (await req.json()) as Partial<TickTickProject>;
      if (!b.name) return json(undefined, 400);
      const proj: TickTickProject = { id: 'p-app' + ++appSeq, name: b.name, viewMode: b.viewMode ?? 'list', kind: b.kind ?? 'TASK' };
      createdProjects.push(proj);
      return json(proj);
    }
    if (p === '/open/v1/task' && req.method === 'POST') {
      const b = (await req.json()) as Partial<TickTickTask>;
      if (!b.title || !b.projectId) return json(undefined, 400);
      if (!createdProjects.some((x) => x.id === b.projectId) && !projects.some((x) => x.id === b.projectId)) return json(undefined, 404);
      const t: TickTickTask = { id: 't-app' + ++appSeq, projectId: b.projectId, title: b.title, content: b.content ?? '', priority: 0, status: 0, kind: 'TEXT' };
      appTasks.push(t);
      return json(t);
    }
    let m = p.match(/^\/open\/v1\/task\/([^/]+)$/);
    if (m && req.method === 'POST' && m[1] !== 'undone' && m[1] !== 'filter') {
      const b = (await req.json()) as Partial<TickTickTask>;
      const t = appTasks.find((x) => x.id === decodeURIComponent(m![1]!) && x.projectId === b.projectId);
      if (!t) return json(undefined, 404);
      if (b.title !== undefined) t.title = b.title;
      if (b.content !== undefined) t.content = b.content;
      return json(t);
    }
    m = p.match(/^\/open\/v1\/project\/([^/]+)\/column$/);
    if (m) {
      const pid = m[1] === 'inbox' ? 'inbox1234' : m[1];
      return json(columns.filter((c) => c.projectId === pid));
    }
    m = p.match(/^\/open\/v1\/project\/([^/]+)\/task\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const t = [...tasks(now), ...appTasks].find((x) => x.id === decodeURIComponent(m![2]!) && x.projectId === decodeURIComponent(m![1]!));
      return t ? json(t) : json(undefined, 404);
    }
    if (p === '/open/v1/focus' && req.method === 'GET') {
      const type = Number(url.searchParams.get('type'));
      const from = parseTickTickDate(url.searchParams.get('from'))!.getTime();
      const to = parseTickTickDate(url.searchParams.get('to'))!.getTime();
      return json(
        focusStore(now).filter((f) => {
          const st = parseTickTickDate(f.startTime)!.getTime();
          return f.type === type && st >= from && st <= to;
        }),
      );
    }
    if (p === '/open/v1/focus' && req.method === 'POST') {
      const b = (await req.json()) as Omit<MockFocus, 'id'>;
      // Como TickTick real: guarda la duración en milisegundos a partir de las horas.
      const ms = parseTickTickDate(b.endTime)!.getTime() - parseTickTickDate(b.startTime)!.getTime();
      const f: MockFocus = { ...b, duration: ms, id: 'f' + ++focusSeq };
      focusStore(now).push(f);
      return json(f);
    }
    m = p.match(/^\/open\/v1\/focus\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      const list = focusStore(now);
      const i = list.findIndex((f) => f.id === decodeURIComponent(m![1]!));
      if (i < 0) return json(undefined, 404);
      const [gone] = list.splice(i, 1);
      return json({ id: gone!.id, type: gone!.type });
    }
    m = p.match(/^\/open\/v1\/project\/([^/]+)\/data$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const proj = id === 'inbox' ? { id: 'inbox1234', name: 'Inbox' } : [...projects, ...createdProjects].find((x) => x.id === id);
      if (!proj) return json(undefined, 404);
      const open = [...tasks(now), ...appTasks.filter((t) => t.status === 0)];
      return json({ project: proj, tasks: open.filter((t) => t.projectId === proj.id), columns: columns.filter((c) => c.projectId === proj.id) });
    }
    m = p.match(/^\/open\/v1\/project\/([^/]+)\/task\/([^/]+)\/complete$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[2]!);
      if (!tasks(now).some((t) => t.id === id && t.projectId === decodeURIComponent(m![1]!))) return json(undefined, 404);
      completed.add(id);
      return new Response(null, { status: 200 });
    }
    if (p === '/open/v1/task/undone' && req.method === 'POST') {
      const body = (await req.json()) as { startDate: string; endDate: string };
      const a = parseTickTickDate(body.startDate)!.getTime();
      const b = parseTickTickDate(body.endDate)!.getTime();
      if (b < a || b - a > 14 * 86400000) return json([]); // la doc: rango inválido → []
      return json(
        tasks(now).filter((t) => {
          const d = parseTickTickDate(t.startDate ?? t.dueDate)?.getTime();
          return d !== undefined && d >= a && d <= b;
        }),
      );
    }
    return json(undefined, 404);
  }

  if (url.host === 'www.googleapis.com' && p === '/calendar/v3/users/me/calendarList') {
    const all = [
      { id: 'yo@example.com', summary: 'yo@example.com', primary: true, accessRole: 'owner', backgroundColor: '#9fe1e7' },
      { id: 'clases@group.calendar.google.com', summary: 'Clases', accessRole: 'owner', backgroundColor: '#f691b2' },
      { id: 'es.pe#holiday@group.v.calendar.google.com', summary: 'Feriados', accessRole: 'reader' },
    ];
    const min = url.searchParams.get('minAccessRole');
    return json({ kind: 'calendar#calendarList', items: min === 'owner' ? all.filter((c) => c.accessRole === 'owner') : all });
  }

  const evm = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
  if (url.host === 'www.googleapis.com' && evm) {
    const calId = decodeURIComponent(evm[1]!);
    const min = new Date(url.searchParams.get('timeMin')!).getTime();
    const max = new Date(url.searchParams.get('timeMax')!).getTime();
    const source = calId === 'primary' || calId === 'yo@example.com' ? events(now)
      : calId === 'clases@group.calendar.google.com' ? classEvents(now)
      : calId.includes('holiday') ? [{ id: 'fer', status: 'confirmed', summary: 'Feriado nacional', start: { date: dayKeyInZone(now, TZ) }, end: { date: addDays(dayKeyInZone(now, TZ), 1) } }]
      : null;
    if (!source) return json({ error: { code: 404 } }, 404);
    const items = (source as MockEvent[]).filter((e) => {
      const s = new Date(e.start.dateTime ?? `${e.start.date}T00:00:00-05:00`).getTime();
      const en = new Date(e.end.dateTime ?? `${e.end.date}T00:00:00-05:00`).getTime();
      return en > min && s < max;
    });
    return json({ kind: 'calendar#events', timeZone: TZ, items });
  }

  return json({ error: 'mock: ruta no simulada ' + url.toString() }, 404);
};
