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
import { cashOf, connectUrl, finishConnect, readBooks, maybeReadBooks, booksNow, booksStatus, booksFacts, disconnectBooks, readProfitAndLoss, yearSoFar, REDIRECT_URI, _resetEndpointsForTests } from '../functions/api/_quickbooks.js';
import { liveNumbers, ensureSchema } from '../functions/api/_board.js';
import { readState, writeState } from '../functions/api/_board-roles.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { onRequest } from '../functions/api/_middleware.js';
import { withBooks, moneyTiles, moneyFor, booksCash } from '../public/admin/board/money.js';
import * as booksAdmin from '../functions/api/books-admin.js';
import * as booksCallback from '../functions/api/books-callback.js';
import { todayEastern } from '../public/admin/board-shared.js';

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

/** SOARD's chart of accounts the way QuickBooks' query answers (the bank and card accounts, and others it skips) */
const ACCOUNTS = [
  { Id: '35', Name: 'SR1_Opex (0986)', AcctNum: '1000', AccountType: 'Bank', CurrentBalance: 64748.68, Active: true },
  { Id: '94', Name: 'SR4_Long Reserve (8861)', AcctNum: '1001', AccountType: 'Bank', CurrentBalance: 300986.49, Active: true },
  { Name: 'SR5_Income (3552)', AccountType: 'Bank', CurrentBalance: 134504.07, Active: true },
  { Name: 'Mercury Bank', AccountType: 'Bank', CurrentBalance: 2500, Active: true },
  { Name: 'Gift Cards', AccountType: 'Bank', CurrentBalance: 0, Active: true },
  { Name: 'Petty Cash', AccountType: 'Bank', CurrentBalance: 40, Active: true },
  { Name: 'Old Checking', AccountType: 'Bank', CurrentBalance: 999, Active: false },
  { Id: '150', Name: 'CD', AccountType: 'Other Current Asset', CurrentBalance: 100000, Active: true },
  { Id: '151', Name: 'Right of Use Assets', AccountType: 'Other Current Asset', CurrentBalance: 172158.05, Active: true },
  { Id: '152', Name: 'Sunny&Ranney - In-Kind Contributions', AccountType: 'Other Current Asset', CurrentBalance: 226623.48, Active: true },
  { Id: '153', Name: 'CD Interest Receivable', AccountType: 'Other Current Asset', CurrentBalance: 410.5, Active: true },
  { Name: 'Chase C/C 3512', AccountType: 'Credit Card', CurrentBalance: 583.45, Active: true },
  { Id: '201', Name: 'Ramp CC', AccountType: 'Credit Card', CurrentBalance: 2196.28, Active: true },
  { Name: 'American Express', AccountType: 'Credit Card', CurrentBalance: 0, Active: true },
  { Name: 'Accounts Payable', AccountType: 'Accounts Payable', CurrentBalance: 4722.11, Active: true },
];

// SOARD's real bank-account totals at each month's end, Oct 2025 to Oct 29 2026 (QuickBooks' balance sheet)
const BANK_BY_MONTH = [575839.31, 594816.02, 587954.4, 535594.85, 429664.17, 405218.33, 408390.6, 463972.11, 375044.29, 391824.08, 558270.93, 608532.14, 569491.45];
const money2 = (n) => n.toFixed(2);
const monthCols = (n, endToday) => Array.from({ length: n }, (_, i) => {
  const t = new Date(Date.UTC(2025, 9 + i, 1));
  const y = t.getUTCFullYear(); const m = t.getUTCMonth();
  const end = i === n - 1 ? endToday : new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  return { ColTitle: t.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), ColType: 'Money', MetaData: [{ Name: 'StartDate', Value: `${y}-${String(m + 1).padStart(2, '0')}-01` }, { Name: 'EndDate', Value: end }] };
});
/** A Balance Sheet the way QuickBooks' Reports API sends it: ASSETS → Current Assets → Bank Accounts, then liabilities and equity */
function balanceSheet(cols, bank, { cd = 100000 } = {}) {
  const v = (n) => n.map((x) => ({ value: money2(x) }));
  const each = (f) => bank.map(f);
  const data = (name, xs) => ({ type: 'Data', ColData: [{ value: name, id: name.length.toString() }, ...v(xs)] });
  const section = (group, label, rows, total, totalLabel = `Total ${label}`) => ({ type: 'Section', group, Header: { ColData: [{ value: label }, ...cols.map(() => ({ value: '' }))] }, Rows: { Row: rows }, Summary: { ColData: [{ value: totalLabel }, ...v(total)] } });
  const opex = each((b) => b * 0.11); const reserve = each((b) => b * 0.53); const income = each((b, i) => b - opex[i] - reserve[i]);
  const cds = each(() => cd);
  const rou = each(() => 172158.05);
  const assets = each((b) => b + cd + 172158.05);
  const liab = each(() => 114214.19);
  const equity = each((b, i) => assets[i] - liab[i]);
  return {
    Header: { ReportName: 'BalanceSheet', ReportBasis: 'Accrual' },
    Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, ...cols] },
    Rows: { Row: [
      section('TotalAssets', 'ASSETS', [
        section('CurrentAssets', 'Current Assets', [
          section('BankAccounts', 'Bank Accounts', [data('SR1_Opex (0986)', opex), data('SR4_Long Reserve (8861)', reserve), data('SR5_Income (3552)', income)], bank),
          section('OtherCurrentAssets', 'Other Current Assets', [data('CD', cds), data('Right of Use Assets', rou)], each((b, i) => cds[i] + rou[i])),
        ], assets),
      ], assets, 'TOTAL ASSETS'),
      section('TotalLiabilitiesAndEquity', 'LIABILITIES AND EQUITY', [
        section('Liabilities', 'Liabilities', [data('Lease Liabilities - Operating Leases - ST', liab)], liab),
        section('Equity', 'Equity', [data('Retained Earnings', each((x, i) => equity[i] - 50000)), data('Net Income', each(() => 50000))], equity),
      ], each((x, i) => assets[i]), 'TOTAL LIABILITIES AND EQUITY'),
    ] },
  };
}
/** The last 12 months' Profit and Loss, with spending that was never cash (depreciation, in-kind goods) */
const TRAILING = {
  Header: { ReportName: 'ProfitAndLoss', ReportBasis: 'Accrual' },
  Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] },
  Rows: { Row: [
    { type: 'Section', group: 'Income', Header: { ColData: [{ value: 'Revenue' }, { value: '' }] }, Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Contributions' }, { value: '900000.00' }] }] }, Summary: { ColData: [{ value: 'Total Revenue' }, { value: '900000.00' }] } },
    { type: 'Section', group: 'Expenses', Header: { ColData: [{ value: 'Expenditures' }, { value: '' }] }, Rows: { Row: [
      { type: 'Data', ColData: [{ value: 'Makeover Materials' }, { value: '360000.00' }] },
      { type: 'Data', ColData: [{ value: 'Depreciation Expense' }, { value: '24000.00' }] },
      { type: 'Section', Header: { ColData: [{ value: 'In-Kind Expenses' }, { value: '' }] }, Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Donated Furniture' }, { value: '36000.00' }] }] }, Summary: { ColData: [{ value: 'Total In-Kind Expenses' }, { value: '36000.00' }] } },
    ] }, Summary: { ColData: [{ value: 'Total Expenditures' }, { value: '420000.00' }] } },
    { type: 'Section', group: 'NetIncome', Summary: { ColData: [{ value: 'Net Revenue' }, { value: '480000.00' }] } },
  ] },
};
/**
 * The General Ledger of the bank accounts for the last 12 months, the way QuickBooks sends it: a section per account,
 * its Beginning Balance, then each transaction with the account it went to (Split) and the running balance.
 * Out: payroll $50,000, a vendor $30,000, the Ramp card paid $20,000 (cash out); moved to the Long Reserve $100,000 and
 * to the CD $100,000 (SOARD's own accounts, never spent). In: gifts $200,000
 */
function ledger({ flip = false } = {}) {
  const k = flip ? -1 : 1;
  let bal = 500000;
  const row = (date, type, split, amount, splitId) => { bal += amount; return { type: 'Data', ColData: [{ value: date }, { value: type }, { value: '' }, { value: '' }, { value: '' }, { value: split, ...(splitId ? { id: splitId } : {}) }, { value: (k * amount).toFixed(2) }, { value: bal.toFixed(2) }] }; };
  const opex = [
    { type: 'Data', ColData: [{ value: 'Beginning Balance' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '500000.00' }] },
    row('2025-11-03', 'Payroll Check', 'Salaries & Wages', -50000),
    row('2025-12-01', 'Expense', '-Split-', -30000),
    row('2026-01-15', 'Transfer', 'Ramp CC', -20000, '201'),
    row('2026-02-01', 'Transfer', '1001 SR4_Long Reserve (8861)', -100000),
    row('2026-03-01', 'Transfer', 'CD', -100000, '150'),
    row('2026-04-01', 'Deposit', 'Contributions', 200000),
  ];
  return {
    Header: { ReportName: 'GeneralLedger' },
    Columns: { Column: [['Date', 'tx_date'], ['Transaction Type', 'txn_type'], ['Num', 'doc_num'], ['Name', 'name'], ['Memo/Description', 'memo'], ['Split', 'split_acc'], ['Amount', 'subt_nat_amount'], ['Balance', 'rbal_nat_amount']].map(([t, key]) => ({ ColTitle: t, ColType: 'String', MetaData: [{ Name: 'ColKey', Value: key }] })) },
    Rows: { Row: [{ type: 'Section', Header: { ColData: [{ value: 'SR1_Opex (0986)' }] }, Rows: { Row: opex }, Summary: { ColData: [{ value: 'Total for SR1_Opex (0986)' }] } }] },
  };
}

/** The year's Profit and Loss by class (the books keep programs, management and fundraising as classes) */
const BY_CLASS = {
  Columns: { Column: ['', 'Programs', 'Management', 'Fundraising', 'Not Specified', 'Total'].map((t, i) => ({ ColTitle: t, ColType: i ? 'Money' : 'Account' })) },
  Rows: { Row: [
    { type: 'Section', group: 'Expenses', Header: { ColData: [{ value: 'Expenses' }] }, Rows: { Row: [] }, Summary: { ColData: ['Total Expenses', '300000', '60000', '30000', '8000.14', '398000.14'].map((v) => ({ value: v })) } },
    { type: 'Section', group: 'COGS', Header: { ColData: [{ value: 'Cost of Goods Sold' }] }, Rows: { Row: [] }, Summary: { ColData: ['Total Cost of Goods Sold', '40000', '0', '0', '0', '40000'].map((v) => ({ value: v })) } },
  ] },
};

let env;
let world;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  env = { DB: await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)', 'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)'] }), QBO_CLIENT_ID: 'client-test', QBO_CLIENT_SECRET: 'secret-test', SLACK_BOT_TOKEN: 'xoxb-test' };
  await ensureSchema(env.DB);
  await writeState(env.DB, 'settings', { admins: [FOUNDER] });
  await writeSlackConfig(env.DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
  world = { tokens: [], reads: [], slack: [], revoked: [], n: 0, refreshError: null, unauthorizedOnce: false, report: PL, accounts: ACCOUNTS, fiscal: 'January', bookClose: '2026-09-30', byClass: BY_CLASS, discovery: { ...DISCOVERY }, discoveryReads: 0 };
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
      if (url.pathname === `/v3/company/${REALM}/query`) {
        // The budgets, locations and classes, each asked for on its own (or refused, as QuickBooks can)
        const entity = url.searchParams.get('query').match(/^select \* from (Budget|Department|Class) MAXRESULTS 1000$/)?.[1];
        if (entity && world.refuse?.includes(entity)) return Response.json({ Fault: { Error: [{ Message: 'Unsupported Operation', code: '500' }], type: 'ValidationFault' } }, { status: 400 });
        if (entity) return Response.json({ QueryResponse: { [entity]: world[entity] || [] } });
        // Each type asked for on its own; QuickBooks answers only that type
        const type = url.searchParams.get('query').match(/^select \* from Account where AccountType = '([\w ]+)' MAXRESULTS 1000$/)?.[1];
        assert.ok(type, url.searchParams.get('query'));
        const list = world.accounts.filter((a) => a.AccountType === type);
        return Response.json({ QueryResponse: { Account: list, startPosition: 1, maxResults: list.length } });
      }
      if (url.pathname === `/v3/company/${REALM}/preferences`) return Response.json({ Preferences: { AccountingInfoPrefs: { BookCloseDate: world.bookClose, ...world.prefs } } });
      if (url.pathname === `/v3/company/${REALM}/reports/GeneralLedger`) {
        world.ledgerAsk = Object.fromEntries(url.searchParams);
        return world.ledgerReply ? world.ledgerReply() : Response.json(ledger());
      }
      if (url.pathname === `/v3/company/${REALM}/reports/BalanceSheet`) {
        const q = Object.fromEntries(url.searchParams);
        if (q.summarize_column_by === 'Month') return Response.json(balanceSheet(monthCols(13, q.end_date), BANK_BY_MONTH));
        // As of a day: this year's, or a year before (less in the bank)
        const end = q.end_date;
        return Response.json(balanceSheet([{ ColTitle: 'Total', ColType: 'Money' }], [end < '2026-01-01' ? 591000.5 : 608532.14], { cd: end < '2026-01-01' ? 0 : 100000 }));
      }
      if (url.pathname === `/v3/company/${REALM}/reports/ProfitAndLoss`) {
        const q = Object.fromEntries(url.searchParams);
        if (world.reportReply) return world.reportReply(q);
        if (q.summarize_column_by === 'Classes') return Response.json(world.byClass);
        // The last 12 full months (Nov 1 to Oct 31 of the year before's end)
        if (q.start_date !== q.end_date.slice(0, 4) + '-01-01') return Response.json(TRAILING);
        // Last year's (smaller), else this year's
        if (q.start_date < '2026-01-01') return Response.json(scaled(world.report, q.end_date.endsWith('12-31') ? 1.25 : 0.8));
        return Response.json(world.report);
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

/** A Profit and Loss with every amount times k (last year's, smaller or bigger) */
function scaled(report, k) {
  const walk = (rows) => rows.map((r) => ({ ...r, ...(r.ColData ? { ColData: r.ColData.map((c, i) => (i ? { value: (Number(c.value) * k).toFixed(2) } : c)) } : {}), ...(r.Summary ? { Summary: { ColData: r.Summary.ColData.map((c, i) => (i ? { value: (Number(c.value) * k).toFixed(2) } : c)) } } : {}), ...(r.Rows ? { Rows: { Row: walk(r.Rows.Row || []) } } : {}) }));
  return { ...report, Rows: { Row: walk(report.Rows.Row) } };
}

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
  const { company, year, from, through, revenue, expenses, net, basis, at, stale, cash } = n;
  assert.deepEqual({ company, year, from, through, revenue, expenses, net, basis, at, stale }, { company: 'Sunshine on a Ranney Day', year: '2026', from: '2026-01-01', through: '2026-10-29', revenue: 822221.67, expenses: 439100.14, net: 383121.53, basis: 'Accrual', at: new Date(T0).toISOString(), stale: false });
  assert.equal(n.contextAt, new Date(T0).toISOString(), 'the year in context, read at once too');
  assert.equal(cash.total, 602779.24, 'every active bank account on the books, and the CD');
  assert.equal(cash.at, new Date(T0).toISOString());
});

test('SOARD’s year is January to December, even when QuickBooks’ setting says August; Settings says so', async () => {
  world.fiscal = 'August';
  await connect();
  const pl = world.reads.find((r) => r.path.endsWith('/reports/ProfitAndLoss'));
  assert.equal(pl.q.start_date, '2026-01-01');
  assert.equal((await booksNow(env.DB, { now: T0 })).year, '2026');
  assert.equal((await booksStatus(env)).connected.qboYearStarts, 'August');
  // Fixed in QuickBooks: the next hourly read sees it
  world.fiscal = 'January';
  await readBooks(env, { now: T0 + HOUR });
  assert.equal((await booksStatus(env)).connected.qboYearStarts, null);
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

test('the cash on the books: active Bank accounts and the CD by name without ledger digits, cards as owed, nothing else', async () => {
  const { bankByMonth, ownAccounts, cashLike } = await import('../functions/api/_quickbooks.js');
  assert.deepEqual(ACCOUNTS.filter(cashLike).map((a) => a.Name), ['CD']);
  assert.ok(cashLike({ Name: 'Chase Certificate of Deposit', AccountType: 'Other Current Asset' }) && cashLike({ Name: 'Money Market', AccountType: 'Other Current Asset' }));
  // Month ends: the CD found by its id whatever the row says, and a Bank account's own row never counted twice
  const cols = monthCols(2, '2025-11-30');
  const sheet = balanceSheet(cols, [500000, 400000]);
  sheet.Rows.Row[0].Rows.Row[0].Rows.Row[1].Rows.Row[0].ColData[0] = { value: '1050 CD 4 Months', id: '150' };
  assert.deepEqual(bankByMonth(sheet, ownAccounts(ACCOUNTS.filter(cashLike))).map((m) => m.total), [600000, 500000]);
  assert.deepEqual(bankByMonth(sheet).map((m) => m.total), [500000, 400000], 'nothing but the bank accounts without a CD');
  assert.deepEqual(bankByMonth(sheet, ownAccounts([{ Id: '9', Name: 'SR1_Opex (0986)' }])).map((m) => m.total), [500000, 400000], 'inside Bank Accounts already');
  const c = cashOf(ACCOUNTS);
  assert.equal(c.total, 602779.24, 'the CD with the bank accounts, as Chase lists it (an Other Current Asset on the books); not the inactive account, the right-of-use asset, in-kind gifts or the CD’s interest due');
  assert.deepEqual(c.accounts, [{ name: 'Long Reserve', balance: 300986.49 }, { name: 'Income', balance: 134504.07 }, { name: 'CD', balance: 100000 }, { name: 'Opex', balance: 64748.68 }, { name: 'Mercury Bank', balance: 2500 }, { name: 'Petty Cash', balance: 40 }], 'largest first');
  assert.deepEqual(c.owed, [{ name: 'Chase C/C 3512', balance: 583.45 }, { name: 'Ramp CC', balance: 2196.28 }]);
  // A card the books carry as a negative balance is still what's owed
  assert.deepEqual(cashOf([{ Name: 'Ramp CC', AccountType: 'Credit Card', CurrentBalance: -2196.28, Active: true }]).owed, [{ name: 'Ramp CC', balance: 2196.28 }]);
  assert.deepEqual(cashOf([]), { total: 0, accounts: [], owed: [] });
});

test('once a day, the year in context: last year by now and in all, the last 12 months’ cash spending, 13 month-ends, statements as of the books’ close, spending by purpose', async () => {
  await connect();
  const n = await booksNow(env.DB, { now: T0 });
  // Last year: the same days (Jan 1 to Oct 29 2025), and the whole year
  assert.deepEqual(n.lastYear, {
    year: '2025', through: '2025-10-29', revenue: 657777.34, expenses: 351280.11, net: 306497.22, full: { revenue: 1027777.09, expenses: 548875.18, net: 478901.91, nonCash: 0 },
    // Its money by category too (this report's sections carry no accounts, so each is one line), and no in kind spent
    sources: [{ key: 'account:income', name: 'Income', amount: 649876.54, accounts: ['Income'] }, { key: 'other', name: 'Other income', amount: 7900.8, accounts: ['Other Income'] }],
    nonCash: 0,
    // No account of this report's is the store's, so no store (never a store at zero)
    store: null,
  });
  // The last 12 full months (Oct 1 2025 to Sep 30 2026): what left the bank accounts, from their ledger. Payroll, a
  // vendor and the Ramp card's payment are cash out; the moves to the Long Reserve and the CD aren't
  assert.deepEqual(n.trailing, { from: '2025-10-01', through: '2026-09-30', spent: 420000, cashOut: 100000, payments: 3 });
  assert.deepEqual(world.ledgerAsk, { start_date: '2025-10-01', end_date: '2026-09-30', account: '35,94', minorversion: '75' }, 'the bank accounts only');
  // $602,779 in the bank and the CD over $8,333 a month of cash out
  assert.equal(n.perMonth, 8333.33);
  assert.equal(n.monthsOfCash, 72.3);
  // Cash at each month's end: 13 of them, the last as of today; the CD's row counted, the right-of-use asset's not
  assert.equal(n.months.length, 13);
  assert.deepEqual(n.months[0], { month: '2025-10', end: '2025-10-31', total: 675839.31 });
  assert.deepEqual(n.months.at(-1), { month: '2026-10', end: '2026-10-29', total: 669491.45 });
  assert.deepEqual(n.months.map((m) => m.total), BANK_BY_MONTH.map((b) => Math.round((b + 100000) * 100) / 100));
  // The statements as of the books' close (Sep 30), beside Sep 30 2025
  const st = n.statements;
  assert.deepEqual([st.asOf, st.closed, st.priorAsOf], ['2026-09-30', true, '2025-09-30']);
  const pos = st.position;
  assert.deepEqual(pos.find((r) => r.k === 'total' && r.label === 'Total Bank Accounts'), { k: 'total', label: 'Total Bank Accounts', d: 2, a: 608532.14, p: 591000.5 });
  assert.deepEqual(pos.find((r) => r.label === 'Opex'), { k: 'acct', label: 'Opex', d: 3, a: 66938.54, p: 65010.06 }, 'account names without ledger digits');
  assert.deepEqual(pos.find((r) => r.label === 'CD'), { k: 'acct', label: 'CD', d: 3, a: 100000, p: 0 }, 'new this year: last year 0');
  assert.equal(pos[0].k, 'head');
  const act = st.activity;
  assert.deepEqual(act.find((r) => r.k === 'sum' && r.label === 'Net Income'), { k: 'sum', label: 'Net Income', d: 0, a: 383121.53, p: 306497.22 });
  // Spending by purpose: the classes the books keep
  assert.deepEqual(n.functions, { list: [{ name: 'Programs', amount: 340000 }, { name: 'Management', amount: 60000 }, { name: 'Fundraising', amount: 30000 }], total: 438000.14 });
  // Where the year's money came from
  assert.deepEqual(n.sources, [{ key: 'account:income', name: 'Income', amount: 812345.67, accounts: ['Income'] }, { key: 'other', name: 'Other income', amount: 9876, accounts: ['Other Income'] }]);
});

test('cash out reads the ledger whichever way its amounts run, and a ledger it can’t read gives no months of cash, never a guess', async () => {
  const { cashOutOf, ownAccounts } = await import('../functions/api/_quickbooks.js');
  const own = ownAccounts(ACCOUNTS.filter((a) => ['Bank', 'Other Current Asset'].includes(a.AccountType)));
  assert.deepEqual(cashOutOf(ledger(), own), { out: 100000, payments: 3 });
  assert.deepEqual(cashOutOf(ledger({ flip: true }), own), { out: 100000, payments: 3 }, 'amounts carried the other way round');
  assert.throws(() => cashOutOf({ Columns: { Column: [{ ColTitle: 'Date' }] }, Rows: {} }, own), (e) => e.code === 'SHAPE');
  // A ledger of every account (the bank filter ignored): only the bank accounts' sections count
  const banks = ownAccounts(ACCOUNTS.filter((a) => a.AccountType === 'Bank'));
  const all = ledger();
  const expense = JSON.parse(JSON.stringify(all.Rows.Row[0]));
  expense.Header.ColData[0] = { value: 'Salaries & Wages' };
  all.Rows.Row.push(expense);
  assert.deepEqual(cashOutOf(all, own, banks), { out: 100000, payments: 3 });
  // Sub-accounts under a bank: in; a section that's no bank at all: nothing
  assert.deepEqual(cashOutOf({ ...all, Rows: { Row: [expense] } }, own, banks), { out: 0, payments: 0 });
  // A ledger QuickBooks won't give: the rest of the day's read stands, months of cash don't show
  world.ledgerReply = () => Response.json({ Fault: { Error: [{ Message: 'Unsupported', code: '2030' }] } }, { status: 400 });
  await connect();
  const n = await booksNow(env.DB, { now: T0 });
  assert.equal(n.trailing.cashOut, null);
  assert.equal(n.monthsOfCash, null);
  assert.ok(n.statements && n.lastYear, 'the rest of the day’s read');
});

test('the day the statements are as of: the books’ close when it’s the last three months’, else the end of last month', async () => {
  const { closeDay, yearBefore, lastMonthEnd } = await import('../functions/api/_quickbooks.js');
  assert.deepEqual(closeDay('2026-10-29', '2026-09-30'), { asOf: '2026-09-30', closed: true });
  assert.deepEqual(closeDay('2026-10-29', '2026-08-31'), { asOf: '2026-08-31', closed: true });
  assert.deepEqual(closeDay('2026-10-29', '2025-12-31'), { asOf: '2026-09-30', closed: false }, 'a close date nobody keeps up');
  assert.deepEqual(closeDay('2026-10-29', '2026-10-15'), { asOf: '2026-09-30', closed: false }, 'this month is never closed yet');
  assert.deepEqual(closeDay('2026-10-29', null), { asOf: '2026-09-30', closed: false });
  assert.equal(yearBefore('2028-02-29'), '2027-02-28');
  assert.equal(lastMonthEnd('2026-03-15'), '2026-02-28');
});

test('the daily read runs once a day; the hourly read every hour', async () => {
  await connect();
  const count = () => world.reads.filter((r) => r.path.endsWith('/preferences')).length;
  assert.equal(count(), 1, 'at connect');
  await maybeReadBooks(env, { now: T0 + 2 * HOUR });
  assert.equal(count(), 1, 'not again the same day');
  await maybeReadBooks(env, { now: T0 + 24 * HOUR });
  assert.equal(count(), 2, 'the next day');
  // Figures an older deploy kept that morning: read again within the hour, not the next day
  await env.DB.prepare("UPDATE books_daily SET data = json_remove(data, '$.shape')").run();
  await maybeReadBooks(env, { now: T0 + 24 * HOUR + 30 * 60 * 1000 });
  assert.equal(count(), 2, 'not in the hour after a read');
  await maybeReadBooks(env, { now: T0 + 26 * HOUR });
  assert.equal(count(), 3, 'an older deploy’s figures, read again the same day');
  assert.ok((await booksNow(env.DB, { now: T0 + 26 * HOUR })).monthsOfCash > 0, 'with today’s months of cash');
  await maybeReadBooks(env, { now: T0 + 27 * HOUR });
  assert.equal(count(), 3, 'then not again that day');
  // A day with no classes in the books: no spending by purpose, never a guess
  world.byClass = { Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Not Specified' }, { ColTitle: 'Total' }] }, Rows: { Row: [{ group: 'Expenses', Summary: { ColData: [{ value: 'Total Expenses' }, { value: '398000.14' }, { value: '398000.14' }] } }] } };
  await maybeReadBooks(env, { now: T0 + 48 * HOUR });
  assert.equal((await booksNow(env.DB, { now: T0 + 48 * HOUR })).functions, null);
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
  assert.deepEqual([b.revenue, b.expenses, b.year, b.asOf, b.live], [{ actual: 822221.67, budget: 1000000, last: null, lastFull: null }, { actual: 439100.14, budget: 600000, last: null, lastFull: null, inKind: 0 }, '2026', 'Oct 29, 2026', true]);
  const tiles = moneyTiles({ cash: null, budget: b, n: {} });
  assert.deepEqual(tiles.map((t) => [t.k, t.value, t.pct, t.sub]), [
    ['rev', '$822,222', 82, '82% of the $1M budget, as of Oct\u00a029'],
    ['exp', '$439,100', 73, '73% of the $600K budget, as of Oct\u00a029'],
  ]);
  // In kind the books took in and used: in the revenue (SOARD's budget counts it there), never in the expenses (its
  // budget leaves it out); last year's pace the same way once the daily read has it, else none rather than mixed
  const lastYear = { year: '2025', revenue: 700000, expenses: 500000, nonCash: 80000, full: { revenue: 1000000, expenses: 700000, nonCash: 100000 } };
  const k = withBooks(SHEET, { ...BOOKS, nonCash: 100000, lastYear });
  assert.deepEqual(k.expenses, { actual: 339100.14, budget: 600000, last: 420000, lastFull: 600000, inKind: 100000 });
  assert.deepEqual(k.revenue.actual, 822221.67);
  assert.equal(moneyTiles({ cash: null, budget: k, n: {} })[1].sub, '57% of the $600K budget, as of Oct\u00a029 · 70% by now last year · not counting $100K in kind');
  assert.deepEqual(withBooks(SHEET, { ...BOOKS, nonCash: 100000, lastYear: { ...lastYear, nonCash: undefined } }).expenses, { actual: 339100.14, budget: 600000, last: null, lastFull: null, inKind: 100000 });
  // January: 2027’s figures before 2027’s budget sheet is in a packet
  const jan = withBooks(SHEET, { ...BOOKS, year: '2027', from: '2027-01-01', through: '2027-01-20', revenue: 5000, expenses: 2000 });
  assert.deepEqual(jan.revenue, { actual: 5000, budget: null, last: null, lastFull: null });
  assert.deepEqual(moneyTiles({ cash: null, budget: jan, n: {} }).map((t) => [t.label, t.pct, t.sub]), [['2027 revenue', null, 'The year so far, as of Jan\u00a020'], ['2027 expenses', null, 'The year so far, as of Jan\u00a020']]);
  // No budget sheet in any packet yet
  assert.deepEqual(withBooks(null, BOOKS).revenue, { actual: 822221.67, budget: null, last: null, lastFull: null });
});

test('the board page’s cash: QuickBooks’ bank accounts beat the balance sheet and Mercury’s test deposit; a bank read live through Plaid beats QuickBooks; a past meeting keeps its packet', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const at = new Date().toISOString();
  const books = { ...BOOKS, at, cash: { total: 502779.24, accounts: [{ name: 'Opex', balance: 64748.68 }, { name: 'Long Reserve', balance: 300986.49 }], owed: [{ name: 'Ramp CC', balance: 2196.28 }, { name: 'Paid off', balance: 0 }], at } };
  const mercuryOnly = { total: 2500, at, accounts: [{ name: 'Mercury Checking', balance: 2500 }] };
  const data = (numbers) => ({ meetings: [], cashHistory: [], numbers: { cash: null, books: null, ...numbers } });
  const q = await moneyFor(data({ cash: mercuryOnly, books }));
  assert.deepEqual([q.cash.total, q.cash.banks, q.cash.owed, q.cash.today, q.cash.live], [502779.24, ['QuickBooks'], [{ name: 'Ramp CC', balance: 2196.28 }], true, true]);
  const tile = moneyTiles({ cash: q.cash, budget: null, n: {} })[0];
  assert.equal(tile.value, '$502,779');
  assert.match(tile.sub, /^From QuickBooks, as of \d{1,2}:\d{2} [AP]M$/);
  // Chase read live through Plaid: the banks' own balances win
  const chase = { total: 662345.67, at, accounts: [{ bank: 'Chase', name: 'Chase Total Checking', balance: 412345.67 }, { bank: 'Chase', name: 'Chase Business CD', balance: 250000 }] };
  assert.deepEqual((await moneyFor(data({ cash: chase, books }))).cash.banks, ['Chase']);
  // Chase and Mercury together, as SOARD names them: SR numbering dropped, each account with its bank, the months
  // of spending from QuickBooks' 12 months out
  const both = { total: 689341, at, accounts: [
    { bank: 'Chase', name: 'Chase SR2_Makeover', balance: 39180 }, { bank: 'Chase', name: 'Chase SR4_Long Reserve', balance: 300991 }, { bank: 'Chase', name: 'Chase CD 4 MONTHS', balance: 100000 },
    { bank: 'Chase', name: 'Chase SR1_Opex', balance: 246170 }, { bank: 'Mercury', name: 'Opex', balance: 2500 }, { bank: 'Mercury', name: 'Income', balance: 500 },
  ], owed: [{ bank: 'Chase', name: 'Chase Ink Business Cash', balance: 4210.5, limit: 50000 }] };
  const shown = (await moneyFor(data({ cash: both, books: { ...books, perMonth: 30000 } }))).cash;
  assert.deepEqual(shown.accounts.map((a) => a.name), ['Chase Makeover', 'Chase Long Reserve', 'Chase CD 4 MONTHS', 'Chase Opex', 'Mercury Opex', 'Mercury Income']);
  assert.deepEqual(shown.owed.map((o) => o.name), ['Chase Ink Business Cash']);
  assert.deepEqual([shown.banks, shown.months, shown.perMonth], [['Chase', 'Mercury'], 23, 30000]);
  assert.equal(moneyTiles({ cash: shown, budget: null, n: {} })[1].value, '23', 'the Months of cash tile');
  // Chase alone: no bank said twice; two that would read the same keep Chase's own names
  const twins = { total: 2, at, accounts: [{ bank: 'Chase', name: 'Chase SR1_Opex', balance: 1 }, { bank: 'Chase', name: 'Chase SR6_Opex', balance: 1 }] };
  assert.deepEqual((await moneyFor(data({ cash: twins, books: null }))).cash.accounts.map((a) => a.name), ['Chase SR1_Opex', 'Chase SR6_Opex']);
  assert.equal((await moneyFor(data({ cash: chase, books: null }))).cash.months, undefined, 'no books, no months');
  // A past meeting keeps to its own packet (none here), never today's books
  assert.equal((await moneyFor(data({ books }), '2026-01-15')).cash, null);
  assert.equal(booksCash(data({}), { ...books, cash: null }), null);
  // A past meeting with QuickBooks' figures locked into it: those, not today's
  const locked = { ...books, cash: { ...books.cash, total: 480000.5 }, monthsOfCash: 14.2, perMonth: 33800 };
  const past = await moneyFor(data({ books }), '2026-01-15', { books: locked });
  assert.deepEqual([past.cash.total, past.cash.months, past.cash.perMonth], [480000.5, 14.2, 33800]);
  assert.ok(today);
});

test('the figures say where the year stands: months of cash, the budget beside last year’s pace by now, and against last year when there’s no budget', () => {
  const ly = { year: '2025', through: '2025-10-29', revenue: 657777.34, expenses: 351280.11, net: 306497.22, full: { revenue: 1027777.09, expenses: 548875.18, net: 478901.91 } };
  const b = withBooks(SHEET, { ...BOOKS, lastYear: ly });
  const cash = { live: true, total: 502779.24, banks: ['QuickBooks'], today: true, at: new Date().toISOString(), asOf: 'Oct 29, 2026', accounts: [], owed: [], months: 16.8, perMonth: 30000 };
  const tiles = moneyTiles({ cash, budget: b, n: {} });
  assert.deepEqual(tiles.map((t) => [t.k, t.value]), [['bank', '$502,779'], ['months', '17'], ['rev', '$822,222'], ['exp', '$439,100']]);
  assert.equal(tiles[1].sub, 'At $30K a month, the last 12 months’ cash out');
  assert.equal(tiles[2].sub, '82% of the $1M budget, as of Oct\u00a029 · 64% by now last year');
  // No budget for the year yet: against last year's same days
  const nob = withBooks(null, { ...BOOKS, lastYear: ly });
  assert.equal(moneyTiles({ cash: null, budget: nob, n: {} })[0].sub, '▲ 25% on last year by now');
});

test('SOARD’s fiscal year starts in August: the budget sheet whose “as of” day falls in QuickBooks’ year is this year’s, by the sheet’s own name for it', () => {
  const fy = { ...BOOKS, year: 'FY2027', from: '2026-08-01', through: '2026-10-29' };
  // A 2026-27 budget, actuals as of September 30: the same fiscal year, though its heading says 2026
  const sheet = { ...SHEET, year: '2026', label: '2026-27', asOf: 'September 30, 2026' };
  const b = withBooks(sheet, fy);
  assert.deepEqual([b.year, b.revenue.budget, b.expenses.budget], ['2026-27', 1000000, 600000]);
  // Last fiscal year's sheet (as of July 31): its budget isn't this year's
  const old = withBooks({ ...sheet, label: '2025-26', asOf: 'July 31, 2026' }, fy);
  assert.deepEqual([old.year, old.revenue.budget], ['FY2027', null]);
  // A sheet with no readable day goes by its year
  assert.equal(withBooks({ ...SHEET, asOf: '' }, BOOKS).revenue.budget, 1000000);
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
  assert.equal(back.headers.get('Location'), 'https://sunshineonaranneyday.com/admin/?books=connected#settings');
  const s = await req(FOUNDER);
  assert.equal(s.body.status.connected.company, 'Sunshine on a Ranney Day');
  assert.equal(s.body.status.connected.through, todayEastern(), 'read just now, through today');
  assert.ok(!/822221|at-1|rt-1|9130350000000001/.test(JSON.stringify(s.body)), 'no amount, token or company id');
  const audit = await env.DB.prepare('SELECT user_email, entity_name FROM audit_log').all();
  assert.deepEqual(audit.results, [{ user_email: FOUNDER, entity_name: 'QuickBooks connected for the board page: Sunshine on a Ranney Day' }]);
  // Cancel on Intuit's page, a state used twice, Intuit refusing
  assert.equal((await callback({ error: 'access_denied', state })).headers.get('Location'), 'https://sunshineonaranneyday.com/admin/?books=declined#settings');
  assert.equal((await callback({ code: 'x', state, realmId: REALM })).headers.get('Location'), 'https://sunshineonaranneyday.com/admin/?books=expired#settings');
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

test('where the money came from: the income accounts by category, the way SOARD’s books keep them', async () => {
  const { sourcesOf, revenueKind } = await import('../functions/api/_quickbooks.js');
  const acct = (label, value) => ({ type: 'Data', ColData: [{ value: label }, { value }] });
  const group = (label, rows, total, group = undefined) => ({ type: 'Section', ...(group ? { group } : {}), Header: { ColData: [{ value: label }, { value: '' }] }, Rows: { Row: rows }, Summary: { ColData: [{ value: `Total ${label}` }, { value: total }] } });
  // SOARD's chart of accounts (made-up amounts): parent accounts with their own accounts under them, and Other Income
  const report = { Rows: { Row: [
    group('Income', [
      group('4000 Revenue', [acct('4010 Individual/Corporate Revenue', '700000.00'), acct('4020 Grant Revenue', '90000.00'), acct('4030 Makeover Revenue', '45.00')], '790045.00'),
      group('4200 Fundraising Income', [acct('4210 Store Income', '420000.00'), acct('4220 Gala Income', '400000.00'), acct('4230 Store Discounts', '-5000.00')], '815000.00'),
      group('4300 Other Contribution', [acct('4310 Rent Income', '16000.00'), acct('4320 In-Kind Contribution', '220000.00')], '236000.00'),
      acct('4900 Golf Classic Income', '30000.00'),
    ], '1871045.00', 'Income'),
    group('Expenses', [acct('Payroll', '500000.00')], '500000.00', 'Expenses'),
    group('Other Income', [acct('Interest Income', '5000.00')], '5000.00', 'OtherIncome'),
  ] } };
  const s = sourcesOf(report);
  assert.deepEqual(s.map((c) => [c.key, c.name, c.amount]), [
    ['donations', 'Donations', 700000], ['store', 'Store sales', 415000], ['gala', 'Gala', 400000], ['inkind', 'In kind', 220000],
    ['grants', 'Grants', 90000], ['account:golf classic', 'Golf Classic', 30000], ['account:rent', 'Rent', 16000], ['account:interest', 'Interest', 5000], ['account:makeover', 'Makeover', 45],
  ]);
  assert.equal(s.reduce((t, c) => t + c.amount, 0), 1876045, 'every dollar of revenue (Income and Other Income), the store’s discounts netted');
  assert.deepEqual(s.find((c) => c.key === 'store').accounts, ['Store Income', 'Store Discounts'], 'each category names its accounts');
  // In kind is never a cash gift, whatever the account says
  assert.equal(revenueKind('In-Kind Contribution').key, 'inkind');
  assert.equal(revenueKind('Donated goods and services').key, 'inkind');
  assert.equal(revenueKind('Other Contribution').key, 'donations');
  assert.deepEqual(revenueKind('Other Income'), { key: 'other', name: 'Other income' });
});

test('the budget against the actuals: QuickBooks’ budget line for line with the Profit and Loss, by account id, to the statements’ day and for the year', async () => {
  const { budgetOf, pickBudget, budgetYear } = await import('../functions/api/_quickbooks.js');
  // SOARD's Profit and Loss (made-up amounts) the way QuickBooks sends it, each account with its id
  const acct = (id, label, value) => ({ type: 'Data', ColData: [{ value: label, id }, { value }] });
  const group = (label, rows, total, g = undefined, id = undefined) => ({ type: 'Section', ...(g ? { group: g } : {}), Header: { ColData: [{ value: label, ...(id ? { id } : {}) }, { value: '' }] }, Rows: { Row: rows }, Summary: { ColData: [{ value: `Total ${label}` }, { value: total }] } });
  const sum = (g, label, value) => ({ type: 'Section', group: g, Summary: { ColData: [{ value: label }, { value }] } });
  const report = { Rows: { Row: [
    group('Income', [
      group('4000 Revenue', [acct('80', '4010 Individual/Corporate Revenue', '728501.72'), acct('81', '4020 Grant Revenue', '141750.00')], '870251.72', undefined, '79'),
      group('4300 Other Contribution', [acct('86', '4320 In-Kind Contribution', '242778.95')], '242778.95'),
    ], '1113030.67', 'Income'),
    group('Cost of Goods Sold', [acct('90', '5210 Store COGS', '271420.14'), acct('91', '5320 In-Kind Contribution Expense', '242778.95')], '514199.09', 'COGS'),
    sum('GrossProfit', 'Gross Profit', '598831.58'),
    group('Expenses', [group('6010 Payroll Expense', [acct('100', '6011 Salary Expense', '475793.34')], '476793.34', undefined, '99')], '476793.34', 'Expenses'),
    sum('NetOperatingIncome', 'Net Operating Income', '122038.24'),
    group('Other Income', [acct('120', '7010 Interest Income', '44.20')], '44.20', 'OtherIncome'),
    sum('NetOtherIncome', 'Net Other Income', '44.20'),
    sum('NetIncome', 'Net Income', '122082.44'),
  ] } };
  // The budget by the month, January to December: $50,000 a month of gifts, the in kind both ways, salaries, and a
  // merchant fee budgeted with nothing spent on it yet
  const months = (id, name, each) => Array.from({ length: 12 }, (_, i) => ({ AccountRef: { value: id, name }, BudgetDate: `2026-${String(i + 1).padStart(2, '0')}-01`, Amount: each }));
  const fy26 = { Name: 'Budget_FY26_P&L', StartDate: '2026-01-01', EndDate: '2026-12-31', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Yearly', Active: true, BudgetDetail: [
    ...months('80', 'Revenue:Individual/Corporate Revenue', 50000), ...months('86', 'Other Contribution:In-Kind Contribution', 25000), ...months('91', 'In-Kind Contribution Expense', 25000),
    ...months('100', 'Payroll Expense:Salary Expense', 44000), ...months('105', 'Merchant Fee Expense', 40),
  ] };
  // Each account's QuickBooks type (the daily read asks once): what group a budgeted account with nothing on it goes in
  const types = new Map([['80', 'Income'], ['81', 'Income'], ['86', 'Income'], ['90', 'Cost of Goods Sold'], ['91', 'Cost of Goods Sold'], ['100', 'Expense'], ['105', 'Expense'], ['120', 'Other Income']]);
  const b = budgetOf([fy26], report, '2026-10-31', types);
  assert.deepEqual([b.name, b.from, b.to, b.asOf, b.step, b.monthly, b.months, b.of], ['Budget_FY26_P&L', '2026-01-01', '2026-12-31', '2026-10-31', 1, true, 10, 12]);
  const row = (label) => b.rows.find((r) => r.label === label);
  assert.deepEqual(row('Individual/Corporate Revenue'), { k: 'acct', label: 'Individual/Corporate Revenue', d: 2, a: 728501.72, b: 500000, y: 600000 }, 'ten months of its budget, and the year’s');
  assert.deepEqual(row('Grant Revenue'), { k: 'acct', label: 'Grant Revenue', d: 2, a: 141750, b: 0, y: 0 }, 'an account with no budget still shows');
  assert.deepEqual(row('Merchant Fee Expense'), { k: 'acct', label: 'Merchant Fee Expense', d: 1, a: 0, b: 400, y: 480 }, 'budgeted, nothing on it yet: in its group');
  assert.deepEqual(b.rows.find((r) => r.label === 'Payroll Expense' && r.k === 'acct'), { k: 'acct', label: 'Payroll Expense', d: 2, a: 1000, b: 0, y: 0 }, 'a parent account’s own figures on a line of their own');
  assert.deepEqual(row('Total Income'), { k: 'total', label: 'Total Income', d: 0, a: 1113030.67, b: 750000, y: 900000 });
  assert.deepEqual(row('Total Expenses'), { k: 'total', label: 'Total Expenses', d: 0, a: 476793.34, b: 440400, y: 528480 });
  // Gross profit and the nets are the groups' budgets: 750,000 − 250,000 = 500,000; less 440,400; plus no other income budgeted
  assert.deepEqual(row('Gross Profit'), { k: 'sum', label: 'Gross Profit', d: 0, a: 598831.58, b: 500000, y: 600000 });
  assert.deepEqual(row('Net Income'), { k: 'sum', label: 'Net Income', d: 0, a: 122082.44, b: 59600, y: 71520 });
  assert.deepEqual(b.totals, { revenue: 900000, spending: 828480, nonCash: 300000, nonCashIncome: 300000 }, 'the year’s revenue and spending, the in kind said apart on both sides');
  // A budget QuickBooks keeps by the year: the year's spread evenly to the day
  const yearly = { ...fy26, BudgetDetail: [{ AccountRef: { value: '80', name: 'Individual/Corporate Revenue' }, BudgetDate: '2026-01-01', Amount: 600000 }] };
  const y = budgetOf([yearly], report, '2026-10-31', types);
  assert.deepEqual([y.step, y.monthly], [12, false]);
  assert.equal(y.rows.find((r) => r.label === 'Individual/Corporate Revenue').b, 500000);
  // A report without ids: matched by name (the budget names a sub-account "Parent:Child")
  const plain = JSON.parse(JSON.stringify(report).replace(/,"id":"\d+"/g, ''));
  assert.equal(budgetOf([fy26], plain, '2026-10-31', types).rows.find((r) => r.label === 'Salary Expense').b, 440000);
  // By the quarter: each quarter counts for the part of it gone by (August 31: Q1, Q2, two thirds of Q3)
  const quarterly = { ...fy26, BudgetDetail: ['01', '04', '07', '10'].map((m) => ({ AccountRef: { value: '80', name: 'Individual/Corporate Revenue' }, BudgetDate: `2026-${m}-01`, Amount: 300000 })) };
  const q = budgetOf([quarterly], report, '2026-08-31', types);
  assert.deepEqual([q.step, q.months, q.rows.find((r) => r.label === 'Individual/Corporate Revenue').b], [3, 8, 800000]);
  // The books closed mid-month: that month counts for its days gone by (October 15: nine months and 15/31 of October)
  const mid = budgetOf([fy26], report, '2026-10-15', types);
  assert.equal(mid.months, 9.5);
  assert.equal(mid.rows.find((r) => r.label === 'Individual/Corporate Revenue').b, Math.round((450000 + 50000 * 15 / 31) * 100) / 100);
  // A budgeted sub-account with nothing on it yet goes under its parent when the report has it
  const sub = { ...fy26, BudgetDetail: [...fy26.BudgetDetail, ...months('107', 'Payroll Expense:Bonus Expense', 1000)] };
  const withSub = budgetOf([sub], report, '2026-10-31', new Map([...types, ['107', 'Expense']]));
  const at = withSub.rows.findIndex((r) => r.label === 'Bonus Expense');
  assert.deepEqual([withSub.rows[at].d, withSub.rows.slice(0, at).reverse().find((r) => r.k === 'head').label], [2, 'Payroll Expense']);
  // Which budget: SOARD's year's (January to December, whatever QuickBooks' own fiscal year), a whole one before one
  // split by location, then the one changed last
  const split = { ...fy26, Name: 'Store', BudgetDetail: fy26.BudgetDetail.map((x) => ({ ...x, DepartmentRef: { value: '1' } })) };
  const old = { ...fy26, Name: 'FY25', StartDate: '2025-01-01', EndDate: '2025-12-31' };
  const augJul = { ...fy26, Name: 'FY27 (Aug–Jul)', StartDate: '2026-08-01', EndDate: '2027-07-31', BudgetDetail: [...fy26.BudgetDetail, ...months('81', 'Grant Revenue', 1)] };
  const revised = { ...fy26, Name: 'Budget_FY26_P&L revised', MetaData: { LastUpdatedTime: '2026-08-04T10:00:00-07:00' } };
  assert.equal(pickBudget([old, split, augJul, fy26], '2026-10-31').Name, 'Budget_FY26_P&L');
  assert.equal(pickBudget([fy26, revised], '2026-10-31').Name, 'Budget_FY26_P&L revised', 'two for the year: the one changed last');
  assert.equal(pickBudget([old, augJul], '2026-10-31'), null, 'a year that isn’t SOARD’s January to December: none');
  assert.equal(budgetOf([old], report, '2026-10-31', types), null, 'no budget for the year: none');
  // The year in brief for the board's figures: in January, this year's budget though the statements are December's
  const fy27 = { ...fy26, Name: 'Budget_FY27_P&L', StartDate: '2027-01-01', EndDate: '2027-12-31', BudgetDetail: fy26.BudgetDetail.map((x) => ({ ...x, BudgetDate: x.BudgetDate.replace('2026', '2027') })) };
  assert.deepEqual(budgetYear([fy26, fy27], '2027-01-10', types), { name: 'Budget_FY27_P&L', year: '2027', revenue: 900000, spending: 828480, nonCash: 300000, nonCashIncome: 300000 });
  assert.equal(budgetYear([fy26], '2027-01-10', types), null);
});

test('what else the books keep, for Settings: each budget’s months and how it’s kept, locations and classes by name, never an amount', async () => {
  // SOARD's budget the way QuickBooks' query answers it (made-up amounts): a P&L budget by month, its fiscal year
  // starting in August, two accounts; locations off, classes on
  const line = (account, date, amount) => ({ AccountRef: { value: account, name: `Account ${account}` }, BudgetDate: date, Amount: amount });
  world.Budget = [{ Id: '1', Name: 'Budget_FY26_P&L', StartDate: '2025-08-01', EndDate: '2026-07-31', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', Active: true,
    BudgetDetail: [line('80', '2025-08-01', 50000), line('80', '2025-09-01', 50000), line('81', '2025-08-01', 58333.33)] }];
  world.Class = [{ Name: 'Makeovers', Active: true }, { Name: 'Fundraising', Active: true }, { Name: 'Old', Active: false }];
  world.prefs = { ClassTrackingPerTxnLine: true, TrackDepartments: false };
  await connect();
  const s = (await booksStatus(env)).connected.setup;
  assert.deepEqual(s, {
    tracking: { locations: false, locationWord: '', classes: true },
    budgets: [{ name: 'Budget_FY26_P&L', type: 'ProfitAndLoss', by: 'Monthly', from: '2025-08-01', to: '2026-07-31', active: true, accounts: 2, splits: [], months: 2, step: 1 }],
    locations: null, classes: ['Makeovers', 'Fundraising'],
  });
  assert.ok(!/50000|58333/.test(JSON.stringify(await booksStatus(env))), 'never an amount');
  // A part QuickBooks refuses is said so, and the day's read (and the rest of what it keeps) stands
  world.Budget = null;
  world.refuse = ['Budget'];
  world.prefs = { TrackDepartments: true, DepartmentTerminology: 'Location' };
  world.Department = [{ Name: 'Store', FullyQualifiedName: 'Store', Active: true }];
  await maybeReadBooks(env, { now: T0 + 25 * HOUR });
  const t = (await booksStatus(env)).connected.setup;
  assert.equal(t.budgets.error, 'QBO_500', 'with QuickBooks’ own code');
  assert.deepEqual([t.tracking, t.locations, t.classes], [{ locations: true, locationWord: 'Location', classes: false }, ['Store'], null]);
  assert.ok((await booksNow(env.DB, { now: T0 + 25 * HOUR })).statements, 'the statements still read');
});

test('the store by its own location: the Store column of a Profit and Loss by location, every account tagged to it and its groups', async () => {
  const { storeByLocation } = await import('../functions/api/_quickbooks.js');
  const cols = ['', 'Store', 'Not Specified', 'Total'];
  const row = (label, ...v) => ({ type: 'Data', ColData: [label, ...v].map((value) => ({ value })) });
  const sec = (group, label, rows, ...tot) => ({ type: 'Section', group, Header: { ColData: [{ value: label }] }, Rows: { Row: rows }, Summary: { ColData: [`Total ${label}`, ...tot].map((value) => ({ value })) } });
  const report = { Columns: { Column: cols.map((t) => ({ ColTitle: t })) }, Rows: { Row: [
    sec('Income', 'Income', [row('4210 Store Income', '459452.59', '0', '459452.59'), row('4010 Individual/Corporate Revenue', '0', '728501.72', '728501.72')], '459452.59', '728501.72', '1187954.31'),
    sec('COGS', 'Cost of Goods Sold', [row('5210 Store COGS', '271420.14', '0', '271420.14')], '271420.14', '0', '271420.14'),
    sec('Expenses', 'Expenses', [sec(undefined, '6010 Payroll Expense', [row('6011 Salary Expense', '80000', '395793.34', '475793.34')], '80000', '395793.34', '475793.34'), row('6021 Rent Expense', '60000', '55966.58', '115966.58')], '140000', '451759.92', '591759.92'),
  ] } };
  const s = storeByLocation(report);
  assert.deepEqual([s.location, s.income, s.cogs, s.expenses, s.net, s.untagged], ['Store', 459452.59, 271420.14, 140000, 48032.45, 451759.92]);
  assert.deepEqual(s.accounts.map((a) => [a.label, a.group, a.amount]), [['Store Income', 'Income', 459452.59], ['Store COGS', 'COGS', 271420.14], ['Salary Expense', 'Expenses', 80000], ['Rent Expense', 'Expenses', 60000]], 'its staff and rent, when they’re tagged to it');
  assert.equal(storeByLocation({ Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Total' }] }, Rows: { Row: [] } }), null, 'no store location: none');
});

test('the store: the accounts named for it (sales, cost of goods, the sales tax a shop keeps), in kind left out, profit before the shared staff and rent', async () => {
  const { storeOf } = await import('../functions/api/_quickbooks.js');
  const acct = (label, value) => ({ type: 'Data', ColData: [{ value: label }, { value }] });
  const group = (label, rows, total, group = undefined) => ({ type: 'Section', ...(group ? { group } : {}), Header: { ColData: [{ value: label }, { value: '' }] }, Rows: { Row: rows }, Summary: { ColData: [{ value: `Total ${label}` }, { value: total }] } });
  // SOARD's chart of accounts (made-up amounts): Store Income under Fundraising Income, Store COGS beside the gala's
  // and the in-kind costs, the shops' vendor compensation under Other Income, staff and rent shared
  const report = { Rows: { Row: [
    group('Income', [
      group('4200 Fundraising Income', [acct('4210 Store Income', '459452.59'), acct('4220 Gala Income', '414888.65')], '874341.24'),
      group('4300 Other Contribution', [acct('4320 In-Kind Contribution', '242778.95')], '242778.95'),
    ], '1117120.19', 'Income'),
    group('Cost of Goods Sold', [acct('5010 Makeover COGS', '289494.01'), acct('5210 Store COGS', '271420.14'), acct('5220 Gala Expense', '55973.42'), acct('5320 In-Kind Contribution Expense', '242778.95'), acct('S&R In-Kind Donations Expense', '1000.00')], '860666.52', 'COGS'),
    group('Expenses', [group('6010 Payroll Expense', [acct('6011 Salary Expense', '475793.34')], '475793.34'), acct('6021 Rent Expense', '115966.58')], '591759.92', 'Expenses'),
    group('Other Income', [acct('7010 Interest Income', '44.20'), acct('Partly Sunny - Vendor Compensation', '874.05'), acct('Sunny&Ranney - Vendor Compensation', '0.00')], '918.25', 'OtherIncome'),
  ] } };
  assert.deepEqual(storeOf(report), {
    sales: 460326.64, cost: 271420.14, profit: 188906.5,
    salesAccounts: ['Store Income', 'Partly Sunny - Vendor Compensation'], costAccounts: ['Store COGS'],
  });
  // The revenue's "Store sales" are the same accounts, so Home's two store figures always agree
  const { sourcesOf } = await import('../functions/api/_quickbooks.js');
  assert.equal(sourcesOf(report).find((c) => c.key === 'store').amount, 460326.64);
  assert.deepEqual(sourcesOf(report).find((c) => c.key === 'store').accounts, ['Store Income', 'Partly Sunny - Vendor Compensation']);
  // Books without a store account have no store, rather than a store at zero; nor do books whose only one is at zero
  assert.equal(storeOf({ Rows: { Row: [group('Income', [acct('Grant Revenue', '100.00')], '100.00', 'Income')] } }), null);
  assert.equal(storeOf({ Rows: { Row: [group('Other Income', [acct('Sunny&Ranney - Vendor Compensation', '0.00')], '0.00', 'OtherIncome')] } }), null);
  // On the board page: a store with costs before its first sale still shows (in the new year's first days), and a line
  // that hasn't moved says so
  const { storeOf: shown, storeChange } = await import('../public/admin/board/money.js');
  const early = shown({ year: '2027', store: { sales: 0, cost: 500, profit: -500, salesAccounts: [], costAccounts: ['Store COGS'] } });
  assert.deepEqual(early.lines.map((x) => [x.k, x.amount]), [['sales', 0], ['cost', 500], ['profit', -500]]);
  assert.equal(shown({ year: '2027', store: { sales: 0, cost: 0, profit: 0 } }), null);
  assert.equal(storeChange({ k: 'sales', amount: 100, last: 100 }), 'Even');
  assert.equal(storeChange({ k: 'profit', amount: 50, last: 80 }), '▼ $30');
  assert.equal(storeOf(null), null);
  // A word that only looks like the store's ("Restoration", "Workshop fees" are SOARD's own words for other things) isn't
  const near = storeOf({ Rows: { Row: [group('Expenses', [acct('Restoration Supplies', '50.00'), acct('Workshop fees', '20.00'), acct('Utilities & Repairs', '10.00')], '80.00', 'Expenses')] } });
  assert.equal(near, null);
});

test('spending that never left the bank: the in-kind expense the books keep beside the in-kind gift, and depreciation', async () => {
  const { nonCashOf } = await import('../functions/api/_quickbooks.js');
  const acct = (label, value) => ({ type: 'Data', ColData: [{ value: label }, { value }] });
  const group = (label, rows, total, group = undefined) => ({ type: 'Section', ...(group ? { group } : {}), Header: { ColData: [{ value: label }, { value: '' }] }, Rows: { Row: rows }, Summary: { ColData: [{ value: `Total ${label}` }, { value: total }] } });
  // SOARD's books (made-up amounts): In-Kind Contribution Expense under Cost of Goods Sold, matching the gift
  const report = { Rows: { Row: [
    group('Income', [group('4300 Other Contribution', [acct('4320 In-Kind Contribution', '226185.37')], '226185.37')], '226185.37', 'Income'),
    group('Cost of Goods Sold', [acct('5010 Store COGS', '600000.00'), acct('5090 In-Kind Contribution Expense', '226185.37')], '826185.37', 'COGS'),
    group('Expenses', [group('6010 Payroll Expense', [acct('6011 Wages', '400000.00')], '400000.00'), acct('6900 Depreciation Expense', '12000.00')], '412000.00', 'Expenses'),
    group('Other Expenses', [acct('Interest Expense', '500.00')], '500.00', 'OtherExpenses'),
  ] } };
  assert.equal(nonCashOf(report), 238185.37, 'the in-kind expense and depreciation; never the in-kind gift itself, wages or interest');
  assert.equal(nonCashOf({ Rows: { Row: [group('Expenses', [acct('Rent', '100.00')], '100.00', 'Expenses')] } }), 0);
  // Spending by purpose leaves it out too, each class its own share of it
  const { functionsOf } = await import('../functions/api/_quickbooks.js');
  const cols = ['', 'Programs', 'Fundraising', 'Total'];
  const row = (label, ...v) => ({ type: 'Data', ColData: [label, ...v].map((value) => ({ value })) });
  const byClass = { Columns: { Column: cols.map((t) => ({ ColTitle: t })) }, Rows: { Row: [
    { type: 'Section', group: 'COGS', Header: { ColData: [{ value: 'Cost of Goods Sold' }] }, Rows: { Row: [row('5010 Store COGS', '0', '600000', '600000'), row('5090 In-Kind Contribution Expense', '200000', '26185.37', '226185.37')] }, Summary: { ColData: ['Total Cost of Goods Sold', '200000', '626185.37', '826185.37'].map((value) => ({ value })) } },
    { type: 'Section', group: 'Expenses', Header: { ColData: [{ value: 'Expenses' }] }, Rows: { Row: [row('Wages', '300000', '100000', '400000')] }, Summary: { ColData: ['Total Expenses', '300000', '100000', '400000'].map((value) => ({ value })) } },
  ] } };
  assert.deepEqual(functionsOf(byClass), { list: [{ name: 'Fundraising', amount: 700000 }, { name: 'Programs', amount: 300000 }], total: 1000000 });
});
