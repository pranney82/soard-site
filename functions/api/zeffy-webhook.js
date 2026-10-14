/**
 * POST /api/zeffy-webhook — Zeffy tells us a payment completed
 * ============================================================
 * Verified with the Zeffy-Signature header against config.zeffy.webhookSecret
 * (saved in Admin → Broadcast → Settings). A gift made during a reveal is
 * counted for the live page's running total (see _live-gifts.js); every
 * other event is acknowledged and ignored.
 *
 * Answers 200 for anything handled (including gifts outside a reveal, so
 * Zeffy doesn't retry them) and 401 for a bad or stale signature. A server
 * error is a 500, never a 502 (Cloudflare replaces 502 bodies with its own
 * error page).
 */

import { readState, readConfig } from './_broadcast.js';
import { verifyZeffySignature, recordGift } from './_live-gifts.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'Not configured' }, 500);
  const body = await request.text();
  if (body.length > 256 * 1024) return json({ ok: false, error: 'Too large' }, 413);
  try {
    const config = await readConfig(env.DB);
    const secret = config.zeffy?.webhookSecret;
    if (!secret) return json({ ok: false, error: 'Zeffy is not connected yet' }, 401);
    if (!(await verifyZeffySignature(request.headers.get('Zeffy-Signature'), body, secret))) return json({ ok: false, error: 'Bad signature' }, 401);
    let event;
    try { event = JSON.parse(body); } catch { return json({ ok: false, error: 'Bad JSON' }, 400); }
    if (event?.type !== 'payment.completed') return json({ ok: true, ignored: event?.type || 'unknown' });
    const state = await readState(env.DB);
    const r = await recordGift(env, state, event.data?.object ?? event.data);
    return json({ ok: true, counted: r.counted, broadcastId: r.broadcastId });
  } catch (e) {
    return json({ ok: false, error: e.message || 'Failed' }, 500);
  }
}
