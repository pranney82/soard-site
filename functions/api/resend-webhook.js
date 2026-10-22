/**
 * POST /api/resend-webhook — did the email arrive?
 * ===========================================================================
 * Resend reports here on every email the site sends: delivered, bounced and
 * why, marked as spam, delayed, failed, opened, clicked (_email-log.js keeps
 * each one for Site → Emails & invites → What went out).
 *
 * Signed the Svix way: svix-signature = "v1," + Base64(HMAC-SHA256(the secret,
 * `${svix-id}.${svix-timestamp}.${body}`)), within 5 minutes. The secret is
 * RESEND_WEBHOOK_SECRET when it's in Cloudflare, else the one the site got
 * when it registered this webhook itself. No secret yet: 503. A signature
 * that doesn't match: 401. Resend retries anything but a 2xx, so everything
 * past the signature answers 204.
 */

import { webhookSecret, verifySvix, recordEvent, followUp, noteWebhookSeen } from './_email-log.js';
import { alertAdmins } from './_broadcast-notify.js';
import { readConfig } from './_broadcast.js';
import { limit } from './_rate-limit.js';
import { clientIp } from './_secure.js';

const MAX_BODY = 64 * 1024;

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return new Response('Not set up', { status: 503 });
  if (!(await limit(env.DB, `resend-webhook:${clientIp(request)}`, 600, 60)).ok) return new Response('Slow down', { status: 429 });
  const secret = await webhookSecret(env).catch(() => null);
  if (!secret) return new Response('Not set up', { status: 503 });
  const raw = await request.text().catch(() => '');
  if (!raw || raw.length > MAX_BODY) return new Response('Bad request', { status: 400 });
  if (!(await verifySvix(secret, request.headers, raw))) return new Response('Unauthorized', { status: 401 });

  let ev = null;
  try { ev = JSON.parse(raw); } catch { return new Response(null, { status: 204 }); }
  const work = (async () => {
    await noteWebhookSeen(env.DB);
    const rec = await recordEvent(env.DB, ev);
    if (!rec?.changed) return;
    const alert = async (e, card) => alertAdmins(e, await readConfig(e.DB), card);
    await followUp(env, rec, { alert });
  })().catch(() => {});
  if (context.waitUntil) context.waitUntil(work); else await work;
  return new Response(null, { status: 204 });
}
