/**
 * GET /api/content-history?collection=kids&slug=<slug>          → { success, versions: [{ id, at, by, action, changed }] }
 * GET /api/content-history?collection=kids&slug=<slug>&id=<n>   → { success, data }
 * GET /api/content-history?collection=kids&deleted=1            → { success, deleted: [{ id, slug, name, year, image, at, by }] }
 *
 * Saved versions of a record, for the editors' History and restore, and the
 * items deleted since (Kids → Recently deleted). See _content-history.js.
 * Admin-only (the middleware requires Access for /api/* by default).
 */
import { HISTORY_TABLES, SLUG_RE, listVersions, getVersion, listDeleted } from './_content-history.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const collection = url.searchParams.get('collection') || '';
  const slug = url.searchParams.get('slug') || '';
  const id = url.searchParams.get('id');
  const headers = { 'Cache-Control': 'no-store' };
  if (!HISTORY_TABLES[collection]) return Response.json({ success: false, error: 'Unknown collection' }, { status: 400, headers });
  try {
    const DB = context.env.DB;
    if (url.searchParams.get('deleted')) return Response.json({ success: true, deleted: await listDeleted(DB, collection) }, { headers });
    if (!SLUG_RE.test(slug)) return Response.json({ success: false, error: 'Unknown item' }, { status: 400, headers });
    if (id) {
      const data = await getVersion(DB, collection, slug, Number(id));
      return data ? Response.json({ success: true, data }, { headers }) : Response.json({ success: false, error: 'That version is gone' }, { status: 404, headers });
    }
    return Response.json({ success: true, versions: await listVersions(DB, collection, slug) }, { headers });
  } catch (err) {
    console.error('[content-history]', err);
    return Response.json({ success: false, error: err.message || 'Couldn’t read the history' }, { status: 500, headers });
  }
}
