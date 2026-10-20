/**
 * Saved versions of content records (kids, team, community projects), so the
 * editors can show who changed what and put an earlier version back, and
 * deleted items can come back. One table for every collection: content_versions.
 * save-content and delete-content record every collection listed in
 * HISTORY_TABLES, so adding one there is all a new editor needs.
 *
 *   - Every save records the version it wrote. The first save of an older
 *     record also records what was there before (no author, a second
 *     earlier), so the original can always come back.
 *   - A delete records the record that was deleted (action 'delete').
 *   - The newest 50 per item are kept.
 * Restoring loads a version into the editor; saving it records a new one.
 */

const KEEP = 50;
// Collection → its D1 table (the same name today; listed so nothing else is queried)
export const HISTORY_TABLES = { kids: 'kids', team: 'team', community: 'community', partners: 'partners', community_partners: 'community_partners', medialogos: 'medialogos' };
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
// Not edits: positions in a list, and counts derived from other fields
const IGNORED = new Set(['order', 'sortOrder', 'photoCount']);

export async function ensureHistory(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS content_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    slug TEXT NOT NULL,
    data TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'save',
    user_email TEXT,
    created_at TEXT NOT NULL
  )`).run();
  await DB.prepare('CREATE INDEX IF NOT EXISTS content_versions_item ON content_versions (collection, slug, id)').run();
}

const insert = (DB, { collection, slug, data, action = 'save', by = null, at }) =>
  DB.prepare('INSERT INTO content_versions (collection, slug, data, action, user_email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(collection, slug, JSON.stringify(data), action, by, at);

async function prune(DB, collection, slug) {
  await DB.prepare(`DELETE FROM content_versions WHERE collection = ? AND slug = ? AND id NOT IN
    (SELECT id FROM content_versions WHERE collection = ? AND slug = ? ORDER BY id DESC LIMIT ${KEEP})`)
    .bind(collection, slug, collection, slug).run();
}

/** Record the version just saved (and, the first time, the one it replaced) */
export async function recordVersion(DB, { collection, slug, data, previous = null, userEmail = null, now = new Date().toISOString() }) {
  await ensureHistory(DB);
  const has = await DB.prepare('SELECT id FROM content_versions WHERE collection = ? AND slug = ? LIMIT 1').bind(collection, slug).first();
  const stmts = [];
  // Before history began: kept with no author, a moment before this save
  if (!has && previous) stmts.push(insert(DB, { collection, slug, data: previous, at: new Date(Date.parse(now) - 1000).toISOString() }));
  stmts.push(insert(DB, { collection, slug, data, by: userEmail, at: now }));
  await DB.batch(stmts);
  await prune(DB, collection, slug);
}

/** Record a delete: the record as it was, so it can be restored */
export async function recordDeletion(DB, { collection, slug, data, userEmail = null, now = new Date().toISOString() }) {
  await ensureHistory(DB);
  await DB.batch([insert(DB, { collection, slug, data, action: 'delete', by: userEmail, at: now })]);
  await prune(DB, collection, slug);
}

/** Fields that differ between two versions (list positions and derived counts aside) */
export function changedFields(before, after) {
  if (!before) return [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of IGNORED) keys.delete(k);
  return [...keys].filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null)).sort();
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Newest first: { id, at, by, action, changed } (changed is null for the oldest) */
export async function listVersions(DB, collection, slug) {
  await ensureHistory(DB);
  const rows = (await DB.prepare('SELECT id, data, action, user_email, created_at FROM content_versions WHERE collection = ? AND slug = ? ORDER BY id ASC')
    .bind(collection, slug).all()).results || [];
  const out = [];
  let prev = null;
  for (const r of rows) {
    const d = parse(r.data) || {};
    out.push({ id: r.id, at: r.created_at, by: r.user_email || null, action: r.action || 'save', changed: prev ? changedFields(prev, d) : null });
    prev = d;
  }
  return out.reverse();
}

export async function getVersion(DB, collection, slug, id) {
  await ensureHistory(DB);
  const r = await DB.prepare('SELECT data FROM content_versions WHERE collection = ? AND slug = ? AND id = ?').bind(collection, slug, id).first();
  return r ? parse(r.data) : null;
}

/** Items deleted and not back since: the last delete of each, newest first */
export async function listDeleted(DB, collection, limit = 50) {
  const table = HISTORY_TABLES[collection];
  if (!table) return [];
  await ensureHistory(DB);
  const rows = (await DB.prepare(`SELECT v.id, v.slug, v.data, v.user_email, v.created_at FROM content_versions v
    WHERE v.collection = ? AND v.action = 'delete'
      AND v.id = (SELECT MAX(id) FROM content_versions w WHERE w.collection = v.collection AND w.slug = v.slug)
      AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.slug = v.slug)
    ORDER BY v.id DESC LIMIT ?`).bind(collection, limit).all()).results || [];
  return rows.map((r) => {
    const d = parse(r.data) || {};
    return { id: r.id, slug: r.slug, name: d.name || d.title || r.slug, year: d.year ?? null, image: d.heroImage || d.photo || d.imageId || d.logo || null, at: r.created_at, by: r.user_email || null };
  });
}

/** After a web address change, the history follows the item */
export async function moveVersions(DB, collection, from, to) {
  await ensureHistory(DB);
  await DB.prepare('UPDATE content_versions SET slug = ? WHERE collection = ? AND slug = ?').bind(to, collection, from).run();
}
