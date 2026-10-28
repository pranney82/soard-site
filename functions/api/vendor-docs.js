/**
 * The public side of a vendor's documents link (/vendor-documents/#t=<token>).
 *
 * GET  /api/vendor-docs?token=…  → { vendor: { name, coi: { expires, insurer } | null, needsW9 } }
 *                                   or 404 (unknown) / 410 (expired or replaced)
 * POST /api/vendor-docs          multipart: token, coi (file), coiExpires (YYYY-MM-DD), coiInsurer, w9 (file)
 *                                   → { ok: true }
 *
 * Public: listed in the middleware's PUBLIC_ROUTES and rate limited per IP.
 * The token is the only key (only its SHA-256 is stored, see _vendors.js).
 * Files go to R2 under vendors/, which nothing public serves. A W-9 sent
 * here also goes onto the vendor's Mercury recipient when there is one. No
 * tax ID is ever asked for or kept: only the form itself.
 */
import { findUploadLink, saveDocuments, LIMITS } from './_vendors.js';

const GONE = {
  expired: 'This link has expired. Ask Sunshine on a Ranney Day for a new one.',
  closed: 'This link has been replaced by a newer one. Use the link in the latest email from Sunshine on a Ranney Day.',
};
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function onRequestGet(context) {
  const token = new URL(context.request.url).searchParams.get('token');
  const { vendor, problem } = await findUploadLink(context.env.DB, token);
  if (problem === 'unknown') return Response.json({ ok: false, error: 'This link isn’t right. Check that you copied all of it.' }, { status: 404, headers: NO_STORE });
  if (problem) return Response.json({ ok: false, error: GONE[problem] }, { status: 410, headers: NO_STORE });
  return Response.json({
    ok: true,
    vendor: {
      name: vendor.name,
      coi: vendor.coi?.expires ? { expires: vendor.coi.expires, insurer: vendor.coi.insurer || '' } : null,
      needsW9: !vendor.w9,
    },
  }, { headers: NO_STORE });
}

export async function onRequestPost(context) {
  try {
    const { env } = context;
    let form;
    try { form = await context.request.formData(); } catch { return Response.json({ ok: false, error: 'Send the form again' }, { status: 400 }); }
    if (form.get('website')) return Response.json({ ok: true }); // a bot filled the hidden field
    const { link, vendor, problem } = await findUploadLink(env.DB, form.get('token'));
    if (problem === 'unknown') return Response.json({ ok: false, error: 'This link isn’t right. Check that you copied all of it.' }, { status: 404 });
    if (problem) return Response.json({ ok: false, error: GONE[problem] }, { status: 410 });
    if (link.uploads >= LIMITS.uploads) return Response.json({ ok: false, error: 'This link has been used too many times. Ask Sunshine on a Ranney Day for a new one.' }, { status: 429 });

    const file = (name) => { const f = form.get(name); return f && typeof f === 'object' && f.size > 0 ? f : null; };
    const coiFile = file('coi');
    const w9File = file('w9');
    const coiExpires = String(form.get('coiExpires') || '').trim();
    if (!coiFile && !w9File) return Response.json({ ok: false, error: 'Add the certificate or the W-9.' }, { status: 400 });
    if (coiFile && !coiExpires) return Response.json({ ok: false, error: 'Add the date the policy ends.' }, { status: 400 });

    try {
      await saveDocuments(env, vendor, {
        coiFile, coiExpires: coiFile ? coiExpires : null, coiInsurer: String(form.get('coiInsurer') || ''), w9File, by: 'vendor',
      });
    } catch (e) {
      return Response.json({ ok: false, error: e.status && e.status < 500 ? e.message : 'The file didn’t upload. Please try again.' }, { status: e.status || 500 });
    }
    await env.DB.prepare('UPDATE vendor_links SET uploads = uploads + 1, last_upload_at = ? WHERE token_hash = ?')
      .bind(new Date().toISOString(), link.token_hash).run();
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[vendor-docs]', err);
    return Response.json({ ok: false, error: 'Something went wrong. Please try again in a minute.' }, { status: 500 });
  }
}
