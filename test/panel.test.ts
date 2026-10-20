import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TickTickClient } from '../src/lib/ticktick';
import { mockFetch } from '../src/mock';
import { getPanelCalendar, htmlToText, normalizeEvent } from '../src/services/calendar';
import { _resetMetaCache, EVAL_RE, getEvaluations, getPanelTasks } from '../src/services/tasks';
import { addDays, dayKeyInZone, endOfDay, startOfDay, toRfc3339InZone } from '../src/lib/time';
import { decryptString, encryptString } from '../src/lib/crypto';

const TZ = 'America/Lima';
const client = () => new TickTickClient({ getAccessToken: async () => 'mock', fetch: mockFetch });

beforeEach(() => _resetMetaCache());

describe('tiempo en America/Lima', () => {
  it('medianoche y fin de día', () => {
    expect(startOfDay('2026-10-06', TZ).toISOString()).toBe('2026-10-06T05:00:00.000Z');
    expect(endOfDay('2026-10-06', TZ).toISOString()).toBe('2026-10-07T04:59:59.000Z');
    expect(toRfc3339InZone(startOfDay('2026-10-06', TZ), TZ)).toBe('2026-10-06T00:00:00-05:00');
    expect(dayKeyInZone(new Date('2026-10-07T04:30:00Z'), TZ)).toBe('2026-10-06');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('regex de evaluaciones', () => {
  const yes = ['PC2 — Curso', 'PC 3', 'Parcial de cálculo', 'EXAMEN final', 'Actividad 3 calificada', 'Trabajo final', 'trabajo grupal X', 'Entrega 1', '2da entrega', 'Presentación', 'Presentacion oral'];
  const no = ['Leer capítulo', 'Preparar PC2', 'Trabajo de campo', 'Actividad calificada'];
  it.each(yes)('reconoce "%s"', (t) => expect(EVAL_RE.test(t)).toBe(true));
  it.each(no)('ignora "%s"', (t) => expect(EVAL_RE.test(t)).toBe(false));
});

describe('/api/tasks', () => {
  it('trae vencidas (≤7 días), hoy y la semana; ordena por día y prioridad', async () => {
    const now = new Date();
    const today = dayKeyInZone(now, TZ);
    const r = await getPanelTasks(client(), { now, timeZone: TZ, strategy: 'undone' });
    const ids = r.tasks.map((t) => t.id);
    expect(ids).not.toContain('t-old'); // vencida hace 10 días
    expect(ids).not.toContain('t-w4'); // día +9
    expect(ids).toContain('t-over1');
    expect(ids).toContain('t-over2');
    for (const t of r.tasks) {
      expect(t.dayKey! >= addDays(today, -7) && t.dayKey! <= addDays(today, 7)).toBe(true);
    }
    // Hoy: prioridad 5 antes que 3 antes que 1
    const todays = r.tasks.filter((t) => t.dayKey === today).map((t) => t.priority);
    expect(todays).toEqual([...todays].sort((a, b) => b - a));
    // Etiquetas: nombre de lista, inbox y columna kanban
    expect(r.tasks.find((t) => t.id === 't-over2')!.list).toBe('Bandeja de entrada');
    const kan = r.tasks.find((t) => t.id === 't-today1')!;
    expect(kan.list).toBe('Curso B');
    expect(kan.column).toBe('En curso');
    expect(kan.allDay).toBe(false);
    expect(r.tasks.find((t) => t.id === 't-today2')!.repeat).toBe(true);
  });

  it('las estrategias "undone" y "scan" devuelven las mismas tareas', async () => {
    const now = new Date();
    const a = await getPanelTasks(client(), { now, timeZone: TZ, strategy: 'undone' });
    _resetMetaCache();
    const b = await getPanelTasks(client(), { now, timeZone: TZ, strategy: 'scan' });
    expect(b.tasks.map((t) => t.id)).toEqual(a.tasks.map((t) => t.id));
    expect(b.tasks.find((t) => t.id === 't-today1')!.column).toBe('En curso');
  });

  it('un 401 de TickTick se traduce a reauth_required', async () => {
    const c = new TickTickClient({ getAccessToken: async () => 'x', fetch: (async () => new Response('', { status: 401 })) as typeof fetch });
    await expect(getPanelTasks(c, { now: new Date(), timeZone: TZ, strategy: 'undone' })).rejects.toMatchObject({ code: 'reauth_required', provider: 'ticktick' });
  });
});

describe('/api/evaluations', () => {
  it('devuelve las 6 más cercanas que cumplen la regex, dentro de 70 días', async () => {
    const r = await getEvaluations(client(), { now: new Date(), timeZone: TZ, strategy: 'undone' });
    expect(r.evaluations.map((e) => e.id)).toEqual(['t-w2', 'e1', 'e2', 'e3', 'e4', 'e5']);
    expect(r.evaluations[1]!.name).toBe('PC2');
    expect(r.evaluations[1]!.daysUntil).toBe(9);
    expect(r.evaluations.map((e) => e.id)).not.toContain('n1');
  });
  it('con límite mayor incluye la de +60 pero no la de +80', async () => {
    const r = await getEvaluations(client(), { now: new Date(), timeZone: TZ, strategy: 'undone', limit: 20 });
    const ids = r.evaluations.map((e) => e.id);
    expect(ids).toContain('e6');
    expect(ids).not.toContain('e7');
  });

  it('consultas simultáneas esperan la misma lectura de columnas (ninguna sale sin curso)', async () => {
    const reads: string[] = [];
    const slow: typeof fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path.endsWith('/column')) {
        reads.push(path);
        await new Promise((r) => setTimeout(r, 20));
      }
      return mockFetch(input, init);
    };
    const c = new TickTickClient({ getAccessToken: async () => 'mock', fetch: slow });
    const now = new Date();
    const [tasks, evals] = await Promise.all([
      getPanelTasks(c, { now, timeZone: TZ, strategy: 'undone' }),
      getEvaluations(c, { now, timeZone: TZ, strategy: 'undone', limit: 40 }),
    ]);
    expect(evals.evaluations.find((e) => e.id === 'e8')!.column).toBe('Estadística Aplicada');
    expect(tasks.tasks.find((t) => t.id === 't-over2')!.column).toBe('HEE');
    // Una lectura por proyecto, y el inbox por su alias (como Estudio).
    expect(reads.sort()).toEqual(['/open/v1/project/inbox/column', '/open/v1/project/p-cursob/column']);
  });

  it('si leer las columnas falla, la próxima consulta reintenta', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let down = true;
    const flaky: typeof fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (down && (path.endsWith('/column') || path.endsWith('/inbox/data'))) return new Response('', { status: 503 });
      return mockFetch(input, init);
    };
    const c = new TickTickClient({ getAccessToken: async () => 'mock', fetch: flaky });
    const opts = { now: new Date(), timeZone: TZ, strategy: 'undone' as const, limit: 40 };
    expect((await getEvaluations(c, opts)).evaluations.find((e) => e.id === 'e8')!.column).toBeNull();
    down = false;
    expect((await getEvaluations(c, opts)).evaluations.find((e) => e.id === 'e8')!.column).toBe('Estadística Aplicada');
    vi.restoreAllMocks();
  });
});

describe('/api/calendar', () => {
  it('normaliza eventos, quita cancelados y limpia HTML', async () => {
    const now = new Date();
    const r = await getPanelCalendar('mock', { now, timeZone: TZ, fetch: mockFetch });
    const ids = r.events.map((e) => e.id);
    expect(ids).not.toContain('ev-cancel');
    expect(ids).toContain('ev-now');
    const allDay = r.events.find((e) => e.id === 'ev-allday')!;
    expect(allDay.allDay).toBe(true);
    expect(allDay.dayKey).toBe(addDays(dayKeyInZone(now, TZ), 2));
    expect(r.events.find((e) => e.id === 'ev-now')!.desc).toBe('Ejercicios antes de la clase.\nLlevar laptop.');
  });
  it('lee todos los calendarios propios (clases incluidas), no los suscritos, y sin duplicados', async () => {
    const r = await getPanelCalendar('mock', { now: new Date(), timeZone: TZ, fetch: mockFetch });
    expect(r.calendars.map((c) => c.name)).toEqual(['yo@example.com', 'Clases']);
    const ids = r.events.map((e) => e.id);
    expect(ids).toContain('cl-hee');
    expect(ids).toContain('cl-eval');
    expect(ids).not.toContain('fer'); // feriados: calendario suscrito (reader)
    expect(ids).not.toContain('cl-dup'); // mismo iCalUID y hora que ev-t1
    expect(ids).toContain('ev-t1');
    const hee = r.events.find((e) => e.id === 'cl-hee')!;
    expect(hee.calendar).toBe('Clases');
    expect(hee.color).toBe('#039BE5'); // colorId 7 = Pavo real
    // Evento sin color propio → color de su calendario.
    expect(r.events.find((e) => e.id === 'ev-t1')!.color).toBe('#9fe1e7');
    // ordenados por día y hora
    const keys = r.events.map((e) => e.dayKey + e.start);
    expect(keys).toEqual([...keys].sort());
  });
  it('CALENDAR_IDS fija la lista a mano', async () => {
    const r = await getPanelCalendar('mock', { now: new Date(), timeZone: TZ, fetch: mockFetch, calendarIds: 'primary' });
    expect(r.calendars).toEqual([{ id: 'primary', name: 'Principal', ok: true }]);
    expect(r.events.some((e) => e.id === 'cl-hee')).toBe(false);
  });
  it('si un calendario secundario falla, muestra el resto', async () => {
    const r = await getPanelCalendar('mock', { now: new Date(), timeZone: TZ, fetch: mockFetch, calendarIds: 'primary,no-existe@group.calendar.google.com' });
    expect(r.calendars.map((c) => c.ok)).toEqual([true, false]);
    expect(r.events.length).toBeGreaterThan(0);
  });
  it('color: el del evento (colorId) o, si no tiene, el del calendario', () => {
    const src = { id: 'c', name: 'C', color: '#123456' };
    const base = { id: 'x', start: { dateTime: '2026-10-12T09:30:00-05:00' }, end: { dateTime: '2026-10-12T11:00:00-05:00' } };
    expect(normalizeEvent({ ...base, colorId: '11' }, TZ, src)!.color).toBe('#D50000');
    expect(normalizeEvent(base, TZ, src)!.color).toBe('#123456');
    expect(normalizeEvent(base, TZ, { ...src, color: 'red' })!.color).toBeNull();
    expect(normalizeEvent({ ...base, colorId: '99' }, TZ)!.color).toBeNull();
  });
  it('evento de día completo: inicio inclusivo, fin exclusivo, en hora de Lima', () => {
    const e = normalizeEvent({ id: 'x', start: { date: '2026-10-08' }, end: { date: '2026-10-09' } }, TZ)!;
    expect(e.start).toBe('2026-10-08T05:00:00.000Z');
    expect(e.end).toBe('2026-10-09T05:00:00.000Z');
  });
  it('htmlToText', () => {
    expect(htmlToText('a<br>b &amp; <a href="x">c</a>')).toBe('a\nb & c');
  });
});

describe('cifrado de tokens', () => {
  it('ida y vuelta con AES-GCM', async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const enc = await encryptString('secreto', key);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('secreto');
    expect(await decryptString(enc, key)).toBe('secreto');
  });
});

describe('configCheck', () => {
  it('valida formatos sin exponer secretos', async () => {
    const { configCheck } = await import('../src/providers');
    const ok = configCheck({ GOOGLE_CLIENT_ID: '123456789012-abc123def.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-xyz' } as never);
    expect(ok.googleClientIdFormatOk).toBe(true);
    expect(ok.googleClientSecret).toEqual({ set: true, length: 10, formatOk: true });
    expect(JSON.stringify(ok)).not.toContain('GOCSPX-xyz');
    const swapped = configCheck({ GOOGLE_CLIENT_ID: 'GOCSPX-xyz', GOOGLE_CLIENT_SECRET: '1-a.apps.googleusercontent.com' } as never);
    expect(swapped.googleClientIdLooksLikeSecret).toBe(true);
    expect(swapped.googleClientSecret.formatOk).toBe(false);
  });
});

describe('evaluaciones: práctica de ciclos pasados y ocultas a mano', () => {
  it('títulos reales: la práctica con código de ciclo no cuenta como evaluación', async () => {
    const { isEvaluationTitle } = await import('../src/services/tasks');
    const practica = [
      'PC2 2026-I — P1 d–e (left_join, case_when, str_c, percentiles) — mar 20/10',
      'PC2 2026-I — gráficos: P1 f–g y P2 e (ggplot2) — mié 28/10',
      'PC2 2026-I — P1 a–c (read_dta, rename, filter, if_else, colapsar) — jue 15/10',
      'Parcial 2025-2 resuelto',
      'PC1 26-1 pasada',
      'Examen 2024-II',
    ];
    const reales = ['PC2 EPP', 'PC3 EPP', 'Actividad 3 calificada PSC', 'Trabajo final EFE Presentaciones de Alto Impacto', 'Presentación Noticia trío 7 HEE', 'PC2 — Estadística Aplicada', 'Entrega 2026 informe'];
    for (const t of practica) expect([t, isEvaluationTitle(t)]).toEqual([t, false]);
    for (const t of reales) expect([t, isEvaluationTitle(t)]).toEqual([t, true]);
    // Tareas que no empiezan con la palabra clave siguen fuera
    expect(isEvaluationTitle('Aplicada: conseguir PC2 pasadas y confirmar reglas con Durán — jue 15/10')).toBe(false);
    expect(isEvaluationTitle('Simulacro PC2 cronometrado (120 min) — sáb 31/10')).toBe(false);
  });
  it('las ocultas a mano no aparecen y se cuentan', async () => {
    const all = await getEvaluations(client(), { now: new Date(), timeZone: TZ, strategy: 'undone' });
    const hide = all.evaluations[0]!.id;
    const r = await getEvaluations(client(), { now: new Date(), timeZone: TZ, strategy: 'undone', ignored: new Set([hide]) });
    expect(r.evaluations.map((e) => e.id)).not.toContain(hide);
    expect(r.ignoredCount).toBe(1);
    expect(all.ignoredCount).toBe(0);
  });
});
