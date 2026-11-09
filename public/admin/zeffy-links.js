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
