/**
 * /api/application-waitlist-admin — the waitlist panel in Admin → Applications → Settings
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list). The
 * waitlist itself and the email it gets when applications open are in
 * ./_application-waitlist.js.
 *
 * GET                       → everything the panel shows (moves the opening along first)
 * GET ?preview=en|es        → { subject, html } of the applications-open email
 * POST { action: 'send-now' | 'hold' | 'retry' | 'retry-signups' | 'import' }
 * POST { action: 'add', email, lang, confirm }   → a family who asked by phone or in person
 * POST { action: 'remove', email }
 * POST { action: 'wording', wording: { en: { subject, body }, es: … } }
 * POST { action: 'test', lang, to?, wording? }    → a test of the email to you
 * POST { action: 'preview', lang, wording }       → the preview with unsaved wording
 */

import { waitlistStatus, waitlistAction, previewOpening } from './_application-waitlist.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const url = new URL(request.url);
  try {
    const preview = url.searchParams.get('preview');
    if (preview) return ok(await previewOpening(env, { lang: preview }));
    return ok({ status: await waitlistStatus(env, { list: url.searchParams.get('list') !== '0' }), me: context.data?.userEmail || null });
  } catch (err) {
    return fail(err.message, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  let body = {};
  try { body = await request.json(); } catch { return fail('Send JSON'); }
  const user = context.data?.userEmail || 'admin';
  try {
    if (body.action === 'preview') return ok(await previewOpening(env, { lang: body.lang, wording: body.wording || null }));
    const r = await waitlistAction(env, String(body.action || ''), body, { user });
    if (!r.ok) return fail(r.error || 'That did not work');
    return ok({ ...r, status: await waitlistStatus(env, { list: true }) });
  } catch (err) {
    return fail(err.message, 500);
  }
}
