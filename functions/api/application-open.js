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
  const { open, year } = await applicationState(context);
  return Response.json({ open, year }, { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=30' } });
}
