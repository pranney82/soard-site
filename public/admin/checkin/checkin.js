/**
 * SOARD Check-in (/admin/checkin/): scan a box (or tap the item), print its labels, put it on the kid's shelf
 * ===========================================================================
 * Each open makeover's things to receive, from /api/kid-items-admin?checkin=1:
 * what was ordered and hasn't come (oldest first), what isn't ordered yet, and
 * the orders the site couldn't place. Scan a box opens the camera in the page
 * (the phone's own camera where the browser won't), takes a photo of the
 * label, and asks /api/kid-items-admin?scan=1 whose box it is. While the page
 * is in practice, Print shows the labels and marks the item here on this phone
 * only: nothing prints and JobTread doesn't change until the printer and the
 * JobTread writes are tested.
 */

const DAY = 86400e3;
const state = { kids: [], needsLook: [], practice: true, filter: 'All', query: '', openHere: new Set(), foundBoxes: 1 };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const daysAgo = (at) => Math.max(0, Math.floor((Date.now() - Date.parse(at)) / DAY));
const ago = (at) => { const d = daysAgo(at); return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const shortAgo = (at) => { const d = daysAgo(at); return d === 0 ? 'Today' : `${d}d`; };
const today = () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reduced() ? 0 : ms));
// iOS Safari shows :active only once the page listens for touches
document.addEventListener('touchstart', () => {}, { passive: true });

const ICON = {
  chev: '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  tick: '<span class="tick"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg></span>',
};

// ─── The list ───────────────────────────────────────────────────────

const matches = (kid, it) => {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [kid.short, it.name, it.line, it.order?.store].some((s) => String(s || '').toLowerCase().includes(q));
};

function rowHtml(kid, it) {
  const sub = [it.order?.store, it.line, it.qty > 1 ? `${it.qty} of them` : null].filter(Boolean).join(' · ');
  let side = '';
  if (it.status === 'ordered' && it.order?.at) side = `<span class="when${daysAgo(it.order.at) > 14 ? ' late' : ''}" title="Ordered ${esc(ago(it.order.at))}">${shortAgo(it.order.at)}</span>`;
  else if (it.status !== 'here' && it.source === 'donated') side = '<span class="when">Donated</span>';
  else if (it.status === 'here') side = `<span class="tag-here">${esc(kid.shelf)}</span>`;
  return `<button class="row${it.status === 'not' ? ' muted' : ''}" data-kid="${esc(kid.jobId)}" data-id="${esc(it.id)}" type="button"${it.status === 'here' ? ' tabindex="-1"' : ''}>
    <span class="row-name">${esc(it.name)}</span><span class="row-side">${side}</span>
    <span class="row-sub">${esc(sub)}</span></button>`;
}

function render() {
  $('chips').innerHTML = ['All', ...state.kids.map((k) => k.short)]
    .map((n) => `<button class="chip" type="button" aria-pressed="${n === state.filter}" data-chip="${esc(n)}">${esc(n)}</button>`).join('');
  let html = state.needsLook.length && !state.query && state.filter === 'All'
    ? `<button class="strip" type="button" id="looks"><b>Needs a look</b><span class="count-warn">${state.needsLook.length}</span>${ICON.chev}</button>` : '';
  for (const kid of state.kids.filter((k) => state.filter === 'All' || k.short === state.filter)) {
    const items = kid.items.filter((it) => matches(kid, it));
    if (state.query && !items.length) continue;
    const here = kid.items.filter((i) => i.status === 'here').length;
    const total = kid.items.length;
    const waiting = items.filter((i) => i.status === 'ordered');
    const notOrdered = items.filter((i) => i.status === 'not');
    const hereItems = items.filter((i) => i.status === 'here');
    html += `<section class="card" aria-label="${esc(kid.short)}">
      <div class="card-head">
        <div class="card-title"><h2>${esc(kid.short)}</h2><span class="count"><b>${here}</b> of ${total} here</span></div>
        <div class="bar" aria-hidden="true"><i data-bar="${esc(kid.jobId)}" style="transform:scaleX(${total ? here / total : 0})"></i></div>
      </div>`;
    if (waiting.length) html += `<div class="group-h"><span>Hasn’t come yet</span><span>${waiting.length}</span></div>${waiting.map((i) => rowHtml(kid, i)).join('')}`;
    if (notOrdered.length) html += `<div class="group-h"><span>Not ordered yet</span><span>${notOrdered.length}</span></div>${notOrdered.map((i) => rowHtml(kid, i)).join('')}`;
    if (hereItems.length) {
      html += state.openHere.has(kid.jobId) || state.query
        ? `<div class="group-h"><span>Here</span><span>${hereItems.length}</span></div>${hereItems.map((i) => rowHtml(kid, i)).join('')}`
        : `<button class="more" type="button" data-here="${esc(kid.jobId)}"><span>${plural(hereItems.length, 'thing')} here</span>${ICON.chev}</button>`;
    }
    html += '</section>';
  }
  $('list').innerHTML = html || `<div class="empty">${state.query ? 'Nothing matches that.' : 'Nothing waiting to be checked in.'}</div>`;
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
function openSheet(inner, { keep = false } = {}) {
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
const stepper = (boxes) => `<div class="stepper"><span>Boxes</span><div><button type="button" data-step="-1" aria-label="One box fewer">−</button><output aria-live="polite">${boxes}</output><button type="button" data-step="1" aria-label="One box more">+</button></div></div>`;
const kidTitle = (kid) => `${esc(kid.short)}<span class="tag-here">${esc(kid.shelf)}</span>`;

function itemSheet(kid, it, { found = '', keep = false, boxes: preset = 1 } = {}) {
  let boxes = Math.max(1, Math.min(9, preset));
  const facts = [
    it.order?.store ? ['From', it.order.store] : null,
    it.order ? ['Ordered', ago(it.order.at)] : null,
    it.order?.orderNumber ? ['Order', it.order.orderNumber] : null,
    it.orderedAs && it.orderedAs !== it.name ? ['Store calls it', it.orderedAs] : null,
    it.source === 'donated' ? ['Donated', 'Yes'] : null, it.qty > 1 ? ['How many', String(it.qty)] : null,
  ].filter(Boolean);
  openSheet(`${head(kidTitle(kid), { kid: true, sub: found ? esc(found) : '' })}
    <p class="item-name">${esc(it.name)}</p>
    ${facts.length ? `<dl class="facts">${facts.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>` : ''}
    ${stepper(boxes)}
    <button class="btn btn-primary btn-big" type="button" id="print" data-focus>Print ${boxes === 1 ? 'label' : `${boxes} labels`}</button>`, { keep });
  // The number changes in place: the sheet doesn't redraw for it
  $('sheet-root').querySelectorAll('[data-step]').forEach((b) => {
    b.onclick = () => {
      boxes = Math.min(9, Math.max(1, boxes + Number(b.dataset.step)));
      sheetEl().querySelector('.stepper output').textContent = boxes;
      $('print').textContent = `Print ${boxes === 1 ? 'label' : `${boxes} labels`}`;
    };
  });
  $('print').onclick = () => printed(kid, it, boxes);
}

function printed(kid, it, boxes) {
  const shown = Math.min(boxes, 3);
  const labels = Array.from({ length: boxes }, (_, i) => {
    const under = boxes - 1 - i; // 0 is the newest, on top
    const off = Math.min(under, 2) * 8;
    return `<div class="label" style="animation-delay:${i * 160}ms;z-index:${i + 1};transform:translate(${off}px, ${off}px)${under >= shown ? ';visibility:hidden' : ''}">
      <div class="label-kid">${esc(kid.short.toUpperCase())}</div>
      <div class="label-item">${esc(it.name)}</div>
      <div class="label-mid"><span class="label-box">Box ${i + 1} of ${boxes}</span><span class="label-shelf">${esc(kid.shelf)}</span></div>
      <div class="label-foot"><span>SOARD<br>In ${esc(today())}</span><canvas data-qr="${esc(it.id)}-${i}" aria-label="QR code"></canvas></div>
    </div>`;
  }).join('');
  const after = 620 + (boxes - 1) * 160;
  openSheet(`${head(boxes === 1 ? 'Label' : `${boxes} labels`, { sub: esc(it.name), one: true })}
    <div class="printer" aria-hidden="true"><div class="slot"></div><div class="stack" style="--peek:${(shown - 1) * 8}px">${labels}</div></div>
    <div class="done-line" style="--after:${after}ms">${ICON.tick}<span>${state.practice ? 'Marked here' : `Received in JobTread, ${esc(today())}`}</span>${state.practice ? '<span class="chip-mode">Practice</span>' : ''}</div>
    <div class="shelf-callout"><span>${esc(kid.short)}’s shelf</span><b>${esc(kid.shelf)}</b></div>
    <div class="after"><button class="btn btn-primary btn-big" type="button" id="next" data-focus>Scan the next box</button><button class="btn btn-text" type="button" id="done">Done</button></div>`, { keep: true });
  document.querySelectorAll('canvas[data-qr]').forEach((c) => drawQr(c, c.dataset.qr));
  document.querySelectorAll('.done-line .tick path').forEach((p) => p.style.setProperty('--after', `${after}ms`));
  const finish = async (next) => {
    it.status = 'here';
    await close();
    if (next) { scan(); setTimeout(() => leave(kid, it), 400); return; }
    leave(kid, it);
  };
  $('done').onclick = () => finish(false);
  $('next').onclick = () => finish(true);
}

/** Once the sheet is gone: the row fades, closes up, and the kid's bar grows */
async function leave(kid, it) {
  const row = document.querySelector(`#list .row[data-id="${CSS.escape(it.id)}"]`);
  const bar = document.querySelector(`[data-bar="${CSS.escape(kid.jobId)}"]`);
  const before = bar?.style.transform;
  if (row && !reduced()) {
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

// A QR in the label's look (the real label's QR comes with the printer)
function drawQr(canvas, seed) {
  const n = 25, ctx = canvas.getContext('2d');
  canvas.width = n; canvas.height = n;
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, n, n); ctx.fillStyle = '#111111';
  let s = 0; for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (rnd() > 0.5) ctx.fillRect(x, y, 1, 1);
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(ox - (ox ? 1 : 0), oy - (oy ? 1 : 0), 8, 8);
    ctx.fillStyle = '#111111'; ctx.fillRect(ox, oy, 7, 7); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(ox + 1, oy + 1, 5, 5); ctx.fillStyle = '#111111'; ctx.fillRect(ox + 2, oy + 2, 3, 3);
  }
}

function otherSheet() {
  if (!state.kids.length) return;
  let kidId = state.filter !== 'All' ? state.kids.find((k) => k.short === state.filter)?.jobId || state.kids[0].jobId : state.kids[0].jobId;
  let boxes = 1;
  openSheet(`${head('Something else')}
    <div class="field"><span class="label-above">For</span><div class="kidpick">${state.kids.map((k) => `<button class="chip" type="button" data-pick="${esc(k.jobId)}" aria-pressed="${k.jobId === kidId}">${esc(k.short)}</button>`).join('')}</div></div>
    <div class="field"><label for="what">What is it?</label><input id="what" type="text" placeholder="Bean bag chair" autocomplete="off" /></div>
    ${stepper(boxes)}
    <button class="btn btn-primary btn-big" type="button" id="print">Print label</button>`, { keep: Boolean(sheetEl()) });
  const input = $('what');
  $('sheet-root').querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = () => { kidId = b.dataset.pick; $('sheet-root').querySelectorAll('[data-pick]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); };
  });
  $('sheet-root').querySelectorAll('[data-step]').forEach((b) => {
    b.onclick = () => { boxes = Math.min(9, Math.max(1, boxes + Number(b.dataset.step))); sheetEl().querySelector('.stepper output').textContent = boxes; $('print').textContent = `Print ${boxes === 1 ? 'label' : `${boxes} labels`}`; };
  });
  $('print').onclick = () => {
    if (!input.value.trim()) { input.focus(); input.placeholder = 'Type what it is first'; return; }
    const kid = state.kids.find((k) => k.jobId === kidId);
    const it = { id: `other:${Date.now()}`, name: input.value.trim(), line: 'Also bought', qty: 1, source: 'buy', status: 'ordered', order: null };
    kid.items.push(it);
    printed(kid, it, boxes);
  };
}

// ─── Needs a look ───────────────────────────────────────────────────

function looksSheet(keep = false) {
  openSheet(`${head('Needs a look', { sub: plural(state.needsLook.length, 'order') })}
    <div class="pick">${state.needsLook.map((o, n) => `<button class="look" type="button" data-look="${n}"><b>${esc(o.store)}</b>
      <span>${esc([o.po ? `PO “${o.po}”` : null, ago(o.at), o.buyer].filter(Boolean).join(' · '))}</span>
      <span>${esc(o.items.slice(0, 2).map((i) => i.name).join(' · '))}${o.items.length > 2 ? ` and ${o.items.length - 2} more` : ''}</span></button>`).join('')}</div>`, { keep });
}

/** One order: whose is it? One tap puts its items on that kid's list; "Not a kid's" clears it */
function lookSheet(n) {
  const o = state.needsLook[n];
  if (!o) return;
  openSheet(`${head(esc(o.store), { sub: esc([o.po ? `PO “${o.po}”` : null, `ordered ${ago(o.at)}`, o.buyer ? `by ${o.buyer}` : null].filter(Boolean).join(' · ')) })}
    <div class="pick">${o.items.map((i) => `<div class="look"><b>${esc(i.name)}</b></div>`).join('')}</div>
    <div class="field"><span class="label-above">Whose is it?</span><div class="kidpick">${state.kids.map((k) => `<button class="chip${k.short === o.kid ? ' hint' : ''}" type="button" data-assign="${esc(k.jobId)}">${esc(k.short)}</button>`).join('')}</div></div>
    <button class="btn btn-text" type="button" data-notkid="1">Not a kid’s</button>`, { keep: true });
  const settle = async () => {
    state.needsLook.splice(n, 1);
    render();
    if (state.needsLook.length) looksSheet(true); else await close();
  };
  $('sheet-root').querySelectorAll('[data-assign]').forEach((b) => {
    b.onclick = () => {
      const kid = state.kids.find((k) => k.jobId === b.dataset.assign);
      for (const i of o.items) kid.items.push({ id: `look:${o.key}:${i.name}`.slice(0, 200), name: i.name, line: 'Also bought', qty: 1, source: 'buy', status: 'ordered', order: { store: o.store, orderNumber: o.orderNumber, at: o.at, buyer: o.buyer } });
      settle();
    };
  });
  $('sheet-root').querySelector('[data-notkid]').onclick = settle;
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
  openSheet(`${head('<span class="with-spin"><span class="spin" aria-hidden="true"></span>Reading the label</span>')}
    <img class="photo" src="${preview}" alt="The photo of the box's label" />`);
  try {
    const res = await fetch('/api/kid-items-admin?scan=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.error || 'The label couldn’t be read. Take the photo again.');
    showFound(body, preview);
  } catch (err) {
    openSheet(`${head('Couldn’t read that label', { sub: esc(err.message) })}
      <img class="photo" src="${preview}" alt="The photo of the box's label" />
      <button class="btn btn-primary btn-big" type="button" data-rescan="1" data-focus>Take it again</button>
      <button class="btn btn-text" type="button" data-close="1">Pick from the list</button>`, { keep: true });
  }
}

function showFound({ found, label }, preview) {
  const kid = found && state.kids.find((k) => k.jobId === found.kid);
  const items = kid ? found.items.map((id) => kid.items.find((i) => i.id === id)).filter((i) => i && i.status !== 'here') : [];
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
  if (t.classList.contains('row') && t.dataset.id) {
    const kid = state.kids.find((k) => k.jobId === t.dataset.kid);
    const it = kid?.items.find((i) => i.id === t.dataset.id);
    const inSheet = Boolean(t.closest('.sheet'));
    if (it && it.status !== 'here') itemSheet(kid, it, { keep: inSheet, found: inSheet ? 'In this box' : '', boxes: inSheet ? state.foundBoxes : 1 });
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (document.querySelector('.cam')) stopCamera(); else close(); } });
$('q').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
$('other').addEventListener('click', otherSheet);
$('scan').addEventListener('click', scan);
$('camera').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  const preview = URL.createObjectURL(f);
  try { read(await fromFile(f), preview); } catch (err) { openSheet(`${head('Couldn’t read that photo', { sub: esc(err.message) })}<button class="btn btn-primary btn-big" type="button" data-rescan="1" data-focus>Take it again</button>`); }
});
window.addEventListener('pagehide', stopCamera);

async function load() {
  try {
    const res = await fetch('/api/kid-items-admin?checkin=1', { headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.error || `The site answered ${res.status}`);
    Object.assign(state, { kids: body.kids || [], needsLook: body.needsLook || [], practice: body.practice !== false });
    $('mode').hidden = !state.practice;
    render();
  } catch (err) {
    $('list').innerHTML = `<div class="empty"><span>The list didn’t load. ${esc(err.message)}</span><button class="btn" type="button" id="retry">Try again</button></div>`;
    $('retry').onclick = () => { $('list').innerHTML = '<div class="hold"></div><div class="hold"></div>'; load(); };
  }
}
load();
