/**
 * POST /api/people-batch
 * One change across many People records in one request, for the Photos review:
 *   { updates: [{ slug, set: { photoCutout: true } }] }
 *   { updates: [{ slug, set: { photoCrop: { x, y, size }, photoSize: [w, h] } }] }
 * Only the allowed photo fields change (false or null clears one); each row
 * is read fresh and written back in one D1 batch, with an audit entry and a
 * saved version per person.
 *
 * Admin-only (the middleware requires Access).
 */
import { EXTRACTORS, generateSha } from './_collections.js';
import { logAudit, diffJson, getEntityName } from './_audit.js';
import { recordVersion } from './_content-history.js';

const unit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const ALLOWED = {
  photoCutout: (v) => typeof v === 'boolean',
  // Fractions of the original photo (team-shared.js validCrop), or null for "center on the face"
  photoCrop: (v) => v === null || (!!v && typeof v === 'object' && unit(v.x) && unit(v.y) && unit(v.size) && v.size > 0 && Object.keys(v).length === 3),
  photoSize: (v) => v === null || (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n > 0 && n < 100000)),
};
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;

export async function batch(env, { updates } = {}, userEmail = 'unknown') {
  if (!Array.isArray(updates) || !updates.length || updates.length > 200) return { status: 400, body: { success: false, error: 'Nothing to change' } };
  for (const u of updates) {
    if (!SLUG_RE.test(u?.slug || '') || !u.set || typeof u.set !== 'object' || !Object.keys(u.set).length) return { status: 400, body: { success: false, error: 'Each change needs a person and a field' } };
    for (const [k, v] of Object.entries(u.set)) if (!ALLOWED[k] || !ALLOWED[k](v)) return { status: 400, body: { success: false, error: `“${k}” can’t be changed here` } };
  }
  const { DB } = env;
  const rows = (await DB.prepare(`SELECT slug, data FROM team WHERE slug IN (${updates.map(() => '?').join(', ')})`).bind(...updates.map((u) => u.slug)).all()).results || [];
  const bySlug = new Map(rows.map((r) => [r.slug, JSON.parse(r.data)]));
  const missing = updates.filter((u) => !bySlug.has(u.slug)).map((u) => u.slug);
  if (missing.length) return { status: 409, body: { success: false, error: `Not found (deleted meanwhile?): ${missing.join(', ')}` } };

  const now = new Date().toISOString();
  const stmts = [];
  const changed = [];
  for (const u of updates) {
    const before = bySlug.get(u.slug);
    const after = { ...before };
    for (const [k, v] of Object.entries(u.set)) { if (v === false || v === null) delete after[k]; else after[k] = v; }
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const [cols, vals] = EXTRACTORS.team(after);
    const all = ['"slug"', '"data"', '"updated_at"', ...cols];
    stmts.push(DB.prepare(`INSERT OR REPLACE INTO team (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`).bind(u.slug, JSON.stringify(after), now, ...vals));
    changed.push({ slug: u.slug, before, after });
  }
  if (stmts.length) await DB.batch(stmts);
  const shas = {};
  for (const c of changed) {
    shas[c.slug] = await generateSha(JSON.stringify(c.after));
    await logAudit(DB, { userEmail, action: 'updated', entityType: 'team', entitySlug: c.slug, entityName: getEntityName(c.after, 'team'), changes: diffJson(c.before, c.after), path: `src/content/team/${c.slug}.json` });
    try { await recordVersion(DB, { collection: 'team', slug: c.slug, data: c.after, previous: c.before, userEmail, now }); } catch {}
  }
  return { status: 200, body: { success: true, changed: changed.map((c) => c.slug), shas } };
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const r = await batch(context.env, body, context.data?.userEmail || 'unknown');
    return Response.json(r.body, { status: r.status });
  } catch (err) {
    console.error('[people-batch]', err);
    return Response.json({ success: false, error: err.message || 'Couldn’t save the changes' }, { status: 500 });
  }
}
