/**
 * Live feed monitor
 * =================
 * Answers "is the reveal actually reaching people, with sound?" in one
 * place, for the admin's Control room and for Slack:
 *
 *  report()   the Control room: phone connection, picture, audio (level,
 *             LUFS, left/right), signal, and a verdict per destination
 *             (site, Facebook, YouTube, Instagram) with the fix.
 *  watch()    runTick, every 15 s while live or reconnecting, nobody needed.
 *             Every problem is an issue: it opens with a Slack post (and the
 *             alert emails), gets a reminder if it is still there after 3
 *             minutes and every 10 after that, and posts again when it clears.
 *             The Control room shows the same issues with their Slack status.
 *             Once a reveal is confirmed healthy everywhere it posts "All
 *             green" (Slack and the staff texts), once per reveal.
 *  finish()   when the reveal ends: closes open issues and writes a health
 *             report (sound, issues, when Facebook/YouTube went live, peak
 *             viewers, reconnects) to History and the "Ended" Slack post.
 *  noteRehearsal()  remembers the last mic check on the rehearsal feed, for
 *             the go/no-go (_broadcast-preflight.js).
 *
 * Destination status: ok (confirmed live) · wait (starting, give it a
 * minute) · warn (needs a person; `fix` says what to do) · off (not set up
 * or paused) · unknown (can't be checked from here) · idle (phone not live).
 */

import * as stream from './_stream-live.js';
import * as fb from './_broadcast-fb.js';
import * as yt from './_youtube.js';
import * as notify from './_broadcast-notify.js';
import { probeFeed, deadSide } from './_stream-probe.js';

const SITE_ORIGIN = 'https://sunshineonaranneyday.com';
export const ADMIN_URL = `${SITE_ORIGIN}/admin/#broadcast/control-room`;
export const WATCH_INTERVAL_MS = 15 * 1000;
const REHEARSAL_INTERVAL_MS = 20 * 1000;

/** How long each problem must last before it is posted, and the reminder cadence. */
export const RULES = {
  noAudioAfter: 20e3,     // seconds live before "no audio track" counts
  silentAfter: 30e3,
  loudAfter: 20e3,
  oneSidedAfter: 30e3,
  quietAfter: 120e3,      // waiting rooms are quiet; only a long stretch counts
  frozenAfter: 30e3,
  feedAfter: 45e3,
  weakAfter: 30e3,
  disconnectedAfter: 10e3,
  fbGrace: 120e3,
  ytGrace: 150e3,
  greenAfter: 60e3,       // live this long with nothing wrong before "All green"
  remindFirst: 3 * 60e3,
  remindEvery: 10 * 60e3,
};

const FB_CACHE_MS = 20 * 1000;
const INPUT_CACHE_MS = 10 * 1000;
const LIVE_PRODUCER_URL = 'https://www.facebook.com/live/producer';
const YT_STUDIO_URL = 'https://studio.youtube.com/channel/UC/livestreaming';

const fbCache = { at: 0, key: null, value: null };
const inputCache = new Map(); // uid → { at, value }
const ytChannelCache = new Map(); // channel URL → { id, title } or { error }

const nowIso = () => new Date(Date.now()).toISOString();

/** 0:42, 3:05, 1:02:10 */
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtClock(iso, tz) {
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/New_York' }); } catch { return ''; }
}

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
  try {
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
  } catch (e) {
    return { configured: true, ok: false, error: e.message };
  }
}

function fmtKbps(bps) {
  if (bps == null) return null;
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
}

const lufsText = (x) => (x == null ? 'silent' : `${Math.round(x)} LUFS`);

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
  const siteAudio = {
    none: ['Live, no audio track', 'Viewers see the picture with no sound.'],
    silent: ['Live, but silent', 'Viewers see the picture with no sound.'],
    loud: ['Live, sound very loud', `Loudness ${lufsText(probe?.audio?.lufs)}: likely distorting.`],
    onesided: ['Live, sound on one side', `Only the ${probe?.audio?.deadSide === 'left' ? 'right' : 'left'} side has sound.`],
  }[audio];
  if (!config.liveInput?.uid) out.site = { status: 'off', title: 'No live input', detail: 'Create it in Settings → Phones.' };
  else if (!live && state?.phase === 'ending') out.site = { status: 'wait', title: 'Waiting for the phone to come back', detail: 'Up to 45 s, then the site switches to the replay.' };
  else if (!live) out.site = { status: 'idle', title: 'Waiting for the phone', detail: 'Starts by itself when Larix connects.' };
  else if (!probe?.ok) out.site = { status: settling(RULES.feedAfter) ? 'wait' : 'warn', title: settling(RULES.feedAfter) ? 'Starting' : 'Player can\'t load the feed', detail: probe?.error || 'Checking…', fix: settling(RULES.feedAfter) ? null : 'Usually clears in a few seconds. If it doesn\'t, stop and restart the stream in Larix.' };
  else if (siteAudio) out.site = { status: 'warn', title: siteAudio[0], detail: siteAudio[1], fix: 'See Sound.' };
  else out.site = { status: 'ok', title: 'Live on the site', detail: [probe.video?.height ? `${Math.min(probe.video.width, probe.video.height)}p` : null, probe.audio?.lufs != null ? lufsText(probe.audio.lufs) : null].filter(Boolean).join(' · ') };
  out.site.url = state.kidSlug ? `${SITE_ORIGIN}/live/${state.kidSlug}/` : `${SITE_ORIGIN}/live/`;
  out.site.viewers = viewers ?? null;

  // Facebook
  const fbOut = config.facebook?.mode === 'api' && state.fb?.outputUid ? { exists: true, enabled: true } : outputOf('facebook');
  out.facebook = { url: facebook?.permalink || config.facebook?.pageUrl || null };
  if (!fbOut) Object.assign(out.facebook, { status: 'off', title: 'Not set up', detail: config.facebook?.mode === 'api' ? 'API mode creates the output when the phone connects.' : 'Add the persistent stream key in Settings → Facebook.' });
  else if (!fbOut.exists) Object.assign(out.facebook, { status: 'warn', title: 'Output missing in Stream', detail: 'Stream has no Facebook output, so nothing is sent.', fix: 'Paste the stream key again in Settings → Facebook.' });
  else if (!fbOut.enabled) Object.assign(out.facebook, { status: 'off', title: 'Paused', detail: 'Resume it in Settings → Facebook to send the reveal there.' });
  else if (!live) Object.assign(out.facebook, { status: 'idle', title: 'Ready', detail: 'Stream sends to Facebook when the phone connects.' });
  else if (!facebook?.configured) Object.assign(out.facebook, { status: 'unknown', title: 'Sending (can\'t confirm)', detail: 'FB_PAGE_ID / FB_PAGE_TOKEN aren\'t set, so the site can\'t see the Page.', fix: 'Check the Page yourself.', action: { label: 'Live Producer', url: LIVE_PRODUCER_URL } });
  else if (facebook.ok === false) Object.assign(out.facebook, { status: 'unknown', title: 'Sending (can\'t confirm)', detail: `Facebook didn't answer: ${facebook.error}` });
  else if (facebook.live) {
    const h = facebook.health;
    const parts = h ? [h.height ? `${Math.min(h.width || h.height, h.height)}p` : null, h.fps ? `${Math.round(h.fps)} fps` : null, fmtKbps(h.videoBitrate), h.audioBitrate != null ? `audio ${fmtKbps(h.audioBitrate)}` : null].filter(Boolean) : [];
    if (h && h.audioBitrate === 0) Object.assign(out.facebook, { status: 'warn', title: 'Live, but Facebook gets no audio', detail: parts.join(' · '), fix: 'Check the mic (see Sound).' });
    else Object.assign(out.facebook, { status: 'ok', title: 'Live on Facebook', detail: parts.join(' · ') || 'The Page has a live video.' });
  } else if (settling(RULES.fbGrace)) Object.assign(out.facebook, { status: 'wait', title: 'Starting', detail: 'Facebook usually starts the post within a minute.' });
  else Object.assign(out.facebook, config.facebook?.mode === 'api'
    ? { status: 'warn', title: 'Post not live', detail: state.fb?.lastError ? `Facebook said: ${state.fb.lastError}` : 'The site couldn\'t start the Facebook post.', fix: 'Start it from Live Producer.', action: { label: 'Open Live Producer', url: LIVE_PRODUCER_URL } }
    : { status: 'warn', title: 'Post not live', detail: 'Stream is sending the video, but the Page has no live video.', fix: 'Open Live Producer. The preview should show the feed; press Go Live.', action: { label: 'Open Live Producer', url: LIVE_PRODUCER_URL } });

  // YouTube
  const ytOut = outputOf('youtube');
  out.youtube = { url: youtube?.live?.url || config.youtube?.channelUrl || null, embed: youtube?.live?.embed || null, viewers: youtube?.live?.viewers ?? null };
  const studio = youtube?.channelId ? YT_STUDIO_URL.replace('/UC/', `/${youtube.channelId}/`) : 'https://studio.youtube.com/';
  if (!ytOut) Object.assign(out.youtube, { status: 'off', title: 'Not set up', detail: 'Optional. Add the stream key in Settings → YouTube.' });
  else if (!ytOut.exists) Object.assign(out.youtube, { status: 'warn', title: 'Output missing in Stream', detail: 'Stream has no YouTube output, so nothing is sent.', fix: 'Paste the stream key again in Settings → YouTube.' });
  else if (!ytOut.enabled) Object.assign(out.youtube, { status: 'off', title: 'Paused', detail: 'Resume it in Settings → YouTube.' });
  else if (!live) Object.assign(out.youtube, { status: 'idle', title: 'Ready', detail: 'Stream sends to YouTube when the phone connects.' });
  else if (!youtube?.configured) Object.assign(out.youtube, { status: 'unknown', title: 'Sending (can\'t confirm)', detail: 'Add YOUTUBE_API_KEY in Cloudflare and this checks the channel automatically.', action: { label: 'YouTube Studio', url: studio } });
  else if (youtube.ok === false) Object.assign(out.youtube, { status: 'unknown', title: 'Sending (can\'t confirm)', detail: `YouTube didn't answer: ${youtube.error}` });
  else if (youtube.live) Object.assign(out.youtube, { status: 'ok', title: 'Live on YouTube', detail: youtube.live.viewers != null ? `${youtube.live.viewers} watching` : 'The channel is live.' });
  else if (settling(RULES.ytGrace)) Object.assign(out.youtube, { status: 'wait', title: 'Starting', detail: 'YouTube takes up to two minutes to show a new live.' });
  else Object.assign(out.youtube, youtube.upcoming
    ? { status: 'warn', title: 'Waiting in YouTube Studio', detail: 'YouTube has the broadcast set up but hasn\'t started it.', fix: 'Turn on Auto-start in YouTube Studio, or press Go live there.', action: { label: 'Open YouTube Studio', url: studio } }
    : { status: 'warn', title: 'Not live', detail: 'The channel has no live broadcast.', fix: 'In YouTube Studio → Go live → Stream, check the stream key matches Settings → YouTube and Auto-start is on.', action: { label: 'Open YouTube Studio', url: studio } });

  // Instagram Live: manual, per broadcast, and Instagram offers no API to confirm it
  const igOut = outputOf('instagram');
  out.instagram = { url: config.instagram?.profileUrl || null };
  if (!igOut) Object.assign(out.instagram, { status: 'off', title: 'Not set up', detail: 'Optional, and set up per reveal.' });
  else if (!igOut.exists) Object.assign(out.instagram, { status: 'warn', title: 'Output missing in Stream', detail: 'Paste the URL and key again in Settings → Instagram.' });
  else if (!igOut.enabled) Object.assign(out.instagram, { status: 'off', title: 'Paused', detail: 'Resume it in Settings → Instagram.' });
  else if (!live) Object.assign(out.instagram, { status: 'idle', title: 'Ready', detail: 'Instagram keys only last one broadcast.' });
  else Object.assign(out.instagram, { status: 'unknown', title: 'Sending (can\'t confirm)', detail: 'Instagram has no way for the site to check. Look in the Instagram app.' });

  return out;
}

/** Everything the Control room shows for one feed. */
export async function report(env, config, state, health, { feed = 'live' } = {}) {
  const input = feed === 'rehearsal' ? config.rehearsalInput : config.liveInput;
  const at = nowIso();
  if (!input?.uid) return { success: true, feed, at, ready: false, error: feed === 'rehearsal' ? 'No rehearsal input yet (Settings → Phones)' : 'No live input yet (Settings → Phones)' };
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
    phoneLive && feed === 'live' ? youtubeLive(env, config) : null,
  ]);
  const liveAt = feed === 'live' && (state.phase === 'live' || state.phase === 'ending') ? (state.segmentAt || state.liveAt) : null;
  const liveForMs = phoneLive && liveAt ? Date.now() - Date.parse(liveAt) : null;
  const host = stream.playbackHost(code);
  const m = feed === 'live' && health?.monitor?.broadcastId === state.broadcastId ? health.monitor : null;
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
    slack: notify.slackConfigured(env),
    watch: m ? { at: m.at, issues: Object.values(m.issues || {}), log: (m.log || []).slice(-20), signal: m.signal || null, audio: m.audio || null, peakViewers: m.peakViewers ?? null } : null,
    rehearsal: health?.rehearsal || null,
    preflight: health?.preflight?.last || null,
  };
}

// ─── Issues ─────────────────────────────────────────────────────────

/** What each issue says when it clears. */
const RESOLVED = {
  noAudio: 'The reveal has sound again',
  silent: 'Reveal audio is back',
  loud: 'Reveal audio is back to a normal level',
  oneSided: 'Sound is on both sides again',
  quiet: 'Reveal audio is loud enough again',
  frozen: 'Reveal video is moving again',
  feed: 'Viewers can load the reveal again',
  weakSignal: 'The phone\'s signal is steady again',
  disconnected: 'The phone is back',
  facebook: 'Facebook is live now',
  youtube: 'YouTube is live now',
};

function freshMonitor(state) {
  return {
    broadcastId: state.broadcastId, at: null, startedAt: nowIso(),
    issues: {}, pending: {}, closed: [], log: [],
    seq: [], reconnects: [], lastSegmentAt: state.segmentAt || null,
    firsts: {}, series: [], stats: {}, lufsPower: 0, lufsCount: 0, peakViewers: null,
    audio: null, video: null, signal: null, destinations: null,
  };
}

const slackStatus = (r) => (r?.skipped ? { skipped: true } : { ok: !!r?.ok, error: r?.ok ? null : (r?.error || null) });

function makeCtx(env, config, state, m, work, record) {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const liveFrom = Date.parse(state.liveAt || m.startedAt);
  const context = `${state.title || 'Live reveal'} · live ${fmtDur(now - liveFrom)}`;
  // One Slack thread per problem per broadcast: reminders reply in it, clearing turns it ✅
  const issueKey = (key) => `live:${state.broadcastId || 'broadcast'}:${key}`;
  const log = (entry) => { m.log.push({ at, ...entry }); if (m.log.length > 40) m.log.splice(0, m.log.length - 40); };

  const raise = async (key, { level = 'warn', title, detail, fix, links = [], after = 0 }) => {
    m.pending[key] ||= at;
    if (now - Date.parse(m.pending[key]) < after) return;
    const open = m.issues[key];
    if (open) {
      Object.assign(open, { level, title, detail, fix });
      const last = Date.parse(open.remindedAt || open.postedAt || open.since);
      if (now - last < (open.remindedAt ? RULES.remindEvery : RULES.remindFirst)) return;
      const r = await notify.alertAdmins(env, config, { level, title: `Still: ${title}`, detail: `${detail} Going on ${fmtDur(now - Date.parse(open.since))}.`, fix, url: ADMIN_URL, links, context, issue: issueKey(key) });
      open.remindedAt = at;
      open.reminders = (open.reminders || 0) + 1;
      open.slack = slackStatus(r.slack);
      log({ key, kind: 'reminder', title, slack: open.slack });
      work.push(`remind:${key}`);
      return;
    }
    // Something failing during the reveal itself buzzes whoever is watching the alerts channel
    const r = await notify.alertAdmins(env, config, { level, title, detail, fix, url: ADMIN_URL, links, context, issue: issueKey(key), urgent: level === 'error', text: true });
    m.issues[key] = { key, level, title, detail, fix, since: m.pending[key], postedAt: at, slack: slackStatus(r.slack) };
    log({ key, kind: 'open', title, slack: m.issues[key].slack });
    await record(env.DB, state.broadcastId, 'issue', { key, level, title });
    work.push(`alert:${key}`);
  };

  const clear = async (key, { quiet = false } = {}) => {
    delete m.pending[key];
    const open = m.issues[key];
    if (!open) return;
    delete m.issues[key];
    const lasted = now - Date.parse(open.since);
    m.closed.push({ key, title: open.title, since: open.since, resolvedAt: at, seconds: Math.round(lasted / 1000) });
    if (m.closed.length > 30) m.closed.shift();
    let slack = null;
    if (!quiet) {
      const r = await notify.alertAdmins(env, config, { level: 'info', title: RESOLVED[key] || `Resolved: ${open.title}`, detail: `It lasted ${fmtDur(lasted)}.`, url: ADMIN_URL, context, resolves: issueKey(key), text: true });
      slack = slackStatus(r.slack);
      work.push(`resolved:${key}`);
    }
    log({ key, kind: 'resolved', title: RESOLVED[key] || open.title, slack });
    await record(env.DB, state.broadcastId, 'issue_resolved', { key, seconds: Math.round(lasted / 1000) });
  };

  return { now, at, liveForMs: now - liveFrom, context, work, raise, clear };
}

/**
 * One watch step. Mutates health.monitor; never throws on bad network.
 * Call while the phase is live or ending and the source is Stream.
 * `record(DB, broadcastId, type, meta)` writes an analytics event.
 */
export async function watch(env, config, state, health, work, record = async () => {}) {
  let m = health.monitor;
  if (!m || m.broadcastId !== state.broadcastId) m = freshMonitor(state);
  health.monitor = m;
  if (m.at && Date.now() - Date.parse(m.at) < WATCH_INTERVAL_MS) return;
  const uid = config.liveInput?.uid;
  const c = makeCtx(env, config, state, m, work, record);
  m.at = c.at;
  if (!uid) return;

  // Reconnects show up as a new segmentAt
  if (state.segmentAt && state.segmentAt !== m.lastSegmentAt) {
    if (m.lastSegmentAt) m.reconnects.push(c.at);
    m.lastSegmentAt = state.segmentAt;
  }

  if (state.phase === 'ending') {
    await c.raise('disconnected', { level: 'error', after: RULES.disconnectedAfter, title: 'The phone lost its connection', detail: 'The site shows "reconnecting" and waits up to 45 seconds before ending the reveal.', fix: 'Check that Larix is still streaming. If it stopped, tap Start: the reveal picks up where it left off.' });
    return;
  }
  await c.clear('disconnected');

  const code = config.customerCode;
  const [probe, viewers, connection, outputsRes, facebook, youtube] = await Promise.all([
    probeFeed(code, uid),
    stream.liveViewers(code, uid),
    connectionStatus(env, uid),
    stream.streamConfigured(env) ? stream.listOutputs(env, uid).catch(() => null) : null,
    facebookLive(env, config, state),
    youtubeLive(env, config),
  ]);
  if (viewers != null) m.peakViewers = Math.max(m.peakViewers ?? 0, viewers);
  m.probeError = probe.error || null;

  // The feed itself
  if (!probe.ok) {
    if (c.liveForMs > RULES.feedAfter) await c.raise('feed', { level: 'error', after: RULES.feedAfter, title: 'Viewers can\'t load the reveal', detail: `Stream says the phone is live, but the player can't load the video (${probe.error}).`, fix: 'Stop and restart the stream in Larix. If it keeps failing, put the emergency banner up from the Now tab and go live from the Facebook app.' });
  } else {
    await c.clear('feed');
    const a = probe.audio || {};
    const verdict = a.verdict;
    m.audio = { verdict, lufs: a.lufs ?? null, levelDb: a.levelDb ?? null, leftDb: a.leftDb ?? null, rightDb: a.rightDb ?? null, channels: a.channels ?? null };
    m.video = probe.video ? { width: probe.video.width, height: probe.video.height, fps: probe.video.fps, lastSequence: probe.video.lastSequence ?? null } : null;
    m.stats[verdict] = (m.stats[verdict] || 0) + 1;
    if (a.lufs != null) { m.lufsPower += Math.pow(10, a.lufs / 10); m.lufsCount++; }
    const last = m.series[m.series.length - 1];
    if (!last || c.liveForMs / 1000 - last[0] >= 30) {
      m.series.push([Math.round(c.liveForMs / 1000), a.lufs != null ? Math.round(a.lufs) : null, (verdict || 'u')[0]]);
      if (m.series.length > 240) m.series.shift();
    }

    // Sound: each verdict is its own issue so a change of problem reads clearly in Slack
    if (verdict === 'none') {
      if (c.liveForMs > RULES.noAudioAfter) await c.raise('noAudio', { level: 'error', title: 'The reveal has no sound track', detail: 'Stream is getting video from the phone with no audio at all, so the site, Facebook and YouTube are silent.', fix: 'In Larix: Settings → Audio, turn audio on, then stop and start the stream.' });
    } else if (verdict !== 'unknown') await c.clear('noAudio');
    const sound = {
      silent: ['silent', { level: 'error', after: RULES.silentAfter, title: 'Reveal audio is silent', detail: 'No sound reaching the site, Facebook or YouTube.', fix: 'Check the mic: receiver plugged into the phone, transmitter switched on and unmuted, Larix not muted.' }],
      loud: ['loud', { level: 'warn', after: RULES.loudAfter, title: 'Reveal audio is very loud', detail: `Loudness ${lufsText(a.lufs)} (aim for about -16). It is probably distorting.`, fix: 'Turn the gain down on the mic transmitter, or move the mic a little further from the loudest voice.' }],
      onesided: ['oneSided', { level: 'warn', after: RULES.oneSidedAfter, title: `Sound is only on the ${deadSide(a) === 'left' ? 'right' : 'left'} side`, detail: 'Viewers with headphones hear it in one ear only.', fix: 'Set Larix audio to mono (Settings → Audio → Channels: 1), or reseat the mic receiver\'s cable in the phone.' }],
      quiet: ['quiet', { level: 'warn', after: RULES.quietAfter, title: 'Reveal audio is very quiet', detail: `Loudness ${lufsText(a.lufs)} (aim for about -16).`, fix: 'Move the mic closer to whoever is talking, or turn up the gain on the mic transmitter.' }],
    };
    if (verdict !== 'unknown') {
      for (const [v, [key, spec]] of Object.entries(sound)) {
        if (verdict === v) await c.raise(key, spec); else await c.clear(key);
      }
    }

    // Picture and signal: the playlist must keep pace with real time
    const seq = probe.video?.lastSequence;
    const segSec = probe.video?.avgSegmentSec || probe.video?.segmentSec || 4;
    if (seq != null) {
      if (m.lastSequence === seq) {
        m.frozenSince ||= m.sequenceAt || c.at;
        if (c.now - Date.parse(m.frozenSince) >= RULES.frozenAfter) await c.raise('frozen', { level: 'error', title: 'Reveal video is frozen', detail: `No new video for ${fmtDur(c.now - Date.parse(m.frozenSince))} although the phone shows as connected.`, fix: 'The phone is probably losing signal: switch Larix to the weak-signal profile, or move toward better coverage.' });
      } else {
        m.lastSequence = seq; m.sequenceAt = c.at; m.frozenSince = null;
        await c.clear('frozen');
      }
      m.seq = [...m.seq.filter(([t]) => c.now - t <= 120e3), [c.now, seq, segSec]];
    }
    const base = m.seq.find(([t]) => c.now - t >= 45e3);
    const ratio = base && seq != null ? ((seq - base[1]) * segSec) / ((c.now - base[0]) / 1000) : null;
    const recent = m.reconnects.filter((t) => c.now - Date.parse(t) <= 5 * 60e3).length;
    const reconnecting = connection === 'reconnecting';
    const status = (ratio != null && ratio < 0.7) || recent >= 2 || reconnecting ? 'weak' : (ratio != null && ratio < 0.9) || recent === 1 ? 'unsteady' : 'strong';
    m.signal = { status, ratio: ratio != null ? Math.round(ratio * 100) / 100 : null, reconnects5m: recent, connection };
    if (status === 'weak') {
      const why = recent >= 2 ? `The phone dropped ${recent} times in the last 5 minutes.` : reconnecting ? 'Stream says the phone is reconnecting.' : `Video is arriving at ${Math.round(ratio * 100)}% of real time, so viewers see stutters and stops.`;
      await c.raise('weakSignal', { level: 'warn', after: RULES.weakAfter, title: 'The phone\'s signal is weak', detail: why, fix: 'Switch Larix to the Weak signal profile (Settings → Phones), move toward a window, or join the house Wi-Fi.' });
    } else if (status === 'strong') await c.clear('weakSignal');
  }

  // Destinations: confirmed live times go in the report; problems after their grace go to Slack
  const d = destinations({ config, state, phoneLive: true, liveForMs: c.liveForMs, probe, viewers, outputs: outputsRes?.ok ? outputsRes.result || [] : null, facebook, youtube });
  m.destinations = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.status]));
  for (const [key, label] of [['facebook', 'Facebook'], ['youtube', 'YouTube']]) {
    const v = d[key];
    if (v.status === 'ok' && m.firsts[key] == null) m.firsts[key] = Math.round(c.liveForMs / 1000);
    if (v.status === 'warn') await c.raise(key, { level: 'warn', title: `${label} isn't showing the reveal (${v.title.toLowerCase()})`, detail: v.detail, fix: v.fix || null, links: v.action ? [v.action] : [] });
    else if (v.status === 'ok' || v.status === 'off') await c.clear(key, { quiet: v.status === 'off' });
  }

  await allGreen(env, config, state, m, c, d);
}

/**
 * "All green", once per reveal: a minute in, nothing wrong or about to be,
 * sound and picture good, and every destination that's set up confirmed
 * live (one that can't be checked from here is named as unconfirmed).
 * A reveal that had a problem says it a minute after the last one cleared,
 * so it confirms the reveal is steady rather than echoing the fix.
 */
async function allGreen(env, config, state, m, c, d) {
  if (m.greenAt || c.liveForMs < RULES.greenAfter) return;
  if (Object.keys(m.issues).length || Object.keys(m.pending).length) return;
  const lastFix = m.closed[m.closed.length - 1]?.resolvedAt;
  if (lastFix && c.now - Date.parse(lastFix) < RULES.greenAfter) return;
  if (m.audio?.verdict !== 'ok' || m.signal?.status === 'weak' || d.site?.status !== 'ok') return;
  const places = [['facebook', 'Facebook'], ['youtube', 'YouTube']].filter(([k]) => d[k]?.status !== 'off');
  if (places.some(([k]) => !['ok', 'unknown'].includes(d[k]?.status))) return;
  const name = (list) => list.join(', ').replace(/, ([^,]*)$/, ' and $1');
  const live = ['the site', ...places.filter(([k]) => d[k].status === 'ok').map(([, l]) => l)];
  const unsure = places.filter(([k]) => d[k].status === 'unknown').map(([, l]) => l);
  const detail = `Sound and picture are good, and it's live on ${name(live)}.${unsure.length ? ` ${name(unsure)} can't be confirmed from here.` : ''}`;
  m.greenAt = c.at;
  const r = await notify.alertAdmins(env, config, { level: 'info', kind: 'news', icon: '🟢', title: `All green: ${state.title || 'the reveal'}`, detail, url: ADMIN_URL, context: c.context, text: true });
  m.log.push({ at: c.at, kind: 'green', title: 'All green', slack: slackStatus(r.slack) });
  c.work.push('all-green');
}

// ─── End of broadcast ───────────────────────────────────────────────

/**
 * Close the monitor for a finished reveal: open issues end with it, and a
 * compact health report goes to History (broadcast_events 'health_report').
 * → { report, summary } where summary is the paragraph for the "Ended" post.
 */
export async function finish(env, config, state, health, record = async () => {}) {
  const m = health.monitor;
  if (!m || m.broadcastId !== state.broadcastId) return { report: null, summary: '' };
  const end = Date.parse(state.endedAt || nowIso());
  const liveFrom = Date.parse(state.liveAt || m.startedAt);
  for (const [key, open] of Object.entries(m.issues)) {
    m.closed.push({ key, title: open.title, since: open.since, resolvedAt: new Date(end).toISOString(), seconds: Math.round((end - Date.parse(open.since)) / 1000), atEnd: true });
  }
  m.issues = {};
  const probes = Object.values(m.stats).reduce((a, n) => a + n, 0);
  const okPct = probes ? Math.round(((m.stats.ok || 0) / probes) * 100) : null;
  const lufs = m.lufsCount ? Math.round(10 * Math.log10(m.lufsPower / m.lufsCount) * 10) / 10 : null;
  const report = {
    v: 1,
    minutes: Math.round((end - liveFrom) / 60000),
    okPct, lufs,
    stats: m.stats,
    issues: m.closed.map((x) => ({ k: x.key, t: x.title, at: Math.round((Date.parse(x.since) - liveFrom) / 1000), s: x.seconds, ...(x.atEnd ? { e: 1 } : {}) })),
    fb: m.firsts.facebook ?? null,
    yt: m.firsts.youtube ?? null,
    peak: m.peakViewers ?? null,
    reconnects: m.reconnects.length,
    series: m.series.map(([t, l, v]) => [t, l, v]),
  };
  // Events hold 2000 characters: thin the loudness series until the report fits
  let json = JSON.stringify(report);
  while (json.length > 1950 && report.series.length > 8) {
    report.series = report.series.filter((_, i) => i % 2 === 0);
    json = JSON.stringify(report);
  }
  if (json.length > 1950) { report.issues = report.issues.slice(-8); report.series = []; }
  await record(env.DB, state.broadcastId, 'health_report', report);

  const tz = config.timezone;
  const parts = [];
  if (okPct != null) parts.push(`Sound good ${okPct}% of the time${lufs != null ? ` (average ${Math.round(lufs)} LUFS)` : ''}.`);
  parts.push(m.closed.length
    ? `Issues: ${m.closed.slice(0, 6).map((x) => `${x.title.toLowerCase()} at ${fmtClock(x.since, tz)} for ${fmtDur(x.seconds * 1000)}${x.atEnd ? ' (still open at the end)' : ''}`).join('; ')}.`
    : 'No issues.');
  const firsts = [m.firsts.facebook != null ? `Facebook live after ${fmtDur(m.firsts.facebook * 1000)}` : null, m.firsts.youtube != null ? `YouTube after ${fmtDur(m.firsts.youtube * 1000)}` : null].filter(Boolean);
  if (firsts.length) parts.push(`${firsts.join(', ')}.`);
  if (m.peakViewers != null) parts.push(`Peak ${m.peakViewers} watching on the site.`);
  if (m.reconnects.length) parts.push(`${m.reconnects.length} reconnect${m.reconnects.length > 1 ? 's' : ''}.`);
  return { report, summary: parts.join(' ') };
}

// ─── Rehearsal (mic checks) ─────────────────────────────────────────

/**
 * Remember what a rehearsal-feed probe heard, for the go/no-go. Returns true
 * when health.rehearsal changed.
 */
export function noteRehearsal(health, probe) {
  if (!probe?.ok || !probe.audio) return false;
  const a = probe.audio;
  const prev = health.rehearsal || {};
  const at = probe.at || nowIso();
  health.rehearsal = {
    lastAt: at,
    verdict: a.verdict,
    lufs: a.lufs ?? null,
    leftDb: a.leftDb ?? null,
    rightDb: a.rightDb ?? null,
    video: probe.video ? { width: probe.video.width, height: probe.video.height } : null,
    goodAt: a.verdict === 'ok' ? at : (prev.goodAt || null),
    goodLufs: a.verdict === 'ok' ? (a.lufs ?? null) : (prev.goodLufs ?? null),
    checkedAt: at,
  };
  return true;
}

let lastRehearsalCheck = 0; // per isolate: a timestamp in health would cost a D1 write every tick

/** runTick: when someone streams to the rehearsal input, note the mic check (every 20 s). */
export async function watchRehearsal(env, config, health) {
  const uid = config.rehearsalInput?.uid;
  if (!uid || Date.now() - lastRehearsalCheck < REHEARSAL_INTERVAL_MS) return false;
  lastRehearsalCheck = Date.now();
  const lc = await stream.lifecycle(config.customerCode, uid);
  if (!lc?.live) return false;
  return noteRehearsal(health, await probeFeed(config.customerCode, uid));
}
