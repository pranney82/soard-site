/**
 * Admin → Applications (loaded on first visit, like ./automations.js)
 * ===========================================================================
 * Eight tabs over functions/api/applications-admin.js, each with its own hash
 * (#applications/<tab>; #applications/<app id> opens that submission):
 *  - Applicants: ./applicants.js, its own module, loaded on first visit.
 *  - Submissions: each application and whether it reached JobTread. Search,
 *    filters, the address and repeat checks, CSV export, Retry, and deleting a
 *    family's data from the site (JobTread is never touched from here).
 *  - Insights: the season's funnel: who started, who finished, where people stop.
 *  - Form: the application itself. Pages and questions on the left (drag the
 *    handle, or Alt+↑/↓), the selected one on the right, a live phone preview.
 *    Every change saves to a draft; "Put live" lists what changed, then makes
 *    it what families see. Questions that feed JobTread can be reworded and
 *    moved, never removed.
 *  - Spanish: every family-facing string, its translation and whether it's
 *    missing or out of date, with an AI first draft.
 *  - Messages: the JobTread messages families get, and the reminder emails.
 *  - History: every version that went live; compare or restore one.
 *  - Settings: open or closed, the season year, the closed message and an
 *    optional outside form. These are `application` in the site settings
 *    (site_config "settings"), saved through /api/save-content like the rest
 *    of Site Config. The tab carries an Open/Closed badge seen from every tab.
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
.afe-chip .afe-chip-n { margin-left: .3rem; opacity: .75; font-weight: 500; }
.afe-list { display: grid; gap: .55rem; transition: opacity .15s; }
.afe-list.is-loading { opacity: .55; }
.afe-item { padding: .75rem .9rem; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-bg-card); }
.afe-item { scroll-margin-top: calc(80px + env(safe-area-inset-top, 0px)); }
.afe-item.is-open { box-shadow: 0 0 0 2px var(--color-primary); border-color: var(--color-primary); }
.afe-item-top { display: flex; justify-content: space-between; align-items: center; gap: .75rem; flex-wrap: wrap; }
.afe-item-who { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; min-width: 0; }
.afe-item-meta { color: var(--color-text-muted); font-size: .85rem; }
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
.afe-ph { padding: 0 .15rem; border-radius: 4px; background: var(--afe-ph); color: var(--color-info); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
.afe-ph.is-missing { background: var(--afe-warn-bg); color: var(--color-text); box-shadow: inset 0 0 0 1px var(--afe-warn-line); }
.afe-progress { display: grid; gap: .35rem; margin-top: .75rem; }
@media (max-width: 768px) { .afe-tr { grid-template-columns: 1fr; } }

/* Messages and reminders */
.afe-msg { display: grid; gap: .5rem; margin-bottom: 1.25rem; }
.afe-msg textarea { min-height: 200px; font-family: inherit; line-height: 1.5; }
.afe-msg-preview { padding: .75rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-secondary); font-size: .9rem; line-height: 1.5; white-space: pre-wrap; }
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
.afe-settings-foot { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-top: 1.1rem; }
/* Settings: status + fields on the left, what families see + history on the right */
.afe-set { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); gap: 1.25rem; align-items: start; }
@media (max-width: 1100px) { .afe-set { grid-template-columns: minmax(0, 1fr); } }
.afe-set-main, .afe-set-side { display: grid; gap: 1.25rem; min-width: 0; }
.afe-set .card { margin: 0; }
.afe-set h4 { margin: 0; font-size: .98rem; }
.afe-set-fields { display: grid; gap: .1rem; margin-top: 1.1rem; max-width: 40rem; }
.afe-set-fields select { max-width: 12rem; }
.afe-set-times { max-width: 40rem; align-items: start; }
.afe-opt { margin-left: .3rem; font-weight: 500; color: var(--color-text-muted); font-size: .78rem; }
.afe-label { font-weight: 600; font-size: .85rem; }
.afe-when { display: flex; gap: .5rem; align-items: center; }
.afe-when .form-input { min-width: 0; flex: 1; }
.afe-root [aria-invalid="true"] { border-color: var(--color-danger); }
.afe-status-row { display: flex; gap: .9rem 1rem; align-items: flex-start; flex-wrap: wrap; }
.afe-status-dot { position: absolute; left: 0; top: .55rem; width: 14px; height: 14px; border-radius: 50%; background: var(--color-border-strong); }
.afe-status.is-open { border-color: color-mix(in srgb, var(--color-success) 35%, var(--color-border)); }
.afe-status.is-open .afe-status-dot { background: var(--color-success); box-shadow: 0 0 0 5px color-mix(in srgb, var(--color-success) 18%, transparent); }
.afe-status-text { position: relative; flex: 1 1 18rem; min-width: 0; padding-left: 1.75rem; }
.afe-status-text h3 { margin: 0 0 .25rem; font-size: 1.4rem; letter-spacing: -.01em; }
.afe-status-text p { margin: 0; color: var(--color-text-secondary); font-size: .92rem; line-height: 1.5; }
.afe-status-text .afe-status-next { display: flex; gap: .4rem; align-items: center; margin-top: .5rem; color: var(--color-text); font-weight: 600; }
.afe-status-btn { flex-shrink: 0; }
.afe-where { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .9rem 1.5rem; margin: 1.15rem 0 0; padding: 1rem 0 0; border-top: 1px solid var(--color-border); }
.afe-where > div { display: grid; gap: .3rem; min-width: 0; }
.afe-where dt { font-size: .72rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--color-text-muted); }
.afe-where dd { margin: 0; display: flex; gap: .3rem; align-items: center; flex-wrap: wrap; font-size: .88rem; color: var(--color-text-secondary); }
.afe-where a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
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
  .afe-where { grid-template-columns: minmax(0, 1fr); }
  .afe-status-text h3 { font-size: 1.2rem; }
}
.afe-hist { display: grid; gap: .5rem; }
.afe-hist > div { display: flex; justify-content: space-between; align-items: center; gap: .75rem; flex-wrap: wrap; padding: .65rem .85rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-card); }

/* Phones: 44px targets, 16px inputs */
@media (max-width: 768px) {
  .afe-root .form-input, .afe-root select, .afe-root textarea, .afe-root input:not([type="checkbox"]):not([type="radio"]) { font-size: 16px; }
  .afe-icon-btn, .afe-mini button, .afe-collapse { width: 44px; height: 44px; }
  .afe-grip { width: 30px; height: 44px; }
  .afe-row { min-height: 52px; flex-wrap: wrap; }
  .afe-row .afe-mini, .afe-page-head .afe-mini { display: none; }
  .afe-row.is-sel .afe-mini, .afe-page.is-sel .afe-page-head .afe-mini { display: flex; }
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
const TABS = [['applicants', 'Applicants'], ['submissions', 'Submissions'], ['insights', 'Insights'], ['form', 'Form'], ['spanish', 'Spanish'], ['messages', 'Messages'], ['history', 'History'], ['settings', 'Settings']];
const TAB_KEYS = new Set(TABS.map(t => t[0]));
const DRAFT_TABS = new Set(['form', 'spanish', 'messages', 'history']);

/** #applications → applicants; #applications/<tab>; #applications/<app id> opens that submission */
function readHash(hash = location.hash) {
  const m = String(hash).match(/^#applications(?:\/([\w-]+))?/);
  if (!m) return null;
  const seg = m[1] || '';
  if (!seg) return { tab: 'applicants', open: null };
  if (TAB_KEYS.has(seg)) return { tab: seg, open: null };
  if (seg === 'list') return { tab: 'submissions', open: null };
  return { tab: 'submissions', open: seg };
}

export function ApplicationsArea({ addToast = () => {}, RichTextEditor = null, initialTab = null, setGlobalDirty = null }) {
  useStyles();
  const start = readHash() || { tab: 'applicants', open: null };
  const [tab, setTab] = useState(initialTab && TAB_KEYS.has(initialTab) ? initialTab : start.tab);
  const [openApp, setOpenApp] = useState(start.open);
  const [listShow, setListShow] = useState(null);
  const d = useFormDraft(addToast, DRAFT_TABS.has(tab));
  const settings = useAppSettings(addToast, setGlobalDirty, tab === 'settings');
  const [formSel, setFormSel] = useState(null);
  const go = (t, opts = {}) => {
    if (DRAFT_TABS.has(tab) && !DRAFT_TABS.has(t)) d.flush();
    setTab(t);
    setOpenApp(null);
    setListShow(opts.show || null);
    setFormSel(opts.formSel || null);
    history.replaceState(null, '', `#applications/${t}`);
  };
  useEffect(() => {
    const onHash = () => { const r = readHash(); if (r) { setTab(r.tab); setOpenApp(r.open); } };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // On a phone the tab row scrolls sideways: bring the open tab into view (Settings is last)
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
  return html`
    <div class="afe-root">
      <div class="hub-tabs afe-tabs" role="tablist" aria-label="Applications" onKeyDown=${onTabKey}>
        ${TABS.map(([k, label]) => html`
          <button class="hub-tab ${tab === k ? 'active' : ''}" role="tab" data-tab=${k} aria-selected=${tab === k} tabindex=${tab === k ? 0 : -1} onClick=${() => go(k)}>
            ${label}${k === 'spanish' && spanishLeft > 0 && html`<span class="afe-tab-count" title=${`${spanishLeft} missing or out of date`}>${spanishLeft}</span>`}${k === 'settings' && settings.saved && html`<span class="afe-tab-state ${settings.saved.open ? 'is-open' : ''}" title=${`Applications are ${settings.saved.open ? 'open' : 'closed'} for the ${settings.saved.year} season${!settings.saved.open && settings.saved.opensAt ? `; they open ${longWhen(settings.saved.opensAt)}` : ''}`}>${settings.saved.open ? 'Open' : settings.saved.opensAt ? `Opens ${shortDay(settings.saved.opensAt)}` : 'Closed'}</span>`}
          </button>`)}
      </div>
      <div role="tabpanel" aria-label=${TABS.find(t => t[0] === tab)?.[1]}>
        ${tab === 'applicants' && html`<${ApplicantsTab} addToast=${addToast} />`}
        ${tab === 'submissions' && html`<${SubmissionsTab} key=${`s:${listShow || ''}`} addToast=${addToast} openFirst=${openApp} initialShow=${listShow} />`}
        ${tab === 'insights' && html`<${InsightsTab} seasonYear=${d.meta?.year} go=${go} />`}
        ${tab === 'form' && html`<${FormEditor} d=${d} RichTextEditor=${RichTextEditor} addToast=${addToast} initialSel=${formSel} />`}
        ${tab === 'spanish' && html`<${SpanishTab} d=${d} RichTextEditor=${RichTextEditor} addToast=${addToast} />`}
        ${tab === 'messages' && html`<${MessagesEditor} d=${d} />`}
        ${tab === 'history' && html`<${HistoryTab} d=${d} />`}
        ${tab === 'settings' && html`<${SettingsTab} addToast=${addToast} s=${settings} go=${go} />`}
      </div>
    </div>`;
}

// ─── Applicants (./applicants.js) ──────────────────────────────────
let applicantsModule = null;
function ApplicantsTab({ addToast }) {
  const [mod, setMod] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => {
    setErr(null);
    applicantsModule ||= import('./applicants.js');
    applicantsModule
      .then((m) => { if (typeof m.ApplicantsArea !== 'function') throw new Error('applicants.js has no ApplicantsArea'); setMod(m); })
      .catch((e) => { applicantsModule = null; setErr(e?.message || String(e)); });
  };
  useEffect(load, []);
  if (err) {
    return html`
      <div class="card" style="text-align: center; padding: 2.25rem 1.5rem;">
        <h3 class="u-mb-1">The applicants view didn't load</h3>
        <p class="afe-lede" style="margin: 0 auto 1rem;">Check your connection and try again. Submissions, Insights and the Form still work.</p>
        <p class="afe-hint" style="margin-bottom: 1rem;">${err}</p>
        <button class="btn btn-primary" onClick=${load}>Try again</button>
      </div>`;
  }
  if (!mod) return html`<div class="afe-spin" role="status"><span class="spinner" /><span class="afe-hint" style="margin-left: .6rem; align-self: center;">Loading…</span></div>`;
  return html`<${mod.ApplicantsArea} addToast=${addToast} />`;
}

// ─── Submissions ───────────────────────────────────────────────────
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
    ${f.area?.status === 'outside' && html`<span class="badge badge-yellow" title=${f.area.text || ''}>Outside area${f.area.miles != null ? ` · ${f.area.miles} mi` : ''}</span>`}
    ${f.area?.status === 'unknown' && html`<span class="badge badge-gray" title=${f.area.text || 'The Census couldn’t find this address'}>Address not found</span>`}
    ${cm && html`<span class="badge badge-yellow" title=${`The family picked ${cm.picked}; the Census says ${cm.census}`}>County mismatch</span>`}
    ${f.repeat?.length > 0 && html`<span class="badge badge-yellow" title=${f.repeat.map(m => `${m.name}${m.year ? ` (${m.year})` : ''}`).join(', ')}>Possible repeat</span>`}`;
}

function SubmissionsTab({ addToast, openFirst, initialShow }) {
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
    requestAnimationFrame(() => document.querySelector('.afe-item.is-open')?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }));
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
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target) || document.querySelector('.afe-overlay, .modal-overlay')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = (id) => {
    const next = openId === id ? null : id;
    setOpenId(next);
    history.replaceState(null, '', next ? `#applications/${next}` : '#applications/submissions');
  };
  const post = async (body, label) => {
    setBusy(label);
    const j = await call(API, body);
    setBusy('');
    if (!j.success) addToast(j.error || 'That didn’t work', 'error');
    await load();
    return j.success ? j : null;
  };
  const retry = async (id) => {
    const j = await post({ retry: id }, id);
    if (j) addToast(j.result?.status === 'done' ? 'Everything is in JobTread.' : j.result?.status === 'waiting' ? 'In JobTread; still waiting on the video.' : `Still not finished: ${j.result?.error || j.result?.status}`, j.result?.error ? 'error' : 'success');
    if (openId === id) setDetailKey(k => k + 1);
  };
  const sendTest = async () => {
    const j = await post({ test: true }, 'test');
    if (j) addToast(j.result?.status === 'error' ? `Test made but not finished: ${j.result.error}` : 'Test application sent to JobTread as "TEST Applicant". Archive that account when you are done.', j.result?.status === 'error' ? 'error' : 'success');
  };
  const setFilter = (fn) => { fn(); setOffset(0); };

  const CHECKS = [['account', 'Account'], ['contacts', 'Contacts'], ['home', 'Home'], ['pdf', 'PDF'], ['photos', 'Photos'], ['video', 'Video'], ['familyMessage', 'Family message'], ['medicalNote', 'Medical note'], ['staffEmail', 'Staff email'], ['staffSlack', 'Staff Slack']];
  const chip = (label, v) => {
    const cls = v === true ? 'badge-green' : v === 'none' ? 'badge-gray' : v === 'waiting' ? 'badge-yellow' : v === false ? 'badge-gray' : 'badge-red';
    const mark = v === true ? '✓' : v === 'waiting' ? '…' : v === 'none' ? '–' : v === false ? '·' : '!';
    return html`<span class="badge ${cls}" title=${typeof v === 'string' && v !== 'none' && v !== 'waiting' ? v : ''}>${mark} ${label}</span>`;
  };
  const apps = data?.applications || [];
  const total = data?.total ?? apps.length;
  const years = data?.years || [];
  const csv = `${API}?export=csv${year ? `&year=${encodeURIComponent(year)}` : ''}${tests ? '&tests=1' : ''}`;

  return html`
    <div class="card">
      <div class="afe-card-head">
        <div>
          <h3>Submissions</h3>
          <p class="afe-lede">Families apply at <a href="/apply/form/" target="_blank" style="color: var(--color-primary-ink); text-decoration: underline;">/apply/form/</a>. Each one goes straight into JobTread as a customer account with the PDF, photos and video, and the family gets the "Application Status" message from the Qualification Committee. Review them in JobTread; this list shows whether each one arrived.</p>
          ${data && html`<p class="text-sm" style="margin: .5rem 0 0;">
            Applications are <strong>${data.open ? 'open' : 'closed'}</strong> for the ${data.year} season.
            <a href="#applications/settings" style="color: var(--color-text-secondary); text-decoration: underline;">Change that in Settings</a>
          </p>`}
        </div>
        <div class="afe-row-actions">
          <button class="btn btn-ghost" onClick=${load} disabled=${!!busy}>Refresh</button>
          <button class="btn btn-ghost" onClick=${sendTest} disabled=${!!busy}>${busy === 'test' ? 'Sending…' : 'Send test application'}</button>
        </div>
      </div>

      <div class="afe-toolbar">
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
        ${SHOWS.map(([k, label]) => html`<button class="afe-chip" aria-pressed=${show === k} onClick=${() => setFilter(() => setShow(k))}>${label}</button>`)}
      </div>

      ${error && html`<p class="text-sm afe-danger" style="margin-top: .75rem;">Couldn't load applications: ${error}</p>`}
      ${!data && !error && html`<${Spinner} />`}
      ${data && html`
        <p class="afe-hint" style="margin: .85rem 0 .6rem;">
          ${plural(data.draftsInProgress, 'application')} in progress (not submitted yet)
          · Messages post as ${data.qcGrant ? 'Qualification Committee' : html`<strong>the site's connection</strong> (add the Qualification Committee's JobTread key as JOBTREAD_QC_GRANT_KEY in Cloudflare to post as them)`}
          ${data.stream === false && html` · <strong>Video uploads are not set up</strong> (CF_STREAM_TOKEN)`}
        </p>
        ${openId && detail && !detail.error && !apps.some(x => x.id === openId) && html`
          <div class="afe-item is-open" style="margin-bottom: .55rem;">
            <div class="afe-item-top">
              <div class="afe-item-who"><strong>${detail.child || 'Applicant'}</strong><${FlagBadges} a=${detail} picked=${pickedCounty(detail)} /><span class="afe-item-meta">${[detail.year && `${detail.year} season`, when(detail.submittedAt)].filter(Boolean).join(' · ')}</span></div>
              <div class="afe-row-actions">
                ${detail.jobtreadUrl && html`<a class="btn btn-ghost" href=${detail.jobtreadUrl} target="_blank" rel="noopener">Open in JobTread</a>`}
                <button class="btn btn-ghost" onClick=${() => toggle(openId)}>Hide</button>
              </div>
            </div>
            <${SubmissionDetail} a=${detail} detail=${detail} onDelete=${() => setDeleting(detail)} />
          </div>`}
        ${apps.length === 0 ? html`<p class="afe-empty">${qd ? `No applications match "${qd}".` : EMPTY_FOR[show] || EMPTY_FOR.all}</p>` : html`
          <div class="afe-list ${loading ? 'is-loading' : ''}" aria-busy=${loading}>
            ${apps.map(a => html`
              <div class="afe-item ${openId === a.id ? 'is-open' : ''}" key=${a.id}>
                <div class="afe-item-top">
                  <div class="afe-item-who">
                    <strong>${a.child || 'Applicant'}</strong>
                    <${FlagBadges} a=${a} picked=${openId === a.id ? pickedCounty(detail) : null} />
                    <span class="afe-item-meta">${[(a.makeoverTypes || []).join(', '), when(a.submittedAt)].filter(Boolean).join(' · ')}</span>
                  </div>
                  <div class="afe-row-actions">
                    ${a.jobtreadUrl && html`<a class="btn btn-ghost" href=${a.jobtreadUrl} target="_blank" rel="noopener">Open in JobTread</a>`}
                    ${a.status !== 'done' && !a.deletedAt && html`<button class="btn btn-ghost" onClick=${() => retry(a.id)} disabled=${!!busy}>${busy === a.id ? 'Retrying…' : 'Retry now'}</button>`}
                    <button class="btn btn-ghost" aria-expanded=${openId === a.id} onClick=${() => toggle(a.id)}>${openId === a.id ? 'Hide' : 'Details'}</button>
                  </div>
                </div>
                ${!a.deletedAt && html`<div class="afe-checks">${CHECKS.map(([k, label]) => chip(label, a.checklist?.[k]))}</div>`}
                ${a.status === 'error' && !a.deletedAt && html`<p class="text-sm afe-danger" style="margin: .5rem 0 0;">Not finished after ${a.attempts} ${a.attempts === 1 ? 'try' : 'tries'}: ${a.lastError}. It retries on its own.</p>`}
                ${a.status === 'waiting' && html`<p class="text-sm text-muted" style="margin: .5rem 0 0;">Waiting on Cloudflare to finish processing the video; it's attached automatically.</p>`}
                ${openId === a.id && html`<${SubmissionDetail} a=${a} detail=${detail} onDelete=${() => setDeleting(detail && !detail.error ? detail : a)} />`}
              </div>`)}
          </div>
          <div class="afe-pager">
            <span>${total > PAGE_SIZE ? `Showing ${num(offset + 1)}–${num(Math.min(offset + PAGE_SIZE, total))} of ${num(total)}` : plural(total, 'application')}</span>
            ${total > PAGE_SIZE && html`<span class="afe-row-actions">
              <button class="btn btn-ghost btn-sm" disabled=${offset === 0 || loading} onClick=${() => setOffset(o => Math.max(0, o - PAGE_SIZE))}>Previous</button>
              <button class="btn btn-ghost btn-sm" disabled=${offset + PAGE_SIZE >= total || loading} onClick=${() => setOffset(o => o + PAGE_SIZE)}>Next</button>
            </span>`}
          </div>`}
        ${(data.events || []).length > 0 && html`
          <details style="margin-top: 1rem;">
            <summary class="text-sm" style="cursor: pointer; font-weight: 600;">Status messages from JobTread (last ${data.events.length})</summary>
            <p class="text-sm text-muted" style="margin: .4rem 0;">When someone changes an applicant's Status in JobTread, the site posts the matching message (In Review, Approved, Denied) to the family once. The wording is in the Messages tab.</p>
            <div style="display: grid; gap: .25rem;">
              ${data.events.map(e => html`
                <div class="text-sm" style="display: flex; gap: .6rem; flex-wrap: wrap;">
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
        addToast('Deleted from the site. JobTread is unchanged.', 'success');
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
        <span class="text-muted"> · form version ${detail.formVersion || 'built in'}${detail.lang === 'es' ? ' · answered in Spanish' : ''}</span>
      </p>
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
      <div class="afe-card-head">
        <div>
          <h3 style="margin: 0;">Insights</h3>
          <p class="afe-lede">How families move through the application this season. Tests are left out.</p>
        </div>
        <label class="afe-row-actions text-sm" style="font-weight: 600;">Season
          <select class="form-input" style="width: auto;" value=${year || ''} onChange=${(e) => setYear(e.target.value)} aria-label="Season">
            ${years.map(y => html`<option value=${y}>${y}</option>`)}
          </select>
        </label>
      </div>
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

          <div class="afe-grid2">
            <div class="afe-viz">
              <h4>Where people stop</h4>
              <span class="afe-hint">The last page each family reached before leaving without finishing.</span>
              <${StopBars} byPage=${ins.byPage || []} started=${ins.started} />
            </div>
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
              <h4>How families heard about us</h4>
              <span class="afe-hint">From "Who referred you", on submitted applications.</span>
              <${RankBars} rows=${ins.referral || []} />
            </div>
            <div class="afe-viz">
              <h4>Reminder emails</h4>
              <span class="afe-hint">Sent to families who started and went quiet. The wording is in Messages.</span>
              <div class="afe-stat-pair">
                <div><b>${num(ins.reminders?.sent)}</b><span>${ins.reminders?.sent === 1 ? 'reminder sent' : 'reminders sent'}</span></div>
                <div><b>${num(ins.reminders?.finishedAfter)}</b><span>finished after a reminder</span></div>
              </div>
            </div>
            <div class="afe-viz">
              <h4>Checks</h4>
              <span class="afe-hint">Run on each submitted application, before anyone reviews it.</span>
              <div class="afe-checklist">
                <div><span>Outside the service area <b>${num(ins.checks?.outside)}</b></span>${ins.checks?.outside > 0 && html`<button class="btn btn-ghost btn-sm" onClick=${() => go('submissions', { show: 'outside' })}>See them</button>`}</div>
                <div><span>Possible repeat applicants <b>${num(ins.checks?.repeat)}</b></span>${ins.checks?.repeat > 0 && html`<button class="btn btn-ghost btn-sm" onClick=${() => go('submissions', { show: 'repeat' })}>See them</button>`}</div>
                <div><span>Address the Census couldn't find <b>${num(ins.checks?.unchecked)}</b></span></div>
              </div>
            </div>
          </div>
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

function DraftBar({ d, onPreview, previewOn }) {
  const { meta, status, savedAt, problems, hasDraft } = d;
  const [diff, setDiff] = useState(null); // { loading } | { changes } | { error }
  if (!meta) return null;
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
    <div class="afe-bar" data-status=${status}>
      <div class="afe-bar-text">
        ${hasDraft
          ? html`<strong><span class="afe-dot is-draft"></span>You have changes that aren't live yet</strong>
              <span class="text-sm text-muted">${sub} · families still see ${liveText}</span>`
          : html`<strong><span class="afe-dot"></span>Families see ${liveText}</strong>
              <span class="text-sm text-muted">${meta.live.liveAt ? `Put live ${when(meta.live.liveAt)}${meta.live.liveBy ? ` by ${personName(meta.live.liveBy)}` : ''}` : 'Matches the Jotform application for 2027'}. Changes save as a draft until you put them live.</span>`}
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

function FormEditor({ d, RichTextEditor, addToast, initialSel = null }) {
  const { work, meta } = d;
  const [sel, setSel] = useState(initialSel || { kind: 'page', id: null, at: 0 });
  const [preview, setPreview] = useState(() => store.get('afe-preview') === '1');
  const [folded, setFolded] = useState(() => new Set());
  const inspector = useRef(null);
  if (!work || !meta) return html`<${Spinner} />`;
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
    if (where.startsWith('messages/') || where === 'reminders') { addToast('That one is in the Messages tab.', 'info'); return; }
    if (where === 'staffEmails' || where === 'serviceArea') { select({ kind: 'settings' }, { scroll: true }); return; }
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
    if (refocus) focusSoon(`.afe-row[data-id="${id}"]`);
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
  const rowKey = (e, f) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectField(f.id, { scroll: true }); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    if (e.altKey) { moveField(f.id, dir, true); return; }
    const rows = [...document.querySelectorAll('.afe-col .afe-row[data-id]')];
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
      <${DraftBar} d=${d} onPreview=${phone ? null : togglePreview} previewOn=${showPreview} />
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
                          <div key=${f.id} class="afe-row ${isSel ? 'is-sel' : ''} ${problemFor(`${p.id}/${f.id}`) ? 'has-problem' : ''}" data-id=${f.id} role="button" tabindex="0" aria-current=${isSel ? 'true' : undefined}
                            onClick=${() => selectField(f.id, { scroll: true })} onKeyDown=${(e) => rowKey(e, f)}>
                            <span class="afe-grip afe-row-grip" title="Drag to move (or Alt+↑/↓)" onClick=${(e) => e.stopPropagation()}><${Icon} name="grip" size=${14} /></span>
                            <span class="afe-type" title=${types[f.type] || f.type}>${ROW_TYPE[f.type] || types[f.type] || f.type}</span>
                            <span class="afe-row-label">${label || html`<em class="text-muted">No wording yet</em>`}</span>
                            <span class="afe-row-badges">
                              ${locked[f.id] && html`<span class="badge badge-blue" title=${locked[f.id].role}>JobTread</span>`}
                              ${f.jobtread && html`<span class="badge badge-blue" title=${`Fills JobTread's "${f.jobtread.name}"`}>→ JobTread</span>`}
                              ${f.required && html`<span class="badge badge-gray">Required</span>`}
                              ${f.showIf && html`<span class="badge badge-yellow" title="Shown only for some answers">If…</span>`}
                              ${f.stops && Object.keys(f.stops).length > 0 && html`<span class="badge badge-gray" title="An answer ends the application">Ends</span>`}
                            </span>
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

          <section class="afe-panel">
            <button class="afe-row ${sel.kind === 'settings' ? 'is-sel' : ''}" style="padding-left: .55rem;" onClick=${() => select({ kind: 'settings' }, { scroll: true })}>
              <span class="afe-type">Settings</span><span class="afe-row-label">New-application email and the service area</span>
            </button>
          </section>
        </div>

        <div class="afe-col">
          <div class="afe-panel afe-inspector" ref=${inspector}>
            <button class="afe-link afe-back" onClick=${() => document.querySelector('.afe-col .afe-row.is-sel, .afe-page.is-sel')?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })}><${Icon} name="up" size=${14} /> Back to the list</button>
            ${sel.kind === 'field' && found && html`<${FieldInspector} key=${found.f.id} d=${d} pi=${found.pi} fi=${found.fi} f=${found.f} locked=${locked[found.f.id]} types=${types} RichTextEditor=${RichTextEditor} onSelect=${select} onDuplicate=${() => dupField(found.f.id)} addToast=${addToast} />`}
            ${sel.kind === 'page' && work.pages[pageAt] && html`<${PageInspector} key=${`p${work.pages[pageAt].id}`} d=${d} pi=${pageAt} locked=${locked} onSelect=${select} onDuplicate=${() => dupPage(pageAt)} />`}
            ${sel.kind === 'stop' && work.stops?.[sel.key] && html`<${StopInspector} key=${`s${sel.key}`} d=${d} k=${sel.key} RichTextEditor=${RichTextEditor} onSelect=${select} />`}
            ${sel.kind === 'settings' && html`<${SettingsInspector} d=${d} />`}
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

function SettingsInspector({ d }) {
  const emails = (d.work.staffEmails || []).join('\n');
  return html`
    <div class="afe-insp-head"><div><span class="afe-crumb">Form</span><h3>Settings</h3></div></div>
    <${Field} label="Who gets the new-application email" id="afe-staff" hint="One address per line. Each new application sends them the child's first name, makeover type and a link to the JobTread account.">
      <textarea id="afe-staff" class="form-input" rows="4" value=${emails} onInput=${(e) => d.update((w) => { w.staffEmails = e.target.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean); })}></textarea>
    <//>
    <${Section} title="Service area"><${ServiceArea} d=${d} /><//>
    <p class="afe-hint" style="margin-top: 1rem;">Open or close applications, and the season year, are in <a href="#applications/settings" style="text-decoration: underline;">Settings</a>.</p>`;
}

/** The boundary each home address is checked against, as corners, plus a way to try an address */
function ServiceArea({ d }) {
  const poly = d.work.serviceArea?.polygon?.length ? d.work.serviceArea.polygon : d.meta?.defaults?.serviceArea?.polygon || [];
  const [text, setText] = useState(() => poly.map(p => p.join(', ')).join('\n'));
  const [bad, setBad] = useState('');
  const [addr, setAddr] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const parse = (t) => t.split('\n').map(s => s.trim()).filter(Boolean).map(s => s.split(/[,\s]+/).map(Number));
  const onText = (t) => {
    setText(t);
    const pts = parse(t);
    if (pts.some(p => p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180)) { setBad('Each line needs a latitude and a longitude, like 34.33, -84.48.'); return; }
    if (pts.length < 3) { setBad('The area needs at least three corners.'); return; }
    setBad('');
    d.update((w) => { w.serviceArea = { polygon: pts }; });
  };
  const test = async () => {
    if (!addr.trim()) return;
    setBusy(true);
    const j = await call(API, { areaTest: addr.trim(), polygon: parse(text) });
    setBusy(false);
    setRes(j.success ? j : { error: j.error || 'Could not check it' });
  };
  return html`
    <p class="afe-hint" style="margin: 0 0 .6rem;">Every home address is checked against this boundary when an application comes in. Staff see the result; families never do. To reshape it by dragging, use the map in <a href="#applications/applicants" style="text-decoration: underline;">Applicants</a>.</p>
    <${Field} label=${`Corners (${parse(text).length})`} id="afe-area" hint="One corner per line: latitude, longitude. They join in order and back to the first.">
      <textarea id="afe-area" class="form-input" rows="6" style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem;" value=${text} onInput=${(e) => onText(e.target.value)}></textarea>
    <//>
    ${bad && html`<p class="afe-bad" style="margin-top: -.5rem;">${bad}</p>`}
    <div class="afe-field">
      <label for="afe-area-test">Try an address</label>
      <div class="afe-row-actions" style="flex-wrap: nowrap;">
        <input id="afe-area-test" class="form-input" placeholder="1 Main St, Marietta, GA 30060" value=${addr} onInput=${(e) => setAddr(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') test(); }} />
        <button class="btn btn-ghost" disabled=${busy || !addr.trim()} onClick=${test}>${busy ? 'Checking…' : 'Check'}</button>
      </div>
      ${res && html`<p class=${res.error ? 'afe-bad' : 'afe-sum'}>${res.error || `${res.text}${res.area?.county ? ` (${res.area.county} County)` : ''}`}</p>`}
    </div>`;
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

function SpanishTab({ d, RichTextEditor, addToast }) {
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
  if (!work || !d.meta) return html`<${Spinner} />`;
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
      <${DraftBar} d=${d} />
      <div class="card">
        <div class="afe-card-head">
          <div>
            <h3>Spanish</h3>
            <p class="afe-lede">Families can switch the application to Spanish. Every question, choice, screen and message is here with its translation. When the English changes, its Spanish shows as out of date until someone checks it. Missing Spanish shows the English.</p>
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

// ─── Messages ──────────────────────────────────────────────────────
const MESSAGE_INFO = [
  ['welcome', 'Application Status', 'Sent right away when an application comes in on the website. When staff add an applicant by hand with Status "Applied", it goes once the status has settled (see the timing below).'],
  ['copyNote', 'The "copy attached" line', 'Goes where {copyNote} is in the message above, only when the family applied on the website (their PDF is attached).'],
  ['inReview', 'Application In Review', 'Sent once Status has been In Review for the wait below.'],
  ['approved', 'Application Decision: approved', 'Sent once Status has been Approved for the wait below.'],
  ['denied', 'Application Decision: denied', 'Sent once Status has been Denied for the wait below.'],
  ['correction', 'Correction', 'Never sent on its own. Staff send it from a family\'s page when a status email went out by mistake, and can edit it first. {status} becomes a line about where the application really stands.'],
];
const SAMPLE_STATUS_LINE = 'Your application is moving forward to the on-site visit, and we will contact you to schedule it.';

/** Put a placeholder where the cursor is (or at the end), then put the cursor after it */
function insertAt(el, value, token, set) {
  const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
  const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : at;
  set(value.slice(0, at) + token + value.slice(end));
  if (el) requestAnimationFrame(() => { el.focus(); el.setSelectionRange?.(at + token.length, at + token.length); });
}

function MessagesEditor({ d }) {
  const { work } = d;
  const refs = useRef({});
  if (!work) return html`<${Spinner} />`;
  const msgs = work.messages || {};
  const setMsg = (k, v) => d.update((w) => { w.messages = { ...(w.messages || {}), [k]: v }; });
  const render1 = (k) => String(msgs[k] || '')
    .replace(/\{parent\}/g, SAMPLE.parent).replace(/\{child\}/g, SAMPLE.child)
    .replace(/\{copyNote\}/g, msgs.copyNote ? `\n\n${msgs.copyNote}` : '')
    .replace(/\{status\}/g, SAMPLE_STATUS_LINE);
  return html`
    <div>
      <${DraftBar} d=${d} />
      <${Problems} problems=${d.problems.filter(p => p.where.startsWith('messages/') || p.where === 'reminders')} />
      <div class="card">
        <h3 class="u-mb-1">Messages to families</h3>
        <p class="afe-lede" style="margin-bottom: 1.25rem;">These post on the family's JobTread account as the Qualification Committee, and JobTread emails them to the main parent. Their replies land on the account. Each one goes to a family once. *Stars* make bold text in JobTread.</p>
        ${MESSAGE_INFO.map(([k, title, note]) => html`
          <section class="afe-msg">
            <label for=${`afe-m-${k}`} style="font-weight: 700;">${title}</label>
            <span class="afe-hint">${note}</span>
            ${k !== 'copyNote' && html`<div class="afe-chips">
              <span class="afe-hint">Insert:</span>
              <button onClick=${() => insertAt(refs.current[k], msgs[k] || '', '{parent}', (v) => setMsg(k, v))} title="The main parent's name">{parent}</button>
              <button onClick=${() => insertAt(refs.current[k], msgs[k] || '', '{child}', (v) => setMsg(k, v))} title="The child's name">{child}</button>
              ${k === 'welcome' && html`<button onClick=${() => insertAt(refs.current[k], msgs[k] || '', '{copyNote}', (v) => setMsg(k, v))} title="Where the copy-attached line goes">{copyNote}</button>`}
              ${k === 'correction' && html`<button onClick=${() => insertAt(refs.current[k], msgs[k] || '', '{status}', (v) => setMsg(k, v))} title="A line about where the application stands now">{status}</button>`}
            </div>`}
            ${k === 'copyNote'
              ? html`<input id=${`afe-m-${k}`} class="form-input" value=${msgs[k] || ''} onInput=${(e) => setMsg(k, e.target.value)} />`
              : html`<textarea id=${`afe-m-${k}`} ref=${(el) => { refs.current[k] = el; }} class="form-input" value=${msgs[k] || ''} onInput=${(e) => setMsg(k, e.target.value)}></textarea>
                <details><summary class="afe-hint" style="cursor: pointer;">How it reads for ${SAMPLE.parent}</summary><div class="afe-msg-preview">${render1(k)}</div></details>`}
          </section>`)}
      </div>
      <${TimingEditor} d=${d} />
      <${RemindersEditor} d=${d} />
    </div>`;
}

/** When status emails go out: waits, quiet hours, and the summary to staff (./_applicant-notify.js) */
function TimingEditor({ d }) {
  const n = d.work.notify || {};
  const waits = { ...DEFAULT_NOTIFY.waits, ...(n.waits || {}) };
  const quiet = { ...DEFAULT_NOTIFY.quiet, ...(n.quiet || {}) };
  const summary = n.summary !== false;
  const set = (patch) => d.update((w) => {
    const cur = w.notify || {};
    w.notify = { waits: { ...DEFAULT_NOTIFY.waits, ...(cur.waits || {}), ...(patch.waits || {}) }, quiet: { ...DEFAULT_NOTIFY.quiet, ...(cur.quiet || {}), ...(patch.quiet || {}) }, summary: 'summary' in patch ? patch.summary : cur.summary !== false };
  });
  const quietOn = quiet.start !== quiet.end;
  const hourLabel = (h) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const mins = (key, label, hint) => html`
    <div class="afe-field">
      <label class="afe-label" for=${`afe-wait-${key}`}>${label}</label>
      <div style="display: flex; gap: .5rem; align-items: center;">
        <input id=${`afe-wait-${key}`} class="form-input" type="number" min="0" max="1440" inputmode="numeric" style="width: 6rem;" value=${waits[key]} onInput=${(e) => set({ waits: { [key]: Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0))) } })} />
        <span class="afe-hint">minutes</span>
      </div>
      <span class="afe-hint">${hint}</span>
    </div>`;
  return html`
    <div class="card" style="margin-top: 1rem;" id="afe-timing">
      <div class="afe-card-head">
        <div>
          <h3>When status emails go out</h3>
          <p class="afe-lede">A family is emailed once their status has stayed put for the wait below, so a change made by mistake and put back never reaches them. If someone flips a status back and forth, the family gets one email for where it lands, or none. Cleared or unknown statuses never email anyone.</p>
        </div>
      </div>
      <div class="afe-grid2" style="margin-top: 1rem;">
        <div>
          ${mins('inReview', 'In Review', 'Most mistakes are fixed within a few minutes.')}
          ${mins('decision', 'Approved and Denied', 'Decisions wait longer: a wrong one is the email that hurts.')}
          ${mins('welcome', 'Welcome for hand-made applicants', 'Families who apply on the website get theirs right away.')}
        </div>
        <div>
          <div class="afe-field">
            <span class="afe-label">Quiet hours (Eastern)</span>
            <label class="afe-switch" style="margin-bottom: .5rem;"><input type="checkbox" role="switch" aria-label="Quiet hours" checked=${quietOn} onChange=${(e) => set({ quiet: e.target.checked ? { start: 20, end: 8 } : { start: 0, end: 0 } })} />${quietOn ? 'On' : 'Off'}</label>
            ${quietOn && html`<div style="display: flex; gap: .5rem; align-items: center; flex-wrap: wrap;">
              <span class="afe-hint">No family emails from</span>
              <select class="form-select" style="width: auto;" aria-label="Quiet hours start" value=${quiet.start} onChange=${(e) => set({ quiet: { start: Number(e.target.value) } })}>${hours.map(h => html`<option value=${h}>${hourLabel(h)}</option>`)}</select>
              <span class="afe-hint">to</span>
              <select class="form-select" style="width: auto;" aria-label="Quiet hours end" value=${quiet.end} onChange=${(e) => set({ quiet: { end: Number(e.target.value) } })}>${hours.map(h => html`<option value=${h}>${hourLabel(h)}</option>`)}</select>
            </div>`}
            <span class="afe-hint">${quietOn ? `An email due in quiet hours waits until ${hourLabel(quiet.end)}.` : 'Emails go whenever their wait is over, day or night.'}</span>
          </div>
          <div class="afe-field">
            <span class="afe-label">Summary for staff</span>
            <label class="afe-switch"><input type="checkbox" role="switch" aria-label="Summary email for staff" checked=${summary} onChange=${(e) => set({ summary: e.target.checked })} />${summary ? 'On' : 'Off'}</label>
            <span class="afe-hint">After someone changes statuses in JobTread, they get one email listing each family with Move back, Don't email and Send now. Families' emails wait 5 minutes after the summary so there's time to act.</span>
          </div>
        </div>
      </div>
    </div>`;
}

/** The reminder emails to families who started and stopped */
function RemindersEditor({ d }) {
  const rem = { ...DEFAULT_REMINDERS, ...(d.work.reminders || {}) };
  const subj = useRef(null);
  const body = useRef(null);
  const lastBox = useRef('body');
  const [day, setDay] = useState('');
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
    const k = lastBox.current;
    const el = k === 'subject' ? subj.current : body.current;
    insertAt(el, rem[k] || '', token, (v) => set({ [k]: v }));
  };
  const probs = d.problems.filter(p => p.where === 'reminders');
  return html`
    <div class="card" style="margin-top: 1rem;" id="afe-reminders">
      <div class="afe-card-head">
        <div>
          <h3>Reminder emails</h3>
          <p class="afe-lede">For families who start an application and stop. Each one goes the set number of days after the family's last change, with a button back to their saved answers. Families who finish, or tap "Stop these reminders", get no more.</p>
        </div>
        <label class="afe-switch"><input type="checkbox" role="switch" aria-label="Send reminder emails" checked=${rem.enabled !== false} onChange=${(e) => set({ enabled: e.target.checked })} />${rem.enabled !== false ? 'On' : 'Off'}</label>
      </div>
      ${probs.length > 0 && html`<p class="afe-bad" style="margin-top: .75rem;">${probs.map(p => p.message).join(' ')}</p>`}
      <div class="afe-grid2" style="margin-top: 1rem; opacity: ${rem.enabled !== false ? 1 : 0.6};">
        <div>
          <div class="afe-field">
            <span class="afe-label" id="afe-days-label">Send after this many days of no changes</span>
            <div class="afe-days" role="group" aria-labelledby="afe-days-label">
              ${days.map(n => html`<span class="afe-day">${plural(n, 'day')}<button class="afe-icon-btn" aria-label=${`Remove ${n} days`} onClick=${() => set({ days: days.filter(x => x !== n) })}><${Icon} name="close" size=${12} /></button></span>`)}
              ${days.length < 6 && html`
                <input class="form-input" type="number" min="1" max="60" inputmode="numeric" style="width: 5.5rem;" placeholder="Days" aria-label="Add a reminder after this many days" value=${day} onInput=${(e) => setDay(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); addDay(); } }} />
                <button class="btn btn-ghost btn-sm" onClick=${addDay} disabled=${!day}>Add</button>`}
            </div>
            <span class="afe-hint">Up to 6 reminders, 1 to 60 days. They're kept in order.</span>
          </div>
          <div class="afe-chips" style="margin-bottom: .5rem;">
            <span class="afe-hint">Insert:</span>
            ${[['{parent}', "The parent's first name"], ['{child}', "The child's first name"], ['{percent}', 'How far along they are'], ['{year}', 'The season year']].map(([t, tip]) => html`<button title=${tip} onClick=${() => insert(t)}>${t}</button>`)}
          </div>
          <${Field} label="Subject" id="afe-rem-subject">
            <input id="afe-rem-subject" ref=${subj} class="form-input" value=${rem.subject || ''} onFocus=${() => { lastBox.current = 'subject'; }} onInput=${(e) => set({ subject: e.target.value })} />
          <//>
          <${Field} label="Message" id="afe-rem-body">
            <textarea id="afe-rem-body" ref=${body} class="form-input" rows="9" style="line-height: 1.5;" value=${rem.body || ''} onFocus=${() => { lastBox.current = 'body'; }} onInput=${(e) => set({ body: e.target.value })}></textarea>
          <//>
        </div>
        <div>
          <span class="afe-sec-title">How it reads for ${SAMPLE.parent}</span>
          <div class="afe-email" aria-label="Sample reminder email">
            <div class="afe-email-head"><span class="afe-hint">From Sunshine on a Ranney Day</span><b>${fillVars(rem.subject) || 'No subject'}</b></div>
            <div class="afe-email-body">${fillVars(rem.body) || html`<span class="text-muted">No message yet.</span>`}
              <div style="white-space: normal; margin-top: .9rem;">
                <span class="afe-hint">${vars.percent}% done</span>
                <div class="afe-email-bar"><span></span></div>
                <span class="afe-email-btn">Finish my application</span>
                <p class="afe-hint" style="margin: .75rem 0 0;">Sunshine on a Ranney Day · Stop these reminders</p>
              </div>
            </div>
          </div>
          <p class="afe-hint" style="margin-top: .5rem;">${rem.enabled === false ? 'Reminders are off. No one gets these.' : days.length ? `Sent ${days.map(n => plural(n, 'day')).join(', then ')} after a family's last change.` : 'Add at least one day.'} Spanish families get the Spanish version from the Spanish tab.</p>
        </div>
      </div>
    </div>`;
}

// ─── History ───────────────────────────────────────────────────────
function HistoryTab({ d }) {
  const { meta } = d;
  const [cmp, setCmp] = useState(null); // { title, loading, changes, error }
  if (!meta) return html`<${Spinner} />`;
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
    <div class="card">
      <h3 class="u-mb-1">History</h3>
      <p class="afe-lede" style="margin-bottom: 1rem;">Every version that went live. Compare one with the version before it, or restore it into your draft to look it over before putting it live. Applications always keep the version they were answered on.</p>
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
      ${cmp && html`
        <${Dialog} wide title=${cmp.title} onClose=${() => setCmp(null)} footer=${html`<button class="btn btn-primary" onClick=${() => setCmp(null)}>Done</button>`}>
          ${cmp.loading && html`<p class="afe-hint">Comparing…</p>`}
          ${cmp.error && html`<p class="afe-bad">${cmp.error}</p>`}
          ${cmp.changes && html`<${ChangesList} changes=${cmp.changes} empty="No differences." />`}
        <//>`}
    </div>`;
}

// ─── Settings ──────────────────────────────────────────────────────
// Open or closed, the season, the closed message, an outside form, and the
// times it opens and closes by itself: `application` in the site settings,
// saved through this area's API (saveApplicationSettings in
// functions/api/_applications.js, which writes only that block and logs each
// field). The form and the Apply page both follow at once (functions/apply/).
const SETTINGS_FIELDS = ['year', 'closedMessage', 'formUrl', 'opensAt', 'closesAt'];
const HTTPS_LINK = /^https:\/\/[^\s/]+\.[^\s]+$/i;
const seasonChoices = () => { const now = new Date().getUTCFullYear(); return [now - 1, now, now + 1, now + 2].map(String); };
const sameFields = (a, b) => !!a && !!b && SETTINGS_FIELDS.every(k => (a[k] || '') === (b[k] || ''));
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
const whoName = (by) => (by === 'schedule' ? 'the schedule' : personName(by));
const defaultClosed = (year) => `The ${year} application period is currently closed.`;

/** What's wrong, by field (the server checks the same and has the last word) */
function settingsProblems(e, saved, now = Date.now()) {
  const out = {};
  if (e.formUrl && !HTTPS_LINK.test(e.formUrl.trim())) out.formUrl = 'Use a full link that starts with https://';
  for (const k of ['opensAt', 'closesAt']) if (e[k] && e[k] !== saved?.[k] && Date.parse(e[k]) <= now) out[k] = 'Pick a time that hasn’t passed';
  if (e.opensAt && e.closesAt && Date.parse(e.closesAt) <= Date.parse(e.opensAt)) out.closesAt = 'Close after it opens';
  return out;
}

/** One history entry → the lines it shows (a time cleared by opening says nothing) */
function historyLines(h) {
  const fields = new Set(h.changes.map(c => String(c.field).replace(/^application\./, '')));
  return h.changes.map((c) => {
    const f = String(c.field).replace(/^application\./, '');
    if (f === 'open') return c.to === true ? (h.by === 'schedule' ? 'Opened on schedule' : 'Opened applications') : (h.by === 'schedule' ? 'Closed on schedule' : 'Closed applications');
    if (f === 'year') return `Season ${c.from || '?'} → ${c.to}`;
    if (f === 'closedMessage') return c.to ? 'Changed the closed message' : 'Went back to the standard closed message';
    if (f === 'formUrl') return c.to ? 'Sent the Apply button to an outside form' : 'Went back to the site’s own form';
    if (f === 'opensAt') return c.to ? `Set to open ${longWhen(c.to)}` : fields.has('open') ? null : 'Took off the scheduled opening';
    if (f === 'closesAt') return c.to ? `Set to close ${longWhen(c.to)}` : fields.has('open') ? null : 'Took off the scheduled close';
    return null;
  }).filter(Boolean);
}

/**
 * The block as saved, what's on screen, and the two ways to save: Open/Close
 * (just `open`, after a confirm) and Save (the other fields). Each sends what
 * it loaded as `base`; if someone changed these since, it shows theirs as
 * saved, keeps these edits, and a second Save uses them.
 */
function useAppSettings(addToast, setGlobalDirty, active) {
  const [saved, setSaved] = useState(null);
  const [edit, setEdit] = useState(null);
  const [since, setSince] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const take = (j) => { if (j.since !== undefined) setSince(j.since); if (j.history) setHistory(j.history); };
  const load = async () => {
    setError(null);
    const j = await call(`${API}?settings=1`);
    if (!j.success) { setError(j.error || 'Could not load the settings.'); return; }
    setSaved(j.settings);
    setEdit(j.settings);
    take(j);
    setConflict(false);
    setServerErrors({});
  };
  useEffect(() => { load(); }, []);


  const dirty = !!saved && !!edit && !sameFields(saved, edit);
  const problems = edit ? { ...settingsProblems(edit, saved), ...serverErrors } : {};
  const invalid = Object.keys(problems).length > 0;
  useEffect(() => {
    setGlobalDirty?.(dirty, 'Applications settings');
    return () => setGlobalDirty?.(false);
  }, [dirty]);
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
    setSaved(j.settings);
    take(j);
    setConflict(false);
    setServerErrors({});
    return j;
  };
  const save = async () => {
    if (!dirty || busy) return false;
    if (invalid) { addToast(Object.values(problems)[0], 'error'); return false; }
    const j = await post(Object.fromEntries(SETTINGS_FIELDS.map(k => [k, edit[k] || ''])), 'save');
    if (j) addToast('Settings saved.', 'success');
    return !!j;
  };
  const setOpen = async (open) => {
    const j = await post({ open }, open ? 'open' : 'close');
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
    saved, edit, since, history, error, busy, dirty, problems, invalid, conflict, save, setOpen, reload: load,
    set: (patch) => { setEdit(e => ({ ...e, ...patch })); setServerErrors(x => { const y = { ...x }; Object.keys(patch).forEach(k => delete y[k]); return y; }); },
    discard: () => { setEdit(saved); setConflict(false); setServerErrors({}); },
  };
}

function SettingsTab({ s, go, addToast = () => {} }) {
  const [ask, setAsk] = useState(null);
  if (s.error && !s.edit) return html`
    <div class="card">
      <p class="afe-bad" style="margin: 0 0 .75rem;">Couldn't load the settings: ${s.error}</p>
      <button class="btn btn-ghost" onClick=${s.reload}>Try again</button>
    </div>`;
  if (!s.edit) return html`<${Spinner} />`;
  const e = s.edit;
  const p = s.problems;
  const zone = zoneName();
  const timeField = (k, label, hint) => html`
    <div class="afe-field">
      <label for=${`afe-${k}`}>${label}</label>
      <div class="afe-when">
        <input id=${`afe-${k}`} class="form-input" type="datetime-local" value=${toLocalInput(e[k])} aria-invalid=${p[k] ? 'true' : 'false'}
          onInput=${(ev) => s.set({ [k]: fromLocalInput(ev.target.value) })} />
        ${e[k] && html`<button class="btn btn-ghost" onClick=${() => s.set({ [k]: '' })}>Clear</button>`}
      </div>
      ${p[k] ? html`<span class="afe-bad">${p[k]}</span>` : html`<span class="afe-hint">${hint}</span>`}
    </div>`;
  return html`
    <div class="afe-set">
      <div class="afe-set-main">
        <${StatusCard} s=${s} onAsk=${setAsk} />

        <div class="card afe-settings">
          <div class="afe-card-head"><div>
            <h3>Season and wording</h3>
            <p class="afe-lede">What families read, and where the Apply button goes.</p>
          </div></div>
          <div class="afe-set-fields">
            <${Field} label="Season" id="afe-season" hint="The year families apply for. It fills in {year} across the form and the messages.">
              <select id="afe-season" class="form-input" value=${e.year} onChange=${(ev) => s.set({ year: ev.target.value })}>
                ${seasonChoices().map(y => html`<option value=${y}>${y}</option>`)}
              </select>
            <//>
            <${Field} label="Message while closed" id="afe-closed" hint=${`On the Apply page and the form. Blank shows "${defaultClosed(e.year)}"`}>
              <input id="afe-closed" class="form-input" maxlength="200" value=${e.closedMessage} placeholder=${defaultClosed(e.year)} onInput=${(ev) => s.set({ closedMessage: ev.target.value })} />
            <//>
            <div class="afe-field">
              <label for="afe-formurl">Outside form <span class="afe-opt">optional</span></label>
              <input id="afe-formurl" class="form-input" type="url" inputmode="url" value=${e.formUrl} placeholder="https://" aria-invalid=${p.formUrl ? 'true' : 'false'} onInput=${(ev) => s.set({ formUrl: ev.target.value })} />
              ${p.formUrl ? html`<span class="afe-bad">${p.formUrl}</span>` : html`<span class="afe-hint">Leave blank to use the site's own form. A link here sends the Apply button to that form instead, in a new tab.</span>`}
            </div>
          </div>

          <${Section} title="Open and close by itself">
            <p class="afe-hint" style="margin: -.15rem 0 .85rem;">Set a time and the site does it within a minute, posts a note in Slack, and logs it below. Times are your time${zone ? ` (${zone})` : ''}.</p>
            <div class="afe-pair afe-set-times">
              ${s.saved.open
                ? html`<div class="afe-field"><span class="afe-label">Open</span><span class="afe-sum">Already open.</span></div>`
                : timeField('opensAt', 'Open on', 'Blank: stays closed until you open it.')}
              ${s.saved.open || e.opensAt
                ? timeField('closesAt', 'Close on', 'Blank: stays open until you close it.')
                : html`<div class="afe-field"><span class="afe-label">Close on</span><span class="afe-sum">Set an opening time first.</span></div>`}
            </div>
          <//>

          ${s.conflict && html`
            <div class="afe-note is-warn" role="alert" style="margin-top: 1rem;">
              <${Icon} name="warn" />
              <span>Someone changed these settings while you had them open. Your changes are still here: Save to use them, or Discard to see theirs.</span>
            </div>`}
          <div class="afe-settings-foot">
            <button class="btn btn-primary" disabled=${!s.dirty || !!s.busy || s.invalid} onClick=${s.save}>${s.busy === 'save' ? 'Saving…' : 'Save'}</button>
            ${s.dirty && html`<button class="btn btn-ghost" disabled=${!!s.busy} onClick=${s.discard}>Discard</button>`}
            <span class="afe-hint" aria-live="polite">${s.dirty ? 'Unsaved changes' : 'Saved'}</span>
          </div>
          <p class="afe-hint" style="margin: 1.25rem 0 0;">Who gets the new-application email, and the service area, are in <button class="afe-link" style="font-size: inherit;" onClick=${() => go('form', { formSel: { kind: 'settings' } })}>Form → Settings</button>.</p>
        </div>
      </div>

      <aside class="afe-set-side">
        <${FamilyPreview} s=${s} />
        <${WaitlistPanel} savedOpen=${!!s.saved?.open} addToast=${addToast} />
        <${SettingsHistory} history=${s.history} />
      </aside>
      ${ask && html`<${OpenCloseDialog} mode=${ask} s=${s} onClose=${() => setAsk(null)} />`}
    </div>`;
}

/** Open or closed, since when and by whom, what's scheduled, and where it shows */
function StatusCard({ s, onAsk }) {
  const a = s.saved;
  const next = !a.open && a.opensAt ? `Opens by itself ${longWhen(a.opensAt)}` : a.open && a.closesAt ? `Closes by itself ${longWhen(a.closesAt)}` : null;
  return html`
    <section class="card afe-status ${a.open ? 'is-open' : ''}" aria-labelledby="afe-status-h">
      <div class="afe-status-row">
        <div class="afe-status-text">
          <span class="afe-status-dot" aria-hidden="true"></span>
          <h3 id="afe-status-h" aria-live="polite">${a.open ? 'Applications are open' : 'Applications are closed'}</h3>
          <p>${a.open ? `Families can start a ${a.year} application.` : `New families can't start an application. Season: ${a.year}.`}${s.since ? ` ${a.open ? 'Opened' : 'Closed'} ${clock(s.since.at)} by ${whoName(s.since.by)}.` : ''}</p>
          ${next && html`<p class="afe-status-next"><${Icon} name="clock" size=${15} />${next}</p>`}
        </div>
        <button class=${`btn ${a.open ? 'btn-ghost' : 'btn-primary'} afe-status-btn`} disabled=${!!s.busy} onClick=${() => onAsk(a.open ? 'close' : 'open')}>
          ${s.busy === 'open' ? 'Opening…' : s.busy === 'close' ? 'Closing…' : a.open ? 'Close applications…' : 'Open applications…'}
        </button>
      </div>
      <dl class="afe-where">
        <div>
          <dt>Application form</dt>
          <dd><span class="afe-live is-on"></span>Follows this right away · <a href="/apply/form/" target="_blank" rel="noopener">/apply/form/</a></dd>
        </div>
        <div>
          <dt>Apply page</dt>
          <dd><span class="afe-live is-on"></span>Follows this right away · <a href="/apply/" target="_blank" rel="noopener">/apply/</a></dd>
        </div>
      </dl>
    </section>`;
}

/** The confirm step: exactly what opening or closing changes */
function OpenCloseDialog({ mode, s, onClose }) {
  const a = s.saved;
  const opening = mode === 'open';
  const confirm = async () => { if (await s.setOpen(opening)) onClose(); };
  return html`
    <${Dialog} title=${opening ? `Open applications for ${a.year}?` : 'Close applications?'} onClose=${onClose}
      footer=${html`
        <button class="btn btn-ghost" onClick=${onClose}>Cancel</button>
        <button class="btn btn-primary" disabled=${!!s.busy} onClick=${confirm}>${s.busy ? (opening ? 'Opening…' : 'Closing…') : opening ? 'Open applications' : 'Close applications'}</button>`}>
      <ul class="afe-effects">
        ${opening ? html`
          <li>Families can start a ${a.year} application at <strong>/apply/form/</strong> right away.</li>
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
  const open = show == null ? s.saved.open : show === 'open';
  const message = (e.closedMessage || '').trim() || defaultClosed(e.year);
  return html`
    <section class="card afe-fam" aria-labelledby="afe-fam-h">
      <div class="afe-fam-head">
        <h4 id="afe-fam-h">What families see</h4>
        <div class="afe-seg afe-seg-text" role="group" aria-label="Show the page">
          <button aria-pressed=${open} onClick=${() => setShow('open')}>Open</button>
          <button aria-pressed=${!open} onClick=${() => setShow('closed')}>Closed</button>
        </div>
      </div>
      <p class="afe-hint" style="margin: 0 0 .7rem;">The banner on the Apply page${s.dirty ? ', with your unsaved changes' : ''}.</p>
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
        ? html`<ol class="afe-log">${rows.slice(0, 10).map(r => html`<li key=${r.key}><span>${r.t}</span><span class="afe-hint">${clock(r.h.at)} · ${whoName(r.h.by)}</span></li>`)}</ol>`
        : html`<p class="afe-hint" style="margin: 0;">Opening, closing and season changes show here, with who made them.</p>`}
    </section>`;
}
