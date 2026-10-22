/**
 * Upcoming reveals as of the build: the public list from the reveals copy
 * the site keeps from JobTread (D1 site_config "reveals"), written to
 * src/data/upcoming-reveals.json by the prebuild (scripts/d1-helpers.js
 * writeUpcomingReveals), for pages that show them on first paint. Pages
 * refresh them live from /api/reveals (./reveals-client.ts). Missing file =
 * nothing coming up.
 */
import type { UpcomingReveal } from './reveals-client';

const files = import.meta.glob<{ upcoming?: UpcomingReveal[] }>('../data/upcoming-reveals.json', { eager: true, import: 'default' });

/** Upcoming reveals as of the last copy, soonest first */
export function upcomingAtBuild(): UpcomingReveal[] {
  const copy = Object.values(files)[0];
  return Array.isArray(copy?.upcoming) ? copy.upcoming : [];
}
