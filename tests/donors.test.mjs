/**
 * The donor list (functions/api/_donors.js): a read-only list of Zeffy's payments, kept right by reading again, and
 * each donor drawn from it. Against a fake Zeffy that pages and filters as its published API says. Names, emails and
 * amounts are made up.
 * Run: node --test tests/donors.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import * as D from '../functions/api/_donors.js';
import { zeffyQuota } from '../functions/api/_zeffy.js';

const DAY = 864e5;
const NOW = Date.parse('2026-11-11T17:00:00Z');
const S = (ms) => Math.floor(ms / 1000);
let db;
let env;
let zeffy;
let calls;
const pay = (o = {}) => ({
  id: o.id || `pay_${Math.random().toString(36).slice(2, 10)}`, object: 'payment', created: o.created ?? S(NOW - DAY), amount: o.amount ?? 10000,
  status: 'succeeded', type: o.type || 'online', refund_status: 'none', refunds: o.refunds || [], description: o.description ?? 'Help Build a Brighter Home',
  contact: o.contact === undefined ? 'ct_jane' : o.contact, payment_method: { type: o.method || 'card' },
  buyer: { email: o.email ?? 'jane@example.com', first_name: o.first ?? 'Jane', last_name: o.last ?? 'Doe', is_corporate: !!o.company, company_name: o.company || null },
  campaign_category: o.category || 'donation', items: o.items || [{ type: 'donation', amount: o.amount ?? 10000 }],
  buyer_questions: o.questions || [], recurring: o.recurring || null, metadata: o.metadata || {}, ...o.extra,
});
/** Zeffy's GET /payments: newest first, 100 a page, created range and status filters, starting_after cursors */
async function fakeFetch(url) {
  const u = new URL(url);
  calls.push(u.pathname + u.search);
  if (zeffy.fail) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
  const gte = Number(u.searchParams.get('created[gte]') ?? 0);
  const lte = Number(u.searchParams.get('created[lte]') ?? Infinity);
  const status = u.searchParams.get('status');
  const list = zeffy.payments.filter((p) => p.created >= gte && p.created <= lte && (!status || p.status === status)).sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
  const after = u.searchParams.get('starting_after');
  const start = after ? list.findIndex((p) => p.id === after) + 1 : 0;
  const data = list.slice(start, start + 100);
  const more = start + 100 < list.length;
  return new Response(JSON.stringify({ object: 'list', data, has_more: more, next_cursor: more ? data.at(-1).id : null }), { status: 200, headers: { 'X-RateLimit-Remaining': String(zeffy.remaining ?? 99), 'X-RateLimit-Reset': String(S(NOW) + 60) } });
}
const rows = async () => (await db.prepare('SELECT * FROM donor_payments ORDER BY at').all()).results;

beforeEach(async () => {
  db = await createD1({ schemaSql: ['CREATE TABLE kids (slug TEXT, name TEXT, data TEXT)', "INSERT INTO kids VALUES ('kyle', 'Kyle', '{\"name\":\"Kyle\"}')"] });
  env = { DB: db, ZEFFY_API_KEY: 'test' };
  zeffy = { payments: [], remaining: 99 };
  calls = [];
  zeffyQuota.remaining = null; zeffyQuota.at = 0;
});

test('giving: donations and sponsorships count, tickets and shop orders don’t, in kind is apart, refunds come off', () => {
  assert.equal(D.givingOf(pay({ amount: 25000 })), 25000);
  // A foursome is a ticket; a hole sponsorship on the same golf link is giving
  const golf = pay({ amount: 300000, category: 'event', items: [{ type: 'ticket', amount: 100000, rate_title: 'Foursome' }, { type: 'ticket', amount: 200000, rate_title: 'Hole Sponsor' }] });
  assert.equal(D.givingOf(golf), 200000);
  assert.equal(D.givingOf(pay({ amount: 15000, category: 'event', items: [{ type: 'ticket', amount: 15000, rate_title: 'General admission' }] })), 0);
  assert.equal(D.givingOf(pay({ amount: 15000, category: 'event', items: [{ type: 'ticket', amount: 10000, rate_title: 'Seat' }, { type: 'additional_donation', amount: 5000 }] })), 5000);
  assert.equal(D.givingOf(pay({ amount: 4000, category: 'shop', items: [] })), 0);
  assert.equal(D.givingOf(pay({ amount: 50000, method: 'cheque', type: 'manual', items: [] })), 50000, 'a check entered with no items is giving');
  assert.equal(D.givingOf(pay({ amount: 90000, method: 'in_kind' })), 0);
  assert.equal(D.givingOf(pay({ amount: 10000, refunds: [{ amount: 4000, status: 'succeeded' }, { amount: 6000, status: 'pending' }] })), 6000);
});

test('the site’s own test records never enter the list; a failed payment doesn’t either', () => {
  assert.equal(D.rowFromPayment(pay({ last: 'WebsiteTest', first: 'SOARD' }), 'x'), null);
  assert.equal(D.rowFromPayment(pay({ metadata: { soardSelfTest: true } }), 'x'), null);
  assert.equal(D.rowFromPayment({ ...pay(), status: 'failed' }, 'x'), null);
  assert.ok(D.rowFromPayment(pay(), 'x'));
});

test('a donor: split charges are one gift, years in a row, first/latest/largest, company gifts are “for”, DAF “through”', () => {
  const y = (yr, m = 3) => S(Date.UTC(yr, m, 10, 16));
  const list = [
    pay({ id: 'a1', created: y(2024), amount: 5000 }),
    pay({ id: 'b1', created: y(2025), amount: 400000 }), pay({ id: 'b2', created: y(2025) + 120, amount: 400000 }), pay({ id: 'b3', created: y(2025) + 240, amount: 200000 }),
    pay({ id: 'c1', created: y(2026, 9), amount: 250000, company: 'Acme Builders' }),
    pay({ id: 'd1', created: y(2026, 8), amount: 100000, method: 'daf', company: 'Fidelity Charitable' }),
  ].map((p) => D.rowFromPayment(p, 'x'));
  const d = D.donorOf('c:ct_jane', list, { now: NOW });
  assert.equal(d.total, 5000 + 1000000 + 250000 + 100000);
  assert.equal(d.gifts, 4, 'the $10,000 Zeffy took in three charges is one gift');
  assert.deepEqual(d.largest, { at: y(2025) + 240, cents: 1000000 });
  assert.deepEqual(d.first, { at: y(2024), cents: 5000 });
  assert.equal(d.latest.cents, 250000);
  assert.equal(d.streak, 3);
  assert.equal(d.thisYear, 350000);
  assert.deepEqual(d.companies, ['Acme Builders']);
  assert.deepEqual(d.funds, ['Fidelity Charitable']);
  assert.equal(d.stage, 'active');
});

test('stages roll: new within 12 months of the first gift, lapsed after 18 months with none; nothing flips on January 1', () => {
  const r = (daysAgo) => D.rowFromPayment(pay({ id: `x${daysAgo}`, created: S(NOW - daysAgo * DAY) }), 'x');
  assert.equal(D.donorOf('k', [r(30)], { now: NOW }).stage, 'new');
  assert.equal(D.donorOf('k', [r(400), r(30)], { now: NOW }).stage, 'active');
  assert.equal(D.donorOf('k', [r(900), r(500)], { now: NOW }).stage, 'active', 'a gift 16 months ago is still active');
  assert.equal(D.donorOf('k', [r(900), r(560)], { now: NOW }).stage, 'lapsed');
  const jan2 = Date.parse('2027-01-02T17:00:00Z');
  assert.equal(D.donorOf('k', [r(400), r(30)], { now: jan2 }).stage, 'active', 'a December giver is still active in January');
});

test('a gift to a campaign named for a child reads “Makeovers” on the donor page', async () => {
  zeffy.payments = [pay({ id: 'k1', description: 'Kyle’s Room Makeover', amount: 50000 })];
  await D.readWindow(env, { now: NOW, fetchImpl: fakeFetch });
  const v = await D.donorView(env, 'c:ct_jane', { now: NOW });
  assert.equal(v.gifts[0].campaign, 'Makeovers');
});

test('the window read settles only when it reached the last page: a deleted payment goes, a read cut short removes nothing', async () => {
  zeffy.payments = Array.from({ length: 230 }, (_, i) => pay({ id: `w${String(i).padStart(3, '0')}`, created: S(NOW - (i % 100) * DAY) - i }));
  let r = await D.readWindow(env, { now: NOW, fetchImpl: fakeFetch });
  assert.equal(r.done, true);
  assert.equal((await rows()).length, 230);
  // Deleted in Zeffy
  zeffy.payments = zeffy.payments.filter((p) => p.id !== 'w010');
  // A read cut short by Zeffy's minute running low after the first page: nothing removed
  zeffy.remaining = 5;
  r = await D.readWindow(env, { now: NOW + 15 * 60e3, fetchImpl: fakeFetch });
  assert.equal(r.done, false);
  assert.equal(r.stopped, 'quota');
  assert.ok((await rows()).some((x) => x.id === 'w010'), 'a read cut short removes nothing');
  zeffy.remaining = 99;
  zeffyQuota.remaining = null;
  r = await D.readWindow(env, { now: NOW + 45 * 60e3, fetchImpl: fakeFetch });
  assert.equal(r.done, true);
  assert.equal(r.dropped, 1);
  assert.ok(!(await rows()).some((x) => x.id === 'w010'));
});

test('a payment older than the window is left for the nightly read, and a webhook gift that arrives during a read stays', async () => {
  zeffy.payments = [pay({ id: 'old', created: S(NOW - 400 * DAY) }), pay({ id: 'recent', created: S(NOW - DAY) })];
  await D.readFill(env, {}, { now: NOW, fetchImpl: fakeFetch });
  assert.equal((await rows()).length, 2);
  zeffy.payments = zeffy.payments.filter((p) => p.id !== 'old');
  await D.readWindow(env, { now: NOW + 60e3, fetchImpl: fakeFetch });
  assert.ok((await rows()).some((x) => x.id === 'old'), 'outside the window: the window read never removes it');
  // A gift the webhook delivered after the read began, not in the page that read saw
  await D.noteDonorPayment(env, pay({ id: 'hook', created: S(NOW + 2 * 60e3) }), { now: NOW + 2 * 60e3 });
  await D.readWindow(env, { now: NOW + 90e3, fetchImpl: fakeFetch });
  assert.ok((await rows()).some((x) => x.id === 'hook'));
  // Zeffy lists the webhook's gift by now. The nightly read began a day later; a gift the webhook delivers while it
  // runs, not yet in the pages it reads, stays; the old one Zeffy no longer has goes once it reaches the end
  zeffy.payments.push(pay({ id: 'hook', created: S(NOW + 2 * 60e3) }));
  const began = new Date(NOW + DAY).toISOString();
  await D.noteDonorPayment(env, pay({ id: 'during', created: S(NOW + DAY + 60e3) }), { now: NOW + DAY + 60e3 });
  const f = await D.readFill(env, { fill: { began, cursor: null } }, { now: NOW + DAY + 2 * 60e3, fetchImpl: fakeFetch });
  assert.equal(f.done, true);
  assert.ok(!(await rows()).some((x) => x.id === 'old'), 'the end removes what Zeffy no longer has');
  assert.ok((await rows()).some((x) => x.id === 'hook'));
  assert.ok((await rows()).some((x) => x.id === 'during'), 'a gift that came in while the nightly read ran stays');
});

test('the nightly read resumes where it stopped and removes nothing until it reached the end', async () => {
  zeffy.payments = Array.from({ length: 1000 }, (_, i) => pay({ id: `h${String(i).padStart(4, '0')}`, created: S(NOW - (i + 1) * DAY) }));
  await D.readFill(env, {}, { now: NOW, fetchImpl: fakeFetch });
  await db.prepare("INSERT INTO donor_payments (id, at, cents, net, giving, first_seen, checked_at) VALUES ('ghost', 1000, 1, 1, 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run();
  let s = await D.readFill(env, {}, { now: NOW, fetchImpl: fakeFetch });
  assert.equal(s.done, false, '1,000 payments take more than one run');
  assert.ok((await rows()).some((x) => x.id === 'ghost'), 'nothing removed before the end');
  let state = { fill: s.fill };
  let runs = 1;
  while (state.fill) { s = await D.readFill(env, state, { now: NOW + runs * 60e3, fetchImpl: fakeFetch }); state = { fill: s.fill }; runs++; }
  assert.ok(runs >= 2);
  assert.ok(!(await rows()).some((x) => x.id === 'ghost'), 'the end removes what Zeffy no longer has');
  assert.equal((await rows()).length, 1000);
});

test('the heartbeat reads every 15 minutes, starts the nightly read after 2 AM Eastern once a day, and keeps going through an error', async () => {
  zeffy.payments = [pay({ id: 'p1' })];
  const at3am = Date.parse('2026-11-11T08:00:00Z'); // 3 AM Eastern
  let s = await D.maybeReadDonors(env, { now: at3am, fetchImpl: fakeFetch });
  assert.ok(s.windowAt && s.filledOn === '2026-11-11');
  const n = calls.length;
  assert.equal(await D.maybeReadDonors(env, { now: at3am + 5 * 60e3, fetchImpl: fakeFetch }), null, 'nothing due 5 minutes later');
  assert.equal(calls.length, n);
  zeffy.fail = true;
  s = await D.maybeReadDonors(env, { now: at3am + 16 * 60e3, fetchImpl: fakeFetch });
  assert.match(s.error, /down/);
  assert.equal((await rows()).length, 1, 'an error keeps the list as it was');
  zeffy.fail = false;
  s = await D.maybeReadDonors(env, { now: at3am + 32 * 60e3, fetchImpl: fakeFetch });
  assert.equal(s.error, null);
});

test('the list: one donor per Zeffy contact, by email or name when Zeffy has no contact; anonymous givers are marked', async () => {
  zeffy.payments = [
    pay({ id: 'j1' }), pay({ id: 'j2', created: S(NOW - 3 * DAY) }),
    pay({ id: 'n1', contact: null, email: 'sam@example.com', first: 'Sam', last: 'Lee' }),
    pay({ id: 'q1', contact: 'ct_quiet', email: 'quiet@example.com', first: 'Pat', last: 'Quiet', questions: [{ question: 'Make my gift anonymous', answer: 'Yes' }] }),
  ];
  await D.readWindow(env, { now: NOW, fetchImpl: fakeFetch });
  const v = await D.donorsView(env, { now: NOW });
  assert.deepEqual(v.people.map((p) => p.key).sort(), ['c:ct_jane', 'c:ct_quiet', 'e:sam@example.com']);
  assert.equal(v.people.find((p) => p.key === 'c:ct_jane').gifts, 2);
  assert.equal(v.people.find((p) => p.key === 'c:ct_quiet').anonymous, true);
  assert.equal(await D.donorOfPayment(env, 'n1'), 'e:sam@example.com');
});

test('a donor page links each gift’s check in Mercury when Checks made or matched its record', async () => {
  await db.prepare('CREATE TABLE check_gifts (id TEXT, zeffy_id TEXT, link TEXT)').run();
  await db.prepare("INSERT INTO check_gifts VALUES ('t1', 'chk1', 'https://app.mercury.com/transactions/t1')").run();
  zeffy.payments = [pay({ id: 'chk1', method: 'cheque', type: 'manual', items: [] }), pay({ id: 'web1', created: S(NOW - 9 * DAY) })];
  await D.readWindow(env, { now: NOW, fetchImpl: fakeFetch });
  const v = await D.donorView(env, 'c:ct_jane', { now: NOW });
  const check = v.gifts.find((g) => g.id === 'chk1');
  assert.equal(check.mercury, 'https://app.mercury.com/transactions/t1');
  assert.equal(check.how, 'Check');
  assert.equal(v.gifts.find((g) => g.id === 'web1').mercury, null);
});

test('an answer with no rate-limit header is not knowing, never “none left”: the nightly read still runs', async () => {
  zeffy.payments = [pay({ id: 'old', created: S(NOW - 900 * DAY) }), pay({ id: 'new' })];
  const bare = async (url) => { const r = await fakeFetch(url); return new Response(await r.text(), { status: r.status }); };
  const f = await D.readFill(env, {}, { now: NOW, fetchImpl: bare });
  assert.equal(f.done, true);
  assert.equal(zeffyQuota.remaining, null);
  assert.deepEqual((await rows()).map((r) => r.id).sort(), ['new', 'old']);
});

// ── Review round 1 (Nov 11 2026): each test failed on the code before its fix ──

test('a strange answer from Zeffy removes nothing and leaves the nightly read to try again: HTML, {}, more with no cursor', async () => {
  zeffy.payments = Array.from({ length: 150 }, (_, i) => pay({ id: `s${i}`, created: S(NOW - (i + 1) * 10 * DAY) }));
  await D.readFill(env, {}, { now: NOW, fetchImpl: fakeFetch });
  assert.equal((await rows()).length, 150);
  const odd = [
    async () => new Response('<html>Bad gateway</html>', { status: 200 }),
    async () => new Response('{}', { status: 200 }),
    async () => new Response(JSON.stringify({ data: [], has_more: true, next_cursor: null }), { status: 200 }),
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  ];
  for (const [i, f] of odd.entries()) {
    await assert.rejects(D.readFill(env, {}, { now: NOW + (i + 1) * DAY, fetchImpl: f }));
    await assert.rejects(D.readWindow(env, { now: NOW + (i + 1) * DAY, fetchImpl: f }));
    assert.equal((await rows()).length, 150, `answer ${i}: nothing removed`);
  }
  const at3 = Date.parse('2026-11-12T08:00:00Z');
  const s = await D.maybeReadDonors(env, { now: at3, fetchImpl: odd[1] });
  assert.ok(s.error && !s.filledOn, 'the error shows, and the night isn’t marked read');
});

test('a read that would take out more than a tenth is held, and goes through only when the next whole read agrees', async () => {
  zeffy.payments = Array.from({ length: 200 }, (_, i) => pay({ id: `h${i}`, created: S(NOW - (i + 1) * 5 * DAY) }));
  await D.readFill(env, {}, { now: NOW, fetchImpl: fakeFetch });
  const kept = zeffy.payments.slice(0, 100);
  zeffy.payments = kept;
  let f = await D.readFill(env, {}, { now: NOW + DAY, fetchImpl: fakeFetch });
  assert.equal(f.dropped, 0);
  assert.equal(f.held.count, 100);
  assert.equal((await rows()).length, 200, 'held: nothing removed on one read');
  // A day later the hold is too old to agree with: held again, never taken out on a stale count
  let late = await D.readFill(env, { heldFill: f.held }, { now: NOW + 3 * DAY, fetchImpl: fakeFetch });
  assert.equal(late.dropped, 0);
  f = await D.readFill(env, { heldFill: late.held }, { now: NOW + 3 * DAY + 90 * 60e3, fetchImpl: fakeFetch });
  assert.equal(f.dropped, 100, 'the next whole read, within hours, agreed: they go');
  assert.equal((await rows()).length, 100);
});

test('one run at a time: two heartbeats at once read Zeffy once, and nothing Zeffy has is removed', async () => {
  zeffy.payments = Array.from({ length: 120 }, (_, i) => pay({ id: `c${i}`, created: S(NOW - (i + 1) * DAY) }));
  const at3 = Date.parse('2026-11-11T08:00:00Z');
  await Promise.all([D.maybeReadDonors(env, { now: at3, fetchImpl: fakeFetch }), D.maybeReadDonors(env, { now: at3 + 5, fetchImpl: fakeFetch })]);
  const reads = calls.filter((c) => c.startsWith('/api/v1/payments') && !c.includes('starting_after')).length;
  assert.equal(reads, 2, 'one run: its window read and its history read');
  assert.equal((await rows()).length, 120);
});

test('the 15-minute read is tried every 15 minutes whatever happened, never every heartbeat', async () => {
  zeffy.fail = true;
  const t = Date.parse('2026-11-11T20:00:00Z');
  await D.maybeReadDonors(env, { now: t, fetchImpl: fakeFetch });
  const n = calls.length;
  assert.equal(await D.maybeReadDonors(env, { now: t + 2 * 60e3, fetchImpl: fakeFetch }), null);
  assert.equal(calls.length, n);
  const s = await D.maybeReadDonors(env, { now: t + 16 * 60e3, fetchImpl: fakeFetch });
  assert.ok(calls.length > n && s.windowError && s.error);
});

test('a gift first seen in the last half hour (the webhook ahead of Zeffy’s list) is never taken out', async () => {
  await D.noteDonorPayment(env, pay({ id: 'early', created: S(NOW) }), { now: NOW });
  zeffy.payments = [pay({ id: 'other' })];
  await D.readWindow(env, { now: NOW + 10 * 60e3, fetchImpl: fakeFetch });
  assert.ok((await rows()).some((r) => r.id === 'early'));
});

test('a gift refunded in full isn’t giving, isn’t in kind, and its donor isn’t on the list; a lost dispute is no money', async () => {
  zeffy.payments = [pay({ id: 'rf', contact: 'ct_rita', email: 'rita@example.com', first: 'Rita', last: 'Moss', amount: 50000, refunds: [{ amount: 50000, status: 'succeeded' }], extra: { refund_status: 'full' } })];
  await D.readWindow(env, { now: NOW, fetchImpl: fakeFetch });
  const v = await D.donorsView(env, { now: NOW });
  assert.ok(!v.people.some((p) => p.key === 'c:ct_rita'));
  const page = await D.donorView(env, 'c:ct_rita', { now: NOW });
  assert.equal(page.donor.stage, 'none');
  assert.equal(page.gifts[0].refunded, true);
  assert.ok(!page.gifts[0].sold && !page.gifts[0].inKind);
  assert.equal(D.netOf(pay({ amount: 9000, extra: { dispute: { status: 'lost' } } })), 0);
});

test('the no-mail address Checks parks on a contact is nobody’s email, on the list or to Kit', () => {
  const r = D.rowFromPayment(pay({ email: 'check-abc123@nomail.soardcharity.com' }), 'x');
  assert.equal(r.email, null);
});

test('gifts in kind joined into one show their whole value, and never count as giving', () => {
  const list = [pay({ id: 'k1', method: 'in_kind', amount: 300000, created: S(NOW - DAY) }), pay({ id: 'k2', method: 'in_kind', amount: 200000, created: S(NOW - DAY) + 60 }), pay({ id: 'm1', amount: 1000 })].map((p) => D.rowFromPayment(p, 'x'));
  const d = D.donorOf('c:ct_jane', list, { now: NOW });
  assert.equal(d.inKind, 500000);
  assert.equal(d.total, 1000);
  const g = D.giftsFrom(list).find((x) => x.inKind);
  assert.equal(g.cents, 500000);
  assert.equal(g.parts, 2);
});

test('a name typed in both boxes is said once, as the board says it', () => {
  const d = D.donorOf('c:x', [D.rowFromPayment(pay({ first: 'Pella', last: 'Pella', company: 'Pella', contact: 'x' }), 'x')], { now: NOW });
  assert.equal(d.name, 'Pella');
});

test('a refund comes off what was bought first: a refunded foursome leaves the hole sponsorship as giving', () => {
  const golf = pay({ amount: 150000, category: 'event', refunds: [{ amount: 100000, status: 'succeeded' }], items: [{ type: 'ticket', amount: 100000, rate_title: 'Foursome' }, { type: 'ticket', amount: 50000, rate_title: 'Hole Sponsor' }] });
  assert.equal(D.givingOf(golf), 50000);
});

test('a payment with no contact, under an email a contact has, is that contact’s: one person, one donor', async () => {
  zeffy.payments = [pay({ id: 'withc', contact: 'ct_sam', email: 'sam@example.com', first: 'Sam', last: 'Lee', created: S(NOW - 9 * DAY) }), pay({ id: 'noc', contact: null, email: 'sam@example.com', first: 'Sam', last: 'Lee' })];
  await D.readWindow(env, { now: NOW, fetchImpl: fakeFetch });
  const v = await D.donorsView(env, { now: NOW });
  assert.deepEqual(v.people.map((p) => p.key), ['c:ct_sam']);
  assert.equal(v.people[0].gifts, 2);
  assert.equal(await D.donorOfPayment(env, 'noc'), 'c:ct_sam');
  assert.equal((await D.donorView(env, 'c:ct_sam', { now: NOW })).gifts.length, 2);
});

test('a nightly read that held a shrink is read again an hour on, to settle it', async () => {
  zeffy.payments = [pay({ id: 'a1' })];
  const t = Date.parse('2026-11-11T20:00:00Z');
  await D.ensureDonors(db);
  await db.prepare("INSERT INTO donor_state (key, value) VALUES ('donors', ?)").bind(JSON.stringify({
    filledOn: '2026-11-11', windowTriedAt: new Date(t).toISOString(),
    heldFill: { kind: 'fill', count: 30, of: 100, at: new Date(t - 61 * 60e3).toISOString() },
  })).run();
  const s = await D.maybeReadDonors(env, { now: t, fetchImpl: fakeFetch });
  assert.ok(s.fillTriedAt && s.filledAt === new Date(t).toISOString(), 'it read the whole history again');
  assert.equal(s.heldFill, null, 'nothing held this time');
});
