// Utilidades de fecha por zona horaria (por defecto America/Lima, UTC-5 sin horario de verano).
// Un "dayKey" es "YYYY-MM-DD" en la zona indicada.

import { dayKeyInZone } from './ticktick/dates';

export { dayKeyInZone };

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Suma n días a un dayKey (aritmética de calendario, sin zona). */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

/** Días de calendario entre dos dayKeys (b - a). */
export function daysBetween(a: string, b: string): number {
  const toUtc = (k: string) => {
    const [y, m, d] = k.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** Desplazamiento (ms) de `timeZone` respecto de UTC en el instante `at`. Lima → -5 h. */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instante de la medianoche (00:00) del dayKey en `timeZone`. */
export function startOfDay(key: string, timeZone: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  // Dos pasadas por si el offset cambia cerca de la medianoche (no ocurre en Lima, pero es barato).
  let t = guess - zoneOffsetMs(new Date(guess), timeZone);
  t = guess - zoneOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

/** Último segundo del dayKey en `timeZone` (23:59:59). */
export function endOfDay(key: string, timeZone: string): Date {
  return new Date(startOfDay(addDays(key, 1), timeZone).getTime() - 1000);
}

/** RFC3339 con el offset de la zona, p. ej. "2026-10-06T00:00:00-05:00" (para Google Calendar). */
export function toRfc3339InZone(at: Date, timeZone: string): string {
  const off = zoneOffsetMs(at, timeZone);
  const local = new Date(at.getTime() + off).toISOString().slice(0, 19);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off) / 60000;
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}
