// Construye clientes autenticados a partir de los tokens guardados.

import type { Env } from './env';
import { isMock } from './env';
import { ApiError } from './lib/http';
import { GoogleError, refreshGoogleToken } from './lib/google';
import { TickTickClient } from './lib/ticktick';
import { mockFetch } from './mock';
import { TokenStore } from './store';

export type TickTickSource = 'oauth' | 'api_token' | 'mock';

export async function getTickTickClient(env: Env, url: URL): Promise<{ client: TickTickClient; source: TickTickSource }> {
  if (isMock(url, env)) {
    return { client: new TickTickClient({ getAccessToken: async () => 'mock', fetch: mockFetch }), source: 'mock' };
  }
  const stored = await new TokenStore(env).getTickTick();
  if (stored && (stored.expiresAt === null || stored.expiresAt > Date.now())) {
    const token = stored.accessToken;
    return { client: new TickTickClient({ getAccessToken: async () => token }), source: 'oauth' };
  }
  if (env.TICKTICK_API_TOKEN) {
    const token = env.TICKTICK_API_TOKEN;
    return { client: new TickTickClient({ getAccessToken: async () => token }), source: 'api_token' };
  }
  if (stored) throw new ApiError('reauth_required', 409, 'El acceso a TickTick venció. Vuelve a conectar TickTick.', 'ticktick');
  throw new ApiError('not_connected', 409, 'TickTick no está conectado.', 'ticktick');
}

/** Access token de Google válido; lo renueva con el refresh token si hace falta. */
export async function getGoogleAccessToken(env: Env, url: URL): Promise<{ token: string; fetch: typeof fetch }> {
  if (isMock(url, env)) return { token: 'mock', fetch: mockFetch };
  const store = new TokenStore(env);
  const cached = await store.getGoogleAccess();
  if (cached && cached.expiresAt - Date.now() > 60_000) return { token: cached.accessToken, fetch };

  const stored = await store.getGoogle();
  if (!stored) throw new ApiError('not_connected', 409, 'Google Calendar no está conectado.', 'google');
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ApiError('misconfigured', 500, 'Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.', 'google');
  }
  try {
    const tok = await refreshGoogleToken({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: stored.refreshToken,
    });
    const expiresAt = Date.now() + (tok.expires_in ?? 3600) * 1000;
    await store.putGoogleAccess({ accessToken: tok.access_token, expiresAt });
    // Google puede rotar el refresh token (poco habitual); si llega uno nuevo, se guarda.
    if (tok.refresh_token && tok.refresh_token !== stored.refreshToken) {
      await store.putGoogle({ ...stored, refreshToken: tok.refresh_token, obtainedAt: Date.now() });
    }
    return { token: tok.access_token, fetch };
  } catch (e) {
    if (e instanceof GoogleError && (e.oauthError === 'invalid_grant' || e.status === 400 || e.status === 401)) {
      throw new ApiError('reauth_required', 409, 'Google rechazó el refresh token. Vuelve a conectar Google Calendar.', 'google');
    }
    if (e instanceof GoogleError) throw new ApiError('upstream_error', 502, 'Google no respondió al renovar el acceso.', 'google');
    throw e;
  }
}

export async function connectionStatus(env: Env, url: URL) {
  if (isMock(url, env)) {
    return { mock: true, google: { connected: true }, ticktick: { connected: true, source: 'mock', expiresAt: null } };
  }
  const store = new TokenStore(env);
  const [tt, g] = await Promise.all([store.getTickTick(), store.getGoogle()]);
  const ttValid = !!tt && (tt.expiresAt === null || tt.expiresAt > Date.now());
  return {
    mock: false,
    google: { connected: !!g, connectedAt: g ? new Date(g.obtainedAt).toISOString() : null },
    ticktick: {
      connected: ttValid || !!env.TICKTICK_API_TOKEN,
      source: ttValid ? 'oauth' : env.TICKTICK_API_TOKEN ? 'api_token' : null,
      expiresAt: tt?.expiresAt ? new Date(tt.expiresAt).toISOString() : null,
    },
  };
}
