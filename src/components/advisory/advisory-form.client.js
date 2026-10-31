/**
 * The Advisory Board application's page script (/advisory-board/apply/).
 * Five steps, checked with the same rules the server uses
 * (functions/api/_advisory-form.js), then a review before sending. Answers save
 * on this device as people type, so a closed tab or a lost connection costs
 * nothing; sending clears them. Turnstile shows on the review once the site has
 * it set up.
 *
 * Like the makeover application: an overview on the page (every step, how long
 * it takes, what's done), then the application on its own screen (html.adv-focus)
 * with a bar across the top, a segment per step, a screen of questions at a time
 * (as many as fit), Back and Continue held at the bottom, and Back from the phone
 * or browser going a screen back.
 */
import { ADVISORY_STEPS, ADVISORY_FIELDS, checkAnswers, isShown } from '../../../functions/api/_advisory-form.js';
import { mailFix } from '../apply/mail-fix.js';

const STORE = 'soard-advisory-application';
const FOCUS = 'soard-advisory-focus';
const API = '/api/advisory-apply';
const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3L12.5 5" /></svg>';
const CHEV = '<svg class="adv-review-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>';
// About 20 minutes in all (what the hero says), shared out by what each step asks
const SECONDS = { text: 20, email: 15, tel: 15, url: 20, address: 20, textarea: 120, choice: 10, check: 10 };

function read() {
  try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
}
function write(v) {
  try { if (v) localStorage.setItem(STORE, JSON.stringify(v)); else localStorage.removeItem(STORE); } catch { /* private mode: no saving */ }
}
const session = {
  get() { try { return sessionStorage.getItem(FOCUS) === '1'; } catch { return false; } },
  set(on) { try { if (on) sessionStorage.setItem(FOCUS, '1'); else sessionStorage.removeItem(FOCUS); } catch { /* private mode */ } },
};
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function initAdvisoryForm() {
  const form = document.getElementById('adv-form');
  const root = document.querySelector('[data-adv]');
  if (!form || !root) return;
  const $ = (id) => document.getElementById(id);
  const pages = [...form.querySelectorAll('.adv-page')]; // the five steps, then the review
  const total = ADVISORY_STEPS.length;
  const REVIEW = total;
  const ui = {
    back: $('adv-back'), next: $('adv-next'), saved: $('adv-saved'), sendError: $('adv-send-error'), turnstile: $('adv-turnstile'),
    stage: $('adv-stage'), stepText: $('adv-step-text'), part: $('adv-part'), title: $('adv-title'), live: $('adv-live'),
    top: root.querySelector('[data-adv-top]'), segs: [...root.querySelectorAll('.adv-seg')], exit: $('adv-exit'),
    hub: $('adv-hub'), hubTitle: $('adv-hub-title'), hubLead: $('adv-hub-lead'), go: $('adv-go'), goLabel: $('adv-go-label'),
    startOver: $('adv-start-over'), hubRows: [...root.querySelectorAll('.adv-hub-row')],
    review: $('adv-review'), reviewAll: $('adv-review-all'), done: $('adv-done'),
  };
  const titles = [...ADVISORY_STEPS.map((s) => s.title), 'Review and send'];
  const baseTitle = document.title;

  const stored = read();
  let step = 0;
  let furthest = 0;
  let screenNo = 0;
  let packs = {};
  let focused = false;
  let moving = false;
  let fromReview = false; // came from the review: 'answer' (one, then straight back) or 'step' (a whole step, walked through)
  let calmUntil = 0; // till when a new screen is settling (presses before then don't count)
  let resumeAt = null; // the screen of the step they left, for coming back to it
  let startedAt = stored?.startedAt || Date.now();
  let turnstileKey = null;
  let turnstileToken = null;
  let sending = false;
  let restored = false;

  $('adv-today').textContent = new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

  // ── Answers in and out of the page ──
  const fieldEl = (id) => form.querySelector(`[data-field="${id}"]`);
  function collect() {
    const a = {};
    for (const f of ADVISORY_FIELDS) {
      if (f.type === 'choice') a[f.id] = form.querySelector(`input[name="${f.id}"]:checked`)?.value || '';
      else if (f.type === 'check') a[f.id] = !!form.elements[f.id]?.checked;
      else a[f.id] = form.elements[f.id]?.value ?? '';
    }
    return a;
  }
  function fill(a) {
    for (const f of ADVISORY_FIELDS) {
      const v = a?.[f.id];
      if (v == null) continue;
      if (f.type === 'choice') { const r = form.querySelector(`input[name="${f.id}"][value="${CSS.escape(String(v))}"]`); if (r) r.checked = true; }
      else if (f.type === 'check') { if (form.elements[f.id]) form.elements[f.id].checked = !!v; }
      else if (form.elements[f.id]) form.elements[f.id].value = String(v);
    }
  }
  /** Follow-ups show after the answer that asks for them */
  function follow() {
    const a = collect();
    for (const f of ADVISORY_FIELDS) {
      if (!f.showIf) continue;
      const el = fieldEl(f.id);
      if (el) el.hidden = !isShown(f, a);
    }
  }
  const problemsOn = (i, a = collect()) => (i >= total ? {} : checkAnswers(a, { step: ADVISORY_STEPS[i].id }).problems);
  const stepDone = (i, a) => i < total && i < furthest && !Object.keys(problemsOn(i, a)).length;

  // ── A step a screen at a time ──
  /**
   * Which of a step's questions share a screen: as many as fit between the bar across the top and
   * Back / Continue, measured as drawn now, spread evenly. A follow-up stays with the question it
   * follows, the step's intro with what comes after it; anything taller than the screen gets one to
   * itself (and scrolls). The problem summary is always on the screen.
   */
  // A pair of questions stacked on a phone is two pieces (they can take a screen each)
  const stackedPair = (k) => k.matches('.adv-pair') && k.children.length === 2
    && k.children[1].getBoundingClientRect().top >= k.children[0].getBoundingClientRect().bottom - 1;
  const pieces = (i) => [...(pages[i]?.children || [])].filter((el) => !el.matches('[data-summary]')).flatMap((k) => (stackedPair(k) ? [...k.children] : [k]));
  // Styles still easing to new values, at them now (with reduced motion every change eases for an instant)
  const settle = () => { for (const a of document.getAnimations()) if (a.transitionProperty) a.finish(); };
  const idsOf = (el) => (el.matches('[data-field]') ? [el.dataset.field] : [...el.querySelectorAll('[data-field]')].map((x) => x.dataset.field));
  function room(el) {
    const top = ui.top?.offsetHeight || 0;
    const nav = form.querySelector('.adv-nav')?.offsetHeight || 0;
    const head = el.getBoundingClientRect().top - ui.stage.getBoundingClientRect().top;
    // The summary of problems over the questions ("3 answers need a look") takes its room too
    const summary = el.querySelector('[data-summary]:not([hidden])');
    const lead = summary ? summary.getBoundingClientRect().height + (parseFloat(getComputedStyle(el).rowGap) || 0) : 0;
    return Math.max(120, innerHeight - top - nav - head - lead - (parseFloat(getComputedStyle(ui.stage).paddingBottom) || 0));
  }
  /**
   * Problem notes (and the summary) on the screen: the questions a little closer together (often room
   * enough). Nothing moves to another screen and the count never changes under them; a long one scrolls,
   * with the focus on the first problem
   */
  function refit(problems = null) {
    if (!problems || !focused || step < 0 || step >= total || !packs[step] || moving) return;
    settle();
    if (document.documentElement.scrollHeight > innerHeight) pages[step].setAttribute('data-snug', '');
  }
  function pack(i) {
    const el = pages[i];
    if (!focused || !el || i >= total) return null;
    settle();
    el.querySelectorAll('[data-off]').forEach((k) => k.removeAttribute('data-off'));
    // The questions closer together while problem notes show (kept through a repack while one does)
    if (![...el.querySelectorAll('.adv-error')].some(e => !e.hidden && e.textContent.trim())) el.removeAttribute('data-snug');
    if (el.offsetParent === null) return null;
    const fit = room(el);
    // Measured as answered: a follow-up as if its question had been answered to show it
    const tucked = [...el.querySelectorAll('[data-field][hidden]')].filter((k) => ADVISORY_FIELDS.find((x) => x.id === k.dataset.field)?.showIf);
    tucked.forEach((k) => { k.hidden = false; });
    const kids = pieces(i);
    const h = kids.map((k) => k.getBoundingClientRect().height + (parseFloat(getComputedStyle(k).marginBottom) || 0));
    // The step's pieces are a gap apart (only between two that show)
    const gap = parseFloat(getComputedStyle(el).rowGap) || 0;
    const join = (a, b) => (a && b ? a + gap + b : a + b);
    tucked.forEach((k) => { k.hidden = true; });
    const blocks = [];
    // Questions of one group (the reference's name, how they know you, email, phone) share a screen while they fit one
    const groupOf = (k) => idsOf(k).map((x) => ADVISORY_FIELDS.find((y) => y.id === x)?.group).find(Boolean) || null;
    kids.forEach((k, j) => {
      const f = k.matches('[data-field]') ? ADVISORY_FIELDS.find((x) => x.id === k.dataset.field) : null;
      const g = groupOf(k);
      // A follow-up shows on its question's screen when the two fit one together (its question may sit a
      // piece back, a pair split on a phone: they join); else it's the next screen's
      const lead = f?.showIf ? blocks.findIndex((b) => Object.keys(f.showIf).some((x) => b.ids.has(x))) : -1;
      const together = lead >= 0 && join(blocks.slice(lead).reduce((t, b) => join(t, b.h), 0), h[j]) <= fit;
      if (lead >= 0 && lead < blocks.length - 1 && together) {
        const [first, ...rest] = blocks.splice(lead);
        for (const b of rest) { first.kids.push(...b.kids); first.h = join(first.h, b.h); b.ids.forEach((x) => first.ids.add(x)); }
        first.carry = false;
        blocks.push(first);
      }
      const prev = blocks[blocks.length - 1];
      const follows = prev && (!h[j] || k.matches('.adv-date') || (f?.showIf && together && Object.keys(f.showIf).some((x) => prev.ids.has(x)))
        || (g && prev.group === g && join(prev.h, h[j]) <= fit));
      if (prev && (follows || prev.carry)) {
        prev.kids.push(k); prev.h = join(prev.h, h[j]);
        prev.group = g || prev.group;
        idsOf(k).forEach((x) => prev.ids.add(x));
        prev.carry = prev.carry && !h[j];
        return;
      }
      // The step's intro leads into what follows, when both fit a screen together
      blocks.push({ kids: [k], h: h[j], ids: new Set(idsOf(k)), group: g, carry: k.matches('.adv-intro') && h[j] < fit * 0.5 && join(h[j], h[j + 1] || 0) <= fit });
    });
    let n = 0;
    let acc = -1;
    for (const b of blocks) { if (acc < 0 || join(acc, b.h) > fit) { n++; acc = b.h; } else acc = join(acc, b.h); }
    if (n <= 1) return [kids];
    // The most even split into that many screens (none over the room unless one piece is)
    const B = blocks.length;
    const cost = (x, y) => blocks.slice(x, y).reduce((t, b) => join(t, b.h), 0);
    const best = Array.from({ length: n + 1 }, () => Array(B + 1).fill(Infinity));
    const cut = Array.from({ length: n + 1 }, () => Array(B + 1).fill(0));
    best[0][0] = 0;
    for (let k = 1; k <= n; k++) {
      for (let y = k; y <= B; y++) {
        for (let x = k - 1; x < y; x++) {
          const c = cost(x, y);
          if (c > fit && y - x > 1) continue; // only a piece taller than the room may have a screen over it
          const v = best[k - 1][x] + c * c;
          if (v < best[k][y]) { best[k][y] = v; cut[k][y] = x; }
        }
      }
    }
    if (!Number.isFinite(best[n][B])) return [kids];
    const screens = [];
    for (let k = n, y = B; k > 0; k--) { const x = cut[k][y]; screens.unshift(blocks.slice(x, y).flatMap((b) => b.kids)); y = x; }
    return screens;
  }
  const screensIn = (i) => packs[i]?.length || 1;
  // A screen holding only a follow-up that isn't asked (its answer wasn't the one) is passed by
  const emptyScreen = (i, n) => !!packs[i]?.[n] && packs[i][n].every((k) => k.hidden || !!k.closest('[hidden]'));
  const screenAhead = () => step < total && (packs[step] || []).some((_, n) => n > screenNo && !emptyScreen(step, n));
  const screenBefore = () => { for (let n = screenNo - 1; n >= 0; n--) if (!emptyScreen(step, n)) return n; return -1; };
  function paintScreen() {
    const list = packs[step];
    const all = list ? list.flat() : pieces(step); // the pieces as packed (a pair split on a phone stays split)
    const on = new Set(list ? list[screenNo] || [] : all);
    for (const k of all) k.toggleAttribute('data-off', !on.has(k));
    capBoxes(pages[step]);
    // A pair split across screens: off where neither half is on (an empty box would still take the page's gap)
    for (const b of pages[step]?.children || []) if (!all.includes(b) && all.some((k) => b.contains(k))) b.toggleAttribute('data-off', ![...on].some((k) => b.contains(k)));
  }
  const screenIds = () => new Set((packs[step] ? packs[step][screenNo] || [] : pieces(step)).flatMap(idsOf));
  const screenOf = (i, id) => {
    const el = fieldEl(id);
    const at = el && packs[i] ? packs[i].findIndex((kids) => kids.some((k) => k === el || k.contains(el))) : 0;
    return Math.max(0, at);
  };

  // ── Problems: under each answer, and a summary that links to them ──
  function showProblems(problems, { focus = true } = {}) {
    const page = pages[step];
    const ids = page ? [...page.querySelectorAll('[data-field]')].map((el) => el.dataset.field) : [];
    for (const id of ids) {
      const el = fieldEl(id);
      const msg = problems[id];
      const err = el.querySelector('.adv-error');
      el.classList.toggle('is-invalid', !!msg);
      err.hidden = !msg;
      err.textContent = msg || '';
      for (const input of el.querySelectorAll('input, textarea')) {
        if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      }
    }
    const mine = ids.filter((id) => problems[id]);
    const summary = page.querySelector('[data-summary]');
    if (!summary) return;
    // The summary only when some are out of sight (another screen): beside each question its own note says it
    const elsewhere = mine.some((id) => fieldEl(id)?.closest('[data-off]'));
    if (mine.length < 2 || !elsewhere) { summary.hidden = true; summary.textContent = ''; if (mine.length) refit(mine); if (focus && mine.length) focusField(mine[0]); return; }
    summary.innerHTML = '';
    const head = document.createElement('p');
    head.textContent = `${mine.length} answers need a look:`;
    head.style.margin = '0';
    const list = document.createElement('ul');
    for (const id of mine) {
      const f = ADVISORY_FIELDS.find((x) => x.id === id);
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#adv-${id}`;
      link.textContent = f.label.replace(/\?$/, '');
      link.addEventListener('click', (e) => { e.preventDefault(); focusField(id); });
      li.append(link);
      list.append(li);
    }
    summary.append(head, list);
    summary.hidden = false;
    refit(mine); // the notes and the summary take room: the questions close up a little
    if (focus) focusField(mine[0]);
  }
  function focusField(id) {
    const el = fieldEl(id);
    if (!el) return;
    if (packs[step] && el.closest('[data-off]')) { screenNo = screenOf(step, id); paintScreen(); paint(); }
    const input = el.querySelector('input:not([type="hidden"]), textarea');
    el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    input?.focus({ preventScroll: true });
  }
  /** Once someone fixes an answer, its message goes as they type */
  function recheck(id) {
    const el = fieldEl(id);
    if (!el?.classList.contains('is-invalid') || step >= total) return;
    const msg = problemsOn(step)[id];
    if (msg) return;
    el.classList.remove('is-invalid');
    el.querySelector('.adv-error').hidden = true;
    for (const input of el.querySelectorAll('input, textarea')) input.removeAttribute('aria-invalid');
    if (![...pages[step].querySelectorAll('.adv-field.is-invalid')].length) pages[step].querySelector('[data-summary]').hidden = true;
  }

  // ── What's on screen ──
  const secondsOf = (i) => (ADVISORY_STEPS[i]?.fields || []).filter((f) => !f.showIf).reduce((t, f) => t + (SECONDS[f.type] || 15) * (f.required ? 1 : 0.5), 0);
  const minutesOf = (i) => Math.max(1, Math.round((secondsOf(i) / ADVISORY_STEPS.reduce((t, _, j) => t + secondsOf(j), 0)) * 20));
  /** A done step's answers in a line: "Taylor Brooks · taylor@example.org" */
  function summaryOf(i, a = collect()) {
    const parts = [];
    for (const f of ADVISORY_STEPS[i]?.fields || []) {
      if (!isShown(f, a) || f.type === 'check') continue;
      const v = String(a[f.id] || '').split('\n')[0].trim();
      // A Yes or No says what it's to ("Four meetings a year: Yes"), not "Yes · Yes"
      const said = f.brief ? `${f.brief}: ${v}` : v;
      if (v && parts.length < 2) parts.push(said.length > 40 ? `${said.slice(0, 38).trimEnd()}…` : said);
    }
    return parts.join(' · ');
  }
  function paint({ focusHeading = false } = {}) {
    const a = collect();
    pages.forEach((p, i) => { p.hidden = i !== step; });
    ui.stepText.textContent = `Step ${step + 1} of ${total + 1}`;
    const n = screensIn(step);
    ui.part.textContent = n > 1 ? `Part ${screenNo + 1} of ${n}` : '';
    if (ui.title.textContent !== titles[step]) ui.title.textContent = titles[step];
    ui.segs.forEach((li, i) => {
      const now = i === step;
      const done = !now && (stepDone(i, a) || (i === REVIEW && sent));
      li.dataset.state = done ? 'done' : now ? 'now' : '';
      li.firstChild.style.transform = `scaleX(${(done ? 1 : now ? (screenNo + 1) / (n + 1) : 0).toFixed(3)})`;
    });
    ui.back.hidden = step === 0 && screenNo === 0;
    const last = !screenAhead();
    // Only when the words change: Safari drops a press on Continue whose words are replaced mid-press
    // On a phone "Continue to reference and signature" doesn't fit the button: "Continue" (the step's name is over the questions)
    const narrow = innerWidth <= 640;
    const label = step === REVIEW ? 'Send my application'
      : fromReview === 'answer' || (fromReview && last) ? 'Back to review'
        : !last ? 'Continue'
          : step === total - 1 ? 'Review my answers' : narrow ? 'Continue' : `Continue to ${titles[step + 1].toLowerCase()}`;
    if (ui.next.textContent !== label) ui.next.textContent = label;
    ui.turnstile.hidden = !(turnstileKey && step === REVIEW);
    if (turnstileKey && step === REVIEW) loadTurnstile();
    document.title = focused ? `Step ${step + 1} of ${total + 1}: ${titles[step]} · ${baseTitle}` : baseTitle;
    paintHub(a);
    if (focusHeading) ui.title.focus({ preventScroll: true });
  }
  /** The overview: every step with its minutes, done ones with their answers, the way in */
  function paintHub(a = collect()) {
    if (focused) return;
    const started = restored || furthest > 0;
    const doneCount = ADVISORY_STEPS.filter((_, i) => stepDone(i, a)).length;
    ui.hubTitle.textContent = started ? 'Your application is saved on this device' : 'Six steps, about 20 minutes';
    ui.hubLead.textContent = started
      ? (doneCount === total ? 'Every step is done. Look it over and send it.' : `${doneCount} of ${total} steps done. Pick up where you left off.`)
      : 'Have a reference in mind. Your answers save on this device as you go.';
    ui.goLabel.textContent = !started ? 'Start the application' : doneCount === total ? 'Review and send' : 'Continue where you left off';
    const cta = document.querySelector('[data-adv-cta]'); // the hero's button says the same
    if (cta && cta.textContent !== ui.goLabel.textContent) cta.textContent = ui.goLabel.textContent;
    ui.startOver.hidden = !started;
    ui.hubRows.forEach((b, i) => {
      const done = stepDone(i, a);
      const now = started && i === step;
      const open = i <= furthest;
      b.dataset.state = done ? 'done' : now ? 'now' : open ? 'open' : 'locked';
      b.disabled = !open;
      const mark = b.querySelector('.adv-mark');
      if (done) mark.innerHTML = CHECK; else mark.textContent = String(i + 1);
      b.querySelector('.adv-hub-sub').textContent = done ? summaryOf(i, a) : now ? 'You are here' : '';
      b.querySelector('.adv-hub-meta').textContent = done ? 'Edit' : i < total ? `${minutesOf(i)} min` : '';
    });
  }

  /**
   * The browser hovers nothing while a view transition runs, so Continue or Back just clicked would
   * lose its hover look for the change and get it back after (a blink on every mouse press). It keeps
   * the look (data-held) until the pointer is back over it, moves, or 600ms pass.
   */
  let holdGen = 0;
  function hold() {
    const btns = [...document.querySelectorAll('.adv-nav-row .btn:hover, .adv-nav-row [data-held]')];
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
      if (performance.now() > end || held.btns.every(b => !b.isConnected || b.hidden || b.matches(':hover'))) done();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }
  /**
   * Change what's on screen with the motion of going forward or back (Linear's pace, the makeover
   * application's: the old screen out in 90ms, the new one in over 200ms); a step's name holds
   * still between its own screens. Resolves once the new screen is in the page.
   */
  function swap(update, dir, same) {
    const html = document.documentElement;
    if (!dir || !focused) { update(); return Promise.resolve(); }
    if (reducedMotion() || !document.startViewTransition || document.visibilityState === 'hidden') {
      update();
      if (!reducedMotion()) ui.stage.animate?.([{ opacity: 0, transform: `translateX(${dir * 16}px)` }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.05,.7,.1,1)' });
      return Promise.resolve();
    }
    html.classList.add('adv-vt');
    html.classList.toggle('adv-vt-back', dir < 0);
    html.classList.toggle('adv-vt-same', same);
    moving = true;
    const held = hold();
    let vt;
    try { vt = document.startViewTransition(() => { try { update(); } catch (err) { console.warn('Could not change the screen', err); } }); } catch {
      html.classList.remove('adv-vt', 'adv-vt-back', 'adv-vt-same'); moving = false; update(); letGo(held); return Promise.resolve();
    }
    vt.ready.catch(() => {});
    vt.finished.catch(() => {}).finally(() => { if (!moving) html.classList.remove('adv-vt', 'adv-vt-back', 'adv-vt-same'); letGo(held); });
    return vt.updateCallbackDone.catch(() => {}).finally(() => { moving = false; });
  }
  /** Put a step on screen, a screen of it (a number, 'last', or the one holding `at`) */
  function go(i, { dir = 0, screen = 0, at = null, focus = true } = {}) {
    const changed = i !== step;
    if (dir) calmUntil = performance.now() + 350; // a second press of Continue mid-change (a double tap) counts once
    return swap(() => {
      step = i;
      furthest = Math.max(furthest, i);
      if (i === REVIEW) { fromReview = false; buildReview(); }
      pages.forEach((p, j) => { p.hidden = j !== step; });
      if (i < total && (changed || !packs[i])) { ui.title.textContent = titles[i]; packs[i] = pack(i); }
      const n = screensIn(i);
      screenNo = Math.max(0, Math.min(n - 1, at ? screenOf(i, at) : screen === 'last' ? n - 1 : Number(screen) || 0));
      if (!at && dir > 0) while (screenNo < n - 1 && emptyScreen(i, screenNo)) screenNo++;
      if (!at && (dir < 0 || screen === 'last')) while (screenNo > 0 && emptyScreen(i, screenNo)) screenNo--;
      paintScreen();
      ui.sendError.hidden = true;
      paint();
      if (focused) window.scrollTo({ top: 0, behavior: 'auto' });
    }, dir, !changed).then(() => {
      if (at) focusField(at);
      else if (focus) {
        // On a computer the screen's first box takes the keys straight away (Linear's way), and a screen
        // reader still hears which step this is; on a touch screen the step's name has the focus, so a
        // keyboard doesn't slide up over the questions
        const box = keysFirst() ? firstBox() : null;
        if (box) {
          box.focus({ preventScroll: true });
          if (changed && ui.live) { ui.live.textContent = ''; setTimeout(() => { ui.live.textContent = `Step ${step + 1} of ${total + 1}: ${titles[step]}`; }, 40); }
        } else ui.title.focus({ preventScroll: true });
      }
    });
  }

  // ── On its own screen ──
  // The browser's or phone's Back and Forward go where they were, a screen at a time: every screen they go
  // to (Continue, Edit from the review) is an entry in the history that says which screen it is, and Back
  // or Forward shows that screen. Made by their taps, so a browser never skips them
  let depth = 0; // the entry they're on (0: the page itself)
  let left = null; // after Save and exit: the entry and screen they left from
  const trail = []; // depth → the screen that entry is
  let swallow = false;
  const whereNow = () => ({ step, screen: step >= total ? 0 : screenNo });
  const sameAt = (x, y) => !!x && !!y && x.step === y.step && x.screen === y.screen;
  function pushLoc() {
    if (!focused) return;
    const at = whereNow();
    try {
      history.pushState({ ...(history.state || {}), advFocus: 1, advDepth: depth + 1, advAt: at }, '');
      depth++;
      trail[depth] = at;
      trail.length = depth + 1;
    } catch { /* no history */ }
  }
  function replaceLoc() {
    if (!focused || !depth) return;
    const at = whereNow();
    try { history.replaceState({ ...(history.state || {}), advFocus: 1, advDepth: depth, advAt: at }, ''); trail[depth] = at; } catch { /* no history */ }
  }
  function armTrap() { if (!depth) pushLoc(); }
  function begin(i = null) {
    if (!focused) {
      focused = true;
      root.classList.add('is-focus');
      document.documentElement.classList.add('adv-focus');
      session.set(true);
      if (!depth && history.state?.advFocus) { depth = history.state.advDepth || 1; trail[depth] = history.state.advAt; } // a reload on one of its own entries
      window.scrollTo({ top: 0, behavior: 'auto' });
      if (!reducedMotion()) {
        ui.top?.animate?.([{ transform: 'translateY(-100%)' }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
        ui.stage.animate?.([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.05,.7,.1,1)' });
      }
    }
    packs = {};
    const target = i != null && i <= furthest ? i : step;
    // Coming back to the step they left: the screen they were on
    const screen = resumeAt && resumeAt.step === target ? resumeAt.screen : 0;
    resumeAt = null;
    step = -1; // a step put on screen afresh
    go(target, { screen }).then(() => (depth ? replaceLoc() : pushLoc()));
  }
  function exitFocus({ fromPop = false } = {}) {
    if (!focused) return;
    saveNow();
    if (step >= 0 && step < total) resumeAt = { step, screen: screenNo }; // "Continue where you left off": this screen
    focused = false;
    root.classList.remove('is-focus');
    document.documentElement.classList.remove('adv-focus', 'adv-vt', 'adv-vt-back', 'adv-vt-same');
    session.set(false);
    // Its entries in the history go with it, so the browser's Back leaves from here next (Forward comes back to this screen)
    left = depth > 0 ? { depth, at: whereNow() } : null;
    if (depth > 0) { swallow = true; history.go(-depth); }
    depth = 0;
    restored = restored || furthest > 0;
    paint();
    requestAnimationFrame(() => {
      const app = document.getElementById('application');
      const top = Math.max(0, (app?.getBoundingClientRect().top || 0) + window.scrollY - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 84) - 16);
      window.scrollTo({ top, behavior: 'auto' });
      (sent ? ui.done : ui.hubTitle).focus({ preventScroll: true });
    });
  }
  const keysFirst = () => matchMedia('(pointer: fine)').matches && !matchMedia('(any-pointer: coarse)').matches;
  /** The screen's first question when it's a box to type in, still empty */
  function firstBox() {
    if (step >= total) return null;
    const seen = (el) => el.getClientRects().length && !el.closest('[data-off], [hidden]');
    const field = [...(pages[step]?.querySelectorAll('[data-field]') || [])].find(seen);
    const box = field?.querySelector('input:is([type=text], [type=email], [type=tel], [type=url], [type=number], :not([type])), textarea');
    return box && seen(box) && !box.value && !box.disabled ? box : null;
  }
  // Escape: a screen back (Linear's way), never from a box they're typing in (the address list closes first, on its own)
  const keys = new AbortController();
  document.addEventListener('astro:before-swap', () => keys.abort(), { once: true });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || !focused || step < 0 || document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t?.matches?.('input:not([type=radio]):not([type=checkbox]), textarea, select')) return; // a box being typed in keeps its Escape
    if (back()) e.preventDefault();
  }, { signal: keys.signal });
  /** A screen back; false at the very start */
  function back() {
    if (moving || performance.now() < calmUntil) return true;
    const before = step < total ? screenBefore() : -1;
    // With an entry behind this one, Back is the browser's Back: the screen they came from, and its Forward
    // comes back here. Without one (the first entry), the screen before, which this entry then is
    if (depth > 1) { history.back(); return true; }
    if (before < 0 && step === 0) return false;
    (before >= 0 ? go(step, { dir: -1, screen: before }) : go(step - 1, { dir: -1, screen: 'last' })).then(() => { replaceLoc(); save(); });
    return true;
  }
  // The page's inline gate asks this first, ahead of the site's router (true = handled here)
  window.__advPop = (e) => {
    if (swallow) { swallow = false; return true; }
    const st = e?.state ?? history.state;
    if (!focused) {
      // Forward onto one of its entries after Save and exit: the application opens again, on that screen
      if (!st?.advFocus || sent) return false;
      const to = st.advDepth || 1;
      // The screen they left, its entry further on: the browser goes there too, so Back and Forward still line up
      const at = left && left.depth > to ? left.at : st.advAt;
      if (left && left.depth > to) { swallow = true; history.go(left.depth - to); depth = left.depth; } else depth = to;
      left = null;
      if (at) { trail[depth] = at; resumeAt = at.step < total ? at : null; }
      begin(at?.step ?? null);
      return true;
    }
    const to = st?.advFocus ? (st.advDepth || 1) : 0;
    const dir = to > depth ? 1 : -1;
    depth = to;
    if (st?.advAt) trail[to] = st.advAt;
    if (!to || sent) { exitFocus({ fromPop: true }); return true; } // back to the page itself
    const at = st.advAt;
    if (at && !sameAt(at, whereNow())) go(at.step, { dir, screen: at.screen });
    else if (!at && dir < 0) back(); // an entry from before they said where they were: a screen back
    return true;
  };
  document.addEventListener('astro:before-swap', () => { window.__advPop = null; document.documentElement.classList.remove('adv-focus', 'adv-vt', 'adv-vt-back', 'adv-vt-same'); }, { once: true });
  const rearm = () => { if (focused && !depth) armTrap(); };
  document.addEventListener('pointerdown', rearm, { capture: true });
  document.addEventListener('keydown', rearm, { capture: true });

  // ── Review: a row per step with its answers in a line, opened to every answer ──
  let reviewAll = false;
  const opened = new Set();
  function setOpen(sec, open) {
    sec.toggleAttribute('data-open', open);
    sec.querySelector('.adv-review-toggle').setAttribute('aria-expanded', String(open));
    sec.querySelector('.adv-review-body').hidden = !open;
    if (open) opened.add(sec.dataset.step); else opened.delete(sec.dataset.step);
  }
  function buildReview() {
    const a = collect();
    const all = checkAnswers(a).problems;
    const secs = ADVISORY_STEPS.map((s, i) => {
      const sec = document.createElement('section');
      sec.className = 'adv-review-section';
      sec.dataset.step = String(i);
      const missing = s.fields.some((f) => all[f.id]);
      if (missing) sec.dataset.missing = '1';
      sec.innerHTML = `<div class="adv-review-head"><h3 class="adv-review-h"><button type="button" class="adv-review-toggle" aria-controls="adv-rv-${s.id}"><span class="adv-mark" aria-hidden="true">${missing ? '!' : CHECK}</span><span class="adv-review-name"><span class="adv-review-title"></span><span class="adv-review-sum"></span></span>${CHEV}</button></h3><button type="button" class="adv-linkbtn adv-review-edit" data-edit="${i}">Edit</button></div><div class="adv-review-body" id="adv-rv-${s.id}"><dl></dl></div>`;
      sec.querySelector('.adv-review-title').textContent = s.title;
      sec.querySelector('.adv-review-sum').textContent = missing ? 'Needs an answer' : summaryOf(i, a);
      sec.querySelector('.adv-review-edit').setAttribute('aria-label', `Edit ${s.title}`);
      const dl = sec.querySelector('dl');
      for (const f of s.fields) {
        if (!isShown(f, a)) continue;
        const v = f.type === 'check' ? (a[f.id] ? 'Yes, I’ve read it' : '') : String(a[f.id] || '').trim();
        if (!v && !all[f.id]) continue;
        const row = document.createElement('div');
        row.className = `adv-review-item${all[f.id] ? ' is-missing' : ''}`;
        const dt = document.createElement('dt');
        dt.textContent = f.label;
        const dd = document.createElement('dd');
        dd.textContent = all[f.id] ? all[f.id] : v;
        const change = document.createElement('button');
        change.type = 'button';
        change.className = 'adv-linkbtn';
        change.dataset.edit = String(i);
        change.dataset.answer = f.id;
        change.textContent = all[f.id] ? 'Answer it' : 'Change';
        change.setAttribute('aria-label', `${change.textContent}: ${f.label}`);
        row.append(dt, dd, change);
        dl.append(row);
      }
      setOpen(sec, missing || reviewAll || opened.has(String(i)));
      return sec;
    });
    // An email they gave that's likely a typo (they're written to there): asked about, the fix a tap away
    const typos = ADVISORY_FIELDS.filter((f) => f.type === 'email' && isShown(f, a) && mailFix(a[f.id])).map((f) => {
      const p = document.createElement('p');
      p.className = 'adv-mailfix adv-review-mail';
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.reviewFix = f.id;
      b.dataset.fix = mailFix(a[f.id]);
      b.textContent = b.dataset.fix;
      b.setAttribute('aria-label', `Use ${b.dataset.fix}`);
      p.append(`We’ll write to ${a[f.id]}. Did you mean `, b, '?');
      return p;
    });
    ui.review.replaceChildren(...typos, ...secs);
    ui.reviewAll.textContent = reviewAll ? 'Hide the answers' : 'Show all answers';
    ui.reviewAll.setAttribute('aria-expanded', String(reviewAll));
  }
  ui.review.addEventListener('click', (e) => {
    // "Did you mean …@gmail.com?": the answer is changed to it, there and then
    const fix = e.target.closest('[data-review-fix]');
    const box = fix && form.elements[fix.dataset.reviewFix];
    if (box) {
      box.value = fix.dataset.fix;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      buildReview();
      return;
    }
    const tg = e.target.closest('.adv-review-toggle');
    if (tg) { const sec = tg.closest('.adv-review-section'); setOpen(sec, !sec.hasAttribute('data-open')); return; }
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const id = edit.dataset.answer || null;
      fromReview = id ? 'answer' : 'step';
      go(Number(edit.dataset.edit), { dir: -1, at: id || null }).then(pushLoc); // Back returns to the review
    }
  });
  ui.reviewAll.addEventListener('click', () => {
    reviewAll = !reviewAll;
    ui.review.querySelectorAll('.adv-review-section').forEach((sec) => setOpen(sec, reviewAll || sec.hasAttribute('data-missing')));
    ui.reviewAll.textContent = reviewAll ? 'Hide the answers' : 'Show all answers';
    ui.reviewAll.setAttribute('aria-expanded', String(reviewAll));
  });

  // ── Saving on this device ──
  let saveTimer = null;
  let sent = false;
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (sent) return;
    write({ answers: collect(), step: Math.min(step, REVIEW), screen: screenNo, furthest, startedAt, savedAt: Date.now() });
    ui.saved.textContent = 'Saved on this device';
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }
  // Leaving mid-sentence (a closed tab, a phone locking) keeps the last keystrokes too
  window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) saveNow(); });

  /** A box for words grows as they write until the screen is full; a longer answer then scrolls inside it, never the screen */
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

  form.addEventListener('input', (e) => {
    const id = e.target.closest('[data-field]')?.dataset.field;
    if (e.target.tagName === 'TEXTAREA') capBoxes(pages[step]);
    if (e.target === sugInput && e.isTrusted) { clearTimeout(sug.timer); sug.timer = setTimeout(suggest, 250); }
    follow();
    if (id) recheck(id);
    save();
  });
  // A likely typo in an email ("name@gmial.com"): "Did you mean name@gmail.com?" under the box, the fix a tap away
  for (const input of form.querySelectorAll('input[type=email]')) {
    const p = document.createElement('p');
    p.className = 'adv-mailfix';
    p.setAttribute('aria-live', 'polite');
    p.hidden = true;
    input.after(p);
  }
  function paintMailFix(input) {
    const p = input.parentElement.querySelector('.adv-mailfix');
    const fix = p && mailFix(input.value);
    if (!p) return;
    p.hidden = !fix;
    p.replaceChildren();
    if (!fix) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mailfixUse = fix;
    b.textContent = fix;
    b.setAttribute('aria-label', `Use ${fix}`);
    p.append('Did you mean ', b, '?');
  }
  form.addEventListener('click', (e) => {
    const use = e.target.closest('[data-mailfix-use]');
    const input = use?.closest('[data-field]')?.querySelector('input[type=email]');
    if (!input) return;
    input.value = use.dataset.mailfixUse;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
  });
  form.addEventListener('input', (e) => { if (e.target.type === 'email') { const p = e.target.parentElement.querySelector('.adv-mailfix'); if (p && !p.hidden) p.hidden = true; } });
  form.addEventListener('change', (e) => {
    const id = e.target.closest('[data-field]')?.dataset.field;
    if (e.target.type === 'email') paintMailFix(e.target);
    follow();
    if (id) recheck(id);
    if (focused && step < total) paint(); // a follow-up asked (or not) on the next screen: Continue says where it goes
    save();
  });
  // ── The home address: suggestions as it's typed (the application's: Google's when SOARD has a key, else
  // OpenStreetMap's, Georgia's only). Picking one puts the whole address in the line; any words typed still count
  const sug = { timer: 0, ctrl: null, items: [], active: -1, closing: 0 };
  const sugInput = form.querySelector('input[role="combobox"]');
  const sugList = sugInput && document.getElementById(sugInput.getAttribute('aria-controls'));
  const oneLine = (a) => [[a.line1, a.line2].filter(Boolean).join(', '), a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  function closeSuggest() {
    if (!sugList) return;
    sugList.hidden = true;
    sugList.replaceChildren();
    sugInput.setAttribute('aria-expanded', 'false');
    sugInput.removeAttribute('aria-activedescendant');
    Object.assign(sug, { items: [], active: -1 });
  }
  /** Under the box, or over it when there's more room there (a phone's keyboard below): never past what can be seen */
  function placeSuggest() {
    if (!sugList || sugList.hidden) return;
    sugList.classList.remove('is-up');
    sugList.style.maxHeight = '';
    const vv = window.visualViewport;
    const seenTop = Math.max(vv ? vv.offsetTop : 0, ui.top?.getBoundingClientRect().bottom || 0);
    const seenBottom = Math.min(vv ? vv.offsetTop + vv.height : innerHeight, form.querySelector('.adv-nav')?.getBoundingClientRect().top ?? Infinity);
    const r = sugInput.getBoundingClientRect();
    const below = seenBottom - r.bottom - 10;
    const above = r.top - seenTop - 10;
    if (sugList.scrollHeight > below && above > below) {
      sugList.classList.add('is-up');
      sugList.style.maxHeight = `${Math.max(140, Math.floor(above))}px`;
    } else sugList.style.maxHeight = `${Math.max(140, Math.floor(below))}px`;
  }
  async function suggest() {
    const q = sugInput.value.trim();
    if (q.length < 4 || !/\d/.test(q)) { closeSuggest(); return; }
    sug.ctrl?.abort();
    const ctrl = new AbortController();
    sug.ctrl = ctrl;
    let data = null;
    try { data = await (await fetch(`/api/apply?address=${encodeURIComponent(q)}`, { signal: ctrl.signal })).json(); } catch { return; }
    if (ctrl.signal.aborted || sugInput.value.trim() !== q || document.activeElement !== sugInput) return;
    const items = (Array.isArray(data?.results) ? data.results : []).filter((i) => i?.line1).slice(0, 5);
    if (!items.length) { closeSuggest(); return; }
    Object.assign(sug, { items, active: -1 });
    sugList.toggleAttribute('data-google', data.source === 'google');
    sugList.replaceChildren(...items.map((it, i) => {
      const li = document.createElement('li');
      li.id = `${sugList.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.i = String(i);
      const main = document.createElement('span');
      main.className = 'adv-suggest-main';
      main.textContent = it.line1;
      const sub = document.createElement('span');
      sub.className = 'adv-suggest-sub';
      sub.textContent = it.sub || [it.city, [it.state, it.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      li.append(main, sub);
      return li;
    }));
    sugList.hidden = false;
    sugInput.setAttribute('aria-expanded', 'true');
    sugInput.removeAttribute('aria-activedescendant');
    placeSuggest();
  }
  function moveActive(d) {
    const n = sug.items.length;
    if (!n) return;
    sug.active = sug.active < 0 ? (d > 0 ? 0 : n - 1) : (sug.active + d + n) % n;
    [...sugList.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sug.active)));
    sugInput.setAttribute('aria-activedescendant', sugList.children[sug.active].id);
    sugList.children[sug.active].scrollIntoView({ block: 'nearest' });
  }
  /** The whole address in the line: a Google pick's street and town at once, its ZIP a moment later */
  async function pickSuggestion(i) {
    const it = sug.items[i];
    if (!it) return;
    closeSuggest();
    sugInput.focus({ preventScroll: true });
    const put = (v) => { sugInput.value = v; sugInput.dispatchEvent(new Event('input', { bubbles: true })); };
    if (!it.id) { put(oneLine(it)); return; }
    put([it.line1, it.sub].filter(Boolean).join(', '));
    try {
      const r = await (await fetch(`/api/apply?place=${encodeURIComponent(it.id)}`)).json();
      if (r?.address && sugInput.value.startsWith(it.line1)) put(oneLine(r.address)); // unless they've typed on since
    } catch { /* the street and town stay */ }
  }
  if (sugInput && sugList) {
    form.addEventListener('keydown', (e) => {
      if (e.target !== sugInput || sugList.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveActive(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (sug.active >= 0) pickSuggestion(sug.active); else closeSuggest(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSuggest(); }
      else if (e.key === 'Tab') closeSuggest();
    }, true); // before Enter's "next box" (and the form's own Enter, Continue)
    sugList.addEventListener('mousedown', (e) => e.preventDefault()); // the cursor stays in the box for the click
    sugList.addEventListener('click', (e) => { const li = e.target.closest('[role="option"]'); if (li) pickSuggestion(Number(li.dataset.i)); });
    sugInput.addEventListener('blur', () => { clearTimeout(sug.closing); sug.closing = setTimeout(() => { if (document.activeElement !== sugInput) closeSuggest(); }, 180); });
    window.visualViewport?.addEventListener('resize', placeSuggest);
    window.addEventListener('resize', placeSuggest);
  }

  // A real change of window size (a phone turned, a window resized; not a phone's address bar sliding):
  // the step's screens worked out again, keeping their place, and Continue's words for the width
  let resizeTimer = 0;
  let packedSize = `${innerWidth}x${innerHeight}`;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      paint();
      const [w0, h0] = packedSize.split('x').map(Number);
      if (Math.abs(innerWidth - w0) < 40 && Math.abs(innerHeight - h0) < 120) return;
      packedSize = `${innerWidth}x${innerHeight}`;
      if (!focused || step < 0 || step >= total || !packs[step]) return;
      const was = packs[step][screenNo]?.[0] || null;
      packs[step] = pack(step);
      screenNo = Math.max(0, was ? packs[step].findIndex((kids) => kids.some((k) => k === was || k.contains(was) || was.contains(k))) : 0);
      paintScreen();
      paint();
    }, 180);
  }, { passive: true });

  // Enter (the keyboard's "next") goes to the next box on the screen; on the last one it's Continue
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.shiftKey || !(e.target instanceof HTMLInputElement) || ['radio', 'checkbox', 'submit', 'button'].includes(e.target.type)) return;
    const boxes = [...pages[step].querySelectorAll('input:not([type=hidden]), textarea')].filter((x) => x.getClientRects().length && !x.closest('[hidden], [data-off]'))
      .filter((x, k, all) => x.type !== 'radio' || all.findIndex((y) => y.type === 'radio' && y.name === x.name) === k);
    const after = boxes[boxes.indexOf(e.target) + 1];
    if (after) { e.preventDefault(); after.focus(); }
  });

  ui.back.addEventListener('click', () => { back(); });
  ui.go.addEventListener('click', () => begin());
  document.querySelector('[data-adv-cta]')?.addEventListener('click', (e) => { e.preventDefault(); begin(); });
  ui.hubRows.forEach((b) => b.addEventListener('click', () => { if (!b.disabled) begin(Number(b.dataset.goto)); }));
  ui.exit.addEventListener('click', () => exitFocus());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending || moving || performance.now() < calmUntil) return;
    ui.sendError.hidden = true;
    if (step === REVIEW) { await send(); return; }
    const here = screenIds();
    const problems = Object.fromEntries(Object.entries(problemsOn(step)).filter(([id]) => here.has(id)));
    if (Object.keys(problems).length) { showProblems(problems); return; }
    showProblems({}, { focus: false });
    const lastHere = !screenAhead();
    if (fromReview === 'answer' || (fromReview && lastHere)) await go(REVIEW, { dir: 1 });
    else if (!lastHere) await go(step, { dir: 1, screen: screenNo + 1 });
    else await go(step + 1, { dir: 1 });
    pushLoc(); // the browser's Back comes back to the screen they've just left
    save();
  });

  async function send() {
    const all = checkAnswers(collect());
    // Anything left on an earlier step: go there
    const firstBad = ADVISORY_STEPS.findIndex((s) => s.fields.some((f) => all.problems[f.id]));
    if (firstBad !== -1) {
      const id = ADVISORY_STEPS[firstBad].fields.find((f) => all.problems[f.id]).id;
      fromReview = 'answer';
      await go(firstBad, { dir: -1, at: id });
      showProblems(all.problems);
      return;
    }
    if (turnstileKey && !turnstileToken) { ui.sendError.textContent = 'Please confirm you’re not a robot, just above.'; ui.sendError.hidden = false; return; }
    sending = true;
    ui.next.disabled = true;
    ui.back.disabled = true;
    ui.next.textContent = 'Sending…';
    try {
      // No connection: said in words, not the browser's ("Failed to fetch", "Load failed")
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: all.answers, website: form.elements.website?.value || '', turnstileToken, startedAt }),
      }).catch(() => { throw new Error('That didn’t send: you seem to be offline. Your answers are still here; please try again once you’re connected.'); });
      const d = await res.json().catch(() => ({}));
      if (res.status === 422 && d.problems) {
        const at = ADVISORY_STEPS.findIndex((s) => s.fields.some((f) => d.problems[f.id]));
        if (at !== -1) { fromReview = 'answer'; await go(at, { dir: -1 }); showProblems(d.problems); }
        throw new Error(d.error || 'A few answers need a look.');
      }
      if (!res.ok || !d.ok) {
        if (d.code === 'turnstile') resetTurnstile();
        throw new Error(d.error || 'That didn’t send. Please try again in a moment.');
      }
      sent = true;
      clearTimeout(saveTimer);
      write(null);
      ui.saved.textContent = '';
      session.set(false);
      form.hidden = true;
      $('adv-done-name').textContent = d.first ? `, ${d.first}` : '';
      ui.exit.querySelector('span').textContent = 'Close';
      ui.done.hidden = false;
      ui.hub.hidden = true;
      paint();
      window.scrollTo({ top: 0, behavior: 'auto' });
      ui.done.focus({ preventScroll: true });
    } catch (err) {
      ui.sendError.textContent = err.message || 'That didn’t send. Your answers are still here; please try again.';
      ui.sendError.hidden = false;
      ui.next.disabled = false;
      ui.back.disabled = false;
      paint();
      if (!form.hidden && !document.activeElement?.closest?.('.adv-page:not([hidden])')) ui.next.focus({ preventScroll: true }); // Send again, where they were (the note is read out)
    } finally {
      sending = false;
    }
  }

  // ── Turnstile (once the site has it set up) ──
  let turnstileLoading = false;
  function loadTurnstile() {
    if (turnstileLoading || !turnstileKey) return;
    turnstileLoading = true;
    window.onAdvisoryTurnstile = () => {
      window.turnstile.render(ui.turnstile.querySelector('.cf-turnstile'), {
        sitekey: turnstileKey,
        callback: (t) => { turnstileToken = t; if (/robot/.test(ui.sendError.textContent)) ui.sendError.hidden = true; },
        'expired-callback': () => { turnstileToken = null; },
      });
    };
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onAdvisoryTurnstile&render=explicit';
    s.async = true;
    document.head.append(s);
  }
  function resetTurnstile() {
    turnstileToken = null;
    try { window.turnstile?.reset(ui.turnstile.querySelector('.cf-turnstile')); } catch { /* not loaded */ }
  }
  fetch(API, { cache: 'no-store' }).then((r) => r.json()).then((d) => { turnstileKey = d?.turnstileSiteKey || null; paint(); }).catch(() => {});

  // ── Picking up where they left off ──
  if (stored?.answers && Object.values(stored.answers).some((v) => v && v !== '')) {
    fill(stored.answers);
    step = Math.min(Math.max(0, Number(stored.step) || 0), REVIEW);
    furthest = Math.min(Math.max(step, Number(stored.furthest) || 0), REVIEW);
    resumeAt = { step, screen: Math.max(0, Number(stored.screen) || 0) };
    restored = true;
  }
  let startOverArmed = 0;
  ui.startOver.addEventListener('click', () => {
    // Deleting every answer takes a second tap (it sits by "Continue where you left off": one slip shouldn't do it)
    if (Date.now() > startOverArmed) {
      startOverArmed = Date.now() + 5000;
      ui.startOver.textContent = 'Tap again to delete your answers';
      setTimeout(() => { if (Date.now() > startOverArmed) ui.startOver.textContent = 'Start over'; }, 5100);
      return;
    }
    startOverArmed = 0;
    ui.startOver.textContent = 'Start over';
    write(null);
    form.reset();
    step = 0;
    furthest = 0;
    screenNo = 0;
    restored = false;
    startedAt = Date.now();
    for (const el of form.querySelectorAll('.adv-field.is-invalid')) el.classList.remove('is-invalid');
    for (const el of form.querySelectorAll('.adv-error, [data-summary]')) el.hidden = true;
    ui.saved.textContent = '';
    follow();
    paint();
    ui.hubTitle.focus({ preventScroll: true });
  });
  follow();
  paint();
  // A reload mid-application goes straight back to it; a tap on Start made while this script was loading
  // (the page's inline catcher kept it) goes ahead now
  root.dataset.ready = 'go';
  for (const b of document.querySelectorAll('#adv-go, [data-adv-cta]')) b.removeAttribute('aria-busy');
  const early = window.__advWant;
  window.__advWant = false;
  if (restored && session.get()) begin(step);
  else if (early) begin();
}
