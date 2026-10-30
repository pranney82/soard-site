/**
 * The makeover application in the browser (/apply/form/)
 * ===========================================================================
 * The form is data (functions/api/_application-form.js; staff edit it in
 * Admin → Applications → Form). The page carries the live definition,
 * embedded by functions/apply/form/[[path]].js (or fetched from
 * /api/apply?config); this script resolves it in the family's language
 * (English or Spanish, switchable at any point without losing an answer),
 * draws it (./application-render.js) and walks them through it one page at a
 * time with the same rules the server checks against: show/hide rules on
 * questions and pages, answer checks, stop screens.
 *
 * It saves to /api/apply as they go (a draft keyed by a token kept in
 * localStorage and in the emailed resume link), suggests addresses as they
 * type the home address and places it on the service-area map (the server
 * asks the Census; the answer it gives is the service-area answer, and the
 * family only answers that themselves when the address can't be found),
 * uploads photos (resized here to JPEG) and the video
 * (straight to Cloudflare Stream over tus, resumable; on a computer it can
 * also record one with the camera), shows a review page, and submits.
 *
 * Preview modes save nothing: ?preview=draft (staff: the unsaved draft) and
 * ?preview=live (the admin editor's live pane: it posts each change here).
 * ?preview=1 only shows the form while applications are closed.
 *
 * ?test=1 is a staff test run (Admin → Applications → Form, "Go through it as a
 * family"): the real form, saving, uploads and submit, open or closed, with every
 * email going to the signed-in staff member. A bar says so and fills a page with
 * sample answers on request; after Submit, the thank-you shows the intake in
 * JobTread step by step as it happens. Its draft is kept apart from a real one.
 */
import * as tus from 'tus-js-client';
import {
  DEFAULT_DEFINITION, LANGS, AREA_VALUES, resolveForm, allFields, indexById, isVisible, pageVisible,
  stopFor, fieldError, formErrors, answerSections, isInput, isUpload, dateText,
} from '../../../functions/api/_application-form.js';
import { addressKey, checkableAddress } from '../../../functions/api/_geo.js';
import { renderPages, t as word, imageHtml, mapWords, esc } from './application-render.js';
import { areaMapHtml, declutter } from './area-map.js';
import { signupCheck, postPlainly } from '../../utils/signup-check';

const API = '/api/apply';
const STORE_KEY = 'soard-application-draft';
const TEST_STORE_KEY = 'soard-application-test-run';
const LANG_KEY = 'soard-application-lang';
const CHUNK = 10 * 1024 * 1024; // tus chunks: small enough for a phone on a weak signal
const PHOTO_MAX = 2560;
const THUMB_MAX = 800;
const RECORD_MAX_MS = 10 * 60 * 1000;
const RING = 113.1; // the upload ring's circumference (r = 18)
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const SLIDE_MS = 260;
const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3L12.5 5" /></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 2.7l2.5 2.5L6 12.5l-3.2.7.7-3.2z" /></svg>';

/** localStorage behind try/catch: private windows and blocked storage just forget */
const local = (key) => ({
  get() { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem(key); } catch { /* private mode */ } },
});
const store = local(STORE_KEY);
const langPref = local(LANG_KEY);

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = () => matchMedia('(pointer: fine)').matches;
const isToken = (s) => /^[0-9a-f]{32}$/.test(String(s || ''));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const blank = (v) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => !String(x ?? '').trim()));

async function api(body) {
  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch { data = { ok: false }; }
  return { status: res.status, ...data };
}

// The site uses Astro's ClientRouter: run on every visit to the page, not just the first load
document.addEventListener('astro:page-load', () => {
  const root = document.querySelector('[data-application]');
  if (root && !root.dataset.ready) boot(root);
});

/** ?preview=live | draft, or 'open' for any other ?preview (show while closed) */
function previewMode() {
  const p = new URLSearchParams(location.search).get('preview');
  if (p == null) return null;
  return p === 'live' || p === 'draft' ? p : 'open';
}

/** The page's config: embedded by the page's Function, else asked for (kind: which application) */
async function loadConfig(mode, kind = 'family') {
  const embedded = document.getElementById('af-config');
  if (embedded && mode !== 'draft') {
    try { return JSON.parse(embedded.textContent); } catch { /* fall through to the API */ }
  }
  try {
    const res = await fetch(`${API}?config${kind === 'organization' ? '&kind=organization' : ''}${mode === 'draft' ? '&preview=draft' : ''}`, { cache: 'no-store' });
    return await res.json();
  } catch {
    return null;
  }
}

/** The language to start in: the family's earlier choice, else the browser's */
function startLang() {
  // A link that names the language (the Spanish "applications are open" email) wins, and sticks
  const asked = new URLSearchParams(location.search).get('lang');
  if (LANGS[asked]) { langPref.set(asked); return asked; }
  const saved = langPref.get();
  if (LANGS[saved]) return saved;
  const nav = String(navigator.languages?.[0] || navigator.language || '').toLowerCase();
  return nav.startsWith('es') ? 'es' : 'en';
}

async function boot(root) {
  root.dataset.ready = '1';
  const mode = previewMode();
  init(root, (await loadConfig(mode, root.dataset.kind)) || {}, mode);
}

function init(root, cfg, mode) {
  // Listeners on document/window end when the page is swapped out
  const life = new AbortController();
  const { signal } = life;
  document.addEventListener('astro:before-swap', () => {
    closeRecorder();
    life.abort();
    window.__afPop = null;
    document.documentElement.classList.remove('af-focus', 'af-vt', 'af-vt-back', 'af-vt-same'); // the next page has the screen back
  }, { once: true });

  const live = mode === 'live';
  const previewing = live || !!cfg.preview;
  // A staff test run: { by: their email } once signed in, { signIn: true } before (the page's Function decides)
  let testRun = !previewing && cfg.testRun ? cfg.testRun : null;
  // A family's application (/apply/form/) or an organization's (/apply/community-project/), each with its own saved draft
  const kind = root.dataset.kind === 'organization' || cfg.kind === 'organization' ? 'organization' : 'family';
  const org = kind === 'organization';
  const keyed = (k) => (org ? `${k}-organization` : k);
  // Its draft is kept apart, so this browser's own application (if any) is never mixed up with it
  let store = local(keyed(testRun ? TEST_STORE_KEY : STORE_KEY));
  // Where messages go: the parent's email, or the organization's main contact's
  const emailId = org ? 'contactEmail' : 'parentEmail';
  const year = String(cfg.year || root.dataset.year || '');
  const version = cfg.version || 0;
  // The raw definition (resolved here per language); an older server only sends the English form
  let definition = cfg.definition?.pages?.length ? cfg.definition : (cfg.form?.pages?.length ? null : DEFAULT_DEFINITION);
  const resolve = (l) => (definition ? resolveForm(definition, { year, version, lang: l }) : { ...cfg.form, lang: 'en', languages: ['en'] });

  const $ = (sel) => root.querySelector(sel);
  const ui = {
    form: $('[data-form]'),
    pages: $('[data-pages]'),
    review: $('[data-page="review"]'),
    reviewList: $('[data-review]'),
    reviewSummary: $('[data-review-summary]'),
    stepText: $('[data-step-text]'),
    partText: $('[data-part-text]'),
    stepTitle: $('[data-step-title]'),
    stage: $('[data-stage]'),
    steps: $('[data-steps]'),
    stepsList: $('[data-steps-list]'),
    back: $('[data-back]'),
    next: $('[data-next]'),
    nextLabel: $('[data-next-label]'),
    nextShort: $('[data-next-short]'),
    navNote: $('[data-nav-note]'),
    saveLaters: [...root.querySelectorAll('[data-save-later]')],   // under the buttons, and in the rail on a computer
    saveStates: [...root.querySelectorAll('[data-save-state]')],
    rail: $('[data-rail]'),
    railList: $('[data-rail-list]'),
    timeLeft: $('[data-time-left]'),
    top: $('[data-top]'),
    segs: $('[data-segs]'),
    exit: $('[data-exit]'),
    hub: $('[data-hub]'),
    hubTitle: $('[data-hub-title]'),
    hubLead: $('[data-hub-lead]'),
    hubList: $('[data-hub-list]'),
    hubGo: $('[data-hub-go]'),
    hubGoLabel: $('[data-hub-go-label]'),
    hubLater: $('[data-hub-later]'),
    reviewAll: $('[data-review-all]'),
    live: $('[data-live]'),
    notice: $('[data-notice]'),
    langSwitches: [...root.querySelectorAll('[data-lang-switch]')], // in the bar across the top, and on the overview
    stop: $('[data-stop]'),
    stopTitle: $('[data-stop-title]'),
    stopBody: $('[data-stop-body]'),
    stopMap: $('[data-stop-map]'),
    done: $('[data-done]'),
    honeypot: $('[data-honeypot]'),
    turnstile: $('[data-turnstile]'),
    dialog: $('[data-later-dialog]'),
    detail: $('[data-detail-dialog]'),
  };

  // ── State ────────────────────────────────────────────────────────
  // The organization application is in English
  let lang = org ? 'en' : startLang();
  let form = null;
  let fields = [];
  let byId = {};
  let pageEls = {};
  let answers = {};          // every answer known so far (kept across redraws)
  const files = {};          // fieldId → { key|uid, uploaded, name } (enough for formErrors)
  const uploadUi = {};       // fieldId → { state, msg, thumb, pct }
  const uploads = new Set(); // uploads in progress
  const touched = new Set(); // questions the family has worked on (they get checked when left)
  const shown = new Set();   // questions showing a problem
  let currentId = null;      // page id, or 'review'
  let screenNo = 0;          // which of the page's screens is showing
  let packs = {};            // page id → its screens: the page's top-level pieces, a screen's worth at a time
  let focused = false;       // the application has the screen to itself (html.af-focus)
  let calmUntil = 0;         // till when a new screen is settling (presses before then don't count)
  let moving = false;        // a screen change is under way (Continue pressed twice counts once)
  let furthestId = null;     // the furthest page reached
  let fromReview = false;    // came from the review page: 'answer' (one, then straight back) or 'step' (a whole step, walked through)
  let token = null;
  let turnstileToken = null;
  let turnstileSiteKey = null;
  let saveChain = Promise.resolve();
  let dirtyTimer = null;
  let busy = false;
  let lastNotice = null;
  let lastSave = null;
  let lastNav = null;
  let stopShown = null;
  let doneShown = null;
  let countyNote = null;
  let laterEmail = '';
  let uspsNow = null;        // the Postal Service's word on the home address (with a Google key): { key, status }
  const uspsOn = !!cfg.usps;
  let areaNow = null;        // the last service-area check of the home address: { key, band, answer, lat, lng, miles, county, matched, reason }

  const T = (k, v = {}) => word(lang, k, { year, ...v }, kind);
  /** A message spec: 'key', ['key', vars] or { raw: 'text' } → words in the current language */
  const say = (m) => (!m ? '' : typeof m === 'string' ? T(m) : Array.isArray(m) ? T(m[0], m[1]) : String(m.raw || ''));
  const fieldEl = (id) => ui.pages.querySelector(`[data-field="${CSS.escape(id)}"]`);
  const pageEl = (id) => (id === 'review' ? ui.review : pageEls[id]);
  const order = (id) => (id === 'review' ? form.pages.length : form.pages.findIndex(p => p.id === id));
  const pageOf = (fid) => byId[fid]?.page;
  const reached = (id) => order(id) >= 0 && order(id) <= order(furthestId);

  // ── Reading and writing answers ──────────────────────────────────
  function readField(f) {
    const el = fieldEl(f.id);
    if (!el) return undefined;
    switch (f.type) {
      case 'radio': return el.querySelector('input:checked')?.value || '';
      case 'checkbox': return [...el.querySelectorAll('input:checked')].map(i => i.value);
      case 'ack': return el.querySelector('input:checked') ? f.options[0] : '';
      case 'name': case 'address':
        return Object.fromEntries([...el.querySelectorAll('[data-part]')].map(i => [i.dataset.part, i.value.trim()]));
      // The check's answer while it matches the address on screen; else theirs, when they were asked
      case 'area': {
        const placed = areaPlaced();
        if (placed) return placed.answer;
        return el.querySelector('[data-area-ask]:not([hidden]) input:checked')?.value || '';
      }
      default: return el.querySelector('input, textarea, select')?.value ?? '';
    }
  }
  function writeField(f, v) {
    const el = fieldEl(f.id);
    if (!el || v == null) return;
    switch (f.type) {
      case 'radio': case 'area': el.querySelectorAll('input[type=radio]').forEach(i => { i.checked = i.value === v; }); break;
      case 'checkbox': el.querySelectorAll('input').forEach(i => { i.checked = Array.isArray(v) && v.includes(i.value); }); break;
      case 'ack': el.querySelectorAll('input').forEach(i => { i.checked = v === f.options[0]; }); break;
      case 'name': case 'address':
        el.querySelectorAll('[data-part]').forEach(i => { if (v[i.dataset.part] != null) i.value = v[i.dataset.part]; });
        if (f.type === 'address') syncAddressLine(el);
        break;
      default: {
        const input = el.querySelector('input, textarea, select');
        if (input && input.type !== 'file') input.value = v;
      }
    }
  }
  function readAnswers() {
    const out = {};
    for (const f of fields) {
      if (!isInput(f)) continue;
      const v = readField(f);
      if (v !== undefined) out[f.id] = v;
    }
    return out;
  }

  // ── Drawing the form (first paint, a language switch, a live-preview edit) ──
  function draw({ merge = true } = {}) {
    if (form && merge) answers = { ...answers, ...readAnswers() };
    // An address being searched for keeps what's typed in its line, one entered by hand its parts (neither is an answer yet)
    const addrWas = form ? [...ui.pages.querySelectorAll('[data-field] .af-address')].map(b => ({ id: b.closest('[data-field]').dataset.field, mode: b.dataset.mode, line: b.querySelector('[data-search]').value })) : [];
    closeRecorder();
    closeSuggest();
    form = resolve(lang);
    lang = form.lang || 'en';
    fields = allFields(form);
    byId = indexById(form);
    ui.pages.innerHTML = renderPages(form, lang);
    ui.pages.removeAttribute('aria-busy');
    packs = {}; // new pieces, new sizes: each page's screens are worked out again when it shows
    pageEls = Object.fromEntries([...ui.pages.querySelectorAll('[data-page]')].map(el => [el.dataset.page, el]));
    for (const f of fields) if (isInput(f)) writeField(f, answers[f.id]);
    for (const was of addrWas) {
      const b = addrBox(fieldEl(was.id));
      if (!b) continue;
      if (was.mode === 'parts') b.dataset.mode = 'parts';
      else if (!b.dataset.picked && was.line) { b.dataset.mode = 'line'; b.querySelector('[data-search]').value = was.line; }
    }
    for (const f of fields) if (isUpload(f)) paintUpload(f.id);
    openAnsweredTucked();
    paintArea();
    if (!furthestId || order(furthestId) < 0) furthestId = form.pages[0]?.id || 'review';
    if (countyNote && answers[countyNote.field] === countyNote.value) showCountyNote();
    refresh({ animate: false });
    for (const id of [...shown]) setFieldError(id, errorFor(id));
  }

  /** Every word outside the questions: hero, buttons, dialog, notices */
  function applyWords() {
    document.querySelectorAll('[data-af-lang-scope]').forEach(el => el.setAttribute('lang', lang));
    document.querySelectorAll('[data-af-t]').forEach(el => { el.textContent = T(el.dataset.afT); });
    document.querySelectorAll('[data-af-t-html]').forEach(el => { el.innerHTML = T(el.dataset.afTHtml); });
    document.querySelectorAll('[data-af-t-aria]').forEach(el => el.setAttribute('aria-label', T(el.dataset.afTAria)));
    document.querySelectorAll('[data-af-t-alt]').forEach(el => el.setAttribute('alt', T(el.dataset.afTAlt)));
    document.querySelectorAll('[data-af-t-placeholder]').forEach(el => el.setAttribute('placeholder', T(el.dataset.afTPlaceholder)));
    paintNotify();
    const later = ui.dialog.querySelector('[data-later-email]');
    if (later) later.textContent = laterEmail;
    const langs = form.languages || ['en'];
    for (const sw of ui.langSwitches) {
      sw.hidden = langs.length < 2;
      sw.querySelectorAll('[data-lang]').forEach(b => {
        b.hidden = !langs.includes(b.dataset.lang);
        b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
      });
    }
    paintNotice();
    paintSaveState();
    paintNavNote();
    if (stopShown) paintStop();
    if (doneShown) paintDone();
  }

  // ── Show/hide rules and choice limits ────────────────────────────
  function refresh({ animate = true } = {}) {
    const a = readAnswers();
    for (const f of fields) {
      if (!f.showIf) continue;
      const el = fieldEl(f.id);
      if (!el) continue;
      const { pageShowIf, ...own } = f; // its page is on screen, so only its own rule matters here
      const show = isVisible(own, a, byId);
      if (el.hidden !== show) continue;
      el.hidden = !show;
      if (show && animate) openUp(el);
      if (!show) setFieldError(f.id, null);
    }
    for (const f of fields) {
      if (f.type !== 'checkbox' || !f.max) continue;
      const el = fieldEl(f.id);
      const picked = el?.querySelectorAll('input:checked').length || 0;
      el?.querySelectorAll('input').forEach(i => { i.disabled = !i.checked && picked >= f.max; });
    }
    paintHeader();
  }

  // ── Motion ───────────────────────────────────────────────────────
  /** Slide/fade something in: transform + opacity only; nothing under reduced motion */
  function enter(el, x, y = 0, duration = SLIDE_MS, easing = EASE) {
    if (!el || reducedMotion() || !el.animate) return null;
    return el.animate([{ opacity: 0, transform: `translate(${x}px, ${y}px)` }, { opacity: 1, transform: 'none' }], { duration, easing });
  }
  /** A follow-up opening under its question: its room opens (nothing below jumps), and it fades in as it does */
  function openUp(el) {
    if (!el || reducedMotion() || !el.animate) return;
    const h = el.getBoundingClientRect().height;
    const gap = parseFloat(getComputedStyle(el.parentElement).rowGap) || 0;
    el.animate([
      { height: '0px', marginTop: `${-gap}px`, opacity: 0, transform: 'translateY(-6px)', overflow: 'hidden' },
      { height: `${h}px`, marginTop: '0px', opacity: 0.4, transform: 'translateY(-2px)', overflow: 'hidden', offset: 0.55 },
      { height: `${h}px`, marginTop: '0px', opacity: 1, transform: 'none', overflow: 'hidden' },
    ], { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  /** The question being edited in the admin, outlined for a moment */
  function flash(el) {
    el.classList.remove('af-flash');
    void el.offsetWidth;
    el.classList.add('af-flash');
    clearTimeout(el._flash);
    el._flash = setTimeout(() => el.classList.remove('af-flash'), 1900);
  }
  function headerOffset() {
    if (focused) return (ui.top?.offsetHeight || 72) + 16;
    return parseInt(getComputedStyle(document.documentElement).scrollPaddingTop, 10) || 100;
  }
  /** Back to the top of the step (or, on the page, of the application) if they've scrolled past it (a test run: its bar, where Fill is) */
  function scrollToForm(force = false) {
    if (focused) { if (force || window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'auto' }); return; }
    const bar = testRun?.by ? root.querySelector('[data-testbar]:not([hidden])') : null;
    const top = (bar || root).getBoundingClientRect().top;
    const offset = headerOffset();
    if (!force && top >= offset - 8) return;
    window.scrollTo({ top: Math.max(0, window.scrollY + top - offset), behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  /**
   * Change what's on screen (`update` does it) with the motion of going forward or back: the old
   * screen slips out the way they're heading and the new one slides in from the other side, Plaid's
   * timing (150ms out, 260ms in, overlapping). View Transitions where the browser has them, a plain
   * slide in where it hasn't, a quick fade under reduced motion. Resolves once the new screen is in
   * the page (the animation may still be finishing).
   */
  function swap(update, dir, samePage = false) {
    const html = document.documentElement;
    if (!dir || !focused) { update(); return Promise.resolve(); }
    calmUntil = performance.now() + 350; // a second press of Continue mid-change (a double tap) counts once
    if (reducedMotion()) {
      update();
      ui.stage.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: 120, easing: 'linear' });
      return Promise.resolve();
    }
    if (!document.startViewTransition || document.visibilityState === 'hidden') {
      update();
      enter(ui.stage, dir * 16, 0, 260, 'cubic-bezier(.05,.7,.1,1)');
      return Promise.resolve();
    }
    html.classList.add('af-vt');
    html.classList.toggle('af-vt-back', dir < 0);
    html.classList.toggle('af-vt-same', samePage);
    moving = true;
    let vt;
    try {
      vt = document.startViewTransition(() => { try { update(); } catch (err) { console.warn('Could not change the screen', err); } });
    } catch {
      html.classList.remove('af-vt', 'af-vt-back', 'af-vt-same');
      moving = false;
      update();
      return Promise.resolve();
    }
    vt.ready.catch(() => {}); // skipped (another change came first, or the tab went to the background): the screen still changes
    vt.finished.catch(() => {}).finally(() => { if (!moving) html.classList.remove('af-vt', 'af-vt-back', 'af-vt-same'); });
    return vt.updateCallbackDone.catch(() => {}).finally(() => { moving = false; });
  }

  // ── The application on its own screen ────────────────────────────
  // Once they start, the site's header, footer and the hero step aside (html.af-focus) and the
  // application fills the screen: Plaid's and Airbnb's way. "Save and exit" (or Back from the
  // first screen) returns to the page, with the overview of every step in the form's place.
  const FOCUS_KEY = keyed('soard-application-focus');
  const session = {
    get() { try { return sessionStorage.getItem(FOCUS_KEY) === '1'; } catch { return false; } },
    set(on) { try { if (on) sessionStorage.setItem(FOCUS_KEY, '1'); else sessionStorage.removeItem(FOCUS_KEY); } catch { /* private mode */ } },
  };
  function enterFocus() {
    if (focused || root.hidden) return false;
    focused = true;
    root.classList.add('is-focus');
    document.documentElement.classList.add('af-focus');
    if (!live) session.set(true);
    trapped = trapped || !!history.state?.afFocus;
    window.scrollTo({ top: 0, behavior: 'auto' });
    // In: the bar drops into place, the step rises (a touch of overshoot, like Plaid Link's sheet)
    if (!reducedMotion()) {
      ui.top?.animate?.([{ transform: 'translateY(-100%)' }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
      enter(ui.stage, 0, 18, 380, 'cubic-bezier(.23,1.2,.32,1)');
      if (railShown()) enter(ui.rail, -14, 0, 380);
    }
    return true;
  }
  /** Start, or carry on: the application takes the screen, at `id` if given (a step already reached), else where they were */
  function begin(id = null) {
    if (root.hidden) return;
    const was = focused;
    enterFocus();
    armTrap();
    const go = id && (reached(id) || previewing) ? id : currentId;
    if (was && go === currentId) return;
    if (go !== currentId) currentId = null; // a new page: worked out afresh
    show(go, { screen: 'open', scroll: true });
  }
  function exitFocus({ fromPop = false } = {}) {
    if (!focused) return;
    if (token) save();
    closeRecorder();
    closeSuggest();
    if (ui.dialog.open) ui.dialog.close();
    focused = false;
    root.classList.remove('is-focus');
    document.documentElement.classList.remove('af-focus', 'af-vt', 'af-vt-back', 'af-vt-same');
    session.set(false);
    if (trapped && !fromPop) { swallow = true; history.back(); }
    trapped = false;
    if (token && !doneShown && !previewing) notice('exitSaved', 'success');
    paintHeader();
    requestAnimationFrame(() => {
      const app = document.getElementById('application');
      const top = Math.max(0, (app?.getBoundingClientRect().top || 0) + window.scrollY - headerOffset());
      window.scrollTo({ top, behavior: 'auto' });
      (doneShown ? ui.done.querySelector('[data-done-title]') : ui.hubTitle)?.focus({ preventScroll: true });
    });
  }

  // The phone's Back gesture (and the browser's Back): a screen back, not off the page. One extra
  // history entry holds the place while the application has the screen; Back lands on the entry
  // under it, which goes back a screen (or, from the first, to the page) instead of the site's
  // router loading the page again. The entry is put back on their next tap, since a browser skips
  // entries a page adds without one.
  let trapped = false;
  let swallow = false;
  function armTrap() {
    if (trapped || !focused || live || window.parent !== window) return;
    try { history.pushState({ ...(history.state || {}), afFocus: 1 }, ''); trapped = true; } catch { /* history unavailable */ }
  }

  // ── Steps ────────────────────────────────────────────────────────
  /** The pages these answers show, in order, then review (the page on screen always counts) */
  function stepIds(a = readAnswers()) {
    return [...form.pages.filter(p => p.id === currentId || pageVisible(p, a, byId)).map(p => p.id), 'review'];
  }
  function reach(id) {
    if (order(id) <= order(furthestId)) return;
    furthestId = id;
    remember();
  }
  function remember() {
    if (token && !previewing) store.set({ token, year, furthest: furthestId });
  }
  const titleOf = (id) => (id === 'review' ? T('reviewTitle') : form.pages.find(p => p.id === id)?.title || '');
  /** Pages with a required answer still missing or wrong */
  const needsSet = (a = readAnswers()) => new Set(Object.keys(formErrors(form, a, files, null, lang)).map(pageOf));
  /** Done: reached, passed, and nothing on it needs them */
  const stepDone = (id, needs) => id !== 'review' && reached(id) && order(id) < order(furthestId) && !needs.has(id);
  const screensIn = (id) => (id === 'review' ? 1 : packs[id]?.length || 1);
  /** A screen with nothing on it (a follow-up alone there that their answer didn't call for) is passed over */
  const emptyScreen = (pid, n) => !!packs[pid]?.[n] && packs[pid][n].every(k => k.hidden || !!k.closest('[hidden]'));
  const screenAhead = () => (packs[currentId] || []).some((_, n) => n > screenNo && !emptyScreen(currentId, n));
  const screenBefore = () => { for (let n = screenNo - 1; n >= 0; n--) if (!emptyScreen(currentId, n)) return n; return -1; };

  // The browser tab says where they are while the application has the screen
  const baseTitle = document.title.replace(/^Test run · /, '');
  function paintTitle(ids = stepIds()) {
    let title = baseTitle;
    if (focused && currentId && !stopShown && !doneShown) {
      const i = Math.max(0, ids.indexOf(currentId));
      title = `${T('step', { n: i + 1, total: ids.length })}: ${titleOf(currentId)} · ${baseTitle}`;
    }
    title = (testRun?.by ? 'Test run · ' : '') + title;
    if (document.title !== title) document.title = title;
  }

  function paintHeader() {
    const ids = stepIds();
    const i = Math.max(0, ids.indexOf(currentId));
    ui.stepText.textContent = T('step', { n: i + 1, total: ids.length });
    const n = screensIn(currentId);
    ui.partText.textContent = n > 1 ? T('part', { n: screenNo + 1, total: n }) : '';
    const title = titleOf(currentId);
    if (ui.stepTitle.textContent !== title) ui.stepTitle.textContent = title;
    const needs = needsSet();
    paintSegs(ids, needs);
    paintTimeLeft(ids);
    paintStepList(ids, needs);
    paintNav(ids);
    paintTitle(ids);
    paintHub(ids, needs);
  }

  /** The segments along the top: done steps full, the one on screen filling a part at a time */
  function paintSegs(ids, needs) {
    if (!ui.segs || !focused) return;
    if (ui.segs.children.length !== ids.length) {
      ui.segs.replaceChildren(...ids.map(() => {
        const li = document.createElement('li');
        li.className = 'af-seg';
        const fill = document.createElement('span');
        fill.className = 'af-seg-fill';
        li.append(fill);
        return li;
      }));
    }
    ids.forEach((id, k) => {
      const li = ui.segs.children[k];
      const now = id === currentId;
      const done = !!doneShown || (!now && stepDone(id, needs));
      const fill = done ? 1 : now ? (screenNo + 1) / (screensIn(id) + 1) : 0;
      li.dataset.state = done ? 'done' : now ? 'now' : '';
      const v = `scaleX(${fill.toFixed(3)})`;
      if (li.firstChild.style.transform !== v) li.firstChild.style.transform = v;
    });
  }

  /**
   * About how long is left: the questions still unanswered on this page and the pages after
   * it, at a rough time each (a long answer or the video takes longest; an optional one
   * counts for less, since many skip it). Scaled so a fresh application reads about 15
   * minutes, which is what the hero promises.
   */
  const SECONDS = { content: 20, guidelines: 40, ack: 6, address: 35, select: 6, radio: 5, checkbox: 10, name: 14, date: 10, text: 15, number: 8, textarea: 70, email: 12, phone: 10, signature: 10, photo: 35, video: 240 };
  function secondsLeft(ids, a, from, fresh = false) {
    let s = 0;
    for (const id of ids) {
      const p = form.pages.find(x => x.id === id);
      if (!p || order(id) < order(from)) continue;
      for (const f of p.fields) {
        const fl = byId[f.id] || f;
        if (!isVisible(fl, a, byId)) continue;
        const each = SECONDS[f.type] || 0;
        if (!each) continue;
        if (!isInput(fl) && !isUpload(fl)) { if (fresh || order(id) > order(from)) s += each; continue; } // reading a page not seen yet
        if (!fresh && !unanswered(fl, a)) continue;
        s += fl.required ? each : each * 0.3;
      }
    }
    return s;
  }
  function minutesLeft(ids = stepIds(), a = readAnswers()) {
    const all = secondsLeft(ids, a, ids[0], true) || 1;
    return Math.max(1, Math.ceil((secondsLeft(ids, a, currentId === 'review' ? 'review' : currentId || ids[0]) / all) * 15));
  }
  /** A step's share of the 15 minutes, for the overview */
  function minutesOf(id) {
    const ids = stepIds();
    const all = secondsLeft(ids, {}, ids[0], true) || 1;
    return Math.max(1, Math.round((secondsLeft([id], {}, id, true) / all) * 15));
  }
  function paintTimeLeft(ids) {
    if (!ui.timeLeft || !railShown()) return;
    if (currentId === 'review') { ui.timeLeft.textContent = T('leftReview'); return; }
    const mins = minutesLeft(ids);
    ui.timeLeft.textContent = mins <= 1 ? T('leftOne') : T('leftMany', { n: mins });
  }

  /** A done step's answers in a line: "Maya Rivera · Apr 12, 2017", "2 photos", "Agreed" */
  function summaryOf(pid, a = readAnswers()) {
    const sec = answerSections(form, a, files).find(s => s.id === pid);
    if (!sec) return '';
    const parts = [];
    let photos = 0;
    let video = false;
    let acks = 0;
    for (const it of sec.items) {
      const f = byId[it.id];
      if (!f) continue;
      if (it.upload) { if (f.type === 'video') video = true; else photos++; continue; }
      if (f.type === 'ack') { acks++; continue; }
      if (f.type === 'area') continue;
      const text = String((f.type === 'date' ? dateText(a[f.id], lang) : it.text) || '').split('\n')[0].trim();
      if (text && parts.length < 2) parts.push(text.length > 44 ? `${text.slice(0, 42).trimEnd()}…` : text);
    }
    if (photos) parts.push(photos === 1 ? T('photoAdded') : T('photosAdded', { n: photos }));
    if (video) parts.push(T('videoUploaded'));
    if (!parts.length && acks) parts.push(T('agreed'));
    return parts.join(' · ');
  }

  /**
   * The step lists ("All steps" on a phone, the panel beside the step on a computer): done ones
   * checked with their answers in a line, this one marked, later ones not open yet. Each is
   * painted only while it shows. Updated in place: an answer saved as someone presses a step
   * (a blur's change event) must not swap the button out from under the press.
   */
  const railShown = () => !!ui.rail && ui.rail.offsetParent !== null;
  function paintStepList(ids = stepIds(), needs = needsSet()) {
    const lists = [ui.steps.open && ui.stepsList, railShown() && ui.railList].filter(Boolean);
    if (!lists.length) return;
    const a = readAnswers();
    for (const list of lists) paintList(list, ids, needs, a);
  }
  function paintList(list, ids, needs, a) {
    const items = [...list.children];
    if (items.map(li => li.firstChild?.dataset.goto).join('|') !== ids.join('|')) {
      list.replaceChildren(...ids.map((id) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'af-step';
        b.dataset.goto = id;
        const mark = document.createElement('span');
        mark.className = 'af-step-mark';
        mark.setAttribute('aria-hidden', 'true');
        const body = document.createElement('span');
        body.className = 'af-step-body';
        const name = document.createElement('span');
        name.className = 'af-step-name';
        const sub = document.createElement('span');
        sub.className = 'af-step-sub';
        body.append(name, sub);
        b.append(mark, body, document.createElement('span'));
        li.append(b);
        return li;
      }));
    }
    ids.forEach((id, i) => {
      const li = list.children[i];
      const b = li.firstChild;
      const [mark, body, state] = b.children;
      const [name, sub] = body.children;
      li.toggleAttribute('data-line', i + 1 < ids.length && reached(ids[i + 1])); // the joining line, dark once the next is reached
      const now = id === currentId;
      const open = reached(id);
      const done = !now && stepDone(id, needs);
      b.dataset.state = now ? 'now' : done ? 'done' : open ? 'open' : 'locked';
      b.disabled = !open;
      b.toggleAttribute('aria-current', now);
      if (now) b.setAttribute('aria-current', 'step');
      const markHtml = done ? CHECK_SVG : String(i + 1);
      if (mark.dataset.v !== markHtml) { mark.dataset.v = markHtml; if (done) mark.innerHTML = CHECK_SVG; else mark.textContent = String(i + 1); }
      const title = titleOf(id);
      if (name.textContent !== title) name.textContent = title;
      const n = screensIn(id);
      const line = done ? summaryOf(id, a) : now ? (n > 1 ? T('part', { n: screenNo + 1, total: n }) : '') : open || id === 'review' ? '' : T('minutes', { n: minutesOf(id) });
      if (sub.textContent !== line) sub.textContent = line;
      state.className = now ? 'af-step-now' : 'af-sr';
      const said = now ? T('stepNow') : done ? T('stepDone') : open ? '' : T('stepLocked');
      if (state.textContent !== said) state.textContent = said;
    });
  }

  /**
   * The overview on the page (before they start, and after Save and exit): every step with its
   * minutes, done ones with their answers in a line, and the way in. Like Plaid's onboarding list.
   */
  function paintHub(ids = stepIds(), needs = needsSet()) {
    if (!ui.hub || focused) return;
    const a = readAnswers();
    const steps = ids.filter(id => id !== 'review');
    const started = !!token || (previewing && order(furthestId) > 0 && !live);
    const doneCount = steps.filter(id => stepDone(id, needs)).length;
    const ready = started && !needs.size && order(furthestId) >= order('review');
    const mins = minutesLeft(ids, a);
    ui.hubTitle.textContent = T(started ? 'hubTitleBack' : 'hubTitle');
    ui.hubLead.textContent = !started ? T('hubLead', { n: ids.length })
      : ready ? T('hubLeadReady')
        : T(mins <= 1 ? 'hubLeadBackOne' : 'hubLeadBack', { done: doneCount, n: steps.length, m: mins });
    ui.hubGoLabel.textContent = T(!started ? 'hubStart' : ready || currentId === 'review' ? 'hubReview' : 'hubContinue');
    ui.hubGo.dataset.go = ready ? 'review' : ''; // "Review and submit" goes there (not to the page they left)
    if (ui.hubLater) ui.hubLater.hidden = !started || previewing;
    // The hero's button says the same: start, or carry on
    const cta = document.querySelector('[data-hero-cta]');
    if (cta && !root.hidden && /^hero(Start|Continue)$/.test(cta.dataset.afT || '')) {
      cta.dataset.afT = token ? 'heroContinue' : 'heroStart';
      if (cta.textContent !== T(cta.dataset.afT)) cta.textContent = T(cta.dataset.afT);
    }
    const list = ui.hubList;
    if ([...list.children].map(li => li.firstChild?.dataset.goto).join('|') !== ids.join('|')) {
      list.replaceChildren(...ids.map((id) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'af-hub-row';
        b.dataset.goto = id;
        b.innerHTML = '<span class="af-step-mark" aria-hidden="true"></span><span class="af-hub-name"><strong></strong><span class="af-hub-sub"></span></span><span class="af-hub-meta"></span>';
        li.append(b);
        return li;
      }));
    }
    ids.forEach((id, i) => {
      const b = list.children[i].firstChild;
      const now = started && id === currentId;
      const open = started ? reached(id) : i === 0;
      const done = started && stepDone(id, needs);
      b.dataset.state = done ? 'done' : now ? 'now' : open ? 'open' : 'locked';
      b.disabled = !open && !previewing;
      const [mark, name, meta] = b.children;
      const markHtml = done ? CHECK_SVG : String(i + 1);
      if (mark.dataset.v !== markHtml) { mark.dataset.v = markHtml; if (done) mark.innerHTML = CHECK_SVG; else mark.textContent = String(i + 1); }
      name.firstChild.textContent = titleOf(id);
      name.lastChild.textContent = done ? summaryOf(id, a) : now ? T('stepNow') : '';
      const metaHtml = done ? `${PENCIL_SVG}<span>${esc(T('edit'))}</span>` : id === 'review' ? '' : esc(T('minutes', { n: minutesOf(id) }));
      if (meta.dataset.v !== metaHtml) { meta.dataset.v = metaHtml; meta.innerHTML = metaHtml; }
      b.setAttribute('aria-label', [`${T('step', { n: i + 1, total: ids.length })}: ${titleOf(id)}`, done ? T('stepDone') : now ? T('stepNow') : open ? '' : T('stepLocked'), name.lastChild.textContent].filter(Boolean).join('. '));
    });
  }

  const setText = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };
  function paintNav(ids = stepIds()) {
    const review = currentId === 'review';
    const at = ids.indexOf(currentId);
    const lastScreen = review || !screenAhead();
    ui.back.hidden = at <= 0 && screenNo === 0;
    const label = review ? (busy ? 'submitting' : 'submit') : fromReview === 'answer' || (fromReview && lastScreen) ? 'toReview' : ids[at + 1] === 'review' && lastScreen ? 'reviewBtn' : 'next';
    // Only when the words change: Safari drops a press on Continue whose words are replaced between the
    // finger going down and coming up (leaving a box on the way to it repaints this)
    setText(ui.nextLabel, T(label));
    if (ui.nextShort) setText(ui.nextShort, T({ reviewBtn: 'reviewBtnShort', toReview: 'toReviewShort', submit: 'submitShort' }[label] || label));
    ui.next.classList.toggle('af-btn--submit', review);
    let blockedBy = null;
    if (review) {
      const missing = Object.keys(formErrors(form, readAnswers(), files, null, lang)).length;
      blockedBy = uploads.size ? 'waitUploads' : missing ? 'submitNeeds' : null;
      if (blockedBy) navNote(blockedBy, true);
      else if (lastNav?.reason) navNote(null);
    } else if (lastNav?.reason) navNote(null);
    ui.next.disabled = busy || !!blockedBy;
    ui.next.setAttribute('aria-busy', String(busy));
    if (ui.turnstile) ui.turnstile.hidden = !(turnstileSiteKey && !token && !previewing && at === 0 && screenNo === 0);
    fitNavLater();
  }
  /**
   * A phone's bar: Save and finish later between Back and Continue while it fits beside them (three
   * short lines at most, the buttons' height). A long Continue ("Revisar mis respuestas") keeps its
   * one line, and the link steps aside for that screen (Save and exit, at the top, saves too).
   */
  function fitNavLater() {
    const later = ui.form.querySelector('.af-nav-later');
    if (!later) return;
    later.classList.remove('is-squeezed');
    if (!focused || getComputedStyle(later).display === 'none') return;
    if (later.offsetHeight > 52 || later.scrollWidth > later.clientWidth + 2) later.classList.add('is-squeezed');
  }

  // ── A page a screen at a time ────────────────────────────────────
  /**
   * Which of a page's questions share a screen: as many as fit between the bar across the top and
   * Back / Continue, measured as they're drawn now (this width, this language), then spread evenly
   * so no screen is left with one lonely question. A follow-up stays with the question it follows,
   * a short note stays with the question after it, and anything taller than the screen gets one to
   * itself (and scrolls). Measured as it will be once answered, so answering never pushes Continue
   * over a question: a follow-up as if shown, the service-area check with what it finds. Only while
   * the application has the screen; before that there's nothing to measure. Staff can change the
   * form freely: this works it out for whatever the pages hold.
   */
  // The home address with its map: two pieces once they're split (data-split), so the address can
  // have one screen and the map with what the check found the next.
  // A pair of questions stacked on a phone is two pieces too (they can take a screen each)
  const stackedPair = (k) => k.matches('.af-pair') && k.children.length === 2
    && k.children[1].getBoundingClientRect().top >= k.children[0].getBoundingClientRect().bottom - 1;
  // The check couldn't place the home (it asks): what it found, then the question with the map, which can
  // take a screen of their own where all three don't fit (the question is about the map, so they stay together)
  const asksAboutHome = (k) => k.matches('.af-field--area') && ['unknown', 'error'].includes(k.querySelector('[data-area]')?.dataset.area);
  const areaPieces = (k) => {
    const [res, ask, map] = ['[data-area-result]', '[data-area-ask]', '[data-area-map]'].map(q => k.querySelector(q));
    // In pieces only where they stand one under another (a phone); beside each other they're one
    const stacked = res && map && map.getBoundingClientRect().top >= res.getBoundingClientRect().bottom - 1;
    return asksAboutHome(k) && stacked && ask ? [res, ask, map] : [k];
  };
  const pieces = (pid) => [...(pageEl(pid)?.children || [])].flatMap(k => (k.matches('.af-place[data-split]') ? [...k.children].flatMap(areaPieces) : stackedPair(k) ? [...k.children] : [k]));
  // A piece's questions (the check's question stands for the service-area answer it belongs to)
  const idsOf = (el) => (el.matches('[data-field]') ? [el.dataset.field] : el.matches('[data-area-ask]') ? [el.closest('[data-field]').dataset.field]
    : [...el.querySelectorAll('[data-field]')].map(x => x.dataset.field));
  const isNote = (el) => ['content', 'guidelines', 'image'].includes(el.dataset.type);
  /**
   * Words taller than the room are read a screen at a time: cut between their blocks (paragraphs, a
   * list's items, the guidelines' "What we do" and "What we don't"), going into a part that's still
   * too tall while its blocks stand one under another (never through a row of cards). Words that
   * lead into what follows (a heading, a bold line, a line ending in ":") stay with it.
   */
  const isLead = (el) => /^H[1-6]$/.test(el.tagName) || (el.tagName === 'P'
    && (/:\s*$/.test(el.textContent) || (el.children.length === 1 && el.firstElementChild.tagName === 'STRONG' && el.textContent.trim() === el.firstElementChild.textContent.trim())));
  function readParts(el, fit, into, cuts) {
    const kids = [...el.children].filter(c => c.getClientRects().length);
    const stacked = kids.every((c, i) => !i || c.getBoundingClientRect().top >= kids[i - 1].getBoundingClientRect().bottom - 1);
    if (kids.length < 2 || !stacked) { into.push(el); return; }
    cuts.push(el);
    for (const c of kids) {
      // Measured with the headings just before it, which go on its screen with it
      let top = c.getBoundingClientRect().top;
      for (let j = into.length - 1; j >= 0 && isLead(into[j]); j--) top = into[j].getBoundingClientRect().top;
      if (c.getBoundingClientRect().bottom - top > fit) readParts(c, fit, into, cuts);
      else into.push(c);
    }
  }
  const cutsOf = {}; // page → the notes (and parts of them) cut across its screens
  const packAsked = {}; // page → whether its screens were worked out with the check asking about the home
  let packSize = '';
  function room(el) {
    // Down to where the step starts: the bar across the top, and a notice or the test-run bar over the step
    const top = Math.max(ui.top?.offsetHeight || 0, ui.stage.getBoundingClientRect().top + window.scrollY);
    const nav = ui.form.querySelector('[data-nav]')?.offsetHeight || 0;
    const head = el.getBoundingClientRect().top - ui.stage.getBoundingClientRect().top; // the stage's padding and the step's header
    const saveRow = ui.stage.querySelector('.af-save-row');
    const shown = saveRow && saveRow.offsetParent !== null;
    const tail = (shown ? saveRow.offsetHeight + parseFloat(getComputedStyle(saveRow).marginTop || 0) : 0) + parseFloat(getComputedStyle(ui.stage).paddingBottom || 0);
    return Math.max(120, innerHeight - top - nav - head - tail);
  }
  /**
   * Something new on the screen (problem notes, a notice, a note by the buttons): if it no longer fits,
   * its page's screens are worked out again with it, keeping `keep` (else what's on it now) in front
   */
  function refitScreen(keep = null, problems = null) {
    if (!focused || !currentId || currentId === 'review' || !packs[currentId] || ui.form.hidden || moving) return;
    settle();
    if (document.documentElement.scrollHeight <= innerHeight) return;
    // Problem notes: first the questions a little closer together (often room enough, nothing moves)…
    const pageNode = pageEl(currentId);
    if (problems) {
      pageNode?.setAttribute('data-snug', '');
      settle();
      if (document.documentElement.scrollHeight <= innerHeight) return;
    }
    // …then the screen keeps its questions up to the last one with a problem (none of them moves away
    // from its note), and only what follows goes on to the next screen
    const here = packs[currentId][screenNo] || [];
    const last = problems ? here.reduce((m, k, i) => (idsOf(k).some(id => problems.includes(id)) ? i : m), -1) : -1;
    if (last >= 0 && last < here.length - 1) {
      for (const k of here.slice(last + 1)) k.setAttribute('data-off', '');
      settle();
      if (document.documentElement.scrollHeight <= innerHeight) {
        const kept = [...packs[currentId].slice(0, screenNo), here.slice(0, last + 1)];
        packs[currentId] = pack(currentId, kept) || kept;
        paintScreen();
        paintHeader();
        return;
      }
    }
    const piece = keep || packs[currentId][screenNo]?.find(k => k.getClientRects().length) || null;
    delete packs[currentId];
    show(currentId, { piece, focus: false, scroll: false });
  }
  /**
   * For measuring: the page as it will look once answered (undone straight after, in the same task).
   * A follow-up whose question is on this page shows, an upload has its Remove, and the service-area
   * check shows what it finds for a home inside, with the county it fills in.
   */
  function answeredLook(el, pid) {
    const undo = [];
    for (const k of el.querySelectorAll('[data-field][hidden]')) {
      const lead = byId[k.dataset.field]?.showIf?.field;
      if (lead && pageOf(lead) === pid) { k.hidden = false; undo.push(() => { k.hidden = true; }); }
    }
    // An upload's Remove, there once something's added
    for (const b of el.querySelectorAll('.af-upload [data-act="remove"][hidden]')) { b.hidden = false; undo.push(() => { b.hidden = true; }); }
    const af = areaField();
    const res = af && pageOf(af.id) === pid && el.querySelector('[data-area-result]');
    if (res && !res.querySelector('.af-area-card')) {
      const was = res.innerHTML;
      const sample = T('areaFoundCounty', { address: '1234 Sample Street, Sampleville, GA 30000', county: 'Sample' });
      res.innerHTML = `<div class="af-area-card" data-band="inside">${AREA_ICONS.inside}<div class="af-area-text"><p class="af-area-title">${esc(T('areaInside'))}</p><div class="af-area-desc-wrap"><p class="af-area-desc">${esc(af.descriptions?.[AREA_VALUES.inside] || '')}</p></div><p class="af-area-found">${esc(sample)}</p>${uspsOn ? uspsHtml('check') : ''}<button type="button" class="af-btn af-btn--link af-area-fix">${esc(T('areaFix'))}</button></div></div>`;
      undo.push(() => { res.innerHTML = was; });
    }
    const note = res && el.querySelector('.af-county-note[hidden]');
    if (note) {
      const was = note.textContent;
      note.textContent = T('countyFilled', { county: 'Sample' });
      note.hidden = false;
      undo.push(() => { note.hidden = true; note.textContent = was; });
    }
    return () => undo.reverse().forEach(f => f());
  }
  /** The page's screens; with `keep` (the screens already seen), only the ones after them, worked out again */
  function pack(pid, keep = null) {
    const el = pageEl(pid);
    if (!focused || !el || el.hidden || ui.form.hidden) return null;
    settle(); // taking the screen's own padding mid-change, the first step came out too narrow
    el.querySelectorAll('[data-off]').forEach(k => k.removeAttribute('data-off'));
    unfit(el); // measured with all their words: a fitted screen is fitted again once it's on
    if (!keep) el.removeAttribute('data-snug'); // the questions closer together while problem notes show: worked out afresh
    const places = [...el.querySelectorAll(':scope > .af-place')];
    places.forEach(p => { p.removeAttribute('data-split'); p.style.removeProperty('--af-map-h'); });
    if (el.offsetParent === null) return null;
    packSize = `${innerWidth}x${innerHeight}`;
    packAsked[pid] = [...el.querySelectorAll('.af-field--area')].some(asksAboutHome);
    const fit = room(el);
    const gap = parseFloat(getComputedStyle(el).rowGap) || 0;
    const undo = answeredLook(el, pid);
    // The address beside its map while both fit (with the note that leads into them), else apart
    for (const p of places) {
      const note = p.previousElementSibling;
      const nh = note && isNote(note) ? note.getBoundingClientRect().height : 0;
      if ((nh && nh < fit * 0.5 ? nh + gap : 0) + p.getBoundingClientRect().height > fit) p.setAttribute('data-split', '');
    }
    const cuts = [];
    const kids = pieces(pid).flatMap((k) => {
      // Words taller than the room are cut between their blocks (paragraphs, cards, a list's items) into
      // as many screens as they need, so reading never scrolls either (only a block taller than a screen would)
      const nh = isNote(k) ? k.getBoundingClientRect().height : 0;
      if (nh <= fit) return [k];
      const parts = [];
      readParts(k, fit, parts, cuts);
      return parts;
    });
    cutsOf[pid] = cuts;
    // Each piece's height, and the room between it and the piece before as drawn: a paragraph's
    // spacing inside words, the page's gap between questions
    const rects = kids.map(k => k.getBoundingClientRect());
    const h = rects.map(r => r.height);
    let above = null;
    const sp = rects.map((r) => {
      if (!r.height) return 0;
      const s = above == null ? 0 : Math.max(0, r.top - above);
      above = r.bottom;
      return s;
    });
    undo();
    if (!kids.length) return null;
    // Pieces already on a screen they've seen stay there
    const seen = keep ? keep.flat() : [];
    const placed = (k) => seen.some(d => d === k || d.contains(k) || k.contains(d));
    const blocks = [];
    kids.forEach((k, i) => {
      if (placed(k)) return;
      const f = k.matches('[data-field]') ? byId[k.dataset.field] : null;
      // A follow-up shows on its question's screen when the two fit one together (its question may sit a
      // piece or two back, a pair split on a phone: those pieces join); else it's the next screen's
      const lead = f?.showIf ? blocks.findIndex(b => b.ids.has(f.showIf.field)) : -1;
      const together = lead >= 0 && blocks.slice(lead).reduce((t, b, j) => t + b.h + (j ? b.sp : 0), 0) + sp[i] + h[i] <= fit;
      if (lead >= 0 && lead < blocks.length - 1 && together) {
        const [first, ...rest] = blocks.splice(lead);
        for (const b of rest) { first.kids.push(...b.kids); first.h += b.sp + b.h; b.ids.forEach(x => first.ids.add(x)); }
        first.carry = false;
        blocks.push(first);
      }
      const prev = blocks[blocks.length - 1];
      const follows = prev && (!h[i] || (f?.showIf && prev.ids.has(f.showIf.field) && together) || k.matches('[data-area-map]'));
      if (prev && (follows || prev.carry)) {
        prev.kids.push(k);
        if (h[i]) prev.h += sp[i] + h[i];
        idsOf(k).forEach(x => prev.ids.add(x));
        prev.carry = (prev.carry && !h[i]) || (h[i] > 0 && isLead(k)); // a heading under a heading leads on too
        return;
      }
      // A short note leads into what follows when both fit a screen; a heading or "…:" always does
      const withNext = h[i] + (sp[i + 1] || 0) + (h[i + 1] || 0) <= fit;
      blocks.push({ kids: [k], h: h[i], sp: sp[i], ids: new Set(idsOf(k)), carry: h[i] > 0 && ((isNote(k) && h[i] < fit * 0.5 && withNext) || isLead(k)) });
    });
    // The fewest screens that fit…
    let n = 0;
    let acc = -1;
    for (const b of blocks) {
      if (acc < 0 || acc + b.sp + b.h > fit) { n++; acc = b.h; } else acc += b.sp + b.h;
    }
    const rest = blocks.flatMap(b => b.kids);
    if (!rest.length) return keep;
    if (n <= 1) return keep ? [...keep, rest] : [rest];
    // …then the most even split into that many: no screen over the room (unless one piece is),
    // and the screens as close to each other in height as they can be
    const B = blocks.length;
    const cost = (i, j) => blocks.slice(i, j).reduce((s, b, k) => s + b.h + (k ? b.sp : 0), 0);
    const best = Array.from({ length: n + 1 }, () => Array(B + 1).fill(Infinity));
    const cut = Array.from({ length: n + 1 }, () => Array(B + 1).fill(0));
    best[0][0] = 0;
    for (let k = 1; k <= n; k++) {
      for (let j = k; j <= B; j++) {
        for (let i = k - 1; i < j; i++) {
          const c = cost(i, j);
          if (c > fit && j - i > 1) continue; // only a piece taller than the room may have a screen over it
          const v = best[k - 1][i] + c * c;
          if (v < best[k][j]) { best[k][j] = v; cut[k][j] = i; }
        }
      }
    }
    if (!Number.isFinite(best[n][B])) return keep ? [...keep, rest] : [rest];
    const screens = [];
    for (let k = n, j = B; k > 0; k--) {
      const i = cut[k][j];
      screens.unshift(blocks.slice(i, j).flatMap(b => b.kids));
      j = i;
    }
    return keep ? [...keep, ...screens] : screens;
  }
  /**
   * Styles still easing to new values, at their new values now: a measurement mid-change reads the old
   * ones (with reduced motion the site eases every change for an instant, so this is every change)
   */
  const settle = () => { for (const a of document.getAnimations()) if (a.transitionProperty) a.finish(); };
  /**
   * The service-area map takes the room its screen has left (never under 160px, 100px on a phone): a longer card above
   * or beside it (the Postal Service's word, a long note) means a smaller map, not a screen that scrolls
   */
  function fitMap() {
    const af = areaField();
    const fe = af && fieldEl(af.id);
    const place = fe?.closest('.af-place');
    if (!place) return;
    place.style.removeProperty('--af-map-h');
    const frame = fe.querySelector('.af-map-frame');
    if (!focused || !frame || !fe.getClientRects().length || fe.closest('[data-off], [hidden]')) return;
    const least = innerWidth <= 640 ? 100 : 160;
    place.removeAttribute('data-tight');
    place.removeAttribute('data-nomap');
    // The family asked whether the home is inside the area "shown on the map": the map stays
    const asked = ['unknown', 'error'].includes(fe.querySelector('[data-area]')?.dataset.area);
    const asItWas = () => { place.style.removeProperty('--af-map-h'); place.removeAttribute('data-tight'); place.removeAttribute('data-nomap'); settle(); };
    let before = Infinity;
    for (let i = 0; i < 6; i++) {
      settle();
      const over = document.documentElement.scrollHeight - innerHeight;
      const h = frame.getBoundingClientRect().height;
      if (over <= 0) return;
      // A smaller map left the screen as tall (it's beside the card, not under it): the map as it was
      if (over >= before) { asItWas(); return; }
      before = over;
      if (h <= least) {
        // Not even its smallest fits: the card says it all and the map steps aside (unless they're asked
        // about it, or its going leaves the screen as tall)
        if (asked) return;
        place.setAttribute('data-nomap', '');
        settle();
        if (document.documentElement.scrollHeight - innerHeight >= over) asItWas();
        return;
      }
      // Small enough that its key ("Our service area", "The home you entered") gives way to the map itself
      if (h - over < 150) place.setAttribute('data-tight', '');
      place.style.setProperty('--af-map-h', `${Math.max(least, Math.floor(h - over - 1))}px`);
    }
  }
  /** A page's choices as they are before fitting: every tile's words, a list in the columns its width gives it */
  function unfit(el) {
    for (const t of el?.querySelectorAll('.af-tile[data-clamp]') || []) { t.removeAttribute('data-clamp'); t.style.removeProperty('--lines'); }
    for (const s of el?.querySelectorAll('.af-choices--tiles[data-snug]') || []) s.removeAttribute('data-snug');
    for (const l of el?.querySelectorAll('.af-choices--cols[data-two]') || []) l.removeAttribute('data-two');
    for (const n of el?.querySelectorAll('.af-content[data-snug]') || []) n.removeAttribute('data-snug');
  }
  const onScreen = (el) => el.getClientRects().length && !el.closest('[data-off], [hidden]');
  const overflows = () => document.documentElement.scrollHeight > innerHeight;
  /**
   * Choices that each explain themselves, on a screen too short for all their words (a phone, a short
   * laptop with a problem note, a phone on its side): a little snugger first, then every tile says its
   * first lines (as many for each, as many as the screen has room for), the rest under its More
   */
  function fitTiles() {
    for (const s of pageEl(currentId)?.querySelectorAll('.af-choices--tiles') || []) {
      if (!focused || !onScreen(s)) continue;
      settle();
      if (!overflows()) continue;
      const tiles = [...s.querySelectorAll('.af-tile')].map((tile) => {
        const d = tile.querySelector('.af-choice-desc');
        return { tile, lines: d ? Math.round(d.getBoundingClientRect().height / (parseFloat(getComputedStyle(d).lineHeight) || 21)) : 0 };
      });
      // n lines each; a little snugger before a line goes
      const fits = (n, snug) => {
        for (const { tile, lines } of tiles) if (lines > n) { tile.dataset.clamp = n; tile.style.setProperty('--lines', n); }
        s.toggleAttribute('data-snug', snug);
        settle();
        return !overflows();
      };
      const most = Math.max(0, ...tiles.map(x => x.lines));
      if (fits(most, true)) continue;
      for (let n = most - 1; n >= 0; n--) if (fits(n, false) || fits(n, true)) break;
    }
  }
  /** A longer list of short answers too tall for a phone's screen in one column: two */
  function fitCols() {
    for (const l of pageEl(currentId)?.querySelectorAll('.af-choices--cols') || []) {
      if (!focused || !onScreen(l)) continue;
      settle();
      if (overflows()) l.setAttribute('data-two', '');
    }
  }
  /** Words that can't be cut between screens any further (cards side by side) and still don't fit: a little snugger */
  function fitNotes() {
    for (const n of pageEl(currentId)?.querySelectorAll('.af-content') || []) {
      if (!focused || !onScreen(n)) continue;
      settle();
      if (overflows()) n.setAttribute('data-snug', '');
    }
  }
  /** The screen fitted to its room: the tiles' words, a long list's columns, snugger words, then the map's size */
  function fitScreen() {
    unfit(pageEl(currentId));
    fitTiles();
    fitCols();
    fitNotes();
    fitMap();
    pageEl(currentId)?.querySelectorAll('textarea').forEach(capBox);
  }
  /** Show the current screen's pieces, the others waiting */
  function paintScreen() {
    const list = packs[currentId];
    const all = list ? list.flat() : pieces(currentId);
    const on = new Set(list ? list[screenNo] || [] : all);
    for (const k of all) k.toggleAttribute('data-off', !on.has(k));
    // A pair, the address apart from its map, the check's pieces, words cut across screens: whatever holds
    // pieces is off where none of them is on (an empty box would still take its gap)
    const page = pageEl(currentId);
    const holders = new Set();
    for (const k of all) for (let p = k.parentElement; p && p !== page; p = p.parentElement) if (!all.includes(p)) holders.add(p);
    for (const c of [...holders, ...((list && cutsOf[currentId]) || [])]) c.toggleAttribute('data-off', ![...on].some(k => c.contains(k)));
    fitScreen();
  }
  /** The questions on a screen of a page (the whole page before it's been worked out) */
  const screenFieldIds = (pid = currentId, n = screenNo) => new Set((packs[pid] ? packs[pid][n] || [] : pieces(pid)).flatMap(idsOf));
  function screenOf(pid, fid) {
    const el = fieldEl(fid);
    if (!el || !packs[pid]) return 0;
    const at = (test) => packs[pid].findIndex(kids => kids.some(test));
    let i = at(k => k === el || k.contains(el));
    // A question in pieces across screens (the check that asks): the screen with its answers
    if (i < 0) i = at(k => el.contains(k) && !!k.querySelector('input, select, textarea'));
    if (i < 0) i = at(k => el.contains(k));
    return Math.max(0, i);
  }
  /**
   * Where to pick up on a page: the first screen with a required answer still missing, from the
   * reading that leads into it (screens with only words on them, like Before You Begin's)
   */
  function openScreen(pid) {
    const list = packs[pid];
    if (!list) return 0;
    const a = readAnswers();
    const asks = (kids) => kids.flatMap(idsOf).some(id => isInput(byId[id] || {}) || isUpload(byId[id] || {}));
    let i = list.findIndex(kids => kids.flatMap(idsOf).some(id => {
      const f = byId[id];
      return f && f.required && (isInput(f) || isUpload(f)) && isVisible(f, a, byId) && !!fieldError(f, isUpload(f) ? files[id] : a[id], lang);
    }));
    if (i < 0) return 0;
    while (i > 0 && !asks(list[i - 1])) i--;
    return i;
  }

  /**
   * Put a page on screen, a screen of it: `screen` is a number, 'last', or 'open' (the first with a
   * required answer missing); `at` or `focusField` picks the screen holding that question. Going
   * forward it slides in from the right, going back from the left. Resolves once it's in the page.
   */
  function show(id, { dir = 0, screen = 0, step = 0, piece = null, at = null, focus = true, focusField = null, scroll = true } = {}) {
    if (!pageEl(id)) id = stepIds()[0];
    const pageChanged = id !== currentId;
    const update = () => {
      currentId = id;
      reach(id);
      if (id === 'review') fromReview = false;
      for (const [pid, el] of Object.entries(pageEls)) el.hidden = pid !== id;
      ui.review.hidden = id !== 'review';
      if (id === 'review') {
        screenNo = 0;
        buildReview();
      } else {
        let onto = -1;
        if (pageChanged || !packs[id]) {
          ui.stepTitle.textContent = titleOf(id); // measured with this step's own name above it
          packs[id] = pack(id);
        } else if (step > 0 && packs[id]) {
          // On: the screens still to come are worked out again (an answer can grow what follows, like
          // the service-area check's result), the ones they've seen kept as they were
          const kept = packs[id].slice(0, screenNo + 1);
          const fresh = pack(id, kept);
          if (fresh && fresh.length > kept.length) { packs[id] = fresh; onto = kept.length; }
        }
        if (piece && packs[id]) onto = packs[id].findIndex(kids => kids.some(k => k === piece || k.contains(piece) || piece.contains(k)));
        const n = screensIn(id);
        const want = onto >= 0 ? onto : at || focusField ? screenOf(id, at || focusField) : screen === 'last' ? n - 1 : screen === 'open' ? openScreen(id) : screen;
        screenNo = Math.max(0, Math.min(n - 1, Number(want) || 0));
        // Nothing on it (a follow-up their answer didn't call for): the next one on, or back, with something
        if (step > 0) while (screenNo < n - 1 && emptyScreen(id, screenNo)) screenNo++;
        if (step < 0 || screen === 'last') while (screenNo > 0 && emptyScreen(id, screenNo)) screenNo--;
        paintScreen();
      }
      if (pageEl(id)?.querySelector('.af-map-frame')) requestAnimationFrame(() => declutter(pageEl(id)));
      if (pageChanged || dir) {
        ui.steps.open = false;
        if (!lastNav?.reason) navNote(null);
        if (lastNotice?.kind === 'success') notice(null); // "Welcome back" has done its job once they move on
      }
      paintHeader();
      if (testRun) {
        paintTestBar();
        const note = (pageChanged || dir) && root.querySelector('[data-test-note]'); // "Filled in …" was about the last page
        if (note) note.textContent = '';
      }
      if (scroll && !focusField) scrollToForm(!!dir);
      growPage(id);
      fitScreen();
      requestAnimationFrame(fitScreen); // and once the screen has settled (its header, Back and Continue)
    };
    return swap(update, dir, !pageChanged).then(() => {
      if (focusField) focusOn(focusField);
      else if (focus) ui.stepTitle.focus({ preventScroll: true });
    });
  }

  async function next() {
    if (busy || moving || performance.now() < calmUntil) return;
    navNote(null);
    if (currentId === 'review') { submit(); return; }
    // An address check still on its way decides this page's answer: wait for it (briefly),
    // unless the address itself needs fixing first (then there's nothing to wait for)
    const home = homeAddressId() && byId[homeAddressId()];
    if (areaWaiting() && !(home && fieldError(home, homeAddressNow(), lang))) {
      setBusy(true);
      try { await Promise.race([flushArea(), wait(9000)]); } finally { setBusy(false); }
    }
    const a = readAnswers();
    // Only this screen's questions: the ones still to come get their own turn
    const here = screenFieldIds();
    const errors = Object.fromEntries(Object.entries(formErrors(form, a, files, [currentId], lang)).filter(([id]) => here.has(id)));
    // An address line searched but not chosen from, the check's question about the home: their own words
    for (const id of here) {
      const type = byId[id]?.type;
      if (type === 'address' || (type === 'area' && errors[id])) { const m = errorFor(id); if (m) errors[id] = m; }
    }
    if (Object.keys(errors).length) { showPageErrors(errors); return; }
    const last = !screenAhead();
    const stop = stopFor(form, a);
    // The address decides the service-area answer, so its screen stops too (a phone has the map on the next)
    const decides = stop && byId[stop.field]?.type === 'area' && here.has(homeAddressId());
    if (stop && stop.page === currentId && (here.has(stop.field) || decides || last)) { showStop(stop); return; }
    setBusy(true);
    try {
      if (!(await start())) return;
      if (fromReview === 'answer' || (fromReview && last)) await show('review', { dir: 1 });
      else if (!last) await show(currentId, { dir: 1, screen: screenNo + 1, step: 1 });
      else {
        const ids = stepIds(a);
        await show(ids[ids.indexOf(currentId) + 1] || 'review', { dir: 1 });
      }
      save();
    } finally {
      setBusy(false);
    }
  }
  /** A screen back (from a page's first, the last screen of the page before); false at the very start */
  function back() {
    if (moving || performance.now() < calmUntil) return true;
    navNote(null);
    const before = currentId === 'review' ? -1 : screenBefore();
    if (before >= 0) { show(currentId, { dir: -1, screen: before, step: -1 }).then(save); return true; }
    const ids = stepIds();
    const at = ids.indexOf(currentId);
    if (at <= 0) return false;
    show(ids[at - 1], { dir: -1, screen: 'last' }).then(save);
    return true;
  }
  /** Jump to a page already reached (the steps list, Edit, Answer it, Change) */
  function jump(id, { focusField = null, whole = true } = {}) {
    if (!reached(id) && !previewing) return;
    if (id === currentId && !focusField) { ui.steps.open = false; return; } // the step they're on: the list closes
    const dir = Math.sign(order(id) - order(currentId));
    if (dir > 0) {
      const stop = stopFor(form, readAnswers());
      if (stop && order(stop.page) < order(id)) { showStop(stop); return; }
    }
    if (currentId === 'review' && id !== 'review') fromReview = whole ? 'step' : 'answer';
    show(id, { dir, focusField, screen: 'open' }).then(save);
  }
  function setBusy(on) {
    busy = on;
    paintNav();
  }

  // ── Problems with answers (never red: soft yellow, deep gold) ─────
  function errorFor(id) {
    const f = byId[id];
    if (!f) return null;
    const a = readAnswers();
    if (!isVisible(f, a, byId)) return null;
    // Searched for but not picked (or not searched for yet): the parts are still empty
    if (f.type === 'area' && !a[id] && !fieldEl(id)?.querySelector('[data-area-ask]')?.hidden) return T('areaChoose');
    const box = f.type === 'address' ? addrBox(fieldEl(id)) : null;
    if (box?.dataset.mode === 'line' && !['line1', 'city', 'state', 'zip'].every(k => String(a[id]?.[k] || '').trim())
      && (f.required || box.querySelector('[data-search]').value.trim())) return T('addressPick');
    // Entered by hand with a part missing: which one (the generic words made them hunt for it)
    if (box?.dataset.mode === 'parts') {
      const missing = ['line1', 'city', 'state', 'zip'].filter(k => !String(a[id]?.[k] || '').trim());
      if (missing.length && (f.required || missing.length < 4)) {
        const names = missing.map(k => T(k === 'line1' ? 'street' : k));
        return T('addressMissing', { parts: names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} ${T('and')} ${names[names.length - 1]}` });
      }
    }
    return fieldError(f, isUpload(f) ? files[id] : a[id], lang);
  }
  function setFieldError(id, msg) {
    const el = fieldEl(id);
    if (msg) shown.add(id); else shown.delete(id);
    if (!el) return;
    const p = el.querySelector('.af-error');
    el.classList.toggle('af-field--error', !!msg);
    if (p && p.textContent !== (msg || '')) p.textContent = msg || '';
    el.querySelectorAll('input:not([type=file]), textarea, select').forEach(i => {
      if (msg) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid');
    });
  }
  function showPageErrors(errors) {
    for (const f of fields) if (f.page === currentId) setFieldError(f.id, errors[f.id] || null);
    const ids = Object.keys(errors);
    ids.forEach(id => touched.add(id));
    announce(ids.length === 1 ? T('attentionOne') : T('attentionMany', { n: ids.length }));
    refitScreen(fieldEl(ids[0]), ids); // the notes take room: their questions stay, the first one in front
    focusOn(ids[0]);
  }
  /** Scroll a question to just under the header and put the cursor in it */
  function focusOn(id) {
    const el = fieldEl(id);
    if (!el || el.hidden) return;
    // The service-area answer comes from the address until the family is asked: send them to the address
    if (byId[id]?.type === 'area' && el.querySelector('[data-area-ask]')?.hidden && homeAddressId()) { focusOn(homeAddressId()); return; }
    if (packs[currentId] && el.closest('[data-off]')) { screenNo = screenOf(currentId, id); paintScreen(); paintHeader(); }
    openTucked(el, { animate: false });
    el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    // An address entered by hand: the first part still empty (not the street they've already typed)
    const box = addrBox(el);
    const empty = box?.dataset.mode === 'parts' ? ['line1', 'city', 'zip'].map(k => box.querySelector(`[data-part="${k}"]`)).find(i => i && !i.value.trim()) : null;
    const target = empty || [...el.querySelectorAll('input:not([type=file]):not([type=radio]):not([type=checkbox]):not([disabled]), textarea, select')].find(x => x.getClientRects().length)
      || el.querySelector('input:checked') || el.querySelector('input[type=radio], input[type=checkbox]')
      || el.querySelector('[data-act="choose"]');
    target?.focus({ preventScroll: true });
  }
  /** While they fix an answer, the note goes as soon as it's right */
  function liveCheck(el) {
    const id = el?.dataset.field;
    if (!id) return;
    touched.add(id);
    if (shown.has(id) && !errorFor(id)) setFieldError(id, null);
  }
  function announce(text) {
    ui.live.textContent = '';
    setTimeout(() => { ui.live.textContent = text; }, 40);
  }

  // ── Notices ──────────────────────────────────────────────────────
  function notice(m, kind = 'info') {
    lastNotice = m ? { m, kind } : null;
    paintNotice();
  }
  function paintNotice() {
    ui.notice.textContent = lastNotice ? say(lastNotice.m) : '';
    ui.notice.dataset.kind = lastNotice?.kind || 'info';
    ui.notice.hidden = !lastNotice;
    if (lastNotice) refitScreen();
  }
  /** A note by the buttons, where the family is looking (reason = why Submit is off) */
  function navNote(m, reason = false) {
    lastNav = m ? { m, reason } : null;
    paintNavNote();
  }
  function paintNavNote() {
    ui.navNote.textContent = lastNav ? say(lastNav.m) : '';
    ui.navNote.hidden = !lastNav;
    if (lastNav) refitScreen();
  }
  function saveState(key) {
    lastSave = key;
    paintSaveState();
  }
  function paintSaveState() {
    for (const el of ui.saveStates) {
      const top = !!el.closest('[data-top]');
      const quiet = lastSave === 'unsaved' && top; // it saves on its own a moment later
      el.textContent = lastSave && !quiet ? T(top && lastSave === 'saved' ? 'savedShort' : lastSave) : '';
      el.dataset.kind = quiet ? '' : lastSave || '';
    }
  }

  // ── Server calls ─────────────────────────────────────────────────
  async function start() {
    if (previewing || token) return true; // a preview walks the pages and saves nothing
    if (testRun?.signIn) { navNote({ raw: TEST.signInNote }); return false; }
    if (turnstileSiteKey && !turnstileToken && !testRun) { navNote('turnstile'); return false; }
    let r;
    try { r = await api({ action: 'start', kind, year, lang, turnstileToken, website: ui.honeypot?.value || '', ...(testRun ? { test: true } : {}) }); } catch { r = { ok: false }; }
    if (r.code === 'staff-only') { testRun = { signIn: true }; paintTestBar(); }
    if (!r.ok) {
      // The quick check's own words here (the server's are English and name a different button)
      navNote(r.code === 'turnstile' ? 'turnstile' : r.error ? { raw: r.error } : 'startFail');
      if (r.code === 'turnstile') resetTurnstile();
      return false;
    }
    token = r.token;
    remember();
    paintNav();
    return true;
  }

  function save() {
    if (!token || previewing) return Promise.resolve(true);
    clearTimeout(dirtyTimer);
    saveState('saving');
    const ids = stepIds();
    const page = currentId === 'review' ? ids[ids.length - 2] : currentId;
    const body = { action: 'save', token, answers: readAnswers(), page, lang };
    saveChain = saveChain.then(async () => {
      try {
        const r = await api(body);
        if (r.ok) { saveState('saved'); return true; }
        if (r.code === 'no-draft') { expired(); return false; }
        saveState(r.status === 429 ? 'paused' : 'notSaved');
        return false;
      } catch {
        saveState('offline');
        return false;
      }
    });
    return saveChain;
  }
  function markDirty() {
    if (!token || previewing) return;
    saveState('unsaved');
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(save, 4000);
  }
  function expired() {
    store.clear();
    token = null;
    notice('expired', 'error');
  }

  // ── Stop screens ─────────────────────────────────────────────────
  function showStop(stop) {
    stopShown = stop;
    paintStop();
    ui.form.hidden = true;
    ui.stop.hidden = false;
    if (focused) window.scrollTo({ top: 0, behavior: 'auto' });
    else {
      const top = ui.stop.getBoundingClientRect().top;
      if (top < headerOffset()) window.scrollTo({ top: window.scrollY + top - headerOffset(), behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    enter(ui.stop, 0, 14, 320);
    paintTitle();
    ui.stopTitle.focus({ preventScroll: true });
    save();
  }
  /** The "outside" stop from the address check: the map shows where the home is, and the way back is the address */
  const stopFromArea = () => stopShown?.key === 'outside' && byId[stopShown.field]?.type === 'area';
  function paintStop() {
    const s = form.stops?.[stopShown.key] || {};
    ui.stopTitle.textContent = s.title || '';
    ui.stopBody.innerHTML = s.body || '';
    const placed = stopFromArea() ? areaPlaced() : null;
    if (placed) ui.stopMap.innerHTML = `<div class="af-map af-map--stop">${areaMapHtml(form.serviceArea, { ...placed }, mapWords(lang, true, kind))}</div>`;
    // An older stop screen with a picture: its words come from the image question showing the same picture
    else if (s.image) ui.stopMap.innerHTML = imageHtml(s.image, fields.find(f => f.type === 'image' && f.image === s.image)?.alt || '');
    else ui.stopMap.innerHTML = '';
    ui.stopMap.hidden = !ui.stopMap.innerHTML;
    requestAnimationFrame(() => declutter(ui.stopMap));
    const back = ui.stop.querySelector('[data-stop-back] [data-af-t]');
    back.dataset.afT = placed ? 'stopEditAddress' : 'stopBack';
    back.textContent = T(back.dataset.afT);
  }
  ui.stop.querySelector('[data-stop-back]').addEventListener('click', () => {
    const field = stopFromArea() && homeAddressId() ? homeAddressId() : stopShown?.field;
    stopShown = null;
    ui.stop.hidden = true;
    ui.form.hidden = false;
    show(currentId, { focusField: field && fieldEl(field) ? field : null, at: field && fieldEl(field) ? field : null });
  });

  // ── Review ───────────────────────────────────────────────────────
  function reviewText(f, item, a) {
    if (f.type === 'date') return dateText(a[f.id], lang);
    return item.text;
  }
  /** Blank, as the family would see it (a ticked-in state on its own isn't an address) */
  function unanswered(f, a) {
    if (isUpload(f)) return !files[f.id];
    const v = a[f.id];
    if (f.type === 'address') return !v || !['line1', 'city', 'zip'].some(k => String(v[k] || '').trim());
    return blank(v);
  }
  /**
   * Review: a row per step with its answers in a line (Plaid's list), opened to every answer with a
   * Change beside each. A step with something missing opens by itself, with Answer it.
   */
  const reviewOpen = new Set(); // steps opened by hand (kept through redraws)
  let reviewAll = false;
  const CHEV_SVG = '<svg class="af-review-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>';
  function setReviewOpen(sec, open) {
    if (!sec) return;
    sec.toggleAttribute('data-open', open);
    sec.querySelector('[data-review-toggle]')?.setAttribute('aria-expanded', String(open));
    const body = sec.querySelector('.af-review-body');
    if (body) body.hidden = !open;
    if (open) reviewOpen.add(sec.dataset.page); else reviewOpen.delete(sec.dataset.page);
  }
  function paintReviewAll() {
    if (!ui.reviewAll) return;
    ui.reviewAll.dataset.afT = reviewAll ? 'reviewCloseAll' : 'reviewOpenAll';
    ui.reviewAll.textContent = T(ui.reviewAll.dataset.afT);
    ui.reviewAll.setAttribute('aria-expanded', String(reviewAll));
  }
  function buildReview() {
    const a = readAnswers();
    const errors = formErrors(form, a, files, null, lang);
    const missing = Object.keys(errors).length;
    ui.reviewSummary.dataset.kind = missing ? 'missing' : 'ready';
    ui.reviewSummary.textContent = missing ? (missing === 1 ? T('reviewMissingOne') : T('reviewMissing', { n: missing })) : T('reviewReady');
    const answered = new Map(answerSections(form, a, files).flatMap(s => s.items).map(it => [it.id, it]));
    const sections = [];
    for (const pid of stepIds(a)) {
      const p = form.pages.find(x => x.id === pid);
      if (!p) continue;
      const rows = [];
      let needs = false;
      for (const pf of p.fields) {
        const f = byId[pf.id];
        if (!f || !(isInput(f) || isUpload(f)) || !isVisible(f, a, byId)) continue;
        const row = document.createElement('div');
        row.className = 'af-review-item';
        const dt = document.createElement('dt');
        dt.textContent = f.label || '';
        const dd = document.createElement('dd');
        let change = null;
        if (errors[f.id]) {
          needs = true;
          row.classList.add('af-review-missing');
          const note = document.createElement('span');
          note.textContent = unanswered(f, a) ? T('notAnswered') : errors[f.id];
          const fix = document.createElement('button');
          fix.type = 'button';
          fix.className = 'af-btn af-btn--ghost';
          fix.dataset.edit = f.id;
          fix.dataset.page = p.id;
          fix.textContent = T('fix');
          fix.setAttribute('aria-label', `${T('fix')}: ${f.label || ''}`);
          dd.append(note, fix);
        } else if (answered.has(f.id)) {
          const item = answered.get(f.id);
          if (item.upload) {
            const thumb = uploadUi[f.id]?.thumb;
            dd.className = 'af-review-thumb';
            if (thumb) { const img = document.createElement('img'); img.src = thumb; img.alt = ''; dd.append(img); }
            dd.append(document.createTextNode(f.type === 'video' ? T('videoUploaded') : T('photoAdded')));
          } else dd.textContent = reviewText(f, item, a);
          change = document.createElement('button');
          change.type = 'button';
          change.className = 'af-btn af-btn--link af-review-change';
          change.dataset.edit = f.id;
          change.dataset.page = p.id;
          change.textContent = T('change');
          change.setAttribute('aria-label', `${T('change')}: ${f.label || ''}`);
        } else continue;
        row.append(dt, dd);
        if (change) row.append(change);
        rows.push(row);
      }
      if (!rows.length) continue;
      const sec = document.createElement('section');
      sec.className = 'af-review-section';
      sec.dataset.page = p.id;
      if (needs) sec.dataset.missing = '1';
      const head = document.createElement('div');
      head.className = 'af-review-head';
      const h = document.createElement('h3');
      h.className = 'af-review-h';
      const tg = document.createElement('button');
      tg.type = 'button';
      tg.className = 'af-review-toggle';
      tg.dataset.reviewToggle = p.id;
      tg.setAttribute('aria-controls', `af-rv-${p.id}`);
      tg.innerHTML = `<span class="af-step-mark" aria-hidden="true">${needs ? '!' : CHECK_SVG}</span><span class="af-review-name"><span class="af-review-title"></span><span class="af-review-sum"></span></span>${CHEV_SVG}`;
      tg.querySelector('.af-review-title').textContent = p.title;
      tg.querySelector('.af-review-sum').textContent = needs ? T('reviewNeeds') : summaryOf(p.id, a) || T(rows.length === 1 ? 'reviewSectionOne' : 'reviewSection', { n: rows.length });
      h.append(tg);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'af-btn af-btn--link af-review-edit';
      edit.dataset.edit = '';
      edit.dataset.page = p.id;
      edit.innerHTML = `${PENCIL_SVG}<span></span>`;
      edit.querySelector('span').textContent = T('edit');
      edit.setAttribute('aria-label', T('editSection', { name: p.title }));
      head.append(h, edit);
      const body = document.createElement('div');
      body.className = 'af-review-body';
      body.id = `af-rv-${p.id}`;
      const dl = document.createElement('dl');
      dl.append(...rows);
      body.append(dl);
      sec.append(head, body);
      setReviewOpen(sec, needs || reviewAll || reviewOpen.has(p.id));
      sections.push(sec);
    }
    ui.reviewList.replaceChildren(...sections);
    paintReviewAll();
  }
  /** The first question on a page (where Edit puts the cursor) */
  const firstQuestion = (pid) => fields.find(f => f.page === pid && (isInput(f) || isUpload(f)) && !fieldEl(f.id)?.hidden)?.id || null;

  async function submit() {
    if (previewing) { navNote('previewSent'); return; }
    if (uploads.size) { navNote('waitUploads', true); return; }
    setBusy(true);
    try {
      await save();
      const r = await api({ action: 'submit', token });
      if (r.ok) { finished(); return; }
      if (r.code === 'no-draft') { expired(); return; }
      if (r.error === 'stopped' && r.stop) { showStop({ key: r.stop, page: stopFor(form, readAnswers())?.page }); return; }
      if (r.errors && Object.keys(r.errors).length) {
        const ids = Object.keys(r.errors);
        ids.forEach(id => touched.add(id));
        const page = pageOf(ids[0]);
        if (page) {
          fromReview = 'answer';
          show(page, { dir: -1, focusField: ids[0] });
          for (const id of ids) setFieldError(id, r.errors[id]);
        }
        notice('attention', 'error');
        return;
      }
      navNote(r.error ? { raw: r.error } : 'submitFail');
    } catch {
      navNote('offlineSubmit');
    } finally {
      setBusy(false);
    }
  }

  // ── The thank-you ────────────────────────────────────────────────
  function finished(already = false) {
    store.clear();
    closeRecorder();
    doneShown = { already, email: testRun?.by || readAnswers()[emailId] || answers[emailId] || '' };
    notice(null);
    ui.form.hidden = true;
    ui.stop.hidden = true;
    ui.done.hidden = false;
    root.classList.add('is-done'); // the steps beside the form have done their job
    paintDone();
    paintSegs(stepIds(), new Set());
    paintTitle();
    if (testRun?.by) startTrace();
    // The sun rises once (the styles keep it still under reduced motion)
    ui.done.classList.remove('is-in');
    void ui.done.offsetWidth;
    ui.done.classList.add('is-in');
    const top = focused ? 0 : ui.done.getBoundingClientRect().top + window.scrollY - headerOffset();
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    ui.done.querySelector('[data-done-title]').focus({ preventScroll: true });
  }
  function paintDone() {
    // Nothing left to save: the way out of the bar just closes it
    const out = ui.exit?.querySelector('[data-af-t]');
    if (out) { out.dataset.afT = 'close'; out.textContent = T('close'); }
    const line = ui.done.querySelector('[data-done-email]');
    line.textContent = doneShown.already ? T('doneAgain') : doneShown.email ? T('doneEmail', { email: doneShown.email }) : '';
  }

  // ── Uploads: the box's look ──────────────────────────────────────
  function setUpload(id, patch) {
    uploadUi[id] = { ...(uploadUi[id] || { state: 'empty' }), ...patch };
    paintUpload(id);
  }
  function paintUpload(id) {
    const el = fieldEl(id);
    const f = byId[id];
    if (!el || !f) return;
    const s = uploadUi[id] || { state: 'empty' };
    const video = f.type === 'video';
    const box = el.querySelector('.af-upload');
    box.dataset.state = s.state;
    let msg = s.msg;
    if (Array.isArray(msg) && msg[1] && 'name' in msg[1] && !msg[1].name) msg = [msg[0], { ...msg[1], name: T(video ? 'yourVideo' : 'yourPhoto') }];
    box.querySelector('.af-upload-status').textContent = msg ? say(msg) : T(video ? 'noVideo' : 'noPhoto');
    const done = s.state === 'done';
    box.querySelector('[data-act="remove"]').hidden = !done;
    box.querySelector('[data-act="choose"]').textContent = done
      ? T(video ? 'chooseOther' : 'replacePhoto')
      : T(video ? (canRecord() ? 'chooseVideoDesk' : 'chooseVideo') : 'choosePhoto');
    const preview = box.querySelector('.af-upload-preview');
    preview.style.backgroundImage = s.thumb ? `url("${s.thumb}")` : '';
    preview.toggleAttribute('data-thumb', !!s.thumb);
    const fill = box.querySelector('.af-ring-fill');
    if (fill) fill.style.strokeDashoffset = String(RING * (1 - Math.min(100, Math.max(0, s.pct || 0)) / 100));
    const pct = box.querySelector('.af-pct');
    if (pct) pct.textContent = s.state === 'busy' && s.pct != null ? `${s.pct}%` : '';
    const rec = box.querySelector('[data-act="record"]');
    if (rec) rec.hidden = !(canRecord() && s.state !== 'busy' && recorder?.id !== id);
  }
  function uploadsChanged() {
    paintNav();
    if (currentId === 'review') buildReview();
  }

  // ── Photos ───────────────────────────────────────────────────────
  async function toJpeg(file, max, quality) {
    let bmp = null;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
      try { bmp = await createImageBitmap(file); } catch { return null; }
    }
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return new Promise(r => canvas.toBlob(b => r(b), 'image/jpeg', quality));
  }
  /** POST with upload progress (fetch can't report it) */
  function postWithProgress(body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ ok: false }); } };
      xhr.onerror = () => reject(new Error(T('uploadFailed')));
      xhr.send(body);
    });
  }
  const isPhotoFile = (file) => /^image\//.test(file.type || '') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '');
  const isVideoFile = (file) => /^video\//.test(file.type || '') || /\.(mp4|mov|m4v|webm|avi|3gp|mkv)$/i.test(file.name || '');
  const failText = (e) => ({ raw: T('tryAgain', { msg: String(e?.message || T('uploadFailed')).replace(/[.!]\s*$/, '') }) });

  async function uploadPhoto(f, file) {
    if (!isPhotoFile(file)) { setUpload(f.id, { msg: 'notImage' }); return; }
    if (previewing) {
      files[f.id] = { key: true, name: file.name };
      const thumb = await toJpeg(file, THUMB_MAX, 0.72).catch(() => null);
      setUpload(f.id, { state: 'done', msg: ['previewFile', { name: file.name }], thumb: thumb ? URL.createObjectURL(thumb) : null });
      setFieldError(f.id, null);
      uploadsChanged();
      return;
    }
    if (!(await start())) return;
    uploads.add(f.id);
    touched.add(f.id);
    setFieldError(f.id, null);
    const before = { ...uploadUi[f.id] };
    setUpload(f.id, { state: 'busy', msg: 'gettingReady', pct: 0 });
    uploadsChanged();
    try {
      const main = await toJpeg(file, PHOTO_MAX, 0.86);
      const thumb = main ? await toJpeg(main, THUMB_MAX, 0.72) : null;
      const body = new FormData();
      body.append('action', 'photo');
      body.append('token', token);
      body.append('field', f.id);
      const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + (main ? '.jpg' : '');
      body.append('file', main || file, main ? name : file.name);
      if (thumb) body.append('thumb', thumb, 'thumb.jpg');
      setUpload(f.id, { msg: ['uploading', { pct: 0 }], thumb: thumb || main ? URL.createObjectURL(thumb || main) : null });
      const r = await postWithProgress(body, (p) => {
        const pct = Math.min(99, Math.round(p * 100));
        setUpload(f.id, { pct, msg: ['uploading', { pct }] });
      });
      if (!r.ok) throw new Error(r.error || T('uploadFailed'));
      files[f.id] = { key: true, name };
      setUpload(f.id, { state: 'done', msg: ['added', { name }], pct: null });
    } catch (e) {
      setUpload(f.id, files[f.id] ? { ...before, msg: failText(e), pct: null } : { state: 'empty', msg: failText(e), thumb: null, pct: null });
    } finally {
      uploads.delete(f.id);
      uploadsChanged();
    }
  }

  // ── Video ────────────────────────────────────────────────────────
  /** A still from the video for its box (null when the browser can't read it) */
  function videoThumb(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      let settled = false;
      const done = (out) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        v.removeAttribute('src');
        v.load();
        URL.revokeObjectURL(url);
        resolve(out);
      };
      const timer = setTimeout(() => done(null), 6000);
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 4); };
      v.onseeked = () => {
        try {
          const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
          const c = document.createElement('canvas');
          c.width = Math.round(v.videoWidth * scale) || 1;
          c.height = Math.round(v.videoHeight * scale) || 1;
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          c.toBlob(b => done(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.75);
        } catch { done(null); }
      };
      v.onerror = () => done(null);
      v.src = url;
    });
  }

  async function uploadVideo(f, file) {
    if (!isVideoFile(file)) { setUpload(f.id, { msg: 'notVideo' }); return; }
    if (!file.size) { setUpload(f.id, { msg: 'empty' }); return; }
    if (previewing) {
      files[f.id] = { uid: true, uploaded: true, name: file.name };
      setUpload(f.id, { state: 'done', msg: ['previewFile', { name: file.name }], thumb: null });
      setFieldError(f.id, null);
      videoThumb(file).then(thumb => { if (thumb) setUpload(f.id, { thumb }); });
      uploadsChanged();
      return;
    }
    if (!(await start())) return;
    touched.add(f.id);
    setFieldError(f.id, null);
    uploads.add(f.id);
    files[f.id] = { uid: true, uploaded: false, name: file.name };
    setUpload(f.id, { state: 'busy', msg: 'starting', pct: 0, thumb: null });
    uploadsChanged();
    videoThumb(file).then(thumb => { if (thumb && files[f.id]?.name === file.name) setUpload(f.id, { thumb }); });
    try {
      const r = await api({ action: 'video-url', token, size: file.size, name: file.name });
      if (!r.ok) throw new Error(r.error || T('uploadStartFail'));
      await new Promise((resolve, reject) => {
        const upload = new tus.Upload(file, {
          uploadUrl: r.uploadUrl,
          chunkSize: CHUNK,
          retryDelays: [0, 2000, 5000, 10000, 20000, 40000, 60000],
          metadata: { filename: file.name, filetype: file.type },
          storeFingerprintForResuming: false,
          onError: reject,
          onProgress(sent, total) {
            const pct = Math.floor((sent / total) * 100);
            setUpload(f.id, { pct, msg: ['uploadingPct', { pct }] });
          },
          onSuccess: resolve,
        });
        upload.start();
      });
      setUpload(f.id, { pct: 100, msg: 'finishing' });
      let uploaded = false;
      for (let i = 0; i < 20 && !uploaded; i++) {
        const done = await api({ action: 'video-done', token });
        if (done.code === 'video-error') throw new Error(done.error);
        uploaded = !!done.uploaded;
        if (!uploaded) await wait(1500);
      }
      if (!uploaded) throw new Error(T('videoGone'));
      files[f.id] = { uid: true, uploaded: true, name: file.name };
      setUpload(f.id, { state: 'done', msg: ['videoDone', { name: file.name }], pct: null });
    } catch (e) {
      delete files[f.id];
      setUpload(f.id, { state: 'empty', msg: failText(e), pct: null, thumb: null });
    } finally {
      uploads.delete(f.id);
      uploadsChanged();
    }
  }

  async function removeFile(f) {
    delete files[f.id];
    uploadUi[f.id] = { state: 'empty' };
    paintUpload(f.id);
    uploadsChanged();
    if (token && !previewing) await api({ action: 'remove-file', token, field: f.id }).catch(() => {});
  }
  function takeFile(f, file) {
    if (uploads.has(f.id)) return;
    if (f.type === 'video') uploadVideo(f, file); else uploadPhoto(f, file);
  }

  // ── Recording with the camera (computers only; phones' own picker records) ──
  let recorder = null; // { id, stream, rec, chunks, started, timer, type }
  function canRecord() {
    if (!finePointer() || typeof window.MediaRecorder !== 'function' || !navigator.mediaDevices?.getUserMedia) return false;
    // The site's Permissions-Policy may turn the camera off for this page; don't offer a button that can't work
    const policy = document.permissionsPolicy || document.featurePolicy;
    try { if (policy?.allowsFeature && !policy.allowsFeature('camera')) return false; } catch { /* unknown: offer it */ }
    return true;
  }
  const recTime = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  async function openRecorder(f) {
    closeRecorder();
    const el = fieldEl(f.id);
    const box = el.querySelector('.af-recorder');
    const time = box.querySelector('.af-recorder-time');
    const toggle = box.querySelector('[data-act="rec-toggle"]');
    box.hidden = false;
    delete box.dataset.rec;
    time.textContent = T('camStarting');
    toggle.disabled = true;
    toggle.textContent = T('recordStart');
    recorder = { id: f.id, stream: null, rec: null, chunks: [], started: 0, timer: null, type: '' };
    const mine = recorder;
    paintUpload(f.id);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: true });
    } catch {
      if (recorder === mine) { closeRecorder(); setUpload(f.id, { msg: 'camBlocked' }); }
      return;
    }
    if (recorder !== mine) { stream.getTracks().forEach(t => t.stop()); return; }
    recorder.stream = stream;
    const view = box.querySelector('.af-recorder-view');
    view.srcObject = stream;
    view.play().catch(() => {});
    time.textContent = T('camReady');
    toggle.disabled = false;
    box.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  function toggleRecording() {
    if (!recorder?.stream) return;
    const box = fieldEl(recorder.id)?.querySelector('.af-recorder');
    if (!box) return;
    const time = box.querySelector('.af-recorder-time');
    const toggle = box.querySelector('[data-act="rec-toggle"]');
    if (!recorder.rec) {
      const type = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find(t => MediaRecorder.isTypeSupported?.(t)) || '';
      const rec = new MediaRecorder(recorder.stream, type ? { mimeType: type } : undefined);
      recorder.rec = rec;
      recorder.type = (rec.mimeType || type || 'video/webm').split(';')[0];
      rec.ondataavailable = (e) => { if (e.data?.size) recorder?.chunks.push(e.data); };
      rec.start(1000);
      recorder.started = Date.now();
      box.dataset.rec = 'on';
      toggle.textContent = T('recordStop');
      const tick = () => {
        const ms = Date.now() - recorder.started;
        time.textContent = T('recording', { time: recTime(ms) });
        if (ms >= RECORD_MAX_MS) toggleRecording();
      };
      tick();
      recorder.timer = setInterval(tick, 250);
      return;
    }
    // Stop and use it: the same upload path as a chosen file
    const mine = recorder;
    toggle.disabled = true;
    clearInterval(mine.timer);
    mine.rec.onstop = () => {
      const ext = mine.type.includes('mp4') ? 'mp4' : 'webm';
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const file = new File(mine.chunks, `recording-${stamp}.${ext}`, { type: mine.type });
      closeRecorder();
      const f = byId[mine.id];
      if (f) uploadVideo(f, file);
    };
    mine.rec.stop();
  }
  function closeRecorder() {
    if (!recorder) return;
    const r = recorder;
    recorder = null;
    clearInterval(r.timer);
    try { if (r.rec && r.rec.state !== 'inactive') { r.rec.onstop = null; r.rec.stop(); } } catch { /* already stopped */ }
    r.stream?.getTracks().forEach(t => t.stop());
    const box = fieldEl(r.id)?.querySelector('.af-recorder');
    if (box) {
      box.hidden = true;
      delete box.dataset.rec;
      const view = box.querySelector('.af-recorder-view');
      if (view) view.srcObject = null;
    }
    paintUpload(r.id);
  }

  // ── The address: one line that finds it, or its parts typed in ────
  // The answer is always the parts (street, apartment, city, state, ZIP). Picking a suggestion fills
  // them and the line shows the whole address; typing it by hand shows the parts themselves.
  const addrBox = (el) => el?.querySelector('.af-address') || null;
  const addressLineOf = (v) => (v && v.line1 && v.city && v.zip ? `${v.line1}, ${v.city}, ${[v.state, v.zip].filter(Boolean).join(' ')}` : '');
  /** The line shows the address the parts hold; parts begun but not finished show themselves, to finish by hand */
  function syncAddressLine(el) {
    const box = addrBox(el);
    const f = byId[el?.dataset.field];
    if (!box || !f) return;
    const v = readField(f) || {};
    const line = addressLineOf(v);
    const search = box.querySelector('[data-search]');
    if (line) { search.value = line; box.dataset.picked = line; box.dataset.mode = 'line'; return; }
    delete box.dataset.picked;
    if (['line1', 'city', 'zip'].some(k => String(v[k] || '').trim())) box.dataset.mode = 'parts';
    else { search.value = ''; box.dataset.mode = 'line'; }
  }
  /** Typing in the line: an address picked before no longer stands (its parts empty), and suggestions for what's there */
  function addressTyped(el, input) {
    const box = addrBox(el);
    if (box?.dataset.picked && input.value !== box.dataset.picked) {
      delete box.dataset.picked;
      for (const k of ['line1', 'city', 'zip']) box.querySelector(`[data-part="${k}"]`).value = '';
      if (el.dataset.field === homeAddressId()) unfillCounty(); // its county (and the note saying so) with it
    }
    suggestFor(el, input);
  }
  /**
   * "Enter the address yourself" (what they'd typed becomes the street), or back to the search; `force`
   * when the parts are already showing (a pick that came without its ZIP), to finish them by hand
   */
  function setAddressMode(el, mode, { force = false } = {}) {
    const box = addrBox(el);
    if (!box || (box.dataset.mode === mode && !force)) return;
    closeSuggest();
    const search = box.querySelector('[data-search]');
    const line1 = box.querySelector('[data-part="line1"]');
    if (mode === 'parts' && !line1.value.trim() && !box.dataset.picked && search.value.trim()) line1.value = search.value.trim().slice(0, 160);
    box.dataset.mode = mode;
    if (mode === 'line') {
      const line = addressLineOf(readField(byId[el.dataset.field]) || {});
      if (line) { search.value = line; box.dataset.picked = line; } else {
        // Begun by hand but not finished: its street goes back in the line to search for, the rest let go
        if (line1.value.trim()) search.value = line1.value.trim();
        for (const k of ['line1', 'city', 'zip']) box.querySelector(`[data-part="${k}"]`).value = '';
        delete box.dataset.picked;
      }
    }
    liveCheck(el);
    refresh();
    markDirty();
    // Into the search, or the first part still empty
    const into = () => (mode === 'parts' ? ['line1', 'city', 'zip'].map(k => box.querySelector(`[data-part="${k}"]`)).find(i => !i.value.trim()) || line1 : search).focus({ preventScroll: true });
    // The parts take more room: work this page's screens out again if this one no longer fits
    settle();
    if (focused && currentId !== 'review' && document.documentElement.scrollHeight > innerHeight) {
      delete packs[currentId];
      show(currentId, { piece: el, focus: false, scroll: false }).then(into);
    } else into();
  }

  // ── Address suggestions (a combobox on the address line) ──────────
  const sug = { timer: 0, ctrl: null, items: [], active: -1, input: null, list: null, el: null, closing: 0 };
  const homeAddressId = () => (byId.address?.type === 'address' ? 'address' : fields.find(f => f.type === 'address')?.id);
  function suggestFor(el, input) {
    clearTimeout(sug.timer);
    const q = input.value.trim();
    if (q.length < 4 || !/\d/.test(q)) { closeSuggest(); return; }
    sug.timer = setTimeout(() => fetchSuggest(el, input, q), 250);
  }
  async function fetchSuggest(el, input, q) {
    sug.ctrl?.abort();
    const ctrl = new AbortController();
    sug.ctrl = ctrl;
    let items = [];
    let google = false;
    try {
      const res = await fetch(`${API}?address=${encodeURIComponent(q)}`, { signal: ctrl.signal });
      const data = await res.json();
      items = Array.isArray(data.results) ? data.results : Array.isArray(data.items) ? data.items : [];
      google = data.source === 'google';
    } catch { return; } // offline or the lookup is down: they keep typing as normal
    if (ctrl.signal.aborted || input.value.trim() !== q || document.activeElement !== input) return;
    openSuggest(el, input, items.filter(i => i?.line1).slice(0, 5), google);
  }
  function openSuggest(el, input, items, google = false) {
    // The address line's list ends with the way to enter it by hand (all it holds when nothing's found)
    const byHand = input.matches('[data-search]');
    if (!items.length && !byHand) { closeSuggest(); return; }
    const list = el.querySelector('.af-suggest');
    list.toggleAttribute('data-google', google); // Google's suggestions carry its credit (the styles add it)
    Object.assign(sug, { items, active: -1, input, list, el });
    list.replaceChildren(...items.map((it, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.i = String(i);
      const main = document.createElement('span');
      main.className = 'af-suggest-main';
      main.textContent = it.line1;
      const sub = document.createElement('span');
      sub.className = 'af-suggest-sub';
      sub.textContent = it.sub || [it.city, [it.state, it.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      li.append(main, sub);
      return li;
    }));
    if (byHand) {
      const li = document.createElement('li');
      li.id = `${list.id}-by-hand`;
      li.className = 'af-suggest-by-hand';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.byHand = '';
      li.textContent = T('addressNotListed');
      list.append(li);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
    placeSuggest();
  }
  /**
   * The list stays inside what can be seen (above a phone's keyboard, clear of the bars): under the
   * street box, or over it when there's more room there, never taller than the room it has
   */
  function placeSuggest() {
    const { list, input } = sug;
    if (!list || list.hidden || !input) return;
    list.classList.remove('is-up');
    list.style.maxHeight = '';
    const vv = window.visualViewport;
    const seenTop = Math.max(vv ? vv.offsetTop : 0, focused ? ui.top?.getBoundingClientRect().bottom || 0 : 0);
    const nav = focused ? ui.form.querySelector('[data-nav]')?.getBoundingClientRect().top : null;
    const seenBottom = Math.min(vv ? vv.offsetTop + vv.height : innerHeight, nav ?? Infinity);
    const r = input.getBoundingClientRect();
    const below = seenBottom - r.bottom - 10;
    const above = r.top - seenTop - 10;
    const need = list.scrollHeight;
    if (need > below && above > below) {
      list.classList.add('is-up');
      list.style.maxHeight = `${Math.max(140, Math.floor(above))}px`;
    } else list.style.maxHeight = `${Math.max(140, Math.floor(below))}px`;
  }
  function closeSuggest() {
    clearTimeout(sug.closing);
    if (sug.list) { sug.list.hidden = true; sug.list.replaceChildren(); }
    if (sug.input) { sug.input.setAttribute('aria-expanded', 'false'); sug.input.removeAttribute('aria-activedescendant'); }
    Object.assign(sug, { items: [], active: -1, list: null });
  }
  function moveActive(d) {
    const n = sug.list?.children.length || 0;
    if (!n) return;
    sug.active = sug.active < 0 ? (d > 0 ? 0 : n - 1) : (sug.active + d + n) % n;
    [...sug.list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sug.active)));
    const li = sug.list.children[sug.active];
    sug.input.setAttribute('aria-activedescendant', li.id);
    li.scrollIntoView({ block: 'nearest' });
  }
  /** A suggestion picked, or the way to enter the address by hand */
  function chooseOption(li) {
    if (!li) return;
    if (li.matches('[data-by-hand]')) { const el = sug.el; closeSuggest(); setAddressMode(el, 'parts'); return; }
    pickSuggestion(Number(li.dataset.i));
  }
  function pickSuggestion(i) {
    const it = sug.items[i];
    const el = sug.el;
    if (!it || !el) return;
    const set = (part, v) => {
      const input = el.querySelector(`[data-part="${part}"]`);
      if (!input || v == null || v === '') return;
      if (input.tagName === 'SELECT' && ![...input.options].some(o => o.value === v)) return;
      input.value = v;
    };
    const box = addrBox(el);
    const search = box?.querySelector('[data-search]');
    const done = (a) => {
      for (const k of ['line1', 'city', 'zip']) { const i = el.querySelector(`[data-part="${k}"]`); if (i) i.value = ''; }
      set('line1', a.line1);
      set('line2', a.line2);
      set('city', a.city);
      set('state', a.state);
      set('zip', a.zip);
      // The whole address in the line, or (a part missing) the parts, to finish by hand
      if (!box || addressLineOf(readField(byId[el.dataset.field]))) syncAddressLine(el);
      else { delete box.dataset.picked; setAddressMode(el, 'parts', { force: true }); }
      if (el.dataset.field === homeAddressId()) { fillCounty(a.county, el); scheduleArea(true); }
      liveCheck(el);
      refresh();
      markDirty();
    };
    const input = sug.input;
    closeSuggest();
    input?.focus({ preventScroll: true });
    if (!it.id) { done(it); return; }
    // A Google suggestion: the line shows it at once, its parts (with the ZIP) a moment later. If they
    // don't come, the parts show with what's known, to finish by hand
    if (search) { search.value = [it.line1, it.sub].filter(Boolean).join(', '); box.dataset.picked = search.value; }
    const [city, state] = String(it.sub || '').split(',').map(x => x.trim());
    const byHand = () => done({ line1: it.line1, city, state: /^[A-Z]{2}$/.test(state || '') ? state : undefined });
    fetch(`${API}?place=${encodeURIComponent(it.id)}`).then(r => r.json()).then((r) => { if (r?.address) done(r.address); else byHand(); }).catch(byHand);
  }
  /** The county question, set from the address when the county is one of its choices */
  function fillCounty(county, addressEl) {
    const name = String(county || '').trim().toLowerCase();
    if (!name) return;
    const choiceTypes = ['select', 'radio'];
    const f = (byId.county && (choiceTypes.includes(byId.county.type) || byId.county.type === 'text') ? byId.county : null)
      || fields.find(x => choiceTypes.includes(x.type) && x.options?.some(o => o.toLowerCase() === name));
    if (!f) return;
    const value = f.type === 'text' ? String(county).trim() : f.options.find(o => o.toLowerCase() === name);
    if (!value) { unfillCounty(); return; } // not a county we serve: the question is the family's (one we filled from the last address goes)
    writeField(f, value);
    liveCheck(fieldEl(f.id));
    countyNote = { field: f.id, value, label: f.optionLabels?.[value] || value, address: addressEl.dataset.field };
    showCountyNote();
  }
  function showCountyNote() {
    const note = fieldEl(countyNote.address)?.querySelector('.af-county-note');
    if (!note) return;
    note.textContent = T('countyFilled', { county: countyNote.label });
    note.hidden = false;
  }
  function hideCountyNote() {
    if (!countyNote) return;
    const note = fieldEl(countyNote.address)?.querySelector('.af-county-note');
    if (note) note.hidden = true;
    countyNote = null;
  }
  /** The county we filled in from an address that's no longer there: taken back (one the family chose stays) */
  function unfillCounty() {
    if (!countyNote) return;
    const f = byId[countyNote.field];
    if (f && readField(f) === countyNote.value) { writeField(f, ''); liveCheck(fieldEl(f.id)); }
    hideCountyNote();
  }

  // ── The service-area check (the home address, placed on the map) ──
  const area = { timer: 0, showTimer: 0, want: null, pending: null };
  const areaField = () => fields.find(f => f.type === 'area') || null;
  const homeAddressNow = () => { const id = homeAddressId(); return id && byId[id] ? readField(byId[id]) : null; };
  /** The check, if it placed the address now on screen: { ...check, answer } */
  function areaPlaced() {
    if (!areaNow || !AREA_VALUES[areaNow.band]) return null;
    return areaNow.key === addressKey(homeAddressNow()) ? { ...areaNow, answer: AREA_VALUES[areaNow.band] } : null;
  }
  /** A check is due or on its way for the address on screen */
  function areaWaiting() {
    const af = areaField();
    if (!af || pageOf(af.id) !== currentId) return false;
    const addr = homeAddressNow();
    return checkableAddress(addr) && areaNow?.key !== addressKey(addr);
  }
  async function flushArea() {
    const addr = homeAddressNow();
    const key = addressKey(addr);
    if (area.want === key && area.pending) return area.pending;
    clearTimeout(area.timer);
    return runArea(addr, key);
  }
  /** Check the address after a pause in typing (at once after picking a suggestion) */
  function scheduleArea(now = false) {
    if (!areaField()) return;
    const addr = homeAddressNow();
    const key = addressKey(addr);
    clearTimeout(area.timer);
    if (!checkableAddress(addr)) {
      area.want = null;
      if (areaNow) { areaNow = null; paintArea(); }
      return;
    }
    // Typed back to the address already checked: its result again (and nothing on its way may replace it)
    if (areaNow?.key === key) { area.want = null; clearTimeout(area.showTimer); paintArea(); return; }
    if (area.want === key) return;
    // The old result no longer describes what's typed
    if (areaNow) paintArea('checking');
    area.timer = setTimeout(() => runArea(addr, key), now ? 0 : 650);
  }
  /** The Postal Service's word on the home address, in what the check found: known, a unit number may be missing, or check it */
  async function runUsps(addr, key) {
    if (!uspsOn || !/^\d{5}/.test(String(addr?.zip || '').trim())) return;
    const q = new URLSearchParams({ usps: '1', ...Object.fromEntries(['line1', 'line2', 'city', 'state', 'zip'].map(k => [k, String(addr[k] || '')])) });
    let status = null;
    try { status = (await (await fetch(`${API}?${q}`)).json())?.usps || null; } catch { /* no word: nothing shows */ }
    if (addressKey(homeAddressNow()) !== key) return; // the address has changed since
    uspsNow = { key, status };
    paintArea();
  }
  /** Its line in the result card (Google's terms: the answer shows with its credit) */
  function uspsHtml(status = uspsNow && uspsNow.key === addressKey(homeAddressNow()) ? uspsNow.status : null) {
    const words = { confirmed: 'uspsConfirmed', unit: 'uspsUnit', check: 'uspsCheck' }[status];
    return words ? `<p class="af-usps" data-status="${status}"><span>${esc(T(words))}</span> <span class="af-usps-by" translate="no">Google Maps</span></p>` : '';
  }
  function runArea(addr, key) {
    runUsps(addr, key);
    area.want = key;
    clearTimeout(area.showTimer);
    area.showTimer = setTimeout(() => { if (area.want === key) paintArea('checking'); }, 180);
    area.pending = (async () => {
      let r;
      try { r = await api({ action: 'area', kind, ...(token && !previewing ? { token } : {}), address: addr }); } catch { r = { ok: false }; }
      if (area.want !== key) return; // a newer address is being checked
      clearTimeout(area.showTimer);
      area.want = null;
      area.pending = null;
      areaNow = r.ok && r.area ? { ...r.area, key } : { key, band: 'unknown', reason: 'error' };
      // The Census's county is the one JobTread should get: fill it unless the family picked one themselves
      if (areaNow.county && homeAddressId()) {
        const county = readAnswers().county;
        if (!county || countyNote) fillCounty(areaNow.county, fieldEl(homeAddressId()));
      } else if (r.ok) unfillCounty(); // placed nowhere: the county of an address before this one goes
      paintArea();
      const af = areaField();
      if (af) liveCheck(fieldEl(af.id));
      refresh();
      markDirty();
    })();
    return area.pending;
  }

  /** "123 MAIN ST, MARIETTA, GA, 30060" → "123 Main St, Marietta, GA 30060" */
  function prettyAddress(s) {
    const parts = String(s || '').split(/\s*,\s*/).filter(Boolean);
    if (parts.length < 3) return String(s || '');
    const word = (w) => (/^(N|S|E|W|NE|NW|SE|SW)$/i.test(w) ? w.toUpperCase() : w.replace(/^(\w)(.*)$/, (m, a, b) => a.toUpperCase() + b.toLowerCase()));
    const zip = /^\d{5}/.test(parts[parts.length - 1]) ? parts.pop() : '';
    const state = parts.pop().toUpperCase();
    return `${parts.map(p => p.split(/\s+/).map(word).join(' ')).join(', ')}, ${state}${zip ? ` ${zip}` : ''}`;
  }
  const milesText = (m) => (m == null ? '' : m >= 10 ? String(Math.round(m)) : String(Math.max(0.1, Math.round(m * 10) / 10)));
  const AREA_ICONS = {
    inside: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" class="af-area-i-fill"/><path d="M7 12.4l3.2 3.2L17 8.8" class="af-area-i-ink"/></svg>',
    near: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.2" class="af-area-i-ring"/><circle cx="12" cy="12" r="4" class="af-area-i-dot"/></svg>',
    far: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.2" class="af-area-i-ring"/><path d="M8 12h8M13 8.5l3.5 3.5-3.5 3.5" class="af-area-i-ink"/></svg>',
    ask: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.2" class="af-area-i-ring"/><path d="M12 7.2v6.2M12 16.6v.2" class="af-area-i-ink"/></svg>',
  };
  function areaResultHtml(st, af) {
    if (st === 'empty') return `<p class="af-area-prompt">${esc(T('areaPrompt'))}</p>`;
    if (st === 'checking') return `<p class="af-area-checking"><span class="af-area-spin" aria-hidden="true"></span>${esc(T('areaChecking'))}</p>`;
    if (st === 'unknown' || st === 'error') {
      // The Postal Service's word helps most here: a number that doesn't exist is often why
      return `<div class="af-area-card" data-band="ask">${AREA_ICONS.ask}<div class="af-area-text"><p class="af-area-title">${esc(T(st === 'unknown' ? 'areaUnknown' : 'areaError'))}</p><p class="af-area-desc">${esc(T(st === 'unknown' ? 'areaUnknownBody' : 'areaErrorBody'))}</p>${uspsHtml()}<button type="button" class="af-btn af-btn--link af-area-fix" data-act="area-fix">${esc(T('areaFix'))}</button></div></div>`;
    }
    const value = AREA_VALUES[st];
    const stopping = st === 'far' && af.stops?.[value] && form.stops?.[af.stops[value]];
    // Far out with Settings stopping them: what the stop screen will say; else the choice's own words
    const desc = stopping ? form.stops[af.stops[value]].body : `<p class="af-area-desc">${esc(String(af.descriptions?.[value] || '').replace(/\{miles\}/g, milesText(areaNow.miles)))}</p>`;
    const title = { inside: 'areaInside', near: 'areaNear', far: 'areaFar' }[st];
    const found = areaNow.matched
      ? `<p class="af-area-found">${esc(T(areaNow.county ? 'areaFoundCounty' : 'areaFound', { address: prettyAddress(areaNow.matched), county: areaNow.county || '' }))}</p>` : '';
    return `<div class="af-area-card" data-band="${st}">${AREA_ICONS[st]}<div class="af-area-text"><p class="af-area-title">${esc(T(title))}</p><div class="af-area-desc-wrap">${desc}</div>${found}${uspsHtml()}<button type="button" class="af-btn af-btn--link af-area-fix" data-act="area-fix">${esc(T('areaFix'))}</button></div></div>`;
  }
  /** Draw the check: map (with the home), what it found, and the question when it couldn't place the home */
  function paintArea(force = null) {
    const af = areaField();
    const el = af && fieldEl(af.id);
    if (!el) return;
    const box = el.querySelector('[data-area]');
    const placed = areaPlaced();
    const st = force || (placed ? placed.band
      : areaNow && areaNow.key === addressKey(homeAddressNow()) && areaNow.reason !== 'incomplete' ? (areaNow.reason === 'no-match' ? 'unknown' : 'error')
        : 'empty');
    const was = box.dataset.area;
    box.dataset.area = st;
    if (st !== 'checking') {
      const home = placed && placed.lat != null ? { lat: placed.lat, lng: placed.lng, miles: placed.miles, band: placed.band } : null;
      const mapEl = box.querySelector('[data-area-map]');
      const sig = JSON.stringify([home?.lat, home?.lng, lang, form.serviceArea?.polygon]);
      if (mapEl.dataset.sig !== sig) {
        mapEl.innerHTML = areaMapHtml(form.serviceArea, home, mapWords(lang, !!home, kind));
        mapEl.dataset.sig = sig;
        requestAnimationFrame(() => declutter(mapEl));
      }
    }
    const res = box.querySelector('[data-area-result]');
    const html = areaResultHtml(st, af);
    if (res.innerHTML !== html) {
      res.innerHTML = html;
      if (was && was !== st && st !== 'checking') enter(res.firstElementChild, 0, 6, 320);
    }
    const ask = box.querySelector('[data-area-ask]');
    const asking = st === 'unknown' || st === 'error';
    if (ask.hidden === asking) {
      ask.hidden = !asking;
      if (asking) enter(ask, 0, -6);
    }
    // Asked about the home now (or not any more): this page's screens worked out again where its pieces
    // changed (what it found, then the question with the map), keeping the screen they're on
    const pid = pageOf(af.id);
    if (focused && packs[pid] && packAsked[pid] !== asking && pid === currentId && !moving) {
      const piece = packs[pid][screenNo]?.find(k => k.getClientRects().length) || null;
      delete packs[pid];
      show(pid, { piece: piece && !piece.closest('[data-area]') ? piece : box.querySelector('[data-area-result]'), focus: false, scroll: false });
      return;
    }
    fitMap(); // the card may have grown or shrunk beside the map
  }

  // ── A staff test run (?test=1) ──────────────────────────────────
  // Staff words (the admin is English); the form itself stays in the family's language
  const TEST = {
    lead: (to) => (org
      ? `You're going through the real form as an organization. Every email comes to you at ${to}. Nothing reaches the team or a real organization: no Slack post, and the JobTread account it makes is marked TEST and archives itself.`
      : `You're going through the real form as a family. Every email comes to you at ${to}. Nothing reaches the team or a real family: no Slack post, and the JobTread account it makes is marked TEST and archives itself.`),
    signIn: 'Test runs are for SOARD staff. Sign in to the admin, then start the test run from Applications → Form.',
    signInNote: 'Sign in to the admin to start a test run.',
    fill: 'Fill this page with sample answers', filling: 'Filling in…',
    filled: (n) => (n ? `Filled in ${n} answer${n === 1 ? '' : 's'}. Change anything you like, then press Next.` : 'Everything on this page is already answered.'),
    noVideo: "This browser can't make a sample video. Choose or record any short video instead.",
  };
  const ui2 = {
    bar: root.querySelector('[data-testbar]'),
    barText: root.querySelector('[data-testbar-text]'),
    fill: root.querySelector('[data-test-fill]'),
    fillNote: root.querySelector('[data-test-note]'),
    signIn: root.querySelector('[data-test-signin]'),
    end: root.querySelector('[data-test-end]'),
    trace: root.querySelector('[data-trace]'),
  };
  function paintTestBar() {
    root.classList.toggle('is-test', !!testRun?.by);
    // Not signed in: only the bar (with the way to sign in) shows, never a form that can't start
    const signIn = !!testRun?.signIn;
    root.classList.toggle('is-signin', signIn);
    if (signIn) { root.hidden = false; ui.form.hidden = true; if (closedCard) closedCard.hidden = true; }
    if (!ui2.bar) return;
    ui2.bar.hidden = !testRun;
    if (!testRun) return;
    ui2.bar.dataset.state = testRun.by ? 'on' : 'sign-in';
    // After the first page it's one slim row (the badge, Fill, End): the words were read once
    ui2.bar.classList.toggle('is-compact', !!testRun.by && !!currentId && (currentId !== stepIds()[0] || screenNo > 0));
    ui2.barText.textContent = testRun.by ? TEST.lead(testRun.by) : TEST.signIn;
    ui2.fill.hidden = !testRun.by;
    ui2.signIn.hidden = !!testRun.by;
    if (ui2.end) ui2.end.hidden = !testRun.by;
    paintTitle();
  }
  ui2.end?.addEventListener('click', () => store.clear()); // the link goes back to the admin

  /** Sample answers for a test run, by question (anything else gets one by its type) */
  const sampleParent = { first: 'Jordan', last: 'Rivera' };
  function sampleFor(f) {
    const known = {
      childName: { first: 'Maya', last: 'Rivera' }, parentName: sampleParent, signature: `${sampleParent.first} ${sampleParent.last}`,
      birthdate: `${Number(year || new Date().getFullYear()) - 9}-04-12`, diagnosis: 'Cerebral palsy', referredBy: 'A friend from church',
      parentRelation: 'Mother', residesWith: 'Both parents', residingDuration: 'At least ten more years',
      diagnosisImpact: 'Maya uses a wheelchair and needs help with every transfer. Bath time takes two of us and a lot of lifting, and her room is too small to turn her chair around.',
      interests: 'Dinosaurs, the color purple, and anything with music. She loves Bluey and dancing in her chair.',
      otherChildren: 'Her younger brother has asthma.', equipment: 'A power wheelchair, a bath chair and a standing frame.',
      makeoverWhy: 'The bathroom. A roll-in shower would make bath time safe for her and for us.',
      positiveImpact: 'She could get ready on her own more often, and we could stop lifting her over the tub.',
    };
    // An organization's test run: a school, with its own answers
    const knownOrg = {
      orgName: 'TEST Sunnyside Academy', contactName: sampleParent, contactTitle: 'Director', website: 'https://example.org',
      mission: 'We teach children with autism and other developmental differences, ages 3 to 12.', childrenServed: '120', agesServed: '3 to 12',
      needsServed: 'Most of our students have autism; some have Down syndrome or cerebral palsy.', childrenUsing: '40',
      spaceToday: 'An empty classroom with fluorescent lights and worn carpet. It is too loud and bright for most of our students.',
      spaceDream: 'A calm sensory room would give students a place to regulate, so they can get back to learning.',
    };
    if (org && f.id in knownOrg) return knownOrg[f.id];
    if (f.id in known) return known[f.id];
    const choose = (want) => f.options.find(o => o === want) ?? null;
    switch (f.type) {
      case 'name': return sampleParent;
      // SOARD's own office: a real address inside the service area, so the map check runs for real
      case 'address': return { line1: '250 Hembree Park Drive', line2: 'Suite 106', city: 'Roswell', state: 'GA', zip: '30076' };
      case 'email': return testRun.by;
      case 'phone': return '(404) 555-0100';
      case 'date': return `${Number(year || new Date().getFullYear()) - 9}-04-12`;
      case 'number': return '3';
      case 'signature': return `${sampleParent.first} ${sampleParent.last}`;
      case 'textarea': return 'A sample answer from a staff test run.';
      case 'text': return 'Sample answer';
      case 'ack': return f.options[0];
      case 'select': return choose('Fulton') ?? choose('English') ?? f.options[0];
      case 'checkbox': return f.options.slice(0, Math.min(2, f.max || 2));
      case 'radio': {
        const prefer = { resides50: 'Yes', previouslyApplied: 'No', verbal: 'Yes', ambulatory: 'No', sensory: 'No', destructive: 'No', permits: 'No', conviction: 'No', gender: 'Female' }[f.id];
        const order = [prefer, ...f.options].filter(o => o != null && f.options.includes(o));
        // Never an answer that ends the application here (renting, outside the area)
        return order.find(o => { const st = stopFor(form, { ...readAnswers(), [f.id]: o }); return !st || st.page !== currentId; }) ?? f.options[0];
      }
      default: return null;
    }
  }

  /** A sample photo made here (a JPEG): the brand's sun on cream, named for the question */
  async function samplePhoto(f) {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 900;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 1200, 900);
    bg.addColorStop(0, '#FFF8DE'); bg.addColorStop(1, '#F3EEE0');
    g.fillStyle = bg; g.fillRect(0, 0, 1200, 900);
    g.fillStyle = '#FFDA24'; g.beginPath(); g.arc(600, 380, 150, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#E6C400'; g.lineWidth = 16; g.lineCap = 'round';
    for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; g.beginPath(); g.moveTo(600 + Math.cos(a) * 200, 380 + Math.sin(a) * 200); g.lineTo(600 + Math.cos(a) * 250, 380 + Math.sin(a) * 250); g.stroke(); }
    g.fillStyle = '#373A36'; g.textAlign = 'center';
    g.font = '700 54px system-ui, sans-serif'; g.fillText('Sample photo', 600, 720);
    g.font = '500 32px system-ui, sans-serif'; g.fillText(`Staff test run · ${String(f.label || '').slice(0, 60)}`, 600, 780);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
    return blob ? new File([blob], `sample-${f.id}.jpg`, { type: 'image/jpeg' }) : null;
  }
  /** A three-second sample video made here (a moving sun), where the browser can record a canvas */
  async function sampleVideo() {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    if (!c.captureStream || typeof MediaRecorder === 'undefined') return null;
    const type = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported?.(t));
    if (!type) return null;
    const g = c.getContext('2d');
    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: type });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    const t0 = performance.now();
    let frame = 0;
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      g.fillStyle = '#FFF8DE'; g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#FFDA24'; g.beginPath(); g.arc(120 + t * 130, 200 - Math.sin(t * 1.4) * 60, 60, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#373A36'; g.font = '700 30px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText('Sample video · staff test run', 320, 320);
      frame = requestAnimationFrame(draw);
    };
    draw();
    rec.start(250);
    await wait(3000);
    rec.stop();
    await stopped;
    cancelAnimationFrame(frame);
    stream.getTracks().forEach(tr => tr.stop());
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    return blob.size ? new File([blob], `sample-video.${type.startsWith('video/mp4') ? 'mp4' : 'webm'}`, { type: blob.type }) : null;
  }

  /** "Fill this page with sample answers": every question showing and still blank on this page */
  async function fillWithSamples() {
    if (!testRun?.by || busy || currentId === 'review') return;
    ui2.fill.disabled = true;
    ui2.fill.setAttribute('aria-busy', 'true');
    const label = ui2.fill.querySelector('span');
    label.textContent = TEST.filling;
    ui2.fillNote.textContent = '';
    let n = 0;
    let note = '';
    const taken = new Set(); // an upload starts a moment after it's handed over: never hand one over twice
    try {
      // Twice: an answer can bring up a follow-up question
      for (let pass = 0; pass < 2; pass++) {
        for (const f of fields) {
          if (f.page !== currentId || !(isInput(f) || isUpload(f))) continue;
          const el = fieldEl(f.id);
          if (!el || el.hidden || el.closest('[hidden]')) continue;
          if (isUpload(f)) {
            if (files[f.id] || uploads.has(f.id) || taken.has(f.id)) continue;
            taken.add(f.id);
            const file = f.type === 'video' ? await sampleVideo() : await samplePhoto(f);
            if (!file) { if (f.type === 'video') note = TEST.noVideo; continue; }
            takeFile(f, file);
            n++;
            continue;
          }
          if (f.type === 'area') continue; // the address answers it (or it's asked below)
          if (!unanswered(f, readAnswers())) continue;
          const v = sampleFor(f);
          if (v == null) continue;
          writeField(f, v);
          touched.add(f.id);
          setFieldError(f.id, null);
          n++;
          refresh({ animate: false });
        }
      }
      const home = homeAddressId();
      if (home && pageOf(home) === currentId) {
        hideCountyNote();
        scheduleArea(true);
        await Promise.race([flushArea(), wait(9000)]);
        // The map couldn't place it: answer the question it asks instead
        const af = areaField();
        const ask = af && fieldEl(af.id)?.querySelector('[data-area-ask]');
        if (ask && !ask.hidden && !ask.querySelector('input:checked')) { ask.querySelector('input')?.click(); n++; }
      }
      fields.filter(f => f.type === 'textarea' && f.page === currentId).forEach(f => grow(fieldEl(f.id)?.querySelector('textarea')));
      refresh();
      markDirty();
    } finally {
      ui2.fill.disabled = false;
      ui2.fill.removeAttribute('aria-busy');
      label.textContent = TEST.fill;
    }
    const said = note || TEST.filled(n);
    ui2.fillNote.textContent = said;
    announce(said);
  }
  ui2.fill?.addEventListener('click', fillWithSamples);

  /**
   * After a test run's Submit: what the real intake does with it, step by step, as it happens
   * (/api/apply test-status, which nudges a due retry along). Checked every few seconds until
   * the account has archived itself, or for 20 minutes.
   */
  // Named so they read right done, under way or stuck
  const TRACE = [
    { key: 'saved', title: 'Saved on the site', done: () => true },
    { key: 'account', title: (st) => `JobTread account: ${st.name || 'TEST'}`, done: (st) => st.steps.account },
    { key: 'people', title: org ? 'Contacts and address, in JobTread' : 'Parents and home, in JobTread', done: (st) => st.steps.contacts && st.steps.home },
    { key: 'files', title: 'Application PDF and photos, in JobTread', done: (st) => st.steps.pdf && st.steps.photos },
    { key: 'welcome', title: (st) => `${org ? 'The welcome email' : "The family's welcome email"} with the PDF copy, to ${st.to}`, done: (st) => st.steps.familyMessage === true },
    // An organization has no diagnosis, so no medical note
    ...(org ? [] : [{ key: 'medical', title: 'Medical note for the team', done: (st) => st.steps.medicalNote === true || /^skipped/.test(String(st.steps.medicalNote)) }]),
    { key: 'staff', title: (st) => `Staff heads-up, to ${st.to}${st.steps.staffSlack === true ? ' and in Slack' : ''}`, done: (st) => st.steps.staffEmail },
    // An organization's application has no video
    ...(org ? [] : [{ key: 'video', title: 'Video, in JobTread', done: (st) => st.steps.video === true || st.steps.video === 'none', wait: (st) => st.steps.video === 'waiting' && 'Waiting for the video to finish processing' }]),
    { key: 'archived', title: 'Archived in JobTread (the test cleans itself up)', done: (st) => st.steps.archived },
  ];
  const ICON = {
    done: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" class="af-tr-fill"/><path d="M6 10.4l2.6 2.6L14 7.6" class="af-tr-ink" pathLength="1"/></svg>',
    work: '<span class="af-tr-spin" aria-hidden="true"></span>',
    wait: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" class="af-tr-ring"/><path d="M10 5.6V10l2.8 1.8" class="af-tr-ink"/></svg>',
    todo: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" class="af-tr-ring af-tr-ring--todo"/></svg>',
    error: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" class="af-tr-ring af-tr-ring--attn"/><path d="M10 5.8v5.2M10 14v.1" class="af-tr-ink af-tr-ink--attn"/></svg>',
  };
  const trace = { timer: 0, started: 0, last: null };
  function paintTrace(st) {
    const el = ui2.trace;
    const list = el.querySelector('[data-trace-list]');
    el.querySelector('[data-trace-lead]').textContent = `Every step below happens in the real system, in the order it runs. Emails go to ${st.to || testRun.by}; the team's Slack stays quiet, and no real family hears a thing.`;
    let current = false;
    const rows = TRACE.map((step) => {
      const title = typeof step.title === 'function' ? step.title(st) : step.title;
      const done = step.key === 'saved' || (st.submitted && step.done(st));
      const waiting = !done && st.submitted && step.wait?.(st);
      let state = done ? 'done' : 'todo';
      if (!done && !current) {
        current = true;
        state = st.error ? 'error' : waiting ? 'wait' : 'work';
      }
      return { key: step.key, title, state, note: state === 'wait' ? waiting : '' };
    });
    // Updated in place, so a step that just finished draws its check once
    if (list.children.length !== rows.length) {
      list.replaceChildren(...rows.map((r) => {
        const li = document.createElement('li');
        li.className = 'af-tr-step';
        li.dataset.key = r.key;
        li.innerHTML = '<span class="af-tr-icon"></span><span class="af-tr-text"><span class="af-tr-title"></span><span class="af-tr-note"></span></span>';
        return li;
      }));
    }
    rows.forEach((r, i) => {
      const li = list.children[i];
      if (li.dataset.state !== r.state) { li.dataset.state = r.state; li.querySelector('.af-tr-icon').innerHTML = ICON[r.state]; }
      li.querySelector('.af-tr-title').textContent = r.title;
      li.querySelector('.af-tr-note').textContent = r.note || '';
    });
    const err = el.querySelector('[data-trace-error]');
    err.hidden = !st.error;
    err.textContent = st.error ? `Stopped at: ${st.error}. It tries again on its own; this page keeps watching.` : '';
    const admin = el.querySelector('[data-trace-admin]');
    if (st.adminUrl) admin.href = st.adminUrl;
    const jt = el.querySelector('[data-trace-jt]');
    jt.hidden = !st.jobtreadUrl;
    if (st.jobtreadUrl) jt.href = st.jobtreadUrl;
    const doneAll = rows.every(r => r.state === 'done');
    el.dataset.complete = doneAll ? '1' : '';
    const sum = el.querySelector('[data-trace-sum]');
    const n = rows.filter(r => r.state === 'done').length;
    const said = doneAll ? `All ${rows.length} steps done` : `${n} of ${rows.length} steps done`;
    if (sum.textContent !== said) { sum.textContent = said; if (doneAll) announce('The test run went all the way through.'); }
    return doneAll;
  }
  async function pollTrace() {
    clearTimeout(trace.timer);
    if (!token || ui2.trace.hidden) return;
    let st = null;
    try { st = await api({ action: 'test-status', token }); } catch { st = null; }
    if (st?.ok) trace.last = st;
    const finished = trace.last ? paintTrace(trace.last) : false;
    const age = Date.now() - trace.started;
    if (finished || age > 20 * 60 * 1000) return;
    trace.timer = setTimeout(pollTrace, age < 2 * 60 * 1000 ? 3000 : 8000);
  }
  function startTrace() {
    if (!ui2.trace) return;
    ui2.trace.hidden = false;
    trace.started = Date.now();
    paintTrace({ submitted: false, to: testRun.by, steps: {} });
    pollTrace();
  }
  document.addEventListener('astro:before-swap', () => clearTimeout(trace.timer), { once: true });

  // ── Optional questions behind a button (application-render.js TUCKED) ──
  /** Open the group a question sits in (an answer to show, a problem to fix, the editor pointing at it) */
  function openTucked(el, { animate = true, focus = false } = {}) {
    const box = el?.closest?.('[data-more]');
    if (!box) return;
    const body = box.querySelector('.af-more-body');
    const btn = box.querySelector('[data-more-open]');
    if (!body.hidden) return;
    body.hidden = false;
    btn.hidden = true;
    btn.setAttribute('aria-expanded', 'true');
    body.querySelectorAll('textarea').forEach(grow);
    if (animate) enter(body, 0, -8);
    if (focus) body.querySelector('input, select, textarea')?.focus();
  }
  function closeTucked(box) {
    const ids = [...box.querySelectorAll('[data-field]')].map(el => el.dataset.field);
    for (const id of ids) {
      const f = byId[id];
      if (!f) continue;
      const parts = fieldEl(id).querySelectorAll('[data-part]');
      if (parts.length) parts.forEach(i => { i.value = ''; });
      else writeField(f, '');
      setFieldError(id, null);
      touched.delete(id);
      answers[id] = readField(f);
    }
    box.querySelectorAll('[data-mailfix]').forEach(p => { p.hidden = true; p.textContent = ''; });
    const body = box.querySelector('.af-more-body');
    const btn = box.querySelector('[data-more-open]');
    body.hidden = true;
    btn.hidden = false;
    btn.setAttribute('aria-expanded', 'false');
    btn.focus();
    refresh();
    markDirty();
  }
  /** After a redraw: a group with an answer in it stays open */
  function openAnsweredTucked() {
    ui.pages.querySelectorAll('[data-more]').forEach(box => {
      const has = [...box.querySelectorAll('[data-field]')].some(el => { const f = byId[el.dataset.field]; return f && !unanswered(f, answers); });
      if (has) openTucked(box.querySelector('[data-field]'), { animate: false });
    });
  }

  // ── Small helps while typing ─────────────────────────────────────
  /** A long answer box grows with what's in it (the page's styles do this where the browser can) */
  const sizesItself = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');
  function grow(ta) {
    if (sizesItself || !ta || ta.offsetParent === null) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 3, Math.round(innerHeight * 0.6))}px`;
  }
  const growPage = (id) => pageEl(id)?.querySelectorAll('textarea').forEach(grow);
  /** …until the screen is full: a longer answer then scrolls inside its box, and the screen never does */
  function capBox(ta) {
    if (!ta) return;
    ta.style.removeProperty('max-height');
    if (!focused || !ta.getClientRects().length || ta.closest('[data-off], [hidden]')) return;
    settle();
    const over = document.documentElement.scrollHeight - innerHeight;
    if (over > 0) ta.style.maxHeight = `${Math.max(parseFloat(getComputedStyle(ta).minHeight) || 80, Math.floor(ta.getBoundingClientRect().height - over))}px`;
  }

  /** A US number reads as (404) 555-0123 as it's typed (only while typing at the end, never while deleting) */
  function phoneShape(v, whole) {
    if (/^\s*\+/.test(v) && !/^\s*\+1/.test(v)) return v; // another country's number: as typed
    let d = v.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length > 10) return v;
    if (whole) return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : v;
    if (d.length < 4) return v;
    return d.length < 7 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }

  /** "jordan@gmial.com" → "jordan@gmail.com": the big email services, a letter or two off, or a .con */
  const MAIL_HOSTS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'comcast.net', 'att.net', 'bellsouth.net', 'live.com', 'msn.com', 'me.com', 'ymail.com', 'sbcglobal.net', 'verizon.net', 'charter.net', 'protonmail.com', 'mac.com', 'yahoo.com.mx', 'hotmail.es', 'outlook.es', 'yahoo.es'];
  function editDistance(a, b) { // with a swap of two letters counting as one
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }
  function mailFix(v) {
    const m = /^([^\s@]+)@([^\s@]+)$/.exec(String(v || '').trim());
    if (!m) return null;
    const host = m[2].toLowerCase();
    if (MAIL_HOSTS.includes(host)) return null;
    let best = null;
    let bestD = Infinity;
    for (const h of MAIL_HOSTS) {
      const dist = editDistance(host, h);
      if (dist < bestD) { bestD = dist; best = h; }
    }
    const allowed = best && best.length <= 7 ? 1 : 2;
    if (best && bestD > 0 && bestD <= allowed) return `${m[1]}@${best}`;
    const tld = host.replace(/\.(con|cmo|cpm|vom|xom|comm|coom)$/, '.com');
    return tld !== host ? `${m[1]}@${tld}` : null;
  }
  function paintMailFix(input) {
    const p = input.closest('[data-field]')?.querySelector('[data-mailfix]');
    if (!p) return;
    const fix = mailFix(input.value);
    p.hidden = !fix;
    p.replaceChildren();
    if (!fix) return;
    const [before, after] = T('mailFix').split('{email}');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mailfixUse = fix;
    b.textContent = fix;
    b.setAttribute('aria-label', T('mailFixUse', { email: fix }));
    p.append(before || '', b, after || '');
  }

  // A tap on the dimmed page around a dialog closes it (one on the dialog's own padding doesn't)
  const tappedOutside = (d, e) => {
    if (e.target !== d) return false;
    const r = d.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };

  // ── Save and finish later ────────────────────────────────────────
  const dlg = ui.dialog;
  const openLater = () => {
    if (previewing) { notice('previewNoSave', 'info'); return; }
    const email = testRun?.by || readAnswers()[emailId];
    const input = dlg.querySelector('input[type=email]');
    if (email && (!input.value || testRun?.by)) input.value = email;
    input.readOnly = !!testRun?.by; // a test run's link only ever goes to the person running it
    dlg.querySelector('[data-later-status]').textContent = '';
    dlg.querySelector('[data-later-form]').hidden = false;
    dlg.querySelector('[data-later-sent]').hidden = true;
    dlg.showModal();
  };
  ui.saveLaters.forEach(b => b.addEventListener('click', openLater));
  dlg.querySelector('[data-later-close]').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-later-done]').forEach(b => b.addEventListener('click', () => dlg.close()));
  dlg.addEventListener('click', (e) => { if (tappedOutside(dlg, e)) dlg.close(); });
  dlg.querySelector('[data-later-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = dlg.querySelector('[data-later-status]');
    const email = dlg.querySelector('input[type=email]').value.trim();
    const btn = dlg.querySelector('[data-later-form] button[type=submit]');
    btn.disabled = true;
    status.textContent = T('sending');
    try {
      if (!(await start())) { status.textContent = say(lastNav?.m) || T('startFail'); return; }
      await save();
      const r = await api({ action: 'email-link', token, email, lang });
      if (!r.ok) { status.textContent = r.error || T('sendFail'); return; }
      laterEmail = email;
      dlg.querySelector('[data-later-email]').textContent = email;
      dlg.querySelector('[data-later-form]').hidden = true;
      dlg.querySelector('[data-later-sent]').hidden = false;
      dlg.querySelector('[data-later-done]').focus();
    } catch {
      status.textContent = T('sendFail');
    } finally {
      btn.disabled = false;
    }
  });

  // ── A choice's whole description (More, when a phone shows only part of it) ──
  const detail = ui.detail;
  let detailFor = null; // the box of the choice it's about
  function paintDetail() {
    const on = detailFor.checked;
    const full = !on && detailFor.disabled; // two chosen already
    const pick = detail.querySelector('[data-detail-pick]');
    detail.querySelector('[data-detail-tag]').hidden = !on;
    pick.textContent = T(on ? 'detailRemove' : 'detailChoose');
    pick.classList.toggle('af-btn--primary', !on);
    pick.classList.toggle('af-btn--ghost', on);
    pick.disabled = full;
    detail.querySelector('[data-detail-status]').textContent = full ? T('detailFull', { n: byId[detailFor.name.replace(/^af-/, '')]?.max || 2 }) : '';
  }
  root.addEventListener('click', (e) => {
    const choice = detail && e.target.closest('[data-tile-more]')?.closest('.af-tile')?.querySelector('.af-choice');
    if (!choice) return;
    detailFor = choice.querySelector('input');
    detail.querySelector('[data-detail-title]').textContent = choice.querySelector('.af-choice-title')?.textContent || '';
    detail.querySelector('[data-detail-text]').textContent = choice.querySelector('.af-choice-desc')?.textContent || '';
    paintDetail();
    detail.showModal();
    detail.querySelector('[data-detail-title]').focus(); // its name read first (and no ring on Close)
  });
  detail?.querySelector('[data-detail-pick]').addEventListener('click', () => {
    if (!detailFor || (detailFor.disabled && !detailFor.checked)) return;
    detail.close();
    detailFor.click(); // as a tap on its box (after the sheet's gone, so the check is seen drawing in): the limit, the save, the rest follow
  });
  detail?.querySelector('[data-detail-close]').addEventListener('click', () => detail.close());
  detail?.addEventListener('click', (e) => { if (tappedOutside(detail, e)) detail.close(); });

  // ── Language ─────────────────────────────────────────────────────
  function setLang(l, { remember: keep = true, persist = true } = {}) {
    if (l === lang || !(form.languages || []).includes(l)) return;
    const anchor = currentId !== 'review' ? [...screenFieldIds()][0] : null;
    lang = l;
    if (keep) langPref.set(l);
    draw();
    applyWords();
    show(currentId, { focus: false, scroll: false, at: anchor && fieldEl(anchor) ? anchor : null });
    if (!reducedMotion()) [ui.form, ui.stop, ui.done].forEach(el => !el.hidden && el.animate?.([{ opacity: 0.4 }, { opacity: 1 }], { duration: 220, easing: EASE }));
    if (persist) save();
  }
  ui.langSwitches.forEach(sw => sw.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) setLang(b.dataset.lang);
  }));

  // ── Open/closed + Turnstile, from the live settings ──────────────
  const closedCard = document.querySelector('[data-closed]');
  function showApp(open) {
    root.hidden = !open;
    if (closedCard) closedCard.hidden = open;
    // The hero's button was built from the content settings; follow the live switch
    const cta = document.querySelector('[data-hero-cta]');
    if (cta) {
      // Closed, it goes to the "tell me when we open" box just below
      cta.setAttribute('href', '#application');
      cta.dataset.afT = open ? (token ? 'heroContinue' : 'heroStart') : 'heroNotify';
      cta.classList.toggle('btn-glow', open);
      cta.textContent = T(cta.dataset.afT);
    }
  }
  // ── Closed: "tell me when applications open", in this page's language ──
  // The same waitlist as the Apply page (functions/api/_application-waitlist.js)
  const notifyForm = closedCard?.querySelector('[data-notify]');
  const notifyUi = notifyForm ? {
    input: notifyForm.querySelector('input[type="email"]'),
    btn: notifyForm.querySelector('[data-notify-btn]'),
    note: notifyForm.querySelector('[data-notify-note]'),
    lang: notifyForm.querySelector('[data-notify-lang]'),
    langs: closedCard.querySelector('[data-closed-lang]'),
  } : null;
  let notifyState = null; // null | 'sending' | { done: key } | { error: key }
  function paintNotify() {
    if (!notifyUi) return;
    const { input, btn, note, lang: langField, langs } = notifyUi;
    if (langField) langField.value = lang;
    const st = notifyState;
    btn.textContent = T(st === 'sending' ? 'notifySending' : st?.done ? 'notifyDone' : 'notifyButton');
    btn.disabled = st === 'sending' || !!st?.done;
    input.disabled = st === 'sending';
    note.textContent = T(st?.done || st?.error || 'notifyNote');
    note.dataset.kind = st?.done ? 'done' : st?.error ? 'error' : '';
    const offered = form?.languages || ['en'];
    langs.hidden = offered.length < 2;
    langs.querySelectorAll('[data-lang]').forEach(b => {
      b.hidden = !offered.includes(b.dataset.lang);
      b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    });
  }
  if (notifyUi) {
    notifyUi.langs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lang]');
      if (b) setLang(b.dataset.lang);
    }, { signal });
    // Typing another address after a signup starts over
    notifyUi.input.addEventListener('input', () => { if (notifyState?.done || notifyState?.error) { notifyState = null; paintNotify(); } }, { signal });
    // The quick check (src/utils/signup-check.ts); without a token, the plain form post and its confirm page
    const notifyCheck = signupCheck(notifyForm, { lang: () => lang });
    notifyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = notifyUi.input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { notifyState = { error: 'notifyBad' }; paintNotify(); notifyUi.input.focus(); return; }
      notifyState = 'sending';
      paintNotify();
      try {
        const turnstileToken = await notifyCheck.token();
        if (turnstileToken === '') { postPlainly(notifyForm); return; }
        const res = await fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, hp: notifyForm.querySelector('[name="website"]')?.value || '', source: 'application-waitlist', lang, page: 'apply-form', ...(turnstileToken ? { turnstileToken } : {}) }),
        });
        const data = await res.json().catch(() => null);
        notifyCheck.reset();
        if (data?.code === 'turnstile') { postPlainly(notifyForm); return; }
        if (data?.ok && data.status === 'open') {
          // Opened since this page loaded: straight to the form
          notifyState = null;
          showApp(true);
          notice('notifyOpen', 'info');
          document.getElementById('application')?.scrollIntoView({ block: 'start' });
          return;
        }
        notifyState = data?.ok
          ? { done: data.status === 'already' ? 'notifyAlready' : data.confirmed === false ? 'notifyAddedQuiet' : 'notifyAdded' }
          : { error: res.status === 429 ? 'notifyBusy' : 'notifyFail' };
        if (data?.ok) notifyUi.input.value = '';
      } catch {
        notifyState = { error: 'notifyFail' };
      }
      paintNotify();
    }, { signal });
  }

  function resetTurnstile() {
    turnstileToken = null;
    try { window.turnstile?.reset(ui.turnstile.querySelector('.cf-turnstile')); } catch { /* not loaded */ }
  }
  function applyConfig() {
    // ?preview shows the form while closed; the server still only lets signed-in staff start one
    if (!token && cfg.open != null) showApp(!!cfg.open || mode != null || !!testRun);
    if (testRun?.signIn) paintTestBar();
    if (previewing) {
      notice(live ? 'previewLive' : 'preview', 'info');
      if (live) begin();
      else document.getElementById('application')?.scrollIntoView({ block: 'start' }); // straight to the overview, past the hero
    }
    if (!cfg.turnstileSiteKey || token || previewing || testRun) return;
    turnstileSiteKey = cfg.turnstileSiteKey;
    window.onSoardTurnstile = () => {
      window.turnstile.render(ui.turnstile.querySelector('.cf-turnstile'), {
        sitekey: turnstileSiteKey,
        callback: (t) => { turnstileToken = t; if (lastNav?.m === 'turnstile') navNote(null); },
        'expired-callback': () => { turnstileToken = null; },
      });
    };
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onSoardTurnstile&render=explicit';
    s.async = true;
    document.head.append(s);
    paintNav();
  }

  // ── Resume (a saved draft on this device, or an emailed link) ─────
  /** The last page with anything filled in (how far they got, when this device doesn't know) */
  function lastAnsweredPage(a) {
    let last = null;
    for (const p of form.pages) if (p.fields.some(f => (isInput(f) || isUpload(f)) && !unanswered(f, a || {}))) last = p.id;
    return last;
  }
  async function resume() {
    const params = new URLSearchParams(location.search);
    const fromLink = params.get('resume');
    const remindersOff = params.get('reminders') === 'off';
    if (fromLink) history.replaceState(history.state, '', location.pathname); // keep the token out of screenshots and shares
    const saved = store.get();
    const candidate = fromLink || saved?.token;
    if (!isToken(candidate)) { if (fromLink) notice('linkExpired', 'error'); return; }
    const r = await api({ action: 'resume', token: candidate, ...(remindersOff ? { reminders: 'off' } : {}) }).catch(() => null);
    if (!r?.ok) {
      // Gone (or never was): forgotten on this device. Not reached (offline, busy, a hiccup): kept, to open next time
      if (r && (r.code === 'no-draft' || r.status === 404)) { if (fromLink) notice('linkExpired', 'error'); store.clear(); }
      else notice('resumeFailed', 'error');
      return;
    }
    token = candidate;
    // A test run's link (from its "finish later" email) carries on as a test run, kept apart
    if (r.test?.by && !testRun?.by) {
      testRun = r.test;
      if (!fromLink) store.clear();
      store = local(keyed(TEST_STORE_KEY));
      paintTestBar();
    }
    showApp(true); // a saved application can always be finished, even after we close
    // Their saved language wins over this device's
    if (LANGS[r.lang] && (form.languages || []).includes(r.lang)) { lang = r.lang; langPref.set(lang); }
    answers = { ...(r.answers || {}) };
    // The last address check, for the address they left (the server placed it against today's area)
    areaNow = r.area ? { ...r.area, key: addressKey(answers[homeAddressId() || 'address']) } : null;
    for (const [id, pf] of Object.entries(r.files || {})) {
      if (id === 'video') {
        if (pf.uploaded) { files.video = { uid: true, uploaded: true, name: pf.name }; uploadUi.video = { state: 'done', msg: ['videoDone', { name: pf.name }] }; }
        else uploadUi.video = { state: 'empty', msg: 'videoGone' };
      } else {
        files[id] = { key: true, name: pf.name };
        uploadUi[id] = { state: 'done', msg: ['added', { name: pf.name }] };
      }
    }
    draw({ merge: false });
    applyWords();
    if (r.submitted) { finished(true); return; }
    // An address without the check's answer for it (it changed just before they left): checked again
    if (homeAddressId() && !areaPlaced() && checkableAddress(homeAddressNow())) scheduleArea(true);
    // How far they got: the draft's record, this device's, the page they were on, what they filled in
    const mine = saved?.token === candidate ? saved.furthest : null;
    const known = [r.maxPage, r.maxPageId, r.max_page_id, mine, r.page, lastAnsweredPage(answers)].filter(id => order(id) >= 0);
    furthestId = known.sort((x, y) => order(y) - order(x))[0] || furthestId;
    const ids = stepIds(answers);
    const at = ids.includes(r.page) ? r.page : ids[0];
    currentId = null;
    show(at, { focus: false, scroll: false, screen: 'open' });
    remember();
    showApp(true); // the hero's button says "Continue"
    notice(remindersOff ? 'remindersOff' : 'welcomeBack', 'success');
    if (fromLink || session.get()) begin();
  }

  // ── Live preview for the form editor (?preview=live) ─────────────
  function onPreview(e) {
    if (e.origin !== location.origin || e.data?.type !== 'afe-preview') return;
    const d = e.data;
    try {
      if (d.definition?.pages?.length) definition = d.definition;
      if (d.lang && LANGS[d.lang]) lang = d.lang;
      draw();
      furthestId = 'review';
      applyWords();
      const focusPage = d.focus ? (form.pages.some(p => p.id === d.focus) ? d.focus : pageOf(d.focus)) : null;
      if (focusPage && stopShown) { stopShown = null; ui.stop.hidden = true; ui.form.hidden = false; }
      if (focusPage && doneShown) { doneShown = null; ui.done.hidden = true; ui.form.hidden = false; root.classList.remove('is-done'); }
      const target = focusPage || (pageEl(currentId) ? currentId : stepIds()[0]);
      const anchor = d.focus && byId[d.focus] ? d.focus : (target === currentId && currentId !== 'review' ? [...screenFieldIds()][0] : null);
      currentId = null;
      show(target, { focus: false, scroll: false, at: anchor && fieldEl(anchor) ? anchor : null });
      const el = d.focus && byId[d.focus] ? fieldEl(d.focus) : null;
      if (el) openTucked(el, { animate: false });
      if (el && !el.hidden) {
        el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
        flash(el);
      } else if (focusPage) scrollToForm(true);
    } catch (err) {
      console.warn('Preview could not draw that change', err);
    }
  }

  // ── Wire up (delegated: the questions are redrawn on a language switch) ──
  ui.form.addEventListener('submit', (e) => { e.preventDefault(); next(); });
  ui.back.addEventListener('click', back);
  ui.steps.addEventListener('toggle', () => paintStepList());
  ui.rail?.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) jump(go.dataset.goto);
  });
  // The rail appears or goes as the window crosses its width: paint it when it shows up
  matchMedia('(min-width: 1080px)').addEventListener?.('change', () => paintHeader(), { signal });

  // In and out of the application's own screen: the hero's button, the overview, Save and exit
  const heroCta = document.querySelector('[data-hero-cta]');
  heroCta?.addEventListener('click', (e) => {
    if (root.hidden || testRun?.signIn) return; // closed: it goes to the "tell me when we open" box
    e.preventDefault();
    begin();
  }, { signal });
  ui.hubGo?.addEventListener('click', () => begin(ui.hubGo.dataset.go || null));
  ui.hubList?.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go && !go.disabled) begin(go.dataset.goto);
  });
  ui.exit?.addEventListener('click', () => exitFocus());
  // Escape closes "All steps" (and a press anywhere else does)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.steps.open) { ui.steps.open = false; ui.steps.querySelector('summary')?.focus(); } }, { signal });
  document.addEventListener('pointerdown', (e) => { if (ui.steps.open && !ui.steps.contains(e.target)) ui.steps.open = false; }, { signal });
  // Back from the phone or the browser: a screen back (see armTrap). The page's inline gate
  // (ApplicationPage.astro) asks this first, ahead of the site's router; true = handled here.
  window.__afPop = () => {
    if (swallow) { swallow = false; return true; }
    if (!focused) return false;
    trapped = false;
    if (ui.dialog.open) { ui.dialog.close(); return true; }
    if (stopShown || doneShown || !back()) exitFocus({ fromPop: true });
    return true;
  };
  const rearm = () => { if (focused && !trapped) armTrap(); };
  document.addEventListener('pointerdown', rearm, { capture: true, signal });
  document.addEventListener('keydown', rearm, { capture: true, signal });
  // A real change of window size (not a phone's address bar sliding away) works the screens out again, keeping their place
  let packTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(packTimer);
    packTimer = setTimeout(() => {
      if (!focused || !packSize || !currentId || currentId === 'review' || ui.form.hidden) return;
      const [w0, h0] = packSize.split('x').map(Number);
      if (Math.abs(innerWidth - w0) < 40 && Math.abs(innerHeight - h0) < 120) return;
      const piece = packs[currentId]?.[screenNo]?.[0] || null; // the same words or question after the resize
      delete packs[currentId];
      show(currentId, { piece, focus: false, scroll: false });
    }, 180);
  }, { passive: true, signal });

  // Review: a step opens to its answers; "Show all answers" opens every one
  ui.review.addEventListener('click', (e) => {
    const tg = e.target.closest('[data-review-toggle]');
    if (tg) { setReviewOpen(tg.closest('.af-review-section'), tg.getAttribute('aria-expanded') !== 'true'); return; }
  });
  ui.reviewAll?.addEventListener('click', () => {
    reviewAll = !reviewAll;
    ui.review.querySelectorAll('.af-review-section').forEach(sec => setReviewOpen(sec, reviewAll || sec.hasAttribute('data-missing')));
    paintReviewAll();
  });

  ui.form.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more-open], [data-more-close]');
    if (more) {
      if (more.matches('[data-more-open]')) openTucked(more.closest('[data-more]').querySelector('[data-field]'), { focus: true });
      else closeTucked(more.closest('[data-more]'));
      return;
    }
    const fixMail = e.target.closest('[data-mailfix-use]');
    if (fixMail) {
      const input = fixMail.closest('[data-field]').querySelector('input[type=email]');
      input.value = fixMail.dataset.mailfixUse;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
      return;
    }
    // An empty photo or video box opens the picker wherever it's pressed, not just on its button
    const box = e.target.closest('.af-upload[data-state="empty"]');
    if (box && !e.target.closest('button, a, input')) { box.querySelector('[data-act="choose"]')?.click(); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const el = act.closest('[data-field]');
      const f = byId[el?.dataset.field];
      if (!f) return;
      switch (act.dataset.act) {
        case 'choose': el.querySelector('input[type=file]').click(); break;
        case 'remove': removeFile(f); break;
        case 'record': openRecorder(f); break;
        case 'rec-toggle': toggleRecording(); break;
        case 'rec-cancel': closeRecorder(); break;
        case 'area-fix': {
          // To the address (its screen, on a phone that has the map on the next), its words ready to change
          if (!homeAddressId()) break;
          focusOn(homeAddressId());
          document.activeElement?.select?.();
          break;
        }
        default:
      }
      return;
    }
    const option = e.target.closest('.af-suggest [role="option"]');
    if (option) { chooseOption(option); return; }
    const addrMode = e.target.closest('[data-addr-mode]');
    if (addrMode) { setAddressMode(addrMode.closest('[data-field]'), addrMode.dataset.addrMode); return; }
    const go = e.target.closest('[data-goto]');
    if (go) { jump(go.dataset.goto); return; }
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const pid = edit.dataset.page;
      const fid = edit.dataset.edit || firstQuestion(pid);
      if (edit.dataset.edit) { touched.add(fid); setFieldError(fid, errorFor(fid)); }
      jump(pid, { focusField: fid, whole: !edit.dataset.edit });
    }
  });
  // Back in an address line they searched but didn't pick from: its suggestions again
  ui.form.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!t.matches?.('[data-search]')) return;
    const el = t.closest('[data-field]');
    if (el && !addrBox(el)?.dataset.picked) suggestFor(el, t);
  });
  // A press on a suggestion keeps the cursor in the address line (so the list stays open for the click)
  ui.form.addEventListener('mousedown', (e) => { if (e.target.closest('.af-suggest')) e.preventDefault(); });

  ui.form.addEventListener('input', (e) => {
    const tgt = e.target;
    if (tgt.type === 'file' || tgt.closest('.af-hp')) return;
    const el = tgt.closest('[data-field]');
    if (tgt.type === 'tel' && e.inputType && !e.inputType.startsWith('delete') && tgt.selectionStart === tgt.value.length) {
      const shaped = phoneShape(tgt.value, false);
      if (shaped !== tgt.value) tgt.value = shaped;
    }
    if (tgt.type === 'email' && e.isTrusted) { const p = el?.querySelector('[data-mailfix]'); if (p && !p.hidden) p.hidden = true; }
    if (tgt.tagName === 'TEXTAREA') { grow(tgt); capBox(tgt); }
    if (tgt.matches('[data-search]') && el) addressTyped(el, tgt);
    liveCheck(el);
    if (el && el.dataset.field === homeAddressId()) scheduleArea();
    if (countyNote && el?.dataset.field === countyNote.field) hideCountyNote();
    refresh();
    markDirty();
  });
  ui.form.addEventListener('change', (e) => {
    const tgt = e.target;
    if (tgt.type === 'file') {
      const f = byId[tgt.closest('[data-field]')?.dataset.field];
      const file = tgt.files?.[0];
      tgt.value = '';
      if (f && file) takeFile(f, file);
      return;
    }
    if (tgt.closest('.af-hp')) return;
    const el = tgt.closest('[data-field]');
    if (tgt.type === 'tel') { const shaped = phoneShape(tgt.value, true); if (shaped !== tgt.value) tgt.value = shaped; }
    if (tgt.type === 'email') paintMailFix(tgt);
    liveCheck(el);
    if (el && el.dataset.field === homeAddressId()) scheduleArea();
    if (countyNote && el?.dataset.field === countyNote.field) hideCountyNote();
    refresh();
    markDirty();
  });
  // Leaving a question they've worked on: check it then (not while they type). If they left it
  // by pressing something (Next, a choice below), wait until the press is over: a note appearing
  // mid-press would push that button out from under their finger and the press would miss.
  let pressing = false;
  const leftWhilePressing = new Set();
  function checkLeft(id) {
    const el = fieldEl(id);
    if (!el || el.contains(document.activeElement)) return;
    const msg = errorFor(id);
    setFieldError(id, msg);
    if (msg) announce(msg);
  }
  const pressOver = () => setTimeout(() => {
    pressing = false;
    for (const id of leftWhilePressing) checkLeft(id);
    leftWhilePressing.clear();
  }, 80);
  document.addEventListener('pointerdown', () => { pressing = true; }, { capture: true, signal });
  document.addEventListener('pointerup', pressOver, { capture: true, signal });
  document.addEventListener('pointercancel', pressOver, { capture: true, signal });
  ui.form.addEventListener('focusout', (e) => {
    const el = e.target.closest?.('[data-field]');
    if (!el) return;
    if (e.target.getAttribute('role') === 'combobox') {
      clearTimeout(sug.closing);
      sug.closing = setTimeout(() => { if (document.activeElement !== sug.input) closeSuggest(); }, 180);
    }
    if (el.contains(e.relatedTarget)) return;
    if (e.relatedTarget && !ui.form.contains(e.relatedTarget)) return; // to the bar across the top, the steps, a dialog
    const id = el.dataset.field;
    if (!touched.has(id) || isUpload(byId[id] || {})) return;
    if (pressing) leftWhilePressing.add(id); else checkLeft(id);
  });
  ui.form.addEventListener('keydown', (e) => {
    const input = e.target;
    if (input.getAttribute?.('role') !== 'combobox') return;
    const open = sug.list && sug.input === input && !sug.list.hidden;
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveActive(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (sug.active >= 0) chooseOption(sug.list.children[sug.active]); else closeSuggest(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSuggest(); }
    else if (e.key === 'Tab') closeSuggest();
  });
  // Enter (the keyboard's "next") goes to the next box on the screen; on the last one it's Continue
  ui.form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.shiftKey) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || ['radio', 'checkbox', 'file', 'submit', 'button'].includes(t.type) || t.closest('.af-hp')) return;
    const boxes = [...(pageEl(currentId)?.querySelectorAll('input:not([type=hidden]):not([type=file]):not([disabled]), select, textarea') || [])]
      .filter(x => x.getClientRects().length && !x.closest('[hidden], [data-off]'))
      .filter((x, i, all) => x.type !== 'radio' || all.findIndex(y => y.type === 'radio' && y.name === x.name) === i); // a choice group once
    const after = boxes[boxes.indexOf(t) + 1];
    if (boxes.includes(t) && after) {
      e.preventDefault();
      // A choice group: the picked choice, else its first
      const to = after.type === 'radio' ? pageEl(currentId).querySelector(`input[type=radio][name="${CSS.escape(after.name)}"]:checked`) || after : after;
      to.focus();
    }
  });

  // Drag and drop onto a photo or video box (computers); a file dropped anywhere else is ignored, not opened
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const dropZone = (e) => e.target.closest?.('[data-drop]');
  const onDrag = (e) => {
    const zone = dropZone(e);
    if (!zone || !hasFiles(e) || zone.dataset.state === 'busy') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    zone.dataset.drag = '1';
  };
  ui.form.addEventListener('dragenter', onDrag);
  ui.form.addEventListener('dragover', onDrag);
  ui.form.addEventListener('dragleave', (e) => {
    const zone = dropZone(e);
    if (zone && !zone.contains(e.relatedTarget)) delete zone.dataset.drag;
  });
  ui.form.addEventListener('drop', (e) => {
    const zone = dropZone(e);
    if (!zone) return;
    e.preventDefault();
    delete zone.dataset.drag;
    const f = byId[zone.closest('[data-field]')?.dataset.field];
    const file = e.dataTransfer?.files?.[0];
    if (f && file && zone.dataset.state !== 'busy') takeFile(f, file);
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e) && !dropZone(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } }, { signal });
  window.addEventListener('drop', (e) => { if (hasFiles(e) && !dropZone(e)) e.preventDefault(); }, { signal });

  // Leaving (a reload, a closed tab, a phone locking or switching apps): what's not saved yet goes with a
  // keepalive request, which the browser finishes after the page is gone (Safari drops an ordinary one)
  function saveOnLeave() {
    if (!token || previewing || !['unsaved', 'saving'].includes(lastSave)) return;
    clearTimeout(dirtyTimer);
    const ids = stepIds();
    const page = currentId === 'review' ? ids[ids.length - 2] : currentId;
    try {
      fetch(API, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', token, answers: readAnswers(), page, lang }) });
    } catch { /* the page is going either way */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveOnLeave(); }, { signal });
  window.addEventListener('pagehide', saveOnLeave, { signal });
  // Map names are spaced for the width they're shown at; a page shown after a hidden one gets its turn too
  let declutterTimer = 0;
  const redeclutter = () => { clearTimeout(declutterTimer); declutterTimer = setTimeout(() => { declutter(ui.pages); declutter(ui.stopMap); }, 120); };
  window.addEventListener('resize', redeclutter, { signal });
  window.addEventListener('resize', fitNavLater, { signal });
  window.visualViewport?.addEventListener('resize', placeSuggest, { signal });
  window.visualViewport?.addEventListener('scroll', placeSuggest, { signal });
  // Measured again in the site's own type once it has loaded (the first screen can come before it)
  document.fonts?.ready.then(() => {
    fitNavLater();
    if (!focused || !currentId || currentId === 'review' || !packs[currentId]) return;
    const piece = packs[currentId][screenNo]?.[0] || null;
    delete packs[currentId];
    show(currentId, { piece, focus: false, scroll: false });
  });
  window.addEventListener('beforeunload', (e) => {
    if (uploads.size || recorder?.rec) { e.preventDefault(); e.returnValue = ''; }
  }, { signal });
  // Leaving through a site link doesn't fire beforeunload; ask before an upload is cut off
  document.addEventListener('astro:before-preparation', (e) => {
    if ((uploads.size || recorder?.rec) && !confirm(T('leaveUpload'))) e.preventDefault();
    else if (token) save();
  }, { signal });
  if (live) window.addEventListener('message', onPreview, { signal });

  // ── First paint ──────────────────────────────────────────────────
  draw();
  if (previewing) furthestId = 'review'; // staff can jump to any page
  applyWords();
  paintTestBar();
  show(stepIds()[0], { focus: false, scroll: false });
  if (previewing) {
    applyConfig();
    if (live && window.parent !== window) window.parent.postMessage({ type: 'afe-preview-ready' }, location.origin);
  } else {
    resume().catch(() => {}).finally(() => { if (!token) applyConfig(); });
  }
}
