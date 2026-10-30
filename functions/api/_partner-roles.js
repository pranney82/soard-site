/**
 * JobTread roles follow Partners levels
 * ===========================================================================
 * Peter, Oct 29 2026: a partner's role in JobTread is its level on the
 * website (Signature, Champion, Builder, Friend). Trade Partner is the one
 * role with no level: companies SOARD pays, which aren't on the website.
 *
 * First step, read-only: what SOARD's JobTread roles are (their kind, which
 * decides the screens a person gets, and their permissions) and who has
 * each, so the level roles can copy the right one.
 *
 * Shapes checked against JobTread's schema without a key (Oct 29 2026):
 * organization.roles.nodes { id, name, type, permissions, createdAt };
 * memberships { count, nextPage, nodes { isInternal, role, account { id, name, type } } }.
 */
import { SOARD_ORG_ID } from './_reveals.js';
import { pave } from './_jt-access.js';

const PAGE = 100;

/**
 * Every role with who has it, counted:
 *   { roles: [{ id, name, type, permissions, createdAt, members, internal, accounts: { vendor, customer, none } }],
 *     noRole, members }
 * accounts: how many of the role's people JobTread ties to a vendor or a
 * customer account (or to none). Names and emails aren't read here.
 */
export async function readRoles(env, { fetchImpl = fetch } = {}) {
  const key = env.JOBTREAD_GRANT_KEY;
  if (!key) throw new Error('JobTread isn’t connected');
  const body = await pave(key, { organization: { $: { id: SOARD_ORG_ID }, roles: { $: { size: 100 }, nodes: { id: {}, name: {}, type: {}, permissions: {}, createdAt: {} } } } }, fetchImpl);
  const nodes = body?.organization?.roles?.nodes;
  if (!Array.isArray(nodes)) throw new Error('JobTread sent no roles');
  const roles = new Map(nodes.map((r) => [r.id, {
    id: r.id, name: r.name || '', type: r.type || null, permissions: Array.isArray(r.permissions) ? [...r.permissions].sort() : [],
    createdAt: r.createdAt || null, members: 0, internal: 0, accounts: { vendor: 0, customer: 0, none: 0 },
  }]));

  let noRole = 0;
  let members = 0;
  let page = null;
  for (let i = 0; i < 50; i++) {
    const res = await pave(key, {
      organization: { $: { id: SOARD_ORG_ID }, memberships: { $: { size: PAGE, ...(page ? { page } : {}) }, nextPage: {},
        nodes: { isInternal: {}, role: { id: {} }, account: { type: {} } } } },
    }, fetchImpl);
    const conn = res?.organization?.memberships;
    for (const m of conn?.nodes || []) {
      members++;
      const r = roles.get(m.role?.id);
      if (!r) { noRole++; continue; }
      r.members++;
      if (m.isInternal) r.internal++;
      const t = m.account?.type;
      r.accounts[t === 'vendor' || t === 'customer' ? t : 'none']++;
    }
    page = conn?.nextPage || null;
    if (!page) break;
  }
  return { roles: [...roles.values()].sort((a, b) => b.members - a.members || a.name.localeCompare(b.name)), noRole, members };
}
