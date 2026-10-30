/**
 * /api/partner-roles-admin — JobTread roles that follow Partners levels
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET → { roles, noRole, members }: SOARD's JobTread roles, their kind and
 *       permissions, and how many people have each. Read-only.
 *
 * See ./_partner-roles.js.
 */
import { readRoles } from './_partner-roles.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
// Never 502: Cloudflare swaps a 502 body for its own error page
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });

export async function onRequestGet({ env }) {
  try { return ok(await readRoles(env)); } catch (e) { return fail(e.message, 500); }
}
