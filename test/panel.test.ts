import { beforeEach, describe, expect, it } from 'vitest';
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
