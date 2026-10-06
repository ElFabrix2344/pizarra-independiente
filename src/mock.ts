// Datos inventados para desarrollo local (MOCK_DATA=true en localhost).
// Imitan las respuestas documentadas de TickTick y Google Calendar para que
// todo el pipeline (normalización, filtros, frontend) se pruebe sin cuentas reales.

import { formatTickTickDate, parseTickTickDate, type TickTickProject, type TickTickTask } from './lib/ticktick';
import { addDays, dayKeyInZone, startOfDay, toRfc3339InZone } from './lib/time';

const TZ = 'America/Lima';
const completed = new Set<string>();

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
];

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
    timed('t-over2', 'inbox1234', 'Responder correo del grupo', addDays(t, -3), 9, 1),
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
    allDay('n1', 'p-personal', 'Leer capítulo 4 (no es evaluación)', addDays(t, 12), 0),
  ].filter((x) => !completed.has(x.id));
}

interface MockEvent {
  id: string;
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

const json = (data: unknown, status = 200) =>
  new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const mockFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const now = new Date();
  const p = url.pathname;

  if (url.host === 'api.ticktick.com') {
    if (p === '/open/v1/project' && req.method === 'GET') return json(projects);
    let m = p.match(/^\/open\/v1\/project\/([^/]+)\/column$/);
    if (m) return json(columns.filter((c) => c.projectId === m![1]));
    m = p.match(/^\/open\/v1\/project\/([^/]+)\/data$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const proj = id === 'inbox' ? { id: 'inbox1234', name: 'Inbox' } : projects.find((x) => x.id === id);
      if (!proj) return json(undefined, 404);
      return json({ project: proj, tasks: tasks(now).filter((t) => t.projectId === proj.id), columns: columns.filter((c) => c.projectId === proj.id) });
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

  if (url.host === 'www.googleapis.com' && p === '/calendar/v3/calendars/primary/events') {
    const min = new Date(url.searchParams.get('timeMin')!).getTime();
    const max = new Date(url.searchParams.get('timeMax')!).getTime();
    const items = events(now).filter((e) => {
      const s = new Date(e.start.dateTime ?? `${e.start.date}T00:00:00-05:00`).getTime();
      const en = new Date(e.end.dateTime ?? `${e.end.date}T00:00:00-05:00`).getTime();
      return en > min && s < max;
    });
    return json({ kind: 'calendar#events', timeZone: TZ, items });
  }

  return json({ error: 'mock: ruta no simulada ' + url.toString() }, 404);
};
