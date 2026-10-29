// Ritmo y bloques en el servidor. La lógica vive en public/pace.js (la usa el navegador) y el Worker
// importa el mismo archivo: así el plan de la mañana y los bloques sugeridos de la Agenda calculan igual.
// @ts-ignore: archivo JS del frontend, sin tipos
import '../../public/pace.js';

export interface WeekPlan {
  met: boolean;
  remaining: number;
  todayTarget: number;
  todayLeft: number;
  perDayAfter: number;
  daysAfter: number;
}
/** Intervalo en ms. */
export interface Slot {
  start: number;
  end: number;
}
export interface Block extends Slot {
  course: string;
  minutes: number;
}

interface PaceApi {
  weekPlan(a: { goal: number; doneWeek: number; doneToday: number; daysLeft: number }): WeekPlan | null;
  freeSlots(a: { events: Slot[]; from: number; to: number; buffer?: number; min?: number }): Slot[];
  suggestBlocks(a: {
    slots: Slot[];
    needs: Array<{ course: string; minutes: number }>;
    max?: number;
    min?: number;
    gap?: number;
    limit?: number;
  }): Block[];
}

export const Pace = (globalThis as unknown as { Pace: PaceApi }).Pace;
