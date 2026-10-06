// Google OAuth 2.0 (web server flow) y Calendar API v3 — solo lo que usa el panel.
// Docs: https://developers.google.com/identity/protocols/oauth2/web-server
//       https://developers.google.com/workspace/calendar/api/v3/reference/events/list

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** `error` del cuerpo de la respuesta, p. ej. "invalid_grant". */
    readonly oauthError?: string,
  ) {
    super(message);
    this.name = 'GoogleError';
  }
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export function buildGoogleAuthUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', CALENDAR_SCOPE);
  u.searchParams.set('access_type', 'offline'); // para recibir refresh_token
  u.searchParams.set('prompt', 'consent'); // fuerza refresh_token aunque ya hayas autorizado antes
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', p.state);
  return u.toString();
}

async function tokenRequest(body: URLSearchParams, fetchImpl: typeof fetch): Promise<GoogleTokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
  } catch (e) {
    throw new GoogleError(`Sin respuesta de Google: ${(e as Error).message}`, 0);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new GoogleError(`Google token → ${res.status} ${String(data.error ?? '')}`, res.status, data.error as string | undefined);
  }
  if (typeof data.access_token !== 'string') throw new GoogleError('Respuesta de token sin access_token', res.status);
  return data as unknown as GoogleTokenResponse;
}

export function exchangeGoogleCode(
  p: { clientId: string; clientSecret: string; redirectUri: string; code: string },
  fetchImpl: typeof fetch = fetch,
) {
  return tokenRequest(
    new URLSearchParams({
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      grant_type: 'authorization_code',
    }),
    fetchImpl,
  );
}

export function refreshGoogleToken(
  p: { clientId: string; clientSecret: string; refreshToken: string },
  fetchImpl: typeof fetch = fetch,
) {
  return tokenRequest(
    new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      refresh_token: p.refreshToken,
      grant_type: 'refresh_token',
    }),
    fetchImpl,
  );
}

// ---------- Calendar ----------

/** Subconjunto del recurso Event que usa el panel. */
export interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
}

interface EventsPage {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

export async function listEvents(
  p: {
    accessToken: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleEvent[]> {
  const out: GoogleEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const u = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(p.calendarId ?? 'primary')}/events`);
    u.searchParams.set('timeMin', p.timeMin);
    u.searchParams.set('timeMax', p.timeMax);
    u.searchParams.set('timeZone', p.timeZone);
    u.searchParams.set('singleEvents', 'true'); // expande recurrentes; requerido por orderBy=startTime
    u.searchParams.set('orderBy', 'startTime');
    u.searchParams.set('maxResults', '250');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    let res: Response;
    try {
      res = await fetchImpl(u.toString(), { headers: { Authorization: `Bearer ${p.accessToken}`, Accept: 'application/json' } });
    } catch (e) {
      throw new GoogleError(`Sin respuesta de Google Calendar: ${(e as Error).message}`, 0);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new GoogleError(`Calendar events.list → ${res.status} ${body.slice(0, 200)}`, res.status);
    }
    const data = (await res.json()) as EventsPage;
    if (!data || (data.items !== undefined && !Array.isArray(data.items))) {
      throw new GoogleError('Calendar devolvió un formato inesperado', 502);
    }
    out.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}
