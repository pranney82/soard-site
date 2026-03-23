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
};

/** Indexed column extractors for INSERT OR REPLACE */
export const EXTRACTORS = {
  kids: (d) => [
    ['name', 'year', 'status', 'featured', 'child_count', 'room_count'],
    [d.name, d.year ?? null, d.status || 'completed', d.featured ? 1 : 0, d.childCount ?? 1, d.roomCount ?? 1],
  ],
  partners: (d) => [
    ['name', 'tier', 'featured'],
    [d.name, d.tier ?? null, d.featured ? 1 : 0],
  ],
  press: (d) => [
    ['title', 'date', 'category', 'featured'],
    [d.title ?? null, d.date ?? null, d.category ?? null, d.featured ? 1 : 0],
  ],
  team: (d) => [
    ['name', '"group"', 'order_num'],
    [d.name, d.group ?? null, d.order ?? 0],
  ],
  events: (d) => [
    ['title', 'date', 'status', 'featured'],
    [d.title, d.date ?? null, d.status || 'upcoming', d.featured ? 1 : 0],
  ],
  community: (d) => [
    ['name', 'order_num'],
    [d.name, d.order ?? 0],
  ],
  articles: (d) => [
    ['title', 'featured', 'order_num'],
    [d.title, d.featured ? 1 : 0, d.order ?? 0],
  ],
};

/**
 * Parse a content path into { type, table, slug } or { type: 'site', key }.
 * Returns null if path is not a recognized content path.
 */
export function parsePath(path) {
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
