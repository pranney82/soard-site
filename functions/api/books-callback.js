/**
 * /api/books-callback (public, GET only) — where Intuit sends a Board admin back after "Connect QuickBooks" in
 * Board → Settings (./_quickbooks.js). Public because it's Intuit's redirect: the one-time state Settings made
 * (used once, within 15 minutes) is the proof the sign-in started there, and the code is useless without
 * SOARD's keys. Always back to Settings, saying how it went (?books=connected|declined|expired|failed).
 */

import { finishConnect } from './_quickbooks.js';
import { logAudit } from './_audit.js';
import { SITE_ORIGIN } from './_broadcast-notify.js';

const back = (result) => new Response(null, { status: 302, headers: { Location: `${SITE_ORIGIN}/admin/?books=${result}#board/settings`, 'Cache-Control': 'no-store' } });

export async function onRequestGet({ env, request }) {
  const q = new URL(request.url).searchParams;
  // The admin pressed Cancel on Intuit's page, or Intuit refused
  if (q.get('error')) return back(q.get('error') === 'access_denied' ? 'declined' : 'failed');
  try {
    const { company, by } = await finishConnect(env, { code: q.get('code'), state: q.get('state'), realmId: q.get('realmId') });
    await logAudit(env.DB, { userEmail: by, action: 'created', entityType: 'board', entitySlug: 'quickbooks', entityName: `QuickBooks connected for the board page: ${company}`, gitStatus: 'ok' }).catch(() => {});
    return back('connected');
  } catch (err) {
    console.error('[books] connect', err.code || '', err.message, err.tid ? `intuit_tid ${err.tid}` : '');
    return back(err.code === 'STATE' ? 'expired' : 'failed');
  }
}
