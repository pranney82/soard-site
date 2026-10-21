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

/**
 * The site docs: site_config rows that are content (src/content/site/<key>.json).
 * The admin reads and saves these through read/list/save-content, the build
 * writes them into src/content, and save-content commits them to the public
 * GitHub repo. Every other site_config row is runtime state kept by a Function
 * (the live broadcast's config with its Stream and push keys, health, caches,
 * locks, Slack and Zeffy bookkeeping...): never served, saved or written by
 * the generic content API or the build. A new kind of site doc goes here.
 *   settings, faq, our-story, media, financial-snapshot, financials  Site Config
 *   golf, gala                                                       Events
 *   board-committees                                                 People
 *   partner-logo-dismissed                                           Partners
 *   email-template-<slug>                                            Email
 * scripts/d1-helpers.js uses the same list.
 */
export const SITE_DOC_KEYS = Object.freeze(['settings', 'faq', 'our-story', 'media', 'financial-snapshot', 'financials', 'golf', 'gala', 'board-committees', 'partner-logo-dismissed']);
export const SITE_DOC_PREFIXES = Object.freeze(['email-template-']);
export function isSiteDocKey(key) {
  if (!isSafeName(key)) return false;
  return SITE_DOC_KEYS.includes(key) || SITE_DOC_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length);
}

/**
 * Link schemes. A browser drops tabs and newlines anywhere in a URL and
 * control characters and spaces around it, and reads the scheme in any case,
 * so "  Java\tScript:…" is javascript:. The scheme as a browser would see it
 * (lower case), or '' for a path, an image ID or a bare host.
 */
export function linkScheme(value) {
  const s = String(value ?? '').replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, '');
  const m = s.match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : '';
}
/** Schemes that run code or smuggle a document when clicked or loaded */
export const SCRIPT_SCHEMES = Object.freeze(['javascript', 'data', 'vbscript']);
/** An http(s) address, a path on this site, or an ID: no other scheme */
export const isWebLink = (value) => ['', 'http', 'https'].includes(linkScheme(value));
/** A full http(s) address */
export const isHttpUrl = (value) => {
  const s = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; }
};
/** Field names that hold a link: url, href, link, website, permalink, linkedin and any *Url, *URL, *Link, *Href */
export const LINK_FIELD = /^(url|href|link|website|permalink|linkedin)$|(Url|URL|Link|Href)$/;
/**
 * Every link-named string field in a record (any depth) whose scheme runs
 * code (javascript:, data:, vbscript:), as [{ path, value }]. save-content
 * refuses a record with any; the build empties them in site docs
 * (scripts/d1-helpers.js) and the site docs' content schema refuses any left.
 */
export function scriptLinks(data, path = '', out = []) {
  if (Array.isArray(data)) data.forEach((v, i) => scriptLinks(v, `${path}[${i}]`, out));
  else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      const at = path ? `${path}.${k}` : k;
      if (typeof v === 'string') { if (LINK_FIELD.test(k) && SCRIPT_SCHEMES.includes(linkScheme(v))) out.push({ path: at, value: v.slice(0, 80) }); }
      else scriptLinks(v, at, out);
    }
  }
  return out;
}
/** A copy of a record with those links emptied, and where they were ({ data, dropped: [path] }) */
export function withoutScriptLinks(data) {
  const dropped = [];
  const clean = (v, path) => {
    if (Array.isArray(v)) return v.map((x, i) => clean(x, `${path}[${i}]`));
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      const at = path ? `${path}.${k}` : k;
      if (typeof x === 'string' && LINK_FIELD.test(k) && SCRIPT_SCHEMES.includes(linkScheme(x))) { dropped.push(at); return [k, '']; }
      return [k, clean(x, at)];
    }));
  };
  return { data: clean(data, ''), dropped };
}

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
    // Only site docs: runtime rows (broadcast-config holds Stream and push keys) aren't content
    return isSiteDocKey(key) ? { type: 'site', key } : null;
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
