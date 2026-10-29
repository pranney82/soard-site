/**
 * Chase through Plaid for the board page's cash (functions/api/_plaid.js, bank-admin.js, _board.js cashNow):
 * connecting a bank, reading its balances, a bank that needs signing in again, and the cash adding up with
 * Mercury. Plaid, Mercury and Slack are fakes; nothing leaves the test.
 * Run: node --test tests/plaid.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { linkToken, connectBank, readBanks, maybeReadBanks, bankBalances, bankStatus, disconnectBank, troubleText } from '../functions/api/_plaid.js';
import { cashNow, liveNumbers, ensureSchema } from '../functions/api/_board.js';
import { writeState } from '../functions/api/_board-roles.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import * as bankAdmin from '../functions/api/bank-admin.js';

const FOUNDER = 'jane@soardcharity.com';
const STAFF = 'pat@soardcharity.com';
const T0 = Date.parse('2026-10-29T12:00:00Z');

const CHASE_ACCOUNTS = [
  { account_id: 'a1', name: 'Total Business Checking', mask: '1234', type: 'depository', subtype: 'checking', balances: { current: 412345.67, available: 410000, limit: null, iso_currency_code: 'USD' } },
  { account_id: 'a2', name: 'Business CD', mask: '9876', type: 'depository', subtype: 'cd', balances: { current: 250000, available: null, limit: null, iso_currency_code: 'USD' } },
  { account_id: 'a3', name: 'Ink Business Cash', mask: '5555', type: 'credit', subtype: 'credit card', balances: { current: 4210.5, available: 45789.5, limit: 50000, iso_currency_code: 'USD' } },
  { account_id: 'a4', name: 'Brokerage', mask: '0001', type: 'investment', subtype: 'brokerage', balances: { current: 9e6 } },
];

let env;
let world;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  env = { DB: await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)', 'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)'] }), PLAID_CLIENT_ID: 'client-test', PLAID_SECRET: 'secret-test', SLACK_BOT_TOKEN: 'xoxb-test' };
  await ensureSchema(env.DB);
  await writeState(env.DB, 'settings', { admins: [FOUNDER] });
  await writeSlackConfig(env.DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
  world = { plaid: [], slack: [], items: new Map(), accountsError: null, mercury: null, removed: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.host === 'slack.com') { world.slack.push(body); return Response.json({ ok: true, channel: 'CFIN', ts: `${world.slack.length}.1` }); }
    if (url.host === 'production.plaid.com' || url.host === 'sandbox.plaid.com') {
      world.plaid.push({ host: url.host, path: url.pathname, body, headers: init.headers });
      assert.equal(init.headers['PLAID-CLIENT-ID'], 'client-test');
      assert.equal(init.headers['PLAID-SECRET'], 'secret-test');
      if (url.pathname === '/link/token/create') return Response.json({ link_token: `link-production-${world.plaid.length}`, expiration: '2026-10-29T16:00:00Z' });
      if (url.pathname === '/item/public_token/exchange') {
        const n = world.items.size + 1;
        world.items.set(`access-production-${n}`, `item-${n}`);
        return Response.json({ access_token: `access-production-${n}`, item_id: `item-${n}` });
      }
      if (url.pathname === '/accounts/get') {
        if (world.accountsError) return Response.json({ error_type: 'ITEM_ERROR', error_code: world.accountsError, error_message: 'the login details of this item have changed', display_message: null }, { status: 400 });
        return Response.json({ accounts: CHASE_ACCOUNTS, item: { item_id: world.items.get(body.access_token) } });
      }
      if (url.pathname === '/item/remove') { world.removed.push(body.access_token); return Response.json({ request_id: 'r' }); }
    }
    if (url.host === 'mercury-relay.sunshineonaranneyday.com') return Response.json({ accounts: world.mercury || [] });
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const connectChase = (now = T0) => connectBank(env, { publicToken: 'public-production-11111111-2222-3333-4444-555555555555', institution: { id: 'ins_56', name: 'Chase' }, by: FOUNDER, now });

test('a link token: Chase’s window for transactions (the balances kept fresh), no email sent to Plaid; signing in again uses the same connection', async () => {
  assert.match(await linkToken(env, { email: FOUNDER }), /^link-production-/);
  const first = world.plaid[0];
  assert.equal(first.host, 'production.plaid.com');
  assert.deepEqual(first.body.products, ['transactions']);
  assert.equal(first.body.client_name, 'Sunshine on a Ranney Day');
  assert.match(first.body.user.client_user_id, /^soard-[0-9a-f]{24}$/);
  assert.ok(!JSON.stringify(first.body).includes('jane'), 'a hash, never the email');
  await connectChase();
  await linkToken(env, { email: FOUNDER, itemId: 'item-1' });
  const again = world.plaid.findLast((c) => c.path === '/link/token/create');
  assert.equal(again.body.access_token, 'access-production-1');
  assert.equal(again.body.products, undefined, 'update mode names no products');
  assert.equal(again.body.update.account_selection_enabled, true, 'and can tick more accounts');
  await assert.rejects(linkToken(env, { email: FOUNDER, itemId: 'item-404' }), /isn’t connected/);
});

test('connecting Chase keeps the checking and the CD as cash and the card as owed; an investment account and the token never show', async () => {
  await connectChase();
  const b = await bankBalances(env.DB, { now: T0 });
  assert.deepEqual(b.accounts.map((a) => [a.name, a.kind, a.balance]), [['Chase Total Business Checking', 'checking', 412345.67], ['Chase Business CD', 'cd', 250000]]);
  assert.deepEqual(b.owed.map((o) => [o.name, o.balance, o.limit]), [['Chase Ink Business Cash', 4210.5, 50000]]);
  assert.deepEqual(b.stale, []);
  const s = await bankStatus(env);
  assert.equal(s.banks.length, 1);
  assert.deepEqual(s.banks[0].accounts.map((a) => a.kind), ['checking', 'cd', 'credit card']);
  assert.ok(!JSON.stringify(s).includes('access-production'), 'Settings never sees the token');
  assert.ok(!/412345|250000|4210/.test(JSON.stringify(s)), 'or a balance');
  await assert.rejects(connectBank(env, { publicToken: 'not-a-token', institution: { name: 'Chase' } }), /Plaid’s window/);
});

test('connecting Chase again replaces the old connection, so its money never counts twice', async () => {
  await connectChase();
  await connectChase(T0 + 60000);
  assert.deepEqual(world.removed, ['access-production-1'], 'Plaid forgets the old one');
  const b = await bankBalances(env.DB, { now: T0 });
  assert.equal(b.accounts.length, 2);
});

test('the cash: Chase and Mercury together; Mercury’s finance summary still waits for Mercury to hold money', async () => {
  env.MERCURY_API_TOKEN = 'mercury-token';
  env.MERCURY_RELAY_KEY = 'relay-key';
  world.mercury = [
    { name: 'Mercury Checking ••4053', kind: 'checking', type: 'mercury', status: 'active', currentBalance: 0 },
    { name: 'Mercury Savings ••4068', kind: 'savings', type: 'mercury', status: 'active', currentBalance: 0 },
    // Chase as Mercury sees it, linked there for transfers: never counted from Mercury (Plaid counts it)
    { name: 'Chase', kind: 'externalChecking', type: 'external', status: 'active', currentBalance: 412345.67 },
  ];
  await connectChase();
  const cash = await cashNow(env);
  assert.equal(cash.total, 662345.67, 'checking + CD, the card not taken off');
  assert.equal(cash.mercuryTotal, 0);
  assert.deepEqual(cash.accounts.map((a) => a.bank), ['Chase', 'Chase', 'Mercury', 'Mercury']);
  assert.equal(cash.owed[0].balance, 4210.5);
  const n = await liveNumbers(env, { now: T0 });
  assert.equal(n.cash.total, 662345.67, 'the board page shows the cash');
  assert.equal(n.mercury.empty, true, 'and Mercury is still empty, so no Mercury record on Financials');
  // No Mercury at all: Chase alone
  delete env.MERCURY_API_TOKEN;
  const chaseOnly = await cashNow(env);
  assert.equal(chaseOnly.total, 662345.67);
  assert.equal(chaseOnly.mercuryTotal, null);
});

test('Chase needs signing in again: its last balances stay, dated; Slack says so once, and again when it reads', async () => {
  await connectChase();
  world.accountsError = 'ITEM_LOGIN_REQUIRED';
  await readBanks(env, { now: T0 + 3600e3 });
  await readBanks(env, { now: T0 + 7200e3 });
  const told = world.slack.filter((p) => /Chase needs signing in again/.test(JSON.stringify(p)));
  assert.equal(told.length, 1, 'once, not every read');
  assert.equal(told[0].channel, 'CFIN', 'to the finance channel');
  const s = await bankStatus(env);
  assert.equal(s.banks[0].needsSignIn, true);
  assert.match(s.banks[0].trouble, /^Chase needs signing in again/);
  const b = await bankBalances(env.DB, { now: T0 + 48 * 3600e3 });
  assert.equal(b.accounts[0].balance, 412345.67, 'the last good read stays');
  assert.deepEqual(b.stale, ['Chase'], 'and says it’s old once it’s a day and a half old');
  world.accountsError = null;
  await readBanks(env, { now: T0 + 50 * 3600e3 });
  assert.ok(world.slack.some((p) => /Chase balances are back/.test(JSON.stringify(p))), 'fixed, said under the same post');
  assert.equal((await bankStatus(env)).banks[0].error, null);
});

test('a bank that’s only down for a while waits three days before Slack hears of it', async () => {
  await connectChase();
  world.accountsError = 'INSTITUTION_DOWN';
  await readBanks(env, { now: T0 + 3600e3 });
  assert.equal(world.slack.length, 0);
  await readBanks(env, { now: T0 + 3600e3 + 3 * 86400e3 });
  assert.equal(world.slack.filter((p) => /aren’t coming through/.test(JSON.stringify(p))).length, 1);
  assert.match(troubleText('INSTITUTION_DOWN', 'Chase'), /isn’t answering Plaid/);
});

test('on the heartbeat: every six hours, and nothing without Plaid’s keys', async () => {
  await connectChase();
  const reads = () => world.plaid.filter((c) => c.path === '/accounts/get').length;
  const before = reads();
  assert.equal(await maybeReadBanks(env, { now: T0 + 3600e3 }), null, 'read an hour ago: not due');
  await maybeReadBanks(env, { now: T0 + 6 * 3600e3 + 1000 });
  assert.equal(reads(), before + 1);
  assert.equal(await maybeReadBanks({ ...env, PLAID_SECRET: '' }, { now: T0 + 24 * 3600e3 }), null);
});

test('disconnecting: Plaid forgets it and the cash stops counting it', async () => {
  await connectChase();
  await disconnectBank(env, 'item-1');
  assert.deepEqual(world.removed, ['access-production-1']);
  assert.equal(await bankBalances(env.DB), null);
});

// ─── /api/bank-admin ────────────────────────────────────────────────

const req = (email, body = null) => {
  const request = new Request('https://sunshineonaranneyday.com/api/bank-admin', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const ctx = { request, env, data: { userEmail: email } };
  return (body ? bankAdmin.onRequestPost(ctx) : bankAdmin.onRequestGet(ctx)).then(async (r) => ({ status: r.status, body: await r.json() }));
};

test('/api/bank-admin: the Board area’s admins only; connect, then the status, never a token or a balance', async () => {
  assert.equal((await req(STAFF)).status, 403, 'other staff');
  assert.equal((await req('alex.board@example.com')).status, 403, 'a board member');
  const t = await req(FOUNDER, { action: 'link-token' });
  assert.match(t.body.linkToken, /^link-production-/);
  const c = await req(FOUNDER, { action: 'connect', publicToken: 'public-production-11111111-2222-3333-4444-555555555555', institution: { id: 'ins_56', name: 'Chase' } });
  assert.equal(c.status, 200);
  assert.equal(c.body.status.banks[0].bank, 'Chase');
  assert.ok(!/access-production|412345/.test(JSON.stringify(c.body)));
  const audit = await env.DB.prepare('SELECT entity_name FROM audit_log').all();
  assert.deepEqual(audit.results.map((r) => r.entity_name), ['Bank connected for the board page: Chase']);
  const d = await req(FOUNDER, { action: 'disconnect', itemId: 'item-1' });
  assert.equal(d.body.status.banks.length, 0);
  // Without Plaid's keys: a clear answer, nothing called
  delete env.PLAID_SECRET;
  const none = await req(FOUNDER, { action: 'link-token' });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /PLAID_CLIENT_ID and PLAID_SECRET/);
  assert.equal((await req(FOUNDER)).body.status.configured, false);
});
