/**
 * Shared collection configuration — single source of truth.
 * Used by save-content, read-content, list-content, delete-content, and prebuild.
 */

export const COLLECTION_MAP = {
  'src/content/kids/': 'kids',
  'src/content/partners/': 'partners',
  'src/content/press/': 'press',
  'src/content/team/': 'team',
  'src/content/events/': 'events',
  'src/content/community/': 'community',
  'src/content/articles/': 'articles',
  'src/content/medialogos/': 'medialogos',
  'src/content/communityPartners/': 'community_partners',
};

export const SITE_PREFIX = 'src/content/site/';

/** Column used for search/display per collection */
export const NAME_COLUMN = {
  kids: 'name',
  partners: 'name',
  press: 'title',
  team: 'name',
  events: 'title',
  community: 'name',
  articles: 'title',
  medialogos: 'name',
  community_partners: 'name',
};

/** Indexed column extractors for INSERT OR REPLACE.
 *  All column names are double-quoted to prevent SQLite keyword collisions
 *  (e.g. "group", "order", "date", "status" are all reserved words). */
export const EXTRACTORS = {
  kids: (d) => [
    ['"name"', '"year"', '"status"', '"featured"', '"child_count"', '"room_count"'],
    [d.name, d.year ?? null, d.status || 'completed', d.featured ? 1 : 0, d.childCount ?? 1, d.roomCount ?? 1],
  ],
  partners: (d) => [
    ['"name"', '"level"', '"category"', '"featured"'],
    [d.name, d.level ?? null, Array.isArray(d.category) ? d.category.join(',') : (d.category ?? null), d.featured ? 1 : 0],
  ],
  press: (d) => [
    ['"title"', '"date"', '"category"', '"featured"'],
    [d.title ?? null, d.date ?? null, d.category ?? null, d.featured ? 1 : 0],
  ],
  team: (d) => [
    ['"name"', '"group"', '"order_num"'],
    [d.name, d.group ?? null, d.order ?? 0],
  ],
  events: (d) => [
    ['"title"', '"date"', '"status"', '"featured"'],
    [d.title, d.date ?? null, d.status || 'upcoming', d.featured ? 1 : 0],
  ],
  community: (d) => [
    ['"name"', '"order_num"'],
    [d.name, d.order ?? 0],
  ],
  articles: (d) => [
    ['"title"', '"featured"', '"order_num"'],
    [d.title, d.featured ? 1 : 0, d.order ?? 0],
  ],
  medialogos: (d) => [
    ['"name"', '"order_num"'],
    [d.name, d.order ?? 0],
  ],
  community_partners: (d) => [
    ['"name"', '"category"', '"featured"', '"order_num"'],
    [d.name, d.category ?? null, d.featured ? 1 : 0, d.order ?? 0],
  ],
};

/**
 * Parse a content path into { type, table, slug } or { type: 'site', key }.
 * Returns null if path is not a recognized content path.
 */
/**
 * A record's file name (a slug, or a site doc's key): letters, digits, - and _,
 * with single dots between parts. No slashes and no "..", so a save or delete
 * can never reach outside its collection (the build writes src/content/<dir>/<name>.json).
 */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
export const isSafeName = (name) => typeof name === 'string' && name.length <= 200 && SAFE_NAME.test(name);

export function parsePath(path) {
  if (typeof path !== 'string') return null;
  if (path.startsWith(SITE_PREFIX) && path.endsWith('.json')) {
    const key = path.slice(SITE_PREFIX.length, -5);
    return isSafeName(key) ? { type: 'site', key } : null;
  }
  for (const [prefix, table] of Object.entries(COLLECTION_MAP)) {
    if (path.startsWith(prefix) && path.endsWith('.json')) {
      const slug = path.slice(prefix.length, -5);
      return isSafeName(slug) ? { type: 'collection', table, slug, prefix } : null;
    }
  }
  return null;
}

/**
 * Resolve a directory path to its D1 table and prefix.
 * Returns null if the directory is not recognized.
 */
export function resolveDirToTable(dir) {
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

/** Generate a deterministic SHA-1 hex string from content */
export async function generateSha(content) {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-1', encoder.encode(content));
  return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}
