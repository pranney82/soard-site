/**
 * POST /api/delete-content
 * Deletes content from D1.
 * Expects JSON body:
 *   {
 *     path: "src/content/kids/amari.json",
 *     sha: "...",              // ignored — kept for admin panel compatibility
 *     message: "Remove amari"  // kept for compatibility
 *   }
 *
 * Env bindings: DB (D1)
 * Env vars: CF_PAGES_DEPLOY_HOOK (optional — triggers rebuild after delete, debounced)
 */

import { parsePath } from './_collections.js';
import { recordAndFlush } from './_deploy-queue.js';

export async function onRequestPost(context) {
  try {
    const { DB } = context.env;
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

    if (parsed.type === 'site') {
      await DB.prepare('DELETE FROM site_config WHERE key = ?')
        .bind(parsed.key).run();
    } else {
      await DB.prepare(`DELETE FROM ${parsed.table} WHERE slug = ?`)
        .bind(parsed.slug).run();
    }

    // Queue a debounced Pages rebuild (batches rapid edits into one deploy)
    const { CF_PAGES_DEPLOY_HOOK } = context.env;
    await recordAndFlush(DB, CF_PAGES_DEPLOY_HOOK, context);

    return Response.json({ success: true });
  } catch (err) {
    console.error("[delete-content]", err);
    return Response.json(
      { success: false, error: err.message || "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
