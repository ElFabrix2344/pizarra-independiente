// Fechas de TickTick: "yyyy-MM-dd'T'HH:mm:ssZ" con offset sin dos puntos
// ("2026-10-11T00:00:00-0500", "2019-11-13T03:00:00.000+0000").
// `Date.parse` no acepta "+0000" de forma fiable, así que se normaliza a "+00:00".

const OFFSET_NO_COLON = /([+-])(\d{2})(\d{2})$/;

/** Convierte una fecha de TickTick a `Date`. Devuelve null si falta o no es válida. */
export function parseTickTickDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const s = String(value).trim().replace(OFFSET_NO_COLON, '$1$2:$3');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Formatea un instante en el formato que espera TickTick, en UTC: "2026-10-06T05:00:00+0000". */
export function formatTickTickDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

/** "YYYY-MM-DD" del instante `date` visto en la zona horaria `timeZone`. */
export function dayKeyInZone(date: Date, timeZone: string): string {
  // en-CA formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Día ("YYYY-MM-DD") al que pertenece la fecha de vencimiento de una tarea.
 * Las tareas de día completo se guardan como la medianoche en la zona de la
 * propia tarea, así que se evalúan en esa zona (si existe) para no correrse un día.
 */
export function taskDayKey(
  due: Date,
  opts: { isAllDay?: boolean; taskTimeZone?: string; displayTimeZone: string },
): string {
  if (opts.isAllDay && opts.taskTimeZone && isValidTimeZone(opts.taskTimeZone)) {
    return dayKeyInZone(due, opts.taskTimeZone);
  }
  return dayKeyInZone(due, opts.displayTimeZone);
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
