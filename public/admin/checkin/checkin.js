/**
 * SOARD Check-in (/admin/checkin/): scan a box (or tap the item), print its labels, put it on the kid's shelf
 * ===========================================================================
 * Each open makeover's things to receive, from /api/kid-items-admin?checkin=1:
 * what was ordered and hasn't come (oldest first), what isn't ordered yet, and
 * the orders the site couldn't place. Scan a box takes a photo of the label
 * and asks /api/kid-items-admin?scan=1 whose it is. While the page is in
 * practice, Print shows the labels and marks the item here on this phone only:
 * nothing prints and JobTread doesn't change until the printer and the JobTread
 * writes are tested.
 */

const DAY = 86400e3;
const state = { kids: [], needsLook: [], practice: true, filter: 'All', query: '', openHere: new Set() };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const daysAgo = (at) => Math.max(0, Math.floor((Date.now() - Date.parse(at)) / DAY));
const ago = (at) => { const d = daysAgo(at); return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const today = () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  const sub = [it.line, it.order?.store, it.qty > 1 ? `${it.qty} of them` : null].filter(Boolean).join(' · ');
  let side = '';
  if (it.status === 'ordered') side = `<span class="tag ${daysAgo(it.order.at) > 10 ? 'tag-late' : 'tag-wait'}">${esc(ago(it.order.at))}</span>`;
  if (it.status === 'not' && it.source === 'donated') side = '<span class="tag tag-wait">Donated</span>';
  if (it.status === 'here') side = `<span class="tag tag-here">${esc(kid.shelf)}</span>`;
  return `<button class="row${it.status === 'not' ? ' muted' : ''}" data-kid="${esc(kid.jobId)}" data-id="${esc(it.id)}" type="button"${it.status === 'here' ? ' tabindex="-1"' : ''}>
    <span class="row-name">${esc(it.name)}</span><span class="row-side">${side}${it.status === 'here' ? '' : ICON.chev}</span>
    <span class="row-sub">${esc(sub)}</span></button>`;
}

function lookCard() {
  if (!state.needsLook.length || state.query || state.filter !== 'All') return '';
  return `<section class="card" aria-label="Needs a look">
    <div class="card-head"><div class="card-title"><h2>Needs a look</h2><span class="count-warn">${state.needsLook.length}</span></div></div>
    ${state.needsLook.map((o) => `<div class="look-row"><b>${esc(o.store)}${o.kid ? ` · ${esc(o.kid)}` : ''}</b>
      <span>${esc([o.po ? `PO “${o.po}”` : null, `ordered ${ago(o.at)}`, o.buyer].filter(Boolean).join(' · '))}</span>
      ${o.items.slice(0, 3).map((i) => `<span>${esc(i.name)}</span><span class="why">${esc(i.look)}</span>`).join('')}
      ${o.items.length > 3 ? `<span>and ${o.items.length - 3} more</span>` : ''}</div>`).join('')}
  </section>`;
}

function render() {
  $('chips').innerHTML = ['All', ...state.kids.map((k) => k.short)]
    .map((n) => `<button class="chip" type="button" aria-pressed="${n === state.filter}" data-chip="${esc(n)}">${esc(n)}</button>`).join('');
  let html = lookCard();
  for (const kid of state.kids.filter((k) => state.filter === 'All' || k.short === state.filter)) {
    const items = kid.items.filter((it) => matches(kid, it));
    if (state.query && !items.length) continue;
    const here = kid.items.filter((i) => i.status === 'here').length;
    const total = kid.items.length;
    const waiting = items.filter((i) => i.status === 'ordered');
    const notOrdered = items.filter((i) => i.status === 'not');
    const hereItems = items.filter((i) => i.status === 'here');
    html += `<section class="card" aria-label="${esc(kid.short)}" data-card="${esc(kid.jobId)}">
      <div class="card-head">
        <div class="card-title"><h2>${esc(kid.short)}</h2><span class="count"><b>${here}</b> of ${total} here</span></div>
        <div class="bar" aria-hidden="true"><i data-bar="${esc(kid.jobId)}" style="width:${total ? (100 * here) / total : 0}%"></i></div>
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
function close() {
  const scrim = document.querySelector('#sheet-root .scrim');
  if (!scrim || scrim.classList.contains('closing')) return;
  scrim.classList.add('closing');
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => { $('sheet-root').innerHTML = ''; }, reduced() ? 0 : 220);
}
function openSheet(inner, { keep = false } = {}) {
  clearTimeout(closeTimer);
  const root = $('sheet-root');
  const existing = root.querySelector('.sheet');
  // A sheet that turns into the next one changes in place; a new one rises
  if (keep && existing && !root.querySelector('.scrim.closing')) existing.innerHTML = `<div class="grabber"></div>${inner}`;
  else root.innerHTML = `<div class="scrim" data-close="1"><div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${inner}</div></div>`;
  (root.querySelector('.sheet [data-focus]') || root.querySelector('.sheet input') || root.querySelector('.sheet button'))?.focus({ preventScroll: true });
}
const head = (title, sub = '', one = false) => `<div class="sheet-head"><div style="min-width:0"><h3>${title}</h3>${sub ? `<div class="sheet-sub${one ? ' one' : ''}">${sub}</div>` : ''}</div>
  <div style="display:flex;gap:8px;align-items:center">${state.practice ? '<span class="chip-mode">Practice</span>' : ''}<button class="x" type="button" data-close="1" aria-label="Close">${ICON.x}</button></div></div>`;
const stepper = (boxes) => `<div class="stepper"><span>Boxes</span><div><button type="button" data-step="-1" aria-label="One box fewer">−</button><output aria-live="polite">${boxes}</output><button type="button" data-step="1" aria-label="One box more">+</button></div></div>`;

function itemSheet(kid, it, { found = '', keep = false } = {}) {
  let boxes = 1;
  const facts = [
    ['For', kid.short], ['Line', it.line], it.order?.store ? ['From', it.order.store] : null,
    it.order ? ['Ordered', `${ago(it.order.at)}${it.order.buyer ? ` by ${it.order.buyer}` : ''}`] : null,
    it.order?.orderNumber ? ['Order', it.order.orderNumber] : null,
    it.orderedAs && it.orderedAs !== it.name ? ['Store calls it', it.orderedAs] : null,
    it.source === 'donated' ? ['Donated', 'Yes'] : null, it.qty > 1 ? ['How many', String(it.qty)] : null,
  ].filter(Boolean);
  const draw = (k) => {
    openSheet(`${head(esc(it.name), found ? esc(found) : it.status === 'not' ? 'Not ordered yet. It can still come in, like from a store run.' : '')}
      <dl class="facts">${facts.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>
      ${stepper(boxes)}
      <button class="btn btn-primary btn-big" type="button" id="print" data-focus>Print ${boxes === 1 ? 'label' : `${boxes} labels`}</button>`, { keep: k });
    $('sheet-root').querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => { boxes = Math.min(9, Math.max(1, boxes + Number(b.dataset.step))); draw(true); }; });
    $('print').onclick = () => printed(kid, it, boxes);
  };
  draw(keep);
}

function printed(kid, it, boxes) {
  const labels = Array.from({ length: boxes }, (_, i) => `<div class="label" style="animation-delay:${i * 140}ms">
      <div class="label-kid">${esc(kid.short.toUpperCase())}</div>
      <div class="label-item">${esc(it.name)}</div>
      <div class="label-mid"><span class="label-box">Box ${i + 1} of ${boxes}</span><span class="label-shelf">${esc(kid.shelf)}</span></div>
      <div class="label-foot"><span>SOARD<br>In ${esc(today())}</span><canvas data-qr="${esc(it.id)}-${i}" aria-label="QR code"></canvas></div>
    </div>`).join('');
  const after = 640 + (boxes - 1) * 140;
  openSheet(`${head(boxes === 1 ? 'Label' : `${boxes} labels`, esc(it.name), true)}
    <div class="printer" aria-hidden="true"><div class="slot"></div><div class="feed">${labels}</div></div>
    <div class="done-line" style="--after:${after}ms">${ICON.tick}<span>${state.practice ? 'Marked here' : `Received in JobTread, ${esc(today())}`}</span></div>
    <div class="shelf-callout"><span>${esc(kid.short)}’s shelf</span><b>${esc(kid.shelf)}</b></div>
    <button class="btn btn-primary btn-big" type="button" id="done" data-focus>Done</button>`, { keep: true });
  document.querySelectorAll('canvas[data-qr]').forEach((c) => drawQr(c, c.dataset.qr));
  document.querySelectorAll('.done-line .tick path').forEach((p) => p.style.setProperty('--after', `${after}ms`));
  $('done').onclick = () => {
    close();
    // The row leaves the list, then the kid's bar grows
    const row = document.querySelector(`.row[data-id="${CSS.escape(it.id)}"]`);
    it.status = 'here';
    if (row && !reduced()) { row.style.maxHeight = `${row.offsetHeight}px`; requestAnimationFrame(() => row.classList.add('leaving')); setTimeout(growBar(kid), 320); } else growBar(kid)();
  };
}
const growBar = (kid) => () => {
  const bar = document.querySelector(`[data-bar="${CSS.escape(kid.jobId)}"]`);
  const before = bar?.style.width;
  render();
  const now = document.querySelector(`[data-bar="${CSS.escape(kid.jobId)}"]`);
  if (now && before) { const after = now.style.width; now.style.width = before; requestAnimationFrame(() => requestAnimationFrame(() => { now.style.width = after; })); }
};

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
  let boxes = 1, what = '';
  const draw = (keep) => {
    openSheet(`${head('Something else', 'A donation, a store run, anything not on the lists.')}
      <div class="field"><label>For</label><div class="kidpick">${state.kids.map((k) => `<button class="chip" type="button" data-pick="${esc(k.jobId)}" aria-pressed="${k.jobId === kidId}">${esc(k.short)}</button>`).join('')}</div></div>
      <div class="field"><label for="what">What is it?</label><input id="what" type="text" placeholder="Bean bag chair" value="${esc(what)}" autocomplete="off" /></div>
      ${stepper(boxes)}
      <button class="btn btn-primary btn-big" type="button" id="print">Print ${boxes === 1 ? 'label' : `${boxes} labels`}</button>`, { keep });
    const input = $('what');
    input.oninput = () => { what = input.value; };
    $('sheet-root').querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => { kidId = b.dataset.pick; draw(true); }; });
    $('sheet-root').querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => { boxes = Math.min(9, Math.max(1, boxes + Number(b.dataset.step))); draw(true); }; });
    $('print').onclick = () => {
      if (!what.trim()) { input.focus(); input.placeholder = 'Type what it is first'; return; }
      const kid = state.kids.find((k) => k.jobId === kidId);
      const it = { id: `other:${Date.now()}`, name: what.trim(), line: 'Also bought', qty: 1, source: 'buy', status: 'ordered', order: null };
      kid.items.push(it);
      printed(kid, it, boxes);
    };
  };
  draw(false);
}

// ─── Scan a box ─────────────────────────────────────────────────────

/** The photo, made small enough to send quickly (labels read fine at 1600px) → a JPEG data URL */
async function shrink(file) {
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

async function scanned(file) {
  const preview = URL.createObjectURL(file);
  openSheet(`${head('Reading the label')}
    <img class="photo" src="${preview}" alt="The photo of the box's label" />
    <div class="reading"><span class="spin" aria-hidden="true"></span><span>Finding whose box this is</span></div>`);
  try {
    const res = await fetch('/api/kid-items-admin?scan=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: await shrink(file) }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.error || 'The label couldn’t be read. Take the photo again.');
    showFound(body, preview);
  } catch (err) {
    openSheet(`${head('Couldn’t read that label', esc(err.message))}
      <img class="photo" src="${preview}" alt="The photo of the box's label" />
      <div class="two"><button class="btn" type="button" data-close="1">Pick from the list</button><button class="btn btn-primary" type="button" data-rescan="1" data-focus>Take it again</button></div>`, { keep: true });
  }
}

function showFound({ found, label }, preview) {
  const kid = found && state.kids.find((k) => k.jobId === found.kid);
  const items = kid ? found.items.map((id) => kid.items.find((i) => i.id === id)).filter((i) => i && i.status !== 'here') : [];
  if (kid && items.length === 1) { itemSheet(kid, items[0], { found: `Found by ${found.how}`, keep: true }); return; }
  if (kid && items.length) {
    openSheet(`${head(`<span class="found-for">${esc(kid.short)}</span>`, `Found by ${esc(found.how)}. Which is in the box?`)}
      <div class="pick">${items.map((i) => rowHtml(kid, i)).join('')}</div>`, { keep: true });
    return;
  }
  const bits = [label?.store, label?.po ? `PO ${label.po}` : null, ...(label?.trackingNumbers || []).map((t) => `…${t.slice(-6)}`), ...(label?.orderNumbers || [])].filter(Boolean);
  openSheet(`${head(kid ? `Everything for ${esc(kid.short)} from that order is here` : 'Couldn’t match this box', kid ? '' : 'Pick it from the list, or use Something else.')}
    <img class="photo" src="${preview}" alt="The photo of the box's label" />
    ${bits.length ? `<div class="read-bits">${bits.map((b) => `<span>${esc(b)}</span>`).join('')}</div>` : ''}
    <div class="two"><button class="btn" type="button" data-close="1" data-focus>Pick from the list</button><button class="btn" type="button" data-other="1">Something else</button></div>`, { keep: true });
}

// ─── Wiring ─────────────────────────────────────────────────────────

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, .scrim');
  if (!t) return;
  if (t.dataset.close && (t === e.target || t.tagName === 'BUTTON')) { close(); return; }
  if (t.dataset.rescan) { $('camera').click(); return; }
  if (t.dataset.other) { otherSheet(); return; }
  if (t.dataset.chip) { state.filter = t.dataset.chip; render(); window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); return; }
  if (t.dataset.here) { state.openHere.add(t.dataset.here); render(); return; }
  if (t.classList.contains('row') && t.dataset.id) {
    const kid = state.kids.find((k) => k.jobId === t.dataset.kid);
    const it = kid?.items.find((i) => i.id === t.dataset.id);
    const inSheet = Boolean(t.closest('.sheet'));
    if (it && it.status !== 'here') itemSheet(kid, it, { keep: inSheet, found: inSheet ? 'In this box' : '' });
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
$('q').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
$('other').addEventListener('click', otherSheet);
$('scan').addEventListener('click', () => $('camera').click());
$('camera').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) scanned(f); });

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
