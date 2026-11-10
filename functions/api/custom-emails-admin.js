/**
 * /api/custom-emails-admin — Emails & invites → Write an email
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET                       → { ok, emails: [{ id, subject, updatedAt, updatedBy, state, broadcastId }] }
 * GET  ?id=                 → { ok, email, status }   status read from Kit
 * POST { save: { id?, subject, preview, signoff, blocks } } → { ok, email }
 * POST { preview: { … } }   → { ok, subject, preview, html }   the email as it will go (no picture check)
 * POST { sendMe: id }       → emails a [Preview] copy to the person asking
 * POST { draft: id }        → drafts it in Kit, or updates the waiting draft (a draft only)
 * POST { remove: id }       → put away (a draft in Kit stays there)
 *
 * See ./_custom-emails.js and ./_custom-email.js.
 */

import {
  listCustomEmails, readCustomEmail, saveCustomEmail, removeCustomEmail, customEmailStatus, draftCustomEmail, sendCustomPreview, isEmailId,
} from './_custom-emails.js';
import { customEmail, emailProblems } from './_custom-email.js';
import { logAudit } from './_audit.js';

const NO_STORE = { 'Cache-Control': 'no-store' };
const ok = (body = {}) => Response.json({ ok: true, ...body }, { headers: NO_STORE });
const fail = (error, status = 400, extra = {}) => Response.json({ ok: false, error, ...extra }, { status, headers: NO_STORE });
const kitUrl = (id) => `https://app.kit.com/campaigns/${encodeURIComponent(id)}`;

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('DB not bound', 500);
  const id = new URL(request.url).searchParams.get('id');
  try {
    if (id) {
      const e = await readCustomEmail(env.DB, id);
      if (!e) return fail('That email isn’t here any more', 404);
      const status = await customEmailStatus(env, e);
      return ok({ email: e, status: { ...status, ...(status.id ? { url: kitUrl(status.id) } : {}) }, missing: emailProblems(e) });
    }
    const emails = await listCustomEmails(env.DB);
    return ok({ emails: emails.map(({ id: eid, subject, updatedAt, updatedBy, state, broadcastId }) => ({ id: eid, subject, updatedAt, updatedBy, state, broadcastId })) });
  } catch (err) {
    return fail(err.message, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const me = context.data?.userEmail || '';
  if (!me.includes('@')) return fail('Could not tell who you are from Access', 403);
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  try {
    if (body?.preview && typeof body.preview === 'object') {
      const m = customEmail(body.preview);
      return ok({ subject: m.subject, preview: m.preview, html: m.html, missing: emailProblems(body.preview) });
    }
    if (body?.save && typeof body.save === 'object') {
      const id = body.save.id || null;
      if (id && !isEmailId(id)) return fail('Not an email');
      const e = await saveCustomEmail(env.DB, { id, email: body.save, by: me });
      return ok({ email: e, missing: emailProblems(e) });
    }
    if (body?.sendMe) {
      if (!isEmailId(body.sendMe)) return fail('Not an email');
      const r = await sendCustomPreview(env, { id: body.sendMe, to: me });
      return r.ok ? ok({ to: r.to }) : fail(r.error);
    }
    if (body?.draft) {
      if (!isEmailId(body.draft)) return fail('Not an email');
      const r = await draftCustomEmail(env, { id: body.draft, by: me });
      if (r.result === 'drafted') {
        const e = await readCustomEmail(env.DB, body.draft);
        await logAudit(env.DB, { userEmail: me, action: 'created', entityType: 'newsletter', entitySlug: String(r.id), entityName: `Kit draft: ${e?.subject || body.draft}`, gitStatus: 'ok' }).catch(() => {});
      }
      return Response.json({ ...r, ...(r.id ? { url: kitUrl(r.id) } : {}) }, { headers: NO_STORE });
    }
    if (body?.remove) {
      if (!isEmailId(body.remove)) return fail('Not an email');
      return (await removeCustomEmail(env.DB, body.remove)) ? ok() : fail('That email isn’t here any more', 404);
    }
    return fail('Nothing to do');
  } catch (err) {
    return fail(err.message, 500);
  }
}
