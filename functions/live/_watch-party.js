/**
 * First paint for the live page's watch party
 * ===========================================
 * During a live reveal most viewers arrive at once, from a text, a QR code
 * or Facebook. The page script would lay the page out for the video a
 * moment after load (photo hero → video beside the messages), which shifts
 * everything on screen. functions/live/[[path]].js uses this to lay the
 * page out on the server instead, so the first paint is already right.
 *
 * Mirrors render() in src/components/live/LivePage.astro: keep them in step.
 */

/** Starting-soon screen fills the frame for the last 30 minutes (SLATE_LEAD_MS in LivePage) */
export const SLATE_LEAD_MS = 30 * 60 * 1000;

/**
 * How the page should look at first paint, or null when it is the plain hero.
 * @param pub   publicState() of the broadcast
 * @param opts  { pageKid: kid slug of the page ('' for /live/), kidPublished: the kid's pages are built, now }
 */
export function watchParty(pub, { pageKid = '', kidPublished = false, now = Date.now() } = {}) {
  if (!pub) return null;
  const forThisKid = !pageKid || !pub.kidSlug || pub.kidSlug === pageKid;
  if (!forThisKid) return null;
  const phase = pub.phase;
  const view = phase === 'live' || phase === 'ending' ? 'live' : phase === 'replay' ? 'replay' : phase === 'scheduled' || phase === 'armed' ? 'upcoming' : 'idle';
  const hasPlayer = !!pub.player && (view === 'live' || view === 'replay');
  const startsIn = pub.scheduledAt ? Date.parse(pub.scheduledAt) - now : Infinity;
  const starting = !hasPlayer && view === 'upcoming' && !!(pageKid || pub.kidSlug) && kidPublished && startsIn <= SLATE_LEAD_MS;
  if (!hasPlayer && !starting) return null;
  const mode = starting ? 'starting' : view;
  return {
    mode,
    orientation: pub.orientation === 'landscape' ? 'landscape' : 'portrait',
    eyebrow: mode === 'live' ? 'Live now' : mode === 'replay' ? 'Replay' : 'Starting soon',
  };
}
