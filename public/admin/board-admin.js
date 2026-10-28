/**
 * Board (admin)
 * =============
 * Loaded on demand by the admin's Board area (#board), which only its admins
 * see (Settings → Who can open it; the founders until saved). Everything for
 * the board's meetings in one place: the agenda before, the notes during, the
 * minutes after, who came, motions and action items, the financials and
 * other files, and the documents library. Board members see what's shared on
 * their own page (/admin/board/, ./board/portal.js), signed in with the same
 * emailed code as staff.
 *
 *   #board                  Meetings (the next one, every meeting, open action items)
 *   #board/meeting/<id>     one meeting's editor
 *   #board/documents        bylaws, policies, budgets; who has signed this year
 *   #board/members          who can sign in, their last visit, Cloudflare's list
 *   #board/settings         who can open this area, quorum, defaults, the agenda template
 * Server: /api/board-admin. The rules: ./board-shared.js.
 */

import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';
import { ask, askToLeave } from './ask.js';
import { viewerLink, sizeText } from './file-viewer.js';
import {
  ATTEND, RESULTS, FILE_KINDS, DOC_KINDS, LIVE, DEFAULT_TEMPLATE, cleanMeeting, meetingName, quarterOf, longDate, shortDate,
  timeRange, money, plural, uid, todayEastern, attendanceCounts, openActions, nextMeeting, parseAgendaText, liveLines, isDate,
} from './board-shared.js';

const html = htm.bind(h);
const API = '/api/board-admin';
const PAGE = '/admin/board/';

async function call(body, { form = null, query = '' } = {}) {
  let r;
  try {
    r = await fetch(`${API}${query}`, form ? { method: 'POST', body: form } : body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { ok: false, error: /cloudflareaccess/i.test(r.url || '') ? 'Your admin session expired. Reload the page and sign in again.' : `HTTP ${r.status}` }; }
  if (!r.ok && j.ok !== false) j.ok = false;
  j.status = r.status;
  return j;
}
const fileUrl = (f) => `/api/board-file?id=${encodeURIComponent(f.id)}`;
const viewerFiles = (files) => files.map((f) => ({ name: f.name, type: f.type, size: f.size, at: f.at, url: fileUrl(f) }));
function ago(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} hr ago`;
  const d = Math.round(m / 1440);
  return d === 1 ? 'yesterday' : d < 14 ? `${d} days ago` : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
const rowsFor = (text, min = 2) => Math.min(24, Math.max(min, String(text || '').split('\n').length + 1));

// ─── Address ────────────────────────────────────────────────────────
const TABS = [['meetings', 'Meetings'], ['documents', 'Documents'], ['members', 'Members'], ['settings', 'Settings']];
function readHash() {
  const m = location.hash.match(/^#board(?:\/([^?]*))?/);
  if (!m) return null;
  const [a, b] = decodeURIComponent(m[1] || '').split('/');
  if (a === 'meeting' && b) return { tab: 'meetings', meetingId: b };
  return { tab: TABS.some(([id]) => id === a) ? a : 'meetings', meetingId: null };
}
const hashFor = (r) => (r.meetingId ? `#board/meeting/${encodeURIComponent(r.meetingId)}` : r.tab === 'meetings' ? '#board' : `#board/${r.tab}`);

// ─── Styles ─────────────────────────────────────────────────────────
const STYLES = `
  .bd { display: grid; gap: 1rem; }
  .bd > .card, .bd-col > .card { margin-bottom: 0; }
  .bd-col { display: grid; gap: 1rem; }
  .bd h3 { margin: 0; font-size: var(--fs-md); }
  .bd-muted { color: var(--color-text-secondary); font-size: var(--fs-sm); line-height: 1.5; margin: 0; }
  .bd-card-head { margin: 0 0 1rem; }
  .bd-card-head h3 { margin: 0; font-size: var(--fs-md); font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; }
  .bd-card-head p { margin: 0.3rem 0 0; max-width: 72ch; font-size: var(--fs-sm); line-height: 1.5; color: var(--color-text-secondary); }
  .bd-row-list { list-style: none; margin: 0; padding: 0; }
  .bd-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; padding: 0.85rem 1.25rem; border-bottom: 1px solid var(--color-border); }
  .bd-row:last-child { border-bottom: none; }
  .bd-row--link { cursor: pointer; }
  .bd-row--link:hover { background: var(--color-bg-hover, rgba(26,27,31,0.03)); }
  .bd-row__main { min-width: 0; flex: 1 1 18rem; }
  .bd-row__title { font-weight: 650; font-size: var(--fs-base); color: var(--color-text); text-decoration: none; }
  .bd-row__title:hover { text-decoration: underline; text-underline-offset: 3px; }
  .bd-row__meta { margin-top: 0.15rem; font-size: var(--fs-sm); color: var(--color-text-secondary); overflow-wrap: anywhere; }
  .bd-tags { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
  .bd-year { padding: 0.55rem 1.25rem; background: var(--color-bg-subtle, #F7F7F5); border-bottom: 1px solid var(--color-border); font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); }
  .bd-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .bd-inline { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .bd-inline .form-input { width: auto; }
  .bd-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: var(--fs-sm); cursor: pointer; }
  .bd-check input { width: 16px; height: 16px; margin: 0; }
  .bd-back { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--color-text-secondary); font-size: var(--fs-sm); text-decoration: none; margin-bottom: 0.25rem; }
  .bd-back:hover { color: var(--color-text); }
  .bd-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 0.75rem 1.5rem; }
  .bd-head h2 { margin: 0; }
  .bd-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
  .bd-grid3 .span-3 { grid-column: 1 / -1; }
  @media (max-width: 900px) { .bd-grid3 { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 600px) { .bd-grid3 { grid-template-columns: 1fr; } .bd-grid3 .span-3 { grid-column: 1; } }

  /* Attendance */
  .bd-people { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  .bd-person { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; padding: 0.55rem 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .bd-person__name { font-weight: 600; }
  .bd-person__org { color: var(--color-text-muted); font-size: var(--fs-xs); margin-left: 0.35rem; }
  .bd-quorum { display: flex; align-items: center; gap: 0.5rem; margin: 0 0 0.85rem; font-size: var(--fs-sm); color: var(--color-text-secondary); }

  /* Agenda */
  .bd-section { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
  .bd-section + .bd-section { margin-top: 0.85rem; }
  .bd-section__head { display: flex; gap: 0.5rem; align-items: center; padding: 0.65rem 0.75rem; border-bottom: 1px solid var(--color-border); background: var(--color-bg-subtle, #F7F7F5); border-radius: var(--radius-md) var(--radius-md) 0 0; }
  .bd-section__num { font-weight: 700; color: var(--color-text-muted); font-size: var(--fs-sm); min-width: 1.5rem; text-align: right; }
  .bd-section__title { flex: 1; font-weight: 700; font-size: var(--fs-base); }
  .bd-items { padding: 0.25rem 0.75rem 0.75rem; }
  .bd-item { padding: 0.75rem 0 0.25rem; border-bottom: 1px dashed var(--color-border); }
  .bd-item:last-of-type { border-bottom: none; }
  .bd-item__top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 14rem) auto; gap: 0.5rem; align-items: center; }
  .bd-item__opts { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; margin-top: 0.5rem; }
  .bd-item__opts .form-select { width: auto; min-width: 12rem; }
  .bd-notes { margin-top: 0.5rem; font-size: var(--fs-sm); line-height: 1.55; }
  /* Empty notes stay two lines and grow as they're typed (rowsFor), not the shared 120px */
  .bd-item .form-textarea { min-height: 0; }
  .bd-staff-note { margin-top: 0.5rem; }
  .bd-staff-note .form-textarea { background: var(--tone-warn-surface); border-color: var(--tone-warn-line); }
  .bd-live { margin: 0.5rem 0 0; padding: 0.55rem 0.75rem; border-radius: var(--radius-md); background: var(--tone-info-surface); border: 1px solid var(--tone-info-line); font-size: var(--fs-sm); line-height: 1.5; }
  .bd-live ul { margin: 0.25rem 0 0 1.1rem; padding: 0; }
  .bd-live__label { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--tone-info-fg); }
  .bd-icon-btns { display: inline-flex; gap: 0.15rem; }
  .bd-icon-btn { border: none; background: none; width: 30px; height: 30px; border-radius: 8px; color: var(--color-text-muted); cursor: pointer; display: inline-grid; place-items: center; font-size: 15px; }
  .bd-icon-btn:hover:not(:disabled) { background: var(--seg-bg); color: var(--color-text); }
  .bd-icon-btn:disabled { opacity: 0.35; cursor: default; }
  @media (max-width: 700px) { .bd-item__top { grid-template-columns: 1fr; } }

  /* Rows of motions, actions, files */
  .bd-lines { display: grid; gap: 0.5rem; }
  .bd-line { display: grid; gap: 0.5rem; align-items: center; padding: 0.55rem 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .bd-line--motion { grid-template-columns: minmax(0, 1fr) 10rem 10rem 9rem auto; }
  .bd-line--action { grid-template-columns: auto minmax(0, 1fr) 13rem 10rem auto; }
  .bd-line--file { grid-template-columns: minmax(0, 1fr) 12rem auto auto; }
  .bd-line.is-done { opacity: 0.65; }
  .bd-line.is-done .bd-line__text { text-decoration: line-through; }
  @media (max-width: 900px) { .bd-line--motion, .bd-line--action, .bd-line--file { grid-template-columns: 1fr; } }
  .bd-file-name { font-weight: 600; text-decoration: none; color: var(--color-text); overflow-wrap: anywhere; }
  .bd-file-name:hover { text-decoration: underline; text-underline-offset: 3px; }
  .bd-drop { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; padding: 0.9rem 1rem; border: 1px dashed var(--color-border-strong); border-radius: var(--radius-md); }
  .bd-drop.is-over { background: var(--tone-info-surface); border-color: var(--tone-info-line-strong); }

  /* Save bar */
  .bd-savebar { position: sticky; bottom: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.75rem 1rem; margin-top: 0.25rem;
    background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: var(--radius-md); box-shadow: 0 -6px 18px rgba(26,27,31,0.06); }
  .bd-savebar__state { font-size: var(--fs-sm); color: var(--color-text-secondary); }

  /* Bring in an old agenda */
  .bd-import textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs); }
  .bd-preview { margin-top: 1rem; display: grid; gap: 0.75rem; }
  .bd-preview ol { margin: 0.25rem 0 0 1.25rem; padding: 0; }
  .bd-preview li { margin: 0.15rem 0; }
  .bd-pre { white-space: pre-wrap; margin: 0.15rem 0 0.35rem; color: var(--color-text-secondary); font-size: var(--fs-xs); }

  /* Members, access */
  .bd-steps { margin: 0.5rem 0 0 1.25rem; padding: 0; display: grid; gap: 0.5rem; font-size: var(--fs-sm); line-height: 1.55; }
  .bd-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: var(--seg-bg); padding: 0.05rem 0.35rem; border-radius: 5px; }
  .bd-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  .bd-table th { text-align: left; font-size: var(--fs-2xs); letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-secondary); padding: 0.6rem 1.25rem; border-bottom: 1px solid var(--color-border); }
  .bd-table td { padding: 0.7rem 1.25rem; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
  .bd-table tr:last-child td { border-bottom: none; }
  @media (max-width: 700px) {
    .bd-table thead { display: none; }
    .bd-table tr { display: grid; gap: 0.2rem; padding: 0.75rem 1.25rem; border-bottom: 1px solid var(--color-border); }
    .bd-table td { padding: 0; border: none; }
    .bd-table td[data-label]::before { content: attr(data-label) ': '; color: var(--color-text-muted); font-size: var(--fs-xs); }
  }
`;
let stylesIn = false;
function injectStyles() {
  if (stylesIn) return;
  stylesIn = true;
  const el = document.createElement('style');
  el.id = 'bd-styles';
  el.textContent = STYLES;
  document.head.appendChild(el);
}

// ─── Little pieces ──────────────────────────────────────────────────
const statusTags = (m) => {
  const out = [];
  out.push(m.shared ? html`<span class="tag tag--success">On the board page</span>` : html`<span class="tag">Not shared yet</span>`);
  if (m.date && m.date < todayEastern()) out.push(m.minutes === 'approved' ? html`<span class="tag tag--success">Minutes approved</span>` : html`<span class="tag tag--warn">Minutes draft</span>`);
  if (m.packetSentAt) out.push(html`<span class="tag tag--info">Packet emailed</span>`);
  if (m.calendar) out.push(m.calendar.gone ? html`<span class="tag tag--warn">Off the calendar</span>` : html`<span class="tag">From the calendar</span>`);
  return out;
};
/** What Board reads from Peter and Holly's email, the one setting it may need, and what came in */
function MailCard({ data }) {
  const m = data.mail || {};
  const recent = data.mailRecent || [];
  const [open, setOpen] = useState(false);
  if (!data.setup.calendar) return null;
  return html`<div class="card" style="padding:0">
    <div class="sec-head"><h3>From email <span class="count">${recent.length}</span></h3><span class="sec-head__hint">${m.checkedAt ? `Looked ${ago(m.checkedAt)}` : 'Not looked yet'}</span>
      <p class="sec-head__desc">Agendas and minutes of past meetings, and QuickBooks’ reports, come in from your and Holly’s email by themselves and land on their meeting. Board only reads; it never sends, deletes or marks anything.</p></div>
    ${m.needsScope ? html`<div class="notice notice--warn" style="margin:1rem 1.25rem"><div class="notice__body">
      <strong>One setting in Google Admin, once.</strong> Open <strong>admin.google.com → Security → Access and data control → API controls → Manage domain-wide delegation</strong>, choose the site’s service account${m.clientId ? html` (client ID <span class="bd-code">${m.clientId}</span>)` : ''}, choose Edit, and add <span class="bd-code">https://www.googleapis.com/auth/gmail.readonly</span> next to the calendar scope that’s there. Board starts reading within the hour.
    </div></div>` : m.errors?.length ? html`<div class="notice notice--warn" style="margin:1rem 1.25rem"><div class="notice__body"><strong>Couldn’t read every inbox.</strong> ${m.errors.join(' · ')}</div></div>` : null}
    ${recent.length ? html`<ul class="bd-row-list">${(open ? recent : recent.slice(0, 4)).map((r) => html`<li class="bd-row">
      <div class="bd-row__main"><div class="bd-row__title">${r.subject || '(no subject)'}</div>
        <div class="bd-row__meta">${[shortDate(String(r.sentAt).slice(0, 10)), r.sender.replace(/<.*>/, '').trim(), r.result].filter(Boolean).join(' · ')}</div></div>
      ${r.meetingId ? html`<a class="btn btn-ghost btn-sm" href=${hashFor({ meetingId: r.meetingId })}>${r.meeting || 'The meeting'}</a>` : null}
    </li>`)}</ul>
    ${recent.length > 4 ? html`<div style="padding:0.5rem 1.25rem 1rem"><button class="btn btn-ghost btn-sm" onClick=${() => setOpen(!open)}>${open ? 'Show fewer' : `Show all ${recent.length}`}</button></div>` : null}`
      : !m.needsScope ? html`<div class="empty empty--inline"><p class="empty__text">${m.checkedAt ? 'Nothing has come by email yet.' : 'The first look is on its way.'}</p></div>` : null}
  </div>`;
}
const firstOf = (email) => { const f = String(email || '').split('@')[0]; return f ? f[0].toUpperCase() + f.slice(1) : 'the'; };
/** Where meetings come from: the admins' calendars, when they were last read, and anything that went wrong */
function CalendarLine({ data }) {
  const c = data.calendar || {};
  const names = data.settings.admins.map(firstOf);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}’s` : `${names[0] || 'your'}’s`;
  if (!data.setup.calendar) return html`<p class="bd-muted" style="margin-top:0.85rem">Add meetings with New meeting. (Board can take them from the calendar once GOOGLE_CALENDAR_KEY is in Cloudflare.)</p>`;
  if (c.errors?.length) return html`<div class="notice notice--warn" style="margin:0.85rem 0 0"><div class="notice__body"><strong>Couldn’t read every calendar.</strong> ${c.errors.join(' · ')}</div></div>`;
  return html`<p class="bd-muted" style="margin-top:0.85rem">Meetings come from ${who} ${names.length > 1 ? 'calendars' : 'calendar'}: any event named like “Board Meeting” from today on, with its day, time and place. ${c.checkedAt ? `Last looked ${ago(c.checkedAt)}${typeof c.found === 'number' ? `, ${plural(c.found, 'meeting')} ahead` : ''}.` : 'Looking for the first time.'}</p>`;
}
function Seg({ value, options, onChange, label, small = false }) {
  return html`<div class="seg" role="radiogroup" aria-label=${label}>
    ${options.map((o) => html`<button type="button" role="radio" aria-checked=${value === o.id} class=${small ? 'btn-sm' : ''} onClick=${() => onChange(o.id)}>${o.label}</button>`)}
  </div>`;
}
function Switch({ checked, onChange, label }) {
  return html`<label class="bc-switch"><input type="checkbox" role="switch" checked=${checked} aria-checked=${checked} onChange=${(e) => onChange(e.target.checked)} /><span class="bc-switch-track" aria-hidden="true"></span><span>${label}</span></label>`;
}
function LiveBox({ kind, numbers, meetingId, locked }) {
  const lines = liveLines(kind, numbers, { meetingId });
  const label = LIVE.find((l) => l.id === kind)?.label || '';
  if (kind === 'minutes') return null;
  return html`<div class="bd-live">
    <div class="bd-live__label">${label}${locked ? ` · locked ${shortDate(String(numbers?.at || '').slice(0, 10))}` : ' · today'}</div>
    ${lines.length ? html`<ul>${lines.map((l) => html`<li>${l}</li>`)}</ul>` : html`<div class="bd-muted">${kind === 'cash' ? (numbers?.mercury?.empty ? 'SOARD’s money isn’t in Mercury yet, so there’s no balance here; the financial statements have it.' : 'No balance from Mercury.') : 'Nothing to show right now.'}</div>`}
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// The area
// ═══════════════════════════════════════════════════════════════════
export function BoardArea({ addToast = () => {}, setGlobalDirty = null }) {
  injectStyles();
  const [route, setRoute] = useState(() => readHash() || { tab: 'meetings', meetingId: null });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const dirty = useRef(false);

  const load = async () => {
    const j = await call();
    if (j.ok) { setData(j); setError(null); } else setError(j.error || 'Couldn’t load the board');
    return j;
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const on = () => {
      const r = readHash();
      if (!r) return;
      if (dirty.current && r.meetingId !== route.meetingId) {
        askToLeave('this meeting').then((ok) => { if (ok) { dirty.current = false; setGlobalDirty?.(false); setRoute(r); } else history.replaceState(null, '', hashFor(route)); });
        return;
      }
      setRoute(r);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [route]);
  const go = (r) => { const next = { tab: 'meetings', meetingId: null, ...r }; if (hashFor(next) !== location.hash) location.hash = hashFor(next); else setRoute(next); };
  const markDirty = (d) => { dirty.current = d; setGlobalDirty?.(d, d ? 'board meeting' : ''); };

  // A meeting changed: put the server's copy into the list
  const putMeeting = (m) => setData((d) => ({ ...d, meetings: [m, ...d.meetings.filter((x) => x.id !== m.id)].sort((a, b) => String(b.date).localeCompare(String(a.date))) }));
  const ctx = { data, setData, load, addToast, go, putMeeting, markDirty };

  if (error && !data) return html`<div class="card empty" role="alert"><p class="empty__title">The board didn’t load</p><p class="empty__text">${error}</p><div class="empty__actions"><button class="btn btn-ghost btn-sm" onClick=${load}>Try again</button></div></div>`;
  if (!data) return html`<div class="area-loading"><span class="spinner" /></div>`;
  const meeting = route.meetingId ? data.meetings.find((m) => m.id === route.meetingId) : null;

  return html`<div class="bd">
    ${route.meetingId ? null : html`
      <div class="hub-tabs" role="tablist" aria-label="Board">
        ${TABS.map(([id, label]) => html`<button type="button" role="tab" aria-selected=${route.tab === id} class=${`hub-tab ${route.tab === id ? 'active' : ''}`} onClick=${() => go({ tab: id })}>${label}</button>`)}
      </div>
      <div class="page-header">
        <div>
          <h2>${{ meetings: 'Board meetings', documents: 'Board documents', members: 'Board members', settings: 'Board settings' }[route.tab]}</h2>
          <p class="page-sub">${{
            meetings: 'The agenda before, the notes during, the minutes after. Board members see a meeting once you share it.',
            documents: 'Bylaws, policies, budgets and plans, on the board page for every member. Ask for a signature where the board signs each year.',
            members: 'Board members sign in at sunshineonaranneyday.com/board with the email on People → Board.',
            settings: 'Who can open this area, the quorum, and what a new meeting starts with.',
          }[route.tab]}</p>
        </div>
        <a class="btn btn-ghost btn-sm" href=${PAGE} target="_blank" rel="noopener">Open the board page</a>
      </div>`}
    ${route.meetingId
      ? (meeting ? html`<${MeetingEditor} key=${meeting.id} meeting=${meeting} ctx=${ctx} />` : html`<div class="card empty"><p class="empty__title">That meeting isn’t here</p><div class="empty__actions"><button class="btn btn-ghost btn-sm" onClick=${() => go({})}>All meetings</button></div></div>`)
      : route.tab === 'documents' ? html`<${DocumentsTab} ctx=${ctx} />`
      : route.tab === 'members' ? html`<${MembersTab} ctx=${ctx} />`
      : route.tab === 'settings' ? html`<${SettingsTab} ctx=${ctx} />`
      : html`<${MeetingsTab} ctx=${ctx} />`}
  </div>`;
}

// ─── Meetings ───────────────────────────────────────────────────────
function MeetingsTab({ ctx }) {
  const { data, go, putMeeting, addToast } = ctx;
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState('');
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const next = nextMeeting(data.meetings);
  const actions = openActions(data.meetings);
  const years = useMemo(() => {
    const by = new Map();
    for (const m of data.meetings) { const y = String(m.date || '').slice(0, 4) || 'No date'; if (!by.has(y)) by.set(y, []); by.get(y).push(m); }
    return [...by.entries()];
  }, [data.meetings]);

  const create = async () => {
    if (!isDate(date)) { addToast('Pick the meeting’s date', 'error'); return; }
    setBusy(true);
    const j = await call({ action: 'new-meeting', date });
    setBusy(false);
    if (!j.ok) { addToast(j.error, 'error'); return; }
    putMeeting(j.meeting);
    setAdding(false); setDate('');
    go({ meetingId: j.meeting.id });
  };
  const toggleAction = async (a) => {
    const j = await call({ action: 'action-done', actionId: a.id, done: true });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    ctx.load();
    addToast(`“${a.text.slice(0, 60)}” is done`, 'info', { label: 'Undo', fn: async () => { await call({ action: 'action-done', actionId: a.id, done: false }); ctx.load(); } });
  };

  return html`
    <div class="card">
      <div class="status-head">
        <div class="status-head__main">
          <span class=${`dot ${next ? 'dot--on' : ''}`} aria-hidden="true"></span>
          <div>
            <h3>${next ? `${meetingName(next)}: ${longDate(next.date)}` : 'No meeting coming up'}</h3>
            <p class="status-head__text">${next
              ? [timeRange(next.start, next.end), next.location].filter(Boolean).join(' · ') || 'Add the time and place'
              : 'Add the next meeting and its agenda starts from the template, with the board on the list and open action items carried over.'}</p>
            ${next ? html`<div class="bd-tags" style="margin-top:0.5rem">${statusTags(next)}</div>` : null}
          </div>
        </div>
        <div class="status-head__actions">
          ${next ? html`<button class="btn btn-primary btn-sm" onClick=${() => go({ meetingId: next.id })}>Open the meeting</button>` : null}
          ${adding ? html`<span class="bd-inline">
              <input class="form-input" type="date" aria-label="Meeting date" value=${date} onInput=${(e) => setDate(e.target.value)} />
              <button class="btn btn-primary btn-sm" disabled=${busy} onClick=${create}>${busy ? 'Adding…' : 'Add'}</button>
              <button class="btn btn-ghost btn-sm" onClick=${() => setAdding(false)}>Cancel</button>
            </span>`
            : html`<button class=${`btn btn-sm ${next ? 'btn-ghost' : 'btn-primary'}`} onClick=${() => setAdding(true)}>New meeting</button>`}
          <button class="btn btn-ghost btn-sm" onClick=${() => setImporting(!importing)} aria-expanded=${importing}>Bring in an old agenda</button>
        </div>
      </div>
      <${CalendarLine} data=${data} />
    </div>
    ${importing ? html`<${ImportPanel} ctx=${ctx} onDone=${(m) => { setImporting(false); if (m) go({ meetingId: m.id }); }} />` : null}
    <${MailCard} data=${data} />

    <div class="card" style="padding:0">
      <div class="sec-head"><h3>Every meeting <span class="count">${data.meetings.length}</span></h3><span class="sec-head__hint">Newest first</span></div>
      ${data.meetings.length ? years.map(([y, list]) => html`
        <div class="bd-year">${y}</div>
        <ul class="bd-row-list">${list.map((m) => {
          const c = attendanceCounts(m);
          return html`<li class="bd-row bd-row--link" key=${m.id} onClick=${(e) => { if (!e.target.closest('a,button')) go({ meetingId: m.id }); }}>
            <div class="bd-row__main">
              <a class="bd-row__title" href=${hashFor({ meetingId: m.id })}>${meetingName(m)}</a>
              <div class="bd-row__meta">${[longDate(m.date), m.location, c.boardHere ? `${c.boardHere} of ${c.board} board members there` : '', m.files.length ? plural(m.files.length, 'file') : ''].filter(Boolean).join(' · ')}</div>
            </div>
            <div class="bd-tags">${statusTags(m)}</div>
          </li>`;
        })}</ul>`)
        : html`<div class="empty empty--inline"><p class="empty__title">No meetings yet</p><p class="empty__text">Add the next one, or bring in an old agenda (paste its text, or choose its PDF).</p></div>`}
    </div>

    <div class="card" style="padding:0">
      <div class="sec-head"><h3>Open action items <span class="count">${actions.length}</span></h3><span class="sec-head__hint">Carried onto each new agenda until done</span></div>
      ${actions.length ? html`<ul class="bd-row-list">${actions.map((a) => html`<li class="bd-row" key=${a.id}>
          <div class="bd-row__main">
            <div class="bd-row__title">${a.text}</div>
            <div class="bd-row__meta">${[a.ownerName || 'No one yet', a.due ? `due ${shortDate(a.due)}` : '', `from the ${a.meetingName}`].filter(Boolean).join(' · ')}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onClick=${() => toggleAction(a)}>Mark done</button>
        </li>`)}</ul>`
        : html`<div class="empty empty--inline"><p class="empty__text">Nothing open. Action items you add to a meeting show here until they’re done.</p></div>`}
    </div>`;
}

// ─── Bring in an old agenda ─────────────────────────────────────────
/** A PDF's text, line by line, the way it reads on the page */
async function pdfText(file) {
  const { pdfjsLib } = await import('./vendor-pdf.js');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const rows = [];
    for (const it of content.items) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5]);
      let row = rows.find((r) => Math.abs(r.y - y) <= 2);
      if (!row) { row = { y, parts: [] }; rows.push(row); }
      row.parts.push({ x: it.transform[4], s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) lines.push(r.parts.sort((a, b) => a.x - b.x).map((x) => x.s).join(' ').replace(/\s+/g, ' ').trim());
  }
  return lines.join('\n');
}

function ImportPanel({ ctx, onDone }) {
  const { data, addToast, putMeeting } = ctx;
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const people = useMemo(() => [
    ...data.people.board.map((p) => ({ slug: p.slug, name: p.name, org: p.organization, kind: 'board' })),
    ...data.people.staff.map((p) => ({ slug: p.slug, name: p.name, org: 'SOARD', kind: 'staff' })),
  ], [data.people]);
  const parsed = useMemo(() => (text.trim() ? parseAgendaText(text, people) : null), [text, people]);
  const choose = async (f) => {
    if (!f) return;
    setFile(f);
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { addToast('That’s not a PDF. Paste the agenda’s text instead (open it in Word, select all, copy).', 'error'); return; }
    setReading(true);
    try { setText(await pdfText(f)); } catch (e) { addToast(`Couldn’t read that PDF: ${e.message}`, 'error'); }
    setReading(false);
  };
  const save = async () => {
    setSaving(true);
    const j = await call({ action: 'import-meeting', meeting: parsed });
    if (!j.ok) { setSaving(false); addToast(j.error, 'error'); return; }
    let m = j.meeting;
    if (file && /\.pdf$/i.test(file.name)) {
      const form = new FormData();
      form.set('file', file); form.set('ownerType', 'meeting'); form.set('ownerId', m.id); form.set('kind', 'agenda'); form.set('staffOnly', 'false');
      const up = await call(null, { form, query: '?upload=1' });
      if (up.ok) m = { ...m, files: [...m.files, up.file] };
      else addToast(`The meeting is in, but its PDF didn’t attach: ${up.error}`, 'error');
    }
    setSaving(false);
    putMeeting(m);
    addToast(`${meetingName(m)} is in. Check it over, then share it with the board.`, 'success');
    onDone(m);
  };
  const items = parsed ? parsed.sections.reduce((n, s) => n + s.items.length, 0) : 0;
  return html`<div class="card bd-import">
    <div class="bd-card-head"><h3>Bring in an old agenda</h3><p>Choose the agenda’s PDF, or paste its text from Word. The date, place, who was there (the x’s), each section, its items and the notes under them come across; check it over before it’s added.</p></div>
    <div class=${`bd-drop`} onDragOver=${(e) => { e.preventDefault(); e.currentTarget.classList.add('is-over'); }} onDragLeave=${(e) => e.currentTarget.classList.remove('is-over')}
      onDrop=${(e) => { e.preventDefault(); e.currentTarget.classList.remove('is-over'); choose(e.dataTransfer.files[0]); }}>
      <label class="btn btn-ghost btn-sm">Choose the PDF<input type="file" accept="application/pdf,.pdf" hidden onChange=${(e) => choose(e.target.files[0])} /></label>
      <span class="bd-muted">${reading ? 'Reading it…' : file ? file.name : 'or drop it here, or paste the text below'}</span>
    </div>
    <div class="form-group" style="margin-top:0.75rem">
      <label class="form-label" for="bd-import-text">The agenda’s text</label>
      <textarea id="bd-import-text" class="form-textarea" rows="8" value=${text} onInput=${(e) => setText(e.target.value)} placeholder="MEETING  SOARD Board – Agenda   DATE 04/30/2026&#10;1. CALL TO ORDER&#10;1. Roll Call&#10;…" />
    </div>
    ${parsed ? html`<div class="bd-preview">
      <div class=${`notice ${parsed.date ? 'notice--info' : 'notice--warn'}`}><div class="notice__body">
        <strong>${parsed.date ? `${quarterOf(parsed.date)} Board Meeting, ${longDate(parsed.date)}` : 'No date found: add it in the meeting after'}</strong>
        ${parsed.start ? ` · ${timeRange(parsed.start, parsed.end)}` : ''}${parsed.location ? ` · ${parsed.location}` : ''}<br />
        ${plural(parsed.attendance.filter((a) => a.status === 'present').length, 'person', 'people')} there, ${parsed.attendance.filter((a) => a.status === 'absent').length} absent · ${plural(parsed.sections.length, 'section')}, ${plural(items, 'item')}
        ${parsed.unmatched.length ? html`<br />Couldn’t place: ${parsed.unmatched.map((u) => `“${u}”`).join(', ')}` : null}
      </div></div>
      <ol>${parsed.sections.map((s) => html`<li><strong>${s.title}</strong>
        <ol>${s.items.map((it) => html`<li>${it.title || html`<em>(no title)</em>`}${it.presenter ? html` <span class="tag">${it.presenter}</span>` : null}${it.notes ? html`<div class="bd-pre">${it.notes}</div>` : null}</li>`)}</ol>
      </li>`)}</ol>
      <div class="bd-actions">
        <button class="btn btn-primary" disabled=${saving || !parsed.sections.length} onClick=${save}>${saving ? 'Adding…' : 'Add this meeting'}</button>
        <button class="btn btn-ghost" onClick=${() => onDone(null)}>Cancel</button>
        <span class="bd-muted">It’s added as ${parsed.date && parsed.date < todayEastern() ? 'approved minutes' : 'a draft'}, not shared with the board until you say so.</span>
      </div>
    </div>` : null}
  </div>`;
}

// ─── One meeting ────────────────────────────────────────────────────
function MeetingEditor({ meeting, ctx }) {
  const { data, addToast, go, putMeeting, markDirty } = ctx;
  const [m, setM] = useState(meeting);
  const [base, setBase] = useState(meeting.updatedAt);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState('');
  const savedJson = useRef(JSON.stringify(cleanMeeting(meeting)));
  const dirty = JSON.stringify(cleanMeeting(m)) !== savedJson.current;
  useEffect(() => { markDirty(dirty); }, [dirty]);
  useEffect(() => () => markDirty(false), []);
  const set = (patch) => setM((x) => ({ ...x, ...patch }));
  const people = useMemo(() => [
    ...data.people.board.map((p) => ({ slug: p.slug, name: p.name, org: p.organization, kind: 'board' })),
    ...data.people.staff.map((p) => ({ slug: p.slug, name: p.name, org: 'SOARD', kind: 'staff' })),
  ], [data.people]);
  const numbers = m.snapshot || data.numbers;

  const adopt = (saved) => { savedJson.current = JSON.stringify(cleanMeeting(saved)); setM(saved); setBase(saved.updatedAt); putMeeting(saved); };
  // A change the server already has (a file, an action ticked off): onto both this copy and the saved one, so it isn't "unsaved"
  const keepSaved = (fn) => {
    savedJson.current = JSON.stringify(cleanMeeting(fn(JSON.parse(savedJson.current))));
    setM((x) => fn(x));
    putMeeting(fn(meeting));
  };
  const save = async () => {
    if (!m.date) { addToast('A meeting needs a date', 'error'); return false; }
    setSaving(true);
    const j = await call({ action: 'save-meeting', meeting: m, base });
    setSaving(false);
    if (j.status === 409 && j.current) {
      const who = j.current.updatedBy || 'Someone';
      if (await ask({ title: `${who} saved this meeting after you opened it`, text: 'Load their version? Your changes since you opened it would be lost. Cancel keeps your copy here so you can copy anything out first.', yes: 'Load their version' })) adopt(j.current);
      return false;
    }
    if (!j.ok) { addToast(j.error, 'error'); return false; }
    adopt(j.meeting);
    addToast('Meeting saved', 'info');
    return true;
  };
  useEffect(() => {
    const on = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });
  const act = async (name, body, okText) => {
    if (dirty && !(await save())) return null;
    setWorking(name);
    const j = await call(body);
    setWorking('');
    if (!j.ok) { addToast(j.error, 'error'); return null; }
    if (j.meeting) adopt(j.meeting);
    if (okText) addToast(typeof okText === 'function' ? okText(j) : okText, 'info');
    return j;
  };
  const remove = async () => {
    if (!(await ask({ title: `Delete the ${meetingName(m)}?`, text: 'Its agenda, notes, minutes and files go for good. Board members stop seeing it.', yes: 'Delete', danger: true }))) return;
    const j = await call({ action: 'delete-meeting', id: m.id });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    markDirty(false);
    ctx.setData((d) => ({ ...d, meetings: d.meetings.filter((x) => x.id !== m.id) }));
    addToast('Meeting deleted', 'info');
    go({});
  };

  // Agenda edits
  const setSection = (si, patch) => set({ sections: m.sections.map((s, i) => (i === si ? { ...s, ...patch } : s)) });
  const setItem = (si, ii, patch) => setSection(si, { items: m.sections[si].items.map((it, j) => (j === ii ? { ...it, ...patch } : it)) });
  const move = (list, i, d) => { const out = [...list]; const [x] = out.splice(i, 1); out.splice(i + d, 0, x); return out; };
  const blankItem = () => ({ id: uid('i_'), title: '', presenter: '', notes: '', staffNote: '', confidential: false, live: '' });

  const c = attendanceCounts(m);
  const quorum = data.settings.quorum;
  const cal = m.calendar;
  const fromCal = !!cal && !cal.gone;
  return html`
    <div>
      <a class="bd-back" href="#board" onClick=${(e) => { e.preventDefault(); go({}); }}>← All meetings</a>
      <div class="bd-head">
        <div>
          <h2>${meetingName(m)}</h2>
          <p class="page-sub">${[longDate(m.date), timeRange(m.start, m.end), m.location].filter(Boolean).join(' · ') || 'Add the date, time and place'}</p>
        </div>
        <div class="bd-tags">${statusTags(m)}</div>
      </div>
    </div>

    <div class="card">
      <div class="bd-card-head"><h3>When and where</h3>${cal ? html`<p>${cal.gone
        ? html`This meeting is no longer on ${firstOf(cal.from)}’s calendar. If it’s off, delete it here.`
        : html`From ${firstOf(cal.from)}’s calendar (“${cal.title}”). Change the day, time${cal.place ? ' or place' : ''} there, and it follows here within the hour.${cal.place ? '' : ` The invite has no address yet${cal.said ? ` (its place says “${cal.said}”, and its notes have none)` : ''}: add it to the invite, or type it here.`}${cal.link ? html` <a class="link" href=${cal.link} target="_blank" rel="noopener">Open the event</a>` : null}`}</p>` : null}</div>
      ${cal?.gone ? html`<div class="notice notice--warn"><div class="notice__body"><strong>Off the calendar.</strong> The event “${cal.title}” is gone from every calendar Board reads.</div></div>` : null}
      <div class="bd-grid3">
        <div class="form-group"><label class="form-label" for="bd-date">Date</label><input id="bd-date" class="form-input" type="date" value=${m.date} disabled=${fromCal} onInput=${(e) => set({ date: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-start">Starts</label><input id="bd-start" class="form-input" type="time" value=${m.start} disabled=${fromCal} onInput=${(e) => set({ start: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-end">Ends</label><input id="bd-end" class="form-input" type="time" value=${m.end} disabled=${fromCal} onInput=${(e) => set({ end: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-loc">Place</label><input id="bd-loc" class="form-input" value=${m.location} placeholder="Crosby Design Group" disabled=${fromCal && cal.place} onInput=${(e) => set({ location: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-addr">Address <span class="form-optional">optional</span></label><input id="bd-addr" class="form-input" value=${m.address} disabled=${fromCal && cal.place} onInput=${(e) => set({ address: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-video">Video link <span class="form-optional">optional</span></label><input id="bd-video" class="form-input" type="url" value=${m.video} placeholder="https://" disabled=${fromCal && cal.call} onInput=${(e) => set({ video: e.target.value })} /></div>
        <div class="form-group span-3"><label class="form-label" for="bd-title">Name <span class="form-optional">optional</span></label><input id="bd-title" class="form-input" value=${m.title} placeholder=${m.date ? `${quarterOf(m.date)} Board Meeting` : 'Board meeting'} onInput=${(e) => set({ title: e.target.value })} /><p class="form-hint">Left empty, the quarter names it.</p></div>
      </div>
    </div>

    <div class="card">
      <div class="bd-card-head"><h3>Who’s there</h3><p>Board members answer on their page whether they’re coming; you mark who was there.</p></div>
      <p class="bd-quorum"><span class=${`dot ${quorum ? (c.boardHere >= quorum ? 'dot--on' : 'dot--warn') : ''}`} aria-hidden="true"></span>
        ${c.boardHere} of ${c.board} board members there${quorum ? ` · a quorum is ${quorum}${c.boardHere >= quorum ? ', so there is one' : ''}` : ''}</p>
      <ul class="bd-people">${m.attendance.map((p, i) => html`<li class="bd-person" key=${p.key}>
        <div><span class="bd-person__name">${p.name}</span><span class="bd-person__org">${p.kind === 'board' ? p.org || 'Board' : p.kind === 'staff' ? 'SOARD' : `Guest${p.org ? `, ${p.org}` : ''}`}</span>
          ${p.rsvp ? html` <span class=${`tag ${p.rsvp === 'no' ? '' : 'tag--info'}`}>${{ yes: 'Said they’ll come', remote: 'Said by video', no: 'Said they can’t' }[p.rsvp]}</span>` : null}</div>
        <div class="bd-inline">
          <${Seg} small value=${p.status} options=${ATTEND} label=${`${p.name} was`} onChange=${(v) => set({ attendance: m.attendance.map((x, j) => (j === i ? { ...x, status: x.status === v ? '' : v } : x)) })} />
          ${p.kind === 'guest' ? html`<button class="bd-icon-btn" aria-label=${`Take ${p.name} off`} onClick=${() => set({ attendance: m.attendance.filter((_, j) => j !== i) })}>✕</button>` : null}
        </div>
      </li>`)}</ul>
      <${AddPerson} people=${people} present=${m.attendance} onAdd=${(p) => set({ attendance: [...m.attendance, p] })} />
    </div>

    <div class="card">
      <div class="bd-card-head"><h3>Agenda and notes</h3><p>Type notes under each item during the meeting. A line starting with “- ” is a point; two spaces deeper is a point under it. Your own notes (yellow) never reach the board; a confidential item is never emailed.</p></div>
      ${m.sections.map((s, si) => html`<div class="bd-section" key=${s.id}>
        <div class="bd-section__head">
          <span class="bd-section__num">${si + 1}.</span>
          <input class="form-input bd-section__title" aria-label=${`Section ${si + 1}`} value=${s.title} placeholder="Section" onInput=${(e) => setSection(si, { title: e.target.value })} />
          <span class="bd-icon-btns">
            <button class="bd-icon-btn" aria-label="Move the section up" disabled=${si === 0} onClick=${() => set({ sections: move(m.sections, si, -1) })}>↑</button>
            <button class="bd-icon-btn" aria-label="Move the section down" disabled=${si === m.sections.length - 1} onClick=${() => set({ sections: move(m.sections, si, 1) })}>↓</button>
            <button class="bd-icon-btn" aria-label="Delete the section" onClick=${async () => { if (!s.items.some((it) => it.notes || it.title) || await ask({ title: `Delete “${s.title || 'this section'}”?`, text: 'Its items and their notes go with it.', yes: 'Delete', danger: true })) set({ sections: m.sections.filter((_, i) => i !== si) }); }}>✕</button>
          </span>
        </div>
        <div class="bd-items">
          ${s.items.map((it, ii) => html`<div class="bd-item" key=${it.id}>
            <div class="bd-item__top">
              <input class="form-input" aria-label="Item" value=${it.title} placeholder="Item" onInput=${(e) => setItem(si, ii, { title: e.target.value })} />
              <input class="form-input" aria-label="Presented by" value=${it.presenter} placeholder="Presented by" list="bd-people-names" onInput=${(e) => setItem(si, ii, { presenter: e.target.value })} />
              <span class="bd-icon-btns">
                <button class="bd-icon-btn" aria-label="Move up" disabled=${ii === 0} onClick=${() => setSection(si, { items: move(s.items, ii, -1) })}>↑</button>
                <button class="bd-icon-btn" aria-label="Move down" disabled=${ii === s.items.length - 1} onClick=${() => setSection(si, { items: move(s.items, ii, 1) })}>↓</button>
                <button class="bd-icon-btn" aria-label="Delete the item" onClick=${async () => { if (!it.notes || await ask({ title: `Delete “${it.title || 'this item'}”?`, text: 'Its notes go with it.', yes: 'Delete', danger: true })) setSection(si, { items: s.items.filter((_, j) => j !== ii) }); }}>✕</button>
              </span>
            </div>
            <textarea class="form-textarea bd-notes" aria-label=${`Notes for ${it.title || 'this item'}`} rows=${rowsFor(it.notes)} value=${it.notes} placeholder="Notes" onInput=${(e) => setItem(si, ii, { notes: e.target.value })} />
            ${it.live && it.live !== 'minutes' ? html`<${LiveBox} kind=${it.live} numbers=${numbers} meetingId=${m.id} locked=${!!m.snapshot} />` : null}
            ${it.staffNote || it.showStaff ? html`<div class="bd-staff-note"><textarea class="form-textarea" aria-label="Your own note" rows=${rowsFor(it.staffNote)} value=${it.staffNote} placeholder="Your own note: only the Board area’s admins see it" onInput=${(e) => setItem(si, ii, { staffNote: e.target.value })} /></div>` : null}
            <div class="bd-item__opts">
              <label class="bd-check"><input type="checkbox" checked=${it.confidential} onChange=${(e) => setItem(si, ii, { confidential: e.target.checked })} /> Confidential (never emailed)</label>
              ${!it.staffNote && !it.showStaff ? html`<button class="btn btn-ghost btn-sm" onClick=${() => setItem(si, ii, { showStaff: true })}>Add your own note</button>` : null}
              <select class="form-select" aria-label="Show live facts" value=${it.live} onChange=${(e) => setItem(si, ii, { live: e.target.value })}>
                <option value="">No live facts</option>
                ${[...LIVE, { id: 'minutes', label: 'The last meeting’s minutes' }].map((l) => html`<option value=${l.id}>${l.label}</option>`)}
              </select>
            </div>
          </div>`)}
          <button class="btn btn-ghost btn-sm" style="margin-top:0.5rem" onClick=${() => setSection(si, { items: [...s.items, blankItem()] })}>Add an item</button>
        </div>
      </div>`)}
      <datalist id="bd-people-names">${people.map((p) => html`<option value=${p.name.split(' ')[0]} />`)}</datalist>
      <button class="btn btn-ghost btn-sm" style="margin-top:0.85rem" onClick=${() => set({ sections: [...m.sections, { id: uid('s_'), title: '', items: [blankItem()] }] })}>Add a section</button>
    </div>

    <${Motions} m=${m} set=${set} people=${people} />
    <${Actions} m=${m} set=${set} people=${people} saved=${meeting} ctx=${ctx} onDone=${(id, done) => keepSaved((x) => ({ ...x, actions: x.actions.map((a) => (a.id === id ? { ...a, done } : a)) }))} />
    <${Files} m=${m} ctx=${ctx} onFiles=${(files) => keepSaved((x) => ({ ...x, files }))} />

    <div class="card">
      <div class="bd-card-head"><h3>The packet</h3><p>Lock in the numbers the board sees, share the meeting, then email the board that it’s ready. The email has the agenda’s headings and a button, never notes or financials.</p></div>
      <div class="bd-col">
        <div class="status-head">
          <div class="status-head__main"><span class=${`dot ${m.snapshot ? 'dot--on' : ''}`} aria-hidden="true"></span><div>
            <h3>${m.snapshot ? `Numbers locked ${shortDate(m.snapshot.at.slice(0, 10))}` : 'Numbers are today’s'}</h3>
            <p class="status-head__text">${liveLines('cash', numbers)[0] || (numbers?.mercury?.empty ? 'Mercury is empty so far, so no balance' : data.setup.mercury ? 'No balance from Mercury' : 'Mercury isn’t connected (MERCURY_API_TOKEN and MERCURY_RELAY_KEY), so no balance')}${liveLines('projects', numbers)[0] ? ` · ${liveLines('projects', numbers)[0]}` : ''}</p>
          </div></div>
          <div class="status-head__actions"><button class="btn btn-ghost btn-sm" disabled=${!!working} onClick=${() => act('snapshot', { action: 'snapshot', id: m.id }, 'Today’s numbers are locked in')}>${working === 'snapshot' ? 'Locking…' : m.snapshot ? 'Update to today’s numbers' : 'Lock in today’s numbers'}</button></div>
        </div>
        <div class="status-head">
          <div class="status-head__main"><span class=${`dot ${m.shared ? 'dot--on' : ''}`} aria-hidden="true"></span><div>
            <h3>${m.shared ? 'On the board page' : 'Not on the board page yet'}</h3>
            <p class="status-head__text">${m.shared ? 'Board members see the agenda, notes, motions, action items and files (not staff-only ones).' : 'Share it when the agenda is ready.'}</p>
          </div></div>
          <div class="status-head__actions"><${Switch} checked=${m.shared} label="Shared" onChange=${(v) => set({ shared: v })} /></div>
        </div>
        <div class="status-head">
          <div class="status-head__main"><span class=${`dot ${m.packetSentAt ? 'dot--on' : ''}`} aria-hidden="true"></span><div>
            <h3>${m.packetSentAt ? `Emailed to ${plural(m.packetSentTo, 'board member')} ${ago(m.packetSentAt)}` : 'The board hasn’t been emailed'}</h3>
            <p class="status-head__text">${data.packetTo ? `${plural(data.packetTo, 'board member')} with an email on People → Board` : 'No board member has an email on People → Board yet'}${data.setup.email ? '' : ' · email isn’t set up'}</p>
          </div></div>
          <div class="status-head__actions">
            <button class="btn btn-ghost btn-sm" disabled=${!!working || !data.setup.email} onClick=${() => act('preview', { action: 'send-packet', id: m.id, test: true }, (j) => `Sent to ${j.to?.[0] || 'you'}`)}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>
            <button class="btn btn-primary btn-sm" disabled=${!!working || !m.shared || !data.packetTo || !data.setup.email} title=${m.shared ? '' : 'Share the meeting first'}
              onClick=${async () => { if (await ask({ title: `Email ${plural(data.packetTo, 'board member')}?`, text: `“The packet for the ${meetingName(m)} is ready,” with the agenda’s headings and a button to the board page.`, yes: m.packetSentAt ? 'Email them again' : 'Email the board' })) act('send', { action: 'send-packet', id: m.id }, (j) => `Emailed ${plural(j.sent, 'board member')}`); }}>
              ${working === 'send' ? 'Sending…' : m.packetSentAt ? 'Email again' : 'Email the board'}</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="status-head">
        <div class="status-head__main"><div>
          <h3>Minutes</h3>
          <p class="status-head__text">${m.minutes === 'approved' ? `Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}. The board page shows them as approved.` : 'A draft until the board approves them at the next meeting.'}</p>
        </div></div>
        <div class="status-head__actions"><${Seg} value=${m.minutes} label="Minutes" options=${[{ id: 'draft', label: 'Draft' }, { id: 'approved', label: 'Approved' }]} onChange=${(v) => set({ minutes: v, approvedOn: v === 'approved' ? (m.approvedOn || todayEastern()) : '' })} /></div>
      </div>
    </div>

    <div class="bd-savebar">
      <span class="bd-savebar__state">${saving ? 'Saving…' : dirty ? 'Unsaved changes' : `Saved${m.updatedAt ? ` ${ago(m.updatedAt)}` : ''}${m.updatedBy ? ` by ${m.updatedBy.split('@')[0]}` : ''}`}</span>
      <div class="bd-actions">
        <button class="btn btn-ghost btn-sm btn-row-danger" onClick=${remove}>Delete meeting</button>
        <a class="btn btn-ghost btn-sm" href=${`${PAGE}#/meetings/${m.id}`} target="_blank" rel="noopener">See it as the board does</a>
        <button class="btn btn-primary" disabled=${saving || !dirty} onClick=${save}>Save</button>
      </div>
    </div>`;
}

function AddPerson({ people, present, onAdd }) {
  const [name, setName] = useState('');
  const [org, setOrg] = useState('');
  const known = people.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const here = new Set(present.map((p) => p.slug).filter(Boolean));
  const add = () => {
    if (!name.trim()) return;
    onAdd(known && !here.has(known.slug) ? { key: known.slug, slug: known.slug, name: known.name, org: known.org, kind: known.kind, status: 'present', rsvp: '' } : { key: `guest:${name.trim().toLowerCase()}`, name: name.trim(), org: org.trim(), kind: 'guest', status: 'present', rsvp: '' });
    setName(''); setOrg('');
  };
  return html`<div class="bd-inline" style="margin-top:0.75rem">
    <input class="form-input" aria-label="Add someone" placeholder="Add a guest or board member" list="bd-add-people" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') add(); }} style="min-width:16rem" />
    ${known ? null : html`<input class="form-input" aria-label="Their company" placeholder="Company" value=${org} onInput=${(e) => setOrg(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') add(); }} />`}
    <button class="btn btn-ghost btn-sm" disabled=${!name.trim()} onClick=${add}>Add</button>
    <datalist id="bd-add-people">${people.filter((p) => !here.has(p.slug)).map((p) => html`<option value=${p.name} />`)}</datalist>
  </div>`;
}

function Motions({ m, set, people }) {
  const upd = (i, patch) => set({ motions: m.motions.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return html`<div class="card">
    <div class="bd-card-head"><h3>Motions and votes</h3><p>What the board voted on, for the minutes: “Approve the Q1 minutes”, “Approve the 2027 budget”.</p></div>
    ${m.motions.length ? html`<div class="bd-lines">${m.motions.map((x, i) => html`<div class="bd-line bd-line--motion" key=${x.id}>
      <input class="form-input" aria-label="Motion" value=${x.text} placeholder="The motion" onInput=${(e) => upd(i, { text: e.target.value })} />
      <input class="form-input" aria-label="Moved by" value=${x.by} placeholder="Moved by" list="bd-people-names-full" onInput=${(e) => upd(i, { by: e.target.value })} />
      <input class="form-input" aria-label="Seconded by" value=${x.second} placeholder="Seconded by" list="bd-people-names-full" onInput=${(e) => upd(i, { second: e.target.value })} />
      <select class="form-select" aria-label="Result" value=${x.result} onChange=${(e) => upd(i, { result: e.target.value })}>${RESULTS.map((r) => html`<option value=${r.id}>${r.label}</option>`)}</select>
      <button class="bd-icon-btn" aria-label="Delete the motion" onClick=${() => set({ motions: m.motions.filter((_, j) => j !== i) })}>✕</button>
    </div>`)}</div>` : null}
    <datalist id="bd-people-names-full">${people.map((p) => html`<option value=${p.name} />`)}</datalist>
    <button class="btn btn-ghost btn-sm" style="margin-top:0.75rem" onClick=${() => set({ motions: [...m.motions, { id: uid('v_'), text: '', by: '', second: '', result: 'passed' }] })}>Add a motion</button>
  </div>`;
}

function Actions({ m, set, people, saved, ctx, onDone }) {
  const upd = (i, patch) => set({ actions: m.actions.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const savedIds = new Set(saved.actions.map((a) => a.id));
  const tick = async (a, done) => {
    const j = await call({ action: 'action-done', actionId: a.id, done });
    if (!j.ok) { ctx.addToast(j.error, 'error'); return; }
    onDone(a.id, done);
    ctx.load();
  };
  return html`<div class="card">
    <div class="bd-card-head"><h3>Action items</h3><p>Who does what by when. Each shows on that board member’s page, and stays on every new agenda until it’s done.</p></div>
    ${m.actions.length ? html`<div class="bd-lines">${m.actions.map((a, i) => html`<div class=${`bd-line bd-line--action ${a.done ? 'is-done' : ''}`} key=${a.id}>
      <input type="checkbox" aria-label="Done" checked=${a.done} disabled=${!savedIds.has(a.id)} title=${savedIds.has(a.id) ? '' : 'Save first'} onChange=${(e) => tick(a, e.target.checked)} />
      <input class="form-input bd-line__text" aria-label="Action item" value=${a.text} placeholder="What needs doing" onInput=${(e) => upd(i, { text: e.target.value })} />
      <select class="form-select" aria-label="Whose it is" value=${a.owner || (a.ownerName ? `name:${a.ownerName}` : '')} onChange=${(e) => { const p = people.find((x) => x.slug === e.target.value); upd(i, p ? { owner: p.slug, ownerName: p.name } : { owner: '', ownerName: '' }); }}>
        <option value="">No one yet</option>
        ${a.ownerName && !a.owner ? html`<option value=${`name:${a.ownerName}`}>${a.ownerName}</option>` : null}
        ${people.map((p) => html`<option value=${p.slug}>${p.name}</option>`)}
      </select>
      <input class="form-input" type="date" aria-label="Due" value=${a.due} onInput=${(e) => upd(i, { due: e.target.value })} />
      <button class="bd-icon-btn" aria-label="Delete the action item" onClick=${() => set({ actions: m.actions.filter((_, j) => j !== i) })}>✕</button>
    </div>`)}</div>` : null}
    <button class="btn btn-ghost btn-sm" style="margin-top:0.75rem" onClick=${() => set({ actions: [...m.actions, { id: uid('a_'), text: '', owner: '', ownerName: '', due: '', done: false, doneOn: '' }] })}>Add an action item</button>
  </div>`;
}

function Files({ m, ctx, onFiles }) {
  const { addToast } = ctx;
  const [uploading, setUploading] = useState(0);
  const upload = async (list) => {
    const files = [...(list || [])];
    if (!files.length) return;
    setUploading(files.length);
    let next = [...m.files];
    for (const f of files) {
      const form = new FormData();
      form.set('file', f); form.set('ownerType', 'meeting'); form.set('ownerId', m.id);
      form.set('kind', /financ|balance|income|p&l|profit|budget|statement/i.test(f.name) ? 'financials' : 'other'); form.set('staffOnly', 'false');
      const j = await call(null, { form, query: '?upload=1' });
      if (j.ok) next = [...next, j.file]; else addToast(`${f.name}: ${j.error}`, 'error');
      setUploading((n) => n - 1);
    }
    onFiles(next);
  };
  const update = async (f, patch) => {
    const j = await call({ action: 'update-file', id: f.id, ...patch });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    onFiles(m.files.map((x) => (x.id === f.id ? { ...x, ...j.file } : x)));
  };
  const remove = async (f) => {
    if (!(await ask({ title: `Delete ${f.name}?`, text: 'It goes for good, from the board page too.', yes: 'Delete', danger: true }))) return;
    const j = await call({ action: 'delete-file', id: f.id });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    onFiles(m.files.filter((x) => x.id !== f.id));
  };
  const vf = viewerFiles(m.files);
  return html`<div class="card">
    <div class="bd-card-head"><h3>Financials and other files</h3><p>The income statement and balance sheet, the budget, a deck. PDFs, pictures, Word, Excel or PowerPoint, up to 50 MB. A staff-only file never reaches the board page.</p></div>
    ${m.files.length ? html`<div class="bd-lines">${m.files.map((f, i) => html`<div class="bd-line bd-line--file" key=${f.id}>
      <div><a class="bd-file-name" ...${viewerLink(vf, i)}>${f.name}</a><div class="bd-row__meta">${[sizeText(f.size), f.at ? shortDate(f.at.slice(0, 10)) : ''].filter(Boolean).join(' · ')}</div></div>
      <select class="form-select" aria-label="What it is" value=${f.kind} onChange=${(e) => update(f, { kind: e.target.value })}>${FILE_KINDS.map((k) => html`<option value=${k.id}>${k.label}</option>`)}</select>
      <label class="bd-check"><input type="checkbox" checked=${f.staffOnly} onChange=${(e) => update(f, { staffOnly: e.target.checked })} /> Staff only</label>
      <button class="bd-icon-btn" aria-label=${`Delete ${f.name}`} onClick=${() => remove(f)}>✕</button>
    </div>`)}</div>` : null}
    <div class="bd-drop" style="margin-top:0.75rem" onDragOver=${(e) => { e.preventDefault(); e.currentTarget.classList.add('is-over'); }} onDragLeave=${(e) => e.currentTarget.classList.remove('is-over')}
      onDrop=${(e) => { e.preventDefault(); e.currentTarget.classList.remove('is-over'); upload(e.dataTransfer.files); }}>
      <label class="btn btn-ghost btn-sm">Add files<input type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.docx,.xlsx,.pptx,.doc,.xls" onChange=${(e) => { upload(e.target.files); e.target.value = ''; }} /></label>
      <span class="bd-muted">${uploading ? `Uploading ${plural(uploading, 'file')}…` : 'or drop them here'}</span>
    </div>
  </div>`;
}

// ─── Documents ──────────────────────────────────────────────────────
function DocumentsTab({ ctx }) {
  const { data, setData, addToast } = ctx;
  const [draft, setDraft] = useState(null); // { title, kind, sign, note, file }
  const [saving, setSaving] = useState(false);
  const boardCount = data.members.length;
  const putDoc = (d) => setData((x) => ({ ...x, docs: [...x.docs.filter((y) => y.id !== d.id), d].sort((a, b) => a.title.localeCompare(b.title)) }));
  const save = async () => {
    if (!draft.title.trim()) { addToast('Give it a title', 'error'); return; }
    setSaving(true);
    const j = await call({ action: 'save-doc', doc: draft });
    if (!j.ok) { setSaving(false); addToast(j.error, 'error'); return; }
    let doc = j.doc;
    if (draft.file) {
      const form = new FormData();
      form.set('file', draft.file); form.set('ownerType', 'doc'); form.set('ownerId', doc.id); form.set('kind', 'other'); form.set('staffOnly', 'false');
      const up = await call(null, { form, query: '?upload=1' });
      if (up.ok) doc = { ...doc, file: up.file }; else addToast(`Saved, but the file didn’t upload: ${up.error}`, 'error');
    }
    setSaving(false);
    putDoc(doc);
    setDraft(null);
    addToast(`${doc.title} is on the board page`, 'info');
  };
  const remove = async (d) => {
    if (!(await ask({ title: `Delete ${d.title}?`, text: 'Its file and this year’s signatures go with it.', yes: 'Delete', danger: true }))) return;
    const j = await call({ action: 'delete-doc', id: d.id });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    setData((x) => ({ ...x, docs: x.docs.filter((y) => y.id !== d.id) }));
  };
  const toggle = async (d, patch) => {
    const j = await call({ action: 'save-doc', doc: { ...d, ...patch } });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    putDoc(j.doc);
  };
  const names = Object.fromEntries(data.members.map((p) => [p.slug, p.name]));
  return html`
    ${draft ? html`<div class="card">
      <div class="bd-card-head"><h3>${draft.id ? 'Edit the document' : 'Add a document'}</h3></div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label" for="bd-doc-title">Title</label><input id="bd-doc-title" class="form-input" value=${draft.title} placeholder="Bylaws" onInput=${(e) => setDraft({ ...draft, title: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-doc-kind">Kind</label><select id="bd-doc-kind" class="form-select" value=${draft.kind} onChange=${(e) => setDraft({ ...draft, kind: e.target.value })}>${DOC_KINDS.map((k) => html`<option value=${k.id}>${k.label}</option>`)}</select></div>
        <div class="form-group span-2"><label class="form-label" for="bd-doc-note">A line about it <span class="form-optional">optional</span></label><input id="bd-doc-note" class="form-input" value=${draft.note} placeholder="Adopted June 2025" onInput=${(e) => setDraft({ ...draft, note: e.target.value })} /></div>
        <div class="form-group span-2">
          <label class="form-label">${draft.id && !draft.file ? 'Replace the file' : 'The file'} <span class="form-optional">${draft.id ? 'optional' : ''}</span></label>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx,.pptx,.doc,.xls" onChange=${(e) => setDraft({ ...draft, file: e.target.files[0] || null })} />
        </div>
        <div class="form-group span-2"><label class="bd-check"><input type="checkbox" checked=${draft.sign} onChange=${(e) => setDraft({ ...draft, sign: e.target.checked })} /> Ask each board member to read and sign it every year (the conflict of interest policy, the board expectations)</label></div>
      </div>
      <div class="bd-actions" style="margin-top:1rem">
        <button class="btn btn-primary" disabled=${saving} onClick=${save}>${saving ? 'Saving…' : 'Save'}</button>
        <button class="btn btn-ghost" onClick=${() => setDraft(null)}>Cancel</button>
      </div>
    </div>` : html`<div class="bd-actions"><button class="btn btn-primary btn-sm" onClick=${() => setDraft({ title: '', kind: 'governance', note: '', sign: false, file: null })}>Add a document</button></div>`}
    <div class="card" style="padding:0">
      <div class="sec-head"><h3>On the board page <span class="count">${data.docs.length}</span></h3><span class="sec-head__hint">Signatures are for ${todayEastern().slice(0, 4)}</span></div>
      ${data.docs.length ? html`<ul class="bd-row-list">${data.docs.map((d) => {
        const signed = Object.keys(d.signed);
        return html`<li class="bd-row" key=${d.id}>
          <div class="bd-row__main">
            ${d.file ? html`<a class="bd-row__title" ...${viewerLink(viewerFiles([d.file]), 0)}>${d.title}</a>` : html`<span class="bd-row__title">${d.title}</span>`}
            <div class="bd-row__meta">${[DOC_KINDS.find((k) => k.id === d.kind)?.label, d.note, d.file ? `${d.file.name} · ${sizeText(d.file.size)}` : 'No file yet'].filter(Boolean).join(' · ')}</div>
            ${d.sign ? html`<div class="bd-row__meta">${signed.length ? `Signed by ${signed.map((s) => names[s] || d.signed[s].name).join(', ')}` : 'No one has signed it this year'}${boardCount ? ` · ${signed.length} of ${boardCount}` : ''}</div>` : null}
          </div>
          <div class="bd-tags">
            ${d.sign ? html`<span class=${`tag ${signed.length >= boardCount && boardCount ? 'tag--success' : 'tag--warn'}`}>${signed.length} of ${boardCount} signed</span>` : null}
            <${Switch} checked=${d.shared} label="On the board page" onChange=${(v) => toggle(d, { shared: v })} />
            <button class="btn btn-ghost btn-sm" onClick=${() => setDraft({ ...d, file: null })}>Edit</button>
            <button class="btn btn-ghost btn-sm btn-row-danger" onClick=${() => remove(d)}>Delete</button>
          </div>
        </li>`;
      })}</ul>` : html`<div class="empty empty--inline"><p class="empty__title">No documents yet</p><p class="empty__text">Start with the bylaws, the board expectations and the conflict of interest policy.</p></div>`}
    </div>`;
}

// ─── Members ────────────────────────────────────────────────────────
function AccessCard({ ctx }) {
  const { data, setData, addToast } = ctx;
  const a = data.access;
  const [trying, setTrying] = useState(false);
  const retry = async () => {
    setTrying(true);
    const j = await call({ action: 'sync-access' });
    setTrying(false);
    if (j.ok) setData((d) => ({ ...d, access: j.access })); else addToast(j.error, 'error');
  };
  const ready = a.configured && a.ok && a.attached;
  const head = !a.configured ? 'Board members can’t sign in yet'
    : a.error && !a.ok ? 'The sign-in list couldn’t be updated'
    : !a.attached ? 'One step left in Cloudflare'
    : `${plural(a.emails, 'board member')} can sign in`;
  return html`<div class="card">
    <div class="status-head">
      <div class="status-head__main"><span class=${`dot ${ready ? 'dot--on' : 'dot--warn'}`} aria-hidden="true"></span><div>
        <h3>${head}</h3>
        <p class="status-head__text">${ready
          ? html`They go to <a class="link" href=${PAGE} target="_blank" rel="noopener">sunshineonaranneyday.com/board</a> and sign in with their email’s code, the way you do. Cloudflare’s list follows People → Board within 5 minutes${a.syncedAt ? ` (checked ${ago(a.syncedAt)})` : ''}. A board sign-in opens the board page and nothing else.`
          : a.error && !a.ok ? html`Cloudflare said: ${a.error}`
          : 'The site keeps Cloudflare’s list of board emails itself once it has a key to do it.'}</p>
      </div></div>
      ${a.configured && a.error && !a.ok ? html`<div class="status-head__actions"><button class="btn btn-primary btn-sm" disabled=${trying} onClick=${retry}>${trying ? 'Trying…' : 'Try again'}</button></div>` : null}
    </div>
    ${!a.configured ? html`<ol class="bd-steps">
      <li>In Cloudflare, open <strong>My Profile → API Tokens → Create Token → Custom token</strong>. Give it two permissions, both under Account: <span class="bd-code">Access: Organizations, Identity Providers, and Groups</span> Edit, and <span class="bd-code">Access: Apps and Policies</span> Edit.</li>
      <li>Open <strong>Workers & Pages → soard-site → Settings → Variables and Secrets</strong>, add a secret named <span class="bd-code">CF_ACCESS_API_TOKEN</span> with that token, then publish.</li>
      <li>Within 5 minutes the site makes the list “SOARD board (kept by the website)” and the policy “SOARD board members”. This card then names the one setting left.</li>
    </ol>` : a.ok && !a.attached ? html`<ol class="bd-steps">
      <li>In Cloudflare, open <strong>Zero Trust → Access → Applications → ${a.appName || 'the admin’s application'} → Policies</strong>.</li>
      <li>Choose <strong>Select existing policies</strong>, tick <strong>SOARD board members</strong>, and save. This card turns green within 5 minutes. (The site never changes the application itself, so a mistake can’t lock staff out.)</li>
    </ol>` : null}
    ${a.missing?.length ? html`<div class="notice notice--warn" style="margin:1rem 0 0"><div class="notice__body"><strong>No email on file for ${a.missing.map((p) => p.name).join(', ')}.</strong> Add it on People → Board (the private email reveal invites go to), and they can sign in a few minutes later.</div><div class="notice__actions"><a class="btn btn-ghost btn-sm" href="#people/board">People → Board</a></div></div>` : null}
  </div>`;
}

function MembersTab({ ctx }) {
  const { data } = ctx;
  const next = nextMeeting(data.meetings);
  const signDocs = data.docs.filter((d) => d.sign && d.shared);
  return html`
    <${AccessCard} ctx=${ctx} />
    <div class="card" style="padding:0">
      <div class="sec-head"><h3>The board <span class="count">${data.members.length}</span></h3><span class="sec-head__hint">From People → Board</span></div>
      <table class="bd-table">
        <thead><tr><th>Member</th><th>Signs in with</th><th>Last on the board page</th>${next ? html`<th>${meetingName(next)}</th>` : null}${signDocs.length ? html`<th>Signed this year</th>` : null}</tr></thead>
        <tbody>${data.members.map((p) => {
          const rsvp = next?.attendance.find((x) => x.slug === p.slug)?.rsvp;
          const signed = signDocs.filter((d) => d.signed[p.slug]).length;
          return html`<tr key=${p.slug}>
            <td><strong>${p.name}</strong>${p.title && p.title !== 'Board Member' ? html`<div class="bd-row__meta">${p.title}</div>` : null}</td>
            <td data-label="Signs in with">${p.email ? p.email : html`<span class="tag tag--warn">No email on file</span>`}</td>
            <td data-label="Last on the board page">${p.lastSeen ? ago(p.lastSeen) : html`<span class="bd-muted">Not yet</span>`}</td>
            ${next ? html`<td data-label=${meetingName(next)}>${rsvp ? { yes: 'Coming', remote: 'By video', no: 'Can’t make it' }[rsvp] : html`<span class="bd-muted">No answer</span>`}</td>` : null}
            ${signDocs.length ? html`<td data-label="Signed this year"><span class=${`tag ${signed === signDocs.length ? 'tag--success' : ''}`}>${signed} of ${signDocs.length}</span></td>` : null}
          </tr>`;
        })}</tbody>
      </table>
    </div>`;
}

// ─── Settings ───────────────────────────────────────────────────────
function SettingsTab({ ctx }) {
  const { data, setData, addToast } = ctx;
  const [s, setS] = useState(() => ({ admins: data.settings.admins, quorum: data.settings.quorum, defaults: data.settings.defaults, template: data.settings.template }));
  const [newAdmin, setNewAdmin] = useState('');
  const [saving, setSaving] = useState(false);
  const saved = JSON.stringify({ admins: data.settings.admins, quorum: data.settings.quorum, defaults: data.settings.defaults, template: data.settings.template });
  const dirty = JSON.stringify(s) !== saved;
  useEffect(() => { ctx.markDirty(dirty); return () => ctx.markDirty(false); }, [dirty]);
  const setDef = (patch) => setS({ ...s, defaults: { ...s.defaults, ...patch } });
  const save = async () => {
    setSaving(true);
    const j = await call({ action: 'save-settings', settings: s });
    setSaving(false);
    if (!j.ok) { addToast(j.error, 'error'); return; }
    setData((d) => ({ ...d, settings: j.settings }));
    setS({ admins: j.settings.admins, quorum: j.settings.quorum, defaults: j.settings.defaults, template: j.settings.template });
    addToast('Board settings saved', 'info');
  };
  const addAdmin = () => {
    const e = newAdmin.trim().toLowerCase();
    if (!/^[^\s@]+@soardcharity\.com$/.test(e)) { addToast('Only a soardcharity.com sign-in can open the Board area', 'error'); return; }
    if (!s.admins.includes(e)) setS({ ...s, admins: [...s.admins, e] });
    setNewAdmin('');
  };
  const tSet = (si, patch) => setS({ ...s, template: s.template.map((x, i) => (i === si ? { ...x, ...patch } : x)) });
  return html`
    <div class="card">
      <div class="bd-card-head"><h3>Who can open the Board area</h3><p>The agenda, notes, minutes and files here are for these people only. Other staff don’t see Board in the menu, and its pages refuse them.</p></div>
      <ul class="bd-people">${s.admins.map((e) => html`<li class="bd-person" key=${e}><span>${e}${e === data.me ? html` <span class="tag">You</span>` : null}</span>
        ${e === data.me ? null : html`<button class="btn btn-ghost btn-sm btn-row-danger" onClick=${() => setS({ ...s, admins: s.admins.filter((x) => x !== e) })}>Remove</button>`}</li>`)}</ul>
      <div class="bd-inline" style="margin-top:0.75rem">
        <input class="form-input" type="email" aria-label="Add someone" placeholder="name@soardcharity.com" value=${newAdmin} onInput=${(e) => setNewAdmin(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') addAdmin(); }} />
        <button class="btn btn-ghost btn-sm" disabled=${!newAdmin.trim()} onClick=${addAdmin}>Add</button>
      </div>
      ${data.settings.adminsSaved ? null : html`<p class="form-hint">Until this is saved, it’s the founders on People → Team.</p>`}
    </div>
    <div class="card">
      <div class="bd-card-head"><h3>Meetings</h3></div>
      <div class="bd-grid3">
        <div class="form-group"><label class="form-label" for="bd-q">Quorum (board members)</label><input id="bd-q" class="form-input" type="number" min="0" max="50" value=${s.quorum || ''} placeholder="Not set" onInput=${(e) => setS({ ...s, quorum: Number(e.target.value) || 0 })} /><p class="form-hint">From the bylaws. The meeting page says whether there is one.</p></div>
        <div class="form-group"><label class="form-label" for="bd-ds">Usually starts</label><input id="bd-ds" class="form-input" type="time" value=${s.defaults.start} onInput=${(e) => setDef({ start: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-de">Usually ends</label><input id="bd-de" class="form-input" type="time" value=${s.defaults.end} onInput=${(e) => setDef({ end: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-dl">Usual place</label><input id="bd-dl" class="form-input" value=${s.defaults.location} onInput=${(e) => setDef({ location: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-da">Its address</label><input id="bd-da" class="form-input" value=${s.defaults.address} onInput=${(e) => setDef({ address: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-dv">Video link</label><input id="bd-dv" class="form-input" type="url" value=${s.defaults.video} placeholder="https://" onInput=${(e) => setDef({ video: e.target.value })} /></div>
      </div>
    </div>
    <div class="card">
      <div class="bd-card-head"><h3>The agenda a new meeting starts with</h3><p>Sections and their items. Items with live facts fill in from JobTread, Mercury and Events.</p></div>
      ${s.template.map((sec, si) => html`<div class="bd-section" key=${si}>
        <div class="bd-section__head"><span class="bd-section__num">${si + 1}.</span>
          <input class="form-input bd-section__title" aria-label=${`Section ${si + 1}`} value=${sec.title} onInput=${(e) => tSet(si, { title: e.target.value })} />
          <span class="bd-icon-btns"><button class="bd-icon-btn" aria-label="Delete the section" onClick=${() => setS({ ...s, template: s.template.filter((_, i) => i !== si) })}>✕</button></span>
        </div>
        <div class="bd-items">${(sec.items || []).map((it, ii) => html`<div class="bd-item__top" style="padding-top:0.5rem" key=${ii}>
          <input class="form-input" aria-label="Item" value=${it.title} onInput=${(e) => tSet(si, { items: sec.items.map((x, j) => (j === ii ? { ...x, title: e.target.value } : x)) })} />
          <select class="form-select" aria-label="Live facts" value=${it.live || ''} onChange=${(e) => tSet(si, { items: sec.items.map((x, j) => (j === ii ? { ...x, live: e.target.value } : x)) })}>
            <option value="">No live facts</option>${[...LIVE, { id: 'minutes', label: 'The last meeting’s minutes' }].map((l) => html`<option value=${l.id}>${l.label}</option>`)}
          </select>
          <button class="bd-icon-btn" aria-label="Delete the item" onClick=${() => tSet(si, { items: sec.items.filter((_, j) => j !== ii) })}>✕</button>
        </div>`)}
          <button class="btn btn-ghost btn-sm" style="margin-top:0.5rem" onClick=${() => tSet(si, { items: [...(sec.items || []), { title: '' }] })}>Add an item</button>
        </div>
      </div>`)}
      <div class="bd-actions" style="margin-top:0.85rem">
        <button class="btn btn-ghost btn-sm" onClick=${() => setS({ ...s, template: [...s.template, { title: '', items: [] }] })}>Add a section</button>
        <button class="btn btn-ghost btn-sm" onClick=${() => setS({ ...s, template: DEFAULT_TEMPLATE })}>Start over from SOARD’s usual agenda</button>
      </div>
    </div>
    <div class="bd-savebar">
      <span class="bd-savebar__state">${saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>
      <button class="btn btn-primary" disabled=${saving || !dirty} onClick=${save}>Save</button>
    </div>`;
}
