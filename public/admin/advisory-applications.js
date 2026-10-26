/**
 * Admin → People → Applications: Advisory Board applications
 * ===========================================================================
 * Everyone who applied on /advisory-board/apply/ (and the applications sent
 * to the old Jotform form, brought in once). Each one opens in a panel:
 * how to reach them, every answer by step, where it stands (New, In
 * conversation, Joined, Not now), notes for staff, and Add as an advisor,
 * which makes them a hidden draft on People → Advisory with their email as
 * their private reveal-invite address, the way Paste a list does.
 *
 * Loaded on first visit from index.html (AdvisoryApplicationsLazy), which
 * passes `kit`: { api, toPersonRecord, team, onOpenPerson(slug), onTeamChanged() }.
 * Server: functions/api/advisory-applications-admin.js.
 */

import { h, htm, useState, useEffect, useRef, useMemo, useCallback } from './vendor.js';
import { slugOf, ADVISORY_TITLE, normalizeLinkedIn } from './team-shared.js';

const html = htm.bind(h);
const API = '/api/advisory-applications-admin';
const STATUS_COLOR = { new: '#2B6CB0', talking: '#B7791F', joined: '#2F7D4F', 'not-now': '#7C7D84' };
const STATUS_HINT = {
  new: 'Not looked at yet',
  talking: 'You’re talking with them',
  joined: 'On People → Advisory',
  'not-now': 'Not moving forward for now',
};
const APPLY_PAGE = '/advisory-board/apply/';

async function call(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  return j;
}

const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const longDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return longDate(iso);
}
const work = (a) => [a.jobTitle, a.company].filter(Boolean).join(', ');
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** Who a new application emails, in words: the list, and the committee with who's on it */
function whoHears(st) {
  const emails = st.staffEmails || [];
  const people = (st.committeeMembers || []).map((m) => m.name);
  const committee = st.committee ? `the ${st.committee} committee${people.length ? ` (${list(people)})` : ' (nobody is on it yet)'}` : null;
  return list([...(emails.length > 3 ? [plural(emails.length, 'person', 'people')] : emails), committee].filter(Boolean));
}
const shown = (a) => (a.preferredName && a.preferredName !== a.name.split(' ')[0] ? `${a.name} (${a.preferredName})` : a.name);

// ─── Styles (prefixed ava-, injected once) ─────────────────────────
const CSS = `
.ava { display: grid; gap: .9rem; min-width: 0; }
.ava > * { min-width: 0; }
.ava-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: .6rem 1rem; }
.ava-head.page-header { margin-bottom: 0; }
.ava-head-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.ava-toolbar { display: flex; flex-wrap: wrap; gap: .5rem .75rem; align-items: center; }
.ava-strip { display: flex; flex-wrap: wrap; gap: .35rem; flex: 1 1 auto; }
.ava-strip button { display: inline-flex; align-items: center; gap: .45rem; min-height: 34px; padding: .2rem .75rem; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-bg-card); color: var(--color-text-secondary); font: inherit; font-size: var(--fs-xs); font-weight: 600; cursor: pointer; }
.ava-strip button:hover { border-color: var(--color-border-strong); color: var(--color-text); }
.ava-strip button b { color: var(--color-text); font-variant-numeric: tabular-nums; }
.ava-strip button[aria-pressed="true"] { border-color: var(--c, var(--color-text)); background: color-mix(in srgb, var(--c, var(--color-text)) 9%, var(--color-bg-card)); color: var(--color-text); box-shadow: inset 0 0 0 1px var(--c, var(--color-text)); }
.ava-strip button.is-all[aria-pressed="true"] { background: var(--color-text); color: var(--color-bg-card); border-color: var(--color-text); box-shadow: none; }
.ava-strip button.is-all[aria-pressed="true"] b { color: inherit; }
.ava-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex: none; display: inline-block; }
.ava-search { flex: 0 1 260px; min-width: 0; }
.ava-search input { width: 100%; min-height: 36px; font-size: var(--fs-sm); }
.ava-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); overflow: hidden; }
.ava-row { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: .35rem .85rem; align-items: center; padding: .8rem 1rem; border-bottom: 1px solid var(--color-border); cursor: pointer; background: none; border-left: 0; border-right: 0; border-top: 0; width: 100%; text-align: left; font: inherit; color: inherit; }
.ava-list li:last-child .ava-row { border-bottom: 0; }
.ava-row:hover { background: var(--color-bg-hover); }
.ava-row:focus-visible { outline: 2px solid var(--color-text); outline-offset: -2px; }
.ava-row.is-new .ava-name::after { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--tone-info-dot); margin-left: .45rem; vertical-align: middle; }
.ava-avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-size: var(--fs-xs); font-weight: 700; color: var(--tone-warn-fg); background: var(--tone-warn-bg); flex: none; }
.ava-who { min-width: 0; display: grid; gap: .1rem; }
.ava-name { font-weight: 650; font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ava-sub { font-size: var(--fs-xs); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ava-why { font-size: var(--fs-xs); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
.ava-meta { display: grid; justify-items: end; gap: .3rem; }
.ava-when { font-size: var(--fs-2xs); color: var(--color-text-muted); white-space: nowrap; }
.ava-pill { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-2xs); font-weight: 650; padding: 3px 9px 3px 7px; border-radius: 999px; background: color-mix(in srgb, var(--c) 12%, white); color: color-mix(in srgb, var(--c) 80%, black); border: 1px solid color-mix(in srgb, var(--c) 28%, white); white-space: nowrap; }
.ava-pill::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
.ava-tag { display: inline-flex; align-items: center; min-height: 20px; padding: .1rem .5rem; border-radius: 999px; background: var(--tone-neutral-bg); color: var(--tone-neutral-fg); font-size: var(--fs-2xs); font-weight: 600; white-space: nowrap; }
/* Empty, nobody matching, a load that failed: the admin's empty card */
.ava-zero { padding: 2.25rem 1.5rem; text-align: center; font-size: var(--fs-sm); line-height: 1.5; color: var(--color-text-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); box-shadow: var(--shadow-sm); }
.ava-zero strong { display: block; margin-bottom: .25rem; font-size: var(--fs-base); font-weight: 600; color: var(--color-text); }
.ava-zero .btn { margin-top: .9rem; }

body.ava-drawer-open .toast-container { z-index: 1350; }
.ava-scrim { position: fixed; inset: 0; background: rgba(26,27,31,.36); z-index: 1200; animation: ava-fade .18s ease-out; }
.ava-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(760px, 100vw); background: var(--color-bg); z-index: 1201; box-shadow: var(--shadow-lg); display: flex; flex-direction: column; animation: ava-in .26s cubic-bezier(.2,.8,.2,1); }
.ava-drawer:focus { outline: none; }
@keyframes ava-in { from { transform: translateX(28px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes ava-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .ava-drawer, .ava-scrim { animation: none; } }
.ava-dhead { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: .3rem .85rem; align-items: center; padding: .9rem 1.1rem; background: var(--color-bg-card); border-bottom: 1px solid var(--color-border); }
.ava-dhead .ava-avatar { width: 46px; height: 46px; font-size: var(--fs-sm); }
.ava-dhead h2 { margin: 0; font-size: var(--fs-lg); line-height: 1.25; font-family: inherit; text-transform: none; letter-spacing: -.01em; color: var(--color-text); overflow-wrap: anywhere; }
.ava-dhead p { margin: .15rem 0 0; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.ava-close { width: 40px; height: 40px; display: inline-grid; place-items: center; border-radius: 10px; border: 1px solid var(--color-border); background: var(--color-bg-card); cursor: pointer; color: var(--color-text); }
.ava-close:hover { background: var(--color-bg-hover); }
.ava-close:focus-visible { outline: 2px solid var(--color-text); outline-offset: 1px; }
.ava-dbody { flex: 1; overflow-y: auto; padding: 1rem 1.1rem 2rem; display: grid; gap: .9rem; align-content: start; }
.ava-panel { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: .9rem 1rem; display: grid; gap: .6rem; }
.ava-panel h3 { margin: 0; font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: .05em; color: var(--color-text-secondary); }
.ava-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.ava-status { display: flex; flex-wrap: wrap; gap: .35rem; }
.ava-status button { display: inline-flex; align-items: center; gap: .4rem; min-height: 38px; padding: .3rem .8rem; border-radius: 999px; border: 1px solid var(--color-border); background: var(--color-bg-card); font: inherit; font-size: var(--fs-xs); font-weight: 600; color: var(--color-text-secondary); cursor: pointer; }
.ava-status button[aria-pressed="true"] { color: var(--color-text); border-color: var(--c); background: color-mix(in srgb, var(--c) 10%, var(--color-bg-card)); box-shadow: inset 0 0 0 1px var(--c); }
.ava-status button:focus-visible { outline: 2px solid var(--color-text); outline-offset: 1px; }
.ava-contact { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .35rem .9rem; margin: 0; font-size: var(--fs-sm); }
.ava-contact dt { color: var(--color-text-muted); font-size: var(--fs-xs); padding-top: .1rem; }
.ava-contact dd { margin: 0; overflow-wrap: anywhere; white-space: pre-line; }
.ava-contact a { color: var(--color-text); }
.ava-qa { display: grid; gap: .75rem; }
.ava-q { font-size: var(--fs-xs); color: var(--color-text-muted); margin: 0 0 .15rem; line-height: 1.4; }
.ava-a { margin: 0; font-size: var(--fs-sm); line-height: 1.55; white-space: pre-line; overflow-wrap: anywhere; }
.ava-a.is-flag { color: var(--tone-warn-fg); background: var(--tone-warn-surface); border: 1px solid var(--tone-warn-line-strong); border-radius: 8px; padding: .35rem .55rem; justify-self: start; }
.ava-notes { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
.ava-notes li { border-left: 3px solid var(--color-border-strong); padding: .1rem 0 .1rem .7rem; font-size: var(--fs-sm); white-space: pre-line; }
.ava-notes small { display: block; color: var(--color-text-muted); font-size: var(--fs-2xs); margin-top: .15rem; }
.ava-note-form { display: grid; gap: .45rem; }
.ava-note-form textarea { min-height: 70px; }
.ava-note-form .btn { justify-self: end; }
.ava-foot { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .5rem; align-items: center; font-size: var(--fs-xs); color: var(--color-text-muted); }
.ava-callout { font-size: var(--fs-xs); border-radius: 10px; padding: .6rem .75rem; background: var(--color-bg-secondary); border: 1px solid var(--color-border); color: var(--color-text-secondary); }
.ava-callout.is-good { background: var(--tone-success-surface); border-color: var(--tone-success-line); color: var(--tone-success-fg); }
.ava-overlay { z-index: 1300; }
.ava-dialog .kd-dialog__body > p { margin: 0 0 .75rem; font-size: var(--fs-sm); line-height: 1.55; color: var(--color-text-secondary); }
.ava-dialog .kd-dialog__body > p:last-child { margin-bottom: 0; }
.ava-dialog ul { margin: .25rem 0 .75rem 1.1rem; font-size: var(--fs-sm); line-height: 1.55; }
@media (max-width: 640px) {
  .ava-row { grid-template-columns: 40px minmax(0, 1fr); }
  .ava-meta { grid-column: 2; justify-items: start; grid-auto-flow: column; justify-content: start; align-items: center; gap: .5rem; }
  .ava-search { flex: 1 1 100%; }
  .ava-dhead { padding: .75rem .8rem; }
  .ava-dbody { padding: .8rem .8rem 2rem; }
  .ava-contact { grid-template-columns: 1fr; gap: .1rem; }
  .ava-contact dd { margin-bottom: .45rem; }
  .ava-status button, .ava-actions .btn { min-height: 44px; }
}
`;
let _cssDone = false;
function injectCss() {
  if (_cssDone) return;
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.appendChild(el);
  _cssDone = true;
}

const Pill = ({ status, label }) => html`<span class="ava-pill" style=${`--c:${STATUS_COLOR[status] || '#7C7D84'}`}>${label}</span>`;
const Avatar = ({ a }) => html`<span class="ava-avatar" style=${`--c:${STATUS_COLOR[a.status]}`} aria-hidden="true">${initials(a.name)}</span>`;

/** The admin's shared dialog (its kd-dialog classes): title and ✕, body, footer.
 *  Escape and the scrim close it (not while it works); Tab stays inside; focus goes
 *  back where it was. A [data-autofocus] element gets the focus first. */
let dlgSeq = 0;
function Dialog({ title, sub = '', children, footer = null, onClose, busy = false, size = 'md' }) {
  const ref = useRef(null);
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = `ava-dlg-${++dlgSeq}`;
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
    requestAnimationFrame(() => (ref.current?.querySelector('[data-autofocus], .kd-dialog__body textarea, .kd-dialog__body input, .kd-dialog__foot .btn-primary') || ref.current)?.focus());
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (document.querySelectorAll('.modal-overlay').length <= 1) document.body.classList.remove('modal-open');
      if (prev?.isConnected) prev.focus?.();
    };
  }, []);
  const id = idRef.current;
  return html`<div class="modal-overlay kd-overlay ava-overlay" onClick=${(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div class=${`modal kd-dialog kd-dialog--${size} ava-dialog`} role="dialog" aria-modal="true" aria-labelledby=${id} ref=${ref} tabindex="-1">
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

export function AdvisoryApplications({ addToast, kit = {} }) {
  injectCss();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(() => (location.hash.match(/^#advisory-applications\/(adv-[0-9a-z-]+)/) || [])[1] || null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    const j = await call(API);
    if (!j.success) { setErr(j.error || 'Couldn’t load the applications'); return; }
    setErr(null);
    setData(j);
    if (j.imported) addToast?.(`${plural(j.imported, 'application')} from the old form ${j.imported === 1 ? 'is' : 'are'} here now.`, 'info');
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = (id) => {
    setOpenId(id);
    const base = location.hash.startsWith('#advisory-applications') || !id ? '#advisory-applications' : null;
    if (base) history.replaceState(null, '', `${location.pathname}${location.search}${id ? `${base}/${id}` : base}`);
  };

  const apps = data?.applications || [];
  const counts = useMemo(() => Object.fromEntries((data?.statuses || []).map((s) => [s.id, apps.filter((a) => a.status === s.id).length])), [data]);
  const ql = q.trim().toLowerCase();
  const list = apps.filter((a) => (!filter || a.status === filter)
    && (!ql || [a.name, a.preferredName, a.company, a.jobTitle, a.email].some((v) => String(v || '').toLowerCase().includes(ql))));
  const statusLabel = (id) => (data?.statuses || []).find((s) => s.id === id)?.label || id;

  const replace = (app) => setData((d) => d && { ...d, applications: d.applications.map((x) => (x.id === app.id ? { ...x, ...app, notes: Array.isArray(app.notes) ? app.notes.length : app.notes } : x)) });
  const drop = (id) => setData((d) => d && { ...d, applications: d.applications.filter((x) => x.id !== id) });

  if (err && !data) return html`<div class="ava"><div class="ava-zero"><strong>Couldn’t load the applications</strong>${err}<div><button class="btn btn-ghost btn-sm" onClick=${load}>Try again</button></div></div></div>`;
  if (!data) return html`<div class="ava"><div class="area-loading" aria-label="Loading the applications"><span class="spinner" /></div></div>`;

  const idx = list.findIndex((a) => a.id === openId);
  return html`<div class="ava">
    <div class="page-header ava-head">
      <div>
        <h2>Advisory Board applications</h2>
        <p class="page-sub">From the <a href=${APPLY_PAGE} target="_blank" rel="noopener">Apply page</a>. Each applicant gets a copy of what they sent. ${whoHears(data.settings) ? `${whoHears(data.settings)} hear about each one by email` : 'Nobody hears by email yet'}, and it’s posted in Slack.</p>
      </div>
      <div class="ava-head-actions">
        <button class="btn btn-ghost btn-sm" onClick=${() => setSettingsOpen(true)}>Who hears about them</button>
      </div>
    </div>

    ${apps.length > 0 && html`<div class="ava-toolbar">
      <div class="ava-strip" role="group" aria-label="Show">
        <button class="is-all" aria-pressed=${!filter} onClick=${() => setFilter('')}>All <b>${apps.length}</b></button>
        ${(data.statuses || []).map((s) => html`<button key=${s.id} style=${`--c:${STATUS_COLOR[s.id]}`} aria-pressed=${filter === s.id} title=${STATUS_HINT[s.id]}
          onClick=${() => setFilter((f) => (f === s.id ? '' : s.id))}><span class="ava-dot"></span>${s.label} <b>${counts[s.id] || 0}</b></button>`)}
      </div>
      <label class="ava-search"><input class="form-input" type="search" placeholder="Search name, company, email" aria-label="Search applications" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
    </div>`}

    ${apps.length === 0 ? html`<div class="ava-zero"><strong>No applications yet</strong>When someone applies on the <a href=${APPLY_PAGE} target="_blank" rel="noopener">Advisory Board’s Apply page</a>, it shows here, and you get an email and a Slack post.</div>`
      : list.length === 0 ? html`<div class="ava-zero"><strong>Nobody matches</strong><button class="btn btn-ghost btn-sm" onClick=${() => { setFilter(''); setQ(''); }}>Show everyone</button></div>`
      : html`<ul class="ava-list">
        ${list.map((a) => html`<li key=${a.id}><button class=${`ava-row ${a.status === 'new' && !a.isTest ? 'is-new' : ''}`} onClick=${() => open(a.id)} aria-label=${`${a.name}, ${statusLabel(a.status)}. Open`}>
          <${Avatar} a=${a} />
          <span class="ava-who">
            <span class="ava-name">${shown(a)}</span>
            <span class="ava-sub">${work(a) || a.email || ''}</span>
            ${a.why && html`<span class="ava-why">${a.why}</span>`}
          </span>
          <span class="ava-meta">
            <${Pill} status=${a.status} label=${statusLabel(a.status)} />
            <span class="ava-when" title=${longDate(a.createdAt)}>${a.isTest ? html`<span class="ava-tag" title="A test: its email went only to the address on it">Test</span> ` : ''}${a.source === 'jotform' ? html`<span class="ava-tag" title="Sent before the website form">Earlier form</span> ` : ''}${ago(a.createdAt)}</span>
          </span>
        </button></li>`)}
      </ul>`}

    ${openId && html`<${Drawer} key=${openId} id=${openId} statuses=${data.statuses} kit=${kit} addToast=${addToast}
      onClose=${() => open(null)}
      onPrev=${idx > 0 ? () => open(list[idx - 1].id) : null}
      onNext=${idx >= 0 && idx < list.length - 1 ? () => open(list[idx + 1].id) : null}
      onChanged=${replace} onRemoved=${(id) => { drop(id); open(null); }} />`}
    ${settingsOpen && html`<${SettingsDialog} settings=${data.settings} addToast=${addToast} onClose=${() => setSettingsOpen(false)}
      onSaved=${(s) => { setData((d) => ({ ...d, settings: s })); setSettingsOpen(false); }} />`}
  </div>`;
}

// ─── One application ────────────────────────────────────────────────

function Drawer({ id, statuses, kit, addToast, onClose, onPrev, onNext, onChanged, onRemoved }) {
  const [app, setApp] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(null); // 'add' | 'remove'
  const panel = useRef(null);

  useEffect(() => {
    let live = true;
    call(`${API}?id=${encodeURIComponent(id)}`).then((j) => { if (!live) return; if (j.success) setApp(j.application); else setErr(j.error || 'Couldn’t load it'); });
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    const prev = document.activeElement;
    document.body.classList.add('ava-drawer-open');
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const onKey = (e) => {
      if (e.defaultPrevented || document.querySelector('.ava-dialog')) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('ava-drawer-open'); document.body.style.overflow = ''; prev?.focus?.(); };
  }, []);

  const post = async (body, what) => {
    setBusy(what);
    const j = await call(API, body);
    setBusy(null);
    if (!j.success) { addToast?.(j.error || 'That didn’t save', 'error'); return null; }
    return j;
  };
  const setStatus = async (status) => {
    if (status === app.status) return;
    const j = await post({ status: { id, status } }, 'status');
    if (j) { setApp(j.application); onChanged(j.application); addToast?.(`Marked ${statuses.find((s) => s.id === status)?.label}`, 'info'); }
  };
  const addNote = async () => {
    const j = await post({ note: { id, text: note } }, 'note');
    if (j) { setApp(j.application); onChanged(j.application); setNote(''); }
  };
  const remove = async () => {
    const j = await post({ remove: { id } }, 'remove');
    if (j) { setConfirm(null); addToast?.(`${app.name}’s application was deleted from the site.`, 'info'); onRemoved(id); }
  };

  // Add as an advisor: a hidden draft on People → Advisory, their email kept private for reveal invites
  const slug = app ? slugOf(app.name) : '';
  const already = app ? (kit.team || []).find((t) => t.slug === slug) : null;
  const linked = app?.personSlug ? (kit.team || []).find((t) => t.slug === app.personSlug) || { slug: app.personSlug, name: app.name } : null;
  const addAdvisor = async () => {
    if (!kit.api || !kit.toPersonRecord) { addToast?.('Open this from People → Applications to add advisors.', 'error'); return; }
    setBusy('add');
    try {
      if (already && already.group !== 'advisory') throw new Error(`${already.name} is already on People in another group. Move them from their page.`);
      if (!already) {
        const order = (kit.team || []).filter((t) => t.group === 'advisory').reduce((m, t) => Math.max(m, Number(t.order) || 0), -1) + 1;
        const linkedin = normalizeLinkedIn(app.link || '');
        const rec = kit.toPersonRecord({
          name: app.name, slug, title: ADVISORY_TITLE, organization: app.company || '', group: 'advisory', order, status: 'active',
          publishStatus: 'draft', since: new Date().getFullYear(), ...(linkedin ? { linkedin } : {}),
        });
        const res = await kit.api.saveContent(`src/content/team/${slug}.json`, JSON.stringify(rec, null, 2), `Add advisor: ${app.name}`);
        if (!res?.success) throw new Error(res?.error || 'Couldn’t add them');
      }
      if (app.email) {
        const r = await fetch('/api/reveal-invites-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boardEmail: { slug, email: app.email } }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(`They’re added, but their email didn’t save (${d.error || `status ${r.status}`}). Add it on their page.`);
      }
      const j = await call(API, { person: { id, slug } });
      if (!j.success) throw new Error(j.error || 'They’re added, but this application didn’t update');
      setApp(j.application);
      onChanged(j.application);
      setConfirm(null);
      kit.onTeamChanged?.();
      addToast?.(`${app.name} is on People → Advisory as a hidden draft. Add a photo there, then show them on the site.`, 'success');
    } catch (e) {
      addToast?.(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const a = app?.answers || {};
  const flag = (sid, item) => (item.id === 'conflict' && item.value === 'Yes') || (item.id === 'meetings' && item.value === 'No') || (item.id === 'ambassador' && item.value === 'No');
  return html`<div>
    <div class="ava-scrim" onClick=${onClose}></div>
    <aside class="ava-drawer" role="dialog" aria-modal="true" aria-label=${app ? `${app.name}’s application` : 'Application'} tabindex="-1" ref=${panel}>
      <header class="ava-dhead">
        ${app ? html`<${Avatar} a=${app} />` : html`<span></span>`}
        <div style="min-width:0">
          <h2>${app ? shown(app) : 'Loading…'}</h2>
          ${app && html`<p>${[work(app), `Applied ${longDate(app.createdAt)}`, app.source === 'jotform' ? 'before the website form' : null].filter(Boolean).join(' · ')}</p>`}
        </div>
        <div class="ava-actions">
          <button class="ava-close" onClick=${onPrev} disabled=${!onPrev} aria-label="Previous application" title="Previous">↑</button>
          <button class="ava-close" onClick=${onNext} disabled=${!onNext} aria-label="Next application" title="Next">↓</button>
          <button class="ava-close" onClick=${onClose} aria-label="Close">✕</button>
        </div>
      </header>
      <div class="ava-dbody">
        ${err && html`<div class="ava-callout">${err}</div>`}
        ${!app && !err && html`<div class="ava-skel">Loading…</div>`}
        ${app && html`
          <section class="ava-panel" aria-label="Where it stands">
            <h3>Where it stands</h3>
            <div class="ava-status" role="group" aria-label="Status">
              ${statuses.map((s) => html`<button key=${s.id} style=${`--c:${STATUS_COLOR[s.id]}`} aria-pressed=${app.status === s.id} disabled=${!!busy} title=${STATUS_HINT[s.id]} onClick=${() => setStatus(s.id)}><span class="ava-dot"></span>${s.label}</button>`)}
            </div>
            ${linked
              ? html`<div class="ava-callout is-good">On People → Advisory as ${linked.name}${linked.publishStatus === 'draft' ? ' (hidden for now)' : ''}. ${kit.onOpenPerson ? html`<button class="btn btn-ghost btn-sm" onClick=${() => kit.onOpenPerson(linked.slug)}>Open their page</button>` : ''}</div>`
              : html`<div class="ava-actions">
                  <button class="btn btn-primary btn-sm" disabled=${!!busy} onClick=${() => setConfirm('add')}>Add as an advisor</button>
                  <span class="text-sm" style="color:var(--color-text-muted)">${already?.group === 'advisory' ? `${already.name} is already on People → Advisory: this links them.` : 'Makes them a hidden draft on People → Advisory.'}</span>
                </div>`}
          </section>

          <section class="ava-panel" aria-label="How to reach them">
            <h3>How to reach them</h3>
            <dl class="ava-contact">
              ${a.email && html`<dt>Email</dt><dd><a href=${`mailto:${a.email}`}>${a.email}</a></dd>`}
              ${a.phone && html`<dt>Phone</dt><dd><a href=${`tel:${a.phone.replace(/[^\d+]/g, '')}`}>${a.phone}</a></dd>`}
              ${a.link && html`<dt>Online</dt><dd><a href=${a.link} target="_blank" rel="noopener noreferrer">${a.link.replace(/^https?:\/\/(www\.)?/, '')}</a></dd>`}
              ${a.address && html`<dt>Home</dt><dd>${a.address}</dd>`}
            </dl>
          </section>

          ${app.sections.filter((s) => s.id !== 'you').map((s) => html`<section class="ava-panel" key=${s.id} aria-label=${s.title}>
            <h3>${s.title}</h3>
            <div class="ava-qa">
              ${s.items.map((it) => html`<div key=${it.id}><p class="ava-q">${it.label}</p><p class=${`ava-a ${flag(s.id, it) ? 'is-flag' : ''}`}>${it.value}</p></div>`)}
            </div>
          </section>`)}

          <section class="ava-panel" aria-label="Notes">
            <h3>Notes ${app.notes.length ? `(${app.notes.length})` : ''}</h3>
            ${app.notes.length > 0 && html`<ul class="ava-notes">${app.notes.map((n, i) => html`<li key=${i}>${n.text}<small>${[n.by, ago(n.at)].filter(Boolean).join(' · ')}</small></li>`)}</ul>`}
            <div class="ava-note-form">
              <label class="sr-only" for="ava-note" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Add a note</label>
              <textarea id="ava-note" class="form-input" placeholder="A note for staff: a call, next steps…" value=${note} onInput=${(e) => setNote(e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim()) addNote(); }}></textarea>
              <button class="btn btn-primary btn-sm" disabled=${!note.trim() || !!busy} onClick=${addNote}>${busy === 'note' ? 'Saving…' : 'Add note'}</button>
            </div>
          </section>

          <div class="ava-foot">
            <span>${app.statusAt ? `Marked ${statuses.find((s) => s.id === app.status)?.label} ${ago(app.statusAt)}${app.statusBy ? ` by ${app.statusBy}` : ''}` : ''}</span>
            <button class="btn btn-ghost btn-sm btn-row-danger" style="position:static" onClick=${() => setConfirm('remove')}>Delete application</button>
          </div>
        `}
      </div>
    </aside>
    ${confirm === 'add' && app && html`<${Dialog} title=${already?.group === 'advisory' ? `Link ${app.name}` : `Add ${app.name} as an advisor`} busy=${busy === 'add'} onClose=${() => setConfirm(null)}
      footer=${html`
        <button class="btn btn-ghost" onClick=${() => setConfirm(null)} disabled=${busy === 'add'}>Cancel</button>
        <button class="btn btn-primary" onClick=${addAdvisor} disabled=${busy === 'add'}>${busy === 'add' ? 'Adding…' : already?.group === 'advisory' ? 'Link them' : 'Add them'}</button>`}>
      <p>${already?.group === 'advisory' ? `${already.name} is already on People → Advisory. This links the application to them and marks it Joined.` : 'This:'}</p>
      ${!(already?.group === 'advisory') && html`<ul>
        <li>adds them to People → Advisory as a <strong>hidden draft</strong>${app.company ? `, at ${app.company}` : ''},</li>
        ${app.email && html`<li>keeps <strong>${app.email}</strong> as their private email, so reveal invites reach them,</li>`}
        <li>and marks this application Joined.</li>
      </ul>
      <p>They show on the site once you add a photo and turn on Show on the site, then publish.</p>`}
    <//>`}
    ${confirm === 'remove' && app && html`<${Dialog} title=${`Delete ${app.name}’s application?`} size="sm" busy=${busy === 'remove'} onClose=${() => setConfirm(null)}
      footer=${html`
        <button class="btn btn-ghost" data-autofocus onClick=${() => setConfirm(null)} disabled=${busy === 'remove'}>Keep it</button>
        <button class="btn btn-danger" onClick=${remove} disabled=${busy === 'remove'}>${busy === 'remove' ? 'Deleting…' : 'Delete application'}</button>`}>
      <p>Their answers and contact details leave the site for good. Use this when someone asks to be removed, or for a test. ${app.personSlug ? 'Their page on People → Advisory stays.' : ''}</p>
    <//>`}
  </div>`;
}

// ─── Who hears about a new application ──────────────────────────────

function SettingsDialog({ settings, addToast, onClose, onSaved }) {
  const [text, setText] = useState(settings.staffEmails.join('\n'));
  const [committee, setCommittee] = useState(settings.committee || '');
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const j = await call(API, { settings: { staffEmails: text, committee } });
    setBusy(false);
    if (!j.success) { setProblem(j.problems?.staffEmails || j.error || 'That didn’t save'); return; }
    addToast?.('Saved. The next application emails them.', 'info');
    onSaved(j.settings);
  };
  const members = committee === settings.committee ? settings.committeeMembers || [] : null;
  const noEmail = (members || []).filter((m) => !m.hasEmail).map((m) => m.name);
  return html`<${Dialog} title="Who hears about new applications" busy=${busy} onClose=${onClose}
    footer=${html`
      <button class="btn btn-ghost" onClick=${onClose} disabled=${busy}>Cancel</button>
      <button class="btn btn-primary" onClick=${save} disabled=${busy}>${busy ? 'Saving…' : 'Save'}</button>`}>
    <p>Each new application emails these people, with the applicant’s contact details and answers, and posts to Slack without them. A test application (a name starting with TEST) emails only the address on it.</p>
    <div class="form-group">
      <label class="form-label" for="ava-staff">Emails, one per line</label>
      <textarea id="ava-staff" class="form-input" rows="3" spellcheck=${false} value=${text} onInput=${(e) => { setText(e.target.value); setProblem(null); }}></textarea>
      ${problem ? html`<p class="form-hint ink-warn ava-strong">${problem}</p>` : settings.isDefault ? html`<p class="form-hint">Until someone saves this, it goes to ${settings.staffEmails.join(', ')}.</p>` : null}
    </div>
    <div class="form-group">
      <label class="form-label" for="ava-committee">And the board committee</label>
      <select id="ava-committee" class="form-select" value=${committee} onChange=${(e) => { setCommittee(e.target.value); setProblem(null); }}>
        <option value="">No committee</option>
        ${(settings.committees || []).map((c) => html`<option key=${c} value=${c}>${c}</option>`)}
      </select>
      ${committee && html`<p class="form-hint">${members === null
        ? `Board members on the ${committee} committee get them, using their private email from People → Board.`
        : members.length
          ? html`On it now: ${list(members.map((m) => m.name))}.${noEmail.length ? html` <strong>${list(noEmail)} ${noEmail.length === 1 ? 'has' : 'have'} no email yet</strong>: add it on their page in People → Board.` : ''}`
          : html`Nobody on People → Board is on the ${committee} committee yet. Open the board member who leads it, add ${committee} under Committees, and they’ll get these from then on.`}</p>`}
    </div>
  <//>`;
}

/** The tab's badge: how many are New (People → Applications) */
export async function newCount() {
  const j = await call(`${API}?count=1`);
  return j.success ? j.new : 0;
}
