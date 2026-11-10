/**
 * Admin → a Zeffy link field (ZeffyLink)
 * ===========================================================================
 * Wherever admin asks for a Zeffy link: a dropdown of the forms in SOARD's Zeffy beside the link box. Pick one and its
 * link fills in. The box stays, so the link is always in view and a link that isn't a Zeffy form (an event's sign-up
 * sheet, say) can still be pasted. The dropdown shows the form the link already goes to.
 *
 * Site Config → Zeffy (./site-config.js) has the site's donation forms, each event's tickets and the Advisory Board's
 * campaign together. The same field is on a kid's Giving (a kid's link lives only there), an event's and the gala's
 * tickets (index.html), the golf tournament's registration (./event-recap-admin.js), and the Advisory Board's
 * campaign and a hosted fundraiser's page (./advisory-admin.js, which reads the list through /api/advisory-admin:
 * Mary runs the group from the advisors' page and can't reach the staff routes).
 *
 * The list is Zeffy's (functions/api/_zeffy-forms.js), read once for every dropdown on the page and again when the tab
 * comes back after a minute away, so a form just made in Zeffy in another tab shows up.
 */

import { h, htm, useState, useEffect } from './vendor.js';
import { zeffyKey, sameForm } from './zeffy-links.js';

const html = htm.bind(h);
const STALE_MS = 60 * 1000;
const RETRY_MS = 15 * 1000; // then 30 s, 1 min… up to 5 min while Zeffy keeps failing
const RETRY_MAX_MS = 5 * 60 * 1000;
const UNKNOWN_LINK_MS = 10 * 1000; // a Zeffy link the list doesn't have: look again, at most this often
// Failures that waiting won't fix: no automatic retries, only when the tab or window comes back
const LASTING = /ZEFFY_API_KEY|isn.t connected|sign-in/i;

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

const SIGNED_OUT = { success: false, error: 'Your sign-in ended. Reload the page to sign in again.' };

/**
 * The staff admin's own route; the advisors' page passes its own (see ./advisory-admin.js). A sign-in that has run out
 * comes back as Cloudflare Access's redirect, its sign-in page, or the site's "missing access token": that says so,
 * and isn't tried again until the tab comes back
 */
async function staffLoad() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch('/api/zeffy-forms', { cache: 'no-store', redirect: 'manual', signal: ctl.signal });
    if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) return { ...SIGNED_OUT };
    const j = /json/i.test(r.headers.get('content-type') || '') ? await r.json().catch(() => null) : null;
    if (!j || typeof j !== 'object') return r.ok || r.status === 401 || r.status === 403 ? { ...SIGNED_OUT } : { success: false };
    if (r.status === 403 && /sign-in|access token/i.test(j.error || '')) return { ...SIGNED_OUT };
    return j;
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
  s = stores[from.key] = { at: 0, busy: false, forms: null, failed: '', tries: 0, subs: new Set(), load: from.load };
  // Back to the tab, or to the window beside another one: a form made in Zeffy meanwhile shows up
  const back = () => { if (!document.hidden && s.subs.size) refresh(s); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', back);
  if (typeof window !== 'undefined') window.addEventListener('focus', back);
  return s;
}

async function refresh(s, { force = false } = {}) {
  if (s.busy || (!force && Date.now() - s.at < STALE_MS)) return;
  s.busy = true;
  const j = await s.load().catch(() => null);
  s.busy = false;
  s.at = Date.now();
  if (j && (j.success || j.ok) && Array.isArray(j.forms)) { s.forms = j.forms; s.failed = ''; s.tries = 0; }
  // A failed look again keeps the list it had; with no list yet, the dropdown says so and tries again
  else if (!s.forms) { s.failed = j?.error || 'Zeffy’s forms didn’t load.'; s.tries += 1; }
  s.subs.forEach((fn) => fn());
}

/** The list itself, for a field that needs it beyond the dropdown (the Advisory Board's campaign ID); null until it comes */
export function useZeffyFormList(from = STAFF) {
  return useZeffyForms(from).forms;
}

function useZeffyForms(from) {
  const s = storeFor(from);
  const [, tick] = useState(0);
  const seen = s.at;
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    s.subs.add(fn);
    // The list came between drawing and listening (refresh won't tell anyone again while it's fresh): draw it now
    if (s.at !== seen) fn();
    refresh(s);
    return () => { s.subs.delete(fn); };
  }, [s]);
  useEffect(() => {
    if (!s.failed || LASTING.test(s.failed)) return undefined;
    const t = setTimeout(() => refresh(s, { force: true }), Math.min(RETRY_MS * 2 ** Math.max(0, s.tries - 1), RETRY_MAX_MS));
    return () => clearTimeout(t);
  }, [s, s.failed, s.at]);
  return s;
}

// The dropdown beside the link box where there's room for both, under each other where there isn't (the box's own
// width decides, not the screen's). The spacing is the grid's: a page's own rule for its inputs (the advisors' page
// zeroes their margins) can't undo it
const CSS = `
.zf-link { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: .5rem; align-items: center; min-width: 0; }
.zf-link > .zf-pick { display: block; min-width: 0; }
.zf-link .zf-select { width: 100%; margin: 0; }
.zf-link__box { display: flex; gap: .5rem; align-items: center; min-width: 0; }
.zf-link__box > input { flex: 1 1 auto; min-width: 0; width: auto; margin: 0; }
.zf-link__open { flex-shrink: 0; display: inline-flex; align-items: center; gap: .3rem; white-space: nowrap; }
.zf-link__open svg { width: 12px; height: 12px; }`;
function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById('zf-style')) return;
  const el = document.createElement('style');
  el.id = 'zf-style';
  el.textContent = CSS;
  document.head.append(el);
}

/**
 * The dropdown on its own (ZeffyLink puts it beside the link box, as every field uses it).
 *   value    the link as it stands, so the dropdown shows its form
 *   id       for a field that keeps the form's ID too: the ID as it stands (see formGroups)
 *   onPick   called with the form picked ({ id, title, url, kind }); the field sets its link to form.url
 *   prefer   kinds listed first, e.g. ['tickets'] for an event
 *   label    the field's name, for screen readers
 *   cls      the page's own select class (form-select in the admin, ar-input on the advisors' page)
 *   from     where the list comes from (STAFF unless the page can't reach the staff routes)
 */
function ZeffyFormSelect({ value = '', id, onPick, prefer = [], label = 'Zeffy link', cls = 'form-select', from = STAFF, disabled = false }) {
  injectStyles();
  const s = useZeffyForms(from);
  const { chosen, groups } = formGroups(s.forms, { value, prefer, id });
  const none = !!s.forms && !groups.length;
  // Short enough for a phone's dropdown; the whole reason is in its tooltip
  const failedAs = /sign-in/i.test(s.failed) ? 'Sign-in ended: reload the page' : LASTING.test(s.failed) ? 'Zeffy isn’t connected yet' : 'Zeffy isn’t answering. Retrying…';
  const lead = !s.forms ? (s.failed ? failedAs : 'Loading Zeffy forms…') : none ? 'Zeffy has no open forms' : 'Choose a Zeffy form';
  // A Zeffy link the list doesn't have may be a form made since the list was read: look again
  const unknown = !!s.forms && !!zeffyKey(value) && !s.forms.some((f) => sameForm(f.url, value));
  useEffect(() => {
    if (unknown && Date.now() - s.at > UNKNOWN_LINK_MS) refresh(s, { force: true });
  }, [s, unknown, value]);
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

const EXT = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>`;

/**
 * A Zeffy link field: the dropdown of SOARD's forms, the link box (for a form made since the list was read, or a link
 * that isn't a Zeffy form: an event's sign-up sheet), and Open. Every field that takes a Zeffy link is this; the page
 * puts its own label over it and its own hint or problem under it.
 *   value      the link as it stands
 *   onChange   the text as typed (the page decides what an empty box means for its record)
 *   onPick     the form picked ({ id, title, url, kind }); the page sets its link to form.url
 *   inputId    the link box's id, for the page's <label for>; without one the box is named by `label`
 *   label      the field's name, for screen readers
 *   invalid    marks the box (the page says why under it); describedBy: the id of that line
 *   prefer, id, from, disabled   as the dropdown's
 *   cls, inputCls, openCls       the page's own classes (form-select / form-input / btn in the admin; ar-input and ar-btn on the advisors' page)
 */
export function ZeffyLink({ value = '', onChange, onPick, prefer = [], label = 'Zeffy link', inputId, id, from = STAFF, invalid = false, describedBy, disabled = false,
  placeholder = 'https://www.zeffy.com/…', cls = 'form-select', inputCls = 'form-input', openCls = 'btn btn-ghost btn-sm' }) {
  injectStyles();
  const v = value ?? '';
  const href = /^https:\/\/[^\s/]+\.\S+$/i.test(v.trim()) ? v.trim() : '';
  return html`<div class="zf-link">
    <${ZeffyFormSelect} value=${v} id=${id} onPick=${onPick} prefer=${prefer} label=${label} cls=${cls} from=${from} disabled=${disabled} />
    <span class="zf-link__box">
      <input id=${inputId} class=${`${inputCls}${invalid ? ' is-invalid' : ''}`} type="url" inputmode="url" value=${v} placeholder=${placeholder} disabled=${disabled}
        aria-label=${inputId ? undefined : label} aria-describedby=${describedBy} aria-invalid=${invalid ? 'true' : 'false'} onInput=${(e) => onChange(e.currentTarget.value)} />
      ${href ? html`<a class=${`zf-link__open ${openCls}`} href=${href} target="_blank" rel="noopener" aria-label=${`Open ${label} in a new tab`}>Open ${EXT}</a>` : null}
    </span>
  </div>`;
}
