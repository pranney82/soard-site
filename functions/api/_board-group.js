/**
 * The board's Google Group, board@soardcharity.com, kept by the site
 * ===========================================================================
 * Mail to board@soardcharity.com reaches the people the board meeting invite
 * goes to: each active board member on People → Board, at the private email
 * there, and the Board area's admins (Holly and Peter). On the heartbeat the
 * site reads the group's members from Google, adds whoever is missing and
 * removes whoever has left the board. It looks within 5 minutes of a change
 * on People → Board, and every 6 hours anyway, so someone added or removed
 * by hand in Google is put back in step. It works the way Cloudflare's board
 * sign-in list does (./_board-access.js).
 *
 * What it never touches:
 *   - the group's owners and managers (whoever runs the group in Google stays,
 *     and that's how to keep someone who isn't on the board)
 *   - a group, or the whole domain, listed as a member
 *   - anything while People → Board has nobody with an email: a read that
 *     comes back empty never empties the group
 * Adding someone through Google's API sends them no email.
 *
 * Google: the service account behind GOOGLE_CALENDAR_KEY with
 * admin.directory.group.member on its domain-wide delegation (the Admin SDK
 * API, already on for staff sign-in, ./_staff-access.js), acting as a
 * founder who is a Workspace admin.
 */

import { accessToken } from './_google-calendar.js';
import { isEmail } from './_broadcast-notify.js';
import { activeBoard, boardAdmins, founderEmails, normEmail, peopleRows, privateEmails, readState, writeState, isStaffEmail } from './_board-roles.js';

export const GROUP_EMAIL = 'board@soardcharity.com';
export const GROUP_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member';
const MEMBERS_API = `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(GROUP_EMAIL)}/members`;
const KEY = 'group';
const LOOK_MS = 5 * 60 * 1000;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000; // after a failure (a Google setting nobody has made yet doesn't need asking every 5 minutes)
const KEEP_CHANGES = 20;
const MAX_CHANGES = 25; // adds and removals in one run

/** A soardcharity.com address as Google lists it: an alias becomes its account's main address (from staff sign-in's last read of Google) */
async function primaryOf(DB) {
  const map = new Map();
  try {
    const row = await DB.prepare("SELECT data FROM staff_state WHERE key = 'directory'").first();
    for (const a of JSON.parse(row?.data || '{}').accounts || []) {
      for (const e of [a.email, ...(a.aliases || [])]) if (e) map.set(normEmail(e), normEmail(a.email));
    }
  } catch { /* not read yet: addresses stay as written */ }
  return (e) => map.get(normEmail(e)) || normEmail(e);
}

/**
 * Who belongs in the group: { members: [{ email, name }] A to Z, board (how many board members have an email), missing }
 * The same people the meeting invite goes to (./_board-invite.js guestsFor).
 */
export async function groupWanted(DB) {
  const [board, admins, people, primary] = await Promise.all([activeBoard(DB), boardAdmins(DB), peopleRows(DB), primaryOf(DB)]);
  const byEmail = new Map();
  for (const p of board) if (isEmail(p.email)) byEmail.set(primary(p.email), p.name);
  const founders = new Map(people.filter((p) => p.group !== 'board' && p.group !== 'advisory').map((p) => [String(p.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]+/)?.[0], p.name]));
  for (const e of admins) if (!byEmail.has(primary(e))) byEmail.set(primary(e), founders.get(e.split('@')[0]) || e);
  const members = [...byEmail].map(([email, name]) => ({ email, name })).sort((a, b) => a.email.localeCompare(b.email));
  return { members, board: board.filter((p) => isEmail(p.email)).length, missing: board.filter((p) => !isEmail(p.email)).map((p) => ({ slug: p.slug, name: p.name })) };
}

async function hashOf(emails) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(emails.join('\n'))));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A Google error, with what would fix it: 'scope' (domain-wide delegation), 'api' (Admin SDK API off), 'admin' (not a Workspace admin), 'group' (no such group); 'empty' and 'outside' are set where they're found */
function googleError(status, body) {
  const message = body?.error?.message || `HTTP ${status}`;
  const needs = /SERVICE_DISABLED|has not been used|is disabled/i.test(JSON.stringify(body?.error || {})) ? 'api'
    : status === 403 && /not authorized/i.test(message) ? 'admin'
      : status === 404 ? 'group' : null;
  return Object.assign(new Error(`Google: ${message}`), { needs, status });
}

async function groupToken(env, subject, { fetchImpl, now }) {
  try {
    return await accessToken(env, subject, { fetchImpl, now, scope: GROUP_SCOPE });
  } catch (err) {
    throw Object.assign(err, { needs: /unauthorized_client|access_denied/.test(err.message) ? 'scope' : null });
  }
}

/** One Directory call → { status, ok, data }; no answer at all is status 0 */
async function google(token, method, url, body, fetchImpl) {
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    return { status: 0, ok: false, data: { error: { message: `no answer (${err.message})` } } };
  }
}

/** Everyone in the group: [{ email, role, type }] */
async function listMembers(token, fetchImpl) {
  const out = [];
  let page = '';
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ maxResults: '200', ...(page ? { pageToken: page } : {}) });
    const r = await google(token, 'GET', `${MEMBERS_API}?${q}`, null, fetchImpl);
    if (!r.ok) throw googleError(r.status, r.data);
    out.push(...(r.data?.members || []).map((m) => ({ email: normEmail(m.email), role: m.role || 'MEMBER', type: m.type || 'USER' })));
    page = r.data?.nextPageToken || '';
    if (!page) break;
  }
  return out;
}

/** What didn't go through, each reason once: "Google didn’t take 5 changes: The service is currently unavailable (Alex Rivera, Sam Ortiz and 3 more)" */
function failedText(failing) {
  const by = new Map();
  for (const f of failing) {
    const why = /aborted|timed? ?out/i.test(f.error) ? 'no answer in time' : f.error.replace(/^Google: /, '').replace(/\.$/, '');
    by.set(why, [...(by.get(why) || []), f.name || f.email]);
  }
  const some = (l) => (l.length > 3 ? `${l.slice(0, 2).join(', ')} and ${l.length - 2} more` : l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l.at(-1)}` : l[0]);
  return `Google didn’t take ${failing.length === 1 ? 'a change' : `${failing.length} changes`}: ${[...by].map(([why, who]) => `${why} (${some(who)})`).join('; ')}`;
}

/** Only plain members who are people are the site's to remove: owners, managers, groups and the domain stay */
const keptBySite = (m) => m.email && m.role === 'MEMBER' && (m.type === 'USER' || m.type === 'EXTERNAL');

/**
 * Bring board@soardcharity.com up to the board. → the saved state
 *   { ok, configured, subject, members, wanted, hash, triedHash, syncedAt, error, needs, failing: [{ email, name, error }], changes: [{ at, added, removed }] }
 */
export async function syncBoardGroup(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const prev = await readState(env.DB, KEY);
  const at = new Date(now).toISOString();
  const want = await groupWanted(env.DB);
  const hash = await hashOf(want.members.map((m) => m.email));
  // failingSince: when this run of failures began, so a passing outage reads as one
  const fail = (err) => writeState(env.DB, KEY, { ...prev, ok: false, configured: true, triedHash: hash, error: err.message, needs: err.needs || null, failedAt: at, failingSince: prev.failingSince || at });
  if (!env.GOOGLE_CALENDAR_KEY) return { ...prev, ok: false, configured: false };
  if (!want.board) return fail(Object.assign(new Error('People → Board has nobody with an email, so the group was left as it is'), { needs: 'empty' }));

  // The founder that worked last time, then staff sign-in's, then each founder: only "not a Workspace admin" is worth trying the next one for
  let staffSubject = '';
  try { staffSubject = JSON.parse((await env.DB.prepare("SELECT data FROM staff_state WHERE key = 'directory'").first())?.data || '{}').subject || ''; } catch { /* not read yet */ }
  const subjects = [...new Set([prev.subject, staffSubject, ...founderEmails(await peopleRows(env.DB))].filter(Boolean))];
  if (!subjects.length) return fail(Object.assign(new Error('No founder on People → Team to ask Google as'), { needs: 'founder' }));
  let token = null, subject = null, current = null, lastErr = null;
  for (const s of subjects) {
    try { token = await groupToken(env, s, { fetchImpl, now }); current = await listMembers(token, fetchImpl); subject = s; break; } catch (err) { lastErr = err; if (err.needs !== 'admin') break; }
  }
  if (!current) return fail(lastErr);

  // Names for whoever leaves: anyone on People with that private email (former board members too)
  const [people, emails] = await Promise.all([peopleRows(env.DB), privateEmails(env.DB)]);
  const nameOf = new Map([...Object.entries(emails).map(([slug, e]) => [e, people.find((p) => p.slug === slug)?.name]), ...(prev.names || []), ...want.members.map((m) => [m.email, m.name])].filter(([, n]) => n));

  const wanted = new Set(want.members.map((m) => m.email));
  const inGroup = new Set(current.map((m) => m.email).filter(Boolean));
  const toAdd = want.members.filter((m) => !inGroup.has(m.email));
  let budget = MAX_CHANGES;
  const added = [], removed = [], failing = [];
  const aliased = new Set(); // domains where an address turned out to be another member's alias
  for (const m of toAdd) {
    if (budget-- <= 0) break;
    const r = await google(token, 'POST', MEMBERS_API, { email: m.email, role: 'MEMBER' }, fetchImpl);
    if (r.ok) { added.push({ email: m.email, name: m.name }); continue; }
    // Already in it under another of their addresses: whoever is listed there is them, so nobody at that domain is removed this time
    if (r.status === 409) { aliased.add(m.email.split('@')[1]); continue; }
    failing.push({ email: m.email, name: m.name, error: googleError(r.status, r.data).message, outside: !isStaffEmail(m.email) });
  }
  const toRemove = current.filter((m) => keptBySite(m) && !wanted.has(m.email) && !aliased.has(m.email.split('@')[1]));
  for (const m of toRemove) {
    if (budget-- <= 0) break;
    const r = await google(token, 'DELETE', `${MEMBERS_API}/${encodeURIComponent(m.email)}`, null, fetchImpl);
    if (r.ok || r.status === 404) { removed.push({ email: m.email, name: nameOf.get(m.email) || '' }); continue; }
    failing.push({ email: m.email, name: nameOf.get(m.email) || '', error: googleError(r.status, r.data).message, removing: true });
  }
  // More than one run's worth (the first run on an old group): the rest at the next look
  const more = toAdd.length + toRemove.length > MAX_CHANGES;

  // Every refused add was an outside address: the group doesn't take members from outside soardcharity.com
  const adds = failing.filter((f) => !f.removing);
  const outsideRefused = adds.length > 0 && adds.every((f) => f.outside);
  const changes = added.length || removed.length ? [{ at, added, removed }, ...(prev.changes || [])].slice(0, KEEP_CHANGES) : (prev.changes || []);
  return writeState(env.DB, KEY, {
    ok: !failing.length, configured: true, subject, group: GROUP_EMAIL,
    members: current.length + added.length - removed.length, wanted: want.members.length,
    owners: current.filter((m) => m.role !== 'MEMBER').length,
    // Caught up only when everything went: anything left is tried again
    hash: failing.length || more ? prev.hash || null : hash, triedHash: more ? null : hash,
    syncedAt: at, failedAt: failing.length ? at : null, failingSince: failing.length ? prev.failingSince || at : null,
    error: failing.length ? failedText(failing) : null,
    needs: outsideRefused ? 'outside' : null,
    failing, changes,
    names: [...new Map([...(prev.names || []), ...removed.map((m) => [m.email, m.name]), ...want.members.map((m) => [m.email, m.name])].filter(([, n]) => n))].slice(-60),
  });
}

/** For the admin: whether the group follows the board, and its last changes (names only) */
export async function groupStatus(env) {
  const [state, want] = await Promise.all([readState(env.DB, KEY), groupWanted(env.DB)]);
  const hash = await hashOf(want.members.map((m) => m.email));
  return {
    group: GROUP_EMAIL,
    configured: Boolean(env.GOOGLE_CALENDAR_KEY),
    ok: !!state.ok, syncedAt: state.syncedAt || null, failedAt: state.failedAt || null, failingSince: state.ok ? null : state.failingSince || state.failedAt || null,
    error: state.ok ? null : state.error || null, needs: state.ok ? null : state.needs || null,
    current: state.hash === hash, members: state.members ?? null, owners: state.owners ?? 0,
    wanted: want.members.length, board: want.board, missing: want.missing, everyone: want.members,
    failing: (state.failing || []).map((f) => ({ name: f.name || f.email, error: f.error, removing: !!f.removing })),
    changes: (state.changes || []).slice(0, 5).map((c) => ({ at: c.at, added: c.added.map((m) => m.name || m.email), removed: c.removed.map((m) => m.name || m.email) })),
  };
}

/** Heartbeat: when People → Board changed (checked every 5 minutes), every 6 hours anyway, and half-hourly while something fails. Never throws. */
export async function maybeSyncBoardGroup(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.GOOGLE_CALENDAR_KEY) return null;
    const runs = await readState(env.DB, 'group-runs');
    if (now - (Number(runs.lookedAt) || 0) < LOOK_MS) return null;
    await writeState(env.DB, 'group-runs', { lookedAt: now });
    const state = await readState(env.DB, KEY);
    const hash = await hashOf((await groupWanted(env.DB)).members.map((m) => m.email));
    const last = Date.parse((state.ok ? state.syncedAt : state.failedAt) || '') || 0;
    // A young outage (Google erring, nothing to set) is asked again at each look for its first half hour, as the panel says
    const young = !state.ok && !state.needs && state.failingSince && now - Date.parse(state.failingSince) < RETRY_MS;
    const due = state.triedHash !== hash || now - last >= (state.ok ? RECHECK_MS : young ? LOOK_MS : RETRY_MS);
    return due ? await syncBoardGroup(env, { fetchImpl, now }) : null;
  } catch (err) {
    console.error('[board-group]', err.message);
    return null;
  }
}
