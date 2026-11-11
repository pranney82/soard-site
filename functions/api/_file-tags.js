/**
 * JobTread's file tags: the five the site keeps, and who sees each
 * ===========================================================================
 * Peter, Nov 9–11 2026: kid photos in JobTread, "best in class setup and
 * ideally less tags", auto-tagged; families see no photos or design ("we dont
 * share during photos with teh family!?", the design: "leave them off");
 * partners, trades, design partners and photographers on a job see its
 * photos, design and plans; the team doesn't use JobTread's Plans tab.
 *
 *   Before  photos/videos taken before the build (and RENDR's room scans)
 *   During  from the Demo date until reveal day
 *   After   reveal day on
 *   Design  layouts, 3Ds, presentations, inspiration, renderings
 *   Plans   the current build set, specs, templates
 *   Costs   pricing quotes, bills and receipts: staff only (Peter, Nov 11 2026:
 *           "we will be uploading receipts and bills to here so might need a tag")
 *
 * Each run (hourly, on the heartbeat: broadcast-hooks.js) makes any of
 * the five that's missing and keeps its audience exactly as below: an access
 * entry per role, made with notify off, and any other role's taken off. A
 * tag shows its files to nobody outside staff until a file is put on it, so
 * making them is safe before anything is tagged. The ids are kept in D1
 * (file_tags), so nothing reads a tag by name.
 *
 * Families' access to before photos comes off the old .BeforePics too (the
 * Makeover Family role's entry), by Peter's rule. Every other old tag keeps
 * today's audience until its files have moved. In Kind, COI and W-9 stay
 * staff only, as they are.
 */

import { SOARD_ORG_ID } from './_reveals.js';
import { pave } from './_jt-access.js';
import { logAudit } from './_audit.js';
import { LEVEL_ROLES, TRADE_ROLE, DESIGN_ROLE } from './_partner-roles.js';

export const PHOTOGRAPHER_ROLE = 'Photographer';
const FAMILY_ROLE = 'Makeover Family';
const PHOTOS_SEEN_BY = [...LEVEL_ROLES, TRADE_ROLE, DESIGN_ROLE, PHOTOGRAPHER_ROLE];
// Staff roles that see the old tags' files today (each old tag's own entries, Nov 11 2026), given the new ones too,
// so nobody on staff loses sight of a file when it moves. Staff roles are added, never taken off.
const STAFF_SEE = ['Admin', 'Application Reviewer', 'Designer', 'Plan Design', 'Production Manager', 'Project Manager'];

/** The five tags: name (≤25), description (≤256), colour, and the roles outside staff that see them */
export const TAGS = [
  { name: 'Before', color: '#3b82f6', roles: PHOTOS_SEEN_BY, staff: STAFF_SEE,
    description: 'Photos and videos from before the build, and room scans. Set by the website from when each was taken. Seen by partners, trades, design partners and photographers on the job.' },
  { name: 'During', color: '#f59e0b', roles: PHOTOS_SEEN_BY, staff: STAFF_SEE,
    description: 'Photos and videos from the Demo date until reveal day. Set by the website from when each was taken. Seen by partners, trades, design partners and photographers on the job.' },
  { name: 'After', color: '#22c55e', roles: PHOTOS_SEEN_BY, staff: STAFF_SEE,
    description: 'Photos and videos from reveal day on. Set by the website from when each was taken. Seen by partners, trades, design partners and photographers on the job.' },
  { name: 'Design', color: '#a855f7', roles: [...LEVEL_ROLES, DESIGN_ROLE], staff: STAFF_SEE,
    description: 'Layouts, 3Ds, presentations, inspiration and renderings. Seen by partners and design partners on the job. Never a family paper.' },
  { name: 'Plans', color: '#0ea5e9', roles: [...LEVEL_ROLES, TRADE_ROLE, DESIGN_ROLE], staff: STAFF_SEE,
    description: 'The current build set, specs and templates. Seen by partners, trades and design partners on the job. Never a family paper.' },
  // Staff only: the staff roles that see .PricingQuotes today, and nobody outside
  { name: 'Costs', color: '#64748b', roles: [], staff: ['Admin', 'Designer', 'Production Manager', 'Project Manager'],
    description: 'Pricing quotes, bills and receipts. Staff only. Set by the website: what QuickBooks sends, and files named like a quote, estimate, bill, invoice or receipt.' },
];
/** Old tags whose audience loses the family, by Peter's rule (no photos for families) */
const FAMILY_OFF = ['.BeforePics'];

const low = (s) => String(s || '').trim().toLowerCase();

export const SCHEMA = 'CREATE TABLE IF NOT EXISTS file_tags (name TEXT PRIMARY KEY, id TEXT NOT NULL, updated_at TEXT NOT NULL)';
const STATE = 'CREATE TABLE IF NOT EXISTS file_tags_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)';
const RUN_EVERY_MS = 60 * 60 * 1000;
const _ready = new WeakSet();
async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch([DB.prepare(SCHEMA), DB.prepare(STATE)]);
  _ready.add(DB);
}

/** The site's tag ids: Map(name → id) */
export async function tagIds(DB) {
  await ensureSchema(DB);
  const { results } = await DB.prepare('SELECT name, id FROM file_tags').all();
  return new Map((results || []).map((r) => [r.name, r.id]));
}

async function readOrg(key, fetchImpl) {
  // Roles and tag names first; each kept tag's audience after, one tag at a time (all of them at once is more than JobTread answers)
  const body = await pave(key, { organization: { $: { id: SOARD_ORG_ID },
    roles: { $: { size: 100 }, nodes: { id: {}, name: {}, type: {} } },
    fileTags: { $: { size: 100 }, nodes: { id: {}, name: {} } },
  } }, fetchImpl);
  const org = body?.organization;
  if (!Array.isArray(org?.roles?.nodes) || !Array.isArray(org?.fileTags?.nodes)) throw new Error('JobTread sent no roles or tags');
  return { roles: org.roles.nodes, tags: org.fileTags.nodes.map((t) => ({ ...t, aces: null })) };
}

/** A tag's access entries: [{ id, role: { id } }] */
async function tagAces(key, tagId, fetchImpl) {
  const body = await pave(key, { fileTag: { $: { id: tagId }, aces: { $: { size: 50 }, nodes: { id: {}, role: { id: {} } } } } }, fetchImpl);
  const nodes = body?.fileTag?.aces?.nodes;
  if (!Array.isArray(nodes)) throw new Error('JobTread sent no access entries for a tag');
  return nodes;
}

/**
 * Make any of the five tags that's missing and keep each one's audience as
 * TAGS says (notify off); take the family off the old .BeforePics.
 * → { made: [names], added: ['Before: Champion', …], removed: [...], missingRoles: [names] }
 */
export async function ensureTags(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  await ensureSchema(DB);
  const { roles, tags } = await readOrg(key, fetchImpl);
  const roleByName = new Map(roles.filter((r) => r.type !== 'internal').map((r) => [low(r.name), r]));
  const staffByName = new Map(roles.filter((r) => r.type === 'internal').map((r) => [low(r.name), r]));
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  // Staff roles are never touched: an entry staff gave their own role stays (it may be how that role sees the files)
  const staffRole = new Set(roles.filter((r) => r.type === 'internal').map((r) => r.id));
  const made = [];
  const added = [];
  const removed = [];
  const missingRoles = new Set();

  const setAudience = async (tag, wanted, staffWanted = []) => {
    const aces = tag.aces ?? await tagAces(key, tag.id, fetchImpl);
    const anyHave = new Set(aces.map((a) => a.role?.id).filter(Boolean));
    for (const roleId of staffWanted) {
      if (anyHave.has(roleId)) continue;
      await pave(key, { createAce: { $: { assignee: { roleId }, notify: false, targetType: 'fileTag', targetId: tag.id } } }, fetchImpl);
      added.push(`${tag.name}: ${roleName.get(roleId)}`);
    }
    const have = new Map(aces.filter((a) => a.role?.id && !staffRole.has(a.role.id)).map((a) => [a.role.id, a.id]));
    for (const roleId of wanted) {
      if (have.has(roleId)) continue;
      // A create answers with the query root (as createRole and createFile do); nothing is needed back
      // The assignee is flat, as for a membership in ./_jt-access.js: { roleId } (seen Nov 11: { role: { roleId } } is read as a person)
      await pave(key, { createAce: { $: { assignee: { roleId }, notify: false, targetType: 'fileTag', targetId: tag.id } } }, fetchImpl);
      added.push(`${tag.name}: ${roleName.get(roleId)}`);
    }
    for (const [roleId, aceId] of have) {
      if (wanted.includes(roleId)) continue;
      await pave(key, { deleteAce: { $: { id: aceId } } }, fetchImpl);
      removed.push(`${tag.name}: ${roleName.get(roleId) || roleId}`);
    }
  };

  const save = DB.prepare('INSERT INTO file_tags (name, id, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET id = excluded.id, updated_at = excluded.updated_at');
  for (const spec of TAGS) {
    let tag = tags.find((t) => low(t.name) === low(spec.name));
    if (!tag) {
      const body = await pave(key, { createFileTag: { $: { organizationId: SOARD_ORG_ID, name: spec.name, description: spec.description, color: spec.color }, createdFileTag: { id: {}, name: {} } } }, fetchImpl);
      const id = body?.createFileTag?.createdFileTag?.id;
      if (!id) throw new Error(`JobTread didn’t make the ${spec.name} tag`);
      tag = { id, name: spec.name, aces: [] };
      made.push(spec.name);
    }
    await save.bind(spec.name, tag.id, new Date(now).toISOString()).run();
    const wanted = [];
    for (const n of spec.roles) {
      const r = roleByName.get(low(n));
      if (r) wanted.push(r.id); else missingRoles.add(n);
    }
    const staffWanted = (spec.staff || []).map((n) => staffByName.get(low(n))?.id).filter(Boolean);
    await setAudience(tag, wanted, staffWanted);
  }

  // Families off the old photo tag: only the Makeover Family role's entry goes
  const family = roleByName.get(low(FAMILY_ROLE));
  for (const name of FAMILY_OFF) {
    const tag = tags.find((t) => low(t.name) === low(name));
    const ace = family && tag && (await tagAces(key, tag.id, fetchImpl)).find((a) => a.role?.id === family.id);
    if (!ace) continue;
    await pave(key, { deleteAce: { $: { id: ace.id } } }, fetchImpl);
    removed.push(`${tag.name}: ${FAMILY_ROLE}`);
  }

  if (made.length || added.length || removed.length) {
    await logAudit(DB, { userEmail: 'sync', action: 'updated', entityType: 'jobtread-tags', entityName: 'File tags in JobTread', changes: { made, added, removed } });
  }
  return { made, added, removed, missingRoles: [...missingRoles] };
}

/**
 * Every tag in JobTread, as it stands: name, who outside staff sees it, and
 * how many photos, videos and other files carry it (for moving the old tags
 * onto the five). One small read per tag. → [{ name, roles: [names], files, photos, videos }]
 */
export async function tagInventory(env, { fetchImpl = fetch } = {}) {
  const key = env.JOBTREAD_GRANT_KEY;
  const { roles, tags } = await readOrg(key, fetchImpl);
  const roleName = new Map(roles.map((r) => [r.id, `${r.name} (${r.type === 'internal' ? 'staff' : r.type})`]));
  const out = [];
  for (const t of tags) {
    const body = await pave(key, { fileTag: { $: { id: t.id },
      all: { _: 'files', $: { size: 1 }, count: {} },
      img: { _: 'files', $: { size: 1, where: ['type', 'like', 'image/%'] }, count: {} },
      vid: { _: 'files', $: { size: 1, where: ['type', 'like', 'video/%'] }, count: {} },
      first: { _: 'files', $: { size: 1, sortBy: [{ field: ['createdAt'], order: 'asc' }] }, nodes: { createdAt: {} } },
      last: { _: 'files', $: { size: 1, sortBy: [{ field: ['createdAt'], order: 'desc' }] }, nodes: { createdAt: {} } },
      aces: { $: { size: 50 }, nodes: { role: { id: {} } } } } }, fetchImpl);
    const f = body?.fileTag;
    out.push({ name: t.name, roles: (f?.aces?.nodes || []).map((a) => roleName.get(a.role?.id)).filter(Boolean).sort(),
      files: f?.all?.count ?? null, photos: f?.img?.count ?? null, videos: f?.vid?.count ?? null,
      oldest: f?.first?.nodes?.[0]?.createdAt?.slice(0, 10) || null, newest: f?.last?.nodes?.[0]?.createdAt?.slice(0, 10) || null });
  }
  return out.sort((a, b) => (b.files || 0) - (a.files || 0));
}

/** The heartbeat's call: once an hour (one run at a time), the five tags kept; the last result kept for Site → Automations. Never throws. */
export async function maybeKeepTags(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  if (!DB || !env.JOBTREAD_GRANT_KEY) return null;
  try {
    await ensureSchema(DB);
    const next = String(now + RUN_EVERY_MS);
    const iso = new Date(now).toISOString();
    const ins = await DB.prepare("INSERT OR IGNORE INTO file_tags_state (key, value, updated_at) VALUES ('turn', ?, ?)").bind(next, iso).run();
    if (!ins?.meta?.changes) {
      const upd = await DB.prepare("UPDATE file_tags_state SET value = ?, updated_at = ? WHERE key = 'turn' AND CAST(value AS INTEGER) <= ?").bind(next, iso, now).run();
      if (!upd?.meta?.changes) return null;
    }
    let last;
    try {
      const r = await ensureTags(env, { fetchImpl, now });
      last = { at: iso, ...r, error: null };
      // What every tag holds, kept for moving the old ones over (names and counts only)
      try { last.inventory = await tagInventory(env, { fetchImpl }); } catch (e) { last.inventoryError = String(e?.message || e).slice(0, 200); }
    } catch (e) {
      last = { at: iso, made: [], added: [], removed: [], missingRoles: [], error: String(e?.message || e).slice(0, 300) };
    }
    await DB.prepare("INSERT INTO file_tags_state (key, value, updated_at) VALUES ('last', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify(last), iso).run();
    return last;
  } catch (e) {
    console.error('[file-tags]', e?.message || e);
    return null;
  }
}

/** For Site → Automations: the last run and the tags the site keeps (names and counts only) */
export async function tagsFacts(DB) {
  await ensureSchema(DB);
  const v = await DB.prepare("SELECT value FROM file_tags_state WHERE key = 'last'").first('value');
  let last = null;
  try { last = v ? JSON.parse(v) : null; } catch { last = null; }
  return { last, kept: [...(await tagIds(DB)).keys()] };
}
