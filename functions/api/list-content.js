/**
 * GET /api/list-content?dir=src/content/kids
 *
 * Returns paginated content from D1.
 * For public/financials, lists files from R2 instead.
 *
 * Params:
 *   dir    — directory path (required), e.g. "src/content/kids"
 *   page   — page number, 0-indexed (default: 0)
 *   limit  — items per page (default: 50, max: 200)
 *   search — optional name/title search
 *
 * Env bindings: DB (D1), FILES (R2)
 */

import { SITE_PREFIX, NAME_COLUMN, resolveDirToTable } from './_collections.js';

const MAX_PER_PAGE = 200;

function isFinancialsDir(dir) {
  const normalized = dir.endsWith('/') ? dir : dir + '/';
  return normalized === 'public/financials/';
}

export async function onRequestGet(context) {
  try {
    const { DB, FILES } = context.env;
    const url = new URL(context.request.url);
    const dir = url.searchParams.get('dir');
    const page = parseInt(url.searchParams.get('page') || '0', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), MAX_PER_PAGE);
    const search = url.searchParams.get('search');

    if (!dir) {
      return Response.json(
        { success: false, error: 'Provide ?dir= parameter' },
        { status: 400 }
      );
    }

    // Handle R2 file listing for public/financials
    if (isFinancialsDir(dir)) {
      const listed = await FILES.list({ prefix: 'financials/' });
      const files = (listed.objects || []).map(obj => ({
        name: obj.key.split('/').pop(),
        path: `public/${obj.key}`,
        sha: obj.etag || obj.key,
        size: obj.size,
      }));
      return Response.json({ success: true, files });
    }

    const resolved = resolveDirToTable(dir);
    if (!resolved) {
      return Response.json(
        { success: false, error: 'Directory not allowed' },
        { status: 403 }
      );
    }

    const { table, prefix } = resolved;

    if (table === 'site_config') {
      const rows = await DB.prepare('SELECT key, data FROM site_config').all();
      const items = (rows.results || []).map(r => ({
        name: `${r.key}.json`,
        path: `${SITE_PREFIX}${r.key}.json`,
        sha: r.key,
        content: JSON.parse(r.data),
      }));
      return Response.json({
        success: true,
        count: items.length,
        total: items.length,
        page: 0,
        pages: 1,
        items,
      });
    }

    // Build query with optional search
    const nameCol = NAME_COLUMN[table] || 'slug';
    let countSql = `SELECT COUNT(*) as total FROM ${table}`;
    let dataSql = `SELECT slug, data FROM ${table}`;
    const bindings = [];

    if (search) {
      const whereClause = ` WHERE ${nameCol} LIKE ?`;
      countSql += whereClause;
      dataSql += whereClause;
      bindings.push(`%${search}%`);
    }

    dataSql += ` ORDER BY slug LIMIT ? OFFSET ?`;

    const countResult = await DB.prepare(countSql).bind(...bindings).first();
    const total = countResult?.total || 0;
    const pages = Math.ceil(total / limit);

    const dataBindings = [...bindings, limit, page * limit];
    const rows = await DB.prepare(dataSql).bind(...dataBindings).all();

    const items = (rows.results || []).map(r => ({
      name: `${r.slug}.json`,
      path: `${prefix}${r.slug}.json`,
      sha: r.slug,
      content: JSON.parse(r.data),
    }));

    return Response.json({
      success: true,
      count: items.length,
      total,
      page,
      pages,
      items,
    });
  } catch (err) {
    console.error("[list-content]", err);
    return Response.json(
      { success: false, error: err.message || "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
