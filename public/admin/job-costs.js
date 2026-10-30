/**
 * Admin → Job Costs: every makeover's spending against its budget, live
 * ===========================================================================
 * Over /api/job-costs-admin (functions/api/_spend.js, _job-ledger.js).
 * Nothing here has to be pressed: Mercury charges arrive on their own,
 * JobTread bills replace them on their own. People use this page to look,
 * and to sort the few charges the site couldn't place.
 *
 * Tabs (#job-costs/<tab>, or #job-costs/<jobId> for one job):
 *   Jobs       each active job: spent and forecast against budget; open one
 *              for its cost codes and every charge and bill
 *   Charges    every Mercury charge: which job, the store or operating;
 *              the ones to sort first
 *   Rules      vendor → cost code (or store, or operating), learned from
 *              each sort and read by the DataX Receipt Processor
 *   Bills      subs' bills waiting for approval (the DataX Bill Approver
 *              emails Holly; staff can decide here too), being paid, paid
 *   Close-outs every finished makeover's final numbers, and what each cost
 *              code really costs per room (the budget builder's history)
 *   Setup      which Mercury card or account is the store's, Mercury
 *              categories, the receipt inbox, card limits from budgets
 *   Ramp bills the old one-line "Makeover COGS" bills, split by code
 * An open job also has the budget builder: a budget from past close-outs
 * for what it will build, beside its JobTread budget.
 */

import { h, htm, useState, useEffect } from './vendor.js';
import { ask } from './ask.js';

const html = htm.bind(h);
const API = '/api/job-costs-admin';
const TABS = [['jobs', 'Jobs'], ['charges', 'Charges'], ['bills', 'Bills'], ['closeouts', 'Close-outs'], ['rules', 'Rules'], ['setup', 'Setup'], ['ramp', 'Ramp bills']];
const BUCKET_NAMES = { job: 'Makeover', store: 'Sunny & Ranney store', operating: 'Operating' };
const HOW = { person: 'the cardholder’s job', build: 'the job in Build', staff: 'picked by staff', bill: 'from its JobTread bill', rule: 'vendor rule', card: 'the store’s card', account: 'the account', refund: 'the charge it refunds' };

async function call(body, { setup = false } = {}) {
  let r;
  try {
    r = await fetch(API + (body ? '' : setup ? '?setup=1' : ''), body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' });
  } catch {
    return { success: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  return j;
}

// Budgets and totals in whole dollars; a single charge to the cent
const usd = (c) => (Math.round(Number(c || 0) / 100)).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdCents = (c) => (Number(c || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const dash = (c) => (c ? usd(c) : '–');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const person = (email) => (email ? email.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : '');
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const ODD_KIND = { duplicate: 'Charged twice?', outlier: 'Bigger than usual', subscription: 'New monthly charge', category: 'Merchant type' };

const CSS = `
.jc { display: grid; gap: 1rem; }
.jc-jobs { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); gap: .75rem; }
.jc-job { display: grid; gap: .55rem; padding: 1rem 1.1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); text-align: left; font: inherit; color: inherit; cursor: pointer; box-shadow: var(--shadow-xs); }
.jc-job:hover { border-color: var(--color-border-strong); }
.jc-job:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.jc-job h3 { margin: 0; font-size: var(--fs-md); font-weight: 600; display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.jc-nums { display: flex; flex-wrap: wrap; gap: .2rem .9rem; font-size: var(--fs-xs); color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
.jc-nums b { color: var(--color-text); font-weight: 600; }
.jc-bar { position: relative; height: 10px; border-radius: 999px; background: var(--tone-neutral-bg); overflow: hidden; }
.jc-bar > span { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 999px; }
.jc-bar .is-billed { background: var(--color-text); }
.jc-bar .is-pending { background: var(--color-primary); }
.jc-bar .is-committed { background: repeating-linear-gradient(45deg, var(--tone-neutral-dot) 0 4px, transparent 4px 7px); }
.jc-bar.is-over { box-shadow: inset 0 0 0 2px var(--tone-warn-dot); }
.jc-key { display: flex; flex-wrap: wrap; gap: .3rem 1rem; font-size: var(--fs-2xs); color: var(--color-text-muted); }
.jc-key i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: .3rem; vertical-align: -1px; }
.jc-table-wrap { overflow-x: auto; }
.jc-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.jc-table th { text-align: right; font-size: var(--fs-2xs); font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: .04em; padding: .5rem .6rem; border-bottom: 1px solid var(--color-border); white-space: nowrap; }
.jc-table th:first-child, .jc-table td:first-child { text-align: left; }
.jc-table td { text-align: right; padding: .55rem .6rem; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
.jc-table tr.is-over td { background: var(--tone-warn-surface); }
.jc-table tfoot td { font-weight: 700; border-bottom: none; }
.jc-charge { display: grid; grid-template-columns: 4.2rem minmax(0, 1fr) auto; gap: .35rem .9rem; align-items: center; padding: .75rem 1.1rem; border-bottom: 1px solid var(--color-border); }
.jc-charge:last-child { border-bottom: none; }
.jc-charge__date { font-size: var(--fs-xs); color: var(--color-text-muted); }
.jc-charge__what { min-width: 0; }
.jc-charge__what strong { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jc-charge__meta { font-size: var(--fs-xs); color: var(--color-text-secondary); display: flex; flex-wrap: wrap; gap: .25rem .5rem; align-items: center; }
.jc-charge__amt { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
.jc-charge__amt.is-refund { color: var(--tone-success-fg); }
.jc-sort { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.jc-sort .form-input { width: auto; max-width: 100%; min-height: 36px; }
.jc-sort label { display: flex; gap: .35rem; align-items: center; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.jc-body { padding: 1rem 1.25rem; }
.jc-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: .75rem 1.25rem; }
.jc-field { display: grid; gap: .3rem; }
.jc-field > span { font-size: var(--fs-xs); font-weight: 600; }
.jc-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.jc-split { display: grid; gap: .25rem; margin: .35rem 0 0; padding: 0; list-style: none; font-size: var(--fs-xs); }
.jc-mono { font-variant-numeric: tabular-nums; }
@media (max-width: 640px) {
  .jc-charge { grid-template-columns: minmax(0, 1fr) auto; padding: .75rem .85rem; }
  .jc-charge__date { grid-column: 1 / -1; }
  .jc-sort { grid-column: 1 / -1; }
  .jc-sort .form-input, .jc-sort .btn { flex: 1 1 100%; min-height: 44px; }
  .jc-body { padding: .85rem; }
  .jc-table .jc-hide-sm { display: none; }
}
`;
let styled = false;
function useStyles() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.module = 'job-costs';
  el.textContent = CSS;
  document.head.append(el);
}

function placeOf(hash = location.hash) {
  const parts = String(hash).replace(/^#/, '').split('/').slice(1).filter(Boolean).map((x) => decodeURIComponent(x));
  if (!parts[0]) return { tab: 'jobs', job: null };
  // #job-costs/closeouts/<jobId>: one close-out (Slack's button)
  if (TABS.some(([k]) => k === parts[0])) return { tab: parts[0], job: parts[0] === 'closeouts' ? parts[1] || null : null };
  return { tab: 'jobs', job: parts[0] };
}
function go(tab, job = null) {
  const next = `#job-costs${tab && tab !== 'jobs' ? `/${tab}` : ''}${job ? `/${encodeURIComponent(job)}` : ''}`;
  if (location.hash !== next) history.pushState(null, '', next);
}

export function JobCosts({ addToast = () => {} }) {
  useStyles();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [place, setPlace] = useState(placeOf);
  const [busy, setBusy] = useState(null);

  const load = async (opts) => {
    const j = await call(null, opts);
    if (!j.success) { setErr(j.error || 'Could not load job costs'); return; }
    setErr(null);
    setData((d) => ({ ...(d || {}), ...j }));
  };
  useEffect(() => { load({ setup: place.tab === 'setup' || place.tab === 'bills' }); }, [place.tab]);
  // Live: charges arrive by the second, so look again every 15 seconds while the tab is open
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden && !busy) load(); }, 15000);
    return () => clearInterval(t);
  }, [busy]);
  useEffect(() => {
    const on = () => setPlace(placeOf());
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('hashchange', on); };
  }, []);
  const open = (tab, job = null) => { go(tab, job); setPlace({ tab, job }); };

  const act = async (body, done) => {
    setBusy(body.action);
    const j = await call(body);
    setBusy(null);
    if (!j.success) { addToast(j.error || 'That did not work', 'error'); return null; }
    setData((d) => ({ ...(d || {}), ...j }));
    if (done) addToast(typeof done === 'function' ? done(j) : done, 'success');
    return j;
  };

  if (err && !data) {
    return html`<div class="notice notice--danger"><div class="notice__body"><strong>Couldn't load job costs:</strong> ${err}</div>
      <div class="notice__actions"><button class="btn btn-ghost" onClick=${() => load()}>Try again</button></div></div>`;
  }
  if (!data) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;

  const unsorted = data.charges.filter((c) => !c.bucket && !c.billId && c.cents > 0 && c.status !== 'cancelled' && c.status !== 'failed').length;
  const proposed = data.recode.filter((r) => r.state === 'proposed').length;
  const waiting = (data.bills || []).filter((b) => ['waiting', 'second'].includes(b.approval?.state) || b.approval?.payState === 'failed').length;
  const counts = { charges: unsorted + (data.odd || []).length, ramp: proposed, bills: waiting };
  const job = place.tab === 'jobs' && place.job ? data.ledgers.find((l) => l.jobId === place.job) : null;

  return html`
    <div class="jc">
      <div class="page-header">
        <div>
          <h2>Job costs</h2>
          <p class="page-sub">Every makeover’s spending against its JobTread budget, as it happens. Card charges show the moment they’re swiped; the receipt’s JobTread bill replaces them with exact cost codes.</p>
        </div>
      </div>
      <${Health} h=${data.health} />
      <div class="seg" role="tablist" aria-label="Job costs">
        ${TABS.map(([k, label]) => html`<button role="tab" aria-selected=${place.tab === k && !(k === 'jobs' && job)} onClick=${() => open(k)}>${label}${counts[k] ? html` <span class="count ${k === 'charges' || k === 'bills' ? 'is-warn' : ''}">${counts[k]}</span>` : ''}</button>`)}
      </div>
      ${job ? html`<${JobDetail} l=${job} data=${data} act=${act} busy=${busy} onBack=${() => open('jobs')} />`
        : place.tab === 'jobs' && place.job ? html`<div class="notice"><div class="notice__body">That job isn’t open any more, or hasn’t been read from JobTread yet. Closed jobs are under Close-outs.</div><div class="notice__actions"><button class="btn btn-ghost" onClick=${() => open('jobs')}>All jobs</button><button class="btn btn-ghost" onClick=${() => open('closeouts', place.job)}>Its close-out</button></div></div>`
        : place.tab === 'bills' ? html`<${Bills} data=${data} act=${act} busy=${busy} />`
        : place.tab === 'closeouts' ? html`<${Closeouts} data=${data} id=${place.job} onOpen=${(id) => open('closeouts', id)} />`
        : place.tab === 'jobs' ? html`<${Jobs} data=${data} onOpen=${(id) => open('jobs', id)} />`
        : place.tab === 'charges' ? html`<${Charges} data=${data} act=${act} busy=${busy} />`
        : place.tab === 'rules' ? html`<${Rules} data=${data} act=${act} busy=${busy} />`
        : place.tab === 'setup' ? html`<${Setup} data=${data} act=${act} busy=${busy} />`
        : html`<${Ramp} data=${data} act=${act} busy=${busy} />`}
    </div>`;
}

/** What isn't working, in sentences; nothing when all is well */
function Health({ h }) {
  const notes = [];
  if (!h.mercury) {
    notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>Mercury isn’t connected yet.</strong> Add SOARD’s Mercury API token in Cloudflare (soard-site → Settings → Variables) as MERCURY_API_TOKEN. The site registers its own webhook with it within a few minutes. Until then, job costs come from JobTread bills only.</div></div>`);
  } else {
    if (h.webhook.error) notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>Mercury’s webhook couldn’t be set up:</strong> ${h.webhook.error}. Charges still arrive every 2 minutes from the catch-up read.</div></div>`);
    if (h.lastCatchUpError && (!h.lastCatchUp || Date.parse(h.lastCatchUpError.at) > Date.parse(h.lastCatchUp.at))) {
      notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>Mercury can’t be read:</strong> ${h.lastCatchUpError.error} (${ago(h.lastCatchUpError.at)}).</div></div>`);
    }
    if (h.lastWriteError && !(Date.parse(h.lastWriteOkAt || 0) > Date.parse(h.lastWriteError.at))) {
      notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>Notes aren’t reaching Mercury.</strong> ${h.lastWriteError.error} Job costs here are unaffected.</div></div>`);
    }
  }
  if (h.jobFieldsError) notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>The job-cost fields on JobTread jobs aren’t updating:</strong> ${h.jobFieldsError.message} (${ago(h.jobFieldsError.at)}). Everything here is unaffected.</div></div>`);
  if (!h.jobtread) notes.push(html`<div class="notice notice--danger"><div class="notice__body"><strong>JobTread isn’t connected</strong> (JOBTREAD_GRANT_KEY), so budgets and bills can’t be read.</div></div>`);
  if (h.closeouts?.error) notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>Close-outs couldn’t be read from JobTread:</strong> ${h.closeouts.error}</div></div>`);
  if (h.billPay?.error) notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>Paying and recording bills stopped:</strong> ${h.billPay.error}</div></div>`);
  const line = html`<p class="sec-head__hint" style="margin: 0;">
    ${h.mercury ? html`<span class="dot ${h.webhook.lastEventAt && Date.now() - Date.parse(h.webhook.lastEventAt) < 86400e3 * 3 ? 'dot--on' : ''}" /> Mercury: last charge event ${ago(h.webhook.lastEventAt)} · checked ${ago(h.lastCatchUp?.at)} · ` : ''}
    Ledgers rebuilt ${ago(h.lastRebuildAt)} · Receipt agent last asked ${ago(h.agentUsedAt)}</p>`;
  return html`${notes}${line}`;
}

function Bar({ t }) {
  const max = Math.max(t.budget, t.forecast, 1);
  const w = (n) => `${Math.min(100, (n / max) * 100)}%`;
  return html`<div class="jc-bar ${t.budget && t.forecast > t.budget ? 'is-over' : ''}" role="img" aria-label=${`${usd(t.forecast)} forecast of ${usd(t.budget)} budget`}>
    <span class="is-committed" style=${`width: ${w(t.billed + t.pending + t.committed)}`} />
    <span class="is-pending" style=${`width: ${w(t.billed + t.pending)}`} />
    <span class="is-billed" style=${`width: ${w(t.billed)}`} />
  </div>`;
}

const Key = () => html`<div class="jc-key"><span><i style="background: var(--color-text)" />Billed</span><span><i style="background: var(--color-primary)" />Spent, waiting for its bill</span><span><i style="background: repeating-linear-gradient(45deg, var(--tone-neutral-dot) 0 3px, transparent 3px 5px)" />Still to come on approved orders</span></div>`;

function Jobs({ data, onOpen }) {
  const list = [...data.ledgers].sort((a, b) => (pct(b.totals?.forecast, b.totals?.budget) ?? -1) - (pct(a.totals?.forecast, a.totals?.budget) ?? -1));
  if (!list.length) return html`<div class="empty">No open jobs yet. They show up here from JobTread within 15 minutes.</div>`;
  return html`
    <${Key} />
    <div class="jc-jobs">
      ${list.map((l) => {
        const t = l.totals || { budget: 0, forecast: 0, billed: 0, pending: 0, committed: 0 };
        const p = pct(t.forecast, t.budget);
        return html`<button class="jc-job" key=${l.jobId} onClick=${() => onOpen(l.jobId)}>
          <h3>${l.name}${l.status ? html`<span class="tag">${l.status}</span>` : ''}${p != null && p >= 100 ? html`<span class="tag tag--warn">Over budget</span>` : p != null && p >= 80 ? html`<span class="tag tag--warn">${p}%</span>` : ''}</h3>
          <${Bar} t=${t} />
          <div class="jc-nums">
            <span><b>${usd(t.billed + t.pending)}</b> spent</span>
            <span><b>${usd(t.forecast)}</b> forecast</span>
            <span>${t.budget ? html`of <b>${usd(t.budget)}</b> budget` : 'no budget in JobTread yet'}</span>
            ${t.pending ? html`<span>${usd(t.pending)} waiting for receipts</span>` : ''}
          </div>
        </button>`;
      })}
    </div>`;
}

function JobDetail({ l, data, act, busy, onBack }) {
  const codeName = (id) => (id === 'uncoded' ? 'Not coded yet' : data.codes.find((c) => c.id === id)?.name || 'Other code');
  const t = l.totals || {};
  const charges = data.charges.filter((c) => c.jobId === l.jobId);
  return html`
    <div class="jc-row"><button class="btn btn-ghost btn-sm" onClick=${onBack}>← All jobs</button></div>
    <section class="card" style="padding: 0;">
      <div class="sec-head"><h3>${l.name}</h3><span class="sec-head__hint">${l.status || ''}${l.address ? ` · ${l.address}` : ''} · updated ${ago(l.updatedAt)}</span></div>
      <div class="jc-body" style="display: grid; gap: .6rem;"><${Bar} t=${t} /><${Key} /></div>
      <div class="jc-table-wrap"><table class="jc-table">
        <thead><tr><th>Cost code</th><th>Budget</th><th>Billed</th><th>Waiting for bill</th><th class="jc-hide-sm">Still to come</th><th>Forecast</th><th>Left</th></tr></thead>
        <tbody>${(l.rows || []).map((r) => html`<tr class=${r.budget && r.forecast > r.budget ? 'is-over' : ''}>
          <td>${codeName(r.codeId)}</td><td>${dash(r.budget)}</td><td>${dash(r.billed)}</td><td>${dash(r.pending)}</td>
          <td class="jc-hide-sm">${dash(r.committed)}</td><td>${usd(r.forecast)}</td><td>${r.budget ? usd(r.budget - r.forecast) : '–'}</td></tr>`)}</tbody>
        <tfoot><tr><td>Total</td><td>${usd(t.budget)}</td><td>${usd(t.billed)}</td><td>${usd(t.pending)}</td><td class="jc-hide-sm">${usd(t.committed)}</td><td>${usd(t.forecast)}</td><td>${usd((t.budget || 0) - (t.forecast || 0))}</td></tr></tfoot>
      </table></div>
    </section>
    <section class="card" style="padding: 0;">
      <div class="sec-head"><h3>Mercury charges and payments <span class="count">${charges.length}</span></h3><span class="sec-head__hint">Card charges and payments to subs. Bills paid another way are in the table above.</span></div>
      ${charges.length ? charges.map((c) => html`<${ChargeRow} key=${c.id} c=${c} data=${data} act=${act} busy=${busy} />`) : html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">No charges on this job yet.</p></div>`}
    </section>
    <${BudgetBuilder} jobId=${l.jobId} data=${data} act=${act} busy=${busy} />`;
}

/** One charge, with what it is and (when unsorted, or asked) the picker */
function ChargeRow({ c, data, act, busy }) {
  const [editing, setEditing] = useState(false);
  const job = data.jobs.find((j) => j.id === c.jobId) || data.ledgers.find((l) => l.jobId === c.jobId);
  const code = data.codes.find((x) => x.id === c.costCodeId);
  const live = c.status === 'pending' || c.status === 'sent';
  const where = c.bucket === 'job' || c.jobId
    ? html`<span class="tag">${job?.name || 'A job'}</span>${c.jobHow && !['bill', 'staff'].includes(c.jobHow) ? html`<span title=${`Guessed from ${HOW[c.jobHow] || c.jobHow}; its JobTread bill will settle it`}>(guessed)</span>` : ''}`
    : c.bucket ? html`<span class="tag">${BUCKET_NAMES[c.bucket]}</span>` : html`<span class="tag tag--warn">Not sorted</span>`;
  return html`<div class="jc-charge">
    <span class="jc-charge__date">${day(c.createdAt)}</span>
    <div class="jc-charge__what">
      <strong>${c.vendor}</strong>
      <div class="jc-charge__meta">
        ${where}
        ${code ? html`<span>${code.name}</span>` : ''}
        ${c.billId ? html`<span class="tag tag--success">Billed in JobTread</span>` : c.bucket === 'job' ? html`<span class="tag">${c.kind === 'outgoingPayment' ? 'Paid, waiting for the bill' : 'Waiting for receipt'}</span>` : ''}
        ${c.jobHow === 'refund' ? html`<span>Refund, back on the job it came from</span>` : ''}
        ${c.status === 'pending' ? html`<span class="tag tag--info">Pending</span>` : !live ? html`<span class="tag">${c.status}</span>` : ''}
        ${c.email ? html`<span>${person(c.email)}</span>` : ''}
        ${c.link ? html`<a href=${c.link} target="_blank" rel="noopener">Mercury</a>` : ''}
        ${!c.billId && live && !editing && c.bucket ? html`<button class="btn btn-ghost btn-sm" onClick=${() => setEditing(true)}>Change</button>` : ''}
      </div>
    </div>
    <span class="jc-charge__amt ${c.cents < 0 ? 'is-refund' : ''}">${usdCents(c.cents)}</span>
    ${(editing || (!c.bucket && !c.billId && live && c.cents > 0)) && html`<${SortPicker} c=${c} data=${data} act=${act} busy=${busy} onDone=${() => setEditing(false)} />`}
  </div>`;
}

function SortPicker({ c, data, act, busy, onDone }) {
  const [choice, setChoice] = useState(c.jobId ? `job:${c.jobId}` : c.bucket || '');
  const [code, setCode] = useState(c.costCodeId || '');
  const [remember, setRemember] = useState(true);
  const isJob = choice.startsWith('job:');
  const save = async () => {
    const body = isJob
      ? { action: 'sort', chargeId: c.id, bucket: 'job', jobId: choice.slice(4), costCodeId: code || null, remember: remember && !!code }
      : { action: 'sort', chargeId: c.id, bucket: choice, remember };
    if (await act(body, `${c.vendor}: sorted`)) onDone();
  };
  return html`<div class="jc-sort">
    <select class="form-input" aria-label="What this charge was for" value=${choice} onChange=${(e) => setChoice(e.target.value)}>
      <option value="" disabled>What was it for?</option>
      <optgroup label="A makeover">${data.jobs.map((j) => html`<option value=${`job:${j.id}`}>${j.name}</option>`)}</optgroup>
      <option value="store">Sunny & Ranney store</option>
      <option value="operating">Operating (running SOARD)</option>
    </select>
    ${isJob && html`<select class="form-input" aria-label="Cost code" value=${code} onChange=${(e) => setCode(e.target.value)}>
      <option value="">Cost code (the receipt decides)</option>
      ${data.codes.map((x) => html`<option value=${x.id}>${x.name}</option>`)}
    </select>`}
    ${(!isJob || code) && choice && html`<label><input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.target.checked)} /> Always for ${c.vendor}</label>`}
    <button class="btn btn-primary btn-sm" disabled=${!choice || !!busy} onClick=${save}>${busy === 'sort' ? 'Saving…' : 'Save'}</button>
    ${c.bucket && html`<button class="btn btn-ghost btn-sm" onClick=${onDone}>Cancel</button>`}
  </div>`;
}

function Charges({ data, act, busy }) {
  const [show, setShow] = useState('sort');
  const [q, setQ] = useState('');
  const live = (c) => c.status === 'pending' || c.status === 'sent';
  const twoDays = Date.now() - 2 * 86400e3;
  const odd = data.odd || [];
  const oddIds = new Set(odd.flatMap((o) => o.chargeIds));
  useEffect(() => { if (/[?&]odd=1/.test(location.hash) && odd.length) setShow('odd'); }, []);
  const filters = {
    sort: (c) => live(c) && !c.bucket && !c.billId && c.cents > 0,
    receipt: (c) => live(c) && c.bucket === 'job' && !c.billId && Date.parse(c.createdAt) < twoDays,
    odd: (c) => oddIds.has(c.id),
    job: (c) => c.bucket === 'job' || !!c.billId,
    store: (c) => c.bucket === 'store',
    operating: (c) => c.bucket === 'operating',
    all: () => true,
  };
  const labels = [['sort', 'To sort'], ['receipt', 'No receipt after 2 days'], ...(odd.length || show === 'odd' ? [['odd', 'Odd']] : []), ['job', 'Makeovers'], ['store', 'Store'], ['operating', 'Operating'], ['all', 'All']];
  const rows = data.charges.filter(filters[show]).filter((c) => !q || c.vendor.toLowerCase().includes(q.toLowerCase()));
  const total = rows.reduce((n, c) => n + c.cents, 0);
  return html`
    <div class="jc-row">
      <div class="pill-row">${labels.map(([k, label]) => {
        const n = data.charges.filter(filters[k]).length;
        return html`<button class="pill" aria-pressed=${show === k} onClick=${() => setShow(k)}>${label}${k !== 'all' && n ? html`<span class="count ${k === 'sort' || k === 'receipt' || k === 'odd' ? 'is-warn' : ''}">${n}</span>` : ''}</button>`;
      })}</div>
      <input class="form-input" type="search" placeholder="Search vendors" aria-label="Search vendors" style="flex: 1 1 12rem; width: auto;" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>
    <section class="card" style="padding: 0;">
      <div class="sec-head"><h3>${labels.find(([k]) => k === show)[1]} <span class="count">${rows.length}</span></h3><span class="sec-head__hint">${rows.length ? `${usdCents(total)} · last 90 days` : ''}</span>
        ${show === 'receipt' && html`<p class="sec-head__desc">A photo of the receipt in Mercury’s app is enough: the site sends it to ${data.config.receiptInbox} for the Receipt Processor. Or forward the receipt there. The JobTread bill clears it from this list.</p>`}
        ${show === 'odd' && html`<p class="sec-head__desc">Worth a second look. Each was posted once in the Finance channel. Say it’s fine and it won’t come up again.</p>`}
        ${show === 'sort' && html`<p class="sec-head__desc">Charges the site couldn’t place: the cardholder is on more than one job, or isn’t on any. Pick once with “Always for…” and that vendor sorts itself next time.</p>`}</div>
      ${show === 'odd' ? odd.map((o) => html`<div class="jc-charge" key=${o.key}>
          <span class="jc-charge__date">${day(o.foundAt)}</span>
          <div class="jc-charge__what"><strong>${o.vendor}</strong><div class="jc-charge__meta"><span class="tag tag--warn">${ODD_KIND[o.kind] || o.kind}</span><span>${o.detail}</span></div></div>
          <span class="jc-charge__amt">${usdCents(o.cents)}</span>
          <div class="jc-sort"><button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => act({ action: 'odd-clear', key: o.key }, `${o.vendor}: checked`)}>It’s fine</button></div>
        </div>`)
      : rows.length ? rows.slice(0, 300).map((c) => html`<${ChargeRow} key=${c.id} c=${c} data=${data} act=${act} busy=${busy} />`)
        : html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">${show === 'sort' ? 'Nothing to sort. Every charge has a home.' : show === 'receipt' ? 'Every makeover charge older than 2 days has its JobTread bill.' : 'No charges here.'}</p></div>`}
    </section>`;
}

function Rules({ data, act, busy }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('code');
  const [code, setCode] = useState('');
  const codeName = (id) => data.codes.find((c) => c.id === id)?.name || 'A cost code';
  const add = async () => {
    if (await act({ action: 'rule-save', name: name.trim(), kind, costCodeId: kind === 'code' ? code : null }, 'Rule saved')) { setName(''); setCode(''); }
  };
  return html`
    <section class="card" style="padding: 0;">
      <div class="sec-head"><h3>Vendor rules <span class="count">${data.rules.length}</span></h3>
        <p class="sec-head__desc">A vendor’s charges go straight to its cost code, the store or operating. The DataX Receipt Processor reads these too when it codes a receipt. “Always for…” on a charge adds one here.</p></div>
      <div class="jc-body" style="border-bottom: 1px solid var(--color-border);">
        <div class="jc-row">
          <input class="form-input" style="flex: 1 1 14rem; width: auto;" placeholder="Vendor, as it shows on the card or in JobTread" value=${name} onInput=${(e) => setName(e.target.value)} />
          <select class="form-input" style="width: auto;" aria-label="Kind" value=${kind} onChange=${(e) => setKind(e.target.value)}>
            <option value="code">Makeover vendor</option><option value="store">Sunny & Ranney store</option><option value="operating">Operating</option>
          </select>
          ${kind === 'code' && html`<select class="form-input" style="width: auto;" aria-label="Cost code" value=${code} onChange=${(e) => setCode(e.target.value)}>
            <option value="" disabled>Cost code</option>${data.codes.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select>`}
          <button class="btn btn-primary" disabled=${!name.trim() || (kind === 'code' && !code) || !!busy} onClick=${add}>Add</button>
        </div>
      </div>
      <div class="jc-table-wrap"><table class="jc-table">
        <thead><tr><th>Vendor</th><th style="text-align: left;">Goes to</th><th class="jc-hide-sm" style="text-align: left;">Added by</th><th><span class="sr-only">Remove</span></th></tr></thead>
        <tbody>${data.rules.map((r) => html`<tr key=${r.vendor}>
          <td>${r.name}</td>
          <td style="text-align: left;">${r.kind === 'code' ? codeName(r.costCodeId) : BUCKET_NAMES[r.kind]}</td>
          <td class="jc-hide-sm" style="text-align: left;">${r.source === 'seed' ? 'Built in' : person(r.by) || 'Staff'}</td>
          <td><button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${async () => { if (await ask({ title: `Remove the rule for ${r.name}?`, text: 'Its charges will be guessed again from the cardholder’s job.', yes: 'Remove', danger: true })) act({ action: 'rule-delete', vendor: r.vendor }, 'Rule removed'); }}>Remove</button></td>
        </tr>`)}</tbody>
      </table></div>
    </section>`;
}

function Setup({ data, act, busy }) {
  const cfg = data.config;
  const [acc, setAcc] = useState(cfg.accountBuckets);
  const [cards, setCards] = useState(cfg.cardBuckets);
  const [cats, setCats] = useState(cfg.categories);
  const [inbox, setInbox] = useState(cfg.receiptInbox || '');
  useEffect(() => { setAcc(cfg.accountBuckets); setCards(cfg.cardBuckets); setCats(cfg.categories); setInbox(cfg.receiptInbox || ''); }, [JSON.stringify(cfg)]);
  const dirty = JSON.stringify([acc, cards, cats, inbox]) !== JSON.stringify([cfg.accountBuckets, cfg.cardBuckets, cfg.categories, cfg.receiptInbox || '']);
  if (!data.health.mercury) return html`<div class="empty">Setup needs Mercury connected (MERCURY_API_TOKEN in Cloudflare).</div>`;
  if (!data.accounts) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;
  const pick = (value, onChange, label, { none = 'Decide by vendor and cardholder' } = {}) => html`
    <select class="form-input" aria-label=${label} value=${value || ''} onChange=${(e) => onChange(e.target.value || undefined)}>
      <option value="">${none}</option>
      ${Object.entries(BUCKET_NAMES).map(([k, n]) => html`<option value=${k}>All ${n.toLowerCase()}</option>`)}
    </select>`;
  const set = (setter) => (id) => (v) => setter((m) => { const n = { ...m }; if (v) n[id] = v; else delete n[id]; return n; });
  const errorOf = (x) => (x && x.error ? html`<p class="sec-head__hint">Mercury: ${x.error}</p>` : null);
  return html`
    <section class="card" style="padding: 0;">
      <div class="sec-head"><h3>Separating the store and operating</h3>
        <p class="sec-head__desc">Simplest: give Sunny & Ranney its own Mercury card (or its own checking account with a debit card) and mark it here. Everything on it is the store’s, no sorting. Everything else is a makeover or operating, by vendor rules and the cardholder’s job.</p></div>
      <div class="jc-body jc-grid2">
        <div class="jc-field"><span>Cards</span>${errorOf(data.cards)}
          ${Array.isArray(data.cards) && data.cards.filter((c) => c.status === 'active').map((c) => html`<label class="jc-field" key=${c.id}><span style="font-weight: 400;">${c.name || 'Card'} ·· ${c.lastFour}${c.nickname ? ` (${c.nickname})` : ''}</span>${pick(cards[c.id], set(setCards)(c.id), `Card ending ${c.lastFour}`)}</label>`)}
        </div>
        <div class="jc-field"><span>Accounts</span>${errorOf(data.accounts)}
          ${Array.isArray(data.accounts) && data.accounts.map((a) => html`<label class="jc-field" key=${a.id}><span style="font-weight: 400;">${a.name}${a.lastFour ? ` ·· ${a.lastFour}` : ''}</span>${pick(acc[a.id], set(setAcc)(a.id), `Account ${a.name}`)}</label>`)}
        </div>
      </div>
      <div class="sec-head" style="border-top: 1px solid var(--color-border);"><h3>Mercury categories</h3>
        <p class="sec-head__desc">Each sorted charge gets this category in Mercury, so Mercury Books files it the same way. Makeover charges get theirs once the JobTread bill turns up.</p></div>
      <div class="jc-body jc-grid2">${errorOf(data.categories)}
        ${Array.isArray(data.categories) && Object.entries(BUCKET_NAMES).map(([k, n]) => html`<label class="jc-field" key=${k}><span>${n}</span>
          <select class="form-input" value=${cats[k] || ''} onChange=${(e) => setCats((m) => ({ ...m, [k]: e.target.value || null }))}>
            <option value="">Leave Mercury’s category alone</option>${data.categories.map((c) => html`<option value=${c.id}>${c.name}</option>`)}
          </select></label>`)}
      </div>
      <div class="sec-head" style="border-top: 1px solid var(--color-border);"><h3>Receipt inbox</h3>
        <p class="sec-head__desc">Where receipt photos from Mercury’s app are sent for the Receipt Processor. It forwards to DataX from there.</p></div>
      <div class="jc-body"><label class="jc-field"><span>Email</span><input class="form-input" type="email" value=${inbox} onInput=${(e) => setInbox(e.target.value)} style="max-width: 24rem;" /></label></div>
      <div class="jc-body" style="border-top: 1px solid var(--color-border);">
        <div class="jc-row"><button class="btn btn-primary" disabled=${!dirty || !!busy} onClick=${() => act({ action: 'setup', accountBuckets: acc, cardBuckets: cards, categories: cats, receiptInbox: inbox }, 'Saved. The last 30 days are sorted again in the next 2 minutes.')}>${busy === 'setup' ? 'Saving…' : 'Save'}</button>
        ${dirty && html`<span class="sec-head__hint">Unsaved</span>`}</div>
      </div>
    </section>
    <${Caps} data=${data} act=${act} busy=${busy} />`;
}

function Caps({ data, act, busy }) {
  const on = data.config.caps;
  const caps = data.caps || [];
  return html`<section class="card" style="padding: 0;">
    <div class="sec-head"><h3>Card limits from budgets</h3>
      <p class="sec-head__desc">Each makeover card’s monthly limit follows what its holder’s jobs have left in budget, plus $500, never under $1,000. It only stops runaway spending; the 80% and 100% Slack alerts are the everyday check. Store and operating cards aren’t touched.</p></div>
    <div class="jc-body" style="display: grid; gap: .75rem;">
      <div class="status-head"><div class="status-head__main"><span class="dot ${on ? 'dot--on' : ''}" /><div>
        <h3>${on ? 'On: limits follow budgets' : 'Off: limits stay as set in Mercury'}</h3>
        ${data.health.lastCaps && html`<p class="status-head__text">Last set ${ago(data.health.lastCaps.at)}: ${data.health.lastCaps.set} card${data.health.lastCaps.set === 1 ? '' : 's'} changed${data.health.lastCaps.error ? `. Mercury said: ${data.health.lastCaps.error}` : ''}</p>`}
      </div></div>
      <div class="status-head__actions"><button class="btn ${on ? 'btn-ghost' : 'btn-primary'}" disabled=${!!busy} onClick=${async () => {
        if (on || await ask({ title: 'Let budgets set card limits?', text: caps.length ? `${caps.length} card${caps.length === 1 ? '' : 's'} get the limits below within a few minutes, and follow their jobs from then on.` : 'Cards on a job get a limit from that job’s budget.', yes: 'Turn on' })) act({ action: 'caps', on: !on }, on ? 'Card limits left alone from now on' : 'Card limits follow budgets');
      }}>${on ? 'Turn off' : 'Turn on'}</button></div></div>
      ${caps.length ? html`<div class="jc-table-wrap"><table class="jc-table">
        <thead><tr><th>Card</th><th>Now</th><th>From budgets</th><th class="jc-hide-sm" style="text-align: left;">Jobs</th></tr></thead>
        <tbody>${caps.map((c) => html`<tr key=${c.cardId}><td>${c.name} ·· ${c.lastFour}</td><td>${c.nowCents != null ? `${usd(c.nowCents)}/${c.interval === 'monthly' ? 'mo' : c.interval}` : 'none'}</td><td>${usd(c.wantCents)}/mo</td><td class="jc-hide-sm" style="text-align: left;">${c.jobs.join(', ')}</td></tr>`)}</tbody>
      </table></div>` : html`<p class="sec-head__hint" style="margin: 0;">No card’s holder is on an open job in JobTread yet.</p>`}
    </div>
  </section>`;
}

function Ramp({ data, act, busy }) {
  const [picked, setPicked] = useState(new Set());
  const codeName = (id) => data.codes.find((c) => c.id === id)?.name || 'A cost code';
  const list = data.recode;
  const proposed = list.filter((r) => r.state === 'proposed');
  const waiting = list.filter((r) => r.state === 'waiting');
  const applied = list.filter((r) => r.state === 'applied');
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const apply = async (ids) => {
    if (!(await ask({ title: `Recode ${ids.length} bill${ids.length === 1 ? '' : 's'} in JobTread?`, text: 'Each bill keeps its total and payment; its one "Makeover COGS" line becomes a line per cost code. Each can be undone here.', yes: 'Recode' }))) return;
    // A bill JobTread refused keeps its error on its row
    const j = await act({ action: 'recode-apply', billIds: ids }, (r) => {
      const n = r.results.filter((x) => x.ok).length;
      return `${n} bill${n === 1 ? '' : 's'} recoded${n < ids.length ? `, ${ids.length - n} couldn’t be (see below)` : ''}`;
    });
    if (j) setPicked(new Set());
  };
  return html`
    <section class="card" style="padding: 0;">
      <div class="sec-head"><h3>Ramp bills to recode</h3>
        <p class="sec-head__desc">Ramp put every bill since August on one line, “Makeover COGS”, under 01 DESIGN & ENGINEERING. The Receipt Processor reads each bill’s receipt and proposes the split by cost code; a vendor rule proposes on its own. Nothing changes in JobTread until you recode.</p></div>
      <div class="jc-body"><div class="jc-row" style="justify-content: space-between;">
        <span class="sec-head__hint">${proposed.length} ready · ${waiting.length} waiting for the agent · ${applied.length} recoded</span>
        <div class="jc-row">
          ${picked.size > 0 && html`<button class="btn btn-primary" disabled=${!!busy} onClick=${() => apply([...picked])}>${busy === 'recode-apply' ? 'Recoding…' : `Recode ${picked.size}`}</button>`}
          ${proposed.length > 0 && !picked.size && html`<button class="btn btn-ghost" disabled=${!!busy} onClick=${() => apply(proposed.slice(0, 25).map((r) => r.billId))}>Recode the first ${Math.min(25, proposed.length)}</button>`}
        </div>
      </div></div>
      ${list.length === 0 && html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">Looking for Ramp bills in JobTread. They show up here within the day.</p></div>`}
      ${[...proposed, ...waiting, ...applied].slice(0, 200).map((r) => html`<div class="jc-charge" key=${r.billId}>
        <span class="jc-charge__date">${day(r.date)}</span>
        <div class="jc-charge__what">
          <strong>${r.vendor}</strong>
          <div class="jc-charge__meta"><span class="tag">${r.jobName || 'A job'}</span>
            ${r.state === 'applied' ? html`<span class="tag tag--success">Recoded</span>` : r.state === 'waiting' ? html`<span class="tag">Waiting for the agent</span>` : html`<span class="tag tag--info">${r.proposedBy === 'rule' ? 'From a vendor rule' : 'Read from the receipt'}</span>`}
            ${r.error ? html`<span class="tag tag--danger">${r.error}</span>` : ''}
            <a href=${`https://app.jobtread.com/documents/${r.billId}`} target="_blank" rel="noopener">JobTread</a>
          </div>
          ${r.proposal && html`<ul class="jc-split">${r.proposal.map((l) => html`<li>${codeName(l.costCodeId)} · <span class="jc-mono">${usdCents(l.cents)}</span>${l.name ? ` · ${l.name}` : ''}</li>`)}</ul>`}
        </div>
        <div class="jc-row" style="justify-content: flex-end;">
          <span class="jc-charge__amt">${usdCents(r.cents)}</span>
          ${r.state === 'proposed' && html`<input type="checkbox" aria-label=${`Pick ${r.vendor}`} checked=${picked.has(r.billId)} onChange=${() => toggle(r.billId)} />`}
          ${r.state === 'applied' && html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => act({ action: 'recode-undo', billId: r.billId }, 'Put back as it was')}>Undo</button>`}
        </div>
      </div>`)}
    </section>`;
}

// ─── Bills ──────────────────────────────────────────────────────────

const BILL_STATE = {
  waiting: ['Waiting for approval', 'tag--warn'], second: ['Needs a second approval', 'tag--warn'], approved: ['Approved', 'tag--success'], rejected: ['Not approved', ''],
};
const PAY_STATE = {
  requested: ['Waiting in Mercury for an approver', 'tag--info'], sent: ['Payment sent', 'tag--info'], paid: ['Paid · recorded in JobTread', 'tag--success'], failed: ['Not paid', 'tag--danger'],
  held: ['Approved · not paid: documents', 'tag--warn'],
};
const PAY_MODES = [
  ['off', 'Pay by hand', 'Approval is recorded. Someone pays in Mercury, and the payment is still recorded on the bill in JobTread by itself.'],
  ['request', 'Mercury holds it for approval', 'An approved bill becomes a payment waiting in Mercury. Nothing leaves until an approver taps Approve in Mercury.'],
  ['send', 'Pay it right away', 'An approved bill is paid from Mercury at once, by ACH (or check), to the vendor’s Mercury recipient.'],
];

function Bills({ data, act, busy }) {
  const [show, setShow] = useState('waiting');
  const [settings, setSettings] = useState(false);
  const bills = data.bills || [];
  const cfg = data.billPay || {};
  const groups = {
    waiting: (b) => ['waiting', 'second'].includes(b.approval.state),
    paying: (b) => b.approval.state === 'approved' && b.approval.payState !== 'paid',
    paid: (b) => b.approval.payState === 'paid',
    rejected: (b) => b.approval.state === 'rejected',
  };
  const labels = [['waiting', 'Waiting for approval'], ['paying', 'Approved'], ['paid', 'Paid'], ['rejected', 'Not approved']];
  const rows = bills.filter(groups[show]);
  return html`
    ${!cfg.approvers?.length && html`<div class="notice notice--warn"><div class="notice__body"><strong>No approvers yet.</strong> Add who approves bills (Holly) in the settings below. Until then, no decision counts, from email or from here.</div></div>`}
    <div class="jc-row" style="justify-content: space-between;">
      <div class="pill-row">${labels.map(([k, label]) => {
        const n = bills.filter(groups[k]).length;
        return html`<button class="pill" aria-pressed=${show === k} onClick=${() => setShow(k)}>${label}${n ? html`<span class="count ${k === 'waiting' ? 'is-warn' : ''}">${n}</span>` : ''}</button>`;
      })}</div>
      <button class="btn btn-ghost btn-sm" aria-expanded=${settings} onClick=${() => setSettings(!settings)}>Settings</button>
    </div>
    ${settings && html`<${BillSettings} data=${data} act=${act} busy=${busy} />`}
    <${RampHolds} ramp=${data.ramp} />
    <section class="card" style="padding: 0;">
      <div class="sec-head"><h3>${labels.find(([k]) => k === show)[1]} <span class="count">${rows.length}</span></h3>
        <p class="sec-head__desc">${show === 'waiting'
          ? 'Subs’ bills in JobTread that aren’t paid yet. The DataX Bill Approver emails each one to the approver, who replies approved or not. Card purchases aren’t here: they’re paid already.'
          : `Paying: ${PAY_MODES.find(([k]) => k === (cfg.payMode || 'off'))[1].toLowerCase()}. When Mercury’s payment goes out, it’s recorded on the bill in JobTread.`}</p></div>
      ${rows.length ? rows.map((b) => html`<${BillRow} key=${b.id} b=${b} data=${data} act=${act} busy=${busy} />`)
        : html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">${show === 'waiting' ? 'No bills waiting. Every sub’s bill has an answer.' : 'None here.'}</p></div>`}
    </section>`;
}

/** While Ramp pays bills: the ones held there for the vendor's W-9 or insurance (functions/api/_ramp.js) */
function RampHolds({ ramp }) {
  if (!ramp?.connected) return null;
  const held = ramp.held || [];
  const watch = ramp.watch || [];
  const unmatched = ramp.unmatched || [];
  if (!ramp.error && !held.length && !watch.length && !unmatched.length) return null;
  const starts = ramp.startsAt && Date.parse(ramp.startsAt) > Date.now()
    ? new Date(ramp.startsAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const names = [...new Set(unmatched.map((r) => r.vendor))];
  return html`<section class="card" style="padding: 0;">
    <div class="sec-head"><h3>Held in Ramp <span class="count">${held.length}</span></h3>
      <p class="sec-head__desc">Ramp pays bills until the switch to Mercury. A Ramp bill whose vendor’s W-9 or insurance isn’t current in JobTread is put on hold in Ramp and the vendor is emailed; the hold comes off by itself once theirs check out.${starts ? ` Holds start ${starts}. Until then these are only noted, so set a store’s Documents field to “Not needed” in JobTread first.` : ''}</p></div>
    ${ramp.error && html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">${ramp.error.error}</p></div>`}
    ${[...held, ...watch].map((r) => html`<div class="jc-charge" key=${r.rampId}>
      <span class="jc-charge__date">${day(r.heldAt)}</span>
      <div class="jc-charge__what">
        <strong>${r.vendor}${r.invoice ? ` · #${r.invoice}` : ''}</strong>
        <div class="jc-charge__meta">
          <span class="tag tag--warn">${r.state === 'held' ? 'On hold in Ramp' : starts ? 'Goes on hold when holds start' : 'Goes on hold at the next check'}</span>
          ${r.reason ? html`<span>${r.reason}</span>` : ''}
          ${r.askedAt ? html`<span>Vendor emailed ${ago(r.askedAt)}</span>` : ''}
          ${r.accountId ? html`<a href=${`https://app.jobtread.com/vendors/${r.accountId}`} target="_blank" rel="noopener">Vendor in JobTread</a>` : ''}
          ${r.jtBillId ? html`<a href=${`https://app.jobtread.com/documents/${r.jtBillId}`} target="_blank" rel="noopener">JobTread</a>` : ''}
        </div>
      </div>
      <span class="jc-charge__amt">${usdCents(r.cents)}</span>
    </div>`)}
    ${names.length ? html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">Not checked, because JobTread has no vendor by that name: ${names.join(', ')}. Add them as vendors in JobTread (or fix the name) and they’re checked within the hour.</p></div>` : ''}
  </section>`;
}

function BillRow({ b, data, act, busy }) {
  const [link, setLink] = useState('');
  const a = b.approval || {};
  const cfg = data.billPay || {};
  const later = cfg.payMode && cfg.payMode !== 'off' && (!cfg.startsOn || cfg.startsOn > new Date().toLocaleDateString('en-CA'));
  const startDay = cfg.startsOn ? new Date(`${cfg.startsOn}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
  const call = a.payState === 'held' && a.hold?.bank;
  const [stateLabel, stateTone] = call ? ['Approved · not paid: a call first', 'tag--warn']
    : a.payState && PAY_STATE[a.payState] ? PAY_STATE[a.payState]
    : a.state === 'approved' && later ? [startDay ? `Approved · Mercury pays it ${startDay}` : 'Approved · Ramp pays it until the switch', 'tag--success']
    : BILL_STATE[a.state] || BILL_STATE.waiting;
  const decide = async (decision) => {
    if (decision === 'approved' && !(await ask({ title: `Approve ${b.vendor}’s bill for ${usdCents(b.owed)}?`, text: later ? (startDay ? `Mercury pays it on ${startDay}, the day bills switch from Ramp.` : 'It’s marked approved. Ramp pays bills until the day they switch to Mercury.') : cfg.payMode === 'send' ? 'It’s paid from Mercury right away.' : cfg.payMode === 'request' ? 'Mercury holds the payment until an approver taps Approve in Mercury.' : 'It’s marked approved. Pay it in Mercury; the payment is recorded in JobTread by itself.', yes: 'Approve' }))) return;
    if (decision === 'rejected' && !(await ask({ title: `Don’t approve ${b.vendor}’s bill?`, text: 'It stays unpaid in JobTread, and the Finance channel hears about it.', yes: 'Don’t approve' }))) return;
    act({ action: 'bill-decide', billId: b.id, decision }, decision === 'approved' ? 'Approved' : 'Marked not approved');
  };
  // The one thing a person does for a trade partner: a bank account they gave on their page, checked by phone before money goes to it
  const confirmBank = async () => {
    if (!(await ask({ title: `Confirm ${b.vendor}’s bank account?`, text: `Call ${b.vendor} on a number SOARD already had for them (an old invoice, your phone), not one from their page or an email, and check the account ends in ${a.hold.last4 || 'the four digits they give you'}. Once it’s confirmed, this bill is paid.`, yes: 'It’s right: confirm' }))) return;
    act({ action: 'bank-confirm', jtId: b.accountId }, 'Bank account confirmed');
  };
  const over = b.job && b.job.budget && b.job.forecast > b.job.budget;
  return html`<div class="jc-charge">
    <span class="jc-charge__date">${day(b.date)}</span>
    <div class="jc-charge__what">
      <strong>${b.vendor}${b.number ? ` · #${b.number}` : ''}</strong>
      <div class="jc-charge__meta">
        <span class="tag ${stateTone}">${stateLabel}</span>
        ${b.jobName ? html`<span class="tag">${b.jobName}</span>` : ''}
        ${b.big ? html`<span>Over the second-approval amount</span>` : ''}
        ${b.documents && !b.documents.ok && a.payState !== 'held' && a.state !== 'rejected' ? html`<span class="tag tag--warn">${cap(b.documents.staff || 'W-9 or insurance missing')}</span>` : ''}
        ${a.payState === 'held' && a.hold?.askedAt ? html`<span>Vendor emailed ${ago(a.hold.askedAt)}</span>` : ''}
        ${b.vendorLink && (a.payState === 'held' || (b.documents && !b.documents.ok)) ? html`<a href=${b.vendorLink} target="_blank" rel="noopener">Vendor in JobTread</a>` : ''}
        ${b.job ? html`<span class=${over ? 'tag tag--warn' : ''}>Job forecast ${usd(b.job.forecast)} of ${usd(b.job.budget)}</span>` : ''}
        ${b.codes.map((c) => html`<span>${c.name}${c.budget ? ` · ${usd(c.forecast)} of ${usd(c.budget)}` : ''}</span>`)}
        ${(a.approvals || []).map((x) => html`<span>${x.decision === 'approved' ? 'Yes' : 'No'} from ${person(x.by)} ${ago(x.at)}${x.via === 'email' ? ' by email' : ''}</span>`)}
        ${a.askedAt && ['waiting', 'second'].includes(a.state) ? html`<span>Asked ${ago(a.askedAt)}</span>` : ''}
        <a href=${b.link} target="_blank" rel="noopener">JobTread</a>
      </div>
      ${a.payError && html`<p class="sec-head__hint" style="margin: .35rem 0 0;">${a.payError}</p>`}
    </div>
    <span class="jc-charge__amt">${usdCents(b.owed)}</span>
    ${['waiting', 'second'].includes(a.state) && html`<div class="jc-sort">
      <button class="btn btn-primary btn-sm" disabled=${!!busy} onClick=${() => decide('approved')}>Approve</button>
      <button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => decide('rejected')}>Don’t approve</button>
    </div>`}
    ${call && b.accountId && html`<div class="jc-sort">
      <button class="btn btn-primary btn-sm" disabled=${!!busy} onClick=${confirmBank}>Confirm bank account</button>
    </div>`}
    ${a.payState === 'failed' && html`<div class="jc-sort">
      ${Array.isArray(data.recipients) && data.recipients.length ? html`<select class="form-input" aria-label="Mercury recipient" value=${link} onChange=${(e) => setLink(e.target.value)}>
        <option value="">Pay to which Mercury recipient?</option>${data.recipients.map((r) => html`<option value=${r.id}>${r.name}${r.hasBank ? '' : ' (no bank yet)'}</option>`)}
      </select>
      <button class="btn btn-ghost btn-sm" disabled=${!link || !!busy} onClick=${() => act({ action: 'bill-link', billId: b.id, recipientId: link }, 'Linked')}>Link</button>` : ''}
      <button class="btn btn-primary btn-sm" disabled=${!!busy} onClick=${() => act({ action: 'bill-retry', billId: b.id }, 'Paid')}>Try paying again</button>
    </div>`}
  </div>`;
}

function BillSettings({ data, act, busy }) {
  const cfg = data.billPay || {};
  const [approvers, setApprovers] = useState((cfg.approvers || []).join(', '));
  const [big, setBig] = useState((cfg.bigApprovers || []).join(', '));
  const [bigAt, setBigAt] = useState(String((cfg.bigBillCents || 0) / 100));
  const [cap, setCap] = useState(String((cfg.dailyCapCents || 0) / 100));
  const [from, setFrom] = useState(cfg.payFromAccountId || '');
  const [starts, setStarts] = useState(cfg.startsOn || '');
  const list = (s) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const save = (extra = {}) => act({ action: 'bill-settings', approvers: list(approvers), bigApprovers: list(big), bigBillCents: Math.round(Number(bigAt) * 100) || 0, dailyCapCents: Math.round(Number(cap) * 100) || 0, payFromAccountId: from || null, startsOn: starts || null, ...extra }, 'Saved');
  const setMode = async (mode) => {
    if (mode === cfg.payMode) return;
    const m = PAY_MODES.find(([k]) => k === mode);
    if (mode !== 'off' && !(await ask({ title: `${m[1]}?`, text: `${m[2]} Payments stop at ${usd(Math.round(Number(cap) * 100))} a day.`, yes: m[1] }))) return;
    save({ payMode: mode });
  };
  const accounts = Array.isArray(data.accounts) ? data.accounts.filter((a) => a.kind !== 'credit') : [];
  return html`<section class="card" style="padding: 0;">
    <div class="sec-head"><h3>Approvals and paying</h3>
      <p class="sec-head__desc">Only these people’s answers count, by email to the DataX Bill Approver or here.</p></div>
    <div class="jc-body jc-grid2">
      <label class="jc-field"><span>Approvers (emails)</span><input class="form-input" value=${approvers} onInput=${(e) => setApprovers(e.target.value)} placeholder="name@soardcharity.com" /></label>
      <label class="jc-field"><span>A bill this big needs two yeses ($)</span><input class="form-input" type="number" min="0" step="100" value=${bigAt} onInput=${(e) => setBigAt(e.target.value)} /></label>
      <label class="jc-field"><span>One of the two must be (emails, optional)</span><input class="form-input" value=${big} onInput=${(e) => setBig(e.target.value)} /></label>
      <label class="jc-field"><span>Most paid in a day ($)</span><input class="form-input" type="number" min="0" step="500" value=${cap} onInput=${(e) => setCap(e.target.value)} /></label>
      <label class="jc-field"><span>Paid from</span><select class="form-input" value=${from} onChange=${(e) => setFrom(e.target.value)}>
        <option value="">Pick an account</option>${accounts.map((a) => html`<option value=${a.id}>${a.name}${a.lastFour ? ` ·· ${a.lastFour}` : ''}</option>`)}
      </select></label>
      <label class="jc-field"><span>Mercury starts paying bills on</span><input class="form-input" type="date" value=${starts} onInput=${(e) => setStarts(e.target.value)} />
        <span class="sec-head__hint">Until then Ramp pays them. Bills approved before this day are paid that morning.</span></label>
    </div>
    <div class="jc-body" style="border-top: 1px solid var(--color-border);"><div class="jc-row"><button class="btn btn-primary" disabled=${!!busy} onClick=${() => save()}>${busy === 'bill-settings' ? 'Saving…' : 'Save'}</button></div></div>
    <div class="sec-head" style="border-top: 1px solid var(--color-border);"><h3>W-9 and insurance</h3>
      <p class="sec-head__desc">A bill is paid only when the vendor’s W-9 and certificate of insurance are current in JobTread. The site asks the vendor for them, and their agent for renewals, by itself; each email is noted on the vendor in JobTread.</p></div>
    <div class="sec-head" style="border-top: 1px solid var(--color-border);"><h3>When a bill is approved</h3>${!cfg.payFromAccountId ? html`<p class="sec-head__desc">Pick and save the account bills are paid from to choose how they’re paid.</p>` : ''}</div>
    <div class="jc-body" style="display: grid; gap: .5rem;">
      ${PAY_MODES.map(([k, label, text]) => html`<label class="jc-row" style="align-items: flex-start;" key=${k}>
        <input type="radio" name="pay-mode" checked=${(cfg.payMode || 'off') === k} onChange=${() => setMode(k)} disabled=${!!busy || (k !== 'off' && !cfg.payFromAccountId)} />
        <span><strong>${label}</strong><br /><span class="sec-head__hint">${text}</span></span>
      </label>`)}
    </div>
  </section>`;
}

// ─── Close-outs and the budget builder ──────────────────────────────

function Closeouts({ data, id, onOpen }) {
  const list = data.closeouts || [];
  const codeName = (cid) => (cid === 'uncoded' ? 'Not coded' : data.codes.find((c) => c.id === cid)?.name || 'Other code');
  const one = id ? list.find((c) => c.jobId === id) : null;
  if (id && !one) return html`<div class="notice"><div class="notice__body">That job’s close-out isn’t ready yet. Closed jobs are read from JobTread every hour.</div><div class="notice__actions"><button class="btn btn-ghost" onClick=${() => onOpen(null)}>All close-outs</button></div></div>`;
  if (one) {
    const d = pct(one.actual - one.budget, one.budget);
    return html`
      <div class="jc-row"><button class="btn btn-ghost btn-sm" onClick=${() => onOpen(null)}>← All close-outs</button></div>
      <section class="card" style="padding: 0;">
        <div class="sec-head"><h3>${one.name}</h3><span class="sec-head__hint">Closed ${day(one.closedOn)}${one.rooms ? ` · ${one.rooms} room${one.rooms === 1 ? '' : 's'}` : ''}</span></div>
        <div class="jc-body jc-nums" style="font-size: var(--fs-sm);">
          <span><b>${usd(one.actual)}</b> spent</span><span>${one.budget ? html`of <b>${usd(one.budget)}</b> budget` : 'no budget'}</span>
          ${d != null ? html`<span class=${d > 0 ? 'tag tag--warn' : 'tag tag--success'}>${d > 0 ? `${d}% over` : `${Math.abs(d)}% under`}</span>` : ''}
          ${one.rooms ? html`<span><b>${usd(one.actual / one.rooms)}</b> a room</span>` : ''}
        </div>
        ${one.codedShare < 0.8 && html`<div class="jc-body" style="padding-top: 0;"><p class="sec-head__hint" style="margin: 0;">${Math.round((1 - one.codedShare) * 100)}% of this job’s spending is uncoded or on the Ramp-era 01 line, so the budget builder doesn’t learn from it yet. Recoding its Ramp bills fixes that.</p></div>`}
        <div class="jc-table-wrap"><table class="jc-table">
          <thead><tr><th>Cost code</th><th>Budget</th><th>Spent</th><th>Over / under</th>${one.rooms ? html`<th class="jc-hide-sm">A room</th>` : ''}</tr></thead>
          <tbody>${one.rows.map((r) => html`<tr class=${r.budget && r.actual > r.budget ? 'is-over' : ''}><td>${codeName(r.codeId)}</td><td>${dash(r.budget)}</td><td>${usd(r.actual)}</td><td>${r.budget ? usd(r.actual - r.budget) : '–'}</td>${one.rooms ? html`<td class="jc-hide-sm">${usd(r.actual / one.rooms)}</td>` : ''}</tr>`)}</tbody>
        </table></div>
      </section>`;
  }
  const h = data.history || { jobs: 0, codes: [] };
  const drift = h.codes.filter((c) => c.overBy != null && c.seen >= 2).sort((a, b) => b.overBy - a.overBy);
  return html`
    ${data.health.closeouts?.historyLeft ? html`<p class="sec-head__hint" style="margin: 0;">Reading past jobs from JobTread: ${data.health.closeouts.historyLeft} to go, a few each hour.</p>` : ''}
    <section class="card" style="padding: 0;">
      <div class="sec-head"><h3>Where budgets miss</h3>
        <p class="sec-head__desc">Across ${h.jobs} finished makeover${h.jobs === 1 ? '' : 's'} with coded spending: how each cost code usually lands against its own budget line. Codes that keep running over are the ones to raise in the JobTread budget template.</p></div>
      ${drift.length ? html`<div class="jc-table-wrap"><table class="jc-table">
        <thead><tr><th>Cost code</th><th>Usually</th><th>A room</th><th class="jc-hide-sm">Jobs</th></tr></thead>
        <tbody>${drift.map((c) => html`<tr class=${c.overBy > 10 ? 'is-over' : ''}><td>${codeName(c.codeId)}</td><td>${c.overBy > 0 ? `${c.overBy}% over` : c.overBy < 0 ? `${-c.overBy}% under` : 'on budget'}</td><td>${usd(c.perRoom)}</td><td class="jc-hide-sm">${c.seen}</td></tr>`)}</tbody>
      </table></div>` : html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">Not enough coded close-outs yet. Each finished makeover adds to this, and so does each recoded Ramp bill.</p></div>`}
    </section>
    <section class="card" style="padding: 0;">
      <div class="sec-head"><h3>Finished makeovers <span class="count">${list.length}</span></h3></div>
      ${list.length ? list.map((c) => {
        const d = pct(c.actual - c.budget, c.budget);
        return html`<button class="jc-charge" style="width: 100%; background: none; border-left: 0; border-right: 0; border-top: 0; font: inherit; color: inherit; text-align: left; cursor: pointer;" key=${c.jobId} onClick=${() => onOpen(c.jobId)}>
          <span class="jc-charge__date">${day(c.closedOn)}</span>
          <span class="jc-charge__what"><strong>${c.name}</strong><span class="jc-charge__meta">
            ${d != null ? html`<span class=${d > 0 ? 'tag tag--warn' : 'tag tag--success'}>${d > 0 ? `${d}% over` : `${Math.abs(d)}% under`}</span>` : html`<span class="tag">No budget</span>`}
            ${c.rooms ? html`<span>${usd(c.actual / c.rooms)} a room</span>` : ''}
            ${c.over[0] ? html`<span>Most over: ${codeName(c.over[0].codeId)}</span>` : ''}
          </span></span>
          <span class="jc-charge__amt">${usd(c.actual)}</span>
        </button>`;
      }) : html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">No closed jobs read yet. They come from JobTread every hour.</p></div>`}
    </section>`;
}

function BudgetBuilder({ jobId, data, act, busy }) {
  const [b, setB] = useState(null);
  const [rooms, setRooms] = useState('');
  const [err, setErr] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const load = async (n = rooms) => {
    setErr(null);
    try {
      const r = await fetch(`${API}?budget=${encodeURIComponent(jobId)}${n ? `&rooms=${encodeURIComponent(n)}` : ''}`, { cache: 'no-store' }).then((x) => x.json());
      if (!r.success) { setErr(r.error); return; }
      setB(r.budget);
      setPicked(new Set(r.budget.lines.filter((l) => l.add).map((l) => l.codeId)));
      if (!n) setRooms(String(r.budget.rooms));
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(''); }, [jobId]);
  const codeName = (cid) => data.codes.find((c) => c.id === cid)?.name || (cid === 'uncoded' ? 'Not coded' : 'Other code');
  const add = async () => {
    const lines = b.lines.filter((l) => picked.has(l.codeId) && l.add).map((l) => ({ codeId: l.codeId, cents: l.suggested }));
    if (!(await ask({ title: `Add ${lines.length} budget line${lines.length === 1 ? '' : 's'} in JobTread?`, text: `${usd(lines.reduce((n, l) => n + l.cents, 0))} in all, one line per cost code. Lines already on the budget aren’t touched.`, yes: 'Add to JobTread' }))) return;
    const j = await act({ action: 'budget-add', jobId, lines }, (r) => `${r.added} line${r.added === 1 ? '' : 's'} added in JobTread`);
    if (j?.budget) { setB(j.budget); setPicked(new Set()); }
  };
  return html`<section class="card" style="padding: 0;">
    <div class="sec-head"><h3>Budget builder</h3>
      <p class="sec-head__desc">What each cost code has really cost per room on finished makeovers, for the rooms this one will build${b?.builds ? '' : ' (its family profile has no rooms yet, so pick how many)'}.</p></div>
    ${err ? html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">${err}</p></div>`
      : !b ? html`<div style="text-align:center;padding:1rem"><span class="spinner" /></div>`
      : !b.history.jobs ? html`<div class="jc-body"><p class="sec-head__hint" style="margin: 0;">No finished makeover with coded spending yet${b.history.all ? ` (${b.history.all} closed, still on Ramp-era lines)` : ''}. Suggestions start with the first one.</p></div>`
      : html`
        <div class="jc-body jc-row">
          <label class="jc-row"><span class="sec-head__hint">Rooms</span><input class="form-input" type="number" min="1" max="20" style="width: 5rem;" value=${rooms} onInput=${(e) => setRooms(e.target.value)} onChange=${(e) => load(e.target.value)} /></label>
          <span class="sec-head__hint">From ${b.history.jobs} finished makeover${b.history.jobs === 1 ? '' : 's'} · suggested ${usd(b.total)} · in JobTread now ${usd(b.current)}</span>
        </div>
        <div class="jc-table-wrap"><table class="jc-table">
          <thead><tr><th>Cost code</th><th>Suggested</th><th class="jc-hide-sm">Usual range</th><th>In JobTread</th><th><span class="sr-only">Add</span></th></tr></thead>
          <tbody>${b.lines.map((l) => html`<tr key=${l.codeId}>
            <td>${codeName(l.codeId)}${l.overBy > 10 ? html` <span class="tag tag--warn" title="How this code has run against its own budget line">runs ${l.overBy}% over</span>` : ''}</td>
            <td>${dash(l.suggested)}</td><td class="jc-hide-sm">${l.suggested ? `${usd(l.low)}–${usd(l.high)}` : '–'}</td><td>${dash(l.current)}</td>
            <td>${l.add && l.suggested ? html`<input type="checkbox" aria-label=${`Add ${codeName(l.codeId)}`} checked=${picked.has(l.codeId)} onChange=${() => setPicked((s) => { const n = new Set(s); if (n.has(l.codeId)) n.delete(l.codeId); else n.add(l.codeId); return n; })} />` : ''}</td>
          </tr>`)}</tbody>
        </table></div>
        ${b.lines.some((l) => l.add && l.suggested) && html`<div class="jc-body"><button class="btn btn-primary" disabled=${!picked.size || !!busy} onClick=${add}>${busy === 'budget-add' ? 'Adding…' : `Add ${picked.size} to JobTread`}</button></div>`}`}
  </section>`;
}
