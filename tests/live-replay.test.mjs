/**
 * Replay extras for the live page — reveal moment and captions
 * Run: node --test tests/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };

// Stream API stand-in: caption tracks and VTT per video, and a log of every call
const tracks = {};
const vtts = {};
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method || 'GET';
  calls.push(`${method} ${url.replace(/^.*\/stream\//, '')}`);
  const m = url.match(/\/stream\/([^/]+)\/captions(?:\/([^/]+)\/(generate|vtt))?$/);
  if (!m) return new Response('{}', { status: 404 });
  const [, uid, , action] = m;
  if (action === 'generate') { tracks[uid] = [{ language: 'en', status: 'inprogress', generated: true }]; return Response.json({ success: true, result: {} }); }
  if (action === 'vtt') return new Response(vtts[uid] || '', { status: vtts[uid] ? 200 : 404 });
  return Response.json({ success: true, result: tracks[uid] || [] });
};

// Workers AI stand-in
let aiAnswer = null;
const AI = { async run() { return { response: aiAnswer ? JSON.stringify(aiAnswer) : 'no idea' }; } };

// Edge cache stand-in
const cached = new Map();
globalThis.caches = { default: { async match(req) { return cached.get(req.url)?.clone(); }, async put(req, res) { cached.set(req.url, res); } } };

const cue = (sec, text) => {
  const t = (s) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000`;
  return `${t(sec)} --> ${t(sec + 3)}\n${text}`;
};
const REVEAL_VTT = ['WEBVTT', cue(30, 'Thanks for joining us today'), cue(735, 'Are you ready?'), cue(742, 'Okay open your eyes'), cue(746, 'Oh my gosh this is your new room'), cue(750, 'Wow!'), cue(900, 'Thank you everyone')].join('\n\n');

let env, b, endpoint;
const get = (qs = '') => endpoint.onRequestGet({ env, request: new Request(`https://x/api/live-replay${qs}`), waitUntil: (p) => p });

async function setReplay(uid, extra = {}) {
  const s = await b.readState(env.DB);
  await b.writeState(env.DB, { ...s, broadcastId: 'live-200', kidSlug: 'axel', kidName: 'Axel', phase: 'replay', replayUid: uid, reel: null, ...extra });
}

before(async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  env = { DB, AI, CF_ACCOUNT_ID: 'acc', CF_STREAM_TOKEN: 'token' };
  b = await import('../functions/api/_broadcast.js');
  endpoint = await import('../functions/api/live-replay.js');
});
after(() => { Date.now = realNow; globalThis.fetch = realFetch; });

test('nothing to say when there is no replay', async () => {
  const data = await (await get()).json();
  assert.deepEqual(data, { ok: true, uid: null, revealAt: null, captions: false });
  assert.equal((await get('?vtt=en')).status, 404);
});

test('asks Stream for captions once, then waits', async () => {
  await setReplay('vidA');
  const first = await (await get()).json();
  assert.equal(first.uid, 'vidA');
  assert.equal(first.captions, false);
  assert.equal(first.revealAt, null);
  assert.ok(calls.includes('POST vidA/captions/en/generate'));
  const n = calls.length;
  await get(); await get();
  assert.equal(calls.length, n, 'viewers within two minutes cause no Stream calls');
});

test('finds the reveal moment from the captions when they arrive', async () => {
  tracks.vidA = [{ language: 'en', status: 'ready' }];
  vtts.vidA = REVEAL_VTT;
  aiAnswer = { revealSeconds: 745, confidence: 0.9 };
  travel(3 * 60 * 1000);
  const data = await (await get()).json();
  assert.equal(data.captions, true);
  assert.equal(data.revealAt, 735, 'the first strong cue of the reveal ("Are you ready?"), when the model agrees');
  const generates = calls.filter((c) => c === 'POST vidA/captions/en/generate').length;
  assert.equal(generates, 1, 'never asks twice');
  travel(3 * 60 * 1000);
  const n = calls.length;
  assert.equal((await (await get()).json()).revealAt, 735);
  assert.equal(calls.length, n, 'settled: no more Stream calls');
});

test('serves the captions for the current replay, cached', async () => {
  const res = await get('?vtt=en');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/vtt/);
  assert.match(await res.text(), /open your eyes/);
  const n = calls.length;
  assert.equal((await get('?vtt=en')).status, 200);
  assert.equal(calls.length, n, 'second request comes from the edge cache');
});

test('a weak guess is not offered as a jump', async () => {
  await setReplay('vidB');
  tracks.vidB = [{ language: 'en', status: 'ready' }];
  vtts.vidB = ['WEBVTT', cue(100, 'wow'), cue(400, 'see you next time')].join('\n\n');
  aiAnswer = null;
  const data = await (await get()).json();
  assert.equal(data.captions, true);
  assert.equal(data.revealAt, null);
});

test('the Reel pipeline answer and the admin override come first', async () => {
  await setReplay('vidC', { reel: { sourceUid: 'vidC', momentSeconds: 1210, method: 'captions+ai', confidence: 0.8, overrideSeconds: null } });
  assert.equal((await (await get()).json()).revealAt, 1210);
  await setReplay('vidC', { reel: { sourceUid: 'vidC', momentSeconds: 1210, method: 'captions+ai', confidence: 0.8, overrideSeconds: 1500 } });
  assert.equal((await (await get()).json()).revealAt, 1500);
  // A Reel record for another recording says nothing about this one
  await setReplay('vidD', { reel: { sourceUid: 'other', momentSeconds: 99, method: 'override' } });
  assert.equal((await (await get()).json()).revealAt, null);
});

test('trust rules', () => {
  assert.equal(endpoint.trustedMoment(null), null);
  assert.equal(endpoint.trustedMoment({ seconds: 10, method: 'captions', confidence: 0.2 }), null);
  assert.equal(endpoint.trustedMoment({ seconds: 10, method: 'captions', confidence: 0.6 }), 10);
  assert.equal(endpoint.trustedMoment({ seconds: 10.4, method: 'override' }), 10);
  assert.equal(endpoint.trustedMoment({ seconds: 'x', method: 'override' }), null);
});
