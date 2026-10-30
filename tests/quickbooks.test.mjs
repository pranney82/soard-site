/**
 * QuickBooks' year so far for the board page (functions/api/_quickbooks.js, books-admin.js, books-callback.js,
 * _board.js liveNumbers, public/admin/board/money.js withBooks): connecting through Intuit's page, the hourly
 * read with its refreshed tokens, a connection that needs connecting again, and the board's figures against the
 * packet's budget. Intuit and Slack are fakes; nothing leaves the test.
 * Run: node --test tests/quickbooks.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { connectUrl, finishConnect, readBooks, maybeReadBooks, booksNow, booksStatus, booksFacts, disconnectBooks, readProfitAndLoss, yearSoFar, REDIRECT_URI, _resetEndpointsForTests } from '../functions/api/_quickbooks.js';
import { liveNumbers, ensureSchema } from '../functions/api/_board.js';
import { readState, writeState } from '../functions/api/_board-roles.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { onRequest } from '../functions/api/_middleware.js';
import { withBooks, moneyTiles } from '../public/admin/board/money.js';
import * as booksAdmin from '../functions/api/books-admin.js';
import * as booksCallback from '../functions/api/books-callback.js';

const FOUNDER = 'jane@soardcharity.com';
const STAFF = 'pat@soardcharity.com';
const REALM = '9130350000000001';
const T0 = Date.parse('2026-10-29T16:00:00Z');
const HOUR = 60 * 60 * 1000;

/** A Profit and Loss the way QuickBooks sends it: a section per group, each with its total in the Summary */
const section = (group, label, total) => ({ type: 'Section', group, Header: { ColData: [{ value: label }, { value: '' }] }, Rows: { Row: [] }, Summary: { ColData: [{ value: `Total ${label}` }, { value: total }] } });
const summary = (group, label, total) => ({ type: 'Section', group, Summary: { ColData: [{ value: label }, { value: total }] } });
const PL = {
  Header: { ReportName: 'ProfitAndLoss', ReportBasis: 'Accrual', StartPeriod: '2026-01-01', EndPeriod: '2026-10-29', Currency: 'USD' },
  Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] },
  Rows: { Row: [
    section('Income', 'Income', '812345.67'),
    section('COGS', 'Cost of Goods Sold', '40000.00'),
    summary('GrossProfit', 'Gross Profit', '772345.67'),
    section('Expenses', 'Expenses', '398000.14'),
    summary('NetOperatingIncome', 'Net Operating Income', '374345.53'),
    section('OtherIncome', 'Other Income', '9876.00'),
    section('OtherExpenses', 'Other Expenses', '1100.00'),
    summary('NetOtherIncome', 'Net Other Income', '8776.00'),
    summary('NetIncome', 'Net Income', '383121.53'),
  ] },
};

// Intuit's discovery document, as https://developer.api.intuit.com/.well-known/openid_configuration has it
const DISCOVERY = {
  issuer: 'https://oauth.platform.intuit.com/op/v1',
  authorization_endpoint: 'https://appcenter.intuit.com/connect/oauth2',
  token_endpoint: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revocation_endpoint: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
};

let env;
let world;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  env = { DB: await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)', 'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)'] }), QBO_CLIENT_ID: 'client-test', QBO_CLIENT_SECRET: 'secret-test', SLACK_BOT_TOKEN: 'xoxb-test' };
  await ensureSchema(env.DB);
  await writeState(env.DB, 'settings', { admins: [FOUNDER] });
  await writeSlackConfig(env.DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
  world = { tokens: [], reads: [], slack: [], revoked: [], n: 0, refreshError: null, unauthorizedOnce: false, report: PL, fiscal: 'January', discovery: { ...DISCOVERY }, discoveryReads: 0 };
  _resetEndpointsForTests();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.host === 'developer.api.intuit.com' && url.pathname === '/.well-known/openid_configuration') { world.discoveryReads += 1; return world.discovery ? Response.json(world.discovery) : new Response('down', { status: 503 }); }
    if (url.host === 'slack.com') { const body = JSON.parse(init.body); world.slack.push(body); return Response.json({ ok: true, channel: 'CFIN', ts: `${world.slack.length}.1` }); }
    if (url.host === 'oauth.platform.intuit.com') {
      assert.ok(['/oauth2/v1/tokens/bearer', '/oauth2/v2/tokens/bearer'].includes(url.pathname), url.pathname);
      world.tokenPaths = [...(world.tokenPaths || []), url.pathname];
      assert.equal(init.headers.Authorization, `Basic ${btoa('client-test:secret-test')}`);
      const p = Object.fromEntries(new URLSearchParams(init.body));
      world.tokens.push(p);
      if (p.grant_type === 'refresh_token' && world.refreshError) return Response.json({ error: world.refreshError }, { status: 400 });
      world.n += 1;
      return Response.json({ token_type: 'bearer', access_token: `at-${world.n}`, expires_in: 3600, refresh_token: `rt-${world.n}`, x_refresh_token_expires_in: 8726400 });
    }
    if (url.host === 'developer.api.intuit.com' && url.pathname === '/v2/oauth2/tokens/revoke') { world.revoked.push(JSON.parse(init.body).token); return new Response(null, { status: 200 }); }
    if (url.host === 'quickbooks.api.intuit.com' || url.host === 'sandbox-quickbooks.api.intuit.com') {
      world.reads.push({ host: url.host, path: url.pathname, q: Object.fromEntries(url.searchParams), auth: init.headers.Authorization });
      if (world.unauthorizedOnce) { world.unauthorizedOnce = false; return Response.json({ fault: { error: [{ message: 'message=AuthenticationFailed', code: '3200' }], type: 'AUTHENTICATION' } }, { status: 401 }); }
      if (url.pathname === `/v3/company/${REALM}/companyinfo/${REALM}`) return Response.json({ CompanyInfo: { CompanyName: 'Sunshine on a Ranney Day', FiscalYearStartMonth: world.fiscal } });
      if (url.pathname === `/v3/company/${REALM}/reports/ProfitAndLoss`) return world.reportReply ? world.reportReply() : Response.json(world.report);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

/** Connect as a Board admin would: Settings' URL, then Intuit sending them back with a code */
async function connect(now = T0) {
  const state = new URL(await connectUrl(env, { by: FOUNDER, now })).searchParams.get('state');
  return finishConnect(env, { code: 'code-from-intuit', state, realmId: REALM, now });
}

test('Connect: Intuit’s page for the accounting scope, back to /api/books-callback, with a state good once', async () => {
  const u = new URL(await connectUrl(env, { by: FOUNDER, now: T0 }));
  assert.equal(u.origin + u.pathname, 'https://appcenter.intuit.com/connect/oauth2');
  assert.equal(u.searchParams.get('client_id'), 'client-test');
  assert.equal(u.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://sunshineonaranneyday.com/api/books-callback');
  assert.equal(REDIRECT_URI, u.searchParams.get('redirect_uri'));
  assert.match(u.searchParams.get('state'), /^[0-9a-f]{32}$/);
  // Someone else's state, or a late one, is refused before anything reaches Intuit
  await assert.rejects(finishConnect(env, { code: 'c', state: 'f'.repeat(32), realmId: REALM, now: T0 }), (e) => e.code === 'STATE');
  const late = new URL(await connectUrl(env, { by: FOUNDER, now: T0 })).searchParams.get('state');
  await assert.rejects(finishConnect(env, { code: 'c', state: late, realmId: REALM, now: T0 + 16 * 60 * 1000 }), (e) => e.code === 'STATE');
  assert.equal(world.tokens.length, 0);
  delete env.QBO_CLIENT_SECRET;
  await assert.rejects(connectUrl(env, { by: FOUNDER }), (e) => e.code === 'NOT_CONFIGURED');
});

test('connecting: the code for tokens, the company’s name, and the year so far read at once; the state is used up', async () => {
  const state = new URL(await connectUrl(env, { by: FOUNDER, now: T0 })).searchParams.get('state');
  const done = await finishConnect(env, { code: 'code-from-intuit', state, realmId: REALM, now: T0 });
  assert.deepEqual(done, { company: 'Sunshine on a Ranney Day', by: FOUNDER });
  assert.deepEqual(world.tokens[0], { grant_type: 'authorization_code', code: 'code-from-intuit', redirect_uri: REDIRECT_URI });
  const pl = world.reads.find((r) => r.path.endsWith('/reports/ProfitAndLoss'));
  assert.equal(pl.host, 'quickbooks.api.intuit.com');
  assert.deepEqual(pl.q, { start_date: '2026-01-01', end_date: '2026-10-29', minorversion: '75' }, 'the fiscal year to today (Eastern), on the company’s own basis');
  assert.equal(pl.auth, 'Bearer at-1');
  assert.deepEqual(await readState(env.DB, 'books-oauth'), {}, 'used up');
  await assert.rejects(finishConnect(env, { code: 'again', state, realmId: REALM, now: T0 }), (e) => e.code === 'STATE');
  const n = await booksNow(env.DB, { now: T0 });
  assert.deepEqual(n, { company: 'Sunshine on a Ranney Day', year: '2026', from: '2026-01-01', through: '2026-10-29', revenue: 822221.67, expenses: 439100.14, net: 383121.53, basis: 'Accrual', at: new Date(T0).toISOString(), stale: false });
});

test('the Profit and Loss: revenue is Income and Other Income, expenses take in Cost of Goods Sold; a report that doesn’t add up is refused', () => {
  const r = readProfitAndLoss(PL);
  assert.equal(r.revenue, 822221.67);
  assert.equal(r.spent, 439100.14);
  assert.equal(r.net, 383121.53);
  // QuickBooks for nonprofits names them Revenue and Expenditures; a row without its group is found by its words
  const nonprofit = { Header: { ReportBasis: 'Cash' }, Rows: { Row: [
    { Summary: { ColData: [{ value: 'Total Revenue' }, { value: '1,000.50' }] } },
    { Summary: { ColData: [{ value: 'Total Expenditures' }, { value: '400.25' }] } },
    { Summary: { ColData: [{ value: 'Net Revenue' }, { value: '600.25' }] } },
  ] } };
  assert.deepEqual([readProfitAndLoss(nonprofit).revenue, readProfitAndLoss(nonprofit).spent, readProfitAndLoss(nonprofit).basis], [1000.5, 400.25, 'Cash']);
  assert.throws(() => readProfitAndLoss({ Rows: { Row: [section('Income', 'Income', '10')] } }), (e) => e.code === 'SHAPE', 'no net income');
  assert.throws(() => readProfitAndLoss({ Rows: { Row: [section('Income', 'Income', '10'), summary('NetIncome', 'Net Income', '500')] } }), (e) => e.code === 'SHAPE', 'sections that don’t add up');
  // January 1st: nothing booked yet
  assert.equal(readProfitAndLoss({ Header: { Option: [{ Name: 'NoReportData', Value: 'true' }] }, Rows: {} }).revenue, 0);
});

test('Intuit’s addresses come from its discovery document, read once a day; only addresses on intuit.com, else the known ones', async () => {
  world.discovery.token_endpoint = 'https://oauth.platform.intuit.com/oauth2/v2/tokens/bearer';
  await connect();
  assert.deepEqual(world.tokenPaths, ['/oauth2/v2/tokens/bearer'], 'the address the document names today');
  await readBooks(env, { now: T0 + 2 * HOUR });
  assert.equal(world.discoveryReads, 1, 'kept, not asked for each call');
  // A document naming somewhere else never gets the keys; neither does one that can't be read
  _resetEndpointsForTests();
  world.discovery.token_endpoint = 'https://evil.example/oauth2/v1/tokens/bearer';
  await readBooks(env, { now: T0 + 4 * HOUR });
  assert.equal(world.tokenPaths.at(-1), '/oauth2/v1/tokens/bearer');
  _resetEndpointsForTests();
  world.discovery = null;
  assert.equal(new URL(await connectUrl(env, { by: FOUNDER })).origin, 'https://appcenter.intuit.com');
});

test('the fiscal year: January’s is the calendar year; one starting in July is named for the year it ends', () => {
  assert.deepEqual(yearSoFar('2026-10-29', 1), { year: '2026', from: '2026-01-01', through: '2026-10-29' });
  assert.deepEqual(yearSoFar('2026-10-29', 7), { year: 'FY2027', from: '2026-07-01', through: '2026-10-29' });
  assert.deepEqual(yearSoFar('2026-03-02', 7), { year: 'FY2026', from: '2025-07-01', through: '2026-03-02' });
});

test('hourly: the access token is used while it lasts, then refreshed, and Intuit’s newest refresh token is the one kept', async () => {
  await connect();
  assert.equal(await maybeReadBooks(env, { now: T0 + 30 * 60 * 1000 }), null, 'read within the hour');
  const before = world.tokens.length;
  assert.equal((await maybeReadBooks(env, { now: T0 + 40 * 60 * 1000 + HOUR })).ok, true);
  const refresh = world.tokens.at(-1);
  assert.equal(world.tokens.length, before + 1);
  assert.deepEqual(refresh, { grant_type: 'refresh_token', refresh_token: 'rt-1' });
  const row = await env.DB.prepare('SELECT refresh_token, access_token FROM books_link').first();
  assert.deepEqual(row, { refresh_token: 'rt-2', access_token: 'at-2' });
  // A 401 mid-hour (Intuit ended the token early): one fresh token, one more try
  world.unauthorizedOnce = true;
  assert.equal((await readBooks(env, { now: T0 + 3 * HOUR - 50 * 60 * 1000 })).ok, true);
  assert.equal((await env.DB.prepare('SELECT refresh_token FROM books_link').first()).refresh_token, 'rt-3');
  assert.equal(world.slack.length, 0);
});

test('a connection turned off in QuickBooks: the last figures stay with their date, Slack is told once, and again when it reads', async () => {
  await connect();
  world.refreshError = 'invalid_grant';
  const r = await readBooks(env, { now: T0 + 2 * HOUR });
  assert.deepEqual(r, { ok: false, code: 'invalid_grant' });
  assert.equal(world.slack.length, 1);
  assert.match(JSON.stringify(world.slack[0]), /QuickBooks needs connecting again/);
  assert.equal(world.slack[0].channel, 'CFIN', 'the finance channel');
  await readBooks(env, { now: T0 + 3 * HOUR });
  assert.equal(world.slack.length, 1, 'once');
  const n = await booksNow(env.DB, { now: T0 + 40 * HOUR });
  assert.equal(n.revenue, 822221.67, 'the last good figures');
  assert.equal(n.stale, true);
  const s = await booksStatus(env);
  assert.equal(s.connected.needsConnect, true);
  assert.match(s.connected.trouble, /connecting again/);
  assert.deepEqual(await booksFacts(env), { configured: true, company: 'Sunshine on a Ranney Day', readAt: new Date(T0).toISOString(), needsConnect: true, failing: false });
  // Connecting again (the same company) keeps the figures, and the read that works says so on Slack
  world.refreshError = null;
  await connect(T0 + 4 * HOUR);
  assert.equal((await booksStatus(env)).connected.error, null);
  assert.equal(world.slack.filter((p) => /QuickBooks needs connecting again/.test(JSON.stringify(p))).length, 1);
  assert.ok(world.slack.slice(1).some((p) => /QuickBooks reads again/.test(JSON.stringify(p))), 'the thread hears it reads again');
});

test('an API error (a validation fault, a reply that isn’t JSON): kept with its words and Intuit’s intuit_tid, the last figures stay, nothing half-read is shown', async () => {
  await connect();
  world.reportReply = () => Response.json({ Fault: { Error: [{ Message: 'Invalid Date', Detail: 'Invalid date format: start_date', code: '2010' }], type: 'ValidationFault' }, time: '2026-10-29T09:00:00.000-07:00' }, { status: 400, headers: { intuit_tid: '1-6720f3a2-1234abcd5678ef90' } });
  assert.deepEqual(await readBooks(env, { now: T0 + 2 * HOUR }), { ok: false, code: 'QBO_2010' });
  const row = await env.DB.prepare('SELECT error, error_detail FROM books_link').first();
  assert.deepEqual(row, { error: 'QBO_2010', error_detail: 'Invalid date format: start_date (intuit_tid 1-6720f3a2-1234abcd5678ef90)' });
  const s = await booksStatus(env);
  assert.equal(s.connected.intuitTid, '1-6720f3a2-1234abcd5678ef90');
  assert.equal(s.connected.needsConnect, false);
  assert.equal(world.slack.length, 0, 'not on Slack until it has lasted 3 days');
  assert.equal((await booksNow(env.DB, { now: T0 + 2 * HOUR })).revenue, 822221.67, 'the last good figures');
  // A garbled reply (not JSON) is never read as the year's figures
  world.reportReply = () => new Response('<html>oops</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  assert.deepEqual(await readBooks(env, { now: T0 + 3 * HOUR }), { ok: false, code: 'SHAPE' });
  assert.equal((await booksNow(env.DB, { now: T0 + 3 * HOUR })).revenue, 822221.67);
  // Lasting 3 days, Slack hears once
  world.reportReply = () => Response.json({ Fault: { Error: [{ Message: 'Invalid Date', code: '2010' }], type: 'ValidationFault' } }, { status: 400 });
  await readBooks(env, { now: T0 + 2 * HOUR + 73 * HOUR });
  await readBooks(env, { now: T0 + 2 * HOUR + 74 * HOUR });
  assert.equal(world.slack.filter((p) => /QuickBooks isn’t coming through/.test(JSON.stringify(p))).length, 2, 'once for the garbled reply, once when the fault lasted');
  world.reportReply = null;
  assert.equal((await readBooks(env, { now: T0 + 80 * HOUR })).ok, true);
  assert.equal((await env.DB.prepare('SELECT error_detail FROM books_link').first()).error_detail, null);
});

test('Disconnect: Intuit forgets the connection and the board page has no QuickBooks figures', async () => {
  await connect();
  await disconnectBooks(env);
  assert.deepEqual(world.revoked, ['rt-1']);
  assert.equal(await booksNow(env.DB), null);
  assert.equal((await booksStatus(env)).connected, null);
  await assert.rejects(disconnectBooks(env), /isn’t connected/);
});

test('the board’s numbers carry QuickBooks’ year so far; never its tokens', async () => {
  assert.equal((await liveNumbers(env, { now: T0 })).books, null, 'not connected');
  await connect();
  const n = await liveNumbers(env, { now: T0 });
  assert.equal(n.books.revenue, 822221.67);
  assert.equal(n.books.expenses, 439100.14);
  assert.ok(!/at-1|rt-1/.test(JSON.stringify(n)));
});

// ─── The board page's figures (money.js) ────────────────────────────

const SHEET = { year: '2026', asOf: 'September 30, 2026', revenue: { budget: 1000000, actual: 700000 }, expenses: { budget: 600000, actual: 350000 }, programs: { budget: 1, actual: 1 }, meeting: { id: 'm1', date: '2026-10-16' }, file: { id: 'f1' } };
const BOOKS = { company: 'Sunshine on a Ranney Day', year: '2026', from: '2026-01-01', through: '2026-10-29', revenue: 822221.67, expenses: 439100.14, net: 383121.53, at: '2026-10-29T16:00:00.000Z', stale: false };

test('the board page: QuickBooks’ figures against the packet’s budget for the same year, never last year’s', () => {
  assert.equal(withBooks(SHEET, null), SHEET, 'not connected: the sheet as it was');
  const b = withBooks(SHEET, BOOKS);
  assert.deepEqual([b.revenue, b.expenses, b.year, b.asOf, b.live], [{ actual: 822221.67, budget: 1000000 }, { actual: 439100.14, budget: 600000 }, '2026', 'Oct 29, 2026', true]);
  const tiles = moneyTiles({ cash: null, budget: b, n: {} });
  assert.deepEqual(tiles.map((t) => [t.k, t.value, t.pct, t.sub]), [
    ['rev', '$822,222', 82, '82% of the $1M budget, as of Oct 29'],
    ['exp', '$439,100', 73, '73% of the $600K budget, as of Oct 29'],
  ]);
  // January: 2027’s figures before 2027’s budget sheet is in a packet
  const jan = withBooks(SHEET, { ...BOOKS, year: '2027', through: '2027-01-20', revenue: 5000, expenses: 2000 });
  assert.deepEqual(jan.revenue, { actual: 5000, budget: null });
  assert.deepEqual(moneyTiles({ cash: null, budget: jan, n: {} }).map((t) => [t.label, t.pct, t.sub]), [['2027 revenue', null, 'The year so far, as of Jan 20'], ['2027 expenses', null, 'The year so far, as of Jan 20']]);
  // No budget sheet in any packet yet
  assert.deepEqual(withBooks(null, BOOKS).revenue, { actual: 822221.67, budget: null });
});

// ─── /api/books-admin and /api/books-callback ───────────────────────

const req = (email, body = null) => {
  const request = new Request('https://sunshineonaranneyday.com/api/books-admin', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const ctx = { request, env, data: { userEmail: email } };
  return (body ? booksAdmin.onRequestPost(ctx) : booksAdmin.onRequestGet(ctx)).then(async (r) => ({ status: r.status, body: await r.json() }));
};
const callback = (q) => booksCallback.onRequestGet({ env, request: new Request(`https://sunshineonaranneyday.com/api/books-callback?${new URLSearchParams(q)}`) });

test('/api/books-admin and the callback: Board admins only; connect, back to Settings, the status without an amount or a token', async () => {
  assert.equal((await req(STAFF)).status, 403, 'other staff');
  assert.equal((await req('alex.board@example.com')).status, 403, 'a board member');
  const c = await req(FOUNDER, { action: 'connect' });
  assert.equal(c.status, 200);
  const state = new URL(c.body.url).searchParams.get('state');
  const back = await callback({ code: 'code-from-intuit', state, realmId: REALM });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('Location'), 'https://sunshineonaranneyday.com/admin/?books=connected#board/settings');
  const s = await req(FOUNDER);
  assert.equal(s.body.status.connected.company, 'Sunshine on a Ranney Day');
  assert.equal(s.body.status.connected.through, '2026-10-29');
  assert.ok(!/822221|at-1|rt-1|9130350000000001/.test(JSON.stringify(s.body)), 'no amount, token or company id');
  const audit = await env.DB.prepare('SELECT user_email, entity_name FROM audit_log').all();
  assert.deepEqual(audit.results, [{ user_email: FOUNDER, entity_name: 'QuickBooks connected for the board page: Sunshine on a Ranney Day' }]);
  // Cancel on Intuit's page, a state used twice, Intuit refusing
  assert.equal((await callback({ error: 'access_denied', state })).headers.get('Location'), 'https://sunshineonaranneyday.com/admin/?books=declined#board/settings');
  assert.equal((await callback({ code: 'x', state, realmId: REALM })).headers.get('Location'), 'https://sunshineonaranneyday.com/admin/?books=expired#board/settings');
  const d = await req(FOUNDER, { action: 'disconnect' });
  assert.equal(d.body.status.connected, null);
  delete env.QBO_CLIENT_ID;
  const none = await req(FOUNDER, { action: 'connect' });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /QBO_CLIENT_ID and QBO_CLIENT_SECRET/);
});

test('the callback is reachable without an admin sign-in (Intuit’s redirect); books-admin is not', async () => {
  const call = (path) => onRequest({ request: new Request(`https://sunshineonaranneyday.com${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), env: {}, data: {}, next: async () => new Response('next') });
  assert.equal(await (await call('/api/books-callback?code=x&state=y')).text(), 'next');
  assert.notEqual(await (await call('/api/books-admin')).text(), 'next');
});
