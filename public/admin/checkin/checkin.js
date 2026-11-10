/**
 * SOARD Check-in (/admin/checkin/): Clareece opens a box, taps the item, prints its labels
 * ===========================================================================
 * Each open makeover's things to receive, from /api/kid-items-admin?checkin=1:
 * what was ordered and hasn't come (oldest first), what isn't ordered yet,
 * and the orders a person needs to look at. For now it's practice: tapping
 * Print shows the labels and marks the item here on this phone only. Nothing
 * prints and nothing changes in JobTread until the printer and the JobTread
 * writes are tested.
 */

const DAY = 86400e3;
const state = { kids: [], needsLook: [], practice: true, filter: 'All', query: '', openHere: new Set() };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const daysAgo = (at) => Math.max(0, Math.floor((Date.now() - Date.parse(at)) / DAY));
const ago = (at) => { const d = daysAgo(at); return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const today = () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const chev = '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const check = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg>';
const xIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

const matches = (kid, it) => {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [kid.short, it.name, it.line, it.order?.store].some((s) => String(s || '').toLowerCase().includes(q));
};

function rowHtml(kid, it) {
  const sub = [it.line, it.order?.store, it.qty > 1 ? `${it.qty} of them` : null].filter(Boolean).join(' · ');
  let side = '';
  if (it.status === 'ordered') side = `<span class="tag ${daysAgo(it.order.at) > 10 ? 'tag-late' : 'tag-wait'}">Ordered ${esc(ago(it.order.at))}</span>`;
  if (it.status === 'not' && it.source === 'donated') side = '<span class="tag tag-wait">Donated</span>';
  if (it.status === 'here') side = `<span class="tag tag-here">${esc(kid.shelf)}</span>`;
  return `<button class="row${it.status === 'not' ? ' muted' : ''}" data-kid="${esc(kid.jobId)}" data-id="${esc(it.id)}" type="button">
    <span class="row-name">${esc(it.name)}</span><span class="row-side">${side}${it.status === 'here' ? '' : chev}</span>
    <span class="row-sub">${esc(sub)}</span></button>`;
}

function lookHtml() {
  if (!state.needsLook.length || state.query) return '';
  return `<section class="look" aria-label="Needs a look">
    <div class="kid-head"><div class="kid-name"><h2>Needs a look</h2><span class="kid-count"><b>${state.needsLook.length}</b> ${state.needsLook.length === 1 ? 'order' : 'orders'}</span></div></div>
    ${state.needsLook.map((o) => `<div class="look-row"><b>${esc(o.store)}${o.kid ? ` · ${esc(o.kid)}` : ''}</b>
      <span>${esc([o.po ? `PO “${o.po}”` : null, `ordered ${ago(o.at)}`, o.buyer].filter(Boolean).join(' · '))}</span>
      ${o.items.slice(0, 4).map((i) => `<span class="look-item">${esc(i.name)}: ${esc(i.look)}</span>`).join('')}
      ${o.items.length > 4 ? `<span>and ${o.items.length - 4} more</span>` : ''}</div>`).join('')}
  </section>`;
}

function render() {
  document.getElementById('chips').innerHTML = ['All', ...state.kids.map((k) => k.short)]
    .map((n) => `<button class="chip" type="button" aria-pressed="${n === state.filter}" data-chip="${esc(n)}">${esc(n)}</button>`).join('');
  let html = state.filter === 'All' ? lookHtml() : '';
  for (const kid of state.kids.filter((k) => state.filter === 'All' || k.short === state.filter)) {
    const items = kid.items.filter((it) => matches(kid, it));
    if (state.query && !items.length) continue;
    const here = kid.items.filter((i) => i.status === 'here').length;
    const total = kid.items.length;
    const waiting = items.filter((i) => i.status === 'ordered');
    const notOrdered = items.filter((i) => i.status === 'not');
    const hereItems = items.filter((i) => i.status === 'here');
    html += `<section class="kid" aria-label="${esc(kid.short)}">
      <div class="kid-head">
        <div class="kid-name"><h2>${esc(kid.short)}</h2><span class="kid-count"><b>${here}</b> of ${total} here</span></div>
        <div class="bar" aria-hidden="true"><i style="width:${total ? Math.round((100 * here) / total) : 0}%"></i></div>
      </div>`;
    if (waiting.length) html += `<div class="group-h"><span>Hasn’t come yet</span><span>${waiting.length}</span></div>${waiting.map((i) => rowHtml(kid, i)).join('')}`;
    if (notOrdered.length) html += `<div class="group-h"><span>Not ordered yet</span><span>${notOrdered.length}</span></div>${notOrdered.map((i) => rowHtml(kid, i)).join('')}`;
    if (hereItems.length) {
      html += state.openHere.has(kid.jobId) || state.query
        ? `<div class="group-h"><span>Here</span><span>${hereItems.length}</span></div>${hereItems.map((i) => rowHtml(kid, i)).join('')}`
        : `<button class="more" type="button" data-here="${esc(kid.jobId)}">Show the ${hereItems.length} here</button>`;
    }
    if (kid.others && !state.query) html += `<div class="others">${kid.others} more come from the installer, a trade partner or the family, so they aren’t checked in here.</div>`;
    html += '</section>';
  }
  document.getElementById('list').innerHTML = html || `<p class="empty">${state.query ? 'Nothing matches that.' : 'Nothing to check in.'}</p>`;
}

// A QR drawn for the label's look (the real label's QR comes with the printer)
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

const close = () => { document.getElementById('sheet-root').innerHTML = ''; };
function openSheet(inner) {
  const root = document.getElementById('sheet-root');
  root.innerHTML = `<div class="scrim" data-close="1"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`;
  root.querySelector('.sheet button, .sheet input')?.focus();
}
const practiceLine = () => (state.practice ? '<p class="hint">Practice: nothing prints and JobTread doesn’t change yet.</p>' : '');

function itemSheet(kid, it) {
  let boxes = 1;
  const facts = [
    ['For', kid.short], ['Item', it.line], it.order?.store ? ['From', it.order.store] : null,
    it.order ? ['Ordered', `${ago(it.order.at)}${it.order.buyer ? ` by ${it.order.buyer}` : ''}`] : null,
    it.order?.orderNumber ? ['Order', it.order.orderNumber] : null,
    it.orderedAs && it.orderedAs !== it.name ? ['Store called it', it.orderedAs] : null,
    it.source === 'donated' ? ['Donated', 'Yes'] : null, it.qty > 1 ? ['How many', String(it.qty)] : null,
  ].filter(Boolean);
  const draw = () => {
    openSheet(`
      <div class="sheet-head"><div><h3>${esc(it.name)}</h3>${it.status === 'not' ? '<div class="sheet-sub">Not ordered yet. It can still be checked in, say if it was bought at a store.</div>' : ''}</div>
        <button class="x" type="button" data-close="1" aria-label="Close">${xIcon}</button></div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <div class="stepper"><span>Boxes</span><div><button type="button" id="minus" aria-label="One box fewer">−</button><output>${boxes}</output><button type="button" id="plus" aria-label="One box more">+</button></div></div>
      <button class="btn btn-primary big" type="button" id="print">Print ${boxes === 1 ? 'label' : `${boxes} labels`}</button>
      <p class="hint">Printing marks it received in JobTread.</p>${practiceLine()}`);
    document.getElementById('minus').onclick = () => { boxes = Math.max(1, boxes - 1); draw(); };
    document.getElementById('plus').onclick = () => { boxes = Math.min(9, boxes + 1); draw(); };
    document.getElementById('print').onclick = () => printed(kid, it, boxes);
  };
  draw();
}

function printed(kid, it, boxes) {
  it.status = 'here';
  render();
  const labels = Array.from({ length: boxes }, (_, i) => `<div class="label">
      <div class="label-kid">${esc(kid.short.toUpperCase())}</div>
      <div class="label-item">${esc(it.name)}</div>
      <div class="label-mid"><span class="label-box">Box ${i + 1} of ${boxes}</span><span class="label-shelf">${esc(kid.shelf)}</span></div>
      <div class="label-foot"><span>SOARD<br>In ${esc(today())}</span><canvas data-qr="${esc(it.id)}-${i}" aria-label="QR code"></canvas></div>
    </div>`).join('');
  openSheet(`
    <div class="sheet-head"><div><h3>${state.practice ? 'Labels (practice)' : boxes === 1 ? 'Label printed' : `${boxes} labels printed`}</h3><div class="sheet-sub">${esc(it.name)}</div></div>
      <button class="x" type="button" data-close="1" aria-label="Close">${xIcon}</button></div>
    <div class="labels">${labels}</div>
    <div class="confirm"><div>${check} ${state.practice ? 'Marked here on this phone' : `Received in JobTread, ${esc(today())}`}</div></div>
    <div class="shelf-callout"><span>Put ${boxes === 1 ? 'it' : 'them'} on ${esc(kid.short)}’s shelf</span><b>${esc(kid.shelf)}</b></div>
    <button class="btn btn-primary big" type="button" data-close="1">Done</button>${practiceLine()}`);
  document.querySelectorAll('canvas[data-qr]').forEach((c) => drawQr(c, c.dataset.qr));
}

function otherSheet() {
  if (!state.kids.length) return;
  let kidId = state.kids[0].jobId, boxes = 1, what = '';
  const draw = () => {
    openSheet(`
      <div class="sheet-head"><div><h3>Something else</h3><div class="sheet-sub">A donation, a store run, anything not on the lists.</div></div>
        <button class="x" type="button" data-close="1" aria-label="Close">${xIcon}</button></div>
      <div class="field"><label>For</label><div class="kidpick">${state.kids.map((k) => `<button class="chip" type="button" data-pick="${esc(k.jobId)}" aria-pressed="${k.jobId === kidId}">${esc(k.short)}</button>`).join('')}</div></div>
      <div class="field"><label for="what">What is it?</label><input id="what" type="text" placeholder="Bean bag chair" value="${esc(what)}" /></div>
      <div class="stepper"><span>Boxes</span><div><button type="button" id="minus" aria-label="One box fewer">−</button><output>${boxes}</output><button type="button" id="plus" aria-label="One box more">+</button></div></div>
      <button class="btn btn-primary big" type="button" id="print">Print ${boxes === 1 ? 'label' : `${boxes} labels`}</button>
      <p class="hint">It’s added to the kid’s JobTread job as received.</p>${practiceLine()}`);
    const input = document.getElementById('what');
    input.oninput = () => { what = input.value; };
    document.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => { kidId = b.dataset.pick; draw(); }; });
    document.getElementById('minus').onclick = () => { boxes = Math.max(1, boxes - 1); draw(); };
    document.getElementById('plus').onclick = () => { boxes = Math.min(9, boxes + 1); draw(); };
    document.getElementById('print').onclick = () => {
      if (!what.trim()) { input.focus(); input.placeholder = 'Type what it is first'; return; }
      const kid = state.kids.find((k) => k.jobId === kidId);
      const it = { id: `other:${Date.now()}`, name: what.trim(), line: 'Also bought', qty: 1, source: 'buy', status: 'here' };
      kid.items.push(it);
      printed(kid, it, boxes);
    };
  };
  draw();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, .scrim');
  if (!t) return;
  if (t.dataset.close && (t === e.target || t.tagName === 'BUTTON')) { close(); return; }
  if (t.dataset.chip) { state.filter = t.dataset.chip; render(); return; }
  if (t.dataset.here) { state.openHere.add(t.dataset.here); render(); return; }
  if (t.classList.contains('row') && t.dataset.id) {
    const kid = state.kids.find((k) => k.jobId === t.dataset.kid);
    const it = kid?.items.find((i) => i.id === t.dataset.id);
    if (it && it.status !== 'here') itemSheet(kid, it);
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
document.getElementById('q').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
document.getElementById('other').addEventListener('click', otherSheet);

async function load() {
  try {
    const res = await fetch('/api/kid-items-admin?checkin=1', { headers: { Accept: 'application/json' } });
    const body = await res.json();
    if (!res.ok || !body.success) throw new Error(body.error || `The site answered ${res.status}`);
    Object.assign(state, { kids: body.kids || [], needsLook: body.needsLook || [], practice: body.practice !== false });
    document.getElementById('mode').hidden = !state.practice;
    const note = document.getElementById('note');
    note.hidden = !state.practice;
    note.textContent = 'Practice for now: the kids, their items and the orders are real. Printing and Received don’t do anything yet; that comes with the label printer.';
    render();
  } catch (err) {
    document.getElementById('list').innerHTML = `<p class="empty">The list didn’t load: ${esc(err.message)}. Pull down to try again, or sign in again if it’s been a while.</p>`;
  }
}
load();
