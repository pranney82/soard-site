/**
 * /api/trade-partners-admin — Admin → Trade partners (public/admin/trade-partners.js)
 * ===========================================================================
 * Behind Cloudflare Access like every admin route; the signed-in person is
 * who decides (context.data.userEmail). JobTread stays the record: the list is
 * its vendors as the 4-hourly cache has them, one partner is read live.
 *
 * GET                       → { success, partners, requests, bank, settings, facts }
 * GET ?vendor=<jtId>        → { success, partner }   one in full (company, files, invoices, bank, agent)
 * POST { action, … }:
 *   invite    { jtId? | company, name, email, phone, lang }   → { success, jtId, to }   "Add a trade partner"
 *   decide    { id, decision: 'approve' | 'decline', jtId?, reason? }                    a "Work with us" request
 *   confirm-bank { jtId }                  someone called the number on file and confirmed it
 *   send-link { jtId }                     their page, by email (the setup invitation until they've finished)
 *   mark      { jtId, materials?, notNeeded? }                  written to JobTread
 *   settings  { glOccurrence, glAggregate, workersComp, elEachAccident, renewDays }   the minimums
 *   preview   {}                           the email a vendor gets, to the signed-in person (a sample company)
 */
import { readDocSettings, saveDocSettings, sendPreview } from './_vendors.js';
import {
  listPartners, partnerDetail, listRequests, decideRequest, invitePartner, confirmBank, sendPartnerLink, markPartner, bankToConfirm, partnerFacts, ensurePartnerSchema,
} from './_trade-partners.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status, headers: { 'Cache-Control': 'no-store' } });
const ID = /^[\w-]{4,64}$/;

async function everything(env) {
  await ensurePartnerSchema(env.DB);
  const [partners, requests, bank, settings, facts] = await Promise.all([
    listPartners(env), listRequests(env.DB), bankToConfirm(env), readDocSettings(env.DB), partnerFacts(env.DB),
  ]);
  return { partners, requests, bank, settings, facts };
}

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const vendor = new URL(context.request.url).searchParams.get('vendor');
    if (vendor) {
      if (!ID.test(vendor)) return fail('That isn’t a vendor');
      return ok({ partner: await partnerDetail(env, vendor) });
    }
    return ok(await everything(env));
  } catch (e) {
    if (e.status && e.status < 500) return fail(e.message, e.status);
    console.error('[trade-partners-admin] get', e.message);
    return fail('Couldn’t read trade partners just now', 500);
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  const by = context.data?.userEmail || 'admin';
  let b;
  try { b = await context.request.json(); } catch { return fail('Send that again'); }
  try {
    const jtId = b.jtId ? String(b.jtId) : null;
    if (jtId && !ID.test(jtId)) return fail('That isn’t a vendor');
    switch (b.action) {
      case 'invite': {
        const r = await invitePartner(env, { jtId, company: b.company, name: b.name, email: b.email, phone: b.phone, lang: b.lang === 'es' ? 'es' : 'en', by });
        return ok({ ...(await everything(env)), jtId: r.jtId, to: String(b.email || '').trim().toLowerCase(), created: r.created });
      }
      case 'decide': {
        if (!['approve', 'decline'].includes(b.decision)) return fail('Approve or decline');
        await decideRequest(env, String(b.id || ''), { decision: b.decision, by, jtId, reason: b.reason || '' });
        break;
      }
      case 'confirm-bank':
        if (!jtId) return fail('Pick the vendor');
        await confirmBank(env, jtId, by);
        break;
      case 'send-link': {
        if (!jtId) return fail('Pick the vendor');
        const r = await sendPartnerLink(env, jtId, by);
        return ok({ ...(await everything(env)), to: r.to });
      }
      case 'mark':
        if (!jtId) return fail('Pick the vendor');
        await markPartner(env, jtId, { materials: typeof b.materials === 'boolean' ? b.materials : undefined, notNeeded: typeof b.notNeeded === 'boolean' ? b.notNeeded : undefined }, by);
        return ok({ ...(await everything(env)), partner: await partnerDetail(env, jtId) });
      case 'settings':
        await saveDocSettings(env.DB, b);
        break;
      case 'preview': {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(by)) return fail('Sign in with your SOARD email to get the preview');
        const r = await sendPreview(env, by);
        return ok({ sent: by, url: r.url });
      }
      default:
        return fail('Unknown action');
    }
    return ok(await everything(env));
  } catch (e) {
    if (e.status && e.status < 500) return fail(e.message, e.status);
    console.error('[trade-partners-admin]', b.action, e.message);
    return fail(e.message || 'That didn’t work', 500);
  }
}
