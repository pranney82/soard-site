/**
 * press-shared.js — the rules for press stories and the outlets that ran them
 * ===========================================================================
 * No DOM. Imported by the admin (./press.js), the server (functions/api/_press.js,
 * press-admin.js) and the tests (tests/press-admin.test.mjs), so all three
 * agree on what an outlet is, when two stories are the same story, and what a
 * story still needs.
 *
 *   Outlets are the media logos collection (src/content/medialogos): name,
 *   slug, logo (optional now), order, plus kind (the outlet's usual category),
 *   aliases (other spellings) and domains (its websites). `strip` says whether
 *   it's in the "As Featured" strip; records from before strip existed are in
 *   it when they have a logo (src/components/ui/MediaLogos.astro agrees).
 *   A press story points at its outlet by slug in `outletLogo` (the old name
 *   is kept so nothing else has to change) and shows the outlet's name.
 *
 * src/pages/publicity.astro and public/admin/press-preview.js mirror
 * linkFor() and outletCount(); change them together.
 */

export const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
export const CF_BASE = `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${CF_HASH}`;

export const CATEGORIES = ['national-tv', 'local-tv', 'print', 'magazine', 'entertainment'];
// The publicity page's own words for them
export const CATEGORY_LABELS = { 'national-tv': 'National TV', 'local-tv': 'Local TV', print: 'Print & Online', magazine: 'Magazine', entertainment: 'Entertainment' };
export const SUMMARY_MAX = 300;

// What the monitor searches for, until someone changes it in Press → Found
export const DEFAULT_QUERIES = ['"Sunshine on a Ranney Day"', 'SOARD charity Roswell', '"Peter Ranney"', '"Holly Ranney"', '"Sunny and Ranney"', 'sunshineonaranneyday'];
// TV stations whose YouTube uploads are watched for SOARD segments (the
// channel's 15 newest videos are read every few hours, filtered by name)
export const DEFAULT_CHANNELS = [
  { name: '11Alive', id: 'UCzF4Ryn8TKn64md77gS5Q5Q' },
  { name: 'WSB-TV', id: 'UCPsSnSR7ymSE8on3wafNbqg' },
  { name: 'FOX 5 Atlanta', id: 'UCjHWv2DU5-HLpogAAr386DQ' },
  { name: 'Atlanta News First', id: 'UCWElIIlFx2JiyI9UVrbrEcw' },
  { name: '13WMAZ', id: 'UCRNf0_t4Qo5eojj8sSvd_8A' },
  { name: 'TODAY', id: 'UChDKyKQ59fYz3JO2fl0Z6sg' },
];
// SOARD's own YouTube channel names: its own videos aren't press
export const OWN_CHANNELS = [/^sunshine on a ranney day/i, /^soard\b/i, /^sunny (and|&) ranney/i];
// Sites that carry other outlets' stories: never an outlet's own website
export const AGGREGATORS = /(^|\.)(news\.google\.com|google\.com|bing\.com|msn\.com|yahoo\.com|aol\.com|newsbreak\.com|flipboard\.com|apple\.news|archive\.org|web\.archive\.org|facebook\.com|instagram\.com|x\.com|twitter\.com|linkedin\.com|youtu\.be|ground\.news|smartnews\.com)$/i;
// Listings and directories that name SOARD but aren't stories about it, and SOARD's own sites
export const NOT_PRESS = /(propublica\.org\/nonprofits|guidestar\.org|candid\.org|charitynavigator\.org|causeiq\.com|opencorporates\.com|bizapedia\.com|greatnonprofits\.org|instrumentl\.com|zoominfo\.com|dnb\.com|yelp\.com|nextdoor\.com|indeed\.com|glassdoor\.com|mapquest\.com|zeffy\.com|givebutter\.com|eventbrite\.com|sunshineonaranneyday\.com|sunnyandranney\.com|soardcharity\.com)/i;
// Obituaries often name SOARD for memorial gifts (and other Peter Ranneys have them)
const OBITUARY = /(^|\.)(legacy\.com|tributearchive\.com|echovita\.com|dignitymemorial\.com|everloved\.com|forevermissed\.com)$|obituar|funeral|memorial-?(home|chapel)|crematory|mortuary/i;
/** Why a found article can't be a press story (from its address and headline), or null */
export function notPressReason(url, title = '') {
  const s = String(url || '');
  if (NOT_PRESS.test(s)) return /sunshineonaranneyday|sunnyandranney|soardcharity/i.test(s) ? 'SOARD’s own website' : 'A listing, not a story';
  if (OBITUARY.test(hostOf(s)) || /\bobituar(y|ies)\b|\bfuneral\b|\bin memoriam\b/i.test(String(title || '')) || /obituar/i.test((() => { try { return new URL(s).pathname; } catch { return ''; } })())) return 'An obituary';
  return null;
}

// ── Text ─────────────────────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
/** A character a numeric entity may stand for: none past U+10FFFF, no lone surrogate halves, no NUL */
const validCodePoint = (n) => Number.isInteger(n) && n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF);
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return validCodePoint(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
/**
 * Words only: entities decoded once, then tags out, spaces collapsed (the
 * page does the same). Decoding first means "&lt;script&gt;" ends up as
 * nothing, never as a real tag, however many times a title passes through;
 * a "<" left opening a tag (a letter, "/", "!" or "?" after it) goes too.
 */
export const plain = (s) => decodeEntities(String(s ?? ''))
  .replace(/<[^>]*>/g, ' ')
  .replace(/<(?=[a-z/!?])/gi, '')
  .replace(/\s+/g, ' ').trim();
export const hasMarkup = (s) => /<\/?[a-z][^>]*>|&(nbsp|amp|#\d+);/i.test(String(s ?? ''));

export function slugify(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}
export function dedupeSlug(base, taken) {
  const t = taken instanceof Set ? taken : new Set(taken || []);
  const b = base || 'story';
  if (!t.has(b)) return b;
  for (let i = 2; ; i++) if (!t.has(`${b}-${i}`)) return `${b}-${i}`;
}

/**
 * The founder is always "Peter", never "Pete" (the brand guide's rule), even when an
 * outlet's headline says Pete. Only next to "Ranney" or "Holly": a child can be a Pete.
 */
export const founderNames = (s) => String(s ?? '')
  .replace(/\bPete(?=(?:['’]s)?\s+Ranney\b)/g, 'Peter')
  .replace(/\b(Holly\s+(?:and|&)\s+)Pete\b/g, '$1Peter')
  .replace(/\bPete(?=\s+(?:and|&)\s+Holly\b)/g, 'Peter');

/** A headline without the " - Outlet" Google News and some sites put after it */
export function cleanTitle(title, source = '') {
  let t = founderNames(plain(title));
  const src = plain(source);
  if (src) {
    for (const sep of [' - ', ' | ', ' — ', ' – ', ': ']) {
      if (t.toLowerCase().endsWith(`${sep}${src}`.toLowerCase())) { t = t.slice(0, -(sep.length + src.length)).trim(); break; }
    }
  }
  return t;
}
/** For telling stories apart: the headline's words, lower case */
export const titleKey = (title) => plain(title).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 18).join(' ');

// ── Web addresses ────────────────────────────────────────────────────
/**
 * An address a page can link to: http(s), or none at all. Any other scheme
 * (javascript:, data:, vbscript:...) comes back as '', read the way a browser
 * reads it (tabs and newlines dropped, any case). functions/api/_collections.js
 * linkScheme() is the server's copy of this rule.
 */
export function webLink(url) {
  const s = String(url ?? '').trim();
  const scheme = s.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, '').match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  return !scheme || scheme === 'http' || scheme === 'https' ? s : '';
}
/** A full https:// (or http://) web address */
export function isWebAddress(url) {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try { return !!new URL(s).hostname; } catch { return false; }
}
export function hostOf(url) {
  try { return new URL(String(url).trim()).hostname.toLowerCase().replace(/^(www\d?|m|amp|mobile)\./, ''); } catch { return ''; }
}
/** A YouTube video id from a link, an embed, or the id itself */
export function youTubeId(input) {
  const s = String(input ?? '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([\w-]{11})/i);
  return m ? m[1] : null;
}
/** One key per article: host and path (query and trailing slash dropped; a YouTube video by its id) */
export function urlKey(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  const yt = /youtu\.?be/i.test(s) ? youTubeId(s) : null;
  if (yt) return `youtube.com/watch/${yt}`;
  try {
    const u = new URL(s);
    const path = decodeURIComponent(u.pathname).replace(/\/(amp|index\.html?)$/i, '').replace(/\/+$/, '').toLowerCase();
    return `${hostOf(s)}${path}`;
  } catch { return s.toLowerCase(); }
}
/** The address of an archived copy's original page (web.archive.org/web/<when>/<url>) */
export const archivedOriginal = (url) => String(url ?? '').match(/web\.archive\.org\/web\/\d+[a-z_]*\/(https?:\/\/.+)$/i)?.[1] || null;

// ── Outlets ──────────────────────────────────────────────────────────
/** One key per outlet name: "The Atlanta Journal-Constitution" = "Atlanta Journal-Constitution", "11Alive.com" = "11Alive (NBC Atlanta)" */
export function outletKey(name) {
  return plain(name).toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/\.(com|org|net|tv|news)\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}
const uniq = (list) => [...new Set((list || []).map((x) => String(x ?? '').trim()).filter(Boolean))];
/** An outlet record as saved: tidy lists, no empty extras */
export function outletRecord(o = {}) {
  const r = { name: plain(o.name), slug: String(o.slug || ''), logo: String(o.logo || ''), order: Number.isFinite(Number(o.order)) ? Number(o.order) : 0 };
  if (CATEGORIES.includes(o.kind)) r.kind = o.kind;
  const aliases = uniq(o.aliases).filter((a) => outletKey(a) && a !== r.name);
  if (aliases.length) r.aliases = aliases;
  const domains = uniq((o.domains || []).map((d) => hostOf(/^https?:/i.test(d) ? d : `https://${d}`))).filter((d) => d && !AGGREGATORS.test(d));
  if (domains.length) r.domains = domains;
  if (typeof o.strip === 'boolean') r.strip = o.strip;
  return r;
}
/** In the "As Featured" strip: records from before the switch are when they have a logo */
export const inStrip = (o) => !!(o && o.logo && o.strip !== false);
/** Every key an outlet answers to */
export const outletKeys = (o) => new Set([outletKey(o?.name), ...(o?.aliases || []).map(outletKey), String(o?.slug || '').replace(/-/g, '')].filter(Boolean));

/**
 * The outlet a story or a found article belongs to, by its website first,
 * then its name (or any other spelling the outlet has). Returns the record.
 */
/** Sites that carry everyone's videos and shows: never one outlet's website */
export const PLATFORMS = /(^|\.)(youtube\.com|vimeo\.com|soundcloud\.com|spotify\.com|podcasts\.apple\.com|tiktok\.com|anchor\.fm|buzzsprout\.com|libsyn\.com|podbean\.com)$/i;
export function matchOutlet(outlets, { name = '', url = '', source = '' } = {}) {
  const list = outlets || [];
  const k = outletKey(cleanOutletName(name));
  const byName = k ? list.find((o) => outletKeys(o).has(k)) || null : null;
  for (const h of [hostOf(url), hostOf(source)].filter((x) => x && !AGGREGATORS.test(x) && !PLATFORMS.test(x))) {
    const hits = list.filter((o) => (o.domains || []).some((d) => h === d || h.endsWith(`.${d}`)));
    // One website can carry several outlets (patch.com's town editions): the name decides
    if (hits.length === 1 && (!byName || byName === hits[0])) return hits[0];
    if (hits.length > 1) return (byName && hits.includes(byName) ? byName : null) || byName || hits[0];
  }
  return byName;
}
/**
 * Two outlet records that are one outlet for sure: they share a news website
 * and one's name begins the other's ("TODAY.com" and "Today Show" on today.com).
 * Patch's town editions share patch.com but neither name begins the other.
 */
export function sameOutletRecords(a, b) {
  const ka = outletKey(cleanOutletName(a?.name));
  const kb = outletKey(cleanOutletName(b?.name));
  if (!ka || !kb || Math.min(ka.length, kb.length) < 4 || !(ka.startsWith(kb) || kb.startsWith(ka))) return false;
  const da = (a.domains || []).filter((d) => !AGGREGATORS.test(d) && !PLATFORMS.test(d));
  return da.some((d) => (b.domains || []).includes(d));
}
/** A site's name without the slogan after it: "ABC News - Breaking News, Latest News and Videos" → "ABC News" */
export function cleanOutletName(name) {
  const n = plain(name);
  const m = n.match(/^(.{2,40}?)\s+[-|–—:]\s+(.{12,})$/);
  return m && m[1].split(/\s+/).length <= 4 && !/\//.test(m[1]) ? m[1].trim() : n;
}

/** An outlet's usual category, guessed from its name and website (Workers AI may say better) */
export function guessKind(name = '', host = '') {
  const s = `${plain(name)} ${host}`.toLowerCase();
  if (/\b(today ?show|today\.com|nightly news|good morning america|nbc news|abc news|cbs news|cbs mornings|cnn|fox news|nbcnews|abcnews|cbsnews)\b/.test(s) && !/atlanta|macon|savannah|augusta/.test(s)) return 'national-tv';
  if (/\b(\d+ ?alive|wsb|wxia|waga|wgcl|wmaz|wmgt|wtoc|wjbf|wrdw|wsav|fox ?\d+|nbc|abc|cbs|telemundo|univision|news ?first|tv)\b/.test(s)) return 'local-tv';
  if (/\b(magazine|monthly|living|lifestyle|home|style|neighbor|trend|voyage)\b/.test(s)) return 'magazine';
  if (/\b(podcast|radio|k-?love|iheart|country|the boot)\b/.test(s)) return 'entertainment';
  return 'print';
}

/** The name a story shows for its outlet */
export const outletNameFor = (story, outletBySlug) => outletBySlug?.get?.(story?.outletLogo)?.name || plain(story?.outlet) || '';
/** Outlets on the publicity page's count: by outlet record when it exists, else by name (src/utils/press.ts mirrors this) */
export function outletCount(stories, outletBySlug = new Map()) {
  return new Set((stories || []).map((p) => (p.outletLogo && outletBySlug.has(p.outletLogo) ? `o:${p.outletLogo}` : `n:${outletKey(p.outlet)}`))).size;
}

// ── Stories ──────────────────────────────────────────────────────────
export const isDraft = (s) => s?.publishStatus === 'draft';
/** Where the page sends a reader: the story, or its archived copy once the story is gone (publicity.astro mirrors this) */
export const linkFor = (s) => (s?.linkGone ? (s.archiveUrl || null) : (s?.url || null));
export const yearOf = (s) => Number(String(s?.date || '').slice(0, 4)) || null;

/** A story as saved: empty extras left off, lists de-duplicated, summary plain */
export function storyRecord(d = {}) {
  const r = {};
  r.outlet = plain(d.outlet);
  r.outletLogo = String(d.outletLogo || '');
  r.category = CATEGORIES.includes(d.category) ? d.category : 'print';
  r.title = founderNames(plain(d.title));
  r.date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? d.date : new Date().toISOString().slice(0, 10);
  // Only a web address: a javascript: or data: link never reaches the page
  r.url = webLink(d.url);
  r.excerpt = founderNames(plain(d.excerpt));
  r.image = d.image ? String(d.image) : null;
  r.featured = !!d.featured;
  r.order = Number.isFinite(Number(d.order)) ? Number(d.order) : 0;
  const vid = youTubeId(d.videoId);
  if (vid) r.videoId = vid;
  // Kept when a story stops being featured, so featuring it again brings them back
  if (plain(d.featuredHeadline)) r.featuredHeadline = founderNames(plain(d.featuredHeadline));
  if (plain(d.featuredDescription)) r.featuredDescription = founderNames(plain(d.featuredDescription));
  const kids = uniq(d.kids);
  if (kids.length) r.kids = kids;
  const partners = uniq(d.partners);
  if (partners.length) r.partners = partners;
  if (webLink(d.archiveUrl)) r.archiveUrl = webLink(d.archiveUrl);
  if (d.linkGone) r.linkGone = String(d.linkGone);
  if (d.publishStatus === 'draft') r.publishStatus = 'draft';
  // Fields this file doesn't know about stay as they were
  for (const [k, v] of Object.entries(d)) if (!(k in r) && !STORY_FIELDS.has(k) && k !== 'slug' && v !== undefined) r[k] = v;
  return r;
}
const STORY_FIELDS = new Set(['outlet', 'outletLogo', 'category', 'title', 'date', 'url', 'excerpt', 'image', 'featured', 'order', 'videoId', 'featuredHeadline', 'featuredDescription', 'kids', 'partners', 'archiveUrl', 'linkGone', 'publishStatus']);

/** A new story's file name: outlet and date, like the older ones (11alive-2025-03-01) */
export function storySlug(story, taken) {
  const base = slugify(`${story.outletLogo || story.outlet || 'press'} ${story.date || ''}`) || 'press';
  return dedupeSlug(base, taken);
}

/** Two saved stories that are the same story: the same article, or the same headline from the same outlet */
export function sameStory(a, b) {
  const ka = [urlKey(a.url), urlKey(archivedOriginal(a.archiveUrl))].filter(Boolean);
  const kb = [urlKey(b.url), urlKey(archivedOriginal(b.archiveUrl))].filter(Boolean);
  if (ka.some((k) => kb.includes(k))) return true;
  return sameHeadline(storyTitle(a), storyTitle(b)) && sameOutlet(a, b);
}
/**
 * One headline for one story: the same words, or one inside the other (an
 * outlet's video page "How SOARD transforms homes and lives" for its article
 * "A room built with dignity: How SOARD transforms homes and lives")
 */
const NAME_WORDS = new Set(['sunshine', 'on', 'a', 'ranney', 'day', 'soard', 'the', 'and', 'sunny', 'of', 'in', 'for', 'to']);
export function sameHeadline(x, y) {
  const a = titleKey(x);
  const b = titleKey(y);
  if (!a || !b) return false;
  if (a === b) return a.split(' ').length >= 4;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  // Inside another headline only with words of its own (not just "Sunshine on a Ranney Day")
  const words = short.split(' ');
  return words.length >= 6 && words.filter((w) => !NAME_WORDS.has(w)).length >= 3 && ` ${long} `.includes(` ${short} `);
}
/** A story's headline without its outlet's name stuck on the end (the old monitor saved them that way) */
export const storyTitle = (s) => [s?.outlet, ...(s?.outletAliases || [])].reduce((t, name) => cleanTitle(t, name), plain(s?.title));
/** A link through Google News instead of to the outlet */
export const googleLink = (url) => /^https?:\/\/news\.google\.com\//i.test(String(url || ''));
/** Two stories from one outlet: the same outlet record, or names that are the same outlet */
export function sameOutlet(a, b) {
  if (a.outletLogo && a.outletLogo === b.outletLogo) return true;
  const ka = outletKey(a.outlet);
  return !!ka && ka === outletKey(b.outlet);
}
/** Groups of saved stories that are copies of one another (each group 2+ slugs) */
export function duplicateGroups(stories) {
  const list = (stories || []).filter((s) => s?.slug);
  const parent = new Map(list.map((s) => [s.slug, s.slug]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    if (sameStory(list[i], list[j])) parent.set(find(list[i].slug), find(list[j].slug));
  }
  const groups = new Map();
  for (const s of list) { const r = find(s.slug); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s.slug); }
  return [...groups.values()].filter((g) => g.length > 1);
}
/** How much a copy carries, to keep the fullest one */
const richness = (s) => (s.featured ? 1000 : 0) + (s.videoId ? 200 : 0) + (s.image ? 100 : 0) + (s.featuredHeadline ? 20 : 0) + (s.featuredDescription ? 20 : 0)
  + ((s.kids || []).length + (s.partners || []).length) * 5 + Math.min(60, plain(s.excerpt).length / 5) - (hasMarkup(s.excerpt) ? 30 : 0) + (s.url ? 10 : 0);
export function pickKeeper(group) {
  return [...group].sort((a, b) => richness(b) - richness(a) || String(a.slug).length - String(b.slug).length || String(a.slug).localeCompare(String(b.slug)))[0];
}
/** The kept copy, with what only the others had filled in */
export function foldInto(keep, others) {
  const r = { ...keep };
  for (const o of others) {
    for (const k of ['image', 'videoId', 'featuredHeadline', 'featuredDescription', 'archiveUrl']) if (!r[k] && o[k]) r[k] = o[k];
    if (o.featured && !r.featured) { r.featured = true; r.order = o.order ?? r.order; }
    if ((!plain(r.excerpt) || hasMarkup(r.excerpt)) && plain(o.excerpt) && !hasMarkup(o.excerpt)) r.excerpt = o.excerpt;
    if (!r.url && o.url) r.url = o.url;
    for (const k of ['kids', 'partners']) if ((o[k] || []).length) r[k] = uniq([...(r[k] || []), ...o[k]]);
  }
  return r;
}

/** A summary that only repeats the headline and outlet (Google News sends those) */
export function junkSummary(s) {
  const e = plain(s.excerpt).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!e) return true;
  const t = plain(s.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return !!t && (e === t || e.startsWith(t) && e.length - t.length < 60);
}

/**
 * What a story still needs, most important first:
 *   [{ id, level: 'warn' | 'info', label, detail }]
 * ctx: { outletBySlug: Map, link: press_links row, dupes: [slug] }
 */
export function storyIssues(s, { outletBySlug = new Map(), link = null, dupes = [] } = {}) {
  const out = [];
  const outlet = outletBySlug.get(s.outletLogo);
  if (s.linkGone || link?.status === 'gone') {
    out.push(s.archiveUrl || link?.archive_url
      ? { id: 'link', level: 'info', label: 'Link broken, archived copy used', detail: 'The outlet took the story down. The site links to a saved copy instead.' }
      : { id: 'link', level: 'warn', label: 'Link broken', detail: 'The outlet took the story down and no saved copy exists, so the site shows it without a link.' });
  }
  if (!s.url) out.push({ id: 'nolink', level: 'warn', label: 'No link', detail: 'Readers have nothing to click.' });
  else if (googleLink(s.url)) out.push({ id: 'google', level: 'info', label: 'Links through Google News', detail: 'The monitor swaps it for the outlet’s own address.' });
  if (storyTitle(s) !== plain(s.title)) out.push({ id: 'title', level: 'info', label: 'Outlet name in the headline', detail: 'The headline ends with the outlet’s name. Saving takes it off.' });
  if (dupes.length) out.push({ id: 'dupe', level: 'warn', label: 'Possible duplicate', detail: 'Another story has the same article or headline from the same outlet.' });
  if (s.featured && !s.image && !s.videoId && !outlet?.logo) out.push({ id: 'visual', level: 'warn', label: 'Featured, no picture', detail: 'The featured card shows the outlet’s name in plain type. Add a picture or a video.' });
  if (!outlet) out.push({ id: 'outlet', level: 'info', label: 'Outlet not linked', detail: 'Pick the outlet so its logo and name stay consistent.' });
  if (!plain(s.excerpt)) out.push({ id: 'summary', level: 'warn', label: 'No summary', detail: 'The archive shows the headline alone.' });
  else if (junkSummary(s)) out.push({ id: 'summary', level: 'info', label: 'Summary repeats the headline', detail: 'Write a sentence or two about what the story says.' });
  else if (plain(s.excerpt).length > SUMMARY_MAX) out.push({ id: 'summary', level: 'info', label: 'Long summary', detail: `Over ${SUMMARY_MAX} characters.` });
  if (hasMarkup(s.excerpt)) out.push({ id: 'markup', level: 'info', label: 'Web code in the summary', detail: 'Saving tidies it into plain words.' });
  return out;
}

// ── Relevance, kids and partners ─────────────────────────────────────
const PHRASES = [/sunshine on a ranney day/i, /sunny\s*(and|&)\s*ranney/i, /sunshineonaranneyday/i];
/** How clearly an article is about SOARD, from its words alone */
export function relevance({ title = '', description = '', text = '' } = {}) {
  const t = plain(title);
  const all = `${t}\n${plain(description)}\n${String(text || '')}`;
  const inTitle = PHRASES.some((r) => r.test(t)) || /\bSOARD\b/.test(t);
  const count = (all.match(/sunshine on a ranney day/gi) || []).length + (all.match(/sunny\s*(and|&)\s*ranney/gi) || []).length;
  const soard = /\bSOARD\b/.test(all);
  const ranney = /\b(Peter|Holly)\s+Ranney\b/.test(all);
  const phrase = count > 0 || PHRASES.some((r) => r.test(all));
  return { inTitle, count, phrase, soard, ranney, strong: inTitle || count >= 2 || (phrase && (soard || ranney)), any: phrase || soard || ranney };
}

/** A kid's names as a story would print them: "Aidan & Brendan" → Aidan, Brendan; "Christian B" → Christian */
export function kidNames(kid) {
  const raw = plain(kid?.name);
  if (!raw) return [];
  const extra = [...raw.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  const parts = raw.replace(/\([^)]*\)/g, ' ').split(/\s*(?:,|&|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean)
    .map((p) => (/ family$/i.test(p) ? p : p.replace(/\s+(jr|sr|ii|iii)\.?$/i, '').replace(/\s+[A-Z]\.?$/, '')));
  return uniq([...parts, ...extra]).filter((n) => n.length >= 2);
}
// Kids' names that are also places, words or SOARD's founders: on their own they
// prove nothing ("Georgia", "Peter Ranney", "Christian"), so Workers AI must
// confirm them and the name must come up at least twice
const AMBIGUOUS_NAMES = new Set(['georgia', 'atlanta', 'roswell', 'marietta', 'savannah', 'augusta', 'macon', 'athens', 'austin', 'dallas', 'paris', 'jordan', 'carolina', 'virginia', 'peter', 'holly', 'ranney', 'sunny', 'hope', 'grace', 'faith', 'joy', 'charity', 'christian', 'angel', 'summer', 'autumn', 'winter', 'may', 'june', 'april', 'chase', 'hunter', 'will', 'mark', 'bill', 'rose', 'ivy', 'lily', 'brooke', 'river', 'sky', 'star', 'king', 'prince', 'major', 'noble', 'royal', 'miles', 'grant', 'page']);
export const ambiguousName = (n) => AMBIGUOUS_NAMES.has(String(n || '').toLowerCase().split(/\s+/)[0]);
const wordRe = (w, flags = '') => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?=$|[^\\p{L}\\p{N}])`, `u${flags}`);
/** A story can't be about a makeover that came after it (a year's slack for guessed dates) */
export const kidAfterStory = (story, kid) => { const y = yearOf(story); const ky = Number(kid?.year) || null; return !!(y && ky && ky > y + 1); };
/**
 * Kids an article might be about: one of their names in it (as a name, with
 * its capital), and their makeover within a couple of years of the story.
 * An older makeover counts as a follow-up ("Tripp Halstead, who inspired
 * millions…", years later) only when the name is in the headline or comes up
 * twice; follow-ups are linked only when Workers AI agrees. Never a makeover
 * after the story. Workers AI confirms these before a story is linked.
 */
export function kidCandidates(text, kids, year, { title = '' } = {}) {
  const body = String(text || '');
  if (!body) return [];
  const head = plain(title);
  const out = [];
  for (const k of kids || []) {
    if (!k?.slug || k.publishStatus === 'draft') continue;
    const ky = Number(k.year) || null;
    if (year && ky && ky > year + 1) continue;
    const hits = kidNames(k).filter((n) => wordRe(n).test(body));
    if (!hits.length) continue;
    const count = hits.reduce((n, h) => n + (body.match(new RegExp(wordRe(h).source, 'gu')) || []).length, 0);
    const ambiguous = hits.every(ambiguousName);
    const followUp = !!(year && ky && ky < year - 2);
    if (followUp && (ambiguous || !(hits.some((h) => wordRe(h).test(head)) || count >= 2))) continue;
    out.push({ slug: k.slug, name: k.name, year: ky, diagnosis: plain(k.diagnosis).slice(0, 80), matched: hits, count, ambiguous, ...(followUp ? { followUp: true } : {}) });
  }
  return out;
}
/** The photo a kid's page leads with (a Cloudflare Images id), for showing who a story is about */
export const kidPhoto = (kid) => cfId(kid?.heroImage || kid?.photos?.find?.((p) => p?.url)?.url || '');
// Partner names that are also everyday words or places
const GENERIC = new Set(['home', 'homes', 'design', 'designs', 'atlanta', 'georgia', 'roswell', 'sunshine', 'hope', 'grace', 'faith', 'joy', 'love', 'build', 'builders', 'construction', 'paint', 'flooring', 'interiors', 'lighting', 'electric', 'plumbing', 'kitchen', 'bath', 'studio', 'group', 'the', 'and', 'friends', 'family', 'church', 'community', 'foundation']);
/** Partners named in an article (their full name, as written); Workers AI confirms */
export function partnerCandidates(text, partners) {
  const body = String(text || '');
  if (!body) return [];
  const out = [];
  for (const p of partners || []) {
    const name = plain(p?.name);
    if (!name || !p.slug) continue;
    const words = name.toLowerCase().split(/\s+/);
    if (words.length === 1 && (GENERIC.has(words[0]) || name.length < 4)) continue;
    // Too short to mean anything ("A T"), or SOARD's own names (its store is listed as a partner)
    if (name.replace(/[^a-z0-9]/gi, '').length < 4 || PHRASES.some((r) => r.test(name)) || /^soard\b/i.test(name)) continue;
    // Short single words count only with their capital letters
    const re = words.length === 1 && name.length < 7 ? wordRe(name) : wordRe(name, 'i');
    if (re.test(body)) out.push({ slug: p.slug, name });
  }
  return out.slice(0, 15);
}

// ── Tidying what's there ─────────────────────────────────────────────
/**
 * Link every story to one outlet record: stories whose outlet names are the
 * same outlet ("FOX 5 Atlanta", "Fox 5 Atlanta") share one; an existing
 * record a story already points at, or whose name or other spellings match,
 * is used; otherwise one is made (no logo, not in the strip). Stories then
 * show their outlet's name.
 * Returns { create: [record], update: [record], stories: [{ slug, outletLogo, outlet }] }
 */
export function planOutletTidy(stories, outlets) {
  const bySlug = new Map((outlets || []).map((o) => [o.slug, o]));
  const taken = new Set((outlets || []).map((o) => o.slug));
  const hosts = (list) => uniq(list.map((s) => hostOf(s.url))).filter((h) => h && !AGGREGATORS.test(h) && !PLATFORMS.test(h));
  const spellings = (list) => uniq(list.map((s) => plain(s.outlet)));
  const groups = new Map(); // 'o:<slug>' (an outlet record) or 'n:<name key>' → stories
  const add = (k, s) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); };
  const rest = [];
  // 1. Stories that already point at an outlet record
  for (const s of stories || []) {
    if (!s?.slug || (!plain(s.outlet) && !bySlug.get(s.outletLogo))) continue;
    if (bySlug.get(s.outletLogo)) add(`o:${s.outletLogo}`, s); else rest.push(s);
  }
  // Those stories teach their outlets the websites and spellings they use
  const known = (outlets || []).map((o) => {
    const list = groups.get(`o:${o.slug}`) || [];
    return { ...o, aliases: [...(o.aliases || []), ...spellings(list)], domains: [...(o.domains || []), ...hosts(list)] };
  });
  // 2. The rest: an outlet by website or name, else grouped by name
  for (const s of rest) {
    const hit = matchOutlet(known, { name: s.outlet, url: s.url });
    add(hit ? `o:${hit.slug}` : `n:${outletKey(cleanOutletName(s.outlet)) || slugify(s.outlet) || 'unknown'}`, s);
  }
  const create = [];
  const updates = new Map();
  const storyChanges = [];
  for (const [k, list] of groups) {
    let outlet;
    const kind = mostCommon(list.map((s) => s.category));
    if (k.startsWith('o:')) {
      const base = bySlug.get(k.slice(2));
      const next = outletRecord({ ...base, aliases: [...(base.aliases || []), ...spellings(list)], domains: [...(base.domains || []), ...hosts(list)], kind: base.kind || kind || guessKind(base.name, hosts(list)[0]) });
      if (JSON.stringify(outletRecord(base)) !== JSON.stringify(next)) updates.set(next.slug, next);
      outlet = next;
    } else {
      const name = cleanOutletName(canonicalName(list.map((s) => plain(s.outlet)).filter(Boolean)));
      const slug = dedupeSlug(slugify(name) || 'outlet', taken);
      taken.add(slug);
      outlet = outletRecord({ name, slug, logo: '', order: 0, strip: false, kind: kind || guessKind(name, hosts(list)[0]), aliases: spellings(list), domains: hosts(list) });
      create.push(outlet);
    }
    for (const s of list) {
      if (s.outletLogo !== outlet.slug || plain(s.outlet) !== outlet.name) storyChanges.push({ slug: s.slug, outletLogo: outlet.slug, outlet: outlet.name });
    }
  }
  return { create, update: [...updates.values()], stories: storyChanges };
}
/** The value most often given; none on a tie (the caller guesses instead) */
function mostCommon(list) {
  const n = new Map();
  for (const x of list || []) if (x) n.set(x, (n.get(x) || 0) + 1);
  const [first, second] = [...n.entries()].sort((a, b) => b[1] - a[1]);
  return first && (!second || second[1] < first[1]) ? first[0] : null;
}
/** The spelling most stories used; on a tie the one that tells a reader more ("13WMAZ (CBS Macon)"), never a ".com" or "The …" form */
export function canonicalName(names) {
  const n = new Map();
  for (const x of names) n.set(x, (n.get(x) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]
    || (/\.(com|org|net)\b/i.test(a[0]) ? 1 : 0) - (/\.(com|org|net)\b/i.test(b[0]) ? 1 : 0)
    || (/^the\s/i.test(a[0]) ? 1 : 0) - (/^the\s/i.test(b[0]) ? 1 : 0)
    || (/\(/.test(b[0]) ? 1 : 0) - (/\(/.test(a[0]) ? 1 : 0)
    || a[0].length - b[0].length)[0]?.[0] || 'Outlet';
}

// ── History ──────────────────────────────────────────────────────────
export const FIELD_LABELS = {
  title: 'Headline', outlet: 'Outlet', outletLogo: 'Outlet', category: 'Category', date: 'Date', url: 'Link', excerpt: 'Summary',
  image: 'Picture', featured: 'Featured', videoId: 'Video', featuredHeadline: 'Featured headline', featuredDescription: 'Featured summary',
  kids: 'Kids', partners: 'Partners', archiveUrl: 'Archived copy', linkGone: 'Link status', publishStatus: 'On the site',
};
export function describeChanges(a, b) {
  if (!a || !b) return [];
  const x = storyRecord(a);
  const y = storyRecord(b);
  const out = [];
  for (const k of Object.keys(FIELD_LABELS)) {
    if (k === 'outletLogo' && x.outlet !== y.outlet) continue;
    const va = x[k] ?? null;
    const vb = y[k] ?? null;
    if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    let detail;
    if (k === 'image') detail = vb ? (va ? 'A new picture' : 'Picture added') : 'Picture removed';
    else if (k === 'featured') detail = vb ? 'Featured' : 'No longer featured';
    else if (k === 'publishStatus') detail = vb === 'draft' ? 'Hidden (draft)' : 'Shown on the site';
    else if (k === 'linkGone') detail = vb ? 'Marked broken' : 'Working again';
    else if (k === 'kids' || k === 'partners') detail = `${(vb || []).length} linked`;
    else if (k === 'excerpt' || k === 'featuredDescription') detail = 'Rewritten';
    else detail = `${va || '(empty)'} → ${vb || '(empty)'}`;
    out.push({ field: k, label: FIELD_LABELS[k], detail });
  }
  return out;
}
export const changedLabels = (keys) => [...new Set((keys || []).map((k) => FIELD_LABELS[k]).filter(Boolean))];

// ── Images ───────────────────────────────────────────────────────────
const CF_PROXY_RE = /^(https?:\/\/[^/]+)?\/cdn-cgi\/imagedelivery\/[^/]+\//;
const NAMED = new Set(['public', 'thumbnail', 'avatar', 'og']);
export function cfId(src) {
  const s = String(src || '');
  if (!s) return '';
  if (!s.includes('imagedelivery.net') && !CF_PROXY_RE.test(s)) return s;
  let id = s.replace(/^https?:\/\/imagedelivery\.net\/[^/]+\//, '').replace(CF_PROXY_RE, '');
  const last = id.lastIndexOf('/');
  if (last > 0) { const suffix = id.slice(last + 1); if (NAMED.has(suffix) || suffix.includes('=')) id = id.slice(0, last); }
  return id;
}
export const cfSrc = (src, t) => { const id = cfId(src); return id ? `${CF_BASE}/${id}/${t}` : ''; };
/**
 * A preview image a site uses for every page (its logo or a placeholder), not
 * this story's. Found in the Oct 2026 second look: an SVG is always a logo,
 * BLOX newspapers keep site-wide promos under /custom/image/, and magazines
 * name their default banner "…-Stock-3.png".
 */
export const genericImage = (url) => {
  const u = String(url || '');
  return /(logo|placeholder|default[-_]?(image|og|share)?|fallback|blank|spacer|favicon|apple-touch|social[-_]?share[-_]?default)/i.test(u)
    || /\.svg(\?|#|$)/i.test(u) || /\/custom\/image\//i.test(u) || /(^|[/_-])stock([-_]?\d+)?\.(png|jpe?g|webp|gif)(\?|$)/i.test(u);
};
