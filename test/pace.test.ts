import { beforeAll, describe, expect, it } from 'vitest';

type PaceApi = {
  weekPlan: (a: { goal: number; doneWeek: number; doneToday: number; daysLeft: number }) => null | {
    met: boolean; remaining: number; todayTarget: number; todayLeft: number; perDayAfter: number; daysAfter: number;
  };
  forecastWeek: (a: { perDay: number | null; doneWeek: number; doneToday: number; daysLeft: number }) => number | null;
  pastWeeks: (values: number[], goal: number, n?: number) => null | { count: number; average: number; met: number | null };
  dailyStreak: (a: { days: Record<string, number>; goal: number; weekdays: number[]; from: string; today: string }) => {
    current: number; best: number; total: number; todayDone: boolean;
  };
  bonus: (m: number, goal: number) => { flowers: number; extra: number; gold: boolean; butterfly: boolean; level: number; next: number | null };
  garden: (a: { days: Record<string, number>; goal: number; from: string; today: string }) => {
    best: number; bestDay: string | null; prevBest: number; prevBestDay: string | null; flowers: number; newRecord: boolean;
  };
  freeSlots: (a: { events: Array<{ start: number; end: number }>; from: number; to: number; buffer?: number; min?: number }) => Array<{ start: number; end: number }>;
  suggestBlocks: (a: { slots: Array<{ start: number; end: number }>; needs: Array<{ course: string; minutes: number }>; max?: number; min?: number; gap?: number; limit?: number }) =>
    Array<{ start: number; end: number; course: string; minutes: number }>;
};
let Pace: PaceApi;

beforeAll(async () => {
  // @ts-expect-error: archivo JS del frontend, sin tipos
  await import('../public/pace.js');
  Pace = (globalThis as unknown as { Pace: PaceApi }).Pace;
});

describe('ritmo necesario', () => {
  it('lunes sin nada: meta / 7 cada día', () => {
    const p = Pace.weekPlan({ goal: 16 * 60, doneWeek: 0, doneToday: 0, daysLeft: 7 })!;
    expect(p.todayTarget).toBeCloseTo(137.14, 1); // 2 h 17
    expect(p.perDayAfter).toBeCloseTo(137.14, 1);
    expect(p.remaining).toBe(960);
  });
  it('la meta de hoy no cambia mientras estudias; si haces de más, baja lo de los días siguientes', () => {
    // jueves (quedan 4 días), 6 h hechas antes de hoy, meta 16 h → hoy (960−360)/4 = 150
    const a = Pace.weekPlan({ goal: 960, doneWeek: 360, doneToday: 0, daysLeft: 4 })!;
    expect(a.todayTarget).toBe(150);
    expect(a.todayLeft).toBe(150);
    const b = Pace.weekPlan({ goal: 960, doneWeek: 420, doneToday: 60, daysLeft: 4 })!;
    expect(b.todayTarget).toBe(150);
    expect(b.todayLeft).toBe(90);
    expect(b.perDayAfter).toBe(150); // si cumples hoy, igual que antes
    const c = Pace.weekPlan({ goal: 960, doneWeek: 600, doneToday: 240, daysLeft: 4 })!;
    expect(c.todayLeft).toBe(0);
    expect(c.perDayAfter).toBe(120); // (960 − 360 − 240) / 3
  });
  it('domingo: todo lo que falta es para hoy; meta cumplida; sin meta', () => {
    const d = Pace.weekPlan({ goal: 600, doneWeek: 500, doneToday: 20, daysLeft: 1 })!;
    expect(d.todayTarget).toBe(120);
    expect(d.todayLeft).toBe(100);
    expect(d.daysAfter).toBe(0);
    expect(Pace.weekPlan({ goal: 600, doneWeek: 650, doneToday: 0, daysLeft: 3 })!.met).toBe(true);
    expect(Pace.weekPlan({ goal: 0, doneWeek: 0, doneToday: 0, daysLeft: 3 })).toBeNull();
  });
});

describe('pronóstico con tu ritmo real', () => {
  it('total al domingo a tu ritmo', () => {
    // miércoles (quedan 5 días), 3 h antes de hoy, 20 min hoy, ritmo 60/día → 180 + 60 + 4·60 = 480
    expect(Pace.forecastWeek({ perDay: 60, doneWeek: 200, doneToday: 20, daysLeft: 5 })).toBe(480);
    // si hoy ya hiciste más que tu ritmo, cuenta lo hecho
    expect(Pace.forecastWeek({ perDay: 60, doneWeek: 300, doneToday: 120, daysLeft: 5 })).toBe(540);
    expect(Pace.forecastWeek({ perDay: null, doneWeek: 0, doneToday: 0, daysLeft: 5 })).toBeNull();
  });
  it('últimas semanas: promedio y cuántas cumplen la meta', () => {
    expect(Pace.pastWeeks([300, 900, 1000, 500, 700], 960)).toEqual({ count: 4, average: 775, met: 1 });
    expect(Pace.pastWeeks([], 960)).toBeNull();
  });
});

describe('racha de la meta diaria (4 h, lunes a viernes)', () => {
  const L_V = [1, 2, 3, 4, 5];
  // lun 12 ✓, mar 13 ✓, mié 14 ✗, jue 15 ✓, vie 16 ✓, sáb y dom libres, lun 19 = hoy
  const week = { '2026-10-12': 250, '2026-10-13': 240, '2026-10-14': 100, '2026-10-15': 300, '2026-10-16': 260 };
  const run = (today: Record<string, number>, from = '2026-10-12') =>
    Pace.dailyStreak({ days: { ...week, ...today }, goal: 240, weekdays: L_V, from, today: '2026-10-19' });

  it('el fin de semana no corta la racha y hoy, sin cumplir aún, tampoco', () => {
    expect(run({ '2026-10-19': 50 })).toEqual({ current: 2, best: 2, total: 4, todayDone: false });
  });
  it('al cumplir hoy, suma', () => {
    expect(run({ '2026-10-19': 245 })).toEqual({ current: 3, best: 3, total: 5, todayDone: true });
  });
  it('un día de la meta sin cumplir sí la corta', () => {
    expect(run({ '2026-10-16': 100, '2026-10-19': 0 })).toMatchObject({ current: 0, best: 2, total: 3 });
  });
  it('estudiar el fin de semana no suma a la racha de días de la meta', () => {
    expect(run({ '2026-10-17': 300, '2026-10-19': 0 })).toMatchObject({ current: 2, total: 4 });
  });
});

describe('bloques sugeridos', () => {
  // Horas en minutos desde la medianoche (ms) para leer las pruebas fácil.
  const h = (hh: number, mm = 0) => (hh * 60 + mm) * 60000;
  const hm = (ms: number) => `${Math.floor(ms / 3600000)}:${String((ms / 60000) % 60).padStart(2, '0')}`;

  it('huecos entre clases, con 10 min antes y después de cada evento, y solo de 30 min o más', () => {
    const events = [
      { start: h(9, 30), end: h(11, 20) }, // clase
      { start: h(11, 30), end: h(12, 0) }, // reunión que se pega a la clase
      { start: h(18, 30), end: h(21, 20) },
    ];
    const slots = Pace.freeSlots({ events, from: h(8), to: h(22) });
    expect(slots.map((s) => `${hm(s.start)}-${hm(s.end)}`)).toEqual(['8:00-9:20', '12:10-18:20', '21:30-22:00']);
    // El de 21:30 a 22:00 dura 30 min justos: entra; con mínimo de 45, no.
    expect(Pace.freeSlots({ events, from: h(8), to: h(22), min: 45 })).toHaveLength(2);
    // Desde "ahora" (14:07) recorta el hueco de la tarde.
    expect(Pace.freeSlots({ events, from: h(14, 7), to: h(22) }).map((s) => hm(s.start))).toEqual(['14:07', '21:30']);
  });
  it('reparte por prioridad en bloques de hasta 90 min con 10 min de pausa', () => {
    const slots = [{ start: h(12, 10), end: h(18, 20) }];
    const out = Pace.suggestBlocks({ slots, needs: [{ course: 'EPP', minutes: 150 }, { course: 'HEE', minutes: 20 }, { course: 'PSC', minutes: 5 }] });
    expect(out.map((b) => `${hm(b.start)}-${hm(b.end)} ${b.course}`)).toEqual([
      '12:10-13:40 EPP', // 90 (tope)
      '13:50-14:50 EPP', // los 60 que faltan
      '15:00-15:30 HEE', // 20 → mínimo 30
    ]); // PSC: menos de 10 min, se ignora
  });
  it('si un hueco no alcanza, sigue en el siguiente; empieza en múltiplos de 5 min', () => {
    const slots = [{ start: h(14, 7), end: h(14, 50) }, { start: h(21, 30), end: h(22, 0) }];
    const out = Pace.suggestBlocks({ slots, needs: [{ course: 'EPP', minutes: 75 }] });
    expect(out.map((b) => `${hm(b.start)}-${hm(b.end)}`)).toEqual(['14:10-14:50', '21:30-22:00']);
  });
});

describe('premios al pasar las 4 h (tope 6 h)', () => {
  it('una flor más cada 30 min, maceta dorada a las 5 h y mariposa a las 6 h', () => {
    expect(Pace.bonus(239, 240)).toMatchObject({ flowers: 0, level: 0, next: null });
    expect(Pace.bonus(240, 240)).toEqual({ flowers: 1, extra: 0, gold: false, butterfly: false, level: 1, next: 270 });
    expect(Pace.bonus(275, 240)).toMatchObject({ flowers: 2, gold: false, next: 300 });
    expect(Pace.bonus(300, 240)).toMatchObject({ flowers: 3, gold: true, butterfly: false, level: 2, next: 330 });
    expect(Pace.bonus(360, 240)).toEqual({ flowers: 5, extra: 4, gold: true, butterfly: true, level: 3, next: null });
    // Después del tope no hay más premios.
    expect(Pace.bonus(480, 240)).toMatchObject({ flowers: 5, butterfly: true, next: null });
  });
  it('récord del ciclo y jardín (flores de todos los días que florecieron, también fines de semana)', () => {
    const days = { '2026-10-05': 500, '2026-10-12': 250, '2026-10-14': 320, '2026-10-17': 245, '2026-10-19': 330 };
    const g = Pace.garden({ days, goal: 240, from: '2026-10-10', today: '2026-10-19' });
    // 10-05 queda antes del inicio. Flores: 250→1, 320→3, 245→1, 330→4 = 9
    expect(g).toEqual({ best: 330, bestDay: '2026-10-19', prevBest: 320, prevBestDay: '2026-10-14', flowers: 9, newRecord: true });
    expect(Pace.garden({ days: { '2026-10-19': 100 }, goal: 240, from: '2026-10-10', today: '2026-10-19' }).newRecord).toBe(false);
  });
});
