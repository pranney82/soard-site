/**
 * Confirmed reveal dates for public pages (kid pages, events page).
 * Data comes from /api/reveals, which reads JobTread; see
 * functions/api/_reveals.js. Only confirmed reveals are ever returned.
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

const TZ = 'America/New_York';
let pending: Promise<Reveal[]> | null = null;
let pendingAt = 0;

/** One request per page view (re-fetched after a minute for long-lived tabs). Never rejects. */
export function loadReveals(): Promise<Reveal[]> {
  if (!pending || Date.now() - pendingAt > 60_000) {
    pendingAt = Date.now();
    pending = fetch('/api/reveals', { headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : { reveals: [] }))
      .then(body => (Array.isArray(body?.reveals) ? body.reveals as Reveal[] : []))
      .catch(() => []);
  }
  return pending;
}

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

/** Google Calendar link for watching online: the event's location is the live page */
export function revealCalendarUrl(r: Reveal, origin = location.origin): string {
  const live = new URL(r.liveUrl, origin).toString();
  const compact = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  let dates: string;
  if (r.time) {
    const start = new Date(r.startsAt);
    dates = `${compact(start)}/${compact(new Date(start.getTime() + 60 * 60 * 1000))}`;
  } else {
    const next = new Date(dayDate(r).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    dates = `${r.date.replace(/-/g, '')}/${next.replace(/-/g, '')}`;
  }
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${r.name}'s Room Reveal (watch live)`,
    dates,
    details: `Watch ${r.name} see the finished room for the first time: ${live}`,
    location: live,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
