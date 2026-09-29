/**
 * Cloudflare Stream Live helpers
 * ==============================
 * Thin wrappers over the Stream REST API for the live broadcast system:
 * live inputs (the standing ingest the crew's phone streams to), simulcast
 * outputs (Facebook + YouTube), the public lifecycle endpoint (is the input
 * live right now, and which recording is it), recordings, and the Larix
 * Broadcaster setup link the admin renders as a QR code.
 *
 * Every API call returns { ok, status, result, errors } and never throws on
 * HTTP errors — callers surface `errors[0].message` to the admin. Network
 * failures do throw.
 *
 * Env vars: CF_ACCOUNT_ID, CF_STREAM_TOKEN (needs Stream:Edit)
 */

const API = 'https://api.cloudflare.com/client/v4';

/** Customer code from src/utils/schema.ts — the playback subdomain for this account. */
export const DEFAULT_CUSTOMER_CODE = 'cuav5h47lgfe96ql';

export function streamConfigured(env) {
  return !!(env.CF_ACCOUNT_ID && env.CF_STREAM_TOKEN);
}

async function api(env, method, path, body) {
  const res = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_STREAM_TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return {
    ok: res.ok && data.success !== false,
    status: res.status,
    result: data.result,
    errors: data.errors || (res.ok ? [] : [{ message: `Stream API returned ${res.status}` }]),
  };
}

/**
 * Human-readable Stream error. Code 10002 on every call is NOT a bad token:
 * it means Cloudflare Stream is not enabled on the account (the paid Stream
 * entitlement lapsed; it has happened twice). Only Cloudflare Billing can fix
 * that, so say so instead of sending someone to chase API tokens.
 */
export function errorMessage(r, fallback = 'Stream API error') {
  const e = r?.errors?.[0];
  if (e?.code === 10002 || (r?.status === 403 && /authorization failure/i.test(e?.message || ''))) {
    return 'Cloudflare Stream is not enabled on this account (code 10002). This is the account\'s Stream subscription, not the token: check Billing → Subscriptions and Images & Stream → Hosted videos, and open a Cloudflare Billing ticket citing "Cloudflare Stream not enabled".';
  }
  return e?.message || fallback;
}

export function streamNotEnabled(r) {
  return r?.errors?.[0]?.code === 10002;
}

// ─── Live inputs ────────────────────────────────────────────────────

/**
 * Create the standing live input. Recording is automatic (so the live
 * stream is playable and every broadcast is saved), low-latency HLS is on,
 * and a 30s reconnect grace keeps one dropped cell connection from
 * splitting a reveal into two recordings.
 */
export async function createLiveInput(env, { name, timeoutSeconds = 30, deleteRecordingAfterDays = null, lowLatency = true } = {}) {
  return api(env, 'POST', '/stream/live_inputs', {
    meta: { name: name || 'SOARD reveals' },
    recording: { mode: 'automatic', timeoutSeconds, requireSignedURLs: false, hideLiveViewerCount: false },
    preferLowLatency: !!lowLatency,
    ...(deleteRecordingAfterDays ? { deleteRecordingAfterDays } : {}),
  });
}

export function getLiveInput(env, uid) {
  return api(env, 'GET', `/stream/live_inputs/${encodeURIComponent(uid)}`);
}

export function updateLiveInput(env, uid, patch) {
  return api(env, 'PUT', `/stream/live_inputs/${encodeURIComponent(uid)}`, patch);
}

export function rotateLiveInputKeys(env, uid) {
  return api(env, 'POST', `/stream/live_inputs/${encodeURIComponent(uid)}/rotate_keys`);
}

export function deleteLiveInput(env, uid) {
  return api(env, 'DELETE', `/stream/live_inputs/${encodeURIComponent(uid)}`);
}

export function listLiveInputs(env) {
  return api(env, 'GET', '/stream/live_inputs');
}

// ─── Simulcast outputs ──────────────────────────────────────────────

export function listOutputs(env, inputUid) {
  return api(env, 'GET', `/stream/live_inputs/${encodeURIComponent(inputUid)}/outputs`);
}

export function createOutput(env, inputUid, { url, streamKey, enabled = true }) {
  return api(env, 'POST', `/stream/live_inputs/${encodeURIComponent(inputUid)}/outputs`, { url, streamKey, enabled });
}

export function updateOutput(env, inputUid, outputUid, { enabled }) {
  return api(env, 'PUT', `/stream/live_inputs/${encodeURIComponent(inputUid)}/outputs/${encodeURIComponent(outputUid)}`, { enabled });
}

export function deleteOutput(env, inputUid, outputUid) {
  return api(env, 'DELETE', `/stream/live_inputs/${encodeURIComponent(inputUid)}/outputs/${encodeURIComponent(outputUid)}`);
}

// ─── Recordings ─────────────────────────────────────────────────────

/** Videos recorded from an input, newest first; the first is live-inprogress while streaming. */
export function listInputVideos(env, inputUid) {
  return api(env, 'GET', `/stream/live_inputs/${encodeURIComponent(inputUid)}/videos`);
}

export function getVideo(env, videoUid) {
  return api(env, 'GET', `/stream/${encodeURIComponent(videoUid)}`);
}

export function updateVideo(env, videoUid, patch) {
  return api(env, 'POST', `/stream/${encodeURIComponent(videoUid)}`, patch);
}

/** Ask Stream to generate captions for a recording (English). Never throws. */
export async function requestCaptions(env, videoUid, language = 'en') {
  try {
    return await api(env, 'POST', `/stream/${encodeURIComponent(videoUid)}/captions/${language}/generate`);
  } catch (e) {
    return { ok: false, status: 0, errors: [{ message: e.message }] };
  }
}

/** Token health check: list one video. */
export async function checkToken(env) {
  try {
    const r = await api(env, 'GET', '/stream?per_page=1');
    if (r.ok) return { ok: true, error: null };
    return { ok: false, error: errorMessage(r), notEnabled: streamNotEnabled(r), code: r.errors?.[0]?.code || r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Public playback endpoints (no token) ───────────────────────────

export function playbackHost(customerCode) {
  return `https://customer-${customerCode || DEFAULT_CUSTOMER_CODE}.cloudflarestream.com`;
}

/**
 * Is the input streaming right now, and which recording is active?
 * { isInput, videoUID, live }. Returns null if unreachable.
 */
export async function lifecycle(customerCode, inputUid) {
  try {
    const res = await fetch(`${playbackHost(customerCode)}/${inputUid}/lifecycle`, {
      signal: AbortSignal.timeout(6000),
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { isInput: !!data.isInput, videoUID: data.videoUID || null, live: !!data.live };
  } catch {
    return null;
  }
}

/** Current live viewers for an input or video; null when unavailable. */
export async function liveViewers(customerCode, uid) {
  try {
    const res = await fetch(`${playbackHost(customerCode)}/${uid}/views`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const n = Number(data.liveViewers);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function embedUrl(customerCode, uid, { autoplay = false, muted = false, poster } = {}) {
  const qs = new URLSearchParams();
  if (autoplay) qs.set('autoplay', 'true');
  if (muted) qs.set('muted', 'true');
  if (poster) qs.set('poster', poster);
  const q = qs.toString();
  return `${playbackHost(customerCode)}/${uid}/iframe${q ? `?${q}` : ''}`;
}

export function thumbnailUrl(customerCode, uid, { width = 1280, height = 720, time } = {}) {
  const qs = new URLSearchParams({ width: String(width), height: String(height), fit: 'crop' });
  if (time) qs.set('time', time);
  return `${playbackHost(customerCode)}/${uid}/thumbnails/thumbnail.jpg?${qs}`;
}

export function watchUrl(uid) {
  return `https://watch.cloudflarestream.com/${uid}`;
}

// ─── Larix Broadcaster setup link ───────────────────────────────────

/**
 * Encoder profiles the admin offers as QR codes. Keyframe every 2s is what
 * Stream expects; audio is 48 kHz stereo AAC so a plugged-in wireless mic
 * comes through clean.
 */
export const ENCODER_PROFILES = {
  standard: { label: 'Standard (1080p)', res: '1920x1080', fps: 30, bitrate: 3500, keyframe: 2, audioBitrate: 128, samples: 48000, channels: 2 },
  lowSignal: { label: 'Weak signal (720p)', res: '1280x720', fps: 30, bitrate: 1800, keyframe: 2, audioBitrate: 96, samples: 48000, channels: 2 },
};

/**
 * Build a Larix Grove deep link (larix://set/v1?…) that installs one SRT
 * connection plus encoder settings when scanned. SRT caller mode with a
 * 2000 ms latency budget rides out cellular hiccups; the passphrase and
 * stream id come from the live input so nobody types anything.
 */
export function larixSetupLink(input, { name = 'SOARD Live', profile = 'standard', latencyMs = 2000 } = {}) {
  const srt = input?.srt;
  if (!srt?.url || !srt?.streamId) return null;
  const enc = ENCODER_PROFILES[profile] || ENCODER_PROFILES.standard;
  const p = new URLSearchParams();
  p.set('conn[][name]', name);
  p.set('conn[][url]', srt.url);
  p.set('conn[][mode]', 'va');
  p.set('conn[][srtmode]', 'c');
  p.set('conn[][srtlatency]', String(latencyMs));
  p.set('conn[][srtstreamid]', srt.streamId);
  if (srt.passphrase) {
    p.set('conn[][srtpass]', srt.passphrase);
    p.set('conn[][srtpbkl]', '16');
  }
  p.set('conn[][overwrite]', 'on');
  p.set('conn[][active]', 'on');
  p.set('enc[vid][res]', enc.res);
  p.set('enc[vid][fps]', String(enc.fps));
  p.set('enc[vid][bitrate]', String(enc.bitrate));
  p.set('enc[vid][keyframe]', String(enc.keyframe));
  p.set('enc[vid][format]', 'avc');
  p.set('enc[vid][camera]', '0');
  p.set('enc[aud][bitrate]', String(enc.audioBitrate));
  p.set('enc[aud][samples]', String(enc.samples));
  p.set('enc[aud][channels]', String(enc.channels));
  return `larix://set/v1?${p.toString()}`;
}

/** SRT URL for OBS or other encoders (Stream's documented form). */
export function srtUrl(input) {
  const srt = input?.srt;
  if (!srt?.url || !srt?.streamId) return null;
  const qs = new URLSearchParams({ streamid: srt.streamId });
  if (srt.passphrase) qs.set('passphrase', srt.passphrase);
  return `${srt.url}?${qs}`;
}

/** Strip secrets from a live input record for read-only admin views. */
export function redactInput(input) {
  if (!input) return null;
  return {
    uid: input.uid,
    name: input.meta?.name || null,
    created: input.created || null,
    keysRotatedAt: input.keysRotatedAt || null,
    enabled: input.enabled !== false,
    recording: input.recording || null,
    preferLowLatency: !!input.preferLowLatency,
    rtmps: input.rtmps ? { url: input.rtmps.url, streamKey: mask(input.rtmps.streamKey) } : null,
    srt: input.srt ? { url: input.srt.url, streamId: mask(input.srt.streamId), passphrase: mask(input.srt.passphrase) } : null,
  };
}

export function mask(s) {
  if (!s) return null;
  const str = String(s);
  return str.length <= 8 ? '••••' : `${str.slice(0, 4)}…${str.slice(-4)}`;
}

/** Well-known ingest URLs the admin pre-fills. */
export const OUTPUT_PRESETS = {
  facebook: { label: 'Facebook Live', url: 'rtmps://live-api-s.facebook.com:443/rtmp/', help: 'Live Producer → Streaming software → Advanced settings → Persistent stream key' },
  youtube: { label: 'YouTube Live', url: 'rtmps://a.rtmps.youtube.com:443/live2', help: 'YouTube Studio → Go live → Stream → Stream key (turn on Auto-start and Auto-stop)' },
};
