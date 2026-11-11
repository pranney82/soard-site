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

/** The every-reveal email sign-up (Reveals → Settings): open or not, and the hours-before notes it sends */
export interface Signup { email: boolean; hours: number[] }

interface Schedule { reveals: Reveal[]; upcoming: UpcomingReveal[]; signup: Signup | null; failed?: boolean }

const TZ = 'America/New_York';

/** The every-reveal email sign-up in an /api/reveals answer: open or not, and its notes. null when not said.
 *  The server reads the same answer the same way (functions/_kid-reveal.js) */
export function signupOf(raw: unknown): Signup | null {
  const s = raw as Partial<Signup> | null | undefined;
  return s && typeof s.email === 'boolean' ? { email: s.email, hours: Array.isArray(s.hours) ? s.hours.filter((h) => h === 24 || h === 1) : [24, 1] } : null;
}

/**
 * The schedule the server drew a part of the page from (/api/reveals as it is at the edge), left on that part as
 * data-schedule (functions/_kid-reveal.js, scheduleAttr) so its script starts from the same list and sign-up
 * setting, and finds nothing to change. null when the server didn't draw it (the page as built).
 */
export function scheduleOnPage(el: HTMLElement | null | undefined): { upcoming: UpcomingReveal[]; signup: Signup | null } | null {
  try {
    const v = JSON.parse(el?.dataset.schedule || 'null');
    return v && Array.isArray(v.upcoming) ? { upcoming: v.upcoming as UpcomingReveal[], signup: signupOf(v.signup) } : null;
  } catch { return null; }
}

let pending: Promise<Schedule> | null = null;
let pendingAt = 0;

/** One request per page view (re-fetched after a minute for long-lived tabs). Never rejects. */
function loadSchedule(): Promise<Schedule> {
  if (!pending || Date.now() - pendingAt > 60_000) {
    pendingAt = Date.now();
    // An answer that doesn't come in 10s counts as not read (what's on the page stays), and is asked again next time
    const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(10_000) : undefined;
    pending = fetch('/api/reveals', { headers: { Accept: 'application/json' }, signal })
      .then(r => (r.ok ? r.json() : null))
      .then((body: { reveals?: unknown; upcoming?: unknown; signup?: unknown } | null) => {
        if (!body) { pendingAt = 0; return { reveals: [], upcoming: [], signup: null, failed: true }; } // the next ask tries again
        const reveals = Array.isArray(body?.reveals) ? body.reveals as Reveal[] : [];
        const upcoming = Array.isArray(body?.upcoming) ? body.upcoming as UpcomingReveal[] : reveals.map(r => ({ ...r, confirmed: true as const, rooms: [] }));
        return { reveals, upcoming, signup: signupOf(body?.signup) };
      })
      .catch(() => { pendingAt = 0; return { reveals: [], upcoming: [], signup: null, failed: true }; });
  }
  return pending;
}

/** The schedule, or null when it couldn't be read: not knowing isn't the same as nothing planned */
export const readReveals = (): Promise<Reveal[] | null> => loadSchedule().then(s => (s.failed ? null : s.reveals));
export const readUpcoming = (): Promise<UpcomingReveal[] | null> => loadSchedule().then(s => (s.failed ? null : s.upcoming));

/** Whether the every-reveal email sign-up is open, from the same answer as the list (null: unknown, so it stays out) */
export const loadSignup = (): Promise<Signup | null> => loadSchedule().then(s => s.signup);
/** The same, or undefined when the answer couldn't be read: what's on the page stays as it is */
export const readSignup = (): Promise<Signup | null | undefined> => loadSchedule().then(s => (s.failed ? undefined : s.signup));

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

/**
 * The zone a reveal's time is shown in: the visitor's own in the browser (as the live banner and hero show it), and
 * Eastern at build, which can't know the visitor. Pages drawn at build redraw when the two differ (rowsSignature).
 */
export const shownZone = (): string => (typeof window === 'undefined' ? TZ : Intl.DateTimeFormat().resolvedOptions().timeZone || TZ);

/** The day it happens where the visitor is, in any format: once the time is set, a reveal can fall on another day far away */
export const revealDateText = (r: Reveal, opts: Intl.DateTimeFormatOptions, tz = shownZone()) => dayFor(r, tz, opts);
const dayFor = (r: Reveal, tz: string, opts: Intl.DateTimeFormatOptions) => (r.time && r.startsAt
  ? new Date(r.startsAt).toLocaleDateString('en-US', { ...opts, timeZone: tz })
  : dayDate(r).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' }));

/** A date in another year than this one (the timeline then says the year) */
export const otherYear = (r: { date: string }) => r.date.slice(0, 4) !== String(new Date().getFullYear());

/** "Tuesday, October 27" (long) or "Tue, Oct 27" (short) */
export function revealDay(r: Reveal, style: 'long' | 'short' = 'long', tz = shownZone()): string {
  return dayFor(r, tz, style === 'long' ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Oct 27" */
export function revealShortDate(r: Reveal, tz = shownZone()): string {
  return dayFor(r, tz, { month: 'short', day: 'numeric' });
}

/** "4:00 PM EST" (where the visitor is: "1:00 PM PST" in Los Angeles), or '' when no time is set yet */
export function revealTime(r: Reveal, tz = shownZone()): string {
  if (!r.time) return '';
  return new Date(r.startsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
}

/** "Tuesday, October 27 at 4:00 PM EST" / "Tuesday, October 27" */
export function revealWhen(r: Reveal, style: 'long' | 'short' = 'long', tz = shownZone()): string {
  const t = revealTime(r, tz);
  return t ? `${revealDay(r, style, tz)} at ${t}` : revealDay(r, style, tz);
}

/** A one-line reveal date: "Reveal mid November", or "Reveal Tuesday, November 25" once confirmed */
export function revealDateLine(r: UpcomingReveal): string {
  return r.confirmed ? `Reveal ${revealDay(r)}` : `Reveal ${r.window.label}`;
}
