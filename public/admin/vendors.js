/**
 * Admin → Vendors: who SOARD pays, their W-9 and insurance, and 1099s
 * ===========================================================================
 * Over /api/vendors-admin (functions/api/_vendors.js). The list builds
 * itself from Mercury, JobTread and spending; W-9s come through Mercury and
 * insurance certificates through the vendor's own page, both asked for
 * automatically once Settings says so. People use this page to look, to
 * fill a gap (an email, a certificate that came by email), and in January
 * to hand the 1099 list to the CPA.
 *
 * Tabs (#vendors/<tab>, or #vendors/<vendorId> for one vendor):
 *   Vendors   everyone, the ones that need something first
 *   1099      payees over the line for a year, with a CSV for the CPA
 *   Settings  the two automatic requests, previews, the $ line
 */

import { h, htm, useState, useEffect } from './vendor.js';
import { ask } from './ask.js';

const html = htm.bind(h);
const API = '/api/vendors-admin';
const TABS = [['list', 'Vendors'], ['1099', '1099'], ['settings', 'Settings']];

async function call(body) {
  let r;
  try {
    r = await fetch(API, body
      ? (body instanceof FormData ? { method: 'POST', body } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      : { cache: 'no-store' });
  } catch {
    return { success: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  return j;
}

const usd = (c) => (Math.round(Number(c || 0) / 100)).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const longDate = (d) => {
  if (!d) return '';
  const s = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d;
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const COI_TEXT = { current: 'Insured', expiring: 'Insurance ends soon', expired: 'Insurance ended', missing: 'No insurance on file', 'not-needed': 'No insurance needed' };
const KIND_TEXT = { sub: 'Sub', supplier: 'Supplier' };

const CSS = `
.vd { display: grid; gap: 1rem; }
.vd-list { display: grid; gap: 0; }
.vd-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .35rem 1rem; align-items: center; padding: .8rem 1.1rem; border: 0; border-bottom: 1px solid var(--color-border); background: none; text-align: left; font: inherit; color: inherit; cursor: pointer; width: 100%; }
.vd-row:last-child { border-bottom: none; }
.vd-row:hover { background: var(--tone-neutral-bg); }
.vd-row:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.vd-row h3 { margin: 0; font-size: var(--fs-md); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vd-row__tags { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .3rem; }
.vd-row__amt { text-align: right; font-variant-numeric: tabular-nums; font-size: var(--fs-sm); }
.vd-row__amt small { display: block; color: var(--color-text-muted); font-size: var(--fs-2xs); }
.vd-tools { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.vd-tools .form-input { max-width: 18rem; }
.vd-body { padding: 1rem 1.25rem; display: grid; gap: .75rem; }
.vd-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr)); gap: .75rem 1.25rem; }
.vd-field { display: grid; gap: .3rem; }
.vd-field > span { font-size: var(--fs-xs); font-weight: 600; }
.vd-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .35rem 1rem; margin: 0; font-size: var(--fs-sm); }
.vd-facts dt { color: var(--color-text-secondary); }
.vd-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.vd-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.vd-table-wrap { overflow-x: auto; }
.vd-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.vd-table th { text-align: left; font-size: var(--fs-2xs); font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: .04em; padding: .5rem .6rem; border-bottom: 1px solid var(--color-border); white-space: nowrap; }
.vd-table td { padding: .55rem .6rem; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
.vd-table .num { text-align: right; }
.vd-suggest { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; justify-content: space-between; padding: .65rem 1.1rem; border-bottom: 1px solid var(--color-border); font-size: var(--fs-sm); }
.vd-suggest:last-child { border-bottom: none; }
.vd-switch { display: flex; gap: 1rem; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.vd-switch p { margin: .25rem 0 0; max-width: 46rem; }
@media (max-width: 640px) {
  .vd-row { padding: .75rem .85rem; }
  .vd-body { padding: .85rem; }
  .vd-tools .form-input, .vd-actions .btn, .vd-actions .form-input { flex: 1 1 100%; max-width: none; min-height: 44px; }
  .vd-table .vd-hide-sm { display: none; }
  .vd-facts { grid-template-columns: 1fr; gap: .1rem; }
  .vd-facts dd { margin-bottom: .4rem; }
}
`;
let styled = false;
function useStyles() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.module = 'vendors';
  el.textContent = CSS;
  document.head.append(el);
}

function placeOf(hash = location.hash) {
  const parts = String(hash).replace(/^#/, '').split('/').slice(1).filter(Boolean).map((x) => decodeURIComponent(x));
  if (!parts[0]) return { tab: 'list', id: null };
  if (TABS.some(([k]) => k === parts[0])) return { tab: parts[0], id: null };
  return { tab: 'list', id: parts[0] };
}
function go(tab, id = null) {
  const next = `#vendors${id ? `/${encodeURIComponent(id)}` : tab && tab !== 'list' ? `/${tab}` : ''}`;
  if (location.hash !== next) history.pushState(null, '', next);
}

const needsAny = (v) => v.needs.w9 || v.needs.coi || v.needs.email;

export function Vendors({ addToast = () => {} }) {
  useStyles();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [place, setPlace] = useState(placeOf);
  const [busy, setBusy] = useState(null);

  const load = async () => {
    const j = await call(null);
    if (!j.success) { setErr(j.error || 'Could not load vendors'); return; }
    setErr(null);
    setData(j);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const on = () => setPlace(placeOf());
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('hashchange', on); };
  }, []);
  const open = (tab, id = null) => { go(tab, id); setPlace({ tab, id }); window.scrollTo?.(0, 0); };

  const act = async (body, done) => {
    setBusy(body instanceof FormData ? body.get('action') : body.action);
    const j = await call(body);
    setBusy(null);
    if (!j.success) { addToast(j.error || 'That did not work', 'error'); return null; }
    setData((d) => ({ ...(d || {}), ...j }));
    if (done) addToast(typeof done === 'function' ? done(j) : done, 'success');
    return j;
  };

  if (err && !data) {
    return html`<div class="notice notice--danger"><div class="notice__body"><strong>Couldn't load vendors:</strong> ${err}</div>
      <div class="notice__actions"><button class="btn btn-ghost" onClick=${load}>Try again</button></div></div>`;
  }
  if (!data) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;

  const waiting = data.vendors.filter(needsAny).length;
  const vendor = place.id ? data.vendors.find((v) => v.id === place.id) : null;
  return html`
    <div class="vd">
      <div class="page-header">
        <div>
          <h2>Vendors</h2>
          <p class="page-sub">Everyone SOARD pays, from Mercury, JobTread and the cards. Subs need a W-9 and a current certificate of insurance; suppliers paid only by card need neither.</p>
        </div>
      </div>
      <${Health} h=${data.health} settings=${data.settings} act=${act} busy=${busy} />
      <div class="seg" role="tablist" aria-label="Vendors">
        ${TABS.map(([k, label]) => html`<button role="tab" aria-selected=${place.tab === k && !(k === 'list' && vendor)} onClick=${() => open(k)}>${label}${k === 'list' && waiting ? html` <span class="count is-warn">${waiting}</span>` : ''}</button>`)}
      </div>
      ${vendor ? html`<${Detail} v=${vendor} data=${data} act=${act} busy=${busy} addToast=${addToast} onBack=${() => open('list')} onOpen=${(id) => open('list', id)} />`
        : place.id ? html`<div class="notice"><div class="notice__body">That vendor isn’t here any more. It may have been linked into another.</div><div class="notice__actions"><button class="btn btn-ghost" onClick=${() => open('list')}>All vendors</button></div></div>`
        : place.tab === '1099' ? html`<${Filings} data=${data} />`
        : place.tab === 'settings' ? html`<${Settings} data=${data} act=${act} busy=${busy} />`
        : html`<${List} data=${data} act=${act} busy=${busy} onOpen=${(id) => open('list', id)} />`}
    </div>`;
}

function Health({ h, settings, act, busy }) {
  const notes = [];
  if (!h.mercury) notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>Mercury isn’t connected yet.</strong> Until it is, vendors come from JobTread and the cards only, and W-9s can’t be asked for.</div></div>`);
  if (h.lastError) {
    notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>The last read didn’t finish:</strong> ${h.lastError.error} (${ago(h.lastError.at)}).</div>
      <div class="notice__actions"><button class="btn btn-ghost" disabled=${!!busy} onClick=${() => act({ action: 'refresh' }, 'Read again')}>${busy === 'refresh' ? 'Reading…' : 'Read again now'}</button></div></div>`);
  }
  if (!h.files) notes.push(html`<div class="notice notice--danger"><div class="notice__body"><strong>File storage isn’t set up</strong> (FILES), so certificates can’t be received.</div></div>`);
  return html`${notes}<p class="sec-head__hint" style="margin: 0;">Mercury read ${ago(h.recipientsAt)} · JobTread read ${ago(h.jobtreadAt)} · W-9 requests ${settings.autoW9 ? 'on' : 'off'} · Insurance requests ${settings.autoCoi ? 'on' : 'off'}</p>`;
}

function Tags({ v }) {
  return html`<span class="vd-row__tags">
    <span class="tag">${KIND_TEXT[v.kind]}</span>
    ${v.kind === 'sub' || v.w9 ? (v.w9 ? html`<span class="tag tag--success">W-9 on file</span>` : v.needs.w9 ? html`<span class="tag tag--warn">Needs a W-9</span>` : html`<span class="tag">No W-9 yet</span>`) : ''}
    ${v.coiState !== 'not-needed' ? html`<span class="tag ${v.coiState === 'current' ? 'tag--success' : v.needs.coi ? 'tag--warn' : ''}">${COI_TEXT[v.coiState]}${v.coi?.expires && v.coiState !== 'missing' ? ` · ${longDate(v.coi.expires)}` : ''}</span>` : ''}
    ${v.needs.email ? html`<span class="tag tag--warn">Needs an email</span>` : ''}
    ${v.onJob ? html`<span class="tag">${v.facts.jobs.length} open job${v.facts.jobs.length === 1 ? '' : 's'}</span>` : ''}
  </span>`;
}

function List({ data, act, busy, onOpen }) {
  const [filter, setFilter] = useState(() => (data.vendors.some(needsAny) ? 'needs' : 'subs'));
  const [q, setQ] = useState('');
  const year = data.year;
  const shown = data.vendors
    .filter((v) => (filter === 'needs' ? needsAny(v) : filter === 'subs' ? v.kind === 'sub' : filter === 'suppliers' ? v.kind === 'supplier' : true))
    .filter((v) => !q || [v.name, ...(v.facts.names || [])].some((n) => n.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => Number(needsAny(b)) - Number(needsAny(a)) || (b.paid.reportable[year] + b.paid.card[year]) - (a.paid.reportable[year] + a.paid.card[year]) || a.name.localeCompare(b.name));
  const FILTERS = [['needs', 'Need something'], ['subs', 'Subs'], ['suppliers', 'Suppliers'], ['all', 'All']];
  return html`
    ${data.suggestions.length ? html`<section class="card">
      <div class="card-header"><h3 class="card-title">Same vendor?</h3></div>
      ${data.suggestions.slice(0, 6).map((s) => html`<div class="vd-suggest" key=${`${s.a}|${s.b}`}>
        <span><strong>${s.aName}</strong> and <strong>${s.bName}</strong></span>
        <span class="vd-actions">
          <button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => act({ action: 'not-same', a: s.a, b: s.b })}>Not the same</button>
          <button class="btn btn-secondary btn-sm" disabled=${!!busy} onClick=${async () => { if (await ask({ title: `Make ${s.bName} part of ${s.aName}?`, text: 'Their payments, documents and jobs show as one vendor. You can pull them apart again from the vendor’s page.', yes: 'Link them' })) act({ action: 'link', a: s.a, b: s.b }, 'Linked'); }}>Link them</button>
        </span>
      </div>`)}
    </section>` : ''}
    <div class="vd-tools">
      <div class="seg" role="group" aria-label="Show">
        ${FILTERS.map(([k, label]) => html`<button aria-pressed=${filter === k} onClick=${() => setFilter(k)}>${label}</button>`)}
      </div>
      <label class="sr-only" for="vd-search">Find a vendor</label>
      <input id="vd-search" class="form-input" type="search" placeholder="Find a vendor" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>
    ${shown.length ? html`<section class="card vd-list">
      ${shown.map((v) => html`<button class="vd-row" key=${v.id} onClick=${() => onOpen(v.id)}>
        <span style="min-width: 0;"><h3>${v.name}</h3><${Tags} v=${v} /></span>
        <span class="vd-row__amt">${usd(v.paid.reportable[year] + v.paid.card[year])}<small>paid in ${year}</small></span>
      </button>`)}
    </section>` : html`<div class="empty">${filter === 'needs' ? 'Nobody needs anything right now.' : data.vendors.length ? 'No vendors match.' : 'No vendors yet. They arrive from Mercury and JobTread within the hour.'}</div>`}`;
}

function Detail({ v, data, act, busy, addToast, onBack, onOpen }) {
  const year = data.year;
  const [email, setEmail] = useState(v.email || '');
  const [coiFile, setCoiFile] = useState(null);
  const [coiExpires, setCoiExpires] = useState('');
  const [coiInsurer, setCoiInsurer] = useState('');
  const [link, setLink] = useState(null);
  useEffect(() => { setEmail(v.email || ''); setLink(null); }, [v.id]);
  const months = Object.entries(v.paid.months || {}).filter(([m]) => m.startsWith(`${year}-`) || m.startsWith(`${year - 1}-`)).sort((a, b) => b[0].localeCompare(a[0]));
  const m = v.facts.mercury;
  const upload = async (doc, file) => {
    const f = new FormData();
    f.append('action', 'upload');
    f.append('id', v.id);
    f.append('doc', doc);
    f.append('file', file);
    if (doc === 'coi') { f.append('coiExpires', coiExpires); f.append('coiInsurer', coiInsurer); }
    const j = await act(f, doc === 'w9' ? 'W-9 saved' : 'Certificate saved');
    if (j && doc === 'coi') { setCoiFile(null); setCoiExpires(''); setCoiInsurer(''); }
  };
  const fileUrl = (doc) => `${API}?file=${encodeURIComponent(v.id)}&doc=${doc}`;

  return html`
    <div><button class="btn btn-ghost btn-sm" onClick=${onBack}>← All vendors</button></div>
    <section class="card">
      <div class="card-header"><h3 class="card-title">${v.name}</h3></div>
      <div class="vd-body">
        <${Tags} v=${v} />
        <dl class="vd-facts">
          <dt>Paid in ${year}</dt><dd>${usd(v.paid.reportable[year])} by ACH, check or wire · ${usd(v.paid.card[year])} by card</dd>
          <dt>Paid in ${year - 1}</dt><dd>${usd(v.paid.reportable[year - 1])} by ACH, check or wire · ${usd(v.paid.card[year - 1])} by card</dd>
          ${v.paid.lastPaid ? html`<dt>Last paid</dt><dd>${longDate(v.paid.lastPaid)}</dd>` : ''}
          <dt>Mercury</dt><dd>${v.mercuryId ? `A recipient${m?.method ? `, paid by ${m.method === 'ach' ? 'ACH' : m.method === 'check' ? 'check' : 'wire'}` : ''}` : 'Not a recipient'}</dd>
          ${m?.address ? html`<dt>Address</dt><dd>${m.address}</dd>` : ''}
          <dt>JobTread</dt><dd>${v.jtId ? 'A vendor account' : 'Not in JobTread'}</dd>
          ${(v.facts.jobs || []).length ? html`<dt>Open jobs</dt><dd>${v.facts.jobs.map((j) => `${j.jobName}${j.status ? ` (${j.status})` : ''}`).join(', ')}</dd>` : ''}
          ${(v.facts.names || []).length > 1 ? html`<dt>Also known as</dt><dd>${v.facts.names.filter((n) => n !== v.name).join(', ')}</dd>` : ''}
        </dl>
        <div class="vd-actions">
          <label class="sr-only" for="vd-email">Email</label>
          <input id="vd-email" class="form-input" style="max-width: 20rem;" type="email" placeholder="Their email for W-9 and insurance requests" value=${email} onInput=${(e) => setEmail(e.target.value)} />
          <button class="btn btn-secondary btn-sm" disabled=${!!busy || email.trim() === (v.email || '')} onClick=${() => act({ action: 'set', id: v.id, email: email.trim() }, 'Email saved')}>Save email</button>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header"><h3 class="card-title">W-9</h3></div>
      <div class="vd-body">
        ${v.w9 ? html`<p style="margin: 0;">On file since ${longDate(v.w9.at)}, ${v.w9.source === 'mercury' ? 'sent to Mercury' : 'sent through their link or added here'}. <a href=${fileUrl('w9')} target="_blank" rel="noopener">Open the W-9</a></p>`
          : html`<p style="margin: 0;">${v.kind === 'sub' ? 'Not on file yet.' : 'Suppliers paid only by card don’t need one.'}${v.invite?.at ? ` Mercury asked them ${v.invite.count} time${v.invite.count === 1 ? '' : 's'}, last ${longDate(v.invite.at)}${v.invite.status && v.invite.status !== 'created' ? ` (${v.invite.status})` : ''}.` : ''}</p>
            <div class="vd-actions">
              ${data.health.mercury ? html`<button class="btn btn-secondary btn-sm" disabled=${!!busy || !v.email} onClick=${() => act({ action: 'ask-w9', id: v.id }, `Mercury emailed ${v.email} a page for their W-9`)}>${busy === 'ask-w9' ? 'Asking…' : 'Ask through Mercury now'}</button>` : ''}
              <label class="btn btn-ghost btn-sm" style="cursor: pointer;">Add a W-9 they sent<input class="sr-only" type="file" accept="application/pdf,image/*" onChange=${(e) => e.target.files[0] && upload('w9', e.target.files[0])} /></label>
            </div>
            ${!v.email ? html`<p class="sec-head__hint" style="margin: 0;">Add their email above to ask.</p>` : ''}`}
      </div>
    </section>

    <section class="card">
      <div class="card-header"><h3 class="card-title">Certificate of insurance</h3></div>
      <div class="vd-body">
        <p style="margin: 0;">${v.coi?.expires ? html`${v.coiState === 'expired' ? 'Ended' : 'Good through'} ${longDate(v.coi.expires)}${v.coi.insurer ? ` with ${v.coi.insurer}` : ''}, sent ${longDate(v.coi.at)}${v.coi.by && v.coi.by !== 'vendor' ? ' (added here)' : ''}. ${v.coi.key ? html`<a href=${fileUrl('coi')} target="_blank" rel="noopener">Open the certificate</a>` : ''}` : COI_TEXT[v.coiState] + '.'}
          ${v.coiAsk?.at ? ` Asked ${v.coiAsk.count} time${v.coiAsk.count === 1 ? '' : 's'}, last ${longDate(v.coiAsk.at)}.` : ''}</p>
        ${v.coiNeeded ? html`<div class="vd-actions">
          <button class="btn btn-secondary btn-sm" disabled=${!!busy || !v.email} onClick=${() => act({ action: 'ask-coi', id: v.id }, `Emailed ${v.email} their upload link`)}>${busy === 'ask-coi' ? 'Sending…' : 'Email them the upload link'}</button>
          <button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${async () => { const j = await act({ action: 'coi-link', id: v.id }); if (j?.link) { setLink(j.link.url); try { await navigator.clipboard.writeText(j.link.url); addToast('Link copied. It works for 30 days.', 'success'); } catch {} } }}>Copy an upload link</button>
        </div>` : ''}
        ${link ? html`<p class="sec-head__hint" style="margin: 0; overflow-wrap: anywhere;">${link}</p>` : ''}
        <details>
          <summary class="text-sm">Add a certificate they emailed</summary>
          <div class="vd-grid" style="margin-top: .75rem;">
            <label class="vd-field"><span>The certificate</span><input class="form-input" type="file" accept="application/pdf,image/*" onChange=${(e) => setCoiFile(e.target.files[0] || null)} /></label>
            <label class="vd-field"><span>Policy ends</span><input class="form-input" type="date" value=${coiExpires} onInput=${(e) => setCoiExpires(e.target.value)} /></label>
            <label class="vd-field"><span>Insurance company</span><input class="form-input" type="text" maxlength="120" value=${coiInsurer} onInput=${(e) => setCoiInsurer(e.target.value)} /></label>
          </div>
          <div class="vd-actions" style="margin-top: .75rem;"><button class="btn btn-primary btn-sm" disabled=${!!busy || !coiFile || !coiExpires} onClick=${() => upload('coi', coiFile)}>${busy === 'upload' ? 'Saving…' : 'Save the certificate'}</button></div>
        </details>
      </div>
    </section>

    ${months.length ? html`<section class="card">
      <div class="card-header"><h3 class="card-title">ACH, check and wire payments</h3></div>
      <div class="vd-table-wrap"><table class="vd-table">
        <thead><tr><th>Month</th><th class="num">Paid</th></tr></thead>
        <tbody>${months.map(([mo, c]) => html`<tr key=${mo}><td>${new Date(`${mo}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</td><td class="num">${usd(c)}</td></tr>`)}</tbody>
      </table></div>
    </section>` : ''}

    <section class="card">
      <div class="card-header"><h3 class="card-title">How the site treats them</h3></div>
      <div class="vd-body">
        <div class="vd-grid">
          <label class="vd-field"><span>Sub or supplier</span>
            <select class="form-input" value=${v.kindSet || ''} disabled=${!!busy} onChange=${(e) => act({ action: 'set', id: v.id, kind: e.target.value || null }, 'Saved')}>
              <option value="">Let the site decide (now: ${KIND_TEXT[v.autoKind]})</option><option value="sub">Sub: needs a W-9 and insurance</option><option value="supplier">Supplier: needs neither</option>
            </select></label>
          <label class="vd-field"><span>Insurance</span>
            <select class="form-input" value=${v.coiNeededSet === null || v.coiNeededSet === undefined ? '' : String(v.coiNeededSet)} disabled=${!!busy} onChange=${(e) => act({ action: 'set', id: v.id, coiNeeded: e.target.value === '' ? null : e.target.value === 'true' }, 'Saved')}>
              <option value="">Subs only (the usual)</option><option value="true">Always ask for a certificate</option><option value="false">Never ask</option>
            </select></label>
        </div>
        <label class="vd-actions" style="gap: .5rem;"><input type="checkbox" checked=${v.corp} disabled=${!!busy} onChange=${(e) => act({ action: 'set', id: v.id, corp: e.target.checked }, e.target.checked ? 'Left off the 1099 list' : 'Back on the 1099 list')} /> A corporation (its W-9 says so): no 1099</label>
        ${v.mercuryId && v.jtId ? html`<div class="vd-actions">
          <button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${async () => {
            if (!(await ask({ title: `Pull the JobTread vendor apart from ${v.name}?`, text: 'Use this when the site joined two different companies. They show as two vendors from now on.', yes: 'Pull apart' }))) return;
            const j = await act({ action: 'unlink', id: v.id, part: 'jobtread' }, 'Now two vendors');
            if (j?.newId) onOpen(v.id);
          }}>These are two different companies</button>
        </div>` : ''}
      </div>
    </section>`;
}

function Filings({ data }) {
  const [year, setYear] = useState(data.year - 1);
  const rows = data.filings[year] || [];
  const total = rows.reduce((s, r) => s + r.total, 0);
  const missing = rows.filter((r) => !r.w9).length;
  return html`
    <section class="card">
      <div class="card-header"><h3 class="card-title">1099-NEC list</h3></div>
      <div class="vd-body">
        <p style="margin: 0;">Everyone SOARD paid $${data.settings.threshold.toLocaleString('en-US')} or more by ACH, check or wire. Card payments never count here: the card network reports those on its own 1099-K. Corporations are left off once you mark them.</p>
        <div class="vd-tools">
          <div class="seg" role="group" aria-label="Year">
            ${[data.year - 1, data.year].map((y) => html`<button aria-pressed=${year === y} onClick=${() => setYear(y)}>${y}${y === data.year ? ' so far' : ''}</button>`)}
          </div>
          ${rows.length ? html`<a class="btn btn-secondary btn-sm" href=${`${API}?csv=1099&year=${year}`} download>Download for the CPA</a>` : ''}
        </div>
        <p class="sec-head__hint" style="margin: 0;">${rows.length} vendor${rows.length === 1 ? '' : 's'} · ${usd(total)} in all${missing ? ` · ${missing} still need${missing === 1 ? 's' : ''} a W-9` : ''}</p>
      </div>
      ${rows.length ? html`<div class="vd-table-wrap"><table class="vd-table">
        <thead><tr><th>Vendor</th><th class="num">Paid</th><th>W-9</th><th class="vd-hide-sm">Address</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr key=${r.id}><td><a href=${`#vendors/${encodeURIComponent(r.id)}`}>${r.name}</a></td><td class="num">${usd(r.total)}</td><td>${r.w9 ? 'On file' : html`<span class="tag tag--warn">Missing</span>`}</td><td class="vd-hide-sm">${r.address || '–'}</td></tr>`)}</tbody>
      </table></div>` : html`<div class="empty">Nobody over the line for ${year}${year === data.year ? ' yet' : ''}.</div>`}
    </section>`;
}

function Settings({ data, act, busy }) {
  const s = data.settings;
  const [threshold, setThreshold] = useState(String(s.threshold));
  const [coiDays, setCoiDays] = useState(String(s.coiDays));
  const [replyTo, setReplyTo] = useState(s.replyTo || '');
  const changed = threshold !== String(s.threshold) || coiDays !== String(s.coiDays) || replyTo !== (s.replyTo || '');
  const toggle = async (key, on, title, text, label) => {
    if (on || await ask({ title, text, yes: 'Turn on' })) act({ action: 'settings', [key]: !on }, on ? `${label} off: nothing goes to vendors` : `${label} on`);
  };
  return html`
    <section class="card">
      <div class="card-header"><h3 class="card-title">Asking vendors</h3></div>
      <div class="vd-body">
        <div class="vd-switch">
          <div><strong>W-9 requests through Mercury</strong>
            <p class="text-sm text-muted">When a sub is first paid by ACH or check, or lands on an open job, without a W-9: Mercury emails them its own page for their bank details and W-9. Again a week later if it isn’t done, three times at most. Mercury keeps the form; the site never sees a tax ID.</p></div>
          <div class="vd-actions">
            <button class="btn btn-ghost btn-sm" disabled=${!!busy || !data.health.mercury} onClick=${() => act({ action: 'preview', kind: 'w9' }, (j) => `Mercury emailed ${j.sentTo} what a vendor gets`)}>Send it to me</button>
            <button class="btn ${s.autoW9 ? 'btn-secondary' : 'btn-primary'} btn-sm" disabled=${!!busy} onClick=${() => toggle('autoW9', s.autoW9, 'Ask subs for W-9s automatically?', `${data.vendors.filter((v) => v.needs.w9 && v.email).length} sub${data.vendors.filter((v) => v.needs.w9 && v.email).length === 1 ? '' : 's'} get Mercury’s email within 15 minutes.`, 'W-9 requests')}>${s.autoW9 ? 'Turn off' : 'Turn on'}</button>
          </div>
        </div>
        <div class="vd-switch">
          <div><strong>Insurance certificate requests</strong>
            <p class="text-sm text-muted">When a sub is on an open job without a current certificate, or theirs ends within ${s.coiDays} days: an email from SOARD with their own upload link. Again a week later, three times at most. Whoever’s on site without one shows in the Finance channel either way.</p></div>
          <div class="vd-actions">
            <button class="btn btn-ghost btn-sm" disabled=${!!busy || !data.health.email} onClick=${() => act({ action: 'preview', kind: 'coi' }, (j) => `Sent to ${j.sentTo}`)}>Send it to me</button>
            <button class="btn ${s.autoCoi ? 'btn-secondary' : 'btn-primary'} btn-sm" disabled=${!!busy} onClick=${() => toggle('autoCoi', s.autoCoi, 'Ask subs for insurance certificates automatically?', `${data.vendors.filter((v) => v.needs.coi && v.email).length} sub${data.vendors.filter((v) => v.needs.coi && v.email).length === 1 ? '' : 's'} get the email within 15 minutes.`, 'Insurance requests')}>${s.autoCoi ? 'Turn off' : 'Turn on'}</button>
          </div>
        </div>
      </div>
    </section>
    <section class="card">
      <div class="card-header"><h3 class="card-title">Details</h3></div>
      <div class="vd-body">
        <div class="vd-grid">
          <label class="vd-field"><span>1099 line ($)</span><input class="form-input" type="number" min="0" step="1" value=${threshold} onInput=${(e) => setThreshold(e.target.value)} /></label>
          <label class="vd-field"><span>Ask for a renewed certificate (days before it ends)</span><input class="form-input" type="number" min="7" max="90" value=${coiDays} onInput=${(e) => setCoiDays(e.target.value)} /></label>
          <label class="vd-field"><span>Replies to insurance emails go to</span><input class="form-input" type="email" placeholder="No one (replies aren’t read)" value=${replyTo} onInput=${(e) => setReplyTo(e.target.value)} /></label>
        </div>
        <div class="vd-actions"><button class="btn btn-primary btn-sm" disabled=${!!busy || !changed} onClick=${() => act({ action: 'settings', threshold: Number(threshold), coiDays: Number(coiDays), replyTo }, 'Saved')}>Save</button></div>
      </div>
    </section>`;
}
