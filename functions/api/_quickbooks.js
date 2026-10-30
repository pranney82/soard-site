/**
 * QuickBooks Online, read-only: the year's revenue and expenses so far, for the board page
 * ===========================================================================
 * Env: QBO_CLIENT_ID and QBO_CLIENT_SECRET (developer.intuit.com → SOARD's app → Keys and credentials,
 * Production), QBO_ENV = 'sandbox' only to try it with Intuit's sandbox company. Nothing else: a Board admin
 * connects SOARD's company once in Board → Settings → QuickBooks. Intuit's own page signs in and asks which
 * company; SOARD never sees the password. The app's redirect URI is REDIRECT_URI (/api/books-callback, public:
 * the one-time `state` Settings made is its proof, and the code it carries is useless without the keys).
 *
 * Read-only: the accounting scope, but only the company's name and its Profit and Loss are ever asked for.
 * Hourly on the board heartbeat, the Profit and Loss from the first day of SOARD's fiscal year to today, on
 * the company's own basis (what its reports show by default). Revenue is Income plus Other Income; expenses
 * are Cost of Goods Sold, Expenses and Other Expenses (what the store sold cost money too).
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
export const SETTINGS_URL = `${SITE_ORIGIN}/admin/#board/settings`;
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
const _ready = new WeakSet();
async function ready(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
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
  await readBooks(env, { fetchImpl, now });
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
  if (row.told) await slackResolved(env, SLACK_KEY, slackCard({ icon: '✅', title: 'QuickBooks disconnected', lead: 'QuickBooks was disconnected in Board → Settings, so the board page goes back to the packet’s budget sheet for the year so far.' }), { summary: 'QuickBooks disconnected' }).catch(() => null);
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

/** The year so far, now: kept with its date; trouble is kept, and told on Slack once */
export async function readBooks(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.DB || !booksConfigured(env)) return null;
  await ready(env.DB);
  const row = await linkRow(env.DB);
  if (!row) return null;
  const at = iso(now);
  try {
    const span = yearSoFar(todayEastern(now), row.fiscal_start || 1);
    const ytd = { ...span, ...readProfitAndLoss(await read(env, row, '/reports/ProfitAndLoss', { start_date: span.from, end_date: span.through }, { fetchImpl, now })) };
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
        fix: needsConnect(code) ? 'A Board admin opens Board → Settings → QuickBooks and presses “Connect QuickBooks again”, then signs in to QuickBooks as an admin on Intuit’s page.' : undefined,
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
  if (!row || (row.tried_at && now - Date.parse(row.tried_at) < READ_EVERY_MS)) return null;
  return readBooks(env, { fetchImpl, now });
}

// ─── For the board page and Settings ────────────────────────────────

/**
 * The year so far as last read → { company, year, from, through, revenue, expenses, net, basis, at, stale } or
 * null with QuickBooks not connected (or not read yet)
 */
export async function booksNow(DB, { now = Date.now() } = {}) {
  if (!DB) return null;
  await ready(DB);
  const row = await DB.prepare('SELECT company, ytd, read_at FROM books_link WHERE id = ?').bind(ID).first();
  if (!row?.ytd || !row.read_at) return null;
  let y;
  try { y = JSON.parse(row.ytd); } catch { return null; }
  if (typeof y?.revenue !== 'number') return null;
  return { company: row.company, year: y.year, from: y.from, through: y.through, revenue: y.revenue, expenses: y.spent, net: y.net, basis: y.basis, at: row.read_at, stale: now - Date.parse(row.read_at) > STALE_MS };
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
