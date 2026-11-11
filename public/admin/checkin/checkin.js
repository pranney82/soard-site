/**
 * SOARD Check-in (/admin/checkin/): scan a box (or tap the item), print its labels, put it on the kid's shelf
 * ===========================================================================
 * Each open makeover's things to receive, from /api/kid-items-admin?checkin=1:
 * what was ordered and hasn't all come (oldest first), what isn't ordered yet,
 * what's here, and the orders the site couldn't place ("Needs a look"). Scan a
 * box photographs the label in the page and asks the site whose box it is.
 * Print saves the check-in (how many came, how many boxes), prints one label a
 * box on the Office's Zebra, gives the kid their shelf, and writes the kid's line
 * in JobTread (Received, the date, the shelf); the sheet says which of those
 * happened. A check-in made without a connection waits on this phone and is sent
 * when the connection is back (each has its own id, so it's never counted twice).
 */

import qrcode from './qr.js';

const DAY = 86400e3;
const state = { kids: [], needsLook: [], shelves: [], shipments: [], shipTaps: new Map(), printer: null, practice: true, since: null, filter: 'All', query: '', openHere: new Set(), foundBoxes: 1, mode: 'in', me: null };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const daysAgo = (at) => Math.max(0, Math.floor((Date.now() - Date.parse(at)) / DAY));
const ago = (at) => { const d = daysAgo(at); return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const shortAgo = (at) => { const d = daysAgo(at); return d === 0 ? 'Today' : `${d}d`; };
const dayOf = (at) => new Date(at || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shelfName = (s) => (!s ? '' : s === 'Floor' ? 'Floor' : `Shelf ${s}`);
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reduced() ? 0 : ms));
const newTap = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// iOS Safari shows :active only once the page listens for touches
document.addEventListener('touchstart', () => {}, { passive: true });

/** A kid's face from their kid page, round; their first letter when there's no photo yet */
const face = (kid, size) => (kid?.photo
  ? `<img class="face" src="${esc(kid.photo)}" alt="" width="${size}" height="${size}" decoding="async" />`
  : `<span class="face ini" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px" aria-hidden="true">${esc(String(kid?.short || '?')[0])}</span>`);
const faceOf = (short, size) => face(state.kids.find((k) => k.short === short), size);
const kidById = (id) => state.kids.find((k) => k.jobId === id);
// Every open makeover's kid, to say whose something is: one with nothing on the list yet (only allowances on their
// budget) is who an allowance buy is for
const pickKids = () => (state.everyKid?.length ? state.everyKid.map((k) => kidById(k.jobId) || { ...k, items: [], others: 0 }) : state.kids);
const anyKid = (id) => kidById(id) || pickKids().find((k) => k.jobId === id);

const ICON = {
  chev: '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  tick: '<span class="tick"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg></span>',
  wait: '<span class="tick wait"><span class="spin" aria-hidden="true"></span></span>',
  warn: '<span class="tick warn" aria-hidden="true">!</span>',
};

// ─── Talking to the site; a check-in made offline waits on this phone ───

const QUEUE_KEY = 'soard-checkin-queue';
const clean = (m) => String(m || '').replace(/[.\s]+$/, '');
const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
// → false when this phone can't keep anything (private browsing with storage off, or it's full)
const writeQueue = (q) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); return true; } catch { return false; } };
const QUEUEABLE = new Set(['receive', 'other', 'house', 'undo', 'shelf', 'decide', 'out']);
const CANT_KEEP = 'No connection, and this phone can’t keep it for later (its storage is off). Try again with signal';
// What one waiting request holds: a load's boxes, a shipment's check-ins, a take-back's boxes, or one thing
const partsOf = (q) => (Array.isArray(q.body?.items) ? q.body.items.map((x) => x.tap) : Array.isArray(q.body?.taps) ? q.body.taps : [q.body?.tap || q.id]);
// How what landed is said: boxes out, check-ins, anything else a change
const nounOf = (action) => (action === 'out' ? 'box' : ['receive', 'other', 'house'].includes(action) ? 'check-in' : 'change');
const NOUNS = { box: 'boxes', 'check-in': 'check-ins', change: 'changes' };

class Offline extends Error {}
const timedOut = (err) => ['AbortError', 'TimeoutError'].includes(err?.name);

/** POST an action → the site's answer (its fresh view is applied); no connection → Offline; the sign-in ran out → 403 */
async function send(action, body) {
  let res;
  try {
    // Poor signal can hang a request for a minute: one that could wait on the phone stops at 10 seconds and does.
    // A sign-in that ran out answers with a redirect to Access's sign-in page: seen as that, never as "no connection"
    const signal = QUEUEABLE.has(action) && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined;
    res = await fetch(`/api/kid-items-admin?${action}=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'manual' });
  } catch {
    throw new Offline('No connection');
  }
  if (res.type === 'opaqueredirect' || [301, 302, 303, 307].includes(res.status)) throw Object.assign(new Error('Your sign-in ran out'), { status: 403 });
  if ([502, 503, 504].includes(res.status) && QUEUEABLE.has(action)) throw new Offline('The site didn’t answer');
  // The 10 seconds can run out while the answer is still arriving: that's no connection too (it waits and goes again)
  let out;
  try { out = await res.json(); } catch (err) { if (timedOut(err) && QUEUEABLE.has(action)) throw new Offline('No connection'); out = {}; }
  if (!res.ok || !out.success) throw Object.assign(new Error(out.error || `The site answered ${res.status}`), { status: res.status });
  if (out.view) apply(out.view);
  return out;
}

/** Send now, or keep it for when the connection is back → { out } | { queued: true } */
async function sendOrKeep(action, body) {
  try {
    return { out: await send(action, body) };
  } catch (err) {
    if (!(err instanceof Offline) || !QUEUEABLE.has(action)) throw err;
    // Tried once already: if the site did get it (only its answer was lost), an undo of it goes to the site too
    if (!writeQueue([...readQueue(), { id: body.tap || newTap(), action, body, at: Date.now(), tried: true }])) throw new Error(CANT_KEEP);
    showQueue();
    overlayQueue();
    return { queued: true };
  }
}

// Refused for good: the item or line is gone, or it was already settled. Anything else (a sign-in that ran out, the
// site down, a box the site didn't answer for) waits on the phone and is tried again
const FOR_GOOD = new Set([400, 404, 409]);
let flushChain = Promise.resolve();
/**
 * Send what's waiting on this phone, oldest first, one run at a time (a run asked for while one is going runs after
 * it, so nothing waits 15 seconds for no reason) → { landed: Set, refused: Map id → { why, status }, answers: Map
 * id → the site's answer, signIn }. What the caller says itself (mine) isn't said here.
 */
let flushing = 0;
function flush(opts = {}) {
  flushing++;
  const run = flushChain.then(() => flushOnce(opts)).finally(() => { flushing--; reloadWhenQuiet(); });
  flushChain = run.catch(() => {});
  return run;
}
/** What a waiting thing is, in words, for a refusal: "Cloud Pendant Light (2 boxes)" */
function whatOf(q, taps) {
  const items = Array.isArray(q.body?.items) ? q.body.items.filter((x) => taps.includes(x.tap)) : [q.body || {}];
  const names = new Map();
  // By its check-in, undone or not (a refusal is often that it was undone)
  const byRef = (ref) => state.kids.flatMap((k) => k.items).find((i) => (i.receipts || []).some((r) => r.id === ref))?.name;
  for (const x of items) { const name = x.ref ? byRef(x.ref) : x.name; if (name) names.set(name, (names.get(name) || 0) + 1); }
  return [...names].map(([name, n]) => (q.action === 'out' && n > 1 ? `${name} (${n} boxes)` : name)).join(', ');
}
async function flushOnce({ mine = new Set() } = {}) {
  const landed = new Set();
  const refused = new Map();
  const answers = new Map();
  let signIn = false;
  if (!readQueue().length) { showQueue(); return { landed, refused, answers, signIn }; }
  const done = new Set();
  const saidNot = [];
  const savedBy = new Map();
  const notSaved = (q, taps, why) => { const w = whatOf(q, taps); if (!taps.some((t) => mine.has(t))) saidNot.push(w ? `${w}: ${why}` : why); };
  const count = (q, taps) => { const n = taps.filter((t) => !mine.has(t)).length; if (n) savedBy.set(nounOf(q.action), (savedBy.get(nounOf(q.action)) || 0) + n); };
  try {
    for (const q of readQueue()) {
      const parts = partsOf(q);
      // Marked before it goes: if its answer is lost, an undo of it is sent to the site too
      if (!q.tried) writeQueue(readQueue().map((e) => (e.id === q.id ? { ...e, tried: true } : e)));
      let out;
      try {
        out = await send(q.action, q.body);
      } catch (err) {
        if (FOR_GOOD.has(err.status)) {
          done.add(q.id);
          // An undo of what the site never saved: nothing to undo, so it's done
          if (q.action === 'undo' && err.status === 404) { parts.forEach((t) => landed.add(t)); continue; }
          for (const t of parts) refused.set(t, { why: clean(err.message), status: err.status });
          notSaved(q, parts, clean(err.message));
          continue;
        }
        if (err.status === 403) { signIn = true; state.signedOut = true; if (!parts.some((t) => mine.has(t))) toast('Your sign-in ran out. Tap “to save” up top to sign in again.'); }
        break;
      }
      state.signedOut = false;
      const many = Array.isArray(q.body?.items) || Array.isArray(q.body?.taps);
      const byTap = new Map((out.results || []).map((x) => [x.tap, x]));
      const retry = [];
      const why = new Map();
      for (const t of parts) {
        const x = many ? byTap.get(t) : out;
        if (x && !x.error) { landed.add(t); answers.set(t, x); }
        else if (x && q.action === 'undo' && x.status === 404) landed.add(t);
        else if (x && FOR_GOOD.has(x.status)) { refused.set(t, { why: clean(x.error), status: x.status }); why.set(clean(x.error), [...(why.get(clean(x.error)) || []), t]); }
        // No answer for it, or the site failed on it: it goes again, with its own id (never counted twice)
        else retry.push(t);
      }
      for (const [w, taps] of why) notSaved(q, taps, w);
      count(q, parts.filter((t) => landed.has(t)));
      if (retry.length) {
        // It keeps its place: what follows may need it first (a box's check-in before the box)
        const body = Array.isArray(q.body?.items) ? { ...q.body, items: q.body.items.filter((x) => retry.includes(x.tap)) } : { taps: retry };
        writeQueue(readQueue().map((e) => (e.id === q.id ? { ...e, body, tried: true } : e)));
        break;
      }
      done.add(q.id);
    }
  } finally {
    // What was added while this ran stays: only what was sent (or refused for good) comes off
    writeQueue(readQueue().filter((q) => !done.has(q.id)));
    showQueue();
    if (done.size) {
      overlayQueue();
      // A sheet that will draw the list as it closes (the done sheet) does it then, so its rows can fade
      if (!state.renderOnClose) render();
    }
    // What waited on the phone has landed: said once, with anything the site refused, by name
    const said = [...savedBy].map(([k, n]) => `${plural(n, k, NOUNS[k])} saved`);
    if (said.length || saidNot.length) toast([said.join(' · '), saidNot.length ? `Not saved: ${saidNot.join('; ')}` : ''].filter(Boolean).join('. '));
  }
  return { landed, refused, answers, signIn };
}

/**
 * Undo (a check-in, a box out, a "Not coming here"), through the queue and behind anything still being sent, so an
 * undo can't overtake what it undoes. Waiting on this phone and never sent: it just comes off. Sent at least once (its
 * answer lost, so the site may have it): undone on the site too. → { ok: Set of undone, refused: Map id → why,
 * waiting: Set kept on the phone for the connection, answers: Map id → the site's answer, signIn }
 */
async function undoTaps(taps) {
  const want = new Set(taps);
  const local = new Set();
  const tried = new Set();
  const q = [];
  for (const x of readQueue()) {
    const items = Array.isArray(x.body?.items) ? x.body.items : null;
    if (!items) {
      if (want.has(x.body?.tap)) { local.add(x.body.tap); if (x.tried) tried.add(x.body.tap); continue; }
      q.push(x);
      continue;
    }
    const keep = items.filter((it) => { if (!want.has(it.tap)) return true; local.add(it.tap); if (x.tried) tried.add(it.tap); return false; });
    if (keep.length) q.push(keep.length === items.length ? x : { ...x, body: { ...x.body, items: keep } });
  }
  const res = { ok: new Set(), refused: new Map(), waiting: new Set(), answers: new Map(), signIn: false };
  if (local.size && writeQueue(q)) {
    // Off the phone: off the list too
    for (const k of state.kids) for (const i of k.items) {
      const before = (i.receipts || []).length;
      i.receipts = (i.receipts || []).filter((r) => !(r.waiting && local.has(r.id)));
      if (i.receipts.length !== before) settleLocal(i);
    }
    for (const t of local) if (!tried.has(t)) res.ok.add(t);
  }
  const toSite = taps.filter((t) => !res.ok.has(t));
  if (!toSite.length) { showQueue(); return res; }
  if (!writeQueue([...readQueue(), { id: newTap(), action: 'undo', body: { taps: toSite }, at: Date.now() }])) {
    // This phone can't keep it: sent now, or said
    let out;
    try { out = await send('undo', { taps: toSite }); } catch (err) { throw err instanceof Offline ? new Error(CANT_KEEP) : err; }
    for (const x of out.results || []) {
      if (!x.error || x.status === 404) { res.ok.add(x.tap); res.answers.set(x.tap, x); } else res.refused.set(x.tap, clean(x.error));
    }
    return res;
  }
  showQueue();
  overlayQueue();
  const f = await flush({ mine: new Set(toSite) });
  for (const t of toSite) {
    if (f.landed.has(t)) { res.ok.add(t); if (f.answers.has(t)) res.answers.set(t, f.answers.get(t)); } else if (f.refused.has(t)) res.refused.set(t, f.refused.get(t).why); else res.waiting.add(t);
  }
  res.signIn = f.signIn;
  return res;
}

function showQueue() {
  const n = readQueue().reduce((t, q) => t + partsOf(q).length, 0);
  const el = $('queue');
  el.hidden = !n;
  // Short, so the title row never wraps and the page never jumps; tapping it sends now (or signs in again)
  el.textContent = n ? (state.signedOut ? `Sign in · ${n}` : `${n} to save`) : '';
  el.setAttribute('aria-label', n ? (state.signedOut ? `${n} waiting: your sign-in ran out. Sign in again` : `${n} waiting for the connection. Send now`) : '');
  // One chip up top at a time: what's waiting matters more than Practice
  $('mode').hidden = Boolean(n) || !state.practice;
}
window.addEventListener('online', () => flush());
setInterval(() => flush(), 15000);

/** A load waiting from an older copy of this page (whole things, not boxes) is put in boxes, so it can go */
function upgradeQueue() {
  let changed = false;
  const q = readQueue().map((x) => {
    if (x.action !== 'out') return x;
    const items = Array.isArray(x.body?.items) ? x.body.items : [x.body || {}];
    if (items.every((it) => it.ref && it.box)) return x;
    changed = true;
    const boxes = items.flatMap((it) => {
      if (it.ref && it.box) return [it];
      const k = kidById(it.jobId);
      const f = it.ref ? findByRef(it.ref) : (() => { const i = k?.items.find((y) => y.itemId === it.itemId && y.partKey === it.partKey); return i ? { k, i } : null; })();
      return f ? boxesHere(f.i).filter((b) => !it.ref || b.ref === it.ref).map((b, n) => ({ tap: `${String(it.tap).slice(0, 58)}-b${n + 1}`, ref: b.ref, box: b.box })) : [];
    });
    return boxes.length ? { ...x, body: { items: boxes } } : null;
  }).filter(Boolean);
  if (changed) writeQueue(q);
}

/**
 * What's waiting on this phone, drawn onto the list (the site's answers don't know it yet): a box out shows as out,
 * a take-back as back, a check-in as here. Every view from the site is drawn over again, so nothing waiting ever
 * shows as undone; a box the site has as out already (another phone loaded it) isn't drawn twice
 */
function overlayQueue() {
  const touched = new Set();
  const at = new Date().toISOString();
  for (const q of readQueue()) {
    const bodies = Array.isArray(q.body?.items) ? q.body.items : [q.body || {}];
    if (q.action === 'out') {
      for (const b of bodies) {
        const f = b.ref ? findByRef(b.ref) : null;
        if (!f || f.i.receipts.some((r) => r.id === b.tap)) continue;
        const p = outStateOf(f.i).per.get(b.ref);
        if (!p || p.full || (b.box && p.boxes.has(Number(b.box)))) continue;
        f.i.receipts.push({ id: b.tap, kind: 'out', ref: b.ref, box: b.box ?? null, units: 0, at: new Date(q.at || Date.now()).toISOString(), waiting: true });
        touched.add(f.i);
      }
    } else if (q.action === 'undo') {
      const taps = new Set(q.body?.taps || [q.body?.tap]);
      for (const k of state.kids) for (const i of k.items) for (const r of i.receipts || []) if (taps.has(r.id) && !r.undone) { r.undone = true; touched.add(i); }
    } else if (q.action === 'decide' && (q.body?.items || []).some((x) => x.itemName === '*')) {
      // Whose it is, said on this phone: its card stops asking (the site puts it on the kid's list when it gets it)
      state.shipments = state.shipments.filter((x) => !(x.unplaced && x.key === q.body.orderKey));
      state.needsLook = state.needsLook.filter((x) => x.key !== q.body.orderKey);
    } else if (q.action === 'receive' || q.action === 'house') {
      for (const b of bodies) {
        const i = kidById(b.jobId)?.items.find((x) => x.itemId === b.itemId && x.partKey === b.partKey);
        if (!i || (i.receipts || []).some((r) => r.id === b.tap)) continue;
        i.receipts = [...(i.receipts || []), { id: b.tap, kind: q.action === 'house' ? 'house' : 'receive', units: q.action === 'house' ? 0 : b.units || 1, boxes: q.action === 'house' ? 0 : b.boxes || 1, shelf: null, at, waiting: true }];
        touched.add(i);
      }
    }
  }
  for (const i of touched) settleLocal(i);
}

/** Where a thing stands from its receipts, as the site works it out (functions/api/_kid-checkin.js settle) */
function settleLocal(it) {
  const st = outStateOf(it);
  it.got = st.got;
  it.sent = st.sent;
  it.boxesLeft = st.boxesLeft;
  const live = (it.receipts || []).filter((r) => !r.undone);
  it.house = live.some((r) => r.kind === 'house');
  if (it.house && !it.got) it.status = 'house';
  else if (st.allOut && (it.got >= it.qty || it.house)) it.status = 'out';
  else if (it.got >= it.qty || it.house) it.status = 'here';
  else if (it.got > 0) it.status = 'partly';
  else it.status = it.order ? 'ordered' : 'not';
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  t.classList.remove('out');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.add('out'); setTimeout(() => { t.hidden = true; }, 240); }, 4200);
}

function apply(view) {
  Object.assign(state, { kids: view.kids || [], everyKid: view.everyKid || [], needsLook: view.needsLook || [], shelves: view.shelves || [], shipments: view.shipments || [], practice: view.practice !== false, since: view.since || null, printer: view.printer || state.printer });
  overlayQueue();
  pruneLoad();
  $('mode').hidden = !state.practice || readQueue().length > 0;
}

// ─── The list ───────────────────────────────────────────────────────

const matches = (kid, it) => {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [kid.short, it.name, it.line, it.order?.store, it.order?.orderNumber].some((s) => String(s || '').toLowerCase().includes(q));
};
const isHere = (it) => it.status === 'here' || it.status === 'house' || it.status === 'out';
// At the Office now: checked in, and not all of it sent to the house yet
const atOffice = (it) => it.status !== 'house' && boxesLeft(it) > 0;
const byWho = (r) => (r?.who ? ` (${r.who})` : '');

function rowHtml(kid, it) {
  const sub = [it.order?.store, it.line, it.qty > 1 && it.status !== 'partly' ? `${it.qty} of them` : null, it.order?.elsewhere && !isHere(it) ? 'Ships elsewhere' : null].filter(Boolean).join(' · ');
  let side = '';
  if (it.status === 'partly') side = `<span class="tag-part">${it.got} of ${it.qty}</span>`;
  else if (it.status === 'ordered' && it.order?.at) side = `<span class="when${daysAgo(it.order.at) > 14 ? ' late' : ''}" title="Ordered ${esc(ago(it.order.at))}">${shortAgo(it.order.at)}</span>`;
  else if (it.status === 'not' && it.source === 'donated') side = '<span class="when">Donated</span>';
  else if (it.status === 'here') side = `<span class="tag-here">${esc(shelfName(it.shelf) || 'Here')}</span>`;
  else if (it.status === 'house') side = '<span class="tag-house">House</span>';
  return `<button class="row${it.status === 'not' ? ' muted' : ''}" data-kid="${esc(kid.jobId)}" data-id="${esc(it.id)}" type="button">
    <span class="row-name">${esc(it.name)}</span><span class="row-side">${side}</span>
    <span class="row-sub">${esc(sub)}</span></button>`;
}

function render() {
  document.body.dataset.mode = state.mode;
  document.querySelector('h1').textContent = state.mode === 'out' ? 'Check out' : 'Check in';
  document.querySelectorAll('.seg [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  $('q').placeholder = state.mode === 'out' ? 'Find a kid or a thing' : 'Find an item, a kid or a store';
  if (state.mode === 'out') { renderOut(); return; }
  $('scan').classList.remove('confirming');
  $('other2').hidden = true;
  paintTabs();
  $('scan').querySelector('span').textContent = 'Scan a box';
  $('other').textContent = 'Something else';
  $('chips').innerHTML = ['All', ...state.kids.map((k) => k.short)]
    .map((n) => `<button class="chip${n === 'All' ? '' : ' has-face'}" type="button" aria-pressed="${n === state.filter}" data-chip="${esc(n)}">${n === 'All' ? '' : faceOf(n, 26)}${esc(n)}</button>`).join('');
  let html = state.needsLook.length && !state.query && state.filter === 'All'
    ? `<button class="strip" type="button" id="looks"><b>Needs a look</b><span class="count-warn">${state.needsLook.length}</span>${ICON.chev}</button>` : '';
  // All kids: what's coming, by shipment, delivered first. One kid (or a search): their list
  if (state.filter === 'All' && !state.query) { $('list').innerHTML = shipmentsHtml(html); showPrinter(); return; }
  for (const kid of state.kids.filter((k) => state.filter === 'All' || k.short === state.filter)) {
    const items = kid.items.filter((it) => matches(kid, it));
    if (state.query && !items.length) continue;
    const here = kid.items.filter(isHere).length;
    const total = kid.items.length;
    const coming = items.filter((i) => i.status === 'partly' || (i.status === 'ordered' && !i.before));
    const before = items.filter((i) => i.status === 'ordered' && i.before);
    const notOrdered = items.filter((i) => i.status === 'not');
    const hereItems = items.filter(isHere);
    html += `<section class="card" aria-label="${esc(kid.short)}">
      <div class="card-head">
        <div class="card-title"><div class="who">${face(kid, 44)}<h2>${esc(kid.short)}</h2>${kid.shelf ? `<span class="tag-here">${esc(kid.shelves.map(shelfName).join(' · '))}</span>` : ''}</div><span class="count"><b>${here}</b> of ${total} here</span></div>
        <div class="bar" aria-hidden="true"><i data-bar="${esc(kid.jobId)}" style="transform:scaleX(${total ? here / total : 0})"></i></div>
      </div>`;
    if (coming.length) html += `<div class="group-h"><span>Hasn’t come yet</span><span>${coming.length}</span></div>${coming.map((i) => rowHtml(kid, i)).join('')}`;
    if (before.length) {
      html += `<div class="group-h"><span>Ordered before this started</span><span>${before.length}</span></div>${before.map((i) => rowHtml(kid, i)).join('')}
        <button class="more strong" type="button" data-allhere="${esc(kid.jobId)}"><span>These are here</span>${ICON.chev}</button>`;
    }
    if (notOrdered.length) html += `<div class="group-h"><span>Not ordered yet</span><span>${notOrdered.length}</span></div>${notOrdered.map((i) => rowHtml(kid, i)).join('')}`;
    if (hereItems.length) {
      html += state.openHere.has(kid.jobId) || state.query
        ? `<div class="group-h"><span>Here</span><span>${hereItems.length}</span></div>${hereItems.map((i) => rowHtml(kid, i)).join('')}`
        : `<button class="more" type="button" data-here="${esc(kid.jobId)}"><span>${plural(hereItems.length, 'thing')} here</span>${ICON.chev}</button>`;
    }
    html += '</section>';
  }
  $('list').innerHTML = html || `<div class="empty">${state.query ? 'Nothing matches that.' : 'Nothing waiting to be checked in.'}</div>`;
  showPrinter();
}

const PRINTER_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/></svg>';
/** The printer, up top: a printer with a dot (green ready, grey off or not set up); a problem says itself */
function showPrinter() {
  const p = state.printer;
  const el = $('printer');
  const problem = p?.setUp && p.problems?.length ? p.problems[0] : '';
  el.className = `printer-pill ${!p?.setUp ? 'off' : problem ? 'warn' : p.online ? 'ok' : 'off'}${problem ? ' says' : ''}`;
  el.innerHTML = `${PRINTER_ICON}<i aria-hidden="true"></i>${problem ? `<span>${esc(problem)}</span>` : ''}`;
  el.setAttribute('aria-label', `Shelves and printer. Printer: ${!p?.setUp ? 'not set up' : problem || (p.online ? 'ready' : 'off or out of reach')}`);
}

// ─── Sheets ─────────────────────────────────────────────────────────

let closeTimer;
const sheetEl = () => document.querySelector('#sheet-root .sheet');
function close() {
  const scrim = document.querySelector('#sheet-root .scrim');
  if (!scrim || scrim.classList.contains('closing')) return Promise.resolve();
  const sheet = sheetEl();
  // From wherever a drag left it
  if (sheet?.style.transform) { sheet.style.transition = 'transform 240ms cubic-bezier(0.32, 0, 0.67, 0)'; sheet.style.transform = 'translateY(100%)'; }
  scrim.classList.add('closing');
  clearTimeout(closeTimer);
  return new Promise((resolve) => {
    closeTimer = setTimeout(() => {
      $('sheet-root').innerHTML = '';
      // What changed while the sheet was up shows once it's gone; focus goes back to what opened it (or the next card)
      if (state.renderOnClose) { state.renderOnClose = false; settleAfter(); }
      reloadWhenQuiet();
      const back = state.openedFrom && document.querySelector(state.openedFrom);
      (back || document.querySelector('#list .ship, #list .row, #list button'))?.focus({ preventScroll: true });
      state.openedFrom = null;
      resolve();
    }, reduced() ? 0 : 240);
  });
}

/** A new sheet rises; a sheet turning into the next one keeps its place and eases to its new height */
function openSheet(inner, { keep = false, label = '' } = {}) {
  clearTimeout(closeTimer);
  // Where focus goes back to when it closes
  if (!sheetEl()) { const a = document.activeElement; state.openedFrom = a?.dataset?.ship ? `[data-ship="${CSS.escape(a.dataset.ship)}"]` : a?.id ? `#${CSS.escape(a.id)}` : null; }
  const root = $('sheet-root');
  const sheet = sheetEl();
  if (keep && sheet && !root.querySelector('.scrim.closing')) {
    const from = sheet.getBoundingClientRect().height;
    sheet.querySelector('.sheet-body').outerHTML = `<div class="sheet-body body-in">${inner}</div>`;
    if (!reduced()) {
      const to = sheet.getBoundingClientRect().height;
      sheet.classList.add('resizing');
      sheet.style.height = `${from}px`;
      requestAnimationFrame(() => requestAnimationFrame(() => { sheet.style.height = `${to}px`; }));
      setTimeout(() => { sheet.classList.remove('resizing'); sheet.style.height = ''; }, 380);
    }
  } else {
    root.innerHTML = `<div class="scrim" data-close="1"><div class="sheet" role="dialog" aria-modal="true"><div class="grab" aria-hidden="true"></div><div class="sheet-body">${inner}</div></div></div>`;
    dragToClose(sheetEl());
  }
  const s = sheetEl();
  const h = s.querySelector('h3');
  if (h) s.setAttribute('aria-label', label || h.textContent.trim());
  (s.querySelector('[data-focus]') || s.querySelector('input') || s.querySelector('.sheet-body button'))?.focus({ preventScroll: true });
}

/** Pull a sheet down by its handle or title to close it: it follows the finger, closes past a quarter or on a flick, else springs back */
function dragToClose(sheet) {
  let startY = null, lastY = 0, lastT = 0, v = 0, dy = 0;
  sheet.addEventListener('pointerdown', (e) => {
    if (sheet.scrollTop > 0 || !e.target.closest('.grab, .sheet-head') || e.target.closest('button')) return;
    startY = lastY = e.clientY; lastT = performance.now(); v = 0; dy = 0;
    sheet.style.transition = 'none';
    sheet.setPointerCapture?.(e.pointerId);
  });
  sheet.addEventListener('pointermove', (e) => {
    if (startY === null) return;
    const raw = e.clientY - startY;
    dy = raw > 0 ? raw : raw * 0.3;
    const now = performance.now();
    v = (e.clientY - lastY) / Math.max(1, now - lastT); lastY = e.clientY; lastT = now;
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const up = () => {
    if (startY === null) return;
    startY = null;
    if (dy > sheet.offsetHeight * 0.25 || v > 0.5) { close(); return; }
    sheet.style.transition = 'transform 300ms cubic-bezier(0.32, 0.72, 0, 1)';
    sheet.style.transform = '';
  };
  sheet.addEventListener('pointerup', up);
  sheet.addEventListener('pointercancel', up);
}

const head = (title, { sub = '', one = false, kid = false } = {}) => `<div class="sheet-head"><div><h3${kid ? ' class="kid"' : ''}>${title}</h3>${sub ? `<div class="sheet-sub${one ? ' one' : ''}">${sub}</div>` : ''}</div>
  <button class="x" type="button" data-close="1" aria-label="Close">${ICON.x}</button></div>`;
const stepper = (name, label, n) => `<div class="stepper" data-stepper="${name}"><span>${label}</span><div><button type="button" data-step="-1" aria-label="${label}: one fewer">−</button><output aria-live="polite">${n}</output><button type="button" data-step="1" aria-label="${label}: one more">+</button></div></div>`;
const kidTitle = (kid) => `${face(kid, 44)}${esc(kid.short)}${kid.shelf ? `<span class="tag-here">${esc(kid.shelf)}</span>` : ''}`;

/** Steppers that change their number in place (the sheet doesn't redraw for it) → read() */
function steppers(limits, onChange = () => {}) {
  const vals = {};
  document.querySelectorAll('#sheet-root [data-stepper]').forEach((el) => {
    const name = el.dataset.stepper;
    const [min, max] = limits[name];
    vals[name] = Number(el.querySelector('output').textContent);
    el.querySelectorAll('[data-step]').forEach((b) => {
      b.onclick = () => {
        vals[name] = Math.min(max, Math.max(min, vals[name] + Number(b.dataset.step)));
        el.querySelector('output').textContent = vals[name];
        onChange(vals);
      };
    });
  });
  return vals;
}
const printWords = (boxes) => `Print ${boxes === 1 ? 'label' : `${boxes} labels`}`;

function factsOf(it) {
  return [
    it.order?.store ? ['From', it.order.store] : null,
    it.order ? ['Ordered', `${ago(it.order.at)}${it.order.buyer ? `, by ${it.order.buyer}` : ''}`] : null,
    it.order?.orderNumber ? ['Order', it.order.orderNumber] : null,
    it.orderedAs && it.orderedAs !== it.name ? ['Store calls it', it.orderedAs] : null,
    it.line && it.line !== 'Also bought' ? ['Line', it.line] : ['Line', 'Also bought, on top of the selections'],
    it.source === 'donated' ? ['Donated', 'Yes'] : null,
    it.qty > 1 ? ['How many', it.got ? `${it.got} of ${it.qty} here` : String(it.qty)] : null,
    it.order?.elsewhere ? ['Ships to', 'Not the Office'] : null,
  ].filter(Boolean);
}
const factsHtml = (facts) => (facts.length ? `<dl class="facts">${facts.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>` : '');

/** One item: how many came, how many boxes, Print; or, once here, its check-ins */
function itemSheet(kid, it, { found = '', keep = false, boxes: preset = 1, ref = null, box = null } = {}) {
  if (state.mode === 'out') {
    if (ref || atOffice(it)) outSheet(kid, it, { keep, ref, box });
    else if (boxesOut(it).length) takeBackSheet(kid, it, { keep });
    else infoSheet(kid, it, { keep });
    return;
  }
  if (isHere(it)) { hereSheet(kid, it, { keep }); return; }
  const left = Math.max(1, it.qty - (it.got || 0));
  let units = left, boxes = Math.max(1, Math.min(20, preset));
  openSheet(`${head(kidTitle(kid), { kid: true, sub: found ? esc(found) : '' })}
    <p class="item-name">${esc(it.name)}</p>
    ${factsHtml(factsOf(it))}
    ${left > 1 ? stepper('units', 'How many came', units) : ''}
    ${stepper('boxes', 'Boxes', boxes)}
    <button class="btn btn-primary btn-big" type="button" id="print" data-focus>${printWords(boxes)}</button>
    <div class="btn-row">${it.order ? '<button class="btn btn-text" type="button" id="wrongkid">Wrong kid or line</button>' : ''}<button class="btn btn-text" type="button" id="house">Not coming here</button></div>`, { keep });
  const vals = steppers({ units: [1, left], boxes: [1, 20] }, (v) => { units = v.units ?? units; boxes = v.boxes; $('print').textContent = printWords(boxes); });
  units = vals.units ?? units;
  $('print').onclick = () => printed(kid, it, { units, boxes });
  $('house').onclick = () => house(kid, it);
  if ($('wrongkid')) $('wrongkid').onclick = () => wrongKidSheet(kid, it);
}

/** Something already here: when it came, where it is, Print again, Undo, another shelf */
function hereSheet(kid, it, { keep = false } = {}) {
  const live = (it.receipts || []).filter((r) => !r.undone);
  const ins = live.filter((r) => r.kind === 'receive' || r.kind === 'house');
  const last = ins[ins.length - 1];
  const waiting = !live.length;
  const rows = live.map((r) => `<div class="receipt"><span>${r.kind === 'house' ? `Went to the house${byWho(r)}` : r.kind === 'out' ? `${r.units > 1 ? `${r.units} out` : 'Out'} to the house ${dayOf(r.at)}${byWho(r)}` : `${plural(r.units, 'came', 'came')} ${dayOf(r.at)}${r.boxes ? `, ${plural(r.boxes, 'box', 'boxes')}` : ''}${byWho(r)}`}</span>${r.kind === 'out' ? `<button class="tag-here as-btn" type="button" data-takeback="${esc(r.id)}" aria-label="Take it back off the truck">Take back</button>` : r.shelf ? `<button class="tag-here as-btn" type="button" data-move="${esc(r.id)}" aria-label="Move it from ${esc(shelfName(r.shelf))}">${esc(shelfName(r.shelf))}</button>` : ''}</div>`).join('');
  openSheet(`${head(kidTitle(kid), { kid: true })}
    <p class="item-name">${esc(it.name)}</p>
    ${factsHtml(factsOf(it))}
    ${budgetPick(kid, it)}
    <div class="receipts">${waiting ? '<div class="receipt"><span>Waiting on this phone for the connection</span></div>' : rows}</div>
    ${last?.kind === 'receive' && !last.waiting ? '<button class="btn btn-big" type="button" id="reprint" data-focus>Print again</button>' : ''}
    ${waiting || !last ? '' : '<div class="btn-row"><button class="btn btn-text" type="button" id="undo">Undo the check-in</button></div>'}`, { keep });
  document.querySelectorAll('#sheet-root [data-takeback]').forEach((b) => {
    b.onclick = async () => {
      let r;
      try { r = await undoTaps([b.dataset.takeback]); } catch (err) { toast(err.message); return; }
      if (r.refused.size) { toast(`Not taken back: ${[...r.refused.values()][0]}`); return; }
      tones.undo();
      await close();
      render();
      toast('Back at the Office');
    };
  });
  if ($('reprint')) $('reprint').onclick = async () => {
    try { const out = await send('reprint', { tap: last.id }); toast(printSaid(out.print).text); } catch (err) { toast(err.message); }
  };
  if ($('undo')) $('undo').onclick = async () => {
    const r = await undoTaps([last.id]).catch((err) => { toast(err.message); return null; });
    if (!r) return;
    if (r.refused.size) { toast(`Not undone: ${[...r.refused.values()][0]}`); return; }
    await close();
    render();
  };
  bindMoves(kid, it);
  bindBudget(kid, it);
}

/**
 * Something typed in (no order to answer Wrong kid or line about): where its line goes on the kid's budget, next to one
 * of their allowances or in Also bought. The site sorts it; a person's answer here stands over that
 */
function budgetPick(kid, it) {
  if (!it.also?.typed || !kid.allowances?.length) return '';
  const now = it.also.pending ? '' : it.also.allowItemId ? `allow:${it.also.allowItemId}` : 'also';
  const opt = (v, t) => `<option value="${esc(v)}"${v === now ? ' selected' : ''}>${esc(t)}</option>`;
  return `<div class="field"><label for="budget">On ${esc(kid.short)}’s budget</label><select id="budget">${now ? '' : '<option value="" selected>Being sorted</option>'}${kid.allowances.map((a) => opt(`allow:${a.itemId}`, `Next to the ${a.line} allowance`)).join('')}${opt('also', 'Also bought')}</select></div>`;
}
function bindBudget(kid, it) {
  const sel = $('budget');
  if (!sel) return;
  sel.onchange = async () => {
    if (!sel.value) return;
    sel.disabled = true;
    try {
      await send('allow', { key: it.also.key, jobId: kid.jobId, itemId: sel.value.startsWith('allow:') ? sel.value.slice(6) : null });
      toast('Its line moves on the budget in a minute');
    } catch (err) {
      toast(`Not saved: ${clean(err.message)}`);
    } finally {
      sel.disabled = false;
    }
  };
}

/** Say what happened to the labels, in a few words */
function printSaid(p) {
  if (!p) return { ok: false, text: 'Saved. The labels print when it’s sent.' };
  if (p.printed) return p.error ? { ok: false, text: `${p.printed} printed, the rest didn’t: ${p.error}` } : { ok: true, text: p.printed === 1 ? 'Printed' : `${p.printed} printed` };
  if (!p.setUp) return { ok: false, text: 'The printer isn’t set up yet' };
  if (p.problems?.length) return { ok: false, text: `Printer: ${p.problems.join(', ')}` };
  if (p.queued) return { ok: false, text: 'The printer is off. They print when it’s back on.' };
  return { ok: false, text: p.error || 'The printer didn’t answer' };
}
const jtSaid = (jt, queued) => (queued ? 'Saved on this phone. It goes to JobTread when the connection is back.'
  : jt === 'written' ? `Received in JobTread, ${dayOf()}` : jt === 'later' ? 'Saved. JobTread in a minute.' : 'Saved');

/** Print: the labels feed out while the check-in is saved; then what happened, the shelf, and what's next */
async function printed(kid, it, { units = 1, boxes = 1, other = null, tap = newTap() } = {}) {
  const shown = Math.min(boxes, 3);
  const shelfNow = kid.shelf || '';
  const labels = Array.from({ length: boxes }, (_, i) => {
    const under = boxes - 1 - i; // 0 is the newest, on top
    const off = Math.min(under, 2) * 8;
    return `<div class="label" style="animation-delay:${i * 160}ms;z-index:${i + 1};transform:translate(${off}px, ${off}px)${under >= shown ? ';visibility:hidden' : ''}">
      <div class="label-kid">${esc(kid.short.toUpperCase())}</div>
      <div class="label-item">${esc(it.name)}</div>
      <div class="label-mid"><span class="label-box">Box ${i + 1} of ${boxes}</span></div>
      <div class="label-shelf" data-label-shelf>${esc((shelfNow || 'Shelf').toUpperCase())}</div>
      <div class="label-foot"><span>In ${esc(dayOf())}<br>SOARD</span><canvas data-qr="${i + 1}" aria-label="QR code for box ${i + 1}"></canvas></div>
    </div>`;
  }).join('');
  const after = 620 + (boxes - 1) * 160;
  openSheet(`${head(boxes === 1 ? 'Label' : `${boxes} labels`, { sub: esc(it.name), one: true })}
    <div class="printer" aria-hidden="true"><div class="slot"></div><div class="stack" style="--peek:${(shown - 1) * 8}px">${labels}</div></div>
    <div class="done-line" id="saved" style="--after:${after}ms">${ICON.wait}<span>Saving</span></div>
    <div class="done-line sub" id="printed" style="--after:${after + 80}ms" hidden></div>
    <button class="shelf-callout" type="button" id="moveit" aria-label="Move it to another shelf"><span class="who">${face(kid, 36)}${esc(kid.short)}’s shelf</span><b id="shelf">${esc(shelfNow || '…')}</b></button>
    <div class="after"><button class="btn btn-primary btn-big" type="button" id="next" data-focus>Scan the next box</button>
      <div class="btn-row"><button class="btn btn-text" type="button" id="done">Done</button><button class="btn btn-text" type="button" id="undo">Undo</button></div></div>`, { keep: true });
  document.querySelectorAll('canvas[data-qr]').forEach((c) => drawQr(c, `${location.origin}/admin/checkin/?r=${encodeURIComponent(tap)}&b=${c.dataset.qr}`));
  const started = Date.now();
  const body = other ? { tap, jobId: kid.jobId, ...other, units, boxes } : { tap, jobId: kid.jobId, itemId: it.itemId, partKey: it.partKey, name: it.name, line: it.line, units, boxes };
  let res = null, failed = null;
  try { res = await sendOrKeep(other ? 'other' : 'receive', body); } catch (err) { failed = err; }
  // The labels finish feeding before the answer shows
  await wait(Math.max(0, after - (Date.now() - started)));
  const saved = $('saved');
  if (!saved) return;
  if (failed) {
    saved.innerHTML = `${ICON.warn}<span>Not saved: ${esc(failed.message)}</span>`;
    $('next').textContent = 'Try again';
    // The same id: if the site did save it before the error, trying again can't count it twice
    $('next').onclick = () => printed(kid, it, { units, boxes, other, tap });
    $('done').onclick = () => close();
    $('undo').hidden = true;
    $('moveit').disabled = true;
    return;
  }
  const out = res.out || {};
  saved.innerHTML = `${ICON.tick}<span>${esc(jtSaid(out.jt, res.queued))}</span>${state.practice && !res.queued ? '<span class="chip-mode">Practice</span>' : ''}`;
  const p = printSaid(res.queued ? null : out.print);
  const pr = $('printed');
  pr.hidden = false;
  pr.innerHTML = `${p.ok ? ICON.tick : ICON.warn}<span>${esc(p.text)}</span>${!p.ok && out.receipt && out.print?.setUp ? '<button class="btn btn-text inline" type="button" id="again">Print again</button>' : ''}`;
  if ($('again')) $('again').onclick = async () => { try { const o = await send('reprint', { tap: out.receipt }); const q = printSaid(o.print); pr.querySelector('span').textContent = q.text; } catch (err) { toast(err.message); } };
  const shelf = out.shelf ? shelfName(out.shelf) : kid.shelf || '';
  $('shelf').textContent = shelf || 'Next free';
  document.querySelectorAll('[data-label-shelf]').forEach((el) => { el.textContent = (shelf || 'Shelf').toUpperCase(); });
  const finish = async (next) => {
    await close();
    if (next) { scan(); setTimeout(() => leave(kid, it), 400); return; }
    leave(kid, it);
  };
  $('done').onclick = () => finish(false);
  $('next').onclick = () => finish(true);
  $('undo').onclick = async () => {
    let r;
    try { r = await undoTaps([tap]); } catch (err) { toast(err.message); return; }
    if (r.refused.size) { toast(`Not taken back: ${[...r.refused.values()][0]}`); return; }
    await close();
    render();
    toast('Taken back');
  };
  $('moveit').onclick = () => (out.receipt ? shelfPicker(kid, tap, () => printedShelf(kid)) : null);
}
const printedShelf = (kid) => { const s = $('shelf'); if (s) s.textContent = kidById(kid.jobId)?.shelf || s.textContent; };

/** After a load: its rows fade and close up, then the list redraws and each bar grows from where it was */
async function settleAfter() {
  const ids = state.afterLoad || [];
  state.afterLoad = null;
  const rows = ids.filter((id) => { const it = itemOfId(id); return it && !atOffice(it); }).map((id) => document.querySelector(`#list .lrow[data-row="${CSS.escape(id)}"]`)).filter(Boolean);
  const bars = new Map([...document.querySelectorAll('[data-bar]')].map((b) => [b.dataset.bar, b.style.transform]));
  if (rows.length && !reduced()) {
    rows.forEach((r) => { r.style.maxHeight = `${r.offsetHeight}px`; r.classList.add('fading'); });
    await wait(120);
    rows.forEach((r) => r.classList.add('leaving'));
    await wait(280);
  }
  render();
  if (reduced()) return;
  document.querySelectorAll('[data-bar]').forEach((b) => {
    const from = bars.get(b.dataset.bar);
    if (!from || from === b.style.transform) return;
    const to = b.style.transform;
    b.style.transition = 'none'; b.style.transform = from;
    requestAnimationFrame(() => requestAnimationFrame(() => { b.style.transition = ''; b.style.transform = to; }));
  });
}

/** Once the sheet is gone: the row fades, closes up, and the kid's bar grows */
async function leave(kid, it) {
  const row = document.querySelector(`#list .row[data-id="${CSS.escape(it.id)}"]`);
  const bar = document.querySelector(`[data-bar="${CSS.escape(kid.jobId)}"]`);
  const before = bar?.style.transform;
  const fresh = kidById(kid.jobId)?.items.find((x) => x.id === it.id);
  if (row && !reduced() && fresh?.status !== 'partly') {
    row.style.maxHeight = `${row.offsetHeight}px`;
    row.classList.add('fading');
    await wait(120);
    row.classList.add('leaving');
    await wait(280);
  }
  render();
  const now = document.querySelector(`[data-bar="${CSS.escape(kid.jobId)}"]`);
  if (now && before && !reduced()) {
    const target = now.style.transform;
    now.style.transition = 'none'; now.style.transform = before;
    requestAnimationFrame(() => requestAnimationFrame(() => { now.style.transition = ''; now.style.transform = target; }));
  }
}

/** The label's QR, the same one the printer prints: it opens this check-in on the page */
function drawQr(canvas, text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), m = 2, size = n + m * 2;
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#111111';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) ctx.fillRect(x + m, y + m, 1, 1);
}

/** Not coming here: it went to the house or an installer; it's done as far as the Office goes */
async function house(kid, it) {
  try {
    const r = await sendOrKeep('house', { tap: newTap(), jobId: kid.jobId, itemId: it.itemId, partKey: it.partKey, name: it.name, line: it.line });
    if (r.queued) it.status = 'house';
    await close();
    leave(kid, it);
    toast(`${it.name}: not coming here`);
  } catch (err) { toast(err.message); }
}

/** Another shelf (or the Floor) for a check-in; a shelf another kid has can't be picked */
function shelfPicker(kid, tap, then) {
  const mine = new Set(kid.shelves || []);
  const list = state.shelves.filter((s) => s.shelf === 'Floor' || !s.kid || s.kid === kid.jobId);
  openSheet(`${head('Which shelf?', { sub: esc(`${kid.short}’s now: ${(kid.shelves || []).map(shelfName).join(', ') || 'none yet'}`) })}
    <div class="shelf-pick">${list.map((s) => `<button class="shelf-btn${mine.has(s.shelf) ? ' mine' : ''}" type="button" data-shelf="${esc(s.shelf)}">${esc(s.shelf === 'Floor' ? 'Floor' : s.shelf)}</button>`).join('')}</div>`, { keep: true });
  document.querySelectorAll('#sheet-root [data-shelf]').forEach((b) => {
    b.onclick = async () => {
      try { await sendOrKeep('shelf', { tap, shelf: b.dataset.shelf }); } catch (err) { toast(err.message); return; }
      toast(`On ${shelfName(b.dataset.shelf)}`);
      await close();
      render();
      then?.();
    };
  });
}
function bindMoves(kid) {
  document.querySelectorAll('#sheet-root [data-move]').forEach((b) => { b.onclick = () => shelfPicker(kid, b.dataset.move); });
}

/** A kid's places an item can go: their open lines, their allowance lines, Also bought */
function optionsFor(kid, { undo = false, guess = '', current = '' } = {}) {
  const open = kid.items.filter((i) => (!i.order || `line:${i.id}` === current) && !i.also && !i.allowance && !isHere(i));
  const opt = (v, t) => `<option value="${esc(v)}"${v === guess ? ' selected' : ''}>${esc(t)}</option>`;
  return [
    opt('also', 'Also bought, on top of the selections'),
    open.length ? `<optgroup label="${esc(kid.short)}’s selections">${open.map((i) => opt(`line:${i.id}`, `${i.line}: ${i.name}`)).join('')}</optgroup>` : '',
    kid.allowances?.length ? `<optgroup label="Allowances">${kid.allowances.map((a) => opt(`allow:${a.itemId}`, `${a.line} allowance`)).join('')}</optgroup>` : '',
    opt('notKid', 'Not a kid’s'),
    undo ? opt('cancelled', 'Cancelled or sent back') : '',
  ].join('');
}
function decisionOf(kid, value) {
  if (value === 'also') return { type: 'also', kid: kid.jobId };
  if (value === 'notKid') return { type: 'notKid' };
  if (value === 'cancelled') return { type: 'cancelled' };
  if (value.startsWith('allow:')) return { type: 'line', kid: kid.jobId, itemId: value.slice(6), partKey: 'allow' };
  const it = kid.items.find((i) => i.id === value.slice(5));
  return { type: 'line', kid: kid.jobId, itemId: it.itemId, partKey: it.partKey };
}

/** Wrong kid or line: whose it really is (this kid to start with) and which of their lines, the allowance or Also bought */
function wrongKidSheet(fromKid, it) {
  let kid = fromKid;
  // Where it is now: a line, the allowance it's bought on, or Also bought
  const here = (k) => (k === fromKid && !it.also?.pending ? (it.also ? (it.also.allowItemId ? `allow:${it.also.allowItemId}` : 'also') : `line:${it.id}`) : '');
  const draw = () => {
    openSheet(`${head('Where does it go?', { sub: esc(it.name), one: true })}
      <div class="kidpick">${pickKids().map((k) => `<button class="chip has-face" type="button" data-pick="${esc(k.jobId)}" aria-pressed="${k.jobId === kid.jobId}">${face(k, 32)}${esc(k.short)}</button>`).join('')}</div>
      <div class="field"><label for="where">${esc(kid.short)}’s</label><select id="where">${optionsFor(kid, { current: here(kid), guess: here(kid) })}</select></div>
      <button class="btn btn-primary btn-big" type="button" id="save" data-focus>Move it</button>`, { keep: true });
    document.querySelectorAll('#sheet-root [data-pick]').forEach((b) => { b.onclick = () => { kid = anyKid(b.dataset.pick); draw(); }; });
    $('save').onclick = async () => {
      const value = $('where').value;
      if (kid === fromKid && value === here(kid)) { await close(); return; }
      const decision = decisionOf(kid, value);
      try { await sendOrKeep('decide', { orderKey: it.order?.key, from: fromKid.jobId, items: [{ itemName: it.orderedAs || it.name, decision }] }); } catch (err) { toast(err.message); return; }
      await close();
      render();
      toast(decision.type === 'notKid' ? 'Taken off the list' : decision.type === 'cancelled' ? 'Marked cancelled' : `Moved${kid === fromKid ? '' : ` to ${kid.short}`}`);
    };
  };
  draw();
}

/** Something else that came: for which kid, what, what it cost; it goes on their budget, next to the allowance it's bought under (or Also bought) */
function otherSheet() {
  const kids = pickKids();
  if (!kids.length) return;
  let kidId = (state.filter !== 'All' && kids.find((k) => k.short === state.filter)?.jobId) || kids[0].jobId;
  let donated = false;
  openSheet(`${head('Something else')}
    <div class="field"><span class="label-above">For</span><div class="kidpick">${kids.map((k) => `<button class="chip has-face" type="button" data-pick="${esc(k.jobId)}" aria-pressed="${k.jobId === kidId}">${face(k, 32)}${esc(k.short)}</button>`).join('')}</div></div>
    <div class="field"><label for="what">What is it?</label><input id="what" type="text" placeholder="Bean bag chair" autocomplete="off" enterkeyhint="next" /></div>
    <div class="field two"><div class="field"><label for="cost">What it cost</label><input id="cost" type="text" inputmode="decimal" placeholder="$0.00" autocomplete="off" /></div>
      <button class="chip toggle" type="button" id="donated" aria-pressed="false">Donated</button></div>
    ${stepper('boxes', 'Boxes', 1)}
    <button class="btn btn-primary btn-big" type="button" id="print">Print label</button>`, { keep: Boolean(sheetEl()) });
  const input = $('what');
  document.querySelectorAll('#sheet-root [data-pick]').forEach((b) => {
    b.onclick = () => { kidId = b.dataset.pick; document.querySelectorAll('#sheet-root [data-pick]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); };
  });
  $('donated').onclick = () => { donated = !donated; $('donated').setAttribute('aria-pressed', String(donated)); $('cost').disabled = donated; };
  const vals = steppers({ boxes: [1, 20] }, (v) => { $('print').textContent = printWords(v.boxes); });
  $('print').onclick = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); input.placeholder = 'Type what it is first'; return; }
    const cents = Math.round(Number(String($('cost').value).replace(/[^0-9.]/g, '')) * 100) || null;
    const kid = anyKid(kidId);
    const it = { id: `typed:${Date.now()}`, name, line: 'Also bought', qty: 1, source: donated ? 'donated' : 'buy', status: 'not', order: null, receipts: [] };
    printed(kid, it, { units: 1, boxes: vals.boxes, other: { name, cents: donated ? null : cents, donated } });
  };
}

/** Ordered before this started: everything the kid has from then, here at once (one label each) */
function allHereSheet(kid) {
  const items = kid.items.filter((i) => i.status === 'ordered' && i.before);
  openSheet(`${head(kidTitle(kid), { kid: true, sub: 'Everything here from before check-in started' })}
    <div class="pick">${items.map((i) => `<label class="look check"><input type="checkbox" checked data-all="${esc(i.id)}" /><span><b>${esc(i.name)}</b><span>${esc([i.order?.store, i.line].filter(Boolean).join(' · '))}</span></span></label>`).join('')}</div>
    <button class="btn btn-primary btn-big" type="button" id="allgo" data-focus>Check in and print ${plural(items.length, 'label')}</button>`);
  const update = () => { const n = document.querySelectorAll('#sheet-root [data-all]:checked').length; $('allgo').textContent = n ? `Check in and print ${plural(n, 'label')}` : 'Pick what’s here'; $('allgo').disabled = !n; };
  document.querySelectorAll('#sheet-root [data-all]').forEach((c) => { c.onchange = update; });
  $('allgo').onclick = async () => {
    const chosen = [...document.querySelectorAll('#sheet-root [data-all]:checked')].map((c) => items.find((i) => i.id === c.dataset.all)).filter(Boolean);
    $('allgo').disabled = true;
    let done = 0, kept = 0;
    for (const it of chosen) {
      $('allgo').innerHTML = `<span class="spin" aria-hidden="true"></span>${done + 1} of ${chosen.length}`;
      try {
        const r = await sendOrKeep('receive', { tap: newTap(), jobId: kid.jobId, itemId: it.itemId, partKey: it.partKey, name: it.name, line: it.line, units: Math.max(1, it.qty - (it.got || 0)), boxes: 1 });
        if (r.queued) kept++;
        done++;
      } catch (err) { toast(`${it.name}: ${err.message}`); }
    }
    await close();
    render();
    toast(kept ? `${done} saved; ${kept} wait for the connection` : `${plural(done, 'thing')} checked in`);
  };
}

// ─── Needs a look ───────────────────────────────────────────────────

function looksSheet(keep = false) {
  openSheet(`${head('Needs a look', { sub: plural(state.needsLook.length, 'order') })}
    <div class="pick">${state.needsLook.map((o, n) => `<button class="look" type="button" data-look="${n}"><b>${esc(o.store)}</b>
      <span>${esc([o.po ? `PO “${o.po}”` : null, ago(o.at), o.buyer].filter(Boolean).join(' · '))}</span>
      <span>${esc(o.items.slice(0, 2).map((i) => i.name).join(' · '))}${o.items.length > 2 ? ` and ${o.items.length - 2} more` : ''}</span>
      ${o.undo ? `<span class="why">Part of it was ${esc(o.undo)}</span>` : ''}</button>`).join('')}</div>`, { keep });
}

/** One order: whose is it, and where each thing in it goes; one Save */
function lookSheet(n) {
  const o = state.needsLook[n];
  if (!o) return;
  let kid = anyKid(o.kid) || null;
  const draw = () => {
    openSheet(`${head(esc(o.store), { sub: esc([o.po ? `PO “${o.po}”` : null, `ordered ${ago(o.at)}`, o.buyer ? `by ${o.buyer}` : null, o.orderNumber ? `order ${o.orderNumber}` : null].filter(Boolean).join(' · ')) })}
      ${o.why ? `<p class="why-line">${esc(o.why)}</p>` : ''}
      <div class="field"><span class="label-above">Whose is it?</span><div class="kidpick">${pickKids().map((k) => `<button class="chip has-face${k.jobId === o.kid ? ' hint' : ''}" type="button" data-assign="${esc(k.jobId)}" aria-pressed="${k.jobId === kid?.jobId}">${face(k, 32)}${esc(k.short)}</button>`).join('')}</div></div>
      ${kid ? `<div class="pick">${o.items.map((i, x) => `<div class="look"><b>${esc(i.name)}</b><span class="why">${esc(i.look)}</span>
        <select data-item="${x}" aria-label="Where ${esc(i.name)} goes">${optionsFor(kid, { undo: Boolean(o.undo), current: i.current || '', guess: i.current || (i.guesses?.[kid.jobId] ? `line:${i.guesses[kid.jobId]}` : 'also') })}</select></div>`).join('')}</div>
        <button class="btn btn-primary btn-big" type="button" id="save" data-focus>Save</button>` : ''}
      <button class="btn btn-text" type="button" id="notkid">Not a kid’s</button>`, { keep: true });
    document.querySelectorAll('#sheet-root [data-assign]').forEach((b) => { b.onclick = () => { kid = anyKid(b.dataset.assign); draw(); }; });
    const settle = async (items) => {
      try { await sendOrKeep('decide', { orderKey: o.key, items }); } catch (err) { toast(err.message); return; }
      state.needsLook = state.needsLook.filter((x) => x !== o);
      render();
      if (state.needsLook.length) looksSheet(true); else await close();
    };
    $('notkid').onclick = () => settle(o.items.map((i) => ({ itemName: i.name, decision: { type: 'notKid' } })));
    if ($('save')) $('save').onclick = () => settle(o.items.map((i, x) => ({ itemName: i.name, decision: decisionOf(kid, document.querySelector(`#sheet-root [data-item="${x}"]`).value) })));
  };
  draw();
}

// ─── Shelves and the printer ────────────────────────────────────────

function shelvesSheet(focus = '') {
  const p = state.printer || {};
  const rows = state.shelves.map((s) => {
    const kid = kidById(s.kid);
    return `<button class="look shelf-row${s.shelf === focus ? ' focus' : ''}" type="button" data-onshelf="${esc(s.shelf)}"><b>${esc(s.name)}</b>
      <span class="who">${kid ? `${face(kid, 24)}${esc(kid.short)}` : s.kid ? 'A finished makeover' : 'Free'}${s.things ? ` · ${plural(s.things, 'thing')}` : ''}</span></button>`;
  }).join('');
  openSheet(`${head('Shelves', { sub: `${state.shelves.filter((s) => s.kid).length} of ${state.shelves.filter((s) => s.shelf !== 'Floor').length} in use` })}
    <button class="printer-card" type="button" id="printer-setup"><span class="printer-pill ${!p.setUp ? 'off' : p.problems?.length ? 'warn' : p.online ? 'ok' : 'off'}"><i aria-hidden="true"></i>${esc(!p.setUp ? 'Not set up' : p.problems?.length ? p.problems.join(', ') : p.online ? 'Ready' : 'Off or out of reach')}</span><b>Label printer</b>${ICON.chev}</button>
    <div class="pick">${rows}</div>
    <button class="btn btn-big" type="button" id="signs">Print the shelf signs</button>`, { keep: Boolean(sheetEl()) });
  $('printer-setup').onclick = printerSheet;
  $('signs').onclick = async () => {
    try { const out = await send('shelf-labels', { shelves: state.shelves.map((s) => s.shelf) }); toast(printSaid(out.print).text); } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('#sheet-root [data-onshelf]').forEach((b) => { b.onclick = () => shelfSheet(b.dataset.onshelf); });
  if (focus) document.querySelector('#sheet-root .shelf-row.focus')?.scrollIntoView({ block: 'center' });
}

/** What's on one shelf (the QR on the shelf's sign opens this, for load-out) */
function shelfSheet(shelf) {
  const s = state.shelves.find((x) => x.shelf === shelf);
  const kid = kidById(s?.kid);
  const things = state.kids.flatMap((k) => k.items.filter((i) => (i.status === 'here' || i.status === 'partly') && i.shelf === shelf).map((i) => ({ k, i })));
  openSheet(`${head(esc(shelfName(shelf)), { sub: kid ? esc(kid.short) : things.length ? '' : 'Free' })}
    ${things.length ? `<div class="pick">${things.map(({ k, i }) => rowHtml(k, i)).join('')}</div>` : '<p class="why-line">Nothing on it.</p>'}
    <button class="btn btn-text" type="button" id="back">All shelves</button>`, { keep: Boolean(sheetEl()) });
  $('back').onclick = () => shelvesSheet(shelf);
}

function printerSheet() {
  const p = state.printer || {};
  openSheet(`${head('Label printer', { sub: !p.setUp ? 'Once, when it’s new' : p.online ? 'Ready' : 'Off or out of reach' })}
    <ol class="steps">
      <li>Plug in the Zebra, load the labels and ribbon, and join it to the Office Wi-Fi in Zebra’s <b>Printer Setup Utility</b> app.</li>
      <li>On this phone, save the setup file: <a class="btn btn-text inline" href="/api/kid-items-admin?printer-setup=1" download="soard-printer-setup.txt">Get the setup file</a></li>
      <li>In Printer Setup Utility, open the printer, then <b>Files</b>, and send it the setup file. The printer restarts.</li>
      <li>In a minute this says Ready. Then print the shelf signs.</li>
    </ol>
    <dl class="facts"><dt>Connects to</dt><dd>${esc(state.printerUrl || '')}</dd><dt>Seen</dt><dd>${esc(p.seenAt ? ago(p.seenAt) : 'Not yet')}</dd>${p.waiting ? `<dt>Waiting</dt><dd>${plural(p.waiting, 'label')}</dd>` : ''}</dl>
    <button class="btn btn-text" type="button" id="back">Shelves</button>`, { keep: true });
  $('back').onclick = () => shelvesSheet();
}

// ─── Scan a box ─────────────────────────────────────────────────────

let stream = null;
const stopCamera = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; document.querySelectorAll('.cam').forEach((c) => c.remove()); };

/** The camera in the page, its shutter where Scan a box sits; the phone's own camera when the page can't have one */
async function scan() {
  if (!navigator.mediaDevices?.getUserMedia) { $('camera').click(); return; }
  if (camOpening || document.querySelector('.cam')) return;
  camOpening = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch {
    stream = null;
    $('camera').click();
    return;
  } finally {
    camOpening = false;
  }
  const cam = document.createElement('div');
  cam.className = 'cam';
  cam.innerHTML = `<video autoplay playsinline muted></video><div class="frame" aria-hidden="true"></div><div class="flash"></div>
    <div class="cam-top"><b class="cam-count">Label, packing slip or the product’s box</b></div>
    <button class="cam-close" type="button" aria-label="Close the camera">${ICON.x}</button>
    <button class="shutter" type="button" aria-label="Take the photo"></button>`;
  document.body.appendChild(cam);
  const video = cam.querySelector('video');
  video.srcObject = stream;
  cam.querySelector('.cam-close').onclick = stopCamera;
  cam.querySelector('.shutter').onclick = () => {
    if (!video.videoWidth) return;
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(video.videoWidth * scale); c.height = Math.round(video.videoHeight * scale);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    cam.querySelector('.flash').classList.add('on');
    const data = c.toDataURL('image/jpeg', 0.82);
    setTimeout(() => { stopCamera(); read(data, data); }, reduced() ? 0 : 180);
  };
}

/** A photo from the phone's own camera, made small enough to send quickly (labels read fine at 1600px) */
async function fromFile(file) {
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
    i.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That photo couldn’t be opened. Take it again.')); };
    i.src = url;
  });
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

async function read(image, preview) {
  openSheet(`${head('<span class="with-spin"><span class="spin" aria-hidden="true"></span>Reading the label</span>', { sub: '' })}
    <img class="photo" src="${preview}" alt="The photo of the box's label" />`, { label: 'Reading the label' });
  try {
    // The answer brings the list as it is now (an order read since this page loaded is on it): drawn behind the sheet
    const out = await send('scan', { image });
    render();
    showFound(out, preview);
  } catch (err) {
    openSheet(`${head('Couldn’t read that label', { sub: esc(err instanceof Offline ? 'No connection. Pick it from the list.' : err.message) })}
      <img class="photo" src="${preview}" alt="The photo of the box's label" />
      <button class="btn btn-primary btn-big" type="button" data-rescan="1" data-focus>Take it again</button>
      <button class="btn btn-text" type="button" data-close="1">Pick from the list</button>`, { keep: true });
  }
}

function showFound({ found, label, likely = [] }, preview) {
  // Its order is in Needs a look (its things fit more than one kid, or its PO names none): each thing to its kid
  if (found?.look) { const n = state.needsLook.findIndex((x) => x.key === found.look); if (n >= 0) { lookSheet(n); return; } }
  // Its order is known and nobody's yet: whose is it? (then it checks in like any shipment)
  if (found?.unplaced) { whoseSheet(state.shipments.find((x) => x.key === found.unplaced) || shipOfKnown(found.known), { how: found.how, keep: true }); return; }
  if (found?.known) { knownSheet(found, preview); return; }
  const kid = found && kidById(found.kid);
  const items = kid ? found.items.map((id) => kid.items.find((i) => i.id === id)).filter((i) => i && !isHere(i)) : [];
  state.foundBoxes = Number(label?.boxTotal) || 1;
  // The box's own order (its tracking or order number, the product's model): its shipment, what it matched ticked
  if (kid && found.done) {
    // Its order is all checked in: where its box goes, and its labels again if this one lost its own
    const sh = state.shipments.find((x) => x.key === found.order);
    const ins = kid.items.filter((i) => sh && i.order?.key === sh.key).flatMap((i) => (i.receipts || []).filter((r) => r.kind === 'receive' && !r.undone));
    openSheet(`${head('Everything from that order is checked in', { sub: esc(`${kid.short} · ${found.how}`) })}
      <div class="shelf-callout static"><span class="who">${face(kid, 36)}${esc(kid.short)}’s shelf</span><b>${esc(kid.shelf || 'Shelf')}</b></div>
      <div class="sheet-foot"><button class="btn btn-primary btn-big" type="button" data-rescan="1" data-focus>Scan the next box</button>
      <div class="btn-row"><button class="btn btn-text" type="button" data-close="1">Done</button>${ins.length ? '<button class="btn btn-text" type="button" id="reprintall">Print its labels again</button>' : ''}</div></div>`, { keep: true });
    if ($('reprintall')) $('reprintall').onclick = async () => { let said = null; for (const r of ins) { try { said = printSaid((await send('reprint', { tap: r.id })).print); } catch (err) { said = { text: err.message }; } } toast(said?.text || ''); };
    return;
  }
  const shipsOf = (list) => [...new Set(list.map((i) => state.shipments.find((x) => x.items.some((y) => y.id === i.id))?.key).filter(Boolean))];
  if (kid && items.length && found.exact) {
    const keys = shipsOf(items);
    if (keys.length === 1) { shipmentSheet(keys[0], { pick: items.map((i) => i.id), how: found.how, boxes: state.foundBoxes, keep: true }); return; }
  }
  // Only the kid's name, a PO or the product's words: the kid's shipments it could be, delivered first, for a tap
  if (kid && items.length) {
    const keys = shipsOf(items);
    const order = { delivered: 0, pickup: 1, out: 2, shipped: 3, ordered: 4, house: 5, in: 6 };
    const cards = keys.map((k) => state.shipments.find((x) => x.key === k)).sort((a, b) => order[a.stage] - order[b.stage]).slice(0, 8).map((x) => shipCard(x, { compact: true })).join('');
    if (cards) {
      openSheet(`${head(kidTitle(kid), { kid: true, sub: esc(`${found.how} · which shipment is it?`) })}
        <div class="ship-pick">${cards}</div>
        <button class="btn btn-text" type="button" data-rescan="1">Scan the packing slip or the product’s box</button>`, { keep: true });
      return;
    }
  }
  if (kid && items.length === 1) { itemSheet(kid, items[0], { found: found.how, keep: true, boxes: state.foundBoxes }); return; }
  if (kid && items.length) {
    openSheet(`${head(kidTitle(kid), { kid: true, sub: esc(found.how) })}
      <span class="label-above">Which is in the box?</span>
      <div class="pick">${items.map((i) => rowHtml(kid, i)).join('')}</div>`, { keep: true });
    return;
  }
  const bits = [label?.store, label?.po ? `PO ${label.po}` : null, ...(label?.trackingNumbers || []).map((t) => `…${t.slice(-6)}`), ...(label?.orderNumbers || []), ...(label?.references || []).map((r) => `Ref ${r}`)].filter(Boolean);
  // Nothing on the label ties it to an order (Amazon's and Crate & Barrel's emails never carry the box's tracking
  // number): the shipments it most likely came in (from the store the label names, delivered lately), then the rest
  // that were delivered and wait to be checked in, for one tap; or the packing slip inside
  // Best first, each with why: a shipment (a kid's, or nobody's yet), or a kid's thing no email has ordered
  const seen = new Set();
  const choices = [];
  for (const x of likely) {
    if (x.order) { if (!seen.has(x.order)) { seen.add(x.order); choices.push({ html: shipCard(state.shipments.find((s2) => s2.key === x.order), { compact: true }), why: x.why }); } continue; }
    const k = kidById(x.kid);
    const it = k?.items.find((i) => i.id === x.item);
    if (!it) continue;
    const sh = state.shipments.find((s2) => s2.items.some((i) => i.id === x.item));
    // A box at the Office isn't one going to the house, or one checked in already
    if (sh && ['in', 'house'].includes(stageOf(sh))) continue;
    if (sh) { if (!seen.has(sh.key)) { seen.add(sh.key); choices.push({ html: shipCard(sh, { compact: true }), why: x.why }); } continue; }
    choices.push({ html: `<button class="row has-face likely-row" type="button" data-kid="${esc(k.jobId)}" data-id="${esc(it.id)}">${face(k, 32)}<span class="row-name">${esc(it.name)}</span><span class="row-sub">${esc(`${k.short} · ${it.line}${it.order ? '' : ' · no order email'}`)}</span></button>`, why: x.why });
  }
  // Nothing on the label points anywhere: what was delivered and waits to be checked in
  if (!choices.length) for (const sh of state.shipments) if (stageOf(sh) === 'delivered' && choices.length < 6) choices.push({ html: shipCard(sh, { compact: true }), why: '' });
  const cards = choices.slice(0, 6).map((c) => `<div class="likely">${c.why ? `<span class="likely-why">${esc(c.why)}</span>` : ''}${c.html}</div>`).join('');
  openSheet(`${head(cards ? 'Which is it?' : 'Couldn’t match this box', { sub: bits.length ? `Read: ${bits.map(esc).join(' · ')}` : 'Nothing readable on the label' })}
    ${cards ? `<div class="ship-pick">${cards}</div>` : `<img class="photo" src="${preview}" alt="The photo of the box's label" />`}
    <div class="sheet-foot"><button class="btn ${cards ? '' : 'btn-primary '}btn-big" type="button" data-rescan="1"${cards ? '' : ' data-focus'}>Scan the packing slip or the product’s box</button>
    <div class="btn-row"><button class="btn btn-text" type="button" data-close="1">Pick from the list</button><button class="btn btn-text" type="button" data-other="1">Something else</button></div></div>`, { keep: true });
}

/** A box's order the site knows from its emails (the scan's answer) as a shipment to ask about */
const shipOfKnown = (k) => ({ key: k.key, store: k.store, orderNumber: k.orderNumber, orderedAt: k.at, buyer: k.buyer, things: k.things || [], items: [], unplaced: true,
  stage: k.stage || 'ordered', shippedAt: k.shippedAt || null, outAt: k.outAt || null, pickupAt: k.pickupAt || null, deliveredAt: k.deliveredAt || null, expected: k.expected || null });

/**
 * Whose an order is. Nobody's yet (no PO, and its things fit no one's selections: bought on an allowance, or for the
 * office), or a kid's by mistake (from: the kid it's on now). A kid: placed as for a PO with their name (their
 * selections, an allowance, or Also bought), and its shipment opens, to check in and print. Not a kid's: off the list
 * for good. Moving it off a kid takes back what was checked in for them (its labels name them), to check in again
 */
function whoseSheet(sh, { how = '', keep = false, from = null } = {}) {
  const was = from ? kidById(from) : null;
  const things = sh.things || sh.items.map((i) => { const it = itemOfId(i.id); return it ? { name: it.orderedAs || it.name, qty: it.qty } : null; }).filter(Boolean);
  // Checked in for the kid it's on: those check-ins come back off, so new labels print for the right kid
  const ins = was ? sh.items.flatMap((i) => (itemOfId(i.id)?.receipts || []).filter((r) => r.kind === 'receive' && !r.undone)) : [];
  const boxes = ins.reduce((t, r) => t + Math.max(1, r.boxes || 1), 0);
  openSheet(`${head(esc(sh.store), { sub: esc([how, sh.orderNumber ? `Order ${sh.orderNumber}` : null, sh.buyer ? `${sh.buyer} ordered it` : null, was ? null : shipStatus(sh)[1]].filter(Boolean).join(' · ')) })}
    <div class="pick">${things.map((t) => `<div class="look"><b>${esc(t.name)}</b>${t.qty > 1 ? `<span>${t.qty} of them</span>` : ''}</div>`).join('') || '<div class="look"><span>Its emails name no things</span></div>'}</div>
    <span class="label-above">Whose is it?</span>
    <div class="kidpick">${pickKids().map((k) => `<button class="chip has-face" type="button" data-whose="${esc(k.jobId)}"${was ? ` aria-pressed="${k.jobId === was.jobId}"` : ''}>${face(k, 32)}${esc(k.short)}</button>`).join('')}</div>
    ${boxes ? `<p class="why-line">${esc(`${plural(boxes, 'box', 'boxes')} of it ${boxes === 1 ? 'is' : 'are'} on ${was.short}’s shelf. Another kid takes ${boxes === 1 ? 'it' : 'them'} off, to check in again with new labels.`)}</p>` : ''}
    <div class="btn-row"><button class="btn btn-text" type="button" id="notkid">Not a kid’s</button></div>`, { keep, label: `${sh.store}: whose is it?` });
  const answer = async (decision, btn) => {
    if (was && decision.kid === was.jobId) { await close(); return; }
    const buttons = [...document.querySelectorAll('#sheet-root button')];
    const stop = (why) => { buttons.forEach((b) => { b.disabled = false; }); btn.classList.remove('working'); tones.warn(); toast(`Not saved: ${clean(why)}`); };
    buttons.forEach((b) => { b.disabled = true; });
    btn.classList.add('working');
    // What was checked in for the wrong kid comes back first (behind anything still waiting to be sent)
    if (ins.length) {
      let u;
      try { u = await undoTaps(ins.map((r) => r.id)); } catch (err) { stop(err.message); return; }
      if (u.refused.size) { stop([...u.refused.values()][0]); return; }
    }
    let r;
    try {
      r = await sendOrKeep('decide', { orderKey: sh.key, ...(was ? { from: was.jobId } : {}), items: [{ itemName: '*', decision }] });
    } catch (err) { stop(err.message); return; }
    if (decision.type === 'notKid') { tones.undo(); await close(); render(); toast(`${sh.store}: not a kid’s, off the list`); return; }
    const kid = anyKid(decision.kid);
    if (r.queued) { await close(); render(); toast(`${kid?.short || 'Their'}’s. It goes on their list when the connection is back`); return; }
    // What the site placed: its shipment, ready to check in and print; anything it couldn't place is asked about
    const placed = r.out?.placed;
    const now = state.shipments.find((x) => x.key === sh.key && !x.unplaced);
    const look = state.needsLook.findIndex((x) => x.key === sh.key);
    tones.ok();
    if (placed?.things && now && waitingOf(now).length) { shipmentSheet(now.key, { keep: true, how: `${kid?.short}’s` }); return; }
    if (look >= 0) { lookSheet(look); return; }
    await close();
    render();
    toast(placed?.things ? `${sh.store}: ${kid?.short}’s` : `Saved, but nothing in it went on ${kid?.short}’s list`);
  };
  document.querySelectorAll('#sheet-root [data-whose]').forEach((b) => { b.onclick = () => answer({ type: 'kid', kid: b.dataset.whose }, b); });
  $('notkid').onclick = () => answer({ type: 'notKid' }, $('notkid'));
}

/** A box whose order the emails know but no list has (marked not a kid's, too old, or no things read): whose it is, or typed in */
function knownSheet(found, preview) {
  const k = found.known;
  const sh = shipOfKnown(k);
  if (k.things?.length) { whoseSheet(sh, { how: `${found.how} · on no list`, keep: true }); return; }
  openSheet(`${head(esc(k.store), { sub: esc([found.how, k.orderNumber ? `Order ${k.orderNumber}` : null, shipStatus(sh)[1]].filter(Boolean).join(' · ')) })}
    <p class="why-line">Its emails don’t say what’s in it. Scan the packing slip or the product’s box, or type it in.</p>
    <img class="photo" src="${preview}" alt="The photo of the box's label" />
    <div class="sheet-foot"><button class="btn btn-primary btn-big" type="button" data-rescan="1" data-focus>Scan the packing slip or the product’s box</button>
    <div class="btn-row"><button class="btn btn-text" type="button" data-close="1">Pick from the list</button><button class="btn btn-text" type="button" data-other="1">Something else</button></div></div>`, { keep: true });
}

// ─── Wiring ─────────────────────────────────────────────────────────

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, .scrim');
  if (!t) return;
  if (t.dataset.close && (t === e.target || t.tagName === 'BUTTON')) { close(); return; }
  if (t.dataset.rescan) { await close(); scan(); return; }
  if (t.dataset.other) { otherSheet(); return; }
  if (t.id === 'looks') { looksSheet(); return; }
  if (t.dataset.look) { lookSheet(Number(t.dataset.look)); return; }
  if (t.dataset.chip) { state.filter = t.dataset.chip; render(); window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); return; }
  if (t.dataset.here) { state.openHere.add(t.dataset.here); render(); return; }
  if (t.dataset.allhere) { const k = kidById(t.dataset.allhere); if (k) allHereSheet(k); return; }
  if (t.dataset.ship) { shipmentSheet(t.dataset.ship, { keep: Boolean(t.closest('.sheet')) }); return; }
  if (t.dataset.shipsection) { (state.openShips ||= new Set()).add(t.dataset.shipsection); render(); return; }
  if (t.dataset.loadkid) { state.loadKid = t.dataset.loadkid; render(); window.scrollTo({ top: 0 }); return; }
  if (t.dataset.back) { state.loadKid = null; render(); window.scrollTo({ top: 0 }); return; }
  if (t.dataset.tick) { tick(t.dataset.kid, t.dataset.tick); return; }
  if (t.dataset.missing) { (state.openMissing ||= new Set()).add(t.dataset.missing); render(); return; }
  if (t.dataset.loaded) { (state.openLoaded ||= new Set()).add(t.dataset.loaded); render(); return; }
  if (t.dataset.opennone) { state.openNone = true; render(); return; }
  if (t.classList.contains('row') && t.dataset.id) {
    const kid = kidById(t.dataset.kid);
    const it = kid?.items.find((i) => i.id === t.dataset.id);
    const inSheet = Boolean(t.closest('.sheet'));
    if (it) itemSheet(kid, it, { keep: inSheet, found: inSheet && !isHere(it) ? 'In this box' : '', boxes: inSheet ? state.foundBoxes : 1 });
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const c = document.querySelector('.cam:not(.leaving) .cam-close'); if (c) c.click(); else close(); } });
$('q').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
// The dock's second button: Something else when checking in, Load all when loading a kid out
$('other').addEventListener('click', () => {
  if (state.mode !== 'out') { otherSheet(); return; }
  tones.wake();
  if (load.size) { scanLabels(kidById(state.loadKid) || null); return; }
  const k = kidById(state.loadKid);
  if (k) addAll(k);
});
$('other2').addEventListener('click', () => { tones.wake(); const k = kidById(state.loadKid); if (k) addAll(k); });
$('scan').addEventListener('click', () => {
  if (state.mode !== 'out') { scan(); return; }
  tones.wake();
  if (load.size) confirmLoad(); else scanLabels(kidById(state.loadKid) || null);
});

document.querySelectorAll('.seg [data-mode]').forEach((b) => b.addEventListener('click', () => {
  if (state.mode === b.dataset.mode) return;
  state.mode = b.dataset.mode;
  state.openHere.clear();
  render();
  window.scrollTo({ top: 0 });
}));
$('printer').addEventListener('click', () => shelvesSheet());
$('queue').addEventListener('click', () => { if (state.signedOut) location.reload(); else flush(); });
$('camera').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  const preview = URL.createObjectURL(f);
  try { read(await fromFile(f), preview); } catch (err) { openSheet(`${head('Couldn’t read that photo', { sub: esc(err.message) })}<button class="btn btn-primary btn-big" type="button" data-rescan="1" data-focus>Take it again</button>`); }
});
window.addEventListener('pagehide', stopCamera);

/** A QR on a label (?r=…) or a shelf sign (?shelf=…) opens what it's for */
function openFromLink() {
  const q = new URLSearchParams(location.search);
  const r = q.get('r'), shelf = q.get('shelf'), box = Number(q.get('b')) || null;
  if (!r && !shelf) return;
  history.replaceState(null, '', location.pathname);
  if (shelf) { shelfSheet(shelf); return; }
  for (const k of state.kids) {
    const it = k.items.find((i) => (i.receipts || []).some((x) => x.id === r));
    if (it) { itemSheet(k, it, { ref: r, box }); return; }
  }
  toast('That label’s item isn’t on the list any more (its makeover may be finished).');
}

async function loadPage() {
  try {
    const res = await fetch('/api/kid-items-admin?checkin=1', { headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.error || `The site answered ${res.status}`);
    apply(body);
    // A makeover's Project Manager loads out: the page opens on Check out for them (Peter, Nov 10 2026)
    state.me = body.me || null;
    if (!state.loadedOnce) state.mode = state.me?.pm || load.size ? 'out' : 'in';
    state.loadedOnce = true;
    state.printerUrl = body.printerUrl || '';
    upgradeQueue();
    overlayQueue();
    render();
    showQueue();
    openFromLink();
    flush();
  } catch (err) {
    $('list').innerHTML = `<div class="empty"><span>The list didn’t load. ${esc(err.message)}</span><button class="btn" type="button" id="retry">Try again</button></div>`;
    $('retry').onclick = () => { $('list').innerHTML = '<div class="hold"></div><div class="hold"></div>'; loadPage(); };
  }
}
loadPage();

// ─── A page left open is never yesterday's ──────────────────────────
// Peter, Nov 11 2026: the site found his box ("whose is it?"), but his phone still ran the page from before the update,
// which didn't know that answer. The page checks its own files (a few bytes: their tags, not the files) every few
// minutes and whenever the phone comes back to it; changed, it reloads itself at a quiet moment: no sheet or camera up,
// nothing being sent. What's in a load and what waits to be sent are kept on the phone, so nothing is lost
const OWN_FILES = ['./checkin.js', './checkin.css', './'];
let ownTags = null;
let updated = false;
async function ownVersion() {
  try {
    const tags = await Promise.all(OWN_FILES.map(async (u) => {
      const r = await fetch(u, { method: 'HEAD', cache: 'no-cache', redirect: 'manual', credentials: 'same-origin' });
      // A sign-in that ran out (a redirect) or no answer: nothing to compare
      return r.ok ? r.headers.get('etag') || r.headers.get('last-modified') || '' : null;
    }));
    return tags.includes(null) ? null : tags.join('|');
  } catch {
    return null;
  }
}
async function checkForUpdate() {
  if (updated) { reloadWhenQuiet(); return; }
  const now = await ownVersion();
  if (now == null) return;
  if (ownTags == null) { ownTags = now; return; }
  if (now !== ownTags) { updated = true; reloadWhenQuiet(); }
}
function reloadWhenQuiet() {
  if (!updated || document.visibilityState !== 'visible') return;
  if (sheetEl() || document.querySelector('.cam') || flushing || camOpening) return;
  location.reload();
}
checkForUpdate();
setInterval(checkForUpdate, 3 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });

// ─── Check out: load-out to the house ───────────────────────────────
// Christian loads one makeover at a time: pick the kid, then their boxes by shelf, ticked off by scanning each label
// (or a tap). Another kid's box is stopped, every scan is heard, and the end says what isn't here yet.

const STAGE_RANK = { Build: 0, Mobilization: 1, Design: 2 };

/**
 * What's out of an item, box by box: the same rule as the site's (functions/api/_kid-record.js outState). Every
 * check-out names one box of one check-in, so a thing is out only when each of its boxes is. A box waiting on this
 * phone to be sent counts as out, and one taken back here as back
 */
function outStateOf(it) {
  const live = (it.receipts || []).filter((r) => !r.undone);
  const outs = live.filter((r) => r.kind === 'out');
  const per = new Map();
  let got = 0, sent = 0, boxesLeft = 0, allOut = true;
  for (const r of live.filter((x) => x.kind === 'receive')) {
    const total = Math.max(1, r.boxes || 1);
    const units = r.units || 0;
    got += units;
    const mine = outs.filter((o) => o.ref === r.id);
    const boxes = new Set(mine.some((o) => !o.box) ? Array.from({ length: total }, (_, n) => n + 1) : mine.map((o) => Number(o.box)).filter((b) => b >= 1 && b <= total));
    const full = boxes.size >= total;
    sent += full ? units : Math.floor((units * boxes.size) / total);
    if (!full) { boxesLeft += total - boxes.size; allOut = false; }
    per.set(r.id, { full, boxes, total, shelf: r.shelf });
  }
  return { got, sent, allOut: got > 0 && allOut, boxesLeft, per };
}
/** Its boxes still at the Office, oldest check-in first: { ref, box, of, shelf } */
function boxesHere(it) {
  const list = [];
  for (const [ref, p] of outStateOf(it).per) for (let b = 1; b <= p.total; b++) if (!p.boxes.has(b)) list.push({ ref, box: b, of: p.total, shelf: p.shelf });
  return list;
}
/** Its boxes on the truck: { id (the check-out), ref, box, of, n, at, who, waiting } */
function boxesOut(it) {
  const per = outStateOf(it).per;
  return (it.receipts || []).filter((r) => !r.undone && r.kind === 'out' && per.has(r.ref))
    .map((r) => ({ id: r.id, ref: r.ref, box: r.box || null, of: per.get(r.ref).total, n: r.box ? 1 : per.get(r.ref).total, at: r.at, who: r.who, waiting: Boolean(r.waiting) }));
}
const boxesLeft = (it) => outStateOf(it).boxesLeft;
const boxesIn = (it) => (it.receipts || []).filter((r) => !r.undone && r.kind === 'receive').reduce((t, r) => t + Math.max(1, r.boxes || 1), 0);
// Two is "both": "Take both boxes back", not "Take all 2 boxes back"
const allOf = (n, cap = false) => (n === 2 ? (cap ? 'Both' : 'both') : `${cap ? 'All' : 'all'} ${n}`);
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const shelfRank = (s) => (s === 'Floor' ? 99 : Number(s) || 98);
/** Where boxes are, in words: "Shelf 1", "Shelves 1 and 3", "Shelf 1 and the Floor", "the Floor" */
function placesWords(shelves) {
  const list = [...new Set(shelves.filter(Boolean))].sort((a, b) => shelfRank(a) - shelfRank(b));
  const nums = list.filter((s) => s !== 'Floor');
  const words = nums.length === 1 ? [`Shelf ${nums[0]}`] : nums.length ? [`Shelves ${nums[0]}`, ...nums.slice(1)] : [];
  if (list.includes('Floor')) words.push('the Floor');
  return andList(words);
}
/** A kid at load-out: what's at the Office (and where), what's loaded, what's in this load, what isn't here yet */
const kidLoad = (kid) => {
  const things = kid.items.filter((i) => i.status !== 'house');
  const atOff = things.filter((i) => boxesLeft(i) > 0);
  const here = atOff.flatMap(boxesHere);
  const done = things.reduce((t, i) => t + Math.max(0, boxesIn(i) - boxesLeft(i)), 0);
  return {
    load: atOff, left: here.length, done, total: here.length + done, places: here.map((b) => b.shelf),
    inLoad: [...load.values()].filter((e) => e.jobId === kid.jobId).length,
    missing: kid.items.filter((i) => ['ordered', 'not', 'partly'].includes(i.status)),
    out: kid.items.filter((i) => i.status === 'out' || i.status === 'house'),
  };
};
const boxWord = (n) => plural(n, 'box', 'boxes');
const notHereYet = (n) => (n === 1 ? '1 thing isn’t here yet' : `${n} things aren’t here yet`);

// ─── This load: each box scanned or ticked, saved only on Confirm ───
// Peter, Nov 10 2026: "then it can be updated in JT after he confirms", "in case they accidently scan something"
const LOAD_KEY = 'soard-checkout-load';
const boxKey = (ref, box) => `box:${ref}#${box}`;
const load = new Map((() => { try { return JSON.parse(localStorage.getItem(LOAD_KEY) || '[]'); } catch { return []; } })().map((e) => [e.key, e]));
const saveLoad = () => { try { localStorage.setItem(LOAD_KEY, JSON.stringify([...load.values()])); } catch { /* private window: kept for this visit */ } };
const loadBoxes = () => load.size;
const entryOf = (k, i, b) => ({ key: boxKey(b.ref, b.box), tap: newTap(), ref: b.ref, box: b.box, of: b.of, jobId: k.jobId, kid: k.short, row: i.id, name: i.name });
const findByRef = (ref) => state.kids.flatMap((k) => k.items.map((i) => ({ k, i }))).find(({ i }) => (i.receipts || []).some((r) => r.id === ref && r.kind === 'receive' && !r.undone));
/** How much of a thing is in this load: { here (its boxes at the Office), n (of them in the load), all } */
const inLoadOf = (it) => { const here = boxesHere(it); const n = here.filter((b) => load.has(boxKey(b.ref, b.box))).length; return { here, n, all: here.length > 0 && n === here.length }; };
const scopeKid = () => kidById(state.loadKid) || kidById([...load.values()][0]?.jobId) || null;

/**
 * The load against the list as it is now: a box whose check-in was undone, or that another phone loaded first, comes
 * out of it and it's said once; a load kept by an older copy of this page (whole things, not boxes) is put in boxes
 */
function pruneLoad() {
  let undone = 0, already = 0;
  for (const e of [...load.values()]) {
    if (e.kind === 'item' || !e.box) {
      load.delete(e.key);
      const k = kidById(e.jobId);
      const f = e.ref ? findByRef(e.ref) : (() => { const i = k?.items.find((x) => x.itemId === e.itemId && x.partKey === e.partKey); return i ? { k, i } : null; })();
      if (f) for (const b of boxesHere(f.i)) if ((!e.ref || b.ref === e.ref) && !load.has(boxKey(b.ref, b.box))) load.set(boxKey(b.ref, b.box), entryOf(f.k, f.i, b));
      continue;
    }
    const f = findByRef(e.ref);
    if (!f) { load.delete(e.key); undone++; continue; }
    if (outStateOf(f.i).per.get(e.ref)?.boxes.has(e.box)) { load.delete(e.key); already++; continue; }
    // Its thing moved to another line (read later): the row it's under now
    e.row = f.i.id;
    e.name = f.i.name;
  }
  saveLoad();
  if (undone) toast(`${boxWord(undone)} came out of this load: the check-in was undone`);
  else if (already) toast(`${boxWord(already)} came out of this load: loaded on another phone`);
}

function addItem(kid, it) {
  for (const b of boxesHere(it)) if (!load.has(boxKey(b.ref, b.box))) load.set(boxKey(b.ref, b.box), entryOf(kid, it, b));
  saveLoad();
}
function dropItem(kid, it) {
  for (const b of boxesHere(it)) load.delete(boxKey(b.ref, b.box));
  saveLoad();
}

function renderOut() {
  const kid = kidById(state.loadKid);
  if (kid) renderLoad(kid); else renderOutHome();
  renderDock();
}
const confirmWords = (n) => `Confirm ${boxWord(n)} out`;
const reviewWords = (n) => `Review ${boxWord(n)}`;
/**
 * The dock, by itself (the list stays as it is, so nothing jumps): Scan boxes, and Load all on a kid's page; with boxes
 * in the load, Review them, Scan more, and Load the other N when the kid has more at the Office
 */
function renderDock() {
  const n = loadBoxes();
  const kid = kidById(state.loadKid);
  const l = kid ? kidLoad(kid) : null;
  const rest = l ? Math.max(0, l.left - l.inLoad) : 0;
  $('scan').classList.toggle('confirming', Boolean(n));
  $('scan').querySelector('span').textContent = n ? reviewWords(n) : 'Scan boxes';
  $('other').textContent = n ? 'Scan more' : rest ? (rest === 1 ? 'Load 1 box' : `Load ${allOf(rest)} boxes`) : '';
  $('other2').textContent = n && rest ? (l.inLoad ? `Load the other ${rest}` : rest === 1 ? 'Load 1 box' : `Load ${allOf(rest)} boxes`) : '';
  $('other2').hidden = !(n && rest);
  paintTabs();
}
/** The Check out tab carries what's in the load (so it's seen from Check in too) */
function paintTabs() {
  const b = document.querySelector('.seg [data-mode="out"]');
  if (b) b.textContent = load.size ? `Check out · ${load.size}` : 'Check out';
}

/** Check out: scan any box straight away; or pick a kid to see their boxes and tick them off. Kids with nothing at the Office fold into one line */
function renderOutHome() {
  const q = state.query.toLowerCase();
  const all = state.kids.map((k) => ({ k, l: kidLoad(k) }))
    .filter(({ k }) => !q || [k.short, ...k.items.map((i) => i.name)].some((x) => String(x).toLowerCase().includes(q)))
    .sort((a, b) => (STAGE_RANK[a.k.stage] ?? 9) - (STAGE_RANK[b.k.stage] ?? 9) || b.l.left - a.l.left);
  const ready = all.filter(({ l }) => l.left || l.done);
  const none = all.filter(({ l }) => !l.left && !l.done);
  // Name and stage on top; how many and where each on a line of its own, never cut off
  const tile = ({ k, l }) => `
    <button class="kid-tile" type="button" data-loadkid="${esc(k.jobId)}">
      ${face(k, 56)}
      <span class="kt-body"><span class="kt-name"><b>${esc(k.short)}</b>${k.stage ? `<span class="kt-stage">${esc(k.stage)}</span>` : ''}</span>
        <span class="kt-line">${l.left ? `${boxWord(l.left)} at the Office` : l.done ? `${l.done === 1 ? '1 box' : `${allOf(l.done, true)} boxes`} loaded` : 'Nothing at the Office yet'}${l.inLoad ? ` · <em>${l.inLoad} in this load</em>` : ''}</span>
        ${l.left ? `<span class="kt-line">On ${esc(placesWords(l.places) || 'a shelf')}</span>` : ''}
        ${l.missing.length ? `<span class="kt-line">${notHereYet(l.missing.length)}</span>` : ''}</span>
      ${ICON.chev}
    </button>`;
  let html = ready.map(tile).join('');
  if (none.length) {
    html += state.openNone || state.query
      ? `<div class="label-above out-q">Nothing at the Office yet</div>${none.map(tile).join('')}`
      : `<button class="more muted-row" type="button" data-opennone="1"><span>${plural(none.length, 'kid')} with nothing at the Office yet: ${esc(none.map(({ k }) => k.short).join(', '))}</span>${ICON.chev}</button>`;
  }
  $('list').innerHTML = html || `<div class="empty">${state.query ? 'Nothing matches that.' : 'No makeovers to load.'}</div>`;
  showPrinter();
}

/** The count by a kid's name: loaded of all, and what's in this load (the bar's yellow part) */
const headCount = (l) => (!l.left && l.done && !l.inLoad
  ? `<span class="chip-ok">${l.done === 1 ? '1 box' : `${allOf(l.done, true)} boxes`} loaded</span>`
  : `<b>${l.done}</b> of ${l.total}<br><span>loaded</span><br><span class="in-load${l.inLoad ? '' : ' none'}">${l.inLoad ? `${l.inLoad} in this load` : 'none in this load'}</span>`);
const barHtml = (kid, l) => `<div class="bar" aria-hidden="true"><i data-bar="${esc(kid.jobId)}" style="transform:scaleX(${l.total ? l.done / l.total : 0})"></i><b class="bar-load" style="left:${l.total ? (100 * l.done) / l.total : 0}%;width:${l.total ? (100 * l.inLoad) / l.total : 0}%"></b></div>`;
function paintKidHead(kid) {
  const l = kidLoad(kid);
  const c = document.querySelector('#list .load-head .count');
  if (c) c.innerHTML = headCount(l);
  const b = document.querySelector('#list .load-head .bar-load');
  if (b) { b.style.left = `${l.total ? (100 * l.done) / l.total : 0}%`; b.style.width = `${l.total ? (100 * l.inLoad) / l.total : 0}%`; }
}

/** One kid: their boxes by shelf (a tick puts its boxes in the load), what isn't here yet, what's loaded. The search finds things */
function renderLoad(kid) {
  const l = kidLoad(kid);
  const q = state.query.toLowerCase();
  const match = (i) => !q || [i.name, i.line].some((x) => String(x || '').toLowerCase().includes(q));
  const placeOf = (it) => boxesHere(it).at(-1)?.shelf || it.shelf || '';
  const byShelf = new Map();
  for (const it of l.load.filter(match)) byShelf.set(placeOf(it), [...(byShelf.get(placeOf(it)) || []), it]);
  const shelves = [...byShelf].sort((a, b) => shelfRank(a[0]) - shelfRank(b[0]));
  const missing = l.missing.filter(match);
  const out = l.out.filter(match);
  let html = `<button class="back" type="button" data-back="1">${ICON.chev}<span>All kids</span></button>
    <section class="card load-head" aria-label="${esc(kid.short)}">
      <div class="card-head">
        <div class="card-title"><div class="who">${face(kid, 56)}<div><h2>${esc(kid.short)}</h2>${kid.stage ? `<span class="kt-stage">${esc(kid.stage)}</span>` : ''}</div></div>
          <span class="count big">${headCount(l)}</span></div>
        ${barHtml(kid, l)}
      </div>
    </section>`;
  if (shelves.length) {
    html += '<section class="card">';
    for (const [shelf, items] of shelves) {
      const n = items.reduce((t, i) => t + boxesLeft(i), 0);
      html += `<div class="shelf-h"><span class="shelf-block">${esc(shelfName(shelf) || 'At the Office')}</span><span>${boxWord(n)}</span></div>${items.map((i) => loadRow(kid, i)).join('')}`;
    }
    html += '</section>';
  } else if (q && !missing.length && !out.length) {
    html += '<div class="empty">Nothing matches that.</div>';
  } else if (!l.done && !q) {
    html += '<div class="empty">Nothing for them at the Office yet.</div>';
  }
  if (missing.length) {
    html += `<section class="card">${state.openMissing?.has(kid.jobId) || q
      ? `<div class="group-h warn"><span>Not here yet</span><span>${missing.length}</span></div>${missing.map((i) => rowHtml(kid, i)).join('')}`
      : `<button class="more warn" type="button" data-missing="${esc(kid.jobId)}"><span>${notHereYet(missing.length)}</span>${ICON.chev}</button>`}</section>`;
  }
  if (out.length) {
    html += `<section class="card">${state.openLoaded?.has(kid.jobId) || q
      ? `<div class="group-h"><span>Loaded</span><span>${plural(out.length, 'thing')}</span></div>${out.map((i) => loadRow(kid, i)).join('')}`
      : `<button class="more" type="button" data-loaded="${esc(kid.jobId)}"><span>${plural(out.length, 'thing')} loaded</span>${ICON.chev}</button>`}</section>`;
  }
  $('list').innerHTML = html;
  showPrinter();
}

/**
 * Boxes in words, the way the labels say them: "Box 2 of 3", "Boxes 2 and 3 of 3" when the thing came in once in
 * three boxes or fewer (a label's own number is the quickest check); else a count. list: [{ box, of, n? }]
 */
function boxesSaid(it, list, { cap = true } = {}) {
  const n = list.reduce((t, b) => t + (b.n || 1), 0);
  const of = list[0]?.of || 1;
  const nums = list.map((b) => b.box).filter(Boolean).sort((a, b) => a - b);
  if (outStateOf(it).per.size === 1 && of > 1 && of <= 3 && nums.length === list.length) return `${cap ? 'B' : 'b'}ox${nums.length > 1 ? 'es' : ''} ${andList(nums)} of ${of}`;
  return boxWord(n);
}

/** A row's state: its circle empty, half (some of its boxes in this load), yellow (all of them), green (loaded) */
function rowState(it) {
  const done = it.status === 'out' || it.status === 'house';
  const { here, n, all } = inLoadOf(it);
  const outs = boxesOut(it);
  const onTruck = outs.reduce((t, o) => t + o.n, 0);
  const inLoadNow = here.filter((b) => load.has(boxKey(b.ref, b.box)));
  const rest = here.filter((b) => !load.has(boxKey(b.ref, b.box)));
  const places = [...new Set(here.map((b) => b.shelf))];
  const named = outStateOf(it).per.size === 1 && (here[0]?.of || outs[0]?.of || 1) <= 3;
  let sub;
  if (it.status === 'house') sub = 'Went straight to the house';
  else if (done) sub = onTruck > 1 ? `${allOf(onTruck, true)} boxes loaded` : 'Loaded';
  else if (all) sub = here.length === 1 ? 'In this load' : `${allOf(here.length, true)} in this load`;
  else if (n) sub = named ? `${boxesSaid(it, inLoadNow)} in this load · ${boxesSaid(it, rest, { cap: false })} still here` : `${n} in this load · ${rest.length} still here`;
  else sub = `${named && onTruck ? boxesSaid(it, here) : boxWord(here.length)}${places.length > 1 ? ` on ${placesWords(places)}` : ''}`;
  if (!done && onTruck) sub += ` · ${named ? boxesSaid(it, outs, { cap: false }) : onTruck} on the truck`;
  return {
    done, pending: !done && n > 0, part: !done && n > 0 && !all,
    pressed: done ? 'true' : n ? 'mixed' : 'false',
    label: done ? `Take back: ${it.name}` : all ? `Take out of this load: ${it.name}` : n ? `Add ${named ? boxesSaid(it, rest, { cap: false }) : `the other ${rest.length}`} to this load: ${it.name}` : `Add to this load: ${it.name}`,
    sub: [it.line, sub].filter(Boolean).join(' · '),
  };
}
function loadRow(kid, it) {
  const s = rowState(it);
  return `<div class="lrow${s.done ? ' done' : ''}${s.pending ? ' pending' : ''}${s.part ? ' part' : ''}" data-row="${esc(it.id)}">
    <button class="tickbtn" type="button" data-kid="${esc(kid.jobId)}" data-tick="${esc(it.id)}" aria-pressed="${s.pressed}" aria-label="${esc(s.label)}"${it.status === 'house' ? ' disabled' : ''}>${ICON.tick}</button>
    <button class="row lrow-main" data-kid="${esc(kid.jobId)}" data-id="${esc(it.id)}" type="button"><span class="row-name">${esc(it.name)}</span><span class="row-sub">${esc(s.sub)}</span></button>
  </div>`;
}
/** The row changes where it is (so its fill and tick animate): false when it isn't on the page */
function paintRow(it) {
  const row = document.querySelector(`#list .lrow[data-row="${CSS.escape(it.id)}"]`);
  if (!row) return false;
  const s = rowState(it);
  row.classList.toggle('done', s.done);
  row.classList.toggle('pending', s.pending);
  row.classList.toggle('part', s.part);
  const b = row.querySelector('.tickbtn');
  b.setAttribute('aria-pressed', s.pressed);
  b.setAttribute('aria-label', s.label);
  row.querySelector('.row-sub').textContent = s.sub;
  return true;
}

/** The circle: all its boxes into the load (the rest, when some are in already) or out of it; loaded, it opens Take back */
function tick(jobId, id) {
  const kid = kidById(jobId);
  const it = kid?.items.find((i) => i.id === id);
  if (!it || it.status === 'house') return;
  tones.wake();
  if (it.status === 'out') { takeBackSheet(kid, it); return; }
  if (inLoadOf(it).all) { dropItem(kid, it); tones.undo(); } else { addItem(kid, it); tones.ok(); }
  if (!paintRow(it)) { render(); return; }
  paintKidHead(kid);
  renderDock();
}

/** One box (or an older label's whole check-in) on the truck, in words: "Box 1 of 3 · Nov 11 · Christian" */
const truckLine = (it, o) => [o.box && o.of > 1 ? `Box ${o.box} of ${o.of}` : o.n > 1 ? boxWord(o.n) : '1 box', o.waiting ? 'waiting to send' : dayOf(o.at), o.who].filter(Boolean).join(' · ');
/** On the truck, a box a row, each with its own Take back (one box that won't fit comes off by itself) */
const truckRows = (it, outs) => (outs.length ? `<div class="label-above">On the truck</div><div class="receipts">${outs.map((o) => `<div class="receipt"><span>${esc(truckLine(it, o))}</span><button class="tag-here as-btn" type="button" data-takeone="${esc(o.id)}" aria-label="Take ${esc(o.box && o.of > 1 ? `box ${o.box}` : 'it')} back off the truck">Take back</button></div>`).join('')}</div>` : '');
const bindTakeOne = (it, outs) => document.querySelectorAll('#sheet-root [data-takeone]').forEach((b) => { b.onclick = () => takeBack(it, outs.filter((o) => o.id === b.dataset.takeone), b); });

/** Loaded: its boxes on the truck, each can come back by itself, or all of them in one go; never by a stray tap */
function takeBackSheet(kid, it, { keep = false } = {}) {
  const outs = boxesOut(it);
  const n = outs.reduce((t, o) => t + o.n, 0);
  openSheet(`${head(kidTitle(kid), { kid: true })}
    <p class="item-name">${esc(it.name)}</p>
    ${n > 1 ? truckRows(it, outs) : `<div class="receipts"><div class="receipt"><span>${esc(truckLine(it, outs[0]))}</span></div></div>`}
    <div class="sheet-foot"><button class="btn btn-big" type="button" id="takeback" data-focus>${n === 1 ? 'Take it back off the truck' : `Take ${allOf(n)} boxes back`}</button></div>`, { keep });
  $('takeback').onclick = () => takeBack(it, outs, $('takeback'));
  bindTakeOne(it, outs);
}

/** Back off the truck: one request for every box, the button says it's working, and the phone shows it at once */
async function takeBack(it, outs, btn) {
  if (btn.disabled) return;
  const n = outs.reduce((t, o) => t + o.n, 0);
  const per = outStateOf(it).per;
  const placesBefore = outs.map((o) => per.get(o.ref)?.shelf);
  const buttons = [...document.querySelectorAll('#sheet-root button')];
  buttons.forEach((b) => { b.disabled = true; });
  const words = btn.innerHTML;
  btn.classList.add('working');
  btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${btn.classList.contains('as-btn') ? 'Taking back' : `Taking back ${boxWord(n)}`}`;
  let r;
  const undo = () => { buttons.forEach((b) => { b.disabled = false; }); btn.classList.remove('working'); btn.innerHTML = words; tones.warn(); };
  try {
    r = await undoTaps(outs.map((o) => o.id));
  } catch (err) {
    undo();
    toast(`Not taken back: ${clean(err.message)}`);
    return;
  }
  const failed = [...r.refused];
  if (failed.length === outs.length) { undo(); toast(`Not taken back: ${failed[0][1]}`); return; }
  const answers = [...r.answers.values()];
  const back = n - failed.reduce((t, [tap]) => t + (outs.find((o) => o.id === tap)?.n || 1), 0);
  const where = placesWords(answers.some((x) => x?.shelf) ? answers.map((x) => x?.shelf) : placesBefore);
  const moved = answers.some((x) => x?.moved);
  tones.undo();
  await close();
  render();
  toast(failed.length
    ? `${boxWord(back)} back. Not taken back: ${failed[0][1]}`
    : `${n === 1 ? 'Back' : `${n} boxes back`} at the Office${where ? `. Put ${n === 1 ? 'it' : 'them'} on ${where}` : ''}${moved ? '. A new label is printing' : ''}`);
}

/** A label read (by the scanner, or opened by the phone's own camera): whose box, and can it go in this load */
function boxVerdict(ref, box) {
  const found = findByRef(ref);
  if (!found) return { v: 'gone' };
  const p = outStateOf(found.i).per.get(ref);
  if (box && !(box >= 1 && box <= p.total)) return { v: 'gone' };
  const boxes = box ? [box] : Array.from({ length: p.total }, (_, n) => n + 1).filter((x) => !p.boxes.has(x));
  const base = { found, ref, of: p.total, boxes };
  if (!boxes.length || (box && p.boxes.has(box))) return { ...base, v: 'out', outs: boxesOut(found.i).filter((o) => o.ref === ref && (!box || !o.box || o.box === box)) };
  if (boxes.every((x) => load.has(boxKey(ref, x)))) return { ...base, v: 'inLoad' };
  const scoped = scopeKid();
  if (scoped && scoped.jobId !== found.k.jobId) return { ...base, v: 'otherKid', scoped };
  return { ...base, v: 'ok' };
}
const addBoxes = (v) => {
  for (const x of v.boxes) if (!load.has(boxKey(v.ref, x))) load.set(boxKey(v.ref, x), entryOf(v.found.k, v.found.i, { ref: v.ref, box: x, of: v.of }));
  saveLoad();
};
const boxName = (v) => (v.of > 1 ? (v.boxes.length === 1 ? `Box ${v.boxes[0]} of ${v.of}` : `${allOf(v.boxes.length, true)} boxes`) : 'The box');

/**
 * One thing at the Office: where its boxes are, who checked it in, what's on the truck already (each can come back),
 * into this load or out of it. Opened from its label by the phone's own camera: that box, checked as a scan is, the
 * answer as the sheet's headline (another kid's box is a stop, as in the scanner)
 */
function outSheet(kid, it, { keep = false, ref = null, box = null } = {}) {
  const came = (it.receipts || []).filter((r) => !r.undone && r.kind === 'receive');
  const last = came[came.length - 1];
  const { here, n, all } = inLoadOf(it);
  const rest = here.filter((b) => !load.has(boxKey(b.ref, b.box)));
  let outs = boxesOut(it);
  const v = ref ? boxVerdict(ref, box) : null;
  let lead = '', stop = false, button = '', primary = true, act = null;
  if (v?.v === 'out') {
    lead = `${boxName(v)} ${v.boxes.length > 1 ? 'are' : 'is'} on the truck`;
    if (v.outs.length) {
      button = v.outs.length === 1 && v.outs[0].n === 1 ? 'Take it back off the truck' : `Take ${allOf(v.outs.reduce((t, o) => t + o.n, 0))} boxes back`;
      primary = false;
      act = (b) => takeBack(it, v.outs, b);
      // The big button covers this box: the list below is the rest of what's on the truck
      outs = outs.filter((o) => !v.outs.includes(o));
    }
  } else if (v?.v === 'inLoad') {
    lead = `${boxName(v)}: in this load`;
    button = 'Take it out of this load';
    primary = false;
    act = async () => { for (const x of v.boxes) load.delete(boxKey(ref, x)); saveLoad(); tones.undo(); await close(); render(); };
  } else if (v?.v === 'otherKid') {
    lead = `Not ${v.scoped.short}’s box. Leave it here.`;
    stop = true;
    button = 'Add it to this load anyway';
    primary = false;
    act = async () => { addBoxes(v); tones.ok(); await close(); render(); };
  } else if (v?.v === 'ok') {
    button = `Add ${v.of > 1 ? `box ${v.boxes.join(', ')} of ${v.of}` : 'it'} to this load`;
    act = async () => { addBoxes(v); tones.ok(); await close(); render(); };
  } else if (v?.v === 'gone') {
    lead = 'That label’s check-in was undone';
  }
  if (!button && here.length && (!v || v.v === 'gone')) {
    const named = outStateOf(it).per.size === 1 && here[0].of <= 3 && here[0].of > 1;
    button = all ? 'Take out of this load' : n ? `Add ${named ? boxesSaid(it, rest, { cap: false }) : `the other ${rest.length}`}` : here.length === 1 ? 'Add to this load' : `Add ${allOf(here.length)} to this load`;
    primary = !all;
    act = async () => { if (all) { dropItem(kid, it); tones.undo(); } else { addItem(kid, it); tones.ok(); } await close(); render(); };
  }
  openSheet(`${head(kidTitle(kid), { kid: true })}
    ${lead ? `<p class="sheet-lead${stop ? ' stop' : ''}">${esc(lead)}</p>` : ''}
    <p class="item-name">${esc(it.name)}</p>
    ${factsHtml([['Where', placesWords(here.map((b) => b.shelf)) || (here.length ? 'At the Office' : '')], ['At the Office', here.length ? boxWord(here.length) : ''], ['Came in', last ? `${dayOf(last.at)}${byWho(last)}` : ''], ['Line', it.line]].filter((f) => f[1]))}
    ${truckRows(it, outs)}
    ${button ? `<button class="btn ${primary ? 'btn-primary ' : ''}btn-big" type="button" id="sendout"${ref ? '' : ' data-focus'}>${esc(button)}</button>` : ''}`, { keep });
  if ($('sendout')) {
    $('sendout').onclick = () => act($('sendout'));
    // Another kid's box: the way past the stop waits a moment, so a thumb on its way can't take it
    if (stop) { $('sendout').disabled = true; setTimeout(() => { if ($('sendout')) $('sendout').disabled = false; }, 900); }
  }
  bindTakeOne(it, outs);
  // Opened by a label: the answer is read first, and no button is lit up for a thumb
  if (ref) { const h = sheetEl()?.querySelector('h3'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
}

/** Check out, a thing that isn't at the Office: what's known about it, and nothing to press (checking in is Check in's) */
function infoSheet(kid, it, { keep = false } = {}) {
  const house = (it.receipts || []).filter((r) => !r.undone && r.kind === 'house');
  openSheet(`${head(kidTitle(kid), { kid: true })}
    <p class="item-name">${esc(it.name)}</p>
    ${factsHtml(factsOf(it))}
    ${house.length ? `<div class="receipts">${house.map((r) => `<div class="receipt"><span>Went straight to the house ${esc(dayOf(r.at))}${byWho(r)}</span></div>`).join('')}</div>` : ''}`, { keep });
}

/** Load all (or the rest): everything the kid has at the Office, into the load, then the review */
function addAll(kid) {
  for (const it of kidLoad(kid).load) addItem(kid, it);
  tones.ok();
  render();
  confirmLoad();
}

/** Under each kid in the review: what stays at the Office and where (it stands out), what isn't here yet (quieter) */
function stillHtml(kid) {
  if (!kid) return '';
  const rest = kidLoad(kid).load.flatMap(boxesHere).filter((b) => !load.has(boxKey(b.ref, b.box)));
  const missing = kidLoad(kid).missing.length;
  return [rest.length ? `<span class="still-here">${boxWord(rest.length)} still on ${esc(placesWords(rest.map((b) => b.shelf)) || 'the shelf')}</span>` : '', missing ? `<span class="still-muted">${notHereYet(missing)}</span>` : ''].join('');
}
const groupBy = (list, key) => { const m = new Map(); for (const x of list) m.set(key(x), [...(m.get(key(x)) || []), x]); return m; };

/**
 * The review: this load by kid and thing (each box a chip to take out; taken out, it says Put back where it was until
 * the sheet closes, so nothing moves under a thumb), two kids in one load said with one chip, what each kid still has
 * at the Office and what isn't here yet. Every number follows the load. Confirm saves it; Scan more stays in reach
 */
function confirmLoad({ keep = false, said = '' } = {}) {
  if (!load.size) { close(); render(); return; }
  const byKid = groupBy([...load.values()], (e) => e.jobId);
  const n = load.size;
  const chip = (e) => `<button class="box-chip" type="button" data-unload="${esc(e.key)}" aria-label="Take ${esc(e.name)}${e.of > 1 ? `, box ${e.box} of ${e.of},` : ''} out of this load">${esc(e.of > 1 ? `Box ${e.box} of ${e.of}` : '1 box')}${ICON.x}</button>`;
  openSheet(`<div class="sheet-head"><div><h3 tabindex="-1" data-focus><span id="load-n">This load: ${boxWord(n)}</span> <span class="chip-mode warn-chip" id="load-kids"${byKid.size > 1 ? '' : ' hidden'}>${byKid.size > 1 ? `${byKid.size} kids` : ''}</span></h3>${said ? `<div class="sheet-sub said">${esc(said)}</div>` : ''}</div>
      <button class="x" type="button" data-close="1" aria-label="Close">${ICON.x}</button></div>
    ${[...byKid].map(([jobId, list]) => {
      const kid = kidById(jobId);
      return `<div class="pick" data-kidgroup="${esc(jobId)}">
        <div class="look kid-row">${kid ? face(kid, 32) : ''}<b>${esc(kid?.short || list[0].kid)}</b><span data-kidn>${boxWord(list.length)}</span></div>
        ${[...groupBy(list, (e) => e.row).values()].map((es) => `<div class="look load-line"><b>${esc(es[0].name)}</b><span class="chips-row">${es.sort((a, b) => a.box - b.box).map(chip).join('')}</span></div>`).join('')}
        <div class="look still" data-still>${stillHtml(kid)}</div>
      </div>`;
    }).join('')}
    <div class="sheet-foot"><button class="btn btn-primary btn-big" type="button" id="confirm">${said ? `Try again: ${confirmWords(n).toLowerCase()}` : confirmWords(n)}</button>
      <button class="btn btn-text" type="button" id="more">Scan more</button></div>`, { keep: keep || Boolean(sheetEl()) });
  const bindChip = (b) => {
    b.onclick = () => {
      const e = load.get(b.dataset.unload);
      if (!e) return;
      load.delete(e.key);
      saveLoad();
      tones.undo();
      b.outerHTML = `<button class="box-chip put-back" type="button" data-putback="${esc(e.key)}" aria-label="Put ${esc(e.name)} back in this load">Put back</button>`;
      const pb = document.querySelector(`#sheet-root [data-putback="${CSS.escape(e.key)}"]`);
      pb.onclick = () => {
        load.set(e.key, e);
        saveLoad();
        tones.ok();
        pb.outerHTML = chip(e);
        bindChip(document.querySelector(`#sheet-root [data-unload="${CSS.escape(e.key)}"]`));
        repaintReview();
        render();
      };
      repaintReview();
      render();
    };
  };
  document.querySelectorAll('#sheet-root [data-unload]').forEach(bindChip);
  $('more').onclick = async () => { await close(); scanLabels(kidById(state.loadKid) || null); };
  $('confirm').onclick = () => confirmNow();
}
/** The review's numbers, from the load as it is now; a kid with every box taken out says so, dimmed, in place */
function repaintReview() {
  const n = load.size;
  if ($('load-n')) $('load-n').textContent = `This load: ${boxWord(n)}`;
  const kids = new Set([...load.values()].map((e) => e.jobId));
  if ($('load-kids')) { $('load-kids').hidden = kids.size < 2; $('load-kids').textContent = kids.size < 2 ? '' : `${kids.size} kids`; }
  document.querySelectorAll('#sheet-root [data-kidgroup]').forEach((g) => {
    const mine = [...load.values()].filter((e) => e.jobId === g.dataset.kidgroup).length;
    g.querySelector('[data-kidn]').textContent = mine ? boxWord(mine) : 'Taken out';
    g.classList.toggle('dim', !mine);
    g.querySelector('[data-still]').innerHTML = stillHtml(kidById(g.dataset.kidgroup));
  });
  if ($('confirm')) { $('confirm').textContent = n ? confirmWords(n) : 'Nothing in this load'; $('confirm').disabled = !n; }
}

/**
 * Confirm: the load is kept on the phone first (in parts the site takes at once), so closing the page loses nothing;
 * the boxes show as out at once and the done sheet rises; then it's sent, and the sheet says Saved, or Saved on this
 * phone, or which boxes the site refused and what to do. Another load can be confirmed while one is still sending
 */
async function confirmNow() {
  const entries = [...load.values()];
  if (!entries.length) return;
  for (const e of entries) e.tap ||= newTap();
  const items = entries.map((e) => ({ tap: e.tap, ref: e.ref, box: e.box }));
  const q = readQueue();
  for (let i = 0; i < items.length; i += 50) q.push({ id: newTap(), action: 'out', body: { items: items.slice(i, i + 50) }, at: Date.now() });
  // This phone can't keep anything: sent now, or kept in the load to try again
  if (!writeQueue(q)) { confirmDirect(entries); return; }
  load.clear();
  saveLoad();
  overlayQueue();
  showQueue();
  tones.ok();
  const token = newTap();
  loadDone(entries, token);
  const res = await flush({ mine: new Set(items.map((x) => x.tap)) });
  const refused = entries.filter((e) => res.refused.has(e.tap));
  const landed = entries.filter((e) => res.landed.has(e.tap)).length;
  loadSaved(entries, { token, landed, waiting: entries.length - landed - refused.length, refused, why: (e) => res.refused.get(e.tap)?.why, signIn: res.signIn });
}
/** On a phone that can't keep anything: the load goes now; without a connection it stays in the load, and it's said */
async function confirmDirect(entries) {
  const btn = $('confirm');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin" aria-hidden="true"></span>Saving ${boxWord(entries.length)}`; }
  const items = entries.map((e) => ({ tap: e.tap, ref: e.ref, box: e.box }));
  const landed = new Set();
  const why = new Map();
  try {
    for (let i = 0; i < items.length; i += 50) {
      const out = await send('out', { items: items.slice(i, i + 50) });
      for (const x of out.results || []) { if (!x.error) landed.add(x.tap); else if (FOR_GOOD.has(x.status)) why.set(x.tap, clean(x.error)); }
    }
  } catch (err) {
    for (const e of entries) if (landed.has(e.tap) || why.has(e.tap)) load.delete(e.key);
    saveLoad();
    tones.warn();
    confirmLoad({ keep: true, said: `${landed.size ? `${boxWord(landed.size)} saved. ` : ''}Not saved: ${err instanceof Offline ? CANT_KEEP : clean(err.message)}` });
    return;
  }
  for (const e of entries) load.delete(e.key);
  saveLoad();
  tones.ok();
  const token = newTap();
  loadDone(entries, token);
  const refused = entries.filter((e) => why.has(e.tap));
  loadSaved(entries, { token, landed: landed.size, waiting: 0, refused, why: (e) => why.get(e.tap) });
}

/** What to do about a box the site refused: it's on the truck, and it shouldn't be */
const refusedStep = (why) => (/taken back|undone/i.test(why) ? 'Its check-in was undone. Take it off the truck until it’s checked in again.'
  : /isn’t one of SOARD’s/i.test(why) ? 'That label isn’t one of SOARD’s check-ins. Take it off the truck.'
  : `${why}. Take it off the truck.`);
const PHONE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>';

/** The done sheet: each kid's boxes that went, what's still at the Office and where, what isn't here yet; how saving went */
function doneKids(went, refused = []) {
  const no = groupBy(refused, (e) => e.jobId);
  return [...groupBy([...went, ...refused], (e) => e.jobId)].map(([jobId, es]) => {
    const k = kidById(jobId);
    const l = k ? kidLoad(k) : null;
    const out = es.filter((e) => !refused.includes(e)).length;
    const not = (no.get(jobId) || []).length;
    return `<div class="shelf-callout static"><span class="who">${face(k, 36)}${esc(k?.short || es[0].kid)} · ${esc(not ? `${out} out · ${not} not loaded` : boxWord(out))}</span><b>${l?.left ? esc(`${l.left} still at the Office`) : 'All out'}</b>
      <span class="sc-items">${l?.left ? `<span>${esc(`On ${placesWords(l.places) || 'the shelf'}`)}</span>` : ''}${l?.missing.length ? `<span class="quiet">${esc(notHereYet(l.missing.length))}</span>` : ''}</span></div>`;
  }).join('');
}
function loadDone(went, token) {
  state.doneToken = token;
  openSheet(`<div class="sheet-head"><div><h3 tabindex="-1" data-focus id="done-h">${esc(`${boxWord(went.length)} out`)}</h3><div class="sheet-sub saving" id="done-sub" role="status"><span class="spin" aria-hidden="true"></span>Saving</div></div>
      <button class="x" type="button" data-close="1" aria-label="Close">${ICON.x}</button></div>
    <div id="done-not" hidden></div>
    <div class="done-kids" id="done-kids">${doneKids(went)}</div>
    <div class="sheet-foot"><button class="btn btn-primary btn-big" type="button" data-close="1">Done</button></div>`, { keep: true });
  // Behind the sheet: the rows, the count and the dock are as they are now; loaded rows fade and close up once it's down
  state.afterLoad = [...new Set(went.map((e) => e.row))];
  state.renderOnClose = true;
  for (const e of went) { const f = findByRef(e.ref); if (f) paintRow(f.i); }
  const kid = kidById(state.loadKid);
  if (kid) paintKidHead(kid);
  renderDock();
}
function loadSaved(went, { token, landed, waiting, refused, why, signIn = false }) {
  const ok = went.filter((e) => !refused.includes(e));
  // Refused, by thing and reason, with what to do: those boxes are on the truck
  const cards = [...groupBy(refused, (e) => `${e.row}|${why(e)}`).values()].map((es) => ({ name: es[0].name, boxes: es.length === es[0].of && es.length > 1 ? `${allOf(es.length)} boxes` : es[0].of > 1 ? es.map((e) => `box ${e.box}`).join(', ') : '1 box', step: refusedStep(why(es[0])) }));
  if (refused.length) tones.warn();
  if (state.doneToken !== token || !$('done-sub')) {
    // The sheet was closed (or another load's is up) before the answer came: only what went wrong is said
    if (cards.length) toast(`Not loaded: ${cards.map((c) => `${c.name} (${c.boxes})`).join('; ')}. Take ${refused.length === 1 ? 'it' : 'them'} off the truck`);
    else if (signIn) toast('Saved on this phone. Your sign-in ran out: tap “Sign in” up top');
    if (!state.renderOnClose) render();
    return;
  }
  const sub = $('done-sub');
  sub.classList.remove('saving');
  const notWords = refused.length ? ` ${boxWord(refused.length)} not loaded.` : '';
  if (!ok.length) sub.textContent = 'Nothing saved';
  else if (waiting && signIn) sub.innerHTML = `${PHONE_ICON}<span>Saved on this phone. Your sign-in ran out.${esc(notWords)}</span><button class="btn btn-text inline" type="button" id="signin">Sign in again</button>`;
  else if (waiting) sub.innerHTML = `${PHONE_ICON}<span>Saved on this phone. It goes when the connection is back.${esc(notWords)}</span>`;
  else sub.innerHTML = `${ICON.tick}<span>Saved.${esc(notWords || ' In JobTread in a minute.')}</span>`;
  sub.style.setProperty('--after', '0ms');
  if ($('signin')) $('signin').onclick = () => location.reload();
  if (refused.length) {
    $('done-h').textContent = ok.length ? `${ok.length} of ${boxWord(went.length)} out` : 'Nothing loaded';
    $('done-not').hidden = false;
    $('done-not').innerHTML = `<div class="refused">${cards.map((c) => `<div class="rf-row"><b>${esc(c.name)} · ${esc(c.boxes)}</b><span>${esc(c.step)}</span></div>`).join('')}</div>`;
    $('done-kids').innerHTML = doneKids(ok, refused);
  }
}

/** Short tones (rising: in the load; low twice: stop; falling: taken out; one blip: seen already). Made in the page, no files */
const tones = (() => {
  let ac = null;
  const play = (notes) => {
    if (!ac) return;
    let t = ac.currentTime + 0.01;
    for (const [hz, ms] of notes) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
      t += ms / 1000 + 0.03;
    }
  };
  const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch { /* not this phone */ } };
  return {
    // Made on a tap: iPhones only let a page make sound after one. Played as "playback" where the phone allows,
    // so the ring/silent switch doesn't mute it
    wake: () => {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older phones */ }
      try { ac ||= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch { ac = null; }
    },
    ok: () => { play([[880, 70], [1320, 110]]); buzz(25); },
    warn: () => { play([[330, 140], [330, 140]]); buzz([60, 40, 60]); },
    undo: () => play([[990, 70], [660, 110]]),
    seen: () => play([[660, 60]]),
  };
})();

/**
 * Scan labels: the camera stays open and reads the label in the frame (only there: labels sit side by side on a
 * shelf). Loading one kid, another kid's box is stopped ("Colin L.'s box. Leave it here.") unless sent anyway; each
 * box loaded says what's left, the last one says that's all of them, and the last read stays on screen until the next.
 * A label read twice counts once; it's read again only after it has left the frame
 */
let scanning = null;
let camOpening = false;
async function scanLabels(scope) {
  // Two taps while the camera starts open it once
  if (camOpening || document.querySelector('.cam')) return;
  camOpening = true;
  try { await openLabels(scope); } finally { camOpening = false; }
}
async function openLabels(scope) {
  // Each reader is given the frame's part of the picture (video pixels, and a little past the frame's edge)
  let detect;
  if ('BarcodeDetector' in window) {
    try {
      const bd = new window.BarcodeDetector({ formats: ['qr_code'] });
      detect = async (video, r) => {
        const inside = (await bd.detect(video)).map((c) => { const b = c.boundingBox || {}; return { c, x: (b.x || 0) + (b.width || 0) / 2, y: (b.y || 0) + (b.height || 0) / 2 }; })
          .filter((p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h)
          .sort((a, b) => ((a.x - r.cx) ** 2 + (a.y - r.cy) ** 2) - ((b.x - r.cx) ** 2 + (b.y - r.cy) ** 2));
        return inside[0]?.c.rawValue || null;
      };
    } catch { detect = null; }
  }
  if (!detect) {
    let jsQR;
    try { jsQR = (await import('./jsqr.js')).default; } catch { toast('The label reader didn’t load. Tick the boxes on the list instead.'); return; }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // At the camera's own sharpness: a label at arm's length keeps all its detail. This reader takes one code a
    // picture, and a neighbour's corner in the frame throws it: each picture it looks at the frame, then its middle,
    // then the middle of that, where the label aimed at is
    const SIZES = [1, 0.72, 0.5];
    let turn = 0;
    detect = async (video, f) => {
      const k = SIZES[turn++ % SIZES.length];
      const r = { w: f.w * k, h: f.h * k, x: f.cx - (f.w * k) / 2, y: f.cy - (f.h * k) / 2 };
      const scale = Math.min(1, 900 / Math.max(r.w, r.h));
      const w = Math.max(1, Math.round(r.w * scale)), h = Math.max(1, Math.round(r.h * scale));
      canvas.width = w; canvas.height = h;
      ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, w, h);
      return jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data || null;
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) { toast('This phone’s browser can’t open the camera here. Tick the boxes on the list instead.'); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch {
    stream = null;
    toast('The camera didn’t open. Allow it for this page, or tick the boxes on the list instead.');
    return;
  }
  const track = stream.getVideoTracks()[0];
  const canTorch = Boolean(track?.getCapabilities?.().torch);
  const cam = document.createElement('div');
  cam.className = 'cam qr';
  cam.setAttribute('role', 'dialog');
  cam.setAttribute('aria-modal', 'true');
  cam.setAttribute('aria-label', 'Scanning box labels');
  cam.innerHTML = `<video autoplay playsinline muted></video>
    <div class="frame square" aria-hidden="true"><svg class="frame-tick" width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg></div>
    <div class="cam-top"><b class="cam-count" aria-live="polite"></b></div>
    <div class="cam-said" aria-live="assertive" hidden></div>
    <button class="cam-close" type="button" aria-label="Stop scanning">${ICON.x}</button>
    ${canTorch ? '<button class="cam-torch" type="button" aria-pressed="false" aria-label="Flashlight"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2h10l-2 6v12a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V8z"/><path d="M12 12v2"/></svg></button>' : ''}
    <button class="btn btn-primary cam-done" type="button">Done</button>`;
  document.body.appendChild(cam);
  cam.querySelector('.cam-done').focus({ preventScroll: true });
  const video = cam.querySelector('video');
  video.srcObject = stream;
  const frameEl = cam.querySelector('.frame');
  // The frame's rectangle in the camera's own pixels (the picture fills the screen and is cropped to it)
  const frameRect = () => {
    const vw = video.videoWidth, vh = video.videoHeight;
    const vr = video.getBoundingClientRect(), fr = frameEl.getBoundingClientRect();
    const s = Math.max(vr.width / vw, vr.height / vh);
    const ox = (vr.width - vw * s) / 2, oy = (vr.height - vh * s) / 2;
    const m = 0.1 * fr.width;
    const x0 = Math.max(0, (fr.left - m - vr.left - ox) / s), y0 = Math.max(0, (fr.top - m - vr.top - oy) / s);
    const x1 = Math.min(vw, (fr.right + m - vr.left - ox) / s), y1 = Math.min(vh, (fr.bottom + m - vr.top - oy) / s);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  };
  // The kid being loaded: the one picked, else whoever the first box in the load is for
  const scopeNow = () => scope || scopeKid();
  let saidTimer;
  let lastRead = '';
  // Whose and how many, up top; when every one of the kid's boxes is loaded or in the load, the pill turns green
  const count = () => {
    const n = loadBoxes();
    const k = scopeNow();
    const pill = cam.querySelector('.cam-count');
    let end = false;
    if (k) {
      const l = kidLoad(k);
      end = l.total > 0 && l.inLoad > 0 && l.done + l.inLoad >= l.total;
      pill.innerHTML = `${face(k, 28)}<span>${esc(k.short)}${l.total ? ` · ${l.done + l.inLoad} of ${boxWord(l.total)}` : ''}</span>${end ? ICON.tick : ''}`;
    } else pill.textContent = n ? `${boxWord(n)} in this load` : 'Point at a label';
    pill.classList.toggle('done', end);
    cam.querySelector('.cam-done').textContent = n ? (end ? 'Review and confirm' : reviewWords(n)) : 'Done';
    return { k, end };
  };
  count();
  let flashTimer;
  const flash = (cls) => { clearTimeout(flashTimer); frameEl.classList.remove('hit', 'stop'); void frameEl.offsetWidth; frameEl.classList.add(cls); flashTimer = setTimeout(() => frameEl.classList.remove(cls), cls === 'hit' ? 350 : 600); };
  // After a few seconds a read shrinks to one line until the next: "Last: Box 2 of 3 · Wayfair Louis…" (the box
  // number never cut off: on a thing in boxes it's the check that the right one was read)
  const showLast = () => {
    const el = cam.querySelector('.cam-said');
    if (!lastRead) { el.hidden = true; return; }
    el.className = 'cam-said last';
    el.innerHTML = `<span class="lb">Last:${lastRead.box ? ` ${esc(lastRead.box)} ·` : ''}</span><span class="ln">${esc(lastRead.name)}</span>`;
    el.hidden = false;
  };
  const say = (cls, html, { stay = false } = {}) => {
    const el = cam.querySelector('.cam-said');
    el.className = `cam-said ${cls}`;
    el.innerHTML = html;
    el.hidden = false;
    // Every read moves, even one right after another
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    clearTimeout(saidTimer);
    if (!stay) saidTimer = setTimeout(showLast, 3200);
    return el;
  };
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; }
  // Back from the lock screen or another app: the screen stays awake again, and a camera that stopped starts again
  const back = async () => {
    if (document.visibilityState !== 'visible' || !document.body.contains(cam)) return;
    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not this phone */ }
    if (stream?.getVideoTracks().every((t) => t.readyState === 'live' && !t.muted)) return;
    try {
      stream?.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream;
    } catch { /* the camera again on the next tap */ }
  };
  document.addEventListener('visibilitychange', back);
  // Leaving: the frame, card and buttons go at once and only the picture fades, so nothing ghosts over the next sheet
  const stop = (then) => {
    if (cam.classList.contains('leaving')) return;
    document.removeEventListener('visibilitychange', back);
    try { wake?.release(); } catch { /* gone */ }
    cancelAnimationFrame(scanning); scanning = null;
    clearTimeout(saidTimer);
    cam.classList.add('leaving');
    if (then) then();
    setTimeout(() => { stopCamera(); render(); }, reduced() ? 0 : 180);
  };
  cam.querySelector('.cam-close').onclick = () => stop();
  cam.querySelector('.cam-done').onclick = () => stop(load.size ? () => confirmLoad() : null);
  cam.querySelector('.cam-torch')?.addEventListener('click', async (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); e.currentTarget.setAttribute('aria-pressed', String(on)); } catch { /* not this phone */ }
  });
  // A box into the load: nothing is saved until Confirm
  const add = (v) => {
    addBoxes(v);
    tones.ok();
    flash('hit');
    const { k, end } = count();
    const what = v.of > 1 ? (v.boxes.length === 1 ? `box ${v.boxes[0]} of ${v.of}` : `${allOf(v.boxes.length)} boxes`) : '';
    lastRead = { box: what ? what[0].toUpperCase() + what.slice(1) : '', name: v.found.i.name };
    const l = k ? kidLoad(k) : null;
    // The end: every box at the Office is in; what hasn't come yet is said there, where the truck is called done
    const el = say(end ? 'ok end' : 'ok', end
      ? `${face(v.found.k, 40)}<b>${l.missing.length ? 'Every box at the Office is in' : `That’s all ${l.total} of ${esc(k.short)}’s boxes`}</b><span>${esc(v.found.i.name)}${what ? ` · ${what}` : ''}</span>${l.missing.length ? `<span class="warn-line">${esc(notHereYet(l.missing.length))}</span>` : ''}<button class="cam-undo" type="button">Take it out</button>`
      : `${face(v.found.k, 40)}<b>${esc(v.found.i.name)}</b><span>${esc(v.found.k.short)}${what ? ` · ${what}` : ''}</span><span class="in-chip">${ICON.tick}In this load</span><button class="cam-undo" type="button">Take it out</button>`, { stay: end });
    el.querySelector('.cam-undo').onclick = () => {
      for (const x of v.boxes) load.delete(boxKey(v.ref, x));
      saveLoad();
      tones.undo();
      lastRead = '';
      count();
      say('seen', '<b>Taken out of this load</b>');
    };
  };
  const seen = new Map();
  let lastAt = 0, busy = false;
  const frame = async (t) => {
    if (!document.body.contains(cam) || cam.classList.contains('leaving')) return;
    scanning = requestAnimationFrame(frame);
    if (busy || t - lastAt < 140 || !video.videoWidth) return;
    lastAt = t;
    busy = true;
    let data = null;
    try { data = await detect(video, frameRect()); } catch { data = null; } finally { busy = false; }
    if (!data || cam.classList.contains('leaving')) return;
    // The same label still in the frame isn't a new read; once it has been out of it for a moment, it is
    const nowMs = performance.now();
    const last = seen.get(data);
    seen.set(data, nowMs);
    if (last && nowMs - last < 800) return;
    let url = null;
    try { url = new URL(data); } catch { /* not a link */ }
    const ours = url?.pathname.startsWith('/admin/checkin');
    const ref = ours ? url.searchParams.get('r') : null;
    const box = ours ? Number(url.searchParams.get('b')) || null : null;
    const shelf = ours ? url.searchParams.get('shelf') : null;
    if (shelf) { tones.seen(); const s = state.shelves.find((x) => x.shelf === shelf); say('seen', `<b>${esc(shelfName(shelf))}</b><span>${esc(kidById(s?.kid)?.short || 'Free')}</span>`); return; }
    if (!ref) { tones.warn(); flash('stop'); say('warn', '<b>Not a SOARD label</b>'); return; }
    const v = boxVerdict(ref, box);
    if (v.v === 'gone') { tones.warn(); flash('stop'); say('warn', '<b>That label isn’t on the list</b><span>Its makeover may be finished, or the check-in was undone.</span>'); return; }
    if (v.v === 'out') { tones.seen(); const o = v.outs?.[0]; say('seen', `<b>${esc(boxName(v))} ${v.boxes.length > 1 ? 'are' : 'is'} on the truck</b><span>${esc(v.found.k.short)}: ${esc(v.found.i.name)}${o ? ` · ${esc(o.waiting ? 'waiting to send' : dayOf(o.at))}` : ''}</span>`); return; }
    if (v.v === 'inLoad') { tones.seen(); say('seen', `<b>Already in this load</b><span>${esc(v.found.k.short)}: ${esc(v.found.i.name)}</span>`); return; }
    if (v.v === 'otherKid') {
      // Another kid's box, while loading this one: stopped, unless it really is going
      tones.warn();
      flash('stop');
      const el = say('stop', `${face(v.found.k, 40)}<b>Leave it here</b><span>${esc(v.found.k.short)}’s box · ${esc(v.found.i.name)}</span><span>This load is ${esc(v.scoped.short)}’s</span><button class="cam-undo" type="button">Add it anyway</button>`, { stay: true });
      // Not in reach of a thumb on its way to the last box's Take it out: it waits a moment, on the other side
      const anyway = el.querySelector('.cam-undo');
      anyway.disabled = true;
      setTimeout(() => { anyway.disabled = false; }, 900);
      anyway.onclick = () => add(v);
      return;
    }
    add(v);
  };
  scanning = requestAnimationFrame(frame);
}

// ─── Shipments: what's coming, by the stores' own emails ────────────
// Peter, Nov 11 2026: "show expected shipments so clareece can print labels from expected shipments and she visually
// sees that shipment as arrived". Delivered first (newest on top), then out for delivery, on the way (by the day it's
// expected), ordered; older deliveries (most likely already on the shelves) and what was checked in fold away

const kidOfItem = (id) => state.kids.find((k) => k.items.some((i) => i.id === id));
const itemOfId = (id) => kidOfItem(id)?.items.find((i) => i.id === id);
const when = (iso, { cap = false } = {}) => {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / DAY);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s(AM|PM)$/, ' $1');
  const out = days === 0 ? `today ${time}` : days === 1 ? 'yesterday' : days < 7 ? d.toLocaleDateString('en-US', { weekday: 'long' }) : dayOf(iso);
  return cap ? out[0].toUpperCase() + out.slice(1) : out;
};
const expectedOn = (ymd) => {
  if (!ymd) return '';
  const d = new Date(`${ymd}T12:00:00`);
  const days = Math.round((d - new Date(new Date().toDateString())) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const waitingOf = (sh) => sh.items.filter((i) => { const it = itemOfId(i.id); return it && !isHere(it); });
// Checked in on this phone and not sent yet: it counts as checked in, and says it's waiting
const sendingOf = (sh) => sh.items.some((i) => (itemOfId(i.id)?.receipts || []).some((r) => r.waiting));
/** The stage as the page shows it: a shipment all checked in on this phone is checked in, even before it's sent */
const stageOf = (sh) => (sh.unplaced ? sh.stage : sh.stage !== 'in' && !waitingOf(sh).length ? 'in' : sh.stage);
// In a section that already says Delivered, the chip says only when
const shipStatus = (sh) => {
  const st = stageOf(sh);
  if (st === 'in' && sendingOf(sh)) return ['out', 'Waiting to send'];
  return st === 'delivered' ? ['delivered', when(sh.deliveredAt, { cap: true })]
    : st === 'pickup' ? ['out', 'Ready for pickup']
      : st === 'house' ? ['ordered', 'Going to the house']
        : st === 'out' ? ['out', 'Out for delivery']
          : st === 'shipped' ? ['shipped', sh.expected ? `Arriving ${expectedOn(sh.expected)}` : 'On the way']
            : st === 'in' ? ['in', `Checked in ${when(sh.checkedAt)}`] : ['ordered', `Ordered ${dayOf(sh.orderedAt)}`];
};

/** One shipment: the store, its order number, where it is, what's still to check in (with each kid's face) and what's on shelves */
function shipCard(sh, { compact = false } = {}) {
  if (!sh) return '';
  const [cls, words] = shipStatus(sh);
  // Nobody's yet (no PO, its things on no one's selections: an allowance buy, or the office's): what's in it, whose is it?
  if (sh.unplaced) {
    const things = sh.things || [];
    const shown = things.slice(0, compact ? 2 : 3);
    return `<button class="ship card stage-${cls} unplaced" type="button" data-ship="${esc(sh.key)}" aria-label="${esc(`${sh.store}, ${words}, not on a kid’s list: whose is it?`)}">
    <span class="ship-head"><b class="ship-name">${esc(sh.store)}</b><span class="ship-chip ${cls}">${esc(words)}</span>${sh.orderNumber ? `<span class="ship-order">Order ${esc(sh.orderNumber)}${sh.buyer ? ` · ${esc(sh.buyer)}` : ''}</span>` : ''}</span>
    <span class="ship-items">${shown.map((t) => `<span class="ship-item"><span class="face ini q" aria-hidden="true">?</span><span class="si-name">${esc(t.name)}${t.qty > 1 ? ` (${t.qty})` : ''}</span></span>`).join('')}
      ${things.length > shown.length ? `<span class="ship-more">and ${plural(things.length - shown.length, 'more thing')}</span>` : ''}</span>
    ${compact ? '' : `<span class="ship-go"><span>Whose is it?</span>${ICON.chev}</span>`}
  </button>`;
  }
  const waiting = waitingOf(sh);
  const here = sh.items.filter((i) => !waiting.includes(i));
  const kidsWaiting = [...new Set(waiting.map((i) => kidOfItem(i.id)?.jobId).filter(Boolean))].map(kidById);
  const shown = waiting.slice(0, compact ? 2 : 4);
  const more = waiting.length - shown.length;
  const label = `${sh.store}, ${words}${waiting.length ? `, ${waiting.length} to check in for ${kidsWaiting.map((k) => k.short).join(' and ')}` : ', all checked in'}`;
  return `<button class="ship card stage-${cls}" type="button" data-ship="${esc(sh.key)}" aria-label="${esc(label)}">
    <span class="ship-head"><b class="ship-name">${esc(sh.store)}</b><span class="ship-chip ${cls}">${esc(words)}</span>${sh.orderNumber ? `<span class="ship-order">Order ${esc(sh.orderNumber)}</span>` : ''}</span>
    <span class="ship-items">${shown.map((i) => { const it = itemOfId(i.id); return it ? `<span class="ship-item">${face(kidOfItem(i.id), 24)}<span class="si-name">${esc(it.name)}</span></span>` : ''; }).join('')}
      ${more > 0 ? `<span class="ship-more">and ${plural(more, 'more thing')}</span>` : ''}
      ${here.length ? `<span class="ship-more">${here.length === sh.items.length ? (sendingOf(sh) ? `${plural(here.length, 'thing')} checked in on this phone` : `All ${plural(here.length, 'thing')} on shelves`) : `${here.length} on shelves`}</span>` : ''}</span>
    ${!compact && waiting.length ? `<span class="ship-go"><span>${waiting.length === sh.items.length ? (waiting.length === 1 ? 'Check it in' : `Check in all ${waiting.length}`) : `Check in the ${waiting.length} left`}${kidsWaiting.length > 1 ? ` · ${kidsWaiting.length} kids` : ''}</span>${ICON.chev}</span>` : ''}
  </button>`;
}

/** Check in, All: shipments by stage; Needs a look below what's on the way, so what arrived leads */
function shipmentsHtml(looks = '') {
  const weekAgo = Date.now() - 7 * DAY;
  // Nobody's orders not here yet wait folded on their own (the list is the kids'); delivered, one asks whose it is with the rest
  const at = (st) => state.shipments.filter((x) => stageOf(x) === st && (!x.unplaced || st === 'delivered'));
  const whose = state.shipments.filter((x) => x.unplaced && stageOf(x) !== 'delivered');
  const groups = {
    delivered: at('delivered').filter((x) => Date.parse(x.deliveredAt || 0) >= weekAgo),
    pickup: at('pickup'),
    out: at('out'),
    shipped: at('shipped'),
    earlier: at('delivered').filter((x) => Date.parse(x.deliveredAt || 0) < weekAgo),
    ordered: at('ordered'),
    house: at('house'),
    in: at('in').filter((x) => sendingOf(x) || Date.parse(x.checkedAt || 0) >= Date.now() - 3 * DAY),
  };
  const open = (k) => state.openShips?.has(k);
  const section = (k, title, list, folded = false) => {
    if (!list.length) return '';
    if (folded && !open(k)) return `<button class="more fold" type="button" data-shipsection="${k}"><span>${esc(title)}</span><span class="fold-n">${list.length}</span>${ICON.chev}</button>`;
    return `<div class="ship-h"><span>${esc(title)}</span><span>${list.length}</span></div>${list.map((x) => shipCard(x)).join('')}`;
  };
  const html = section('delivered', 'Delivered', groups.delivered)
    + section('pickup', 'Ready for pickup', groups.pickup)
    + section('out', 'Out for delivery', groups.out)
    + section('shipped', 'On the way', groups.shipped)
    + looks
    + section('whose', 'Not on a kid’s list yet', whose, true)
    + section('earlier', 'Delivered more than a week ago', groups.earlier, true)
    + section('ordered', 'Ordered, not shipped yet', groups.ordered, true)
    + section('house', 'Shipped to the house', groups.house, true)
    + section('in', 'Checked in lately', groups.in, true);
  return html || '<div class="empty">Nothing on the way. Scan a box, or pick a kid above.</div>';
}

/**
 * A shipment: what came, by kid (each kid's face and shelf once), each thing ticked when its delivered email named it
 * (what isn't delivered yet sits below, unticked), and how many boxes it came in; one tap checks them in and prints
 * every label. What's here already shows where it is
 */
function shipmentSheet(key, { pick = null, how = '', boxes: preset = 1, keep = false } = {}) {
  const sh = state.shipments.find((x) => x.key === key);
  if (!sh) return;
  if (sh.unplaced) { whoseSheet(sh, { how, keep }); return; }
  const [, words] = shipStatus(sh);
  const waiting = waitingOf(sh);
  const done = sh.items.filter((i) => !waiting.includes(i));
  const someDelivered = waiting.some((i) => i.delivered);
  const boxes = new Map(waiting.map((i) => [i.id, pick?.length === 1 && pick.includes(i.id) ? Math.max(1, preset) : 1]));
  // A label scanned: what it matched. Else what the delivered email named (when it named some); else all of it
  const ticked = new Set(waiting.map((i) => i.id).filter((id) => (pick ? pick.includes(id) : !someDelivered || waiting.find((i) => i.id === id).delivered)));
  for (const i of waiting) if (!state.shipTaps.has(i.id)) state.shipTaps.set(i.id, newTap());
  const taps = state.shipTaps;
  const byKid = new Map();
  for (const i of [...waiting].sort((a, b) => Number(ticked.has(b.id)) - Number(ticked.has(a.id)))) { const k = kidOfItem(i.id); byKid.set(k.jobId, [...(byKid.get(k.jobId) || []), i]); }
  const many = byKid.size > 1;
  const row = (i) => {
    const it = itemOfId(i.id), k = kidOfItem(i.id);
    const left = it.qty - (it.got || 0);
    const sub = [many ? null : k.short, it.line, left > 1 ? `${left} of them` : null, someDelivered && !i.delivered && !pick ? 'Not delivered yet' : null].filter(Boolean).join(' · ');
    return `<label class="look ship-row${many ? ' no-face' : ''}"><input type="checkbox" data-shipitem="${esc(i.id)}"${ticked.has(i.id) ? ' checked' : ''} />
      ${many ? '' : face(k, 32)}<span class="sr-name">${esc(it.name)}</span>
      <span class="sr-sub">${esc(sub)}</span>
      <span class="mini-step" data-boxes="${esc(i.id)}"><button type="button" data-bstep="-1" aria-label="${esc(it.name)}: one box fewer">−</button><output aria-label="Boxes">${boxes.get(i.id)}</output><button type="button" data-bstep="1" aria-label="${esc(it.name)}: one box more">+</button></span></label>`;
  };
  const labelCount = () => [...ticked].reduce((t, id) => t + boxes.get(id), 0);
  const goWords = () => (ticked.size ? `Check in and print ${plural(labelCount(), 'label')}` : 'Tick what came');
  // One kid's: the wrong kid is one tap to change, for the whole order (Peter, Nov 11 2026: "i accidently picked the
  // wrong kid and am on the check in screen with no way to change the kid"). Not once a box of it is on the truck
  const kids = [...new Set(sh.items.map((i) => kidOfItem(i.id)?.jobId).filter(Boolean))];
  const loaded = sh.items.some((i) => (itemOfId(i.id)?.receipts || []).some((r) => r.kind !== 'receive' && !r.undone));
  const wrong = kids.length === 1 && !loaded ? '<button class="btn btn-text" type="button" id="shipwrong">Wrong kid</button>' : '';
  const house = sh.house && waiting.length ? '<button class="btn btn-text" type="button" id="shiphouse">Not coming here: it went to the house</button>' : '';
  // The rest of the order a person has to place: in Needs a look
  const lookAt = state.needsLook.findIndex((x) => x.key === sh.key);
  const lookN = lookAt >= 0 ? state.needsLook[lookAt].items.length : 0;
  // The order number is on the line already: the match says only what else it was
  const sub = [sh.orderNumber ? `Order ${sh.orderNumber}` : null, words, how && !(sh.orderNumber && how.includes(sh.orderNumber)) ? how : null].filter(Boolean).join(' · ');
  openSheet(`${head(esc(sh.store), { sub: esc(sub) })}
    ${waiting.length ? [...byKid].map(([jobId, list]) => { const k = kidById(jobId); return `<div class="pick">${many ? `<div class="look kid-row">${face(k, 32)}<b>${esc(k.short)}</b><span>${esc(k.shelf || 'Next free shelf')}</span></div>` : ''}${list.map(row).join('')}</div>`; }).join('') : ''}
    ${done.length ? `<div class="label-above">On shelves</div><div class="pick">${done.map((i) => { const it = itemOfId(i.id), k = kidOfItem(i.id); return it ? `<div class="look ship-row done">${face(k, 32)}<span class="sr-name">${esc(it.name)}</span><span class="sr-sub">${esc(k.short)}</span><span class="tag-here">${esc(it.status === 'house' ? 'House' : it.status === 'out' ? 'Loaded' : shelfName(it.shelf) || 'Here')}</span></div>` : ''; }).join('')}</div>` : ''}
    ${lookN ? `<div class="pick"><button class="look" type="button" data-look="${lookAt}"><b>${esc(lookN === 1 ? '1 more thing in it needs a look' : `${lookN} more things in it need a look`)}</b><span>Where each one goes</span></button></div>` : ''}
    ${waiting.length ? `<div class="sheet-foot"><button class="btn btn-primary btn-big" type="button" id="shipgo" data-focus>${goWords()}</button>
      ${wrong || house ? `<div class="btn-row">${wrong}${house}</div>` : ''}</div>` : wrong ? `<div class="btn-row">${wrong}</div>` : ''}`, { keep });
  if ($('shipwrong')) $('shipwrong').onclick = () => whoseSheet(sh, { from: kids[0], keep: true, how: `On ${kidById(kids[0])?.short}’s list` });
  const refresh = () => { const b = $('shipgo'); if (b) { b.textContent = goWords(); b.disabled = !ticked.size; } };
  document.querySelectorAll('#sheet-root [data-shipitem]').forEach((c) => { c.onchange = () => { if (c.checked) ticked.add(c.dataset.shipitem); else ticked.delete(c.dataset.shipitem); refresh(); }; });
  document.querySelectorAll('#sheet-root [data-boxes]').forEach((el) => {
    el.querySelectorAll('[data-bstep]').forEach((b) => {
      b.onclick = (e) => {
        // The stepper sits inside the row's label: a tap on it changes the boxes, never the tick
        e.preventDefault();
        const id = el.dataset.boxes;
        boxes.set(id, Math.min(20, Math.max(1, boxes.get(id) + Number(b.dataset.bstep))));
        el.querySelector('output').textContent = boxes.get(id);
        refresh();
      };
    });
  });
  if ($('shiphouse')) $('shiphouse').onclick = async () => {
    for (const i of waiting.filter((x) => ticked.has(x.id))) {
      const it = itemOfId(i.id), k = kidOfItem(i.id);
      try { await sendOrKeep('house', { tap: newTap(), jobId: k.jobId, itemId: it.itemId, partKey: it.partKey, name: it.name, line: it.line }); } catch (err) { toast(err.message); return; }
    }
    await close();
    render();
    toast('Marked as gone to the house');
  };
  if (!$('shipgo')) return;
  $('shipgo').onclick = () => {
    const chosen = waiting.filter((i) => ticked.has(i.id));
    if (!chosen.length) return;
    const items = chosen.map((i) => { const it = itemOfId(i.id), k = kidOfItem(i.id); return { tap: taps.get(i.id), jobId: k.jobId, itemId: it.itemId, partKey: it.partKey, name: it.name, line: it.line, units: Math.max(1, it.qty - (it.got || 0)), boxes: boxes.get(i.id) }; });
    shipDone(sh, items);
  };
}

/**
 * Checking a shipment in: the done sheet rises at once (Saving, then a tick, as a single check-in does), then says
 * where each kid's things go, by name, with the labels' state; Print again when they didn't print; Undo takes the
 * whole shipment back
 */
async function shipDone(sh, items) {
  const byKid = new Map();
  for (const it of items) byKid.set(it.jobId, [...(byKid.get(it.jobId) || []), it]);
  const labels = items.reduce((t, it) => t + it.boxes, 0);
  const callouts = (shelfOf) => [...byKid].map(([jobId, list]) => { const k = kidById(jobId); return `<div class="shelf-callout static"><span class="who">${face(k, 36)}${esc(k?.short || '')}</span><b>${esc(shelfOf(jobId) || '…')}</b>
      <span class="sc-items">${list.map((x) => `<span>${esc(x.name)}${x.boxes > 1 ? ` (${x.boxes} boxes)` : ''}</span>`).join('')}</span></div>`; }).join('');
  openSheet(`<div class="sheet-head"><div><h3 tabindex="-1" data-focus>${esc(sh.store)}</h3><div class="sheet-sub" id="shipsaid">Checking in ${plural(items.length, 'thing')}</div></div>
      <button class="x" type="button" data-close="1" aria-label="Close">${ICON.x}</button></div>
    <div class="done-line" id="saved" style="--after:0ms">${ICON.wait}<span>Saving</span></div>
    <div class="done-line sub" id="printed" hidden></div>
    <div id="callouts">${callouts((j) => kidById(j)?.shelf)}</div>
    <div class="after"><button class="btn btn-primary btn-big" type="button" id="next">Scan the next box</button>
      <div class="btn-row"><button class="btn btn-text" type="button" data-close="1">Done</button><button class="btn btn-text" type="button" id="shipundo" hidden>Undo</button></div></div>`, { keep: true });
  $('next').onclick = async () => { await close(); scan(); };
  state.renderOnClose = true;
  let r;
  try { r = await sendOrKeep('receive', { items }); } catch (err) {
    tones.warn();
    $('saved').innerHTML = `${ICON.warn}<span>Not saved: ${esc(err.message)}</span>`;
    $('next').textContent = 'Try again';
    // The same ids: if the site did save some before the error, trying again can't count them twice
    $('next').onclick = () => shipDone(sh, items);
    return;
  }
  const results = new Map((r.out?.results || []).map((x) => [x.tap, x]));
  const refused = items.filter((it) => results.get(it.tap)?.error);
  const ok = items.filter((it) => !refused.includes(it));
  for (const it of ok) state.shipTaps.delete([...state.shipTaps].find(([, t]) => t === it.tap)?.[0]);
  // Waiting on the phone, it shows as here at once (overlayQueue), so it can't be checked in a second time meanwhile
  if (refused.length) tones.warn(); else tones.ok();
  const p = printSaid(r.queued ? null : r.out?.print);
  $('shipsaid').textContent = r.queued ? 'Saved on this phone. It goes to JobTread when the connection is back.' : `${plural(ok.length, 'thing')} checked in${refused.length ? `, ${refused.length} not` : ''}`;
  $('saved').innerHTML = `${refused.length ? ICON.warn : ICON.tick}<span>${esc(refused.length ? `Not checked in: ${refused.map((it) => `${it.name} (${results.get(it.tap).error})`).join('; ')}` : r.queued ? 'Saved on this phone' : 'Saved. JobTread in a minute.')}</span>`;
  const pr = $('printed');
  pr.hidden = false;
  pr.innerHTML = `${p.ok ? ICON.tick : ICON.warn}<span>${esc(r.queued ? `${plural(labels, 'label')} print when it’s sent` : p.ok ? `${plural(labels, 'label')} printing` : p.text)}</span>${!p.ok && !r.queued && r.out?.print?.setUp ? '<button class="btn btn-text inline" type="button" id="again">Print again</button>' : ''}`;
  const shelfOf = (jobId) => { const x = ok.find((it) => it.jobId === jobId && results.get(it.tap)?.shelf); return x ? shelfName(results.get(x.tap).shelf) : kidById(jobId)?.shelf; };
  $('callouts').innerHTML = callouts(shelfOf);
  if ($('again')) $('again').onclick = async () => {
    let said = null;
    for (const it of ok) { try { said = printSaid((await send('reprint', { tap: it.tap })).print); } catch (err) { said = { text: err.message }; } }
    pr.querySelector('span').textContent = said?.text || '';
  };
  const undo = $('shipundo');
  undo.hidden = !ok.length;
  undo.onclick = async () => {
    let r;
    try { r = await undoTaps(ok.map((it) => it.tap)); } catch (err) { toast(err.message); return; }
    if (r.refused.size) { toast(`Not taken back: ${[...r.refused.values()][0]}`); return; }
    tones.undo();
    await close();
    render();
    toast('Taken back');
  };
}
