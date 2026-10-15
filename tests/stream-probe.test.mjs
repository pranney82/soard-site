/**
 * Live feed monitor: AAC level reader, HLS probe, destination verdicts,
 * Slack issues, end-of-reveal report, go/no-go.
 * Run: node --test tests/
 *
 * Fixtures (tests/fixtures/aac/) are one-second AAC-LC 48 kHz clips made
 * with FFmpeg 6.0. Expected values are FFmpeg's own decode: astats RMS per
 * channel and ebur128 integrated loudness.
 *   init.mp4 + silence.m4s     stereo digital silence        -inf
 *   init.mp4 + pink-32.m4s     pink noise, L = R             -32.6 dBFS, -30.5 LUFS
 *   init.mp4 + speech-40.m4s   speech, L = R                 -40.2 dBFS, -37.2 LUFS
 *   speech-40.ts               same speech, MPEG-TS/ADTS     -40.2 dBFS
 *   init.mp4 + left-only.m4s   tone on the left only         L -35.2, R -inf, -35.8 LUFS
 *   init.mp4 + wide.m4s        independent noise L/R         L -24.3, R -44.9, -25.2 LUFS
 *   init.mp4 + loud.m4s        full-scale white noise        -6.9 dBFS, -0.9 LUFS
 *   mono-init.mp4 + mono.m4s   mono speech (SCE)             -27.1 dBFS, -27.1 LUFS
 *   intensity-init.mp4 + intensity.m4s   R = L/2 coded as intensity stereo   L -27.1, R -32.1
 * Speech reads up to ~2 dB low on one-second clips (the decoder skips TNS);
 * on Stream's 8-second probe window it is within about 1 dB.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeSegment, analyzeSegments, configFromInit } from '../functions/api/_aac-level.js';
import { parseMaster, parseMedia, probeFeed, audioVerdict, deadSide } from '../functions/api/_stream-probe.js';
import { destinations, watch, finish, noteRehearsal, RULES } from '../functions/api/_broadcast-monitor.js';
import * as preflight from '../functions/api/_broadcast-preflight.js';

const fx = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/aac/${name}`, import.meta.url)));
const INIT = fx('init.mp4');
const near = (actual, expected, tol, msg) => assert.ok(actual != null && Math.abs(actual - expected) <= tol, `${msg}: ${actual} not within ${tol} of ${expected}`);

// ─── AAC level reader ───────────────────────────────────────────────

test('reads the AAC config and audio track from an fMP4 init segment', () => {
  assert.deepEqual(configFromInit(INIT), { aot: 2, sfIndex: 3, sampleRate: 48000, channels: 2, trackId: 1 });
  assert.equal(configFromInit(fx('mono-init.mp4')).channels, 1);
});

test('digital silence reads as silent', () => {
  const r = analyzeSegment({ init: INIT, segment: fx('silence.m4s') });
  assert.equal(r.supported, true);
  assert.ok(r.frames > 40);
  assert.equal(r.failed, 0);
  assert.equal(r.levelDb, null);
  assert.equal(r.lufs, null);
  assert.equal(r.silentPct, 100);
});

test('levels and loudness match the reference decode', () => {
  const pink = analyzeSegment({ init: INIT, segment: fx('pink-32.m4s') });
  near(pink.leftDb, -32.6, 0.5, 'pink left');
  near(pink.rightDb, -32.6, 0.5, 'pink right');
  near(pink.lufs, -30.5, 0.5, 'pink LUFS');
  assert.equal(pink.failed, 0);
  const loud = analyzeSegment({ init: INIT, segment: fx('loud.m4s') });
  near(loud.levelDb, -6.9, 0.5, 'full-scale noise level');
  near(loud.lufs, -0.9, 0.5, 'full-scale noise LUFS');
  const speech = analyzeSegment({ init: INIT, segment: fx('speech-40.m4s') });
  near(speech.levelDb, -40.2, 3, 'speech (fMP4)');
  near(speech.lufs, -37.2, 3, 'speech LUFS');
  const ts = analyzeSegment({ segment: fx('speech-40.ts') });
  near(ts.levelDb, -40.2, 3, 'speech (MPEG-TS)');
  assert.equal(ts.failed, 0);
});

test('stereo is undone into true left and right (mid/side, intensity, one side dead)', () => {
  const left = analyzeSegment({ init: INIT, segment: fx('left-only.m4s') });
  assert.equal(left.channels, 2);
  near(left.leftDb, -35.2, 0.5, 'left-only: left');
  assert.equal(left.rightDb, null, 'left-only: right is digital silence');
  near(left.lufs, -35.8, 0.5, 'left-only LUFS');
  const wide = analyzeSegment({ init: INIT, segment: fx('wide.m4s') });
  near(wide.leftDb, -24.3, 0.5, 'wide: left');
  near(wide.rightDb, -44.9, 0.5, 'wide: right');
  near(wide.lufs, -25.2, 0.5, 'wide LUFS');
  const is = analyzeSegment({ init: fx('intensity-init.mp4'), segment: fx('intensity.m4s') });
  near(is.leftDb, -27.1, 0.5, 'intensity: left');
  near(is.rightDb, -32.1, 0.5, 'intensity: right');
});

test('mono (single channel element) reads as one channel', () => {
  const r = analyzeSegment({ init: fx('mono-init.mp4'), segment: fx('mono.m4s') });
  assert.equal(r.channels, 1);
  assert.equal(r.rightDb, null);
  near(r.levelDb, -27.1, 3, 'mono speech');
  near(r.lufs, -27.1, 3, 'mono LUFS');
});

test('without an init segment fMP4 audio is reported unsupported, not guessed', () => {
  assert.equal(analyzeSegment({ segment: fx('pink-32.m4s') }).supported, false);
});

test('several segments are measured as one window', () => {
  const a = analyzeSegment({ init: INIT, segment: fx('pink-32.m4s') });
  const s = analyzeSegment({ init: INIT, segment: fx('silence.m4s') });
  const m = analyzeSegments({ init: INIT, segments: [fx('pink-32.m4s'), fx('silence.m4s')] });
  near(m.levelDb, a.levelDb - 3, 0.5, 'half noise, half silence is ~3 dB down');
  assert.equal(m.frames, a.frames + s.frames);
  assert.ok(m.silentPct > 40 && m.silentPct < 60);
  near(m.lufs, a.lufs, 1.5, 'gating drops the silent half (blocks straddling the edge pull it ~1 dB)');
});

// ─── Manifests ──────────────────────────────────────────────────────

const HOST = 'https://customer-test.cloudflarestream.com';
const masterWithAudio = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_audio",NAME="original",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:RESOLUTION=1080x1920,CODECS="avc1.4d4028,mp4a.40.2",BANDWIDTH=4005042,AVERAGE-BANDWIDTH=2507481,FRAME-RATE=30.000,AUDIO="group_audio"
v1080.m3u8
#EXT-X-STREAM-INF:RESOLUTION=720x1280,CODECS="avc1.4d401f,mp4a.40.2",BANDWIDTH=2036226,FRAME-RATE=30.000,AUDIO="group_audio"
v720.m3u8
`;
const masterNoAudio = `#EXTM3U
#EXT-X-STREAM-INF:RESOLUTION=1920x1080,CODECS="avc1.4d4028",BANDWIDTH=3000000,FRAME-RATE=30
v1080.m3u8
`;
const livePlaylist = (seq, seg = 'a') => `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:${seq}
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-10-14T18:00:00.000Z
#EXTINF:4.000,
${seg}1.m4s
#EXTINF:4.000,
${seg}2.m4s
`;

test('parses a Stream master manifest (renditions, separate audio group)', () => {
  const m = parseMaster(masterWithAudio, `${HOST}/x/manifest/video.m3u8`);
  assert.equal(m.variants.length, 2);
  assert.equal(m.variants[0].height, 1920);
  assert.equal(m.variants[0].fps, 30);
  assert.equal(m.variants[0].uri, `${HOST}/x/manifest/v1080.m3u8`);
  assert.equal(m.audio[0].uri, `${HOST}/x/manifest/audio.m3u8`);
});

test('parses a live media playlist (sequence, init map, date-times)', () => {
  const p = parseMedia(livePlaylist(41), `${HOST}/x/manifest/v1080.m3u8`);
  assert.equal(p.mediaSequence, 41);
  assert.equal(p.lastSequence, 42);
  assert.equal(p.endList, false);
  assert.equal(p.map, `${HOST}/x/manifest/init.mp4`);
  assert.equal(p.segments[0].pdt, Date.parse('2026-10-14T18:00:00.000Z'));
});

// ─── Fake network ───────────────────────────────────────────────────

const feeds = {};       // uid → { master, audioSeg, seq, viewers }
const slack = [];       // payloads posted to the Slack webhook
let slackStatus = 200;
const graph = { live: false, scheduled: false };
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'hooks.slack.test') { slack.push(JSON.parse(init.body)); return new Response(slackStatus === 200 ? 'ok' : 'error', { status: slackStatus }); }
    if (url.hostname === 'graph.facebook.test' || url.hostname === 'graph.facebook.com') {
      if (url.pathname.endsWith('/videos')) return json({ data: graph.live ? [{ id: 'v1', live_status: 'LIVE', permalink_url: '/soard/videos/1/', title: 'Reveal' }] : graph.scheduled ? [{ id: 'v0', live_status: 'SCHEDULED_UNPUBLISHED', title: 'Sam\'s reveal' }] : [] });
      return json({ id: 'page', name: 'SOARD', link: 'https://facebook.com/soard' });
    }
    if (url.hostname === 'api.cloudflare.com') {
      if (url.pathname.endsWith('/outputs')) return json({ success: true, result: [{ uid: 'o-fb', enabled: true }] });
      if (url.pathname.includes('/live_inputs/')) return json({ success: true, result: { uid: 'reveal', enabled: true, status: 'connected' } });
      return json({ success: true, result: [] });
    }
    if (url.hostname !== 'customer-test.cloudflarestream.com') return new Response('not mocked', { status: 599 });
    const [, uid, kind, file] = url.pathname.split('/');
    const f = feeds[uid];
    if (!f) return new Response('404 not found', { status: 404 });
    if (kind === 'views') return json({ liveViewers: f.viewers ?? 3 });
    if (kind === 'lifecycle') return json({ isInput: true, live: true, videoUID: 'v' });
    if (file === 'video.m3u8') return new Response(f.master);
    if (file === 'audio.m3u8') return new Response(livePlaylist(f.seq, 'a'));
    if (file === 'v1080.m3u8') return new Response(livePlaylist(f.seq, 'v'));
    if (file === 'init.mp4') return new Response(INIT);
    if (/^a\d\.m4s$/.test(file)) return new Response(fx(f.audioSeg));
    return new Response('no', { status: 404 });
  };
});
after(() => { globalThis.fetch = realFetch; });

// ─── Probe ──────────────────────────────────────────────────────────

test('probe: a live feed with sound is ok, with level, loudness and picture size', async () => {
  feeds.talk = { master: masterWithAudio, audioSeg: 'pink-32.m4s', seq: 10 };
  const r = await probeFeed('test', 'talk');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.live, true);
  assert.equal(r.video.height, 1920);
  assert.deepEqual(r.video.ladder, ['1080p', '720p']);
  assert.equal(r.video.lastSequence, 11);
  assert.equal(r.video.avgSegmentSec, 4);
  near(r.audio.levelDb, -32.6, 0.5, 'probe level');
  near(r.audio.lufs, -30.5, 0.5, 'probe LUFS');
  assert.equal(r.audio.verdict, 'ok');
  feeds.soft = { master: masterWithAudio, audioSeg: 'speech-40.m4s', seq: 10 };
  const soft = await probeFeed('test', 'soft');
  near(soft.audio.lufs, -37.2, 3, 'soft speech LUFS');
  assert.equal(soft.audio.verdict, 'quiet', 'speech around -37 LUFS is hard to hear');
});

test('probe verdicts: silent mic, missing track, one side, too loud', async () => {
  feeds.mute = { master: masterWithAudio, audioSeg: 'silence.m4s', seq: 3 };
  assert.equal((await probeFeed('test', 'mute')).audio.verdict, 'silent');
  feeds.noaudio = { master: masterNoAudio, seq: 3 };
  const none = await probeFeed('test', 'noaudio');
  assert.equal(none.ok, true);
  assert.equal(none.audio.present, false);
  assert.equal(none.audio.verdict, 'none');
  feeds.left = { master: masterWithAudio, audioSeg: 'left-only.m4s', seq: 3 };
  const left = await probeFeed('test', 'left');
  assert.equal(left.audio.verdict, 'onesided');
  assert.equal(left.audio.deadSide, 'right');
  feeds.loud = { master: masterWithAudio, audioSeg: 'loud.m4s', seq: 3 };
  assert.equal((await probeFeed('test', 'loud')).audio.verdict, 'loud');
});

test('probe: an idle input reports no video without throwing', async () => {
  const r = await probeFeed('test', 'nobody');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.match(r.error, /No video/);
});

test('audio verdict thresholds', () => {
  const base = { present: true, supported: true, frames: 90, silentPct: 0, channels: 2, leftDb: -24, rightDb: -24 };
  assert.equal(audioVerdict({ ...base, levelDb: -24, lufs: -18, lufsMax: -14 }), 'ok');
  assert.equal(audioVerdict({ ...base, levelDb: -40, lufs: -36, lufsMax: -30 }), 'quiet');
  assert.equal(audioVerdict({ ...base, levelDb: -8, lufs: -7, lufsMax: -4 }), 'loud');
  assert.equal(audioVerdict({ ...base, levelDb: -20, lufs: -16, lufsMax: -5 }), 'loud', 'one 400 ms burst over -6 LUFS');
  assert.equal(audioVerdict({ ...base, levelDb: -40, lufs: -36, silentPct: 95 }), 'silent');
  assert.equal(audioVerdict({ ...base, leftDb: -20, rightDb: null, levelDb: -23, lufs: -20, lufsMax: -18 }), 'onesided');
  assert.equal(deadSide({ channels: 2, leftDb: -60, rightDb: -20 }), 'left');
  assert.equal(deadSide({ channels: 1, leftDb: -20, rightDb: null }), null, 'mono is not one-sided');
  assert.equal(deadSide({ channels: 2, leftDb: -70, rightDb: -90 }), null, 'both near silence is silence, not one-sided');
  assert.equal(audioVerdict({ present: false }), 'none');
  assert.equal(audioVerdict({ present: true, supported: false, frames: 0 }), 'unknown');
});

// ─── Destination verdicts ───────────────────────────────────────────

const baseConfig = {
  customerCode: 'test',
  liveInput: { uid: 'talk' },
  outputs: { facebook: { uid: 'o-fb', enabled: true }, youtube: { uid: 'o-yt', enabled: true } },
  facebook: { mode: 'persistent', pageUrl: 'https://www.facebook.com/x' },
  youtube: { channelUrl: 'https://www.youtube.com/@x/live' },
  instagram: { profileUrl: 'https://www.instagram.com/x' },
  timezone: 'America/New_York',
};
const okProbe = { ok: true, video: { width: 1080, height: 1920 }, audio: { present: true, verdict: 'ok', lufs: -17 } };
const listed = [{ uid: 'o-fb', enabled: true }, { uid: 'o-yt', enabled: true }];

test('destinations: the Website card says so while the phone is reconnecting', () => {
  const d = destinations({ config: baseConfig, state: { kidSlug: 'sam', phase: 'ending', fb: {} }, phoneLive: false, liveForMs: 0, probe: null, viewers: null, outputs: listed, facebook: null, youtube: null });
  assert.equal(d.site.status, 'wait');
  assert.equal(d.site.title, 'Waiting for the phone to come back');
  const idle = destinations({ config: baseConfig, state: { phase: 'scheduled', fb: {} }, phoneLive: false, liveForMs: 0, probe: null, viewers: null, outputs: listed, facebook: null, youtube: null });
  assert.equal(idle.site.title, 'Waiting for the phone');
});

test('destinations: everything live and confirmed', () => {
  const d = destinations({ config: baseConfig, state: { kidSlug: 'sam', fb: {} }, phoneLive: true, liveForMs: 5 * 60e3, probe: okProbe, viewers: 12, outputs: listed, facebook: { configured: true, ok: true, live: true, permalink: 'https://facebook.com/v/1' }, youtube: { configured: true, ok: true, live: { viewers: 4, url: 'https://youtube.com/watch?v=1' } } });
  assert.equal(d.site.status, 'ok');
  assert.equal(d.site.detail, '1080p · -17 LUFS', 'the admin status card carries the one "watching" number');
  assert.equal(d.site.viewers, 12, 'Stream\'s player count stays for the peak in the health report');
  assert.equal(d.facebook.status, 'ok');
  assert.equal(d.facebook.url, 'https://facebook.com/v/1');
  assert.equal(d.youtube.status, 'ok');
  assert.equal(d.instagram.status, 'off');
});

test('destinations: Facebook and YouTube not live after their grace periods say what to do', () => {
  const d = destinations({ config: baseConfig, state: { fb: {} }, phoneLive: true, liveForMs: 4 * 60e3, probe: okProbe, outputs: listed, facebook: { configured: true, ok: true, live: false }, youtube: { configured: true, ok: true, live: null, upcoming: { videoId: 'u' }, channelId: 'UCabc' } });
  assert.equal(d.facebook.status, 'warn');
  assert.match(d.facebook.fix, /Go Live/);
  assert.equal(d.facebook.action.url, 'https://www.facebook.com/live/producer');
  assert.equal(d.youtube.status, 'warn');
  assert.match(d.youtube.fix, /Auto-start/);
  assert.match(d.youtube.action.url, /UCabc/);
});

test('destinations: first minute is "starting", not a problem', () => {
  const d = destinations({ config: baseConfig, state: { fb: {} }, phoneLive: true, liveForMs: 30e3, probe: okProbe, outputs: listed, facebook: { configured: true, ok: true, live: false }, youtube: { configured: true, ok: true, live: null } });
  assert.equal(d.facebook.status, 'wait');
  assert.equal(d.youtube.status, 'wait');
});

test('destinations: silent audio, missing outputs, Facebook with no audio bitrate', () => {
  const d = destinations({ config: { ...baseConfig, facebook: { mode: 'api' } }, state: { fb: { outputUid: 'dyn' } }, phoneLive: true, liveForMs: 5 * 60e3, probe: { ...okProbe, audio: { present: true, verdict: 'silent' } }, outputs: [], facebook: { configured: true, ok: true, live: true, health: { width: 1080, height: 1920, fps: 30, videoBitrate: 3400000, audioBitrate: 0 } }, youtube: { configured: false } });
  assert.equal(d.site.status, 'warn');
  assert.match(d.site.title, /silent/);
  assert.equal(d.facebook.status, 'warn');
  assert.match(d.facebook.title, /no audio/);
  assert.match(d.facebook.detail, /1080p · 30 fps · 3.4 Mbps · audio 0 kbps/);
  assert.equal(d.youtube.status, 'warn'); // not listed in Stream's outputs
  assert.match(d.youtube.title, /missing/);
});

test('destinations: idle phone, paused output', () => {
  const d = destinations({ config: { ...baseConfig, outputs: { ...baseConfig.outputs, youtube: { uid: 'o-yt', enabled: false } } }, state: { fb: {} }, phoneLive: false, liveForMs: null, probe: null, outputs: [{ uid: 'o-fb' }, { uid: 'o-yt', enabled: false }] });
  assert.equal(d.site.status, 'idle');
  assert.equal(d.facebook.status, 'idle');
  assert.equal(d.youtube.status, 'off');
  assert.match(d.youtube.title, /Paused/);
});

// ─── Unattended watch → Slack ───────────────────────────────────────

/** A clock, a reveal, and a step function that advances time and runs one watch. */
function scenario(uid, { audioSeg = 'pink-32.m4s', fb = false, outputs = {} } = {}) {
  const realNow = Date.now;
  let t = Date.parse('2026-10-14T18:00:00Z');
  Date.now = () => t;
  feeds[uid] = { master: masterWithAudio, audioSeg, seq: 100, viewers: 5 };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', ...(fb ? { FB_PAGE_ID: 'page', FB_PAGE_TOKEN: 'tok' } : {}) };
  const config = { ...baseConfig, liveInput: { uid }, outputs };
  const state = { broadcastId: `b-${uid}`, title: 'Sam\'s room reveal', phase: 'live', source: 'stream', liveAt: new Date(t).toISOString(), segmentAt: new Date(t).toISOString(), fb: {} };
  const health = {};
  const events = [];
  const record = async (_db, id, type, meta) => { events.push({ id, type, meta }); };
  const step = async (ms, { advance = true } = {}) => { t += ms; if (advance) feeds[uid].seq += Math.round(ms / 4000); const work = []; await watch(env, config, state, health, work, record); return work; };
  const restore = () => { Date.now = realNow; };
  return { env, config, state, health, events, step, restore, feed: feeds[uid], at: () => t };
}
const texts = () => slack.map((p) => p.text);

test('watch: silence opens an issue in Slack with the fix, reminds, then posts when sound is back', async () => {
  const s = scenario('w-silent', { audioSeg: 'silence.m4s' });
  slack.length = 0;
  try {
    await s.step(1000);                                   // first sighting
    assert.equal(slack.length, 0);
    assert.deepEqual(await s.step(5000), [], 'throttled inside 15 s');
    await s.step(15e3); await s.step(15e3);               // 31 s of silence → posted
    assert.equal(slack.length, 1);
    const post = slack[0];
    assert.match(post.text, /Reveal audio is silent/);
    assert.ok(post.blocks.some((b) => /\*Fix:\*/.test(b.text?.text || '')), 'Slack post has the fix');
    assert.ok(JSON.stringify(post.blocks).includes('/admin/#broadcast/control-room'), 'links to the control room');
    assert.match(JSON.stringify(post.blocks), /Sam's room reveal · live/);
    const issue = s.health.monitor.issues.silent;
    assert.equal(issue.level, 'error');
    assert.equal(issue.slack.ok, true);
    assert.equal(s.events.filter((e) => e.type === 'issue').length, 1);

    for (let i = 0; i < 12; i++) await s.step(15e3);       // 3 more minutes → one reminder
    assert.equal(slack.length, 2);
    assert.match(slack[1].text, /Still: Reveal audio is silent/);
    s.feed.audioSeg = 'pink-32.m4s';
    await s.step(15e3);
    assert.equal(slack.length, 3);
    assert.match(slack[2].text, /Reveal audio is back/);
    assert.equal(s.health.monitor.issues.silent, undefined);
    assert.equal(s.health.monitor.log.map((l) => l.kind).join(','), 'open,reminder,resolved');
  } finally { s.restore(); }
});

test('watch: one-sided and too-loud sound are their own issues', async () => {
  const s = scenario('w-side', { audioSeg: 'left-only.m4s' });
  slack.length = 0;
  try {
    await s.step(1000); await s.step(15e3); await s.step(16e3);
    assert.equal(slack.length, 1);
    assert.match(slack[0].text, /only on the left side/);
    s.feed.audioSeg = 'loud.m4s';
    await s.step(15e3);                                    // one-sided clears, loud starts its 20 s
    assert.match(texts().join('\n'), /Sound is on both sides again/);
    await s.step(15e3); await s.step(15e3);
    assert.ok(texts().some((x) => /very loud/.test(x)), texts().join(' | '));
  } finally { s.restore(); }
});

test('watch: a failed Slack post is retried, then sent as plain text, and the failure is kept', async () => {
  const s = scenario('w-fail', { audioSeg: 'silence.m4s' });
  slack.length = 0;
  slackStatus = 500;
  try {
    await s.step(1000); await s.step(15e3); await s.step(16e3);
    assert.equal(slack.length, 4, 'blocks twice, then plain text twice');
    assert.ok(slack[0].blocks && !slack[3].blocks);
    const issue = s.health.monitor.issues.silent;
    assert.equal(issue.slack.ok, false);
    assert.ok(issue.slack.error);
  } finally { slackStatus = 200; s.restore(); }
});

test('watch: frozen picture and a weak signal', async () => {
  const s = scenario('w-frozen');
  slack.length = 0;
  try {
    await s.step(1000); await s.step(15e3); await s.step(15e3); await s.step(15e3);
    assert.equal(s.health.monitor.signal.status, 'strong');
    await s.step(15e3, { advance: false }); await s.step(15e3, { advance: false }); await s.step(15e3, { advance: false });
    assert.ok(texts().some((x) => /Reveal video is frozen/.test(x)), texts().join(' | '));
    assert.equal(s.health.monitor.signal.status, 'weak');
    await s.step(15e3, { advance: false }); await s.step(15e3, { advance: false });
    assert.ok(texts().some((x) => /signal is weak/.test(x)), texts().join(' | '));
    await s.step(15e3);
    assert.ok(texts().some((x) => /moving again/.test(x)));
  } finally { s.restore(); }
});

test('watch: the phone dropping and coming back', async () => {
  const s = scenario('w-drop');
  slack.length = 0;
  try {
    await s.step(1000);
    s.state.phase = 'ending'; s.state.disconnectedAt = new Date(s.at()).toISOString();
    await s.step(15e3); await s.step(15e3);
    assert.ok(texts().some((x) => /lost its connection/.test(x)), texts().join(' | '));
    s.state.phase = 'live'; s.state.disconnectedAt = null; s.state.segmentAt = new Date(s.at()).toISOString();
    await s.step(15e3);
    assert.ok(texts().some((x) => /The phone is back/.test(x)));
    assert.equal(s.health.monitor.reconnects.length, 1);
  } finally { s.restore(); }
});

test('watch: Facebook not live after 2 minutes, then live; report has the timing', async () => {
  const s = scenario('w-fb', { fb: true, outputs: { facebook: { uid: 'o-fb', enabled: true } } });
  slack.length = 0;
  graph.live = false;
  try {
    for (let i = 0; i < 10; i++) await s.step(15e3);      // 2.5 min, never live on Facebook
    assert.ok(texts().some((x) => /Facebook isn't showing the reveal/.test(x)), texts().join(' | '));
    assert.ok(JSON.stringify(slack.find((p) => /Facebook/.test(p.text)).blocks).includes('facebook.com/live/producer'), 'links Live Producer');
    graph.live = true;
    await s.step(25e3);                                    // past the 20 s Facebook cache
    assert.ok(texts().some((x) => /Facebook is live now/.test(x)));
    assert.equal(s.health.monitor.firsts.facebook, 175);

    s.state.phase = 'replay'; s.state.endedAt = new Date(s.at() + 60e3).toISOString();
    const { report, summary } = await finish(s.env, s.config, s.state, s.health, async (_db, id, type, meta) => s.events.push({ type, meta }));
    assert.equal(report.fb, 175);
    assert.equal(report.peak, 5);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].k, 'facebook');
    assert.ok(JSON.stringify(report).length < 2000, 'fits an event row');
    assert.match(summary, /Sound good \d+% of the time/);
    assert.match(summary, /Facebook live after 2:55/);
    assert.match(summary, /Peak 5 watching/);
    assert.ok(s.events.some((e) => e.type === 'health_report'));
  } finally { graph.live = false; s.restore(); }
});

// ─── Rehearsal + go/no-go ───────────────────────────────────────────

test('a rehearsal probe is remembered as the latest mic check', () => {
  const health = {};
  assert.equal(noteRehearsal(health, { ok: true, at: '2026-10-14T17:00:00Z', audio: { verdict: 'ok', lufs: -18.2 }, video: { width: 1080, height: 1920 } }), true);
  assert.equal(health.rehearsal.goodAt, '2026-10-14T17:00:00Z');
  noteRehearsal(health, { ok: true, at: '2026-10-14T17:05:00Z', audio: { verdict: 'silent', lufs: null } });
  assert.equal(health.rehearsal.verdict, 'silent');
  assert.equal(health.rehearsal.goodAt, '2026-10-14T17:00:00Z', 'a later bad check keeps the last good one');
});

test('go/no-go: missing pieces fail or warn with the fix', async () => {
  const r = await preflight.run({}, { ...baseConfig, outputs: {} }, { phase: 'scheduled', scheduledAt: '2026-10-14T22:00:00Z' }, {});
  const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
  assert.equal(r.ready, false);
  assert.equal(by.stream.status, 'fail');
  assert.equal(by.slack.status, 'fail');
  assert.match(by.slack.fix, /SLACK_WEBHOOK_URL/);
  assert.equal(by.micCheck.status, 'warn');
  assert.equal(by.facebookOutput.status, 'fail');
  assert.equal(by.youtube.status, 'off');
  assert.equal(by.kid.status, 'warn');
  const post = preflight.slackText(r, { title: 'Sam\'s room reveal', scheduledAt: '2026-10-14T22:00:00Z' }, baseConfig);
  assert.match(post.title, /^No-go: Sam's room reveal at 6:00 PM/);
  assert.equal(post.level, 'error');
  assert.match(post.detail, /❌ Slack alerts aren't set up/);
});

test('go/no-go: posts an hour before, and again at 10 minutes only if something was open', async () => {
  const realNow = Date.now;
  let t = Date.parse('2026-10-14T21:05:00Z');
  Date.now = () => t;
  slack.length = 0;
  graph.scheduled = true;
  try {
    const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', CF_ACCOUNT_ID: 'acct', CF_STREAM_TOKEN: 'tok', FB_PAGE_ID: 'page', FB_PAGE_TOKEN: 'tok' };
    const config = { ...baseConfig, liveInput: { uid: 'reveal' }, rehearsalInput: { uid: 'reh' }, outputs: { facebook: { uid: 'o-fb', enabled: true } } };
    const state = { broadcastId: 'b-pre', phase: 'scheduled', title: 'Sam\'s room reveal', kidSlug: 'sam', kidName: 'Sam', scheduledAt: '2026-10-14T22:00:00Z' };
    const health = { rehearsal: { goodAt: '2026-10-14T19:00:00Z', lastAt: '2026-10-14T19:00:00Z', verdict: 'ok', goodLufs: -18 } };
    const hubStatus = async () => ({ ok: true });
    const work = [];
    await preflight.auto(env, config, state, health, work, { hubStatus });   // 55 min out
    assert.equal(slack.length, 1);
    assert.match(slack[0].text, /^🟢 Go: Sam's room reveal at 6:00 PM/);
    assert.equal(health.preflight.last.ready, true);
    await preflight.auto(env, config, state, health, work, { hubStatus });
    assert.equal(slack.length, 1, 'once per stage');
    t = Date.parse('2026-10-14T21:52:00Z');
    await preflight.auto(env, config, state, health, work, { hubStatus });
    assert.equal(slack.length, 1, 'all clear at the hour: no 10-minute post');

    // Same reveal with a problem at the hour mark gets a second post
    slack.length = 0;
    t = Date.parse('2026-10-14T21:05:00Z');
    const h2 = { };
    await preflight.auto(env, config, { ...state, broadcastId: 'b-pre2' }, h2, work, { hubStatus });
    assert.match(slack[0].text, /Go, with notes/);
    assert.match(slack[0].text, /No mic check/);
    t = Date.parse('2026-10-14T21:52:00Z');
    await preflight.auto(env, config, { ...state, broadcastId: 'b-pre2' }, h2, work, { hubStatus });
    assert.equal(slack.length, 2);
  } finally { graph.scheduled = false; Date.now = realNow; }
});

test('rules: Slack waits long enough not to cry wolf', () => {
  assert.ok(RULES.silentAfter >= 30e3 && RULES.quietAfter >= 120e3 && RULES.remindFirst >= 180e3);
});
