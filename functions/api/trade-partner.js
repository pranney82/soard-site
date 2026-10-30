/**
 * /api/trade-partner — the trade-partner pages' steps (see ./_trade-partners.js)
 * ===========================================================================
 * GET  ?config                       → { ok, turnstileSiteKey, trades, requirements, minimums }   for /trade-partners/
 * POST { action, … } (JSON):
 *   signin    { email, lang }          → { ok }   a link goes to that email when JobTread has it (never said either way)
 *   request   { company, trades, name, email, phone, website, area, note, lang, turnstileToken, website2 }
 *                                      → { ok }   "Work with us", decided in the admin
 *   With a link's token (their own page; an agent's link can't):
 *   company   { token, name, trades, address, license, main, billing }   → { ok }
 *   w9        { token, w9: { … } }    → { ok } | { ok: false, problems }
 *   agent     { token, name, email, agency, phone }                     → { ok }
 *   bank      { token, routing, account, account2, kind }               → { ok, last4 }
 *   bank-link { token }                → { ok, to }   a fresh link, for bank details, to the email on file
 *   lang      { token, lang }          → { ok }
 *
 * Public: listed in the middleware's PUBLIC_ROUTES and rate limited per
 * address there; these add per-email and per-day limits through D1.
 */
import { findLink, hashToken, readDocSettings, LIMITS } from './_vendors.js';
import { requirementLines } from './_vendor-read.js';
import { signIn, submitRequest, saveCompany, signW9, saveAgent, saveBank, freshBankLink, patchProfile, ensurePartnerSchema } from './_trade-partners.js';
import { TRADES } from './_vendors.js';
import { limit } from './_rate-limit.js';
import { turnstileOn, turnstileSiteKey, verifyTurnstile } from './_secure.js';

const NO_STORE = { 'Cache-Control': 'no-store' };
const reply = (body, status = 200) => Response.json(body, { status, headers: NO_STORE });
const fail = (error, status, extra = {}) => reply({ ok: false, error, ...extra }, status);
const GONE = {
  unknown: 'This link isn’t right. Check that you copied all of it, or sign in again.',
  expired: 'This link has expired. Sign in again with your email and we’ll send a new one.',
  closed: 'This link has been replaced by a newer one. Use the link in your latest email, or sign in again.',
};

export async function onRequestGet(context) {
  const p = new URL(context.request.url).searchParams;
  if (!p.has('config')) return fail('Not found', 404);
  const req = await readDocSettings(context.env.DB).catch(() => null);
  const minimums = req && { glOccurrence: req.glOccurrence, glAggregate: req.glAggregate, workersComp: !!req.workersComp, elEachAccident: req.elEachAccident, renewDays: req.renewDays };
  return reply({ ok: true, turnstileSiteKey: turnstileOn(context.env) ? turnstileSiteKey(context.env) : null, trades: TRADES, requirements: req ? requirementLines(req) : null, minimums });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const ip = request.headers.get('cf-connecting-ip') || '';
  let body;
  try { body = await request.json(); } catch { return fail('Send that again', 400); }
  const action = String(body?.action || '');
  try {
    await ensurePartnerSchema(env.DB);
    if (action === 'signin') {
      const email = String(body.email || '').trim().toLowerCase();
      const byIp = await limit(env.DB, `tp-signin:ip:${ip}`, 10, 3600);
      const byEmail = await limit(env.DB, `tp-signin:email:${(await hashToken(email)).slice(0, 24)}`, 3, 3600);
      if (!byIp.ok || !byEmail.ok) return fail('That’s a lot of sign-in links. Check your email for the last one, or try again in an hour.', 429);
      await signIn(env, email, { lang: body.lang === 'es' ? 'es' : 'en' });
      return reply({ ok: true });
    }
    if (action === 'request') {
      if (body.website2) return reply({ ok: true }); // a bot filled the hidden field
      const byIp = await limit(env.DB, `tp-request:ip:${ip}`, 5, 86400);
      if (!byIp.ok) return fail('We’ve had a few requests from here today. Email us instead and we’ll be in touch.', 429);
      if (turnstileOn(env) && !(await verifyTurnstile(env, body.turnstileToken, ip))) return fail('Please complete the quick check above the button.', 403, { code: 'turnstile' });
      const r = await submitRequest(env, body, { ip });
      return reply({ ok: true, again: !!r.again });
    }

    // Everything else is a partner's own page, behind their link
    const { link, problem } = await findLink(env.DB, body.token);
    if (problem) return fail(GONE[problem], problem === 'unknown' ? 404 : 410, { code: problem });
    if (link.scope === 'agent') return fail('This link is for the certificate of insurance only.', 403);
    if (link.uploads >= LIMITS.uploads * 2) return fail('This link has been used a lot. Sign in again for a fresh one.', 429);
    await env.DB.prepare('UPDATE vendor_links SET uploads = uploads + 1, last_upload_at = ? WHERE token_hash = ?').bind(new Date().toISOString(), link.token_hash).run();
    if (action === 'company') return reply(await saveCompany(env, link, body));
    if (action === 'w9') return reply(await signW9(env, link, body.w9 || {}, { ip }));
    if (action === 'agent') return reply(await saveAgent(env, link, body));
    if (action === 'bank') return reply(await saveBank(env, link, body));
    if (action === 'bank-link') return reply(await freshBankLink(env, link));
    if (action === 'lang') {
      if (link.vendor_id !== 'preview') await patchProfile(env.DB, link.vendor_id, { lang: body.lang === 'es' ? 'es' : 'en' });
      return reply({ ok: true });
    }
    return fail('Not a step this page knows', 400);
  } catch (e) {
    if (e.status && e.status < 500) return fail(e.message, e.status, { field: e.field || null, code: e.code || null });
    console.error('[trade-partner]', action, e.message);
    return fail('That didn’t go through. Please try again in a minute.', 500);
  }
}
