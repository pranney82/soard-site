/**
 * GET /api/reveals (public) — upcoming reveals for the kid pages, the events
 * page, the live page's "Coming up" list and the starting-soon screen. See
 * ./_reveals.js for where the dates come from and what may be shown.
 *
 * → { reveals: [{ slug, name, startsAt, date, time, image, kidUrl, liveUrl }],   confirmed only
 *     upcoming: [{ slug, name, confirmed, image, rooms, kidUrl, liveUrl,
 *                  startsAt, date, time  (confirmed) | window (tentative) }],
 *     signup: { email, hours } | null,
 *     updatedAt, source: 'jobtread' | 'cache' | 'none', error? }
 *
 * signup: whether a visitor can sign up for every reveal by email right now
 * (Reveals → Settings has reminders on and email can go out), and the notes
 * they'd get. The Coming up band's email card reads it from this same answer,
 * so it opens complete, with no second request to wait on.
 *
 * Cached at the edge for EDGE_TTL seconds so visitors never wait on JobTread;
 * a reveal confirmed in JobTread shows up within a few minutes, no deploy.
 */

import { getReveals } from './_reveals.js';
import { maybeSweep, maybeCheckGuests } from './_reveal-invites.js';
import { maybeNudge } from './_reveal-nudges.js';
import { syncBroadcastSchedule } from './_broadcast-schedule.js';
import { maybeSyncKidStatuses } from './_kid-status.js';
import { maybeSyncKidPartners } from './_kid-partners.js';
import { readConfig } from './_broadcast.js';
import { emailConfigured } from './_broadcast-notify.js';

const EDGE_TTL = 180;
const BROWSER_TTL = 60;

/** The every-reveal email sign-up: open or not, and its notes (the hours before). null when the settings can't be read. */
export async function signupFacts(env) {
  try {
    const config = await readConfig(env.DB);
    const hours = Array.isArray(config.reminders?.hoursBefore) ? config.reminders.hoursBefore.filter((h) => h === 24 || h === 1) : [24, 1];
    return { email: !!config.reminders?.enabled && emailConfigured(env), hours };
  } catch {
    return null;
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL('/api/reveals', request.url).toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  // The past reveals kept for the calendar feed aren't for pages
  const [{ past: _past, ...schedule }, signup] = await Promise.all([getReveals(env), signupFacts(env)]);
  const body = { ...schedule, signup };
  // Reveal invites safety net: re-check every open job every few hours, after
  // the response, so a missed JobTread webhook can't leave an invite stale
  context.waitUntil(maybeSweep(env));
  // New guests on a reveal whose invite is out (backup for the hub's heartbeat)
  context.waitUntil(maybeCheckGuests(env));
  // Weekday reveal checks for Project Managers, first request after 8 AM Eastern
  context.waitUntil(maybeNudge(env));
  // The live countdown follows JobTread's next confirmed reveal (backup for the hub's heartbeat)
  context.waitUntil(syncBroadcastSchedule(env));
  context.waitUntil(maybeSyncKidStatuses(env));
  // Vendor and Sponsor logos on kid pages (backup for the hub's heartbeat)
  context.waitUntil(maybeSyncKidPartners(env));
  // Only a fresh read is worth holding for the full TTL; a fallback gets a short one
  const ttl = body.source === 'jobtread' ? EDGE_TTL : 30;
  const res = Response.json(body, {
    headers: {
      'Cache-Control': `public, max-age=${Math.min(BROWSER_TTL, ttl)}, s-maxage=${ttl}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
  if (cache) context.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}
