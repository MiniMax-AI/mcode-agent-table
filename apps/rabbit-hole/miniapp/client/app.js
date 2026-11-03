// Rabbit Hole Client. Everything agents write is untrusted, so it only ever reaches the DOM as text.
import { getLang, pickLang, setLang, t as tr } from './i18n.js';
import { chipLabels, seatDetail } from './seats.js';

const ICONS = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H4l2.5-3A8 8 0 1 1 21 12z"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2.2M15 9.3V6a3 3 0 0 0-5.8-1M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.4 2.3M12 18v3"/></svg>',
  hand: '<svg viewBox="0 0 24 24"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7c-2.5 0-4-1-5.5-3L3.8 15a1.6 1.6 0 0 1 2.4-2L8 15"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.3a6.5 6.5 0 0 1 3.5 5.7"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  split: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="4" width="8" height="7" rx="1.5"/><rect x="8" y="14" width="8" height="7" rx="1.5"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="11" rx="1.5"/><path d="M4 4.5h4M10 4.5h4M16 4.5h4"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="4" width="8" height="7" rx="1.5"/><rect x="3" y="13" width="8" height="7" rx="1.5"/><rect x="13" y="13" width="8" height="7" rx="1.5"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  auto: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>',
};
const MARK = '<svg viewBox="0 0 64 80" fill="none" stroke="currentColor" stroke-width="7"><rect x="13" y="4" width="12" height="36" rx="6"/><rect x="39" y="4" width="12" height="36" rx="6"/><circle cx="32" cy="52" r="23"/><circle cx="32" cy="52" r="9" fill="currentColor"/></svg>';
const QUIET = new Set(['floor_granted', 'seat_joined', 'table_opened', 'task_state']);
const STEPS = ['awaiting_approval', 'approved', 'running', 'reported', 'verified'];
const BAD = new Set(['rejected', 'failed', 'stalled']);
const PRESETS = {
  debate: { fixed: true, rounds: 2, seats: ['pro', 'con', 'judge'] },
  round: { rounds: 2, seats: ['analyst', 'skeptic', 'host'] },
  pipeline: { rounds: 1, seats: ['draft', 'review', 'final'] },
};
const kindText = (k) => { const s = tr('kind.' + k); return s === 'kind.' + k ? k : s; };

const $ = (id) => document.getElementById(id);
const S = { view: 'home', meetings: null, listError: null, tableId: null, table: null, tableError: null, mode: 'speaker', panel: 'transcript', showSystem: false, pin: null, captions: {}, colors: {}, chips: {}, models: null, fatal: false, signTask: null, signAfterLoad: null, preset: 'debate', themePref: 'system' };

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}
function icon(name) { const s = h('span', { class: 'icon', 'aria-hidden': 'true' }); s.innerHTML = ICONS[name]; return s; }
function markEl() { const m = h('span', { class: 'mark', 'aria-hidden': 'true' }); m.innerHTML = MARK; return m; }
const eq = () => h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
function chip(seat, large) {
  const name = String(seat).replace(/^owner:/, '');
  return h('span', { class: 'chip' + (large ? ' chip-lg' : ''), 'data-c': S.colors[seat] ?? S.colors[name] ?? 'x', 'aria-hidden': 'true' }, S.chips[seat] ?? S.chips[name] ?? name.slice(0, 1));
}
const tailText = (s, n) => (!s ? '' : s.length > n ? '…' + s.slice(-n) : s);
function toast(text) {
  const el = $('toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3600);
}

// ---------- data ----------
async function api(path, { method = 'GET', body } = {}) {
  let r;
  try { r = await fetch(path, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }); }
  catch { throw Object.assign(new Error(tr('net.lost')), { code: 'NETWORK' }); }
  if (r.status === 401) { S.fatal = true; render(); throw Object.assign(new Error(tr('net.restarted')), { code: 'RESTARTED' }); }
  let j = null;
  try { j = await r.json(); } catch { /* handled below */ }
  if (!r.ok) throw Object.assign(new Error(j?.error?.message ?? tr('net.failed')), { code: j?.error?.code, status: r.status });
  return j;
}
async function loadMeetings() {
  try { S.meetings = (await api('/api/tables')).meetings; S.listError = null; }
  catch (e) { if (e.code !== 'RESTARTED') S.listError = e.message; }
  render();
}
async function loadTable(id) {
  try {
    const t = await api('/api/tables/' + encodeURIComponent(id));
    if (id !== S.tableId) return;
    S.table = t; S.tableError = null;
    S.colors = Object.fromEntries(t.seats.map((s, i) => [s.seat, String(i % 8)]));
    S.chips = chipLabels(t.seats.map((s) => s.seat));
    for (const s of t.seats) {
      if (!(s.owner in S.colors)) S.colors[s.owner] = S.colors[s.seat];
      if (!(s.owner in S.chips)) S.chips[s.owner] = S.chips[s.seat];
    }
    S.captions = Object.fromEntries(t.turns.filter((x) => x.kind === 'floor').map((x) => [x.seat, x.caption]));
    if (S.signAfterLoad) {
      const x = t.tasks.find((y) => y.id === S.signAfterLoad && y.state === 'awaiting_approval');
      S.signAfterLoad = null;
      if (x) openSign(x);
    }
  } catch (e) { if (e.code !== 'RESTARTED' && id === S.tableId) S.tableError = e.status === 404 ? tr('room.notFound') : e.message; }
  render();
}
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { if (S.view === 'room' && S.tableId) loadTable(S.tableId); else loadMeetings(); }, 90);
}
function connectEvents() {
  const es = new EventSource('/api/events');
  const onTable = (ev) => { const d = JSON.parse(ev.data); if (S.view === 'home' || d.table === S.tableId) scheduleRefresh(); };
  es.addEventListener('entry', onTable);
  es.addEventListener('turn', onTable);
  es.addEventListener('tables', () => { if (S.view === 'home') scheduleRefresh(); });
  es.addEventListener('caption', (ev) => { const d = JSON.parse(ev.data); if (d.table === S.tableId) patchCaption(d.seat, d.text); });
  es.onopen = () => scheduleRefresh();
  es.onerror = () => { api('/api/tables').catch(() => {}); };
}
function patchCaption(seat, text) {
  S.captions[seat] = text;
  if (!text) return;
  for (const el of document.querySelectorAll('[data-caption-seat]')) {
    if (el.dataset.captionSeat !== seat) continue;
    const n = Number(el.dataset.captionTail);
    el.textContent = n ? tailText(text, n) : text;
    el.classList.remove('muted');
    el.scrollTop = el.scrollHeight;
  }
}

// ---------- navigation and view state ----------
function goHome() { S.view = 'home'; S.tableId = null; S.table = null; S.pin = null; history.pushState(null, '', '/meetings'); loadMeetings(); render(); }
function goTable(id) {
  S.view = 'room'; S.tableId = id; S.table = null; S.tableError = null; S.pin = null; S.captions = {};
  history.pushState(null, '', '/meetings/' + encodeURIComponent(id));
  if (window.innerWidth < 1000) S.panel = null;
  loadTable(id); render();
}
function routeFromPath() {
  const m = location.pathname.match(/^\/meetings\/([^/]+)$/);
  if (m) { S.view = 'room'; S.tableId = decodeURIComponent(m[1]); loadTable(S.tableId); }
  else { S.view = 'home'; S.tableId = null; S.table = null; loadMeetings(); }
  render();
}
function saveView() {
  try { localStorage.setItem('rabbit-hole:view', JSON.stringify({ mode: S.mode, panel: S.panel, showSystem: S.showSystem })); } catch { /* preference only */ }
}
function restoreView() {
  try { const v = JSON.parse(localStorage.getItem('rabbit-hole:view') ?? '{}'); if (v.mode) S.mode = v.mode; if ('panel' in v) S.panel = v.panel; S.showSystem = !!v.showSystem; } catch { /* preference only */ }
  if (window.innerWidth < 1000) S.panel = null;
}

// ---------- text helpers ----------
const closeText = (r) => {
  if (!r) return tr('close.ended');
  if (r.startsWith('decision')) return tr('close.decision');
  if (r.startsWith('rounds_exhausted')) return tr('close.rounds');
  if (r.startsWith('budget_exhausted')) return tr('close.budget');
  if (r.startsWith('depth_exhausted')) return tr('close.depth');
  if (r.startsWith('max_entries')) return tr('close.entries');
  if (r === 'ended by the host') return tr('close.host');
  return r;
};
const TASK_STATES = new Set(['approved', 'rejected', 'running', 'reported', 'verified', 'failed', 'stalled']);
/** Table Core writes system entries in English; the page tells them from the event data instead. */
function sysText(e) {
  const d = e.data ?? {};
  switch (e.event) {
    case 'table_opened': return tr('sys.opened');
    case 'seat_joined': return tr('sys.joined', d.seat, d.owner && d.owner !== d.seat ? d.owner : null, !!d.card?.proxy);
    case 'floor_granted': return d.holder ? tr('sys.floorTo', d.holder) : tr('sys.floorBack');
    case 'task_opened': return d.state === 'approved' ? tr('sys.taskApproved', e.task, d.executor) : tr('sys.taskWaits', e.task, d.owner);
    case 'task_state': return e.task + ' ' + (TASK_STATES.has(d.state) ? tr('sys.state.' + d.state, d.executor ?? tr('sys.executor')) : d.state);
    case 'table_closed': return tr('sys.closed', closeText(d.reason));
    case 'subtable_result': return (d.decisions ?? []).length ? tr('sys.breakoutResult', d.subtable, d.decisions.map((x) => x.body).join(tr('sep.list'))) : tr('sys.breakoutNone', d.subtable);
    case 'note': return d.subtable ? tr('sys.breakoutOpened', d.subtable) : e.body ?? '';
    default: return e.body ?? e.event ?? '';
  }
}
const seatLabel = (name) => (name === 'core' ? tr('seat.core') : name.startsWith('owner:') ? name.slice(6) : name);
function fmtClock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60); return (m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s % 60).padStart(2, '0'); }
function elapsedText(t) { return t.createdAt ? fmtClock((t.closedAt ? Date.parse(t.closedAt) : Date.now()) - t.createdAt) : '--:--'; }
function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts); const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return d.toDateString() === now.toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
const kfmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
const effectText = (f) => f.owner + ' · ' + f.resource + ' · ' + f.action + (f.args && Object.keys(f.args).length ? ' ' + JSON.stringify(f.args) : '');
function lastEntry(t, fn) { for (let i = t.entries.length - 1; i >= 0; i--) if (fn(t.entries[i])) return t.entries[i]; return null; }
const lastSpeech = (t, seat) => lastEntry(t, (e) => e.seat === seat && ['say', 'proposal', 'decision'].includes(e.kind) && e.body);
const lastSpeaker = (t) => lastEntry(t, (e) => ['say', 'proposal', 'decision'].includes(e.kind))?.seat ?? t.seats[0]?.seat ?? null;
function seatState(t, seat) {
  if (!seat.joined) return 'absent';
  const turn = t.turns.find((x) => x.seat === seat.seat);
  if (turn && turn.kind !== 'floor') return 'working';
  if (t.holder === seat.seat) return 'speaking';
  return t.status === 'closed' ? 'closed' : 'idle';
}
const roleText = (t, s) => [s.role, t.deciders.includes(s.seat) ? tr('role.decider') : null, s.owner !== s.seat ? tr('role.owner', s.owner) : null].filter(Boolean).join(' · ');
const seatSub = (t, s) => [roleText(t, s), seatDetail(s)].filter(Boolean).join(' · ');

// ---------- render ----------
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; paint(); });
}
let galleryObserver = null;
function paint() {
  const root = $('app');
  document.documentElement.dataset.view = S.view;
  const focusKey = document.activeElement?.dataset?.key;
  const scrolls = {};
  for (const el of root.querySelectorAll('[data-scroll]')) scrolls[el.dataset.scroll] = { top: el.scrollTop, left: el.scrollLeft, bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 40 };
  const view = S.view === 'room' ? roomView() : homeView();
  root.replaceChildren(...(S.fatal ? [h('div', { class: 'alert-bar', role: 'alert' }, tr('fatal.text'), h('button', { type: 'button', onclick: () => location.reload() }, tr('fatal.reload')))] : []), view);
  for (const el of root.querySelectorAll('[data-scroll]')) {
    const old = scrolls[el.dataset.scroll];
    if (el.dataset.stick === 'true' && (!old || old.bottom)) el.scrollTop = el.scrollHeight;
    else if (old) { el.scrollTop = old.top; el.scrollLeft = old.left; }
  }
  if (focusKey) root.querySelector('[data-key="' + CSS.escape(focusKey) + '"]')?.focus();
  galleryObserver?.disconnect();
  galleryObserver = null;
  const gallery = root.querySelector('.gallery');
  if (gallery) { fitGallery(gallery); galleryObserver = new ResizeObserver(() => fitGallery(gallery)); galleryObserver.observe(gallery); }
}
/** Zoom's gallery: pick the column count that makes 16:9 tiles as large as possible inside the stage. */
function fitGallery(el) {
  const n = el.children.length;
  if (!n) return;
  const gap = 10, ratio = 16 / 9, W = el.clientWidth - 6, H = el.clientHeight - 6;
  let best = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (W - gap * (cols - 1)) / cols;
    if ((w / ratio) * rows + gap * (rows - 1) > H) w = ((H - gap * (rows - 1)) / rows) * ratio;
    best = Math.max(best, w);
  }
  el.style.setProperty('--tile-w', Math.floor(Math.min(Math.max(best, 150), 720)) - 1 + 'px');
}

// ---------- meeting list ----------
function homeView() {
  const bridge = window.mcode?.miniapp?.message?.append;
  const rows = S.meetings;
  const pending = (rows ?? []).flatMap((m) => (m.pendingTasks ?? []).map((x) => ({ ...x, meeting: m })));
  let list;
  if (S.listError) list = h('div', { class: 'empty', role: 'alert' }, tr('home.loadFailed', S.listError), h('button', { class: 'btn', type: 'button', onclick: loadMeetings }, tr('retry')));
  else if (!rows) list = h('p', { class: 'empty', role: 'status' }, tr('home.loading'));
  else if (!rows.length) list = h('p', { class: 'empty' }, tr('home.empty'));
  else list = h('div', {},
    h('div', { class: 'mhead', 'aria-hidden': 'true' }, h('span', {}, tr('col.status')), h('span', {}, tr('col.topic')), h('span', { class: 'num' }, tr('col.seats')), h('span', { class: 'num' }, tr('col.entries')), h('span', { class: 'num' }, tr('col.updated'))),
    h('ul', { class: 'mlist' }, rows.map((m) => h('li', {}, h('button', { class: 'mrow', type: 'button', 'data-key': 'm-' + m.id, onclick: () => goTable(m.id) },
      h('span', { class: 'status', 'data-live': String(m.status === 'open') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), m.status === 'open' ? tr('status.live') : closeText(m.closeReason)),
      h('span', { class: 'topic' }, m.topic, m.pending ? h('span', { class: 'tag tag-sign' }, tr('tag.pending', m.pending)) : null, m.parent ? h('span', { class: 'tag tag-plain' }, tr('tag.breakout')) : null),
      h('span', { class: 'num mono c-seats' }, String(m.seats)),
      h('span', { class: 'num mono c-entries' }, String(m.seq)),
      h('span', { class: 'num mono' }, fmtWhen(m.lastTs)))))));
  return h('div', { class: 'home' },
    h('header', { class: 'home-head' },
      h('h1', { class: 'wordmark' }, markEl(), 'Rabbit Hole'),
      h('span', { class: 'spacer' }),
      themeButton(),
      bridge ? h('button', { class: 'btn', type: 'button', 'data-key': 'ask', title: tr('home.askTitle'), onclick: askAgent }, icon('chat'), tr('home.ask')) : null,
      h('button', { class: 'btn btn-primary', type: 'button', 'data-key': 'new', onclick: openNewMeeting }, icon('plus'), tr('home.new'))),
    h('main', { class: 'home-main' },
      pending.length ? h('section', { 'aria-labelledby': 'h-sign' },
        h('div', { class: 'section-head' }, h('h2', { id: 'h-sign' }, tr('sign.waiting')), h('span', { class: 'n mono' }, String(pending.length))),
        h('ul', { class: 'sign-list' }, pending.map((x) => h('li', { class: 'sign-item' },
          h('span', { class: 'id mono' }, x.id),
          h('span', { class: 'what' }, h('span', { class: 'v mono' }, x.effects.map(effectText).join(tr('sep.list'))), h('span', { class: 'from' }, x.meeting.topic)),
          h('button', { class: 'btn btn-sign', type: 'button', 'data-key': 'hs-' + x.meeting.id + '-' + x.id, onclick: () => { S.signAfterLoad = x.id; goTable(x.meeting.id); } }, tr('home.goSign')))))) : null,
      h('section', { 'aria-labelledby': 'h-list' },
        h('div', { class: 'section-head' }, h('h2', { id: 'h-list' }, tr('home.meetings')), rows?.length ? h('span', { class: 'n mono' }, String(rows.length)) : null),
        list)));
}
async function askAgent(ev) {
  const button = ev.currentTarget; button.disabled = true;
  try {
    await window.mcode.miniapp.message.append(tr('ask.prompt'));
    toast(tr('ask.done'));
  } catch (e) {
    const code = e?.message ?? '';
    toast(code === 'user_cancelled' ? tr('ask.cancelled') : code === 'result_unknown' ? tr('ask.unknown') : tr('ask.failed'));
  } finally { button.disabled = false; }
}

// ---------- room ----------
function tile(t, s, { compact } = {}) {
  const state = seatState(t, s);
  const turn = t.turns.find((x) => x.seat === s.seat);
  const liveTurn = turn?.kind === 'floor' ? turn : null;
  const live = t.holder === s.seat;
  const badges = [];
  if (t.hands.includes(s.seat)) badges.push(h('span', { class: 'badge badge-sign' }, icon('hand'), tr('tile.hand')));
  if (turn && turn.kind !== 'floor') badges.push(h('span', { class: 'badge badge-sign' }, tr(turn.kind === 'execute' ? 'tile.execute' : 'tile.verify') + (compact ? '' : ' ' + (turn.task ?? ''))));
  if (!s.joined) badges.push(h('span', { class: 'badge' }, tr('tile.absent')));
  if (s.proxy && !compact) badges.push(h('span', { class: 'badge' }, tr('tile.proxy')));
  const voice = liveTurn ? eq() : live ? h('span', { class: 'mic-on' }, icon('mic')) : h('span', { class: 'mic-off' }, icon('micOff'));
  const tag = h('span', { class: 'tile-tag' }, chip(s.seat), compact ? null : h('span', { class: 'label' }, [s.seat, seatDetail(s)].filter(Boolean).join(' · ')), voice, h('span', { class: 'sr-only' }, tr(live ? 'tile.hasFloor' : 'tile.noFloor')));
  const said = liveTurn ? tailText(S.captions[s.seat], 140) : lastSpeech(t, s.seat)?.body;
  let feed;
  if (!compact && (said || liveTurn)) {
    feed = h('span', { class: 'tile-quote' + (said ? '' : ' muted'), ...(liveTurn ? { 'data-caption-seat': s.seat, 'data-caption-tail': '140' } : {}) }, said || (liveTurn.tool ? tr('tile.tool', liveTurn.tool) : tr('tile.thinking')));
  } else {
    const sub = compact ? '' : [roleText(t, s), !s.joined ? tr('tile.notJoined') : turn ? null : tr('tile.notSpoken')].filter(Boolean).join(' · ');
    feed = [h('span', { class: 'tile-name' }, s.seat), sub ? h('span', { class: 'tile-sub' }, sub) : null];
  }
  const kids = [h('span', { class: 'tile-feed' }, feed), badges.length ? h('span', { class: 'tile-badges' }, badges) : null, tag];
  if (compact) {
    const pinned = S.pin === s.seat;
    return h('button', { class: 'tile', type: 'button', 'data-state': state, 'data-key': 'tile-' + s.seat, 'aria-pressed': String(pinned), 'aria-label': tr(pinned ? 'tile.unpin' : 'tile.pin', s.seat), title: tr(pinned ? 'tile.unpinTitle' : 'tile.pinTitle'), onclick: () => { S.pin = pinned ? null : s.seat; render(); } }, kids);
  }
  return h('article', { class: 'tile', 'data-state': state, 'aria-label': s.seat }, kids);
}
function spotlight(t) {
  const closed = t.status === 'closed';
  if (!S.pin && closed) {
    const decision = lastEntry(t, (e) => e.kind === 'decision');
    const seat = decision?.seat ?? lastSpeaker(t);
    return h('section', { class: 'spotlight', 'aria-label': tr('spot.result') },
      h('div', { class: 'spot-head' }, seat ? chip(seat, true) : null,
        h('div', { class: 'who' }, h('p', { class: 'spot-kicker' }, tr(decision ? 'spot.decision' : 'spot.ended')), h('p', { class: 'spot-name' }, decision ? seatLabel(seat) : closeText(t.closeReason))),
        h('span', { class: 'spacer' }), h('span', { class: 'spot-state mono' }, elapsedText(t))),
      h('div', { class: 'spot-text' + (decision ? ' verdict' : ' muted'), 'data-scroll': 'spot' }, decision?.body ?? tr('spot.noDecision')));
  }
  if (!S.pin && !t.holder && t.waitingFor.length) {
    return h('section', { class: 'spotlight', 'aria-label': tr('spot.waiting') },
      h('div', { class: 'spot-head' }, h('div', { class: 'who' }, h('p', { class: 'spot-kicker' }, tr('spot.waiting')), h('p', { class: 'spot-name' }, t.waitingFor.join(tr('sep.names'))))),
      h('div', { class: 'spot-text muted' }, tr('spot.waitingHint')));
  }
  const id = S.pin ?? t.holder ?? lastSpeaker(t);
  const s = t.seats.find((x) => x.seat === id);
  if (!s) return h('section', { class: 'spotlight' }, h('div', { class: 'spot-text muted' }, tr('spot.nobody')));
  const turn = t.turns.find((x) => x.seat === id && x.kind === 'floor');
  const live = t.holder === id;
  const shown = turn ? S.captions[id] : lastSpeech(t, id)?.body;
  const placeholder = turn ? (turn.tool ? tr('tile.tool', turn.tool) : tr('tile.thinking')) : live ? tr('spot.yourTurn') : tr('spot.notSpoken');
  return h('section', { class: 'spotlight', 'data-live': String(live), 'aria-label': tr('spot.current') },
    h('div', { class: 'spot-head' }, chip(id, true),
      h('div', { class: 'who' }, h('p', { class: 'spot-name' }, id), h('p', { class: 'spot-sub' }, seatSub(t, s))),
      h('span', { class: 'spacer' }),
      h('span', { class: 'spot-state' }, turn ? eq() : null, live ? tr(turn ? 'spot.speaking' : 'spot.holding') : tr(S.pin ? 'spot.pinned' : 'spot.previous'))),
    h('div', { class: 'spot-text' + (shown ? '' : ' muted'), 'data-scroll': 'spot', 'data-stick': String(!!turn), 'data-streaming': String(!!turn), ...(turn ? { 'data-caption-seat': id } : {}) }, shown || placeholder));
}
function signCard(t) {
  const pending = t.tasks.filter((x) => x.state === 'awaiting_approval');
  if (!pending.length) return null;
  const x = pending[0];
  return h('section', { class: 'sign-card', 'aria-label': tr('sign.waiting') },
    h('span', { class: 'what' }, h('span', { class: 'k' }, tr('sign.waiting') + (pending.length > 1 ? ' · ' + pending.length : '')), h('span', { class: 'v mono' }, x.id + '  ' + x.effects.map(effectText).join(tr('sep.list')))),
    h('button', { class: 'btn btn-sign', type: 'button', 'data-key': 'sign-' + x.id, onclick: () => openSign(x) }, tr('sign.review')));
}
function stage(t) {
  const kids = [signCard(t)];
  if (S.mode === 'speaker') {
    kids.push(h('section', { class: 'filmstrip', 'aria-label': tr('panel.seats'), 'data-scroll': 'film' }, t.seats.map((s) => tile(t, s, { compact: true }))), spotlight(t));
  } else {
    kids.push(h('section', { class: 'gallery', 'aria-label': tr('panel.seats'), 'data-scroll': 'gallery' }, t.seats.map((s) => tile(t, s))));
    const live = t.turns.find((x) => x.kind === 'floor');
    if (live) kids.push(h('p', { class: 'captions' }, h('b', {}, live.seat), h('span', { 'data-caption-seat': live.seat, 'data-caption-tail': '160' }, tailText(S.captions[live.seat], 160) || '…')));
  }
  return h('main', { class: 'stage' }, kids);
}
function transcript(t) {
  const shown = t.entries.filter((e) => S.showSystem || !QUIET.has(e.event));
  const live = t.turns.filter((x) => x.kind === 'floor');
  return [
    h('div', { class: 'panel-tools' }, h('span', { class: 'mono' }, tr('log.count', t.entries.length)),
      h('label', {}, h('input', { type: 'checkbox', 'data-key': 'sys', ...(S.showSystem ? { checked: true } : {}), onchange: (e) => { S.showSystem = e.target.checked; saveView(); render(); } }), tr('log.system'))),
    h('div', { class: 'log', role: 'log', 'aria-label': tr('log.aria') }, shown.map((e) => {
      if (e.kind === 'system') return h('p', { class: 'msg-sys' }, h('span', { class: 'mono seq' }, '#' + e.seq), h('span', {}, sysText(e)));
      return h('article', { class: 'msg', 'data-kind': e.kind }, chip(e.seat),
        h('div', { class: 'msg-head' }, h('b', {}, seatLabel(e.seat)), h('span', { class: 'msg-kind' }, kindText(e.kind)), e.to?.length ? h('span', {}, '→ ' + e.to.join(' ')) : null, e.task ? h('span', { class: 'mono' }, e.task) : null, h('span', { class: 'mono seq' }, '#' + e.seq)),
        e.body ? h('div', { class: 'msg-body' }, e.body + (e.truncated ? tr('log.truncated') : '')) : null,
        e.effects?.length ? h('div', { class: 'effects mono' }, e.effects.map(effectText).join('\n')) : null,
        e.result ? h('div', { class: 'msg-body' }, tr(e.result === 'pass' ? 'log.pass' : 'log.fail')) : null);
    })),
    ...live.map((x) => h('p', { class: 'typing' }, eq(), tr('log.typing', x.seat))),
  ];
}
function seatsPanel(t) {
  return t.seats.map((s) => {
    const live = t.holder === s.seat;
    const turn = t.turns.find((x) => x.seat === s.seat);
    const st = !s.joined ? tr('tile.absent') : live ? tr(turn ? 'spot.speaking' : 'spot.holding') : t.hands.includes(s.seat) ? tr('tile.hand') : tr('seat.present');
    const can = s.capabilities.map((c) => c.resource + ' · ' + c.actions.join(tr('sep.names'))).join(tr('sep.list'));
    return h('section', { class: 'seat-row', 'aria-label': s.seat }, chip(s.seat, true),
      h('div', { class: 'who' }, h('b', {}, s.seat), h('span', { class: 'sub' }, seatSub(t, s))),
      h('span', { class: 'st' + (live ? ' on' : '') }, live && turn ? eq() : null, st),
      can ? h('p', { class: 'more mono' }, tr('seat.can', can)) : null,
      s.persona ? h('details', { class: 'more' }, h('summary', {}, tr('seat.persona')), h('p', {}, s.persona)) : null);
  });
}
function breakoutsPanel(t) {
  const items = [];
  if (t.parent) items.push(h('button', { class: 'btn', type: 'button', 'data-key': 'parent', onclick: () => goTable(t.parent) }, icon('back'), tr('br.back')));
  if (!t.children.length) items.push(h('p', { class: 'note' }, tr('br.none')));
  for (const c of t.children) items.push(h('button', { class: 'child', type: 'button', 'data-key': 'child-' + c.id, onclick: () => goTable(c.id) },
    h('span', { class: 'status', 'data-live': String(c.status === 'open') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), tr(c.status === 'open' ? 'status.live' : 'close.ended')),
    h('span', { class: 't' }, c.topic),
    h('span', { class: 'd' }, c.decisions.length ? tr('br.decisions', c.decisions.join(tr('sep.list'))) : tr('br.noDecision'))));
  return items;
}
function tasksPanel(t) {
  if (!t.tasks.length) return [h('p', { class: 'note' }, tr('task.none'))];
  return t.tasks.map((x) => {
    const idx = STEPS.indexOf(x.state);
    const bad = BAD.has(x.state) ? tr('step.' + x.state) : null;
    const reached = idx >= 0 ? idx : x.receipt ? 3 : x.signature?.kind === 'approval' ? 1 : 0;
    const label = x.turn ? tr(x.turn === 'execute' ? 'task.executing' : 'task.verifying') : bad ?? (idx >= 0 ? tr('step.' + x.state) : x.state);
    const tone = bad ? ' bad' : x.state === 'verified' ? ' ok' : x.state === 'awaiting_approval' ? ' sign' : '';
    const colon = tr('sep.colon');
    return h('article', { class: 'task', 'data-state': x.state },
      h('div', { class: 'task-head' }, h('b', { class: 'mono' }, x.id), h('span', { class: 'task-state' + tone }, label)),
      h('div', { class: 'progress', role: 'img', 'aria-label': tr('task.progress', label) }, STEPS.map((_, i) => h('i', { class: bad && i === reached ? 'bad' : i < reached || (!bad && i === reached) ? 'on' : '' }))),
      h('dl', { class: 'kv' },
        h('dt', {}, tr('task.do')), h('dd', { class: 'mono' }, x.effects.map(effectText).join('\n')),
        h('dt', {}, tr('task.from')), h('dd', {}, '@' + x.proposer + (x.why ? colon + x.why : '')),
        h('dt', {}, tr('task.executor')), h('dd', {}, '@' + (x.executor ?? x.plannedExecutor ?? tr('task.unassigned'))),
        x.signature ? [h('dt', {}, tr('task.signature')), h('dd', {}, tr(x.signature.kind === 'approval' ? 'task.approvedBy' : 'task.rejectedBy', x.owner) + (x.signature.reason ? colon + x.signature.reason : ''))] : null,
        x.receipt ? [h('dt', {}, tr('task.receipt')), h('dd', {}, x.receipt.body)] : null,
        x.verify ? [h('dt', {}, tr('task.verify')), h('dd', {}, tr(x.verify.result === 'pass' ? 'task.passedBy' : 'task.failedBy', x.verify.seat) + (x.verify.body ? colon + x.verify.body : ''))] : null),
      x.state === 'awaiting_approval' ? h('button', { class: 'btn btn-sign', type: 'button', 'data-key': 'tsign-' + x.id, onclick: () => openSign(x) }, tr('sign.review')) : null);
  });
}
const PANELS = { transcript: 'list', seats: 'users', breakouts: 'split', tasks: 'pen' };
function sidePanel(t) {
  if (!S.panel) return null;
  const body = { transcript, seats: seatsPanel, breakouts: breakoutsPanel, tasks: tasksPanel }[S.panel](t);
  return h('aside', { class: 'panel', 'aria-label': tr('panel.' + S.panel) },
    h('div', { class: 'panel-tabs', role: 'tablist' },
      Object.keys(PANELS).map((k) => h('button', { class: 'tab', role: 'tab', type: 'button', 'data-key': 'tab-' + k, 'aria-selected': String(S.panel === k), onclick: () => { S.panel = k; saveView(); render(); } }, tr('panel.' + k))),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': tr('panel.close'), 'data-key': 'panel-close', onclick: () => { S.panel = null; saveView(); render(); } }, icon('close'))),
    h('div', { class: 'panel-scroll', 'data-scroll': 'panel-' + S.panel, 'data-stick': String(S.panel === 'transcript'), role: 'tabpanel' }, body));
}
function toolButton(key, count, hot) {
  const on = S.panel === key;
  const label = tr('panel.' + key);
  return h('button', { class: 'tool', type: 'button', 'data-key': 'tool-' + key, 'aria-pressed': String(on), 'aria-label': count ? tr('tool.count', label, count) : label, onclick: () => { S.panel = on ? null : key; saveView(); render(); } },
    icon(PANELS[key]), h('span', { class: 'tool-label' }, label), count ? h('span', { class: 'count' + (hot ? ' count-hot' : '') }, String(count)) : null);
}
function meter(t) {
  const p = t.budget ? Math.min(100, (t.tokens / t.budget) * 100) : 0;
  return h('span', { class: 'meter', title: tr('meter.title', t.budget ? t.budget.toLocaleString() : null) },
    h('span', { class: 'meter-bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + p.toFixed(1) + '%' })),
    h('span', { class: 'mono' }, '≈' + kfmt(t.tokens) + (t.budget ? ' / ' + kfmt(t.budget) : '')));
}
async function copyId(id) {
  try { await navigator.clipboard.writeText(id); toast(tr('copy.done')); } catch { toast(tr('copy.failed', id)); }
}
function roomShell(title, body) {
  return h('div', { class: 'room' }, h('header', { class: 'room-top' }, h('button', { class: 'icon-btn', type: 'button', 'aria-label': tr('room.back'), 'data-key': 'back', onclick: goHome }, icon('back')), h('h1', { class: 'room-title' }, title)), h('main', { class: 'stage' }, body), h('div'));
}
function roomView() {
  const t = S.table;
  if (S.tableError) return roomShell('Rabbit Hole', h('div', { class: 'empty', role: 'alert' }, tr('room.openFailed', S.tableError)));
  if (!t) return roomShell('Rabbit Hole', h('p', { class: 'loading', role: 'status' }, tr('room.entering')));
  const closed = t.status === 'closed';
  const pending = t.tasks.filter((x) => x.state === 'awaiting_approval').length;
  return h('div', { class: 'room', 'data-status': t.status },
    h('header', { class: 'room-top' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': tr('room.back'), 'data-key': 'back', onclick: goHome }, icon('back')),
      h('span', { class: 'rec', 'data-closed': String(closed), title: tr(closed ? 'room.sealed' : 'room.recording') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), closed ? tr('close.ended') : 'REC'),
      h('h1', { class: 'room-title', title: t.topic }, t.topic),
      h('span', { class: 'room-meta' },
        h('span', { class: 'mono', id: 'elapsed', title: tr('room.elapsed') }, elapsedText(t)),
        h('span', { class: 'mono seq-count', title: tr('room.entries') }, '#' + t.entries.length),
        meter(t)),
      h('div', { class: 'views', role: 'group', 'aria-label': tr('room.views') },
        [['speaker', 'speaker'], ['gallery', 'grid']].map(([k, ic]) => h('button', { type: 'button', 'data-key': 'mode-' + k, 'aria-pressed': String(S.mode === k), 'aria-label': tr('view.' + k), onclick: () => { S.mode = k; saveView(); render(); } }, icon(ic), h('span', { class: 'view-label' }, tr('view.' + k))))),
      themeButton()),
    h('div', { class: 'room-body' }, stage(t), sidePanel(t)),
    h('footer', { class: 'toolbar' },
      h('span', { class: 'left' }, h('button', { class: 'table-id mono', type: 'button', 'data-key': 'copy-id', title: tr('room.copyTitle'), onclick: () => copyId(t.id) }, icon('copy'), t.id)),
      h('div', { class: 'tools' },
        toolButton('seats', t.seats.length),
        toolButton('transcript'),
        toolButton('breakouts', t.children.length),
        toolButton('tasks', pending || t.tasks.length, pending > 0)),
      h('span', { class: 'right' }, closed ? h('button', { class: 'btn', type: 'button', 'data-key': 'leave', onclick: goHome }, tr('room.leave')) : h('button', { class: 'btn-end', type: 'button', 'data-key': 'end', onclick: () => confirmEnd(t) }, tr('room.end')))));
}

// ---------- dialogs ----------
function confirmEnd(t) {
  $('confirm-title').textContent = tr('end.title');
  $('confirm-body').textContent = tr('end.body');
  $('confirm-ok').textContent = tr('end.ok');
  $('confirm').showModal();
  $('confirm-ok').onclick = async () => {
    $('confirm').close();
    try { await api('/api/tables/' + encodeURIComponent(t.id) + '/close', { method: 'POST', body: {} }); toast(tr('end.done')); }
    catch (e) { toast(tr('end.failed', e.message)); }
    scheduleRefresh();
  };
}
$('confirm-cancel').onclick = () => $('confirm').close();
function openSign(x) {
  S.signTask = x;
  $('sign-title').textContent = tr('sign.titleFor', x.id);
  $('sign-sub').textContent = tr('sign.sub', x.plannedExecutor ?? tr('sys.executor'));
  $('sign-body').replaceChildren(
    h('dl', { class: 'kv' },
      h('dt', {}, tr('task.do')), h('dd', {}, h('div', { class: 'effects mono' }, x.effects.map(effectText).join('\n'))),
      h('dt', {}, tr('task.from')), h('dd', {}, '@' + x.proposer + (x.fromKind ? tr('paren', kindText(x.fromKind)) : '')),
      x.why ? [h('dt', {}, tr('sign.why')), h('dd', {}, x.why)] : null,
      h('dt', {}, tr('sign.signer')), h('dd', {}, x.owner),
      h('dt', {}, tr('task.executor')), h('dd', {}, '@' + (x.plannedExecutor ?? tr('task.unassigned')))),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, tr('sign.note')), h('textarea', { id: 'sign-reason', rows: 2, maxlength: 2000, placeholder: tr('sign.notePlaceholder') })),
    h('p', { id: 'sign-error', class: 'form-error', role: 'alert', hidden: true }));
  $('sign-approve').textContent = tr('sign.as', x.owner);
  $('sign').showModal();
}
async function submitSign(decision) {
  const x = S.signTask; if (!x) return;
  for (const id of ['sign-approve', 'sign-reject']) $(id).disabled = true;
  try {
    await api('/api/tables/' + encodeURIComponent(S.tableId) + '/tasks/' + encodeURIComponent(x.id) + '/decision', { method: 'POST', body: { decision, reason: $('sign-reason').value } });
    $('sign').close();
    toast(decision === 'approve' ? tr('sign.approvedToast', x.plannedExecutor ?? tr('sys.executor')) : tr('sign.rejectedToast'));
    S.panel = S.panel ?? 'tasks';
    scheduleRefresh();
  } catch (e) {
    const el = $('sign-error');
    el.textContent = e.code === 'NETWORK' ? tr('sign.netError') : tr('sign.failed', e.message);
    el.hidden = false;
    scheduleRefresh();
  } finally { for (const id of ['sign-approve', 'sign-reject']) $(id).disabled = false; }
}
$('sign-cancel').onclick = () => $('sign').close();
$('sign-approve').onclick = () => submitSign('approve');
$('sign-reject').onclick = () => submitSign('reject');
function seatEditor(name, persona, fixed, label) {
  const models = S.models ?? [];
  const row = h('section', { class: 'seat-edit', 'aria-label': label ?? tr('nm.seat') },
    label ? h('span', { class: 'seat-hint' }, label) : null,
    h('input', { type: 'text', class: 'seat-name mono', value: name, maxlength: 48, 'aria-label': label ? label + ' · ' + tr('nm.seatName') : tr('nm.seatName'), placeholder: tr('nm.seatName'), spellcheck: 'false' }),
    h('select', { class: 'seat-model', 'aria-label': tr('nm.model') }, h('option', { value: '' }, tr('nm.defaultModel')), models.map((m, i) => h('option', { value: String(i) }, m.displayName))),
    h('input', { type: 'text', class: 'seat-can mono', maxlength: 120, 'aria-label': tr('nm.can'), placeholder: tr('nm.canPlaceholder') }),
    fixed ? h('span') : h('button', { type: 'button', class: 'rm', 'aria-label': tr('nm.remove'), onclick: () => { row.remove(); updateCost(); } }, icon('close')),
    h('textarea', { class: 'seat-persona', rows: 2, maxlength: 2000, 'aria-label': tr('nm.brief'), placeholder: tr('nm.briefPlaceholder') }, persona));
  return row;
}
function applyPreset(key) {
  S.preset = key;
  const p = PRESETS[key];
  $('nm-preset').replaceChildren(...Object.keys(PRESETS).map((k) => h('button', { type: 'button', 'aria-pressed': String(k === key), onclick: () => applyPreset(k) }, tr('preset.' + k))));
  $('nm-rounds').value = p.rounds;
  $('nm-seats').replaceChildren(...p.seats.map((n) => seatEditor(n, tr('brief.' + key + '.' + n), p.fixed, p.fixed ? tr('preset.' + key + '.' + n) : undefined)));
  $('nm-add').hidden = !!p.fixed;
  updateCost();
}
function turnCount() {
  const n = $('nm-seats').children.length; const r = Number($('nm-rounds').value) || 1;
  return S.preset === 'debate' ? r * 2 + 1 : n * r;
}
function updateCost() { $('nm-cost').textContent = tr('nm.cost', turnCount()); }
async function openNewMeeting() {
  $('nm-error').hidden = true;
  if (!S.models) { try { S.models = (await api('/api/models')).models; } catch { S.models = []; } }
  applyPreset(S.preset);
  $('new-meeting').showModal();
  $('nm-topic').focus();
}
$('nm-add').onclick = () => { if ($('nm-seats').children.length < 8) { $('nm-seats').append(seatEditor('seat' + ($('nm-seats').children.length + 1), '', false)); updateCost(); } };
$('nm-rounds').oninput = updateCost;
$('nm-cancel').onclick = () => $('new-meeting').close();
$('nm-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const showError = (text) => { const el = $('nm-error'); el.textContent = text; el.hidden = false; };
  const topic = $('nm-topic').value.trim();
  if (!topic) { showError(tr('nm.needTopic')); $('nm-topic').focus(); return; }
  const seats = [];
  for (const row of $('nm-seats').children) {
    const seat = row.querySelector('.seat-name').value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(seat) || seat === 'core') { showError(tr('nm.badSeat', seat || tr('nm.emptyName'))); return; }
    if (seats.some((s) => s.seat === seat)) { showError(tr('nm.dupSeat', seat)); return; }
    const can = row.querySelector('.seat-can').value.trim();
    let capabilities = [];
    if (can) {
      const m = can.match(/^([^:\s]+):([^\s]+)$/);
      if (!m) { showError(tr('nm.badCan', seat)); return; }
      capabilities = [{ resource: m[1], actions: m[2].split(',').filter(Boolean) }];
    }
    const modelIndex = row.querySelector('.seat-model').value;
    const model = modelIndex === '' ? undefined : S.models[Number(modelIndex)];
    seats.push({ seat, persona: row.querySelector('.seat-persona').value.trim() || undefined, capabilities, ...(model ? { model: { providerId: model.providerId, modelId: model.modelId }, modelLabel: model.displayName } : {}) });
  }
  const rounds = Math.min(Math.max(Number($('nm-rounds').value) || 1, 1), 10);
  const names = seats.map((s) => s.seat);
  const body = { topic, seats };
  if (S.preset === 'debate') body.topology = { kind: 'debate', pro: names[0], con: names[1], judge: names[2], rounds };
  else if (S.preset === 'round') { body.topology = { kind: 'broadcast', order: names, rounds }; body.decision_by = [names[names.length - 1]]; }
  else body.topology = { kind: 'pipeline', stages: names, rounds };
  $('nm-submit').disabled = true;
  try {
    const { id } = await api('/api/tables', { method: 'POST', body });
    $('new-meeting').close();
    $('nm-topic').value = '';
    goTable(id);
  } catch (e) {
    if (e.code === 'NETWORK') {
      // The request may have reached the service before the connection dropped: check before retrying.
      $('new-meeting').close();
      toast(tr('nm.netError'));
      loadMeetings();
    } else showError(tr('nm.failed', e.message));
  } finally { $('nm-submit').disabled = false; }
});

// ---------- start ----------
// Language: MiniMax Code's interface language, or the browser's outside it. The static dialog text
// in index.html carries data-i18n keys and is filled in here.
function applyLanguage(tag) {
  setLang(pickLang(tag));
  document.documentElement.lang = getLang() === 'zh' ? 'zh-Hans' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = tr(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', tr(el.dataset.i18nLabel));
  render();
}
// Theme: follow MiniMax Code by default (or the OS outside it); the button can pin light or dark.
const THEMES = { system: ['auto', 'theme.system'], light: ['sun', 'theme.light'], dark: ['moon', 'theme.dark'] };
let hostTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
function applyTheme() { document.documentElement.dataset.theme = S.themePref === 'system' ? hostTheme : S.themePref; }
function followHost() {
  try { const p = localStorage.getItem('rabbit-hole:theme'); if (p in THEMES) S.themePref = p; } catch { /* preference only */ }
  applyTheme();
  applyLanguage(navigator.language);
  const host = window.mcode?.miniapp?.host;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const fromSystem = () => { hostTheme = media.matches ? 'dark' : 'light'; applyTheme(); };
  if (!host?.ui?.subscribe) { media.addEventListener('change', fromSystem); return; }
  const sub = host.ui.subscribe(({ theme, language }) => {
    hostTheme = theme; applyTheme();
    if (language && pickLang(language) !== getLang()) applyLanguage(language);
  }, { onError: fromSystem });
  addEventListener('pagehide', () => sub?.dispose?.(), { once: true });
}
function cycleTheme() {
  const order = Object.keys(THEMES);
  S.themePref = order[(order.indexOf(S.themePref) + 1) % order.length];
  try { localStorage.setItem('rabbit-hole:theme', S.themePref); } catch { /* preference only */ }
  applyTheme();
  render();
}
function themeButton() {
  const [ic, key] = THEMES[S.themePref];
  const label = tr(key);
  return h('button', { class: 'icon-btn theme-btn', type: 'button', 'data-key': 'theme', 'aria-label': tr('theme.aria', label), title: tr('theme.title', label), onclick: cycleTheme }, icon(ic));
}
followHost();
restoreView();
routeFromPath();
connectEvents();
addEventListener('popstate', routeFromPath);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveView(); else scheduleRefresh(); });
setInterval(() => { const el = $('elapsed'); if (el && S.table && S.table.status === 'open') el.textContent = elapsedText(S.table); }, 1000);
render();
