/**
 * Admin → the Zeffy form dropdown
 * ===========================================================================
 * Wherever admin asks for a Zeffy link, this dropdown sits above the link box and lists the forms in SOARD's Zeffy:
 * pick one and its link fills in. The box stays, so the link is always in view and a link that isn't a Zeffy form
 * (an event's sign-up sheet, say) can still be pasted. The dropdown shows the form the link already goes to.
 *
 * Used by a kid's Fundraising link, an event's Tickets link and the gala's Ticket URL (index.html), the golf
 * tournament's Registration link (./event-recap-admin.js), and the Advisory Board's campaign and a hosted fundraiser's
 * page (./advisory-admin.js, which reads the list through /api/advisory-admin: Mary can't reach the staff routes).
 *
 * The list is Zeffy's (functions/api/_zeffy-forms.js), read once for every dropdown on the page and again when the tab
 * comes back after a minute away, so a form just made in Zeffy in another tab shows up.
 */

import { h, htm, useState, useEffect } from './vendor.js';
import { zeffyKey, sameForm } from './zeffy-links.js';

const html = htm.bind(h);
const STALE_MS = 60 * 1000;
const RETRY_MS = 15 * 1000;

/** The dropdown's groups, in this order unless a field prefers others first */
export const KINDS = {
  donation: 'Donation forms',
  tickets: 'Events and tickets',
  peer: 'Peer-to-peer',
  auction: 'Auctions',
  raffle: 'Raffles',
  membership: 'Memberships',
  shop: 'Shops',
};

// Which form a link opens: the one rule the server uses too
export { zeffyKey, sameForm };

const madeOn = (unix, time = false) => (unix ? new Date(unix * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(time ? { hour: 'numeric', minute: '2-digit' } : {}), timeZone: 'America/New_York' }) : '');
const countOf = (keys) => keys.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());

/**
 * What the dropdown lists for a link: the open forms, newest first, grouped by kind with the field's own kinds first,
 * plus the form the link already goes to even when it has closed. Two forms with one title get the day each was made,
 * the time too when that's the same, and a number when even that is.
 * id: a field that keeps the form's ID as well (the Advisory Board's campaign) passes it, so a link saved without its
 * ID shows nothing chosen and picking the form fills the ID in
 */
export function formGroups(forms, { value = '', prefer = [], id } = {}) {
  const list = Array.isArray(forms) ? forms : [];
  const chosen = list.find((f) => sameForm(f.url, value) && (id === undefined || f.id === id)) || null;
  const shown = list.filter((f) => KINDS[f.kind] && (f.open || f === chosen)).sort((a, b) => (b.created || 0) - (a.created || 0));
  const labels = new Map(shown.map((f) => [f, f.title]));
  const clashing = () => { const n = countOf([...labels.values()].map((l) => l.toLowerCase())); return shown.filter((f) => n.get(labels.get(f).toLowerCase()) > 1); };
  for (const time of [false, true]) for (const f of clashing()) if (f.created) labels.set(f, `${f.title} · ${madeOn(f.created, time)}`);
  // Still alike: numbered among themselves, oldest first
  const alike = new Map();
  for (const f of clashing()) { const k = labels.get(f).toLowerCase(); alike.set(k, [...(alike.get(k) || []), f]); }
  for (const same of alike.values()) [...same].reverse().forEach((f, i) => labels.set(f, `${labels.get(f)} (${i + 1})`));
  const labelOf = (f) => `${labels.get(f)}${f.open ? '' : f.ended ? ' (ended)' : ' (closed)'}`;
  const order = [...prefer, ...Object.keys(KINDS)].filter((k, i, a) => KINDS[k] && a.indexOf(k) === i);
  const groups = order
    .map((kind) => ({ kind, label: KINDS[kind], forms: shown.filter((f) => f.kind === kind).map((f) => ({ ...f, label: labelOf(f) })) }))
    .filter((g) => g.forms.length);
  return { chosen, groups };
}

// ─── The list, read once for every dropdown on the page ──────────────

/** The staff admin's own route; the advisors' page passes its own (see ./advisory-admin.js) */
async function staffLoad() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch('/api/zeffy-forms', { cache: 'no-store', signal: ctl.signal });
    const j = await r.json().catch(() => null);
    return j && typeof j === 'object' ? j : { success: false };
  } catch {
    return { success: false };
  } finally {
    clearTimeout(timer);
  }
}
export const STAFF = { key: 'staff', load: staffLoad };

const stores = {};
function storeFor(from) {
  let s = stores[from.key];
  if (s) return s;
  s = stores[from.key] = { at: 0, busy: false, forms: null, failed: '', subs: new Set(), load: from.load };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden && s.subs.size) refresh(s); });
  }
  return s;
}

async function refresh(s, { force = false } = {}) {
  if (s.busy || (!force && Date.now() - s.at < STALE_MS)) return;
  s.busy = true;
  const j = await s.load().catch(() => null);
  s.busy = false;
  s.at = Date.now();
  if (j && (j.success || j.ok) && Array.isArray(j.forms)) { s.forms = j.forms; s.failed = ''; }
  // A failed look again keeps the list it had; with no list yet, the dropdown says so and tries again
  else if (!s.forms) s.failed = j?.error || 'Zeffy’s forms didn’t load.';
  s.subs.forEach((fn) => fn());
}

/** The list itself, for a field that needs it beyond the dropdown (the Advisory Board's campaign ID); null until it comes */
export function useZeffyFormList(from = STAFF) {
  return useZeffyForms(from).forms;
}

function useZeffyForms(from) {
  const s = storeFor(from);
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    s.subs.add(fn);
    refresh(s);
    return () => { s.subs.delete(fn); };
  }, [s]);
  useEffect(() => {
    if (!s.failed) return undefined;
    const t = setTimeout(() => refresh(s, { force: true }), RETRY_MS);
    return () => clearTimeout(t);
  }, [s, s.failed, s.at]);
  return s;
}

// The space sits on a wrapper: a page's own rule for its inputs (the advisors' page zeroes their margins) can't undo it
const CSS = '.zf-pick { display: block; margin-bottom: 0.5rem; }';
function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById('zf-style')) return;
  const el = document.createElement('style');
  el.id = 'zf-style';
  el.textContent = CSS;
  document.head.append(el);
}

/**
 * The dropdown. Goes just above the field's link box.
 *   value    the link as it stands, so the dropdown shows its form
 *   id       for a field that keeps the form's ID too: the ID as it stands (see formGroups)
 *   onPick   called with the form picked ({ id, title, url, kind }); the field sets its link to form.url
 *   prefer   kinds listed first, e.g. ['tickets'] for an event
 *   label    the field's name, for screen readers
 *   cls      the page's own select class (form-select in the admin, ar-input on the advisors' page)
 *   from     where the list comes from (STAFF unless the page can't reach the staff routes)
 */
export function ZeffyFormSelect({ value = '', id, onPick, prefer = [], label = 'Zeffy link', cls = 'form-select', from = STAFF, disabled = false }) {
  injectStyles();
  const s = useZeffyForms(from);
  const { chosen, groups } = formGroups(s.forms, { value, prefer, id });
  const none = !!s.forms && !groups.length;
  const lead = !s.forms ? (s.failed ? 'Couldn’t read Zeffy’s forms. Trying again…' : 'Loading Zeffy forms…')
    : none ? 'Zeffy has no open forms' : 'Choose a Zeffy form';
  const pick = (e) => {
    const f = (s.forms || []).find((x) => x.id === e.currentTarget.value);
    if (f) onPick(f);
  };
  return html`<span class="zf-pick"><select class=${`zf-select ${cls}`} aria-label=${`${label}: pick a Zeffy form`} title=${s.failed && !s.forms ? s.failed : undefined}
    value=${chosen?.id || ''} disabled=${disabled || !s.forms || none} onChange=${pick}>
    <option value="" disabled selected=${!chosen}>${lead}</option>
    ${groups.map((g) => html`<optgroup key=${g.kind} label=${g.label}>
      ${g.forms.map((f) => html`<option key=${f.id} value=${f.id}>${f.label}</option>`)}
    </optgroup>`)}
  </select></span>`;
}
