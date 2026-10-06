export interface Env {
  ASSETS: Fetcher;
  TOKENS: KVNamespace;

  // vars (wrangler.jsonc)
  TIMEZONE: string;
  /** "undone" (por defecto) o "scan": cómo se leen las tareas de TickTick. */
  TICKTICK_STRATEGY?: string;

  // secretos (`wrangler secret put` / `.env` en local)
  /** https://<equipo>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Correos autorizados separados por comas (segunda capa además de la política de Access). */
  ALLOWED_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TICKTICK_CLIENT_ID?: string;
  TICKTICK_CLIENT_SECRET?: string;
  TICKTICK_API_TOKEN?: string;
  TOKEN_ENCRYPTION_KEY?: string;

  // solo desarrollo local (se ignoran fuera de localhost)
  DEV_MODE?: string;
  MOCK_DATA?: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** true solo si DEV_MODE=true Y la petición llega a localhost. En Cloudflare el host nunca es localhost. */
export function isLocalDev(url: URL, env: Env): boolean {
  return env.DEV_MODE === 'true' && LOCAL_HOSTS.has(url.hostname);
}

export function isMock(url: URL, env: Env): boolean {
  return isLocalDev(url, env) && env.MOCK_DATA === 'true';
}
