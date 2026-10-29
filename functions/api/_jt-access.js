/**
 * Giving someone access to a job in JobTread
 * ===========================================================================
 * createAce gives a person access to a job: by email and name (JobTread makes
 * the login when they have none) or by an existing membership. The role
 * (Sponsor, Vendor…) is the membership's, so it applies on every job they
 * are on. It is set only on a membership that has none yet or was just made;
 * someone who is already a Vendor keeps that role, and the caller hears so.
 *
 * notify: false adds them without JobTread's own email (Peter, Oct 28 2026,
 * for sponsors: they still get the site's Demo Day and reveal invites, which
 * go to everyone with the Sponsor role on the job).
 *
 * Shapes checked against JobTread's schema without a key (Oct 28 2026):
 * assignee is { emailAddress, name, phoneNumber? } or { membershipId };
 * targetType 'job'; updateMembership { id, roleId }; organization.roles;
 * deleteAce { id } (the job's aces carry their id).
 */
import { JT_URL, SOARD_ORG_ID } from './_reveals.js';

export async function pave(grantKey, query, fetchImpl = fetch) {
  const res = await fetchImpl(JT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: { $: { grantKey }, ...query } }) });
  // A refused query comes back as 4xx with the reason as plain text
  if (!res.ok) throw new Error(`JobTread: ${(await res.text().catch(() => '')).slice(0, 200) || res.status}`);
  return res.json();
}

const normEmail = (e) => String(e || '').trim().toLowerCase();
const MEMBERSHIP = { id: {}, createdAt: {}, isInternal: {}, role: { id: {}, name: {} }, user: { name: {}, emailAddress: {} } };

// Role ids by name, read once per isolate (they don't change)
let roleCache = null;
export async function roleId(grantKey, name, fetchImpl = fetch) {
  if (!roleCache) {
    const body = await pave(grantKey, { organization: { $: { id: SOARD_ORG_ID }, roles: { $: { size: 100 }, nodes: { id: {}, name: {} } } } }, fetchImpl);
    const nodes = body?.organization?.roles?.nodes;
    if (!Array.isArray(nodes)) throw new Error('JobTread sent no roles');
    roleCache = new Map(nodes.map((r) => [String(r.name || '').trim().toLowerCase(), r.id]));
  }
  const id = roleCache.get(String(name).trim().toLowerCase());
  if (!id) throw new Error(`JobTread has no ${name} role`);
  return id;
}
export const _resetRoleCache = () => { roleCache = null; };

/** Who has access to a job: [{ membershipId, name, email, role, internal }] */
export async function jobAccess(grantKey, jobId, fetchImpl = fetch) {
  const body = await pave(grantKey, { job: { $: { id: jobId }, id: {}, aces: { $: { size: 50 }, nodes: { membership: MEMBERSHIP } } } }, fetchImpl);
  if (!body?.job) throw new Error('JobTread has no such job');
  return (body.job.aces?.nodes || []).map((a) => a.membership).filter(Boolean).map((m) => ({
    membershipId: m.id, name: m.user?.name || null, email: normEmail(m.user?.emailAddress), role: m.role?.name || null, internal: !!m.isInternal,
  }));
}

/** Take one person off a job: aceId is their entry in the job's aces (their membership and role stay) */
export async function revokeJobAccess(env, aceId, { fetchImpl = fetch } = {}) {
  if (!env.JOBTREAD_GRANT_KEY) throw new Error('JobTread isn’t connected');
  await pave(env.JOBTREAD_GRANT_KEY, { deleteAce: { $: { id: aceId } } }, fetchImpl);
}

/**
 * Give one person access to a job with a role. Returns
 *   { state: 'there' }                     already on the job
 *   { state: 'added', role }               given access (role: what they have now)
 *   { state: 'added', role, kept: true }   given access, but they already had another role, kept
 * `access` (from jobAccess) saves a read when the caller has it.
 */
export async function grantJobAccess(env, jobId, person, roleName, { notify = false, access = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const key = env.JOBTREAD_GRANT_KEY;
  if (!key) throw new Error('JobTread isn’t connected');
  const email = normEmail(person?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('No email to give access to');
  const on = (access || await jobAccess(key, jobId, fetchImpl)).find((m) => m.email === email);
  if (on) return { state: 'there', role: on.role };

  // Someone already in SOARD's JobTread (on another job) is added by their membership
  const found = await pave(key, {
    organization: { $: { id: SOARD_ORG_ID }, memberships: { $: { size: 5, where: [['user', 'emailAddress'], '=', email] }, nodes: MEMBERSHIP } },
  }, fetchImpl);
  const existing = (found?.organization?.memberships?.nodes || []).find((m) => normEmail(m.user?.emailAddress) === email) || null;
  const assignee = existing ? { membershipId: existing.id } : { emailAddress: email, name: String(person.name || '').trim() || email };
  const made = await pave(key, { createAce: { $: { assignee, targetId: jobId, targetType: 'job', notify }, createdAce: { id: {}, membership: MEMBERSHIP } } }, fetchImpl);
  const m = made?.createAce?.createdAce?.membership || existing;
  if (!m?.id) throw new Error('JobTread didn’t say who it added');
  const had = m.role?.name || null;
  if (m.isInternal) return { state: 'added', role: had, kept: true };
  // Only a membership with no role, or one JobTread just made, takes the role
  const fresh = !existing && (!m.createdAt || now - Date.parse(m.createdAt) < 10 * 60 * 1000);
  if (had && had.toLowerCase() === String(roleName).toLowerCase()) return { state: 'added', role: had };
  if (had && !fresh) return { state: 'added', role: had, kept: true };
  await pave(key, { updateMembership: { $: { id: m.id, roleId: await roleId(key, roleName, fetchImpl) } } }, fetchImpl);
  return { state: 'added', role: roleName };
}
