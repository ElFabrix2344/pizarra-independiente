// OAuth 2.0 de TickTick (authorization code), según developer.ticktick.com/docs/openapi.md:
//  1. Redirigir a https://ticktick.com/oauth/authorize?scope&client_id&state&redirect_uri&response_type=code
//  2. TickTick vuelve a redirect_uri con ?code&state
//  3. POST https://ticktick.com/oauth/token (x-www-form-urlencoded), client_id/client_secret
//     en la cabecera Basic Auth; body: code, grant_type=authorization_code, scope, redirect_uri.
// La doc no describe refresh token: cuando el access token vence hay que repetir el flujo.

import type { TickTickScope, TickTickTokenResponse } from './types';
import { TickTickError } from './errors';

export const TICKTICK_AUTHORIZE_URL = 'https://ticktick.com/oauth/authorize';
export const TICKTICK_TOKEN_URL = 'https://ticktick.com/oauth/token';

export interface TickTickOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: TickTickScope[];
}

export function buildAuthorizeUrl(cfg: Omit<TickTickOAuthConfig, 'clientSecret'>, state: string): string {
  const u = new URL(TICKTICK_AUTHORIZE_URL);
  u.searchParams.set('scope', cfg.scopes.join(' '));
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_type', 'code');
  return u.toString();
}

export async function exchangeCode(
  cfg: TickTickOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TickTickTokenResponse> {
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    scope: cfg.scopes.join(' '),
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetchImpl(TICKTICK_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${cfg.clientId}:${cfg.clientSecret}`),
      Accept: 'application/json',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new TickTickError(`Intercambio de código falló (${res.status})`, res.status, text.slice(0, 300));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TickTickError('Respuesta de token no es JSON', res.status, text.slice(0, 300));
  }
  const tok = json as TickTickTokenResponse;
  if (!tok || typeof tok.access_token !== 'string' || !tok.access_token) {
    throw new TickTickError('Respuesta de token sin access_token', res.status);
  }
  return tok;
}
