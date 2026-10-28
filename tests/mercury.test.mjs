/**
 * Job costs end to end: Mercury's webhook → a charge on its job → the
 * JobTread bill that replaces it → the note back in Mercury
 * (functions/api/_spend.js, _mercury.js, _jobtread-bills.js)
 * Run: node --test tests/
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { verifySignature, writeState, mercury, MERCURY_BASE } from '../functions/api/_mercury.js';
import {
  handleWebhook, readCharges, syncBills, pairAll, writeNotes, placeCharge, readRules, readConfig, writeConfig, keepTransaction,
} from '../functions/api/_spend.js';
import { readLedgers } from '../functions/api/_job-ledger.js';
import { proposeSplit, readRecode } from '../functions/api/_jobtread-bills.js';

const SECRET = 'mercury_whsec_test';
const RELAY_KEY = 'relay-key:test';
const NOW = Date.parse('2026-10-27T16:00:00Z');
const S = (ms) => Math.floor(ms / 1000);

let world;
const fresh = () => ({
  txns: {},
  patches: [],
  jobs: [{ id: 'J1', name: 'Max Daniel (2026)', status: 'Build', staff: ['amy@soardcharity.com'] }],
  budget: { J1: [{ cost: 5000, costCode: { id: 'PLUMB' } }, { cost: 2000, costCode: { id: 'PAINT' } }] },
  docs: { J1: [] },
  bills: [],
  slack: [],
  madeFields: [],
  jobFields: [],
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.origin === MERCURY_BASE) {
    // The relay: a bare "Forbidden" unless the key matches, then Mercury's answer
    if (init.headers?.['X-Relay-Key'] !== RELAY_KEY) return new Response('Forbidden', { status: 403 });
    const p = url.pathname.replace('/api/v1', '');
    const one = p.match(/^\/transaction\/(.+)$/);
    if (one && init.method === 'PATCH') {
      world.patches.push({ id: one[1], ...JSON.parse(init.body) });
      return Response.json(world.txns[one[1]]);
    }
    if (one) return world.txns[one[1]] ? Response.json(world.txns[one[1]]) : Response.json({ errors: { message: 'not found' } }, { status: 404 });
    if (p === '/cards') return Response.json({ cards: [{ id: 'card-amy', userId: 'u1', status: 'active', spendLimit: { amountCents: 500000, interval: 'monthly' } }] });
    if (p === '/users') return Response.json({ users: [{ userId: 'u1', email: 'amy@soardcharity.com', firstName: 'Amy' }] });
    if (p === '/transactions') return Response.json({ transactions: Object.values(world.txns), page: {} });
    throw new Error(`Mercury doesn't know ${p}`);
  }
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.jobs) {
      return Response.json({ organization: { jobs: { nextPage: null, nodes: world.jobs.map((j) => ({
        id: j.id, name: j.name, location: { address: '1 Main St' },
        customFieldValues: { nodes: [{ value: j.status }] },
        aces: { nodes: j.staff.map((e) => ({ membership: { isInternal: true, user: { emailAddress: e } } })) },
      })) } } });
    }
    if (query.organization?.customFields) return Response.json({ organization: { customFields: { nodes: [{ id: 'F1', name: 'Spent to date' }] } } });
    if (query.createCustomField) {
      world.madeFields.push(query.createCustomField.$.name);
      return Response.json({ createCustomField: { createdCustomField: { id: `F${world.madeFields.length + 1}` } } });
    }
    if (query.updateJob) { world.jobFields.push(query.updateJob.$); return Response.json({ updateJob: {} }); }
    if (query.organization?.costCodes) return Response.json({ organization: { costCodes: { nodes: [{ id: 'PLUMB', name: '19 PLUMBING' }, { id: 'PAINT', name: '23 PAINTING' }] } } });
    if (query.organization?.documents) return Response.json({ organization: { documents: { nextPage: null, nodes: world.bills } } });
    if (query.job?.costItems) return Response.json({ job: { costItems: { nextPage: null, nodes: world.budget[query.job.$.id] || [] } } });
    if (query.job?.documents) return Response.json({ job: { documents: { nextPage: null, nodes: world.docs[query.job.$.id] || [] } } });
    throw new Error(`JobTread doesn't know ${JSON.stringify(Object.keys(query))}`);
  }
  if (url.host === 'slack.com') {
    world.slack.push(JSON.parse(init.body));
    return Response.json({ ok: true, channel: 'C1', ts: '1.1' });
  }
  throw new Error(`unexpected fetch ${url.href}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
beforeEach(async () => {
  world = fresh();
  const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
  env = { DB, MERCURY_API_TOKEN: 'secret-token:test', MERCURY_RELAY_KEY: RELAY_KEY, JOBTREAD_GRANT_KEY: 'jt' };
  await writeState(DB, 'mercury-webhook', { id: 'wh1', secret: SECRET });
});

const txn = (o = {}) => ({
  id: 'tx1', kind: 'creditCardTransaction', status: 'pending', amount: -467.1, counterpartyName: 'THE HOME DEPOT #121',
  cardId: 'card-amy', accountId: 'acc-credit', createdAt: '2026-10-27T15:00:00Z', attachments: [], ...o,
});

async function deliver(event, { secret = SECRET, t = S(NOW) } = {}) {
  const raw = JSON.stringify(event);
  const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const waits = [];
  const res = await handleWebhook(env, new Request('https://x/api/mercury-webhook', { method: 'POST', body: raw, headers: { 'Mercury-Signature': `t=${t},v1=${v1}` } }),
    { now: NOW, after: (p) => waits.push(p) });
  await Promise.all(waits);
  return { status: res.status, body: await res.json() };
}

test('Mercury’s signature: good, stale and forged', async () => {
  const raw = '{"a":1}';
  const t = S(NOW);
  const v1 = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  assert.deepEqual(await verifySignature(SECRET, `t=${t},v1=${v1}`, raw, t), { ok: true });
  assert.equal((await verifySignature(SECRET, `t=${t},v1=${v1}`, raw, t + 600)).ok, false);
  assert.equal((await verifySignature('other', `t=${t},v1=${v1}`, raw, t)).ok, false);
  assert.equal((await verifySignature(SECRET, null, raw, t)).ok, false);
});

test('a swipe shows up as pending on the cardholder’s job within the webhook call', async () => {
  world.txns.tx1 = txn();
  const r = await deliver({ id: 'ev1', resourceType: 'transaction', resourceId: 'tx1', operationType: 'create' });
  assert.equal(r.status, 200);
  const [c] = await readCharges(env.DB);
  assert.equal(c.cents, 46710);
  assert.equal(c.email, 'amy@soardcharity.com');
  assert.equal(c.bucket, 'job');
  assert.equal(c.jobId, 'J1');
  assert.equal(c.jobHow, 'person');
  const [l] = await readLedgers(env.DB);
  assert.equal(l.totals.pending, 46710);
  assert.equal(l.totals.budget, 700000);
  // The same numbers land on the job in JobTread; the missing fields are made once
  assert.deepEqual(world.madeFields, ['Waiting for receipts', 'Forecast vs budget', 'Close-out report']);
  assert.deepEqual(world.jobFields.at(-1), { id: 'J1', customFieldValues: { F1: '$467', F2: '$467', F3: '$467 of $7,000 (7%)' } });
  // The same event again (Mercury delivers at least once) does nothing
  assert.deepEqual((await deliver({ id: 'ev1', resourceType: 'transaction', resourceId: 'tx1' })).body, { ok: true, duplicate: true });
});

test('a forged or stale delivery is refused and not retried', async () => {
  world.txns.tx1 = txn();
  assert.equal((await deliver({ id: 'ev2', resourceType: 'transaction', resourceId: 'tx1' }, { secret: 'wrong' })).status, 400);
  assert.equal((await deliver({ id: 'ev3', resourceType: 'transaction', resourceId: 'tx1' }, { t: S(NOW) - 900 })).status, 400);
  assert.equal((await readCharges(env.DB)).length, 0);
});

test('the JobTread bill replaces the guess, and Mercury gets the note', async () => {
  world.txns.tx1 = txn({ status: 'sent' });
  await deliver({ id: 'ev1', resourceType: 'transaction', resourceId: 'tx1' });
  // The DataX agent made the bill: two codes on the receipt
  const bill = { id: 'B1', status: 'approved', cost: 467.1, issueDate: '2026-10-27', createdAt: '2026-10-27T18:00:00Z', number: '42',
    account: { name: 'The Home Depot' }, job: { id: 'J1' }, costItems: { nodes: [{ cost: 400, costCode: { id: 'PLUMB' } }, { cost: 67.1, costCode: { id: 'PAINT' } }] } };
  world.bills = [bill];
  world.docs.J1 = [{ ...bill, type: 'vendorBill', costItems: { nodes: bill.costItems.nodes.map((n, i) => ({ id: `ci${i}`, name: 'x', ...n })) } }];
  await syncBills(env, { now: NOW });
  const touched = await pairAll(env, { now: NOW });
  assert.deepEqual(touched, ['J1']);
  const [c] = await readCharges(env.DB);
  assert.equal(c.billId, 'B1');
  assert.equal(c.jobHow, 'bill');
  assert.equal(c.costCodeId, 'PLUMB');
  await writeConfig(env.DB, { categories: { job: 'cat-cogs' } });
  const w = await writeNotes(env, { now: NOW });
  assert.equal(w.written, 1);
  assert.equal(world.patches[0].id, 'tx1');
  assert.equal(world.patches[0].categoryId, 'cat-cogs');
  assert.match(world.patches[0].note, /^JobTread: Max Daniel \(2026\) · bill #42 · https:\/\/app\.jobtread\.com\/documents\/B1$/);
});

test('Mercury calls go through the relay with its key, and a wrong key names the secret to fix', async () => {
  assert.equal(MERCURY_BASE, 'https://mercury-relay.sunshineonaranneyday.com');
  assert.equal((await mercury(env, '/cards')).cards[0].id, 'card-amy');
  env.MERCURY_RELAY_KEY = 'wrong';
  await assert.rejects(mercury(env, '/cards'), { status: 403, relay: true, message: /MERCURY_RELAY_KEY is missing or wrong/ });
  delete env.MERCURY_RELAY_KEY;
  await assert.rejects(mercury(env, '/cards'), { relay: true, message: 'MERCURY_RELAY_KEY is not set' });
});

test('the store’s card is the store’s; a person sorting a charge teaches the vendor', async () => {
  await writeConfig(env.DB, { cardBuckets: { 'card-store': 'store' } });
  const r1 = await keepTransaction(env, txn({ id: 'tx2', cardId: 'card-store', counterpartyName: 'HOBBY LOBBY' }), { now: NOW });
  assert.equal(r1.charge.bucket, 'store');
  assert.equal(r1.charge.jobId, null);
  // An operating expense on Amy's card: guessed onto her job, then sorted by hand
  world.txns.tx3 = txn({ id: 'tx3', counterpartyName: 'CANVA* 0123', amount: -15 });
  await keepTransaction(env, world.txns.tx3, { now: NOW });
  await placeCharge(env, 'tx3', { bucket: 'operating', remember: true, by: 'peter@soardcharity.com' });
  const rules = await readRules(env.DB);
  assert.ok(rules.some((r) => r.name === 'CANVA* 0123' && r.kind === 'operating'));
  // The next Canva charge is operating on its own, and gets its Mercury note without waiting for a bill
  const r2 = await keepTransaction(env, txn({ id: 'tx4', counterpartyName: 'CANVA* 0999', amount: -15 }), { now: NOW });
  assert.equal(r2.charge.bucket, 'operating');
  world.txns.tx4 = txn({ id: 'tx4' });
  world.txns.tx2 = txn({ id: 'tx2' });
  await writeNotes(env, { now: NOW });
  const notes = Object.fromEntries(world.patches.map((p) => [p.id, p.note]));
  assert.equal(notes.tx2, 'Sunny & Ranney (store)');
  assert.equal(notes.tx4, 'SOARD operating');
  assert.equal(notes.tx3, 'SOARD operating');
});

test('a Ramp bill’s split has to add up to the bill', async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spend_recode (
    bill_id TEXT PRIMARY KEY, job_id TEXT, job_name TEXT, vendor TEXT, cents INTEGER, date TEXT, before TEXT NOT NULL,
    proposal TEXT, proposed_by TEXT, state TEXT NOT NULL, added TEXT, error TEXT, updated_at TEXT, by TEXT)`).run();
  await env.DB.prepare("INSERT INTO spend_recode (bill_id, cents, before, state) VALUES ('R1', 10000, '{}', 'waiting')").run();
  const codes = [{ id: 'PLUMB' }, { id: 'PAINT' }];
  assert.match((await proposeSplit(env.DB, 'R1', [{ costCodeId: 'PLUMB', amount: 50 }], { codes })).error, /add up to 50\.00, the bill is 100\.00/);
  assert.match((await proposeSplit(env.DB, 'R1', [{ costCodeId: 'NOPE', amount: 100 }], { codes })).error, /isn’t one of SOARD’s/);
  assert.deepEqual(await proposeSplit(env.DB, 'R1', [{ costCodeId: 'PLUMB', amount: 60 }, { costCodeId: 'PAINT', amount: 15 }, { costCodeId: 'PLUMB', amount: 25 }], { codes }), { ok: true });
  const [r] = await readRecode(env.DB);
  assert.equal(r.state, 'proposed');
  assert.deepEqual(r.proposal.map((l) => [l.costCodeId, l.cents]), [['PLUMB', 8500], ['PAINT', 1500]]);
});
