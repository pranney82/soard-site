/**
 * POST /api/save-content
 * Creates or updates content in D1 AND commits to GitHub.
 * Expects JSON body:
 *   {
 *     path: "src/content/kids/amari.json",
 *     content: "{ ... }",        // file content as JSON string
 *     message: "Update amari",   // used as git commit message
 *     sha: "..."                 // ignored — D1 uses upsert
 *   }
 *
 * Env bindings: DB (D1)
 * Env vars: GITHUB_TOKEN, GITHUB_REPO (required for git commits)
 *           GITHUB_BRANCH (optional, default "main")
 */

import { EXTRACTORS, parsePath, generateSha } from './_collections.js';
import { commitFile } from './_github.js';
import { logAudit, diffJson, getEntityName } from './_audit.js';

export async function onRequestPost(context) {
  try {
    const { DB } = context.env;
    const userEmail = context.data?.userEmail || 'unknown';
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
    const prettyJson = JSON.stringify(data, null, 2);
    const now = new Date().toISOString();

    // 0. Read old value for diffing
    let oldData = null;
    let isCreate = true;
    try {
      if (parsed.type === 'site') {
        const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(parsed.key).first();
        if (row) { oldData = JSON.parse(row.data); isCreate = false; }
      } else {
        const row = await DB.prepare(`SELECT data FROM ${parsed.table} WHERE slug = ?`).bind(parsed.slug).first();
        if (row) { oldData = JSON.parse(row.data); isCreate = false; }
      }
    } catch (e) { /* first save — no old data */ }

    // 1. Write to D1 (fast read cache for admin panel)
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

    // 2. Commit to GitHub (source of truth). Awaited so we can report status to admin.
    let gitStatus = 'ok';
    try {
      await commitFile(context.env, path, prettyJson + '\n', message);
    } catch (err) {
      gitStatus = 'failed';
      console.error('[save-content] GitHub commit failed:', err.message);
    }

    // 3. Audit log
    const entityType = parsed.type === 'site' ? parsed.key : parsed.table;
    const entitySlug = parsed.type === 'site' ? parsed.key : parsed.slug;
    const action = isCreate ? 'created' : (data.publishStatus === 'draft' ? 'drafted' : 'updated');

    await logAudit(DB, {
      userEmail,
      action,
      entityType,
      entitySlug,
      entityName: getEntityName(data, entityType),
      changes: isCreate ? null : diffJson(oldData, data),
      path,
      gitStatus,
    });

    return Response.json({
      success: true,
      sha,
      path,
      gitCommit: gitStatus,
    });
  } catch (err) {
    console.error("[save-content]", err);
    return Response.json(
      { success: false, error: err.message || "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
