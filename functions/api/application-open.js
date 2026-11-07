/**
 * GET /api/application-open (public): is the family application open right now?
 * The application bar's page script reads this (ApplicationBar.astro), so a page
 * left open drops the bar when the season closes. New pages get it from the
 * server already (../_apply-bar.js), from the same cached answer.
 *
 * → { open: true, year: '2027' }
 *
 * Only those two fields ever leave here. The edge keeps the answer 30 seconds, so the
 * database is read about twice a minute however busy it gets. Closing by hand, at the
 * close date (the heartbeat, every minute) or at the application limit all turn the
 * same switch off.
 */

import { applicationState } from '../_apply-bar.js';

export async function onRequestGet(context) {
  let state;
  try { state = await applicationState(context); } catch {
    // Not knowing isn't "closed": the page keeps its bar and asks again
    return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json({ open: state.open, year: state.year }, { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=30' } });
}
