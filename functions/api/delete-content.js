/**
 * POST /api/delete-content
 * Deletes content from D1 AND removes the file from GitHub.
 * Expects JSON body:
 *   {
 *     path: "src/content/kids/amari.json",
 *     sha: "...",              // ignored — kept for admin panel compatibility
 *     message: "Remove amari"  // used as git commit message
 *   }
 *
 * Env bindings: DB (D1)
 * Env vars: GITHUB_TOKEN, GITHUB_REPO (required for git commits)
 *           GITHUB_BRANCH (optional, default "main")
 */

import { parsePath } from './_collections.js';
import { deleteFile } from './_github.js';
import { logAudit, getEntityName } from './_audit.js';

export async function onRequestPost(context) {
  try {
    const { DB } = context.env;
    const userEmail = context.data?.userEmail || 'unknown';
    const { path, message } = await context.request.json();

    if (!path || !message) {
      return Response.json(
        { success: false, error: 'Missing required fields: path, message' },
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

    // 0. Read old value before deleting (for audit trail)
    let oldData = null;
    let entityName = null;
    try {
      if (parsed.type === 'site') {
        const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(parsed.key).first();
        if (row) { oldData = JSON.parse(row.data); entityName = getEntityName(oldData); }
      } else {
        const row = await DB.prepare(`SELECT data FROM ${parsed.table} WHERE slug = ?`).bind(parsed.slug).first();
        if (row) { oldData = JSON.parse(row.data); entityName = getEntityName(oldData); }
      }
    } catch (e) { /* ok */ }

    // 1. Delete from D1 (read cache)
    if (parsed.type === 'site') {
      await DB.prepare('DELETE FROM site_config WHERE key = ?')
        .bind(parsed.key).run();
    } else {
      await DB.prepare(`DELETE FROM ${parsed.table} WHERE slug = ?`)
        .bind(parsed.slug).run();
    }

    // 2. Delete from GitHub (awaited so we can report status to admin)
    let gitStatus = 'ok';
    try {
      await deleteFile(context.env, path, message);
    } catch (err) {
      gitStatus = 'failed';
      console.error('[delete-content] GitHub delete failed:', err.message);
    }

    // 3. Audit log
    const entityType = parsed.type === 'site' ? parsed.key : parsed.table;
    const entitySlug = parsed.type === 'site' ? parsed.key : parsed.slug;

    await logAudit(DB, {
      userEmail,
      action: 'deleted',
      entityType,
      entitySlug,
      entityName,
      changes: null,
      path,
      gitStatus,
    });

    return Response.json({ success: true, gitCommit: gitStatus });
  } catch (err) {
    console.error("[delete-content]", err);
    return Response.json(
      { success: false, error: err.message || "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
