/**
 * Admin → Donors & Partners: everyone who gives, the partners on the website, and checks into Zeffy
 * ===========================================================================
 * Peter, Nov 11 2026: "i want a donor crm, similar to how kids is built today", Checks "is not related to job costs
 * and probably needs its own place on the sidebar called donors", and Partners in with it. Over /api/donors-admin
 * (functions/api/_donors.js, _donor-crm.js): Zeffy stays where gifts are taken, receipted and changed, and every gift
 * and donor here opens there in one click. What only the site knows (which organization a Zeffy name is, two records
 * that are one person, Keep anonymous) is said here, privately: nothing on this page reaches the website by itself.
 *
 * One area, four tabs (./donor-tabs.js): Donors and Checks here, Partners and Community partners in index.html.
 * Addresses: #donors, #donors/needs, #donors/thanks, #donors/checks, #donors/<Zeffy contact id> (a person),
 * #donors/org/<p:slug|o:id> (an organization), #donors/gift/<payment id> (whoever a gift counts for, the gift marked:
 * the MAJOR GIFT Slack post links this). The old #job-costs/checks opens Checks here.
 *
 * Donors     people and organizations: New (first gift within 12 months), Active (a gift within 18 months), Lapsed
 *            (none in 18 months); Organizations; Not yet this year (gave last year, nothing yet this year: the
 *            year-end list); To thank (gifts Zeffy sends no thank-you for, and every gift of $1,000 or more:
 *            functions/api/_donor-thanks.js); Needs you (a near name, a gift two organizations could have, two records
 *            that may be one person, a partner whose giving says Champion, a big giver with no organization, a name
 *            that reads as an organization's). The list and To thank filter by who on the team looks after them
 *            (Owner); Needs you is about records, not whose they are, so it's everyone's.
 *            A donor's page, built like a kid's: what to thank them for, giving, the team's notes and gifts; beside
 *            them stage, owner, Zeffy, Keep anonymous, organizations and History.
 * Checks     every check deposited in Mercury and its Zeffy record (./checks.js)
 */
import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';
import { Checks } from './checks.js';
import { useStyles as useJobCostsStyles } from './job-costs.js';
import { zeffyPaymentUrl, zeffyContactUrl } from './zeffy-links.js';
import { AreaTabs, setChecksWaiting } from './donor-tabs.js';
import { ask as askAnywhere } from './ask.js';
// A question about this page closes when the page is left (Back, a link): it never acts on a page no longer shown
const ask = (o) => askAnywhere({ ...o, closeOnMove: true });
import { useDialog } from './dialog.js';
import { Timeline } from './donor-timeline.js';
import { SignalsCard } from './donor-signals.js';
import { call, get, change, lostAnswer, thanksChanged, whenUnsure, draftKey, keepDraft, draftOf, moveDraft, editKey, editDrafts } from './donor-api.js';

const html = htm.bind(h);
const PAGE = 100;

const STYLE = `
.dn { display: grid; gap: 1rem; min-width: 0; }
/* Each one-column stack is as wide as its box, never as wide as its widest content asks (the filter pills' row
   asks for its whole length before it scrolls): what's too long wraps or scrolls inside, the page never widens */
:is(.dn, .dn-years, .dn-facts, .dn-needs, .dn-need, .dn-plain, .dn-thank__list, .dn-thank__one, .dn-note-new, .dn-picker__list, .dn-picker__item) { grid-template-columns: minmax(0, 1fr); }
.dn-status { margin: 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
.dn-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem .75rem; }
.dn-toolbar .search-bar { flex: 1 1 16rem; min-width: 0; }
.dn-sort { display: flex; align-items: center; gap: .4rem; font-size: var(--fs-sm); color: var(--color-text-secondary); }
.dn-sort .form-select { width: auto; min-height: 36px; }
.dn-list { padding: 0; overflow: hidden; }
.dn-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.dn-table th { padding: .55rem .9rem; border-bottom: 1px solid var(--color-border); text-align: left; font-size: var(--fs-xs); font-weight: 600; color: var(--color-text-muted); white-space: nowrap; }
.dn-table td { padding: .6rem .9rem; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
.dn-table tr:last-child td { border-bottom: none; }
.dn-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dn-row { cursor: pointer; }
.dn-row:hover td { background: var(--color-bg-hover); }
.dn-name { display: block; padding: 0; border: none; background: none; font: inherit; font-weight: 600; color: var(--color-text); text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.dn-name:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); border-radius: 4px; }
.dn-sub { display: block; margin-top: .1rem; font-size: var(--fs-xs); color: var(--color-text-muted); overflow-wrap: anywhere; }
.dn-more { display: flex; justify-content: center; padding: .75rem; border-top: 1px solid var(--color-border); }
.dn-empty { padding: 1.25rem; color: var(--color-text-secondary); }
.dn-tags { display: inline-flex; flex-wrap: wrap; gap: .3rem; vertical-align: middle; }
.dn-stage--new { background: var(--tone-success-bg, #E8F6EC); color: var(--tone-success-fg, #1F6B3A); }
.dn-stage--lapsed { background: var(--tone-warn-bg); color: var(--tone-warn-fg); }
.dn-head { margin-bottom: .25rem; }
.dn-head h2 { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .6rem; margin: 0; overflow-wrap: anywhere; }
.dn-head h2 .tag { font-size: var(--fs-xs); }
.dn-head__sub { margin: .25rem 0 0; color: var(--color-text-secondary); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.dn-back { display: inline-flex; align-items: center; gap: .35rem; margin-bottom: .5rem; padding: .25rem 0; border: none; background: none; font: inherit; font-size: var(--fs-sm); color: var(--color-text-secondary); cursor: pointer; }
.dn-back:hover { color: var(--color-text); }
.dn-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .6rem; }
.dn-tile { min-width: 0; padding: .75rem .85rem; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-bg-card); }
.dn-tile__label { display: block; font-size: var(--fs-xs); color: var(--color-text-muted); }
.dn-tile__value { display: block; margin-top: .15rem; font-size: var(--fs-lg, 1.125rem); font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
/* (a long amount, millions with cents: a size smaller, so it fits a phone's tile) */
.dn-tile__value.is-long { font-size: min(var(--fs-base, 1rem), 3.7vw); white-space: nowrap; overflow-wrap: normal; }
.dn-tile__sub { display: block; margin-top: .1rem; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.dn-years { display: grid; gap: .35rem; margin: 1rem 0 0; padding: 0; list-style: none; }
.dn-years li { display: grid; grid-template-columns: 3rem minmax(0, 1fr) auto; align-items: center; gap: .6rem; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.dn-bar { height: 8px; border-radius: 4px; background: var(--color-bg-secondary); overflow: hidden; }
.dn-bar > span { display: block; height: 100%; border-radius: 4px; background: var(--color-text); }
.dn-facts { display: grid; gap: .5rem; margin: 0; }
.dn-facts dt { font-size: var(--fs-xs); color: var(--color-text-muted); }
.dn-facts dd { margin: 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .dn-table .dn-hide-sm { display: none; }
  .dn-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* A phone: the stage under the name, so a total of millions has its column (never cut off) */
.dn-stage-xs { display: none; }
@media (max-width: 560px) {
  .dn-table .dn-hide-xs { display: none; }
  .dn-stage-xs { display: inline-block; margin-top: .25rem; }
  .dn-table th, .dn-table td { padding-left: .6rem; padding-right: .6rem; }
}
@media (pointer: coarse) { .dn-name, .dn-back { min-height: 44px; display: inline-flex; align-items: center; } }

.dn-tag--site { background: var(--color-bg-secondary); color: var(--color-text); }
.dn-needs-pill[aria-pressed="false"] { border-color: var(--tone-warn-border, #E9C46A); }
.dn-needs { display: grid; gap: .75rem; margin: 0; padding: 0; list-style: none; }
.dn-need { display: grid; gap: .45rem; padding: 1rem 1.1rem; }
.dn-need__q { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.dn-need__sub { margin: 0; font-size: var(--fs-sm); color: var(--color-text-secondary); overflow-wrap: anywhere; }
.dn-need__do { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; margin-top: .25rem; }
.dn-need__q, .dn-need__sub, .dn-need__do a { overflow-wrap: anywhere; min-width: 0; }
.dn-need__do .btn { display: inline-flex; align-items: center; gap: .35rem; }
.dn-same { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; }
.dn-same__one { display: grid; gap: .15rem; padding: .6rem .75rem; border: 1px solid var(--color-border); border-radius: 10px; min-width: 0; overflow-wrap: anywhere; }
.dn-done { padding: 1rem 0; }
.dn-picker { width: min(32rem, 100%); }
.dn-picker .form-input { width: 100%; margin-bottom: .6rem; }
.dn-picker__list { display: grid; gap: .25rem; max-height: 50vh; overflow: auto; margin: 0 0 1rem; padding: 0; list-style: none; }
.dn-picker__list > li { min-width: 0; }
.dn-picker__item { display: grid; gap: .1rem; width: 100%; min-width: 0; overflow-wrap: anywhere; padding: .55rem .7rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-card); font: inherit; text-align: left; color: var(--color-text); cursor: pointer; }
.dn-picker__item:hover:not(:disabled) { border-color: var(--color-border-strong); background: var(--color-bg-hover); }
.dn-picker__item:disabled { opacity: .55; cursor: default; }
.dn-picker__none { padding: .5rem .2rem; }
/* After Stage and the card under it (and, on a phone, after the giving and gifts) */
.dn-card--late { order: 3; }
/* A heading that takes the focus only so a screen reader says whose page this is */
.dn-head h2:focus, .dn-head h2[tabindex]:focus-visible, .dn .page-header h2[tabindex]:focus { outline: none; box-shadow: none; }
.dn-check { display: inline-flex; align-items: center; gap: .5rem; min-height: 36px; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; }
.dn-check input { width: 18px; height: 18px; margin: 0; }
.dn-plain { display: grid; gap: .6rem; margin: 0; padding: 0; list-style: none; font-size: var(--fs-sm); }
.dn-plain li { display: grid; gap: .15rem; min-width: 0; overflow-wrap: anywhere; }
.dn-row-do { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem .75rem; margin-top: .15rem; }
.dn .btn[aria-disabled="true"], .dn-picker .btn[aria-disabled="true"] { opacity: 0.45; cursor: progress; box-shadow: none; }
.dn-linkbtn { padding: 0; border: none; background: none; font: inherit; font-size: inherit; cursor: pointer; justify-self: start; text-align: left; }
.dn-suggest { margin-top: .75rem; padding: .7rem .8rem; border-radius: 10px; background: var(--tone-warn-surface, #FFF9DB); font-size: var(--fs-sm); }
.dn-suggest p { margin: 0 0 .4rem; }
.dn-maybe { padding: .6rem .75rem; border-radius: 10px; background: var(--tone-warn-surface, #FFF9DB); }
.dn-rename .form-input { width: 100%; margin-bottom: 1rem; }
/* Search, Owner and Sort on one line; the filters on their own below */
.dn-toolbar .ppl-filters { flex-basis: 100%; }
.dn-card--owner { order: 1; }
/* A person's Zeffy details after what to thank them for and their giving, on a phone */
.kd-card.dn-card--zeffy { order: 3; }
.dn-card--owner .form-select { width: 100%; }
.dn-tag--thank { background: var(--tone-warn-bg); color: var(--tone-warn-fg); }
.dn-thank { border-color: var(--tone-warn-border, #E9C46A); }
.dn-thank__list { display: grid; margin: 0; padding: 0; list-style: none; }
.dn-thank__one { display: grid; gap: .2rem; padding: .7rem 0; border-top: 1px solid var(--color-border); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.dn-thank__one:first-child { border-top: none; padding-top: 0; }
.dn-note-new { display: grid; gap: .5rem; }
/* (a button naming a long email, on a phone: its words wrap inside it) */
.dn-need__do .btn { max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left; height: auto; }
.dn-kept { margin: 0; padding: .5rem .75rem; border-left: 3px solid var(--color-border-strong); background: var(--color-bg-card); white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--fs-sm); }
.dn-note-new textarea, .dn-tl__body textarea { width: 100%; min-height: 4.5rem; resize: vertical; font: inherit; }
.dn-note-new__do { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem .75rem; }
@media (max-width: 720px) { .dn-same { grid-template-columns: minmax(0, 1fr); } }
/* Room under a list on a phone, so the item after one answered can sit above the message at the foot of the screen */
@media (max-width: 720px) { .dn-needs { padding-bottom: 7rem; } }
@media (pointer: coarse) { .dn-linkbtn, .dn-plain a, .dn-need__do a { min-height: 44px; display: inline-flex; align-items: center; } }
`;

let styled = false;
function useStyles() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.module = 'donors';
  el.textContent = STYLE;
  document.head.append(el);
}

// Whole dollars as whole dollars ($10,000), anything else to the cent ($10.10)
const usd = (cents) => { const c = Math.round(Number(cents) || 0); return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`; };
const day = (s) => (s ? new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const ago = (iso) => {
  if (!iso) return null;
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} minute${m === 1 ? '' : 's'} ago` : m < 1440 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'} ago` : `${Math.round(m / 1440)} day${Math.round(m / 1440) === 1 ? '' : 's'} ago`;
};
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const STAGES = {
  new: { label: 'New', tone: 'dn-stage--new', what: 'Their first gift was within the last 12 months.' },
  active: { label: 'Active', tone: '', what: 'They first gave more than a year ago, and have given within the last 18 months.' },
  lapsed: { label: 'Lapsed', tone: 'dn-stage--lapsed', what: 'No gift in the last 18 months.' },
  inkind: { label: 'In kind only', tone: '', what: 'Only gifts in kind so far.' },
  none: { label: 'No gifts of their own', tone: '', what: 'Only tickets, purchases, gifts refunded in full, or gifts that count for an organization.' },
};
// (a Giving tile's value: a size smaller when long, so millions with cents fit a phone's tile)
const tileClass = (v) => `dn-tile__value${String(typeof v === 'number' ? v : v ?? '').length > 10 ? ' is-long' : ''}`;
const stageTag = (s) => html`<span class=${`tag ${STAGES[s]?.tone || ''}`}>${STAGES[s]?.label || s}</span>`;
/** A teammate by their address: their name from Google, else the start of the address ("alex@…" → Alex) */
const fullName = (email, staff = []) => {
  if (!email) return '';
  const s = staff.find((x) => x.email === email);
  if (s) return s.name;
  if (!String(email).includes('@')) return String(email);
  const f = String(email).split('@')[0].split(/[._+-]/)[0];
  return f ? f[0].toUpperCase() + f.slice(1) : String(email);
};
const firstName = (email, staff = []) => fullName(email, staff).split(' ')[0];
// (a gift in kind Zeffy has no value for is said so, never "$0")
const amountOf = (g) => (g.inKind ? `${usd(g.inKind)} in kind` : !Number(g.cents) && (g.why === 'kind' || g.thanks?.why === 'kind') ? 'a gift in kind' : usd(g.cents));
/** Who looks after a donor, as the Owner filter has it: '' anyone, 'none' no one, else their address */
const ownerOk = (filter, owner) => !filter || (filter === 'none' ? !owner : owner === filter);
/** Where an organization is: its level on the Partners page, or only here */
const orgTag = (o) => html`<span class=${`tag ${o.onSite ? 'dn-tag--site' : ''}`}>${o.onSite ? `${o.levelLabel || 'Friend'} partner` : 'Not on the website'}</span>`;

// (the site's answers, changes and kept note drafts: ./donor-api.js, shared with each page's Timeline)
whenUnsure(() => listChanged());

function placeOf(hash = location.hash) {
  const raw = String(hash).replace(/^#/, '');
  // The old Job Costs address of Checks
  if (/^job-costs\/checks\b/.test(raw)) return { tab: 'checks' };
  const parts = raw.split('?')[0].split('/').slice(1).filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  if (!parts[0]) return { tab: 'people' };
  if (parts[0] === 'checks') return { tab: 'checks' };
  if (parts[0] === 'needs') return { tab: 'people', needs: true };
  if (parts[0] === 'thanks') return { tab: 'people', thanks: true };
  if (parts[0] === 'gift') return parts[1] ? { tab: 'people', gift: parts[1] } : { tab: 'people' };
  if (parts[0] === 'org') return parts[1] ? { tab: 'people', org: parts[1] } : { tab: 'people' };
  return { tab: 'people', donor: parts[0] };
}
// (a gift's link that settled on its donor is at the donor's address: the gift only marks which one to show)
const addressOf = (place) => (place.tab === 'checks' ? '#donors/checks' : place.needs ? '#donors/needs' : place.thanks ? '#donors/thanks' : place.org ? `#donors/org/${encodeURIComponent(place.org)}`
  : place.donor ? `#donors/${encodeURIComponent(place.donor)}` : place.gift ? `#donors/gift/${encodeURIComponent(place.gift)}` : '#donors');
function go(place) {
  const next = addressOf(place);
  if (location.hash !== next) history.pushState(null, '', next);
}
/** A donor in the list → their place */
/** From a toast, which can be pressed after leaving: by address, which the admin follows from anywhere */
const goTo = (place) => { location.hash = addressOf(place); };
const placeOfDonor = (d, extra = {}) => (d.type === 'org' ? { tab: 'people', org: d.ref, ...extra } : d.ref.startsWith('g:') ? { tab: 'people', gift: d.ref.slice(2), fromList: true, ...extra } : { tab: 'people', donor: d.ref, ...extra });

// Each move to a place (a link, Back, Forward, a click) is a new page there: nothing of the page before carries over
let moves = 0;
export function Donors({ addToast = () => {}, partners = [], partnersCount = null, communityCount = null, createPartner = null, onPartnersChanged = () => {} }) {
  useJobCostsStyles();
  useStyles();
  const [place, setPlace] = useState(() => ({ ...placeOf(), n: ++moves }));
  const placeRef = useRef(place);
  placeRef.current = place;
  // A double click is one press: its second half never lands on what moved under the pointer (the next item's
  // Thanked, a card's answer, the To thank box where a row was)
  useEffect(() => {
    const once = (e) => { if (e.detail > 1 && e.target?.closest?.('.dn button, .dn a, .dn .dn-row, .dn-picker button, .dn input[type="checkbox"], .dn label')) { e.preventDefault(); e.stopPropagation(); } };
    // …and a held Enter or Space is one press: its repeats never answer the next item, which takes the focus
    const held = (e) => { if (e.repeat && (e.key === 'Enter' || e.key === ' ') && e.target?.closest?.('.dn button, .dn a, .dn-picker button, .dn input[type="checkbox"]')) { e.preventDefault(); e.stopPropagation(); } };
    document.addEventListener('click', once, true);
    document.addEventListener('keydown', held, true);
    return () => { document.removeEventListener('click', once, true); document.removeEventListener('keydown', held, true); };
  }, []);
  useEffect(() => {
    // An old Job Costs link to Checks settles on this area's own address, opened fresh or followed from here
    const settle = () => { if (/^#job-costs\/checks\b/.test(location.hash)) history.replaceState(null, '', '#donors/checks'); };
    settle();
    const on = () => {
      settle();
      // Anywhere but the page To thank or Needs you opened: Back is to the list again
      if (backFor && location.hash !== backFor) { backTo = null; backFor = null; }
      if (!/^#(donors|job-costs\/checks)\b/.test(location.hash)) return;
      const next = placeOf();
      const cur = placeRef.current;
      if (cur && addressOf(cur) === addressOf(next)) return;
      setPlace({ ...next, n: ++moves });
    };
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    // An address changed between the first draw and now (a link followed at once) isn't missed
    on();
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('hashchange', on); backTo = null; backFor = null; };
  }, []);
  const open = (p) => { go(p); setPlace({ ...p, n: ++moves }); window.scrollTo({ top: 0, behavior: 'instant' }); };
  // A move that took away what had the focus (Take it out, then the list): the page's heading has it
  useEffect(() => { const t = setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) { const h = document.querySelector('.dn h2'); if (h) { if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } } }, 400); return () => clearTimeout(t); }, [place.n]);
  // Back from a donor's page: where it was opened from (To thank, Needs you), else the list
  const backLabel = backTo === 'thanks' ? 'To thank' : backTo === 'needs' ? 'Needs you' : 'Donors';
  // (back to To thank or Needs you: the item that took the opened one's place has the focus, working down the list;
  // its pill only when there's no place to go back to)
  const goBack = () => { const to = backTo; backTo = null; backFor = null; if (viewPlace && viewPlace.view === to) viewPlace = { ...viewPlace, armed: true }; else viewPlace = null; focusPill = !!to && !viewPlace; open({ tab: 'people', thanks: to === 'thanks', needs: to === 'needs' }); };
  // What's done here is in effect at once (private D1, Zeffy, Mercury), so no message offers Publish unless it says it
  // waits for it ({ publish: true }: a partner's level, a partner card made)
  const toast = (msg, type, action = null, o = {}) => addToast(msg, type, action, { publish: false, ...o });
  const ctx = { addToast: toast, open, partners, createPartner, partnersChanged: onPartnersChanged };
  const pick = (id) => {
    if (id === 'partners') location.hash = '#partners';
    else if (id === 'community') location.hash = '#partners/community-partners';
    else open({ tab: id === 'checks' ? 'checks' : 'people' });
  };
  if (place.org) return html`<div class="dn"><${OrgPage} key=${`${place.n}:${place.org}`} orgKey=${place.org} gift=${place.gift || null} ctx=${ctx} onBack=${goBack} backLabel=${backLabel} /></div>`;
  if (place.donor || place.gift) {
    // A gift's link settling on its donor's own address is the same page (n stays): it isn't read twice
    return html`<div class="dn"><${DonorPage} key=${place.n} donor=${place.donor} gift=${place.gift} fromList=${!!place.fromList} ctx=${ctx} onBack=${goBack} backLabel=${backLabel}
      onDonor=${(ref) => { if (location.hash !== addressOf(place)) return; history.replaceState(null, '', `#donors/${encodeURIComponent(ref)}`); setPlace({ tab: 'people', donor: ref, gift: place.gift, fromList: place.fromList, n: place.n }); }}
      onOrg=${(key) => { if (location.hash !== addressOf(place)) return; history.replaceState(null, '', `#donors/org/${encodeURIComponent(key)}`); setPlace({ tab: 'people', org: key, gift: place.gift, n: place.n }); }} /></div>`;
  }
  return html`<div class="dn">
    <${AreaTabs} current=${place.tab === 'checks' ? 'checks' : 'donors'} partners=${partnersCount} community=${communityCount} onPick=${pick} />
    ${place.tab === 'checks' ? html`<div class="page-header"><div><h2>Checks into Zeffy</h2>
        <p class="page-sub">Every check deposited in Mercury, on its way into Zeffy: the site reads each one and fills in its card, and a person sends it.</p></div></div>
      <div class="jc"><${Checks} addToast=${toast} onCount=${setChecksWaiting} /></div>`
      : html`<${DonorList} ctx=${ctx} view=${place.needs ? 'needs' : place.thanks ? 'thanks' : null} onView=${(w) => open({ tab: 'people', needs: w === 'needs', thanks: w === 'thanks' })} onOpen=${(d) => open(placeOfDonor(d))} />`}
  </div>`;
}

// ─── Donors ─────────────────────────────────────────────────────────

const SORTS = [
  ['latest', 'Latest gift', (a, b) => (b.latest?.at || 0) - (a.latest?.at || 0)],
  ['total', 'Most given', (a, b) => b.total - a.total],
  ['year', 'Most this year', (a, b) => b.thisYear - a.thisYear || b.total - a.total],
  ['last', 'Most last year', (a, b) => b.lastYear - a.lastYear || b.total - a.total],
  ['name', 'Name', (a, b) => a.name.localeCompare(b.name)],
];
let lastList = null; // the list as last read, so coming back from a donor shows it at once
// Where the list was (search, filter, sort, how many shown, scroll, the donor opened), so Back returns there
let lastPlace = null;
// The admin's sidebar (or anything that opens Donors by name) brings Donors fresh: its list as it first shows.
// Another area opened by name leaves it be: Back and Forward through the areas find it as it was
if (typeof window !== 'undefined') window.addEventListener('soard-nav', (e) => { if (!e.detail || e.detail === 'donors') lastPlace = null; });
// The Owner filter, kept while the admin is open (a donor's page and back, To thank and back)
let lastOwner = '';
// Where a donor's page was opened from, when not the list ('thanks' | 'needs'): its Back goes there. Kept with the
// address that list opened, so any other way to a page (a Slack link, after leaving the area) is the list's
let backTo = null;
let backFor = null;
const cameFrom = (view) => (e) => { const li = e.currentTarget.closest('li'); backTo = view; backFor = e.currentTarget.getAttribute('href'); viewPlace = { view, scroll: window.scrollY, href: backFor, i: li ? [...li.parentElement.children].indexOf(li) : 0 }; };
// (the browser's Back, a moment ago: as the page's own Back, it finds To thank or Needs you as it was)
if (typeof window !== 'undefined') window.addEventListener('popstate', () => { if (viewPlace) viewPlace = { ...viewPlace, armed: true }; });
// Where To thank or Needs you was when a giver was opened from it: back there, the same place and the same item
let viewPlace = null;
/** Back on To thank or Needs you from a giver: scrolled where it was, the focus on the link that opened them */
function useViewPlace(view, ready) {
  useEffect(() => {
    if (!ready) return;
    // (only on that Back: To thank or Needs you opened another way starts at the top, and forgets the place)
    if (viewPlace?.view !== view || !viewPlace.armed) { if (viewPlace?.view === view) viewPlace = null; return; }
    const at = viewPlace;
    viewPlace = null;
    requestAnimationFrame(() => {
      window.scrollTo({ top: at.scroll, behavior: 'instant' });
      // (gone since, thanked on their page: the item that took its place)
      const items = [...document.querySelectorAll('.dn-needs > li')];
      const a = [...document.querySelectorAll('.dn-needs a[href]')].find((x) => x.getAttribute('href') === at.href)
        || items[Math.min(at.i, items.length - 1)]?.querySelector('button:not([disabled]), a[href]');
      // (nothing left there: its pill)
      if (a) a.focus({ preventScroll: true });
      else document.querySelector('.dn .ppl-filters [aria-pressed="true"]')?.focus({ preventScroll: true });
    });
  }, [ready]);
}
// Back there: the focus on its pill (the donor's row has it when Back is to the list)
let focusPill = false;
/** Read the list again when it next shows (a change on a donor's page moves gifts between donors) */
const listChanged = () => { if (lastList) lastList = { ...lastList, stale: true }; };
/** Read again when a thank-you is said anywhere (a toast's Undo after leaving the page that said it) */
function useThanksSaid(reload) {
  const fn = useRef(reload);
  fn.current = reload;
  useEffect(() => {
    const on = (e) => { if (!(e.detail && 'value' in e.detail)) fn.current(); };
    window.addEventListener('soard-thanks-changed', on);
    window.addEventListener('soard-thanks-moved', on);
    return () => { window.removeEventListener('soard-thanks-changed', on); window.removeEventListener('soard-thanks-moved', on); };
  }, []);
}
/**
 * A page's read that a newer read can take the place of (a teammate's change heard meanwhile): whoever waits on it
 * (a change's own read) gets the page as it shows in the end, never an early return with the page as it was.
 * `readPage` returns TAKEN when a newer read took its place
 */
const TAKEN = Symbol('taken');
function useReads(readPage) {
  const reading = useRef(null);
  return (opts) => {
    const p = (async () => {
      const r = await readPage(opts);
      if (r !== TAKEN) return r;
      // (none newer: the page was left, so there's nothing to wait for)
      return reading.current && reading.current !== p ? reading.current : null;
    })();
    reading.current = p;
    return p;
  };
}
/** A read whose answer still counts: one started later wins, whatever order they come back in */
function useLatest() {
  const n = useRef(0);
  // (left: the list is gone, another view opened meanwhile; its slow read never lands on the counts or the sidebar)
  useEffect(() => () => { n.current = -1; }, []);
  return () => { if (n.current < 0) return () => false; const mine = ++n.current; return () => mine === n.current; };
}
/** The pressed pill in sight in its row (a phone scrolls the row sideways; the page never moves) */
function usePressedInView(deps) {
  useEffect(() => {
    const pill = document.querySelector('.dn .ppl-filters [aria-pressed="true"]');
    const row = pill?.parentElement;
    if (!row || row.scrollWidth <= row.clientWidth) return;
    const left = pill.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + pill.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = Math.max(0, left - (row.clientWidth - pill.offsetWidth) / 2);
  }, deps);
}

function DonorList({ ctx, view, onView, onOpen }) {
  const [v, setV] = useState(lastList);
  const [err, setErr] = useState(null);
  const back = useRef(lastPlace);
  const [q, setQ] = useState(back.current?.q || '');
  // To thank and Needs you aren't searched: their own lists, with no words left in the box over them
  useEffect(() => { if (view) setQ(''); }, [view]);
  const [stage, setStage] = useState(back.current?.stage || 'all');
  const [sort, setSort] = useState(back.current?.sort || 'latest');
  const [owner, setOwner] = useState(lastOwner);
  const [shown, setShown] = useState(back.current?.shown || PAGE);
  const search = useRef(null);
  // Back from a donor: the same rows, scrolled where they were, the focus on the donor just opened
  useEffect(() => {
    const b = back.current;
    if (!b || !v || view) return;
    back.current = null;
    requestAnimationFrame(() => {
      window.scrollTo({ top: b.scroll || 0, behavior: 'instant' });
      if (b.key) document.querySelector(`.dn-row[data-key="${CSS.escape(b.key)}"] .dn-name`)?.focus({ preventScroll: true });
    });
  }, [!!v]);
  // (kept as it changes, so Back, Forward and Back again find the same list: left for a donor, or for another area
  // straight from the list, with where it was scrolled to)
  useEffect(() => { lastPlace = { ...(lastPlace || {}), q, stage, sort, owner, shown }; }, [q, stage, sort, owner, shown]);
  const scrolled = useRef(0);
  useEffect(() => {
    if (view) return undefined;
    const on = () => { scrolled.current = window.scrollY; };
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, [view]);
  useEffect(() => () => { if (lastPlace && !view) lastPlace = { ...lastPlace, scroll: scrolled.current }; }, [view]);
  const openDonor = (p) => { lastPlace = { q, stage, sort, owner, shown, scroll: window.scrollY, key: p.key }; backTo = null; backFor = null; onOpen(p); };
  const latest = useLatest();
  // Left (a donor opened): a read still out lands nowhere, and its count never reaches the sidebar
  const gone = useRef(false);
  useEffect(() => () => { gone.current = true; }, []);
  const load = async () => {
    const current = latest();
    const j = await get('');
    if (!current() || gone.current) return;
    if (!j.success) { setErr(j.error); return; }
    setErr(null);
    lastList = j;
    setV(j);
    thanksChanged(j.thanks || 0);
  };
  // Shown at once from the last read, then read again (a change on a donor's page can move gifts)
  useEffect(() => { load(); }, []);
  useThanksSaid(load);
  usePressedInView([view, stage, !!v]);
  useEffect(() => { if (v && focusPill) { focusPill = false; document.querySelector('.dn .ppl-filters [aria-pressed="true"]')?.focus({ preventScroll: true }); } }, [!!v]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('.modal-overlay, .ask-overlay')) return;
      e.preventDefault();
      // The search box is there in every view: typing in it goes back to the list
      search.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view]);
  const firstRender = useRef(true);
  useEffect(() => { if (firstRender.current) { firstRender.current = false; return; } setShown(PAGE); }, [q, stage, sort, owner]);
  const people = v?.people || [];
  const staff = v?.staff || [];
  const me = v?.me && staff.some((s) => s.email === v.me) ? v.me : null;
  // The Owner filter on someone the list no longer offers (left the team, and looks after no one now): Anyone again
  useEffect(() => { if (v && owner && owner !== 'none' && owner !== me && !staff.some((s) => s.email === owner)) { setOwner(''); lastOwner = ''; } }, [v, owner]);
  // As people type it: accents and "&" or "and" either way (Marí finds María, "lark and wren" Lark & Wren)
  const fold = (x) => String(x || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ').trim();
  const words = fold(q);
  const inStage = (p, s) => (s === 'all' ? true : s === 'org' ? p.type === 'org' : s === 'yearend' ? p.lastYear > 0 && !p.thisYear : p.stage === s);
  const has = (x) => fold(x).includes(words);
  // An organization is found by who gave for it too (a person whose every gift counts for it has no row of their own)
  const giverOf = (p) => (words && p.type === 'org' && ![p.name, ...(p.companies || []), ...(p.funds || [])].some(has) ? (p.givers || []).find((g) => [g.name, ...(g.emails || [])].some(has)) : null);
  const matches = useMemo(() => people.filter((p) => inStage(p, stage) && ownerOk(owner, p.owner)
    && (!words || [p.name, p.email, ...(p.companies || []), ...(p.funds || [])].some(has) || !!giverOf(p)))
    .sort(SORTS.find(([k]) => k === sort)[2]), [people, words, stage, sort, owner]);
  const count = (s) => people.filter((p) => inStage(p, s) && ownerOk(owner, p.owner)).length;
  // Gifts to thank, under the Owner filter like every other count (and like the To thank list)
  const thanksShown = Array.isArray(v?.thanksOwners) ? v.thanksOwners.filter((o) => ownerOk(owner, o || null)).length : v?.thanks || 0;
  if (err && !v) return html`<div class="notice notice--danger"><div class="notice__body"><strong>Couldn’t load donors:</strong> ${err}</div>
    <div class="notice__actions"><button class="btn btn-ghost" onClick=${load}>Try again</button></div></div>`;
  // Read before and couldn't be read again: what shows is the last read, and it says so
  const stale = err && v ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>Couldn’t read the list again:</strong> ${err} It shows what was read before.</div>
    <div class="notice__actions"><button class="btn btn-ghost" onClick=${load}>Try again</button></div></div>` : null;
  if (!v) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;
  const fresh = ago(v.windowAt);
  const year = new Date().getFullYear();
  const filters = [['all', 'Everyone'], ['org', 'Organizations'], ['new', 'New'], ['active', 'Active'], ['lapsed', 'Lapsed'], ['yearend', 'Not yet this year']];
  // The year-end list reads best by last year's giving; leaving it, the list goes back to the latest gift
  const pickStage = (k) => {
    if (k === 'yearend' && sort === 'latest') setSort('last');
    if (k !== 'yearend' && stage === 'yearend' && sort === 'last') setSort('latest');
    setStage(k);
    if (view) onView(null);
  };
  const pickOwner = (o) => { setOwner(o); lastOwner = o; };
  // To thank or Needs you just read: the counts above them say what they show (a teammate's answers since included)
  const counts = (c) => { setV((x) => (x ? { ...x, ...c } : x)); if (lastList) lastList = { ...lastList, ...c }; if ('thanks' in c) thanksChanged(c.thanks); };
  const yearEnd = stage === 'yearend';
  // A count from before a change made since (Back to the list after a thank-you): being read again, never shown as now
  const n = (x, tone = '') => (v.stale && !err ? html`<span class=${`count ${tone}`} aria-label="being read again">…</span>` : html`<span class=${`count ${tone}`}>${x.toLocaleString()}</span>`);
  const ownerName = owner === 'none' ? 'no one' : owner === me ? 'you' : fullName(owner, staff);
  return html`
    <div class="page-header">
      <div>
        <h2>Donors</h2>
        <p class="page-sub">Everyone who gives to SOARD, people and organizations, from Zeffy. Gifts are taken and changed in Zeffy: each one here opens there. Which organization a name belongs to, who looks after them, notes and thank-yous are kept here, for the team only.</p>
      </div>
    </div>
    ${v.error || (v.windowError && (!v.windowAt || Date.now() - Date.parse(v.windowAt) > 30 * 60e3)) ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>The site couldn’t finish reading Zeffy${v.windowAt ? ` since ${ago(v.windowAt)}` : ''}.</strong> ${v.error || v.windowError}. It tries again on its own every 15 minutes; the list shows what it read last.</div></div>` : null}
    ${stale}
    ${v.held ? html`<div class="notice notice--warn" role="status"><div class="notice__body"><strong>Zeffy’s list came back much shorter than the one here.</strong> Nothing was taken out. If the next read agrees, the gifts Zeffy no longer has come off; if it was a glitch, nothing changes. Nothing to do.</div></div>` : null}
    ${!v.filledAt ? html`<div class="notice" role="status"><div class="notice__body"><strong>Reading all of Zeffy’s history.</strong> ${v.payments ? `${v.payments.toLocaleString()} gifts so far. ` : ''}Totals and first gifts fill in over the next hour or so; nothing to do.</div></div>` : null}
    <div class="dn-toolbar">
      <div class="search-bar">
        <span class="search-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>
        <input type="search" ref=${search} placeholder="Name, email or company" aria-label="Search donors" aria-keyshortcuts="/" value=${q} onInput=${(e) => { setQ(e.target.value); if (view) onView(null); }} />
        ${!q ? html`<kbd class="kd-kbd" aria-hidden="true">/</kbd>` : null}
      </div>
      ${view === 'needs' ? null : html`<label class="dn-sort dn-owner-filter">Owner <select class="form-select" value=${owner} onChange=${(e) => pickOwner(e.target.value)}>
        <option value="">Anyone</option>
        ${me ? html`<option value=${me}>Me</option>` : null}
        <option value="none">No one</option>
        ${staff.filter((s) => s.email !== me).map((s) => html`<option key=${s.email} value=${s.email}>${s.name}${s.left ? ' (left the team)' : ''}</option>`)}
      </select></label>`}
      ${view ? null : html`<label class="dn-sort dn-sort-by">Sort <select class="form-select" value=${sort} onChange=${(e) => setSort(e.target.value)}>${SORTS.map(([k, label]) => html`<option key=${k} value=${k}>${label}</option>`)}</select></label>`}
      <div class="ppl-filters" role="group" aria-label="Show">
        ${filters.map(([k, label]) => html`
          <button type="button" key=${k} class="pill ppl-filter" aria-pressed=${!view && stage === k} onClick=${() => pickStage(k)}>${label} ${n(count(k))}</button>`)}
        ${v.thanks || view === 'thanks' ? html`<button type="button" class="pill ppl-filter dn-needs-pill" aria-pressed=${view === 'thanks'} onClick=${() => onView(view === 'thanks' ? null : 'thanks')}>To thank ${n(thanksShown, 'is-warn')}</button>` : null}
        ${v.needs || view === 'needs' ? html`<button type="button" class="pill ppl-filter dn-needs-pill" aria-pressed=${view === 'needs'} onClick=${() => onView(view === 'needs' ? null : 'needs')}>Needs you ${n(v.needs || 0, 'is-warn')}</button>` : null}
      </div>
    </div>
    ${view === 'needs' ? html`<${NeedsList} ctx=${ctx} onChanged=${load} onCount=${(n) => counts({ needs: n })} />`
    : view === 'thanks' ? html`<${ThanksList} ctx=${ctx} owner=${owner} ownerName=${ownerName} onCount=${(items) => counts({ thanks: items.length, thanksOwners: items.map((t) => t.owner || '') })} />` : html`
    <p class="dn-status">${stage === 'org' ? 'Partners and the other organizations that give, with their gifts from every name they give under.' : yearEnd ? `The year-end list: gave in ${year - 1}, nothing yet in ${year}.` : STAGES[stage]?.what || 'Everyone who has given.'}${owner ? ` Looked after by ${ownerName}.` : ''} From Zeffy${fresh ? `, read ${fresh}` : ''}.</p>
    <div class="card dn-list">
      ${matches.length ? html`<table class="dn-table">
        <caption class="sr-only">Donors${stage === 'org' ? ', organizations' : yearEnd ? ', not yet this year' : stage !== 'all' ? `, ${STAGES[stage].label}` : ''}${owner ? `, looked after by ${ownerName}` : ''}${words ? `, matching “${q.trim()}”` : ''}</caption>
        <thead><tr><th scope="col">Donor</th><th scope="col" class="dn-hide-xs">Stage</th><th scope="col" class="num dn-hide-sm">${yearEnd ? 'Last year' : 'This year'}</th><th scope="col" class="num">All time</th><th scope="col" class="num dn-hide-sm">Latest gift</th><th scope="col" class="dn-hide-sm">Owner</th></tr></thead>
        <tbody>${matches.slice(0, shown).map((p) => html`<tr key=${p.key} class="dn-row" data-key=${p.key} onClick=${(e) => { if (!e.target.closest('button')) openDonor(p); }}>
          <td><button type="button" class="dn-name" onClick=${() => openDonor(p)}>${p.name}</button>
            <span class="dn-sub">${p.type === 'org' ? html`${orgTag(p)} ` : null}${[giverOf(p) ? `given by ${giverOf(p).name || giverOf(p).emails[0]}` : null, p.type !== 'org' && p.companies?.length ? `for ${p.companies.join(', ')}` : null, p.funds?.length ? `through ${p.funds.join(', ')}` : null, p.keepAnonymous ? 'kept anonymous' : p.anonymous ? 'asked to be anonymous' : null, `${plural(p.gifts, 'gift')}${p.streak > 1 ? `, ${p.streak} years in a row` : ''}`].filter(Boolean).join(' · ')}</span><span class="dn-stage-xs">${stageTag(p.stage)}</span></td>
          <td class="dn-hide-xs">${stageTag(p.stage)}</td>
          <td class="num dn-hide-sm">${(yearEnd ? p.lastYear : p.thisYear) ? usd(yearEnd ? p.lastYear : p.thisYear) : '–'}</td>
          <td class="num">${usd(p.total)}</td>
          <td class="num dn-hide-sm">${day(p.latest?.at)}</td>
          <td class="dn-hide-sm">${p.owner ? firstName(p.owner, staff) : html`<span class="dn-sub">–</span>`}</td>
        </tr>`)}</tbody>
      </table>
      ${matches.length > shown ? html`<div class="dn-more"><button type="button" class="btn btn-ghost btn-sm" onClick=${() => { const at = shown; setShown((n) => n + PAGE); requestAnimationFrame(() => document.querySelectorAll('.dn-table tbody .dn-name')[at]?.focus()); }}>Show ${Math.min(PAGE, matches.length - shown)} more of ${matches.length.toLocaleString()}</button></div>` : null}`
      : html`<p class="dn-empty">${people.length ? `No donors match${words ? ` “${q.trim()}”` : ''}${stage !== 'all' ? ` among ${Object.fromEntries(filters)[stage] || stage}` : ''}${owner ? `, looked after by ${ownerName}` : ''}.${stage !== 'all' && owner ? ' Try Everyone and Anyone.' : stage !== 'all' ? ' Try Everyone.' : owner ? ' Try Anyone.' : ''}` : 'No gifts read from Zeffy yet. They come in within 15 minutes.'}</p>`}
    </div>`}`;
}

// ─── To thank ───────────────────────────────────────────────────────

/**
 * Thanked, or not needed: said on the gift, with Undo in the toast. Each says what it saw (To thank; Undo, what it
 * said), so another tab's or a teammate's answer since is never overwritten: they're told instead. Whatever happens,
 * every view of it reads again (the list, To thank, a donor's page, the sidebar), wherever the person is by then
 */
async function sayThanks(ctx, g, state) {
  const r = await change({ act: 'thanks', id: g.id, state, was: 'todo' });
  // (every view reads again once: a refusal or a lost answer has had change() ask already)
  if (r.success) { listChanged(); thanksChanged(); }
  if (!r.success) { ctx.addToast(r.error, 'error'); return false; }
  // Already so (a second click, or a teammate said the same): nothing changed, so nothing to undo
  if (r.same && !(r.retried && r.you)) { ctx.addToast(`${state === 'thanked' ? 'Thanked' : 'No thank-you needed'} already${r.you ? ', by you' : r.by ? `, said by ${r.by.split('@')[0].replace(/^./, (c) => c.toUpperCase())}` : ''}`, 'info'); return true; }
  const undo = async () => {
    const u = await change({ act: 'thanks', id: g.id, state: 'todo', was: state });
    // Back in its list: the focus on it (pressed from the toast, the focus had nowhere to be), once a read shows it
    const back = u.success ? focusWhenBack(g.id) : null;
    // (a refusal or a lost answer has had change() ask every view to read again already)
    if (u.success) { listChanged(); thanksChanged(); }
    if (!u.success) { ctx.addToast(u.error, 'error'); return; }
    // (put back already, by a teammate or another tab: said so, never as if this Undo did it)
    if (u.same && !(u.retried && u.you)) ctx.addToast(`Back on To thank already${u.you ? ', by you in another tab' : u.by ? `, put back by ${u.by.split('@')[0].replace(/^./, (c) => c.toUpperCase())}` : ''}: ${amountOf(g)}${from}`, 'info');
    else ctx.addToast(`To thank again: ${amountOf(g)}${from}`, 'info');
    await back;
  };
  // (Zeffy with no name for them: the gift alone, never "from No name")
  const from = g.name && g.name !== 'No name' ? ` from ${g.name}` : '';
  ctx.addToast(state === 'thanked' ? `Thanked: ${amountOf(g)}${from}` : `No thank-you needed: ${amountOf(g)}${from}`, 'success', { label: 'Undo', fn: undo });
  return true;
}
/** A list of thank-yous (To thank, a donor's page) shows a fresh read: whoever waits for one looks again */
const thanksRead = () => window.dispatchEvent(new Event('soard-thanks-read'));
/**
 * A thank-you said To thank again (Undo): its Thanked button, once a read made after the Undo shows it again (one read
 * before it may still show it as it was, then not at all), and only while the focus is nowhere a person put it
 */
function focusWhenBack(id) {
  return new Promise((done) => {
    let t = null;
    const finish = () => { window.removeEventListener('soard-thanks-read', look); clearTimeout(t); done(); };
    function look() {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-thank="${CSS.escape(String(id))}"] .btn-primary`);
        if (!el) return;
        const a = document.activeElement;
        if (!a || a === document.body || a.matches('h1, h2, .toast-undo, [tabindex="-1"]')) el.focus();
        finish();
      });
    }
    window.addEventListener('soard-thanks-read', look);
    t = setTimeout(finish, 6000);
  });
}
/** An item under the messages at the foot of the screen (a phone): the page moves so it shows above them */
function clearOfToasts(el) {
  const t = [...document.querySelectorAll('.toast-container .toast')].map((x) => x.getBoundingClientRect()).filter((r) => r.height);
  if (!t.length) return;
  const top = Math.min(...t.map((r) => r.top));
  const r = el.getBoundingClientRect();
  if (!(r.bottom > top - 8 && r.top < window.innerHeight)) return;
  const need = r.bottom - top + 16;
  // Not enough page left below to move it clear (the last items, several messages up): room is made under the list
  const room = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
  const list = el.closest('ul, ol');
  if (room < need && list) list.style.paddingBottom = `${(parseFloat(getComputedStyle(list).paddingBottom) || 0) + need - room + 16}px`;
  window.scrollBy({ top: need });
}
/** After an item of a list is answered and goes: the focus on the one that took its place, else the list's words */
function useRefocus(selector, ready, otherwise = '.dn-done, .dn-status') {
  const at = useRef(null);
  useEffect(() => {
    // Once the item answered has gone (the list read again), not before
    // (an answer that failed leaves its item: after a while the focus is left where the person put it)
    if (at.current && Date.now() - at.current.t > 10e3) at.current = null;
    if (at.current == null || !ready || at.current.li?.isConnected) return;
    const { i } = at.current;
    at.current = null;
    // The person moved on meanwhile (typing a note, the Owner filter): the focus stays where they put it
    if (document.activeElement && document.activeElement !== document.body) return;
    const items = [...document.querySelectorAll(`${selector} > li`)];
    const item = items[Math.min(i, items.length - 1)];
    const next = item?.querySelector('.dn-need__do button:not([disabled]), .dn-row-do button:not([disabled])') || item?.querySelector('button:not([disabled]), a[href]');
    const fallback = document.querySelector(otherwise);
    if (next) { next.focus(); requestAnimationFrame(() => clearOfToasts(next.closest('li') || next)); }
    else if (fallback) { fallback.setAttribute('tabindex', '-1'); fallback.focus(); }
  });
  return (el) => { const li = el?.closest?.('li'); at.current = { li, i: li ? [...li.parentElement.children].indexOf(li) : 0, t: Date.now() }; };
}
// (by the calendar, as people say it: last night's is yesterday's)
const waiting = (since) => {
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return '';
  const dayOf = (x) => { const d = new Date(x); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5; };
  const d = dayOf(Date.now()) - dayOf(t);
  return d < 1 ? 'Came in today' : d === 1 ? 'Came in yesterday' : `Waiting ${plural(d, 'day')}`;
};

function ThanksList({ ctx, owner = '', ownerName = '', onCount = () => {} }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const latest = useLatest();
  const load = async () => {
    const current = latest();
    const j = await get('?thanks=1');
    if (!current()) return;
    if (!j.success) { setErr(j.error); return; }
    setErr(null);
    setV(j);
    // (an answer's button waits for the read it asked for: the list as it is now)
    setBusy(null);
    onCount(j.items);
    thanksRead();
  };
  useEffect(() => { load(); }, []);
  useThanksSaid(load);
  const refocus = useRefocus('.dn-needs[aria-label="To thank"]', !!v);
  useViewPlace('thanks', !!v);
  if (err) return html`<div class="notice notice--danger"><div class="notice__body">${err}</div><div class="notice__actions"><button class="btn btn-ghost" onClick=${load}>Try again</button></div></div>`;
  if (!v) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;
  const items = v.items.filter((t) => ownerOk(owner, t.owner));
  const doIt = async (t, state, e) => {
    refocus(e.currentTarget);
    setBusy(`${t.id}:${state}`);
    // (the answer has every view read again, this list too: its read lands and frees the buttons)
    await sayThanks(ctx, t, state);
  };
  if (!items.length) return html`<p class="dn-status dn-done">${owner ? `Nothing to thank for donors looked after by ${ownerName}.` : 'Nothing to thank.'} A gift shows here when Zeffy sends the giver no thank-you (a check, a donor-advised fund, a gift in kind, anything entered by hand) or it’s $1,000 or more.</p>`;
  return html`
    <p class="dn-status">Zeffy thanks online givers by email. These it doesn’t, or they’re big enough for a call or a note from the team. The one waiting longest is first${owner ? `; looked after by ${ownerName}` : ''}.</p>
    <ul class="dn-needs" aria-label="To thank">${items.map((t) => html`<li key=${t.id} class="card dn-need" data-thank=${t.id}>
      <p class="dn-need__q">Thank ${t.name === 'No name' ? 'a giver Zeffy has no name for' : t.name}${t.org && t.org.name !== t.name ? ` (for ${t.org.name})` : !t.org && t.company && t.company !== t.name && t.how !== 'Donor-advised fund' ? ` (for ${t.company})` : ''}: ${amountOf(t)}</p>
      <p class="dn-need__sub">${[t.how, t.campaign, day(t.at)].filter(Boolean).join(' · ')}. ${t.whyText}.</p>
      <p class="dn-need__sub">${t.owner ? `Looked after by ${fullName(t.owner, v.staff)}` : 'No one looks after them yet'} · ${waiting(t.since)}</p>
      <div class="dn-need__do">
        <button type="button" class="btn btn-primary btn-sm" aria-label=${`Thanked: ${amountOf(t)} from ${t.name === 'No name' ? 'a giver Zeffy has no name for' : t.name}`} aria-disabled=${busy ? 'true' : null} onClick=${(e) => { if (!busy) doIt(t, 'thanked', e); }}>${busy === `${t.id}:thanked` ? html`<span class="spinner spinner-14" />` : null}Thanked</button>
        <button type="button" class="btn btn-ghost btn-sm" aria-label=${`Not needed: ${amountOf(t)} from ${t.name === 'No name' ? 'a giver Zeffy has no name for' : t.name}`} aria-disabled=${busy ? 'true' : null} onClick=${(e) => { if (!busy) doIt(t, 'skipped', e); }}>${busy === `${t.id}:skipped` ? html`<span class="spinner spinner-14" />` : null}Not needed</button>
        <a class="link" href=${t.org ? `#donors/org/${encodeURIComponent(t.org.key)}` : t.ref && !t.ref.startsWith('g:') ? `#donors/${encodeURIComponent(t.ref)}` : `#donors/gift/${encodeURIComponent(t.ids?.[0] || t.id)}`} onClick=${cameFrom('thanks')}>${t.org ? `Open ${t.org.name}` : t.name === 'No name' ? 'Open their gift' : `Open ${t.name}`}</a>
        <a class="link" href=${zeffyPaymentUrl(t.ids?.[0] || t.id)} target="_blank" rel="noopener" aria-label=${`Open in Zeffy: ${amountOf(t)} from ${t.name === 'No name' ? 'a giver Zeffy has no name for' : t.name}`}>Open in Zeffy</a>
      </div></li>`)}</ul>
    ${v.more ? html`<p class="dn-status">And ${plural(v.more, 'more gift')} after these.</p>` : null}`;
}

// ─── Needs you ──────────────────────────────────────────────────────

/** Moving a partner to Champion, as Partners asks it (the page on Publish, JobTread's role soon) */
async function makeChampion(item, ctx) {
  const yes = await ask({
    title: `Move ${item.name} to Champion?`,
    text: `They gave ${usd(item.cents12)} in the last 12 months. Champion is the Champions grid on the Partners page; the page changes when you publish. Anyone of theirs in JobTread gets the Champion role there soon, published or not.`,
    yes: 'Move to Champion', careful: true,
  });
  if (!yes) return false;
  // One step on the site: the partner moved (an upgrade only, as it is at that moment) and the answer said, together;
  // refused (someone answered, or moved them, since), nothing changes and it says why
  const r = await change({ act: 'level', org: item.org, done: true, was: item.levelLabel, asked: true, move: true });
  if (!r.success) {
    // The answer lost on the way back (the move may have gone through): as it is now, never a failure that worked
    const now = r.status && r.status < 500 ? null : await get(`?org=${encodeURIComponent(item.org)}`);
    if (now?.success && now.level === 'champion') {
      window.dispatchEvent(new CustomEvent('soard-content-changed'));
      ctx.partnersChanged?.();
      ctx.addToast(`${item.name} moves to Champion when you publish`, 'success', null, { publish: true });
      return true;
    }
    ctx.addToast(`Couldn’t move ${item.name}: ${r.error}`, 'error');
    return false;
  }
  // A partner's level is the website's: the Publish bar counts it at once, and Partners shows it there
  window.dispatchEvent(new CustomEvent('soard-content-changed'));
  ctx.partnersChanged?.();
  ctx.addToast(`${item.name} moves to Champion when you publish`, 'success', null, { publish: true });
  return true;
}

/** Making an organization here (not on the website) from a name, with that name linked */
async function keepAsOrg(name, link, ctx, question = null) {
  const key = `o:${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const r = await change({ act: 'org-new', key, name, links: link ? [link] : [], ...(question ? { asked: true, subject: question.subject, also: question.also || [] } : {}) });
  if (!r.success) { ctx.addToast(r.error, 'error'); return null; }
  listChanged();
  ctx.addToast(r.same && !r.retried ? `${name} is an organization here already: someone kept it a moment ago.` : `${name} is an organization here now. Only staff see it.`, 'success', { label: 'Open', fn: () => goTo({ tab: 'people', org: r.key }) });
  return r.key;
}

function NeedsList({ ctx, onChanged, only = null, onCount = () => {} }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [staff, setStaff] = useState([]);
  const latest = useLatest();
  const load = async () => {
    const current = latest();
    const j = await get('?needs=1');
    if (!current()) return;
    if (!j.success) { setErr(j.error); return; }
    setErr(null);
    setV(j.items);
    setStaff(j.staff || []);
    if (!only) onCount(j.items.length);
  };
  useEffect(() => { load(); }, []);
  useThanksSaid(load);
  const refocus = useRefocus('.dn-needs[aria-label="Needs you"]', !!v);
  useViewPlace('needs', !!v);
  const doIt = async (id, fn, e) => {
    refocus(e?.currentTarget);
    setBusy(id);
    const ok = await fn();
    // Answered, or not (someone answered it first, it's gone since): the list as it is now, and the card stays busy
    // until then (never pressed twice)
    if (ok !== false) listChanged();
    await load();
    setBusy(null);
    onChanged?.();
  };
  // An answer to the question as this page asked it: answered since (another tab, a teammate), nothing changes
  const said = async (body, done) => { const r = await change({ ...body, asked: true }); if (!r.success) { ctx.addToast(r.error, 'error'); return false; } if (done) ctx.addToast(done, 'success'); return true; };
  if (err) return html`<div class="notice notice--danger"><div class="notice__body">${err}</div><div class="notice__actions"><button class="btn btn-ghost" onClick=${load}>Try again</button></div></div>`;
  if (!v) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;
  const items = only ? v.filter(only) : v;
  if (!items.length) return html`<p class="dn-status dn-done">Nothing needs you. The site asks here when a name might be a partner or reads as an organization’s, two records might be one person, a gift could count for two organizations, or someone’s giving says Champion.</p>`;
  const btn = (id, label, fn, primary = false) => html`<button type="button" class=${`btn btn-sm ${primary ? 'btn-primary' : 'btn-ghost'}`} aria-disabled=${busy ? 'true' : null} onClick=${(e) => { if (!busy) doIt(id, fn, e); }}>${busy === id ? html`<span class="spinner spinner-14" />` : null}${label}</button>`;
  // A donor's page from here: its Back comes back here
  const who = (s, label = s.name) => html`<a class="link" href=${`#donors/${encodeURIComponent(s.ref)}`} onClick=${cameFrom('needs')}>${label}</a>`;
  return html`<ul class="dn-needs" aria-label="Needs you">${items.map((it) => {
    const id = it.id;
    if (it.kind === 'level') return html`<li key=${id} class="card dn-need">
      <p class="dn-need__q">${it.name} gave ${usd(it.cents12)} in the last 12 months. Make them a Champion?</p>
      <p class="dn-need__sub">A Funding partner, ${it.levelLabel} on the Partners page now. Champion is for major sponsors: $10,000 or more.</p>
      <div class="dn-need__do">${btn(id, 'Move to Champion…', () => makeChampion(it, ctx), true)}${btn(`${id}:no`, 'Not now', () => said({ act: 'level', org: it.org, done: false }, 'It won’t ask about them again for a year'))}
        <a class="link" href=${`#donors/org/${encodeURIComponent(it.org)}`} onClick=${cameFrom('needs')}>See their giving</a></div></li>`;
    // A name that reads as an organization's: a contact can be said to be a person, for good
    const isPerson = (label = 'It’s a person') => (it.person ? btn(`${id}:person`, label, () => said({ act: 'big', subject: it.subject, also: it.also || [], person: true }, `${it.name} stays a person, and it won’t ask again`)) : null);
    const keep = btn(id, 'Keep it as an organization', async () => { const k = await keepAsOrg(it.name, { kind: it.link, subject: it.linkSubject }, ctx, it); return k ? true : false; }, true);
    if (it.kind === 'big') return html`<li key=${id} class="card dn-need">
      <p class="dn-need__q">${it.name} gave ${usd(it.cents12)} in the last 12 months and isn’t an organization here.</p>
      <p class="dn-need__sub">${it.people?.length ? `Given by ${it.people.join(', ')}. ` : ''}Keep it as an organization to see all its giving together. Only staff see it; putting it on the website is a separate step.</p>
      <div class="dn-need__do">${keep}${isPerson()}${btn(`${id}:no`, 'Not now', () => said({ act: 'big', subject: it.subject, also: it.also || [] }, 'It won’t ask about it again for a year'))}</div></li>`;
    if (it.kind === 'named') return html`<li key=${id} class="card dn-need">
      <p class="dn-need__q">Is ${it.name} an organization?</p>
      <p class="dn-need__sub">Its name reads as one, but it shows as a person here. It gave ${usd(it.cents)} in all. Keep it as an organization to list it with the organizations; only staff see it.</p>
      <div class="dn-need__do">${keep}${isPerson('No, it’s a person')}
        ${it.ref ? who({ ref: it.ref, name: it.name }, 'See their gifts') : null}
        ${it.link === 'contact' ? html`<a class="link" href=${zeffyContactUrl(it.linkSubject)} target="_blank" rel="noopener">Open in Zeffy</a>` : null}</div></li>`;
    if (it.kind === 'near') return html`<li key=${id} class="card dn-need">
      <p class="dn-need__q">Is ${it.link === 'company' ? html`“${it.subject}”` : it.name} ${it.orgName}?</p>
      <p class="dn-need__sub">${it.link === 'company' ? `A company named on ${usd(it.cents)} of gifts${it.people?.length ? ` (${it.people.join(', ')})` : ''}.` : `A Zeffy contact who gave ${usd(it.cents)}.`} ${it.why}. Yes counts its gifts for ${it.orgName}.</p>
      <div class="dn-need__do">${btn(id, `Yes, it’s ${it.orgName}`, () => said({ act: 'link', kind: it.link, subject: it.subject, org: it.org }, `Its gifts count for ${it.orgName} now`), true)}${btn(`${id}:no`, 'No', () => said({ act: 'not', kind: it.link, subject: it.subject, org: it.org }, `It won’t link that name to ${it.orgName}`))}
        ${it.link === 'contact' ? html`<a class="link" href=${zeffyContactUrl(it.subject)} target="_blank" rel="noopener">Open in Zeffy</a>` : null}</div></li>`;
    if (it.kind === 'clash') return html`<li key=${id} class="card dn-need">
      <p class="dn-need__q">${it.name}’s gift of ${usd(it.cents)} on ${day(it.at)} was for ${it.company}, but their Zeffy contact counts for ${it.countedName}.</p>
      <p class="dn-need__sub">It counts for ${it.countedName} until you say.</p>
      <div class="dn-need__do">${btn(id, `Count it for ${it.otherName}`, () => said({ act: 'payment', id: it.payment, owner: it.other }, `That gift counts for ${it.otherName} now`))}${btn(`${id}:keep`, `Keep it with ${it.countedName}`, () => said({ act: 'payment', id: it.payment, owner: it.counted }, `That gift counts for ${it.countedName}`))}
        <a class="link" href=${zeffyPaymentUrl(it.payment)} target="_blank" rel="noopener">Open in Zeffy</a></div></li>`;
    if (it.kind === 'same') return html`<li key=${id} class="card dn-need">
      <p class="dn-need__q">${it.a.name === it.b.name ? `Same person? Two records named ${it.a.name}` : `Same person? ${it.a.name} and ${it.b.name}`}</p>
      <p class="dn-need__sub">${it.why}. The same person shows as one donor here, with all their gifts; Zeffy keeps both records until someone merges them there.</p>
      <div class="dn-same">${[it.a, it.b].map((s) => html`<div key=${s.key} class="dn-same__one"><strong>${s.ref ? who(s) : s.name}</strong>
        <span class="dn-sub">${[s.email, `${plural(s.gifts, 'gift')}, ${usd(s.cents)}`, s.latest ? `latest ${day(s.latest)}` : null].filter(Boolean).join(' · ')}</span>
        ${s.ref ? html`<a class="link dn-sub" href=${zeffyContactUrl(s.ref)} target="_blank" rel="noopener">Open in Zeffy</a>` : null}</div>`)}</div>
      <div class="dn-need__do">${btn(id, 'Same person', () => said({ act: 'same', a: it.a.key, b: it.b.key, same: true }, 'One donor now'), true)}${btn(`${id}:no`, 'Not the same', () => said({ act: 'same', a: it.a.key, b: it.b.key, same: false }, 'Two donors, and it won’t ask again'))}</div></li>`;
    if (it.kind === 'moved') {
      // The team's notes and owner, left on the old record: they go to the contact picked, never left where no one sees them
      const kept = [it.notes === 1 ? 'note' : it.notes ? `${it.notes} notes` : null, it.owner ? `owner (${firstName(it.owner, staff)})` : null].filter(Boolean);
      const keptWords = kept.length ? `Its ${kept.join(' and its ')} ${kept.length > 1 || it.notes > 1 ? 'go' : 'goes'} to the one you pick${it.owner && it.who?.some((w) => w.owner) ? ' (its owner only to one with no owner of its own)' : ''}.` : '';
      // Each told apart (two of one name, as a duplicate Zeffy split is): its email and its gifts
      const who = (i) => it.names?.[i] || `Contact ${i + 1}`;
      const whoFull = (i) => [who(i), it.who?.[i]?.email, it.who?.[i]?.gifts ? plural(it.who[i].gifts, 'gift') : null, it.who?.[i]?.owner ? `looked after by ${firstName(it.who[i].owner, staff)}` : null].filter(Boolean).join(', ');
      // What goes to each: the old owner only to one with no owner of its own (one that has one keeps theirs, and says so)
      const goes = (i) => {
        const own = it.who?.[i]?.owner;
        const parts = [it.notes === 1 ? 'note' : it.notes ? `${it.notes} notes` : null, it.owner && !own ? `owner (${firstName(it.owner, staff)})` : null].filter(Boolean);
        const twin = it.names?.filter((x) => x === who(i)).length > 1;
        const said = parts.length ? `Its ${parts.join(' and its ')} went to ${twin ? whoFull(i) : who(i)}` : `Done`;
        return it.owner && own ? `${said}. ${who(i)} is still looked after by ${firstName(own, staff)}, not ${firstName(it.owner, staff)}` : said;
      };
      return html`<li key=${id} class="card dn-need">
      <p class="dn-need__q">Zeffy split a contact’s gifts between ${plural(it.to.length, 'contact')}${it.names?.some(Boolean) ? `: ${it.to.map((c, i) => who(i)).join(' and ')}` : ''}.</p>
      <p class="dn-need__sub">What was said about it here (an organization, the same person) stayed with the old record. Look at them in Zeffy and say it again on the right one.${it.anon ? ' It was kept anonymous, so each of them is kept anonymous too.' : ''} ${keptWords}</p>
      ${it.to.length ? html`<ul class="dn-plain">${it.to.map((c, i) => html`<li key=${c}>${whoFull(i)} · <a class="link" href=${zeffyContactUrl(c)} target="_blank" rel="noopener" aria-label=${`${whoFull(i)}, in Zeffy`}>In Zeffy</a></li>`)}</ul>` : null}
      <div class="dn-need__do">
        ${kept.length ? it.to.map((c, i) => btn(`${id}:${c}`, `Give them to ${whoFull(i)}`, () => said({ act: 'moved-done', contact: it.contact, to: c }, goes(i))))
          : btn(id, 'Done', () => said({ act: 'moved-done', contact: it.contact }, 'Done'))}</div></li>`;
    }
    return null;
  })}</ul>`;
}

// ─── Pickers ────────────────────────────────────────────────────────

/** A small dialog: a search box and a list to pick from */
function Picker({ title, sub, placeholder, search, onPick, onClose, extra = null }) {
  const box = useRef(null);
  const [openedAt] = useState(() => Date.now());
  const input = useRef(null);
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  const [failed, setFailed] = useState(null);
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  // Closed after the page changed under it (the row that opened it gone): the focus on the page's heading
  useDialog(box, onClose, busy, { returnTo: '.dn-head h2' });
  // Opened: the focus in the search box (the dialog itself takes it first)
  useEffect(() => { input.current?.focus(); }, []);
  // Asked a moment after typing stops, and only the latest answer shows; one that failed says so
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      Promise.resolve().then(() => search(q)).then((l) => { if (live) { setFailed(null); setList(l || []); } }, (e) => { if (live) { setFailed(e?.message || 'The site didn’t answer'); setList([]); } });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, tries]);
  // Refused (gone since, someone answered first): the choices are read again, as they are now
  const pick = async (x) => { setBusy(true); const done = await onPick(x); setBusy(false); if (done !== false) onClose(); else { search.reset?.(); setTries((n) => n + 1); input.current?.focus(); } };
  return html`<div class="modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget && !busy && Date.now() - openedAt > 400) onClose(); }}>
    <div class="modal dn-picker" role="dialog" aria-modal="true" aria-labelledby="dn-pick-h" tabindex="-1" ref=${box}>
      <h3 id="dn-pick-h">${title}</h3>
      ${sub ? html`<p>${sub}</p>` : null}
      <input class="form-input" type="search" ref=${input} placeholder=${placeholder} aria-label=${placeholder} value=${q} onInput=${(e) => setQ(e.target.value)} />
      <ul class="dn-picker__list" aria-label="Choices">${list.length ? list.map((x) => html`<li key=${x.id}><button type="button" class="dn-picker__item" disabled=${x.disabled} aria-disabled=${busy ? 'true' : null} onClick=${() => { if (!busy) pick(x); }}>
        <strong>${x.label}</strong>${x.sub ? html`<span class="dn-sub">${x.sub}</span>` : null}</button></li>`) : failed ? html`<li class="dn-sub dn-picker__none">Couldn’t search just now: ${String(failed).replace(/[.\s]+$/, '').replace(/ Try again.*$/, '')}. <button type="button" class="link dn-linkbtn" onClick=${() => setTries((n) => n + 1)}>Try again</button></li>` : html`<li class="dn-sub dn-picker__none">${!q.trim() ? 'Type a couple of letters' : q.trim().length < 2 ? 'Nothing yet: type another letter' : 'Nothing by that name'}</li>`}</ul>
      ${extra}
      <div class="modal-buttons"><button type="button" class="btn btn-ghost" onClick=${onClose} disabled=${busy}>Cancel</button></div>
    </div></div>`;
}

/** Organizations to link a name to: partners (on the website) and the ones kept here, read from the site once a picker */
function orgChooser(except = null) {
  let all = null;
  // (read again after a pick that was refused: an organization a teammate took out goes from the choices)
  return Object.assign(async (q) => {
    all ||= get('?orgs=1').then((j) => { if (!j.success) throw new Error(j.error); return j.orgs || []; });
    const t = q.trim().toLowerCase();
    let orgs;
    try { orgs = await all; } catch (e) { all = null; throw e; }
    return orgs.filter((o) => o.key !== except && (!t || o.name.toLowerCase().includes(t)))
      .map((o) => ({ id: o.key, label: o.name, sub: o.onSite ? `${o.levelLabel || 'Friend'} partner` : 'Not on the website' })).slice(0, t ? 12 : 8);
  }, { reset: () => { all = null; } });
}

// ─── One donor ──────────────────────────────────────────────────────

const KIT = {
  active: 'Gets the newsletter', inactive: 'On the list, not getting it', cancelled: 'Unsubscribed', bounced: 'Their email bounced', complained: 'Marked it as spam',
};

function GivingTiles({ d }) {
  const most = Math.max(1, ...d.years.map((y) => y.cents));
  return html`<div class="dn-tiles">
      <div class="dn-tile"><span class="dn-tile__label">All time</span><span class=${tileClass(usd(d.total))}>${usd(d.total)}</span><span class="dn-tile__sub">${plural(d.gifts, 'gift')}</span></div>
      <div class="dn-tile"><span class="dn-tile__label">This year</span><span class=${tileClass(usd(d.thisYear))}>${usd(d.thisYear)}</span><span class="dn-tile__sub">Last year ${usd(d.lastYear)}</span></div>
      <div class="dn-tile"><span class="dn-tile__label">Years in a row</span><span class=${tileClass(d.streak)}>${d.streak}</span></div>
      ${d.first ? html`<div class="dn-tile"><span class="dn-tile__label">First gift</span><span class=${tileClass(usd(d.first.cents))}>${usd(d.first.cents)}</span><span class="dn-tile__sub">${day(d.first.at)}</span></div>` : null}
      ${d.latest ? html`<div class="dn-tile"><span class="dn-tile__label">Latest gift</span><span class=${tileClass(usd(d.latest.cents))}>${usd(d.latest.cents)}</span><span class="dn-tile__sub">${day(d.latest.at)}</span></div>` : null}
      ${d.largest ? html`<div class="dn-tile"><span class="dn-tile__label">Largest gift</span><span class=${tileClass(usd(d.largest.cents))}>${usd(d.largest.cents)}</span><span class="dn-tile__sub">${day(d.largest.at)}</span></div>` : null}
      ${d.inKind ? html`<div class="dn-tile"><span class="dn-tile__label">In kind</span><span class=${tileClass(usd(d.inKind))}>${usd(d.inKind)}</span><span class="dn-tile__sub">Not in the totals</span></div>` : null}
    </div>
    ${d.years.length > 1 ? html`<ul class="dn-years" aria-label="Giving by year">${d.years.map((y) => html`<li key=${y.year}><span>${y.year}</span><span class="dn-bar" aria-hidden="true"><span style=${`width:${Math.max(2, Math.round((y.cents / most) * 100))}%`}></span></span><span>${usd(y.cents)}</span></li>`)}</ul>` : null}`;
}

/** Thanked or Not needed by mistake, found later: To thank again, from the gift (the toast's Undo lasts seconds) */
const againNow = new Set();
async function thankAgain(ctx, t) {
  if (againNow.has(t.id)) return;
  againNow.add(t.id);
  try {
    const r = await change({ act: 'thanks', id: t.id, state: 'todo', was: t.state });
    if (r.success) { listChanged(); thanksChanged(); }
    if (!r.success) { ctx.addToast(r.error, 'error'); return; }
    if (r.same && !(r.retried && r.you)) { ctx.addToast(`To thank already${r.you ? ', by you' : r.by ? `, said by ${r.by.split('@')[0].replace(/^./, (c) => c.toUpperCase())}` : ''}`, 'info'); return; }
    ctx.addToast(`To thank again: ${amountOf(t)}`, 'success');
    await focusWhenBack(t.id);
  } finally { againNow.delete(t.id); }
}
/** Who on the team looks after a donor */
// Each page's owner, saved one pick at a time, by the page's key: kept apart from the card, so the card drawn again (the
// window made narrower or wider) or gone (Back, another page) leaves the queue as it is. `shown`: the owner as last
// read (the next pick's `was`), `saving`: the pick out now, `next`: one picked meanwhile, `picked`: one not saved yet,
// `card`: the card on the page now (its state to set), `say`: the words and toasts of the last card
const owners = new Map();
const ownerQ = (subject) => { if (!owners.has(subject)) owners.set(subject, { shown: null, saving: null, next: null, picked: null, card: null, say: null }); return owners.get(subject); };
async function saveOwner(subject, email) {
  const q = ownerQ(subject);
  // One at a time: a pick while one saves goes once that's saved and the page read again
  if (q.saving !== null) { q.next = email; return; }
  if (email === (q.shown || '')) { if (q.picked === email) q.picked = null; q.card?.setPicked((p) => (p === email ? null : p)); return; }
  q.saving = email;
  const startedOn = q.card;
  startedOn?.setBusy(true);
  let r = await change({ act: 'owner', key: subject, email, was: q.shown || '' });
  const { ctx, staff, name, onDone, peek } = q.say;
  // (its answers lost: the page as it is now says whether it saved; the card gone, read straight from the site)
  let read = null;
  if (!r.success && lostAnswer(r)) {
    read = q.card ? await (q.card.onDone || onDone)() : await peek?.();
    if (read && read.success !== false && 'owner' in read && (read.owner || '') === email) r = { success: true, retried: true };
  }
  // (the card gone meanwhile: the answer is still said, naming whose it was)
  if (!r.success) ctx.addToast(q.card ? r.error : lostAnswer(r) ? `Who looks after ${name} may not have changed: ${r.error}` : `Who looks after ${name} wasn’t changed: ${r.error}`, 'error');
  else {
    q.shown = email;
    listChanged();
    if (!r.same || r.retried) ctx.addToast(email ? `${fullName(email, staff)} looks after ${name} now` : `No one looks after ${name} now`, 'success');
  }
  if (q.picked === email) q.picked = null;
  // (no card: whatever shows now, the list or another page, reads again)
  if (!q.card) thanksChanged();
  // Refused, or the answers lost (it may have saved): the page read again says who it is now, the next pick's `was`
  const j = read || await (q.card?.onDone || onDone)();
  if (j && j.success !== false && 'owner' in j) q.shown = j.owner || '';
  q.saving = null;
  startedOn?.setBusy(false);
  q.card?.setBusy(false);
  const then = q.next;
  q.next = null;
  if (then !== null && then !== email) { saveOwner(subject, then); return; }
  if (q.picked === null) q.card?.setPicked(null);
}
function OwnerCard({ subject, owner, staff = [], name, ctx, onDone, peek = null }) {
  const q = ownerQ(subject);
  const [busy, setBusy] = useState(() => q.saving !== null);
  // The one picked, shown until it's saved (a re-read meanwhile never puts the select back under the person; a card
  // drawn again shows it too)
  const [picked, setPicked] = useState(() => q.picked);
  // (as last read, when nothing of this page's is out: a save's own read moves it on)
  if (q.saving === null) q.shown = owner || '';
  q.say = { ctx, staff, name, onDone, peek };
  useEffect(() => {
    const card = { setPicked, setBusy, onDone };
    q.card = card;
    return () => { if (q.card === card) q.card = null; };
  }, [subject, onDone]);
  // (saved by a card before this one, drawn again: the page read again shows it, so the pick needn't)
  useEffect(() => { if (picked !== null && (owner || '') === picked && q.picked === null && q.saving === null) setPicked(null); }, [owner]);
  // Saved a moment after the pick settles, or when the select is left: arrowing through a closed select (Windows
  // changes it at each press) saves only the one landed on, never an owner and a History line per name passed
  const wait = useRef(null);
  const waiting = useRef(null);
  useEffect(() => {
    // The tab closed or reloaded with a pick still to send (waiting, or behind one saving): sent as it goes (the one
    // saving is on its way already: changes go with keepalive)
    const send = () => {
      const email = waiting.current ?? q.next;
      if (email === null) return;
      clearTimeout(wait.current);
      wait.current = null;
      waiting.current = null;
      q.next = null;
      // (behind one still on its way: either owner is what the person last chose from, whichever lands first)
      const was = q.saving !== null ? [q.saving, q.shown || ''] : q.shown || '';
      if (email === (q.saving ?? (q.shown || ''))) return;
      try { fetch('/api/donors-admin', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ act: 'owner', key: subject, email, was }) }); } catch { /* sent as far as the browser lets it */ }
    };
    window.addEventListener('pagehide', send);
    return () => {
      window.removeEventListener('pagehide', send);
      // The card gone (another page, Back, the window narrower), or the page now another key, with a pick still
      // waiting: saved now, its answer said
      if (wait.current && waiting.current !== null) { clearTimeout(wait.current); const email = waiting.current; waiting.current = null; wait.current = null; saveOwner(subject, email); }
    };
  }, [subject]);
  const save = (email) => { wait.current = null; waiting.current = null; saveOwner(subject, email); };
  const pick = (e) => {
    const email = e.target.value;
    setPicked(email);
    q.picked = email;
    clearTimeout(wait.current);
    waiting.current = email;
    wait.current = setTimeout(() => save(email), 700);
  };
  const settle = () => { if (wait.current && picked !== null) { clearTimeout(wait.current); save(picked); } };
  const left = owner && staff.find((s) => s.email === owner)?.left;
  return html`<section class="kd-card dn-card--owner" aria-labelledby="dn-owner-h">
    <h3 id="dn-owner-h">Owner</h3>
    <select id="dn-owner-pick" class="form-select" aria-label=${`Who on the team looks after ${name}`} value=${picked ?? owner ?? ''} aria-busy=${busy ? 'true' : null} onChange=${pick} onBlur=${settle}>
      <option value="">No one yet</option>
      ${staff.map((s) => html`<option key=${s.email} value=${s.email}>${s.name}${s.left ? ' (left the team)' : ''}</option>`)}
    </select>
    <p class="kd-card__note">${left ? `${fullName(owner, staff)} is no longer on the team: pick who looks after them now.` : 'The one on the team who looks after them: thanks them, keeps in touch and keeps the notes up to date.'}</p>
  </section>`;
}

/** The gifts on this page still to thank, at the top where they can't be missed */
function ThankBox({ gifts, name, ctx }) {
  const [busy, setBusy] = useState(null);
  // Said here: gone from the box at once, until the page reads again (never pressed twice while the read comes)
  const [said, setSaid] = useState(() => new Set());
  useEffect(() => { setSaid(new Set()); }, [gifts]);
  // Every thank-you still to do, each its own (a gift can hold a thanked part and a later part to thank)
  const seen = new Set();
  const todo = gifts.flatMap((g) => (g.thanksAll || (g.thanks ? [g.thanks] : [])).filter((t) => t.state === 'todo' && !said.has(t.id) && !seen.has(t.id) && seen.add(t.id)).map((t) => ({ ...g, id: `${g.id}:${t.id}`, thanks: t })));
  // The last one said: the box goes, the focus to the donor's name
  const refocus = useRefocus('.dn-thank__list', true, '.dn-head h2');
  if (!todo.length) return null;
  const doIt = async (g, state, e) => {
    refocus(e.currentTarget);
    setBusy(`${g.id}:${state}`);
    const ok = await sayThanks(ctx, { id: g.thanks.id, cents: g.thanks.cents ?? g.cents, inKind: g.thanks.inKind ?? g.inKind, why: g.thanks.why, name: g.by || name }, state);
    if (ok) setSaid((x) => new Set(x).add(g.thanks.id));
    setBusy(null);
  };
  return html`<section class="card kd-sec dn-thank" aria-labelledby="dn-thank-h">
    <header class="kd-sec__head"><h3 id="dn-thank-h">To thank <span class="count">${todo.length}</span></h3></header>
    <ul class="dn-thank__list">${todo.map((g) => html`<li key=${g.id} class="dn-thank__one" data-thank=${g.thanks.id}>
      <span><strong>${amountOf({ cents: g.thanks.cents ?? g.cents, inKind: g.thanks.inKind ?? g.inKind, thanks: g.thanks })}</strong> · ${[g.campaign || 'A gift', g.thanks.how || g.how, day(g.at), g.by ? `from ${g.by}` : null, g.thanks.ids && g.ids?.length > 1 && !g.thanks.ids.includes(g.ids[0]) ? 'the part given later' : null].filter(Boolean).join(' · ')}</span>
      <span class="dn-sub">${g.thanks.whyText}.</span>
      <span class="dn-row-do">
        <button type="button" class="btn btn-primary btn-sm" aria-label=${`Thanked: ${amountOf({ cents: g.thanks.cents ?? g.cents, inKind: g.thanks.inKind ?? g.inKind, thanks: g.thanks })}, ${day(g.at)}`} aria-disabled=${busy ? 'true' : null} onClick=${(e) => { if (!busy) doIt(g, 'thanked', e); }}>${busy === `${g.id}:thanked` ? html`<span class="spinner spinner-14" />` : null}Thanked</button>
        <button type="button" class="btn btn-ghost btn-sm" aria-label=${`Not needed: ${amountOf({ cents: g.thanks.cents ?? g.cents, inKind: g.thanks.inKind ?? g.inKind, thanks: g.thanks })}, ${day(g.at)}`} aria-disabled=${busy ? 'true' : null} onClick=${(e) => { if (!busy) doIt(g, 'skipped', e); }}>${busy === `${g.id}:skipped` ? html`<span class="spinner spinner-14" />` : null}Not needed</button>
      </span></li>`)}</ul>
    <p class="kd-card__note">Zeffy thanks online givers by email. These it doesn’t, or they’re big enough for a call or a note from the team.</p>
  </section>`;
}

/** Keep anonymous: on a person or an organization */
function KeepAnonymous({ subject, on, why = null, names = [], name, ctx, onDone, onSite = false }) {
  const [busy, setBusy] = useState(false);
  // Saved: shown so at once, until the page's own read says it (never snapping back while it reads)
  const [saved, setSaved] = useState(null);
  useEffect(() => { setSaved(null); }, [on]);
  const isOn = saved ?? on;
  // Kept because someone kept shares their email (a Zeffy duplicate, or a spouse): said so, and freed by "not the same"
  const shared = why?.kind === 'shared' || why?.kind === 'name';
  const notSame = async () => {
    const twin = name === why.otherName;
    if (!(await ask({ title: twin ? `Two records named ${name}: not the same person?` : `${name} and ${why.otherName}: not the same person?`, text: twin ? `They share ${why.kind === 'name' ? 'a name' : 'an email'} in Zeffy. The other one is kept anonymous; said not to be the same person, this one isn’t, and the two show as separate donors.` : `They share ${why.kind === 'name' ? 'a name' : 'an email'} in Zeffy. ${why.otherName} is kept anonymous; said not to be the same person, ${name} isn’t, and the two show as separate donors.`, yes: 'Not the same person' }))) return;
    setBusy(true);
    const r = await change({ act: 'same', a: subject, b: why.other, same: false });
    setBusy(false);
    if (!r.success) { ctx.addToast(r.error, 'error'); return; }
    listChanged();
    ctx.addToast(name === why.otherName ? `The two records named ${name} are separate donors now` : `${name} and ${why.otherName} are separate donors now`, 'success');
    onDone();
  };
  const flip = async (e) => {
    const next = e.target.checked;
    if (busy) { e.target.checked = !next; return; }
    setBusy(true);
    let r = await change({ act: 'anon', key: subject, on: next, name });
    // (its answers lost: the page read again says whether it saved)
    if (!r.success && lostAnswer(r)) { const j = await onDone(); if (j && j.success !== false && 'keepAnonymous' in j && (!!j.keepAnonymous === next || (!next && j.keptWhy))) r = { success: true, still: !!(!next && j.keptWhy) }; }
    setBusy(false);
    // Refused, or the answer lost on the way back and not saved: the page reads again, so the box shows what's so
    if (!r.success) { ctx.addToast(r.error, 'error'); e.target.checked = !next; setSaved(null); onDone(); return; }
    setSaved(next);
    listChanged();
    ctx.addToast(next ? `${name} is kept anonymous` : r.still ? `${name}’s own Keep anonymous is off, but they’re still kept anonymous: they share a name or email with someone who is` : `${name} is no longer kept anonymous`, r.still ? 'info' : 'success');
    // The page read again shows what's so (still kept by someone else's setting): the box follows it
    await onDone();
    setSaved(null);
  };
  return html`<section class="kd-card dn-card--late" aria-labelledby="dn-anon-h">
    <h3 id="dn-anon-h">Anonymous</h3>
    <label class="dn-check"><input type="checkbox" checked=${isOn} disabled=${shared} aria-busy=${busy ? 'true' : null} onChange=${flip} /> Keep anonymous</label>
    ${shared ? html`<p class="kd-card__note">Because they share ${why.kind === 'name' ? 'a name' : 'an email'} in Zeffy with ${why.otherName}, who is kept anonymous. <button type="button" class="link dn-linkbtn" disabled=${busy} onClick=${notSame}>Not the same person</button></p>`
      : why?.kind === 'email' ? html`<p class="kd-card__note">Kept by their email from before Zeffy had a contact for them.</p>` : null}
    <p class="kd-card__note">${onSite ? 'Its name stays off the board’s list of gifts. It’s on the Partners page already: Keep anonymous doesn’t take it off.' : 'Their name stays off the board’s list of gifts, and the site never suggests them for the Partners page.'}</p>
    ${isOn && names.length > 1 ? html`<p class="kd-card__note">Gifts under any name it has had are hidden too: ${names.join(', ')}.</p>` : null}
  </section>`;
}

/** Whether a page's layout is two columns (its shell 1000px or wider, as the shared layout's container query) */
function useWide(el, at = 1000) {
  const [wide, setWide] = useState(() => (typeof window !== 'undefined' ? window.innerWidth - 300 >= at : true));
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const next = e.contentRect.width >= at;
      setWide((was) => {
        if (was === next) return was;
        // The cards move between columns: what had the focus (a note being typed) keeps it, and its place in the words
        const a = document.activeElement;
        const sel = a && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
        // (a side card is drawn again in its new column: found again by its id, or its card and its place in it)
        const card = a?.closest?.('section[aria-labelledby]');
        const where = a && a !== document.body ? { id: a.id || null, card: card?.getAttribute('aria-labelledby') || null, i: card ? [...card.querySelectorAll('button, a[href], select, input, textarea')].indexOf(a) : -1 } : null;
        if (where) requestAnimationFrame(() => {
          if (a.isConnected && document.activeElement === a) return;
          const el = a.isConnected ? a : (where.id && document.getElementById(where.id))
            || (where.card && where.i >= 0 && document.querySelector(`section[aria-labelledby="${CSS.escape(where.card)}"]`)?.querySelectorAll('button, a[href], select, input, textarea')[where.i]);
          if (!el) return;
          el.focus({ preventScroll: true });
          if (sel) try { el.setSelectionRange(...sel); } catch { /* not a text box */ }
        });
        return next;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return wide;
}

function DonorPage({ donor, gift, fromList = false, ctx, onBack, backLabel = 'Donors', onDonor, onOrg }) {
  const [shell, setShell] = useState(null);
  const wide = useWide(shell);
  const shownKey = useRef(null);
  const [v, setV] = useState(null);
  const [rowBusy, setRowBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [gone, setGone] = useState(null);
  const [picking, setPicking] = useState(null);
  const [joining, setJoining] = useState(false);
  // Only the latest read lands (a quick move to another donor never shows the one before)
  const seq = useRef(0);
  // Left (another donor, the list, another area): a read or a change still out lands nowhere, and moves no one
  const left = useRef(false);
  useEffect(() => () => { left.current = true; seq.current++; }, []);
  // `follow`: read after the person's own change (Count it for an organization): it goes where they went, kept until
  // a read shows the page (a newer read taking its place follows too)
  const wantFollow = useRef(false);
  const load = useReads(async ({ follow: asked = false } = {}) => {
    if (asked) wantFollow.current = true;
    const mine = ++seq.current;
    const fresh = () => mine === seq.current;
    setErr(null);
    let ref = donor;
    if (!ref && gift) {
      const g = await get(`?gift=${encodeURIComponent(gift)}`);
      if (!fresh()) return TAKEN;
      if (!g.success) { setErr({ text: g.error, final: g.status === 404 }); return; }
      // A gift that counts for an organization opens the organization
      if (g.org) { onOrg(g.org); return; }
      ref = g.ref;
      // A Zeffy contact has an address of its own; a donor with none stays at their gift's
      if (!ref.startsWith('g:')) { onDonor(ref); return; }
    }
    const j = await get(`?donor=${encodeURIComponent(ref)}`);
    if (!fresh()) return TAKEN;
    const follow = wantFollow.current;
    wantFollow.current = false;
    if (!j.success && shown.current && j.status !== 404) { ctx.addToast(`The page couldn’t be read again just now: ${j.error} It shows what was read before.`, 'error', { label: 'Try again', fn: () => load() }); return j; }
    // Gone since it was read (taken out, merged, by a teammate): the page stays as it was, so nothing typed is lost
    if (!j.success && shown.current) { setGone({ text: j.error }); return j; }
    if (!j.success) { setErr({ text: j.error, final: j.status === 404 }); return j; }
    // (shown already, not by this person's change: the page stays, so nothing typed is lost, and says where they are)
    // (a Zeffy record merged into another since: its address opens that one, the words being written with it)
    // (the next read moves them, to the key that page is under)
    if (j.moved) { if (!shownKey.current && !String(ref).startsWith('g:')) shownKey.current = `c:${String(ref).replace(/^c:/, '')}`; if (follow) wantFollow.current = true; onDonor(j.moved); return j; }
    if (j.org && shown.current && follow !== true) { setGone({ text: 'Their gifts count for an organization now: they were linked to it since this page was read.', org: j.org }); return j; }
    // (its page is the organization's now: what was being written at this address goes there, read before or not)
    if (j.org) { moveDraft(shownKey.current || (String(ref).startsWith('g:') ? null : `c:${String(ref).replace(/^c:/, '')}`), j.org); onOrg(j.org); return j; }
    // (joined under another lead since: the words being written go with the page)
    if (shownKey.current && j.key && j.key !== shownKey.current) moveDraft(shownKey.current, j.key);
    // First read: words being written on any record that's part of this person now (typed on its own page before it
    // was joined to them, or at the address opened) come to their page
    if (!shownKey.current && j.key) for (const k of new Set([String(ref).startsWith('g:') ? null : `c:${String(ref).replace(/^c:/, '')}`, j.shownAs, ...(j.also || []).map((x) => x.key), ...(j.formerly || [])])) if (k && k !== j.key) moveDraft(k, j.key);
    shownKey.current = j.key;
    setGone(null);
    setV(j);
    thanksRead();
    return j;
  });
  useEffect(() => { setV(null); load(); }, [donor, gift]);
  // A thank-you said elsewhere (a toast's Undo from another page): this page as it is now
  useThanksSaid(() => { if (v) load(); });
  const shown = useRef(false);
  shown.current = !!v;
  // Opened: the focus on the donor's name, so a screen reader says whose page this is; after a change re-draws the
  // page and takes away what had the focus (a record split off, a name taken off), there again
  const heading = useRef(null);
  useEffect(() => { if (v) heading.current?.focus({ preventScroll: true }); }, [!!v]);
  useEffect(() => { if (v && (!document.activeElement || document.activeElement === document.body)) heading.current?.focus({ preventScroll: true }); }, [v]);
  // A gift opened from a link (Slack): in view, marked a moment, once (a change on the page later never jumps back to
  // it). Opened from the list, the page starts at the top
  const flashed = useRef(null);
  useEffect(() => {
    // (opened from To thank or Needs you: the page from the top, its To thank box first)
    if (!v || !gift || fromList || backTo || flashed.current === gift) return;
    const el = document.querySelector(`[data-gifts~="${CSS.escape(gift)}"]`);
    if (!el) return;
    flashed.current = gift;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('is-flash');
    // Not tied to this effect: a change on the page meanwhile (a note, an owner) never leaves the mark on for good
    setTimeout(() => el.classList.remove('is-flash'), 2400);
  }, [v, gift]);
  const back = html`<button type="button" class="dn-back" onClick=${onBack}>← ${backLabel}</button>`;
  // (an address that leads nowhere: the focus on Back, never left on the page)
  if (err) return html`${back}<div class="notice notice--danger" role="alert" ref=${(el) => { if (el && err.final && (!document.activeElement || document.activeElement === document.body)) document.querySelector('.dn-back')?.focus(); }}><div class="notice__body">${err.text}</div>${err.final ? null : html`<div class="notice__actions"><button class="btn btn-ghost" onClick=${load}>Try again</button></div>`}</div>`;
  if (!v) return html`${back}<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;
  const d = v.donor;
  // One of the company row's answers at a time (a second press while the first saves does nothing)
  const once = async (fn) => { if (rowBusy) return; setRowBusy(true); try { await fn(); } finally { setRowBusy(false); } };
  const linkTo = async (link, orgKey, orgName, asked = false) => {
    // (a contact counted for an organization: this page goes to it, so a note being written asks first)
    // A Zeffy contact: every record of theirs (a person joined from several counts whole)
    const subjects = link.kind === 'contact' ? [...new Set([v.key, ...(v.also || []).map((a) => a.key)].filter((k) => k.startsWith('c:')).map((k) => k.slice(2)))] : [link.subject];
    // (all of them in one step: never some linked and some not)
    let r = await change({ act: 'link', kind: link.kind, subject: subjects[0], subjects, org: orgKey, ...(asked ? { asked: true } : {}) });
    if (!r.success) {
      // Refused: said, and the page as it is now. Its answers lost: the page read again says whether it saved (its gifts
      // count for that organization now: it did, and the page goes there as it would have)
      if (!lostAnswer(r)) { ctx.addToast(r.error, 'error'); await load(); return false; }
      const now = await get(`?donor=${encodeURIComponent(donor || v.ref || '')}`);
      if (!(link.kind === 'contact' && now.success && (now.org === orgKey || (now.links && subjects.every((c) => now.links[c] === orgKey))))) { ctx.addToast(r.error, 'error'); await load(); return false; }
      // (it saved: as it would have, the page goes where they count now)
      r = { success: true };
    }
    listChanged();
    // (a record Zeffy merged into someone else's since: theirs counts too, and it says whose)
    ctx.addToast(`${link.kind === 'company' ? `Gifts for ${link.subject}` : `${d.name}’s gifts`} count for ${orgName} now${r.followed && r.followed !== d.name ? `, with ${r.followed}’s: Zeffy made their records one` : ''}`, 'success', { label: 'Open', fn: () => goTo({ tab: 'people', org: orgKey }) });
    if (r.success) await load({ follow: true });
    return true;
  };
  // Read in the order it shows: two columns, the page then the side; one column, the first cards, the page, then the rest
  const early = html`
        <section class="kd-card kd-card--status" aria-labelledby="dn-stage-h">
          <h3 id="dn-stage-h">Stage</h3>
          <p>${stageTag(d.stage)}</p>
          <p class="kd-card__note">${STAGES[d.stage]?.what}</p>
        </section>
        <${OwnerCard} subject=${v.key} owner=${v.owner} staff=${v.staff} name=${d.name === 'No name' ? 'this giver' : d.name} ctx=${ctx} onDone=${load} peek=${() => get(`?donor=${encodeURIComponent(v.ref)}`)} />
  `;
  const late = html`
        <section class="kd-card kd-card--health dn-card--zeffy" aria-labelledby="dn-zeffy-h">
          <h3 id="dn-zeffy-h">In Zeffy</h3>
          <dl class="dn-facts">
            ${d.email ? html`<div><dt>Email</dt><dd>${d.email}</dd></div>` : null}
            <div><dt>Newsletter</dt><dd>${!d.email ? 'No email in Zeffy' : !v.kit ? 'Kit isn’t connected' : v.kit.error ? 'Kit didn’t answer' : v.kit.none ? 'Not on the list' : KIT[v.kit.state] || v.kit.state}</dd></div>
          </dl>
          ${d.contact ? html`<p style="margin:.75rem 0 0"><a class="btn btn-ghost btn-sm" href=${zeffyContactUrl(d.contact)} target="_blank" rel="noopener">Open in Zeffy</a></p>
            <p class="kd-card__note">Their name, email and address are changed in Zeffy.</p>` : html`<p class="kd-card__note">Zeffy has no contact for these gifts, only the name on each.</p>`}
          ${/^[cen]:/.test(v.key) ? html`<p class="kd-card__note">In Zeffy twice? <button type="button" class="link dn-linkbtn" onClick=${() => setJoining(true)}>Same person as another donor…</button></p>` : null}
          ${v.also?.length ? html`<p class="kd-card__note">Also in Zeffy as:</p><ul class="dn-plain">${v.also.map((a, i) => html`<li key=${a.key}>
            ${a.ref ? html`<a class="link" href=${zeffyContactUrl(a.ref)} target="_blank" rel="noopener">Record ${i + 2} in Zeffy</a>` : html`<span>Record ${i + 2}, with no Zeffy contact</span>`}
            <button type="button" class="link dn-linkbtn" onClick=${async () => {
              if (!(await ask({ title: 'Not the same person?', text: `Record ${i + 2} becomes a donor of its own, with its own gifts, and won’t be asked about again. ${d.name}’s other records stay together.`, yes: 'Not the same' }))) return;
              let r = await change({ act: 'split', key: a.key, others: [v.key, ...(v.also || []).map((x) => x.key)].filter((k) => k !== a.key) });
              // (its answers lost: the record as it is now says whether it was taken out; the person goes on with their
              // other records)
              if (!r.success && lostAnswer(r) && a.ref) {
                const others = [v.key, ...(v.also || []).map((x) => x.key)].filter((k) => k !== a.key);
                const it = await get(`?donor=${encodeURIComponent(a.ref)}`);
                if (it.success && it.key && !others.includes(it.key) && !(it.also || []).some((x) => others.includes(x.key))) r = { success: true, ref: others.find((k) => k.startsWith('c:'))?.slice(2) || null };
              }
              if (!r.success) { ctx.addToast(r.error, 'error'); return; }
              listChanged();
              ctx.addToast(`Record ${i + 2} is a donor of its own now`, 'success');
              if (left.current) return;
              // This page stays with the person (the record split off may be the address it was opened at)
              if (r.ref && r.ref !== donor) onDonor(r.ref); else await load();
            }}>Not the same person</button></li>`)}</ul>` : null}
        </section>
        <${SignalsCard} refOf=${v.ref} name=${d.name} />
        <${KeepAnonymous} subject=${v.key} on=${!!v.keepAnonymous} why=${v.keptWhy} name=${d.name} ctx=${ctx} onDone=${load} />
        <section class="kd-card dn-card--late" aria-labelledby="dn-orgs-h">
          <h3 id="dn-orgs-h">Organizations</h3>
          ${v.gaveFor?.length ? html`<ul class="dn-plain">${v.gaveFor.map((o) => html`<li key=${o.key}><span>Gave ${usd(o.cents)} for <a class="link" href=${`#donors/org/${encodeURIComponent(o.key)}`}>${o.name}</a></span><span class="dn-sub">${plural(o.gifts, 'gift')}, counted for them</span></li>`)}</ul>` : null}
          ${v.companies?.length ? html`<ul class="dn-plain">${v.companies.map((c) => html`<li key=${c.name}>Gave ${usd(c.cents)} for ${c.name}
            <span class="dn-sub">Counted as ${d.name}’s until it’s linked</span>
            <span class="dn-row-do">
              ${c.near ? html`<button type="button" class="btn btn-ghost btn-sm" aria-disabled=${rowBusy ? 'true' : null} onClick=${() => once(() => linkTo({ kind: 'company', subject: c.name }, c.near.key, c.near.name, true))}>It’s ${c.near.name}</button>` : null}
              <button type="button" class="btn btn-ghost btn-sm" onClick=${() => setPicking({ kind: 'company', subject: c.name, label: c.name })}>Link to…</button>
              <button type="button" class="btn btn-ghost btn-sm" aria-disabled=${rowBusy ? 'true' : null} onClick=${() => once(async () => { await keepAsOrg(c.name, { kind: 'company', subject: c.name }, ctx); await load(); })}>Keep as an organization</button>
            </span></li>`)}</ul>` : null}
          ${!v.gaveFor?.length && !v.companies?.length ? html`<p class="kd-card__note">None. When they give for a company, it shows here.</p>` : null}
          ${d.contact ? html`<p class="kd-card__note">Is this an organization’s own record in Zeffy? <button type="button" class="link dn-linkbtn" onClick=${() => setPicking({ kind: 'contact', subject: d.contact, label: d.name })}>Count it for an organization…</button></p>` : null}
        </section>
  `;
  const main = html`
      <div class="kd-main" key="main" style="display:grid;gap:1rem">
        <${ThankBox} gifts=${v.gifts} name=${d.name} ctx=${ctx} />
        <section class="card kd-sec" aria-labelledby="dn-giving-h">
          <header class="kd-sec__head"><h3 id="dn-giving-h">Giving</h3></header>
          <${GivingTiles} d=${d} />
        </section>
        <${Timeline} key=${v.key} subject=${v.key} keys=${[v.key, v.shownAs, ...(v.also || []).map((x) => x.key), ...(v.formerly || [])].filter(Boolean)} refOf=${v.ref} name=${d.name === 'No name' ? 'this giver' : d.name} gifts=${v.gifts} notes=${v.notes} staff=${v.staff} zeffy=${!!d.contact} ctx=${ctx} onChanged=${load} focusGift=${gift || null} thankAgain=${(th) => thankAgain(ctx, th)} />
      </div>
  `;
  return html`
    ${back}
    ${gone ? html`<div class="notice notice--warn" role="alert"><div class="notice__body"><strong>${gone.text}</strong> This page shows it as it was: copy anything you typed here${gone.org ? ', then open where it is now.' : ', then go back.'}</div>${gone.org ? html`<div class="notice__actions"><button type="button" class="btn btn-ghost btn-sm" onClick=${() => goTo({ tab: 'people', org: gone.org })}>Open it</button></div>` : null}</div>` : null}
    <div class="dn-head">
      <h2 tabindex="-1" ref=${heading}>${d.name === 'No name' ? 'A giver Zeffy has no name for' : d.name} ${stageTag(d.stage)}${v.keepAnonymous ? html`<span class="tag">Kept anonymous</span>` : d.anonymous ? html`<span class="tag">Asked to be anonymous</span>` : null}</h2>
      <p class="dn-head__sub">${[d.funds.length ? `Through ${d.funds.join(', ')}` : null, d.email].filter(Boolean).join(' · ')}</p>
    </div>
    <div class="kd-shell" ref=${setShell}><div class="kd-layout">
      ${wide ? [main, html`<aside class="kd-rail" key="rail" aria-label="Donor at a glance">${early}${late}</aside>`]
        : [html`<aside class="kd-rail" key="rail" aria-label="Donor at a glance">${early}</aside>`, main, html`<aside class="kd-rail" key="more" aria-label="More about this donor">${late}</aside>`]}
    </div></div>
    ${picking ? html`<${Picker} title=${picking.kind === 'company' ? `Which organization is “${picking.label}”?` : `Which organization is ${picking.label}?`}
      sub=${picking.kind === 'company' ? 'Every gift given for that name counts for it, from anyone.' : 'Every gift from this Zeffy contact counts for it.'}
      placeholder="Organization name" search=${picking.search ||= orgChooser()}
      onPick=${(o) => linkTo({ kind: picking.kind, subject: picking.subject }, o.id, o.label)} onClose=${() => setPicking(null)} />` : null}
    ${joining ? html`<${Picker} title=${`Who else is ${d.name}?`} sub="Pick their other record: it shows as one donor here, with all their gifts. Zeffy keeps both until someone merges them there."
      placeholder="Name or email in Zeffy" onClose=${() => setJoining(false)}
      search=${async (q) => {
        if (q.trim().length < 2) return [];
        const j = await call('', { findPeople: q.trim(), except: v.key });
        if (!j.success) throw new Error(j.error);
        return (j.people || []).map((p) => ({ id: p.key, label: p.name, sub: [p.email, `${plural(p.gifts, 'gift')}, ${usd(p.cents)}`].filter(Boolean).join(' · ') }));
      }}
      onPick=${async (p) => {
        const r = await change({ act: 'same', a: v.key, b: p.id, same: true });
        const joined = !r.success && lostAnswer(r) && await (async () => {
          const j = await get(`?donor=${encodeURIComponent(donor || v.ref || '')}`);
          return [j.key, j.shownAs, ...(j.also || []).map((a) => a.key)].includes(p.id);
        })();
        if (!r.success && !joined) { ctx.addToast(r.error, 'error'); return false; }
        listChanged();
        ctx.addToast(d.name === p.label ? `The two records named ${d.name} are one donor now` : `${d.name} and ${p.label} are one donor now`, 'success');
        await load();
        return true;
      }} />` : null}`;
}

// ─── One organization ───────────────────────────────────────────────

// (one Put it on the website at a time: a double click asks once)
let puttingOnSite = false;
function OrgPage({ orgKey, gift = null, ctx, onBack, backLabel = 'Donors' }) {
  const [shell, setShell] = useState(null);
  const wide = useWide(shell);
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [gone, setGone] = useState(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const left = useRef(false);
  useEffect(() => () => { left.current = true; seq.current++; }, []);
  const wantFollow = useRef(false);
  // The page as last read (what a change's own read shows: a rename refused shows the name it has now)
  const lastRead = useRef(null);
  const load = useReads(async ({ follow: asked = false } = {}) => {
    if (asked) wantFollow.current = true;
    const mine = ++seq.current;
    setErr(null);
    const j = await get(`?org=${encodeURIComponent(orgKey)}`);
    if (mine !== seq.current) return TAKEN;
    const followIt = wantFollow.current;
    wantFollow.current = false;
    if (!j.success && shown.current && j.status !== 404) { ctx.addToast(`The page couldn’t be read again just now: ${j.error} It shows what was read before.`, 'error', { label: 'Try again', fn: () => load() }); return j; }
    // Gone since it was read (taken out, merged, by a teammate): the page stays as it was, so nothing typed is lost.
    // Taken out with a Zeffy record it was made from: what was said about it went back there, and a note being written
    // here goes there too. With none: the words are shown, to copy, never lost unseen
    const back = j.back ? { key: j.back, ref: j.backRef } : null;
    if (!j.success && back) moveDraft(orgKey, back.key);
    if (!j.success && shown.current) { setGone({ text: j.error, back }); return j; }
    if (!j.success) { setErr({ text: j.error, final: j.status === 404, back, words: back ? '' : [String(draftOf(draftKey(orgKey, 'new'))?.text || '').trim(), ...editDrafts().filter((d) => d.subject === orgKey).map((d) => String(d.draft || '').trim())].filter(Boolean).join('\n\n') }); return j; }
    // Kept here before, on the website now: its partner's page, at its address
    if (j.org && !j.donor && shown.current && followIt !== true) { setGone({ text: 'It’s on the website now: it was put there since this page was read.', org: j.org }); return j; }
    if (j.org && !j.donor) { moveDraft(orgKey, j.org); history.replaceState(null, '', `#donors/org/${encodeURIComponent(j.org)}`); ctx.open({ tab: 'people', org: j.org }); return j; }
    // First read: words being written on a Zeffy contact's own page before it was counted for this organization come here
    // (only a contact whose own page this is now: a person who keeps a page of their own keeps their words there)
    if (!shown.current && j.key) for (const n of j.names || []) if (n.kind === 'contact' && n.alone) moveDraft(`c:${n.subject}`, j.key);
    setGone(null);
    lastRead.current = j;
    setV(j);
    thanksRead();
    return j;
  });
  useEffect(() => { setV(null); load(); }, [orgKey]);
  useThanksSaid(() => { if (v) load(); });
  const shown = useRef(false);
  shown.current = !!v;
  const heading = useRef(null);
  useEffect(() => { if (v) heading.current?.focus({ preventScroll: true }); }, [!!v]);
  useEffect(() => { if (v && (!document.activeElement || document.activeElement === document.body)) heading.current?.focus({ preventScroll: true }); }, [v]);
  // Opened from a gift's link (the Slack "Major gift" post) that counts for this organization: that gift, marked, once
  const flashed = useRef(null);
  useEffect(() => {
    if (!v || !gift || flashed.current === gift) return;
    const el = document.querySelector(`[data-gifts~="${CSS.escape(gift)}"]`);
    if (!el) return;
    flashed.current = gift;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('is-flash');
    setTimeout(() => el.classList.remove('is-flash'), 2400);
  }, [v, gift]);
  const back = html`<button type="button" class="dn-back" onClick=${onBack}>← ${backLabel}</button>`;
  // (an address that leads nowhere: the focus on Back, never left on the page)
  const copyWords = (words) => { try { navigator.clipboard?.writeText(words).then(() => ctx.addToast('Copied', 'success'), () => {}); } catch { /* the words show, to select */ } };
  if (err) return html`${back}<div class="notice notice--danger" role="alert" ref=${(el) => { if (el && err.final && (!document.activeElement || document.activeElement === document.body)) document.querySelector('.dn-back')?.focus(); }}><div class="notice__body">${err.text}${err.back ? ' What was said about it went back to the Zeffy record it was made from, a note being written here too.' : ''}
      ${err.words ? html`<p class="dn-sub" style="margin:.5rem 0 .25rem">The note you were writing here wasn’t saved:</p><blockquote class="dn-kept">${err.words}</blockquote>` : null}</div>
    ${err.back?.ref || err.words || !err.final ? html`<div class="notice__actions">
      ${err.back?.ref ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => goTo({ tab: 'people', donor: err.back.ref })}>Open that record</button>` : null}
      ${err.words ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => copyWords(err.words)}>Copy the words</button>` : null}
      ${err.final ? null : html`<button class="btn btn-ghost" onClick=${() => load()}>Try again</button>`}</div>` : null}</div>`;
  if (!v) return html`${back}<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;
  const d = v.donor;
  const level = v.needs.find((n) => n.kind === 'level');
  const near = v.needs.filter((n) => n.kind === 'near');
  const unlink = async (n) => {
    if (!(await ask({ title: `Take “${n.name}” off ${v.name}?`, text: n.kind === 'payment' ? 'That gift counts as it would without your answer: for its giver’s organization if they have one, else for them.' : 'Its gifts count for the people who gave them again, and the site won’t link that name to it by itself.', yes: 'Take it off' }))) return;
    const r = await change(n.kind === 'payment' ? { act: 'payment-clear', id: n.subject } : { act: 'not', kind: n.kind, subject: n.subject, ...(n.subjects?.length > 1 ? { subjects: n.subjects } : {}), org: v.key });
    if (!r.success) { ctx.addToast(r.error, 'error'); return; }
    listChanged();
    ctx.addToast(`“${n.name}” is off ${v.name}`, 'success');
    await load();
  };
  // Refused (answered by someone since): the page as it is now, so the question it showed goes
  const say = async (body, done) => { setBusy(true); const r = await change(body); setBusy(false); if (!r.success) { ctx.addToast(r.error, 'error'); await load(); return false; } listChanged(); if (done) ctx.addToast(done, 'success'); await load(); return true; };
  const putOnSite = async () => {
    if (puttingOnSite) return;
    puttingOnSite = true;
    try { await putOnSiteNow(); } finally { puttingOnSite = false; }
  };
  const putOnSiteNow = async () => {
    if (!ctx.createPartner) { location.hash = '#partners'; return; }
    // As it is now, not as this page read it: taken out, renamed or put on the website by a teammate since
    const now = await get(`?org=${encodeURIComponent(v.key)}`);
    if (left.current) return;
    if (now.success && (now.org || now.onSite)) { ctx.addToast(`${v.name} is on the website already: someone put it there since this page was read`, 'info'); goTo({ tab: 'people', org: now.org || v.key }); return; }
    if (!now.success && now.status === 404) { ctx.addToast(`${v.name} was taken out since this page was read, so there’s nothing to put on the website. Nothing was made.`, 'error'); if (!left.current) await load(); return; }
    if (!now.success) { ctx.addToast(`Couldn’t check ${v.name} just now: ${now.error} Nothing was made.`, 'error', { label: 'Try again', fn: putOnSite }); return; }
    const o = { name: now.name || v.name, keepAnonymous: !!now.keepAnonymous, anonymousGifts: !!now.anonymousGifts };
    if (o.keepAnonymous || o.anonymousGifts) {
      if (!(await ask({ title: `Put ${o.name} on the website?`, text: o.keepAnonymous ? `${o.name} is kept anonymous. Its name and logo would be on the Partners page for anyone to see.` : `Some of ${o.name}’s gifts were given anonymously. Its name and logo would be on the Partners page for anyone to see.`, yes: 'Put it on the website', careful: true }))) return;
    }
    // A partner card of its exact name already (made here a moment ago, before a step that failed): that one, never a second
    const nk = (x) => String(x || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
    const made = (ctx.partners || []).find((p) => nk(p.name) === nk(o.name));
    if (made) {
      if (await ask({ title: `Use the partner card “${made.name}”?`, text: `There’s a partner card with this name already. ${o.name}’s gifts, notes and owner go to it, and it’s on the website after you publish. To make another card instead, rename this organization first.`, yes: 'Use it' })) await finishOnSite(made.slug, o.name, false, o.keepAnonymous);
      return;
    }
    if (left.current) return;
    const got = await ctx.createPartner({ name: o.name });
    if (!got) return;
    const card = typeof got === 'string' ? { slug: got, name: o.name } : got;
    await finishOnSite(card.slug, card.name || o.name, true, o.keepAnonymous);
  };
  // Its partner card is made: everything said about it moves to the partner (tried again from the toast if it failed)
  const finishOnSite = async (slug, name = v.name, madeNow = false, kept = null, fromToast = false) => {
    const r = await change({ act: 'website', key: v.key, slug, ...(typeof kept === 'boolean' ? { was: { kept } } : {}) });
    // Refused (taken out, or on the website as another card, since): the card just made says so, never left unmentioned
    if (!r.success && r.status === 409) {
      ctx.addToast(`${r.error}${madeNow && !r.went && !/partner card/i.test(r.error) ? ` The partner card “${name}” was made just before: delete it in Partners if it isn’t wanted.` : ''}`, 'error');
      if (!left.current) await load();
      return;
    }
    // Both answers lost: it may have gone through all the same (then it's done, and says so)
    const now = r.success ? null : await get(`?org=${encodeURIComponent(v.key)}`);
    const went = now?.success && now.org && !now.donor ? now.org : null;
    if (!r.success && !went) { ctx.addToast(`${name} has a partner card, but its gifts haven’t moved to it yet: ${r.error}`, 'error', { label: 'Try again', fn: () => finishOnSite(slug, name, madeNow, kept, true) }); return; }
    if (went) r.key = went;
    listChanged();
    ctx.addToast(`${name} is on the Partners page after you publish`, 'success', null, { publish: true });
    // By address: pressed from its toast after the page was left, it goes there; finished on its own after the person
    // left, it never pulls them back
    moveDraft(v.key, r.key);
    if (!left.current || fromToast) location.replace(addressOf({ tab: 'people', org: r.key }));
  };
  const takeOut = async () => {
    const ownNotes = (v.notes || []).filter((n) => n.subject === v.key).length;
    const ownOwner = v.ownOwner || null;
    // What's its own, said plainly: its notes, and who looks after it (by name)
    const notesWords = ownNotes === 1 ? 'its note' : ownNotes ? `its ${ownNotes} notes` : null;
    const ownerWords = ownOwner ? `its owner (${fullName(ownOwner, v.staff)})` : null;
    const both = notesWords && ownerWords;
    const cap = (x) => x[0].toUpperCase() + x.slice(1);
    const keptWords = !notesWords && !ownerWords ? ''
      : v.madeFrom ? ` ${cap([notesWords, ownerWords].filter(Boolean).join(' and '))} ${both || ownNotes > 1 ? 'go' : 'goes'} back to ${v.madeFrom.name}, the Zeffy record it was made from.`
      : ` ${[notesWords ? `${cap(notesWords)} ${ownNotes > 1 ? 'are' : 'is'} deleted with it` : null, ownerWords ? `${notesWords ? 'and ' : ''}${notesWords ? ownerWords : cap(ownerWords)} is cleared` : null].filter(Boolean).join(', ')}.`;
    // (a note being written here, or a change to one of its own notes: said what becomes of it, never lost unasked; a
    // change to a Zeffy contact's note stays with that note, on the contact's page)
    const ownEdits = (v.notes || []).filter((n) => n.subject === v.key && draftOf(editKey(n.id)));
    const writing = !!(String(draftOf(draftKey(v.key, 'new'))?.text || '').trim() || ownEdits.length);
    if (!(await ask({ title: `Take ${v.name} out?`, text: `Its gifts count for the people who gave them again. Nothing changes in Zeffy.${keptWords}${writing ? (v.madeFrom ? ` The note you’re writing here goes to ${v.madeFrom.name}’s page, not saved yet.` : ' The note you’re writing here isn’t saved, and goes with it.') : ''}${v.keepAnonymous ? (v.madeFrom ? ` It’s kept anonymous, and ${v.madeFrom.name} stays kept anonymous.` : ' It’s kept anonymous: their names show on the board’s list of gifts again, unless they’re kept anonymous themselves.') : ''}`, yes: 'Take it out', danger: true }))) return;
    // (what the question said goes with it: a teammate's note or owner since is never lost unseen)
    const r = await change({ act: 'org-delete', key: v.key, was: { notes: (v.notes || []).map((n) => n.id), owner: v.owner || '', kept: !!v.keepAnonymous } });
    // (its answers lost every time: taken out after all, it's done)
    const gone = !r.success && lostAnswer(r) && (await get(`?org=${encodeURIComponent(v.key)}`)).status === 404;
    if (!r.success && !gone) { ctx.addToast(r.error, 'error'); if (!left.current) await load(); return; }
    // (the note being written: to the record it goes back to, else gone with it, as the question said)
    if (v.madeFrom?.key) moveDraft(v.key, v.madeFrom.key);
    else { keepDraft(draftKey(v.key, 'new'), null); for (const n of ownEdits) keepDraft(editKey(n.id), null); }
    listChanged();
    ctx.addToast(`${v.name} taken out`, 'success');
    if (!left.current) onBack();
  };
  const findNames = async (q) => {
    if (q.trim().length < 2) return [];
    const j = await call('', { find: q.trim() });
    if (!j.success) throw new Error(j.error);
    return (j.names || []).map((x) => ({ id: `${x.kind}:${x.subject}`, ...x, label: x.name, disabled: x.org === v.key,
      sub: [x.kind === 'company' ? 'A company name on gifts' : x.email || 'A Zeffy contact', `${usd(x.cents)} given`, x.org === v.key ? 'already counts here' : x.orgName ? `counts for ${x.orgName} now` : null].filter(Boolean).join(' · ') }));
  };
  // Read in the order it shows: two columns, the page then the side; one column, the first cards, the page, then the rest
  const early = html`
        <section class="kd-card kd-card--status" aria-labelledby="dn-stage-h">
          <h3 id="dn-stage-h">Stage</h3>
          <p>${stageTag(d.stage)}</p>
          <p class="kd-card__note">${STAGES[d.stage]?.what}</p>
        </section>
        <${OwnerCard} subject=${v.key} owner=${v.owner} staff=${v.staff} name=${v.name} ctx=${ctx} onDone=${load} peek=${() => get(`?org=${encodeURIComponent(v.key)}`)} />
        <section class="kd-card kd-card--health" aria-labelledby="dn-site-h">
          <h3 id="dn-site-h">On the website</h3>
          ${v.onSite ? html`<p>${v.levelLabel} on the Partners page</p>
            <p style="margin:.5rem 0 0"><a class="btn btn-ghost btn-sm" href=${`#partners/${encodeURIComponent(v.slug)}`}>Open its partner card</a></p>
            ${level ? html`<div class="dn-suggest"><p>Gave ${usd(level.cents12)} in the last 12 months: Champion is $10,000 or more.</p>
              <div class="dn-need__do"><button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${async () => { if (await makeChampion(level, ctx)) listChanged(); await load(); }}>Move to Champion…</button>
              <button type="button" class="btn btn-ghost btn-sm" disabled=${busy} onClick=${() => say({ act: 'level', org: v.key, done: false, asked: true }, 'It won’t ask about them again for a year')}>Not now</button></div></div>` : null}`
          : html`<p>Not on the website. Only staff see it here.</p>
            <div class="dn-need__do"><button type="button" class="btn btn-ghost btn-sm" onClick=${putOnSite}>Put it on the website…</button>
              <button type="button" class="btn btn-ghost btn-sm" onClick=${() => setRenaming(true)}>Rename</button>
              <button type="button" class="btn btn-ghost btn-sm" onClick=${takeOut}>Take it out</button></div>`}
          <p class="kd-card__note">Giving in the last 12 months: ${usd(v.cents12)}.</p>
        </section>
  `;
  const late = html`
        <${KeepAnonymous} subject=${v.key} on=${!!v.keepAnonymous} names=${v.keptNames || []} name=${v.name} onSite=${!!v.onSite} ctx=${ctx} onDone=${load} />
  `;
  const main = html`
      <div class="kd-main" key="main" style="display:grid;gap:1rem">
        <${ThankBox} gifts=${v.gifts} name=${v.name} ctx=${ctx} />
        <section class="card kd-sec" aria-labelledby="dn-giving-h">
          <header class="kd-sec__head"><h3 id="dn-giving-h">Giving</h3></header>
          <${GivingTiles} d=${d} />
        </section>
        <section class="card kd-sec" aria-labelledby="dn-names-h">
          <header class="kd-sec__head"><h3 id="dn-names-h">Names it gives under</h3>
            <button type="button" class="btn btn-ghost btn-sm" onClick=${() => setAdding(true)}>Add a Zeffy name</button></header>
          ${near.length ? html`<ul class="dn-plain">${near.map((n) => html`<li key=${n.id} class="dn-maybe">Maybe ${n.link === 'company' ? html`“${n.subject}”` : n.name}? <span class="dn-sub">${n.why}, ${usd(n.cents)} given</span>
            <span class="dn-row-do"><button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${() => say({ act: 'link', kind: n.link, subject: n.subject, org: v.key, asked: true }, `Its gifts count for ${v.name} now`)}>Yes, it’s ${v.name}</button>
            <button type="button" class="btn btn-ghost btn-sm" disabled=${busy} onClick=${() => say({ act: 'not', kind: n.link, subject: n.subject, org: v.key, asked: true })}>No</button></span></li>`)}</ul>` : null}
          ${v.names.length ? html`<ul class="dn-plain">${v.names.map((n) => html`<li key=${`${n.kind}:${n.subject}`}><strong>${n.name}</strong>
            <span class="dn-sub">${n.kind === 'company' ? 'A company name on gifts' : n.kind === 'payment' ? 'One gift, counted here by hand' : 'A Zeffy contact'} · ${n.how === 'same name' ? 'the same name, linked by itself' : n.how === 'linked' ? 'linked by a person' : n.how}</span>
            <span class="dn-row-do">${n.kind === 'contact' ? html`<a class="link" href=${zeffyContactUrl(n.subject)} target="_blank" rel="noopener">Open in Zeffy</a>` : null}
              <button type="button" class="link dn-linkbtn" onClick=${() => unlink(n)}>Take off</button></span></li>`)}</ul>`
          : html`<p class="dn-sub">No Zeffy names yet. Add the company name its gifts carry, or the Zeffy contact it gives as.</p>`}
        </section>
        ${v.people.length ? html`<section class="card kd-sec" aria-labelledby="dn-people-h">
          <header class="kd-sec__head"><h3 id="dn-people-h">Who gave for it</h3></header>
          <ul class="dn-plain">${v.people.map((p) => html`<li key=${p.key}>${p.self ? html`<span>${p.name} <span class="dn-sub">(its own record in Zeffy)</span></span>` : html`<a class="link" href=${`#donors/${encodeURIComponent(p.ref)}`}>${p.name}</a>`} <span class="dn-sub">${usd(p.cents)}, ${plural(p.gifts, 'gift')}</span></li>`)}</ul>
        </section>` : null}
        <${Timeline} key=${v.key} subject=${v.key} keys=${[v.key, ...(v.names || []).filter((x) => x.kind === 'contact').map((x) => `c:${x.subject}`)]} refOf=${v.key} org=${true} name=${v.name} gifts=${v.gifts} notes=${v.notes} staff=${v.staff} ctx=${ctx} onChanged=${load} focusGift=${gift || null} thankAgain=${(th) => thankAgain(ctx, th)} />
      </div>
  `;
  return html`
    ${back}
    ${gone ? html`<div class="notice notice--warn" role="alert"><div class="notice__body"><strong>${gone.text}</strong> ${gone.back ? 'What was said about it went back to the Zeffy record it was made from, and a note being written here goes there too.' : `This page shows it as it was: copy anything you typed here${gone.org ? ', then open where it is now.' : ', then go back.'}`}</div>
      ${gone.org || gone.back?.ref ? html`<div class="notice__actions"><button type="button" class="btn btn-ghost btn-sm" onClick=${() => { if (gone.back) { moveDraft(orgKey, gone.back.key); goTo({ tab: 'people', donor: gone.back.ref }); } else goTo({ tab: 'people', org: gone.org }); }}>${gone.back ? 'Open that record' : 'Open it'}</button></div>` : null}</div>` : null}
    <div class="dn-head">
      <h2 tabindex="-1" ref=${heading}>${v.name} ${stageTag(d.stage)} ${orgTag(v)}${v.keepAnonymous ? html`<span class="tag">Kept anonymous</span>` : null}</h2>
      <p class="dn-head__sub">An organization: every gift from the names below counts for it.</p>
    </div>
    <div class="kd-shell" ref=${setShell}><div class="kd-layout">
      ${wide ? [main, html`<aside class="kd-rail" key="rail" aria-label="Organization at a glance">${early}${late}</aside>`]
        : [html`<aside class="kd-rail" key="rail" aria-label="Organization at a glance">${early}</aside>`, main, html`<aside class="kd-rail" key="more" aria-label="More about this organization">${late}</aside>`]}
    </div></div>
    ${adding && !gone ? html`<${Picker} title=${`Add a Zeffy name to ${v.name}`} sub="A company name its gifts carry, or the Zeffy contact it gives as. Every gift under it counts here." placeholder="Name or email in Zeffy"
      search=${findNames} onClose=${() => setAdding(false)}
      onPick=${async (x) => {
        // (a name that counts for another organization now: moved from there only when the person says so)
        if (x.org && x.org !== v.key && !(await ask({ title: `Move “${x.name}” to ${v.name}?`, text: `Its gifts count for ${x.orgName || 'another organization'} now. Moved, they count for ${v.name} instead, and no longer for ${x.orgName || 'it'}.`, yes: 'Move it', careful: true }))) return false;
        const ok = await say({ act: 'link', kind: x.kind, subject: x.subject, org: v.key, from: x.org || '' }, `“${x.name}” counts for ${v.name} now`);
        if (ok) return true;
        // (its answers lost every time: on this organization after all, it's done)
        const now = await get(`?org=${encodeURIComponent(v.key)}`);
        return (now.names || []).some((n) => n.kind === x.kind && String(n.subject).toLowerCase() === String(x.subject).toLowerCase()) ? true : false;
      }} />` : null}
    ${renaming && !gone ? html`<${RenameDialog} name=${v.name} onClose=${() => setRenaming(false)} onSave=${async (name, was) => ((await say({ act: 'org-rename', key: v.key, name, was }, 'Renamed')) ? true : { now: lastRead.current?.name ?? null })} />` : null}`;
}

/** A new name for an organization kept here (a partner's name is changed in its partner card) */
function RenameDialog({ name: shownName, onSave, onClose }) {
  const box = useRef(null);
  const input = useRef(null);
  // The name it opened on: what the person saw, and is renaming (sent as such, whatever a re-read shows since). Told
  // of a teammate's rename (refused), it's that one they've seen: Save then renames it
  const [name, setName] = useState(shownName);
  const [openedAt] = useState(() => Date.now());
  const latestShown = useRef(shownName);
  latestShown.current = shownName;
  const [val, setVal] = useState(name);
  const [busy, setBusy] = useState(false);
  useDialog(box, onClose, busy);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const save = async (e) => {
    e.preventDefault();
    const t = val.trim();
    if (!t || t === name) { onClose(); return; }
    setBusy(true);
    const ok = await onSave(t, name);
    setBusy(false);
    if (ok === true) { onClose(); return; }
    // Refused (renamed by a teammate meanwhile), or its answers lost: the name it has now, as the page read it again.
    // Saved after all, it reads as they wrote it, so it's done; else Save renames the one they've now seen
    const now = ok?.now ?? latestShown.current;
    if (now === t) { onClose(); return; }
    setName(now);
  };
  return html`<div class="modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget && !busy && Date.now() - openedAt > 400) onClose(); }}>
    <div class="modal dn-rename" role="dialog" aria-modal="true" aria-labelledby="dn-rename-h" tabindex="-1" ref=${box}><form onSubmit=${save}>
      <h3 id="dn-rename-h">Rename ${name}</h3>
      <p>Only staff see this name. It isn’t on the website.</p>
      <label class="sr-only" for="dn-rename-input">Name</label>
      <input id="dn-rename-input" ref=${input} class="form-input" maxlength="120" value=${val} onInput=${(e) => setVal(e.target.value)} autocomplete="off" />
      <div class="modal-buttons"><button type="button" class="btn btn-ghost" onClick=${onClose} disabled=${busy}>Cancel</button>
        <button type="submit" class="btn btn-primary" disabled=${busy || !val.trim()}>${busy ? html`<span class="spinner spinner-14" />` : null}Save</button></div>
    </form></div></div>`;
}
