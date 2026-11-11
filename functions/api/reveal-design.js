/**
 * GET /api/reveal-design?kid=<slug> — a kid's design for their reveal
 * ====================================================================
 * The starting-soon screen (/live/<kid>/slate/) and the live page ask here
 * for the before photos, drawings and design boards on the kid's profile
 * (public/admin/reveal-design.js has the rules). Public, and it says nothing
 * until the design opens, an hour before the reveal:
 *   { open: false, opensAt }          not yet (opensAt: when, if a time is set)
 *   { open: true, after, name, slides: [...] }  from then on, through the reveal and its replay
 *                                    (after: it has started; the slides say "before", not "today")
 * The profile is read as saved, so a change in Admin → Kids shows on the next
 * ask (the screen asks every few minutes) without waiting for a publish, as
 * the rest of /live/ does. A hidden (draft) or unknown kid is a 404.
 */
import { readState } from './_broadcast.js';
import { cachedReveals } from './_reveals.js';
import { revealSlides, designWindow } from '../../public/admin/reveal-design.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const json = (body, status = 200, maxAge = 30) => Response.json(body, {
  status,
  headers: { 'Cache-Control': `public, max-age=${maxAge}`, 'X-Content-Type-Options': 'nosniff' },
});

/** The kid's reveal from the schedule JobTread keeps: coming up (confirmed), or kept from the last few months */
export function revealOf(schedule, slug) {
  const ahead = (schedule?.upcoming || []).find((r) => r.slug === slug && r.confirmed !== false);
  if (ahead) return { startsAt: ahead.startsAt, confirmed: true };
  const past = (schedule?.past || []).find((r) => r.slug === slug && r.startsAt);
  return past ? { startsAt: past.startsAt, confirmed: true } : null;
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const slug = String(url.searchParams.get('kid') || '').trim().toLowerCase();
  if (!SLUG.test(slug)) return json({ error: 'Which kid?' }, 400, 300);
  if (!env.DB) return json({ error: 'Not available' }, 503, 0);

  let kid = null;
  try {
    const row = await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first();
    kid = row?.data ? JSON.parse(row.data) : null;
  } catch { /* unreadable reads as unknown */ }
  if (!kid || kid.publishStatus === 'draft') return json({ error: 'No such reveal' }, 404, 60);
  kid.slug ||= slug;

  const [broadcast, schedule] = await Promise.all([
    readState(env.DB).catch(() => null),
    cachedReveals(env).catch(() => null),
  ]);
  const now = Date.now();
  const { open, opensAt, after } = designWindow({ kid, reveal: revealOf(schedule, slug), broadcast, now });
  if (!open) {
    // Asked again soon after it opens: the edge copy never outlives the wait
    const wait = opensAt ? Math.max(0, Math.floor((Date.parse(opensAt) - now) / 1000)) : 300;
    return json({ open: false, opensAt }, 200, Math.min(60, wait));
  }
  // after: the reveal has started, so the room is "before", not "today"
  return json({ open: true, after, name: kid.name || '', slides: revealSlides(kid, { after }) });
}
