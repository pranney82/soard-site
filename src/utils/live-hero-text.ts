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

/** The hero's lead when no reveal is set (LivePage.astro); /live/'s share card says the same */
export const LIVE_GENERIC_LEAD = 'Room reveals stream live right here. Watch the moment a child sees their new room for the first time.';

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

// ── The hero's buttons ──────────────────────────────────────────────

/**
 * The hero offers two things at most (Peter, Nov 9 2026: five was too many). Each moment lists its buttons in order of
 * what matters most then; the first two that apply show, in that order, and the rest wait. During the watch party the
 * message box is already in the hero, so "Leave a message" only applies around it.
 */
export const HERO_CTAS: Record<string, string[]> = {
  idle: ['cta-remind', 'cta-calendar', 'cta-past', 'cta-share', 'cta-donate'],
  upcoming: ['cta-remind', 'cta-calendar', 'cta-share', 'cta-donate'],
  starting: ['cta-facebook', 'cta-messages', 'cta-donate', 'cta-share'],
  live: ['cta-facebook', 'cta-messages', 'cta-donate', 'cta-share'],
  replay: ['cta-facebook', 'cta-share', 'cta-donate', 'cta-messages'],
};
export const HERO_CTA_MAX = 2;

export interface CtaFacts {
  /** What the hero shows: idle, upcoming, starting, live, replay */
  display: string;
  /** The broadcast's own view of this page: idle, upcoming, live, replay */
  view: string;
  scheduledAt: string | null;
  /** Reveal emails (or this browser's alerts) can be signed up for */
  remindUsable: boolean;
  pageKid: string;
  /** This child's reveal is in the schedule (their own calendar invite) */
  inSchedule: boolean;
  /** The page has past reveals to jump to */
  pastOnPage: boolean;
  hasPlayer: boolean;
  now?: number;
}

/** Which of the hero's buttons apply now (cta-messages is the message box's own; cta-donate always applies) */
export function ctasThatApply(f: CtaFacts): Record<string, boolean> {
  const now = f.now ?? Date.now();
  const begun = !!f.scheduledAt && Date.parse(f.scheduledAt) <= now;
  return {
    // Reminders stop making sense once the reveal's time has come
    'cta-remind': (f.display === 'upcoming' || f.display === 'idle') && !(f.view === 'upcoming' && begun) && f.remindUsable,
    // This child's own invite, or the broadcast's file when a scheduled reveal isn't in the list
    'cta-calendar': (f.display === 'upcoming' && !begun) || (f.display === 'idle' && !!f.pageKid && f.inSchedule),
    'cta-past': f.view === 'idle' && f.pastOnPage,
    'cta-share': f.view !== 'idle',
    'cta-facebook': (f.view === 'live' || f.view === 'replay') && !f.hasPlayer,
    'cta-donate': true,
  };
}

/** The buttons shown, in order: the first HERO_CTA_MAX for the moment of those that apply */
export function ctaPicks(display: string, applies: (key: string) => boolean): string[] {
  return (HERO_CTAS[display] || HERO_CTAS.idle).filter(applies).slice(0, HERO_CTA_MAX);
}
