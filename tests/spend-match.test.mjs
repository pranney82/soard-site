/**
 * Job costs: which job, which bucket, which bill (functions/api/_spend-match.js)
 * and the ledger math (functions/api/_job-ledger.js)
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  vendorKey, vendorLikeness, ruleFor, chargeOf, guessJob, bucketOf, pairBills,
} from '../functions/api/_spend-match.js';
import { computeLedger, thresholds, UNCODED } from '../functions/api/_job-ledger.js';

test('vendor names from card descriptors match the vendor in JobTread', () => {
  assert.equal(vendorKey('THE HOME DEPOT #0123'), 'home depot');
  assert.equal(vendorKey('homedepot.com'), 'home depot');
  assert.equal(vendorKey('LOWES #01234   ATLANTA GA'), 'lowes');
  assert.equal(vendorKey("Lowe's"), 'lowes');
  assert.equal(vendorKey('SQ *TKO PLUMBING'), 'tko plumbing');
  assert.equal(vendorLikeness('AMZN Mktp US*2K4', 'Amazon'), 0);
  assert.equal(vendorLikeness('The Home Depot', 'HOME DEPOT 4521'), 1);
});

test('a rule only applies to the same vendor', () => {
  const rules = [{ vendor: 'tko plumbing', name: 'TKO Plumbing', kind: 'code', costCodeId: 'P' }, { vendor: 'spotify', name: 'Spotify', kind: 'operating' }];
  assert.equal(ruleFor('SQ *TKO PLUMBING', rules)?.costCodeId, 'P');
  assert.equal(ruleFor('Spotify USA', rules)?.kind, 'operating');
  assert.equal(ruleFor('Plumbing Supply Co', rules), null);
});

test('spending is kept, refunds count against it, transfers are not spending', () => {
  const t = { id: 't1', kind: 'creditCardTransaction', status: 'pending', amount: -123.45, counterpartyName: 'THE HOME DEPOT', createdAt: '2026-10-27T15:00:00Z', accountId: 'acc' };
  assert.equal(chargeOf(t).cents, 12345);
  assert.equal(chargeOf(t).accountId, 'acc');
  assert.equal(chargeOf({ ...t, kind: 'creditCardCredit', amount: 20 }).cents, -2000);
  assert.equal(chargeOf({ ...t, kind: 'internalTransfer' }), null);
  assert.equal(chargeOf({ ...t, amount: 0 }), null);
});

test('a charge goes to the cardholder’s one buying job, else the one job in Build, else nowhere', () => {
  const jobs = [
    { id: 'A', status: 'Build', staff: ['amy@soard.org'] },
    { id: 'B', status: 'Mobilization', staff: ['amy@soard.org', 'bo@soard.org'] },
    { id: 'C', status: 'Design', staff: ['cy@soard.org'] },
  ];
  assert.deepEqual(guessJob({ email: 'bo@soard.org' }, jobs), { jobId: 'B', how: 'person' });
  // Amy is on two buying jobs: falls to the one job in Build
  assert.deepEqual(guessJob({ email: 'amy@soard.org' }, jobs), { jobId: 'A', how: 'build' });
  // Cy's job is still in Design (not buying); A is the only build
  assert.deepEqual(guessJob({ email: 'cy@soard.org' }, jobs), { jobId: 'A', how: 'build' });
  assert.deepEqual(guessJob({ email: 'x@soard.org' }, [...jobs, { id: 'D', status: 'Build', staff: [] }]), { jobId: null, how: null });
  assert.deepEqual(guessJob({ email: 'bo@soard.org' }, jobs, { staffPick: 'C' }), { jobId: 'C', how: 'staff' });
});

test('the store’s card and account, then vendor rules, decide the bucket', () => {
  const c = { cardId: 'card-store', accountId: 'acc-main' };
  assert.deepEqual(bucketOf(c, { cardBuckets: { 'card-store': 'store' } }), { bucket: 'store', how: 'card' });
  assert.deepEqual(bucketOf({ cardId: 'x', accountId: 'acc-ops' }, { accountBuckets: { 'acc-ops': 'operating' } }), { bucket: 'operating', how: 'account' });
  assert.deepEqual(bucketOf({ cardId: 'x' }, { rule: { kind: 'store' } }), { bucket: 'store', how: 'rule' });
  assert.deepEqual(bucketOf({ cardId: 'x' }, { rule: { kind: 'code' } }), { bucket: null, how: null });
});

test('bills pair with charges by total, vendor and date, one to one', () => {
  const charges = [
    { id: 'c1', cents: 46710, vendor: 'THE HOME DEPOT #121', createdAt: '2026-10-20T14:00:00Z' },
    { id: 'c2', cents: 9900, vendor: 'TRUE LOO WASTE', createdAt: '2026-10-14T14:00:00Z' },
    { id: 'c3', cents: 5000, vendor: 'AMAZON', createdAt: '2026-10-10T14:00:00Z' },
    { id: 'c4', cents: 5000, vendor: 'TARGET', createdAt: '2026-10-11T14:00:00Z' },
  ];
  const bills = [
    { id: 'b1', cents: 46710, vendor: 'The Home Depot', date: '2026-10-22' },
    { id: 'b2', cents: 9900, vendor: 'True Loo Waste Services', date: '2026-10-15' },
    // Same total as two charges, vendor JobTread spells differently: not paired (could be either)
    { id: 'b3', cents: 5000, vendor: 'Wayfair', date: '2026-10-11' },
    // Two weeks after the charge: too late to be its receipt
    { id: 'b4', cents: 46710, vendor: 'The Home Depot', date: '2026-11-10' },
  ];
  const pairs = pairBills(bills, charges);
  assert.deepEqual(pairs.map((p) => [p.billId, p.chargeId]).sort(), [['b1', 'c1'], ['b2', 'c2']]);
  // A bill naming the vendor picks its twin-amount charge
  assert.deepEqual(pairBills([{ id: 'b5', cents: 5000, vendor: 'Target', date: '2026-10-12' }], charges).map((p) => p.chargeId), ['c4']);
});

test('the ledger: budget, billed, what orders still have to come, and pending charges', () => {
  const l = computeLedger({
    budget: [{ costCodeId: 'PLUMB', cents: 500000 }, { costCodeId: 'PAINT', cents: 100000 }],
    docs: [
      // A $3,000 plumbing order, $1,000 of it billed so far: $2,000 still to come
      { id: 'po', type: 'vendorOrder', status: 'approved', vendor: 'TKO Plumbing', cents: 300000, lines: [{ costCodeId: 'PLUMB', cents: 300000 }] },
      { id: 'b1', type: 'vendorBill', status: 'approved', vendor: 'TKO Plumbing', cents: 100000, lines: [{ costCodeId: 'PLUMB', cents: 100000 }] },
      // A bill whose lines don't add up: the rest counts, uncoded
      { id: 'b2', type: 'vendorBill', status: 'pending', vendor: 'Sherwin-Williams', cents: 30000, lines: [{ costCodeId: 'PAINT', cents: 25000 }] },
      // Denied and pending orders don't count
      { id: 'b3', type: 'vendorBill', status: 'denied', vendor: 'X', cents: 999999, lines: [] },
      { id: 'po2', type: 'vendorOrder', status: 'pending', vendor: 'Y', cents: 50000, lines: [{ costCodeId: 'PAINT', cents: 50000 }] },
    ],
    pending: [{ id: 'c1', cents: 12000, costCodeId: 'PAINT' }, { id: 'c2', cents: 4000, costCodeId: null }],
  });
  const row = (id) => l.rows.find((r) => r.codeId === id);
  assert.deepEqual(row('PLUMB'), { codeId: 'PLUMB', budget: 500000, committed: 200000, billed: 100000, pending: 0, forecast: 300000 });
  assert.deepEqual(row('PAINT'), { codeId: 'PAINT', budget: 100000, committed: 0, billed: 25000, pending: 12000, forecast: 37000 });
  assert.deepEqual(row(UNCODED), { codeId: UNCODED, budget: 0, committed: 0, billed: 5000, pending: 4000, forecast: 9000 });
  assert.equal(l.rows.at(-1).codeId, UNCODED);
  assert.deepEqual(l.totals, { budget: 600000, committed: 200000, billed: 130000, pending: 16000, forecast: 346000 });
});

test('budget alerts post once per crossing', () => {
  const at = (forecast, budget = 1000000, rows = []) => ({ totals: { budget, forecast, billed: forecast, pending: 0, committed: 0 }, rows });
  let t = thresholds(at(700000), {});
  assert.equal(t.posts.length, 0);
  t = thresholds(at(850000), t.alerted, { name: 'Max Daniel (2026)' });
  assert.equal(t.posts.length, 1);
  assert.match(t.posts[0].title, /Max Daniel \(2026\) is at 85% of its budget/);
  t = thresholds(at(900000), t.alerted);
  assert.equal(t.posts.length, 0, 'still in the 80s: no second post');
  t = thresholds(at(1020000), t.alerted, { name: 'Max' });
  assert.equal(t.posts[0].title, 'Max is over budget');
  // A cost code over its own line by more than $100 and 10%
  const rows = [{ codeId: 'PLUMB', budget: 100000, forecast: 125000 }, { codeId: 'PAINT', budget: 100000, forecast: 105000 }];
  t = thresholds(at(500000, 1000000, rows), {}, { codeName: (id) => (id === 'PLUMB' ? '19 PLUMBING' : id) });
  assert.deepEqual(t.posts.map((p) => p.title), ['This job: 19 PLUMBING is over its budget line']);
  assert.equal(thresholds(at(500000, 1000000, rows), t.alerted).posts.length, 0);
});
