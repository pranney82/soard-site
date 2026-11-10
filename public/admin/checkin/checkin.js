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
const state = { kids: [], needsLook: [], shelves: [], printer: null, practice: true, since: null, filter: 'All', query: '', openHere: new Set(), foundBoxes: 1, mode: 'in', me: null };
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

const ICON = {
  chev: '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  tick: '<span class="tick"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg></span>',
  wait: '<span class="tick wait"><span class="spin" aria-hidden="true"></span></span>',
  warn: '<span class="tick warn" aria-hidden="true">!</span>',
};

// ─── Talking to the site; a check-in made offline waits on this phone ───

const QUEUE_KEY = 'soard-checkin-queue';
const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
const writeQueue = (q) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* private window: it can't wait, it's sent now or said */ } };
const QUEUEABLE = new Set(['receive', 'other', 'house', 'undo', 'shelf', 'decide']);

class Offline extends Error {}

/** POST an action → the site's answer (its fresh view is applied); no connection → Offline */
async function send(action, body) {
  let res;
  try {
    res = await fetch(`/api/kid-items-admin?${action}=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Offline('No connection');
  }
  if ([502, 503, 504].includes(res.status) && QUEUEABLE.has(action)) throw new Offline('The site didn’t answer');
  const out = await res.json().catch(() => ({}));
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
    writeQueue([...readQueue(), { id: body.tap || newTap(), action, body, at: Date.now() }]);
    showQueue();
    return { queued: true };
  }
}

let flushing = false;
// Refused for good: the item or line is gone, or it was already settled. Anything else (a sign-in that ran out, the
// site down) waits on the phone and is tried again
const FOR_GOOD = new Set([400, 404, 409]);
async function flush() {
  if (flushing) return;
  if (!readQueue().length) { showQueue(); return; }
  flushing = true;
  const done = new Set();
  try {
    for (const q of readQueue()) {
      try { await send(q.action, q.body); done.add(q.id); } catch (err) {
        if (FOR_GOOD.has(err.status)) { done.add(q.id); toast(`A check-in couldn’t be saved: ${err.message}`); continue; }
        if (err.status === 403) toast('Your sign-in ran out. Reload the page to sign in, and what’s waiting will save.');
        break;
      }
    }
  } finally {
    // What was added while this ran stays: only what was sent (or refused for good) comes off
    writeQueue(readQueue().filter((q) => !done.has(q.id)));
    flushing = false;
    showQueue();
    if (done.size) render();
  }
}
/** Undo a check-in: one still waiting on this phone just comes off the queue */
async function undoTap(tap) {
  const q = readQueue();
  if (q.some((x) => x.body?.tap === tap)) {
    writeQueue(q.filter((x) => x.body?.tap !== tap));
    showQueue();
    return { local: true };
  }
  return sendOrKeep('undo', { tap });
}
function showQueue() {
  const n = readQueue().length;
  const el = $('queue');
  el.hidden = !n;
  el.textContent = n ? `${n} to save` : '';
  el.setAttribute('aria-label', n ? `${plural(n, 'check-in')} waiting for the connection` : '');
  // One chip up top at a time: what's waiting matters more than Practice
  $('mode').hidden = Boolean(n) || !state.practice;
}
window.addEventListener('online', flush);
setInterval(flush, 15000);

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
  Object.assign(state, { kids: view.kids || [], needsLook: view.needsLook || [], shelves: view.shelves || [], practice: view.practice !== false, since: view.since || null, printer: view.printer || state.printer });
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
const atOffice = (it) => (it.got || 0) > (it.sent || 0) && it.status !== 'house';
const toLoad = (it) => Math.max(0, (it.got || 0) - (it.sent || 0));
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
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  if (state.mode === 'out') { renderOut(); return; }
  $('scan').querySelector('span').textContent = 'Scan a box';
  $('other').textContent = 'Something else';
  $('chips').innerHTML = ['All', ...state.kids.map((k) => k.short)]
    .map((n) => `<button class="chip${n === 'All' ? '' : ' has-face'}" type="button" aria-pressed="${n === state.filter}" data-chip="${esc(n)}">${n === 'All' ? '' : faceOf(n, 26)}${esc(n)}</button>`).join('');
  let html = state.needsLook.length && !state.query && state.filter === 'All'
    ? `<button class="strip" type="button" id="looks"><b>Needs a look</b><span class="count-warn">${state.needsLook.length}</span>${ICON.chev}</button>` : '';
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
  return new Promise((resolve) => { closeTimer = setTimeout(() => { $('sheet-root').innerHTML = ''; resolve(); }, reduced() ? 0 : 240); });
}

/** A new sheet rises; a sheet turning into the next one keeps its place and eases to its new height */
function openSheet(inner, { keep = false, label = '' } = {}) {
  clearTimeout(closeTimer);
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
function itemSheet(kid, it, { found = '', keep = false, boxes: preset = 1 } = {}) {
  if (state.mode === 'out' && atOffice(it)) { outSheet(kid, it, { keep }); return; }
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
  const last = live[live.length - 1];
  const waiting = !last;
  const rows = live.map((r) => `<div class="receipt"><span>${r.kind === 'house' ? `Went to the house${byWho(r)}` : r.kind === 'out' ? `${r.units > 1 ? `${r.units} out` : 'Out'} to the house ${dayOf(r.at)}${byWho(r)}` : `${plural(r.units, 'came', 'came')} ${dayOf(r.at)}${r.boxes ? `, ${plural(r.boxes, 'box', 'boxes')}` : ''}${byWho(r)}`}</span>${r.shelf ? `<button class="tag-here as-btn" type="button" data-move="${esc(r.id)}" aria-label="Move it from ${esc(shelfName(r.shelf))}">${esc(shelfName(r.shelf))}</button>` : ''}</div>`).join('');
  openSheet(`${head(kidTitle(kid), { kid: true })}
    <p class="item-name">${esc(it.name)}</p>
    ${factsHtml(factsOf(it))}
    <div class="receipts">${waiting ? '<div class="receipt"><span>Waiting on this phone for the connection</span></div>' : rows}</div>
    ${last?.kind === 'receive' && !last.waiting ? '<button class="btn btn-big" type="button" id="reprint" data-focus>Print again</button>' : ''}
    ${waiting ? '' : '<div class="btn-row"><button class="btn btn-text" type="button" id="undo">Undo the check-in</button></div>'}`, { keep });
  if ($('reprint')) $('reprint').onclick = async () => {
    try { const out = await send('reprint', { tap: last.id }); toast(printSaid(out.print).text); } catch (err) { toast(err.message); }
  };
  if ($('undo')) $('undo').onclick = async () => {
    const r = await undoTap(last.id).catch((err) => { toast(err.message); return null; });
    if (!r) return;
    if (r.queued || r.local) { last.undone = true; it.got = Math.max(0, (it.got || 0) - (last.units || 0)); it.status = it.order ? 'ordered' : 'not'; }
    await close();
    render();
  };
  bindMoves(kid, it);
}

/** Say what happened to the labels, in a few words */
function printSaid(p) {
  if (!p) return { ok: false, text: 'Saved. The labels print when it’s sent.' };
  if (p.printed) return { ok: true, text: p.printed === 1 ? 'Printed' : `${p.printed} printed` };
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
      <div class="label-foot"><span>In ${esc(dayOf())}<br>SOARD</span><canvas data-qr="${esc(tap)}" aria-label="QR code"></canvas></div>
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
  document.querySelectorAll('canvas[data-qr]').forEach((c) => drawQr(c, `${location.origin}/admin/checkin/?r=${encodeURIComponent(tap)}`));
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
  if (res.queued) { it.got = (it.got || 0) + units; it.status = it.got >= it.qty ? 'here' : 'partly'; it.receipts = [...(it.receipts || []), { id: tap, kind: 'receive', units, boxes, shelf: null, at: new Date().toISOString(), waiting: true }]; }
  const finish = async (next) => {
    await close();
    if (next) { scan(); setTimeout(() => leave(kid, it), 400); return; }
    leave(kid, it);
  };
  $('done').onclick = () => finish(false);
  $('next').onclick = () => finish(true);
  $('undo').onclick = async () => {
    try { await undoTap(tap); } catch (err) { toast(err.message); return; }
    if (res.queued) { it.got = Math.max(0, (it.got || 0) - units); it.status = it.order ? 'ordered' : 'not'; }
    await close();
    render();
    toast('Taken back');
  };
  $('moveit').onclick = () => (out.receipt ? shelfPicker(kid, tap, () => printedShelf(kid)) : null);
}
const printedShelf = (kid) => { const s = $('shelf'); if (s) s.textContent = kidById(kid.jobId)?.shelf || s.textContent; };

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
  const here = (k) => (k === fromKid ? (it.also ? 'also' : `line:${it.id}`) : '');
  const draw = () => {
    openSheet(`${head('Where does it go?', { sub: esc(it.name), one: true })}
      <div class="kidpick">${state.kids.map((k) => `<button class="chip has-face" type="button" data-pick="${esc(k.jobId)}" aria-pressed="${k === kid}">${face(k, 32)}${esc(k.short)}</button>`).join('')}</div>
      <div class="field"><label for="where">${esc(kid.short)}’s</label><select id="where">${optionsFor(kid, { current: here(kid), guess: here(kid) })}</select></div>
      <button class="btn btn-primary btn-big" type="button" id="save" data-focus>Move it</button>`, { keep: true });
    document.querySelectorAll('#sheet-root [data-pick]').forEach((b) => { b.onclick = () => { kid = kidById(b.dataset.pick); draw(); }; });
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

/** Something else that came: for which kid, what, what it cost; it goes on their budget as Also bought */
function otherSheet() {
  if (!state.kids.length) return;
  let kidId = state.filter !== 'All' ? state.kids.find((k) => k.short === state.filter)?.jobId || state.kids[0].jobId : state.kids[0].jobId;
  let donated = false;
  openSheet(`${head('Something else')}
    <div class="field"><span class="label-above">For</span><div class="kidpick">${state.kids.map((k) => `<button class="chip has-face" type="button" data-pick="${esc(k.jobId)}" aria-pressed="${k.jobId === kidId}">${face(k, 32)}${esc(k.short)}</button>`).join('')}</div></div>
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
    const kid = kidById(kidId);
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
  let kid = kidById(o.kid) || null;
  const draw = () => {
    openSheet(`${head(esc(o.store), { sub: esc([o.po ? `PO “${o.po}”` : null, `ordered ${ago(o.at)}`, o.buyer ? `by ${o.buyer}` : null, o.orderNumber ? `order ${o.orderNumber}` : null].filter(Boolean).join(' · ')) })}
      ${o.why ? `<p class="why-line">${esc(o.why)}</p>` : ''}
      <div class="field"><span class="label-above">Whose is it?</span><div class="kidpick">${state.kids.map((k) => `<button class="chip has-face${k.jobId === o.kid ? ' hint' : ''}" type="button" data-assign="${esc(k.jobId)}" aria-pressed="${k === kid}">${face(k, 32)}${esc(k.short)}</button>`).join('')}</div></div>
      ${kid ? `<div class="pick">${o.items.map((i, x) => `<div class="look"><b>${esc(i.name)}</b><span class="why">${esc(i.look)}</span>
        <select data-item="${x}" aria-label="Where ${esc(i.name)} goes">${optionsFor(kid, { undo: Boolean(o.undo), current: i.current || '', guess: i.current || (i.guesses?.[kid.jobId] ? `line:${i.guesses[kid.jobId]}` : 'also') })}</select></div>`).join('')}</div>
        <button class="btn btn-primary btn-big" type="button" id="save" data-focus>Save</button>` : ''}
      <button class="btn btn-text" type="button" id="notkid">Not a kid’s</button>`, { keep: true });
    document.querySelectorAll('#sheet-root [data-assign]').forEach((b) => { b.onclick = () => { kid = kidById(b.dataset.assign); draw(); }; });
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
const stopCamera = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; document.querySelector('.cam')?.remove(); };

/** The camera in the page, its shutter where Scan a box sits; the phone's own camera when the page can't have one */
async function scan() {
  if (!navigator.mediaDevices?.getUserMedia) { $('camera').click(); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch {
    stream = null;
    $('camera').click();
    return;
  }
  const cam = document.createElement('div');
  cam.className = 'cam';
  cam.innerHTML = `<video autoplay playsinline muted></video><div class="frame" aria-hidden="true"></div><div class="flash"></div>
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
    const out = await send('scan', { image });
    showFound(out, preview);
  } catch (err) {
    openSheet(`${head('Couldn’t read that label', { sub: esc(err instanceof Offline ? 'No connection. Pick it from the list.' : err.message) })}
      <img class="photo" src="${preview}" alt="The photo of the box's label" />
      <button class="btn btn-primary btn-big" type="button" data-rescan="1" data-focus>Take it again</button>
      <button class="btn btn-text" type="button" data-close="1">Pick from the list</button>`, { keep: true });
  }
}

function showFound({ found, label }, preview) {
  const kid = found && kidById(found.kid);
  const items = kid ? found.items.map((id) => kid.items.find((i) => i.id === id)).filter((i) => i && !isHere(i)) : [];
  state.foundBoxes = Number(label?.boxTotal) || 1;
  if (kid && items.length === 1) { itemSheet(kid, items[0], { found: found.how, keep: true, boxes: state.foundBoxes }); return; }
  if (kid && items.length) {
    openSheet(`${head(kidTitle(kid), { kid: true, sub: esc(found.how) })}
      <span class="label-above">Which is in the box?</span>
      <div class="pick">${items.map((i) => rowHtml(kid, i)).join('')}</div>`, { keep: true });
    return;
  }
  const bits = [label?.store, label?.po ? `PO ${label.po}` : null, ...(label?.trackingNumbers || []).map((t) => `…${t.slice(-6)}`), ...(label?.orderNumbers || [])].filter(Boolean);
  openSheet(`${head(kid ? `Everything for ${esc(kid.short)} from that order is here` : 'Couldn’t match this box', { sub: bits.map(esc).join(' · ') })}
    <img class="photo" src="${preview}" alt="The photo of the box's label" />
    <button class="btn btn-primary btn-big" type="button" data-close="1" data-focus>Pick from the list</button>
    <button class="btn btn-text" type="button" data-other="1">Something else</button>`, { keep: true });
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
  if (t.dataset.loadkid) { state.loadKid = t.dataset.loadkid; render(); window.scrollTo({ top: 0 }); return; }
  if (t.dataset.back) { state.loadKid = null; render(); window.scrollTo({ top: 0 }); return; }
  if (t.dataset.tick) { tick(t.dataset.kid, t.dataset.tick); return; }
  if (t.dataset.missing) { (state.openMissing ||= new Set()).add(t.dataset.missing); render(); return; }
  if (t.dataset.loaded) { (state.openLoaded ||= new Set()).add(t.dataset.loaded); render(); return; }
  if (t.classList.contains('row') && t.dataset.id) {
    const kid = kidById(t.dataset.kid);
    const it = kid?.items.find((i) => i.id === t.dataset.id);
    const inSheet = Boolean(t.closest('.sheet'));
    if (it) itemSheet(kid, it, { keep: inSheet, found: inSheet && !isHere(it) ? 'In this box' : '', boxes: inSheet ? state.foundBoxes : 1 });
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (document.querySelector('.cam')) stopCamera(); else close(); } });
$('q').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
// The dock's second button: Something else when checking in, Load all when loading a kid out
$('other').addEventListener('click', () => {
  if (state.mode !== 'out') { otherSheet(); return; }
  const k = kidById(state.loadKid);
  if (k) loadAllSheet(k);
});
$('scan').addEventListener('click', () => {
  if (state.mode !== 'out') { scan(); return; }
  tones.wake();
  scanLabels(kidById(state.loadKid) || null);
});

document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  if (state.mode === b.dataset.mode) return;
  state.mode = b.dataset.mode;
  state.openHere.clear();
  state.loadKid = null;
  render();
  window.scrollTo({ top: 0 });
}));
$('printer').addEventListener('click', () => shelvesSheet());
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
  const r = q.get('r'), shelf = q.get('shelf');
  if (!r && !shelf) return;
  history.replaceState(null, '', location.pathname);
  if (shelf) { shelfSheet(shelf); return; }
  for (const k of state.kids) {
    const it = k.items.find((i) => (i.receipts || []).some((x) => x.id === r));
    if (it) { itemSheet(k, it); return; }
  }
  toast('That label’s item isn’t on the list any more (its makeover may be finished).');
}

async function load() {
  try {
    const res = await fetch('/api/kid-items-admin?checkin=1', { headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.error || `The site answered ${res.status}`);
    apply(body);
    // A makeover's Project Manager loads out: the page opens on Check out for them (Peter, Nov 10 2026)
    state.me = body.me || null;
    if (!state.loadedOnce) state.mode = state.me?.pm ? 'out' : 'in';
    state.loadedOnce = true;
    state.printerUrl = body.printerUrl || '';
    render();
    showQueue();
    openFromLink();
    flush();
  } catch (err) {
    $('list').innerHTML = `<div class="empty"><span>The list didn’t load. ${esc(err.message)}</span><button class="btn" type="button" id="retry">Try again</button></div>`;
    $('retry').onclick = () => { $('list').innerHTML = '<div class="hold"></div><div class="hold"></div>'; load(); };
  }
}
load();

// ─── Check out: load-out to the house ───────────────────────────────
// Christian loads one makeover at a time: pick the kid, then their boxes by shelf, ticked off by scanning each label
// (or a tap). Another kid's box is stopped, every scan is heard, and the end says what isn't here yet.

const STAGE_RANK = { Build: 0, Mobilization: 1, Design: 2 };

/** Boxes of an item still at the Office: each check-in's boxes, less the ones whose label was scanned out or that went with Load all */
function boxesLeft(it) {
  const live = (it.receipts || []).filter((r) => !r.undone);
  const scanned = new Set(live.filter((r) => r.kind === 'out' && r.ref).map((r) => r.ref));
  let tapped = live.filter((r) => r.kind === 'out' && !r.ref).reduce((t, r) => t + (r.units || 0), 0);
  let boxes = 0;
  for (const r of live.filter((x) => x.kind === 'receive')) {
    if (scanned.has(r.id)) continue;
    if (tapped >= r.units) { tapped -= r.units; continue; }
    boxes += Math.max(1, r.boxes || 1);
  }
  return boxes;
}
const boxesOut = (it) => (it.receipts || []).filter((r) => !r.undone && r.kind === 'receive').reduce((t, r) => t + Math.max(1, r.boxes || 1), 0) - boxesLeft(it);
const kidLoad = (kid) => {
  const load = kid.items.filter(atOffice);
  const left = load.reduce((t, i) => t + boxesLeft(i), 0);
  const done = kid.items.reduce((t, i) => t + boxesOut(i), 0);
  return { load, left, done, total: left + done, missing: kid.items.filter((i) => ['ordered', 'not', 'partly'].includes(i.status)), out: kid.items.filter((i) => i.status === 'out' || i.status === 'house') };
};
const boxWord = (n) => plural(n, 'box', 'boxes');
const notHereYet = (n) => (n === 1 ? '1 thing isn’t here yet' : `${n} things aren’t here yet`);

function renderOut() {
  const kid = kidById(state.loadKid);
  if (kid) renderLoad(kid); else renderOutHome();
}

/** Who's being loaded: each kid with what's at the Office (boxes and shelves) and what isn't here yet; theirs first */
function renderOutHome() {
  $('scan').querySelector('span').textContent = 'Scan labels';
  $('other').textContent = '';
  const kids = state.kids.map((k) => ({ k, l: kidLoad(k) }))
    .filter(({ k, l }) => !state.query || [k.short, ...k.items.map((i) => i.name)].some((x) => String(x).toLowerCase().includes(state.query.toLowerCase())))
    .sort((a, b) => (b.l.left > 0) - (a.l.left > 0) || (STAGE_RANK[a.k.stage] ?? 9) - (STAGE_RANK[b.k.stage] ?? 9) || b.l.left - a.l.left);
  $('list').innerHTML = kids.length ? `<div class="label-above out-q">Who are you loading?</div>${kids.map(({ k, l }) => `
    <button class="kid-tile" type="button" data-loadkid="${esc(k.jobId)}">
      ${face(k, 56)}
      <span class="kt-body"><b>${esc(k.short)}</b>
        <span>${l.left ? `${boxWord(l.left)}${k.shelves.length ? ` · ${esc(k.shelves.map(shelfName).join(', '))}` : ''}` : l.done ? 'All loaded' : 'Nothing at the Office yet'}</span>
        ${l.missing.length ? `<span class="kt-warn">${plural(l.missing.length, 'thing')} not here yet</span>` : ''}</span>
      ${k.stage ? `<span class="kt-stage">${esc(k.stage)}</span>` : ''}${ICON.chev}
    </button>`).join('')}` : `<div class="empty">${state.query ? 'Nothing matches that.' : 'No makeovers to load.'}</div>`;
  showPrinter();
}

/** One kid's load: their boxes by shelf (tick one off, or scan its label), what isn't here yet, what's loaded */
function renderLoad(kid) {
  const l = kidLoad(kid);
  $('scan').querySelector('span').textContent = `Scan ${kid.short.split(' ')[0]}’s labels`;
  $('other').textContent = l.left ? `Load all ${boxWord(l.left)}` : '';
  const byShelf = new Map();
  for (const it of l.load) byShelf.set(it.shelf || '', [...(byShelf.get(it.shelf || '') || []), it]);
  const shelves = [...byShelf].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
  let html = `<button class="back" type="button" data-back="1">${ICON.chev}<span>All kids</span></button>
    <section class="card load-head" aria-label="${esc(kid.short)}">
      <div class="card-head">
        <div class="card-title"><div class="who">${face(kid, 56)}<div><h2>${esc(kid.short)}</h2>${kid.stage ? `<span class="kt-stage">${esc(kid.stage)}</span>` : ''}</div></div>
          <span class="count big"><b>${l.done}</b> of ${l.total} ${l.total === 1 ? 'box' : 'boxes'}<br><span>loaded</span></span></div>
        <div class="bar" aria-hidden="true"><i data-bar="${esc(kid.jobId)}" style="transform:scaleX(${l.total ? l.done / l.total : 0})"></i></div>
      </div>
      ${!l.left && l.done ? `<div class="all-loaded">${ICON.tick}<span>Everything at the Office is loaded${l.missing.length ? `. ${notHereYet(l.missing.length)}.` : '.'}</span></div>` : ''}
    </section>`;
  if (shelves.length) {
    html += '<section class="card">';
    for (const [shelf, items] of shelves) {
      const n = items.reduce((t, i) => t + boxesLeft(i), 0);
      html += `<div class="group-h"><span>${esc(shelfName(shelf) || 'At the Office')}</span><span>${boxWord(n)}</span></div>${items.map((i) => loadRow(kid, i)).join('')}`;
    }
    html += '</section>';
  } else if (!l.done) {
    html += '<div class="empty">Nothing for them at the Office yet.</div>';
  }
  if (l.missing.length) {
    html += `<section class="card">${state.openMissing?.has(kid.jobId)
      ? `<div class="group-h warn"><span>Not here yet</span><span>${l.missing.length}</span></div>${l.missing.map((i) => rowHtml(kid, i)).join('')}`
      : `<button class="more warn" type="button" data-missing="${esc(kid.jobId)}"><span>${plural(l.missing.length, 'thing')} not here yet</span>${ICON.chev}</button>`}</section>`;
  }
  if (l.out.length) {
    html += `<section class="card">${state.openLoaded?.has(kid.jobId)
      ? `<div class="group-h"><span>Loaded</span><span>${l.out.length}</span></div>${l.out.map((i) => loadRow(kid, i)).join('')}`
      : `<button class="more" type="button" data-loaded="${esc(kid.jobId)}"><span>${plural(l.out.length, 'thing')} loaded</span>${ICON.chev}</button>`}</section>`;
  }
  $('list').innerHTML = html;
  showPrinter();
}

/** A row to tick off: the circle loads it (and, filled, takes it back); the rest of the row opens it */
function loadRow(kid, it) {
  const done = it.status === 'out' || it.status === 'house';
  const n = done ? 0 : boxesLeft(it);
  const sub = [it.line, done ? (it.status === 'house' ? 'Went straight to the house' : 'Loaded') : boxWord(n), it.sent && !done ? `${it.sent} of ${it.got} loaded` : null].filter(Boolean).join(' · ');
  return `<div class="lrow${done ? ' done' : ''}" data-row="${esc(it.id)}">
    <button class="tickbtn" type="button" data-kid="${esc(kid.jobId)}" data-tick="${esc(it.id)}" aria-pressed="${done}" aria-label="${done ? `Take back: ${esc(it.name)}` : `Loaded: ${esc(it.name)}`}"${it.status === 'house' ? ' disabled' : ''}>${ICON.tick}</button>
    <button class="row lrow-main" data-kid="${esc(kid.jobId)}" data-id="${esc(it.id)}" type="button"><span class="row-name">${esc(it.name)}</span><span class="row-sub">${esc(sub)}</span></button>
  </div>`;
}

/** One tap: all of it that's at the Office goes on the truck; tapped again, the last of it comes back */
async function tick(jobId, id) {
  const kid = kidById(jobId);
  const it = kid?.items.find((i) => i.id === id);
  if (!it) return;
  tones.wake();
  const done = it.status === 'out';
  try {
    if (done) {
      const last = [...(it.receipts || [])].reverse().find((r) => r.kind === 'out' && !r.undone);
      if (!last) return;
      const r = await undoTap(last.id);
      if (r.queued || r.local) { last.undone = true; it.sent = Math.max(0, (it.sent || 0) - (last.units || 0)); it.status = 'here'; }
      tones.undo();
    } else {
      const r = await sendOrKeep('out', { tap: newTap(), jobId, itemId: it.itemId, partKey: it.partKey, units: toLoad(it), name: it.name, line: it.line });
      if (r.queued) { it.sent = it.got; it.status = 'out'; }
      tones.ok();
    }
  } catch (err) { tones.warn(); toast(err.message); return; }
  render();
}

/** One thing at the Office: where it is, who checked it in, how many go, Out to the house */
function outSheet(kid, it, { keep = false } = {}) {
  const left = toLoad(it);
  let units = left;
  const came = (it.receipts || []).filter((r) => !r.undone && r.kind === 'receive');
  const last = came[came.length - 1];
  openSheet(`${head(kidTitle(kid), { kid: true })}
    <p class="item-name">${esc(it.name)}</p>
    ${factsHtml([['Where', shelfName(it.shelf) || 'At the Office'], ['Boxes', String(boxesLeft(it))], ['Came in', last ? `${dayOf(last.at)}${byWho(last)}` : ''], ['Line', it.line], it.sent ? ['Loaded already', String(it.sent)] : null].filter((f) => f && f[1]))}
    ${left > 1 ? stepper('units', 'How many go', units) : ''}
    <button class="btn btn-primary btn-big" type="button" id="sendout" data-focus>Loaded</button>`, { keep });
  const vals = steppers({ units: [1, left] }, (v) => { units = v.units; });
  units = vals.units ?? units;
  $('sendout').onclick = async () => {
    try {
      const r = await sendOrKeep('out', { tap: newTap(), jobId: kid.jobId, itemId: it.itemId, partKey: it.partKey, units, name: it.name, line: it.line });
      if (r.queued) { it.sent = (it.sent || 0) + units; if (it.sent >= it.got) it.status = 'out'; }
      tones.ok();
    } catch (err) { toast(err.message); return; }
    await close();
    render();
  };
}

/** Everything a kid has at the Office, loaded at once (each ticked to start) */
function loadAllSheet(kid) {
  const items = kid.items.filter(atOffice);
  if (!items.length) return;
  const boxesOf = (list) => list.reduce((t, i) => t + boxesLeft(i), 0);
  openSheet(`${head(kidTitle(kid), { kid: true, sub: 'Everything at the Office, on the truck' })}
    <div class="pick">${items.map((i) => `<label class="look check"><input type="checkbox" checked data-all="${esc(i.id)}" /><span><b>${esc(i.name)}</b><span>${esc([shelfName(i.shelf), boxWord(boxesLeft(i)), i.line].filter(Boolean).join(' · '))}</span></span></label>`).join('')}</div>
    <button class="btn btn-primary btn-big" type="button" id="allgo" data-focus>Loaded: ${boxWord(boxesOf(items))}</button>`);
  const chosenNow = () => [...document.querySelectorAll('#sheet-root [data-all]:checked')].map((c) => items.find((i) => i.id === c.dataset.all)).filter(Boolean);
  document.querySelectorAll('#sheet-root [data-all]').forEach((c) => { c.onchange = () => { const n = boxesOf(chosenNow()); $('allgo').textContent = n ? `Loaded: ${boxWord(n)}` : 'Pick what’s going'; $('allgo').disabled = !n; }; });
  $('allgo').onclick = async () => {
    const chosen = chosenNow();
    $('allgo').disabled = true;
    let done = 0, kept = 0;
    for (const it of chosen) {
      $('allgo').innerHTML = `<span class="spin" aria-hidden="true"></span>${done + 1} of ${chosen.length}`;
      try {
        const r = await sendOrKeep('out', { tap: newTap(), jobId: kid.jobId, itemId: it.itemId, partKey: it.partKey, units: toLoad(it), name: it.name, line: it.line });
        if (r.queued) { kept++; it.sent = it.got; it.status = 'out'; }
        done++;
      } catch (err) { toast(`${it.name}: ${err.message}`); }
    }
    tones.ok();
    await close();
    render();
    if (kept) toast(`${kept} wait for the connection`);
  };
}

/** Short tones for a scan (rising: loaded; low twice: stop; falling: taken back). Quiet, made in the page, no files */
const tones = (() => {
  let ac = null;
  const play = (notes) => {
    if (!ac) return;
    let t = ac.currentTime + 0.01;
    for (const [hz, ms] of notes) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
      t += ms / 1000 + 0.03;
    }
  };
  return {
    // Made on a tap: iPhones only let a page make sound after one
    wake: () => { try { ac ||= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch { ac = null; } },
    ok: () => play([[880, 70], [1320, 110]]),
    warn: () => play([[330, 140], [330, 140]]),
    undo: () => play([[990, 70], [660, 110]]),
  };
})();

/**
 * Scan labels: the camera stays open and reads each label's QR as it passes. Loading one kid, another kid's box is
 * stopped ("Colin L.'s box. Leave it here.") unless sent anyway; each box loaded says what's left, and the last one says
 * everything at the Office is loaded and what isn't here yet. A label read twice counts once
 */
let scanning = null;
async function scanLabels(scope) {
  let read;
  if ('BarcodeDetector' in window) {
    try { const bd = new window.BarcodeDetector({ formats: ['qr_code'] }); read = async (src) => (await bd.detect(src))[0]?.rawValue || null; } catch { read = null; }
  }
  if (!read) {
    let jsQR;
    try { jsQR = (await import('./jsqr.js')).default; } catch { toast('The label reader didn’t load. Tick the boxes on the list instead.'); return; }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    read = async (video) => {
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data || null;
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
  cam.innerHTML = `<video autoplay playsinline muted></video><div class="frame square" aria-hidden="true"></div>
    <div class="cam-top">${scope ? `${face(scope, 32)}<span>${esc(scope.short)}</span>` : ''}<b class="cam-count" aria-live="polite"></b></div>
    <div class="cam-said" aria-live="assertive" hidden></div>
    <button class="cam-close" type="button" aria-label="Done scanning">${ICON.x}</button>
    ${canTorch ? '<button class="cam-torch" type="button" aria-pressed="false" aria-label="Flashlight"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2h10l-2 6v12a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V8z"/><path d="M12 12v2"/></svg></button>' : ''}
    <button class="btn btn-primary cam-done" type="button">Done</button>`;
  document.body.appendChild(cam);
  const video = cam.querySelector('video');
  video.srcObject = stream;
  const seen = new Set();
  let loaded = 0, busy = false, saidTimer;
  const count = () => {
    const k = scope && kidById(scope.jobId);
    const l = k ? kidLoad(k) : null;
    cam.querySelector('.cam-count').textContent = l ? (l.total ? `${l.done} of ${l.total} boxes` : '') : loaded ? `${loaded} loaded` : '';
    return l;
  };
  count();
  const say = (cls, html, { stay = false } = {}) => {
    const el = cam.querySelector('.cam-said');
    el.className = `cam-said ${cls}`;
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(saidTimer);
    if (!stay) saidTimer = setTimeout(() => { el.hidden = true; }, 3200);
    return el;
  };
  const finish = () => { cancelAnimationFrame(scanning); scanning = null; stopCamera(); render(); };
  cam.querySelector('.cam-close').onclick = finish;
  cam.querySelector('.cam-done').onclick = finish;
  cam.querySelector('.cam-torch')?.addEventListener('click', async (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); e.currentTarget.setAttribute('aria-pressed', String(on)); } catch { /* not this phone */ }
  });
  const sendOut = async (ref, found) => {
    busy = true;
    try {
      const outTap = newTap();
      const r = await sendOrKeep('out', { tap: outTap, ref });
      const repeat = r.out?.repeat;
      if (!repeat) loaded++;
      if (r.queued && found) { found.i.sent = found.i.got; found.i.status = 'out'; }
      const l = count();
      const k = found ? kidById(found.k.jobId) : null;
      const boxes = found ? Math.max(1, (found.i.receipts || []).find((x) => x.id === ref)?.boxes || 1) : 1;
      if (repeat) { tones.undo(); say('info', `<b>Already loaded</b><span>${esc(found ? `${found.k.short}: ${found.i.name}` : '')}</span>`); return; }
      tones.ok();
      const end = l && l.left === 0;
      const el = say(end ? 'ok end' : 'ok', `${k ? face(k, 40) : ICON.tick}<b>${esc(found ? found.i.name : r.out?.item?.name || 'Loaded')}</b>
        <span>${esc(found ? found.k.short : '')}${boxes > 1 ? ` · ${boxWord(boxes)}: take all ${boxes}` : ''}</span>
        <span class="dim">${end ? `Everything for ${esc(scope.short)} at the Office is loaded${l.missing.length ? `. ${notHereYet(l.missing.length)}.` : '.'}` : l ? `${boxWord(l.left)} left` : r.queued ? 'Saves when the connection is back' : 'Loaded'}</span>
        <button class="cam-undo" type="button">Undo</button>`, { stay: end });
      if (end) cam.querySelector('.cam-done').textContent = 'Finish';
      el.querySelector('.cam-undo').onclick = async () => {
        try { await undoTap(outTap); } catch (err) { toast(err.message); return; }
        seen.delete(ref); loaded = Math.max(0, loaded - 1);
        tones.undo(); count(); cam.querySelector('.cam-done').textContent = 'Done';
        say('info', '<b>Taken back</b>');
      };
    } catch (err) {
      seen.delete(ref);
      tones.warn();
      say('warn', `<b>${esc(err.message)}</b>`);
    } finally {
      busy = false;
    }
  };
  let lastAt = 0;
  const frame = async (t) => {
    if (!document.body.contains(cam)) return;
    scanning = requestAnimationFrame(frame);
    if (busy || t - lastAt < 140 || !video.videoWidth) return;
    lastAt = t;
    busy = true;
    let data = null;
    try { data = await read(video); } catch { data = null; } finally { busy = false; }
    if (!data) return;
    let url = null;
    try { url = new URL(data); } catch { /* not a link */ }
    const ours = url?.pathname.startsWith('/admin/checkin');
    const ref = ours ? url.searchParams.get('r') : null;
    const shelf = ours ? url.searchParams.get('shelf') : null;
    if (shelf) {
      if (seen.has(`shelf:${shelf}`)) return;
      seen.add(`shelf:${shelf}`);
      const s = state.shelves.find((x) => x.shelf === shelf);
      say('info', `<b>${esc(shelfName(shelf))}</b><span>${esc(kidById(s?.kid)?.short || 'Free')}</span>`);
      return;
    }
    if (!ref) { if (!seen.has(data)) { seen.add(data); tones.warn(); say('warn', '<b>Not a SOARD label</b>'); } return; }
    if (seen.has(ref)) return;
    seen.add(ref);
    const found = state.kids.flatMap((k) => k.items.map((i) => ({ k, i }))).find(({ i }) => (i.receipts || []).some((r) => r.id === ref));
    if (scope && found && found.k.jobId !== scope.jobId) {
      // Another kid's box, while loading this one: stopped, unless it really is going
      tones.warn();
      const el = say('warn stop', `${face(found.k, 40)}<b>${esc(found.k.short)}’s box</b><span>${esc(found.i.name)}</span><span>Not ${esc(scope.short)}’s. Leave it here.</span><button class="cam-undo" type="button">Load it anyway</button>`, { stay: true });
      el.querySelector('.cam-undo').onclick = () => sendOut(ref, found);
      return;
    }
    sendOut(ref, found);
  };
  scanning = requestAnimationFrame(frame);
}
