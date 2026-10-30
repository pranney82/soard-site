/**
 * Admin → Job Costs → Insurance audit: the subcontractors SOARD paid in a
 * workers' comp policy term, and the insurance that covered each payment
 * ===========================================================================
 * Over /api/insurance-audit-admin (functions/api/_insurance-audit.js).
 * Nothing here has to be pressed: payments are read every day, certificates
 * arrive from the certificate search, and subs with a gap are emailed on
 * their own. People look, download the spreadsheet or the auditor's packet,
 * and can make a call on a payee the site counted wrong (works off site,
 * one person with no employees, sells materials only).
 */

import { h, htm, useState, useEffect, useRef } from './vendor.js';
import { float } from './float.js';

const html = htm.bind(h);
const API = '/api/insurance-audit-admin';

async function call(query, body = null) {
  let r;
  try {
    r = await fetch(API + query, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { success: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  return j;
}

const usd = (c) => (Number(c || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const day = (d) => (d ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const month = (ym) => new Date(`${ym}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const months = (list) => list.map(month).join(', ');
const FROM = { jobtread: 'JobTread', ramp: 'Ramp', mercury: 'Mercury' };
const LEAVE = [['off-site', 'Leave out: works off site'], ['no-employees', 'Leave out: one person, no employees'], ['materials', 'Leave out: sells materials only']];

const CSS = `
.ia { display: grid; gap: 1rem; }
.ia-top { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: .75rem 1.5rem; }
.ia-top h3 { margin: 0 0 .25rem; font-size: var(--fs-lg); }
.ia-lead { margin: 0; max-width: 62ch; font-size: var(--fs-sm); color: var(--color-text-secondary); line-height: 1.5; }
.ia-downloads { display: flex; flex-wrap: wrap; gap: .5rem; }
.ia-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .75rem; }
.ia-list { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
.ia-head, .ia-row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1.1fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1.3fr) 44px; gap: 1rem; align-items: start; padding: .85rem 1rem; }
.ia-head { padding: .5rem 1rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--color-text-secondary); border-bottom: 1px solid var(--color-border); }
.ia-item + .ia-item { border-top: 1px solid var(--color-border); }
.ia-cell { display: flex; flex-direction: column; align-items: flex-start; gap: .25rem; min-width: 0; font-size: var(--fs-sm); }
.ia-cell > * { max-width: 100%; }
.ia-name { font-weight: 600; font-size: var(--fs-base); overflow-wrap: anywhere; }
.ia-sub { font-size: var(--fs-xs); color: var(--color-text-secondary); line-height: 1.45; overflow-wrap: anywhere; }
.ia-num { font-variant-numeric: tabular-nums; font-weight: 600; }
.ia-link { padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-xs); color: var(--color-text); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; min-height: 24px; }
.ia-link:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); border-radius: 4px; }
.ia-pays { margin: 0 1rem .9rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm, 8px); overflow-x: auto; }
.ia-pays table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.ia-pays th, .ia-pays td { text-align: left; padding: .45rem .65rem; border-top: 1px solid var(--color-border); white-space: nowrap; }
.ia-pays th { border-top: 0; font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: .06em; color: var(--color-text-secondary); }
.ia-pays td.num { text-align: right; font-variant-numeric: tabular-nums; }
.ia-more { width: 44px; height: 44px; display: inline-grid; place-items: center; border: 1px solid transparent; border-radius: 10px; background: none; font: inherit; font-size: 1.15rem; line-height: 1; color: var(--color-text-secondary); cursor: pointer; }
.ia-more:hover, .ia-more[aria-expanded="true"] { background: var(--color-bg-secondary); color: var(--color-text); }
.ia-more:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.ia-menu { min-width: 260px; padding: .3rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); box-shadow: var(--shadow-lg, 0 12px 32px rgba(26,27,31,.16)); display: grid; }
.ia-menu button { display: block; width: 100%; min-height: 44px; padding: .55rem .75rem; border: 0; border-radius: 8px; background: none; font: inherit; font-size: var(--fs-sm); text-align: left; color: var(--color-text); cursor: pointer; }
.ia-menu button:hover, .ia-menu button:focus-visible { outline: none; background: var(--color-bg-secondary); }
.ia-out > summary { cursor: pointer; padding: .75rem 0; font-weight: 600; min-height: 44px; display: flex; align-items: center; gap: .5rem; }
.ia-out > summary:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); border-radius: 6px; }
.ia-foot { margin: 0; font-size: var(--fs-xs); color: var(--color-text-secondary); line-height: 1.5; }
@media (max-width: 1100px) { .ia-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 860px) {
  .ia-head { display: none; }
  .ia-row { grid-template-columns: minmax(0, 1fr) 44px; gap: .5rem .75rem; }
  .ia-row > .ia-cell:not(:first-child) { grid-column: 1; }
  .ia-row > .ia-more { grid-row: 1; grid-column: 2; }
  .ia-row > .ia-cell[data-label]::before { content: attr(data-label); font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--color-text-secondary); }
}
@media (max-width: 520px) { .ia-stats { grid-template-columns: 1fr; } .ia-downloads { width: 100%; } .ia-downloads .btn { flex: 1 1 auto; justify-content: center; } }`;

let styled = false;
function useStyles() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.module = 'insurance-audit';
  el.textContent = CSS;
  document.head.append(el);
}

export function InsuranceAudit({ addToast = () => {} }) {
  useStyles();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [termId, setTermId] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async (id) => {
    setErr(null);
    const j = await call(id ? `?term=${encodeURIComponent(id)}` : '');
    if (!j.success) { setErr(j.error || 'Couldn’t put the audit together'); return; }
    setData(j);
    setTermId(j.audit.term.id);
  };
  useEffect(() => { load(null); }, []);

  const decide = async (r, reason) => {
    setBusy(true);
    const j = await call('', { action: 'call', term: data.audit.term.id, key: r.key, jtId: r.jtId, name: r.name, reason });
    setBusy(false);
    if (!j.success) { addToast(j.error || 'That didn’t work', 'error'); return; }
    setData(j);
    addToast(reason === 'clear' ? `${r.name}: back to how the site counts them` : `${r.name}: ${j.audit.rows.find((x) => x.key === r.key)?.sub ? 'counted' : 'left out'}`, 'success');
  };

  if (err && !data) {
    return html`<div class="notice notice--warn"><div class="notice__body"><strong>Couldn’t put the audit together:</strong> ${err}</div>
      <div class="notice__actions"><button class="btn btn-ghost" onClick=${() => load(termId)}>Try again</button></div></div>`;
  }
  if (!data) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;

  const a = data.audit;
  const t = a.totals;
  const subs = a.rows.filter((r) => r.sub);
  const out = a.rows.filter((r) => !r.sub);
  const q = `?term=${a.term.id}`;
  const src = a.sources || {};
  const notes = [];
  if (src.jobtread && !src.jobtread.ok && src.jobtread.connected) notes.push(`JobTread didn’t answer (${src.jobtread.error}), so its bills aren’t in this yet. It’s read again within a day.`);
  if (src.jobtreadPayments && !src.jobtreadPayments.ok && src.jobtreadPayments.connected) notes.push('JobTread’s payment dates couldn’t be read, so its bills are dated by the bill.');
  if (src.ramp && !src.ramp.ok) notes.push(src.ramp.connected ? `Ramp didn’t answer (${src.ramp.error}), so the bills Ramp paid aren’t in this yet.` : 'Ramp isn’t connected, so bills Ramp paid count only when JobTread has them.');
  if (src.mercury && !src.mercury.ok && src.mercury.connected) notes.push(`Mercury didn’t answer (${src.mercury.error}), so its payments aren’t in this yet.`);

  return html`
    <section class="ia" aria-labelledby="ia-title">
      <div class="ia-top">
        <div>
          <h3 id="ia-title">Insurance audit</h3>
          <p class="ia-lead">Every subcontractor SOARD paid in the workers’ compensation policy term, and the insurance that covered each payment. The premium auditor adds what was paid to a subcontractor without workers’ compensation to SOARD’s payroll.</p>
        </div>
        <div class="ia-downloads">
          <a class="btn btn-ghost" href=${`${API}${q}&download=csv`} download>Spreadsheet</a>
          <a class="btn btn-primary" href=${`${API}${q}&download=packet`} download>Auditor’s packet (PDF)</a>
        </div>
      </div>
      <div class="seg" role="tablist" aria-label="Policy term">
        ${data.terms.map((x) => html`<button role="tab" aria-selected=${x.id === a.term.id} disabled=${busy} onClick=${() => { if (x.id !== a.term.id) { setData((d) => ({ ...d })); load(x.id); } }}>${x.short}</button>`)}
      </div>
      ${notes.map((n) => html`<div class="notice notice--warn"><div class="notice__body">${n}</div></div>`)}
      <div class="ia-stats">
        <div class="stat"><span class="stat__label">Paid to subcontractors without insurance</span><span class="stat__value">${usd(t.uninsuredCents)}</span>
          <span class=${`stat__note ${t.uninsuredSubs ? 'is-warn' : ''}`}>${t.uninsuredSubs ? `${t.uninsuredSubs} subcontractor${t.uninsuredSubs === 1 ? '' : 's'} without workers’ comp on those days` : 'Every payment had workers’ comp'}</span></div>
        <div class="stat"><span class="stat__label">Paid to insured subcontractors</span><span class="stat__value">${usd(t.insuredCents)}</span><span class="stat__note">${t.subs} subcontractor${t.subs === 1 ? '' : 's'} paid in all</span></div>
        <div class="stat"><span class="stat__label">Without general liability</span><span class="stat__value">${usd(t.glGapCents)}</span><span class="stat__note">${t.glGapSubs ? `${t.glGapSubs} subcontractor${t.glGapSubs === 1 ? '' : 's'}` : 'None'}</span></div>
        <div class="stat"><span class="stat__label">Not counted</span><span class="stat__value">${usd(t.leftOutCents)}</span><span class="stat__note">${t.leftOut} payee${t.leftOut === 1 ? '' : 's'}: stores, suppliers and the ones left out</span></div>
      </div>
      ${subs.length ? html`<div class="ia-list" role="list" aria-label="Subcontractors paid">
        <div class="ia-head" aria-hidden="true"><span>Subcontractor</span><span>Paid in the term</span><span>Workers’ comp</span><span>General liability</span><span>Certificate</span><span></span></div>
        ${subs.map((r) => html`<${Row} key=${r.key} r=${r} busy=${busy} onDecide=${decide} />`)}
      </div>` : html`<div class="notice"><div class="notice__body">No subcontractor payments in ${a.term.short} yet.</div></div>`}
      ${out.length ? html`<details class="ia-out">
        <summary>Paid and not counted as subcontractors <span class="count">${out.length}</span></summary>
        <div class="ia-list" role="list" aria-label="Paid and not counted">
          <div class="ia-head" aria-hidden="true"><span>Payee</span><span>Paid in the term</span><span>Why</span><span></span><span></span><span></span></div>
          ${out.map((r) => html`<${Row} key=${r.key} r=${r} busy=${busy} onDecide=${decide} />`)}
        </div>
      </details>` : null}
      <p class="ia-foot">Payments read from JobTread, Ramp and Mercury ${when(a.builtAt)}, and again every day. Certificates come from the staff inboxes and JobTread as they’re found. A subcontractor paid on days none covers is emailed for it once, a week later.</p>
    </section>`;
}

function Cover({ c }) {
  if (!c.cents) {
    const s = c.shown;
    return html`<span class="tag tag--success">${s?.exempt ? 'Exempt' : 'Covered'}</span>${s && !s.exempt ? html`<span class="ia-sub">${s.insurer || (s.source === 'jobtread' ? 'End date in JobTread' : 'Certificate')}${s.expires ? `, through ${day(s.expires)}` : ''}</span>` : null}`;
  }
  return html`<span class="tag tag--warn">${usd(c.cents)} not covered</span><span class="ia-sub">${months(c.months)}</span>`;
}

function Row({ r, busy, onDecide }) {
  const [open, setOpen] = useState(false);
  const items = [
    ...(r.sub ? LEAVE.filter(([k]) => r.call?.reason !== k) : r.call?.reason === 'sub' ? [] : [['sub', 'Count as a subcontractor']]),
    ...(r.call ? [['clear', `Undo “${r.call.label}”`]] : []),
  ];
  const cert = r.asked ? `Asked ${day(r.asked.sentAt)}${r.asked.toKind === 'agent' ? ', their agent' : ''}`
    : r.files.length ? `${r.files.length === 1 ? 'Certificate' : `${r.files.length} certificates`} on file`
    : (r.wc.cents || r.gl.cents) && !r.email && !r.agentEmail ? 'None, and no email in JobTread to ask' : r.wc.cents || r.gl.cents ? 'None yet' : 'On file in JobTread';
  return html`<div class="ia-item" role="listitem">
    <div class="ia-row">
      <div class="ia-cell">
        <span class="ia-name">${r.name}</span>
        <span class="ia-sub">${r.why}${r.inJobTread ? '' : ' · not a JobTread vendor'}</span>
        <button class="ia-link" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? 'Hide' : 'Show'} ${r.count} payment${r.count === 1 ? '' : 's'}</button>
      </div>
      <div class="ia-cell" data-label="Paid in the term"><span class="ia-num">${usd(r.paidCents)}</span><span class="ia-sub">${r.first === r.last ? day(r.first) : `${day(r.first)} to ${day(r.last)}`}</span></div>
      ${r.sub ? html`
        <div class="ia-cell" data-label="Workers’ comp"><${Cover} c=${r.wc} /></div>
        <div class="ia-cell" data-label="General liability"><${Cover} c=${r.gl} /></div>
        <div class="ia-cell" data-label="Certificate"><span class="ia-sub">${cert}</span></div>`
      : html`<div class="ia-cell" data-label="Why"><span class="ia-sub">${r.why}</span></div><div class="ia-cell"></div><div class="ia-cell"></div>`}
      ${items.length ? html`<${More} label=${`More for ${r.name}`} items=${items} disabled=${busy} onPick=${(k) => onDecide(r, k)} />` : html`<span></span>`}
    </div>
    ${open ? html`<div class="ia-pays"><table>
      <thead><tr><th>Paid</th><th class="num">Amount</th><th>From</th><th>Workers’ comp</th><th>General liability</th></tr></thead>
      <tbody>${r.payments.map((p) => html`<tr>
        <td>${day(p.date)}${p.dateFrom === 'bill' ? ' (bill date)' : ''}</td><td class="num">${usd(p.cents)}</td><td>${FROM[p.source] || p.source}${p.ref ? `, ${p.ref}` : ''}</td>
        <td>${p.wc.ok ? (p.wc.exempt ? 'Exempt' : 'Covered') : 'Not covered'}</td><td>${p.gl.ok ? 'Covered' : 'Not covered'}</td></tr>`)}</tbody>
    </table></div>` : null}
  </div>`;
}

/** The row's "⋯": a person's call on this payee, drawn over everything (./float.js) */
function More({ label, items, disabled, onPick }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const list = useRef(null);
  useEffect(() => {
    if (!open || !list.current) return undefined;
    const unfloat = float(list.current, { anchor: btn.current, align: 'end', onHide: () => setOpen(false) });
    list.current.querySelector('button')?.focus();
    const away = (e) => { if (!list.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    const key = (e) => {
      if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = [...list.current.querySelectorAll('button')];
      const i = all.indexOf(document.activeElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    };
    document.addEventListener('pointerdown', away, true);
    list.current.addEventListener('keydown', key);
    const el = list.current;
    return () => { unfloat?.(); document.removeEventListener('pointerdown', away, true); el.removeEventListener('keydown', key); };
  }, [open]);
  return html`<button class="ia-more" ref=${btn} aria-label=${label} title=${label} aria-haspopup="menu" aria-expanded=${open} disabled=${disabled} onClick=${() => setOpen(!open)}>⋯</button>
    ${open ? html`<div class="ia-menu" role="menu" aria-label=${label} ref=${list}>
      ${items.map(([k, text]) => html`<button type="button" role="menuitem" onClick=${() => { setOpen(false); btn.current?.focus(); onPick(k); }}>${text}</button>`)}
    </div>` : null}`;
}
