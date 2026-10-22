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

/** The page's config: embedded by the page's Function, else asked for */
async function loadConfig(mode) {
  const embedded = document.getElementById('af-config');
  if (embedded && mode !== 'draft') {
    try { return JSON.parse(embedded.textContent); } catch { /* fall through to the API */ }
  }
  try {
    const res = await fetch(`${API}?config${mode === 'draft' ? '&preview=draft' : ''}`, { cache: 'no-store' });
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
  init(root, (await loadConfig(mode)) || {}, mode);
}

function init(root, cfg, mode) {
  // Listeners on document/window end when the page is swapped out
  const life = new AbortController();
  const { signal } = life;
  document.addEventListener('astro:before-swap', () => { closeRecorder(); life.abort(); }, { once: true });

  const live = mode === 'live';
  const previewing = live || !!cfg.preview;
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
    stepTitle: $('[data-step-title]'),
    bar: $('[data-progress-bar]'),
    steps: $('[data-steps]'),
    stepsList: $('[data-steps-list]'),
    back: $('[data-back]'),
    next: $('[data-next]'),
    nextLabel: $('[data-next-label]'),
    navNote: $('[data-nav-note]'),
    saveLaters: [...root.querySelectorAll('[data-save-later]')],   // under the buttons, and in the rail on a computer
    saveStates: [...root.querySelectorAll('[data-save-state]')],
    rail: $('[data-rail]'),
    railList: $('[data-rail-list]'),
    timeLeft: $('[data-time-left]'),
    mini: $('[data-mini]'),
    miniStep: $('[data-mini-step]'),
    miniTitle: $('[data-mini-title]'),
    miniBar: $('[data-mini-bar]'),
    live: $('[data-live]'),
    notice: $('[data-notice]'),
    langSwitch: $('[data-lang-switch]'),
    stop: $('[data-stop]'),
    stopTitle: $('[data-stop-title]'),
    stopBody: $('[data-stop-body]'),
    stopMap: $('[data-stop-map]'),
    done: $('[data-done]'),
    honeypot: $('[data-honeypot]'),
    turnstile: $('[data-turnstile]'),
    dialog: $('[data-later-dialog]'),
  };

  // ── State ────────────────────────────────────────────────────────
  let lang = startLang();
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
  let furthestId = null;     // the furthest page reached
  let fromReview = false;    // came from the review page to change something
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
  let areaNow = null;        // the last service-area check of the home address: { key, band, answer, lat, lng, miles, county, matched, reason }

  const T = (k, v = {}) => word(lang, k, { year, ...v });
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
    closeRecorder();
    closeSuggest();
    form = resolve(lang);
    lang = form.lang || 'en';
    fields = allFields(form);
    byId = indexById(form);
    ui.pages.innerHTML = renderPages(form, lang);
    ui.pages.removeAttribute('aria-busy');
    pageEls = Object.fromEntries([...ui.pages.querySelectorAll('[data-page]')].map(el => [el.dataset.page, el]));
    for (const f of fields) if (isInput(f)) writeField(f, answers[f.id]);
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
    ui.langSwitch.hidden = langs.length < 2;
    ui.langSwitch.querySelectorAll('[data-lang]').forEach(b => {
      b.hidden = !langs.includes(b.dataset.lang);
      b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    });
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
      if (show && animate) enter(el, 0, -6);
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
  function enter(el, x, y = 0, duration = SLIDE_MS) {
    if (!el || reducedMotion() || !el.animate) return null;
    return el.animate([{ opacity: 0, transform: `translate(${x}px, ${y}px)` }, { opacity: 1, transform: 'none' }], { duration, easing: EASE });
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
    return parseInt(getComputedStyle(document.documentElement).scrollPaddingTop, 10) || 100;
  }
  /** Bring the top of the form back into view if the family has scrolled past it */
  function scrollToForm(force = false) {
    const top = ui.form.getBoundingClientRect().top;
    const offset = headerOffset();
    if (!force && top >= offset - 8) return;
    window.scrollTo({ top: Math.max(0, window.scrollY + top - offset), behavior: reducedMotion() ? 'auto' : 'smooth' });
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

  function paintHeader() {
    const ids = stepIds();
    const i = Math.max(0, ids.indexOf(currentId));
    ui.stepText.textContent = T('step', { n: i + 1, total: ids.length });
    const title = currentId === 'review' ? T('reviewTitle') : (form.pages.find(p => p.id === currentId)?.title || '');
    if (ui.stepTitle.textContent !== title) ui.stepTitle.textContent = title;
    const done = (i + 1) / ids.length;
    ui.bar.style.transform = `translateX(${done * 100 - 100}%)`;
    // The bar that follows a phone down the page says the same
    if (ui.mini) {
      ui.miniStep.textContent = `${i + 1}/${ids.length}`;
      ui.miniTitle.textContent = title;
      ui.miniBar.style.transform = `scaleX(${done})`;
      ui.mini.setAttribute('title', T('miniUp'));
    }
    paintTimeLeft(ids);
    paintStepList(ids);
    paintNav(ids);
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
  function paintTimeLeft(ids) {
    if (!ui.timeLeft || !railShown()) return;
    if (currentId === 'review') { ui.timeLeft.textContent = T('leftReview'); return; }
    const a = readAnswers();
    const all = secondsLeft(ids, a, ids[0], true) || 1;
    const mins = Math.max(1, Math.ceil((secondsLeft(ids, a, currentId) / all) * 15));
    ui.timeLeft.textContent = mins <= 1 ? T('leftOne') : T('leftMany', { n: mins });
  }

  /**
   * The step lists ("All steps" in the card, and the rail beside it on a computer): done ones
   * checked, this one marked, later ones not open yet. Each is painted only while it shows.
   * Updated in place: an answer saved as someone presses a step (a blur's change event)
   * must not swap the button out from under the press.
   */
  const railShown = () => !!ui.rail && ui.rail.offsetParent !== null;
  function paintStepList(ids = stepIds()) {
    const lists = [ui.steps.open && ui.stepsList, railShown() && ui.railList].filter(Boolean);
    if (!lists.length) return;
    const errs = formErrors(form, readAnswers(), files, null, lang);
    const needs = new Set(Object.keys(errs).map(pageOf));
    for (const list of lists) paintList(list, ids, needs);
  }
  function paintList(list, ids, needs) {
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
        const name = document.createElement('span');
        name.className = 'af-step-name';
        b.append(mark, name, document.createElement('span'));
        li.append(b);
        return li;
      }));
    }
    ids.forEach((id, i) => {
      const li = list.children[i];
      const b = li.firstChild;
      const [mark, name, state] = b.children;
      li.toggleAttribute('data-line', i + 1 < ids.length && reached(ids[i + 1])); // the rail's joining line, dark once the next is reached
      const now = id === currentId;
      const open = reached(id);
      const done = !now && open && id !== 'review' && !needs.has(id) && order(id) < order(furthestId);
      b.dataset.state = now ? 'now' : done ? 'done' : open ? 'open' : 'locked';
      b.disabled = !open;
      b.toggleAttribute('aria-current', now);
      if (now) b.setAttribute('aria-current', 'step');
      const markHtml = done ? CHECK_SVG : String(i + 1);
      if (mark.dataset.v !== markHtml) { mark.dataset.v = markHtml; if (done) mark.innerHTML = CHECK_SVG; else mark.textContent = String(i + 1); }
      const title = id === 'review' ? T('reviewTitle') : form.pages.find(p => p.id === id)?.title || '';
      if (name.textContent !== title) name.textContent = title;
      state.className = now ? 'af-step-now' : 'af-sr';
      const said = now ? T('stepNow') : done ? T('stepDone') : open ? '' : T('stepLocked');
      if (state.textContent !== said) state.textContent = said;
    });
  }

  function paintNav(ids = stepIds()) {
    const review = currentId === 'review';
    const at = ids.indexOf(currentId);
    ui.back.hidden = at <= 0;
    const label = review ? (busy ? 'submitting' : 'submit') : fromReview ? 'toReview' : ids[at + 1] === 'review' ? 'reviewBtn' : 'next';
    ui.nextLabel.textContent = T(label);
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
    if (ui.turnstile) ui.turnstile.hidden = !(turnstileSiteKey && !token && !previewing && at === 0);
  }

  /** Put a page on screen: slides in from the right going forward, from the left going back */
  function show(id, { dir = 0, focus = true, focusField = null, scroll = true } = {}) {
    if (!pageEl(id)) id = stepIds()[0];
    const changed = id !== currentId;
    currentId = id;
    reach(id);
    if (id === 'review') fromReview = false;
    for (const [pid, el] of Object.entries(pageEls)) el.hidden = pid !== id;
    ui.review.hidden = id !== 'review';
    if (pageEl(id)?.querySelector('.af-map-frame')) requestAnimationFrame(() => declutter(pageEl(id)));
    if (id === 'review') buildReview();
    if (changed) {
      ui.steps.open = false;
      if (!lastNav?.reason) navNote(null);
      if (lastNotice?.kind === 'success') notice(null); // "Welcome back" has done its job once they move on
    }
    paintHeader();
    const moving = changed && dir && !reducedMotion();
    if (moving) {
      enter(pageEl(id), dir * 28);
      enter(ui.stepTitle, dir * 14);
    }
    if (scroll && !focusField) scrollToForm();
    growPage(id);
    requestAnimationFrame(paintMini);
    const after = () => {
      if (focusField) focusOn(focusField);
      else if (focus) ui.stepTitle.focus({ preventScroll: true });
    };
    if (moving) setTimeout(after, SLIDE_MS); else after();
  }

  async function next() {
    if (busy) return;
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
    const errors = formErrors(form, a, files, [currentId], lang);
    if (Object.keys(errors).length) { showPageErrors(errors); return; }
    const stop = stopFor(form, a);
    if (stop && stop.page === currentId) { showStop(stop); return; }
    setBusy(true);
    try {
      if (!(await start())) return;
      const ids = stepIds(a);
      const target = fromReview ? 'review' : ids[ids.indexOf(currentId) + 1] || 'review';
      show(target, { dir: 1 });
      save();
    } finally {
      setBusy(false);
    }
  }
  function back() {
    navNote(null);
    const ids = stepIds();
    const at = ids.indexOf(currentId);
    if (at <= 0) return;
    show(ids[at - 1], { dir: -1 });
    save();
  }
  /** Jump to a page already reached (the steps list, Edit, Answer it) */
  function jump(id, { focusField = null } = {}) {
    if (!reached(id) && !previewing) return;
    if (id === currentId && !focusField) return;
    const dir = Math.sign(order(id) - order(currentId));
    if (dir > 0) {
      const stop = stopFor(form, readAnswers());
      if (stop && order(stop.page) < order(id)) { showStop(stop); return; }
    }
    if (currentId === 'review' && id !== 'review') fromReview = true;
    show(id, { dir, focusField });
    save();
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
    focusOn(ids[0]);
  }
  /** Scroll a question to just under the header and put the cursor in it */
  function focusOn(id) {
    const el = fieldEl(id);
    if (!el || el.hidden) return;
    // The service-area answer comes from the address until the family is asked: send them to the address
    if (byId[id]?.type === 'area' && el.querySelector('[data-area-ask]')?.hidden && homeAddressId()) { focusOn(homeAddressId()); return; }
    openTucked(el, { animate: false });
    el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    const target = el.querySelector('input:not([type=file]):not([type=radio]):not([type=checkbox]):not([disabled]), textarea, select')
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
  }
  /** A note by the buttons, where the family is looking (reason = why Submit is off) */
  function navNote(m, reason = false) {
    lastNav = m ? { m, reason } : null;
    paintNavNote();
  }
  function paintNavNote() {
    ui.navNote.textContent = lastNav ? say(lastNav.m) : '';
    ui.navNote.hidden = !lastNav;
  }
  function saveState(key) {
    lastSave = key;
    paintSaveState();
  }
  function paintSaveState() {
    for (const el of ui.saveStates) {
      el.textContent = lastSave ? T(lastSave) : '';
      el.dataset.kind = lastSave || '';
    }
  }

  // ── Server calls ─────────────────────────────────────────────────
  async function start() {
    if (previewing || token) return true; // a preview walks the pages and saves nothing
    if (turnstileSiteKey && !turnstileToken) { navNote('turnstile'); return false; }
    let r;
    try { r = await api({ action: 'start', year, lang, turnstileToken, website: ui.honeypot?.value || '' }); } catch { r = { ok: false }; }
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
    const top = ui.stop.getBoundingClientRect().top;
    if (top < headerOffset()) window.scrollTo({ top: window.scrollY + top - headerOffset(), behavior: reducedMotion() ? 'auto' : 'smooth' });
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
    if (placed) ui.stopMap.innerHTML = `<div class="af-map af-map--stop">${areaMapHtml(form.serviceArea, { ...placed }, mapWords(lang, true))}</div>`;
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
    show(currentId, { focusField: field && fieldEl(field) ? field : null });
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
        } else continue;
        row.append(dt, dd);
        rows.push(row);
      }
      if (!rows.length) continue;
      const sec = document.createElement('section');
      sec.className = 'af-review-section';
      if (needs) sec.dataset.missing = '1';
      const head = document.createElement('div');
      head.className = 'af-review-head';
      const h = document.createElement('h3');
      h.textContent = p.title;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'af-btn af-btn--link af-review-edit';
      edit.dataset.edit = '';
      edit.dataset.page = p.id;
      edit.innerHTML = `${PENCIL_SVG}<span></span>`;
      edit.querySelector('span').textContent = T('edit');
      edit.setAttribute('aria-label', T('editSection', { name: p.title }));
      head.append(h, edit);
      const dl = document.createElement('dl');
      dl.append(...rows);
      sec.append(head, dl);
      sections.push(sec);
    }
    ui.reviewList.replaceChildren(...sections);
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
          fromReview = true;
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
    doneShown = { already, email: readAnswers().parentEmail || answers.parentEmail || '' };
    notice(null);
    ui.form.hidden = true;
    ui.stop.hidden = true;
    ui.done.hidden = false;
    root.classList.add('is-done'); // the steps beside the form have done their job
    paintMini();
    paintDone();
    // The sun rises once (the styles keep it still under reduced motion)
    ui.done.classList.remove('is-in');
    void ui.done.offsetWidth;
    ui.done.classList.add('is-in');
    const top = ui.done.getBoundingClientRect().top + window.scrollY - headerOffset();
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    ui.done.querySelector('[data-done-title]').focus({ preventScroll: true });
  }
  function paintDone() {
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

  // ── Address suggestions (a combobox on Street address) ───────────
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
    try {
      const res = await fetch(`${API}?address=${encodeURIComponent(q)}`, { signal: ctrl.signal });
      const data = await res.json();
      items = Array.isArray(data.results) ? data.results : Array.isArray(data.items) ? data.items : [];
    } catch { return; } // offline or the lookup is down: they keep typing as normal
    if (ctrl.signal.aborted || input.value.trim() !== q || document.activeElement !== input) return;
    openSuggest(el, input, items.filter(i => i?.line1).slice(0, 5));
  }
  function openSuggest(el, input, items) {
    if (!items.length) { closeSuggest(); return; }
    const list = el.querySelector('.af-suggest');
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
      sub.textContent = [it.city, [it.state, it.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      li.append(main, sub);
      return li;
    }));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
  }
  function closeSuggest() {
    clearTimeout(sug.closing);
    if (sug.list) { sug.list.hidden = true; sug.list.replaceChildren(); }
    if (sug.input) { sug.input.setAttribute('aria-expanded', 'false'); sug.input.removeAttribute('aria-activedescendant'); }
    Object.assign(sug, { items: [], active: -1, list: null });
  }
  function moveActive(d) {
    const n = sug.items.length;
    if (!n) return;
    sug.active = sug.active < 0 ? (d > 0 ? 0 : n - 1) : (sug.active + d + n) % n;
    [...sug.list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sug.active)));
    const li = sug.list.children[sug.active];
    sug.input.setAttribute('aria-activedescendant', li.id);
    li.scrollIntoView({ block: 'nearest' });
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
    set('line1', it.line1);
    set('city', it.city);
    set('state', it.state);
    set('zip', it.zip);
    const input = sug.input;
    closeSuggest();
    if (el.dataset.field === homeAddressId()) { fillCounty(it.county, el); scheduleArea(true); }
    liveCheck(el);
    refresh();
    markDirty();
    input?.focus({ preventScroll: true });
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
    if (!value) return; // not a county we serve: leave the question to the family
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
    if (areaNow?.key === key || area.want === key) return;
    // The old result no longer describes what's typed
    if (areaNow) paintArea('checking');
    area.timer = setTimeout(() => runArea(addr, key), now ? 0 : 650);
  }
  function runArea(addr, key) {
    area.want = key;
    clearTimeout(area.showTimer);
    area.showTimer = setTimeout(() => { if (area.want === key) paintArea('checking'); }, 180);
    area.pending = (async () => {
      let r;
      try { r = await api({ action: 'area', ...(token && !previewing ? { token } : {}), address: addr }); } catch { r = { ok: false }; }
      if (area.want !== key) return; // a newer address is being checked
      clearTimeout(area.showTimer);
      area.want = null;
      area.pending = null;
      areaNow = r.ok && r.area ? { ...r.area, key } : { key, band: 'unknown', reason: 'error' };
      // The Census's county is the one JobTread should get: fill it unless the family picked one themselves
      if (areaNow.county && homeAddressId()) {
        const county = readAnswers().county;
        if (!county || countyNote) fillCounty(areaNow.county, fieldEl(homeAddressId()));
      }
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
      return `<div class="af-area-card" data-band="ask">${AREA_ICONS.ask}<div class="af-area-text"><p class="af-area-title">${esc(T(st === 'unknown' ? 'areaUnknown' : 'areaError'))}</p><p class="af-area-desc">${esc(T(st === 'unknown' ? 'areaUnknownBody' : 'areaErrorBody'))}</p></div></div>`;
    }
    const value = AREA_VALUES[st];
    const stopping = st === 'far' && af.stops?.[value] && form.stops?.[af.stops[value]];
    // Far out with Settings stopping them: what the stop screen will say; else the choice's own words
    const desc = stopping ? form.stops[af.stops[value]].body : `<p class="af-area-desc">${esc(String(af.descriptions?.[value] || '').replace(/\{miles\}/g, milesText(areaNow.miles)))}</p>`;
    const title = { inside: 'areaInside', near: 'areaNear', far: 'areaFar' }[st];
    const found = areaNow.matched
      ? `<p class="af-area-found">${esc(T(areaNow.county ? 'areaFoundCounty' : 'areaFound', { address: prettyAddress(areaNow.matched), county: areaNow.county || '' }))}</p>` : '';
    return `<div class="af-area-card" data-band="${st}">${AREA_ICONS[st]}<div class="af-area-text"><p class="af-area-title">${esc(T(title))}</p><div class="af-area-desc-wrap">${desc}</div>${found}<button type="button" class="af-btn af-btn--link af-area-fix" data-act="area-fix">${esc(T('areaFix'))}</button></div></div>`;
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
        mapEl.innerHTML = areaMapHtml(form.serviceArea, home, mapWords(lang, !!home));
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
  }

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

  // ── The bar that follows a phone down the page ───────────────────
  let miniFrame = 0;
  function paintMini() {
    miniFrame = 0;
    if (!ui.mini) return;
    // On as the step's own progress line goes under the site header; off near the end of the card
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 72;
    const line = ui.bar.parentElement.getBoundingClientRect();
    const card = ui.form.getBoundingClientRect();
    const on = !root.hidden && !ui.form.hidden && line.bottom < top + 2 && card.bottom > top + 160;
    if (ui.mini.classList.contains('is-on') !== on) ui.mini.classList.toggle('is-on', on);
  }
  const onScroll = () => { if (!miniFrame) miniFrame = requestAnimationFrame(paintMini); };

  // ── Save and finish later ────────────────────────────────────────
  const dlg = ui.dialog;
  const openLater = () => {
    if (previewing) { notice('previewNoSave', 'info'); return; }
    const email = readAnswers().parentEmail;
    const input = dlg.querySelector('input[type=email]');
    if (email && !input.value) input.value = email;
    dlg.querySelector('[data-later-status]').textContent = '';
    dlg.querySelector('[data-later-form]').hidden = false;
    dlg.querySelector('[data-later-sent]').hidden = true;
    dlg.showModal();
  };
  ui.saveLaters.forEach(b => b.addEventListener('click', openLater));
  dlg.querySelector('[data-later-close]').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-later-done]').forEach(b => b.addEventListener('click', () => dlg.close()));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // a tap on the dimmed backdrop
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

  // ── Language ─────────────────────────────────────────────────────
  function setLang(l, { remember: keep = true, persist = true } = {}) {
    if (l === lang || !(form.languages || []).includes(l)) return;
    lang = l;
    if (keep) langPref.set(l);
    draw();
    applyWords();
    show(currentId, { focus: false, scroll: false });
    if (!reducedMotion()) [ui.form, ui.stop, ui.done].forEach(el => !el.hidden && el.animate?.([{ opacity: 0.4 }, { opacity: 1 }], { duration: 220, easing: EASE }));
    if (persist) save();
  }
  ui.langSwitch.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) setLang(b.dataset.lang);
  });

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
      cta.dataset.afT = open ? 'heroStart' : 'heroNotify';
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
    if (!token && cfg.open != null) showApp(!!cfg.open || mode != null);
    if (previewing) {
      notice(live ? 'previewLive' : 'preview', 'info');
      document.getElementById('application')?.scrollIntoView({ block: 'start' }); // straight to the form, past the hero
    }
    if (!cfg.turnstileSiteKey || token || previewing) return;
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
      if (fromLink) notice('linkExpired', 'error');
      store.clear();
      return;
    }
    token = candidate;
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
    // How far they got: the draft's record, this device's, the page they were on, what they filled in
    const mine = saved?.token === candidate ? saved.furthest : null;
    const known = [r.maxPage, r.maxPageId, r.max_page_id, mine, r.page, lastAnsweredPage(answers)].filter(id => order(id) >= 0);
    furthestId = known.sort((x, y) => order(y) - order(x))[0] || furthestId;
    const ids = stepIds(answers);
    const at = ids.includes(r.page) ? r.page : ids[0];
    currentId = null;
    show(at, { focus: false, scroll: false });
    remember();
    notice(remindersOff ? 'remindersOff' : 'welcomeBack', 'success');
    if (fromLink) document.getElementById('application')?.scrollIntoView({ block: 'start' });
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
      if (target !== currentId) currentId = null;
      show(target, { focus: false, scroll: false });
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
  matchMedia('(min-width: 1080px)').addEventListener?.('change', () => { paintHeader(); paintMini(); }, { signal });
  ui.mini?.addEventListener('click', () => scrollToForm(true));
  window.addEventListener('scroll', onScroll, { passive: true, signal });

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
          const addr = fieldEl(homeAddressId())?.querySelector('[data-part="line1"]');
          if (!addr) break;
          fieldEl(homeAddressId()).scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
          addr.focus({ preventScroll: true });
          addr.select();
          break;
        }
        default:
      }
      return;
    }
    const option = e.target.closest('.af-suggest [role="option"]');
    if (option) { pickSuggestion(Number(option.dataset.i)); return; }
    const go = e.target.closest('[data-goto]');
    if (go) { jump(go.dataset.goto); return; }
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const pid = edit.dataset.page;
      const fid = edit.dataset.edit || firstQuestion(pid);
      if (edit.dataset.edit) { touched.add(fid); setFieldError(fid, errorFor(fid)); }
      jump(pid, { focusField: fid });
    }
  });
  // A press on a suggestion keeps the cursor in Street address (so the list stays open for the click)
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
    if (tgt.tagName === 'TEXTAREA') grow(tgt);
    liveCheck(el);
    if (tgt.dataset.part === 'line1' && el?.dataset.type === 'address') suggestFor(el, tgt);
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
    else if (e.key === 'Enter') { e.preventDefault(); if (sug.active >= 0) pickSuggestion(sug.active); else closeSuggest(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSuggest(); }
    else if (e.key === 'Tab') closeSuggest();
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

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && token) save(); }, { signal });
  // Map names are spaced for the width they're shown at; a page shown after a hidden one gets its turn too
  let declutterTimer = 0;
  const redeclutter = () => { clearTimeout(declutterTimer); declutterTimer = setTimeout(() => { declutter(ui.pages); declutter(ui.stopMap); }, 120); };
  window.addEventListener('resize', redeclutter, { signal });
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
  show(stepIds()[0], { focus: false, scroll: false });
  if (previewing) {
    applyConfig();
    if (live && window.parent !== window) window.parent.postMessage({ type: 'afe-preview-ready' }, location.origin);
  } else {
    resume().catch(() => {}).finally(() => { if (!token) applyConfig(); });
  }
}
