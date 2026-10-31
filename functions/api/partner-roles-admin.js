/**
 * /api/partner-roles-admin — JobTread roles that follow Partners levels
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET → { roles, noRole, members, view }: SOARD's JobTread roles, their kind and
 *       permissions, how many people have each, and what the sweep changed or will
 * Roles always follow levels (no switch): staff's say for one person (their
 * partner, Trade Partner, Design Partner, or leave a level) is POSTed to
 * /api/vendor-access-admin { link } or { rolePick }, from Partners → JobTread access.
 *
 * See ./_partner-roles.js.
 */
import { readRoles, rolesView } from './_partner-roles.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
// Never 502: Cloudflare swaps a 502 body for its own error page
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });

export async function onRequestGet({ env }) {
  if (!env.DB) return fail('DB not bound', 500);
  try { return ok({ ...(await readRoles(env)), view: await rolesView(env.DB) }); } catch (e) { return fail(e.message, 500); }
}
