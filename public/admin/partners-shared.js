/**
 * partners-shared.js — the rules for partner records, shared by the admin's
 * Partners tabs (index.html) and the unit tests (tests/partners-admin.test.mjs).
 *
 * What the site does with a partner mirrors src/pages/partners/index.astro
 * (sections by level, order then name, the directory's category tabs), the
 * home page's logo strip (src/pages/index.astro: Signature partners with a
 * logo), src/pages/community/index.astro (community partners with a logo)
 * and src/components/ui/MediaLogos.astro. The partners page Preview
 * (partner-preview.js) rebuilds the real page, and
 * scripts/test-page-preview.mjs checks it against the build.
 *
 * Fields the editor writes on a partner (src/content/config.ts):
 *   level     'signature' | 'champion' | 'builder' | 'friend'
 *   category  ['build' | 'design' | 'funding' | 'community', ...]; left out until
 *             someone chooses (the site lists them under Build meanwhile)
 *   featured  a soft highlight on a directory card (only the directory shows it)
 *   order     place in the Signature or Champion section; 0 in the directory,
 *             which is A to Z
 *   tagline   a line under the name (Signature cards and directory cards)
 * Older records keep `category` as a string, or none at all (the site reads
 * that as Build), and a `tier` the site no longer uses (kept as it is).
 *   logoFolders  upload folders linked by hand ("CR Construction" is this
 *             partner): admin-only, the site's schema drops it
 */

export const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
export const CF_ORIGIN = `https://imagedelivery.net/${CF_HASH}`;
export const CF_BASE = `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${CF_HASH}`;
const NAMED_VARIANTS = new Set(['public', 'nav', 'footer', 'og']);
const CF_PROXY_RE = /^https?:\/\/[^/]+\/cdn-cgi\/imagedelivery\/[^/]+\//;

// ── Levels: the sections of the Partners page, top to bottom ─────────
export const LEVELS = [
  { id: 'signature', label: 'Signature', sortable: true, short: 'Top of the Partners page, and the home page',
    who: 'The top few spotlight partners, year after year.',
    where: 'Feature cards at the top of the Partners page, with their tagline, and the logo strip on the home page.' },
  { id: 'champion', label: 'Champion', sortable: true, short: 'The Champions grid',
    who: 'Major sponsors: $10K or more, or major contributors.',
    where: 'The Champions grid on the Partners page.' },
  { id: 'builder', label: 'Builder', short: 'The directory, with a Builder badge',
    who: 'Regular in-kind partners.',
    where: 'The partner directory, A to Z, with a Builder badge.' },
  { id: 'friend', label: 'Friend', short: 'The directory',
    who: 'Everyone else who has helped.',
    where: 'The partner directory, A to Z.' },
];
export const levelOf = (id) => LEVELS.find((l) => l.id === id) || LEVELS[3];
export const inDirectory = (p) => p?.level !== 'signature' && p?.level !== 'champion';

// ── Categories: the directory's filter tabs ──────────────────────────
export const CATEGORIES = [
  { id: 'build', label: 'Build', hint: 'Contractors, trades and building materials' },
  { id: 'design', label: 'Design', hint: 'Designers, architects and furnishings' },
  { id: 'funding', label: 'Funding', hint: 'Sponsors, foundations and donors' },
  { id: 'community', label: 'Community', hint: 'Organizations, media, photographers and volunteers' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
export const categoryLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label || id;

/** The categories the site files them under (config.ts: a string, or none, reads as that one, or Build) */
export function categoriesOf(p) {
  const raw = Array.isArray(p?.category) ? p.category : [p?.category ?? 'build'];
  const ids = raw.filter((c) => CATEGORY_IDS.has(c));
  return ids.length ? [...new Set(ids)] : ['build'];
}
/** No category was ever chosen: the site lists them under Build by default */
export const categoryUnset = (p) => !(Array.isArray(p?.category) ? p.category.some((c) => CATEGORY_IDS.has(c)) : CATEGORY_IDS.has(p?.category));

// ── How each card shows a logo (CSS px), for the sharpness check ─────
export const LOGO_BOX = {
  signature: { w: 200, h: 60, where: 'Signature card' },
  champion: { w: 140, h: 40, where: 'Champions grid' },
  builder: { w: 90, h: 32, where: 'directory card' },
  friend: { w: 90, h: 32, where: 'directory card' },
  // The home strip's frame is 64px tall and at most 145px wide (measured in the browser)
  home: { w: 145, h: 64, where: 'home page logo strip' },
  media: { w: 200, h: 48, where: '“As Featured” strip' },
};

// ── Images ───────────────────────────────────────────────────────────
export function cfId(src) {
  if (!src) return '';
  if (!src.includes('imagedelivery.net') && !CF_PROXY_RE.test(src)) return src;
  let id = src.replace(`${CF_ORIGIN}/`, '').replace(CF_PROXY_RE, '');
  const last = id.lastIndexOf('/');
  if (last > 0) {
    const suffix = id.slice(last + 1);
    if (NAMED_VARIANTS.has(suffix) || suffix.includes('=')) id = id.slice(0, last);
  }
  return id;
}
/** A resized logo (fit inside the box, never cropped). Local previews pass through */
export function logoSrc(logo, w, h, q = 80) {
  if (!logo || /^(blob|data):/.test(logo)) return logo || '';
  const id = cfId(logo);
  if (!id || id === logo) return logo;
  return `${CF_BASE}/${id}/w=${w},h=${h},fit=contain,q=${q}`;
}
/** The partner a logo file was uploaded for: /partners/<folder>/… */
export const logoFolder = (url) => (String(url || '').match(/\/partners\/([a-z0-9-]+)\//) || [])[1] || '';

/**
 * How sharp a logo looks where this level shows it. size: [width, height] of
 * the original, or 'svg' (a vector is sharp at any size). A logo is drawn to fit its box, so the side that fills the
 * box decides: at least twice the box (Retina) is sharp, at least once is
 * soft, below that it's blurry.
 */
export function logoQuality(size, level = 'friend') {
  if (size === 'svg') return { verdict: 'sharp', vector: true, width: null, height: null, need: 0 };
  if (!Array.isArray(size) || !(size[0] > 0) || !(size[1] > 0)) return null;
  const [w, h] = size;
  const rank = { sharp: 0, soft: 1, blurry: 2 };
  let out = { verdict: 'sharp', width: w, height: h, need: 0 };
  for (const box of [LOGO_BOX[level] || LOGO_BOX.friend, ...(level === 'signature' ? [LOGO_BOX.home] : [])]) {
    const drawn = w * Math.min(box.w / w, box.h / h); // CSS px wide where it shows
    const verdict = w >= drawn * 2 ? 'sharp' : w >= drawn ? 'soft' : 'blurry';
    const need = Math.ceil(drawn * 2);
    if (rank[verdict] > rank[out.verdict] || (verdict === out.verdict && need > out.need)) out = { verdict, width: w, height: h, need };
  }
  return out;
}

// ── Empty margins ────────────────────────────────────────────────────
/**
 * The box around what a logo actually draws: every pixel that isn't
 * transparent or near-white. Only those count as margin, since the logo sits
 * on a white card: a colored background is part of the logo (Cloudflare's
 * trim=border would cut it off). rgba: 4 bytes a pixel, w × h. Returns
 * { x, y, w, h } in pixels, or null for a blank image.
 */
export function contentBox(rgba, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] < 16 || (rgba[i] > 244 && rgba[i + 1] > 244 && rgba[i + 2] > 244)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
/** What a crop keeps: the content and a little room (3% of its longer side, 2px at least), inside the image */
export function cropBox(box, w, h) {
  const pad = Math.max(2, Math.round(Math.max(box.w, box.h) * 0.03));
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return { x, y, w: Math.min(w, box.x + box.w + pad) - x, h: Math.min(h, box.y + box.h + pad) - y };
}
/**
 * How many times bigger a logo would draw on its card without its empty
 * margins. file: [w, h]; crop: the cropBox, in the same pixels.
 */
export function marginFactor(file, crop, level = 'friend') {
  if (!Array.isArray(file) || !(file[0] > 0) || !crop || !(crop.w > 0) || !(crop.h > 0)) return 1;
  const b = LOGO_BOX[level] || LOGO_BOX.friend;
  return Math.max(1, Math.min(b.w / crop.w, b.h / crop.h) / Math.min(b.w / file[0], b.h / file[1]));
}
export const MARGIN_WARN = 2;     // shows at half the size it could, or smaller
export const MARGIN_NOTE = 1.5;
/**
 * Cropping an SVG keeps it a vector: a new viewBox around the content. vb:
 * its viewBox [x, y, w, h]; W × H: the size it was drawn at to measure it
 * (preserveAspectRatio's default: fit, centered); crop: in those pixels.
 */
export function svgCropViewBox(vb, W, H, crop) {
  const [vx, vy, vw, vh] = vb;
  const s = Math.min(W / vw, H / vh);
  const ox = (W - vw * s) / 2;
  const oy = (H - vh * s) / 2;
  const r = (n) => Math.round(n * 1000) / 1000;
  return [r(vx + (crop.x - ox) / s), r(vy + (crop.y - oy) / s), r(crop.w / s), r(crop.h / s)];
}

// ── Web addresses ────────────────────────────────────────────────────
const SOCIAL = /(^|\.)(facebook|instagram|linkedin|x|twitter|tiktok|youtube|linktr)\.(com|ee)$/;
/**
 * A website as typed → { url, ok, note }. Bare domains get https://; a value
 * that isn't a web address at all (a name, a sentence) is not ok, since the
 * site would link the card to it.
 */
export function normalizeWebsite(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { url: '', ok: true, note: '' };
  let v = s;
  if (/^www\./i.test(v) || (!/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^\s/]+\.[a-z]{2,}(?:[/?#].*)?$/i.test(v))) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || /\s/.test(s)) throw new Error('not a site');
    if (u.protocol === 'http:') u.protocol = 'https:';
    const url = u.href.replace(/\/$/, u.pathname === '/' && !u.search && !u.hash ? '' : '/');
    return { url, ok: true, note: v !== s ? 'https:// added' : '' };
  } catch {
    return { url: s, ok: false, note: 'Not a web address' };
  }
}
export function domainOf(url) {
  try { return new URL(normalizeWebsite(url).url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
export const isSocial = (url) => SOCIAL.test(domainOf(url));

// ── Names ────────────────────────────────────────────────────────────
export const nameKey = (name) => String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(the|inc|llc|co|corp|company|group|and)\b/g, ' ').replace(/\s+/g, '');
export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// ── The record ───────────────────────────────────────────────────────
/** The site's view of a record, with schema defaults (config.ts) applied */
export const withDefaults = (p) => ({ level: 'friend', featured: false, order: 0, ...p, category: categoriesOf(p) });

/** A website the site can link: http(s) only (a javascript: or data: one is never kept) */
const unsafeLink = (v) => /^\s*[a-z][a-z0-9+.-]*:/i.test(String(v || '')) && !/^\s*https?:/i.test(String(v || ''));

/**
 * What Save writes. Keeps every field it doesn't own (older records carry a
 * `tier`, for instance). base: the record as saved; a field that's the same
 * as there is written exactly as it was, so a save changes only what someone
 * changed (a category nobody chose stays unchosen, an old website keeps its
 * spelling). The directory is A to Z, so a partner there gets order 0: a
 * Signature partner moved down would otherwise sort after everyone.
 */
export function partnerRecord(d, base = null) {
  const same = (k) => !!base && JSON.stringify(d[k] ?? null) === JSON.stringify(base[k] ?? null);
  const out = { ...d };
  out.level = LEVELS.some((l) => l.id === d.level) ? d.level : 'friend';
  if (!same('name')) out.name = String(d.name || '').trim();
  if (!same('website')) {
    const web = normalizeWebsite(d.website);
    if (web.url) out.website = web.ok ? web.url : String(d.website).trim(); else delete out.website;
  }
  if (unsafeLink(out.website)) delete out.website;
  if (!same('tagline')) {
    const tagline = String(d.tagline || '').trim().replace(/\s+/g, ' ');
    if (tagline) out.tagline = tagline; else delete out.tagline;
  }
  // None chosen stays none (the site files them under Build until someone chooses)
  if (!same('category')) { if (categoryUnset(d)) delete out.category; else out.category = categoriesOf(d); }
  if (!same('featured')) out.featured = !!d.featured;
  out.order = inDirectory(out) ? 0 : Math.max(0, Math.round(Number(d.order) || 0));
  if (base && !('order' in base) && out.order === 0) delete out.order;
  if (!out.logo && !same('logo')) out.logo = '';
  return out;
}

/**
 * Some fields changed on a saved record (many partners at once): Save's
 * rules for those fields only; everything else stays exactly as it was.
 * patch.category null (or none) means "none chosen".
 */
export function applyPartnerChange(before, patch) {
  const out = { ...before, ...patch };
  if ('level' in patch) out.level = LEVELS.some((l) => l.id === patch.level) ? patch.level : 'friend';
  if ('featured' in patch) out.featured = !!patch.featured;
  if ('tagline' in patch) { const t = String(patch.tagline || '').trim().replace(/\s+/g, ' '); if (t) out.tagline = t; else delete out.tagline; }
  if ('category' in patch) { if (categoryUnset(patch)) delete out.category; else out.category = categoriesOf(patch); }
  if ('order' in patch || 'level' in patch) out.order = inDirectory(out) ? 0 : Math.max(0, Math.round(Number(out.order) || 0));
  return out;
}

/** The home page's logo strip: Signature partners with a logo, in their order (src/pages/index.astro) */
export const homeStrip = (partners) => sections(partners).signature.filter((p) => p.logo);

/** Site order: order, then name (src/pages/partners/index.astro) */
export const compareSite = (a, b) => (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(String(b.name || ''));
export function sections(partners) {
  const sorted = [...(partners || [])].map(withDefaults).sort(compareSite);
  return Object.fromEntries(LEVELS.map((l) => [l.id, sorted.filter((p) => p.level === l.id)]));
}
/** The next free place at the end of a sortable section */
export const nextOrder = (partners, level) => (partners || []).filter((p) => p.level === level).reduce((m, p) => Math.max(m, (Number(p.order) || 0) + 1), 0);

// ── Where a partner shows ────────────────────────────────────────────
export function placesOf(p) {
  const d = withDefaults(p);
  const out = [];
  if (d.level === 'signature') out.push({ id: 'signature', label: 'Signature partners', page: '/partners/#signature' });
  if (d.level === 'champion') out.push({ id: 'champion', label: 'Champions grid', page: '/partners/#champions' });
  if (inDirectory(d)) out.push({ id: 'directory', label: `Directory: ${d.category.map(categoryLabel).join(', ')}`, page: '/partners/#all' });
  if (d.level === 'signature' && d.logo) out.push({ id: 'home', label: 'Home page logo strip', page: '/' });
  return out;
}

// ── Kid pages: which partners worked on which builds ─────────────────
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const VERSION_TAIL = /-(?:v?\d+|logo|new|black|white|color|colour|store|inc|llc)$/;
// Upload folders that don't name a partner ("new": a logo uploaded before the name was typed)
const GENERIC_FOLDERS = new Set(['new', 'uploaded', 'logo', 'logos', 'partner', 'partners']);
const folderKey = (s) => {
  let k = String(s || '');
  for (let i = 0; i < 3 && VERSION_TAIL.test(k); i++) k = k.replace(VERSION_TAIL, '');
  return k.replace(/-and-/g, '-').replace(/[^a-z0-9]/g, '').replace(/and/g, '');
};
/**
 * Every kid page's partner logos, matched to the directory: by the exact
 * image, else by the folder it was uploaded to (/partners/<folder>/), else
 * by a folder that's the same partner under an older name ("cambria" for
 * Cambria's "cambria-black", "tko-plumbing-2023"), or by a folder someone
 * linked to the partner (logoFolders: "CR Construction is Construction
 * Resources"). Returns
 *   byPartner  Map(partner slug → [{ slug, name, year, url, logoName }]), newest first
 *   unmatched  [{ key, folders, name, url, kids: [...] }]: logos on kid pages
 *              with no directory partner, most kids first
 */
export function kidUsage(kids, partners) {
  const byImage = new Map();
  const byKey = new Map();
  const linked = new Map();
  const add = (k, slug) => { if (!k || GENERIC_FOLDERS.has(k)) return; const s = byKey.get(k) || new Set(); s.add(slug); byKey.set(k, s); };
  for (const p of partners || []) {
    if (p.logo) byImage.set(cfId(p.logo), p.slug);
    add(folderKey(p.slug), p.slug);
    add(folderKey(logoFolder(p.logo)), p.slug);
    add(folderKey(slugify(p.name)), p.slug);
    // Linked by hand: these win over any guess
    for (const f of Array.isArray(p.logoFolders) ? p.logoFolders : []) linked.set(folderKey(f), p.slug);
  }
  const keys = [...byKey.keys()];
  const match = (url) => {
    const exact = byImage.get(cfId(url));
    if (exact) return exact;
    const folder = logoFolder(url);
    if (!folder) return null;
    const k = folderKey(folder);
    if (linked.has(k)) return linked.get(k);
    if (GENERIC_FOLDERS.has(k)) return null;
    const hit = byKey.get(k);
    if (hit) return hit.size === 1 ? [...hit][0] : null;
    if (k.length < 6) return null;
    const near = new Set();
    for (const kk of keys) if (kk.length >= 6 && (kk.startsWith(k) || k.startsWith(kk))) byKey.get(kk).forEach((s) => near.add(s));
    return near.size === 1 ? [...near][0] : null;
  };
  const byPartner = new Map();
  const loose = new Map();
  for (const kid of kids || []) {
    if (kid.publishStatus === 'draft') continue;
    const seen = new Set();
    for (const l of kid.partnerLogos || []) {
      if (!l?.url) continue;
      const row = { slug: kid.slug, name: kid.name, year: Number(kid.year) || null, url: l.url, logoName: String(l.name || '').trim() };
      const slug = match(l.url);
      if (slug) {
        if (seen.has(slug)) continue;
        seen.add(slug);
        const list = byPartner.get(slug) || [];
        list.push(row);
        byPartner.set(slug, list);
      } else {
        const folder = logoFolder(l.url);
        if (!folder) continue; // uploaded with the kid (a one-off image), not a partner logo
        const key = folderKey(folder);
        const g = loose.get(key) || { key, folder, folders: new Set(), names: [], urls: [], kids: [] };
        g.folders.add(folder);
        if (!g.kids.some((x) => x.slug === kid.slug)) g.kids.push(row);
        if (row.logoName) g.names.push(row.logoName);
        g.urls.push(l.url);
        loose.set(key, g);
      }
    }
  }
  const newest = (a, b) => (b.year || 0) - (a.year || 0) || String(a.name).localeCompare(String(b.name));
  for (const list of byPartner.values()) list.sort(newest);
  const titled = (folder) => folder.replace(VERSION_TAIL, '').split('-').filter(Boolean).map((w, i) => (
    // Initials stay capitals ("CR"); small words stay small after the first
    w.length <= 3 && !/[aeiouy]/.test(w) ? w.toUpperCase() : i && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
  const unmatched = [...loose.values()].map((g) => {
    g.kids.sort(newest);
    const count = (n) => g.names.filter((x) => x === n).length;
    const named = [...new Set(g.names)].sort((a, b) => count(b) - count(a))[0];
    // The logo on the newest build is the one to start from
    return { key: g.key, folder: g.folder, folders: [...g.folders].sort(), name: named || titled(g.folder), url: g.kids[0]?.url || g.urls[0], kids: g.kids };
  }).sort((a, b) => b.kids.length - a.kids.length || a.name.localeCompare(b.name));
  return { byPartner, unmatched };
}

/** The key that groups a folder with its older names (for links and dismissals) */
export const logoFolderKey = (folder) => folderKey(folder);
export const LOGO_FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

// ── Who a name probably means ────────────────────────────────────────
const NAME_STOP = new Set(['the', 'and', 'of', 'inc', 'llc', 'co', 'corp', 'company', 'group', 'ltd']);
const nameTokens = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ')
  .split(/[^a-z0-9]+/).filter((t) => t && !NAME_STOP.has(t));
function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// "CR Construction" and Construction Resources: a short first word that's the other's initials
const initialsOf = (a, b) => b.length >= 2 && a[0]?.length === b.length && a[0].length <= 4 && a[0] === b.map((t) => t[0]).join('');
/**
 * Directory partners a name probably means, best first: [{ partner, score, why }].
 * The same name typed differently, a typo, shared words, the same first two
 * words, initials, or one name inside the other. score 0..1; at least min.
 */
export function similarPartners(name, partners, { min = 0.5, max = 3, except = null } = {}) {
  const a = nameTokens(name);
  const ka = a.join('');
  if (!ka) return [];
  const out = [];
  for (const p of partners || []) {
    if (except && p.slug === except) continue;
    const b = nameTokens(p.name);
    const kb = b.join('');
    if (!kb) continue;
    let score = 0;
    let why = '';
    let signals = 0;
    const bump = (n, w) => { signals++; if (n > score) { score = n; why = w; } };
    if (ka === kb) bump(1, 'Same name');
    else {
      const ratio = 1 - editDistance(ka, kb) / Math.max(ka.length, kb.length);
      if (ratio >= 0.85) bump(ratio, 'Nearly the same name');
      const sa = new Set(a);
      const sb = new Set(b);
      const shared = [...sa].filter((t) => sb.has(t)).length;
      if (shared) bump(shared / new Set([...sa, ...sb]).size, 'Shares words');
      if (a.length >= 2 && b.length >= 2 && a[0] === b[0] && a[1] === b[1]) bump(0.6, 'Starts the same');
      if (initialsOf(a, b) || initialsOf(b, a)) bump(0.7, 'Initials');
      if (ka.length >= 6 && kb.length >= 6 && (ka.includes(kb) || kb.includes(ka))) bump(0.65, 'One name inside the other');
    }
    // Each further sign that agrees counts a little ("CR" and a shared word beat "CR" alone)
    if (signals > 1 && score < 1) score = Math.min(0.99, score + 0.05 * (signals - 1));
    if (score >= min) out.push({ partner: p, score: Math.round(score * 100) / 100, why });
  }
  return out.sort((x, y) => y.score - x.score || String(x.partner.name).localeCompare(String(y.partner.name))).slice(0, max);
}

// ── Possible duplicates ──────────────────────────────────────────────
/** Map(slug → [other slugs]) for partners with the same name or the same website (social pages aside) */
export function duplicatesOf(partners) {
  const groups = new Map();
  const put = (k, slug) => { if (!k) return; const g = groups.get(k) || []; g.push(slug); groups.set(k, g); };
  for (const p of partners || []) {
    put(`n:${nameKey(p.name)}`, p.slug);
    const d = p.website && normalizeWebsite(p.website).ok && !isSocial(p.website) ? domainOf(p.website) : '';
    if (d) put(`d:${d}`, p.slug);
  }
  const out = new Map();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const s of g) out.set(s, [...new Set([...(out.get(s) || []), ...g.filter((x) => x !== s)])]);
  }
  return out;
}

// ── What needs attention ─────────────────────────────────────────────
/**
 * Chips for a partner's row and checks for the editor. tone 'warn' is
 * something visitors see wrong now; 'info' is worth doing.
 * ctx: { size: [w, h] of what the logo draws (its content, without margins), or 'svg';
 *        margins: marginFactor; broken: the logo file is gone; blank: it draws nothing; dupes: [names] }
 */
export function issuesOf(p, ctx = {}) {
  const d = withDefaults(p);
  const out = [];
  if (!d.logo) out.push({ id: 'logo', tone: 'warn', label: 'No logo', tip: 'The site shows their name in a plain box instead.' });
  else if (ctx.broken) out.push({ id: 'logo', tone: 'warn', label: 'Logo missing', tip: 'The image file is gone, so the site shows their name in a plain box.' });
  else if (ctx.blank) out.push({ id: 'logo-blank', tone: 'warn', label: 'Blank logo', tip: 'The file draws nothing (it’s all transparent or white), so their card shows an empty box. Upload the logo again.' });
  else {
    if (ctx.margins >= MARGIN_WARN) out.push({ id: 'margins', tone: 'warn', label: 'Wide margins', tip: `Empty space around the logo makes it show ${ctx.margins.toFixed(1)}× smaller than it could on the ${(LOGO_BOX[d.level] || LOGO_BOX.friend).where}. Crop the margins in the editor.` });
    else if (ctx.margins >= MARGIN_NOTE) out.push({ id: 'margins', tone: 'info', label: 'Some margin', tip: `Cropping the empty space would show it ${ctx.margins.toFixed(1)}× bigger.` });
    const q = logoQuality(ctx.size, d.level);
    if (q?.verdict === 'blurry') out.push({ id: 'logo-small', tone: 'warn', label: 'Blurry logo', tip: `${q.width}px wide; the ${levelOf(d.level).label} card needs ${q.need}px or more to look sharp.` });
    else if (q?.verdict === 'soft') out.push({ id: 'logo-small', tone: 'info', label: 'Soft logo', tip: `${q.width}px wide; ${q.need}px or more looks sharp on Retina screens.` });
  }
  const web = normalizeWebsite(d.website);
  if (!web.ok) out.push({ id: 'website', tone: 'warn', label: 'Website isn’t a link', tip: `“${d.website}” isn’t a web address, so the card links nowhere useful.` });
  else if (!web.url) out.push({ id: 'website', tone: 'info', label: 'No website', tip: 'Their card isn’t a link.' });
  if (inDirectory(d) && categoryUnset(p)) out.push({ id: 'category', tone: 'info', label: 'No category', tip: 'The directory files them under Build until one is chosen.' });
  if (d.level === 'signature' && !String(d.tagline || '').trim()) out.push({ id: 'tagline', tone: 'info', label: 'No tagline', tip: 'Signature cards show a line under the name.' });
  if (ctx.dupes?.length) out.push({ id: 'duplicate', tone: 'warn', label: 'Possible duplicate', tip: `Same name or website as ${ctx.dupes.join(', ')}.` });
  return out;
}

/** Search: name, website, categories, level, tagline */
export function matches(p, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return true;
  const d = withDefaults(p);
  return [d.name, d.website, d.tagline, levelOf(d.level).label, ...d.category.map(categoryLabel)].some((v) => String(v || '').toLowerCase().includes(s));
}

// ── History: what changed between two saved versions ─────────────────
const FIELD_LABELS = { name: 'Name', website: 'Website', level: 'Level', category: 'Categories', featured: 'Highlight', tagline: 'Tagline', logo: 'Logo', order: 'Place' };
const show = (k, v) => {
  if (k === 'level') return levelOf(v).label;
  if (k === 'category') return (v || []).map(categoryLabel).join(', ');
  if (k === 'featured') return v ? 'On' : 'Off';
  if (k === 'logo') return v ? 'Changed' : 'Removed';
  return v == null || v === '' ? '(empty)' : String(v);
};
/** [{ field, label, detail }] for what differs on the site between a and b */
export function describeChanges(a, b) {
  if (!a || !b) return [];
  const x = partnerRecord(a);
  const y = partnerRecord(b);
  const out = [];
  for (const k of ['name', 'level', 'category', 'website', 'tagline', 'featured', 'logo']) {
    if (JSON.stringify(x[k] ?? '') === JSON.stringify(y[k] ?? '')) continue;
    out.push({ field: k, label: FIELD_LABELS[k], detail: k === 'logo' ? (y.logo ? (x.logo ? 'A new logo' : 'Logo added') : 'Logo removed') : `${show(k, x[k])} → ${show(k, y[k])}` });
  }
  return out;
}

/** Labels for the fields a save changed (the history's field list) */
export const changedLabels = (keys) => [...new Set((keys || []).map((k) => FIELD_LABELS[k]).filter(Boolean))];

// ── Export ───────────────────────────────────────────────────────────
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** A spreadsheet of every partner, in page order, with how many kid pages each is on */
export function partnersCsv(partners, usage) {
  const rows = [['Name', 'Level', 'Categories', 'Website', 'Tagline', 'Highlighted', 'Kid pages', 'Latest build', 'Logo']];
  const s = sections(partners);
  for (const l of LEVELS) {
    for (const p of s[l.id]) {
      const kids = usage?.get(p.slug) || [];
      rows.push([p.name, l.label, p.category.map(categoryLabel).join('; '), p.website || '', p.tagline || '', p.featured ? 'Yes' : '', kids.length || '', kids[0]?.year || '', p.logo ? 'Yes' : 'No']);
    }
  }
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ── Community partners (src/pages/community/index.astro) ─────────────
export const COMMUNITY_CATEGORIES = [
  { id: 'education', label: 'Education' },
  { id: 'health', label: 'Health & therapy' },
  { id: 'community', label: 'Community' },
  { id: 'faith', label: 'Faith-based' },
  { id: 'government', label: 'Government' },
];
/** The Community page lists only nonprofit partners with a logo */
export const communityListed = (p) => !!p?.logo;
export function communityIssues(p, ctx = {}) {
  const out = [];
  if (!p.logo) out.push({ id: 'logo', tone: 'warn', label: 'Not on the site', tip: 'The Community page shows nonprofit partners with a logo only.' });
  else if (ctx.blank) out.push({ id: 'logo-blank', tone: 'warn', label: 'Blank logo', tip: 'The file draws nothing, so the Community page shows an empty box.' });
  const web = normalizeWebsite(p.website);
  if (!web.ok) out.push({ id: 'website', tone: 'warn', label: 'Website isn’t a link', tip: `“${p.website}” isn’t a web address.` });
  else if (!web.url) out.push({ id: 'website', tone: 'info', label: 'No website', tip: 'Their logo isn’t a link.' });
  return out;
}
export function communityRecord(d) {
  const out = { ...d, name: String(d.name || '').trim(), description: String(d.description || '').trim(), order: Math.max(0, Math.round(Number(d.order) || 0)) };
  if (!COMMUNITY_CATEGORIES.some((c) => c.id === out.category)) out.category = 'community';
  const web = normalizeWebsite(d.website);
  if (web.url) out.website = web.ok ? web.url : String(d.website).trim(); else delete out.website;
  for (const k of ['impact', 'impactLabel', 'location']) { const v = String(d[k] || '').trim(); if (v) out[k] = v; else delete out[k]; }
  if (!out.logo) delete out.logo;
  out.featured = !!d.featured;
  return out;
}

const COMMUNITY_LABELS = { name: 'Name', website: 'Website', logo: 'Logo', category: 'Category', location: 'Location', description: 'About', impact: 'Impact number', impactLabel: 'Impact label' };
export function describeCommunityChanges(a, b) {
  if (!a || !b) return [];
  const x = communityRecord(a);
  const y = communityRecord(b);
  return Object.keys(COMMUNITY_LABELS).filter((k) => JSON.stringify(x[k] ?? '') !== JSON.stringify(y[k] ?? ''))
    .map((k) => ({ field: k, label: COMMUNITY_LABELS[k], detail: k === 'logo' ? (y.logo ? (x.logo ? 'A new logo' : 'Logo added') : 'Logo removed') : k === 'description' ? 'Rewritten' : `${x[k] || '(empty)'} → ${y[k] || '(empty)'}` }));
}
export const communityChangedLabels = (keys) => [...new Set((keys || []).map((k) => COMMUNITY_LABELS[k]).filter(Boolean))];

// ── Media logos (src/components/ui/MediaLogos.astro, src/pages/publicity.astro) ──
/** Press stories that use an outlet's logo (press.outletLogo is the media logo's slug) */
export const pressUsing = (press, slug) => (press || []).filter((p) => p.outletLogo === slug);
const MEDIA_LABELS = { name: 'Outlet', logo: 'Logo' };
export function describeMediaChanges(a, b) {
  if (!a || !b) return [];
  return Object.keys(MEDIA_LABELS).filter((k) => String(a[k] ?? '').trim() !== String(b[k] ?? '').trim())
    .map((k) => ({ field: k, label: MEDIA_LABELS[k], detail: k === 'logo' ? (b.logo ? (a.logo ? 'A new logo' : 'Logo added') : 'Logo removed') : `${a[k] || '(empty)'} → ${b[k] || '(empty)'}` }));
}
export const mediaChangedLabels = (keys) => [...new Set((keys || []).map((k) => MEDIA_LABELS[k]).filter(Boolean))];

