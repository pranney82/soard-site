/**
 * What the floating reveal banner shows and says (LiveIndicator.astro). No page
 * code in here, so tests/live-banner.test.mjs can run it.
 *
 * One banner at a time, for the broadcast the site is following. A planned
 * reveal shows from a week out; live and replay always show. Other confirmed
 * reveals coming up inside that week get named on the banner's second line, so
 * a reveal two days after another still gets its week.
 */
import type { LiveState, ReminderOptions } from './live-client';

export const BANNER_LEAD_DAYS = 7;
const DAY = 86_400_000;
const ENDED_MS = 6 * 3600e3;     // a recording that hasn't come by now isn't "on its way" (REPLAY_WORK_MAX_MS)
const STARTING_MS = 30 * 60_000; // this close, the live page is the starting-soon screen (ARM_WINDOW_MS)
export const RUNNING_LATE_MS = 30 * 60_000; // past the start with no stream for this long, "any moment" has stopped being true
export const runningLate = (iso: string | null | undefined, now = Date.now()) => !!iso && now - Date.parse(iso) > RUNNING_LATE_MS;
const LOCALE = 'en-US';          // the sentences around the dates are English, whatever the browser's language

export type BannerStage = 'upcoming' | 'today' | 'live' | 'ended' | 'replay';
export interface NextReveal { slug: string; name: string; startsAt: string; date?: string; time?: string | null }
type Status = Pick<LiveState, 'id' | 'live' | 'upcoming' | 'replay' | 'kidSlug' | 'kidName' | 'title' | 'message' | 'scheduledAt' | 'endedAt'> & { player?: unknown; source?: string | null };

const midnight = (t: number | string) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
/** Calendar days away, in the viewer's own time zone */
const daysAway = (iso: string, now: number) => Math.round((midnight(iso) - midnight(now)) / DAY);
const clock = (iso: string) => new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
/** Same rule as reveals-client: "Max’s", "James’" */
const possessive = (name: string) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

/**
 * A reveal with no time yet is a date, not a moment (the feed gives it midnight
 * Eastern). Noon UTC lands on that date across the US, and for order it counts
 * as the end of that day, after the day's timed reveals.
 */
const dayIso = (r: NextReveal) => (!r.time && r.date ? `${r.date}T12:00:00Z` : r.startsAt);
const orderAt = (r: NextReveal) => (!r.time && r.date ? Date.parse(`${r.date}T23:59:00-05:00`) : Date.parse(r.startsAt));

/** "today", "tomorrow", "Friday"; a day of the week a week off also says the date */
function dayWords(iso: string, now: number): string {
  const away = daysAway(iso, now);
  if (away === 0) return 'today';
  if (away === 1) return 'tomorrow';
  const opts: Intl.DateTimeFormatOptions = away >= 6 ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'long' };
  return new Intl.DateTimeFormat(LOCALE, opts).format(new Date(iso));
}
const onDay = (iso: string, now: number) => { const d = dayWords(iso, now); return d === 'today' || d === 'tomorrow' ? d : `on ${d}`; };

/** Long enough since it ended that a recording isn't "on its way" any more */
export function replayOverdue(endedAt: string | null | undefined, now = Date.now()): boolean {
  const ended = endedAt ? Date.parse(endedAt) : NaN;
  return Number.isFinite(ended) && now - ended > ENDED_MS;
}

/** Which banner this broadcast gets right now; null = none yet */
export function bannerStage(s: Status | null, now = Date.now()): BannerStage | null {
  if (!s) return null;
  if (s.live) return 'live';
  if (s.replay) {
    if (s.player) return 'replay';
    return replayOverdue(s.endedAt, now) ? null : 'ended'; // over, with no recording to watch yet
  }
  if (!s.upcoming) return null;
  if (!s.scheduledAt) return 'upcoming';
  const at = Date.parse(s.scheduledAt);
  if (!Number.isFinite(at)) return 'upcoming';
  if (at <= now || daysAway(s.scheduledAt, now) === 0) return 'today';
  return at - now > BANNER_LEAD_DAYS * DAY ? null : 'upcoming';
}

/** Other confirmed reveals to name: inside the week, from this one on, soonest first */
export function revealsAfter(s: Status, reveals: NextReveal[], now = Date.now()): NextReveal[] {
  const from = Math.max(now, s.upcoming && s.scheduledAt ? Date.parse(s.scheduledAt) : now);
  return reveals
    .filter((r) => r.slug !== s.kidSlug && r.startsAt && orderAt(r) >= from && orderAt(r) - now <= BANNER_LEAD_DAYS * DAY)
    .sort((a, b) => orderAt(a) - orderAt(b));
}

/** "Then Max’s on Friday." / "Then Max’s on Friday and Colin’s on Saturday." / "Then 3 more after that." */
function thenLine(s: Status, next: NextReveal[], now: number): string {
  if (!next.length) return '';
  if (next.length > 2) return `Then ${next.length} more after that.`;
  const say = (r: NextReveal) => {
    const sameDay = s.scheduledAt && daysAway(dayIso(r), now) === daysAway(s.scheduledAt, now);
    return `${possessive(r.name)} ${sameDay && r.time ? `at ${clock(r.startsAt)}` : onDay(dayIso(r), now)}`;
  };
  const together = s.scheduledAt && Date.parse(next[0].startsAt) === Date.parse(s.scheduledAt);
  return `${together ? 'Also' : 'Then'} ${next.map(say).join(' and ')}.`;
}

/** "Next: Max’s on Friday at 4:00 PM." with "and 1 more" past the first */
function nextLine(next: NextReveal[], now: number): string {
  if (!next.length) return '';
  const r = next[0];
  const more = next.length > 1 ? ` and ${next.length - 1} more` : '';
  return `Next: ${possessive(r.name)} ${onDay(dayIso(r), now)}${r.time ? ` at ${clock(r.startsAt)}` : ''}${more}.`;
}

/** anchor: where on the page the button's words are kept, so "Remind me" lands on the form */
export interface BannerWords { label: string; msg: string; next: string; cta: string; aria: string; anchor: string }

const words = (label: string, msg: string, next: string, cta: string, anchor = ''): BannerWords => ({
  label, msg, next, cta, anchor,
  // Starts with what's on screen, so voice control can match it
  aria: [`${label}.`, msg, next, `${cta.replace(' →', '')}.`].filter(Boolean).join(' '),
});

export function bannerWords(s: Status, stage: BannerStage, next: NextReveal[], { now = Date.now(), remindersOn = false } = {}): BannerWords {
  const who = s.kidName ? `${possessive(s.kidName)} room reveal` : (s.title || 'Live room reveal');
  if (stage === 'live') return words('Live now', s.message || who, '', 'Watch →');
  if (stage === 'ended') return words('Just ended', `${who} just ended.${s.source === 'stream' ? ' The replay is on its way.' : ''}`, nextLine(next, now), 'Details →');
  if (stage === 'replay') return words('Replay ready', `Missed ${s.kidName ? possessive(s.kidName) : 'the'} reveal? Watch it any time.`, nextLine(next, now), 'Watch →');
  const at = s.scheduledAt ? Date.parse(s.scheduledAt) : NaN;
  const when = s.scheduledAt && Number.isFinite(at) ? ` goes live ${dayWords(s.scheduledAt, now)} at ${clock(s.scheduledAt)}` : '';
  // Past its start and still waiting on the stream: a time in the past reads as a mistake
  const msg = !(at <= now) ? `${who}${when}.` : runningLate(s.scheduledAt, now) ? `${who} is running a little late.` : `${who} is starting soon.`;
  // The button says what the page it opens really offers; this close, that page is the starting-soon screen
  const starting = at - now <= STARTING_MS;
  const cta = starting ? 'Watch →' : remindersOn ? 'Remind me →' : 'Add to calendar →';
  return words(stage === 'today' ? 'Reveal day' : 'Coming up', msg, thenLine(s, next, now), cta, starting ? '' : '#remind');
}

/** Reminders only count as on when there's a way to sign up for them */
export const remindersUsable = (r: ReminderOptions | null | undefined, canPush = true) => !!r?.enabled && !!(r.email || (r.push && r.pushKey && canPush));

/** Can this browser take alerts at all? */
export const browserCanPush = () => typeof window !== 'undefined' && 'PushManager' in window && 'serviceWorker' in navigator
  && typeof Notification !== 'undefined' && Notification.permission !== 'denied';

/**
 * What a reminder sign-up will hear, worded as the confirm email words it (reminderPlan in _broadcast-notify.js),
 * from the hours Reveals → Settings has. about: "every reveal" (the band's card and the /live/ form), or
 * "Colin’s reveal". Only what can still be sent: a reveal with its day doesn't "get a date", and ten minutes
 * out there's no "day before".
 */
export function remindPromise(hours: number[] = [24, 1], { about = 'every reveal', dated = false, left = Infinity } = {}): string {
  const notes = [!dated && 'when it gets a date', left > 24 * 3600_000 && hours.includes(24) && 'the day before', left > 3600_000 && hours.includes(1) && 'an hour before', 'when we go live'].filter(Boolean);
  // A comma before "and" only in a list of three or more
  return `We'll email you about ${about}: ${notes.join(', ')}${notes.length > 1 ? ',' : ''} and when the replay is up. Nothing else, ever.`;
}

/** Today in Eastern, as the schedule's dates are written */
export const easternDay = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(now));

/** A stream with no kid named counts as this kid's only on the day of this kid's reveal */
export const revealIsToday = (slug: string, reveals: { slug: string; date?: string }[], now = Date.now()) =>
  reveals.some((r) => r.slug === slug && r.date === easternDay(now));

/** /live/, the reveal's own /live page and its starting-soon screen already show it; another kid's page doesn't */
export function pageShowsIt(path: string, kidSlug: string | null | undefined, reveals: { slug: string; date?: string }[] = [], now = Date.now()): boolean {
  const [root, kid, more] = path.split('/').filter(Boolean);
  if (root !== 'live') return false;
  return !kid || !!more || kid === kidSlug || (!kidSlug && revealIsToday(kid, reveals, now));
}

/**
 * Closing a banner closes that news, not the reveal: a countdown closed last
 * week comes back on the day, and closing one never hides "Live now".
 */
export const dismissValue = (s: Pick<Status, 'id'>, stage: BannerStage) => `${s.id}:${stage}`;

/** What a banner must never sit on: anything you can press or type in, any video, and the answer a form just gave */
export const MAIN_CONTROLS = [
  'button', 'summary', '[role="button"]', '.btn', 'a[class*="btn"]', 'a[class*="cta"]', '.pstrip__link', '.ps__link', '.upn-act', '.upn-card',
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])', 'select', 'textarea', 'footer a', 'video', 'iframe',
  '[role="status"]:not(:empty)',
].join(',');
export const PICTURES = 'video,iframe'; // not even a sliver of these

export interface Box { left: number; top: number; right: number; bottom: number }

/** Do two boxes overlap by more than a sliver each way? Brushing a button's edge doesn't count */
export function sitsOn(a: Box, b: Box, slack = 8): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > slack
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > slack;
}
