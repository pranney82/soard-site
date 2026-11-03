/**
 * /api/kit-quiet-admin — the quiet-subscriber switch in Site Config → Newsletter
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list). The work
 * itself is in ./_kit-quiet.js.
 *
 * GET               → { quiet }  on/off, how many are in the three weeks now,
 *                                stayed, unsubscribed, the store's sending address
 * POST { on: bool } → { quiet }  turn it on or off
 * (Not `status`: the admin's call() puts the HTTP status there.)
 */

import { quietStatus, setQuietOn } from './_kit-quiet.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'private, no-store' } });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });

export async function onRequestGet({ env }) {
  if (!env.DB) return fail('DB not bound', 500);
  try {
    return ok({ quiet: await quietStatus(env) });
  } catch (err) {
    return fail(err.message, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  let body = {};
  try { body = await request.json(); } catch { return fail('Send JSON'); }
  if (typeof body.on !== 'boolean') return fail('Send { on: true | false }');
  try {
    return ok({ quiet: await setQuietOn(env, body.on, context.data?.userEmail) });
  } catch (err) {
    return fail(err.message, 500);
  }
}
