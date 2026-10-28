/**
 * Admin → Finance: the monthly P&L, cash 13 weeks ahead, the month-end close
 * ===========================================================================
 * Over /api/finance-admin (functions/api/_finance.js). Read from Mercury and
 * from where Job Costs sorted each charge; nobody types numbers in here.
 *
 * Tabs (#finance/<tab>):
 *   P&L     a month in three columns (Makeovers, Sunny & Ranney store,
 *           Operating), beside the same month last year and year to date;
 *           who sends money in, and what kind it is; the CSV for the CPA
 *   Cash    13 weeks ahead from today's balances: a likely line between a
 *           cautious and a hopeful one, and the cash floor
 *   Close   last month's checklist; ready months go to the CPA by themselves
 *   Setup   the CPA's email and where their replies go
 */

import { h, htm, useState, useEffect } from './vendor.js';
import { ask } from './ask.js';

const html = htm.bind(h);
const API = '/api/finance-admin';
const TABS = [['pnl', 'P&L'], ['cash', 'Cash'], ['close', 'Close'], ['setup', 'Setup']];
const COLS = [['job', 'Makeovers'], ['store', 'Store'], ['operating', 'Operating']];
const KINDS = [['donations', 'Donations'], ['store', 'Store sales'], ['other', 'Other income']];

async function call(query, body) {
  let r;
  try {
    r = await fetch(body ? API : `${API}?${new URLSearchParams(query)}`, body
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

// Totals in whole dollars, like Job Costs
const usd = (c) => (Math.round(Number(c || 0) / 100)).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dash = (c) => (c ? usd(c) : '–');
const weekName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const change = (now, before) => {
  if (!before) return null;
  const p = Math.round(((now - before) / Math.abs(before)) * 100);
  return `${p > 0 ? '+' : ''}${p}% on last year`;
};

const CSS = `
.fi { display: grid; gap: 1rem; }
.fi-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9.5rem), 1fr)); gap: .75rem; }
.fi-tile { padding: .9rem 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); box-shadow: var(--shadow-xs); display: grid; gap: .2rem; }
.fi-tile > span { font-size: var(--fs-xs); color: var(--color-text-secondary); }
.fi-tile > strong { font-size: var(--fs-xl); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.fi-tile > small { font-size: var(--fs-2xs); color: var(--color-text-muted); }
.fi-table-wrap { overflow-x: auto; }
.fi-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.fi-table th { text-align: right; font-size: var(--fs-2xs); font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: .04em; padding: .5rem .6rem; border-bottom: 1px solid var(--color-border); white-space: nowrap; }
.fi-table th:first-child, .fi-table td:first-child { text-align: left; }
.fi-table td { text-align: right; padding: .5rem .6rem; border-bottom: 1px solid var(--color-border); }
.fi-table tr.is-head td { font-weight: 700; padding-top: 1rem; border-bottom: none; text-align: left; }
.fi-table tr.is-total td { font-weight: 700; }
.fi-table tr.is-net td { font-weight: 700; border-bottom: none; background: var(--tone-neutral-bg); }
.fi-table tr.is-unsorted td { background: var(--tone-warn-surface); }
.fi-table td.fi-muted { color: var(--color-text-muted); }
.fi-body { padding: 1rem 1.25rem; }
.fi-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.fi-field { display: grid; gap: .3rem; max-width: 26rem; }
.fi-field > span { font-size: var(--fs-xs); font-weight: 600; }
.fi-list { list-style: none; margin: 0; padding: 0; }
.fi-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .25rem 1rem; align-items: center; padding: .65rem 1.25rem; border-bottom: 1px solid var(--color-border); }
.fi-list li:last-child { border-bottom: none; }
.fi-list strong { font-weight: 600; overflow-wrap: anywhere; }
.fi-list small { display: block; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.fi-check { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr) auto; gap: .25rem .75rem; align-items: start; padding: .7rem 1.25rem; border-bottom: 1px solid var(--color-border); }
.fi-check:last-child { border-bottom: none; }
.fi-check .dot { margin-top: .4rem; }
.fi-check small { display: block; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.fi-chart { width: 100%; height: auto; max-height: 340px; display: block; }
.fi-chart text { font-size: 9px; fill: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.fi-key { display: flex; flex-wrap: wrap; gap: .3rem 1rem; font-size: var(--fs-2xs); color: var(--color-text-muted); }
.fi-key i { display: inline-block; width: 14px; height: 10px; border-radius: 3px; margin-right: .3rem; vertical-align: -1px; }
.fi-mono { font-variant-numeric: tabular-nums; white-space: nowrap; }
.fi-sources { margin: 0; padding-left: 1.1rem; display: grid; gap: .35rem; font-size: var(--fs-sm); }
@media (max-width: 640px) {
  .fi-body { padding: .85rem; }
  .fi-list li, .fi-check { padding: .65rem .85rem; }
  .fi-list li { grid-template-columns: minmax(0, 1fr); }
  .fi-list .form-input, .fi-row .btn, .fi-row .form-input { min-height: 44px; }
  .fi-table .fi-hide-sm { display: none; }
}
`;
let styled = false;
function useStyles() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.module = 'finance';
  el.textContent = CSS;
  document.head.append(el);
}

function tabOf(hash = location.hash) {
  const t = String(hash).replace(/^#/, '').split('/')[1] || 'pnl';
  return TABS.some(([k]) => k === t) ? t : 'pnl';
}

export function Finance({ addToast = () => {} }) {
  useStyles();
  const [tab, setTab] = useState(tabOf);
  const [data, setData] = useState({});
  const [err, setErr] = useState(null);
  const [month, setMonth] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = async (t = tab, m = month) => {
    const j = await call({ view: t, ...(t === 'pnl' && m ? { month: m } : {}) });
    if (!j.success) { setErr(j.error || 'Could not load finance'); return; }
    setErr(null);
    setData((d) => ({ ...d, ...j }));
    if (t === 'pnl' && j.pnl && !m) setMonth(j.pnl.month);
  };
  useEffect(() => { load(tab); }, [tab]);
  useEffect(() => {
    const on = () => setTab(tabOf());
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('hashchange', on); };
  }, []);
  const open = (t) => {
    const next = `#finance${t === 'pnl' ? '' : `/${t}`}`;
    if (location.hash !== next) history.pushState(null, '', next);
    setTab(t);
  };
  const act = async (body, done) => {
    setBusy(body.action);
    const j = await call(null, body);
    setBusy(null);
    if (!j.success) { addToast(j.error || 'That did not work', 'error'); return null; }
    setData((d) => ({ ...d, ...j }));
    if (done) addToast(typeof done === 'function' ? done(j) : done, 'success');
    return j;
  };

  const loaded = tab === 'pnl' ? data.pnl : tab === 'cash' ? data.cash : tab === 'close' ? data.close : data.settings;
  if (err && !loaded) {
    return html`<div class="notice notice--danger"><div class="notice__body"><strong>Couldn't load finance:</strong> ${err}</div>
      <div class="notice__actions"><button class="btn btn-ghost" onClick=${() => load()}>Try again</button></div></div>`;
  }
  const toClose = (data.close || []).filter((c) => !c.closed && c.ended).length;

  return html`
    <div class="fi">
      <div class="page-header">
        <div>
          <h2>Finance</h2>
          <p class="page-sub">SOARD’s money from Mercury, sorted the way Job Costs sorts every charge: makeovers, the Sunny & Ranney store, and running SOARD.</p>
        </div>
      </div>
      ${data.health ? html`<${Health} h=${data.health} />` : null}
      <div class="seg" role="tablist" aria-label="Finance">
        ${TABS.map(([k, label]) => html`<button role="tab" aria-selected=${tab === k} onClick=${() => open(k)}>${label}${k === 'close' && toClose ? html` <span class="count">${toClose}</span>` : ''}</button>`)}
      </div>
      ${!loaded ? html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`
        : tab === 'pnl' ? html`<${Pnl} data=${data} act=${act} busy=${busy} onMonth=${(m) => { setMonth(m); load('pnl', m); }} />`
        : tab === 'cash' ? html`<${Cash} data=${data} act=${act} busy=${busy} />`
        : tab === 'close' ? html`<${Close} data=${data} act=${act} busy=${busy} />`
        : html`<${Setup} data=${data} act=${act} busy=${busy} />`}
    </div>`;
}

function Health({ h }) {
  const notes = [];
  if (!h.mercury) notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>Mercury isn’t connected yet.</strong> Once MERCURY_API_TOKEN is in Cloudflare, the site reads Mercury back to January last year by itself, a few thousand transactions every 15 minutes.</div></div>`);
  else if (!h.history.doneAt) notes.push(html`<div class="notice"><div class="notice__body"><strong>Reading Mercury’s history.</strong> ${h.history.read ? `${h.history.read.toLocaleString()} transactions so far${h.history.reachedTo ? `, up to ${new Date(h.history.reachedTo).toLocaleDateString()}` : ''}.` : 'Starting within 15 minutes.'} Earlier months fill in as it goes.${h.history.error ? ` Last try: ${h.history.error}` : ''}</div></div>`);
  if (h.balancesError) notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>Mercury’s balances couldn’t be read</strong> (${ago(h.balancesError.at)}): ${h.balancesError.error}</div></div>`);
  if (h.cpaError) notes.push(html`<div class="notice notice--warn"><div class="notice__body"><strong>${monthName(h.cpaError.month)}’s packet didn’t reach the CPA:</strong> ${h.cpaError.error}. It tries again within the hour.</div></div>`);
  return notes;
}

// ─── P&L ────────────────────────────────────────────────────────────

function Pnl({ data, act, busy, onMonth }) {
  const r = data.pnl;
  const [period, setPeriod] = useState('month');
  const p = period === 'month' ? (r.closed?.snapshot || r.periods.month) : r.periods.ytd;
  const before = period === 'month' ? r.periods.lastYearMonth : r.periods.lastYtd;
  const yearsBack = before.count > 0;
  const lineRow = (label, c, cls = '', last = null) => html`<tr class=${cls}>
    <td>${label}</td>
    ${COLS.map(([k]) => html`<td class="fi-hide-sm">${dash(c[k])}</td>`)}
    <td>${dash(c.total)}</td>
    <td class="fi-hide-sm fi-muted">${last === null ? '' : dash(last)}</td>
  </tr>`;
  const lastOf = (list, key, field) => (yearsBack ? (list.find((x) => x[field] === key)?.cents.total || 0) : null);
  const names = r.jobNames || {};
  return html`
    <div class="fi-row">
      <label class="sr-only" for="fi-month">Month</label>
      <select id="fi-month" class="form-input" style="width:auto" value=${r.month} onChange=${(e) => onMonth(e.target.value)}>
        ${data.months.map((m) => html`<option value=${m}>${monthName(m)}</option>`)}
      </select>
      <div class="seg" role="tablist" aria-label="Period">
        <button role="tab" aria-selected=${period === 'month'} onClick=${() => setPeriod('month')}>${r.label}</button>
        <button role="tab" aria-selected=${period === 'ytd'} onClick=${() => setPeriod('ytd')}>Year to date</button>
      </div>
      <a class="btn btn-ghost btn-sm" href=${`${API}?view=csv&month=${r.month}`} download>Download CSV</a>
    </div>
    ${r.closed && period === 'month' ? html`<div class="notice"><div class="notice__body"><strong>${r.label} is closed.</strong> These are the numbers as they stood when it was closed${r.closed.by ? ` by ${r.closed.by}` : ''} on ${new Date(r.closed.at).toLocaleDateString()}. Reopen it in Close to see them move again.</div></div>` : null}
    <div class="fi-tiles">
      <div class="fi-tile"><span>Money in</span><strong>${usd(p.incomeTotal.total)}</strong><small>${change(p.incomeTotal.total, before.incomeTotal.total) || 'Nothing to compare with last year yet'}</small></div>
      <div class="fi-tile"><span>Spent</span><strong>${usd(p.expenseTotal.total)}</strong><small>${change(p.expenseTotal.total, before.expenseTotal.total) || ' '}</small></div>
      <div class="fi-tile"><span>Makeovers cost</span><strong>${usd(p.expenseTotal.job)}</strong><small>${p.jobs.filter((j) => j.jobId).length} makeover${p.jobs.filter((j) => j.jobId).length === 1 ? '' : 's'} spent money</small></div>
      <div class="fi-tile"><span>Left over</span><strong>${usd(p.net.total)}</strong><small>Money in minus spent</small></div>
    </div>
    ${p.unsorted.cents ? html`<div class="notice notice--warn"><div class="notice__body"><strong>${usd(p.unsorted.cents)} isn’t sorted yet</strong> (${p.unsorted.count} charge${p.unsorted.count === 1 ? '' : 's'}). It’s in the total, on its own line, until someone says whether it was a makeover, the store or operating.</div><div class="notice__actions"><a class="btn btn-ghost btn-sm" href="#job-costs/charges">Sort them</a></div></div>` : null}
    <div class="card">
      <div class="fi-table-wrap">
        <table class="fi-table">
          <caption class="sr-only">${period === 'month' ? r.label : 'Year to date'} P&L by column</caption>
          <thead><tr><th scope="col">Line</th>${COLS.map(([, l]) => html`<th scope="col" class="fi-hide-sm">${l}</th>`)}<th scope="col">Total</th><th scope="col" class="fi-hide-sm">Last year</th></tr></thead>
          <tbody>
            <tr class="is-head"><td colspan="6">Money in</td></tr>
            ${p.income.length ? p.income.map((l) => lineRow(l.label, l.cents, '', lastOf(before.income, l.key, 'key'))) : html`<tr><td colspan="6" class="fi-muted">Nothing came in.</td></tr>`}
            ${lineRow('Total money in', p.incomeTotal, 'is-total', yearsBack ? before.incomeTotal.total : null)}
            <tr class="is-head"><td colspan="6">Spent</td></tr>
            ${p.expenses.map((l) => lineRow(l.category, l.cents, '', lastOf(before.expenses, l.category, 'category')))}
            ${p.unsorted.cents ? html`<tr class="is-unsorted"><td>Not sorted yet (${p.unsorted.count})</td>${COLS.map(() => html`<td class="fi-hide-sm" />`)}<td>${usd(p.unsorted.cents)}</td><td class="fi-hide-sm" /></tr>` : null}
            ${lineRow('Total spent', p.expenseTotal, 'is-total', yearsBack ? before.expenseTotal.total : null)}
            ${lineRow('Left over', p.net, 'is-net', yearsBack ? before.net.total : null)}
          </tbody>
        </table>
      </div>
    </div>
    <p class="sec-head__hint" style="margin:0">Gifts aren’t tied to one makeover, so donations sit under Operating; the Makeovers column is what makeovers cost. Moving money between SOARD’s own accounts and paying off the Mercury card aren’t counted, so nothing counts twice. On a phone, the Total column shows; turn sideways or use a computer for all three.</p>
    <div class="fi-tiles" style="grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr))">
      <div class="card">
        <div class="sec-head"><h3>Makeovers ${period === 'month' ? `in ${r.label}` : 'this year'}</h3></div>
        ${p.jobs.length ? html`<ul class="fi-list">${p.jobs.map((j) => html`<li key=${j.jobId || 'none'}><div><strong>${j.jobId ? names[j.jobId] || 'A makeover' : 'Makeover spending not on one job yet'}</strong></div><span class="fi-mono">${usd(j.cents)}</span></li>`)}</ul>`
          : html`<div class="empty">No makeover spending.</div>`}
      </div>
      <div class="card">
        <div class="sec-head"><h3>What a finished makeover costs</h3></div>
        ${r.perMakeover ? html`<div class="fi-body">
          <p style="margin:0 0 .5rem"><strong style="font-size:var(--fs-xl)">${usd(r.perMakeover.averageCents)}</strong> on average, across ${r.perMakeover.count} makeover${r.perMakeover.count === 1 ? '' : 's'} finished this year.</p>
          <ul class="fi-list">${r.perMakeover.jobs.map((j) => html`<li key=${j.jobId}><div><strong>${j.name}</strong></div><span class="fi-mono">${usd(j.cents)}</span></li>`)}</ul>
          <p class="sec-head__hint">${r.perMakeover.from === 'closeouts' ? 'From each makeover’s close-out in Job Costs.' : 'From Mercury spending on makeovers that are no longer open in JobTread.'}</p>
        </div>` : html`<div class="empty">No finished makeovers this year yet.</div>`}
      </div>
    </div>
    <${Sources} r=${r} act=${act} busy=${busy} />`;
}

function Sources({ r, act, busy }) {
  if (!r.sources.length) return null;
  return html`<div class="card">
    <div class="sec-head"><div><h3>Who sends money in</h3><p class="sec-head__hint">The last 12 months. The site guesses from the name (Zeffy is donations, Shopify is store sales, a paper check is a gift); pick another and it sticks.</p></div></div>
    <ul class="fi-list">
      ${r.sources.map((s) => html`<li key=${s.key}>
        <div><strong>${s.name}</strong><small>${usd(s.cents)} · ${s.count} deposit${s.count === 1 ? '' : 's'}${s.picked ? ' · picked by staff' : ''}</small></div>
        <div>
          <label class="sr-only" for=${`src-${s.key}`}>What money from ${s.name} is</label>
          <select id=${`src-${s.key}`} class="form-input" style="width:auto" value=${s.kind} disabled=${!!busy}
            onChange=${(e) => act({ action: 'income-source', key: s.key, kind: e.target.value, month: r.month }, `${s.name}: ${KINDS.find(([k]) => k === e.target.value)?.[1]}`)}>
            ${KINDS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}
          </select>
        </div>
      </li>`)}
    </ul>
  </div>`;
}

// ─── Cash ───────────────────────────────────────────────────────────

function Chart({ f }) {
  const W = 720;
  const H = 240;
  const pad = { l: 56, r: 12, t: 12, b: 26 };
  const pts = [{ start: f.today, likely: f.startCents, low: f.startCents, high: f.startCents }, ...f.weeks];
  const vals = pts.flatMap((p) => [p.low, p.high]).concat([f.floorCents, 0]);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const x = (i) => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / Math.max(1, max - min)) * (H - pad.t - pad.b);
  const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
  const band = `${pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.high).toFixed(1)}`).join('')}${pts.slice().reverse().map((p, i) => `L${x(pts.length - 1 - i).toFixed(1)},${y(p.low).toFixed(1)}`).join('')}Z`;
  const ticks = [min, (min + max) / 2, max];
  return html`<svg class="fi-chart" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${`Cash over the next 13 weeks: likely ${usd(f.end.likely)} at the end, lowest ${usd(f.lowest.likely.cents)} the week of ${weekName(f.lowest.likely.week)}`}>
    ${ticks.map((t) => html`<g><line x1=${pad.l} x2=${W - pad.r} y1=${y(t)} y2=${y(t)} stroke="var(--color-border)" /><text x=${pad.l - 6} y=${y(t) + 4} text-anchor="end">${usd(t)}</text></g>`)}
    <path d=${band} fill="var(--tone-neutral-bg)" />
    <line x1=${pad.l} x2=${W - pad.r} y1=${y(f.floorCents)} y2=${y(f.floorCents)} stroke="var(--tone-warn-dot)" stroke-dasharray="5 4" stroke-width="1.5" />
    <path d=${line('low')} fill="none" stroke="var(--color-text-muted)" stroke-width="1.25" stroke-dasharray="2 3" />
    <path d=${line('likely')} fill="none" stroke="var(--color-text)" stroke-width="2.25" />
    ${pts.map((p, i) => (i % 2 === 0 ? html`<text x=${x(i)} y=${H - 6} text-anchor="middle">${weekName(p.start)}</text>` : null))}
  </svg>`;
}

function Cash({ data, act, busy }) {
  const f = data.cash;
  const [floor, setFloor] = useState(Math.round(f.floorCents / 100));
  useEffect(() => { setFloor(Math.round(f.floorCents / 100)); }, [f.floorCents]);
  if (!f.balances) {
    return html`<div class="empty">The forecast starts from Mercury’s balances, so it shows once Mercury is connected.</div>`;
  }
  const s = f.sources;
  return html`
    ${f.belowFloor ? html`<div class="notice notice--warn"><div class="notice__body"><strong>On the cautious line, cash dips under ${usd(f.floorCents)} the week of ${weekName(f.belowFloor.week)}</strong> (to ${usd(f.belowFloor.cents)}). The Finance channel heard once; it hears again when the forecast is back above the floor.</div></div>` : null}
    <div class="fi-tiles">
      <div class="fi-tile"><span>Cash today</span><strong>${usd(f.startCents)}</strong><small>${f.owedCents ? `${usd(f.owedCents)} owed on the card` : 'Nothing owed on the card'} · ${ago(f.balances.at)}</small></div>
      <div class="fi-tile"><span>Lowest point, likely</span><strong>${usd(f.lowest.likely.cents)}</strong><small>Week of ${weekName(f.lowest.likely.week)}</small></div>
      <div class="fi-tile"><span>Lowest point, cautious</span><strong>${usd(f.lowest.low.cents)}</strong><small>Week of ${weekName(f.lowest.low.week)}</small></div>
      <div class="fi-tile"><span>In 13 weeks, likely</span><strong>${usd(f.end.likely)}</strong><small>Between ${usd(f.end.low)} and ${usd(f.end.high)}</small></div>
    </div>
    <div class="card"><div class="fi-body">
      <${Chart} f=${f} />
      <div class="fi-key" style="margin-top:.5rem">
        <span><i style="background: var(--color-text)" />Likely</span>
        <span><i style="background: var(--tone-neutral-bg); border: 1px solid var(--color-border)" />Between cautious and hopeful</span>
        <span><i style="background: repeating-linear-gradient(90deg, var(--color-text-muted) 0 2px, transparent 2px 5px)" />Cautious</span>
        <span><i style="background: repeating-linear-gradient(90deg, var(--tone-warn-dot) 0 5px, transparent 5px 9px)" />Cash floor</span>
      </div>
    </div></div>
    <div class="card">
      <div class="sec-head"><h3>Where these numbers come from</h3></div>
      <div class="fi-body">
        <ol class="fi-sources">
          <li><strong>Cash today:</strong> Mercury checking, savings and treasury right now${f.balances.accounts?.length ? ` (${f.balances.accounts.map((a) => `${a.name} ${usd(a.cents)}`).join(', ')})` : ''}. What’s owed on the Mercury card leaves in week 2.</li>
          <li><strong>Money in:</strong> a typical week brings ${usd(s.incomeWeekly.likely)} (the middle week of the last 26, counting weeks with no gift at all), mixed with the same week last year and the year before, so year-end giving and the gala show up when they came before. Cautious uses a slow week (${usd(s.incomeWeekly.low)}), hopeful a good one (${usd(s.incomeWeekly.high)}).</li>
          <li><strong>Makeovers already going:</strong> ${usd(s.makeoversCents)} still to spend on ${s.makeoverCount} job${s.makeoverCount === 1 ? '' : 's'} (each job’s budget, or its forecast if higher, minus what’s spent), spread over 3 weeks in Build, 6 in Mobilization and 10 in Approval.</li>
          ${s.unbudgetedCount ? html`<li><strong>Makeovers with no budget yet:</strong> ${s.unbudgetedCount}, each counted at ${usd(s.averageMakeoverCents)} ${data.cash.averageFrom === 'budgets' ? '(the average budget of open jobs)' : '(what a finished makeover cost on average)'}.</li>` : null}
          <li><strong>Running SOARD:</strong> ${usd(s.operatingWeekly)} a week, from the middle of the last 3 months of operating spending (one odd month doesn’t move it). <strong>The store:</strong> ${usd(s.storeWeekly)} a week, the same way.</li>
          <li><strong>Cautious and hopeful:</strong> cautious also spends 10% more than planned, hopeful 10% less. Only the cautious line is checked against the floor.</li>
        </ol>
      </div>
    </div>
    <div class="card"><div class="fi-body">
      <form class="fi-row" onSubmit=${(e) => { e.preventDefault(); act({ action: 'settings', floorCents: Math.round(Number(floor) * 100) }, 'Cash floor saved. The forecast checks it within 15 minutes.'); }}>
        <label class="fi-field"><span>Cash floor</span>
          <input class="form-input" type="number" min="0" step="1000" inputmode="numeric" value=${floor} onInput=${(e) => setFloor(e.target.value)} />
        </label>
        <button class="btn btn-primary" type="submit" style="align-self:end" disabled=${!!busy || Math.round(Number(floor) * 100) === f.floorCents}>Save</button>
      </form>
      <p class="sec-head__hint">The least cash SOARD should hold. When the cautious line dips under it, the Finance channel hears once.</p>
    </div></div>
    <details class="card">
      <summary class="fi-body" style="cursor:pointer;font-weight:600">Week by week</summary>
      <div class="fi-table-wrap">
        <table class="fi-table">
          <thead><tr><th scope="col">Week of</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Cash, likely</th><th scope="col" class="fi-hide-sm">Cautious</th><th scope="col" class="fi-hide-sm">Hopeful</th></tr></thead>
          <tbody>${f.weeks.map((w) => html`<tr><td>${weekName(w.start)}</td><td>${dash(w.inLikely)}</td><td>${dash(w.out)}</td><td>${usd(w.likely)}</td><td class="fi-hide-sm">${usd(w.low)}</td><td class="fi-hide-sm">${usd(w.high)}</td></tr>`)}</tbody>
        </table>
      </div>
    </details>`;
}

// ─── Close ──────────────────────────────────────────────────────────

const STATE = { ok: ['dot--on', 'Done'], todo: ['dot--warn', 'To do'], na: ['', 'Not yet'], unknown: ['dot--warn', 'Couldn’t check'] };

function Close({ data, act, busy }) {
  const list = data.close || [];
  const s = data.settings || {};
  if (!list.length) return html`<div class="empty">No month to close yet. Last month shows here from the 1st.</div>`;
  return html`${list.map((m) => {
    const todo = m.checks.filter((c) => c.state === 'todo' || c.state === 'unknown').length;
    return html`<div class="card" key=${m.month}>
      <div class="sec-head">
        <div>
          <h3>${m.label} ${m.closed ? html`<span class="tag">Closed</span>` : m.ready ? html`<span class="tag tag--success">Ready to close</span>` : html`<span class="tag tag--warn">${todo} to do</span>`}</h3>
          <p class="sec-head__hint">${m.closed ? `Closed${m.closed.by ? ` by ${m.closed.by}` : ''} on ${new Date(m.closed.at).toLocaleDateString()}. Its P&L is frozen.`
            : m.ready ? (s.cpaEmail ? `Every check passed. The P&L went to ${s.cpaEmail} with the CSV.` : 'Every check passed. Add the CPA’s email in Setup and ready months go to them by themselves.')
            : 'Checked every hour. When all pass, the Finance channel hears once and the CPA gets the P&L.'}</p>
        </div>
      </div>
      ${m.checks.map((c) => html`<div class="fi-check" key=${c.key}>
        <span class=${`dot ${STATE[c.state][0]}`} aria-hidden="true" />
        <div><strong>${c.label}</strong><small><span class="sr-only">${STATE[c.state][1]}: </span>${c.detail}</small></div>
        ${c.state === 'todo' && c.link ? html`<${FixLink} url=${c.link} />` : html`<span />`}
      </div>`)}
      <div class="fi-body fi-row" style="border-top:1px solid var(--color-border)">
        ${m.closed
          ? html`<button class="btn btn-ghost" disabled=${!!busy} onClick=${async () => { if (await ask({ title: `Reopen ${m.label}?`, text: 'Its P&L moves again with any late changes until it’s closed again.', yes: 'Reopen' })) act({ action: 'reopen', month: m.month }, `${m.label} reopened`); }}>Reopen</button>`
          : html`<button class="btn btn-primary" disabled=${!!busy || !m.ended} onClick=${async () => { if (await ask({ title: `Close ${m.label}?`, text: m.ready ? 'Its P&L is frozen as it is now. It can be reopened.' : `${todo} check${todo === 1 ? ' hasn’t' : 's haven’t'} passed yet. Its P&L is frozen as it is now; it can be reopened.`, yes: 'Close the month' })) act({ action: 'close', month: m.month }, `${m.label} closed`); }}>Close ${m.label}</button>`}
        <button class="btn btn-ghost" disabled=${!!busy} onClick=${() => act({ action: 'preview-close', month: m.month }, (j) => `Sent to ${j.sentTo}. Check your inbox.`)}>Send the CPA’s email to me</button>
      </div>
    </div>`;
  })}`;
}

// Admin links stay in this tab; Mercury opens in a new one
function FixLink({ url }) {
  const inside = url.match(/\/admin\/(#.*)$/);
  return inside
    ? html`<a class="btn btn-ghost btn-sm" href=${inside[1]}>Fix</a>`
    : html`<a class="btn btn-ghost btn-sm" href=${url} target="_blank" rel="noopener">Fix<span class="sr-only"> (opens Mercury)</span></a>`;
}

// ─── Setup ──────────────────────────────────────────────────────────

function Setup({ data, act, busy }) {
  const s = data.settings || {};
  const [cpa, setCpa] = useState(s.cpaEmail || '');
  const [reply, setReply] = useState(s.replyTo || '');
  const changed = cpa.trim().toLowerCase() !== (s.cpaEmail || '') || reply.trim().toLowerCase() !== (s.replyTo || '');
  return html`<div class="card"><div class="fi-body">
    <form style="display:grid;gap:1rem" onSubmit=${(e) => { e.preventDefault(); act({ action: 'settings', cpaEmail: cpa, replyTo: reply }, 'Saved'); }}>
      <label class="fi-field"><span>The CPA’s email</span>
        <input class="form-input" type="email" autocomplete="off" value=${cpa} onInput=${(e) => setCpa(e.target.value)} placeholder="name@firm.com" />
        <small class="form-hint">When a month passes every close check, its P&L and a CSV of every transaction go here once. Leave it empty and nothing is sent.</small>
      </label>
      <label class="fi-field"><span>Replies go to</span>
        <input class="form-input" type="email" autocomplete="off" value=${reply} onInput=${(e) => setReply(e.target.value)} placeholder="peter@soardcharity.com" />
        <small class="form-hint">Who hears it when the CPA replies.</small>
      </label>
      <div class="fi-row"><button class="btn btn-primary" type="submit" disabled=${!!busy || !changed}>Save</button></div>
    </form>
    ${!data.health?.email ? html`<p class="sec-head__hint">Email isn’t set up on the site (RESEND_API_KEY), so nothing can be sent yet.</p>` : null}
    <p class="sec-head__hint">Money alerts post in the Finance channel, picked in Reveals → Settings → Alerts. Without one they stay here.</p>
  </div></div>`;
}
