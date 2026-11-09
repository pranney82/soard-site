/**
 * remind-signup.ts — a reveal reminder email form, wired up
 * =========================================================
 * Every email sign-up for reveal reminders runs through here: the /live/
 * pages' reminder block (one reveal, or every reveal) and the "Get every
 * reveal by email" card in the Coming up band (/live/ and the events page).
 * Nobody is on the list until the address proves it's theirs: /api/reminders
 * emails a link to confirm.
 *
 * The button is never `disabled` (that drops keyboard focus to the page):
 * while it sends or once it's done it's aria-disabled, shows a spinner or
 * "Sent", and presses do nothing. News goes to the form's status line.
 *
 * The quick check (Turnstile) runs while the server asks for one. The page's
 * CSP doesn't load Turnstile, so it runs in a frame /api/reminders serves
 * with its own policy, and posts its token up to this page. Each form has its
 * own frame, out of sight unless Cloudflare wants a click. The frame says
 * "ready" as soon as it loads; one that never does (its page failed, or was
 * blocked) is given up on, and the next press builds a fresh one.
 *
 * The form needs: input[name="email"], input[name="website"] (the honeypot),
 * a submit button with .btn-text / .btn-busy / .btn-done, and a .remind-note.
 */
import { mailFix } from '../components/apply/mail-fix.js';
import { isEmail } from './email-rule.js';

interface Options {
  /** Where the quick check's frame goes (a box after the form) */
  checkBox: HTMLElement | null;
  /** The reveal this sign-up is for: a kid's slug, or '' for every reveal */
  kid: () => string;
  /** Where the sign-up came from (Reveals → History) */
  source: () => string;
  /** The quick check to match the form's background */
  theme?: 'light' | 'dark';
}

// Whether the server wants the check: asked once per page, shared by every form on it. An answer that doesn't come
// (an error, or nothing in 8s) counts as "no", and is asked again next time; the server's own "check first" overrules it.
let checkOn: Promise<boolean> | null = null;
// (Browsers before 2022 have no AbortSignal.timeout: they simply wait)
const within = (ms: number) => (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined);
const checkNeeded = () => (checkOn ||= fetch('/api/reminders?config=1', { cache: 'no-store', signal: within(8000) })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((d) => !!d.turnstile)
  .catch(() => { checkOn = null; return false; }));
// A sign-up that hears nothing back in this long says so, rather than spinning for ever
const SEND_TIMEOUT_MS = 20000;

const errorText = (data: Record<string, any>, status: number) => data.error || (status === 429 ? 'Too many tries. Give it a minute.' : 'Something went wrong. Please try again.');
// A second press this soon after "Did you mean…?" is the same press (a double-click, a held Enter), not "send it as typed"
const SAME_PRESS_MS = 1000;
// The check's frame says "ready" when it loads: silence this long after its load event (or this long overall) means it didn't
const FRAME_QUIET_MS = 4000;
const FRAME_LOAD_MS = 15000;
const BLOCKED = "The quick check couldn't load here. Turn off any blocker or try another browser, then try again.";
let notes = 0;

export function wireRemindForm(form: HTMLFormElement, { checkBox, kid, source, theme = 'light' }: Options) {
  const input = form.querySelector('input[name="email"]') as HTMLInputElement;
  const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
  const note = form.querySelector('.remind-note') as HTMLElement;
  if (!note.id) note.id = `remind-note-${++notes}`;
  const changed = () => form.dispatchEvent(new Event('remind-state'));

  /** News on the status line; field: it's about the address, so the box is marked and reads it */
  const say = (text: string, { error = false, field = false } = {}) => {
    note.className = error ? 'remind-note remind-note--error' : 'remind-note';
    note.textContent = text;
    if (field) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', note.id); }
    else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
    // Anything floating over the page (the reveal banner) steps aside from fresh news (LiveIndicator listens)
    if (text) note.dispatchEvent(new CustomEvent('status-news', { bubbles: true }));
  };

  // ── Pressable or not ──
  let busy = false;
  const done = () => form.classList.contains('is-done');
  // (No aria-busy on the form: a screen reader may hold back a busy region's news. The button says "Sending".)
  const setState = (sending: boolean) => {
    busy = sending;
    form.classList.toggle('is-busy', sending);
    btn.setAttribute('aria-disabled', String(sending || done()));
    if (!sending) input.readOnly = false;
    changed();
  };
  // The page ships the button off (so nothing can send the form before this script is here): on, now that it is
  btn.disabled = false;
  btn.setAttribute('aria-disabled', 'false');
  let typed = false; // they've typed since the last sign-up or reset (an address left in the box isn't someone typing)
  /** The answer to a press, in view: on a short phone it can land under the keyboard or the fold */
  const showAnswer = () => {
    const r = note.getBoundingClientRect();
    const view = window.visualViewport?.height || innerHeight;
    if (r.height && (r.bottom > view || r.top < 0)) note.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  // ── The quick check ──
  let checkFrame: HTMLIFrameElement | null = null;
  let checkToken = '';
  let checkHeight = 0; // what Cloudflare drew, as the frame reports it
  let checkReady = false; // the frame has spoken: its page loaded
  let checkBlocked = false; // it couldn't load: a blocker, a failed page, or the network
  let checkWantsClick = false; // Cloudflare asked for a click
  let quiet = 0;
  let retryWhenChecked = ''; // a press the check held up; it goes ahead when the check sorts itself out
  let calledOff = false; // the address was changed while the check held the press up
  let waitTimer = 0;
  const checkWaiters: ((token: string) => void)[] = [];
  // Out of sight is out of the tab order and the screen reader too, until Cloudflare wants a click
  const showCheck = (on: boolean) => {
    checkBox?.classList.toggle('is-shown', on);
    checkBox?.setAttribute('aria-hidden', String(!on));
    if (checkFrame) {
      checkFrame.tabIndex = on ? 0 : -1;
      // Its own height once known (the compact widget on a narrow phone is taller); the stylesheet's until then
      checkFrame.style.height = on && checkHeight ? `${checkHeight}px` : '';
    }
  };
  const giveUpOnFrame = () => {
    checkBlocked = true;
    showCheck(false);
    for (const w of checkWaiters.splice(0)) w('');
  };
  async function warmCheck() {
    if (checkFrame || !checkBox || !(await checkNeeded()) || checkFrame) return;
    checkReady = false;
    checkFrame = document.createElement('iframe');
    checkFrame.src = `/api/reminders?check=1${theme === 'dark' ? '&theme=dark' : ''}`;
    checkFrame.title = 'Quick check that you are a person';
    const frame = checkFrame;
    const wait = (ms: number) => { clearTimeout(quiet); quiet = window.setTimeout(() => { if (checkFrame === frame && !checkReady) giveUpOnFrame(); }, ms); };
    wait(FRAME_LOAD_MS);
    frame.addEventListener('load', () => wait(FRAME_QUIET_MS), { once: true });
    checkBox.append(frame);
    showCheck(false);
  }
  function onCheckMessage(e: MessageEvent) {
    if (!checkFrame || e.source !== checkFrame.contentWindow || e.origin !== location.origin) return;
    const d = e.data || {};
    if (d.type !== 'soard-check') return;
    checkReady = true;
    clearTimeout(quiet);
    if (typeof d.h === 'number' && d.h > 0) {
      checkHeight = Math.min(Math.round(d.h), 320);
      if (checkBox?.classList.contains('is-shown')) checkFrame.style.height = `${checkHeight}px`;
    }
    // Shown only to someone it's for: not under a finished sign-up, nor while one is already on its way
    // (the next token, fetched ahead, asked); it shows when there's a next press to make
    if (d.show || d.error) { checkWantsClick = true; if (!done() && (checkWaiters.length || !busy)) showCheck(true); }
    // A click to make: there's time for it
    if (d.show && checkWaiters.length) armWait(90_000);
    // A press waiting on the check, and Cloudflare now wants a click: say where
    if (d.show && checkWaiters.length) say('Almost there. Finish the quick check below.');
    if (d.expired) checkToken = '';
    if (d.token) {
      checkToken = String(d.token);
      checkWantsClick = false;
      showCheck(false);
      const waiting = checkWaiters.length > 0;
      for (const w of checkWaiters.splice(0)) w(checkToken);
      // The check failed under a press, then sorted itself out: that sign-up carries on
      if (!waiting && retryWhenChecked && retryWhenChecked === input.value.trim() && !busy && !done()) { retryWhenChecked = ''; form.requestSubmit(); }
    }
    if (d.error) for (const w of checkWaiters.splice(0)) w('');
    if (d.blocked) giveUpOnFrame();
  }
  window.addEventListener('message', onCheckMessage);
  function armWait(ms: number) {
    clearTimeout(waitTimer);
    waitTimer = window.setTimeout(() => { for (const w of checkWaiters.splice(0)) w(''); }, ms);
  }
  /** A fresh token, '' when none came, or null when no check is on */
  async function checkTokenFor(): Promise<string | null> {
    if (!(await checkNeeded())) return null;
    // Trying again after it couldn't load starts it fresh
    if (checkBlocked) { checkBlocked = false; checkFrame?.remove(); checkFrame = null; }
    await warmCheck();
    let token = checkToken;
    if (!token && !checkBlocked) {
      // (Cloudflare's invisible check can take a while; the frame shows only if it asks for a click)
      if (checkWantsClick) { showCheck(true); say('Almost there. Finish the quick check below.'); }
      token = await new Promise<string>((resolve) => {
        checkWaiters.push((t) => { clearTimeout(waitTimer); resolve(t); });
        // An invisible check that says nothing for 20s isn't coming; one waiting on a click gets 90s
        armWait(checkWantsClick ? 90_000 : 20_000);
      });
      if (token && busy) say('One moment…');
    }
    // Each token works once: start the next one now
    checkToken = '';
    checkFrame?.contentWindow?.postMessage({ type: 'soard-check-reset' }, location.origin);
    return token || '';
  }
  form.addEventListener('focusin', () => { void warmCheck(); }, { once: true });
  form.addEventListener('pointerenter', () => { void warmCheck(); }, { once: true });

  /** POST to /api/reminders → [ok, data, status], with the kid, the source and (when needed) the check's token */
  async function send(payload: Record<string, string>, again = false): Promise<[boolean, Record<string, any>, number]> {
    const body: Record<string, unknown> = { ...payload, kidSlug: kid() || undefined, source: source() };
    const token = await checkTokenFor();
    if (calledOff) return [false, { calledOff: true }, 0];
    if (token === '') {
      return [false, { check: true, error: checkBlocked ? BLOCKED : checkWantsClick ? 'Please finish the quick check below, then try again.' : "The quick check didn't finish. Please try again." }, 403];
    }
    if (token) body.turnstileToken = token;
    // The address that's going is the one on screen: from here it can't change until the answer comes
    input.readOnly = true;
    try {
      const res = await fetch('/api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: within(SEND_TIMEOUT_MS) });
      const data = await res.json().catch(() => ({}));
      // The server wants the check (switched on since this page asked, or the config answer never came), or the token
      // had run out: once more, with the check on and a fresh token (the frame started the next one when the last was taken)
      if (data.code === 'turnstile' && !again) { checkOn = Promise.resolve(true); return send(payload, true); }
      return [res.ok && !!data.ok, data, res.status];
    } catch (err) {
      return [false, { error: (err as Error)?.name === 'TimeoutError' ? "We didn't hear back. Please try again." : 'No connection. Please try again.' }, 0];
    }
  }

  // ── The form ──
  let askedAbout = '';
  let askedAt = 0;
  /** "Did you mean ana@gmail.com?", a tap to use it */
  function offerFix(email: string, fix: string) {
    askedAbout = email;
    askedAt = performance.now();
    say('Did you mean ');
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'remind-fix';
    use.textContent = fix;
    use.addEventListener('click', () => { input.value = fix; input.focus(); say(''); });
    note.append(use, '?');
  }
  let doneFor = ''; // the reveal the finished sign-up was for ('' = every reveal, which covers any)
  function markDone(email: string, forKid: string) {
    doneFor = forKid;
    retryWhenChecked = '';
    typed = false;
    form.classList.add('is-done');
    setState(false);
    // The check has nothing more to ask of this sign-up
    showCheck(false);
    say(`Check your email to confirm. We sent a link to ${email}. Nothing comes until you tap it.`);
  }
  // A sign-up in another form here: one for every reveal covers this form's too, and one for this form's reveal is
  // this form's; either way it says so, not "Email me" again (unless someone is busy with it)
  function onSigned(e: Event) {
    const d = (e as CustomEvent<{ kid: string; email: string; from: HTMLFormElement }>).detail;
    if (!d || d.from === form || done() || busy || form.contains(document.activeElement)) return;
    if (d.kid && d.kid !== kid()) return;
    input.value = d.email;
    markDone(d.email, d.kid);
  }
  document.addEventListener('remind-signed', onSigned);
  function reset() {
    typed = false;
    form.classList.remove('is-done');
    setState(false);
    say('');
    // A click Cloudflare asked for after the last sign-up shows now there's a new one
    if (checkWantsClick) showCheck(true);
  }
  input.addEventListener('input', () => {
    typed = true;
    // Changed while the check held the press up: that press is called off, and this address waits for the next one
    if (busy && checkWaiters.length) { calledOff = true; for (const w of checkWaiters.splice(0)) w(''); }
    // "Did you mean" and "not valid" belong to the address they were about
    if (note.querySelector('.remind-fix') || note.classList.contains('remind-note--error')) say('');
    // A typo in the address? Editing it opens the form again
    if (done()) reset();
    changed();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || done()) return;
    calledOff = false;
    const email = input.value.trim();
    if (!email) { say('Enter your email address.', { error: true, field: true }); input.focus(); return; }
    const hp = (form.querySelector('input[name="website"]') as HTMLInputElement | null)?.value || '';
    const fix = mailFix(email);
    if (!isEmail(email)) {
      // "ana@gmail.com." is a slip with an answer; anything else needs fixing by hand
      if (fix && isEmail(fix)) { offerFix(email, fix); return; }
      say('Enter a valid email address.', { error: true, field: true });
      input.focus();
      return;
    }
    // A likely typo is asked about once. Pressing again sends it as typed: it may be right.
    if (fix && askedAbout !== email) { offerFix(email, fix); return; }
    if (fix && performance.now() - askedAt < SAME_PRESS_MS) return;
    setState(true);
    say('One moment…');
    const [ok, data, status] = await send({ channel: 'email', email, hp });
    if (data.calledOff) {
      // They're fixing the address: quietly ready for the next press
      setState(false);
      say('');
      return;
    }
    if (ok) {
      markDone(email, kid());
      showAnswer();
      // Any other reminder form on the page this covers shows it too, rather than asking again
      document.dispatchEvent(new CustomEvent('remind-signed', { detail: { kid: kid(), email, from: form } }));
    } else {
      retryWhenChecked = data.check && !checkBlocked ? email : '';
      setState(false);
      say(errorText(data, status), { error: true, field: status === 400 });
      // The server found the address wrong: back to the box, as the page's own check does
      if (status === 400) input.focus();
      showAnswer();
    }
  });

  return {
    /** A new reveal named: the form opens again, empty of news */
    reset,
    /** Signed up for every reveal (here or in another form on the page): it covers whoever is next */
    coversAll: () => done() && doneFor === '',
    /** Someone is filling it in: focus is in it, or they've typed an address and not sent it yet */
    inUse: () => form.contains(document.activeElement) || (typed && !!input.value.trim() && !done()),
    destroy() { clearTimeout(quiet); clearTimeout(waitTimer); window.removeEventListener('message', onCheckMessage); document.removeEventListener('remind-signed', onSigned); },
  };
}
