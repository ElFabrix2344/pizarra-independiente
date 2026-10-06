export type ApiErrorCode =
  | 'not_connected' // el proveedor nunca se conectó
  | 'reauth_required' // el token venció o fue revocado
  | 'upstream_error' // Google/TickTick fallaron o no respondieron
  | 'bad_response' // respuesta con forma inesperada
  | 'bad_request'
  | 'forbidden'
  | 'not_found'
  | 'misconfigured';

export type Provider = 'google' | 'ticktick';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly provider?: Provider,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return json({ error: { code: e.code, message: e.message, provider: e.provider ?? null } }, { status: e.status });
  }
  console.error('Error no controlado', e);
  return json({ error: { code: 'upstream_error', message: 'Error interno', provider: null } }, { status: 500 });
}

/** Página HTML mínima para los resultados de OAuth y los errores de acceso. */
export function htmlPage(title: string, bodyHtml: string, status = 200): Response {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="wrap simple"><h1>${escapeHtml(title)}</h1>${bodyHtml}<p><a href="/">Volver a la pizarra</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
