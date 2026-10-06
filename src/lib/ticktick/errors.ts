export class TickTickError extends Error {
  constructor(
    message: string,
    /** Código HTTP de la respuesta de TickTick (0 si no hubo respuesta). */
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'TickTickError';
  }

  /** 401/403: el token venció o fue revocado; hay que volver a autorizar. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}
