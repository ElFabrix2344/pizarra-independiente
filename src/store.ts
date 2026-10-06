// Tokens en KV, cifrados con TOKEN_ENCRYPTION_KEY.
//   ticktick:token  → { accessToken, expiresAt, scope, obtainedAt }
//   google:token    → { refreshToken, scope, obtainedAt }
//   google:access   → { accessToken, expiresAt }   (caché; expira sola)

import type { Env } from './env';
import { ApiError } from './lib/http';
import { decryptString, encryptString } from './lib/crypto';

export interface TickTickStored {
  accessToken: string;
  /** epoch ms; null si TickTick no informó expires_in. */
  expiresAt: number | null;
  scope: string | null;
  obtainedAt: number;
}

export interface GoogleStored {
  refreshToken: string;
  scope: string | null;
  obtainedAt: number;
}

export interface GoogleAccessCached {
  accessToken: string;
  expiresAt: number;
}

const K = {
  ticktick: 'ticktick:token',
  google: 'google:token',
  googleAccess: 'google:access',
} as const;

export class TokenStore {
  constructor(private readonly env: Env) {}

  private key(): string {
    const k = this.env.TOKEN_ENCRYPTION_KEY;
    if (!k) throw new ApiError('misconfigured', 500, 'Falta el secreto TOKEN_ENCRYPTION_KEY');
    return k;
  }

  private async get<T>(name: string): Promise<T | null> {
    const raw = await this.env.TOKENS.get(name);
    if (!raw) return null;
    try {
      return JSON.parse(await decryptString(raw, this.key())) as T;
    } catch (e) {
      // Clave cambiada o dato corrupto: se trata como "no conectado".
      console.warn(`No se pudo descifrar ${name}`, (e as Error).message);
      return null;
    }
  }

  private async put(name: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const enc = await encryptString(JSON.stringify(value), this.key());
    await this.env.TOKENS.put(name, enc, ttlSeconds ? { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) } : undefined);
  }

  getTickTick() {
    return this.get<TickTickStored>(K.ticktick);
  }
  putTickTick(v: TickTickStored) {
    return this.put(K.ticktick, v);
  }

  getGoogle() {
    return this.get<GoogleStored>(K.google);
  }
  async putGoogle(v: GoogleStored) {
    await this.put(K.google, v);
    await this.env.TOKENS.delete(K.googleAccess);
  }
  async deleteGoogle() {
    await Promise.all([this.env.TOKENS.delete(K.google), this.env.TOKENS.delete(K.googleAccess)]);
  }

  getGoogleAccess() {
    return this.get<GoogleAccessCached>(K.googleAccess);
  }
  putGoogleAccess(v: GoogleAccessCached) {
    return this.put(K.googleAccess, v, (v.expiresAt - Date.now()) / 1000);
  }
}
