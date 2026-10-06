import { listEvents, type GoogleEvent } from '../lib/google';
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
}

export interface CalendarResult {
  generatedAt: string;
  timeZone: string;
  today: string;
  events: PanelEvent[];
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

export function normalizeEvent(e: GoogleEvent, timeZone: string): PanelEvent | null {
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
  };
}

export async function getPanelCalendar(
  accessToken: string,
  opts: { now: Date; timeZone: string; fetch?: typeof fetch },
): Promise<CalendarResult> {
  const { now, timeZone: tz } = opts;
  const today = dayKeyInZone(now, tz);
  const items = await listEvents(
    {
      accessToken,
      calendarId: 'primary',
      timeMin: toRfc3339InZone(startOfDay(today, tz), tz),
      timeMax: toRfc3339InZone(endOfDay(addDays(today, CAL_DAYS), tz), tz),
      timeZone: tz,
    },
    opts.fetch,
  );
  const events = items
    .map((e) => normalizeEvent(e, tz))
    .filter((e): e is PanelEvent => e !== null)
    // Un evento de varios días que empezó antes de hoy se muestra en "hoy".
    .map((e) => (e.dayKey < today ? { ...e, dayKey: today } : e))
    .sort((a, b) => (a.dayKey !== b.dayKey ? (a.dayKey < b.dayKey ? -1 : 1) : a.start.localeCompare(b.start)));
  return { generatedAt: now.toISOString(), timeZone: tz, today, events };
}
