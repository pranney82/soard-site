/**
 * POST /api/broadcast-hooks — heartbeat from the real-time hub
 * =============================================================
 * The soard-live-hub Durable Object calls this every few seconds with a
 * one-time nonce in X-Hub-Nonce. We verify the nonce back over the private
 * LIVE_HUB binding (only this Pages project can reach it), run a tick, and
 * return the public state; the hub pushes it to every open socket if it
 * changed. No shared secret exists anywhere.
 */

import { runTick, verifyHubNonce } from './_broadcast.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const nonce = request.headers.get('x-hub-nonce');
  if (!env.LIVE_HUB) return Response.json({ ok: false, error: 'LIVE_HUB binding missing' }, { status: 503 });
  if (!(await verifyHubNonce(env, nonce))) return Response.json({ ok: false, error: 'invalid nonce' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  try {
    const r = await runTick(env, { source: body.source ? `hub:${body.source}` : 'hub', force: !!body.force });
    return Response.json({ ok: true, state: r.state, reason: r.reason, work: r.work, changed: r.changed, cached: !!r.cached });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'broadcast-hooks', method: 'POST' });
}
