(function () {
'use strict';
const TZ = 'America/Lima';
const REFRESH = 5 * 60 * 1000;
const CAL = 'Google Calendar', TT = 'TickTick';
const SERVER = { google: CAL, ticktick: TT };
const fKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fTime = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fDay = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' });
const fWeekday = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, weekday: 'long' });
const fDayMon = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, day: 'numeric', month: 'short' });
const fDayNum = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, day: 'numeric' });
const fMonth = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, month: 'long' });
const dayKey = d => fKey.format(d);
const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10); };
const keyDate = k => new Date(k + 'T12:00:00-05:00');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const today = () => dayKey(new Date());
function rel(ms) { const m = Math.round(Math.abs(ms) / 60000); if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; if (h < 24) return h + ' h' + (r ? ' ' + r + ' min' : ''); const d = Math.round(h / 24); return d + (d === 1 ? ' día' : ' días'); }
/** "Hoy" / "Mañana" / "Domingo · 11 oct." para un instante. */
function whenLabel(d) {
  const k = dayKey(d), t = today();
  const day = k === t ? 'Hoy' : k === addDays(t, 1) ? 'Mañana' : cap(fDay.format(d));
  return day + ' · ' + fTime.format(d);
}

/* ---------- API ---------- */
// Los errores tienen la forma { code, message, provider }. Códigos propios del cliente:
// "network" (sin conexión) y "session" (la sesión de Cloudflare Access expiró).
// Desfase entre el reloj de este dispositivo y el del servidor (ms). El cronómetro guarda
// las horas del servidor; si el reloj local va atrasado, sin esto el tiempo "salta" al pausar.
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;

async function api(path, opts = {}) {
  let res;
  const t0 = Date.now();
  try {
    res = await fetch(path, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store', ...opts });
  } catch (_) {
    throw { code: 'network' };
  }
  const st = Number(res.headers.get('X-Server-Time'));
  // La hora se marca al final del procesamiento: se compara con la mitad del viaje de vuelta (~estimación).
  if (st > 0) { const t1 = Date.now(); clockOffset = st - (t1 - Math.min(250, (t1 - t0) / 4)); }
  // Access redirige a su página de login cuando la sesión expira.
  if (res.type === 'opaqueredirect' || res.status === 0) throw { code: 'session' };
  let body = null;
  try { body = await res.json(); } catch (_) { /* no es JSON */ }
  if (!body) throw { code: res.status === 401 || res.status === 403 ? 'session' : 'bad_response' };
  if (!res.ok) throw body.error || { code: 'upstream_error' };
  return body;
}

/* ---------- normalización ---------- */
const toEvent = e => ({ ...e, start: new Date(e.start), end: new Date(e.end), key: e.dayKey });
const toTask = t => ({ ...t, due: t.due ? new Date(t.due) : null, key: t.dayKey });

/* ---------- estado ---------- */
const S = {
  cal: { status: 'loading', items: [], at: null, err: null },
  tt: { status: 'loading', items: [], at: null, err: null },
  ev: { status: 'loading', items: [], at: null, err: null },
  st: { status: 'loading', items: null, at: null, err: null },
  gr: { status: 'loading', items: null, at: null, err: null },
  pl: { status: 'loading', items: null, at: null, err: null },
  refreshing: false,
  session: false,
};
let loadedDay = null, lastRefresh = 0, armed = null, armTimer = null, flash = null;
// Plan de la mañana: pidiéndolo ahora (planBusy) y el último error al pedirlo (planMsg).
let planBusy = false, planMsg = null;
// done: id → fecha (ms) de la ocurrencia marcada como hecha. Una tarea que se repite conserva su id
// y TickTick la pasa a la siguiente fecha: esa ocurrencia nueva sí se muestra.
const done = new Map(), pending = new Map(), notes = new Map();
const isDone = x => done.has(x.id) && done.get(x.id) === (x.due ? +x.due : null);

let evIgnored = 0, evArmed = null, evArmTimer = null;
const evHidden = new Set();
// Calendarios que fallaron en la última lectura (p. ej. el de clases) y cuándo se leyó bien cada uno por última vez.
let calFailed = [];
const calGoodAt = new Map();
const SOURCES = {
  cal: { path: '/api/calendar', pick: pickCalendar },
  tt: { path: '/api/tasks', pick: b => b.tasks.map(toTask) },
  // Hasta 40 (las del radar de próximas semanas); la ficha muestra las 6 más cercanas.
  ev: { path: '/api/evaluations?limit=40', pick: b => { evIgnored = b.ignoredCount || 0; return b.evaluations.map(toTask); } },
  st: { path: '/api/study', pick: b => b },
  gr: { path: '/api/grades', pick: b => b },
  // Plan de la mañana (Claude): lo arma el servidor a las 6:25; aquí solo se lee.
  pl: { path: '/api/plan', pick: b => b },
};

/** Eventos leídos + los últimos buenos de un calendario que esta vez falló (el servidor devuelve el resto
 *  y marca el que falló con ok: false). Así las clases no desaparecen por un error pasajero de Google. */
function pickCalendar(b) {
  const items = b.events.map(toEvent), now = Date.now();
  const cals = Array.isArray(b.calendars) ? b.calendars : [];
  const name = c => String(c.name || c.id || '');
  for (const c of cals) if (c && c.ok !== false) calGoodAt.set(name(c), now);
  const failed = cals.filter(c => c && c.ok === false).map(name);
  calFailed = failed.map(n => ({ name: n || 'un calendario', since: calGoodAt.get(n) || null }));
  if (!failed.length) return items;
  const t = today(), seen = new Set(items.map(e => e.id + '|' + +e.start));
  const kept = S.cal.items.filter(e => failed.includes(e.calendar) && e.key >= t && !seen.has(e.id + '|' + +e.start));
  return items.concat(kept).sort((a, b) => a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.start - b.start);
}

async function load(name) {
  const s = S[name], src = SOURCES[name];
  try {
    const body = await api(src.path);
    s.items = src.pick(body);
    s.status = 'ok'; s.err = null; s.at = Date.now();
    S.session = false;
  } catch (e) {
    s.err = e;
    if (e.code === 'session') S.session = true;
    // Conserva los últimos datos buenos: la sección sigue visible y avisa que no se actualizó.
    s.status = s.at ? 'stale' : 'error';
  }
}

async function refreshAll() {
  // El historial (y el mapa de constancia) pesa más: se recarga cada 30 min o tras una acción de estudio.
  if (typeof H !== 'undefined' && H.status !== 'loading' && (!H.loadedAt || Date.now() - H.loadedAt > 30 * 60 * 1000)) loadHistory();
  if (S.refreshing) return;
  S.refreshing = true; render();
  loadedDay = today(); lastRefresh = Date.now();
  await Promise.all(Object.keys(SOURCES).map(n => load(n).then(render)));
  S.refreshing = false; render();
}

/* ---------- completar tareas ---------- */
async function completeTask(id, project) {
  // La fecha se toma antes de llamar: un refresco en paralelo podría traer ya la siguiente ocurrencia.
  const it = S.tt.items.find(x => x.id === id), due0 = it && it.due ? +it.due : null;
  pending.set(id, true); notes.delete(id); render();
  try {
    await api(`/api/tasks/${encodeURIComponent(project)}/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      headers: { 'X-Pizarra': '1' },
    });
    done.set(id, due0); notes.set(id, { ok: true, t: 'Marcada como hecha' });
    Promise.all([load('tt'), load('ev')]).then(render);
  } catch (e) {
    const c = e && e.code;
    if (c === 'network' || c === 'upstream_error' || c === 'bad_response') {
      notes.set(id, { ok: false, t: 'No sé si se marcó. Actualizo la lista para comprobarlo.' });
      Promise.all([load('tt'), load('ev')]).then(render);
    } else if (c === 'session') {
      S.session = true;
      notes.set(id, { ok: false, t: 'Tu sesión expiró. Recarga la página e inténtalo de nuevo.' });
    } else if (c === 'reauth_required' || c === 'not_connected') {
      notes.set(id, { ok: false, t: 'Reconecta TickTick para poder marcar tareas.' });
    } else {
      notes.set(id, { ok: false, t: 'TickTick no aceptó el cambio' + (e && e.message ? ': ' + String(e.message).slice(0, 140) : '.') });
    }
  } finally { pending.delete(id); render(); }
}

/* ---------- vista ---------- */
const $ = id => document.getElementById(id);

function errCopy(server, e) {
  const p = e && e.provider;
  switch (e && e.code) {
    case 'not_connected': return { t: `${server} no está conectado.`, link: p && { href: `/oauth/${p}/start`, label: `Conectar ${SERVER[p]}` } };
    case 'reauth_required': return { t: `Tu acceso a ${server} expiró.`, fix: e.message || '', link: p && { href: `/oauth/${p}/start`, label: `Volver a conectar ${SERVER[p]}` } };
    case 'session': return { t: 'Tu sesión expiró.', fix: 'Recarga la página para volver a entrar.', reload: true };
    case 'network': return { t: 'Sin conexión con el servidor.', fix: 'Se reintentará en el próximo ciclo de actualización.' };
    case 'bad_response': return { t: `${server} devolvió datos en un formato que no reconozco.`, fix: e.message || '' };
    case 'misconfigured': return { t: 'Falta configuración en el servidor.', fix: e.message || '' };
    case 'upstream_error': return { t: `${server} respondió con un error.`, fix: (e.message || '') + ' Se reintentará en el próximo ciclo.' };
    default: return { t: `No se pudo leer ${server} ahora.`, fix: 'Se reintentará en el próximo ciclo de actualización.' };
  }
}
function errorBox(server, e) {
  const c = errCopy(server, e);
  return `<div class="error"><span><b>${esc(c.t)}</b> ${esc(c.fix || '')}</span>`
    + (c.link ? `<a class="btn" href="${esc(c.link.href)}">${esc(c.link.label)}</a>` : '')
    + (c.reload ? '<button type="button" data-reload="1">Recargar</button>' : '')
    + '</div>';
}
function freshText(...ss) {
  const live = ss.filter(s => s.at); if (!live.length) return { txt: '', stale: false };
  const at = Math.min(...live.map(s => s.at)); const stale = ss.some(s => s.status === 'stale');
  return { txt: (stale ? 'Sin actualizar desde ' : 'Actualizado ') + fTime.format(new Date(at)), stale };
}
function setFresh(el, f) { el.textContent = f.txt; el.classList.toggle('stale', f.stale); }
function skeleton() { return '<div class="skel"></div><div class="skel"></div><div class="skel"></div>'; }

// Etiqueta de lista/columna. En el inbox la columna (p. ej. el curso) es lo informativo.
function taskLabel(x) {
  if (x.column && x.projectId.startsWith('inbox')) return x.column;
  return [x.list, x.column].filter(Boolean).join(' · ');
}

function tasksVisible() { return S.tt.items.filter(x => !isDone(x)); }

// Estado solo de la vista: eventos abiertos/cerrados a mano y si se ven los terminados de hoy.
const evOpen = new Map();
let showPast = false;
const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function dayHeader(k, extra = '') {
  const t = today(), d = keyDate(k);
  const isToday = k === t;
  const name = isToday ? 'Hoy' : k === addDays(t, 1) ? 'Mañana' : fWeekday.format(d);
  const date = isToday || k === addDays(t, 1) ? fDay.format(d) : fDayMon.format(d);
  return `<h3 class="day-h${isToday ? ' today' : ''}"><span class="dname">${esc(name)}</span><span class="ddate">${esc(date)}</span>${extra}</h3>`;
}

/** Evento destacado: el que está en curso o, si no hay, el siguiente. */
function featured() {
  const now = Date.now(), timed = S.cal.items.filter(e => !e.allDay);
  const cur = timed.find(e => e.start <= now && e.end > now) || null;
  const nxt = timed.find(e => e.start > now) || null;
  return { cur, nxt, main: cur || nxt };
}

/* ---------- agenda ---------- */
function evRow(e, mainId, now) {
  const isNow = e.start <= now && e.end > now, past = e.end <= now;
  const open = evOpen.has(e.id) ? evOpen.get(e.id) : (e.id === mainId && !!e.desc);
  const more = open && (e.desc || e.link)
    ? `<div class="more">${e.desc ? `<p class="d">${esc(e.desc)}</p>` : ''}${e.calendar ? `<span class="cal-name"><i class="sw" aria-hidden="true"></i>${esc(e.calendar)}</span>` : ''}${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Abrir en Google Calendar ↗</a>` : ''}</div>`
    : '';
  return `<li class="ev${isNow ? ' now' : ''}${past && !isNow ? ' past' : ''}${open ? ' open' : ''}"${colorAttr(e)}>
    <button type="button" class="row-main" data-ev="${esc(e.id)}" aria-expanded="${open}">
      <span class="when"><b>${fTime.format(e.start)}</b><span>${fTime.format(e.end)}</span></span>
      <span class="t">${esc(e.title)}${isNow ? '<span class="live">Ahora</span>' : ''}</span>
      <span class="chev" aria-hidden="true">▾</span>
    </button>${more}</li>`;
}

/** Aviso cuando un calendario no se pudo leer y el resto sí. */
function calFailedBox() {
  const t = calFailed.map(c => c.since
    ? `No se pudo actualizar «${c.name}»: se muestran sus eventos leídos a las ${fTime.format(new Date(c.since))}.`
    : `No se pudo leer «${c.name}»: faltan sus eventos.`).join(' ');
  return `<div class="error"><span><b>${esc(t)}</b> Se reintentará en el próximo ciclo de actualización.</span></div>`;
}

function renderCal() {
  const s = S.cal, body = $('cal-body');
  if (s.status === 'loading' && !s.at) { body.innerHTML = skeleton(); return; }
  if (s.status === 'error') { body.innerHTML = errorBox(CAL, s.err); return; }
  const now = Date.now(), t = today(), mainId = featured().main?.id;
  let groups = new Map();
  for (const e of s.items) { if (!groups.has(e.key)) groups.set(e.key, []); groups.get(e.key).push(e); }
  // Plan de la mañana: mientras le queden bloques por delante, reemplaza a los sugeridos de hoy.
  const pi = planInfo(), plan = pi && pi.plan;
  const planBlocks = plan ? plan.blocks.filter(b => Date.parse(b.end) > now) : [];
  const box = pi ? planBox(pi, now) : '';
  const sugAll = suggestions();
  const sug = sugAll && !(planBlocks.length && sugAll.day === t) ? sugAll : null;
  // Bloques sugeridos y el plan: entran en su día (aunque ese día no tenga eventos).
  for (const k of [sug && (sug.blocks.length || sug.note) ? sug.day : null, box || planBlocks.length ? t : null]) {
    if (!k || groups.has(k)) continue;
    groups.set(k, []);
    groups = new Map([...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  }
  const canStart = !(S.st.items && S.st.items.active);
  let h = s.status === 'stale' ? errorBox(CAL, s.err) : calFailed.length ? calFailedBox() : '';
  if (!groups.size) { body.innerHTML = h + '<div class="empty">No hay eventos en los próximos 7 días.</div>'; return; }
  for (const [k, evs] of groups) {
    const allDay = evs.filter(e => e.allDay), timed = evs.filter(e => !e.allDay);
    const past = k === t ? timed.filter(e => e.end <= now) : [];
    const rest = timed.filter(e => !past.includes(e));
    const here = sug && sug.day === k ? sug : null;
    const rows = [
      ...rest.map(e => ({ at: +e.start, html: evRow(e, mainId, now) })),
      ...(here ? here.blocks : []).map(b => ({ at: b.start, html: sugRow(b, canStart) })),
      ...(k === t ? planBlocks : []).map(b => ({ at: Date.parse(b.start), html: planRow(b, canStart) })),
    ].sort((a, b) => a.at - b.at);
    h += `<div class="day">${dayHeader(k)}`;
    if (k === t) h += box;
    if (allDay.length) {
      h += '<div class="allday">' + allDay.map(e => e.link
        ? `<a class="chip"${colorAttr(e)} href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Todo el día · ${esc(e.title)}</a>`
        : `<span class="chip"${colorAttr(e)}>Todo el día · ${esc(e.title)}</span>`).join('') + '</div>';
    }
    if (past.length || rows.length) {
      h += '<ul class="rows">';
      if (past.length) {
        const n = past.length;
        h += `<li><button type="button" class="past-toggle" data-toggle-past aria-expanded="${showPast}">${showPast ? 'Ocultar' : 'Mostrar'} ${n === 1 ? '1 evento terminado' : n + ' eventos terminados'}</button></li>`;
        if (showPast) h += past.map(e => evRow(e, mainId, now)).join('');
      }
      h += rows.map(r => r.html).join('');
      h += '</ul>';
    }
    if (here && here.note) h += `<p class="sug-note">${esc(here.note)}</p>`;
    h += '</div>';
  }
  body.innerHTML = h;
}

/* ---------- tareas ---------- */
/* Enlace a TickTick: en escritorio abre la app buscando el título (ticktick://v1/search?keyword=…, probado en Windows;
   show?taskId solo abre la app, sin la tarea);
   Shift/Ctrl + clic abre la web. En el celular, la web. */
const DESKTOP_TT = /Windows|Macintosh/.test(navigator.userAgent) && !/Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
function ttLink(x) {
  if (!DESKTOP_TT) return `<a class="ext" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir en TickTick" title="Abrir en TickTick">↗</a>`;
  // Título completo (hasta 80 caracteres, cortado en una palabra) para distinguir tareas parecidas.
  const q = x.title.length > 80 ? x.title.slice(0, 80).replace(/\s+\S*$/, '') : x.title;
  const app = 'ticktick://v1/search?keyword=' + encodeURIComponent(q);
  return `<a class="ext" href="${esc(app)}" data-web="${esc(x.url)}" aria-label="Buscar en la app de TickTick" title="Buscar en la app de TickTick (Shift + clic: versión web)">↗</a>`;
}

function taskRow(x, g) {
  const now = Date.now();
  const pr = { 5: 'alta', 3: 'media', 1: 'baja' }[x.priority];
  const time = x.due && !x.allDay ? fTime.format(x.due) : '';
  const over = g === 'over' && x.due ? `<span class="chip crit">hace ${rel(now - x.due)}</span>` : '';
  const tag = taskLabel(x), busy = pending.has(x.id), isArmed = armed === x.id, note = notes.get(x.id);
  return `<li class="task p${x.priority}${isArmed ? ' armed' : ''}">
    <button type="button" class="check" data-done="${esc(x.id)}" data-project="${esc(x.projectId)}" aria-label="${isArmed ? 'Confirmar: marcar como hecha' : 'Marcar como hecha'}: ${esc(x.title)}"${busy ? ' disabled' : ''}>${CHECK_SVG}</button>
    <div class="body">
      <span class="t">${esc(x.title)}</span>
      <span class="meta">${over}${tag ? `<span class="chip">${esc(tag)}</span>` : ''}${time ? `<span class="mono">${time}</span>` : ''}${x.repeat ? '<span>↻ se repite</span>' : ''}${pr ? `<span class="sr">Prioridad ${pr}</span>` : ''}</span>
      ${x.note ? `<span class="d">${esc(x.note)}</span>` : ''}
      ${isArmed ? '<span class="confirm">¿Hecha? Toca el círculo otra vez para confirmar</span>' : ''}
      ${busy ? '<span class="msg">Marcando…</span>' : ''}
      ${note && !note.ok ? `<span class="msg bad">${esc(note.t)}</span>` : ''}
    </div>
    ${ttLink(x)}
  </li>`;
}

function renderTT() {
  const s = S.tt, body = $('tt-body');
  if (s.status === 'loading' && !s.at) { body.innerHTML = skeleton(); return; }
  if (s.status === 'error') { body.innerHTML = errorBox(TT, s.err); return; }
  const t = today(), items = tasksVisible();
  let h = s.status === 'stale' ? errorBox(TT, s.err) : '';
  const gone = [...notes].filter(([id, n]) => n.ok && done.has(id));
  if (gone.length) h += `<div class="done-note">✓ ${gone.length === 1 ? '1 tarea marcada' : gone.length + ' tareas marcadas'} como hecha${gone.length === 1 ? '' : 's'} en TickTick.</div>`;
  if (!items.length) { body.innerHTML = h + '<div class="empty">Nada pendiente para los próximos 7 días ni vencido.</div>'; return; }
  const groups = new Map();
  for (const x of items) { const g = !x.key ? 'sin' : x.key < t ? 'over' : x.key; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
  for (const [g, xs] of groups) {
    const badge = `<span class="count-badge">${xs.length}</span>`;
    const head = g === 'over' ? `<h3 class="day-h"><span class="dname over">Vencidas</span>${badge}</h3>`
      : g === 'sin' ? `<h3 class="day-h"><span class="dname">Sin fecha</span>${badge}</h3>`
      : dayHeader(g, badge);
    h += `<div class="day">${head}<ul class="rows">${xs.map(x => taskRow(x, g)).join('')}</ul></div>`;
  }
  body.innerHTML = h;
}

/* ---------- resumen ---------- */
function renderHero() {
  const el = $('tile-next'), s = S.cal;
  if (s.status === 'loading' && !s.at) { el.innerHTML = '<span class="eyebrow">Ahora</span><div class="skel"></div>'; return; }
  if (s.status === 'error') { el.innerHTML = '<span class="eyebrow">Ahora</span>' + errorBox(CAL, s.err); return; }
  const now = Date.now(), t = today();
  const { cur, nxt, main } = featured();
  const allDayToday = s.items.filter(e => e.allDay && e.key === t);
  let h = '';
  if (cur) {
    const pct = Math.min(100, Math.max(0, Math.round((now - cur.start) / (cur.end - cur.start) * 100)));
    h += `<div class="hero-top"><span class="pill"><span class="dot" aria-hidden="true"></span>Ahora</span><span class="hero-when mono">${fTime.format(cur.start)}–${fTime.format(cur.end)}</span></div>
      <h2 class="hero-title"${colorAttr(cur)}>${esc(cur.title)}</h2>${cur.desc ? `<p class="hero-desc">${esc(cur.desc)}</p>` : ''}
      <progress${colorAttr(cur)} max="100" value="${pct}" aria-label="Avance del evento: ${pct} %"></progress>
      <div class="hero-count"><span class="big">${rel(cur.end - now)}</span><span class="muted">para terminar</span></div>`;
  } else if (nxt) {
    h += `<div class="hero-top"><span class="pill">Siguiente</span><span class="hero-when">${esc(whenLabel(nxt.start))}</span></div>
      <h2 class="hero-title"${colorAttr(nxt)}>${esc(nxt.title)}</h2>${nxt.desc ? `<p class="hero-desc">${esc(nxt.desc)}</p>` : ''}
      <div class="hero-count"><span class="big">en ${rel(nxt.start - now)}</span></div>`;
  } else {
    h += '<div class="hero-top"><span class="pill">Agenda</span></div><p class="msg-empty">Nada más agendado esta semana.</p>';
  }
  if (allDayToday.length) h += '<div class="hero-allday">' + allDayToday.map(e => `<span>Todo el día · ${esc(e.title)}</span>`).join('') + '</div>';
  if (main) {
    const later = s.items.filter(e => !e.allDay && e !== main && e.start > now && dayKey(e.start) === t).slice(0, 4);
    if (later.length) {
      h += `<div class="later"><span class="eyebrow">${cur ? 'Después, hoy' : 'Más tarde, hoy'}</span><ul>`
        + later.map(e => `<li${colorAttr(e)}><span class="mono">${fTime.format(e.start)}</span><span><i class="sw" aria-hidden="true"></i>${esc(e.title)}</span></li>`).join('') + '</ul></div>';
    } else if (dayKey(main.start) === t) {
      h += `<div class="later"><p>Es lo último de hoy.${cur && nxt ? ` Luego: ${esc(whenLabel(nxt.start))} · ${esc(nxt.title)}` : ''}</p></div>`;
    } else {
      h += '<div class="later"><p>Hoy ya no queda nada en la agenda.</p></div>';
    }
  }
  if (s.status === 'stale') h += `<span class="muted">Sin actualizar desde ${fTime.format(new Date(s.at))}</span>`;
  else if (calFailed.length) h += `<span class="muted">Sin datos nuevos de ${esc(listFmt.format(calFailed.map(c => '«' + c.name + '»')))} (ver Agenda).</span>`;
  el.innerHTML = h;
}

function renderCounts() {
  const t = today(), items = tasksVisible();
  let h = '<span class="eyebrow">Tareas pendientes</span>';
  if (S.tt.status === 'loading' && !S.tt.at) h += '<span class="muted">Cargando TickTick…</span>';
  else if (S.tt.status === 'error') h += '<span class="muted">Sin datos de TickTick.</span>';
  else {
    const over = items.filter(x => x.key && x.key < t).length, tod = items.filter(x => x.key === t).length, wk = items.filter(x => x.key && x.key > t).length;
    h += `<div class="counts"><div class="count${over ? ' crit' : ''}"><span class="n">${over}</span><span class="l">vencidas</span></div><div class="count${tod ? ' warn' : ''}"><span class="n">${tod}</span><span class="l">para hoy</span></div><div class="count"><span class="n">${wk}</span><span class="l">esta semana</span></div></div>`;
  }
  $('tile-tasks').innerHTML = h;
}

function renderExams() {
  const t = today(), ev = S.ev;
  let h = '<span class="eyebrow">Próximas evaluaciones</span>';
  if (ev.status === 'loading' && !ev.at) h += '<span class="muted">Cargando…</span>';
  else if (ev.status === 'error') h += errorBox(TT, ev.err);
  else {
    const list = ev.items.filter(x => x.key && x.key >= t && !isDone(x) && !evHidden.has(x.id)).slice(0, 6);
    if (!list.length) h += '<span class="muted">Nada en los próximos 70 días. Las tareas de TickTick que empiezan con PC, Parcial, Examen, Entrega o Actividad calificada aparecen aquí.</span>';
    else {
      h += '<ul class="exams">';
      for (const x of list) {
        const d = Math.round((keyDate(x.key) - keyDate(t)) / 864e5);
        const num = d === 0 ? '<b>Hoy</b>' : `<b>${d}</b><small>${d === 1 ? 'día' : 'días'}</small>`;
        const urg = d <= 3 ? ' u-crit' : d <= 7 ? ' u-warn' : '';
        const when = esc(fDay.format(x.due)) + (x.allDay ? '' : ' · ' + fTime.format(x.due));
        const lbl = taskLabel(x);
        const gi = gradeInfoFor(x);
        const armedX = evArmed === x.id;
        h += `<li class="exam${urg}"><span class="days" aria-label="${d === 0 ? 'hoy' : 'en ' + d + (d === 1 ? ' día' : ' días')}">${num}</span><span class="info"><span class="nm">${esc(x.name)}</span><span class="sub">${lbl ? esc(lbl) + ' · ' : ''}${when}</span>${gi ? `<span class="sub gi">${esc(gi)}</span>` : ''}</span><button type="button" class="ex-x${armedX ? ' armed' : ''}" data-eval-ignore="${esc(x.id)}" title="No es una evaluación: ocultar" aria-label="${armedX ? 'Confirmar: ocultar' : 'Ocultar'} ${esc(x.name)}">${armedX ? '¿Ocultar?' : '✕'}</button></li>`;
      }
      h += '</ul>';
    }
    const hiddenN = evIgnored + evHidden.size;
    if (hiddenN) h += `<span class="ex-foot">${hiddenN === 1 ? '1 oculta' : hiddenN + ' ocultas'} · <button type="button" class="linkish" data-eval-restore>Restaurar</button></span>`;
    if (ev.status === 'stale') h += '<span class="fresh stale">Sin actualizar desde ' + fTime.format(new Date(ev.at)) + '</span>';
  }
  $('tile-exams').innerHTML = h;
}

function renderBanner() {
  const b = $('banner');
  if (S.session) {
    b.className = 'banner';
    b.innerHTML = '<span><b>Tu sesión expiró.</b> Recarga la página para volver a entrar; mientras tanto ves los últimos datos.</span><button type="button" data-reload="1">Recargar</button>';
    b.hidden = false;
  } else if (flash) {
    b.className = 'banner good';
    b.innerHTML = `<span><b>${esc(flash)}</b></span>`;
    b.hidden = false;
  } else b.hidden = true;
}

function renderDate() {
  const d = new Date();
  $('today-label').innerHTML = `${esc(cap(fWeekday.format(d)))} <span class="dnum">${esc(fDayNum.format(d))}</span><span class="mon">de ${esc(fMonth.format(d).toLocaleLowerCase('es'))}</span>`;
}

/* ---------- estudio ---------- */
const fDayShort = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, weekday: 'short', day: 'numeric' });
const listFmt = new Intl.ListFormat('es', { style: 'long', type: 'conjunction' });
let studyMsg = null, studyArmed = null, studyArmTimer = null, studyBusy = false, moreRenderedAt = null, moreDirty = false;

function fmtMin(m) {
  m = Math.max(0, Math.round(m));
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60), r = m % 60;
  return h + ' h' + (r ? ' ' + String(r).padStart(2, '0') : '');
}
/** Tiempo de estudio activo del cronómetro (sin pausas). */
function activeElapsed(a) {
  return Math.max(0, (a.pausedAt || serverNow()) - a.startedAt - (a.pausedMs || 0));
}
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
}

async function studyAction(path, method, body) {
  if (studyBusy) return;
  studyBusy = true; studyMsg = null; render();
  try {
    const r = await api(path, {
      method,
      headers: { 'X-Pizarra': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (path.endsWith('/stop')) studyMsg = r.saved ? { ok: true, t: `Guardado: ${fmtMin(r.minutes)} de ${r.course}${r.capped ? ' (recortado a 12 h)' : ''}.` } : { ok: false, t: r.reason };
    else if (path.endsWith('/manual')) { studyMsg = { ok: true, t: `Sesión agregada: ${fmtMin(r.minutes)} de ${r.course}.` }; moreDirty = false; }
    else if (path.endsWith('/goals')) { studyMsg = { ok: true, t: 'Metas guardadas.' }; moreDirty = false; }
    else if (path.endsWith('/courses')) { studyMsg = { ok: true, t: 'Cursos actualizados.' }; moreDirty = false; }
    else if (path.endsWith('/cycle')) {
      // Las notas van por ciclo: un ajuste de fecha las mueve; otro ciclo empieza en blanco.
      studyMsg = { ok: true, t: r.grades === 'new' ? 'Inicio del ciclo guardado. Es otro ciclo: Notas empieza en blanco (las notas anteriores siguen guardadas con la fecha anterior).' : 'Inicio del ciclo guardado.' };
      load('gr').then(render);
    }
    else if (path.endsWith('/claude-note/context')) {
      studyMsg = r.error ? { ok: false, t: 'Contexto guardado, pero la nota no se pudo actualizar: ' + r.error } : { ok: true, t: 'Contexto guardado y nota actualizada en TickTick.' };
      moreDirty = false;
    }
    else if (path.endsWith('/claude-note/sync')) studyMsg = r.error ? { ok: false, t: 'No se pudo actualizar la nota: ' + r.error } : { ok: true, t: 'Nota para Claude actualizada en TickTick.' };
    else if (method === 'DELETE') studyMsg = { ok: true, t: 'Sesión borrada.' };
    return r;
  } catch (e) {
    if (e && e.code === 'session') S.session = true;
    studyMsg = { ok: false, t: e && e.message ? e.message : 'No se pudo completar la acción.' };
  } finally {
    studyBusy = false;
    await load('st');
    render();
    loadHistory();
  }
}

function renderStudy() {
  const s = S.st, main = $('study-main'), d = s.items;
  if (s.status === 'loading' && !s.at) { main.innerHTML = '<div class="skel"></div><div class="skel"></div>'; $('study-total').textContent = ''; return; }
  if (s.status === 'error' || !d) { main.innerHTML = errorBox(TT, s.err); $('study-total').textContent = ''; return; }

  const goalTotal = d.goalTotalMinutes;
  $('study-total').innerHTML = `Total <b>${fmtMin(d.totalMinutes)}</b>${goalTotal ? ` / ${fmtMin(goalTotal)}` : ''}`;

  // Cronómetro
  let t = '';
  const msg = studyMsg ? `<span class="msg ${studyMsg.ok ? 'good' : 'bad'}">${esc(studyMsg.t)}</span>` : '';
  if (d.active) {
    const isArmed = studyArmed === 'cancel';
    const paused = !!d.active.pausedAt;
    const pausedMin = Math.round(((d.active.pausedMs || 0) + (paused ? serverNow() - d.active.pausedAt : 0)) / 60000);
    t = `<div class="timer running${paused ? ' paused' : ''}">
      <div class="t-head"><span class="pill">${paused ? '<span class="pause-ico" aria-hidden="true">❚❚</span>En pausa' : '<span class="dot" aria-hidden="true"></span>Estudiando'}</span><span class="t-course">${esc(d.active.course)}</span></div>
      <span class="t-clock mono" id="study-clock">${clock(activeElapsed(d.active))}</span>
      <span class="muted">Desde las ${fTime.format(new Date(d.active.startedAt))}${dayKey(new Date(d.active.startedAt)) !== today() ? ' de ' + esc(fDay.format(new Date(d.active.startedAt))) : ''}${pausedMin ? ` · ${fmtMin(pausedMin)} en pausa` : ''}</span>
      <div class="t-actions">${paused
        ? `<button type="button" data-study-resume${studyBusy ? ' disabled' : ''}>▶ Reanudar</button>`
        : `<button type="button" data-study-pause${studyBusy ? ' disabled' : ''}>❚❚ Pausar</button>`}<button type="button" class="${paused ? '' : 'ghost'}" data-study-stop${studyBusy ? ' disabled' : ''}>■ Parar y guardar</button><button type="button" class="ghost${isArmed ? ' armed' : ''}" data-study-cancel${studyBusy ? ' disabled' : ''}>${isArmed ? '¿Descartar? Toca otra vez' : 'Descartar'}</button></div>
      ${msg}<div class="daily" id="daily"></div></div>`;
  } else {
    t = `<div class="timer"><span class="eyebrow">Empezar a estudiar</span>
      <div class="course-btns">${d.courses.map(c => `<button type="button" data-study-start="${esc(c.name)}"${studyBusy ? ' disabled' : ''}>▶ ${esc(c.name)}</button>`).join('')}<button type="button" data-study-start="General"${studyBusy ? ' disabled' : ''}>▶ General</button></div>
      <span class="muted">El tiempo se guarda en TickTick al parar. También cuenta lo que cronometres desde la app de TickTick sobre una tarea del curso.</span>
      ${msg}<div class="daily" id="daily"></div></div>`;
  }

  // Metas (con ritmo necesario y pronóstico)
  const pace = studyPace(d);
  let g = '<div class="goals"><span class="eyebrow">Metas de la semana</span>' + paceSummary(pace);
  for (const c of d.courses) {
    if (c.goalMinutes) {
      const cp = pace.byCourse[c.name];
      const doneC = cp ? cp.doneWeek : c.minutes;
      const met = doneC >= c.goalMinutes;
      g += `<div class="goal${met ? ' met' : ''}"><div class="g-top"><span class="g-name">${esc(c.name)}</span><span class="g-val mono">${met ? '✓ ' : ''}${fmtMin(doneC)} <span class="muted">/ ${fmtMin(c.goalMinutes)}</span></span></div><progress max="${c.goalMinutes}" value="${Math.min(doneC, c.goalMinutes)}" aria-label="${esc(c.name)}: ${fmtMin(doneC)} de ${fmtMin(c.goalMinutes)}"></progress>${coursePaceLine(cp)}</div>`;
    } else {
      g += `<div class="goal nogoal"><div class="g-top"><span class="g-name">${esc(c.name)}</span><span class="g-val mono">${fmtMin(c.minutes)} <span class="muted">· sin meta</span></span></div></div>`;
    }
  }
  if (d.otherMinutes) g += `<div class="goal nogoal"><div class="g-top"><span class="g-name">Otros / General</span><span class="g-val mono">${fmtMin(d.otherMinutes)}</span></div></div>`;
  if (!d.courses.some(c => c.goalMinutes)) g += '<p class="hint">Pon una meta semanal por curso en «metas», aquí abajo.</p>';
  g += dayTable(d) + '</div>';
  main.innerHTML = t + g;
  renderDaily();
  // El mapa de constancia usa la meta diaria (llega con /api/study): se redibuja si cambió o si se dibujó sin ella.
  if (H.data && heatGoal !== dailyGoalMin()) renderStreak();

  // Panel desplegable: solo se redibuja con datos nuevos y si no lo estás editando.
  const more = $('study-more');
  if (moreRenderedAt !== s.at && !moreDirty && !more.contains(document.activeElement)) {
    moreRenderedAt = s.at;
    more.innerHTML = renderStudyMore(d);
  } else if (studyArmed && studyArmed !== 'cancel') {
    more.querySelectorAll('[data-study-del]').forEach(b => {
      const on = b.dataset.studyDel === studyArmed;
      b.classList.toggle('armed', on); b.textContent = on ? '¿Borrar?' : 'Borrar';
    });
  }
  const cs = document.getElementById('claude-status');
  if (cs && d.note) cs.innerHTML = claudeStatus(d.note);
}

/* ---------- ritmo y pronóstico (lógica en pace.js) ---------- */
/** Minutos de esta semana y de hoy por curso (incluye el cronómetro en marcha) y el plan/pronóstico de cada uno. */
function studyPace(d) {
  const today = d.today;
  const daysLeft = Math.round((keyUTC(d.weekEnd) - keyUTC(today)) / 864e5) + 1;
  const todayBy = {};
  for (const x of d.sessions) {
    if (x.course && dayKey(new Date(x.start)) === today) todayBy[x.course] = (todayBy[x.course] || 0) + x.minutes;
  }
  const live = d.active ? activeElapsed(d.active) / 60000 : 0;
  if (live) todayBy[d.active.course] = (todayBy[d.active.course] || 0) + live;

  // Todo se mide con los cursos que tienen meta. El ritmo real sale de las semanas completas
  // anteriores del historial (mínimo 2), curso por curso.
  const h = H.data;
  // Solo cuentan las semanas desde la primera con datos: antes de empezar a registrar no hay "0 h", hay vacío.
  const firstData = h ? h.weeks.findIndex(w => w.total > 0) : -1;
  const past = firstData >= 0 ? h.weeks.slice(firstData).filter(w => w.start < h.currentWeek) : [];
  const enough = past.length >= 2;
  const goalCourses = d.courses.filter(c => c.goalMinutes);

  const byCourse = {}, pendingToday = [];
  let todayTarget = 0, todayLeft = 0, perDayAfter = 0, goalTotal = 0, todayDone = 0, perDay = 0, forecast = 0, allMet = true;
  for (const c of goalCourses) {
    const doneWeek = c.minutes + (d.active && d.active.course === c.name ? live : 0);
    const doneToday = todayBy[c.name] || 0;
    const plan = Pace.weekPlan({ goal: c.goalMinutes, doneWeek, doneToday, daysLeft });
    const hist = enough ? Pace.pastWeeks(past.map(w => w.byCourse[c.name] || 0), c.goalMinutes) : null;
    const coursePerDay = hist ? hist.average / 7 : null;
    const fc = Pace.forecastWeek({ perDay: coursePerDay, doneWeek, doneToday, daysLeft });
    byCourse[c.name] = { doneWeek, doneToday, plan, forecast: fc, goal: c.goalMinutes };
    goalTotal += c.goalMinutes;
    todayDone += doneToday;
    if (hist) { perDay += coursePerDay; forecast += fc; }
    if (!plan.met) { allMet = false; todayTarget += plan.todayTarget; todayLeft += plan.todayLeft; perDayAfter += plan.perDayAfter; }
    if (plan && !plan.met && plan.todayLeft >= 1) pendingToday.push({ name: c.name, left: plan.todayLeft });
  }
  return {
    any: goalCourses.length > 0, allMet, daysLeft, goalTotal, byCourse,
    todayTarget, todayLeft, perDayAfter, todayDone, pendingToday,
    perDay: enough ? perDay : null,
    forecast: enough ? forecast : null,
    pastCount: past.length,
    past: enough ? Pace.pastWeeks(past.map(w => goalCourses.reduce((a, c) => a + (w.byCourse[c.name] || 0), 0)), goalTotal) : null,
  };
}

function paceSummary(p) {
  if (!p.any) return '';
  let h = '<div class="pace">';
  if (p.allMet) h += '<p class="pace-done">Metas de la semana cumplidas ✓</p>';
  else {
    // Cada curso tiene su meta: lo extra en uno no cubre a otro, así que se dice qué curso falta.
    const pend = p.pendingToday.map(x => `<b>${fmtMin(x.left)}</b> de ${esc(x.name)}`);
    h += `<p><b>Hoy: ${fmtMin(p.todayTarget)}</b> <span class="muted">· llevas ${fmtMin(p.todayDone)}</span>${pend.length ? ` · te faltan ${listFmt.format(pend)}` : ' · <span class="ok">hoy cumplido ✓</span>'}</p>`;
    if (p.daysLeft > 1) h += `<p>Luego: <b>${fmtMin(p.perDayAfter)}</b> por día hasta el domingo <span class="muted">(${p.daysLeft - 1} ${p.daysLeft - 1 === 1 ? 'día' : 'días'})</span></p>`;
  }
  if (p.forecast !== null) {
    const ok = p.forecast >= p.goalTotal;
    h += `<p class="fc">A tu ritmo (${fmtMin(p.perDay)} por día) llegarías a <b>~${fmtMin(p.forecast)}</b> de ${fmtMin(p.goalTotal)}${ok ? ' <span class="ok">✓</span>' : ` · faltarían ${fmtMin(p.goalTotal - p.forecast)}`}</p>`;
  } else {
    h += `<p class="hint">Pronóstico: aparece cuando tengas 2 semanas completas registradas (${p.pastCount === 1 ? 'llevas 1' : 'llevas ' + p.pastCount}).</p>`;
  }
  if (p.past) h += `<p class="hint">Últimas ${p.past.count} ${p.past.count === 1 ? 'semana' : 'semanas'}: promedio ${fmtMin(p.past.average)} · en tus cursos con meta habrías cumplido la meta actual en ${p.past.met} de ${p.past.count}.</p>`;
  return h + '</div>';
}

function coursePaceLine(cp) {
  if (!cp || !cp.plan || cp.plan.met) return '';
  const parts = [cp.plan.todayLeft >= 1 ? `hoy faltan ${fmtMin(cp.plan.todayLeft)}` : 'hoy cumplido ✓'];
  if (cp.plan.daysAfter > 0) parts.push(`luego ${fmtMin(cp.plan.perDayAfter)}/día`);
  if (cp.forecast !== null) parts.push(cp.forecast >= cp.goal ? `a tu ritmo ~${fmtMin(cp.forecast)} ✓` : `a tu ritmo ~${fmtMin(cp.forecast)} (faltarían ${fmtMin(cp.goal - cp.forecast)})`);
  return `<span class="g-pace">${parts.join(' · ')}</span>`;
}

/* ---------- por día: curso × día de una semana ---------- */
const fDowHead = new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', weekday: 'short' });
let dayWeek = null; // lunes de la semana mostrada; null = la actual

/** "45m", "1h10", "2h": cabe en una columna angosta del celular. */
function fmtShort(m) {
  m = Math.round(m);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60), r = m % 60;
  return h + 'h' + (r ? String(r).padStart(2, '0') : '');
}

/** Minutos por día y curso ('' = otros). La semana actual sale de las sesiones (más el cronómetro en marcha), igual que las metas; las anteriores, del historial. */
function weekDays(d, monday) {
  const out = {};
  if (monday === d.weekStart) {
    const visible = new Set(d.courses.map(c => c.name));
    const add = (k, c, m) => { const o = (out[k] ||= {}); const ck = c && visible.has(c) ? c : ''; o[ck] = (o[ck] || 0) + m; };
    for (const x of d.sessions) add(dayKey(new Date(x.start)), x.course, x.minutes);
    if (d.active) add(d.today, d.active.course, activeElapsed(d.active) / 60000);
    return out;
  }
  const dc = (H.data && H.data.dayCourses) || {};
  for (let i = 0; i < 7; i++) { const k = addDays(monday, i); if (dc[k]) out[k] = dc[k]; }
  return out;
}

function dayTable(d) {
  const cur = d.weekStart, h = H.data;
  const first = h && h.weeks.length ? h.weeks[0].start : cur;
  const monday = dayWeek && dayWeek >= first && dayWeek < cur ? dayWeek : cur;
  const data = weekDays(d, monday);
  const keys = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(monday, i));
  const val = (k, c) => Math.round((data[k] && data[k][c]) || 0);
  const rows = d.courses.map(c => c.name);
  if (keys.some(k => val(k, ''))) rows.push('');
  const td = (k, m, cls = '') => k > d.today ? '<td class="fut"></td>'
    : `<td class="mono${k === d.today ? ' today' : ''}${cls}">${m ? fmtShort(m) : '<span class="zero">·</span>'}</td>`;

  const label = monday === cur ? 'Esta semana' : weekRangeLabel({ start: monday, end: keys[6] });
  const prevOff = !h || monday <= first, nextOff = monday >= cur;
  let out = `<div class="perday"><div class="perday-head"><span class="eyebrow">Por día</span>
    <span class="perday-nav"><button type="button" class="ghost" data-days-nav="-1" aria-label="Semana anterior"${prevOff ? ' disabled' : ''}>‹</button><span class="perday-week">${esc(label)}</span><button type="button" class="ghost" data-days-nav="1" aria-label="Semana siguiente"${nextOff ? ' disabled' : ''}>›</button></span></div>
    <div class="tbl-scroll"><table class="perday-tbl"><thead><tr><th scope="col"><span class="sr">Curso</span></th>${keys.map(k => `<th scope="col"${k === d.today ? ' class="today"' : ''}><span>${esc(fDowHead.format(keyUTC(k)).replace('.', ''))}</span><span>${Number(k.slice(8))}</span></th>`).join('')}</tr></thead><tbody>`;
  for (const c of rows) {
    out += `<tr><th scope="row">${esc(c || 'Otros')}</th>${keys.map(k => td(k, val(k, c))).join('')}</tr>`;
  }
  out += `<tr class="tot"><th scope="row">Total</th>${keys.map(k => td(k, rows.reduce((a, c) => a + val(k, c), 0))).join('')}</tr>`;
  return out + '</tbody></table></div></div>';
}

/* ---------- meta diaria: la planta ----------
   Todo lo estudiado en el día (cualquier curso). La planta crece mientras estudias: el tallo sube
   sin parar, sale una hoja cada 1/8 de la meta (30 min en 4 h), un botón en el último tramo y
   florece al cumplirla. Después, premios hasta 2 h más (lógica en pace.js → Pace.bonus):
   una flor extra cada 30 min, maceta dorada a +1 h y mariposa a +2 h (tope). Los días libres
   no suman ni cortan la racha. */
const DOW_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DOW_LETTER = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const dowOf = k => new Date(k + 'T12:00:00Z').getUTCDay();
const EXTRA_POS = [[20, 21], [40, 19], [18, 31], [42, 29]];
const BLOOM_KEY = 'bitacora:bloom', RECORD_KEY = 'bitacora:record';
const flagMem = {};
let dailyTick = 0;

// Qué ya se celebró hoy (por dispositivo). Sin almacenamiento, vale en memoria hasta recargar.
function readFlag(k) { try { const v = localStorage.getItem(k); return v === null ? (flagMem[k] ?? null) : v; } catch (_) { return flagMem[k] ?? null; } }
function saveFlag(k, v) { flagMem[k] = v; try { localStorage.setItem(k, v); } catch (_) { /* sin almacenamiento */ } }
/** Nivel ya celebrado hoy: 1 floración, 2 maceta dorada, 3 mariposa ("YYYY-MM-DD" a secas = 1, formato anterior). */
function celebratedLevel(day) {
  const v = readFlag(BLOOM_KEY);
  if (!v) return 0;
  const [k, l] = v.split('|');
  return k === day ? Number(l || 1) : 0;
}

function daysLabel(w) {
  const k = [...w].sort((a, b) => a - b).join(',');
  return k === '1,2,3,4,5' ? 'lun a vie' : k === '1,2,3,4,5,6' ? 'lun a sáb' : k === '0,1,2,3,4,5,6' ? 'todos los días' : w.map(x => DOW_SHORT[x]).join(', ');
}

function flowerSvg(x, y, r, cls) {
  let g = `<g class="${cls}">`;
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    g += `<circle class="pl-petal" cx="${(x + r * 1.27 * Math.cos(a)).toFixed(2)}" cy="${(y + r * 1.27 * Math.sin(a)).toFixed(2)}" r="${r}"/>`;
  }
  return g + `<circle class="pl-core" cx="${x}" cy="${y.toFixed(2)}" r="${(r * 0.78).toFixed(2)}"/></g>`;
}

/**
 * Planta para un avance p (0–1). viewBox 60×64; las clases pl-* toman los colores del tema.
 * opts: cls (clases extra del svg), extra (flores extra 0–4), gold (maceta dorada), butterfly, hideExtra (índice que aparece con animación).
 */
function plantSvg(p, size, opts = {}) {
  p = Math.max(0, Math.min(1, p || 0));
  const gold = opts.gold ? ' gold' : '';
  let g = `<svg class="plant${opts.cls || ''}" width="${size}" height="${size}" viewBox="0 0 60 64" aria-hidden="true" focusable="false">`
    + `<g class="pl-potg"><path class="pl-pot${gold}" d="M17 48h26l-3 14H20z"/><rect class="pl-rim${gold}" x="15" y="44" width="30" height="5" rx="1.5"/></g>`;
  if (p === 0) return g + '<ellipse class="pl-seed" cx="30" cy="42.6" rx="2.4" ry="1.6"/></svg>';
  const top = 43 - (5 + 27 * p);
  g += `<path class="pl-stem" d="M30 44 Q${p > 0.5 ? 27.5 : 31.5} ${((44 + top) / 2).toFixed(1)} 30 ${top.toFixed(1)}"/>`;
  const leaves = Math.min(8, Math.floor(p * 8 + 1e-9));
  for (let i = 0; i < leaves; i++) {
    const y = 40 - i * 3.3, left = i % 2 === 0, x = left ? 25 : 35;
    if (y < top + 2) break;
    g += `<ellipse class="pl-leaf" cx="${x}" cy="${y.toFixed(1)}" rx="5.2" ry="2.3" transform="rotate(${left ? -28 : 28} ${x} ${y.toFixed(1)})"/>`;
  }
  if (p >= 1) {
    for (let i = 0; i < Math.min(4, opts.extra || 0); i++) {
      const [x, y] = EXTRA_POS[i];
      g += `<g class="pl-extra${i === opts.hideExtra ? ' pre-pop' : ''}" data-i="${i}"><line class="pl-twig" x1="30" y1="${y + 4}" x2="${x}" y2="${y}"/>${flowerSvg(x, y, 2.1, 'pl-mini')}</g>`;
    }
    g += flowerSvg(30, top, 3.4, 'pl-flower');
    if (opts.butterfly) {
      g += '<g transform="translate(49 9) rotate(-15)"><g class="pl-fly"><g class="pl-wings">'
        + '<ellipse class="pl-wing" cx="-3" cy="-2" rx="3.4" ry="2.4"/><ellipse class="pl-wing" cx="3" cy="-2" rx="3.4" ry="2.4"/>'
        + '<ellipse class="pl-wing2" cx="-2.4" cy="2" rx="2.2" ry="1.6"/><ellipse class="pl-wing2" cx="2.4" cy="2" rx="2.2" ry="1.6"/></g>'
        + '<line class="pl-body" x1="0" y1="-4" x2="0" y2="4"/></g></g>';
    }
  } else if (p >= 7 / 8) {
    g += `<ellipse class="pl-petal" cx="30" cy="${(top - 1.6).toFixed(1)}" rx="2.1" ry="3.1"/>`;
  }
  return g + '</svg>';
}

/** Minutos por día de esta semana (todas las materias, con el cronómetro en marcha hoy), premios, racha, récord y jardín. */
function dailyState(d) {
  const goal = d.daily;
  if (!goal || !goal.minutes) return null;
  const byDay = {};
  for (const x of d.sessions) { const k = dayKey(new Date(x.start)); byDay[k] = (byDay[k] || 0) + x.minutes; }
  if (d.active) byDay[d.today] = (byDay[d.today] || 0) + activeElapsed(d.active) / 60000;
  const isGoalDay = k => goal.weekdays.includes(dowOf(k));
  const week = [0, 1, 2, 3, 4, 5, 6].map(i => {
    const k = addDays(d.weekStart, i), m = byDay[k] || 0;
    return { k, m, goalDay: isGoalDay(k), bonus: Pace.bonus(m, goal.minutes) };
  });
  let streak = null, garden = null;
  const h = H.data;
  if (h && h.days) {
    const from = h.cycleStart > h.from ? h.cycleStart : h.from;
    const days = { ...h.days, ...byDay };
    streak = Pace.dailyStreak({ days, goal: goal.minutes, weekdays: goal.weekdays, from, today: d.today });
    garden = Pace.garden({ days, goal: goal.minutes, from, today: d.today });
  }
  const done = byDay[d.today] || 0;
  return {
    goal: goal.minutes, weekdays: goal.weekdays, done, goalDay: isGoalDay(d.today), today: d.today,
    bonus: Pace.bonus(done, goal.minutes), week, streak, garden, running: !!(d.active && !d.active.pausedAt),
  };
}

/** Qué celebrar ahora (una vez por día cada cosa): el nivel nuevo de premios o un récord del ciclo. */
function pendingKind(s) {
  const lvl = s.bonus.level, prev = celebratedLevel(s.today);
  if (lvl > prev) return lvl === 1 ? 'bloom' : lvl === 2 ? 'gold' : 'fly';
  if (s.garden && s.garden.newRecord && readFlag(RECORD_KEY) !== s.today) return 'record';
  return null;
}

function dailyHtml(s, kind, hideExtra) {
  const b = s.bonus;
  let main, next = '';
  if (b.level === 3) main = `<b>¡Día completo!</b> ${fmtMin(s.done)} hoy ✓`;
  else if (b.level === 2) main = `<b>¡Día de oro!</b> ${fmtMin(s.done)} hoy ✓`;
  else if (b.level === 1) main = `<b>¡Floreció!</b> ${fmtMin(s.done)} hoy ✓`;
  else if (!s.goalDay) main = `Día libre${s.done >= 1 ? ` · ${fmtMin(s.done)} estudiadas` : ''}`;
  else {
    main = `<b>${fmtMin(s.done)}</b> de ${fmtMin(s.goal)} · faltan ${fmtMin(s.goal - s.done)}`;
    const at = new Date(serverNow() + (s.goal - s.done) * 60000);
    next = dayKey(at) !== s.today ? 'Hoy ya no alcanzan las horas para llegar.'
      : `${s.running ? 'Si sigues sin parar' : 'Si empiezas ahora'}, llegas a las <b>${fTime.format(at)}</b>.`;
  }
  if (b.next) {
    const what = b.next === s.goal + 120 ? 'la mariposa y la última flor' : b.next === s.goal + 60 ? 'la maceta dorada y otra flor' : 'otra flor';
    next = `Siguiente premio: ${what} en <b>${fmtMin(Math.max(1, Math.ceil(b.next - s.done)))}</b>.`;
  } else if (b.level === 3) next = `${b.flowers} flores, maceta dorada y mariposa: llegaste al tope de premios de hoy.`;

  const st = s.streak;
  const unit = n => n === 1 ? 'día' : 'días';
  const streak = !st ? ''
    : st.current ? `Racha: <b>${st.current}</b> ${st.current === 1 ? 'día' : 'días seguidos'} con ${fmtMin(s.goal)}${st.best > st.current ? ` · mejor racha: ${st.best}` : ' · tu mejor racha'}`
    : st.best ? `Racha en 0 · mejor racha: ${st.best} ${unit(st.best)}`
    : `Aún sin días de ${fmtMin(s.goal)}: hoy puede ser el primero.`;

  const g = s.garden;
  let counters = '';
  if (g) {
    const dm = k => `${DOW_SHORT[dowOf(k)]} ${Number(k.slice(8))}/${Number(k.slice(5, 7))}`;
    const rec = g.newRecord ? `<b>¡Nuevo récord del ciclo!</b> (antes ${fmtMin(g.prevBest)})`
      : g.best >= 1 ? `Récord del ciclo: ${fmtMin(g.best)} (${g.bestDay === s.today ? 'hoy' : dm(g.bestDay)})` : '';
    counters = [rec, `Jardín: <b>${g.flowers}</b> ${g.flowers === 1 ? 'flor' : 'flores'}`].filter(Boolean).join(' · ');
  }

  const pots = s.week.map(w => {
    const wb = w.bonus;
    const prize = wb.level === 3 ? ' · mariposa' : wb.level === 2 ? ' · maceta dorada' : '';
    const tip = `${DOW_SHORT[dowOf(w.k)]} ${Number(w.k.slice(8))}: ${w.m >= 1 ? fmtMin(w.m) : 'sin estudio'}`
      + (wb.flowers ? ` ✓ · ${wb.flowers} ${wb.flowers === 1 ? 'flor' : 'flores'}${prize}` : '') + (w.goalDay ? '' : ' · día libre');
    return `<span class="pot${w.k === s.today ? ' today' : ''}${w.goalDay ? '' : ' free'}" title="${esc(tip)}">${plantSvg(w.m / s.goal, 30, wb)}<span>${DOW_LETTER[dowOf(w.k)]}</span></span>`;
  }).join('');
  const aria = 'Semana: ' + s.week.map(w => `${DOW_SHORT[dowOf(w.k)]} ${w.m >= 1 ? fmtMin(w.m) : 'nada'}${w.bonus.flowers ? `, ${w.bonus.flowers} ${w.bonus.flowers === 1 ? 'flor' : 'flores'}` : ''}${w.goalDay ? '' : ' (libre)'}`).join('; ');

  const cls = ' live' + (kind === 'bloom' ? ' pre-bloom' : kind === 'gold' ? ' pre-gold' : kind === 'fly' ? ' pre-fly' : '');
  return `<div class="daily-head"><span class="eyebrow">Meta del día</span><span class="daily-cfg">${fmtMin(s.goal)} · ${esc(daysLabel(s.weekdays))}</span></div>
    <div class="daily-main">
      <div class="daily-plant">${plantSvg(s.done / s.goal, 104, { cls, extra: b.extra, gold: b.gold, butterfly: b.butterfly, hideExtra })}</div>
      <div class="daily-text"><p class="daily-done${b.level ? ' met' : ''}${b.level >= 2 ? ' gold' : ''}">${main}</p>${next ? `<p class="muted">${next}</p>` : ''}${streak ? `<p class="muted">${streak}</p>` : ''}${counters ? `<p class="muted">${counters}</p>` : ''}</div>
    </div>
    <div class="daily-week" role="img" aria-label="${esc(aria)}">${pots}</div>`;
}

/**
 * Dibuja la planta (también cada 30 s con el cronómetro en marcha). Celebra cada premio una vez por día
 * y hace aparecer cada flor extra nueva. Tras guardar una sesión la tarjeta se redibuja varias veces
 * seguidas (sesión, historial): los efectos esperan a que pase esa ráfaga, si no se cortarían al instante.
 */
let effectTimer = null, pendingPop = -1, lastFlowers = { day: null, n: 0 };
function renderDaily() {
  const el = document.getElementById('daily'), d = S.st.items;
  if (!el || !d) return;
  const s = dailyState(d);
  el.hidden = !s;
  if (!s) return;
  const kind = pendingKind(s);
  if (!kind && lastFlowers.day === s.today && s.bonus.flowers > lastFlowers.n && s.bonus.extra > 0) pendingPop = s.bonus.extra - 1;
  if (kind || lastFlowers.day !== s.today || s.bonus.flowers < lastFlowers.n) pendingPop = -1;
  lastFlowers = { day: s.today, n: s.bonus.flowers };
  el.innerHTML = dailyHtml(s, kind, pendingPop);
  if (kind || pendingPop >= 0) {
    clearTimeout(effectTimer);
    effectTimer = setTimeout(runDailyEffects, 800);
  }
}

function runDailyEffects() {
  const d = S.st.items, s = d && dailyState(d);
  const wrap = document.querySelector('#daily .daily-plant'), plant = wrap && wrap.querySelector('.plant');
  if (!s || !plant) return;
  const kind = pendingKind(s);
  if (kind) {
    if (kind === 'record') saveFlag(RECORD_KEY, s.today);
    else {
      saveFlag(BLOOM_KEY, `${s.today}|${s.bonus.level}`);
      if (s.garden && s.garden.newRecord) saveFlag(RECORD_KEY, s.today); // el récord ya se festeja con el premio
    }
    plant.classList.remove('pre-bloom', 'pre-gold', 'pre-fly');
    plant.classList.add('celebrate-' + kind);
    const burst = document.createElement('span');
    burst.className = 'burst' + (kind === 'gold' ? ' gold' : '');
    burst.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 10; i++) burst.appendChild(document.createElement('i'));
    wrap.appendChild(burst);
  } else if (pendingPop >= 0) {
    const f = plant.querySelector(`.pl-extra[data-i="${pendingPop}"]`);
    if (f) { f.classList.remove('pre-pop'); f.classList.add('pop'); }
  }
  pendingPop = -1;
}

function renderStudyMore(d) {
  const opts = d.courses.map(c => `<option>${esc(c.name)}</option>`).join('') + '<option>General</option>';
  const manual = `<form class="sform" data-study-form="manual"><h3>Agregar sesión</h3>
    <label>Curso<select name="course">${opts}</select></label>
    <label>Duración<span class="row"><input name="h" type="number" min="0" max="12" value="1" inputmode="numeric" aria-label="Horas"> h <input name="m" type="number" min="0" max="59" step="5" value="0" inputmode="numeric" aria-label="Minutos"> min</span></label>
    <label>Día<input name="date" type="date" value="${d.today}" max="${d.today}"></label>
    <button type="submit">Guardar sesión</button></form>`;
  const dg = d.daily || { minutes: 0, weekdays: [1, 2, 3, 4, 5] };
  const bp = d.blocks || { on: true, from: '08:00', to: '22:00' };
  const planOn = d.plan ? d.plan.on : true, pi = S.pl.items;
  const dKey = dg.weekdays.join(',');
  const dOpts = [['1,2,3,4,5', 'Lunes a viernes'], ['1,2,3,4,5,6', 'Lunes a sábado'], ['0,1,2,3,4,5,6', 'Todos los días']];
  if (!dOpts.some(([v]) => v === dKey)) dOpts.push([dKey, daysLabel(dg.weekdays)]);
  const goals = `<form class="sform" data-study-form="goals"><h3>Metas semanales</h3>
    ${d.courses.map(c => `<label class="goal-row">${esc(c.name)}<span class="row"><input type="number" min="0" max="80" step="0.5" data-goal="${esc(c.name)}" value="${c.goalMinutes ? +(c.goalMinutes / 60).toFixed(2) : ''}" placeholder="0" aria-label="Horas por semana para ${esc(c.name)}"> h</span></label>`).join('')}
    <h3 class="sub-h">Meta diaria</h3>
    <p class="hint">Todo lo que estudies en el día, de cualquier curso. La planta florece al cumplirla; los días libres no cortan la racha. 0 = sin meta diaria.</p>
    <label class="goal-row">Horas por día<span class="row"><input type="number" name="dailyHours" min="0" max="16" step="0.5" value="${dg.minutes ? +(dg.minutes / 60).toFixed(2) : 0}" aria-label="Horas por día"> h</span></label>
    <label class="goal-row">Días que cuentan<select name="dailyDays">${dOpts.map(([v, l]) => `<option value="${v}"${v === dKey ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <h3 class="sub-h">Bloques sugeridos</h3>
    <p class="hint">En la Agenda, huecos libres entre tus eventos para lo que te falta estudiar hoy (primero el curso con la evaluación más cercana).</p>
    <label class="check-row"><input type="checkbox" name="blocksOn"${bp.on ? ' checked' : ''}> Mostrar en la Agenda</label>
    <label class="goal-row">Desde<input type="time" name="blocksFrom" value="${esc(bp.from)}" step="300"></label>
    <label class="goal-row">Hasta<input type="time" name="blocksTo" value="${esc(bp.to)}" step="300"></label>
    <h3 class="sub-h">Plan de la mañana</h3>
    <p class="hint">De lunes a viernes a las 6:30, Claude reparte lo que te falta estudiar hoy en esos huecos, con una tarea concreta por bloque. Llega como «☀️ Plan de hoy» en TickTick (con aviso) y aparece en la Agenda.</p>
    <label class="check-row"><input type="checkbox" name="planOn"${planOn ? ' checked' : ''}> Armar el plan cada mañana</label>
    ${pi ? `<p class="hint">${esc(planSettingsHint(pi))}${pi.configured ? ' ' + `<button type="button" class="linkish" data-plan-run${planBusy ? ' disabled' : ''}>Pedir plan ahora</button>` : ''}</p>` : ''}
    <button type="submit">Guardar metas</button></form>`;
  const list = d.sessions.length
    ? '<ul class="sessions">' + d.sessions.map(x => {
      const key = x.type + '/' + x.id;
      const src = x.source === 'pizarra' ? (x.label === 'manual' ? 'a mano' : 'Bitácora') : 'TickTick · ' + x.label;
      return `<li><span class="s-main">${esc(x.course || 'Otros')} · ${fmtMin(x.minutes)}</span><span class="s-sub">${esc(cap(fDayShort.format(new Date(x.start))))} · ${fTime.format(new Date(x.start))} · ${esc(src)}</span><button type="button" data-study-del="${esc(key)}" class="${studyArmed === key ? 'armed' : ''}">${studyArmed === key ? '¿Borrar?' : 'Borrar'}</button></li>`;
    }).join('') + '</ul>'
    : '<p class="hint">Aún no hay sesiones esta semana.</p>';
  const claude = d.note ? claudeForm(d.note) : '';
  const opt = d.courseOptions || [];
  const courses = `<form class="sform" data-study-form="courses"><h3>Cursos</h3>
    <p class="hint">Salen de las columnas de tu inbox de TickTick. Desmarca los que no quieras ver (p. ej. de otro ciclo).</p>
    ${opt.map(o => `<label class="check-row"><input type="checkbox" ${o.source === 'extra' ? 'data-course-extra' : 'data-course-col'}="${esc(o.name)}"${o.visible ? ' checked' : ''}> ${esc(o.name)}${o.source === 'extra' ? ' <span class="muted">· agregado</span>' : ''}</label>`).join('')}
    <label>Agregar curso<input name="newCourse" maxlength="40" placeholder="Ej.: Inglés" autocomplete="off"></label>
    <button type="submit">Guardar cursos</button></form>`;
  return manual + goals + claude + courses + `<div><h3>Sesiones de la semana</h3>${list}</div>`;
}

/* ---------- resumen para Claude (nota en TickTick que la Bitácora reescribe sola) ---------- */
const CLAUDE_MEMORY_LINE = 'Recuerda: para cualquier tema de mis estudios (horas, metas, evaluaciones, notas), primero lee en TickTick la nota «📒 Bitácora — resumen para Claude» de la lista «Bitácora». La actualiza sola mi app Bitácora.';
let claudePreviewOpen = false;

function claudeForm(n) {
  return `<form class="sform claude-form" data-study-form="claude"><h3>Resumen para Claude</h3>
    <p class="hint">La Bitácora mantiene en TickTick la nota <b>${esc(n.title)}</b> (lista «${esc(n.list)}») con tus horas por curso y por día, metas, próximas evaluaciones, notas y este contexto. Los chats de Claude la leen con el conector de TickTick.</p>
    <label>Contexto para Claude<textarea name="context" rows="4" maxlength="1500" placeholder="Ej.: Esta semana priorizo EPP por la PC3 del jueves 22; la PC2 de Aplicada recién es el 07/11.">${esc(n.context)}</textarea></label>
    <button type="submit">Guardar contexto</button>
    <div id="claude-status" class="claude-status">${claudeStatus(n)}</div>
    ${n.content ? `<details class="claude-preview"${claudePreviewOpen ? ' open' : ''}><summary>Ver lo que lee Claude</summary><pre>${esc(n.content)}</pre></details>` : ''}
    <p class="hint">Para que Claude la use, díselo una vez en un chat: <q>${esc(CLAUDE_MEMORY_LINE)}</q> <button type="button" class="linkish" data-copy="${esc(CLAUDE_MEMORY_LINE)}">Copiar</button></p>
  </form>`;
}

/** Cuándo se escribió la nota, enlace y errores. Se redibuja siempre (no depende de si editas el contexto). */
function claudeStatus(n) {
  const at = t => `${cap(fDayShort.format(new Date(t)))} · ${fTime.format(new Date(t))}`;
  const open = !n.url ? '' : DESKTOP_TT
    ? ` · <a href="${esc('ticktick://v1/search?keyword=' + encodeURIComponent('resumen para Claude'))}" data-web="${esc(n.url)}" title="Buscar en la app de TickTick (Shift + clic: versión web)">Abrir en TickTick ↗</a>`
    : ` · <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">Abrir en TickTick ↗</a>`;
  let h = `<p class="hint">${n.writtenAt ? `Nota escrita: <b>${esc(at(n.writtenAt))}</b>` : 'La nota aún no existe en TickTick.'}`
    + (n.checkedAt && n.writtenAt && n.checkedAt > n.writtenAt ? ` · revisada ${esc(fTime.format(new Date(n.checkedAt)))}, sin cambios` : '')
    + `${open} · <button type="button" class="linkish" data-claude-sync${studyBusy ? ' disabled' : ''}>${n.writtenAt ? 'Actualizar ahora' : 'Crear la nota'}</button></p>`;
  if (n.error) h += `<p class="msg bad">No se pudo actualizar la nota: ${esc(n.error)}</p>`;
  return h;
}
document.addEventListener('toggle', ev => {
  if (ev.target.classList && ev.target.classList.contains('claude-preview')) claudePreviewOpen = ev.target.open;
}, true);

function armStudy(key) {
  studyArmed = key; clearTimeout(studyArmTimer); render();
  studyArmTimer = setTimeout(() => { studyArmed = null; render(); }, 4000);
}

/** Clicks de la sección de estudio. Devuelve true si los manejó. */
function studyClick(ev) {
  if (ev.target.closest('[data-claude-sync]')) {
    document.activeElement && document.activeElement.blur();
    moreRenderedAt = null;
    studyAction('/api/claude-note/sync', 'POST', {});
    return true;
  }
  const cp = ev.target.closest('[data-copy]');
  if (cp) {
    const done = t => { cp.textContent = t; setTimeout(() => { cp.textContent = 'Copiar'; }, 2500); };
    if (navigator.clipboard) navigator.clipboard.writeText(cp.dataset.copy).then(() => done('Copiado ✓'), () => done('No se pudo copiar'));
    else done('No se pudo copiar');
    return true;
  }
  const nav = ev.target.closest('[data-days-nav]');
  if (nav) {
    const cur = S.st.items && S.st.items.weekStart;
    if (!cur) return true;
    const next = addDays(dayWeek || cur, 7 * Number(nav.dataset.daysNav));
    dayWeek = next >= cur ? null : next;
    renderStudy();
    return true;
  }
  const st = ev.target.closest('[data-study-start]');
  if (st) { studyAction('/api/study/start', 'POST', { course: st.dataset.studyStart }); return true; }
  if (ev.target.closest('[data-study-pause]')) { studyAction('/api/study/pause', 'POST', {}); return true; }
  if (ev.target.closest('[data-study-resume]')) { studyAction('/api/study/resume', 'POST', {}); return true; }
  if (ev.target.closest('[data-study-stop]')) { studyAction('/api/study/stop', 'POST', {}); return true; }
  if (ev.target.closest('[data-study-cancel]')) {
    if (studyArmed !== 'cancel') { armStudy('cancel'); return true; }
    studyArmed = null; clearTimeout(studyArmTimer);
    studyAction('/api/study/cancel', 'POST', {}).then(() => { studyMsg = { ok: true, t: 'Cronómetro descartado.' }; render(); });
    return true;
  }
  const del = ev.target.closest('[data-study-del]');
  if (del) {
    const key = del.dataset.studyDel;
    if (studyArmed !== key) { armStudy(key); return true; }
    studyArmed = null; clearTimeout(studyArmTimer);
    const [type, id] = key.split('/');
    moreRenderedAt = null;
    studyAction(`/api/study/sessions/${type}/${encodeURIComponent(id)}`, 'DELETE');
    return true;
  }
  return false;
}

document.addEventListener('submit', ev => {
  const f = ev.target.closest('[data-study-form]');
  if (!f) return;
  ev.preventDefault();
  if (f.dataset.studyForm === 'manual') {
    const minutes = (Number(f.h.value) || 0) * 60 + (Number(f.m.value) || 0);
    if (minutes < 1) { studyMsg = { ok: false, t: 'Pon una duración de al menos 1 minuto.' }; render(); return; }
    moreRenderedAt = null;
    studyAction('/api/study/manual', 'POST', { course: f.course.value, minutes, date: f.date.value });
  } else if (f.dataset.studyForm === 'claude') {
    // Sin foco dentro del panel, se redibuja al terminar (vista previa nueva).
    document.activeElement && document.activeElement.blur();
    moreRenderedAt = null;
    studyAction('/api/claude-note/context', 'PUT', { text: f.context.value });
  } else if (f.dataset.studyForm === 'cycle') {
    studyAction('/api/study/cycle', 'PUT', { start: f.start.value });
  } else if (f.dataset.studyForm === 'courses') {
    const hidden = [...f.querySelectorAll('[data-course-col]')].filter(i => !i.checked).map(i => i.dataset.courseCol);
    const extra = [...f.querySelectorAll('[data-course-extra]')].filter(i => i.checked).map(i => i.dataset.courseExtra);
    const nw = f.newCourse.value.trim();
    if (nw) extra.push(nw);
    moreRenderedAt = null;
    studyAction('/api/study/courses', 'PUT', { hidden, extra });
  } else {
    const goals = {};
    f.querySelectorAll('[data-goal]').forEach(i => { const h = Number(i.value); if (h > 0) goals[i.dataset.goal] = Math.round(h * 60); });
    const daily = { minutes: Math.round((Number(f.dailyHours.value) || 0) * 60), weekdays: f.dailyDays.value.split(',').map(Number) };
    const blocks = { on: f.blocksOn.checked, from: f.blocksFrom.value, to: f.blocksTo.value };
    const plan = { on: f.planOn.checked };
    moreRenderedAt = null;
    studyAction('/api/study/goals', 'PUT', { goals, daily, blocks, plan }).then(() => load('pl')).then(render);
  }
});
document.addEventListener('input', ev => { if (ev.target.closest('#study-more')) moreDirty = true; });

// Reloj del cronómetro: cada segundo, solo el texto.
setInterval(() => {
  const el = document.getElementById('study-clock'), a = S.st.items && S.st.items.active;
  if (el && a && !a.pausedAt) el.textContent = clock(activeElapsed(a));
  // La planta crece en vivo mientras corre el cronómetro.
  if (a && !a.pausedAt && ++dailyTick % 30 === 0) renderDaily();
}, 1000);

/* ---------- historial del ciclo ---------- */
const H = { status: 'idle', data: null, err: null };
const fWeekLbl = new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const keyUTC = k => new Date(k + 'T12:00:00Z');
const MAX_SLOTS = 8;
let histHover = null;

async function loadHistory() {
  if (H.status === 'loading') return;
  H.status = 'loading'; renderHistory();
  try {
    H.data = await api('/api/study/history');
    H.status = 'ok'; H.err = null; H.loadedAt = Date.now();
  } catch (e) {
    if (e && e.code === 'session') S.session = true;
    H.status = 'error'; H.err = e;
  }
  renderHistory();
  renderStreak();
  // El ritmo y la tabla por día también usan el historial; el radar, sus colores por curso.
  if (S.st.items) renderStudy();
  renderRadar();
}

function slotOf(h, course) {
  const i = h.courses.indexOf(course);
  return i >= 0 && i < MAX_SLOTS ? 's' + (i + 1) : 's-other';
}
function weekRangeLabel(w) {
  const a = keyUTC(w.start), b = keyUTC(w.end);
  return `${fWeekLbl.format(a)} – ${fWeekLbl.format(b)}`;
}
/** Paso "limpio" para el eje Y (en minutos), con ≤5 marcas. */
function niceStep(maxMin) {
  for (const h of [1, 2, 5, 10, 20, 50]) if (maxMin / (h * 60) <= 5) return h * 60;
  return 100 * 60;
}

function renderHistory() {
  const box = $('history');
  if (!box) return;
  if (H.status === 'loading' && !H.data) { box.innerHTML = '<div class="skel"></div>'; return; }
  if (H.status === 'error' && !H.data) { box.innerHTML = errorBox(TT, H.err); return; }
  const h = H.data;
  if (!h) { box.innerHTML = ''; return; }

  const done = h.weeks.filter(w => w.start < h.currentWeek);
  const avg = done.length ? done.reduce((a, w) => a + w.total, 0) / done.length : h.total;
  const series = h.courses.slice(0, MAX_SLOTS);
  const hasOther = h.otherTotal > 0 || h.courses.length > MAX_SLOTS;

  let out = `<div class="hist-head">
    <div class="hist-stats">
      <div class="stat"><span class="l">Total del ciclo</span><span class="v">${fmtMin(h.total)}</span></div>
      <div class="stat"><span class="l">Promedio por semana</span><span class="v">${fmtMin(avg)}</span></div>
      <div class="stat"><span class="l">Semanas</span><span class="v">${h.weeks.length}</span></div>
    </div>
    <form class="sform cycle-form" data-study-form="cycle"><label>Inicio del ciclo<span class="row"><input type="date" name="start" value="${esc(h.cycleStart)}" max="${esc(h.weeks.at(-1).end)}"><button type="submit">Guardar</button></span></label></form>
  </div>`;
  if (h.truncated) out += `<p class="hint">Se muestran las últimas ${h.weeks.length} semanas.</p>`;

  if (!h.total) {
    out += '<div class="empty">Aún no hay horas registradas en este ciclo. Usa ▶ en «Empezar a estudiar» o agrega sesiones a mano.</div>';
    box.innerHTML = out; return;
  }

  // leyenda (siempre, ≥2 series)
  out += '<div class="legend" aria-hidden="true">' + series.map(c => `<span><i class="sw ${slotOf(h, c)}"></i>${esc(c)}</span>`).join('')
    + (hasOther ? '<span><i class="sw s-other"></i>Otros</span>' : '')
    + (h.goalTotalMinutes ? `<span><i class="goal-key"></i>Meta semanal (${fmtMin(h.goalTotalMinutes)})</span>` : '') + '</div>';
  out += `<div class="chart-wrap" id="hist-chart" role="img" aria-label="Horas de estudio por semana y curso. La tabla de abajo tiene los mismos datos."></div>`;

  // totales por curso
  const maxTot = Math.max(1, ...series.map(c => h.totals[c] || 0), h.otherTotal);
  const nWeeks = Math.max(1, h.weeks.length);
  out += '<div class="hist-totals"><span class="eyebrow">Por curso en el ciclo</span>' + series.concat(hasOther ? ['__other'] : []).map(c => {
    const other = c === '__other', v = other ? h.otherTotal : (h.totals[c] || 0);
    return `<div class="ht-row"><span class="ht-name"><i class="sw ${other ? 's-other' : slotOf(h, c)}"></i>${esc(other ? 'Otros' : c)}</span>
      <svg class="ht-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="${other ? 's-other' : slotOf(h, c)}" x="0" y="0" height="8" width="${Math.max(v ? 1.5 : 0, (v / maxTot) * 100).toFixed(2)}" rx="2"/></svg>
      <span class="ht-val mono">${fmtMin(v)}<span class="muted"> · ${fmtMin(v / nWeeks)}/sem</span></span></div>`;
  }).join('') + '</div>';

  // tabla
  out += `<details class="hist-table"><summary>Ver como tabla</summary><div class="tbl-scroll"><table>
    <thead><tr><th>Semana</th>${series.map(c => `<th>${esc(c)}</th>`).join('')}${hasOther ? '<th>Otros</th>' : ''}<th>Total</th></tr></thead><tbody>`
    + h.weeks.slice().reverse().map(w => `<tr${w.start === h.currentWeek ? ' class="cur"' : ''}><td>${esc(weekRangeLabel(w))}${w.start === h.currentWeek ? ' (esta)' : ''}</td>${series.map(c => `<td class="mono">${w.byCourse[c] ? fmtMin(w.byCourse[c]) : '—'}</td>`).join('')}${hasOther ? `<td class="mono">${w.other ? fmtMin(w.other) : '—'}</td>` : ''}<td class="mono"><b>${fmtMin(w.total)}</b></td></tr>`).join('')
    + '</tbody></table></div></details>';

  box.innerHTML = out;
  drawHistoryChart();
}

function roundedTop(x, y, w, hgt, r) {
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function drawHistoryChart() {
  const wrap = document.getElementById('hist-chart'), h = H.data;
  if (!wrap || !h) return;
  const W = Math.max(280, wrap.clientWidth), Hh = 220;
  const m = { l: 40, r: 8, t: 20, b: 26 };
  const iw = W - m.l - m.r, ih = Hh - m.t - m.b;
  const n = h.weeks.length, band = iw / n, bw = Math.min(24, Math.max(6, band * 0.62));
  const maxMin = Math.max(60, ...h.weeks.map(w => w.total), h.goalTotalMinutes || 0);
  const step = niceStep(maxMin), top = Math.ceil(maxMin / step) * step;
  const y = v => m.t + ih - (v / top) * ih;
  const series = h.courses.slice(0, MAX_SLOTS);
  const labelEvery = n > 18 ? 3 : n > 10 ? 2 : 1;

  let g = '';
  for (let v = 0; v <= top; v += step) {
    g += `<line class="grid${v === 0 ? ' base' : ''}" x1="${m.l}" x2="${W - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
    g += `<text class="tick" x="${m.l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v / 60} h</text>`;
  }
  h.weeks.forEach((w, i) => {
    const cx = m.l + band * i + band / 2, x = cx - bw / 2;
    const segs = series.map(c => [slotOf(h, c), w.byCourse[c] || 0]).filter(s => s[1] > 0);
    const otherMin = w.other + h.courses.slice(MAX_SLOTS).reduce((a, c) => a + (w.byCourse[c] || 0), 0);
    if (otherMin > 0) segs.push(['s-other', otherMin]);
    let acc = 0;
    g += `<g class="col${histHover === i ? ' on' : ''}${histHover !== null && histHover !== i ? ' dim' : ''}">`;
    segs.forEach(([cls, v], k) => {
      const y0 = y(acc), y1 = y(acc + v), isTop = k === segs.length - 1;
      const hgt = Math.max(0, y0 - y1 - (isTop || y0 - y1 < 3 ? 0 : 2));
      g += isTop ? `<path class="${cls}" d="${roundedTop(x, y1, bw, hgt, 4)}"/>` : `<rect class="${cls}" x="${x.toFixed(1)}" y="${(y0 - hgt).toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}"/>`;
      acc += v;
    });
    g += '</g>';
    // Etiqueta cada labelEvery semanas, y siempre la última; se omite la que quedaría pegada a la última.
    if ((i % labelEvery === 0 && n - 1 - i >= labelEvery) || i === n - 1) {
      const cur = w.start === h.currentWeek;
      g += `<text class="xl${cur ? ' cur' : ''}" x="${cx.toFixed(1)}" y="${Hh - 8}" text-anchor="middle">${cur ? 'Esta' : esc(fWeekLbl.format(keyUTC(w.start)))}</text>`;
    }
    g += `<rect class="hit" data-i="${i}" x="${(m.l + band * i).toFixed(1)}" y="${m.t}" width="${band.toFixed(1)}" height="${ih}"/>`;
  });
  if (h.goalTotalMinutes) {
    const gy = y(h.goalTotalMinutes).toFixed(1);
    g += `<line class="goal" x1="${m.l}" x2="${W - m.r}" y1="${gy}" y2="${gy}"/><text class="goal-lbl" x="${W - m.r}" y="${(+gy - 5).toFixed(1)}" text-anchor="end">Meta ${fmtMin(h.goalTotalMinutes)}</text>`;
  }
  wrap.innerHTML = `<svg width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}">${g}</svg><div class="tip" id="hist-tip" hidden></div>`;
  if (histHover !== null) showTip(histHover);
}

function showTip(i) {
  const h = H.data, tip = document.getElementById('hist-tip'), wrap = document.getElementById('hist-chart');
  if (!h || !tip || !wrap) return;
  const w = h.weeks[i];
  const rows = h.courses.slice(0, MAX_SLOTS).filter(c => w.byCourse[c]).map(c => `<div class="tr"><i class="sw ${slotOf(h, c)}"></i><span>${esc(c)}</span><b class="mono">${fmtMin(w.byCourse[c])}</b></div>`);
  const otherMin = w.other + h.courses.slice(MAX_SLOTS).reduce((a, c) => a + (w.byCourse[c] || 0), 0);
  if (otherMin) rows.push(`<div class="tr"><i class="sw s-other"></i><span>Otros</span><b class="mono">${fmtMin(otherMin)}</b></div>`);
  tip.innerHTML = `<div class="th">${esc(weekRangeLabel(w))}${w.start === h.currentWeek ? ' · esta semana' : ''}</div>`
    + (rows.length ? rows.join('') : '<div class="muted">Sin horas</div>')
    + `<div class="tt"><span>Total</span><b class="mono">${fmtMin(w.total)}</b></div>`
    + (h.goalTotalMinutes ? `<div class="muted">Meta ${fmtMin(h.goalTotalMinutes)}</div>` : '');
  tip.hidden = false;
  const hit = wrap.querySelector(`.hit[data-i="${i}"]`);
  const bx = hit.getBBox(), tw = tip.offsetWidth, W = wrap.clientWidth;
  let left = bx.x + bx.width / 2 + 12;
  if (left + tw > W) left = bx.x + bx.width / 2 - tw - 12;
  tip.style.left = Math.max(0, left) + 'px';
  tip.style.top = '8px';
}

function setHover(i) {
  if (histHover === i) return;
  histHover = i;
  drawHistoryChart();
  if (i === null) { const t = document.getElementById('hist-tip'); if (t) t.hidden = true; }
}

document.addEventListener('pointermove', ev => {
  const hit = ev.target.closest && ev.target.closest('#hist-chart .hit');
  if (hit) setHover(Number(hit.dataset.i));
  else if (histHover !== null && !(ev.target.closest && ev.target.closest('#hist-chart'))) setHover(null);
});
document.addEventListener('pointerleave', () => setHover(null));
document.getElementById('history-wrap').addEventListener('toggle', ev => {
  if (ev.target.open && H.status !== 'loading' && !H.data) loadHistory();
  else if (ev.target.open) drawHistoryChart();
});
if (window.ResizeObserver) {
  let t = null;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(drawHistoryChart, 120); }).observe(document.getElementById('history'));
}

/* ---------- notas ---------- */
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmtN = (n, d = 1) => (n === null || n === undefined ? '—' : Number(n).toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1'));
let gEditing = null, gRenderedAt = null, gSettingsRenderedAt = null, gMsg = null, gBusy = false, gSettingsDirty = false;

function needText(n, what) {
  if (!n) return '';
  if (n.status === 'done') return `${what}: logrado ✓`;
  if (n.status === 'secured') return `${what}: asegurado aunque saques 0 en lo que falta ✓`;
  if (n.status === 'impossible') return `${what}: ya no alcanza aunque saques 20 en lo que falta`;
  return `${what}: necesitas <b>${fmtN(n.average)}</b> de promedio en lo que falta`;
}

/** Barra 0–20: rango posible (lo asegurado → lo máximo alcanzable), marca del 11, meta y posición actual.
 *  Las posiciones van en data-l / data-w y se aplican por CSSOM (la CSP no permite style="" en el HTML). */
function meterHtml(c) {
  const pct = v => (Math.max(0, Math.min(20, v)) / 20 * 100).toFixed(2);
  const cls = c.max < 10.5 ? 'bad' : c.min >= 10.5 ? 'good' : 'mid';
  const p = c.final !== null ? c.earned : c.average;
  const label = c.final !== null
    ? `Nota exacta ${fmtN(c.earned, 2)}, final ${c.final}`
    : `Rango posible de ${fmtN(c.min)} a ${fmtN(c.max)}; aprobatoria 11${c.target ? '; meta ' + c.target : ''}`;
  let h = `<div class="meter" role="img" aria-label="${esc(label)}"><div class="m-track"></div>`;
  if (c.final === null) h += `<div class="m-band ${cls}" data-l="${pct(c.min)}" data-w="${Math.max(0.8, pct(c.max) - pct(c.min)).toFixed(2)}"></div>`;
  h += `<div class="m-mark pass" data-l="${pct(10.5)}"></div>`;
  if (c.target && c.target > 11) h += `<div class="m-mark goal" data-l="${pct(c.target - 0.5)}"></div>`;
  if (p !== null) h += `<div class="m-dot ${cls}" data-l="${pct(p)}"></div>`;
  h += '</div>';
  const left = c.final !== null ? `Nota exacta ${fmtN(c.earned, 2)} → ${c.final}` : `Rango posible ${fmtN(c.min)} – ${fmtN(c.max)}`;
  return h + `<div class="m-legend"><span>${left}</span><span><i class="k-pass"></i>11${c.target && c.target > 11 ? ` <i class="k-goal"></i>meta ${c.target}` : ''}</span></div>`;
}

function applyPositions(root) {
  root.querySelectorAll('[data-l]').forEach(el => { el.style.left = el.dataset.l + '%'; });
  root.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });
}

function gradeCard(c) {
  const head = `<header class="g-head"><h3>${esc(c.name)}</h3><span class="muted">${c.credits ? fmtN(c.credits) + ' cr' : 'sin créditos'}</span>${c.academic ? '' : '<span class="chip">No cuenta en el ponderado</span>'}
    <button type="button" class="g-edit" data-g-edit="${esc(c.name)}">${c.items.length ? 'Editar' : 'Agregar evaluaciones'}</button></header>`;
  if (gEditing === c.name) return `<article class="gcard editing">${head}${gradeForm(c)}</article>`;
  if (!c.items.length) return `<article class="gcard empty-card">${head}<p class="hint">Agrega las evaluaciones del sílabo con su peso; las notas las vas llenando a medida que salen.</p></article>`;

  const state = c.final !== null ? (c.final >= 11 ? 'pass' : 'fail') : c.pass.status === 'impossible' ? 'fail' : c.pass.status === 'secured' ? 'pass' : '';
  let main;
  if (c.final !== null) main = `<div class="g-main"><span class="g-big">${c.final}</span><span class="muted">Nota final · ${c.final >= 11 ? 'aprobado ✓' : 'desaprobado'}</span></div>`;
  else if (c.average !== null) main = `<div class="g-main"><span class="g-big">${fmtN(c.average)}</span><span class="muted">promedio de lo evaluado (${fmtN(c.gradedWeight)} %) · si sigues así: <b>${c.projected}</b></span></div>`;
  else main = `<div class="g-main"><span class="g-big muted">—</span><span class="muted">Aún sin notas · ${fmtN(c.totalWeight)} % por evaluar</span></div>`;

  const needs = [needText(c.pass, 'Para aprobar (11)'), c.goal ? needText(c.goal, `Para tu meta (${c.goal.target})`) : ''].filter(Boolean)
    .map(t => `<p class="g-need">${t}</p>`).join('');
  const rows = c.items.map(i => `<li><span class="gi-name">${esc(i.name)}</span><span class="gi-w mono">${fmtN(i.weight)} %</span><span class="gi-g mono${i.grade === null ? ' muted' : ''}">${i.grade === null ? '—' : fmtN(i.grade)}</span></li>`).join('');
  return `<article class="gcard ${state}">${head}${main}${meterHtml(c)}${needs}
    <ul class="g-items">${rows}</ul>${c.weightWarning ? `<p class="g-warn">⚠ ${esc(c.weightWarning)}</p>` : ''}</article>`;
}

function gradeForm(c) {
  const row = i => `<div class="g-row" data-id="${esc(i.id || '')}">
      <input class="gi-name" name="name" value="${esc(i.name || '')}" placeholder="PC1" maxlength="60" aria-label="Evaluación">
      <label class="gi-w"><input name="weight" type="number" min="0" max="100" step="any" value="${i.weight ?? ''}" aria-label="Peso en %">%</label>
      <input class="gi-g" name="grade" type="number" min="0" max="20" step="any" value="${i.grade ?? ''}" placeholder="nota" aria-label="Nota">
      <button type="button" class="gi-del" data-g-del title="Quitar evaluación" aria-label="Quitar evaluación">✕</button></div>`;
  const items = c.items.length ? c.items : [{ name: '', weight: '', grade: null }];
  return `<form class="gform" data-g-form="${esc(c.name)}">
    <div class="g-rows-head"><span>Evaluación</span><span>Peso</span><span>Nota</span><span></span></div>
    <div class="g-rows">${items.map(row).join('')}</div>
    <button type="button" class="g-add" data-g-add>+ Evaluación</button>
    <p class="g-sumw">Suma de pesos: <b data-g-sum>${fmtN(c.items.reduce((a, i) => a + i.weight, 0))}</b> %</p>
    <div class="g-actions"><button type="submit">Guardar</button><button type="button" class="ghost" data-g-cancel>Cancelar</button></div>
  </form>`;
}

function renderGrades(force = false) {
  const s = S.gr, body = $('grades-body'), d = s.items;
  if (!body) return;
  if (s.status === 'loading' && !s.at) { body.innerHTML = '<div class="skel"></div>'; return; }
  if (s.status === 'error' || !d) { body.innerHTML = errorBox(TT, s.err); $('grades-sum').textContent = ''; return; }

  const sem = d.semester;
  $('grades-sum').innerHTML = sem.semester !== null ? `Ponderado proyectado <b>${sem.semester.toFixed(2)}</b>${sem.cumulative !== null ? ` · acumulado <b>${sem.cumulative.toFixed(2)}</b>` : ''}` : '';

  // No redibujar mientras editas (ni con el refresco de cada minuto).
  if (!force && gRenderedAt === s.at && !gMsg) return;
  if (!force && gEditing && body.contains(document.activeElement)) return;
  gRenderedAt = s.at;

  let h = gMsg ? `<p class="msg ${gMsg.ok ? 'good' : 'bad'}">${esc(gMsg.t)}</p>` : '';
  const missing = sem.missing.length
    ? `<p class="hint">No entran aún al ponderado: ${sem.missing.map(m => `${esc(m.name)} (${m.reason === 'credits' ? 'faltan créditos' : 'sin notas'})`).join(', ')}.</p>` : '';
  if (sem.semester !== null || missing) {
    h += `<div class="g-stats"><div class="stat"><span class="l">Ponderado del ciclo (proyectado)</span><span class="v">${sem.semester !== null ? sem.semester.toFixed(2) : '—'}</span></div>
      <div class="stat"><span class="l">Acumulado proyectado</span><span class="v">${sem.cumulative !== null ? sem.cumulative.toFixed(2) : '—'}</span>${sem.cumulative === null ? '<span class="hint">Pon tu acumulado anterior en «Créditos, metas y acumulado anterior».</span>' : ''}</div></div>${missing}`;
  }
  h += `<div class="g-grid">${d.courses.map(gradeCard).join('')}</div>`;
  // Lo escrito en el formulario abierto (aún sin guardar) se conserva al redibujar: refresco automático o error al guardar.
  const open = gEditing ? body.querySelector('.gcard.editing form[data-g-form]') : null;
  const draft = open && open.dataset.gForm === gEditing ? open.querySelector('.g-rows') : null;
  body.innerHTML = h;
  if (draft) {
    const fresh = body.querySelector('.gcard.editing .g-rows');
    if (fresh) { fresh.replaceWith(draft); updateWeightSum(draft.closest('form')); }
  }
  applyPositions(body);

  const set = $('grades-settings');
  if (gSettingsRenderedAt !== s.at && !gSettingsDirty && !set.contains(document.activeElement)) {
    gSettingsRenderedAt = s.at;
    set.innerHTML = gradeSettings(d);
  }
}

function gradeSettings(d) {
  const rows = d.courses.map(c => `<div class="gs-row" data-course="${esc(c.name)}">
      <span class="gs-name">${esc(c.name)}</span>
      <label>Créditos<input name="credits" type="number" min="0" max="30" step="0.5" value="${c.credits ?? ''}"></label>
      <label>Meta<input name="target" type="number" min="11" max="20" step="1" value="${c.target ?? ''}" placeholder="—"></label>
      <label class="check-row"><input name="academic" type="checkbox"${c.academic ? ' checked' : ''}> Cuenta en el ponderado</label></div>`).join('');
  return `<form class="sform gs-form" data-g-settings><h3>Por curso</h3>${rows}<button type="submit">Guardar cursos</button></form>
    <form class="sform" data-g-prior><h3>Acumulado antes de este ciclo</h3>
      <p class="hint">Para proyectar tu acumulado al cerrar el ciclo. Usa los créditos académicos que cuenta tu acumulado.</p>
      <label>Acumulado<input name="average" type="number" min="0" max="20" step="0.01" value="${d.prior.average ?? ''}" placeholder="14.72"></label>
      <label>Créditos<input name="credits" type="number" min="0" max="400" step="1" value="${d.prior.credits ?? ''}" placeholder="94"></label>
      <button type="submit">Guardar acumulado</button></form>`;
}

/** kind: 'course' (formulario de notas de un curso) o 'settings' (créditos/metas/acumulado). */
async function gradesPut(path, body, okText, kind = 'course') {
  if (gBusy) return;
  gBusy = true; gMsg = null;
  try {
    const r = await api(path, { method: 'PUT', headers: { 'X-Pizarra': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    S.gr.items = r; S.gr.at = Date.now(); S.gr.status = 'ok'; S.gr.err = null;
    gMsg = { ok: true, t: okText };
    // Guardar uno de los formularios no cierra ni descarta lo que estés escribiendo en el otro.
    if (kind === 'course') gEditing = null; else gSettingsDirty = false;
    setTimeout(() => {
      gMsg = null;
      // Si mientras tanto abriste un curso para editar, no se redibuja (perderías el foco): solo se quita el aviso.
      if (gEditing) $('grades-body')?.querySelector(':scope > .msg')?.remove();
      else renderGrades(true);
    }, 4000);
  } catch (e) {
    if (e && e.code === 'session') S.session = true;
    gMsg = { ok: false, t: (e && e.message) || 'No se pudo guardar.' };
  } finally {
    gBusy = false; renderGrades(true); renderExams();
  }
}

function readGradeForm(f) {
  return [...f.querySelectorAll('.g-row')].map(r => ({
    id: r.dataset.id || undefined,
    name: r.querySelector('[name=name]').value.trim(),
    weight: r.querySelector('[name=weight]').value,
    grade: r.querySelector('[name=grade]').value,
  })).filter(i => i.name || i.weight !== '' || i.grade !== '');
}

function updateWeightSum(f) {
  const sum = [...f.querySelectorAll('[name=weight]')].reduce((a, i) => a + (Number(i.value) || 0), 0);
  const el = f.querySelector('[data-g-sum]');
  if (el) { el.textContent = fmtN(sum); el.parentElement.classList.toggle('bad', Math.abs(sum - 100) >= 0.01); }
}

function courseByName(name) { return S.gr.items && S.gr.items.courses.find(c => c.name === name); }

/** Clicks de la sección de notas. Devuelve true si los manejó. */
function gradesClick(ev) {
  const ed = ev.target.closest('[data-g-edit]');
  if (ed) { gEditing = ed.dataset.gEdit; gMsg = null; renderGrades(true); document.querySelector('.gcard.editing input')?.focus(); return true; }
  if (ev.target.closest('[data-g-cancel]')) { gEditing = null; renderGrades(true); return true; }
  if (ev.target.closest('[data-g-add]')) {
    const f = ev.target.closest('form');
    const tmp = document.createElement('div');
    tmp.innerHTML = gradeForm({ name: '', items: [{ name: '', weight: '', grade: null }] });
    f.querySelector('.g-rows').appendChild(tmp.querySelector('.g-row'));
    f.querySelector('.g-rows .g-row:last-child input')?.focus();
    return true;
  }
  const del = ev.target.closest('[data-g-del]');
  if (del) { const f = del.closest('form'); del.closest('.g-row').remove(); updateWeightSum(f); return true; }
  return false;
}

document.addEventListener('submit', ev => {
  const gf = ev.target.closest('[data-g-form]');
  if (gf) {
    ev.preventDefault();
    const c = courseByName(gf.dataset.gForm);
    if (!c) return;
    gradesPut('/api/grades/course', { name: c.name, credits: c.credits, academic: c.academic, target: c.target, items: readGradeForm(gf) }, `Notas de ${c.name} guardadas.`);
    return;
  }
  const gs = ev.target.closest('[data-g-settings]');
  if (gs) {
    ev.preventDefault();
    const rows = [...gs.querySelectorAll('.gs-row')];
    (async () => {
      for (const r of rows) {
        const c = courseByName(r.dataset.course);
        if (!c) continue;
        const credits = r.querySelector('[name=credits]').value, target = r.querySelector('[name=target]').value, academic = r.querySelector('[name=academic]').checked;
        if (String(c.credits ?? '') === credits && String(c.target ?? '') === target && c.academic === academic) continue;
        await gradesPut('/api/grades/course', { name: c.name, credits, target, academic, items: c.items }, 'Cursos guardados.', 'settings');
      }
    })();
    return;
  }
  const gp = ev.target.closest('[data-g-prior]');
  if (gp) {
    ev.preventDefault();
    gradesPut('/api/grades/prior', { average: gp.average.value, credits: gp.credits.value }, 'Acumulado guardado.', 'settings');
  }
});
document.addEventListener('input', ev => {
  const f = ev.target.closest('[data-g-form]');
  if (f && ev.target.name === 'weight') updateWeightSum(f);
  if (ev.target.closest('#grades-settings')) gSettingsDirty = true;
});

/** La evaluación del registro de notas que corresponde a una tarea (mismo curso y todas las palabras del nombre). */
function gradeMatch(x) {
  const d = S.gr.items;
  if (!d) return null;
  const c = d.courses.find(c => [evCourse(x), x.column, x.list].some(n => n && fold(n) === fold(c.name)));
  if (!c) return null;
  const words = fold(x.name).split(/[^a-z0-9ñ]+/).filter(Boolean);
  const item = c.items.find(i => {
    const iw = fold(i.name).split(/[^a-z0-9ñ]+/).filter(Boolean);
    return iw.length && iw.every(w => words.includes(w));
  });
  return item ? { c, item } : null;
}

/** Peso y nota necesaria de una evaluación próxima, si coincide con una del registro de notas. */
function gradeInfoFor(x) {
  const g = gradeMatch(x);
  if (!g) return null;
  const { c, item } = g;
  if (item.grade !== null) return `${fmtN(item.weight)} % · nota ${fmtN(item.grade)}`;
  const n = c.goal || c.pass;
  const what = c.goal ? 'meta' : 'aprobar';
  if (n.status === 'possible') return `${fmtN(item.weight)} % · necesitas ${Math.ceil(n.average - 1e-9)} para ${what}`;
  if (n.status === 'secured' || n.status === 'done') return `${fmtN(item.weight)} % · ${what} asegurado`;
  return `${fmtN(item.weight)} %`;
}

/* ---------- bloques sugeridos (en la Agenda) ----------
   Lo que falta estudiar hoy (la parte de hoy del ritmo semanal de cada curso, completada hasta la
   meta diaria) repartido en los huecos libres entre tus eventos, dentro del horario de Metas.
   Primero el curso con la evaluación más cercana (≤ 14 días); después, el que más le debe a su meta
   semanal. Si el horario de hoy ya terminó, se sugiere mañana. Lógica en pace.js. */
function suggestions() {
  const d = S.st.items, prefs = d && d.blocks;
  if (!d || !prefs || !prefs.on || !S.cal.at || S.cal.status === 'error') return null;
  const now = serverNow(), M = 60000;
  const win = k => ({ from: +new Date(`${k}T${prefs.from}:00-05:00`), to: +new Date(`${k}T${prefs.to}:00-05:00`) });
  const events = S.cal.items.filter(e => !e.allDay).map(e => ({ start: +e.start, end: +e.end }));
  const pace = studyPace(d);
  const goals = d.courses.filter(c => c.goalMinutes);
  const weekLeft = c => { if (!c || !c.goalMinutes) return 0; const cp = pace.byCourse[c.name]; return Math.max(0, c.goalMinutes - (cp ? cp.doneWeek : c.minutes)); };
  const ds = dailyState(d); // lo estudiado hoy en total (todas las materias + el cronómetro en marcha)

  const plan = (k, isToday) => {
    // Necesidad por curso: la parte de hoy (o de mañana) de la meta semanal.
    const newWeek = !isToday && d.today === d.weekEnd;
    const base = {};
    for (const c of goals) {
      const cp = pace.byCourse[c.name], p = cp && cp.plan;
      base[c.name] = newWeek ? c.goalMinutes / 7 : !p || p.met ? 0 : isToday ? p.todayLeft : p.perDayAfter;
    }
    // Evaluaciones cercanas: dan prioridad y se llevan lo que falte para la meta diaria.
    const evals = {};
    for (const x of (S.ev.items || [])) {
      if (!x.key || x.key < k || isDone(x) || evHidden.has(x.id)) continue;
      const days = Math.round((keyUTC(x.key) - keyUTC(k)) / 864e5);
      const course = d.courses.find(c => [evCourse(x), x.column, x.list].some(n => n && fold(n) === fold(c.name)));
      if (course && days <= 14 && !(course.name in evals)) evals[course.name] = { days, name: shortEval(x.name) };
    }
    const order = d.courses.map(c => c.name).sort((a, b) =>
      (evals[a] ? evals[a].days : 99) - (evals[b] ? evals[b].days : 99)
      || weekLeft(d.courses.find(c => c.name === b)) - weekLeft(d.courses.find(c => c.name === a)));
    const daily = d.daily && d.daily.minutes && d.daily.weekdays.includes(dowOf(k)) ? d.daily.minutes : 0;
    const dailyLeft = isToday ? Math.max(0, daily - (ds ? ds.done : 0)) : daily;
    const sum = Object.values(base).reduce((a, b) => a + b, 0);
    const extra = Math.max(0, dailyLeft - sum);
    const needs = order.map(name => ({ course: name, minutes: (base[name] || 0) + (name === order[0] ? extra : 0) })).filter(n => n.minutes >= 10);
    const w = win(k);
    const from = isToday ? Math.max(w.from, now + 5 * M) : w.from;
    const blocks = Pace.suggestBlocks({ slots: Pace.freeSlots({ events, from, to: w.to }), needs });
    for (const b of blocks) {
      const why = [];
      const e = evals[b.course];
      if (e) why.push(`${e.name} ${e.days === 0 ? 'hoy' : e.days === 1 ? 'mañana' : `en ${e.days} días`}`);
      const c = d.courses.find(x => x.name === b.course);
      if (c && c.goalMinutes && weekLeft(c) > 0) why.push(`faltan ${fmtMin(weekLeft(c))} esta semana`);
      if (extra > 0 && b.course === order[0] && daily) why.push(`para tus ${fmtMin(daily)} del día`);
      b.why = why.join(' · ');
    }
    return { day: k, blocks, needs: needs.length, window: w };
  };

  const today = plan(d.today, true);
  if (today.blocks.length) return today;
  // Terminado el horario de hoy, se planea mañana; si no, se avisa que no hay huecos (o nada, si no falta nada).
  if (now >= today.window.to - 30 * M) return plan(addDays(d.today, 1), false);
  return today.needs ? { ...today, note: `No quedan huecos de 30 min hoy entre ${prefs.from} y ${prefs.to}.` } : today;
}

/* ---------- plan de la mañana (Claude) ----------
   Lo arma el servidor (src/services/morningPlan.ts) a las 6:25 de lunes a viernes, o a pedido. Sus bloques
   usan los mismos huecos que los sugeridos, pero con una tarea concreta y la explicación de Claude. */

function planInfo() {
  const p = S.pl.items;
  if (!p) return null;
  return { ...p, plan: p.plan && p.plan.day === today() ? p.plan : null };
}

/** "claude-opus-5-5" → "Opus 5.5" (como en la tarea de TickTick). */
const modelName = id => id === 'simulado' ? 'simulado'
  : id.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1').replace(/^./, c => c.toUpperCase());

function planBox(pi, now) {
  const p = pi.plan;
  const btn = label => `<button type="button" class="linkish" data-plan-run${planBusy ? ' disabled' : ''}>${label}</button>`;
  let h = '';
  if (planBusy) {
    h += '<div class="plan quiet" role="status"><span class="plan-ico" aria-hidden="true">☀️</span><p>Claude está armando tu plan… <span class="muted">(unos 30 s)</span></p></div>';
  } else if (p) {
    const by = p.model === 'simulado' ? 'Plan de prueba' : 'Claude ' + modelName(p.model);
    const more = p.runs < pi.maxRuns ? ' · ' + btn('Otro plan') : '';
    const tt = pi.taskUrl ? ` · <a href="${esc(pi.taskUrl)}" target="_blank" rel="noopener noreferrer">en TickTick</a>` : '';
    h += `<div class="plan"><span class="plan-ico" aria-hidden="true">☀️</span><div class="plan-body">
      <p class="plan-sum">${esc(p.summary)}</p>
      ${p.note ? `<p class="plan-note"><b>Ojo:</b> ${esc(p.note)}</p>` : ''}
      ${p.fallback ? '<p class="plan-note">Los bloques de Claude no cabían en tus huecos: van los que calcula la app.</p>' : ''}
      <p class="plan-meta">${esc(by)} · ${fTime.format(new Date(p.generatedAt))}${more}${tt}</p>
    </div></div>`;
  } else if (pi.configured && pi.on && pi.planDay) {
    const early = fTime.format(new Date(now)) < pi.time;
    h += `<div class="plan quiet"><span class="plan-ico" aria-hidden="true">☀️</span><p>${early ? `Tu plan llega a las ${esc(pi.time)}.` : 'Sin plan de hoy.'} ${btn('Pedir plan a Claude')}</p></div>`;
  }
  // El error se muestra si es más nuevo que el plan (p. ej. falló el de hoy y el de ayer ya no cuenta).
  const err = planMsg || (pi.error && (!p || (pi.errorAt && pi.errorAt > Date.parse(p.generatedAt))) ? pi.error : null);
  if (err) h += `<p class="plan-err" role="alert">${esc(err)}</p>`;
  return h;
}

function planRow(b, canStart) {
  const mins = Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60000);
  const label = b.task ? `${b.course} · ${b.task}` : `${b.course} · ${fmtMin(mins)}`;
  const why = [b.task ? fmtMin(mins) : '', b.why].filter(Boolean).join(' · ');
  return `<li class="ev sug plan-b">
    <div class="sug-main">
      <span class="when"><b>${fTime.format(new Date(b.start))}</b><span>${fTime.format(new Date(b.end))}</span></span>
      <span class="sug-body"><span class="t"><span class="sug-tag">Plan</span>${esc(label)}</span>${why ? `<span class="sug-why">${esc(why)}</span>` : ''}</span>
      ${canStart ? `<button type="button" class="sug-go" data-study-start="${esc(b.course)}" aria-label="Empezar a estudiar ${esc(b.course)}" title="Empezar a estudiar ${esc(b.course)}">▶</button>` : ''}
    </div></li>`;
}

/** Pide un plan ahora (también para rehacerlo). Claude tarda unos segundos: se muestra el aviso mientras. */
async function runPlan() {
  if (planBusy) return;
  planBusy = true; planMsg = null; render();
  try {
    S.pl.items = await api('/api/plan', { method: 'POST', headers: { 'X-Pizarra': '1', 'Content-Type': 'application/json' }, body: '{}' });
    S.pl.status = 'ok'; S.pl.at = Date.now();
  } catch (e) {
    planMsg = e && e.code === 'session' ? 'Tu sesión expiró: recarga la página.' : (e && e.message) || 'No se pudo armar el plan.';
    load('pl').then(render);
  } finally {
    planBusy = false; render();
  }
}
document.addEventListener('click', ev => { if (ev.target.closest('[data-plan-run]')) runPlan(); });

function planSettingsHint(pi) {
  if (!pi) return '';
  if (!pi.configured) return 'Falta la clave de Claude (ANTHROPIC_API_KEY): ver «Plan de la mañana» en el README.';
  const m = pi.month || { runs: 0, cost: 0 };
  return `Con ${modelName(pi.model)}. Este mes: ${m.runs === 1 ? '1 plan' : m.runs + ' planes'} · ~US$${m.cost.toFixed(2)}.`;
}

function sugRow(b, canStart) {
  return `<li class="ev sug">
    <div class="sug-main">
      <span class="when"><b>${fTime.format(new Date(b.start))}</b><span>${fTime.format(new Date(b.end))}</span></span>
      <span class="sug-body"><span class="t"><span class="sug-tag">Sugerido</span>${esc(b.course)} · ${fmtMin(b.minutes)}</span>${b.why ? `<span class="sug-why">${esc(b.why)}</span>` : ''}</span>
      ${canStart ? `<button type="button" class="sug-go" data-study-start="${esc(b.course)}" aria-label="Empezar a estudiar ${esc(b.course)}" title="Empezar a estudiar ${esc(b.course)}">▶</button>` : ''}
    </div></li>`;
}

/* ---------- próximas semanas: radar de evaluaciones ----------
   Una fila por curso y un punto por evaluación en las próximas 6 semanas; el tamaño es su peso en la
   nota (del registro de Notas). Arriba, la carga de cada semana (barra = cantidad; texto = peso sumado):
   «nudo» con 3+ evaluaciones, o 2+ que sumen 40 %+. Colores por curso iguales a los del historial. */
const RADAR_WEEKS = 6;
let radarItems = [];
const mondayOfKey = k => addDays(k, -((dowOf(k) + 6) % 7));
// Curso de una tarea: su columna; si TickTick no la informó (o es «Not Sectioned»/«Personal»), el curso
// que nombre el título («PC3 EPP»); si no, la lista (fuera del inbox) u «Otros».
function evCourse(x) {
  if (x.column && !/^(not sectioned|personal)$/i.test(x.column.trim())) return x.column;
  return titleCourse(x.title || x.name) || (!x.projectId.startsWith('inbox') && x.list) || 'Otros';
}
function titleCourse(title) {
  const st = S.st.items, names = [...(st ? [...st.courses, ...(st.courseOptions || [])] : []), ...(S.gr.items ? S.gr.items.courses : [])].map(c => c.name);
  const words = s => fold(s).replace(/[^a-z0-9ñ]+/g, ' ').trim();
  const t = ' ' + words(title) + ' ';
  return [...new Set(names)].sort((a, b) => b.length - a.length).find(n => words(n) && t.includes(' ' + words(n) + ' ')) || null;
}
/** Versión corta de shortEval para cuando la etiqueta no cabe: «Act. 4», «Trab. grupal», «Ex. final». */
function tinyEval(name) {
  const s = shortEval(name);
  const t = s.replace(/^Actividad/i, 'Act.').replace(/^Trabajo/i, 'Trab.').replace(/^Examen/i, 'Ex.').replace(/^Presentaci[oó]n/i, 'Pres.').replace(/entrega$/i, 'entr.');
  return t !== s || s.length <= 8 ? t : s.slice(0, 7) + '…';
}
function shortEval(name) {
  const m = String(name).match(/^(PC\s?\d+|Parcial|Examen(\s+final)?|Actividad\s+\d+|Trabajo\s+(final|grupal)|Entrega|\d+\S*\s+entrega|Presentaci[oó]n)/i);
  if (!m) return name.length > 14 ? name.slice(0, 13) + '…' : name;
  return /^pc/i.test(m[0]) ? m[0].toUpperCase().replace(/\s+/g, '') : cap(m[0].toLowerCase());
}

let measureCtx = null;
function textWidth(s, font) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  if (!measureCtx) return s.length * 6.2;
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
}

function radarData() {
  if (!S.ev.items) return null;
  const t = today(), monday = mondayOfKey(t), end = addDays(monday, 7 * RADAR_WEEKS - 1);
  const items = S.ev.items
    .filter(x => x.key && x.key >= t && x.key <= end && !isDone(x) && !evHidden.has(x.id))
    .map(x => { const g = gradeMatch(x); return { x, course: evCourse(x), day: Math.round((keyUTC(x.key) - keyUTC(monday)) / 864e5), weight: g ? g.item.weight : null }; });
  const order = S.st.items ? S.st.items.courses.map(c => c.name) : [];
  const rank = c => { const i = order.indexOf(c); return c === 'Otros' ? 100 : i < 0 ? 99 : i; };
  const rows = [...new Set(items.map(i => i.course))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'es'));
  const weeks = Array.from({ length: RADAR_WEEKS }, (_, w) => {
    const its = items.filter(i => Math.floor(i.day / 7) === w);
    const load = its.reduce((a, i) => a + (i.weight || 0), 0);
    // Nudo = cosas que se juntan: 3+ evaluaciones, o 2+ que sumen 40 %+ (un solo examen pesado no es un nudo).
    return { w, start: addDays(monday, 7 * w), n: its.length, load, hot: its.length >= 3 || (its.length >= 2 && load >= 40) };
  });
  return { t, monday, items, rows, weeks, todayIdx: Math.round((keyUTC(t) - keyUTC(monday)) / 864e5) };
}

function renderRadar() {
  const box = $('radar'), sum = $('radar-sum');
  if (!box) return;
  const ev = S.ev;
  if (ev.status === 'loading' && !ev.at) { box.innerHTML = '<div class="radar-card"><div class="skel"></div></div>'; return; }
  if (ev.status === 'error') { box.innerHTML = `<div class="radar-card">${errorBox(TT, ev.err)}</div>`; sum.textContent = ''; return; }
  const r = radarData();
  if (!r) return;
  radarItems = r.items;
  const hot = r.weeks.filter(w => w.hot);
  const range = w => `${fWeekLbl.format(keyUTC(w.start))} – ${fWeekLbl.format(keyUTC(addDays(w.start, 6)))}`;
  sum.textContent = !r.items.length ? '' : `${r.items.length} ${r.items.length === 1 ? 'evaluación' : 'evaluaciones'}${hot.length ? ` · ${hot.length === 1 ? 'nudo' : 'nudos'}: ${hot.map(range).join(', ')}` : ' · sin nudos'}`;
  if (!r.items.length) {
    box.innerHTML = '<div class="radar-card"><div class="empty">Sin evaluaciones en las próximas 6 semanas. Aparecen las tareas de TickTick que empiezan con PC, Parcial, Examen, Entrega, Actividad N calificada, Trabajo final/grupal o Presentación.</div></div>';
    return;
  }

  // Geometría: columna de cursos + 42 días; en el celular, mínimo 9 px por día (se desliza).
  const avail = Math.max(280, box.clientWidth - 38);
  const L = Math.round(Math.min(160, avail * 0.28, Math.max(76, 18 + 6.6 * Math.max(...r.rows.map(c => c.length)))));
  const maxChars = Math.floor((L - 16) / 6.6);
  const px = Math.max(11, (avail - L - 10) / (RADAR_WEEKS * 7));
  const W = Math.round(L + RADAR_WEEKS * 7 * px + 10), TOP = 46, RH = 34, HT = TOP + r.rows.length * RH + 18;
  const maxN = Math.max(3, ...r.weeks.map(w => w.n)); // la barra mide cuántas evaluaciones hay (el peso va en el texto)
  const slot = c => (H.data && H.data.courses) ? slotOf(H.data, c) : 's-other';
  let g = '';
  r.weeks.forEach(w => {
    const x = L + w.w * 7 * px, ww = 7 * px;
    g += `<line class="gl" x1="${x.toFixed(1)}" y1="2" x2="${x.toFixed(1)}" y2="${HT - 16}"/>`;
    const wlabel = w.w === 0 && ww >= 90 ? 'esta semana' : fWeekLbl.format(keyUTC(w.start));
    g += `<text class="wl${w.hot ? ' hot' : ''}" x="${(x + 4).toFixed(1)}" y="12">${esc(wlabel)}${w.hot ? ' · nudo' : ''}</text>`;
    if (w.n) {
      g += `<text class="wm" x="${(x + 4).toFixed(1)}" y="25">${w.n} ev.${w.load ? ` · ${fmtN(w.load)} %` : ''}</text>`;
      g += `<rect class="wbar${w.hot ? ' hot' : ''}" x="${(x + 4).toFixed(1)}" y="31" width="${((w.n / maxN) * (ww - 8)).toFixed(1)}" height="6" rx="3"/>`;
    }
  });
  r.rows.forEach((c, i) => {
    const y = TOP + i * RH + RH / 2;
    g += `<line class="lane" x1="${L}" y1="${y}" x2="${W - 6}" y2="${y}"/>`;
    g += `<circle class="${slot(c)}" cx="5" cy="${y}" r="4"/><text class="rl" x="14" y="${y + 4}">${esc(c.length > maxChars ? c.slice(0, maxChars - 1) + '…' : c)}</text>`;
  });
  const nowX = L + r.todayIdx * px;
  g += `<line class="now" x1="${nowX.toFixed(1)}" y1="${TOP - 4}" x2="${nowX.toFixed(1)}" y2="${HT - 16}"/><text class="wm" x="${nowX.toFixed(1)}" y="${HT - 4}" text-anchor="middle">hoy</text>`;
  // Puntos (más pesados primero, para que los chicos queden encima) y sus etiquetas.
  const pts = r.items.map((it, i) => ({ ...it, i, cx: L + (it.day + 0.5) * px, cy: TOP + r.rows.indexOf(it.course) * RH + RH / 2, rad: it.weight ? Math.min(12, 3.5 + it.weight / 5) : 4.5 }));
  // Mismo curso y mismo día: uno sobre otro dentro del carril, en vez de taparse.
  const sameDay = new Map();
  pts.forEach(p => { const k = p.course + '|' + p.day; sameDay.set(k, [...(sameDay.get(k) || []), p]); });
  sameDay.forEach(ps => ps.forEach((p, k) => { p.cy += Math.max(-12, Math.min(12, (k - (ps.length - 1) / 2) * 9)); }));
  [...pts].sort((a, b) => b.rad - a.rad).forEach(p => {
    g += `<circle class="rd ${slot(p.course)}${p.weight ? '' : ' hollow'}" cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="${p.rad.toFixed(1)}"/>`;
  });
  // Etiquetas sin choques: las más pesadas (y luego las más próximas) eligen primero; cada una prueba
  // a la derecha, arriba, abajo y a la izquierda de su punto, completa o abreviada. Si no cabe, queda
  // solo el punto: el detalle sigue en el tooltip y en «Ver como lista».
  const font = '11px ' + (getComputedStyle(document.documentElement).getPropertyValue('--f-body').trim() || 'sans-serif');
  const taken = pts.map(p => ({ x1: p.cx - p.rad, x2: p.cx + p.rad, y1: p.cy - p.rad, y2: p.cy + p.rad }));
  const fits = b => b.x1 >= L + 2 && b.x2 <= W - 2 && b.y1 >= 38 && b.y2 <= HT - 14
    && !taken.some(o => b.x1 < o.x2 + 3 && b.x2 > o.x1 - 3 && b.y1 < o.y2 + 1 && b.y2 > o.y1 - 1);
  [...pts].sort((a, b) => b.rad - a.rad || a.day - b.day).forEach(p => {
    const full = shortEval(p.x.name), tiny = tinyEval(p.x.name), r0 = p.rad;
    const spots = (label) => {
      const w = textWidth(label, font) + 1;
      return [
        { label, x: p.cx + r0 + 3, y: p.cy + 4, a: 'start', b: { x1: p.cx + r0 + 3, x2: p.cx + r0 + 3 + w, y1: p.cy - 5, y2: p.cy + 6 } },
        { label, x: p.cx, y: p.cy - r0 - 4, a: 'middle', b: { x1: p.cx - w / 2, x2: p.cx + w / 2, y1: p.cy - r0 - 13, y2: p.cy - r0 - 2 } },
        { label, x: p.cx, y: p.cy + r0 + 12, a: 'middle', b: { x1: p.cx - w / 2, x2: p.cx + w / 2, y1: p.cy + r0 + 3, y2: p.cy + r0 + 14 } },
        { label, x: p.cx - r0 - 3, y: p.cy + 4, a: 'end', b: { x1: p.cx - r0 - 3 - w, x2: p.cx - r0 - 3, y1: p.cy - 5, y2: p.cy + 6 } },
      ];
    };
    const a = spots(full), b = tiny === full ? [] : spots(tiny);
    const spot = a.flatMap((s, k) => [s, b[k]]).find(s => s && fits(s.b));
    if (!spot) return;
    taken.push(spot.b);
    g += `<text class="ml" x="${spot.x.toFixed(1)}" y="${spot.y.toFixed(1)}" text-anchor="${spot.a}">${esc(spot.label)}</text>`;
  });
  pts.forEach(p => {
    g += `<circle class="rh" cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="${Math.max(p.rad + 4, 11).toFixed(1)}" data-i="${p.i}"/>`;
  });
  const aria = `Próximas ${RADAR_WEEKS} semanas: ${r.items.length} evaluaciones en ${r.rows.length} cursos`
    + (hot.length ? `; semanas más cargadas: ${hot.map(w => `${range(w)} (${w.n} evaluaciones)`).join(', ')}` : '') + '. La lista de abajo tiene el detalle.';

  const list = r.weeks.filter(w => w.n).map(w => `<li><b>${esc(range(w))}</b>${w.hot ? ' <span class="hot">· nudo</span>' : ''} <span class="muted">· ${w.n} ev.${w.load ? ` · ${fmtN(w.load)} %` : ''}</span><ul>`
    + r.items.filter(i => Math.floor(i.day / 7) === w.w).map(i => `<li>${esc(cap(fDayShort.format(i.x.due ? new Date(i.x.due) : keyUTC(i.x.key))))} · ${esc(i.x.name)} <span class="muted">· ${esc(i.course)}${i.weight ? ` · ${fmtN(i.weight)} %` : ''}</span></li>`).join('') + '</ul></li>').join('');

  box.innerHTML = `<div class="radar-card">
    <div class="radar-plot" id="radar-plot"><svg width="${W}" height="${HT}" viewBox="0 0 ${W} ${HT}" role="img" aria-label="${esc(aria)}">${g}</svg><div class="tip" id="radar-tip" hidden></div></div>
    <p class="hint">El tamaño del punto es el peso en tu nota (registro de Notas); los huecos, evaluaciones sin peso registrado. Nudo: 3+ evaluaciones en la semana, o 2+ que sumen 40 %+.</p>
    <details class="radar-list"><summary>Ver como lista</summary><ul>${list}</ul></details>
  </div>`;
}

function showRadarTip(el) {
  const tip = document.getElementById('radar-tip'), plot = document.getElementById('radar-plot');
  if (!tip || !plot) return;
  const it = el && radarItems[Number(el.dataset.i)];
  if (!it) { tip.hidden = true; return; }
  const x = it.x, gi = gradeInfoFor(x);
  const d = Math.round((keyUTC(x.key) - keyUTC(today())) / 864e5);
  const when = cap(fDay.format(x.due ? new Date(x.due) : keyUTC(x.key))) + (x.allDay || !x.due ? '' : ' · ' + fTime.format(new Date(x.due)));
  tip.innerHTML = `<b>${esc(x.name)}</b><span>${esc(it.course)} · ${esc(when)}</span><span>${d === 0 ? 'hoy' : d === 1 ? 'mañana' : `en ${d} días`}</span>`
    + `<span class="muted">${gi ? esc(gi) : 'Peso sin registrar: agrégalo en Notas'}</span>`;
  tip.hidden = false;
  const r = el.getBoundingClientRect(), pr = plot.getBoundingClientRect();
  let left = r.left - pr.left + plot.scrollLeft + r.width / 2 - tip.offsetWidth / 2;
  left = Math.max(plot.scrollLeft, Math.min(left, plot.scrollLeft + plot.clientWidth - tip.offsetWidth));
  tip.style.left = left + 'px';
  tip.style.top = Math.max(0, r.top - pr.top - tip.offsetHeight - 6) + 'px';
}
document.addEventListener('pointermove', ev => {
  const c = ev.target.closest && ev.target.closest('#radar-plot .rh');
  if (c) showRadarTip(c);
  else if (!(ev.target.closest && ev.target.closest('#radar-plot'))) showRadarTip(null);
});
document.addEventListener('click', ev => {
  const c = ev.target.closest && ev.target.closest('#radar-plot .rh');
  if (c) showRadarTip(c);
});
if (window.ResizeObserver) {
  let t3 = null, lastW3 = 0;
  new ResizeObserver(es => { const w = Math.round(es[0].contentRect.width); if (w === lastW3) return; lastW3 = w; clearTimeout(t3); t3 = setTimeout(renderRadar, 120); }).observe(document.getElementById('radar'));
}
// La sección recuerda si la dejaste abierta o cerrada (en este dispositivo).
(() => {
  const wrap = document.getElementById('radar-wrap');
  if (!wrap) return;
  try { if (localStorage.getItem('bitacora:radar') === '0') wrap.open = false; } catch (_) { /* sin almacenamiento */ }
  wrap.addEventListener('toggle', () => {
    try { localStorage.setItem('bitacora:radar', wrap.open ? '1' : '0'); } catch (_) { /* sin almacenamiento */ }
    if (wrap.open) renderRadar();
  });
})();

/* ---------- constancia (mapa de días) ---------- */
const fDayTip = new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const fMonShort = new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', month: 'short' });
const HEAT_BINS = [1, 30, 60, 120, 180]; // minutos, sin meta diaria: cada umbral abre un nivel (1–5)
/** Con meta diaria, los niveles van por cuartos de la meta (4 h → 1, 2, 3 y 4 h): el color pleno es la meta cumplida. */
function heatBins(goal) { return goal ? [1, goal / 4, goal / 2, (3 * goal) / 4, goal] : HEAT_BINS; }
const heatLevel = (m, bins) => { let l = 0; bins.forEach((b, i) => { if (m >= b) l = i + 1; }); return l; };
const dailyGoalMin = () => (S.st.items && S.st.items.daily && S.st.items.daily.minutes) || 0;
let heatGoal = null; // meta con la que se dibujó el mapa (si cambia, se redibuja)

/** Flor de "meta cumplida" dentro de un cuadrito (no tapa el puntero: la ayuda sigue funcionando). */
function heatFlower(cx, cy, size) {
  const r = size * 0.17;
  let g = '<g class="hf">';
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
    g += `<circle class="hf-petal" cx="${(cx + r * Math.cos(a)).toFixed(1)}" cy="${(cy + r * Math.sin(a)).toFixed(1)}" r="${(r * 0.62).toFixed(1)}"/>`;
  }
  return g + `<circle class="hf-core" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 0.5).toFixed(1)}"/></g>`;
}

function renderStreak() {
  const el = $('streak');
  if (!el) return;
  const h = H.data;
  if (!h || !h.streak) { el.innerHTML = H.status === 'loading' ? '<div class="skel"></div>' : ''; return; }
  const s = h.streak, goal = dailyGoalMin(), bins = heatBins(goal);
  heatGoal = goal;
  const start = h.cycleStart > h.from ? h.cycleStart : h.from;
  const goalDays = goal ? Object.entries(h.days).filter(([k, m]) => k >= start && k <= h.today && m >= goal).length : 0;
  const keep = !s.todayDone && s.current > 0 ? '<span class="st-keep">Estudia hoy para mantenerla</span>' : '';
  let out = `<div class="st-head"><span class="eyebrow">Constancia</span>
    <div class="st-stats">
      <div class="stat"><span class="v">${s.current}</span><span class="l">${s.current === 1 ? 'día' : 'días'} de racha${s.todayDone ? ' · hoy ✓' : ''}</span>${keep}</div>
      <div class="stat"><span class="v">${s.best}</span><span class="l">mejor racha</span></div>
      <div class="stat"><span class="v">${s.activeDays}<small>/${s.totalDays}</small></span><span class="l">días con estudio</span></div>
      ${goal ? `<div class="stat"><span class="v">${goalDays}</span><span class="l">${goalDays === 1 ? 'día' : 'días'} con ${fmtMin(goal)}</span></div>` : ''}
    </div></div>`;
  out += `<div class="heat-wrap" id="heat-wrap">${heatSvg(h, el.clientWidth - 36, bins, goal, goalDays)}<div class="tip" id="heat-tip" hidden></div></div>`;
  const ticks = bins.map((b, i) => fmtMin(b) + (i === bins.length - 1 ? '+' : '')).join(', ');
  out += `<div class="heat-legend" aria-hidden="true"><span>Menos</span>${[1, 2, 3, 4, 5].map(l => `<i class="hl${l}"></i>`).join('')}<span>Más</span><span class="muted">· ${ticks}</span>`
    + (goal ? `<span class="hf-key"><svg class="heat" width="13" height="13" viewBox="0 0 13 13"><rect class="hl5" width="13" height="13" rx="2"/>${heatFlower(6.5, 6.5, 13)}</svg>meta cumplida</span>` : '') + '</div>';
  el.innerHTML = out;
}

function heatSvg(h, avail, bins = HEAT_BINS, goal = 0, goalDays = 0) {
  const gap = 3, left = 18, top = 16, n = h.weeks.length;
  // Cuadritos que llenan el ancho disponible (entre 12 y 22 px); en el celular, el SVG escala hacia abajo.
  const cell = Math.max(12, Math.min(22, Math.floor(((avail || 0) - left) / n) - gap));
  const step = cell + gap, W = left + n * step, Hh = top + 7 * step;
  const start = h.cycleStart > h.from ? h.cycleStart : h.from;
  let g = '';
  ['L', '', 'X', '', 'V', '', ''].forEach((t, r) => { if (t) g += `<text class="hx" x="0" y="${top + r * step + cell / 2 + 4}">${t}</text>`; });
  let lastMonth = '';
  h.weeks.forEach((w, c) => {
    const x = left + c * step;
    // Etiqueta de mes en la primera columna y en la semana donde empieza un mes nuevo.
    const monthOf = k => fMonShort.format(keyUTC(k)).replace('.', '').toLocaleLowerCase('es');
    const firstIdx = [0, 1, 2, 3, 4, 5, 6].find(r => addDays(w.start, r).endsWith('-01'));
    const lbl = c === 0 ? monthOf(w.start) : firstIdx !== undefined ? monthOf(addDays(w.start, firstIdx)) : null;
    if (lbl && lbl !== lastMonth) { g += `<text class="hx" x="${x}" y="10">${esc(lbl)}</text>`; lastMonth = lbl; }
    for (let r = 0; r < 7; r++) {
      const k = addDays(w.start, r);
      if (k > h.today || k < start) continue;
      const m = h.days[k] || 0;
      g += `<rect class="hc hl${heatLevel(m, bins)}${k === h.today ? ' today' : ''}" x="${x}" y="${top + r * step}" width="${cell}" height="${cell}" rx="${cell > 16 ? 3 : 2}" data-k="${k}" data-m="${m}"/>`;
      if (goal && m >= goal) g += heatFlower(x + cell / 2, top + r * step + cell / 2, cell);
    }
  });
  const label = `Mapa de constancia: ${h.streak.activeDays} de ${h.streak.totalDays} días con estudio`
    + (goal ? `; ${goalDays} ${goalDays === 1 ? 'día' : 'días'} con la meta de ${fmtMin(goal)}` : '');
  return `<svg class="heat" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(label)}">${g}</svg>`;
}

function showHeatTip(cellEl) {
  const tip = document.getElementById('heat-tip'), wrap = document.getElementById('heat-wrap');
  if (!tip || !wrap) return;
  if (!cellEl) { tip.hidden = true; return; }
  const k = cellEl.dataset.k, m = Number(cellEl.dataset.m);
  const daily = S.st.items && S.st.items.daily, goal = daily && daily.minutes;
  let note = '';
  if (goal) {
    const free = !daily.weekdays.includes(dowOf(k)), b = Pace.bonus(m, goal);
    if (m >= goal) note = `Meta de ${fmtMin(goal)} cumplida ✓${b.flowers > 1 ? ` · ${b.flowers} flores` : ''}${free ? ' (día libre)' : ''}`;
    else if (free) note = 'Día libre';
    else note = `${k === H.data.today ? 'Faltan' : 'Faltaron'} ${fmtMin(goal - m)} para la meta`;
  }
  tip.innerHTML = `<b>${esc(cap(fDayTip.format(keyUTC(k))))}</b><span>${m ? fmtMin(m) + ' de estudio' : 'Sin estudio'}</span>${note ? `<span class="tip-goal">${esc(note)}</span>` : ''}`;
  tip.hidden = false;
  const r = cellEl.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  let leftPx = r.left - wr.left + r.width / 2 - tip.offsetWidth / 2;
  leftPx = Math.max(0, Math.min(leftPx, wrap.clientWidth - tip.offsetWidth));
  tip.style.left = leftPx + 'px';
  tip.style.top = (r.top - wr.top - tip.offsetHeight - 6) + 'px';
}
if (window.ResizeObserver) {
  let t2 = null, lastW = 0;
  new ResizeObserver(es => { const w = Math.round(es[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t2); t2 = setTimeout(renderStreak, 120); }).observe(document.getElementById('streak'));
}
document.addEventListener('pointermove', ev => {
  const c = ev.target.closest && ev.target.closest('#heat-wrap .hc');
  if (c) showHeatTip(c);
  else if (!(ev.target.closest && ev.target.closest('#heat-wrap'))) showHeatTip(null);
});
document.addEventListener('click', ev => {
  const web = ev.target.closest('a[data-web]');
  if (web && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    window.open(web.dataset.web, '_blank', 'noopener');
  }
});
document.addEventListener('click', ev => {
  const c = ev.target.closest('#heat-wrap .hc');
  if (c) showHeatTip(c); else if (!ev.target.closest('#heat-wrap')) showHeatTip(null);
});

/* ---------- colores de calendario ---------- */
// La CSP no permite style="" en el HTML: el color va en data-color y se aplica por CSSOM.
const HEX = /^#[0-9a-f]{6}$/i;
function colorAttr(e) { return e && e.color && HEX.test(e.color) ? ` data-color="${e.color}"` : ''; }
function applyColors() {
  document.querySelectorAll('[data-color]').forEach(el => {
    const c = el.getAttribute('data-color');
    if (HEX.test(c)) { el.style.setProperty('--ev', c); el.classList.add('has-color'); }
  });
}

function render() {
  renderDate(); renderBanner(); renderHero(); renderCounts(); renderExams(); renderStudy(); renderGrades(); renderRadar(); renderCal(); renderTT();
  applyColors();
  setFresh($('fresh-cal'), freshText(S.cal));
  setFresh($('fresh-tt'), freshText(S.tt, S.ev));
  const gs = $('global-status');
  if (S.refreshing) gs.textContent = 'Actualizando…';
  else { const f = freshText(S.cal, S.tt); gs.textContent = f.txt ? 'Cada 5 min · ' + f.txt.toLowerCase() : 'Sin datos'; gs.classList.toggle('stale', f.stale); }
  $('refresh-btn').disabled = S.refreshing;
}

/* ---------- eventos ---------- */
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-done]');
  if (b) {
    const id = b.dataset.done;
    if (armed !== id) {
      armed = id; clearTimeout(armTimer); render();
      document.querySelector(`[data-done="${CSS.escape(id)}"]`)?.focus();
      armTimer = setTimeout(() => { armed = null; render(); }, 4000);
      return;
    }
    armed = null; clearTimeout(armTimer); completeTask(id, b.dataset.project); return;
  }
  const r = ev.target.closest('[data-ev]');
  if (r) {
    const id = r.dataset.ev;
    evOpen.set(id, r.getAttribute('aria-expanded') !== 'true');
    render();
    document.querySelector(`[data-ev="${CSS.escape(id)}"]`)?.focus();
    return;
  }
  if (ev.target.closest('[data-toggle-past]')) {
    showPast = !showPast; render();
    document.querySelector('[data-toggle-past]')?.focus();
    return;
  }
  if (studyClick(ev)) return;
  if (gradesClick(ev)) return;
  const ex = ev.target.closest('[data-eval-ignore]');
  if (ex) {
    const id = ex.dataset.evalIgnore;
    if (evArmed !== id) {
      evArmed = id; clearTimeout(evArmTimer); render();
      evArmTimer = setTimeout(() => { evArmed = null; render(); }, 4000);
      return;
    }
    evArmed = null; clearTimeout(evArmTimer);
    evHidden.add(id); render();
    api('/api/evaluations/ignore', { method: 'POST', headers: { 'X-Pizarra': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: id }) })
      .then(() => load('ev')).catch(() => { evHidden.delete(id); }).finally(() => { evHidden.delete(id); render(); });
    return;
  }
  if (ev.target.closest('[data-eval-restore]')) {
    api('/api/evaluations/restore', { method: 'POST', headers: { 'X-Pizarra': '1' } })
      .then(() => { evHidden.clear(); return load('ev'); }).finally(render);
    return;
  }
  const hit = ev.target.closest('#hist-chart .hit');
  if (hit) { setHover(histHover === Number(hit.dataset.i) ? null : Number(hit.dataset.i)); return; }
  if (histHover !== null && !ev.target.closest('#hist-chart')) setHover(null);
  if (ev.target.closest('[data-reload]')) location.reload();
});
$('refresh-btn').addEventListener('click', refreshAll);

// Cada 5 min; al volver a la pestaña (o desbloquear el celular) si pasó ese tiempo; y al cambiar de día.
setInterval(refreshAll, REFRESH);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastRefresh > REFRESH) refreshAll();
});
setInterval(() => {
  if (loadedDay && today() !== loadedDay) { evOpen.clear(); showPast = false; refreshAll(); }
  else render();
}, 60000);

// Aviso tras conectar una cuenta por OAuth (/?connected=google|ticktick).
const params = new URLSearchParams(location.search);
const connected = params.get('connected');
if (connected && SERVER[connected]) {
  flash = `${SERVER[connected]} conectado.`;
  history.replaceState(null, '', location.pathname);
  setTimeout(() => { flash = null; render(); }, 6000);
}

render();
refreshAll();
})();
