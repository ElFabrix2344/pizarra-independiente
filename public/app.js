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
  refreshing: false,
  session: false,
};
let loadedDay = null, lastRefresh = 0, armed = null, armTimer = null, flash = null;
const done = new Set(), pending = new Map(), notes = new Map();

let evIgnored = 0, evArmed = null, evArmTimer = null;
const evHidden = new Set();
const SOURCES = {
  cal: { path: '/api/calendar', pick: b => b.events.map(toEvent) },
  tt: { path: '/api/tasks', pick: b => b.tasks.map(toTask) },
  ev: { path: '/api/evaluations', pick: b => { evIgnored = b.ignoredCount || 0; return b.evaluations.map(toTask); } },
  st: { path: '/api/study', pick: b => b },
};

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
  if (S.refreshing) return;
  S.refreshing = true; render();
  loadedDay = today(); lastRefresh = Date.now();
  await Promise.all(Object.keys(SOURCES).map(n => load(n).then(render)));
  S.refreshing = false; render();
}

/* ---------- completar tareas ---------- */
async function completeTask(id, project) {
  pending.set(id, true); notes.delete(id); render();
  try {
    await api(`/api/tasks/${encodeURIComponent(project)}/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      headers: { 'X-Pizarra': '1' },
    });
    done.add(id); notes.set(id, { ok: true, t: 'Marcada como hecha' });
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

function tasksVisible() { return S.tt.items.filter(x => !done.has(x.id)); }

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

function renderCal() {
  const s = S.cal, body = $('cal-body');
  if (s.status === 'loading' && !s.at) { body.innerHTML = skeleton(); return; }
  if (s.status === 'error') { body.innerHTML = errorBox(CAL, s.err); return; }
  const now = Date.now(), t = today(), mainId = featured().main?.id, groups = new Map();
  for (const e of s.items) { if (!groups.has(e.key)) groups.set(e.key, []); groups.get(e.key).push(e); }
  let h = s.status === 'stale' ? errorBox(CAL, s.err) : '';
  if (!groups.size) { body.innerHTML = h + '<div class="empty">No hay eventos en los próximos 7 días.</div>'; return; }
  for (const [k, evs] of groups) {
    const allDay = evs.filter(e => e.allDay), timed = evs.filter(e => !e.allDay);
    const past = k === t ? timed.filter(e => e.end <= now) : [];
    const rest = timed.filter(e => !past.includes(e));
    h += `<div class="day">${dayHeader(k)}`;
    if (allDay.length) {
      h += '<div class="allday">' + allDay.map(e => e.link
        ? `<a class="chip"${colorAttr(e)} href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Todo el día · ${esc(e.title)}</a>`
        : `<span class="chip"${colorAttr(e)}>Todo el día · ${esc(e.title)}</span>`).join('') + '</div>';
    }
    if (past.length || rest.length) {
      h += '<ul class="rows">';
      if (past.length) {
        const n = past.length;
        h += `<li><button type="button" class="past-toggle" data-toggle-past aria-expanded="${showPast}">${showPast ? 'Ocultar' : 'Mostrar'} ${n === 1 ? '1 evento terminado' : n + ' eventos terminados'}</button></li>`;
        if (showPast) h += past.map(e => evRow(e, mainId, now)).join('');
      }
      h += rest.map(e => evRow(e, mainId, now)).join('');
      h += '</ul>';
    }
    h += '</div>';
  }
  body.innerHTML = h;
}

/* ---------- tareas ---------- */
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
      ${note ? `<span class="msg ${note.ok ? 'good' : 'bad'}">${esc(note.t)}</span>` : ''}
    </div>
    <a class="ext" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir en TickTick" title="Abrir en TickTick">↗</a>
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
    const list = ev.items.filter(x => x.key && x.key >= t && !done.has(x.id) && !evHidden.has(x.id));
    if (!list.length) h += '<span class="muted">Nada en los próximos 70 días. Las tareas de TickTick que empiezan con PC, Parcial, Examen, Entrega o Actividad calificada aparecen aquí.</span>';
    else {
      h += '<ul class="exams">';
      for (const x of list) {
        const d = Math.round((keyDate(x.key) - keyDate(t)) / 864e5);
        const num = d === 0 ? '<b>Hoy</b>' : `<b>${d}</b><small>${d === 1 ? 'día' : 'días'}</small>`;
        const urg = d <= 3 ? ' u-crit' : d <= 7 ? ' u-warn' : '';
        const when = esc(fDay.format(x.due)) + (x.allDay ? '' : ' · ' + fTime.format(x.due));
        const lbl = taskLabel(x);
        const armedX = evArmed === x.id;
        h += `<li class="exam${urg}"><span class="days" aria-label="${d === 0 ? 'hoy' : 'en ' + d + (d === 1 ? ' día' : ' días')}">${num}</span><span class="info"><span class="nm">${esc(x.name)}</span><span class="sub">${lbl ? esc(lbl) + ' · ' : ''}${when}</span></span><button type="button" class="ex-x${armedX ? ' armed' : ''}" data-eval-ignore="${esc(x.id)}" title="No es una evaluación: ocultar" aria-label="${armedX ? 'Confirmar: ocultar' : 'Ocultar'} ${esc(x.name)}">${armedX ? '¿Ocultar?' : '✕'}</button></li>`;
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
    else if (path.endsWith('/cycle')) studyMsg = { ok: true, t: 'Inicio del ciclo guardado.' };
    else if (method === 'DELETE') studyMsg = { ok: true, t: 'Sesión borrada.' };
    return r;
  } catch (e) {
    if (e && e.code === 'session') S.session = true;
    studyMsg = { ok: false, t: e && e.message ? e.message : 'No se pudo completar la acción.' };
  } finally {
    studyBusy = false;
    await load('st');
    render();
    if (document.getElementById('history-wrap').open) loadHistory();
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
      ${msg}</div>`;
  } else {
    t = `<div class="timer"><span class="eyebrow">Empezar a estudiar</span>
      <div class="course-btns">${d.courses.map(c => `<button type="button" data-study-start="${esc(c.name)}"${studyBusy ? ' disabled' : ''}>▶ ${esc(c.name)}</button>`).join('')}<button type="button" data-study-start="General"${studyBusy ? ' disabled' : ''}>▶ General</button></div>
      <span class="muted">El tiempo se guarda en TickTick al parar. También cuenta lo que cronometres desde la app de TickTick sobre una tarea del curso.</span>
      ${msg}</div>`;
  }

  // Metas
  let g = '<div class="goals"><span class="eyebrow">Metas de la semana</span>';
  for (const c of d.courses) {
    if (c.goalMinutes) {
      const met = c.minutes >= c.goalMinutes;
      g += `<div class="goal${met ? ' met' : ''}"><div class="g-top"><span class="g-name">${esc(c.name)}</span><span class="g-val mono">${met ? '✓ ' : ''}${fmtMin(c.minutes)} <span class="muted">/ ${fmtMin(c.goalMinutes)}</span></span></div><progress max="${c.goalMinutes}" value="${Math.min(c.minutes, c.goalMinutes)}" aria-label="${esc(c.name)}: ${fmtMin(c.minutes)} de ${fmtMin(c.goalMinutes)}"></progress></div>`;
    } else {
      g += `<div class="goal nogoal"><div class="g-top"><span class="g-name">${esc(c.name)}</span><span class="g-val mono">${fmtMin(c.minutes)} <span class="muted">· sin meta</span></span></div></div>`;
    }
  }
  if (d.otherMinutes) g += `<div class="goal nogoal"><div class="g-top"><span class="g-name">Otros / General</span><span class="g-val mono">${fmtMin(d.otherMinutes)}</span></div></div>`;
  if (!d.courses.some(c => c.goalMinutes)) g += '<p class="hint">Pon una meta semanal por curso en «metas», aquí abajo.</p>';
  g += '</div>';
  main.innerHTML = t + g;

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
}

function renderStudyMore(d) {
  const opts = d.courses.map(c => `<option>${esc(c.name)}</option>`).join('') + '<option>General</option>';
  const manual = `<form class="sform" data-study-form="manual"><h3>Agregar sesión</h3>
    <label>Curso<select name="course">${opts}</select></label>
    <label>Duración<span class="row"><input name="h" type="number" min="0" max="12" value="1" inputmode="numeric" aria-label="Horas"> h <input name="m" type="number" min="0" max="59" step="5" value="0" inputmode="numeric" aria-label="Minutos"> min</span></label>
    <label>Día<input name="date" type="date" value="${d.today}" max="${d.today}"></label>
    <button type="submit">Guardar sesión</button></form>`;
  const goals = `<form class="sform" data-study-form="goals"><h3>Metas semanales</h3>
    ${d.courses.map(c => `<label class="goal-row">${esc(c.name)}<span class="row"><input type="number" min="0" max="80" step="0.5" data-goal="${esc(c.name)}" value="${c.goalMinutes ? +(c.goalMinutes / 60).toFixed(2) : ''}" placeholder="0" aria-label="Horas por semana para ${esc(c.name)}"> h</span></label>`).join('')}
    <button type="submit">Guardar metas</button></form>`;
  const list = d.sessions.length
    ? '<ul class="sessions">' + d.sessions.map(x => {
      const key = x.type + '/' + x.id;
      const src = x.source === 'pizarra' ? (x.label === 'manual' ? 'a mano' : 'Bitácora') : 'TickTick · ' + x.label;
      return `<li><span class="s-main">${esc(x.course || 'Otros')} · ${fmtMin(x.minutes)}</span><span class="s-sub">${esc(cap(fDayShort.format(new Date(x.start))))} · ${fTime.format(new Date(x.start))} · ${esc(src)}</span><button type="button" data-study-del="${esc(key)}" class="${studyArmed === key ? 'armed' : ''}">${studyArmed === key ? '¿Borrar?' : 'Borrar'}</button></li>`;
    }).join('') + '</ul>'
    : '<p class="hint">Aún no hay sesiones esta semana.</p>';
  const opt = d.courseOptions || [];
  const courses = `<form class="sform" data-study-form="courses"><h3>Cursos</h3>
    <p class="hint">Salen de las columnas de tu inbox de TickTick. Desmarca los que no quieras ver (p. ej. de otro ciclo).</p>
    ${opt.map(o => `<label class="check-row"><input type="checkbox" ${o.source === 'extra' ? 'data-course-extra' : 'data-course-col'}="${esc(o.name)}"${o.visible ? ' checked' : ''}> ${esc(o.name)}${o.source === 'extra' ? ' <span class="muted">· agregado</span>' : ''}</label>`).join('')}
    <label>Agregar curso<input name="newCourse" maxlength="40" placeholder="Ej.: Inglés" autocomplete="off"></label>
    <button type="submit">Guardar cursos</button></form>`;
  return manual + goals + courses + `<div><h3>Sesiones de la semana</h3>${list}</div>`;
}

function armStudy(key) {
  studyArmed = key; clearTimeout(studyArmTimer); render();
  studyArmTimer = setTimeout(() => { studyArmed = null; render(); }, 4000);
}

/** Clicks de la sección de estudio. Devuelve true si los manejó. */
function studyClick(ev) {
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
    moreRenderedAt = null;
    studyAction('/api/study/goals', 'PUT', { goals });
  }
});
document.addEventListener('input', ev => { if (ev.target.closest('#study-more')) moreDirty = true; });

// Reloj del cronómetro: cada segundo, solo el texto.
setInterval(() => {
  const el = document.getElementById('study-clock'), a = S.st.items && S.st.items.active;
  if (el && a && !a.pausedAt) el.textContent = clock(activeElapsed(a));
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
    H.status = 'ok'; H.err = null;
  } catch (e) {
    if (e && e.code === 'session') S.session = true;
    H.status = 'error'; H.err = e;
  }
  renderHistory();
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
  if (ev.target.open && H.status !== 'loading') loadHistory();
});
if (window.ResizeObserver) {
  let t = null;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(drawHistoryChart, 120); }).observe(document.getElementById('history'));
}

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
  renderDate(); renderBanner(); renderHero(); renderCounts(); renderExams(); renderStudy(); renderCal(); renderTT();
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
