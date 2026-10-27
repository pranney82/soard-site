/**
 * Live broadcast: the security fixes (October 2026)
 *   stream-webhook   the shared secret, alerts in our own words, dedupe, forced-tick cap, atomic health
 *   broadcast-event  banner clicks counted in place, the broadcast id checked, meta kept small
 *   runTick          the D1 lease, rev-checked state writes, one-time claims (two "isolates" racing)
 *   fb-live-videos   the public sees LIVE/VOD from the cache, only staff skip it, no Facebook text echoed
 *   live-ws          origin allowlist, admin only with an Access login, the caller's address for the hub
 * Run: node --test tests/broadcast-security.test.mjs
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';

// ─── Time travel ────────────────────────────────────────────────────
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };
const S = 1000, M = 60e3, H = 3600e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fake network ───────────────────────────────────────────────────
// lifecycleGate: a promise the live input's lifecycle call waits on; onLifecycle: runs as Stream is asked (time travel, a rival lease)
const sim = { live: false, videoUID: null, lifecycleDelay: 0, lifecycleGate: null, onLifecycle: null, graphVideos: [], graphError: null };
let calls = [];
let accessKey = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  calls.push({ url, method, body: typeof init.body === 'string' ? init.body : init.body ? String(init.body) : null });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/cdn-cgi/access/certs')) return json({ keys: accessKey ? [accessKey] : [] });
  if (url.includes('cloudflarestream.com/') && url.endsWith('/lifecycle')) {
    if (sim.lifecycleDelay) await sleep(sim.lifecycleDelay);
    if (sim.lifecycleGate && url.endsWith('/in1/lifecycle')) await sim.lifecycleGate;
    if (sim.onLifecycle && url.endsWith('/in1/lifecycle')) await sim.onLifecycle();
    return json({ isInput: true, videoUID: sim.live ? sim.videoUID : null, live: sim.live });
  }
  if (url.includes('graph.facebook.com') && url.includes('/live_videos') && method === 'POST') {
    return json({ id: 'fbv1', secure_stream_url: 'rtmps://live-api-s.facebook.com:443/rtmp/FB-key-123' });
  }
  if (url.includes('graph.facebook.com') && url.includes('/videos')) return sim.graphError ? json({ error: sim.graphError }, 400) : json({ data: sim.graphVideos });
  if (url.includes('graph.facebook.com')) return json({ data: [] });
  if (url.includes('/stream/live_inputs/in1/outputs') && method === 'POST') return json({ success: true, result: { uid: 'out1' } });
  if (url.startsWith('https://api.resend.com/')) return json({ data: [] });
  return json({ success: true, result: [] });
};
// The live input's lifecycle (the rehearsal input's is the mic-check watch, not a tick's reconcile)
const lifecycleCalls = () => calls.filter((c) => c.url.endsWith('/in1/lifecycle')).length;
const fbPosts = () => calls.filter((c) => c.url.includes('/live_videos') && c.method === 'POST').length;
const outputPosts = () => calls.filter((c) => c.url.includes('/live_inputs/in1/outputs') && c.method === 'POST').length;
/** Staff alert emails (the alert list gets '[SOARD Live] <title>') */
const alerts = (match) => calls.filter((c) => c.url.startsWith('https://api.resend.com/emails'))
  .flatMap((c) => { try { return JSON.parse(c.body); } catch { return []; } })
  .filter((m) => /^\[SOARD Live\]/.test(m.subject || '') && (!match || match.test(m.subject)));

// ─── Fake hub binding ───────────────────────────────────────────────
const NONCE = '0b6a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const hub = { published: [], sockets: [], nonces: new Set() };
const LIVE_HUB = {
  idFromName: () => 'main',
  get: () => ({
    async fetch(input, init = {}) {
      const req = input instanceof Request ? input : null;
      const path = new URL(req ? req.url : input).pathname;
      if (path === '/ws') { hub.sockets.push(req); return new Response('upgraded'); }
      const body = init.body ? JSON.parse(init.body) : {};
      if (path === '/publish') { hub.published.push(body); return Response.json({ ok: true, changed: true, clients: 1 }); }
      if (path === '/verify') return Response.json({ ok: hub.nonces.delete(body.nonce) });
      if (path === '/status') return Response.json({ ok: true, clients: 1, phase: 'idle', watchers: 0 });
      return new Response('nf', { status: 404 });
    },
  }),
};

// ─── Cloudflare Access (a real RS256 token against a fake team) ─────
const ACCESS = { CF_ACCESS_TEAM_DOMAIN: 'soard-test', CF_ACCESS_AUD: 'aud-test' };
async function accessToken() {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  accessKey = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256' };
  const b64u = (x) => Buffer.from(typeof x === 'string' ? x : new Uint8Array(x)).toString('base64url');
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: 'https://soard-test.cloudflareaccess.com', aud: ['aud-test'], email: 'staff@soardcharity.com', exp: Math.floor(Date.now() / 1000) + 90 * 86400 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}

let DB, env, b, b2, jwt, endpoints;
const SECRET = 'whsec-test-0123456789abcdef';
const ctx = (request, extra = {}) => ({ env, request, data: { userEmail: 'staff@example.com' }, waitUntil: (p) => { ctx.pending.push(Promise.resolve(p).catch(() => {})); }, ...extra });
ctx.pending = [];
const flush = () => Promise.all(ctx.pending.splice(0));
const post = (url, body, headers = {}) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const hook = (data, headers = {}) => post('https://sunshineonaranneyday.com/api/stream-webhook', { name: 'Stream Live', data }, headers);
const signed = { 'cf-webhook-auth': SECRET };

/** A D1 whose lease table is unreachable: ticks run "unleased", so only the rev check and the claims stand */
function withoutLease(db) {
  return { ...db, prepare: (sql) => { if (sql.includes('broadcast_locks')) throw new Error('D1 hiccup'); return db.prepare(sql); } };
}
const count = async (sql, ...args) => (await DB.prepare(sql).bind(...args).first())?.n ?? 0;

async function freshBroadcast(phase = 'idle', minutesAhead = 20) {
  // Back to a clean slate between scenarios (as an admin reset would)
  await b.adminAction(env, 'reset', {}, 'staff@example.com');
  sim.live = false; sim.lifecycleDelay = 0;
  travel(10 * M); // every throttle and dedupe window from the last scenario has passed
  if (phase === 'scheduled') {
    const r = await b.adminAction(env, 'schedule', { kidSlug: 'remi', scheduledAt: new Date(Date.now() + minutesAhead * M).toISOString() }, 'staff@example.com');
    assert.equal(r.success, true, r.error);
  }
}

before(async () => {
  DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare('INSERT INTO kids (slug, data, name, year, status) VALUES (?, ?, ?, ?, ?)').bind('remi', JSON.stringify({ name: 'Remi', slug: 'remi' }), 'Remi', 2026, 'completed').run();
  env = { DB, LIVE_HUB, CF_ACCOUNT_ID: 'acct', CF_STREAM_TOKEN: 'tok', RESEND_API_KEY: 're_test', ALERT_EMAILS: 'ops@example.com', FB_PAGE_ID: 'page', FB_PAGE_TOKEN: 'fbtok', ...ACCESS };
  b = await import('../functions/api/_broadcast.js');
  // A second copy of the module is a second isolate: its own in-memory throttles, the same D1
  b2 = await import('../functions/api/_broadcast.js?isolate=2');
  endpoints = {
    webhook: await import('../functions/api/stream-webhook.js'),
    event: await import('../functions/api/broadcast-event.js'),
    broadcast: await import('../functions/api/broadcast.js'),
    hooks: await import('../functions/api/broadcast-hooks.js'),
    ws: await import('../functions/api/live-ws.js'),
  };
  await b.ensureSchema(DB);
  const cfg = await b.readConfig(DB);
  await b.writeConfig(DB, { ...cfg, liveInput: { uid: 'in1', srt: { url: 'srt://live.cloudflare.com:778', streamId: 'sid', passphrase: 'pass' } }, rehearsalInput: { uid: 'rh1' } });
  jwt = await accessToken();
});

after(() => { Date.now = realNow; globalThis.fetch = realFetch; });

// ─── stream-webhook ─────────────────────────────────────────────────

const PHISH = 'Your account is suspended. Log in at https://evil.example.com/login now';
const errored = (inputId, extra = {}) => ({
  input_id: inputId, event_type: 'live_input.errored',
  live_input_errored: { error: { code: 'ERR_GOP_OUT_OF_RANGE', message: PHISH }, video_codec: 'h264', audio_codec: `aac <a href="https://evil.example.com">x</a>`, ...extra },
});

test('webhook with STREAM_WEBHOOK_SECRET set: a missing or wrong cf-webhook-auth is refused and does nothing', async () => {
  await freshBroadcast();
  env.STREAM_WEBHOOK_SECRET = SECRET;
  const before = (await b.readHealth(DB)).webhook?.count || 0;
  calls = [];
  const none = await endpoints.webhook.onRequestPost(ctx(hook(errored('in1'))));
  const wrong = await endpoints.webhook.onRequestPost(ctx(hook(errored('in1'), { 'cf-webhook-auth': 'nope' })));
  await flush();
  assert.equal(none.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(alerts().length, 0, 'no alert');
  assert.equal(lifecycleCalls(), 0, 'no tick');
  assert.equal((await b.readHealth(DB)).webhook?.count || 0, before, 'not even counted');
});

test('signed error webhook: one alert in our own words, deduped per input for 15 minutes', async () => {
  calls = [];
  const res = await endpoints.webhook.onRequestPost(ctx(hook(errored('in1'), signed)));
  await flush();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true }, 'the reply says nothing about which inputs we know');
  const [mail, ...more] = alerts(/Stream input error/);
  assert.ok(mail, 'staff alerted');
  assert.equal(more.length, 0);
  assert.equal(mail.subject, '[SOARD Live] Stream input error: ERR_GOP_OUT_OF_RANGE');
  for (const part of [mail.subject, mail.html, mail.text]) {
    assert.doesNotMatch(part, /evil\.example\.com|suspended|Log in/, 'nothing from the payload reaches staff');
  }
  assert.match(mail.text, /keyframe interval/i, 'our own explanation');

  // Stream repeats the error: no new alert inside 15 minutes, for the same input
  calls = [];
  await endpoints.webhook.onRequestPost(ctx(hook(errored('in1'), signed)));
  travel(10 * M);
  await endpoints.webhook.onRequestPost(ctx(hook(errored('in1'), signed)));
  await flush();
  assert.equal(alerts(/Stream input error/).length, 0, 'deduped');

  // The rehearsal input has its own window; an input that isn't ours never alerts
  await endpoints.webhook.onRequestPost(ctx(hook(errored('rh1', { video_codec: '<script>', audio_codec: 'opus' }), signed)));
  await endpoints.webhook.onRequestPost(ctx(hook(errored('someone-elses-input'), signed)));
  await flush();
  const reh = alerts(/Stream input error/);
  assert.equal(reh.length, 1);
  assert.match(reh[0].subject, /\(rehearsal\)/);
  assert.doesNotMatch(reh[0].html, /script/);

  travel(6 * M); // 16 minutes since the first live alert
  calls = [];
  await endpoints.webhook.onRequestPost(ctx(hook(errored('in1', { error: { code: 'ERR_SOMETHING_NEW', message: PHISH } }), signed)));
  await flush();
  const again = alerts(/Stream input error/);
  assert.equal(again.length, 1, 'alerts again after 15 minutes');
  assert.equal(again[0].subject, '[SOARD Live] Stream input error: unknown', 'an unknown code is not repeated');
});

test('errorAlert: codes and codecs only from fixed lists', () => {
  const a = endpoints.webhook.errorAlert('live', { error: { code: 'toString', message: PHISH }, video_codec: 'H264', audio_codec: { evil: true } });
  assert.match(a.title, /: unknown$/, 'prototype names are not codes');
  assert.deepEqual(a.facts, [['Video codec', 'h264'], ['Audio codec', 'unknown']]);
  assert.equal(a.urgent, true);
  assert.equal(endpoints.webhook.errorAlert('rehearsal', null).urgent, false);
});

test('signed webhook: only a whitelisted event name is stored and sent to the hub; odd payloads never crash', async () => {
  hub.published = [];
  const big = 'x'.repeat(20000);
  for (const event_type of [{ toString: 1 }, ['live_input.connected'], 42, big, 'live_input.connected']) {
    travel(6 * S);
    const res = await endpoints.webhook.onRequestPost(ctx(hook({ input_id: 'in1', event_type, extra: { blob: 'y'.repeat(1000) } }, signed)));
    assert.equal(res.status, 200);
  }
  const plain = await endpoints.webhook.onRequestPost(ctx(post('https://sunshineonaranneyday.com/api/stream-webhook', 'not json', signed)));
  assert.equal(plain.status, 200, "Cloudflare's test body is fine");
  await flush();
  const events = hub.published.map((p) => p.event).filter(Boolean);
  assert.ok(events.length >= 1);
  for (const e of events) assert.deepEqual(Object.keys(e), ['type']);
  assert.deepEqual([...new Set(events.map((e) => e.type))], ['live_input.connected'], 'junk event names never reach the hub');
  assert.ok(hub.published.every((p) => p.reason === 'webhook'), 'the reason is a kind, not the event');
  const h = (await b.readHealth(DB)).webhook;
  assert.equal(h.lastEvent, 'test', "Cloudflare's test (or junk) is stored as 'test'");
  assert.equal(h.signed, true);
});

test('signed connect webhooks force a tick at most once every 5 seconds', async () => {
  travel(10 * S);
  calls = [];
  // Each call answers at once; its tick runs after the reply (flush waits for it)
  const call = async (event_type) => { const res = await endpoints.webhook.onRequestPost(ctx(hook({ input_id: 'in1', event_type }, signed))); assert.deepEqual(await res.json(), { ok: true }); await flush(); };
  await call('live_input.connected');
  assert.equal(lifecycleCalls(), 1, 'first: forced, Stream asked right away');
  await call('live_input.connected');
  await call('live_input.disconnected');
  assert.equal(lifecycleCalls(), 1, 'within 5 s: ordinary throttled ticks');
  travel(6 * S);
  await call('live_input.connected');
  assert.equal(lifecycleCalls(), 2, 'forced again after 5 s');
});

test('unsigned webhook (no secret set yet): never alerts, never forces', async () => {
  delete env.STREAM_WEBHOOK_SECRET;
  travel(20 * M);
  calls = [];
  const res = await endpoints.webhook.onRequestPost(ctx(hook(errored('in1'))));
  assert.deepEqual(await res.json(), { ok: true });
  await endpoints.webhook.onRequestPost(ctx(hook({ input_id: 'in1', event_type: 'live_input.connected' })));
  await flush();
  assert.equal(alerts().length, 0, 'anyone could have sent it, so no alert');
  assert.equal(lifecycleCalls(), 1, 'one ordinary tick; the second call is throttled');
  const h = (await b.readHealth(DB)).webhook;
  assert.equal(h.signed, false);
  assert.equal(h.lastEvent, 'live_input.connected');
});

test("a tick holding an old copy of health can't wipe the webhook's record", async () => {
  const stale = await b.readHealth(DB);
  const n = stale.webhook.count;
  await b.noteWebhook(DB, { event: 'live_input.disconnected', signed: true });
  await b.writeHealth(DB, { ...stale, lastDailyAt: new Date().toISOString() });
  const h = await b.readHealth(DB);
  assert.equal(h.webhook.count, n + 1);
  assert.equal(h.webhook.lastEvent, 'live_input.disconnected');
  assert.ok(h.lastDailyAt, 'the rest of the tick write landed');
});

// ─── broadcast-event ────────────────────────────────────────────────

const beacon = (body) => endpoints.event.onRequestPost(ctx(post('https://sunshineonaranneyday.com/api/broadcast-event', body)));

test('banner clicks are counted in place; a click never rewrites the state', async () => {
  await freshBroadcast('scheduled');
  const s0 = await b.readState(DB);
  await beacon({ type: 'banner_click', broadcastId: s0.broadcastId });
  await beacon({ type: 'banner_click' });
  const s1 = await b.readState(DB);
  assert.equal(s1.clicks, 2);
  assert.equal(s1.rev, s0.rev, 'no state write');
  // A tick or admin write with an older count keeps the higher one for the same broadcast
  await b.writeState(DB, { ...s0, title: 'Edited' });
  const s2 = await b.readState(DB);
  assert.equal(s2.clicks, 2);
  assert.equal(s2.title, 'Edited');
});

test("a late click can't undo an admin cancel", async () => {
  const s = await b.readState(DB);
  const r = await b.adminAction(env, 'cancel', {}, 'staff@example.com');
  assert.equal(r.success, true);
  await beacon({ type: 'banner_click', broadcastId: s.broadcastId });
  const after = await b.readState(DB);
  assert.equal(after.phase, 'idle', 'still cancelled');
  assert.equal(after.broadcastId, null);
});

test('broadcast ids are checked and meta is kept small and flat', async () => {
  await freshBroadcast('scheduled');
  const s = await b.readState(DB);
  const before = await count('SELECT COUNT(*) AS n FROM broadcast_events');
  await beacon({ type: 'click_donate', broadcastId: 'live-123456' });             // never existed
  await beacon({ type: 'click_donate', broadcastId: 'not-a-broadcast' });          // wrong shape
  await beacon({ type: 'click_donate', broadcastId: { $gt: '' } });                // not a string
  assert.equal(await count('SELECT COUNT(*) AS n FROM broadcast_events'), before, 'dropped');
  await beacon({
    type: 'click_donate', broadcastId: s.broadcastId,
    meta: { where: 'x'.repeat(500), how: 'panel', n: 3, ok: true, nested: { a: 1 }, list: [1], 'bad key': 'v', __proto__x: 'v', a1: '1', a2: '2', a3: '3', a4: '4' },
  });
  const row = await DB.prepare('SELECT broadcast_id, meta FROM broadcast_events ORDER BY id DESC LIMIT 1').first();
  assert.equal(row.broadcast_id, s.broadcastId);
  const meta = JSON.parse(row.meta);
  assert.ok(Object.keys(meta).length <= 6);
  assert.equal(meta.where.length, 80);
  assert.equal(meta.n, 3);
  assert.equal(meta.ok, true);
  assert.ok(!('nested' in meta) && !('list' in meta) && !('bad key' in meta));
  // A broadcast we really had (a replay page left open) still counts
  const past = s.broadcastId;
  await freshBroadcast('scheduled');
  await beacon({ type: 'click_replay', broadcastId: past });
  assert.equal((await DB.prepare('SELECT broadcast_id FROM broadcast_events ORDER BY id DESC LIMIT 1').first()).broadcast_id, past);
});

// ─── The tick: lease, rev check, claims ─────────────────────────────

async function apiModeLive() {
  const cfg = await b.readConfig(DB);
  await b.writeConfig(DB, { ...cfg, facebook: { ...cfg.facebook, mode: 'api' } });
  sim.live = true; sim.videoUID = 'vid1'; sim.lifecycleDelay = 40;
}

async function liveSideEffects(since) {
  return {
    fbPosts: fbPosts(),
    outputs: outputPosts(),
    liveAlerts: alerts(/Live now/).length,
    liveStarts: await count(`SELECT COUNT(*) AS n FROM broadcast_events WHERE type = 'live_start' AND id > ?`, since),
    audits: await count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'live-status' AND action = 'published' AND id > ?`, since),
  };
}

test('two isolates race the go-live: the lease lets one run it; one Facebook post, one alert', async () => {
  await freshBroadcast('scheduled');
  await apiModeLive();
  const since = await count('SELECT MAX(id) AS n FROM broadcast_events');
  const auditSince = await count('SELECT MAX(id) AS n FROM audit_log');
  calls = [];
  const [r1, r2] = await Promise.all([b.runTick(env, { source: 'test', force: true }), b2.runTick(env, { source: 'test', force: true })]);
  await flush();
  assert.equal(r1.state.phase, 'live');
  assert.equal(r2.state.phase, 'live');
  const fx = await liveSideEffects(since);
  assert.equal(fx.fbPosts, 1, 'one Facebook live post');
  assert.equal(fx.outputs, 1, 'one Stream output to Facebook');
  assert.equal(fx.liveAlerts, 1, 'one "Live now" alert');
  assert.equal(fx.liveStarts, 1);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'live-status' AND action = 'published' AND id > ?`, auditSince), 1);
  assert.equal((await b.readState(DB)).fb.liveVideoId, 'fbv1');
});

test('with the lease unreachable, the rev check still lets only one tick announce the go-live', async () => {
  await freshBroadcast('scheduled');
  await apiModeLive();
  const since = await count('SELECT MAX(id) AS n FROM broadcast_events');
  const rows = await count('SELECT COUNT(*) AS n FROM broadcasts');
  const raw = { ...env, DB: withoutLease(DB) };
  calls = [];
  const results = await Promise.all([b.runTick(raw, { source: 'a', force: true }), b2.runTick(raw, { source: 'b', force: true })]);
  await flush();
  assert.equal(results.filter((r) => r.conflict).length, 1, 'the second tick saw it lost and stopped');
  const fx = await liveSideEffects(since);
  assert.equal(fx.fbPosts, 1);
  assert.equal(fx.outputs, 1);
  assert.equal(fx.liveAlerts, 1);
  assert.equal(fx.liveStarts, 1);
  assert.equal((await b.readState(DB)).phase, 'live');
  assert.equal(await count('SELECT COUNT(*) AS n FROM broadcasts'), rows, 'no stray broadcast row');
});

test('unplanned go-live with the lease unreachable: one broadcast, not two', async () => {
  await freshBroadcast(); // idle: each racing tick would invent its own broadcast id
  await apiModeLive();
  const rows = await count('SELECT COUNT(*) AS n FROM broadcasts');
  const raw = { ...env, DB: withoutLease(DB) };
  calls = [];
  await Promise.all([b.runTick(raw, { source: 'a', force: true }), b2.runTick(raw, { source: 'b', force: true })]);
  await flush();
  assert.equal(await count('SELECT COUNT(*) AS n FROM broadcasts'), rows + 1);
  assert.equal(fbPosts(), 1);
  assert.equal(alerts(/Live now/).length, 1);
});

test('a claimed side effect hands its result to a tick that runs it again', async () => {
  // As if a tick posted to Facebook, then lost its state write: the next one reads the id back
  await freshBroadcast('scheduled');
  await apiModeLive();
  const s = await b.readState(DB);
  await DB.prepare(`INSERT INTO broadcast_claims (broadcast_id, key, result, created_at) VALUES (?, 'fb-live-post', ?, ?)`)
    .bind(s.broadcastId, JSON.stringify({ liveVideoId: 'fbv-earlier', outputUid: 'out-earlier' }), new Date().toISOString()).run();
  calls = [];
  await b.runTick(env, { source: 'test', force: true });
  await flush();
  assert.equal(fbPosts(), 0, 'no second Facebook post');
  const after = await b.readState(DB);
  assert.equal(after.fb.liveVideoId, 'fbv-earlier');
  assert.equal(after.fb.outputUid, 'out-earlier');
});

test('an admin cancel during a tick waits for the lease and is never undone', async () => {
  await freshBroadcast('scheduled', 31);
  travel(2 * M); // 29 minutes out: the next tick arms it
  assert.equal((await b.readState(DB)).phase, 'scheduled');
  sim.live = false; sim.lifecycleDelay = 120;
  const ticking = b.runTick(env, { source: 'test', force: true });
  await sleep(20); // the tick holds the lease and is waiting on Stream
  const cancel = await b2.adminAction(env, 'cancel', {}, 'staff@example.com');
  const t = await ticking;
  assert.equal(t.state.phase, 'armed', 'the tick finished first');
  assert.equal(cancel.success, true, cancel.error);
  const s = await b.readState(DB);
  assert.equal(s.phase, 'idle');
  assert.equal(s.note, 'cancelled');
});

test('with the lease unreachable, a tick that read before an admin cancel loses instead of reverting it', async () => {
  await freshBroadcast('scheduled', 31);
  travel(2 * M); // the tick will arm it
  sim.live = false; sim.lifecycleDelay = 120;
  const raw = { ...env, DB: withoutLease(DB) };
  const ticking = b.runTick(raw, { source: 'test', force: true });
  await sleep(20); // the tick has read "scheduled" and is waiting on Stream
  const cancel = await b2.adminAction(raw, 'cancel', {}, 'staff@example.com');
  assert.equal(cancel.success, true, cancel.error);
  const t = await ticking;
  assert.equal(t.conflict, true);
  const s = await b.readState(DB);
  assert.equal(s.phase, 'idle', 'the old code saved "armed" over the cancel');
});

test('with the lease unreachable, a tick merges its own changes over an admin edit (both kept)', async () => {
  await freshBroadcast('scheduled');
  sim.live = true; sim.videoUID = 'vid9'; sim.lifecycleDelay = 0;
  sim.graphVideos = [];
  const cfg = await b.readConfig(DB);
  await b.writeConfig(DB, { ...cfg, facebook: { ...cfg.facebook, mode: 'persistent' } });
  await b.runTick(env, { source: 'test', force: true });
  assert.equal((await b.readState(DB)).phase, 'live');
  // Next tick finds the Facebook permalink while staff rename the reveal
  travel(2 * M);
  sim.graphVideos = [{ id: 'fbl1', live_status: 'LIVE', permalink_url: '/SunshineOnaRanneyDay/videos/123' }];
  sim.lifecycleDelay = 120;
  const raw = { ...env, DB: withoutLease(DB) };
  const ticking = b.runTick(raw, { source: 'test', force: true });
  await sleep(20);
  const upd = await b2.adminAction(raw, 'update', { title: 'Renamed by staff' }, 'staff@example.com');
  assert.equal(upd.success, true, upd.error);
  await ticking;
  const s = await b.readState(DB);
  assert.equal(s.title, 'Renamed by staff', "the admin's edit stands");
  assert.equal(s.fb.permalink, 'https://www.facebook.com/SunshineOnaRanneyDay/videos/123', "and so does the tick's");
  sim.graphVideos = [];
});

test('mergeState: ours over theirs key by key; theirs wins ties and phase changes', () => {
  const base = { phase: 'live', broadcastId: 'live-1', title: 'A', fb: { permalink: null }, rev: 4 };
  const ours = { ...base, fb: { permalink: 'p' }, title: 'A' };
  assert.deepEqual(b.mergeState(base, ours, { ...base, title: 'B', rev: 5 }), { state: { ...base, title: 'B', fb: { permalink: 'p' }, rev: 5 }, dropped: false });
  assert.equal(b.mergeState(base, { ...base, title: 'Ours' }, { ...base, title: 'Theirs', rev: 5 }).state.title, 'Theirs');
  assert.equal(b.mergeState(base, ours, { ...base, phase: 'replay', rev: 5 }).dropped, true);
  assert.equal(b.mergeState(base, ours, { ...base, broadcastId: 'live-2', rev: 5 }).dropped, true);
});

test('public GETs never force a tick, and the throttle holds across isolates', async () => {
  await freshBroadcast();
  sim.lifecycleDelay = 0;
  travel(30 * S); // both isolates' own caches have expired
  await b2.runTick(env, { source: 'hub', force: true }); // the other isolate ticked just now
  calls = [];
  const res = await endpoints.broadcast.onRequestGet(ctx(new Request('https://sunshineonaranneyday.com/api/broadcast')));
  assert.equal(res.status, 200);
  await flush();
  assert.equal(lifecycleCalls(), 0, 'a visitor tick waits 20 s after any tick, in any isolate');
  travel(21 * S);
  calls = [];
  await endpoints.broadcast.onRequestGet(ctx(new Request('https://sunshineonaranneyday.com/api/broadcast')));
  await flush();
  assert.equal(lifecycleCalls(), 1, 'then it runs');
});

test('the hub only ever gets the kind of reason', async () => {
  hub.published = [];
  await b.publishToHub(env, await b.readState(DB), await b.readConfig(DB), 'admin:cancel');
  await b.publishToHub(env, await b.readState(DB), await b.readConfig(DB), 'email:day:3/3,kid:remi:facebook-live');
  assert.deepEqual(hub.published.map((p) => p.reason), ['admin', 'email']);
});

// ─── fb-live-videos ─────────────────────────────────────────────────

const VIDEOS = ['LIVE', 'VOD', 'SCHEDULED_UNPUBLISHED', 'UNPUBLISHED', 'LIVE_STOPPED', 'SCHEDULED_LIVE'].map((s, i) => ({ id: `v${i}`, live_status: s, permalink_url: `/page/videos/${i}`, title: s }));
const graphCalls = () => calls.filter((c) => c.url.includes('graph.facebook.com') && c.url.includes('/videos')).length;
let fbn = 0;
const fbModule = () => import(`../functions/api/fb-live-videos.js?fresh-copy=${++fbn}`);
const fbGet = (mod, qs = '', headers = {}) => mod.onRequestGet(ctx(new Request(`https://sunshineonaranneyday.com/api/fb-live-videos${qs}`, { headers })));

test('fb-live-videos: the public gets LIVE and VOD only, from the cache, whatever ?fresh says', async () => {
  const mod = await fbModule();
  sim.graphVideos = VIDEOS.slice(0, 5); sim.graphError = null;
  calls = [];
  const one = await (await fbGet(mod, '?fresh=1')).json();
  const two = await (await fbGet(mod, '?fresh=1')).json();
  assert.equal(graphCalls(), 1, '?fresh=1 from the public does not skip the cache');
  assert.deepEqual(one.videos.map((v) => v.status), ['LIVE', 'VOD']);
  assert.deepEqual(two, one);
});

test('fb-live-videos: a signed-in admin sees every broadcast and may skip the cache', async () => {
  const mod = await fbModule();
  sim.graphVideos = VIDEOS.slice(0, 5);
  calls = [];
  const auth = { 'CF-Access-JWT-Assertion': jwt };
  const first = await (await fbGet(mod, '', auth)).json();
  await fbGet(mod, '?fresh=1', auth);
  assert.equal(graphCalls(), 2, 'fresh=1 skips the cache for staff');
  assert.equal(first.videos.length, 5);
  const pub = await (await fbGet(mod, '?fresh=1')).json();
  assert.equal(graphCalls(), 2, 'the public reads what staff fetched');
  assert.deepEqual(pub.videos.map((v) => v.status), ['LIVE', 'VOD']);
  const forged = await (await fbGet(mod, '?fresh=1', { 'CF-Access-JWT-Assertion': `${jwt.slice(0, -4)}AAAA` })).json();
  assert.equal(graphCalls(), 2, 'a forged token is just the public');
  assert.deepEqual(forged.videos.map((v) => v.status), ['LIVE', 'VOD']);
});

test("fb-live-videos: Facebook's error text is never passed on", async () => {
  const mod = await fbModule();
  sim.graphError = { message: PHISH, code: 190, type: 'OAuthException' };
  const pub = await (await fbGet(mod)).json();
  assert.equal(pub.success, false);
  assert.doesNotMatch(JSON.stringify(pub), /evil|suspended/);
  const mod2 = await fbModule();
  const staff = await (await fbGet(mod2, '', { 'CF-Access-JWT-Assertion': jwt })).json();
  assert.equal(staff.error, 'The Facebook token expired or was revoked (code 190)');
  assert.doesNotMatch(JSON.stringify(staff), /evil|suspended/);
  sim.graphError = null;
});

// ─── live-ws ────────────────────────────────────────────────────────

const wsReq = (url, headers = {}) => new Request(url, { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.9', ...headers } });

test('live-ws: only pages on this site may open a socket', async () => {
  const site = 'https://sunshineonaranneyday.com/api/live-ws';
  hub.sockets = [];
  const cases = [
    [wsReq(site), 403],
    [wsReq(site, { Origin: 'https://evil.example.com' }), 403],
    [wsReq(site, { Origin: 'http://localhost:4321' }), 403],
    [wsReq(site, { Origin: 'https://sunshineonaranneyday.com' }), 200],
    [wsReq('https://abc123.soard-site.pages.dev/api/live-ws', { Origin: 'https://abc123.soard-site.pages.dev' }), 200],
    [wsReq('http://localhost:8788/api/live-ws', { Origin: 'http://localhost:4321' }), 200],
  ];
  for (const [req, status] of cases) {
    const res = await endpoints.ws.onRequestGet(ctx(req));
    assert.equal(res.status, status, `${req.url} from ${req.headers.get('Origin')}`);
  }
  assert.equal(hub.sockets.length, 3);
});

test('live-ws: admin only with a valid Access login; the address is ours, never the caller\'s', async () => {
  hub.sockets = [];
  const origin = { Origin: 'https://sunshineonaranneyday.com' };
  await endpoints.ws.onRequestGet(ctx(wsReq('https://sunshineonaranneyday.com/api/live-ws?role=admin', { ...origin, 'x-soard-client-ip': '1.2.3.4' })));
  await endpoints.ws.onRequestGet(ctx(wsReq('https://sunshineonaranneyday.com/api/live-ws?role=admin', { ...origin, 'CF-Access-JWT-Assertion': jwt })));
  await endpoints.ws.onRequestGet(ctx(wsReq('https://sunshineonaranneyday.com/api/live-ws', { ...origin, 'CF-Connecting-IP': '2001:db8:1:2:3:4:5:6' })));
  const [anon, staff, v6] = hub.sockets;
  assert.equal(new URL(anon.url).searchParams.get('role'), 'site', 'role=admin without a login is a site socket');
  assert.equal(new URL(staff.url).searchParams.get('role'), 'admin');
  assert.equal(anon.headers.get('x-soard-client-ip'), '203.0.113.9', 'a caller-supplied address is replaced');
  assert.equal(v6.headers.get('x-soard-client-ip'), '2001:db8:1:2::/64', 'IPv6 counts per /64');
  assert.equal(anon.headers.get('upgrade'), 'websocket');
});

// ─── Follow-up: effects survive a cut-off tick; the lease stays short ─

/** A D1 that throws once on the first statement matching `pattern` (as if the request died right there) */
function failOnce(db, pattern) {
  let armed = true;
  return { ...db, prepare: (sql) => {
    if (armed && pattern.test(sql)) { armed = false; throw new Error('cut off'); }
    return db.prepare(sql);
  } };
}
/** A D1 that logs every bound statement */
function spy(db, log) {
  return { ...db, prepare: (sql) => {
    const st = db.prepare(sql);
    return { ...st, bind: (...args) => { log.push({ sql, args }); return st.bind(...args); } };
  } };
}

async function addSubscriber() {
  await DB.prepare(`INSERT OR IGNORE INTO broadcast_reminders (id, channel, address, kid_slug, token, source, created_at, fails) VALUES ('r-fan', 'email', 'fan@example.com', NULL, 'tok-fan', 'test', ?, 0)`)
    .bind(new Date().toISOString()).run();
}
const liveReminderEmails = () => calls.filter((c) => c.url.startsWith('https://api.resend.com/emails'))
  .flatMap((c) => { try { return JSON.parse(c.body); } catch { return []; } })
  .filter((m) => (m.to || []).includes('fan@example.com'));

test('a tick cut off right after saving the go-live loses none of its side effects', async () => {
  await freshBroadcast('scheduled');
  await addSubscriber();
  await apiModeLive();
  sim.lifecycleDelay = 0;
  const since = await count('SELECT MAX(id) AS n FROM broadcast_events');
  calls = [];
  // The phase is saved, then the next D1 write (the broadcast row) dies with the request
  await assert.rejects(b.runTick({ ...env, DB: failOnce(DB, /^INSERT INTO broadcasts/) }, { source: 'test', force: true }));
  const s = await b.readState(DB);
  assert.equal(s.phase, 'live', 'the go-live was saved');
  assert.equal(fbPosts(), 0);
  assert.equal(alerts(/Live now/).length, 0, 'nothing announced yet');
  assert.equal((await DB.prepare('SELECT phase FROM broadcasts WHERE id = ?').bind(s.broadcastId).first())?.phase, 'armed', 'the row still says it is coming up');

  travel(9 * S); // the hub's next heartbeat
  await b.runTick(env, { source: 'hub' });
  await flush();
  assert.equal(fbPosts(), 1, 'the Facebook live post goes out on the next tick');
  assert.equal(outputPosts(), 1);
  assert.equal(alerts(/Live now/).length, 1, 'staff hear about it');
  assert.equal(await count(`SELECT COUNT(*) AS n FROM broadcast_events WHERE type = 'live_start' AND id > ?`, since), 1);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM broadcast_sends WHERE broadcast_id = ? AND kind = 'live' AND channel = 'email'`, s.broadcastId), 1, 'the "we\'re live" reminder started');
  assert.equal(liveReminderEmails().length, 1, 'and reached the subscriber');
  assert.equal((await DB.prepare('SELECT phase FROM broadcasts WHERE id = ?').bind(s.broadcastId).first())?.phase, 'live', 'the row is there');
  assert.equal((await b.readState(DB)).fb.liveVideoId, 'fbv1');

  travel(9 * S);
  await b.runTick(env, { source: 'hub' });
  await flush();
  assert.equal(fbPosts(), 1, 'and only once');
  assert.equal(alerts(/Live now/).length, 1);
  assert.equal(liveReminderEmails().length, 1);
});

test('a tick cut off right after saving the end still ends Facebook and announces it once', async () => {
  // Carries on from the live broadcast above
  sim.live = false;
  travel(9 * S);
  await b.runTick(env, { source: 'hub' }); // ending
  travel(50 * S);
  calls = [];
  await assert.rejects(b.runTick({ ...env, DB: failOnce(DB, /^INSERT INTO broadcasts/) }, { source: 'test', force: true }));
  const s = await b.readState(DB);
  assert.equal(s.phase, 'replay');
  assert.equal(alerts(/Ended/).length, 0);
  travel(9 * S);
  await b.runTick(env, { source: 'hub' });
  await flush();
  assert.equal(alerts(/Ended/).length, 1);
  assert.equal(calls.filter((c) => c.url.includes('graph.facebook.com/v25.0/fbv1') && c.method === 'POST').length, 1, 'the Facebook live video is ended');
  assert.equal(await count(`SELECT COUNT(*) AS n FROM broadcast_events WHERE broadcast_id = ? AND type = 'live_end'`, s.broadcastId), 1);
  travel(9 * S);
  await b.runTick(env, { source: 'hub' });
  await flush();
  assert.equal(alerts(/Ended/).length, 1, 'once');
});

test('"End now" in the admin is not announced again by the next tick', async () => {
  await freshBroadcast('scheduled');
  await apiModeLive();
  sim.lifecycleDelay = 0;
  await b.runTick(env, { source: 'test', force: true });
  assert.equal((await b.readState(DB)).phase, 'live');
  const r = await b.adminAction(env, 'endNow', {}, 'staff@example.com');
  assert.equal(r.success, true, r.error);
  sim.live = false;
  calls = [];
  travel(9 * S);
  await b.runTick(env, { source: 'hub' });
  await flush();
  assert.equal(alerts(/Ended/).length, 0, 'the admin ended it; nothing more to announce');
  assert.equal(calls.filter((c) => c.url.includes('graph.facebook.com/v25.0/fbv1') && c.method === 'POST').length, 0);
});

test("a broadcast that went live long before the claims existed isn't announced again", async () => {
  await freshBroadcast();
  const s = await b.readState(DB);
  await b.writeState(DB, { ...s, phase: 'live', source: 'stream', broadcastId: 'live-1700000000000', title: 'Old', liveAt: new Date(Date.now() - 20 * M).toISOString(), segmentAt: new Date(Date.now() - 20 * M).toISOString() });
  sim.live = true; sim.videoUID = 'vid1'; sim.lifecycleDelay = 0;
  calls = [];
  travel(9 * S);
  await b.runTick(env, { source: 'hub' });
  await flush();
  assert.equal(alerts(/Live now/).length, 0);
  assert.equal(fbPosts(), 0);
  sim.live = false;
});

test('a long tick keeps extending its lease; one that lost it stops and leaves the new holder alone', async () => {
  await freshBroadcast();
  sim.lifecycleDelay = 0;
  // Stream takes "6 s" to answer: the tick extends its lease before its next step
  const log = [];
  sim.onLifecycle = async () => { travel(6 * S); };
  travel(30 * S);
  const r = await b.runTick({ ...env, DB: spy(DB, log) }, { source: 'test', force: true });
  sim.onLifecycle = null;
  const extends_ = log.filter((x) => /^UPDATE broadcast_locks SET expires_at = \? WHERE/.test(x.sql) && x.args[0] > 0);
  assert.ok(extends_.length >= 1, 'extended');
  assert.ok(Math.abs(extends_[0].args[0] - (Date.now() + 15 * S)) < 5 * S, 'by 15 s from then');
  assert.ok(!r.work.includes('lease-lost'));

  // This time the lease ran out while Stream was slow, and another tick took it
  sim.onLifecycle = async () => {
    travel(16 * S);
    await DB.prepare(`UPDATE broadcast_locks SET holder = 'rival', expires_at = ? WHERE name = 'tick'`).bind(Date.now() + 15 * S).run();
  };
  travel(30 * S);
  const lost = await b.runTick(env, { source: 'test', force: true });
  sim.onLifecycle = null;
  assert.ok(lost.work.includes('lease-lost'), lost.work.join(','));
  const lock = await DB.prepare(`SELECT holder, expires_at FROM broadcast_locks WHERE name = 'tick'`).first();
  assert.equal(lock.holder, 'rival', 'its release never touches the rival');
  assert.ok(lock.expires_at > Date.now());
  await DB.prepare(`UPDATE broadcast_locks SET expires_at = 0 WHERE name = 'tick'`).run();
});

test("a visitor's busy no-op never holds up the hub's heartbeat on the same isolate", async () => {
  travel(60 * S);
  sim.lifecycleDelay = 0;
  // Someone else holds the lease
  await DB.prepare(`UPDATE broadcast_locks SET holder = 'other', expires_at = ? WHERE name = 'tick'`).bind(Date.now() + 15 * S).run();
  const visitor = await b.runTick(env, { source: 'visitor', minIntervalMs: 20000 });
  assert.equal(visitor.busy, true);
  const again = await b.runTick(env, { source: 'visitor', minIntervalMs: 20000 });
  assert.equal(again.cached, true, 'visitors reuse the busy answer for a while (no D1 round trips)');
  await DB.prepare(`UPDATE broadcast_locks SET expires_at = 0, started_at = 0 WHERE name = 'tick'`).run();
  const hubTick = await b.runTick(env, { source: 'hub' });
  assert.ok(!hubTick.busy && !hubTick.cached, 'the heartbeat right after runs for real');
});

test('the hub gets an answer within 10 s; a slower tick finishes after it and publishes its own change', async () => {
  await freshBroadcast('scheduled');
  const cfg = await b.readConfig(DB);
  await b.writeConfig(DB, { ...cfg, facebook: { ...cfg.facebook, mode: 'persistent' } });
  sim.live = true; sim.videoUID = 'vid3'; sim.lifecycleDelay = 0;
  let open;
  sim.lifecycleGate = new Promise((r) => { open = r; });
  travel(30 * S);
  hub.nonces.add(NONCE);
  hub.published = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const answering = endpoints.hooks.onRequestPost(ctx(post('https://sunshineonaranneyday.com/api/broadcast-hooks', { type: 'tick', source: 'alarm' }, { 'x-hub-nonce': NONCE })));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); // the tick is now waiting on Stream
    mock.timers.tick(10 * S);
    const res = await answering;
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.busy, true);
    assert.equal(body.state.phase, 'armed', 'the state as it stands');
    assert.equal(hub.published.length, 0);
  } finally {
    mock.timers.reset();
  }
  open();
  sim.lifecycleGate = null;
  await flush();
  assert.equal((await b.readState(DB)).phase, 'live', 'the tick finished after the answer');
  assert.equal(hub.published.at(-1)?.state?.phase, 'live', 'and pushed the change to the hub itself');
  assert.equal(hub.published.at(-1)?.reason, 'tick');
  sim.live = false;
});
