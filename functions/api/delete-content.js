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
 * Env vars: CF_PAGES_DEPLOY_HOOK (optional — triggers rebuild after delete)
 */

const COLLECTION_MAP = {
  'src/content/kids/': 'kids',
  'src/content/partners/': 'partners',
  'src/content/press/': 'press',
  'src/content/team/': 'team',
  'src/content/events/': 'events',
  'src/content/community/': 'community',
  'src/content/articles/': 'articles',
};

const SITE_PREFIX = 'src/content/site/';

function parsePath(path) {
  if (path.startsWith(SITE_PREFIX) && path.endsWith('.json')) {
    return { type: 'site', key: path.slice(SITE_PREFIX.length, -5) };
  }
  for (const [prefix, table] of Object.entries(COLLECTION_MAP)) {
    if (path.startsWith(prefix) && path.endsWith('.json')) {
      return { type: 'collection', table, slug: path.slice(prefix.length, -5) };
    }
  }
  return null;
}

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

    // Trigger a Pages rebuild
    const { CF_PAGES_DEPLOY_HOOK } = context.env;
    if (CF_PAGES_DEPLOY_HOOK) {
      context.waitUntil(
        fetch(CF_PAGES_DEPLOY_HOOK, { method: 'POST' }).catch(() => {})
      );
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error("[delete-content]", err);
    return Response.json(
      { success: false, error: err.message || "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
