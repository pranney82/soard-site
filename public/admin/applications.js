/**
 * Admin → Applications (loaded on first visit, like ./automations.js)
 * ===========================================================================
 * Five tabs, grouped by job, each with its own hash (#applications/<tab>):
 *  - Applicants: ./applicants.js, loaded on first visit. Board, List, Map,
 *    Activity and a family's page, worked live against JobTread. This file
 *    adds its Submissions view (#applications/submissions): each website
 *    application, whether every step of loading it into JobTread worked, the
 *    address and repeat checks, CSV, Retry, and deleting a family's data from
 *    the site. Applications that haven't fully arrived show as a notice above
 *    every view. #applications/<app id> (JobTread's Application URL) opens
 *    that family's page, or its row in Submissions.
 *  - Insights: the season's funnel: who started, who finished, where people stop.
 *  - Form: the application itself, with Questions, Spanish and Versions. Pages
 *    and questions on the left (drag the handle, or Alt+↑/↓), the selected
 *    one on the right, a live phone preview. Every change saves to a draft;
 *    "Put live" lists what changed, then makes it what families see.
 *    Questions that feed JobTread can be reworded and moved, never removed.
 *  - Emails: every email a family gets, in order, each with its Spanish and a
 *    preview of how it reads. Wording is part of the form's draft.
 *  - Settings: how it all runs, saved at once (never through Put live): open
 *    or closed, the season, the closed message, an outside form and the
 *    opening schedule (`application` in the site settings), plus who gets the
 *    new-application email, the service area and when status emails go out
 *    (the form's settings, _application-forms.js). The tab carries an
 *    Open/Closed badge seen from every tab.
 *
 * Undo: ⌘Z / Ctrl+Z steps the draft back and ⇧⌘Z / Ctrl+Y forward, from
 * anywhere except a text box, where the keys keep their usual job (undoing the
 * typing in that box, as every editor does). The toolbar buttons always step
 * the draft. A burst of typing in one box (keys under 600ms apart) is one step.
 *
 * Two editors at once: every save sends the draft's updatedAt this editor last
 * saw (`base`). If someone else saved since, the server answers 409 with their
 * draft and autosave waits until this editor loads theirs or keeps its own.
 *
 * The definition format and its rules live in functions/api/_application-form.js.
 * This file is served as-is, so the few helpers it needs from there
 * (englishStrings, translationStatus, newFieldId, ruleText) are mirrored here.
 */

import { h, htm, render, Component, useState, useEffect, useRef, useMemo, Sortable, DOMPurify } from './vendor.js';
import { WaitlistPanel, WaitlistOpenNote } from './waitlist.js';
import { nearRing, bandCounts, bandChanges, placeHome, NEAR_MAX } from './area-shared.js';

const html = htm.bind(h);
const API = '/api/applications-admin';

const SERVICE_MAP_IMAGE = 'd993cd7c-7863-4a1b-ea5e-50602623cb00';
const CF_BASE = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ';
const CHOICE_TYPES = ['select', 'radio', 'checkbox', 'ack'];
const ANSWERED = (t) => !['content', 'image', 'guidelines'].includes(t);
const UPLOADS = ['photo', 'video'];
const ADDABLE = ['text', 'textarea', 'radio', 'checkbox', 'select', 'number', 'date', 'email', 'phone', 'name', 'address', 'ack', 'photo', 'content', 'image'];
const SAMPLE = { parent: 'Jordan Stone', child: 'Avery Stone', percent: '60' };
/** Short type names for the outline rows (the inspector uses the full names from the server) */
const ROW_TYPE = { text: 'Short text', textarea: 'Long text', email: 'Email', phone: 'Phone', number: 'Number', date: 'Date', select: 'Dropdown', radio: 'One choice', checkbox: 'Choices', name: 'Name', address: 'Address', ack: 'Agree box', signature: 'Signature', photo: 'Photo', video: 'Video', content: 'Text', image: 'Image', guidelines: 'Guidelines' };
const first = (s) => String(s || '').trim().split(/\s+/)[0] || '';
const PLACEHOLDER_RE = /\{[a-zA-Z]+\}/g;
const MESSAGE_KEYS = ['welcome', 'copyNote', 'inReview', 'approved', 'denied', 'correction'];
// When status emails go out (mirrors DEFAULT_NOTIFY in functions/api/_application-form.js)
const DEFAULT_NOTIFY = { waits: { welcome: 10, inReview: 10, decision: 30 }, quiet: { start: 20, end: 8 }, summary: true };
const DEFAULT_REMINDERS = { enabled: true, days: [2, 7, 21], subject: '', body: '' };
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+';

// ─── Small helpers ─────────────────────────────────────────────────
const clone = (o) => JSON.parse(JSON.stringify(o));
const choice = (o) => (o && typeof o === 'object' ? { value: String(o.value ?? o.label ?? ''), label: String(o.label || o.value || ''), description: o.description || '' } : { value: String(o ?? ''), label: String(o ?? ''), description: '' });
const packChoice = (c) => (c.label && c.label !== c.value) || c.description ? { value: c.value, ...(c.label && c.label !== c.value ? { label: c.label } : {}), ...(c.description ? { description: c.description } : {}) } : c.value;
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const dayText = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
/** "2:14 PM" today, "Oct 18, 2:14 PM" before */
const clock = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : when(iso);
};
const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const fill = (s, year) => String(s || '').replace(/\{year\}/g, year || '2027');
const short = (s, n = 60) => { const t = strip(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const plural = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;
const num = (n) => Number(n || 0).toLocaleString();
/** "peter.ranney@x.org" → "Peter Ranney" */
const personName = (email) => {
  const s = String(email || '');
  if (!s.includes('@')) return s || 'Someone';
  return s.split('@')[0].split(/[._+-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || s;
};
/** A box that keeps its own undo: typing goes there, not to the draft's history */
const isTextEntry = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA'
  || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(el.type)));
const prefersReducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

async function call(path, body) {
  let r;
  try {
    r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch (e) {
    return { success: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  j.status = r.status;
  return j;
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** The element's width in pixels, kept current (charts draw at real size so text stays legible) */
function useWidth(ref, fallback = 600) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth || fallback);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

/** Mirrors newFieldId in _application-form.js: q + six base-36 characters, never one in use */
function newFieldId(existing) {
  let id;
  do id = `q${Math.random().toString(36).slice(2, 8)}`; while (id.length < 7 || existing.has(id));
  return id;
}

// ─── Rules ("show only when") ──────────────────────────────────────
// A rule is { field, in: [values] }, or { all: [rules] } / { any: [rules] }.
const ruleFields = (r) => (!r ? [] : Array.isArray(r.all) ? r.all.flatMap(ruleFields) : Array.isArray(r.any) ? r.any.flatMap(ruleFields) : r.field ? [r.field] : []);

/** Rebuild a rule leaf by leaf: fn returns the new leaf or null to drop it. Empty groups go; a group of one becomes that one. */
function mapRule(rule, fn) {
  if (!rule) return null;
  for (const k of ['all', 'any']) {
    if (Array.isArray(rule[k])) {
      const list = rule[k].map(r => mapRule(r, fn)).filter(Boolean);
      return list.length ? (list.length === 1 ? list[0] : { [k]: list }) : null;
    }
  }
  return fn({ field: rule.field, in: [...(rule.in || [])] });
}
/** Every page and question rule in a definition, rebuilt with fn (null removes it) */
function eachRule(w, fn) {
  for (const p of w.pages) {
    if (p.showIf) { const r = fn(p.showIf); if (r) p.showIf = r; else delete p.showIf; }
    for (const f of p.fields) if (f.showIf) { const r = fn(f.showIf); if (r) f.showIf = r; else delete f.showIf; }
  }
}
const dropFromRules = (w, ids) => eachRule(w, r => mapRule(r, l => (ids.has(l.field) ? null : l)));
const renameInRules = (w, fid, from, to) => eachRule(w, r => mapRule(r, l => (l.field === fid ? { ...l, in: l.in.map(v => (v === from ? to : v)) } : l)));
const removeValueInRules = (w, fid, v) => eachRule(w, r => mapRule(r, l => (l.field === fid ? { ...l, in: l.in.filter(x => x !== v) } : l)));

/** A rule as one list the builder can show: { mode, conds }, or null when it has nested groups */
function flatRule(rule) {
  if (!rule) return { mode: 'all', conds: [] };
  if (rule.field != null && !rule.all && !rule.any) return { mode: 'all', conds: [{ field: rule.field, in: [...(rule.in || [])] }] };
  for (const k of ['all', 'any']) {
    if (Array.isArray(rule[k]) && rule[k].every(x => x && x.field != null && !x.all && !x.any)) return { mode: k, conds: rule[k].map(x => ({ field: x.field, in: [...(x.in || [])] })) };
  }
  return null;
}
const buildRule = (mode, conds) => (!conds.length ? null : conds.length === 1 ? { field: conds[0].field, in: conds[0].in } : { [mode]: conds.map(c => ({ field: c.field, in: c.in })) });

/** In plain words (mirrors ruleText): 'Gender is Female, and County is Cobb or Fulton' */
function ruleText(rule, labelOf, valueOf) {
  if (!rule) return '';
  if (Array.isArray(rule.all)) return rule.all.map(r => ruleText(r, labelOf, valueOf)).join(', and ');
  if (Array.isArray(rule.any)) return rule.any.map(r => ruleText(r, labelOf, valueOf)).join(', or ');
  return `${labelOf(rule.field)} is ${(rule.in || []).map(v => valueOf(rule.field, v)).join(' or ') || '(no answer picked)'}`;
}

// ─── Translations (mirrors englishStrings / translationStatus) ─────
function englishStrings(def) {
  const out = {};
  const put = (path, v) => { if (typeof v === 'string' && v.trim()) out[path] = v; };
  put('title', def.title);
  for (const p of def.pages || []) {
    put(`page:${p.id}`, p.title);
    for (const f of p.fields || []) {
      for (const k of ['label', 'help', 'html', 'alt', 'title', 'doTitle', 'dontTitle']) put(`field:${f.id}:${k}`, f[k]);
      (f.doItems || []).forEach((it, i) => { put(`field:${f.id}:doItems:${i}:title`, it.title); put(`field:${f.id}:doItems:${i}:text`, it.text); });
      (f.dontItems || []).forEach((it, i) => put(`field:${f.id}:dontItems:${i}`, it));
      for (const o of f.options || []) {
        const c = choice(o);
        put(`field:${f.id}:option:${c.value}`, c.label);
        put(`field:${f.id}:desc:${c.value}`, c.description);
      }
    }
  }
  for (const [k, s] of Object.entries(def.stops || {})) { put(`stop:${k}:title`, s.title); put(`stop:${k}:body`, s.body); }
  for (const k of MESSAGE_KEYS) put(`message:${k}`, def.messages?.[k]);
  const rem = { ...DEFAULT_REMINDERS, ...(def.reminders || {}) };
  put('reminder:subject', rem.subject);
  put('reminder:body', rem.body);
  return out;
}
function translationStatus(def, lang = 'es') {
  const en = englishStrings(def);
  const tr = def.i18n?.[lang] || {};
  const strings = tr.strings || {};
  const sources = tr.sources || {};
  const out = {};
  for (const [path, text] of Object.entries(en)) {
    if (!strings[path]) out[path] = 'missing';
    else if (sources[path] != null && sources[path] !== text) out[path] = 'stale';
    else out[path] = 'done';
  }
  return out;
}
const placeholders = (s) => [...new Set(String(s || '').match(PLACEHOLDER_RE) || [])];

// ─── JobTread fields ───────────────────────────────────────────────
// Which question types can fill each JobTread field type (mirrors JT_TYPES_FOR)
const JT_TYPES_FOR = {
  text: ['text', 'textarea', 'select', 'radio', 'email', 'phone', 'number', 'date'],
  option: ['select', 'radio', 'checkbox'],
  date: ['date'],
  number: ['number'],
  url: ['text'],
  emailAddress: ['email'],
  phoneNumber: ['phone'],
  boolean: ['ack'],
};
const JT_TYPE_LABEL = { text: 'Text', option: 'Choice', date: 'Date', number: 'Number', url: 'Link', emailAddress: 'Email', phoneNumber: 'Phone', boolean: 'Yes or no' };
const jtTypeLabel = (jt) => (jt.type === 'option' && jt.multiple ? 'Several choices' : JT_TYPE_LABEL[jt.type] || jt.type);
let jtFieldsCache = null; // the session's list, loaded once

/** What's wrong with sending this question to that JobTread field, in plain words */
function jtWarnings(f, jt, types) {
  const out = [];
  const fits = JT_TYPES_FOR[jt.type] || [];
  if (!fits.includes(f.type)) out.push(`A ${(types[f.type] || f.type).toLowerCase()} question can't fill a ${jtTypeLabel(jt).toLowerCase()} field in JobTread. Make it ${fits.map(t => `a ${(types[t] || t).toLowerCase()}`).join(' or ') || 'another type'}, or pick another field.`);
  if (jt.type === 'option' && Array.isArray(jt.options) && CHOICE_TYPES.includes(f.type)) {
    const missing = (f.options || []).map(choice).filter(c => !jt.options.includes(c.value));
    if (missing.length) out.push(`JobTread's "${jt.name}" has no ${missing.map(c => `"${c.value}"`).join(', ')}. Its choices are ${jt.options.map(o => `"${o}"`).join(', ')}.`);
    if (f.type === 'checkbox' && !jt.multiple) out.push(`"${jt.name}" holds one choice. Make this a one-choice question or a dropdown.`);
  }
  return out;
}

/** An image id from an id, a Cloudflare Images link or an admin /cdn-cgi link */
function imageIdFrom(s) {
  const t = String(s || '').trim().replace(/[?#].*$/, '');
  const m = t.match(/imagedelivery(?:\.net)?\/[^/]+\/(.+)$/);
  if (!m) return t;
  const parts = m[1].split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : parts[0] || '';
}

// ─── Icons (24px grid, stroked) ────────────────────────────────────
const ICONS = {
  grip: html`<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none" />`,
  up: html`<path d="M12 19V5M6 11l6-6 6 6" />`,
  down: html`<path d="M12 5v14M6 13l6 6 6-6" />`,
  copy: html`<rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />`,
  undo: html`<path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />`,
  redo: html`<path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />`,
  close: html`<path d="M18 6 6 18M6 6l12 12" />`,
  chevron: html`<path d="m6 9 6 6 6-6" />`,
  search: html`<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />`,
  trash: html`<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />`,
  ext: html`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />`,
  plus: html`<path d="M12 5v14M5 12h14" />`,
  check: html`<path d="m5 12 5 5 9-10" />`,
  warn: html`<path d="M12 4 2.5 20h19L12 4z" /><path d="M12 10v4M12 17.5v.01" />`,
  send: html`<path d="M4 12h12M12 6l6 6-6 6" />`,
  image: html`<rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" />`,
  clock: html`<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />`,
  sparkle: html`<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />`,
  play: html`<path d="M8 5.5v13l10.5-6.5z" />`,
};
const Icon = ({ name, size = 16 }) => html`<svg class="afe-ico" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

// ─── Styles (prefixed afe-, injected once) ────────────────────────
// Colors come from the admin's tokens (index.html :root). The few chart colors
// are validated categorical steps, with darker-surface steps for a dark theme.
const CSS = `
.afe-root { --afe-data: #2a78d6; --afe-data-2: #1baf7a; --afe-data-3: #eb6834; --afe-rest: var(--color-border-strong);
  --afe-track: color-mix(in srgb, var(--color-text) 7%, transparent);
  --afe-sel: color-mix(in srgb, var(--color-primary) 12%, var(--color-bg-card));
  --afe-warn-bg: color-mix(in srgb, var(--color-warning) 11%, var(--color-bg-card));
  --afe-warn-line: color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
  --afe-bad-line: color-mix(in srgb, var(--color-danger) 38%, var(--color-border));
  --afe-ph: color-mix(in srgb, var(--color-info) 14%, transparent); }
:root[data-theme="dark"] .afe-root { --afe-data: #3987e5; --afe-data-2: #199e70; --afe-data-3: #d95926; }
.afe-ico { display: block; flex-shrink: 0; }
.afe-tabs { margin-bottom: 1.25rem; }
.afe-tab-count { display: inline-block; margin-left: .4rem; min-width: 1.35rem; padding: 0 .4rem; border-radius: 999px; background: var(--afe-track); color: var(--color-text-secondary); font-size: .72rem; font-weight: 700; line-height: 1.35rem; text-align: center; }
.afe-tab-state { display: inline-block; margin-left: .4rem; padding: 0 .5rem; border-radius: 999px; background: var(--afe-track); color: var(--color-text-secondary); font-size: .72rem; font-weight: 700; line-height: 1.35rem; }
.afe-tab-state.is-open { background: color-mix(in srgb, var(--color-success) 13%, transparent); color: color-mix(in srgb, var(--color-success) 85%, var(--color-text)); }
.afe-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex-shrink: 0; padding: 0; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
.afe-icon-btn:hover:not(:disabled) { background: var(--color-bg-hover); border-color: var(--color-border); color: var(--color-text); }
.afe-icon-btn:disabled { opacity: .32; cursor: default; }
.afe-seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-card); box-shadow: var(--shadow-xs); }
.afe-seg > button { height: 30px; min-width: 30px; }
.afe-seg-text > button { padding: 0 .7rem; border: 0; border-radius: 7px; background: transparent; color: var(--color-text-secondary); font: inherit; font-size: .82rem; font-weight: 600; cursor: pointer; }
.afe-seg-text > button[aria-pressed="true"] { background: var(--color-text); color: var(--color-bg-card); }
.afe-link { padding: 0; border: 0; background: none; color: var(--color-text-secondary); font: inherit; font-size: .85rem; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.afe-link:hover { color: var(--color-text); }
.afe-hint { font-size: .8rem; color: var(--color-text-muted); line-height: 1.45; }
.afe-empty { padding: .5rem 0; color: var(--color-text-muted); font-size: .9rem; }
.afe-danger { color: var(--color-danger); }
.afe-note { display: flex; gap: .55rem; align-items: flex-start; padding: .65rem .8rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-secondary); font-size: .85rem; line-height: 1.5; color: var(--color-text-secondary); }
.afe-note.is-warn { border-color: var(--afe-warn-line); background: var(--afe-warn-bg); color: var(--color-text); }
.afe-note .afe-ico { margin-top: .15rem; }
.afe-spin { display: flex; justify-content: center; padding: 2.5rem; }
.afe-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
.afe-card-head h3 { margin: 0 0 .25rem; }
.afe-card-head > div:first-child { flex: 1 1 26rem; min-width: 0; }
.afe-lede { margin: 0; max-width: 62rem; font-size: .9rem; color: var(--color-text-secondary); line-height: 1.5; }
.afe-row-actions { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }

/* Draft bar */
.afe-bar { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; gap: .6rem 1rem; align-items: center; justify-content: space-between; margin-bottom: 1rem; padding: .7rem .8rem .7rem 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); box-shadow: var(--shadow-xs); }
@media (max-width: 1024px) { .afe-bar { top: calc(56px + env(safe-area-inset-top, 0px)); } }
.afe-bar-text { display: grid; gap: .1rem; min-width: 0; flex: 1 1 18rem; }
.afe-bar-text strong { display: flex; align-items: center; gap: .5rem; font-size: .95rem; }
.afe-bar-actions { display: flex; gap: .45rem; flex-wrap: wrap; align-items: center; }
.afe-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--color-success); }
.afe-dot.is-draft { background: var(--color-warning); }
.afe-conflict { display: flex; flex-wrap: wrap; gap: .75rem 1rem; align-items: center; justify-content: space-between; margin-bottom: .75rem; padding: .8rem 1rem; border: 1px solid var(--afe-warn-line); border-radius: var(--radius-md); background: var(--afe-warn-bg); }
.afe-conflict > div:first-child { display: grid; gap: .15rem; min-width: 0; flex: 1 1 20rem; }
.afe-problems { margin-bottom: 1rem; padding: .75rem 1rem; border: 1px solid var(--afe-bad-line); border-radius: var(--radius-md); background: var(--color-danger-bg); }
.afe-problems ul { margin: .35rem 0 0 1.1rem; }
.afe-problems li { margin: .2rem 0; font-size: .9rem; }
.afe-problems button { padding: 0; border: 0; background: none; color: var(--color-info); font: inherit; text-decoration: underline; cursor: pointer; }

/* Form editor layout */
.afe-cols { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(320px, 1fr); gap: 1rem; align-items: start; }
.afe-cols.has-preview { grid-template-columns: minmax(280px, 1fr) minmax(300px, 1fr) 380px; }
@media (max-width: 1100px) { .afe-cols, .afe-cols.has-preview { grid-template-columns: 1fr; } }
.afe-col { display: grid; gap: .75rem; min-width: 0; container-type: inline-size; align-self: stretch; align-content: start; }
.afe-col > *, .afe-rows, .afe-row { min-width: 0; }
.afe-panel { min-width: 0; padding: .8rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
.afe-pages { display: grid; gap: .75rem; }
.afe-inspector { position: sticky; top: 76px; max-height: calc(100vh - 96px); overflow: auto; overscroll-behavior: contain; padding: 1rem; }
@media (max-width: 1100px) { .afe-inspector { position: static; max-height: none; } }
.afe-inspector, .afe-row, .afe-page { scroll-margin-top: 90px; }
@media (max-width: 1024px) { .afe-inspector, .afe-row, .afe-page { scroll-margin-top: calc(56px + 96px + env(safe-area-inset-top, 0px)); } }
@media (max-width: 768px) { .afe-inspector, .afe-row, .afe-page { scroll-margin-top: calc(56px + 140px + env(safe-area-inset-top, 0px)); } }
.afe-back { display: none; align-items: center; gap: .3rem; margin-bottom: .75rem; }
@media (max-width: 1100px) { .afe-back { display: inline-flex; } }
.afe-page-head { display: flex; align-items: center; gap: .25rem; margin: -.15rem 0 .5rem; }
.afe-page-head .afe-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: .45rem; padding: .3rem .4rem; border: 0; border-radius: 8px; background: none; color: var(--color-text); font: inherit; font-weight: 700; font-size: 1rem; text-align: left; cursor: pointer; }
.afe-title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afe-page-head .afe-title:hover { background: var(--color-bg-hover); }
.afe-page-head .afe-title.is-sel { background: var(--afe-sel); }
.afe-page-head .afe-title.is-sel .afe-num { color: var(--color-primary-ink); }
.afe-num { flex-shrink: 0; color: var(--color-text-muted); font-weight: 600; font-size: .78rem; }
.afe-grip { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 30px; flex-shrink: 0; color: var(--color-text-muted); opacity: .55; cursor: grab; touch-action: none; border-radius: 6px; }
.afe-grip:hover { opacity: 1; background: var(--color-bg-hover); }
.afe-collapse { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 30px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--color-text-muted); cursor: pointer; }
.afe-collapse:hover { background: var(--color-bg-hover); color: var(--color-text); }
.afe-collapse[aria-expanded="false"] .afe-ico { transform: rotate(-90deg); }
.afe-rows { display: grid; gap: .3rem; min-height: 2.25rem; }
.afe-rows-empty { padding: .6rem; border: 1px dashed var(--color-border-strong); border-radius: 10px; color: var(--color-text-muted); font-size: .85rem; text-align: center; }
.afe-row { position: relative; display: flex; align-items: center; gap: .35rem .5rem; width: 100%; padding: .35rem .45rem .35rem .2rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-secondary); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.afe-row:hover { border-color: var(--color-border-strong); }
.afe-row.is-sel { border-color: var(--color-primary); background: var(--afe-sel); box-shadow: 0 0 0 2px var(--color-primary-ring); }
.afe-row.has-problem { border-color: var(--afe-bad-line); }
.afe-row:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.afe-row-main { all: unset; box-sizing: border-box; display: flex; flex: 1 1 auto; min-width: 0; align-items: center; gap: .35rem .5rem; align-self: stretch; cursor: pointer; border-radius: 8px; }
.afe-row:has(.afe-row-main:focus-visible) { box-shadow: var(--focus-ring-strong); }
.afe-type { flex-shrink: 0; width: 5.9rem; color: var(--color-text-muted); font-size: .68rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afe-row-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .9rem; }
.afe-row-badges { display: flex; gap: .25rem; flex-shrink: 0; }
@container (max-width: 400px) { .afe-type { display: none; } .afe-row-badges .badge-gray { display: none; } }
.afe-mini { display: flex; gap: .15rem; flex-shrink: 0; }
.afe-mini button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid var(--color-border); border-radius: 7px; background: var(--color-bg-card); color: var(--color-text-secondary); cursor: pointer; }
.afe-mini button:hover:not(:disabled) { color: var(--color-text); border-color: var(--color-border-strong); }
.afe-mini button:disabled { opacity: .3; cursor: default; }
@media (hover: hover) {
  .afe-row .afe-mini { position: absolute; right: .3rem; top: 50%; transform: translateY(-50%); padding-left: .6rem; opacity: 0; pointer-events: none; background: linear-gradient(90deg, transparent, var(--color-bg-secondary) .6rem); transition: opacity .12s; }
  .afe-row.is-sel .afe-mini { background: linear-gradient(90deg, transparent, var(--afe-sel) .6rem); }
  .afe-row:hover .afe-mini, .afe-row:focus-within .afe-mini { opacity: 1; pointer-events: auto; }
  .afe-page-head .afe-mini { opacity: 0; transition: opacity .12s; }
  .afe-page:hover .afe-page-head .afe-mini, .afe-page-head:focus-within .afe-mini { opacity: 1; }
}
.afe-ghost { opacity: .35; }
.afe-chosen { box-shadow: var(--shadow-md) !important; }
.sortable-fallback { opacity: .95 !important; box-shadow: var(--shadow-lg) !important; }
.afe-add { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; margin-top: .5rem; }
.afe-add select { width: auto; max-width: 240px; }
.afe-folded { margin: 0; padding: 0 .4rem; font-size: .82rem; color: var(--color-text-muted); }

/* Inspector */
.afe-insp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .5rem; margin-bottom: .85rem; }
.afe-insp-head h3 { margin: 0; font-size: 1.05rem; }
.afe-crumb { display: block; margin-bottom: .15rem; color: var(--color-text-muted); font-size: .78rem; }
.afe-sec { margin: 1rem -.15rem 0; padding: 1rem .15rem 0; border-top: 1px solid var(--color-border); }
.afe-sec-title { display: block; margin-bottom: .6rem; color: var(--color-text-muted); font-size: .72rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.afe-field { display: grid; gap: .3rem; margin-bottom: .85rem; }
.afe-field > label, .afe-field > .afe-label { font-weight: 600; font-size: .85rem; }
.afe-lock { margin-bottom: .85rem; padding: .55rem .7rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-primary-bg); font-size: .85rem; }
.afe-choices { display: grid; gap: .4rem; margin-bottom: .4rem; }
.afe-choice { display: grid; grid-template-columns: auto 1fr auto; gap: .35rem; align-items: start; padding: .45rem .45rem .45rem .2rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-card); }
.afe-choice > .afe-grip { margin-top: .3rem; }
.afe-choice-main { display: grid; gap: .3rem; min-width: 0; }
.afe-choice .afe-mini { flex-direction: column; }
.afe-check { display: flex; align-items: center; gap: .5rem; font-size: .9rem; cursor: pointer; }
.afe-check input { width: 18px; height: 18px; }
.afe-pair { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.afe-pair label { display: grid; gap: .25rem; font-size: .82rem; font-weight: 600; }
.afe-sum { margin: .1rem 0 0; font-size: .85rem; color: var(--color-text-secondary); }
.afe-bad { color: var(--color-danger); font-size: .82rem; }

/* Rule builder */
.afe-rule { display: grid; gap: .5rem; }
.afe-rule-head { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; font-size: .88rem; font-weight: 600; }
.afe-rule-head select { width: auto; padding: .2rem 1.8rem .2rem .5rem; min-height: 32px; }
.afe-cond { display: grid; grid-template-columns: 1fr auto; gap: .4rem; padding: .55rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-secondary); }
.afe-cond > select { grid-column: 1; min-width: 0; }
.afe-cond > .afe-icon-btn { grid-column: 2; grid-row: 1; }
.afe-cond-is { grid-column: 1 / -1; font-size: .78rem; color: var(--color-text-muted); }
.afe-cond-vals { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: .3rem; }
.afe-tog { min-height: 30px; max-width: 100%; padding: .2rem .65rem; border: 1px solid var(--color-border-strong); border-radius: 999px; background: var(--color-bg-card); color: var(--color-text-secondary); font: inherit; font-size: .82rem; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; }
.afe-tog[aria-pressed="true"] { border-color: var(--color-text); background: var(--color-text); color: var(--color-bg-card); }
.afe-rule-foot { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
.afe-rule-sum { margin: 0; padding: .5rem .65rem; border-radius: 8px; background: var(--afe-track); font-size: .85rem; line-height: 1.45; }

/* JobTread */
.afe-jt { display: grid; gap: .5rem; padding: .7rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-secondary); }
.afe-jt-name { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; font-weight: 600; }
.afe-jt-list { display: grid; gap: 1rem; max-height: min(55vh, 460px); overflow: auto; margin: .75rem -.25rem 0; padding: 0 .25rem; }
.afe-jt-list h4 { margin: 0 0 .35rem; color: var(--color-text-muted); font-size: .72rem; letter-spacing: .05em; text-transform: uppercase; }
.afe-jt-item { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: .75rem; min-height: 44px; padding: .45rem .65rem; border: 1px solid transparent; border-radius: 9px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.afe-jt-item:hover, .afe-jt-item.is-active { background: var(--color-bg-hover); border-color: var(--color-border); }
.afe-jt-item.is-current { box-shadow: inset 0 0 0 1px var(--color-primary); background: var(--afe-sel); }
.afe-jt-item small { display: block; color: var(--color-text-muted); font-size: .78rem; }

/* Image picker */
.afe-drop { display: grid; place-items: center; gap: .4rem; padding: 1.1rem; border: 1.5px dashed var(--color-border-strong); border-radius: 12px; background: var(--color-bg-secondary); color: var(--color-text-secondary); text-align: center; font-size: .88rem; }
.afe-drop.is-over { border-color: var(--color-text); background: var(--afe-sel); }
.afe-thumb { display: block; width: 100%; height: auto; max-height: 260px; object-fit: contain; border: 1px solid var(--color-border); border-radius: 10px; background: var(--afe-track); }

/* Live preview */
.afe-preview { position: sticky; top: 76px; display: grid; gap: .5rem; }
.afe-preview-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.afe-preview-head strong { font-size: .9rem; }
.afe-phone { padding: 10px; border: 1px solid var(--color-border-strong); border-radius: 30px; background: var(--color-bg-card); box-shadow: var(--shadow-md); }
.afe-phone iframe { display: block; width: 100%; height: calc(100vh - 210px); min-height: 520px; border: 0; border-radius: 22px; background: #fff; }
@media (max-width: 1100px) { .afe-preview { position: static; } .afe-phone { max-width: 400px; } }

/* Dialogs (above the admin header) */
.afe-overlay { z-index: 1200; }
.afe-dialog { max-width: 560px; padding: 1.25rem 1.35rem 1.15rem; max-height: calc(100dvh - 2rem); display: flex; flex-direction: column; }
.afe-dialog.is-wide { max-width: 720px; }
.afe-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; margin-bottom: .5rem; }
.afe-dialog-head h3 { margin: .15rem 0 0; }
.afe-dialog-body { overflow: auto; min-height: 0; margin: 0 -.25rem; padding: 0 .25rem; }
.afe-dialog .afe-dialog-body p { margin-bottom: .85rem; }
.afe-dialog-foot { margin-top: 1rem; padding-top: .9rem; border-top: 1px solid var(--color-border); align-items: center; }
.afe-dialog-foot .afe-hint { flex: 1; margin-right: auto; }
.afe-diff { display: grid; gap: 1rem; }
.afe-diff h4 { display: flex; align-items: center; gap: .4rem; margin: 0 0 .35rem; font-size: .78rem; letter-spacing: .05em; text-transform: uppercase; color: var(--color-text-muted); }
.afe-diff ul { list-style: none; display: grid; gap: .3rem; }
.afe-diff li { display: grid; grid-template-columns: 5.2rem 1fr; gap: .5rem; align-items: baseline; font-size: .88rem; line-height: 1.45; }
.afe-kind { justify-self: start; padding: .05rem .45rem; border-radius: 999px; font-size: .7rem; font-weight: 700; background: var(--afe-track); color: var(--color-text-secondary); }
.afe-kind.is-added { background: color-mix(in srgb, var(--color-success) 14%, transparent); color: var(--color-success); }
.afe-kind.is-removed { background: color-mix(in srgb, var(--color-text) 10%, transparent); color: var(--color-text); }
.afe-kind.is-moved { background: color-mix(in srgb, var(--color-info) 12%, transparent); color: var(--color-info); }

/* Lists: submissions and history */
.afe-toolbar { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin: 1rem 0 .75rem; }
.afe-search { position: relative; flex: 1 1 240px; max-width: 360px; }
.afe-search .afe-ico { position: absolute; left: .7rem; top: 50%; transform: translateY(-50%); color: var(--color-text-muted); pointer-events: none; }
.afe-search input { padding-left: 2.1rem; }
.afe-search kbd { position: absolute; right: .55rem; top: 50%; transform: translateY(-50%); padding: 0 .35rem; border: 1px solid var(--color-border); border-radius: 5px; color: var(--color-text-muted); font: inherit; font-size: .72rem; pointer-events: none; }
.afe-chipbar { display: flex; flex-wrap: wrap; gap: .3rem; }
.afe-chip { min-height: 32px; padding: .2rem .7rem; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-bg-card); color: var(--color-text-secondary); font: inherit; font-size: .84rem; font-weight: 600; cursor: pointer; white-space: nowrap; }
.afe-chip:hover { border-color: var(--color-border-strong); color: var(--color-text); }
.afe-chip[aria-pressed="true"] { border-color: var(--color-text); background: var(--color-text); color: var(--color-bg-card); }
.afe-chip .afe-chip-n { margin-left: .3rem; font-weight: 500; }
.afe-checks { display: flex; gap: .3rem; flex-wrap: wrap; margin-top: .5rem; }
.afe-detail { margin-top: .75rem; padding-top: .75rem; border-top: 1px solid var(--color-border); display: grid; gap: .6rem; }
.afe-detail dl { margin: .35rem 0 .35rem .75rem; }
.afe-detail dt { margin-top: .45rem; color: var(--color-text-muted); font-size: .82rem; }
.afe-detail dd { margin: 0; white-space: pre-wrap; }
.afe-pager { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; margin-top: .9rem; font-size: .88rem; color: var(--color-text-secondary); }
.afe-danger-zone { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; justify-content: space-between; margin-top: .4rem; padding-top: .7rem; border-top: 1px dashed var(--color-border); }
.btn.afe-btn-danger { color: var(--color-danger); }
.btn.afe-btn-danger:hover:not(:disabled) { border-color: var(--afe-bad-line); background: var(--color-danger-bg); }

/* Insights */
.afe-ins { display: grid; gap: 1rem; }
.afe-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .75rem; }
@media (max-width: 900px) { .afe-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.afe-tile { padding: .9rem 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
.afe-tile span { display: block; color: var(--color-text-secondary); font-size: .82rem; font-weight: 600; }
.afe-tile strong { display: block; margin: .25rem 0 .1rem; font-size: 1.85rem; font-weight: 700; letter-spacing: -.02em; line-height: 1.1; color: var(--color-text); }
.afe-tile small { color: var(--color-text-muted); font-size: .78rem; }
.afe-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; align-items: start; }
@media (max-width: 900px) { .afe-grid2 { grid-template-columns: 1fr; } }
.afe-viz { padding: 1rem 1.1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); min-width: 0; }
.afe-viz h4 { margin: 0; font-size: .95rem; }
.afe-viz > .afe-hint { display: block; margin: .15rem 0 .85rem; }
.afe-stack { display: flex; gap: 2px; height: 14px; margin: .2rem 0 .8rem; }
.afe-stack > span { min-width: 2px; height: 100%; }
.afe-stack > span:first-child { border-radius: 4px 0 0 4px; }
.afe-stack > span:last-child { border-radius: 0 4px 4px 0; }
.afe-stack > span:only-child { border-radius: 4px; }
.afe-legend { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .5rem 1rem; }
.afe-legend div { display: grid; grid-template-columns: 10px 1fr; gap: .1rem .5rem; align-items: start; align-content: start; font-size: .85rem; }
.afe-legend i { width: 10px; height: 10px; margin-top: .3rem; border-radius: 3px; }
.afe-legend b { grid-column: 2; font-size: 1.05rem; font-variant-numeric: tabular-nums; }
.afe-legend small { grid-column: 2; color: var(--color-text-muted); font-size: .78rem; }
.afe-hbars { display: grid; gap: .55rem; }
.afe-hbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .2rem .75rem; align-items: baseline; }
.afe-hbar-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .86rem; }
.afe-hbar-label em { margin-right: .35rem; color: var(--color-text-muted); font-style: normal; font-size: .78rem; }
.afe-hbar-val { font-size: .86rem; font-variant-numeric: tabular-nums; color: var(--color-text-secondary); text-align: right; }
.afe-hbar-val b { color: var(--color-text); }
.afe-hbar-track { grid-column: 1 / -1; height: 10px; border-radius: 4px; background: var(--afe-track); overflow: hidden; }
.afe-hbar-track > span { display: block; height: 100%; border-radius: 0 4px 4px 0; background: color-mix(in srgb, var(--afe-data) 55%, var(--color-bg-card)); }
.afe-hbar.is-top .afe-hbar-track > span { background: var(--afe-data); }
.afe-tag { margin-left: .4rem; padding: .02rem .45rem; border-radius: 999px; background: var(--afe-track); color: var(--color-text-secondary); font-size: .7rem; font-weight: 700; }
.afe-chart { position: relative; }
.afe-chart svg { display: block; overflow: visible; }
.afe-chart .afe-axis { fill: var(--color-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.afe-chart .afe-grid { stroke: var(--color-border); stroke-width: 1; shape-rendering: crispEdges; }
.afe-chart .afe-colbar { fill: var(--afe-data); }
.afe-chart .afe-colbar.is-dim { fill: color-mix(in srgb, var(--afe-data) 45%, var(--color-bg-card)); }
.afe-tip { position: absolute; z-index: 5; transform: translate(-50%, -100%); padding: .35rem .55rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-card); box-shadow: var(--shadow-md); font-size: .8rem; white-space: nowrap; pointer-events: none; }
.afe-tip b { display: block; font-size: .95rem; }
.afe-stat-pair { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
.afe-stat-pair div { padding: .6rem .7rem; border-radius: 10px; background: var(--color-bg-secondary); }
.afe-stat-pair b { display: block; font-size: 1.35rem; }
.afe-stat-pair span { font-size: .8rem; color: var(--color-text-muted); }
.afe-checklist { display: grid; gap: .1rem; }
.afe-checklist div { display: flex; align-items: center; justify-content: space-between; gap: .75rem; min-height: 44px; padding: .25rem 0; border-bottom: 1px solid var(--color-border); font-size: .9rem; }
.afe-checklist div:last-child { border-bottom: 0; }
.afe-table { width: 100%; border-collapse: collapse; margin-top: .5rem; font-size: .85rem; }
.afe-table th, .afe-table td { padding: .3rem .4rem; border-bottom: 1px solid var(--color-border); text-align: left; }
.afe-table td:last-child, .afe-table th:last-child { text-align: right; }

/* Spanish */
.afe-meter { height: 8px; margin: .5rem 0 .25rem; border-radius: 4px; background: var(--afe-track); overflow: hidden; }
.afe-meter > span { display: block; height: 100%; border-radius: 4px; background: var(--color-success); }
.afe-tr-group { margin-top: 1.25rem; }
.afe-tr-group > h4 { margin: 0 0 .5rem; font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; color: var(--color-text-muted); }
.afe-tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: .4rem 1rem; padding: .75rem 0; border-top: 1px solid var(--color-border); }
.afe-tr-where { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; font-size: .82rem; color: var(--color-text-secondary); }
.afe-tr-where b { color: var(--color-text); font-weight: 600; }
.afe-tr-en { align-self: start; padding: .5rem .65rem; border-radius: 8px; background: var(--color-bg-secondary); font-size: .88rem; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.afe-tr-en.is-html { white-space: normal; }
.afe-tr-en.is-html p, .afe-tr-en.is-html ul { margin: 0 0 .4rem; }
.afe-tr-en.is-html ul { padding-left: 1.1rem; }
.afe-tr-es { display: grid; gap: .3rem; align-content: start; min-width: 0; }
.afe-tr-es textarea { min-height: 2.6rem; field-sizing: content; max-height: 22rem; line-height: 1.5; resize: vertical; }
.afe-ph { padding: 0 .15rem; border-radius: 4px; background: var(--afe-ph); color: color-mix(in srgb, var(--color-info) 72%, #000); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
.afe-ph.is-missing { background: var(--afe-warn-bg); color: var(--color-text); box-shadow: inset 0 0 0 1px var(--afe-warn-line); }
.afe-progress { display: grid; gap: .35rem; margin-top: .75rem; }
@media (max-width: 768px) { .afe-tr { grid-template-columns: 1fr; } }

/* Emails */
.afe-chips { display: flex; gap: .35rem; flex-wrap: wrap; align-items: center; }
.afe-chips button { min-height: 28px; padding: .1rem .6rem; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-bg-card); color: var(--color-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; cursor: pointer; }
.afe-chips button:hover { border-color: var(--color-border-strong); }
.afe-days { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; }
.afe-day { display: inline-flex; align-items: center; gap: .15rem; padding: .1rem .15rem .1rem .65rem; border: 1px solid var(--color-border-strong); border-radius: 999px; background: var(--color-bg-card); font-size: .85rem; font-weight: 600; }
.afe-day .afe-icon-btn { width: 26px; height: 26px; }
.afe-email { overflow: hidden; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-bg-card); }
.afe-email-head { display: grid; gap: .15rem; padding: .65rem .85rem; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); font-size: .85rem; }
.afe-email-head b { font-size: .95rem; }
.afe-email-body { padding: .85rem; font-size: .92rem; line-height: 1.6; white-space: pre-wrap; }
.afe-email-bar { height: 8px; margin: .25rem 0 .75rem; border-radius: 4px; background: var(--afe-track); overflow: hidden; }
.afe-email-bar span { display: block; height: 100%; width: 60%; background: var(--color-primary); }
.afe-email-btn { display: inline-block; padding: .55rem 1.2rem; border-radius: 999px; background: var(--color-primary); color: #1A1B1F; font-weight: 700; white-space: normal; }
.afe-switch { display: inline-flex; align-items: center; gap: .55rem; font-weight: 600; cursor: pointer; }
.afe-switch input { appearance: none; position: relative; width: 38px; height: 22px; margin: 0; border-radius: 999px; background: var(--color-border-strong); cursor: pointer; transition: background .15s; }
.afe-switch input::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--color-bg-card); box-shadow: var(--shadow-xs); transition: transform .15s; }
.afe-switch input:checked { background: var(--color-success); }
.afe-switch input:checked::after { transform: translateX(16px); }
.afe-switch input:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
/* Settings: open and closed + the other cards on the left, what families see + history on the right */
.afe-set { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); gap: 1.25rem; align-items: start; }
@media (max-width: 1100px) { .afe-set { grid-template-columns: minmax(0, 1fr); } }
.afe-set-main, .afe-set-side { display: grid; gap: 1.25rem; min-width: 0; }
.afe-set .card { margin: 0; }
.afe-set h4 { margin: 0; font-size: .98rem; }
.afe-set-fields { display: grid; gap: .1rem; margin-top: 1.1rem; max-width: 40rem; }
.afe-set-fields select { max-width: 12rem; }
.afe-opt { margin-left: .3rem; font-weight: 500; color: var(--color-text-muted); font-size: .78rem; }
.afe-label { font-weight: 600; font-size: .85rem; }
.afe-when { display: flex; gap: .5rem; align-items: center; }
.afe-when .form-input { min-width: 0; flex: 1; }
.afe-root [aria-invalid="true"] { border-color: var(--color-danger); }
.afe-status-row { display: flex; gap: .9rem 1rem; align-items: flex-start; flex-wrap: wrap; }
.afe-status-dot { position: absolute; left: 0; top: .55rem; width: 14px; height: 14px; border-radius: 50%; background: var(--color-border-strong); }
.afe-avail.is-open .afe-status-dot { background: var(--color-success); box-shadow: 0 0 0 5px color-mix(in srgb, var(--color-success) 18%, transparent); }
.afe-status-text { position: relative; flex: 1 1 18rem; min-width: 0; padding-left: 1.75rem; }
.afe-status-text h3 { margin: 0 0 .25rem; font-size: 1.4rem; letter-spacing: -.01em; }
.afe-status-text p { margin: 0; color: var(--color-text-secondary); font-size: .92rem; line-height: 1.5; }
.afe-status-text .afe-status-next { display: flex; gap: .45rem; align-items: flex-start; margin-top: .6rem; color: var(--color-text); font-weight: 600; }
.afe-status-next .afe-ico { margin-top: .2rem; }
.afe-status-btn { flex-shrink: 0; }
/* Open and closed, one card: where things stand on top, then bands of setting rows */
.afe-avail { padding: 0; }
.afe-avail.is-open { border-color: color-mix(in srgb, var(--color-success) 35%, var(--color-border)); }
.afe-avail .afe-status { padding: 1.4rem 1.5rem 1.25rem; }
.afe-avail.is-open .afe-status { background: color-mix(in srgb, var(--color-success) 4%, var(--color-bg-card)); }
.afe-reach { margin: 1rem 0 0; font-size: .84rem; line-height: 1.55; color: var(--color-text-secondary); }
.afe-reach .afe-live { display: inline-block; margin: 0 .45rem 1px 0; vertical-align: middle; }
.afe-reach a { color: inherit; text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
.afe-band { padding: 1.25rem 1.5rem 1.4rem; border-top: 1px solid var(--color-border); }
.afe-band > h4 { margin: 0; font-size: 1rem; }
.afe-band > .afe-lede { margin-top: .2rem; max-width: 46rem; font-size: .86rem; }
.afe-rows { margin-top: .35rem; }
.afe-srow { display: grid; grid-template-columns: minmax(0, 18rem) minmax(0, 1fr); gap: .45rem 2rem; padding: 1rem 0; }
.afe-srow + .afe-srow { border-top: 1px solid color-mix(in srgb, var(--color-border) 65%, transparent); }
.afe-srow:last-child { padding-bottom: 0; }
.afe-srow-l { display: grid; gap: .25rem; align-content: start; min-width: 0; }
.afe-srow-l > label { font-weight: 600; font-size: .9rem; }
.afe-srow-c { display: grid; gap: .35rem; align-content: start; min-width: 0; max-width: 34rem; }
.afe-srow-c select.form-input { max-width: 10rem; }
.afe-srow-c > .afe-note { margin: .3rem 0 0; }
.afe-way .afe-switch { align-items: flex-start; font-size: .9rem; line-height: 1.35; min-height: 24px; }
.afe-way .afe-switch input { flex: none; margin-top: -1px; }
.afe-way .afe-srow-l > .afe-hint { padding-left: calc(38px + .55rem); }
.afe-switch:has(input:disabled) { cursor: default; color: var(--color-text-muted); }
.afe-after { margin: 1rem 0 0; }
@media (pointer: coarse), (max-width: 768px) { .afe-switch { min-height: 44px; } .afe-way .afe-switch { min-height: 44px; align-items: center; } .afe-way .afe-switch input { margin-top: 0; } }
.afe-switch input:disabled { opacity: .45; cursor: not-allowed; }
.afe-way-off { margin: 0; padding-top: .15rem; color: var(--color-text-muted); }
.afe-srow-c .afe-when .form-input { max-width: 16rem; }
.afe-limit-fields { align-items: start; gap: .9rem; }
.afe-limit-fields .afe-field { margin-bottom: 0; }
.afe-limit-fields .form-input { max-width: 9rem; }
@media (max-width: 768px) { .afe-avail .afe-status, .afe-band { padding-left: 1rem; padding-right: 1rem; } }
@media (max-width: 720px) { .afe-srow { grid-template-columns: minmax(0, 1fr); gap: .55rem; } .afe-srow-c { max-width: none; } }
@media (max-width: 480px) { .afe-limit-fields { grid-template-columns: minmax(0, 1fr); } }
/* The application limit: how full the season is, the heads-up mark, and what's next */
.afe-cap { max-width: 40rem; margin-top: 1rem; padding: .9rem 1rem; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-bg-secondary); }
.afe-cap-nums { display: flex; flex-wrap: wrap; align-items: baseline; gap: .2rem .55rem; font-size: .92rem; color: var(--color-text-secondary); }
.afe-cap-nums b { font-size: 1.5rem; line-height: 1.1; color: var(--color-text); font-variant-numeric: tabular-nums; }
.afe-cap-bar { position: relative; height: 10px; margin: .75rem 0 .55rem; border-radius: 99px; background: var(--afe-track); }
.afe-cap-bar > span { position: absolute; top: 0; bottom: 0; left: 0; max-width: 100%; border-radius: 99px; background: var(--afe-data); }
.afe-cap-bar.is-near > span { background: var(--color-warning); }
.afe-cap-bar.is-full > span { background: var(--color-text-muted); }
.afe-cap-bar > i { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--color-text); opacity: .5; }
.afe-cap-meta { display: flex; flex-wrap: wrap; gap: .25rem 1rem; font-size: .82rem; line-height: 1.45; color: var(--color-text-secondary); }
.afe-cap-meta .afe-cap-mark { display: inline-flex; align-items: center; gap: .35rem; }
.afe-cap-meta .afe-cap-mark::before { content: ''; width: 2px; height: 12px; border-radius: 1px; background: var(--color-text); opacity: .5; }
.afe-cap-raise { display: grid; gap: .3rem; margin-top: 1rem; }
.afe-status-text .afe-status-next a { color: inherit; font-weight: 500; text-decoration: underline; text-underline-offset: 2px; }
.afe-cap-raise .form-input { max-width: 10rem; }
.afe-live { width: 8px; height: 8px; margin-right: .2rem; border-radius: 50%; background: var(--color-border-strong); flex-shrink: 0; }
.afe-live.is-on { background: var(--color-success); }
.afe-live.is-wait { background: var(--color-warning); }
.afe-effects { margin: 0; padding-left: 1.1rem; display: grid; gap: .55rem; line-height: 1.5; }
.afe-effects q { font-style: italic; }
.afe-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; word-break: break-all; }
.afe-fam-head { display: flex; justify-content: space-between; align-items: center; gap: .75rem; margin-bottom: .35rem; }
.afe-fam-banner { display: grid; gap: .8rem; padding: 1rem; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-bg-secondary); }
.afe-fam-banner.is-open { border-color: color-mix(in srgb, var(--color-success) 25%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 6%, var(--color-bg-card)); }
.afe-fam-top { display: flex; gap: .7rem; align-items: flex-start; }
.afe-fam-top b { display: block; font-size: .92rem; line-height: 1.35; }
.afe-fam-top span { display: block; margin-top: .2rem; font-size: .82rem; line-height: 1.45; color: var(--color-text-secondary); }
.afe-fam-dot { width: 10px; height: 10px; margin-top: .3rem; border-radius: 50%; background: var(--color-text-muted); opacity: .35; flex-shrink: 0; }
.afe-fam-banner.is-open .afe-fam-dot { background: var(--color-success); opacity: 1; box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-success) 20%, transparent); }
.afe-fam-btn { justify-self: start; padding: .5rem 1rem; border-radius: 999px; background: var(--color-primary); color: #1A1B1F; font-size: .82rem; font-weight: 700; white-space: nowrap; }
.afe-fam-to { margin-top: -.45rem; font-size: .75rem; color: var(--color-text-muted); word-break: break-all; }
.afe-fam-notify { display: flex; gap: .4rem; }
.afe-fam-input { flex: 1; min-width: 0; padding: .5rem .8rem; border: 1.5px solid var(--color-border); border-radius: 999px; background: var(--color-bg-card); color: var(--color-text-muted); font-size: .8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.afe-log { list-style: none; margin: .75rem 0 0; padding: 0; display: grid; gap: .1rem; }
.afe-log li { display: grid; gap: .1rem; padding: .55rem 0; border-top: 1px solid var(--color-border); font-size: .88rem; }
.afe-log li:first-child { border-top: 0; padding-top: 0; }
@media (max-width: 600px) {
  .afe-status-btn { width: 100%; justify-content: center; }
  .afe-status-text h3 { font-size: 1.2rem; }
}
.afe-hist { display: grid; gap: .5rem; }
.afe-hist > div { display: flex; justify-content: space-between; align-items: center; gap: .75rem; flex-wrap: wrap; padding: .65rem .85rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-card); }

/* Tab headers and the tab row */
.afe-head { margin-bottom: 1rem; }
.afe-head .page-sub a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.afe-head-actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.afe-sample-btn { display: inline-flex; align-items: center; gap: .4rem; white-space: nowrap; }
.afe-tab-dot { display: inline-block; width: 7px; height: 7px; margin-left: .4rem; border-radius: 50%; background: var(--color-warning); vertical-align: middle; }
.afe-ins > .afe-head { margin-bottom: 0; }

/* The Form's views ride at the start of the draft bar */
.afe-bar-lead { flex: none; display: flex; }
.afe-bar.has-lead .afe-bar-text { padding-left: .9rem; border-left: 1px solid var(--color-border); }
.afe-subnav > button { display: inline-flex; align-items: center; gap: .35rem; }
.afe-subnav .afe-tab-count { margin-left: 0; }
.afe-seg-text > button[aria-pressed="true"] .afe-tab-count { background: rgba(255,255,255,.22); color: inherit; }
.afe-form-foot { margin: .15rem .2rem 0; }
@media (max-width: 768px) { .afe-bar.has-lead .afe-bar-text { padding-left: 0; border-left: 0; flex-basis: 100%; } .afe-bar-lead { width: 100%; } .afe-subnav { width: 100%; } .afe-subnav > button { flex: 1; justify-content: center; } }

/* Applications that haven't reached JobTread, above the Applicants views */
.afe-intake { align-items: center; }
.afe-intake > span { flex: 1; }

/* Submissions */
.afe-subs { display: grid; gap: .75rem; }
.afe-subs > .afe-lede a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.afe-subs-bar { margin: 0; }
.afe-setup { border: 1px solid var(--afe-warn-line); background: var(--afe-warn-bg); border-radius: 10px; padding: .55rem .8rem; font-size: .86rem; }
.afe-setup summary { display: flex; gap: .55rem; align-items: center; cursor: pointer; list-style: none; }
.afe-setup summary::-webkit-details-marker { display: none; }
.afe-setup summary > span:first-of-type { flex: 1; }
.afe-setup ul { margin: .5rem 0 0 1.6rem; display: grid; gap: .25rem; }
.afe-sub-list { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); overflow: hidden; transition: opacity .15s; }
.afe-sub-list.is-loading { opacity: .55; }
.afe-sub { scroll-margin-top: calc(80px + env(safe-area-inset-top, 0px)); }
.afe-sub + .afe-sub { border-top: 1px solid var(--color-border); }
.afe-sub.is-open { background: color-mix(in srgb, var(--color-primary) 4%, var(--color-bg-card)); box-shadow: inset 3px 0 0 var(--color-primary); }
.afe-sub-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: .45rem 1rem; align-items: center; padding: .7rem .9rem; }
.afe-sub-main { min-width: 0; display: grid; gap: .15rem; }
.afe-sub-who { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; }
.afe-sub-name { all: unset; font-weight: 700; font-size: .95rem; color: var(--color-text); border-radius: 4px; }
button.afe-sub-name { cursor: pointer; }
button.afe-sub-name:hover { text-decoration: underline; text-underline-offset: 2px; }
button.afe-sub-name:focus-visible { outline: 2px solid var(--color-text); outline-offset: 2px; }
.afe-sub-meta { font-size: .82rem; color: var(--color-text-muted); }
.afe-sub-state { display: flex; justify-content: flex-end; }
.afe-steps { display: flex; flex-wrap: wrap; gap: .25rem; justify-content: flex-end; }
.afe-sub-actions { flex-wrap: nowrap; }
.afe-sub-note { margin: -.3rem .9rem .7rem; font-size: .84rem; color: var(--color-text-secondary); }
.afe-sub-note.is-bad { color: var(--color-danger); }
.afe-sub .afe-detail { margin: 0 .9rem .9rem; }
.afe-events summary { cursor: pointer; font-weight: 600; font-size: .88rem; }
.afe-events .afe-hint { display: block; margin: .4rem 0; }
.afe-events > div { display: grid; gap: .25rem; }
.afe-events > div > div { display: flex; gap: .6rem; flex-wrap: wrap; }
@media (max-width: 760px) {
  .afe-sub-row { grid-template-columns: minmax(0, 1fr) auto; }
  .afe-sub-state { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
  .afe-steps { justify-content: flex-start; }
  .afe-sub-actions { grid-row: 1; grid-column: 2; }
}

/* Insights: two columns that stack on their own, so cards never leave gaps */
.afe-ins-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; align-items: start; }
.afe-ins-col { display: grid; gap: 1rem; min-width: 0; }
@media (max-width: 900px) { .afe-ins-cols { grid-template-columns: minmax(0, 1fr); } }

/* Emails: the list on the left, the editor and how it reads on the right */
.afe-emails { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 1rem; align-items: start; }
.afe-email-rail { position: sticky; top: 84px; display: grid; gap: 2px; padding: .35rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
.afe-email-rail button { all: unset; box-sizing: border-box; position: relative; display: grid; grid-template-columns: 1.6rem minmax(0, 1fr); gap: .05rem .55rem; align-items: center; padding: .55rem 1.7rem .55rem .55rem; border-radius: 10px; cursor: pointer; }
.afe-email-rail button:hover { background: var(--color-bg-hover); }
.afe-email-rail button:focus-visible { outline: 2px solid var(--color-text); outline-offset: -2px; }
.afe-email-rail button[aria-current="true"] { background: var(--afe-sel); box-shadow: inset 0 0 0 1px var(--color-primary); }
.afe-email-n { grid-row: span 2; width: 1.6rem; height: 1.6rem; border-radius: 50%; display: grid; place-items: center; background: var(--afe-track); color: var(--color-text-secondary); font-size: .74rem; font-weight: 700; }
.afe-email-rail button[aria-current="true"] .afe-email-n { background: var(--color-primary); color: #1A1B1F; }
.afe-email-rail b { display: flex; align-items: center; gap: .35rem; font-size: .9rem; font-weight: 650; }
.afe-email-rail small { font-size: .76rem; color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afe-email-rail .afe-tr-dot { position: absolute; right: .7rem; top: 50%; margin-top: -4px; }
.afe-email-bad { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: var(--color-danger); color: #fff; font-size: .68rem; font-weight: 700; }
.afe-tr-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
.afe-tr-dot.is-done { background: var(--color-success); opacity: .5; }
.afe-tr-dot.is-stale { background: var(--color-info); }
.afe-tr-dot.is-missing { background: var(--color-warning); }
.afe-email-main { min-width: 0; display: grid; gap: .85rem; padding: 1rem 1.1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
.afe-email-top { display: flex; justify-content: space-between; gap: .75rem 1rem; align-items: flex-start; flex-wrap: wrap; }
.afe-email-top h3 { margin: 0 0 .2rem; font-size: 1.1rem; }
.afe-email-top .afe-hint { margin: 0; max-width: 46rem; }
.afe-email-top .afe-seg-text > button { display: inline-flex; align-items: center; gap: .35rem; }
.afe-email-work { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.1rem; align-items: start; }
.afe-email-ed { display: grid; gap: .55rem; min-width: 0; align-content: start; }
.afe-email-ed .afe-tr-en .afe-sec-title { margin-bottom: .3rem; }
.afe-email-text { min-height: 280px; font-family: inherit; line-height: 1.55; resize: vertical; }
.afe-email-prev { position: sticky; top: 84px; display: grid; gap: .45rem; min-width: 0; }
.afe-email-body.is-rich { white-space: normal; }
.afe-rem-row { display: flex; align-items: center; gap: .75rem; }
@media (max-width: 1280px) { .afe-email-work { grid-template-columns: minmax(0, 1fr); } .afe-email-prev { position: static; } }
@media (max-width: 1024px) { .afe-email-rail { top: calc(56px + 84px + env(safe-area-inset-top, 0px)); } }
@media (max-width: 900px) {
  .afe-emails { grid-template-columns: minmax(0, 1fr); }
  .afe-email-rail { position: static; display: flex; overflow-x: auto; scrollbar-width: none; scroll-padding-inline: 1.5rem; mask-image: linear-gradient(90deg, #000 calc(100% - 2rem), transparent); -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 2rem), transparent); }
  .afe-email-rail::-webkit-scrollbar { display: none; }
  .afe-email-rail button { flex: none; grid-template-columns: auto auto; }
  .afe-email-rail small { display: none; }
  .afe-email-n { grid-row: auto; }
  .afe-email-main { padding: .85rem; }
  .afe-email-text { min-height: 200px; }
}

/* Settings */
.afe-settings h3 { margin: 0 0 .2rem; font-size: 1.05rem; }
.afe-savebar { position: sticky; bottom: calc(.75rem + env(safe-area-inset-bottom, 0px)); z-index: 40; display: flex; flex-wrap: wrap; gap: .6rem 1rem; align-items: center; justify-content: space-between; margin-top: 1.25rem; padding: .75rem .9rem .75rem 1.1rem; border: 1px solid var(--color-border-strong); border-radius: 14px; background: var(--color-bg-card); box-shadow: var(--shadow-lg); animation: afe-rise .18s ease-out; }
.afe-savebar-text { display: grid; gap: .1rem; min-width: 0; flex: 1 1 18rem; }
@keyframes afe-rise { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .afe-savebar { animation: none; } }
.afe-chipfield { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; min-height: 42px; padding: .3rem .4rem; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-bg-card); box-shadow: var(--shadow-xs); cursor: text; }
.afe-chipfield:focus-within { border-color: #E0B800; box-shadow: var(--focus-ring); }
.afe-chipfield.is-invalid { border-color: var(--color-danger); }
.afe-chipfield input { flex: 1 1 12rem; min-width: 8rem; min-height: 30px; border: 0; outline: 0; background: none; font: inherit; font-size: .92rem; padding: .2rem .3rem; color: var(--color-text); }
.afe-addr { display: inline-flex; align-items: center; gap: .15rem; padding: .15rem .2rem .15rem .6rem; border-radius: 999px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); font-size: .86rem; font-weight: 600; max-width: 100%; overflow-wrap: anywhere; }
.afe-addr.is-bad { background: var(--color-danger-bg); border-color: var(--afe-bad-line); color: var(--color-danger); }
.afe-addr button { display: inline-grid; place-items: center; width: 24px; height: 24px; flex: none; border: 0; border-radius: 50%; background: none; color: var(--color-text-muted); cursor: pointer; }
.afe-addr button:hover { background: var(--color-bg-hover); color: var(--color-text); }
.afe-area { display: flex; gap: 1.1rem; align-items: center; margin-top: 1rem; flex-wrap: wrap; }
.afe-area-svg { flex: none; max-width: 100%; height: auto; border: 1px solid var(--color-border); border-radius: 12px; background: #FBF9F3; }
/* The area as families see it: brand yellow, a charcoal line; "close" is the dashed ring */
.afe-area-svg .afe-area-fill { fill: rgba(255, 218, 36, .42); stroke: #373A36; stroke-width: 1.6; stroke-linejoin: round; }
.afe-area-svg .afe-area-ring { fill: none; stroke: #373A36; stroke-width: 1.1; stroke-dasharray: 4 4; opacity: .55; }
.afe-area-svg .afe-area-corner { fill: #fff; stroke: #373A36; stroke-width: 1.3; }
.afe-area-svg .afe-area-pt { stroke: #fff; stroke-width: .9; }
.afe-area-svg .afe-area-pt.is-inside { fill: #373A36; }
.afe-area-svg .afe-area-pt.is-near { fill: #B88A00; }
.afe-area-svg .afe-area-pt.is-far { fill: #8C8D93; }
.afe-area-svg .afe-area-pt.is-moving { stroke: #373A36; stroke-width: 1.6; }
.afe-area-svg.is-empty { display: grid; place-items: center; }
.afe-near { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
.afe-near input[type="range"] { flex: 1 1 12rem; max-width: 22rem; accent-color: #373A36; min-height: 32px; }
.afe-near .form-input { width: 5.2rem; }
.afe-area-rules { display: grid; gap: 1rem; margin-top: 1.1rem; padding-top: 1.1rem; border-top: 1px solid var(--color-border); }
.afe-area-split { display: grid; gap: .35rem; }
.afe-beyond { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem; }
.afe-beyond > button { display: grid; gap: .2rem; text-align: left; padding: .7rem .85rem; border: 1.5px solid var(--color-border); border-radius: 12px; background: var(--color-bg-card); color: var(--color-text); font: inherit; cursor: pointer; }
.afe-beyond > button b { font-size: .9rem; }
.afe-beyond > button span { font-size: .8rem; color: var(--color-text-secondary); line-height: 1.4; }
.afe-beyond > button[aria-checked="true"] { border-color: var(--color-text); box-shadow: inset 0 0 0 .5px var(--color-text); background: #FFFBEA; }
.afe-beyond > button:focus-visible { outline: 2px solid var(--color-text); outline-offset: 2px; }
@media (max-width: 640px) { .afe-beyond { grid-template-columns: minmax(0, 1fr); } }
.afe-outlines { list-style: none; margin: .4rem 0 0; padding: 0; display: grid; gap: .35rem; }
.afe-outlines li { display: flex; align-items: center; gap: .7rem; padding: .35rem .5rem .35rem .35rem; border: 1px solid var(--color-border); border-radius: 10px; }
.afe-outlines li .afe-area-svg { border-radius: 8px; }
.afe-outlines li > div { display: grid; gap: .1rem; min-width: 0; flex: 1; font-size: .85rem; }
.afe-outlines li > div .afe-hint { font-size: .78rem; }
.afe-area-text { display: grid; gap: .45rem; justify-items: start; min-width: 0; flex: 1 1 14rem; }
.afe-area-text p { margin: 0; display: flex; gap: .4rem; align-items: center; }
.afe-corners { margin-top: .75rem; }
.afe-corners summary { cursor: pointer; font-size: .88rem; font-weight: 600; color: var(--color-text-secondary); min-height: 32px; display: flex; align-items: center; }
.afe-corners[open] summary { margin-bottom: .6rem; }
.afe-fam-switch { display: flex; align-items: center; gap: .45rem; }
@media (max-width: 768px) {
  .afe-savebar { border-radius: 12px; padding: .7rem .8rem; }
  .afe-savebar .afe-row-actions { width: 100%; justify-content: flex-end; }
  .afe-chipfield input, .afe-addr { font-size: 16px; }
  .afe-addr button { width: 36px; height: 36px; }
  .afe-email-rail button, .afe-corners summary { min-height: 44px; }
}

/* Phones: 44px targets, 16px inputs */
@media (max-width: 768px) {
  .afe-root .form-input, .afe-root select, .afe-root textarea, .afe-root input:not([type="checkbox"]):not([type="radio"]) { font-size: 16px; }
  .afe-icon-btn, .afe-mini button, .afe-collapse { width: 44px; height: 44px; }
  .afe-grip { width: 30px; height: 44px; }
  .afe-row { min-height: 52px; flex-wrap: wrap; }
  .afe-row .afe-mini, .afe-page-head .afe-mini { display: none; }
  .afe-row.is-sel .afe-mini, .afe-page.is-sel .afe-page-head .afe-mini { display: flex; }
  .afe-row-main { flex-wrap: wrap; }
  .afe-row-label { flex-basis: calc(100% - 3rem); white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .afe-row .afe-mini { margin-left: auto; }
  .afe-row-badges { order: 3; }
  .afe-chip, .afe-tog, .afe-chips button { min-height: 44px; }
  .afe-seg > button { height: 40px; min-width: 40px; }
  .afe-pair { grid-template-columns: 1fr; }
  .afe-diff li { grid-template-columns: 1fr; gap: .15rem; }
  .afe-search { max-width: none; flex-basis: 100%; }
  .afe-search kbd { display: none; }
  .afe-bar-actions { width: 100%; }
  .afe-bar-actions .btn-primary { margin-left: auto; }
}
`;
function useStyles() {
  useEffect(() => {
    let s = document.getElementById('afe-style');
    if (!s) { s = document.createElement('style'); s.id = 'afe-style'; document.head.append(s); }
    if (s.textContent !== CSS) s.textContent = CSS;
  }, []);
}

// ─── Shared pieces ─────────────────────────────────────────────────

const Spinner = () => html`<div class="afe-spin"><span class="spinner" /></div>`;

/**
 * Renders its children into <body>, so a dialog sits above sticky bars and the
 * admin header (and outside .afe-col, whose container query would otherwise
 * become the dialog's containing block). A class, so the copy in <body> is
 * redrawn in the same commit as the parent: a deferred redraw would race
 * typing in the dialog's inputs.
 */
class Portal extends Component {
  componentDidMount() { this.host = document.createElement('div'); document.body.append(this.host); this.paint(); }
  componentDidUpdate() { this.paint(); }
  componentWillUnmount() { render(null, this.host); this.host.remove(); }
  paint() { render(html`<div class="afe-root">${this.props.children}</div>`, this.host); }
  render() { return null; }
}

let dialogCount = 0;
/** A dialog: Escape or the backdrop closes it, Tab stays inside, focus comes back after */
function Dialog({ title, onClose, children, footer, wide = false }) {
  const box = useRef(null);
  const idRef = useRef(`afe-dlg-${++dialogCount}`);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    const raf = requestAnimationFrame(() => {
      const el = box.current?.querySelector('[data-autofocus]') || box.current?.querySelector('input:not([type="hidden"]), textarea, select') || box.current?.querySelector('.afe-dialog-foot .btn-primary, .afe-dialog-foot .btn');
      el?.focus();
    });
    const onKey = (e) => {
      if (!box.current) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current?.(); return; }
      if (e.key !== 'Tab') return;
      const all = [...box.current.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent !== null);
      if (!all.length) return;
      const [a, z] = [all[0], all[all.length - 1]];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey, true); if (before?.isConnected) before.focus?.(); };
  }, []);
  return html`
    <${Portal}>
      <div class="modal-overlay afe-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) close.current?.(); }}>
        <div class="modal afe-dialog ${wide ? 'is-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby=${idRef.current} ref=${box}>
          <div class="afe-dialog-head">
            <h3 id=${idRef.current}>${title}</h3>
            <button class="afe-icon-btn" aria-label="Close" onClick=${() => close.current?.()}><${Icon} name="close" /></button>
          </div>
          <div class="afe-dialog-body">${children}</div>
          ${footer && html`<div class="modal-buttons afe-dialog-foot">${footer}</div>`}
        </div>
      </div>
    <//>`;
}

/**
 * A list Sortable can reorder (drag the handle). Sortable moves the DOM node;
 * we put it straight back and move the data instead, so Preact stays in charge
 * of the page. onDrop gets { from, to, oldIndex, newIndex, id } (list keys from
 * listKey, indexes among the draggable items).
 */
function SortList({ tag = 'div', class: cls = '', listKey = '', group = null, handle, draggable, onDrop, children, ...rest }) {
  const ref = useRef(null);
  const cb = useRef(onDrop);
  cb.current = onDrop;
  useEffect(() => {
    if (!ref.current || !Sortable) return undefined;
    const s = Sortable.create(ref.current, {
      group: group || undefined,
      handle,
      draggable,
      animation: prefersReducedMotion() ? 0 : 150,
      forceFallback: true, // mouse and touch events, the same everywhere (and in tests)
      fallbackOnBody: true,
      fallbackTolerance: 3,
      ghostClass: 'afe-ghost',
      chosenClass: 'afe-chosen',
      emptyInsertThreshold: 24,
      onEnd: (evt) => {
        const { item, from, to, oldIndex, newIndex, oldDraggableIndex, newDraggableIndex } = evt;
        if (from === to && oldIndex === newIndex) return;
        item.remove();
        from.insertBefore(item, from.children[oldIndex] || null);
        cb.current?.({ from: from.dataset.key, to: to.dataset.key, oldIndex: oldDraggableIndex, newIndex: newDraggableIndex, id: item.dataset.id });
      },
    });
    return () => s.destroy();
  }, []);
  return h(tag, { ref, class: cls, 'data-key': listKey, ...rest }, children);
}

// ─── The area ──────────────────────────────────────────────────────
// Five tabs, by job: run the season (Applicants, Insights), what families
// read and get (Form, Emails), and how it all runs (Settings).
const TABS = [['applicants', 'Applicants'], ['insights', 'Insights'], ['form', 'Form'], ['emails', 'Emails'], ['settings', 'Settings']];
const TAB_KEYS = new Set(TABS.map(t => t[0]));
const DRAFT_TABS = new Set(['form', 'emails']);
const FORM_VIEWS = [['questions', 'Questions'], ['spanish', 'Spanish'], ['versions', 'Versions']];
const FORM_VIEW_KEYS = new Set(FORM_VIEWS.map(v => v[0]));
const APP_ID = /^app-[0-9a-z]+-[0-9a-f]+$/i;

/**
 * The address: #applications/<tab>[/<view>]. Older links still land where
 * they meant: submissions → Applicants → Submissions, messages → Emails,
 * spanish and history → Form, and #applications/<app id> (JobTread's
 * Application URL) opens that family, or its row in Submissions.
 */
function readHash(hash = location.hash) {
  const m = String(hash).match(/^#applications(?:\/([\w-]+))?(?:\/([\w-]+))?/);
  if (!m) return null;
  const a = m[1] || '';
  const b = m[2] || '';
  if (!a) return { tab: 'applicants' };
  if (a === 'applicants') return { tab: 'applicants', account: b || null };
  if (a === 'submissions' || a === 'list') return { tab: 'applicants', view: 'submissions', open: APP_ID.test(b) ? b : null };
  if (a === 'insights' || a === 'settings') return { tab: a };
  if (a === 'form') return { tab: 'form', formView: FORM_VIEW_KEYS.has(b) ? b : 'questions' };
  if (a === 'spanish') return { tab: 'form', formView: 'spanish' };
  if (a === 'history' || a === 'versions') return { tab: 'form', formView: 'versions' };
  if (a === 'emails' || a === 'messages') return { tab: 'emails' };
  return { tab: 'applicants', application: a };
}
const hashFor = (t, o = {}) => (t === 'applicants' ? (o.view === 'submissions' ? '#applications/submissions' : '#applications/applicants')
  : t === 'form' ? `#applications/form${o.formView && o.formView !== 'questions' ? `/${o.formView}` : ''}` : `#applications/${t}`);

/** A tab's title, one line on what it's for, and its actions (the admin's own page header) */
const Head = ({ title, sub, children }) => html`
  <div class="page-header afe-head">
    <div><h2>${title}</h2>${sub && html`<p class="page-sub">${sub}</p>`}</div>
    ${children && html`<div class="afe-head-actions">${children}</div>`}
  </div>`;

/**
 * "See what a family receives": a sample application through the real intake
 * with the person as the parent. They get the family's welcome email with the
 * PDF and the staff heads-up; the sample archives itself in JobTread.
 */
function SampleButton({ d, addToast }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    const j = await call(API, { test: true });
    setBusy(false);
    if (!j.success) { addToast(j.error || 'The sample didn’t go through. Try again in a minute.', 'error'); return; }
    setAsk(false);
    if (j.result?.status === 'error') addToast(`The sample was made but didn’t finish: ${j.result.error}. It retries on its own.`, 'error');
    else addToast(`Sample sent. The welcome email and the staff heads-up reach ${j.email || 'you'} in about a minute.`, 'success');
  };
  return html`
    <button class="btn btn-ghost afe-sample-btn" onClick=${() => setAsk(true)}><${Icon} name="send" size=${15} /> See what a family receives</button>
    ${ask && html`<${Dialog} title="See what a family receives?" onClose=${() => !busy && setAsk(false)} footer=${html`
      <button class="btn btn-ghost" onClick=${() => setAsk(false)} disabled=${busy}>Cancel</button>
      <button class="btn btn-primary" data-autofocus onClick=${send} disabled=${busy}>${busy ? 'Sending…' : 'Send me a sample'}</button>`}>
      <p>Sends a sample application through the real intake with you as the parent. You get the family's welcome email with the PDF, and the staff heads-up. The sample archives itself in JobTread.</p>
      ${d?.hasDraft && html`<div class="afe-note is-warn" style="margin-bottom: .85rem;"><${Icon} name="warn" /><span>It uses what families get today. Your changes that aren’t live yet won’t be in it, so put them live first to see them.</span></div>`}
      <p class="afe-hint" style="margin: 0;">It also shows in Submissions and in Slack, marked as a test.</p>
    <//>`}`;
}

/**
 * "Go through it as a family": the real form in a new tab (/apply/form/?test=1), open or closed.
 * Saving, the map check, uploads and Submit all run for real; every email goes to the person
 * running it, and the JobTread account is marked TEST and archives itself. The page offers
 * sample answers a page at a time and, after Submit, shows the intake step by step.
 */
function TestRunButton({ d }) {
  const tip = d?.hasDraft
    ? 'Opens the real form in a new tab, as families see it today (put your changes live first to try them). Every email comes to you.'
    : 'Opens the real form in a new tab. Every email comes to you, and nothing reaches the team or a real family.';
  return html`<a class="btn btn-primary afe-sample-btn" href="/apply/form/?test=1" target="_blank" rel="noopener" title=${tip}><${Icon} name="play" size=${15} /> Go through it as a family</a>`;
}

export function ApplicationsArea({ addToast = () => {}, RichTextEditor = null, initialTab = null, setGlobalDirty = null }) {
  useStyles();
  const start = readHash() || { tab: 'applicants' };
  const [tab, setTab] = useState(initialTab && TAB_KEYS.has(initialTab) ? initialTab : start.tab);
  const [route, setRoute] = useState(() => ({ ...start, n: 1 })); // what the address asked the Applicants tab for
  const [formView, setFormView] = useState(start.formView || 'questions');
  const d = useFormDraft(addToast, DRAFT_TABS.has(tab));
  const settings = useAppSettings(addToast, tab === 'settings');
  const [formSel, setFormSel] = useState(null);
  // One unsaved-changes guard for the whole area
  useEffect(() => {
    setGlobalDirty?.(settings.dirty, 'Applications settings');
    return () => setGlobalDirty?.(false);
  }, [settings.dirty]);
  const go = (t, opts = {}) => {
    if (DRAFT_TABS.has(tab) && !DRAFT_TABS.has(t)) d.flush();
    setTab(t);
    if (t === 'form') setFormView(opts.formView || 'questions');
    if (t === 'applicants') setRoute(r => ({ tab: t, view: opts.view || null, show: opts.show || null, editBoundary: !!opts.editBoundary, n: r.n + 1 }));
    setFormSel(opts.formSel || null);
    history.replaceState(null, '', hashFor(t, { ...opts, formView: t === 'form' ? opts.formView || 'questions' : null }));
  };
  const goFormView = (v) => { setFormView(v); history.replaceState(null, '', hashFor('form', { formView: v })); };
  useEffect(() => {
    const onHash = () => {
      const r = readHash();
      if (!r) return;
      setTab(r.tab);
      if (r.tab === 'form') setFormView(r.formView || 'questions');
      if (r.tab === 'applicants') setRoute(x => ({ ...r, n: x.n + 1 }));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // On a phone the tab row scrolls sideways: bring the open tab into view
  useEffect(() => {
    const list = document.querySelector('.afe-tabs');
    const el = list?.querySelector(`[data-tab="${tab}"]`);
    if (!el || list.scrollWidth <= list.clientWidth) return;
    const lr = list.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.left < lr.left || er.right > lr.right) list.scrollLeft += er.left - lr.left - (lr.width - er.width) / 2;
  }, [tab]);
  const spanishLeft = useMemo(() => (d.work ? Object.values(translationStatus(d.work)).filter(s => s !== 'done').length : 0), [d.work]);
  const onTabKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex(t => t[0] === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
    e.preventDefault();
    go(next);
    requestAnimationFrame(() => document.querySelector(`.afe-tabs [data-tab="${next}"]`)?.focus());
  };
  const saved = settings.saved;
  const seasonFull = !!(saved && settings.cap?.full && settings.cap.year === saved.year);
  const draftDot = (k) => DRAFT_TABS.has(k) && d.hasDraft && html`<span class="afe-tab-dot" title="Changes that aren't live yet"><span class="sr-only">(changes not live yet)</span></span>`;
  return html`
    <div class="afe-root">
      <div class="hub-tabs afe-tabs" role="tablist" aria-label="Applications" onKeyDown=${onTabKey}>
        ${TABS.map(([k, label]) => html`
          <button class="hub-tab ${tab === k ? 'active' : ''}" role="tab" data-tab=${k} aria-selected=${tab === k} tabindex=${tab === k ? 0 : -1} onClick=${() => go(k)}>
            ${label}${draftDot(k)}${k === 'settings' && saved && html`<span class="afe-tab-state ${saved.open ? 'is-open' : ''}" title=${`Applications are ${saved.open ? 'open' : 'closed'} for the ${saved.year} season${!saved.open && seasonFull ? '; the season is full' : ''}${!saved.open && saved.opensAt ? `; they open ${longWhen(saved.opensAt)}` : ''}`}>${saved.open ? 'Open' : saved.opensAt ? `Opens ${shortDay(saved.opensAt)}` : seasonFull ? 'Full' : 'Closed'}</span>`}
          </button>`)}
      </div>
      <div role="tabpanel" aria-label=${TABS.find(t => t[0] === tab)?.[1]}>
        ${tab === 'applicants' && html`<${ApplicantsTab} addToast=${addToast} route=${route} go=${go} />`}
        ${tab === 'insights' && html`<${InsightsTab} seasonYear=${d.meta?.year} go=${go} />`}
        ${tab === 'form' && html`<${FormArea} d=${d} view=${formView} onView=${goFormView} spanishLeft=${spanishLeft} RichTextEditor=${RichTextEditor} addToast=${addToast} initialSel=${formSel} go=${go} />`}
        ${tab === 'emails' && html`<${EmailsTab} d=${d} RichTextEditor=${RichTextEditor} go=${go} addToast=${addToast} />`}
        ${tab === 'settings' && html`<${SettingsTab} addToast=${addToast} s=${settings} go=${go} />`}
      </div>
    </div>`;
}

// ─── Applicants (./applicants.js), with Submissions as one of its views ──
let applicantsModule = null;
function ApplicantsTab({ addToast, route, go }) {
  const [mod, setMod] = useState(null);
  const [err, setErr] = useState(null);
  const [intake, setIntake] = useState(null); // the applications that haven't fully reached JobTread
  const load = () => {
    setErr(null);
    applicantsModule ||= import('./applicants.js');
    applicantsModule
      .then((m) => { if (typeof m.ApplicantsArea !== 'function') throw new Error('applicants.js has no ApplicantsArea'); setMod(m); })
      .catch((e) => { applicantsModule = null; setErr(e?.message || String(e)); });
  };
  const loadIntake = async () => {
    const j = await call(`${API}?show=attention&limit=5`);
    if (j.success) setIntake({ total: j.total || 0, names: (j.applications || []).map(a => a.child || 'Applicant') });
  };
  useEffect(load, []);
  useEffect(() => {
    loadIntake();
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadIntake(); }, 120000);
    return () => clearInterval(t);
  }, []);
  if (err) {
    return html`
      <div class="card" style="text-align: center; padding: 2.25rem 1.5rem;">
        <h3 class="u-mb-1">The applicants view didn't load</h3>
        <p class="afe-lede" style="margin: 0 auto 1rem;">Check your connection and try again. Insights, the Form and Settings still work.</p>
        <p class="afe-hint" style="margin-bottom: 1rem;">${err}</p>
        <button class="btn btn-primary" onClick=${load}>Try again</button>
      </div>`;
  }
  if (!mod) return html`<div class="afe-spin" role="status"><span class="spinner" /><span class="afe-hint" style="margin-left: .6rem; align-self: center;">Loading…</span></div>`;
  const n = intake?.total || 0;
  const notice = n > 0 && route.view !== 'submissions' ? html`
    <div class="afe-note is-warn afe-intake" role="status">
      <${Icon} name="warn" />
      <span><strong>${n === 1 ? '1 website application hasn’t' : `${n} website applications haven’t`} fully reached JobTread</strong>${intake.names.length ? ` (${intake.names.slice(0, 3).join(', ')}${n > 3 ? '…' : ''})` : ''}. ${n === 1 ? 'It retries' : 'They retry'} on ${n === 1 ? 'its' : 'their'} own.</span>
      <button class="btn btn-ghost btn-sm" onClick=${() => go('applicants', { view: 'submissions', show: 'attention' })}>Review</button>
    </div>` : null;
  return html`<${mod.ApplicantsArea}
    addToast=${addToast}
    route=${route}
    notice=${notice}
    extraViews=${[{ key: 'submissions', label: 'Submissions', count: n, render: () => html`<${SubmissionsView} key=${`s${route.n}`} addToast=${addToast} openFirst=${route.view === 'submissions' ? route.open : route.application} initialShow=${route.show} attention=${n} onChanged=${loadIntake} />` }]} />`;
}

// ─── Submissions (a view of Applicants) ────────────────────────────
// The website form's intake log: each application, whether every step of
// loading it into JobTread worked, the address and repeat checks, the
// answers, CSV, and deleting a family's data from the site.
const SHOWS = [['all', 'All'], ['attention', 'Needs attention'], ['outside', 'Outside area'], ['repeat', 'Possible repeat'], ['test', 'Tests'], ['deleted', 'Deleted']];
const EMPTY_FOR = {
  all: 'No applications yet.',
  attention: 'Nothing needs attention. Every application reached JobTread.',
  outside: 'No applications from outside the service area.',
  repeat: 'No possible repeats.',
  test: 'No test applications.',
  deleted: 'No deleted applications.',
};
const PAGE_SIZE = 50;
const CHECKS = [['account', 'Account'], ['contacts', 'Contacts'], ['home', 'Home'], ['pdf', 'PDF'], ['photos', 'Photos'], ['video', 'Video'], ['familyMessage', 'Family message'], ['medicalNote', 'Medical note'], ['staffEmail', 'Staff email'], ['staffSlack', 'Staff Slack']];
const stepDone = (v) => v === true || v === 'none';

/** The family picked one county; the Census put the address in another */
function countyMismatch(flags, picked = null) {
  if (!flags) return null;
  if (flags.countyMismatch === true) return { census: flags.area?.county || '', picked: picked || flags.county || '' };
  const census = flags.area?.county;
  const mine = picked || flags.county || flags.countyAnswer;
  return census && mine && census.toLowerCase() !== String(mine).toLowerCase() ? { census, picked: mine } : null;
}

function FlagBadges({ a, picked = null }) {
  const f = a.flags || {};
  const cm = countyMismatch(f, picked);
  return html`
    ${a.isTest && html`<span class="badge badge-blue">Test</span>`}
    ${a.deletedAt && html`<span class="badge badge-gray" title=${`Deleted ${dayText(a.deletedAt)}${a.deletedBy ? ` by ${a.deletedBy}` : ''}`}>Deleted</span>`}
    ${(f.lang || a.lang) === 'es' && html`<span class="badge badge-gray" title="Answered in Spanish">Spanish</span>`}
    ${f.area?.status === 'outside' && html`<span class="badge badge-yellow" title=${f.area.text || ''}>${f.area.miles != null ? `${f.area.miles} mi outside` : 'Outside area'}</span>`}
    ${f.area?.status === 'unknown' && html`<span class="badge badge-gray" title=${f.area.text || 'The Census couldn’t find this address'}>Address not found</span>`}
    ${cm && html`<span class="badge badge-yellow" title=${`The family picked ${cm.picked}; the Census says ${cm.census}`}>County mismatch</span>`}
    ${f.repeat?.length > 0 && html`<span class="badge badge-yellow" title=${f.repeat.map(m => `${m.name}${m.year ? ` (${m.year})` : ''}`).join(', ')}>Possible repeat</span>`}`;
}

/** One chip per step: ✓ done, – not part of this one, … waiting, · not yet, ! failed */
const stepChip = (label, v) => {
  const cls = v === true ? 'badge-green' : v === 'none' || v === false ? 'badge-gray' : v === 'waiting' ? 'badge-yellow' : 'badge-red';
  const mark = v === true ? '✓' : v === 'waiting' ? '…' : v === 'none' ? '–' : v === false ? '·' : '!';
  return html`<span class="badge ${cls}" title=${typeof v === 'string' && v !== 'none' && v !== 'waiting' ? v : ''}>${mark} ${label}</span>`;
};

/** Where one application stands: a single check when it all went through, else what's left */
function Delivery({ a }) {
  if (a.deletedAt) return html`<span class="afe-hint">Data deleted from the site</span>`;
  const left = CHECKS.filter(([k]) => !stepDone(a.checklist?.[k]));
  if (!left.length) {
    const skipped = CHECKS.filter(([k]) => a.checklist?.[k] === 'none').map(([, l]) => l.toLowerCase());
    return html`<span class="badge badge-green afe-delivered" title=${`Done: ${CHECKS.filter(([k]) => a.checklist?.[k] === true).map(([, l]) => l).join(', ')}${skipped.length ? `. Not part of this one: ${skipped.join(', ')}` : ''}`}>✓ In JobTread</span>`;
  }
  return html`<span class="afe-steps">${left.map(([k, l]) => stepChip(l, a.checklist?.[k]))}</span>`;
}

function SubmissionsView({ addToast, openFirst, initialShow, attention = 0, onChanged = () => {} }) {
  const [q, setQ] = useState('');
  const qd = useDebounced(q.trim(), 300);
  const [show, setShow] = useState(initialShow || 'all');
  const [year, setYear] = useState('');
  const [offset, setOffset] = useState(0);
  const [tests, setTests] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [openId, setOpenId] = useState(openFirst);
  useEffect(() => { if (openFirst) setOpenId(openFirst); }, [openFirst]);
  const [detail, setDetail] = useState(null);
  const [detailKey, setDetailKey] = useState(0);
  const [deleting, setDeleting] = useState(null);
  const searchRef = useRef(null);
  const seq = useRef(0);
  // Arriving from a link (#applications/<app id>): bring it into view once it's loaded
  const scrolled = useRef(null);
  useEffect(() => {
    if (!openId || !detail || detail.error || scrolled.current === openId || openFirst !== openId) return;
    scrolled.current = openId;
    requestAnimationFrame(() => document.querySelector('.afe-sub.is-open')?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }));
  }, [detail]);

  const load = async () => {
    const n = ++seq.current;
    setLoading(true);
    const p = new URLSearchParams({ show, offset: String(offset), limit: String(PAGE_SIZE) });
    if (qd) p.set('q', qd);
    if (year) p.set('year', year);
    const j = await call(`${API}?${p}`);
    if (n !== seq.current) return;
    setLoading(false);
    if (j.success) { setData(j); setError(null); } else setError(j.error || 'Could not load');
  };
  useEffect(() => { load(); }, [qd, show, year, offset]);
  // Stays current on its own while it's open
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadRef.current(); }, 60000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); return undefined; }
    let live = true;
    setDetail(null);
    call(`${API}?id=${encodeURIComponent(openId)}`).then(j => { if (live) setDetail(j.success ? j.application : { error: j.error || 'Not found' }); });
    return () => { live = false; };
  }, [openId, detailKey]);
  // "/" jumps to the search box
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target) || document.querySelector('.afe-overlay, .modal-overlay, .apl-drawer')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = (id) => {
    const next = openId === id ? null : id;
    setOpenId(next);
    history.replaceState(null, '', next ? `#applications/submissions/${next}` : '#applications/submissions');
  };
  const post = async (body, label) => {
    setBusy(label);
    const j = await call(API, body);
    setBusy('');
    if (!j.success) addToast(j.error || 'That didn’t work', 'error');
    await load();
    onChanged();
    return j.success ? j : null;
  };
  const retry = async (id) => {
    const j = await post({ retry: id }, id);
    if (j) addToast(j.result?.status === 'done' ? 'Everything is in JobTread.' : j.result?.status === 'waiting' ? 'In JobTread; still waiting on the video.' : `Still not finished: ${j.result?.error || j.result?.status}`, j.result?.error ? 'error' : 'info');
    if (openId === id) setDetailKey(k => k + 1);
  };
  const setFilter = (fn) => { fn(); setOffset(0); };
  const family = (accountId) => { location.hash = `#applications/applicants/${accountId}`; };

  const apps = data?.applications || [];
  const total = data?.total ?? apps.length;
  const years = data?.years || [];
  const csv = `${API}?export=csv${year ? `&year=${encodeURIComponent(year)}` : ''}${tests ? '&tests=1' : ''}`;
  const setup = data ? [
    !data.qcGrant && { text: 'Family messages post as the website’s JobTread connection, not as the Qualification Committee.', fix: 'Add the Qualification Committee’s JobTread grant key in Cloudflare (soard-site → Settings → Variables) as JOBTREAD_QC_GRANT_KEY.' },
    data.stream === false && { text: 'Video uploads aren’t connected, so families can’t add their video.', fix: 'Cloudflare Stream needs CF_ACCOUNT_ID and CF_STREAM_TOKEN in Cloudflare (soard-site → Settings → Variables).' },
  ].filter(Boolean) : [];

  const row = (a, open) => html`
    <div class="afe-sub ${open ? 'is-open' : ''}" key=${a.id} data-id=${a.id}>
      <div class="afe-sub-row">
        <div class="afe-sub-main">
          <div class="afe-sub-who">
            ${a.accountId && !a.deletedAt
              ? html`<button class="afe-sub-name" onClick=${() => family(a.accountId)} title="Open this family">${a.child || 'Applicant'}</button>`
              : html`<strong class="afe-sub-name">${a.child || 'Applicant'}</strong>`}
            <${FlagBadges} a=${a} picked=${open ? pickedCounty(detail) : null} />
          </div>
          <div class="afe-sub-meta">${[a.parent, (a.makeoverTypes || []).join(', '), when(a.submittedAt)].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="afe-sub-state"><${Delivery} a=${a} /></div>
        <div class="afe-row-actions afe-sub-actions">
          ${a.status !== 'done' && !a.deletedAt && html`<button class="btn btn-ghost btn-sm" onClick=${() => retry(a.id)} disabled=${!!busy}>${busy === a.id ? 'Retrying…' : 'Retry now'}</button>`}
          <button class="btn btn-ghost btn-sm" aria-expanded=${open} onClick=${() => toggle(a.id)}>${open ? 'Hide' : 'Details'}</button>
        </div>
      </div>
      ${a.status === 'error' && !a.deletedAt && html`<p class="afe-sub-note is-bad">Not finished after ${a.attempts} ${a.attempts === 1 ? 'try' : 'tries'}: ${a.lastError}. It retries on its own.</p>`}
      ${a.status === 'waiting' && html`<p class="afe-sub-note">Waiting on Cloudflare to finish the video; it's attached on its own.</p>`}
      ${open && html`<${SubmissionDetail} a=${a} detail=${detail} onDelete=${() => setDeleting(detail && !detail.error ? detail : a)} />`}
    </div>`;

  return html`
    <div class="afe-subs">
      <p class="afe-lede">
        Every application sent through the <a href="/apply/form/" target="_blank" rel="noopener">website form</a>, and whether each step of loading it into JobTread worked.
        ${data && html` Applications are <strong>${data.open ? 'open' : 'closed'}</strong> for the ${data.year} season (<a href="#applications/settings">Settings</a>).`}
        ${data?.draftsInProgress > 0 && html` ${plural(data.draftsInProgress, 'family has', 'families have')} started one and not sent it yet.`}
      </p>
      ${setup.length > 0 && html`<details class="afe-setup">
        <summary><${Icon} name="warn" size=${15} /><span>${setup.map(x => x.text).join(' ')}</span><span class="afe-link">How to fix</span></summary>
        <ul>${setup.map(x => html`<li>${x.fix}</li>`)}</ul>
      </details>`}

      <div class="afe-toolbar afe-subs-bar">
        <label class="afe-search">
          <${Icon} name="search" />
          <input ref=${searchRef} class="form-input" type="search" placeholder="Search child, parent or email" aria-label="Search applications" value=${q} onInput=${(e) => { setQ(e.target.value); setOffset(0); }} />
          ${!q && html`<kbd>/</kbd>`}
        </label>
        <select class="form-input" style="width: auto;" aria-label="Season" value=${year} onChange=${(e) => setFilter(() => setYear(e.target.value))}>
          <option value="">All seasons</option>
          ${years.map(y => html`<option value=${y}>${y} season</option>`)}
        </select>
        <span style="flex: 1;"></span>
        <label class="afe-check text-sm" title="Test applications are left out of the export unless this is on"><input type="checkbox" checked=${tests} onChange=${(e) => setTests(e.target.checked)} /> Include tests</label>
        <a class="btn btn-ghost" href=${csv} download>Export CSV</a>
      </div>
      <div class="afe-chipbar" role="group" aria-label="Show">
        ${SHOWS.map(([k, label]) => html`<button class="afe-chip" aria-pressed=${show === k} onClick=${() => setFilter(() => setShow(k))}>${label}${k === 'attention' && attention > 0 && html`<span class="afe-chip-n">${attention}</span>`}</button>`)}
      </div>

      ${error && html`<p class="text-sm afe-danger">Couldn't load applications: ${error}</p>`}
      ${!data && !error && html`<${Spinner} />`}
      ${data && html`
        ${openId && detail && !detail.error && !apps.some(x => x.id === openId) && html`<div class="afe-sub-list">${row({ ...detail, makeoverTypes: [] }, true)}</div>`}
        ${apps.length === 0 ? html`<p class="afe-empty">${qd ? `No applications match "${qd}".` : EMPTY_FOR[show] || EMPTY_FOR.all}</p>` : html`
          <div class="afe-sub-list ${loading ? 'is-loading' : ''}" aria-busy=${loading}>${apps.map(a => row(a, openId === a.id))}</div>
          <div class="afe-pager">
            <span>${total > PAGE_SIZE ? `Showing ${num(offset + 1)}–${num(Math.min(offset + PAGE_SIZE, total))} of ${num(total)}` : plural(total, 'application')}</span>
            ${total > PAGE_SIZE && html`<span class="afe-row-actions">
              <button class="btn btn-ghost btn-sm" disabled=${offset === 0 || loading} onClick=${() => setOffset(o => Math.max(0, o - PAGE_SIZE))}>Previous</button>
              <button class="btn btn-ghost btn-sm" disabled=${offset + PAGE_SIZE >= total || loading} onClick=${() => setOffset(o => o + PAGE_SIZE)}>Next</button>
            </span>`}
          </div>`}
        ${(data.events || []).length > 0 && html`
          <details class="afe-events">
            <summary>Status messages from JobTread (last ${data.events.length})</summary>
            <p class="afe-hint">When someone changes an applicant's Status, the site emails the family the matching message once. The wording is in Emails.</p>
            <div>
              ${data.events.map(e => html`
                <div class="text-sm">
                  <span class="text-muted">${when(e.created_at)}</span>
                  <span>${e.previous_status || 'None'} → ${e.status || 'None'}</span>
                  <span class="text-muted">${Object.entries(e.actions || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'nothing to send'}</span>
                  ${e.error && html`<span class="afe-danger">${e.error}</span>`}
                </div>`)}
            </div>
          </details>`}
      `}
      ${deleting && html`<${DeleteDialog} app=${deleting} onClose=${() => setDeleting(null)} onDone=${async (j) => {
        setDeleting(null);
        addToast('Deleted from the site. JobTread is unchanged.', 'info');
        await load();
        setDetailKey(k => k + 1);
        if (j.accountUrl) addToast('Archive the JobTread account too if the family asked to be removed.', 'info');
      }} />`}
    </div>`;
}

/** The county the family picked, from the answers in the detail view */
const pickedCounty = (detail) => (detail && !detail.error ? detail.sections?.flatMap(s => s.items).find(i => i.id === 'county')?.text || null : null);

function SubmissionDetail({ a, detail, onDelete }) {
  if (!detail) return html`<div class="afe-detail"><p class="text-sm text-muted">Loading…</p></div>`;
  if (detail.error) return html`<div class="afe-detail"><p class="text-sm">${detail.error}</p></div>`;
  const f = detail.flags || a.flags || {};
  const cm = countyMismatch(f, pickedCounty(detail));
  const deleted = detail.deletedAt || a.deletedAt;
  return html`
    <div class="afe-detail">
      <p class="text-sm" style="margin: 0;">
        ${detail.parent || 'No contact (deleted)'}${detail.email && html` · <a href=${`mailto:${detail.email}`}>${detail.email}</a>`}
        ${detail.hasPdf && html` · <a href=${`${API}?file=${detail.id}&field=pdf`} target="_blank">Application PDF</a>`}
        ${detail.jobtreadUrl && html` · <a href=${detail.jobtreadUrl} target="_blank" rel="noopener">Open in JobTread</a>`}
        <span class="text-muted"> · form version ${detail.formVersion || 'built in'}${detail.lang === 'es' ? ' · answered in Spanish' : ''}</span>
      </p>
      ${!deleted && detail.checklist && html`<div class="afe-checks" aria-label="Each step into JobTread">${CHECKS.map(([k, label]) => stepChip(label, detail.checklist[k]))}</div>`}
      ${(f.area || cm || f.repeat?.length > 0 || f.saidApplied) && html`
        <div class="afe-note ${f.area?.status === 'outside' || cm || f.repeat?.length ? 'is-warn' : ''}">
          <div style="display: grid; gap: .3rem;">
            ${f.area && html`<span><strong>Address check:</strong> ${f.area.text}${f.area.county ? ` (${f.area.county} County)` : ''}</span>`}
            ${cm && html`<span><strong>County:</strong> the family picked ${cm.picked}; the Census says ${cm.census}.</span>`}
            ${f.repeat?.length > 0 && html`<span><strong>Possible repeat:</strong> ${f.repeat.map((m, i) => html`${i ? '; ' : ''}${m.url ? html`<a href=${m.url} target="_blank" rel="noopener" style="text-decoration: underline;">${m.name}</a>` : m.name}${m.year ? ` (${m.year})` : ''}${m.status ? `, ${m.status}` : ''}${m.why ? `: ${m.why}` : ''}`)}</span>`}
            ${f.saidApplied && !f.repeat?.length && html`<span>The family said they applied before.</span>`}
          </div>
        </div>`}
      ${deleted
        ? html`<p class="text-sm text-muted" style="margin: 0;">The family's answers and files were deleted from the site ${dayText(deleted)}${a.deletedBy ? ` by ${a.deletedBy}` : ''}. The JobTread account was left as it was.</p>`
        : (detail.sections || []).map(s => html`
          <details>
            <summary style="cursor: pointer; font-weight: 600;">${s.title}</summary>
            <dl>
              ${s.items.map(i => html`
                <dt>${i.label}${i.labelEn && i.labelEn !== i.label ? html` <span class="afe-hint">(${i.labelEn})</span>` : ''}</dt>
                <dd>${i.upload
                  ? (i.type === 'photo' ? html`<a href=${`${API}?file=${detail.id}&field=${i.id}`} target="_blank"><img src=${`${API}?file=${detail.id}&field=${i.id}${i.hasThumb ? '&thumb=1' : ''}`} alt=${i.label} style="max-width: 160px; max-height: 120px; border-radius: 6px;" /></a>` : `Video ${i.video?.uploaded ? 'uploaded' : 'not finished'}${i.video?.duration ? ` (${Math.round(i.video.duration)} s)` : ''}`)
                  : i.text}</dd>`)}
            </dl>
          </details>`)}
      ${!deleted && html`
        <div class="afe-danger-zone">
          <span class="afe-hint">Removes the answers, photos, video and PDF from the website. JobTread stays as it is.</span>
          <button class="btn btn-ghost btn-sm afe-btn-danger" onClick=${onDelete}><${Icon} name="trash" size=${14} /> Delete family's data from the site</button>
        </div>`}
    </div>`;
}

function DeleteDialog({ app, onClose, onDone }) {
  const name = first(String(app.child || '').replace(/\s*\(deleted\)$/i, ''));
  const word = name || 'DELETE';
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ok = typed.trim().toLowerCase() === word.toLowerCase();
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    const j = await call(API, { deleteApp: app.id });
    setBusy(false);
    if (j.success) onDone(j); else setErr(j.error || 'That didn’t work. Try again.');
  };
  return html`
    <${Dialog} title="Delete this family's data from the site?" onClose=${onClose} footer=${html`
      <button class="btn btn-ghost" onClick=${onClose}>Cancel</button>
      <button class="btn btn-danger" disabled=${!ok || busy} onClick=${go}>${busy ? 'Deleting…' : 'Delete data'}</button>`}>
      <p>This removes ${name ? `${name}'s` : 'this'} application from the website: the answers, photos, video and PDF. It can't be undone. A short record stays so the list shows it happened.</p>
      <div class="afe-note" style="margin-bottom: 1rem;"><${Icon} name="warn" /><span><strong>JobTread isn't touched.</strong> The account and everything already in it stay. If the family asked to be removed, archive the account in JobTread too.</span></div>
      <div class="afe-field">
        <label for="afe-del-confirm">Type <strong>${word}</strong> to confirm</label>
        <input id="afe-del-confirm" class="form-input" autocomplete="off" value=${typed} onInput=${(e) => setTyped(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') go(); }} />
      </div>
      ${err && html`<p class="afe-bad">${err}</p>`}
    <//>`;
}

// ─── Insights ──────────────────────────────────────────────────────
const minutesText = (m) => {
  if (m == null) return '–';
  if (m < 90) return `${Math.max(1, Math.round(m))} min`;
  if (m < 48 * 60) { const hh = Math.floor(m / 60); const mm = Math.round(m % 60); return mm ? `${hh} h ${mm} min` : `${hh} h`; }
  return plural(Math.round(m / 1440), 'day');
};
const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

function InsightsTab({ seasonYear, go }) {
  const [years, setYears] = useState([]);
  const [year, setYear] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    call(`${API}?limit=1`).then(j => {
      const season = j.year || seasonYear || String(new Date().getFullYear() + 1);
      setYears([...new Set([season, ...(j.years || [])].filter(Boolean))].sort().reverse());
      setYear(y => y || season);
    });
  }, []);
  useEffect(() => {
    if (!year) return undefined;
    let live = true;
    setLoading(true);
    call(`${API}?insights=1&year=${encodeURIComponent(year)}`).then(j => {
      if (!live) return;
      setLoading(false);
      if (j.success) { setData(j.insights); setError(null); } else setError(j.error || 'Could not load');
    });
    return () => { live = false; };
  }, [year]);
  const ins = data;
  const stoppedTotal = ins ? (ins.stopped?.outside || 0) + (ins.stopped?.rental || 0) + (ins.stopped?.other || 0) : 0;
  return html`
    <div class="afe-ins" aria-busy=${loading}>
      <${Head} title="Insights" sub="How families move through the application: who finishes, where people stop, and how they heard about us. Tests are left out.">
        <label class="afe-row-actions text-sm" style="font-weight: 600;">Season
          <select class="form-input" style="width: auto;" value=${year || ''} onChange=${(e) => setYear(e.target.value)} aria-label="Season">
            ${years.map(y => html`<option value=${y}>${y}</option>`)}
          </select>
        </label>
      <//>
      ${error && html`<div class="afe-note is-warn"><${Icon} name="warn" /><span>Couldn't load insights: ${error}</span></div>`}
      ${!ins && !error && html`<${Spinner} />`}
      ${ins && !ins.started && html`
        <div class="card" style="text-align: center; padding: 2.5rem 1.5rem;">
          <h4 style="margin: 0 0 .35rem;">No one has started a ${ins.year} application yet</h4>
          <p class="afe-lede" style="margin: 0 auto;">This fills in as families open the application: who finishes, where people stop, and how they heard about us.</p>
        </div>`}
      ${ins && ins.started > 0 && html`
        <div class="afe-ins" style="opacity: ${loading ? 0.6 : 1}; transition: opacity .15s;">
          <div class="afe-tiles">
            <div class="afe-tile"><span>Started</span><strong>${num(ins.started)}</strong><small>opened the application</small></div>
            <div class="afe-tile"><span>Submitted</span><strong>${num(ins.submitted)}</strong><small>finished and sent it</small></div>
            <div class="afe-tile"><span>Finish rate</span><strong>${ins.finishRate == null ? '–' : `${ins.finishRate}%`}</strong><small>of those who started</small></div>
            <div class="afe-tile"><span>Typical time to finish</span><strong>${minutesText(ins.medianMinutes)}</strong><small>median, first page to submit</small></div>
          </div>

          <div class="afe-viz">
            <h4>What happened to everyone who started</h4>
            <span class="afe-hint">${num(ins.started)} ${ins.started === 1 ? 'family' : 'families'} started a ${ins.year} application.</span>
            <${StackBar} parts=${[
              { label: 'Submitted', n: ins.submitted, color: 'var(--afe-data)' },
              { label: 'Still working on it', n: ins.inProgress, color: 'var(--afe-data-2)', note: 'changed something in the last 14 days' },
              { label: 'Ended by an answer', n: stoppedTotal, color: 'var(--afe-data-3)', note: [ins.stopped?.outside && `${ins.stopped.outside} outside the area`, ins.stopped?.rental && `${ins.stopped.rental} renting`, ins.stopped?.other && `${ins.stopped.other} other`].filter(Boolean).join(', ') || 'a stop screen' },
              { label: 'Left without finishing', n: ins.leftUnfinished, color: 'var(--afe-rest)', note: 'quiet for 14 days or more' },
            ]} total=${ins.started} />
          </div>

          <div class="afe-ins-cols">
            <div class="afe-ins-col">
            <div class="afe-viz">
              <h4>Where people stop</h4>
              <span class="afe-hint">The last page each family reached before leaving without finishing.</span>
              <${StopBars} byPage=${ins.byPage || []} started=${ins.started} />
            </div>
            ${ins.area?.checked > 0 && html`<${AreaInsight} a=${ins.area} go=${go} />`}
            <div class="afe-viz">
              <h4>How families heard about us</h4>
              <span class="afe-hint">From "Who referred you", on submitted applications.</span>
              <${RankBars} rows=${ins.referral || []} />
            </div>
            </div>
            <div class="afe-ins-col">
            <div class="afe-viz">
              <h4>Applications per week</h4>
              <span class="afe-hint">Submitted applications, by the week they came in (weeks start Monday).</span>
              <${WeekChart} perWeek=${ins.perWeek || []} />
            </div>
            <div class="afe-viz">
              <h4>Language</h4>
              <span class="afe-hint">The language families chose when they started.</span>
              <${StackBar} parts=${[
                { label: 'English', n: ins.languages?.en || 0, color: 'var(--afe-data)' },
                { label: 'Spanish', n: ins.languages?.es || 0, color: 'var(--afe-data-2)' },
              ]} total=${(ins.languages?.en || 0) + (ins.languages?.es || 0)} />
            </div>
            <div class="afe-viz">
              <h4>Reminder emails</h4>
              <span class="afe-hint">Sent to families who started and went quiet. The wording is in <a href="#applications/emails">Emails</a>.</span>
              <div class="afe-stat-pair">
                <div><b>${num(ins.reminders?.sent)}</b><span>${ins.reminders?.sent === 1 ? 'reminder sent' : 'reminders sent'}</span></div>
                <div><b>${num(ins.reminders?.finishedAfter)}</b><span>finished after a reminder</span></div>
              </div>
            </div>
            <div class="afe-viz">
              <h4>Checks</h4>
              <span class="afe-hint">Run on each submitted application, before anyone reviews it.</span>
              <div class="afe-checklist">
                <div><span>Outside the service area <b>${num(ins.checks?.outside)}</b></span>${ins.checks?.outside > 0 && html`<button class="btn btn-ghost btn-sm" onClick=${() => go('applicants', { view: 'submissions', show: 'outside' })}>See them</button>`}</div>
                <div><span>Possible repeat applicants <b>${num(ins.checks?.repeat)}</b></span>${ins.checks?.repeat > 0 && html`<button class="btn btn-ghost btn-sm" onClick=${() => go('applicants', { view: 'submissions', show: 'repeat' })}>See them</button>`}</div>
                <div><span>Address the Census couldn't find <b>${num(ins.checks?.unchecked)}</b></span></div>
              </div>
            </div>
            </div>
          </div>
        </div>`}
    </div>`;
}

/**
 * Where the families who started live, from the address check on the form:
 * inside, close, farther out, not found; how far out the outside ones are;
 * and what the families farther out did.
 */
function AreaInsight({ a, go }) {
  const steps = (a.steps || []).filter(st => st.count > 0 || st.close);
  const max = Math.max(1, ...steps.map(st => st.count));
  const span = (st) => (st.to == null ? `Over ${st.from} mi` : st.from ? `${st.from} to ${st.to} mi` : `Up to ${st.to} mi`);
  return html`
    <div class="afe-viz">
      <h4>Where families live</h4>
      <span class="afe-hint">From the address check as families type their home address. Close means within ${plural(a.nearMiles, 'mile')} of the area (<a href="#applications/settings" onClick=${(e) => { e.preventDefault(); go('settings'); }}>Settings</a>).</span>
      <${StackBar} parts=${[
        { label: 'Inside', n: a.inside, color: 'var(--afe-data)' },
        { label: 'Close', n: a.near, color: 'var(--afe-data-2)' },
        { label: 'Farther out', n: a.far, color: 'var(--afe-data-3)' },
        { label: 'Address not found', n: a.notFound, color: 'var(--afe-rest)', note: 'they answered for themselves' },
      ]} total=${a.inside + a.near + a.far + a.notFound} />
      ${(a.near + a.far) > 0 && html`
        <div class="afe-hbars" style="margin-top: .9rem;" aria-label="How far outside the area">
          ${steps.map(st => html`
            <div class="afe-hbar">
              <span class="afe-hbar-label">${span(st)}${st.close ? html` <span class="afe-tag">close</span>` : ''}</span>
              <span class="afe-hbar-val"><b>${num(st.count)}</b></span>
              <span class="afe-hbar-track"><span style=${`width: ${(st.count / max) * 100}%;`}></span></span>
            </div>`)}
        </div>`}
      ${a.far > 0 && html`
        <div class="afe-stat-pair" style="margin-top: .9rem;">
          <div><b>${num(a.farDid?.applied)}</b><span>farther out who applied anyway${a.beyond === 'stop' ? ' (before stopping was on)' : ''}</span></div>
          <div><b>${num(a.farDid?.stopped)}</b><span>stopped by the form</span></div>
        </div>`}
    </div>`;
}

/** Part to whole: one bar, a 2px gap between parts, a legend with the numbers */
function StackBar({ parts, total }) {
  const shown = parts.filter(p => p.n > 0);
  return html`
    <div>
      <div class="afe-stack" role="img" aria-label=${parts.map(p => `${p.label}: ${p.n}`).join(', ')}>
        ${total > 0 ? shown.map(p => html`<span style=${`flex: ${p.n} 1 0; background: ${p.color};`} title=${`${p.label}: ${num(p.n)} (${pct(p.n, total)}%)`}></span>`) : html`<span style="flex: 1; background: var(--afe-track);"></span>`}
      </div>
      <div class="afe-legend">
        ${parts.map(p => html`<div><i style=${`background: ${p.color};`}></i><span>${p.label}</span><b>${num(p.n)} <small style="font-weight: 500;">${total ? `${pct(p.n, total)}%` : ''}</small></b>${p.note && html`<small>${p.note}</small>`}</div>`)}
      </div>
    </div>`;
}

function StopBars({ byPage, started }) {
  const max = Math.max(0, ...byPage.map(p => p.leftHere || 0));
  if (!byPage.length) return html`<p class="afe-empty">No pages.</p>`;
  if (!max) return html`<p class="afe-empty">No one has left partway yet.</p>`;
  return html`
    <div class="afe-hbars">
      ${byPage.map((p, i) => html`
        <div class="afe-hbar ${p.leftHere === max ? 'is-top' : ''}">
          <span class="afe-hbar-label"><em>${i + 1}</em>${p.title}${p.leftHere === max && html`<span class="afe-tag">Most stop here</span>`}</span>
          <span class="afe-hbar-val"><b>${num(p.leftHere)}</b> left · ${pct(p.reached, started)}% reached</span>
          <span class="afe-hbar-track"><span style=${`width: ${(p.leftHere / max) * 100}%;`}></span></span>
        </div>`)}
    </div>`;
}

function RankBars({ rows }) {
  if (!rows.length) return html`<p class="afe-empty">No submitted applications yet.</p>`;
  const top = rows.slice(0, 6);
  const rest = rows.slice(6);
  const list = rest.length ? [...top, { source: `Other (${rest.length} more)`, count: rest.reduce((n, r) => n + r.count, 0) }] : top;
  const max = Math.max(1, ...list.map(r => r.count));
  return html`
    <div class="afe-hbars">
      ${list.map((r, i) => html`
        <div class=${`afe-hbar ${i === 0 ? 'is-top' : ''}`}>
          <span class="afe-hbar-label" title=${r.source}>${r.source}</span>
          <span class="afe-hbar-val"><b>${num(r.count)}</b></span>
          <span class="afe-hbar-track"><span style=${`width: ${(r.count / max) * 100}%;`}></span></span>
        </div>`)}
    </div>`;
}

const WEEK = 7 * 864e5;
const niceMax = (n) => { if (n <= 5) return Math.max(1, n); const p = 10 ** Math.floor(Math.log10(n)); return [1, 2, 2.5, 5, 10].map(m => m * p).find(v => v >= n); };
const weekLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Columns per week, every week from the first to the last (empty weeks show as gaps) */
function WeekChart({ perWeek }) {
  const box = useRef(null);
  const width = useWidth(box, 560);
  const [hi, setHi] = useState(null);
  const weeks = useMemo(() => {
    if (!perWeek.length) return [];
    const by = new Map(perWeek.map(w => [w.week, w.count]));
    const start = Date.parse(`${perWeek[0].week}T00:00:00Z`);
    const end = Date.parse(`${perWeek[perWeek.length - 1].week}T00:00:00Z`);
    const out = [];
    for (let t = start; t <= end && out.length < 120; t += WEEK) { const k = new Date(t).toISOString().slice(0, 10); out.push({ week: k, count: by.get(k) || 0 }); }
    return out;
  }, [perWeek]);
  const total = weeks.reduce((n, w) => n + w.count, 0);
  if (!weeks.length) return html`<div ref=${box}><p class="afe-empty">No applications submitted yet.</p></div>`;
  if (weeks.length === 1) return html`<div ref=${box}><p class="afe-sum">All ${num(total)} came in the week of ${weekLabel(weeks[0].week)}.</p></div>`;
  const H = 170;
  const pad = { l: 30, r: 6, t: 8, b: 22 };
  const plotW = Math.max(120, width - pad.l - pad.r);
  const plotH = H - pad.t - pad.b;
  const max = niceMax(Math.max(...weeks.map(w => w.count)));
  const slot = plotW / weeks.length;
  const bw = Math.max(2, Math.min(24, slot - 2));
  const y = (v) => pad.t + plotH - (v / max) * plotH;
  const ticks = max <= 1 ? [0, 1] : [0, max / 2, max].map(v => (Number.isInteger(v) ? v : null)).filter(v => v != null);
  // A month label under the first week of each month, when there's room
  let lastX = -99;
  const labels = [];
  weeks.forEach((w, i) => {
    const d = new Date(`${w.week}T12:00:00Z`);
    const prev = i ? new Date(`${weeks[i - 1].week}T12:00:00Z`) : null;
    if (i === 0 || d.getUTCMonth() !== prev.getUTCMonth()) {
      const x = pad.l + i * slot + slot / 2;
      if (x - lastX > 34) { labels.push({ x, text: d.toLocaleDateString([], { month: 'short', timeZone: 'UTC' }) }); lastX = x; }
    }
  });
  const bar = (i, v) => {
    const x = pad.l + i * slot + (slot - bw) / 2;
    const top = y(v);
    const hgt = pad.t + plotH - top;
    if (hgt <= 0) return '';
    const r = Math.min(4, bw / 2, hgt);
    return `M${x},${pad.t + plotH}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${pad.t + plotH}Z`;
  };
  const tip = hi != null ? weeks[hi] : null;
  return html`
    <div class="afe-chart" ref=${box} onPointerLeave=${() => setHi(null)}>
      <svg width=${width} height=${H} role="img" aria-label=${`Applications per week: ${num(total)} in ${weeks.length} weeks`}>
        ${ticks.map(t => html`<line class="afe-grid" x1=${pad.l} x2=${pad.l + plotW} y1=${Math.round(y(t)) + 0.5} y2=${Math.round(y(t)) + 0.5} /><text class="afe-axis" x=${pad.l - 6} y=${y(t) + 4} text-anchor="end">${t}</text>`)}
        ${weeks.map((w, i) => html`<path class=${`afe-colbar ${hi != null && hi !== i ? 'is-dim' : ''}`} d=${bar(i, w.count)} />`)}
        ${weeks.map((w, i) => html`<rect x=${pad.l + i * slot} y=${pad.t} width=${slot} height=${plotH} fill="transparent" onPointerEnter=${() => setHi(i)} onPointerMove=${() => setHi(i)}><title>${`Week of ${weekLabel(w.week)}: ${w.count}`}</title></rect>`)}
        ${labels.map(l => html`<text class="afe-axis" x=${l.x} y=${H - 6} text-anchor="middle">${l.text}</text>`)}
      </svg>
      ${tip && html`<div class="afe-tip" style=${`left: ${Math.min(width - 60, Math.max(60, pad.l + hi * slot + slot / 2))}px; top: ${Math.max(48, y(tip.count) - 6)}px;`}><b>${tip.count}</b>week of ${weekLabel(tip.week)}</div>`}
      <details style="margin-top: .5rem;">
        <summary class="afe-hint">Show as a table</summary>
        <table class="afe-table"><thead><tr><th>Week of</th><th>Applications</th></tr></thead>
          <tbody>${weeks.map(w => html`<tr><td>${weekLabel(w.week)}</td><td>${w.count}</td></tr>`)}</tbody></table>
      </details>
    </div>`;
}

// ─── The draft (shared by Form, Spanish, Messages, History) ────────
const COALESCE_MS = 600;
const HISTORY_MAX = 200;

/**
 * The definition being edited, its autosave, undo/redo and the two-editor
 * guard. `active` (a draft tab is showing) turns the undo keys on.
 */
function useFormDraft(addToast, active) {
  const [meta, setMeta] = useState(null);       // GET ?form=1: { live, draft, versions, locked, types, year, me, defaults }
  const [work, setWork] = useState(null);       // the definition being edited
  const [problems, setProblems] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | pending | saving | saved | error | conflict
  const [savedAt, setSavedAt] = useState(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [conflict, setConflict] = useState(null);
  const [, bump] = useState(0);
  const workRef = useRef(null);
  const metaRef = useRef(null);
  const past = useRef([]);
  const future = useRef([]);
  const last = useRef({ at: 0, key: null, group: null });
  const base = useRef('');         // the draft's updatedAt this editor last saw ('' = it saw none, so any draft by someone else is a conflict)
  const pending = useRef(null);    // a definition waiting to be saved
  const inflight = useRef(null);   // the save in progress (a promise)
  const timer = useRef(null);
  const conflictRef = useRef(null);
  const toastRef = useRef(addToast);
  toastRef.current = addToast;

  const commit = (def) => { workRef.current = def; setWork(def); };
  metaRef.current = meta;

  const load = async ({ keepHistory = false, from = null } = {}) => {
    const j = from || await call(`${API}?form=1`);
    if (!j.success) { toastRef.current(j.error || 'Could not load the form', 'error'); return null; }
    setMeta(j);
    const def = clone(j.draft?.definition || j.live.definition);
    if (keepHistory && workRef.current) { past.current.push(workRef.current); future.current = []; } else { past.current = []; future.current = []; }
    last.current = { at: 0, key: null, group: null };
    base.current = j.draft?.updatedAt || '';
    pending.current = null;
    commit(def);
    setProblems(j.problems || []);
    setSavedAt(j.draft?.updatedAt || null);
    setStatus('idle');
    return j;
  };
  useEffect(() => { load(); }, []);

  const save = async ({ force = false } = {}) => {
    clearTimeout(timer.current);
    if (inflight.current) { await inflight.current; if (!pending.current) return true; }
    const def = pending.current;
    if (!def) return true;
    if (conflictRef.current && !force) return false;
    pending.current = null;
    setStatus('saving');
    const run = (async () => {
      const j = await call(API, { formSave: def, base: base.current, ...(force ? { force: true } : {}) });
      if (j.conflict) {
        pending.current = pending.current || def;
        conflictRef.current = j.conflict;
        setConflict(j.conflict);
        setStatus('conflict');
        return false;
      }
      if (!j.success) {
        pending.current = pending.current || def;
        setStatus('error');
        toastRef.current(j.error || 'Could not save the draft. Trying again shortly.', 'error');
        timer.current = setTimeout(() => save(), 6000);
        return false;
      }
      base.current = j.updatedAt || base.current;
      setProblems(j.problems || []);
      setSavedAt(j.updatedAt || new Date().toISOString());
      setMeta(m => ({ ...m, draft: { ...(m?.draft || {}), version: j.version, definition: j.definition, updatedAt: j.updatedAt, updatedBy: m?.me || m?.draft?.updatedBy } }));
      setPreviewKey(k => k + 1);
      if (pending.current) { setStatus('pending'); timer.current = setTimeout(() => save(), 300); } else setStatus('saved');
      return true;
    })();
    inflight.current = run;
    const ok = await run;
    inflight.current = null;
    return ok;
  };
  const schedule = (def) => {
    pending.current = def;
    clearTimeout(timer.current);
    if (conflictRef.current) { setStatus('conflict'); return; }
    setStatus('pending');
    timer.current = setTimeout(() => save(), 900);
  };
  /** Save now if anything is waiting; false when it couldn't (a conflict or an error) */
  const flush = async () => {
    clearTimeout(timer.current);
    if (inflight.current) await inflight.current;
    if (conflictRef.current) return false;
    return pending.current ? save() : true;
  };

  /**
   * Change the draft: fn edits a copy in place (return false to cancel).
   * Typing in the same box within 600ms joins the last undo step; `group`
   * joins every change with that name (an AI fill made of several batches).
   */
  const update = (fn, { group = null } = {}) => {
    const cur = workRef.current;
    if (!cur) return;
    const next = clone(cur);
    if (fn(next) === false) return;
    if (JSON.stringify(next) === JSON.stringify(cur)) return;
    const el = document.activeElement;
    const key = isTextEntry(el) ? el : null;
    const now = Date.now();
    const join = (group && group === last.current.group) || (!group && key && key === last.current.key && now - last.current.at < COALESCE_MS);
    if (!join) { past.current.push(cur); if (past.current.length > HISTORY_MAX) past.current.shift(); }
    last.current = { at: now, key, group };
    future.current = [];
    commit(next);
    bump(n => n + 1);
    schedule(next);
  };
  const step = (from, to) => {
    if (!from.current.length || !workRef.current) return;
    const def = from.current.pop();
    to.current.push(workRef.current);
    last.current = { at: 0, key: null, group: null };
    commit(def);
    bump(n => n + 1);
    schedule(def);
  };
  const undo = () => step(past, future);
  const redo = () => step(future, past);

  const resolveConflict = async (choice) => {
    const c = conflictRef.current;
    if (!c) return;
    conflictRef.current = null;
    setConflict(null);
    if (choice === 'mine') {
      const ok = await save({ force: true });
      if (ok) toastRef.current('Your version is saved. Theirs was replaced.', 'success');
      return;
    }
    clearTimeout(timer.current);
    pending.current = null;
    await load({ keepHistory: true });
    toastRef.current(`Showing ${personName(c.updatedBy)}'s version. Undo brings yours back.`, 'info');
  };

  /**
   * The draft changed somewhere else (another editor, another tab, or the
   * Applicants map saving the boundary or putting it live): when nothing here
   * is waiting to save, show the latest. Runs on focus and on entering a
   * draft tab. A change by this same person is picked up quietly.
   */
  const refresh = async () => {
    if (document.visibilityState === 'hidden' || !metaRef.current || pending.current || inflight.current || conflictRef.current) return;
    const j = await call(`${API}?form=1`);
    if (!j.success || pending.current || inflight.current || conflictRef.current) return;
    const theirs = j.draft;
    const moved = (theirs?.updatedAt || '') !== base.current || j.live?.version !== metaRef.current?.live?.version;
    if (!moved) return;
    await load({ keepHistory: true, from: j });
    if (theirs && theirs.updatedBy && theirs.updatedBy !== j.me) toastRef.current(`${personName(theirs.updatedBy)} changed the draft at ${clock(theirs.updatedAt)}. You're seeing their latest.`, 'info');
  };
  useEffect(() => {
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => { document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  useEffect(() => { if (active) refresh(); }, [active]);

  // Save when leaving the page with changes still waiting
  useEffect(() => {
    const out = () => {
      if (!pending.current || conflictRef.current) return;
      const body = JSON.stringify({ formSave: pending.current, base: base.current });
      navigator.sendBeacon?.(API, new Blob([body], { type: 'application/json' }));
    };
    window.addEventListener('pagehide', out);
    return () => { window.removeEventListener('pagehide', out); clearTimeout(timer.current); if (pending.current && !conflictRef.current) save(); };
  }, []);

  // ⌘Z / ⇧⌘Z / Ctrl+Y step the draft, except in a text box (its own undo) or a dialog; ⌘S saves now
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const isUndo = k === 'z' && !e.shiftKey;
      const isRedo = (k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey && !e.metaKey);
      if (!isUndo && !isRedo) return;
      if (isTextEntry(e.target) || document.querySelector('.afe-overlay')) return;
      e.preventDefault();
      if (isUndo) undo(); else redo();
    };
    const onSave = async () => { if (pending.current && (await flush())) toastRef.current('Draft saved.', 'success'); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('soard-save', onSave);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('soard-save', onSave); };
  }, [active]);

  const putLive = async () => {
    if (!(await flush())) return false;
    const j = await call(API, { formPutLive: true });
    if (!j.success) { toastRef.current(j.error || 'Could not put it live', 'error'); if (j.problems) setProblems(j.problems); return false; }
    toastRef.current(`Version ${j.version} is live. Families see it now.`, 'success');
    await load();
    return true;
  };
  const discard = async () => {
    clearTimeout(timer.current);
    if (!confirm('Throw away the changes that aren’t live yet? Undo can bring them back while this page is open.')) return;
    if (inflight.current) await inflight.current;
    pending.current = null;
    conflictRef.current = null;
    setConflict(null);
    await call(API, { formDiscard: true });
    toastRef.current('Changes discarded.', 'success');
    await load({ keepHistory: true });
  };
  const restore = async (v) => {
    await flush();
    if (meta?.draft && !confirm('Replace the changes you haven’t put live with this version?')) return;
    const j = await call(API, { formRestore: v });
    if (!j.success) { toastRef.current(j.error || 'Could not restore it', 'error'); return; }
    toastRef.current(`${v ? `Version ${v}` : 'The built-in form'} is now your draft. Look it over, then put it live.`, 'success');
    await load({ keepHistory: true });
  };

  // Values each choice question has in the live form: those never change (answers point at them)
  const liveValues = useMemo(() => {
    const out = {};
    for (const p of meta?.live?.definition?.pages || []) for (const f of p.fields || []) if (f.options) out[f.id] = new Set(f.options.map(o => choice(o).value));
    return out;
  }, [meta?.live]);
  /** A question id nobody has used: not in the draft, the live form or the JobTread list */
  const newId = () => {
    const used = new Set(Object.keys(meta?.locked || {}));
    for (const def of [workRef.current, meta?.live?.definition]) for (const p of def?.pages || []) for (const f of p.fields || []) used.add(f.id);
    return newFieldId(used);
  };

  const hasDraft = !!meta?.draft || ['pending', 'saving', 'conflict', 'error'].includes(status);
  return {
    meta, work, problems, status, savedAt, previewKey, conflict, hasDraft, liveValues,
    update, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0,
    putLive, discard, restore, flush, resolveConflict, newId, year: meta?.year || '2027',
  };
}

/** The draft's state and its actions, kept in view; `lead` (the Form's views) sits at its start */
function DraftBar({ d, onPreview, previewOn, lead = null, emails = false }) {
  const { meta, status, savedAt, problems, hasDraft } = d;
  const [diff, setDiff] = useState(null); // { loading } | { changes } | { error }
  if (!meta) return lead ? html`<div class="afe-bar has-lead"><div class="afe-bar-lead">${lead}</div></div>` : null;
  const saving = status === 'pending' || status === 'saving';
  const liveText = meta.live.builtIn ? 'the built-in form' : `version ${meta.live.version}`;
  const sub = status === 'conflict' ? 'Not saved: choose a version above'
    : saving ? 'Saving…'
    : status === 'error' ? 'Not saved yet; trying again'
    : `Draft saved ${clock(savedAt)}`;
  const openPutLive = async () => {
    if (!(await d.flush())) return;
    setDiff({ loading: true });
    const j = await call(`${API}?form-diff=draft`);
    setDiff(j.success ? { changes: j.changes || [] } : { error: j.error || 'Could not load the changes' });
  };
  const confirmLive = async () => {
    setDiff(x => ({ ...x, busy: true }));
    const ok = await d.putLive();
    if (ok) setDiff(null); else setDiff(x => ({ ...x, busy: false }));
  };
  return html`
    ${d.conflict && html`<${ConflictBanner} d=${d} />`}
    <div class="afe-bar ${lead ? 'has-lead' : ''}" data-status=${status}>
      ${lead && html`<div class="afe-bar-lead">${lead}</div>`}
      <div class="afe-bar-text">
        ${hasDraft
          ? html`<strong><span class="afe-dot is-draft"></span>You have changes that aren't live yet</strong>
              <span class="text-sm text-muted">${sub} · families still see ${liveText}</span>`
          : html`<strong><span class="afe-dot"></span>${!emails ? `Families see ${liveText}` : meta.live.builtIn ? 'Families get the built-in emails' : `Families get the emails from version ${meta.live.version}`}</strong>
              <span class="text-sm text-muted">${meta.live.liveAt ? `Put live ${when(meta.live.liveAt)}${meta.live.liveBy ? ` by ${personName(meta.live.liveBy)}` : ''}` : emails ? 'The wording the site started with' : 'Matches the Jotform application for 2027'}. Changes save as a draft until you put them live.</span>`}
      </div>
      <div class="afe-bar-actions">
        <span class="afe-seg" role="group" aria-label="Undo and redo">
          <button class="afe-icon-btn" disabled=${!d.canUndo} onClick=${d.undo} aria-label="Undo" title=${`Undo (${MOD}Z). In a text box, ${MOD}Z undoes your typing there.`}><${Icon} name="undo" /></button>
          <button class="afe-icon-btn" disabled=${!d.canRedo} onClick=${d.redo} aria-label="Redo" title=${`Redo (⇧${MOD}Z)`}><${Icon} name="redo" /></button>
        </span>
        ${onPreview && html`<button class="btn btn-ghost" aria-pressed=${!!previewOn} onClick=${onPreview}>${previewOn ? 'Hide preview' : 'Preview'}</button>`}
        ${hasDraft && html`<button class="btn btn-ghost" onClick=${d.discard}>Discard</button>`}
        ${hasDraft && html`<button class="btn btn-primary" disabled=${saving || problems.length > 0 || !!d.conflict} title=${problems.length ? 'Fix the problems listed first' : ''} onClick=${openPutLive}>Put live</button>`}
      </div>
    </div>
    ${diff && html`
      <${Dialog} wide title="What's changing" onClose=${() => !diff.busy && setDiff(null)} footer=${html`
        <span class="afe-hint">Families see this right away. Applications already submitted keep the version they were answered on.</span>
        <button class="btn btn-ghost" onClick=${() => setDiff(null)} disabled=${diff.busy}>Cancel</button>
        <button class="btn btn-primary" data-autofocus onClick=${confirmLive} disabled=${diff.loading || diff.busy || !!diff.error}>${diff.busy ? 'Putting live…' : 'Put live'}</button>`}>
        ${diff.loading && html`<p class="afe-hint">Comparing with what families see…</p>`}
        ${diff.error && html`<p class="afe-bad">${diff.error}</p>`}
        ${diff.changes && html`<${ChangesList} changes=${diff.changes} empty="Nothing differs from what families see now." />`}
      <//>`}`;
}

function ConflictBanner({ d }) {
  const c = d.conflict;
  return html`
    <div class="afe-conflict" role="alert">
      <div>
        <strong>${c.updatedBy && c.updatedBy === d.meta?.me ? 'You saved changes in another tab or window' : `${personName(c.updatedBy)} saved changes`} at ${clock(c.updatedAt)}.</strong>
        <span class="text-sm text-muted">Your edits since then aren't saved, and saving is paused until you pick one.</span>
      </div>
      <div class="afe-row-actions">
        <button class="btn btn-ghost" onClick=${() => d.resolveConflict('theirs')}>Load their version</button>
        <button class="btn btn-primary" onClick=${() => d.resolveConflict('mine')}>Keep mine</button>
      </div>
    </div>`;
}

function Problems({ problems, onJump }) {
  if (!problems.length) return null;
  return html`
    <div class="afe-problems" role="alert">
      <strong>${problems.length === 1 ? '1 thing to fix' : `${problems.length} things to fix`} before this can go live</strong>
      <ul>${problems.map(p => html`<li>${p.where && onJump ? html`<button onClick=${() => onJump(p.where)}>${p.where}</button>: ` : ''}${p.message}</li>`)}</ul>
    </div>`;
}

const AREA_ORDER = ['Pages', 'Questions', 'Choices', 'Rules', 'JobTread', 'Stop screens', 'Messages', 'Reminders', 'Settings', 'Spanish'];
const KIND_LABEL = { added: 'Added', removed: 'Removed', changed: 'Changed', moved: 'Moved' };

/** The server's change list, grouped by area */
function ChangesList({ changes, empty }) {
  if (!changes.length) return html`<p class="afe-empty">${empty}</p>`;
  const groups = new Map();
  for (const c of changes) { if (!groups.has(c.area)) groups.set(c.area, []); groups.get(c.area).push(c); }
  const areas = [...groups.keys()].sort((a, b) => ((AREA_ORDER.indexOf(a) + 1) || 99) - ((AREA_ORDER.indexOf(b) + 1) || 99));
  return html`
    <p class="afe-hint" style="margin-bottom: .75rem;">${plural(changes.length, 'change')}</p>
    <div class="afe-diff">
      ${areas.map(area => html`
        <section>
          <h4>${area} <span class="afe-tab-count">${groups.get(area).length}</span></h4>
          <ul>${groups.get(area).map(c => html`<li><span class="afe-kind is-${c.kind}">${KIND_LABEL[c.kind] || c.kind}</span><span>${c.text}</span></li>`)}</ul>
        </section>`)}
    </div>`;
}

// ─── Form: the questions, their Spanish, and the versions that went live ──
function FormArea({ d, view, onView, spanishLeft, RichTextEditor, addToast, initialSel, go }) {
  const nav = html`
    <div class="afe-seg afe-seg-text afe-subnav" role="group" aria-label="Form">
      ${FORM_VIEWS.map(([k, label]) => html`<button aria-pressed=${view === k} data-view=${k} onClick=${() => onView(k)}>${label}${k === 'spanish' && spanishLeft > 0 && html`<span class="afe-tab-count" title=${`${spanishLeft} missing or out of date`}>${spanishLeft}</span>`}</button>`)}
    </div>`;
  return html`
    <div>
      <${Head} title="Form" sub=${html`The application families fill in at <a href="/apply/form/" target="_blank" rel="noopener">/apply/form/</a>. Every edit saves as a draft, and Put live makes it what families see. Questions that feed JobTread can be reworded and moved, never removed.`}>
        <${TestRunButton} d=${d} />
        <${SampleButton} d=${d} addToast=${addToast} />
      <//>
      ${view === 'questions' && html`<${FormEditor} d=${d} lead=${nav} RichTextEditor=${RichTextEditor} addToast=${addToast} initialSel=${initialSel} go=${go} />`}
      ${view === 'spanish' && html`<${SpanishTab} d=${d} lead=${nav} RichTextEditor=${RichTextEditor} addToast=${addToast} />`}
      ${view === 'versions' && html`<${VersionsView} d=${d} lead=${nav} />`}
    </div>`;
}

// ─── Form editor ───────────────────────────────────────────────────
const findField = (work, id) => {
  for (let pi = 0; pi < work.pages.length; pi++) {
    const fi = work.pages[pi].fields.findIndex(f => f.id === id);
    if (fi >= 0) return { pi, fi, f: work.pages[pi].fields[fi] };
  }
  return null;
};
const fieldName = (f, year, types = {}) => (ANSWERED(f.type) ? fill(f.label, year) : f.type === 'guidelines' ? (f.title || 'Guidelines') : f.type === 'image' ? (f.alt || 'Image') : strip(fill(f.html, year))) || types[f.type] || f.type;
const focusSoon = (sel) => requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(sel)?.focus()));
const narrow = () => { try { return matchMedia('(max-width: 1100px)').matches; } catch { return false; } };

function FormEditor({ d, RichTextEditor, addToast, initialSel = null, lead = null, go = () => {} }) {
  const { work, meta } = d;
  const [sel, setSel] = useState(initialSel || { kind: 'page', id: null, at: 0 });
  const [preview, setPreview] = useState(() => store.get('afe-preview') === '1');
  const [folded, setFolded] = useState(() => new Set());
  const inspector = useRef(null);
  if (!work || !meta) return html`<div><${DraftBar} d=${d} lead=${lead} /><${Spinner} /></div>`;
  const locked = meta.locked || {};
  const types = meta.types || {};
  const year = d.year;
  const problemFor = (where) => d.problems.some(p => p.where === where);

  // The selection follows its id through moves and undo
  const pageAt = sel.kind === 'page' ? (() => { const i = sel.id ? work.pages.findIndex(p => p.id === sel.id) : -1; return i >= 0 ? i : Math.min(sel.at || 0, work.pages.length - 1); })() : -1;
  const found = sel.kind === 'field' ? findField(work, sel.id) : null;
  const select = (s, { scroll = false } = {}) => {
    setSel(s);
    if (scroll && narrow()) requestAnimationFrame(() => inspector.current?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }));
  };
  const selectPage = (pi, opts) => select({ kind: 'page', id: work.pages[pi]?.id, at: pi }, opts);
  const selectField = (id, opts) => select({ kind: 'field', id }, opts);
  const focus = sel.kind === 'field' ? sel.id : sel.kind === 'page' ? work.pages[pageAt]?.id : null;

  const jump = (where) => {
    if (where.startsWith('stops/')) { select({ kind: 'stop', key: where.slice(6) }, { scroll: true }); return; }
    if (where.startsWith('messages/') || where === 'reminders') { go('emails'); return; }
    if (where === 'staffEmails' || where === 'serviceArea') { go('settings'); return; }
    const [pid, fid] = where.split('/');
    if (fid && findField(work, fid)) { selectField(fid, { scroll: true }); return; }
    const pi = work.pages.findIndex(p => p.id === pid);
    if (pi >= 0) { selectPage(pi, { scroll: true }); return; }
    if (findField(work, where)) selectField(where, { scroll: true });
  };

  // ── Moving ──
  /** One step up or down; past the end of a page it goes on to the next page */
  const moveField = (id, dir, refocus = false) => d.update((w) => {
    const at = findField(w, id);
    if (!at) return false;
    const list = w.pages[at.pi].fields;
    const to = at.fi + dir;
    if (to >= 0 && to < list.length) { [list[at.fi], list[to]] = [list[to], list[at.fi]]; }
    else if (dir < 0 && at.pi > 0) { list.splice(at.fi, 1); w.pages[at.pi - 1].fields.push(at.f); }
    else if (dir > 0 && at.pi < w.pages.length - 1) { list.splice(at.fi, 1); w.pages[at.pi + 1].fields.unshift(at.f); }
    else return false;
    if (refocus) focusSoon(`.afe-row[data-id="${id}"] .afe-row-main`);
  });
  const movePage = (pi, dir, refocus = false) => d.update((w) => {
    const to = pi + dir;
    if (to < 0 || to >= w.pages.length) return false;
    [w.pages[pi], w.pages[to]] = [w.pages[to], w.pages[pi]];
    if (refocus) focusSoon(`.afe-page[data-id="${w.pages[to].id}"] .afe-title`);
  });
  const dropField = ({ from, to, oldIndex, newIndex, id }) => d.update((w) => {
    const src = w.pages.find(p => p.id === from);
    const dst = w.pages.find(p => p.id === to);
    if (!src || !dst) return false;
    const i = src.fields.findIndex(f => f.id === id);
    const [me] = src.fields.splice(i >= 0 ? i : oldIndex, 1);
    dst.fields.splice(Math.min(newIndex, dst.fields.length), 0, me);
  });
  const dropPage = ({ oldIndex, newIndex }) => d.update((w) => {
    const [p] = w.pages.splice(oldIndex, 1);
    w.pages.splice(newIndex, 0, p);
  });

  // ── Adding and copying ──
  const addField = (pi, type) => {
    const id = d.newId();
    d.update((w) => {
      const f = { id, type };
      if (ANSWERED(type)) f.label = 'New question';
      if (['radio', 'select', 'checkbox'].includes(type)) f.options = ['First choice', 'Second choice'];
      if (type === 'ack') f.options = ['Yes, I agree.'];
      if (type === 'content') f.html = '<p>New text</p>';
      if (type === 'image') Object.assign(f, { image: '', alt: '', width: 938, height: 768 });
      w.pages[pi].fields.push(f);
    });
    selectField(id);
    if (ANSWERED(type)) focusSoon('#afe-f-label');
  };
  const addPage = () => {
    const ids = new Set(work.pages.map(p => p.id));
    let n = work.pages.length + 1;
    while (ids.has(`page-${n}`)) n++;
    const at = Math.max(0, work.pages.length - 1); // before the signature page, so it stays last
    d.update((w) => { w.pages.splice(at, 0, { id: `page-${n}`, title: 'New page', fields: [{ id: d.newId(), type: 'content', html: '<p>New text</p>' }] }); });
    select({ kind: 'page', id: `page-${n}`, at });
    focusSoon('#afe-page-title');
  };
  /** A copy right below, with a new id. A JobTread question's copy is an ordinary question. */
  const dupField = (id) => {
    const at = findField(work, id);
    if (!at) return;
    const copyId = d.newId();
    d.update((w) => {
      const c = clone(w.pages[at.pi].fields[at.fi]);
      c.id = copyId;
      delete c.jobtread;
      w.pages[at.pi].fields.splice(at.fi + 1, 0, c);
    });
    selectField(copyId);
    addToast(locked[id] ? 'Copied. The copy is an ordinary question; only the original feeds JobTread.' : 'Copied.', 'success');
  };
  const dupPage = (pi) => {
    const src = work.pages[pi];
    const pageIds = new Set(work.pages.map(p => p.id));
    const stem = `${src.id.replace(/-copy(-\d+)?$/, '')}`.slice(0, 30);
    let pid = `${stem}-copy`;
    for (let n = 2; pageIds.has(pid); n++) pid = `${stem}-copy-${n}`;
    d.update((w) => {
      const p = clone(w.pages[pi]);
      const used = new Set();
      for (const pg of w.pages) for (const f of pg.fields) used.add(f.id);
      for (const k of Object.keys(locked)) used.add(k);
      for (const pg of meta.live?.definition?.pages || []) for (const f of pg.fields || []) used.add(f.id);
      const map = new Map();
      for (const f of p.fields) { const nid = newFieldId(used); used.add(nid); map.set(f.id, nid); f.id = nid; delete f.jobtread; }
      // Rules inside the copy point at the copy's own questions
      for (const f of p.fields) if (f.showIf) { const r = mapRule(f.showIf, l => ({ ...l, field: map.get(l.field) || l.field })); if (r) f.showIf = r; else delete f.showIf; }
      p.id = pid;
      p.title = `${p.title} (copy)`;
      w.pages.splice(pi + 1, 0, p);
    });
    select({ kind: 'page', id: pid, at: pi + 1 });
    addToast('Page copied. Rename it before you put it live.', 'success');
    focusSoon('#afe-page-title');
  };
  const toggleFold = (id) => setFolded(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // ── Keyboard on the outline ──
  // Each row's main button carries the keys (Enter clicks it like any button): ↑/↓ walk the list, Alt+↑/↓ move
  const rowKey = (e, f) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    if (e.altKey) { moveField(f.id, dir, true); return; }
    const rows = [...document.querySelectorAll('.afe-col .afe-row-main[data-id]')];
    const next = rows[rows.indexOf(e.currentTarget) + dir];
    if (next) { next.focus(); selectField(next.dataset.id); }
  };
  const titleKey = (e, pi) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    movePage(pi, e.key === 'ArrowUp' ? -1 : 1, true);
  };
  const togglePreview = () => { d.flush(); setPreview(p => { store.set('afe-preview', p ? '0' : '1'); return !p; }); };
  // A phone has no room beside the editor for a phone preview; "Open in a new tab" is the way there
  const phone = (() => { try { return matchMedia('(max-width: 768px)').matches; } catch { return false; } })();
  const showPreview = preview && !phone;
  const total = work.pages.reduce((n, p) => n + p.fields.length, 0);

  return html`
    <div>
      <${DraftBar} d=${d} lead=${lead} onPreview=${phone ? null : togglePreview} previewOn=${showPreview} />
      <${Problems} problems=${d.problems} onJump=${jump} />
      <div class="afe-cols ${showPreview ? 'has-preview' : ''}">
        <div class="afe-col">
          <${SortList} class="afe-pages" listKey="pages" handle=".afe-page-grip" draggable=".afe-page" onDrop=${dropPage}>
            ${work.pages.map((p, pi) => {
              const open = !folded.has(p.id);
              return html`
                <section key=${p.id} class="afe-panel afe-page ${pageAt === pi ? 'is-sel' : ''}" data-id=${p.id} aria-label=${`Page ${pi + 1}: ${fill(p.title, year)}`}>
                  <div class="afe-page-head">
                    <span class="afe-grip afe-page-grip" title="Drag to move this page (or Alt+↑/↓ on its title)"><${Icon} name="grip" /></span>
                    <button class="afe-collapse" aria-expanded=${open} aria-label=${`${open ? 'Fold' : 'Unfold'} page ${pi + 1}`} onClick=${() => toggleFold(p.id)}><${Icon} name="chevron" /></button>
                    <button class="afe-title ${pageAt === pi ? 'is-sel' : ''}" onClick=${() => selectPage(pi, { scroll: true })} onKeyDown=${(e) => titleKey(e, pi)}>
                      <span class="afe-num">Page ${pi + 1}</span><span class="afe-title-text">${fill(p.title, year) || 'Untitled page'}</span>
                    </button>
                    ${p.showIf && html`<span class="badge badge-yellow" title="Shown only for some answers">If…</span>`}
                    <span class="afe-mini">
                      <button aria-label=${`Move page ${pi + 1} up`} title="Move up (Alt+↑)" disabled=${pi === 0} onClick=${() => movePage(pi, -1)}><${Icon} name="up" size=${14} /></button>
                      <button aria-label=${`Move page ${pi + 1} down`} title="Move down (Alt+↓)" disabled=${pi === work.pages.length - 1} onClick=${() => movePage(pi, 1)}><${Icon} name="down" size=${14} /></button>
                      <button aria-label=${`Duplicate page ${pi + 1}`} title="Duplicate page" onClick=${() => dupPage(pi)}><${Icon} name="copy" size=${14} /></button>
                    </span>
                  </div>
                  ${open ? html`
                    <${SortList} class="afe-rows" listKey=${p.id} group="afe-fields" handle=".afe-row-grip" draggable=".afe-row" onDrop=${dropField}>
                      ${p.fields.map((f, fi) => {
                        const isSel = sel.kind === 'field' && sel.id === f.id;
                        const label = fieldName(f, year);
                        const first1 = pi === 0 && fi === 0;
                        const last1 = pi === work.pages.length - 1 && fi === p.fields.length - 1;
                        return html`
                          <div key=${f.id} class="afe-row ${isSel ? 'is-sel' : ''} ${problemFor(`${p.id}/${f.id}`) ? 'has-problem' : ''}" data-id=${f.id}
                            onClick=${() => selectField(f.id, { scroll: true })}>
                            <span class="afe-grip afe-row-grip" title="Drag to move (or Alt+↑/↓)" onClick=${(e) => e.stopPropagation()}><${Icon} name="grip" size=${14} /></span>
                            <button type="button" class="afe-row-main" data-id=${f.id} aria-current=${isSel ? 'true' : undefined} onKeyDown=${(e) => rowKey(e, f)}>
                              <span class="afe-type" title=${types[f.type] || f.type}>${ROW_TYPE[f.type] || types[f.type] || f.type}</span>
                              <span class="afe-row-label">${label || html`<em class="text-muted">No wording yet</em>`}</span>
                              <span class="afe-row-badges">
                                ${locked[f.id] && html`<span class="badge badge-blue" title=${locked[f.id].role}>JobTread</span>`}
                                ${f.jobtread && html`<span class="badge badge-blue" title=${`Fills JobTread's "${f.jobtread.name}"`}>→ JobTread</span>`}
                                ${f.required && html`<span class="badge badge-gray">Required</span>`}
                                ${f.showIf && html`<span class="badge badge-yellow" title="Shown only for some answers">If…</span>`}
                                ${f.stops && Object.keys(f.stops).length > 0 && html`<span class="badge badge-gray" title="An answer ends the application">Ends</span>`}
                              </span>
                            </button>
                            <span class="afe-mini" onClick=${(e) => e.stopPropagation()}>
                              <button aria-label="Move up" title="Move up (Alt+↑)" disabled=${first1} onClick=${() => moveField(f.id, -1)}><${Icon} name="up" size=${14} /></button>
                              <button aria-label="Move down" title="Move down (Alt+↓)" disabled=${last1} onClick=${() => moveField(f.id, 1)}><${Icon} name="down" size=${14} /></button>
                              <button aria-label="Duplicate" title="Duplicate" onClick=${() => dupField(f.id)}><${Icon} name="copy" size=${14} /></button>
                            </span>
                          </div>`;
                      })}
                      ${!p.fields.length && html`<div class="afe-rows-empty">Drag questions here</div>`}
                    <//>
                    <div class="afe-add">
                      <label class="text-sm text-muted" for=${`afe-add-${pi}`}>Add to this page</label>
                      <select id=${`afe-add-${pi}`} class="form-input" value="" onChange=${(e) => { if (e.target.value) addField(pi, e.target.value); e.target.value = ''; }}>
                        <option value="">Choose a question type…</option>
                        ${ADDABLE.map(t => html`<option value=${t}>${types[t] || t}</option>`)}
                      </select>
                    </div>`
                    : html`<p class="afe-folded">${plural(p.fields.length, 'item')} folded away</p>`}
                </section>`;
            })}
          <//>
          <div class="afe-row-actions">
            <button class="btn btn-ghost" onClick=${addPage}><${Icon} name="plus" size=${14} /> Add a page</button>
            <span class="afe-hint">${plural(work.pages.length, 'page')}, ${plural(total, 'item')}</span>
          </div>

          <section class="afe-panel">
            <div class="afe-page-head"><strong style="padding: .3rem .4rem;">Stop screens</strong></div>
            <p class="afe-hint" style="margin: 0 0 .5rem;">What a family sees when an answer means we can't help this time. Pick them on a question's choices.</p>
            <div class="afe-rows">
              ${Object.entries(work.stops || {}).map(([k, s]) => html`
                <button class="afe-row ${sel.kind === 'stop' && sel.key === k ? 'is-sel' : ''}" style="padding-left: .55rem;" onClick=${() => select({ kind: 'stop', key: k }, { scroll: true })}>
                  <span class="afe-type">Stop</span><span class="afe-row-label">${strip(s.body) || s.title}</span>
                </button>`)}
            </div>
            <div class="afe-add"><button class="btn btn-ghost btn-sm" onClick=${() => {
              let n = 1; while (work.stops?.[`stop-${n}`]) n++;
              d.update((w) => { w.stops = w.stops || {}; w.stops[`stop-${n}`] = { title: 'Thank you so much for your interest in Sunshine on a Ranney Day.', body: '<p></p>' }; });
              select({ kind: 'stop', key: `stop-${n}` }, { scroll: true });
            }}><${Icon} name="plus" size=${14} /> Add a stop screen</button></div>
          </section>

          <p class="afe-hint afe-form-foot">Who gets the new-application email, the service area and when status emails go out are in <button class="afe-link" onClick=${() => go('settings')}>Settings</button>. The emails' wording is in <button class="afe-link" onClick=${() => go('emails')}>Emails</button>.</p>
        </div>

        <div class="afe-col">
          <div class="afe-panel afe-inspector" ref=${inspector}>
            <button class="afe-link afe-back" onClick=${() => document.querySelector('.afe-col .afe-row.is-sel, .afe-page.is-sel')?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })}><${Icon} name="up" size=${14} /> Back to the list</button>
            ${sel.kind === 'field' && found && html`<${FieldInspector} key=${found.f.id} d=${d} pi=${found.pi} fi=${found.fi} f=${found.f} locked=${locked[found.f.id]} types=${types} RichTextEditor=${RichTextEditor} onSelect=${select} onDuplicate=${() => dupField(found.f.id)} addToast=${addToast} />`}
            ${sel.kind === 'page' && work.pages[pageAt] && html`<${PageInspector} key=${`p${work.pages[pageAt].id}`} d=${d} pi=${pageAt} locked=${locked} onSelect=${select} onDuplicate=${() => dupPage(pageAt)} />`}
            ${sel.kind === 'stop' && work.stops?.[sel.key] && html`<${StopInspector} key=${`s${sel.key}`} d=${d} k=${sel.key} RichTextEditor=${RichTextEditor} onSelect=${select} />`}
            ${((sel.kind === 'field' && !found) || (sel.kind === 'page' && !work.pages[pageAt]) || (sel.kind === 'stop' && !work.stops?.[sel.key])) && html`<p class="afe-empty">Pick a page or question on the left.</p>`}
          </div>
        </div>

        ${showPreview && html`<${PreviewPane} d=${d} focus=${focus} onClose=${togglePreview} />`}
      </div>
    </div>`;
}

/**
 * The phone preview: /apply/form/?preview=live, which says
 * { type: 'afe-preview-ready' } when it boots. From then on every draft
 * change (250ms after the last) and every selection goes to it as
 * { type: 'afe-preview', definition, lang, focus }. If it never says ready,
 * the frame falls back to the last saved draft and reloads after each save.
 */
function PreviewPane({ d, focus, onClose }) {
  const frame = useRef(null);
  const ready = useRef(false);
  const [mode, setMode] = useState('live'); // live | saved
  const [isReady, setIsReady] = useState(false);
  const [lang, setLang] = useState('en');
  const latest = useRef({});
  latest.current = { def: d.work, lang, focus };
  const post = () => {
    const win = frame.current?.contentWindow;
    if (!win || !ready.current) return;
    try { win.postMessage({ type: 'afe-preview', definition: latest.current.def, lang: latest.current.lang, focus: latest.current.focus || null }, location.origin); } catch { /* the frame went away */ }
  };
  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'afe-preview-ready') { ready.current = true; setIsReady(true); setMode('live'); post(); }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  useEffect(() => { const t = setTimeout(post, 250); return () => clearTimeout(t); }, [d.work]);
  useEffect(() => { post(); }, [focus, lang]);
  const onLoad = () => {
    if (mode !== 'live') return;
    setTimeout(() => { if (!ready.current) setMode('saved'); }, 3500);
  };
  const src = mode === 'live' ? '/apply/form/?preview=live' : `/apply/form/?preview=${d.hasDraft ? 'draft' : '1'}${lang === 'es' ? '&lang=es' : ''}&k=${d.previewKey}`;
  return html`
    <div class="afe-preview" data-mode=${mode} data-ready=${isReady ? 'true' : 'false'}>
      <div class="afe-preview-head">
        <strong>Phone preview</strong>
        <span class="afe-row-actions" style="gap: .35rem;">
          <span class="afe-seg afe-seg-text" role="group" aria-label="Preview language">
            <button aria-pressed=${lang === 'en'} onClick=${() => setLang('en')}>EN</button>
            <button aria-pressed=${lang === 'es'} onClick=${() => setLang('es')}>ES</button>
          </span>
          <a class="afe-icon-btn" href=${`/apply/form/?preview=${d.hasDraft ? 'draft' : '1'}`} target="_blank" rel="noopener" aria-label="Open the preview in a new tab" title="Open in a new tab" onClick=${() => d.flush()}><${Icon} name="ext" /></a>
          <button class="afe-icon-btn" aria-label="Close the preview" title="Close" onClick=${onClose}><${Icon} name="close" /></button>
        </span>
      </div>
      <div class="afe-phone">
        <iframe ref=${frame} key=${mode === 'live' ? 'live' : `saved-${d.previewKey}-${lang}`} title="Preview of the application as families see it" src=${src} onLoad=${onLoad}></iframe>
      </div>
      <p class="afe-hint" aria-live="polite">${mode === 'live' ? (isReady ? 'Updates as you edit. Answers typed here are never saved.' : 'Loading the preview…') : 'Shows your last saved draft and refreshes after each save. Answers typed here are never saved.'}</p>
    </div>`;
}

const Field = ({ label, hint, children, id }) => html`
  <div class="afe-field">
    ${label && html`<label for=${id}>${label}</label>`}
    ${children}
    ${hint && html`<span class="afe-hint">${hint}</span>`}
  </div>`;
const Section = ({ title, children }) => html`<div class="afe-sec"><span class="afe-sec-title">${title}</span>${children}</div>`;

/** Choice questions a rule may point at, as { id, label, options: [{ value, label }] } */
const ruleChoices = (fields, year) => fields.filter(x => CHOICE_TYPES.includes(x.type)).map(x => ({ id: x.id, label: strip(fill(x.label, year)) || x.id, options: (x.options || []).map(choice).map(c => ({ value: c.value, label: strip(fill(c.label, year)) || c.value })) }));

function PageInspector({ d, pi, locked, onSelect, onDuplicate }) {
  const { work, year } = d;
  const p = work.pages[pi];
  const hasLocked = p.fields.some(f => locked[f.id]);
  const mustShow = p.fields.some(f => locked[f.id]?.required);
  const set = (k, v) => d.update((w) => { w.pages[pi][k] = v; });
  const earlier = ruleChoices(work.pages.slice(0, pi).flatMap(x => x.fields), year);
  const del = () => {
    if (!confirm(`Delete page ${pi + 1} and everything on it?`)) return;
    d.update((w) => { const ids = new Set(w.pages[pi].fields.map(f => f.id)); w.pages.splice(pi, 1); dropFromRules(w, ids); });
    onSelect({ kind: 'page', id: work.pages[Math.max(0, pi - 1)]?.id, at: Math.max(0, pi - 1) });
  };
  return html`
    <div class="afe-insp-head">
      <div><span class="afe-crumb">Page ${pi + 1} of ${work.pages.length}</span><h3>${fill(p.title, year) || 'Untitled page'}</h3></div>
      <span class="afe-row-actions" style="gap: .25rem;">
        <button class="afe-icon-btn" aria-label="Duplicate this page" title="Duplicate this page" onClick=${onDuplicate}><${Icon} name="copy" /></button>
      </span>
    </div>
    <${Field} label="Title" id="afe-page-title" hint="Shown above the questions. {year} becomes the season year.">
      <input id="afe-page-title" class="form-input" value=${p.title} onInput=${(e) => set('title', e.target.value)} />
    <//>
    <${Field} label="Page id" id="afe-page-id" hint="Lowercase letters, numbers and dashes. Only used behind the scenes.">
      <input id="afe-page-id" class="form-input" value=${p.id} onInput=${(e) => {
        const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
        set('id', v);
        onSelect({ kind: 'page', id: v, at: pi });
      }} />
    <//>
    <${Section} title="Show this page">
      <${RuleBuilder} rule=${p.showIf} eligible=${earlier} year=${year} noun="page"
        disabledText=${mustShow ? 'Always shown: it has questions JobTread needs.' : null}
        onChange=${(r) => d.update((w) => { if (r) w.pages[pi].showIf = r; else delete w.pages[pi].showIf; })} />
    <//>
    <${Section} title="Page">
      <p class="afe-hint" style="margin: 0 0 .6rem;">${plural(p.fields.length, 'item')} on this page.</p>
      <button class="btn btn-ghost btn-sm afe-btn-danger" disabled=${hasLocked || work.pages.length === 1}
        title=${hasLocked ? 'This page has questions that feed JobTread; move them to another page first.' : ''} onClick=${del}><${Icon} name="trash" size=${14} /> Delete this page</button>
      ${hasLocked && html`<p class="afe-hint" style="margin-top: .4rem;">This page has questions that feed JobTread. Move them to another page to delete it.</p>`}
    <//>`;
}

function FieldInspector({ d, pi, fi, f, locked, types, RichTextEditor, onSelect, onDuplicate, addToast }) {
  const { work, year } = d;
  const up = (fn) => d.update((w) => fn(w.pages[pi].fields[fi], w));
  const id = (k) => `afe-f-${k}`;
  const liveVals = d.liveValues[f.id] || new Set();
  const choices = (f.options || []).map(choice);
  const before = work.pages.flatMap((p, i) => p.fields.map((x, j) => ({ ...x, at: i * 1000 + j }))).filter(x => x.at < pi * 1000 + fi);
  const typeChoices = locked ? locked.types : Object.keys(types).filter(t => t !== 'guidelines' || f.type === 'guidelines');
  const page = work.pages[pi];

  const setChoice = (i, patch) => up((me, w) => {
    const list = me.options.map(choice);
    const c = { ...list[i], ...patch };
    // A choice that isn't live yet follows its wording; a live one keeps its saved value
    if ('label' in patch && !liveVals.has(list[i].value)) {
      // Empty while it's being retyped: the problems list asks for wording until it has some
      let v = patch.label.trim();
      if (v) {
        const others = new Set(list.filter((_, j) => j !== i).map(x => x.value));
        let n = 2; const stem = v; while (others.has(v)) v = `${stem} (${n++})`;
      }
      if (v !== list[i].value) {
        if (me.stops && me.stops[list[i].value]) { me.stops[v] = me.stops[list[i].value]; delete me.stops[list[i].value]; }
        renameInRules(w, f.id, list[i].value, v);
      }
      c.value = v;
      c.label = patch.label;
    }
    list[i] = c;
    me.options = list.map(packChoice);
  });
  const moveChoice = (i, to) => up((me) => { if (to < 0 || to >= me.options.length || to === i) return false; const list = [...me.options]; const [x] = list.splice(i, 1); list.splice(to, 0, x); me.options = list; });
  const removeChoice = (i) => up((me, w) => {
    const v = choice(me.options[i]).value;
    me.options = me.options.filter((_, j) => j !== i);
    if (me.stops) { delete me.stops[v]; if (!Object.keys(me.stops).length) delete me.stops; }
    removeValueInRules(w, f.id, v);
  });
  const addChoice = () => {
    up((me) => {
      const vals = new Set((me.options || []).map(o => choice(o).value));
      let n = (me.options || []).length + 1; let v = `Choice ${n}`; while (vals.has(v)) v = `Choice ${++n}`;
      me.options = [...(me.options || []), v];
    });
    focusSoon(`.afe-inspector input[aria-label="Choice ${choices.length + 1}"]`);
  };
  const canAddChoice = !locked?.values;
  const canRemoveChoice = () => !(locked?.allValues) && !(locked?.values && choices.length <= 1) && f.type !== 'ack';
  const del = () => {
    if (!confirm('Delete this question? Applications already submitted keep their answer.')) return;
    d.update((w) => { w.pages[pi].fields.splice(fi, 1); dropFromRules(w, new Set([f.id])); });
    onSelect({ kind: 'page', id: page.id, at: pi });
  };

  return html`
    <div class="afe-insp-head">
      <div><span class="afe-crumb">Page ${pi + 1}: ${short(fill(page.title, year), 40)}</span><h3>${types[f.type] || f.type}</h3></div>
      <span class="afe-row-actions" style="gap: .25rem;">
        <span class="afe-hint" title="The id answers are saved under">${f.id}</span>
        <button class="afe-icon-btn" aria-label="Duplicate this question" title="Duplicate" onClick=${onDuplicate}><${Icon} name="copy" /></button>
      </span>
    </div>
    ${locked && html`<div class="afe-lock"><strong>${locked.role}.</strong> You can reword and move this question; it can't be removed${locked.values ? ', and its choices are the ones JobTread knows' : ''}.</div>`}

    ${ANSWERED(f.type) && html`
      <${Field} label="Wording" id=${id('label')} hint="{year} becomes the season year.">
        <textarea id=${id('label')} class="form-input" rows="3" value=${f.label || ''} onInput=${(e) => up((me) => { me.label = e.target.value; })}></textarea>
      <//>
      <${Field} label="Help text (optional)" id=${id('help')} hint="A short note under the question.">
        <input id=${id('help')} class="form-input" value=${f.help || ''} onInput=${(e) => up((me) => { if (e.target.value) me.help = e.target.value; else delete me.help; })} />
      <//>
      <label class="afe-check" style="margin-bottom: .85rem;">
        <input type="checkbox" checked=${!!f.required} disabled=${!!locked?.required} onChange=${(e) => up((me) => { if (e.target.checked) me.required = true; else delete me.required; })} />
        Required${locked?.required ? ' (always, for JobTread)' : ''}
      </label>`}

    ${typeChoices.length > 1 && html`
      <${Field} label="Type" id=${id('type')}>
        <select id=${id('type')} class="form-input" value=${f.type} onChange=${(e) => up((me) => {
          const t = e.target.value;
          const was = me.type;
          me.type = t;
          if (CHOICE_TYPES.includes(t) && !me.options) me.options = t === 'ack' ? ['Yes, I agree.'] : ['First choice', 'Second choice'];
          if (t === 'ack' && me.options?.length > 1) me.options = [me.options[0]];
          if (!CHOICE_TYPES.includes(t)) { delete me.options; delete me.stops; }
          if (t !== 'checkbox') delete me.max;
          if (t === 'content' && !me.html) me.html = `<p>${me.label || ''}</p>`;
          if (ANSWERED(t) && !me.label) me.label = 'New question';
          const kind = (x) => (['text', 'textarea'].includes(x) ? 'length' : x);
          if (me.rules && kind(was) !== kind(t)) delete me.rules;
          if (!ANSWERED(t) || UPLOADS.includes(t)) delete me.jobtread;
        })}>
          ${typeChoices.map(t => html`<option value=${t}>${types[t] || t}</option>`)}
        </select>
      <//>`}

    ${CHOICE_TYPES.includes(f.type) && html`
      <div class="afe-field">
        <span class="afe-label">${f.type === 'ack' ? 'Checkbox wording' : 'Choices'}</span>
        <${SortList} class="afe-choices" listKey="choices" handle=".afe-choice-grip" draggable=".afe-choice" onDrop=${({ oldIndex, newIndex }) => moveChoice(oldIndex, newIndex)}>
          ${choices.map((c, i) => html`
            <div class="afe-choice">
              ${choices.length > 1 ? html`<span class="afe-grip afe-choice-grip" title="Drag to reorder"><${Icon} name="grip" size=${14} /></span>` : html`<span></span>`}
              <div class="afe-choice-main">
                <input class="form-input" aria-label=${`Choice ${i + 1}`} value=${c.label} onInput=${(e) => setChoice(i, { label: e.target.value })} />
                ${f.type !== 'ack' && f.type !== 'select' && html`<input class="form-input" aria-label=${`Description for choice ${i + 1}`} placeholder="Description (optional)" value=${c.description} onInput=${(e) => setChoice(i, { description: e.target.value })} />`}
                ${c.label !== c.value && html`<span class="afe-hint">Saved as "${c.value}"${locked || f.jobtread ? ' (what JobTread gets)' : ''}</span>`}
                ${['radio', 'select'].includes(f.type) && Object.keys(work.stops || {}).length > 0 && html`
                  <label class="afe-hint" style="display: flex; gap: .4rem; align-items: center; flex-wrap: wrap;">This answer
                    <select class="form-input" style="width: auto; padding: .2rem .4rem; min-height: 30px;" value=${f.stops?.[c.value] || ''} onChange=${(e) => up((me) => { me.stops = { ...(me.stops || {}) }; if (e.target.value) me.stops[c.value] = e.target.value; else delete me.stops[c.value]; if (!Object.keys(me.stops).length) delete me.stops; })}>
                      <option value="">continues the application</option>
                      ${Object.entries(work.stops).map(([k, s]) => html`<option value=${k}>ends it: ${strip(s.body).slice(0, 40) || s.title}</option>`)}
                    </select>
                  </label>`}
              </div>
              <span class="afe-mini">
                ${choices.length > 1 && html`<button aria-label=${`Move choice ${i + 1} up`} disabled=${i === 0} onClick=${() => moveChoice(i, i - 1)}><${Icon} name="up" size=${14} /></button>`}
                ${choices.length > 1 && html`<button aria-label=${`Move choice ${i + 1} down`} disabled=${i === choices.length - 1} onClick=${() => moveChoice(i, i + 1)}><${Icon} name="down" size=${14} /></button>`}
                ${canRemoveChoice(c) && html`<button aria-label=${`Remove choice ${i + 1}`} onClick=${() => removeChoice(i)}><${Icon} name="close" size=${14} /></button>`}
              </span>
            </div>`)}
        <//>
        ${f.type !== 'ack' && canAddChoice && html`<button class="btn btn-ghost btn-sm" style="justify-self: start;" onClick=${addChoice}><${Icon} name="plus" size=${14} /> Add a choice</button>`}
        ${locked?.values && !locked.allValues && html`<span class="afe-hint">JobTread knows: ${locked.values.join(', ')}. You can reword, reorder or remove these, not add new ones.</span>`}
      </div>`}

    ${f.type === 'checkbox' && html`
      <${Field} label="Most choices a family can pick (optional)" id=${id('max')}>
        <input id=${id('max')} type="number" min="1" max=${choices.length} class="form-input" style="width: 7rem;" value=${f.max || ''} onInput=${(e) => up((me) => { const n = parseInt(e.target.value, 10); if (n > 0) me.max = n; else delete me.max; })} />
      <//>`}

    ${f.type === 'content' && html`
      <div class="afe-field">
        <span class="afe-label">Text</span>
        ${RichTextEditor
          ? html`<${RichTextEditor} value=${f.html || ''} minHeight=${160} label="Text block" onChange=${(v) => up((me) => { me.html = v; })} />`
          : html`<textarea class="form-input" rows="8" value=${f.html || ''} onInput=${(e) => up((me) => { me.html = e.target.value; })}></textarea>`}
        <span class="afe-hint">{year} becomes the season year.</span>
      </div>`}

    ${f.type === 'image' && html`<${ImagePicker} f=${f} up=${up} addToast=${addToast} />`}
    ${f.type === 'guidelines' && html`<${GuidelinesEditor} f=${f} up=${up} />`}

    ${ANSWERED(f.type) && html`
      <${Section} title="Show only when">
        <${RuleBuilder} rule=${f.showIf} eligible=${ruleChoices(before, year)} year=${year} noun="question"
          disabledText=${locked?.required ? 'Always shown: JobTread needs this answer.' : null}
          onChange=${(r) => up((me) => { if (r) me.showIf = r; else delete me.showIf; })} />
      <//>`}

    ${['text', 'textarea', 'number', 'date'].includes(f.type) && html`
      <${Section} title="Answer rules"><${AnswerRules} f=${f} up=${up} /><//>`}

    ${ANSWERED(f.type) && !locked && !UPLOADS.includes(f.type) && !['name', 'address', 'signature'].includes(f.type) && html`
      <${Section} title="JobTread"><${JobTreadSection} f=${f} up=${up} types=${types} work=${work} /><//>`}

    <${Section} title="Place">
      <${Field} label="On page" id=${id('page')}>
        <select id=${id('page')} class="form-input" value=${String(pi)} onChange=${(e) => { const to = Number(e.target.value); d.update((w) => { const [me] = w.pages[pi].fields.splice(fi, 1); w.pages[to].fields.push(me); }); }}>
          ${work.pages.map((p, i) => html`<option value=${String(i)}>Page ${i + 1}: ${fill(p.title, year)}</option>`)}
        </select>
      <//>
      ${!locked && html`<button class="btn btn-ghost btn-sm afe-btn-danger" onClick=${del}><${Icon} name="trash" size=${14} /> Delete this ${ANSWERED(f.type) ? 'question' : 'item'}</button>`}
    <//>`;
}

/**
 * "Show when all/any of these match": each condition is an earlier question
 * with choices plus the answers that show this one. One condition saves as
 * { field, in }; more as { all: [...] } or { any: [...] }.
 */
function RuleBuilder({ rule, eligible, onChange, noun = 'question', disabledText = null }) {
  const flat = flatRule(rule);
  const [modePick, setModePick] = useState(flat?.mode || 'all');
  if (disabledText) return html`<p class="afe-hint" style="margin: 0;">${disabledText}</p>`;
  const byId = Object.fromEntries(eligible.map(q => [q.id, q]));
  const labelOf = (fid) => short(byId[fid]?.label || 'a question that comes later', 60);
  const valueOf = (fid, v) => byId[fid]?.options.find(o => o.value === v)?.label || v;
  if (!flat) {
    return html`
      <div class="afe-rule">
        <p class="afe-rule-sum">Shown when ${ruleText(rule, labelOf, valueOf)}.</p>
        <span class="afe-hint">This rule has groups inside groups, which this editor can't show one by one.</span>
        <div class="afe-rule-foot">
          <button class="btn btn-ghost btn-sm" onClick=${() => onChange(buildRule('all', ruleFields(rule).map(fid => ({ field: fid, in: [] }))))}>Start over with these questions</button>
          <button class="afe-link" onClick=${() => onChange(null)}>Always show</button>
        </div>
      </div>`;
  }
  const mode = flat.conds.length > 1 ? flat.mode : modePick;
  const conds = flat.conds;
  const set = (next, m = mode) => onChange(buildRule(m, next));
  const add = () => {
    const used = new Set(conds.map(c => c.field));
    const q = [...eligible].reverse().find(x => !used.has(x.id)) || eligible[eligible.length - 1];
    if (q) set([...conds, { field: q.id, in: [] }]);
    requestAnimationFrame(() => requestAnimationFrame(() => { const all = document.querySelectorAll('.afe-inspector .afe-cond select'); all[all.length - 1]?.focus(); }));
  };
  if (!conds.length) {
    return html`
      <div class="afe-rule-foot">
        <span class="text-sm">Always shown.</span>
        ${eligible.length
          ? html`<button class="btn btn-ghost btn-sm" onClick=${add}><${Icon} name="plus" size=${14} /> Add a condition</button>`
          : html`<span class="afe-hint">Only questions with choices that come before this ${noun} can be used.</span>`}
      </div>`;
  }
  const incomplete = conds.some(c => !c.in.length);
  return html`
    <div class="afe-rule">
      <div class="afe-rule-head">
        ${conds.length > 1
          ? html`<span>Show when</span>
              <select class="form-input" aria-label="Match all or any" value=${mode} onChange=${(e) => { setModePick(e.target.value); set(conds, e.target.value); }}>
                <option value="all">all</option><option value="any">any</option>
              </select><span>of these match</span>`
          : html`<span>Show when</span>`}
      </div>
      ${conds.map((c, i) => html`
        <div class="afe-cond">
          <select class="form-input" aria-label=${`Condition ${i + 1}: question`} value=${c.field} onChange=${(e) => set(conds.map((x, j) => (j === i ? { field: e.target.value, in: [] } : x)))}>
            ${!byId[c.field] && html`<option value=${c.field}>${c.field ? 'A question that comes later (move it earlier)' : 'Choose a question'}</option>`}
            ${eligible.map(q => html`<option value=${q.id}>${short(q.label, 70)}</option>`)}
          </select>
          <button class="afe-icon-btn" aria-label=${`Remove condition ${i + 1}`} title="Remove" onClick=${() => set(conds.filter((_, j) => j !== i))}><${Icon} name="close" /></button>
          <span class="afe-cond-is">is one of</span>
          <div class="afe-cond-vals" role="group" aria-label=${`Condition ${i + 1}: answers`}>
            ${(byId[c.field]?.options || []).map(o => html`
              <button type="button" class="afe-tog" aria-pressed=${c.in.includes(o.value)} title=${o.label}
                onClick=${() => set(conds.map((x, j) => (j === i ? { ...x, in: x.in.includes(o.value) ? x.in.filter(v => v !== o.value) : [...x.in, o.value] } : x)))}>${o.label}</button>`)}
          </div>
        </div>`)}
      <div class="afe-rule-foot">
        <button class="btn btn-ghost btn-sm" onClick=${add}><${Icon} name="plus" size=${14} /> Add a condition</button>
        <button class="afe-link" onClick=${() => onChange(null)}>Always show</button>
      </div>
      <p class="afe-rule-sum">${incomplete ? `Pick at least one answer for each condition.` : `Shown when ${ruleText(buildRule(mode, conds), labelOf, valueOf)}.`}</p>
    </div>`;
}

/** Limits on an answer: length for text, range for numbers, age for dates */
function AnswerRules({ f, up }) {
  const r = f.rules || {};
  const setR = (k, v) => up((me) => {
    const rules = { ...(me.rules || {}) };
    if (v === '' || v == null || v === false || Number.isNaN(v)) delete rules[k]; else rules[k] = v;
    if (Object.keys(rules).length) me.rules = rules; else delete me.rules;
  });
  const numIn = (k, label, min = 0) => html`
    <label>${label}<input type="number" class="form-input" inputmode="numeric" min=${min} step="1" value=${r[k] ?? ''} aria-label=${label}
      onInput=${(e) => setR(k, e.target.value === '' ? '' : Number(e.target.value))} /></label>`;
  const both = (a, b) => r[a] != null && r[b] != null;
  let sum = '';
  let bad = '';
  if (['text', 'textarea'].includes(f.type)) {
    sum = both('minLength', 'maxLength') ? `Between ${r.minLength} and ${r.maxLength} characters.` : r.minLength != null ? `At least ${r.minLength} characters.` : r.maxLength != null ? `${r.maxLength} characters or fewer.` : 'Any length.';
    if (both('minLength', 'maxLength') && r.minLength > r.maxLength) bad = 'The shortest is longer than the longest.';
    if (r.maxLength != null && r.maxLength < 1) bad = 'The longest must be at least 1 character.';
    return html`
      <div class="afe-pair">${numIn('minLength', 'Shortest (characters)')}${numIn('maxLength', 'Longest (characters)', 1)}</div>
      <p class="afe-sum">${sum}</p>${bad && html`<p class="afe-bad">${bad}</p>`}`;
  }
  if (f.type === 'number') {
    sum = `${both('min', 'max') ? `From ${r.min} to ${r.max}` : r.min != null ? `${r.min} or more` : r.max != null ? `${r.max} or less` : 'Any number'}${r.integer ? ', whole numbers only' : ''}.`;
    if (both('min', 'max') && r.min > r.max) bad = 'The smallest is bigger than the largest.';
    return html`
      <div class="afe-pair">${numIn('min', 'Smallest', -1e9)}${numIn('max', 'Largest', -1e9)}</div>
      <label class="afe-check" style="margin-top: .6rem;"><input type="checkbox" checked=${!!r.integer} onChange=${(e) => setR('integer', e.target.checked)} /> Whole numbers only</label>
      <p class="afe-sum">${sum}</p>${bad && html`<p class="afe-bad">${bad}</p>`}`;
  }
  sum = both('minAge', 'maxAge') ? `The child must be ${r.minAge} to ${r.maxAge} years old.` : r.minAge != null ? `The child must be at least ${r.minAge}.` : r.maxAge != null ? `The child must be ${r.maxAge} or younger.` : 'Any date in the past.';
  if (both('minAge', 'maxAge') && r.minAge > r.maxAge) bad = 'The youngest age is older than the oldest.';
  return html`
    <div class="afe-pair">${numIn('minAge', 'Youngest age (years)')}${numIn('maxAge', 'Oldest age (years)')}</div>
    <p class="afe-sum">${sum}</p>${bad && html`<p class="afe-bad">${bad}</p>`}`;
}

const PLACEHOLDER_CHOICE = /^(First choice|Second choice|Choice \d+)$/;

/** Send this answer to a JobTread field: pick one, see what doesn't fit, stop sending */
function JobTreadSection({ f, up, types, work }) {
  const [open, setOpen] = useState(false);
  const jt = f.jobtread;
  const others = new Map();
  for (const p of work.pages) for (const x of p.fields) if (x.jobtread && x.id !== f.id) others.set(x.jobtread.fieldId, strip(x.label) || x.id);
  const pick = (field) => {
    up((me) => {
      me.jobtread = { fieldId: field.fieldId, target: field.target, name: field.name, type: field.type, ...(Array.isArray(field.options) ? { options: field.options } : {}), ...(field.multiple ? { multiple: true } : {}) };
      // A new choice question still on its starter choices takes JobTread's
      if (field.type === 'option' && field.options?.length && CHOICE_TYPES.includes(me.type) && me.type !== 'ack' && (me.options || []).every(o => PLACEHOLDER_CHOICE.test(choice(o).value))) me.options = [...field.options];
    });
    setOpen(false);
  };
  const warnings = jt ? jtWarnings(f, jt, types) : [];
  if (jt && others.has(jt.fieldId)) warnings.push(`"${others.get(jt.fieldId)}" already fills this field. Only one question can.`);
  const canMatch = jt?.type === 'option' && jt.options?.length && CHOICE_TYPES.includes(f.type) && f.type !== 'ack' && warnings.some(w => w.includes('has no'));
  return html`
    ${!jt
      ? html`<p class="afe-hint" style="margin: 0 0 .6rem;">The answer is in the PDF and on the site. It can also fill a field on the family's JobTread account or home.</p>
          <button class="btn btn-ghost btn-sm" onClick=${() => setOpen(true)}><${Icon} name="send" size=${14} /> Send this answer to JobTread</button>`
      : html`
        <div class="afe-jt">
          <div class="afe-jt-name"><span>Fills "${jt.name}"</span><span class="badge badge-gray">${jt.target === 'location' ? 'Home (location)' : 'Account'} · ${jtTypeLabel(jt)}</span></div>
          ${warnings.map(w => html`<div class="afe-note is-warn"><${Icon} name="warn" /><span>${w}</span></div>`)}
          ${!warnings.length && html`<span class="afe-hint">Each new application sends this answer to JobTread.</span>`}
          <div class="afe-rule-foot">
            ${canMatch && html`<button class="btn btn-ghost btn-sm" onClick=${() => up((me) => { me.options = [...jt.options]; })}>Use JobTread's choices</button>`}
            <button class="btn btn-ghost btn-sm" onClick=${() => setOpen(true)}>Change</button>
            <button class="afe-link" onClick=${() => up((me) => { delete me.jobtread; })}>Stop sending</button>
          </div>
        </div>`}
    ${open && html`<${JobTreadPicker} f=${f} types=${types} current=${jt?.fieldId} used=${others} onPick=${pick} onClose=${() => setOpen(false)} />`}`;
}

function JobTreadPicker({ f, types, current, used, onPick, onClose }) {
  const [fields, setFields] = useState(jtFieldsCache);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const load = () => {
    setError(null);
    call(`${API}?jobtread-fields=1`).then(j => { if (j.success) { jtFieldsCache = j.fields || []; setFields(jtFieldsCache); } else setError(j.error || 'Could not reach JobTread'); });
  };
  useEffect(() => { if (!fields) load(); }, []);
  const needle = q.trim().toLowerCase();
  const list = (fields || []).filter(x => !needle || x.name.toLowerCase().includes(needle) || jtTypeLabel(x).toLowerCase().includes(needle));
  const groups = [['account', 'Account'], ['location', 'Home (location)']].map(([k, label]) => [label, list.filter(x => x.target === k)]).filter(([, xs]) => xs.length);
  const flat = groups.flatMap(([, xs]) => xs);
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, Math.min(flat.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1)))); }
    if (e.key === 'Enter' && flat[active]) { e.preventDefault(); onPick(flat[active]); }
  };
  useEffect(() => { document.querySelector('.afe-jt-item.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  return html`
    <${Dialog} title="Send this answer to JobTread" onClose=${onClose}>
      <p class="afe-hint" style="margin-bottom: .6rem;">Pick the JobTread field this answer fills on each new application. Fields the site already fills aren't listed.</p>
      <label class="afe-search" style="max-width: none;">
        <${Icon} name="search" />
        <input class="form-input" type="search" placeholder="Search JobTread fields" aria-label="Search JobTread fields" value=${q} onInput=${(e) => { setQ(e.target.value); setActive(0); }} onKeyDown=${onKey} />
      </label>
      ${error && html`<div class="afe-note is-warn" style="margin-top: .75rem;"><${Icon} name="warn" /><span>Couldn't load JobTread's fields: ${error} <button class="afe-link" onClick=${load}>Try again</button></span></div>`}
      ${!fields && !error && html`<${Spinner} />`}
      ${fields && html`
        <div class="afe-jt-list" role="listbox" aria-label="JobTread fields">
          ${!flat.length && html`<p class="afe-empty">${needle ? `No fields match "${q.trim()}".` : 'No JobTread fields to pick.'}</p>`}
          ${groups.map(([label, xs]) => html`
            <section>
              <h4>${label}</h4>
              ${xs.map(x => {
                const i = flat.indexOf(x);
                const fits = (JT_TYPES_FOR[x.type] || []).includes(f.type);
                const by = used.get(x.fieldId);
                return html`
                  <button class="afe-jt-item ${i === active ? 'is-active' : ''} ${x.fieldId === current ? 'is-current' : ''}" role="option" aria-selected=${x.fieldId === current} onMouseEnter=${() => setActive(i)} onClick=${() => onPick(x)}>
                    <span><span>${x.name}</span>
                      <small>${by ? `Used by "${short(by, 40)}"` : !fits ? `Doesn't fit a ${(types[f.type] || f.type).toLowerCase()} question` : x.options?.length ? `Choices: ${x.options.slice(0, 4).join(', ')}${x.options.length > 4 ? ', …' : ''}` : ''}</small></span>
                    <span class="badge ${fits ? 'badge-gray' : 'badge-yellow'}">${jtTypeLabel(x)}</span>
                  </button>`;
              })}
            </section>`)}
        </div>`}
    <//>`;
}

/** Drop or choose an image; it goes to Cloudflare Images and the field keeps its id */
function ImagePicker({ f, up, addToast }) {
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef(null);
  const sizeOf = (file) => new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    img.src = url;
  });
  const upload = async (file) => {
    setErr('');
    if (!file) return;
    if (!/^image\//.test(file.type)) { setErr('That isn’t an image. Choose a JPG, PNG, WebP or GIF.'); return; }
    if (file.size > 10 * 1024 * 1024) { setErr('That image is over 10 MB. Choose a smaller one.'); return; }
    setBusy(true);
    const dims = await sizeOf(file);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('id', `applications/form/${f.id}-${Date.now().toString(36)}`);
    let j = {};
    try { const r = await fetch('/api/upload-image', { method: 'POST', body: fd }); j = await r.json().catch(() => ({ success: false, error: `HTTP ${r.status}` })); } catch { j = { success: false, error: 'No connection.' }; }
    setBusy(false);
    if (!j.success) { setErr(j.error || 'The upload didn’t work. Try again.'); return; }
    up((me) => { me.image = imageIdFrom(j.imageId || j.imageUrl); if (dims?.w && dims?.h) { me.width = dims.w; me.height = dims.h; } });
    addToast?.('Image uploaded.', 'success');
  };
  return html`
    <div class="afe-field">
      <span class="afe-label">Image</span>
      ${f.image && html`<img class="afe-thumb" src=${`${CF_BASE}/${f.image}/w=600`} alt="" style=${f.width && f.height ? `aspect-ratio: ${f.width} / ${f.height};` : ''} />`}
      <div class="afe-drop ${over ? 'is-over' : ''}"
        onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
        onDrop=${(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer?.files?.[0]); }}>
        <${Icon} name="image" size=${22} />
        <span>${busy ? 'Uploading…' : f.image ? 'Drop a new image here to replace it' : 'Drop an image here'}</span>
        <button class="btn btn-ghost btn-sm" disabled=${busy} onClick=${() => input.current?.click()}>${f.image ? 'Choose another' : 'Choose a file'}</button>
        <input ref=${input} type="file" accept="image/*" hidden onChange=${(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      ${err && html`<p class="afe-bad">${err}</p>`}
    </div>
    <${Field} label="Or an image id or link" id="afe-f-image" hint="From Cloudflare Images (Media in the admin). A full link is fine; the id is kept.">
      <input id="afe-f-image" class="form-input" value=${f.image || ''} onChange=${(e) => up((me) => { me.image = imageIdFrom(e.target.value); })} />
    <//>
    <${Field} label="Describe the image (for people who can't see it)" id="afe-f-alt">
      <input id="afe-f-alt" class="form-input" value=${f.alt || ''} onInput=${(e) => up((me) => { me.alt = e.target.value; })} />
    <//>
    <div class="afe-pair" style="margin-bottom: .85rem;">
      <label>Width (px)<input type="number" min="1" class="form-input" value=${f.width || ''} onInput=${(e) => up((me) => { me.width = Number(e.target.value) || 938; })} /></label>
      <label>Height (px)<input type="number" min="1" class="form-input" value=${f.height || ''} onInput=${(e) => up((me) => { me.height = Number(e.target.value) || 768; })} /></label>
    </div>`;
}

function GuidelinesEditor({ f, up }) {
  return html`
    <${Field} label="Heading" id="afe-g-title"><input id="afe-g-title" class="form-input" value=${f.title || ''} onInput=${(e) => up((me) => { me.title = e.target.value; })} /><//>
    <${Field} label="First list title" id="afe-g-do"><input id="afe-g-do" class="form-input" value=${f.doTitle || ''} onInput=${(e) => up((me) => { me.doTitle = e.target.value; })} /><//>
    ${(f.doItems || []).map((it, i) => html`
      <div class="afe-choice" style="grid-template-columns: 1fr auto; padding-left: .45rem; margin-bottom: .4rem;">
        <div class="afe-choice-main">
          <input class="form-input" aria-label=${`Item ${i + 1} title`} placeholder="Title" value=${it.title} onInput=${(e) => up((me) => { me.doItems[i].title = e.target.value; })} />
          <textarea class="form-input" rows="2" aria-label=${`Item ${i + 1} text`} value=${it.text} onInput=${(e) => up((me) => { me.doItems[i].text = e.target.value; })}></textarea>
        </div>
        <span class="afe-mini"><button aria-label=${`Remove item ${i + 1}`} onClick=${() => up((me) => { me.doItems.splice(i, 1); })}><${Icon} name="close" size=${14} /></button></span>
      </div>`)}
    <button class="btn btn-ghost btn-sm" style="margin-bottom: .85rem;" onClick=${() => up((me) => { me.doItems = [...(me.doItems || []), { title: '', text: '' }]; })}><${Icon} name="plus" size=${14} /> Add to the first list</button>
    <${Field} label="Second list title" id="afe-g-dont"><input id="afe-g-dont" class="form-input" value=${f.dontTitle || ''} onInput=${(e) => up((me) => { me.dontTitle = e.target.value; })} /><//>
    ${(f.dontItems || []).map((it, i) => html`
      <div class="afe-choice" style="grid-template-columns: 1fr auto; padding-left: .45rem; margin-bottom: .4rem;">
        <div class="afe-choice-main"><input class="form-input" aria-label=${`Second list item ${i + 1}`} value=${it} onInput=${(e) => up((me) => { me.dontItems[i] = e.target.value; })} /></div>
        <span class="afe-mini"><button aria-label=${`Remove second list item ${i + 1}`} onClick=${() => up((me) => { me.dontItems.splice(i, 1); })}><${Icon} name="close" size=${14} /></button></span>
      </div>`)}
    <button class="btn btn-ghost btn-sm" style="margin-bottom: .85rem;" onClick=${() => up((me) => { me.dontItems = [...(me.dontItems || []), '']; })}><${Icon} name="plus" size=${14} /> Add to the second list</button>`;
}

function StopInspector({ d, k, RichTextEditor, onSelect }) {
  const s = d.work.stops[k];
  const used = d.work.pages.some(p => p.fields.some(f => f.stops && Object.values(f.stops).includes(k)));
  const set = (patch) => d.update((w) => { Object.assign(w.stops[k], patch); });
  return html`
    <div class="afe-insp-head"><div><span class="afe-crumb">Stop screen</span><h3>${short(s.title, 60) || 'Stop screen'}</h3></div></div>
    <${Field} label="Heading" id="afe-stop-title"><input id="afe-stop-title" class="form-input" value=${s.title} onInput=${(e) => set({ title: e.target.value })} /><//>
    <div class="afe-field">
      <span class="afe-label">Message</span>
      ${RichTextEditor
        ? html`<${RichTextEditor} value=${s.body || ''} minHeight=${120} label="Stop screen message" onChange=${(v) => set({ body: v })} />`
        : html`<textarea class="form-input" rows="5" value=${s.body || ''} onInput=${(e) => set({ body: e.target.value })}></textarea>`}
    </div>
    <label class="afe-check" style="margin-bottom: .85rem;">
      <input type="checkbox" checked=${!!s.image} onChange=${(e) => d.update((w) => { if (e.target.checked) w.stops[k].image = SERVICE_MAP_IMAGE; else delete w.stops[k].image; })} />
      Show the service area map
    </label>
    <p class="afe-hint">${used ? 'A choice in the form leads here.' : 'No choice leads here yet. Pick it on a question’s choices.'}</p>
    <button class="btn btn-ghost btn-sm afe-btn-danger" disabled=${used} title=${used ? 'A choice still leads here' : ''}
      onClick=${() => { if (!confirm('Delete this stop screen?')) return; d.update((w) => { delete w.stops[k]; }); onSelect({ kind: 'page', id: d.work.pages[0]?.id, at: 0 }); }}><${Icon} name="trash" size=${14} /> Delete this stop screen</button>`;
}

// ─── Spanish ───────────────────────────────────────────────────────
const TR_FILTERS = [['all', 'All'], ['missing', 'Missing'], ['stale', 'Out of date'], ['done', 'Done']];
const TR_BADGE = { missing: ['badge-yellow', 'Missing'], stale: ['badge-blue', 'Out of date'], done: ['badge-green', 'Done'] };
const PART_NAME = { label: 'Wording', help: 'Help text', html: 'Text', alt: 'Image description', title: 'Heading', doTitle: 'First list title', dontTitle: 'Second list title' };
const MESSAGE_NAMES = { welcome: 'Application Status', copyNote: 'The "copy attached" line', inReview: 'Application In Review', approved: 'Application Decision: approved', denied: 'Application Decision: denied', correction: 'Correction' };
const AI_BATCH = 40;
const isHtmlPath = (path) => /:html$|^stop:.*:body$/.test(path);

/** Where a string lives, in words: { group, item, part } */
function stringPlace(path, def, year, types, index) {
  const [kind, ...rest] = path.split(':');
  if (kind === 'title') return { group: 'Form', item: 'Form title', part: '' };
  if (kind === 'page') {
    const pi = def.pages.findIndex(p => p.id === rest[0]);
    return { group: pi >= 0 ? `Page ${pi + 1}: ${fill(def.pages[pi].title, year)}` : 'Pages', item: 'Page title', part: '' };
  }
  if (kind === 'field') {
    const at = index.get(rest[0]);
    const group = at ? `Page ${at.pi + 1}: ${fill(def.pages[at.pi].title, year)}` : 'Questions';
    const item = at ? short(fieldName(at.f, year, types), 70) : rest[0];
    const k = rest[1];
    const opt = rest.slice(2).join(':');
    const label = at && (k === 'option' || k === 'desc') ? (at.f.options || []).map(choice).find(c => c.value === opt)?.label || opt : opt;
    const part = k === 'option' ? `Choice: ${short(label, 40)}`
      : k === 'desc' ? `Choice description: ${short(label, 40)}`
      : k === 'doItems' ? `First list, item ${Number(rest[2]) + 1} ${rest[3] === 'title' ? 'title' : 'text'}`
      : k === 'dontItems' ? `Second list, item ${Number(rest[2]) + 1}`
      : PART_NAME[k] || k;
    return { group, item, part };
  }
  if (kind === 'stop') return { group: 'Stop screens', item: short(def.stops?.[rest[0]]?.title || rest[0], 60), part: rest[1] === 'body' ? 'Message' : 'Heading' };
  if (kind === 'message') return { group: 'Messages to families', item: MESSAGE_NAMES[rest[0]] || rest[0], part: '' };
  if (kind === 'reminder') return { group: 'Reminder email', item: rest[0] === 'subject' ? 'Subject' : 'Message', part: '' };
  return { group: 'Other', item: path, part: '' };
}

const marked = (s) => String(s || '').split(/(\{[a-zA-Z]+\})/g).map((part, i) => (i % 2 ? html`<mark class="afe-ph">${part}</mark>` : part));
const markedHtml = (s) => DOMPurify.sanitize(String(s || '')).replace(/\{([a-zA-Z]+)\}/g, '<mark class="afe-ph">{$1}</mark>');

function SpanishTab({ d, RichTextEditor, addToast, lead = null }) {
  const { work } = d;
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [job, setJob] = useState(null); // { done, total, failed, error, running }
  const [onlyFailed, setOnlyFailed] = useState(null);
  const pinned = useRef(new Set());
  const cancel = useRef(false);
  const en = useMemo(() => (work ? englishStrings(work) : {}), [work]);
  const status = useMemo(() => (work ? translationStatus(work) : {}), [work]);
  const index = useMemo(() => {
    const m = new Map();
    (work?.pages || []).forEach((p, pi) => p.fields.forEach((f) => m.set(f.id, { pi, f })));
    return m;
  }, [work]);
  if (!work || !d.meta) return html`<div><${DraftBar} d=${d} lead=${lead} /><${Spinner} /></div>`;
  const types = d.meta.types || {};
  const year = d.year;
  const es = work.i18n?.es || {};
  const strings = es.strings || {};
  const sources = es.sources || {};
  const paths = Object.keys(en);
  const counts = { all: paths.length, missing: 0, stale: 0, done: 0 };
  for (const p of paths) counts[status[p]]++;
  const todo = paths.filter(p => status[p] !== 'done');

  const pickFilter = (k) => { pinned.current = new Set(); setOnlyFailed(null); setFilter(k); };
  const needle = q.trim().toLowerCase();
  const visible = paths.filter((p) => {
    if (onlyFailed) return onlyFailed.includes(p);
    if (filter !== 'all' && status[p] !== filter && !pinned.current.has(p)) return false;
    if (!needle) return true;
    return strip(en[p]).toLowerCase().includes(needle) || strip(strings[p]).toLowerCase().includes(needle);
  });
  const groups = [];
  for (const p of visible) {
    const place = stringPlace(p, work, year, types, index);
    let g = groups[groups.length - 1];
    if (!g || g.name !== place.group) { g = { name: place.group, items: [] }; groups.push(g); }
    g.items.push({ path: p, place });
  }

  const setEs = (path, v) => {
    pinned.current.add(path);
    d.update((w) => {
      w.i18n = w.i18n || {};
      const t = w.i18n.es = w.i18n.es || {};
      t.strings = t.strings || {};
      t.sources = t.sources || {};
      if (strip(v)) { t.strings[path] = v; t.sources[path] = en[path]; } else { delete t.strings[path]; delete t.sources[path]; }
    });
  };
  const stillRight = (path) => { pinned.current.add(path); d.update((w) => { w.i18n.es.sources[path] = en[path]; }); };

  const fillWithAi = async () => {
    const list = [...todo];
    if (!list.length) return;
    cancel.current = false;
    const group = `ai-${Date.now()}`;
    const failed = [];
    setOnlyFailed(null);
    setJob({ done: 0, total: list.length, failed, error: null, running: true });
    for (let i = 0; i < list.length; i += AI_BATCH) {
      if (cancel.current) break;
      const batch = Object.fromEntries(list.slice(i, i + AI_BATCH).map(p => [p, en[p]]));
      const j = await call(API, { translate: batch });
      if (!j.success) {
        const why = /not bound|isn.t bound/i.test(j.error || '') ? 'AI translation isn’t set up on this site yet (Workers AI isn’t connected).' : (j.error || 'The translation service didn’t answer.');
        setJob({ done: i, total: list.length, failed, error: why, running: false });
        return;
      }
      for (const p of j.failed || []) failed.push(p);
      const got = j.strings || {};
      d.update((w) => {
        const nowEn = englishStrings(w);
        w.i18n = w.i18n || {};
        const t = w.i18n.es = w.i18n.es || {};
        t.strings = t.strings || {};
        t.sources = t.sources || {};
        let n = 0;
        for (const [p, text] of Object.entries(got)) {
          // Someone typed this one while the batch was out: theirs stays
          const cur = t.strings[p];
          if (cur && (t.sources[p] == null || t.sources[p] === nowEn[p])) continue;
          t.strings[p] = text;
          t.sources[p] = batch[p];
          n++;
        }
        return n > 0;
      }, { group });
      setJob({ done: Math.min(list.length, i + AI_BATCH), total: list.length, failed: [...failed], error: null, running: !cancel.current && i + AI_BATCH < list.length });
    }
    setJob(x => ({ ...x, running: false }));
    addToast(failed.length ? `Spanish drafts added. ${plural(failed.length, 'string')} still need${failed.length === 1 ? 's' : ''} you.` : 'Spanish drafts added. Read them over before you put the form live.', failed.length ? 'info' : 'success');
  };

  return html`
    <div>
      <${DraftBar} d=${d} lead=${lead} />
      <div class="card">
        <div class="afe-card-head">
          <div>
            <p class="afe-lede">Families can switch the application, and every email they get, to Spanish. Each question, choice, screen and email is here beside its translation. When the English changes, its Spanish shows as out of date until someone checks it. Missing Spanish shows the English.</p>
          </div>
          <div style="min-width: 220px;">
            <div class="text-sm"><strong>${num(counts.done)}</strong> of ${num(counts.all)} done</div>
            <div class="afe-meter" role="img" aria-label=${`${counts.done} of ${counts.all} done`}><span style=${`width: ${counts.all ? (counts.done / counts.all) * 100 : 0}%;`}></span></div>
          </div>
        </div>

        <div class="afe-toolbar">
          <div class="afe-chipbar" role="group" aria-label="Show">
            ${TR_FILTERS.map(([k, label]) => html`<button class="afe-chip" data-filter=${k} aria-pressed=${!onlyFailed && filter === k} onClick=${() => pickFilter(k)}>${label}<span class="afe-chip-n">${num(counts[k])}</span></button>`)}
            ${onlyFailed && html`<button class="afe-chip" aria-pressed="true" onClick=${() => setOnlyFailed(null)}>Couldn't translate<span class="afe-chip-n">${onlyFailed.length}</span></button>`}
          </div>
          <label class="afe-search">
            <${Icon} name="search" />
            <input class="form-input" type="search" placeholder="Search English or Spanish" aria-label="Search translations" value=${q} onInput=${(e) => setQ(e.target.value)} />
          </label>
          <span style="flex: 1;"></span>
          ${job?.running
            ? html`<button class="btn btn-ghost" onClick=${() => { cancel.current = true; }}>Stop</button>`
            : html`<button class="btn btn-primary" disabled=${!todo.length} onClick=${fillWithAi} title=${todo.length ? `${todo.length} missing or out of date` : 'Everything is translated'}><${Icon} name="sparkle" size=${15} /> Fill missing with AI</button>`}
        </div>

        ${job && html`
          <div class="afe-progress" role="status">
            ${job.running && html`<span class="text-sm">Translating ${num(job.done)} of ${num(job.total)}…</span>`}
            ${job.running && html`<div class="afe-meter"><span style=${`width: ${job.total ? (job.done / job.total) * 100 : 0}%; background: var(--afe-data);`}></span></div>`}
            ${job.error && html`<div class="afe-note is-warn"><${Icon} name="warn" /><span><strong>No AI drafts this time.</strong> ${job.error} You can still type the Spanish below.${job.done > 0 ? ` ${num(job.done)} were filled before it stopped.` : ''}</span></div>`}
            ${!job.running && !job.error && html`<span class="afe-hint">AI drafts for ${num(job.done - job.failed.length)} of ${num(job.total)}. Read them over before you put the form live.</span>`}
            ${!job.running && job.failed.length > 0 && html`<div class="afe-note"><span>${plural(job.failed.length, 'string')} came back with a placeholder or tag changed, so ${job.failed.length === 1 ? 'it was' : 'they were'} left for you. <button class="afe-link" onClick=${() => setOnlyFailed([...job.failed])}>Show ${job.failed.length === 1 ? 'it' : 'them'}</button></span></div>`}
          </div>`}

        ${!visible.length && html`<p class="afe-empty" style="margin-top: 1rem;">${needle ? `Nothing matches "${q.trim()}".` : filter === 'done' ? 'Nothing is done yet.' : 'Nothing here. Everything is translated and up to date.'}</p>`}
        ${groups.map(g => html`
          <section class="afe-tr-group">
            <h4>${g.name}</h4>
            ${g.items.map(({ path, place }, idx) => {
              const again = idx > 0 && g.items[idx - 1].place.item === place.item && !!place.part;
              const st = status[path];
              const need = placeholders(en[path]);
              const have = placeholders(strings[path]);
              const missing = strings[path] ? need.filter(p => !have.includes(p)) : [];
              const extra = have.filter(p => !need.includes(p));
              const htmlPath = isHtmlPath(path);
              return html`
                <div class="afe-tr" data-path=${path} key=${path}>
                  <div class="afe-tr-where">
                    ${again ? html`<b>${place.part}</b>` : html`<b>${place.item}</b>${place.part && html`<span>› ${place.part}</span>`}`}
                    <span class="badge ${TR_BADGE[st][0]}">${TR_BADGE[st][1]}</span>
                  </div>
                  ${htmlPath
                    ? html`<div class="afe-tr-en is-html" lang="en" dangerouslySetInnerHTML=${{ __html: markedHtml(en[path]) }}></div>`
                    : html`<div class="afe-tr-en" lang="en">${marked(en[path])}</div>`}
                  <div class="afe-tr-es">
                    ${htmlPath && RichTextEditor
                      ? html`<${RichTextEditor} value=${strings[path] || ''} minHeight=${90} label=${`Spanish: ${place.item}`} onChange=${(v) => setEs(path, v)} />`
                      : html`<textarea class="form-input" lang="es" rows=${Math.min(10, Math.max(1, Math.ceil(strip(en[path]).length / 55)))} aria-label=${`Spanish for ${place.item}${place.part ? `, ${place.part}` : ''}`} placeholder="Spanish" value=${strings[path] || ''} onInput=${(e) => setEs(path, e.target.value)}></textarea>`}
                    ${need.length > 0 && html`<span class="afe-hint">Keep ${need.map((p, i) => html`${i ? ' ' : ''}<mark class="afe-ph ${missing.includes(p) ? 'is-missing' : ''}">${p}</mark>`)} as they are; they're filled in for each family.</span>`}
                    ${missing.length > 0 && html`<span class="afe-bad">The Spanish is missing ${missing.join(' and ')}.</span>`}
                    ${extra.length > 0 && html`<span class="afe-bad">${extra.join(' and ')} ${extra.length === 1 ? "isn't" : "aren't"} in the English, so ${extra.length === 1 ? 'it' : 'they'} won't be filled in.</span>`}
                    ${st === 'stale' && html`
                      <div class="afe-note">
                        <span>The English changed after this was translated. It used to say: “${short(sources[path], 160)}” <button class="afe-link" onClick=${() => stillRight(path)}>The Spanish is still right</button></span>
                      </div>`}
                  </div>
                </div>`;
            })}
          </section>`)}
      </div>
    </div>`;
}

// ─── Emails ────────────────────────────────────────────────────────
// Every email a family gets, in the order they get them. Status emails post
// on the family's JobTread account as the Qualification Committee and
// JobTread emails them; reminders come from the site. Their wording is part
// of the form's draft (Put live), and each has its Spanish beside it. When
// they go out is a setting (Settings → When status emails go out).
const SAMPLE_STATUS_LINE = {
  en: 'Your application is moving forward to the on-site visit, and we will contact you to schedule it.',
  es: 'Su solicitud avanza a la visita en persona y le contactaremos para programarla.',
};
const hour12 = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const quietText = (n) => (n.quiet.start !== n.quiet.end ? `, never between ${hour12(n.quiet.start)} and ${hour12(n.quiet.end)} Eastern` : '');
const EMAILS = [
  { key: 'welcome', name: 'Application received', subject: ['Application Status', 'Estado de la solicitud'], tokens: ['{parent}', '{child}', '{copyNote}'],
    when: () => 'Right away, when a family applies on the website. Families staff add in JobTread get it once their status settles.' },
  { key: 'inReview', name: 'In review', subject: ['Application In Review', 'Solicitud en revisión'], tokens: ['{parent}', '{child}'],
    when: (n) => `Once Status has stayed In Review for ${plural(n.waits.inReview, 'minute')}${quietText(n)}.` },
  { key: 'approved', name: 'Approved', subject: ['Application Decision', 'Decisión sobre la solicitud'], tokens: ['{parent}', '{child}'],
    when: (n) => `Once Status has stayed Approved for ${plural(n.waits.decision, 'minute')}${quietText(n)}.` },
  { key: 'denied', name: 'Denied', subject: ['Application Decision', 'Decisión sobre la solicitud'], tokens: ['{parent}', '{child}'],
    when: (n) => `Once Status has stayed Denied for ${plural(n.waits.decision, 'minute')}${quietText(n)}.` },
  { key: 'correction', name: 'Correction', subject: ['An update on your application', 'Una actualización sobre su solicitud'], tokens: ['{parent}', '{child}', '{status}'],
    when: () => 'Only when staff send it from a family’s page, after a status email went out by mistake. They can edit it first. {status} becomes a line about where the application really stands.' },
  { key: 'reminders', name: 'Reminders', tokens: ['{parent}', '{child}', '{percent}', '{year}'],
    when: (n, rem) => (rem.enabled === false ? 'Off: nobody gets these.' : rem.days?.length ? `To families who start and stop: ${rem.days.map(x => plural(x, 'day')).join(', then ')} after their last change.` : 'On, but no days are set yet.') },
];
const TOKEN_TIP = { '{parent}': "The main parent's name", '{child}': "The child's name", '{copyNote}': 'Where the "copy attached" line goes', '{status}': 'Where the application stands now', '{percent}': 'How far along they are', '{year}': 'The season year' };
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JobTread's light formatting (*bold*, _italic_, line breaks) as safe HTML */
const jtRich = (s) => escHtml(s).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>').replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1<em>$2</em>').replace(/\n/g, '<br>');

/** Put a placeholder where the cursor is (or at the end), then put the cursor after it */
function insertAt(el, value, token, set) {
  const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
  const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : at;
  set(value.slice(0, at) + token + value.slice(end));
  if (el) requestAnimationFrame(() => { el.focus(); el.setSelectionRange?.(at + token.length, at + token.length); });
}

const TR_DOT = { missing: ['is-missing', 'Spanish missing'], stale: ['is-stale', 'Spanish out of date'], done: ['is-done', 'Spanish done'] };

function EmailsTab({ d, go, addToast = () => {} }) {
  const { work } = d;
  const [sel, setSel] = useState(() => store.get('afe-email') || 'welcome');
  const [lang, setLang] = useState('en');
  const pick = (k) => { setSel(k); store.set('afe-email', k); };
  // Where the list scrolls sideways (phones), keep the open email in view
  useEffect(() => {
    const rail = document.querySelector('.afe-email-rail');
    const el = rail?.querySelector(`[data-email="${sel}"]`);
    if (!el || rail.scrollWidth <= rail.clientWidth) return;
    const r = rail.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    if (e.left < r.left || e.right > r.right - 24) rail.scrollLeft += e.left - r.left - 16;
  }, [sel, !!work]);
  const status = useMemo(() => (work ? translationStatus(work) : {}), [work]);
  if (!work || !d.meta) return html`<div><${Head} title="Emails" /><${Spinner} /></div>`;
  const n = { ...DEFAULT_NOTIFY, ...(work.notify || {}), waits: { ...DEFAULT_NOTIFY.waits, ...(work.notify?.waits || {}) }, quiet: { ...DEFAULT_NOTIFY.quiet, ...(work.notify?.quiet || {}) } };
  const rem = { ...DEFAULT_REMINDERS, ...(work.reminders || {}) };
  const cur = EMAILS.find(e => e.key === sel) || EMAILS[0];
  const paths = (k) => (k === 'reminders' ? ['reminder:subject', 'reminder:body'] : k === 'welcome' ? ['message:welcome', 'message:copyNote'] : [`message:${k}`]);
  const trState = (k) => {
    const st = paths(k).map(p => status[p]).filter(Boolean);
    return st.includes('missing') ? 'missing' : st.includes('stale') ? 'stale' : 'done';
  };
  const problemsFor = (k) => d.problems.filter(p => (k === 'reminders' ? p.where === 'reminders' : p.where === `messages/${k}`));
  return html`
    <div>
      <${Head} title="Emails" sub="Every email a family gets from us, in the order they get it. Status emails post on the family's JobTread account as the Qualification Committee, and JobTread emails them; their replies come back to the family's page. Wording changes go live with Put live.">
        <${TestRunButton} d=${d} />
        <${SampleButton} d=${d} addToast=${addToast} />
      <//>
      <${DraftBar} d=${d} emails />
      <div class="afe-emails">
        <nav class="afe-email-rail" aria-label="Emails">
          ${EMAILS.map((e, i) => {
            const st = trState(e.key);
            const bad = problemsFor(e.key).length > 0;
            return html`<button key=${e.key} data-email=${e.key} aria-current=${sel === e.key ? 'true' : undefined} onClick=${() => pick(e.key)}>
              <span class="afe-email-n" aria-hidden="true">${i + 1}</span>
              <b>${e.name}${bad && html`<span class="afe-email-bad" title="Something to fix before Put live">!</span>`}</b>
              <small>${e.key === 'welcome' ? 'Right away' : e.key === 'correction' ? 'When staff send it' : e.key === 'reminders' ? (rem.enabled === false ? 'Off' : `${(rem.days || []).join(', ')} days after they stop`) : `After ${n.waits[e.key === 'inReview' ? 'inReview' : 'decision']} min`}</small>
              <span class=${`afe-tr-dot ${TR_DOT[st][0]}`} title=${TR_DOT[st][1]}><span class="sr-only">${TR_DOT[st][1]}</span></span>
            </button>`;
          })}
        </nav>
        <div class="afe-email-main">
          <div class="afe-email-top">
            <div>
              <h3>${cur.name}</h3>
              <p class="afe-hint">${cur.when(n, rem)} ${['welcome', 'inReview', 'approved', 'denied'].includes(cur.key) && html`<button class="afe-link" onClick=${() => go('settings')}>Timing is in Settings</button>`}</p>
            </div>
            <div class="afe-seg afe-seg-text" role="group" aria-label="Language">
              <button aria-pressed=${lang === 'en'} onClick=${() => setLang('en')}>English</button>
              <button aria-pressed=${lang === 'es'} onClick=${() => setLang('es')}>Spanish${trState(cur.key) !== 'done' && html`<span class=${`afe-tr-dot ${TR_DOT[trState(cur.key)][0]}`} title=${TR_DOT[trState(cur.key)][1]}></span>`}</button>
            </div>
          </div>
          ${problemsFor(cur.key).length > 0 && html`<div class="afe-problems" role="alert"><ul>${problemsFor(cur.key).map(p => html`<li>${p.message}</li>`)}</ul></div>`}
          ${cur.key === 'reminders'
            ? html`<${RemindersEditor} d=${d} lang=${lang} key=${`rem-${lang}`} />`
            : html`<${MessageEditor} d=${d} k=${cur.key} spec=${cur} lang=${lang} status=${status} key=${`${cur.key}-${lang}`} />`}
        </div>
      </div>
    </div>`;
}

/** The text of a family-facing string in a language, and a way to set it (Spanish keeps its source) */
function useString(d, path, lang, fallbackEn) {
  const w = d.work;
  const en = path.startsWith('reminder:') ? ({ ...DEFAULT_REMINDERS, ...(w.reminders || {}) })[path.split(':')[1]] || '' : (w.messages || {})[path.split(':')[1]] ?? fallbackEn ?? '';
  const es = w.i18n?.es?.strings?.[path] || '';
  const set = (v) => {
    if (lang === 'en') {
      const [kind, key] = path.split(':');
      if (kind === 'reminder') d.update((x) => { x.reminders = { ...DEFAULT_REMINDERS, ...(x.reminders || {}), [key]: v }; });
      else d.update((x) => { x.messages = { ...(x.messages || {}), [key]: v }; });
      return;
    }
    d.update((x) => {
      x.i18n = x.i18n || {};
      const t = x.i18n.es = x.i18n.es || {};
      t.strings = t.strings || {};
      t.sources = t.sources || {};
      if (strip(v)) { t.strings[path] = v; t.sources[path] = en; } else { delete t.strings[path]; delete t.sources[path]; }
    });
  };
  const stillRight = () => d.update((x) => { x.i18n.es.sources[path] = en; });
  return { en, es, value: lang === 'en' ? en : es, set, stillRight, source: w.i18n?.es?.sources?.[path] };
}

/** A Spanish box's notes: what it was translated from, and its placeholders */
function SpanishNotes({ st, s, en }) {
  const need = placeholders(en);
  const have = placeholders(s.es);
  const missing = s.es ? need.filter(p => !have.includes(p)) : [];
  return html`
    ${st === 'missing' && html`<span class="afe-hint">No Spanish yet: Spanish-speaking families get the English. Fill it here, or all at once with AI in <a href="#applications/form/spanish">Form → Spanish</a>.</span>`}
    ${st === 'stale' && html`<div class="afe-note"><span>The English changed after this was translated. It used to say: “${short(s.source, 160)}” <button class="afe-link" onClick=${s.stillRight}>The Spanish is still right</button></span></div>`}
    ${missing.length > 0 && html`<span class="afe-bad">The Spanish is missing ${missing.join(' and ')}.</span>`}`;
}

function MessageEditor({ d, k, spec, lang, status }) {
  const box = useRef(null);
  const msg = useString(d, `message:${k}`, lang);
  const note = useString(d, 'message:copyNote', lang);
  const st = status[`message:${k}`] || 'done';
  const enText = msg.en;
  const fillFor = (text, copy) => String(text || '')
    .replace(/\{parent\}/g, SAMPLE.parent).replace(/\{child\}/g, SAMPLE.child)
    .replace(/\{copyNote\}/g, copy ? `\n\n${copy}` : '')
    .replace(/\{status\}/g, SAMPLE_STATUS_LINE[lang]);
  const shown = lang === 'es' ? (msg.es || enText) : enText;
  const shownNote = lang === 'es' ? (note.es || note.en) : note.en;
  return html`
    <div class="afe-email-work">
      <section class="afe-email-ed" aria-label=${`${spec.name}, ${lang === 'es' ? 'Spanish' : 'English'}`}>
        ${lang === 'es' && html`<div class="afe-tr-en" lang="en"><span class="afe-sec-title">English</span>${marked(enText)}</div>`}
        <div class="afe-chips">
          <span class="afe-hint">Insert:</span>
          ${spec.tokens.map(t => html`<button title=${TOKEN_TIP[t]} onClick=${() => insertAt(box.current, msg.value, t, msg.set)}>${t}</button>`)}
        </div>
        <label class="sr-only" for=${`afe-m-${k}`}>${spec.name} ${lang === 'es' ? '(Spanish)' : ''}</label>
        <textarea id=${`afe-m-${k}`} ref=${box} class="form-input afe-email-text" lang=${lang} placeholder=${lang === 'es' ? 'Spanish' : ''} value=${msg.value} onInput=${(e) => msg.set(e.target.value)}></textarea>
        ${lang === 'es' ? html`<${SpanishNotes} st=${st} s=${msg} en=${enText} />` : html`<span class="afe-hint">*Stars* make bold text in JobTread. Each family gets this once.</span>`}
        ${k === 'welcome' && html`
          <div class="afe-field" style="margin-top: .5rem;">
            <label for="afe-m-copyNote">The "copy attached" line</label>
            <input id="afe-m-copyNote" class="form-input" lang=${lang} value=${note.value} placeholder=${lang === 'es' ? note.en : ''} onInput=${(e) => note.set(e.target.value)} />
            <span class="afe-hint">Goes where {copyNote} is, only when the family applied on the website (their PDF is attached).</span>
            ${lang === 'es' && html`<${SpanishNotes} st=${status['message:copyNote'] || 'done'} s=${note} en=${note.en} />`}
          </div>`}
      </section>
      <aside class="afe-email-prev">
        <span class="afe-sec-title">How it reads for ${SAMPLE.parent}${lang === 'es' ? ', in Spanish' : ''}</span>
        <div class="afe-email" aria-label="Sample email">
          <div class="afe-email-head">
            <span class="afe-hint">From the Qualification Committee, through JobTread · To ${SAMPLE.parent}</span>
            <b>${spec.subject[lang === 'es' ? 1 : 0]}</b>
          </div>
          <div class="afe-email-body is-rich" dangerouslySetInnerHTML=${{ __html: jtRich(fillFor(shown, shownNote)) || '<span class="text-muted">No message yet.</span>' }}></div>
        </div>
        ${lang === 'es' && !msg.es && html`<p class="afe-hint">Showing the English: that's what Spanish-speaking families get until there's a translation.</p>`}
      </aside>
    </div>`;
}

/** The reminder emails to families who started and stopped */
function RemindersEditor({ d, lang = 'en' }) {
  const rem = { ...DEFAULT_REMINDERS, ...(d.work.reminders || {}) };
  const subjRef = useRef(null);
  const bodyRef = useRef(null);
  const lastBox = useRef('body');
  const [day, setDay] = useState('');
  const status = useMemo(() => translationStatus(d.work), [d.work]);
  const subj = useString(d, 'reminder:subject', lang);
  const body = useString(d, 'reminder:body', lang);
  const set = (patch) => d.update((w) => { w.reminders = { ...DEFAULT_REMINDERS, ...(w.reminders || {}), ...patch }; });
  const days = [...(rem.days || [])];
  const addDay = () => {
    const n = Math.floor(Number(day));
    if (!(n >= 1 && n <= 60) || days.includes(n) || days.length >= 6) return;
    set({ days: [...days, n].sort((a, b) => a - b) });
    setDay('');
  };
  const vars = { parent: first(SAMPLE.parent), child: first(SAMPLE.child), percent: SAMPLE.percent, year: d.year };
  const fillVars = (s) => String(s || '').replace(/\{(parent|child|percent|year)\}/g, (m, k) => vars[k]);
  const insert = (token) => {
    const s = lastBox.current === 'subject' ? subj : body;
    insertAt(lastBox.current === 'subject' ? subjRef.current : bodyRef.current, s.value, token, s.set);
  };
  const showSubj = lang === 'es' ? (subj.es || subj.en) : subj.en;
  const showBody = lang === 'es' ? (body.es || body.en) : body.en;
  return html`
    <div class="afe-email-work">
      <section class="afe-email-ed" aria-label=${`Reminders, ${lang === 'es' ? 'Spanish' : 'English'}`}>
        ${lang === 'en' && html`
          <div class="afe-rem-row">
            <label class="afe-switch"><input type="checkbox" role="switch" aria-label="Send reminder emails" checked=${rem.enabled !== false} onChange=${(e) => set({ enabled: e.target.checked })} />${rem.enabled !== false ? 'Reminders on' : 'Reminders off'}</label>
          </div>
          <div class="afe-field" style=${rem.enabled === false ? 'opacity: .6;' : ''}>
            <span class="afe-label" id="afe-days-label">Send after this many days of no changes</span>
            <div class="afe-days" role="group" aria-labelledby="afe-days-label">
              ${days.map(n => html`<span class="afe-day">${plural(n, 'day')}<button class="afe-icon-btn" aria-label=${`Remove ${n} days`} onClick=${() => set({ days: days.filter(x => x !== n) })}><${Icon} name="close" size=${12} /></button></span>`)}
              ${days.length < 6 && html`
                <input class="form-input" type="number" min="1" max="60" inputmode="numeric" style="width: 5.5rem;" placeholder="Days" aria-label="Add a reminder after this many days" value=${day} onInput=${(e) => setDay(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); addDay(); } }} />
                <button class="btn btn-ghost btn-sm" onClick=${addDay} disabled=${!day}>Add</button>`}
            </div>
            <span class="afe-hint">Up to 6 reminders, 1 to 60 days. Families who finish, or tap "Stop these reminders", get no more.</span>
          </div>`}
        <div class="afe-chips">
          <span class="afe-hint">Insert:</span>
          ${['{parent}', '{child}', '{percent}', '{year}'].map(t => html`<button title=${TOKEN_TIP[t]} onClick=${() => insert(t)}>${t}</button>`)}
        </div>
        <${Field} label=${lang === 'es' ? 'Subject (Spanish)' : 'Subject'} id="afe-rem-subject">
          ${lang === 'es' && html`<span class="afe-hint" lang="en">English: ${subj.en}</span>`}
          <input id="afe-rem-subject" ref=${subjRef} class="form-input" lang=${lang} value=${subj.value} placeholder=${lang === 'es' ? subj.en : ''} onFocus=${() => { lastBox.current = 'subject'; }} onInput=${(e) => subj.set(e.target.value)} />
          ${lang === 'es' && html`<${SpanishNotes} st=${status['reminder:subject'] || 'done'} s=${subj} en=${subj.en} />`}
        <//>
        <${Field} label=${lang === 'es' ? 'Message (Spanish)' : 'Message'} id="afe-rem-body">
          ${lang === 'es' && html`<div class="afe-tr-en" lang="en">${marked(body.en)}</div>`}
          <textarea id="afe-rem-body" ref=${bodyRef} class="form-input afe-email-text" lang=${lang} rows="9" value=${body.value} onFocus=${() => { lastBox.current = 'body'; }} onInput=${(e) => body.set(e.target.value)}></textarea>
          ${lang === 'es' && html`<${SpanishNotes} st=${status['reminder:body'] || 'done'} s=${body} en=${body.en} />`}
        <//>
      </section>
      <aside class="afe-email-prev">
        <span class="afe-sec-title">How it reads for ${SAMPLE.parent}${lang === 'es' ? ', in Spanish' : ''}</span>
        <div class="afe-email" aria-label="Sample reminder email">
          <div class="afe-email-head"><span class="afe-hint">From Sunshine on a Ranney Day · To ${SAMPLE.parent}</span><b>${fillVars(showSubj) || 'No subject'}</b></div>
          <div class="afe-email-body">${fillVars(showBody) || html`<span class="text-muted">No message yet.</span>`}
            <div style="white-space: normal; margin-top: .9rem;">
              <span class="afe-hint">${vars.percent}% ${lang === 'es' ? 'completado' : 'done'}</span>
              <div class="afe-email-bar"><span></span></div>
              <span class="afe-email-btn">${lang === 'es' ? 'Terminar mi solicitud' : 'Finish my application'}</span>
              <p class="afe-hint" style="margin: .75rem 0 0;">Sunshine on a Ranney Day · ${lang === 'es' ? 'Dejar de recibir estos recordatorios' : 'Stop these reminders'}</p>
            </div>
          </div>
        </div>
      </aside>
    </div>`;
}

// ─── Form → Versions ───────────────────────────────────────────────
function VersionsView({ d, lead = null }) {
  const { meta } = d;
  const [cmp, setCmp] = useState(null); // { title, loading, changes, error }
  if (!meta) return html`<div><${DraftBar} d=${d} lead=${lead} /><${Spinner} /></div>`;
  const rows = meta.versions || [];
  const shown = rows.filter(v => v.state !== 'draft' || meta.draft);
  const label = (s) => (s === 'live' ? html`<span class="badge badge-green">Live</span>` : s === 'draft' ? html`<span class="badge badge-yellow">Draft</span>` : html`<span class="badge badge-gray">Earlier</span>`);
  const compare = async (v, title) => {
    await d.flush();
    setCmp({ title, loading: true });
    const j = await call(`${API}?form-diff=${encodeURIComponent(v)}`);
    setCmp({ title, ...(j.success ? { changes: j.changes || [] } : { error: j.error || 'Could not compare' }) });
  };
  const liveRows = rows.filter(v => v.state !== 'draft');
  const prevOf = (v) => liveRows.find(x => x.version < v.version);
  return html`
    <div>
      <${DraftBar} d=${d} lead=${lead} />
      <div class="card">
        <p class="afe-lede" style="margin-bottom: 1rem;">Every version of the form and its emails that went live. Compare one with the version before it, or restore it into your draft to look it over before putting it live. Each application keeps the version it was answered on.</p>
        <div class="afe-hist">
          ${shown.map(v => html`
            <div>
              <div>
                <strong>Version ${v.version}</strong> ${label(v.state)}
                <div class="text-sm text-muted">${v.state === 'draft' ? `Edited ${when(v.updatedAt)}${v.updatedBy ? ` by ${personName(v.updatedBy)}` : ''}` : `Put live ${when(v.liveAt)}${v.liveBy ? ` by ${personName(v.liveBy)}` : ''}`}${v.note ? ` · ${v.note}` : ''}</div>
              </div>
              <div class="afe-row-actions">
                ${v.state === 'draft'
                  ? html`<button class="btn btn-ghost btn-sm" onClick=${() => compare('draft', "What's changing from the live form")}>What's changing</button>`
                  : html`<button class="btn btn-ghost btn-sm" onClick=${() => compare(v.version, `Version ${v.version} compared with ${prevOf(v) ? `version ${prevOf(v).version}` : 'the built-in form'}`)}>Compare with previous</button>`}
                ${v.state === 'old' && html`<button class="btn btn-ghost btn-sm" onClick=${() => d.restore(v.version)}>Restore as draft</button>`}
              </div>
            </div>`)}
          <div>
            <div><strong>Built-in form</strong> ${meta.live.builtIn ? label('live') : label('old')}<div class="text-sm text-muted">The Jotform application as it stood for 2027.</div></div>
            ${!meta.live.builtIn && html`<button class="btn btn-ghost btn-sm" onClick=${() => d.restore(0)}>Restore as draft</button>`}
          </div>
        </div>
        ${shown.length === 0 && html`<p class="afe-hint" style="margin: .85rem 0 0;">Nothing has been put live yet, so families get the built-in form. Your first Put live shows here as version 1.</p>`}
      </div>
      ${cmp && html`
        <${Dialog} wide title=${cmp.title} onClose=${() => setCmp(null)} footer=${html`<button class="btn btn-primary" onClick=${() => setCmp(null)}>Done</button>`}>
          ${cmp.loading && html`<p class="afe-hint">Comparing…</p>`}
          ${cmp.error && html`<p class="afe-bad">${cmp.error}</p>`}
          ${cmp.changes && html`<${ChangesList} changes=${cmp.changes} empty="No differences." />`}
        <//>`}
    </div>`;
}

// ─── Settings ──────────────────────────────────────────────────────
// How applications run, all in one place, all used as soon as they're saved
// (none of it waits for the form's Put live):
//  - open or closed, the season, the closed message, an outside form, and
//    the times it opens and closes by itself: `application` in the site
//    settings (saveApplicationSettings in functions/api/_applications.js,
//    which writes only that block and logs each field). The form and the
//    Apply page both follow at once (functions/apply/).
//  - who gets the new-application email, the service-area boundary and when
//    status emails go out: the form's settings (saveFormRules in
//    functions/api/_application-forms.js), laid over every version of the form.
// One save bar covers both; ⌘S saves.
const SETTINGS_FIELDS = ['year', 'closedMessage', 'formUrl', 'opensAt', 'closesAt', 'maxApplications', 'warnAt', 'fullMessage'];
const RULE_FIELDS = ['staffEmails', 'serviceArea', 'notify'];
const RULE_NAME = { staffEmails: 'the new-application email', serviceArea: 'the service area', notify: 'email timing' };
const HTTPS_LINK = /^https:\/\/[^\s/]+\.[^\s]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const seasonChoices = () => { const now = new Date().getUTCFullYear(); return [now - 1, now, now + 1, now + 2].map(String); };
const sameFields = (a, b) => !!a && !!b && SETTINGS_FIELDS.every(k => (a[k] || '') === (b[k] || ''));
const sameRule = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
/**
 * After a clash: what I didn't touch (mine still equals what I loaded) takes
 * theirs, field by field inside the timing, so a wait I changed and a switch
 * they changed both survive. Lists (addresses, corners) are whole values.
 */
function followDeep(mine, base, theirs) {
  if (sameRule(mine, base)) return theirs;
  if (isPlain(mine) && isPlain(base) && isPlain(theirs)) {
    return Object.fromEntries([...new Set([...Object.keys(mine), ...Object.keys(theirs)])].map(k => [k, followDeep(mine[k], base[k], theirs[k])]));
  }
  return mine;
}
/** ISO → what a datetime-local box takes, in this browser's time */
const toLocalInput = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(+d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(+d) ? d.toISOString() : ''; };
const zoneName = () => { try { return new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || ''; } catch { return ''; } };
const longWhen = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '');
const shortDay = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
const whoName = (by) => (by === 'schedule' ? 'the schedule' : by === 'limit' ? 'the limit' : personName(by));
const defaultClosed = (year) => `The ${year} application period is currently closed.`;
// The application limit (functions/api/_application-cap.js has the same numbers and words)
const MAX_LIMIT = 10000;
const defaultFull = (year) => `We’ve received all the applications we can take for ${year}.`;
const defaultWarnAt = (max) => Math.max(1, Math.floor(max * 0.8));
const isWhole = (v, max = MAX_LIMIT) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= max;
const limitOf = (e) => (isWhole(e?.maxApplications) ? Number(e.maxApplications) : 0);
const warnOf = (e) => { const max = limitOf(e); return !max ? 0 : isWhole(e.warnAt) && Number(e.warnAt) < max ? Number(e.warnAt) : defaultWarnAt(max); };
/** Saving these edits would close applications: open now, and the new limit is at or under what's in */
const closesOnSave = (s) => !!(s.saved?.open && s.cap && limitOf(s.edit) && limitOf(s.edit) !== limitOf(s.saved) && s.cap.received >= limitOf(s.edit));
const touchOnly = () => { try { return matchMedia('(hover: none) and (pointer: coarse)').matches; } catch { return false; } };
const listText = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** What's wrong, by field (the server checks the same and has the last word) */
function settingsProblems(e, saved, now = Date.now(), cap = null) {
  const out = {};
  if (!e) return out;
  if (e.formUrl && !HTTPS_LINK.test(e.formUrl.trim())) out.formUrl = 'Use a full link that starts with https://';
  for (const k of ['opensAt', 'closesAt']) if (e[k] && e[k] !== saved?.[k] && Date.parse(e[k]) <= now) out[k] = 'Pick a time that hasn’t passed';
  if (e.opensAt && e.closesAt && Date.parse(e.closesAt) <= Date.parse(e.opensAt)) out.closesAt = 'Close after it opens';
  // The application limit
  if (e.maxApplications && !isWhole(e.maxApplications)) out.maxApplications = `Use a whole number from 1 to ${num(MAX_LIMIT)}`;
  const max = limitOf(e);
  if (max && e.warnAt) {
    if (!isWhole(e.warnAt)) out.warnAt = 'Use a whole number';
    else if (Number(e.warnAt) >= max) out.warnAt = `Pick a number under the limit of ${num(max)}`;
  }
  if (max && cap && e.year === cap.year && cap.received >= max && e.opensAt && e.opensAt !== saved?.opensAt) out.opensAt = `${num(cap.received)} of ${num(max)} are already in. Raise the limit to set a time to open.`;
  return out;
}
function rulesProblems(r) {
  const out = {};
  if (!r) return out;
  const bad = (r.staffEmails || []).filter(x => !EMAIL_RE.test(x));
  if (bad.length) out.staffEmails = `${listText(bad.map(x => `"${x}"`))} ${bad.length === 1 ? "isn't an email address" : "aren't email addresses"}.`;
  else if (!(r.staffEmails || []).length) out.staffEmails = 'Add at least one email address.';
  if ((r.serviceArea?.polygon || []).length < 3) out.serviceArea = 'The service area needs at least three corners.';
  return out;
}

const WAIT_NAME = { inReview: 'In Review', decision: 'Approved and Denied', welcome: 'Welcome' };
/** One history entry → the lines it shows (a time cleared by opening says nothing) */
function historyLines(h) {
  const fields = new Set(h.changes.map(c => String(c.field).replace(/^application\./, '')));
  return h.changes.map((c) => {
    const f = String(c.field).replace(/^application\./, '');
    if (f === 'open') return c.to === true ? (h.by === 'schedule' ? 'Opened on schedule' : 'Opened applications') : (h.by === 'schedule' ? 'Closed on schedule' : h.by === 'limit' ? 'Closed: the limit was reached' : 'Closed applications');
    if (f === 'maxApplications') return c.to ? `Limit set to ${plural(c.to, 'application')}` : 'Took the application limit off';
    if (f === 'warnAt') return c.to ? `The team hears at ${plural(c.to, 'application')}` : fields.has('maxApplications') ? null : 'The heads-up went back to 80% of the limit';
    if (f === 'fullMessage') return c.to ? 'Changed the message when full' : 'Went back to the standard message when full';
    if (f === 'opensAt' && !c.to && h.by === 'schedule' && !fields.has('open')) return 'Didn’t open on schedule: the limit was already reached';
    if (f === 'year') return `Season ${c.from || '?'} → ${c.to}`;
    if (f === 'closedMessage') return c.to ? 'Changed the closed message' : 'Went back to the standard closed message';
    if (f === 'formUrl') return c.to ? 'Sent the Apply button to an outside form' : 'Went back to the site’s own form';
    if (f === 'opensAt') return c.to ? `Set to open ${longWhen(c.to)}` : fields.has('open') ? null : 'Took off the scheduled opening';
    if (f === 'closesAt') return c.to ? `Set to close ${longWhen(c.to)}` : fields.has('open') ? null : 'Took off the scheduled close';
    if (f === 'staffEmails') return `New-application email goes to ${c.to || 'nobody'}`;
    if (f === 'serviceArea') return `Reshaped the service area (${plural(c.to, 'corner')})`;
    if (f === 'serviceArea.nearMiles') return c.to > 0 ? `“Close to the area” is now within ${plural(c.to, 'mile')}` : 'Turned “close to the area” off';
    if (f === 'serviceArea.beyond') return c.to === 'stop' ? 'Families far outside the area are now stopped' : 'Families far outside the area can now apply';
    if (f.startsWith('notify.waits.')) return `${WAIT_NAME[f.split('.')[2]] || 'Status'} emails wait ${plural(c.to, 'minute')}`;
    if (f === 'notify.quiet') return c.to === 'off' ? 'Turned quiet hours off' : `Quiet hours ${c.to} Eastern`;
    if (f === 'notify.summary') return `Turned the staff summary ${c.to ? 'on' : 'off'}`;
    return null;
  }).filter(Boolean);
}

/**
 * Both kinds of settings as saved, what's on screen, and one Save for them.
 * Open/Close is its own step (just `open`, after a confirm). Each save sends
 * what it loaded as `base`; if someone changed them since, it shows theirs
 * as saved, keeps these edits, and a second Save uses them.
 */
function useAppSettings(addToast, active) {
  const [saved, setSaved] = useState(null);
  const [edit, setEdit] = useState(null);
  const [rules, setRules] = useState(null);         // { values, updatedAt, updatedBy, defaults }
  const [rulesEdit, setRulesEdit] = useState(null);
  const [since, setSince] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [rulesConflict, setRulesConflict] = useState(null);
  const [serverErrors, setServerErrors] = useState({});
  const [area, setArea] = useState(null);           // { points, history }: homes on the Applicants map, past outlines
  const [cap, setCap] = useState(null);             // where the season stands against its limit (applications-admin capNow)
  const [ways, setWays] = useState({});             // ways to open or close switched on by hand, kept open while blank until Save or Discard
  const take = (j) => { if (j.since !== undefined) setSince(j.since); if (j.history) setHistory(j.history); if (j.area) setArea(j.area); if (j.cap !== undefined) setCap(j.cap); };
  const load = async () => {
    setError(null);
    const j = await call(`${API}?settings=1`);
    if (!j.success) { setError(j.error || 'Could not load the settings.'); return; }
    setSaved(j.settings);
    setEdit(j.settings);
    setWays({});
    if (j.rules) { setRules(j.rules); setRulesEdit(clone(j.rules.values)); }
    take(j);
    setConflict(false);
    setRulesConflict(null);
    setServerErrors({});
  };
  useEffect(() => { load(); }, []);

  const appFields = saved && edit ? SETTINGS_FIELDS.filter(k => (saved[k] || '') !== (edit[k] || '')) : [];
  const changedRules = rules && rulesEdit ? RULE_FIELDS.filter(k => !sameRule(rules.values[k], rulesEdit[k])) : [];
  const dirty = appFields.length > 0 || changedRules.length > 0;
  const problems = { ...settingsProblems(edit, saved, Date.now(), cap), ...rulesProblems(rulesEdit), ...serverErrors };
  const invalid = Object.keys(problems).length > 0;
  // Back on the tab with nothing waiting: show what's saved now (the map may have moved the boundary)
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => { if (active && saved && !dirtyRef.current) load(); }, [active]);
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // Fields the person hasn't touched follow what the server now has
  const follow = (from, to, all = false) => setEdit(e => Object.fromEntries(Object.keys(to).map(k => [k, all || e?.[k] === from?.[k] ? to[k] : e[k]])));
  const post = async (patch, kind) => {
    setBusy(kind);
    const j = await call(API, { settings: patch, base: saved });
    setBusy(null);
    if (j.status === 409 && j.conflict) { follow(saved, j.conflict); setSaved(j.conflict); setConflict(true); return null; }
    if (!j.success) {
      if (j.errors) setServerErrors(Object.fromEntries(j.errors.map(x => [x.field, x.error])));
      addToast(`Couldn't save: ${j.error || `HTTP ${j.status}`}`, 'error');
      return null;
    }
    follow(saved, j.settings, kind === 'save');
    setWays({});
    if (j.capClosed) addToast(`Applications are closed: the limit of ${num(j.settings.maxApplications)} is reached`, 'success');
    setSaved(j.settings);
    take(j);
    setConflict(false);
    setServerErrors(x => Object.fromEntries(Object.entries(x).filter(([k]) => RULE_FIELDS.includes(k))));
    return j;
  };
  const saveRules = async () => {
    const patch = Object.fromEntries(changedRules.map(k => [k, rulesEdit[k]]));
    const j = await call(API, { rules: patch, base: rules.updatedAt });
    if (j.status === 409 && j.conflict) {
      const theirs = { values: j.conflict.rules, updatedAt: j.conflict.updatedAt, updatedBy: j.conflict.updatedBy };
      setRulesEdit(e => Object.fromEntries(RULE_FIELDS.map(k => [k, followDeep(e[k], rules.values[k], theirs.values[k])])));
      setRules(r => ({ ...r, ...theirs }));
      setRulesConflict(theirs);
      return false;
    }
    if (!j.success) {
      if (j.errors) setServerErrors(x => ({ ...x, ...Object.fromEntries(j.errors.map(e => [e.where, e.message])) }));
      addToast(`Couldn't save: ${j.error || `HTTP ${j.status}`}`, 'error');
      return false;
    }
    setRules(j.rules);
    setRulesEdit(clone(j.rules.values));
    if (j.area) setArea(j.area);
    setRulesConflict(null);
    setServerErrors(x => Object.fromEntries(Object.entries(x).filter(([k]) => !RULE_FIELDS.includes(k))));
    if (j.history) setHistory(j.history);
    return true;
  };
  const save = async () => {
    if (!dirty || busy) return false;
    if (invalid) { addToast(Object.values(problems)[0], 'error'); return false; }
    setBusy('save');
    let ok = true;
    if (appFields.length) ok = !!(await post(Object.fromEntries(SETTINGS_FIELDS.map(k => [k, edit[k] || ''])), 'save')) && ok;
    setBusy('save');
    if (changedRules.length) ok = (await saveRules()) && ok;
    setBusy(null);
    if (ok) addToast('Settings saved. They’re in use now.', 'success');
    return ok;
  };
  // `extra` rides along with opening: a higher limit, when the season is full
  const setOpen = async (open, extra = {}) => {
    const j = await post({ open, ...extra }, open ? 'open' : 'close');
    if (j) addToast(open ? `Applications are open. Families can apply for ${j.settings.year} now` : 'Applications are closed. Families who already started can still finish', 'success');
    return !!j;
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!active) return undefined;
    const fn = () => saveRef.current();
    window.addEventListener('soard-save', fn);
    return () => window.removeEventListener('soard-save', fn);
  }, [active]);

  return {
    saved, edit, rules, rulesEdit, since, history, area, cap, ways, error, busy, dirty, appFields, changedRules, problems, invalid, conflict, rulesConflict, save, setOpen, reload: load,
    setWay: (k, v) => setWays(w => (!!w[k] === v ? w : { ...w, [k]: v })),
    set: (patch) => { setEdit(e => ({ ...e, ...patch })); setServerErrors(x => { const y = { ...x }; Object.keys(patch).forEach(k => delete y[k]); return y; }); },
    setRules: (patch) => { setRulesEdit(r => ({ ...r, ...patch })); setServerErrors(x => { const y = { ...x }; Object.keys(patch).forEach(k => delete y[k]); return y; }); },
    discard: () => { setEdit(saved); setWays({}); if (rules) setRulesEdit(clone(rules.values)); setConflict(false); setRulesConflict(null); setServerErrors({}); },
  };
}

function SettingsTab({ s, go, addToast = () => {} }) {
  const [ask, setAsk] = useState(null);
  const head = html`<${Head} title="Settings" sub="Whether applications are open, and everything that opens or closes them; who hears about new ones, the service area and when families are emailed. Changes here are used as soon as you save; none of them wait for the form's Put live." />`;
  if (s.error && !s.edit) return html`
    <div>${head}
      <div class="card">
        <p class="afe-bad" style="margin: 0 0 .75rem;">Couldn't load the settings: ${s.error}</p>
        <button class="btn btn-ghost" onClick=${s.reload}>Try again</button>
      </div>
    </div>`;
  if (!s.edit) return html`<div>${head}<${Spinner} /></div>`;
  return html`
    <div class="afe-settings-tab">
      ${head}
      <div class="afe-set">
        <div class="afe-set-main">
          <${AvailabilityCard} s=${s} onAsk=${setAsk} />

          ${s.rulesEdit && html`
            <${StaffEmailCard} s=${s} />
            <${ServiceAreaCard} s=${s} go=${go} />
            <${TimingCard} s=${s} />`}
        </div>

        <aside class="afe-set-side">
          <${FamilyPreview} s=${s} />
          <${WaitlistPanel} savedOpen=${!!s.saved?.open} addToast=${addToast} />
          <${SettingsHistory} history=${s.history} />
        </aside>
      </div>
      <${SaveBar} s=${s} />
      ${ask && html`<${OpenCloseDialog} mode=${ask} s=${s} onClose=${() => setAsk(null)} />`}
    </div>`;
}

/** "in 3 days" beside a time still to come */
const fromNow = (iso, now = Date.now()) => {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const hours = ms / 36e5;
  if (hours < 1) return `in ${plural(Math.max(1, Math.round(ms / 6e4)), 'minute')}`;
  if (hours < 36) return `in ${plural(Math.round(hours), 'hour')}`;
  return `in ${plural(Math.round(hours / 24), 'day')}`;
};
const whenText = (iso) => { const rel = fromNow(iso); return `${longWhen(iso)}${rel ? ` (${rel})` : ''}`; };
/**
 * What opens or closes applications next by themselves, in one sentence:
 * a time, the limit, whichever comes first. `x` is the settings (as saved,
 * or as edited), `open` whether they're open, `received` how many are in.
 */
function nextText(x, open, received) {
  const max = limitOf(x);
  const full = !!max && received >= max;
  const ends = [x.closesAt && `on ${whenText(x.closesAt)}`, max && `at ${plural(max, 'application')}`].filter(Boolean);
  const endText = `${ends.join(' or ')}${ends.length > 1 ? ', whichever comes first' : ''}`;
  if (open) return full ? `Closes within a minute: the limit of ${num(max)} is reached.` : ends.length ? `Closes by itself ${endText}.` : 'Stays open until someone closes it.';
  if (full) return 'Stays closed until the limit goes up.';
  if (x.opensAt) return `Opens by itself ${whenText(x.opensAt)}.${ends.length ? ` Then closes by itself ${endText}.` : ''}`;
  return `Stays closed until someone opens it.${max ? ` Once open, it closes by itself at ${plural(max, 'application')}.` : ''}`;
}
const PLAN_FIELDS = ['opensAt', 'closesAt', 'maxApplications', 'warnAt'];

/** One setting: what it is on the left, the control on the right (stacked on a phone) */
const SetRow = ({ id = null, rowId = null, label = null, lead = null, hint = null, cls = '', children }) => html`
  <div class=${`afe-srow ${cls}`} id=${rowId || undefined}>
    <div class="afe-srow-l">
      ${lead || html`<label for=${id}>${label}</label>`}
      ${hint && html`<span class="afe-hint">${hint}</span>`}
    </div>
    <div class="afe-srow-c">${children}</div>
  </div>`;

/**
 * Open and closed, in one card. The top is where things stand, as saved:
 * open or closed, since when, what opens or closes them next (a time or the
 * limit, whichever comes first) and the season against its limit, with the
 * one button that opens or closes them. Below: the season, each way they
 * open and close by themselves (a switch per way), and what families read
 * while closed. Everything below goes out with the tab's one Save.
 * The limit is ./_application-cap.js on the server.
 */
function AvailabilityCard({ s, onAsk }) {
  const a = s.saved;
  const e = s.edit;
  const p = s.problems;
  const zone = zoneName();
  // A way switched on by hand stays open while its box is blank (a number being retyped), until Save or Discard
  const on = s.ways;
  const mark = (k) => s.setWay(k, true);

  // Where the season stands, as saved
  const c = s.cap && s.cap.year === a.year ? s.cap : null;
  const max = limitOf(a);
  const received = c?.received ?? 0;
  const full = !a.open && !!max && !!c?.full;
  const warnAt = warnOf(a);
  const near = !!max && !full && received >= warnAt && received < max;
  const pct = (n) => `${Math.min(100, Math.max(0, (n / max) * 100))}%`;
  // The same words as paceWords in functions/api/_application-cap.js; a full season has no pace to speak of
  const pace = c?.perDay && !c.full ? (c.perDay >= 1 ? `about ${num(Math.round(c.perDay))} a day this week` : `about ${num(Math.max(1, Math.round(c.perDay * 7)))} a week`) : null;
  const left = max ? Math.max(0, max - received) : 0;
  const days = c?.perDay && left ? left / c.perDay : null;
  const fills = days && days <= 90 ? (days < 1 ? 'within a day' : days < 1.5 ? 'in about a day' : `in about ${num(Math.round(days))} days`) : null;

  const editMax = limitOf(e);
  // What happens next by itself, as saved; and, while the times or the limit are being changed, after Save
  const next = nextText(a, a.open, received);
  const planEdited = s.appFields.some(k => PLAN_FIELDS.includes(k)) && !PLAN_FIELDS.some(k => p[k]) && !closesOnSave(s);
  const inNow = e.year === a.year ? received : 0;
  const newWarn = warnOf(e);
  const room = editMax && inNow < editMax && (editMax !== max || newWarn !== warnAt)
    ? ` ${num(inNow)} ${inNow === 1 ? 'is' : 'are'} in, so there’s room for ${plural(editMax - inNow, 'more family', 'more families')}; ${newWarn > inNow ? `the team hears at ${num(newWarn)}` : 'the team hears how many are left right away'}.` : '';
  const afterSave = planEdited ? `${nextText(e, a.open, inNow)}${room}` : null;

  // The ways it opens and closes by itself, as edited
  const fullIfSaved = !!c && !!editMax && c.received >= editMax;
  const isOn = { opensAt: !!e.opensAt || !!on.opensAt, closesAt: !!e.closesAt || !!on.closesAt, limit: !!e.maxApplications || !!on.limit };
  const boxId = { opensAt: 'afe-opensAt', closesAt: 'afe-closesAt', limit: 'afe-max' };
  const flip = (k, v) => {
    s.setWay(k, v);
    if (k === 'opensAt' && !v && !a.open) s.setWay('closesAt', false);
    if (v) { requestAnimationFrame(() => document.getElementById(boxId[k])?.focus()); return; }
    if (k === 'limit') s.set({ maxApplications: 0, warnAt: 0 });
    // Closed, a close time needs an opening before it (the server drops it otherwise)
    else if (k === 'opensAt' && !a.open) s.set({ opensAt: '', closesAt: '' });
    else s.set({ [k]: '' });
  };
  const blocked = {
    opensAt: !a.open && fullIfSaved && !e.opensAt ? `The season is full: ${num(c.received)} are in. Raise the limit below first.` : null,
    closesAt: !a.open && !e.opensAt ? 'Turn on “Open on a date” first: there’s nothing to close yet.' : null,
  };
  const way = (k, title, what, offText, control) => {
    const live = isOn[k] && !blocked[k];
    return html`
      <${SetRow} cls=${`afe-way ${live ? 'is-on' : ''}`} rowId=${k === 'limit' ? 'afe-limit' : `afe-way-${k}`} hint=${what}
        lead=${html`<label class="afe-switch"><input type="checkbox" role="switch" id=${`afe-sw-${k}`} checked=${live} disabled=${!!blocked[k]} onChange=${(ev) => flip(k, ev.target.checked)} />${title}</label>`}>
        ${live ? control : html`<p class="afe-sum afe-way-off">${blocked[k] || offText}</p>`}
      <//>`;
  };
  const timeBox = (k) => html`
    <div class="afe-when">
      <input id=${boxId[k]} class="form-input" type="datetime-local" value=${toLocalInput(e[k])} aria-invalid=${p[k] ? 'true' : 'false'}
        aria-label=${k === 'opensAt' ? 'Open on: date and time' : 'Close on: date and time'} aria-describedby=${`${boxId[k]}-h`} onInput=${(ev) => { mark(k); s.set({ [k]: fromLocalInput(ev.target.value) }); }} />
    </div>
    ${p[k] ? html`<span class="afe-bad" id=${`${boxId[k]}-h`}>${p[k]}</span>`
      : html`<span class="afe-hint" id=${`${boxId[k]}-h`}>${e[k] ? `${fromNow(e[k]) ? `${fromNow(e[k])[0].toUpperCase()}${fromNow(e[k]).slice(1)}. ` : ''}Your time${zone ? ` (${zone})` : ''}.` : `Pick a date and time, your time${zone ? ` (${zone})` : ''}.`}</span>`}`;
  const setMax = (v) => { mark('limit'); s.set({ maxApplications: v === '' ? 0 : Number(v), ...(v === '' ? { warnAt: 0 } : {}) }); };
  const limitBox = html`
    <div class="afe-pair afe-limit-fields">
      <div class="afe-field">
        <label for="afe-max">Most applications</label>
        <input id="afe-max" class="form-input" type="number" min="1" max=${MAX_LIMIT} step="1" inputmode="numeric" placeholder="25"
          value=${e.maxApplications || ''} aria-invalid=${p.maxApplications ? 'true' : 'false'} onInput=${(ev) => setMax(ev.target.value)} />
        ${p.maxApplications ? html`<span class="afe-bad">${p.maxApplications}</span>`
          : html`<span class="afe-hint">${c && e.year === a.year ? `${num(received)} in so far. ` : ''}Only applications sent through the form count.</span>`}
      </div>
      <div class="afe-field">
        <label for="afe-warn">Tell the team at</label>
        <input id="afe-warn" class="form-input" type="number" min="1" max=${editMax ? editMax - 1 : undefined} step="1" inputmode="numeric" disabled=${!editMax}
          placeholder=${editMax ? String(defaultWarnAt(editMax)) : ''} value=${editMax && e.warnAt ? e.warnAt : ''} aria-invalid=${p.warnAt ? 'true' : 'false'}
          onInput=${(ev) => { mark('limit'); s.set({ warnAt: ev.target.value === '' ? 0 : Number(ev.target.value) }); }} />
        ${p.warnAt ? html`<span class="afe-bad">${p.warnAt}</span>` : html`<span class="afe-hint">${editMax ? `Blank: at ${num(defaultWarnAt(editMax))}, 80% of the limit. One heads-up in Slack and by email to the staff list.` : 'Set the limit first.'}</span>`}
      </div>
    </div>
    ${closesOnSave(s) && html`
      <p class="afe-note is-warn" role="status"><${Icon} name="warn" size=${16} />
        <span>${num(received)} applications are already in, so saving a limit of ${num(editMax)} closes applications right away. New families will see the message when full, and the team gets the notice.</span>
      </p>`}
`;

  return html`
    <section class=${`card afe-avail ${a.open ? 'is-open' : ''}`} aria-labelledby="afe-status-h">
      <div class="afe-status">
        <div class="afe-status-row">
          <div class="afe-status-text">
            <span class="afe-status-dot" aria-hidden="true"></span>
            <h3 id="afe-status-h" aria-live="polite">${a.open ? 'Applications are open' : full ? 'Applications are closed: the season is full' : 'Applications are closed'}</h3>
            <p>${a.open ? `Families can start a ${a.year} application.` : full ? `All ${num(max)} applications the ${a.year} season takes are in${received > max ? ` (${num(received)} with families who finished after it closed)` : ''}. New families see the message when full.` : `New families can't start an application. Season: ${a.year}.`}${s.since ? ` ${a.open ? 'Opened' : 'Closed'} ${clock(s.since.at)} by ${whoName(s.since.by)}.` : ''}</p>
            <p class="afe-status-next"><${Icon} name="clock" size=${15} /><span>${next}</span></p>
          </div>
          <button class=${`btn ${a.open ? 'btn-ghost' : 'btn-primary'} afe-status-btn`} disabled=${!!s.busy} onClick=${() => onAsk(a.open ? 'close' : 'open')}>
            ${s.busy === 'open' ? 'Opening…' : s.busy === 'close' ? 'Closing…' : a.open ? 'Close applications…' : 'Open applications…'}
          </button>
        </div>

        ${c && html`
          <div class="afe-cap" role="group" aria-label="Applications so far">
            <div class="afe-cap-nums">
              <b>${num(received)}</b>
              <span>${max ? `of ${num(max)} in for ${c.year}` : `in for ${c.year} so far`}</span>
              ${max ? html`<span>· ${c.full ? 'the limit is reached' : `${num(left)} left`}</span>` : html`<span>· no limit</span>`}
            </div>
            ${max ? html`
              <div class=${`afe-cap-bar ${c.full ? 'is-full' : near ? 'is-near' : ''}`} role="img" aria-label=${`${num(received)} of ${num(max)} applications in; the team hears at ${num(warnAt)}`}>
                <span style=${`width: ${pct(received)}`}></span>
                ${warnAt < max && html`<i style=${`left: ${pct(warnAt)}`}></i>`}
              </div>` : null}
            <div class="afe-cap-meta">
              ${max && warnAt < max ? html`<span class="afe-cap-mark">Team hears at ${num(warnAt)}</span>` : null}
              ${c.filling ? html`<span>${plural(c.filling, 'family is', 'families are')} partway through</span>` : null}
              ${pace && html`<span>${pace}${max && fills ? `, so it fills ${fills}` : ''}</span>`}
              ${c.addedInJobTread ? html`<span>${plural(c.addedInJobTread, 'family', 'families')} added in JobTread for ${c.year} ${c.addedInJobTread === 1 ? 'doesn’t' : 'don’t'} count</span>` : null}
              ${!max && !c.filling && !pace && !c.addedInJobTread ? html`<span>Tests and deleted applications don’t count.</span>` : null}
            </div>
          </div>`}

        <p class="afe-reach"><span class="afe-live is-on" aria-hidden="true"></span>The Apply page and the application form follow this right away: <a href="/apply/" target="_blank" rel="noopener">/apply/</a> · <a href="/apply/form/" target="_blank" rel="noopener">/apply/form/</a></p>
      </div>

      <div class="afe-band" role="group" aria-labelledby="afe-band-when">
        <h4 id="afe-band-when">When applications run</h4>
        <p class="afe-lede">The season, then each way they open and close by themselves. Whichever comes first wins: the site acts within a minute, posts a note in Slack and logs it under Recent changes.</p>
        <div class="afe-rows">
          <${SetRow} id="afe-season" label="Season" hint="The year families apply for. It fills in {year} across the form and the emails.">
            <select id="afe-season" class="form-input" value=${e.year} onChange=${(ev) => s.set({ year: ev.target.value })}>
              ${seasonChoices().map(y => html`<option value=${y}>${y}</option>`)}
            </select>
          <//>
          ${!a.open && way('opensAt', 'Open on a date', 'Applications open by themselves at this time.', 'Off: they stay closed until someone opens them.', timeBox('opensAt'))}
          ${way('closesAt', 'Close on a date', 'Applications close by themselves at this time.', a.open || e.opensAt ? 'Off: no closing date.' : '', timeBox('closesAt'))}
          ${way('limit', 'Close at a number of applications', 'Applications close by themselves once this many are in. Families partway through can still finish, so a season can end a little over.', 'Off: no limit.', limitBox)}
        </div>
        <p class="afe-note afe-after" role="status" aria-live="polite" hidden=${!afterSave}><${Icon} name="clock" size=${16} />
          <span><b>After you save:</b> ${afterSave}</span>
        </p>
      </div>

      <div class="afe-band" role="group" aria-labelledby="afe-band-words">
        <h4 id="afe-band-words">What families read</h4>
        <p class="afe-lede">On the Apply page and the form. “What families see” shows each one as you type.</p>
        <div class="afe-rows">
          <${SetRow} id="afe-closed" label="While closed" hint="Beside the “notify me” box, so families can hear when applications open.">
            <input id="afe-closed" class="form-input" maxlength="200" value=${e.closedMessage} placeholder=${defaultClosed(e.year)} onInput=${(ev) => s.set({ closedMessage: ev.target.value })} />
            <span class="afe-hint">Blank shows “${defaultClosed(e.year)}”</span>
          <//>
          ${editMax ? html`
            <${SetRow} id="afe-full" label="When the season is full" hint="Instead of the closed message, once the limit closes applications.">
              <input id="afe-full" class="form-input" maxlength="200" value=${e.fullMessage} placeholder=${defaultFull(e.year)} onInput=${(ev) => s.set({ fullMessage: ev.target.value })} />
              <span class="afe-hint">Blank shows “${defaultFull(e.year)}”, in Spanish on the Spanish form.</span>
            <//>` : null}
          <${SetRow} id="afe-formurl" lead=${html`<label for="afe-formurl">Outside form <span class="afe-opt">optional</span></label>`} hint="Where Apply Now goes while applications are open.">
            <input id="afe-formurl" class="form-input" type="url" inputmode="url" value=${e.formUrl} placeholder="https://" aria-invalid=${p.formUrl ? 'true' : 'false'} onInput=${(ev) => s.set({ formUrl: ev.target.value })} />
            ${p.formUrl ? html`<span class="afe-bad">${p.formUrl}</span>` : html`<span class="afe-hint">Blank: the site’s own form. A link here sends Apply Now to that form instead, in a new tab.</span>`}
          <//>
        </div>
      </div>
    </section>`;
}

/** Shown while anything on the tab is unsaved: what, and Save or Discard (⌘S saves) */
function SaveBar({ s }) {
  const touched = (ks) => s.appFields.some(k => ks.includes(k));
  const what = [
    touched(['year']) && 'the season',
    touched(['opensAt', 'closesAt']) && 'the open and close times',
    touched(['maxApplications', 'warnAt']) && 'the application limit',
    touched(['closedMessage', 'fullMessage', 'formUrl']) && 'what families read',
    ...s.changedRules.map(k => RULE_NAME[k]),
  ].filter(Boolean);
  const closing = closesOnSave(s);
  const who = s.rulesConflict?.updatedBy || null;
  if (!s.dirty && !s.conflict && !s.rulesConflict) return null;
  return html`
    <div class="afe-savebar" role="region" aria-label="Unsaved settings">
      <div class="afe-savebar-text">
        ${(s.conflict || s.rulesConflict)
          ? html`<strong>${who ? `${personName(who)} changed` : 'Someone changed'} these settings while you had them open.</strong><span class="afe-hint">Your changes are still here: Save to use yours, or Discard to see theirs.</span>`
          : html`<strong>Unsaved changes to ${listText(what)}</strong><span class="afe-hint">${s.invalid ? Object.values(s.problems)[0] : closing ? `Saving closes applications: ${num(s.cap.received)} are in and the new limit is ${num(limitOf(s.edit))}.` : touchOnly() ? 'Used as soon as you save.' : `Used as soon as you save (${MOD}S).`}</span>`}
      </div>
      <div class="afe-row-actions">
        <button class="btn btn-ghost" disabled=${!!s.busy} onClick=${s.discard}>Discard</button>
        <button class="btn btn-primary" disabled=${!s.dirty || !!s.busy || s.invalid} onClick=${s.save}>${s.busy === 'save' ? 'Saving…' : 'Save'}</button>
      </div>
    </div>`;
}

/** A list of email addresses as chips: type, then Enter or a comma */
function EmailListInput({ id, value, onChange, invalid = false }) {
  const [text, setText] = useState('');
  const add = (raw) => {
    const parts = String(raw).split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (!parts.length) { setText(''); return; }
    const next = [...value];
    for (const x of parts) if (!next.some(y => y.toLowerCase() === x.toLowerCase())) next.push(x);
    onChange(next.slice(0, 10));
    setText('');
  };
  return html`
    <div class="afe-chipfield ${invalid ? 'is-invalid' : ''}" onClick=${(ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.querySelector('input')?.focus(); }}>
      ${value.map((x, i) => html`<span class="afe-addr ${EMAIL_RE.test(x) ? '' : 'is-bad'}" key=${x}>${x}<button type="button" aria-label=${`Remove ${x}`} onClick=${() => onChange(value.filter((_, j) => j !== i))}><${Icon} name="close" size=${12} /></button></span>`)}
      <input id=${id} type="text" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" aria-invalid=${invalid ? 'true' : 'false'}
        placeholder=${value.length ? 'Add another address' : 'name@soardcharity.com'} value=${text}
        onInput=${(ev) => { const v = ev.target.value; if (/[,;\s]$/.test(v)) add(v); else setText(v); }}
        onKeyDown=${(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(text); } else if (ev.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1)); }}
        onBlur=${() => add(text)} />
    </div>`;
}

function StaffEmailCard({ s }) {
  const list = s.rulesEdit.staffEmails || [];
  return html`
    <section class="card afe-settings" aria-labelledby="afe-set-staff">
      <h3 id="afe-set-staff">New applications</h3>
      <p class="afe-lede">Who's told when a family applies on the website. Each new application emails them the child's first name, the makeover type and a link to the family, and posts in Slack.</p>
      <div class="afe-field afe-set-fields">
        <label for="afe-staff">Who gets the new-application email</label>
        <${EmailListInput} id="afe-staff" value=${list} invalid=${!!s.problems.staffEmails} onChange=${(v) => s.setRules({ staffEmails: v })} />
        ${s.problems.staffEmails ? html`<span class="afe-bad">${s.problems.staffEmails}</span>` : html`<span class="afe-hint">Up to 10 addresses. Type one, then Enter or a comma.</span>`}
      </div>
    </section>`;
}

/**
 * The area drawn to scale, as families see it (yellow, a charcoal line), with
 * the "close" ring dashed around it and, when given, every family's home as a
 * dot by where it lands. No map tiles: the shape is the point.
 */
function AreaOutline({ polygon, nearMiles = 0, points = [], moving = null, size = 136, height = size, corners = true, label = null }) {
  if (!polygon || polygon.length < 3) return html`<div class="afe-area-svg is-empty" style=${`width:${size}px;height:${height}px`}><span class="afe-hint">No boundary</span></div>`;
  const ring = nearMiles > 0 ? nearRing(polygon, nearMiles, 96) : [];
  const frame = ring.length ? ring : polygon;
  const lat0 = polygon.reduce((n, pt) => n + pt[0], 0) / polygon.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xy = ([lat, lng]) => [lng * k, -lat];
  const fx = frame.map(xy);
  const x0 = Math.min(...fx.map(p => p[0]));
  const y0 = Math.min(...fx.map(p => p[1]));
  const w = Math.max(...fx.map(p => p[0])) - x0 || 1;
  const hh = Math.max(...fx.map(p => p[1])) - y0 || 1;
  const pad = 10;
  const sc = Math.min((size - 2 * pad) / w, (height - 2 * pad) / hh);
  const ox = pad + (size - 2 * pad - w * sc) / 2;
  const oy = pad + (height - 2 * pad - hh * sc) / 2;
  const P = (pt) => { const [x, y] = xy(pt); return [ox + (x - x0) * sc, oy + (y - y0) * sc]; };
  const pts = (list) => list.map(pt => P(pt).map(v => v.toFixed(1)).join(',')).join(' ');
  const area = { polygon, nearMiles };
  const dots = points.map(p => ({ p, at: P([p.lat, p.lng]), band: placeHome(p.lat, p.lng, area).band }))
    .filter(d => d.at[0] >= 2 && d.at[0] <= size - 2 && d.at[1] >= 2 && d.at[1] <= height - 2);
  return html`<svg class="afe-area-svg" width=${size} height=${height} viewBox=${`0 0 ${size} ${height}`} role="img"
    aria-label=${label || `The service area, ${polygon.length} corners${ring.length ? `, with the ${nearMiles}-mile close ring` : ''}`}>
    ${ring.length > 0 && html`<polygon class="afe-area-ring" points=${pts(ring)} />`}
    <polygon class="afe-area-fill" points=${pts(polygon)} />
    ${dots.map(d => html`<circle key=${d.p.id || `${d.p.lat},${d.p.lng}`} class=${`afe-area-pt is-${d.band}${moving?.has(d.p.id) ? ' is-moving' : ''}`} cx=${d.at[0].toFixed(1)} cy=${d.at[1].toFixed(1)} r=${moving?.has(d.p.id) ? 3.6 : 2.3} />`)}
    ${corners && polygon.map((pt, i) => { const [x, y] = P(pt); return html`<circle key=${`c${i}`} class="afe-area-corner" cx=${x.toFixed(1)} cy=${y.toFixed(1)} r="2.6" />`; })}
  </svg>`;
}

const BEYOND_TEXT = {
  warn: { title: 'Tell them, and let them apply', hint: 'They read that the home is outside the area, with the distance, and can still send an application. Staff see it flagged.' },
  stop: { title: 'Stop the application', hint: 'They see the “outside” stop screen with the map and their home on it, and can change the address. Its wording is in Form.' },
};
const ringText = (m) => (m > 0 ? `within ${plural(m, 'mile')}` : 'off');

function ServiceAreaCard({ s, go }) {
  const sa = s.rulesEdit.serviceArea || {};
  const poly = sa.polygon || [];
  const nearMiles = sa.nearMiles ?? 15;
  const beyond = sa.beyond === 'stop' ? 'stop' : 'warn';
  const live = s.rules?.values?.serviceArea || {};
  const points = s.area?.points || [];
  const setArea = (patch) => s.setRules({ serviceArea: { ...sa, ...patch } });
  const asText = (pts) => pts.map(pt => pt.join(', ')).join('\n');
  const [text, setText] = useState(() => asText(poly));
  const [bad, setBad] = useState('');
  const [addr, setAddr] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  // The corners change elsewhere too (Discard, someone else's save): follow unless this box is mid-edit
  const typing = useRef(false);
  const key = JSON.stringify(poly);
  useEffect(() => { if (!typing.current) { setText(asText(poly)); setBad(''); } typing.current = false; }, [key]);
  const parse = (t) => t.split('\n').map(x => x.trim()).filter(Boolean).map(x => x.split(/[,\s]+/).map(Number));
  const onText = (t) => {
    setText(t);
    const pts = parse(t);
    if (pts.some(pt => pt.length !== 2 || !pt.every(Number.isFinite) || Math.abs(pt[0]) > 90 || Math.abs(pt[1]) > 180)) { setBad('Each line needs a latitude and a longitude, like 34.33, -84.48.'); return; }
    if (pts.length < 3) { setBad('The area needs at least three corners.'); return; }
    setBad('');
    typing.current = true;
    setArea({ polygon: pts });
  };
  const test = async () => {
    if (!addr.trim()) return;
    setBusy(true);
    const j = await call(API, { areaTest: addr.trim(), polygon: poly, nearMiles });
    setBusy(false);
    setRes(j.success ? j : { error: j.error || 'Could not check it' });
  };
  // What the settings on screen mean for the families already on the Applicants map
  const counts = useMemo(() => bandCounts(points, { polygon: poly, nearMiles }), [points, key, nearMiles]);
  const placed = counts.inside + counts.near + counts.far;
  const moved = useMemo(() => (live.polygon ? bandChanges(points, { polygon: live.polygon, nearMiles: live.nearMiles ?? 15 }, { polygon: poly, nearMiles }) : []), [points, key, nearMiles, live.polygon, live.nearMiles]);
  const movedSet = useMemo(() => new Set(moved.map(m => m.id)), [moved]);
  const word = { inside: 'inside', near: 'close', far: 'farther out', unknown: 'off the map' };
  const movedText = (() => {
    if (!moved.length) return null;
    const by = {};
    for (const m of moved) by[word[m.to]] = (by[word[m.to]] || 0) + 1;
    return `Compared with what's in use: ${listText(Object.entries(by).map(([w, n]) => `${plural(n, 'family')} would count as ${w}`))}.`;
  })();
  const changed = s.changedRules.includes('serviceArea');
  const history = (s.area?.history || []).filter(h => h.polygon?.length >= 3);
  return html`
    <section class="card afe-settings" aria-labelledby="afe-set-area">
      <h3 id="afe-set-area">Service area</h3>
      <p class="afe-lede">Families see this area on a map as they type their home address, and the form answers “inside the service area?” from the address (the Census places it). Staff see the same check on every family.</p>
      <div class="afe-area">
        <${AreaOutline} polygon=${poly} nearMiles=${nearMiles} points=${points} moving=${movedSet} size=${220} height=${176} />
        <div class="afe-area-text">
          <p><strong>${plural(poly.length, 'corner')}</strong>${changed ? html` <span class="badge badge-yellow">Not saved</span>` : ''}</p>
          <button class="btn btn-ghost" disabled=${s.dirty} title=${s.dirty ? 'Save or discard the changes here first' : ''} onClick=${() => go('applicants', { editBoundary: true })}>Reshape it on the map</button>
          <span class="afe-hint">${s.dirty ? 'Save or discard the changes on this page first.' : 'The map shows every family’s home against it, and saves as soon as you’re done.'}</span>
        </div>
      </div>

      <div class="afe-area-rules">
        <div class="afe-field">
          <label for="afe-near">Close to the area</label>
          <div class="afe-near">
            <input type="range" min="0" max=${NEAR_MAX} step="1" value=${nearMiles} aria-label="Close to the area, in miles" aria-valuetext=${ringText(nearMiles)}
              onInput=${(ev) => setArea({ nearMiles: Number(ev.target.value) })} />
            <input id="afe-near" class="form-input" type="number" min="0" max=${NEAR_MAX} inputmode="numeric" value=${nearMiles}
              onInput=${(ev) => { const v = Math.round(Number(ev.target.value)); if (Number.isFinite(v)) setArea({ nearMiles: Math.max(0, Math.min(NEAR_MAX, v)) }); }} />
            <span class="afe-hint">miles</span>
          </div>
          <span class="afe-hint">${nearMiles > 0 ? `Homes outside the line by ${plural(nearMiles, 'mile')} or less count as close: families there read that they can still apply. The dashed ring shows it.` : 'Off: every home outside the line counts as farther out.'}</span>
        </div>
        ${placed > 0 && html`
          <div class="afe-area-split" aria-live="polite">
            <span class="afe-label">The ${plural(placed, 'family', 'families')} on the Applicants map, by these settings</span>
            <${StackBar} parts=${[
              { label: 'Inside', n: counts.inside, color: '#373A36' },
              { label: nearMiles > 0 ? `Close (${ringText(nearMiles)})` : 'Close', n: counts.near, color: '#D9A400' },
              { label: 'Farther out', n: counts.far, color: '#A6A7AC' },
            ]} total=${placed} />
            ${movedText && html`<span class="afe-hint">${movedText}</span>`}
          </div>`}
        <div class="afe-field">
          <span class="afe-label" id="afe-beyond-l">Families farther out than that</span>
          <div class="afe-beyond" role="radiogroup" aria-labelledby="afe-beyond-l">
            ${['warn', 'stop'].map(k => html`<button type="button" role="radio" aria-checked=${beyond === k ? 'true' : 'false'} tabindex=${beyond === k ? 0 : -1}
              onClick=${() => setArea({ beyond: k })}
              onKeyDown=${(ev) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) { ev.preventDefault(); const n = k === 'warn' ? 'stop' : 'warn'; setArea({ beyond: n }); ev.currentTarget.parentElement.querySelector(`[data-k="${n}"]`)?.focus(); } }}
              data-k=${k}><b>${BEYOND_TEXT[k].title}</b><span>${BEYOND_TEXT[k].hint}</span></button>`)}
          </div>
          ${placed > 0 && counts.far > 0 && html`<span class="afe-hint">${plural(counts.far, 'family', 'families')} on the map live this far out${beyond === 'stop' ? ': under this setting, the form would have stopped them.' : '.'}</span>`}
        </div>
      </div>

      <div class="afe-field" style="margin-top: 1rem;">
        <label for="afe-area-test">Try an address</label>
        <div class="afe-row-actions" style="flex-wrap: nowrap;">
          <input id="afe-area-test" class="form-input" placeholder="1 Main St, Marietta, GA 30060" value=${addr} onInput=${(ev) => setAddr(ev.target.value)} onKeyDown=${(ev) => { if (ev.key === 'Enter') test(); }} />
          <button class="btn btn-ghost" disabled=${busy || !addr.trim()} onClick=${test}>${busy ? 'Checking…' : 'Check'}</button>
        </div>
        ${res && html`<p class=${res.error ? 'afe-bad' : 'afe-sum'} aria-live="polite">${res.error || `${res.text}${res.area?.county ? ` (${res.area.county} County)` : ''}${res.area?.band === 'far' ? (beyond === 'stop' ? '. The form would stop this family.' : '. The form tells this family, and they can still apply.') : ''}`}</p>`}
        <span class="afe-hint">Uses what's on screen here, saved or not, the same way the form does.</span>
      </div>

      ${history.length > 1 && html`
        <details class="afe-corners">
          <summary>Earlier outlines (${history.length - 1})</summary>
          <ul class="afe-outlines">
            ${history.map(h => {
              const same = JSON.stringify(h.polygon) === key;
              const shift = same ? [] : bandChanges(points, { polygon: poly, nearMiles }, { polygon: h.polygon, nearMiles });
              return html`<li key=${h.id}>
                <${AreaOutline} polygon=${h.polygon} size=${56} height=${44} corners=${false} label=${`Outline from ${shortDay(h.at)}`} />
                <div>
                  <span><b>${h.note || clock(h.at)}</b>${h.live ? html` <span class="badge badge-green">In use</span>` : ''}${same && !h.live ? html` <span class="badge badge-yellow">On screen</span>` : ''}</span>
                  <span class="afe-hint">${[plural(h.polygon.length, 'corner'), h.by ? personName(h.by) : null, shift.length ? `${plural(shift.length, 'family', 'families')} would change` : null].filter(Boolean).join(' · ')}</span>
                </div>
                ${!same && html`<button class="btn btn-ghost btn-sm" onClick=${() => setArea({ polygon: h.polygon })}>Use this one</button>`}
              </li>`;
            })}
          </ul>
          <span class="afe-hint">“Use this one” puts it on screen here; Save makes it the one in use.</span>
        </details>`}

      <details class="afe-corners">
        <summary>Edit the corners by hand</summary>
        <${Field} label=${`Corners (${parse(text).length})`} id="afe-area" hint="One corner per line: latitude, longitude. They join in order and back to the first.">
          <textarea id="afe-area" class="form-input" rows="6" style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem;" value=${text} aria-invalid=${bad || s.problems.serviceArea ? 'true' : 'false'} onInput=${(ev) => onText(ev.target.value)}></textarea>
        <//>
        ${(bad || s.problems.serviceArea) && html`<p class="afe-bad" style="margin-top: -.5rem;">${bad || s.problems.serviceArea}</p>`}
      </details>
    </section>`;
}

/** When status emails go out: waits, quiet hours, and the summary to staff (./_applicant-notify.js) */
function TimingCard({ s }) {
  const n = s.rulesEdit.notify || DEFAULT_NOTIFY;
  const waits = { ...DEFAULT_NOTIFY.waits, ...(n.waits || {}) };
  const quiet = { ...DEFAULT_NOTIFY.quiet, ...(n.quiet || {}) };
  const summary = n.summary !== false;
  const set = (patch) => s.setRules({ notify: { waits: { ...waits, ...(patch.waits || {}) }, quiet: { ...quiet, ...(patch.quiet || {}) }, summary: 'summary' in patch ? patch.summary : summary } });
  const quietOn = quiet.start !== quiet.end;
  const hourLabel = (h) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const mins = (key, label, hint) => html`
    <div class="afe-field">
      <label class="afe-label" for=${`afe-wait-${key}`}>${label}</label>
      <div style="display: flex; gap: .5rem; align-items: center;">
        <input id=${`afe-wait-${key}`} class="form-input" type="number" min="0" max="1440" inputmode="numeric" style="width: 6rem;" value=${waits[key]} onInput=${(ev) => set({ waits: { [key]: Math.max(0, Math.min(1440, Math.round(Number(ev.target.value) || 0))) } })} />
        <span class="afe-hint">minutes</span>
      </div>
      <span class="afe-hint">${hint}</span>
    </div>`;
  return html`
    <section class="card afe-settings" id="afe-timing" aria-labelledby="afe-set-timing">
      <h3 id="afe-set-timing">When status emails go out</h3>
      <p class="afe-lede">A family is emailed once their status has stayed put for the wait below, so a change made by mistake and put back never reaches them. If someone flips a status back and forth, the family gets one email for where it lands, or none. The wording is in <a href="#applications/emails">Emails</a>.</p>
      <div class="afe-grid2" style="margin-top: 1rem;">
        <div>
          ${mins('inReview', 'In Review', 'Most mistakes are fixed within a few minutes.')}
          ${mins('decision', 'Approved and Denied', 'Decisions wait longer: a wrong one is the email that hurts.')}
          ${mins('welcome', 'Welcome for families added in JobTread', 'Families who apply on the website get theirs right away.')}
        </div>
        <div>
          <div class="afe-field">
            <span class="afe-label">Quiet hours (Eastern)</span>
            <label class="afe-switch" style="margin-bottom: .5rem;"><input type="checkbox" role="switch" aria-label="Quiet hours" checked=${quietOn} onChange=${(ev) => set({ quiet: ev.target.checked ? { start: 20, end: 8 } : { start: 0, end: 0 } })} />${quietOn ? 'On' : 'Off'}</label>
            ${quietOn && html`<div style="display: flex; gap: .5rem; align-items: center; flex-wrap: wrap;">
              <span class="afe-hint">No family emails from</span>
              <select class="form-select" style="width: auto;" aria-label="Quiet hours start" value=${quiet.start} onChange=${(ev) => set({ quiet: { start: Number(ev.target.value) } })}>${hours.map(h => html`<option value=${h}>${hourLabel(h)}</option>`)}</select>
              <span class="afe-hint">to</span>
              <select class="form-select" style="width: auto;" aria-label="Quiet hours end" value=${quiet.end} onChange=${(ev) => set({ quiet: { end: Number(ev.target.value) } })}>${hours.map(h => html`<option value=${h}>${hourLabel(h)}</option>`)}</select>
            </div>`}
            <span class="afe-hint">${quietOn ? `An email due in quiet hours waits until ${hourLabel(quiet.end)}.` : 'Emails go whenever their wait is over, day or night.'}</span>
          </div>
          <div class="afe-field">
            <span class="afe-label">Summary for staff</span>
            <label class="afe-switch"><input type="checkbox" role="switch" aria-label="Summary email for staff" checked=${summary} onChange=${(ev) => set({ summary: ev.target.checked })} />${summary ? 'On' : 'Off'}</label>
            <span class="afe-hint">After someone changes statuses in JobTread, they get one email listing each family with Move back, Don't email and Send now. Families' emails wait 5 minutes after the summary, so there's time to act.</span>
          </div>
        </div>
      </div>
    </section>`;
}

/** The confirm step: exactly what opening or closing changes */
function OpenCloseDialog({ mode, s, onClose }) {
  const a = s.saved;
  const opening = mode === 'open';
  // A full season opens only with a higher limit (or none), set right here
  const c = s.cap && s.cap.year === a.year && s.cap.max ? s.cap : null;
  const full = opening && !!c?.full;
  const [raise, setRaise] = useState('');
  const raiseOk = isWhole(raise) && Number(raise) > (c?.received || 0);
  // A heads-up point already passed would never be heard again: it goes back to 80% of the new limit
  const keepWarn = !!(a.warnAt && c && a.warnAt > c.received);
  const raised = { maxApplications: Number(raise), ...(keepWarn ? {} : { warnAt: '' }) };
  const newWarn = raiseOk ? warnOf({ ...a, ...raised }) : 0;
  const confirm = async (extra = {}) => { if (await s.setOpen(opening, extra)) onClose(); };
  const busyWord = opening ? 'Opening…' : 'Closing…';
  return html`
    <${Dialog} title=${opening ? `Open applications for ${a.year}?` : 'Close applications?'} onClose=${onClose}
      footer=${full ? html`
        <button class="btn btn-ghost" onClick=${onClose}>Cancel</button>
        <button class="btn btn-ghost" disabled=${!!s.busy} onClick=${() => confirm({ maxApplications: '' })}>Open with no limit</button>
        <button class="btn btn-primary" disabled=${!!s.busy || !raiseOk} onClick=${() => confirm(raised)}>${s.busy ? busyWord : raiseOk ? `Raise to ${num(raise)} and open` : 'Raise the limit and open'}</button>`
      : html`
        <button class="btn btn-ghost" onClick=${onClose}>Cancel</button>
        <button class="btn btn-primary" disabled=${!!s.busy} onClick=${() => confirm()}>${s.busy ? busyWord : opening ? 'Open applications' : 'Close applications'}</button>`}>
      ${full && html`
        <div class="afe-note is-warn" style="margin-bottom: 1rem;"><${Icon} name="warn" size=${16} />
          <span>The ${a.year} season is full: ${num(c.received)} applications are in and the limit is ${num(c.max)}. To open again, raise the limit or take it off.</span>
        </div>
        <div class="afe-cap-raise">
          <label class="afe-label" for="afe-raise">New limit</label>
          <input id="afe-raise" class="form-input" type="number" min=${c.received + 1} max=${MAX_LIMIT} step="1" inputmode="numeric" value=${raise}
            aria-invalid=${raise && !raiseOk ? 'true' : 'false'} onInput=${(ev) => setRaise(ev.target.value)} />
          <span class=${raise && !raiseOk ? 'afe-bad' : 'afe-hint'}>${raise && !raiseOk ? `Pick more than the ${num(c.received)} already in.` : raiseOk ? `${newWarn > c.received ? `The team hears at ${num(newWarn)}` : 'The team hears how many are left right away'}, and it closes by itself again at ${num(raise)}.` : `More than the ${num(c.received)} already in.`}</span>
        </div>`}
      <ul class="afe-effects" style=${full ? 'margin-top: 1rem;' : ''}>
        ${opening ? html`
          <li>Families can start a ${a.year} application at <strong>/apply/form/</strong> right away.</li>
          ${c && !full && html`<li>It closes by itself at ${plural(c.max, 'application')}. ${num(c.received)} ${c.received === 1 ? 'is' : 'are'} in now.</li>`}
          <${WaitlistOpenNote} />
          <li>The Apply page shows its Apply button right away too.</li>
          ${a.formUrl && html`<li>The Apply button goes to your outside form: <span class="afe-mono">${a.formUrl}</span></li>`}
          ${a.opensAt && html`<li>The opening set for ${longWhen(a.opensAt)} isn't needed and comes off.</li>`}
          ${a.closesAt && html`<li>It still closes by itself ${longWhen(a.closesAt)}.</li>`}`
        : html`
          <li>New families see: <q>${a.closedMessage || defaultClosed(a.year)}</q></li>
          <li>Families who already started can still finish and submit.</li>
          <li>The Apply page switches to its closed banner right away.</li>
          ${a.closesAt && html`<li>The close set for ${longWhen(a.closesAt)} isn't needed and comes off.</li>`}`}
      </ul>
      ${s.dirty && html`<p class="afe-hint" style="margin: 1rem 0 0;">This changes only open or closed. Your other unsaved changes stay as they are.</p>`}
    <//>`;
}

/** The Apply page's banner, drawn from what's on screen (unsaved edits too) */
function FamilyPreview({ s }) {
  const [show, setShow] = useState(null);
  const e = s.edit;
  const limited = !!limitOf(e);
  // Closed and full right now: the preview starts on what families actually see
  const now = s.saved.open ? 'open' : s.cap?.full && s.cap.year === s.saved.year ? 'full' : 'closed';
  const view = show === 'full' && !limited ? 'closed' : show || now;
  const open = view === 'open';
  const message = view === 'full' ? (e.fullMessage || '').trim() || defaultFull(e.year) : (e.closedMessage || '').trim() || defaultClosed(e.year);
  return html`
    <section class="card afe-fam" aria-labelledby="afe-fam-h">
      <div class="afe-fam-head">
        <h4 id="afe-fam-h">What families see</h4>
        <div class="afe-fam-switch">
          <span class="afe-hint" id="afe-fam-as">Preview as</span>
          <div class="afe-seg afe-seg-text" role="group" aria-labelledby="afe-fam-as">
            <button aria-pressed=${open} onClick=${() => setShow('open')}>Open</button>
            <button aria-pressed=${view === 'closed'} onClick=${() => setShow('closed')}>Closed</button>
            ${limited && html`<button aria-pressed=${view === 'full'} onClick=${() => setShow('full')}>Full</button>`}
          </div>
        </div>
      </div>
      <p class="afe-hint" style="margin: 0 0 .7rem;">The banner on the Apply page${s.dirty ? ', with your unsaved changes' : ''}. Switching here only changes the preview.</p>
      <div class="afe-fam-banner ${open ? 'is-open' : ''}">
        <div class="afe-fam-top">
          <span class="afe-fam-dot" aria-hidden="true"></span>
          <div>
            <b>${open ? `The ${e.year} application is now open!` : message}</b>
            <span>${open ? "We're accepting applications for room makeovers in the greater Atlanta area." : "Leave your email and we'll let you know the moment applications reopen."}</span>
          </div>
        </div>
        ${open
          ? html`<span class="afe-fam-btn">Apply Now →</span>${e.formUrl ? html`<span class="afe-fam-to">Opens ${short(e.formUrl, 44)}</span>` : null}`
          : html`<div class="afe-fam-notify"><span class="afe-fam-input">Your email address</span><span class="afe-fam-btn">Notify Me</span></div>`}
      </div>
    </section>`;
}

function SettingsHistory({ history }) {
  const rows = history.flatMap(h => historyLines(h).map((t, i) => ({ key: `${h.at}-${i}`, t, h })));
  return html`
    <section class="card afe-log-card" aria-labelledby="afe-log-h">
      <h4 id="afe-log-h">Recent changes</h4>
      ${rows.length
        ? html`<ol class="afe-log">${rows.slice(0, 12).map(r => html`<li key=${r.key}><span>${r.t}</span><span class="afe-hint">${clock(r.h.at)} · ${whoName(r.h.by)}</span></li>`)}</ol>`
        : html`<p class="afe-hint" style="margin: 0;">Opening, closing and every setting here show up when they change, with who changed them.</p>`}
    </section>`;
}
