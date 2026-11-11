/**
 * events-shared.js — the rules for event pages, before and after the event
 * =========================================================================
 * No DOM. Imported by the site (src/pages/events/*, src/components/events/*),
 * the admin (the Event editor and ./event-preview.js), the server
 * (functions/api/_event-recap.js) and the tests (tests/event-recap.test.mjs),
 * so all four agree on what follows.
 *
 *   Series. The gala and the golf tournament come back every year. Each one
 *   has a page that never moves (/events/gala/, /events/golf/) and always
 *   shows the newest event of its series, plus a page per year
 *   (/events/gala/2026/) that keeps that year's photos and sponsors for good.
 *   An event joins a series by its slug, so "2027-evening-of-sunshine" or
 *   "golf-2027" needs no code change. The year comes from the event's date.
 *
 *   Over. An event is over the day after its last day, in Atlanta time. From
 *   then on its page is the recap: the pro photos, then the sponsors. The
 *   hub heartbeat rebuilds the site that morning so nobody has to publish.
 *
 *   Photos. An event's own photos (the Event editor) come first. A series
 *   event without any shows the photos uploaded to its page's gallery (Gala or
 *   Golf editor) from its date until the next event of the series: uploads
 *   carry their time in the image ID ("gallery/gala/1790263941367-dsc.jpg").
 *
 *   Sponsors. An event's own sponsor list comes first. Until it has one, the
 *   newest event of a series shows its page's sponsor list (the Gala or Golf
 *   editor), and the heartbeat saves that list with the event when it ends,
 *   so next year's sponsors never rewrite this year's thank-you.
 *
 *   Tickets. An event's own tickets link (ticketsOf) is the only one any page uses: none means not on sale yet, and
 *   no page asks anyone to buy or register.
 */

import { zeffyLinkProblem } from './zeffy-links.js';

export const TZ = 'America/New_York';

export const SERIES = [
  { key: 'gala', name: 'Evening of Sunshine', kind: 'gala', pattern: /evening-of-sunshine|gala/, path: '/events/gala/', doc: 'gala', mailSubject: 'Evening of Sunshine' },
  { key: 'golf', name: 'Sunshine on a Ranney Fairway', kind: 'golf tournament', pattern: /fairway|golf/, path: '/events/golf/', doc: 'golf', mailSubject: 'Sunshine on a Ranney Fairway' },
];

/** The series an event belongs to, or null */
export const seriesOf = (ev) => SERIES.find((s) => s.pattern.test(String(ev?.slug || ''))) || null;
export const seriesByKey = (key) => SERIES.find((s) => s.key === key) || null;

/** A day (YYYY-MM-DD) in Atlanta time */
export function dayIn(ms = Date.now(), tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
export const lastDay = (ev) => ev?.endDate || ev?.date || '';
export const yearOf = (ev) => String(ev?.date || '').slice(0, 4);
/** Over from the day after its last day (Atlanta time); a cancelled event never is */
export const isOver = (ev, today = dayIn()) => !!ev?.date && ev.status !== 'cancelled' && lastDay(ev) < today;

/** A series' events, newest first (cancelled ones left out) */
export function seriesEvents(series, events) {
  return (events || [])
    .filter((e) => e?.date && e.status !== 'cancelled' && seriesOf(e)?.key === series.key)
    .sort((a, b) => b.date.localeCompare(a.date) || String(a.slug).localeCompare(String(b.slug)));
}
export const latestOf = (series, events) => seriesEvents(series, events)[0] || null;
/** Is this the newest event of its series (the one /events/gala/ shows)? */
export function isLatest(ev, events) {
  const s = seriesOf(ev);
  return !!s && latestOf(s, events)?.slug === ev.slug;
}

/** The year page of a series event: /events/gala/2026/ (null for the second event of a year) */
export function yearPath(ev, events) {
  const s = seriesOf(ev);
  const y = yearOf(ev);
  if (!s || !/^\d{4}$/.test(y)) return null;
  const first = seriesEvents(s, events).filter((e) => yearOf(e) === y).pop();
  return first?.slug === ev.slug ? `${s.path}${y}/` : null;
}

/** Every year page the build makes: series events that are over */
export function yearPages(events, today = dayIn()) {
  const out = [];
  for (const s of SERIES) {
    for (const ev of seriesEvents(s, events)) {
      const path = isOver(ev, today) ? yearPath(ev, events) : null;
      if (path) out.push({ series: s, year: yearOf(ev), ev, path });
    }
  }
  return out;
}

/**
 * Where an event lives on the site. The newest event of a series is at the
 * series page; an older one at its year page once it's over. Anything else
 * at /events/<slug>/ (which exists when hasOwnPage says so).
 */
export function eventPath(ev, events, today = dayIn()) {
  const s = seriesOf(ev);
  if (s && ev.status !== 'cancelled') {
    if (isLatest(ev, events)) return s.path;
    const y = isOver(ev, today) ? yearPath(ev, events) : null;
    if (y) return y;
  }
  return `/events/${ev.slug}/`;
}

/** Does /events/<slug>/ have a page of its own (not a forward to the series)? */
export function hasOwnPage(ev, events, today = dayIn()) {
  if (eventPath(ev, events, today) !== `/events/${ev.slug}/`) return false;
  if (ev.body || (ev.photos || []).length > 0 || ev.streamVideoId || ev.videoUrl) return true;
  return isOver(ev, today);
}

// ── Tickets ──────────────────────────────────────────────────────────────
/**
 * An event's tickets or sign-up link, when it's a whole https:// link (the rule Admin's Zeffy fields check with), or
 * '' when it has none: every page that shows a ticket button asks this, and shows none for ''
 */
export function ticketsOf(ev) {
  const url = String(ev?.ticketUrl ?? '').trim();
  return url && !zeffyLinkProblem(url) ? url : '';
}

// ── Photos ───────────────────────────────────────────────────────────────
/** The upload time an admin upload carries in its ID ("…/1790263941367-name"), or null */
export function uploadedAt(id) {
  const m = String(id || '').match(/(?:^|\/)(\d{13})-/);
  return m ? Number(m[1]) : null;
}
/** Photos as { id, alt }, empty IDs and repeats left out */
export function cleanPhotos(list) {
  const seen = new Set();
  const out = [];
  for (const p of list || []) {
    const ph = typeof p === 'string' ? { id: p, alt: '' } : { alt: '', ...p };
    const id = String(ph.id || '').trim();
    if (!id || id.startsWith('blob:') || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...ph, id, alt: String(ph.alt || '').trim() });
  }
  return out;
}
/** The page gallery photos that belong to a series event: uploaded from its date until the next one */
export function galleryPhotosFor(ev, events, pageDoc) {
  const s = seriesOf(ev);
  if (!s || !pageDoc) return [];
  const list = seriesEvents(s, events);
  const i = list.findIndex((e) => e.slug === ev.slug);
  if (i < 0) return [];
  const until = i > 0 ? list[i - 1].date : null;
  return cleanPhotos(pageDoc.galleryPhotos).filter((p) => {
    const t = uploadedAt(p.id);
    if (!t) return false;
    const d = dayIn(t);
    return d >= ev.date && (!until || d < until);
  });
}
/** The photos an event's recap shows */
export function recapPhotos(ev, events, pageDoc) {
  const own = cleanPhotos(ev?.photos);
  return own.length ? own : galleryPhotosFor(ev, events, pageDoc);
}
/** Where an event's recap photos come from: 'event', 'gallery' or null */
export function recapPhotosSource(ev, events, pageDoc) {
  if (cleanPhotos(ev?.photos).length) return 'event';
  return galleryPhotosFor(ev, events, pageDoc).length ? 'gallery' : null;
}

// ── Sponsors ─────────────────────────────────────────────────────────────
/** Tier groups { tier, size, names: [{ name, logo?, website?, scale? }] }, empty ones left out */
export function cleanSponsors(tiers) {
  return (Array.isArray(tiers) ? tiers : [])
    .map((t) => ({
      ...t,
      tier: String(t?.tier || '').trim(),
      size: ['xl', 'lg', 'md', 'sm'].includes(t?.size) ? t.size : 'md',
      names: (Array.isArray(t?.names) ? t.names : [])
        .map((n) => (typeof n === 'string' ? { name: n } : { ...n }))
        .map((n) => ({ ...n, name: String(n.name || '').trim() }))
        .filter((n) => n.name || n.logo),
    }))
    .filter((t) => t.names.length);
}
export const hasOwnSponsors = (ev) => cleanSponsors(ev?.sponsors).length > 0;
/** The sponsors an event's recap thanks */
export function recapSponsors(ev, events, pageDoc) {
  if (hasOwnSponsors(ev)) return cleanSponsors(ev.sponsors);
  return pageDoc && isLatest(ev, events) ? cleanSponsors(pageDoc.sponsors) : [];
}
export function recapSponsorsSource(ev, events, pageDoc) {
  if (hasOwnSponsors(ev)) return 'event';
  return recapSponsors(ev, events, pageDoc).length ? 'page' : null;
}
export const sponsorCount = (tiers) => new Set(cleanSponsors(tiers).flatMap((t) => t.names.map((n) => (n.name || n.logo).toLowerCase()))).size;

const LEVEL_WORDS = /\b(title|presenting|diamond|platinum|gold|silver|bronze|copper|premier|champion|patron|benefactor|founding|host|hole)\b/i;
/**
 * Levels (Diamond, Gold, Hole…) get a logo wall; the named pieces of the day
 * (Signature Cocktail, Closest to the Pin…) read like a program. A tier is a
 * level when it's large, says so in its name or has more than three sponsors.
 */
export function splitSponsors(tiers) {
  const levels = [];
  const moments = [];
  for (const t of cleanSponsors(tiers)) {
    const level = t.size !== 'sm' && (t.size === 'xl' || t.size === 'lg' || LEVEL_WORDS.test(t.tier) || t.names.length > 3);
    (level ? levels : moments).push(t);
  }
  return { levels, moments };
}
/** "Signature Cocktail Sponsor" → "Signature Cocktail" */
export const momentName = (tier) => String(tier || '').replace(/\s+sponsors?(hip)?$/i, '').trim() || String(tier || '');

/** One key per sponsor name, for matching sponsors to partner records */
export const nameKey = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(inc|llc|co|corp|corporate|the)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, '');

/** The event's own numbers ("350" guests), filled ones only, at most four */
export const HIGHLIGHTS_MAX = 4;
export function cleanHighlights(list) {
  return (Array.isArray(list) ? list : [])
    .map((h) => ({ value: String(h?.value || '').trim(), label: String(h?.label || '').trim() }))
    .filter((h) => h.value && h.label)
    .slice(0, HIGHLIGHTS_MAX);
}

// ── Look ─────────────────────────────────────────────────────────────────
const GALA_TEAL = '#0d2f3f';
const GOLF_GREEN = '#1a472a';
/**
 * Each series' recap colors, the one list for its recap page and its recap
 * email: EventRecap.astro sets the page's --rc-* variables from it
 * (recapStyle), and the email takes its colors from it (recapLook in
 * functions/api/_newsletter-email.js). Values are as CSS writes them; null
 * keeps the site's own (EventRecap.astro's .rc, the site's yellow), and so
 * does any event outside a series.
 *   paper, paper2   the page, and its white cards
 *   ink, muted      words, quiet words
 *   eyebrow         the small line over a heading, and the gala's theme
 *   accent          focus rings and the shape behind the cover photo
 *   highlight       the marker behind a heading's key word
 *   dark            the series' own dark: the bands below fade from it, and the
 *                   email, which can't fade, has it solid
 *   band, bandAccent   the dark tile and its numbers
 *   tile            behind a photo while it loads
 *   line            rules
 *   close           the card the page closes on
 */
export const RECAP_LOOKS = Object.freeze({
  gala: Object.freeze({
    paper: '#faf3e0', paper2: '#fffaf0', ink: GALA_TEAL, muted: '#4b5d63', eyebrow: '#b04f3d', accent: '#d4a017',
    highlight: 'rgba(232, 152, 112, 0.42)', dark: GALA_TEAL,
    band: `linear-gradient(150deg, ${GALA_TEAL} 0%, #1a4759 60%, #24586a 100%)`, bandAccent: '#f0c35a',
    tile: '#efe2c6', line: 'rgba(13, 47, 63, 0.12)', close: `linear-gradient(150deg, ${GALA_TEAL} 0%, #1a4759 100%)`,
  }),
  golf: Object.freeze({
    paper: '#f7f8f2', paper2: '#fff', ink: '#12301f', muted: '#4f5b52', eyebrow: '#2e7d32', accent: null,
    highlight: 'rgba(255, 218, 36, 0.38)', dark: GOLF_GREEN,
    band: `linear-gradient(150deg, #0d2818 0%, ${GOLF_GREEN} 55%, #2e7d32 100%)`, bandAccent: null,
    tile: '#e3e8dc', line: 'rgba(18, 48, 31, 0.1)', close: `linear-gradient(150deg, #0d2818 0%, ${GOLF_GREEN} 100%)`,
  }),
});

/** The page's names for them */
const RC_VARS = Object.freeze({
  paper: 'paper', paper2: 'paper-2', ink: 'ink', muted: 'muted', eyebrow: 'eyebrow', accent: 'accent',
  highlight: 'highlight', band: 'band', bandAccent: 'band-accent', tile: 'tile', line: 'line', close: 'close',
});

/** A recap page's colors as its style ("--rc-paper:#faf3e0;…"); undefined for the site's own */
export function recapStyle(key) {
  const look = RECAP_LOOKS[key];
  if (!look) return undefined;
  return Object.entries(RC_VARS).filter(([k]) => look[k] != null).map(([k, name]) => `--rc-${name}:${look[k]}`).join(';');
}

/** The gala's theme for its year ("Havana Nights"), as staff set it on the event (Events → Gala → Theme) */
export function recapThemeName(ev) {
  return String(ev?.theme || '').trim();
}

// ── Words ────────────────────────────────────────────────────────────────
export function fmtDay(d, opts = { month: 'long', day: 'numeric', year: 'numeric' }) {
  return d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', opts) : '';
}
/** The name a recap shows: the series name, else the title without a leading year */
export function displayName(ev) {
  const s = seriesOf(ev);
  if (s) return s.name;
  return String(ev?.title || '').trim();
}
/** The recap's opening words, unless the event has its own thank-you note */
export function recapLead(ev, { photos = 0, sponsors = 0 } = {}) {
  const own = String(ev?.recapNote || '').trim();
  if (own) return own;
  const day = fmtDay(ev?.date, { month: 'long', day: 'numeric' });
  const when = seriesOf(ev)?.key === 'gala' ? 'night' : 'day';
  const came = `Thank you to everyone who joined us${ev?.location ? ` at ${String(ev.location).trim()}` : ''}${day ? ` on ${day}` : ''}.`;
  if (photos && sponsors) return `${came} Here’s the ${when} in photos, followed by the sponsors who made it possible.`;
  if (photos) return `${came} Here’s the ${when} in photos.`;
  if (sponsors) return `${came} Our photographer’s pictures are on the way. Below are the sponsors who made the ${when} possible.`;
  return `${came} Photos from the ${when} are on the way.`;
}
