/**
 * Major gifts on the board page, read from Zeffy (functions/api/_board-gifts.js)
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { giftOf, giftsOf, campaignOf, kidNames, readGifts, maybeReadGifts, giftsNow, giftsStatus, yearStartS } from '../functions/api/_board-gifts.js';

const NOW = Date.parse('2026-10-30T16:00:00Z'); // noon Eastern
const S = (ms) => Math.floor(ms / 1000);
const DAY = 864e5;

/** A Zeffy Payment, the shape GET /payments returns (made-up people) */
const payment = (o = {}) => ({
  id: 'pay_0001', object: 'payment', created: S(NOW - DAY), amount: 250000, currency: 'usd', status: 'succeeded', type: 'online',
  refund_status: 'none', refunds: [], description: 'Evening of Sunshine', payment_method: { type: 'card', brand: 'visa', last4: '4242' },
  buyer: { email: 'jane@example.com', first_name: 'Jane', last_name: 'Doe', is_corporate: false, company_name: null, address: { line1: '1 Example St' } },
  buyer_questions: [], items: [], recurring: null, metadata: {}, ...o,
});

let env;
let calls;
let pages;
const zeffy = async (url) => {
  const u = new URL(url);
  assert.equal(u.host, 'api.zeffy.com');
  calls.push(u);
  const at = Number(u.searchParams.get('starting_after') || 0);
  const page = pages[at];
  if (page instanceof Error) throw page;
  return Response.json({ object: 'list', data: page || [], has_more: at + 1 < pages.length, next_cursor: at + 1 < pages.length ? String(at + 1) : null });
};

beforeEach(async () => {
  env = { DB: await createD1({ schemaSql: ['CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)'] }), ZEFFY_API_KEY: 'zk_test' };
  calls = [];
  pages = [[]];
});

test('a major gift is $1,000 or more after refunds, through the same screen as the Slack alert', () => {
  assert.equal(giftOf(payment({ amount: 100000 })).cents, 100000);
  assert.equal(giftOf(payment({ amount: 99999 })), null);
  // A partial refund that takes it under $1,000 isn't a major gift; one that doesn't shows what was kept
  assert.equal(giftOf(payment({ amount: 120000, refund_status: 'partial', refunds: [{ amount: 30000, status: 'succeeded' }] })), null);
  assert.equal(giftOf(payment({ amount: 500000, refund_status: 'partial', refunds: [{ amount: 100000, status: 'succeeded' }, { amount: 50000, status: 'failed' }] })).cents, 400000);
  for (const p of [payment({ refund_status: 'full' }), payment({ status: 'failed' }), payment({ metadata: { soardSelfTest: true } })]) assert.equal(giftOf(p), null);
  // A gift imported into Zeffy (a gala's, from its auction platform) is this year's giving: on the board
  assert.ok(giftOf(payment({ type: 'imported' })), 'an imported gift counts on the board');
});

test('who gave: a name, a company and the person who gave for it, never an email or address', () => {
  const g = giftOf(payment());
  // contact and method are kept for Keep anonymous; the board page never gets them (giftsNow leaves them out)
  assert.deepEqual(g, { id: 'pay_0001', at: S(NOW - DAY), cents: 250000, name: 'Jane Doe', company: '', anonymous: false, campaign: 'Evening of Sunshine', every: '', inKind: false, contact: '', method: 'card' });
  assert.doesNotMatch(JSON.stringify(g), /example\.com|Example St|4242/);
  const co = giftOf(payment({ buyer: { first_name: 'Lee', last_name: 'Sample', is_corporate: true, company_name: '  Sample  Builders ' } }));
  assert.equal(co.company, 'Sample Builders');
  assert.equal(co.name, 'Lee Sample');
  // A company name typed without ticking "as an organization" is still the person's gift
  assert.equal(giftOf(payment({ buyer: { first_name: 'Lee', last_name: 'Sample', is_corporate: false, company_name: 'Sample Builders' } })).company, '');
});

test('a giver who asked to stay anonymous is Anonymous, company and all', () => {
  const q = (answer) => [{ question: 'Make my donation anonymous', type: 'checkbox', answer }];
  for (const answer of [true, 'Yes']) {
    const g = giftOf(payment({ buyer_questions: q(answer), buyer: { first_name: 'Lee', last_name: 'Sample', is_corporate: true, company_name: 'Sample Builders' } }));
    assert.equal(g.anonymous, true);
    assert.equal(g.name, '');
    assert.equal(g.company, '');
  }
  assert.equal(giftOf(payment({ buyer_questions: q(false) })).name, 'Jane Doe');
});

test('monthly and in kind; a one-time gift is neither, and a foundation named twice is named once', () => {
  assert.equal(giftOf(payment({ recurring: { is_recurring: true, interval: 'month' } })).every, 'monthly');
  // What Zeffy sends on a one-time gift (seen on SOARD's real payments, Oct 30 2026)
  assert.equal(giftOf(payment({ items: [{ type: 'donation', amount: 250000, recurrence_interval: 'onetime' }] })).every, '');
  assert.equal(giftOf(payment({ recurring: { is_recurring: false, interval: 'month' } })).every, '');
  const f = giftOf(payment({ buyer: { first_name: 'Example Family', last_name: 'Foundation', is_corporate: true, company_name: 'Example Family Foundation' } }));
  assert.deepEqual([f.company, f.name], ['Example Family Foundation', '']);
  assert.equal(giftOf(payment({ type: 'manual', payment_method: { type: 'in_kind' } })).inKind, true);
});

test('a campaign named for a child reads “Makeovers”; the kids come from every page, drafts too', async () => {
  await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('max', 'Max', 2026, JSON.stringify({ name: 'Max', publishStatus: 'draft' })).run();
  await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('ava-and-eli', 'Ava & Eli', 2025, JSON.stringify({ name: 'Ava and Eli Sample' })).run();
  const kids = await kidNames(env.DB);
  assert.deepEqual(kids.sort(), ['Ava', 'Eli', 'Max']);
  assert.equal(campaignOf('Help build Max’s room', kids), 'Makeovers');
  assert.equal(campaignOf("ELI'S MAKEOVER", kids), 'Makeovers');
  assert.equal(campaignOf('Maximum Impact Fund', kids), 'Maximum Impact Fund', 'a name inside a word is not the name');
  assert.equal(campaignOf('Evening of Sunshine', kids), 'Evening of Sunshine');
  assert.equal(campaignOf('  ', kids), '');
});

test('a gift Zeffy took in several charges is one gift: $4,000 + $4,000 + $2,000 minutes apart is $10,000', () => {
  const MIN = 60e3;
  const at = NOW - 5 * DAY;
  // Zeffy takes $5,000 at most in one charge: the giver pays three times in four minutes
  const split = [payment({ id: 'pay_0a', created: S(at), amount: 400000 }), payment({ id: 'pay_0b', created: S(at + 2 * MIN), amount: 400000 }), payment({ id: 'pay_0c', created: S(at + 4 * MIN), amount: 200000 })];
  const [g, ...rest] = giftsOf(split);
  // Every charge is kept with it (ids, charges) for Keep anonymous; the board page never gets them
  const { ids, charges, ...shown } = g;
  assert.deepEqual(shown, { id: 'pay_0a', at: S(at + 4 * MIN), cents: 1000000, name: 'Jane Doe', company: '', anonymous: false, campaign: 'Evening of Sunshine', every: '', inKind: false, contact: '', method: 'card', parts: 3 });
  assert.equal(ids.length, 3);
  assert.equal(charges.length, 3);
  assert.equal(rest.length, 0);
  // The same payments read twice (Zeffy's pages overlap) are counted once
  assert.equal(giftsOf([...split, ...split])[0].cents, 1000000);
  // A last charge under $1,000 is part of the gift, and charges under $1,000 that add up to it make one
  assert.equal(giftsOf([payment({ amount: 500000 }), payment({ id: 'pay_0d', amount: 50000 })])[0].cents, 550000);
  assert.deepEqual(giftsOf([payment({ amount: 60000 }), payment({ id: 'pay_0d', amount: 60000 })]).map((x) => x.cents), [120000]);
  assert.deepEqual(giftsOf([payment({ amount: 60000 })]), []);
  // Each charge within an hour of the one before; a payment more than an hour on is a gift of its own
  assert.deepEqual(giftsOf([payment({ id: 'pay_01', created: S(at), amount: 300000 }), payment({ id: 'pay_02', created: S(at + 50 * MIN), amount: 300000 }), payment({ id: 'pay_03', created: S(at + 100 * MIN), amount: 300000 }), payment({ id: 'pay_04', created: S(at + 200 * MIN), amount: 300000 })]).map((x) => [x.id, x.cents, x.parts]), [['pay_04', 300000, undefined], ['pay_01', 900000, 3]]);
});

test('only one giver’s one-time payments to one campaign are put together; anonymous once is anonymous', () => {
  const two = (o) => giftsOf([payment({ id: 'pay_0a', amount: 300000 }), payment({ id: 'pay_0b', amount: 300000, ...o })]).length;
  assert.equal(two({ description: 'Golf Classic' }), 2, 'another campaign');
  assert.equal(two({ buyer: { email: 'sam@example.com', first_name: 'Sam', last_name: 'Doe' } }), 2, 'another giver');
  assert.equal(two({ buyer: { email: 'jdoe@example.org', first_name: ' jane ', last_name: 'DOE' } }), 1, 'the same name, however it was typed, whatever the email');
  assert.equal(two({ recurring: { interval: 'month' } }), 2, 'monthly gifts each month');
  assert.equal(two({ payment_method: { type: 'in_kind' } }), 2, 'in kind beside money');
  // No name: the company, else the email tells them apart; none of them, and each stands alone
  const unnamed = (o) => ({ buyer: { is_corporate: false, ...o } });
  assert.equal(giftsOf([payment({ id: 'pay_0a', ...unnamed({ company_name: 'Sample Builders' }) }), payment({ id: 'pay_0b', ...unnamed({ company_name: 'Sample Builders' }) })]).length, 1);
  assert.equal(giftsOf([payment({ id: 'pay_0a', ...unnamed({ email: 'a@example.com' }) }), payment({ id: 'pay_0b', ...unnamed({ email: 'a@example.com' }) })]).length, 1);
  assert.equal(giftsOf([payment({ id: 'pay_0a', ...unnamed({ email: 'a@example.com' }) }), payment({ id: 'pay_0b', ...unnamed({ email: 'b@example.com' }) })]).length, 2);
  assert.equal(giftsOf([payment({ id: 'pay_0a', buyer: {} }), payment({ id: 'pay_0b', buyer: {} })]).length, 2);
  // A company's gift keeps its name; one charge marked anonymous makes the whole gift anonymous
  const co = { buyer: { email: 'lee@example.com', first_name: 'Lee', last_name: 'Sample', is_corporate: true, company_name: 'Sample Builders' } };
  assert.deepEqual(giftsOf([payment({ id: 'pay_0a', ...co }), payment({ id: 'pay_0b', ...co })]).map((g) => [g.company, g.name, g.cents]), [['Sample Builders', 'Lee Sample', 500000]]);
  const hidden = giftsOf([payment({ id: 'pay_0a', ...co }), payment({ id: 'pay_0b', ...co, buyer_questions: [{ question: 'Give anonymously?', answer: true }] })]);
  assert.deepEqual(hidden.map((g) => [g.company, g.name, g.anonymous, g.cents]), [['', '', true, 500000]]);
});

test('the year is read from January 1 in Eastern time, every page, newest first', async () => {
  assert.equal(new Date(yearStartS(2026) * 1000).toISOString(), '2026-01-01T05:00:00.000Z');
  pages = [
    [payment({ id: 'pay_old', created: S(NOW - 30 * DAY), amount: 100000 }), payment({ id: 'pay_small', created: S(NOW - 2 * DAY), amount: 5000 })],
    [payment({ id: 'pay_new', created: S(NOW - DAY), amount: 2500000 }), payment({ id: 'pay_old', created: S(NOW - 30 * DAY), amount: 100000 })],
  ];
  const r = await readGifts(env, { fetchImpl: zeffy, now: NOW });
  assert.equal(r.year, 2026);
  assert.deepEqual(r.list.map((g) => g.id), ['pay_new', 'pay_old'], 'newest first, a payment once');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get('status'), 'succeeded');
  assert.equal(calls[0].searchParams.get('created[gte]'), String(yearStartS(2026)));
  assert.equal(calls[0].searchParams.get('created[lte]'), String(S(NOW)));
});

test('the heartbeat reads every 15 minutes, replaces the list whole, and keeps the last one through a failure', async () => {
  assert.equal(await maybeReadGifts({ ...env, ZEFFY_API_KEY: '' }, { fetchImpl: zeffy, now: NOW }), null, 'no key, no read');
  assert.equal(await giftsNow(env.DB, { now: NOW }), null, 'nothing before the first read');
  pages = [[payment({ id: 'pay_aaa', amount: 300000 }), payment({ id: 'pay_bbb', created: S(NOW - 2 * DAY), amount: 100000 })]];
  await maybeReadGifts(env, { fetchImpl: zeffy, now: NOW });
  let g = await giftsNow(env.DB, { now: NOW });
  assert.deepEqual({ year: g.year, count: g.count, total: g.total, stale: g.stale }, { year: 2026, count: 2, total: 400000, stale: false });
  // Ten minutes on, no read; at fifteen, a refund drops one out
  pages = [[payment({ id: 'pay_aaa', amount: 300000 })]];
  await maybeReadGifts(env, { fetchImpl: zeffy, now: NOW + 10 * 60e3 });
  assert.equal(calls.length, 1);
  await maybeReadGifts(env, { fetchImpl: zeffy, now: NOW + 15 * 60e3 });
  g = await giftsNow(env.DB, { now: NOW + 15 * 60e3 });
  assert.deepEqual(g.list.map((x) => x.id), ['pay_aaa']);
  // Zeffy refusing the key: the list stays, the trouble is noted for Automations
  pages = [Object.assign(new Error('Unauthorized'), { status: 401 })];
  await maybeReadGifts(env, { fetchImpl: zeffy, now: NOW + 30 * 60e3 });
  assert.deepEqual((await giftsNow(env.DB, { now: NOW + 30 * 60e3 })).list.map((x) => x.id), ['pay_aaa']);
  assert.equal((await giftsStatus(env.DB)).error, 'Zeffy refused ZEFFY_API_KEY');
  // A day without a good read says so
  assert.equal((await giftsNow(env.DB, { now: NOW + 26 * 60 * 60e3 })).stale, true);
});

test('in January last year’s gifts are gone: a new year starts empty', async () => {
  pages = [[payment({ id: 'pay_dec', amount: 900000 })]];
  await maybeReadGifts(env, { fetchImpl: zeffy, now: NOW });
  const g = await giftsNow(env.DB, { now: Date.parse('2027-01-01T06:00:00Z') });
  assert.deepEqual({ year: g.year, count: g.count, total: g.total, list: g.list }, { year: 2027, count: 0, total: 0, list: [] });
});

test('Keep anonymous in Donors & Partners hides the giver on the board, the person or the organization the gift counts for', async () => {
  const { act } = await import('../functions/api/_donor-crm.js');
  const db2 = await createD1({ schemaSql: ["CREATE TABLE partners (slug TEXT PRIMARY KEY, data TEXT)", "INSERT INTO partners VALUES ('acme', '{\"name\":\"Acme Builders\",\"level\":\"friend\"}')"] });
  const at = NOW - 3 * DAY;
  const pays = [
    payment({ id: 'pay_p1', contact: 'ct_jane', created: S(at) }),
    payment({ id: 'pay_p2', contact: 'ct_lee', created: S(at), buyer: { first_name: 'Lee', last_name: 'Sample', email: 'lee@example.com', is_corporate: true, company_name: 'Acme Builders' } }),
    payment({ id: 'pay_p3', contact: 'ct_kim', created: S(at), buyer: { first_name: 'Kim', last_name: 'Park', email: 'kim@example.com' } }),
  ];
  const list = pays.map((p) => giftOf(p));
  // The donor list has them too (the gift webhook and the 15-minute read): one not there yet is hidden while anyone is kept
  const { noteDonorPayment } = await import('../functions/api/_donors.js');
  for (const p of pays) await noteDonorPayment({ DB: db2 }, p, { now: NOW });
  const { writeState } = await import('../functions/api/_board-roles.js');
  await writeState(db2, 'gifts', { year: 2026, list, at: new Date(NOW).toISOString(), triedAt: new Date(NOW).toISOString() });
  let v = await giftsNow(db2, { now: NOW });
  assert.deepEqual(v.list.map((g) => g.name || g.company || 'Anonymous').sort(), ['Jane Doe', 'Kim Park', 'Lee Sample']);
  assert.ok(v.list.every((g) => !('contact' in g) && !('method' in g)), 'the board never gets the contact');
  await act({ DB: db2 }, { act: 'anon', key: 'c:ct_jane', on: true }, 'staff@example.org', { now: NOW });
  await act({ DB: db2 }, { act: 'anon', key: 'p:acme', on: true }, 'staff@example.org', { now: NOW });
  v = await giftsNow(db2, { now: NOW });
  const by = Object.fromEntries(v.list.map((g) => [g.id, g]));
  assert.equal(by.pay_p1.anonymous, true, 'the person kept anonymous');
  assert.equal(by.pay_p1.name, '');
  assert.equal(by.pay_p2.anonymous, true, 'a gift for an organization kept anonymous');
  assert.equal(by.pay_p2.company, '');
  assert.equal(by.pay_p3.name, 'Kim Park', 'everyone else as they were');
});

test('an imported gift refunded in full, failed or of nothing is never on the board', () => {
  for (const p of [payment({ type: 'imported', refund_status: 'full' }), payment({ type: 'imported', status: 'failed' }), payment({ type: 'imported', amount: 0 })]) assert.equal(giftOf(p), null);
});
