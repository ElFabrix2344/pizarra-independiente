import { GoogleError, listCalendars, listEvents, type GoogleEvent } from '../lib/google';
import { addDays, dayKeyInZone, endOfDay, startOfDay, toRfc3339InZone } from '../lib/time';

export const CAL_DAYS = 7;

export interface PanelEvent {
  id: string;
  title: string;
  desc: string;
  start: string; // ISO UTC
  end: string; // ISO UTC
  allDay: boolean;
  dayKey: string;
  link: string | null;
  /** Nombre del calendario de origen (p. ej. "UP 26-1"). */
  calendar: string;
  /** Color del calendario en Google ("#rrggbb"), si lo hay. */
  color: string | null;
}

export interface CalendarResult {
  generatedAt: string;
  timeZone: string;
  today: string;
  /** Calendarios leídos. */
  calendars: Array<{ id: string; name: string; ok: boolean }>;
  events: PanelEvent[];
}

interface CalendarSource {
  id: string;
  name: string;
  color: string | null;
}

/**
 * Qué calendarios leer. Por defecto, todos los propios (accessRole "owner") y no ocultos:
 * el principal y los que crees tú (p. ej. el de clases). Los suscritos (feriados) quedan fuera.
 * `override` (CALENDAR_IDS) permite fijar la lista a mano: ids separados por comas, "primary" vale.
 */
export async function resolveCalendars(accessToken: string, override: string | undefined, fetchImpl?: typeof fetch): Promise<CalendarSource[]> {
  const ids = (override ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ids.length) return ids.map((id) => ({ id, name: id === 'primary' ? 'Principal' : id, color: null }));
  const list = await listCalendars({ accessToken, minAccessRole: 'owner' }, fetchImpl);
  const own = list.filter((c) => !c.hidden && (c.accessRole === undefined || c.accessRole === 'owner'));
  if (!own.length) return [{ id: 'primary', name: 'Principal', color: null }];
  return own
    .sort((a, b) => Number(!!b.primary) - Number(!!a.primary))
    .map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor ?? null }));
}

/** Las descripciones de Google Calendar pueden traer HTML; el panel muestra texto plano. */
export function htmlToText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeEvent(e: GoogleEvent, timeZone: string, source?: CalendarSource): PanelEvent | null {
  if (!e || e.status === 'cancelled' || !e.start) return null;
  const allDay = !e.start.dateTime && !!e.start.date;
  let start: Date;
  let end: Date;
  let dayKey: string;
  if (allDay) {
    // Día completo: start.date inclusivo, end.date exclusivo.
    start = startOfDay(e.start.date!, timeZone);
    end = startOfDay(e.end?.date ?? addDays(e.start.date!, 1), timeZone);
    dayKey = e.start.date!;
  } else {
    start = new Date(e.start.dateTime!);
    end = new Date(e.end?.dateTime ?? e.start.dateTime!);
    if (Number.isNaN(start.getTime())) return null;
    dayKey = dayKeyInZone(start, timeZone);
  }
  return {
    id: e.id,
    title: (e.summary ?? '').trim() || '(sin título)',
    desc: htmlToText(e.description ?? ''),
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
    dayKey,
    link: e.htmlLink ?? null,
    calendar: source?.name ?? '',
    color: source?.color ?? null,
  };
}

export async function getPanelCalendar(
  accessToken: string,
  opts: { now: Date; timeZone: string; fetch?: typeof fetch; calendarIds?: string },
): Promise<CalendarResult> {
  const { now, timeZone: tz } = opts;
  const today = dayKeyInZone(now, tz);
  const sources = await resolveCalendars(accessToken, opts.calendarIds, opts.fetch);
  const range = {
    accessToken,
    timeMin: toRfc3339InZone(startOfDay(today, tz), tz),
    timeMax: toRfc3339InZone(endOfDay(addDays(today, CAL_DAYS), tz), tz),
    timeZone: tz,
  };
  const results = await Promise.allSettled(sources.map((c) => listEvents({ ...range, calendarId: c.id }, opts.fetch)));

  // Si fallan todos, error. Si falla uno secundario, se muestra el resto (y queda anotado en "calendars").
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length === results.length) throw failed[0]!.reason;
  for (const f of failed) {
    if (f.reason instanceof GoogleError && f.reason.status === 401) throw f.reason; // token: que lo maneje el reintento
    console.warn('Calendario no disponible:', (f.reason as Error)?.message);
  }

  const seen = new Set<string>();
  const events: PanelEvent[] = [];
  results.forEach((r, idx) => {
    if (r.status !== 'fulfilled') return;
    for (const raw of r.value) {
      const e = normalizeEvent(raw, tz, sources[idx]);
      if (!e) continue;
      // El mismo evento puede estar en dos calendarios propios (p. ej. invitado a ambos).
      const key = `${raw.iCalUID ?? raw.id}|${e.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Un evento de varios días que empezó antes de hoy se muestra en "hoy".
      events.push(e.dayKey < today ? { ...e, dayKey: today } : e);
    }
  });
  events.sort((a, b) => (a.dayKey !== b.dayKey ? (a.dayKey < b.dayKey ? -1 : 1) : a.start.localeCompare(b.start)));

  return {
    generatedAt: now.toISOString(),
    timeZone: tz,
    today,
    calendars: sources.map((c, idx) => ({ id: c.id, name: c.name, ok: results[idx]!.status === 'fulfilled' })),
    events,
  };
}
