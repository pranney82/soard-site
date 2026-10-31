/**
 * JobTread roles follow Partners levels (Peter, Oct 29 2026)
 * ===========================================================================
 * A partner's role in JobTread is its level on the website: Signature,
 * Champion, Builder or Friend. Trade Partner is the one role with no level:
 * a company SOARD pays for work, which isn't on the website (JobTread's own
 * vendor fields say so: Trades, W-9, Documents, a purchase order; "Materials
 * only" or Documents "Not needed" is a supplier, never on a job).
 *
 * The website wins. Each run every partner-role login is placed: its company
 * (the JobTread vendor account matched to a partner, a partner contact's
 * email, the account's name, or the partner website's email domain) gives
 * the level; a JobTread vendor that isn't a partner but is a sub gives Trade
 * Partner. A role changed by hand in JobTread is set back. Someone the site
 * can't place keeps their role and waits in Partners → JobTread access, where
 * staff say their partner, Trade Partner or Design Partner, or leave a level.
 *
 * Only partner roles are touched: the four levels, Trade Partner, and the old
 * Vendor and Monetary Sponsor. Staff, families, the board, photographers and
 * design partners never are (but staff can make someone a Design Partner).
 * The old roles are deleted in JobTread once nobody has them (Peter, Oct 30
 * 2026: "i want it gone"), so nobody can be given one again.
 *
 * Always on (Peter, Oct 30 2026: "i want the sync to always be on"): grants
 * give the level roles, and every change is logged with the role before.
 * updateMembership sends no email.
 *
 * Shapes checked against JobTread's schema without a key (Oct 29 2026):
 * organization.roles.nodes { id, name, type, permissions, createdAt };
 * memberships { nextPage, nodes { id, createdAt, isInternal, role, account { id, name, type }, user } };
 * createRole { organizationId, name, type: 'vendor', permissions }; updateMembership { id, roleId }; deleteRole { id }.
 * A login can't be deleted or archived through the API (deleteMembership asks for a captcha).
 * Live (Oct 29 2026): every partner role is the vendor kind (Vendor: plans,
 * tasks, to-do progress; Monetary Sponsor: daily logs, task groups).
 */
import { SOARD_ORG_ID } from './_reveals.js';
import { pave, _resetRoleCache } from './_jt-access.js';
import { logAudit } from './_audit.js';
import { LEVELS, levelOf, nameKey, domainOf, isSocial } from '../../public/admin/partners-shared.js';

export const TRADE_ROLE = 'Trade Partner';
// A role staff can give someone the site can't place, besides Trade Partner: never a partner role, so the sweep leaves it be
export const DESIGN_ROLE = 'Design Partner';
export const LEVEL_ROLES = LEVELS.map((l) => l.label);
export const PARTNER_ROLES = [...LEVEL_ROLES, TRADE_ROLE];
// What partners were given before roles followed levels (the site asked for "Sponsor", which JobTread never had)
export const OLD_VENDOR_ROLE = 'Vendor';
export const OLD_SPONSOR_ROLE = 'Monetary Sponsor';
const OLD_ROLES = [OLD_VENDOR_ROLE, OLD_SPONSOR_ROLE, 'Sponsor'];
// A new role can do what both old ones did, so nobody moved loses anything
const FALLBACK_PERMISSIONS = ['readDailyLogs', 'readJobPlans', 'readJobTaskGroups', 'readJobTasks', 'updateJobToDoProgresses'];
const MAX_CHANGES = 25;
const PAGE = 100;

const low = (s) => String(s || '').trim().toLowerCase();
const MANAGED = new Set([...PARTNER_ROLES, ...OLD_ROLES].map(low));
/** A role the site keeps in step with Partners: a level, Trade Partner, or an old Vendor / Monetary Sponsor */
export const isPartnerRole = (name) => MANAGED.has(low(name));
export const isLevelRole = (name) => LEVEL_ROLES.some((r) => low(r) === low(name));
export const isOldRole = (name) => OLD_ROLES.some((r) => low(r) === low(name));
/** The old sponsor roles: someone given one in JobTread is a sponsor on JobTread's say-so */
export const isSponsorRole = (name) => low(name) === low(OLD_SPONSOR_ROLE) || low(name) === 'sponsor';
export const roleOfLevel = (level) => levelOf(level).label;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS partner_roles_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS partner_role_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, membership_id TEXT NOT NULL, name TEXT, company TEXT, partner TEXT,
    from_role TEXT, to_role TEXT NOT NULL, why TEXT, batch TEXT, at TEXT NOT NULL, by TEXT, undone_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS partner_role_changes_m ON partner_role_changes (membership_id)',
];
const _ready = new WeakSet();
export async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  for (const sql of SCHEMA) await DB.prepare(sql).run();
  _ready.add(DB);
}
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const iso = (ms) => new Date(ms).toISOString();
async function readKey(DB, key) {
  await ensureSchema(DB);
  const row = await DB.prepare('SELECT value FROM partner_roles_state WHERE key = ?').bind(key).first();
  return parse(row?.value || '{}', {});
}
async function writeKey(DB, key, value) {
  await ensureSchema(DB);
  await DB.prepare('INSERT OR REPLACE INTO partner_roles_state (key, value) VALUES (?, ?)').bind(key, JSON.stringify(value)).run();
  return value;
}

// ── Which roles to give ──────────────────────────────────────────────
/** The roles a grant gives: { partner(p), sponsor(p), trade }, the level roles made in JobTread first when missing */
export async function roleMode(env, { fetchImpl = fetch } = {}) {
  await ensurePartnerRoles(env, { fetchImpl });
  return { partner: (p) => roleOfLevel(p?.level), sponsor: (p) => roleOfLevel(p?.level), trade: TRADE_ROLE };
}

// ── JobTread ─────────────────────────────────────────────────────────
async function fetchRoles(key, fetchImpl) {
  const body = await pave(key, { organization: { $: { id: SOARD_ORG_ID }, roles: { $: { size: 100 }, nodes: { id: {}, name: {}, type: {}, permissions: {}, createdAt: {} } } } }, fetchImpl);
  const nodes = body?.organization?.roles?.nodes;
  if (!Array.isArray(nodes)) throw new Error('JobTread sent no roles');
  return nodes;
}

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
  const roles = new Map((await fetchRoles(key, fetchImpl)).map((r) => [r.id, {
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

/** The level roles and Trade Partner, made when missing (the vendor kind, with both old roles' permissions) → Map(lower name → id) */
let ensured = null;
export async function ensurePartnerRoles(env, { fetchImpl = fetch } = {}) {
  if (ensured) return ensured;
  const key = env.JOBTREAD_GRANT_KEY;
  if (!key) throw new Error('JobTread isn’t connected');
  const roles = await fetchRoles(key, fetchImpl);
  const ids = new Map(roles.map((r) => [low(r.name), r.id]));
  const missing = PARTNER_ROLES.filter((n) => !ids.has(low(n)));
  if (missing.length) {
    const old = roles.filter((r) => [OLD_VENDOR_ROLE, OLD_SPONSOR_ROLE].map(low).includes(low(r.name)));
    const permissions = [...new Set(old.flatMap((r) => r.permissions || []))].sort();
    for (const name of missing) {
      const body = await pave(key, { createRole: { $: { organizationId: SOARD_ORG_ID, name, type: 'vendor', permissions: permissions.length ? permissions : FALLBACK_PERMISSIONS }, createdRole: { id: {}, name: {} } } }, fetchImpl);
      const id = body?.createRole?.createdRole?.id;
      if (!id) throw new Error(`JobTread didn’t make the ${name} role`);
      ids.set(low(name), id);
    }
    _resetRoleCache();
    if (env.DB) await writeKey(env.DB, 'made', { at: iso(Date.now()), roles: missing, permissions: permissions.length ? permissions : FALLBACK_PERMISSIONS });
  }
  ensured = ids;
  return ids;
}
export const _resetEnsured = () => { ensured = null; };

/** SOARD's JobTread logins outside staff: [{ id, createdAt, role, account: { id, name, type } | null, name, email }] */
export async function readMemberships(key, fetchImpl = fetch) {
  const out = [];
  let page = null;
  for (let i = 0; i < 50; i++) {
    const res = await pave(key, {
      organization: { $: { id: SOARD_ORG_ID }, memberships: { $: { size: PAGE, ...(page ? { page } : {}) }, nextPage: {},
        nodes: { id: {}, createdAt: {}, isInternal: {}, role: { id: {}, name: {} }, account: { id: {}, name: {}, type: {} }, user: { name: {}, emailAddress: {} } } } },
    }, fetchImpl);
    const conn = res?.organization?.memberships;
    for (const m of conn?.nodes || []) {
      if (m.isInternal) continue;
      out.push({
        id: m.id, createdAt: m.createdAt || null, role: m.role?.name || null,
        account: m.account?.id ? { id: m.account.id, name: String(m.account.name || '').trim(), type: m.account.type || null } : null,
        name: String(m.user?.name || '').trim() || null, email: low(m.user?.emailAddress) || null,
      });
    }
    page = conn?.nextPage || null;
    if (!page) break;
  }
  return out;
}

// ── Who has which role ───────────────────────────────────────────────
/**
 * Whose a login is: { partner } (a slug), { trade: true }, or {} when the
 * site can't tell. ctx: { bySlug, accountPartner: Map(account id → slug),
 * contactPartner: Map(email → slug), links: { [name key]: slug },
 * trade(account id) → bool, freeMail: Set }
 */
export function placePerson(m, ctx) {
  const { bySlug, accountPartner, contactPartner, links = {}, trade = () => false, freeMail = new Set() } = ctx;
  const ok = (slug) => (slug && bySlug.has(slug) ? { partner: slug } : null);
  if (m.account?.type === 'vendor') {
    const hit = ok(accountPartner.get(m.account.id));
    if (hit) return hit;
  }
  const byMail = m.email ? ok(contactPartner.get(m.email)) : null;
  if (byMail) return byMail;
  const ak = nameKey(m.account?.name || '');
  if (ak) {
    const hit = ok(links[ak]) || ok([...bySlug.values()].find((p) => nameKey(p.name) === ak)?.slug);
    if (hit) return hit;
  }
  const d = String(m.email || '').split('@')[1] || '';
  if (d && !freeMail.has(d)) {
    const p = [...bySlug.values()].find((x) => {
      const w = x.website && !isSocial(x.website) ? domainOf(x.website) : '';
      return w && (d === w || d.endsWith(`.${w}`));
    });
    if (p) return { partner: p.slug };
  }
  if (m.account?.type === 'vendor' && trade(m.account.id)) return { trade: true };
  return {};
}

/**
 * What to change → { changes: [{ membership, name, company, partner, from, to, why }],
 *   unplaced: [{ membership, name, company, account (their JobTread vendor's id), role, why: 'unknown' | 'level' }] }
 * why: 'level' (their partner's level), 'trade', 'staff' (staff's pick), 'set back' (changed by hand in JobTread).
 * picks: { [membership id]: { role } | { keep: true } }; setTo: { [membership id]: the role the site last gave }
 */
export function planRoles(people, { place, bySlug, picks = {}, setTo = {} }) {
  const changes = [];
  const unplaced = [];
  for (const m of people) {
    if (!isPartnerRole(m.role)) continue;
    const pick = picks[m.id];
    // Leave as it is: a level set by hand, never an old role (they go)
    if (pick?.keep && !isOldRole(m.role)) continue;
    const at = place(m);
    const p = at.partner ? bySlug.get(at.partner) : null;
    let to = null;
    let why = null;
    if (p) { to = roleOfLevel(p.level); why = 'level'; }
    else if (at.trade) { to = TRADE_ROLE; why = 'trade'; }
    else if (pick?.role) { to = pick.role; why = 'staff'; }
    if (!to) {
      unplaced.push({ membership: m.id, name: m.name || m.email, company: m.account?.name || null, account: m.account?.type === 'vendor' ? m.account.id : null, role: m.role, why: isLevelRole(m.role) ? 'level' : 'unknown' });
      continue;
    }
    if (low(to) === low(m.role)) continue;
    if (setTo[m.id] && low(setTo[m.id]) === low(to)) why = 'set back';
    changes.push({ membership: m.id, name: m.name || m.email, company: p?.name || m.account?.name || null, partner: p?.slug || null, from: m.role, to, why });
  }
  return { changes, unplaced };
}

/** The role the site last gave each login (changes not put back): { [membership id]: role } */
async function lastSet(DB) {
  const rows = (await DB.prepare('SELECT membership_id, to_role FROM partner_role_changes WHERE undone_at IS NULL ORDER BY id').all()).results || [];
  return Object.fromEntries(rows.map((r) => [r.membership_id, r.to_role]));
}

/**
 * One run, from the vendor sweep (which has the partners, matches and
 * vendor facts at hand): changes up to MAX_CHANGES roles while room()
 * allows, then deletes an old role nobody has. → { changed, pending, unplaced, error? }
 */
export async function reconcileRoles(env, ctx, { fetchImpl = fetch, now = Date.now(), room = () => true } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  await ensureSchema(DB);
  const [picks, setTo, people] = await Promise.all([readKey(DB, 'picks'), lastSet(DB), readMemberships(key, fetchImpl)]);
  const plan = planRoles(people, { place: (m) => placePerson(m, ctx), bySlug: ctx.bySlug, picks, setTo });
  const done = [];
  const problems = [];
  if (plan.changes.length) {
    const ids = new Map(await ensurePartnerRoles(env, { fetchImpl }));
    // Staff's Design Partner isn't one the site makes: JobTread's own
    if (plan.changes.some((c) => !ids.has(low(c.to)))) for (const r of await fetchRoles(key, fetchImpl)) if (!ids.has(low(r.name))) ids.set(low(r.name), r.id);
    const batch = iso(now);
    for (const c of plan.changes) {
      if (done.length >= MAX_CHANGES || !room()) break;
      const roleId = ids.get(low(c.to));
      if (!roleId) { problems.push(`JobTread has no ${c.to} role`); continue; }
      try {
        await pave(key, { updateMembership: { $: { id: c.membership, roleId } } }, fetchImpl);
        await DB.prepare('INSERT INTO partner_role_changes (membership_id, name, company, partner, from_role, to_role, why, batch, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(c.membership, c.name, c.company, c.partner, c.from, c.to, c.why, batch, iso(now), 'sync').run();
        done.push(c);
        const m = people.find((x) => x.id === c.membership);
        if (m) m.role = c.to;
      } catch (e) { problems.push(`Couldn’t change ${c.name}’s role: ${e.message}`); }
    }
    if (done.length) {
      // Names only: emails stay in JobTread
      await logAudit(DB, { userEmail: 'sync', action: 'updated', entityType: 'jobtread-roles', entityName: 'Roles in JobTread', changes: { changed: done.map((c) => `${c.name}${c.company ? ` (${c.company})` : ''}: ${c.from} → ${c.to}`) } });
    }
  }
  if (room()) await dropOldRoles(env, people, { fetchImpl, now, problems });
  const pending = plan.changes.filter((c) => !done.includes(c));
  await writeKey(DB, 'plan', { at: iso(now), changes: pending, unplaced: plan.unplaced, problems: problems.slice(0, 5) });
  return { changed: done.length, pending: pending.length, unplaced: plan.unplaced.length, ...(problems.length ? { error: problems[0] } : {}) };
}

/**
 * Vendor and Monetary Sponsor are deleted in JobTread once nobody has them
 * (people: every login outside staff, as this run left them), and remembered
 * as gone ('gone': { name: when }, "Sponsor" too, which JobTread never had).
 */
async function dropOldRoles(env, people, { fetchImpl, now, problems }) {
  const { DB } = env;
  const gone = await readKey(DB, 'gone');
  const left = new Set(people.map((m) => low(m.role)));
  if (!people.length || OLD_ROLES.every((n) => gone[n] || left.has(low(n)))) return;
  const roles = await fetchRoles(env.JOBTREAD_GRANT_KEY, fetchImpl);
  const deleted = [];
  for (const n of OLD_ROLES) {
    if (gone[n] || left.has(low(n))) continue;
    const r = roles.find((x) => low(x.name) === low(n));
    try {
      if (r) { await pave(env.JOBTREAD_GRANT_KEY, { deleteRole: { $: { id: r.id } } }, fetchImpl); deleted.push(n); }
      gone[n] = iso(now);
    } catch (e) { problems.push(`Couldn’t delete the ${n} role in JobTread: ${e.message}`); }
  }
  await writeKey(DB, 'gone', gone);
  if (deleted.length) {
    _resetRoleCache();
    await logAudit(DB, { userEmail: 'sync', action: 'deleted', entityType: 'jobtread-roles', entityName: 'Old roles in JobTread', changes: { deleted } });
  }
}

// ── Staff ────────────────────────────────────────────────────────────
/** Staff's say for someone the site can't place: Trade Partner, Design Partner, or leave a level (keep), or undo (null) */
export async function pickRole(DB, { membership, role = null, keep = false, name = null }, by = null, now = Date.now()) {
  if (role && role !== TRADE_ROLE && role !== DESIGN_ROLE) throw new Error('Only Trade Partner or Design Partner can be picked; a partner’s level comes from Partners');
  const picks = await readKey(DB, 'picks');
  if (!role && !keep) delete picks[membership];
  else picks[membership] = { ...(role ? { role } : { keep: true }), name, by, at: iso(now) };
  await writeKey(DB, 'picks', picks);
  // The person comes off the list now; the next run gives the role
  const plan = await readKey(DB, 'plan');
  if (plan.unplaced) await writeKey(DB, 'plan', { ...plan, unplaced: plan.unplaced.filter((u) => u.membership !== membership || (!role && !keep)) });
  return picks[membership] || null;
}

/**
 * Partners → JobTread access, the roles part:
 * { at, pending: [change], unplaced: [...], recent: [{ name, company, from, to, why, at }], made, gone, problems }
 */
export async function rolesView(DB) {
  await ensureSchema(DB);
  const [plan, made, gone] = await Promise.all([readKey(DB, 'plan'), readKey(DB, 'made'), readKey(DB, 'gone')]);
  const recent = ((await DB.prepare('SELECT name, company, from_role, to_role, why, at FROM partner_role_changes WHERE undone_at IS NULL ORDER BY id DESC LIMIT 40').all()).results || [])
    .map((r) => ({ name: r.name, company: r.company, from: r.from_role, to: r.to_role, why: r.why, at: r.at }));
  return {
    at: plan.at || null,
    pending: (plan.changes || []).map(({ membership, ...c }) => c),
    unplaced: plan.unplaced || [],
    recent, made: made.roles ? made : null, gone, problems: plan.problems || [],
  };
}
