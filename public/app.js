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
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store', ...opts });
  } catch (_) {
    throw { code: 'network' };
  }
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
  refreshing: false,
  session: false,
};
let loadedDay = null, lastRefresh = 0, armed = null, armTimer = null, flash = null;
const done = new Set(), pending = new Map(), notes = new Map();

const SOURCES = {
  cal: { path: '/api/calendar', pick: b => b.events.map(toEvent) },
  tt: { path: '/api/tasks', pick: b => b.tasks.map(toTask) },
  ev: { path: '/api/evaluations', pick: b => b.evaluations.map(toTask) },
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
    ? `<div class="more">${e.desc ? `<p class="d">${esc(e.desc)}</p>` : ''}${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Abrir en Google Calendar ↗</a>` : ''}</div>`
    : '';
  return `<li class="ev${isNow ? ' now' : ''}${past && !isNow ? ' past' : ''}${open ? ' open' : ''}">
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
        ? `<a class="chip" href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Todo el día · ${esc(e.title)}</a>`
        : `<span class="chip">Todo el día · ${esc(e.title)}</span>`).join('') + '</div>';
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
      <h2 class="hero-title">${esc(cur.title)}</h2>${cur.desc ? `<p class="hero-desc">${esc(cur.desc)}</p>` : ''}
      <progress max="100" value="${pct}" aria-label="Avance del evento: ${pct} %"></progress>
      <div class="hero-count"><span class="big">${rel(cur.end - now)}</span><span class="muted">para terminar</span></div>`;
  } else if (nxt) {
    h += `<div class="hero-top"><span class="pill">Siguiente</span><span class="hero-when">${esc(whenLabel(nxt.start))}</span></div>
      <h2 class="hero-title">${esc(nxt.title)}</h2>${nxt.desc ? `<p class="hero-desc">${esc(nxt.desc)}</p>` : ''}
      <div class="hero-count"><span class="big">en ${rel(nxt.start - now)}</span></div>`;
  } else {
    h += '<div class="hero-top"><span class="pill">Agenda</span></div><p class="msg-empty">Nada más agendado esta semana.</p>';
  }
  if (allDayToday.length) h += '<div class="hero-allday">' + allDayToday.map(e => `<span>Todo el día · ${esc(e.title)}</span>`).join('') + '</div>';
  if (main) {
    const later = s.items.filter(e => !e.allDay && e !== main && e.start > now && dayKey(e.start) === t).slice(0, 4);
    if (later.length) {
      h += `<div class="later"><span class="eyebrow">${cur ? 'Después, hoy' : 'Más tarde, hoy'}</span><ul>`
        + later.map(e => `<li><span class="mono">${fTime.format(e.start)}</span><span>${esc(e.title)}</span></li>`).join('') + '</ul></div>';
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
    const list = ev.items.filter(x => x.key && x.key >= t && !done.has(x.id));
    if (!list.length) h += '<span class="muted">Nada en los próximos 70 días. Las tareas de TickTick que empiezan con PC, Parcial, Examen, Entrega o Actividad calificada aparecen aquí.</span>';
    else {
      h += '<ul class="exams">';
      for (const x of list) {
        const d = Math.round((keyDate(x.key) - keyDate(t)) / 864e5);
        const num = d === 0 ? '<b>Hoy</b>' : `<b>${d}</b><small>${d === 1 ? 'día' : 'días'}</small>`;
        const urg = d <= 3 ? ' u-crit' : d <= 7 ? ' u-warn' : '';
        const when = esc(fDay.format(x.due)) + (x.allDay ? '' : ' · ' + fTime.format(x.due));
        const lbl = taskLabel(x);
        h += `<li class="exam${urg}"><span class="days" aria-label="${d === 0 ? 'hoy' : 'en ' + d + (d === 1 ? ' día' : ' días')}">${num}</span><span class="info"><span class="nm">${esc(x.name)}</span><span class="sub">${lbl ? esc(lbl) + ' · ' : ''}${when}</span></span></li>`;
      }
      h += '</ul>';
    }
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

function render() {
  renderDate(); renderBanner(); renderHero(); renderCounts(); renderExams(); renderCal(); renderTT();
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
