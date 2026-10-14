// Ritmo y pronóstico de estudio (lógica pura, sin DOM). Lo usa app.js en el navegador
// y las pruebas (vitest) importan este mismo archivo. Todo en minutos.
(function (root) {
  'use strict';

  /**
   * Plan de la semana para una meta.
   * La meta de hoy se fija con lo que había antes de hoy: (meta − hecho antes de hoy) / días que quedan (incluye hoy),
   * así no cambia mientras estudias. Lo de "luego" supone que hoy cumples la meta de hoy (o lo que ya hiciste, si es más).
   */
  function weekPlan({ goal, doneWeek, doneToday, daysLeft }) {
    if (!goal || goal <= 0) return null;
    const days = Math.max(1, daysLeft);
    const doneBefore = Math.max(0, doneWeek - doneToday);
    if (doneWeek >= goal) return { met: true, remaining: 0, todayTarget: 0, todayLeft: 0, perDayAfter: 0, daysAfter: days - 1 };
    const todayTarget = Math.max(0, (goal - doneBefore) / days);
    const todayLeft = Math.max(0, todayTarget - doneToday);
    const afterToday = Math.max(0, goal - doneBefore - Math.max(doneToday, todayTarget));
    const perDayAfter = days > 1 ? afterToday / (days - 1) : 0;
    return { met: false, remaining: goal - doneWeek, todayTarget, todayLeft, perDayAfter, daysAfter: days - 1 };
  }

  /** Total al domingo si sigues a tu ritmo: lo de antes de hoy + hoy (lo hecho o el ritmo, lo mayor) + ritmo × días restantes. */
  function forecastWeek({ perDay, doneWeek, doneToday, daysLeft }) {
    if (perDay === null || perDay === undefined) return null;
    const doneBefore = Math.max(0, doneWeek - doneToday);
    return doneBefore + Math.max(doneToday, perDay) + perDay * Math.max(0, daysLeft - 1);
  }

  /** Últimas `n` semanas completas: promedio y cuántas alcanzan `goal`. `values` en orden cronológico. */
  function pastWeeks(values, goal, n = 4) {
    const last = values.slice(-n);
    if (!last.length) return null;
    const avg = last.reduce((a, b) => a + b, 0) / last.length;
    return { count: last.length, average: avg, met: goal ? last.filter((v) => v >= goal).length : null };
  }

  root.Pace = { weekPlan, forecastWeek, pastWeeks };
})(typeof window !== 'undefined' ? window : globalThis);
