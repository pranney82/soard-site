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
 * POST { action: 'create', id, name, formId, day?, notThose?, shown? }  a person's entry; Zeffy is read again first
 *   Every action on a check also sends `saw`: the state the page showed, so an older screen never overrules a newer answer
 * POST { action: 'link', id, zeffyId }                             this check is that Zeffy entry
 * POST { action: 'unlink', id }                                    the matched entry isn't this check
 * POST { action: 'not-gift', id }
 * POST { action: 'is-gift', id }                                   while watching, takes back a "not a gift"
 * POST { action: 'letter-done', id }                               a letter added after the record, or a refused address, was looked at
 */

import { checksView, openForms, setMode, personCreate, personLink, personNotGift, personIsGift, personUnlink, personLetterDone } from './_check-gifts.js';
import { logAudit } from './_audit.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400, extra = {}) => Response.json({ success: false, error, ...extra }, { status });
/** What the site meant to say, or plain words for a fault it didn't expect: never a database's own message */
const failWith = (e, { reading = false } = {}) => {
  if (e.status) return fail(e.message, e.status, e.entries ? { entries: e.entries } : {});
  console.error('[checks-admin]', e.message);
  return fail(reading ? 'The site didn’t answer. Try again in a minute.' : 'Something went wrong on the site. Look at the list before trying again: it shows what went through.', 500);
};

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('D1 binding missing', 503);
  try {
    if (new URL(request.url).searchParams.get('forms')) return ok({ forms: await openForms(env) });
    return ok(await checksView(env));
  } catch (e) {
    return failWith(e, { reading: true });
  }
}

export async function onRequestPost({ env, request, data }) {
  if (!env.DB) return fail('D1 binding missing', 503);
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  const by = data?.userEmail || null;
  const id = String(body?.id || '');
  const saw = typeof body?.saw === 'string' ? body.saw : null;
  try {
    let result;
    switch (body?.action) {
      case 'mode':
        if (!['watch', 'on'].includes(body.mode)) return fail('Bad mode');
        result = await setMode(env, body.mode, { by, saw: ['on', 'watch'].includes(body.saw) ? body.saw : null });
        break;
      case 'create':
        result = await personCreate(env, id, { name: body.name, formId: body.formId, day: body.day || null, notThose: !!body.notThose, shown: Array.isArray(body.shown) ? body.shown.slice(0, 20) : [], saw, by });
        break;
      case 'link':
        result = await personLink(env, id, String(body.zeffyId || ''), { saw, by });
        break;
      case 'unlink':
        result = await personUnlink(env, id, { saw, by });
        break;
      case 'not-gift':
        result = await personNotGift(env, id, { saw, by });
        break;
      case 'is-gift':
        result = await personIsGift(env, id, { saw, by });
        break;
      case 'letter-done':
        result = await personLetterDone(env, id, { saw, by });
        break;
      default:
        return fail('Unknown action');
    }
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'check-gift', entitySlug: id || 'mode', entityName: body.action === 'mode' ? `Checks: ${body.mode}` : `Check: ${body.action}`, changes: {} }).catch(() => null);
    return ok({ result, ...(await checksView(env)) });
  } catch (e) {
    return failWith(e);
  }
}
