/**
 * /api/checks-admin — Admin → Job Costs → Checks (public/admin/checks.js)
 * ===========================================================================
 * Behind Cloudflare Access like every admin route. Every check deposited in Mercury, and its card: the site fills each one in
 * (./_check-gifts.js), and a person sends it to Zeffy, matches it to an entry Zeffy has, or says it isn't for Zeffy.
 *
 * GET                                       → { success, list, waiting, sending, joinOk, dontReasons, writeTest, … }
 * GET ?forms=1                              → { success, forms }   Zeffy's open donation forms, for a card
 * POST { action: 'send', id, name, donor, formId, day?, email?, address?, notThose?, shown?, donorsShown? }
 *        donor: a Zeffy contact id or 'new'; address: { line1, city, state, postal_code } or null for none
 * POST { action: 'dont-send', id, reason }                         reason: a key of dontReasons
 * POST { action: 'reopen', id }                                    "Send to Zeffy after all"
 * POST { action: 'link', id, zeffyId }                             this check is that Zeffy entry
 * POST { action: 'unlink', id }                                    the matched entry isn't this check
 * POST { action: 'letter-done', id }                               a file added after the record, or a refused address, was looked at
 *   Every action also sends `saw`: the version the page showed, so an older screen never overrules a newer answer
 */

import { checksView, openForms, personSend, personDontSend, personReopen, personLink, personUnlink, personLetterDone } from './_check-gifts.js';
import { logAudit } from './_audit.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400, extra = {}) => Response.json({ success: false, error, ...extra }, { status });
/** What the site meant to say, or plain words for a fault it didn't expect: never a database's own message */
const failWith = (e, { reading = false, ver = null } = {}) => {
  if (e.status) return fail(e.message, e.status, { ...(e.entries ? { entries: e.entries } : {}), ...(e.ver || ver ? { ver: e.ver || ver } : {}) });
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
      case 'send': {
        const a = body.address && typeof body.address === 'object' ? body.address : null;
        result = await personSend(env, id, {
          name: String(body.name || ''), donor: String(body.donor || 'new'), formId: String(body.formId || ''), day: body.day || null,
          email: String(body.email || ''), address: a ? { line1: String(a.line1 || ''), city: String(a.city || ''), state: String(a.state || ''), postal_code: String(a.postal_code || '') } : null,
          notThose: !!body.notThose, shown: Array.isArray(body.shown) ? body.shown.slice(0, 20) : [],
          donorsShown: Array.isArray(body.donorsShown) ? body.donorsShown.slice(0, 20).map(String) : [], saw, by,
        });
        break;
      }
      case 'dont-send':
        result = await personDontSend(env, id, { reason: String(body.reason || ''), saw, by });
        break;
      case 'reopen':
        result = await personReopen(env, id, { saw, by });
        break;
      case 'link':
        result = await personLink(env, id, String(body.zeffyId || ''), { saw, by });
        break;
      case 'unlink':
        result = await personUnlink(env, id, { saw, by });
        break;
      case 'letter-done':
        result = await personLetterDone(env, id, { saw, by });
        break;
      default:
        return fail('Unknown action');
    }
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'check-gift', entitySlug: id, entityName: `Check: ${body.action}`, changes: {} }).catch(() => null);
    return ok({ result, ...(await checksView(env)) });
  } catch (e) {
    // (a refusal that changed the check says the version it left, e.ver; one that changed nothing says none)
    return failWith(e);
  }
}
