/**
 * Instagram Reel pipeline — moment detection, cut window, end-to-end publish.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as reels from '../functions/api/_broadcast-reel.js';

const ts = (sec) => { const m = Math.floor(sec / 60), s = sec % 60; return `00:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000`; };
function vtt(lines) {
  return 'WEBVTT\n\n' + lines.map(([sec, text], i) => `${i + 1}\n${ts(sec)} --> ${ts(sec + 4)} align:start\n${text}`).join('\n\n') + '\n';
}

// A 25-minute reveal: chatter, a false "wow" early, the countdown and reveal at 12:30, reactions after
const REVEAL = vtt([
  [30, 'hi everyone welcome to the live stream'],
  [95, 'wow look at this tile work'],
  [240, 'thank you to our partners for donating the cabinets'],
  [480, 'she is almost here'],
  [735, 'are you ready'],
  [742, 'three two one'],
  [750, 'open your eyes'],
  [754, 'oh my gosh'],
  [758, 'this is your new room'],
  [762, 'wow'],
  [770, 'do you like it'],
  [1100, 'let us take a look at the closet'],
  [1440, 'thank you all for watching'],
]);

test('parseVtt reads cues with hours and settings', () => {
  const cues = reels.parseVtt(REVEAL);
  assert.equal(cues.length, 13);
  assert.equal(cues[6].start, 750);
  assert.equal(cues[6].end, 754);
  assert.equal(cues[6].text, 'open your eyes');
});

test('keyword detector lands on the reveal, not the early wow', () => {
  const kw = reels.detectByKeywords(reels.parseVtt(REVEAL));
  assert.ok(kw);
  assert.ok(kw.seconds >= 735 && kw.seconds <= 750, `got ${kw.seconds}`);
  assert.ok(kw.confidence >= 0.5, `confidence ${kw.confidence}`);
});

test('no reveal language → null', () => {
  assert.equal(reels.detectByKeywords(reels.parseVtt(vtt([[10, 'hello'], [60, 'thanks for coming']]))), null);
});

test('chooseMoment prefers precise keywords when AI agrees, AI when keywords are weak', () => {
  assert.equal(reels.chooseMoment({ seconds: 742, confidence: 0.9 }, { seconds: 760, confidence: 0.7 }).method, 'captions+ai');
  assert.equal(reels.chooseMoment({ seconds: 95, confidence: 0.1 }, { seconds: 750, confidence: 0.8 }).seconds, 750);
  assert.equal(reels.chooseMoment(null, null), null);
});

test('clipWindow: lead-up, clamping, fits, fallback', () => {
  assert.deepEqual(reels.clipWindow(600, 300), { start: 0, end: 600 });
  assert.deepEqual(reels.clipWindow(1500, 742, { leadSeconds: 240 }), { start: 502, end: 1397 });
  assert.deepEqual(reels.clipWindow(1500, 100, { leadSeconds: 240 }), { start: 0, end: 895 });
  assert.deepEqual(reels.clipWindow(1800, 1750, { leadSeconds: 240 }), { start: 905, end: 1800 });
  assert.deepEqual(reels.clipWindow(1800, null), { start: 905, end: 1800 });
  for (const [d, m] of [[1500, 742], [1800, 1750], [1800, 10]]) { const w = reels.clipWindow(d, m); assert.ok(w.end - w.start <= 895); }
});

test('renderCaption fills the kid and falls back without one', () => {
  assert.match(reels.renderCaption(null, { kidName: 'Remi' }), /^Remi's room reveal/);
  assert.match(reels.renderCaption(null, { kidName: null }), /^Room reveal day/);
});

test('pipeline: 25-min recording → captions → cut → MP4 → Instagram Reel', async () => {
  const calls = [];
  let downloadsRequested = false, downloadPolls = 0, containerPolls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method || 'GET').toUpperCase();
    calls.push(`${method} ${url.split('?')[0]}`);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    const cf = 'https://api.cloudflare.com/client/v4/accounts/acct';
    if (url === `${cf}/stream/src1` && method === 'GET') return json({ success: true, result: { uid: 'src1', duration: 1500, status: { state: 'ready' } } });
    if (url === `${cf}/stream/src1/captions`) return json({ success: true, result: [{ language: 'en', label: 'English', generated: true, status: 'ready' }] });
    if (url === `${cf}/stream/src1/captions/en/vtt`) return new Response(REVEAL, { status: 200 });
    if (url === `${cf}/stream/clip` && method === 'POST') { const b = JSON.parse(init.body); assert.equal(b.clippedFromVideoUID, 'src1'); assert.ok(b.endTimeSeconds - b.startTimeSeconds <= 895); return json({ success: true, result: { uid: 'clip1' } }); }
    if (url === `${cf}/stream/clip1` && method === 'GET') return json({ success: true, result: { uid: 'clip1', status: { state: 'ready' } } });
    if (url === `${cf}/stream/clip1/downloads` && method === 'GET') { downloadPolls++; return json({ success: true, result: downloadsRequested ? { default: { status: downloadPolls > 2 ? 'ready' : 'inprogress', url: 'https://customer-x.cloudflarestream.com/clip1/downloads/default.mp4' } } : {} }); }
    if (url === `${cf}/stream/clip1/downloads` && method === 'POST') { downloadsRequested = true; return json({ success: true, result: { default: { status: 'inprogress', url: 'https://customer-x.cloudflarestream.com/clip1/downloads/default.mp4' } } }); }
    if (url.startsWith('https://graph.facebook.com/v25.0/page1?')) return json({ instagram_business_account: { id: 'ig1', username: 'sunshineonaranneyday' } });
    if (url === 'https://graph.facebook.com/v25.0/ig1/media' && method === 'POST') {
      const b = new URLSearchParams(init.body);
      assert.equal(b.get('media_type'), 'REELS');
      assert.match(b.get('video_url'), /clip1\/downloads\/default\.mp4$/);
      assert.match(b.get('caption'), /^Remi's room reveal/);
      assert.ok(Number(b.get('thumb_offset')) > 0);
      return json({ id: 'cont1' });
    }
    if (url.startsWith('https://graph.facebook.com/v25.0/cont1?')) { containerPolls++; return json({ status_code: containerPolls > 1 ? 'FINISHED' : 'IN_PROGRESS' }); }
    if (url === 'https://graph.facebook.com/v25.0/ig1/media_publish' && method === 'POST') return json({ id: 'media1' });
    if (url.startsWith('https://graph.facebook.com/v25.0/media1?')) return json({ permalink: 'https://www.instagram.com/reel/ABC/' });
    return new Response('not mocked ' + url, { status: 599 });
  };
  const env = { CF_ACCOUNT_ID: 'acct', CF_STREAM_TOKEN: 't', FB_PAGE_ID: 'page1', FB_PAGE_TOKEN: 'pt', AI: { run: async () => ({ response: '{"revealSeconds": 752, "confidence": 0.8}' }) } };
  const config = { reels: reels.defaultReelConfig() };
  let state = { kidName: 'Remi', title: "Remi's room reveal", reel: reels.startReel({}, 'src1', null) };
  const stages = [];
  try {
    for (let i = 0; i < 20 && !['done', 'failed', 'blocked'].includes(state.reel.stage); i++) {
      state = (await reels.advanceReel(env, config, state, { force: true })).state;
      stages.push(state.reel.stage);
    }
  } finally { globalThis.fetch = realFetch; }
  assert.equal(state.reel.stage, 'done', `${stages.join(' → ')} | ${state.reel.error}`);
  assert.equal(state.reel.method, 'captions+ai');
  assert.ok(state.reel.momentSeconds >= 735 && state.reel.momentSeconds <= 752);
  assert.equal(state.reel.start, state.reel.momentSeconds - 240);
  assert.ok(state.reel.end - state.reel.start <= 895);
  assert.equal(state.reel.permalink, 'https://www.instagram.com/reel/ABC/');
  assert.ok(stages.includes('clipping') && stages.includes('processing'));
});

test('pipeline: short recording posts whole, no clip', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/stream/s2')) return json({ success: true, result: { duration: 600, status: { state: 'ready' } } });
    if (url.endsWith('/stream/s2/downloads')) return json({ success: true, result: { default: { status: 'ready', url: 'https://x/s2.mp4' } } });
    return new Response('{}', { status: 599 });
  };
  try {
    let state = { kidName: 'Ana', reel: reels.startReel({}, 's2', null) };
    state = (await reels.advanceReel({ CF_ACCOUNT_ID: 'acct', CF_STREAM_TOKEN: 't' }, {}, state, { force: true })).state;
    assert.equal(state.reel.stage, 'download');
    assert.equal(state.reel.method, 'fits');
    state = (await reels.advanceReel({ CF_ACCOUNT_ID: 'acct', CF_STREAM_TOKEN: 't' }, {}, state, { force: true })).state;
    assert.equal(state.reel.stage, 'instagram');
    assert.ok(!seen.some(u => u.includes('/stream/clip')));
  } finally { globalThis.fetch = realFetch; }
});

test('pipeline: missing Instagram permission → blocked with a clear message', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: '(#10) Application does not have permission for this action', code: 10 } }), { status: 400 });
  try {
    let state = { reel: { ...reels.startReel({}, 's3', null), stage: 'instagram', mp4Url: 'https://x/a.mp4' } };
    state = (await reels.advanceReel({ FB_PAGE_ID: 'p', FB_PAGE_TOKEN: 't' }, {}, state, { force: true })).state;
    assert.equal(state.reel.stage, 'blocked');
    assert.match(state.reel.error, /permission/i);
  } finally { globalThis.fetch = realFetch; }
});

test('override minute skips caption detection', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/stream/s4')) return new Response(JSON.stringify({ success: true, result: { duration: 1800, status: { state: 'ready' } } }), { status: 200 });
    return new Response('{}', { status: 599 });
  };
  try {
    let state = { reel: reels.startReel({}, 's4', 20 * 60) };
    state = (await reels.advanceReel({ CF_ACCOUNT_ID: 'a', CF_STREAM_TOKEN: 't' }, {}, state, { force: true })).state;
    assert.equal(state.reel.stage, 'window');
    assert.equal(state.reel.method, 'override');
    assert.equal(state.reel.momentSeconds, 1200);
  } finally { globalThis.fetch = realFetch; }
});
