// Rutas /oauth/{google,ticktick}/{start,callback}.
// Protección CSRF: `state` aleatorio guardado en una cookie HttpOnly que se compara en el callback.
// Todas estas rutas quedan detrás de Cloudflare Access, así que nadie más puede conectar su cuenta.

import type { Env } from './env';
import { buildGoogleAuthUrl, exchangeGoogleCode, GoogleError } from './lib/google';
import { escapeHtml, htmlPage } from './lib/http';
import { randomToken } from './lib/crypto';
import { buildAuthorizeUrl, exchangeCode, TickTickError, type TickTickScope } from './lib/ticktick';
import { TokenStore } from './store';

type Provider = 'google' | 'ticktick';
const TICKTICK_SCOPES: TickTickScope[] = ['tasks:read', 'tasks:write'];
const NAMES: Record<Provider, string> = { google: 'Google Calendar', ticktick: 'TickTick' };

function redirectUri(url: URL, provider: Provider): string {
  return `${url.origin}/oauth/${provider}/callback`;
}

function stateCookie(provider: Provider, value: string, url: URL, maxAge: number): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `oauth_state_${provider}=${value}; Path=/oauth/${provider}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie') ?? '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

export async function handleOAuth(req: Request, env: Env, url: URL): Promise<Response | null> {
  const m = url.pathname.match(/^\/oauth\/(google|ticktick)\/(start|callback)$/);
  if (!m || req.method !== 'GET') return null;
  const provider = m[1] as Provider;
  const step = m[2] as 'start' | 'callback';
  return step === 'start' ? start(provider, env, url) : callback(provider, req, env, url);
}

function start(provider: Provider, env: Env, url: URL): Response {
  const clientId = provider === 'google' ? env.GOOGLE_CLIENT_ID : env.TICKTICK_CLIENT_ID;
  if (!clientId) {
    return htmlPage('Falta configuración', `<p>No hay client ID de ${NAMES[provider]} configurado en el servidor.</p>`, 500);
  }
  const state = randomToken(24);
  const location =
    provider === 'google'
      ? buildGoogleAuthUrl({ clientId, redirectUri: redirectUri(url, provider), state })
      : buildAuthorizeUrl({ clientId, redirectUri: redirectUri(url, provider), scopes: TICKTICK_SCOPES }, state);
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Set-Cookie': stateCookie(provider, state, url, 600), 'Cache-Control': 'no-store' },
  });
}

async function callback(provider: Provider, req: Request, env: Env, url: URL): Promise<Response> {
  const name = NAMES[provider];
  const clear = stateCookie(provider, '', url, 0);
  const fail = (msg: string, status = 400) => {
    const r = htmlPage(`No se pudo conectar ${name}`, `<p>${escapeHtml(msg)}</p><p><a href="/oauth/${provider}/start">Intentar de nuevo</a></p>`, status);
    r.headers.append('Set-Cookie', clear);
    return r;
  };

  const err = url.searchParams.get('error');
  if (err) return fail(`${name} devolvió: ${err}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = readCookie(req, `oauth_state_${provider}`);
  if (!code || !state || !expected || state !== expected) {
    return fail('La sesión de autorización no coincide o expiró (state inválido).');
  }

  const store = new TokenStore(env);
  try {
    if (provider === 'google') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail('Faltan credenciales de Google en el servidor.', 500);
      const tok = await exchangeGoogleCode({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: redirectUri(url, provider),
        code,
      });
      if (!tok.refresh_token) {
        return fail('Google no envió refresh token. Quita el acceso de la app en myaccount.google.com/permissions y vuelve a intentarlo.');
      }
      await store.putGoogle({ refreshToken: tok.refresh_token, scope: tok.scope ?? null, obtainedAt: Date.now() });
      await store.putGoogleAccess({ accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 });
    } else {
      if (!env.TICKTICK_CLIENT_ID || !env.TICKTICK_CLIENT_SECRET) return fail('Faltan credenciales de TickTick en el servidor.', 500);
      const tok = await exchangeCode(
        {
          clientId: env.TICKTICK_CLIENT_ID,
          clientSecret: env.TICKTICK_CLIENT_SECRET,
          redirectUri: redirectUri(url, provider),
          scopes: TICKTICK_SCOPES,
        },
        code,
      );
      await store.putTickTick({
        accessToken: tok.access_token,
        expiresAt: typeof tok.expires_in === 'number' ? Date.now() + tok.expires_in * 1000 : null,
        scope: tok.scope ?? null,
        obtainedAt: Date.now(),
      });
    }
  } catch (e) {
    console.error(`OAuth ${provider}`, e);
    if (e instanceof GoogleError || e instanceof TickTickError) return fail(`El intercambio del código falló (${e.status}).`, 502);
    return fail('Error inesperado al guardar el acceso.', 500);
  }

  const r = new Response(null, { status: 302, headers: { Location: `/?connected=${provider}`, 'Cache-Control': 'no-store' } });
  r.headers.append('Set-Cookie', clear);
  return r;
}
