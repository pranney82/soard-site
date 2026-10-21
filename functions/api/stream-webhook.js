/**
 * POST /api/stream-webhook — Cloudflare Notifications → Stream Live events
 * =========================================================================
 * Cloudflare sends { data: { input_id, event_type, ... } } when the live
 * input connects, disconnects or errors. The payload is a WAKE-UP CALL only:
 * it never changes state by itself. The tick it starts asks Stream's own
 * lifecycle endpoint what is true and reconciles from that.
 *
 * Signed: the webhook destination has a secret, which Cloudflare sends in the
 * cf-webhook-auth header, and the same value is set here as
 * STREAM_WEBHOOK_SECRET. A wrong or missing header is refused (401). A signed
 * call for our live input forces an immediate tick (at most one every 5 s),
 * and an error on either of our inputs alerts staff (once per input per 15
 * minutes).
 *
 * Unsigned (STREAM_WEBHOOK_SECRET not set yet): anyone could have sent it,
 * so it only starts an ordinary, throttled tick. No alerts, nothing forced.
 *
 * Nothing from the payload reaches staff, the hub or the response: the alert
 * is built from our own text (live or rehearsal by our own input ids, the
 * error code and codecs only from fixed lists), the hub gets one of Stream's
 * three event names, and the reply is always { ok: true }.
 *
 * Set up once: Cloudflare dashboard → Notifications → Destinations →
 * Webhooks → Create, URL = this endpoint, Secret = a long random value. Add
 * the same value in Cloudflare Pages as STREAM_WEBHOOK_SECRET. Then
 * Notifications → Add → Stream → "Stream Live Notifications", attach the
 * webhook. Or use the Alerting API (see docs/live-broadcast.md).
 */

import { runTick, readConfig, readState, publishToHub, noteWebhook, ensureSchema, SITE_ORIGIN } from './_broadcast.js';
import * as notify from './_broadcast-notify.js';
import { safeEqual } from './_secure.js';
import { limit } from './_rate-limit.js';

const EVENTS = new Set(['live_input.connected', 'live_input.disconnected', 'live_input.errored']);
// Stream's documented error codes, each with our own words (docs: stream/stream-live/webhooks)
const ERRORS = {
  ERR_GOP_OUT_OF_RANGE: ['The keyframe interval is out of range.', 'In Larix, set the keyframe interval to 2 seconds.'],
  ERR_UNSUPPORTED_VIDEO_CODEC: ['Stream can\'t use the video codec the phone sent.', 'In Larix, set the video codec to H.264.'],
  ERR_UNSUPPORTED_AUDIO_CODEC: ['Stream can\'t use the audio codec the phone sent.', 'In Larix, set the audio codec to AAC.'],
  ERR_STORAGE_QUOTA_EXHAUSTED: ['Cloudflare Stream storage is full.', 'Delete old recordings in Cloudflare Stream, or add storage.'],
  ERR_MISSING_SUBSCRIPTION: ['The Cloudflare Stream subscription isn\'t active.', 'Check the Stream plan in the Cloudflare dashboard.'],
  ERR_UNHEALTHY: ['Stream couldn\'t process the broadcast.', 'Check the Larix profile, then stop and start the stream.'],
};
const CODECS = new Set(['h264', 'avc', 'hevc', 'h265', 'av1', 'vp8', 'vp9', 'aac', 'opus', 'mp3', 'ac3', 'eac3']);
const ERROR_ALERT_EVERY_SEC = 15 * 60;
const FORCED_TICK_EVERY_SEC = 5;
// Unsigned calls do nothing an anonymous visitor couldn't, but still cost D1 writes: cap them site-wide
const UNSIGNED_PER_MINUTE = 30;
const MAX_BODY_BYTES = 16 * 1024;

const ok = () => Response.json({ ok: true });

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'stream-webhook', method: 'POST' });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const secret = String(env.STREAM_WEBHOOK_SECRET || '').trim();
  const signed = !!secret && safeEqual((request.headers.get('cf-webhook-auth') || '').trim(), secret);
  if (secret && !signed) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body = {};
  try {
    // Stream's payloads are a few hundred bytes; a big body is never read, let alone parsed
    if (Number(request.headers.get('content-length') || 0) <= MAX_BODY_BYTES) {
      const text = await request.text();
      if (text.length <= MAX_BODY_BYTES) body = JSON.parse(text);
    }
  } catch { /* Cloudflare's "Save and Test" may send a plain body */ }
  const data = body?.data && typeof body.data === 'object' ? body.data : {};
  const named = typeof data.event_type === 'string' ? data.event_type
    : typeof body?.text === 'string' ? body.text.match(/Event type: (\S+)/)?.[1] : null;
  // Only Stream's three event names are kept; anything else (Cloudflare's test included) is a 'test'
  const event = EVENTS.has(named) ? named : 'test';

  try {
    await ensureSchema(env.DB);
    if (!signed && !(await limit(env.DB, 'stream-webhook:unsigned', UNSIGNED_PER_MINUTE, 60)).ok) return ok();
    const config = await readConfig(env.DB);
    const inputId = typeof data.input_id === 'string' ? data.input_id : null;
    const which = !inputId ? null
      : inputId === config.liveInput?.uid ? 'live'
      : inputId === config.rehearsalInput?.uid ? 'rehearsal' : null;
    await noteWebhook(env.DB, { event, inputId: which ? inputId : null, signed });

    if (!signed) {
      // Unsigned: an ordinary throttled check, like a visitor's, after the reply
      context.waitUntil((async () => {
        const r = await runTick(env, { source: 'webhook' });
        if (r.changed && !r.cached && !r.busy) await publishToHub(env, await readState(env.DB), config, 'webhook');
      })().catch((err) => console.error('[stream-webhook]', err.message)));
      return ok();
    }

    if (event === 'live_input.errored' && which) {
      // Once per input per 15 minutes, however often Stream repeats it
      if ((await limit(env.DB, `stream-webhook:errored:${which}`, 1, ERROR_ALERT_EVERY_SEC)).ok) {
        context.waitUntil(notify.alertAdmins(env, config, errorAlert(which, data.live_input_errored)));
      }
    }

    if (which === 'live') {
      // Reconcile right now (forced at most every 5 s), then push to every open page. After the
      // reply: a forced tick may first wait a few seconds for a running one, and Cloudflare
      // shouldn't wait on that (or cut it off by giving up on the call)
      context.waitUntil((async () => {
        const force = (await limit(env.DB, 'stream-webhook:force', 1, FORCED_TICK_EVERY_SEC)).ok;
        await runTick(env, { source: `webhook:${event}`, force });
        await publishToHub(env, await readState(env.DB), config, 'webhook', event === 'test' ? undefined : { type: event });
      })().catch((err) => console.error('[stream-webhook]', err.message)));
    }
    return ok();
  } catch (err) {
    // Always 200 so Cloudflare doesn't disable the destination over our bug
    console.error('[stream-webhook]', err.message);
    return ok();
  }
}

/** The staff alert for an input error, from our own words only */
export function errorAlert(which, errored) {
  const raw = errored && typeof errored === 'object' ? errored : {};
  const code = typeof raw.error?.code === 'string' && Object.hasOwn(ERRORS, raw.error.code) ? raw.error.code : null;
  const [what, fix] = code ? ERRORS[code] : ['Stream reported a problem with the incoming broadcast.', null];
  const codec = (v) => (typeof v === 'string' && CODECS.has(v.trim().toLowerCase()) ? v.trim().toLowerCase() : 'unknown');
  return {
    level: 'error',
    urgent: which === 'live',
    text: which === 'live',
    title: `Stream input error${which === 'live' ? '' : ' (rehearsal)'}: ${code || 'unknown'}`,
    detail: what,
    facts: [['Video codec', codec(raw.video_codec)], ['Audio codec', codec(raw.audio_codec)]],
    fix: fix || 'Check the phone\'s Larix profile: H.264 video, AAC audio, a keyframe every 2 seconds.',
    url: `${SITE_ORIGIN}/admin/`,
  };
}
