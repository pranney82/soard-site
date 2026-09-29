/**
 * /api/broadcast — public state + admin commands
 * ================================================
 * GET  (public)  → { state, reminders, timezone, hub }  see _broadcast.publicPayload
 *                  Every public GET also piggybacks a throttled tick in
 *                  waitUntil, so the state machine keeps moving even if the
 *                  real-time hub is ever down (the same trick live-status
 *                  used for the archive sweep).
 * POST (Access)  → { action, ... }  schedule | update | cancel | goLiveManual |
 *                  endNow | clearReplay | extendReplay | setReplay | reset
 */

import { publicPayload, adminAction, runTick } from './_broadcast.js';

export async function onRequestGet(context) {
  const { env } = context;
  try {
    context.waitUntil(runTick(env, { source: 'visitor', minIntervalMs: 20000 }).catch(() => {}));
    const payload = await publicPayload(env);
    return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json({ state: null, error: err.message }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  let body = {};
  try { body = await context.request.json(); } catch { /* empty */ }
  try {
    const r = await adminAction(env, body.action, body, context.data?.userEmail || 'unknown');
    return Response.json(r, { status: r.success ? 200 : (r.status || 400) });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
