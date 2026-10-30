/**
 * Major gifts on the board page, read from Zeffy (functions/api/_board-gifts.js)
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { giftOf, campaignOf, kidNames, readGifts, maybeReadGifts, giftsNow, giftsStatus, yearStartS } from '../functions/api/_board-gifts.js';

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
  for (const p of [payment({ refund_status: 'full' }), payment({ type: 'imported' }), payment({ status: 'failed' }), payment({ metadata: { soardSelfTest: true } })]) assert.equal(giftOf(p), null);
});

test('who gave: a name, a company and the person who gave for it, never an email or address', () => {
  const g = giftOf(payment());
  assert.deepEqual(g, { id: 'pay_0001', at: S(NOW - DAY), cents: 250000, name: 'Jane Doe', company: '', anonymous: false, campaign: 'Evening of Sunshine', every: '', inKind: false });
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

test('monthly and in kind', () => {
  assert.equal(giftOf(payment({ recurring: { is_recurring: true, interval: 'month' } })).every, 'monthly');
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

test('the year is read from January 1 in Eastern time, every page, newest first', async () => {
  assert.equal(new Date(yearStartS(2026) * 1000).toISOString(), '2026-01-01T05:00:00.000Z');
  pages = [
    [payment({ id: 'pay_old', created: S(NOW - 30 * DAY), amount: 100000 }), payment({ id: 'pay_small', amount: 5000 })],
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
