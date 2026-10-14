/**
 * Live feed monitor
 * =================
 * Answers "is the reveal actually reaching people, with sound?" in one
 * place, for two callers:
 *
 *  report()  the admin's Control room: phone connection, picture, audio
 *            level, and a verdict per destination (site, Facebook, YouTube,
 *            Instagram) with the fix when something is wrong.
 *  watch()   runTick, every 15 s while live, nobody needed: alerts admins
 *            (Slack/email) once per problem when the audio goes silent or
 *            missing, the picture freezes, or Facebook / YouTube still
 *            aren't live minutes after the phone connected. A recovery note
 *            follows when the audio comes back.
 *
 * Destination status: ok (confirmed live) · wait (starting, give it a
 * minute) · warn (needs a person; `fix` says what to do) · off (not set up
 * or paused) · unknown (can't be checked from here) · idle (phone not live).
 */

import * as stream from './_stream-live.js';
import * as fb from './_broadcast-fb.js';
import * as yt from './_youtube.js';
import * as notify from './_broadcast-notify.js';
import { probeFeed } from './_stream-probe.js';

const SITE_ORIGIN = 'https://sunshineonaranneyday.com';
export const WATCH_INTERVAL_MS = 15 * 1000;
const SILENT_ALERT_MS = 30 * 1000;
const FROZEN_ALERT_MS = 30 * 1000;
const NO_AUDIO_GRACE_MS = 20 * 1000;
const FB_GRACE_MS = 2 * 60 * 1000;
const YT_GRACE_MS = 150 * 1000;
const FB_CACHE_MS = 20 * 1000;
const INPUT_CACHE_MS = 10 * 1000;
const LIVE_PRODUCER_URL = 'https://www.facebook.com/live/producer';
const YT_STUDIO_URL = 'https://studio.youtube.com/channel/UC/livestreaming';

const fbCache = { at: 0, key: null, value: null };
const inputCache = new Map(); // uid → { at, value }
const ytChannelCache = new Map(); // channel URL → { id, title } or { error }

const nowIso = () => new Date(Date.now()).toISOString();
const secs = (ms) => Math.round(ms / 1000);
const mins = (ms) => Math.max(1, Math.round(ms / 60000));

/** Stream's own word for the phone's connection: connected, reconnecting, … (null if unknown). */
async function connectionStatus(env, uid) {
  if (!stream.streamConfigured(env) || !uid) return null;
  const hit = inputCache.get(uid);
  if (hit && Date.now() - hit.at < INPUT_CACHE_MS) return hit.value;
  let value = null;
  try {
    const r = await stream.getLiveInput(env, uid);
    const s = r.ok ? r.result?.status : null;
    value = typeof s === 'string' ? s : (s?.current?.state || s?.current?.reason || null);
  } catch { /* unknown */ }
  inputCache.set(uid, { at: Date.now(), value });
  return value;
}

/** Is the Page live? API mode reads Facebook's ingest health; persistent mode looks for a LIVE video. */
async function facebookLive(env, config, state) {
  if (!fb.fbConfigured(env)) return { configured: false };
  const apiId = config.facebook?.mode === 'api' ? state.fb?.liveVideoId : null;
  const key = apiId || 'page';
  if (fbCache.key === key && Date.now() - fbCache.at < FB_CACHE_MS) return fbCache.value;
  let value;
  try {
    if (apiId) {
      const h = await fb.fbLiveVideoHealth(env, apiId);
      value = { configured: true, ok: h.ok, live: h.status === 'LIVE', status: h.status, health: h.health, permalink: state.fb?.permalink || null, error: h.error || null };
    } else {
      const cur = await fb.fbCurrentLive(env);
      value = { configured: true, ok: true, live: !!cur, permalink: cur?.permalink || state.fb?.permalink || null, videoId: cur?.id || null, error: null };
    }
  } catch (e) {
    value = { configured: true, ok: false, live: false, error: e.message };
  }
  Object.assign(fbCache, { at: Date.now(), key, value });
  return value;
}

async function youtubeLive(env, config) {
  if (!yt.youtubeConfigured(env)) return { configured: false };
  const url = config.youtube?.channelUrl || '';
  let ch = ytChannelCache.get(url);
  if (!ch || ch.error) {
    const r = await yt.resolveChannel(env, url);
    ch = r.ok ? { id: r.id, title: r.title } : { error: r.error };
    ytChannelCache.set(url, ch);
  }
  if (ch.error) return { configured: true, ok: false, error: ch.error };
  const now = await yt.liveNow(env, ch.id);
  return { configured: true, channelId: ch.id, channelTitle: ch.title, ...now };
}

function fmtKbps(bps) {
  if (bps == null) return null;
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
}

/**
 * Verdict per destination. Inputs are what report()/watch() already fetched.
 *   liveForMs  how long the phone has been sending (null when not live)
 */
export function destinations({ config, state, phoneLive, liveForMs, probe, viewers, outputs, facebook, youtube }) {
  const out = {};
  const outputOf = (target) => {
    const cfg = config.outputs?.[target];
    const listed = outputs ? outputs.find((o) => o.uid === cfg?.uid) : null;
    if (!cfg) return null;
    return { exists: outputs ? !!listed : true, enabled: listed ? listed.enabled !== false : cfg.enabled !== false };
  };
  const live = !!phoneLive;
  const settling = (grace) => liveForMs != null && liveForMs < grace;

  // Site: Stream's own player, the source of truth for "the phone is reaching us"
  const audio = probe?.audio?.verdict;
  if (!config.liveInput?.uid) out.site = { status: 'off', title: 'No live input', detail: 'Create it in Setup.' };
  else if (!live) out.site = { status: 'idle', title: 'Waiting for the phone', detail: 'Starts by itself when Larix connects.' };
  else if (!probe?.ok) out.site = { status: settling(30e3) ? 'wait' : 'warn', title: settling(30e3) ? 'Starting' : 'Player can\'t load the feed', detail: probe?.error || 'Checking…', fix: settling(30e3) ? null : 'Usually clears in a few seconds. If it doesn\'t, stop and restart the stream in Larix.' };
  else if (audio === 'none' || audio === 'silent') out.site = { status: 'warn', title: audio === 'none' ? 'Live, no audio track' : 'Live, but silent', detail: 'Viewers see the picture with no sound.', fix: 'Check the mic (see Audio).' };
  else out.site = { status: 'ok', title: 'Live on the site', detail: [viewers != null ? `${viewers} watching` : null, probe.video?.height ? `${Math.min(probe.video.width, probe.video.height)}p` : null].filter(Boolean).join(' · ') };
  out.site.url = state.kidSlug ? `${SITE_ORIGIN}/live/${state.kidSlug}/` : `${SITE_ORIGIN}/live/`;
  out.site.viewers = viewers ?? null;

  // Facebook
  const fbOut = config.facebook?.mode === 'api' && state.fb?.outputUid ? { exists: true, enabled: true } : outputOf('facebook');
  out.facebook = { url: facebook?.permalink || config.facebook?.pageUrl || null };
  if (!fbOut) Object.assign(out.facebook, { status: 'off', title: 'Not set up', detail: config.facebook?.mode === 'api' ? 'API mode creates the output when the phone connects.' : 'Add the persistent stream key in Setup → Facebook.' });
  else if (!fbOut.exists) Object.assign(out.facebook, { status: 'warn', title: 'Output missing in Stream', detail: 'Stream has no Facebook output, so nothing is sent.', fix: 'Paste the stream key again in Setup → Facebook.' });
  else if (!fbOut.enabled) Object.assign(out.facebook, { status: 'off', title: 'Paused', detail: 'Resume it in Setup → Facebook to send the reveal there.' });
  else if (!live) Object.assign(out.facebook, { status: 'idle', title: 'Ready', detail: 'Stream sends to Facebook when the phone connects.' });
  else if (!facebook?.configured) Object.assign(out.facebook, { status: 'unknown', title: 'Sending (can\'t confirm)', detail: 'FB_PAGE_ID / FB_PAGE_TOKEN aren\'t set, so the site can\'t see the Page.', fix: 'Check the Page yourself.', action: { label: 'Live Producer', url: LIVE_PRODUCER_URL } });
  else if (facebook.ok === false) Object.assign(out.facebook, { status: 'unknown', title: 'Sending (can\'t confirm)', detail: `Facebook didn't answer: ${facebook.error}` });
  else if (facebook.live) {
    const h = facebook.health;
    const parts = h ? [h.height ? `${Math.min(h.width || h.height, h.height)}p` : null, h.fps ? `${Math.round(h.fps)} fps` : null, fmtKbps(h.videoBitrate), h.audioBitrate != null ? `audio ${fmtKbps(h.audioBitrate)}` : null].filter(Boolean) : [];
    if (h && h.audioBitrate === 0) Object.assign(out.facebook, { status: 'warn', title: 'Live, but Facebook gets no audio', detail: parts.join(' · '), fix: 'Check the mic (see Audio).' });
    else Object.assign(out.facebook, { status: 'ok', title: 'Live on Facebook', detail: parts.join(' · ') || 'The Page has a live video.' });
  } else if (settling(FB_GRACE_MS)) Object.assign(out.facebook, { status: 'wait', title: 'Starting', detail: 'Facebook usually starts the post within a minute.' });
  else Object.assign(out.facebook, config.facebook?.mode === 'api'
    ? { status: 'warn', title: 'Post not live', detail: state.fb?.lastError ? `Facebook said: ${state.fb.lastError}` : 'The site couldn\'t start the Facebook post.', fix: 'Start it from Live Producer.', action: { label: 'Open Live Producer', url: LIVE_PRODUCER_URL } }
    : { status: 'warn', title: 'Post not live', detail: 'Stream is sending the video, but the Page has no live video.', fix: 'Open Live Producer. The preview should show the feed; press Go Live.', action: { label: 'Open Live Producer', url: LIVE_PRODUCER_URL } });

  // YouTube
  const ytOut = outputOf('youtube');
  out.youtube = { url: youtube?.live?.url || config.youtube?.channelUrl || null, embed: youtube?.live?.embed || null, viewers: youtube?.live?.viewers ?? null };
  const studio = youtube?.channelId ? YT_STUDIO_URL.replace('/UC/', `/${youtube.channelId}/`) : 'https://studio.youtube.com/';
  if (!ytOut) Object.assign(out.youtube, { status: 'off', title: 'Not set up', detail: 'Optional. Add the stream key in Setup → YouTube.' });
  else if (!ytOut.exists) Object.assign(out.youtube, { status: 'warn', title: 'Output missing in Stream', detail: 'Stream has no YouTube output, so nothing is sent.', fix: 'Paste the stream key again in Setup → YouTube.' });
  else if (!ytOut.enabled) Object.assign(out.youtube, { status: 'off', title: 'Paused', detail: 'Resume it in Setup → YouTube.' });
  else if (!live) Object.assign(out.youtube, { status: 'idle', title: 'Ready', detail: 'Stream sends to YouTube when the phone connects.' });
  else if (!youtube?.configured) Object.assign(out.youtube, { status: 'unknown', title: 'Sending (can\'t confirm)', detail: 'Add YOUTUBE_API_KEY in Cloudflare and this checks the channel automatically.', action: { label: 'YouTube Studio', url: studio } });
  else if (youtube.ok === false) Object.assign(out.youtube, { status: 'unknown', title: 'Sending (can\'t confirm)', detail: `YouTube didn't answer: ${youtube.error}` });
  else if (youtube.live) Object.assign(out.youtube, { status: 'ok', title: 'Live on YouTube', detail: youtube.live.viewers != null ? `${youtube.live.viewers} watching` : 'The channel is live.' });
  else if (settling(YT_GRACE_MS)) Object.assign(out.youtube, { status: 'wait', title: 'Starting', detail: 'YouTube takes up to two minutes to show a new live.' });
  else Object.assign(out.youtube, youtube.upcoming
    ? { status: 'warn', title: 'Waiting in YouTube Studio', detail: 'YouTube has the broadcast set up but hasn\'t started it.', fix: 'Turn on Auto-start in YouTube Studio, or press Go live there.', action: { label: 'Open YouTube Studio', url: studio } }
    : { status: 'warn', title: 'Not live', detail: 'The channel has no live broadcast.', fix: 'In YouTube Studio → Go live → Stream, check the stream key matches Setup and Auto-start is on.', action: { label: 'Open YouTube Studio', url: studio } });

  // Instagram Live: manual, per broadcast, and Instagram offers no API to confirm it
  const igOut = outputOf('instagram');
  out.instagram = { url: config.instagram?.profileUrl || null };
  if (!igOut) Object.assign(out.instagram, { status: 'off', title: 'Not set up', detail: 'Optional, and set up per reveal.' });
  else if (!igOut.exists) Object.assign(out.instagram, { status: 'warn', title: 'Output missing in Stream', detail: 'Paste the URL and key again in Setup.' });
  else if (!igOut.enabled) Object.assign(out.instagram, { status: 'off', title: 'Paused', detail: 'Resume it in Setup.' });
  else if (!live) Object.assign(out.instagram, { status: 'idle', title: 'Ready', detail: 'Instagram keys only last one broadcast.' });
  else Object.assign(out.instagram, { status: 'unknown', title: 'Sending (can\'t confirm)', detail: 'Instagram has no way for the site to check. Look in the Instagram app.' });

  return out;
}

/** Everything the Control room shows for one feed. */
export async function report(env, config, state, health, { feed = 'live' } = {}) {
  const input = feed === 'rehearsal' ? config.rehearsalInput : config.liveInput;
  const at = nowIso();
  if (!input?.uid) return { success: true, feed, at, ready: false, error: feed === 'rehearsal' ? 'No rehearsal input yet (Setup → 5)' : 'No live input yet (Setup → 1)' };
  const code = config.customerCode;
  const [lc, connection, outputsRes] = await Promise.all([
    stream.lifecycle(code, input.uid),
    connectionStatus(env, input.uid),
    feed === 'live' && stream.streamConfigured(env) ? stream.listOutputs(env, input.uid).catch(() => null) : null,
  ]);
  const phoneLive = !!lc?.live;
  const [probe, viewers, facebook, youtube] = await Promise.all([
    phoneLive ? probeFeed(code, input.uid) : null,
    phoneLive && feed === 'live' ? stream.liveViewers(code, input.uid) : null,
    phoneLive && feed === 'live' ? facebookLive(env, config, state) : null,
    phoneLive && feed === 'live' ? youtubeLive(env, config).catch((e) => ({ configured: true, ok: false, error: e.message })) : null,
  ]);
  const liveAt = feed === 'live' && (state.phase === 'live' || state.phase === 'ending') ? (state.segmentAt || state.liveAt) : null;
  const liveForMs = phoneLive && liveAt ? Date.now() - Date.parse(liveAt) : null;
  const host = stream.playbackHost(code);
  return {
    success: true,
    feed, at, ready: true,
    uid: input.uid,
    phoneLive,
    connection,
    liveAt,
    orientation: config.orientation === 'portrait' ? 'portrait' : 'landscape',
    playback: { hls: `${host}/${input.uid}/manifest/video.m3u8`, llhls: input.preferLowLatency !== false ? `${host}/${input.uid}/manifest/video.m3u8?protocol=llhls` : null },
    probe,
    destinations: feed === 'live' ? destinations({ config, state, phoneLive, liveForMs, probe, viewers, outputs: outputsRes?.ok ? outputsRes.result || [] : null, facebook, youtube }) : null,
    watch: feed === 'live' ? (health?.monitor || null) : null,
  };
}

// ─── Unattended watch (runTick) ─────────────────────────────────────

const ADMIN_URL = `${SITE_ORIGIN}/admin/`;

/**
 * One watch step. Mutates health.monitor; returns nothing. Call only while
 * the phase is live and the source is Stream. Throttled to WATCH_INTERVAL_MS
 * across isolates via health.monitor.at.
 */
export async function watch(env, config, state, health, work) {
  const now = Date.now();
  let m = health.monitor;
  if (!m || m.broadcastId !== state.broadcastId) m = { broadcastId: state.broadcastId, at: null, alerts: {}, silentSince: null, frozenSince: null, lastSequence: null, sequenceAt: null };
  if (m.at && now - Date.parse(m.at) < WATCH_INTERVAL_MS) return;
  m.at = nowIso();
  const uid = config.liveInput?.uid;
  if (!uid) { health.monitor = m; return; }
  const liveFrom = Date.parse(state.segmentAt || state.liveAt || m.at);
  const liveForMs = now - liveFrom;

  const alert = async (key, level, title, detail, url = ADMIN_URL) => {
    if (m.alerts[key]) return;
    m.alerts[key] = nowIso();
    await notify.alertAdmins(env, config, { level, title, detail, url });
    work.push(`alert:${key}`);
  };

  const probe = await probeFeed(config.customerCode, uid);
  m.audio = probe.audio ? { verdict: probe.audio.verdict, levelDb: probe.audio.levelDb ?? null, silentPct: probe.audio.silentPct ?? null } : null;
  m.video = probe.video ? { height: probe.video.height, width: probe.video.width, fps: probe.video.fps, lastSequence: probe.video.lastSequence ?? null } : null;
  m.probeError = probe.error || null;

  if (probe.ok) {
    // Audio: no track at all, or silence that lasts
    const verdict = probe.audio?.verdict;
    if (verdict === 'none' && liveForMs > NO_AUDIO_GRACE_MS) {
      await alert('noAudio', 'error', 'The reveal stream has no audio track', 'Stream is getting video from the phone with no sound at all. In Larix, open Settings → Audio, make sure audio is on, then stop and restart the broadcast.');
    }
    if (verdict === 'silent') {
      m.silentSince ||= m.at;
      const silentMs = now - Date.parse(m.silentSince);
      if (silentMs >= SILENT_ALERT_MS) await alert('silent', 'error', 'Reveal audio is silent', `No sound for ${secs(silentMs)} seconds. Check the mic: wireless receiver plugged into the phone, transmitter on and unmuted, Larix not muted. The site, Facebook and YouTube all hear nothing until it's fixed.`);
    } else if (verdict === 'ok' || verdict === 'quiet') {
      if (m.alerts.silent && m.silentSince) {
        await notify.alertAdmins(env, config, { level: 'info', title: 'Reveal audio is back', detail: `Sound returned after ${secs(now - Date.parse(m.silentSince))} seconds of silence.`, url: ADMIN_URL });
        work.push('alert:audio-back');
        delete m.alerts.silent; // a second silence alerts again
      }
      m.silentSince = null;
    }

    // Picture: the playlist must keep advancing while the phone is connected
    const seq = probe.video?.lastSequence;
    if (seq != null && seq === m.lastSequence) {
      m.frozenSince ||= m.sequenceAt || m.at;
      const frozenMs = now - Date.parse(m.frozenSince);
      if (frozenMs >= FROZEN_ALERT_MS) await alert('frozen', 'error', 'Reveal video looks frozen', `Stream hasn't made new video for ${secs(frozenMs)} seconds although the phone shows as connected. The phone may have lost signal: switch Larix to the weak-signal profile, or move toward better coverage.`);
    } else if (seq != null) {
      delete m.alerts.frozen; // a later freeze alerts again
      m.lastSequence = seq; m.sequenceAt = m.at; m.frozenSince = null;
    }
  }

  // Destinations that should be live by now
  if (liveForMs > FB_GRACE_MS || liveForMs > YT_GRACE_MS) {
    const outputsRes = stream.streamConfigured(env) ? await stream.listOutputs(env, uid).catch(() => null) : null;
    const [facebook, youtube] = await Promise.all([
      liveForMs > FB_GRACE_MS ? facebookLive(env, config, state) : null,
      liveForMs > YT_GRACE_MS ? youtubeLive(env, config).catch((e) => ({ configured: true, ok: false, error: e.message })) : null,
    ]);
    const d = destinations({ config, state, phoneLive: true, liveForMs, probe, viewers: null, outputs: outputsRes?.ok ? outputsRes.result || [] : null, facebook, youtube });
    m.destinations = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.status]));
    if (facebook && d.facebook.status === 'warn') await alert('facebook', 'warn', `Facebook isn't showing the reveal (${d.facebook.title.toLowerCase()})`, `The phone has been live ${mins(liveForMs)} min. ${d.facebook.detail} ${d.facebook.fix || ''}`.trim(), d.facebook.action?.url || ADMIN_URL);
    if (youtube && d.youtube.status === 'warn') await alert('youtube', 'warn', `YouTube isn't showing the reveal (${d.youtube.title.toLowerCase()})`, `The phone has been live ${mins(liveForMs)} min. ${d.youtube.detail} ${d.youtube.fix || ''}`.trim(), d.youtube.action?.url || ADMIN_URL);
  }

  health.monitor = m;
}
