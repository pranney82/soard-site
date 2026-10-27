/**
 * The board's sign-in: Cloudflare Access's list of board emails, kept by the site
 * ===========================================================================
 * Board members sign in the way staff do (an emailed code), so Access has to
 * know their addresses. The site keeps an Access group, "SOARD board (kept by
 * the website)", holding exactly the active board's private emails from
 * People → Board, and an allow policy, "SOARD board members", that names the
 * group. A board member added, removed or given a new email on People is on
 * (or off) the list within minutes (the heartbeat checks every 5 minutes;
 * see maybeSyncBoardAccess).
 *
 * Getting in is all Access decides: what a board sign-in can reach is the
 * site's call (_board-roles.js), so a board member who signs in reaches the
 * board page and nothing else.
 *
 * Env: CF_ACCESS_API_TOKEN (an API token with Access: Organizations,
 * Identity Providers, and Groups Edit plus Access: Apps and Policies Edit),
 * CF_ACCOUNT_ID, CF_ACCESS_AUD. The site never changes the admin's Access
 * application itself (a bad write there could lock staff out): the policy is
 * added to it once in the dashboard, and the site checks that it is.
 */

import { activeBoard, readState, writeState } from './_board-roles.js';

const API = 'https://api.cloudflare.com/client/v4';
export const GROUP_NAME = 'SOARD board (kept by the website)';
export const POLICY_NAME = 'SOARD board members';
// Access refuses a group with no rule: an address nobody can receive keeps it valid but empty
export const NOBODY = 'no-board-members@invalid.invalid';
const KEY = 'access';
const RECHECK_MS = 6 * 60 * 60 * 1000;
const LOOK_MS = 5 * 60 * 1000;

export const accessConfigured = (env) => Boolean(String(env.CF_ACCESS_API_TOKEN || '').trim() && env.CF_ACCOUNT_ID && env.CF_ACCESS_AUD);

/** The active board's sign-in emails, A to Z, and who has none on file */
export async function boardSignIns(DB) {
  const board = await activeBoard(DB);
  const emails = [...new Set(board.map((p) => p.email).filter(Boolean))].sort();
  return { emails, missing: board.filter((p) => !p.email).map((p) => ({ slug: p.slug, name: p.name })) };
}

async function hashOf(list) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(list.join('\n'))));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function cf(env, path, { method = 'GET', body = null, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API}/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${String(env.CF_ACCESS_API_TOKEN).trim()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.success) {
    const why = j?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Cloudflare ${method} ${path.split('?')[0]}: ${why}`), { status: res.status });
  }
  return j.result;
}

const includeOf = (emails) => (emails.length ? emails : [NOBODY]).map((email) => ({ email: { email } }));
const emailsIn = (group) => (group?.include || []).map((r) => r?.email?.email).filter((e) => e && e !== NOBODY).map((e) => e.toLowerCase()).sort();

/**
 * Bring the Access group up to the board's emails, make sure the policy that
 * names it exists, and see whether the admin's application uses that policy.
 * → the saved state: { ok, emails, hash, groupId, policyId, appName, attached, syncedAt, error }
 */
export async function syncBoardAccess(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const prev = await readState(env.DB, KEY);
  const { emails } = await boardSignIns(env.DB);
  const hash = await hashOf(emails);
  if (!accessConfigured(env)) return { ...prev, ok: false, configured: false, hash };
  const o = { fetchImpl };
  try {
    let group = null;
    if (prev.groupId) group = await cf(env, `/access/groups/${prev.groupId}`, o).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    if (!group) group = (await cf(env, '/access/groups?per_page=100', o) || []).find((g) => g.name === GROUP_NAME) || null;
    if (!group) group = await cf(env, '/access/groups', { ...o, method: 'POST', body: { name: GROUP_NAME, include: includeOf(emails) } });
    else if (emailsIn(group).join('\n') !== emails.join('\n')) {
      group = await cf(env, `/access/groups/${group.id}`, { ...o, method: 'PUT', body: { name: GROUP_NAME, include: includeOf(emails), exclude: group.exclude || [], require: group.require || [] } });
    }

    let policy = (await cf(env, '/access/policies?per_page=100', o) || []).find((p) => p.name === POLICY_NAME) || null;
    if (!policy) policy = await cf(env, '/access/policies', { ...o, method: 'POST', body: { name: POLICY_NAME, decision: 'allow', include: [{ group: { id: group.id } }] } });

    const app = (await cf(env, '/access/apps?per_page=100', o) || []).find((a) => a.aud === env.CF_ACCESS_AUD) || null;
    const attached = Boolean(app && (app.policies || []).some((p) => p.id === policy.id));
    return await writeState(env.DB, KEY, {
      ok: true, configured: true, emails: emails.length, hash, groupId: group.id, policyId: policy.id,
      appName: app?.name || null, appFound: Boolean(app), attached, syncedAt: new Date(now).toISOString(), error: null,
    });
  } catch (err) {
    return await writeState(env.DB, KEY, { ...prev, ok: false, configured: true, error: err.message, failedAt: new Date(now).toISOString() });
  }
}

/** For the admin: whether board members can sign in, and who can't yet */
export async function accessStatus(env) {
  const [state, { emails, missing }] = await Promise.all([readState(env.DB, KEY), boardSignIns(env.DB)]);
  const hash = await hashOf(emails);
  return {
    configured: accessConfigured(env),
    ...state,
    current: state.hash === hash,
    emails: emails.length,
    missing,
  };
}

/** Heartbeat: sync when People → Board changed (checked every 5 minutes) and every 6 hours anyway. Never throws. */
export async function maybeSyncBoardAccess(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !accessConfigured(env)) return null;
    const runs = await readState(env.DB, 'access-runs');
    if (now - (Number(runs.lookedAt) || 0) < LOOK_MS) return null;
    await writeState(env.DB, 'access-runs', { lookedAt: now });
    const state = await readState(env.DB, KEY);
    const { emails } = await boardSignIns(env.DB);
    const stale = !state.syncedAt || now - Date.parse(state.syncedAt) > RECHECK_MS || !state.attached;
    if (state.ok && state.hash === await hashOf(emails) && !stale) return null;
    return await syncBoardAccess(env, { fetchImpl, now });
  } catch (err) {
    console.error('[board-access]', err.message);
    return null;
  }
}
