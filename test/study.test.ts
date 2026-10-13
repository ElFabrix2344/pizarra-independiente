import { beforeEach, describe, expect, it } from 'vitest';
import { TickTickClient } from '../src/lib/ticktick';
import { mockFetch } from '../src/mock';
import {
  _resetStudyCaches,
  addManual,
  courseFromNote,
  courseFromTitle,
  focusSeconds,
  getStudy,
  mondayOf,
  saveGoals,
  startStudy,
  stopStudy,
  StudyStore,
  weekRange,
} from '../src/services/study';

const TZ = 'America/Lima';
const client = () => new TickTickClient({ getAccessToken: async () => 'mock', fetch: mockFetch });

/** KV mínimo en memoria con la parte de la API que usa StudyStore. */
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

beforeEach(() => _resetStudyCaches());

describe('utilidades de estudio', () => {
  it('lunes de la semana', () => {
    expect(mondayOf('2026-10-12')).toBe('2026-10-12'); // lunes
    expect(mondayOf('2026-10-18')).toBe('2026-10-12'); // domingo
    expect(mondayOf('2026-10-14')).toBe('2026-10-12');
    const w = weekRange(new Date('2026-10-14T15:00:00Z'), TZ);
    expect(w.from.toISOString()).toBe('2026-10-12T05:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-19T04:59:59.000Z');
  });
  it('segundos de un registro', () => {
    // Registro real devuelto por TickTick: 69 s con "duration": 69000 (milisegundos).
    expect(focusSeconds({ id: 'real', type: 1, note: 'Pizarra · HEE', startTime: '2026-10-12T15:16:24+0000', endTime: '2026-10-12T15:17:33+0000', pauseDuration: 0, duration: 69000 })).toBe(69);
    expect(focusSeconds({ id: 'a', duration: 1500 })).toBe(1500);
    expect(focusSeconds({ id: 'ms', duration: 1_500_000 })).toBe(1500);
    expect(focusSeconds({ id: 'b', startTime: '2026-04-07T09:00:00+0800', endTime: '2026-04-07T09:25:00+0800', pauseDuration: 60 })).toBe(1440);
  });
  it('curso desde la nota y desde el título', () => {
    const courses = ['Estadística Aplicada', 'EPP', 'HEE', 'Pensamiento Social', 'EFE'];
    expect(courseFromNote('Bitácora · HEE', courses)).toBe('HEE');
    expect(courseFromNote('Pizarra · HEE', courses)).toBe('HEE'); // nombre anterior de la app
    expect(courseFromNote('Pizarra · estadistica aplicada · manual', courses)).toBe('Estadística Aplicada');
    expect(courseFromNote('otra cosa', courses)).toBeNull();
    expect(courseFromTitle('Lectura HEE — víspera de sesión lunes', courses)).toBe('HEE');
    expect(courseFromTitle('PC3 EPP', courses)).toBe('EPP');
    expect(courseFromTitle('Ejercicios de Estadística Aplicada', courses)).toBe('Estadística Aplicada');
    expect(courseFromTitle('HEEX no es HEE?', ['HEEX2'])).toBeNull();
    expect(courseFromTitle('Leer capítulo', courses)).toBeNull();
  });
});

describe('getStudy', () => {
  it('cursos = columnas del inbox sin Personal/Not Sectioned; curso por nota o por columna de la tarea', async () => {
    const now = new Date();
    const r = await getStudy(client(), new StudyStore(memKV()), { now, timeZone: TZ });
    expect(r.courses.map((c) => c.name)).toEqual(['Estadística Aplicada', 'EPP', 'HEE']);
    const w = weekRange(now, TZ);
    for (const s of r.sessions) expect(new Date(s.start) >= w.from).toBe(true);
    const byLabel = Object.fromEntries(r.sessions.map((s) => [s.label, s]));
    // Las semillas pueden caer en la semana anterior si hoy es lunes temprano: solo se verifican las que están.
    if (byLabel['Responder correo del grupo']) {
      expect(byLabel['Responder correo del grupo']!.course).toBe('HEE'); // columna de la tarea
      expect(byLabel['Responder correo del grupo']!.source).toBe('ticktick');
    }
    if (byLabel['pizarra']) expect(byLabel['pizarra']!.course).toBe('EPP');
    if (byLabel['Estudio libre']) expect(byLabel['Estudio libre']!.course).toBeNull();
    const sum = r.courses.reduce((a, c) => a + c.minutes, 0) + r.otherMinutes;
    expect(sum).toBe(r.totalMinutes);
  });
});

describe('cronómetro, manual y metas', () => {
  it('start → stop guarda un registro con la nota del curso', async () => {
    const store = new StudyStore(memKV());
    const t0 = Date.now() - 45 * 60000;
    await startStudy(client(), store, 'hee', t0);
    expect((await store.getActive())?.course).toBe('HEE');
    await expect(startStudy(client(), store, 'EPP', t0)).rejects.toMatchObject({ status: 409 });
    const res = await stopStudy(client(), store, t0 + 45 * 60000);
    expect(res).toMatchObject({ saved: true, minutes: 45, course: 'HEE' });
    expect(await store.getActive()).toBeNull();
    const r = await getStudy(client(), store, { now: new Date(), timeZone: TZ });
    expect(r.sessions.some((s) => s.id === (res as { id: string }).id && s.course === 'HEE' && s.minutes === 45)).toBe(true);
  });
  it('menos de un minuto no se guarda', async () => {
    const store = new StudyStore(memKV());
    const t0 = Date.now();
    await startStudy(client(), store, 'EPP', t0);
    expect(await stopStudy(client(), store, t0 + 20000)).toMatchObject({ saved: false });
  });
  it('curso desconocido o duración inválida se rechazan', async () => {
    const store = new StudyStore(memKV());
    await expect(startStudy(client(), store, 'Química')).rejects.toMatchObject({ status: 400 });
    await expect(addManual(client(), new StudyStore(memKV()), { course: 'HEE', minutes: 0 }, { now: new Date(), timeZone: TZ })).rejects.toMatchObject({ status: 400 });
    await expect(addManual(client(), new StudyStore(memKV()), { course: 'HEE', minutes: 30, date: '2999-01-01' }, { now: new Date(), timeZone: TZ })).rejects.toMatchObject({ status: 400 });
  });
  it('sesión manual de hoy cuenta para el curso', async () => {
    const now = new Date();
    const res = await addManual(client(), new StudyStore(memKV()), { course: 'Estadística Aplicada', minutes: 75 }, { now, timeZone: TZ });
    const r = await getStudy(client(), new StudyStore(memKV()), { now, timeZone: TZ });
    const s = r.sessions.find((x) => x.id === res.id)!;
    expect(s).toMatchObject({ course: 'Estadística Aplicada', minutes: 75, label: 'manual' });
  });
  it('metas: solo cursos válidos y minutos positivos', async () => {
    const store = new StudyStore(memKV());
    const r = await saveGoals(client(), store, { HEE: 300, 'estadística aplicada': 240, Química: 60, EPP: -5 });
    expect(r.goals).toEqual({ HEE: 300, 'Estadística Aplicada': 240 });
    const st = await getStudy(client(), store, { now: new Date(), timeZone: TZ });
    expect(st.courses.find((c) => c.name === 'HEE')!.goalMinutes).toBe(300);
    expect(st.courses.find((c) => c.name === 'EPP')!.goalMinutes).toBeNull();
    expect(st.goalTotalMinutes).toBe(540);
  });
});

describe('cursos visibles', () => {
  it('ocultar columnas y agregar cursos propios', async () => {
    const { saveCourses } = await import('../src/services/study');
    const store = new StudyStore(memKV());
    const r = await saveCourses(client(), store, { hidden: ['epp'], extra: ['Inglés', ' Inglés ', 'Tesis  I'] });
    expect(r.hidden).toEqual(['EPP']);
    expect(r.extra).toEqual(['Inglés', 'Tesis I']);
    expect(r.courses).toEqual(['Estadística Aplicada', 'HEE', 'Inglés', 'Tesis I']);

    const st = await getStudy(client(), store, { now: new Date(), timeZone: TZ });
    expect(st.courses.map((c) => c.name)).toEqual(['Estadística Aplicada', 'HEE', 'Inglés', 'Tesis I']);
    expect(st.courseOptions.find((o) => o.name === 'EPP')).toEqual({ name: 'EPP', source: 'ticktick', visible: false });
    // La sesión de EPP sigue sumando al total, pero en "Otros".
    const sum = st.courses.reduce((a, c) => a + c.minutes, 0) + st.otherMinutes;
    expect(sum).toBe(st.totalMinutes);

    await expect(startStudy(client(), store, 'EPP')).rejects.toMatchObject({ status: 400 });
    await expect(startStudy(client(), store, 'inglés')).resolves.toMatchObject({ active: { course: 'Inglés' } });
  });
  it('rechaza cursos extra que ya son columnas, "General" o demasiado largos', async () => {
    const { saveCourses } = await import('../src/services/study');
    const store = new StudyStore(memKV());
    await expect(saveCourses(client(), store, { extra: ['HEE'] })).rejects.toMatchObject({ status: 400 });
    await expect(saveCourses(client(), store, { extra: ['general'] })).rejects.toMatchObject({ status: 400 });
    await expect(saveCourses(client(), store, { extra: ['x'.repeat(41)] })).rejects.toMatchObject({ status: 400 });
  });
  it('las metas solo valen para cursos visibles y se conservan al cambiar cursos', async () => {
    const { saveCourses } = await import('../src/services/study');
    const store = new StudyStore(memKV());
    await saveGoals(client(), store, { HEE: 300, EPP: 120 });
    await saveCourses(client(), store, { hidden: ['EPP'] });
    expect((await store.getSettings()).goals).toEqual({ HEE: 300, EPP: 120 });
    const r = await saveGoals(client(), store, { HEE: 240, EPP: 60 });
    expect(r.goals).toEqual({ HEE: 240 });
  });
});

describe('historial del ciclo', () => {
  it('semanas desde el inicio del ciclo hasta la actual, con totales coherentes', async () => {
    const { getHistory, saveCycleStart } = await import('../src/services/study');
    const now = new Date();
    const store = new StudyStore(memKV());
    const w = weekRange(now, TZ);
    const tenAgo = new Date(w.from.getTime() - 10 * 7 * 86400000 + 12 * 3600000).toISOString().slice(0, 10);
    await saveCycleStart(store, tenAgo, { now, timeZone: TZ });
    const h = await getHistory(client(), store, { now, timeZone: TZ });
    expect(h.weeks.length).toBe(11);
    expect(h.weeks.at(-1)!.start).toBe(w.monday);
    expect(h.currentWeek).toBe(w.monday);
    expect(h.courses).toEqual(['Estadística Aplicada', 'EPP', 'HEE']);
    for (const wk of h.weeks) {
      const sum = Object.values(wk.byCourse).reduce((a, b) => a + b, 0) + wk.other;
      expect(sum).toBe(wk.total);
    }
    const byCourse = Object.values(h.totals).reduce((a, b) => a + b, 0) + h.otherTotal;
    expect(byCourse).toBe(h.total);
    // las semillas del mock dan horas a semanas anteriores
    expect(h.weeks.slice(0, -1).some((wk) => wk.total > 0)).toBe(true);
    expect(h.truncated).toBe(false);
  });
  it('sin fecha configurada usa 12 semanas; un ciclo muy largo se recorta a 26', async () => {
    const { getHistory, saveCycleStart, MAX_HISTORY_WEEKS } = await import('../src/services/study');
    const now = new Date();
    const store = new StudyStore(memKV());
    expect((await getHistory(client(), store, { now, timeZone: TZ })).weeks.length).toBe(12);
    const longAgo = new Date(now.getTime() - 40 * 7 * 86400000).toISOString().slice(0, 10);
    await saveCycleStart(store, longAgo, { now, timeZone: TZ });
    const h = await getHistory(client(), store, { now, timeZone: TZ });
    expect(h.weeks.length).toBe(MAX_HISTORY_WEEKS);
    expect(h.truncated).toBe(true);
  });
  it('valida la fecha de inicio', async () => {
    const { saveCycleStart } = await import('../src/services/study');
    const store = new StudyStore(memKV());
    const opts = { now: new Date(), timeZone: TZ };
    await expect(saveCycleStart(store, '2999-01-01', opts)).rejects.toMatchObject({ status: 400 });
    await expect(saveCycleStart(store, 'ayer', opts)).rejects.toMatchObject({ status: 400 });
    await expect(saveCycleStart(store, '2001-01-01', opts)).rejects.toMatchObject({ status: 400 });
  });
});

describe('pausa del cronómetro', () => {
  it('solo cuenta el tiempo activo y la sesión termina al parar', async () => {
    const { pauseStudy, resumeStudy, activeMs } = await import('../src/services/study');
    const store = new StudyStore(memKV());
    const M = 60000, t0 = Date.now() - 60 * M;
    await startStudy(client(), store, 'HEE', t0);
    await pauseStudy(store, t0 + 20 * M);
    expect(activeMs((await store.getActive())!, t0 + 30 * M)).toBe(20 * M); // en pausa no avanza
    await resumeStudy(store, t0 + 35 * M);
    await pauseStudy(store, t0 + 40 * M);
    await resumeStudy(store, t0 + 42 * M);
    const res = await stopStudy(client(), store, t0 + 52 * M); // 20 + 5 + 10 = 35 min activos
    expect(res).toMatchObject({ saved: true, minutes: 35, course: 'HEE' });
    const r = await getStudy(client(), store, { now: new Date(), timeZone: TZ });
    const s = r.sessions.find((x) => x.id === (res as { id: string }).id)!;
    expect(s.minutes).toBe(35);
    expect(new Date(s.end!).getTime()).toBe(Math.floor((t0 + 52 * M) / 1000) * 1000); // TickTick guarda segundos
  });
  it('parar en pausa guarda hasta el inicio de la pausa', async () => {
    const { pauseStudy } = await import('../src/services/study');
    const store = new StudyStore(memKV());
    const M = 60000, t0 = Date.now() - 90 * M;
    await startStudy(client(), store, 'EPP', t0);
    await pauseStudy(store, t0 + 25 * M);
    const res = await stopStudy(client(), store, t0 + 80 * M);
    expect(res).toMatchObject({ saved: true, minutes: 25 });
  });
  it('estados inválidos dan 409', async () => {
    const { pauseStudy, resumeStudy } = await import('../src/services/study');
    const store = new StudyStore(memKV());
    await expect(pauseStudy(store)).rejects.toMatchObject({ status: 409 });
    await startStudy(client(), store, 'HEE');
    await expect(resumeStudy(store)).rejects.toMatchObject({ status: 409 });
    await pauseStudy(store);
    await expect(pauseStudy(store)).rejects.toMatchObject({ status: 409 });
  });
  it('cronómetros guardados antes de existir la pausa siguen funcionando', async () => {
    const { activeMs } = await import('../src/services/study');
    expect(activeMs({ course: 'HEE', startedAt: 1000 }, 61000)).toBe(60000);
  });
});

describe('constancia (rachas)', () => {
  it('racha actual, mejor racha y días activos', async () => {
    const { computeStreak } = await import('../src/services/study');
    const d = { '2026-10-01': 30, '2026-10-02': 45, '2026-10-03': 10, '2026-10-05': 60, '2026-10-06': 20, '2026-10-07': 90 };
    expect(computeStreak(d, '2026-10-01', '2026-10-07')).toEqual({ current: 3, todayDone: true, best: 3, activeDays: 6, totalDays: 7 });
    // hoy aún sin estudiar: la racha cuenta hasta ayer y sigue viva
    expect(computeStreak(d, '2026-10-01', '2026-10-08')).toMatchObject({ current: 3, todayDone: false });
    // un día entero sin estudiar la corta
    expect(computeStreak(d, '2026-10-01', '2026-10-09')).toMatchObject({ current: 0, todayDone: false, best: 3, activeDays: 6, totalDays: 9 });
    expect(computeStreak({}, '2026-10-01', '2026-10-01')).toEqual({ current: 0, todayDone: false, best: 0, activeDays: 0, totalDays: 1 });
  });
  it('el historial trae minutos por día coherentes con las semanas', async () => {
    const { getHistory } = await import('../src/services/study');
    const h = await getHistory(client(), new StudyStore(memKV()), { now: new Date(), timeZone: TZ });
    const sumDays = Object.values(h.days).reduce((a, b) => a + b, 0);
    expect(sumDays).toBe(h.total);
    expect(h.today).toBe(weekRange(new Date(), TZ).today);
    expect(h.streak.totalDays).toBeGreaterThan(0);
  });
});
