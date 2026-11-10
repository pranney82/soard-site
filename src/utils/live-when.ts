/**
 * live-when.ts — the live page's time words, in any zone
 * =======================================================
 * "Wednesday, November 18 at 4:00 PM EST", "in 8 days", "Reveal day". The
 * live page writes them in the viewer's own zone (tz left out: the browser's);
 * the server writes the same words into the page before it goes out, in the
 * zone Cloudflare places the visitor in (functions/live/[[path]].js), so
 * nothing changes when the page script takes over. Plain functions, nothing
 * of the browser's.
 */

/** The calendar day of a moment in a zone, as "2026-11-18" (tz undefined: the browser's own zone) */
const dayKey = (t: number, tz?: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const dayNumber = (t: number, tz?: string) => Date.parse(`${dayKey(t, tz)}T00:00:00Z`) / 86_400_000;

/** "in 2 days", "in 3 hours", "in 12 minutes", "any minute now", "" once passed */
export function relativeUntil(iso: string | null, now = Date.now(), tz?: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 60_000) return ms > -10 * 60_000 ? 'any minute now' : '';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} minute${min === 1 ? '' : 's'}`;
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 36) return `in ${hrs} hour${hrs === 1 ? '' : 's'}`;
  // Calendar days, so it agrees with the day named beside it
  const days = Math.round(dayNumber(Date.parse(iso), tz) - dayNumber(now, tz));
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/** The heading over a planned reveal: "Reveal day" only on the day itself */
export function revealLabel(iso: string | null, tz?: string, now = Date.now()): string {
  return iso && dayKey(Date.parse(iso), tz) === dayKey(now, tz) ? 'Reveal day' : 'Coming up';
}

/** "today at 4:00 PM EST", "tomorrow at …", "Wednesday, November 18 at …" */
export function formatWhen(iso: string | null, tz?: string, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  const days = Math.round(dayNumber(t, tz) - dayNumber(now, tz));
  // English sentences, whatever the browser's language. The zone says these are the viewer's own hours; the emails are in Eastern.
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(t);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(t);
  return `${day} at ${time}`;
}
