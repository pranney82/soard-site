/**
 * Live feed monitor: AAC level reader, HLS probe, destination verdicts, alerts
 * Run: node --test tests/
 *
 * Fixtures (tests/fixtures/aac/) are one-second AAC-LC 48 kHz stereo 128 kbps
 * clips made with FFmpeg 6.0; the expected levels are FFmpeg's own decode of
 * the first channel (astats RMS):
 *   silence.m4s     digital silence            -inf
 *   pink-32.m4s     pink noise                 -32.6 dBFS
 *   speech-40.m4s   speech                     -40.2 dBFS
 *   speech-40.ts    same speech, MPEG-TS/ADTS  -40.2 dBFS
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeSegment, configFromInit, mergeLevels } from '../functions/api/_aac-level.js';
import { parseMaster, parseMedia, probeFeed, audioVerdict } from '../functions/api/_stream-probe.js';
import { destinations, watch } from '../functions/api/_broadcast-monitor.js';

const fx = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/aac/${name}`, import.meta.url)));
const INIT = fx('init.mp4');
const near = (actual, expected, tol, msg) => assert.ok(actual != null && Math.abs(actual - expected) <= tol, `${msg}: ${actual} not within ${tol} of ${expected}`);

// ─── AAC level reader ───────────────────────────────────────────────

test('reads the AAC config and audio track from an fMP4 init segment', () => {
  const c = configFromInit(INIT);
  assert.equal(c.aot, 2);
  assert.equal(c.sampleRate, 48000);
  assert.equal(c.channels, 2);
  assert.equal(c.trackId, 1);
});

test('digital silence reads as silent', () => {
  const r = analyzeSegment({ init: INIT, segment: fx('silence.m4s') });
  assert.equal(r.supported, true);
  assert.ok(r.frames > 40);
  assert.equal(r.failed, 0);
  assert.equal(r.levelDb, null);
  assert.equal(r.silentPct, 100);
});

test('noise and speech levels match the reference decode', () => {
  const pink = analyzeSegment({ init: INIT, segment: fx('pink-32.m4s') });
  near(pink.levelDb, -32.6, 1, 'pink noise');
  assert.equal(pink.failed, 0);
  assert.equal(pink.silentPct, 0);
  const speech = analyzeSegment({ init: INIT, segment: fx('speech-40.m4s') });
  near(speech.levelDb, -40.2, 3, 'speech (fMP4)');
  const ts = analyzeSegment({ segment: fx('speech-40.ts') });
  near(ts.levelDb, -40.2, 3, 'speech (MPEG-TS)');
  assert.equal(ts.failed, 0);
});

test('without an init segment fMP4 audio is reported unsupported, not guessed', () => {
  const r = analyzeSegment({ segment: fx('pink-32.m4s') });
  assert.equal(r.supported, false);
});

test('mergeLevels averages energy across segments', () => {
  const a = analyzeSegment({ init: INIT, segment: fx('pink-32.m4s') });
  const s = analyzeSegment({ init: INIT, segment: fx('silence.m4s') });
  const m = mergeLevels([a, s]);
  near(m.levelDb, a.levelDb - 3, 0.5, 'half noise, half silence is ~3 dB down');
  assert.equal(m.frames, a.frames + s.frames);
  assert.ok(m.silentPct > 40 && m.silentPct < 60);
});

// ─── Manifests ──────────────────────────────────────────────────────

const HOST = 'https://customer-test.cloudflarestream.com';
const masterWithAudio = (uid) => `#EXTM3U
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
  const m = parseMaster(masterWithAudio('x'), `${HOST}/x/manifest/video.m3u8`);
  assert.equal(m.variants.length, 2);
  assert.equal(m.variants[0].height, 1920);
  assert.equal(m.variants[0].fps, 30);
  assert.equal(m.variants[0].uri, `${HOST}/x/manifest/v1080.m3u8`);
  assert.equal(m.audio.length, 1);
  assert.equal(m.audio[0].uri, `${HOST}/x/manifest/audio.m3u8`);
});

test('parses a live media playlist (sequence, init map, date-times)', () => {
  const p = parseMedia(livePlaylist(41), `${HOST}/x/manifest/v1080.m3u8`);
  assert.equal(p.mediaSequence, 41);
  assert.equal(p.lastSequence, 42);
  assert.equal(p.endList, false);
  assert.equal(p.map, `${HOST}/x/manifest/init.mp4`);
  assert.equal(p.segments.length, 2);
  assert.equal(p.segments[0].pdt, Date.parse('2026-10-14T18:00:00.000Z'));
});

// ─── Probe against a fake Stream host ───────────────────────────────

const feeds = {}; // uid → { master, audioSeg, seq }
const sent = []; // alert webhook bodies
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'hook.test') { sent.push(JSON.parse(init.body).text); return new Response('ok'); }
    if (url.hostname !== 'customer-test.cloudflarestream.com') return new Response('not mocked', { status: 599 });
    const [, uid, , file] = url.pathname.split('/');
    const f = feeds[uid];
    if (!f) return new Response('404 not found', { status: 404 });
    if (file === 'video.m3u8') return new Response(f.master);
    if (file === 'audio.m3u8') return new Response(livePlaylist(f.seq, 'a'));
    if (file === 'v1080.m3u8') return new Response(livePlaylist(f.seq, 'v'));
    if (file === 'init.mp4') return new Response(INIT);
    if (/^a\d\.m4s$/.test(file)) return new Response(fx(f.audioSeg));
    return new Response('no', { status: 404 });
  };
});
after(() => { globalThis.fetch = realFetch; });

test('probe: live feed with speech is ok, with level and picture size', async () => {
  feeds.talk = { master: masterWithAudio('talk'), audioSeg: 'speech-40.m4s', seq: 10 };
  const r = await probeFeed('test', 'talk');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.live, true);
  assert.equal(r.video.height, 1920);
  assert.deepEqual(r.video.ladder, ['1080p', '720p']);
  assert.equal(r.video.lastSequence, 11);
  assert.equal(r.audio.present, true);
  near(r.audio.levelDb, -40.2, 3, 'probe level');
  assert.equal(r.audio.verdict, 'ok');
});

test('probe: silent mic and missing audio track are told apart', async () => {
  feeds.mute = { master: masterWithAudio('mute'), audioSeg: 'silence.m4s', seq: 3 };
  assert.equal((await probeFeed('test', 'mute')).audio.verdict, 'silent');
  feeds.noaudio = { master: masterNoAudio, audioSeg: null, seq: 3 };
  const r = await probeFeed('test', 'noaudio');
  assert.equal(r.ok, true);
  assert.equal(r.audio.present, false);
  assert.equal(r.audio.verdict, 'none');
});

test('probe: an idle input reports no video without throwing', async () => {
  const r = await probeFeed('test', 'nobody');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.match(r.error, /No video/);
});

test('audio verdict thresholds', () => {
  assert.equal(audioVerdict({ present: true, supported: true, frames: 90, levelDb: -24, silentPct: 0 }), 'ok');
  assert.equal(audioVerdict({ present: true, supported: true, frames: 90, levelDb: -56, silentPct: 20 }), 'quiet');
  assert.equal(audioVerdict({ present: true, supported: true, frames: 90, levelDb: -40, silentPct: 95 }), 'silent');
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
};
const okProbe = { ok: true, video: { width: 1080, height: 1920 }, audio: { present: true, verdict: 'ok' } };
const listed = [{ uid: 'o-fb', enabled: true }, { uid: 'o-yt', enabled: true }];

test('destinations: everything live and confirmed', () => {
  const d = destinations({ config: baseConfig, state: { kidSlug: 'sam', fb: {} }, phoneLive: true, liveForMs: 5 * 60e3, probe: okProbe, viewers: 12, outputs: listed, facebook: { configured: true, ok: true, live: true, permalink: 'https://facebook.com/v/1' }, youtube: { configured: true, ok: true, live: { viewers: 4, url: 'https://youtube.com/watch?v=1' } } });
  assert.equal(d.site.status, 'ok');
  assert.match(d.site.detail, /12 watching · 1080p/);
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

test('destinations: silent audio, missing outputs, Facebook with no audio bitrate, unchecked YouTube', () => {
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

// ─── Unattended watch → alerts ──────────────────────────────────────

test('watch: alerts once when audio stays silent, again when it comes back, and on frozen video', async () => {
  const realNow = Date.now;
  let t = Date.parse('2026-10-14T18:00:00Z');
  Date.now = () => t;
  try {
    feeds.reveal = { master: masterWithAudio('reveal'), audioSeg: 'silence.m4s', seq: 100 };
    const env = { SLACK_WEBHOOK_URL: 'https://hook.test/slack' };
    const config = { ...baseConfig, liveInput: { uid: 'reveal' }, outputs: {} };
    const state = { broadcastId: 'b1', phase: 'live', source: 'stream', liveAt: new Date(t - 60e3).toISOString(), fb: {} };
    const health = {};
    const step = async (ms) => { t += ms; feeds.reveal.seq++; const work = []; await watch(env, config, state, health, work); return work; };
    sent.length = 0;

    await step(0);                       // silent, first sighting
    assert.equal(sent.length, 0);
    assert.ok((await step(5e3)).length === 0, 'throttled inside 15 s');
    await step(15e3);                    // 20 s silent
    assert.equal(sent.length, 0);
    await step(15e3);                    // 35 s silent → alert
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Reveal audio is silent/);
    await step(15e3);                    // still silent → no repeat
    assert.equal(sent.length, 1);
    feeds.reveal.audioSeg = 'speech-40.m4s';
    await step(15e3);                    // sound back → recovery note
    assert.equal(sent.length, 2);
    assert.match(sent[1], /audio is back/);
    assert.equal(health.monitor.audio.verdict, 'ok');

    // Picture stops advancing while the phone still shows connected
    await step(15e3); await step(15e3);
    assert.equal(sent.length, 2, 'no alert while the playlist moves');
    const hold = async (ms) => { t += ms; await watch(env, config, state, health, []); };
    await hold(15e3);                    // same sequence for 15 s
    await hold(15e3);                    // 30 s → alert
    assert.equal(sent.length, 3);
    assert.match(sent[2], /video looks frozen/);
    await hold(15e3);
    assert.equal(sent.length, 3, 'frozen alert fires once');
  } finally {
    Date.now = realNow;
  }
});
