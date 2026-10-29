/**
 * board-ui.js — what the Board area's screens share (./board-admin.js and
 * ./board-meeting.js): the API call, the addresses, small controls, and the
 * styles. Composed from the admin's tokens and shared classes (index.html);
 * these add only what the board screens need.
 */

import { h, htm } from './vendor.js';
import { LIVE, liveLines, shortDate, todayEastern, isDate, noteBlocks, callName } from './board-shared.js';

export const html = htm.bind(h);
export const API = '/api/board-admin';
export const PAGE = '/admin/board/';

/** One call to /api/board-admin: { ok, status, ... } (never throws) */
export async function call(body, { form = null, query = '' } = {}) {
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
/** Upload a file to a meeting or a document */
export function upload(file, { ownerType, ownerId, kind = 'other', staffOnly = false }) {
  const form = new FormData();
  form.set('file', file); form.set('ownerType', ownerType); form.set('ownerId', ownerId); form.set('kind', kind); form.set('staffOnly', String(staffOnly));
  return call(null, { form, query: '?upload=1' });
}

export const fileUrl = (f) => `/api/board-file?id=${encodeURIComponent(f.id)}`;
export const viewerFiles = (files) => files.map((f) => ({ name: f.name, type: f.type, size: f.size, at: f.at, url: fileUrl(f) }));
export function ago(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} hr ago`;
  const d = Math.round(m / 1440);
  return d === 1 ? 'yesterday' : d < 14 ? `${d} days ago` : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
/** "8:42 AM" for a moment today, else ago() */
export const savedAt = (iso) => { const t = new Date(iso || 0); return Date.now() - t < 12 * 3600e3 ? t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ago(iso); };
/** What a video link is: "Google Meet", "Microsoft Teams", "Zoom" */
export { callName };
/** Whole days from today in Atlanta to a date: 0 today, 1 tomorrow, -1 yesterday; null without one */
export const daysFrom = (date, today = todayEastern()) => (isDate(date) ? Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000) : null);
export const whenWords = (d) => (d === null ? 'No date yet' : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d > 1 ? `In ${d} days` : d === -1 ? 'Yesterday' : d > -45 ? `${-d} days ago` : 'Past');
export const firstOf = (email) => { const f = String(email || '').split('@')[0]; return f ? f[0].toUpperCase() + f.slice(1) : 'the'; };
/** "you and Holly" from Settings' admins, as the person signed in sees it */
export const youAnd = (admins = [], me = '') => {
  const others = admins.filter((e) => e !== me).map(firstOf);
  return others.length ? `you and ${others.join(' and ')}` : 'you';
};

// ─── Addresses ──────────────────────────────────────────────────────
export const TABS = [['meetings', 'Meetings'], ['documents', 'Documents'], ['members', 'Members'], ['settings', 'Settings']];
export const STEPS = ['before', 'during', 'after'];
export function readHash() {
  const m = location.hash.match(/^#board(?:\/([^?]*))?/);
  if (!m) return null;
  const [a, b, c] = decodeURIComponent(m[1] || '').split('/');
  if (a === 'meeting' && b) return { tab: 'meetings', meetingId: b, step: STEPS.includes(c) ? c : null };
  if (a === 'practice') return { tab: 'meetings', meetingId: null, step: null, practice: true };
  return { tab: TABS.some(([id]) => id === a) ? a : 'meetings', meetingId: null, step: null };
}
export const hashFor = (r) => (r.practice ? '#board/practice' : r.meetingId ? `#board/meeting/${encodeURIComponent(r.meetingId)}${r.step ? `/${r.step}` : ''}` : r.tab === 'meetings' ? '#board' : `#board/${r.tab}`);

// ─── Small controls ─────────────────────────────────────────────────
export function Switch({ checked, onChange, label, disabled = false }) {
  return html`<label class="bc-switch"><input type="checkbox" role="switch" checked=${checked} aria-checked=${checked} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} /><span class="bc-switch-track" aria-hidden="true"></span><span>${label}</span></label>`;
}
export const CHECK = html`<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>`;

/** An agenda item's live facts (today's, or the packet's locked ones) */
export function LiveBox({ kind, numbers, meetingId, locked }) {
  if (!kind || kind === 'minutes') return null;
  const lines = liveLines(kind, numbers, { meetingId });
  const label = LIVE.find((l) => l.id === kind)?.label || '';
  return html`<div class="bd-live">
    <div class="bd-live__label">${label}${locked ? ` · locked ${shortDate(String(numbers?.at || '').slice(0, 10))}` : ' · today’s'}</div>
    ${lines.length ? html`<ul>${lines.map((l) => html`<li>${l}</li>`)}</ul>`
      : html`<div class="bd-muted">${kind === 'cash' ? (numbers?.mercury?.empty ? 'SOARD’s money isn’t in Mercury yet, so there’s no balance here. The financial statements have it.' : 'No balance from Mercury.') : 'Nothing to show right now.'}</div>`}
  </div>`;
}

/**
 * A notes box that writes points the way a word processor does: Enter
 * continues the point, Enter on an empty point ends the list, Tab and
 * Shift+Tab move a point in and out. (Stored as "- " lines, two spaces a level.)
 */
export function NotesBox({ value, onChange, label, placeholder = 'Notes', tone = '' }) {
  // One line while empty; then as tall as what's in it, and a line to spare
  const rows = value ? Math.min(30, Math.max(2, String(value).split('\n').length + 1)) : 1;
  // Into the box at once (the next render finds it already there), so a key pressed right away lands after the caret, not before it
  const edit = (el, text, caret) => { el.value = text; el.setSelectionRange(caret, caret); onChange(text); };
  const onKeyDown = (e) => {
    const el = e.currentTarget;
    const v = el.value;
    const start = v.lastIndexOf('\n', el.selectionStart - 1) + 1;
    const end = v.indexOf('\n', el.selectionStart) === -1 ? v.length : v.indexOf('\n', el.selectionStart);
    const line = v.slice(start, end);
    const m = line.match(/^(\s*)- (.*)$/);
    if (e.key === 'Enter' && !e.shiftKey && m) {
      e.preventDefault();
      if (!m[2].trim()) { edit(el, v.slice(0, start) + v.slice(end), start); return; } // an empty point ends the list
      const ins = `\n${m[1]}- `;
      edit(el, v.slice(0, el.selectionStart) + ins + v.slice(el.selectionEnd), el.selectionStart + ins.length);
    } else if (e.key === 'Tab' && m) {
      e.preventDefault();
      if (e.shiftKey) { if (m[1].length >= 2) edit(el, v.slice(0, start) + line.slice(2) + v.slice(end), Math.max(start, el.selectionStart - 2)); }
      else edit(el, `${v.slice(0, start)}  ${line}${v.slice(end)}`, el.selectionStart + 2);
    }
  };
  // An empty box starts as a point, so nobody needs to know how points are written
  const onFocus = (e) => { if (!e.currentTarget.value) edit(e.currentTarget, '- ', 2); };
  const onBlur = (e) => { if (/^\s*-\s*$/.test(e.currentTarget.value)) onChange(''); };
  return html`<textarea class=${`form-textarea bd-notes ${tone}`} aria-label=${label} rows=${rows} value=${value} placeholder=${placeholder}
    onInput=${(e) => onChange(e.target.value)} onKeyDown=${onKeyDown} onFocus=${onFocus} onBlur=${onBlur} />`;
}

/** Notes as they read: points (nested) and paragraphs */
export function Notes({ text }) {
  const blocks = noteBlocks(text);
  if (!blocks.length) return null;
  const list = (nodes) => html`<ul class="bm-notes">${nodes.map((n) => html`<li>${n.text}${n.children.length ? list(n.children) : null}</li>`)}</ul>`;
  const out = [];
  let run = [];
  for (const b of blocks) {
    if (b.para) { if (run.length) { out.push(list(run)); run = []; } out.push(html`<p class="bm-para">${b.text}</p>`); } else run.push(b);
  }
  if (run.length) out.push(list(run));
  return out;
}

/** A small "⋯" menu of actions; closes when one is chosen or on a click elsewhere */
export function Menu({ label, items }) {
  const close = (el) => el.closest('details')?.removeAttribute('open');
  return html`<details class="bd-menu" onToggle=${(e) => {
    const d = e.currentTarget;
    if (!d.open) return;
    const away = (ev) => { if (!d.contains(ev.target)) { d.removeAttribute('open'); document.removeEventListener('pointerdown', away, true); } };
    document.addEventListener('pointerdown', away, true);
  }}>
    <summary class="bd-icon-btn" aria-label=${label} title=${label}>⋯</summary>
    <div class="bd-menu__list" role="menu">
      ${items.filter(Boolean).map((it) => html`<button type="button" role="menuitem" class=${`bd-menu__item ${it.danger ? 'is-danger' : ''}`} disabled=${it.disabled} onClick=${(e) => { close(e.currentTarget); it.run(); }}>${it.label}</button>`)}
    </div>
  </details>`;
}

// ─── Styles ─────────────────────────────────────────────────────────
export const STYLES = `
  .bd { display: grid; gap: 1rem; }
  .bd > .card, .bd-col > .card, .bm-pane > .card { margin-bottom: 0; }
  .bd-col, .bm-pane { display: grid; gap: 1rem; }
  .bd h3 { margin: 0; font-size: var(--fs-md); }
  .bd-muted { color: var(--color-text-secondary); font-size: var(--fs-sm); line-height: 1.5; margin: 0; }
  .bd-card-head { margin: 0 0 1rem; }
  .bd-card-head h3 { margin: 0; font-size: var(--fs-md); font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; }
  .bd-card-head p { margin: 0.3rem 0 0; max-width: 72ch; font-size: var(--fs-sm); line-height: 1.5; color: var(--color-text-secondary); }
  .bd-card-head--row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 0.5rem 1rem; }
  .bd-row-list { list-style: none; margin: 0; padding: 0; }
  .bd-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; padding: 0.85rem 1.25rem; border-bottom: 1px solid var(--color-border); }
  .bd-row:last-child { border-bottom: none; }
  .bd-row--link { cursor: pointer; }
  .bd-row--link:hover { background: var(--color-bg-hover, rgba(26,27,31,0.03)); }
  .bd-row__main { min-width: 0; flex: 1 1 18rem; }
  .bd-row__title { font-weight: 650; font-size: var(--fs-base); color: var(--color-text); text-decoration: none; }
  a.bd-row__title:hover { text-decoration: underline; text-underline-offset: 3px; }
  .bd-row__meta { margin-top: 0.15rem; font-size: var(--fs-sm); color: var(--color-text-secondary); overflow-wrap: anywhere; }
  .bd-next { margin-top: 0.2rem; font-size: var(--fs-sm); font-weight: 600; color: var(--tone-info-fg); }
  .bd-tags { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
  .bd-year { padding: 0.55rem 1.25rem; background: var(--color-bg-subtle, #F7F7F5); border-bottom: 1px solid var(--color-border); font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); }
  .bd-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .bd-inline { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .bd-inline .form-input { width: auto; }
  .bd-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: var(--fs-sm); cursor: pointer; }
  .bd-check input { width: 16px; height: 16px; margin: 0; }
  .bd-back { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--color-text-secondary); font-size: var(--fs-sm); text-decoration: none; margin-bottom: 0.25rem; }
  .bd-back:hover { color: var(--color-text); }
  .bd-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.85rem 1rem; }
  .bd-grid3 .span-3 { grid-column: 1 / -1; }
  @media (max-width: 900px) { .bd-grid3 { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 600px) { .bd-grid3 { grid-template-columns: 1fr; } .bd-grid3 .span-3 { grid-column: 1; } }
  .bd-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: var(--seg-bg); padding: 0.05rem 0.35rem; border-radius: 5px; overflow-wrap: anywhere; }
  .bd-icon-btn { border: none; background: none; width: 34px; height: 34px; border-radius: 8px; color: var(--color-text-muted); cursor: pointer; display: inline-grid; place-items: center; font-size: 17px; line-height: 1; list-style: none; }
  .bd-icon-btn::-webkit-details-marker { display: none; }
  .bd-icon-btn:hover:not(:disabled) { background: var(--seg-bg); color: var(--color-text); }
  .bd-icon-btn:disabled { opacity: 0.35; cursor: default; }
  .bd-drop { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; padding: 0.9rem 1rem; border: 1px dashed var(--color-border-strong); border-radius: var(--radius-md); }
  .bd-drop.is-over { background: var(--tone-info-surface); border-color: var(--tone-info-line-strong); }
  .bd-live { margin: 0.5rem 0 0; padding: 0.55rem 0.75rem; border-radius: var(--radius-md); background: var(--tone-info-surface); border: 1px solid var(--tone-info-line); font-size: var(--fs-sm); line-height: 1.5; }
  .bd-live ul { margin: 0.25rem 0 0 1.1rem; padding: 0; }
  .bd-live__label { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.04em; color: var(--tone-info-fg); }

  /* ⋯ menus */
  .bd-menu { position: relative; display: inline-block; }
  .bd-menu > summary { list-style: none; }
  .bd-menu__list { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 14rem; padding: 0.3rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); box-shadow: 0 10px 30px rgba(26,27,31,0.14); }
  .bd-menu:not([open]) .bd-menu__list { display: none; }
  .bd-menu__item { display: block; width: 100%; text-align: left; padding: 0.5rem 0.65rem; border: none; border-radius: 6px; background: none; font: inherit; font-size: var(--fs-sm); color: var(--color-text); cursor: pointer; }
  .bd-menu__item:hover:not(:disabled) { background: var(--seg-bg); }
  .bd-menu__item:disabled { opacity: 0.4; cursor: default; }
  .bd-menu__item.is-danger { color: var(--tone-danger-fg); }

  /* Meetings: the next one, its agenda, past meetings */
  .bh-date { flex: none; width: 64px; display: grid; justify-items: center; align-content: center; padding: 0.45rem 0 0.5rem; border-radius: var(--radius-md); background: var(--color-text); color: #fff; line-height: 1; }
  .bh-date__m { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.1em; color: var(--color-primary); }
  .bh-date__d { margin-top: 0.2rem; font-size: 1.75rem; font-weight: 800; letter-spacing: -0.03em; }
  .bh-date__w { margin-top: 0.25rem; font-size: var(--fs-2xs); font-weight: 600; opacity: 0.75; }
  .bh-date--sm { width: 46px; padding: 0.35rem 0; background: var(--seg-bg); color: var(--color-text); }
  .bh-date--sm .bh-date__m { color: var(--color-text-secondary); }
  .bh-date--sm .bh-date__d { font-size: 1.2rem; margin-top: 0.1rem; }
  .bh-next__top { display: flex; align-items: center; gap: 1rem 1.25rem; flex-wrap: wrap; }
  .bh-next__main { flex: 1 1 18rem; min-width: 0; }
  .bh-eyebrow { margin: 0; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); }
  .bh-next__title { margin: 0.2rem 0 0 !important; font-size: var(--fs-lg, 1.25rem) !important; letter-spacing: -0.015em; }
  .bh-next__title a { color: inherit; text-decoration: none; }
  .bh-next__title a:hover { text-decoration: underline; text-underline-offset: 3px; }
  .bh-facts { margin: 0.3rem 0 0; display: flex; flex-wrap: wrap; row-gap: 0.2rem; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .bh-facts > * + *::before { content: '·'; margin: 0 0.55rem; color: var(--color-text-muted); }
  @media (max-width: 600px) { .bh-facts, .bm-facts { display: grid; justify-items: start; } .bh-facts > * + *::before, .bm-facts > * + *::before { content: none; } }
  .bh-prep { list-style: none; margin: 1.1rem 0 0; padding: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.4rem; }
  .bh-prep li { display: flex; align-items: center; gap: 0.45rem; min-width: 0; padding: 0.5rem 0.6rem; border-radius: var(--radius-md); background: var(--seg-bg); font-size: var(--fs-sm); font-weight: 600; color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bh-prep li.is-done { background: var(--tone-success-surface); color: var(--tone-success-fg); }
  .bh-prep li.is-next { background: var(--color-bg-card); color: var(--color-text); box-shadow: inset 0 0 0 2px var(--color-text); }
  .bh-prep__mark { flex: none; width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; display: grid; place-items: center; box-sizing: border-box; opacity: 0.8; }
  .bh-prep li.is-done .bh-prep__mark { border: none; background: var(--tone-success-bg); opacity: 1; }
  .bh-prep__mark svg { width: 11px; height: 11px; }
  @media (max-width: 760px) { .bh-prep { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .bh-nextline { margin: 0.85rem 0 0; font-size: var(--fs-base); line-height: 1.5; }
  .bh-rsvp { margin: 0.35rem 0 0; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .bh-rsvp strong { color: var(--color-text); font-weight: 650; }
  .bh-agenda { margin: 0.9rem 0 0; padding: 0 0 0 1.5rem; columns: 2 20rem; column-gap: 2.5rem; }
  .bh-agenda > li { break-inside: avoid; margin: 0 0 0.6rem; line-height: 1.45; }
  .bh-agenda > li::marker { font-weight: 700; color: var(--color-text-muted); }
  .bh-agenda__sec { display: block; font-weight: 700; }
  .bh-agenda__items { display: block; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .bh-row { display: flex; align-items: center; gap: 0.9rem; padding: 0.75rem 1.25rem; border-bottom: 1px solid var(--color-border); cursor: pointer; flex-wrap: wrap; }
  .bh-row:last-child { border-bottom: none; }
  .bh-row:hover { background: var(--color-bg-hover, rgba(26,27,31,0.03)); }
  .bh-row__main { flex: 1 1 16rem; min-width: 0; }
  .bh-past-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; }
  .bh-sources { padding: 0 0.25rem; }

  /* The meeting: its head, its three stages, and the main column beside its checklist */
  .bm-top { display: grid; gap: 0.75rem; }
  .bm-top__bar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.5rem 1rem; }
  .bm-top__bar .bd-back { margin: 0; }
  .bm-title h2 { margin: 0.45rem 0 0; font-size: clamp(1.4rem, 1.1rem + 1vw, 1.75rem); letter-spacing: -0.02em; line-height: 1.2; }
  .bm-when { display: inline-flex; align-items: center; height: 24px; padding: 0 0.6rem; border-radius: 999px; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; background: var(--seg-bg); color: var(--color-text-secondary); }
  .bm-when.is-ahead { background: var(--tone-info-bg); color: var(--tone-info-fg); }
  .bm-when.is-today { background: var(--color-primary); color: #1A1B1F; }
  .bm-facts { margin: 0.4rem 0 0; display: flex; flex-wrap: wrap; align-items: baseline; row-gap: 0.25rem; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .bm-facts > * + *::before { content: '·'; margin: 0 0.55rem; color: var(--color-text-muted); text-decoration: none; display: inline-block; }
  .bm-link { border: none; background: none; padding: 0; font: inherit; color: var(--tone-info-fg); font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
  .bm-link:hover { color: var(--color-text); }
  .bm-saved { font-size: var(--fs-sm); color: var(--color-text-secondary); display: inline-flex; align-items: center; gap: 0.4rem; white-space: nowrap; }
  .bm-saved.is-error { color: var(--tone-warn-fg); }
  .bm-stages { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); overflow: hidden; }
  .bm-stage { display: flex; align-items: center; gap: 0.7rem; padding: 0.75rem 0.95rem; border: none; border-left: 1px solid var(--color-border); background: none; text-align: left; font: inherit; color: var(--color-text); cursor: pointer; min-width: 0; }
  .bm-stage:first-child { border-left: none; }
  .bm-stage:hover { background: var(--color-bg-hover, rgba(26,27,31,0.03)); }
  .bm-stage[aria-selected="true"] { background: var(--color-bg-subtle, #F7F7F5); box-shadow: inset 0 -3px 0 var(--color-text); }
  .bm-stage__n { flex: 0 0 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: var(--fs-sm); background: var(--seg-bg); color: var(--color-text-secondary); }
  .bm-stage[aria-selected="true"] .bm-stage__n { background: var(--color-text); color: #fff; }
  .bm-stage.is-done .bm-stage__n { background: var(--tone-success-bg); color: var(--tone-success-fg); }
  .bm-stage__t { display: block; font-weight: 700; font-size: var(--fs-base); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bm-stage__what { font-weight: 500; color: var(--color-text-secondary); }
  .bm-stage__s { display: block; font-size: var(--fs-xs); color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 760px) { .bm-stage { padding: 0.6rem; gap: 0.5rem; } .bm-stage__n, .bm-stage__what { display: none; } .bm-stage__s { white-space: normal; } }
  .bm-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(19rem, 23rem); gap: 1rem; align-items: start; }
  .bm-main, .bm-aside { display: grid; gap: 1rem; min-width: 0; }
  .bm-main > .card, .bm-aside > .card { margin: 0; }
  .bm-aside { position: sticky; top: calc(var(--top-h, 0px) + 1rem); max-height: calc(100vh - var(--top-h, 0px) - 2rem); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; border-radius: var(--radius-md); }
  @media (max-width: 1180px) { .bm-layout { grid-template-columns: minmax(0, 1fr); } .bm-aside { position: static; order: -1; max-height: none; overflow: visible; } }

  /* A checklist: done, the next thing, still to come */
  .bm-tasks { list-style: none; margin: 0; padding: 0; display: grid; }
  .bm-task { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 0.75rem; padding: 0.85rem 0; border-top: 1px solid var(--color-border); }
  .bm-task:first-child { border-top: none; padding-top: 0.15rem; }
  .bm-task__mark { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--color-border-strong); display: grid; place-items: center; margin-top: 1px; box-sizing: border-box; }
  .bm-task__mark svg { width: 13px; height: 13px; }
  .bm-task.is-done .bm-task__mark { background: var(--tone-success-bg); border-color: transparent; color: var(--tone-success-fg); }
  .bm-task.is-next .bm-task__mark { border-color: var(--color-text); box-shadow: 0 0 0 4px var(--color-primary); }
  .bm-task.is-done .bm-task__t { color: var(--color-text-secondary); }
  .bm-task__t { font-weight: 650; line-height: 1.35; }
  .bm-task.is-next .bm-task__t { font-weight: 750; }
  .bm-task__s { margin-top: 0.2rem; font-size: var(--fs-sm); color: var(--color-text-secondary); line-height: 1.5; overflow-wrap: anywhere; }
  .bm-task__do { margin-top: 0.6rem; display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .bm-check .bd-card-head { margin-bottom: 0.85rem; }

  /* Who's coming */
  .bm-bar { display: flex; gap: 2px; height: 8px; border-radius: 999px; overflow: hidden; background: var(--seg-bg); }
  .bm-bar__part.is-yes { background: var(--tone-success-fg); }
  .bm-bar__part.is-maybe { background: var(--tone-warn-fg); }
  .bm-bar__part.is-no { background: var(--color-text-muted); }
  .bm-bar__part.is-none { background: var(--color-border-strong); }
  .bm-who { margin: 0.75rem 0 0; display: grid; gap: 0.5rem; }
  .bm-who dt { font-size: var(--fs-xs); font-weight: 700; color: var(--color-text-secondary); }
  .bm-who dt b { color: var(--color-text); margin-left: 0.15rem; }
  .bm-who dd { margin: 0.1rem 0 0; font-size: var(--fs-sm); line-height: 1.5; }
  .bm-who--doc { margin: 0 0 1.1rem; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.75rem 1.25rem; padding: 0.85rem 1rem; border-radius: var(--radius-md); background: var(--color-bg-subtle, #F7F7F5); }

  /* The agenda, as it reads, editable in place */
  .ag { display: grid; }
  .ag-sec { padding: 0.65rem 0; border-top: 1px solid var(--color-border); }
  .ag-sec:first-child { border-top: none; padding-top: 0.1rem; }
  .ag-sec__head { display: flex; align-items: center; gap: 0.55rem; }
  .ag-num { flex: 0 0 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; background: var(--color-text); color: #fff; font-weight: 700; font-size: var(--fs-xs); }
  .ag-sec__label { margin: 0; flex: 1; font-size: var(--fs-md); font-weight: 700; }
  .ag-input { flex: 1; min-width: 0; height: 36px; border: 1px solid transparent; background: transparent; border-radius: 7px; padding: 0 0.5rem; font: inherit; color: var(--color-text); }
  .ag-input:hover { background: var(--color-bg-subtle, #F7F7F5); }
  .ag-input:focus { outline: none; background: var(--color-bg-card); border-color: var(--color-border-strong); box-shadow: 0 0 0 3px rgba(26,27,31,0.07); }
  .ag-input::placeholder { color: var(--color-text-muted); }
  .ag-input--sec { font-weight: 700; font-size: var(--fs-md); }
  .ag-input--who { flex: 0 0 9.5rem; text-align: right; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .ag-input--who:focus { text-align: left; }
  @media (hover: hover) { .ag-input--who:placeholder-shown:not(:focus):not(.is-shown) { opacity: 0; } .ag-item__row:hover .ag-input--who:placeholder-shown { opacity: 1; } }
  .ag-items { list-style: none; margin: 0.15rem 0 0; padding: 0 0 0 2.05rem; }
  .ag-item__row { display: flex; align-items: center; gap: 0.25rem; }
  .ag-dot { flex: 0 0 6px; height: 6px; margin: 0 0.15rem 0 0.3rem; border-radius: 50%; background: var(--color-text-muted); }
  .ag-tags { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.1rem 0 0.3rem 1.25rem; }
  .ag-item > .bd-notes, .ag-item > .bd-private-label { margin-left: 1.25rem; width: calc(100% - 1.25rem); }
  .ag-item > .bd-notes { margin-bottom: 0.35rem; }
  .ag-add { border: none; background: none; height: 32px; padding: 0 0.5rem; margin-left: 0.85rem; font: inherit; font-size: var(--fs-sm); font-weight: 600; color: var(--color-text-secondary); cursor: pointer; border-radius: 7px; }
  .ag-add:hover { color: var(--color-text); background: var(--seg-bg); }
  .ag-add--sec { margin: 0.6rem 0 0; justify-self: start; }
  .ag--run .ag-items { display: grid; gap: 0.9rem; margin-top: 0.6rem; }
  .ag-item__name { font-weight: 650; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.6rem; }
  .ag-item__who { font-weight: 500; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .ag-item__name .bm-link { margin-left: auto; font-size: var(--fs-xs); font-weight: 500; color: var(--color-text-muted); }
  .ag--run .bd-notes { margin-top: 0.4rem; }
  .ag-item .form-textarea { min-height: 0; resize: vertical; }
  .ag-empty { padding-left: 2.05rem; margin-top: 0.35rem; }
  @media (max-width: 600px) {
    .ag-items { padding-left: 0.4rem; }
    .ag-dot { display: none; }
    .ag-tags, .ag-item > .bd-notes, .ag-item > .bd-private-label { margin-left: 0.5rem; width: calc(100% - 0.5rem); }
    /* Who presents goes under the item, and only once there's someone (⋯ → Add who presents) */
    .ag-item__row { flex-wrap: wrap; }
    .ag-item__row > .ag-input:not(.ag-input--who) { flex: 1 1 10rem; }
    .ag-input--who { order: 3; flex: 1 1 100%; height: 30px; text-align: left; }
    .ag-input--who:placeholder-shown:not(:focus):not(.is-shown) { display: none; }
  }

  /* Files, by what they are */
  .bf-group + .bf-group { margin-top: 0.85rem; }
  .bf-group .bm-group { margin-top: 0; }
  .bf-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .bf-file { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.5rem 0.5rem 0.85rem; border-top: 1px solid var(--color-border); }
  .bf-file:first-child { border-top: none; }
  .bf-file__main { flex: 1; min-width: 0; }
  .bf-seen { display: inline-flex; align-items: center; gap: 0.3rem; height: 32px; padding: 0 0.7rem; border-radius: 999px; border: 1px solid var(--tone-success-line, var(--color-border)); background: var(--tone-success-surface); color: var(--tone-success-fg); font: inherit; font-size: var(--fs-xs); font-weight: 650; cursor: pointer; white-space: nowrap; }
  .bf-seen svg { width: 13px; height: 13px; }
  .bf-seen.is-staff { background: var(--tone-warn-surface); border-color: var(--tone-warn-line); color: var(--tone-warn-fg); }
  @media (max-width: 600px) { .bf-file { flex-wrap: wrap; } .bf-file__main { flex-basis: 100%; } }

  /* The minutes, as the board reads them */
  .bm-doc h4 { margin: 0; font-size: var(--fs-base); font-weight: 700; }
  .bm-doc__sections { margin: 0; padding: 0 0 0 1.35rem; display: grid; gap: 0.9rem; }
  .bm-doc__sections > li::marker { font-weight: 700; color: var(--color-text-muted); }
  .bm-doc__items { margin: 0.3rem 0 0; padding-left: 1.1rem; display: grid; gap: 0.4rem; font-size: var(--fs-sm); line-height: 1.55; }
  .bm-doc__item { font-weight: 600; display: inline-flex; flex-wrap: wrap; gap: 0.2rem 0.5rem; align-items: baseline; }
  .bm-doc__h { margin-top: 1.25rem !important; }
  .bm-notes { margin: 0.2rem 0 0; padding-left: 1.1rem; font-weight: 400; }
  .bm-para { margin: 0.2rem 0 0; }

  /* The agenda */
  .bd-section { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
  .bd-section + .bd-section { margin-top: 0.85rem; }
  .bd-section__head { display: flex; gap: 0.5rem; align-items: center; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--color-border); background: var(--color-bg-subtle, #F7F7F5); border-radius: var(--radius-md) var(--radius-md) 0 0; }
  .bd-section__num { font-weight: 700; color: var(--color-text-muted); font-size: var(--fs-sm); min-width: 1.5rem; text-align: right; }
  .bd-section__title { flex: 1; font-weight: 700; font-size: var(--fs-base); }
  .bd-items { padding: 0.25rem 0.75rem 0.75rem; }
  .bd-item { padding: 0.75rem 0 0.6rem; border-bottom: 1px solid var(--color-border); }
  .bd-item:last-of-type { border-bottom: none; }
  .bd-item__top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 13rem) auto; gap: 0.5rem; align-items: center; }
  .bd-item .form-textarea { min-height: 0; }
  .bd-notes { margin-top: 0.5rem; font-size: var(--fs-sm); line-height: 1.55; }
  .bd-notes.is-private { background: var(--tone-warn-surface); border-color: var(--tone-warn-line); }
  .bd-private-label { margin: 0.5rem 0 -0.25rem; font-size: var(--fs-xs); font-weight: 600; color: var(--tone-warn-fg); }

  /* Attendance */
  .bm-quorum__n { font-size: 2.1rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1; color: var(--color-text-secondary); }
  .bm-quorum__n b { color: var(--color-text); }
  .bm-quorum__t { margin-top: 0.3rem; font-weight: 650; }
  .bm-quorum__q { margin: 0.6rem 0 0.75rem; font-size: var(--fs-sm); line-height: 1.5; }
  .bm-quorum.is-met { background: var(--tone-success-surface); border-color: var(--tone-success-line); }
  .bm-quorum.is-met .bm-quorum__q { color: var(--tone-success-fg); font-weight: 650; }
  .bm-quorum.is-short { background: var(--tone-warn-surface); border-color: var(--tone-warn-line-strong); }
  .bm-quorum.is-short .bm-quorum__q { color: var(--tone-warn-fg); font-weight: 650; }
  .bm-people { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 24rem), 1fr)); gap: 0.5rem; }
  .bm-person { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem 0.75rem; padding: 0.45rem 0.45rem 0.45rem 0.8rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); min-width: 0; }
  .bm-person__who { min-width: 0; }
  .bm-person__name { font-weight: 650; }
  .bm-person__meta { font-size: var(--fs-xs); color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bm-choices { flex: none; display: inline-grid; grid-auto-flow: column; gap: 2px; padding: 3px; border-radius: 999px; background: var(--seg-bg); }
  .bm-choice { min-height: 34px; padding: 0 0.65rem; border: none; border-radius: 999px; background: none; font: inherit; font-size: var(--fs-xs); font-weight: 650; color: var(--color-text-secondary); cursor: pointer; white-space: nowrap; }
  .bm-choice:hover { color: var(--color-text); }
  .bm-choice[aria-pressed="true"] { background: var(--color-bg-card); color: var(--color-text); box-shadow: 0 1px 3px rgba(26,27,31,0.18); }
  .bm-choice.is-present[aria-pressed="true"], .bm-choice.is-remote[aria-pressed="true"] { background: var(--tone-success-bg); color: var(--tone-success-fg); }
  @media (max-width: 560px) { .bm-person { flex-wrap: wrap; } .bm-choices { width: 100%; grid-auto-columns: minmax(0, 1fr); } .bm-choice { min-height: 40px; padding: 0 0.3rem; } }
  .bm-group { margin: 1rem 0 0.4rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); }

  /* Rows of motions, actions, files */
  .bd-lines { display: grid; gap: 0.5rem; }
  .bd-line { display: grid; gap: 0.5rem; align-items: center; padding: 0.55rem 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .bd-line--motion { grid-template-columns: minmax(0, 1fr) 11rem 11rem 9rem auto; }
  .bd-line--action { grid-template-columns: auto minmax(0, 1fr) 13rem 10rem auto; }
  .bd-line.is-done { opacity: 0.65; }
  .bd-line.is-done .bd-line__text { text-decoration: line-through; }
  @media (max-width: 900px) { .bd-line--motion, .bd-line--action { grid-template-columns: 1fr; } }
  .bd-line input[type="checkbox"] { width: 22px; height: 22px; margin: 0; }
  .bd-file-name { font-weight: 600; text-decoration: none; color: var(--color-text); overflow-wrap: anywhere; }
  .bd-file-name:hover { text-decoration: underline; text-underline-offset: 3px; }

  /* Bring in an old agenda */
  .bd-import textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs); }
  .bd-preview { margin-top: 1rem; display: grid; gap: 0.75rem; }
  .bd-preview ol { margin: 0.25rem 0 0 1.25rem; padding: 0; }
  .bd-preview li { margin: 0.15rem 0; }
  .bd-pre { white-space: pre-wrap; margin: 0.15rem 0 0.35rem; color: var(--color-text-secondary); font-size: var(--fs-xs); }

  /* Members */
  .bd-steps { margin: 0.5rem 0 0 1.25rem; padding: 0; display: grid; gap: 0.5rem; font-size: var(--fs-sm); line-height: 1.55; }
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
  .bd-savebar { position: sticky; bottom: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.75rem 1rem; background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: var(--radius-md); box-shadow: 0 -6px 18px rgba(26,27,31,0.06); }
  .bd-savebar__state { font-size: var(--fs-sm); color: var(--color-text-secondary); }

  /* The meeting as it's held (During): the run bar, the item being discussed, a vote open on the board page.
     Live is brand yellow with a pulse, never red. Flat fills only. */
  .bd-quiet { margin: -0.25rem 0 0; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .bm-practice { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem 1.25rem; padding: 0.85rem 1rem; border: 1px solid var(--tone-info-line); border-radius: var(--radius-md); background: var(--tone-info-surface); color: var(--color-text); font-size: var(--fs-sm); line-height: 1.5; }
  .bm-practice > div { flex: 1 1 26rem; min-width: 0; }
  .bm-live-dot { position: relative; display: inline-block; flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--color-primary); box-shadow: 0 0 0 2px rgba(26,27,31,0.85); }
  .bm-live-dot::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid var(--color-primary); animation: bm-pulse 1.6s cubic-bezier(0.22,1,0.36,1) infinite; }
  @keyframes bm-pulse { 0% { transform: scale(0.55); opacity: 0.95; } 100% { transform: scale(1.7); opacity: 0; } }
  .bm-run { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.75rem 1.25rem; }
  .bm-run.is-ready, .bm-run.is-ended { grid-template-columns: minmax(0, 1fr) auto; }
  .bm-run__lead p { margin: 0.25rem 0 0; font-size: var(--fs-sm); color: var(--color-text-secondary); line-height: 1.5; max-width: 46rem; }
  .bm-run__state { font-size: var(--fs-2xs); font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-text-secondary); }
  .bm-run.is-live { position: sticky; top: calc(var(--top-h, 0px) + 0.5rem); z-index: 15; background: #1F201C; border-color: #1F201C; color: #F6F4EC; box-shadow: 0 10px 28px -12px rgba(26,27,31,0.55); }
  .bm-run.is-live .bm-run__state { color: var(--color-primary); }
  .bm-run__clock { display: flex; align-items: center; gap: 0.6rem; }
  .bm-run__time { font-variant-numeric: tabular-nums; font-weight: 700; font-size: var(--fs-md); letter-spacing: 0.01em; }
  .bm-run__now { display: grid; min-width: 0; }
  .bm-run__label { font-size: var(--fs-2xs); font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-primary); }
  .bm-run__title { font-size: var(--fs-lg, 1.15rem); font-weight: 750; letter-spacing: -0.01em; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bm-run__sec { font-size: var(--fs-xs); color: rgba(246,244,236,0.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bm-run__do { display: flex; flex-wrap: wrap; gap: 0.4rem; justify-content: flex-end; }
  .bm-run.is-live .btn-ghost { background: rgba(246,244,236,0.1); border-color: rgba(246,244,236,0.2); color: #F6F4EC; }
  .bm-run.is-live .btn-ghost:hover:not(:disabled) { background: rgba(246,244,236,0.18); }
  .bm-run.is-live .btn:disabled { opacity: 0.4; }
  .bm-run__hint { grid-column: 1 / -1; margin: 0; font-size: var(--fs-xs); color: rgba(246,244,236,0.65); }
  .bm-run__hint .kbd { background: rgba(246,244,236,0.12); border-color: rgba(246,244,236,0.25); color: #F6F4EC; }
  @media (max-width: 760px) { .bm-run, .bm-run.is-ready, .bm-run.is-ended { grid-template-columns: minmax(0, 1fr); } .bm-run__do { justify-content: flex-start; } .bm-run__title { white-space: normal; } }
  .ag--run .ag-item { scroll-margin: calc(var(--top-h, 0px) + 9rem); border-radius: var(--radius-md); transition: background 0.3s, box-shadow 0.3s; }
  .ag--run .ag-item.is-now { background: var(--color-primary-bg); box-shadow: 0 0 0 1px var(--color-primary), 0 0 0 6px var(--color-primary-bg); padding: 0.5rem 0.6rem; margin: -0.5rem -0.6rem; }
  .bm-now { display: inline-flex; align-items: center; gap: 0.45rem; height: 22px; padding: 0 0.55rem 0 0.45rem; border-radius: 999px; background: #1F201C; color: var(--color-primary); font-size: var(--fs-2xs); font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
  .bm-now .bm-live-dot { width: 7px; height: 7px; box-shadow: none; }
  .bm-now .bm-live-dot::after { inset: -3px; }
  .ag-item__name .bm-discuss { margin-left: auto; font-size: var(--fs-xs); font-weight: 650; color: var(--tone-info-fg); }
  .ag-item__name .bm-discuss + .bm-link { margin-left: 0.85rem; }
  .bm-person.is-checked { border-color: var(--tone-success-line); }
  .bm-motion { display: grid; gap: 0.5rem; }
  .bm-motion.is-voting > .bd-line { border-color: var(--color-text); }
  .bm-vote-line { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; padding: 0 0.15rem; font-size: var(--fs-sm); }
  .bm-vote { display: grid; gap: 0.85rem; padding: 1rem 1.1rem; border-radius: var(--radius-md); background: var(--color-primary-bg); border: 1px solid var(--color-primary); }
  .bm-vote__head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; }
  .bm-vote__counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
  .bm-vote__n { display: grid; gap: 0.15rem; padding: 0.7rem 0.8rem; border-radius: var(--radius-md); background: var(--color-bg-card); border: 1px solid var(--color-border); }
  .bm-vote__num { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1; font-variant-numeric: tabular-nums; }
  .bm-vote__lab { font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-secondary); }
  .bm-vote__bar { height: 6px; border-radius: 999px; background: var(--seg-bg); overflow: hidden; margin-top: 0.35rem; }
  .bm-vote__bar i { display: block; height: 100%; width: var(--w); border-radius: inherit; background: var(--color-text-muted); transition: width 0.5s cubic-bezier(0.22,1,0.36,1); }
  .bm-vote__n.is-for .bm-vote__bar i { background: var(--tone-success-fg); }
  .bm-vote__n.is-against .bm-vote__bar i { background: var(--color-text); }
  .bm-vote__who { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .bm-vote__who li { display: inline-flex; align-items: center; gap: 0.35rem; height: 28px; padding: 0 0.65rem; border-radius: 999px; background: var(--color-bg-card); border: 1px solid var(--color-border); font-size: var(--fs-xs); font-weight: 650; animation: bm-in 0.35s cubic-bezier(0.22,1,0.36,1) both; }
  .bm-vote__who li span { font-weight: 500; color: var(--color-text-secondary); }
  .bm-vote__who li.is-for { border-color: var(--tone-success-line); }
  @keyframes bm-in { from { opacity: 0; transform: translateY(4px) scale(0.96); } }
  @media (max-width: 560px) { .bm-vote__counts { grid-template-columns: minmax(0, 1fr); } }
  @media (prefers-reduced-motion: reduce) { .bm-live-dot::after, .bm-vote__who li { animation: none; } .bm-vote__bar i, .ag--run .ag-item { transition: none; } }
`;
let stylesIn = false;
export function injectStyles() {
  if (stylesIn) return;
  stylesIn = true;
  const el = document.createElement('style');
  el.id = 'bd-styles';
  el.textContent = STYLES;
  document.head.appendChild(el);
}
