/**
 * A check deposited in Mercury becomes its Zeffy record (functions/api/_check-gifts.js)
 * Names and amounts are made up; the patterns are the real ones: a monthly giver, several checks of the
 * same amount, a foundation "c/o" someone, a donor's pay-by-check promise.
 * Run: node --test tests/check-gifts.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { mirrorTransaction } from '../functions/api/_mercury-txns.js';
import { readZeffyConfig } from '../functions/api/_zeffy.js';
import {
  hasAccountDigits, safeText, safeMemo, payerKey, sameGiver, proveRead, matchZeffy, judge, pickForm, nameParts, recordDay, recordFor, mercuryPayer,
  runChecks, maybeRunChecks, testWrite, checksView, checksFacts, setMode, personCreate, personLink, personUnlink, personNotGift, personIsGift, ensureChecks, WRITE_TEST,
} from '../functions/api/_check-gifts.js';
import { readState, writeState } from '../functions/api/_mercury.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';

const NOW = Date.parse('2026-11-10T16:00:00Z');
const MIN = 60e3;
const DAY = 86400e3;
const S = (ms) => Math.floor(ms / 1000);
const dayS = (d) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);
const ACCOUNT = '121000248 4815162342';

const hand = (o = {}) => ({
  id: 'zp_hand', object: 'payment', created: dayS('2026-11-04'), amount: 1000000, currency: 'usd', status: 'succeeded', type: 'manual', refund_status: 'none', refunds: [],
  description: 'Help Build a Brighter Home', contact: 'contact_1', payment_method: { type: 'cheque', brand: null, last4: null },
  buyer: { email: null, first_name: 'Pine', last_name: 'Foundation', is_corporate: false, company_name: null, address: null }, campaign_id: 'form_home', receipt_url: null, metadata: {}, ...o,
});
const FORMS = [{ id: 'form_home', title: 'Help Build a Brighter Home' }, { id: 'form_grant', title: 'Grant Funding 2026' }, { id: 'form_jack', title: 'Help Build Sam\'s Bedroom Therapy Room!' }];
const row = (o = {}) => ({ id: 'tx1', cents: 1000000, payer: 'Pine Foundation', memo: '', check_date: '2026-11-03', deposited_at: '2026-11-05T15:00:00Z', ...o });
const read = (o = {}) => ({ payer: 'Pine Foundation', remitter: '', cashiersCheck: false, payee: 'Sunshine On A Ranney Day', date: '2026-11-03', amount: 10000, checkNumber: '1042', memo: '', ...o });

// ── The bank number never gets through ───────────────────────────────────

test('a routing or account number never survives, however it is spaced', () => {
  for (const s of ['121000248', '1210 00248', '121-000-248', '⑆121000248⑆ 4815162342⑈ 1042', ACCOUNT, 'Acct: 48 15 16 23 42', 'memo 4815162342', '121,000,248', '121/000/248', '48*15*16*23*42', '１２１０００２４８']) assert.equal(hasAccountDigits(s), true, s);
  assert.equal(safeText('Pine 121000248 Foundation'), '');
  assert.equal(safeText('Acct 4815162342'), '');
});
test('a memo keeps its words when its numbers go, so a refund or an event is still seen', () => {
  assert.equal(safeMemo('Refund claim 20261104'), 'Refund claim');
  assert.equal(safeMemo('Gala table 11-14-2026'), 'Gala table');
  assert.equal(judge(row({ memo: safeMemo('Refund claim 20261104') }), { forms: FORMS }).reason, 'refund');
  assert.equal(judge(row({ memo: safeMemo('Gala table 11-14-2026') }), { forms: FORMS }).reason, 'event');
  assert.equal(safeMemo(ACCOUNT), '');
});
test('ordinary words and short numbers pass, and so does this check\'s own number', () => {
  assert.equal(hasAccountDigits('Suite 200'), false);
  assert.equal(hasAccountDigits('11/04/2026'), false, 'a date on a memo line');
  assert.equal(hasAccountDigits('Check 100423', '100423'), false);
  assert.equal(hasAccountDigits('Check 100423', '100424'), true);
  assert.equal(safeText('  Pine   Foundation '), 'Pine Foundation');
});

// ── Who wrote it ─────────────────────────────────────────────────────────

test('a name is compared the way staff type it', () => {
  assert.equal(payerKey('The Pine Family Foundation, Inc.'), 'pine family foundation');
  assert.equal(payerKey('Pine Foundation c/o Dana Whitlock'), 'pine foundation');
  assert.equal(payerKey('Pine Foundation c o Dana Whitlock'), 'pine foundation');
  assert.equal(payerKey('Lakeside Builders LLC Lakeside Builders LLC'), 'lakeside builders', 'a name typed in both boxes');
  assert.equal(payerKey('Ace & Sons'), 'ace sons');
  assert.ok(sameGiver('Oakline Design Build', 'Oakline'));
  assert.ok(sameGiver('Tom and Ann Kessler Foundation c o Dana Whitlock', 'Tom and Ann Kessler Foundation'));
  assert.ok(sameGiver('R. Vance', 'Rosalind Vance'));
  assert.ok(sameGiver('John A Smith', 'John Smith'));
  assert.ok(!sameGiver('John Smith', 'Mary Smith'));
  assert.ok(!sameGiver('Pine Foundation', 'Oak Foundation'));
  assert.ok(!sameGiver('', 'Oak'));
});
test('Mercury\'s own name counts only when it is a name', () => {
  assert.equal(mercuryPayer({ counterpartyName: 'Check' }), '');
  assert.equal(mercuryPayer({ counterpartyName: 'Mobile Check Deposit' }), '');
  assert.equal(mercuryPayer({ counterpartyName: 'Pine Foundation' }), 'Pine Foundation');
  assert.equal(mercuryPayer({ counterpartyName: '' }), '');
});

// ── Reading the picture ──────────────────────────────────────────────────

const proof = (a, b, o = {}) => proveRead([a, b], { cents: 1000000, checkNumber: '1042', ...o });
test('a check is proven when both readers agree and the amount and number are Mercury\'s', () => {
  assert.deepEqual(proof(read(), read()), { ok: true, payer: 'Pine Foundation', date: '2026-11-03', memo: '' });
  assert.equal(proof(read({ payer: 'Pine Family Foundation' }), read({ payer: 'Pine Family Foundation Inc' })).payer, 'Pine Family Foundation Inc');
  assert.equal(proof(read({ amount: 1000 }), read()).ok, true, 'one reader may misread the amount');
});
test('it is not proven when the readers disagree, or the picture is another check', () => {
  assert.equal(proof(read(), read({ payer: 'Oak Trust' })).ok, false);
  assert.equal(proof(read({ amount: 5 }), read({ amount: 5 })).ok, false, 'another amount is another check');
  assert.equal(proof(read({ checkNumber: '999' }), read({ checkNumber: '999' })).ok, false, 'another number is another check');
  assert.equal(proveRead([read(), null], { cents: 1000000, checkNumber: '1042' }).ok, false, 'one reader is not two');
  assert.equal(proveRead([null, null], { cents: 1000000 }).ok, false);
});
test('a name in capitals goes in as a name, and two memos saying the same thing are one', () => {
  assert.equal(proof(read({ payer: 'DANA R. WHITFIELD' }), read({ payer: 'DANA R. WHITFIELD' })).payer, 'Dana R. Whitfield');
  assert.equal(proof(read({ payer: 'THE PINE RIDGE FAMILY FOUNDATION' }), read({ payer: 'THE PINE RIDGE FAMILY FOUNDATION' })).payer, 'The Pine Ridge Family Foundation');
  assert.equal(proof(read({ payer: 'ACME HOLDINGS LLC' }), read({ payer: 'ACME HOLDINGS LLC' })).payer, 'Acme Holdings LLC');
  assert.equal(proof(read({ payer: 'Dana McKay' }), read({ payer: 'Dana McKay' })).payer, 'Dana McKay', 'a name already in mixed case is left alone');
  assert.equal(proof(read({ memo: '2026 general grant, Inv 4471' }), read({ memo: 'RE: 2026 general grant, Inv 4471' })).memo, 'RE: 2026 general grant, Inv 4471');
  assert.equal(proof(read({ memo: 'gala' }), read({ memo: 'golf' })).memo, 'gala / golf', 'different readings are both kept');
});
test('readers that took the payee for the payer prove nothing', () => {
  const own = read({ payer: 'Sunshine On A Ranney Day' });
  assert.equal(proof(own, own).ok, false);
});
test('a date only one reader sees is not used', () => {
  assert.equal(proof(read({ date: '2026-11-14' }), read()).date, '');
  assert.equal(proof(read({ date: 'soon' }), read({ date: 'soon' })).date, '');
});
test('on a cashier\'s check the giver is the remitter, and the bank never is', () => {
  const c = read({ payer: 'Truist Bank', cashiersCheck: true, remitter: 'Dana Lee' });
  assert.equal(proof(c, c).payer, 'Dana Lee');
  const none = read({ payer: 'Truist Bank', cashiersCheck: true, remitter: '' });
  assert.equal(proof(none, none).ok, false);
});
test('a model that copies the account number loses that field, never the rest of the safety', () => {
  const r = proof(read({ memo: `acct ${ACCOUNT}` }), read({ memo: ACCOUNT }));
  assert.equal(r.ok, true);
  assert.equal(r.memo, 'acct');
  assert.equal(proof(read({ payer: ACCOUNT }), read({ payer: ACCOUNT })).ok, false);
});
test('Mercury naming the payer stands in for the readers, and a wrong picture never adds to it', () => {
  assert.equal(proveRead([read({ amount: 5 }), read({ amount: 5 })], { cents: 1000000, hint: 'Pine Foundation' }).ok, true);
  assert.equal(proveRead([read({ amount: 5, memo: 'gala' }), read({ amount: 5, memo: 'gala' })], { cents: 1000000, hint: 'Pine Foundation' }).memo, '');
  assert.equal(proveRead([read({ payer: 'x', memo: 'hi' }), read({ payer: 'y', memo: 'hi' })], { cents: 1000000, checkNumber: '1042', hint: 'Pine Foundation' }).memo, 'hi');
});

// ── Is it in Zeffy already? ──────────────────────────────────────────────

test('a hand entry from this giver for this amount is this check', () => {
  const m = matchZeffy(row(), [hand()]);
  assert.equal(m.same.length, 1);
});
test('five $10,000 checks: amount alone never matches', () => {
  const others = ['Oak Trust', 'Elm Fund', 'Yardstick Inc', 'Ash Foundation'].map((n, i) => hand({ id: `z${i}`, created: dayS('2026-10-20'), buyer: { first_name: n, last_name: '' } }));
  const m = matchZeffy(row(), others);
  assert.equal(m.same.length, 0);
  assert.equal(m.maybe.length, 0, 'dated before the check was written, and another name: not this check');
});
test('the same amount under another name, dated with the check, is asked about', () => {
  const m = matchZeffy(row(), [hand({ buyer: { first_name: 'Oak', last_name: 'Trust' } })]);
  assert.equal(m.maybe.length, 1);
  assert.equal(judge(row(), { payments: [hand({ buyer: { first_name: 'Oak', last_name: 'Trust' } })], forms: FORMS }).reason, 'maybe-double');
});
test('a monthly giver\'s last check is not this one', () => {
  const r = row({ cents: 50000, payer: 'Dana Lee', check_date: '2026-11-01' });
  const last = hand({ amount: 50000, created: dayS('2026-10-01'), buyer: { first_name: 'Dana', last_name: 'Lee' } });
  assert.equal(matchZeffy(r, [last]).same.length, 0);
  assert.equal(judge(r, { payments: [last], forms: FORMS }).do, 'create');
});
test('a record another check claimed is out, so one entry can never stand for two checks', () => {
  assert.equal(matchZeffy(row(), [hand()], new Set(['zp_hand'])).same.length, 0);
});
test('two checks and two entries from one giver: each takes the nearest', () => {
  const near = hand({ id: 'near', created: dayS('2026-11-04') });
  const far = hand({ id: 'far', created: dayS('2026-10-25') });
  assert.equal(matchZeffy(row(), [far, near]).same[0].id, 'near');
});
test('a donor\'s pay-by-check from long before is asked about: it may be this check, or a gift already banked', () => {
  const promise = hand({ type: 'online', created: dayS('2026-09-01') });
  const m = matchZeffy(row(), [promise]);
  assert.equal(m.same.length, 0);
  assert.equal(m.maybe.length, 1);
  assert.equal(judge(row(), { payments: [promise], forms: FORMS }).reason, 'maybe-double');
});
test('a recent pay-by-check from the same giver links by itself', () => {
  assert.equal(matchZeffy(row(), [hand({ type: 'online', created: dayS('2026-10-28') })]).same.length, 1);
});
test('a hand entry made weeks after an old-dated check, near the deposit, is still this check', () => {
  const r = row({ check_date: '2026-10-08', deposited_at: '2026-11-05T15:00:00Z' });
  assert.equal(matchZeffy(r, [hand({ created: dayS('2026-11-05') })]).same.length, 1);
});
test('no date read: the giver\'s older entry is asked about, not missed', () => {
  const r = row({ check_date: null, deposited_at: '2026-11-25T15:00:00Z' });
  assert.equal(matchZeffy(r, [hand({ created: dayS('2026-11-01') })]).maybe.length, 1);
});
test('a promise under another name is asked about at any age Zeffy is read', () => {
  const promise = hand({ type: 'online', status: 'pending', created: dayS('2026-10-14'), buyer: { first_name: 'Dana', last_name: 'Whitlock' } });
  assert.equal(judge(row(), { payments: [promise], forms: FORMS }).reason, 'maybe-double');
});
test('an online card gift of the same amount from the same giver is another gift', () => {
  const card = hand({ type: 'online', payment_method: { type: 'card', brand: 'visa', last4: '4242' } });
  assert.equal(matchZeffy(row(), [card]).same.length, 0);
  assert.equal(judge(row(), { payments: [card], forms: FORMS }).do, 'create');
});
test('an unpaid pledge from this giver waits for a person', () => {
  const pledge = hand({ status: 'pending', type: 'manual', created: dayS('2026-08-01') });
  assert.equal(judge(row(), { payments: [pledge], forms: FORMS }).reason, 'pledge');
});
test('this giver for another amount around this date waits for a person', () => {
  assert.equal(judge(row(), { payments: [hand({ amount: 400000 })], forms: FORMS }).reason, 'amount-differs');
});
test('a refunded entry is not this check', () => {
  assert.equal(matchZeffy(row(), [hand({ refund_status: 'full' })]).same.length, 0);
});
test('a check whose payer nobody could read can only be a maybe', () => {
  assert.equal(matchZeffy(row({ payer: '' }), [hand()]).maybe.length, 1);
});

// ── What this check is ───────────────────────────────────────────────────

test('a first-time giver goes straight in, with no click', () => {
  const v = judge(row({ payer: 'Dana Lee' }), { forms: FORMS });
  assert.equal(v.do, 'create');
  assert.equal(v.form.id, 'form_home');
});
test('not gifts are left out without asking anyone', () => {
  assert.deepEqual(judge(row({ payer: 'Sunshine On A Ranney Day Inc' }), { forms: FORMS }), { do: 'left-out', reason: 'own' });
  assert.equal(judge(row({ memo: 'Refund for invoice 88' }), { forms: FORMS }).reason, 'refund');
  assert.equal(judge(row({ memo: 'Reimbursement' }), { forms: FORMS }).reason, 'refund');
  assert.equal(judge(row({ payer: 'State Farm Insurance' }), { forms: FORMS }).reason, 'not-a-giver');
  assert.equal(judge(row({ payer: 'Internal Revenue Service' }), { forms: FORMS }).reason, 'not-a-giver');
  assert.equal(judge(row({ payer: 'Georgia Department of Revenue' }), { forms: FORMS }).reason, 'not-a-giver');
});
test('an insurance company\'s foundation is a giver', () => {
  assert.equal(judge(row({ payer: 'State Farm Foundation' }), { forms: FORMS }).do, 'create');
});
test('event money goes to a person: Zeffy takes tickets and auctions only by hand', () => {
  for (const memo of ['Golf sponsor', 'Gala table', 'Auction item', 'Foursome', 'Advisory board']) assert.equal(judge(row({ memo }), { forms: FORMS }).reason, 'event', memo);
});
test('a company SOARD pays: a blank check is a person, a donation says so', () => {
  assert.equal(judge(row({ payer: 'Brightwell' }), { forms: FORMS, isVendor: true }).reason, 'vendor');
  assert.equal(judge(row({ payer: 'Brightwell', memo: 'Match Gift' }), { forms: FORMS, isVendor: true }).do, 'create');
});
test('a hand entry settles it, whatever the memo says', () => {
  assert.equal(judge(row({ memo: 'Golf sponsor' }), { payments: [hand()], forms: FORMS }).do, 'link');
});
test('a person saying it is a gift is past the memo and the payer, not past a double', () => {
  assert.equal(judge(row({ memo: 'Golf sponsor' }), { forms: FORMS, gift: true }).do, 'create');
  assert.equal(judge(row({ memo: 'refund' }), { payments: [hand({ buyer: { first_name: 'Oak', last_name: 'Trust' } })], forms: FORMS, gift: true }).reason, 'maybe-double');
});
test('no form that fits waits for a person', () => {
  assert.equal(judge(row(), { forms: [] }).reason, 'no-form');
});

test('the form comes from what the site knows, with no question', () => {
  assert.equal(pickForm(row({ payer: 'Dana Lee' }), FORMS).id, 'form_home');
  assert.equal(pickForm(row({ payer: 'Pine Family Foundation' }), FORMS).id, 'form_grant');
  assert.equal(pickForm(row({ payer: 'Maple Hollow Family Fund' }), FORMS).id, 'form_grant');
  assert.equal(pickForm(row({ payer: 'Dana Lee', memo: 'For Sam' }), FORMS).id, 'form_jack');
  assert.equal(pickForm(row({ payer: 'Dana Lee', memo: 'for the home' }), FORMS).id, 'form_home', 'a word in many titles says nothing');
  assert.equal(pickForm(row({ payer: 'Dana Lee' }), FORMS, { campaign_id: 'form_jack' }).id, 'form_jack', 'where this giver\'s last check went');
  assert.equal(pickForm(row({ payer: 'Dana Lee' }), FORMS, { campaign_id: 'closed_form' }).id, 'form_home', 'a closed form is never picked');
  assert.equal(pickForm(row({ payer: 'Pine Foundation' }), [...FORMS, { id: 'g27', title: 'Grant Funding 2027' }]).id, 'g27', 'the newest year');
});

// ── The record ───────────────────────────────────────────────────────────

test('nothing the site sends can reach a donor', () => {
  for (const email of [null, 'dana@example.com']) {
    const r = recordFor(row(), { name: 'Pine Foundation', form: FORMS[0], email });
    assert.equal(r.generate_tax_receipt, false);
    assert.equal(r.send_confirmation_email, false);
  }
});
test('the record says what the check says', () => {
  const r = recordFor(row(), { name: 'Pine Family Foundation', form: FORMS[1] });
  assert.equal(r.campaign_id, 'form_grant');
  assert.equal(r.amount, 1000000);
  assert.equal(r.payment_method, 'cheque');
  assert.equal(r.first_name, 'Pine Family');
  assert.equal(r.last_name, 'Foundation');
  assert.equal(r.payment_date, '2026-11-03T17:00:00.000Z');
  assert.equal('email' in r, false);
});
test('a one-word name fills both boxes', () => assert.deepEqual(nameParts('Brightwell'), { first_name: 'Brightwell', last_name: 'Brightwell' }));
test('the date is the one on the check, within reason', () => {
  assert.equal(recordDay({ check_date: '2025-12-30', deposited_at: '2026-01-05T15:00:00Z' }), '2025-12-30', 'a December gift deposited in January stays in December');
  assert.equal(recordDay({ check_date: '2026-11-20', deposited_at: '2026-11-05T15:00:00Z' }), '2026-11-05', 'never after the deposit');
  assert.equal(recordDay({ check_date: '2026-01-02', deposited_at: '2026-11-05T15:00:00Z' }), '2026-11-05', 'a misread year');
  assert.equal(recordDay({ check_date: null, deposited_at: '2026-11-05T15:00:00Z' }), '2026-11-05');
});

// ── The whole path, against a pretend Mercury, Zeffy, Slack and two models ──

const realFetch = globalThis.fetch;
let world;
let env;
const TX = 'tx_1';
const txn = (o = {}) => ({
  id: TX, accountId: 'acct_check', kind: 'checkDeposit', status: 'pending', amount: 10000, counterpartyName: 'Check', createdAt: '2026-11-05T15:00:00Z', postedAt: null,
  checkNumber: '1042', dashboardLink: 'https://app.mercury.com/transactions/tx_1', attachments: [{ fileName: 'front.jpg', url: 'https://files.mercury.test/front.jpg', attachmentType: 'checkImage' }], relatedTransactions: [], ...o,
});
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 217]);

function freshWorld() {
  return {
    txns: { [TX]: txn() }, payments: [], forms: [
      { id: 'form_home', type: 'donation_form', status: 'active', title: 'Help Build a Brighter Home' },
      { id: 'form_grant', type: 'donation_form', status: 'active', title: 'Grant Funding 2026' },
      { id: 'form_golf', type: 'ticketing', status: 'active', title: 'Fairway 2026' },
    ],
    posts: [], deletes: [], slack: [], contacts: {}, patches: [], patchFails: null, postFails: null, deleteFails: false, picture: JPEG, aiCalls: 0, aiThrow: null, reading: read(), nextId: 1,
  };
}
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const fakeFetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method || 'GET';
  if (url.hostname === 'files.mercury.test') return new Response(world.picture, { status: 200 });
  if (url.hostname.startsWith('mercury-relay')) {
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    return world.txns[id] ? json(world.txns[id]) : json({}, 404);
  }
  if (url.hostname === 'api.zeffy.com') {
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/campaigns') return json({ data: world.forms, has_more: false });
    if (path === '/payments' && method === 'GET') return json({ data: world.payments.filter((p) => p.created >= Number(url.searchParams.get('created[gte]') || 0)), has_more: false });
    if (path === '/payments' && method === 'POST') {
      const body = JSON.parse(init.body);
      world.posts.push(body);
      if (world.postFails === 'timeout') throw new DOMException('timed out', 'TimeoutError');
      if (world.postFails === 'saved-then-lost') {
        world.payments.push(hand({ id: `zeffy_pay_${world.nextId++}`, amount: body.amount, campaign_id: body.campaign_id, type: 'manual', buyer: { first_name: body.first_name, last_name: body.last_name }, created: dayS(body.payment_date.slice(0, 10)) }));
        throw new DOMException('timed out', 'TimeoutError');
      }
      if (world.postFails === 422) return json({ error: { code: 'amount_out_of_range', message: 'Amount is too high' } }, 422);
      if (world.postFails === 429) return json({ error: { code: 'rate_limit_exceeded', message: 'Slow down' } }, 429);
      // Zeffy files a record under the contact holding its email, or makes a new one
      const owner = body.email ? Object.values(world.contacts).find((c) => c.email && c.email.toLowerCase() === body.email.toLowerCase()) : null;
      const p = hand({ id: `zeffy_pay_${world.nextId++}`, amount: body.amount, campaign_id: body.campaign_id, contact: owner ? owner.id : `contact_${world.nextId}`, description: world.forms.find((f) => f.id === body.campaign_id)?.title, buyer: { first_name: body.first_name, last_name: body.last_name, email: body.email || null }, created: dayS(body.payment_date?.slice(0, 10) || '2026-11-10') });
      world.payments.push(p);
      return json(p, 201);
    }
    const one = path.match(/^\/payments\/(.+)$/);
    if (one && method === 'GET') { const p = world.payments.find((x) => x.id === one[1]); return p ? json(p) : json({ error: { message: 'no' } }, 404); }
    if (one && method === 'DELETE') {
      if (world.deleteFails) return json({ error: { message: 'Not allowed' } }, 403);
      world.deletes.push(one[1]);
      world.payments = world.payments.filter((x) => x.id !== one[1]);
      return json({});
    }
    if (path === '/contacts' && method === 'POST') {
      const b = JSON.parse(init.body);
      const id = `ct_${world.nextId++}`;
      world.contacts[id] = { id, email: b.email || null, first_name: b.first_name, last_name: b.last_name, donation_count: 0 };
      return json(world.contacts[id], 201);
    }
    const contact = path.match(/^\/contacts\/(.+)$/);
    if (contact && method === 'GET') return json(world.contacts[contact[1]] || {}, world.contacts[contact[1]] ? 200 : 404);
    if (contact && method === 'PATCH') {
      const b = JSON.parse(init.body);
      world.patches.push({ id: contact[1], email: b.email });
      const f = world.patchFails;
      if (f === 'timeout-after-set' && b.email) { if (world.contacts[contact[1]]) world.contacts[contact[1]].email = b.email; throw new DOMException('timed out', 'TimeoutError'); }
      if (f === 'all' || (f === 'clear' && b.email === null) || (f === 'set' && b.email)) return json({ error: { code: 'invalid_email', message: 'Email is not valid' } }, 422);
      if (!world.contacts[contact[1]]) return json({ error: { message: 'no' } }, 404);
      Object.assign(world.contacts[contact[1]], b);
      return json(world.contacts[contact[1]]);
    }
    if (contact && method === 'DELETE') { delete world.contacts[contact[1]]; return json({}); }
  }
  if (url.hostname === 'slack.com') { world.slack.push(String(init.body || '')); return json({ ok: true, ts: '1.1', channel: 'C1' }); }
  throw new Error(`Unexpected fetch ${url}`);
};
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });

async function deposit(t = world.txns[TX]) { await mirrorTransaction(env.DB, t, { now: NOW }); }
const run = (now = NOW, o = {}) => runChecks(env, { now, fetchImpl: fakeFetch, ...o });
const theRow = () => env.DB.prepare('SELECT * FROM check_gifts WHERE id = ?').bind(TX).first();
const post = () => { world.txns[TX] = { ...world.txns[TX], status: 'sent', postedAt: '2026-11-07T15:00:00Z' }; };
const passedTest = () => writeState(env.DB, 'check-gifts', { writeTest: { id: WRITE_TEST, ok: true } });
/** Read, then decide, the way two heartbeats would */
async function throughRead(now = NOW) { await run(now); return theRow(); }
async function posted(now = NOW) { await throughRead(now); post(); return run(now + 10 * MIN); }

beforeEach(async () => {
  world = freshWorld();
  const DB = await createD1();
  env = {
    DB, MERCURY_API_TOKEN: 'm', MERCURY_RELAY_KEY: 'r', ZEFFY_API_KEY: 'z', SLACK_BOT_TOKEN: 'xoxb',
    AI: { run: async () => { world.aiCalls++; if (world.aiThrow) throw world.aiThrow; return { response: world.reading }; } },
  };
  await ensureChecks(DB);
  await DB.prepare('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)').run();
  await writeSlackConfig(DB, { attention: { id: 'C_ALERTS', name: 'website-alerts', private: false } });
  await passedTest();
  await deposit();
});

test('a deposit gets a row and is read while Mercury still holds it, and nothing happens until it posts', async () => {
  const r = await throughRead();
  assert.equal(r.state, 'read');
  assert.equal(r.payer, 'Pine Foundation');
  assert.equal(r.check_date, '2026-11-03');
  assert.equal(world.aiCalls, 2, 'two readers');
  await run(NOW + 10 * MIN);
  assert.equal(world.posts.length, 0);
});
test('Watch never writes to Zeffy: it says what it would do', async () => {
  await posted();
  assert.equal((await theRow()).state, 'would');
  assert.equal((await theRow()).form_title, 'Grant Funding 2026');
  assert.equal(world.posts.length, 0);
});
test('a hand entry links itself in Watch, is scored, and teaches who that payer is', async () => {
  // Zeffy's contact for the entry carries the payer's own name, so it's theirs to learn
  world.contacts.contact_1 = { id: 'contact_1', email: null, first_name: 'Pine', last_name: 'Foundation' };
  await posted();
  world.payments.push(hand({ campaign_id: 'form_grant', description: 'Grant Funding 2026' }));
  await run(NOW + 90 * MIN);
  const r = await theRow();
  assert.equal(r.state, 'linked');
  assert.equal(r.zeffy_id, 'zp_hand');
  assert.deepEqual(JSON.parse(r.score), { payer: true, form: true, gift: true });
  const v = await checksView(env);
  assert.deepEqual(v.scored, { total: 1, right: 1 });
  const p = await env.DB.prepare('SELECT * FROM check_payers').first();
  assert.equal(p.contact_id, 'contact_1');
  assert.equal(p.campaign_id, 'form_grant');
});
test('a score counts a wrong form as wrong', async () => {
  await posted();
  world.payments.push(hand({ campaign_id: 'form_home' }));
  await run(NOW + 90 * MIN);
  assert.deepEqual((await checksView(env)).scored, { total: 1, right: 0 });
});
test('On: the record is made once, on the right form, with nothing sent to the donor, and Slack hears it', async () => {
  await setMode(env, 'on', { by: 'peter@soardcharity.com' });
  await posted();
  const r = await theRow();
  assert.equal(r.state, 'created');
  assert.equal(world.posts.length, 1);
  assert.equal(world.posts[0].generate_tax_receipt, false);
  assert.equal(world.posts[0].send_confirmation_email, false);
  assert.equal(world.posts[0].campaign_id, 'form_grant');
  assert.equal(r.zeffy_id, 'zeffy_pay_1');
  assert.equal(world.slack.length, 1, 'the gift alert');
  await run(NOW + 20 * MIN);
  await run(NOW + 30 * MIN);
  await run(NOW + 90 * MIN);
  assert.equal(world.posts.length, 1, 'never again');
});
test('On: a giver learned earlier lands on their own donor record, still with nothing sent', async () => {
  await env.DB.prepare('INSERT INTO check_payers (key, name, contact_id, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?)').bind('pine foundation', 'Pine Foundation', 'c_pine', 'form_home', 'x').run();
  world.contacts.c_pine = { id: 'c_pine', email: 'pine@example.com' };
  await setMode(env, 'on');
  await posted();
  assert.equal(world.posts[0].email, 'pine@example.com');
  assert.equal(world.posts[0].campaign_id, 'form_home');
  assert.equal(world.posts[0].generate_tax_receipt, false);
});
test('On: an entry already in Zeffy is linked and nothing is made', async () => {
  await setMode(env, 'on');
  world.payments.push(hand());
  await posted();
  assert.equal((await theRow()).state, 'linked');
  assert.equal(world.posts.length, 0);
});
test('On: a POST with no answer is looked for, found, and never sent twice', async () => {
  await setMode(env, 'on');
  world.postFails = 'saved-then-lost';
  await posted();
  assert.equal((await theRow()).state, 'unsure');
  world.postFails = null;
  await run(NOW + 20 * MIN);
  const r = await theRow();
  assert.equal(r.state, 'created');
  assert.equal(r.zeffy_id, 'zeffy_pay_1');
  assert.equal(world.posts.length, 1);
  assert.equal(world.payments.length, 1);
});
test('On: a POST that never saved goes to a person, and is not sent again', async () => {
  await setMode(env, 'on');
  world.postFails = 'timeout';
  await posted();
  world.postFails = null;
  await run(NOW + 20 * MIN);
  assert.equal((await theRow()).state, 'unsure', 'Zeffy gets time to show it');
  await run(NOW + 60 * MIN);
  const r = await theRow();
  assert.equal(r.state, 'person');
  assert.equal(r.reason, 'unsure');
  assert.equal(world.posts.length, 1);
});
test('On: a run cut off mid-POST is treated the same as no answer', async () => {
  await setMode(env, 'on');
  await throughRead();
  post();
  await run(NOW + MIN); // now Mercury says sent
  await env.DB.prepare(`UPDATE check_gifts SET state = 'creating', payload = ?, updated_at = ?, zeffy_id = NULL WHERE id = ?`).bind(JSON.stringify({ campaign_id: 'form_grant', first_name: 'Pine', last_name: 'Foundation' }), new Date(NOW).toISOString(), TX).run();
  world.posts = [];
  world.payments = [];
  await run(NOW + 10 * MIN);
  assert.equal((await theRow()).state, 'unsure');
  await run(NOW + 60 * MIN);
  assert.equal((await theRow()).state, 'person');
  assert.equal(world.posts.length, 0);
});
test('On: Zeffy refusing is a person, told why in plain words', async () => {
  await setMode(env, 'on');
  world.postFails = 422;
  await posted();
  const r = await theRow();
  assert.equal(r.state, 'person');
  assert.equal(r.reason, 'zeffy-refused');
  assert.equal(r.note, 'Zeffy wouldn’t take this amount.');
  assert.equal(r.payload, null);
});
test('On: Zeffy saying "slow down" waits a quarter hour at the back of the line', async () => {
  await setMode(env, 'on');
  world.postFails = 429;
  await posted();
  assert.equal((await theRow()).state, 'read');
  world.postFails = null;
  await run(NOW + 20 * MIN);
  assert.equal((await theRow()).state, 'read', 'not yet: other checks go first');
  await run(NOW + 30 * MIN);
  assert.equal((await theRow()).state, 'created');
  assert.equal(world.payments.length, 1);
});
test('a check that came back after a record is said out loud, and the site deletes nothing', async () => {
  await setMode(env, 'on');
  await posted();
  world.txns[TX] = { ...world.txns[TX], status: 'failed' };
  world.slack = [];
  await env.DB.prepare('UPDATE check_gifts SET looked_at = NULL WHERE id = ?').bind(TX).run();
  await run(NOW + 2 * DAY);
  const r = await theRow();
  assert.equal(r.state, 'came-back');
  assert.equal(r.final, 1);
  assert.equal(world.deletes.length, 0);
  assert.equal(world.slack.length, 1);
});
test('a return Mercury ties to the deposit counts; a fee tied to it does not', async () => {
  await setMode(env, 'on');
  await posted();
  world.txns[TX] = { ...world.txns[TX], relatedTransactions: [{ id: 'f', relationKind: 'FeePaymentToOriginalTransaction' }] };
  await env.DB.prepare('UPDATE check_gifts SET looked_at = NULL WHERE id = ?').bind(TX).run();
  await run(NOW + 2 * DAY);
  assert.equal((await theRow()).state, 'created');
  world.txns[TX] = { ...world.txns[TX], relatedTransactions: [{ id: 'r', relationKind: 'OriginalTransactionToReturn' }] };
  await env.DB.prepare('UPDATE check_gifts SET looked_at = NULL WHERE id = ?').bind(TX).run();
  await run(NOW + 4 * DAY);
  assert.equal((await theRow()).state, 'came-back');
});
test('a blocked check is told, makes no record, and goes on if Mercury releases it', async () => {
  await throughRead();
  world.txns[TX] = { ...world.txns[TX], status: 'blocked' };
  world.slack = [];
  await run(NOW + 10 * MIN);
  const r = await theRow();
  assert.equal(r.state, 'read', 'a hold, not a check that came back: nobody is told to cancel anything');
  assert.equal(r.final, 0);
  assert.equal(world.slack.length, 1);
  assert.match(world.slack[0], /holding a check/);
  assert.doesNotMatch(world.slack[0], /cancel/i);
  assert.equal(world.posts.length, 0);
  post();
  await setMode(env, 'on');
  await run(NOW + 20 * MIN);
  await run(NOW + 30 * MIN);
  assert.equal((await theRow()).state, 'created');
});
test('a check that fails with no linked record is still told: someone may have entered it', async () => {
  await throughRead();
  world.txns[TX] = { ...world.txns[TX], status: 'failed' };
  world.slack = [];
  await run(NOW + 10 * MIN);
  assert.equal((await theRow()).final, 1);
  assert.equal(world.slack.length, 1);
});
test('a POST with no answer never claims last month\'s gift from the same giver', async () => {
  await setMode(env, 'on');
  world.payments.push(hand({ id: 'zeffy_october', campaign_id: 'form_grant', created: dayS('2026-10-01') }));
  world.postFails = 'timeout';
  await posted();
  world.postFails = null;
  await run(NOW + 20 * MIN);
  await run(NOW + 60 * MIN);
  const r = await theRow();
  assert.equal(r.zeffy_id, null);
  assert.equal(r.state, 'person');
});
test('a post-dated check still finds its hand entry, and a check dated a year off still can\'t reach an old one', () => {
  assert.equal(matchZeffy(row({ check_date: '2026-12-31' }), [hand()]).same.length, 1);
  const lastYear = row({ check_date: '2025-11-01', deposited_at: '2026-11-05T15:00:00Z' });
  assert.equal(matchZeffy(lastYear, [hand({ created: dayS('2026-10-01') })]).same.length, 0);
});
test('with no date read, an entry under another name is reached further back', () => {
  const entry = hand({ created: dayS('2026-10-29'), buyer: { first_name: 'Oak', last_name: 'Trust' } });
  assert.equal(matchZeffy(row({ check_date: null }), [entry]).maybe.length, 1);
  assert.equal(matchZeffy(row(), [entry]).maybe.length, 0);
});
test('next month\'s entry from a monthly giver is not this month\'s check', () => {
  const r = row({ cents: 50000, payer: 'Dana Lee', check_date: '2026-10-01', deposited_at: '2026-10-03T15:00:00Z' });
  assert.equal(matchZeffy(r, [hand({ amount: 50000, created: dayS('2026-11-01'), buyer: { first_name: 'Dana', last_name: 'Lee' } })]).same.length, 0);
});
test('a donor\'s pay-by-check under another name is asked about, not doubled', () => {
  const promise = hand({ type: 'online', created: dayS('2026-10-25'), buyer: { first_name: 'Dana', last_name: 'Whitlock' } });
  assert.equal(judge(row(), { payments: [promise], forms: FORMS }).reason, 'maybe-double');
});
test('a failed card try is not a pledge', () => {
  const failed = hand({ type: 'online', status: 'failed', payment_method: { type: 'card' } });
  assert.equal(judge(row(), { payments: [failed], forms: FORMS }).do, 'create');
});
test('an entry under another name reaches a person, and no false "isn\'t in Zeffy" goes out', async () => {
  await posted();
  world.slack = [];
  world.payments.push(hand({ id: 'zeffy_other', created: dayS('2026-11-04'), buyer: { first_name: 'Oak', last_name: 'Trust' } }));
  await run(NOW + 12 * DAY);
  const c = (await checksView(env)).list[0];
  assert.equal(c.state, 'person');
  assert.equal(c.candidates[0].id, 'zeffy_other');
  assert.equal(world.slack.length, 0);
  assert.equal((await checksFacts(env.DB)).waiting, 1);
});
test('one check that can\'t be read never holds up the next', async () => {
  world.txns.tx_2 = txn({ id: 'tx_2', createdAt: '2026-11-06T15:00:00Z', status: 'sent', postedAt: '2026-11-06T15:00:00Z' });
  await deposit(world.txns.tx_2);
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET tries = 0 WHERE id = ?`).bind(TX).run();
  delete world.txns[TX];
  await run(NOW + 10 * MIN).catch(() => null);
  await run(NOW + 20 * MIN).catch(() => null);
  const second = await env.DB.prepare(`SELECT state, payer FROM check_gifts WHERE id = 'tx_2'`).first();
  assert.notEqual(second.state, 'new');
});
test('three thrown tries sends a check to a person instead of trying forever', async () => {
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'new', tries = 2, try_at = NULL, status = 'sent' WHERE id = ?`).bind(TX).run();
  await setMode(env, 'on');
  await run(NOW + 10 * MIN, { fetchImpl: async (u, i) => { if (String(u).includes('mercury-relay')) throw Object.assign(new Error('gone'), { status: 404 }); return fakeFetch(u, i); } });
  assert.equal((await theRow()).state, 'person');
});
test('a person\'s "not a gift" stays, even with a matching entry', async () => {
  await posted();
  await personNotGift(env, TX, { by: 'h', now: NOW });
  world.payments.push(hand());
  await run(NOW + 2 * 60 * MIN);
  assert.equal((await theRow()).state, 'left-out');
});
test('a linked pledge says it is still unpaid in Zeffy', async () => {
  await withPerson();
  world.payments.push(hand({ id: 'zeffy_pledge', status: 'pending' }));
  await personLink(env, TX, 'zeffy_pledge', { now: NOW, fetchImpl: fakeFetch });
  assert.match((await checksView(env)).list[0].why, /unpaid/);
});
test('money going back out is looked for even when every check is settled', async () => {
  await posted();
  world.payments.push(hand({ campaign_id: 'form_grant', description: 'Grant Funding 2026' }));
  await run(NOW + 90 * MIN);
  await env.DB.prepare(`UPDATE check_gifts SET state = 'linked' WHERE id = ?`).bind(TX).run();
  await mirrorTransaction(env.DB, txn({ id: 'tx_back', kind: 'other', amount: -10000, status: 'sent', createdAt: '2026-11-09T00:00:00Z', attachments: [] }), { now: NOW });
  world.slack = [];
  await run(NOW + 3 * 60 * MIN);
  assert.equal(world.slack.length, 1);
});
test('Mercury with no posted date never reads as long since final', async () => {
  await run();
  world.txns[TX] = { ...world.txns[TX], status: 'sent', postedAt: null };
  await env.DB.prepare('UPDATE check_gifts SET looked_at = NULL WHERE id = ?').bind(TX).run();
  await run(NOW + 10 * MIN);
  assert.equal((await theRow()).final, 0);
});
test('a corrected amount reaches the row before anything is made', async () => {
  await run();
  world.txns[TX] = { ...world.txns[TX], amount: 9000 };
  await env.DB.prepare('UPDATE check_gifts SET looked_at = NULL WHERE id = ?').bind(TX).run();
  await run(NOW + 10 * MIN);
  assert.equal((await theRow()).cents, 900000);
});
test('Mercury naming SOARD itself as the payer is no payer', () => {
  assert.equal(mercuryPayer({ counterpartyName: 'Sunshine On A Ranney Day' }), '');
});
test('a failed Slack post is tried again at the next look', async () => {
  await setMode(env, 'on');
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'event', status = 'sent' WHERE id = ?`).bind(TX).run();
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).includes('slack.com') ? new Response('{"ok":false,"error":"down"}', { status: 200 }) : real(u, i));
  await run(NOW + 2 * 60 * MIN);
  globalThis.fetch = real;
  assert.equal((await theRow()).alerted, null);
  world.slack = [];
  await run(NOW + 4 * 60 * MIN);
  assert.equal(world.slack.length, 1);
});
test('a status nobody planned for is told, not ignored', async () => {
  await throughRead();
  world.txns[TX] = { ...world.txns[TX], status: 'on-hold-somehow' };
  world.slack = [];
  await run(NOW + 10 * MIN);
  assert.equal(world.slack.length, 1);
  assert.equal((await theRow()).final, 0);
});
test('a check that stays pending for two weeks is told once', async () => {
  await throughRead();
  world.slack = [];
  await run(NOW + 12 * DAY);
  await run(NOW + 13 * DAY);
  assert.equal(world.slack.length, 1);
});
test('a check that posts is kept an eye on for 60 days, then it is final', async () => {
  await posted();
  await env.DB.prepare('UPDATE check_gifts SET looked_at = NULL WHERE id = ?').bind(TX).run();
  await run(NOW + 61 * DAY);
  assert.equal((await theRow()).final, 1);
});
test('a hand entry made after the site\'s record is flagged as a double, once, and neither is touched', async () => {
  await setMode(env, 'on');
  await posted();
  world.slack = [];
  world.payments.push(hand({ id: 'zeffy_late', created: dayS('2026-11-09') }));
  await run(NOW + 2 * 60 * MIN);
  await run(NOW + 4 * 60 * MIN);
  assert.equal(world.slack.length, 1);
  assert.equal(world.deletes.length, 0);
  assert.equal(world.payments.length, 2);
});
test('nobody entered a cleared check in Watch: it is said after 10 days', async () => {
  await posted();
  world.slack = [];
  await run(NOW + 2 * DAY);
  assert.equal(world.slack.length, 0);
  await run(NOW + 12 * DAY);
  assert.equal(world.slack.length, 1);
});
test('a check deposited to the store account is listed and left alone', async () => {
  await env.DB.prepare('DELETE FROM check_gifts').run();
  const { writeConfig } = await import('../functions/api/_spend.js');
  await writeConfig(env.DB, { accountBuckets: { acct_check: 'store' } });
  await run();
  post();
  await run(NOW + 10 * MIN);
  assert.equal((await theRow()).state, 'store');
  assert.equal(world.aiCalls, 0);
  assert.equal(world.posts.length, 0);
});
test('no picture: wait while it is pending, then a person', async () => {
  world.txns[TX] = txn({ attachments: [] });
  await run();
  assert.equal((await theRow()).state, 'new');
  post();
  await env.DB.prepare('UPDATE check_gifts SET try_at = NULL WHERE id = ?').bind(TX).run();
  for (let i = 1; i <= 4; i++) await run(NOW + i * 10 * MIN);
  const r = await theRow();
  assert.equal(r.state, 'person');
  assert.equal(r.reason, 'no-picture');
  assert.equal(world.aiCalls, 0);
});
test('no picture but Mercury names the payer: the check still goes through', async () => {
  world.txns[TX] = txn({ attachments: [], counterpartyName: 'Pine Foundation' });
  await run();
  assert.equal((await theRow()).payer, 'Pine Foundation');
});
test('a picture Workers AI can\'t take is a person, and its kind is noted for us', async () => {
  world.picture = new TextEncoder().encode('%PDF-1.7 not a photo');
  post();
  for (let i = 0; i < 4; i++) await run(NOW + i * 10 * MIN);
  const r = await theRow();
  assert.equal(r.state, 'person');
  assert.equal(r.reason, 'unreadable');
  assert.equal(JSON.parse(r.shape).picture.kind, 'other');
});
test('readers that keep disagreeing use up three tries, then a person', async () => {
  let n = 0;
  env.AI.run = async () => ({ response: read({ payer: n++ % 2 ? 'Pine Foundation' : 'Oak Trust' }) });
  for (let i = 0; i < 5; i++) await run(NOW + i * 10 * MIN);
  assert.equal((await theRow()).state, 'person');
  assert.equal((await theRow()).reason, 'unreadable');
  assert.equal((await theRow()).tries, 3);
});
test('a second picture is tried when the first was the back', async () => {
  world.txns[TX] = txn({ attachments: [{ url: 'https://files.mercury.test/back.jpg', attachmentType: 'checkImage' }, { url: 'https://files.mercury.test/front.jpg', attachmentType: 'checkImage' }] });
  const seen = [];
  const f = async (u, i) => { if (String(u).includes('files.mercury')) seen.push(String(u)); return fakeFetch(u, i); };
  env.AI.run = async () => ({ response: seen.at(-1).includes('back') ? read({ payer: '', amount: 0, checkNumber: '' }) : read() });
  await run(NOW, { fetchImpl: f });
  await run(NOW + 10 * MIN, { fetchImpl: f });
  assert.equal((await theRow()).state, 'read');
});
test('a spending cap costs no try: the check waits for it to lift', async () => {
  world.aiThrow = new Error('2045: Spend limit exceeded');
  await run();
  const r = await theRow();
  assert.equal(r.state, 'new');
  assert.equal(r.tries, 0);
});
test('a run that dies mid-read still counted its try', async () => {
  await env.DB.prepare(`UPDATE check_gifts SET tries = 2 WHERE id = ?`).bind(TX).run().catch(() => {});
  await run(); // pulls the row in
  await env.DB.prepare(`UPDATE check_gifts SET tries = 2, try_at = NULL, state = 'new' WHERE id = ?`).bind(TX).run();
  env.AI.run = async () => ({ response: read({ payer: 'x', amount: 1 }) });
  await run(NOW + 10 * MIN);
  assert.equal((await theRow()).state, 'person');
});
test('a second run while one is reading leaves the check alone', async () => {
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'new', try_at = ?, tries = 1 WHERE id = ?`).bind(new Date(NOW).toISOString(), TX).run();
  const calls = world.aiCalls;
  await run(NOW + MIN);
  assert.equal(world.aiCalls, calls);
});

test('nothing a model said survives except who, when and the memo; no picture, no account number', async () => {
  world.reading = read({ memo: `pay ${ACCOUNT}`, payee: ACCOUNT });
  await posted();
  const r = await theRow();
  const all = JSON.stringify(r);
  assert.equal(all.includes('121000248'), false);
  assert.equal(all.includes('4815162342'), false);
  assert.equal(all.includes('base64'), false);
  assert.equal(all.includes('files.mercury.test'), false);
  const shape = JSON.parse(r.shape);
  assert.equal(shape.pictures, 1);
  assert.equal(shape.counterparty, 'a label');
});

// ── The heartbeat ────────────────────────────────────────────────────────

test('the heartbeat runs every 5 minutes, and only with Mercury and Zeffy connected', async () => {
  assert.equal(await maybeRunChecks({ ...env, ZEFFY_API_KEY: '' }, { now: NOW, fetchImpl: fakeFetch }), null);
  assert.notEqual(await maybeRunChecks(env, { now: NOW, fetchImpl: fakeFetch }), null);
  assert.equal(await maybeRunChecks(env, { now: NOW + MIN, fetchImpl: fakeFetch }), null);
  assert.notEqual(await maybeRunChecks(env, { now: NOW + 6 * MIN, fetchImpl: fakeFetch }), null);
});
test('a run that fails says so, and the next good one clears it', async () => {
  await maybeRunChecks(env, { now: NOW, fetchImpl: async () => { throw new Error('no line'); } });
  assert.match((await checksView(env)).lastError?.error || '', /didn’t answer|unexpected/);
  await maybeRunChecks(env, { now: NOW + 6 * MIN, fetchImpl: fakeFetch });
  assert.equal((await checksView(env)).lastError, null);
});

// ── The one-time write test ──────────────────────────────────────────────

test('the write test makes $1 records, removes them and leaves the switch able to turn on', async () => {
  await writeState(env.DB, 'check-gifts', { writeTest: null });
  const r = await run();
  assert.equal(r.writeTest.ok, true);
  assert.equal(r.writeTest.removed, true);
  assert.equal(world.posts.length, 5, 'three plain ones, one filed under a contact, one with an email');
  assert.equal(world.deletes.length, 5);
  assert.equal(world.payments.length, 0);
  for (const p of world.posts) { assert.equal(p.generate_tax_receipt, false); assert.equal(p.send_confirmation_email, false); }
  for (const p of world.posts.slice(0, 3)) assert.equal('email' in p, false);
  assert.match(world.posts[3].email, /@nomail\.soardcharity\.com$/);
  assert.equal(world.posts[4].email, 'peter+zeffy-write-test@soardcharity.com', 'a SOARD inbox, to see Zeffy sends nothing');
  assert.equal(r.writeTest.join.ok, true);
  assert.equal(r.writeTest.email.saved, true);
  assert.deepEqual(world.contacts, {}, 'the test contact is gone too');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM check_tags').first()).n, 0);
  await setMode(env, 'on');
  assert.equal((await checksView(env)).mode, 'on');
  await run(NOW + 10 * MIN);
  assert.equal(world.posts.length, 5, 'once');
});
test('a new test after one that passed tries only what\'s new: one record filed under a contact, one with an email', async () => {
  await writeState(env.DB, 'check-gifts', { writeTest: { id: '2026-11-06', ok: true, at: '2026-11-07T14:20:00Z', steps: [{ what: 'two names' }], sameContact: false } });
  const r = await run();
  assert.equal(world.posts.length, 2);
  assert.equal(r.writeTest.ok, true);
  assert.equal(r.writeTest.join.ok, true);
  assert.equal(r.writeTest.provenAt, '2026-11-07T14:20:00Z');
  assert.equal(world.deletes.length, 2);
});
test('if Zeffy won\'t take the no-mail address, the test still passes and gifts simply get their own contact', async () => {
  await writeState(env.DB, 'check-gifts', { writeTest: null });
  world.patchFails = 'set';
  const r = await run();
  assert.equal(r.writeTest.ok, true);
  assert.equal(r.writeTest.join.ok, false);
  assert.equal('email' in world.posts[3], false, 'it went in plainly');
  await env.DB.prepare('INSERT INTO check_payers (key, name, contact_id, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?)').bind('pine foundation', 'Pine Foundation', 'c_pine', 'form_home', 'x').run();
  world.contacts.c_pine = { id: 'c_pine', email: null, first_name: 'Pine', last_name: 'Foundation' };
  world.posts = []; world.patches = [];
  await setMode(env, 'on');
  await posted(NOW + 10 * MIN);
  assert.equal(world.posts.length, 1);
  assert.equal('email' in world.posts[0], false);
  assert.equal(world.patches.length, 0, 'never touches a donor contact unless the test proved it');
});
test('a write test that fails keeps the switch off and says why', async () => {
  await writeState(env.DB, 'check-gifts', { writeTest: null });
  world.postFails = 422;
  const r = await run();
  assert.equal(r.writeTest.ok, false);
  await assert.rejects(setMode(env, 'on'), /proven/);
});
test('a test record Zeffy won\'t remove asks a person, and stops asking once it\'s gone: the site never needs to delete', async () => {
  await writeState(env.DB, 'check-gifts', { writeTest: null });
  world.deleteFails = true;
  const r = await run();
  assert.equal(r.writeTest.ok, true);
  assert.equal(r.writeTest.removed, false);
  assert.equal(r.writeTest.leftBehind.length, 5);
  await setMode(env, 'on');
  world.payments = [];
  await run(NOW + 2 * 60 * MIN);
  assert.deepEqual((await readState(env.DB, 'check-gifts')).writeTest.leftBehind, []);
});
test('records Zeffy calls imported would skip Slack and the board, so the test fails', async () => {
  const f = async (u, i) => {
    const res = await fakeFetch(u, i);
    if (i?.method === 'POST') { const b = await res.json(); return json({ ...b, type: 'imported' }, 201); }
    return res;
  };
  const r = await testWrite(env, { now: NOW, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.error, /imported/);
  assert.equal(world.deletes.length, 3, 'still cleaned up');
});

// ── A giver Zeffy has no email for keeps one contact ──────────────────────

const joinProven = () => writeState(env.DB, 'check-gifts', { writeTest: { id: WRITE_TEST, ok: true, join: { ok: true } } });
async function noEmailGiver() {
  await env.DB.prepare('INSERT INTO check_payers (key, name, contact_id, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?)').bind('pine foundation', 'Pine Foundation', 'c_pine', 'form_home', 'x').run();
  world.contacts.c_pine = { id: 'c_pine', email: null, first_name: 'Pine', last_name: 'Foundation', donation_count: 3 };
  await joinProven();
  await setMode(env, 'on');
}
const tags = async () => (await env.DB.prepare('SELECT * FROM check_tags').all()).results;

test('a repeat giver with no email: the gift lands on their contact, and the contact is left with no email again', async () => {
  await noEmailGiver();
  await posted();
  const r = await theRow();
  assert.equal(r.state, 'created');
  assert.equal(world.posts.length, 1);
  assert.match(world.posts[0].email, /^check-[a-z0-9]+-[a-z0-9]+@nomail\.soardcharity\.com$/);
  assert.equal(world.posts[0].generate_tax_receipt, false);
  assert.equal(world.posts[0].send_confirmation_email, false);
  assert.equal(world.payments.at(-1).contact, 'c_pine', 'on their own contact');
  assert.equal(world.contacts.c_pine.email, null, 'the address came off');
  assert.deepEqual(world.patches.map((p) => p.email === null ? 'off' : 'on'), ['on', 'off']);
  assert.deepEqual(await tags(), []);
  assert.equal(JSON.parse(r.payload || 'null'), null, 'nothing waiting');
});
test('filed under a contact, the record carries the names staff gave it, not how the check was read', async () => {
  await noEmailGiver();
  world.contacts.c_pine = { ...world.contacts.c_pine, first_name: 'Pine Family', last_name: 'Foundation Inc' };
  await posted();
  assert.equal(world.posts[0].first_name, 'Pine Family');
  assert.equal(world.posts[0].last_name, 'Foundation Inc');
});
test('a giver with an email is filed by it, and their contact is never touched', async () => {
  await noEmailGiver();
  world.contacts.c_pine.email = 'pine@example.com';
  await posted();
  assert.equal(world.posts[0].email, 'pine@example.com');
  assert.equal(world.patches.length, 0);
});
test('a contact deleted in Zeffy since gets nothing done to it: the gift makes a new one', async () => {
  await noEmailGiver();
  delete world.contacts.c_pine;
  await posted();
  assert.equal(world.posts.length, 1);
  assert.equal('email' in world.posts[0], false);
  assert.equal(world.patches.length, 0);
});
test('an address the site couldn\'t take off comes off on a later run, and a day stuck tells a person once', async () => {
  await noEmailGiver();
  world.patchFails = 'clear';
  await posted();
  assert.equal(world.payments.at(-1).contact, 'c_pine', 'the gift itself is right');
  assert.match(world.contacts.c_pine.email, /@nomail\./);
  assert.equal((await tags()).length, 1, 'kept to take off');
  const slackBefore = world.slack.length;
  await run(NOW + 20 * MIN);
  assert.equal((await tags()).length, 1);
  assert.equal(world.slack.length, slackBefore, 'not yet a day');
  await run(NOW + DAY + 20 * MIN);
  await run(NOW + DAY + 30 * MIN);
  const cards = world.slack.slice(slackBefore).filter((b) => /no-mail address/.test(b));
  assert.equal(cards.length, 1, 'said once');
  world.patchFails = null;
  await run(NOW + DAY + 40 * MIN);
  assert.equal(world.contacts.c_pine.email, null);
  assert.deepEqual(await tags(), []);
});
test('an email someone typed on the contact meanwhile stays: only the site\'s own address is ever taken off', async () => {
  await noEmailGiver();
  world.patchFails = 'clear';
  await posted();
  world.contacts.c_pine.email = 'pine@example.com';
  world.patchFails = null;
  const before = world.patches.length;
  await run(NOW + 20 * MIN);
  assert.equal(world.contacts.c_pine.email, 'pine@example.com');
  assert.equal(world.patches.length, before, 'no change sent');
  assert.deepEqual(await tags(), []);
});
test('a record that times out after the address went on: the address stays until it\'s settled, it\'s never sent again, and the record is found by its contact', async () => {
  await noEmailGiver();
  world.postFails = 'saved-then-lost';
  await posted();
  assert.equal((await theRow()).state, 'unsure');
  // Zeffy may still be saving it by that address: taking it off now would file the record on a new contact
  assert.match(world.contacts.c_pine.email, /nomail/);
  // Zeffy kept the names it had for the contact, not the ones read off the check
  world.payments.at(-1).contact = 'c_pine';
  world.payments.at(-1).buyer = { first_name: 'P.', last_name: 'F. Trust' };
  world.postFails = null;
  await run(NOW + 20 * MIN);
  const r = await theRow();
  assert.equal(r.state, 'created');
  assert.equal(world.posts.length, 1, 'never sent again');
  await run(NOW + 30 * MIN);
  assert.equal(world.contacts.c_pine.email, null, 'off once it settled');
  assert.deepEqual(await tags(), []);
});
test('a run cut off with the address on: the next run takes it off', async () => {
  await noEmailGiver();
  world.contacts.c_pine.email = 'check-cut-x@nomail.soardcharity.com';
  await env.DB.prepare('INSERT INTO check_tags (email, contact, at) VALUES (?, ?, ?)').bind('check-cut-x@nomail.soardcharity.com', 'c_pine', new Date(NOW).toISOString()).run();
  // A save may still be using it for a minute or two: it's left to that save
  await run();
  assert.match(world.contacts.c_pine.email, /nomail/);
  await run(NOW + 10 * MIN);
  assert.equal(world.contacts.c_pine.email, null);
  assert.deepEqual(await tags(), []);
});
test('Watch never touches a donor contact', async () => {
  await noEmailGiver();
  await setMode(env, 'watch');
  await posted();
  assert.equal((await theRow()).state, 'would');
  assert.equal(world.patches.length, 0);
  assert.equal(world.posts.length, 0);
});
test('a person entering a no-email giver\'s check files it under their contact too', async () => {
  await noEmailGiver();
  world.reading = read({ payer: '', remitter: '' });
  await posted();
  await run(NOW + 20 * MIN);
  await run(NOW + 30 * MIN);
  await run(NOW + 40 * MIN);
  const r0 = await theRow();
  assert.equal(r0.state, 'person');
  await personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', by: 'holly@soardcharity.com', now: NOW + 50 * MIN, fetchImpl: fakeFetch });
  assert.equal(world.payments.at(-1).contact, 'c_pine');
  assert.equal(world.contacts.c_pine.email, null);
});

// ── A person ─────────────────────────────────────────────────────────────

async function withPerson(reason = 'unreadable') {
  await setMode(env, 'on');
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'person', reason = ?, status = 'sent', payer = NULL WHERE id = ?`).bind(reason, TX).run();
}
test('a person\'s entry makes the record, still with nothing sent, and teaches the payer', async () => {
  await withPerson();
  const r = await personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_grant', by: 'holly@soardcharity.com', now: NOW, fetchImpl: fakeFetch });
  assert.equal(r.result, 'created');
  assert.equal(world.posts[0].generate_tax_receipt, false);
  const row = await theRow();
  assert.equal(row.via, 'person');
  assert.equal(row.by, 'holly@soardcharity.com');
  assert.equal((await env.DB.prepare('SELECT campaign_id FROM check_payers').first()).campaign_id, 'form_grant');
});
test('a person\'s entry reads Zeffy again first: an entry made since is linked, not doubled', async () => {
  await withPerson();
  world.payments.push(hand());
  const r = await personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', now: NOW, fetchImpl: fakeFetch });
  assert.equal(r.result, 'linked');
  assert.equal(world.posts.length, 0);
});
test('a possible double stops a person too, until they look at it and say it is another gift', async () => {
  await withPerson();
  world.payments.push(hand({ id: 'zp_oak', buyer: { first_name: 'Oak', last_name: 'Trust' } }));
  await assert.rejects(personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', now: NOW, fetchImpl: fakeFetch }), /may be this check/);
  assert.equal(world.posts.length, 0);
  const view = (await checksView(env)).list[0];
  assert.equal(view.candidates[0].id, 'zp_oak');
  const r = await personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', notThose: true, shown: ['zp_oak'], now: NOW, fetchImpl: fakeFetch });
  assert.equal(r.result, 'created');
});
test('a person can\'t create while the site is watching: staff are entering by hand', async () => {
  await withPerson();
  await setMode(env, 'watch');
  await assert.rejects(personCreate(env, TX, { name: 'x y', formId: 'form_home', now: NOW, fetchImpl: fakeFetch }), /watching/);
});
test('a person\'s entry needs a name, an open form and a real date', async () => {
  await withPerson();
  const go = (o) => personCreate(env, TX, { name: 'Pine', formId: 'form_home', now: NOW, fetchImpl: fakeFetch, ...o });
  await assert.rejects(go({ name: '' }), /Who wrote/);
  await assert.rejects(go({ name: ACCOUNT }), /long number/);
  await assert.rejects(go({ formId: 'form_golf' }), /open donation form/);
  await assert.rejects(go({ day: 'tomorrow' }), /date/);
});
test('two presses of Create make one record', async () => {
  await withPerson();
  await personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', now: NOW, fetchImpl: fakeFetch });
  await assert.rejects(personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', now: NOW, fetchImpl: fakeFetch }), /moved on/);
  assert.equal(world.posts.length, 1);
});
test('a person links a check to an entry; the same entry can\'t take a second check', async () => {
  await withPerson();
  world.payments.push(hand({ id: 'zp_x', buyer: { first_name: 'Other', last_name: 'Name' } }));
  await personLink(env, TX, 'zp_x', { by: 'h', now: NOW, fetchImpl: fakeFetch });
  assert.equal((await theRow()).state, 'linked');
  await env.DB.prepare(`INSERT INTO check_gifts (id, cents, state, deposited_at) VALUES ('tx_2', 1000000, 'person', '2026-11-06T00:00:00Z')`).run();
  await assert.rejects(personLink(env, 'tx_2', 'zp_x', { now: NOW, fetchImpl: fakeFetch }), /Another check/);
});
test('not a gift: left out by a person, and a check with a record can\'t be', async () => {
  await withPerson();
  await personNotGift(env, TX, { by: 'h', now: NOW });
  assert.equal((await theRow()).state, 'left-out');
  assert.equal((await theRow()).reason, 'person');
  await env.DB.prepare(`UPDATE check_gifts SET zeffy_id = 'zp' WHERE id = ?`).bind(TX).run();
  await assert.rejects(personNotGift(env, TX, { now: NOW }), /Zeffy record/);
});
test('entering by hand: the check waits, and the entry links itself', async () => {
  await setMode(env, 'on');
  await posted();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'event', zeffy_id = NULL, memo = 'Golf' WHERE id = ?`).bind(TX).run();
  world.payments = [];
  world.payments.push(hand({ id: 'zp_golf', campaign_id: 'form_golf' }));
  await run(NOW + 2 * 60 * MIN);
  assert.equal((await theRow()).state, 'linked');
  assert.equal((await theRow()).zeffy_id, 'zp_golf');
});
test('a hand entry under another name on a check with a person is put in front of them', async () => {
  await setMode(env, 'on');
  await posted();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'event', zeffy_id = NULL, memo = 'Golf' WHERE id = ?`).bind(TX).run();
  world.payments = [hand({ id: 'zeffy_other', created: dayS('2026-11-09'), buyer: { first_name: 'Pine Ridge', last_name: 'Golf Team' } })];
  await run(NOW + 2 * 60 * MIN);
  const r = await theRow();
  assert.equal(r.state, 'person');
  assert.equal((await checksView(env)).list[0].candidates[0].id, 'zeffy_other');
});
test('Mercury not answering at all is said, not swallowed', async () => {
  await run();
  await maybeRunChecks(env, { now: NOW + 10 * MIN, fetchImpl: async (u, i) => { if (String(u).includes('mercury-relay')) throw new Error('relay down'); return fakeFetch(u, i); } });
  assert.equal((await checksView(env)).lastError?.error, 'Mercury didn’t answer');
});
test('turned on, what it was watching goes on too, one a run, each read against Zeffy again', async () => {
  await posted();
  assert.equal((await theRow()).state, 'would');
  await setMode(env, 'on');
  await run(NOW + 20 * MIN);
  assert.equal((await theRow()).state, 'created');
  assert.equal(world.posts.length, 1);
});
test('turned on, a check entered by hand since is linked, not doubled', async () => {
  await posted();
  world.payments.push(hand());
  await setMode(env, 'on');
  await run(NOW + 20 * MIN);
  assert.equal((await theRow()).state, 'linked');
  assert.equal(world.posts.length, 0);
});
test('Zeffy being busy on a person\'s save says nothing was saved', async () => {
  await withPerson();
  world.postFails = 429;
  await assert.rejects(personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', now: NOW, fetchImpl: fakeFetch }), /nothing was saved/);
  assert.equal((await theRow()).state, 'person');
});
test('Zeffy not answering the reads before a person\'s save says nothing was saved', async () => {
  await withPerson();
  const down = async (u, i) => { if (String(u).includes('api.zeffy.com')) throw new DOMException('timed out', 'TimeoutError'); return fakeFetch(u, i); };
  await assert.rejects(personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', now: NOW, fetchImpl: down }), /nothing was saved/);
});
test('a left-out check a person calls a gift, with an entry that may be it, comes to Needs you with that entry', async () => {
  await setMode(env, 'on');
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'left-out', reason = 'refund', status = 'sent', memo = 'refund' WHERE id = ?`).bind(TX).run();
  world.payments.push(hand({ id: 'zeffy_ruth', buyer: { first_name: 'Ruth', last_name: 'Ace' } }));
  await assert.rejects(personCreate(env, TX, { name: 'Ace Supply', formId: 'form_home', now: NOW, fetchImpl: fakeFetch }), /may be this check/);
  const c = (await checksView(env)).list[0];
  assert.equal(c.state, 'person');
  assert.equal(c.candidates[0].id, 'zeffy_ruth');
  assert.equal(c.formId, 'form_home');
});
test('matching an unread check to an entry fills its name in; differing amounts stay visible', async () => {
  await withPerson();
  world.payments.push(hand({ id: 'zeffy_small', amount: 10000, buyer: { first_name: 'Rosa', last_name: 'Whitfield' } }));
  await personLink(env, TX, 'zeffy_small', { by: 'h', now: NOW, fetchImpl: fakeFetch });
  const c = (await checksView(env)).list[0];
  assert.equal(c.payer, 'Rosa Whitfield');
  assert.equal(c.reason, 'amount-off');
  assert.match(c.why, /different amounts/);
});
test('an entry another check took drops off the page at once, and the check is decided again', async () => {
  await setMode(env, 'on');
  await run();
  world.txns.tx_other = txn({ id: 'tx_other', status: 'sent', postedAt: '2026-11-05T00:00:00Z' });
  await env.DB.prepare(`INSERT INTO check_gifts (id, cents, state, status, deposited_at, payer, zeffy_id) VALUES ('tx_other', 1000000, 'linked', 'sent', '2026-11-04T00:00:00Z', 'Oak', 'zeffy_taken')`).run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'maybe-double', status = 'sent', payer = 'Pine Foundation', note = ? WHERE id = ?`).bind(JSON.stringify([{ id: 'zeffy_taken', name: 'Oak', cents: 1000000, at: 1, form: 'x' }]), TX).run();
  assert.equal((await checksView(env)).list.find((c) => c.id === TX).candidates, null);
  await run(NOW + 2 * 60 * MIN);
  assert.equal((await theRow()).state, 'created', 'nothing stood in its way any more');
  assert.equal(world.posts.length, 1);
});
test('with nobody known to have written it, a check is never made', async () => {
  assert.equal(judge(row({ payer: '' }), { forms: FORMS }).reason, 'unreadable');
  assert.equal(judge(row({ payer: '' }), { forms: FORMS, gift: true }).reason, 'unreadable');
});
test('a failed write test tries again a day later, unless it left a record behind', async () => {
  await writeState(env.DB, 'check-gifts', { writeTest: null });
  world.postFails = 422;
  await run();
  world.postFails = null;
  await run(NOW + 10 * MIN);
  assert.equal((await readState(env.DB, 'check-gifts')).writeTest.ok, false, 'not straight away');
  await run(NOW + 2 * DAY);
  assert.equal((await readState(env.DB, 'check-gifts')).writeTest.ok, true);
  await writeState(env.DB, 'check-gifts', { writeTest: { id: WRITE_TEST, ok: false, removed: false, leftBehind: ['x'], at: new Date(NOW).toISOString() } });
  const posts = world.posts.length;
  await run(NOW + 9 * DAY);
  assert.equal(world.posts.length, posts, 'a record left behind waits for a person');
});
test('a person\'s date can\'t be after the deposit, or years off', async () => {
  await withPerson();
  const go = (day) => personCreate(env, TX, { name: 'Pine', formId: 'form_home', day, now: NOW, fetchImpl: fakeFetch });
  await assert.rejects(go('2062-11-05'), /date/);
  await assert.rejects(go('2020-01-01'), /date/);
});
test('a late deposit keeps its Eastern day', () => {
  assert.equal(recordDay({ check_date: null, deposited_at: '2027-01-01T02:30:00Z' }), '2026-12-31');
});
test('while watching, a person can take back "not a gift"', async () => {
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'left-out', reason = 'person' WHERE id = ?`).bind(TX).run();
  await personIsGift(env, TX, { by: 'h', now: NOW });
  assert.equal((await theRow()).state, 'person');
  assert.match((await checksView(env)).list[0].why, /said this is a gift/);
});
test('a check that came back with a record says what to do', async () => {
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'came-back', reason = 'back', zeffy_id = 'zeffy_z' WHERE id = ?`).bind(TX).run();
  assert.match((await checksView(env)).list[0].why, /Cancel the record in Zeffy/);
});
test('the tab count shows a real question while watching, and everything once on', async () => {
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'event' WHERE id = ?`).bind(TX).run();
  assert.equal((await checksFacts(env.DB)).waiting, 0);
  await env.DB.prepare(`UPDATE check_gifts SET reason = 'maybe-double', note = '[{"id":"z"}]' WHERE id = ?`).bind(TX).run();
  assert.equal((await checksFacts(env.DB)).waiting, 1);
  await setMode(env, 'on');
  await env.DB.prepare(`UPDATE check_gifts SET reason = 'event', note = NULL WHERE id = ?`).bind(TX).run();
  assert.equal((await checksFacts(env.DB)).waiting, 0, 'Mercury hasn’t posted it: nothing to do yet');
  await env.DB.prepare(`UPDATE check_gifts SET status = 'sent' WHERE id = ?`).bind(TX).run();
  assert.equal((await checksFacts(env.DB)).waiting, 1);
});
test('runs cut short still send a check to a person', async () => {
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'new', tries = 3, try_at = NULL, status = 'sent' WHERE id = ?`).bind(TX).run();
  const calls = world.aiCalls;
  await run(NOW + 10 * MIN);
  assert.equal((await theRow()).state, 'person');
  assert.equal(world.aiCalls, calls, 'no read is started');
});
test('a record deleted in Zeffy stops saying In Zeffy, and the site never makes it again by itself', async () => {
  await setMode(env, 'on');
  await posted();
  world.payments = [];
  world.posts = [];
  await run(NOW + 2 * 60 * MIN);
  const r = await theRow();
  assert.equal(r.state, 'person');
  assert.equal(r.reason, 'record-gone');
  assert.equal(r.zeffy_id, null);
  await run(NOW + 4 * 60 * MIN);
  assert.equal(world.posts.length, 0);
});
test('fixing the amount or marking a pledge paid in Zeffy clears what the page asked for', async () => {
  await withPerson();
  world.payments.push(hand({ id: 'zeffy_fix', amount: 100, buyer: { first_name: 'Rosa', last_name: 'Lee' } }));
  await personLink(env, TX, 'zeffy_fix', { now: NOW, fetchImpl: fakeFetch });
  assert.equal((await theRow()).reason, 'amount-off');
  world.payments[0].amount = 1000000;
  await run(NOW + 2 * 60 * MIN);
  assert.equal((await theRow()).reason, null);
});
test('a check that came back and was cancelled in Zeffy stops asking', async () => {
  await setMode(env, 'on');
  await posted();
  world.txns[TX] = { ...world.txns[TX], status: 'failed' };
  await env.DB.prepare('UPDATE check_gifts SET looked_at = NULL WHERE id = ?').bind(TX).run();
  await run(NOW + 2 * 60 * MIN);
  assert.match((await checksView(env)).list[0].why, /Cancel the record/);
  world.payments = [];
  await run(NOW + 4 * 60 * MIN);
  assert.equal((await checksView(env)).list[0].zeffyId, null);
  assert.match((await checksView(env)).list[0].why, /came back/);
});
test('Not this entry: the entry comes off, what it taught goes, and it is never offered for this check again', async () => {
  await posted();
  world.payments.push(hand({ id: 'zeffy_wrong' }));
  await run(NOW + 2 * 60 * MIN);
  assert.equal((await theRow()).state, 'linked');
  await personUnlink(env, TX, { by: 'h', now: NOW });
  const r = await theRow();
  assert.equal(r.zeffy_id, null);
  assert.equal(r.payer, 'Pine Foundation');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM check_payers').first()).n, 0);
  await run(NOW + 3 * 60 * MIN);
  assert.notEqual((await theRow()).zeffy_id, 'zeffy_wrong');
  await run(NOW + 4 * 60 * MIN);
  assert.notEqual((await theRow()).zeffy_id, 'zeffy_wrong');
  await assert.rejects(personUnlink(env, TX, { now: NOW }), /Only a matched entry/);
});
test('at the flip, a check posted long ago goes to a person, not straight in', async () => {
  await posted();
  await setMode(env, 'on');
  await run(NOW + 40 * DAY);
  const r = await theRow();
  assert.equal(r.state, 'person');
  assert.equal(r.reason, 'old-check');
  assert.equal(world.posts.length, 0);
});
test('a check waiting on its entry links however old it gets', async () => {
  await posted();
  await env.DB.prepare('UPDATE check_gifts SET final = 1 WHERE id = ?').bind(TX).run();
  world.payments.push(hand({ campaign_id: 'form_grant', created: dayS('2026-11-05') }));
  await run(NOW + 90 * DAY);
  assert.equal((await theRow()).state, 'linked');
});
test('a block lifted later doesn\'t turn "not a gift" or the store\'s money into a gift', async () => {
  await setMode(env, 'on');
  await posted();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'left-out', reason = 'person', zeffy_id = NULL WHERE id = ?`).bind(TX).run();
  world.payments = [];
  world.posts = [];
  world.txns[TX] = { ...world.txns[TX], status: 'blocked' };
  await env.DB.prepare('UPDATE check_gifts SET looked_at = NULL WHERE id = ?').bind(TX).run();
  await run(NOW + 2 * 60 * MIN);
  assert.equal((await theRow()).state, 'left-out');
  world.txns[TX] = { ...world.txns[TX], status: 'sent' };
  await run(NOW + 4 * 60 * MIN);
  await run(NOW + 6 * 60 * MIN);
  assert.equal((await theRow()).state, 'left-out');
  assert.equal(world.posts.length, 0);
});
test('a company paid only through Mercury or on W-9s & insurance counts as one SOARD pays', async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vendor_papers (id TEXT, vkey TEXT)`).run();
  const { nameKeyOf } = await import('../functions/api/_vendor-files.js');
  await env.DB.prepare(`INSERT INTO vendor_papers (id, vkey) VALUES ('v', ?)`).bind(nameKeyOf('Ace Roofing LLC')).run();
  world.reading = read({ payer: 'Ace Roofing LLC' });
  await setMode(env, 'on');
  await posted();
  assert.equal((await theRow()).reason, 'vendor');
  assert.equal(world.posts.length, 0);
});
test('a company paid out of Mercury counts too', async () => {
  await mirrorTransaction(env.DB, txn({ id: 'tx_paid', kind: 'outgoingPayment', amount: -4000, status: 'sent', counterpartyName: 'Birch Roofing LLC', attachments: [] }), { now: NOW });
  world.reading = read({ payer: 'Birch Roofing LLC' });
  await setMode(env, 'on');
  await posted();
  assert.equal((await theRow()).reason, 'vendor');
});
test('a date that isn\'t a day is no date', () => {
  assert.equal(proof(read({ date: '2026-09-31' }), read({ date: '2026-09-31' })).date, '');
});
test('a check that goes in after a person was told closes the alert', async () => {
  await setMode(env, 'on');
  await run();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'read', status = 'sent', alerted = 'maybe-double' WHERE id = ?`).bind(TX).run();
  const { slackIssue } = await import('../functions/api/_broadcast-notify.js');
  const { slackCard } = await import('../functions/api/_slack-cards.js');
  await slackIssue(env, `check:${TX}`, slackCard({ title: 't', lead: 'l' }), { title: 't', kind: 'attention' });
  world.slack = [];
  await run(NOW + 10 * MIN);
  assert.equal((await theRow()).state, 'created');
  assert.ok(world.slack.some((b) => b.includes('Saved in Zeffy')), 'the alert is closed');
});
test('an unknown check is a clear no', async () => {
  await assert.rejects(personNotGift(env, 'nope', { now: NOW }), /isn.t on the list/);
});

test('On needs the write test; Watch is the default', async () => {
  await writeState(env.DB, 'check-gifts', { writeTest: null, mode: null });
  assert.equal((await checksView(env)).mode, 'watch');
  await assert.rejects(setMode(env, 'on'), /proven/);
});
test('the Automations map gets counts and times only', async () => {
  await run();
  const f = await checksFacts(env.DB);
  assert.equal(f.total, 1);
  assert.equal(f.mode, 'watch');
  assert.equal(f.writeOk, true);
  assert.equal(JSON.stringify(f).includes('Pine'), false);
});
test('gift alerts skip the write test by name', async () => {
  const { screenPayment } = await import('../functions/api/_zeffy.js');
  assert.equal(screenPayment(hand({ buyer: { first_name: 'SOARD', last_name: 'WebsiteTest' } })), 'website test');
  assert.equal(screenPayment(hand({ buyer: { first_name: 'SOARDWebsiteTest', last_name: 'SOARDWebsiteTest' } })), 'website test');
  assert.equal(screenPayment(hand()), null);
  void readZeffyConfig; void readState;
});
test('a name typed in both boxes reads once in Slack and on the board', async () => {
  const { giftMessage } = await import('../functions/api/_zeffy.js');
  const { giftOf } = await import('../functions/api/_board-gifts.js');
  const p = hand({ buyer: { first_name: 'Brightwell', last_name: 'Brightwell' } });
  assert.match(giftMessage(p).text, /from Brightwell(\n|$| )/);
  assert.doesNotMatch(giftMessage(p).text, /Brightwell Brightwell/);
  assert.equal(giftOf(p).name, 'Brightwell');
});

// ── What the page sends and shows (Nov 7 break-it round) ─────────────────────

test('an answer from an older screen never overrules a newer one: a colleague\'s "not a gift" stands', async () => {
  await withPerson();
  await personNotGift(env, TX, { saw: 'person', by: 'b@example.com', now: NOW });
  await assert.rejects(personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', saw: 'person', now: NOW, fetchImpl: fakeFetch }), /just changed/);
  assert.equal(world.posts.length, 0);
  assert.equal((await theRow()).state, 'left-out');
});
test('"Not this entry" hands the check to the person, and the site never makes its own record after it', async () => {
  // A hand entry got there first, and the site matched it
  world.payments.push(hand({ campaign_id: 'form_grant', description: 'Grant Funding 2026' }));
  await setMode(env, 'on');
  await posted();
  assert.equal((await theRow()).state, 'linked');
  assert.equal(world.posts.length, 0);
  await personUnlink(env, TX, { saw: 'linked', now: NOW + 25 * MIN });
  const r = await theRow();
  assert.equal(r.state, 'person');
  assert.equal(r.reason, 'unlinked');
  for (let i = 1; i <= 4; i++) await run(NOW + 25 * MIN + i * 61 * MIN);
  assert.equal(world.posts.length, 0, 'no record made by itself');
  assert.equal((await theRow()).state, 'person');
  const v = (await checksView(env)).list.find((c) => c.id === TX);
  assert.equal(v.needsYou, true);
});
test('Save names the entry it found, and "a different gift" covers exactly the entries shown', async () => {
  await withPerson();
  world.payments.push(hand({ id: 'zp_rp', buyer: { first_name: 'Rosalind', last_name: 'Park' }, created: dayS('2026-11-04') }));
  const e = await personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', saw: 'person', now: NOW, fetchImpl: fakeFetch }).catch((x) => x);
  assert.equal(e.status, 409);
  assert.deepEqual(e.entries.map((x) => [x.id, x.name]), [['zp_rp', 'Rosalind Park']]);
  // Another entry turns up before the person answers: it's shown first, not saved past
  world.payments.push(hand({ id: 'zp_new', type: 'online', status: 'pending', created: dayS('2026-11-06'), buyer: { first_name: 'Ruth', last_name: 'Ace' } }));
  const again = await personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', notThose: true, shown: ['zp_rp'], saw: 'person', now: NOW, fetchImpl: fakeFetch }).catch((x) => x);
  assert.equal(again.status, 409);
  assert.equal(world.posts.length, 0);
  const r = await personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', notThose: true, shown: ['zp_rp', 'zp_new'], saw: 'person', now: NOW, fetchImpl: fakeFetch });
  assert.equal(r.result, 'created');
});
test('a check Mercury hasn\'t posted can\'t be saved yet', async () => {
  await withPerson();
  await env.DB.prepare(`UPDATE check_gifts SET status = 'pending' WHERE id = ?`).bind(TX).run();
  await assert.rejects(personCreate(env, TX, { name: 'Pine Foundation', formId: 'form_home', now: NOW, fetchImpl: fakeFetch }), /hasn’t posted/);
  assert.equal(world.posts.length, 0);
});
test('nothing can be answered while Zeffy hasn\'t answered the site\'s save', async () => {
  await withPerson();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'unsure' WHERE id = ?`).bind(TX).run();
  for (const go of [() => personNotGift(env, TX, { now: NOW }), () => personLink(env, TX, 'zp_hand', { now: NOW, fetchImpl: fakeFetch }), () => personCreate(env, TX, { name: 'Pine', formId: 'form_home', now: NOW, fetchImpl: fakeFetch })]) {
    await assert.rejects(go(), /hasn’t answered/);
  }
});
test('an entry deleted in Zeffy since is said plainly and no longer offered', async () => {
  await withPerson('maybe-double');
  await env.DB.prepare(`UPDATE check_gifts SET note = ? WHERE id = ?`).bind(JSON.stringify([{ id: 'zp_gone', name: 'Oak Trust', cents: 1000000, at: dayS('2026-11-04') }, { id: 'zp_hand', name: 'Pine Foundation', cents: 1000000, at: dayS('2026-11-04') }]), TX).run();
  await assert.rejects(personLink(env, TX, 'zp_gone', { now: NOW, fetchImpl: fakeFetch }), /was deleted/);
  assert.deepEqual(JSON.parse((await theRow()).note).map((x) => x.id), ['zp_hand']);
});
test('to-dos in Zeffy wait on a person and are counted; the tab\'s count is always the list\'s', async () => {
  await setMode(env, 'on');
  await posted();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'linked', zeffy_id = 'zp_x', reason = 'amount-off' WHERE id = ?`).bind(TX).run();
  for (const mode of ['on', 'watch']) {
    await setMode(env, mode);
    const v = await checksView(env);
    assert.equal(v.list[0].needsYou, true, mode);
    assert.equal(v.waiting, 1);
    assert.equal((await checksFacts(env.DB)).waiting, v.waiting, mode);
  }
});
test('while watching, a question whose entry went to another check waits for the hand entry and isn\'t counted', async () => {
  await posted();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'maybe-double', note = ? WHERE id = ?`).bind(JSON.stringify([{ id: 'zp_taken', name: 'Oak Trust', cents: 1000000, at: dayS('2026-11-04') }]), TX).run();
  await env.DB.prepare(`INSERT INTO check_gifts (id, cents, state, zeffy_id, deposited_at) VALUES ('other', 1000000, 'linked', 'zp_taken', '2026-11-04T15:00:00Z')`).run();
  const v = await checksView(env);
  const c = v.list.find((x) => x.id === TX);
  assert.equal(c.needsYou, false);
  assert.match(c.why, /now another check’s/);
  assert.equal(v.waiting, 0);
  assert.equal((await checksFacts(env.DB)).waiting, 0);
});
test('while on, "It isn\'t a gift" works on a check the site was about to enter', async () => {
  await setMode(env, 'on');
  await throughRead();
  post();
  await personNotGift(env, TX, { saw: 'read', now: NOW });
  await run(NOW + 10 * MIN);
  assert.equal((await theRow()).state, 'left-out');
  assert.equal(world.posts.length, 0);
});
test('the admin route never shows a database\'s own message', async () => {
  const { onRequestGet, onRequestPost } = await import('../functions/api/checks-admin.js');
  const broken = { DB: { prepare: () => { throw new Error('D1_ERROR: database is locked'); } } };
  const g = await (await onRequestGet({ env: broken, request: new Request('https://x.test/api/checks-admin') })).json();
  assert.doesNotMatch(g.error, /D1_ERROR/);
  assert.match(g.error, /Try again in a minute/);
  const p = await (await onRequestPost({ env: broken, request: new Request('https://x.test/api/checks-admin', { method: 'POST', body: JSON.stringify({ action: 'not-gift', id: 'x' }) }), data: {} })).json();
  assert.doesNotMatch(p.error, /D1_ERROR/);
});

test('a refusal is said in plain words, never Zeffy\'s field names', async () => {
  const { refusalWords } = await import('../functions/api/_check-gifts.js');
  assert.equal(refusalWords({ code: 'invalid_request', message: 'campaign_id must be an active campaign' }), 'The Zeffy form isn’t open any more. Pick another form.');
  assert.equal(refusalWords({ message: 'Zeffy answered 422' }), 'Zeffy wouldn’t take this record.');
});
test('a check that goes to a person keeps the form the site would have used', async () => {
  world.reading = read({ payer: 'Elm Street Fund', memo: 'golf' });
  await setMode(env, 'on');
  await posted();
  const r = await theRow();
  assert.equal(r.reason, 'event');
  assert.equal(r.form_id, 'form_grant');
});
test('Save after a deleted entry, with nothing left to ask about, decides the check again', async () => {
  await withPerson('maybe-double');
  await env.DB.prepare(`UPDATE check_gifts SET payer = 'Pine Foundation', note = ? WHERE id = ?`).bind(JSON.stringify([{ id: 'zp_gone', name: 'Oak Trust', cents: 1000000, at: dayS('2026-11-04') }]), TX).run();
  await assert.rejects(personLink(env, TX, 'zp_gone', { now: NOW, fetchImpl: fakeFetch }), /nothing to match. The site decides this check again/);
  assert.equal((await theRow()).state, 'read');
});
test('On, stopped by a new write test that failed: the page says so and Slack hears it once', async () => {
  await setMode(env, 'on');
  await writeState(env.DB, 'check-gifts', { writeTest: { id: 'older', ok: true } });
  world.postFails = 422;
  await run();
  const v = await checksView(env);
  assert.equal(v.mode, 'watch');
  assert.equal(v.paused, true);
  assert.equal(world.slack.filter((b) => /stopped entering checks/.test(b)).length, 1);
});

// ── Round four on the page's side ────────────────────────────────────────

test('an older screen is refused even when the check came back round to the same state', async () => {
  await withPerson('maybe-double');
  await env.DB.prepare(`UPDATE check_gifts SET note = ? WHERE id = ?`).bind(JSON.stringify([{ id: 'zp_hand', name: 'Pine Foundation', cents: 1000000, at: dayS('2026-11-04') }]), TX).run();
  const before = (await checksView(env)).list[0].ver;
  world.payments.push(hand());
  await personLink(env, TX, 'zp_hand', { saw: before, now: NOW, fetchImpl: fakeFetch });
  const linked = (await checksView(env)).list[0].ver;
  await personUnlink(env, TX, { saw: linked, now: NOW });
  // Back to "person", but not the check the old screen showed: that entry was ruled out since
  await assert.rejects(personLink(env, TX, 'zp_hand', { saw: before, now: NOW, fetchImpl: fakeFetch }), /just changed/);
  const now = (await checksView(env)).list[0].ver;
  await assert.rejects(personLink(env, TX, 'zp_hand', { saw: now, now: NOW, fetchImpl: fakeFetch }), /isn’t this check/);
});
test('an amounts-differ to-do names the entry and both amounts', async () => {
  await posted();
  world.payments.push(hand({ amount: 900000, campaign_id: 'form_grant' }));
  await env.DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'amount-differs' WHERE id = ?`).bind(TX).run();
  await personLink(env, TX, 'zp_hand', { now: NOW, fetchImpl: fakeFetch });
  const c = (await checksView(env)).list[0];
  assert.equal(c.toDo, true);
  assert.match(c.why, /Pine Foundation, \$9,000\.00/);
  assert.match(c.why, /\$10,000\.00/);
});
test('the switch counts every check it was watching, not only the ones listed', async () => {
  for (let i = 0; i < 4; i++) await env.DB.prepare(`INSERT INTO check_gifts (id, cents, state, status, deposited_at, posted_at) VALUES (?, 100, 'would', 'sent', '2026-08-01T15:00:00Z', '2026-08-03T15:00:00Z')`).bind(`old${i}`).run();
  await env.DB.prepare(`INSERT INTO check_gifts (id, cents, state, status, deposited_at, posted_at) VALUES ('fresh', 100, 'would', 'sent', ?, ?)`).bind(new Date().toISOString(), new Date().toISOString()).run();
  const v = await checksView(env);
  assert.deepEqual(v.watching, { fresh: 1, old: 4 });
});
// ── Round six ────────────────────────────────────────────────────────────

test('a switch pressed on an older screen never undoes a colleague\'s switch', async () => {
  await setMode(env, 'on', { by: 'a@example.com' });
  await setMode(env, 'watch', { by: 'a@example.com', saw: 'on' });
  await assert.rejects(setMode(env, 'on', { by: 'b@example.com', saw: 'on' }), /Someone just turned it back to watching/);
  assert.equal((await checksView(env)).mode, 'watch');
  await setMode(env, 'on', { by: 'b@example.com', saw: 'watch' });
  assert.equal((await checksView(env)).mode, 'on');
});
test('a save Zeffy says to wait on leaves the check\'s name and form as they were', async () => {
  await withPerson();
  await env.DB.prepare(`UPDATE check_gifts SET state = 'left-out', reason = 'refund', payer = 'Ace Supply' WHERE id = ?`).bind(TX).run();
  world.postFails = 429;
  await assert.rejects(personCreate(env, TX, { name: 'Rosa Whitfield', formId: 'form_home', now: NOW, fetchImpl: fakeFetch }), /busy/);
  assert.equal((await theRow()).payer, 'Ace Supply');
  assert.equal((await theRow()).state, 'left-out');
});
test('the Watch score counts every scored check, not only the ones listed', async () => {
  for (let i = 0; i < 305; i++) await env.DB.prepare(`INSERT INTO check_gifts (id, cents, state, deposited_at, score) VALUES (?, 100, 'linked', ?, ?)`).bind(`s${i}`, new Date(Date.parse('2026-01-01T15:00:00Z') + i * 3600e3).toISOString(), JSON.stringify({ payer: i >= 5, gift: true, form: true })).run();
  assert.deepEqual((await checksView(env)).scored, { total: 305, right: 300 });
});
// ── The wide look before any record is made ──────────────────────────────

test('the wide look: anything since the check was written, any name; the giver\'s own open pledge or one just marked paid, any age', async () => {
  const { netOf } = await import('../functions/api/_check-gifts.js');
  const r = row({ check_date: '2026-11-03' });
  const other = hand({ id: 'zp_other', created: dayS('2026-11-20'), buyer: { first_name: 'Dana', last_name: 'Whitfield' } });
  const before = hand({ id: 'zp_before', created: dayS('2026-09-01'), buyer: { first_name: 'Dana', last_name: 'Whitfield' } });
  const pledge = hand({ id: 'zp_pledge', type: 'online', status: 'pending', created: dayS('2026-05-01') });
  const paidLongAgo = hand({ id: 'zp_paid', type: 'online', created: dayS('2026-05-01') });
  const card = hand({ id: 'zp_card', type: 'online', payment_method: { type: 'card' }, created: dayS('2026-11-04') });
  const ids = (o) => netOf(r, [other, before, pledge, paidLongAgo, card], new Set(), o).map((p) => p.id).sort();
  assert.deepEqual(ids(), ['zp_other', 'zp_pledge']);
  assert.deepEqual(ids({ turnedPaid: new Set(['zp_paid']) }), ['zp_other', 'zp_paid', 'zp_pledge'], 'a pledge marked paid since the check was written');
  assert.deepEqual(netOf(r, [other], new Set(['zp_other'])), [], 'claimed by another check');
});
test('On never makes a record past an entry under another name the windows miss: a person looks', async () => {
  await setMode(env, 'on');
  await throughRead();
  // Typed late, not backdated, under a fund advisor's name
  world.payments.push(hand({ id: 'zp_late', created: dayS('2026-11-09'), buyer: { first_name: 'Dana', last_name: 'Whitfield' } }));
  post();
  await run(NOW + 10 * MIN);
  const r = await theRow();
  assert.equal(r.state, 'person');
  assert.match(r.note, /zp_late/);
  assert.equal(world.posts.length, 0);
});

// ── The weekly money check ───────────────────────────────────────────────

test('the money check names a check gift in Zeffy with no check in Mercury, and leaves out what it should', async () => {
  const { moneyCheck } = await import('../functions/api/_check-gifts.js');
  await setMode(env, 'on');
  await posted();
  const r = await theRow();
  assert.equal(r.state, 'created');
  const at = dayS('2026-11-07'); // after checks went through Mercury (Nov 6)
  world.payments.push(
    hand({ id: 'zp_twice', created: at, buyer: { first_name: 'Dana', last_name: 'Whitfield' } }),          // a second record for a check: named
    hand({ id: 'zp_old', created: dayS('2026-10-20') }),                                                   // before checks went through Mercury: left out
    hand({ id: 'zp_test', created: at, amount: 100, buyer: { first_name: 'SOARD', last_name: 'WebsiteTest' } }), // the site's own test: left out
    hand({ id: 'zp_card', created: at, type: 'online', payment_method: { type: 'card' } }),                // not a check: left out
    hand({ id: 'zp_asked', created: at, amount: 5000 }),                                                   // already asked about: left out
  );
  await env.DB.prepare(`INSERT INTO check_gifts (id, cents, state, reason, status, deposited_at, note) VALUES ('q', 5000, 'person', 'maybe-double', 'sent', '2026-11-05T15:00:00Z', ?)`).bind(JSON.stringify([{ id: 'zp_asked' }])).run();
  world.slack = [];
  const m = await moneyCheck(env, { now: NOW + DAY, fetchImpl: fakeFetch });
  assert.deepEqual(m.loose.map((x) => x.id), ['zp_twice']);
  assert.equal(world.slack.filter((b) => /no check in Mercury/.test(b)).length, 1);
  assert.equal((await checksView(env)).money.loose.length, 1);
  assert.equal((await checksFacts(env.DB)).moneyLoose, 1);
});
test('the money check runs Monday morning, once', async () => {
  const mon = Date.parse('2026-11-16T15:00:00Z'); // 10 AM Eastern, a Monday
  await run(mon);
  const first = (await readState(env.DB, 'check-gifts')).money?.at;
  assert.ok(first);
  await run(mon + 10 * MIN);
  assert.equal((await readState(env.DB, 'check-gifts')).money.at, first, 'once that day');
});
