/**
 * Admin → Trade partners: the companies SOARD pays
 * ===========================================================================
 * Over /api/trade-partners-admin (functions/api/_trade-partners.js). JobTread
 * is the record: this is its vendors, with where each stands on its W-9,
 * insurance, setup and bank account, and the few things a person decides.
 *
 * Tabs (#trade-partners/<tab>, or #trade-partners/<jtId> for one partner):
 *   Partners      every JobTread vendor; find one, filter by what needs doing;
 *                 open one for its people, files, invoices and bank account
 *   Requests      "Work with us" from /trade-partners/: approve (a JobTread
 *                 vendor made and invited), match to one JobTread has, decline
 *   Bank changes  accounts a partner added or changed: call the number on
 *                 file, then confirm; their bills wait until someone does
 *   Settings      the insurance minimums, and the email a vendor gets
 * "Add a trade partner" invites a company: one JobTread has, or a new one.
 */

import { h, htm, useState, useEffect, useRef } from './vendor.js';
import { ask } from './ask.js';

const html = htm.bind(h);
const API = '/api/trade-partners-admin';
const TABS = [['partners', 'Partners'], ['requests', 'Requests'], ['bank', 'Bank changes'], ['settings', 'Settings']];
const FILTERS = [['all', 'All'], ['needs', 'Needs documents'], ['expiring', 'Expiring'], ['setup', 'Setting up'], ['held', 'Payments held'], ['suppliers', 'Suppliers']];

async function call(body, query = '') {
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
const day = (iso) => (iso ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const phoneText = (p) => (p ? String(p).replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') : '');
const STATUS = {
  current: ['Current', 'success'], expiring: ['Expiring soon', 'warn'], needs: ['Needs documents', 'warn'], 'not-needed': ['Not needed', ''], unknown: ['Not read yet', ''],
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
/** An insurance end date: through it, or ended (in amber) once it's past */
const ends = (iso) => (!iso ? 'Not on file' : iso < today() ? html`<span class="tag tag--warn">Ended ${day(iso)}</span>` : `Through ${day(iso)}`);
const INVOICE = { received: 'Received', review: 'Waiting for approval', approved: 'Approved', held: 'Held', sending: 'Being paid', paid: 'Paid', declined: 'Declined' };

const CSS = `
.tpm-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .75rem; margin: 0 0 1.25rem; }
.tpm-stats .stat[aria-pressed="true"] { border-color: var(--color-text); box-shadow: inset 0 0 0 1px var(--color-text); }
.tpm-tools { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin: 1rem 0; }
.tpm-tools .form-input { flex: 1 1 260px; max-width: 360px; }
.tpm-list { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); overflow: hidden; }
.tpm-row { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, .9fr) 24px; gap: 1rem; align-items: center; width: 100%; padding: .85rem 1rem; border: 0; border-top: 1px solid var(--color-border); background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; min-height: 60px; }
.tpm-row:first-child { border-top: 0; }
.tpm-row:hover { background: var(--color-bg-secondary); }
.tpm-row:focus-visible { outline: 2px solid var(--color-text); outline-offset: -2px; }
.tpm-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpm-sub { font-size: var(--fs-xs); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpm-cell { display: flex; flex-direction: column; gap: .2rem; min-width: 0; align-items: flex-start; }
.tpm-cell > * { max-width: 100%; }
.tpm-nowrap { white-space: nowrap; }
.tpm-wrap { white-space: normal; }
.tpm-chev { color: var(--color-text-muted); }
.tpm-head { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, .9fr) 24px; gap: 1rem; padding: .5rem 1rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--color-text-secondary); }
.tpm-card { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); padding: 1rem 1.1rem; display: grid; gap: .6rem; }
.tpm-cards { display: grid; gap: .75rem; }
.tpm-card h3 { margin: 0; font-size: var(--fs-lg); }
.tpm-kv { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: .35rem 1rem; font-size: var(--fs-sm); margin: 0; }
.tpm-kv dt { color: var(--color-text-secondary); }
.tpm-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.tpm-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.tpm-detail { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 1rem; align-items: start; }
.tpm-detail > div { display: grid; gap: 1rem; }
.tpm-back { margin: 1rem 0 .75rem; }
.tpm-files { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
.tpm-files li { display: flex; align-items: center; gap: .6rem; font-size: var(--fs-sm); }
.tpm-inv { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.tpm-inv th, .tpm-inv td { text-align: left; padding: .45rem .5rem; border-top: 1px solid var(--color-border); }
.tpm-inv th { font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: .06em; color: var(--color-text-secondary); border-top: 0; }
.tpm-inv td.num { text-align: right; font-variant-numeric: tabular-nums; }
.tpm-steps { display: flex; flex-wrap: wrap; gap: .4rem; }
.tpm-switch { display: flex; align-items: flex-start; gap: .75rem; font-weight: 400; }
.tpm-switch .bc-switch-track { margin-top: 2px; }
.tpm-switch--line { align-items: center; }
.tpm-switch--line .bc-switch-track { margin-top: 0; }
.tpm-note { font-size: var(--fs-sm); color: var(--color-text-secondary); margin: 0; line-height: 1.5; }
.tpm-pick { list-style: none; margin: .5rem 0 0; padding: 0; max-height: 260px; overflow: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.tpm-pick button { display: flex; justify-content: space-between; gap: .75rem; width: 100%; padding: .65rem .8rem; border: 0; border-top: 1px solid var(--color-border); background: none; font: inherit; text-align: left; cursor: pointer; min-height: 44px; }
.tpm-pick li:first-child button { border-top: 0; }
.tpm-pick button:hover, .tpm-pick button[aria-pressed="true"] { background: var(--color-bg-secondary); }
.tpm-form { display: grid; gap: .9rem; }
.tpm-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: .9rem; }
.tpm-field { display: grid; gap: .35rem; font-size: var(--fs-sm); }
.tpm-field > span { font-weight: 600; }
@media (max-width: 1100px) { .tpm-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } .tpm-detail { grid-template-columns: 1fr; } }
@media (max-width: 760px) {
  .tpm-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tpm-head { display: none; }
  .tpm-row { grid-template-columns: minmax(0, 1fr) 20px; gap: .35rem .75rem; }
  .tpm-row > .tpm-cell:not(:first-child) { grid-column: 1; flex-direction: row; flex-wrap: wrap; gap: .4rem; }
  .tpm-row > .tpm-chev { grid-row: 1; grid-column: 2; }
  .tpm-kv { grid-template-columns: 1fr; gap: .1rem; }
  .tpm-kv dd { margin-bottom: .45rem; }
  .tpm-grid2 { grid-template-columns: 1fr; }
}`;

let _css = false;
function useStyles() {
  if (_css) return;
  const el = document.createElement('style');
  el.dataset.module = 'trade-partners';
  el.textContent = CSS;
  document.head.append(el);
  _css = true;
}

function placeOf(hash = location.hash) {
  const parts = String(hash).replace(/^#/, '').split('/').slice(1).filter(Boolean).map((x) => decodeURIComponent(x));
  if (!parts[0]) return { tab: 'partners', id: null };
  if (TABS.some(([k]) => k === parts[0])) return { tab: parts[0], id: null };
  return { tab: 'partners', id: parts[0] };
}
function go(tab, id = null) {
  const next = `#trade-partners${id ? `/${encodeURIComponent(id)}` : tab && tab !== 'partners' ? `/${tab}` : ''}`;
  if (location.hash !== next) history.pushState(null, '', next);
}

let dlgSeq = 0;
/** The admin's shared dialog (its kd-dialog classes), as in advisory-applications.js */
function Dialog({ title, sub = '', children, footer = null, onClose, busy = false, size = 'md' }) {
  const ref = useRef(null);
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = `tpm-dlg-${++dlgSeq}`;
  const live = useRef({ busy, onClose });
  live.current = { busy, onClose };
  useEffect(() => {
    const prev = document.activeElement;
    document.body.classList.add('modal-open');
    const onKey = (e) => {
      if (e.key === 'Escape') { if (!live.current.busy) { e.preventDefault(); e.stopPropagation(); live.current.onClose(); } return; }
      if (e.key !== 'Tab') return;
      const f = [...(ref.current?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])') || [])].filter((el) => el.getClientRects().length);
      if (!f.length) return;
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === f[0])) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (!inside || document.activeElement === f[f.length - 1])) { e.preventDefault(); f[0].focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => (ref.current?.querySelector('[data-autofocus], .kd-dialog__body input, .kd-dialog__foot .btn-primary') || ref.current)?.focus());
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (document.querySelectorAll('.modal-overlay').length <= 1) document.body.classList.remove('modal-open');
      if (prev?.isConnected) prev.focus?.();
    };
  }, []);
  const id = idRef.current;
  return html`<div class="modal-overlay kd-overlay" onClick=${(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div class=${`modal kd-dialog kd-dialog--${size}`} role="dialog" aria-modal="true" aria-labelledby=${id} ref=${ref} tabindex="-1">
      <header class="kd-dialog__head">
        <div class="kd-dialog__titles"><h2 id=${id}>${title}</h2>${sub ? html`<p class="kd-dialog__sub">${sub}</p>` : null}</div>
        <button type="button" class="kd-x" aria-label="Close" onClick=${onClose} disabled=${busy}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </header>
      <div class="kd-dialog__body">${children}</div>
      ${footer ? html`<footer class="kd-dialog__foot">${footer}</footer>` : null}
    </div>
  </div>`;
}

// ─── The area ───────────────────────────────────────────────────────

export function TradePartners({ addToast = () => {} }) {
  useStyles();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [place, setPlace] = useState(placeOf);
  const [busy, setBusy] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    const j = await call(null);
    if (!j.success) { setErr(j.error || 'Could not load trade partners'); return; }
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
  const open = (tab, id = null) => { go(tab, id); setPlace({ tab, id }); window.scrollTo({ top: 0 }); };

  const act = async (body, done) => {
    setBusy(body.action + (body.jtId || body.id || ''));
    const j = await call(body);
    setBusy(null);
    if (!j.success) { addToast(j.error || 'That didn’t work', 'error'); return null; }
    if (j.partners) setData((d) => ({ ...d, ...j }));
    if (done) addToast(typeof done === 'function' ? done(j) : done, 'success');
    return j;
  };

  if (err && !data) {
    return html`<div class="notice notice--danger"><div class="notice__body"><strong>Couldn’t load trade partners:</strong> ${err}</div>
      <div class="notice__actions"><button class="btn btn-ghost" onClick=${load}>Try again</button></div></div>`;
  }
  if (!data) return html`<div class="area-loading"><span class="spinner" /></div>`;

  const newReqs = data.requests.filter((r) => r.status === 'new').length;
  const toConfirm = data.bank.filter((b) => b.status === 'pending').length;
  const counts = { requests: newReqs, bank: toConfirm };

  return html`
    <div class="tpm">
      <div class="page-header">
        <div>
          <h2>Trade partners</h2>
          <p class="page-sub">The companies SOARD pays: W-9s, insurance, setting up and bank accounts. JobTread is the record; partners keep theirs current on <a class="link" href="/trade-partners/" target="_blank" rel="noopener">their own page</a>.</p>
        </div>
        <div class="page-header__actions"><button class="btn btn-primary" onClick=${() => setAdding(true)}>Add a trade partner</button></div>
      </div>
      ${data.facts.fieldDupes?.length ? html`<div class="notice notice--warn" style="margin-bottom: 1rem;"><div class="notice__body">JobTread has two vendor fields named ${data.facts.fieldDupes.map((n) => `“${n}”`).join(', ')}. The site uses the first one in JobTread → Settings → Custom fields → Vendors; delete the other so answers land in one place.</div></div>` : null}
      ${data.facts.fieldSingle?.length ? html`<div class="notice notice--warn" style="margin-bottom: 1rem;"><div class="notice__body">JobTread’s ${data.facts.fieldSingle.map((n) => `“${n}”`).join(', ')} vendor field takes one answer, so only a partner’s first trade is kept. In JobTread → Settings → Custom fields → Vendors, let it take more than one.</div></div>` : null}
      <div class="seg" role="tablist" aria-label="Trade partners">
        ${TABS.map(([k, label]) => html`<button role="tab" aria-selected=${place.tab === k && !place.id} onClick=${() => open(k)}>${label}${counts[k] ? html` <span class="count is-warn">${counts[k]}</span>` : ''}</button>`)}
      </div>
      ${place.id ? html`<${Detail} id=${place.id} data=${data} act=${act} busy=${busy} onBack=${() => open('partners')} />`
        : place.tab === 'requests' ? html`<${Requests} data=${data} act=${act} busy=${busy} />`
        : place.tab === 'bank' ? html`<${Bank} data=${data} act=${act} busy=${busy} onOpen=${(id) => open('partners', id)} />`
        : place.tab === 'settings' ? html`<${Settings} data=${data} act=${act} busy=${busy} />`
        : html`<${Partners} data=${data} onOpen=${(id) => open('partners', id)} onTab=${open} />`}
      ${adding ? html`<${AddPartner} data=${data} act=${act} busy=${busy} onClose=${() => setAdding(false)} />` : null}
    </div>`;
}

// ─── Partners ───────────────────────────────────────────────────────

function Partners({ data, onOpen, onTab }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const all = data.partners;
  const n = {
    needs: all.filter((p) => p.status === 'needs' && !p.materials).length,
    expiring: all.filter((p) => p.status === 'expiring').length,
    setup: all.filter((p) => p.setup === 'started').length,
    held: all.filter((p) => p.held).length,
    suppliers: all.filter((p) => p.materials).length,
  };
  const heldCents = all.reduce((s, p) => s + (p.held?.cents || 0), 0);
  const words = q.trim().toLowerCase();
  const list = all.filter((p) => {
    if (filter === 'needs' && !(p.status === 'needs' && !p.materials)) return false;
    if (filter === 'expiring' && p.status !== 'expiring') return false;
    if (filter === 'setup' && p.setup !== 'started') return false;
    if (filter === 'held' && !p.held) return false;
    if (filter === 'suppliers' && !p.materials) return false;
    return !words || [p.name, p.email, ...(p.trades || [])].some((x) => String(x || '').toLowerCase().includes(words));
  });
  const stat = (k, label, value, note) => html`<button class="stat" aria-pressed=${filter === k} onClick=${() => setFilter(filter === k ? 'all' : k)}>
    <span class="stat__label">${label}</span><span class="stat__value">${value}</span>${note ? html`<span class="stat__note">${note}</span>` : null}</button>`;
  return html`
    <div class="tpm-stats" style="margin-top: 1rem;">
      ${stat('needs', 'Needs documents', n.needs, 'W-9 or insurance missing or ended')}
      ${stat('expiring', 'Expiring soon', n.expiring, 'Renewal asked ahead')}
      ${stat('setup', 'Setting up', n.setup, 'Invited, not finished')}
      ${stat('held', 'Payments held', n.held, n.held ? usd(heldCents) : 'None')}
      <button class="stat" onClick=${() => onTab('requests')}><span class="stat__label">Requests</span><span class="stat__value">${data.facts.requests}</span><span class="stat__note">${data.facts.bankToConfirm ? `${data.facts.bankToConfirm} bank account${data.facts.bankToConfirm === 1 ? '' : 's'} to confirm` : 'From the website'}</span></button>
    </div>
    <div class="tpm-tools">
      <input class="form-input" type="search" placeholder="Find a company, email or trade" aria-label="Find a trade partner" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <div class="seg" role="tablist" aria-label="Show">
        ${FILTERS.map(([k, label]) => html`<button role="tab" aria-selected=${filter === k} onClick=${() => setFilter(k)}>${label}${k !== 'all' && n[k] ? html` <span class="count">${n[k]}</span>` : ''}</button>`)}
      </div>
    </div>
    ${!all.length ? html`<div class="empty"><p class="empty__title">No vendors read from JobTread yet</p><p class="empty__text">They arrive within four hours of the site’s first run.</p></div>`
      : !list.length ? html`<div class="empty"><p class="empty__title">Nobody matches</p><p class="empty__text">Try another name, or show all of them.</p><div class="empty__actions"><button class="btn btn-ghost" onClick=${() => { setQ(''); setFilter('all'); }}>Show all</button></div></div>`
      : html`
        <div class="tpm-head" aria-hidden="true"><span>Company</span><span>Documents</span><span>Setup</span><span>Payments</span><span /></div>
        <div class="tpm-list">
          ${list.slice(0, 300).map((p) => {
            const [label, tone] = p.materials ? ['Supplier', ''] : STATUS[p.status] || STATUS.unknown;
            return html`<button class="tpm-row" key=${p.jtId} onClick=${() => onOpen(p.jtId)}>
              <span class="tpm-cell"><span class="tpm-name">${p.name}</span><span class="tpm-sub">${(p.trades || []).slice(0, 3).join(', ') || p.email || '—'}</span></span>
              <span class="tpm-cell"><span class=${`tag ${tone ? `tag--${tone}` : ''}`}>${label}</span>${p.status === 'needs' && !p.materials && p.staff ? html`<span class="tpm-sub">${p.staff}</span>` : p.asking ? html`<span class="tpm-sub">Asked ${p.asks}×</span>` : null}</span>
              <span class="tpm-cell">${p.setup === 'done' ? html`<span class="tag tag--success">Set up</span>` : p.setup === 'started' ? html`<span class="tag tag--info">Invited</span><span class="tpm-sub">${day(p.invitedAt)}</span>` : html`<span class="tpm-sub">—</span>`}</span>
              <span class="tpm-cell">${p.held ? html`<span class="tag tag--warn">${usd(p.held.cents)} held</span>` : null}${p.bank ? html`<span class="tpm-sub">••${p.bank.last4}${p.bank.status === 'pending' ? ' · to confirm' : ''}</span>` : !p.held ? html`<span class="tpm-sub">—</span>` : null}</span>
              <span class="tpm-chev" aria-hidden="true">›</span>
            </button>`;
          })}
        </div>
        ${list.length > 300 ? html`<p class="tpm-note" style="margin-top: .5rem;">Showing the first 300. Search to find the rest.</p>` : null}`}`;
}

// ─── One partner ────────────────────────────────────────────────────

function Detail({ id, data, act, busy, onBack }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  const load = async () => {
    const j = await call(null, `?vendor=${encodeURIComponent(id)}`);
    if (!j.success) { setErr(j.error || 'Could not read them from JobTread'); return; }
    setErr(null);
    setP(j.partner);
  };
  useEffect(() => { setP(null); load(); }, [id]);
  const row = data.partners.find((x) => x.jtId === id);
  const bank = data.bank.find((b) => b.jtId === id);

  if (err) return html`<div class="tpm-back"><button class="btn btn-ghost btn-sm" onClick=${onBack}>‹ All partners</button></div>
    <div class="notice notice--danger"><div class="notice__body">${err}</div><div class="notice__actions"><button class="btn btn-ghost" onClick=${load}>Try again</button></div></div>`;
  if (!p) return html`<div class="tpm-back"><button class="btn btn-ghost btn-sm" onClick=${onBack}>‹ All partners</button></div><div class="area-loading"><span class="spinner" /></div>`;

  const mark = async (patch, words) => { const j = await act({ action: 'mark', jtId: id, ...patch }, words); if (j?.partner) setP(j.partner); };
  const sendLink = () => act({ action: 'send-link', jtId: id }, (j) => `Sent to ${j.to}`);
  const confirm = async () => {
    if (!(await ask({ title: `Confirm ${p.name}’s bank account?`, text: `Only after you called ${phoneText(bank?.phone) || 'the number on file'}, the number SOARD had before the change, and they confirmed the account ending ${bank?.last4}. Their held bills are paid once it’s confirmed.`, confirm: 'It’s confirmed' }))) return;
    await act({ action: 'confirm-bank', jtId: id }, 'Confirmed. Their bills can be paid.');
    load();
  };
  const steps = [['company', 'Company'], ['w9', 'W-9'], ['coi', 'Insurance'], ['bank', 'Bank']];
  const d = p.docs;
  return html`
    <div class="tpm-back"><button class="btn btn-ghost btn-sm" onClick=${onBack}>‹ All partners</button></div>
    <div class="page-header" style="margin-top: 0;">
      <div><h2>${p.name}</h2><p class="page-sub">${(p.trades || []).join(', ') || 'No trades yet'}${p.address ? ` · ${p.address}` : ''}</p></div>
      <div class="page-header__actions tpm-actions">
        <a class="btn btn-ghost" href=${p.url} target="_blank" rel="noopener">Open in JobTread</a>
        <button class="btn btn-primary" disabled=${!!busy} onClick=${sendLink}>${busy === `send-link${id}` ? 'Sending…' : p.doneAt ? 'Send their link' : 'Send the setup invitation'}</button>
      </div>
    </div>
    <div class="tpm-detail">
      <div>
        <section class="tpm-card" aria-labelledby="tpm-docs">
          <div class="tpm-actions" style="justify-content: space-between;"><h3 id="tpm-docs">W-9 and insurance</h3><span class=${`tag ${d.ok ? (d.expiring ? 'tag--warn' : 'tag--success') : 'tag--warn'}`}>${d.docsField || d.label}</span></div>
          <dl class="tpm-kv">
            <dt>W-9</dt><dd>${!d.w9 ? 'Missing' : p.files.some((f) => f.tag === 'W-9') ? 'On file' : 'Ticked in JobTread, no file tagged W-9'}</dd>
            <dt>Liability</dt><dd>${ends(d.glExpires)}</dd>
            <dt>Workers’ comp</dt><dd>${ends(d.wcExpires)}</dd>
            ${d.check ? html`<dt>Last check</dt><dd>${d.check}</dd>` : null}
            ${p.agent?.email ? html`<dt>Insurance agent</dt><dd>${p.agent.name || ''} ${p.agent.agency ? `(${p.agent.agency})` : ''} <a class="link" href=${`mailto:${p.agent.email}`}>${p.agent.email}</a>${p.agent.askedAt ? html`<br /><span class="tpm-sub">Asked ${day(p.agent.askedAt)}${p.agent.asks > 1 ? `, ${p.agent.asks} times` : ''}</span>` : null}</dd>` : null}
            ${p.ask?.askedAt ? html`<dt>Emailed</dt><dd>${day(p.ask.askedAt)}${p.ask.asks > 1 ? `, ${p.ask.asks} times` : ''}</dd>` : null}
          </dl>
          ${p.files.length ? html`<ul class="tpm-files">${p.files.map((f) => html`<li key=${f.id}><span class="tag">${f.tag}</span><a class="link" href=${f.url} target="_blank" rel="noopener">${f.name}</a><span class="tpm-sub">${day(f.at)}</span></li>`)}</ul>` : html`<p class="tpm-note">No files tagged W-9 or COI on their JobTread account yet.</p>`}
        </section>
        <section class="tpm-card" aria-labelledby="tpm-inv">
          <h3 id="tpm-inv">Invoices</h3>
          ${p.invoices.length ? html`<table class="tpm-inv"><thead><tr><th>Invoice</th><th>Date</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
            ${p.invoices.map((i) => html`<tr key=${i.id}><td>${i.number ? `#${i.number}` : '—'}</td><td>${day(i.date)}</td><td class="num">${usd(i.cents)}</td><td>${INVOICE[i.status] || i.status}${i.status === 'held' ? ` (${i.heldFor === 'bank' ? 'bank account' : 'documents'})` : i.status === 'paid' && i.paidAt ? ` ${day(i.paidAt)}` : ''}</td></tr>`)}
          </tbody></table>` : html`<p class="tpm-note">No bills from them in the last 18 months.</p>`}
        </section>
      </div>
      <div>
        <section class="tpm-card" aria-labelledby="tpm-setup">
          <h3 id="tpm-setup">Their page</h3>
          <div class="tpm-steps">${steps.map(([k, label]) => html`<span class=${`tag ${p.steps?.[k] ? 'tag--success' : ''}`}>${p.steps?.[k] ? '✓ ' : ''}${label}</span>`)}</div>
          <p class="tpm-note">${p.doneAt ? `Set up ${day(p.doneAt)}.` : p.invitedAt ? `Invited ${day(p.invitedAt)}${p.invitedBy ? ` by ${p.invitedBy}` : ''}; not finished yet. They’re reminded after 2 and 5 days.` : 'Not invited yet.'}${p.lang === 'es' ? ' Reads it in Spanish.' : ''}</p>
        </section>
        <section class="tpm-card" aria-labelledby="tpm-bank">
          <h3 id="tpm-bank">Bank account</h3>
          ${p.bank ? html`<p class="tpm-note"><strong>${bank?.kindLabel || ''} ending ${p.bank.last4}</strong>${p.bank.previousLast4 ? ` (was ending ${p.bank.previousLast4})` : ''}, ${p.bank.status === 'pending' ? `added ${day(p.bank.changedAt)}, waiting for a call to confirm it` : `confirmed by ${p.bank.confirmedBy} ${day(p.bank.confirmedAt)}`}.</p>
            ${p.bank.status === 'pending' ? html`<div class="tpm-actions">${bank?.phone ? html`<a class="btn btn-ghost" href=${`tel:${bank.phone}`}>Call ${phoneText(bank.phone)}</a>` : null}<button class="btn btn-primary" disabled=${!!busy} onClick=${confirm}>I called and confirmed it</button></div>` : null}`
            : html`<p class="tpm-note">They haven’t added one on their page.</p>`}
        </section>
        <section class="tpm-card" aria-labelledby="tpm-people">
          <h3 id="tpm-people">People</h3>
          ${p.contacts.length ? html`<dl class="tpm-kv">${p.contacts.map((c) => html`<dt>${c.role === 'main' ? 'Main contact' : c.title || 'Contact'}</dt><dd>${c.name}${c.email ? html` · <a class="link" href=${`mailto:${c.email}`}>${c.email}</a>` : ''}${c.phone ? html` · <span class="tpm-nowrap">${phoneText(c.phone)}</span>` : ''}</dd>`)}</dl>` : html`<p class="tpm-note">No contacts in JobTread.</p>`}
          ${p.license ? html`<p class="tpm-note">License ${p.license}</p>` : null}
        </section>
        <section class="tpm-card" aria-labelledby="tpm-calls">
          <h3 id="tpm-calls">Your calls</h3>
          <label class="bc-switch tpm-switch"><input type="checkbox" role="switch" checked=${p.materials} aria-checked=${p.materials} disabled=${!!busy} onChange=${(e) => mark({ materials: e.target.checked }, e.target.checked ? 'Marked materials only' : 'Unmarked')} /><span class="bc-switch-track" aria-hidden="true" /><span><strong>Materials only</strong><br /><span class="tpm-sub tpm-wrap">A supplier, not a sub: left out of the insurance audit.</span></span></label>
          <label class="bc-switch tpm-switch"><input type="checkbox" role="switch" checked=${d.docsField === 'Not needed'} aria-checked=${d.docsField === 'Not needed'} disabled=${!!busy} onChange=${(e) => mark({ notNeeded: e.target.checked }, e.target.checked ? 'Set to Not needed' : 'Back to what their documents say')} /><span class="bc-switch-track" aria-hidden="true" /><span><strong>Documents not needed</strong><br /><span class="tpm-sub tpm-wrap">Never asked for a W-9 or insurance, and bills never wait for them.</span></span></label>
        </section>
      </div>
    </div>`;
}

// ─── Requests ───────────────────────────────────────────────────────

function Requests({ data, act, busy }) {
  const [matching, setMatching] = useState(null);
  const open = data.requests.filter((r) => r.status === 'new');
  const done = data.requests.filter((r) => r.status !== 'new');
  const approve = (r) => act({ action: 'decide', id: r.id, decision: 'approve' }, `${r.company} is in JobTread and has their invitation`);
  const decline = async (r) => {
    if (!(await ask({ title: `Decline ${r.company}?`, text: `They get a kind email saying we don’t have work for them right now and will keep their details.`, confirm: 'Decline' }))) return;
    act({ action: 'decide', id: r.id, decision: 'decline' }, 'Declined');
  };
  return html`
    <div style="margin-top: 1rem;">
      ${open.length ? html`<div class="tpm-cards">${open.map((r) => html`
        <article class="tpm-card" key=${r.id}>
          <div class="tpm-actions" style="justify-content: space-between;"><h3>${r.company}</h3><span class="tpm-sub">${day(r.createdAt)}</span></div>
          <dl class="tpm-kv">
            <dt>Trades</dt><dd>${r.trades.join(', ')}</dd>
            <dt>Contact</dt><dd>${r.name} · <a class="link" href=${`mailto:${r.email}`}>${r.email}</a> · <span class="tpm-nowrap">${phoneText(r.phone)}</span></dd>
            ${r.area ? html`<dt>Where</dt><dd>${r.area}</dd>` : null}
            ${r.website ? html`<dt>Website</dt><dd><a class="link" href=${/^https?:/.test(r.website) ? r.website : `https://${r.website}`} target="_blank" rel="noopener noreferrer">${r.website}</a></dd>` : null}
            ${r.note ? html`<dt>Note</dt><dd>${r.note}</dd>` : null}
            ${r.lang === 'es' ? html`<dt>Language</dt><dd>Spanish</dd>` : null}
          </dl>
          <div class="tpm-actions">
            <button class="btn btn-primary" disabled=${!!busy} onClick=${() => approve(r)}>${busy === `decide${r.id}` ? 'Working…' : 'Approve and invite'}</button>
            <button class="btn btn-ghost" disabled=${!!busy} onClick=${() => setMatching(r)}>It’s a vendor we have…</button>
            <button class="btn btn-ghost" disabled=${!!busy} onClick=${() => decline(r)}>Decline</button>
          </div>
        </article>`)}</div>`
        : html`<div class="empty"><p class="empty__title">No requests waiting</p><p class="empty__text">Companies ask to work with SOARD on the trade-partner page. Each one shows here for someone to approve; Slack hears when one comes in.</p></div>`}
      ${done.length ? html`<div class="sec-head" style="margin-top: 1.5rem;"><h3>Decided</h3></div>
        <div class="tpm-list">${done.slice(0, 50).map((r) => html`<div class="tpm-row" style="cursor: default;" key=${r.id}>
          <span class="tpm-cell"><span class="tpm-name">${r.company}</span><span class="tpm-sub">${r.email}</span></span>
          <span class="tpm-cell"><span class=${`tag ${r.status === 'declined' ? '' : 'tag--success'}`}>${r.status === 'declined' ? 'Declined' : r.status === 'matched' ? 'Matched' : 'Approved'}</span></span>
          <span class="tpm-cell"><span class="tpm-sub">${r.decidedBy || ''}</span></span><span class="tpm-cell"><span class="tpm-sub">${day(r.decidedAt)}</span></span><span /></div>`)}</div>` : null}
      ${matching ? html`<${MatchVendor} r=${matching} data=${data} act=${act} busy=${busy} onClose=${() => setMatching(null)} />` : null}
    </div>`;
}

/** A vendor JobTread has, picked by name */
function VendorPicker({ data, picked, onPick, start = '' }) {
  const [q, setQ] = useState(start);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? data.partners.filter((p) => words.every((w) => `${p.name} ${p.email || ''}`.toLowerCase().includes(w))).slice(0, 8) : [];
  return html`<div>
    <input class="form-input" type="search" data-autofocus placeholder="A vendor’s name in JobTread" aria-label="Find the vendor" value=${q} onInput=${(e) => setQ(e.target.value)} />
    ${hits.length ? html`<ul class="tpm-pick">${hits.map((p) => html`<li key=${p.jtId}><button type="button" aria-pressed=${picked === p.jtId} onClick=${() => onPick(p.jtId)}><span>${p.name}</span><span class="tpm-sub">${p.email || ''}</span></button></li>`)}</ul>` : null}
  </div>`;
}

function MatchVendor({ r, data, act, busy, onClose }) {
  const [jtId, setJtId] = useState(null);
  const go = async () => { if (await act({ action: 'decide', id: r.id, decision: 'approve', jtId }, `Matched; ${r.email} has their invitation`)) onClose(); };
  return html`<${Dialog} title=${`Which vendor is ${r.company}?`} sub="Their request goes onto the vendor JobTread already has, and they’re invited from there." onClose=${onClose} busy=${!!busy}
    footer=${html`<button class="btn btn-ghost" onClick=${onClose}>Cancel</button><button class="btn btn-primary" disabled=${!jtId || !!busy} onClick=${go}>${busy ? 'Working…' : 'Match and invite'}</button>`}>
    <${VendorPicker} data=${data} picked=${jtId} onPick=${setJtId} start=${r.company.split(/\s+/)[0]} />
  </${Dialog}>`;
}

// ─── Bank changes ───────────────────────────────────────────────────

function Bank({ data, act, busy, onOpen }) {
  const pending = data.bank.filter((b) => b.status === 'pending');
  const done = data.bank.filter((b) => b.status !== 'pending');
  const confirm = async (b) => {
    if (!(await ask({ title: `Confirm ${b.name}’s bank account?`, text: `Only after you called ${phoneText(b.phone) || 'the number on file'}, the number SOARD had before the change, and they confirmed the account ending ${b.last4}. Their held bills are paid once it’s confirmed.`, confirm: 'It’s confirmed' }))) return;
    act({ action: 'confirm-bank', jtId: b.jtId }, 'Confirmed. Their bills can be paid.');
  };
  return html`
    <div style="margin-top: 1rem;">
      <p class="tpm-note" style="margin-bottom: 1rem;">A new or changed bank account is the usual way vendor payments get stolen: someone gets into a contractor’s email and changes where the money goes. So each one waits for a call to the number SOARD already had, never one in the change itself.</p>
      ${pending.length ? html`<div class="tpm-cards">${pending.map((b) => html`
        <article class="tpm-card" key=${b.jtId}>
          <div class="tpm-actions" style="justify-content: space-between;"><h3><button class="link" style="background:none;border:0;padding:0;font:inherit;cursor:pointer;" onClick=${() => onOpen(b.jtId)}>${b.name}</button></h3><span class="tag tag--warn">To confirm</span></div>
          <dl class="tpm-kv">
            <dt>Account</dt><dd>${b.kindLabel} ending ${b.last4}${b.previousLast4 ? ` (was ending ${b.previousLast4})` : ' (their first)'}</dd>
            <dt>Changed</dt><dd>${day(b.changedAt)} on their trade-partner page</dd>
            <dt>Call</dt><dd>${b.phone ? html`<a class="link" href=${`tel:${b.phone}`}>${phoneText(b.phone)}</a>${b.contact ? ` (${b.contact})` : ''}` : 'No phone in JobTread: find one you trust before confirming'}</dd>
          </dl>
          <div class="tpm-actions"><button class="btn btn-primary" disabled=${!!busy} onClick=${() => confirm(b)}>${busy === `confirm-bank${b.jtId}` ? 'Confirming…' : 'I called and confirmed it'}</button></div>
        </article>`)}</div>`
        : html`<div class="empty"><p class="empty__title">Nothing to confirm</p><p class="empty__text">When a partner adds or changes their bank account, it shows here with the number to call.</p></div>`}
      ${done.length ? html`<div class="sec-head" style="margin-top: 1.5rem;"><h3>Confirmed</h3></div>
        <div class="tpm-list">${done.slice(0, 50).map((b) => html`<button class="tpm-row" key=${b.jtId} onClick=${() => onOpen(b.jtId)}>
          <span class="tpm-cell"><span class="tpm-name">${b.name}</span><span class="tpm-sub">${b.kindLabel} ending ${b.last4}</span></span>
          <span class="tpm-cell"><span class="tag tag--success">Confirmed</span></span><span class="tpm-cell"><span class="tpm-sub">${b.confirmedBy}</span></span><span class="tpm-cell"><span class="tpm-sub">${day(b.confirmedAt)}</span></span><span class="tpm-chev" aria-hidden="true">›</span></button>`)}</div>` : null}
    </div>`;
}

// ─── Settings ───────────────────────────────────────────────────────

function Settings({ data, act, busy }) {
  const d = data.settings || {};
  const [occ, setOcc] = useState(String(d.glOccurrence ?? 1000000));
  const [agg, setAgg] = useState(String(d.glAggregate ?? 2000000));
  const [wc, setWc] = useState(d.workersComp !== false);
  const [el, setEl] = useState(String(d.elEachAccident ?? 100000));
  const [renew, setRenew] = useState(String(d.renewDays ?? 30));
  const save = () => act({ action: 'settings', glOccurrence: Number(occ), glAggregate: Number(agg), workersComp: wc, elEachAccident: Number(el), renewDays: Number(renew) }, 'Saved');
  return html`
    <section class="tpm-card" style="margin-top: 1rem;">
      <h3>Insurance minimums</h3>
      <p class="tpm-note">Every certificate is checked against these the moment it’s added, on the partner’s page or by their agent. A bill is paid only when the vendor’s W-9 and certificate are current in JobTread.</p>
      <div class="tpm-grid2">
        <label class="tpm-field"><span>General liability, each occurrence ($)</span><input class="form-input" type="number" min="0" step="100000" value=${occ} onInput=${(e) => setOcc(e.target.value)} /></label>
        <label class="tpm-field"><span>General liability, aggregate ($)</span><input class="form-input" type="number" min="0" step="100000" value=${agg} onInput=${(e) => setAgg(e.target.value)} /></label>
        <label class="tpm-field"><span>Employer’s liability, each accident ($)</span><input class="form-input" type="number" min="0" step="50000" value=${el} onInput=${(e) => setEl(e.target.value)} disabled=${!wc} /></label>
        <label class="tpm-field"><span>Ask for the renewal this many days ahead</span><input class="form-input" type="number" min="7" max="90" value=${renew} onInput=${(e) => setRenew(e.target.value)} /></label>
      </div>
      <label class="bc-switch tpm-switch tpm-switch--line"><input type="checkbox" role="switch" checked=${wc} aria-checked=${wc} onChange=${(e) => setWc(e.target.checked)} /><span class="bc-switch-track" aria-hidden="true" /><span>Workers’ compensation is required</span></label>
      <div class="tpm-actions">
        <button class="btn btn-primary" disabled=${!!busy} onClick=${save}>${busy === 'settings' ? 'Saving…' : 'Save'}</button>
        <button class="btn btn-ghost" disabled=${!!busy} onClick=${() => act({ action: 'preview' }, (j) => `Sent to ${j.sent}`)}>${busy === 'preview' ? 'Sending…' : 'Send me the vendor email'}</button>
        <span class="tpm-sub">Its link opens the page for a sample company: try a real certificate there; nothing is kept.</span>
      </div>
    </section>`;
}

// ─── Add a trade partner ────────────────────────────────────────────

function AddPartner({ data, act, busy, onClose }) {
  const [mode, setMode] = useState('new');
  const [jtId, setJtId] = useState(null);
  const [f, setF] = useState({ company: '', name: '', email: '', phone: '', lang: 'en' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const can = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim()) && (mode === 'have' ? !!jtId : f.company.trim().length > 1);
  const go = async () => {
    const j = await act({ action: 'invite', ...(mode === 'have' ? { jtId } : { company: f.company.trim() }), name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim(), lang: f.lang },
      (r) => `${r.created ? 'Made in JobTread and invited' : 'Invited'}: ${r.to}`);
    if (j) onClose();
  };
  return html`<${Dialog} title="Add a trade partner" sub="They get an email to set up their page: company, W-9, insurance and bank account." onClose=${onClose} busy=${!!busy}
    footer=${html`<button class="btn btn-ghost" onClick=${onClose}>Cancel</button><button class="btn btn-primary" disabled=${!can || !!busy} onClick=${go}>${busy ? 'Sending…' : 'Send the invitation'}</button>`}>
    <div class="tpm-form">
      <div class="seg" role="tablist" aria-label="Which company">
        <button role="tab" aria-selected=${mode === 'new'} onClick=${() => setMode('new')}>A new company</button>
        <button role="tab" aria-selected=${mode === 'have'} onClick=${() => setMode('have')}>One in JobTread</button>
      </div>
      ${mode === 'new'
        ? html`<label class="tpm-field"><span>Company name</span><input class="form-input" data-autofocus value=${f.company} onInput=${set('company')} /></label>`
        : html`<${VendorPicker} data=${data} picked=${jtId} onPick=${setJtId} />`}
      <div class="tpm-grid2">
        <label class="tpm-field"><span>Contact’s name</span><input class="form-input" value=${f.name} onInput=${set('name')} autocomplete="off" /></label>
        <label class="tpm-field"><span>Phone (optional)</span><input class="form-input" type="tel" value=${f.phone} onInput=${set('phone')} /></label>
      </div>
      <label class="tpm-field"><span>Email the invitation to</span><input class="form-input" type="email" value=${f.email} onInput=${set('email')} autocomplete="off" /></label>
      <label class="tpm-field"><span>Their language</span><select class="form-input" value=${f.lang} onChange=${set('lang')}><option value="en">English</option><option value="es">Spanish</option></select></label>
    </div>
  </${Dialog}>`;
}
