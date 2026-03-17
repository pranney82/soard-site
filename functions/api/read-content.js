/**
 * GET /api/read-content?path=src/content/kids/amari.json
 * Reads content from D1.
 *
 * GET /api/read-content?dir=src/content/kids
 * Lists files in a collection (returns names, paths, shas).
 *
 * Env bindings: DB (D1)
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

function resolvePathToQuery(path) {
  if (path.startsWith(SITE_PREFIX) && path.endsWith('.json')) {
    return { type: 'site', key: path.slice(SITE_PREFIX.length, -5) };
  }
  for (const [prefix, table] of Object.entries(COLLECTION_MAP)) {
    if (path.startsWith(prefix) && path.endsWith('.json')) {
      return { type: 'collection', table, slug: path.slice(prefix.length, -5), prefix };
    }
  }
  return null;
}

function resolveDirToTable(dir) {
  const normalized = dir.endsWith('/') ? dir : dir + '/';
  for (const [prefix, table] of Object.entries(COLLECTION_MAP)) {
    if (normalized === prefix || normalized.startsWith(prefix)) {
      return { table, prefix };
    }
  }
  if (normalized === 'src/content/site/' || normalized.startsWith('src/content/site/')) {
    return { table: 'site_config', prefix: SITE_PREFIX };
  }
  return null;
}

async function generateSha(content) {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-1', encoder.encode(content));
  return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet(context) {
  try {
    const { DB } = context.env;
    const url = new URL(context.request.url);
    const path = url.searchParams.get('path');
    const dir = url.searchParams.get('dir');

    // Read single file
    if (path) {
      const resolved = resolvePathToQuery(path);
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
