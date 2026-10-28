/**
 * Bills approved by email and paid from Mercury, close-outs and the budget
 * builder, odd charges, receipts both ways
 * (functions/api/_bill-pay.js, _job-closeout.js, _spend-odd.js, _spend-receipts.js)
 * Run: node --test tests/
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { MERCURY_BASE } from '../functions/api/_mercury.js';
import { syncBills, keepTransaction, readCharges, ensureSpendSchema } from '../functions/api/_spend.js';
import {
  needsApproval, approvalState, recipientFor, billForPayment, decideBill, saveBillPayConfig, recordPayments, billsToAsk, markAsked, billQueue, payApproved,
} from '../functions/api/_bill-pay.js';
import { closeoutOf, codeHistory, suggestBudget, addBudgetLines } from '../functions/api/_job-closeout.js';
import { findOdd, refundTarget, checkOdd } from '../functions/api/_spend-odd.js';
import { forwardMercuryReceipts, receiptSubject } from '../functions/api/_spend-receipts.js';
import { RAMP_CODE_ID } from '../functions/api/_jobtread-bills.js';

const RELAY_KEY = 'relay-key:test';
const NOW = Date.parse('2026-10-27T16:00:00Z');
const DAY = 86400e3;
const iso = (ms) => new Date(ms).toISOString();

let world;
const fresh = () => ({
  bills: [], recipients: [], requests: [], sent: [], payments: [], applied: [], costItems: [], budget: [], emails: [], slack: [],
  txns: {}, balances: {}, statuses: {}, updated: [],
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.origin === MERCURY_BASE) {
    if (init.headers?.['X-Relay-Key'] !== RELAY_KEY) return new Response('Forbidden', { status: 403 });
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/recipients') return Response.json({ recipients: world.recipients });
    if (/\/request-send-money$/.test(p)) { world.requests.push(JSON.parse(init.body)); return Response.json({ requestId: `req${world.requests.length}`, status: 'pendingApproval' }); }
    if (/^\/account\/.+\/transactions$/.test(p) && init.method === 'POST') { world.sent.push(JSON.parse(init.body)); return Response.json({ id: `out${world.sent.length}`, status: 'pending', kind: 'outgoingPayment' }); }
    const one = p.match(/^\/transaction\/([^/]+)$/);
    if (one) return Response.json(world.txns[one[1]]);
    throw new Error(`Mercury doesn't know ${p}`);
  }
  if (url.host === 'files.example') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  if (url.host === 'api.resend.com') { world.emails.push(JSON.parse(init.body)); return Response.json({ id: 'em1' }); }
  if (url.host === 'slack.com') { world.slack.push(JSON.parse(init.body)); return Response.json({ ok: true, channel: 'C1', ts: '1.1' }); }
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.documents) return Response.json({ organization: { documents: { nextPage: null, nodes: world.bills } } });
    if (query.organization?.costCodes) return Response.json({ organization: { costCodes: { nodes: [{ id: 'PLUMB', name: '19 PLUMBING' }, { id: 'ELEC', name: '20 ELECTRICAL' }, { id: 'PAINT', name: '23 PAINTING' }] } } });
    if (query.document) return Response.json({ document: { status: world.statuses[query.document.$.id] || 'pending', balance: (world.balances[query.document.$.id] ?? 0) / 100, amountPaid: 0, account: { id: 'ACC-TKO' } } });
    if (query.updateDocument) { world.updated.push(query.updateDocument.$); return Response.json({ updateDocument: {} }); }
    if (query.createPayment) { world.payments.push(query.createPayment.$); return Response.json({ createPayment: { createdPayment: { id: `P${world.payments.length}` } } }); }
    if (query.createDocumentPayment) { world.applied.push(query.createDocumentPayment.$); return Response.json({ createDocumentPayment: { createdDocumentPayment: { id: 'DP1' } } }); }
    if (query.createCostItem) { world.costItems.push(query.createCostItem.$); return Response.json({ createCostItem: { createdCostItem: { id: `CI${world.costItems.length}` } } }); }
    if (query.job?.costItems) return Response.json({ job: { costItems: { nextPage: null, nodes: world.budget } } });
    if (query.job?.documents) return Response.json({ job: { documents: { nextPage: null, nodes: [] } } });
    throw new Error(`JobTread doesn't know ${JSON.stringify(Object.keys(query))}`);
  }
  throw new Error(`unexpected fetch ${url.href}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
beforeEach(async () => {
  world = fresh();
  const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
  env = { DB, MERCURY_API_TOKEN: 'secret-token:test', MERCURY_RELAY_KEY: RELAY_KEY, JOBTREAD_GRANT_KEY: 'jt', RESEND_API_KEY: 're_test', SLACK_BOT_TOKEN: 'xoxb-test' };
  await ensureSpendSchema(DB);
});

const APPROVER = 'approver@example.org';
const SECOND = 'second@example.org';
const cfg = (o = {}) => ({ approvers: [APPROVER], bigApprovers: [], bigBillCents: 1000000, ...o });
const tkoBill = (o = {}) => ({
  id: 'BILL1', status: 'pending', cost: 1850, issueDate: '2026-10-20', createdAt: '2026-10-20T12:00:00Z', number: '7', amountPaid: 0, balance: 1850,
  account: { id: 'ACC-TKO', name: 'TKO Plumbing' }, job: { id: 'J1' }, costItems: { nodes: [{ cost: 1850, costCode: { id: 'PLUMB' } }] }, ...o,
});

// ─── Pure ───────────────────────────────────────────────────────────

test('which bills need a person’s yes', () => {
  assert.equal(needsApproval({ status: 'pending', cents: 100, balance: 100 }), true);
  assert.equal(needsApproval({ status: 'pending', cents: 100, balance: 100, chargeId: 'c1' }), false, 'a card purchase is paid already');
  assert.equal(needsApproval({ status: 'pending', cents: 100, balance: 0 }), false);
  assert.equal(needsApproval({ status: 'draft', cents: 100, balance: 100 }), false, 'a "needs a hand" draft is not ready');
});

test('approvals: only listed people count, a big bill takes two', () => {
  const bill = { cents: 50000 };
  assert.equal(approvalState(bill, [{ by: 'someone@else.org', decision: 'approved' }], cfg()), 'waiting');
  assert.equal(approvalState(bill, [{ by: APPROVER, decision: 'approved' }], cfg()), 'approved');
  assert.equal(approvalState(bill, [{ by: APPROVER, decision: 'rejected' }], cfg()), 'rejected');
  const big = { cents: 1200000 };
  const c = cfg({ bigApprovers: [SECOND] });
  assert.equal(approvalState(big, [{ by: APPROVER, decision: 'approved' }], c), 'second');
  assert.equal(approvalState(big, [{ by: APPROVER, decision: 'approved' }, { by: SECOND, decision: 'approved' }], c), 'approved');
});

test('the Mercury recipient: a link wins, else exactly one name match', () => {
  const rs = [{ id: 'r1', name: 'TKO Plumbing LLC', status: 'active' }, { id: 'r2', name: 'Power Up Electrical', status: 'active' }];
  assert.equal(recipientFor('TKO Plumbing', rs)?.id, 'r1');
  assert.equal(recipientFor('Somebody Else', rs), null);
  assert.equal(recipientFor('TKO Plumbing', [...rs, { id: 'r3', name: 'TKO Plumbing', status: 'active' }]), null, 'two matches: a person links one');
  assert.equal(recipientFor('TKO Plumbing', rs, 'r2')?.id, 'r2');
});

test('a Mercury payment finds the bill it paid', () => {
  const bills = [{ id: 'B1', vendor: 'TKO Plumbing', cents: 185000, balance: 185000, date: '2026-10-20' }, { id: 'B2', vendor: 'TKO Plumbing', cents: 90000, balance: 0, date: '2026-10-01' }];
  const t = { cents: -185000, counterparty: 'TKO Plumbing LLC', posted_at: '2026-10-25T00:00:00Z' };
  assert.equal(billForPayment(t, bills)?.id, 'B1');
  assert.equal(billForPayment({ ...t, cents: -90000 }, bills), null, 'a paid bill is not paid again');
  assert.equal(billForPayment({ ...t, counterparty: 'Home Depot' }, bills), null);
});

test('close-outs teach the budget builder only when coded', () => {
  const kid = { roomTypes: ['Dream Bedroom', 'Accessible Bathroom'], bedroomCount: 1, bathroomCount: 1 };
  const ledger = (plumb, elec) => ({ rows: [
    { codeId: 'PLUMB', budget: 400000, billed: plumb, pending: 0 },
    { codeId: 'ELEC', budget: 200000, billed: elec, pending: 0 },
  ] });
  const a = closeoutOf(ledger(500000, 180000), kid);
  assert.equal(a.rooms, 2);
  assert.equal(a.actual, 680000);
  assert.deepEqual(a.over, [{ codeId: 'PLUMB', by: 100000 }]);
  const ramp = closeoutOf({ rows: [{ codeId: RAMP_CODE_ID, budget: 0, billed: 900000, pending: 0 }] }, kid);
  assert.equal(ramp.codedShare, 0);
  const h = codeHistory([a, closeoutOf(ledger(440000, 200000), kid), ramp]);
  assert.equal(h.jobs, 2, 'the Ramp-era job teaches nothing');
  const plumb = h.codes.find((c) => c.codeId === 'PLUMB');
  assert.equal(plumb.perRoom, 235000);
  assert.equal(plumb.overBy, 18);
  const s = suggestBudget(h, { rooms: 3, current: [{ costCodeId: 'ELEC', cents: 250000 }] });
  const p = s.lines.find((l) => l.codeId === 'PLUMB');
  assert.equal(p.suggested, 705000);
  assert.equal(p.add, true);
  assert.equal(s.lines.find((l) => l.codeId === 'ELEC').add, false, 'a code the budget has is never added again');
});

test('odd charges: twice, far over usual, newly monthly, a bar', () => {
  const c = (id, vendor, cents, at, extra = {}) => ({ id, vendor, cents, status: 'sent', createdAt: iso(at), ...extra });
  const odd = findOdd([
    c('a', 'Home Depot', 4210, NOW - 3 * DAY), c('b', 'Home Depot', 4210, NOW - 3 * DAY + 3600e3),
    c('l1', 'Lowes', 5000, NOW - 60 * DAY), c('l2', 'Lowes', 6000, NOW - 50 * DAY), c('l3', 'Lowes', 5500, NOW - 40 * DAY), c('l4', 'Lowes', 90000, NOW - DAY),
    c('s1', 'Canva', 1500, NOW - 62 * DAY), c('s2', 'Canva', 1500, NOW - 32 * DAY), c('s3', 'Canva', 1500, NOW - 2 * DAY),
    c('x', 'Joe’s Tavern', 6400, NOW - DAY, { category: 'AlcoholAndBars' }),
  ], { now: NOW });
  const kinds = odd.map((o) => o.kind).sort();
  assert.deepEqual(kinds, ['category', 'duplicate', 'outlier', 'subscription']);
  const r = refundTarget({ id: 'rf', vendor: 'HOME DEPOT #121', cents: -4210, createdAt: iso(NOW) }, [{ id: 'a', vendor: 'The Home Depot', cents: 4210, createdAt: iso(NOW - 3 * DAY), bucket: 'job', jobId: 'J1' }]);
  assert.equal(r?.id, 'a');
});

// ─── Flows ──────────────────────────────────────────────────────────

test('an approved bill becomes a Mercury payment waiting for approval, then is recorded paid in JobTread', async () => {
  world.bills = [tkoBill()];
  world.balances.BILL1 = 185000;
  world.recipients = [{ id: 'rec-tko', name: 'TKO Plumbing', status: 'active', defaultPaymentMethod: 'ach', electronicRoutingInfo: { accountNumber: 'x' }, attachments: [] }];
  await syncBills(env, { now: NOW });
  await saveBillPayConfig(env.DB, { approvers: [APPROVER], payMode: 'request', payFromAccountId: 'acc-checking', startsOn: '2026-10-01' });

  // The agent's list, then it says it asked
  assert.deepEqual((await billsToAsk(env, { now: NOW })).map((b) => b.id), ['BILL1']);
  await markAsked(env, 'BILL1', { ref: 'msg-1', now: NOW });
  assert.equal((await billsToAsk(env, { now: NOW + DAY })).length, 0, 'not asked again the next day');
  assert.equal((await billsToAsk(env, { now: NOW + 4 * DAY })).length, 1, 'asked again after 3 days of quiet');

  // A reply from someone not on the list changes nothing
  const no = await decideBill(env, 'BILL1', { decision: 'approved', from: 'stranger@example.org', now: NOW });
  assert.equal(no.ok, false);
  assert.equal(world.requests.length, 0);

  const yes = await decideBill(env, 'BILL1', { decision: 'approved', from: 'Approver@Example.org', now: NOW });
  assert.equal(yes.state, 'approved');
  assert.deepEqual(world.updated, [{ id: 'BILL1', status: 'approved' }], 'JobTread shows it approved');
  assert.deepEqual(world.requests, [{
    recipientId: 'rec-tko', amount: 1850, paymentMethod: 'ach', idempotencyKey: 'soard-bill-BILL1',
    note: 'JobTread bill #7 · approved by approver@example.org', externalMemo: 'Sunshine on a Ranney Day · bill 7',
  }]);
  const q = await billQueue(env, { now: NOW });
  assert.equal(q[0].approval.payState, 'requested');

  // Someone approves it in Mercury; the payment goes out and Mercury sends it
  await keepTransaction(env, { id: 'out-1', kind: 'outgoingPayment', status: 'sent', amount: -1850, counterpartyName: 'TKO Plumbing', counterpartyId: 'rec-tko', accountId: 'acc-checking', createdAt: iso(NOW + DAY), postedAt: iso(NOW + DAY), attachments: [] }, { jobs: [], cards: new Map(), now: NOW + DAY });
  const r = await recordPayments(env, { now: NOW + DAY });
  assert.equal(r.recorded, 1);
  assert.equal(world.payments[0].type, 'debit');
  assert.equal(world.payments[0].amount, 1850);
  assert.equal(world.payments[0].externalId, 'mercury:out-1');
  assert.deepEqual(world.applied[0], { amount: 1850, documentId: 'BILL1', paymentId: 'P1' });
  // The payment is the bill's money: on the job, not "waiting for a receipt" too
  const [charge] = await readCharges(env.DB);
  assert.equal(charge.billId, 'BILL1');
  assert.equal(charge.jobId, 'J1');
  // Once only
  await recordPayments(env, { now: NOW + DAY + 60000 });
  assert.equal(world.payments.length, 1);
});

test('paying right away stops at the day’s cap', async () => {
  world.bills = [tkoBill({ cost: 30000, balance: 30000, costItems: { nodes: [{ cost: 30000, costCode: { id: 'PLUMB' } }] } })];
  world.recipients = [{ id: 'rec-tko', name: 'TKO Plumbing', status: 'active', defaultPaymentMethod: 'ach', electronicRoutingInfo: {}, attachments: [] }];
  await syncBills(env, { now: NOW });
  world.balances.BILL1 = 3000000;
  await saveBillPayConfig(env.DB, { approvers: [APPROVER, SECOND], bigBillCents: 5000000, payMode: 'send', payFromAccountId: 'acc-checking', dailyCapCents: 2500000, startsOn: '2026-10-01' });
  await decideBill(env, 'BILL1', { decision: 'approved', from: APPROVER, now: NOW });
  assert.equal(world.sent.length, 0, 'over the cap: nothing sent');
  const [b] = await billQueue(env, { now: NOW });
  assert.equal(b.approval.payState, 'failed');
  assert.match(b.approval.payError, /cap/);
});

const sendSetup = async (o = {}) => {
  world.recipients = [{ id: 'rec-tko', name: 'TKO Plumbing', status: 'active', defaultPaymentMethod: 'ach', electronicRoutingInfo: {}, attachments: [] }];
  await syncBills(env, { now: NOW });
  await saveBillPayConfig(env.DB, { approvers: [APPROVER], payMode: 'send', payFromAccountId: 'acc-checking', startsOn: '2026-10-01', ...o });
};

test('pays what JobTread says is owed now, not the copy', async () => {
  world.bills = [tkoBill()];
  await sendSetup();
  world.balances.BILL1 = 85000;   // someone paid $1,000 of it by hand after the last sync
  await decideBill(env, 'BILL1', { decision: 'approved', from: APPROVER, now: NOW });
  assert.equal(world.sent.length, 1);
  assert.equal(world.sent[0].amount, 850);
});

test('a bill that grew after the yes is asked about again, not paid', async () => {
  world.bills = [tkoBill()];
  await sendSetup({ payMode: 'off' });
  await decideBill(env, 'BILL1', { decision: 'approved', from: APPROVER, now: NOW });
  world.balances.BILL1 = 1500000;   // the sub edited the bill to $15,000
  await saveBillPayConfig(env.DB, { payMode: 'send' });
  await payApproved(env, { now: NOW + 60000 });
  assert.equal(world.sent.length, 0, 'nothing paid');
  const [b] = await billQueue(env, { now: NOW });
  assert.equal(b.approval.state, 'waiting');
  assert.match(b.approval.note, /\$1,850.*\$15,000/);
});

test('nothing is paid from Mercury before the switch day, then it all goes that morning', async () => {
  world.bills = [tkoBill()];
  world.balances.BILL1 = 185000;
  await sendSetup({ startsOn: '2026-11-02' });
  const r = await decideBill(env, 'BILL1', { decision: 'approved', from: APPROVER, now: NOW });
  assert.equal(r.state, 'approved');
  assert.equal(world.sent.length, 0, 'Ramp still pays bills before the switch');
  assert.equal(await payApproved(env, { now: Date.parse('2026-11-01T20:00:00Z') }), 0);
  assert.equal(await payApproved(env, { now: Date.parse('2026-11-02T13:00:00Z') }), 1);
  assert.equal(world.sent.length, 1);
});

test('a denied bill is never paid', async () => {
  world.bills = [tkoBill()];
  world.balances.BILL1 = 185000;
  world.statuses.BILL1 = 'denied';
  await sendSetup();
  await decideBill(env, 'BILL1', { decision: 'approved', from: APPROVER, now: NOW });
  assert.equal(world.sent.length, 0);
});

test('the cap counts the day a payment went out, not the day it was recorded', async () => {
  world.bills = [tkoBill(), tkoBill({ id: 'BILL2', number: '8', cost: 900, balance: 900, costItems: { nodes: [{ cost: 900, costCode: { id: 'PLUMB' } }] } })];
  world.balances.BILL1 = 185000;
  world.balances.BILL2 = 90000;
  await sendSetup({ dailyCapCents: 200000 });
  await decideBill(env, 'BILL1', { decision: 'approved', from: APPROVER, now: NOW });
  // Next day: yesterday's payment is recorded in JobTread (its row changes today), then BILL2 is approved
  await keepTransaction(env, { id: 'out1', kind: 'outgoingPayment', status: 'sent', amount: -1850, counterpartyName: 'TKO Plumbing', counterpartyId: 'rec-tko', accountId: 'acc-checking', createdAt: iso(NOW), postedAt: iso(NOW + DAY), attachments: [] }, { jobs: [], cards: new Map(), now: NOW + DAY });
  await recordPayments(env, { now: NOW + DAY });
  await decideBill(env, 'BILL2', { decision: 'approved', from: APPROVER, now: NOW + DAY });
  assert.equal(world.sent.length, 2, 'yesterday’s $1,850 doesn’t count against today');
});

test('a payment Mercury held finds its bill by recipient, even with a same-size twin', async () => {
  world.bills = [tkoBill(), tkoBill({ id: 'BILL2', number: '8' })];
  world.balances.BILL1 = 185000;
  world.balances.BILL2 = 185000;
  await sendSetup({ payMode: 'request' });
  await decideBill(env, 'BILL2', { decision: 'approved', from: APPROVER, now: NOW });
  await keepTransaction(env, { id: 'out9', kind: 'outgoingPayment', status: 'sent', amount: -1850, counterpartyName: 'TKO Plumbing', counterpartyId: 'rec-tko', accountId: 'acc-checking', createdAt: iso(NOW + DAY), postedAt: iso(NOW + DAY), attachments: [] }, { jobs: [], cards: new Map(), now: NOW + DAY });
  const r = await recordPayments(env, { now: NOW + DAY });
  assert.equal(r.recorded, 1);
  assert.equal(world.applied[0].documentId, 'BILL2');
});

test('payroll and rent never crowd out a bill payment', async () => {
  world.bills = [tkoBill()];
  world.balances.BILL1 = 185000;
  await syncBills(env, { now: NOW });
  for (let i = 0; i < 40; i++) {
    await keepTransaction(env, { id: `pay${i}`, kind: 'outgoingPayment', status: 'sent', amount: -(500 + i), counterpartyName: `Someone ${i}`, accountId: 'acc-checking', createdAt: iso(NOW + i * 1000), postedAt: iso(NOW + i * 1000), attachments: [] }, { jobs: [], cards: new Map(), now: NOW });
  }
  await keepTransaction(env, { id: 'outTKO', kind: 'outgoingPayment', status: 'sent', amount: -1850, counterpartyName: 'TKO Plumbing', accountId: 'acc-checking', createdAt: iso(NOW + DAY), postedAt: iso(NOW + DAY), attachments: [] }, { jobs: [], cards: new Map(), now: NOW + DAY });
  const r = await recordPayments(env, { now: NOW + DAY });
  assert.equal(r.recorded, 1);
});

test('budget lines go in JobTread only for codes the job has none of', async () => {
  world.budget = [{ cost: 2500, costCode: { id: 'ELEC' } }];
  const r = await addBudgetLines(env, 'J1', [{ codeId: 'PLUMB', cents: 705000 }, { codeId: 'ELEC', cents: 300000 }, { codeId: 'NOPE', cents: 100 }]);
  assert.equal(r.added.length, 1);
  assert.equal(r.skipped, 2);
  assert.deepEqual(world.costItems[0], { jobId: 'J1', name: '19 PLUMBING', costCodeId: 'PLUMB', quantity: 1, unitCost: 7050, unitPrice: 7050, description: 'From the budget builder (past close-outs)' });
});

test('a refund goes back on the job its charge was on', async () => {
  const cards = new Map();
  const jobs = [{ id: 'J1', name: 'Max', status: 'Build', staff: [] }];
  await keepTransaction(env, { id: 'c1', kind: 'creditCardTransaction', status: 'sent', amount: -42.1, counterpartyName: 'THE HOME DEPOT #121', createdAt: iso(NOW - 3 * DAY), attachments: [] }, { jobs, cards, now: NOW });
  await keepTransaction(env, { id: 'c2', kind: 'creditCardCredit', status: 'sent', amount: 42.1, counterpartyName: 'HOME DEPOT', createdAt: iso(NOW), attachments: [] }, { jobs: [], cards, now: NOW });
  const r = await checkOdd(env, { now: NOW });
  assert.equal(r.refunds, 1);
  const refund = (await readCharges(env.DB)).find((c) => c.id === 'c2');
  assert.equal(refund.jobId, 'J1');
  assert.equal(refund.jobHow, 'refund');
});

test('a receipt photo in Mercury’s app goes to the receipt inbox', async () => {
  const t = { id: 'c9', kind: 'creditCardTransaction', status: 'sent', amount: -88.5, counterpartyName: 'LOWES #9', createdAt: iso(NOW - DAY), attachments: [{ fileName: 'r.jpg', url: 'https://files.example/r.jpg', attachmentType: 'receipt' }] };
  world.txns.c9 = t;
  await keepTransaction(env, t, { jobs: [{ id: 'J1', name: 'Max', status: 'Build', staff: [] }], cards: new Map(), now: NOW });
  const r = await forwardMercuryReceipts(env, { jobs: [{ id: 'J1', name: 'Max' }], now: NOW });
  assert.equal(r.sent, 1);
  assert.equal(world.emails[0].to[0], 'ap@soardcharity.com');
  assert.equal(world.emails[0].subject, receiptSubject({ id: 'c9', vendor: 'LOWES #9', cents: 8850, createdAt: t.createdAt }, 'Max'));
  assert.equal(world.emails[0].attachments[0].content, 'AQID');
  // Once
  await forwardMercuryReceipts(env, { jobs: [], now: NOW });
  assert.equal(world.emails.length, 1);
});
