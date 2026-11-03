/**
 * board-ui.js — what the Board area's screens share (./board-admin.js and
 * ./board-meeting.js): the API call, the addresses, small controls, and the
 * styles. Composed from the admin's tokens and shared classes (index.html);
 * these add only what the board screens need.
 */

import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';
import { float, floatRef } from './float.js';
import { LIVE, liveLines, shortDate, todayEastern, isDate, noteBlocks, callName, fileTitle, docTitle, namesText, SHOW_KINDS, LIVE_TITLES } from './board-shared.js';

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

// Line icons for menu actions, drawn in the text's color (24 × 24, one stroked path each)
const MENU_ICONS = {
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c.8-3.6 3.9-5.5 7.5-5.5s6.7 1.9 7.5 5.5',
  doc: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8zM14 3v5h5M12 11.5v6M9 14.5h6',
  report: 'M4 20h4.5L19.3 9.2a2.1 2.1 0 0 0 0-3l-1.5-1.5a2.1 2.1 0 0 0-3 0L4 15.5zM13.5 6.5l4 4',
  live: 'M3 12h4l3-7 4 14 3-7h4',
  lock: 'M7.5 11V8a4.5 4.5 0 0 1 9 0v3M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-7A1.5 1.5 0 0 1 6.5 11z',
  private: 'M3 3l18 18M10.6 5.1A9.6 9.6 0 0 1 12 5c5.5 0 9.5 7 9.5 7a17 17 0 0 1-3 3.8M6.4 6.4C3.9 8.2 2.5 12 2.5 12s4 7 9.5 7a9.4 9.4 0 0 0 4.6-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  remove: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  trash: 'M4 7h16M9.5 7V4.5h5V7M6.5 7l.9 12.2A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.8L17.5 7M10 11v6M14 11v6',
  rename: 'M4 20h4.5L19.3 9.2a2.1 2.1 0 0 0 0-3l-1.5-1.5a2.1 2.1 0 0 0-3 0L4 15.5zM13.5 6.5l4 4',
  open: 'M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
};
const menuIcon = (name) => (MENU_ICONS[name] ? html`<svg class="bd-menu__ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d=${MENU_ICONS[name]} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>` : null);

/**
 * The rows a menu draws: falsy items left out, a divider only between two groups, a heading only over something, a
 * pair missing one side drawn alone
 */
export function menuRows(items) {
  const rows = [];
  const dropHeading = () => { if (rows.at(-1)?.heading) rows.pop(); };
  for (const it of items || []) {
    if (!it) continue;
    if (it.divider) { dropHeading(); if (rows.length && !rows.at(-1).divider) rows.push(it); continue; }
    if (it.heading) { dropHeading(); rows.push(it); continue; }
    if (it.pair) { const two = it.pair.filter(Boolean); if (two.length > 1) rows.push({ pair: two }); else if (two.length) rows.push(two[0]); continue; }
    rows.push(it);
  }
  while (rows.at(-1)?.divider || rows.at(-1)?.heading) rows.pop();
  return rows;
}

/**
 * A "⋯" menu of actions, drawn over everything (./float.js). `items`, in order: { label, run, icon (a MENU_ICONS
 * name), hint (a few words on the right), checked (true/false: an on/off choice with a switch), chosen (true/false:
 * one of a few, the chosen one ticked), danger, disabled, title, keys (aria-keyshortcuts) }, { divider: true } between
 * groups, { heading } over a group, and { pair: [a, b] } for two actions side by side (Move up | Move down). `text`
 * shows that word on the button instead of ⋯.
 * Keys: Enter, Space or ↓ opens it on its first action (↑ on its last); ↑ ↓ Home End move, ← → within a pair, a letter
 * jumps to the action it starts, Escape closes it back on its button, Tab closes it and moves on.
 */
let menuSeq = 0;
/**
 * The second click of a double-click on an action (and its press and release): swallowed where the first one landed,
 * so it never reaches whatever was under the menu it just closed
 */
function swallowNextClick(x, y) {
  const near = (ev) => Math.abs(ev.clientX - x) < 12 && Math.abs(ev.clientY - y) < 12;
  const stop = (ev) => { if (near(ev)) { ev.preventDefault(); ev.stopPropagation(); } };
  const kinds = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'];
  kinds.forEach((k) => document.addEventListener(k, stop, true));
  setTimeout(() => kinds.forEach((k) => document.removeEventListener(k, stop, true)), 500);
}

export function Menu({ label, items, text }) {
  const rows = menuRows(items);
  const ref = useRef(null);
  const id = useMemo(() => `bd-menu-${++menuSeq}`, []);
  const how = useRef('pointer'); // how it's being opened: 'pointer', 'key' (onto the first action) or 'last'
  const typed = useRef({ text: '', at: 0 });
  const listOf = (d) => d?.querySelector('.bd-menu__list');
  const buttonOf = (d) => d?.querySelector('summary');
  // Every action, the unavailable ones too (the keys reach them, and a screen reader says they're unavailable)
  const actions = (d) => [...(listOf(d)?.querySelectorAll('.bd-menu__item') || [])];
  const shut = (d, focus) => { if (!d?.open) return; d.removeAttribute('open'); if (focus) buttonOf(d)?.focus({ preventScroll: true }); };
  const unhook = (d) => { d?.unfloat?.(); d?.unaway?.(); if (d) { d.unfloat = null; d.unaway = null; } };
  // Gone while open (its item deleted from the menu itself): nothing left listening
  useEffect(() => () => unhook(ref.current), []);
  const onToggle = (e) => {
    const d = e.currentTarget;
    unhook(d);
    if (!d.open) {
      // Closed any way but a press somewhere else (its button pressed again, its button scrolled away): the focus that
      // was in the list goes back on the button, never to the page
      const a = document.activeElement;
      if (d.closedBy !== 'away' && (!a || a === document.body || listOf(d)?.contains(a))) buttonOf(d)?.focus({ preventScroll: true });
      d.closedBy = '';
      return;
    }
    d.closedBy = '';
    // Drawn over everything, toasts and sticky bars included
    d.unfloat = float(listOf(d), { anchor: buttonOf(d), align: 'end', onHide: () => d.removeAttribute('open') });
    const away = (ev) => { if (!d.contains(ev.target)) { d.closedBy = 'away'; d.removeAttribute('open'); } };
    document.addEventListener('pointerdown', away, true);
    d.unaway = () => document.removeEventListener('pointerdown', away, true);
    // From the keyboard onto an action; from a click onto the list itself, so keys work at once with nothing lit
    const els = actions(d).filter((b) => b.getAttribute('aria-disabled') !== 'true');
    ((how.current === 'last' ? els.at(-1) : how.current === 'key' ? els[0] : null) || listOf(d))?.focus({ preventScroll: true });
    how.current = 'pointer';
  };
  const onKeyDown = (e) => {
    const d = e.currentTarget;
    const onButton = e.target === buttonOf(d);
    // A held Enter or Space acts once: never opens the menu and then runs its first action
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); return; }
    if (!d.open) {
      if (!onButton) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); how.current = e.key === 'ArrowUp' ? 'last' : 'key'; d.setAttribute('open', ''); }
      else if (e.key === 'Enter' || e.key === ' ') how.current = 'key';
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); shut(d, true); return; }
    if (e.key === 'Tab') { d.closedBy = 'away'; shut(d, false); return; }
    if (onButton && (e.key === 'Enter' || e.key === ' ')) return; // the button closes it, as it opened it
    const els = actions(d);
    if (!els.length) return;
    const at = els.indexOf(document.activeElement);
    const t = typed.current;
    const typing = e.timeStamp - t.at < 700 && t.text;
    // Keys the menu uses stop here, so the page's own shortcuts (the screen's ← →) don't act on them too
    const go = (i) => { e.preventDefault(); e.stopPropagation(); els[(i + els.length) % els.length].focus(); };
    const inPair = at >= 0 && els[at].parentElement?.classList.contains('bd-menu__pair');
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home' || e.key === 'PageUp') go(0);
    else if (e.key === 'End' || e.key === 'PageDown') go(-1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const side = inPair && (e.key === 'ArrowRight' ? els[at].nextElementSibling : els[at].previousElementSibling);
      if (side) side.focus();
    } else if (e.key.length === 1 && (e.key !== ' ' || typing) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // The first letters of an action jump to it ("move d", its space too); the same letter again steps through the
      // actions it starts
      e.preventDefault();
      e.stopPropagation();
      t.text = (typing ? t.text : '') + e.key.toLowerCase();
      t.at = e.timeStamp;
      const after = [...els.slice(at + 1), ...els.slice(0, at + 1)];
      const here = at < 0 ? after : [...els.slice(at), ...els.slice(0, at)];
      const name = (b) => (b.querySelector('.bd-menu__label')?.textContent || '').trim().toLowerCase();
      let next = (t.text.length > 1 ? here : after).find((b) => name(b).startsWith(t.text))
        || (new Set(t.text).size === 1 && after.find((b) => name(b).startsWith(t.text[0])));
      // Letters that start nothing together: the last one on its own
      if (!next && t.text.length > 1 && e.key !== ' ') { t.text = e.key.toLowerCase(); next = after.find((b) => name(b).startsWith(t.text)); }
      next?.focus();
    }
  };
  // Focus goes back on ⋯ before the action runs, so one that opens a field or a question takes it from there
  const choose = (e, it) => {
    if (it.disabled) return;
    if (e.detail > 0) swallowNextClick(e.clientX, e.clientY);
    shut(e.currentTarget.closest('details'), true);
    it.run();
  };
  // Each row keyed by its place, so a re-drawn menu never hands one action's button (and its focus) to another. The
  // lit row is the focused one: the mouse moves the focus as it goes, and leaving a row takes it off (nothing lit,
  // nothing for Enter to run)
  const item = (it, key) => {
    const onOff = typeof it.checked === 'boolean';
    const oneOf = typeof it.chosen === 'boolean';
    return html`<button type="button" key=${key} role=${onOff ? 'menuitemcheckbox' : oneOf ? 'menuitemradio' : 'menuitem'} aria-checked=${onOff ? String(it.checked) : oneOf ? String(it.chosen) : null} tabindex="-1"
      class=${`bd-menu__item ${it.danger ? 'is-danger' : ''} ${it.checked ? 'is-on' : ''} ${it.chosen ? 'is-chosen' : ''} ${it.disabled ? 'is-disabled' : ''}`} aria-disabled=${it.disabled ? 'true' : null} title=${it.title || null} aria-keyshortcuts=${it.keys || null}
      onPointerMove=${(e) => { if (e.pointerType === 'mouse' && document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true }); }}
      onPointerLeave=${(e) => { if (e.pointerType === 'mouse' && document.activeElement === e.currentTarget) listOf(e.currentTarget.closest('details'))?.focus({ preventScroll: true }); }}
      onClick=${(e) => choose(e, it)}>
      ${menuIcon(it.icon)}<span class="bd-menu__label">${it.label}</span>${it.hint ? html`<small class="bd-menu__hint">${it.hint}</small>` : null}${onOff ? html`<span class="bd-menu__switch" aria-hidden="true"></span>` : null}${oneOf ? html`<span class="bd-menu__tick" aria-hidden="true">${it.chosen ? CHECK : null}</span>` : null}
    </button>`;
  };
  const row = (r, key) => (r.pair ? html`<div class="bd-menu__pair" role="group" key=${key}>${r.pair.map((x, j) => item(x, `p${j}`))}</div>` : item(r, key));
  // A heading and the rows under it (to the next divider or heading) are one group named by it
  const blocks = [];
  rows.forEach((r, i) => {
    if (r.heading) blocks.push({ heading: r.heading, i, rows: [] });
    else if (r.divider) blocks.push({ divider: true, i });
    else if (blocks.at(-1)?.heading && !blocks.at(-1).closed) blocks.at(-1).rows.push([r, i]);
    else blocks.push({ row: r, i });
    if (r.divider && blocks.at(-2)?.heading) blocks.at(-2).closed = true;
  });
  return html`<details class="bd-menu" ref=${ref} onToggle=${onToggle} onKeyDown=${onKeyDown}>
    ${text
      ? html`<summary class="btn btn-ghost btn-sm bd-menu__text" aria-haspopup="menu" title=${label}>${text}</summary>`
      : html`<summary class="bd-icon-btn" aria-haspopup="menu" aria-label=${label} title=${label}>⋯</summary>`}
    <div class="bd-menu__list" role="menu" aria-label=${label} tabindex="-1">
      ${blocks.map((b) => (b.divider ? html`<div class="bd-menu__sep" role="separator" key=${`r${b.i}`}></div>`
        : b.heading ? html`<div role="group" aria-labelledby=${`${id}-${b.i}`} key=${`r${b.i}`}><div class="bd-menu__head" id=${`${id}-${b.i}`} role="presentation">${b.heading}</div>${b.rows.map(([r, i]) => row(r, `r${i}`))}</div>`
        : row(b.row, `r${b.i}`)))}
    </div>
  </details>`;
}

// ─── Pickers: who presents, and which item a document goes with ─────

const initialsOf = (name) => { const w = String(name || '').split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '') + (w.length > 1 ? w.at(-1)[0] : '')).toUpperCase() || '?'; };
/** A person's face: their photo over their initials (the initials stay if the photo doesn't load) */
export function Face({ p, size = 24 }) {
  // The initials are drawn by CSS, so the face adds nothing to the name of the button it's in
  return html`<span class="avatar bd-face" style=${`--av:${size}px`} data-i=${initialsOf(p?.name)} aria-hidden="true">${p?.photo ? html`<img src=${p.photo} alt="" loading="lazy" decoding="async" onError=${(e) => e.currentTarget.remove()} />` : null}</span>`;
}
/** Board members, then staff, as the pickers list them: [{ slug, name, photo, meta, group }] */
export const pickable = (people) => [
  ...(people?.board || []).map((p) => ({ slug: p.slug, name: p.name, photo: p.photo, meta: [p.title && p.title !== 'Board Member' ? p.title : '', (p.committees || []).join(', ')].filter(Boolean).join(' · '), group: 'Board' })),
  ...(people?.staff || []).map((p) => ({ slug: p.slug, name: p.name, photo: p.photo, meta: p.title || 'SOARD', group: 'Staff' })),
];

/**
 * A popover beside its button: opens on a click, closes on Escape (focus back on the button), a click outside, or
 * `close()`. `children(close)` draws what's inside.
 */
function Pop({ button, label, cls = '', startOpen = false, onClosed = () => {}, children }) {
  const [open, setOpen] = useState(startOpen);
  const ref = useRef(null);
  const close = (focus = true) => { setOpen(false); onClosed(); if (focus) ref.current?.querySelector('.bd-pop__btn')?.focus(); };
  const closeNow = useRef(close);
  closeNow.current = close;
  // Drawn over everything, the agenda rows under it included (./float.js); it closes once its button scrolls out of sight
  const panelRef = useMemo(() => floatRef({ anchor: () => ref.current, align: 'end', gap: 6, onHide: () => closeNow.current(false) }), []);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) close(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', away, true);
    ref.current?.addEventListener('keydown', esc);
    const el = ref.current;
    return () => { document.removeEventListener('pointerdown', away, true); el?.removeEventListener('keydown', esc); };
  }, [open]);
  return html`<div class=${`bd-pop ${cls} ${open ? 'is-open' : ''}`} ref=${ref}>
    <button type="button" class="bd-pop__btn" aria-haspopup="dialog" aria-expanded=${open} aria-label=${label} onClick=${() => (open ? close() : setOpen(true))}>${button}</button>
    ${open ? html`<div class="bd-pop__panel" role="dialog" aria-label=${label} ref=${panelRef}>${[].concat(children).find((c) => typeof c === 'function')?.(close)}</div>` : null}
  </div>`;
}

/** Arrow keys through a list of choices, Enter takes the highlighted one: [active, onKeyDown] */
function useListKeys(count, take) {
  const [active, setActive] = useState(0);
  useEffect(() => { if (active >= count) setActive(Math.max(0, count - 1)); }, [count]);
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % Math.max(1, count)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + Math.max(1, count)) % Math.max(1, count)); }
    else if (e.key === 'Enter' && count) { e.preventDefault(); take(active); }
  };
  return [active, setActive, onKeyDown];
}
const matches = (q, ...texts) => { const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean); const hay = texts.join(' ').toLowerCase().split(/[\s,·&/()-]+/); return words.every((w) => hay.some((x) => x.startsWith(w))); };

/**
 * Who presents an item: faces and names on the agenda, and a list of the board and staff to pick from (photo,
 * name, their seat and committees), up to three, or a guest's name typed in. `value`: [{ slug?, name, photo? }].
 */
export function PersonPicker({ people, value, onChange, label = 'Who presents', empty = 'Who presents', max = 3, startOpen = false, onClosed }) {
  const chosen = new Set(value.map((p) => p.slug).filter(Boolean));
  // Two or three: first names, so they fit ("Traci & Holly")
  const names = value.length > 1 ? namesText(value.map((p) => p.name.split(/\s+/)[0])) : value[0]?.name || '';
  const shown = value.length ? html`<span class="bd-who__faces">${value.map((p) => html`<${Face} p=${p} size=${22} key=${p.slug || p.name} />`)}</span><span class="bd-who__names">${names}</span>`
    : html`<span class="bd-who__empty">+ ${empty}</span>`;
  // Its name starts with what it shows ("Traci & Holly present Events (Traci Messier and Holly Ranney)"), so a voice
  // command saying what's there finds it, and the full names follow
  const what = label.replace(/^Who presents\s*/, '');
  const named = value.length ? `${names} ${value.length > 1 ? 'present' : 'presents'} ${what}${value.length > 1 ? ` (${value.map((p) => p.name).join(' and ')})` : ''}` : label;
  return html`<${Pop} cls=${`bd-who ${value.length ? 'has-who' : ''}`} label=${named} button=${shown} startOpen=${startOpen} onClosed=${onClosed}>
    ${(close) => html`<${PeopleList} people=${people} value=${value} chosen=${chosen} max=${max} onChange=${onChange} close=${close} />`}
  </${Pop}>`;
}
/**
 * A list's search box, ready to type in the moment it opens: focused as it's put on the page (autofocus does nothing
 * for a box added after the page loads, and an effect comes a frame late, after a fast first key). Not on a phone or a
 * tablet: its keyboard would come up over the list being picked from
 */
function useFocusFirst() {
  const done = useRef(false);
  const ref = useRef((el) => { if (el && !done.current) { done.current = true; if (!matchMedia('(hover: none) and (pointer: coarse)').matches) el.focus(); } });
  return ref.current;
}
function PeopleList({ people, value, chosen, max, onChange, close }) {
  const [q, setQ] = useState('');
  const find = useFocusFirst();
  const list = people.filter((p) => !q.trim() || matches(q, p.name, p.meta));
  const typed = q.trim().replace(/\s+/g, ' ');
  const guest = typed && !people.some((p) => p.name.toLowerCase() === typed.toLowerCase()) && !value.some((p) => p.name.toLowerCase() === typed.toLowerCase());
  const options = [...list.map((p) => ({ p })), ...(guest ? [{ guest: typed }] : [])];
  // Up to `max`: one more is refused, and the list says so (never someone else dropped to make room)
  const [full, setFull] = useState(false);
  const toggle = (p) => {
    const on = chosen.has(p.slug);
    if (!on && value.length >= max) { setFull(true); return; }
    setFull(false);
    onChange(on ? value.filter((x) => x.slug !== p.slug) : [...value, p]);
    setQ('');
  };
  const take = (i) => {
    const o = options[i];
    if (!o) return;
    if (!o.guest) { toggle(o.p); return; }
    if (value.length >= max) { setFull(true); return; }
    setFull(false);
    onChange([...value, { name: o.guest }]);
    setQ('');
  };
  const [active, setActive, onKeyDown] = useListKeys(options.length, take);
  let group = '';
  return html`<div class="bd-picker">
    <input class="bd-picker__find" type="search" ref=${find} value=${q} placeholder="Find someone, or type a guest’s name" aria-label="Find someone"
      onInput=${(e) => { setQ(e.target.value); setActive(0); }} onKeyDown=${onKeyDown} />
    ${value.length ? html`<div class="bd-picker__chosen">${value.map((p) => html`<span class="bd-chip" key=${p.slug || p.name}><${Face} p=${p} size=${18} />${p.name}<button type="button" aria-label=${`Take ${p.name} off`} onClick=${() => onChange(value.filter((x) => x !== p))}>✕</button></span>`)}</div>` : null}
    <ul class="bd-picker__list" role="listbox" aria-multiselectable="true" aria-label="People">
      ${options.map((o, i) => {
        const head = o.p && o.p.group !== group ? (group = o.p.group) : '';
        return html`${head ? html`<li class="bd-picker__group" role="presentation">${head}</li>` : null}
          ${o.p ? html`<li role="option" aria-selected=${chosen.has(o.p.slug)} class=${`bd-picker__opt ${i === active ? 'is-active' : ''}`} key=${o.p.slug} onPointerEnter=${() => setActive(i)} onClick=${() => toggle(o.p)}>
            <${Face} p=${o.p} size=${30} /><span class="bd-picker__text"><span class="bd-picker__name">${o.p.name}</span>${o.p.meta ? html`<span class="bd-picker__meta">${o.p.meta}</span>` : null}</span>
            <span class="bd-picker__check" aria-hidden="true">${chosen.has(o.p.slug) ? CHECK : null}</span>
          </li>`
          : html`<li role="option" aria-selected="false" class=${`bd-picker__opt bd-picker__opt--guest ${i === active ? 'is-active' : ''}`} key="guest" onPointerEnter=${() => setActive(i)} onClick=${() => take(i)}>
            <span class="avatar bd-face" style="--av:30px" aria-hidden="true">+</span><span class="bd-picker__text"><span class="bd-picker__name">Add “${o.guest}”</span><span class="bd-picker__meta">Someone who isn’t on People, as a guest</span></span>
          </li>`}`;
      })}
      ${options.length ? null : html`<li class="bd-picker__none">Nobody by that name</li>`}
    </ul>
    <div class="bd-picker__foot"><span class=${`bd-muted ${full ? 'is-full' : ''}`} role=${full ? 'alert' : null}>${full ? `Up to ${max}: take someone off first` : value.length ? `${value.length} of up to ${max}` : `Up to ${max}`}</span>
      <span class="bd-actions">${value.length ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => onChange([])}>Clear</button>` : null}<button type="button" class="btn btn-primary btn-sm" onClick=${() => close()}>Done</button></span></div>
  </div>`;
}

/** What each live list draws from, under its name in the Shows list */
const SHOW_FROM = { projects: 'The makeovers board, from JobTread', reveals: 'Reveals ahead, from JobTread', events: 'Events ahead, from the website', cash: 'The bank, the budget and QuickBooks, beside last year', meetings: 'This year’s board meetings' };
/**
 * What an item shows live, in order: the lists as chips (the button), and a checklist to add or take off each one.
 * Order is the order they're picked in: the first on the item's own card on the screen, each next a slide of its own.
 * `value`: ['projects', 'reveals', …]
 */
export function ShowsPicker({ value, onChange, label, startOpen = false, onClosed }) {
  const button = value.length
    ? html`<span class="bd-shows">${value.map((k) => html`<span class=${`agx-live is-${k}`} key=${k}><span class="agx-live__dot" aria-hidden="true"></span>${LIVE_TITLES[k]}</span>`)}</span>`
    : html`<span class="bd-who__empty">+ Show live numbers</span>`;
  const named = value.length ? `Shows ${value.map((k) => LIVE_TITLES[k]).join(', ')}: ${label}` : label;
  const toggle = (k) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  // One earlier (−1) or later (+1) in the order the screen shows them
  const move = (k, d) => {
    const i = value.indexOf(k);
    if (i < 0 || i + d < 0 || i + d >= value.length) return;
    const next = [...value];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  // The list has the focus as it opens (from its button or the ⋯ menu): on the first one shown, else the first
  const focusList = (el) => {
    if (!el || el.dataset.focused) return;
    el.dataset.focused = '1';
    (el.querySelector('[aria-selected="true"]') || el.querySelector('[role="option"]'))?.focus({ preventScroll: true });
  };
  // ↑ ↓ (Home, End) along the list, Enter or the space bar picks, Alt with ↑ ↓ moves a picked one in the order
  const keys = (e, k) => {
    const opts = [...e.currentTarget.parentElement.querySelectorAll('[role="option"]')];
    const i = opts.indexOf(e.currentTarget);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(k); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(k, e.key === 'ArrowUp' ? -1 : 1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]?.focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); opts[e.key === 'Home' ? 0 : opts.length - 1]?.focus(); }
  };
  return html`<${Pop} cls=${`bd-showpick ${value.length ? 'has-who' : ''}`} label=${named} button=${button} startOpen=${startOpen} onClosed=${onClosed}>
    ${(close) => html`<div class="bd-picker">
      <p class="bd-picker__lead">Live from JobTread, QuickBooks and the website, under the item on the board page, and on the screen in this order</p>
      <ul class="bd-picker__list" role="listbox" aria-multiselectable="true" aria-label="Live lists" ref=${focusList}>
        ${SHOW_KINDS.map((k) => {
          const at = value.indexOf(k);
          return html`<li role="option" aria-selected=${at >= 0} class="bd-picker__opt" key=${k} tabindex="0" onClick=${() => toggle(k)} onKeyDown=${(e) => keys(e, k)}>
            <span class=${`bd-showpick__n ${at >= 0 ? 'is-on' : ''}`} aria-hidden="true">${at >= 0 ? at + 1 : ''}</span>
            <span class="bd-picker__text"><span class="bd-picker__name">${LIVE_TITLES[k]}</span><span class="bd-picker__meta">${SHOW_FROM[k]}</span></span>
            <span class="bd-picker__check" aria-hidden="true">${at >= 0 ? CHECK : null}</span>
          </li>`;
        })}
      </ul>
      ${value.length > 1 ? html`<div class="bd-showorder">
        <p class="bd-showorder__h">The order on the screen</p>
        <ol>${value.map((k, i) => html`<li key=${k}>
          <span class="bd-showpick__n is-on" aria-hidden="true">${i + 1}</span>
          <span class="bd-showorder__t">${LIVE_TITLES[k]}<small>${i ? 'a slide of its own' : 'on the item’s slide'}</small></span>
          ${i ? html`<button type="button" class="bd-icon-btn bd-showorder__up" aria-label=${`Show ${LIVE_TITLES[k]} before ${LIVE_TITLES[value[i - 1]]}`} title="Earlier" onClick=${() => move(k, -1)}>${menuIcon('up')}</button>` : null}
        </li>`)}</ol>
      </div>` : null}
      <div class="bd-picker__foot"><span class="bd-muted">${value.length ? `${value.length} shown` : 'None shown'}</span>
        <span class="bd-actions">${value.length ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => onChange([])}>Clear</button>` : null}<button type="button" class="btn btn-primary btn-sm" onClick=${() => close()}>Done</button></span></div>
    </div>`}
  </${Pop}>`;
}

/**
 * Which agenda item a document goes with: the agenda, numbered as it reads, to pick from (or none).
 * `items`: agendaItems(m); `value`: an item id or ''.
 */
export function ItemChooser({ items, value, onChange, label = 'Goes with' }) {
  const at = items.find((it) => it.id === value);
  // Named by what it shows first ("3.2 Financial: which agenda item…")
  const named = `${at ? `${at.label} ${at.title}` : 'Not on an item'}: ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  return html`<${Pop} cls="bd-goes" label=${named} button=${html`<span class=${`bd-goes__now ${at ? '' : 'is-none'}`}>${at ? html`<b>${at.label}</b> ${at.title}` : 'Not on an item'}</span><svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>`}>
    ${(close) => html`<${ItemList} items=${items} value=${value} onPick=${(id) => { onChange(id); close(); }} />`}
  </${Pop}>`;
}
function ItemList({ items, value, onPick }) {
  const [q, setQ] = useState('');
  const find = useFocusFirst();
  // "Not on an item" first, where it's found without scrolling past the whole agenda
  const list = [...(q.trim() ? [] : [{ id: '', title: 'Not on an item', label: '' }]), ...items.filter((it) => !q.trim() || matches(q, it.title, it.section, it.label))];
  const [active, setActive, onKeyDown] = useListKeys(list.length, (i) => list[i] && onPick(list[i].id));
  let sec = null;
  return html`<div class="bd-picker">
    <input class="bd-picker__find" type="search" ref=${find} value=${q} placeholder="Find an agenda item" aria-label="Find an agenda item" onInput=${(e) => { setQ(e.target.value); setActive(0); }} onKeyDown=${onKeyDown} />
    <ul class="bd-picker__list" role="listbox" aria-label="Agenda items">
      ${list.map((it, i) => {
        const head = it.id && it.section !== sec ? (sec = it.section) || 'Agenda' : '';
        return html`${head ? html`<li class="bd-picker__group" role="presentation">${head}</li>` : null}
          <li role="option" aria-selected=${it.id === value} class=${`bd-picker__opt bd-picker__opt--item ${i === active ? 'is-active' : ''} ${it.id ? '' : 'is-none'}`} key=${it.id || 'none'} onPointerEnter=${() => setActive(i)} onClick=${() => onPick(it.id)}>
            ${it.label ? html`<span class="bd-picker__num">${it.label}</span>` : null}<span class="bd-picker__text"><span class="bd-picker__name">${it.title}</span></span>
            <span class="bd-picker__check" aria-hidden="true">${it.id === value ? CHECK : null}</span>
          </li>`;
      })}
    </ul>
  </div>`;
}

/** A document on an agenda item: its name (opening it), and ✕ to take it off the item */
export function DocChip({ f, link, onRemove, note = '' }) {
  const fmt = /pdf/i.test(f.type) || /\.pdf$/i.test(f.name) ? 'PDF' : /sheet|excel/i.test(f.type) || /\.xlsx?$/i.test(f.name) ? 'XLS' : /word/i.test(f.type) || /\.docx?$/i.test(f.name) ? 'DOC' : /presentation/i.test(f.type) || /\.pptx?$/i.test(f.name) ? 'PPT' : /^image\//.test(f.type) ? 'IMG' : 'FILE';
  return html`<span class="bd-doc"><a class="bd-doc__a" ...${link}><span class="bd-doc__fmt" data-fmt=${fmt}>${fmt}</span><span class="bd-doc__name">${docTitle(f.name)}</span>${note ? html`<span class="bd-doc__note">${note}</span>` : null}</a>${onRemove ? html`<button type="button" class="bd-doc__x" aria-label=${`Take ${fileTitle(f.name)} off this item`} title="Take it off this item" onClick=${onRemove}>✕</button>` : null}</span>`;
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
  /* Board → Members: Board access, a line each (the dot hangs left of the title, so the text lines up under it) */
  .bd-access__t { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; }
  .bd-access__t .tag { white-space: nowrap; }
  .bd-access .bd-row__meta, .bd-access__fix, .bd-access__after { padding-left: calc(8px + 0.6rem); }
  .bd-access__after { flex: 1 1 100%; }
  /* The line takes focus when its button goes away: an inset ring, since the card clips anything outside */
  li.bd-access[tabindex]:focus-visible { box-shadow: inset 0 0 0 2px var(--color-primary); border-radius: 0; }
  .bd-next { margin-top: 0.2rem; font-size: var(--fs-sm); font-weight: 600; color: var(--tone-info-fg); }
  .bd-tags { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
  .bd-year { padding: 0.55rem 1.25rem; background: var(--color-bg-subtle, #F7F7F5); border-bottom: 1px solid var(--color-border); font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); }
  .bd-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .bd-inline { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .bd-inline .form-input { width: auto; }
  .bd-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: var(--fs-sm); cursor: pointer; }
  .bd-check input { width: 16px; height: 16px; margin: 0; }
  .bd-signers { flex: 1 1 100%; min-width: 0; margin-top: 0.25rem; border-top: 1px solid var(--color-border); }
  .bd-signers__list { list-style: none; margin: 0; padding: 0; }
  .bd-signer { display: grid; grid-template-columns: 0.5rem minmax(8rem, 13rem) minmax(0, 1fr) auto; align-items: center; gap: 0.25rem 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid var(--color-border); font-size: var(--fs-sm); }
  .bd-signer:last-child { border-bottom: none; }
  .bd-signer__dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--color-border-strong); }
  .bd-signer__dot.is-on { background: var(--tone-success-dot, var(--tone-success-fg)); }
  .bd-signer__name { font-weight: 600; color: var(--color-text); }
  .bd-signer__how { color: var(--color-text-secondary); overflow-wrap: anywhere; }
  .bd-signer__how a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
  @media (max-width: 640px) { .bd-signer { grid-template-columns: 0.5rem minmax(0, 1fr); } .bd-signer__how, .bd-signer__act { grid-column: 2; } }
  .bd-select { width: auto; max-width: 15rem; }
  .bd-words { min-width: 0; }
  .bd-words__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.35rem 0.75rem; margin-bottom: 0.4rem; }
  .bd-words__head .form-label { margin: 0; }
  .bd-wordings { margin-top: 0.6rem; }
  .bd-wordings__list { list-style: none; margin: 0.5rem 0 0; padding: 0; border-top: 1px solid var(--color-border); }
  .bd-wordings__list > li { padding: 0.5rem 0; border-bottom: 1px solid var(--color-border); font-size: var(--fs-sm); }
  .bd-wordings__row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.35rem 0.75rem; }
  .bd-wordings__words { margin-top: 0.5rem; padding: 0.75rem 1rem; border-radius: 8px; background: var(--color-bg-subtle, #F7F7F5); max-height: 22rem; overflow: auto; }
  .bd-back { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--color-text-secondary); font-size: var(--fs-sm); text-decoration: none; margin-bottom: 0.25rem; }
  .bd-back:hover { color: var(--color-text); }
  .bd-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.85rem 1rem; }
  .bd-grid3 .span-3 { grid-column: 1 / -1; }
  @media (max-width: 900px) { .bd-grid3 { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 600px) { .bd-grid3 { grid-template-columns: 1fr; } .bd-grid3 .span-3 { grid-column: 1; } }
  .bd-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: var(--seg-bg); padding: 0.05rem 0.35rem; border-radius: 5px; overflow-wrap: anywhere; }
  .bd-icon-btn { border: none; background: none; width: 34px; height: 34px; border-radius: 8px; color: var(--color-text-muted); cursor: pointer; display: inline-grid; place-items: center; font-size: 17px; line-height: 1; list-style: none; }
  .bd-icon-btn::-webkit-details-marker { display: none; }
  @media (hover: hover) { .bd-icon-btn:hover:not(:disabled) { background: var(--seg-bg); color: var(--color-text); } }
  .bd-menu[open] > .bd-icon-btn { background: var(--seg-bg); color: var(--color-text); }
  @media (pointer: coarse) { .bd-icon-btn { width: 44px; height: 44px; } }
  .bd-icon-btn:disabled { opacity: 0.35; cursor: default; }
  .bd-drop { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; padding: 0.9rem 1rem; border: 1px dashed var(--color-border-strong); border-radius: var(--radius-md); }
  .bd-drop.is-over { background: var(--tone-info-surface); border-color: var(--tone-info-line-strong); }
  .bd-live { margin: 0.5rem 0 0; padding: 0.55rem 0.75rem; border-radius: var(--radius-md); background: var(--tone-info-surface); border: 1px solid var(--tone-info-line); font-size: var(--fs-sm); line-height: 1.5; }
  .bd-live ul { margin: 0.25rem 0 0 1.1rem; padding: 0; }
  .bd-live__label { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.04em; color: var(--tone-info-fg); }

  /* ⋯ menus: actions in groups, an icon on each, a switch on the on/off ones */
  .bd-menu { position: relative; display: inline-block; }
  .bd-menu > summary { list-style: none; -webkit-user-select: none; user-select: none; }
  .bd-menu > summary::-webkit-details-marker { display: none; }
  .bd-menu__list { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; box-sizing: border-box; -webkit-user-select: none; user-select: none; overflow-x: hidden; width: max-content; min-width: 15.5rem; max-width: min(22rem, calc(100vw - 16px)); max-height: min(34rem, calc(100vh - 16px)); overflow-y: auto; overscroll-behavior: contain; padding: 0.3rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); color: var(--color-text); box-shadow: var(--shadow-lg); outline: none; transform-origin: top right; }
  .bd-menu .bd-menu__list:focus-visible { box-shadow: var(--shadow-lg); }
  .bd-menu__list[data-side="top"] { transform-origin: bottom right; }
  .bd-menu[open] .bd-menu__list { animation: bd-menu-in 0.14s var(--ease-out); }
  @keyframes bd-menu-in { from { opacity: 0; transform: translateY(-3px) scale(0.97); } }
  .bd-menu__list[data-side="top"] { animation-name: bd-menu-up; }
  @keyframes bd-menu-up { from { opacity: 0; transform: translateY(3px) scale(0.97); } }
  .bd-menu:not([open]) .bd-menu__list { display: none; }
  .bd-menu__item { display: flex; align-items: center; gap: 0.6rem; width: 100%; min-height: 2.25rem; padding: 0.4rem 0.6rem; border: none; border-radius: var(--radius-sm); background: none; font: inherit; font-size: var(--fs-sm); font-weight: 500; line-height: 1.3; color: var(--color-text); text-align: left; cursor: pointer; }
  /* The lit row is the focused one (the mouse moves the focus as it goes), so there's only ever one */
  .bd-menu__item:focus { outline: none; box-shadow: none; background: var(--seg-bg); }
  /* From the keyboard, a ring inside the row as well (the admin's own ring would spill over its neighbours) */
  .bd-menu .bd-menu__list .bd-menu__item:focus-visible { box-shadow: inset 0 0 0 2px var(--color-text); }
  .bd-menu__item.is-disabled { opacity: 0.4; cursor: default; }
  .bd-menu__item.is-disabled:focus:not(:focus-visible) { background: none; }
  .bd-menu__ico { flex: none; color: var(--color-text-muted); }
  .bd-menu__item:focus .bd-menu__ico { color: var(--color-text); }
  .bd-menu__label { flex: 1 1 auto; min-width: 6.5em; }
  /* A hint gives way first: it wraps under itself, never over the action's name */
  .bd-menu__hint { flex: 0 1 auto; min-width: 0; margin-left: 0.75rem; font-size: var(--fs-xs); font-weight: 400; line-height: 1.25; text-align: right; color: var(--color-text-muted); }
  .bd-menu__switch { position: relative; flex: none; width: 28px; height: 16px; margin-left: 0.5rem; border-radius: 8px; background: var(--switch-off); transition: background 0.18s; }
  .bd-menu__switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(26,27,31,0.25); transition: transform 0.18s var(--ease-out); }
  .bd-menu__item.is-on .bd-menu__switch { background: var(--switch-on); }
  .bd-menu__item.is-on .bd-menu__switch::after { transform: translateX(12px); }
  .bd-menu__item.is-danger, .bd-menu__item.is-danger .bd-menu__ico { color: var(--tone-danger-fg); }
  .bd-menu__item.is-danger:focus { background: var(--tone-danger-bg); }
  .bd-menu__tick { flex: none; display: grid; place-items: center; width: 16px; height: 16px; margin-left: 0.5rem; color: var(--color-text); }
  .bd-menu__item.is-chosen { font-weight: 600; }
  .bd-menu__sep { height: 1px; margin: 0.3rem 0.45rem; background: var(--color-border); }
  .bd-menu__head { padding: 0.45rem 0.6rem 0.2rem; font-size: var(--fs-2xs); font-weight: 600; letter-spacing: 0.02em; color: var(--color-text-muted); }
  .bd-menu__pair { display: grid; grid-template-columns: repeat(2, minmax(max-content, 1fr)); gap: 0.15rem; }
  .bd-menu__pair .bd-menu__item { white-space: nowrap; }
  @media (pointer: coarse) { .bd-menu__item { min-height: 2.75rem; } }
  @media (prefers-reduced-motion: reduce) { .bd-menu[open] .bd-menu__list { animation: none; } .bd-menu__switch, .bd-menu__switch::after { transition: none; } }

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
  .bm-facts { margin: 0.4rem 0 0 -1.1rem; display: flex; flex-wrap: wrap; align-items: baseline; row-gap: 0.25rem; clip-path: inset(-0.6rem -0.6rem -0.6rem 1.1rem); font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .bm-facts > * { position: relative; margin-left: 1.1rem; }
  .bm-facts > *::before { content: '·'; position: absolute; left: -0.72rem; color: var(--color-text-muted); text-decoration: none; }
  .bm-link { border: none; background: none; padding: 0; font: inherit; color: var(--tone-info-fg); font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
  .bm-link:hover { color: var(--color-text); }
  .bm-saved { font-size: var(--fs-sm); color: var(--color-text-secondary); display: inline-flex; align-items: center; gap: 0.4rem; white-space: nowrap; }
  .bm-saved.is-error { color: var(--tone-warn-fg); }
  .bm-top__bar .bd-actions { flex-wrap: wrap; justify-content: flex-end; min-width: 0; }
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
  .bm-main, .bm-aside { display: grid; gap: 1rem; min-width: 0; align-content: start; }
  .bm-main { grid-column: 1; grid-row: 1; }
  .bm-aside { grid-column: 2; grid-row: 1; }
  .bm-slot { display: grid; min-width: 0; }
  .bm-slot:empty { display: none; }
  .bm-main > .card, .bm-aside > .card, .bm-slot > .card, .bm-slot > label { margin: 0; }
  /* During: the check-ins stay beside the agenda, and the live card above it as it scrolls */
  .bm-layout.is-during .bm-aside { position: sticky; top: 1rem; }
  .bm-slot--run:has(> .bm-run.is-live) { position: sticky; top: 0.75rem; z-index: 15; }
  /* the page's own colour above it, so the agenda never shows over its top edge */
  .bm-slot--run:has(> .bm-run.is-live)::before { content: ''; position: absolute; left: -0.5rem; right: -0.5rem; bottom: 100%; height: 0.75rem; background: var(--color-bg); }
  @media (max-width: 1180px) { .bm-layout { grid-template-columns: minmax(0, 1fr); } .bm-main, .bm-aside { display: contents; } .bm-slot { order: var(--o, 0); } .bm-slot--run:has(> .bm-run.is-live) { position: static; } }

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

  /* The agenda editor (board-meeting.js AgendaEditor): the run of show, then the parts as chapters, each item a card */
  .agx-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.5rem 1rem; }
  .agx-head .bd-card-head { margin-bottom: 0.9rem; max-width: 40rem; }
  .agx-run { display: flex; gap: 3px; height: 42px; margin: 0 0 0.45rem; border-radius: 12px; overflow: hidden; }
  .agx-run__part { position: relative; min-width: 34px; display: flex; align-items: center; justify-content: space-between; gap: 0.3rem; padding: 0 0.55rem; background: #ECEAE3; color: var(--color-text); text-decoration: none; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; transition: background 0.2s, flex-grow 0.5s cubic-bezier(0.22,1,0.36,1); overflow: hidden; white-space: nowrap; }
  .agx-run__part:nth-child(even) { background: #E2DFD6; }
  .agx-run__part b { font-weight: 800; }
  .agx-run__part span { color: var(--color-text-secondary); font-weight: 650; }
  .agx-run__part.is-own { box-shadow: inset 0 -3px 0 var(--color-text); }
  .agx-run__part:hover, .agx-run__part:focus-visible { background: var(--color-primary); }
  .agx-run__part:hover span, .agx-run__part:focus-visible span { color: #1F201C; }
  .agx-runmeta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.25rem 1rem; margin: 0 0 1.1rem; font-size: var(--fs-xs); color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
  .agx-runmeta .is-over { color: var(--tone-warn-fg); font-weight: 700; }
  .agx-secs { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.1rem; }
  /* One part's wide content wraps in it, never widening every part past the card */
  .agx-sec, .agx-item { min-width: 0; }
  .agx-sec { position: relative; padding: 0.85rem 0.85rem 0.6rem; border-radius: 16px; background: #FAF9F6; border: 1px solid var(--color-border); scroll-margin: calc(var(--top-h, 0px) + 6rem); transition: box-shadow 0.25s, opacity 0.25s; }
  .agx-sec__head { gap: 0.45rem; }
  .agx-sec__n { flex: none; min-width: 2.2rem; font-size: 1.55rem; font-weight: 800; letter-spacing: -0.04em; line-height: 1; font-variant-numeric: tabular-nums; color: var(--color-text); }
  /* A part's name wraps, as an item's does, never cut off beside the presentation or on a phone */
  .agx-sec__title.ag-input { display: block; height: auto; min-height: 40px; padding-block: 0.4rem; line-height: 1.25; font-size: var(--fs-lg, 1.15rem); font-weight: 750; letter-spacing: -0.01em; resize: none; overflow: hidden; field-sizing: content; }
  .agx-items.ag-items { padding: 0; margin: 0.65rem 0 0; display: grid; gap: 0.45rem; }
  .agx-item { position: relative; padding: 0.45rem 0.55rem 0.5rem 0.35rem; border-radius: 12px; background: var(--color-bg-card); border: 1px solid var(--color-border); box-shadow: 0 1px 2px rgba(26,27,31,0.04); transition: box-shadow 0.25s, border-color 0.2s, opacity 0.25s, translate 0.35s cubic-bezier(0.22,1,0.36,1); }
  @starting-style { .agx-item { opacity: 0; translate: 0 6px; } }
  .agx-item:hover { border-color: var(--color-border-strong); box-shadow: 0 6px 18px -10px rgba(26,27,31,0.25); }
  .agx-item:focus-within { border-color: var(--color-text); box-shadow: 0 0 0 3px rgba(26,27,31,0.06); }
  .agx-item.has-live { border-left: 3px solid var(--color-primary); padding-left: calc(0.35rem - 2px); }
  .agx-item__row { gap: 0.3rem; }
  .agx-item__n { flex: none; display: inline-grid; place-items: center; min-width: 2.2rem; height: 1.55rem; padding: 0 0.35rem; border-radius: 999px; background: var(--seg-bg, rgba(0,0,0,0.05)); font-size: var(--fs-2xs); font-weight: 750; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
  .agx-item__title.ag-input { display: block; height: auto; min-height: 36px; padding: 0.42rem 0.5rem; line-height: 1.35; font-weight: 600; resize: none; overflow: hidden; field-sizing: content; }
  .agx-item__row { align-items: flex-start; }
  .agx-item__row > .agx-grip, .agx-item__row > .bd-who, .agx-item__row > details { margin-top: 2px; }
  .agx-item__row > .agx-item__n { margin-top: 5px; }
  /* The report: read in place (Edit to write), or written in place */
  .agx-report { margin: 0.45rem 0 0.25rem 2.95rem; }
  .agx-report:not(.is-writing) { padding: 0.7rem 0.9rem 0.8rem; border-radius: 10px; background: #FAF9F6; border: 1px solid var(--color-border); }
  .agx-report__head { display: flex; align-items: center; gap: 0.6rem; margin: -0.25rem -0.3rem 0.35rem 0; }
  .agx-report__label { font-size: var(--fs-2xs); font-weight: 750; letter-spacing: 0.07em; text-transform: uppercase; color: var(--color-text-secondary); }
  .agx-report__by { flex: 1; min-width: 0; font-size: var(--fs-xs); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agx-report .rp { font-size: var(--fs-sm); }
  .agx-report .rp-more { font-size: var(--fs-xs); }
  .agx-grip { flex: none; display: grid; place-items: center; width: 22px; height: 32px; border: none; background: none; border-radius: 6px; color: var(--color-text-muted); cursor: grab; opacity: 0.45; transition: opacity 0.15s, background 0.15s; }
  .agx-grip svg { fill: currentColor; }
  .agx-item:hover .agx-grip, .agx-sec__head:hover .agx-grip, .agx-grip:focus-visible { opacity: 1; }
  .agx-grip:hover { background: var(--seg-bg, rgba(0,0,0,0.05)); color: var(--color-text); }
  .agx-grip:active { cursor: grabbing; }
  .agx-tags.ag-tags { margin: 0.3rem 0 0.15rem 2.95rem; }
  .agx-live { display: inline-flex; align-items: center; gap: 0.4rem; height: 24px; padding: 0 0.6rem 0 0.5rem; border-radius: 999px; background: var(--color-primary-bg); border: 1px solid rgba(245,204,0,0.45); font-size: var(--fs-2xs); font-weight: 700; color: var(--color-text); }
  .agx-live__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-primary); box-shadow: 0 0 0 2px rgba(255,213,0,0.25); }
  .agx-live.is-minutes { background: var(--tone-success-surface); border-color: var(--tone-success-line); }
  .agx-live.is-minutes .agx-live__dot { background: var(--tone-success-dot); box-shadow: none; }
  .agx-docs.ag-docs { margin-left: 2.95rem; }
  .agx-item > .bd-notes, .agx-item > .bd-private-label { margin-left: 2.95rem; width: calc(100% - 2.95rem); }
  .agx-dropnote { position: absolute; inset: auto 0.6rem 0.4rem auto; margin: 0; font-size: var(--fs-2xs); font-weight: 700; color: var(--tone-info-fg); pointer-events: none; }
  .agx-end { min-height: 34px; border-radius: 10px; }
  .agx-add.ag-add { margin-left: 0.15rem; }
  .agx-addsec.ag-add { margin: 0.9rem 0 0; }
  /* Dragging: the one moving fades, a bar shows where it would land */
  .agx-item.is-dragging, .agx-sec.is-dragging { opacity: 0.4; }
  .agx-item.drop-before::before, .agx-item.drop-after::after, .agx-end.drop-before::before, .agx-sec.drop-before::before, .agx-sec.drop-after::after { content: ''; position: absolute; left: 0.4rem; right: 0.4rem; height: 3px; border-radius: 3px; background: var(--color-text); pointer-events: none; }
  .agx-item.drop-before::before, .agx-sec.drop-before::before { top: -5px; }
  .agx-item.drop-after::after, .agx-sec.drop-after::after { bottom: -5px; }
  .agx-end { position: relative; }
  .agx-end.drop-before::before { top: 2px; }
  ::view-transition-group(*) { animation-duration: 0.38s; animation-timing-function: cubic-bezier(0.22,1,0.36,1); }
  @media (max-width: 640px) {
    .agx-sec { padding: 0.7rem 0.6rem 0.5rem; }
    .agx-tags.ag-tags, .agx-docs.ag-docs, .agx-item > .bd-notes, .agx-item > .bd-private-label, .agx-report { margin-left: 0.4rem; width: auto; }
    .agx-item__row { flex-wrap: wrap; }
    .agx-item__row > .agx-item__title { flex: 1 1 9rem; }
    .agx-run__part span { display: none; }
    .agx-sec__head { flex-wrap: wrap; }
    .agx-sec__head > .agx-sec__title { flex: 1 1 10rem; }
  }
  @media (prefers-reduced-motion: reduce) { .agx-item, .agx-run__part { transition: none; } }

  /* Where the meeting stands: the line under its name (board-meeting.js pathOf), done, next, or to come. It stays at
     the top as the page scrolls (under the top bar on a tablet or phone), on a band of the page's own color; whatever
     sticks or is scrolled to below it clears its height (--bm-path-h, set by board-meeting.js, which also brings what
     the keyboard focuses out from under it) */
  :root:has(.bd > .bm-path) { --bm-stick: 0px; }
  @media (max-width: 1024px) { :root:has(.bd > .bm-path) { --bm-stick: var(--top-h, 0px); } }
  .bm-path { position: sticky; top: var(--bm-stick); z-index: 12; min-width: 0; margin: -0.75rem -0.5rem -0.5rem; padding: 0.5rem; background: var(--color-bg); container-type: inline-size; container-type: inline-size scroll-state; }
  .bm-path ol { transition: box-shadow 0.2s; }
  @container scroll-state(stuck: top) { .bm-path ol { box-shadow: 0 10px 24px -14px rgba(26,27,31,0.4); } }
  .bd:has(> .bm-path) :is(#bm-work, #bm-ready, #bm-minutes, #bm-after, #bm-where) { scroll-margin-top: calc(var(--bm-stick) + var(--bm-path-h, 5rem) + 0.75rem); }
  @media (min-width: 1281px) { .bd:has(> .bm-path) .agx-stage { top: calc(var(--bm-stick) + var(--bm-path-h, 5rem) + 0.5rem); max-height: calc(100vh - var(--bm-stick) - var(--bm-path-h, 5rem) - 1.5rem); } }
  .bm-path ol { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); overflow: hidden; }
  .bm-path__step { position: relative; min-width: 0; border-left: 1px solid var(--color-border); }
  .bm-path__step:first-child { border-left: none; }
  .bm-path__btn { display: flex; align-items: flex-start; gap: 0.6rem; width: 100%; height: 100%; padding: 0.7rem 0.8rem; border: none; background: none; font: inherit; text-align: left; color: var(--color-text); cursor: pointer; }
  button.bm-path__btn:hover { background: var(--color-bg-hover); }
  span.bm-path__btn { cursor: default; }
  .bm-path__btn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--color-text); }
  .bm-path__dot { flex: none; display: grid; place-items: center; width: 22px; height: 22px; margin-top: 1px; border-radius: 50%; border: 2px solid var(--color-border-strong); background: var(--color-bg-card); }
  .bm-path__dot svg { width: 13px; height: 13px; }
  .bm-path__step.is-done .bm-path__dot { border-color: var(--tone-success-fg); background: var(--tone-success-fg); color: #fff; }
  .bm-path__step.is-next .bm-path__dot { border-color: var(--color-text); background: var(--color-primary); }
  .bm-path__step.is-next { box-shadow: inset 0 -3px 0 var(--color-text); background: var(--color-bg-subtle, #F7F7F5); }
  .bm-path__words { display: grid; min-width: 0; }
  .bm-path__t { font-size: var(--fs-sm); font-weight: 650; line-height: 1.3; }
  .bm-path__s { font-size: var(--fs-xs); color: var(--color-text-secondary); line-height: 1.35; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .bm-path__step.is-todo .bm-path__t { color: var(--color-text-secondary); }
  /* Too narrow for all six names on one line each (a phone, a tablet, a narrow window, or a laptop's larger touch
     text beside the menu): still one row, since it stays at the top, scrolling sideways to the rest */
  @container (max-width: 63.5rem) {
    .bm-path ol { display: flex; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
    .bm-path ol::-webkit-scrollbar { display: none; }
    .bm-path__step { flex: 1 0 10.5rem; }
    .bm-path__t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (hover: hover) { .bm-path ol { scroll-padding-inline: 2.25rem; } }
  }
  .bm-path__more { position: absolute; top: 0.5rem; bottom: 0.5rem; z-index: 1; display: none; place-items: center; width: 2.25rem; padding: 0 0 2px; border: 1px solid var(--color-border); background: var(--color-bg-card); font: inherit; font-size: 22px; line-height: 1; color: var(--color-text); cursor: pointer; }
  .bm-path__more.is-back { left: 0.5rem; border-radius: var(--radius-md) 0 0 var(--radius-md); }
  .bm-path__more.is-on { right: 0.5rem; border-radius: 0 var(--radius-md) var(--radius-md) 0; }
  .bm-path__more:hover { background: var(--color-bg-hover); }
  @media (hover: hover) { .bm-path__more { display: grid; } }
  /* A short window (a phone on its side): the names only, so the line takes less of it */
  @media (max-height: 500px) { .bm-path__s { display: none; } }
  /* A card the line or a slide sent you to, lit a moment */
  .bm-row__main.is-found > .card:first-child, .bm-row__side.is-found > .card:first-child, .bm-row.is-found .card, .bm-work.is-found > .agx, .agx-item.is-found { animation: bm-found 1.4s var(--ease-out); }
  @keyframes bm-found { 0%, 35% { box-shadow: 0 0 0 3px var(--color-primary); } 100% { box-shadow: 0 0 0 3px transparent; } }

  /* The page: the agenda beside its presentation, then the rows of cards */
  .bm-work { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.08fr); gap: 1rem; align-items: start; margin-top: 1rem; }
  .bm-work > .agx { margin: 0; min-width: 0; }
  .bm-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(19rem, 23rem); gap: 1rem; align-items: start; margin-top: 1rem; }
  .bm-row__main, .bm-row__side { display: grid; gap: 1rem; min-width: 0; align-content: start; }
  .bm-row .card { margin: 0; }
  .bm-row + .card, .bm-work + .card { margin-top: 1rem; }
  @media (max-width: 1180px) { .bm-row { grid-template-columns: minmax(0, 1fr); } }

  /* The presentation beside the agenda (board-meeting.js AgendaStage): the slide, its steps, every slide in order */
  .agx-stage { position: sticky; top: calc(var(--top-h, 0px) + 1rem); display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; max-height: calc(100vh - var(--top-h, 0px) - 2rem); padding: 0.85rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
  .agx-stage__bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; }
  .agx-stage__note { font-size: var(--fs-xs); color: var(--color-text-secondary); }
  .agx-stage .bd-seg { display: inline-flex; padding: 3px; border-radius: 999px; background: var(--seg-bg, rgba(0,0,0,0.05)); }
  .agx-stage .bd-seg button { height: 30px; padding: 0 0.85rem; border: none; border-radius: 999px; background: none; font: inherit; font-size: var(--fs-xs); font-weight: 650; color: var(--color-text-secondary); cursor: pointer; }
  .agx-stage .bd-seg button.is-on { background: var(--color-bg-card); color: var(--color-text); box-shadow: 0 1px 3px rgba(26,27,31,0.14); }
  .agx-stage .bd-seg button:focus-visible { outline: 2px solid var(--color-text); outline-offset: 1px; }
  .agx-stage__frame { position: relative; flex: none; overflow: hidden; border: 1px solid var(--color-border); border-radius: 10px; background: #FEFCF5; }
  .agx-stage__frame iframe { display: block; border: 0; transform-origin: 0 0; background: #FEFCF5; }
  .agx-stage__frame.is-phone { display: flex; justify-content: center; padding: 13px 0; background: var(--color-bg-subtle, #F3F2EE); }
  .agx-stage__frame.is-phone iframe { transform-origin: 50% 0; border-radius: 26px; box-shadow: 0 0 0 7px #1F201C, 0 18px 40px -16px rgba(0,0,0,0.45); }
  .agx-stage__frame.is-screen { background: #1C1D1A; border-color: #1C1D1A; }
  .agx-stage__nav { display: flex; align-items: center; gap: 0.35rem; min-width: 0; }
  .agx-stage__step { font-size: 22px; line-height: 1; }
  .agx-stage__count { flex: none; min-width: 4.6em; text-align: center; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; color: var(--color-text-secondary); }
  .agx-stage__count b { color: var(--color-text); }
  .agx-stage__now { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 0.45rem; margin-left: 0.4rem; font-size: var(--fs-sm); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agx-stage__now > span { overflow: hidden; text-overflow: ellipsis; }
  .agx-stage__now b, .agx-slide__t b { flex: none; display: inline-grid; place-items: center; min-width: 2rem; height: 1.35rem; padding: 0 0.35rem; border-radius: 999px; background: var(--seg-bg); font-size: var(--fs-2xs); font-weight: 700; font-variant-numeric: tabular-nums; }
  .agx-stage__play { flex: none; margin-left: auto; }
  .agx-slides { flex: 1 1 auto; min-height: 7rem; margin: 0; padding: 0.2rem; list-style: none; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; border-top: 1px solid var(--color-border); }
  .agx-slide { display: flex; align-items: center; gap: 0.6rem; width: 100%; min-height: 2.1rem; padding: 0.3rem 0.5rem; border: none; border-radius: 8px; background: none; font: inherit; font-size: var(--fs-sm); color: var(--color-text); text-align: left; cursor: pointer; }
  .agx-slide:hover { background: var(--color-bg-hover); }
  .agx-slide:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--color-text); }
  .agx-slide.is-on { background: var(--seg-bg); font-weight: 650; }
  .agx-slide__n { flex: none; width: 1.8rem; text-align: right; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--color-text-muted); }
  .agx-slide__t { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 0.45rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agx-slide__t small { color: var(--color-text-secondary); font-size: var(--fs-xs); font-weight: 400; overflow: hidden; text-overflow: ellipsis; }
  .agx-slide__k { flex: none; font-size: var(--fs-2xs); font-weight: 600; letter-spacing: 0.02em; color: var(--color-text-muted); }
  .agx-slide.is-section { font-weight: 650; }
  .agx-slide.is-doc .agx-slide__t, .agx-slide.is-live .agx-slide__t, .agx-slide.is-books .agx-slide__t { padding-left: 1.2rem; font-weight: 400; color: var(--color-text-secondary); }
  .agx-slide.is-doc.is-on .agx-slide__t, .agx-slide.is-live.is-on .agx-slide__t, .agx-slide.is-books.is-on .agx-slide__t { color: var(--color-text); }
  .agx-item__n.is-blank { visibility: hidden; }
  /* Too narrow for both side by side (up to 1280px, beside the menu the agenda's names went a word to a line, and a touch
     screen's larger text broke them mid-word): the presentation over the agenda, the slide on the left, its list beside it */
  @media (max-width: 1280px) {
    .bm-work { grid-template-columns: minmax(0, 1fr); }
    .agx-stage { position: static; max-height: none; order: -1; display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); grid-template-areas: 'bar bar' 'frame list' 'nav list'; column-gap: 1rem; align-items: start; }
    .agx-stage:not(.is-screen) { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'bar' 'frame'; }
    .agx-stage__bar { grid-area: bar; }
    .agx-stage__frame { grid-area: frame; }
    .agx-stage__nav { grid-area: nav; flex-wrap: wrap; }
    .agx-slides { grid-area: list; align-self: stretch; max-height: 22rem; border-top: none; border-left: 1px solid var(--color-border); }
  }
  @media (max-width: 760px) {
    .agx-stage, .agx-stage:not(.is-screen) { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'bar' 'frame' 'nav' 'list'; }
    .agx-slides { max-height: 14rem; border-left: none; border-top: 1px solid var(--color-border); }
    .agx-stage__now { display: none; }
  }
  /* A phone: the agenda alone (Preview the presentation, at the top, shows the slides themselves) */
  @media (max-width: 600px) { .agx-stage { display: none; } }

  /* Getting ready: which presenters' reports are in */
  .bm-reports { margin-top: 1rem; padding-top: 0.9rem; border-top: 1px solid var(--color-border); }
  .bm-reports__h { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; margin: 0 0 0.2rem; }
  .bm-reports__h span { font-size: var(--fs-sm); font-weight: 650; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
  .bm-reports__h span.is-all { color: var(--tone-success-fg); }
  .bm-reports__list { list-style: none; margin: 0.55rem -0.45rem 0; padding: 0; display: grid; gap: 1px; }
  .bm-reports__row { display: flex; align-items: center; gap: 0.55rem; padding: 0.4rem 0.45rem; border-radius: 8px; text-decoration: none; color: inherit; }
  .bm-reports__row:hover { background: var(--seg-bg); }
  .bm-reports__n { flex: none; min-width: 1.9rem; font-size: var(--fs-2xs); font-weight: 750; color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
  .bm-reports__t { flex: 1; min-width: 0; display: grid; }
  .bm-reports__t > span { font-size: var(--fs-sm); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bm-reports__t small { font-size: var(--fs-xs); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bm-reports__s { flex: none; display: inline-flex; align-items: center; gap: 0.25rem; font-size: var(--fs-xs); color: var(--color-text-muted); white-space: nowrap; }
  .bm-reports__row.is-in .bm-reports__s { color: var(--tone-success-fg); font-weight: 650; }
  .bm-reports__s svg { width: 13px; height: 13px; }

  /* Files, by what they are */
  .bf-group + .bf-group { margin-top: 0.85rem; }
  .bf-group .bm-group { margin-top: 0; }
  .bf-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .bf-file { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.5rem 0.5rem 0.85rem; border-top: 1px solid var(--color-border); }
  .bf-file:first-child { border-top: none; }
  .bf-file__main { flex: 1; min-width: 0; }
  .bf-seen { display: inline-flex; align-items: center; gap: 0.45rem; flex: none; width: 8.8rem; height: 32px; padding: 0 0.7rem 0 0.45rem; border-radius: 999px; border: 1px solid var(--color-border); background: var(--color-bg-card); font: inherit; font-size: var(--fs-xs); font-weight: 650; color: var(--color-text); cursor: pointer; }
  .bf-seen:focus-visible { outline: 2px solid var(--color-text); outline-offset: 2px; }
  .bf-seen__track { position: relative; flex: none; width: 26px; height: 16px; border-radius: 999px; background: var(--tone-success-fg); transition: background 0.15s; }
  .bf-seen__dot { position: absolute; top: 2px; left: 12px; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.25); transition: left 0.15s; }
  .bf-seen.is-staff .bf-seen__track { background: var(--color-border-strong); }
  .bf-seen.is-staff .bf-seen__dot { left: 2px; }
  .bf-seen.is-staff { color: var(--tone-warn-fg); border-color: var(--tone-warn-line); background: var(--tone-warn-surface); }
  @media (max-width: 600px) { .bf-file { flex-wrap: wrap; } .bf-file__main { flex-basis: 100%; } }

  /* The minutes, as the board reads them */
  .bm-minutes h4 { margin: 0; font-size: var(--fs-base); font-weight: 700; }
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
  .bd-line--vote { grid-template-columns: minmax(0, 1fr) auto; }
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
  /* Presenting (board-meeting.js RunBar): what's on the screen, the screen itself small, Previous and Next in a place
     of their own, and the part's clock; every row a set height, so nothing moves as the screen does */
  .bm-run { margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.85rem; }
  .bm-run.is-ended { grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.75rem 1.25rem; }
  .bm-run__head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem 1.25rem; min-width: 0; }
  .bm-run__head .bm-run__clock { min-height: 32px; }
  .bm-run.is-ready .bm-run__hint { color: var(--color-text-secondary); }
  .bm-run.is-ready .bm-run__hint .kbd { background: var(--color-bg-secondary); border-color: var(--color-border); color: var(--color-text); }
  .bm-run__lead p { margin: 0.25rem 0 0; font-size: var(--fs-sm); color: var(--color-text-secondary); line-height: 1.5; max-width: 46rem; }
  .bm-run__state { font-size: var(--fs-2xs); font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-text-secondary); }
  .bm-run.is-live { background: #1F201C; border-color: #1F201C; color: #F6F4EC; box-shadow: 0 10px 28px -12px rgba(26,27,31,0.55); }
  .bm-run.is-live .bm-run__state { color: var(--color-primary); }
  .bm-run__clock { display: flex; align-items: center; gap: 0.6rem; }
  .bm-run__time { font-variant-numeric: tabular-nums; font-weight: 700; font-size: var(--fs-md); letter-spacing: 0.01em; }
  .bm-run__deck { display: grid; grid-template-columns: clamp(9.5rem, 15vw, 13rem) minmax(0, 1fr) auto; align-items: center; gap: 1.1rem; padding-top: 0.85rem; border-top: 1px solid var(--color-border); }
  .bm-mirror { display: block; width: 100%; padding: 0; border: none; border-radius: 8px; background: #1C1D1A; cursor: pointer; overflow: hidden; box-shadow: 0 0 0 1px rgba(26,27,31,0.2), 0 6px 16px -10px rgba(26,27,31,0.6); }
  .bm-mirror:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
  .bm-mirror__frame { position: relative; display: block; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; }
  .bm-mirror__frame iframe { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; border: 0; transform-origin: 0 0; pointer-events: none; }
  .bm-run__now { display: grid; gap: 0.1rem; min-width: 0; }
  .bm-run__label { font-size: var(--fs-2xs); font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--tone-info-fg); }
  .bm-run__title { font-size: var(--fs-lg, 1.15rem); font-weight: 750; letter-spacing: -0.01em; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bm-run__sec, .bm-run__next { font-size: var(--fs-xs); color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bm-run__step { display: flex; align-items: center; gap: 0.4rem; }
  .bm-run__count { min-width: 4.4em; margin-right: 0.3rem; text-align: right; font-size: var(--fs-sm); font-weight: 750; font-variant-numeric: tabular-nums; }
  .bm-run__count span { font-weight: 500; color: var(--color-text-secondary); }
  .bm-run__do { display: flex; flex-wrap: wrap; gap: 0.4rem; justify-content: flex-end; flex: none; }
  .bm-run.is-live .bm-run__label { color: var(--color-primary); }
  .bm-run.is-live .bm-run__sec { color: rgba(246,244,236,0.72); }
  .bm-run.is-live .bm-run__next, .bm-run.is-live .bm-run__count span { color: rgba(246,244,236,0.58); }
  .bm-run.is-live .bm-run__deck, .bm-run.is-live .bm-run__meta { border-top-color: rgba(246,244,236,0.14); }
  .bm-run.is-live .btn-ghost { background: rgba(246,244,236,0.1); border-color: rgba(246,244,236,0.2); color: #F6F4EC; }
  .bm-run.is-live .btn-ghost:hover:not(:disabled) { background: rgba(246,244,236,0.18); }
  .bm-run.is-live .btn:disabled { opacity: 0.4; }
  .bm-run__hint { margin: 0; font-size: var(--fs-xs); color: rgba(246,244,236,0.65); }
  .bm-run__hint .kbd { background: rgba(246,244,236,0.12); border-color: rgba(246,244,236,0.25); color: #F6F4EC; }
  @media (max-width: 760px) {
    .bm-run.is-ended { grid-template-columns: minmax(0, 1fr); } .bm-run__head { flex-wrap: wrap; } .bm-run__do { justify-content: flex-start; }
    .bm-run__deck { grid-template-columns: minmax(0, 1fr); } .bm-run__step { justify-content: flex-end; } .bm-run__step .btn { flex: 1 1 0; }
  }
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
  @media (max-width: 560px) { .bm-vote__counts { gap: 0.4rem; } .bm-vote__n { padding: 0.5rem 0.55rem; } .bm-vote__num { font-size: 1.45rem; } .bm-vote__lab { font-size: var(--fs-2xs); } }
  @media (prefers-reduced-motion: reduce) { .bm-live-dot::after, .bm-vote__who li { animation: none; } .bm-vote__bar i, .ag--run .ag-item { transition: none; } }

  /* Pickers: who presents, which item a document goes with */
  .bd-face::before { content: attr(data-i); }
  .bd-face { --av-bg: var(--seg-bg); --av-fg: var(--color-text-secondary); box-shadow: 0 0 0 2px var(--color-bg-card); }
  .bd-pop { position: relative; display: inline-flex; min-width: 0; }
  .bd-pop__btn { display: inline-flex; align-items: center; gap: 0.45rem; min-width: 0; max-width: 100%; height: 32px; padding: 0 0.55rem; border: 1px solid transparent; border-radius: 999px; background: none; font: inherit; font-size: var(--fs-sm); color: var(--color-text-secondary); cursor: pointer; }
  .bd-pop__btn:hover, .bd-pop.is-open .bd-pop__btn { background: var(--seg-bg); color: var(--color-text); }
  .bd-pop__btn:focus-visible { outline: 2px solid var(--color-text); outline-offset: 1px; }
  .bd-pop__panel { position: absolute; top: calc(100% + 6px); right: 0; width: min(23rem, calc(100vw - 2rem)); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); box-shadow: 0 18px 44px -12px rgba(26,27,31,0.28); animation: bd-pop-in 0.16s cubic-bezier(0.22,1,0.36,1) both; }
  @keyframes bd-pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
  .bd-who { flex: 0 1 auto; max-width: 17rem; }
  .bd-who__faces { display: inline-flex; flex: none; }
  .bd-who__faces .bd-face + .bd-face { margin-left: -6px; }
  .bd-who__names { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text); font-weight: 550; }
  .bd-who__empty { white-space: nowrap; color: var(--color-text-muted); font-weight: 600; }
  /* Nobody picked yet: there to see on every item, quietly */
  .bd-who:not(.has-who) .bd-pop__btn { border: 1px dashed var(--color-border-strong); color: var(--color-text-secondary); }
  .bd-who:not(.has-who) .bd-pop__btn:hover, .bd-who.is-open:not(.has-who) .bd-pop__btn { border-style: solid; color: var(--color-text); }
  .bd-who:not(.has-who) .bd-who__empty { color: inherit; }
  .bd-picker { display: grid; }
  .bd-picker__find { margin: 0.6rem 0.6rem 0.35rem; height: 38px; padding: 0 0.7rem; border: 1px solid var(--color-border-strong); border-radius: 8px; font: inherit; font-size: var(--fs-sm); background: var(--color-bg-card); color: var(--color-text); }
  .bd-picker__find:focus { outline: none; border-color: var(--color-text); box-shadow: 0 0 0 3px rgba(26,27,31,0.08); }
  .bd-picker__chosen { display: flex; flex-wrap: wrap; gap: 0.3rem; padding: 0.15rem 0.6rem 0.4rem; }
  .bd-chip { display: inline-flex; align-items: center; gap: 0.35rem; height: 28px; padding: 0 0.25rem 0 0.3rem; border-radius: 999px; background: var(--seg-bg); font-size: var(--fs-xs); font-weight: 650; }
  .bd-chip button { border: none; background: none; width: 22px; height: 22px; border-radius: 50%; color: var(--color-text-muted); cursor: pointer; font-size: 11px; }
  .bd-chip button:hover { background: var(--color-bg-card); color: var(--color-text); }
  .bd-picker__list { list-style: none; margin: 0; padding: 0.15rem 0.35rem 0.35rem; max-height: min(22rem, 52vh); overflow-y: auto; overscroll-behavior: contain; }
  .bd-picker__group { padding: 0.55rem 0.5rem 0.25rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-muted); }
  .bd-picker__opt { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0.5rem; border-radius: 8px; cursor: pointer; }
  .bd-picker__opt.is-active { background: var(--seg-bg); }
  .bd-picker__opt:hover { background: var(--seg-bg); }
  .bd-picker__opt:focus-visible { outline: 2px solid var(--color-text); outline-offset: -2px; }
  /* The order the screen shows them, each after the first a step earlier */
  .bd-showorder { margin: 0 0.35rem; padding: 0.5rem 0.5rem 0.35rem; border-top: 1px solid var(--color-border); }
  .bd-showorder__h { margin: 0 0 0.35rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-muted); }
  .bd-showorder ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
  .bd-showorder li { display: flex; align-items: center; gap: 0.6rem; min-height: 34px; }
  .bd-showorder__t { flex: 1; min-width: 0; display: grid; font-size: var(--fs-sm); font-weight: 600; }
  .bd-showorder__t small { font-size: var(--fs-xs); font-weight: 400; color: var(--color-text-secondary); }
  .bd-picker__opt[aria-selected="true"] .bd-picker__name { font-weight: 700; }
  .bd-picker__text { display: grid; min-width: 0; flex: 1; }
  .bd-picker__name { font-size: var(--fs-sm); font-weight: 600; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bd-picker__meta { font-size: var(--fs-xs); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bd-picker__check { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; color: var(--color-text); }
  .bd-picker__opt[aria-selected="true"] .bd-picker__check { background: var(--color-primary); }
  .bd-picker__check svg { width: 13px; height: 13px; }
  .bd-picker__num { flex: none; min-width: 2.2rem; font-variant-numeric: tabular-nums; font-size: var(--fs-xs); font-weight: 700; color: var(--color-text-muted); }
  .bd-picker__opt.is-none .bd-picker__name { color: var(--color-text-secondary); font-weight: 500; }
  .bd-picker__none { padding: 0.75rem 0.5rem; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .bd-picker__lead { margin: 0; padding: 0.7rem 0.85rem 0.35rem; font-size: var(--fs-xs); line-height: 1.45; color: var(--color-text-secondary); }
  .bd-showpick .bd-pop__btn { height: auto; min-height: 30px; padding: 0.15rem 0.35rem; }
  .bd-showpick:not(.has-who) .bd-pop__btn { border: 1px dashed var(--color-border-strong); color: var(--color-text-secondary); padding: 0 0.55rem; }
  .bd-shows { display: inline-flex; flex-wrap: wrap; gap: 0.3rem; }
  .bd-showpick__n { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; border: 1.5px solid var(--color-border-strong); font-size: var(--fs-2xs); font-weight: 800; font-variant-numeric: tabular-nums; }
  .bd-showpick__n.is-on { border-color: var(--color-primary); background: var(--color-primary); color: #1F201C; }
  .bd-picker__foot .is-full { color: var(--tone-warn-fg); font-weight: 650; }
  .bd-picker__foot { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.5rem 0.6rem; border-top: 1px solid var(--color-border); }
  .bd-goes .bd-pop__btn { border-color: var(--color-border); max-width: 16rem; }
  .bd-goes__now { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text); }
  .bd-goes__now b { font-variant-numeric: tabular-nums; color: var(--color-text-secondary); margin-right: 0.2rem; }
  .bd-goes__now.is-none { color: var(--color-text-muted); }

  /* The documents that go with an agenda item */
  .ag-docs { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.15rem 0 0.4rem 1.25rem; }
  .bd-doc { display: inline-flex; align-items: center; max-width: 100%; height: 30px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-card); }
  .bd-doc__a { display: inline-flex; align-items: center; gap: 0.45rem; min-width: 0; height: 100%; padding: 0 0.55rem 0 0.35rem; color: var(--color-text); text-decoration: none; font-size: var(--fs-xs); font-weight: 600; }
  .bd-doc__a:hover .bd-doc__name { text-decoration: underline; text-underline-offset: 3px; }
  .bd-doc__fmt { flex: none; padding: 0.1rem 0.3rem; border-radius: 4px; background: var(--seg-bg); font-size: 9.5px; font-weight: 800; letter-spacing: 0.04em; color: var(--color-text-secondary); }
  .bd-doc__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 22rem; }
  .bd-doc__note { color: var(--color-text-muted); font-weight: 500; white-space: nowrap; }
  .bd-doc__x { flex: none; width: 26px; height: 26px; margin-right: 2px; border: none; border-radius: 6px; background: none; color: var(--color-text-muted); cursor: pointer; font-size: 11px; }
  .bd-doc__x:hover { background: var(--seg-bg); color: var(--color-text); }
  .ag-item.is-over { background: var(--tone-info-surface); box-shadow: 0 0 0 1px var(--tone-info-line-strong); border-radius: var(--radius-md); }
  .ag-add-doc { border: 1px dashed var(--color-border-strong); background: none; height: 30px; padding: 0 0.6rem; border-radius: 8px; font: inherit; font-size: var(--fs-xs); font-weight: 600; color: var(--color-text-secondary); cursor: pointer; }
  .ag-add-doc:hover { color: var(--color-text); border-color: var(--color-text-muted); }
  .bd-docpick__up { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.6rem; border-top: 1px solid var(--color-border); }
  .bf-file .bd-goes { flex: none; }
  @media (max-width: 600px) { .ag-docs { margin-left: 0.5rem; } .bd-who { max-width: 100%; } .bf-file .bd-goes { order: 3; } }
  @media (prefers-reduced-motion: reduce) { .bd-pop__panel { animation: none; } }

  /* The part's timer and who has the floor, under what's on the screen */
  .bm-run__meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.6rem 1.5rem; min-height: 2.6rem; padding: 0.7rem 0 0; border-top: 1px solid var(--color-border); }
  .bm-timer { display: flex; align-items: center; gap: 0.6rem; height: 2rem; min-width: 0; white-space: nowrap; }
  .bm-timer__t { font-size: var(--fs-xl, 1.4rem); font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .bm-timer__s { min-width: 0; font-size: var(--fs-xs); opacity: 0.75; overflow: hidden; text-overflow: ellipsis; }
  .bm-timer.is-over .bm-timer__t { padding: 0 0.55rem; border-radius: 8px; background: var(--color-primary); color: #1F201C; animation: bm-over 1.6s ease-in-out infinite; }
  @keyframes bm-over { 50% { opacity: 0.72; } }
  .bm-floor { display: flex; align-items: center; gap: 0.55rem; height: 2rem; min-width: 0; }
  .bm-floor__faces { display: inline-flex; }
  .bm-floor__faces .bd-face + .bd-face { margin-left: -8px; }
  .bm-floor__t { min-width: 0; font-size: var(--fs-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bm-run.is-live .bm-floor .bd-menu > summary { color: #F6F4EC; }
  @media (prefers-reduced-motion: reduce) { .bm-timer.is-over .bm-timer__t { animation: none; } }
  .bm-run.is-rehearsing { border-color: var(--tone-info-line-strong); }
  /* A part's time, beside its name in the agenda editor */
  .ag-mins { display: inline-flex; align-items: center; gap: 0.35rem; flex: none; height: 32px; padding: 0 0.5rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text-secondary); font-size: var(--fs-xs); cursor: text; }
  .ag-mins:focus-within { border-color: var(--color-text); background: var(--color-bg-card); box-shadow: 0 0 0 3px rgba(26,27,31,0.1); }
  .ag-mins input { width: 2.6rem; border: none; background: none; padding: 0; font: inherit; font-weight: 700; color: var(--color-text); text-align: right; -moz-appearance: textfield; }
  .ag-mins input::-webkit-outer-spin-button, .ag-mins input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .ag-mins input:focus { outline: none; }
  .ag-mins input::placeholder { color: var(--color-text-secondary); font-weight: 600; }
  .ag-mins__at { font-variant-numeric: tabular-nums; padding-right: 0.35rem; border-right: 1px solid var(--color-border); }
  .bm-order__head small { margin-left: auto; color: var(--color-text-secondary); font-weight: 600; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
  /* During: the agenda in order, each item and document a tap from the screen */
  .bm-order, .bm-order ol { list-style: none; margin: 0; padding: 0; }
  .bm-order { display: grid; gap: 0.9rem; }
  .bm-order__head { display: flex; gap: 0.6rem; align-items: baseline; margin: 0 0 0.3rem; font-size: var(--fs-sm); font-weight: 750; color: var(--color-text); }
  .bm-order__head span { color: var(--color-text-secondary); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); }
  .bm-order__sec > ol { display: grid; gap: 0.15rem; }
  .bm-order__item { padding: 0.15rem 0; border-radius: var(--radius-md); scroll-margin: calc(var(--top-h, 0px) + 9rem); }
  .bm-order__go { display: flex; align-items: center; gap: 0.6rem; width: 100%; min-height: 40px; padding: 0.35rem 0.6rem; border: 1px solid transparent; border-radius: var(--radius-md); background: none; font: inherit; color: var(--color-text); text-align: left; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
  .bm-order__go:hover { background: var(--color-bg-subtle, rgba(0,0,0,0.035)); }
  .bm-order__n { flex: none; display: inline-grid; place-items: center; min-width: 2.1rem; height: 1.6rem; padding: 0 0.35rem; border-radius: 999px; background: var(--seg-bg, rgba(0,0,0,0.05)); font-size: var(--fs-2xs); font-weight: 750; font-variant-numeric: tabular-nums; color: var(--color-text-secondary); }
  .bm-order__t { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.1rem 0.6rem; font-weight: 600; }
  .bm-order__t small { color: var(--color-text-secondary); font-weight: 500; font-size: var(--fs-xs); }
  .bm-order__item.is-now .bm-order__go { background: var(--color-primary-bg); border-color: var(--color-primary); }
  .bm-order__item.is-now .bm-order__n { background: #1F201C; }
  .bm-order__approve { margin: 0.2rem 0 0.35rem 2.6rem; }
  .bm-order__head small { white-space: nowrap; }
  .bm-order__tags { display: inline-flex; flex-wrap: wrap; gap: 0.3rem; }
  /* An item's other live lists and QuickBooks' slides, each a stop to put on the screen */
  .bm-slides { list-style: none; margin: 0.1rem 0 0.3rem 2.75rem; padding: 0; display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .bm-slide { display: inline-flex; align-items: center; gap: 0.45rem; min-height: 32px; padding: 0 0.7rem 0 0.35rem; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-bg-card); font: inherit; font-size: var(--fs-xs); font-weight: 650; color: var(--color-text); cursor: pointer; }
  .bm-slide:hover { border-color: var(--color-border-strong); }
  .bm-slide.is-on { background: var(--color-primary-bg); border-color: var(--color-primary); }
  .bm-slide__k { display: inline-grid; place-items: center; min-width: 2.1rem; height: 22px; padding: 0 0.35rem; border-radius: 999px; background: var(--seg-bg, rgba(0,0,0,0.05)); font-size: var(--fs-2xs); font-weight: 800; letter-spacing: 0.04em; color: var(--color-text-secondary); }
  @media (max-width: 600px) {
    .bm-order__go { flex-wrap: wrap; }
    .bm-order__t { flex: 1 1 calc(100% - 3rem); }
    .bm-order__go > .tag, .bm-order__tags { margin-left: 2.7rem; }
    .bm-slides { margin-left: 0.4rem; }
  }
  /* After: one place to drop the minutes */
  .bm-minutes-drop { display: flex; align-items: center; gap: 1rem; padding: 1.15rem 1.25rem; margin: 0; border: 1.5px dashed var(--color-border-strong); border-radius: var(--radius-lg, 14px); background: var(--color-bg-card); cursor: pointer; transition: background 0.2s, border-color 0.2s; }
  .bm-minutes-drop:hover, .bm-minutes-drop.is-over { border-color: var(--color-text); background: var(--color-primary-bg); }
  .bm-minutes-drop:focus-within { outline: 2px solid var(--color-text); outline-offset: 2px; }
  .bm-minutes-drop.is-done { border-style: solid; border-color: var(--tone-success-line, var(--color-border)); background: var(--tone-success-surface, var(--color-bg-card)); }
  .bm-minutes-drop.is-busy { cursor: progress; }
  .bm-minutes-drop__icon { flex: none; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: var(--color-primary); color: #1F201C; }
  .bm-minutes-drop.is-done .bm-minutes-drop__icon { background: var(--tone-success-bg); color: var(--tone-success-fg); }
  .bm-minutes-drop__text { flex: 1 1 auto; min-width: 0; display: grid; gap: 0.15rem; }
  .bm-minutes-drop__text strong { font-size: var(--fs-md, 1rem); }
  .bm-minutes-drop__text span { color: var(--color-text-secondary); font-size: var(--fs-xs); line-height: 1.4; }
  /* An item's documents, under it: each one's first page, its title and what it is, all one size (two to a row on a wide screen) */
  .bm-docs { list-style: none; margin: 0.25rem 0 0.45rem 2.6rem; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr)); gap: 0.4rem; }
  .bm-docs--more { margin-left: 0; }
  .bm-doc { display: flex; align-items: center; gap: 0.7rem; width: 100%; height: 100%; min-height: 3.6rem; padding: 0.35rem 0.75rem 0.35rem 0.4rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); font: inherit; color: var(--color-text); text-align: left; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .bm-doc:hover { border-color: var(--color-border-strong); background: var(--color-bg-subtle, rgba(0,0,0,0.035)); }
  .bm-doc__cover { flex: none; display: grid; place-items: center; width: 36px; height: 46px; overflow: hidden; border-radius: 3px; background: #fff; box-shadow: 0 0 0 1px var(--color-border), 0 1px 2px rgba(0,0,0,0.08); }
  .bm-doc__text { min-width: 0; display: grid; gap: 0.1rem; }
  .bm-doc__title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: var(--fs-sm); font-weight: 650; line-height: 1.3; }
  .bm-doc__meta { font-size: var(--fs-xs); color: var(--color-text-secondary); }
  .bm-doc.is-on { background: #1F201C; border-color: #1F201C; color: #fff; }
  .bm-doc.is-on .bm-doc__meta { color: var(--color-primary); font-weight: 650; }
  .bm-doc.is-on .bm-doc__cover { box-shadow: none; }

  /* Board → a meeting, after the Nov 2026 review */
  .bm-when.is-live { background: #1F201C; color: var(--color-primary); }
  .bm-when.is-held { background: var(--seg-bg); color: var(--color-text-secondary); }
  @media (max-width: 600px) {
    .bm-facts { display: grid; justify-items: start; margin-left: 0; clip-path: none; } .bm-facts > * { margin-left: 0; } .bm-facts > *::before { content: none; }
    /* the phone's header keeps one row: Saved and Saving are said to a screen reader, not shown (an error is). Shown,
       Saving took a row of its own as you typed and gave it back on the save, so the page jumped twice an edit */
    .bm-saved:not(.is-error) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .bm-top__bar .bd-actions { margin-left: auto; }
  }
  @media (max-width: 760px) { .bm-stage { align-items: flex-start; } .bm-stage__s { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; } }
  .bm-note { display: flex; align-items: flex-start; gap: 0.5rem; margin: 0 0 0.85rem; padding: 0.6rem 0.75rem; border-radius: var(--radius-md); background: var(--color-bg-subtle, #F7F7F5); font-size: var(--fs-sm); line-height: 1.45; color: var(--color-text-secondary); }
  .bm-note.is-warn { background: var(--tone-warn-surface); border: 1px solid var(--tone-warn-line); color: var(--tone-warn-fg); }
  .bm-note svg { flex: none; margin-top: 2px; }
  .bm-note .link { white-space: nowrap; }
  .bm-task__do .bm-note, .bm-vote .bm-note { flex-basis: 100%; margin: 0.35rem 0 0; }
  .bm-who__no { font-size: var(--fs-xs); color: var(--tone-warn-fg); }
  .bm-coming__wait { margin: 0.75rem 0 0; font-size: var(--fs-sm); }
  .bm-task__t:focus, .bm-check h3:focus, #bm-where h3:focus { outline: none; }
  .bd-pick:focus-within { outline: 2px solid var(--color-text); outline-offset: 2px; }
  .bm-task.is-skip .bm-task__mark { border-style: dashed; opacity: 0.6; }
  .bm-task.is-skip .bm-task__t { color: var(--color-text-secondary); font-weight: 500; }
  .bm-hint { margin: 0.35rem 0 0; font-size: var(--fs-xs); color: var(--color-text-secondary); }
  .bm-minutes-drop__undo { flex: none; }
  @media (max-width: 600px) {
    /* a phone checks who's coming first */
    .bm-slot--coming { order: 0; }
    /* a save that failed keeps the header one row: Present steps aside until it's saved */
    .bm-top:has(.bm-saved.is-error) .bm-present { display: none; }
    /* what the calendar sets, a line each */
    #bm-where .form-group:has(> .bm-fixed) { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.2rem; }
    #bm-where .form-group:has(> .bm-fixed) .form-label { flex: 0 0 4.6rem; margin: 0; }
    #bm-where .form-group:has(> .bm-fixed) .bm-fixed { padding: 0; }
  }
  .bm-motion__text { flex: 1 1 auto; min-width: 0; margin: 0; padding: 0.45rem 0.1rem; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
  .bm-run { scroll-margin-top: calc(var(--top-h, 0px) + 0.75rem); }
  /* A phone: what's on the screen and Previous / Next first, the small screen under them */
  @media (max-width: 760px) {
    .bm-run__now { order: 1; } .bm-run__step { order: 2; } .bm-run__deck > .bm-mirror { order: 3; }
    .bm-timer { white-space: normal; height: auto; flex-wrap: wrap; row-gap: 0.1rem; } .bm-timer__s { white-space: normal; } .bm-floor { height: auto; } .bm-floor__t { white-space: normal; }
  }
  .bm-task__t:focus-visible, .bm-check h3:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; border-radius: 4px; }
  .bm-where__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .bm-fixed { display: flex; align-items: center; gap: 0.45rem; margin: 0; padding: 0.3rem 0 0; font-size: var(--fs-base); font-weight: 600; color: var(--color-text); }
  .bm-fixed svg { flex: none; color: var(--color-text-muted); }
  .bm-quorum.is-held { background: var(--color-bg-card); }
  .bd-menu__text { white-space: nowrap; }
  .bm-run.is-live .bm-floor .bd-menu__text { background: rgba(246,244,236,0.1); border-color: rgba(246,244,236,0.2); color: #F6F4EC; }
  /* The packet: a file dragged over the page, one being renamed, the ones on their way up */
  .bm-files.is-over { box-shadow: 0 0 0 2px var(--tone-info-line-strong); }
  .bf-rename { height: 34px; max-width: 100%; }
  .bf-up { margin-top: 0.6rem; }
  .bf-file.is-up { color: var(--color-text-secondary); }
  .bf-file.is-up .spinner { flex: none; }
  /* After: the drop card, one row once the minutes are in; its button never wraps */
  .bm-minutes-drop__btn { flex: none; white-space: nowrap; }
  .bm-minutes-drop.is-done { padding: 0.7rem 1rem; }
  .bm-minutes-drop.is-done .bm-minutes-drop__icon { width: 32px; height: 32px; border-radius: 9px; }
  @media (max-width: 600px) { .bm-minutes-drop { flex-wrap: wrap; gap: 0.75rem 1rem; } .bm-minutes-drop__text { flex: 1 1 calc(100% - 44px - 1rem); } .bm-minutes-drop__btn { margin-left: calc(44px + 1rem); } .bm-minutes-drop.is-done .bm-minutes-drop__btn { margin-left: calc(32px + 1rem); } }
  /* The bar at the foot of a tablet or a phone while presenting, once the run card is scrolled away */
  .bm-runbar { display: none; }
  @media (max-width: 1180px) {
    .bm-runbar { position: fixed; z-index: 40; left: calc(var(--bar-l, 0px) + max(0.75rem, env(safe-area-inset-left, 0px))); right: calc(var(--bar-r, 0px) + max(0.75rem, env(safe-area-inset-right, 0px))); bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
      display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0.5rem 0.45rem 0.35rem; border-radius: 14px; border: 1px solid var(--color-border); background: var(--color-bg-card); box-shadow: 0 14px 36px -12px rgba(26,27,31,0.45);
      transform: translateY(calc(100% + 1.5rem)); visibility: hidden; transition: transform 0.25s cubic-bezier(0.22,1,0.36,1), visibility 0s linear 0.25s; }
    .bm-runbar.is-on { transform: none; visibility: visible; transition: transform 0.25s cubic-bezier(0.22,1,0.36,1); }
    .bm-runbar.is-live { background: #1F201C; border-color: #1F201C; color: #F6F4EC; }
    .bm-runbar.is-live .btn-ghost { background: rgba(246,244,236,0.1); border-color: rgba(246,244,236,0.2); color: #F6F4EC; }
    .bm-runbar__now { flex: 1 1 auto; min-width: 0; display: grid; gap: 0.05rem; min-height: 44px; padding: 0.15rem 0.45rem; border: none; border-radius: 9px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .bm-runbar__state { display: inline-flex; align-items: center; gap: 0.4rem; font-size: var(--fs-2xs); font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--tone-info-fg); }
    .bm-runbar.is-live .bm-runbar__state { color: var(--color-primary); }
    .bm-runbar__state b { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
    .bm-runbar__state { gap: 0.6rem; }
    .bm-runbar__state .bm-live-dot { width: 7px; height: 7px; margin-left: 0.25rem; }
    .bm-runbar__t { font-size: var(--fs-sm); font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bm-runbar__t b { font-weight: 800; }
    .bm-runbar .btn { flex: none; min-height: 44px; }
    .bm-layout.is-during:has(.bm-runbar.is-on) { padding-bottom: 5.5rem; }
    body:has(.bm-runbar.is-on) .toast-container { bottom: calc(5.5rem + env(safe-area-inset-bottom, 0px)); }
  }
  @media (prefers-reduced-motion: reduce) { .bm-runbar { transition: none !important; } }
  /* A finger's worth of room on touch screens */
  @media (pointer: coarse) {
    .bm-top .bd-back, .bm-facts .bm-link { display: inline-flex; align-items: center; min-height: 44px; }
    .bf-file .bd-file-name { display: inline-flex; align-items: center; min-height: 44px; }
    .bf-seen { height: 44px; }
    .toast-undo { min-height: 44px; padding-inline: 0.85rem; }
    .bm-note .link { min-width: 44px; justify-content: center; }
    .bm-facts .link, .bm-note .link, #bm-where .link { display: inline-flex; align-items: center; min-height: 44px; }
    #bm-where .btn-sm, .bf-file .bd-pop__btn { min-height: 44px; }
    .bm-top .bd-icon-btn, .bm-layout .bd-icon-btn { min-width: 44px; min-height: 44px; }
    .bm-top .btn-sm, .bm-layout .btn-sm { min-height: 44px; }
    .bd-menu__item { min-height: 44px; }
    .bm-stage { min-height: 56px; }
    .bd-drop__hint { display: none; }
  }
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
