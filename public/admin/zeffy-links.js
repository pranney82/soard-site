/**
 * Which Zeffy form a link opens: one rule for the admin's Zeffy form dropdowns (./zeffy-forms.js) and for the server
 * matching a saved link to a Zeffy campaign (functions/api/_advisory-money.js), so the two never disagree.
 *
 * One form's links differ by language (/en-US/, /fr-CA/, /es-419/, or none, as Zeffy's own API gives them), www,
 * tracking, an embed, a trailing slash and case; none of those make it another form. A link typed without https:// is
 * no form's: on a public page it would point at a page of our own site.
 * Also what makes a link whole (zeffyLinkProblem, finishLink: admin's Zeffy fields use them), and the site's own forms.
 * No imports: the server reads this file too.
 */

/** A Zeffy form link's own path, as written (no language, no embed), or null for a link that isn't one */
function formPath(url) {
  const m = String(url || '').trim().match(/^https?:\/\/(?:www\.)?zeffy\.com\/([^?#\s]*)/i);
  if (!m) return null;
  const parts = m[1].split('/').filter(Boolean);
  // A language and an embed, in either order, come before the form's own path
  for (let i = 0; i < 2 && parts.length && (/^embed$/i.test(parts[0]) || /^[a-z]{2}(-[a-z0-9]{2,4})?$/i.test(parts[0])); i++) parts.shift();
  return parts.length ? parts.join('/') : null;
}

/** '' for a link that isn't a Zeffy form */
export const zeffyKey = (url) => (formPath(url) || '').toLowerCase();

export const sameForm = (a, b) => { const k = zeffyKey(a); return !!k && k === zeffyKey(b); };

// ─── A link typed into a Zeffy field ───────────────────────────────
/**
 * What's wrong with it, in the words every field shows, or null.
 *   required   an empty one is a problem (the Donate page's and the live reveal's forms)
 *   zeffyOnly  only a Zeffy form will do (those open inside our own pages)
 * Anything else may be any whole web address: an event's sign-up sheet, say.
 */
const LINKISH = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|[^\s/]+\.[a-z]{2,}(?:[/?#]|$))/i;
export function zeffyLinkProblem(url, { required = false, zeffyOnly = false } = {}) {
  const v = String(url ?? '').trim();
  if (!v) return required ? 'Pick a Zeffy form' : null;
  // Words with spaces ("Sign up at the front desk") aren't a link with a space in it
  if (/\s/.test(v)) return LINKISH.test(v) ? 'Take the spaces out of the link' : 'That isn’t a link: paste the whole link, starting with https://';
  if (!/^https:\/\//i.test(v)) return 'Paste the whole link, starting with https://';
  if (!/^https:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(v)) return 'That isn’t a whole web address';
  if (zeffyOnly && !zeffyKey(v)) return 'Use a Zeffy form’s link (zeffy.com)';
  return null;
}

/** A link typed without its https:// (www.zeffy.com/…) with it put on; anything else as it was, trimmed */
export function finishLink(url) {
  const v = String(url ?? '').trim();
  return v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^\s/]+\.[a-z]{2,}(\/|$)/i.test(v) ? `https://${v}` : v;
}

// ─── The site's own forms ──────────────────────────────────────────
// Admin → Site Config → Zeffy keeps them in the settings document (settings.zeffy), and nowhere else: no page has a
// form of its own. Each is required there, and only a Zeffy form will do: the pages open it inside themselves.
export const SITE_FORM_KEYS = ['donateUrl', 'monthlyUrl', 'liveUrl'];
// What each is for, as a build that can't find one says it
const SITE_FORM_FOR = { donateUrl: 'The Donate page’s one-time gifts', monthlyUrl: 'The Donate page’s monthly gifts', liveUrl: 'The live reveal’s “Fund the next room”' };

/** The form a page uses for one of SITE_FORM_KEYS, or '' when Site Config has none */
export function siteForm(settings, key) {
  const saved = String(settings?.zeffy?.[key] || '').trim();
  return zeffyLinkProblem(saved, { required: true, zeffyOnly: true }) ? '' : saved;
}

/**
 * The same, for a page that can't be built without it: a missing form stops the build with what to do, rather than
 * putting a page up with a button that goes nowhere (a failed build leaves the last good site up)
 */
export function requireSiteForm(settings, key) {
  const url = siteForm(settings, key);
  if (!url) throw new Error(`${SITE_FORM_FOR[key] || key} has no Zeffy form: pick one in Admin → Site Config → Zeffy (settings.zeffy.${key}), then publish.`);
  return url;
}

/**
 * A Zeffy form's two links, from however it was saved: its page (what a new tab, or no JavaScript, opens) and its
 * embed (what ZeffyPopup opens on our page). Both are the form's own path, in lower case and without a language, with
 * the saved link's query kept but for an amount, which belongs to each button. null for a link that isn't a form
 */
export function formLinks(url) {
  const path = formPath(url);
  if (!path) return null;
  let query = '';
  try {
    const u = new URL(String(url).trim());
    u.searchParams.delete('amount');
    query = u.search;
  } catch { /* formPath matched, so it parses */ }
  const own = path.toLowerCase();
  return { page: `https://www.zeffy.com/${own}${query}`, embed: `https://www.zeffy.com/embed/${own}${query}` };
}

/** Zeffy's embed of a form (for a pop-up on our page), or '' for a link that isn't a Zeffy form */
export const embedOf = (url) => formLinks(url)?.embed || '';

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

/**
 * A gift button's link to one of the site's forms, at an amount when it has one: { href, 'data-zeffy' }, spread onto
 * the <a>. ZeffyPopup opens data-zeffy in place; href is the form's own page, for a new tab or no JavaScript
 */
export function giftLink(settings, key, amount = null) {
  const { page, embed } = formLinks(requireSiteForm(settings, key));
  const at = (u) => (amount == null ? u : withParam(u, 'amount', amount));
  return { href: at(page), 'data-zeffy': at(embed) };
}

// ─── Giving from a donor-advised fund ──────────────────────────────
// Zeffy offers "Donor-advised fund" at checkout for one-time gifts from DAF_MIN, on a form with "Offer payment by
// donor-advised fund" on (Edit → Advanced settings). Zeffy's API doesn't say which forms have it, so whoever picks
// the one-time form in Site Config → Zeffy says so (settings.zeffy.daf), and the pages offer it only then.
export const DAF_MIN = 1000;
/** "$1,000": the minimum as the pages say it */
export const DAF_MIN_TEXT = '$' + DAF_MIN.toLocaleString('en-US');
/** Does the one-time form take donor-advised fund gifts (as Site Config → Zeffy was told)? */
export const dafOn = (settings) => settings?.zeffy?.daf === true && !!siteForm(settings, 'donateUrl');
/** "Give from your DAF": the one-time form at the minimum, so "Donor-advised fund" is there after Continue; null when it's off */
export const dafGift = (settings) => (dafOn(settings) ? giftLink(settings, 'donateUrl', DAF_MIN) : null);

// ─── One record in Zeffy's own dashboard ───────────────────────────
// Zeffy opens a payment or a donor in a side panel without changing the address, but both open straight from a link
// carrying the id its API gives: a payment's id is Zeffy's transactionId (checked in SOARD's Zeffy, Nov 11 2026, on a
// record the site made). Admin and Slack link these, so a person lands on the record itself, never a list to search.
export const ZEFFY_PAYMENTS = 'https://www.zeffy.com/en-US/o/all-payments';
export const ZEFFY_CONTACTS = 'https://www.zeffy.com/en-US/o/crm/contacts';
/** That payment in Zeffy; Zeffy's Payments list when there's no id */
export const zeffyPaymentUrl = (id) => (id ? `${ZEFFY_PAYMENTS}?transactionId=${encodeURIComponent(String(id))}` : ZEFFY_PAYMENTS);
/** That donor (contact) in Zeffy; Zeffy's Contacts list when there's no id */
export const zeffyContactUrl = (id) => (id ? `${ZEFFY_CONTACTS}?contactId=${encodeURIComponent(String(id))}` : ZEFFY_CONTACTS);
