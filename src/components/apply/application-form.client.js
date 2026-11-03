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
  stopFor, fieldError, namedError, formErrors, answerSections, isInput, isUpload, dateText, optionLabel,
} from '../../../functions/api/_application-form.js';
import { addressKey, checkableAddress } from '../../../functions/api/_geo.js';
import { renderPages, t as word, imageHtml, mapWords, esc } from './application-render.js';
import { areaMapHtml, declutter } from './area-map.js';
import { signupCheck, postPlainly } from '../../utils/signup-check';
import { mailFix } from './mail-fix.js';

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
// Some browsers block saving on the device (every cookie blocked, strict privacy): the server still has
// the answers, but this device won't remember the way back to them
const canKeep = (() => { try { localStorage.setItem('soard-probe', '1'); localStorage.removeItem('soard-probe'); return true; } catch { return false; } })();

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = () => matchMedia('(pointer: fine)').matches;
const isToken = (s) => /^[0-9a-f]{32}$/.test(String(s || ''));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const SCREEN_KEY = 'soard-application-screen'; // this tab's screen, for a reload
const PENDING_KEY = 'soard-application-unsaved';
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
  // Answers typed here and not saved yet (offline, the server failing, the tab closed first): kept on this
  // device until the server has them, and put back on top when this application opens here again
  const pending = local(keyed(PENDING_KEY));
  // Where messages go: the parent's email, or the organization's main contact's
  const emailId = org ? 'contactEmail' : 'parentEmail';
  const year = String(cfg.year || root.dataset.year || '');
  // The application this device had going when a link opened another one (a brother's or sister's): the
  // overview keeps a way back to it, and from that one back to this
  const otherStore = local(keyed('soard-application-other'));
  const otherHere = () => { const x = previewing || testRun ? null : otherStore.get(); return isToken(x?.token) && x.token !== token && (!x.year || x.year === year) ? x : null; };
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
    hubOther: $('[data-hub-other]'),
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
  let detour = null;         // gone back to an earlier step from the overview or the steps: { page, piece } of where they were
  let reviewBack = null;     // the review's answer (or step) they went from to change: { edit } | { page }
  let token = null;
  let rev = null;            // the draft's save this page last had (another device's save since is brought in, not saved over)
  let synced = null;         // the answers as of that save (what's changed here since goes with the next one)
  let turnstileToken = null;
  let turnstileSiteKey = null;
  let saveChain = Promise.resolve();
  let dirtyTimer = null;
  let busy = false;
  let busyShown = false; // Continue looks busy only once a press takes a moment (a screen change never does)
  let busyTimer = 0;
  let lastNotice = null;
  let lastSave = null;
  let lastNav = null;
  let stopShown = null;
  let doneShown = null;
  let countyNote = null;
  let laterEmail = '';
  let uspsNow = null;        // the Postal Service's word on the home address (with a Google key): { key, status }
  let uspsGoing = '';        // ...the address it's being asked about
  const uspsOn = !!cfg.usps;
  let areaNow = null;        // the last service-area check of the home address: { key, band, answer, lat, lng, miles, county, matched, reason }
  let askedFor = null;       // the address (its key) the family's own answer to "is the home inside the area?" is about

  const T = (k, v = {}) => word(lang, k, { year, ...v }, kind);
  /** A message spec: 'key', ['key', vars] or { raw: 'text' } → words in the current language */
  // A message: a word's key, [key, values], { raw } words as they came (the server's), or { again: key } (our own
  // words with "Please try again" after them): all but the server's said in the language of the moment
  const sayAgain = (k) => { const msg = T(k); return /try again|again|intent|de nuevo|please|por favor|pruebe|elija|choose|vuelva|another|otro/i.test(msg) ? msg : T('tryAgain', { msg: msg.replace(/[.!]\s*$/, '') }); };
  const say = (m) => (!m ? '' : typeof m === 'string' ? T(m) : Array.isArray(m) ? T(m[0], m[1]) : m.again ? sayAgain(m.again) : String(m.raw || ''));
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
  // Safari on a Mac draws today's date, grayed, in an empty date box (WebKit bug 233215), so a birthday left empty
  // looks answered. There it's drawn empty, as an iPhone's Safari draws it, till they're in it (the styles); one
  // begun and left part-way ("03/dd/yyyy") stays as it is
  if (/^((?!chrome|chromium|crios|fxios|edg|opr|android).)*safari/i.test(navigator.userAgent) && navigator.maxTouchPoints < 2) root.classList.add('af-mac-safari');
  const paintDate = (i) => i.toggleAttribute('data-empty', !i.value && !i.validity?.badInput);
  for (const type of ['input', 'change', 'focusout']) ui.pages.addEventListener(type, (e) => { if (e.target.type === 'date') paintDate(e.target); }, { signal });
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
        if (input?.type === 'date') paintDate(input);
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
    // A group they've opened ("Add another parent or guardian") stays open, nothing in it yet or not
    const openWas = form ? [...ui.pages.querySelectorAll('[data-more]')].filter(b => !b.querySelector('.af-more-body')?.hidden).map(b => b.querySelector('[data-field]')?.dataset.field).filter(Boolean) : [];
    closeRecorder({ keep: true, why: 'recKeptLang' }); // a language switch mid-recording keeps it
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
    ui.pages.querySelectorAll('input[type=date]').forEach(paintDate);
    for (const was of addrWas) {
      const b = addrBox(fieldEl(was.id));
      if (!b) continue;
      if (was.mode === 'parts') b.dataset.mode = 'parts';
      else if (!b.dataset.picked && was.line) { b.dataset.mode = 'line'; b.querySelector('[data-search]').value = was.line; }
    }
    for (const f of fields) if (isUpload(f)) paintUpload(f.id);
    openAnsweredTucked();
    for (const id of openWas) openTucked(fieldEl(id), { animate: false });
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
    paintHeroNote();
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
      // As many as it takes: the rest greyed, still reached by Tab and a screen reader (a press says why)
      el?.querySelectorAll('input').forEach(i => { if (!i.checked && picked >= f.max) i.setAttribute('aria-disabled', 'true'); else i.removeAttribute('aria-disabled'); });
      if (picked < f.max && Array.isArray(lastNav?.m) && lastNav.m[0] === 'detailFull') navNote(null); // one taken off: the note's done
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
   * The browser hovers nothing while a view transition runs, so the button just clicked would lose its
   * hover look for the change and fade it back in after (a blink on every mouse press). It keeps the
   * look (data-held) until the pointer is back over it, moves, or 600ms pass.
   */
  let holdGen = 0;
  function hold() {
    const btns = [...root.querySelectorAll('.af-btn:hover, .af-step:hover, [data-held]')];
    btns.forEach(b => b.setAttribute('data-held', ''));
    return { btns, gen: ++holdGen };
  }
  function letGo(held) {
    if (!held.btns.length) return;
    const end = performance.now() + 600;
    const done = () => {
      removeEventListener('pointermove', done, true);
      if (held.gen === holdGen) held.btns.forEach(b => b.removeAttribute('data-held'));
    };
    addEventListener('pointermove', done, true);
    const check = () => {
      if (held.gen !== holdGen) return removeEventListener('pointermove', done, true);
      if (performance.now() > end || held.btns.every(b => !b.isConnected || b.matches(':hover'))) done();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }
  /**
   * Change what's on screen (`update` does it) with the motion of going forward or back: the old
   * screen slips out the way they're heading and the new one slides in from the other side, at
   * Linear's pace (90ms out, 200ms in, overlapping). View Transitions where the browser has them, a plain
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
      // (from partly there: the old screen is already gone, so from nothing there'd be a frame of blank page)
      ui.stage.animate?.([{ opacity: 0.4, transform: `translateX(${dir * 16}px)` }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.05,.7,.1,1)' });
      return Promise.resolve();
    }
    html.classList.add('af-vt');
    html.classList.toggle('af-vt-back', dir < 0);
    html.classList.toggle('af-vt-same', samePage);
    moving = true;
    const held = hold();
    let vt;
    try {
      vt = document.startViewTransition(() => { try { update(); } catch (err) { console.warn('Could not change the screen', err); } });
    } catch {
      html.classList.remove('af-vt', 'af-vt-back', 'af-vt-same');
      moving = false;
      update();
      letGo(held);
      return Promise.resolve();
    }
    vt.ready.catch(() => {}); // skipped (another change came first, or the tab went to the background): the screen still changes
    vt.finished.catch(() => {}).finally(() => { if (!moving) html.classList.remove('af-vt', 'af-vt-back', 'af-vt-same'); letGo(held); });
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
    if (/^exit/.test(lastNotice?.m || '')) notice(null); // "Saved…" was for the overview, not the screen they come back to
    root.classList.add('is-focus');
    document.documentElement.classList.add('af-focus');
    if (!live) session.set(true);
    if (!depth && history.state?.afFocus) { depth = history.state.afDepth || 1; trail[depth] = history.state.afAt; } // a reload on one of its own entries
    window.scrollTo({ top: 0, behavior: 'auto' });
    // In: the bar drops into place and the step rises, quick and settled (no overshoot)
    if (!reducedMotion()) {
      ui.top?.animate?.([{ transform: 'translateY(-100%)' }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
      enter(ui.stage, 0, 12, 260, 'cubic-bezier(.05,.7,.1,1)');
      if (railShown()) enter(ui.rail, -10, 0, 260, 'cubic-bezier(.05,.7,.1,1)');
    }
    return true;
  }
  /** Start, or carry on: the application takes the screen, at `id` if given (a step already reached), else where they were */
  function begin(id = null) {
    if (root.hidden) return;
    const fromPage = !focused && !session.get(); // in from the page (the overview, the hero, a link), not a reload on a screen
    // Left by the browser's Back (which walks back a screen at a time, to the very first): "Continue where you
    // left off" is the furthest step they'd reached, not the start they backed through
    if (id == null && backedOut && !focused && order(currentId) < order(furthestId)) id = furthestId;
    backedOut = false;
    // ...and when another tab or device took it further meanwhile: on from there, with what was answered there
    if (id == null && fromPage && aheadElsewhere && order(currentId) < order(furthestId)) { id = furthestId; peek(); }
    aheadElsewhere = false;
    const was = focused;
    // A link that didn't open, pressed past to start afresh: its note was about that link, not this one
    if (!token && lastNotice?.m === 'linkExpired') { notice(null); linkGone = false; }
    enterFocus();
    const go = id && (reached(id) || previewing) ? id : currentId;
    if (was && go === currentId) { armTrap(); return; }
    if (go !== currentId) currentId = null; // a new page: worked out afresh
    const piece = resumePiece && pageEl(go)?.contains(resumePiece) ? resumePiece : null;
    resumePiece = null;
    // An answer that stops it: "Continue to see why" (the overview's words) is that screen, after a reload too
    const stopNow = fromPage && id == null && !stopShown && token && !previewing ? stopFor(form, readAnswers()) : null;
    show(go, piece ? { piece, scroll: true } : { screen: 'open', scroll: true }).then(() => {
      if (depth) replaceLoc(); else pushLoc();
      if (stopNow && stopNow.page === currentId && !stopShown) { showStop(stopNow); pushLoc({ stop: true }); } // (Back from it: the question, as from any stop)
      if (stopShown && !ui.stop.hidden) ui.stopTitle.focus({ preventScroll: true }); // back onto a "can't help" screen: its words
      // Measured again once the application has the screen (Safari can measure the first frame's words a
      // line long), before the count is read: "Part 1 of 5" then "Part 2 of 4" never happens
      requestAnimationFrame(() => requestAnimationFrame(() => replan(true)));
    });
  }
  let backedOut = false;
  let aheadElsewhere = false; // the application went further in another tab or on another device while this page sat
  function exitFocus({ fromPop = false } = {}) {
    if (!focused) return;
    backedOut = fromPop;
    // Backed out (Back a screen at a time, to the very first): "Continue where you left off" is the furthest step,
    // after they've been to another page and come back too
    if (fromPop && order(currentId) < order(furthestId)) try { sessionStorage.setItem(keyed(SCREEN_KEY), JSON.stringify({ page: furthestId })); } catch { /* storage off */ }
    keepHeldAddresses();
    dropRemoved(); // Save and exit keeps it as it is
    const saving = token && !doneShown && !previewing ? save() : null; // sent: nothing more to save
    resumePiece = currentId !== 'review' && anchor && pageEl(currentId)?.contains(anchor) ? anchor : null; // "Continue where you left off": this screen
    closeRecorder({ keep: true });
    closeSuggest();
    if (ui.dialog.open) ui.dialog.close();
    focused = false;
    paintHeroNote(); // the page above says what's so now (an old link's note goes once a new application is under way)
    root.classList.remove('is-focus');
    document.documentElement.classList.remove('af-focus', 'af-vt', 'af-vt-back', 'af-vt-same');
    session.set(false);
    // Its entries in the history go with it, so the browser's Back leaves from here next (Forward comes back to this screen)
    left = depth > 0 ? { depth, at: whereNow() } : null;
    if (depth > 0) { swallow = true; history.go(-depth); }
    depth = 0;
    pageAt = 0;
    if (saving) {
      // "Saved" only once it is: offline, they're told the answers are still on this page
      notice('exitSaving');
      saving.then((ok) => {
        if (focused || lastNotice?.m !== 'exitSaving') return;
        // A photo or video still on its way isn't saved yet: they keep the page open till it is (said when it is)
        if (ok && uploads.size) notice('exitUploading', 'info');
        else if (ok) savedOnExit();
        else notice(notSavedWord(), 'error');
        paintHub(); // its heading says the same as the note (an earlier save landing first said "saved" too soon)
      });
    }
    paintHeader();
    if (doneShown) showApp(!root.hidden); // the hero says it's sent, and offers another child's
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
  let depth = 0; // the application's entry in the browser's history they're on (0: the page itself)
  const trail = []; // depth → the screen that entry is
  let left = null; // after Save and exit: the entry and screen they left from
  let pageAt = history.state?.afFocus ? history.state.afDepth || 1 : 0; // the entry the page itself sits on, out of the application
  let swallow = false;
  /**
   * The browser's or phone's Back and Forward go where they were, a screen at a time: every screen they
   * go to (Continue, a jump from the steps or the review, a stop) is an entry in the history that says
   * which screen it is, and Back or Forward shows that screen. The entries are made by their taps, so a
   * browser never skips them
   */
  const histOk = () => focused && !live && window.parent === window;
  // A screen is known by its first question (words to read before it can be parted from it by a repack)
  const screenQuestion = (pid = currentId, n = screenNo) => {
    const ids = [...screenFieldIds(pid, n)];
    const asks = (id) => byId[id] && (isInput(byId[id]) || isUpload(byId[id]));
    // One that shows (not a follow-up nobody asked for, or one tucked behind "Add another…"): those can
    // sit on another screen in the other language
    const shows = (id) => { const h = fieldEl(id)?.closest('[hidden]'); return !h || h === pageEl(pid); };
    return ids.find(id => asks(id) && shows(id)) || ids.find(asks) || ids[0] || null;
  };
  // Where a screen is: its question; the service-area check's card or map alone on a screen, which of them
  const screenAt = (pid = currentId, n = screenNo) => {
    const q = screenQuestion(pid, n);
    if (q) return { field: q };
    const k = (packs[pid]?.[n] || []).find(x => x.matches('[data-area-result], [data-area-map]'));
    if (k) return { field: k.closest('[data-field]').dataset.field, area: k.matches('[data-area-map]') ? 'map' : 'found' };
    return { field: (anchor && idsOf(anchor)[0]) || null };
  };
  const whereNow = () => (currentId === 'review' || !currentId ? { page: 'review' } : { page: currentId, ...screenAt() });
  /** The piece a location stands for (the screen holding it is the one) */
  const atPiece = (at) => {
    const el = at?.page && at.page !== 'review' && at.field ? fieldEl(at.field) : null;
    return (at?.area && el?.querySelector(at.area === 'map' ? '[data-area-map]' : '[data-area-result]')) || el;
  };
  // A screen reached from the review carries that in its entry: a reload (or Back and Forward) keeps "Back to review"
  const reviewMark = () => (fromReview && currentId !== 'review' ? { fromReview } : {});
  function pushLoc(extra = {}) {
    if (!histOk()) return;
    const at = { ...whereNow(), ...reviewMark(), ...extra };
    try {
      history.pushState({ ...(history.state || {}), afFocus: 1, afDepth: depth + 1, afAt: at }, '');
      depth++;
      trail[depth] = at;
      trail.length = depth + 1;
    } catch { /* history unavailable */ }
  }
  /** The entry they're on says the screen they're on now (an in-page Back, a fix that moved them) */
  function replaceLoc() {
    if (!histOk() || !depth) return;
    const at = { ...whereNow(), ...reviewMark(), ...(stopShown ? { stop: true } : {}) }; // over a "can't help" screen it's still the stop's
    try { history.replaceState({ ...(history.state || {}), afFocus: 1, afDepth: depth, afAt: at }, ''); trail[depth] = at; } catch { /* history unavailable */ }
  }
  function armTrap() { if (!depth) pushLoc(); }
  const sameAt = (x, y) => !!x && !!y && x.page === y.page && (x.page === 'review' || (x.field === y.field && (x.area || '') === (y.area || '')));
  /** The screen an entry was: shown, sliding the way they went */
  function goTo(at, dir) {
    if (!at?.page) return;
    const piece = atPiece(at);
    if (sameAt(at, whereNow())) return;
    show(at.page, piece ? { dir, piece } : { dir, screen: 0 });
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
  // The steps that need them: an answer missing or wrong, or one that stops the application (a rented home)
  const needsSet = (a = readAnswers()) => new Set([...Object.keys(formErrors(form, a, files, null, lang)).map(pageOf), stopFor(form, a)?.page].filter(Boolean));
  /** Done: reached, passed, and nothing on it needs them */
  const stepDone = (id, needs) => id !== 'review' && reached(id) && order(id) < order(furthestId) && !needs.has(id);
  const screensIn = (id) => (id === 'review' ? 1 : packs[id]?.length || 1);
  /** A screen with nothing on it (a follow-up alone there that their answer didn't call for) is passed over */
  const emptyScreen = (pid, n) => !!packs[pid]?.[n] && packs[pid][n].every(k => k.hidden || !!k.closest('[hidden]'));
  const screenAhead = () => (packs[currentId] || []).some((_, n) => n > screenNo && !emptyScreen(currentId, n));
  /** "Part 2 of 5": counting only the screens that show (one holding a follow-up they weren't asked isn't one) */
  function partOf(pid = currentId, n = screenNo) {
    const shown = (packs[pid] || [null]).map((_, i) => i).filter(i => !emptyScreen(pid, i));
    return { at: Math.max(0, shown.indexOf(n)) + 1, total: Math.max(1, shown.length) };
  }
  const screenBefore = () => { for (let n = screenNo - 1; n >= 0; n--) if (!emptyScreen(currentId, n)) return n; return -1; };

  // The browser tab says where they are while the application has the screen
  const baseTitle = document.title.replace(/^Test run · /, '');
  // In Spanish, the application's own name in Spanish too (the site's name after it stays)
  const siteName = baseTitle.includes(' | ') ? baseTitle.slice(baseTitle.indexOf(' | ')) : '';
  function paintTitle(ids = stepIds()) {
    const app = lang === 'en' ? baseTitle : `${T('appTitle')}${siteName}`;
    let title = app;
    if (focused && currentId && !stopShown && !doneShown) {
      const i = Math.max(0, ids.indexOf(currentId));
      title = `${T('step', { n: i + 1, total: ids.length })}: ${titleOf(currentId)} · ${app}`;
    }
    title = (testRun?.by ? 'Test run · ' : '') + title;
    if (document.title !== title) document.title = title;
  }

  function paintHeader() {
    const ids = stepIds();
    const i = Math.max(0, ids.indexOf(currentId));
    ui.stepText.textContent = T('step', { n: i + 1, total: ids.length });
    const part = partOf();
    ui.partText.textContent = part.total > 1 ? T('part', { n: part.at, total: part.total }) : '';
    // On a line of its own (the narrowest phones, in Spanish): no "•" leading that line
    ui.partText.toggleAttribute('data-wrapped', !!ui.partText.textContent && ui.partText.offsetTop > ui.stepText.offsetTop + 2);
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
    // "Something else" chosen and named in its own box: the name, in its place ("Public library", not "Something else")
    const named = {};
    for (const it of sec.items) {
      const on = byId[it.id]?.showIf;
      if (on?.field && byId[on.field] && on.in?.length === 1 && /^something else$/i.test(on.in[0]) && String(it.text || '').trim()) named[on.field] = { id: it.id, value: on.in[0], text: String(it.text).trim() };
    }
    const namedIds = new Set(Object.values(named).map(n => n.id));
    for (const it of sec.items) {
      const f = byId[it.id];
      if (!f || namedIds.has(it.id)) continue;
      if (it.upload) { if (f.type === 'video') video = true; else photos++; continue; }
      if (f.type === 'ack') { acks++; continue; }
      if (f.type === 'area') continue;
      const n = named[f.id];
      const said = n ? [].concat(a[f.id] ?? []).map(v => (v === n.value ? n.text : optionLabel(f, v))).join(', ') : it.text;
      const text = String((f.type === 'date' ? dateText(a[f.id], lang) : said) || '').split('\n')[0].trim();
      if (text && parts.length < 2) parts.push(text); // a long one is cut where the line ends (one "…", the styles')
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
    // The rail's list scrolls on a short screen (its foot, with Save and finish later, stays put): the step they're on kept in view
    const box = railShown() && ui.railList.closest('nav');
    const now = box && ui.railList.querySelector('[aria-current="step"]');
    if (now && box.scrollHeight > box.clientHeight) {
      const top = now.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      if (top < box.scrollTop || top + now.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - box.clientHeight / 3);
    }
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
      const part = now && partOf(id);
      const line = done ? summaryOf(id, a) : now ? (part.total > 1 ? T('part', { n: part.at, total: part.total }) : '') : open || id === 'review' ? '' : T('minutes', { n: minutesOf(id) });
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
    // An answer that stops the application (a rented home): its step isn't done, and the overview says why it waits
    const stopAt = started ? stopFor(form, a)?.page || null : null;
    const isDone = (id) => stepDone(id, needs); // (a stop's step is among `needs`)
    const doneCount = steps.filter(isDone).length;
    const ready = started && !needs.size && order(furthestId) >= order('review');
    const mins = minutesLeft(ids, a);
    const sent = !started && !resumePending ? sentHere() : null;
    const pending = !started && !!resumePending; // saved, not reached just now: said here too, by its Continue
    ui.hubTitle.textContent = T(sent ? 'hubTitleSent' : pending ? 'hubTitleBack' : !started ? 'hubTitle' : ['offline', 'notSaved', 'paused'].includes(lastSave) ? 'hubTitleUnsaved' : ['saving', 'unsaved'].includes(lastSave) || lastNotice?.m === 'exitSaving' ? 'hubTitleSaving' : 'hubTitleBack');
    ui.hubLead.textContent = sent ? (sent.at ? T('hubLeadSent', { date: sentDate(sent.at) }) : T('hubLeadSentToday'))
      : pending ? T('resumeFailed')
        : !started ? T('hubLead', { n: ids.length })
          : stopAt ? T('hubLeadStopped', { step: titleOf(stopAt) })
            : ready ? T('hubLeadReady')
              : T(mins <= 1 ? 'hubLeadBackOne' : 'hubLeadBack', { done: doneCount, n: ids.length, m: mins }); // the same count as "Step 4 of 10"
    ui.hubGoLabel.textContent = T(sent ? 'hubAnother' : pending ? 'hubContinue' : !started ? 'hubStart' : ready || currentId === 'review' ? 'hubReview' : 'hubContinue');
    ui.hubGo.dataset.go = ready ? 'review' : ''; // "Review and submit" goes there (not to the page they left)
    if (ui.hubLater) ui.hubLater.hidden = !started || previewing;
    if (ui.hubOther) ui.hubOther.hidden = !otherHere();
    // The hero's button says the same: start, or carry on
    const cta = document.querySelector('[data-hero-cta]');
    if (cta && !root.hidden && /^hero(Start|Continue|Another)$/.test(cta.dataset.afT || '')) {
      cta.dataset.afT = heroCtaWord();
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
        // Spaces between the words' boxes (the layout takes no notice): read as words, never "Begin1 min"
        b.innerHTML = '<span class="af-step-mark" aria-hidden="true"></span> <span class="af-hub-name"><strong></strong> <span class="af-hub-sub"></span></span> <span class="af-hub-meta"></span>';
        li.append(b);
        return li;
      }));
    }
    ids.forEach((id, i) => {
      const b = list.children[i].firstChild;
      const now = started && id === currentId;
      const open = started ? reached(id) : i === 0;
      const done = started && isDone(id);
      b.dataset.state = done ? 'done' : now ? 'now' : open ? 'open' : 'locked';
      b.disabled = !open && !previewing;
      const [mark, name, meta] = b.children;
      const markHtml = done ? CHECK_SVG : String(i + 1);
      // Its number is drawn by the styles: a picture of which step it is (its name says so in words), not a
      // word of its label ("1 Before You Begin" isn't what it's called)
      if (mark.dataset.v !== markHtml) { mark.dataset.v = markHtml; if (done) { mark.innerHTML = CHECK_SVG; delete mark.dataset.n; } else { mark.textContent = ''; mark.dataset.n = String(i + 1); } }
      name.firstChild.textContent = titleOf(id);
      name.lastChild.textContent = done ? summaryOf(id, a) : now ? T('stepNow') : '';
      const metaHtml = done ? `${PENCIL_SVG}<span>${esc(T('edit'))}</span>` : id === 'review' ? '' : esc(T('minutes', { n: minutesOf(id) }));
      if (meta.dataset.v !== metaHtml) { meta.dataset.v = metaHtml; meta.innerHTML = metaHtml; }
      // Its name holds what it shows, in that order (the minutes, Edit too), so a voice command naming what's
      // seen finds it; done or locked after
      const said = [`${T('step', { n: i + 1, total: ids.length })}: ${titleOf(id)}`, name.lastChild.textContent, meta.textContent, done ? T('stepDone') : now || open ? '' : T('stepLocked')];
      b.setAttribute('aria-label', said.filter((x, k) => x && said.indexOf(x) === k).join('. '));
    });
  }

  const setText = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };
  function paintNav(ids = stepIds()) {
    const review = currentId === 'review';
    const at = ids.indexOf(currentId);
    const lastScreen = review || !screenAhead();
    ui.back.hidden = at <= 0 && screenNo === 0;
    const label = review ? (busyShown ? 'submitting' : 'submit') : fromReview === 'answer' || (fromReview && lastScreen) ? 'toReview'
      : detourHere(lastScreen) ? 'toWhereWas' : ids[at + 1] === 'review' && lastScreen ? 'reviewBtn' : 'next';
    // Only when the words change: Safari drops a press on Continue whose words are replaced between the
    // finger going down and coming up (leaving a box on the way to it repaints this)
    setText(ui.nextLabel, T(label));
    if (ui.nextShort) setText(ui.nextShort, T({ reviewBtn: 'reviewBtnShort', toReview: 'toReviewShort', submit: 'submitShort', toWhereWas: 'toWhereWasShort' }[label] || label));
    ui.next.classList.toggle('af-btn--submit', review);
    let blockedBy = null;
    if (review) {
      const missing = Object.keys(formErrors(form, readAnswers(), files, null, lang)).length;
      blockedBy = uploads.size ? 'waitUploads' : missing ? 'submitNeeds' : null;
      if (blockedBy) navNote(blockedBy, true);
      else if (lastNav?.reason) navNote(null);
    } else if (lastNav?.reason) navNote(null);
    // Working: it looks off but stays a button (a disabled one drops the keyboard's focus to the page)
    ui.next.disabled = !!blockedBy;
    if (busyShown) ui.next.setAttribute('aria-disabled', 'true'); else ui.next.removeAttribute('aria-disabled');
    ui.next.setAttribute('aria-busy', String(busyShown));
    if (ui.turnstile) ui.turnstile.hidden = !(turnstileSiteKey && !token && !previewing && ((at === 0 && screenNo === 0) || checkAsked));
    fitNavLater();
    fitTopTitle();
  }
  /** The bar's title as it fits: the application's whole name, else its short one ("2027 Application") */
  function fitTopTitle() {
    const el = ui.top?.querySelector('.af-top-title');
    if (!el || !focused) return;
    el.textContent = T('appTitle');
    if (el.scrollWidth > el.clientWidth + 1) el.textContent = T('appTitleShort');
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
  // What the check found, then the map: the map shares the card's screen while it fits there at a size
  // that still reads (MAP_LEAST), else it has the next. When the check couldn't place the home (it asks),
  // the question goes with the map (it's about the map, so they stay together)
  const MAP_LEAST = 150;
  const asksAboutHome = (k) => k.matches('.af-field--area') && ['unknown', 'error'].includes(k.querySelector('[data-area]')?.dataset.area);
  const areaPieces = (k) => {
    const [res, ask, map] = ['[data-area-result]', '[data-area-ask]', '[data-area-map]'].map(q => k.querySelector(q));
    // In pieces only where they stand one under another (a phone); beside each other they're one
    const stacked = res && map && map.getBoundingClientRect().top >= res.getBoundingClientRect().bottom - 1;
    if (!stacked) return [k];
    return asksAboutHome(k) && ask ? [res, ask, map] : [res, map];
  };
  // A group opened ("Add another parent or guardian"): its questions are pieces like any others (Remove goes with the last)
  const groupPieces = (k) => {
    const body = k.querySelector(':scope > .af-more-body');
    return body && !body.hidden ? [...body.children].flatMap(c => (stackedPair(c) ? [...c.children] : [c])) : [k];
  };
  const pieces = (pid) => [...(pageEl(pid)?.children || [])].flatMap(k => (k.matches('.af-place[data-split]') ? [...k.children].flatMap(areaPieces)
    : stackedPair(k) ? [...k.children] : k.matches('.af-more') ? groupPieces(k) : [k]));
  // A piece's questions (the check's question stands for the service-area answer it belongs to)
  const idsOf = (el) => (el.matches('[data-field]') ? [el.dataset.field] : el.matches('[data-area-ask]') ? [el.closest('[data-field]').dataset.field]
    : [...el.querySelectorAll('[data-field]')].map(x => x.dataset.field));
  const isNote = (el) => ['content', 'guidelines', 'image'].includes(el.dataset.type);
  // Words that lead into what follows (a heading, a bold line, a line ending in ":") stay with it
  const isLead = (el) => /^H[1-6]$/.test(el.tagName) || (el.tagName === 'P'
    && (/:\s*$/.test(el.textContent) || (el.children.length === 1 && el.firstElementChild.tagName === 'STRONG' && el.textContent.trim() === el.firstElementChild.textContent.trim())));
  const packAsked = {}; // page → whether its screens were worked out with the check asking about the home
  let packSize = '';
  /** The page's screens worked out again where they stand (the screen they're on kept); `quiet`: only when they come out different */
  function replan(quiet = false) {
    if (!focused || !currentId || currentId === 'review' || !packs[currentId] || moving) return;
    const piece = (anchor && pageEl(currentId)?.contains(anchor) && anchor) || packs[currentId][screenNo]?.[0] || null;
    if (quiet) {
      const was = packs[currentId].map(sc => sc.length).join();
      const now = pack(currentId);
      if (!now || now.map(sc => sc.length).join() === was) { paintScreen(); fitScreen(); return; }
    }
    delete packs[currentId];
    show(currentId, { piece, focus: false, scroll: false, refit: true });
  }
  /**
   * A step they've been on, come back to: its screens as they were ("Part 3 of 3" stays 3 of 3), while
   * it's the same window and the same pieces (an answer that changed what the step holds works it out again)
   */
  function stillFits(id) {
    const plan = packs[id];
    if (!plan || plan.size !== `${innerWidth}x${innerHeight}`) return false;
    pageEl(id).querySelectorAll('[data-off]').forEach(k => k.removeAttribute('data-off')); // laid out to be told apart (the screen's painted after)
    const now = pieces(id);
    const was = plan.flat();
    return now.length === was.length && now.every((k, i) => k === was[i] && k.isConnected);
  }
  function room(el) {
    // Down to where the step starts: the bar across the top, the test-run bar over the step, and a note at the
    // top while it shows ("Welcome back"): the screen fits with it (nothing under Back / Continue meanwhile),
    // and is worked out again without it once it's gone (see forgetNotePacks)
    const top = Math.max(ui.top?.offsetHeight || 0, ui.stage.getBoundingClientRect().top + window.scrollY);
    const nav = ui.form.querySelector('[data-nav]')?.offsetHeight || 0;
    const head = el.getBoundingClientRect().top - ui.stage.getBoundingClientRect().top; // the stage's padding and the step's header
    const saveRow = ui.stage.querySelector('.af-save-row');
    const shown = saveRow && saveRow.offsetParent !== null;
    const tail = (shown ? saveRow.offsetHeight + parseFloat(getComputedStyle(saveRow).marginTop || 0) : 0) + parseFloat(getComputedStyle(ui.stage).paddingBottom || 0);
    // Good news there for a moment ("Welcome back"): not counted, so "Part 1 of 3" never turns "1 of 4" under it
    // (the screen may scroll a little till it goes)
    const brief = passing() ? Math.max(0, ui.form.getBoundingClientRect().top - ui.notice.getBoundingClientRect().top) : 0; // (it sits over the form)
    return Math.max(120, innerHeight - top - nav - head - tail + brief);
  }
  /**
   * Problem notes on the screen: the questions a little closer together (often room enough). Nothing
   * moves to another screen and the screen's count never changes under them; a long one scrolls, with
   * the focus on the first problem
   */
  function refitScreen(problems = null) {
    if (!problems || !focused || !currentId || currentId === 'review' || ui.form.hidden || moving) return;
    settle();
    if (document.documentElement.scrollHeight > innerHeight) pageEl(currentId)?.setAttribute('data-snug', '');
  }
  /**
   * For measuring: the page as it will look once answered (undone straight after, in the same task).
   * A follow-up whose question is on this page shows, an upload has its Remove, and the service-area
   * check shows what it finds for a home inside, with the county it fills in.
   */
  function answeredLook(el, pid) {
    const undo = [];
    // Problem notes come and go: the screens are planned without them (a language switch while they show
    // doesn't turn "Part 1 of 2" into "Part 1 of 3"), and they close the questions up when they show
    for (const p of el.querySelectorAll('.af-error')) {
      const was = p.textContent;
      if (was) { p.textContent = ''; undo.push(() => { p.textContent = was; }); }
    }
    if (el.hasAttribute('data-snug')) { el.removeAttribute('data-snug'); undo.push(() => el.setAttribute('data-snug', '')); }
    for (const b of el.querySelectorAll('.af-error-remove:not([hidden])')) { b.hidden = true; undo.push(() => { b.hidden = false; }); }
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
    // The questions closer together while problem notes show (kept through a repack while one does)
    if (!keep && ![...el.querySelectorAll('.af-error')].some(e => e.textContent.trim())) el.removeAttribute('data-snug');
    const places = [...el.querySelectorAll(':scope > .af-place')];
    places.forEach(p => { p.removeAttribute('data-split'); p.style.removeProperty('--af-map-h'); });
    fitAddress(el);
    if (el.offsetParent === null) return null;
    packSize = `${innerWidth}x${innerHeight}`;
    packAsked[pid] = [...el.querySelectorAll('.af-field--area')].some(asksAboutHome);
    if (!ui.notice.hidden && ui.notice.offsetParent && !passing()) packedWithNote.add(pid);
    const fit = room(el);
    const gap = parseFloat(getComputedStyle(el).rowGap) || 0;
    const undo = answeredLook(el, pid);
    // The address beside its map while both fit (with the note that leads into them), else apart
    for (const p of places) {
      const note = p.previousElementSibling;
      const nh = note && isNote(note) ? note.getBoundingClientRect().height : 0;
      if ((nh && nh < fit * 0.5 ? nh + gap : 0) + p.getBoundingClientRect().height > fit) p.setAttribute('data-split', '');
    }
    // Reading is read whole: a note taller than the room has a screen to itself, read down like a page
    const kids = pieces(pid);
    // Each piece's height, and the room between it and the piece before as drawn: a paragraph's
    // spacing inside words, the page's gap between questions
    const rects = kids.map(k => k.getBoundingClientRect());
    const h = rects.map(r => r.height);
    // How much shorter the map can be and still read
    const mapGives = kids.map(k => (k.matches('[data-area-map]') ? Math.max(0, (k.querySelector('.af-map-frame')?.getBoundingClientRect().height || 0) - MAP_LEAST) : 0));
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
      // The map stays with the question about it; with what the check found while the two fit
      const mapFollows = k.matches('[data-area-map]') && prev && (prev.kids.some(x => x.matches('[data-area-ask]')) || prev.h + sp[i] + h[i] - mapGives[i] <= fit);
      const follows = prev && (!h[i] || (f?.showIf && prev.ids.has(f.showIf.field) && together) || mapFollows || k.matches('.af-more-remove'));
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
    // A map that still reads (its pin's name, its key): smaller than that, the screen scrolls instead (on a
    // phone the packer has given it a screen of its own where it wouldn't read beside the card).
    // With the question about it on its screen, the answers come first: the map gives way further (its key
    // too), so none of them is under Back / Continue
    const ask = fe.querySelector('[data-area-ask]');
    const asking = !!ask && !ask.hidden && onScreen(ask);
    const least = asking ? 100 : MAP_LEAST;
    place.removeAttribute('data-tight');
    place.removeAttribute('data-nomap');
    const asItWas = () => { place.style.removeProperty('--af-map-h'); place.removeAttribute('data-tight'); settle(); };
    let before = Infinity;
    for (let i = 0; i < 6; i++) {
      settle();
      const over = document.documentElement.scrollHeight - innerHeight;
      const h = frame.getBoundingClientRect().height;
      if (over <= 0) { if (!i) growMap(fe, frame, place); return; }
      // A smaller map left the screen as tall (it's beside the card, not under it): the map as it was
      if (over >= before) { asItWas(); return; }
      before = over;
      if (h <= least) return; // its smallest: the screen scrolls a little rather than lose the map
      if (asking && h - over < 150) place.setAttribute('data-tight', ''); // its key gives way to the answers
      place.style.setProperty('--af-map-h', `${Math.max(least, Math.floor(h - over - 1))}px`);
    }
  }
  /**
   * A map over or under what's on its screen (a phone) takes the room the screen has left under the
   * last answer, as wide as the screen allows: no empty band over Back / Continue
   */
  function growMap(fe, frame, place) {
    const fr = frame.getBoundingClientRect();
    const by = ['[data-area-ask]', '[data-area-result]'].map(q => fe.querySelector(q)).find(x => x && onScreen(x));
    const o = by?.getBoundingClientRect();
    if (!o || fr.left >= o.right - 1 || fr.right <= o.left + 1) return; // beside the card, not under it
    const bottom = Math.max(...pieces(currentId).filter(onScreen).map(k => k.getBoundingClientRect().bottom));
    const navTop = ui.form.querySelector('[data-nav]')?.getBoundingClientRect().top ?? innerHeight;
    const spare = Math.floor(navTop - bottom - (parseFloat(getComputedStyle(ui.stage).paddingBottom) || 0));
    if (spare < 24) return;
    place.style.setProperty('--af-map-h', `${Math.floor(fr.height + spare)}px`);
    settle();
    if (document.documentElement.scrollHeight > innerHeight) { place.style.removeProperty('--af-map-h'); settle(); }
  }
  /** A page's choices as they are before fitting: every tile's words, a list in the columns its width gives it */
  function unfit(el) {
    for (const t of el?.querySelectorAll('.af-tile[data-clamp]') || []) { t.removeAttribute('data-clamp'); t.style.removeProperty('--lines'); }
    for (const s of el?.querySelectorAll('.af-choices--tiles[data-snug]') || []) s.removeAttribute('data-snug');
    for (const l of el?.querySelectorAll('.af-choices--cols[data-two]') || []) l.removeAttribute('data-two');
  }
  const onScreen = (el) => el.getClientRects().length && !el.closest('[data-off], [hidden]');
  const overflows = () => document.documentElement.scrollHeight > innerHeight;
  /**
   * Choices that each explain themselves, on a phone too short for all their words: a little snugger
   * first, then every tile says its first lines (as many for each, as many as the screen has room
   * for), the rest under its More. Two to a row (a computer), every word shows
   */
  function fitTiles() {
    for (const s of pageEl(currentId)?.querySelectorAll('.af-choices--tiles') || []) {
      if (!focused || !onScreen(s)) continue;
      settle();
      if (!overflows()) continue;
      // Two to a row (a computer): every word still shows, the tiles just a little closer
      if (getComputedStyle(s).getPropertyValue('--af-narrow').trim() !== '1') { s.setAttribute('data-snug', ''); continue; }
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
  /** An address and its apartment side by side only while the apartment's name fits its box; else one above the other */
  function fitAddress(el = pageEl(currentId)) {
    for (const box of el?.querySelectorAll('.af-address') || []) {
      box.removeAttribute('data-stack');
      const apt = box.querySelector('[data-part="line2"]');
      const label = apt?.closest('.af-float')?.querySelector('.af-float-label');
      if (label?.getClientRects().length && label.scrollWidth > label.clientWidth + 1) box.dataset.stack = '';
    }
  }
  /** The screen fitted to its room: the tiles' words, a long list's columns, then the map's size */
  function fitScreen() {
    unfit(pageEl(currentId));
    fitAddress();
    fitTiles();
    fitCols();
    fitMap();
    const page = pageEl(currentId);
    if (page?.querySelector('.af-map-frame')) declutter(page); // its names placed for the size it ended up
    capBoxes(pageEl(currentId));
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
    for (const c of holders) c.toggleAttribute('data-off', ![...on].some(k => c.contains(k)));
    page?.querySelectorAll('.af-more').forEach(paintGroupRemove);
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
  // The screen they came to (its first piece): a resize or a rotation that works the screens out again
  // brings them back to it, not to whichever screen that piece's neighbor ends up on
  let anchor = null;
  let resumePiece = null; // after a reload: the screen they were on
  function show(id, { dir = 0, screen = 0, step = 0, piece = null, at = null, focus = true, focusField = null, scroll = true, refit = false } = {}) {
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
        if (pageChanged) forgetNotePacks(id);
        if (!packs[id] || (pageChanged && !stillFits(id))) {
          ui.stepTitle.textContent = titleOf(id); // measured with this step's own name above it
          packs[id] = pack(id);
          if (packs[id]) packs[id].size = packSize;
        } else if (step > 0 && packs[id]) {
          // On: the screens still to come are worked out again (an answer can grow what follows, like
          // the service-area check's result), the ones they've seen kept as they were
          const kept = packs[id].slice(0, screenNo + 1);
          const places = [...pageEl(id).querySelectorAll(':scope > .af-place')];
          const split = places.map(p => p.hasAttribute('data-split'));
          const fresh = pack(id, kept);
          // "Part X of Y" doesn't shrink under them: what turned out shorter than planned (what the check
          // found, the fonts come in) leaves the screens they were told of, which still fit
          if (fresh && fresh.length > kept.length && fresh.length >= packs[id].length) { packs[id] = fresh; fresh.size = packSize; onto = kept.length; }
          else places.forEach((p, i) => p.toggleAttribute('data-split', split[i]));
        }
        if (piece && packs[id]) onto = packs[id].findIndex(kids => kids.some(k => k === piece || k.contains(piece) || piece.contains(k)));
        const n = screensIn(id);
        const want = onto >= 0 ? onto : at || focusField ? screenOf(id, at || focusField) : screen === 'last' ? n - 1 : screen === 'open' ? openScreen(id) : screen;
        screenNo = Math.max(0, Math.min(n - 1, Number(want) || 0));
        // Nothing on it (a follow-up their answer didn't call for): the next one on, or back, with something
        if (step > 0) while (screenNo < n - 1 && emptyScreen(id, screenNo)) screenNo++;
        if (step < 0 || screen === 'last') while (screenNo > 0 && emptyScreen(id, screenNo)) screenNo--;
        paintScreen();
        if (!refit) {
          anchor = packs[id]?.[screenNo]?.find(k => k.getClientRects().length) || null;
          // This tab remembers it too: a reload comes back to this screen, not to the next one with an answer missing
          const where = screenAt(id, screenNo);
          try { if (where.field && focused) sessionStorage.setItem(keyed(SCREEN_KEY), JSON.stringify({ page: id, ...where })); } catch { /* storage off */ }
        }
      }
      // The camera's screen left (Back, the steps, the browser's Back): it stops there, not out of sight
      if (recorder && !(fieldEl(recorder.id) && onScreen(fieldEl(recorder.id)))) closeRecorder({ keep: true });
      if (pageEl(id)?.querySelector('.af-map-frame')) requestAnimationFrame(() => declutter(pageEl(id)));
      if (pageChanged || dir) {
        ui.steps.open = false;
        if (!lastNav?.reason) navNote(null);
        if (lastNotice?.kind === 'success' || ['remindersOff', 'pickedUp'].includes(lastNotice?.m)) notice(null); // "Welcome back" has done its job once they move on
      }
      // A screen that can't fit with a note at the top (one question that can't be split, like the makeover tiles):
      // the note goes sooner, so nothing waits under Back / Continue for long
      if (lastNotice?.kind === 'success' && focused && overflows()) { clearTimeout(noticeTimer); noticeTimer = setTimeout(passNotice, 3000); }
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
      else if (focus) {
        // On a computer the screen's first box takes the keys straight away (Linear's way), and a screen
        // reader still hears which step this is; on a touch screen the step's name has the focus, so a
        // keyboard doesn't slide up over the questions (the step's name is described by its part, "Part 2 of 4":
        // a new part of the same step is heard too)
        const box = keysFirst() ? firstBox() : null;
        const part = partOf();
        if (box) {
          box.focus({ preventScroll: true });
          clearOfBars(box); // (a window zoomed in far: the box with the keys isn't left under Back / Continue)
          if (pageChanged) announce(`${T('step', { n: stepIds().indexOf(id) + 1, total: stepIds().length })}: ${titleOf(id)}`);
          else if (part.total > 1) announce(T('part', { n: part.at, total: part.total }));
        } else ui.stepTitle.focus({ preventScroll: true });
      }
    });
  }
  const keysFirst = () => finePointer() && !matchMedia('(any-pointer: coarse)').matches;
  /** Out from under Back / Continue, as little as it takes (never past the bar across the top) */
  function clearOfBars(el) {
    const r = el.getBoundingClientRect();
    const navTop = ui.form.querySelector('[data-nav]')?.getBoundingClientRect().top ?? innerHeight;
    const by = Math.min(r.bottom + 12 - navTop, r.top - (ui.top?.getBoundingClientRect().bottom || 0) - 8);
    if (by > 0) window.scrollBy({ top: by, behavior: 'auto' });
  }
  /** The screen's first question (past any words to read) when it's a box to type in, still empty */
  function firstBox() {
    if (currentId === 'review') return null;
    const field = [...(pageEl(currentId)?.querySelectorAll('[data-field]') || [])].find(f => onScreen(f) && !isNote(f));
    const box = field?.querySelector('input:is([type=text], [type=email], [type=tel], [type=number], :not([type])), textarea');
    return box && onScreen(box) && !box.value && !box.disabled ? box : null;
  }

  async function next() {
    if (busy || moving || performance.now() < calmUntil) return;
    navNote(null);
    if (currentId === 'review') { submit(); return; }
    // Waiting (a check, a photo on its way) while they go Back or jump: this Continue is over
    const from = `${currentId}:${screenNo}`;
    const moved = () => `${currentId}:${screenNo}` !== from || !focused || ui.form.hidden;
    // An address pasted (or filled in) a moment ago, its suggestions still coming: wait for them, so the
    // one that matches it is taken (not "choose it from the list")
    const due = sug.due || sug.going ? suggestDue() : null;
    if (due) {
      setBusy(true);
      try { await Promise.race([due, wait(5000)]); } finally { setBusy(false); }
      if (moved()) return;
    }
    takeExactMatch();
    if (due) reopenSuggest();
    // A check that didn't go (the connection, our server): asked again before its question's answer is taken, a
    // home it places outside the area stops here (on later screens it's asked again on its way, said at Continue)
    if (areaFailed() && !area.want) {
      if (pageOf(areaField().id) === currentId) {
        setBusy(true);
        try { await Promise.race([areaAgain(), wait(9000)]); } finally { setBusy(false); }
        if (moved()) return;
      } else areaAgain();
    }
    // An address check still on its way decides this page's answer: wait for it (briefly),
    // unless the address itself needs fixing first (then there's nothing to wait for)
    const home = homeAddressId() && byId[homeAddressId()];
    if (areaWaiting() && !(home && fieldError(home, homeAddressNow(), lang))) {
      setBusy(true);
      try { await Promise.race([flushArea(), wait(9000)]); } finally { setBusy(false); }
      if (moved()) return;
    }
    // A suggestion picked a moment ago, its parts still coming: wait for them rather than say to pick one
    if (placing) {
      setBusy(true);
      try { await Promise.race([placing, wait(8000)]); } finally { setBusy(false); }
      if (areaWaiting()) { setBusy(true); try { await Promise.race([flushArea(), wait(9000)]); } finally { setBusy(false); } }
      if (moved()) return;
    }
    // Recording with the camera when Continue is pressed: stopped and used as the video (as Stop does, and as
    // Back does), then Continue waits for its upload like any other (not "Please upload your video" over it)
    if (recorder?.rec && recorder.rec.state !== 'inactive' && screenFieldIds().has(recorder.id)) {
      const id = recorder.id;
      setBusy(true);
      try {
        toggleRecording();
        for (let t = 0; t < 40 && !uploads.has(id) && !files[id] && !moved(); t++) await wait(100);
      } finally { setBusy(false); }
      if (moved()) return;
    }
    // A photo or video on this screen still on its way: Continue waits for it (the button shows it's
    // working) rather than saying it's missing
    const sending = () => [...screenFieldIds()].some(id => uploads.has(id));
    if (sending()) {
      setBusy(true);
      try { for (let t = 0; t < 600 && sending() && !moved(); t++) await wait(200); } finally { setBusy(false); }
      if (moved()) return;
      if (sending()) { navNote('waitUploads', true); return; }
    }
    const a = readAnswers();
    // Only this screen's questions: the ones still to come get their own turn
    const here = screenFieldIds();
    const errors = Object.fromEntries(Object.entries(formErrors(form, a, files, [currentId], lang)).filter(([id]) => here.has(id)));
    // An address line searched but not chosen from, the check's question about the home: their own words
    for (const id of here) {
      const type = byId[id]?.type;
      if (type === 'address' || type === 'date' || (type === 'area' && errors[id])) { const m = errorFor(id); if (m) errors[id] = m; }
    }
    // An answer here that means we can't help (a home far outside the area, a rented one): said first, before
    // asking for the rest of the screen (an iPad has "Have you applied before?" beside the far home's map)
    const early = Object.keys(errors).length ? stopFor(form, a) : null;
    const earlyFrom = early && early.page === currentId ? (here.has(early.field) ? early.field : byId[early.field]?.type === 'area' && here.has(homeAddressId()) ? homeAddressId() : null) : null;
    if (earlyFrom && !errors[earlyFrom] && !errors[early.field]) { showStop(early); pushLoc({ stop: true }); return; }
    if (Object.keys(errors).length) { showPageErrors(errors); return; }
    // And every screen before this one: a screen passed without its own Continue (an opened group took
    // them on to a screen of its own, the browser's Forward) is checked now, and they go back to it
    const behind = fromReview || previewing ? null : behindErrors(a);
    if (behind) {
      await show(behind.page, { dir: -1, focusField: behind.id });
      replaceLoc();
      const there = screenFieldIds();
      showPageErrors(Object.fromEntries(Object.entries(behind.errors).filter(([id]) => there.has(id))));
      return;
    }
    const last = !screenAhead();
    const stop = stopFor(form, a);
    // An answer on a screen before this one that means we can't help (the check, asked again once the connection
    // was back, placed the home outside the area): said now, not after the photos and the video
    if (stop && order(stop.page) < order(currentId) && !previewing) { showStop(stop); pushLoc({ stop: true }); return; }
    // The address decides the service-area answer, so its screen stops too (a phone has the map on the next)
    const decides = stop && byId[stop.field]?.type === 'area' && here.has(homeAddressId());
    if (stop && stop.page === currentId && (here.has(stop.field) || decides || last)) { showStop(stop); pushLoc({ stop: true }); return; }
    // The home's address changed from the review to one outside the area (or one the check couldn't place):
    // what that means, on its own screen, before the review
    const card = fromReview === 'answer' && here.has(homeAddressId()) && areaField() ? fieldEl(areaField().id)?.querySelector('[data-area-result]') : null;
    const toCard = !!card && !onScreen(card) && areaPlaced()?.band !== 'inside';
    setBusy(true);
    try {
      if (!(await start())) return;
      if (toCard) await show(currentId, { dir: 1, piece: card, step: 1 });
      else if (fromReview === 'answer' || (fromReview && last)) { const was = reviewBack; await show('review', { dir: 1 }); landOnReview(was); }
      else if (detourHere(last)) { const d = detour; detour = null; await show(d.page, { dir: 1, piece: d.piece && pageEl(d.page)?.contains(d.piece) ? d.piece : null, screen: 'open' }); }
      else if (!last) await show(currentId, { dir: 1, screen: screenNo + 1, step: 1 });
      else {
        const ids = stepIds(a);
        await show(ids[ids.indexOf(currentId) + 1] || 'review', { dir: 1 });
      }
      pushLoc(); // the browser's Back comes back to the screen they've just left
      save();
    } finally {
      setBusy(false);
    }
  }
  /** The first question before this screen with an answer still missing or wrong: { page, id, errors } */
  function behindErrors(a) {
    const ids = stepIds(a);
    const at = ids.indexOf(currentId);
    if (at < 0) return null;
    const errors = formErrors(form, a, files, ids.slice(0, at + 1).filter(id => id !== 'review'), lang);
    for (const id of Object.keys(errors)) if (byId[id]?.type === 'address') errors[id] = errorFor(id) || errors[id];
    // On this page, only the screens before this one (this one's were just checked). A question drawn in pieces (the
    // service area's card, map and question) is still to come while any of its pieces is
    const later = new Set();
    if (currentId !== 'review') {
      for (let n = screenNo; n < screensIn(currentId); n++) {
        screenFieldIds(currentId, n).forEach(id => later.add(id));
        for (const k of packs[currentId]?.[n] || []) { const own = k.closest?.('[data-field]'); if (own) later.add(own.dataset.field); }
      }
    }
    // A photo still on its way, the check still placing the home: not missing
    const first = fields.find(f => errors[f.id] && !later.has(f.id) && !uploads.has(f.id) && !(f.type === 'area' && areaWaiting()));
    return first ? { page: first.page, id: first.id, errors } : null;
  }
  /** A screen back (from a page's first, the last screen of the page before); false at the very start */
  function back() {
    if (moving || submitting || performance.now() < calmUntil) return true;
    navNote(null);
    keepHeldAddresses();
    const before = currentId === 'review' ? -1 : screenBefore();
    const ids = stepIds();
    const at = ids.indexOf(currentId);
    // With an entry behind this one, Back is the browser's Back: the screen they came from, and its Forward
    // comes back here. Without one (the first entry), the screen before, which this entry then is
    // (the browser's Back lands a moment later: a double click counts once, as it does on Continue)
    if (depth > 1 && histOk()) { calmUntil = performance.now() + 350; history.back(); return true; }
    if (before < 0 && at <= 0) return false;
    (before >= 0 ? show(currentId, { dir: -1, screen: before, step: -1 }) : show(ids[at - 1], { dir: -1, screen: 'last' })).then(() => { replaceLoc(); save(); });
    return true;
  }
  /** Jump to a page already reached (the steps list, Edit, Answer it, Change) */
  /**
   * Back on the review after changing one answer: at that answer (a long "Show all answers" list isn't scrolled
   * through again), with the keys on its Change; its step's row when the answer's isn't open
   */
  function landOnReview(back) {
    reviewBack = null;
    if (!back || currentId !== 'review') return;
    // The answer's Change, else its step's own Edit (a button: the step's section carries its page too, and
    // focus on a section goes nowhere)
    const stepEdit = (pid) => ui.reviewList.querySelector(`button[data-edit=""][data-page="${CSS.escape(pid || '')}"]`);
    const btn = (back.edit && [...ui.reviewList.querySelectorAll(`button[data-edit="${CSS.escape(back.edit)}"]`)].find(b => b.getClientRects().length))
      || stepEdit(back.page || pageOf(back.edit));
    if (!btn?.getClientRects().length) return;
    requestAnimationFrame(() => {
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      btn.focus({ preventScroll: true });
    });
  }
  /** On the last screen of a step they went back to (Edit on the overview, a step in the list): Continue goes back to where they were */
  const detourHere = (lastScreen) => !!detour && lastScreen && !fromReview && currentId !== 'review' && order(currentId) < order(detour.page);
  /** Going back to an earlier step: where they were, kept for its Continue (the furthest of a few such trips) */
  function takeDetour(id) {
    if (!currentId || currentId === 'review' || order(id) >= order(currentId)) { if (order(id) >= order(detour?.page)) detour = null; return; }
    if (!detour || order(currentId) >= order(detour.page)) detour = { page: currentId, piece: resumePiece || packs[currentId]?.[screenNo]?.[0] || null };
  }
  function jump(id, { focusField = null, whole = true } = {}) {
    if ((!reached(id) && !previewing) || doneShown) return; // sent: the steps are closed
    if (id === currentId && !focusField) { ui.steps.open = false; return; } // the step they're on: the list closes
    keepHeldAddresses();
    if (currentId !== 'review') takeDetour(id);
    const dir = Math.sign(order(id) - order(currentId));
    if (dir > 0) {
      const stop = stopFor(form, readAnswers());
      if (stop && order(stop.page) < order(id)) { showStop(stop); return; }
    }
    if (currentId === 'review' && id !== 'review') fromReview = whole ? 'step' : 'answer';
    show(id, { dir, focusField, screen: 'open' }).then(() => { pushLoc(); save(); }); // Back returns to where they jumped from
  }
  function setBusy(on) {
    busy = on;
    clearTimeout(busyTimer);
    // A second press is ignored straight away; the button only dims, with its turning wheel, when the
    // wait is long enough to see (the server, a check), so a screen change has nothing moving after it
    if (on) busyTimer = setTimeout(() => { busyShown = true; paintNav(); }, 300);
    else if (busyShown) { busyShown = false; paintNav(); }
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
    // Entered by hand: which part is missing (the generic words made them hunt for it), and what's wrong with
    // the ones filled in (a ZIP short a digit, a street without its number), all said at once, not one per Continue
    if (box?.dataset.mode === 'parts') {
      const v = a[id] || {};
      const missing = ['line1', 'city', 'state', 'zip'].filter(k => !String(v[k] || '').trim());
      if (missing.length === 4 && !f.required) return null;
      const said = [];
      if (missing.length) {
        const names = missing.map(k => T(k === 'line1' ? 'street' : k));
        said.push(T('addressMissing', { parts: names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} ${T('and')} ${names[names.length - 1]}` }));
      }
      // The missing parts stood in for, so only the filled ones are checked: the ZIP first, then the street
      const filled = { line1: v.line1 || '1 Main St', line2: v.line2 || '', city: v.city || 'City', state: v.state || 'GA', zip: v.zip || '30000' };
      const first = fieldError(f, filled, lang);
      if (first) said.push(first);
      const street = first && first === fieldError(f, { ...filled, line1: '1 Main St', line2: '' }, lang) ? fieldError(f, { ...filled, zip: '30000' }, lang) : null;
      if (street) said.push(street);
      return said.join(' ') || null;
    }
    // A date half typed, or one that isn't (February 30): the box has words in it, so not "Please answer this question"
    if (f.type === 'date' && fieldEl(id)?.querySelector('input[type=date]')?.validity?.badInput) return fieldError(f, 'not a date', lang);
    return fieldError(f, isUpload(f) ? files[id] : a[id], lang) || namedError(f, a, lang);
  }
  function setFieldError(id, msg) {
    const el = fieldEl(id);
    if (msg) shown.add(id); else shown.delete(id);
    if (!el) return;
    const p = el.querySelector('.af-error');
    el.classList.toggle('af-field--error', !!msg);
    if (p && p.textContent !== (msg || '')) p.textContent = msg || '';
    const box = el.closest('.af-more');
    if (box) paintGroupRemove(box);
    if (sug.el === el) suggestNote();
    // The boxes the note is about: an address's parts still empty, or the one that's wrong (a ZIP short a
    // digit, a PO box for the street); never the optional apartment
    const wrong = (i) => {
      const part = i.dataset.part;
      const v = i.value.trim();
      if (!part) return true;
      if (part === 'line2') return false;
      if (!v) return true;
      if (part === 'zip') return !/^\d{5}(-\d{4})?$/.test(v);
      return part === 'line1' && (/\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i.test(v) || (id === 'address' && !/\d/.test(v)));
    };
    const errId = p?.id;
    el.querySelectorAll('input:not([type=file]), textarea, select').forEach(i => {
      const bad = !!msg && wrong(i);
      if (bad) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid');
      // A name's or address's own boxes read the note too (a screen reader landing on "First name" hears it,
      // not only one going in at the group's legend)
      if (!errId || !(i.dataset.part || i.hasAttribute('data-search'))) return;
      const ids = (i.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== errId);
      if (bad) ids.push(errId);
      if (ids.length) i.setAttribute('aria-describedby', ids.join(' ')); else i.removeAttribute('aria-describedby');
    });
  }
  function showPageErrors(errors) {
    for (const f of fields) if (f.page === currentId) setFieldError(f.id, errors[f.id] || null);
    const ids = Object.keys(errors);
    ids.forEach(id => touched.add(id));
    announce(ids.length === 1 ? T('attentionOne') : T('attentionMany', { n: ids.length }));
    refitScreen(ids); // the notes take room: the questions close up a little
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
    // To the question; and when it has a note, the note in view too (on a tall question, the map and its
    // question over its answers, the note is what they need to see)
    const note = [...el.querySelectorAll('.af-error')].find(n => n.textContent.trim() && n.getClientRects().length);
    // (already in view between the bar across the top and Back / Continue: the screen stays as it is, its top too)
    const r = el.getBoundingClientRect();
    const seen = r.top >= (ui.top?.getBoundingClientRect().bottom || 0) + 4 && r.bottom <= (ui.form.querySelector('[data-nav]')?.getBoundingClientRect().top ?? innerHeight) - 4;
    if (!seen) {
      el.scrollIntoView({ block: 'start', behavior: note || reducedMotion() ? 'auto' : 'smooth' });
      note?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
    // An address entered by hand: the part the note is about (still empty, or a ZIP short a digit), not the street they've typed
    const box = addrBox(el);
    const empty = box?.dataset.mode === 'parts' ? box.querySelector('[data-part][aria-invalid="true"]:not([disabled])') : null;
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
  /**
   * Saved, after Save and exit: "here whenever you come back", unless this browser won't keep their place (every
   * cookie blocked): then the way back is a link, a tap away
   */
  function savedOnExit() {
    if (canKeep || testRun) notice('exitSaved', 'success');
    else notice('exitSavedNoStore', 'info', 'emailLink');
  }
  function notice(m, kind = 'info', act = null) {
    lastNotice = m ? { m, kind, act, at: Date.now() } : null;
    paintNotice();
    clearTimeout(noticeTimer);
    if (m && kind === 'success') noticeTimer = setTimeout(passNotice, 8000);
  }
  // A note that's good news ("Welcome back") is there for a moment on the application's screens: read, it goes
  // (it stays on the overview, which has room for it)
  let noticeTimer = 0;
  // Pages whose screens were fitted with a note at the top: fitted again without it, once it's gone (never the
  // screen they're on, under them: the next time a page is shown)
  const packedWithNote = new Set();
  const passing = () => !ui.notice.hidden && lastNotice?.kind === 'success'; // a note that goes by itself
  function forgetNotePacks(showing = null) {
    if (!packedWithNote.size || !ui.notice.hidden) return;
    for (const id of [...packedWithNote]) {
      if (id === currentId && id !== showing) continue;
      delete packs[id];
      packedWithNote.delete(id);
    }
  }
  function passNotice() {
    const was = lastNotice;
    if (was?.kind !== 'success') return;
    if (!focused || ui.notice.hidden) { noticeTimer = setTimeout(passNotice, 8000); return; }
    const done = () => { if (lastNotice === was) notice(null); };
    if (reducedMotion() || !ui.notice.animate) { done(); return; }
    const h = ui.notice.offsetHeight;
    ui.notice.animate([{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px', borderWidth: '0px' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.then(done, done);
  }
  /**
   * A note at the top that stopped being true goes: "Not saved yet" once it's saved, "A few answers need
   * attention" once none do, "add your photos and video again" once they're added, "…is being added as your
   * video" once it's in (or didn't make it)
   */
  function retireNotices({ videoDone = false } = {}) {
    const m = Array.isArray(lastNotice?.m) ? lastNotice.m[0] : lastNotice?.m;
    if (['exitNotSaved', 'exitNotSavedServer', 'exitNotSavedBusy'].includes(m) && lastSave === 'saved') { if (focused) notice(null); else savedOnExit(); }
    else if (m === 'attention' && currentId === 'review' && !Object.keys(formErrors(form, readAnswers(), files, null, lang)).length) notice(null);
    else if (m === 'renewedFiles' && !fields.some(f => isUpload(f) && uploadUi[f.id]?.msg === 'fileAgain')) notice('renewed', 'info');
    else if (['recKept', 'recKeptLang'].includes(m) && videoDone) {
      // Read first: it says why the camera stopped (an upload that's over at once mustn't take the words away with it)
      const was = lastNotice;
      setTimeout(() => { if (lastNotice === was) notice(null); }, Math.max(0, 6000 - (Date.now() - was.at)));
    }
  }
  function paintNotice() {
    ui.notice.textContent = lastNotice ? say(lastNotice.m) : '';
    // A note with something to do about it ("Open that one instead"): its button after its words
    if (lastNotice?.act) {
      const words = document.createElement('span');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'af-btn af-btn--link af-notice-act';
      b.dataset.noticeAct = lastNotice.act;
      b.textContent = T(lastNotice.act);
      words.append(say(lastNotice.m), ' ', b);
      ui.notice.replaceChildren(words);
    }
    ui.notice.dataset.kind = lastNotice?.kind || 'info';
    // A saved application that couldn't open: said once on the page, at the top (the hero's note)
    ui.notice.hidden = !lastNotice || (!focused && !root.hidden && ['resumeFailed', 'linkExpired'].includes(lastNotice.m));
  }
  /**
   * The note at the top, said over the screen they were sent back to ("A few answers need attention"): clear of the
   * bar across the top, as far as the box with the cursor can go down and stay clear of Back / Continue
   */
  function noticeInView() {
    if (ui.notice.hidden || !focused) return;
    const under = (ui.top?.getBoundingClientRect().bottom || 0) + 12 - ui.notice.getBoundingClientRect().top;
    if (under <= 0 || window.scrollY <= 0) return;
    const navTop = ui.form.querySelector('[data-nav]')?.getBoundingClientRect().top ?? innerHeight;
    const box = document.activeElement?.closest?.('[data-field]')?.getBoundingClientRect();
    const room = box ? navTop - 12 - Math.min(box.bottom, box.top + 96) : under; // (its question and box at least)
    const by = Math.min(under, window.scrollY, Math.max(0, room));
    if (by > 0) window.scrollBy({ top: -by, behavior: 'auto' });
  }
  /** A notice their own press led to (Submit, on an expired draft): in view, with the keys on it */
  function readNotice() {
    if (ui.notice.hidden) return;
    ui.notice.tabIndex = -1;
    ui.notice.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    ui.notice.focus({ preventScroll: true });
  }
  /** A note by the buttons, where the family is looking (reason = why Submit is off) */
  function navNote(m, reason = false) {
    lastNav = m ? { m, reason } : null;
    paintNavNote();
  }
  function paintNavNote() {
    const was = ui.navNote.hidden ? '' : ui.navNote.textContent;
    const text = lastNav ? say(lastNav.m) : '';
    ui.navNote.textContent = text;
    ui.navNote.hidden = !lastNav;
    // Heard as well as seen (a screen reader on Submit hears why it didn't go), and Continue / Submit described by it
    if (text && text !== was) announce(text);
    if (text) ui.next.setAttribute('aria-describedby', ui.navNote.id); else ui.next.removeAttribute('aria-describedby');
  }
  const TOP_SAVE = { saved: 'savedShort', offline: 'offlineShort', notSaved: 'notSavedShort', paused: 'pausedShort' };
  function saveState(key) {
    // Heard only when it matters: saving stopped (offline, the server), and saved again after that; not
    // "Saving…" and "All changes saved" after every pause in typing
    const trouble = (k) => ['offline', 'notSaved', 'paused'].includes(k);
    if (trouble(key) && /^welcomeBack/.test(lastNotice?.m || '')) notice(null); // "Your answers are saved" isn't so just now
    if (trouble(key) && !trouble(lastSave)) announce(T(key));
    else if (key === 'saved' && trouble(lastSave)) announce(T('saved'));
    lastSave = key;
    if (key === 'saved') retireNotices();
    paintSaveState();
    if (!focused) paintHub(); // the overview's "Your application is saved" waits for it to be
  }
  function paintSaveState() {
    for (const el of ui.saveStates) {
      const top = !!el.closest('[data-top]');
      const quiet = lastSave === 'unsaved' && top; // it saves on its own a moment later
      // The bar's line is short (a phone has room for a few words): the whole of it, never cut off
      el.textContent = lastSave && !quiet ? T(top && TOP_SAVE[lastSave] ? TOP_SAVE[lastSave] : lastSave) : '';
      el.dataset.kind = quiet ? '' : lastSave || '';
    }
  }

  // ── Server calls ─────────────────────────────────────────────────
  async function start({ renew = null } = {}) {
    if (previewing || token) return true; // a preview walks the pages and saves nothing
    if (testRun?.signIn) { navNote({ raw: TEST.signInNote }); return false; }
    if (turnstileSiteKey && !turnstileToken && !testRun && !renew) {
      // The check passes on its own in a moment (Continue looks busy meanwhile); said only when it wants a tap
      if (!turnstileWants && !turnstileFailed) await Promise.race([new Promise(r => turnstileWaiting.push(r)), wait(6000)]);
      if (token) return true;
      if (!turnstileToken) { askCheck(); return false; }
    }
    // Another tab or window on this device started one since this page opened: that one, where they left off
    // there (not a second application, and this device then remembering only the second)
    if (!renew && !testRun && othersStarted()) {
      await resume();
      if (token) { notice('pickedUp', 'info'); announce(T('pickedUp')); return false; }
    }
    let r;
    try { r = await api({ action: 'start', kind, year, lang, turnstileToken, website: ui.honeypot?.value || '', ...(renew ? { renew } : {}), ...(testRun ? { test: true } : {}) }); } catch { r = { ok: false }; }
    if (token) return true; // started meanwhile (a second press)
    if (r.code === 'staff-only') { testRun = { signIn: true }; paintTestBar(); }
    if (!r.ok) {
      if (renew) return false; // said by expired()
      // The quick check's own words here (the server's are English and name a different button)
      if (r.code === 'turnstile') { resetTurnstile(); askCheck(); } else navNote(r.error ? { raw: r.error } : 'startFail');
      return false;
    }
    token = r.token;
    rev = 0;
    synced = {};
    linkGone = false;
    checkAsked = false;
    turnstileToken = null; // used: a new application (another child) has the check again
    if (['linkExpired', 'resumeFailed', 'expired'].includes(lastNotice?.m)) notice(null); // about the one before this
    if (!canKeep && !testRun) notice('noStorage', 'info'); // their way back is the emailed link
    remember();
    paintNav();
    return true;
  }
  /** The quick check wants a tap: it shows on the screen they're on, in view (not under Continue) */
  let checkAsked = false;
  let turnstileWants = false;
  let turnstileFailed = false;
  const turnstileWaiting = [];
  function askCheck() {
    checkAsked = true;
    navNote(turnstileFailed ? 'turnstileFailed' : 'turnstile');
    paintNav();
    if (!ui.turnstile || ui.turnstile.hidden) return;
    requestAnimationFrame(() => ui.turnstile.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }));
  }

  // One save on its way at a time, and one waiting behind it at most: it sends what's here when its turn comes
  // (so a few saves asked for on a slow connection go as one), and "All changes saved" waits for the last
  // Why Save and exit couldn't save: offline, our server busy (it asked them to wait), or no answer from it
  const notSavedWord = () => (lastSave === 'offline' ? 'exitNotSaved' : lastSave === 'paused' ? 'exitNotSavedBusy' : 'exitNotSavedServer');
  let saveWaiting = null;
  let lastSent = null; // what the last save that went through said (one after it with nothing new isn't sent)
  let mustSend = false; // ...except one that has to reach the server: Submit's, and one that brings in another device's save
  function save({ force = false } = {}) {
    if (!token || previewing) return Promise.resolve(true);
    if (force) mustSend = true;
    clearTimeout(dirtyTimer);
    saveState('saving');
    if (saveWaiting) return saveWaiting;
    const turn = saveChain.then(async () => {
      saveWaiting = null; // a change from here on is the next save's
      const ids = stepIds();
      const page = currentId === 'review' ? ids[ids.length - 2] : currentId;
      const now = readAnswers();
      const body = { action: 'save', token, answers: now, page, lang };
      // The save it follows, and what's changed here since (see saveDraft): asked once it's this one's turn
      const changed = Object.keys(now).filter(id => !sameAnswer(now[id], synced?.[id]));
      if (!mustSend && !changed.length && lastSent && lastSent.token === token && lastSent.page === page && lastSent.lang === lang) {
        saveState(saveWaiting ? 'saving' : 'saved'); // nothing new since the one before (Save and exit after Continue)
        return true;
      }
      lastSent = null;
      mustSend = false;
      try {
        const r = await api({ ...body, rev, changed });
        if (r.ok) {
          if (Number.isInteger(r.rev)) rev = r.rev;
          synced = { ...now };
          lastSent = { token: body.token, page, lang };
          if (r.theirs) takeTheirs(r, now);
          // Saved, unless more is on its way (still "Saving…") or was typed meanwhile (its save follows): a page
          // closed then still sends it
          if (saveWaiting) saveState('saving');
          else if (!sameAnswer(readAnswers(), synced)) markDirty();
          else saveState('saved');
          retries = 0;
          keepPending(); // anything typed since stays kept; nothing left: forgotten
          return true;
        }
        if (r.code === 'no-draft') { await expired(body.token); return false; }
        // Sent from another device or tab: this one says so (what's typed here since can't be added)
        if (r.code === 'submitted') { if (body.token === token && !doneShown) finished(true, { elsewhere: true }); return true; }
        saveState(r.status === 429 ? 'paused' : 'notSaved');
        keepPending();
        retrySave();
        return false;
      } catch {
        saveState('offline');
        keepPending();
        retrySave();
        return false;
      }
    });
    saveChain = turn;
    saveWaiting = turn;
    return turn;
  }
  // "We will try again" / "…will save when you reconnect": it does, sooner when the connection's back
  let retryTimer = 0;
  let retries = 0;
  const unsaved = () => ['offline', 'notSaved', 'paused'].includes(lastSave);
  function retrySave() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (unsaved() && token && !doneShown) save(); }, Math.min(60000, 5000 * 2 ** retries++));
  }
  window.addEventListener('online', () => {
    if (lastNav?.m === 'offlineSubmit') navNote(null); // "you seem to be offline" isn't so now (Submit goes again)
    const laterNote = ui.dialog.querySelector('[data-later-status]');
    if (ui.dialog.open && laterNote?.textContent === T('sendOffline')) laterNote.textContent = ''; // nor in "Save and finish later"
    if (unsaved() && token && !doneShown) save();
  }, { signal });
  function markDirty() {
    if (!token || previewing) return;
    saveState('unsaved');
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(save, 4000);
    // Kept at once (not a moment later): a tab opened now reads what's here, never an answer already changed back
    keepPending();
  }
  /** This page's answers the server doesn't have yet, on this device (see `pending`) */
  function keepPending() {
    if (!token || previewing || doneShown) return;
    const now = readAnswers();
    const changed = {};
    for (const id of Object.keys(now)) if (!sameAnswer(now[id], synced?.[id])) changed[id] = now[id];
    // (and the screen they were on: a new tab opens there)
    const where = currentId && currentId !== 'review' && packs[currentId] ? screenAt(currentId, screenNo) : {}; // (Save and exit's save lands after they've left it)
    if (Object.keys(changed).length) pending.set({ token, changed, page: currentId, field: where.field || null, area: where.area || null, at: Date.now() });
    else pending.clear();
  }
  /**
   * The saved application expired with this page still open (weeks on): a new one with the answers here,
   * at once (it passed the quick check for the old one). Its photos and video went with it: added again
   */
  async function expired(was = token) {
    if (!was || was !== token) return; // about one already replaced
    forgetRemoved();
    store.clear();
    token = null;
    saveState(null); // nothing left to save to ("Saving…" forever otherwise)
    let lost = 0;
    for (const f of fields) {
      if (!isUpload(f) || !files[f.id]) continue;
      delete files[f.id];
      uploadUi[f.id] = { state: 'empty', msg: 'fileAgain' };
      paintUpload(f.id);
      lost++;
    }
    if (lost) uploadsChanged();
    // Once a page (a new one that's "gone" at once isn't started again and again)
    if (!renewed && await start({ renew: was })) { renewed = true; notice(lost ? 'renewedFiles' : 'renewed', 'info'); save(); return; }
    resetTurnstile(); // Continue starts a new one, with the quick check again
    notice('expired', 'error');
  }
  let renewed = false;
  const sameAnswer = (x, y) => JSON.stringify(x ?? '') === JSON.stringify(y ?? '');
  /**
   * Answers saved from somewhere else since this page last had them (the emailed link on another device,
   * a tab left open): shown here, and the photos added there; an answer changed here meanwhile stays
   * this page's (its next save says so)
   */
  let theirsTaken = 0; // times another device's answers were brought in (Submit looks before it sends)
  function takeTheirs(r, sent) {
    const now = readAnswers();
    const took = [];
    for (const [id, v] of Object.entries(r.theirs || {})) {
      const f = byId[id];
      if (!f || !isInput(f) || !sameAnswer(now[id], sent[id])) continue;
      answers[id] = v;
      writeField(f, v);
      synced[id] = readField(f);
      took.push(id);
    }
    const gotFiles = takeFiles(r.files || {});
    if (order(r.maxPage) > order(furthestId)) { furthestId = r.maxPage; remember(); if (!focused) aheadElsewhere = true; }
    if (!took.length && !gotFiles) { paintHeader(); return; }
    theirsTaken++;
    openAnsweredTucked();
    if (homeAddressId() && took.includes(homeAddressId()) && !areaPlaced() && checkable(homeAddressNow())) scheduleArea(true);
    paintArea();
    refresh({ animate: false });
    replan(true);
    if (currentId === 'review') buildReview();
    notice('fromElsewhere', 'success');
  }
  /** Photos and the video as the draft has them, where this page doesn't know of them yet (or they went): true if any did */
  function takeFiles(rf) {
    let any = false;
    for (const f of fields) {
      if (!isUpload(f) || uploads.has(f.id)) continue;
      const pf = rf[f.id];
      const had = !!files[f.id];
      if (pf && !had) {
        if (f.type === 'video') {
          if (!pf.uploaded) continue;
          files.video = { uid: true, uploaded: true, name: pf.name };
          uploadUi.video = { state: 'done', msg: ['videoDone', { name: pf.name }] };
        } else {
          files[f.id] = { key: true, name: pf.name };
          uploadUi[f.id] = { state: 'done', msg: ['added', { name: pf.name }] };
          if (pf.hasThumb) loadThumb(f.id);
        }
      } else if (!pf && had && uploadUi[f.id]?.state === 'done') {
        delete files[f.id];
        uploadUi[f.id] = { state: 'empty' };
      } else continue;
      paintUpload(f.id);
      any = true;
    }
    if (any) uploadsChanged();
    return any;
  }
  /** A photo's small preview from the draft, so they see which one it is (not a gray box) */
  function loadThumb(id) {
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'thumb', token, field: id }) })
      .then(res => (res.ok ? res.blob() : null))
      .then((b) => { if (b && files[id] && uploadUi[id]?.state === 'done' && !uploadUi[id].thumb) setUpload(id, { thumb: URL.createObjectURL(b) }); })
      .catch(() => {});
  }
  // A tab coming back into view (the phone picked up again after the laptop): saved from somewhere else
  // since? Then a save brings that in before they carry on here
  let peeking = false;
  async function peek() {
    if (!token || previewing || doneShown || peeking || rev == null) return;
    peeking = true;
    try {
      const r = await api({ action: 'peek', token }).catch(() => null);
      if (r?.code === 'submitted') { finished(true, { elsewhere: lastSave === 'unsaved' || unsaved() }); return; }
      if (r?.code === 'no-draft') { await expired(); return; }
      if (!r?.ok) return;
      if (r.rev !== rev) await save({ force: true }); // (with nothing new here too: it's what brings theirs in)
      else if (takeFiles(r.files || {})) notice('fromElsewhere', 'success');
    } finally {
      peeking = false;
    }
  }

  // ── Stop screens ─────────────────────────────────────────────────
  function showStop(stop) {
    stopShown = stop;
    if (lastNotice?.kind === 'success') notice(null); // "Welcome back" isn't what this screen is about
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
  /** The question to change: the address when the check placed it (its answer came from there), else the one they answered */
  const stopField = () => {
    const id = stopFromArea() && areaPlaced() && homeAddressId() ? homeAddressId() : stopShown?.field;
    return id && fieldEl(id) ? id : null;
  };
  function paintStop() {
    const s = form.stops?.[stopShown.key] || {};
    ui.stopTitle.textContent = s.title || '';
    ui.stopBody.innerHTML = s.body || '';
    const placed = stopFromArea() ? areaPlaced() : null;
    // The service area's own map (as staff draw it), with the home on it when the check placed it: never the
    // older picture, whether the stop came from the check, their own answer, or the server's look at Submit
    const areaStop = stopShown.key === 'outside' && !!areaField();
    if (placed) ui.stopMap.innerHTML = `<div class="af-map af-map--stop">${areaMapHtml(form.serviceArea, { ...placed }, mapWords(lang, true, kind))}</div>`;
    else if (areaStop) ui.stopMap.innerHTML = `<div class="af-map af-map--stop">${areaMapHtml(form.serviceArea, null, mapWords(lang, false, kind))}</div>`;
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
    // The stop has its own entry in the browser's history: going back is leaving it, as the browser's Back
    // does (so their next Back is the screen before, not this one again or the one they went on to)
    if (histOk() && trail[depth]?.stop) { history.back(); return; }
    const field = stopField();
    stopShown = null;
    ui.stop.hidden = true;
    ui.form.hidden = false;
    show(currentId, { focusField: field, at: field }).then(replaceLoc);
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
    // An answer that stops the application (one brought in from another device, say): never "Everything is here"
    // over it, but that answer marked, with its Change, before Submit lands on the "can't help" screen
    const stop = stopFor(form, a);
    if (stop?.field && byId[stop.field] && !errors[stop.field]) errors[stop.field] = T('reviewStopAnswer');
    const missing = Object.keys(errors).length;
    if (!missing && lastNotice?.m === 'attention') notice(null); // fixed since
    ui.reviewSummary.dataset.kind = missing ? 'missing' : 'ready';
    ui.reviewSummary.textContent = stop?.field && byId[stop.field] ? T('reviewStopped') : missing ? (missing === 1 ? T('reviewMissingOne') : T('reviewMissing', { n: missing })) : T('reviewReady');
    // An email they gave that's likely a typo (they're written to there): asked about, with the fix a tap away
    const mails = fields.filter(f => f.type === 'email' && isVisible(f, a, byId) && mailFix(a[f.id]));
    ui.reviewSummary.parentElement.querySelectorAll('.af-review-mail').forEach(n => n.remove());
    for (const f of mails) {
      const fix = mailFix(a[f.id]);
      const p = document.createElement('p');
      p.className = 'af-mailfix af-review-mail';
      const [before, after] = T('reviewMailCheck', { email: a[f.id] }).split('{fix}');
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.mailfixReview = f.id;
      b.dataset.fix = fix;
      b.textContent = fix;
      b.setAttribute('aria-label', T('mailFixUse', { email: fix }));
      p.append(before || '', b, after || '');
      ui.reviewSummary.after(p);
    }
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
          const word = f.id === stop?.field ? 'change' : 'fix'; // an answer to change, not one to give
          fix.textContent = T(word);
          fix.setAttribute('aria-label', `${T(word)}: ${f.label || ''}`);
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
        // A definition list holds terms and definitions only: Change sits in one of its own
        if (change) { const act = document.createElement('dd'); act.className = 'af-review-act'; act.append(change); row.append(act); }
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

  // While it sends, the ways out wait ("Saved… look it over and submit" while it was going was wrong)
  let submitting = false;
  function paintSubmitting() {
    if (ui.exit) ui.exit.disabled = submitting;
    ui.saveLaters.forEach(b => { b.disabled = submitting; });
    // While it sends, the review stays as sent: its Change buttons, the steps and the language wait (a change
    // made now would never be sent, and the thank-you would cover it)
    for (const el of [ui.reviewList, ui.railList, ui.steps, ui.back, ...ui.langSwitches]) if (el) el.inert = submitting;
    root.toggleAttribute('data-sending', submitting);
  }
  async function submit() {
    if (previewing) { navNote('previewSent'); return; }
    if (uploads.size) { navNote('waitUploads', true); return; }
    setBusy(true);
    submitting = true;
    paintSubmitting();
    try {
      await dropRemoved(); // sent without what they removed
      if (!(await start())) return; // expired, and a new one couldn't start just now (it says why)
      // Sent only as it is here: a save that didn't go would send the answers from before it
      const was = token;
      const theirs = theirsTaken;
      const saved = await save({ force: true }); // always asked (another device may have saved since: shown, never sent unseen)
      if (doneShown) return; // it turned out to be sent already (another device)
      // Another device's changes came in just now: shown on the review first, never sent unseen
      if (theirsTaken !== theirs && currentId === 'review') { buildReview(); notice('reviewTheirs', 'info'); readNotice(); return; }
      // It had expired: the answers went into a new one (or will on Submit), and its note says what's next
      if (token !== was) { readNotice(); return; }
      if (!saved) { navNote(lastSave === 'offline' ? 'offlineSubmit' : 'submitUnsaved'); return; }
      const r = await api({ action: 'submit', token });
      if (r.ok) { finished(); return; }
      if (r.code === 'no-draft') { await expired(); readNotice(); return; } // its note says what happened (a new one: Submit again)
      if (r.code === 'submitted') { finished(true); return; }
      if (r.error === 'stopped' && r.stop) { showStop({ key: r.stop, page: stopFor(form, readAnswers())?.page }); return; }
      if (r.errors && Object.keys(r.errors).length) {
        const ids = Object.keys(r.errors);
        ids.forEach(id => touched.add(id));
        const page = pageOf(ids[0]);
        if (page) {
          fromReview = 'answer';
          show(page, { dir: -1, focusField: ids[0] }).then(() => setTimeout(noticeInView, reducedMotion() ? 0 : 450)); // (once its scroll is done)
          for (const id of ids) setFieldError(id, r.errors[id]);
        }
        notice('attention', 'error');
        return;
      }
      navNote(r.error ? { raw: r.error } : 'submitFail');
    } catch {
      navNote('offlineSubmit');
    } finally {
      submitting = false;
      paintSubmitting();
      setBusy(false);
    }
  }

  // ── The thank-you ────────────────────────────────────────────────
  function finished(already = false, { elsewhere = false } = {}) {
    forgetRemoved();
    store.clear();
    pending.clear();
    if (!testRun && !previewing && (!already || sentStore.get()?.year !== year)) sentStore.set({ year, at: already ? null : Date.now() });
    closeRecorder();
    clearTimeout(dirtyTimer);
    clearTimeout(retryTimer);
    if (ui.dialog?.open) ui.dialog.close();
    doneShown = { already, elsewhere, email: testRun?.by || readAnswers()[emailId] || answers[emailId] || '' };
    saveState(null);
    notice(null);
    ui.form.hidden = true;
    ui.stop.hidden = true;
    ui.done.hidden = false;
    root.classList.add('is-done'); // the steps beside the form have done their job
    paintDone();
    paintHeroNote(); // the page above says it went too (a link opened for one already sent)
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
    line.textContent = doneShown.elsewhere ? T('doneElsewhere') : doneShown.already ? T('doneAgain') : doneShown.email ? T('doneEmail', { email: doneShown.email }) : '';
  }

  // ── Uploads: the box's look ──────────────────────────────────────
  const retryFiles = {}; // fieldId → the file that didn't go (its "Try again")
  // A video on its way can be stopped (a wrong or huge file): its Cancel, or another video dropped on its box.
  // Not once it's all sent (Stream has it then, and it's the video)
  const stopping = {}; // fieldId → { canceled, late, upload, reject, finished } while a video uploads
  const stoppable = (id) => !!stopping[id] && !stopping[id].late && !stopping[id].canceled;
  // An upload the connection dropped goes again by itself once it's back (a video from where it stopped), as it
  // says: at the browser's "online", or a few times over a minute when the drop was a hiccup the browser didn't notice
  const autoTries = {};
  function retryDropped() {
    if (!token || doneShown || previewing) return;
    for (const [id, file] of Object.entries(retryFiles)) {
      if (uploads.has(id) || recorder?.id === id || uploadUi[id]?.msg?.again !== 'uploadOffline' || !byId[id]) continue;
      const el = fieldEl(id);
      if (el?.querySelector('[data-act="retry"]') === document.activeElement) el.querySelector('[data-act="choose"]')?.focus({ preventScroll: true }); // "Try again" steps aside while it goes
      takeFile(byId[id], file);
    }
  }
  function whenBack(id) {
    if (uploadUi[id]?.msg?.again !== 'uploadOffline') { delete autoTries[id]; return; }
    if (!navigator.onLine) return; // its "online" brings it
    const n = autoTries[id] = (autoTries[id] || 0) + 1;
    if (n <= 3) setTimeout(retryDropped, 5000 * 2 ** (n - 1));
  }
  window.addEventListener('online', retryDropped, { signal });
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
    const status = box.querySelector('.af-upload-status');
    status.textContent = msg ? say(msg) : T(video ? 'noVideo' : 'noPhoto');
    // What a screen reader hears: each change, an upload's progress only at each quarter ("Uploading… 25%", not
    // every number the line shows)
    const heard = box.querySelector('[data-upload-said]');
    if (heard) {
      const pct = Array.isArray(msg) && ['uploading', 'uploadingPct'].includes(msg[0]) ? Math.min(75, Math.floor((Number(msg[1]?.pct) || 0) / 25) * 25) : null;
      const words = pct == null ? status.textContent : pct ? say([msg[0], { pct }]) : heard.textContent;
      if (heard.textContent !== words) heard.textContent = words;
    }
    // A problem is read whole, even over a photo already added (a file's name is what's cut short)
    status.toggleAttribute('data-problem', !!msg && ((typeof msg === 'object' && !Array.isArray(msg)) || ['notImage', 'notVideo', 'empty', 'camBlocked'].includes(msg)));
    const done = s.state === 'done';
    const failed = s.state === 'failed';
    box.querySelector('[data-act="remove"]').hidden = !done;
    const undo = box.querySelector('[data-act="undo"]');
    if (undo) undo.hidden = !removing[id] || s.state !== 'empty';
    // Didn't go: the same file again, or another
    const retry = box.querySelector('[data-act="retry"]');
    // Didn't go, the first time or over one already added (its words say "Try again": it's there)
    if (retry) { retry.hidden = !(failed || status.hasAttribute('data-problem')) || !retryFiles[id]; retry.textContent = T('retryUpload'); }
    const choose = box.querySelector('[data-act="choose"]');
    if (s.state === 'busy') choose.setAttribute('aria-disabled', 'true'); else choose.removeAttribute('aria-disabled');
    choose.textContent = done
      ? T(video ? 'chooseOther' : 'replacePhoto')
      : failed && retryFiles[id] ? T(video ? 'chooseOther' : 'choosePhotoOther')
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
    const cancel = box.querySelector('[data-act="cancel"]');
    if (cancel) {
      const had = document.activeElement === cancel;
      cancel.hidden = !(s.state === 'busy' && stoppable(id));
      if (had && cancel.hidden) box.querySelector('[data-act="choose"]')?.focus({ preventScroll: true });
    }
  }
  /** Stop the video on its way: what was there before it (or nothing) is what's there */
  function cancelVideo(id) {
    const c = stopping[id];
    if (!stoppable(id)) return null;
    c.canceled = true;
    try { c.upload?.abort(); } catch { /* stopped either way */ }
    c.reject?.(Object.assign(new Error('canceled'), { canceled: true }));
    return c.finished;
  }
  function uploadsChanged() {
    paintHeader(); // the steps' "Done" too: a photo gone (an expired draft's) undoes its step
    // Save and exit with a photo or video still going: once it's in (or didn't make it), said where they are
    if (!focused && !uploads.size && lastNotice?.m === 'exitUploading') {
      const failed = Object.values(uploadUi).some(u => u?.state === 'failed');
      save().then((ok) => { if (!focused && lastNotice?.m === 'exitUploading') { if (ok && !failed) savedOnExit(); else notice(failed ? 'exitUploadFailed' : notSavedWord(), 'error'); } });
    }
    if (currentId === 'review') buildReview();
    if (!uploads.size || lastNotice?.m === 'renewedFiles') retireNotices();
    // A note that said the photo or video was missing goes once it's in
    for (const id of [...shown]) if (byId[id] && isUpload(byId[id]) && !errorFor(id)) setFieldError(id, null);
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
      xhr.onerror = () => reject(Object.assign(new Error(T('uploadFailed')), { network: true }));
      xhr.send(body);
    });
  }
  const isPhotoFile = (file) => /^image\//.test(file.type || '') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '');
  const isVideoFile = (file) => /^video\//.test(file.type || '') || /\.(mp4|mov|m4v|webm|avi|3gp|mkv)$/i.test(file.name || '');
  /** An upload turned away because the application expired or was sent: as a save's would be (its words, or null) */
  function uploadGone(r, was) {
    if (r?.code === 'no-draft') { expired(was); return T('fileAgain'); }
    if (r?.code === 'submitted') { if (was === token && !doneShown) finished(true, { elsewhere: true }); return T('doneElsewhere'); }
    return null;
  }
  // Words of ours (the form's, or the server's in the family's language) are said as they are. Anything
  // else is the browser's or the uploader's own, in English and technical ("tus: unexpected response…",
  // "Failed to fetch"): what happened is said in plain words instead
  const said = (msg) => Object.assign(new Error(msg), { said: true });
  // What went wrong, and what to do: "Please try again" added only when the words don't already say what to do
  const failText = (e, video = false) => {
    if (e?.key) return { again: e.key }; // a message of ours, kept as its key: a language switch says it in the new one
    const status = e?.originalResponse?.getStatus?.() || 0;
    const dropped = !navigator.onLine || e?.network || e instanceof TypeError || (!!e?.originalRequest && !status);
    if (!(e?.said && e.message)) return { again: dropped ? 'uploadOffline' : video ? 'videoFailed' : 'uploadFailed' };
    const msg = String(e.message).trim();
    return { raw: /try again|again|intent|de nuevo|please|por favor|pruebe|elija|choose|vuelva|another|otro/i.test(msg) ? msg : T('tryAgain', { msg: msg.replace(/[.!]\s*$/, '') }) };
  };

  async function uploadPhoto(f, file) {
    if (!isPhotoFile(file)) { setUpload(f.id, { msg: 'notImage' }); return; }
    if (!file.size) { setUpload(f.id, { msg: 'empty' }); return; } // a cloud file not on the device yet: said as the video says it
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
      body.append('lang', lang); // its problems said in their language
      body.append('field', f.id);
      const name = file.name || 'photo.jpg'; // the name they chose (a PNG made a JPEG here is still "space.png" to them)
      body.append('file', main || file, name);
      if (thumb) body.append('thumb', thumb, 'thumb.jpg');
      setUpload(f.id, { msg: ['uploading', { pct: 0 }], thumb: thumb || main ? URL.createObjectURL(thumb || main) : null });
      const r = await postWithProgress(body, (p) => {
        const pct = Math.min(99, Math.round(p * 100));
        setUpload(f.id, { pct, msg: ['uploading', { pct }] });
      });
      // Not a photo after all (a file renamed .jpg the browser couldn't read): said as the page says it, and another
      // file asked for (the same one again can't go)
      if (r.code === 'not-photo') throw Object.assign(said(T('notImage')), { unusable: true, key: 'notImage' });
      if (!r.ok) throw said(uploadGone(r, body.get('token')) || r.error || T('uploadFailed'));
      files[f.id] = { key: true, name };
      delete retryFiles[f.id];
      delete autoTries[f.id];
      setUpload(f.id, { state: 'done', msg: ['added', { name }], pct: null });
    } catch (e) {
      if (e?.unusable) delete retryFiles[f.id]; else retryFiles[f.id] = file;
      setUpload(f.id, files[f.id] ? { ...before, msg: failText(e), pct: null } : { state: 'failed', msg: failText(e), pct: null });
      whenBack(f.id);
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

  const goingOn = {}; // field id → { sig, url, token }: a video upload cut off, to carry on with (Try again)
  // ...kept on the device too: a reload (a phone that closed the tab while they were in another app) and the same
  // video chosen again carries on from where it stopped, as Try again does, not from 0%
  const videoGoing = local(keyed('soard-application-video'));
  const forgetGoing = (id) => { delete goingOn[id]; if (videoGoing.get()?.field === id) videoGoing.clear(); };
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
    let finish;
    const ctl = stopping[f.id] = { canceled: false, late: false, upload: null, reject: null, finished: new Promise(r => { finish = r; }) };
    const halt = () => { if (ctl.canceled) throw Object.assign(new Error('canceled'), { canceled: true }); };
    // A video already in stays theirs till this one is (the server keeps it too): put back if this one doesn't go
    const before = files[f.id]?.uploaded ? { file: files[f.id], ui: { ...uploadUi[f.id] }, token } : null;
    files[f.id] = { uid: true, uploaded: false, name: file.name };
    setUpload(f.id, { state: 'busy', msg: 'starting', pct: 0, thumb: null });
    uploadsChanged();
    videoThumb(file).then(thumb => { if (thumb && files[f.id]?.name === file.name) setUpload(f.id, { thumb }); });
    try {
      const sig = `${file.name}|${file.size}|${file.lastModified}`;
      for (let fresh = 0; ; fresh++) {
        const was = token;
        // Try again on the same file after the connection dropped (or the page reloaded): on from where it stopped
        // (the same upload, not 0%)
        const kept = videoGoing.get();
        if (!fresh && !goingOn[f.id] && kept?.field === f.id && kept.token === token && kept.sig === sig && kept.url) goingOn[f.id] = { sig, url: kept.url, token };
        let url = !fresh && goingOn[f.id]?.sig === sig && goingOn[f.id].token === token ? goingOn[f.id].url : null;
        if (!url) {
          const r = await api({ action: 'video-url', token, size: file.size, name: file.name, lang });
          halt();
          if (!r.ok) throw said(uploadGone(r, was) || r.error || T('uploadStartFail'));
          url = r.uploadUrl;
          goingOn[f.id] = { sig, url, token };
          videoGoing.set({ field: f.id, sig, url, token });
        }
        try {
          halt();
          await new Promise((resolve, reject) => {
            ctl.reject = reject;
            const upload = ctl.upload = new tus.Upload(file, {
              uploadUrl: url,
              chunkSize: CHUNK,
              retryDelays: [0, 2000, 5000, 10000, 20000, 40000, 60000],
              metadata: { filename: file.name, filetype: file.type },
              storeFingerprintForResuming: false,
              // Its own rule for trying a piece again (tus's), and the box says so while it waits, not a still 0%
              onShouldRetry(err) {
                const status = err?.originalResponse?.getStatus?.() || 0;
                const again = (!(status >= 400 && status < 500) || status === 409 || status === 423) && navigator.onLine !== false;
                if (again) setUpload(f.id, { msg: ['uploadRetrying', { pct: uploadUi[f.id]?.pct || 0 }] });
                return again;
              },
              onError: reject,
              onProgress(sent, total) {
                const pct = Math.floor((sent / total) * 100);
                setUpload(f.id, { pct, msg: ['uploadingPct', { pct }] });
              },
              onSuccess: resolve,
            });
            upload.start();
          });
          break;
        } catch (e) {
          // Its upload link ran out or was let go (Stream keeps one for a while): a new one, once, from the start
          if (!fresh && !ctl.canceled && [404, 410].includes(e?.originalResponse?.getStatus?.())) { forgetGoing(f.id); setUpload(f.id, { pct: 0, msg: 'starting' }); continue; }
          throw e;
        }
      }
      halt();
      ctl.late = true;
      setUpload(f.id, { pct: 100, msg: 'finishing' });
      let uploaded = false;
      for (let i = 0; i < 20 && !uploaded; i++) {
        const done = await api({ action: 'video-done', token, lang });
        if (done.code === 'video-error') throw Object.assign(said(done.error), { unusable: true }); // Stream can't read it: another file, not the same again
        uploaded = !!done.uploaded;
        if (!uploaded) await wait(1500);
      }
      if (!uploaded) throw Object.assign(said(T('videoGone')), { key: 'videoGone' });
      files[f.id] = { uid: true, uploaded: true, name: file.name };
      delete retryFiles[f.id];
      delete autoTries[f.id];
      forgetGoing(f.id);
      setUpload(f.id, { state: 'done', msg: ['videoDone', { name: file.name }], pct: null });
    } catch (e) {
      if (e?.canceled) {
        // Stopped: the server lets go of what came of it (the one before it stays the video)
        forgetGoing(f.id);
        delete retryFiles[f.id];
        delete autoTries[f.id];
        const keep = before && before.token === token;
        if (keep) { files[f.id] = before.file; setUpload(f.id, { ...before.ui, msg: ['videoKept', { name: before.file.name }], pct: null }); }
        else { delete files[f.id]; setUpload(f.id, { state: 'empty', msg: 'videoCanceled', pct: null, thumb: null }); }
        if (token && !previewing) api({ action: 'remove-file', token, field: f.id, ...(keep ? { next: true } : {}) }).catch(() => {});
        return; // (its status line says so)
      }
      if (e?.unusable) { delete retryFiles[f.id]; forgetGoing(f.id); } else retryFiles[f.id] = file;
      if (before && before.token === token) { files[f.id] = before.file; setUpload(f.id, { ...before.ui, msg: failText(e, true), pct: null }); } // (not an application that expired meanwhile)
      else { delete files[f.id]; setUpload(f.id, { state: 'failed', msg: failText(e, true), pct: null }); }
      whenBack(f.id);
    } finally {
      if (stopping[f.id] === ctl) delete stopping[f.id];
      uploads.delete(f.id);
      uploadsChanged();
      retireNotices({ videoDone: true });
      finish();
    }
  }

  // Remove can be undone for a moment (a video can take minutes to upload again): the server lets go of the
  // file once that's past, or straight away when another file is chosen, it's sent or saved, or the page goes
  const removing = {}; // field id → { timer, was }
  const UNDO_MS = 8000;
  function removeFile(f) {
    clearTimeout(removing[f.id]?.timer);
    removing[f.id] = { was: { file: files[f.id], ui: { ...uploadUi[f.id] } }, timer: setTimeout(() => dropRemoved(f.id), UNDO_MS) };
    delete files[f.id];
    uploadUi[f.id] = { state: 'empty', msg: f.type === 'video' ? 'videoRemoved' : 'photoRemoved' };
    paintUpload(f.id);
    uploadsChanged();
    fieldEl(f.id)?.querySelector('[data-act="undo"]')?.focus({ preventScroll: true }); // Remove itself is gone: the keys go to Undo
  }
  function undoRemove(f) {
    const r = removing[f.id];
    if (!r) return;
    clearTimeout(r.timer);
    delete removing[f.id];
    files[f.id] = r.was.file;
    uploadUi[f.id] = r.was.ui;
    paintUpload(f.id);
    uploadsChanged();
    fieldEl(f.id)?.querySelector('[data-act="remove"]')?.focus({ preventScroll: true });
  }
  /** Removed files the server lets go of now (all of them, or one); `leaving`: the page is going, so it's sent as it goes */
  function dropRemoved(id = null, { leaving = false } = {}) {
    const going = [];
    for (const k of id ? [id] : Object.keys(removing)) {
      const r = removing[k];
      if (!r) continue;
      clearTimeout(r.timer);
      delete removing[k];
      if (!leaving && uploadUi[k]?.state === 'empty') {
        // "Video removed." and its Undo go together (the keys to the box's own button if they were on Undo)
        const undo = fieldEl(k)?.querySelector('[data-act="undo"]');
        const had = undo && document.activeElement === undo;
        uploadUi[k] = { state: 'empty' };
        paintUpload(k);
        if (had) fieldEl(k)?.querySelector('[data-act="choose"]')?.focus({ preventScroll: true });
      }
      if (byId[k]?.type === 'video') forgetGoing(k); // (its upload goes with it)
      if (!token || previewing) continue;
      const body = { action: 'remove-file', token, field: k };
      if (leaving) { try { fetch(API, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch { /* the page is going either way */ } }
      else going.push(api(body).catch(() => {}));
    }
    return Promise.all(going);
  }
  /** Removed and not undone, of an application that's gone (expired, sent): nothing left to let go of */
  function forgetRemoved() {
    for (const k of Object.keys(removing)) { clearTimeout(removing[k].timer); delete removing[k]; }
  }
  function takeFile(f, file) {
    // A file chosen while the camera's on (or recording): the file is the video; the camera stops, its clip let go
    // (kept, it would replace the file the moment they went on)
    if (recorder?.id === f.id) closeRecorder();
    // Another video while one's on its way: that one stops, this one goes
    if (uploads.has(f.id) && stoppable(f.id)) { cancelVideo(f.id).then(() => takeFile(f, file)); return; }
    if (uploads.has(f.id)) return;
    // The one just removed goes from the server first, so the new one is what stays
    if (removing[f.id]) { dropRemoved(f.id).then(() => takeFile(f, file)); return; }
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
    const heard = box.querySelector('[data-rec-said]');
    box.hidden = false;
    delete box.dataset.rec;
    time.textContent = T('camStarting');
    if (heard) heard.textContent = T('camStarting'); // (the clock itself isn't read out each second)
    // Waiting on the camera: busy, not disabled, so the keys move here from "Record with my camera" (which goes)
    toggle.setAttribute('aria-disabled', 'true');
    toggle.textContent = T('recordStart');
    recorder = { id: f.id, stream: null, rec: null, chunks: [], started: 0, timer: null, type: '' };
    const mine = recorder;
    const keys = el.contains(document.activeElement);
    paintUpload(f.id);
    if (keys) toggle.focus({ preventScroll: true });
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
    if (heard) heard.textContent = T('camReady');
    toggle.removeAttribute('aria-disabled');
    box.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  function toggleRecording() {
    if (!recorder?.stream) return;
    const box = fieldEl(recorder.id)?.querySelector('.af-recorder');
    if (!box) return;
    const time = box.querySelector('.af-recorder-time');
    const toggle = box.querySelector('[data-act="rec-toggle"]');
    if (toggle.getAttribute('aria-disabled') === 'true') return;
    if (!recorder.rec) {
      const type = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find(t => MediaRecorder.isTypeSupported?.(t)) || '';
      const rec = new MediaRecorder(recorder.stream, type ? { mimeType: type } : undefined);
      recorder.rec = rec;
      recorder.type = (rec.mimeType || type || 'video/webm').split(';')[0];
      // Its own recording's pieces (the last ones come once it's stopped, after the camera's put away)
      const own = recorder;
      rec.ondataavailable = (e) => { if (e.data?.size) own.chunks.push(e.data); };
      rec.start(1000);
      recorder.started = Date.now();
      box.dataset.rec = 'on';
      toggle.textContent = T('recordStop');
      const heard = box.querySelector('[data-rec-said]');
      if (heard) heard.textContent = T('recording', { time: recTime(0) }); // (once: the clock isn't read out each second)
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
    toggle.setAttribute('aria-disabled', 'true');
    clearInterval(mine.timer);
    mine.rec.onstop = () => { closeRecorder(); useRecording(mine); };
    mine.rec.stop();
  }
  /** What was recorded, as the video: the same upload path as a chosen file */
  function useRecording(r) {
    const ext = r.type.includes('mp4') ? 'mp4' : 'webm';
    const d = new Date(); // their own clock's time, not UTC (one made in the evening isn't named tomorrow)
    const stamp = [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()].map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('');
    const file = new File(r.chunks, `recording-${stamp}.${ext}`, { type: r.type });
    const f = byId[r.id];
    if (f && file.size) uploadVideo(f, file);
  }
  /**
   * The camera off. `keep`: leaving its screen (or switching language, Save and exit) mid-recording
   * stops it there and keeps what was recorded as the video (as Stop does), and says so; never a camera
   * left running out of sight, nor a recording lost
   */
  function closeRecorder({ keep = false, why = 'recKept' } = {}) {
    if (!recorder) return;
    const r = recorder;
    recorder = null;
    clearInterval(r.timer);
    const going = r.rec && r.rec.state !== 'inactive';
    const kept = keep && going && Date.now() - r.started >= 1000;
    try { if (going) { r.rec.onstop = kept ? () => useRecording(r) : null; r.rec.stop(); } } catch { /* already stopped */ }
    if (kept) notice([why, { time: recTime(Date.now() - r.started) }], 'info');
    r.stream?.getTracks().forEach(t => t.stop());
    const box = fieldEl(r.id)?.querySelector('.af-recorder');
    const keys = !!box?.contains(document.activeElement); // Stop or Cancel had them: they stay in the video's box
    if (box) {
      box.hidden = true;
      delete box.dataset.rec;
      const view = box.querySelector('.af-recorder-view');
      if (view) view.srcObject = null;
    }
    paintUpload(r.id);
    if (keys) focusUploadBox(r.id);
  }
  /** The keys on the upload box's first button there is (its own words, if none): never dropped to the page */
  function focusUploadBox(id) {
    const el = fieldEl(id);
    const btn = [...(el?.querySelectorAll('.af-upload-actions button') || [])].find(b => !b.hidden && !b.disabled && b.getClientRects().length);
    const to = btn || el?.querySelector('.af-upload-status');
    if (!to) return;
    if (!btn) to.tabIndex = -1;
    to.focus({ preventScroll: true });
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
    // Typed back to the address it held (a letter typed and taken out again): that address again, nothing lost
    if (box && !box.dataset.picked && held.get(box)?.line === input.value) { restoreHeld(el); closeSuggest(); return; }
    if (box?.dataset.picked && input.value !== box.dataset.picked) {
      // Kept aside, so leaving the screen without picking another (Back, the steps, Save and exit) puts it back
      held.set(box, { line: box.dataset.picked, splitApt: box.dataset.splitApt, area: el.dataset.field === homeAddressId() ? areaNow : null, parts: Object.fromEntries(['line1', 'line2', 'city', 'state', 'zip'].map(k => [k, box.querySelector(`[data-part="${k}"]`)?.value || ''])) });
      delete box.dataset.picked;
      for (const k of ['line1', 'city', 'zip']) box.querySelector(`[data-part="${k}"]`).value = '';
      // An apartment that came from what they'd typed (not one they entered) goes with that address
      const apt = box.querySelector('[data-part="line2"]');
      if (box.dataset.splitApt && apt?.value === box.dataset.splitApt) apt.value = '';
      delete box.dataset.splitApt;
      if (el.dataset.field === homeAddressId()) unfillCounty(); // its county (and the note saying so) with it
    }
    suggestFor(el, input);
  }
  // A confirmed address being typed over (see addressTyped): what it was, till another is picked or entered by hand
  const held = new WeakMap();
  function restoreHeld(el) {
    const box = addrBox(el);
    const h = box && held.get(box);
    if (!h) return;
    held.delete(box);
    for (const [k, v] of Object.entries(h.parts)) { const i = box.querySelector(`[data-part="${k}"]`); if (i) i.value = v; }
    box.querySelector('[data-search]').value = h.line;
    box.dataset.picked = h.line;
    if (h.splitApt) box.dataset.splitApt = h.splitApt;
    setFieldError(el.dataset.field, null);
    if (el.dataset.field === homeAddressId()) {
      // Its place on the map too (what the check found for it), not a fresh look and a moment with no answer
      if (h.area && h.area.key === addressKey(homeAddressNow())) { area.want = null; clearTimeout(area.timer); areaNow = h.area; }
      scheduleArea(true);
      paintArea();
    }
    refresh();
    markDirty();
  }
  /** Leaving the screen with an address typed over and nothing picked: the one it held, back (never lost to a stray key) */
  function keepHeldAddresses() {
    for (const box of ui.pages.querySelectorAll('.af-address')) {
      if (box.dataset.mode === 'line' && !box.dataset.picked && held.has(box)) restoreHeld(box.closest('[data-field]'));
    }
  }
  /**
   * "Enter the address yourself" (what they'd typed becomes the street), or back to the search; `force`
   * when the parts are already showing (a pick that came without its ZIP), to finish them by hand
   */
  /**
   * A typed address line into the parts it names: "1 Nowhere Lane, Apt 2, Faketown, GA 30999". With no
   * commas it's all the street (with a ZIP at its end taken off); "GA" or "Georgia" is the state already chosen
   */
  const STREET_WORDS = /^(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|pkwy|parkway|hwy|highway|trl|trail|ter|terrace|run|pass|xing|crossing|sq|square|loop|row|path|walk|pt|point|ridge|trce|trace|cv|cove|bnd|bend|holw|hollow|ne|nw|se|sw)\.?$/i;
  function splitAddressLine(v) {
    let s = String(v || '').trim();
    const out = {};
    const zip = s.match(/[\s,]+(\d{5}(?:-\d{4})?)\s*$/);
    if (zip) { out.zip = zip[1]; s = s.slice(0, zip.index).trim(); }
    s = s.replace(/[\s,]+(GA|Georgia)\.?\s*$/i, '').trim();
    const parts = s.split(',').map(x => x.trim()).filter(Boolean);
    // No commas: the city is what follows the street's last word that names a street ("456 Oak Ave Marietta")
    if (parts.length === 1) {
      const words = parts[0].split(/\s+/);
      const end = STREET_WORDS.test(words[words.length - 1]) ? -1 : words.findLastIndex((w, i) => i > 0 && STREET_WORDS.test(w));
      if (end > 0) parts.splice(0, 1, words.slice(0, end + 1).join(' '), words.slice(end + 1).join(' '));
    }
    out.line1 = parts.shift() || '';
    if (parts.length) out.city = parts.pop();
    if (parts.length) out.line2 = parts.join(', ');
    return out;
  }
  function setAddressMode(el, mode, { force = false } = {}) {
    const box = addrBox(el);
    if (!box || (box.dataset.mode === mode && !force)) return;
    if (mode === 'parts') held.delete(box); // entering it by hand: theirs now
    closeSuggest();
    const search = box.querySelector('[data-search]');
    const line1 = box.querySelector('[data-part="line1"]');
    // What they typed goes into the parts it names ("1 Nowhere Lane, Faketown 30999": street, city, ZIP)
    if (mode === 'parts' && !line1.value.trim() && !box.dataset.picked && search.value.trim()) {
      const parts = splitAddressLine(search.value);
      for (const [k, v] of Object.entries(parts)) {
        const i = box.querySelector(`[data-part="${k}"]`);
        if (i && v && !i.value.trim()) i.value = v.slice(0, Number(i.maxLength) > 0 ? i.maxLength : 160);
      }
      if (parts.line2) box.dataset.splitApt = box.querySelector('[data-part="line2"]').value;
    }
    // The note about the line was about the line: they're doing what it asked
    if (shown.has(el.dataset.field)) setFieldError(el.dataset.field, null);
    box.dataset.mode = mode;
    if (mode === 'line') {
      const line = addressLineOf(readField(byId[el.dataset.field]) || {});
      if (line) { search.value = line; box.dataset.picked = line; } else {
        // Begun by hand but not finished: its street goes back in the line to search for, the rest let go
        if (line1.value.trim()) search.value = line1.value.trim();
        for (const k of ['line1', 'city', 'zip']) box.querySelector(`[data-part="${k}"]`).value = '';
        const apt = box.querySelector('[data-part="line2"]');
        if (box.dataset.splitApt && apt.value === box.dataset.splitApt) apt.value = '';
        delete box.dataset.splitApt;
        delete box.dataset.picked;
      }
    }
    liveCheck(el);
    refresh();
    markDirty();
    // Into the search, or the first part still empty
    const to = mode === 'parts' ? ['line1', 'city', 'zip'].map(k => box.querySelector(`[data-part="${k}"]`)).find(i => !i.value.trim()) || line1 : search;
    to.focus({ preventScroll: true });
    // The parts take more room: the screen scrolls if it must (nothing moves to another screen), the box
    // they're in clear of the bar and of Back / Continue
    to.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }

  // ── Address suggestions (a combobox on the address line) ──────────
  const sug = { timer: 0, due: null, going: null, ctrl: null, items: [], active: -1, input: null, list: null, el: null, closing: 0 };
  const homeAddressId = () => (byId.address?.type === 'address' ? 'address' : fields.find(f => f.type === 'address')?.id);
  // Each search is a paid lookup: asked once a house number has a few letters of its street after it ("1234 Pea",
  // not "1234"), and never twice for the same words (a space typed, a letter taken back and typed again)
  const sugSeen = new Map(); // the words, as searched → { items, google, complete }
  const sugKey = (q) => q.toLowerCase().replace(/[\s,]+/g, ' ').trim();
  const searchable = (q) => q.length >= 4 && /\d/.test(q) && (q.match(/\p{L}/gu) || []).length >= 3;
  // One search session per address picked (Google counts a session's searches, past its first dozen, as free)
  let sugSession = '';
  const newSession = () => { try { sugSession = crypto.randomUUID(); } catch { sugSession = ''; } };
  newSession();
  // ...nor for more of words whose list was all Google had (it sent fewer than five): that list, narrowed to what's
  // typed now ("1234 Peachtree Indu…" from "1234 Peachtree Ind"'s two), a search again only once none of it fits
  const labelOf = (it) => sugKey([it.line1, it.sub || [it.city, it.state, it.zip].filter(Boolean).join(' ')].join(' '));
  function narrowed(q) {
    const key = sugKey(q);
    let from = null;
    for (const [k, v] of sugSeen) if (v.complete && key.startsWith(k) && (!from || k.length > from.k.length)) from = { k, v };
    const items = from ? from.v.items.filter(it => labelOf(it).startsWith(key)) : [];
    if (!items.length) return null;
    const hit = { items, google: from.v.google, complete: true };
    sugSeen.set(key, hit);
    return hit;
  }
  function suggestFor(el, input) {
    clearTimeout(sug.timer);
    sug.due = null;
    const q = input.value.trim();
    if (!searchable(q)) { closeSuggest(); return; }
    const seen = sugSeen.get(sugKey(q)) || narrowed(q);
    if (seen) {
      sug.ctrl?.abort(); // (words asked about before this: their answer isn't for what's typed now)
      sug.last = { input, q, ...seen };
      const open = sug.list && !sug.list.hidden && sug.input === input && sug.items === seen.items; // (the same list: its place in it kept)
      if (!open && document.activeElement === input) openSuggest(el, input, seen.items, seen.google);
      return;
    }
    sug.due = { el, input, q };
    sug.timer = setTimeout(() => { sug.due = null; fetchSuggest(el, input, q); }, 250);
  }
  /** Suggestions for what's in the line still on their way (asked now if they were waiting to be): done when they're in */
  function suggestDue() {
    if (sug.due) {
      clearTimeout(sug.timer);
      const { el, input, q } = sug.due;
      sug.due = null;
      return fetchSuggest(el, input, q);
    }
    return sug.going;
  }
  function fetchSuggest(el, input, q) {
    const p = sug.going = findSuggest(el, input, q).finally(() => { if (sug.going === p) sug.going = null; });
    return p;
  }
  async function findSuggest(el, input, q) {
    sug.ctrl?.abort();
    const ctrl = new AbortController();
    sug.ctrl = ctrl;
    let items = [];
    let google = false;
    let complete = false;
    try {
      const res = await fetch(`${API}?address=${encodeURIComponent(q)}${sugSession ? `&session=${sugSession}` : ''}`, { signal: ctrl.signal });
      const data = await res.json();
      items = Array.isArray(data.results) ? data.results : Array.isArray(data.items) ? data.items : [];
      google = data.source === 'google';
      complete = google && data.complete === true;
    } catch { return; } // offline or the lookup is down: they keep typing as normal
    items = items.filter(i => i?.line1).slice(0, 5);
    if (!ctrl.signal.aborted) sugSeen.set(sugKey(q), { items, google, complete }); // (an answer that came is kept, whatever they've typed since)
    if (ctrl.signal.aborted || input.value.trim() !== q) return;
    sug.last = { input, q, items, google };
    // Continue pressed meanwhile (a whole address pasted, then straight on): no list, but known, so it can take it
    if (document.activeElement !== input) {
      if (sug.list && sug.input !== input) return; // another address's list is open: left as it is
      closeSuggest();
      Object.assign(sug, { items: sug.last.items, el, input });
      return;
    }
    openSuggest(el, input, sug.last.items, google);
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
    suggestNote();
    placeSuggest();
  }
  /** A problem with the address while its list is open: said at the list's top (the list covers the note under the box) */
  function suggestNote() {
    const { list, el } = sug;
    if (!list || list.hidden) return;
    const msg = el?.querySelector('.af-error')?.textContent.trim();
    let head = list.querySelector('.af-suggest-note');
    if (!msg) { head?.remove(); return; }
    if (!head) {
      head = document.createElement('li');
      head.className = 'af-suggest-note';
      head.setAttribute('role', 'presentation');
      head.setAttribute('aria-hidden', 'true'); // the box's own note says it (aria-describedby)
      list.prepend(head);
    }
    head.textContent = msg;
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
  const options = () => [...(sug.list?.querySelectorAll('[role="option"]') || [])];
  function moveActive(d) {
    const n = options().length;
    if (!n) return;
    sug.active = sug.active < 0 ? (d > 0 ? 0 : n - 1) : (sug.active + d + n) % n;
    options().forEach((li, i) => li.setAttribute('aria-selected', String(i === sug.active)));
    const li = options()[sug.active];
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
    const typed = search?.value || '';
    const done = (a) => {
      for (const k of ['line1', 'city', 'zip']) { const i = el.querySelector(`[data-part="${k}"]`); if (i) i.value = ''; }
      set('line1', a.line1);
      set('line2', unitAsTyped(a.line2, typed));
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
    if (search) { search.value = [it.line1, it.sub].filter(Boolean).join(', '); box.dataset.picked = search.value; held.delete(box); }
    const [, city, state, zip] = String(it.sub || '').match(/^(.*?),\s*([A-Z]{2})(?:\s+(\d{5}))?$/) || [];
    const byHand = () => done({ line1: it.line1, city, state, zip });
    // Continue waits for this (a slow connection): the pick is made, its parts are on their way
    const p = placing = fetch(`${API}?place=${encodeURIComponent(it.id)}${sugSession ? `&session=${sugSession}` : ''}`).then(r => r.json()).then((r) => { if (r?.address) done(r.address); else byHand(); }).catch(byHand)
      .finally(() => { if (placing === p) placing = null; });
    newSession(); // (the pick ends Google's session: the next address is a new one)
  }
  let placing = null; // a picked suggestion's parts still on their way
  /**
   * The apartment as they typed it ("Apt 4B"), not as Google sends it back ("apt 4b"); one they didn't type is
   * written the usual way, its word capitalized and its number's letter a capital ("Unit C", "#12B")
   */
  const UNIT_WORD = '(?:(?:apartment|apt|building|bldg|floor|fl|room|rm|suite|ste|space|spc|unit|lot|trlr)(?![a-z])|#)';
  function unitAsTyped(unit, typed) {
    const u = String(unit || '').trim();
    if (!u) return u;
    const core = u.replace(new RegExp(`^${UNIT_WORD}\\.?\\s*#?\\s*`, 'i'), '');
    const m = core ? String(typed).match(new RegExp(`(?:^|[\\s,])(${UNIT_WORD}\\.?\\s*#?\\s*)?(${core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}\\d])`, 'iu')) : null;
    if (m?.[1]) return `${m[1]}${m[2]}`.trim();
    const word = u.replace(new RegExp(`^${UNIT_WORD}`, 'i'), w => (w === '#' ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()));
    return m ? word.slice(0, word.length - core.length) + m[2] : word.replace(/(\d+[a-z]?|\b[a-z])$/i, x => x.toUpperCase());
  }
  /** A whole address typed (or pasted) that the list offers back exactly, alone: Continue takes it, no tap on the list needed */
  /**
   * Suggestions that came while Continue waited (the keys were on Continue, so they opened for no one), and none
   * the address exactly: the list they'll be told to choose from is open under the line
   */
  function reopenSuggest() {
    const box = sug.el && addrBox(sug.el);
    const input = box?.querySelector('[data-search]');
    if (!input || box.dataset.mode !== 'line' || box.dataset.picked === input.value || sug.last?.input !== input || sug.last.q !== input.value.trim()) return;
    openSuggest(sug.el, input, sug.last.items, sug.last.google);
  }
  function takeExactMatch() {
    const el = sug.el;
    const box = el && addrBox(el);
    const search = box?.querySelector('[data-search]');
    if (!search || sug.items.length !== 1 || box.dataset.mode === 'parts' || box.dataset.picked === search.value) return;
    const it = sug.items[0];
    const words = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (words(search.value) === words([it.line1, it.sub || [it.city, it.state, it.zip].filter(Boolean).join(' ')].join(' '))) pickSuggestion(0);
  }
  /** The county question, set from the address when the county is one of its choices */
  function fillCounty(county, addressEl) {
    const name = String(county || '').trim().toLowerCase();
    if (!name) return;
    const choiceTypes = ['select', 'radio'];
    const f = (byId.county && (choiceTypes.includes(byId.county.type) || byId.county.type === 'text') ? byId.county : null)
      || fields.find(x => choiceTypes.includes(x.type) && x.options?.some(o => o.toLowerCase() === name));
    if (!f) return;
    // Not one of the choices: "Other" when the question has it (its note still names the county)
    const other = f.type === 'text' ? null : f.options.find(o => /^other\b/i.test(o));
    const value = f.type === 'text' ? String(county).trim() : f.options.find(o => o.toLowerCase() === name) || other;
    if (!value) { unfillCounty(); return; } // not a county we serve: the question is the family's (one we filled from the last address goes)
    writeField(f, value);
    liveCheck(fieldEl(f.id));
    countyNote = { field: f.id, value, label: value === other ? String(county).trim() : f.optionLabels?.[value] || value, address: addressEl.dataset.field };
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
  const area = { timer: 0, showTimer: 0, want: null, pending: null, again: 0, tries: 0, retrying: false };
  const areaField = () => fields.find(f => f.type === 'area') || null;
  const homeAddressNow = () => { const id = homeAddressId(); return id && byId[id] ? readField(byId[id]) : null; };
  /** The check, if it placed the address now on screen: { ...check, answer } */
  function areaPlaced() {
    if (!areaNow || !AREA_VALUES[areaNow.band]) return null;
    return areaNow.key === addressKey(homeAddressNow()) ? { ...areaNow, answer: AREA_VALUES[areaNow.band] } : null;
  }
  // A PO box as the home isn't checked (it's turned away as the home, and a check would only cost a lookup)
  const checkable = (a) => checkableAddress(a) && !(homeAddressId() === 'address' && /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i.test(`${a?.line1 || ''} ${a?.line2 || ''}`));
  /** A check is due or on its way for the address on screen */
  function areaWaiting() {
    const af = areaField();
    if (!af || pageOf(af.id) !== currentId) return false;
    const addr = homeAddressNow();
    return checkable(addr) && areaNow?.key !== addressKey(addr);
  }
  async function flushArea() {
    const addr = homeAddressNow();
    const key = addressKey(addr);
    if (area.want === key && area.pending) return area.pending;
    clearTimeout(area.timer);
    return runArea(addr, key);
  }
  /** The check of the address on screen didn't go (not "no such address", nor the allowance used up) */
  const areaFailed = () => !!areaNow && ['error', 'busy'].includes(areaNow.reason) && areaNow.key === addressKey(homeAddressNow()) && checkable(homeAddressNow());
  /** That check again (once, with nothing else on its way) */
  function areaAgain() {
    if (!areaFailed() || area.want || doneShown || !token && !previewing) return null;
    return runArea(homeAddressNow(), areaNow.key, { again: true });
  }
  window.addEventListener('online', () => { clearTimeout(area.again); areaAgain(); }, { signal });
  /** Check the address after a pause in typing (at once after picking a suggestion) */
  function scheduleArea(now = false) {
    if (!areaField()) return;
    const addr = homeAddressNow();
    const key = addressKey(addr);
    clearTimeout(area.timer);
    if (!checkable(addr)) {
      area.want = null;
      if (areaNow) { areaNow = null; paintArea(); }
      return;
    }
    // Typed back to the address already checked: its result again (and nothing on its way may replace it). Its ZIP
    // put right since ("30076-12" to "30076", the same place to the check): the Postal Service is asked now
    if (areaNow?.key === key) { area.want = null; clearTimeout(area.showTimer); if (uspsNow?.key !== key) runUsps(addr, key); paintArea(); return; }
    if (area.want === key) return;
    // The old result no longer describes what's typed
    if (areaNow) paintArea('checking');
    area.timer = setTimeout(() => runArea(addr, key), now ? 0 : 650);
  }
  /** The Postal Service's word on the home address, in what the check found: known, a unit number may be missing, or check it */
  async function runUsps(addr, key) {
    // (a ZIP the box itself says is wrong, "30076-12", isn't asked about: each check is paid for; nor one already on its way)
    if (!uspsOn || !/^\d{5}(?:-\d{4})?$/.test(String(addr?.zip || '').trim()) || uspsGoing === key) return;
    uspsGoing = key;
    const q = new URLSearchParams({ usps: '1', ...Object.fromEntries(['line1', 'line2', 'city', 'state', 'zip'].map(k => [k, String(addr[k] || '')])) });
    let status = null;
    try { status = (await (await fetch(`${API}?${q}`)).json())?.usps || null; } catch { /* no word: nothing shows */ }
    if (uspsGoing === key) uspsGoing = '';
    if (addressKey(homeAddressNow()) !== key) return; // the address has changed since
    uspsNow = { key, status };
    paintArea();
  }
  /** Its line in the result card (Google's terms: the answer shows with its credit) */
  function uspsHtml(status = uspsNow && uspsNow.key === addressKey(homeAddressNow()) ? uspsNow.status : null) {
    // A building with apartments, and they've given theirs: the Postal Service couldn't confirm that one
    const unitGiven = status === 'unit' && !!homeAddressNow()?.line2;
    const words = { confirmed: 'uspsConfirmed', unit: unitGiven ? 'uspsUnitGiven' : 'uspsUnit', check: 'uspsCheck' }[status];
    // An apartment they may have left off: a way straight to its box (it's on the address's screen, often not this one)
    const apt = status === 'unit' && !unitGiven ? `<button type="button" class="af-btn af-btn--link af-area-apt" data-act="area-apt">${esc(T('addApt'))}</button>` : '';
    return words ? `<p class="af-usps" data-status="${status}"><span>${esc(T(words))}</span> <span class="af-usps-by" translate="no">Google Maps</span></p>${apt}` : '';
  }
  function runArea(addr, key, { again = false } = {}) {
    if (!again) runUsps(addr, key);
    area.want = key;
    clearTimeout(area.showTimer);
    clearTimeout(area.again);
    // (asked again after it didn't go: the card and their answer stay until there's word, nothing flickers)
    if (!again) area.showTimer = setTimeout(() => { if (area.want === key) paintArea('checking'); }, 180);
    area.pending = (async () => {
      let r;
      try { r = await api({ action: 'area', kind, ...(token && !previewing ? { token } : {}), address: addr }); } catch { r = { ok: false }; }
      if (area.want !== key) return; // a newer address is being checked
      clearTimeout(area.showTimer);
      area.want = null;
      area.pending = null;
      const was = areaNow;
      areaNow = r.ok && r.area ? { ...r.area, key } : { key, band: 'unknown', reason: 'error' };
      // Not checked just now (the connection, our server, the map service busy): asked again by itself, at once
      // when the connection's back, else a few times over a minute (and at Continue, and its "Check again")
      area.tries = areaFailed() ? (again && was?.key === key ? area.tries + 1 : 1) : 0;
      if (areaFailed() && navigator.onLine && area.tries <= 3) area.again = setTimeout(areaAgain, 5000 * 3 ** (area.tries - 1));
      area.retrying = false;
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
  /**
   * What the check found, in the family's own words while it's their house (same number, same ZIP): the
   * map service writes "Holcomb Wood Pkwy" for the Woods they picked, and leaves out the apartment
   */
  function foundAddress() {
    const a = homeAddressNow() || {};
    const m = String(areaNow?.matched || '');
    const no = (x) => (String(x || '').match(/^\s*(\d+)/) || [])[1];
    const zip = (x) => (String(x || '').match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1];
    const theirs = no(a.line1) && no(a.line1) === no(m) && (!zip(m) || !zip(a.zip) || zip(m) === zip(a.zip));
    return theirs ? [a.line1, a.line2, a.city, [a.state, zip(a.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ') : prettyAddress(m);
  }
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
      // The Postal Service's word helps most here: a number that doesn't exist is often why. A check that didn't go
      // can be asked again (it is by itself too)
      const again = st === 'error' && areaFailed()
        ? `<button type="button" class="af-btn af-btn--link af-area-again" data-act="area-again"${area.retrying ? ' aria-disabled="true"' : ''}>${area.retrying ? `<span class="af-area-spin" aria-hidden="true"></span>${esc(T('areaChecking'))}` : esc(T('areaAgain'))}</button>` : '';
      return `<div class="af-area-card" data-band="ask">${AREA_ICONS.ask}<div class="af-area-text"><p class="af-area-title">${esc(T(st === 'unknown' ? 'areaUnknown' : 'areaError'))}</p><p class="af-area-desc">${esc(T(st === 'unknown' ? 'areaUnknownBody' : 'areaErrorBody'))}</p>${uspsHtml()}${again}<button type="button" class="af-btn af-btn--link af-area-fix" data-act="area-fix">${esc(T('areaFix'))}</button></div></div>`;
    }
    const value = AREA_VALUES[st];
    const stopping = st === 'far' && af.stops?.[value] && form.stops?.[af.stops[value]];
    // Far out with Settings stopping them: what the stop screen will say; else the choice's own words
    const desc = stopping ? form.stops[af.stops[value]].body : `<p class="af-area-desc">${esc(String(af.descriptions?.[value] || '').replace(/\{miles\}/g, milesText(areaNow.miles)))}</p>`;
    const title = { inside: 'areaInside', near: 'areaNear', far: 'areaFar' }[st];
    const found = areaNow.matched
      ? `<p class="af-area-found">${esc(T(areaNow.county ? 'areaFoundCounty' : 'areaFound', { address: foundAddress(), county: areaNow.county || '' }))}</p>` : '';
    // (a home we can't reach: no apartment number asked for, it wouldn't change that)
    return `<div class="af-area-card" data-band="${st}">${AREA_ICONS[st]}<div class="af-area-text"><p class="af-area-title">${esc(T(title))}</p><div class="af-area-desc-wrap">${desc}</div>${found}${st === 'far' ? '' : uspsHtml()}<button type="button" class="af-btn af-btn--link af-area-fix" data-act="area-fix">${esc(T('areaFix'))}</button></div></div>`;
  }
  /** Draw the check: map (with the home), what it found, and the question when it couldn't place the home */
  function paintArea(force = null) {
    const af = areaField();
    const el = af && fieldEl(af.id);
    if (!el) return;
    const box = el.querySelector('[data-area]');
    const placed = areaPlaced();
    // (a check on its way for the address on screen: still "Checking…" when the card is drawn again, a language switch)
    const st = force || (placed ? placed.band
      : area.want && area.want === addressKey(homeAddressNow()) ? 'checking'
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
    // Asked about an address they haven't answered for: no answer ticked (one from an address before, or the
    // check's answer for it put back after a reload or a language switch, isn't theirs for this one)
    if (asking && askedFor !== addressKey(homeAddressNow())) ask.querySelectorAll('input:checked').forEach(i => { i.checked = false; });
    if (ask.hidden === asking) {
      ask.hidden = !asking;
      if (asking) enter(ask, 0, -6);
    }
    // Asked about the home now (or not any more): this page's screens worked out again where its pieces
    // changed (what it found, then the question with the map), keeping the screen they're on
    const pid = pageOf(af.id);
    if (focused && packs[pid] && packAsked[pid] !== asking && pid === currentId && !moving) {
      // The screen they stay on is the one with the box they're typing in, and with the address when it's
      // on this screen (not whatever came first on it): the address never moves off the screen it's entered on
      const typing = document.activeElement?.closest?.('[data-field]');
      const addr = fieldEl(homeAddressId());
      const here = packs[pid][screenNo] || [];
      const has = (el) => el && here.find(k => k === el || k.contains(el) || el.contains(k));
      const held = has(typing) || has(addr);
      const piece = held || here.find(k => k.getClientRects().length) || null;
      const keepAt = document.activeElement;
      delete packs[pid];
      show(pid, { piece: piece && !piece.closest('[data-area]') ? piece : box.querySelector('[data-area-result]'), focus: false, scroll: false })
        .then(() => { if (held && keepAt?.isConnected && keepAt.getClientRects().length) keepAt.focus({ preventScroll: true }); });
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
    if (!focus) return;
    body.querySelector('input, select, textarea')?.focus({ preventScroll: true });
    // All of it in view, its Remove too (clear of Back / Continue, never past its own start)
    requestAnimationFrame(() => {
      const r = body.getBoundingClientRect();
      const navTop = ui.form.querySelector('[data-nav]')?.getBoundingClientRect().top ?? innerHeight;
      const by = Math.min(r.bottom + 12 - navTop, r.top - (ui.top?.getBoundingClientRect().bottom || 0) - 8);
      if (by > 0) window.scrollBy({ top: by, behavior: reducedMotion() ? 'auto' : 'smooth' });
    });
  }
  function closeTucked(box) {
    const ids = [...box.querySelectorAll('[data-field]')].map(el => el.dataset.field);
    // What was in it: a group they'd filled in goes with an Undo for a moment, as a removed photo does
    const was = {};
    for (const id of ids) {
      const f = byId[id];
      const v = f ? readField(f) : undefined;
      if (!f || unanswered(f, { [id]: v })) continue;
      const ab = addrBox(fieldEl(id));
      was[id] = { v, addr: ab ? { line: ab.querySelector('[data-search]').value, picked: ab.dataset.picked, splitApt: ab.dataset.splitApt, mode: ab.dataset.mode } : null };
    }
    for (const id of ids) {
      const f = byId[id];
      if (!f) continue;
      const parts = fieldEl(id).querySelectorAll('[data-part]');
      if (parts.length) parts.forEach(i => { i.value = ''; });
      else writeField(f, '');
      // An address: its line too (typed, or the one picked), so it's gone, not just its parts
      const ab = addrBox(fieldEl(id));
      if (ab) {
        if (sug.el === fieldEl(id)) closeSuggest();
        ab.querySelector('[data-search]').value = '';
        delete ab.dataset.picked;
        delete ab.dataset.splitApt;
        ab.dataset.mode = 'line';
      }
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
    if (Object.keys(was).length) showGroupUndo(box, was);
    refresh();
    markDirty();
  }
  const groupUndo = new WeakMap(); // a group's box → { was, row, timer } while its Undo shows
  function showGroupUndo(box, was) {
    dropGroupUndo(box);
    const row = document.createElement('p');
    row.className = 'af-more-undo';
    row.innerHTML = '<span></span> <button type="button" class="af-btn af-btn--link" data-more-undo></button>';
    row.firstChild.textContent = T('groupRemoved');
    row.lastChild.textContent = T('undo');
    box.append(row); // (before the screen is worked out again: it's measured with it)
    groupUndo.set(box, { was, row, timer: setTimeout(() => dropGroupUndo(box), UNDO_MS) });
    row.lastChild.focus({ preventScroll: true }); // the keys go to Undo, as a removed photo's do
    announce(T('groupRemoved'));
  }
  function dropGroupUndo(box) {
    const u = groupUndo.get(box);
    if (!u) return;
    clearTimeout(u.timer);
    groupUndo.delete(box);
    const keys = u.row.contains(document.activeElement);
    u.row.remove();
    if (keys) box.querySelector('[data-more-open]')?.focus({ preventScroll: true });
  }
  function undoGroup(box) {
    const u = groupUndo.get(box);
    if (!u) return;
    clearTimeout(u.timer);
    groupUndo.delete(box);
    u.row.remove();
    for (const [id, { v, addr }] of Object.entries(u.was)) {
      const f = byId[id];
      if (!f) continue;
      writeField(f, v);
      const ab = addr ? addrBox(fieldEl(id)) : null;
      if (ab) {
        ab.querySelector('[data-search]').value = addr.line;
        for (const k of ['picked', 'splitApt', 'mode']) { if (addr[k] != null) ab.dataset[k] = addr[k]; else delete ab.dataset[k]; }
      }
      answers[id] = readField(f);
    }
    openTucked(box.querySelector('[data-field]'), { focus: true });
    makeRoom(box);
    refresh();
    markDirty();
  }
  /**
   * A group they opened ("Add another parent or guardian") too tall for the screen it's on: the screen's
   * questions from there on are worked out again (the screens before stay as they were), and they go to
   * the screen with the group's first box when it moved on
   */
  function makeRoom(box) {
    if (!focused || !packs[currentId] || currentId === 'review' || !overflows()) return;
    const fresh = pack(currentId, packs[currentId].slice(0, screenNo));
    if (!fresh) return;
    packs[currentId] = fresh;
    fresh.size = packSize;
    const first = box.querySelector('[data-field]')?.dataset.field;
    const to = first ? screenOf(currentId, first) : screenNo;
    if (to !== screenNo) { show(currentId, { dir: 1, screen: to, focusField: first }).then(() => { pushLoc(); save(); }); return; }
    replaceLoc(); // this screen holds other questions now: its entry says which (Back from the next one comes here)
    paintScreen();
    paintHeader();
  }
  /** Removed again: its button goes back on the screen it was on (with the question before it, where they fit) */
  function closeRoom(box) {
    if (!focused || !packs[currentId] || currentId === 'review') return;
    const list = packs[currentId];
    const has = (sc, el) => !!el && sc.some(k => k === el || k.contains(el) || el.contains(k));
    let from = list.findIndex(sc => has(sc, box));
    const before = list.findIndex(sc => has(sc, box.previousElementSibling));
    if (before >= 0 && before < from) from = before;
    if (from < 0) return;
    const fresh = pack(currentId, list.slice(0, from));
    if (!fresh) return;
    packs[currentId] = fresh;
    fresh.size = packSize;
    const to = fresh.findIndex(sc => has(sc, box));
    const btn = () => box.querySelector('[data-more-undo]') || box.querySelector('[data-more-open]'); // (its Undo, while that shows)
    if (to >= 0 && to !== screenNo) { show(currentId, { dir: -1, screen: to, focus: false }).then(() => { btn().focus({ preventScroll: true }); replaceLoc(); }); return; }
    replaceLoc();
    paintScreen();
    paintHeader();
    btn().focus({ preventScroll: true });
  }
  /**
   * A group cut across screens (a small phone) has its Remove with its last question: a problem note on one of
   * its screens before that has a Remove of its own, the way on when they've changed their mind
   */
  function paintGroupRemove(box) {
    const body = box.querySelector(':scope > .af-more-body');
    const away = !!body && !body.hidden && !!body.querySelector(':scope > [data-more-close]')?.hasAttribute('data-off');
    for (const p of box.querySelectorAll('.af-error')) {
      const here = p.nextElementSibling?.matches('.af-error-remove') ? p.nextElementSibling : null;
      const want = away && !!p.textContent.trim();
      if (want && !here) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'af-btn af-btn--link af-error-remove';
        b.setAttribute('data-more-close', '');
        b.textContent = T('remove');
        p.after(b);
      } else if (!want && here) here.remove();
      else if (here) here.textContent = T('remove'); // (a language switch)
    }
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
  /**
   * A long answer near the most its box holds: how many characters, under it. A paste that didn't all fit
   * says so (the box keeps the first part on its own, and the end would go without anyone knowing)
   */
  let pasteCut = null;
  function paintCount(ta) {
    const p = ta.parentElement?.querySelector('[data-count]');
    const max = ta.maxLength;
    if (!p || !(max > 0)) return;
    const n = ta.value.length;
    const cut = pasteCut === ta && n >= max;
    if (!cut && pasteCut === ta) pasteCut = null;
    const near = n >= max * 0.9;
    const fmt = (x) => x.toLocaleString(lang === 'es' ? 'es-US' : 'en-US');
    p.textContent = cut ? T('countCut', { max: fmt(max) }) : near ? T('countNear', { n: fmt(n), max: fmt(max) }) : '';
    p.dataset.kind = cut ? 'cut' : '';
    p.hidden = !cut && !near;
  }
  ui.form.addEventListener('paste', (e) => {
    const ta = e.target;
    if (ta?.tagName !== 'TEXTAREA' || !(ta.maxLength > 0)) return;
    const text = e.clipboardData?.getData('text') || '';
    pasteCut = ta.value.length - (ta.selectionEnd - ta.selectionStart) + text.length > ta.maxLength ? ta : null;
  });
  /** …until the screen is full: a longer answer then scrolls inside its box, and the screen never does */
  function capBoxes(page) {
    const boxes = [...(page?.querySelectorAll('textarea') || [])];
    for (const ta of boxes) { ta.style.removeProperty('max-height'); ta.style.removeProperty('min-height'); }
    if (!focused) return;
    settle();
    let over = document.documentElement.scrollHeight - innerHeight;
    // The tallest gives way first, each never under two lines of words (below its usual least height
    // only when the screen needs it)
    const shown = boxes.filter(ta => ta.getClientRects().length && !ta.closest('[data-off], [hidden]')).sort((a, b) => b.offsetHeight - a.offsetHeight);
    for (const ta of shown) {
      if (over <= 0) return;
      const cs = getComputedStyle(ta);
      const px = (k) => parseFloat(cs[k]) || 0;
      const two = Math.ceil(2 * (px('lineHeight') || 24) + px('paddingTop') + px('paddingBottom') + px('borderTopWidth') + px('borderBottomWidth'));
      const was = ta.getBoundingClientRect().height;
      const h = Math.max(Math.min(two, was), Math.floor(was - over));
      if (h >= was) continue;
      ta.style.maxHeight = `${h}px`;
      if (h < px('minHeight')) ta.style.minHeight = `${h}px`;
      settle();
      over = document.documentElement.scrollHeight - innerHeight;
    }
  }


  /** A US number reads as (404) 555-0123 as it's typed (only while typing at the end, never while deleting) */
  function phoneShape(v, whole) {
    if (/^\s*\+/.test(v) && !/^\s*\+1/.test(v)) return v; // another country's number: as typed
    if (/[a-z]/i.test(v)) return v; // an extension being typed ("ext 5"): as typed
    if (/^\s*\d{3}[-.\s]\d{1,4}\s*$/.test(v)) return v; // a number without its area code ("555-1234"): as typed, not "(555) 123-4"
    let d = v.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length > 10) return v;
    if (whole) return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : v;
    if (d.length < 4) return v;
    return d.length < 7 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }

  /** "jordan@gmial.com" → "jordan@gmail.com": the big email services, a letter or two off, or a .con */
  function paintMailFix(input) {
    const p = input.closest('[data-field], [data-later-form]')?.querySelector('[data-mailfix]');
    if (!p) return;
    const fix = mailFix(input.value);
    p.hidden = !fix;
    p.replaceChildren();
    if (!fix) return;
    p.dataset.shownAt = String(Date.now()); // (Send in "Save and finish later" knows whether it's been seen)
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
  let laterOpener = null;
  let laterWaiting = null; // an email the link is to go to once the quick check is done
  function sendLaterNow() {
    const email = laterWaiting;
    laterWaiting = null;
    openLater();
    laterInput.value = email;
    laterAsked = email; // asked about a likely typo already, if it was one
    dlg.querySelector('[data-later-form]').requestSubmit();
  }
  const openLater = (e) => {
    if (doneShown) return; // sent: nothing to finish later
    if (previewing) { notice('previewNoSave', 'info'); return; }
    laterOpener = e?.currentTarget instanceof HTMLElement ? e.currentTarget : document.activeElement; // Safari doesn't focus a tapped button
    const email = testRun?.by || readAnswers()[emailId];
    const input = dlg.querySelector('input[type=email]');
    if (email && (!input.value || testRun?.by)) input.value = email;
    input.readOnly = !!testRun?.by; // a test run's link only ever goes to the person running it
    dlg.querySelector('[data-later-status]').textContent = '';
    markLater(null);
    // "Already saved" only when they are (offline, or a save still on its way: it's saved as the link goes)
    const intro = dlg.querySelector('[data-af-t^="laterIntro"]');
    if (intro) { intro.dataset.afT = token && (!lastSave || lastSave === 'saved') ? 'laterIntro' : 'laterIntroUnsaved'; intro.textContent = T(intro.dataset.afT); }
    dlg.querySelector('[data-later-form]').hidden = false;
    dlg.querySelector('[data-later-sent]').hidden = true;
    dlg.showModal();
    // On a computer the keys go to the email (not the ×, where Enter would close it); a phone's keyboard waits for a tap
    if (finePointer()) input.focus();
  };
  ui.saveLaters.forEach(b => b.addEventListener('click', openLater));
  // Closed (Escape, Close, done): the focus goes back to what opened it, not to the page
  dlg.addEventListener('close', () => { if (laterOpener?.isConnected && laterOpener.getClientRects().length) laterOpener.focus({ preventScroll: true }); laterOpener = null; });
  dlg.querySelector('[data-later-close]').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-later-done]').forEach(b => b.addEventListener('click', () => {
    // "Keep going now" from the overview: the application, where they left off (from a screen, that screen)
    const go = !focused && !!token && !doneShown && !root.hidden;
    if (go) laterOpener = null;
    dlg.close();
    if (go) begin(ui.hubGo?.dataset.go || null);
  }));
  dlg.addEventListener('click', (e) => { if (tappedOutside(dlg, e)) dlg.close(); });
  // A likely typo in the address is asked about once ("Did you mean …@gmail.com?") before the link goes there
  const laterInput = dlg.querySelector('input[type=email]');
  let laterAsked = '';
  // The box marked wrong with its note read with it (as the form's own boxes are), or both let go of
  const markLater = (wrong) => {
    if (wrong) { laterInput.setAttribute('aria-invalid', 'true'); laterInput.setAttribute('aria-describedby', 'af-later-status'); }
    else { laterInput.removeAttribute('aria-invalid'); laterInput.removeAttribute('aria-describedby'); }
  };
  // Its note goes as they type (it was about the box as it was), and a likely typo is asked about as they leave it
  // (as the form's own email boxes do), not only on Send
  laterInput.addEventListener('input', () => {
    const status = dlg.querySelector('[data-later-status]');
    if (laterInput.hasAttribute('aria-invalid')) { markLater(null); if (status) status.textContent = ''; }
  }, { signal });
  // (Send still asks once: pressing it is what blurs the box.) A hint already showing for these words isn't drawn
  // again: its button would be swapped under a finger pressing it, and the press lost
  // A press on Send blurs the box: the hint isn't drawn then (it would push Send down under the finger), Send asks
  let pressingSend = false;
  dlg.querySelector('[data-later-form] button[type=submit]')?.addEventListener('pointerdown', () => { pressingSend = true; setTimeout(() => { pressingSend = false; }, 700); }, { signal });
  laterInput.addEventListener('blur', () => {
    if (pressingSend) return;
    const v = laterInput.value.trim();
    const p = dlg.querySelector('[data-mailfix]');
    if (v && mailFix(v) && (p?.hidden || p?.querySelector('[data-mailfix-use]')?.dataset.mailfixUse !== mailFix(v))) paintMailFix(laterInput);
  }, { signal });
  laterInput.addEventListener('input', () => { const p = dlg.querySelector('[data-mailfix]'); if (p && !p.hidden) p.hidden = true; });
  dlg.addEventListener('click', (e) => {
    const use = e.target.closest('[data-mailfix-use]');
    if (!use) return;
    laterInput.value = use.dataset.mailfixUse;
    paintMailFix(laterInput);
    // Fixed: the note about the old words goes with them
    markLater(null);
    const status = dlg.querySelector('[data-later-status]');
    if (status) status.textContent = '';
    laterInput.focus();
  });
  dlg.querySelector('[data-later-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Busy, not disabled: a disabled button drops the keys to the page (and Tab out of the dialog)
    const btn = dlg.querySelector('[data-later-form] button[type=submit]');
    if (btn.getAttribute('aria-busy') === 'true') return;
    const status = dlg.querySelector('[data-later-status]');
    const email = laterInput.value.trim();
    // A likely typo first ("Did you mean …@gmail.com?", a tap to fix), whether the words are an email or not; asked
    // once (a hint already up a moment, from leaving the box, counts: this press sends)
    const hint = dlg.querySelector('[data-mailfix]');
    const seen = !!hint && !hint.hidden && hint.querySelector('[data-mailfix-use]')?.dataset.mailfixUse === mailFix(email) && Date.now() - Number(hint.dataset.shownAt || 0) > 700;
    if (email && mailFix(email) && laterAsked !== email && !seen) { laterAsked = email; paintMailFix(laterInput); status.textContent = ''; markLater(null); return; }
    // Empty or not an email: said here in the form's own words (not the browser's bubble)
    const wrong = email ? fieldError({ id: 'laterEmail', type: 'email', required: true }, email, lang) : T('laterEmailEmpty');
    markLater(wrong);
    status.textContent = wrong || '';
    if (wrong) { laterInput.focus(); return; }
    btn.setAttribute('aria-busy', 'true');
    status.textContent = T('sending');
    try {
      if (!navigator.onLine) { status.textContent = T('sendOffline'); return; }
      // (an application another tab started, picked up instead: the link is that one's)
      if (!(await start()) && !token) {
        // The quick check wants a tap: it's on the page, under this (shown once this closes), and the link goes
        // once it's done (they aren't left to send it again, thinking it went)
        if (checkAsked) { laterWaiting = email; dlg.close(); if (!turnstileFailed) navNote('turnstileLater'); return; }
        status.textContent = say(lastNav?.m) || T('startFail');
        return;
      }
      // The link opens what's saved: not sent until this page's answers are
      if (!(await save())) { if (dlg.open) status.textContent = T(navigator.onLine ? 'laterUnsaved' : 'sendOffline'); return; }
      if (doneShown) return; // sent already, from another device (the thank-you says so)
      await dropRemoved(); // the link opens it as it is
      const r = await api({ action: 'email-link', token, email, lang });
      if (!r.ok) { status.textContent = r.error || T('sendFail'); return; }
      laterEmail = email;
      dlg.querySelector('[data-later-email]').textContent = email;
      dlg.querySelector('[data-later-form]').hidden = true;
      dlg.querySelector('[data-later-sent]').hidden = false;
      dlg.querySelector('[data-later-done]').focus();
    } catch {
      status.textContent = T('sendOffline'); // the request never got there
    } finally {
      btn.removeAttribute('aria-busy');
    }
  });

  // ── A choice's whole description (More, when a phone shows only part of it) ──
  const detail = ui.detail;
  let detailFor = null; // the box of the choice it's about
  let detailOpener = null; // the More that opened it: focus goes back there (or to the choice, once chosen)
  const isFull = (input) => input.getAttribute('aria-disabled') === 'true';
  function paintDetail() {
    const on = detailFor.checked;
    const full = !on && isFull(detailFor); // two chosen already
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
    // A guideline card's More: its words to read, nothing to choose
    const card = detail && !choice && e.target.closest('[data-offer-more]')?.closest('.af-offer-card');
    if (!choice && !card) return;
    detailFor = choice ? choice.querySelector('input') : null;
    detailOpener = e.target.closest('[data-tile-more], [data-offer-more]');
    detail.querySelector('[data-detail-title]').textContent = (choice ? choice.querySelector('.af-choice-title') : card.querySelector('.af-offer-text strong'))?.textContent || '';
    detail.querySelector('[data-detail-text]').textContent = (choice ? choice.querySelector('.af-choice-desc') : card.querySelector('.af-offer-text > span'))?.textContent || '';
    detail.querySelector('[data-detail-pick]').hidden = !choice;
    if (choice) paintDetail();
    else { detail.querySelector('[data-detail-tag]').hidden = true; detail.querySelector('[data-detail-status]').textContent = ''; }
    detail.showModal();
    detail.querySelector('[data-detail-title]').focus(); // its name read first (and no ring on Close)
  });
  detail?.querySelector('[data-detail-pick]').addEventListener('click', () => {
    if (!detailFor || (isFull(detailFor) && !detailFor.checked)) return;
    const box = detailFor;
    detailOpener = null;
    detail.close();
    box.click(); // as a tap on its box (after the sheet's gone, so the check is seen drawing in): the limit, the save, the rest follow
    box.focus({ preventScroll: true }); // on the choice they just made, not lost to the page
  });
  detail?.addEventListener('close', () => { if (detailOpener?.isConnected) detailOpener.focus({ preventScroll: true }); detailOpener = null; });
  detail?.querySelector('[data-detail-close]').addEventListener('click', () => detail.close());
  detail?.addEventListener('click', (e) => { if (tappedOutside(detail, e)) detail.close(); });

  // ── Language ─────────────────────────────────────────────────────
  let langAt = null; // the question a language switch kept their place by, and the screen it landed them on
  function setLang(l, { remember: keep = true, persist = true } = {}) {
    if (l === lang || !(form.languages || []).includes(l)) return;
    // Its place kept by the screen's first question (not words to read before it, which a repack can part from it).
    // Switched back without moving: the question they were on before, so English, Spanish, English lands where it began
    const before = langAt && langAt.page === currentId && langAt.screen === screenNo && langAt.lang === lang && screenFieldIds().has(langAt.field) ? langAt.field : null;
    // Else the question they're in, else the first on the screen still to answer (where they are), else its first
    const here = currentId !== 'review' && !before ? [...screenFieldIds()].filter(id => byId[id] && (isInput(byId[id]) || isUpload(byId[id])) && onScreen(fieldEl(id))) : [];
    const typing = document.activeElement?.closest?.('[data-field]')?.dataset.field;
    const a = here.length ? readAnswers() : null;
    const anchor = currentId !== 'review' ? before || here.find(id => id === typing) || here.find(id => unanswered(byId[id], a)) || screenQuestion() : null;
    const area = !anchor && currentId !== 'review' ? screenAt() : null; // the check's card or its map, alone on the screen
    lang = l;
    if (keep) langPref.set(l);
    draw();
    applyWords();
    ui.form.querySelectorAll('input[type=email]').forEach(i => { if (i.value) paintMailFix(i); }); // "Did you mean …" in the new language
    if (ui.live) ui.live.textContent = ''; // nothing said in the last language is read out after
    show(currentId, { focus: false, scroll: false, ...(area?.area ? { piece: atPiece({ page: currentId, ...area }) } : { at: anchor && fieldEl(anchor) ? anchor : null }) })
      .then(() => { langAt = anchor ? { page: currentId, screen: screenNo, lang, field: anchor } : null; });
    if (!reducedMotion()) [ui.form, ui.stop, ui.done].forEach(el => !el.hidden && el.animate?.([{ opacity: 0.4 }, { opacity: 1 }], { duration: 220, easing: EASE }));
    if (persist) save();
  }
  ui.langSwitches.forEach(sw => sw.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (!b) return;
    setLang(b.dataset.lang);
    // A phone's switch is one button, the other language: focus stays on it, not lost to the page
    if (!b.getClientRects().length) [...sw.querySelectorAll('[data-lang]')].find(x => x.getClientRects().length)?.focus({ preventScroll: true });
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
      cta.dataset.afT = open ? heroCtaWord() : 'heroNotify';
      cta.classList.toggle('btn-glow', open);
      cta.textContent = T(cta.dataset.afT);
    }
    paintHeroNote();
  }
  // ── Before they start: what this device knows ─────────────────────
  // The application sent from here (a parent unsure it went through isn't sent into a second one), and a
  // saved one that couldn't be opened just now (its link's words at the top, where they land)
  const sentStore = local(keyed('soard-application-sent'));
  /** The device goes to its other application, and keeps this one as the way back */
  function openOther() {
    const was = otherHere();
    if (!was) { notice(null); paintHub(); return; }
    store.set({ token: was.token, year: was.year || year });
    if (token) otherStore.set({ token, year }); else otherStore.clear();
    try { sessionStorage.removeItem(keyed(SCREEN_KEY)); } catch { /* storage off */ }
    location.replace(location.pathname);
  }
  ui.notice.addEventListener('click', (e) => {
    if (e.target.closest('[data-notice-act="emailLink"]')) { openLater(); return; }
    if (e.target.closest('[data-notice-act="openOther"]')) openOther();
  }, { signal });
  ui.hubOther?.addEventListener('click', openOther, { signal });
  let resumePending = null; // a saved application not reached yet: Start tries it again (not a blank one)
  let linkGone = false;     // the link they came by has expired
  let wantIn = false;       // they pressed Continue while it was being tried: in, once it opens
  const sentHere = () => { const x = !token && !testRun && !previewing ? sentStore.get() : null; return x?.year === year ? x : null; };
  const sentDate = (at) => new Date(at).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'long', day: 'numeric' });
  const heroCtaWord = () => (doneShown && !previewing ? 'heroAnother' : token || resumePending ? 'heroContinue' : sentHere() ? 'heroAnother' : 'heroStart');
  function paintHeroNote() {
    const el = document.querySelector('[data-hero-note]');
    if (!el) return;
    // Sent from this page just now (or its link was for one already sent): said here too, once they close it
    const sent = doneShown && !previewing && !testRun ? sentStore.get() || {} : sentHere();
    const m = (token && !doneShown) || focused ? null
      : resumePending ? { m: 'resumeFailed', kind: 'error' }
        : linkGone ? { m: 'linkExpired', kind: 'error' }
          : sent ? { m: sent.at ? ['sentNote', { date: sentDate(sent.at) }] : 'sentNoteToday', kind: 'success' } : null;
    el.hidden = !m || root.hidden;
    if (!m) return;
    el.dataset.kind = m.kind;
    el.textContent = say(m.m);
  }
  /** Continue pressed while the saved application couldn't be reached: tried again now, and opened when it comes */
  function tryResumeNow() {
    wantIn = true;
    for (const b of [document.querySelector('[data-hero-cta]'), ui.hubGo]) b?.setAttribute('aria-busy', 'true');
    clearTimeout(resumeTimer);
    resumeAgain?.();
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
        callback: (t) => {
          turnstileToken = t; turnstileFailed = false; turnstileWaiting.splice(0).forEach(r => r());
          if (['turnstile', 'turnstileFailed', 'turnstileLater'].includes(lastNav?.m)) navNote(null);
          if (laterWaiting) sendLaterNow(); // "Email me the link" was pressed before the check: it goes now
        },
        // It couldn't pass at all (it tries again by itself): said so, with a way forward, not "complete the check"
        'error-callback': () => { turnstileFailed = true; turnstileWaiting.splice(0).forEach(r => r()); if (checkAsked) navNote('turnstileFailed'); },
        'expired-callback': () => { turnstileToken = null; },
        // It wants a tap (it won't pass on its own): asked for now, not after the wait
        'before-interactive-callback': () => { turnstileWants = true; turnstileWaiting.splice(0).forEach(r => r()); },
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
  let resumeTimer = 0;
  let resumeAgain = null; // not reached: tried again a little later, and as soon as the connection's back
  window.addEventListener('online', () => { if (resumeAgain) { clearTimeout(resumeTimer); resumeAgain(); } }, { signal });
  /** An application this device has going, started in another tab or window (this one has none of its own) */
  const othersStarted = () => { const s = token || previewing || testRun ? null : store.get(); return isToken(s?.token) && (!s.year || s.year === year); };
  // Started there while this page sat on its start: "Continue where you left off" here too. (Already on the
  // application's screen, it's picked up at Continue: the screen isn't changed under them.) The same application
  // taken further there: this page's Continue goes on from there, with that tab's answers
  window.addEventListener('storage', (e) => {
    if (e.key !== keyed(STORE_KEY) || focused || doneShown || root.hidden) return;
    if (othersStarted()) { resume().then(() => { if (token && lastNotice?.m === 'welcomeBack') notice('pickedUp', 'info'); }).catch(() => {}); return; }
    const s = store.get();
    if (token && !previewing && s?.token === token && order(s.furthest) > order(furthestId)) { furthestId = s.furthest; aheadElsewhere = true; paintHub(); }
  }, { signal });
  async function resume(link = null, tries = 0) {
    const params = new URLSearchParams(location.search);
    const fromLink = link?.token || params.get('resume');
    const remindersOff = link ? link.remindersOff : params.get('reminders') === 'off';
    if (fromLink) history.replaceState(history.state, '', location.pathname); // keep the token out of screenshots and shares
    const saved = store.get();
    const candidate = fromLink || saved?.token;
    if (!isToken(candidate)) { if (fromLink) { notice('linkExpired', 'error'); linkGone = true; paintHeroNote(); } return; }
    resumeAgain = null;
    const r = await api({ action: 'resume', token: candidate, ...(remindersOff ? { reminders: 'off' } : {}) }).catch(() => null);
    for (const b of [document.querySelector('[data-hero-cta]'), ui.hubGo]) b?.removeAttribute('aria-busy'); // a Continue that tried it again
    if (token) return; // they started a new one while it was trying
    if (!r?.ok) {
      // Gone (or never was): forgotten on this device. Not reached (offline, busy, a hiccup): kept on this
      // device (the link's too, with the link gone from the address bar), and opened as soon as it can be
      if (r && (r.code === 'no-draft' || r.status === 404)) {
        if (fromLink) { notice('linkExpired', 'error'); linkGone = true; }
        store.clear();
        resumePending = null;
        wantIn = false;
        showApp(!root.hidden);
        paintHub();
        return;
      }
      if (fromLink && saved?.token !== fromLink) store.set({ token: fromLink, year });
      notice('resumeFailed', 'error');
      if (wantIn) announce(T('resumeFailed')); // they pressed Continue: still not, and why
      resumePending = { link: fromLink };
      if (!root.hidden || fromLink) showApp(true); // its Continue tries it again (a saved one can be finished after we close)
      paintHub();
      resumeAgain = () => { resumeAgain = null; if (!token) resume(fromLink ? { token: fromLink, remindersOff } : null, tries + 1).catch(() => {}); };
      resumeTimer = setTimeout(() => resumeAgain?.(), Math.min(30000, 3000 * 2 ** tries));
      return;
    }
    token = candidate;
    rev = Number(r.rev) || 0;
    resumePending = null;
    linkGone = false;
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
    // Their answer to the area question is theirs only when the check couldn't place the address (else it was the check's)
    askedFor = areaField() && answers[areaField().id] && !(areaNow && AREA_VALUES[areaNow.band]) ? addressKey(answers[homeAddressId() || 'address']) : null;
    for (const [id, pf] of Object.entries(r.files || {})) {
      if (id === 'video') {
        if (pf.uploaded) { files.video = { uid: true, uploaded: true, name: pf.name }; uploadUi.video = { state: 'done', msg: ['videoDone', { name: pf.name }] }; }
        else uploadUi.video = { state: 'empty', msg: 'videoGone' };
      } else {
        files[id] = { key: true, name: pf.name };
        uploadUi[id] = { state: 'done', msg: ['added', { name: pf.name }] };
      }
    }
    // A video cut off by the page going (a reload, the tab closed), its upload kept here: the same video again carries on
    const going = videoGoing.get();
    if (going?.token === candidate && byId[going.field] && !r.files?.[going.field]?.uploaded) uploadUi[going.field] = { state: 'empty', msg: 'videoResume' };
    draw({ merge: false });
    synced = readAnswers();
    // What was typed here last time and never reached the server (offline, the tab closed): back on top
    const kept = pending.get();
    let keptBack = 0;
    if (kept?.token === candidate && !r.submitted) {
      for (const [id, v] of Object.entries(kept.changed || {})) {
        const f = byId[id];
        if (!f || !isInput(f) || sameAnswer(v, synced[id])) continue;
        answers[id] = v;
        writeField(f, v);
        keptBack++;
      }
      if (keptBack) { openAnsweredTucked(); refresh({ animate: false }); }
    }
    if (!keptBack) pending.clear();
    applyWords();
    if (r.submitted) { finished(true); return; }
    // Their photos' small previews, so they see which ones they sent (not a gray box)
    for (const [id, pf] of Object.entries(r.files || {})) if (id !== 'video' && pf.hasThumb) loadThumb(id);
    // An address without the check's answer for it (it changed just before they left): checked again
    if (homeAddressId() && !areaPlaced() && checkable(homeAddressNow())) scheduleArea(true);
    // How far they got: the draft's record, this device's, the page they were on, what they filled in
    const mine = saved?.token === candidate ? saved.furthest : null;
    const known = [r.maxPage, r.maxPageId, r.max_page_id, mine, r.page, lastAnsweredPage(answers)].filter(id => order(id) >= 0);
    furthestId = known.sort((x, y) => order(y) - order(x))[0] || furthestId;
    const ids = stepIds(answers);
    // A reload in the same tab: the screen they were on (with the box they were typing in), the history
    // entry they reloaded on first, even when they'd gone back from further on (its Back then goes a screen back)
    let was = null;
    if (!fromLink) {
      try { was = JSON.parse(sessionStorage.getItem(keyed(SCREEN_KEY)) || 'null'); } catch { /* storage off */ }
      const entry = history.state?.afFocus ? history.state.afAt : null;
      if (entry?.page && entry.page !== was?.page) was = entry;
    }
    const tab = was?.page && ids.includes(was.page) && order(was.page) <= order(furthestId) ? was.page : null;
    // Answers this device kept (never saved: offline when they left): the page they were on then, not the server's last
    const keptAt = keptBack && kept.page && ids.includes(kept.page) && order(kept.page) <= order(furthestId) ? kept.page : null;
    const at = tab || keptAt || (ids.includes(r.page) ? r.page : ids[0]);
    currentId = null;
    resumePiece = (was?.page === at && was.field && atPiece(was)) || (keptAt && keptAt === at && kept.field && atPiece(kept)) || null;
    // Reloaded while changing an answer from the review: its Continue still says "Back to review"
    const onEntry = !fromLink && history.state?.afFocus ? history.state.afAt : null;
    if (onEntry?.fromReview && onEntry.page === at) fromReview = onEntry.fromReview;
    show(at, { focus: false, scroll: false, screen: 'open' });
    remember();
    showApp(true); // the hero's button says "Continue"
    // A link to another application than the one this device had going (a brother's or sister's): said, so the
    // one they were on isn't thought lost
    const other = !!fromLink && isToken(saved?.token) && saved.token !== fromLink;
    if (other) otherStore.set({ token: saved.token, year: saved.year || year }); // a way back to it from here (it may have no link of its own)
    const otherSaid = other && !keptBack;
    // (a brother's or sister's this device also has: offered each time they come back, and on the overview)
    const m = remindersOff ? (otherSaid ? 'remindersOffOther' : 'remindersOff') : keptBack ? 'keptHere' : otherSaid ? 'otherApplication' : otherHere() ? 'welcomeBackOther' : 'welcomeBack';
    // ("No more reminder emails" is what their press was for: there till they move on, the screen fitted with it)
    notice(m, otherSaid || remindersOff ? 'info' : 'success', /Other$|^otherApplication$/.test(m) ? 'openOther' : null);
    if (keptBack) save();
    // A reload on a "can't help" screen: that screen again while the answer that led to it stands (its place in
    // the browser's history is the stop's, so Back from it is the question's, as before the reload)
    const stopAgain = !fromLink && history.state?.afFocus && history.state.afAt?.stop ? stopFor(form, readAnswers()) : null;
    if (fromLink || session.get() || wantIn) begin();
    if (stopAgain && focused && stopAgain.page === currentId) showStop(stopAgain);
    wantIn = false;
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
    if (doneShown && token && !previewing) { another(); return; }
    if (resumePending && !token) { tryResumeNow(); return; }
    begin();
  }, { signal });
  /** Sent, and "Apply for another child": the page afresh (nothing of the one sent kept), straight into the new one */
  const ANOTHER_KEY = keyed('soard-application-another');
  function another() {
    try { sessionStorage.setItem(ANOTHER_KEY, '1'); } catch { /* storage off: the page's own Start, after */ }
    location.reload();
  }
  ui.hubGo?.addEventListener('click', () => { if (resumePending && !token) tryResumeNow(); else begin(ui.hubGo.dataset.go || null); });
  ui.hubList?.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (!go || go.disabled) return;
    if (!doneShown) takeDetour(go.dataset.goto);
    // Left from the review (Save and exit there): the step is walked through, then "Back to review", as its own Edit does
    if (!doneShown && currentId === 'review' && go.dataset.goto !== 'review') fromReview = 'step';
    begin(go.dataset.goto);
  });
  ui.exit?.addEventListener('click', () => exitFocus());
  // Escape closes "All steps" (and a press anywhere else does)
  // Escape: the steps list closes; else a screen back (Linear's way), never from a box they're typing in
  // (an address list, a sheet or a dialog closes first, on its own)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    if (ui.steps.open) { ui.steps.open = false; ui.steps.querySelector('summary')?.focus(); return; }
    if (!focused || ui.form.hidden || document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t?.matches?.('input:not([type=radio]):not([type=checkbox]), textarea, select')) return; // a box being typed in keeps its Escape
    if (back()) e.preventDefault();
  }, { signal });
  // A tap outside the open steps list closes it, and only that (not the button or link it landed on)
  let eatClick = 0;
  document.addEventListener('pointerdown', (e) => {
    if (!ui.steps.open || ui.steps.contains(e.target)) return;
    ui.steps.open = false;
    eatClick = performance.now() + 700;
  }, { signal });
  document.addEventListener('click', (e) => {
    if (performance.now() > eatClick) return;
    eatClick = 0;
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true, signal });
  // Back from the phone or the browser: a screen back (see armTrap). The page's inline gate
  // (ApplicationPage.astro) asks this first, ahead of the site's router; true = handled here.
  window.__afPop = (e) => {
    if (swallow) { swallow = false; return true; }
    const st = e?.state ?? history.state;
    if (!focused) {
      // Forward onto one of its entries after Save and exit: the application opens again, on that screen
      if (!st?.afFocus || root.hidden) return false;
      // Sent (and the page reloaded since): its screens went with it, and a new one starts from the page's
      // button. Back leaves the page, past those entries, as a page's Back does
      if (doneShown || sentHere()) {
        const to = st.afDepth || 1;
        if (to > pageAt) { swallow = true; history.go(pageAt - to); } // Forward: nothing there now
        else { pageAt = to; history.go(-(to + 1)); }
        return true;
      }
      const to = st.afDepth || 1;
      // The screen they left, its entry further on: the browser goes there too, so Back and Forward still line up
      const at = left && left.depth > to ? left.at : st.afAt;
      if (left && left.depth > to) { swallow = true; history.go(left.depth - to); depth = left.depth; } else depth = to;
      left = null;
      if (at) { trail[depth] = at; resumePiece = atPiece(at); fromReview = (at.page !== 'review' && at.fromReview) || false; }
      begin(at?.page || null);
      return true;
    }
    const to = st?.afFocus ? (st.afDepth || 1) : 0;
    const dir = to > depth ? 1 : -1;
    // Sending: they stay on the review till it's sent (or isn't), the browser's history lined up with it
    if (submitting) { swallow = true; history.go(-dir); return true; }
    // A sheet or dialog open: Back closes it, and they stay on the screen it was over
    const sheet = [ui.dialog, ui.detail].find(d => d?.open);
    if (sheet) { sheet.close(); swallow = true; history.go(-dir); return true; }
    keepHeldAddresses(); // the screen's being left: an address typed over and not picked is the one it held
    if (st?.afAt?.page && st.afAt.page !== 'review') fromReview = st.afAt.fromReview || false; // as the entry was left
    depth = to;
    if (st?.afAt) trail[to] = st.afAt;
    if (!to || doneShown) { exitFocus({ fromPop: true }); return true; } // back to the page itself
    if (stopShown) {
      // Back from a stop: the question that led to it, with the keys there (as its own "Go back" does)
      const field = stopField();
      stopShown = null;
      ui.stop.hidden = true;
      ui.form.hidden = false;
      if (field && dir < 0 && pageEl(currentId)?.contains(fieldEl(field))) {
        const shown = show(currentId, { dir, focusField: field, at: field, scroll: false });
        // The entry says the screen with that question (an address, when the stop came from its map's screen)
        if (st.afAt?.field !== field) shown.then(replaceLoc);
        return true;
      }
      if (!st.afAt || sameAt(st.afAt, whereNow())) {
        show(currentId, { dir, scroll: false });
        return true;
      }
    }
    // Forward onto a stop: it again, while the answer that led to it stands
    const stop = st.afAt?.stop ? stopFor(form, readAnswers()) : null;
    if (stop && stop.page === st.afAt.page) {
      if (!sameAt(st.afAt, whereNow())) goTo(st.afAt, dir);
      showStop(stop);
      return true;
    }
    if (st.afAt) goTo(st.afAt, dir);
    else if (dir < 0) back(); // an entry from before they said where they were: a screen back
    return true;
  };
  const rearm = () => { if (focused && !depth) armTrap(); };
  // Typing in a box when the page goes (a reload): that box's screen is the one to come back to
  window.addEventListener('pagehide', () => {
    const f = document.activeElement?.closest?.('[data-field]');
    if (!focused || !f || !onScreen(f) || !pageEl(currentId)?.contains(f)) return;
    try { sessionStorage.setItem(keyed(SCREEN_KEY), JSON.stringify({ page: currentId, field: f.dataset.field })); } catch { /* storage off */ }
  }, { signal });
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
      // The screen with the box they're typing in stays (a window made shorter, a tablet turned), with the keys in it;
      // else the screen's own first piece
      const keysAt = document.activeElement;
      const typing = keysAt?.closest?.('[data-field]');
      const mine = (el) => !!el && !!pageEl(currentId)?.contains(el) && !el.closest('[data-off]');
      const piece = (mine(typing) && typing) || (anchor && pageEl(currentId)?.contains(anchor) && anchor) || packs[currentId]?.[screenNo]?.[0] || null;
      delete packs[currentId];
      show(currentId, { piece, focus: false, scroll: false, refit: true }).then(() => {
        if (mine(typing) && keysAt?.isConnected && keysAt.getClientRects().length && document.activeElement !== keysAt) keysAt.focus({ preventScroll: true });
        requestAnimationFrame(() => requestAnimationFrame(() => replan(true)));
      });
    }, 180);
  }, { passive: true, signal });

  // Review: a step opens to its answers; "Show all answers" opens every one
  ui.review.addEventListener('click', (e) => {
    const tg = e.target.closest('[data-review-toggle]');
    if (tg) { setReviewOpen(tg.closest('.af-review-section'), tg.getAttribute('aria-expanded') !== 'true'); return; }
    // "Did you mean …@gmail.com?": the answer is changed to it, there and then
    const fix = e.target.closest('[data-mailfix-review]');
    const input = fix && fieldEl(fix.dataset.mailfixReview)?.querySelector('input[type=email]');
    if (input) {
      input.value = fix.dataset.fix;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      buildReview();
      ui.reviewSummary.focus?.({ preventScroll: true });
    }
  });
  ui.reviewAll?.addEventListener('click', () => {
    reviewAll = !reviewAll;
    ui.review.querySelectorAll('.af-review-section').forEach(sec => setReviewOpen(sec, reviewAll || sec.hasAttribute('data-missing')));
    paintReviewAll();
  });

  ui.form.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more-open], [data-more-close], [data-more-undo]');
    if (more) {
      if (more.matches('[data-more-undo]')) undoGroup(more.closest('[data-more]'));
      else if (more.matches('[data-more-open]')) { dropGroupUndo(more.closest('[data-more]')); openTucked(more.closest('[data-more]').querySelector('[data-field]'), { focus: true }); makeRoom(more.closest('[data-more]')); }
      else { const box = more.closest('[data-more]'); closeTucked(box); closeRoom(box); } // (a note's own Remove goes with the note)
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
    // A choice greyed out because they've picked as many as it takes: they're told why, by the buttons
    const full = e.target.closest('.af-choice:has(input[aria-disabled="true"])');
    const fullField = full && byId[full.closest('[data-field]')?.dataset.field];
    if (fullField?.max && !e.target.closest('[data-tile-more]')) { e.preventDefault(); navNote(['detailFull', { n: fullField.max }]); announce(T('detailFull', { n: fullField.max })); return; }
    // An empty photo or video box opens the picker wherever it's pressed, not just on its button
    const box = e.target.closest('.af-upload[data-state="empty"]');
    if (box && !e.target.closest('button, a, input')) { box.querySelector('[data-act="choose"]')?.click(); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const el = act.closest('[data-field]');
      const f = byId[el?.dataset.field];
      if (!f) return;
      switch (act.dataset.act) {
        case 'choose':
          // On its way already: said (a keyboard reaches the button the dimming keeps a finger from), not a picker
          // whose choice would be dropped
          if (uploads.has(f.id)) { announce(T('uploadWait')); break; }
          el.querySelector('input[type=file]').click();
          break;
        case 'remove': removeFile(f); break;
        case 'cancel': cancelVideo(f.id); break;
        case 'undo': undoRemove(f); break;
        case 'retry':
          el.querySelector('[data-act="choose"]')?.focus({ preventScroll: true }); // "Try again" steps aside while it goes
          if (retryFiles[f.id]) takeFile(f, retryFiles[f.id]);
          break;
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
        case 'area-again': {
          // Its "Checking the address…" in its place until there's word, then the card (and the key on what's there)
          if (area.retrying || !areaFailed()) break;
          area.retrying = true;
          paintArea();
          fieldEl(areaField().id)?.querySelector('[data-act="area-again"]')?.focus({ preventScroll: true });
          areaAgain()?.then(() => {
            const box = fieldEl(areaField()?.id)?.querySelector('[data-area-result]');
            if (box && !box.contains(document.activeElement) && document.activeElement === document.body) (box.querySelector('[data-act="area-again"]') || box.querySelector('button'))?.focus({ preventScroll: true });
          });
          break;
        }
        case 'area-apt': {
          // To the apartment's own box, on the address's screen
          if (!homeAddressId()) break;
          focusOn(homeAddressId());
          const apt = fieldEl(homeAddressId())?.querySelector('[data-part="line2"]');
          if (apt?.getClientRects().length) apt.focus();
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
      reviewBack = edit.dataset.edit ? { edit: edit.dataset.edit } : { page: pid }; // "Back to review" lands here again
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
    if (tgt.tagName === 'TEXTAREA') { grow(tgt); capBoxes(pageEl(currentId)); paintCount(tgt); }
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
    if (tgt.closest('[data-area-ask]')) askedFor = addressKey(homeAddressNow()); // their answer, for this address
    const el = tgt.closest('[data-field]');
    if (tgt.type === 'tel') { const shaped = phoneShape(tgt.value, true); if (shaped !== tgt.value) tgt.value = shaped; }
    if (tgt.matches('[data-part="line2"]')) { const b = addrBox(el); if (b) delete b.dataset.splitApt; } // an apartment they entered is theirs
    if (tgt.type === 'email') paintMailFix(tgt);
    liveCheck(el);
    // A whole date entered under a note about it (it's "change" once every part's in): the note says what's so now
    // ("Please check the year", or gone), not "Please answer this question" over a date
    if (tgt.type === 'date' && el && shown.has(el.dataset.field)) setFieldError(el.dataset.field, errorFor(el.dataset.field));
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
    if (placing && byId[id]?.type === 'address') return; // picked from the list, its parts still on their way: nothing to say yet
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
    // Closed (Escape, a click away): Down brings the list back for what's typed, the same words' list without looking again
    if (!open && e.key === 'ArrowDown' && !e.altKey && !addrBox(input.closest('[data-field]'))?.dataset.picked) {
      const el = input.closest('[data-field]');
      const q = input.value.trim();
      if (sug.last?.input === input && sug.last.q === q) { e.preventDefault(); openSuggest(el, input, sug.last.items, sug.last.google); moveActive(1); }
      else if (sugSeen.get(sugKey(q)) || narrowed(q)) { e.preventDefault(); const seen = sugSeen.get(sugKey(q)); sug.last = { input, q, ...seen }; openSuggest(el, input, seen.items, seen.google); moveActive(1); }
      else if (searchable(q)) { e.preventDefault(); fetchSuggest(el, input, q); }
      return;
    }
    // Enter on what's typed, none of the list picked (open or not): as Continue does, the exact match is taken, or
    // they're told to choose from the list (and it's open), never nothing at all
    if (e.key === 'Enter' && !e.isComposing && !(open && sug.active >= 0) && input.value.trim() && addrBox(input.closest('[data-field]'))?.dataset.picked !== input.value) { e.preventDefault(); next(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveActive(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (sug.active >= 0) chooseOption(options()[sug.active]); else closeSuggest(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSuggest(); }
    else if (e.key === 'Tab') closeSuggest();
  });
  // Enter (the keyboard's "next") goes to the next box on the screen; on the last one it's Continue
  ui.form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.shiftKey) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || ['radio', 'checkbox', 'file', 'submit', 'button'].includes(t.type) || t.closest('.af-hp')) return;
    // (an address's apartment box is passed over from its own line: Enter on a picked address is Continue)
    const own = t.closest('[data-field]');
    const boxes = [...(pageEl(currentId)?.querySelectorAll('input:not([type=hidden]):not([type=file]):not([disabled]), select, textarea') || [])]
      .filter(x => x.getClientRects().length && !x.closest('[hidden], [data-off]'))
      .filter(x => !(x.dataset.part === 'line2' && x !== t && x.closest('[data-field]') === own))
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
    if (!zone || !hasFiles(e)) return;
    e.preventDefault(); // (a box still uploading too: a file let fall on it never opens in the browser, off the application)
    if (zone.dataset.state === 'busy' && !stoppable(zone.closest('[data-field]')?.dataset.field)) { e.dataTransfer.dropEffect = 'none'; return; }
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
    if (f && file && zone.dataset.state === 'busy' && !stoppable(f.id)) announce(T('uploadWait')); // said, not dropped without a word
    else if (f && file) takeFile(f, file);
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e) && !dropZone(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } }, { signal });
  window.addEventListener('drop', (e) => { if (hasFiles(e) && !dropZone(e)) e.preventDefault(); }, { signal });

  // Leaving (a reload, a closed tab, a phone locking or switching apps): what's not saved yet goes with a
  // keepalive request, which the browser finishes after the page is gone (Safari drops an ordinary one)
  function saveOnLeave(e) {
    // The page closing (not just hidden: they may be off copying an address from another app): a typed-over address back
    if (e?.type === 'pagehide') keepHeldAddresses();
    dropRemoved(null, { leaving: true });
    if (token && !previewing && (unsaved() || ['unsaved', 'saving'].includes(lastSave))) keepPending();
    if (!token || previewing || !['unsaved', 'saving'].includes(lastSave)) return;
    clearTimeout(dirtyTimer);
    const ids = stepIds();
    const page = currentId === 'review' ? ids[ids.length - 2] : currentId;
    try {
      const now = readAnswers();
      fetch(API, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', token, answers: now, page, lang, rev, changed: Object.keys(now).filter(id => !sameAnswer(now[id], synced?.[id])) }) });
    } catch { /* the page is going either way */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveOnLeave(); else peek(); }, { signal });
  window.addEventListener('pagehide', saveOnLeave, { signal });
  // Map names are spaced for the width they're shown at; a page shown after a hidden one gets its turn too
  let declutterTimer = 0;
  const redeclutter = () => { clearTimeout(declutterTimer); declutterTimer = setTimeout(() => { declutter(ui.pages); declutter(ui.stopMap); }, 120); };
  window.addEventListener('resize', redeclutter, { signal });
  window.addEventListener('resize', fitNavLater, { signal });
  window.addEventListener('resize', fitTopTitle, { signal });
  window.visualViewport?.addEventListener('resize', placeSuggest, { signal });
  window.visualViewport?.addEventListener('scroll', placeSuggest, { signal });
  // Measured again in the site's own type once it has loaded (the first screen can come before it)
  document.fonts?.ready.then(() => {
    fitNavLater();
    fitTopTitle();
    replan();
  });
  window.addEventListener('beforeunload', (e) => {
    // An upload or a recording would be cut off; changes not saved yet (offline, the server failing) are
    // kept on this device, but a family on someone else's phone wouldn't be back to it
    if (uploads.size || recorder?.rec || (token && !doneShown && unsaved())) { e.preventDefault(); e.returnValue = ''; return; }
    // A browser that won't keep their place (every cookie blocked): leaving with answers and no emailed link asks
    // first, as "Before you leave, use Save and finish later" said
    if (!canKeep && !testRun && token && !doneShown && !laterEmail && !previewing && Object.values(readAnswers()).some(v => !blank(v))) { e.preventDefault(); e.returnValue = ''; }
  }, { signal });
  // Leaving through a site link doesn't fire beforeunload; ask before an upload is cut off. Asked on the link's own
  // click, before the site's router: a "no" given to the router it turns into a full page load (and the browser
  // asks a second time); here "Cancel" simply keeps them on the page, the upload going on
  let leaveOk = false;
  document.addEventListener('click', (e) => {
    if (!(uploads.size || recorder?.rec) || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.hash)) return; // another site: the browser asks
    if (confirm(T('leaveUpload'))) { leaveOk = true; return; }
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true, signal });
  document.addEventListener('astro:before-preparation', (e) => {
    if ((uploads.size || recorder?.rec) && !leaveOk && !confirm(T('leaveUpload'))) e.preventDefault(); // (the browser's Back)
    else if (token) save();
    leaveOk = false;
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
    resume().catch(() => {}).finally(() => { if (!token) applyConfig(); ready(); });
  }
  if (previewing) ready();
  /** Ready to start: a tap on Start made while the script was loading (the page's inline catcher kept it) goes ahead now */
  function ready() {
    root.dataset.ready = 'go';
    const want = window.__afWant;
    window.__afWant = null;
    for (const b of document.querySelectorAll('[data-hero-cta][aria-busy], [data-hub-go][aria-busy]')) b.removeAttribute('aria-busy');
    let again = false;
    try { again = sessionStorage.getItem(ANOTHER_KEY) === '1'; sessionStorage.removeItem(ANOTHER_KEY); } catch { /* storage off */ }
    if (again && !token && !root.hidden) { begin(); return; } // "Apply for another child", after the reload
    if (want) (want === 'hub' ? ui.hubGo : document.querySelector('[data-hero-cta]'))?.click();
  }
}
