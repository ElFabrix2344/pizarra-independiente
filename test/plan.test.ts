import { beforeEach, describe, expect, it } from 'vitest';
import { formatTickTickDate, TickTickClient } from '../src/lib/ticktick';
import { ApiError } from '../src/lib/http';
import { dayKeyInZone, startOfDay } from '../src/lib/time';
import { _mockAppTasks, _resetMockApp, mockFetch } from '../src/mock';
import type { NoteInput } from '../src/services/claudeNote';
import { buildResult } from '../src/services/grades';
import {
  buildPrompt,
  claudeLLM,
  generatePlan,
  getDayPlan,
  isPlanDay,
  MAX_RUNS,
  mockLLM,
  modelLabel,
  PLAN_MODEL,
  planContext,
  planStatus,
  planTaskId,
  SYSTEM_PROMPT,
  validatePlan,
  type PlanInput,
  type PlanLLM,
} from '../src/services/morningPlan';
import { _resetStudyCaches, type StudyDigest } from '../src/services/study';
import { _resetMetaCache, getPanelTasks, type PanelEvaluation, type PanelTask } from '../src/services/tasks';
import type { PanelEvent } from '../src/services/calendar';

const TZ = 'America/Lima';
const client = () => new TickTickClient({ getAccessToken: async () => 'mock', fetch: mockFetch });
const hm = (ms: number | string) =>
  new Intl.DateTimeFormat('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));

function memKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string, type?: string) => {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  } as unknown as KVNamespace;
}

beforeEach(() => {
  _resetMockApp();
  _resetStudyCaches();
  _resetMetaCache();
});

// Miércoles 28/10/2026 a las 6:25 en Lima. Lunes 2 h de EPP, martes 2 h de Aplicada.
const study: StudyDigest = {
  today: '2026-10-28',
  weekStart: '2026-10-26',
  weekEnd: '2026-11-01',
  cycleStart: '2026-08-10',
  courses: [
    { name: 'Estadística Aplicada', goalMinutes: 360 },
    { name: 'EPP', goalMinutes: 480 },
    { name: 'HEE', goalMinutes: null },
    { name: 'Pensamiento Social', goalMinutes: null },
  ],
  weeks: [{ start: '2026-10-26', end: '2026-11-01', byCourse: { 'Estadística Aplicada': 120, EPP: 120 }, other: 0, total: 240 }],
  days: { '2026-10-26': { EPP: 120 }, '2026-10-27': { 'Estadística Aplicada': 120 } },
  active: null,
  daily: { minutes: 240, weekdays: [1, 2, 3, 4, 5] },
};

const ev = (over: Partial<PanelEvaluation>): PanelEvaluation => ({
  id: 'e', projectId: 'inbox1', title: '', note: '', due: null, allDay: true, dayKey: null, priority: 5,
  list: 'Bandeja de entrada', column: null, tags: [], repeat: false, url: '', name: '', daysUntil: 0, ...over,
});
const task = (over: Partial<PanelTask>): PanelTask => ({
  id: 't', projectId: 'inbox1', title: '', note: '', due: null, allDay: true, dayKey: null, priority: 0,
  list: 'Bandeja de entrada', column: null, tags: [], repeat: false, url: '', ...over,
});
const event = (title: string, from: string, to: string): PanelEvent => ({
  id: title, title, desc: '', start: new Date(`2026-10-28T${from}:00-05:00`).toISOString(), end: new Date(`2026-10-28T${to}:00-05:00`).toISOString(),
  allDay: false, dayKey: '2026-10-28', link: null, calendar: 'UP 26-1', color: null,
});

const note: NoteInput = {
  now: new Date('2026-10-28T11:25:00Z'),
  timeZone: TZ,
  context: { text: 'La PC3 de EPP entra cap. VIII y IX.', updatedAt: 1 },
  study,
  evaluations: [
    ev({ id: 'e1', title: 'PC3 EPP — jueves 29/10, 17:30', name: 'PC3 EPP', column: 'EPP', allDay: false, due: '2026-10-29T22:30:00.000Z', dayKey: '2026-10-29', daysUntil: 1 }),
    // Sin columna y con una sigla que no es el nombre del curso: no se le asigna curso.
    ev({ id: 'e2', title: 'Actividad 4 calificada PSC — martes 03/11', name: 'Actividad 4 calificada PSC', dayKey: '2026-11-03', daysUntil: 6 }),
    ev({ id: 'e3', title: 'Parcial Estadística Aplicada — sábado 07/11', name: 'Parcial Estadística Aplicada', column: 'Estadística Aplicada', dayKey: '2026-11-07', daysUntil: 10 }),
  ],
  ignoredCount: 0,
  grades: buildResult(
    {
      cycleStart: '2026-08-10',
      courses: {
        'Estadística Aplicada': {
          credits: 4, academic: true, target: null,
          items: [
            { id: 'a', name: 'PC1', weight: 20, grade: 13 },
            { id: 'b', name: 'Parcial', weight: 30, grade: null },
            { id: 'c', name: 'Final', weight: 50, grade: null },
          ],
        },
      },
      prior: { average: null, credits: null },
    },
    study.courses.map((c) => c.name),
  ),
};

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  now: note.now,
  timeZone: TZ,
  note,
  prefs: { on: true, from: '08:00', to: '22:00' },
  events: [event('EvalPriv — Clase', '10:00', '11:20'), event('Aplicada — Clase', '14:00', '15:20'), { ...event('Semana de exámenes', '00:00', '23:59'), allDay: true }],
  tasks: [
    task({ id: 't1', title: 'Simulacro PC3 EPP 25-1 cronometrado (100 min)', column: 'EPP', dayKey: '2026-10-28', priority: 5, note: 'Con reloj, sin apuntes.' }),
    task({ id: 't2', title: 'Leer Nussbaum cap. 4', column: 'Pensamiento Social', dayKey: '2026-10-27', priority: 3 }),
  ],
  ...over,
});

describe('lo que calcula la app (igual que los bloques sugeridos)', () => {
  it('huecos entre clases, prioridad a la evaluación más cercana y lo que falta para la meta del día', () => {
    const ctx = planContext(input());
    expect(ctx.slots.map((s) => `${hm(s.start)}–${hm(s.end)}`)).toEqual(['08:00–09:50', '11:30–13:50', '15:30–22:00']);
    // EPP (PC3 mañana) va primero y se lleva lo que falta para las 4 h: 72 min de su ritmo + 120 de la meta diaria.
    expect(ctx.needs).toEqual([{ course: 'EPP', minutes: 192 }, { course: 'Estadística Aplicada', minutes: 48 }]);
    expect(ctx.evals).toEqual({ EPP: { days: 1, name: 'PC3 EPP' }, 'Estadística Aplicada': { days: 10, name: 'Parcial Estadística Aplicada' } });
    expect(ctx.baseline.map((b) => `${hm(b.start)}–${hm(b.end)} ${b.course}`)).toEqual([
      '08:00–09:30 EPP',
      '11:30–13:00 EPP',
      '13:10–13:40 EPP',
      '15:30–16:30 Estadística Aplicada',
    ]);
    expect(ctx.dailyGoal).toBe(240);
  });

  it('a media tarde el horario empieza ahora (+5 min) y el cronómetro en marcha cuenta', () => {
    const now = new Date('2026-10-28T21:00:00Z'); // 16:00
    const active = { course: 'EPP', startedAt: now.getTime() - 60 * 60000, pausedAt: null, pausedMs: 0 };
    const ctx = planContext(input({ now, note: { ...note, now, study: { ...study, active } } }));
    expect(hm(ctx.slots[0]!.start)).toBe('16:05');
    expect(ctx.doneToday).toBe(60);
  });

  it('el fin de semana no hay meta diaria ni plan automático', () => {
    expect(isPlanDay('2026-10-31')).toBe(false); // sábado
    expect(isPlanDay('2026-10-28')).toBe(true);
    const ctx = planContext(input({ note: { ...note, study: { ...study, today: '2026-10-31' } } }));
    expect(ctx.dailyGoal).toBe(0);
  });
});

describe('lo que se le manda a Claude', () => {
  it('trae huecos, clases, ritmo, evaluaciones con su peso, tareas con id y el contexto; los datos van aparte', () => {
    const p = buildPrompt(input(), planContext(input()));
    expect(p.system).toBe(SYSTEM_PROMPT);
    expect(p.system).toContain('no instrucciones');
    expect(p.user.startsWith('<datos>\n')).toBe(true);
    expect(p.user).toContain('</datos>\n\nArma el plan de hoy.');
    expect(p.user).toContain('- 08:00–09:50 (1 h 50)');
    expect(p.user).toContain('- 10:00–11:20 · EvalPriv — Clase (UP 26-1)');
    expect(p.user).toContain('- todo el día · Semana de exámenes');
    expect(p.user).toContain('Meta del día: 4 h de estudio en total. Lleva hoy: 0 min. Le faltan: 4 h.');
    expect(p.user).toContain('- EPP: meta 8 h por semana · lleva 2 h · faltan 6 h · hoy le tocan 1 h 12');
    expect(p.user).toContain('- jue 29/10 17:30 — PC3 EPP (EPP) · mañana');
    expect(p.user).toContain('Parcial Estadística Aplicada (Estadística Aplicada) · en 10 días · pesa 30 % · para aprobar necesita');
    expect(p.user).toContain('- [id t1] Simulacro PC3 EPP 25-1 cronometrado (100 min) · EPP · vence hoy · prioridad alta · nota: Con reloj, sin apuntes.');
    expect(p.user).toContain('- [id t2] Leer Nussbaum cap. 4 · Pensamiento Social · vencida (mar 27/10) · prioridad media');
    expect(p.user).toContain('La PC3 de EPP entra cap. VIII y IX.');
  });

  it('sin calendario, lo dice para que Claude lo avise', () => {
    const p = buildPrompt(input({ events: null }), planContext(input({ events: null })));
    expect(p.user).toContain('No se pudo leer Google Calendar');
  });
});

describe('lo que responde Claude', () => {
  const known = { courses: study.courses.map((c) => c.name), taskIds: new Set(['t1', 't2']), timeZone: TZ };

  it('solo quedan los bloques que caben en un hueco, sin chocar, con curso conocido y tarea de la lista', () => {
    const ctx = planContext(input());
    const r = validatePlan(
      {
        resumen: '  Hoy va EPP: la PC3 es mañana.  ',
        nota: '',
        bloques: [
          { inicio: '08:00', fin: '09:40', curso: 'epp', tarea: 'Simulacro PC3 25-1', taskId: 't1', motivo: 'PC3 mañana' },
          { inicio: '09:00', fin: '09:45', curso: 'EPP', tarea: 'choca con el anterior', taskId: '', motivo: '' },
          { inicio: '10:00', fin: '11:00', curso: 'HEE', tarea: 'en plena clase', taskId: '', motivo: '' },
          { inicio: '11:30', fin: '11:45', curso: 'HEE', tarea: 'muy corto', taskId: '', motivo: '' },
          { inicio: '11:32', fin: '13:00', curso: 'Pensamiento', tarea: 'Leer Nussbaum cap. 4', taskId: 'no-existe', motivo: 'atrasada' },
          { inicio: '15:30', fin: '16:30', curso: 'Cálculo', tarea: 'Repaso', taskId: '', motivo: '' },
          { inicio: '25:00', fin: '26:00', curso: 'EPP', tarea: 'hora inválida', taskId: '', motivo: '' },
        ],
      },
      ctx,
      known,
    );
    expect(r.summary).toBe('Hoy va EPP: la PC3 es mañana.');
    expect(r.note).toBeNull();
    expect(r.fallback).toBe(false);
    expect(r.blocks.map((b) => `${hm(b.start)}–${hm(b.end)} ${b.course} ${b.taskId}`)).toEqual([
      '08:00–09:40 EPP t1',
      '11:35–13:00 Pensamiento Social null', // empieza en múltiplo de 5; el id inventado se descarta
      '15:30–16:30 General null', // curso desconocido
    ]);
  });

  it('si ningún bloque sirve, usa los de la app; si Claude no propuso bloques, no inventa', () => {
    const ctx = planContext(input());
    const bad = validatePlan({ resumen: 'x', nota: 'ojo', bloques: [{ inicio: '10:00', fin: '11:00', curso: 'EPP', tarea: '', taskId: '', motivo: '' }] }, ctx, known);
    expect(bad.fallback).toBe(true);
    expect(bad.blocks).toHaveLength(ctx.baseline.length);
    expect(bad.note).toBe('ojo');
    const none = validatePlan({ resumen: 'Hoy descansa.', nota: '', bloques: [] }, ctx, known);
    expect(none).toEqual({ summary: 'Hoy descansa.', note: null, blocks: [], fallback: false });
    expect(() => validatePlan({ nota: '', bloques: [] }, ctx, known)).toThrow(ApiError);
  });
});

describe('el pedido a la API de Claude', () => {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } });

  it('Opus 5.5, salida JSON con el esquema, esfuerzo medio y respaldo del servidor ante rechazos', async () => {
    const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fakeFetch: typeof fetch = async (i, init) => {
      const req = new Request(i, init);
      seen.push({ url: req.url, headers: req.headers, body: await req.json() });
      return reply(200, {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: '{"resumen":"ok","nota":"","bloques":[]}' }],
        usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      });
    };
    const llm = claudeLLM('sk-ant-prueba', { fetch: fakeFetch });
    const r = await llm({ system: 'S', user: 'U', ctx: planContext(input()), input: input() });
    expect(r).toEqual({ text: '{"resumen":"ok","nota":"","bloques":[]}', model: 'claude-opus-5-5', usage: { input: 1200, output: 300 } });
    const [call] = seen;
    expect(call!.url).toContain('https://api.anthropic.com/v1/messages');
    // El SDK 1.x manda la clave como "Authorization: Bearer"; versiones anteriores usaban x-api-key.
    expect(call!.headers.get('x-api-key') ?? call!.headers.get('authorization')).toContain('sk-ant-prueba');
    expect(call!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(call!.body).toMatchObject({
      model: PLAN_MODEL,
      fallbacks: 'default',
      system: 'S',
      messages: [{ role: 'user', content: 'U' }],
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    expect(call!.body.thinking).toBeUndefined(); // en Opus 5.5 el razonamiento siempre está activo
  });

  it('una clave inválida se explica en español', async () => {
    const llm = claudeLLM('sk-ant-mala', { fetch: async () => reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    await expect(llm({ system: 'S', user: 'U', ctx: planContext(input()), input: input() })).rejects.toMatchObject({
      code: 'misconfigured',
      provider: 'claude',
      message: expect.stringContaining('ANTHROPIC_API_KEY'),
    });
  });

  it('el nombre del modelo para mostrar', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
  });
});

describe('todo junto, con el TickTick simulado', () => {
  const today = dayKeyInZone(new Date(), TZ);
  const now = new Date(startOfDay(today, TZ).getTime() + (6 * 60 + 25) * 60000); // hoy a las 6:25
  const fakeLLM: PlanLLM = async ({ ctx, input: inp }) => {
    const s = ctx.slots[0]!;
    return {
      text: JSON.stringify({
        resumen: 'Hoy toca repasar.',
        nota: '',
        bloques: [{ inicio: hm(s.start), fin: hm(s.start + 60 * 60000), curso: inp.note.study.courses[0]!.name, tarea: 'Repasar', taskId: inp.tasks[0]?.id ?? '', motivo: 'prueba' }],
      }),
      model: 'claude-opus-5-5',
      usage: { input: 1000, output: 200 },
    };
  };
  const run = (kv: KVNamespace, llm: PlanLLM = fakeLLM) =>
    generatePlan({ kv, ticktick: client(), llm, calendar: async () => [] }, { now, timeZone: TZ, strategy: 'undone' });
  const planTasks = () => _mockAppTasks().filter((t) => (t.title ?? '').startsWith('☀️ Plan de hoy'));

  it('guarda el plan, cuenta el gasto y deja en TickTick una tarea de día completo con aviso a las 6:30', async () => {
    const kv = memKV();
    const plan = await run(kv);
    expect(plan).toMatchObject({ day: today, model: 'claude-opus-5-5', summary: 'Hoy toca repasar.', fallback: false, runs: 1 });
    expect(plan.blocks).toHaveLength(1);
    expect(await getDayPlan(kv, today)).toEqual(plan);

    const [t] = planTasks();
    expect(t).toMatchObject({
      isAllDay: true,
      timeZone: TZ,
      dueDate: formatTickTickDate(startOfDay(today, TZ)),
      reminders: ['TRIGGER:P0DT6H30M0S'],
      status: 0,
    });
    expect(t!.content).toContain('Hoy toca repasar.');
    expect(t!.content).toContain('Lo armó Claude (Opus 5.5) a las 06:25');

    // La tarea del plan sale en /task/undone (tiene fecha): la ruta /api/tasks la filtra por este id.
    expect(await planTaskId(kv)).toBe(t!.id);
    const tasks = await getPanelTasks(client(), { now: new Date(), timeZone: TZ, strategy: 'undone' });
    expect(tasks.tasks.some((x) => x.id === t!.id)).toBe(true);

    const st = await planStatus(kv, { now, timeZone: TZ, configured: true });
    expect(st).toMatchObject({ today, configured: true, on: true, plan, error: null, month: { runs: 1, input: 1000, output: 200 } });
    expect(st.month.cost).toBeCloseTo(0.008, 6); // 1000 × 4 + 200 × 20 por millón
  });

  it('reescribe la misma tarea; si la marcaste como hecha crea otra; y hay un tope de planes por día', async () => {
    const kv = memKV();
    await run(kv);
    await run(kv);
    expect(planTasks()).toHaveLength(1);
    planTasks()[0]!.status = 2; // hecha en TickTick
    const third = await run(kv);
    expect(third.runs).toBe(3);
    expect(planTasks()).toHaveLength(2);
    expect(planTasks().filter((t) => t.status === 0)).toHaveLength(1);
    for (let i = 3; i < MAX_RUNS; i++) await run(kv);
    await expect(run(kv)).rejects.toMatchObject({ status: 429 });
  });

  it('sin clave, en local: el plan de prueba son los bloques de la app', async () => {
    const kv = memKV();
    const plan = await run(kv, mockLLM);
    expect(plan.model).toBe('simulado');
    expect(plan.summary).toContain('Plan de prueba');
    expect(plan.fallback).toBe(false);
    expect(planTasks()[0]!.content).toContain('Plan de prueba a las 06:25');
  });
});
