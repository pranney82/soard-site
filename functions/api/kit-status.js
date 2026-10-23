/**
 * GET /api/kit-status → { ok, configured }
 *
 * Whether KIT_API_KEY is set, for Site Config → Newsletter. No Kit API call.
 * Newsletters are written and sent in Kit itself; the site only adds signups
 * and makes the reveal drafts. Behind Cloudflare Access like every admin route.
 */

import { kitConfigured } from './_kit.js';

export async function onRequestGet({ env }) {
  return Response.json({ ok: true, configured: kitConfigured(env) }, { headers: { 'Cache-Control': 'private, no-store' } });
}
