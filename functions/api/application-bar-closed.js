/**
 * GET /api/application-bar-closed?year=2027 (public): the application bar's X.
 * Sets a cookie for the season so the server leaves the bar out of every page
 * this visitor loads (../_apply-bar.js). The page also remembers it in the
 * browser; this is the copy that lasts (Safari clears what page scripts write
 * after a week, not a cookie the server sets).
 */

import { cleanYear } from './_applications.js';
import { BAR_COOKIE } from '../_apply-bar.js';

const YEAR_S = 365 * 24 * 3600;

export async function onRequestGet({ request }) {
  const asked = new URL(request.url).searchParams.get('year') || '';
  const year = cleanYear(asked);
  if (asked !== year) return new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  return new Response(null, {
    status: 204,
    headers: {
      'Set-Cookie': `${BAR_COOKIE}=${year}; Path=/; Max-Age=${YEAR_S}; SameSite=Lax; Secure`,
      'Cache-Control': 'no-store',
    },
  });
}
