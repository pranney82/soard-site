/**
 * The public side of a vendor's link (/vendor-documents/#t=<token>).
 *
 * GET  /api/vendor-docs?token=…   → { ok, vendor: { name, needs, items, have, requirements, w9Only, notNeeded } }
 *                                    or 404 (unknown) / 410 (expired or replaced)
 * POST /api/vendor-docs           multipart: token, doc ('w9' | 'coi'), file (up to 3 for a
 *                                    certificate), anyway ('1': send it in for a person despite the check)
 *                                    → { ok, accepted, look, problems, lines, needs, done }
 *
 * Public: listed in the middleware's PUBLIC_ROUTES and rate limited per IP.
 * The token is the only key (only its SHA-256 is stored, see _vendors.js).
 * Everything is read from and written to the vendor's account in JobTread;
 * the site keeps no copy of the files. No tax ID is asked for or kept.
 */
import { findLink, pageView, fileUpload, LIMITS } from './_vendors.js';

const GONE = {
  expired: 'This link has expired. Reply to our last email and we’ll send a new one.',
  closed: 'This link has been replaced by a newer one. Use the link in the latest email from Sunshine on a Ranney Day.',
};
const NO_STORE = { 'Cache-Control': 'no-store' };
const fail = (error, status) => Response.json({ ok: false, error }, { status, headers: NO_STORE });

async function linkFor(env, token) {
  const { link, problem } = await findLink(env.DB, token);
  if (problem === 'unknown') return { stop: fail('This link isn’t right. Check that you copied all of it.', 404) };
  if (problem) return { stop: fail(GONE[problem], 410) };
  return { link };
}

export async function onRequestGet(context) {
  try {
    const { link, stop } = await linkFor(context.env, new URL(context.request.url).searchParams.get('token'));
    if (stop) return stop;
    const vendor = await pageView(context.env, link);
    if (!vendor) return fail('This link is for a company we no longer have on file. Reply to our email and we’ll sort it out.', 410);
    return Response.json({ ok: true, vendor }, { headers: NO_STORE });
  } catch (err) {
    console.error('[vendor-docs] get', err.message);
    return fail('We couldn’t load your page just now. Please try again in a minute.', 500);
  }
}

export async function onRequestPost(context) {
  try {
    const { env } = context;
    let form;
    try { form = await context.request.formData(); } catch { return fail('Send the file again', 400); }
    if (form.get('website')) return Response.json({ ok: true, accepted: false, problems: [] }); // a bot filled the hidden field
    const { link, stop } = await linkFor(env, form.get('token'));
    if (stop) return stop;
    if (link.uploads >= LIMITS.uploads) return fail('This link has been used too many times. Reply to our email and we’ll send a new one.', 429);
    try {
      const r = await fileUpload(env, link, { doc: String(form.get('doc') || ''), files: form.getAll('file'), anyway: form.get('anyway') === '1' });
      return Response.json({ ok: true, ...r }, { headers: NO_STORE });
    } catch (e) {
      if (e.status && e.status < 500) return fail(e.message, e.status);
      console.error('[vendor-docs] post', e.message);
      return fail('The file didn’t go through. Please try again in a minute.', 500);
    }
  } catch (err) {
    console.error('[vendor-docs]', err);
    return fail('Something went wrong. Please try again in a minute.', 500);
  }
}
