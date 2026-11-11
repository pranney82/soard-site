/**
 * A gift from a donor-advised fund, given on a Zeffy form (Peter, Nov 10 2026: the site points DAF donors at Zeffy's
 * "Donor-advised fund" checkout). Zeffy records it at once, Due until someone marks it paid; the money comes days or
 * weeks later as a check from the fund, under the fund's name. That check must never become a second Zeffy record:
 * matchZeffy and netOf (the wide look) read a DAF gift under any name, the check's card shows it ("This is the check"),
 * and Send refuses until the person says it's a different gift. A paid DAF gift holds a check only in the DAF_DAYS (90)
 * before it, so one old gift doesn't hold every check of its amount.
 *
 * Real shape (SOARD's Zeffy, Oct 15 2026): "Donation SK3IIOCK via Other", method DAF, Succeeded. The API's word for the
 * method isn't documented, hence the spellings. Each end-to-end case has its control: the same check, sent, without it.
 * Against the spec-faithful fakes in tests/lib/check-gifts-harness-2.mjs. Names are made up.
 * Run: node --test tests/check-gifts-daf.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, rowOf, posted, fakeFetch, hand, dayS, approve, card, NOW, MIN } = await import('./lib/check-gifts-harness-2.mjs');
const { byDaf, matchZeffy, matchBoth, netOf, notesFor } = CG;

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => setup());
const world = () => W.world;
const sitePosts = () => world().posts.filter((b) => b.amount > 100);

const person = (first, last, o = {}) => ({ first_name: first, last_name: last, email: null, is_corporate: false, company_name: null, ...o });
/** A DAF gift on a Zeffy form: online, Due (pending) unless said, under the donor's own name */
const daf = (o = {}) => hand({
  id: 'zp_daf', type: 'online', status: 'pending', created: dayS('2026-10-01'), contact: 'c_dana',
  payment_method: { type: 'daf', brand: null, last4: null }, buyer: person('Dana', 'Whitfield', { email: 'dana@example.com' }), ...o,
});
/** The harness's check: Pine Foundation, $10,000, written Nov 3, deposited Nov 5 */
const row = (o = {}) => ({ id: 'tx1', cents: 1000000, payer: 'Pine Foundation', memo: '', check_date: '2026-11-03', deposited_at: '2026-11-05T15:00:00Z', ...o });
const FORMS = [{ id: 'form_home', title: 'Help Build a Brighter Home', open: true, kind: 'donation' }];
const ids = (list) => list.map((p) => p.id);

// ── The DAF method, however Zeffy spells it ─────────────────────────────────────────────────────────────────────────────

test('a DAF gift is known by its method, in any spelling; card, bank, check, cash and goods are not', () => {
  for (const type of ['daf', 'DAF', 'Daf', 'donor_advised_fund', 'donor-advised fund', 'DonorAdvisedFund', 'dafpay', 'daf_grant'])
    assert.equal(byDaf({ payment_method: { type } }), true, type);
  for (const type of ['card', 'cheque', 'check', 'ach', 'us_bank_account', 'apple_pay', 'google_pay', 'cash', 'in_kind', 'other', 'tap_to_pay', '', undefined])
    assert.equal(byDaf({ payment_method: { type } }), false, String(type));
  assert.equal(byDaf(null), false);
});

// ── matchZeffy ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a Due DAF gift under another name, of any age, may be the fund\'s check: a person says, it never links by itself', () => {
  for (const created of [dayS('2026-10-30'), dayS('2026-10-01'), dayS('2025-12-01')]) {
    const m = matchZeffy(row(), [daf({ created })]);
    assert.deepEqual({ same: ids(m.same), promised: ids(m.promised), maybe: ids(m.maybe) }, { same: [], promised: [], maybe: ['zp_daf'] }, `made ${new Date(created * 1000).toISOString().slice(0, 10)}`);
  }
});

test('the giver\'s own Due DAF gift is a promise this check may pay, for its amount or another', () => {
  const mine = daf({ buyer: person('Pine', 'Foundation') });
  assert.deepEqual(ids(matchZeffy(row(), [mine]).promised), ['zp_daf']);
  assert.deepEqual(ids(matchZeffy(row({ cents: 750000 }), [mine]).promised), ['zp_daf']);
  // Another name and another amount: nothing to do with this check
  const m = matchZeffy(row({ cents: 750000 }), [daf()]);
  assert.equal(m.same.length + m.promised.length + m.maybe.length + m.other.length, 0);
});

test('a DAF gift already marked paid holds the check when it was given in the 90 days before it, never by itself', () => {
  assert.deepEqual(ids(matchZeffy(row(), [daf({ status: 'succeeded', created: dayS('2026-08-10') })]).maybe), ['zp_daf']);
  // Even the giver's own, sure name, given days before: a person marks the DAF gift paid in Zeffy, so a person links it
  const m = matchZeffy(row(), [daf({ status: 'succeeded', created: dayS('2026-11-01'), buyer: person('Pine', 'Foundation') })], new Set(), { contact_id: 'c_dana' });
  assert.deepEqual({ same: ids(m.same), maybe: ids(m.maybe) }, { same: [], maybe: ['zp_daf'] });
  // Paid long before: last spring's gift isn't this check
  const old = matchZeffy(row(), [daf({ status: 'succeeded', created: dayS('2026-07-01') })]);
  assert.equal(old.same.length + old.promised.length + old.maybe.length + old.other.length, 0);
});

test('a DAF gift already taken by another check, refunded or failed is left alone; a card gift is still nobody\'s check', () => {
  assert.equal(matchZeffy(row(), [daf()], new Set(['zp_daf'])).maybe.length, 0);
  assert.equal(matchZeffy(row(), [daf({ refund_status: 'full' })]).maybe.length, 0);
  assert.equal(matchZeffy(row(), [daf({ status: 'failed' })]).maybe.length, 0);
  const card = matchZeffy(row(), [daf({ status: 'succeeded', created: dayS('2026-10-20'), payment_method: { type: 'card', brand: 'visa', last4: '4242' } })]);
  assert.equal(card.same.length + card.promised.length + card.maybe.length + card.other.length, 0);
});

test('under both of a check\'s names (the letter\'s giver and the fund on the check) a DAF gift is asked about once', () => {
  const m = matchBoth(row({ payer: 'Dana Whitfield', drawer: 'Whitfield Family Fund' }), [daf()]);
  const all = [...m.same, ...m.promised, ...m.maybe, ...m.other].map((p) => p.id);
  assert.deepEqual(all, ['zp_daf']);
  assert.deepEqual(ids(m.promised), ['zp_daf'], 'the letter names the donor: her own gift, still Due');
});

// ── netOf, the wide look before a check is sent ─────────────────────────────────────────────────────────────────

test('the wide look sees a Due DAF gift under any name and age, and a paid one from the 90 days before the check', () => {
  assert.deepEqual(ids(netOf(row(), [daf({ created: dayS('2025-12-01') })])), ['zp_daf']);
  assert.deepEqual(ids(netOf(row(), [daf({ status: 'succeeded', created: dayS('2026-08-10') })])), ['zp_daf']);
  assert.deepEqual(ids(netOf(row(), [daf({ status: 'succeeded', created: dayS('2026-07-01') })])), []);
  assert.deepEqual(ids(netOf(row(), [daf({ status: 'succeeded', created: dayS('2026-07-01') })], new Set(), { turnedPaid: new Set(['zp_daf']) })), ['zp_daf'], 'marked paid since the check was written');
  // Controls: the same entry paid by card, and a DAF gift of another amount
  assert.deepEqual(ids(netOf(row(), [daf({ status: 'succeeded', created: dayS('2026-10-20'), payment_method: { type: 'card', brand: 'visa', last4: '4242' } })])), []);
  assert.deepEqual(ids(netOf(row({ cents: 750000 }), [daf()])), []);
});

// ── notesFor, what the card says ────────────────────────────────────────────────────────────────────────────────────────

test('notesFor: a fund\'s check with a DAF gift waiting puts it on the card, never sent as a new record without a look', () => {
  const card = (payments) => (({ link, notes, entries }) => ({ link, notes, entries: ids(entries) }))(notesFor(row(), { payments, forms: FORMS }));
  assert.deepEqual(card([daf()]), { link: null, notes: ['maybe-double'], entries: ['zp_daf'] });
  assert.deepEqual(card([daf({ buyer: person('Pine', 'Foundation') })]), { link: null, notes: ['pledge'], entries: ['zp_daf'] });
  // Control: without it, or with only last spring's paid one, the card is a new gift, ready as it's filled in
  assert.deepEqual(card([]), { link: null, notes: [], entries: [] });
  assert.deepEqual(card([daf({ status: 'succeeded', created: dayS('2026-07-01') })]), { link: null, notes: [], entries: [] });
  assert.equal(notesFor(row(), { payments: [], forms: FORMS }).form?.id, 'form_home');
});

// ── The whole run: the card, and a person pressing Send ─────────────────────────────────────────────────────────────────

const SEND = NOW + 15 * MIN;

test('the fund\'s check finds the donor\'s Due DAF gift: its card shows it, and Send gives Zeffy no second record', async () => {
  world().payments.push(daf());
  await posted();
  const r = await rowOf();
  assert.deepEqual({ state: r.state, reason: r.reason, posts: sitePosts().length }, { state: 'person', reason: 'maybe-double', posts: 0 }, `the check is "${r.state}" (${r.reason})`);
  assert.ok(JSON.parse(r.note).some((e) => e.id === 'zp_daf'), 'the DAF gift is the entry the person is shown');
  assert.ok(JSON.parse(r.card).entries.some((e) => e.id === 'zp_daf'));
  assert.ok((await card()).candidates.some((e) => e.id === 'zp_daf'), 'beside "This is the check"');
  // Send as the card is: refused, with the entry to look at
  await assert.rejects(approve(undefined, { now: SEND }), (e) => e.status === 409 && e.entries?.some((x) => x.id === 'zp_daf'));
  assert.equal(sitePosts().length, 0);
  // Only a person looking right at it and saying it's another gift sends a new record
  await approve(undefined, { now: SEND + MIN, notThose: true, shown: ['zp_daf'] });
  assert.equal(sitePosts().length, 1);
});

test('a DAF gift already marked paid last month holds the check the same way', async () => {
  world().payments.push(daf({ status: 'succeeded', created: dayS('2026-10-20') }));
  await posted();
  const r = await rowOf();
  assert.deepEqual({ state: r.state, reason: r.reason, posts: sitePosts().length }, { state: 'person', reason: 'maybe-double', posts: 0 });
  await assert.rejects(approve(undefined, { now: SEND }), (e) => e.status === 409 && e.entries?.some((x) => x.id === 'zp_daf'));
  assert.equal(sitePosts().length, 0);
});

test('control: with no DAF gift, or only a paid one from last spring, the same check\'s card is ready and Send puts it in Zeffy', async () => {
  await posted();
  assert.deepEqual({ state: (await rowOf()).state, reason: (await rowOf()).reason }, { state: 'person', reason: 'ready' });
  await approve(undefined, { now: SEND });
  assert.deepEqual({ state: (await rowOf()).state, posts: sitePosts().length }, { state: 'created', posts: 1 });
  await setup();
  world().payments.push(daf({ status: 'succeeded', created: dayS('2026-07-01') }));
  await posted();
  assert.equal((await rowOf()).reason, 'ready');
  await approve(undefined, { now: SEND });
  assert.deepEqual({ state: (await rowOf()).state, posts: sitePosts().length }, { state: 'created', posts: 1 });
});
