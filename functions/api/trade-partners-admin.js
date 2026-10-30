/**
 * /api/trade-partners-admin — clearing up after a live test of /trade-partners/
 * ===========================================================================
 * Behind Cloudflare Access like every admin route; a change must come from the
 * admin itself (_middleware.js). No button calls it: whoever ran the test calls
 * it from the signed-in admin. Only companies named "TEST …" are ever touched
 * (./_trade-partners.js isTestCompany), and each is read again before anything goes.
 *
 * GET                                            → { success, tests: [{ jtId, name, archived, payees }] }
 * POST { action: 'remove-tests', jtIds: [...] }  → { success, removed: [{ jtId, name, payees, jobtread }] }
 */
import { testPartners, removeTestPartners } from './_trade-partners.js';

const headers = { 'Cache-Control': 'no-store' };
const ok = (body = {}) => Response.json({ success: true, ...body }, { headers });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status, headers });

export async function onRequestGet({ env }) {
  try {
    return ok({ tests: await testPartners(env) });
  } catch (e) {
    console.error('[trade-partners-admin] get', e.message);
    return fail(e.message || 'Couldn’t read JobTread just now', 500);
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  let b;
  try { b = await context.request.json(); } catch { return fail('Send that again'); }
  if (b.action !== 'remove-tests') return fail('Unknown action');
  const jtIds = [].concat(b.jtIds || []).map(String).filter(Boolean).slice(0, 10);
  if (!jtIds.length) return fail('Say which test companies');
  try {
    const removed = await removeTestPartners(env, jtIds);
    console.log('[trade-partners-admin] removed', context.data?.userEmail || 'admin', JSON.stringify(removed));
    return ok({ removed });
  } catch (e) {
    console.error('[trade-partners-admin] remove', e.message);
    return fail(e.message || 'Couldn’t remove them just now', 500);
  }
}
