/**
 * Upcoming reveals as of the build: the public list from the reveals copy
 * the site keeps from JobTread (D1 site_config "reveals"), written to
 * src/data/upcoming-reveals.json by the prebuild (scripts/d1-helpers.js
 * writeUpcomingReveals), for pages that show them on first paint. Pages
 * refresh them live from /api/reveals (./reveals-client.ts). Missing file =
 * nothing coming up.
 */
import type { UpcomingReveal } from './reveals-client';

const files = import.meta.glob<{ upcoming?: UpcomingReveal[]; past?: { slug: string; date: string }[] }>('../data/upcoming-reveals.json', { eager: true, import: 'default' });

/** Upcoming reveals as of the last copy, soonest first */
export function upcomingAtBuild(): UpcomingReveal[] {
  const copy = Object.values(files)[0];
  return Array.isArray(copy?.upcoming) ? copy.upcoming : [];
}

/** Confirmed reveals whose day had passed by the last copy (the last few months), newest first: { slug, date } */
export function pastAtBuild(): { slug: string; date: string }[] {
  const copy = Object.values(files)[0];
  return Array.isArray(copy?.past) ? copy.past : [];
}
