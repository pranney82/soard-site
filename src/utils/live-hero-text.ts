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
import { runningLate, remindersUsable, remindPromise } from './live-banner';
import { revealWhen, type UpcomingReveal } from './reveals-client';
import type { ReminderOptions } from './live-client';

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

// ── The reminder block (#remind) ────────────────────────────────────

export interface RemindFacts {
  /** The reminder options as /api/broadcast gives them (null: not known) */
  reminders: ReminderOptions | null;
  /** Whether this browser can take alerts (the server takes it as possible, as for the hero's buttons) */
  canPush: boolean;
  /** What the page shows: 'upcoming' (a reveal planned), 'idle' (between reveals), 'live', 'replay' */
  view: string;
  /** The child whose page this is ('' on /live/) */
  pageKid: string;
  /** The broadcast: when, and whose */
  scheduledAt: string | null;
  kidName: string;
  kidSlug: string;
  /** This page's child in the schedule (a child's page between reveals), for their day */
  inviteFor?: Pick<UpcomingReveal, 'name' | 'startsAt'>;
  now?: number;
}

/**
 * Which parts of the reminder block show, by the facts alone: reminders that really go out (email, or alerts this
 * browser can take), the calendar link while there's a date to add, and the child the block names. LivePage draws
 * the block by this, and the server (functions/live/[[path]].js) writes it into the page the same way, so the block
 * is there from the first paint and a link to #remind lands on it.
 */
export function remindParts(f: RemindFacts) {
  const now = f.now ?? Date.now();
  const on = remindersUsable(f.reminders, f.canPush);
  const begun = !!f.scheduledAt && Date.parse(f.scheduledAt) <= now;
  const calendar = (f.view === 'upcoming' && !begun) || (f.view === 'idle' && !!f.pageKid && !!f.inviteFor);
  // A sign-up is for the reveal the block names, and otherwise for every reveal
  const name = (f.view === 'upcoming' ? f.kidName : f.view === 'idle' && f.pageKid ? f.inviteFor?.name : '') || '';
  return {
    on,
    email: on && !!f.reminders?.email,
    push: on && !!f.reminders?.push && !!f.reminders?.pushKey && f.canPush,
    calendar,
    // Reminders off: the block is just the calendar link, or nothing when there's no date to add
    block: on || calendar,
    label: on ? 'Reminders' : 'Calendar',
    /** The child the block names, and their slug ('' : every reveal) */
    name,
    slug: !name ? '' : f.view === 'upcoming' ? f.kidSlug || '' : f.pageKid,
    /** When the named reveal is: only what can still be sent is promised (ten minutes out there's no "day before") */
    planned: (f.view === 'upcoming' ? f.scheduledAt : f.view === 'idle' && f.pageKid ? f.inviteFor?.startsAt : null) || null,
  };
}

/**
 * The block's words for the child it names (shown: their name, '' for none) and the reveals picked ('one': just
 * theirs). On first paint the block names remindParts' child with every reveal picked; the page script keeps
 * whatever someone mid-sign-up chose.
 */
export function remindWords(parts: ReturnType<typeof remindParts>, { shown, scope, hours, view, now = Date.now() }: { shown: string; scope: 'all' | 'one'; hours?: number[]; view: string; now?: number }) {
  const one = !!shown && scope === 'one';
  return {
    heading: shown
      ? (parts.on ? `Don't miss ${shown}'s reveal` : `Save the date for ${shown}'s reveal`)
      : !parts.on ? 'Save the date' : view === 'replay' ? 'Hear about the next reveal' : 'Never miss a reveal',
    /** Which reveals: asked only when the block names a child and the form shows */
    scopeShown: !!shown && parts.email,
    scopeOne: shown ? `Just ${shown}'s` : '',
    emailLabel: one ? `Email address for ${shown}'s reveal` : 'Email address for every reveal',
    scope: (one ? 'one' : 'all') as 'one' | 'all',
    // Both promises are written, and the one for the choice shows: the block keeps the taller one's height
    leadAll: remindPromise(hours, { about: shown ? `every reveal, ${shown}'s included` : 'every reveal' }),
    leadOne: shown ? remindPromise(hours, { about: `${shown}'s reveal`, dated: !!parts.planned, left: parts.planned ? Date.parse(parts.planned) - now : Infinity }) : '',
    /** This form already signs up for every reveal: the Coming up band leaves its email card out */
    remindHere: parts.email && !one,
  };
}
