/**
 * Finance: the P&L's columns, the lumpy-cash forecast, the month-end close
 * and the board's totals (functions/api/_finance.js)
 * Run: node --test tests/
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { writeState, MERCURY_BASE } from '../functions/api/_mercury.js';
import { mirrorTransaction, txnRow } from '../functions/api/_mercury-txns.js';
import { ensureSpendSchema, writeConfig } from '../functions/api/_spend.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import {
  classify, pnl, forecast, incomeKind, weekStart, maybeRunFinance,
  boardFinance, readFinance, writeFinance, cashForecast, addMonths,
} from '../functions/api/_finance.js';

const RELAY_KEY = 'relay-key:test';
const NOW = Date.parse('2026-11-03T16:00:00Z');
const row = (o) => txnRow({ status: 'sent', accountId: 'chk', createdAt: '2026-10-10T15:00:00Z', postedAt: '2026-10-10T15:00:00Z', attachments: [], ...o });

test('which money is what: gifts, store sales, refunds, moves and the card payoff', () => {
  const charge = (bucket, job_id = null) => ({ bucket, job_id });
  assert.deepEqual(classify(row({ id: 'a', kind: 'internalTransfer', amount: -5000 })), { type: 'skip' });
  assert.deepEqual(classify(row({ id: 'b', kind: 'externalTransfer', amount: -2400, counterpartyName: 'Mercury IO Payment' })), { type: 'skip' });
  assert.deepEqual(classify(row({ id: 'c', kind: 'externalTransfer', amount: 812.5, counterpartyName: 'ZEFFY PAYOUT' })), { type: 'income', kind: 'donations', column: 'operating', cents: 81250 });
  assert.deepEqual(classify(row({ id: 'd', kind: 'externalTransfer', amount: 120, counterpartyName: 'SHOPIFY' })), { type: 'income', kind: 'store', column: 'store', cents: 12000 });
  assert.equal(classify(row({ id: 'e', kind: 'checkDeposit', amount: 500, counterpartyName: 'Check' })).kind, 'donations');
  assert.equal(classify(row({ id: 'f', kind: 'interestPayment', amount: 3.1 })).kind, 'interest');
  // A person's pick wins over the guess
  assert.equal(incomeKind({ kind: 'externalTransfer', counterparty: 'SHOPIFY' }, { shopify: 'donations' }), 'donations');
  const spend = classify(row({ id: 'g', kind: 'creditCardTransaction', amount: -467.1, mercuryCategory: 'FacilitiesExpenses' }), { charge: charge('job', 'J1') });
  assert.deepEqual(spend, { type: 'expense', column: 'job', jobId: 'J1', category: 'Facilities expenses', cents: 46710 });
  const refund = classify(row({ id: 'h', kind: 'creditCardCredit', amount: 40, mercuryCategory: 'Retail' }), { charge: charge('job', 'J1') });
  assert.equal(refund.cents, -4000);
  assert.equal(refund.column, 'job');
  assert.equal(classify(row({ id: 'i', kind: 'creditCardTransaction', amount: -12 })).column, null); // not sorted yet
  assert.equal(classify(row({ id: 'j', kind: 'wireFee', amount: -15 })).column, 'operating');
  assert.equal(classify(row({ id: 'k', kind: 'creditCardTransaction', amount: -9, status: 'cancelled' })).type, 'skip');
  // The store's own account: its deposits are the store's
  assert.equal(classify(row({ id: 'l', kind: 'externalTransfer', amount: 50, counterpartyName: 'Someone', accountId: 'store-acct' }), { accountBuckets: { 'store-acct': 'store' } }).column, 'store');
});

test('the P&L adds up by column, with unsorted spending as its own line', () => {
  const rows = [
    row({ id: '1', kind: 'externalTransfer', amount: 1000, counterpartyName: 'Zeffy' }),
    row({ id: '2', kind: 'externalTransfer', amount: 200, counterpartyName: 'Shopify' }),
    row({ id: '3', kind: 'creditCardTransaction', amount: -300, categoryData: { id: 'c1', name: 'Makeover materials' } }),
    row({ id: '4', kind: 'creditCardTransaction', amount: -50, categoryData: { id: 'c2', name: 'Store inventory' } }),
    row({ id: '5', kind: 'debitCardTransaction', amount: -25, categoryData: { id: 'c3', name: 'Software' } }),
    row({ id: '6', kind: 'creditCardTransaction', amount: -10 }),
  ];
  const charges = new Map([['3', { bucket: 'job', job_id: 'J1' }], ['4', { bucket: 'store' }], ['5', { bucket: 'operating' }]]);
  const p = pnl(rows, { charges });
  assert.deepEqual(p.incomeTotal, { job: 0, store: 20000, operating: 100000, total: 120000 });
  assert.equal(p.expenseTotal.job, 30000);
  assert.equal(p.expenseTotal.store, 5000);
  assert.equal(p.expenseTotal.operating, 2500);
  assert.deepEqual(p.unsorted, { cents: 1000, count: 1 });
  assert.equal(p.expenseTotal.total, 38500);
  assert.deepEqual(p.net, { job: -30000, store: 15000, operating: 97500, total: 81500 });
  assert.deepEqual(p.jobs, [{ jobId: 'J1', cents: 30000 }]);
});

test('the forecast: lumpy gifts give a band, the card leaves in week 2, the floor is checked on the cautious line', () => {
  // A year of weeks: mostly nothing, a few big gifts, and a December rush last year
  const weeklyIncome = [];
  for (let i = 0; i < 70; i++) {
    const d = new Date(Date.parse('2025-09-01T12:00:00Z') + i * 7 * 86400e3).toISOString().slice(0, 10);
    const dec = d >= '2025-11-24' && d < '2025-12-29';
    weeklyIncome.push({ weekStart: d, cents: dec ? 4000000 : i % 3 === 0 ? 600000 : 0 });
  }
  const f = forecast({
    startCents: 6000000, owedCents: 800000, weeklyIncome, today: '2026-11-03',
    monthlySpend: { operating: [1300000, 1100000, 5000000], store: [100000, 120000, 90000] },
    jobs: [{ name: 'Max', status: 'Build', remainingCents: 900000 }],
    unbudgeted: [{ name: 'Ava', status: 'Approval' }],
    averageMakeoverCents: 3000000,
    floorCents: 2500000,
  });
  assert.equal(f.weeks.length, 13);
  assert.equal(f.weeks[1].parts.card, 800000);
  assert.equal(f.weeks[0].parts.card, 0);
  assert.equal(f.weeks[0].parts.makeovers, 300000); // Build spreads over 3 weeks
  assert.equal(f.weeks[3].parts.makeovers, 0);
  assert.equal(f.weeks[3].parts.newMakeovers, 300000); // an approved job with no budget yet, from week 3
  // Median, not mean: one $50k month doesn't set the run-rate
  assert.equal(f.sources.operatingWeekly, Math.round((1300000 * 12) / 52));
  // Last December shows up this December
  const dec = f.weeks.find((w) => w.start >= '2026-11-30');
  assert.ok(dec.inLikely > f.weeks[0].inLikely);
  for (const w of f.weeks) assert.ok(w.low <= w.likely && w.likely <= w.high);
  assert.ok(f.lowest.low.cents <= f.lowest.likely.cents);
  assert.equal(weekStart('2026-11-05'), '2026-11-02');
});

// ─── With a database ────────────────────────────────────────────────

let env;
let world;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.origin === MERCURY_BASE) {
    if (init.headers?.['X-Relay-Key'] !== RELAY_KEY) return new Response('Forbidden', { status: 403 });
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/transactions') {
      world.listed.push(url.searchParams.get('start'));
      return Response.json({ transactions: world.history, page: {} });
    }
    if (p === '/accounts') return Response.json({ accounts: [{ id: 'chk', name: 'Checking', kind: 'checking', type: 'mercury', status: 'active', currentBalance: world.balance }, { id: 'ext', type: 'external', currentBalance: 99999 }] });
    if (p === '/credit') return Response.json({ accounts: [{ id: 'io', status: 'active', currentBalance: 1200 }] });
    if (p === '/treasury') return Response.json({ accounts: [] });
    if (/^\/account\/chk\/statements$/.test(p)) return Response.json({ statements: world.statements });
    throw new Error(`Mercury doesn't know ${p}`);
  }
  if (url.host === 'slack.com') { world.slack.push(JSON.parse(init.body)); return Response.json({ ok: true, channel: 'CFIN', ts: `${world.slack.length}.1` }); }
  if (url.host === 'api.resend.com') { world.emails.push(JSON.parse(init.body)); return Response.json({ id: `em${world.emails.length}` }); }
  throw new Error(`unexpected fetch ${url.href}`);
};
after(() => { globalThis.fetch = realFetch; });

beforeEach(async () => {
  world = { history: [], listed: [], balance: 40000, statements: [], slack: [], emails: [] };
  const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
  env = { DB, MERCURY_API_TOKEN: 'secret-token:test', MERCURY_RELAY_KEY: RELAY_KEY, SLACK_BOT_TOKEN: 'xoxb-test', RESEND_API_KEY: 're_test' };
  await ensureSpendSchema(DB);
});

async function seedOctober() {
  const t = (o) => ({ status: 'sent', accountId: 'chk', attachments: [], ...o });
  const list = [
    t({ id: 'g1', kind: 'externalTransfer', amount: 5000, counterpartyName: 'ZEFFY', createdAt: '2026-10-05T14:00:00Z', postedAt: '2026-10-05T14:00:00Z', accountingStatus: { status: 'synced' }, categoryData: { id: 'cat-g', name: 'Donations' } }),
    t({ id: 'c1', kind: 'creditCardTransaction', amount: -467.1, counterpartyName: 'THE HOME DEPOT', createdAt: '2026-10-08T14:00:00Z', postedAt: '2026-10-09T14:00:00Z', accountingStatus: { status: 'synced' }, categoryData: { id: 'cat-m', name: 'Makeover materials' } }),
    t({ id: 'c2', kind: 'creditCardTransaction', amount: -15, counterpartyName: 'CANVA', createdAt: '2026-10-12T14:00:00Z', postedAt: '2026-10-12T14:00:00Z', accountingStatus: { status: 'pending' } }),
    // Late on Oct 31 in Atlanta is November in UTC: it's still October's
    t({ id: 'c3', kind: 'debitCardTransaction', amount: -20, counterpartyName: 'HOBBY LOBBY', createdAt: '2026-11-01T02:00:00Z', postedAt: '2026-11-01T02:00:00Z', accountingStatus: { status: 'synced' }, categoryData: { id: 'cat-s', name: 'Store inventory' } }),
    t({ id: 'x1', kind: 'internalTransfer', amount: -1000, createdAt: '2026-10-20T14:00:00Z', postedAt: '2026-10-20T14:00:00Z' }),
    // Last October, for "same month last year"
    t({ id: 'old', kind: 'externalTransfer', amount: 2000, counterpartyName: 'ZEFFY', createdAt: '2025-10-07T14:00:00Z', postedAt: '2025-10-07T14:00:00Z' }),
  ];
  for (const x of list) await mirrorTransaction(env.DB, x, { now: NOW });
  const add = (id, bucket, jobId, receipt, created) => env.DB.prepare('INSERT INTO spend_charges (id, kind, status, cents, vendor, created_at, bucket, job_id, has_receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, 'creditCardTransaction', 'sent', 1, 'v', created, bucket, jobId, receipt).run();
  await add('c1', 'job', 'J1', 1, '2026-10-08T14:00:00Z');
  await add('c2', null, null, 0, '2026-10-12T14:00:00Z');
  await add('c3', 'store', null, 1, '2026-10-31T22:00:00Z');
  await writeFinance(env.DB, { jobNames: { J1: 'Max Daniel (2026)' } });
  return list;
}

test('history is read back to January last year, a step at a time, then stops', async () => {
  world.history = [{ id: 'h1', kind: 'externalTransfer', status: 'sent', amount: 10, counterpartyName: 'ZEFFY', accountId: 'chk', createdAt: '2025-03-01T00:00:00Z', postedAt: '2025-03-01T00:00:00Z' }];
  await maybeRunFinance(env, { now: NOW });
  assert.equal(world.listed[0], '2025-01-01T00:00:00Z');
  const fin = await readFinance(env.DB);
  assert.ok(fin.backfill.doneAt);
  assert.equal(fin.backfill.read, 1);
  await writeFinance(env.DB, { lastRunAt: null });
  await maybeRunFinance(env, { now: NOW + 1800e3 });
  assert.equal(world.listed.length, 1, 'no second read once the history is in');
  assert.equal(addMonths('2026-01', -1), '2025-12');
});

test('cash under the floor posts once to the Finance channel, and clears when it recovers', async () => {
  await seedOctober();
  await writeSlackConfig(env.DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
  await writeFinance(env.DB, { backfill: { doneAt: 'x', since: '2025-01-01' }, floorCents: 5000000 });
  world.balance = 20000; // $20,000 with a $50,000 floor
  await maybeRunFinance(env, { now: NOW });
  const posts = () => world.slack.filter((s) => /below the floor/.test(JSON.stringify(s)));
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].channel, 'CFIN');
  assert.match(JSON.stringify(posts()[0]), /admin\/#board/, 'the button opens the board page, not an admin Finance tab');
  const f = await cashForecast(env, { now: NOW });
  assert.equal(f.owedCents, 120000);
  assert.equal(f.startCents, 2000000, 'external accounts aren’t SOARD’s cash');
  await writeFinance(env.DB, { lastRunAt: null });
  await maybeRunFinance(env, { now: NOW + 1800e3 });
  assert.equal(posts().length, 1, 'still low: no second post');
  world.balance = 900000;
  await writeFinance(env.DB, { lastRunAt: null, balances: null });
  await maybeRunFinance(env, { now: NOW + 3600e3 });
  assert.ok(world.slack.some((s) => /back above the floor/i.test(JSON.stringify(s))));
});

test('money alerts never post anywhere without a Finance channel', async () => {
  await seedOctober();
  await writeSlackConfig(env.DB, { channel: { id: 'CNEWS', name: 'news' }, attention: { id: 'CALERT', name: 'alerts' } });
  await writeFinance(env.DB, { backfill: { doneAt: 'x' }, floorCents: 5000000 });
  world.balance = 100;
  await maybeRunFinance(env, { now: NOW });
  assert.equal(world.slack.length, 0);
});

test('the board gets totals only: no vendors, people or jobs', async () => {
  await seedOctober();
  await writeFinance(env.DB, { lastForecast: { lowest: { likely: { cents: 3000000, week: '2026-12-07' }, low: { cents: 1000000, week: '2026-12-07' } }, end: { likely: 4500000 }, startCents: 4000000, floorCents: 2500000, belowFloor: { week: '2026-12-07', cents: 1000000 } } });
  const b = await boardFinance(env, { now: NOW });
  assert.equal(b.months.length, 12);
  const oct = b.months.find((m) => m.month === '2026-10');
  assert.deepEqual(oct, { month: '2026-10', income: 5000, makeovers: 467, store: 20, operating: 15, net: 4498, storeSales: 0 });
  assert.equal(b.cash.today, 40000);
  assert.equal(b.cash.belowFloor, true);
  assert.ok(!('close' in b), 'no month-end close: Mercury Books closes the books');
  const text = JSON.stringify(b);
  for (const secret of ['HOME DEPOT', 'CANVA', 'Max Daniel', 'J1', 'peter@']) assert.ok(!text.includes(secret), secret);
});
