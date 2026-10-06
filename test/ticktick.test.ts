import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCode,
  formatTickTickDate,
  parseTickTickDate,
  splitRange,
  taskDayKey,
  TickTickClient,
  TickTickError,
  UNDONE_MAX_RANGE_MS,
} from '../src/lib/ticktick';

describe('fechas de TickTick', () => {
  it('normaliza offsets sin dos puntos', () => {
    expect(parseTickTickDate('2026-10-11T00:00:00-0500')?.toISOString()).toBe('2026-10-11T05:00:00.000Z');
    expect(parseTickTickDate('2019-11-13T03:00:00+0000')?.toISOString()).toBe('2019-11-13T03:00:00.000Z');
    expect(parseTickTickDate('2026-03-05T00:00:00.000+0000')?.toISOString()).toBe('2026-03-05T00:00:00.000Z');
    expect(parseTickTickDate('2026-10-11T00:00:00-05:00')?.toISOString()).toBe('2026-10-11T05:00:00.000Z');
  });
  it('devuelve null para vacío o inválido', () => {
    expect(parseTickTickDate(undefined)).toBeNull();
    expect(parseTickTickDate('')).toBeNull();
    expect(parseTickTickDate('no es fecha')).toBeNull();
  });
  it('formatea en UTC con +0000', () => {
    expect(formatTickTickDate(new Date('2026-10-06T05:00:00Z'))).toBe('2026-10-06T05:00:00+0000');
  });
  it('día de una tarea de día completo se calcula en la zona de la tarea', () => {
    // Medianoche del 11 en Tokio = 10 a las 15:00 UTC; en Lima sería el 10.
    const due = parseTickTickDate('2026-10-10T15:00:00+0000')!;
    expect(taskDayKey(due, { isAllDay: true, taskTimeZone: 'Asia/Tokyo', displayTimeZone: 'America/Lima' })).toBe('2026-10-11');
    expect(taskDayKey(due, { isAllDay: false, taskTimeZone: 'Asia/Tokyo', displayTimeZone: 'America/Lima' })).toBe('2026-10-10');
    // Medianoche de Lima.
    const lima = parseTickTickDate('2026-10-11T00:00:00-0500')!;
    expect(taskDayKey(lima, { isAllDay: true, taskTimeZone: 'America/Lima', displayTimeZone: 'America/Lima' })).toBe('2026-10-11');
  });
});

describe('splitRange', () => {
  it('parte 71 días en tramos de ≤14 días sin huecos', () => {
    const a = new Date('2026-10-06T05:00:00Z');
    const b = new Date(a.getTime() + 71 * 86400000 - 1000);
    const w = splitRange(a, b, UNDONE_MAX_RANGE_MS);
    expect(w.length).toBe(6);
    expect(w[0]![0].getTime()).toBe(a.getTime());
    expect(w.at(-1)![1].getTime()).toBe(b.getTime());
    for (const [s, e] of w) expect(e.getTime() - s.getTime()).toBeLessThan(UNDONE_MAX_RANGE_MS);
    for (let i = 1; i < w.length; i++) expect(w[i]![0].getTime() - w[i - 1]![1].getTime()).toBe(1000);
  });
  it('un rango corto queda en un solo tramo', () => {
    const a = new Date('2026-10-06T05:00:00Z');
    expect(splitRange(a, new Date(a.getTime() + 86400000), UNDONE_MAX_RANGE_MS)).toHaveLength(1);
  });
});

describe('TickTickClient', () => {
  it('envía el token Bearer y el cuerpo de /task/undone con el formato de la doc', async () => {
    const f = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response('[]', { status: 200 }));
    const c = new TickTickClient({ getAccessToken: async () => 'tok', fetch: f as unknown as typeof fetch });
    await c.listUndone({ startDate: new Date('2026-10-06T05:00:00Z'), endDate: new Date('2026-10-14T04:59:59Z') });
    const [u, init] = f.mock.calls[0]!;
    expect(String(u)).toBe('https://api.ticktick.com/open/v1/task/undone');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init!.body))).toEqual({ startDate: '2026-10-06T05:00:00+0000', endDate: '2026-10-14T04:59:59+0000' });
  });
  it('rechaza rangos de más de 14 días en listUndone', async () => {
    const c = new TickTickClient({ getAccessToken: async () => 'tok', fetch: (async () => new Response('[]')) as typeof fetch });
    expect(() => c.listUndone({ startDate: new Date(0), endDate: new Date(15 * 86400000) })).toThrow(RangeError);
  });
  it('completeTask acepta 200 sin cuerpo', async () => {
    const f = vi.fn(async () => new Response(null, { status: 200 }));
    const c = new TickTickClient({ getAccessToken: async () => 'tok', fetch: f as unknown as typeof fetch });
    await expect(c.completeTask('p1', 't1')).resolves.toBeUndefined();
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe('https://api.ticktick.com/open/v1/project/p1/task/t1/complete');
  });
  it('401 produce TickTickError con isAuthError', async () => {
    const c = new TickTickClient({ getAccessToken: async () => 'x', fetch: (async () => new Response('', { status: 401 })) as typeof fetch });
    const err = await c.listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(TickTickError);
    expect(err.isAuthError).toBe(true);
  });
});

describe('OAuth de TickTick', () => {
  it('construye la URL de autorización con los parámetros de la doc', () => {
    const u = new URL(buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://x.dev/oauth/ticktick/callback', scopes: ['tasks:read', 'tasks:write'] }, 'st'));
    expect(u.origin + u.pathname).toBe('https://ticktick.com/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      scope: 'tasks:read tasks:write',
      client_id: 'cid',
      state: 'st',
      redirect_uri: 'https://x.dev/oauth/ticktick/callback',
      response_type: 'code',
    });
  });
  it('intercambia el código con Basic Auth y form-urlencoded', async () => {
    const f = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(JSON.stringify({ access_token: 'AT', expires_in: 100 })));
    const tok = await exchangeCode(
      { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x.dev/cb', scopes: ['tasks:read'] },
      'CODE',
      f as unknown as typeof fetch,
    );
    expect(tok.access_token).toBe('AT');
    const [u, init] = f.mock.calls[0]!;
    expect(String(u)).toBe('https://ticktick.com/oauth/token');
    const h = init!.headers as Record<string, string>;
    expect(h.Authorization).toBe('Basic ' + btoa('cid:sec'));
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(init!.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('CODE');
    expect(body.get('client_secret')).toBeNull(); // el secreto va solo en la cabecera
  });
});
