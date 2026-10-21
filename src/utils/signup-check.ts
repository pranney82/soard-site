/**
 * The quick check (Cloudflare Turnstile) on the site's email signups.
 *
 * /api/newsletter wants a Turnstile token with every JSON signup while the
 * check is on; GET /api/newsletter says whether it is, with the site key.
 * This loads Turnstile the first time someone reaches for a signup form,
 * renders a widget that stays out of sight unless Cloudflare needs a click,
 * and hands the submit a fresh token.
 *
 * No token to be had (Turnstile blocked, failing, or turned down by the
 * server)? The form posts itself plainly instead: /api/newsletter answers a
 * plain form post with a one-tap confirm page, so nobody is ever stuck.
 *
 * Used by the footer newsletter form, the Apply page's "Notify me" form and
 * the closed application form (functions/api/newsletter.js has the server side).
 */

type Turnstile = {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
};

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const WAIT_MS = 12_000;           // for a token that needs no click
const WAIT_INTERACTIVE_MS = 120_000; // once the widget asks the person to click

let keyPromise: Promise<string | null> | null = null;
let apiPromise: Promise<Turnstile> | null = null;

/** The site key while the check is on, null while it's off. One request per page session. */
function siteKey(): Promise<string | null> {
  keyPromise ||= fetch('/api/newsletter', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((b) => (b && typeof b.turnstileSiteKey === 'string' ? b.turnstileSiteKey : null))
    .catch(() => { keyPromise = null; return null; });
  return keyPromise;
}

/** Turnstile's script, loaded once (the application form may have loaded it already) */
function turnstileApi(): Promise<Turnstile> {
  const w = window as unknown as { turnstile?: Turnstile };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  apiPromise ||= new Promise<Turnstile>((resolve, reject) => {
    let s = document.querySelector<HTMLScriptElement>('script[src*="challenges.cloudflare.com/turnstile/"]');
    if (!s) {
      s = document.createElement('script');
      s.src = TURNSTILE_SRC;
      s.async = true;
      document.head.append(s);
    }
    s.addEventListener('error', () => reject(new Error('Turnstile did not load')), { once: true });
    const started = Date.now();
    const poll = () => {
      if (w.turnstile) return resolve(w.turnstile);
      if (Date.now() - started > WAIT_MS) return reject(new Error('Turnstile did not load'));
      setTimeout(poll, 100);
    };
    poll();
  }).catch((e) => { apiPromise = null; throw e; });
  return apiPromise;
}

export interface SignupCheck {
  /**
   * What to send with the signup: null when no check is needed, a token, or
   * '' when none could be had (post the form plainly instead).
   */
  token(): Promise<string | null>;
  /** Tokens work once: call after each send */
  reset(): void;
  /** Before the page is swapped out (view transitions) */
  destroy(): void;
}

/**
 * The check for one form. The widget goes in the form's [data-signup-check]
 * box, which gets .is-shown while Cloudflare wants a click.
 */
export function signupCheck(form: HTMLFormElement, { lang }: { lang?: () => string } = {}): SignupCheck {
  const box = form.querySelector<HTMLElement>('[data-signup-check]');
  let state: 'idle' | 'loading' | 'off' | 'ready' | 'failed' = 'idle';
  let widget: string | null = null;
  let current: string | null = null;
  let interactive = false;

  async function start() {
    if (state !== 'idle') return;
    state = 'loading';
    const key = await siteKey();
    if (!key) { state = 'off'; return; }
    if (!box) { state = 'failed'; return; }
    try {
      const ts = await turnstileApi();
      widget = ts.render(box, {
        sitekey: key,
        action: 'signup',
        appearance: 'interaction-only',
        size: 'flexible',
        language: lang?.() || 'auto',
        callback: (t: string) => { current = t; state = 'ready'; interactive = false; box.classList.remove('is-shown'); },
        'expired-callback': () => { current = null; },
        'error-callback': () => { current = null; state = 'failed'; return true; },
        'unsupported-callback': () => { state = 'failed'; },
        'before-interactive-callback': () => { interactive = true; box.classList.add('is-shown'); },
        'after-interactive-callback': () => { interactive = false; },
      });
    } catch {
      state = 'failed';
    }
  }

  // Warm up as soon as someone reaches for the form, so the token is usually ready by Submit
  const warm = () => { void start(); };
  form.addEventListener('focusin', warm, { once: true });
  form.addEventListener('pointerenter', warm, { once: true });

  return {
    async token() {
      void start();
      const began = Date.now();
      for (;;) {
        if (state === 'off') return null;
        if (current) return current;
        if (state === 'failed') return '';
        if (Date.now() - began > (interactive ? WAIT_INTERACTIVE_MS : WAIT_MS)) return '';
        await new Promise((r) => setTimeout(r, 150));
      }
    },
    reset() {
      current = null;
      if (widget == null) return;
      state = 'loading';
      try { (window as unknown as { turnstile?: Turnstile }).turnstile?.reset(widget); } catch { state = 'failed'; }
    },
    destroy() {
      if (widget == null) return;
      try { (window as unknown as { turnstile?: Turnstile }).turnstile?.remove(widget); } catch { /* already gone */ }
      widget = null;
    },
  };
}

/**
 * Send the form the plain way (the no-JavaScript path): the server answers
 * with its one-tap confirm page. Fields must be enabled to be sent.
 */
export function postPlainly(form: HTMLFormElement) {
  form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((el) => { el.disabled = false; });
  HTMLFormElement.prototype.submit.call(form);
}
