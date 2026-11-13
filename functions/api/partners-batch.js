/**
 * POST /api/partners-batch
 * Admin → Partners changes that touch many records at once:
 *
 *   { updates: [{ slug, set: { level, featured, tagline, category, order }, add: ['design'], remove: ['build'],
 *                 addFolders: ['cr-construction'], removeFolders: [...] }] }
 *     Several partners at once (select rows, then Set level / categories /
 *     highlight; Undo puts the fields back). add/remove change categories on
 *     each partner's own list (after set.category, when both are sent);
 *     set.category null means "none chosen". addFolders/removeFolders link
 *     upload folders seen on kid pages to the partner (logoFolders: the site
 *     drops it, the admin counts those kid pages for them).
 *
 *   { swapLogo: { from, to, name } }
 *     After a partner's logo is replaced: every kid page showing the old
 *     logo shows the new one (and gets the partner's name if it had none).
 *
 * Only the fields asked for change, with Save's rules for just those
 * (applyPartnerChange in public/admin/partners-shared.js): a partner moved
 * into Signature or Champion goes to the end of that section, one moved into
 * the directory gets order 0, and nothing else on the record is touched.
 * Each row is written only if it's still what was read (UPDATE … WHERE data
 * = what was read); one saved meanwhile is read again and changed once more,
 * and is skipped (listed in `conflicts`) if it moved again. Every write gets
 * an audit entry, a saved version and the GitHub copy, like save-content.
 * At most 100 partners per request (each costs a few D1 queries); the admin
 * sends bigger selections in turns.
 *
 * Admin-only (not in the middleware's PUBLIC_ROUTES, so it requires Access).
 */
import { EXTRACTORS, generateSha } from './_collections.js';
import { commitFile } from './_github.js';
import { logAudit, diffJson, getEntityName } from './_audit.js';
import { recordVersion } from './_content-history.js';
import { applyPartnerChange, LEVELS, CATEGORIES, cfId, LOGO_FOLDER_RE, kidUsage, nameKey, wordsKey } from '../../public/admin/partners-shared.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const MAX = 100;
const LEVEL_IDS = new Set(LEVELS.map((l) => l.id));
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
const cats = (v) => Array.isArray(v) && v.length <= 4 && v.every((c) => CATEGORY_IDS.has(c));
const folders = (v) => Array.isArray(v) && v.length <= 10 && v.every((f) => typeof f === 'string' && LOGO_FOLDER_RE.test(f));
const SET = {
  level: (v) => LEVEL_IDS.has(v),
  featured: (v) => typeof v === 'boolean',
  tagline: (v) => typeof v === 'string' && v.length <= 160,
  // A whole list (or null: none chosen) or a place, so Undo can put a partner back exactly
  category: (v) => v === null || (cats(v) && v.length >= 1),
  order: (v) => Number.isInteger(v) && v >= 0 && v < 100000,
};
const IMAGE_RE = /^https:\/\/(imagedelivery\.net|[a-z0-9.-]+\/cdn-cgi\/imagedelivery)\/[^\s]+$/;
const DIR = { partners: 'src/content/partners/', kids: 'src/content/kids/', community: 'src/content/community/' };

const read = async (DB, table, slugs) => {
  const out = new Map();
  // D1 takes 100 bound parameters per query
  for (let i = 0; i < slugs.length; i += 90) {
    const part = slugs.slice(i, i + 90);
    const rows = (await DB.prepare(`SELECT slug, data FROM ${table} WHERE slug IN (${part.map(() => '?').join(', ')})`).bind(...part).all()).results || [];
    for (const r of rows) out.set(r.slug, r.data);
  }
  return out;
};
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

/**
 * Write each row only if it's still what was read; a row changed meanwhile is
 * read again and changed once more (change(slug, before) → after, or null)
 */
async function writeChecked(DB, table, rows, change, now) {
  const extractor = EXTRACTORS[table];
  const update = (r) => {
    const [cols, vals] = extractor(r.after);
    const sets = ['"data" = ?', '"updated_at" = ?', ...cols.map((c) => `${c} = ?`)];
    return DB.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE slug = ? AND data = ?`).bind(JSON.stringify(r.after), now, ...vals, r.slug, r.raw);
  };
  const done = [];
  let todo = rows;
  let lost = [];
  for (let attempt = 0; attempt < 2 && todo.length; attempt++) {
    const results = await DB.batch(todo.map(update));
    const again = [];
    todo.forEach((r, i) => { if (results[i]?.meta?.changes) done.push(r); else again.push(r.slug); });
    if (!again.length) break;
    if (attempt) { lost = again; break; }
    const fresh = await read(DB, table, again);
    todo = again.map((slug) => {
      const raw = fresh.get(slug);
      const before = raw && parse(raw);
      const after = before && change(slug, before);
      return after && JSON.stringify(after) !== JSON.stringify(before) ? { slug, raw, before, after } : null;
    }).filter(Boolean);
  }
  return { done, conflicts: lost };
}
async function record(env, table, rows, userEmail, now, message) {
  const { DB } = env;
  const shas = {};
  for (const r of rows) {
    shas[r.slug] = await generateSha(JSON.stringify(r.after));
    const path = `${DIR[table]}${r.slug}.json`;
    let gitStatus = 'ok';
    try { await commitFile(env, path, JSON.stringify(r.after, null, 2) + '\n', `${message}: ${r.after.name || r.slug}`); } catch { gitStatus = 'failed'; }
    await logAudit(DB, { userEmail, action: 'updated', entityType: table, entitySlug: r.slug, entityName: getEntityName(r.after, table), changes: diffJson(r.before, r.after), path, gitStatus });
    try { await recordVersion(DB, { collection: table, slug: r.slug, data: r.after, previous: r.before, userEmail, now }); } catch {}
  }
  return shas;
}

export async function updatePartners(env, updates, userEmail = 'unknown') {
  if (!Array.isArray(updates) || !updates.length || updates.length > MAX) return { status: 400, body: { success: false, error: `Send 1 to ${MAX} partners at a time` } };
  const seen = new Set();
  for (const u of updates) {
    if (!SLUG_RE.test(u?.slug || '') || seen.has(u.slug)) return { status: 400, body: { success: false, error: 'Each change needs a partner, once' } };
    seen.add(u.slug);
    const set = u.set || {};
    if (typeof set !== 'object' || Array.isArray(set)) return { status: 400, body: { success: false, error: 'Nothing to change' } };
    for (const [k, v] of Object.entries(set)) if (!SET[k] || !SET[k](v)) return { status: 400, body: { success: false, error: `“${k}” can’t be changed here` } };
    if ((u.add != null && !cats(u.add)) || (u.remove != null && !cats(u.remove))) return { status: 400, body: { success: false, error: 'Unknown category' } };
    if ((u.addFolders != null && !folders(u.addFolders)) || (u.removeFolders != null && !folders(u.removeFolders))) return { status: 400, body: { success: false, error: 'Unknown logo folder' } };
    if (!Object.keys(set).length && !u.add?.length && !u.remove?.length && !u.addFolders?.length && !u.removeFolders?.length) return { status: 400, body: { success: false, error: 'Nothing to change' } };
  }
  const { DB } = env;
  const raws = await read(DB, 'partners', updates.map((u) => u.slug));
  const missing = updates.filter((u) => !raws.has(u.slug)).map((u) => u.slug);
  if (missing.length) return { status: 409, body: { success: false, error: `Not found (deleted meanwhile?): ${missing.join(', ')}. Reload and try again.` } };

  // Partners moving into a sortable section line up after the ones already there
  // (by the level in each record, not the indexed column)
  const next = {};
  const all = ((await DB.prepare('SELECT data FROM partners').all()).results || []).map((r) => parse(r.data)).filter(Boolean);
  for (const l of LEVELS.filter((x) => x.sortable)) next[l.id] = all.filter((p) => p.level === l.id).reduce((m, p) => Math.max(m, (Number(p.order) || 0) + 1), 0);

  const bySlug = new Map(updates.map((u) => [u.slug, u]));
  const placed = new Map(); // slug → its new place, so a second try keeps it
  // `from: { level: [...] }`: changed only from one of those levels, as it is at the moment it's written (Move to
  // Champion is an upgrade from Builder or Friend: a partner moved to Signature meanwhile is left as it is)
  const refused = new Set();
  const change = (slug, before) => {
    const u = bySlug.get(slug);
    if (Array.isArray(u.from?.level) && !u.from.level.includes(before.level || 'friend')) { refused.add(slug); return before; }
    refused.delete(slug);
    const patch = { ...(u.set || {}) };
    if (u.add?.length || u.remove?.length) {
      const startFrom = 'category' in patch ? (patch.category || []) : (Array.isArray(before.category) ? before.category : before.category ? [before.category] : []);
      const had = startFrom.filter((c) => CATEGORY_IDS.has(c));
      const list = [...new Set([...had, ...(u.add || [])])].filter((c) => !(u.remove || []).includes(c));
      // Taking away the last one leaves it as it was
      if (list.length) patch.category = list;
    }
    if (u.addFolders?.length || u.removeFolders?.length) {
      patch.logoFolders = [...new Set([...(Array.isArray(before.logoFolders) ? before.logoFolders : []), ...(u.addFolders || [])])].filter((f) => !(u.removeFolders || []).includes(f));
    }
    if (patch.level && patch.order == null && patch.level !== (before.level || 'friend') && next[patch.level] != null) {
      if (!placed.has(slug)) placed.set(slug, next[patch.level]++);
      patch.order = placed.get(slug);
    }
    const after = applyPartnerChange(before, patch);
    if (Array.isArray(after.logoFolders) && !after.logoFolders.length) delete after.logoFolders;
    return after;
  };
  const rows = [];
  for (const u of updates) {
    const raw = raws.get(u.slug);
    const before = parse(raw);
    if (!before) continue;
    const after = change(u.slug, before);
    if (JSON.stringify(before) !== JSON.stringify(after)) rows.push({ slug: u.slug, raw, before, after });
  }
  const now = new Date().toISOString();
  const { done, conflicts } = await writeChecked(DB, 'partners', rows, change, now);
  const shas = await record(env, 'partners', done, userEmail, now, 'Update partner');
  return { status: 200, body: { success: true, changed: done.map((c) => c.slug), conflicts, shas, ...(refused.size ? { refused: [...refused] } : {}) } };
}

export async function swapLogo(env, { from, to, name } = {}, userEmail = 'unknown') {
  if (!IMAGE_RE.test(from || '') || !IMAGE_RE.test(to || '') || cfId(from) === cfId(to)) return { status: 400, body: { success: false, error: 'Send the old and the new logo' } };
  const { DB } = env;
  const old = cfId(from);
  const label = String(name || '').trim().slice(0, 120);
  const change = (slug, before) => {
    const logos = Array.isArray(before.partnerLogos) ? before.partnerLogos : [];
    if (!logos.some((l) => cfId(l?.url) === old)) return null;
    return { ...before, partnerLogos: logos.map((l) => (cfId(l?.url) === old ? { ...l, url: to, name: String(l.name || '').trim() || label } : l)) };
  };
  const rows = [];
  for (const r of (await DB.prepare('SELECT slug, data FROM kids').all()).results || []) {
    const before = parse(r.data);
    const after = before && change(r.slug, before);
    if (after) rows.push({ slug: r.slug, raw: r.data, before, after });
  }
  const now = new Date().toISOString();
  const { done, conflicts } = await writeChecked(DB, 'kids', rows, change, now);
  const shas = await record(env, 'kids', done, userEmail, now, 'Partner logo');
  return { status: 200, body: { success: true, changed: done.map((c) => c.slug), conflicts, shas } };
}

/**
 * Logos off one page, for "take off this makeover" (./_vendor-access.js takeOffJob): every logo of a partner, or
 * these files. sha: what the editor has; when it's still right, the page's new one comes back so its next Save fits.
 * → { removed: [{ url, name, at }], sha? }. A page that changed under it is read again (writeChecked).
 */
export async function pageLogosOff(env, { table, slug, partner = null, urls = [], sha = null }, userEmail = 'unknown') {
  const { DB } = env;
  const raw = (await read(DB, table, [slug])).get(slug);
  const before = raw && parse(raw);
  if (!before) throw Object.assign(new Error('That page isn’t there any more. Reload and try again.'), { status: 409 });
  const partners = partner ? ((await DB.prepare('SELECT slug, data FROM partners').all()).results || []).map((r) => ({ ...(parse(r.data) || {}), slug: r.slug })) : [];
  const company = partners.find((p) => p.slug === partner);
  const files = new Set(urls.map(cfId));
  let removed = [];
  const change = (s, data) => {
    const logos = Array.isArray(data.partnerLogos) ? data.partnerLogos : [];
    const ids = new Set(company ? (kidUsage([{ ...data, slug: s, publishStatus: 'published' }], partners).byPartner.get(partner) || []).map((row) => cfId(row.url)) : []);
    const named = (l) => !!company && ((!!nameKey(l?.name) && nameKey(l.name) === nameKey(company.name)) || (!!wordsKey(l?.name) && wordsKey(l.name) === wordsKey(company.name)));
    const theirs = (l) => files.has(cfId(l?.url)) || ids.has(cfId(l?.url)) || named(l);
    removed = logos.map((l, at) => ({ url: l?.url, name: l?.name || '', at })).filter((l) => theirs(l));
    return removed.length ? { ...data, partnerLogos: logos.filter((l) => !theirs(l)) } : null;
  };
  const after = change(slug, before);
  if (!after) return { removed: [] };
  const now = new Date().toISOString();
  const { done } = await writeChecked(DB, table, [{ slug, raw, before, after }], change, now);
  if (!done.length) throw Object.assign(new Error('Someone saved that page just now. Reload and try again.'), { status: 409 });
  const had = await generateSha(raw);
  const shas = await record(env, table, done, userEmail, now, 'Taken off the makeover');
  return { removed, ...(sha && sha === had ? { sha: shas[slug] } : {}) };
}

/** Undo: those logos back where they were → { sha? } */
export async function pageLogosOn(env, { table, slug, logos, sha = null }, userEmail = 'unknown') {
  if (!Array.isArray(logos) || !logos.length || logos.length > 20 || !logos.every((l) => IMAGE_RE.test(l?.url || ''))) throw Object.assign(new Error('Nothing to put back'), { status: 400 });
  const { DB } = env;
  const raw = (await read(DB, table, [slug])).get(slug);
  const before = raw && parse(raw);
  if (!before) throw Object.assign(new Error('That page isn’t there any more. Reload and try again.'), { status: 409 });
  const change = (s, data) => {
    const list = [...(Array.isArray(data.partnerLogos) ? data.partnerLogos : [])];
    for (const l of [...logos].sort((a, b) => (a.at || 0) - (b.at || 0))) {
      if (list.some((x) => cfId(x?.url) === cfId(l.url))) continue;
      list.splice(Math.min(Number(l.at) || 0, list.length), 0, { url: l.url, name: String(l.name || '').trim().slice(0, 200) });
    }
    return list.length === (data.partnerLogos || []).length ? null : { ...data, partnerLogos: list };
  };
  const after = change(slug, before);
  if (!after) return {};
  const now = new Date().toISOString();
  const { done } = await writeChecked(DB, table, [{ slug, raw, before, after }], change, now);
  if (!done.length) throw Object.assign(new Error('Someone saved that page just now. Reload and try again.'), { status: 409 });
  const had = await generateSha(raw);
  const shas = await record(env, table, done, userEmail, now, 'Put back on the makeover');
  return sha && sha === had ? { sha: shas[slug] } : {};
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const who = context.data?.userEmail || 'unknown';
    const r = body.swapLogo ? await swapLogo(context.env, body.swapLogo, who) : await updatePartners(context.env, body.updates, who);
    return Response.json(r.body, { status: r.status });
  } catch (err) {
    console.error('[partners-batch]', err);
    return Response.json({ success: false, error: err.message || 'Couldn’t save the changes' }, { status: 500 });
  }
}
