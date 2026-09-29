/**
 * Live broadcast state machine — scenario tests
 * Run: node --test tests/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';

// ─── Time travel ────────────────────────────────────────────────────
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const travel = (ms) => { offset += ms; };
const H = 3600e3, M = 60e3, S = 1000;

// ─── Fake network ───────────────────────────────────────────────────
const sim = { live: false, videoUID: null, videoState: 'live-inprogress', viewers: 3 };
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  calls.push({ url, method, body: init.body });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('cloudflarestream.com/') && url.endsWith('/lifecycle')) return json({ isInput: true, videoUID: sim.live ? sim.videoUID : null, live: sim.live });
  if (url.includes('cloudflarestream.com/') && url.endsWith('/views')) return json({ liveViewers: sim.viewers });
  if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/acct/stream/live_inputs') && method === 'POST' && !url.includes('/outputs')) {
    return json({ success: true, result: { uid: 'in1', created: new Date().toISOString(), meta: { name: 'SOARD reveals' }, rtmps: { url: 'rtmps://live.cloudflare.com:443/live/', streamKey: 'rtmpkey123456789' }, srt: { url: 'srt://live.cloudflare.com:778', streamId: 'sid123456789', passphrase: 'pass123456789' }, recording: { mode: 'automatic' }, enabled: true } });
  }
  if (url.includes('/stream/live_inputs/in1/outputs') && method === 'POST') return json({ success: true, result: { uid: 'out1' } });
  if (url.includes('/stream/live_inputs/in1/outputs')) return json({ success: true, result: [] });
  if (url.includes('/stream/live_inputs/in1/videos')) return json({ success: true, result: [] });
  if (url.includes('/stream/live_inputs/in1')) return json({ success: true, result: { uid: 'in1', srt: { url: 'srt://live.cloudflare.com:778', streamId: 'sid123456789', passphrase: 'pass123456789' } } });
  if (url.includes('/stream?per_page=1')) return json({ success: true, result: [] });
  if (/\/stream\/vid1\/captions\//.test(url)) return json({ success: true, result: {} });
  if (/\/stream\/vid1$/.test(url)) return json({ success: true, result: { uid: 'vid1', status: { state: sim.videoState } } });
  if (url.startsWith('https://api.resend.com/emails/batch')) return json({ data: [] });
  if (url.startsWith('https://hook.test/')) return new Response('ok', { status: 200 });
  return new Response('not mocked: ' + url, { status: 599 });
};

// ─── Fake hub binding ───────────────────────────────────────────────
const hub = { published: [], nonces: new Set(['good']) };
const LIVE_HUB = {
  idFromName: () => 'main',
  get: () => ({
    async fetch(url, init = {}) {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : {};
      if (path === '/publish') { hub.published.push(body); return Response.json({ ok: true, changed: true, clients: 1 }); }
      if (path === '/verify') { const ok = hub.nonces.delete(body.nonce); return Response.json({ ok }); }
      if (path === '/status') return Response.json({ ok: true, clients: 1, phase: 'idle' });
      return new Response('nf', { status: 404 });
    },
  }),
};

let env, b, notify, streamLive, endpoints;
const ctx = (request, extra = {}) => ({ env, request, data: { userEmail: 'peter@test' }, waitUntil: (p) => { ctx.pending.push(Promise.resolve(p).catch(() => {})); }, ...extra });
ctx.pending = [];
const flush = () => Promise.all(ctx.pending.splice(0));
const post = (url, body, headers = {}) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare(`INSERT INTO kids (slug, data, name, year, status) VALUES (?, ?, ?, ?, ?)`).bind('remi', JSON.stringify({ name: 'Remi', slug: 'remi', heroImage: 'kids/remi/hero' }), 'Remi', 2026, 'completed').run();
  env = { DB, LIVE_HUB, CF_ACCOUNT_ID: 'acct', CF_STREAM_TOKEN: 'tok', RESEND_API_KEY: 're_test', CF_PAGES_DEPLOY_HOOK: 'https://hook.test/deploy' };
  b = await import('../functions/api/_broadcast.js');
  notify = await import('../functions/api/_broadcast-notify.js');
  streamLive = await import('../functions/api/_stream-live.js');
  endpoints = {
    admin: await import('../functions/api/broadcast-admin.js'),
    reminders: await import('../functions/api/reminders.js'),
    hooks: await import('../functions/api/broadcast-hooks.js'),
    webhook: await import('../functions/api/stream-webhook.js'),
    legacy: await import('../functions/api/live-status.js'),
    event: await import('../functions/api/broadcast-event.js'),
  };
});

after(() => { Date.now = realNow; globalThis.fetch = realFetch; });

test('schema + defaults', async () => {
  await b.ensureSchema(env.DB);
  const cfg = await b.readConfig(env.DB);
  assert.equal(cfg.facebook.mode, 'persistent');
  const st = await b.readState(env.DB);
  assert.equal(st.phase, 'idle');
  assert.equal(b.publicState(st, cfg).live, false);
});

test('setup live input via admin endpoint', async () => {
  const res = await endpoints.admin.onRequestPost(ctx(post('https://x/api/broadcast-admin', { action: 'setupInput' })));
  const data = await res.json();
  assert.equal(data.success, true, JSON.stringify(data));
  const cfg = await b.readConfig(env.DB);
  assert.equal(cfg.liveInput.uid, 'in1');
  assert.equal(cfg.liveInput.srt.passphrase, 'pass123456789', 'full record kept server-side');
  assert.match(data.input.srt.passphrase, /…/, 'redacted in response');
  const link = streamLive.larixSetupLink(cfg.liveInput);
  assert.match(link, /^larix:\/\/set\/v1\?/);
  assert.match(link, /srtstreamid%5D=sid123456789/);
  assert.match(link, /srtpass%5D=pass123456789/);
  assert.match(link, /enc%5Bvid%5D%5Bkeyframe%5D=2/);
});

test('schedule a reveal for a kid', async () => {
  const at = new Date(Date.now() + 2 * 24 * H).toISOString();
  const r = await b.adminAction(env, 'schedule', { kidSlug: 'remi', scheduledAt: at }, 'peter@test');
  assert.equal(r.success, true, r.error);
  assert.equal(r.state.phase, 'scheduled');
  assert.equal(r.state.kidName, 'Remi');
  assert.equal(r.state.image, 'kids/remi/hero');
  assert.equal(r.state.liveUrl, 'https://sunshineonaranneyday.com/live/remi/');
  assert.match(r.state.title, /Remi's room reveal/);
  const row = await env.DB.prepare('SELECT * FROM broadcasts WHERE id = ?').bind(r.state.id).first();
  assert.equal(row.kid_slug, 'remi');
  assert.ok(hub.published.length >= 1, 'published to hub');
  assert.equal(hub.published.at(-1).state.phase, 'scheduled');
});

test('visitor signs up for email reminders', async () => {
  const res = await endpoints.reminders.onRequestPost(ctx(post('https://x/api/reminders', { channel: 'email', email: 'Fan@Example.com', kidSlug: 'remi', hp: '' })));
  assert.equal((await res.json()).ok, true);
  const res2 = await endpoints.reminders.onRequestPost(ctx(post('https://x/api/reminders', { channel: 'email', email: 'fan@example.com' })));
  assert.equal((await res2.json()).ok, true, 'upsert on conflict');
  const rows = await env.DB.prepare('SELECT * FROM broadcast_reminders').all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].address, 'fan@example.com');
  const bot = await endpoints.reminders.onRequestPost(ctx(post('https://x/api/reminders', { channel: 'email', email: 'bot@x.com', hp: 'filled' })));
  assert.equal((await bot.json()).ok, true, 'honeypot pretends success');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM broadcast_reminders').first()).n, 1);
  const ics = await endpoints.reminders.onRequestGet(ctx(new Request('https://x/api/reminders?ics=1')));
  assert.equal(ics.status, 200);
  assert.match(await ics.text(), /BEGIN:VEVENT[\s\S]*DTSTART:/);
});

test('day-before reminder fires once', async () => {
  travel(24 * H + 30 * M); // now ~23.5h before
  calls.length = 0;
  const r = await b.runTick(env, { source: 'test', force: true });
  assert.ok(r.work.some(w => w.startsWith('email:day')), r.work.join(','));
  const sends = await env.DB.prepare(`SELECT * FROM broadcast_sends WHERE kind = 'day'`).all();
  assert.equal(sends.results.length, 1);
  assert.equal(sends.results[0].sent, 1);
  const resend = calls.filter(c => c.url.includes('resend.com/emails/batch'));
  assert.equal(resend.length, 1);
  const payload = JSON.parse(resend[0].body)[0];
  assert.match(payload.subject, /Tomorrow/);
  assert.match(payload.html, /unsubscribe=/);
  const r2 = await b.runTick(env, { source: 'test', force: true });
  assert.ok(!r2.work.some(w => w.startsWith('email:day')), 'idempotent');
});

test('arms 30 minutes before', async () => {
  travel(23 * H + 15 * M); // ~15 min before
  const r = await b.runTick(env, { source: 'test', force: true });
  assert.equal(r.state.phase, 'armed');
  assert.ok(r.work.includes('armed') || r.work.some(w => w.startsWith('email:hour')));
  const hour = await env.DB.prepare(`SELECT * FROM broadcast_sends WHERE kind = 'hour'`).first();
  assert.ok(hour, 'hour reminder claimed');
});

test('phone connects → live within one tick, live reminder sent, player exposed', async () => {
  sim.live = true; sim.videoUID = 'vid1';
  calls.length = 0;
  const r = await b.runTick(env, { source: 'test', force: true });
  assert.equal(r.state.phase, 'live');
  assert.equal(r.state.live, true);
  assert.equal(r.state.player.kind, 'live');
  assert.equal(r.state.player.uid, 'in1');
  assert.ok(r.work.includes('auto-start'));
  const st = await b.readState(env.DB);
  assert.equal(st.liveVideoUid, 'vid1');
  assert.equal(st.source, 'stream');
  const live = await env.DB.prepare(`SELECT * FROM broadcast_sends WHERE kind = 'live'`).first();
  assert.equal(live.sent, 1);
  const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE entity_type = 'live-status' AND action = 'published'`).first();
  assert.ok(audit);
  const ev = await env.DB.prepare(`SELECT * FROM broadcast_events WHERE type = 'live_start'`).first();
  assert.ok(ev);
  const legacy = b.legacyState(st, await b.readConfig(env.DB));
  assert.equal(legacy.live, true);
  assert.equal(legacy.url, 'https://sunshineonaranneyday.com/live/remi/');
});

test('drop + reconnect stays live; drop past grace ends it', async () => {
  sim.live = false;
  let r = await b.runTick(env, { source: 'test', force: true });
  assert.equal(r.state.phase, 'ending');
  assert.equal(r.state.live, true, 'still shown as live during grace');
  sim.live = true;
  r = await b.runTick(env, { source: 'test', force: true });
  assert.equal(r.state.phase, 'live');
  sim.live = false;
  r = await b.runTick(env, { source: 'test', force: true });
  assert.equal(r.state.phase, 'ending');
  travel(50 * S);
  r = await b.runTick(env, { source: 'test', force: true });
  assert.equal(r.state.phase, 'replay');
  assert.equal(r.state.replay, true);
  assert.ok(r.state.replayUntil);
  const ev = await env.DB.prepare(`SELECT * FROM broadcast_events WHERE type = 'live_end'`).first();
  assert.ok(ev);
});

test('replay ready → attached to kid, captions, deploy, replay email', async () => {
  sim.videoState = 'ready';
  travel(31 * S);
  calls.length = 0;
  const r = await b.runTick(env, { source: 'test', force: true });
  assert.ok(r.work.includes('replay-ready'), r.work.join(','));
  assert.equal(r.state.player.kind, 'replay');
  assert.equal(r.state.player.uid, 'vid1');
  const kid = JSON.parse((await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind('remi').first()).data);
  assert.equal(kid.revealVideoUrl, 'https://watch.cloudflarestream.com/vid1');
  assert.ok(calls.some(c => c.url.includes('/captions/en/generate')), 'captions requested');
  assert.ok(calls.some(c => c.url === 'https://hook.test/deploy'), 'deploy hook fired');
  const replay = await env.DB.prepare(`SELECT * FROM broadcast_sends WHERE kind = 'replay'`).first();
  assert.equal(replay.sent, 1);
  const r2 = await b.runTick(env, { source: 'test', force: true });
  assert.ok(!r2.work.includes('replay-ready'), 'only once');
});

test('replay expires back to idle', async () => {
  travel(73 * H);
  const r = await b.runTick(env, { source: 'test', force: true });
  assert.equal(r.state.phase, 'idle');
  assert.equal(r.state.player, null);
});

test('manual banner-only override and end', async () => {
  const r = await b.adminAction(env, 'goLiveManual', { message: 'Live on Facebook', url: 'https://www.facebook.com/SunshineOnaRanneyDay', durationHours: 2 }, 'peter@test');
  assert.equal(r.success, true, r.error);
  assert.equal(r.state.phase, 'live');
  assert.equal(r.state.source, 'manual');
  assert.equal(r.state.player, null, 'no player without a stream');
  assert.equal(r.state.url, 'https://www.facebook.com/SunshineOnaRanneyDay');
  const t = await b.runTick(env, { source: 'test', force: true });
  assert.equal(t.state.phase, 'live', 'stream idle must not end a manual banner');
  const e = await b.adminAction(env, 'endNow', {}, 'peter@test');
  assert.equal(e.state.phase, 'idle');
});

test('legacy live-status POST start with future startsAt schedules', async () => {
  const at = new Date(Date.now() + 3 * H).toISOString();
  const res = await endpoints.legacy.onRequestPost(ctx(post('https://x/api/live-status', { action: 'start', startsAt: at, message: 'Watch Remi', kidSlug: 'remi' })));
  const data = await res.json();
  assert.equal(data.success, true, data.error);
  assert.equal(data.state.upcoming, true);
  assert.equal(data.state.auto, true);
  const stop = await endpoints.legacy.onRequestPost(ctx(post('https://x/api/live-status', { action: 'stop' })));
  assert.equal((await stop.json()).state.upcoming, false);
  const get = await endpoints.legacy.onRequestGet(ctx(new Request('https://x/api/live-status')));
  const g = await get.json();
  assert.equal(g.live, false);
  assert.equal(g.phase, 'idle');
  await flush();
});

test('hub heartbeat: nonce verified over the binding', async () => {
  hub.nonces.add('good');
  const ok = await endpoints.hooks.onRequestPost(ctx(post('https://x/api/broadcast-hooks', { type: 'tick', source: 'alarm' }, { 'x-hub-nonce': 'good' })));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.state.phase, 'idle');
  const bad = await endpoints.hooks.onRequestPost(ctx(post('https://x/api/broadcast-hooks', { type: 'tick' }, { 'x-hub-nonce': 'bad' })));
  assert.equal(bad.status, 401);
  const replayed = await endpoints.hooks.onRequestPost(ctx(post('https://x/api/broadcast-hooks', { type: 'tick' }, { 'x-hub-nonce': 'good' })));
  assert.equal(replayed.status, 401, 'nonce is single-use');
});

test('webhook is only a wake-up call: forged connect with idle stream does nothing', async () => {
  sim.live = false;
  const res = await endpoints.webhook.onRequestPost(ctx(post('https://x/api/stream-webhook', { data: { input_id: 'in1', event_type: 'live_input.connected' } })));
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.phase, 'idle');
  sim.live = true; sim.videoUID = 'vid2'; sim.videoState = 'live-inprogress';
  const res2 = await endpoints.webhook.onRequestPost(ctx(post('https://x/api/stream-webhook', { data: { input_id: 'in1', event_type: 'live_input.connected' } })));
  assert.equal((await res2.json()).phase, 'live', 'real stream → live even with no schedule');
  await flush();
  const st = await b.readState(env.DB);
  assert.equal(st.kidSlug, null, 'unplanned broadcast has no kid');
  assert.equal(st.title, 'Live room reveal');
  sim.live = false;
  await b.runTick(env, { source: 'test', force: true });
  travel(60 * S);
  await b.runTick(env, { source: 'test', force: true });
  await b.adminAction(env, 'clearReplay', {}, 'peter@test');
});

test('analytics beacon records whitelisted types only', async () => {
  const ok = await endpoints.event.onRequestPost(ctx(post('https://x/api/broadcast-event', { type: 'click_donate', meta: { src: 'live' } })));
  assert.equal(ok.status, 204);
  const nope = await endpoints.event.onRequestPost(ctx(post('https://x/api/broadcast-event', { type: 'drop table' })));
  assert.equal(nope.status, 204);
  const rows = await env.DB.prepare(`SELECT type FROM broadcast_events WHERE type IN ('click_donate','drop table')`).all();
  assert.deepEqual(rows.results.map(r => r.type), ['click_donate']);
});

test('web push: encrypt → decrypt round trip (RFC 8291)', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: notify.b64u.encode(uaPub), auth: notify.b64u.encode(auth) } };
  const body = await notify.encryptPushPayload(sub, JSON.stringify({ title: 'hi' }));
  // parse header
  const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0), idlen = body[20];
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const asPub = body.slice(21, 86); const ct = body.slice(86);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const hk = async (s, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
  const te = new TextEncoder();
  const info = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPub, ...asPub]);
  const ikm = await hk(auth, shared, info, 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ct));
  assert.equal(pt.at(-1), 2, 'padding delimiter');
  assert.equal(new TextDecoder().decode(pt.slice(0, -1)), JSON.stringify({ title: 'hi' }));
  const vapid = await notify.generateVapidKeys();
  assert.equal(notify.b64u.decode(vapid.publicKey).length, 65);
});

test('sendTestReminder + config update through admin endpoint', async () => {
  const res = await endpoints.admin.onRequestPost(ctx(post('https://x/api/broadcast-admin', { action: 'setConfig', config: { replayHours: 48, facebook: { mode: 'api' }, alerts: { emails: ['ops@example.com', 'nope'] } } })));
  const d = await res.json();
  assert.equal(d.success, true, d.error);
  assert.equal(d.config.replayHours, 48);
  assert.equal(d.config.facebook.mode, 'api');
  assert.deepEqual(d.config.alerts.emails, ['ops@example.com']);
  const t = await endpoints.admin.onRequestPost(ctx(post('https://x/api/broadcast-admin', { action: 'sendTestReminder', kind: 'live', email: 'peter@test.com' })));
  assert.equal((await t.json()).success, true);
  const get = await endpoints.admin.onRequestGet(ctx(new Request('https://x/api/broadcast-admin?reveal=1')));
  const g = await get.json();
  assert.equal(g.success, true, g.error);
  assert.match(g.larix.standard, /^larix:/);
  assert.equal(g.setup.inputReady, true);
  assert.equal(g.reminders.counts.email, 1);
});
