/**
 * Reveal dates for public pages (kid pages, events page, the live page's
 * "Coming up" list, the starting-soon screen). Data comes from /api/reveals,
 * which reads JobTread; see functions/api/_reveals.js. A confirmed reveal
 * has its day and time; a tentative one only "early/mid/late <month>".
 */

export interface Reveal {
  slug: string;
  name: string;
  startsAt: string;      // ISO UTC
  date: string;          // YYYY-MM-DD, Eastern
  time: string | null;   // HH:MM Eastern, null until the time is set
  image: string | null;
  kidUrl: string;
  liveUrl: string;
}

/** A third of a month, the only timing a tentative reveal ever shows */
export interface RevealWindow {
  part: 'early' | 'mid' | 'late';
  month: string;         // YYYY-MM
  through: string;       // YYYY-MM-DD, the window's last day
  label: string;         // "mid November" ("early January 2027" in another year)
}

/** One entry in the upcoming list: a confirmed reveal, or a tentative one with only its window */
export type UpcomingReveal =
  | (Reveal & { confirmed: true; rooms: string[] })
  | { slug: string; name: string; confirmed: false; window: RevealWindow; image: string | null; kidUrl: string; liveUrl: string; rooms: string[] };

interface Schedule { reveals: Reveal[]; upcoming: UpcomingReveal[] }

const TZ = 'America/New_York';
let pending: Promise<Schedule> | null = null;
let pendingAt = 0;

/** One request per page view (re-fetched after a minute for long-lived tabs). Never rejects. */
function loadSchedule(): Promise<Schedule> {
  if (!pending || Date.now() - pendingAt > 60_000) {
    pendingAt = Date.now();
    pending = fetch('/api/reveals', { headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : {}))
      .then((body: { reveals?: unknown; upcoming?: unknown }) => {
        const reveals = Array.isArray(body?.reveals) ? body.reveals as Reveal[] : [];
        const upcoming = Array.isArray(body?.upcoming) ? body.upcoming as UpcomingReveal[] : reveals.map(r => ({ ...r, confirmed: true as const, rooms: [] }));
        return { reveals, upcoming };
      })
      .catch(() => ({ reveals: [], upcoming: [] }));
  }
  return pending;
}

/** Confirmed reveals only, soonest first */
export function loadReveals(): Promise<Reveal[]> {
  return loadSchedule().then(s => s.reveals);
}

/** Everything coming up, confirmed and tentative, soonest first */
export function loadUpcoming(): Promise<UpcomingReveal[]> {
  return loadSchedule().then(s => s.upcoming);
}

/** "mid November" → "Mid November" */
export const windowTitle = (w: RevealWindow) => w.label.charAt(0).toUpperCase() + w.label.slice(1);

/** "Mid Nov" for tight spaces */
export function windowShort(w: RevealWindow): string {
  const [y, m] = w.month.split('-').map(Number);
  const mon = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${w.part.charAt(0).toUpperCase()}${w.part.slice(1)} ${mon}`;
}

// ─── Reveal invites people add to their calendars (functions/api/reveals.ics.js) ───
// Each child has their own (?kid=<slug>): live link only, never an address;
// it fills in the day and time on its own once they're set.
export const FEED_PATH = '/api/reveals.ics';
export const CALENDAR_NAME = 'Sunshine on a Ranney Day reveals';
const SITE = 'https://sunshineonaranneyday.com';

/** "Max’s", "James’" */
export const possessive = (name: string) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

/** Where each calendar app adds an invite (one child's, or every reveal), and the plain address to paste anywhere else */
export function inviteLinks(kid?: { slug: string; name: string } | null, origin = SITE) {
  const https = `${origin}${FEED_PATH}${kid ? `?kid=${encodeURIComponent(kid.slug)}` : ''}`;
  const webcal = https.replace(/^https?:/, 'webcal:');
  const name = kid ? `${possessive(kid.name)} room reveal` : CALENDAR_NAME;
  return {
    apple: webcal,
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(name)}`,
    copy: https,
  };
}

/** The calendar with every confirmed reveal */
export const subscribeLinks = (origin = SITE) => inviteLinks(null, origin);

/**
 * What an invite button carries, so the invite sheet can say what it adds
 * without another request: data-invite (slug), -name, -when, -set.
 */
export function inviteData(r: UpcomingReveal): Record<string, string> {
  return {
    'data-invite': r.slug,
    'data-invite-name': r.name,
    'data-invite-when': r.confirmed ? revealWhen(r) : r.window.label,
    'data-invite-set': r.confirmed ? '1' : '0',
  };
}

/** One confirmed reveal as a calendar file */
export const revealIcsUrl = (slug: string) => `${FEED_PATH}?reveal=${encodeURIComponent(slug)}`;

// Date-only values are formatted at noon UTC so no time zone can shift the day
const dayDate = (r: Reveal) => new Date(`${r.date}T12:00:00Z`);

/** "Tuesday, October 27" (long) or "Tue, Oct 27" (short) */
export function revealDay(r: Reveal, style: 'long' | 'short' = 'long'): string {
  return dayDate(r).toLocaleDateString('en-US', style === 'long'
    ? { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }
    : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "Oct 27" */
export function revealShortDate(r: Reveal): string {
  return dayDate(r).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "4:00 PM ET", or '' when no time is set yet */
export function revealTime(r: Reveal): string {
  if (!r.time) return '';
  const t = new Date(r.startsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
  return `${t} ET`;
}

/** "Tuesday, October 27 at 4:00 PM ET" / "Tuesday, October 27" */
export function revealWhen(r: Reveal, style: 'long' | 'short' = 'long'): string {
  const t = revealTime(r);
  return t ? `${revealDay(r, style)} at ${t}` : revealDay(r, style);
}

/** A one-line reveal date: "Reveal mid November", or "Reveal Tuesday, November 25" once confirmed */
export function revealDateLine(r: UpcomingReveal): string {
  return r.confirmed ? `Reveal ${revealDay(r)}` : `Reveal ${r.window.label}`;
}
