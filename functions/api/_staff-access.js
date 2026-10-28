/**
 * Who counts as staff: SOARD's Google Workspace, read by the site
 * ===========================================================================
 * Staff sign in to the admin with an emailed code to their soardcharity.com
 * address. The address alone isn't the test: every 5 minutes (on the live
 * hub's heartbeat) the site reads SOARD's Google Workspace accounts, and a
 * sign-in opens the admin only while its Google account is active. Suspend,
 * archive or delete someone in Google Admin and within 5 minutes the site
 * refuses them and Cloudflare Access signs them out everywhere. Nobody keeps a
 * list here: a new hire works the moment Google has their account (an address
 * the last read didn't have is asked of Google then and there).
 *
 * It never locks staff out by failing. Until the accounts have been read once,
 * and whenever Google can't answer about an address it hasn't listed, a
 * soardcharity.com sign-in counts the way it always has. A read that suddenly
 * loses a third of the active accounts isn't believed.
 *
 * Google: the service account behind GOOGLE_CALENDAR_KEY with
 * admin.directory.user.readonly on its domain-wide delegation and the Admin
 * SDK API on in its Google Cloud project, acting as a founder (a Workspace
 * admin). Cloudflare: CF_ACCESS_API_TOKEN, the board sign-in's key, whose
 * Access Organizations Edit permission also signs someone out.
 */

import { accessToken, parseServiceAccount } from './_google-calendar.js';
import { isStaffEmail, normEmail, peopleRows, founderEmails } from './_board-roles.js';

export const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';
const USERS_API = 'https://admin.googleapis.com/admin/directory/v1/users';
const CF_API = 'https://api.cloudflare.com/client/v4';
const LOOK_MS = 5 * 60 * 1000;
const CACHE_MS = 60 * 1000; // one sign-in's answer, per isolate
const KEEP_OUT = 20;        // sign-outs the Automations page remembers

const SCHEMA = 'CREATE TABLE IF NOT EXISTS staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)';
const _ready = new WeakSet();
async function readState(DB, key) {
  if (!DB) return {};
  if (!_ready.has(DB)) { await DB.prepare(SCHEMA).run(); _ready.add(DB); }
  const row = await DB.prepare('SELECT data FROM staff_state WHERE key = ?').bind(key).first();
  try { return row ? JSON.parse(row.data) || {} : {}; } catch { return {}; }
}
async function writeState(DB, key, value) {
  if (!_ready.has(DB)) { await DB.prepare(SCHEMA).run(); _ready.add(DB); }
  await DB.prepare('INSERT OR REPLACE INTO staff_state (key, data, updated_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(value), new Date().toISOString()).run();
  return value;
}

const _seen = new Map(); // email → { at, standing }
export function clearStaffCache() { _seen.clear(); }

/** A Google user as the site keeps it: { email, aliases, name, active, why: null | 'suspended' | 'archived' | 'gone', lastLogin } */
function accountOf(u) {
  const email = normEmail(u.primaryEmail);
  const aliases = [...(u.aliases || []), ...(u.nonEditableAliases || [])].map(normEmail).filter((a) => a && a !== email);
  const why = u.suspended ? 'suspended' : u.archived ? 'archived' : null;
  // Google says 1970 for an account that has never signed in
  const lastLogin = u.lastLoginTime && Date.parse(u.lastLoginTime) > 0 ? u.lastLoginTime : null;
  return { email, aliases, name: u.name?.fullName || '', active: !why, why, lastLogin };
}

/** The account an address belongs to: an active one first (an old address can live on as someone's alias) */
function accountFor(accounts, email) {
  const all = (accounts || []).filter((a) => a.email === email || (a.aliases || []).includes(email));
  return all.find((a) => a.active) || all[0] || null;
}

/** A Google error, with what would fix it: 'scope' (domain-wide delegation), 'api' (Admin SDK API off), 'admin' (not a Workspace admin) */
function googleError(status, body) {
  const message = body?.error?.message || `HTTP ${status}`;
  const needs = /SERVICE_DISABLED|has not been used|is disabled/i.test(JSON.stringify(body?.error || {})) ? 'api'
    : status === 403 && /not authorized/i.test(message) ? 'admin' : null;
  return Object.assign(new Error(`Google: ${message}`), { needs, status });
}

async function directoryToken(env, subject, { fetchImpl, now }) {
  try {
    return await accessToken(env, subject, { fetchImpl, now, scope: DIRECTORY_SCOPE });
  } catch (err) {
    throw Object.assign(err, { needs: /unauthorized_client/.test(err.message) ? 'scope' : null });
  }
}

/** Every Workspace account, acting as `subject` */
async function listAccounts(env, subject, { fetchImpl, now }) {
  const token = await directoryToken(env, subject, { fetchImpl, now });
  const users = [];
  let page = '';
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ customer: 'my_customer', maxResults: '500', projection: 'basic', viewType: 'admin_view', ...(page ? { pageToken: page } : {}) });
    const res = await fetchImpl(`${USERS_API}?${q}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw googleError(res.status, body);
    users.push(...(body?.users || []));
    page = body?.nextPageToken || '';
    if (!page) break;
  }
  return users.map(accountOf);
}

/** End every Access session for an account's soardcharity.com addresses → { ok, error } */
async function signOut(env, account, { fetchImpl }) {
  const key = String(env.CF_ACCESS_API_TOKEN || '').trim();
  if (!key || !env.CF_ACCOUNT_ID) return { ok: false, error: 'No CF_ACCESS_API_TOKEN in Cloudflare, so a sign-in they already had lasts until it runs out' };
  const errors = [];
  for (const email of [account.email, ...(account.aliases || [])].filter(isStaffEmail)) {
    try {
      const res = await fetchImpl(`${CF_API}/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/access/organizations/revoke_user`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await res.json().catch(() => null);
      const why = j?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      // Someone who never signed in has nothing to end
      if ((!res.ok || j?.success === false) && !(res.status === 404 || /not.?found/i.test(why))) errors.push(`${email}: ${why}`);
    } catch (err) {
      errors.push(`${email}: ${err.message}`);
    }
  }
  return errors.length ? { ok: false, error: `Cloudflare: ${errors.join(' · ')}` } : { ok: true };
}

/**
 * Read Google's accounts, keep them, and sign out anyone whose account stopped
 * being active since the last read. → the saved state
 *   { ok, syncedAt, subject, accounts, out: [{ email, name, why, at, signedOut, error }], error, needs, failedAt }
 */
export async function syncStaffDirectory(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const prev = await readState(env.DB, 'directory');
  const at = new Date(now).toISOString();
  const fail = (err) => writeState(env.DB, 'directory', { ...prev, ok: false, error: err.message, needs: err.needs || null, failedAt: at });
  if (!env.GOOGLE_CALENDAR_KEY) return fail(Object.assign(new Error('GOOGLE_CALENDAR_KEY is not set'), { needs: 'key' }));

  // The founder that worked last time, then each founder: only "not a Workspace admin" is worth trying the next one for
  const subjects = [...new Set([prev.subject, ...founderEmails(await peopleRows(env.DB))].filter(Boolean))];
  if (!subjects.length) return fail(new Error('No founder on People → Team to read Google’s accounts as'));
  let read = null, subject = null, lastErr = null;
  for (const s of subjects) {
    try { read = await listAccounts(env, s, { fetchImpl, now }); subject = s; break; } catch (err) { lastErr = err; if (err.needs !== 'admin') break; }
  }
  if (!read) return fail(lastErr);
  if (!read.some((a) => a.active)) return fail(new Error('Google listed no active accounts, so nothing changed'));

  // An address that was here and isn't any more was deleted in Google: kept as gone, so it's refused without asking
  const listed = new Set(read.map((a) => a.email));
  const accounts = [...read, ...(prev.accounts || []).filter((a) => !listed.has(a.email)).map((a) => ({ ...a, active: false, why: 'gone', goneAt: a.goneAt || at }))];
  const before = new Map((prev.accounts || []).map((a) => [a.email, a]));
  const stopped = accounts.filter((a) => !a.active && before.get(a.email)?.active);
  const wasActive = (prev.accounts || []).filter((a) => a.active).length;
  if (stopped.length > 2 && stopped.length * 3 > wasActive) {
    return fail(new Error(`Google’s list suddenly left out ${stopped.length} of ${wasActive} active accounts, so nobody was signed out. It tries again in 5 minutes`));
  }
  const out = [...(prev.out || [])];
  for (const a of stopped) {
    const r = await signOut(env, a, { fetchImpl });
    out.unshift({ email: a.email, name: a.name, why: a.why, at, signedOut: r.ok, error: r.error || null });
  }
  _seen.clear();
  return writeState(env.DB, 'directory', { ok: true, syncedAt: at, subject, accounts, out: out.slice(0, KEEP_OUT), error: null, needs: null });
}

/** Heartbeat: a read every 5 minutes once the Google key is there. Never throws */
export async function maybeSyncStaff(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return null;
    const runs = await readState(env.DB, 'runs');
    if (now - (Number(runs.lookedAt) || 0) < LOOK_MS) return null;
    await writeState(env.DB, 'runs', { lookedAt: now });
    return await syncStaffDirectory(env, { fetchImpl, now });
  } catch (err) {
    console.error('[staff-access]', err.message);
    return null;
  }
}

/** An address Google's last read didn't have: asked of Google now. Google not answering keeps the old rule */
async function askGoogle(env, email, dir, { fetchImpl, now }) {
  try {
    const token = await directoryToken(env, dir.subject, { fetchImpl, now });
    const res = await fetchImpl(`${USERS_API}/${encodeURIComponent(email)}?projection=basic&viewType=admin_view`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return { staff: false, why: 'none' };
    const body = await res.json().catch(() => null);
    if (!res.ok) throw googleError(res.status, body);
    const a = accountOf(body || {});
    return a.active ? { staff: true, name: a.name } : { staff: false, why: a.why, name: a.name };
  } catch (err) {
    console.warn('[staff-access] couldn’t ask Google about a sign-in:', err.message);
    return { staff: true, unchecked: true };
  }
}

/**
 * Whether a sign-in counts as staff: { staff, why?, name? }. A soardcharity.com
 * address whose Google account is suspended, archived, deleted or never was
 * (a group's address) doesn't. Never throws; any doubt keeps the old rule.
 */
export async function staffStanding(env, email, { fetchImpl = fetch, now = Date.now() } = {}) {
  const e = normEmail(email);
  if (!isStaffEmail(e)) return { staff: false, why: 'domain' };
  const hit = _seen.get(e);
  if (hit && now - hit.at < CACHE_MS) return hit.standing;
  let standing;
  try {
    const dir = await readState(env?.DB, 'directory');
    const a = dir.accounts ? accountFor(dir.accounts, e) : null;
    standing = !dir.accounts ? { staff: true, unchecked: true }
      : a ? (a.active ? { staff: true, name: a.name } : { staff: false, why: a.why, name: a.name })
        : await askGoogle(env, e, dir, { fetchImpl, now });
  } catch (err) {
    console.error('[staff-access]', err.message);
    standing = { staff: true, unchecked: true };
  }
  _seen.set(e, { at: now, standing });
  return standing;
}

/** What a refused staff sign-in is told */
export function refusedText(standing) {
  const what = standing.why === 'suspended' ? 'is suspended in Google'
    : standing.why === 'archived' ? 'is archived in Google'
      : standing.why === 'gone' ? 'was deleted in Google'
        : 'isn’t a SOARD Google account';
  return `This sign-in’s SOARD account ${what}, so it can’t open the admin. If that’s a mistake, a Google Workspace admin can put the account back, and the admin opens again within 5 minutes.`;
}

/** For Site → Automations: counts, times and on/off; names only of who was signed out */
export async function staffStatus(env) {
  const dir = await readState(env.DB, 'directory');
  const accounts = (dir.accounts || []).filter((a) => isStaffEmail(a.email));
  let clientId = '', project = '';
  try { const k = parseServiceAccount(env.GOOGLE_CALENDAR_KEY); clientId = String(k.client_id || ''); project = String(k.project_id || ''); } catch { /* no key yet */ }
  return {
    key: !!env.GOOGLE_CALENDAR_KEY,
    signOut: !!(String(env.CF_ACCESS_API_TOKEN || '').trim() && env.CF_ACCOUNT_ID),
    ok: !!dir.ok, read: !!dir.accounts, syncedAt: dir.syncedAt || null, failedAt: dir.failedAt || null,
    error: dir.ok ? null : dir.error || null, needs: dir.ok ? null : dir.needs || null,
    clientId, project,
    active: accounts.filter((a) => a.active).length,
    off: accounts.filter((a) => !a.active).length,
    out: (dir.out || []).slice(0, 5).map((o) => ({ name: o.name || o.email, why: o.why, at: o.at, signedOut: o.signedOut, error: o.error })),
  };
}
