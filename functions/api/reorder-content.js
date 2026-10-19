/**
 * POST /api/reorder-content
 * Saves a new order for many items in one request: one D1 batch, so the
 * order is never half-saved, and one audit entry per item that moved (so
 * Publish lists exactly who moved).
 *
 * Body: { collection: "team" | "kids", items: [{ slug, order }] }
 * Returns: { success, changed: [slug], shas: { slug: sha } }
 *
 * Admin-only (the middleware requires Access for /api/* not in PUBLIC_ROUTES).
 * Only the order changes: each row is read fresh and written back with just its
 * order replaced, so an edit saved meanwhile elsewhere is never overwritten.
 * Team rows keep it in `order`; kids in `sortOrder` (their place among the
 * active kids at the top of Meet the Kids).
 */
import { EXTRACTORS, generateSha } from './_collections.js';
import { commitFile } from './_github.js';
import { logAudit, diffJson, getEntityName } from './_audit.js';

// Collections that can be reordered here, and the field that holds the order
const REORDERABLE = {
  team: { dir: 'src/content/team/', field: 'order' },
  kids: { dir: 'src/content/kids/', field: 'sortOrder' },
};
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const MAX_ITEMS = 500;

export async function reorder(env, { collection, items } = {}, userEmail = 'unknown') {
  const cfg = REORDERABLE[collection];
  if (!cfg) return { status: 403, body: { success: false, error: 'This list can’t be reordered here' } };
  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) {
    return { status: 400, body: { success: false, error: 'Send the items in their new order' } };
  }
  const seen = new Set();
  for (const it of items) {
    if (!it || !SLUG_RE.test(it.slug || '') || !Number.isInteger(it.order) || it.order < 0 || seen.has(it.slug)) {
      return { status: 400, body: { success: false, error: 'Each item needs a slug and a whole-number order, once each' } };
    }
    seen.add(it.slug);
  }
  const { DB } = env;
  const table = collection;
  const rows = (await DB.prepare(`SELECT slug, data FROM ${table} WHERE slug IN (${items.map(() => '?').join(', ')})`)
    .bind(...items.map((i) => i.slug)).all()).results || [];
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const missing = items.filter((i) => !bySlug.has(i.slug)).map((i) => i.slug);
  if (missing.length) {
    return { status: 409, body: { success: false, error: `Not found (deleted meanwhile?): ${missing.join(', ')}. Reload and try again.` } };
  }

  const now = new Date().toISOString();
  const extractor = EXTRACTORS[table];
  const moved = [];
  const stmts = [];
  for (const it of items) {
    const before = JSON.parse(bySlug.get(it.slug).data);
    if (before[cfg.field] === it.order) continue;
    const after = { ...before, [cfg.field]: it.order };
    const json = JSON.stringify(after);
    const [cols, vals] = extractor(after);
    const all = ['"slug"', '"data"', '"updated_at"', ...cols];
    stmts.push(DB.prepare(`INSERT OR REPLACE INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`)
      .bind(it.slug, json, now, ...vals));
    moved.push({ slug: it.slug, before, after, json });
  }
  if (stmts.length) await DB.batch(stmts);

  const shas = {};
  for (const m of moved) {
    shas[m.slug] = await generateSha(m.json);
    const path = `${cfg.dir}${m.slug}.json`;
    let gitStatus = 'ok';
    try { await commitFile(env, path, JSON.stringify(m.after, null, 2) + '\n', `Reorder: ${m.after.name || m.slug}`); }
    catch { gitStatus = 'failed'; }
    await logAudit(DB, {
      userEmail, action: 'updated', entityType: table, entitySlug: m.slug,
      entityName: getEntityName(m.after, table), changes: diffJson(m.before, m.after), path, gitStatus,
    });
  }
  return { status: 200, body: { success: true, changed: moved.map((m) => m.slug), shas } };
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const r = await reorder(context.env, body, context.data?.userEmail || 'unknown');
    return Response.json(r.body, { status: r.status });
  } catch (err) {
    console.error('[reorder-content]', err);
    return Response.json({ success: false, error: err.message || 'Couldn’t save the order' }, { status: 500 });
  }
}
