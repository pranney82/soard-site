/**
 * /api/live-messages — messages for the family on the live reveal page
 * =====================================================================
 * GET  (public) → { ok, open, enabled, broadcastId, messages: [{ id, name, body, at }] }
 *                 shown messages for the current reveal, oldest first
 * POST (public) { name, body, clientId, website (honeypot) }
 *               → 200 { ok, status: 'shown', message }
 *                 202 { ok, status: 'held' }        screening unavailable; a person approves it
 *                 422 { ok: false, error }          screening said no
 *                 429 / 409 { ok: false, error }    rate limit, duplicate, or messages closed
 * Screening, limits and the hub relay live in _live-messages.js.
 */

import { listShown, postMessage } from './_live-messages.js';

const noStore = { 'Cache-Control': 'no-store' };

export async function onRequestGet(context) {
  try {
    const r = await listShown(context.env);
    return Response.json(r, { headers: noStore });
  } catch (err) {
    return Response.json({ ok: false, messages: [], error: err.message }, { status: 500, headers: noStore });
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  try {
    const r = await postMessage(env, {
      name: body.name,
      body: body.body,
      clientId: body.clientId,
      hp: body.website,
      ip: request.headers.get('CF-Connecting-IP') || '',
    });
    const { httpStatus, ...out } = r;
    return Response.json(out, { status: httpStatus || 200, headers: noStore });
  } catch (err) {
    return Response.json({ ok: false, error: 'Something went wrong. Please try again.', detail: err.message }, { status: 500, headers: noStore });
  }
}
