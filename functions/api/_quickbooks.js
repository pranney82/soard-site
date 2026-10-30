/**
 * QuickBooks Online, read-only: the year's revenue and expenses so far, for the board page
 * ===========================================================================
 * Env: QBO_CLIENT_ID and QBO_CLIENT_SECRET (developer.intuit.com → SOARD's app → Keys and credentials,
 * Production), QBO_ENV = 'sandbox' only to try it with Intuit's sandbox company. Nothing else: a Board admin
 * connects SOARD's company once in Settings → QuickBooks (System → Settings in the admin). Intuit's own page signs in and asks which
 * company; SOARD never sees the password. The app's redirect URI is REDIRECT_URI (/api/books-callback, public:
 * the one-time `state` Settings made is its proof, and the code it carries is useless without the keys).
 *
 * Read-only: the accounting scope, but only the company's name, its Profit and Loss and its accounts are ever
 * asked for. Hourly on the board heartbeat, the Profit and Loss from January 1 to today (SOARD's fiscal year is the
 * calendar year, whatever the company's QuickBooks setting says; Settings flags a different one), on the company's own basis (what its reports show by default). Revenue is Income plus Other Income;
 * expenses are Cost of Goods Sold, Expenses and Other Expenses (what the store sold cost money too). And the
 * cash: each active Bank account's balance on the books, with the Credit Card accounts as owed. Once a day, the year
 * in context (readDaily): last year's same days and whole year, the last 12 months' spending (and how much of it was
 * never cash), cash at each month's end for 13 months, the statements of financial position and activities as of
 * the books' close beside the same day a year before, and spending by purpose when the books keep it by class.
 * Months of cash go by the cash that left the bank accounts (their General Ledger), never the books' expenses: SOARD's
 * in-kind gifts are expenses but never cash.
 *
 * D1 books_link keeps one row: the company, its tokens (never sent to a browser), the year so far as last
 * read, and any trouble (its code, words and Intuit's intuit_tid, which Intuit's support asks for; the same in
 * the logs). Intuit's access token lasts an hour and its refresh token about 100 days, renewed by
 * every refresh, so the hourly read keeps the connection alive by itself. When it can't (the app disconnected
 * in QuickBooks, the keys changed), Slack says so once and Settings offers "Connect QuickBooks again"; the
 * board page keeps the last figures, with their date.
 */

import { slackIssue, slackResolved, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { readState, writeState } from './_board-roles.js';
import { todayEastern } from '../../public/admin/board-shared.js';

// Intuit's OAuth addresses come from its discovery document (Intuit asks apps to read them there); these are
// what it has always named, for when the document can't be read
const DISCOVERY = { production: 'https://developer.api.intuit.com/.well-known/openid_configuration', sandbox: 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration' };
const KNOWN = { authorize: 'https://appcenter.intuit.com/connect/oauth2', token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', revoke: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke' };
const DISCOVERY_MS = 24 * 60 * 60 * 1000;
const HOSTS = { production: 'https://quickbooks.api.intuit.com', sandbox: 'https://sandbox-quickbooks.api.intuit.com' };
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '75';
export const REDIRECT_URI = `${SITE_ORIGIN}/api/books-callback`;
export const SETTINGS_URL = `${SITE_ORIGIN}/admin/#settings`;
/** The year so far older than this shows its date on the board page */
export const STALE_MS = 36 * 60 * 60 * 1000;
const READ_EVERY_MS = 60 * 60 * 1000;
// Connect's one-time state: used once, within this long of pressing Connect
const STATE_MS = 15 * 60 * 1000;
// A fresh access token is fetched when the one kept has less than this left
const TOKEN_SLACK_MS = 5 * 60 * 1000;
// Anything else (QuickBooks down for a while) tells Slack only once it has lasted this long
const TELL_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const ID = 'qbo';
const SLACK_KEY = 'books:qbo';

const SCHEMA = 'CREATE TABLE IF NOT EXISTS books_link (id TEXT PRIMARY KEY, realm_id TEXT NOT NULL, company TEXT, fiscal_start INTEGER, access_token TEXT, access_expires TEXT, refresh_token TEXT NOT NULL, refresh_expires TEXT, ytd TEXT, read_at TEXT, tried_at TEXT, error TEXT, error_at TEXT, error_detail TEXT, told TEXT, linked_at TEXT, linked_by TEXT)';
// Once a day, the year in context (last year, the last 12 months, cash at each month's end, the statements): its own row
const DAILY_SCHEMA = 'CREATE TABLE IF NOT EXISTS books_daily (id TEXT PRIMARY KEY, data TEXT, day TEXT, read_at TEXT, tried_at TEXT, error TEXT)';
const _ready = new WeakSet();
async function ready(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  await DB.prepare(DAILY_SCHEMA).run();
  _ready.add(DB);
}
const linkRow = (DB) => DB.prepare('SELECT * FROM books_link WHERE id = ?').bind(ID).first();

export const booksConfigured = (env) => !!String(env.QBO_CLIENT_ID || '').trim() && !!String(env.QBO_CLIENT_SECRET || '').trim();
const envName = (env) => (String(env.QBO_ENV || '').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production');
const iso = (ms) => new Date(ms).toISOString();
const cleanText = (s, n = 80) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const notConfigured = () => Object.assign(new Error('QBO_CLIENT_ID and QBO_CLIENT_SECRET are not set'), { status: 409, code: 'NOT_CONFIGURED' });

// ─── Intuit's tokens ────────────────────────────────────────────────

/** Intuit's reference for a call (the intuit_tid header), which its support asks for */
const tidOf = (r) => cleanText(r?.headers?.get?.('intuit_tid'), 80) || null;
/** An error as kept and logged: its words, and Intuit's reference */
const detailOf = (err) => cleanText(`${err.message}${err.tid ? ` (intuit_tid ${err.tid})` : ''}`, 300);

const _endpoints = new Map();
export const _resetEndpointsForTests = () => _endpoints.clear();
// Only an https address on Intuit's own domain is ever sent a secret or a person
const intuitUrl = (u) => typeof u === 'string' && /^https:\/\/([a-z0-9-]+\.)*intuit\.com\//i.test(u);
/** Intuit's authorize, token and revoke addresses, as its discovery document names them today (kept a day) */
async function endpoints(env, { fetchImpl }) {
  const name = envName(env);
  const kept = _endpoints.get(name);
  if (kept && Date.now() - kept.at < DISCOVERY_MS) return kept.value;
  try {
    const r = await fetchImpl(DISCOVERY[name], { headers: { Accept: 'application/json' } });
    const j = r.ok ? await r.json() : {};
    if (![j.authorization_endpoint, j.token_endpoint, j.revocation_endpoint].every(intuitUrl)) throw new Error(r.ok ? 'it names an address off intuit.com' : `Intuit answered ${r.status}`);
    const value = { authorize: j.authorization_endpoint, token: j.token_endpoint, revoke: j.revocation_endpoint };
    _endpoints.set(name, { at: Date.now(), value });
    return value;
  } catch (err) {
    // Asked again next time; the known addresses meanwhile
    console.error('[books] discovery document', err.message);
    return KNOWN;
  }
}

/** Intuit's token endpoint (a code, or a refresh). Throws an Error with .code (Intuit's `error`, e.g. invalid_grant) */
async function tokenCall(env, params, { fetchImpl }) {
  const basic = btoa(`${String(env.QBO_CLIENT_ID).trim()}:${String(env.QBO_CLIENT_SECRET).trim()}`);
  const r = await fetchImpl((await endpoints(env, { fetchImpl })).token, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error(j.error_description || j.error || `Intuit answered ${r.status}`), { status: r.status, code: j.error || `HTTP_${r.status}`, tid: tidOf(r) });
  return j;
}
const tokenFields = (t, now, row = {}) => ({
  access_token: t.access_token,
  access_expires: iso(now + (Number(t.expires_in) || 3600) * 1000),
  // Intuit may hand back a new refresh token: from here on only the newest is sure to work
  refresh_token: t.refresh_token || row.refresh_token,
  refresh_expires: t.x_refresh_token_expires_in ? iso(now + Number(t.x_refresh_token_expires_in) * 1000) : row.refresh_expires || null,
});

/** An access token with time left: the one kept, else a refresh (kept before it's used) */
async function accessToken(env, row, { fetchImpl, now, force = false }) {
  if (!force && row.access_token && Date.parse(row.access_expires || '') - now > TOKEN_SLACK_MS) return row.access_token;
  const f = tokenFields(await tokenCall(env, { grant_type: 'refresh_token', refresh_token: row.refresh_token }, { fetchImpl }), now, row);
  await env.DB.prepare('UPDATE books_link SET access_token = ?, access_expires = ?, refresh_token = ?, refresh_expires = ? WHERE id = ?')
    .bind(f.access_token, f.access_expires, f.refresh_token, f.refresh_expires, ID).run();
  Object.assign(row, f);
  return f.access_token;
}

/** One QuickBooks read. Throws an Error with .code: UNAUTHORIZED, FORBIDDEN, QBO_<code> or HTTP_<status> */
async function qbo(env, realm, token, path, query, { fetchImpl }) {
  const u = new URL(`${HOSTS[envName(env)]}/v3/company/${encodeURIComponent(realm)}${path}`);
  for (const [k, v] of Object.entries({ ...query, minorversion: MINOR_VERSION })) u.searchParams.set(k, v);
  const r = await fetchImpl(u.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  const fault = j.Fault?.Error?.[0] || j.fault?.error?.[0] || null;
  if (!r.ok || fault) {
    const code = r.status === 401 ? 'UNAUTHORIZED' : r.status === 403 ? 'FORBIDDEN' : fault?.code ? `QBO_${fault.code}` : `HTTP_${r.status}`;
    throw Object.assign(new Error(fault?.Detail || fault?.Message || `QuickBooks answered ${r.status}`), { status: r.status, code, tid: tidOf(r) });
  }
  return j;
}

/** A read with the row's token; a 401 (the hour ran out early) gets one fresh token and one more try */
async function read(env, row, path, query, { fetchImpl, now }) {
  try {
    return await qbo(env, row.realm_id, await accessToken(env, row, { fetchImpl, now }), path, query, { fetchImpl });
  } catch (err) {
    if (err.code !== 'UNAUTHORIZED') throw err;
    return qbo(env, row.realm_id, await accessToken(env, row, { fetchImpl, now, force: true }), path, query, { fetchImpl });
  }
}

// ─── What the troubles mean, in words ───────────────────────────────

/** Codes only connecting again fixes */
const CONNECT_AGAIN = new Set(['invalid_grant', 'UNAUTHORIZED', 'FORBIDDEN']);
export const needsConnect = (code) => CONNECT_AGAIN.has(code);
export function troubleText(code) {
  if (!code) return '';
  if (code === 'invalid_grant' || code === 'UNAUTHORIZED') return 'QuickBooks needs connecting again: the connection was turned off in QuickBooks, or went unused too long.';
  if (code === 'FORBIDDEN') return 'QuickBooks refused the read. Whoever connected it may no longer be an admin there: connect it again as a QuickBooks admin.';
  if (code === 'invalid_client') return 'Intuit doesn’t accept the keys in Cloudflare (QBO_CLIENT_ID and QBO_CLIENT_SECRET). Copy them again from the Production keys.';
  if (code === 'NOT_CONFIGURED') return 'QuickBooks’ keys aren’t in Cloudflare.';
  if (code === 'SHAPE') return 'QuickBooks’ Profit and Loss came back in a shape the site doesn’t read, so its figures weren’t used.';
  return `QuickBooks couldn’t be read (${code}). It tries again by itself.`;
}

// ─── Connecting SOARD's company ─────────────────────────────────────

/** Intuit's sign-in page, with a state good for one use in the next 15 minutes */
export async function connectUrl(env, { by = '', fetchImpl = fetch, now = Date.now() } = {}) {
  if (!booksConfigured(env)) throw notConfigured();
  const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await writeState(env.DB, 'books-oauth', { state, by: cleanText(by, 120), at: iso(now) });
  const q = new URLSearchParams({ client_id: String(env.QBO_CLIENT_ID).trim(), response_type: 'code', scope: SCOPE, redirect_uri: REDIRECT_URI, state });
  return `${(await endpoints(env, { fetchImpl })).authorize}?${q}`;
}

/** SOARD's fiscal year starts in January */
const SOARD_YEAR_STARTS = 1;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** QuickBooks' FiscalYearStartMonth ("January") → 1..12, January when it's missing */
const monthNumber = (name) => MONTHS.indexOf(String(name || '').trim().toLowerCase()) + 1 || 1;

/**
 * Intuit sent the admin back: check the state (once only), keep the company's tokens in place of any earlier
 * connection, and read the year so far now. → { company, by }
 */
export async function finishConnect(env, { code, state, realmId, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!booksConfigured(env)) throw notConfigured();
  await ready(env.DB);
  const pending = await readState(env.DB, 'books-oauth');
  const fresh = pending.state && now - Date.parse(pending.at || '') < STATE_MS;
  if (!fresh || !state || state !== pending.state) throw Object.assign(new Error('That sign-in didn’t start from Board → Settings, or took longer than 15 minutes'), { status: 400, code: 'STATE' });
  await writeState(env.DB, 'books-oauth', {});
  if (!/^\d{1,24}$/.test(String(realmId || '')) || !code) throw Object.assign(new Error('Intuit didn’t say which company'), { status: 400, code: 'REALM' });
  const t = tokenFields(await tokenCall(env, { grant_type: 'authorization_code', code: String(code), redirect_uri: REDIRECT_URI }, { fetchImpl }), now);
  const row = { realm_id: String(realmId), ...t };
  const info = (await qbo(env, row.realm_id, t.access_token, `/companyinfo/${row.realm_id}`, {}, { fetchImpl })).CompanyInfo || {};
  const company = cleanText(info.CompanyName || info.LegalName, 80) || 'QuickBooks';
  // Connecting again replaces the connection. The same company keeps its last figures (and any trouble, until a
  // read clears it); a different company's old tokens are handed back to Intuit
  const old = await linkRow(env.DB);
  const same = old?.realm_id === row.realm_id;
  if (old && !same) await revoke(env, old.refresh_token, { fetchImpl }).catch((e) => console.error('[books] revoke the old company', e.message));
  await env.DB.prepare('INSERT OR REPLACE INTO books_link (id, realm_id, company, fiscal_start, access_token, access_expires, refresh_token, refresh_expires, ytd, read_at, tried_at, error, error_at, error_detail, told, linked_at, linked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)')
    .bind(ID, row.realm_id, company, monthNumber(info.FiscalYearStartMonth), t.access_token, t.access_expires, t.refresh_token, t.refresh_expires,
      same ? old.ytd : null, same ? old.read_at : null, same ? old.error : null, same ? old.error_at : null, same ? old.error_detail : null, same ? old.told : null, iso(now), pending.by || '').run();
  if ((await readBooks(env, { fetchImpl, now }))?.ok) await readDaily(env, { fetchImpl, now });
  return { company, by: pending.by || '' };
}

async function revoke(env, token, { fetchImpl }) {
  if (!token) return;
  const basic = btoa(`${String(env.QBO_CLIENT_ID).trim()}:${String(env.QBO_CLIENT_SECRET).trim()}`);
  const r = await fetchImpl((await endpoints(env, { fetchImpl })).revoke, { method: 'POST', headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  // A token Intuit already forgot is as good as revoked
  if (!r.ok && r.status !== 400) throw new Error(`Intuit answered ${r.status}`);
}

/** Stop reading QuickBooks: Intuit forgets the connection, and so does SOARD */
export async function disconnectBooks(env, { fetchImpl = fetch } = {}) {
  await ready(env.DB);
  const row = await linkRow(env.DB);
  if (!row) throw Object.assign(new Error('QuickBooks isn’t connected'), { status: 404 });
  if (booksConfigured(env)) await revoke(env, row.refresh_token, { fetchImpl });
  await env.DB.prepare('DELETE FROM books_link WHERE id = ?').bind(ID).run();
  await env.DB.prepare('DELETE FROM books_daily WHERE id = ?').bind(ID).run();
  if (row.told) await slackResolved(env, SLACK_KEY, slackCard({ icon: '✅', title: 'QuickBooks disconnected', lead: 'QuickBooks was disconnected in Settings, so the board page goes back to the packet’s budget sheet for the year so far.' }), { summary: 'QuickBooks disconnected' }).catch(() => null);
}

// ─── Reading the year so far ────────────────────────────────────────

/** The fiscal year to `today` (YYYY-MM-DD): its first day, and its name (2026, or FY2027 for July 2026 to June 2027) */
export function yearSoFar(today, startMonth = 1) {
  const y = Number(today.slice(0, 4));
  const fromYear = Number(today.slice(5, 7)) >= startMonth ? y : y - 1;
  return { year: startMonth === 1 ? String(fromYear) : `FY${fromYear + 1}`, from: `${fromYear}-${String(startMonth).padStart(2, '0')}-01`, through: today };
}

const round2 = (n) => Math.round(n * 100) / 100;
// Each section by its group, else by its total's words (Income is "Revenue" in QuickBooks for nonprofits)
const SECTIONS = {
  income: ['Income', /^total (income|revenue)$/i],
  otherIncome: ['OtherIncome', /^total other (income|revenue)$/i],
  cogs: ['COGS', /^total cost of (goods sold|sales)$/i],
  expenses: ['Expenses', /^total (expenses|expenditures)$/i],
  otherExpenses: ['OtherExpenses', /^total other (expenses|expenditures)$/i],
  net: ['NetIncome', /^net (income|revenue)$/i],
};

/**
 * QuickBooks' ProfitAndLoss report (one total column) → { income, otherIncome, cogs, expenses, otherExpenses,
 * revenue, spent, net, basis }. Throws SHAPE when its sections don't add up to its own net, so a report that
 * changed shape never shows as the year's figures
 */
export function readProfitAndLoss(report) {
  const rows = report?.Rows?.Row || [];
  // The first days of a year can have nothing booked yet: QuickBooks says so instead of sending sections
  const empty = (report?.Header?.Option || []).some((o) => o?.Name === 'NoReportData' && String(o.Value) === 'true');
  if (empty && !rows.length) return { income: 0, otherIncome: 0, cogs: 0, expenses: 0, otherExpenses: 0, revenue: 0, spent: 0, net: 0, basis: cleanText(report?.Header?.ReportBasis, 20) };
  const totalOf = (r) => {
    const n = Number(String(r?.Summary?.ColData?.at(-1)?.value ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const found = {};
  for (const [key, [group, words]] of Object.entries(SECTIONS)) {
    const r = rows.find((x) => x.group === group) || rows.find((x) => words.test(String(x.Summary?.ColData?.[0]?.value || '').trim()));
    found[key] = r ? totalOf(r) : null;
  }
  const v = (k) => found[k] || 0;
  const revenue = round2(v('income') + v('otherIncome'));
  const spent = round2(v('cogs') + v('expenses') + v('otherExpenses'));
  // A report with no net, or one its sections don't add up to, isn't one this reads
  if (found.net === null || Math.abs(revenue - spent - found.net) > 1) throw Object.assign(new Error('The Profit and Loss sections don’t add up to its net income'), { code: 'SHAPE' });
  return {
    income: round2(v('income')), otherIncome: round2(v('otherIncome')), cogs: round2(v('cogs')), expenses: round2(v('expenses')), otherExpenses: round2(v('otherExpenses')),
    revenue, spent, net: round2(found.net), basis: cleanText(report?.Header?.ReportBasis, 20),
  };
}

/** "SR4_Long Reserve (8861)" → "Long Reserve": no ledger number, no account's last digits (as board/money.js reads the balance sheet) */
const accountName = (s) => cleanText(String(s || '').replace(/^\d+\s+/, '').replace(/^SR\d+_/i, '').replace(/\s*\(\d{3,}\)\s*$/, '').replace(/_/g, ' '), 60) || 'Account';

/**
 * QuickBooks' accounts → the cash on the books: { total, accounts: [{ name, balance }], owed: [{ name, balance }] }.
 * Every active Bank account counts toward the total (each its own balance, so a parent and its sub-accounts aren't
 * counted twice); the accounts listed are those with money; Credit Card accounts are owed, never taken off the cash
 */
export function cashOf(list) {
  const num = (a) => (typeof a?.CurrentBalance === 'number' ? a.CurrentBalance : Number(a?.CurrentBalance) || 0);
  const live = (list || []).filter((a) => a && a.Active !== false);
  const banks = live.filter((a) => a.AccountType === 'Bank');
  return {
    total: round2(banks.reduce((t, a) => t + num(a), 0)),
    accounts: banks.filter((a) => round2(num(a)) !== 0).map((a) => ({ name: accountName(a.Name), balance: round2(num(a)) })).sort((x, y) => y.balance - x.balance),
    // What's owed on each card, whichever sign the books carry a liability in; a card at zero isn't listed
    owed: live.filter((a) => a.AccountType === 'Credit Card' && round2(num(a)) !== 0).map((a) => ({ name: accountName(a.Name), balance: round2(Math.abs(num(a))) })),
  };
}

// ─── The year in context, once a day ────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const dayOf = (t) => `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
/** "2026-10-29" a year before: "2025-10-29" (February 29th's is the 28th) */
export function yearBefore(day) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y - 1, m - 1, d));
  return t.getUTCMonth() === m - 1 ? dayOf(t) : dayOf(new Date(Date.UTC(y - 1, m, 0)));
}
/** The last day of the month before `day`'s */
export const lastMonthEnd = (day) => { const [y, m] = day.split('-').map(Number); return dayOf(new Date(Date.UTC(y, m - 1, 0))); };
/** The first day of the month `back` months before `day`'s */
const monthStart = (day, back = 0) => { const [y, m] = day.split('-').map(Number); return dayOf(new Date(Date.UTC(y, m - 1 - back, 1))); };
/**
 * The day the statements are as of: the books' close date (QuickBooks → Settings → Advanced → Accounting → Close the
 * books) when it's the last three months', so a month still being entered never reaches the board; else the last
 * day of last month
 */
export function closeDay(today, bookClose) {
  const last = lastMonthEnd(today);
  if (isDay(bookClose) && bookClose <= last && bookClose >= monthStart(last, 2)) return { asOf: bookClose, closed: true };
  return { asOf: last, closed: false };
}

const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const cellText = (c) => cleanText(c?.value, 100);
/** A QuickBooks report's rows as a tree: sections (a heading, their rows, a total), summary lines (Net Income), accounts */
function treeOf(rows) {
  return (rows || []).map((r) => {
    if (r.Header || r.Rows) return { kind: 'section', label: cellText(r.Header?.ColData?.[0]), group: r.group || '', kids: treeOf(r.Rows?.Row), total: num(r.Summary?.ColData?.at(-1)?.value), totalLabel: cellText(r.Summary?.ColData?.[0]) };
    if (r.Summary) return { kind: 'sum', label: cellText(r.Summary.ColData?.[0]), group: r.group || '', amount: num(r.Summary.ColData?.at(-1)?.value) };
    return { kind: 'acct', label: cellText(r.ColData?.[0]), amount: num(r.ColData?.at(-1)?.value) };
  }).filter((n) => n.label || n.kind === 'section');
}
const keyOf = (n) => `${n.kind}:${n.group || n.label}`;
/** This year's tree with the year before's amounts beside it (null when there's no year before); its rows this year lacks come after */
function mergeTrees(cur, prior) {
  const left = prior ? [...prior] : null;
  const take = (n) => { const i = left ? left.findIndex((p) => keyOf(p) === keyOf(n)) : -1; return i < 0 ? null : left.splice(i, 1)[0]; };
  const pair = (n, p, onlyPrior = false) => (n.kind === 'section'
    ? { ...n, total: onlyPrior ? 0 : n.total, priorTotal: p ? p.total : left ? 0 : null, kids: mergeTrees(onlyPrior ? [] : n.kids, p ? p.kids : left ? [] : null) }
    : { ...n, amount: onlyPrior ? 0 : n.amount, prior: p ? p.amount : left ? 0 : null });
  const both = cur.map((n) => pair(n, take(n)));
  return [...both, ...(left || []).map((p) => pair(p, p, true))];
}
const quiet = (n) => (n.kind === 'section' ? !n.total && !n.priorTotal && n.kids.every(quiet) : !n.amount && !n.prior);
/** The merged tree as a statement's rows: { k: 'head'|'acct'|'total'|'sum', label, d (depth), a (this year), p (the year before) } */
function rowsOf(nodes, d = 0, out = []) {
  for (const n of nodes) {
    if (quiet(n)) continue;
    if (n.kind === 'section') {
      out.push({ k: 'head', label: accountName(n.label), d });
      rowsOf(n.kids, d + 1, out);
      out.push({ k: 'total', label: n.totalLabel || `Total ${accountName(n.label)}`, d, a: round2(n.total), p: n.priorTotal == null ? null : round2(n.priorTotal) });
    } else out.push({ k: n.kind, label: n.kind === 'acct' ? accountName(n.label) : n.label, d, a: round2(n.amount), p: n.prior == null ? null : round2(n.prior) });
  }
  return out;
}
/** Two of QuickBooks' reports, this year's and the same day a year before, as one statement's rows */
export const statementRows = (now, then) => rowsOf(mergeTrees(treeOf(now?.Rows?.Row), then ? treeOf(then?.Rows?.Row) : null));

const SPENDING = ['COGS', 'Expenses', 'OtherExpenses'];
const normName = (s) => String(s || '').trim().toLowerCase().replace(/^\d+\s+/, '');
/** SOARD's own places money can move to without being spent (bank accounts, the CD), by id and by name */
export function ownAccounts(list) {
  const ids = new Set();
  const names = new Set();
  for (const a of list || []) {
    if (a?.Id) ids.add(String(a.Id));
    for (const n of [a?.Name, a?.FullyQualifiedName, a?.AcctNum && `${a.AcctNum} ${a.Name}`]) if (n) names.add(normName(n));
  }
  return { ids, names };
}

/**
 * The cash that left SOARD's bank accounts, from QuickBooks' General Ledger of those accounts: every payment out
 * (bills, payroll, card payments, loan payments), but never a move to another of SOARD's own accounts (`own`: the bank
 * accounts, the CD). In-kind gifts and depreciation never touch a bank account, so they're never in it, whatever
 * their accounts are called. Only the sections of the bank accounts themselves (`banks`) count, so a ledger of every
 * account is never read as cash. → { out, payments }. The sign of the ledger's amounts is read from its running
 * balance (money out lowers it); SHAPE when it has no amount or split column
 */
export function cashOutOf(report, own, banks = own) {
  const cols = report?.Columns?.Column || [];
  const key = (c) => String((c.MetaData || []).find((m) => m.Name === 'ColKey')?.Value || '').toLowerCase();
  const col = (keys, title) => cols.findIndex((c) => keys.includes(key(c)) || title.test(String(c.ColTitle || '').trim()));
  const at = { amount: col(['subt_nat_amount', 'nat_amount', 'amount'], /^amount$/i), split: col(['split_acc'], /^split$/i), type: col(['txn_type'], /^transaction type$/i), balance: col(['rbal_nat_amount', 'rbal'], /^balance$/i) };
  if (at.amount < 0 || at.split < 0) throw Object.assign(new Error('The General Ledger has no Amount or Split column'), { code: 'SHAPE' });
  // Each bank account's rows (a section per account, sub-accounts within), without its Beginning Balance line
  const isBank = (cell) => !!cell && ((cell.id && banks.ids.has(String(cell.id))) || banks.names.has(normName(cell.value)));
  const sections = [];
  const walk = (rows, bank) => {
    const mine = [];
    for (const r of rows || []) {
      if (r.Rows) walk(r.Rows.Row, bank || isBank(r.Header?.ColData?.[0]));
      else if (bank && r.ColData && !/beginning balance/i.test(String(r.ColData[0]?.value || ''))) mine.push(r.ColData);
    }
    if (mine.length) sections.push(mine);
  };
  walk(report?.Rows?.Row, false);
  // Which way the amounts run: a row's amount is how its running balance moved, or the opposite
  let votes = 0;
  if (at.balance >= 0) {
    for (const rows of sections) {
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1][at.balance]?.value;
        const bal = rows[i][at.balance]?.value;
        if (prev === '' || bal === '' || prev == null || bal == null) continue;
        const moved = num(bal) - num(prev);
        const amount = num(rows[i][at.amount]?.value);
        if (Math.abs(moved) < 0.005) continue;
        if (Math.abs(moved - amount) < 0.01) votes += 1;
        else if (Math.abs(moved + amount) < 0.01) votes -= 1;
      }
    }
  }
  const sign = votes < 0 ? -1 : 1;
  let out = 0;
  let payments = 0;
  for (const rows of sections) {
    for (const cd of rows) {
      const moved = sign * num(cd[at.amount]?.value);
      if (!(moved < 0)) continue;
      const split = cd[at.split] || {};
      if ((split.id && own.ids.has(String(split.id))) || own.names.has(normName(split.value))) continue;
      out += -moved;
      payments += 1;
    }
  }
  return { out: round2(out), payments };
}

/** A month-by-month Balance Sheet → the bank accounts' total at each month's end: [{ month: 'YYYY-MM', end, total }], oldest first */
export function bankByMonth(report) {
  const cols = (report?.Columns?.Column || []).slice(1);
  const ends = cols.map((c) => {
    if (/^total$/i.test(String(c.ColTitle || '').trim())) return null;
    const meta = Object.fromEntries((c.MetaData || []).map((m) => [m.Name, m.Value]));
    if (isDay(meta.EndDate)) return meta.EndDate;
    const t = new Date(Date.parse(`1 ${c.ColTitle} 12:00 UTC`));
    return Number.isFinite(t.getTime()) ? dayOf(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0))) : null;
  });
  const find = (rows) => {
    for (const r of rows || []) {
      if (r.group === 'BankAccounts' || /^total (for )?bank accounts$/i.test(String(r.Summary?.ColData?.[0]?.value || '').trim())) return r;
      const x = find(r.Rows?.Row);
      if (x) return x;
    }
    return null;
  };
  const vals = (find(report?.Rows?.Row)?.Summary?.ColData || []).slice(1);
  return ends.map((end, i) => (end && vals[i] ? { month: end.slice(0, 7), end, total: round2(num(vals[i].value)) } : null)).filter(Boolean);
}

/** Where the year's money came from: Income's own lines (each account or group), then Other Income as one, largest first */
export function sourcesOf(report) {
  const tree = treeOf(report?.Rows?.Row);
  const income = tree.find((n) => n.kind === 'section' && (n.group === 'Income' || /^total (income|revenue)$/i.test(n.totalLabel)));
  const other = tree.find((n) => n.kind === 'section' && (n.group === 'OtherIncome' || /^total other (income|revenue)$/i.test(n.totalLabel)));
  const list = (income?.kids || []).map((n) => ({ name: accountName(n.label), amount: round2(n.kind === 'section' ? n.total : n.amount) }));
  if (other?.total) list.push({ name: accountName(other.label) || 'Other income', amount: round2(other.total) });
  return list.filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);
}

/**
 * A Profit and Loss by class → spending by purpose: { list: [{ name, amount }], total }, only when the books keep it
 * (two or more classes carrying at least half the spending); else null
 */
export function functionsOf(report) {
  const cols = (report?.Columns?.Column || []).map((c) => cleanText(c.ColTitle, 60));
  const groups = (report?.Rows?.Row || []).filter((r) => SPENDING.includes(r.group));
  const at = (i) => groups.reduce((t, r) => t + num(r.Summary?.ColData?.[i]?.value), 0);
  const totalAt = cols.findIndex((t, i) => i > 0 && /^total$/i.test(t));
  const named = cols.map((t, i) => ({ t, i })).filter(({ t, i }) => i > 0 && i !== totalAt && t && !/^(not specified|no class|unclassified)$/i.test(t));
  const list = named.map(({ t, i }) => ({ name: t, amount: round2(at(i)) })).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = round2(totalAt > 0 ? at(totalAt) : cols.reduce((t, _, i) => (i > 0 ? t + at(i) : t), 0));
  if (list.length < 2 || !(total > 0) || list.reduce((t, x) => t + x.amount, 0) < total * 0.5) return null;
  return { list, total };
}

const DAILY_RETRY_MS = 60 * 60 * 1000;
/**
 * The year in context, now (about ten reports): kept in books_daily with its day. Trouble is logged and kept, and the
 * last good read stays; the hourly read is the one that tells Slack
 */
export async function readDaily(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.DB || !booksConfigured(env)) return null;
  await ready(env.DB);
  const row = await linkRow(env.DB);
  if (!row) return null;
  const today = todayEastern(now);
  const at = iso(now);
  const get = (path, query) => read(env, row, path, query, { fetchImpl, now });
  const pl = (from, to, more = {}) => get('/reports/ProfitAndLoss', { start_date: from, end_date: to, ...more });
  try {
    const year = Number(today.slice(0, 4));
    // Last year: the same days, and the whole year (how far along it was by now)
    const sameDay = yearBefore(today);
    const lastSame = readProfitAndLoss(await pl(`${year - 1}-01-01`, sameDay));
    const lastFull = readProfitAndLoss(await pl(`${year - 1}-01-01`, `${year - 1}-12-31`));
    // The last 12 full months: the cash that left the bank accounts (the General Ledger of those accounts), beside the
    // books' expenses (in-kind and depreciation included). Without a clean ledger, no months of cash rather than a guess
    const tThrough = lastMonthEnd(today);
    const tFrom = monthStart(tThrough, 11);
    const trail = readProfitAndLoss(await pl(tFrom, tThrough));
    const accountsOf = async (type) => (await get('/query', { query: `select * from Account where AccountType = '${type}' MAXRESULTS 1000` })).QueryResponse?.Account || [];
    const banks = await accountsOf('Bank');
    let cashOut = null;
    try {
      const own = ownAccounts([...banks, ...await accountsOf('Other Current Asset'), ...await accountsOf('Other Asset')]);
      const ids = banks.map((a) => a.Id).filter(Boolean);
      if (ids.length) {
        const c = cashOutOf(await get('/reports/GeneralLedger', { start_date: tFrom, end_date: tThrough, account: ids.join(',') }), own, ownAccounts(banks));
        // Nothing out in a year, or far more than the books spent, isn't a ledger read right
        if (c.out > 0 && !(trail.spent > 0 && c.out > trail.spent * 3)) cashOut = c;
        else console.error('[books] cash out looks wrong', c.out, trail.spent);
      }
    } catch (err) {
      console.error('[books] cash out', err.code || '', detailOf(err));
    }
    // Cash at each month's end, 13 months (this month's as of today)
    const months = bankByMonth(await get('/reports/BalanceSheet', { start_date: monthStart(today, 12), end_date: today, summarize_column_by: 'Month' }));
    // The statements, as of the books' close, beside the same day a year before
    const prefs = (await get('/preferences', {})).Preferences || {};
    const close = closeDay(today, prefs.AccountingInfoPrefs?.BookCloseDate);
    const priorAsOf = yearBefore(close.asOf);
    const jan1 = (d) => `${d.slice(0, 4)}-01-01`;
    const posNow = await get('/reports/BalanceSheet', { start_date: jan1(close.asOf), end_date: close.asOf });
    const posThen = await get('/reports/BalanceSheet', { start_date: jan1(priorAsOf), end_date: priorAsOf });
    const actNow = await pl(jan1(close.asOf), close.asOf);
    const actThen = await pl(jan1(priorAsOf), priorAsOf);
    readProfitAndLoss(actNow);
    const statements = { asOf: close.asOf, closed: close.closed, priorAsOf, position: statementRows(posNow, posThen), activity: statementRows(actNow, actThen) };
    // Spending by purpose, when the books keep it by class
    const functions = functionsOf(await pl(`${year}-01-01`, today, { summarize_column_by: 'Classes' }));
    const data = {
      day: today,
      lastYear: { year: String(year - 1), through: sameDay, revenue: lastSame.revenue, expenses: lastSame.spent, net: lastSame.net, full: { revenue: lastFull.revenue, expenses: lastFull.spent, net: lastFull.net } },
      trailing: { from: tFrom, through: tThrough, spent: trail.spent, cashOut: cashOut ? cashOut.out : null, payments: cashOut ? cashOut.payments : 0 },
      months, statements, functions,
    };
    await env.DB.prepare('INSERT OR REPLACE INTO books_daily (id, data, day, read_at, tried_at, error) VALUES (?, ?, ?, ?, ?, NULL)').bind(ID, JSON.stringify(data), today, at, at).run();
    return { ok: true, data };
  } catch (err) {
    const code = err.code || (err.status ? `HTTP_${err.status}` : 'UNREACHABLE');
    console.error('[books] daily', code, detailOf(err));
    const had = await env.DB.prepare('SELECT id FROM books_daily WHERE id = ?').bind(ID).first();
    if (had) await env.DB.prepare('UPDATE books_daily SET tried_at = ?, error = ? WHERE id = ?').bind(at, code, ID).run();
    else await env.DB.prepare('INSERT INTO books_daily (id, tried_at, error) VALUES (?, ?, ?)').bind(ID, at, code).run();
    return { ok: false, code };
  }
}

/** The year so far and the cash, now: kept with their date; trouble is kept, and told on Slack once */
export async function readBooks(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.DB || !booksConfigured(env)) return null;
  await ready(env.DB);
  const row = await linkRow(env.DB);
  if (!row) return null;
  const at = iso(now);
  try {
    // SOARD's fiscal year is January to December (Peter, Oct 29 2026). QuickBooks' own setting has said August, so
    // it's kept only to show in Settings, never followed
    const span = yearSoFar(todayEastern(now), SOARD_YEAR_STARTS);
    const pl = await read(env, row, '/reports/ProfitAndLoss', { start_date: span.from, end_date: span.through }, { fetchImpl, now });
    const ytd = { ...span, ...readProfitAndLoss(pl), sources: sourcesOf(pl) };
    // The cash on the books: the Bank accounts and the Credit Card accounts, each asked for by type (the whole chart of
    // accounts can run past one answer's rows, and the cards came after the cut)
    const ofType = async (type) => (await read(env, row, '/query', { query: `select * from Account where AccountType = '${type}' MAXRESULTS 1000` }, { fetchImpl, now })).QueryResponse?.Account || [];
    ytd.cash = cashOf([...await ofType('Bank'), ...await ofType('Credit Card')]);
    // The company's name and its fiscal-year setting, kept current (Settings flags a year that doesn't start in January)
    const info = (await read(env, row, `/companyinfo/${row.realm_id}`, {}, { fetchImpl, now })).CompanyInfo || {};
    await env.DB.prepare('UPDATE books_link SET company = ?, fiscal_start = ? WHERE id = ?').bind(cleanText(info.CompanyName || info.LegalName, 80) || row.company, monthNumber(info.FiscalYearStartMonth), ID).run();
    await env.DB.prepare('UPDATE books_link SET ytd = ?, read_at = ?, tried_at = ?, error = NULL, error_at = NULL, error_detail = NULL, told = NULL WHERE id = ?').bind(JSON.stringify(ytd), at, at, ID).run();
    if (row.told) {
      await slackResolved(env, SLACK_KEY, slackCard({ icon: '✅', title: 'QuickBooks reads again', lead: `The board page has ${row.company}’s revenue and expenses for the year so far again, as of today.`, buttons: [{ label: 'QuickBooks in Settings', url: SETTINGS_URL }] }), { summary: 'QuickBooks reads again' }).catch(() => null);
    }
    return { ok: true, ytd };
  } catch (err) {
    const code = err.code || (err.status ? `HTTP_${err.status}` : 'UNREACHABLE');
    console.error('[books] read', code, detailOf(err));
    const since = row.error_at || at;
    await env.DB.prepare('UPDATE books_link SET tried_at = ?, error = ?, error_at = ?, error_detail = ? WHERE id = ?').bind(at, code, since, detailOf(err), ID).run();
    const tell = needsConnect(code) || code === 'invalid_client' || code === 'SHAPE' || now - Date.parse(since) >= TELL_AFTER_MS;
    if (tell && row.told !== code) {
      const card = slackCard({
        icon: '📒', title: needsConnect(code) ? 'QuickBooks needs connecting again' : 'QuickBooks isn’t coming through',
        lead: `${troubleText(code)} Until then the board page shows the year so far from the last good read.`,
        fix: needsConnect(code) ? 'A Board admin opens Settings → QuickBooks in the admin and presses “Connect QuickBooks again”, then signs in to QuickBooks as an admin on Intuit’s page.' : undefined,
        buttons: [{ label: 'QuickBooks in Settings', url: SETTINGS_URL }],
      });
      const r = await slackIssue(env, SLACK_KEY, card, { title: 'QuickBooks', kind: 'attention', area: 'finance' }).catch((e) => ({ ok: false, error: e.message }));
      if (r?.ok) await env.DB.prepare('UPDATE books_link SET told = ? WHERE id = ?').bind(code, ID).run();
    }
    return { ok: false, code };
  }
}

/** On the heartbeat: hourly while QuickBooks is connected */
export async function maybeReadBooks(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.DB || !booksConfigured(env)) return null;
  await ready(env.DB);
  const row = await env.DB.prepare('SELECT tried_at FROM books_link WHERE id = ?').bind(ID).first();
  if (!row) return null;
  let r = null;
  if (!(row.tried_at && now - Date.parse(row.tried_at) < READ_EVERY_MS)) {
    r = await readBooks(env, { fetchImpl, now });
    if (!r?.ok) return r;
  }
  // The year in context once a day (again an hour after one that didn't work)
  const d = await env.DB.prepare('SELECT day, tried_at FROM books_daily WHERE id = ?').bind(ID).first();
  if (!(d && (d.day === todayEastern(now) || (d.tried_at && now - Date.parse(d.tried_at) < DAILY_RETRY_MS)))) await readDaily(env, { fetchImpl, now });
  return r;
}

// ─── For the board page and Settings ────────────────────────────────

/**
 * The year so far as last read → { company, year, from, through, revenue, expenses, net, basis, at, stale,
 * cash: { total, accounts, owed, at } | null, sources, monthsOfCash, qboYearStarts, and from the daily read: lastYear,
 * trailing, months (cash at each month's end), statements, functions, contextAt } or null with QuickBooks not
 * connected (or not read yet)
 */
export async function booksNow(DB, { now = Date.now() } = {}) {
  if (!DB) return null;
  await ready(DB);
  const row = await DB.prepare('SELECT company, ytd, read_at, fiscal_start FROM books_link WHERE id = ?').bind(ID).first();
  if (!row?.ytd || !row.read_at) return null;
  let y;
  try { y = JSON.parse(row.ytd); } catch { return null; }
  if (typeof y?.revenue !== 'number') return null;
  const cash = y.cash && typeof y.cash.total === 'number' ? { total: y.cash.total, accounts: y.cash.accounts || [], owed: y.cash.owed || [], at: row.read_at } : null;
  const daily = await DB.prepare('SELECT data, read_at FROM books_daily WHERE id = ?').bind(ID).first();
  let d = null;
  try { d = daily?.data ? JSON.parse(daily.data) : null; } catch { d = null; }
  // Months of cash: the cash over a month's worth of the last 12 months' cash out
  const perMonth = d?.trailing?.cashOut > 0 ? d.trailing.cashOut / 12 : 0;
  return {
    company: row.company, year: y.year, from: y.from, through: y.through, revenue: y.revenue, expenses: y.spent, net: y.net, basis: y.basis, at: row.read_at, stale: now - Date.parse(row.read_at) > STALE_MS, cash,
    sources: y.sources || [], monthsOfCash: cash && perMonth ? Math.round((cash.total / perMonth) * 10) / 10 : null, perMonth: perMonth ? round2(perMonth) : null,
    qboYearStarts: row.fiscal_start && row.fiscal_start !== SOARD_YEAR_STARTS ? MONTHS[row.fiscal_start - 1].replace(/^./, (c) => c.toUpperCase()) : null,
    lastYear: d?.lastYear || null, trailing: d?.trailing || null, months: d?.months || [], statements: d?.statements || null, functions: d?.functions || null, contextAt: daily?.read_at || null,
  };
}

/** Board → Settings: the company by name, when it was read and through which day, any trouble (never an amount) */
export async function booksStatus(env) {
  const configured = booksConfigured(env);
  const base = { configured, env: envName(env), redirectUri: REDIRECT_URI, connected: null };
  if (!env.DB) return base;
  await ready(env.DB);
  const r = await linkRow(env.DB);
  if (!r) return base;
  let through = null;
  try { through = JSON.parse(r.ytd || 'null')?.through || null; } catch { through = null; }
  return {
    ...base,
    connected: {
      company: r.company, readAt: r.read_at || null, through, linkedAt: r.linked_at || null, linkedBy: r.linked_by || null,
      error: r.error || null, errorAt: r.error_at || null, trouble: troubleText(r.error), needsConnect: needsConnect(r.error),
      // QuickBooks' own "first month of fiscal year" when it isn't SOARD's January ("August"), else null
      qboYearStarts: r.fiscal_start && r.fiscal_start !== SOARD_YEAR_STARTS ? MONTHS[r.fiscal_start - 1].replace(/^./, (c) => c.toUpperCase()) : null,
      // Intuit's reference for the failed call, for its support
      intuitTid: String(r.error_detail || '').match(/intuit_tid ([\w-]+)/)?.[1] || null,
    },
  };
}

/** Site → Automations: on/off, the company and times only */
export async function booksFacts(env) {
  const s = await booksStatus(env).catch(() => ({ configured: booksConfigured(env), connected: null }));
  const c = s.connected;
  return { configured: s.configured, company: c?.company || null, readAt: c?.readAt || null, needsConnect: !!c?.needsConnect, failing: !!(c?.error && !c.needsConnect) };
}
