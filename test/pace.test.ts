import { beforeAll, describe, expect, it } from 'vitest';

type PaceApi = {
  weekPlan: (a: { goal: number; doneWeek: number; doneToday: number; daysLeft: number }) => null | {
    met: boolean; remaining: number; todayTarget: number; todayLeft: number; perDayAfter: number; daysAfter: number;
  };
  forecastWeek: (a: { perDay: number | null; doneWeek: number; doneToday: number; daysLeft: number }) => number | null;
  pastWeeks: (values: number[], goal: number, n?: number) => null | { count: number; average: number; met: number | null };
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
