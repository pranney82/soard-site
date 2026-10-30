/**
 * Gift alerts in Slack: Zeffy's webhook and the catch-up check
 * (functions/api/_zeffy.js)
 * Run: node --test tests/
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { renderSlack } from './lib/slack-render.mjs';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import {
  giftMessage, screenPayment, verifySignature, handleWebhook, runSweep, maybeSweepZeffy,
  readZeffyConfig, MAJOR_GIFT_CENTS, maybeSelfTest, SELF_TEST,
} from '../functions/api/_zeffy.js';

const SECRET = 'whsec_test_5f5e5d0f7c4c9a3e2b1a';
const SLACK = 'https://slack.com/api/chat.postMessage';
const NOW = Date.parse('2026-10-20T16:00:00Z'); // noon Eastern
const S = (ms) => Math.floor(ms / 1000);
const MIN = 60e3;

/** A Zeffy Payment, the shape GET /payments/:id and the webhook's `data` carry */
const payment = (o = {}) => ({
  id: 'pay_0001', object: 'payment', created: S(NOW - 2 * MIN), amount: 5000, eligible_amount: 5000, currency: 'usd',
  status: 'succeeded', type: 'online', refund_status: 'none', refunds: [], description: 'Help Build a Brighter Home',
  buyer: { email: 'jane@example.com', first_name: 'Jane', last_name: 'Doe', is_corporate: false, company_name: null, address: null },
  campaign_id: 'camp_1', campaign_category: 'donation', items: [], recurring: null, ...o,
});

// ── A fake outside world: Slack, Zeffy's API, Resend ───────────────────────
const realFetch = globalThis.fetch;
let world;
function freshWorld() {
  return { slack: [], channels: [], emails: [], payments: [], slackError: null, zeffyStatus: 200, zeffyCalls: [] };
}
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.href === SLACK) {
    // The site's Slack app, posting by channel id (Slack answers 200 with ok:false on errors)
    assert.equal(init.headers.Authorization, 'Bearer xoxb-test');
    const body = JSON.parse(init.body);
    world.channels.push(body.channel);
    if (world.slackError) return Response.json({ ok: false, error: world.slackError });
    world.slack.push(renderSlack(body));
    return Response.json({ ok: true, channel: body.channel, ts: '1.2' });
  }
  if (url.host === 'api.zeffy.com') {
    world.zeffyCalls.push(url.href);
    assert.equal(init.headers.Authorization, 'Bearer zk_test');
    if (world.zeffyStatus !== 200) return Response.json({ error: { message: 'Invalid API key.' } }, { status: world.zeffyStatus });
    const one = url.pathname.match(/^\/api\/v1\/payments\/(.+)$/);
    if (one) {
      const p = world.payments.find((x) => x.id === decodeURIComponent(one[1]));
      return p ? Response.json(p) : Response.json({ error: { message: 'No payment found' } }, { status: 404 });
    }
    const q = url.searchParams;
    const gte = Number(q.get('created[gte]'));
    const lte = Number(q.get('created[lte]'));
    const data = world.payments.filter((p) => p.created >= gte && p.created <= lte && (!q.get('status') || p.status === q.get('status')));
    return Response.json({ object: 'list', data, has_more: false, next_cursor: null });
  }
  if (url.host === 'api.resend.com') {
    for (const m of JSON.parse(init.body)) world.emails.push({ to: m.to[0], subject: m.subject, text: m.text });
    return Response.json({ data: [] });
  }
  throw new Error(`unexpected fetch ${url.href}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
beforeEach(async () => {
  world = freshWorld();
  env = {
    DB: await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] }),
    ZEFFY_WEBHOOK_SECRET: SECRET, ZEFFY_API_KEY: 'zk_test', SLACK_BOT_TOKEN: 'xoxb-test', RESEND_API_KEY: 're_test',
  };
});

function signed(body, { secret = SECRET, t = S(NOW) } = {}) {
  const raw = JSON.stringify(body);
  const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return new Request('https://sunshineonaranneyday.com/api/zeffy-webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Zeffy-Signature': `t=${t},v1=${v1}` }, body: raw,
  });
}
const completed = (p, id = 'evt_1') => ({ id, type: 'payment.completed', version: 1, dispatchedAt: new Date(NOW).toISOString(), data: p });
const row = (id) => env.DB.prepare('SELECT * FROM zeffy_gifts WHERE payment_id = ?').bind(id).first();

// ── The post ────────────────────────────────────────────────────────────────

test('the post: the amount and giver up top, then the campaign and the day, in Eastern dates', () => {
  const card = giftMessage(payment());
  assert.equal(card.blocks[0].type, 'header');
  assert.equal(card.text, '💛 $50.00 gift from Jane Doe', 'the phone notification');
  assert.equal(card.plain, '💛 $50.00 gift from Jane Doe\nCampaign: Help Build a Brighter Home\nReceived: October 20, 2026');
  // 11:30 PM Eastern on the 19th is the 20th in UTC; the post says the 19th
  assert.match(giftMessage(payment({ created: S(Date.parse('2026-10-20T03:30:00Z')) })).plain, /Received: October 19, 2026$/);
});

test('$1,000 and up is a major gift; $999.99 is not', () => {
  assert.equal(MAJOR_GIFT_CENTS, 100000);
  assert.equal(giftMessage(payment({ amount: 100000 })).text, '🌟 Major gift: $1,000.00 from Jane Doe');
  assert.equal(giftMessage(payment({ amount: 275000 })).text, '🌟 Major gift: $2,750.00 from Jane Doe');
  assert.equal(giftMessage(payment({ amount: 99999 })).text, '💛 $999.99 gift from Jane Doe');
});

test('a missing field leaves its line out, never empty or guessed', () => {
  const msg = giftMessage(payment({ buyer: { first_name: '', last_name: null }, description: '  ', created: null }));
  assert.equal(msg.plain, '💛 $50.00 gift');
  assert.equal(msg.blocks.length, 1, 'just the headline: no empty grid');
  assert.equal(giftMessage(payment({ buyer: { first_name: 'Cher', last_name: '' } })).text, '💛 $50.00 gift from Cher');
  assert.equal(giftMessage({ id: 'pay_x', description: 'Golf' }).plain, '💛 New gift\nCampaign: Golf');
});

test('no email address or contact details, ever', () => {
  const msg = giftMessage(payment({ buyer: { email: 'jane@example.com', first_name: 'Jane', last_name: 'Doe', address: { line1: '1 Main St' } }, buyer_questions: [{ question: 'Phone', type: 'phone', answer: '555-1234' }] }));
  assert.doesNotMatch(JSON.stringify(msg), /example\.com|Main St|555/);
});

test('organizations, monthly gifts, other currencies, and Slack markup', () => {
  assert.equal(giftMessage(payment({ buyer: { first_name: 'Ann', last_name: 'Lee', is_corporate: true, company_name: 'Pulte Homes' } })).text, '💛 $50.00 gift from Pulte Homes (Ann Lee)');
  assert.equal(giftMessage(payment({ buyer: { is_corporate: true, company_name: 'Northside' } })).text, '💛 $50.00 gift from Northside');
  assert.equal(giftMessage(payment({ amount: 2500, recurring: { is_recurring: true, interval: 'month' } })).text, '💛 $25.00 monthly gift from Jane Doe');
  assert.equal(giftMessage(payment({ amount: 250000, recurring: { is_recurring: true, interval: 'month' } })).text, '🌟 Major gift: $2,500.00 monthly from Jane Doe');
  // A one-time gift's item says "onetime", which isn't an interval; a foundation that typed its name as the giver's is named once
  assert.equal(giftMessage(payment({ amount: 200000, items: [{ type: 'donation', amount: 200000, recurrence_interval: 'onetime' }] })).text, '🌟 Major gift: $2,000.00 from Jane Doe');
  assert.equal(giftMessage(payment({ amount: 5000, items: [{ type: 'donation', amount: 5000, recurrence_interval: 'onetime' }] })).text, '💛 $50.00 gift from Jane Doe');
  assert.equal(giftMessage(payment({ amount: 2000000, buyer: { first_name: 'Example Family', last_name: 'Foundation', is_corporate: true, company_name: 'Example Family Foundation' } })).text, '🌟 Major gift: $20,000.00 from Example Family Foundation');
  assert.match(giftMessage(payment({ currency: 'cad' })).text, /^💛 CA\$50\.00 gift/);
  const sneaky = giftMessage(payment({ buyer: { first_name: '<!channel>', last_name: 'A&B' }, description: '<https://evil|click>' }));
  // The headline is plain text, which Slack never reads as a mention or link; everything else is escaped
  assert.equal(sneaky.blocks[0].text.type, 'plain_text');
  assert.match(sneaky.text, /from &lt;!channel&gt; A&amp;B/);
  assert.match(sneaky.blocks[1].text.text, /^\*Campaign:\* &lt;https:\/\/evil\|click&gt;$/m);
  assert.doesNotMatch(JSON.stringify(sneaky.blocks.slice(1)), /<!channel>|<https:\/\/evil/);
});

test('gifts follow the Good news channel picked in the admin', async () => {
  await writeSlackConfig(env.DB, { channel: { id: 'C0GOODNEWS', name: 'good-news' }, attention: { id: 'C0ALERTS', name: 'website-alerts' } });
  await handleWebhook(env, signed(completed(payment())), { now: NOW });
  assert.deepEqual(world.channels, ['C0GOODNEWS']);
});

test('what isn’t posted', () => {
  assert.equal(screenPayment(payment()), null);
  assert.equal(screenPayment(payment({ status: 'failed' })), 'status failed');
  assert.equal(screenPayment(payment({ type: 'imported' })), 'imported');
  assert.equal(screenPayment(payment({ amount: 0 })), 'no amount');
  assert.equal(screenPayment(payment({ refund_status: 'full' })), 'refunded');
  assert.equal(screenPayment(payment({ type: 'manual' })), null, 'a check entered by hand is a gift');
  assert.equal(screenPayment({ id: '../x' }), 'not a payment');
});

// ── The signature ───────────────────────────────────────────────────────────

test('signature: HMAC-SHA256 of "{t}.{raw body}" with the whole whsec_ secret, within 5 minutes', async () => {
  const raw = '{"a":1}';
  const t = S(NOW);
  const v1 = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  assert.deepEqual(await verifySignature(SECRET, `t=${t},v1=${v1}`, raw, NOW / 1000), { ok: true });
  assert.deepEqual(await verifySignature(SECRET, `t=${t},v1=${'0'.repeat(64)},v1=${v1}`, raw, NOW / 1000), { ok: true }, 'any v1 may match');
  assert.equal((await verifySignature('whsec_other', `t=${t},v1=${v1}`, raw, NOW / 1000)).ok, false);
  assert.equal((await verifySignature(SECRET, `t=${t},v1=${v1}`, '{"a":2}', NOW / 1000)).ok, false, 'a changed body fails');
  assert.match((await verifySignature(SECRET, `t=${t},v1=${v1}`, raw, NOW / 1000 + 301)).why, /outside 5 minutes/);
  assert.match((await verifySignature(SECRET, 'garbage', raw, NOW / 1000)).why, /malformed/);
  assert.match((await verifySignature(SECRET, null, raw, NOW / 1000)).why, /no Zeffy-Signature/);
});

// ── The webhook ─────────────────────────────────────────────────────────────

test('webhook: a completed payment posts once, however often Zeffy sends it', async () => {
  const r1 = await handleWebhook(env, signed(completed(payment())), { now: NOW });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).result, 'posted');
  const r2 = await handleWebhook(env, signed(completed(payment())), { now: NOW + 5000 });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).result, 'duplicate');
  assert.deepEqual(world.slack, ['💛 $50.00 gift from Jane Doe\nCampaign: Help Build a Brighter Home\nReceived: October 20, 2026']);
  assert.deepEqual(world.channels, ['C04NJ4W4QG6'], '#team-everyone until a Good news channel is picked');
  const r = await row('pay_0001');
  assert.equal(r.state, 'posted');
  assert.equal(r.pending, null, 'no amount or name is kept once posted');
  const cfg = await readZeffyConfig(env.DB);
  assert.ok(cfg.lastWebhookAt && cfg.lastPostAt && cfg.since);
});

test('webhook: other events, bad signatures and missing setup', async () => {
  const other = await handleWebhook(env, signed({ id: 'evt_2', type: 'payment.updated', data: { id: 'pay_0001', object: 'payment' } }), { now: NOW });
  assert.equal(other.status, 200);
  assert.equal((await other.json()).ignored, 'payment.updated');

  const forged = await handleWebhook(env, signed(completed(payment()), { secret: 'whsec_wrong' }), { now: NOW });
  assert.equal(forged.status, 400);
  assert.match((await readZeffyConfig(env.DB)).lastRejected.why, /does not match/);

  const unset = await handleWebhook({ ...env, ZEFFY_WEBHOOK_SECRET: '' }, signed(completed(payment())), { now: NOW });
  assert.equal(unset.status, 503, 'Zeffy keeps retrying until the secret is set');
  assert.deepEqual(world.slack, []);
});

test('webhook: imported and $0 payments are recorded, not posted', async () => {
  for (const [p, reason] of [[payment({ id: 'pay_imp', type: 'imported' }), 'imported'], [payment({ id: 'pay_zero', amount: 0 }), 'no amount']]) {
    const r = await handleWebhook(env, signed(completed(p)), { now: NOW });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).reason, reason);
  }
  assert.deepEqual(world.slack, []);
});

test('webhook: Slack refuses → 500 so Zeffy retries; the retry posts exactly once', async () => {
  world.slackError = 'channel_not_found';
  const r1 = await handleWebhook(env, signed(completed(payment())), { now: NOW });
  assert.equal(r1.status, 500);
  assert.equal((await row('pay_0001')).state, 'failed');
  assert.equal((await row('pay_0001')).reason, 'channel_not_found');

  world.slackError = null;
  const r2 = await handleWebhook(env, signed(completed(payment()), { t: S(NOW + 60e3) }), { now: NOW + 60e3 });
  assert.equal(r2.status, 200);
  const r3 = await handleWebhook(env, signed(completed(payment()), { t: S(NOW + 120e3) }), { now: NOW + 120e3 });
  assert.equal((await r3.json()).result, 'duplicate');
  assert.equal(world.slack.length, 1);
  assert.equal((await row('pay_0001')).attempts, 2);
});

test('webhook: no Slack token yet → recorded as failed, posted once it’s set', async () => {
  const noSlack = { ...env, SLACK_BOT_TOKEN: '' };
  const r = await handleWebhook(noSlack, signed(completed(payment())), { now: NOW });
  assert.equal(r.status, 500);
  assert.match((await row('pay_0001')).reason, /SLACK_BOT_TOKEN/);
  await runSweep(env, { now: NOW + 15 * MIN });
  assert.equal(world.slack.length, 1);
  assert.equal((await row('pay_0001')).state, 'posted');
});

// ── The catch-up check ──────────────────────────────────────────────────────

test('catch-up: the first check starts the clock and posts nothing from before', async () => {
  world.payments = [payment({ id: 'pay_old', created: S(NOW - 60 * MIN) })];
  const s = await runSweep(env, { now: NOW });
  assert.equal(s.posted, 0);
  assert.equal((await readZeffyConfig(env.DB)).since, new Date(NOW).toISOString());
  const later = await runSweep(env, { now: NOW + 30 * MIN });
  assert.equal(later.posted, 0, 'a gift from before the site took over stays the old system’s');
  assert.deepEqual(world.slack, []);
});

test('catch-up: a gift the webhook never delivered is posted, once, and Peter hears why', async () => {
  await runSweep(env, { now: NOW });
  world.payments = [payment({ id: 'pay_missed', created: S(NOW + 5 * MIN), amount: 250000, buyer: { first_name: 'Ben', last_name: 'Wood' } })];
  const early = await runSweep(env, { now: NOW + 10 * MIN });
  assert.equal(early.posted, 0, 'the webhook gets 10 minutes first');
  const s = await runSweep(env, { now: NOW + 20 * MIN });
  assert.equal(s.missed, 1);
  assert.equal(s.posted, 1);
  assert.match(world.slack[0], /^🌟 Major gift: \$2,500\.00 from Ben Wood\n/);
  assert.equal((await row('pay_missed')).via, 'sweep');
  assert.equal(world.emails.length, 1);
  assert.equal(world.emails[0].to, 'peter@soardcharity.com');
  assert.match(world.emails[0].subject, /webhook missed a gift/);
  assert.doesNotMatch(world.emails[0].text, /Ben|2,500/, 'the alert names no donor or amount');

  world.payments.push(payment({ id: 'pay_missed2', created: S(NOW + 6 * MIN) }));
  const again = await runSweep(env, { now: NOW + 40 * MIN });
  assert.equal(again.posted, 1);
  assert.equal(world.slack.length, 2, 'the first gift isn’t posted again');
  assert.equal(world.emails.length, 1, 'one email a day per problem');
});

test('catch-up: a gift the webhook delivered isn’t posted again', async () => {
  await runSweep(env, { now: NOW - 30 * MIN });
  world.payments = [payment()];
  await handleWebhook(env, signed(completed(payment())), { now: NOW });
  const s = await runSweep(env, { now: NOW + 20 * MIN });
  assert.equal(s.checked, 1);
  assert.equal(s.missed, 0);
  assert.equal(world.slack.length, 1);
  assert.equal(world.emails.length, 0);
});

test('catch-up: retries what Slack refused, emails after 30 minutes, gives up after 3 days', async () => {
  world.slackError = 'channel_not_found';
  await handleWebhook(env, signed(completed(payment())), { now: NOW });
  const s1 = await runSweep(env, { now: NOW + 15 * MIN });
  assert.equal(s1.retried, 1);
  assert.equal(world.emails.length, 0, 'not yet: it may be a blip');
  await runSweep(env, { now: NOW + 45 * MIN });
  assert.equal(world.emails.length, 1);
  assert.match(world.emails[0].subject, /aren’t reaching Slack/);

  const s3 = await runSweep(env, { now: NOW + 3 * 24 * 60 * MIN + MIN });
  assert.equal(s3.gaveUp, 1);
  const r = await row('pay_0001');
  assert.equal(r.state, 'gave-up');
  assert.equal(r.pending, null);
  assert.ok(world.emails.some((e) => /never posted/.test(e.subject)));
});

test('catch-up: a claim whose worker died is picked up after 5 minutes', async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS zeffy_gifts (payment_id TEXT PRIMARY KEY, state TEXT NOT NULL, via TEXT, reason TEXT, pending TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, paid_at INTEGER, created_at TEXT, updated_at TEXT)`).run();
  const iso = new Date(NOW).toISOString();
  await env.DB.prepare("INSERT INTO zeffy_gifts (payment_id, state, via, pending, created_at, updated_at) VALUES ('pay_stuck', 'posting', 'webhook', ?, ?, ?)").bind('🎉 New donation - $5.00', iso, iso).run();
  assert.equal((await runSweep(env, { now: NOW + 2 * MIN })).retried, 0, 'still in flight');
  assert.equal((await runSweep(env, { now: NOW + 6 * MIN })).retried, 1);
  assert.deepEqual(world.slack, ['🎉 New donation - $5.00'], 'a row saved before cards still posts, as the text it was');
});

test('catch-up: a refused API key is reported once a day, and webhook gifts still post', async () => {
  world.zeffyStatus = 401;
  await runSweep(env, { now: NOW - 30 * MIN });
  const s = await runSweep(env, { now: NOW });
  assert.equal(s.error, 'Zeffy refused ZEFFY_API_KEY');
  assert.equal(world.emails.length, 1);
  assert.match(world.emails[0].subject, /can’t check Zeffy/);
  await runSweep(env, { now: NOW + 15 * MIN });
  assert.equal(world.emails.length, 1);
  const r = await handleWebhook(env, signed(completed(payment())), { now: NOW });
  assert.equal((await r.json()).result, 'posted');
});

test('catch-up: a wrong signing secret is reported when Zeffy itself is refused', async () => {
  // Zeffy rotated the secret: its delivery of a real gift fails the check
  world.payments = [payment()];
  await handleWebhook(env, signed(completed(payment()), { secret: 'whsec_wrong' }), { now: NOW });
  await runSweep(env, { now: NOW + MIN });
  assert.ok(world.emails.some((e) => /being refused/.test(e.subject)));
  assert.ok(world.zeffyCalls.some((u) => u.endsWith('/payments/pay_0001')), 'asked Zeffy whether the gift is real');
  assert.equal((await readZeffyConfig(env.DB)).lastRejected.real, true);
});

test('bad signatures from anyone else: no email, and a flood writes one note, not one per request', async () => {
  // Count writes to site_config
  let writes = 0;
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (/INSERT OR REPLACE INTO site_config/.test(sql)) writes++; return prepare(sql); };
  for (let i = 0; i < 25; i++) {
    const r = await handleWebhook(env, signed(completed(payment({ id: `pay_fake${i}` })), { secret: 'whsec_attacker' }), { now: NOW + i * 1000 });
    assert.equal(r.status, 400);
  }
  await handleWebhook(env, new Request('https://sunshineonaranneyday.com/api/zeffy-webhook', { method: 'POST', headers: { 'Zeffy-Signature': 'garbage' }, body: 'x' }), { now: NOW + 30e3 });
  assert.equal(writes, 1, 'one note for the whole flood');
  const note = (await readZeffyConfig(env.DB)).lastRejected;
  assert.equal(note.paymentId, 'pay_fake0');
  assert.match(note.why, /does not match/);

  // The catch-up check asks Zeffy once, hears there's no such payment, and tells nobody
  await runSweep(env, { now: NOW + MIN });
  await runSweep(env, { now: NOW + 16 * MIN });
  assert.equal(world.zeffyCalls.filter((u) => u.includes('/payments/pay_fake0')).length, 1, 'the answer is kept');
  assert.equal((await readZeffyConfig(env.DB)).lastRejected.real, false);
  assert.deepEqual(world.emails, []);
  assert.deepEqual(world.slack, []);
});

test('bad signatures: none naming a payment, a good delivery since, or no API key to ask means no email', async () => {
  // Nothing to look up: not an email
  await handleWebhook(env, new Request('https://sunshineonaranneyday.com/api/zeffy-webhook', { method: 'POST', headers: { 'Zeffy-Signature': `t=${S(NOW)},v1=${'0'.repeat(64)}` }, body: '{}' }), { now: NOW });
  await runSweep(env, { now: NOW + MIN });
  assert.deepEqual(world.emails, []);

  // A real refusal, but Zeffy delivered fine afterwards: the secret is right
  world.payments = [payment(), payment({ id: 'pay_0002' })];
  await handleWebhook(env, signed(completed(payment({ id: 'pay_0002' })), { secret: 'whsec_wrong', t: S(NOW + 11 * MIN) }), { now: NOW + 11 * MIN });
  assert.equal((await (await handleWebhook(env, signed(completed(payment()), { t: S(NOW + 12 * MIN) }), { now: NOW + 12 * MIN })).json()).result, 'posted');
  await runSweep(env, { now: NOW + 13 * MIN });
  assert.equal(world.emails.filter((e) => /being refused/.test(e.subject)).length, 0);

  // Without ZEFFY_API_KEY there's no telling Zeffy from anyone else
  const noKey = { ...env, ZEFFY_API_KEY: '' };
  await handleWebhook(noKey, signed(completed(payment({ id: 'pay_0002' })), { secret: 'whsec_wrong', t: S(NOW + 30 * MIN) }), { now: NOW + 30 * MIN });
  assert.ok((await readZeffyConfig(env.DB)).lastRejected.at.startsWith(new Date(NOW + 30 * MIN).toISOString().slice(0, 16)), 'noted');
  await runSweep(noKey, { now: NOW + 31 * MIN });
  assert.equal(world.emails.filter((e) => /being refused/.test(e.subject)).length, 0);
});

test('the heartbeat: every 15 minutes, and only once Zeffy is connected', async () => {
  assert.equal(await maybeSweepZeffy({ DB: env.DB }, { now: NOW }), null, 'nothing set up');
  assert.ok(await maybeSweepZeffy(env, { now: NOW }));
  assert.equal(await maybeSweepZeffy(env, { now: NOW + 5 * MIN }), null);
  assert.ok(await maybeSweepZeffy(env, { now: NOW + 15 * MIN }));
});

test('D1 keeps payment ids, states and times, never an amount or a name once posted', async () => {
  await runSweep(env, { now: NOW - 30 * MIN });
  await handleWebhook(env, signed(completed(payment())), { now: NOW });
  world.slackError = 'channel_not_found';
  await handleWebhook(env, signed(completed(payment({ id: 'pay_0002', amount: 777700, buyer: { first_name: 'Zed', last_name: 'Q' } }))), { now: NOW });
  world.slackError = null;
  await runSweep(env, { now: NOW + 15 * MIN });
  assert.equal(world.slack.length, 2);
  const rows = (await env.DB.prepare('SELECT * FROM zeffy_gifts').all()).results;
  assert.deepEqual(rows.map((r) => r.state), ['posted', 'posted']);
  assert.doesNotMatch(JSON.stringify(rows), /Jane|Zed|\$|7,777|777700|example\.com/);
  assert.doesNotMatch(JSON.stringify(await readZeffyConfig(env.DB)), /Jane|Zed|\$|777700/);
});

test('self-test: once per SELF_TEST, through the real webhook path, plainly marked, not counted as Zeffy', async () => {
  const r = await maybeSelfTest(env, { now: NOW });
  assert.deepEqual(r, { id: SELF_TEST, at: new Date(NOW).toISOString(), status: 200, result: 'posted', error: null });
  assert.equal(world.slack.length, 1);
  assert.equal(world.slack[0], '💛 $50.00 gift from Test Donor\n🧪 *Test from the website · no gift was made*\nGift alerts are connected. Real gifts look just like this.\nCampaign: Website test\nReceived: October 20, 2026');
  assert.equal(await maybeSelfTest(env, { now: NOW + 60e3 }), null, 'never twice');
  const cfg = await readZeffyConfig(env.DB);
  assert.equal(cfg.lastWebhookAt, undefined, 'a self-test isn’t Zeffy reaching the site');
  assert.equal(cfg.selfTest.result, 'posted');
  // The heartbeat runs it, and overlapping runs still post once (the payment id is claimed)
  const env2 = { ...env, DB: await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] }) };
  await Promise.all([maybeSelfTest(env2, { now: NOW }), maybeSelfTest(env2, { now: NOW })]);
  assert.equal(world.slack.length, 2);
  assert.ok(await maybeSweepZeffy({ ...env, DB: await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] }) }, { now: NOW }));
  assert.equal(world.slack.length, 3, 'the heartbeat’s first wake-up posts the self-test');
});

test('self-test: Slack refusing is recorded, retried by the catch-up check, and the real format is untouched', async () => {
  world.slackError = 'not_in_channel';
  const r = await maybeSelfTest(env, { now: NOW });
  assert.equal(r.status, 500);
  assert.equal(r.error, 'not_in_channel');
  world.slackError = null;
  await runSweep(env, { now: NOW + 15 * MIN });
  assert.match(world.slack[0], /^💛 \$50\.00 gift from Test Donor\n🧪 \*Test from the website/);
  assert.doesNotMatch(JSON.stringify(giftMessage(payment())), /🧪|Test/);
});
