/**
 * /api/live-messages — messages for the family on the live reveal page
 * =====================================================================
 * GET  (public) → { ok, open, enabled, broadcastId, messages: [{ id, name, body, at }] }
 *                 shown messages for the current reveal, oldest first
 * POST (public, from our own pages only) { name, body, website (honeypot) }
 *               → 200 { ok, status: 'shown', message }
 *                 202 { ok, status: 'held' }        a person approves it first
 *                 403 { ok: false, error }          posted from another site
 *                 422 { ok: false, error }          screening said no
 *                 429 / 409 { ok: false, error }    rate limit, duplicate, or messages closed
 * Who posted is a random id this endpoint sets as an HttpOnly cookie on the
 * first post (a clientId the browser sends is ignored), plus the address.
 * Screening, limits and the hub relay live in _live-messages.js.
 */

import { listShown, postMessage } from './_live-messages.js';
import { crossSiteChange } from './_origin-guard.js';
import { clientIp } from './_secure.js';
import { b64u, SITE_ORIGIN } from './_broadcast-notify.js';

const noStore = { 'Cache-Control': 'no-store' };
const VISITOR_COOKIE = 'soard_live_visitor';
const VISITOR_MAX_AGE = 180 * 24 * 3600;

/** The visitor id this endpoint set earlier, or null */
export function visitorFrom(request) {
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)soard_live_visitor=([A-Za-z0-9_-]{16,64})(?:;|$)/);
  return m ? m[1] : null;
}

export function visitorCookie(id) {
  return `${VISITOR_COOKIE}=${id}; Path=/api/live-messages; Max-Age=${VISITOR_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

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
  // Notes come from the reveal page itself, never a form or script on another site
  if (crossSiteChange(request, [SITE_ORIGIN])) {
    return Response.json({ ok: false, error: 'Please post from the reveal page on our site.' }, { status: 403, headers: noStore });
  }
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  if (!body || typeof body !== 'object') body = {};
  const known = visitorFrom(request);
  const visitorId = known || b64u.encode(crypto.getRandomValues(new Uint8Array(18)));
  const headers = { ...noStore, ...(known ? {} : { 'Set-Cookie': visitorCookie(visitorId) }) };
  try {
    const r = await postMessage(env, {
      name: body.name,
      body: body.body,
      visitorId,
      newVisitor: !known,
      hp: body.website,
      ip: request.headers.get('CF-Connecting-IP') ? clientIp(request) : '',
    });
    const { httpStatus, ...out } = r;
    return Response.json(out, { status: httpStatus || 200, headers });
  } catch (err) {
    return Response.json({ ok: false, error: 'Something went wrong. Please try again.', detail: err.message }, { status: 500, headers });
  }
}
