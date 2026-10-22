/**
 * The Advisory Board application's page script (/advisory-board/apply/).
 * Five steps, checked with the same rules the server uses
 * (functions/api/_advisory-form.js). Answers save on this device as people
 * type, so a closed tab or a lost connection costs nothing; sending clears
 * them. Turnstile shows on the last step once the site has it set up.
 */
import { ADVISORY_STEPS, ADVISORY_FIELDS, checkAnswers, isShown } from '../../../functions/api/_advisory-form.js';

const STORE = 'soard-advisory-application';
const API = '/api/advisory-apply';

function read() {
  try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
}
function write(v) {
  try { if (v) localStorage.setItem(STORE, JSON.stringify(v)); else localStorage.removeItem(STORE); } catch { /* private mode: no saving */ }
}

export function initAdvisoryForm() {
  const form = document.getElementById('adv-form');
  if (!form) return;
  const $ = (id) => document.getElementById(id);
  const pages = [...form.querySelectorAll('.adv-page')];
  const dots = [...form.querySelectorAll('[data-step-dot]')];
  const back = $('adv-back');
  const next = $('adv-next');
  const saved = $('adv-saved');
  const sendError = $('adv-send-error');
  const turnstileBox = $('adv-turnstile');
  const total = pages.length;

  const stored = read();
  let step = 0;
  let startedAt = stored?.startedAt || Date.now();
  let turnstileKey = null;
  let turnstileToken = null;
  let sending = false;

  const today = new Date();
  $('adv-today').textContent = today.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

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
    if (!mine.length) { summary.hidden = true; summary.textContent = ''; return; }
    summary.innerHTML = '';
    const head = document.createElement('p');
    head.textContent = mine.length === 1 ? 'One answer needs a look:' : `${mine.length} answers need a look:`;
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
    if (focus) focusField(mine[0]);
  }
  function focusField(id) {
    const el = fieldEl(id);
    const input = el?.querySelector('input:not([type="hidden"]), textarea');
    el?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    input?.focus({ preventScroll: true });
  }
  /** Once someone fixes an answer, its message goes as they type */
  function recheck(id) {
    const el = fieldEl(id);
    if (!el?.classList.contains('is-invalid')) return;
    const { problems } = checkAnswers(collect(), { step: ADVISORY_STEPS[step].id });
    const msg = problems[id];
    if (!msg) {
      el.classList.remove('is-invalid');
      el.querySelector('.adv-error').hidden = true;
      for (const input of el.querySelectorAll('input, textarea')) input.removeAttribute('aria-invalid');
      const left = [...pages[step].querySelectorAll('.adv-field.is-invalid')].length;
      if (!left) pages[step].querySelector('[data-summary]').hidden = true;
    }
  }

  // ── Steps ──
  function paint({ focusHeading = false } = {}) {
    pages.forEach((p, i) => { p.hidden = i !== step; });
    dots.forEach((d, i) => { d.classList.toggle('is-done', i < step); d.classList.toggle('is-now', i === step); });
    $('adv-bar-fill').style.width = `${((step + 1) / total) * 100}%`;
    back.hidden = step === 0;
    next.textContent = step === total - 1 ? 'Send my application' : `Continue to ${ADVISORY_STEPS[step + 1].title.toLowerCase()}`;
    turnstileBox.hidden = !(turnstileKey && step === total - 1);
    if (turnstileKey && step === total - 1) loadTurnstile();
    follow();
    if (focusHeading) {
      const h = pages[step].querySelector('h2');
      document.getElementById('application')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      h?.focus({ preventScroll: true });
    }
  }

  let saveTimer = null;
  let sent = false;
  const saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (sent) return;
    write({ answers: collect(), step, startedAt, savedAt: Date.now() });
    saved.textContent = 'Saved on this device';
  };
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }
  // Leaving mid-sentence (a closed tab, a phone locking) keeps the last keystrokes too
  window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) saveNow(); });

  form.addEventListener('input', (e) => {
    const id = e.target.closest('[data-field]')?.dataset.field;
    follow();
    if (id) recheck(id);
    save();
  });
  form.addEventListener('change', (e) => {
    const id = e.target.closest('[data-field]')?.dataset.field;
    follow();
    if (id) recheck(id);
    save();
  });

  back.addEventListener('click', () => {
    if (step === 0) return;
    step -= 1;
    sendError.hidden = true;
    paint({ focusHeading: true });
    save();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;
    sendError.hidden = true;
    const { problems } = checkAnswers(collect(), { step: ADVISORY_STEPS[step].id });
    if (Object.keys(problems).length) { showProblems(problems); return; }
    showProblems({}, { focus: false });
    if (step < total - 1) {
      step += 1;
      paint({ focusHeading: true });
      save();
      return;
    }
    await send();
  });

  async function send() {
    const all = checkAnswers(collect());
    // Anything left on an earlier step (it shouldn't be): go there
    const firstBad = ADVISORY_STEPS.findIndex((s) => s.fields.some((f) => all.problems[f.id]));
    if (firstBad !== -1) { step = firstBad; paint({ focusHeading: true }); showProblems(all.problems); return; }
    if (turnstileKey && !turnstileToken) { sendError.textContent = 'Please confirm you’re not a robot, just above.'; sendError.hidden = false; return; }
    sending = true;
    next.disabled = true;
    back.disabled = true;
    next.textContent = 'Sending…';
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: all.answers, website: form.elements.website?.value || '', turnstileToken, startedAt }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 422 && d.problems) {
        const at = ADVISORY_STEPS.findIndex((s) => s.fields.some((f) => d.problems[f.id]));
        if (at !== -1) { step = at; paint({ focusHeading: true }); showProblems(d.problems); }
        throw new Error(d.error || 'A few answers need a look.');
      }
      if (!res.ok || !d.ok) {
        if (d.code === 'turnstile') resetTurnstile();
        throw new Error(d.error || 'That didn’t send. Please try again in a moment.');
      }
      sent = true;
      clearTimeout(saveTimer);
      write(null);
      form.hidden = true;
      $('adv-restored').hidden = true;
      $('adv-done-name').textContent = d.first ? `, ${d.first}` : '';
      const done = $('adv-done');
      done.hidden = false;
      document.getElementById('application')?.scrollIntoView({ block: 'start' });
      done.focus({ preventScroll: true });
    } catch (err) {
      sendError.textContent = err.message || 'That didn’t send. Your answers are still here; please try again.';
      sendError.hidden = false;
      next.disabled = false;
      back.disabled = false;
      paint();
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
      window.turnstile.render(turnstileBox.querySelector('.cf-turnstile'), {
        sitekey: turnstileKey,
        callback: (t) => { turnstileToken = t; if (/robot/.test(sendError.textContent)) sendError.hidden = true; },
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
    try { window.turnstile?.reset(turnstileBox.querySelector('.cf-turnstile')); } catch { /* not loaded */ }
  }
  fetch(API, { cache: 'no-store' }).then((r) => r.json()).then((d) => { turnstileKey = d?.turnstileSiteKey || null; paint(); }).catch(() => {});

  // ── Picking up where they left off ──
  if (stored?.answers && Object.values(stored.answers).some((v) => v && v !== '')) {
    fill(stored.answers);
    step = Math.min(Math.max(0, Number(stored.step) || 0), total - 1);
    $('adv-restored').hidden = false;
  }
  $('adv-start-over').addEventListener('click', () => {
    write(null);
    form.reset();
    step = 0;
    startedAt = Date.now();
    $('adv-restored').hidden = true;
    for (const el of form.querySelectorAll('.adv-field.is-invalid')) el.classList.remove('is-invalid');
    for (const el of form.querySelectorAll('.adv-error, [data-summary]')) el.hidden = true;
    saved.textContent = '';
    paint({ focusHeading: true });
  });
  paint();
}
