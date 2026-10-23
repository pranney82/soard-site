/**
 * Admin → Applications → Applicants (loaded by ./applications.js)
 * ===========================================================================
 * Every makeover family in JobTread, worked from the site. JobTread stays the
 * record: each change here is written to JobTread first, and whatever staff
 * do in JobTread shows up here within a couple of minutes (or straight away
 * for a status change, through the JobTread workflow). The server side is
 * functions/api/applicants-admin.js and ./_applicants.js.
 *
 *  - Board: a column per status. Drag a family to another column (or use
 *    the status menu) and a sheet shows exactly what the family will be
 *    emailed before anything is sent.
 *  - List: sortable, searchable table.
 *  - Map: every home against the service-area boundary, pins colored by
 *    status. The boundary can be reshaped here; it's a setting, so it's
 *    used for everyone the moment it's saved.
 *  - Activity: what happened across every family, newest first.
 *  - More views from ./applications.js (`extraViews`): Submissions, the
 *    website form's intake log, sits beside these.
 *  - A family (drawer): the whole conversation (emails, replies, texts,
 *    calls, notes) with a composer to email the family or add a note; the
 *    JobTread details, editable in place; contacts, home, the answers from
 *    the website form, files. On a phone, Conversation and Details are tabs.
 *
 * One toolbar row: the views, then search, season and a Filters menu (the
 * filters in use show as chips you can clear).
 *
 * Staying in step with JobTread needs nobody: changes arrive within seconds,
 * and coming back to the tab catches up at once ({ sync: 'catchup' }). The
 * header says when JobTread was last checked; only when something is wrong
 * does it say what, with a "Check JobTread now" button.
 *
 * "Pause family emails" (the ⋯ menu) is for changing a lot of statuses at
 * once: family emails hold for up to 2 hours, and when the person turns them
 * back on, they choose which held emails still go, family by family.
 */

import { h, htm, useState, useEffect, useRef, useMemo, useCallback, Sortable } from './vendor.js';
import { nearRing, bandChanges } from './area-shared.js';

const html = htm.bind(h);
const API = '/api/applicants-admin';
const STATUS_ORDER = ['Applied', 'In Review', 'Approved', 'Denied'];
const STATUS_COLOR = { Applied: '#2B6CB0', 'In Review': '#B7791F', Approved: '#2F7D4F', Denied: '#7C7D84', '': '#A3A4AA' };
const STATUS_HINT = {
  Applied: 'New applications waiting for a first look',
  'In Review': 'Interview and home visit stage',
  Approved: 'On the makeover waitlist',
  Denied: 'Not moving forward',
};
// The area as families see it on the application: brand yellow, a charcoal line; "close" is a dashed ring
const AREA_INK = '#373A36';
const AREA_FILL = '#FFDA24';
const SOURCE_LABEL = { website: 'on the website', jobtread: 'in JobTread', datax: 'by DataX', zapier: 'by Zapier', family: 'by the family', workflow: 'by a JobTread workflow', claude: 'by Claude' };
const COMMENT_KINDS = new Set(['comment', 'reply', 'textIn', 'textOut', 'call', 'sent', 'note']);
const DEFAULT_SUBJECT = 'A message from Sunshine on a Ranney Day';
// The status messages JobTread emails to families (English and Spanish titles)
const FAMILY_TITLES = new Set(['Application Status', 'Application In Review', 'Application Decision', 'Estado de la solicitud', 'Solicitud en revisión', 'Decisión sobre la solicitud']);

async function call(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  return j;
}

// ─── Small helpers ─────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JobTread's light formatting (*bold*, _italic_, line breaks) as safe HTML */
const richText = (s) => esc(s).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>').replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1<em>$2</em>').replace(/^#{2,4}\s?(.*)$/gm, '<strong>$1</strong>').replace(/\n/g, '<br>');
const fullDate = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: s > 86400 * 300 ? 'numeric' : undefined });
}
/** An activity title as a label ("Makeover job created:" with nothing after reads "Makeover job created") */
const cleanTitle = (t) => String(t || '').replace(/[:\s]+$/, '');
const daysSince = (iso, now = Date.now()) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / 86400000)) : null);
function ageOf(birthday) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(birthday || '')) return null;
  const b = new Date(`${birthday.slice(0, 10)}T12:00:00`);
  const n = new Date();
  let y = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) y--;
  return y >= 0 && y < 40 ? y : null;
}
/** "2:45 PM" today, "Tue 8:00 AM" further out (the family's emails keep Eastern time) */
function clock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
const minutesUntil = (ts) => Math.max(0, Math.round((ts - Date.now()) / 60000));
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const phoneText = (p) => {
  const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p || '';
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const TYPE_ICON = { Bedroom: '🛏', Bathroom: '🛁', 'Therapy Room': '🧸', Ramp: '♿' };

// ─── Styles (prefixed apl-, injected once) ─────────────────────────
const CSS = `
.apl { --apl-gap: .9rem; --apl-warn-bg: #FFF6E0; --apl-warn-line: #F2D899; --apl-warn-ink: #6B4A00; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--apl-gap); min-width: 0; }
.apl > * { min-width: 0; }
.apl > .page-header { margin-bottom: 0; }
.apl-head-actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }

/* One toolbar row: views on the left, search and filters on the right */
.apl-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem .75rem; }
.apl-views { display: inline-flex; flex: none; max-width: 100%; overflow-x: auto; scrollbar-width: none; padding: 3px; gap: 2px; border-radius: 10px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); }
.apl-views::-webkit-scrollbar { display: none; }
.apl-views button { display: inline-flex; align-items: center; gap: .4rem; flex: none; border: 0; background: none; font: inherit; font-size: .88rem; font-weight: 600; color: var(--color-text-secondary); padding: .42rem .85rem; border-radius: 8px; cursor: pointer; min-height: 36px; transition: background .15s, color .15s, box-shadow .15s; white-space: nowrap; }
.apl-views button:hover { color: var(--color-text); }
.apl-views button[aria-pressed="true"] { background: var(--color-bg-card); color: var(--color-text); box-shadow: var(--shadow-sm); }
.apl-views button:focus-visible { outline: 2px solid var(--color-text); outline-offset: -2px; }
.apl-view-n { min-width: 1.25rem; padding: 0 .38rem; border-radius: 999px; background: var(--apl-warn-bg); border: 1px solid var(--apl-warn-line); color: var(--apl-warn-ink); font-size: .72rem; font-weight: 700; line-height: 1.15rem; text-align: center; font-variant-numeric: tabular-nums; }
/* Search, season and Filters stay together on one line; short of room, they move under the views as a group */
.apl-filters { display: flex; flex-wrap: nowrap; gap: .5rem; align-items: center; justify-content: flex-end; flex: 1 1 26rem; min-width: 0; }
.apl-filters > * { flex-shrink: 0; }
.apl-filters > .apl-search { flex-shrink: 1; min-width: 8.5rem; }
.apl-filters > .apl-season { flex-shrink: 1; min-width: 7.5rem; }
.apl-filters .form-select, .apl-filters .form-input { width: auto; min-height: 38px; font-size: .88rem; }
.apl-filters .form-select { max-width: 13rem; }
.apl-search { position: relative; flex: 1 1 200px; max-width: 320px; }
.apl-search input, .apl-filters .apl-search input { padding-left: 2rem; padding-right: 2rem; width: 100%; }
.apl-search input::-webkit-search-cancel-button { cursor: pointer; }
.apl-search svg { position: absolute; left: .65rem; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--color-text-muted); pointer-events: none; }
.apl-search kbd { position: absolute; right: .5rem; top: 50%; transform: translateY(-50%); font: 600 .7rem/1 ui-monospace, monospace; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 4px; padding: 2px 5px; background: var(--color-bg-secondary); pointer-events: none; }
@media (pointer: coarse) { .apl-search kbd { display: none; } .apl-fbtn, .apl-more-btn, .apl-sortbar .btn { min-height: 44px; } }
.apl-fbtn { display: inline-flex; align-items: center; gap: .4rem; min-height: 38px; white-space: nowrap; }
.apl-fbtn[aria-expanded="true"] { border-color: var(--color-text); }
.apl-fbtn b { min-width: 1.2rem; padding: 0 .35rem; border-radius: 999px; background: var(--color-text); color: var(--color-bg-card); font-size: .7rem; line-height: 1.2rem; text-align: center; }
.apl-active { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; margin-top: -.3rem; }
.apl-active button { display: inline-flex; align-items: center; gap: .3rem; min-height: 30px; padding: .15rem .45rem .15rem .65rem; border: 1px solid var(--color-border-strong); border-radius: 999px; background: var(--color-bg-card); color: var(--color-text); font: inherit; font-size: .8rem; font-weight: 600; cursor: pointer; }
.apl-active button:hover { background: var(--color-bg-hover); }
.apl-active button svg { width: 12px; height: 12px; color: var(--color-text-muted); }
.apl-active .apl-clear { border-color: transparent; background: none; color: var(--color-text-secondary); text-decoration: underline; text-underline-offset: 2px; padding: .15rem .3rem; }

/* Popovers: the Filters panel and the ⋯ menu */
.apl-pop-wrap { position: relative; display: inline-flex; }
.apl-popover { position: absolute; z-index: 80; top: calc(100% + 6px); right: 0; width: min(300px, calc(100vw - 2rem)); padding: .85rem; display: grid; gap: .7rem; background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 12px; box-shadow: var(--shadow-lg); animation: apl-pop .14s ease-out; }
.apl-popover label { display: grid; gap: .3rem; font-size: .8rem; font-weight: 650; color: var(--color-text-secondary); }
.apl-popover .form-select { width: 100%; max-width: none; }
.apl-pop-season { display: none !important; }
@media (max-width: 640px) { .apl-pop-season { display: grid !important; } }
.apl-popover-foot { display: flex; justify-content: space-between; align-items: center; gap: .5rem; padding-top: .55rem; border-top: 1px solid var(--color-border); }
.apl-menu { position: absolute; z-index: 80; top: calc(100% + 6px); right: 0; width: min(300px, calc(100vw - 2rem)); padding: .35rem; display: grid; gap: 2px; background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 12px; box-shadow: var(--shadow-lg); animation: apl-pop .14s ease-out; }
.apl-menu button { all: unset; box-sizing: border-box; display: grid; gap: .1rem; width: 100%; padding: .55rem .65rem; border-radius: 8px; cursor: pointer; font-size: .88rem; font-weight: 600; color: var(--color-text); }
.apl-menu button small { font-size: .76rem; font-weight: 400; color: var(--color-text-muted); line-height: 1.4; }
.apl-menu button:hover, .apl-menu button:focus-visible { background: var(--color-bg-hover); }
.apl-menu button:focus-visible { outline: 2px solid var(--color-text); outline-offset: -2px; }
.apl-menu button[aria-disabled="true"] { opacity: .45; cursor: default; }
.apl-menu hr { margin: .25rem .4rem; border: 0; border-top: 1px solid var(--color-border); }
.apl-more-btn { min-width: 38px; min-height: 38px; padding: 0 .55rem; display: inline-grid; place-items: center; }
.apl-more-btn svg { width: 18px; height: 18px; }

.apl-sync { font-size: .8rem; color: var(--color-text-muted); display: inline-flex; gap: .45rem; align-items: center; }
.apl-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.apl-dot.is-live { background: var(--color-success); box-shadow: 0 0 0 3px rgba(47,125,79,.15); }
.apl-dot.is-stale { background: var(--color-warning); }

/* Status counts above the list and the map (they filter too) */
.apl-strip { display: flex; flex-wrap: wrap; gap: .35rem; }
.apl-strip button { display: inline-flex; align-items: center; gap: .45rem; min-height: 34px; padding: .2rem .75rem; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-bg-card); color: var(--color-text-secondary); font: inherit; font-size: .84rem; font-weight: 600; cursor: pointer; transition: border-color .15s, background .15s; }
.apl-strip button:hover { border-color: var(--color-border-strong); color: var(--color-text); }
.apl-strip button b { color: var(--color-text); font-variant-numeric: tabular-nums; }
.apl-strip button[aria-pressed="true"] { border-color: var(--c, var(--color-text)); background: color-mix(in srgb, var(--c, var(--color-text)) 9%, var(--color-bg-card)); color: var(--color-text); box-shadow: inset 0 0 0 1px var(--c, var(--color-text)); }
.apl-strip .apl-dot { background: var(--c); }
.apl-strip button.is-all[aria-pressed="true"] { border-color: var(--color-text); background: var(--color-text); color: var(--color-bg-card); box-shadow: none; }
.apl-strip button.is-all[aria-pressed="true"] b { color: inherit; }

/* The board always fits the page: four columns share the width, and the
   cards inside shrink with them. Too narrow for four (phones, a small
   window), one status shows at a time under a switcher. Never a sideways scroll. */
.apl-board-wrap { container: apl-board / inline-size; }
.apl-board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .75rem; align-items: start; }
.apl-col { container: apl-col / inline-size; background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-md); min-width: 0; display: flex; flex-direction: column; max-height: calc(100vh - 230px); }
.apl-col-head { display: flex; align-items: center; gap: .5rem; padding: .7rem .8rem .55rem; border-bottom: 1px solid var(--color-border); min-width: 0; }
.apl-col-head h3 { margin: 0; font-size: .92rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apl-col-head .apl-count { margin-left: auto; font-size: .78rem; font-weight: 700; color: var(--color-text-secondary); background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 999px; padding: 1px 8px; font-variant-numeric: tabular-nums; }
.apl-col-hint { font-size: .75rem; line-height: 1.35; color: var(--color-text-muted); padding: .35rem .8rem 0; }
.apl-cards { display: grid; grid-template-columns: minmax(0, 1fr); gap: .5rem; padding: .6rem; overflow-y: auto; overflow-x: hidden; min-height: 90px; align-content: start; flex: 1; }
.apl-cards.is-target { background: var(--color-primary-bg); outline: 2px dashed var(--color-primary); outline-offset: -6px; border-radius: 10px; }
.apl-empty-col { font-size: .8rem; color: var(--color-text-muted); text-align: center; padding: 1.2rem .5rem; border: 1px dashed var(--color-border-strong); border-radius: 10px; }
.apl-empty-col .is-narrow { display: none; }

/* The switcher: one button per status with its count (shown only when the columns can't all fit) */
.apl-board-tabs { display: none; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2px; padding: 3px; margin-bottom: .6rem; border-radius: 12px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); }
.apl-board-tabs button { display: grid; justify-items: center; align-content: center; gap: 2px; min-width: 0; min-height: 52px; padding: .35rem .25rem; border: 0; border-radius: 9px; background: none; font: inherit; color: var(--color-text-secondary); cursor: pointer; transition: background .15s, color .15s, box-shadow .15s; }
.apl-board-tabs button span { display: inline-flex; align-items: center; gap: .3rem; max-width: 100%; font-size: .78rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.apl-board-tabs button b { font-size: 1.05rem; line-height: 1.1; color: var(--color-text); font-variant-numeric: tabular-nums; }
.apl-board-tabs button .apl-dot { width: 7px; height: 7px; background: var(--c); }
.apl-board-tabs button:hover { color: var(--color-text); }
.apl-board-tabs button[aria-pressed="true"] { background: var(--color-bg-card); color: var(--color-text); box-shadow: var(--shadow-sm), inset 0 -2px 0 var(--c); }
.apl-board-tabs button:focus-visible { outline: 2px solid var(--color-text); outline-offset: -2px; }
@container apl-board (max-width: 699px) {
  .apl-board-tabs { display: grid; }
  .apl-board { grid-template-columns: minmax(0, 1fr); }
  .apl-col:not(.is-shown) { display: none; }
  .apl-col { max-height: none; }
  .apl-col-head { display: none; }
  .apl-col-hint { padding-top: .6rem; }
  .apl-cards { overflow: visible; }
  .apl-empty-col .is-wide { display: none; }
  .apl-empty-col .is-narrow { display: inline; }
}

.apl-card { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 10px; padding: .65rem .7rem; display: grid; grid-template-columns: minmax(0, 1fr); gap: .4rem; cursor: pointer; box-shadow: var(--shadow-xs); transition: box-shadow .15s, border-color .15s, transform .15s; text-align: left; font: inherit; color: inherit; width: 100%; min-width: 0; }
.apl-card > * { min-width: 0; }
.apl-card:hover { border-color: var(--color-border-strong); box-shadow: var(--shadow-md); }
.apl-card:focus-visible { outline: 2px solid var(--color-text); outline-offset: 2px; }
.apl-card.is-ghost { opacity: .35; }
.apl-card.is-chosen { box-shadow: var(--shadow-lg); transform: rotate(-1deg); }
.apl-card-top { display: flex; gap: .6rem; align-items: center; min-width: 0; }
.apl-avatar { position: relative; width: 34px; height: 34px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: .75rem; font-weight: 700; color: #fff; background: color-mix(in srgb, var(--c, #A3A4AA) 76%, #000); overflow: hidden; }
/* The photo covers the initials; a photo that won't load hides and they show */
.apl-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
.apl-card-name { font-weight: 650; font-size: .92rem; line-height: 1.25; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apl-card-sub { font-size: .76rem; color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.apl-tags { display: flex; flex-wrap: wrap; gap: .3rem; }
.apl-tag { font-size: .72rem; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); color: var(--color-text-secondary); white-space: nowrap; }
.apl-tag.is-out, .apl-tag.is-warn { background: var(--apl-warn-bg); border-color: var(--apl-warn-line); color: var(--apl-warn-ink); }
.apl-tag.is-in { background: #EAF6EF; border-color: #BFE3CD; color: #1F5C39; }
.apl-tag.is-es { background: #EAF2FB; border-color: #C5DAF1; color: #23578F; }
.apl-tag.is-test { background: #F1F0FB; border-color: #D7D3F2; color: #4B3F9C; }
.apl-card-foot { display: flex; justify-content: space-between; gap: .5rem; font-size: .74rem; color: var(--color-text-muted); }
.apl-card-foot span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apl-stage.is-long { color: #8A5A00; font-weight: 600; }
/* Narrow columns (a laptop window, an iPad): the name may take two lines, nothing is cut off */
@container apl-col (max-width: 215px) {
  .apl-col-head { padding: .6rem .6rem .5rem; gap: .4rem; }
  .apl-col-hint { padding: .35rem .6rem 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .apl-cards { padding: .45rem; gap: .4rem; }
  .apl-card { padding: .55rem .55rem .5rem; gap: .35rem; }
  /* The name beside the photo (two lines if it needs them); age and town under both, the card's full width */
  .apl-card-top { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .3rem .5rem; align-items: center; }
  .apl-card-top > div { display: contents; }
  .apl-card .apl-avatar { width: 28px; height: 28px; font-size: .66rem; }
  .apl-card-name { white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .apl-card .apl-card-sub { grid-column: 1 / -1; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .apl-tag { padding: 1px 6px; font-size: .7rem; }
}
.apl-mail { font-size: .72rem; font-weight: 650; padding: 2px 7px; border-radius: 999px; background: #FFF6D6; border: 1px solid #F2D899; color: #6B4A00; white-space: nowrap; }
.apl-mail.is-held { background: #EEF0F3; border-color: #D9DDE3; color: #4A4F57; }
.apl-mail.is-fix { background: #FFE6B8; border-color: #EBC16A; color: #5C3D00; }
.apl-banner { display: flex; gap: .75rem; align-items: center; justify-content: space-between; flex-wrap: wrap; border-radius: var(--radius-md); padding: .7rem .9rem; border: 1px solid #F2D899; background: #FFFBEB; font-size: .88rem; }
.apl-banner.is-info { border-color: var(--color-border); background: var(--color-bg-card); }
.apl-banner.is-warn { border-color: #F5C2BD; background: #FFF5F4; }
.apl-banner p { margin: 0; min-width: 0; flex: 1 1 280px; }
.apl-banner .apl-banner-actions { display: flex; gap: .4rem; flex-wrap: wrap; }
.apl-held { display: grid; gap: .5rem; }
.apl-held-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; border-top: 1px solid var(--apl-warn-line); }
.apl-held-list li { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .75rem; padding: .45rem 0; border-bottom: 1px solid var(--apl-warn-line); }
.apl-held-list li .apl-banner-actions { margin-left: auto; }
.apl-held-all { justify-content: flex-end; }
.apl-steps-list { margin: 0; padding-left: 1.2rem; display: grid; gap: .45rem; font-size: .92rem; line-height: 1.5; }
.apl-sync.is-problem { color: var(--apl-warn-ink); font-weight: 600; }
.apl-thread-banner { position: sticky; top: -1rem; z-index: 2; margin: -1rem -1.1rem .25rem; padding: .7rem 1.1rem; border-radius: 0; border-left: 0; border-right: 0; border-top: 0; }

.apl-table-wrap { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); overflow: auto; }
.apl-table { width: 100%; border-collapse: collapse; font-size: .88rem; }
.apl-table th { position: sticky; top: 0; background: var(--color-bg-secondary); text-align: left; font-size: .76rem; text-transform: uppercase; letter-spacing: .04em; color: var(--color-text-secondary); padding: .6rem .75rem; border-bottom: 1px solid var(--color-border); white-space: nowrap; z-index: 1; }
.apl-table th button { all: unset; cursor: pointer; display: inline-flex; gap: .3rem; align-items: center; }
.apl-table th button:focus-visible { outline: 2px solid var(--color-text); border-radius: 4px; }
.apl-table td { padding: .6rem .75rem; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
.apl-table tbody tr { cursor: pointer; transition: background .1s; }
.apl-table tbody tr:hover { background: var(--color-bg-hover); }
.apl-table tbody tr:focus-visible { outline: 2px solid var(--color-text); outline-offset: -2px; }
.apl-table .apl-td-last { max-width: 260px; }
/* Narrower than the table (a laptop window, an iPad, a phone): each family is a short row, never a sideways scroll */
.apl-list { container: apl-list / inline-size; display: grid; gap: .6rem; }
.apl-sortbar { display: none; align-items: center; justify-content: flex-end; gap: .4rem; }
.apl-sortbar label { display: inline-flex; align-items: center; gap: .45rem; font-size: .84rem; font-weight: 600; color: var(--color-text-secondary); }
.apl-sortbar .form-select { width: auto; min-height: 38px; font-size: .88rem; }
.apl-sortbar .btn { min-width: 38px; min-height: 38px; justify-content: center; }
.apl-table .apl-td-meta { display: none; }
@container apl-list (max-width: 899px) {
  .apl-sortbar { display: flex; }
  .apl-table-wrap { overflow: visible; }
  .apl-table thead { display: none; }
  .apl-table, .apl-table tbody { display: block; }
  .apl-table tbody tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "who status" "meta meta" "last last"; gap: .3rem .75rem; align-items: center; padding: .75rem .9rem; border-bottom: 1px solid var(--color-border); }
  .apl-table tbody tr:last-child { border-bottom: 0; }
  .apl-table td { display: none; padding: 0; border: 0; min-width: 0; }
  .apl-table td:nth-child(1) { display: block; grid-area: who; }
  .apl-table td:nth-child(2) { display: block; grid-area: status; }
  .apl-table .apl-td-meta { display: block; grid-area: meta; font-size: .84rem; color: var(--color-text-secondary); padding-left: calc(28px + .55rem); }
  .apl-table .apl-td-last { display: block; grid-area: last; max-width: none; white-space: normal; padding-left: calc(28px + .55rem); }
}
.apl-pill { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 650; padding: 3px 9px 3px 7px; border-radius: 999px; background: color-mix(in srgb, var(--c) 12%, white); color: color-mix(in srgb, var(--c) 80%, black); border: 1px solid color-mix(in srgb, var(--c) 28%, white); white-space: nowrap; }
.apl-pill::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--c); }

.apl-map-wrap { position: relative; border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; background: #EEF0EC; }
.apl-map { height: min(72vh, 760px); min-height: 420px; }
.apl-legend { position: absolute; z-index: 500; top: .75rem; left: .75rem; background: rgba(255,255,255,.96); border: 1px solid var(--color-border); border-radius: 10px; box-shadow: var(--shadow-md); padding: .55rem .6rem; display: grid; gap: .2rem; min-width: 190px; }
.apl-legend button { all: unset; display: flex; align-items: center; gap: .5rem; font-size: .84rem; padding: .25rem .35rem; border-radius: 6px; cursor: pointer; }
.apl-legend button:hover { background: var(--color-bg-hover); }
.apl-legend button:focus-visible { outline: 2px solid var(--color-text); }
.apl-legend button[aria-pressed="false"] { opacity: .45; }
.apl-legend b { margin-left: auto; font-variant-numeric: tabular-nums; }
.apl-legend-line { display: flex; align-items: center; gap: .5rem; font-size: .8rem; color: var(--color-text-secondary); padding: .3rem .35rem 0; border-top: 1px solid var(--color-border); margin-top: .2rem; }
.apl-legend-line i { width: 18px; height: 11px; border: 2px solid ${AREA_INK}; background: color-mix(in srgb, ${AREA_FILL} 45%, transparent); border-radius: 3px; display: inline-block; }
.apl-legend-line i.is-ring { background: none; border: 1.5px dashed ${AREA_INK}; opacity: .7; }
.apl-map-tools { position: absolute; z-index: 500; top: .75rem; right: .75rem; display: grid; gap: .4rem; justify-items: end; }
.apl-map-tools .btn { box-shadow: var(--shadow-md); }
.apl-map-note { position: absolute; z-index: 500; left: 50%; bottom: .9rem; transform: translateX(-50%); background: #1A1B1F; color: #fff; border-radius: 10px; padding: .6rem .9rem; font-size: .84rem; box-shadow: var(--shadow-lg); display: flex; gap: .75rem; align-items: center; max-width: calc(100% - 2rem); flex-wrap: wrap; justify-content: center; }
.apl-map-note .btn { min-height: 34px; }
.apl-pin { width: 18px; height: 18px; border-radius: 50%; background: var(--c); border: 2.5px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.35); transition: transform .15s; }
.apl-pin.is-moving { box-shadow: 0 0 0 3px #fff, 0 0 0 5.5px ${AREA_INK}, 0 1px 4px rgba(0,0,0,.35); }
.apl-pin.is-focus { transform: scale(1.5); box-shadow: 0 0 0 6px color-mix(in srgb, var(--c) 30%, transparent), 0 1px 4px rgba(0,0,0,.35); }
.apl-handle { width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 3px solid ${AREA_INK}; box-shadow: 0 1px 3px rgba(0,0,0,.3); cursor: grab; }
.apl-handle.is-mid { width: 10px; height: 10px; border-width: 2px; opacity: .8; }
.apl-pop { font: 14px/1.4 Inter, system-ui, sans-serif; display: grid; gap: .35rem; min-width: 190px; }
.apl-pop strong { font-size: .95rem; }
.apl-pop button { justify-self: start; }
.leaflet-container { font: inherit; }
.apl-tiles { filter: grayscale(1) contrast(.8) brightness(1.13); }
.apl-map img, .apl-homemap img { max-width: none !important; max-height: none !important; border-radius: 0 !important; box-shadow: none !important; }
/* isolation keeps Leaflet's own z-indexes (400+) under the drawer's menus */
/* width: 100% keeps the 280px height cap from narrowing it (aspect-ratio would trade width for height) */
.apl-homemap { width: 100%; height: auto; aspect-ratio: 21 / 10; min-height: 180px; max-height: 280px; border: 1px solid var(--color-border); border-radius: 10px; overflow: hidden; background: #EEF0EC; isolation: isolate; }
.apl-homemap .leaflet-control-attribution { font-size: 10px; }
.apl-gap { position: absolute; transform: translate(-50%, -50%); white-space: nowrap; background: #fff; color: ${AREA_INK}; border: 1.5px solid ${AREA_INK}; border-radius: 999px; padding: .05rem .45rem; font-size: .74rem; font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
.apl-home-links { display: flex; gap: .9rem; text-transform: none; letter-spacing: 0; }
/* Leaflet's own CSS lands after this, so these need the extra class to win */
@media (pointer: coarse) { .apl-homemap.leaflet-container .leaflet-control-zoom a { width: 40px; height: 40px; line-height: 40px; } .apl-home-links .apl-more { min-height: 44px; display: inline-flex; align-items: center; } }
.leaflet-popup-content-wrapper { border-radius: 12px; box-shadow: var(--shadow-lg); }

.apl-feed { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
.apl-feed-row { display: grid; grid-template-columns: 34px 1fr auto; gap: .7rem; padding: .7rem .9rem; border-bottom: 1px solid var(--color-border); align-items: start; cursor: pointer; }
.apl-feed-row:hover { background: var(--color-bg-hover); }
.apl-feed-row:last-child { border-bottom: 0; }
.apl-feed-icon { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--color-bg-secondary); border: 1px solid var(--color-border); font-size: .95rem; }
.apl-feed-main { min-width: 0; display: grid; gap: .15rem; }
.apl-feed-main p { margin: 0; font-size: .84rem; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.apl-feed-time { font-size: .76rem; color: var(--color-text-muted); white-space: nowrap; }

/* The admin's toasts sit at z-index 1000, under the drawer: lift them while it's open, and let clicks pass through */
body.apl-drawer-open .toast-container { z-index: 1350; }
body.apl-drawer-open .toast-container, body.apl-drawer-open .toast-container * { pointer-events: none !important; }
.apl-scrim { position: fixed; inset: 0; background: rgba(26,27,31,.36); z-index: 1200; animation: apl-fade .18s ease-out; }
.apl-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(1080px, 100vw); background: var(--color-bg); z-index: 1201; box-shadow: var(--shadow-lg); display: flex; flex-direction: column; animation: apl-in .26s cubic-bezier(.2,.8,.2,1); }
@keyframes apl-in { from { transform: translateX(28px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes apl-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .apl-drawer, .apl-scrim, .apl-sheet { animation: none !important; } .apl-card, .apl-pin { transition: none; } }
.apl-dhead { background: var(--color-bg-card); border-bottom: 1px solid var(--color-border); padding: .85rem 1.1rem; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; grid-template-areas: "avatar title actions nav"; gap: .4rem .85rem; align-items: center; }
.apl-dhead > .apl-avatar { grid-area: avatar; }
.apl-dhead .apl-dtitle { grid-area: title; }
.apl-dhead .apl-dactions { grid-area: actions; }
.apl-dhead .apl-dnav { grid-area: nav; display: flex; gap: .35rem; }
.apl-dhead .apl-avatar { width: 46px; height: 46px; font-size: .95rem; }
.apl-dtitle { min-width: 0; flex: 1; display: grid; gap: .2rem; }
.apl-dtitle h2 { margin: 0; font-size: 1.25rem; line-height: 1.2; text-transform: none; letter-spacing: -.01em; font-weight: 700; color: var(--color-text); font-family: inherit; }
.apl-dtitle p { margin: 0; font-size: .84rem; color: var(--color-text-secondary); }
.apl-dactions { display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
.apl-icon-btn { width: 38px; height: 38px; display: inline-grid; place-items: center; border-radius: 10px; border: 1px solid var(--color-border); background: var(--color-bg-card); cursor: pointer; color: var(--color-text); }
.apl-icon-btn:hover:not(:disabled) { background: var(--color-bg-hover); }
.apl-icon-btn:disabled { opacity: .4; cursor: default; }
.apl-icon-btn:focus-visible { outline: 2px solid var(--color-text); outline-offset: 1px; }
.apl-status-select { position: relative; }
.apl-status-select select, .apl-status-select select:not([multiple]):not([size]) { appearance: none; -webkit-appearance: none; background-image: none !important; padding: .45rem 2rem .45rem 1.7rem !important; width: auto !important; border-radius: 999px; font: inherit; font-weight: 650; font-size: .88rem; border: 1px solid color-mix(in srgb, var(--c) 35%, white); background: color-mix(in srgb, var(--c) 10%, white); color: color-mix(in srgb, var(--c) 80%, black); cursor: pointer; min-height: 38px; }
.apl-status-select::before { content: ''; position: absolute; left: .7rem; top: 50%; width: 8px; height: 8px; margin-top: -4px; border-radius: 50%; background: var(--c); pointer-events: none; }
.apl-status-select::after { content: ''; position: absolute; right: .85rem; top: 50%; width: 6px; height: 6px; border-right: 1.75px solid color-mix(in srgb, var(--c) 80%, black); border-bottom: 1.75px solid color-mix(in srgb, var(--c) 80%, black); transform: translateY(-70%) rotate(45deg); pointer-events: none; }
.apl-dbody { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, 1fr); grid-template-rows: minmax(0, 1fr); }
.apl-convo { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--color-border); }
.apl-thread { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .75rem; }
/* Phones and portrait iPads: Conversation and Details are tabs, each the full height */
.apl-dtabs { display: none; }
@media (max-width: 860px) {
  .apl-dtabs { display: flex; grid-column: 1 / -1; gap: 2px; padding: 3px; margin: .35rem 0 0; border-radius: 10px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); }
  .apl-dtabs button { flex: 1; min-height: 40px; border: 0; border-radius: 8px; background: none; font: inherit; font-size: .9rem; font-weight: 650; color: var(--color-text-secondary); cursor: pointer; }
  .apl-dtabs button[aria-selected="true"] { background: var(--color-bg-card); color: var(--color-text); box-shadow: var(--shadow-sm); }
  .apl-dhead { padding-bottom: .6rem; }
  .apl-dbody { grid-template-columns: minmax(0, 1fr); }
  .apl-dbody[data-pane="convo"] .apl-side, .apl-dbody[data-pane="details"] .apl-convo { display: none; }
  .apl-convo { border-right: 0; }
}
.apl-day { align-self: center; font-size: .74rem; font-weight: 650; color: var(--color-text-muted); background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 999px; padding: 2px 10px; }
.apl-msg { max-width: 88%; display: grid; gap: .3rem; }
.apl-msg-meta { font-size: .74rem; color: var(--color-text-muted); display: flex; gap: .4rem; flex-wrap: wrap; align-items: baseline; }
.apl-msg-meta b { color: var(--color-text-secondary); font-weight: 650; }
.apl-bubble { border-radius: 14px; padding: .65rem .85rem; font-size: .9rem; line-height: 1.5; border: 1px solid var(--color-border); background: var(--color-bg-card); overflow-wrap: anywhere; }
.apl-bubble h4 { margin: 0 0 .3rem; font-size: .86rem; }
.apl-bubble.is-clamped { max-height: 9.5em; overflow: hidden; position: relative; }
.apl-bubble.is-clamped::after { content: ''; position: absolute; inset: auto 0 0 0; height: 2.5em; background: linear-gradient(transparent, var(--bubble-bg, #fff)); }
.apl-more { all: unset; font-size: .78rem; font-weight: 600; color: var(--color-info); cursor: pointer; }
.apl-more:focus-visible { outline: 2px solid var(--color-text); border-radius: 4px; }
.apl-msg.is-out { align-self: flex-end; }
.apl-msg.is-out .apl-msg-meta { justify-content: flex-end; }
.apl-msg.is-out .apl-bubble { --bubble-bg: #FFF8D6; background: #FFF8D6; border-color: #F0DE8A; }
.apl-msg.is-text.is-out .apl-bubble { --bubble-bg: #1A1B1F; background: #1A1B1F; color: #fff; border-color: #1A1B1F; }
.apl-msg.is-text.is-in .apl-bubble { --bubble-bg: #EEF0F3; background: #EEF0F3; border-color: #E2E5EA; }
.apl-msg.is-note .apl-bubble { --bubble-bg: #F6F5F0; background: #F6F5F0; border-style: dashed; border-color: var(--color-border-strong); }
.apl-msg.is-in.is-email .apl-bubble { border-left: 3px solid var(--color-info); }
.apl-msg.is-internal { align-self: stretch; max-width: 100%; }
.apl-msg.is-internal .apl-bubble { --bubble-bg: #F6F5F0; background: #F6F5F0; border-style: dashed; border-color: var(--color-border-strong); font-size: .86rem; }
.apl-files { display: flex; flex-wrap: wrap; gap: .35rem; }
.apl-file-chip { font-size: .76rem; text-decoration: none; color: var(--color-text); border: 1px solid var(--color-border); background: var(--color-bg-card); border-radius: 8px; padding: 3px 8px; }
.apl-event { align-self: center; display: flex; gap: .45rem; align-items: center; font-size: .8rem; color: var(--color-text-secondary); max-width: 92%; text-align: center; justify-content: center; }
/* The words wrap beside the icon or pill; long details never run past the thread's edges */
.apl-event > span:last-child { min-width: 0; overflow-wrap: anywhere; }
.apl-event-sub { display: block; font-size: .76rem; color: var(--color-text-muted); }
.apl-event b { color: var(--color-text); }
.apl-event .apl-pill { font-size: .74rem; }
.apl-composer { border-top: 1px solid var(--color-border); background: var(--color-bg-card); padding: .75rem 1rem .9rem; display: grid; grid-template-columns: minmax(0, 1fr); gap: .55rem; }
.apl-composer-head { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; flex-wrap: wrap; }
.apl-composer-head b { font-size: .9rem; }
.apl-composer-head span { font-size: .78rem; color: var(--color-text-muted); }
.apl-composer textarea { min-height: 84px; resize: vertical; }
.apl-composer-foot { display: flex; justify-content: space-between; align-items: center; gap: .6rem; flex-wrap: wrap; font-size: .78rem; color: var(--color-text-muted); }
.apl-composer-foot .btn { margin-left: auto; }
@media (pointer: coarse) { .apl-kbd-hint { display: none; } }
/* On a phone the To and Subject fold into one line until tapped */
.apl-email-sum { display: none; }
.apl-to { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem; min-height: 40px; padding: .3rem .6rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-hover); font-size: .84rem; color: var(--color-text-secondary); }
.apl-thread-to { display: flex; align-items: center; justify-content: space-between; gap: .5rem; min-height: 40px; padding: .3rem .6rem; border: 1px solid #F0DE8A; border-radius: 8px; background: #FFF8D6; font-size: .84rem; color: var(--color-text-secondary); min-width: 0; }
.apl-thread-to span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apl-thread-to b { color: var(--color-text); }
.apl-msg-actions { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; }
.apl-inreply { font-size: .76rem; color: var(--color-text-muted); }
.apl-subject { display: flex; align-items: center; gap: .45rem; min-height: 40px; padding: 0 .6rem; border: 1px solid var(--color-border-strong); border-radius: 8px; background: var(--color-bg-card); font-size: .84rem; color: var(--color-text-secondary); cursor: text; }
.apl-subject:focus-within { border-color: var(--color-text); box-shadow: 0 0 0 3px rgba(26, 27, 31, .08); }
.apl-subject input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; padding: .45rem 0; font: inherit; font-size: .9rem; color: var(--color-text); }
.apl-to-chip { padding: .1rem .5rem; border-radius: 999px; background: var(--color-bg-card); border: 1px solid var(--color-border); color: var(--color-text); font-weight: 600; font-size: .8rem; }
@media (max-width: 640px) {
  .apl-composer:not(.is-head-open) .apl-email-row { display: none !important; }
  .apl-email-sum { all: unset; box-sizing: border-box; display: flex; gap: .4rem; align-items: center; min-height: 40px; font-size: .84rem; color: var(--color-text-secondary); cursor: pointer; }
  .apl-email-sum span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .apl-email-sum b { color: var(--color-text); font-weight: 650; }
  .apl-email-sum em { margin-left: auto; font-style: normal; font-weight: 650; color: var(--color-info); }
  .apl-composer { padding: .6rem .8rem calc(.7rem + env(safe-area-inset-bottom, 0px)); gap: .45rem; }
  .apl-composer textarea { min-height: 64px; }
}
.apl-side { overflow-y: auto; padding: 1rem 1.1rem 2rem; display: grid; gap: 1rem; align-content: start; }
.apl-panel { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: .85rem .95rem; display: grid; gap: .6rem; }
.apl-panel h3 { margin: 0; font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--color-text-secondary); display: flex; justify-content: space-between; align-items: center; }
.apl-kv { display: grid; grid-template-columns: minmax(110px, 38%) 1fr; gap: .1rem .6rem; align-items: center; }
.apl-kv dt { font-size: .8rem; color: var(--color-text-muted); padding: .35rem 0; }
.apl-kv dd { margin: 0; min-width: 0; }
.apl-edit { all: unset; display: block; width: 100%; box-sizing: border-box; padding: .35rem .5rem; margin-left: -.5rem; border-radius: 6px; cursor: text; font-size: .88rem; min-height: 1.4em; overflow-wrap: anywhere; white-space: pre-wrap; }
.apl-edit:hover { background: var(--color-bg-hover); }
.apl-edit:focus-visible { outline: 2px solid var(--color-text); }
.apl-edit.is-empty { color: var(--color-text-muted); font-style: italic; }
.apl-edit.is-saving { opacity: .55; }
.apl-edit.is-saved { animation: apl-saved 1.2s ease-out; }
@keyframes apl-saved { 0% { background: rgba(47,125,79,.16); } 100% { background: transparent; } }
.apl-kv .form-input, .apl-kv .form-select, .apl-kv textarea { font-size: .88rem; padding: .35rem .5rem; width: 100%; }
/* Every detail reads as plain text until you point at it, the same for choices and typed values */
.apl-kv .form-select { min-height: 32px; margin-left: -.5rem; width: calc(100% + .5rem); border-color: transparent; background-color: transparent; box-shadow: none; }
.apl-kv .form-select:hover:not(:focus) { border-color: var(--color-border); background-color: var(--color-bg-hover); }
.apl-kv .form-select:focus { background-color: var(--color-bg-card); }
@media (hover: hover) { .apl-kv select.form-select:not(:hover):not(:focus) { background-image: none !important; } }
.apl-kv .form-select.is-unset { color: var(--color-text-muted); font-style: italic; }
.apl-type-picks { display: flex; flex-wrap: wrap; gap: .3rem; }
.apl-type-picks button { border: 1px solid var(--color-border); background: var(--color-bg-card); border-radius: 999px; padding: .25rem .65rem; font: inherit; font-size: .8rem; cursor: pointer; min-height: 30px; }
.apl-type-picks button[aria-pressed="true"] { background: var(--color-primary-bg); border-color: #E9C700; color: #5A4600; font-weight: 650; }
.apl-contact { display: grid; gap: .15rem; padding: .5rem 0; border-bottom: 1px solid var(--color-border); }
.apl-contact:last-child { border-bottom: 0; padding-bottom: 0; }
.apl-contact strong { font-size: .9rem; }
.apl-contact a { font-size: .84rem; color: var(--color-info); text-decoration: none; }
.apl-contact a:hover { text-decoration: underline; }
.apl-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: .45rem; }
.apl-gallery a { display: block; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--color-bg-secondary); border: 1px solid var(--color-border); }
.apl-gallery img { width: 100%; height: 100%; object-fit: cover; transition: transform .2s; }
.apl-gallery a:hover img { transform: scale(1.04); }
.apl-doclist { display: grid; gap: .3rem; }
.apl-doclist a { display: flex; gap: .5rem; align-items: center; font-size: .86rem; text-decoration: none; color: var(--color-text); padding: .35rem .45rem; border-radius: 6px; }
.apl-doclist a:hover { background: var(--color-bg-hover); }
.apl-doclist small { color: var(--color-text-muted); margin-left: auto; white-space: nowrap; }
.apl-answers { display: grid; gap: .5rem; }
.apl-answers a { color: var(--color-info); }
.apl-answer-sec { border-top: 1px solid var(--color-border); padding-top: .4rem; }
.apl-answer-sec summary { cursor: pointer; font-size: .86rem; font-weight: 650; min-height: 32px; display: flex; align-items: center; }
.apl-answer-sec dl { margin: .2rem 0 .5rem; }
.apl-answer-sec dt { font-size: .76rem; color: var(--color-text-muted); margin-top: .45rem; }
.apl-answer-sec dd { margin: .1rem 0 0; font-size: .86rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.apl-answer-sec img { max-width: 140px; max-height: 110px; border-radius: 8px; border: 1px solid var(--color-border); }

.apl-sheet-wrap { position: fixed; inset: 0; z-index: 1300; display: grid; place-items: center; padding: 1rem; background: rgba(26,27,31,.42); animation: apl-fade .15s ease-out; }
.apl-sheet { width: min(620px, 100%); max-height: calc(100vh - 2rem); overflow: auto; background: var(--color-bg-card); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: 1.2rem 1.25rem; display: grid; gap: .9rem; animation: apl-pop .2s cubic-bezier(.2,.8,.2,1); }
@keyframes apl-pop { from { transform: translateY(8px) scale(.98); opacity: 0; } to { transform: none; opacity: 1; } }
.apl-sheet h2 { margin: 0; font-size: 1.15rem; }
.apl-sheet-move { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; font-size: .9rem; }
.apl-preview { border: 1px solid var(--color-border); border-radius: 12px; overflow: hidden; }
.apl-preview-head { background: var(--color-bg-secondary); padding: .55rem .8rem; font-size: .8rem; color: var(--color-text-secondary); display: grid; gap: .1rem; border-bottom: 1px solid var(--color-border); }
.apl-preview-head b { color: var(--color-text); }
.apl-preview-body { padding: .8rem .9rem; font-size: .88rem; line-height: 1.55; max-height: 300px; overflow: auto; }
.apl-check { display: flex; gap: .55rem; align-items: flex-start; font-size: .9rem; cursor: pointer; }
.apl-check input { width: 18px; height: 18px; margin-top: 2px; accent-color: #1A1B1F; flex: none; }
.apl-sheet-foot { display: flex; justify-content: flex-end; gap: .5rem; flex-wrap: wrap; }
.apl-callout { font-size: .84rem; border-radius: 10px; padding: .6rem .75rem; background: var(--color-bg-secondary); border: 1px solid var(--color-border); color: var(--color-text-secondary); }
.apl-callout.is-warn { background: #FFF6E0; border-color: #F2D899; color: #6B4A00; }
.apl-skel { color: var(--color-text-muted); font-size: .9rem; padding: 2rem; text-align: center; }
.apl-zero { text-align: center; padding: 2.5rem 1rem; color: var(--color-text-secondary); border: 1px dashed var(--color-border-strong); border-radius: var(--radius-md); background: var(--color-bg-card); }
@media (max-width: 900px) {
  .apl-filters { justify-content: flex-start; flex-basis: 100%; }
  .apl-search { max-width: none; }
}
.apl-sync-short { display: none; }
@media (max-width: 640px) {
  .apl > .page-header { gap: .6rem; }
  .apl-head-actions { width: 100%; }
  .apl-head-actions .apl-sync { flex: 1; min-width: 0; }
  .apl-sync-long { display: none; }
  .apl-sync-short { display: inline; }
  .apl-sync .btn { white-space: nowrap; }
  .apl-search { flex: 1 1 0; }
  .apl-filters .apl-season { display: none; }
  .apl-email-row { grid-template-columns: 1fr !important; }
  .apl-kv .form-select { min-height: 44px; }
  .apl-strip button, .apl-active button { min-height: 40px; }
  .apl-menu button { min-height: 44px; }
  .apl-dhead { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "avatar title nav" "actions actions actions"; }
  .apl-dhead { padding: .7rem .8rem; }
  .apl-thread, .apl-side { padding-left: .8rem; padding-right: .8rem; }
  .apl-kv { grid-template-columns: 1fr; }
  .apl-kv dt { padding-bottom: 0; }
  .apl-composer textarea, .apl-composer input, .apl-kv .form-input, .apl-kv .form-select { font-size: 16px; }
  .apl-type-picks button { min-height: 44px; }
  .apl-edit { min-height: 44px; display: flex; align-items: center; }
  .apl-icon-btn { width: 44px; height: 44px; }
  .apl-more { min-height: 36px; display: inline-flex; align-items: center; }
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

const Icon = {
  search: () => html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5" stroke-linecap="round"/></svg>`,
  close: () => html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/></svg>`,
  up: () => html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 10l4-4 4 4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  down: () => html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  ext: () => html`<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 3h4v4M13 3L7 9M12 10v3H3V4h3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  more: () => html`<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg>`,
  filter: () => html`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke-linecap="round"/></svg>`,
  x: () => html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-linecap="round"/></svg>`,
};
const FEED_ICON = { notify: '📨', status: '●', fields: '✎', comment: '💬', reply: '↩', textIn: '📱', textOut: '📱', call: '📞', sent: '✉', note: '📝', file: '📎', contact: '👤', home: '🏠', job: '🛠', created: '✨', archived: '🗄', unarchived: '🗄', renamed: '✎' };

const PHOTO_FROM = { page: 'Photo from their kid page', application: 'Photo from their application' };
/** Where the avatar comes from, and why it isn't the kid page's yet */
const photoTitle = (a) => [a.photo ? PHOTO_FROM[a.photoFrom] : null, a.kid && a.photoFrom !== 'page' ? 'their kid page has no photos yet' : null].filter(Boolean).join(' · ').replace(/^./, (c) => c.toUpperCase());
/** The child's photo (their kid page's once it has one, else the application's), or their initials */
function Avatar({ a, size = null }) {
  const c = STATUS_COLOR[a.status || ''];
  return html`<span class="apl-avatar" style=${`--c:${c}${size ? `;width:${size}px;height:${size}px` : ''}`} title=${photoTitle(a)} aria-hidden="true">
    ${initials(a.name)}${a.photo && html`<img key=${a.photo} src=${a.photo} alt="" loading="lazy" decoding="async" onError=${e => { e.currentTarget.style.display = 'none'; }} />`}
  </span>`;
}
const Pill = ({ status }) => html`<span class="apl-pill" style=${`--c:${STATUS_COLOR[status || '']}`}>${status || 'No status'}</span>`;

/** A JobTread account made for trying things out (the sample application, staff tests) */
const isTestFamily = (a) => !!a.isTest || /^TEST\b/.test(a.name || '');

function Flags({ a, compact = false }) {
  const out = [];
  if (a.area === 'outside') out.push(html`<span class="apl-tag is-out" title="Home is outside the service-area boundary">${a.areaMiles != null ? `${a.areaMiles} mi outside` : 'Outside area'}</span>`);
  if (a.repeat?.length) out.push(html`<span class="apl-tag is-warn" title=${`Possible repeat of ${a.repeat.join(', ')}`}>Possible repeat</span>`);
  if (a.lang === 'es' || a.fields?.language === 'Spanish') out.push(html`<span class="apl-tag is-es" title="The family reads Spanish: their emails go in Spanish">Spanish</span>`);
  if (isTestFamily(a)) out.push(html`<span class="apl-tag is-test">Test</span>`);
  if (a.archivedAt) out.push(html`<span class="apl-tag">Archived</span>`);
  if (!compact) for (const t of a.types || []) out.push(html`<span class="apl-tag">${TYPE_ICON[t] ? `${TYPE_ICON[t]} ` : ''}${t}</span>`);
  return out.length ? html`<div class="apl-tags">${out}</div>` : null;
}

function lastLine(a) {
  const l = a.lastActivity;
  if (!l) return a.createdAt ? `Added ${ago(a.createdAt)}` : '';
  const who = l.by && l.by !== 'JobTread' ? ` · ${l.by.split(' ')[0]}` : '';
  const what = l.kind === 'status' ? `Moved to ${a.status || 'no status'}` : l.kind === 'textIn' ? 'Text from the family' : l.kind === 'reply' ? 'Reply from the family' : cleanTitle(l.title || l.kind);
  return `${what}${who} · ${ago(a.lastActivityAt)}`;
}

// ─── The area ───────────────────────────────────────────────────────

const BUILT_IN_VIEWS = [['board', 'Board'], ['list', 'List'], ['map', 'Map'], ['activity', 'Activity']];
const AREA_LABEL = { inside: 'Inside the boundary', outside: 'Outside the boundary', unknown: 'No map point' };

/**
 * The Applicants tab. ./applications.js adds to it:
 *  - extraViews: [{ key, label, count, render }] beside Board, List, Map, Activity
 *  - notice: shown under the toolbar (for example, applications that didn't reach JobTread)
 *  - menuItems: more entries for the ⋯ menu ({ label, hint, onSelect } or '-')
 *  - route: { view, application, editBoundary, n } from the address bar; a new n applies it
 */
export function ApplicantsArea({ addToast, extraViews = [], notice = null, menuItems = [], route = null }) {
  injectCss();
  const viewKeys = [...BUILT_IN_VIEWS.map(v => v[0]), ...extraViews.map(v => v.key)];
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [view, setViewRaw] = useState(() => {
    if (route?.view && viewKeys.includes(route.view)) return route.view;
    try { const v = localStorage.getItem('apl-view'); return BUILT_IN_VIEWS.some(x => x[0] === v) ? v : 'board'; } catch { return 'board'; }
  });
  const [q, setQ] = useState('');
  const [year, setYear] = useState(null);
  const [type, setType] = useState('');
  const [area, setArea] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [archived, setArchived] = useState(false);
  const [tests, setTests] = useState(false); // test accounts (TEST…) stay off the board unless asked for
  const [openId, setOpenId] = useState(() => (location.hash.match(/^#applications\/applicants\/([A-Za-z0-9]{6,32})(?:\/reply\/[A-Za-z0-9_-]{4,64})?$/) || [])[1] || null);
  // A family-reply alert's Reply link: open the family answering in that JobTread thread
  const [replyLink] = useState(() => (location.hash.match(/^#applications\/applicants\/[A-Za-z0-9]{6,32}\/reply\/([A-Za-z0-9_-]{4,64})$/) || [])[1] || null);
  const [sheet, setSheet] = useState(null);       // { a, status }
  const [syncing, setSyncing] = useState(false);
  const [focusPin, setFocusPin] = useState(null);
  const [editBoundary, setEditBoundary] = useState(!!route?.editBoundary);
  const [busy, setBusy] = useState('');
  const [cleanup, setCleanup] = useState(false); // the "Pause family emails" sheet
  const searchRef = useRef(null);

  const setView = (v) => {
    setViewRaw(v);
    if (!openId) history.replaceState(null, '', extraViews.some(x => x.key === v) ? `#applications/${v}` : '#applications/applicants');
  };
  const load = useCallback(async (quiet = false) => {
    const j = await call(`${API}?list=1${archived ? '&archived=1' : ''}`);
    if (!j.success) { if (!quiet) setErr(j.error || 'Could not load applicants'); return; }
    setErr(null);
    setData(j);
    setYear(y => (y == null ? (j.applicants.some(a => a.year === j.season && !a.archivedAt) ? j.season : '') : y));
  }, [archived]);
  useEffect(() => { load(); }, [load]);
  // Stay current while the page is open (JobTread changes arrive through the sweep)
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, 60000);
    return () => clearInterval(t);
  }, [load]);
  // Back on the tab (say, after changing something in JobTread): catch up on JobTread's changes now
  const caughtUp = useRef(0);
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== 'visible' || Date.now() - caughtUp.current < 20000) return;
      caughtUp.current = Date.now();
      await call(API, { sync: 'catchup' });
      load(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);
  // Remember the last board, list, map or activity view (a view from ./applications.js is opened on purpose each time)
  useEffect(() => { if (BUILT_IN_VIEWS.some(v => v[0] === view)) { try { localStorage.setItem('apl-view', view); } catch { /* private mode */ } } }, [view]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && !document.activeElement?.isContentEditable && !document.querySelector('.apl-drawer, .apl-sheet-wrap, .modal-overlay')) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const open = (id) => {
    setOpenId(id);
    history.replaceState(null, '', id ? `#applications/applicants/${id}` : extraViews.some(x => x.key === view) ? `#applications/${view}` : '#applications/applicants');
  };

  // A link from somewhere else: a view, the boundary editor, or one website application
  // (which opens that family when they're in JobTread, else its row in Submissions)
  useEffect(() => {
    if (!route) return;
    if (route.view && viewKeys.includes(route.view)) { setViewRaw(route.view); setOpenId(null); }
    if (route.editBoundary) { setViewRaw('map'); setEditBoundary(true); setOpenId(null); }
    if (route.account && /^[A-Za-z0-9]{6,32}$/.test(route.account)) setOpenId(route.account);
  }, [route?.n]);
  const placed = useRef(null);
  useEffect(() => {
    if (!route?.application || !data || placed.current === route.n) return;
    placed.current = route.n;
    const a = data.applicants.find(x => x.applicationId === route.application);
    if (a) { setOpenId(a.id); history.replaceState(null, '', `#applications/applicants/${a.id}`); }
    else if (viewKeys.includes('submissions')) setViewRaw('submissions');
  }, [data, route?.n]);

  const all = useMemo(() => (data?.applicants || []).filter(a => tests || !isTestFamily(a)), [data, tests]);
  const testCount = useMemo(() => (data?.applicants || []).filter(isTestFamily).length, [data]);
  const years = useMemo(() => {
    const m = new Map();
    for (const a of all) if (a.year) m.set(a.year, (m.get(a.year) || 0) + 1);
    return [...m.entries()].sort((x, y) => y[0].localeCompare(x[0]));
  }, [all]);
  const counties = useMemo(() => [...new Set(all.map(a => a.county).filter(Boolean))].sort(), [all]);
  const [county, setCounty] = useState('');
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter(a => {
      if (year && a.year !== year) return false;
      if (type && !(a.types || []).includes(type)) return false;
      if (county && a.county !== county) return false;
      if (area && a.area !== area) return false;
      if (statusFilter && view !== 'board' && (a.status || '') !== statusFilter) return false;
      if (words.length) {
        const hay = [a.name, a.contact?.name, a.contact?.email, a.contact?.phone, a.address, a.city, a.county, a.fields?.diagnosis, a.fields?.referredBy].join(' ').toLowerCase();
        if (!words.every(w => hay.includes(w))) return false;
      }
      return true;
    });
  }, [all, q, year, type, county, area, statusFilter, view]);
  // The status counts leave the status filter out, so every count stays visible while one is picked
  const counts = useMemo(() => {
    const m = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]));
    const words = q.trim().toLowerCase();
    for (const a of all) {
      if ((year && a.year !== year) || (type && !(a.types || []).includes(type)) || (county && a.county !== county) || (area && a.area !== area)) continue;
      if (words && !words.split(/\s+/).every(w => [a.name, a.contact?.name, a.contact?.email, a.contact?.phone, a.address, a.city, a.county, a.fields?.diagnosis, a.fields?.referredBy].join(' ').toLowerCase().includes(w))) continue;
      if (m[a.status] != null) m[a.status]++;
    }
    return m;
  }, [all, q, year, type, county, area]);

  const askStatus = (a, status) => { if (a.status !== status) setSheet({ a, status }); };
  const afterChange = (applicant) => {
    if (!applicant) return load(true);
    setData(d => d && { ...d, applicants: d.applicants.map(x => (x.id === applicant.id ? { ...x, ...applicant } : x)) });
    load(true);
  };
  // Only offered when the automatic check has a problem
  const checkNow = async () => {
    setSyncing(true);
    const j = await call(API, { sync: true });
    setSyncing(false);
    if (!j.success) { addToast(j.error || 'JobTread didn’t answer. Try again in a minute.', 'error'); load(true); return; }
    addToast('JobTread answered. Everything here is up to date.', 'success');
    load(true);
  };
  const post = async (body, key, done) => {
    setBusy(key);
    const j = await call(API, body);
    setBusy('');
    if (!j.success) { addToast(j.error || 'That didn’t work', 'error'); return false; }
    if (done) addToast(done, 'info');
    load(true);
    return true;
  };
  const startCleanup = async () => {
    if (await post({ pause: { minutes: 120 } }, 'pause', 'Family emails are paused. Change what you need, then choose “Turn family emails back on”.')) setCleanup(false);
  };
  const doneCleanup = () => post({ resume: true }, 'resume', 'Family emails are back on. Choose which held emails still go.');

  if (err && !data) return html`<div class="apl-zero"><p><strong>Couldn't load applicants.</strong></p><p>${err}</p><button class="btn btn-ghost" onClick=${() => load()}>Try again</button></div>`;
  if (!data) return html`<div class="apl-skel"><span class="spinner" /> Loading applicants from JobTread…</div>`;

  const sync = data.sync || {};
  const problem = sync.problem || null;
  const idx = shown.findIndex(a => a.id === openId);
  const extra = extraViews.find(v => v.key === view);
  const season = data.season;
  const offSeason = year !== season;
  const active = [
    offSeason && { key: 'year', text: year ? `${year} season` : 'All years', clear: () => setYear(season) },
    type && { key: 'type', text: `${TYPE_ICON[type] ? `${TYPE_ICON[type]} ` : ''}${type}`, clear: () => setType('') },
    county && { key: 'county', text: `${county} County`, clear: () => setCounty('') },
    area && { key: 'area', text: AREA_LABEL[area], clear: () => setArea('') },
    archived && { key: 'archived', text: 'Including archived', clear: () => setArchived(false) },
    tests && { key: 'tests', text: 'Including test families', clear: () => setTests(false) },
  ].filter(Boolean);
  const inPanel = [type, county, area, archived, tests].filter(Boolean).length;
  const clearAll = () => { setYear(season); setType(''); setCounty(''); setArea(''); setArchived(false); setTests(false); };
  const emails = data.emails || {};
  const menu = [
    emails.active
      ? { label: 'Turn family emails back on', hint: `Paused until ${clock(emails.until)}. Next, you choose which held emails still go.`, onSelect: doneCleanup }
      : { label: 'Pause family emails', hint: 'Changing a lot of statuses at once? Families aren’t emailed about each change. Afterward, you choose which emails still go.', onSelect: () => setCleanup(true) },
    ...(menuItems.length ? ['-', ...menuItems] : []),
  ];

  return html`<div class="apl">
    <div class="page-header">
      <div>
        <h2>Applicants</h2>
        <p class="page-sub">Every family who applied, read from JobTread. Moves, emails and edits here save straight to JobTread.</p>
      </div>
      <div class="apl-head-actions">
        <span class=${`apl-sync ${problem ? 'is-problem' : ''}`} aria-live="polite" title=${sync.eventsCheckedAt ? `Last checked ${fullDate(sync.eventsCheckedAt)}` : ''}>
          <span class=${`apl-dot ${problem ? 'is-stale' : 'is-live'}`}></span>
          ${problem
            ? html`<span>${problem.reason}${problem.since ? ` Since ${clock(problem.since)}.` : ''}</span>`
            : sync.eventsCheckedAt
              ? html`<span class="apl-sync-long">In sync with JobTread · checked ${ago(sync.eventsCheckedAt)}</span><span class="apl-sync-short">Synced ${ago(sync.eventsCheckedAt)}</span>`
              : html`<span>Reading JobTread for the first time…</span>`}
          ${!problem && !sync.historyDone && sync.historyBackTo ? html`<span class="apl-sync-long"> · loading history (back to ${new Date(sync.historyBackTo).toLocaleDateString([], { month: 'short', year: 'numeric' })})</span>` : null}
        </span>
        ${problem && html`<button class="btn btn-ghost btn-sm" onClick=${checkNow} disabled=${syncing}>${syncing ? 'Checking…' : 'Check JobTread now'}</button>`}
        <${MoreMenu} items=${menu} busy=${!!busy} />
      </div>
    </div>

    <div class="apl-toolbar">
      <div class="apl-views" role="group" aria-label="View">
        ${[...BUILT_IN_VIEWS, ...extraViews.map(v => [v.key, v.label, v.count])].map(([k, label, n]) => html`
          <button aria-pressed=${view === k} data-view=${k} onClick=${() => setView(k)}>${label}${n > 0 && html`<span class="apl-view-n" title=${`${n} need${n === 1 ? 's' : ''} a look`}>${n}</span>`}</button>`)}
      </div>
      ${!extra && html`<div class="apl-filters">
        <label class="apl-search">${Icon.search()}<input ref=${searchRef} class="form-input" type="search" placeholder="Search name, parent, address…" value=${q} onInput=${e => setQ(e.target.value)} aria-label="Search applicants" />${!q && html`<kbd>/</kbd>`}</label>
        <select class="form-select apl-season" value=${year || ''} onChange=${e => setYear(e.target.value)} aria-label="Makeover year">
          <option value="">All years (${all.length})</option>
          ${years.map(([y, n]) => html`<option value=${y}>${y}${y === season ? ' season' : ''} (${n})</option>`)}
        </select>
        <${FiltersButton} count=${inPanel} onClear=${clearAll}>
          <label class="apl-pop-season">Makeover year
            <select class="form-select" value=${year || ''} onChange=${e => setYear(e.target.value)} aria-label="Makeover year (filters)">
              <option value="">All years (${all.length})</option>
              ${years.map(([y, n]) => html`<option value=${y}>${y}${y === season ? ' season' : ''} (${n})</option>`)}
            </select>
          </label>
          <label>Makeover
            <select class="form-select" value=${type} onChange=${e => setType(e.target.value)} aria-label="Makeover type">
              <option value="">Any makeover</option>
              ${(data.fields?.types?.options || []).map(t => html`<option value=${t}>${t}</option>`)}
            </select>
          </label>
          <label>County
            <select class="form-select" value=${county} onChange=${e => setCounty(e.target.value)} aria-label="County">
              <option value="">Any county</option>
              ${counties.map(c => html`<option value=${c}>${c}</option>`)}
            </select>
          </label>
          <label>Service area
            <select class="form-select" value=${area} onChange=${e => setArea(e.target.value)} aria-label="Service area">
              <option value="">In or out of the area</option>
              <option value="inside">Inside the boundary</option>
              <option value="outside">Outside the boundary</option>
              <option value="unknown">No map point</option>
            </select>
          </label>
          <span class="apl-check" style="font-size:.86rem;font-weight:600;color:var(--color-text)"><input type="checkbox" id="apl-archived" checked=${archived} onChange=${e => setArchived(e.target.checked)} /><label for="apl-archived" style="all:unset;cursor:pointer">Include archived families</label></span>
          ${testCount > 0 && html`<span class="apl-check" style="font-size:.86rem;font-weight:600;color:var(--color-text)"><input type="checkbox" id="apl-tests" checked=${tests} onChange=${e => setTests(e.target.checked)} /><label for="apl-tests" style="all:unset;cursor:pointer">Include test families (${testCount})</label></span>`}
        <//>
      </div>`}
    </div>
    ${!extra && active.length > 0 && html`<div class="apl-active" aria-label="Filters in use">
      ${active.map(f => html`<button key=${f.key} onClick=${f.clear} aria-label=${`Remove filter: ${f.text}`}>${f.text}${Icon.x()}</button>`)}
      ${active.length > 1 && html`<button class="apl-clear" onClick=${clearAll}>Clear all</button>`}
    </div>`}

    ${!extra && notice}
    <${EmailBanner} emails=${emails} busy=${busy} onPost=${post} onDone=${doneCleanup} onOpen=${open} addToast=${addToast} onChanged=${() => load(true)} />

    ${(view === 'list' || view === 'map') && html`<div class="apl-strip" role="group" aria-label="Show status">
      <button class="is-all" aria-pressed=${!statusFilter} onClick=${() => setStatusFilter('')}>All <b>${STATUS_ORDER.reduce((n, s) => n + counts[s], 0)}</b></button>
      ${STATUS_ORDER.map(s => html`
        <button style=${`--c:${STATUS_COLOR[s]}`} aria-pressed=${statusFilter === s} onClick=${() => setStatusFilter(f => (f === s ? '' : s))} title=${STATUS_HINT[s]}>
          <span class="apl-dot"></span>${s} <b>${counts[s]}</b>
        </button>`)}
    </div>`}

    ${view === 'board' && html`<${Board} list=${shown} onOpen=${open} onMove=${askStatus} />`}
    ${view === 'list' && html`<${ListView} list=${shown} onOpen=${open} />`}
    ${view === 'map' && html`<${MapView} list=${shown} boundary=${data.boundary} focus=${focusPin} startEditing=${editBoundary} onEditDone=${() => setEditBoundary(false)} onOpen=${open} addToast=${addToast} onSaved=${() => load(true)} />`}
    ${view === 'activity' && html`<${ActivityView} onOpen=${open} />`}
    ${extra && extra.render()}

    ${openId && html`<${Drawer}
      id=${openId}
      replyLink=${replyLink}
      fields=${data.fields}
      boundary=${data.boundary}
      summary=${(data.applicants || []).find(a => a.id === openId)}
      onClose=${() => open(null)}
      onPrev=${idx > 0 ? () => open(shown[idx - 1].id) : null}
      onNext=${idx >= 0 && idx < shown.length - 1 ? () => open(shown[idx + 1].id) : null}
      onStatus=${askStatus}
      onChanged=${afterChange}
      onShowOnMap=${(a) => { open(null); setFocusPin(a.id); setView('map'); }}
      addToast=${addToast} />`}
    ${sheet && html`<${StatusSheet} a=${sheet.a} status=${sheet.status} paused=${!!emails.active} onClose=${() => setSheet(null)} onDone=${(applicant) => { setSheet(null); afterChange(applicant); }} addToast=${addToast} />`}
    ${cleanup && html`<${CleanupSheet} busy=${busy === 'pause'} onClose=${() => setCleanup(false)} onStart=${startCleanup} />`}
  </div>`;
}

/** Pausing family emails: what happens, in order, before anything holds */
function CleanupSheet({ busy, onClose, onStart }) {
  const go = useRef(null);
  useEffect(() => { go.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const until = clock(Date.now() + 120 * 60000);
  return html`<div class="apl-sheet-wrap" onClick=${e => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="apl-sheet" role="dialog" aria-modal="true" aria-labelledby="apl-clean-title">
      <h2 id="apl-clean-title">Pause family emails?</h2>
      <p style="margin:0">Normally, every status change emails that family. Pause first when you’re changing a lot of statuses at once, like tidying up in JobTread.</p>
      <ol class="apl-steps-list">
        <li>Change as many statuses as you need, here or in JobTread. No family is emailed.</li>
        <li>When you finish, choose <strong>Turn family emails back on</strong>. If you forget, they come back on by themselves at ${until}.</li>
        <li>Then you see every email that was held and choose which ones still go. None go unless you choose.</li>
      </ol>
      <div class="apl-sheet-foot">
        <button class="btn btn-ghost" onClick=${onClose}>Cancel</button>
        <button class="btn btn-primary" ref=${go} onClick=${onStart} disabled=${busy}>${busy ? 'Pausing…' : 'Pause family emails'}</button>
      </div>
    </div>
  </div>`;
}

/** Open state for a popover that closes on Escape and on a click anywhere else */
function usePopover() {
  const [open, setOpenState] = useState(false);
  const ref = useRef(null);
  // Closed means closed at once: its listeners go after the next paint, and until then
  // they must not take an Escape or a click meant for whatever opened next
  const isOpen = useRef(false);
  const setOpen = useCallback((v) => { isOpen.current = typeof v === 'function' ? !!v(isOpen.current) : !!v; setOpenState(isOpen.current); }, []);
  // Escape closes it. Its wrapper listens too (onKeyDown, pop.onKey), so it works from the
  // moment it opens: the document listener below only arrives after the next paint
  const onKey = useCallback((e) => {
    if (e.key !== 'Escape' || !isOpen.current) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    ref.current?.querySelector('[aria-expanded]')?.focus();
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (isOpen.current && ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  return { open, setOpen, ref, onKey };
}

/** The ⋯ menu: occasional actions, each with a line saying what it does */
function MoreMenu({ items, busy = false }) {
  const pop = usePopover();
  const list = useRef(null);
  useEffect(() => { if (pop.open) requestAnimationFrame(() => list.current?.querySelector('button:not([aria-disabled="true"])')?.focus()); }, [pop.open]);
  const onKey = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(e.key)) return;
    if (e.key === 'Tab') { pop.setOpen(false); return; }
    e.preventDefault();
    const btns = [...list.current.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    btns[next]?.focus();
  };
  if (!items.length) return null;
  return html`<div class="apl-pop-wrap" ref=${pop.ref} onKeyDown=${pop.onKey}>
    <button class="btn btn-ghost btn-sm apl-more-btn" aria-haspopup="menu" aria-expanded=${pop.open} aria-label="More actions" title="More actions" disabled=${busy} onClick=${() => pop.setOpen(o => !o)}>${Icon.more()}</button>
    ${pop.open && html`<div class="apl-menu" role="menu" aria-label="More actions" ref=${list} onKeyDown=${onKey}>
      ${items.map((it, i) => (it === '-' ? html`<hr key=${`sep${i}`} />` : html`
        <button key=${it.label} role="menuitem" aria-disabled=${it.disabled ? 'true' : undefined} onClick=${() => { if (it.disabled) return; pop.setOpen(false); it.onSelect(); }}>
          ${it.label}${it.hint && html`<small>${it.hint}</small>`}
        </button>`))}
    </div>`}
  </div>`;
}

/** Filters: one button; the panel holds the less-used ones */
function FiltersButton({ count, onClear, children }) {
  const pop = usePopover();
  return html`<div class="apl-pop-wrap" ref=${pop.ref} onKeyDown=${pop.onKey}>
    <button class="btn btn-ghost apl-fbtn" aria-haspopup="dialog" aria-expanded=${pop.open} onClick=${() => pop.setOpen(o => !o)}>${Icon.filter()} Filters${count ? html`<b aria-label=${`${count} in use`}>${count}</b>` : ''}</button>
    ${pop.open && html`<div class="apl-popover" role="dialog" aria-label="Filters">
      ${children}
      <div class="apl-popover-foot">
        <button class="btn btn-ghost btn-sm" onClick=${onClear} disabled=${!count}>Clear all</button>
        <button class="btn btn-primary btn-sm" onClick=${() => pop.setOpen(false)}>Done</button>
      </div>
    </div>`}
  </div>`;
}

/** Family emails paused, the emails held meanwhile (chosen family by family), and a stalled sweep */
const HELD_LABEL = { welcome: 'Application received', inReview: 'In review', approved: 'Approved', denied: 'Denied' };
function EmailBanner({ emails, busy, onPost, onDone, onOpen, addToast, onChanged }) {
  const [each, setEach] = useState('');
  if (!emails) return null;
  const held = emails.held || [];
  if (!emails.active && !held.length && !(emails.overdue > 0)) return null;
  const one = async (h, action) => {
    setEach(h.account_id);
    const j = await call(API, { notify: { id: h.account_id, action } });
    setEach('');
    if (!j.success) { addToast(j.error || 'That didn’t work', 'error'); return; }
    addToast(action === 'send' ? `Emailed ${h.name}’s family` : `${h.name}’s family won’t get this one`, 'success');
    onChanged();
  };
  return html`<div style="display:grid;gap:.5rem">
    ${emails.active
      ? html`<div class="apl-banner is-info" role="status"><p><strong>Family emails are paused</strong> until ${clock(emails.until)}${emails.by ? ` (paused by ${String(emails.by).split('@')[0]})` : ''}. Status changes won’t email families${held.length ? `; ${plural(held.length, 'email is', 'emails are')} held so far` : ''}.</p>
          <div class="apl-banner-actions"><button class="btn btn-primary btn-sm" onClick=${onDone} disabled=${!!busy}>${busy === 'resume' ? 'Turning on…' : 'Turn family emails back on'}</button></div></div>`
      : null}
    ${!emails.active && held.length > 0 && html`<div class="apl-banner apl-held" role="region" aria-label="Held emails">
      <p><strong>${plural(held.length, 'family email was', 'family emails were')} held while emails were paused.</strong> Choose which still go. Nothing is sent unless you choose.</p>
      <ul class="apl-held-list">
        ${held.map(h => html`<li key=${h.account_id}>
          <button class="apl-more" onClick=${() => onOpen(h.account_id)}>${h.name}</button>
          <span class="apl-card-sub">${HELD_LABEL[h.kind] || h.kind} email · now ${h.status || 'no status'}</span>
          <span class="apl-banner-actions">
            <button class="btn btn-ghost btn-sm" onClick=${() => one(h, 'skip')} disabled=${!!each || !!busy}>Don't send</button>
            <button class="btn btn-ghost btn-sm" onClick=${() => one(h, 'send')} disabled=${!!each || !!busy}>${each === h.account_id ? 'Sending…' : 'Send'}</button>
          </span>
        </li>`)}
      </ul>
      ${held.length > 1 && html`<div class="apl-banner-actions apl-held-all">
        <button class="btn btn-ghost btn-sm" onClick=${() => onPost({ held: 'skip' }, 'skip', 'None of the held emails will go')} disabled=${!!busy || !!each}>Send none</button>
        <button class="btn btn-primary btn-sm" onClick=${() => onPost({ held: 'send' }, 'send', 'All the held emails are going out')} disabled=${!!busy || !!each}>${busy === 'send' ? 'Sending…' : `Send all ${held.length}`}</button>
      </div>`}
    </div>`}
    ${emails.overdue > 0 && html`<div class="apl-banner is-warn" role="alert"><p><strong>${plural(emails.overdue, 'family email is', 'family emails are')} overdue.</strong> The background check that sends them may have stopped. Opening this page sends them now; if this keeps showing, tell Peter.</p></div>`}
  </div>`;
}

// ─── Board ──────────────────────────────────────────────────────────

let lastDragEnd = 0;
function Board({ list, onOpen, onMove }) {
  const cols = useRef({});
  const byId = useMemo(() => new Map(list.map(a => [a.id, a])), [list]);
  const groups = useMemo(() => {
    const g = Object.fromEntries(STATUS_ORDER.map(s => [s, []]));
    const none = [];
    for (const a of list) (g[a.status] || none).push(a);
    // Longest waiting first in the working columns; newest decisions first in the last two
    for (const s of STATUS_ORDER) {
      g[s].sort((x, y) => (s === 'Applied' || s === 'In Review'
        ? String(x.stageAt || x.createdAt).localeCompare(String(y.stageAt || y.createdAt))
        : String(y.stageAt || y.createdAt).localeCompare(String(x.stageAt || x.createdAt))));
    }
    return { ...g, none };
  }, [list]);
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  const mapRef = useRef(byId);
  mapRef.current = byId;
  // Where one status shows at a time (too narrow for four columns): the one picked,
  // and when a search leaves it empty, the first status that has someone
  const [picked, setPicked] = useState(null);
  const shown = picked && (groups[picked].length || !STATUS_ORDER.some(s => groups[s].length)) ? picked : (STATUS_ORDER.find(s => groups[s].length) || 'Applied');

  useEffect(() => {
    const made = [];
    for (const s of STATUS_ORDER) {
      const el = cols.current[s];
      if (!el) continue;
      made.push(Sortable.create(el, {
        group: 'apl-board', sort: false, animation: 150, delay: 120, delayOnTouchOnly: true,
        draggable: '.apl-card', ghostClass: 'is-ghost', chosenClass: 'is-chosen', filter: '.apl-empty-col',
        onMove: (evt) => {
          for (const c of Object.values(cols.current)) c?.classList.toggle('is-target', c === evt.to && evt.to !== evt.from);
        },
        onEnd: (evt) => {
          lastDragEnd = Date.now();
          for (const c of Object.values(cols.current)) c?.classList.remove('is-target');
          if (evt.to === evt.from) return;
          // Put the card back: the move only happens once the sheet is confirmed
          const ref = evt.from.children[evt.oldIndex] || null;
          evt.from.insertBefore(evt.item, ref);
          const a = mapRef.current.get(evt.item.dataset.id);
          if (a) moveRef.current(a, evt.to.dataset.status);
        },
      }));
    }
    return () => made.forEach(s => s.destroy());
  }, []);

  const now = Date.now();
  // One season showing: its year on every card says nothing
  const oneYear = list.length > 0 && list.every(a => a.year === list[0].year);
  const column = (s) => html`
    <section class=${`apl-col ${s === shown ? 'is-shown' : ''}`} aria-label=${s} data-status=${s}>
      <div class="apl-col-head"><span class="apl-dot" style=${`background:${STATUS_COLOR[s]}`}></span><h3>${s}</h3><span class="apl-count">${groups[s].length}</span></div>
      <div class="apl-col-hint">${STATUS_HINT[s]}</div>
      <div class="apl-cards" ref=${el => { cols.current[s] = el; }} data-status=${s}>
        ${groups[s].map(a => {
          const days = daysSince(a.stageAt || a.createdAt, now);
          const long = (s === 'Applied' && days > 21) || (s === 'In Review' && days > 45);
          const age = ageOf(a.fields?.birthday);
          return html`<button class="apl-card" key=${a.id} data-id=${a.id} onClick=${() => { if (Date.now() - lastDragEnd > 350) onOpen(a.id); }} aria-label=${`${a.name}, ${s}. Open`}>
            <div class="apl-card-top"><${Avatar} a=${a} />
              <div style="min-width:0"><div class="apl-card-name">${a.name}</div>
              <div class="apl-card-sub">${[age != null ? `${age} yrs` : null, a.city || a.county, oneYear ? null : a.year].filter(Boolean).join(' · ')}</div></div>
            </div>
            <${Flags} a=${a} />
            ${a.notify && html`<div class="apl-tags">${a.notify.kind ? html`<span class=${`apl-mail ${a.notify.hold ? 'is-held' : ''}`} title=${a.notify.hold ? 'Held: family emails are paused' : `The ${a.notify.label} email goes out at ${clock(a.notify.dueAt)} unless the status changes back`}>${a.notify.hold ? 'Email held' : `Emails ${clock(a.notify.dueAt)}`}</span>` : a.notify.correction ? html`<span class="apl-mail is-fix" title=${`The family was emailed ${a.notify.told}, but the status is now ${a.status}`}>Needs a correction</span>` : null}</div>`}
            <div class="apl-card-foot"><span>${lastLine(a)}</span>${days != null && html`<span class=${`apl-stage ${long ? 'is-long' : ''}`} title=${`In ${s} for ${plural(days, 'day')}`}>${days}d</span>`}</div>
          </button>`;
        })}
        ${!groups[s].length && html`<div class="apl-empty-col">Nobody here${s === 'Applied' ? ' yet' : ''}. <span class="is-wide">Drag a family here to move them.</span><span class="is-narrow">To move a family, open them and change their status.</span></div>`}
      </div>
    </section>`;
  return html`<div class="apl-board-wrap">
    <div class="apl-board-tabs" role="group" aria-label="Show status">
      ${STATUS_ORDER.map(s => html`<button key=${s} style=${`--c:${STATUS_COLOR[s]}`} aria-pressed=${s === shown} onClick=${() => setPicked(s)} title=${STATUS_HINT[s]}>
        <span><i class="apl-dot" aria-hidden="true"></i>${s}</span><b>${groups[s].length}</b>
      </button>`)}
    </div>
    <div class="apl-board">${STATUS_ORDER.map(column)}</div>
    ${groups.none.length > 0 && html`<div class="apl-callout" style="margin-top:.75rem">${plural(groups.none.length, 'applicant has', 'applicants have')} a Makeover Year but no Status in JobTread: ${groups.none.slice(0, 6).map((a, i) => html`${i ? ', ' : ''}<button class="apl-more" onClick=${() => onOpen(a.id)}>${a.name}</button>`)}${groups.none.length > 6 ? '…' : ''}</div>`}
  </div>`;
}

// ─── List ───────────────────────────────────────────────────────────

const LIST_COLS = [
  { k: 'name', label: 'Name', get: a => a.name.toLowerCase() },
  { k: 'status', label: 'Status', get: a => STATUS_ORDER.indexOf(a.status) },
  { k: 'year', label: 'Year', get: a => a.year || '' },
  { k: 'types', label: 'Makeover', get: a => (a.types || []).join(',') },
  { k: 'county', label: 'County', get: a => a.county || '' },
  { k: 'area', label: 'Area', get: a => (a.area === 'outside' ? 100 + (a.areaMiles || 0) : a.area === 'inside' ? 0 : 50) },
  { k: 'stage', label: 'In status', get: a => -(Date.parse(a.stageAt || a.createdAt) || 0) },
  { k: 'last', label: 'Last activity', get: a => -(Date.parse(a.lastActivityAt || a.createdAt) || 0) },
];
function ListView({ list, onOpen }) {
  const [sort, setSort] = useState({ k: 'last', dir: 1 });
  const rows = useMemo(() => {
    const col = LIST_COLS.find(c => c.k === sort.k);
    return [...list].sort((x, y) => {
      const a = col.get(x);
      const b = col.get(y);
      return (a > b ? 1 : a < b ? -1 : 0) * sort.dir;
    });
  }, [list, sort]);
  if (!list.length) return html`<div class="apl-zero">No applicants match these filters.</div>`;
  const now = Date.now();
  const oneYear = list.every(a => a.year === list[0].year);
  return html`<div class="apl-list">
    <div class="apl-sortbar">
      <label>Sort by <select class="form-select" value=${sort.k} onChange=${e => setSort(s => ({ k: e.target.value, dir: s.dir }))} aria-label="Sort by">
        ${LIST_COLS.map(c => html`<option value=${c.k}>${c.label}</option>`)}
      </select></label>
      <button class="btn btn-ghost btn-sm" onClick=${() => setSort(s => ({ ...s, dir: -s.dir }))} aria-label=${sort.dir > 0 ? 'Sorted first to last; reverse' : 'Sorted last to first; reverse'}>${sort.dir > 0 ? '↑' : '↓'}</button>
    </div>
    <div class="apl-table-wrap"><table class="apl-table">
    <thead><tr>${LIST_COLS.map(c => html`<th aria-sort=${sort.k === c.k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}><button onClick=${() => setSort(s => ({ k: c.k, dir: s.k === c.k ? -s.dir : 1 }))}>${c.label}${sort.k === c.k ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`)}</tr></thead>
    <tbody>${rows.map(a => {
      const days = daysSince(a.stageAt || a.createdAt, now);
      return html`<tr key=${a.id} tabindex="0" onClick=${() => onOpen(a.id)} onKeyDown=${e => { if (e.key === 'Enter') onOpen(a.id); }}>
      <td><div style="display:flex;gap:.55rem;align-items:center"><${Avatar} a=${a} size=${28} /><div style="min-width:0"><strong>${a.name}</strong><div class="apl-card-sub">${a.contact?.name || ''}</div></div></div></td>
      <td><${Pill} status=${a.status} /></td>
      <td>${a.year || '—'}</td>
      <td>${(a.types || []).join(', ') || '—'}</td>
      <td>${a.county || '—'}</td>
      <td>${a.area === 'outside' ? html`<span class="apl-tag is-out">${a.areaMiles} mi outside</span>` : a.area === 'inside' ? 'Inside' : '—'}</td>
      <td>${days != null ? `${days}d` : '—'}</td>
      <td class="apl-card-sub apl-td-last">${lastLine(a)}</td>
      <td class="apl-td-meta">${[oneYear ? null : a.year, (a.types || []).join(', '), a.county, days != null ? `${days}d in ${a.status || 'no status'}` : null].filter(Boolean).join(' · ')}${a.area === 'outside' ? html` <span class="apl-tag is-out">${a.areaMiles} mi outside</span>` : ''}</td>
    </tr>`;
    })}</tbody>
  </table></div>
  </div>`;
}

// ─── Map ────────────────────────────────────────────────────────────

let _leaflet = null;
function loadLeaflet() {
  _leaflet ||= import('./vendor-map.js').then((m) => {
    const el = document.createElement('style');
    el.textContent = m.leafletCss;
    document.head.appendChild(el);
    return m.L;
  }).catch((e) => { _leaflet = null; throw e; });
  return _leaflet;
}

// The nearest point on the area's edge, so a home outside it is framed with the gap to the area
function nearestEdgePoint([lat, lng], polygon) {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = null;
  let bestD = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ay, ax] = polygon[j];
    const [by, bx] = polygon[i];
    const dx = (bx - ax) * k;
    const dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((lng - ax) * k * dx + (lat - ay) * dy) / (dx * dx + dy * dy))) : 0;
    const p = [ay + t * (by - ay), ax + t * (bx - ax)];
    const d = Math.hypot((lng - p[1]) * k, lat - p[0]);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** A family's home on a small map in their drawer: the streets around it, or the gap to the area when it's outside */
function HomeMap({ a, boundary }) {
  const box = useRef(null);
  const st = useRef({});
  const [L, setL] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { loadLeaflet().then(setL).catch(e => setErr(e.message)); }, []);

  // The map itself, once. A drawer that opens on Conversation (phones) has a hidden map, so it's framed when it shows.
  useEffect(() => {
    if (!L || !box.current || st.current.map) return;
    const map = L.map(box.current, { zoomControl: false, scrollWheelZoom: false, dragging: !L.Browser.mobile }); // phones: one finger scrolls the drawer, two move the map. Whole zoom levels only: in-between ones leave seams between tiles
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'apl-tiles',
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    const layers = L.layerGroup().addTo(map);
    let width = 0;
    const ro = new ResizeObserver(() => {
      const w = box.current?.offsetWidth || 0;
      if (w && !width) { map.invalidateSize(); st.current.frame?.(); } else if (w) map.invalidateSize();
      width = w;
    });
    ro.observe(box.current);
    st.current = { map, layers };
    return () => { ro.disconnect(); map.remove(); st.current = {}; };
  }, [L]);

  // The area, its "close" ring, and the home
  const poly = boundary?.live || [];
  const nearMiles = boundary?.nearMiles ?? 15;
  const polyKey = JSON.stringify(poly);
  useEffect(() => {
    const s = st.current;
    if (!L || !s.map) return;
    s.layers.clearLayers();
    const home = [a.lat, a.lng];
    const outside = a.area === 'outside' && poly.length >= 3;
    if (poly.length >= 3) {
      // Up close on a home inside, the yellow would wash over every street: just the line there
      const ring = outside && nearMiles > 0 ? nearRing(poly, nearMiles) : [];
      if (ring.length) L.polygon(ring, { color: AREA_INK, weight: 1.5, opacity: 0.6, dashArray: '5 6', fill: false, interactive: false }).addTo(s.layers);
      L.polygon(poly, { color: AREA_INK, weight: 2.5, opacity: 0.95, fill: outside, fillColor: AREA_FILL, fillOpacity: 0.16, interactive: false }).addTo(s.layers);
    }
    const edge = outside ? nearestEdgePoint(home, poly) : null;
    if (edge) {
      L.polyline([home, edge], { color: AREA_INK, weight: 2, dashArray: '2 6', opacity: 0.8, interactive: false }).addTo(s.layers);
      const label = L.divIcon({ className: '', html: `<span class="apl-gap">${esc(String(a.areaMiles))} mi</span>`, iconSize: [0, 0] });
      L.marker([(home[0] + edge[0]) / 2, (home[1] + edge[1]) / 2], { icon: label, interactive: false, keyboard: false }).addTo(s.layers);
    }
    const icon = L.divIcon({ className: '', html: `<div class="apl-pin is-focus" style="--c:${STATUS_COLOR[a.status || '']}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
    L.marker(home, { icon, title: a.address || a.name, keyboard: false }).addTo(s.layers);
    s.frame = () => {
      // The home, the gap, and a little of the area past its edge, so the shape reads
      if (edge) s.map.fitBounds(L.latLngBounds([home, [edge[0] + (edge[0] - home[0]) * 0.35, edge[1] + (edge[1] - home[1]) * 0.35]]), { padding: [30, 30], maxZoom: 13 });
      else s.map.setView(home, 13);
    };
    if (box.current?.offsetWidth) s.frame();
  }, [L, a.lat, a.lng, a.area, a.status, polyKey, nearMiles]);

  if (err) return null;
  return html`<div class="apl-homemap" ref=${box} role="region" aria-label=${`Map of ${a.address || 'the home'}${a.area === 'outside' ? `, ${a.areaMiles} miles outside the service area` : a.area === 'inside' ? ', inside the service area' : ''}`}></div>`;
}

function MapView({ list, boundary, focus, startEditing = false, onEditDone, onOpen, addToast, onSaved }) {
  const box = useRef(null);
  const st = useRef({});
  const [L, setL] = useState(null);
  const [err, setErr] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [editing, setEditing] = useState(false);
  const [draftPoly, setDraftPoly] = useState(null);
  const [busy, setBusy] = useState(false);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const startEdit = () => { setEditing(true); setDraftPoly(boundary?.live || []); };
  const stopEdit = () => { setEditing(false); setDraftPoly(null); onEditDone?.(); };
  // Arriving from Settings → Service area: straight into reshaping it
  useEffect(() => { if (startEditing && !editing) startEdit(); }, [startEditing]);

  useEffect(() => { loadLeaflet().then(setL).catch(e => setErr(e.message)); }, []);

  // The map itself, once
  useEffect(() => {
    if (!L || !box.current || st.current.map) return;
    const map = L.map(box.current, { zoomControl: false, scrollWheelZoom: true, attributionControl: true, zoomSnap: 0.25 });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    // OpenStreetMap's own tiles (no key; fine for a few staff), quieted to gray so the pins carry the color
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'apl-tiles',
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map);
    st.current = { map, pins: L.layerGroup().addTo(map), area: null, ring: null, handles: L.layerGroup().addTo(map), markers: new Map() };
    // The area and its "close" ring in view: the families near the edge are the ones to look at
    const poly = boundary?.live || [];
    const ring = poly.length >= 3 && boundary?.nearMiles > 0 ? nearRing(poly, boundary.nearMiles, 48) : [];
    if (poly.length >= 3) map.fitBounds(L.latLngBounds(ring.length ? ring : poly), { padding: [24, 24] });
    else map.setView([33.95, -84.35], 9);
    return () => { map.remove(); st.current = {}; };
  }, [L]);

  // The boundary (live, or the one being edited), and the "close" ring around it
  const poly = useMemo(() => draftPoly || boundary?.live || [], [draftPoly, boundary?.live]);
  const nearMiles = boundary?.nearMiles ?? 15;
  useEffect(() => {
    const s = st.current;
    if (!L || !s.map) return;
    if (s.area) s.area.remove();
    if (s.ring) s.ring.remove();
    s.ring = null;
    if (poly.length >= 3) {
      const ring = nearMiles > 0 ? nearRing(poly, nearMiles) : [];
      if (ring.length) s.ring = L.polygon(ring, { color: AREA_INK, weight: 1.5, opacity: 0.6, dashArray: '5 6', fill: false, interactive: false }).addTo(s.map);
      s.area = L.polygon(poly, { color: AREA_INK, weight: editing ? 3 : 2.5, opacity: 0.95, fillColor: AREA_FILL, fillOpacity: editing ? 0.2 : 0.16, dashArray: editing ? '6 6' : null, interactive: false }).addTo(s.map);
    }
    s.handles.clearLayers();
    if (!editing) return;
    const corner = L.divIcon({ className: '', html: '<div class="apl-handle"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
    const mid = L.divIcon({ className: '', html: '<div class="apl-handle is-mid"></div>', iconSize: [10, 10], iconAnchor: [5, 5] });
    poly.forEach((p, i) => {
      const m = L.marker(p, { icon: corner, draggable: true, keyboard: true, title: 'Drag to move this corner. Double-click to remove it.' }).addTo(s.handles);
      m.on('drag', (e) => { s.area?.setLatLngs(poly.map((q, j) => (j === i ? [e.latlng.lat, e.latlng.lng] : q))); });
      m.on('dragend', (e) => setDraftPoly(poly.map((q, j) => (j === i ? [e.target.getLatLng().lat, e.target.getLatLng().lng] : q))));
      m.on('dblclick', () => { if (poly.length > 3) setDraftPoly(poly.filter((_, j) => j !== i)); else addToast('A boundary needs at least 3 corners', 'info'); });
      const n = poly[(i + 1) % poly.length];
      const mm = L.marker([(p[0] + n[0]) / 2, (p[1] + n[1]) / 2], { icon: mid, draggable: true, title: 'Drag to add a corner here' }).addTo(s.handles);
      mm.on('dragend', (e) => { const ll = e.target.getLatLng(); setDraftPoly([...poly.slice(0, i + 1), [ll.lat, ll.lng], ...poly.slice(i + 1)]); });
    });
  }, [L, poly, editing]);

  // While reshaping: who the new outline moves in or out (against the one in use), ringed on the map
  const moves = useMemo(() => {
    if (!editing || !draftPoly || draftPoly.length < 3 || !boundary?.live) return [];
    const pts = list.filter(a => a.lat != null && a.lng != null).map(a => ({ id: a.id, lat: a.lat, lng: a.lng }));
    return bandChanges(pts, { polygon: boundary.live, nearMiles }, { polygon: draftPoly, nearMiles });
  }, [editing, draftPoly, boundary?.live, list, nearMiles]);
  const moving = useMemo(() => new Set(moves.map(m => m.id)), [moves]);
  const moveText = (() => {
    if (!moves.length) return draftPoly && JSON.stringify(draftPoly) !== JSON.stringify(boundary?.live) ? 'No family changes sides with this outline.' : null;
    const into = moves.filter(m => m.to === 'inside').length;
    const outOf = moves.filter(m => m.from === 'inside').length;
    const other = moves.length - into - outOf;
    return [into && `${plural(into, 'family moves', 'families move')} inside`, outOf && `${plural(outOf, 'family moves', 'families move')} outside`, other && `${plural(other, 'family', 'families')} change between close and farther out`].filter(Boolean).join(', ');
  })();

  // Pins
  useEffect(() => {
    const s = st.current;
    if (!L || !s.map) return;
    s.pins.clearLayers();
    s.markers.clear();
    for (const a of list) {
      if (a.lat == null || a.lng == null || hidden.has(a.status || '')) continue;
      const c = STATUS_COLOR[a.status || ''];
      const icon = L.divIcon({ className: '', html: `<div class="apl-pin${focus === a.id ? ' is-focus' : ''}${moving.has(a.id) ? ' is-moving' : ''}" style="--c:${c}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
      const m = L.marker([a.lat, a.lng], { icon, title: a.name, riseOnHover: true, keyboard: true }).addTo(s.pins);
      const div = document.createElement('div');
      div.className = 'apl-pop';
      div.innerHTML = `<strong>${esc(a.name)}</strong><span class="apl-pill" style="--c:${c}">${esc(a.status || 'No status')}</span><span style="font-size:.82rem;color:#5E5F66">${esc(a.address || '')}</span>${a.area === 'outside' ? `<span class="apl-tag is-out" style="justify-self:start">${a.areaMiles} mi outside the boundary</span>` : ''}<button class="btn btn-primary btn-sm" type="button">Open</button>`;
      div.querySelector('button').addEventListener('click', () => openRef.current(a.id));
      m.bindPopup(div, { closeButton: true, autoPanPadding: [40, 40] });
      s.markers.set(a.id, m);
    }
  }, [L, list, hidden, focus, moving]);

  // "Show on map" from a family's drawer (once, not on every refresh)
  const focused = useRef(null);
  useEffect(() => {
    const s = st.current;
    const m = focus && focus !== focused.current && s.markers?.get(focus);
    if (m) { focused.current = focus; s.map.setView(m.getLatLng(), Math.max(s.map.getZoom(), 13), { animate: true }); m.openPopup(); }
  }, [L, focus, list]);

  const counts = useMemo(() => {
    const m = { Applied: 0, 'In Review': 0, Approved: 0, Denied: 0, '': 0 };
    for (const a of list) if (a.lat != null) m[a.status || ''] = (m[a.status || ''] || 0) + 1;
    return m;
  }, [list]);
  const noPoint = list.filter(a => a.lat == null).length;
  const outside = list.filter(a => a.area === 'outside').length;

  // The boundary is a setting: saved, it's used for everyone at once (no form Put live)
  const save = async () => {
    setBusy(true);
    const j = await call(API, { boundary: draftPoly });
    if (!j.success) { setBusy(false); addToast(j.error || 'Could not save the boundary', 'error'); return; }
    await onSaved?.();
    setBusy(false);
    setEditing(false);
    setDraftPoly(null);
    onEditDone?.();
    addToast(j.changed ? 'The new boundary is in use. Every family was checked against it again.' : 'The boundary is the same as before.', 'info');
  };

  if (err) return html`<div class="apl-zero">The map couldn't load (${err}).</div>`;
  return html`<div class="apl-map-wrap">
    <div class="apl-map" ref=${box} role="region" aria-label="Map of applicants and the service-area boundary"></div>
    ${!L && html`<div class="apl-skel" style="position:absolute;inset:0;display:grid;place-items:center">Loading the map…</div>`}
    <div class="apl-legend">
      ${['Applied', 'In Review', 'Approved', 'Denied'].map(s => html`<button aria-pressed=${!hidden.has(s)} onClick=${() => setHidden(h => { const n = new Set(h); n.has(s) ? n.delete(s) : n.add(s); return n; })}>
        <span class="apl-dot" style=${`background:${STATUS_COLOR[s]};width:10px;height:10px`}></span>${s}<b>${counts[s]}</b></button>`)}
      <div class="apl-legend-line"><i></i> Service area${outside ? ` · ${outside} outside` : ''}</div>
      ${nearMiles > 0 && html`<div class="apl-legend-line" style="border-top: 0; margin-top: 0; padding-top: 0;"><i class="is-ring"></i> Close: within ${plural(nearMiles, 'mile')}</div>`}
      ${noPoint > 0 && html`<div class="apl-card-sub" style="padding:.2rem .35rem 0">${plural(noPoint, 'family has', 'families have')} no home in JobTread yet</div>`}
    </div>
    <div class="apl-map-tools">
      ${!editing && html`<button class="btn btn-ghost btn-sm" onClick=${startEdit}>Edit boundary</button>`}
    </div>
    ${editing && html`<div class="apl-map-note" role="status">
      <span>Drag a corner to move it, drag a small dot to add one, double-click a corner to remove it. Saving uses it for every family right away.${moveText ? html`<br /><b aria-live="polite">${moveText}</b>` : ''}</span>
      <button class="btn btn-ghost btn-sm" onClick=${stopEdit} disabled=${busy}>Cancel</button>
      <button class="btn btn-primary btn-sm" onClick=${save} disabled=${busy}>${busy ? 'Saving…' : 'Save boundary'}</button>
    </div>`}
  </div>`;
}

// ─── Activity across everyone ───────────────────────────────────────

function ActivityView({ onOpen }) {
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(true);
  const load = async (before = null) => {
    const j = await call(`${API}?activity=1${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    if (!j.success) return;
    setRows(r => (before ? [...(r || []), ...j.activity] : j.activity));
    setMore(j.activity.length >= 60);
  };
  useEffect(() => { load(); }, []);
  if (!rows) return html`<div class="apl-skel">Loading activity…</div>`;
  if (!rows.length) return html`<div class="apl-zero">Nothing yet. Activity from JobTread appears here as it happens.</div>`;
  return html`<div class="apl-feed">
    ${rows.map(r => html`<div class="apl-feed-row" key=${r.id} role="button" tabindex="0" onClick=${() => onOpen(r.accountId)} onKeyDown=${e => { if (e.key === 'Enter') onOpen(r.accountId); }}>
      <span class="apl-feed-icon" aria-hidden="true">${FEED_ICON[r.kind] || '•'}</span>
      <div class="apl-feed-main"><div><strong>${r.applicant}</strong> · ${cleanTitle(r.title || r.kind)}</div>
        ${r.body && html`<p>${r.body}</p>`}
        <span class="apl-card-sub">${r.by ? `${r.by} ` : ''}${SOURCE_LABEL[r.source] || ''}</span></div>
      <span class="apl-feed-time" title=${fullDate(r.at)}>${ago(r.at)}</span>
    </div>`)}
    ${more && html`<div style="padding:.75rem;text-align:center"><button class="btn btn-ghost btn-sm" onClick=${() => load(rows[rows.length - 1].at)}>Show older</button></div>`}
  </div>`;
}

// ─── One family (drawer) ────────────────────────────────────────────

function Drawer({ id, replyLink = null, fields, boundary, summary, onClose, onPrev, onNext, onStatus, onChanged, onShowOnMap, addToast }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [pane, setPane] = useState('convo'); // phones: which half shows
  const panel = useRef(null);
  const load = useCallback(async () => {
    const j = await call(`${API}?id=${encodeURIComponent(id)}`);
    if (!j.success) { setErr(j.error || 'Could not load'); return; }
    setErr(null);
    setD(j);
  }, [id]);
  useEffect(() => { setD(null); load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
    return () => clearInterval(t);
  }, [load]);
  // Keys work from the moment the drawer is on screen (an effect waits for the next paint, and an
  // Esc pressed on a busy page before then was lost), and focus comes back once, when it closes
  const keys = useRef({});
  keys.current = { onClose, onPrev, onNext };
  const attach = useCallback((el) => {
    if (el) {
      panel.current = el;
      const prev = document.activeElement;
      el.focus();
      const onKey = (e) => {
        const k = keys.current;
        if (e.key === 'Escape' && !document.querySelector('.apl-sheet-wrap')) { e.preventDefault(); k.onClose(); }
        const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
        if (!typing && e.key === 'k' && k.onPrev) k.onPrev();
        if (!typing && e.key === 'j' && k.onNext) k.onNext();
      };
      window.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
      document.body.classList.add('apl-drawer-open');
      el._detach = () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; document.body.classList.remove('apl-drawer-open'); if (prev?.isConnected) prev.focus?.(); };
    } else if (panel.current) {
      panel.current._detach?.();
      panel.current = null;
    }
  }, []);

  const a = d?.applicant ? { ...summary, ...d.applicant } : summary;
  const refresh = async (applicant) => { await load(); onChanged(applicant); };

  return html`<div>
    <div class="apl-scrim" onClick=${onClose}></div>
    <aside class="apl-drawer" role="dialog" aria-modal="true" aria-label=${a ? a.name : 'Applicant'} tabindex="-1" ref=${attach}>
      ${a && html`<header class="apl-dhead">
        <${Avatar} a=${a} />
        <div class="apl-dtitle">
          <h2>${a.name}</h2>
          <p>${[ageOf(a.fields?.birthday) != null ? `${ageOf(a.fields.birthday)} years old` : null, a.fields?.diagnosis ? a.fields.diagnosis.slice(0, 70) + (a.fields.diagnosis.length > 70 ? '…' : '') : null, a.year ? `${a.year} season` : null].filter(Boolean).join(' · ')}</p>
          <${Flags} a=${a} compact=${true} />
        </div>
        <div class="apl-dactions">
          <label class="apl-status-select" style=${`--c:${STATUS_COLOR[a.status || '']}`} title="Change status">
            <span class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Status</span>
            <select value=${a.status || ''} onChange=${e => { const v = e.target.value; e.target.value = a.status || ''; onStatus(a, v); }}>
              ${!a.status && html`<option value="">No status</option>`}
              ${STATUS_ORDER.map(s => html`<option value=${s}>${s}</option>`)}
            </select>
          </label>
          <a class="btn btn-ghost btn-sm" href=${a.jobtreadUrl} target="_blank" rel="noopener">JobTread ${Icon.ext()}</a>
        </div>
        <div class="apl-dnav">
          <button class="apl-icon-btn" onClick=${onPrev} disabled=${!onPrev} aria-label="Previous family (K)" title="Previous (K)">${Icon.up()}</button>
          <button class="apl-icon-btn" onClick=${onNext} disabled=${!onNext} aria-label="Next family (J)" title="Next (J)">${Icon.down()}</button>
          <button class="apl-icon-btn" onClick=${onClose} aria-label="Close (Esc)" title="Close (Esc)">${Icon.close()}</button>
        </div>
        <div class="apl-dtabs" role="tablist" aria-label="Show">
          <button role="tab" aria-selected=${pane === 'convo'} onClick=${() => setPane('convo')}>Conversation</button>
          <button role="tab" aria-selected=${pane === 'details'} onClick=${() => setPane('details')}>Details</button>
        </div>
      </header>`}
      ${err && html`<div class="apl-callout is-warn" style="margin:1rem">${err} <button class="apl-more" onClick=${load}>Try again</button></div>`}
      ${!d && !err && html`<div class="apl-skel">Reading ${summary?.name || 'this family'} from JobTread…</div>`}
      ${d && !a && html`<div class="apl-skel">This family isn't in JobTread any more. <button class="apl-more" onClick=${onClose}>Close</button></div>`}
      ${d && a && html`<div class="apl-dbody" data-pane=${pane}>
        <${Conversation} d=${{ ...d, applicant: a }} onSent=${refresh} addToast=${addToast} replyLink=${replyLink} />
        <${SidePanel} d=${{ ...d, applicant: a }} fields=${fields} boundary=${boundary} onSaved=${refresh} onShowOnMap=${onShowOnMap} addToast=${addToast} />
      </div>`}
    </aside>
  </div>`;
}

/** Comments (live from JobTread) and the history of everything else, in time order */
function timelineOf(d) {
  const siteBy = new Map();
  const fromLog = new Map();
  for (const r of d.activity || []) {
    if (!r.data?.commentId) continue;
    if (r.source === 'website' && ['sent', 'note', 'textOut'].includes(r.kind)) siteBy.set(r.data.commentId, r);
    else fromLog.set(r.data.commentId, r);
  }
  const items = [];
  // A family member writing in JobTread's family portal isn't an email reply, but it's them all the same
  const familyNames = new Set((d.applicant?.contacts || []).map(c => String(c.name || '').trim().toLowerCase()).filter(Boolean));
  const byId = new Map((d.comments || []).map(c => [c.id, c]));
  for (const c of d.comments || []) {
    if (c.name === 'Comms Thread' && !c.parentId) continue; // the texting thread's starter
    const msg = c.message || '';
    const site = siteBy.get(c.id);
    let kind = 'comment';
    if (/^\/text\s/i.test(msg)) continue;                   // the command; DataX logs the sent text
    if (/New (incoming|outgoing) _message_/i.test(msg)) kind = /incoming/i.test(msg) ? 'textIn' : 'textOut';
    else if (/New (incoming|outgoing) _call_/i.test(msg)) kind = 'call';
    else if (c.fromEmail || fromLog.get(c.id)?.source === 'family' || fromLog.get(c.id)?.kind === 'reply' || familyNames.has(String(c.by || '').trim().toLowerCase())) kind = 'reply';
    else if (site?.kind === 'note' || /_[^_]+, from the website_$/.test(msg)) kind = 'note';
    else if (site?.kind === 'sent' || c.to?.length || FAMILY_TITLES.has(c.name || '')) kind = 'sent';
    else if (c.by === 'Qualification Committee' || /\(automatic\)$/.test(c.name || '') || /^Moved back to /.test(msg)) kind = 'internal';
    // The conversation it belongs to: its first message (a reply's parent)
    const rootId = c.parentId || c.id;
    items.push({ type: 'msg', kind, at: c.at, c, site, rootId, rootTitle: byId.get(rootId)?.name || null });
  }
  // Staff answering inside a family's conversation are writing to the family
  const familyThreads = new Set(items.filter(it => it.kind === 'sent' || it.kind === 'reply').map(it => it.rootId));
  for (const it of items) if (it.kind === 'comment' && it.c.parentId && familyThreads.has(it.rootId)) it.kind = 'sent';
  // A move made on the site is in the history twice: the site's own line, and JobTread's record of
  // the same change (made with the site's key). Keep the site's, which says who and what was emailed.
  // The same goes for details changed on the site.
  const echoed = new Set(['status', 'fields']);
  const siteMoves = (d.activity || []).filter(r => echoed.has(r.kind) && String(r.id).startsWith('site:'));
  const fieldsOf = (r) => (r.data?.changes || []).map(c => c.field).sort().join();
  const same = (s, r) => s.kind === r.kind && (r.kind === 'status' ? (s.data?.to || '') === (r.data?.to || '') : fieldsOf(s) === fieldsOf(r));
  const echo = (r) => echoed.has(r.kind) && r.source === 'website' && !String(r.id).startsWith('site:')
    && siteMoves.some(s => same(s, r) && Math.abs(Date.parse(s.at) - Date.parse(r.at)) < 2 * 60 * 1000);
  // Oldest first, so lines written in the same moment keep the order they happened in
  for (const r of [...(d.activity || [])].reverse()) {
    if (COMMENT_KINDS.has(r.kind) || echo(r)) continue;
    items.push({ type: 'event', kind: r.kind, at: r.at, r });
  }
  // A status move made from the site leads the lines it set off (its own line is written last)
  const rank = (it) => (it.type === 'event' && it.kind === 'status' ? 0 : 1);
  return items.sort((x, y) => String(x.at).localeCompare(String(y.at)) || rank(x) - rank(y));
}

function textParts(msg) {
  const body = msg.replace(/^Company Number:[^\n]*\n+/i, '');
  const contact = (body.match(/Contact:\s*(.+)/) || [])[1] || '';
  const text = (body.match(/Message:\s*([\s\S]*)$/) || [])[1];
  const summary = (body.match(/Call Summary:\s*([\s\S]*)$/) || [])[1];
  return { contact, text: text != null ? text.trim() : null, summary: summary ? summary.trim() : null };
}

function Message({ it, onReply }) {
  const [openFull, setOpenFull] = useState(false);
  const { c, kind, site } = it;
  const out = ['sent', 'textOut', 'note'].includes(kind) || (kind === 'comment' && c.by !== null);
  const cls = ['apl-msg', kind === 'internal' ? 'is-internal' : out && kind !== 'comment' ? 'is-out' : 'is-in', kind.startsWith('text') ? 'is-text' : '', kind === 'note' ? 'is-note' : '', kind === 'reply' ? 'is-email' : ''].join(' ');
  let label = '';
  let body = c.message;
  if (kind === 'textIn' || kind === 'textOut' || kind === 'call') {
    const p = textParts(c.message);
    label = kind === 'textIn' ? `Text from ${p.contact || 'the family'}` : kind === 'textOut' ? `Text to ${p.contact || 'the family'}` : `Call with ${p.contact || 'the family'}`;
    body = kind === 'call' ? (p.summary || 'Call logged (no summary).') : (p.text ?? c.message);
  } else if (kind === 'reply') label = c.fromEmail ? 'Email reply from the family' : 'Message from the family';
  else if (kind === 'sent') label = `${c.parentId ? 'Replied to' : 'Emailed to'} ${c.to?.length ? namesOf(c.to) : 'the family'}${site?.by ? ` by ${site.by}` : ''}`;
  else if (kind === 'note') label = 'Internal note';
  else if (kind === 'internal') label = 'Staff only';
  else label = 'Comment in JobTread';
  if (kind === 'note') body = body.replace(/\n\n_([^_]+), from the website_$/, '');
  const long = body.length > 420 && !openFull;
  const by = kind === 'note' && site?.by ? site.by : c.by;
  return html`<div class=${cls}>
    <div class="apl-msg-meta"><b>${label}</b><span>${by && kind !== 'textIn' && kind !== 'reply' ? `${by} · ` : ''}<span title=${fullDate(c.at)}>${new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></span></div>
    <div class=${`apl-bubble ${long ? 'is-clamped' : ''}`}>
      ${c.name && !['textIn', 'textOut', 'call'].includes(kind) && html`<h4>${c.name}</h4>`}
      <div dangerouslySetInnerHTML=${{ __html: richText(body) }}></div>
    </div>
    ${(body.length > 420 || (onReply && (kind === 'sent' || kind === 'reply'))) && html`<div class="apl-msg-actions" style=${out && kind !== 'comment' ? 'justify-content:flex-end' : ''}>
      ${c.parentId && it.rootTitle && html`<span class="apl-inreply">In “${it.rootTitle}”</span>`}
      ${body.length > 420 && html`<button class="apl-more" onClick=${() => setOpenFull(v => !v)}>${openFull ? 'Show less' : 'Show all'}</button>`}
      ${onReply && (kind === 'sent' || kind === 'reply') && html`<button class="apl-more" onClick=${() => onReply({ id: it.rootId, title: it.rootTitle })} aria-label=${`Reply in “${it.rootTitle || 'this conversation'}”`}>Reply</button>`}
    </div>`}
    ${c.files?.length > 0 && html`<div class="apl-files">${c.files.map(f => html`<span class="apl-file-chip">📎 ${f.name}</span>`)}</div>`}
  </div>`;
}

function EventLine({ r }) {
  const who = r.by ? html` · ${r.by}${r.source && SOURCE_LABEL[r.source] ? ` ${SOURCE_LABEL[r.source]}` : ''}` : '';
  return html`<div class="apl-event" title=${fullDate(r.at)}>
    ${r.kind === 'status' ? html`<${Pill} status=${r.data?.to || r.title.replace(/^Status:\s*/, '')} />` : html`<span aria-hidden="true">${FEED_ICON[r.kind] || '•'}</span>`}
    <span><b>${r.kind === 'status' ? (r.data?.from ? `Moved from ${r.data.from}` : 'Status set') : cleanTitle(r.title)}</b>${who}${r.kind === 'status' && r.body && /emailed|already|skipped|Noted/.test(r.body) ? html`<span class="apl-event-sub">${r.body.split('\n').filter(l => !/^Was /.test(l)).join(' ')}</span>` : ''}${r.kind !== 'status' && r.body ? html`<span class="apl-event-sub">${r.body.split('\n').slice(0, 3).join(' · ')}</span>` : ''}</span>
  </div>`;
}

/** Everyone a family email goes to: each contact with an email address, main contact first, each address once */
function familyEmails(a) {
  const seen = new Set();
  const all = (a.contacts || []).slice().sort((x, y) => (y.email === a.contact?.email) - (x.email === a.contact?.email));
  return all.filter(c => c.email && !seen.has(c.email.toLowerCase()) && seen.add(c.email.toLowerCase()));
}

/** "Jordan Stone and Sam Stone" */
function namesOf(people, fallback = 'the family') {
  const n = [...new Set((people || []).map(p => p.name || p.email).filter(Boolean))];
  return !n.length ? fallback : n.length === 1 ? n[0] : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
}

function Conversation({ d, onSent, addToast, replyLink = null }) {
  const a = d.applicant;
  const items = useMemo(() => timelineOf(d), [d]);
  // Where an answer goes: a JobTread conversation ({ id, title }), or null for a new message.
  // It starts on the alert's thread, else the one the family wrote in last (if they wrote last).
  const linked = useMemo(() => {
    const it = replyLink && items.find(x => x.type === 'msg' && (x.c.id === replyLink || x.rootId === replyLink));
    return it ? { id: it.rootId, title: it.rootTitle } : null;
  }, [items, replyLink]);
  const familyLast = useMemo(() => {
    const last = [...items].reverse().find(x => x.type === 'msg' && (x.kind === 'sent' || x.kind === 'reply'));
    return last?.kind === 'reply' ? { id: last.rootId, title: last.rootTitle } : null;
  }, [items]);
  const [picked, setPicked] = useState(undefined); // undefined: follow the default above
  useEffect(() => { setPicked(undefined); }, [a.id]);
  const scroller = useRef(null);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [items.length, a.id]);
  const emailable = familyEmails(a);
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [headOpen, setHeadOpen] = useState(false); // phones: To and Subject, folded until tapped
  const box = useRef(null);
  const thread = correcting ? null : picked === undefined ? (linked || familyLast) : picked;
  const reply = (t) => { setPicked(t); setHeadOpen(true); setTimeout(() => box.current?.focus(), 0); };
  const send = async () => {
    if (!text.trim() || busy || !emailable.length) return;
    setBusy(true);
    const body = correcting ? { correction: { id: a.id, subject, message: text } } : { message: { id: a.id, subject, message: text, ...(thread ? { replyTo: thread.id } : {}) } };
    const j = await call(API, body);
    setBusy(false);
    if (!j.success) { addToast(j.error || 'Not sent', 'error'); return; }
    addToast(correcting ? `Correction sent to ${namesOf(j.to)} through JobTread` : thread ? `Replied to ${namesOf(j.to)} in “${thread.title || 'their conversation'}” through JobTread` : `Sent to ${namesOf(j.to)} through JobTread`, 'success');
    if (!thread) setPicked(undefined);
    setText('');
    if (correcting) { setCorrecting(false); setSubject(DEFAULT_SUBJECT); }
    onSent();
  };
  const startCorrection = (draft) => {
    setCorrecting(true);
    setHeadOpen(true);
    setSubject(draft.subject);
    setText(draft.message);
    setTimeout(() => box.current?.focus(), 0);
  };
  let lastDay = '';
  return html`<section class="apl-convo" aria-label="Conversation">
    <div class="apl-thread" ref=${scroller} tabindex="0" role="log" aria-label="Messages and activity">
      <${NotifyBanner} d=${d} onChanged=${onSent} onCorrection=${startCorrection} addToast=${addToast} />
      ${!items.length && html`<div class="apl-skel">No messages yet.</div>`}
      ${items.map((it) => {
        const day = new Date(it.at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: new Date(it.at).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
        const sep = day !== lastDay ? html`<div class="apl-day">${day}</div>` : null;
        lastDay = day;
        return html`${sep}${it.type === 'msg' ? html`<${Message} it=${it} key=${it.c.id} onReply=${emailable.length ? reply : null} />` : html`<${EventLine} r=${it.r} key=${it.r.id} />`}`;
      })}
    </div>
    ${!emailable.length ? html`<div class="apl-composer" aria-label="Message the family">
      <div class="apl-callout is-warn">No one on this family has an email address in JobTread, so there's no one to message yet. Add an email address for ${namesOf(a.contacts || [], 'a contact')} in JobTread and they'll show here.</div>
    </div>` : html`<div class=${`apl-composer ${headOpen ? 'is-head-open' : ''}`} aria-label="Message the family">
      <div class="apl-composer-head"><b>Message the family</b><span>Sent through JobTread, which emails it. Replies come back here.</span></div>
      ${!headOpen && html`<button class="apl-email-sum" onClick=${() => setHeadOpen(true)} aria-label=${thread ? 'See who it goes to, or start a new message' : 'See who it goes to, or change the subject'}><span>To <b>${namesOf(emailable)}</b> · ${thread ? `Replying in “${thread.title || 'their conversation'}”` : subject}</span><em>Edit</em></button>`}
      ${html`<div class="apl-email-row" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.5rem">
        <div class="apl-to" aria-label="To">To ${emailable.map(c => html`<span class="apl-to-chip" title=${c.email}>${c.name || c.email}</span>`)}</div>
        ${thread ? html`<div class="apl-thread-to"><span>Replying in <b>${thread.title || 'their conversation'}</b></span><button class="apl-more" onClick=${() => setPicked(null)}>New message</button></div>`
          : html`<label class="apl-subject">Subject <input value=${subject} onInput=${e => setSubject(e.target.value)} maxlength="128" aria-label="Subject" /></label>`}
      </div>`}
      ${correcting && html`<div class="apl-callout">Writing a correction. When it's sent, the site counts ${namesOf(emailable)} as knowing where things stand now. <button class="apl-more" onClick=${() => { setCorrecting(false); setSubject(DEFAULT_SUBJECT); setText(''); }}>Cancel</button></div>`}
      <textarea ref=${box} class="form-input" value=${text} onInput=${e => setText(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
        placeholder=${thread ? 'Write your reply. It goes back to everyone listed in the same JobTread conversation.' : 'Write to the family. JobTread emails it from the Qualification Committee to everyone listed, and their replies land here.'}
        aria-label=${thread ? 'Reply' : 'Message'} maxlength="4000"></textarea>
      <div class="apl-composer-foot">
        <span class="apl-kbd-hint">⌘/Ctrl + Enter to send</span>
        <button class="btn btn-primary" onClick=${send} disabled=${busy || !text.trim()}>${busy ? 'Sending…' : correcting ? 'Send correction' : thread ? 'Send reply' : 'Send'}</button>
      </div>
    </div>`}
  </section>`;
}

/** What's about to be emailed to this family (or what they were told that's no longer true) */
function NotifyBanner({ d, onChanged, onCorrection, addToast }) {
  const n = d.notify;
  const a = d.applicant;
  const [busy, setBusy] = useState('');
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 30000); return () => clearInterval(t); }, []);
  if (!n || (!n.kind && !n.correction)) return null;
  const parent = namesOf(familyEmails(a));
  const act = async (action) => {
    setBusy(action);
    const j = await call(API, { notify: { id: a.id, action } });
    setBusy('');
    if (!j.success) { addToast(j.error || 'That didn’t work', 'error'); return; }
    addToast(action === 'send' ? (j.result === 'already' ? 'They already had this email' : `Emailed ${parent}`) : action === 'skip' ? 'They won’t be emailed about this' : `Moved back to ${j.status}. Nothing was sent.`, 'success');
    onChanged();
  };
  const correction = async () => {
    setBusy('fix');
    const j = await call(`${API}?correction=${encodeURIComponent(a.id)}`);
    setBusy('');
    if (!j.success) { addToast(j.error || 'Couldn’t start a correction', 'error'); return; }
    onCorrection(j.draft);
  };
  if (n.kind) {
    const held = n.hold === 'paused';
    const mins = minutesUntil(n.dueAt);
    return html`<div class=${`apl-banner apl-thread-banner ${held ? 'is-info' : ''}`} role="status">
      <p>${held
        ? html`<strong>Email held.</strong> This changed while family emails were paused, so the ${n.label} email to ${parent} waits until someone chooses whether it goes.`
        : html`<strong>The ${n.label} email to ${parent} goes out at ${clock(n.dueAt)}</strong>${mins > 0 ? ` (in ${plural(mins, 'minute')})` : ''}. If this status was a mistake, change it back and nothing is sent.`}</p>
      <div class="apl-banner-actions">
        ${n.previous && n.previous !== n.status && html`<button class="btn btn-ghost btn-sm" onClick=${() => act('back')} disabled=${!!busy}>${busy === 'back' ? 'Moving…' : `Move back to ${n.previous}`}</button>`}
        <button class="btn btn-ghost btn-sm" onClick=${() => act('skip')} disabled=${!!busy}>Don't email</button>
        <button class="btn btn-primary btn-sm" onClick=${() => act('send')} disabled=${!!busy}>${busy === 'send' ? 'Sending…' : 'Send now'}</button>
      </div>
    </div>`;
  }
  return html`<div class="apl-banner apl-thread-banner is-warn" role="status">
    <p><strong>${parent} was emailed the ${n.told} message${n.toldAt ? ` on ${new Date(n.toldAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}</strong>, but ${a.name} is ${a.status || 'not set'} now. If that email was a mistake, send a short correction.</p>
    <div class="apl-banner-actions"><button class="btn btn-primary btn-sm" onClick=${correction} disabled=${!!busy}>${busy === 'fix' ? 'Writing…' : 'Write a correction'}</button></div>
  </div>`;
}

// ─── Details, contacts, home, files ─────────────────────────────────

const SIDE_FIELDS = ['year', 'types', 'birthday', 'gender', 'diagnosis', 'language', 'verbal', 'mobile', 'qualified', 'referredBy', 'denialReason'];

function FieldRow({ k, meta, value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value ?? '');
  const [state, setState] = useState('');
  const ref = useRef(null);
  useEffect(() => { if (!editing) setV(value ?? ''); }, [value, editing]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const commit = async (next = v) => {
    setEditing(false);
    const before = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
    const after = Array.isArray(next) ? JSON.stringify(next) : String(next ?? '');
    if (before === after) return;
    setState('is-saving');
    const ok = await onSave(k, next);
    setState(ok ? 'is-saved' : '');
    if (!ok) setV(value ?? '');
  };
  if (meta.type === 'multi') {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return html`<div class=${`apl-type-picks ${state}`}>${meta.options.map(o => html`<button aria-pressed=${list.includes(o)} onClick=${() => commit(list.includes(o) ? list.filter(x => x !== o) : [...list, o])}>${TYPE_ICON[o] ? `${TYPE_ICON[o]} ` : ''}${o}</button>`)}</div>`;
  }
  if (meta.type === 'option') {
    return html`<select class=${`form-select ${value ? '' : 'is-unset'} ${state}`} value=${value ?? ''} onChange=${e => commit(e.target.value)} aria-label=${meta.label}>
      <option value="">Not set</option>
      ${meta.options.map(o => html`<option value=${o}>${o}</option>`)}
      ${value && !meta.options.includes(value) && html`<option value=${value}>${value}</option>`}
    </select>`;
  }
  if (!editing) {
    const shown = meta.type === 'date' && value ? new Date(`${value}T12:00:00`).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) + (ageOf(value) != null ? ` (${ageOf(value)})` : '') : value;
    return html`<button class=${`apl-edit ${value ? '' : 'is-empty'} ${state}`} onClick=${() => setEditing(true)} aria-label=${`Edit ${meta.label}`}>${shown || 'Add'}</button>`;
  }
  const keys = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setV(value ?? ''); setEditing(false); } if (e.key === 'Enter' && (!meta.long || e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); } };
  if (meta.type === 'date') return html`<input ref=${ref} type="date" class="form-input" value=${v} onInput=${e => setV(e.target.value)} onBlur=${() => commit()} onKeyDown=${keys} />`;
  if (meta.long) return html`<textarea ref=${ref} class="form-input" rows="4" value=${v} onInput=${e => setV(e.target.value)} onBlur=${() => commit()} onKeyDown=${keys}></textarea>`;
  return html`<input ref=${ref} class="form-input" value=${v} onInput=${e => setV(e.target.value)} onBlur=${() => commit()} onKeyDown=${keys} />`;
}

function SidePanel({ d, fields, boundary, onSaved, onShowOnMap, addToast }) {
  const a = d.applicant;
  const [archBusy, setArchBusy] = useState(false);
  const save = async (k, value) => {
    const j = await call(API, { fields: { id: a.id, changes: { [k]: value } } });
    if (!j.success) { addToast(j.error || 'Not saved', 'error'); return false; }
    onSaved(j.applicant);
    return true;
  };
  const archive = async () => {
    const yes = window.confirm(a.archivedAt ? `Bring ${a.name} back from the archive in JobTread?` : `Archive ${a.name} in JobTread? You can bring them back any time.`);
    if (!yes) return;
    setArchBusy(true);
    const j = await call(API, { archive: { id: a.id, archive: !a.archivedAt } });
    setArchBusy(false);
    if (!j.success) { addToast(j.error || 'Not changed', 'error'); return; }
    addToast(a.archivedAt ? 'Unarchived' : 'Archived in JobTread', 'success');
    onSaved(j.applicant);
  };
  const files = d.files || [];
  const photos = files.filter(f => /^image\//.test(f.type || ''));
  const docs = files.filter(f => !/^image\//.test(f.type || ''));
  const visible = SIDE_FIELDS.filter(k => fields[k] && (k !== 'denialReason' || a.status === 'Denied' || a.fields?.denialReason));
  return html`<section class="apl-side" aria-label="Details">
    <div class="apl-panel">
      <h3>Details <span class="apl-card-sub" style="text-transform:none;letter-spacing:0">Saved to JobTread as you edit</span></h3>
      <dl class="apl-kv">${visible.map(k => html`<dt>${fields[k].label}</dt><dd><${FieldRow} k=${k} meta=${fields[k]} value=${a.fields?.[k] ?? (k === 'types' ? [] : '')} onSave=${save} /></dd>`)}</dl>
    </div>

    <div class="apl-panel">
      <h3>Family</h3>
      ${a.contacts?.length ? a.contacts.map(c => html`<div class="apl-contact">
        <strong>${c.name}${c.title ? html` <span class="apl-card-sub" style="display:inline">· ${c.title}</span>` : ''}</strong>
        ${c.email && html`<a href=${`mailto:${c.email}`}>${c.email}</a>`}
        ${c.phone && html`<a href=${`tel:${c.phone}`}>${phoneText(c.phone)}</a>`}
      </div>`) : html`<p class="apl-card-sub">No contacts in JobTread.</p>`}
    </div>

    <div class="apl-panel">
      <h3>Home <span class="apl-home-links">
        ${a.address && html`<a class="apl-more" href=${`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a.address)}`} target="_blank" rel="noopener">Directions</a>`}
        ${a.lat != null && html`<button class="apl-more" onClick=${() => onShowOnMap(a)}>Show on map</button>`}
      </span></h3>
      ${a.address ? html`<div style="font-size:.9rem">${a.address}</div>` : html`<p class="apl-card-sub">No home address in JobTread.</p>`}
      <div class="apl-tags">
        ${a.county && html`<span class="apl-tag">${a.county} County</span>`}
        ${a.area === 'inside' && html`<span class="apl-tag is-in">Inside the service area</span>`}
        ${a.area === 'outside' && html`<span class="apl-tag is-out">${a.areaMiles} miles outside the service area</span>`}
      </div>
      ${a.lat != null && a.lng != null ? html`<${HomeMap} a=${a} boundary=${boundary} />`
        : a.address && html`<p class="apl-card-sub">JobTread has no map point for this address, so it can't be checked against the service area.</p>`}
    </div>

    ${(photos.length > 0 || docs.length > 0 || a.applicationId || a.applicationUrl) && html`<div class="apl-panel">
      <h3>Application and files</h3>
      ${a.applicationId ? html`<${WebsiteAnswers} id=${a.applicationId} key=${a.applicationId} />`
        : a.applicationUrl && html`<a class="btn btn-ghost btn-sm" style="justify-self:start" href=${a.applicationUrl} target="_blank" rel="noopener">Open the original application ${Icon.ext()}</a>`}
      ${photos.length > 0 && html`<div class="apl-gallery">${photos.map(f => html`<a href=${f.url} target="_blank" rel="noopener" title=${f.name}><img src=${f.thumb || f.url} alt=${f.name} loading="lazy" /></a>`)}</div>`}
      ${docs.length > 0 && html`<div class="apl-doclist">${docs.map(f => html`<a href=${f.url} target="_blank" rel="noopener"><span aria-hidden="true">${/pdf/.test(f.type) ? '📄' : /video/.test(f.type) ? '🎬' : '📎'}</span>${f.name}<small>${f.size ? `${Math.max(1, Math.round(f.size / 1024 / (f.size > 1048576 ? 1024 : 1)))} ${f.size > 1048576 ? 'MB' : 'KB'}` : ''}</small></a>`)}</div>`}
    </div>`}

    ${a.jobId && html`<div class="apl-panel"><h3>Makeover job</h3><a class="btn btn-ghost btn-sm" style="justify-self:start" href=${a.jobUrl} target="_blank" rel="noopener">${a.jobName || 'Open the job'} ${Icon.ext()}</a></div>`}

    <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap">
      <span class="apl-card-sub">Read from JobTread ${ago(a.syncedAt)}${a.createdAt ? ` · added ${fullDate(a.createdAt)}` : ''}</span>
      <button class="btn btn-ghost btn-sm" onClick=${archive} disabled=${archBusy}>${a.archivedAt ? 'Unarchive' : 'Archive'}</button>
    </div>
  </section>`;
}

/**
 * The family's answers from the website form, folded until asked for. Applications →
 * Submissions has the same with the intake checks; a problem there shows here too.
 */
function WebsiteAnswers({ id }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!open || d) return;
    call(`/api/applications-admin?id=${encodeURIComponent(id)}`).then(j => { if (j.success) setD(j.application); else setErr(j.error || 'Couldn’t load the answers'); });
  }, [open]);
  const unfinished = d ? Object.values(d.checklist || {}).some(v => v !== true && v !== 'none') : false;
  const file = (f, thumb = false) => `/api/applications-admin?file=${encodeURIComponent(id)}&field=${encodeURIComponent(f)}${thumb ? '&thumb=1' : ''}`;
  return html`<div class="apl-answers">
    <button class="btn btn-ghost btn-sm" style="justify-self:start" aria-expanded=${open} onClick=${() => setOpen(o => !o)}>${open ? 'Hide the answers' : 'Show the answers from the website form'}</button>
    ${open && !d && !err && html`<div class="apl-card-sub">Loading the answers…</div>`}
    ${err && html`<div class="apl-callout is-warn">${err}</div>`}
    ${d && html`
      ${unfinished && !d.deletedAt && html`<div class="apl-callout is-warn">This application hasn't fully reached JobTread yet. It retries on its own. <a href=${`#applications/submissions/${id}`}>See it in Submissions</a></div>`}
      ${d.deletedAt
        ? html`<p class="apl-card-sub">The family's answers and files were deleted from the site.</p>`
        : (d.sections || []).map(sec => html`<details class="apl-answer-sec">
            <summary>${sec.title}</summary>
            <dl>${sec.items.map(i => html`<dt>${i.label}</dt><dd>${i.upload
              ? (i.type === 'photo' ? html`<a href=${file(i.id)} target="_blank" rel="noopener"><img src=${file(i.id, i.hasThumb)} alt=${i.label} loading="lazy" /></a>` : `Video ${i.video?.uploaded ? 'uploaded' : 'not finished'}${i.video?.duration ? ` (${Math.round(i.video.duration)} s)` : ''}`)
              : i.text}</dd>`)}</dl>
          </details>`)}
      <div class="apl-card-sub">${[d.lang === 'es' ? 'Answered in Spanish' : null, `form version ${d.formVersion || 'built in'}`].filter(Boolean).join(' · ')}${d.hasPdf ? html` · <a href=${file('pdf')} target="_blank" rel="noopener">PDF</a>` : ''} · <a href=${`#applications/submissions/${id}`}>Open in Submissions</a></div>`}
  </div>`;
}

// ─── Status change sheet ────────────────────────────────────────────

function StatusSheet({ a, status, paused = false, onClose, onDone, addToast }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  const [notify, setNotify] = useState(true);
  const [reason, setReason] = useState(a.fields?.denialReason || '');
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef(null);
  useEffect(() => {
    call(`${API}?id=${encodeURIComponent(a.id)}&preview=${encodeURIComponent(status)}`).then(j => {
      if (!j.success) setErr(j.error || 'Could not check what would be sent');
      else setP(j.preview);
    });
  }, [a.id, status]);
  useEffect(() => { if (p) confirmRef.current?.focus(); }, [p]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const m = p?.message;
  const willEmail = !!(m && !m.already && m.to && notify);
  // One person by first name; several are "the family"
  const first = m?.to?.length > 1 ? '' : (m?.to?.[0]?.name || a.contact?.name || '').split(' ')[0];
  const go = async (emailNow = false) => {
    setBusy(true);
    const j = await call(API, { status: { id: a.id, status, notify: willEmail, emailNow: willEmail && emailNow, denialReason: status === 'Denied' ? reason : null } });
    setBusy(false);
    if (!j.success) { addToast(j.error || 'Not changed', 'error'); return; }
    addToast(paused && willEmail ? `${a.name} is now ${status}. Family emails are paused, so the email is held.`
      : j.email === 'scheduled' ? `${a.name} is now ${status}. ${first || 'The family'} is emailed at ${clock(j.dueAt)}.`
        : j.email === 'sent' ? `${a.name} is now ${status}. The family was emailed.` : `${a.name} is now ${status}.`, 'success');
    onDone(j.applicant);
  };
  return html`<div class="apl-sheet-wrap" onClick=${e => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="apl-sheet" role="dialog" aria-modal="true" aria-labelledby="apl-sheet-title">
      <h2 id="apl-sheet-title">Move ${a.name} to ${status}?</h2>
      <div class="apl-sheet-move"><${Pill} status=${a.status} /> <span aria-hidden="true">→</span> <${Pill} status=${status} /> <span class="apl-card-sub">Saved to JobTread right away</span></div>
      ${err && html`<div class="apl-callout is-warn">${err}</div>`}
      ${!p && !err && html`<div class="apl-skel" style="padding:1rem">Checking what the family would get…</div>`}
      ${p && !p.forward && html`<div class="apl-callout">${p.note}</div>`}
      ${p && p.forward && !m && html`<div class="apl-callout">No family message goes with this status.</div>`}
      ${m && m.already && html`<div class="apl-callout">${first || 'The family'} already got the ${m.title} message, so nothing is sent again.</div>`}
      ${m && !m.already && !m.to && html`<div class="apl-callout is-warn">There's no email address for this family in JobTread, so the ${m.title} message can't be sent. Add one in JobTread, then send it from the conversation.</div>`}
      ${m && !m.already && m.to && html`
        <label class="apl-check"><input type="checkbox" checked=${notify} onChange=${e => setNotify(e.target.checked)} />
          <span>Email this to ${m.to.map((t, i) => html`${i ? (i === m.to.length - 1 ? ' and ' : ', ') : ''}${t.name} <span class="apl-card-sub" style="display:inline">(${t.email})</span>`)}${m.lang === 'es' ? ' in Spanish' : ''}</span></label>
        <div class="apl-preview" style=${notify ? '' : 'opacity:.45'}>
          <div class="apl-preview-head"><span>From <b>Qualification Committee</b> through JobTread</span><span>Subject <b>${m.title}</b></span></div>
          <div class="apl-preview-body" dangerouslySetInnerHTML=${{ __html: richText(m.message) }}></div>
        </div>
        ${notify && paused && html`<div class="apl-callout">Family emails are paused, so this email is held with the rest. You choose whether it goes when you turn emails back on.</div>`}
        ${notify && !paused && p.sendAt && html`<div class="apl-card-sub">Goes out at <strong>${clock(p.sendAt)}</strong>, once the status has stayed put. Change it back before then and nothing is sent.</div>`}
        ${!notify && html`<div class="apl-callout">They won't get this message, now or if the status changes in JobTread later.</div>`}`}
      ${status === 'Denied' && html`<label style="display:grid;gap:.3rem;font-size:.88rem"><span><strong>Reason</strong> <span class="apl-card-sub" style="display:inline">(staff only, saved as Denial Reason)</span></span>
        <textarea class="form-input" rows="3" value=${reason} onInput=${e => setReason(e.target.value)} placeholder="For example: outside the service area"></textarea></label>`}
      <div class="apl-sheet-foot">
        <button class="btn btn-ghost" onClick=${onClose}>Cancel</button>
        ${willEmail && !paused && html`<button class="btn btn-ghost" onClick=${() => go(true)} disabled=${busy}>Move and email now</button>`}
        <button class="btn btn-primary" ref=${confirmRef} onClick=${() => go(false)} disabled=${busy || (!p && !err)}>${busy ? 'Moving…' : willEmail && !paused ? `Move, email at ${clock(p.sendAt)}` : `Move to ${status}`}</button>
      </div>
    </div>
  </div>`;
}
