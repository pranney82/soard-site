/**
 * Admin → Job Costs → W-9s & insurance: every company SOARD pays, and the
 * W-9 and certificates of insurance the site keeps for each
 * ===========================================================================
 * Over /api/vendor-papers-admin (functions/api/_vendor-files.js, _vendors.js).
 * The site is the record (Peter, Nov 2 2026: whatever project or payment
 * system SOARD is on, the papers stay); JobTread's vendor fields only show it.
 *
 * Nothing here has to be pressed: files come in from each company's own
 * page, their insurance agent, the certificate search through staff email,
 * JobTread and Ramp, and the companies paid outside JobTread are found in
 * Mercury and Ramp. People look, open a file, add one that came another way,
 * mark a company "W-9 only" or "Not needed", and say what a file nobody could
 * read shows. The list leads with who SOARD paid in the last year and what's
 * missing for them.
 *
 * #job-costs/papers lists them; #job-costs/papers/<id> is one company.
 */

import { h, htm, useState, useEffect, useRef } from './vendor.js';
import { ask } from './ask.js';
import { openViewer, sizeText } from './file-viewer.js';

const html = htm.bind(h);
const API = '/api/vendor-papers-admin';

async function call(query = '', body = null) {
  let r;
  try {
    r = await fetch(API + query, body instanceof FormData ? { method: 'POST', body }
      : body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { success: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  return j;
}

const day = (d) => (d ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const TONE = { Current: 'success', 'Expiring soon': 'warn', Requested: 'info', Expired: 'warn', Missing: 'warn', 'Needs a look': 'warn', 'W-9 only': 'success', 'Not needed': '' };
const FROM = { page: 'from their page', agent: 'from their insurance agent', signed: 'signed on their page', email: 'from staff email', jobtread: 'from JobTread', ramp: 'from Ramp', search: 'from the certificate search' };
const FILTERS = [['paid', 'Who SOARD pays'], ['todo', 'Needs something'], ['all', 'All'], ['site', 'Paid outside JobTread']];
const usd = (n) => (n ? `$${Number(n).toLocaleString('en-US')}` : '');
const usdCents = (c) => (c ? (Math.round(c / 100)).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '');
const person = (email) => (email && email.includes('@') ? email.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : email || 'staff');
const whence = (f) => (f.source === 'staff' ? `added by ${person(f.addedBy)}` : FROM[f.source] || f.source);
// Still missing something a person or the company has to send (expiring soon isn't missing yet)
const missing = (r) => !r.ok || r.look;
const needs = (r) => !r.ok || r.expiring || r.look;
const isPhoto = (f) => /^image\//.test(f.type || '');
/** What's missing, the way a person says it: "a W-9, general liability insurance (it ended Mar 3, 2026)" (the server's words are "no W-9, …") */
const stillNeeded = (staff) => String(staff || '').split(/, (?!\d)/).filter(Boolean)
  .map((w) => w.replace(/^no W-9$/, 'a W-9').replace(/^no (.+)$/, '$1').replace(/^(.+) (ended|ends) (.+)$/, '$1 (it $2 $3)')).join(', ');
/** What a file's move or taking off changed on a company's record, in words (empty: nothing) */
const changedWords = (patch = {}) => [
  patch.w9 === true && 'W-9 on file', patch.w9 === false && 'no W-9',
  patch.gl !== undefined && (patch.gl ? `liability to ${day(patch.gl)}` : 'no liability date'),
  patch.wc !== undefined && (patch.wc ? `workers’ comp to ${day(patch.wc)}` : 'no workers’ comp date'),
].filter(Boolean).join(', ');

/**
 * A choice of two or three, as radio buttons: Tab reaches the chosen one and the arrows move between them. pickOnArrow:
 * the arrows choose too (a choice that only changes the form); where choosing saves, Space or Enter chooses, so
 * stepping past one never saves it. While busy it reads as unavailable but keeps the focus where it is.
 */
function Choice({ label, n, value, options, disabled, onPick, pickOnArrow = false }) {
  const keys = (e, i) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const j = (i + step + options.length) % options.length;
    if (pickOnArrow && !disabled) onPick(options[j][0]);
    e.currentTarget.parentElement?.children[j]?.focus();
  };
  const at = Math.max(0, options.findIndex(([k]) => k === value));
  return html`<div class="seg vp-choice" style=${`--n: ${n}`} role="radiogroup" aria-label=${label}>
    ${options.map(([k, text], i) => html`<button type="button" role="radio" aria-checked=${value === k} tabindex=${i === at ? 0 : -1} aria-disabled=${disabled ? 'true' : null}
      onClick=${() => { if (!disabled) onPick(k); }} onKeyDown=${(e) => keys(e, i)}>${text}</button>`)}
  </div>`;
}
/** A name as the list compares it: "&" and "and" alike, case and punctuation aside */
const plainName = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Where the list was, so coming back from a company finds it the same way
const kept = { filter: 'paid', q: '' };

const CSS = `
.vp { display: grid; gap: 1rem; min-width: 0; }
.vp > *, .vp-card > *, .vp-top > * { min-width: 0; }
.vp-top { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: .75rem 1.5rem; }
.vp-top h3 { margin: 0 0 .25rem; font-size: var(--fs-lg); display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; overflow-wrap: anywhere; }
.vp-lead { margin: 0; max-width: 64ch; font-size: var(--fs-sm); color: var(--color-text-secondary); line-height: 1.5; }
.vp-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; }
.vp-bar .form-input { width: min(100%, 18rem); }
.vp-bar .seg { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.vp-bar .seg > button { flex: none; }
.vp-off { display: grid; gap: .25rem; }
.vp-contents { display: contents; }
@media (pointer: coarse) { .vp-drop-word { display: none; } }
.vp-list { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); overflow: hidden; }
.vp-row { display: grid; grid-template-columns: minmax(0, 1fr) 8.5rem 6.5rem 5rem 7rem 7rem 3.5rem; gap: .5rem .9rem; align-items: center; width: 100%; padding: .7rem 1.1rem; border: 0; border-bottom: 1px solid var(--color-border); background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.vp-row:last-child { border-bottom: none; }
.vp-row:hover { background: var(--tone-neutral-surface, var(--color-bg-subtle)); }
.vp-row:focus-visible { outline: none; box-shadow: inset var(--focus-ring-strong); }
.vp-row.is-head { cursor: default; font-size: var(--fs-2xs); font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: .04em; background: none; }
.vp-name { min-width: 0; }
.vp-name strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.vp-name span { font-size: var(--fs-xs); color: var(--color-text-muted); }
.vp-num { font-variant-numeric: tabular-nums; font-size: var(--fs-sm); }
.vp-muted { color: var(--color-text-muted); }
.vp-facts { font-size: var(--fs-xs); color: var(--color-text-muted); display: flex; flex-wrap: wrap; gap: .25rem 1rem; }
.vp-card { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); padding: 1rem 1.15rem; display: grid; gap: .85rem; }
.vp-card h4 { margin: 0; font-size: var(--fs-md); }
.vp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); gap: .75rem 1.25rem; }
.vp-field { display: grid; gap: .3rem; font-size: var(--fs-sm); }
.vp-field > span { font-size: var(--fs-xs); font-weight: 600; color: var(--color-text-secondary); }
.vp-file { display: grid; grid-template-columns: 2.2rem minmax(0, 1fr) auto; gap: .35rem .8rem; align-items: center; padding: .6rem 0; border-top: 1px solid var(--color-border); }
.vp-file:first-child { border-top: none; }
.vp-file__icon { font-size: 1.4rem; text-align: center; }
.vp-file__what { min-width: 0; }
.vp-file__what button.link { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; max-width: 100%; text-align: left; }
.vp-file__meta { font-size: var(--fs-xs); color: var(--color-text-secondary); overflow-wrap: anywhere; }
.vp-file__acts { display: flex; gap: .35rem; flex-wrap: wrap; justify-content: flex-end; }
.vp-move { grid-column: 2 / -1; display: grid; gap: .4rem; }
.vp-drop { border: 2px dashed var(--color-border-strong); border-radius: var(--radius-md); padding: 1rem; display: grid; gap: .6rem; justify-items: start; }
.vp-drop.is-over { border-color: var(--color-text); background: var(--tone-neutral-surface, transparent); }
.vp-drop.is-busy { opacity: .7; }
.vp-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.vp-result { font-size: var(--fs-sm); line-height: 1.5; }
.vp-result ul { margin: .25rem 0 0; padding-left: 1.1rem; }
/* A choice of two or three: equal columns that wrap their words, never scrolled sideways on a phone */
.vp-choice { display: grid; grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr)); width: 100%; max-width: 34rem; }
.vp-choice.seg > :is(button, [role="radio"]) { white-space: normal; line-height: 1.25; text-align: center; min-width: 0; }
@media (max-width: 760px) {
  .vp-row { grid-template-columns: minmax(0, 1fr) auto; padding: .7rem .85rem; }
  .vp-row > .vp-hide-sm { display: none; }
  .vp-file { grid-template-columns: 2rem minmax(0, 1fr); }
  .vp-file__acts { grid-column: 1 / -1; justify-content: flex-start; }
  .vp-move { grid-column: 1 / -1; }
  .vp-file__acts .btn, .vp-actions .btn { min-height: 44px; }
  .vp-bar .seg { flex-wrap: wrap; overflow: visible; }
  .vp-bar .seg > button { flex: 1 1 auto; }
}
`;
let styled = false;
function useStyles() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.module = 'vendor-papers';
  el.textContent = CSS;
  document.head.append(el);
}

const Tag = ({ label }) => html`<span class="tag ${TONE[label] ? `tag--${TONE[label]}` : ''}">${label}</span>`;
/** The status, and what a person decided they need when it isn't the usual W-9 and insurance */
const Status = ({ r }) => html`<${Tag} label=${r.label} />${r.need && r.need !== r.label ? html` <span class="tag">${r.need === 'Not needed' ? 'Needs nothing' : r.need}</span>` : null}`;

export function VendorPapers({ id = null, onOpen = () => {}, addToast = () => {} }) {
  useStyles();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = async () => {
    const j = await call();
    if (!j.success) { setErr(j.error || 'Couldn’t load W-9s and insurance'); return; }
    setErr(null);
    setData(j);
  };
  useEffect(() => { load(); }, [id]);
  if (id) return html`<${Company} key=${id} id=${id} list=${data?.list || []} onBack=${() => onOpen(null)} onOpen=${onOpen} addToast=${addToast} onChanged=${load} />`;
  if (err && !data) return html`<div class="notice notice--danger"><div class="notice__body">${err}</div><div class="notice__actions"><button class="btn btn-ghost" onClick=${load}>Try again</button></div></div>`;
  if (!data) return html`<div class="area-loading"><span class="spinner" /></div>`;
  return html`<${List} data=${data} onOpen=${onOpen} addToast=${addToast} />`;
}

// ─── Every company ──────────────────────────────────────────────────

function List({ data, onOpen, addToast }) {
  const [filter, setFilterState] = useState(kept.filter);
  const [q, setQState] = useState(kept.q);
  const [adding, setAdding] = useState(false);
  const addBtn = useRef(null);
  const setFilter = (f) => { kept.filter = f; setFilterState(f); };
  const setQ = (s) => { kept.q = s; setQState(s); };
  const words = plainName(q);
  // Who SOARD pays: paid in the last year, on an open job, or a company paid outside JobTread (they're payees by being here)
  const keep = { all: () => true, site: (r) => r.site, todo: needs, paid: (r) => r.paid > 0 || r.jobs > 0 || r.site };
  // Typing a name looks through every company, whatever the tab, those taken off the list too (only a search finds them)
  const shown = data.list.filter((r) => (words ? plainName(r.name).includes(words) : !r.archived && keep[filter](r)))
    // Who SOARD pays: what's missing first, then who's paid most
    .sort((a, b) => (filter === 'paid' && !words ? Number(missing(b)) - Number(missing(a)) : 0) || (b.paid || 0) - (a.paid || 0) || a.name.localeCompare(b.name));
  const paidMissing = data.list.filter((r) => !r.archived && r.paid > 0 && missing(r));
  const counts = {};
  for (const r of data.list) if (!r.archived) counts[r.label] = (counts[r.label] || 0) + 1;
  const f = data.facts || {};
  const imp = f.import;
  return html`
    <div class="vp">
      <div class="vp-top">
        <div>
          <h3>W-9s and insurance</h3>
          <p class="vp-lead">Every company SOARD pays, on a job or not, and the W-9 and certificates of insurance kept for each. They’re kept here on the site; JobTread’s vendor fields show the same dates.</p>
        </div>
        <button class="btn btn-primary" ref=${addBtn} onClick=${() => setAdding(true)}>Add a company</button>
      </div>
      ${adding ? html`<${AddCompany} onOpen=${onOpen} onDone=${(j) => {
        setAdding(false);
        // Closed without adding: the focus goes back where it came from
        if (!j) { setTimeout(() => addBtn.current?.focus(), 0); return; }
        addToast(j.made ? `${j.vendor.name} added` : j.back ? `${j.vendor.name} is back on the list` : `${j.vendor.name} is in the list already`, j.made || j.back ? 'success' : 'info');
        onOpen(j.vendor.id);
      }} />` : null}
      ${f.storage === null ? html`<div class="notice notice--danger" role="alert"><div class="notice__body"><strong>The private storage for W-9s isn’t connected.</strong> Nothing can be added until it is (the VENDOR_FILES bucket in Cloudflare).</div></div>` : null}
      ${paidMissing.length ? html`<div class="notice notice--warn"><div class="notice__body"><strong>${paidMissing.length} compan${paidMissing.length === 1 ? 'y' : 'ies'} SOARD paid in the last year ${paidMissing.length === 1 ? 'is' : 'are'} missing a W-9 or current insurance</strong> (paid ${usdCents(paidMissing.reduce((n, r) => n + (r.paid || 0), 0)) || '$0'} in all). They’re first under “Who SOARD pays”.</div></div>` : null}
      <div class="pill-row">${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([label, n]) => html`<span class="pill"><${Tag} label=${label} /> ${n}</span>`)}</div>
      <div class="vp-bar">
        <div class="seg vp-filters" role="radiogroup" aria-label="Which companies">
          ${FILTERS.map(([k, label], i) => html`<button type="button" role="radio" aria-checked=${filter === k && !words} tabindex=${filter === k ? 0 : -1} onClick=${() => { setFilter(k); setQ(''); }}
            onKeyDown=${(e) => {
              const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
              if (!step) return;
              e.preventDefault();
              const j = (i + step + FILTERS.length) % FILTERS.length;
              setFilter(FILTERS[j][0]); setQ('');
              e.currentTarget.parentElement?.children[j]?.focus();
            }}>${label}</button>`)}
        </div>
        <input class="form-input" type="search" placeholder="Find any company" aria-label="Find any company" value=${q} onInput=${(e) => setQ(e.target.value)} />
      </div>
      <div class="vp-list">
        <div class="vp-row is-head" aria-hidden="true"><span>Company</span><span>Status</span><span class="vp-hide-sm">Paid, last year</span><span class="vp-hide-sm">W-9</span><span class="vp-hide-sm">Liability to</span><span class="vp-hide-sm">Workers’ comp to</span><span class="vp-hide-sm">Files</span></div>
        ${shown.length ? shown.slice(0, 400).map((r) => html`
          <button class="vp-row" onClick=${() => onOpen(r.id)}>
            <span class="vp-name"><strong title=${r.name}>${r.name}</strong><span>${r.archived ? 'Off the list · ' : ''}${r.site ? 'Paid outside JobTread' : r.jobs ? `${r.jobs} open job${r.jobs === 1 ? '' : 's'}` : 'JobTread vendor'}${r.look ? ' · a file to look at' : ''}${r.asked ? ` · asked ${day(r.asked)}` : ''}</span></span>
            <span><span class="sr-only">Status: </span><${Status} r=${r} /></span>
            <span class="vp-hide-sm vp-num"><span class="sr-only">Paid in the last year: </span>${r.paid ? usdCents(r.paid) : html`<span class="vp-muted">–</span>`}</span>
            <span class="vp-hide-sm vp-num"><span class="sr-only">W-9: </span>${r.w9 ? 'On file' : html`<span class="vp-muted">None</span>`}</span>
            <span class="vp-hide-sm vp-num"><span class="sr-only">Liability to: </span>${r.gl ? day(r.gl) : html`<span class="vp-muted">–</span>`}</span>
            <span class="vp-hide-sm vp-num"><span class="sr-only">Workers’ comp to: </span>${r.wc ? day(r.wc) : html`<span class="vp-muted">–</span>`}</span>
            <span class="vp-hide-sm vp-num"><span class="sr-only">Files: </span>${r.files || html`<span class="vp-muted">0</span>`}</span>
          </button>`) : html`<div class="empty empty--inline"><div class="empty__title">${words ? 'No company by that name' : filter === 'todo' ? 'Every company has what it needs' : filter === 'paid' ? 'No payments in the last year yet' : 'No companies here yet'}</div></div>`}
      </div>
      ${shown.length > 400 ? html`<p class="vp-facts">Showing 400 of ${shown.length}. Type part of a name to find the rest.</p>` : null}
      <div class="vp-facts">
        <span>${f.files || 0} file${f.files === 1 ? '' : 's'} kept for ${f.withFiles || 0} compan${f.withFiles === 1 ? 'y' : 'ies'}, in private storage only staff can open</span>
        ${imp ? html`<span>${imp.doneAt ? `JobTread’s W-9 and insurance files moved here: ${imp.files || 0} copied, ${imp.removed || 0} taken out of JobTread` : `Moving JobTread’s W-9 and insurance files here: ${imp.files || 0} so far`}${imp.skipped ? `; ${imp.skipped} left in JobTread (too big, not a PDF or photo, it wouldn’t download, or its name doesn’t say whether it’s a W-9 or a certificate)` : ''}</span>` : null}
        ${imp?.deleteError ? html`<span class="ink-warn">JobTread wouldn’t delete its copies just now. They’re kept here, and it’s tried again tomorrow.</span>` : null}
      </div>
    </div>`;
}

function AddCompany({ onDone, onOpen }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Opened to type in: the name takes the focus; Escape closes it
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const j = await call('', { action: 'add', name, email });
    setBusy(false);
    if (!j.success) { setErr(j); return; }
    onDone(j);
  };
  return html`
    <form class="vp-card" onSubmit=${save} onKeyDown=${(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(null); } }}>
      <h4>A company SOARD pays outside JobTread</h4>
      <p class="vp-lead">Like the CPA or a law firm: paid, never on a job. They need a W-9 and nothing else. A company on jobs is added in JobTread and shows here on its own.</p>
      <div class="vp-grid">
        <label class="vp-field"><span>Company</span><input class="form-input" required ref=${first} value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <label class="vp-field"><span>Email (for their W-9)</span><input class="form-input" type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>
      </div>
      ${err ? html`<div class="notice notice--danger" role="alert"><div class="notice__body">${err.error}</div>${err.jtId ? html`<div class="notice__actions"><button type="button" class="btn btn-ghost" onClick=${() => onOpen(err.jtId)}>Open it</button></div>` : null}</div>` : null}
      <div class="vp-actions"><button class="btn btn-primary" disabled=${busy}>${busy ? 'Adding…' : 'Add'}</button><button type="button" class="btn btn-ghost" onClick=${() => onDone(null)}>Cancel</button></div>
    </form>`;
}

// ─── One company ────────────────────────────────────────────────────

function Company({ id, list, onBack, onOpen, addToast, onChanged }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  // The company asked for last: an answer for one opened before it is never shown
  const asked = useRef(id);
  asked.current = id;
  const load = async () => {
    const j = await call(`?id=${encodeURIComponent(id)}`);
    if (asked.current !== id) return;
    if (!j.success) { setErr(j.movedTo ? j : j.error || 'Couldn’t load that company'); return; }
    setErr(null);
    setV(j.vendor);
  };
  useEffect(() => { setV(null); setErr(null); load(); }, [id]);
  // After a file is moved, taken off or put back its row is gone: the focus goes to the Files heading, not the page
  const filesHead = useRef(null);
  const head = useRef(null);
  const act = async (body, done) => {
    setBusy(body.action);
    const j = await call('', body);
    setBusy(null);
    if (/file$/.test(body.action)) setTimeout(() => filesHead.current?.focus({ preventScroll: true }), 0);
    // A change refused because the company changed since it was shown comes back with how it is now
    if (j.vendor && asked.current === id && j.vendor.id === id) setV(j.vendor);
    if (!j.success) { addToast(j.error || 'That didn’t work', 'error'); return null; }
    if (done) addToast(typeof done === 'function' ? done(j) : done, 'success');
    onChanged();
    return j;
  };
  const back = html`<button class="btn btn-ghost" onClick=${onBack}>← Every company</button>`;
  // A company moved onto its JobTread vendor: where it went
  if (err?.movedTo) return html`<div class="vp">${back}<div class="notice notice--info"><div class="notice__body">${err.error}</div><div class="notice__actions"><button class="btn btn-ghost" onClick=${() => onOpen(err.movedTo.id)}>Open ${err.movedTo.name}</button></div></div></div>`;
  if (err) return html`<div class="vp">${back}<div class="notice notice--danger"><div class="notice__body">${err}</div><div class="notice__actions"><button class="btn btn-ghost" onClick=${() => { setErr(null); load(); }}>Try again</button></div></div></div>`;
  if (!v) return html`<div class="vp">${back}<div class="area-loading"><span class="spinner" /></div></div>`;
  // The Files card keeps the same elements whether there are files or not: one swapped for another would start the
  // upload box below it over, mid-upload, and lose what the check said
  // A W-9 is only fetched when it's the one opened (each opening is logged); Download says it's a download
  const files = v.files.map((f) => ({ name: f.name, type: f.type, url: f.url, size: f.size, at: f.receivedAt || f.addedAt, private: f.doc === 'w9', download: `${f.url}&download=1` }));
  return html`
    <div class="vp">
      <div>${back}</div>
      ${v.jobtreadDown ? html`<div class="notice notice--warn"><div class="notice__body">${v.jobtreadDown}. This is what the site keeps for them; changes made in JobTread lately may not show yet.</div></div>` : null}
      ${v.archived ? html`<div class="notice notice--warn"><div class="notice__body"><strong>${v.site ? 'Off the list.' : 'Archived in JobTread.'}</strong> ${v.site ? 'Someone said SOARD doesn’t pay them. It comes back on its own if SOARD pays them again.' : 'Unarchive them in JobTread to ask them for anything.'}</div>
        ${v.site ? html`<div class="notice__actions"><button class="btn btn-ghost" disabled=${!!busy} onClick=${async () => { if (await act({ action: 'archive', id: v.id, archived: false }, `${v.name} is back on the list`)) setTimeout(() => head.current?.focus({ preventScroll: true }), 0); }}>Put it back on the list</button></div>` : null}</div>` : null}
      <div class="vp-top">
        <div>
          <h3 ref=${head} tabindex="-1"><span>${v.name}</span> <${Status} r=${v} /></h3>
          <p class="vp-lead">${v.ok && !v.expiring ? (v.need === 'Not needed' ? 'Nothing is asked of them.' : v.need === 'W-9 only' ? 'Their W-9 is on file, and nothing else is needed.' : 'Their W-9 and insurance are current.') : v.staff ? `Still needed: ${stillNeeded(v.staff)}.` : ''}
            ${v.site ? ' Paid outside JobTread.' : v.jobs.length ? ` On ${v.jobs.map((j) => j.name).join(', ')}.` : ''}</p>
        </div>
        <div class="vp-actions">
          ${v.jobtread ? html`<a class="btn btn-ghost" href=${v.jobtread} target="_blank" rel="noopener">Open in JobTread ↗</a>` : null}
        </div>
      </div>

      <${Record} key=${v.id} v=${v} act=${act} busy=${busy} />

      <div class="vp-card">
        <h4 ref=${filesHead} tabindex="-1">Files</h4>
        <div>${v.files.length ? v.files.map((f, i) => html`<${FileRow} key=${f.id} f=${f} i=${i} files=${files} v=${v} list=${list} act=${act} busy=${busy} />`) : html`<p class="vp-lead">No W-9 or certificate kept for them yet.</p>`}</div>
        <div class="vp-contents">${v.removed?.length ? html`<details class="vp-off"><summary class="vp-file__meta">Taken off (${v.removed.length})</summary>
          ${v.removed.map((f) => html`<div class="vp-file"><span class="vp-file__icon" aria-hidden="true">${isPhoto(f) ? '🖼' : '📄'}</span>
            <div class="vp-file__what"><strong class="vp-file__meta">${f.name}</strong><div class="vp-file__meta">${f.doc === 'w9' ? 'W-9' : 'Certificate'} · ${day(f.receivedAt || f.addedAt)} · ${whence(f)}</div></div>
            <div class="vp-file__acts"><button class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`Put back ${f.name}`}
              onClick=${() => act({ action: 'restore-file', fileId: f.id, shownOn: v.id, shownAs: 'removed' }, (j) => { const w = changedWords(j.changed?.to); return `Put back${w ? `. Now: ${w}` : ''}`; })}>Put back</button></div></div>`)}
        </details>` : null}</div>
        <${AddFile} v=${v} onDone=${(j) => { if (asked.current === id) setV(j.vendor); onChanged(); }} addToast=${addToast} />
      </div>

      ${v.archived ? null : html`<${Reach} v=${v} act=${act} busy=${busy} addToast=${addToast} />`}
      ${v.site ? html`<${SiteCompany} v=${v} act=${act} busy=${busy} list=${list} onOpen=${onOpen} onBack=${onBack} />` : null}
    </div>`;
}

/** One file: open it, download it, say it's looked at, move it to the right company or kind, or take it off */
function FileRow({ f, i, files, v, list, act, busy }) {
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState('');
  const words = to.trim().toLowerCase();
  const others = words.length >= 2 ? list.filter((r) => r.id !== v.id && r.name.toLowerCase().includes(words)).slice(0, 6) : [];
  const other = f.doc === 'w9' ? 'certificate' : 'W-9';
  // The file as this page shows it: someone may have moved it, taken it off or looked at it since (then it's a 409)
  const shown = { shownOn: v.id, shownAs: f.status };
  // What moving it did to each company's record, said in the toast (the record above shows the rest)
  const told = (where) => (j) => {
    const off = changedWords(j.changed?.from);
    const on = changedWords(j.changed?.to);
    const there = where.startsWith('Moved to ') ? where.slice(9) : null;
    // Relabeled on the one company: one "now" for both
    if (!there) return [where, [off, on].filter(Boolean).length && `${v.name} now: ${[off, on].filter(Boolean).join(', ')}`].filter(Boolean).join('. ');
    return [where, off && `${v.name} now: ${off}`, on && `${there} now: ${on}`].filter(Boolean).join('. ');
  };
  return html`
    <div class="vp-file">
      <span class="vp-file__icon" aria-hidden="true">${isPhoto(f) ? '🖼' : '📄'}</span>
      <div class="vp-file__what">
        <button class="link" onClick=${() => openViewer(files, i)}>${f.name}</button>
        <div class="vp-file__meta">${f.doc === 'w9' ? 'W-9' : 'Certificate'} · ${day(f.receivedAt || f.addedAt)} · ${whence(f)}${f.size ? ` · ${sizeText(f.size)}` : ''}
          ${f.status === 'look' ? html` · <${Tag} label="Needs a look" />` : null}</div>
        ${f.summary ? html`<div class="vp-file__meta">${f.summary}</div>` : null}
        ${f.reading?.policies?.length && !(f.status === 'checked' && f.summary) ? html`<div class="vp-file__meta">${f.reading.policies.map((p) => `${p.kind === 'workers compensation' ? 'Workers’ comp' : p.kind === 'general liability' ? 'Liability' : p.kind} to ${day(p.expires)}${p.each ? `, ${usd(p.each)} each` : ''}${p.insurer ? ` (${p.insurer})` : ''}`).join(' · ')}</div>` : null}
      </div>
      <div class="vp-file__acts">
        <a class="btn btn-ghost btn-sm" href=${`${f.url}&download=1`} aria-label=${`Download ${f.name}`}>Download</a>
        ${f.status === 'look' ? html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`I looked at it: ${f.name}`} onClick=${() => act({ action: 'file', fileId: f.id, status: 'checked', ...shown }, 'Marked as looked at')}>I looked at it</button>` : null}
        <button class="btn btn-ghost btn-sm" disabled=${!!busy} aria-expanded=${moving} aria-label=${`Move ${f.name}`} onClick=${() => setMoving(!moving)}>Move</button>
        <button class="btn btn-ghost btn-sm" disabled=${!!busy} aria-label=${`Take off ${f.name}`} onClick=${async () => {
          if (!(await ask({ title: `Take ${f.name} off ${v.name}?`, text: `It goes out of their list, kept out of sight (never deleted) and put back with one click. ${f.doc === 'w9' ? 'If it’s their only W-9, their W-9 shows as missing.' : 'A date only this certificate showed comes off their record.'} To put it on the right company instead, use Move.`, yes: 'Take it off' }))) return;
          act({ action: 'remove-file', fileId: f.id, ...shown }, told('Taken off'));
        }}>Take off</button>
      </div>
      ${moving ? html`
        <div class="vp-move">
          <p class="vp-file__meta">What it shows moves with it: ${f.doc === 'w9' ? 'the W-9' : 'its dates'} come off ${v.name} (unless another of their files shows the same) and go onto wherever it’s moved.</p>
          <div class="vp-actions"><button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => { setMoving(false); act({ action: 'move-file', fileId: f.id, doc: f.doc === 'w9' ? 'coi' : 'w9', ...shown }, told(`Now filed as a ${other}`)); }}>It’s a ${other}, not a ${f.doc === 'w9' ? 'W-9' : 'certificate'}</button></div>
          <label class="vp-field"><span>Or it belongs to another company</span><input class="form-input" type="search" placeholder="Type part of their name" value=${to} onInput=${(e) => setTo(e.target.value)} /></label>
          ${others.length ? html`<div class="vp-actions">${others.map((r) => html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => { setMoving(false); act({ action: 'move-file', fileId: f.id, toId: r.id, ...shown }, told(`Moved to ${r.name}`)); }}>${r.name}</button>`)}</div>`
            : words.length >= 2 ? html`<p class="vp-file__meta" role="status">No company by that name. Check the spelling, or add it from the list first.</p>` : null}
        </div>` : null}
    </div>`;
}

/** The record: W-9 on file, the two dates, and W-9 only / Nothing. Only what's changed is saved. */
function Record({ v, act, busy }) {
  const [w9, setW9] = useState(v.w9);
  const [gl, setGl] = useState(v.gl || '');
  const [wc, setWc] = useState(v.wc || '');
  const reset = () => { setW9(v.w9); setGl(v.gl || ''); setWc(v.wc || ''); };
  useEffect(reset, [v.id, v.w9, v.gl, v.wc]);
  const choice = v.need || null;
  // Dates aren't asked for under "W-9 only" or "Nothing", so they can't be changed (or saved) from there
  const change = {
    ...(w9 !== v.w9 ? { w9 } : {}),
    ...(!choice && (gl || null) !== (v.gl || null) ? { gl: gl || null } : {}),
    ...(!choice && (wc || null) !== (v.wc || null) ? { wc: wc || null } : {}),
  };
  const changed = Object.keys(change).length > 0;
  // What the page showed: a value that changed since (a certificate came in) is never saved over
  const base = { w9: v.w9, gl: v.gl || null, wc: v.wc || null, docs: v.need || null };
  const pick = (k) => { if (choice === k) return; reset(); act({ action: 'set', id: v.id, docs: k, base }, k ? `${v.name}: ${k === 'Not needed' ? 'nothing needed' : 'a W-9 only'}` : `${v.name} needs a W-9 and insurance`); };
  return html`
    <div class="vp-card">
      <h4>What they need</h4>
      <${Choice} label="What they need" n=${3} value=${choice} disabled=${!!busy} onPick=${pick} options=${[[null, 'W-9 and insurance'], ['W-9 only', 'W-9 only'], ['Not needed', 'Nothing']]} />
      ${choice === 'Not needed' ? html`<p class="vp-lead">Nothing is asked of them: no W-9 and no insurance.</p>` : html`
        <div class="vp-grid">
          <label class="vp-field"><span>W-9</span>
            <select class="form-input" value=${w9 ? 'yes' : 'no'} onChange=${(e) => setW9(e.target.value === 'yes')}><option value="yes">On file</option><option value="no">None</option></select></label>
          ${choice ? null : html`
            <label class="vp-field"><span>Liability ends</span><input class="form-input" type="date" value=${gl} onInput=${(e) => setGl(e.target.value)} /></label>
            <label class="vp-field"><span>Workers’ comp ends</span><input class="form-input" type="date" value=${wc} onInput=${(e) => setWc(e.target.value)} /></label>`}
        </div>`}
      ${v.check && !choice ? html`<p class="vp-file__meta">Last certificate: ${v.check}</p>` : null}
      ${changed ? html`<div class="vp-actions"><button class="btn btn-primary" disabled=${!!busy} onClick=${() => act({ action: 'set', id: v.id, ...change, base }, 'Saved')}>${busy === 'set' ? 'Saving…' : 'Save'}</button><button class="btn btn-ghost" onClick=${reset}>Undo</button></div>` : null}
    </div>`;
}

// A PDF's first pages as pictures, the way the company's own page sends them: a W-9's signature and typed boxes aren't in its text
let pdfjs = null;
const loadPdf = () => (pdfjs ||= import('./vendor-pdf.js').then((m) => m.pdfjsLib).catch((e) => { pdfjs = null; throw e; }));
async function pagePictures(file, max = 3, side = 2000) {
  if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) return [];
  try {
    const lib = await loadPdf();
    const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), standardFontDataUrl: '/admin/pdf/standard_fonts/', wasmUrl: '/admin/pdf/wasm/', useWasm: false, enableXfa: false });
    const out = [];
    try {
      const doc = await task.promise;
      for (let n = 1; n <= Math.min(max, doc.numPages); n++) {
        const page = await doc.getPage(n);
        const one = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: side / Math.max(one.width, one.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvas, viewport, background: 'white', annotationMode: lib.AnnotationMode.ENABLE_STORAGE }).promise;
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
        if (blob) out.push(blob);
      }
    } finally {
      task.destroy();
    }
    return out;
  } catch {
    return [];
  }
}

// An iPhone photo (HEIC), as a JPEG the check can read and any browser can show: Safari draws it itself; elsewhere the
// converter the company's own page uses (./vendor-heic.js, loaded only then)
const isHeic = (f) => /^image\/hei[cf]$/i.test(f.type || '') || /\.hei[cf]$/i.test(f.name || '');
async function asJpeg(f) {
  const name = `${String(f.name || 'photo').replace(/\.[^.]+$/, '')}.jpg`;
  try {
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    if (blob) return new File([blob], name, { type: 'image/jpeg' });
  } catch { /* not a picture this browser draws */ }
  const { heicTo } = await import('./vendor-heic.js');
  return new File([await heicTo({ blob: f, type: 'image/jpeg', quality: 0.9 })], name, { type: 'image/jpeg' });
}

/** Add a W-9 or certificate that came another way: checked like one from their page, kept either way */
function AddFile({ v, onDone, addToast }) {
  const [doc, setDoc] = useState(v.needs?.includes('w9') || v.need ? 'w9' : 'coi');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [result, setResult] = useState(null);
  const input = useRef(null);
  const busyRef = useRef(false);
  const send = async (list) => {
    // One at a time: a second file dropped while the first is being checked waits for it
    if (busyRef.current) { addToast('One moment: the last file is still being checked', 'info'); return; }
    const all = [...(list || [])];
    let files = all.slice(0, doc === 'w9' ? 1 : 3);
    if (!files.length) return;
    if (all.length > files.length) addToast(doc === 'w9' ? 'One W-9 at a time: the first one is being added' : 'Up to three files for one certificate: the first three are being added', 'info');
    if (files.some((f) => f.size > 15 * 1024 * 1024)) { addToast('A file is over 15 MB. Try a smaller copy or a PDF.', 'error'); return; }
    busyRef.current = true;
    setBusy(true);
    setResult(null);
    try {
      files = await Promise.all(files.map((f) => (isHeic(f) ? asJpeg(f) : f)));
    } catch {
      busyRef.current = false;
      setBusy(false);
      addToast('That iPhone photo couldn’t be opened here. Try it in Safari, or save it as a JPG first.', 'error');
      return;
    }
    const form = new FormData();
    form.set('id', v.id);
    form.set('doc', doc);
    for (const [i, f] of files.entries()) {
      form.append('file', f, f.name);
      for (const [n, p] of (await pagePictures(f, doc === 'w9' ? 2 : 3)).entries()) form.append(`pages${i}`, p, `page-${n + 1}.jpg`);
    }
    const j = await call('', form);
    busyRef.current = false;
    setBusy(false);
    if (input.current) input.current.value = '';
    if (!j.success) { addToast(j.error || 'That didn’t go through', 'error'); return; }
    setResult(j.result);
    onDone(j);
  };
  const r = result;
  return html`
    <div class=${`vp-drop ${over ? 'is-over' : ''} ${busy ? 'is-busy' : ''}`} aria-busy=${busy}
      onDragOver=${(e) => { e.preventDefault(); if (!busy) setOver(true); }} onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files); }}>
      <${Choice} label="What it is" n=${2} value=${doc} disabled=${busy} pickOnArrow onPick=${setDoc} options=${[['w9', 'W-9'], ['coi', 'Certificate of insurance']]} />
      <div class="vp-actions">
        <input ref=${input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" multiple=${doc === 'coi'} hidden onChange=${(e) => send(e.target.files)} />
        <button class="btn btn-ghost" disabled=${busy} onClick=${() => input.current?.click()}>${busy ? 'Checking it…' : `Add a ${doc === 'w9' ? 'W-9' : 'certificate'}`}</button>
        <span class="vp-file__meta"><span class="vp-drop-word">or drop a PDF or photo here. </span>It’s checked the same way as on their page, and kept either way.</span>
      </div>
      ${r ? html`<div class="vp-result" role="status">
        ${r.duplicate ? html`<strong>That file was already kept.</strong> ` : null}
        ${r.accepted ? html`<strong>It checks out.</strong>` : r.look ? html`<strong>Nobody could read it automatically.</strong> Say what it shows above: the W-9, or when liability and workers’ comp end.` : html`<strong>Kept, but it doesn’t pass:</strong><ul>${r.problems.map((p) => html`<li>${p}</li>`)}</ul>`}
        ${r.lines?.length ? html`<div>${r.accepted ? '' : 'It shows:'}<ul>${r.lines.map((l) => html`<li>${l}</li>`)}</ul></div>` : null}
        ${[r.changed?.w9 && 'W-9', r.changed?.gl && `liability to ${day(r.changed.gl)}`, r.changed?.wc && `workers’ comp to ${day(r.changed.wc)}`].some(Boolean)
          ? html`<div>Now on file: ${[r.changed.w9 && 'W-9', r.changed.gl && `liability to ${day(r.changed.gl)}`, r.changed.wc && `workers’ comp to ${day(r.changed.wc)}`].filter(Boolean).join(', ')}.</div>` : null}
      </div>` : null}
    </div>`;
}

/** Their link and the email asking for what's missing */
function Reach({ v, act, busy, addToast }) {
  // A JobTread vendor with no email: one typed here goes onto their JobTread contacts
  const [typed, setTyped] = useState('');
  useEffect(() => { setTyped(''); }, [v.id, v.email]);
  const add = (e) => { e.preventDefault(); act({ action: 'edit', id: v.id, email: typed.trim() }, (j) => `${j.vendor?.email || 'Their email'} is on their JobTread contacts now`); };
  const copy = async () => {
    const j = await act({ action: 'link', id: v.id });
    if (!j?.url) return;
    try { await navigator.clipboard.writeText(j.url); addToast('Their link is copied. It works for 90 days.', 'success'); } catch { addToast(`Their link (works for 90 days): ${j.url}`, 'info'); }
  };
  const email = async () => {
    if (!(await ask({ title: `Email ${v.name}?`, text: `${v.email} gets SOARD’s email asking for ${stillNeeded(v.staff) || 'their papers'}, with their link.`, yes: 'Send it' }))) return;
    act({ action: 'ask', id: v.id }, (j) => `Sent to ${j.sent}`);
  };
  const asking = !v.ok || v.expiring;
  return html`
    <div class="vp-card">
      <h4>Asking them</h4>
      <p class="vp-lead">${v.ask?.askedAt ? `Asked ${v.ask.asks} time${v.ask.asks === 1 ? '' : 's'}, last on ${day(v.ask.askedAt)}. ` : ''}${v.email ? `Their email: ${v.email}.` : v.site ? 'No email on file yet.' : 'No email on their JobTread contacts.'}${v.agent ? ` Their insurance agent: ${v.agent.name || v.agent.email}${v.agent.agency ? ` at ${v.agent.agency}` : ''} (${v.agent.email}).` : ''}</p>
      ${!v.email && !v.site ? html`<form onSubmit=${add}>
        <div class="vp-grid"><label class="vp-field"><span>Their email (it goes on their JobTread contacts)</span><input class="form-input" type="email" autocomplete="off" value=${typed} onInput=${(e) => setTyped(e.target.value)} /></label></div>
        <div class="vp-actions"><button class="btn btn-primary" type="submit" disabled=${!!busy || !typed.trim()}>Add their email</button></div>
      </form>` : null}
      <div class="vp-actions">
        <button class="btn btn-ghost" disabled=${!!busy} onClick=${copy}>Copy their link</button>
        ${asking && v.email ? html`<button class="btn btn-ghost" disabled=${!!busy} onClick=${email}>Email them for it</button>` : null}
      </div>
    </div>`;
}

/** A company only on the site: its name and email, the JobTread vendor it may be, or out of the list */
function SiteCompany({ v, act, busy, list, onOpen, onBack }) {
  const [name, setName] = useState(v.name);
  const [email, setEmail] = useState(v.email || '');
  const [same, setSame] = useState('');
  useEffect(() => { setName(v.name); setEmail(v.email || ''); }, [v.id, v.name, v.email]);
  const words = same.trim().toLowerCase();
  const jt = words.length >= 2 ? list.filter((r) => !r.site && r.name.toLowerCase().includes(words)).slice(0, 8) : [];
  const merge = async (r) => {
    if (!(await ask({ title: `Is ${v.name} the same company as ${r.name} in JobTread?`, text: `${v.name}’s files and dates go onto ${r.name}, and ${v.name} comes off this list. The link SOARD sent them stops working; ${r.name} has its own. This can’t be undone.`, yes: 'Yes, the same company' }))) return;
    const j = await act({ action: 'merge', id: v.id, jtId: r.id }, `Moved onto ${r.name}`);
    if (j?.vendor) onOpen(j.vendor.id);
  };
  const archive = async () => {
    if (!(await ask({ title: `Take ${v.name} off the list?`, text: 'For a company SOARD doesn’t pay after all. Its files are kept. It comes back on its own if SOARD pays them again (a Ramp bill or a Mercury payment dated later). Until then, find it by typing its name in the list.', yes: 'Take it off' }))) return;
    const j = await act({ action: 'archive', id: v.id, archived: true }, `${v.name} is off the list`);
    if (j) onBack();
  };
  return html`
    <div class="vp-card">
      <h4>This company</h4>
      ${v.payee ? html`<p class="vp-file__meta">Paid through ${[v.payee.mercury && 'Mercury', v.payee.ramp && 'Ramp'].filter(Boolean).join(' and ') || 'SOARD'}${v.payee.cents12 ? `, ${usdCents(v.payee.cents12)} through Ramp in the last year` : ''}${v.payee.last ? `, last on ${day(v.payee.last)}` : ''}.</p>` : null}
      <div class="vp-grid">
        <label class="vp-field"><span>Company</span><input class="form-input" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <label class="vp-field"><span>Email</span><input class="form-input" type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>
      </div>
      ${name !== v.name || email !== (v.email || '') ? html`<div class="vp-actions"><button class="btn btn-primary" disabled=${!!busy} onClick=${() => act({ action: 'edit', id: v.id, name, email }, 'Saved')}>Save</button></div>` : null}
      ${v.maybe?.length ? html`<div class="vp-field"><span>Likely the same as a JobTread vendor</span><div class="vp-actions">${v.maybe.map((r) => html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => merge(r)}>It’s ${r.name}</button>`)}</div></div>` : null}
      <label class="vp-field"><span>Is it a JobTread vendor after all?</span><input class="form-input" type="search" placeholder="Type part of its JobTread name" value=${same} onInput=${(e) => setSame(e.target.value)} /></label>
      ${jt.length ? html`<div class="vp-actions">${jt.map((r) => html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => merge(r)}>${r.name}</button>`)}</div>` : null}
      ${v.archived ? null : html`<div class="vp-actions"><button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${archive}>SOARD doesn’t pay them</button></div>`}
    </div>`;
}
