/**
 * GET /api/read-content?path=src/content/kids/amari.json
 * Reads content from D1.
 *
 * GET /api/read-content?dir=src/content/kids
 * Lists files in a collection (returns names, paths, shas).
 *
 * Env bindings: DB (D1)
 */

import { SITE_PREFIX, parsePath, resolveDirToTable, generateSha } from './_collections.js';

export async function onRequestGet(context) {
  try {
    const { DB } = context.env;
    const url = new URL(context.request.url);
    const path = url.searchParams.get('path');
    const dir = url.searchParams.get('dir');

    // Read single file
    if (path) {
      const resolved = parsePath(path);
      if (!resolved) {
        return Response.json({ success: false, error: 'Path not allowed' }, { status: 403 });
      }

      let content;
      if (resolved.type === 'site') {
        const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?')
          .bind(resolved.key).first();
        if (!row) {
          return Response.json({ success: false, error: 'Not found' }, { status: 404 });
        }
        content = row.data;
      } else {
        const row = await DB.prepare(`SELECT data FROM ${resolved.table} WHERE slug = ?`)
          .bind(resolved.slug).first();
        if (!row) {
          return Response.json({ success: false, error: 'Not found' }, { status: 404 });
        }
        content = row.data;
      }

      const sha = await generateSha(content);
      const name = path.split('/').pop();

      return Response.json({
        success: true,
        content,
        sha,
        name,
        path,
      });
    }

    // List directory
    if (dir) {
      const resolved = resolveDirToTable(dir);
      if (!resolved) {
        return Response.json({ success: false, error: 'Directory not allowed' }, { status: 403 });
      }

      let fileList;
      if (resolved.table === 'site_config') {
        const rows = await DB.prepare('SELECT key, data FROM site_config').all();
        fileList = await Promise.all((rows.results || []).map(async (r) => ({
          name: `${r.key}.json`,
          path: `${SITE_PREFIX}${r.key}.json`,
          sha: await generateSha(r.data),
          size: r.data.length,
        })));
      } else {
        const rows = await DB.prepare(`SELECT slug, data FROM ${resolved.table}`).all();
        fileList = await Promise.all((rows.results || []).map(async (r) => ({
          name: `${r.slug}.json`,
          path: `${resolved.prefix}${r.slug}.json`,
          sha: await generateSha(r.data),
          size: r.data.length,
        })));
      }

      return Response.json({ success: true, files: fileList });
    }

    return Response.json(
      { success: false, error: 'Provide ?path= or ?dir= parameter' },
      { status: 400 }
    );
  } catch (err) {
    console.error("[read-content]", err);
    return Response.json(
      { success: false, error: err.message || "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
