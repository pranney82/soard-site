/**
 * Admin → a Zeffy link field (ZeffyLink)
 * ===========================================================================
 * Wherever admin asks for a Zeffy link: a dropdown of the forms in SOARD's Zeffy, and Open beside it. Picking a form
 * saves its link, taken from Zeffy: nothing is typed or pasted. An optional field has "No form" to take its link off.
 * Only an event can sell its tickets on another site instead, and only then is there a box for that site's link.
 *
 * What a field says is fieldState()'s, and every page's Save is blocked by the same fieldState(): a link just set that
 * won't do (or a required one missing) blocks, in red; a link saved earlier that won't do, or a form Zeffy has closed
 * or deleted, is a warning, in amber, that never blocks the rest of a page's save.
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

import { h, htm, useState, useEffect, useRef } from './vendor.js';
import { zeffyKey, sameForm, zeffyLinkProblem, finishLink } from './zeffy-links.js';

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
 * only: the kinds a field takes (the Donate page's forms: donations), the others left out
 */
export function formGroups(forms, { value = '', prefer = [], id, only = null } = {}) {
  const list = Array.isArray(forms) ? forms : [];
  const chosen = list.find((f) => sameForm(f.url, value) && (id === undefined || f.id === id)) || null;
  const shown = list.filter((f) => KINDS[f.kind] && (!only || only.includes(f.kind) || f === chosen) && (f.open || f === chosen)).sort((a, b) => (b.created || 0) - (a.created || 0));
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

/**
 * The list itself, for a page that checks its fields before saving (fieldState wants it): null until it comes.
 * load: false listens without reading it, for a page that only needs it once a field there has asked for it
 */
export function useZeffyFormList(from = STAFF, { load = true } = {}) {
  return useZeffyForms(from, { load }).forms;
}

function useZeffyForms(from, { load = true } = {}) {
  const s = storeFor(from);
  const [, tick] = useState(0);
  const seen = s.at;
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    s.subs.add(fn);
    // The list came between drawing and listening (refresh won't tell anyone again while it's fresh): draw it now
    if (s.at !== seen) fn();
    if (load) refresh(s);
    return () => { s.subs.delete(fn); };
  }, [s]);
  useEffect(() => {
    if (!load || !s.failed || LASTING.test(s.failed)) return undefined;
    const t = setTimeout(() => refresh(s, { force: true }), Math.min(RETRY_MS * 2 ** Math.max(0, s.tries - 1), RETRY_MAX_MS));
    return () => clearTimeout(t);
  }, [s, s.failed, s.at]);
  return s;
}

const PICK = 'Pick a Zeffy form';
/**
 * What a Zeffy field says about its link: { problem, warning }. The field shows exactly this, and a page blocks Save
 * on `problem` and nothing else, so the two never disagree.
 *   required   an empty one is a problem (the Donate page's and the live reveal's forms)
 *   only       the kinds of form it takes (a listed form of another kind won't do)
 *   elsewhere  an event, which may sell on another site: a link that isn't Zeffy's is that site's, any whole link
 *   forms      Zeffy's list, when it has come (the kind, closed and deleted checks wait for it)
 *   saved      the link as last saved. One that won't do blocks only when it isn't that one (or the field is
 *              required): a link saved earlier is a warning, so an old link never stops the rest of a page from
 *              saving. Left out, the link counts as just set. Spaces at either end don't make it another link
 * A form Zeffy has closed or no longer lists is always a warning: Zeffy changed, not the person saving
 */
export function fieldState(value, { required = false, only = null, elsewhere = false, forms = null, saved } = {}) {
  const v = String(value ?? '').trim();
  const changed = saved === undefined || v !== String(saved ?? '').trim();
  if (!v) return { problem: required ? PICK : null, warning: null };
  let wrong = null;
  let warning = null;
  // Another site's link, being set now, is judged with the https:// the field puts on it (when the box is left, as
  // Save starts, or as soon as Discard or History puts it there). One saved earlier is judged as it's saved
  if (!zeffyKey(v)) wrong = elsewhere ? zeffyLinkProblem(changed ? finishLink(v) : v) : 'What’s saved isn’t a Zeffy form: pick one';
  else if (zeffyLinkProblem(v)) wrong = 'What’s saved isn’t a whole link: pick the form again';
  else if (forms) {
    const listed = forms.find((f) => sameForm(f.url, v));
    if (!listed) warning = 'That form isn’t in SOARD’s Zeffy any more: pick another';
    else if (only && !only.includes(listed.kind)) wrong = `Pick a form from “${KINDS[only[0]]}”: this one is in “${KINDS[listed.kind] || listed.kind}”`;
    else if (!listed.open) warning = `That form has ${listed.ended ? 'ended' : 'closed'} in Zeffy: pick an open one`;
  }
  return changed || required ? { problem: wrong, warning } : { problem: null, warning: wrong || warning };
}

/** What the Advisory Board's campaign field says under itself, on Site Config → Zeffy and on the advisors' page */
export function campaignNote({ url, id } = {}, saved = {}, forms = null) {
  const u = String(url || '').trim();
  if (!u) return 'Not connected: nothing counts toward the goal until a campaign is picked.';
  const same = u === String(saved.url || '').trim() || sameForm(u, saved.url);
  if (same && id && id === saved.id) return 'Connected: what it raises counts toward the goal.';
  if (same && !id) {
    return forms?.some((f) => sameForm(f.url, u)) ? 'Not connected yet: pick it again to connect it now.'
      : 'Saved, but Zeffy hasn’t said which campaign this is yet. The site asks again every 15 minutes.';
  }
  const form = id && (forms || []).find((f) => f.id === id);
  return form ? `“${form.title}”: connected when you save.` : 'Save asks Zeffy which campaign this is.';
}

// The dropdown (or, for an event selling elsewhere, the link box) takes the width; Open sits beside it and keeps its
// room while it's hidden, so nothing moves when a form is picked. Lines under it: what's wrong (red), a warning
// (amber), or that Zeffy can't be reached; then, for an event, the switch between a Zeffy form and another site
const CSS = `
.zf-field { min-width: 0; }
.zf-link { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .5rem; align-items: stretch; min-width: 0; }
.zf-link > .zf-pick { display: block; min-width: 0; }
.zf-link .zf-select, .zf-link > input { width: 100%; min-width: 0; margin: 0; }
.zf-link .zf-link__open { display: inline-flex; align-items: center; gap: .3rem; white-space: nowrap; height: auto; min-height: 0; margin: 0; }
.zf-link .zf-link__open[aria-hidden="true"] { visibility: hidden; }
.zf-link__open svg { width: 12px; height: 12px; }
.zf-link__bad, .zf-link__warn, .zf-link__note { margin: .35rem 0 0; font-size: .85em; line-height: 1.35; }
.zf-link__bad { color: var(--color-danger, #b42318); }
.zf-link__warn { color: var(--tone-warn-fg, #8a5a00); }
.zf-link__note { color: var(--color-text-muted, inherit); }
.zf-link__switch { display: inline-flex; align-items: center; margin: .2rem 0 0; padding: .25rem 0; border: 0; background: none; font: inherit; font-size: .85em; color: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
@media (pointer: coarse) { .zf-link__switch { min-height: 44px; } }`;
function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById('zf-style')) return;
  const el = document.createElement('style');
  el.id = 'zf-style';
  el.textContent = CSS;
  document.head.append(el);
}

const shortLink = (url) => String(url || '').trim().replace(/^https?:\/\/(www\.)?/i, '');
const NONE = '__none';
// Why there's nothing to pick, in words for the person, not the system (the dropdown's tooltip keeps the detail)
const unreachable = (failed) => (/sign-in/i.test(failed) ? 'Your sign-in ended: reload the page to pick a form.'
  : LASTING.test(failed) ? 'Zeffy isn’t connected to the site, so its forms can’t be listed.'
    : 'Zeffy isn’t answering, so forms can’t be picked right now. It tries again on its own.');

/** The dropdown, inside ZeffyLink: the forms store, the saved link and ID, the kinds the field takes, "No form" */
function ZeffyFormSelect({ s, value = '', id, onPick, prefer = [], only = null, required = false, label, selectId, describedBy, cls, disabled = false }) {
  const v = String(value || '').trim();
  // A saved link that isn't a whole link isn't shown as its form, so picking that form again saves it whole
  const { chosen, groups } = formGroups(s.forms, { value: zeffyLinkProblem(v) ? '' : v, prefer, id, only });
  const kinds = only ? `${KINDS[only[0]].toLowerCase()}` : 'forms';
  const lead = v && !chosen ? `Saved: ${shortLink(v)}`
    : !s.forms ? (s.failed ? (/sign-in/i.test(s.failed) ? 'Sign-in ended: reload the page' : LASTING.test(s.failed) ? 'Zeffy isn’t connected yet' : 'Zeffy isn’t answering. Retrying…') : 'Loading Zeffy forms…')
      : !groups.length ? `No open ${kinds} in Zeffy` : 'Choose a Zeffy form';
  // A Zeffy link the list doesn't have may be a form made since the list was read: look again
  const unknown = !!s.forms && !!zeffyKey(v) && !s.forms.some((f) => sameForm(f.url, v));
  useEffect(() => {
    if (unknown && Date.now() - s.at > UNKNOWN_LINK_MS) refresh(s, { force: true });
  }, [s, unknown, v]);
  const pick = (e) => {
    const picked = e.currentTarget.value;
    if (picked === NONE) return onPick(null);
    const f = (s.forms || []).find((x) => x.id === picked);
    if (f) onPick(f);
  };
  // Optional: "No form" is a choice, and the one shown while there's no link. Required: a prompt to pick
  const selected = chosen ? chosen.id : !v && !required ? NONE : '';
  // The lead line is marked selected itself: with every other line unpickable, setting the select's value alone can
  // leave it showing nothing
  return html`<span class="zf-pick"><select id=${selectId} class=${`zf-select ${cls}`} aria-label=${label} aria-describedby=${describedBy}
    title=${s.failed && !s.forms ? s.failed : undefined} value=${selected} disabled=${disabled || (required && !groups.length)} onChange=${pick}>
    ${selected === NONE ? null : html`<option value="" disabled selected>${lead}</option>`}
    ${required ? null : html`<option value=${NONE}>No form</option>`}
    ${groups.map((g) => html`<optgroup key=${g.kind} label=${g.label}>
      ${g.forms.map((f) => html`<option key=${f.id} value=${f.id}>${f.label}</option>`)}
    </optgroup>`)}
  </select></span>`;
}

const EXT = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>`;
let uid = 0;

/**
 * A Zeffy link field. Pick one of SOARD's Zeffy forms: its link comes from Zeffy behind the scenes, and Open shows the
 * form. An optional field has "No form" to take the link off. An event can sell its tickets on another site instead
 * (`elsewhere`, the words of that choice): then, and only then, a box for that site's link. A link set there gets
 * its https:// when the box is left, as Save starts while it's still being typed in (the 'soard-before-save' event),
 * or at once when Discard or History puts it there, so what's saved is what was checked; a saved link nobody touched
 * is left exactly as it is. The page puts its label over the field and its hint under it, and blocks Save on
 * fieldState(value, the same rule and saved).problem.
 *   value      the saved link;  saved  the link as last saved (without it, every link counts as just set)
 *   onPick     the form picked ({ id, title, url, kind }), or null for "No form"
 *   onChange   the other site's link (with `elsewhere`); '' when switching back from one that isn't Zeffy's
 *   required, only, elsewhere   what the link may be (see fieldState); only also narrows the dropdown
 *   inputId    the control's id, for the page's <label for>: the dropdown, or the box while it shows
 *   label      the field's name, for screen readers (the label above may carry a date or a tag)
 *   describedBy  the id of the page's hint under the field
 *   prefer, id, from, disabled   for the dropdown (see formGroups)
 *   cls, inputCls, openCls       the page's own classes (form-select / form-input / btn in the admin; ar-input and ar-btn on the advisors' page)
 */
export function ZeffyLink({ value = '', saved, onChange = () => {}, onPick, prefer = [], only = null, required = false, elsewhere = null, label = 'Zeffy link', inputId, id,
  from = STAFF, describedBy, disabled = false, placeholder = 'https://', cls = 'form-select', inputCls = 'form-input', openCls = 'btn btn-ghost btn-sm' }) {
  injectStyles();
  const s = useZeffyForms(from);
  const v = value ?? '';
  const now = v.trim();
  // A link that isn't a Zeffy form is another site's: the box shows it. Otherwise the dropdown, unless someone chose
  // another site: then the box stays, even for a Zeffy link typed in it, until a link is put here from outside
  // (Discard, History). It's a text box with a link keyboard, not type=url, which drops a typed space without a word
  // (it's kept here, and the field says so)
  const [chose, setChose] = useState(false);
  const [focused, setFocused] = useState(false);
  const other = !!elsewhere && (chose || (!!now && !zeffyKey(now)));
  const [own] = useState(() => `zf-${++uid}`);
  // What's wrong shows as it's typed, as every other link field in admin does
  const { problem, warning } = fieldState(v, { required, only, elsewhere: !!elsewhere, forms: s.forms, saved });
  const changed = saved === undefined || now !== String(saved ?? '').trim();

  // Why there's nothing to pick, unless the dropdown's own top line already says it (a required field with no link)
  const note = !other && !s.forms && s.failed && (now || !required) ? unreachable(s.failed) : null;
  // The box's link, whole: when it's left, and as Save starts while it's still being typed in (⌘S). Only a link
  // typed in or changed: a saved link nobody touched is left as it is, even when the box is tabbed through. The
  // listener reads the value and the page's onChange as they are now, not as they were when it was added
  const latest = useRef({ v, onChange, changed });
  latest.current = { v, onChange, changed };
  const mine = useRef(v);
  const typed = useRef(false);
  const change = (x) => { mine.current = x; latest.current.onChange(x); };
  const finish = () => {
    const { v: was, changed: moved } = latest.current;
    if (!moved && !typed.current) return;
    const done = finishLink(was);
    if (done !== was) change(done);
  };
  useEffect(() => {
    if (!other || !focused) return undefined;
    window.addEventListener('soard-before-save', finish);
    return () => window.removeEventListener('soard-before-save', finish);
  }, [other, focused]);
  // A link put here from outside (Discard, History): box or dropdown by what it is, and one that isn't the saved link
  // gets its https:// as a typed one does
  useEffect(() => {
    if (v === mine.current) return;
    mine.current = v;
    if (focused) return;
    setChose(false);
    if (elsewhere && changed && now && !zeffyKey(now)) finish();
  }, [v]);
  const href = now && !zeffyLinkProblem(now) ? now : '';
  const described = [problem && `${own}-bad`, warning && `${own}-warn`, note && `${own}-note`, describedBy].filter(Boolean).join(' ') || undefined;
  // To another site: the box starts from what's there. Back to Zeffy: a link that isn't a Zeffy form goes
  const switchTo = (toOther) => { setChose(toOther); if (!toOther && now && !zeffyKey(now)) change(''); };
  return html`<div class="zf-field">
    <div class="zf-link">
      ${other
        ? html`<input id=${inputId} class=${`${inputCls}${problem ? ' is-invalid' : ''}`} type="text" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" value=${v} placeholder=${placeholder} disabled=${disabled}
            aria-label=${label} aria-describedby=${described} aria-invalid=${problem ? 'true' : 'false'}
            onFocus=${() => { setChose(true); setFocused(true); typed.current = false; }} onBlur=${() => { setFocused(false); finish(); }} onInput=${(e) => { typed.current = true; change(e.currentTarget.value); }} />`
        : html`<${ZeffyFormSelect} s=${s} value=${v} id=${id} onPick=${onPick} prefer=${prefer} only=${only} required=${required} label=${label} selectId=${inputId} describedBy=${described} cls=${cls} disabled=${disabled} />`}
      ${href ? html`<a class=${`zf-link__open ${openCls}`} href=${href} target="_blank" rel="noopener" aria-label=${`Open ${label} in a new tab`}>Open ${EXT}</a>`
        : html`<span class=${`zf-link__open ${openCls}`} aria-hidden="true">Open ${EXT}</span>`}
    </div>
    ${problem ? html`<p class="zf-link__bad" id=${`${own}-bad`}>${problem}</p>` : null}
    ${warning ? html`<p class="zf-link__warn" id=${`${own}-warn`}>${warning}</p>` : null}
    ${note ? html`<p class="zf-link__note" id=${`${own}-note`}>${note}</p>` : null}
    ${elsewhere ? html`<button type="button" class="zf-link__switch" disabled=${disabled} onClick=${() => switchTo(!other)}>${other ? 'Use a Zeffy form instead' : elsewhere}</button>` : null}
  </div>`;
}
