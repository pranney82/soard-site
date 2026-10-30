/**
 * /api/partner-roles-admin — JobTread roles that follow Partners levels
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET              → { roles, noRole, members, view }: SOARD's JobTread roles, their kind and
 *                    permissions, how many people have each, and what the sweep would change or did
 * POST { on: true }      → roles follow levels from the next run (the level roles are made then)
 * POST { on: false }     → stop changing roles; what was changed stays
 * POST { putBack: true } → stop, and every role the site changed goes back to what it was
 * Staff's say for one person (Trade Partner, or leave as is) is POSTed to
 * /api/vendor-access-admin { rolePick }, from Partners → JobTread access.
 *
 * See ./_partner-roles.js.
 */
import { readRoles, rolesView, setOn, putBack } from './_partner-roles.js';
import { logAudit } from './_audit.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
// Never 502: Cloudflare swaps a 502 body for its own error page
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });

export async function onRequestGet({ env }) {
  if (!env.DB) return fail('DB not bound', 500);
  try { return ok({ ...(await readRoles(env)), view: await rolesView(env.DB) }); } catch (e) { return fail(e.message, 500); }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const by = context.data?.userEmail || null;
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  if (body?.putBack === true) {
    try { return ok({ putBack: await putBack(env, by), view: await rolesView(env.DB) }); } catch (e) { return fail(e.message, 500); }
  }
  if (typeof body?.on === 'boolean') {
    await setOn(env.DB, body.on, by);
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'jobtread-roles', entityName: body.on ? 'Roles follow Partners levels' : 'Roles left as they are' });
    return ok({ view: await rolesView(env.DB) });
  }
  return fail('Nothing to do');
}
