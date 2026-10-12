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
    expect(focusSeconds({ id: 'a', duration: 1500 })).toBe(1500);
    expect(focusSeconds({ id: 'b', startTime: '2026-04-07T09:00:00+0800', endTime: '2026-04-07T09:25:00+0800', pauseDuration: 60 })).toBe(1440);
  });
  it('curso desde la nota y desde el título', () => {
    const courses = ['Estadística Aplicada', 'EPP', 'HEE', 'Pensamiento Social', 'EFE'];
    expect(courseFromNote('Pizarra · HEE', courses)).toBe('HEE');
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
