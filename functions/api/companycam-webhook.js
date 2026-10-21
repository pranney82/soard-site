/**
 * POST /api/companycam-webhook — CompanyCam says something changed
 * ===========================================================================
 * The webhook the site keeps in CompanyCam (./_companycam-sync.js
 * ensureWebhook): photos, documents and projects. Only events for a family's
 * home-visit project lead anywhere; everything else (every job's project,
 * which JobTread's own integration copies) gets a plain 200.
 *
 * Signed: X-CompanyCam-Signature = Base64(HMAC-SHA1(token, raw body)), with
 * the token the site works out from COMPANYCAM_TOKEN. No key set, or a
 * signature that doesn't match: 401. The body is only a wake-up: the ids in
 * it say where to look, and the photo, document or project is read back from
 * CompanyCam before anything is written to JobTread. The answer is { ok }.
 *
 * CompanyCam counts only a 200 as delivered and turns the webhook off after
 * too many failures, so anything past the signature answers 200 and failed
 * work waits for the heartbeat's next try.
 */

import { webhookToken, signatureFor } from './_companycam.js';
import { takeEvent, processFile } from './_companycam-sync.js';
import { safeEqual } from './_secure.js';
import { limit, tooMany } from './_rate-limit.js';

const MAX_BODY = 256 * 1024;
const ok = () => Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
const refused = (status) => Response.json({ ok: false }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function onRequestPost(context) {
  const { env, request } = context;
  const token = await webhookToken(env);
  if (!token || !env.DB) return refused(401);
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return refused(413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return refused(413);
  const given = String(request.headers.get('X-CompanyCam-Signature') || '').trim();
  if (!given || !safeEqual(given, await signatureFor(token, raw))) return refused(401);

  // A busy day is a few hundred photos an hour; this is far past that
  const rl = await limit(env.DB, 'companycam-webhook', 600, 60);
  if (!rl.ok) return tooMany(rl.retryAfter);

  let ev = null;
  try { ev = JSON.parse(raw); } catch { return ok(); } // signed but unreadable: nothing to do, and no retries
  try {
    const r = await takeEvent(env, ev);
    if (r?.ccId) context.waitUntil(processFile(env, r.ccId));
  } catch (e) {
    console.error('[companycam-webhook]', e.message); // the catch-up check finds it
  }
  return ok();
}

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'companycam-webhook', method: 'POST' });
}
