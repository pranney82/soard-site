/**
 * Admin side of profile requests (see _profile-requests.js).
 *
 * GET  /api/profile-requests-admin                      → { requests: [{ id, slug, status, createdAt, expiresAt, submittedAt, submission }] }
 * POST { action: 'create', slug }                       → { url, expiresAt }   (the link is shown once; a new one replaces it)
 * POST { action: 'resolve', id, status: 'used'|'dismissed' }
 *
 * Admin-only (the middleware requires Access).
 */
import { createRequest, liveRequests, resolveRequest } from './_profile-requests.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const SITE = 'https://sunshineonaranneyday.com';

export async function onRequestGet(context) {
  try {
    return Response.json({ success: true, requests: await liveRequests(context.env.DB) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[profile-requests-admin]', err);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  try {
    const { DB } = context.env;
    const body = await context.request.json().catch(() => ({}));
    if (body.action === 'create') {
      if (!SLUG_RE.test(body.slug || '')) return Response.json({ success: false, error: 'Which person?' }, { status: 400 });
      const exists = await DB.prepare('SELECT slug FROM team WHERE slug = ?').bind(body.slug).first();
      if (!exists) return Response.json({ success: false, error: 'Save this person first' }, { status: 404 });
      const { token, expiresAt } = await createRequest(DB, { slug: body.slug, userEmail: context.data?.userEmail || null });
      // The token rides in the fragment, so it never reaches server logs, analytics or a referrer
      return Response.json({ success: true, url: `${SITE}/profile-update/#t=${token}`, expiresAt });
    }
    if (body.action === 'resolve') {
      await resolveRequest(DB, Number(body.id), body.status);
      return Response.json({ success: true });
    }
    return Response.json({ success: false, error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    console.error('[profile-requests-admin]', err);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
