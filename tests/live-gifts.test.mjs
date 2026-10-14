/**
 * Gifts during a reveal — Zeffy webhook, honest totals, the public total
 * Run: node --test tests/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';

const SECRET = 'whsec_testsecret0123456789';
const relayed = [];
const LIVE_HUB = { idFromName: () => 'main', get: () => ({ async fetch(_url, init) { relayed.push(JSON.parse(init.body)); return Response.json({ ok: true, sent: 1 }); } }) };
const cached = new Map();
const realCaches = globalThis.caches;
globalThis.caches = { default: { async match(req) { return cached.get(req.url)?.clone(); }, async put(req, res) { cached.set(req.url, res); } } };

let env, b, g, hook, totals;
const sign = (body, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const post = (event, header) => {
  const body = JSON.stringify(event);
  return hook.onRequestPost({ env, request: new Request('https://x/api/zeffy-webhook', { method: 'POST', headers: { 'Zeffy-Signature': header ?? sign(body) }, body }) });
};
const payment = (id, dollars, extra = {}) => ({ type: 'payment.completed', data: { id, amount: dollars * 100, currency: 'usd', created: Math.floor(Date.now() / 1000), status: 'succeeded', recurring: null, buyer: { first_name: 'Ana' }, ...extra } });
const publicTotal = async () => { cached.clear(); return (await totals.onRequestGet({ env, request: new Request('https://x/api/live-gifts') })).json(); };

before(async () => {
  env = { DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }), LIVE_HUB };
  b = await import('../functions/api/_broadcast.js');
  g = await import('../functions/api/_live-gifts.js');
  hook = await import('../functions/api/zeffy-webhook.js');
  totals = await import('../functions/api/live-gifts.js');
});
after(() => { globalThis.caches = realCaches; });

async function setState(extra) {
  const s = await b.readState(env.DB);
  await b.writeState(env.DB, { ...s, broadcastId: 'live-300', kidSlug: 'axel', kidName: 'Axel', ...extra });
}

test('refused until Zeffy is connected', async () => {
  await setState({ phase: 'live', liveAt: new Date().toISOString() });
  assert.equal((await post(payment('p0', 50))).status, 401);
  assert.equal((await publicTotal()).configured, false);
  const c = await b.readConfig(env.DB);
  await b.writeConfig(env.DB, { ...c, zeffy: { webhookSecret: SECRET } });
});

test('a forged or stale signature is refused', async () => {
  const body = JSON.stringify(payment('p1', 50));
  assert.equal((await post(payment('p1', 50), sign(body, undefined, 'whsec_wrong'))).status, 401);
  assert.equal((await post(payment('p1', 50), sign(body, Math.floor(Date.now() / 1000) - 3600))).status, 401);
  assert.equal(await g.verifyZeffySignature(sign(body), body, SECRET), true);
  assert.equal(await g.verifyZeffySignature(sign(body, undefined, SECRET.slice(6)), body, SECRET), true, 'the bare secret works too');
});

test('a gift during the reveal counts once, and everyone watching hears about it', async () => {
  const r = await (await post(payment('p2', 50))).json();
  assert.deepEqual([r.ok, r.counted, r.broadcastId], [true, true, 'live-300']);
  assert.deepEqual(relayed.at(-1), { type: 'gifts', broadcastId: 'live-300', cents: 5000, count: 1 });
  const again = await (await post(payment('p2', 50))).json();
  assert.equal(again.counted, false, 'a Zeffy retry is not a second gift');
  await post(payment('p3', 25));
  const t = await publicTotal();
  assert.deepEqual([t.configured, t.broadcastId, t.cents, t.count], [true, 'live-300', 7500, 2]);
  assert.ok(t.lastEventAt);
});

test('monthly gifts and other events are left out', async () => {
  const monthly = await (await post(payment('p4', 20, { recurring: { interval: 'month', subscription_id: 's1' } }))).json();
  assert.equal(monthly.counted, false);
  const other = await (await post({ type: 'contact.created', data: { id: 'c1' } })).json();
  assert.equal(other.ignored, 'contact.created');
  assert.equal((await publicTotal()).cents, 7500);
});

test('the reveal window: 30 minutes before, an hour after', () => {
  const now = Date.parse('2026-10-14T18:00:00Z');
  const live = { broadcastId: 'b', phase: 'live', liveAt: new Date(now).toISOString() };
  assert.equal(g.broadcastFor(live, now + 5 * 60e3), 'b');
  assert.equal(g.broadcastFor(live, now - 20 * 60e3), 'b', 'during the starting-soon window');
  assert.equal(g.broadcastFor(live, now - 45 * 60e3), null);
  const replay = { ...live, phase: 'replay', endedAt: new Date(now + 3600e3).toISOString() };
  assert.equal(g.broadcastFor(replay, now + 3600e3 + 30 * 60e3), 'b');
  assert.equal(g.broadcastFor(replay, now + 3600e3 + 90 * 60e3), null);
  assert.equal(g.broadcastFor({ ...live, phase: 'idle' }, now), null);
});

test('a gift with nothing on is acknowledged but not counted', async () => {
  await setState({ phase: 'idle', broadcastId: null });
  const r = await (await post(payment('p5', 100))).json();
  assert.equal(r.counted, false);
  assert.equal((await publicTotal()).count, 0);
});
