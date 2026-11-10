/**
 * GET /api/printer-ws/ — the Office label printer's own socket (Zebra Cloud Connect)
 * ===========================================================================
 * Public (the printer can't sign in through Cloudflare Access), so it signs in
 * itself: Basic with the user "soard" and the printer's password
 * (functions/api/_kid-print.js), which Zebra's Weblink sends after a 401. Then the
 * socket is handed to the PrintHub Durable Object (workers/live-hub), which
 * prints what the check-in page sends.
 */

import { printerAllowed } from '../_kid-print.js';

export async function onRequestGet({ env, request }) {
  if (!env.DB) return new Response('Not ready', { status: 503 });
  if (!(await printerAllowed(request, env.DB))) {
    return new Response('Sign in', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="SOARD printer"', 'Cache-Control': 'no-store' } });
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
  if (!env.PRINT_HUB) return new Response('The printer hub isn’t set up', { status: 503 });
  const stub = env.PRINT_HUB.get(env.PRINT_HUB.idFromName('office'));
  return stub.fetch(new Request('https://hub/printer', { method: 'GET', headers: request.headers }));
}
