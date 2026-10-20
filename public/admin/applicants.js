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
 *    status. The boundary can be reshaped here (saved into the form draft).
 *  - Activity: what happened across every family, newest first.
 *  - A family (drawer): the whole conversation (emails, replies, texts,
 *    calls, notes) with a composer to email, text or note; the JobTread
 *    details, editable in place; contacts, home, files.
 */

import { h, htm, useState, useEffect, useRef, useMemo, useCallback, Sortable } from './vendor.js';

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
const BOUNDARY_RED = '#D92D20';
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
.apl { --apl-gap: 1rem; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--apl-gap); min-width: 0; }
.apl > * { min-width: 0; }
.apl-top { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem .75rem; justify-content: space-between; }
.apl-views { display: inline-flex; padding: 3px; gap: 2px; border-radius: 10px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); }
.apl-views button { border: 0; background: none; font: inherit; font-size: .88rem; font-weight: 600; color: var(--color-text-secondary); padding: .42rem .85rem; border-radius: 8px; cursor: pointer; min-height: 36px; transition: background .15s, color .15s, box-shadow .15s; }
.apl-views button:hover { color: var(--color-text); }
.apl-views button[aria-pressed="true"] { background: var(--color-bg-card); color: var(--color-text); box-shadow: var(--shadow-sm); }
.apl-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.apl-filters .form-select, .apl-filters .form-input { width: auto; min-height: 38px; font-size: .88rem; }
.apl-filters .form-select { max-width: 13rem; }
.apl-filter-toggle { display: none; }
@media (max-width: 640px) {
  .apl-filter-toggle { display: inline-flex; }
  .apl-filters .apl-more-filters { display: none; width: 100%; }
  .apl-filters.is-open .apl-more-filters { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
  .apl-filters .form-select { max-width: none; width: 100%; font-size: 16px; }
}
.apl-more-filters { display: contents; }
.apl-search { position: relative; }
.apl-search { flex: 1 1 240px; max-width: 340px; }
.apl-filters .apl-search input { padding-left: 2rem; width: 100%; }
.apl-search svg { position: absolute; left: .65rem; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--color-text-muted); pointer-events: none; }
.apl-search kbd { position: absolute; right: .5rem; top: 50%; transform: translateY(-50%); font: 600 .7rem/1 ui-monospace, monospace; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 4px; padding: 2px 5px; background: var(--color-bg-secondary); }
.apl-sync { font-size: .8rem; color: var(--color-text-muted); display: inline-flex; gap: .4rem; align-items: center; }
.apl-sync-short { display: none; }
@media (max-width: 640px) { .apl-sync-short { display: inline; } }
.apl-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.apl-dot.is-live { background: var(--color-success); box-shadow: 0 0 0 3px rgba(47,125,79,.15); }
.apl-dot.is-stale { background: var(--color-warning); }
.apl-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .6rem; }
.apl-stat { border: 1px solid var(--color-border); background: var(--color-bg-card); border-radius: var(--radius-md); padding: .7rem .85rem; display: grid; gap: .15rem; text-align: left; font: inherit; cursor: pointer; transition: border-color .15s, box-shadow .15s; position: relative; overflow: hidden; }
.apl-stat::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--c); }
.apl-stat:hover { border-color: var(--color-border-strong); box-shadow: var(--shadow-sm); }
.apl-stat[aria-pressed="true"] { border-color: var(--c); box-shadow: 0 0 0 1px var(--c) inset; }
.apl-stat b { font-size: 1.35rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
.apl-stat span { font-size: .8rem; color: var(--color-text-secondary); }
@media (max-width: 720px) { .apl-summary { gap: .4rem; } .apl-stat { padding: .5rem .55rem; } .apl-stat b { font-size: 1.1rem; } .apl-stat span { font-size: .72rem; } }

.apl-board { display: grid; grid-template-columns: repeat(4, minmax(240px, 1fr)); gap: .75rem; align-items: start; overflow-x: auto; padding-bottom: .5rem; scroll-snap-type: x proximity; }
.apl-col { background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-md); min-width: 0; display: flex; flex-direction: column; max-height: calc(100vh - 230px); scroll-snap-align: start; }
.apl-col-head { display: flex; align-items: center; gap: .5rem; padding: .7rem .8rem .55rem; border-bottom: 1px solid var(--color-border); }
.apl-col-head h3 { margin: 0; font-size: .92rem; }
.apl-col-head .apl-count { margin-left: auto; font-size: .78rem; font-weight: 700; color: var(--color-text-secondary); background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 999px; padding: 1px 8px; font-variant-numeric: tabular-nums; }
.apl-col-hint { font-size: .75rem; color: var(--color-text-muted); padding: .35rem .8rem 0; }
.apl-cards { display: grid; gap: .5rem; padding: .6rem; overflow-y: auto; min-height: 90px; align-content: start; flex: 1; }
.apl-cards.is-target { background: var(--color-primary-bg); outline: 2px dashed var(--color-primary); outline-offset: -6px; border-radius: 10px; }
.apl-empty-col { font-size: .8rem; color: var(--color-text-muted); text-align: center; padding: 1.2rem .5rem; border: 1px dashed var(--color-border-strong); border-radius: 10px; }
@media (max-width: 1100px) { .apl-board { grid-template-columns: repeat(4, minmax(260px, 82vw)); } }

.apl-card { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 10px; padding: .65rem .7rem; display: grid; gap: .4rem; cursor: pointer; box-shadow: var(--shadow-xs); transition: box-shadow .15s, border-color .15s, transform .15s; text-align: left; font: inherit; color: inherit; width: 100%; }
.apl-card:hover { border-color: var(--color-border-strong); box-shadow: var(--shadow-md); }
.apl-card:focus-visible { outline: 2px solid var(--color-text); outline-offset: 2px; }
.apl-card.is-ghost { opacity: .35; }
.apl-card.is-chosen { box-shadow: var(--shadow-lg); transform: rotate(-1deg); }
.apl-card-top { display: flex; gap: .6rem; align-items: center; min-width: 0; }
.apl-avatar { width: 34px; height: 34px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: .75rem; font-weight: 700; color: #fff; background: var(--c, #A3A4AA); overflow: hidden; }
.apl-avatar img { width: 100%; height: 100%; object-fit: cover; }
.apl-card-name { font-weight: 650; font-size: .92rem; line-height: 1.25; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apl-card-sub { font-size: .76rem; color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.apl-tags { display: flex; flex-wrap: wrap; gap: .3rem; }
.apl-tag { font-size: .72rem; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); color: var(--color-text-secondary); white-space: nowrap; }
.apl-tag.is-out { background: #FDECEA; border-color: #F5C2BD; color: #9B2C20; }
.apl-tag.is-warn { background: #FFF6E0; border-color: #F2D899; color: #7A5300; }
.apl-tag.is-es { background: #EAF2FB; border-color: #C5DAF1; color: #23578F; }
.apl-tag.is-test { background: #F1F0FB; border-color: #D7D3F2; color: #4B3F9C; }
.apl-card-foot { display: flex; justify-content: space-between; gap: .5rem; font-size: .74rem; color: var(--color-text-muted); }
.apl-card-foot span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apl-stage.is-long { color: #8A5A00; font-weight: 600; }
.apl-mail { font-size: .72rem; font-weight: 650; padding: 2px 7px; border-radius: 999px; background: #FFF6D6; border: 1px solid #F2D899; color: #6B4A00; white-space: nowrap; }
.apl-mail.is-held { background: #EEF0F3; border-color: #D9DDE3; color: #4A4F57; }
.apl-mail.is-fix { background: #FDECEA; border-color: #F5C2BD; color: #9B2C20; }
.apl-banner { display: flex; gap: .75rem; align-items: center; justify-content: space-between; flex-wrap: wrap; border-radius: var(--radius-md); padding: .7rem .9rem; border: 1px solid #F2D899; background: #FFFBEB; font-size: .88rem; }
.apl-banner.is-info { border-color: var(--color-border); background: var(--color-bg-card); }
.apl-banner.is-warn { border-color: #F5C2BD; background: #FFF5F4; }
.apl-banner p { margin: 0; min-width: 0; flex: 1 1 280px; }
.apl-banner .apl-banner-actions { display: flex; gap: .4rem; flex-wrap: wrap; }
.apl-thread-banner { position: sticky; top: 0; z-index: 2; margin: -1rem -1.1rem .25rem; padding: .7rem 1.1rem; border-radius: 0; border-left: 0; border-right: 0; border-top: 0; }
@media (max-width: 860px) { .apl-thread-banner { position: static; } }

.apl-table-wrap { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); overflow: auto; }
.apl-table { width: 100%; border-collapse: collapse; font-size: .88rem; }
.apl-table th { position: sticky; top: 0; background: var(--color-bg-secondary); text-align: left; font-size: .76rem; text-transform: uppercase; letter-spacing: .04em; color: var(--color-text-secondary); padding: .6rem .75rem; border-bottom: 1px solid var(--color-border); white-space: nowrap; z-index: 1; }
.apl-table th button { all: unset; cursor: pointer; display: inline-flex; gap: .3rem; align-items: center; }
.apl-table th button:focus-visible { outline: 2px solid var(--color-text); border-radius: 4px; }
.apl-table td { padding: .6rem .75rem; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
.apl-table tbody tr { cursor: pointer; transition: background .1s; }
.apl-table tbody tr:hover { background: var(--color-bg-hover); }
.apl-table tbody tr:focus-visible { outline: 2px solid var(--color-text); outline-offset: -2px; }
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
.apl-legend-line i { width: 18px; height: 0; border-top: 2.5px solid ${BOUNDARY_RED}; display: inline-block; }
.apl-map-tools { position: absolute; z-index: 500; top: .75rem; right: .75rem; display: grid; gap: .4rem; justify-items: end; }
.apl-map-tools .btn { box-shadow: var(--shadow-md); }
.apl-map-note { position: absolute; z-index: 500; left: 50%; bottom: .9rem; transform: translateX(-50%); background: #1A1B1F; color: #fff; border-radius: 10px; padding: .6rem .9rem; font-size: .84rem; box-shadow: var(--shadow-lg); display: flex; gap: .75rem; align-items: center; max-width: calc(100% - 2rem); flex-wrap: wrap; justify-content: center; }
.apl-map-note .btn { min-height: 34px; }
.apl-pin { width: 18px; height: 18px; border-radius: 50%; background: var(--c); border: 2.5px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.35); transition: transform .15s; }
.apl-pin.is-focus { transform: scale(1.5); box-shadow: 0 0 0 6px color-mix(in srgb, var(--c) 30%, transparent), 0 1px 4px rgba(0,0,0,.35); }
.apl-handle { width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 3px solid ${BOUNDARY_RED}; box-shadow: 0 1px 3px rgba(0,0,0,.3); cursor: grab; }
.apl-handle.is-mid { width: 10px; height: 10px; border-width: 2px; opacity: .8; }
.apl-pop { font: 14px/1.4 Inter, system-ui, sans-serif; display: grid; gap: .35rem; min-width: 190px; }
.apl-pop strong { font-size: .95rem; }
.apl-pop button { justify-self: start; }
.leaflet-container { font: inherit; }
.apl-tiles { filter: grayscale(1) contrast(.8) brightness(1.13); }
.apl-map img { max-width: none !important; max-height: none !important; border-radius: 0 !important; box-shadow: none !important; }
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
.apl-status-select select { appearance: none; -webkit-appearance: none; background-image: none !important; padding: .45rem 2rem .45rem 1.7rem !important; width: auto !important; border-radius: 999px; font: inherit; font-weight: 650; font-size: .88rem; border: 1px solid color-mix(in srgb, var(--c) 35%, white); background: color-mix(in srgb, var(--c) 10%, white); color: color-mix(in srgb, var(--c) 80%, black); cursor: pointer; min-height: 38px; }
.apl-status-select::before { content: ''; position: absolute; left: .7rem; top: 50%; width: 8px; height: 8px; margin-top: -4px; border-radius: 50%; background: var(--c); pointer-events: none; }
.apl-status-select::after { content: ''; position: absolute; right: .85rem; top: 50%; width: 6px; height: 6px; border-right: 1.75px solid color-mix(in srgb, var(--c) 80%, black); border-bottom: 1.75px solid color-mix(in srgb, var(--c) 80%, black); transform: translateY(-70%) rotate(45deg); pointer-events: none; }
.apl-dbody { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, 1fr); }
@media (max-width: 860px) { .apl-dbody { grid-template-columns: 1fr; overflow-y: auto; } }
.apl-convo { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--color-border); }
@media (max-width: 860px) { .apl-convo { border-right: 0; } .apl-thread { overflow: visible; flex: none; } }
.apl-thread { flex: 1; overflow-y: auto; padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .75rem; }
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
.apl-event { align-self: center; display: flex; gap: .45rem; align-items: center; font-size: .8rem; color: var(--color-text-secondary); max-width: 92%; text-align: center; flex-wrap: wrap; justify-content: center; }
.apl-event b { color: var(--color-text); }
.apl-event .apl-pill { font-size: .74rem; }
.apl-composer { border-top: 1px solid var(--color-border); background: var(--color-bg-card); padding: .75rem 1rem .9rem; display: grid; gap: .55rem; }
.apl-modes { display: flex; gap: .3rem; flex-wrap: wrap; }
.apl-modes button { border: 1px solid var(--color-border); background: var(--color-bg-card); border-radius: 999px; padding: .32rem .8rem; font: inherit; font-size: .82rem; font-weight: 600; cursor: pointer; color: var(--color-text-secondary); min-height: 34px; }
.apl-modes button[aria-pressed="true"] { background: #1A1B1F; border-color: #1A1B1F; color: #fff; }
.apl-composer textarea { min-height: 84px; resize: vertical; }
.apl-composer-foot { display: flex; justify-content: space-between; align-items: center; gap: .6rem; flex-wrap: wrap; font-size: .78rem; color: var(--color-text-muted); }
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
@media (max-width: 640px) {
  .apl-search { flex: 1 1 0; max-width: none; }
  .apl-search kbd, .apl-sync-long { display: none; }
  .apl-sync .btn { white-space: nowrap; }
  .apl-email-row { grid-template-columns: 1fr !important; }
  .apl-dhead { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "avatar title nav" "actions actions actions"; }
  .apl-dhead { padding: .7rem .8rem; }
  .apl-thread, .apl-side { padding-left: .8rem; padding-right: .8rem; }
  .apl-kv { grid-template-columns: 1fr; }
  .apl-kv dt { padding-bottom: 0; }
  .apl-composer textarea, .apl-composer input, .apl-kv .form-input, .apl-kv .form-select { font-size: 16px; }
  .apl-type-picks button, .apl-modes button { min-height: 44px; }
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
};
const FEED_ICON = { notify: '📨', status: '●', fields: '✎', comment: '💬', reply: '↩', textIn: '📱', textOut: '📱', call: '📞', sent: '✉', note: '📝', file: '📎', contact: '👤', home: '🏠', job: '🛠', created: '✨', archived: '🗄', unarchived: '🗄', renamed: '✎' };

function Avatar({ a, size = null }) {
  const c = STATUS_COLOR[a.status || ''];
  return html`<span class="apl-avatar" style=${`--c:${c}${size ? `;width:${size}px;height:${size}px` : ''}`} aria-hidden="true">${a.photo ? html`<img src=${a.photo} alt="" loading="lazy" />` : initials(a.name)}</span>`;
}
const Pill = ({ status }) => html`<span class="apl-pill" style=${`--c:${STATUS_COLOR[status || '']}`}>${status || 'No status'}</span>`;

function Flags({ a, compact = false }) {
  const out = [];
  if (a.area === 'outside') out.push(html`<span class="apl-tag is-out" title="Home is outside the service-area boundary">${a.areaMiles != null ? `${a.areaMiles} mi outside` : 'Outside area'}</span>`);
  if (a.repeat?.length) out.push(html`<span class="apl-tag is-warn" title=${`Possible repeat of ${a.repeat.join(', ')}`}>Possible repeat</span>`);
  if (a.lang === 'es' || a.fields?.language === 'Spanish') out.push(html`<span class="apl-tag is-es">Español</span>`);
  if (a.isTest || /^TEST\b/.test(a.name)) out.push(html`<span class="apl-tag is-test">Test</span>`);
  if (a.archivedAt) out.push(html`<span class="apl-tag">Archived</span>`);
  if (!compact) for (const t of a.types || []) out.push(html`<span class="apl-tag">${TYPE_ICON[t] ? `${TYPE_ICON[t]} ` : ''}${t}</span>`);
  return out.length ? html`<div class="apl-tags">${out}</div>` : null;
}

function lastLine(a) {
  const l = a.lastActivity;
  if (!l) return a.createdAt ? `Added ${ago(a.createdAt)}` : '';
  const who = l.by && l.by !== 'JobTread' ? ` · ${l.by.split(' ')[0]}` : '';
  const what = l.kind === 'status' ? `Moved to ${a.status || 'no status'}` : l.kind === 'textIn' ? 'Text from the family' : l.kind === 'reply' ? 'Reply from the family' : (l.title || l.kind);
  return `${what}${who} · ${ago(a.lastActivityAt)}`;
}

// ─── The area ───────────────────────────────────────────────────────

export function ApplicantsArea({ addToast }) {
  injectCss();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [view, setView] = useState(() => { try { return localStorage.getItem('apl-view') || 'board'; } catch { return 'board'; } });
  const [q, setQ] = useState('');
  const [year, setYear] = useState(null);
  const [type, setType] = useState('');
  const [area, setArea] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [archived, setArchived] = useState(false);
  const [openId, setOpenId] = useState(() => (location.hash.match(/^#applications\/applicants\/([A-Za-z0-9]{6,32})$/) || [])[1] || null);
  const [sheet, setSheet] = useState(null);       // { a, status }
  const [syncing, setSyncing] = useState(false);
  const [focusPin, setFocusPin] = useState(null);
  const searchRef = useRef(null);

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
  useEffect(() => { try { localStorage.setItem('apl-view', view); } catch { /* private mode */ } }, [view]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && !document.activeElement?.isContentEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const open = (id) => {
    setOpenId(id);
    history.replaceState(null, '', id ? `#applications/applicants/${id}` : '#applications/applicants');
  };

  const all = data?.applicants || [];
  const years = useMemo(() => {
    const m = new Map();
    for (const a of all) if (a.year) m.set(a.year, (m.get(a.year) || 0) + 1);
    return [...m.entries()].sort((x, y) => y[0].localeCompare(x[0]));
  }, [all]);
  const counties = useMemo(() => [...new Set(all.map(a => a.county).filter(Boolean))].sort(), [all]);
  const [county, setCounty] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = [type, county, area, archived ? 'a' : ''].filter(Boolean).length + (year && data && year !== data.season ? 1 : 0);
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
  const counts = useMemo(() => Object.fromEntries(STATUS_ORDER.map(s => [s, shown.filter(a => a.status === s).length])), [shown]);

  const askStatus = (a, status) => { if (a.status !== status) setSheet({ a, status }); };
  const afterChange = (applicant) => {
    if (!applicant) return load(true);
    setData(d => d && { ...d, applicants: d.applicants.map(x => (x.id === applicant.id ? { ...x, ...applicant } : x)) });
    load(true);
  };
  const syncNow = async () => {
    setSyncing(true);
    const j = await call(API, { sync: true });
    setSyncing(false);
    if (!j.success) { addToast(j.error || 'Sync failed', 'error'); return; }
    addToast('Up to date with JobTread', 'success');
    load(true);
  };

  if (err && !data) return html`<div class="apl-zero"><p><strong>Couldn't load applicants.</strong></p><p>${err}</p><button class="btn btn-ghost" onClick=${() => load()}>Try again</button></div>`;
  if (!data) return html`<div class="apl-skel"><span class="spinner" /> Loading applicants from JobTread…</div>`;

  const sync = data.sync || {};
  const fresh = sync.eventsCheckedAt && Date.now() - Date.parse(sync.eventsCheckedAt) < 10 * 60 * 1000;
  const idx = shown.findIndex(a => a.id === openId);

  return html`<div class="apl">
    <div class="apl-top">
      <div class="apl-views" role="group" aria-label="View">
        ${[['board', 'Board'], ['list', 'List'], ['map', 'Map'], ['activity', 'Activity']].map(([k, label]) => html`
          <button aria-pressed=${view === k} onClick=${() => setView(k)}>${label}</button>`)}
      </div>
      <div class="apl-sync" aria-live="polite">
        <span class=${`apl-dot ${fresh ? 'is-live' : 'is-stale'}`}></span>
        ${fresh ? html`<span class="apl-sync-long">In sync with JobTread · checked ${ago(sync.eventsCheckedAt)}</span><span class="apl-sync-short">Synced ${ago(sync.eventsCheckedAt)}</span>` : sync.eventsCheckedAt ? `Last checked JobTread ${ago(sync.eventsCheckedAt)}` : 'Not synced yet'}
        ${!sync.historyDone && sync.historyBackTo ? html` · loading history (back to ${new Date(sync.historyBackTo).toLocaleDateString([], { month: 'short', year: 'numeric' })})` : null}
        <button class="btn btn-ghost btn-sm" onClick=${syncNow} disabled=${syncing}>${syncing ? 'Syncing…' : 'Sync now'}</button>
      </div>
    </div>
    <div class=${`apl-filters ${filtersOpen ? 'is-open' : ''}`}>
      <label class="apl-search">${Icon.search()}<input ref=${searchRef} class="form-input" type="search" placeholder="Search name, parent, address…" value=${q} onInput=${e => setQ(e.target.value)} aria-label="Search applicants" />${!q && html`<kbd>/</kbd>`}</label>
      <button class="btn btn-ghost btn-sm apl-filter-toggle" aria-expanded=${filtersOpen} onClick=${() => setFiltersOpen(v => !v)}>Filters${activeFilters ? ` (${activeFilters})` : ''}</button>
      <div class="apl-more-filters">
        <select class="form-select" value=${year || ''} onChange=${e => setYear(e.target.value)} aria-label="Makeover year">
        <option value="">All years (${all.length})</option>
        ${years.map(([y, n]) => html`<option value=${y}>${y}${y === data.season ? ' season' : ''} (${n})</option>`)}
      </select>
      <select class="form-select" value=${type} onChange=${e => setType(e.target.value)} aria-label="Makeover type">
        <option value="">Any makeover</option>
        ${(data.fields?.types?.options || []).map(t => html`<option value=${t}>${t}</option>`)}
      </select>
      <select class="form-select" value=${county} onChange=${e => setCounty(e.target.value)} aria-label="County">
        <option value="">Any county</option>
        ${counties.map(c => html`<option value=${c}>${c}</option>`)}
      </select>
      <select class="form-select" value=${area} onChange=${e => setArea(e.target.value)} aria-label="Service area">
        <option value="">In or out of area</option>
        <option value="inside">Inside the boundary</option>
        <option value="outside">Outside the boundary</option>
        <option value="unknown">No map point</option>
      </select>
      <label class="apl-check" style="font-size:.84rem;align-items:center"><input type="checkbox" checked=${archived} onChange=${e => setArchived(e.target.checked)} /> Archived too</label>
      </div>
    </div>

    <${EmailBanner} emails=${data.emails} onChanged=${() => load(true)} addToast=${addToast} />

    ${view !== 'board' && html`<div class="apl-summary">
      ${STATUS_ORDER.map(s => html`
        <button class="apl-stat" style=${`--c:${STATUS_COLOR[s]}`} aria-pressed=${statusFilter === s} onClick=${() => setStatusFilter(f => (f === s ? '' : s))} title=${STATUS_HINT[s]}>
          <b>${counts[s]}</b><span>${s}</span>
        </button>`)}
    </div>`}

    ${view === 'board' && html`<${Board} list=${shown} onOpen=${open} onMove=${askStatus} />`}
    ${view === 'list' && html`<${ListView} list=${shown} onOpen=${open} />`}
    ${view === 'map' && html`<${MapView} list=${shown} boundary=${data.boundary} focus=${focusPin} onOpen=${open} addToast=${addToast} onSaved=${() => load(true)} />`}
    ${view === 'activity' && html`<${ActivityView} onOpen=${open} />`}

    ${openId && html`<${Drawer}
      id=${openId}
      fields=${data.fields}
      texting=${!!data.texting}
      summary=${all.find(a => a.id === openId)}
      onClose=${() => open(null)}
      onPrev=${idx > 0 ? () => open(shown[idx - 1].id) : null}
      onNext=${idx >= 0 && idx < shown.length - 1 ? () => open(shown[idx + 1].id) : null}
      onStatus=${askStatus}
      onChanged=${afterChange}
      onShowOnMap=${(a) => { open(null); setFocusPin(a.id); setView('map'); }}
      addToast=${addToast} />`}
    ${sheet && html`<${StatusSheet} a=${sheet.a} status=${sheet.status} onClose=${() => setSheet(null)} onDone=${(applicant) => { setSheet(null); afterChange(applicant); }} addToast=${addToast} />`}
  </div>`;
}

/** Pause family emails (for data cleanup), what a pause held back, and a stalled sweep */
function EmailBanner({ emails, onChanged, addToast }) {
  const [busy, setBusy] = useState('');
  if (!emails) return null;
  const post = async (body, key, done) => {
    setBusy(key);
    const j = await call(API, body);
    setBusy('');
    if (!j.success) { addToast(j.error || 'That didn’t work', 'error'); return; }
    if (done) addToast(done, 'success');
    onChanged();
  };
  const pause = () => {
    if (!window.confirm('Pause family status emails for 2 hours?\n\nUse this while cleaning up statuses in JobTread. Nothing that changes during the pause is emailed unless someone chooses to send it afterwards.')) return;
    post({ pause: { minutes: 120 } }, 'pause', 'Family emails paused for 2 hours');
  };
  const held = emails.held || [];
  return html`<div style="display:grid;gap:.5rem">
    ${emails.active
      ? html`<div class="apl-banner is-info" role="status"><p><strong>Family emails are paused</strong> until ${clock(emails.until)}${emails.by ? ` (started by ${String(emails.by).split('@')[0]})` : ''}. Status changes now are held, not emailed.</p>
          <div class="apl-banner-actions"><button class="btn btn-ghost btn-sm" onClick=${() => post({ resume: true }, 'resume', 'Family emails are back on')} disabled=${!!busy}>Resume now</button></div></div>`
      : null}
    ${held.length > 0 && html`<div class="apl-banner" role="status"><p><strong>${plural(held.length, 'family email was', 'family emails were')} held during a pause:</strong> ${held.slice(0, 6).map(h => `${h.name} (${h.status})`).join(', ')}${held.length > 6 ? '…' : ''}.</p>
      <div class="apl-banner-actions">
        <button class="btn btn-ghost btn-sm" onClick=${() => post({ held: 'skip' }, 'skip', 'Held emails dismissed')} disabled=${!!busy}>Don't send</button>
        <button class="btn btn-primary btn-sm" onClick=${() => post({ held: 'send' }, 'send', 'Held emails sent')} disabled=${!!busy}>${busy === 'send' ? 'Sending…' : 'Send these'}</button>
      </div></div>`}
    ${emails.overdue > 0 && html`<div class="apl-banner is-warn" role="alert"><p><strong>${plural(emails.overdue, 'family email is', 'family emails are')} overdue.</strong> The background check that sends them may have stopped. Opening this page sends them now; if this keeps showing, tell Peter.</p></div>`}
    ${!emails.active && html`<div style="display:flex;justify-content:flex-end"><button class="btn btn-ghost btn-sm" onClick=${pause} disabled=${!!busy} title="For cleaning up statuses in JobTread without emailing families">Pause family emails</button></div>`}
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
  const column = (s) => html`
    <section class="apl-col" aria-label=${s}>
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
              <div class="apl-card-sub">${[age != null ? `${age} yrs` : null, a.city || a.county, a.year].filter(Boolean).join(' · ')}</div></div>
            </div>
            <${Flags} a=${a} />
            ${a.notify && html`<div class="apl-tags">${a.notify.kind ? html`<span class=${`apl-mail ${a.notify.hold ? 'is-held' : ''}`} title=${a.notify.hold ? 'Held: family emails are paused' : `The ${a.notify.label} email goes out at ${clock(a.notify.dueAt)} unless the status changes back`}>${a.notify.hold ? 'Email held' : `Emails ${clock(a.notify.dueAt)}`}</span>` : a.notify.correction ? html`<span class="apl-mail is-fix" title=${`The family was emailed ${a.notify.told}, but the status is now ${a.status}`}>Needs a correction</span>` : null}</div>`}
            <div class="apl-card-foot"><span>${lastLine(a)}</span>${days != null && html`<span class=${`apl-stage ${long ? 'is-long' : ''}`} title=${`In ${s} for ${plural(days, 'day')}`}>${days}d</span>`}</div>
          </button>`;
        })}
        ${!groups[s].length && html`<div class="apl-empty-col">Nobody here${s === 'Applied' ? ' yet' : ''}. Drag a family here to move them.</div>`}
      </div>
    </section>`;
  return html`<div>
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
  return html`<div class="apl-table-wrap"><table class="apl-table">
    <thead><tr>${LIST_COLS.map(c => html`<th aria-sort=${sort.k === c.k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}><button onClick=${() => setSort(s => ({ k: c.k, dir: s.k === c.k ? -s.dir : 1 }))}>${c.label}${sort.k === c.k ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`)}</tr></thead>
    <tbody>${rows.map(a => html`<tr key=${a.id} tabindex="0" onClick=${() => onOpen(a.id)} onKeyDown=${e => { if (e.key === 'Enter') onOpen(a.id); }}>
      <td><div style="display:flex;gap:.55rem;align-items:center"><${Avatar} a=${a} size=${28} /><div><strong>${a.name}</strong><div class="apl-card-sub">${a.contact?.name || ''}</div></div></div></td>
      <td><${Pill} status=${a.status} /></td>
      <td>${a.year || '—'}</td>
      <td>${(a.types || []).join(', ') || '—'}</td>
      <td>${a.county || '—'}</td>
      <td>${a.area === 'outside' ? html`<span class="apl-tag is-out">${a.areaMiles} mi out</span>` : a.area === 'inside' ? 'Inside' : '—'}</td>
      <td>${daysSince(a.stageAt || a.createdAt, now) != null ? `${daysSince(a.stageAt || a.createdAt, now)}d` : '—'}</td>
      <td class="apl-card-sub" style="max-width:260px">${lastLine(a)}</td>
    </tr>`)}</tbody>
  </table></div>`;
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

function MapView({ list, boundary, focus, onOpen, addToast, onSaved }) {
  const box = useRef(null);
  const st = useRef({});
  const [L, setL] = useState(null);
  const [err, setErr] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [editing, setEditing] = useState(false);
  const [draftPoly, setDraftPoly] = useState(null);
  const [saved, setSaved] = useState(null);   // { changes } after saving into the draft
  const [busy, setBusy] = useState(false);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

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
    st.current = { map, pins: L.layerGroup().addTo(map), area: null, handles: L.layerGroup().addTo(map), markers: new Map() };
    const poly = boundary?.live || [];
    if (poly.length >= 3) map.fitBounds(L.latLngBounds(poly), { padding: [30, 30] });
    else map.setView([33.95, -84.35], 9);
    return () => { map.remove(); st.current = {}; };
  }, [L]);

  // The boundary (live, or the one being edited)
  const poly = useMemo(() => draftPoly || boundary?.live || [], [draftPoly, boundary?.live]);
  useEffect(() => {
    const s = st.current;
    if (!L || !s.map) return;
    if (s.area) s.area.remove();
    if (poly.length >= 3) {
      s.area = L.polygon(poly, { color: BOUNDARY_RED, weight: editing ? 3 : 2.5, opacity: 0.95, fillColor: BOUNDARY_RED, fillOpacity: editing ? 0.07 : 0.035, dashArray: editing ? '6 6' : null, interactive: false }).addTo(s.map);
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

  // Pins
  useEffect(() => {
    const s = st.current;
    if (!L || !s.map) return;
    s.pins.clearLayers();
    s.markers.clear();
    for (const a of list) {
      if (a.lat == null || a.lng == null || hidden.has(a.status || '')) continue;
      const c = STATUS_COLOR[a.status || ''];
      const icon = L.divIcon({ className: '', html: `<div class="apl-pin${focus === a.id ? ' is-focus' : ''}" style="--c:${c}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
      const m = L.marker([a.lat, a.lng], { icon, title: a.name, riseOnHover: true, keyboard: true }).addTo(s.pins);
      const div = document.createElement('div');
      div.className = 'apl-pop';
      div.innerHTML = `<strong>${esc(a.name)}</strong><span class="apl-pill" style="--c:${c}">${esc(a.status || 'No status')}</span><span style="font-size:.82rem;color:#5E5F66">${esc(a.address || '')}</span>${a.area === 'outside' ? `<span class="apl-tag is-out" style="justify-self:start">${a.areaMiles} mi outside the boundary</span>` : ''}<button class="btn btn-primary btn-sm" type="button">Open</button>`;
      div.querySelector('button').addEventListener('click', () => openRef.current(a.id));
      m.bindPopup(div, { closeButton: true, autoPanPadding: [40, 40] });
      s.markers.set(a.id, m);
    }
  }, [L, list, hidden, focus]);

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

  const save = async () => {
    setBusy(true);
    const j = await call(API, { boundary: draftPoly });
    setBusy(false);
    if (!j.success) { addToast(j.error || 'Could not save the boundary', 'error'); return; }
    setSaved({ changes: j.changes || [] });
    setEditing(false);
  };
  const putLive = async () => {
    setBusy(true);
    const j = await call('/api/applications-admin', { formPutLive: true });
    setBusy(false);
    if (!j.success) { addToast(j.error || 'Could not put the form live', 'error'); return; }
    addToast('The new boundary is live. Everyone is re-checked against it.', 'success');
    setSaved(null);
    setDraftPoly(null);
    onSaved();
  };

  if (err) return html`<div class="apl-zero">The map couldn't load (${err}).</div>`;
  return html`<div class="apl-map-wrap">
    <div class="apl-map" ref=${box} role="region" aria-label="Map of applicants and the service-area boundary"></div>
    ${!L && html`<div class="apl-skel" style="position:absolute;inset:0;display:grid;place-items:center">Loading the map…</div>`}
    <div class="apl-legend">
      ${['Applied', 'In Review', 'Approved', 'Denied'].map(s => html`<button aria-pressed=${!hidden.has(s)} onClick=${() => setHidden(h => { const n = new Set(h); n.has(s) ? n.delete(s) : n.add(s); return n; })}>
        <span class="apl-dot" style=${`background:${STATUS_COLOR[s]};width:10px;height:10px`}></span>${s}<b>${counts[s]}</b></button>`)}
      <div class="apl-legend-line"><i></i> Service area${outside ? ` · ${outside} outside` : ''}</div>
      ${noPoint > 0 && html`<div class="apl-card-sub" style="padding:.2rem .35rem 0">${plural(noPoint, 'family has', 'families have')} no home in JobTread yet</div>`}
    </div>
    <div class="apl-map-tools">
      ${!editing && !saved && html`<button class="btn btn-ghost btn-sm" onClick=${() => { setEditing(true); setDraftPoly(boundary?.draft || boundary?.live || []); }}>Edit boundary</button>`}
      ${boundary?.draft && !editing && !saved && JSON.stringify(boundary.draft) !== JSON.stringify(boundary.live) && html`<span class="apl-tag is-warn">The form draft has a different boundary</span>`}
    </div>
    ${editing && html`<div class="apl-map-note" role="status">
      Drag a corner to move it, drag a small dot to add one, double-click a corner to remove it.
      <button class="btn btn-ghost btn-sm" onClick=${() => { setEditing(false); setDraftPoly(null); }}>Cancel</button>
      <button class="btn btn-primary btn-sm" onClick=${save} disabled=${busy}>${busy ? 'Saving…' : 'Save to the form draft'}</button>
    </div>`}
    ${saved && html`<div class="apl-map-note" role="status">
      Saved to the form draft${saved.changes.length > 1 ? `, along with ${plural(saved.changes.length - 1, 'other change')}` : ''}. It's used once the form goes live.
      <button class="btn btn-ghost btn-sm" onClick=${() => { location.hash = '#applications/form'; }}>Review in Form</button>
      <button class="btn btn-primary btn-sm" onClick=${putLive} disabled=${busy}>${busy ? 'Putting live…' : 'Put live now'}</button>
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
      <div class="apl-feed-main"><div><strong>${r.applicant}</strong> · ${r.title || r.kind}</div>
        ${r.body && html`<p>${r.body}</p>`}
        <span class="apl-card-sub">${r.by ? `${r.by} ` : ''}${SOURCE_LABEL[r.source] || ''}</span></div>
      <span class="apl-feed-time" title=${fullDate(r.at)}>${ago(r.at)}</span>
    </div>`)}
    ${more && html`<div style="padding:.75rem;text-align:center"><button class="btn btn-ghost btn-sm" onClick=${() => load(rows[rows.length - 1].at)}>Show older</button></div>`}
  </div>`;
}

// ─── One family (drawer) ────────────────────────────────────────────

function Drawer({ id, fields, texting = false, summary, onClose, onPrev, onNext, onStatus, onChanged, onShowOnMap, addToast }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
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
  useEffect(() => {
    const prev = document.activeElement;
    panel.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.apl-sheet-wrap')) { e.preventDefault(); onClose(); }
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
      if (!typing && e.key === 'k' && onPrev) onPrev();
      if (!typing && e.key === 'j' && onNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    document.body.classList.add('apl-drawer-open');
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; document.body.classList.remove('apl-drawer-open'); prev?.focus?.(); };
  }, [onClose, onPrev, onNext]);

  const a = d?.applicant ? { ...summary, ...d.applicant } : summary;
  const refresh = async (applicant) => { await load(); onChanged(applicant); };

  return html`<div>
    <div class="apl-scrim" onClick=${onClose}></div>
    <aside class="apl-drawer" role="dialog" aria-modal="true" aria-label=${a ? a.name : 'Applicant'} tabindex="-1" ref=${panel}>
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
      </header>`}
      ${err && html`<div class="apl-callout is-warn" style="margin:1rem">${err} <button class="apl-more" onClick=${load}>Try again</button></div>`}
      ${!d && !err && html`<div class="apl-skel">Reading ${summary?.name || 'this family'} from JobTread…</div>`}
      ${d && html`<div class="apl-dbody">
        <${Conversation} d=${{ ...d, applicant: a }} onSent=${refresh} addToast=${addToast} texting=${texting} />
        <${SidePanel} d=${{ ...d, applicant: a }} fields=${fields} onSaved=${refresh} onShowOnMap=${onShowOnMap} addToast=${addToast} />
      </div>`}
    </aside>
  </div>`;
}

/** Comments (live from JobTread) and the history of everything else, in time order */
function timelineOf(d) {
  const siteBy = new Map();
  const fromLog = new Map();
  for (const r of d.activity) {
    if (!r.data?.commentId) continue;
    if (r.source === 'website' && ['sent', 'note', 'textOut'].includes(r.kind)) siteBy.set(r.data.commentId, r);
    else fromLog.set(r.data.commentId, r);
  }
  const items = [];
  for (const c of d.comments) {
    if (c.name === 'Comms Thread' && !c.parentId) continue; // the texting thread's starter
    const msg = c.message || '';
    const site = siteBy.get(c.id);
    let kind = 'comment';
    if (/^\/text\s/i.test(msg)) continue;                   // the command; DataX logs the sent text
    if (/New (incoming|outgoing) _message_/i.test(msg)) kind = /incoming/i.test(msg) ? 'textIn' : 'textOut';
    else if (/New (incoming|outgoing) _call_/i.test(msg)) kind = 'call';
    else if (c.fromEmail || fromLog.get(c.id)?.source === 'family') kind = 'reply';
    else if (site?.kind === 'note' || /_[^_]+, from the website_$/.test(msg)) kind = 'note';
    else if (site?.kind === 'sent' || FAMILY_TITLES.has(c.name || '')) kind = 'sent';
    else if (c.by === 'Qualification Committee' || /\(automatic\)$/.test(c.name || '') || /^Moved back to /.test(msg)) kind = 'internal';
    items.push({ type: 'msg', kind, at: c.at, c, site });
  }
  for (const r of d.activity) {
    if (COMMENT_KINDS.has(r.kind)) continue;
    items.push({ type: 'event', kind: r.kind, at: r.at, r });
  }
  return items.sort((x, y) => String(x.at).localeCompare(String(y.at)));
}

function textParts(msg) {
  const body = msg.replace(/^Company Number:[^\n]*\n+/i, '');
  const contact = (body.match(/Contact:\s*(.+)/) || [])[1] || '';
  const text = (body.match(/Message:\s*([\s\S]*)$/) || [])[1];
  const summary = (body.match(/Call Summary:\s*([\s\S]*)$/) || [])[1];
  return { contact, text: text != null ? text.trim() : null, summary: summary ? summary.trim() : null };
}

function Message({ it }) {
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
  else if (kind === 'sent') label = `Emailed to the family${site?.by ? ` by ${site.by}` : ''}`;
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
    ${body.length > 420 && html`<button class="apl-more" style=${out && kind !== 'comment' ? 'justify-self:end' : ''} onClick=${() => setOpenFull(v => !v)}>${openFull ? 'Show less' : 'Show all'}</button>`}
    ${c.files?.length > 0 && html`<div class="apl-files">${c.files.map(f => html`<span class="apl-file-chip">📎 ${f.name}</span>`)}</div>`}
  </div>`;
}

function EventLine({ r }) {
  const who = r.by ? html` · ${r.by}${r.source && SOURCE_LABEL[r.source] ? ` ${SOURCE_LABEL[r.source]}` : ''}` : '';
  return html`<div class="apl-event" title=${fullDate(r.at)}>
    ${r.kind === 'status' ? html`<${Pill} status=${r.data?.to || r.title.replace(/^Status:\s*/, '')} />` : html`<span aria-hidden="true">${FEED_ICON[r.kind] || '•'}</span>`}
    <span><b>${r.kind === 'status' ? (r.data?.from ? `Moved from ${r.data.from}` : 'Status set') : r.title}</b>${who}${r.kind === 'status' && r.body && /emailed|already|skipped|Noted/.test(r.body) ? html`<br /><span class="apl-card-sub">${r.body.split('\n').filter(l => !/^Was /.test(l)).join(' ')}</span>` : ''}${r.kind !== 'status' && r.body ? html`<br /><span class="apl-card-sub">${r.body.split('\n').slice(0, 3).join(' · ')}</span>` : ''}</span>
  </div>`;
}

function Conversation({ d, onSent, addToast, texting = false }) {
  const a = d.applicant;
  const items = useMemo(() => timelineOf(d), [d]);
  const scroller = useRef(null);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [items.length, a.id]);
  const emailable = a.contacts.filter(c => c.email);
  const [mode, setMode] = useState(emailable.length ? 'email' : 'note');
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [to, setTo] = useState(emailable.find(c => c.email === a.contact?.email)?.id || emailable[0]?.id || '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const box = useRef(null);
  const canText = texting && !!a.commsThreadId && !!a.contact?.phone;
  const textWhy = !texting ? "Texting isn't set up yet" : 'Needs a mobile number and a Comms Thread in JobTread';
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const body = correcting ? { correction: { id: a.id, subject, message: text } }
      : mode === 'email' ? { message: { id: a.id, subject, message: text, contactId: to || null } }
        : mode === 'text' ? { text: { id: a.id, message: text } } : { note: { id: a.id, message: text } };
    const j = await call(API, body);
    setBusy(false);
    if (!j.success) { addToast(j.error || 'Not sent', 'error'); return; }
    addToast(correcting ? `Correction sent to ${j.to?.name || 'the family'}` : mode === 'email' ? `Emailed ${j.to?.name || 'the family'} through JobTread` : mode === 'text' ? 'Text sent through JobTread' : 'Note added in JobTread', 'success');
    setText('');
    if (correcting) { setCorrecting(false); setSubject(DEFAULT_SUBJECT); }
    onSent();
  };
  const startCorrection = (draft) => {
    setMode('email');
    setCorrecting(true);
    setSubject(draft.subject);
    setText(draft.message);
    setTimeout(() => box.current?.focus(), 0);
  };
  let lastDay = '';
  return html`<section class="apl-convo" aria-label="Conversation">
    <div class="apl-thread" ref=${scroller}>
      <${NotifyBanner} d=${d} onChanged=${onSent} onCorrection=${startCorrection} addToast=${addToast} />
      ${!items.length && html`<div class="apl-skel">No messages yet.</div>`}
      ${items.map((it) => {
        const day = new Date(it.at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: new Date(it.at).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
        const sep = day !== lastDay ? html`<div class="apl-day">${day}</div>` : null;
        lastDay = day;
        return html`${sep}${it.type === 'msg' ? html`<${Message} it=${it} key=${it.c.id} />` : html`<${EventLine} r=${it.r} key=${it.r.id} />`}`;
      })}
    </div>
    <div class="apl-composer">
      <div class="apl-modes" role="group" aria-label="Send as">
        <button aria-pressed=${mode === 'email'} onClick=${() => setMode('email')} disabled=${!emailable.length} title=${emailable.length ? '' : 'No email address in JobTread'}>Email family</button>
        <button aria-pressed=${mode === 'text'} onClick=${() => setMode('text')} disabled=${!canText} title=${canText ? '' : textWhy}>${texting ? 'Text' : 'Text (not set up yet)'}</button>
        <button aria-pressed=${mode === 'note'} onClick=${() => setMode('note')}>Internal note</button>
      </div>
      ${mode === 'email' && html`<div class="apl-email-row" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.5rem">
        <select class="form-select" value=${to} onChange=${e => setTo(e.target.value)} aria-label="To">${emailable.map(c => html`<option value=${c.id}>To ${c.name || c.email} (${c.email})</option>`)}</select>
        <input class="form-input" value=${subject} onInput=${e => setSubject(e.target.value)} maxlength="128" aria-label="Subject" />
      </div>`}
      ${correcting && html`<div class="apl-callout">Writing a correction. When it's sent, the site counts ${a.contact?.name || 'the family'} as knowing where things stand now. <button class="apl-more" onClick=${() => { setCorrecting(false); setSubject(DEFAULT_SUBJECT); setText(''); }}>Cancel</button></div>`}
      <textarea ref=${box} class="form-input" value=${text} onInput=${e => setText(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
        placeholder=${mode === 'email' ? 'Write to the family. JobTread emails it from the Qualification Committee, and their reply lands here.' : mode === 'text' ? `Text ${a.contact?.name || 'the family'} at ${phoneText(a.contact?.phone)}` : 'Only staff see notes. Saved on the account in JobTread.'}
        aria-label="Message" maxlength=${mode === 'text' ? 1000 : 4000}></textarea>
      <div class="apl-composer-foot">
        <span>${mode === 'text' ? `${text.length}/1000 · ` : ''}⌘/Ctrl + Enter to send</span>
        <button class="btn btn-primary" onClick=${send} disabled=${busy || !text.trim()}>${busy ? 'Sending…' : correcting ? 'Send correction' : mode === 'email' ? 'Send email' : mode === 'text' ? 'Send text' : 'Add note'}</button>
      </div>
    </div>
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
  const parent = a.contact?.name || 'the family';
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
        ? html`<strong>Email held.</strong> Family emails were paused when this changed, so the ${n.label} email to ${parent} waits for someone to send it or not.`
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
    return html`<select class="form-select" value=${value ?? ''} onChange=${e => commit(e.target.value)} aria-label=${meta.label}>
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

function SidePanel({ d, fields, onSaved, onShowOnMap, addToast }) {
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
  const photos = d.files.filter(f => /^image\//.test(f.type || ''));
  const docs = d.files.filter(f => !/^image\//.test(f.type || ''));
  const visible = SIDE_FIELDS.filter(k => fields[k] && (k !== 'denialReason' || a.status === 'Denied' || a.fields?.denialReason));
  return html`<section class="apl-side" aria-label="Details">
    <div class="apl-panel">
      <h3>Details <span class="apl-card-sub" style="text-transform:none;letter-spacing:0">Saved to JobTread as you edit</span></h3>
      <dl class="apl-kv">${visible.map(k => html`<dt>${fields[k].label}</dt><dd><${FieldRow} k=${k} meta=${fields[k]} value=${a.fields?.[k] ?? (k === 'types' ? [] : '')} onSave=${save} /></dd>`)}</dl>
    </div>

    <div class="apl-panel">
      <h3>Family</h3>
      ${a.contacts.length ? a.contacts.map(c => html`<div class="apl-contact">
        <strong>${c.name}${c.title ? html` <span class="apl-card-sub" style="display:inline">· ${c.title}</span>` : ''}</strong>
        ${c.email && html`<a href=${`mailto:${c.email}`}>${c.email}</a>`}
        ${c.phone && html`<a href=${`tel:${c.phone}`}>${phoneText(c.phone)}</a>`}
      </div>`) : html`<p class="apl-card-sub">No contacts in JobTread.</p>`}
    </div>

    <div class="apl-panel">
      <h3>Home ${a.lat != null && html`<button class="apl-more" style="text-transform:none;letter-spacing:0" onClick=${() => onShowOnMap(a)}>Show on map</button>`}</h3>
      ${a.address ? html`<div style="font-size:.9rem">${a.address}</div>` : html`<p class="apl-card-sub">No home address in JobTread.</p>`}
      <div class="apl-tags">
        ${a.county && html`<span class="apl-tag">${a.county} County</span>`}
        ${a.area === 'inside' && html`<span class="apl-tag" style="background:#EAF6EF;border-color:#BFE3CD;color:#1F5C39">Inside the service area</span>`}
        ${a.area === 'outside' && html`<span class="apl-tag is-out">${a.areaMiles} miles outside the service area</span>`}
      </div>
    </div>

    ${(photos.length > 0 || docs.length > 0 || a.applicationId || a.applicationUrl) && html`<div class="apl-panel">
      <h3>Application and files</h3>
      ${a.applicationId ? html`<a class="btn btn-ghost btn-sm" style="justify-self:start" href=${`#applications/${a.applicationId}`}>View the answers from the website form</a>`
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

// ─── Status change sheet ────────────────────────────────────────────

function StatusSheet({ a, status, onClose, onDone, addToast }) {
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
  const first = (a.contact?.name || '').split(' ')[0];
  const go = async (emailNow = false) => {
    setBusy(true);
    const j = await call(API, { status: { id: a.id, status, notify: willEmail, emailNow: willEmail && emailNow, denialReason: status === 'Denied' ? reason : null } });
    setBusy(false);
    if (!j.success) { addToast(j.error || 'Not changed', 'error'); return; }
    addToast(j.email === 'scheduled' ? `${a.name} is now ${status}. ${first || 'The family'} is emailed at ${clock(j.dueAt)}.` : j.email === 'sent' ? `${a.name} is now ${status}. The family was emailed.` : `${a.name} is now ${status}.`, 'success');
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
          <span>Email this to ${m.to.name} <span class="apl-card-sub" style="display:inline">(${m.to.email})</span>${m.lang === 'es' ? ' in Spanish' : ''}</span></label>
        <div class="apl-preview" style=${notify ? '' : 'opacity:.45'}>
          <div class="apl-preview-head"><span>From <b>Qualification Committee</b> through JobTread</span><span>Subject <b>${m.title}</b></span></div>
          <div class="apl-preview-body" dangerouslySetInnerHTML=${{ __html: richText(m.message) }}></div>
        </div>
        ${notify && p.sendAt && html`<div class="apl-card-sub">Goes out at <strong>${clock(p.sendAt)}</strong>, once the status has stayed put. Change it back before then and nothing is sent.</div>`}
        ${!notify && html`<div class="apl-callout">They won't get this message, now or if the status changes in JobTread later.</div>`}`}
      ${status === 'Denied' && html`<label style="display:grid;gap:.3rem;font-size:.88rem"><span><strong>Reason</strong> <span class="apl-card-sub" style="display:inline">(staff only, saved as Denial Reason)</span></span>
        <textarea class="form-input" rows="3" value=${reason} onInput=${e => setReason(e.target.value)} placeholder="For example: outside the service area"></textarea></label>`}
      <div class="apl-sheet-foot">
        <button class="btn btn-ghost" onClick=${onClose}>Cancel</button>
        ${willEmail && html`<button class="btn btn-ghost" onClick=${() => go(true)} disabled=${busy}>Move and email now</button>`}
        <button class="btn btn-primary" ref=${confirmRef} onClick=${() => go(false)} disabled=${busy || (!p && !err)}>${busy ? 'Moving…' : willEmail ? `Move, email at ${clock(p.sendAt)}` : `Move to ${status}`}</button>
      </div>
    </div>
  </div>`;
}
