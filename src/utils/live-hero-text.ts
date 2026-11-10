/**
 * live-hero-text.ts — what the live page's hero says before a reveal
 * ===================================================================
 * The eyebrow and status line while a reveal is planned ("Coming up" / "We go
 * live Wednesday, November 18 at 4:00 PM EST, in 8 days."), and between
 * reveals ("Max's reveal is Friday, November 20 at 4:00 PM EST."). The page
 * script (LivePage.astro) and the server (functions/live/[[path]].js, which
 * writes them into the page before it goes out) both use these, so the hero
 * says the same thing from the first paint and nothing moves when the script
 * takes over. tz left out: the browser's own zone.
 */
import { formatWhen, relativeUntil, revealLabel } from './live-when';
import { runningLate } from './live-banner';
import { revealWhen, type UpcomingReveal } from './reveals-client';

/** A planned reveal, before its starting-soon screen → { eyebrow, status } */
export function plannedText(scheduledAt: string | null, tz?: string, now = Date.now()) {
  const rel = relativeUntil(scheduledAt, now, tz);
  return {
    eyebrow: revealLabel(scheduledAt, tz, now),
    status: !scheduledAt ? 'A reveal is on the calendar.'
      : Date.parse(scheduledAt) > now ? `We go live ${formatWhen(scheduledAt, tz, now)}${rel ? `, ${rel}` : ''}.`
      : runningLate(scheduledAt, now) ? 'We’re running a little late. Stay right here.' : 'Any moment now. Stay right here.',
  };
}

/** Between reveals: a child's page names their own reveal, /live/ the next one ('' when the schedule has nothing to say) */
export function betweenText(upcoming: UpcomingReveal[], pageKid: string, tz?: string): string {
  if (pageKid) {
    const mine = upcoming.find((r) => r.slug === pageKid);
    if (!mine) return '';
    return mine.confirmed
      ? `${mine.name}'s reveal is ${revealWhen(mine, 'long', tz)}.`
      : `${mine.name}'s reveal is planned for ${mine.window.label}. The exact day and time go up here as soon as they're set.`;
  }
  const next = upcoming[0];
  return next ? `Next up: ${next.name}'s reveal, ${next.confirmed ? revealWhen(next, 'long', tz) : next.window.label}.` : '';
}
