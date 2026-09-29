/**
 * POST /api/stream-webhook — Cloudflare Notifications → Stream Live events
 * =========================================================================
 * Cloudflare sends { data: { input_id, event_type, ... } } when the live
 * input connects, disconnects or errors. This endpoint is public and treats
 * the payload as a WAKE-UP CALL only: it never changes state by itself. It
 * forces an immediate tick, which asks Stream's own lifecycle endpoint what
 * is true and reconciles from that. So a forged request can at most make us
 * re-check Stream, which the hub does every few seconds anyway.
 *
 * Set up once: Cloudflare dashboard → Notifications → Destinations →
 * Webhooks → Create, URL = this endpoint. Then Notifications → Add →
 * Stream → "Stream Live Notifications", attach the webhook. Or use the
 * Alerting API (see docs/live-broadcast.md).
 */

import { runTick, readConfig, readHealth, writeHealth, readState, publishToHub } from './_broadcast.js';
import * as notify from './_broadcast-notify.js';

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'stream-webhook', method: 'POST' });
}

export async function onRequestPost(context) {
  const { env } = context;
  let body = {};
  try { body = await context.request.json(); } catch { /* Cloudflare's "test" may send a plain body */ }
  const data = body?.data || {};
  const inputId = data.input_id || null;
  const eventType = data.event_type || body?.text?.match(/Event type: (\S+)/)?.[1] || 'unknown';

  try {
    const [config, health] = await Promise.all([readConfig(env.DB), readHealth(env.DB)]);
    health.webhook = {
      lastReceivedAt: new Date().toISOString(),
      lastEvent: eventType,
      lastInputId: inputId,
      count: (health.webhook?.count || 0) + 1,
    };
    await writeHealth(env.DB, health);

    const known = inputId && (inputId === config.liveInput?.uid || inputId === config.rehearsalInput?.uid);
    const isLiveInput = inputId && inputId === config.liveInput?.uid;

    if (eventType === 'live_input.errored') {
      const err = data.live_input_errored?.error || {};
      context.waitUntil(notify.alertAdmins(env, config, {
        level: 'error',
        title: `Stream input error${isLiveInput ? '' : ' (rehearsal)'}: ${err.code || 'unknown'}`,
        detail: `${err.message || 'Stream reported a problem with the incoming broadcast.'}\nVideo codec: ${data.live_input_errored?.video_codec || '?'} · Audio codec: ${data.live_input_errored?.audio_codec || '?'}\nCheck the phone's Larix profile (H.264, AAC, keyframe 2s).`,
        url: 'https://sunshineonaranneyday.com/admin/',
      }));
    }

    if (isLiveInput) {
      // Reconcile right now, then push to every open page
      const r = await runTick(env, { source: `webhook:${eventType}`, force: true });
      const state = await readState(env.DB);
      context.waitUntil(publishToHub(env, state, config, `webhook:${eventType}`, { type: eventType }));
      return Response.json({ ok: true, handled: true, phase: r.state?.phase || null });
    }

    return Response.json({ ok: true, handled: false, known: !!known, note: inputId ? 'input not tracked' : 'no input_id (test payload?)' });
  } catch (err) {
    // Always 200 so Cloudflare doesn't disable the destination over our bug
    return Response.json({ ok: false, error: err.message });
  }
}
