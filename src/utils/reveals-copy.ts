/**
 * The reveals the site keeps from JobTread (D1 site_config "reveals", pulled
 * into src/content/site/reveals.json before the build), for pages that pick
 * something at build time. Pages that show dates also refresh them live from
 * /api/reveals (see ./reveals-client.ts). Missing file = nothing coming up.
 */
import type { UpcomingReveal } from './reveals-client';

const files = import.meta.glob<{ upcoming?: UpcomingReveal[] }>('../content/site/reveals.json', { eager: true, import: 'default' });

/** Upcoming reveals as of the last copy, soonest first */
export function upcomingAtBuild(): UpcomingReveal[] {
  const copy = Object.values(files)[0];
  return Array.isArray(copy?.upcoming) ? copy.upcoming : [];
}
