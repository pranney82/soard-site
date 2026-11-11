/**
 * The trade-partner sign-in card, one template for both places it's drawn:
 * the page as built (src/pages/trade-partners/account.astro, in English and
 * Spanish, before any script runs) and account.ts (when there's no link on
 * the device, or after signing out). The same markup either way, so the page
 * script taking over moves nothing.
 */
import type { Words } from './account-words';
import type { Lang } from './words';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** The button that switches the page to the other language */
export const langButtonHtml = (T: Words, lang: Lang) =>
  `<button type="button" class="tpa-lang" data-act="lang" lang="${lang === 'es' ? 'en' : 'es'}">${esc(T.otherLang)}</button>`;

/**
 * The card. The form is method="dialog": sent before the page script has taken it over, it goes
 * nowhere (a plain form would load the page again with the email address in it).
 * papersBefore: this device signed in as a company SOARD pays off the jobs, so no "new here" line.
 */
export function signInHtml(T: Words, lang: Lang, { message = '', papersBefore = false }: { message?: string; papersBefore?: boolean } = {}) {
  return `
    <div class="tpa-narrow">
      <div class="tpa-card tpa-signin">
        <div class="tpa-row"><p class="tpa-eyebrow">${esc(T.eyebrow)}</p>${langButtonHtml(T, lang)}</div>
        <h1 class="tpa-h1">${esc(T.signTitle)}</h1>
        ${message ? `<p class="tpa-callout" role="alert">${esc(message)}</p>` : ''}
        <p class="tpa-lead">${esc(T.signBody)}</p>
        <form class="tpa-form" data-form="signin" method="dialog" novalidate>
          <label class="tpa-field"><span class="tpa-label">${esc(T.emailLabel)}</span><input name="email" type="email" autocomplete="email" inputmode="email" required></label>
          <button class="tpa-btn tpa-btn--primary tpa-btn--wide" type="submit">${esc(T.signBtn)}</button>
          <p class="tpa-note" data-note role="status" aria-live="polite" hidden></p>
        </form>
        ${papersBefore ? '' : `<p class="tpa-small tpa-new-here">${esc(T.newHere)} <a href="/trade-partners/#start">${esc(T.workWithUs)}</a></p>`}
      </div>
    </div>`;
}
