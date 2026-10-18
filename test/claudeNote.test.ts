import { beforeEach, describe, expect, it } from 'vitest';
import { TickTickClient } from '../src/lib/ticktick';
import { _mockAppTasks, _resetMockApp, mockFetch } from '../src/mock';
import { buildNote, fmtMinutes, getNoteState, NOTE_LIST, NOTE_TITLE, saveContext, syncNote, type NoteInput } from '../src/services/claudeNote';
import { buildResult } from '../src/services/grades';
import { _resetStudyCaches, type StudyDigest } from '../src/services/study';
import { _resetMetaCache, type PanelEvaluation } from '../src/services/tasks';

const TZ = 'America/Lima';
const client = () => new TickTickClient({ getAccessToken: async () => 'mock', fetch: mockFetch });

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

// La semana real del 12 al 18 de octubre de 2026 (la de la captura de la Bitácora).
const study: StudyDigest = {
  today: '2026-10-18',
  weekStart: '2026-10-12',
  weekEnd: '2026-10-18',
  cycleStart: '2026-08-10',
  courses: [
    { name: 'Estadística Aplicada', goalMinutes: 360 },
    { name: 'EPP', goalMinutes: 480 },
    { name: 'HEE', goalMinutes: null },
    { name: 'Pensamiento Social', goalMinutes: null },
  ],
  weeks: [
    { start: '2026-09-14', end: '2026-09-20', byCourse: {}, other: 0, total: 0 },
    { start: '2026-09-21', end: '2026-09-27', byCourse: {}, other: 0, total: 0 },
    { start: '2026-09-28', end: '2026-10-04', byCourse: { EPP: 120 }, other: 0, total: 120 },
    { start: '2026-10-05', end: '2026-10-11', byCourse: { 'Estadística Aplicada': 200, EPP: 250 }, other: 30, total: 480 },
    { start: '2026-10-12', end: '2026-10-18', byCourse: { 'Estadística Aplicada': 188, EPP: 497, HEE: 2 }, other: 0, total: 687 },
  ],
  days: {
    '2026-10-12': { 'Estadística Aplicada': 85, EPP: 107, HEE: 2 },
    '2026-10-13': { EPP: 19 },
    '2026-10-14': { 'Estadística Aplicada': 86, EPP: 149 },
    '2026-10-15': { 'Estadística Aplicada': 17, EPP: 165 },
    '2026-10-18': { EPP: 57 },
  },
  active: null,
};

const ev = (over: Partial<PanelEvaluation>): PanelEvaluation => ({
  id: 'e', projectId: 'inbox1', title: '', note: '', due: null, allDay: true, dayKey: null, priority: 5,
  list: 'Bandeja de entrada', column: null, tags: [], repeat: false, url: '', name: '', daysUntil: 0, ...over,
});

const input = (over: Partial<NoteInput> = {}): NoteInput => ({
  now: new Date('2026-10-18T21:40:00Z'), // domingo 16:40 en Lima
  timeZone: TZ,
  context: { text: 'Más peso a EPP por la PC3 del jueves; la PC2 de Aplicada es recién el 07/11.', updatedAt: 1 },
  study,
  evaluations: [
    ev({ id: 'e1', title: 'PC3 EPP — jueves 22/10, 17:30', name: 'PC3 EPP', column: 'EPP', allDay: false, due: '2026-10-22T22:30:00.000Z', dayKey: '2026-10-22', daysUntil: 4 }),
    ev({ id: 'e2', title: 'PC2 Estadística Aplicada — sábado 07/11 (R)', name: 'PC2 Estadística Aplicada', column: 'Estadística Aplicada', due: '2026-11-07T05:00:00.000Z', dayKey: '2026-11-07', daysUntil: 20 }),
  ],
  ignoredCount: 0,
  grades: buildResult(
    {
      cycleStart: '2026-08-10',
      courses: {
        'Estadística Aplicada': {
          credits: 4, academic: true, target: null,
          items: [
            { id: 'a', name: 'PC1', weight: 15, grade: 14 },
            { id: 'b', name: 'PC2', weight: 15, grade: 12 },
            { id: 'c', name: 'Parcial', weight: 30, grade: null },
            { id: 'd', name: 'Final', weight: 40, grade: null },
          ],
        },
      },
      prior: { average: null, credits: null },
    },
    study.courses.map((c) => c.name),
  ),
  ...over,
});

describe('contenido de la nota para Claude', () => {
  it('resume la semana, los días, las semanas anteriores, las evaluaciones y las notas', () => {
    const { body, content } = buildNote(input());
    const lines = content.split('\n');
    expect(lines).toContain('Escrito el domingo 18/10/2026 a las 16:40 (hora de Lima).');
    expect(lines).toContain('Más peso a EPP por la PC3 del jueves; la PC2 de Aplicada es recién el 07/11.');
    expect(lines).toContain('## Esta semana: lun 12/10 – dom 18/10 (hoy domingo; queda 1 día contando hoy)');
    expect(lines).toContain('Total: 11 h 27 · meta 14 h (suma de las metas por curso).');
    expect(lines).toContain('- Estadística Aplicada: 3 h 08 de 6 h · faltan 2 h 52');
    expect(lines).toContain('- EPP: 8 h 17 de 8 h ✓ cumplida');
    expect(lines).toContain('- HEE: 2 min (sin meta)');
    expect(lines).toContain('- Pensamiento Social: 0 min (sin meta)');
    expect(lines).toContain('- lun 12/10: 3 h 14 (Estadística Aplicada 1 h 25 · EPP 1 h 47 · HEE 2 min)');
    expect(lines).toContain('- mar 13/10: 19 min (EPP 19 min)');
    expect(lines).toContain('- vie 16/10: sin estudio');
    expect(lines).toContain('- dom 18/10 (hoy): 57 min (EPP 57 min)');
    // Las semanas sin registros antes de empezar a usar la app no cuentan como 0 h.
    expect(content).not.toContain('14/09');
    expect(lines).toContain('- 28/09 – 04/10: 2 h (EPP 2 h)');
    expect(lines).toContain('- 05/10 – 11/10: 8 h (Estadística Aplicada 3 h 20 · EPP 4 h 10 · Otros 30 min)');
    expect(lines).toContain('Promedio: 5 h por semana (2 semanas).');
    expect(lines).toContain('- jue 22/10, 17:30 — PC3 EPP (EPP) · en 4 días');
    expect(lines).toContain('- sáb 07/11 — PC2 Estadística Aplicada (Estadística Aplicada) · en 20 días');
    expect(lines).toContain('- Estadística Aplicada (4 cr): promedio 13 en lo evaluado (30 %); si sigue así, 13. Para aprobar (11): necesita 9.5 de promedio en lo que falta.');
    expect(lines).toContain('Ponderado proyectado del ciclo: 13.00.');
    expect(body).not.toContain('Escrito el');
    expect(content.endsWith(body)).toBe(true);
  });
  it('el cuerpo no cambia con la hora (solo con los datos): así no se reescribe de gusto', () => {
    const a = buildNote(input()).body;
    const b = buildNote(input({ now: new Date('2026-10-18T23:55:00Z') })).body;
    expect(b).toBe(a);
    expect(buildNote(input({ context: { text: 'Otro', updatedAt: 2 } })).body).not.toBe(a);
  });
  it('sin contexto, sin evaluaciones y con el cronómetro en marcha', () => {
    const startedAt = new Date('2026-10-18T21:05:00Z').getTime(); // 16:05
    const { content } = buildNote(input({ context: { text: '', updatedAt: null }, evaluations: [], grades: null, study: { ...study, active: { course: 'EPP', startedAt } } }));
    expect(content).toContain('Sin contexto escrito.');
    expect(content).toContain('Ninguna registrada en TickTick.');
    expect(content).toContain('En curso ahora: EPP desde las 16:05 (35 min; aún sin guardar).');
    expect(content).not.toContain('## Notas del ciclo');
  });
  it('formato de minutos', () => {
    expect(fmtMinutes(0)).toBe('0 min');
    expect(fmtMinutes(59.6)).toBe('1 h');
    expect(fmtMinutes(188)).toBe('3 h 08');
  });
});

describe('sincronización con TickTick', () => {
  const opts = (force = false) => ({ now: new Date(), timeZone: TZ, strategy: 'undone' as const, force });

  it('crea la lista y la nota; no reescribe si nada cambió; la recrea si la completan o la borran', async () => {
    const kv = memKV();
    const tt = client();
    expect(await syncNote(tt, kv, opts())).toBe('created');
    const notes = _mockAppTasks();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe(NOTE_TITLE);
    const lists = (await tt.listProjects()).filter((p) => p.name === NOTE_LIST);
    expect(lists).toHaveLength(1);
    expect(notes[0]!.projectId).toBe(lists[0]!.id);
    const st = await getNoteState(kv);
    expect(notes[0]!.content).toBe(st.content);
    expect(st.content).toContain('## Esta semana');

    // Sin cambios: no se toca TickTick (lo editado a mano sigue ahí).
    notes[0]!.content = 'editada a mano';
    expect(await syncNote(tt, kv, opts())).toBe('unchanged');
    expect(notes[0]!.content).toBe('editada a mano');
    // Forzado: se reescribe la misma tarea.
    expect(await syncNote(tt, kv, opts(true))).toBe('updated');
    expect(notes[0]!.content).toBe((await getNoteState(kv)).content);

    // El contexto cambia el contenido.
    await saveContext(kv, 'Priorizo EPP por la PC3.');
    expect(await syncNote(tt, kv, opts())).toBe('updated');
    expect(notes[0]!.content).toContain('Priorizo EPP por la PC3.');

    // La marcan como hecha en TickTick: se crea otra en la misma lista.
    notes[0]!.status = 2;
    await saveContext(kv, 'Otro contexto.');
    expect(await syncNote(tt, kv, opts())).toBe('created');
    expect(notes).toHaveLength(2);
    expect(notes[1]!.projectId).toBe(lists[0]!.id);

    // La borran: se crea otra.
    notes.splice(0, notes.length);
    expect(await syncNote(tt, kv, opts(true))).toBe('created');
    expect(notes).toHaveLength(1);
    expect((await tt.listProjects()).filter((p) => p.name === NOTE_LIST)).toHaveLength(1);
  });
  it('si se pierde el estado en KV, reutiliza la nota existente en vez de duplicarla', async () => {
    const tt = client();
    expect(await syncNote(tt, memKV(), opts())).toBe('created');
    expect(await syncNote(tt, memKV(), opts())).toBe('updated');
    expect(_mockAppTasks()).toHaveLength(1);
  });
  it('valida el contexto', async () => {
    const kv = memKV();
    await expect(saveContext(kv, 42)).rejects.toMatchObject({ status: 400 });
    await expect(saveContext(kv, 'x'.repeat(1501))).rejects.toMatchObject({ status: 400 });
    expect((await saveContext(kv, '  a\r\n\r\n\r\nb  ')).text).toBe('a\n\nb');
  });
});
