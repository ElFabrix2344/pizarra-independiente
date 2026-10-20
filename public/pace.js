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

  /**
   * Racha de la meta diaria: días seguidos que la cumplen, contando solo los días de la meta
   * (los libres no suman ni la cortan). Hoy, si aún no se cumple, tampoco la corta: sigue viva
   * hasta que termine el día. `days`: { 'YYYY-MM-DD': minutos }; se recorre de `from` a `today`.
   */
  function dailyStreak({ days, goal, weekdays, from, today }) {
    const add = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10); };
    const isGoalDay = (k) => weekdays.includes(new Date(k + 'T12:00:00Z').getUTCDay());
    let run = 0, best = 0, total = 0;
    for (let k = from; k <= today; k = add(k, 1)) {
      if (!isGoalDay(k)) continue;
      if ((days[k] || 0) >= goal) { run++; total++; if (run > best) best = run; }
      else if (k !== today) run = 0;
    }
    return { current: run, best, total, todayDone: isGoalDay(today) && (days[today] || 0) >= goal };
  }

  /** Premios por pasar la meta diaria: cada 30 min extra +1 flor (hasta 4), maceta dorada a +1 h y mariposa a +2 h (tope). */
  const BONUS_STEP = 30, BONUS_MAX = 4;
  function bonus(m, goal) {
    const none = { flowers: 0, extra: 0, gold: false, butterfly: false, level: 0, next: null };
    if (!goal || !(m >= goal)) return none;
    const cap = goal + BONUS_STEP * BONUS_MAX;
    const extra = Math.min(BONUS_MAX, Math.floor((Math.min(m, cap) - goal) / BONUS_STEP + 1e-9));
    const gold = m >= goal + 2 * BONUS_STEP, butterfly = m >= cap;
    return { flowers: 1 + extra, extra, gold, butterfly, level: butterfly ? 3 : gold ? 2 : 1, next: butterfly ? null : goal + (extra + 1) * BONUS_STEP };
  }

  /**
   * Récord del día y jardín (flores ganadas) desde `from` hasta `today`. `days`: { 'YYYY-MM-DD': minutos }.
   * prevBest es el mejor día antes de hoy: si hoy lo supera (y había alguno), es récord nuevo.
   */
  function garden({ days, goal, from, today }) {
    let best = 0, bestDay = null, prevBest = 0, prevBestDay = null, flowers = 0;
    for (const k of Object.keys(days).sort()) {
      if (k < from || k > today) continue;
      const m = days[k] || 0;
      if (m > best) { best = m; bestDay = k; }
      if (k < today && m > prevBest) { prevBest = m; prevBestDay = k; }
      flowers += bonus(m, goal).flowers;
    }
    return { best, bestDay, prevBest, prevBestDay, flowers, newRecord: prevBest > 0 && (days[today] || 0) > prevBest };
  }

  /**
   * Huecos libres en [from, to] (ms) entre eventos con hora, dejando `buffer` minutos antes y después
   * de cada uno. Solo los de al menos `min` minutos. events: [{ start, end }] en ms.
   */
  function freeSlots({ events, from, to, buffer = 10, min = 30 }) {
    const M = 60000;
    const busy = events
      .map((e) => [e.start - buffer * M, e.end + buffer * M])
      .filter(([a, b]) => b > from && a < to)
      .sort((x, y) => x[0] - y[0]);
    const out = [];
    let cur = from;
    for (const [a, b] of busy) {
      if (a > cur) out.push({ start: cur, end: Math.min(a, to) });
      cur = Math.max(cur, b);
      if (cur >= to) break;
    }
    if (cur < to) out.push({ start: cur, end: to });
    return out.filter((s) => s.end - s.start >= min * M);
  }

  /**
   * Reparte lo que falta estudiar en los huecos, en orden: `needs` ya viene por prioridad
   * ([{ course, minutes }]). Bloques de hasta `max` min (al menos `min`, redondeados a 15) con `gap`
   * de pausa entre bloques del mismo hueco. Necesidades de menos de 10 min se ignoran.
   */
  function suggestBlocks({ slots, needs, max = 90, min = 30, gap = 10, limit = 5 }) {
    const M = 60000, out = [];
    const left = needs.map((n) => ({ ...n, minutes: n.minutes >= 10 ? n.minutes : 0 }));
    for (const s of slots) {
      let t = Math.ceil(s.start / (5 * M)) * 5 * M; // empieza en un múltiplo de 5 min
      while (out.length < limit) {
        const n = left.find((x) => x.minutes > 0);
        const room = (s.end - t) / M;
        if (!n || room < min) break;
        const want = Math.max(min, Math.ceil(n.minutes / 15) * 15);
        const len = Math.min(max, want, Math.floor(room / 5) * 5);
        out.push({ start: t, end: t + len * M, course: n.course, minutes: len });
        n.minutes -= len;
        t += (len + gap) * M;
      }
      if (out.length >= limit || !left.some((x) => x.minutes > 0)) break;
    }
    return out;
  }

  root.Pace = { weekPlan, forecastWeek, pastWeeks, dailyStreak, bonus, garden, freeSlots, suggestBlocks };
})(typeof window !== 'undefined' ? window : globalThis);
