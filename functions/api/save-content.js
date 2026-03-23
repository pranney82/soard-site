/**
 * POST /api/save-content
 * Creates or updates content in D1.
 * Expects JSON body:
 *   {
 *     path: "src/content/kids/amari.json",
 *     content: "{ ... }",        // file content as JSON string
 *     message: "Update amari",   // kept for admin panel compatibility
 *     sha: "..."                 // ignored — D1 uses upsert
 *   }
 *
 * Env bindings: DB (D1)
 * Env vars: CF_PAGES_DEPLOY_HOOK (optional — triggers rebuild after save)
 */

import { EXTRACTORS, parsePath, generateSha } from './_collections.js';

export async function onRequestPost(context) {
  try {
    const { DB } = context.env;
    const { path, content, message } = await context.request.json();

    if (!path || content === undefined || !message) {
      return Response.json(
        { success: false, error: 'Missing required fields: path, content, message' },
        { status: 400 }
      );
    }

    const parsed = parsePath(path);
    if (!parsed) {
      return Response.json(
        { success: false, error: 'Path not allowed' },
        { status: 403 }
      );
    }

    const data = typeof content === 'string' ? JSON.parse(content) : content;
    const jsonStr = JSON.stringify(data);
    const now = new Date().toISOString();

    if (parsed.type === 'site') {
      await DB.prepare(
        'INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)'
      ).bind(parsed.key, jsonStr, now).run();
    } else {
      const { table, slug } = parsed;
      const extractor = EXTRACTORS[table];

      if (extractor) {
        const [colNames, colValues] = extractor(data);
        const allCols = ['slug', 'data', 'updated_at', ...colNames];
        const placeholders = allCols.map(() => '?').join(', ');
        const allValues = [slug, jsonStr, now, ...colValues];

        await DB.prepare(
          `INSERT OR REPLACE INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders})`
        ).bind(...allValues).run();
      } else {
        await DB.prepare(
          `INSERT OR REPLACE INTO ${table} (slug, data, updated_at) VALUES (?, ?, ?)`
        ).bind(slug, jsonStr, now).run();
      }
    }

    const sha = await generateSha(jsonStr);

    // Trigger a Pages rebuild so the static site reflects the change
    const { CF_PAGES_DEPLOY_HOOK } = context.env;
    if (CF_PAGES_DEPLOY_HOOK) {
      context.waitUntil(
        fetch(CF_PAGES_DEPLOY_HOOK, { method: 'POST' }).catch(() => {})
      );
    }

    return Response.json({
      success: true,
      sha,
      path,
    });
  } catch (err) {
    console.error("[save-content]", err);
    return Response.json(
      { success: false, error: err.message || "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
