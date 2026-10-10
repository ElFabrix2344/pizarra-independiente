(function () {
'use strict';
const TZ = 'America/Lima';
const REFRESH = 5 * 60 * 1000;
const CAL = 'Google Calendar', TT = 'TickTick';
const SERVER = { google: CAL, ticktick: TT };
const fKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fTime = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fDay = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' });
const fLong = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const dayKey = d => fKey.format(d);
const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10); };
const keyDate = k => new Date(k + 'T12:00:00-05:00');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const today = () => dayKey(new Date());
function dayLabel(k) { const t = today(); if (k === t) return '<span class="today">Hoy</span> · ' + esc(fDay.format(keyDate(k))); if (k === addDays(t, 1)) return 'Mañana · ' + esc(fDay.format(keyDate(k))); return esc(fDay.format(keyDate(k))); }
function rel(ms) { const m = Math.round(Math.abs(ms) / 60000); if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; if (h < 24) return h + ' h' + (r ? ' ' + r + ' min' : ''); const d = Math.round(h / 24); return d + (d === 1 ? ' día' : ' días'); }

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

function renderCal() {
  const s = S.cal, body = $('cal-body');
  if (s.status === 'loading' && !s.at) { body.innerHTML = skeleton(); return; }
  if (s.status === 'error') { body.innerHTML = errorBox(CAL, s.err); return; }
  const now = Date.now(), groups = new Map();
  for (const e of s.items) { if (!groups.has(e.key)) groups.set(e.key, []); groups.get(e.key).push(e); }
  let h = s.status === 'stale' ? errorBox(CAL, s.err) : '';
  if (!groups.size) { body.innerHTML = h + '<div class="empty">No hay eventos en los próximos 7 días.</div>'; return; }
  for (const [k, evs] of groups) {
    h += `<div class="day"><h3>${dayLabel(k)}</h3><ul class="list">`;
    for (const e of evs) {
      const isNow = !e.allDay && e.start <= now && e.end > now, past = e.end <= now;
      const when = e.allDay ? 'Todo el día' : `${fTime.format(e.start)}–${fTime.format(e.end)}`;
      h += `<li class="item${isNow ? ' now' : ''}${past && !isNow ? ' past' : ''}"><span class="when mono">${when}</span><div class="body">
        <span class="t">${esc(e.title)}</span>${isNow ? '<span class="meta"><span class="chip">En curso</span></span>' : ''}
        ${e.desc ? `<span class="d">${esc(e.desc)}</span>` : ''}
        ${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">Abrir en Calendar</a>` : ''}
      </div></li>`;
    }
    h += '</ul></div>';
  }
  body.innerHTML = h;
}

function renderTT() {
  const s = S.tt, body = $('tt-body');
  if (s.status === 'loading' && !s.at) { body.innerHTML = skeleton(); return; }
  if (s.status === 'error') { body.innerHTML = errorBox(TT, s.err); return; }
  const t = today(), items = tasksVisible();
  let h = s.status === 'stale' ? errorBox(TT, s.err) : '';
  const gone = [...notes].filter(([id, n]) => n.ok && done.has(id));
  if (gone.length) h += `<div class="msg good">${gone.length === 1 ? '1 tarea marcada' : gone.length + ' tareas marcadas'} como hecha${gone.length === 1 ? '' : 's'} en TickTick.</div>`;
  if (!items.length) { body.innerHTML = h + '<div class="empty">Nada pendiente para los próximos 7 días ni vencido.</div>'; return; }
  const groups = new Map();
  for (const x of items) { const g = !x.key ? 'sin' : x.key < t ? 'over' : x.key; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
  for (const [g, xs] of groups) {
    const label = g === 'over' ? '<span class="over">Vencidas</span>' : g === 'sin' ? 'Sin fecha' : dayLabel(g);
    h += `<div class="day"><h3>${label}</h3><ul class="list">`;
    for (const x of xs) {
      const pr = { 5: 'Alta', 3: 'Media', 1: 'Baja' }[x.priority];
      const time = x.due && !x.allDay ? fTime.format(x.due) : '';
      const over = g === 'over' && x.due ? `<span class="chip crit">Hace ${rel(Date.now() - x.due)}</span>` : '';
      const tag = taskLabel(x);
      const busy = pending.has(x.id);
      h += `<li class="item task p${x.priority}"><span class="stripe" aria-hidden="true"></span><div class="body">
        <span class="t">${esc(x.title)}</span>
        <span class="meta">${over}${tag ? `<span class="chip">${esc(tag)}</span>` : ''}${pr ? `<span>Prioridad ${pr}</span>` : ''}${time ? `<span class="mono">${time}</span>` : ''}${x.repeat ? '<span>Se repite</span>' : ''}</span>
        ${x.note ? `<span class="d">${esc(x.note)}</span>` : ''}
        <span class="actions"><button type="button" class="done${armed === x.id ? ' arm' : ''}" data-done="${esc(x.id)}" data-project="${esc(x.projectId)}"${busy ? ' disabled' : ''}>${busy ? 'Marcando…' : armed === x.id ? '¿Confirmar?' : 'Hecha'}</button><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Abrir en TickTick</a>${notes.has(x.id) ? `<span class="msg ${notes.get(x.id).ok ? 'good' : 'bad'}">${esc(notes.get(x.id).t)}</span>` : ''}</span>
      </div></li>`;
    }
    h += '</ul></div>';
  }
  body.innerHTML = h;
}

function renderTiles() {
  const now = Date.now(), t = today();
  // Ahora / siguiente
  let nh = '<span class="eyebrow">Ahora / siguiente</span>';
  if (S.cal.status === 'loading' && !S.cal.at) nh += '<span class="muted">Cargando agenda…</span>';
  else if (S.cal.status === 'error') nh += '<span class="muted">Sin datos de calendario.</span>';
  else {
    const timed = S.cal.items.filter(e => !e.allDay);
    const cur = timed.find(e => e.start <= now && e.end > now);
    const nxt = timed.find(e => e.start > now);
    if (cur) nh += `<span class="big">${esc(cur.title)}</span><span class="muted">En curso · termina a las <span class="mono">${fTime.format(cur.end)}</span> · quedan ${rel(cur.end - now)}</span>`;
    if (nxt) nh += `${cur ? '<span class="muted">Luego: ' : '<span class="big">' + esc(nxt.title) + '</span><span class="muted">'}${cur ? esc(nxt.title) + ' · ' : ''}${dayKey(nxt.start) === t ? 'hoy' : esc(fDay.format(nxt.start))} <span class="mono">${fTime.format(nxt.start)}</span> · en ${rel(nxt.start - now)}</span>`;
    if (!cur && !nxt) nh += '<span class="muted">Nada más agendado esta semana.</span>';
  }
  $('tile-next').innerHTML = nh;

  // Conteo de tareas
  const items = tasksVisible();
  const over = items.filter(x => x.key && x.key < t).length, tod = items.filter(x => x.key === t).length, wk = items.filter(x => x.key && x.key > t).length;
  let th = '<span class="eyebrow">Tareas pendientes</span>';
  if (S.tt.status === 'loading' && !S.tt.at) th += '<span class="muted">Cargando TickTick…</span>';
  else if (S.tt.status === 'error') th += '<span class="muted">Sin datos de TickTick.</span>';
  else th += `<div class="counts"><div class="count"><span class="n${over ? ' crit' : ''}">${over}</span><span class="l">vencidas</span></div><div class="count"><span class="n${tod ? ' warn' : ''}">${tod}</span><span class="l">para hoy</span></div><div class="count"><span class="n">${wk}</span><span class="l">resto de la semana</span></div></div>`;
  $('tile-tasks').innerHTML = th;

  // Evaluaciones
  let eh = '<span class="eyebrow">Próximas evaluaciones</span>';
  const ev = S.ev;
  if (ev.status === 'loading' && !ev.at) eh += '<span class="muted">Cargando…</span>';
  else if (ev.status === 'error') eh += errorBox(TT, ev.err);
  else {
    const list = ev.items.filter(x => x.key && x.key >= t && !done.has(x.id));
    if (!list.length) eh += '<span class="muted">Nada en los próximos 70 días. Las tareas de TickTick que empiezan con PC, Parcial, Examen, Entrega o Actividad calificada aparecen aquí.</span>';
    else {
      eh += '<ul class="exams">';
      for (const x of list) {
        const d = Math.round((keyDate(x.key) - keyDate(t)) / 864e5);
        const lbl = d === 0 ? 'hoy' : d === 1 ? 'mañana' : `en ${d} días`;
        const when = esc(fDay.format(x.due)) + (x.allDay ? '' : ' · ' + fTime.format(x.due));
        eh += `<li class="exam"><span class="nm">${esc(x.name)}</span><span class="dd${d <= 7 ? ' soon' : ''}">${lbl}</span><span class="sub">${taskLabel(x) ? esc(taskLabel(x)) + ' · ' : ''}${when}</span></li>`;
      }
      eh += '</ul>';
    }
    if (ev.status === 'stale') eh += '<span class="fresh stale">Sin actualizar desde ' + fTime.format(new Date(ev.at)) + '</span>';
  }
  $('tile-exams').innerHTML = eh;
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

function render() {
  $('today-label').textContent = cap(fLong.format(new Date()));
  renderBanner(); renderTiles(); renderCal(); renderTT();
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
  if (ev.target.closest('[data-reload]')) location.reload();
});
$('refresh-btn').addEventListener('click', refreshAll);

// Cada 5 min; al volver a la pestaña (o desbloquear el celular) si pasó ese tiempo; y al cambiar de día.
setInterval(refreshAll, REFRESH);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastRefresh > REFRESH) refreshAll();
});
setInterval(() => { if (loadedDay && today() !== loadedDay) refreshAll(); else render(); }, 60000);

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
