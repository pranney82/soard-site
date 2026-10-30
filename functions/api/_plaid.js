/**
 * Banks outside Mercury, through Plaid: Chase's checking, CD and credit card for the board page's cash
 * ===========================================================================
 * Env: PLAID_CLIENT_ID and PLAID_SECRET (Plaid Dashboard → Developers → Keys; the Production secret),
 * PLAID_ENV = 'sandbox' only to try it with Plaid's made-up banks. Nothing else: a Board admin connects a
 * bank once in Settings → Bank balances. Plaid's own window signs into the bank; SOARD never sees
 * the password.
 *
 * Read-only. A bank is connected for Plaid's "transactions", the product that keeps its balances fresh
 * (Plaid refreshes them about once a day). This file asks only for /accounts/get, the balances Plaid
 * already has (no charge per call), never a transaction, and never moves money.
 *
 * D1 bank_links keeps a row per connected bank: its access token (useless without the keys above, and
 * never sent to a browser), its accounts as last read, and any trouble Plaid reported. When a bank needs
 * signing in again, its last balances stay with their date, Slack says so once (and again when it's
 * fixed), and Settings offers "Sign in to Chase again".
 */

import { slackIssue, slackResolved, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';

const HOSTS = { production: 'https://production.plaid.com', sandbox: 'https://sandbox.plaid.com' };
export const SETTINGS_URL = `${SITE_ORIGIN}/admin/#settings`;
/** A bank's balances older than this show their date on the board page */
export const STALE_MS = 36 * 60 * 60 * 1000;
const READ_EVERY_MS = 6 * 60 * 60 * 1000;
// Anything else Plaid reports (the bank down for a while) tells Slack only once it has lasted this long
const TELL_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const SCHEMA = 'CREATE TABLE IF NOT EXISTS bank_links (item_id TEXT PRIMARY KEY, institution_id TEXT, institution TEXT, access_token TEXT NOT NULL, accounts TEXT, read_at TEXT, tried_at TEXT, error TEXT, error_at TEXT, told TEXT, linked_at TEXT, linked_by TEXT)';
const _ready = new WeakSet();
async function ready(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  _ready.add(DB);
}

export const plaidConfigured = (env) => !!String(env.PLAID_CLIENT_ID || '').trim() && !!String(env.PLAID_SECRET || '').trim();
const envName = (env) => (String(env.PLAID_ENV || '').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production');

/** One Plaid call. Throws an Error with .code (Plaid's error_code) and .status on a non-2xx answer */
export async function plaid(env, path, body = {}, { fetchImpl = fetch } = {}) {
  if (!plaidConfigured(env)) throw Object.assign(new Error('PLAID_CLIENT_ID and PLAID_SECRET are not set'), { status: 0, code: 'NOT_CONFIGURED' });
  const r = await fetchImpl(`${HOSTS[envName(env)]}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PLAID-CLIENT-ID': String(env.PLAID_CLIENT_ID).trim(), 'PLAID-SECRET': String(env.PLAID_SECRET).trim() },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.display_message || j.error_message || `Plaid answered ${r.status}`), { status: r.status, code: j.error_code || null });
  return j;
}

// ─── What Plaid's troubles mean, in words ───────────────────────────

/** Codes only signing in to the bank again fixes */
const SIGN_IN_AGAIN = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'ACCESS_NOT_GRANTED', 'NO_ACCOUNTS', 'INSUFFICIENT_CREDENTIALS', 'USER_PERMISSION_REVOKED']);
const GONE = new Set(['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN']);
export function troubleText(code, bank = 'The bank') {
  if (!code) return '';
  if (code === 'ITEM_LOGIN_REQUIRED' || code === 'INSUFFICIENT_CREDENTIALS') return `${bank} needs signing in again (a changed password, or its regular check).`;
  if (code === 'PENDING_EXPIRATION' || code === 'PENDING_DISCONNECT') return `${bank}’s permission runs out soon. Sign in again to keep it.`;
  if (code === 'ACCESS_NOT_GRANTED' || code === 'NO_ACCOUNTS' || code === 'USER_PERMISSION_REVOKED') return `${bank} isn’t sharing any account with Plaid. Sign in again and tick the accounts.`;
  if (GONE.has(code)) return `Plaid no longer has this connection. Connect ${bank} again.`;
  if (/^INSTITUTION_/.test(code)) return `${bank} isn’t answering Plaid right now. It tries again by itself.`;
  if (code === 'NOT_CONFIGURED') return 'Plaid’s keys aren’t in Cloudflare.';
  return `Plaid couldn’t read ${bank} (${code}). It tries again by itself.`;
}
const needsSignIn = (code) => SIGN_IN_AGAIN.has(code) || GONE.has(code);

// ─── Connecting a bank ──────────────────────────────────────────────

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
// Plaid wants a steady id for whoever connects; a hash, so no email leaves SOARD
const userId = async (email) => `soard-${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(email || '').trim().toLowerCase()))).slice(0, 24)}`;
const cleanText = (s, n = 80) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

/** A one-time token for Plaid's window: a new bank, or (itemId) signing in to a connected one again */
export async function linkToken(env, { email, itemId = null, fetchImpl = fetch } = {}) {
  await ready(env.DB);
  const base = { client_name: 'Sunshine on a Ranney Day', language: 'en', country_codes: ['US'], user: { client_user_id: await userId(email) } };
  if (itemId) {
    const row = await env.DB.prepare('SELECT access_token FROM bank_links WHERE item_id = ?').bind(itemId).first();
    if (!row) throw Object.assign(new Error('That bank isn’t connected any more'), { status: 404 });
    // Update mode: the same connection, signed in again, with a chance to tick more accounts (the credit card, say)
    return (await plaid(env, '/link/token/create', { ...base, access_token: row.access_token, update: { account_selection_enabled: true } }, { fetchImpl })).link_token;
  }
  return (await plaid(env, '/link/token/create', { ...base, products: ['transactions'], transactions: { days_requested: 30 } }, { fetchImpl })).link_token;
}

/** Plaid's window said yes: keep the bank (in place of an earlier connection to it), and read its balances now */
export async function connectBank(env, { publicToken, institution = {}, by = '', fetchImpl = fetch, now = Date.now() } = {}) {
  if (!/^public-(production|sandbox|development)-[\w-]{8,}$/.test(String(publicToken || ''))) throw Object.assign(new Error('That didn’t come from Plaid’s window'), { status: 400 });
  await ready(env.DB);
  const ex = await plaid(env, '/item/public_token/exchange', { public_token: publicToken }, { fetchImpl });
  const instId = cleanText(institution.id, 40) || null;
  // Connecting the same bank twice would count its money twice: the new connection replaces the old one
  const old = instId ? (await env.DB.prepare('SELECT item_id FROM bank_links WHERE institution_id = ? AND item_id != ?').bind(instId, ex.item_id).all()).results || [] : [];
  for (const o of old) await removeItem(env, o.item_id, { fetchImpl }).catch((e) => console.error('[plaid] replace', e.message));
  await env.DB.prepare('INSERT OR REPLACE INTO bank_links (item_id, institution_id, institution, access_token, linked_at, linked_by) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ex.item_id, instId, cleanText(institution.name, 60) || 'Bank', ex.access_token, new Date(now).toISOString(), cleanText(by, 120)).run();
  await readBanks(env, { fetchImpl, now, only: ex.item_id });
  return ex.item_id;
}

/** Stop reading a bank: Plaid forgets the connection, and so does SOARD */
export async function disconnectBank(env, itemId, { fetchImpl = fetch } = {}) {
  await ready(env.DB);
  const row = await env.DB.prepare('SELECT item_id, institution, told FROM bank_links WHERE item_id = ?').bind(itemId).first();
  if (!row) throw Object.assign(new Error('That bank isn’t connected any more'), { status: 404 });
  await removeItem(env, itemId, { fetchImpl });
  if (row.told) await slackResolved(env, keyOf(row), slackCard({ icon: '✅', title: `${row.institution} disconnected`, lead: `${row.institution} was disconnected in Board → Settings, so the board page no longer counts it.` }), { summary: `${row.institution} disconnected` }).catch(() => null);
}

async function removeItem(env, itemId, { fetchImpl }) {
  const row = await env.DB.prepare('SELECT access_token FROM bank_links WHERE item_id = ?').bind(itemId).first();
  if (row) {
    await plaid(env, '/item/remove', { access_token: row.access_token }, { fetchImpl }).catch((e) => {
      if (!GONE.has(e.code)) throw e;
    });
  }
  await env.DB.prepare('DELETE FROM bank_links WHERE item_id = ?').bind(itemId).run();
}

// ─── Reading the balances ───────────────────────────────────────────

const round2 = (n) => Math.round(n * 100) / 100;
/** A Plaid account → what SOARD keeps: cash accounts (checking, savings, a CD) and credit cards, with their balances */
function cleanAccount(a) {
  if (!a || !['depository', 'credit'].includes(a.type)) return null;
  const b = a.balances || {};
  if (typeof b.current !== 'number') return null;
  return {
    name: cleanText(a.name || a.official_name || 'Account', 60), mask: cleanText(a.mask, 4) || null, type: a.type, subtype: cleanText(a.subtype, 30) || null,
    current: round2(b.current), available: typeof b.available === 'number' ? round2(b.available) : null, limit: typeof b.limit === 'number' ? round2(b.limit) : null,
  };
}
const keyOf = (row) => `bank:${row.item_id}`;

/** Each connected bank's accounts as Plaid last refreshed them; trouble is kept, and told on Slack once */
export async function readBanks(env, { fetchImpl = fetch, now = Date.now(), only = null } = {}) {
  if (!plaidConfigured(env)) return [];
  await ready(env.DB);
  const rows = ((await env.DB.prepare('SELECT item_id, institution, access_token, error, error_at, told FROM bank_links').all()).results || []).filter((r) => !only || r.item_id === only);
  const out = [];
  for (const row of rows) {
    const at = new Date(now).toISOString();
    try {
      const j = await plaid(env, '/accounts/get', { access_token: row.access_token }, { fetchImpl });
      const accounts = (j.accounts || []).map(cleanAccount).filter(Boolean);
      await env.DB.prepare('UPDATE bank_links SET accounts = ?, read_at = ?, tried_at = ?, error = NULL, error_at = NULL, told = NULL WHERE item_id = ?').bind(JSON.stringify(accounts), at, at, row.item_id).run();
      if (row.told) {
        await slackResolved(env, keyOf(row), slackCard({ icon: '✅', title: `${row.institution} balances are back`, lead: `The board page counts ${row.institution} again, as of today.`, buttons: [{ label: 'Bank balances', url: SETTINGS_URL }] }), { summary: `${row.institution} reads again` }).catch(() => null);
      }
      out.push({ itemId: row.item_id, ok: true, accounts: accounts.length });
    } catch (err) {
      const code = err.code || (err.status ? `HTTP_${err.status}` : 'UNREACHABLE');
      const since = row.error_at || at;
      await env.DB.prepare('UPDATE bank_links SET tried_at = ?, error = ?, error_at = ? WHERE item_id = ?').bind(at, code, since, row.item_id).run();
      const tell = needsSignIn(code) || now - Date.parse(since) >= TELL_AFTER_MS;
      if (tell && row.told !== code) {
        const card = slackCard({
          icon: '🏦', title: needsSignIn(code) ? `${row.institution} needs signing in again` : `${row.institution} balances aren’t coming through`,
          lead: `${troubleText(code, row.institution)} Until then the board page shows ${row.institution}’s balances from the last good read.`,
          fix: needsSignIn(code) ? `A Board admin opens Settings → Bank balances in the admin and presses “Sign in to ${row.institution} again”. Plaid’s window opens; sign in there.` : undefined,
          buttons: [{ label: 'Bank balances', url: SETTINGS_URL }],
        });
        const r = await slackIssue(env, keyOf(row), card, { title: `${row.institution} balances`, kind: 'attention', area: 'finance' }).catch((e) => ({ ok: false, error: e.message }));
        if (r?.ok) await env.DB.prepare('UPDATE bank_links SET told = ? WHERE item_id = ?').bind(code, row.item_id).run();
      }
      out.push({ itemId: row.item_id, ok: false, code });
    }
  }
  return out;
}

/** On the heartbeat: every six hours (Plaid refreshes about daily, so this catches each refresh the same morning) */
export async function maybeReadBanks(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.DB || !plaidConfigured(env)) return null;
  await ready(env.DB);
  const due = (await env.DB.prepare('SELECT count(*) AS n FROM bank_links WHERE tried_at IS NULL OR tried_at < ?').bind(new Date(now - READ_EVERY_MS).toISOString()).first())?.n || 0;
  return due ? readBanks(env, { fetchImpl, now }) : null;
}

// ─── For the board page and Settings ────────────────────────────────

/** "Chase" + "Chase Total Checking" → "Chase Total Checking"; + "Business CD" → "Chase Business CD" */
const withBank = (bank, name) => (name.toLowerCase().startsWith(bank.toLowerCase()) ? name : `${bank} ${name}`);

/**
 * The connected banks' money as last read → { accounts: [{ bank, name, kind, balance }], owed: [{ bank, name,
 * balance, limit }], at (the oldest read), stale: [bank names past STALE_MS] } or null with no bank connected
 */
export async function bankBalances(DB, { now = Date.now() } = {}) {
  if (!DB) return null;
  await ready(DB);
  const rows = ((await DB.prepare('SELECT institution, accounts, read_at FROM bank_links ORDER BY linked_at').all()).results || []).filter((r) => r.read_at && r.accounts);
  if (!rows.length) return null;
  const accounts = [];
  const owed = [];
  for (const r of rows) {
    let list = [];
    try { list = JSON.parse(r.accounts) || []; } catch { list = []; }
    // Two accounts with one name tell themselves apart by their last digits
    const dup = (a) => list.filter((b) => b.name === a.name).length > 1 && a.mask ? ` ••${a.mask}` : '';
    for (const a of list) {
      const name = `${withBank(r.institution, a.name)}${dup(a)}`;
      if (a.type === 'depository') accounts.push({ bank: r.institution, name, kind: a.subtype || 'checking', balance: a.current, at: r.read_at });
      else owed.push({ bank: r.institution, name, balance: a.current, limit: a.limit, at: r.read_at });
    }
  }
  const at = rows.map((r) => r.read_at).sort()[0];
  const stale = rows.filter((r) => now - Date.parse(r.read_at) > STALE_MS).map((r) => r.institution);
  return { accounts, owed, at, stale };
}

/** Board → Settings: each bank, its accounts by name and kind (never balances), when it was read, any trouble */
export async function bankStatus(env) {
  const configured = plaidConfigured(env);
  if (!env.DB) return { configured, env: envName(env), banks: [] };
  await ready(env.DB);
  const rows = (await env.DB.prepare('SELECT item_id, institution, accounts, read_at, error, error_at, linked_at, linked_by FROM bank_links ORDER BY linked_at').all()).results || [];
  return {
    configured, env: envName(env),
    banks: rows.map((r) => {
      let list = [];
      try { list = JSON.parse(r.accounts || '[]') || []; } catch { list = []; }
      return {
        itemId: r.item_id, bank: r.institution, readAt: r.read_at || null, linkedAt: r.linked_at || null, linkedBy: r.linked_by || null,
        accounts: list.map((a) => ({ name: a.name, mask: a.mask, kind: a.type === 'credit' ? 'credit card' : a.subtype || 'checking' })),
        error: r.error || null, errorAt: r.error_at || null, trouble: troubleText(r.error, r.institution), needsSignIn: needsSignIn(r.error),
      };
    }),
  };
}

/** Site → Automations: counts and times only */
export async function bankFacts(env) {
  const s = await bankStatus(env).catch(() => ({ configured: plaidConfigured(env), banks: [] }));
  return {
    configured: s.configured, banks: s.banks.map((b) => b.bank), readAt: s.banks.map((b) => b.readAt).filter(Boolean).sort()[0] || null,
    needsSignIn: s.banks.filter((b) => b.needsSignIn).map((b) => b.bank), failing: s.banks.filter((b) => b.error && !b.needsSignIn).map((b) => b.bank),
  };
}
