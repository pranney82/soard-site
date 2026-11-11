/**
 * The live client (src/utils/live-client.ts) tells its listeners nothing until /api/broadcast has answered:
 * the reminder options come only with that answer, and the real-time hub's state (often first) heard without
 * them read as "no reminders", so /live/ dropped its sign-up button and form for a moment and put them back.
 * Run: node --test tests/live-client-first-state.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';

// The client polls and reconnects on timers: let them run without keeping this test process alive
// (the test's own waits use the real setTimeout)
const realSetTimeout = globalThis.setTimeout;
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
for (const name of ['setTimeout', 'setInterval']) {
  const real = globalThis[name];
  globalThis[name] = (...args) => { const t = real(...args); t?.unref?.(); return t; };
}

const code = buildSync({ entryPoints: ['src/utils/live-client.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' }).outputFiles[0].text;

const STATE = { phase: 'scheduled', live: false, upcoming: true, replay: false, id: 'b1', kidSlug: 'dylan', kidName: 'Dylan', scheduledAt: '2026-11-18T21:00:00Z' };
const REMINDERS = { enabled: true, email: true, sms: false, push: false, pushKey: null };

/** A browser where the hub and /api/broadcast answer when the test says so */
async function browser({ broadcast }) {
  const sockets = [];
  class FakeSocket {
    constructor() { sockets.push(this); }
    send() {}
    close() {}
  }
  let answer;
  const answered = new Promise((r) => { answer = r; });
  globalThis.window = { parent: null, addEventListener() {} };
  window.parent = window;
  globalThis.WebSocket = FakeSocket;
  window.WebSocket = FakeSocket;
  globalThis.document = { hidden: false, visibilityState: 'visible', addEventListener() {} };
  globalThis.location = { protocol: 'https:', host: 'example.org', pathname: '/live/' };
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/broadcast')) { await answered; return broadcast(); }
    return new Response('{}');
  };
  const { getLiveClient } = await import(`data:text/javascript,${encodeURIComponent(code)}#${Math.random()}`);
  const client = getLiveClient();
  const heard = [];
  client.subscribe((state, meta) => heard.push({ state, reminders: meta.reminders }));
  const hub = sockets[0];
  return { client, heard, hub, answer, settle: () => wait(20) };
}

test('the hub\'s state before /api/broadcast answers is kept, then heard with the reminder options', async () => {
  const b = await browser({ broadcast: () => Response.json({ state: STATE, reminders: REMINDERS, timezone: 'America/New_York' }) });
  b.hub.onopen?.();
  b.hub.onmessage({ data: JSON.stringify({ type: 'state', state: { ...STATE, title: 'from the hub' } }) });
  await b.settle();
  assert.equal(b.heard.length, 0, 'nothing heard without the reminder options');
  b.answer();
  await b.settle();
  assert.equal(b.heard.length, 1);
  assert.deepEqual(b.heard[0].reminders, REMINDERS);
  // later hub states are heard straight away, with the options already known
  b.hub.onmessage({ data: JSON.stringify({ type: 'state', state: { ...STATE, phase: 'live', live: true } }) });
  assert.equal(b.heard.length, 2);
  assert.equal(b.heard[1].state.phase, 'live');
  assert.deepEqual(b.heard[1].reminders, REMINDERS);
});

test('when /api/broadcast fails, the hub\'s state is still heard (its reminders unknown)', async () => {
  const b = await browser({ broadcast: () => new Response('down', { status: 503 }) });
  b.hub.onmessage({ data: JSON.stringify({ type: 'state', state: STATE }) });
  await b.settle();
  assert.equal(b.heard.length, 0);
  b.answer();
  await b.settle();
  assert.equal(b.heard.length, 1);
  assert.equal(b.heard[0].reminders, null);
});

test('when /api/broadcast answers with no state yet, a state the hub gave is heard', async () => {
  const b = await browser({ broadcast: () => Response.json({ reminders: REMINDERS }) });
  b.hub.onmessage({ data: JSON.stringify({ type: 'state', state: STATE }) });
  b.answer();
  await b.settle();
  assert.equal(b.heard.length, 1);
  assert.equal(b.heard[0].state.kidSlug, 'dylan');
});
