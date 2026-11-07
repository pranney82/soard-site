/**
 * /api/checks-admin — Admin → Job Costs → Checks (public/admin/checks.js)
 * ===========================================================================
 * Behind Cloudflare Access like every admin route. Every check deposited in Mercury
 * and what became of it (./_check-gifts.js). Nothing here has to be pressed for a
 * check that went fine; people answer the few the site can't.
 *
 * GET                                       → { success, mode, list, waiting, scored, writeTest, … }
 * GET ?forms=1                              → { success, forms }   Zeffy's open donation forms, for a person's entry
 * POST { action: 'mode', mode: 'watch'|'on' }                      On says staff stop entering Mercury checks
 * POST { action: 'create', id, name, formId, day?, notThose? }     a person's entry; Zeffy is read again first
 * POST { action: 'link', id, zeffyId }                             this check is that Zeffy entry
 * POST { action: 'unlink', id }                                    the matched entry isn't this check
 * POST { action: 'not-gift', id }
 * POST { action: 'is-gift', id }                                   while watching, takes back a "not a gift"
 */

import { checksView, openForms, setMode, personCreate, personLink, personNotGift, personIsGift, personUnlink } from './_check-gifts.js';
import { logAudit } from './_audit.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('D1 binding missing', 503);
  try {
    if (new URL(request.url).searchParams.get('forms')) return ok({ forms: await openForms(env) });
    return ok(await checksView(env));
  } catch (e) {
    return fail(e.message, e.status || 500);
  }
}

export async function onRequestPost({ env, request, data }) {
  if (!env.DB) return fail('D1 binding missing', 503);
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  const by = data?.userEmail || null;
  const id = String(body?.id || '');
  try {
    let result;
    switch (body?.action) {
      case 'mode':
        if (!['watch', 'on'].includes(body.mode)) return fail('Bad mode');
        result = await setMode(env, body.mode, { by });
        break;
      case 'create':
        result = await personCreate(env, id, { name: body.name, formId: body.formId, day: body.day || null, notThose: !!body.notThose, by });
        break;
      case 'link':
        result = await personLink(env, id, String(body.zeffyId || ''), { by });
        break;
      case 'unlink':
        result = await personUnlink(env, id, { by });
        break;
      case 'not-gift':
        result = await personNotGift(env, id, { by });
        break;
      case 'is-gift':
        result = await personIsGift(env, id, { by });
        break;
      default:
        return fail('Unknown action');
    }
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'check-gift', entitySlug: id || 'mode', entityName: body.action === 'mode' ? `Checks: ${body.mode}` : `Check: ${body.action}`, changes: {} }).catch(() => null);
    return ok({ result, ...(await checksView(env)) });
  } catch (e) {
    return fail(e.message, e.status || 500);
  }
}
