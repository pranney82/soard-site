/**
 * Which Zeffy form a link opens: one rule for the admin's Zeffy form dropdowns (./zeffy-forms.js) and for the server
 * matching a pasted link to a Zeffy campaign (functions/api/_advisory-money.js), so the two never disagree.
 *
 * One form's links differ by language (/en-US/, /fr-CA/, /es-419/, or none, as Zeffy's own API gives them), www,
 * tracking, an embed, a trailing slash and case; none of those make it another form. A link typed without https:// is
 * no form's: on a public page it would point at a page of our own site.
 * No imports: the server reads this file too.
 */

/** '' for a link that isn't a Zeffy form */
export function zeffyKey(url) {
  const m = String(url || '').trim().toLowerCase().match(/^https?:\/\/(?:www\.)?zeffy\.com\/([^?#\s]*)/);
  if (!m) return '';
  const parts = m[1].split('/').filter(Boolean);
  // A language and an embed, in either order, come before the form's own path
  for (let i = 0; i < 2 && parts.length && (parts[0] === 'embed' || /^[a-z]{2}(-[a-z0-9]{2,4})?$/.test(parts[0])); i++) parts.shift();
  return parts.join('/');
}

export const sameForm = (a, b) => { const k = zeffyKey(a); return !!k && k === zeffyKey(b); };

// ─── The site's own forms ──────────────────────────────────────────
// Admin → Site Config → Zeffy saves them in the settings document (settings.zeffy); until it has one, a page uses
// the form it always had. Only a Zeffy form will do: the Donate page and the live reveal open it inside the page.
export const SITE_FORMS = {
  donateUrl: 'https://www.zeffy.com/en-US/donation-form/help-build-a-brighter-home',
  monthlyUrl: 'https://www.zeffy.com/en-US/donation-form/soard-monthly-builders',
  liveUrl: 'https://www.zeffy.com/en-US/donation-form/help-build-a-brighter-home',
};
/** The form a page uses for one of SITE_FORMS' keys */
export function siteForm(settings, key) {
  const saved = String(settings?.zeffy?.[key] || '').trim();
  return /^https:\/\//i.test(saved) && zeffyKey(saved) ? saved : SITE_FORMS[key] || '';
}

/** Zeffy's embed of a form (for a pop-up on our page), or '' for a link that isn't a Zeffy form. Keeps its case */
export function embedOf(url) {
  if (!zeffyKey(url)) return '';
  const parts = String(url).trim().match(/^https?:\/\/(?:www\.)?zeffy\.com\/([^?#\s]*)/i)[1].split('/').filter(Boolean);
  for (let i = 0; i < 2 && parts.length && (/^embed$/i.test(parts[0]) || /^[a-z]{2}(-[a-z0-9]{2,4})?$/i.test(parts[0])); i++) parts.shift();
  return `https://www.zeffy.com/embed/${parts.join('/')}`;
}

/** A link with one value in its query set (an amount for a Zeffy form), whatever query it already has */
export function withParam(url, key, value) {
  try {
    const u = new URL(url);
    u.searchParams.set(key, String(value));
    return u.toString();
  } catch {
    return url;
  }
}
