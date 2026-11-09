/**
 * Donors join the newsletter (functions/api/_kit-donors.js)
 * Run: node --test tests/kit-donors.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  runDonorSync, maybeSyncDonors, donorsStatus, readDonorConfig, whyLeftOut, donorFirstName,
  DONOR_TAG, START, MAX_PEOPLE, LOOKBACK_DAYS,
} from '../functions/api/_kit-donors.js';
import { WRITE_TEST_NAME } from '../functions/api/_zeffy.js';
import { tagFor } from '../functions/api/_check-gifts.js';

const NOW = Date.parse('2026-11-09T17:00:00Z'); // noon Eastern
const S = (ms) => Math.floor(ms / 1000);
const MIN = 60e3;
const DAY = 24 * 60 * MIN;
const TAG_ID = 77;

let n = 0;
/** A Zeffy Payment, the shape GET /payments returns */
const gift = (o = {}) => {
  n++;
  const { buyer = {}, ...rest } = o;
  return {
    id: `pay_${String(n).padStart(4, '0')}`, object: 'payment', created: S(NOW - DAY), amount: 5000, currency: 'usd',
    status: 'succeeded', type: 'online', refund_status: 'none', refunds: [], description: 'Help Build a Brighter Home',
    buyer: { email: `giver${n}@example.com`, first_name: 'Jane', last_name: 'Doe', is_corporate: false, company_name: null, ...buyer },
    items: [], recurring: null, ...rest,
  };
};

// ── A fake outside world: Zeffy's API and Kit's ─────────────────────────────
const realFetch = globalThis.fetch;
let world;
function freshWorld() {
  return {
    payments: [], zeffyStatus: 200, zeffyCalls: [],
    kit: new Map(), nextId: 1000, tags: new Map(), tagged: new Map(), kitStatus: 200, kitError: 'The API key is invalid', refuseTag: new Set(), kitCalls: [],
  };
}
const kitSub = (email, state = 'active', first = 'Old Name') => {
  const s = { id: world.nextId++, email_address: email, state, first_name: first };
  world.kit.set(email, s);
  return s;
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method || 'GET';
  if (url.host === 'api.zeffy.com') {
    world.zeffyCalls.push(url.href);
    if (world.zeffyStatus !== 200) return Response.json({ error: { message: 'Invalid API key.' } }, { status: world.zeffyStatus });
    const q = url.searchParams;
    const gte = Number(q.get('created[gte]'));
    const lte = Number(q.get('created[lte]'));
    const data = world.payments.filter((p) => p.created >= gte && p.created <= lte && p.status === q.get('status'));
    return Response.json({ object: 'list', data, has_more: false, next_cursor: null });
  }
  if (url.host === 'api.kit.com') {
    assert.equal(init.headers['X-Kit-Api-Key'], 'kit_test');
    const path = url.pathname.replace(/^\/v4/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    world.kitCalls.push(`${method} ${path}${body?.email_address ? ` ${body.email_address}` : ''}`);
    if (world.kitStatus !== 200) return Response.json({ errors: [world.kitError] }, { status: world.kitStatus });
    if (method === 'GET' && path === '/subscribers') {
      assert.equal(url.searchParams.get('status'), 'all', 'asks about every state, so unsubscribes show');
      const want = url.searchParams.get('email_address').split(',');
      return Response.json({ subscribers: want.map((e) => world.kit.get(e)).filter(Boolean), pagination: { has_next_page: false } });
    }
    if (method === 'POST' && path === '/subscribers') {
      const had = world.kit.get(body.email_address);
      if (had) return Response.json({ subscriber: had }, { status: 200 }); // Kit keeps the state it had
      const s = { id: world.nextId++, email_address: body.email_address, state: body.state, first_name: body.first_name ?? null };
      world.kit.set(s.email_address, s);
      return Response.json({ subscriber: s }, { status: 201 });
    }
    if (method === 'GET' && path === '/tags') return Response.json({ tags: [...world.tags.entries()].map(([id, name]) => ({ id, name })), pagination: { has_next_page: false } });
    if (method === 'POST' && path === '/tags') { world.tags.set(TAG_ID, body.name); return Response.json({ tag: { id: TAG_ID, name: body.name } }, { status: 201 }); }
    const t = path.match(/^\/tags\/(\d+)\/subscribers\/(\d+)$/);
    if (method === 'POST' && t) {
      const id = Number(t[2]);
      const s = [...world.kit.values()].find((x) => x.id === id);
      if (!s) return Response.json({ errors: ['Not found'] }, { status: 404 });
      if (world.refuseTag.has(s.email_address)) return Response.json({ errors: ['Something went wrong'] }, { status: 422 });
      world.tagged.set(s.email_address, Number(t[1]));
      return Response.json({ subscriber: s }, { status: 201 });
    }
  }
  throw new Error(`unexpected fetch ${method} ${url.href}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
let told;
const alert = async (e, card) => { told.push(card); };
const sync = (o = {}) => runDonorSync(env, { now: NOW, alert, ...o });
const rows = async () => (await env.DB.prepare('SELECT * FROM kit_donors ORDER BY payment_id').all()).results;
const stateOf = async (p) => (await env.DB.prepare('SELECT state, reason FROM kit_donors WHERE payment_id = ?').bind(p.id).first());

beforeEach(async () => {
  world = freshWorld();
  told = [];
  env = {
    DB: await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] }),
    ZEFFY_API_KEY: 'zk_test', KIT_API_KEY: 'kit_test',
  };
});

test('a new donor is added, subscribed, with their first name, and tagged Donors (the tag is made once)', async () => {
  const p = gift({ buyer: { email: 'New.Giver@Example.com ', first_name: 'Robin' } });
  world.payments = [p];
  const r = await sync();
  assert.equal(r.added, 1);
  assert.equal(r.error, null);
  const s = world.kit.get('new.giver@example.com');
  assert.deepEqual([s.state, s.first_name], ['active', 'Robin']);
  assert.equal(world.tagged.get('new.giver@example.com'), TAG_ID);
  assert.equal(world.tags.get(TAG_ID), DONOR_TAG);
  assert.deepEqual(await stateOf(p), { state: 'added', reason: null });
});

test('someone already on the list (or waiting to confirm) is only tagged: their name and state are never touched', async () => {
  kitSub('on@example.com', 'active', 'Robbie');
  kitSub('confirming@example.com', 'inactive', null);
  const a = gift({ buyer: { email: 'on@example.com', first_name: 'Robin' } });
  const b = gift({ buyer: { email: 'confirming@example.com' } });
  world.payments = [a, b];
  const r = await sync();
  assert.deepEqual([r.added, r.tagged], [0, 2]);
  assert.ok(!world.kitCalls.some((c) => c.startsWith('POST /subscribers')), 'never re-sent to Kit, so a name can’t be overwritten');
  assert.equal(world.kit.get('on@example.com').first_name, 'Robbie');
  assert.equal(world.kit.get('confirming@example.com').state, 'inactive');
  assert.equal(world.tagged.size, 2);
  assert.deepEqual(await stateOf(a), { state: 'tagged', reason: null });
});

test('a donor who unsubscribed, bounced or marked SOARD as spam is left exactly as they are: no add, no tag', async () => {
  for (const st of ['cancelled', 'bounced', 'complained']) kitSub(`${st}@example.com`, st);
  const gifts = ['cancelled', 'bounced', 'complained'].map((st) => gift({ buyer: { email: `${st}@example.com` } }));
  world.payments = gifts;
  const r = await sync();
  assert.equal(r.leftOut, 3);
  assert.equal(world.tagged.size, 0);
  assert.ok(!world.kitCalls.some((c) => c.startsWith('POST')), 'nothing written to Kit');
  for (const st of ['cancelled', 'bounced', 'complained']) assert.equal(world.kit.get(`${st}@example.com`).state, st);
  assert.deepEqual(await stateOf(gifts[0]), { state: 'left-out', reason: 'cancelled' });
  // Kit naming them only when asked to add (its lookup missed them): still left alone
  world.kit.clear(); world.kitCalls = [];
  const late = gift({ buyer: { email: 'late@example.com' } });
  world.payments = [late];
  const realGet = world.kit.get.bind(world.kit);
  world.kit.get = (e) => (world.kitCalls.at(-1)?.startsWith('POST /subscribers') ? { id: 9, email_address: e, state: 'cancelled' } : realGet(e));
  const r2 = await sync();
  assert.equal(r2.leftOut, 1);
  assert.equal(world.tagged.size, 0);
});

test('left out: what Slack leaves out, gifts with no email, and SOARD’s own addresses (staff, and the checks’ parking address)', async () => {
  const left = {
    imported: gift({ type: 'imported' }),
    refunded: gift({ refund_status: 'full' }),
    'no amount': gift({ amount: 0 }),
    'website test': gift({ buyer: { ...WRITE_TEST_NAME } }),
    'no email': gift({ buyer: { email: null } }),
    'SOARD address': gift({ buyer: { email: 'peter@soardcharity.com' } }),
    parked: gift({ buyer: { email: tagFor('chk_1', NOW) } }),
    site: gift({ buyer: { email: 'x@sunshineonaranneyday.com' } }),
  };
  const keep = gift();
  world.payments = [...Object.values(left), keep];
  const r = await sync();
  assert.equal(r.skipped, 8);
  assert.equal(r.added, 1);
  assert.deepEqual([...world.kit.keys()], [keep.buyer.email], 'only the real giver reached Kit');
  for (const [why, p] of Object.entries(left)) {
    assert.equal((await stateOf(p)).state, 'skipped');
    assert.equal((await stateOf(p)).reason, why === 'parked' || why === 'site' ? 'SOARD address' : why);
  }
  assert.equal(whyLeftOut(gift({ metadata: { soardSelfTest: true } })), 'website test');
});

test('each gift once: a second run asks Kit about nobody, and two gifts from one giver are one person', async () => {
  const a = gift({ buyer: { email: 'twice@example.com' } });
  const b = gift({ buyer: { email: 'twice@example.com' }, created: S(NOW - 2 * DAY) });
  world.payments = [a, b];
  const r = await sync();
  assert.equal(r.added, 1);
  assert.equal(world.kitCalls.filter((c) => c.startsWith('POST /subscribers')).length, 1);
  assert.deepEqual((await rows()).map((x) => x.state), ['added', 'added']);
  world.kitCalls = [];
  const again = await runDonorSync(env, { now: NOW + 20 * MIN, alert });
  assert.deepEqual([again.added, again.tagged, again.skipped], [0, 0, 0]);
  assert.deepEqual(world.kitCalls, [], 'done gifts never go back to Kit');
});

test('catch-up: reads from September 1, at most MAX_PEOPLE a run, oldest first; once caught up, only the last 60 days', async () => {
  const old = gift({ created: S(Date.parse(START) + DAY) });
  const before = gift({ created: S(Date.parse(START) - DAY) }); // before the catch-up: already in Kit's upload
  const many = Array.from({ length: MAX_PEOPLE + 3 }, (_, i) => gift({ created: S(NOW - (10 + i) * 60 * MIN) }));
  world.payments = [before, old, ...many];
  const r1 = await sync();
  assert.equal(r1.added, MAX_PEOPLE);
  assert.equal(r1.waiting, 4);
  assert.ok(world.kit.has(old.buyer.email), 'oldest first');
  assert.ok(!world.kit.has(before.buyer.email), 'nothing before September 1');
  assert.equal(new URL(world.zeffyCalls[0]).searchParams.get('created[gte]'), String(S(Date.parse(START))));
  assert.equal((await readDonorConfig(env.DB)).caughtUp, false);
  const r2 = await runDonorSync(env, { now: NOW + 15 * MIN, alert });
  assert.equal(r2.added, 4);
  assert.equal(r2.waiting, 0);
  const cfg = await readDonorConfig(env.DB);
  assert.equal(cfg.caughtUp, true);
  assert.deepEqual(cfg.totals, { added: MAX_PEOPLE + 4, tagged: 0, leftOut: 0 });
  world.zeffyCalls = [];
  await runDonorSync(env, { now: NOW + 30 * MIN, alert });
  assert.equal(new URL(world.zeffyCalls[0]).searchParams.get('created[gte]'), String(S(NOW + 30 * MIN) - LOOKBACK_DAYS * 86400));
  // A check entered late with an earlier date is still found
  const late = gift({ created: S(NOW - 20 * DAY) });
  world.payments.push(late);
  const r4 = await runDonorSync(env, { now: NOW + 45 * MIN, alert });
  assert.equal(r4.added, 1);
});

test('Kit refusing: nobody is marked done, every gift is tried again; staff are told after an hour, once, then the all-clear', async () => {
  const p = gift();
  world.payments = [p];
  world.kitStatus = 401;
  const r1 = await sync();
  assert.match(r1.error, /API key is invalid/);
  assert.equal(await stateOf(p), null, 'not done: picked up once Kit works');
  assert.equal(told.length, 0, 'a blip doesn’t tell anyone');
  await runDonorSync(env, { now: NOW + 30 * MIN, alert });
  assert.equal(told.length, 0);
  await runDonorSync(env, { now: NOW + 61 * MIN, alert });
  assert.equal(told.length, 1);
  assert.equal(told[0].issue, 'kit-donors');
  assert.match(told[0].title, /donors aren’t reaching the newsletter/i);
  assert.match(told[0].fix, /KIT_API_KEY/);
  await runDonorSync(env, { now: NOW + 90 * MIN, alert });
  assert.equal(told.length, 1, 'once');
  world.kitStatus = 200;
  const ok = await runDonorSync(env, { now: NOW + 105 * MIN, alert });
  assert.equal(ok.added, 1);
  assert.equal(told.length, 2);
  assert.equal(told[1].resolves, 'kit-donors');
  assert.equal((await readDonorConfig(env.DB)).failingSince, null);
});

test('an error Kit words with an address in it is kept without the address', async () => {
  world.payments = [gift()];
  world.kitStatus = 422;
  world.kitError = 'Email address someone@example.com is invalid';
  const r = await sync();
  assert.equal(r.error, 'Kit: Email address (an address) is invalid');
  assert.ok(!JSON.stringify(await readDonorConfig(env.DB)).includes('@'));
});

test('Zeffy refusing its key says so, and the fix names ZEFFY_API_KEY', async () => {
  world.zeffyStatus = 401;
  const r = await sync();
  assert.equal(r.error, 'Zeffy refused ZEFFY_API_KEY');
  await runDonorSync(env, { now: NOW + 61 * MIN, alert });
  assert.match(told[0].fix, /ZEFFY_API_KEY/);
});

test('Kit refusing one person: tried again each run, then left for a person after 12 tries, and Automations says so', async () => {
  const p = gift({ buyer: { email: 'stuck@example.com' } });
  const fine = gift();
  world.payments = [p, fine];
  world.refuseTag.add('stuck@example.com');
  const r = await sync();
  assert.deepEqual([r.added, r.failed, r.error], [1, 1, null]);
  assert.equal((await stateOf(p)).state, 'failed');
  for (let i = 1; i < 11; i++) await runDonorSync(env, { now: NOW + i * 15 * MIN, alert });
  assert.equal((await stateOf(p)).state, 'failed');
  assert.equal(told.length, 0, 'one person Kit refuses isn’t Kit being down');
  const last = await runDonorSync(env, { now: NOW + 11 * 15 * MIN, alert });
  assert.equal(last.gaveUp, 1);
  assert.equal((await stateOf(p)).state, 'gave-up');
  assert.equal(told.length, 1, 'staff told once, when the site stops trying');
  assert.match(told[0].detail, new RegExp(p.id));
  assert.ok(!JSON.stringify(told[0]).includes('stuck@'), 'the note names the Zeffy payment, never the email');
  const s = await donorsStatus(env.DB);
  assert.equal(s.gaveUp, 1);
  world.kitCalls = [];
  await runDonorSync(env, { now: NOW + 13 * 15 * MIN, alert });
  assert.ok(!world.kitCalls.some((c) => c.includes('stuck')), 'not tried again after that');
  assert.equal(told.length, 1, 'and not told again');
});

test('the site keeps no email, name or amount: only payment ids, outcomes and times', async () => {
  kitSub('left@example.com', 'cancelled');
  world.payments = [gift({ buyer: { first_name: 'Marguerite', last_name: 'Quill' } }), gift({ buyer: { email: 'left@example.com', first_name: 'Ozymandias' } }), gift({ buyer: { email: null, first_name: 'Bartholomew' } })];
  await sync();
  const stored = JSON.stringify(await rows()) + JSON.stringify(await readDonorConfig(env.DB)) + JSON.stringify(await donorsStatus(env.DB));
  assert.ok(!stored.includes('@'), 'no email');
  for (const name of ['Marguerite', 'Quill', 'Ozymandias', 'Bartholomew', '5000']) assert.ok(!stored.includes(name), `no ${name}`);
});

test('a company’s name, or one typed in both name boxes, is never used as a first name', () => {
  assert.equal(donorFirstName({ first_name: 'Robin', last_name: 'Murray' }), 'Robin');
  assert.equal(donorFirstName({ first_name: 'Grainger', last_name: 'Grainger', is_corporate: true, company_name: 'Grainger' }), null);
  assert.equal(donorFirstName({ first_name: 'MCN Enterprises LLC', last_name: 'X', is_corporate: true, company_name: 'MCN Enterprises LLC' }), null);
  assert.equal(donorFirstName({ first_name: 'Ashley', last_name: 'Reynolds', is_corporate: true, company_name: 'Pella Window & Door' }), 'Ashley');
  assert.equal(donorFirstName({ first_name: 'n/a 2' }), null);
  assert.equal(donorFirstName({ first_name: '  ' }), null);
  assert.equal(donorFirstName({ first_name: 'RANDOLPH', last_name: 'LEGG' }), 'Randolph');
  assert.equal(donorFirstName({ first_name: 'mary-kate' }), 'Mary-Kate');
  assert.equal(donorFirstName({ first_name: 'DeShawn' }), 'DeShawn', 'a name with its own capitals stays as typed');
});

test('the heartbeat: needs both Zeffy and Kit, then every 15 minutes', async () => {
  world.payments = [gift()];
  assert.equal(await maybeSyncDonors({ ...env, KIT_API_KEY: '' }, { now: NOW, alert }), null);
  assert.equal(await maybeSyncDonors({ ...env, ZEFFY_API_KEY: '' }, { now: NOW, alert }), null);
  assert.equal(world.zeffyCalls.length, 0);
  const r = await maybeSyncDonors(env, { now: NOW, alert });
  assert.equal(r.added, 1);
  assert.equal(await maybeSyncDonors(env, { now: NOW + 14 * MIN, alert }), null);
  assert.ok(await maybeSyncDonors(env, { now: NOW + 15 * MIN, alert }));
});

test('Automations facts: people counts and times', async () => {
  const empty = await donorsStatus(env.DB);
  assert.deepEqual([empty.lastRunAt, empty.added, empty.gaveUp, empty.caughtUp], [null, 0, 0, false]);
  kitSub('on@example.com');
  kitSub('gone@example.com', 'cancelled');
  world.payments = [gift(), gift({ buyer: { email: 'on@example.com' } }), gift({ buyer: { email: 'gone@example.com' } })];
  await sync();
  const s = await donorsStatus(env.DB);
  assert.deepEqual([s.added, s.tagged, s.leftOut, s.caughtUp, s.error], [1, 1, 1, true, null]);
  assert.equal(s.lastRunAt, new Date(NOW).toISOString());
  assert.equal(s.lastAddedAt, new Date(NOW).toISOString());
});
