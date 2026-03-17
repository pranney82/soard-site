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

const EXTRACTORS = {
  kids: (d) => [
    'd.name, d.year ?? null, d.status || "completed", d.featured ? 1 : 0, d.childCount ?? 1, d.roomCount ?? 1',
    ['name', 'year', 'status', 'featured', 'child_count', 'room_count'],
    [d.name, d.year ?? null, d.status || 'completed', d.featured ? 1 : 0, d.childCount ?? 1, d.roomCount ?? 1],
  ],
  partners: (d) => [null, ['name', 'tier', 'featured'], [d.name, d.tier ?? null, d.featured ? 1 : 0]],
  press: (d) => [null, ['title', 'date', 'category', 'featured'], [d.title ?? null, d.date ?? null, d.category ?? null, d.featured ? 1 : 0]],
  team: (d) => [null, ['name', '"group"', 'order_num'], [d.name, d.group ?? null, d.order ?? 0]],
  events: (d) => [null, ['title', 'date', 'status', 'featured'], [d.title, d.date ?? null, d.status || 'upcoming', d.featured ? 1 : 0]],
  community: (d) => [null, ['name', 'order_num'], [d.name, d.order ?? 0]],
  articles: (d) => [null, ['title', 'featured', 'order_num'], [d.title, d.featured ? 1 : 0, d.order ?? 0]],
};

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
        const [, colNames, colValues] = extractor(data);
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

    // Generate a deterministic fake sha for admin panel compatibility
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-1', encoder.encode(jsonStr));
    const sha = [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');

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
