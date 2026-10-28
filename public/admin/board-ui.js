/**
 * board-ui.js — what the Board area's screens share (./board-admin.js and
 * ./board-meeting.js): the API call, the addresses, small controls, and the
 * styles. Composed from the admin's tokens and shared classes (index.html);
 * these add only what the board screens need.
 */

import { h, htm } from './vendor.js';
import { LIVE, liveLines, shortDate } from './board-shared.js';

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
  return { tab: TABS.some(([id]) => id === a) ? a : 'meetings', meetingId: null, step: null };
}
export const hashFor = (r) => (r.meetingId ? `#board/meeting/${encodeURIComponent(r.meetingId)}${r.step ? `/${r.step}` : ''}` : r.tab === 'meetings' ? '#board' : `#board/${r.tab}`);

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
export function NotesBox({ value, onChange, label, placeholder = 'Notes', big = false, tone = '' }) {
  const rows = Math.min(30, Math.max(big ? 4 : 2, String(value || '').split('\n').length + 1));
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
  return html`<textarea class=${`form-textarea bd-notes ${big ? 'bd-notes--big' : ''} ${tone}`} aria-label=${label} rows=${rows} value=${value} placeholder=${placeholder}
    onInput=${(e) => onChange(e.target.value)} onKeyDown=${onKeyDown} onFocus=${onFocus} onBlur=${onBlur} />`;
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

  /* The meeting: its head and its three steps */
  .bm-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 0.5rem 1.5rem; }
  .bm-head h2 { margin: 0; }
  .bm-saved { font-size: var(--fs-sm); color: var(--color-text-secondary); display: inline-flex; align-items: center; gap: 0.4rem; white-space: nowrap; }
  .bm-saved.is-error { color: var(--tone-warn-fg); }
  .bm-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; margin: 0.25rem 0 0; }
  .bm-step-tab { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 0.9rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); text-align: left; font: inherit; color: var(--color-text); cursor: pointer; min-width: 0; }
  .bm-step-tab:hover { border-color: var(--color-border-strong); }
  .bm-step-tab[aria-selected="true"] { border-color: var(--color-text); box-shadow: inset 0 0 0 1px var(--color-text); }
  .bm-step-tab__n { flex: 0 0 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: var(--fs-sm); background: var(--seg-bg); color: var(--color-text-secondary); }
  .bm-step-tab[aria-selected="true"] .bm-step-tab__n { background: var(--color-text); color: #fff; }
  .bm-step-tab.is-done .bm-step-tab__n { background: var(--tone-success-bg); color: var(--tone-success-fg); }
  .bm-step-tab__t { display: block; font-weight: 700; font-size: var(--fs-base); }
  .bm-step-tab__s { display: block; font-size: var(--fs-xs); color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 600px) { .bm-step-tab { padding: 0.6rem; gap: 0.5rem; } .bm-step-tab__n { display: none; } .bm-step-tab__s { white-space: normal; } }

  /* The agenda */
  .bd-section { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
  .bd-section + .bd-section { margin-top: 0.85rem; }
  .bd-section__head { display: flex; gap: 0.5rem; align-items: center; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--color-border); background: var(--color-bg-subtle, #F7F7F5); border-radius: var(--radius-md) var(--radius-md) 0 0; }
  .bd-section__num { font-weight: 700; color: var(--color-text-muted); font-size: var(--fs-sm); min-width: 1.5rem; text-align: right; }
  .bd-section__title { flex: 1; font-weight: 700; font-size: var(--fs-base); }
  .bd-section__label { flex: 1; font-weight: 700; font-size: var(--fs-md); }
  .bd-items { padding: 0.25rem 0.75rem 0.75rem; }
  .bd-item { padding: 0.75rem 0 0.6rem; border-bottom: 1px solid var(--color-border); }
  .bd-item:last-of-type { border-bottom: none; }
  .bd-item__top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 13rem) auto; gap: 0.5rem; align-items: center; }
  @media (max-width: 700px) { .bd-item__top { grid-template-columns: minmax(0, 1fr) auto; } .bd-item__top .bd-presenter { grid-column: 1 / -1; grid-row: 2; } }
  .bd-item__tags { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.4rem; }
  .bd-item__name { font-weight: 700; font-size: var(--fs-base); display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 0.6rem; }
  .bd-item__who { font-weight: 500; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .bd-item .form-textarea { min-height: 0; }
  .bd-notes { margin-top: 0.5rem; font-size: var(--fs-sm); line-height: 1.55; }
  .bd-notes--big { font-size: var(--fs-base); }
  .bd-notes.is-private { background: var(--tone-warn-surface); border-color: var(--tone-warn-line); }
  .bd-private-label { margin: 0.5rem 0 -0.25rem; font-size: var(--fs-xs); font-weight: 600; color: var(--tone-warn-fg); }

  /* Attendance */
  .bm-quorum { position: sticky; top: calc(var(--top-h, 0px) + 8px); z-index: 15; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; padding: 0.7rem 1rem; margin: 0 0 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--color-border); background: var(--color-bg-card); font-weight: 600; box-shadow: 0 6px 16px rgba(26,27,31,0.06); }
  .bm-quorum.is-met { background: var(--tone-success-surface); border-color: var(--tone-success-line); color: var(--tone-success-fg); }
  .bm-quorum.is-short { background: var(--tone-warn-surface); border-color: var(--tone-warn-line-strong); color: var(--tone-warn-fg); }
  .bm-people { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  .bm-person { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem 1rem; align-items: center; padding: 0.6rem 0.75rem; min-height: 56px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
  .bm-person__name { font-weight: 650; font-size: var(--fs-base); }
  .bm-person__meta { font-size: var(--fs-xs); color: var(--color-text-secondary); }
  .bm-choices { display: grid; grid-template-columns: repeat(4, auto); gap: 0.35rem; }
  .bm-choice { display: inline-flex; align-items: center; justify-content: center; gap: 0.3rem; min-height: 40px; padding: 0.4rem 0.8rem; border: 1px solid var(--color-border-strong); border-radius: 999px; background: var(--color-bg-card); font: inherit; font-size: var(--fs-sm); font-weight: 600; color: var(--color-text-secondary); cursor: pointer; white-space: nowrap; }
  .bm-choice:hover { color: var(--color-text); border-color: var(--color-text-secondary); }
  .bm-choice[aria-pressed="true"] { background: var(--color-text); border-color: var(--color-text); color: #fff; }
  .bm-choice--quiet { border-style: dashed; }
  @media (max-width: 760px) { .bm-person { grid-template-columns: 1fr; } .bm-choices { grid-template-columns: repeat(4, minmax(0, 1fr)); } .bm-choice { padding: 0.4rem 0.3rem; } }
  .bm-group { margin: 1rem 0 0.4rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); }
  .bm-counts { display: flex; flex-wrap: wrap; gap: 0.4rem 1.25rem; margin: 0 0 0.75rem; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .bm-counts b { color: var(--color-text); font-size: var(--fs-md); }

  /* Numbered steps (the packet, the minutes) */
  .bm-steplist { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
  .bm-steprow { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; gap: 0.75rem 1rem; align-items: center; padding: 0.75rem 0.85rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .bm-steprow__n { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: var(--fs-sm); background: var(--seg-bg); color: var(--color-text-secondary); }
  .bm-steprow.is-done .bm-steprow__n { background: var(--tone-success-bg); color: var(--tone-success-fg); }
  .bm-steprow__t { font-weight: 650; }
  .bm-steprow__s { font-size: var(--fs-sm); color: var(--color-text-secondary); margin-top: 0.1rem; }
  @media (max-width: 700px) { .bm-steprow { grid-template-columns: 32px minmax(0, 1fr); } .bm-steprow .bd-actions { grid-column: 1 / -1; } }

  /* Rows of motions, actions, files */
  .bd-lines { display: grid; gap: 0.5rem; }
  .bd-line { display: grid; gap: 0.5rem; align-items: center; padding: 0.55rem 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .bd-line--motion { grid-template-columns: minmax(0, 1fr) 11rem 11rem 9rem auto; }
  .bd-line--action { grid-template-columns: auto minmax(0, 1fr) 13rem 10rem auto; }
  .bd-line--file { grid-template-columns: minmax(0, 1fr) 12rem auto auto; }
  .bd-line.is-done { opacity: 0.65; }
  .bd-line.is-done .bd-line__text { text-decoration: line-through; }
  @media (max-width: 900px) { .bd-line--motion, .bd-line--action, .bd-line--file { grid-template-columns: 1fr; } }
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
