/**
 * Ramp bills held for the vendor's W-9 and insurance (functions/api/_ramp.js)
 * Run: node --test tests/
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { asksOn } from './lib/vendor-asks.mjs';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { ensureSpendSchema } from '../functions/api/_spend.js';
import { ensureBillPaySchema, releaseVendorHolds } from '../functions/api/_bill-pay.js';
import { jtSetup, ensureVendorSchema, vendorsThatNeedDocs, maybeRunVendors } from '../functions/api/_vendors.js';
import { matchRampBill, runRamp, maybeRunRamp, rampView, ensureRampSchema, forgetRampToken, WATCH_MS, RAMP_BASE } from '../functions/api/_ramp.js';

const NOW = Date.parse('2026-10-29T15:00:00Z');
const MIN = 60e3;
const LATER = NOW + WATCH_MS + MIN;   // the watching day is over
const TKO = 'ACC-TKO';
const DEPOT = 'ACC-DEPOT';

// ─── A pretend Ramp, JobTread, Resend and Slack ─────────────────────

let world;
const fresh = () => ({
  fields: [{ id: 'F-W9', name: 'W-9', type: 'boolean', options: null }],
  tags: [],
  vendors: {
    [TKO]: { name: 'TKO Plumbing', email: 'office@tko.example', values: {} },
    [DEPOT]: { name: 'Home Depot', email: 'pro@depot.example', values: {} },
  },
  comments: [], pinned: [], emails: [], slack: [],
  bills: [], holds: [], releases: [], tokens: 0, holdFails: false, releaseStatus: 'PAYMENT_SCHEDULED', tokenStatus: 200,
});
const rampBill = (o) => ({ id: 'RB1', vendor: 'TKO Plumbing', cents: 185000, invoice: 'INV-77', status: 'AWAITING_PAYMENT', ...o });
const apiBill = (b) => ({
  id: b.id, vendor: { name: b.vendor }, amount: { amount: b.cents, currency_code: 'USD', minor_unit_conversion_rate: 100 },
  invoice_number: b.invoice, status: b.paid ? 'PAID' : 'OPEN', status_summary: b.status, archived_at: null,
});

function accountOf(id) {
  const v = world.vendors[id];
  if (!v) return null;
  const email = { nodes: v.email ? [{ value: v.email }] : [] };
  return {
    id, name: v.name, type: 'vendor', archivedAt: null,
    customFieldValues: { nodes: Object.entries(v.values).map(([fid, value]) => ({ value, customField: { id: fid } })) },
    primaryContact: { id: 'CON1', customFieldValues: email }, contacts: { nodes: [{ id: 'CON1', customFieldValues: email }] },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.href.startsWith(RAMP_BASE)) {
    const p = url.pathname.replace('/developer/v1', '');
    if (p === '/token') {
      world.tokens++;
      assert.equal(init.headers.Authorization, `Basic ${btoa('ramp-id:ramp-secret')}`);
      assert.match(init.body, /grant_type=client_credentials/);
      assert.match(decodeURIComponent(init.body.replace(/\+/g, ' ')), /scope=bills:read bills:write/);
      if (world.tokenStatus !== 200) return new Response('{"error":"invalid_client"}', { status: world.tokenStatus });
      return Response.json({ access_token: 'tok', expires_in: 864000 });
    }
    assert.equal(init.headers.Authorization, 'Bearer tok');
    if (p === '/bills') {
      assert.equal(url.searchParams.get('payment_status'), 'OPEN');
      return Response.json({ data: world.bills.map(apiBill), page: { next: null } });
    }
    const m = p.match(/^\/bills\/([^/]+)\/(hold|release)$/);
    if (m && init.method === 'POST') {
      const b = world.bills.find((x) => x.id === m[1]);
      if (m[2] === 'hold') {
        if (world.holdFails) return new Response('{"error":"not allowed"}', { status: 400 });
        world.holds.push({ id: m[1], ...JSON.parse(init.body) });
        b.status = 'ON_HOLD';
      } else {
        world.releases.push(m[1]);
        b.status = world.releaseStatus;
      }
      return Response.json(apiBill(b));
    }
    throw new Error(`Ramp doesn't know ${p}`);
  }
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.customFields) return Response.json({ organization: { customFields: { nodes: world.fields }, fileTags: { nodes: world.tags } } });
    if (query.createCustomField) {
      const f = { id: `F-${query.createCustomField.$.name}`, ...query.createCustomField.$ };
      world.fields.push(f);
      return Response.json({ createCustomField: { createdCustomField: { id: f.id } } });
    }
    if (query.updateCustomField) return Response.json({});
    if (query.createFileTag) {
      const t = { id: `T-${query.createFileTag.$.name}`, name: query.createFileTag.$.name };
      world.tags.push(t);
      return Response.json({ createFileTag: { createdFileTag: { id: t.id } } });
    }
    if (query.account) return Response.json({ account: accountOf(query.account.$.id) });
    if (query.updateAccount) { Object.assign(world.vendors[query.updateAccount.$.id].values, query.updateAccount.$.customFieldValues); return Response.json({}); }
    if (query.createComment) { world.comments.push(query.createComment.$); return Response.json({ createComment: { createdComment: { id: `C${world.comments.length}` } } }); }
    if (query.updateComment) { world.pinned.push(query.updateComment.$); return Response.json({}); }
    throw new Error(`JobTread doesn't know ${JSON.stringify(Object.keys(query))}`);
  }
  if (url.host === 'api.resend.com') { world.emails.push(...JSON.parse(init.body)); return Response.json({ data: [{ id: 'em1' }] }); }
  if (url.host === 'slack.com') { world.slack.push(JSON.parse(init.body)); return Response.json({ ok: true, channel: 'CFIN', ts: `${world.slack.length}.1` }); }
  throw new Error(`unexpected fetch ${url.href}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
beforeEach(async () => {
  world = fresh();
  forgetRampToken();
  const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
  env = { DB, JOBTREAD_GRANT_KEY: 'jt', RESEND_API_KEY: 're_test', SLACK_BOT_TOKEN: 'xoxb-test', RAMP_CLIENT_ID: 'ramp-id', RAMP_CLIENT_SECRET: 'ramp-secret' };
  await ensureSpendSchema(DB);
  await ensureBillPaySchema(DB);
  await ensureVendorSchema(DB);
  await asksOn(DB);
  await ensureRampSchema(DB);
  await writeSlackConfig(DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
  await jtSetup(env);
  // Ramp's copy of TKO's bill in JobTread, and the cached vendors
  await DB.prepare('INSERT INTO spend_bills (id, job_id, vendor, cents, date, created_at, status, number, lines, account_id, paid, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('JTB1', 'J1', 'TKO Plumbing LLC', 185000, '2026-10-20', new Date(NOW - 5 * 86400e3).toISOString(), 'approved', '12', '[]', TKO, 0, 185000).run();
  for (const [id, v] of Object.entries(world.vendors)) {
    await DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(`jt_${id}`, v.name, v.name.toLowerCase(), id, '{}', '', '').run();
  }
});

const fieldId = (name) => world.fields.find((f) => f.name === name)?.id;
const current = (id) => Object.assign(world.vendors[id].values, { 'F-W9': true, [fieldId('Liability Expires')]: '2027-06-01', [fieldId('Workers\' Comp Expires')]: '2027-06-01' });
const row = (id) => env.DB.prepare('SELECT * FROM ramp_holds WHERE ramp_id = ?').bind(id).first();
const slackText = () => JSON.stringify(world.slack);

// ─── Which JobTread vendor ──────────────────────────────────────────

test('a Ramp bill finds its JobTread vendor: the copy of the bill, the vendor alone, or nothing it could be wrong about', () => {
  const jt = [
    { id: 'B1', vendor: 'TKO Plumbing LLC', cents: 185000, number: '12', accountId: 'A1' },
    { id: 'B2', vendor: 'Sparks Electric', cents: 50000, number: 'INV-9', accountId: 'A2' },
    { id: 'B3', vendor: 'Sparks Electric', cents: 50000, number: 'INV-10', accountId: 'A2' },
    { id: 'B4', vendor: 'Rivera Roofing', cents: 90000, number: '1', accountId: 'A3' },
    { id: 'B5', vendor: 'Rivera Roofing Co', cents: 90000, number: '2', accountId: 'A4' },
  ];
  const vendors = [{ jtId: 'A5', name: 'Bright Paint' }, { jtId: 'A6', name: 'Cool Air' }, { jtId: 'A7', name: 'Cool Air' }];
  assert.deepEqual(matchRampBill({ vendor: 'TKO Plumbing', cents: 185000, invoice: 'X' }, jt, vendors), { accountId: 'A1', jtBillId: 'B1' });
  // The same amount twice: the invoice number picks the bill; without one, still the one vendor
  assert.deepEqual(matchRampBill({ vendor: 'Sparks Electric', cents: 50000, invoice: 'inv 10' }, jt, vendors), { accountId: 'A2', jtBillId: 'B3' });
  assert.deepEqual(matchRampBill({ vendor: 'Sparks Electric', cents: 50000, invoice: null }, jt, vendors), { accountId: 'A2', jtBillId: null });
  // No copy in JobTread: the vendor by its name
  assert.deepEqual(matchRampBill({ vendor: 'Bright Paint', cents: 1, invoice: null }, jt, vendors), { accountId: 'A5', jtBillId: null });
  // Two vendors it could be: neither
  assert.equal(matchRampBill({ vendor: 'Rivera Roofing', cents: 90000, invoice: null }, jt, vendors), null);
  assert.equal(matchRampBill({ vendor: 'Cool Air', cents: 5, invoice: null }, jt, vendors), null);
  assert.equal(matchRampBill({ vendor: 'Nobody Known', cents: 5, invoice: null }, jt, vendors), null);
});

// ─── The watching day ───────────────────────────────────────────────

test('the first day connected nothing is held or emailed: the Finance channel gets the list once, with when holds start', async () => {
  world.bills = [rampBill(), rampBill({ id: 'RB2', vendor: 'Home Depot', cents: 4210, invoice: null })];
  world.vendors[DEPOT].values[fieldId('Documents')] = 'Not needed';
  let r = await runRamp(env, { now: NOW });
  assert.equal(r.open, 2);
  assert.equal(r.watching, 1);
  assert.equal(world.holds.length, 0);
  assert.equal(world.emails.length, 0);
  assert.equal((await row('RB1')).state, 'watch');
  assert.equal((await row('RB1')).reason, 'Waiting on TKO Plumbing for a W-9 and a current certificate of insurance (no general liability insurance, no workers’ compensation insurance)');
  assert.equal((await row('RB1')).jt_bill_id, 'JTB1');
  assert.equal((await row('RB2')).state, 'clear', 'a vendor set to Not needed is never held');
  assert.equal(world.slack.length, 1);
  assert.match(slackText(), /1 bill go on hold/);
  assert.match(slackText(), /TKO Plumbing: \$1,850/);
  assert.match(slackText(), /Not needed/);
  await runRamp(env, { now: NOW + 15 * MIN });
  assert.equal(world.slack.length, 1, 'the list goes out once');
  assert.equal(world.tokens, 1, 'one token, kept between calls');

  const v = await rampView(env);
  assert.equal(v.connected, true);
  assert.equal(v.watch.length, 1);
  assert.equal(Date.parse(v.startsAt), NOW + WATCH_MS);
});

// ─── Holding and letting go ─────────────────────────────────────────

test('after the first day: held in Ramp with the reason, the vendor emailed, a pinned note on the JobTread bill, Slack once', async () => {
  world.bills = [rampBill()];
  await runRamp(env, { now: NOW });
  const r = await runRamp(env, { now: LATER });
  assert.equal(r.held, 1);
  assert.equal(world.holds.length, 1);
  assert.match(world.holds[0].reason, /^Waiting on TKO Plumbing for a W-9 and a current certificate of insurance \(no general liability insurance, .*\)\. Comes off by itself/);
  assert.equal(world.emails.length, 1);
  assert.equal(world.emails[0].to[0], 'office@tko.example');
  assert.match(world.emails[0].subject, /payment from Sunshine on a Ranney Day is waiting/);
  const note = world.comments.find((c) => c.targetId === 'JTB1');
  assert.ok(note?.isPinned);
  assert.equal(note.isVisibleToVendorRoles, false);
  assert.match(note.message, /On hold in Ramp since Oct 30: TKO Plumbing needs to send a W-9 and a current certificate of insurance \(no general liability insurance, /);
  assert.match(slackText(), /Ramp bill on hold/);
  const h = await row('RB1');
  assert.equal(h.state, 'held');
  assert.ok(h.asked_at);

  // The next runs leave it be: no second hold, email or card
  const slackBefore = world.slack.length;
  await runRamp(env, { now: LATER + 15 * MIN });
  await runRamp(env, { now: LATER + 2 * 3600e3 });
  assert.equal(world.holds.length, 1);
  assert.equal(world.emails.length, 1);
  assert.equal(world.slack.length, slackBefore);

  // The heartbeat's sweep counts it as a held bill, for reminders and letting go
  const who = await vendorsThatNeedDocs(env.DB, { now: LATER });
  assert.equal(who.get(TKO).why, 'held');
  assert.equal(who.get(TKO).bill.ramp, true);
});

test('their documents check out: the hold comes off in Ramp, the note unpinned, Slack told it pays as usual', async () => {
  world.bills = [rampBill()];
  await runRamp(env, { now: NOW });
  await runRamp(env, { now: LATER });
  current(TKO);
  // What an upload that checks out runs (fileUpload → releaseVendorHolds)
  const n = await releaseVendorHolds(env, TKO, { now: LATER + 3600e3 });
  assert.equal(n, 1);
  assert.deepEqual(world.releases, ['RB1']);
  assert.ok(world.pinned.some((u) => u.id && u.isPinned === false));
  assert.ok(world.comments.some((c) => c.targetId === 'JTB1' && c.name === 'Documents in'));
  assert.match(slackText(), /so it pays as usual/);
  assert.equal((await row('RB1')).state, 'released');
  // And it's not held again
  await runRamp(env, { now: LATER + 3 * 3600e3 });
  assert.equal(world.holds.length, 1);
  assert.equal((await row('RB1')).state, 'clear');
});

test('a released bill Ramp leaves unscheduled is said so, since Ramp has no API to schedule it', async () => {
  world.bills = [rampBill()];
  world.releaseStatus = 'PAYMENT_NOT_INSTRUCTED';
  await runRamp(env, { now: NOW });
  await runRamp(env, { now: LATER });
  current(TKO);
  await runRamp(env, { now: LATER + 2 * 3600e3 });
  assert.deepEqual(world.releases, ['RB1']);
  assert.match(slackText(), /schedule it in Ramp/);
});

test('a hold someone takes off in Ramp stays off; holds people made and bills already paying are never touched', async () => {
  world.bills = [rampBill(), rampBill({ id: 'RB3', status: 'ON_HOLD' }), rampBill({ id: 'RB4', status: 'PAYMENT_PROCESSING' })];
  await runRamp(env, { now: NOW });
  await runRamp(env, { now: LATER });
  assert.deepEqual(world.holds.map((h) => h.id), ['RB1']);
  world.bills[0].status = 'PAYMENT_SCHEDULED';   // a person released it in Ramp
  await runRamp(env, { now: LATER + 2 * 3600e3 });
  await runRamp(env, { now: LATER + 4 * 3600e3 });
  assert.equal(world.holds.length, 1);
  assert.equal((await row('RB1')).state, 'override');
  assert.match(slackText(), /Someone took the hold off in Ramp/);
  current(TKO);
  await releaseVendorHolds(env, TKO, { now: LATER + 5 * 3600e3 });
  assert.deepEqual(world.releases, [], 'nothing of theirs is released');
});

test('a bill paid or archived in Ramp while held: the note and the card go', async () => {
  world.bills = [rampBill()];
  await runRamp(env, { now: NOW });
  await runRamp(env, { now: LATER });
  world.bills = [];
  await runRamp(env, { now: LATER + 15 * MIN });
  assert.equal((await row('RB1')).state, 'gone');
  assert.ok(world.pinned.some((u) => u.isPinned === false));
  assert.match(slackText(), /no longer lists it as unpaid/);
});

test('a vendor JobTread doesn’t have is listed, not held', async () => {
  world.bills = [rampBill({ id: 'RB5', vendor: 'Mystery Movers', cents: 777 })];
  const r = await runRamp(env, { now: LATER });
  assert.equal(r.unmatched, 1);
  assert.equal(world.holds.length, 0);
  const v = await rampView(env);
  assert.equal(v.unmatched[0].vendor, 'Mystery Movers');
});

// ─── When Ramp says no ──────────────────────────────────────────────

test('Ramp refusing a hold is kept for the automations map, and the other bills still run', async () => {
  world.bills = [rampBill(), rampBill({ id: 'RB2', vendor: 'Home Depot', cents: 4210, invoice: null })];
  await maybeRunRamp(env, { now: NOW });
  world.holdFails = true;
  const r = await maybeRunRamp(env, { now: LATER });
  assert.equal(r.failed.length, 2);
  const v = await rampView(env);
  assert.match(v.error.error, /^Ramp: hold TKO Plumbing: Ramp said 400/);
  world.holdFails = false;
  await maybeRunRamp(env, { now: LATER + 15 * MIN });
  assert.equal((await rampView(env)).error, null);
});

test('wrong keys say which ones, and with no keys Ramp is never called', async () => {
  world.tokenStatus = 401;
  const r = await maybeRunRamp(env, { now: NOW });
  assert.match(r.error, /RAMP_CLIENT_ID and RAMP_CLIENT_SECRET/);
  world.tokenStatus = 200;
  forgetRampToken();

  const bare = { ...env, RAMP_CLIENT_ID: '', RAMP_CLIENT_SECRET: '' };
  world.tokens = 0;
  assert.equal(await maybeRunRamp(bare, { now: NOW }), null);
  await maybeRunVendors(bare, { now: NOW, force: true });
  assert.equal(world.tokens, 0);
  assert.deepEqual(await rampView(bare), { connected: false });
});
