/**
 * Admin → Site Config, the parts with no screen
 * ===========================================================================
 * Which public page each setting is on, how each photo is cropped there,
 * saving only what changed, and the checks. ./site-config.js draws it;
 * tests/site-config.test.mjs checks it. No DOM, no imports.
 *
 * Six documents (D1 site_config rows, read and saved through /api/read-content
 * and /api/save-content as src/content/site/<key>.json): settings, faq,
 * our-story, media, financial-snapshot, financials. `settings.application` is
 * Admin → Applications → Settings and never written from here.
 *
 * Saving is a three-way merge: the fields changed since the editor loaded
 * (base → edit) are laid onto a fresh read, so two people editing different
 * parts of the same document never undo each other. A field someone else
 * changed to something different is a conflict, and nothing is written.
 */

export const DOC_KEYS = ['settings', 'faq', 'our-story', 'media', 'financial-snapshot', 'financials'];
export const docPath = (key) => `src/content/site/${key}.json`;
export const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';

// ─── Paths ─────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** A copy of obj with path set (undefined removes it); parents are made as needed */
export function setPath(obj, path, value) {
  const keys = String(path).split('.');
  const root = isObj(obj) ? { ...obj } : {};
  let o = root;
  for (let i = 0; i < keys.length - 1; i++) {
    o[keys[i]] = isObj(o[keys[i]]) ? { ...o[keys[i]] } : {};
    o = o[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
  return root;
}

// Maps whose keys contain dots (photoTimestamps["sectionPhotos.process"]): compared whole
const FLAT_MAPS = new Set(['photoTimestamps']);

/** Leaf paths that differ: objects are walked, lists and values compared whole */
export function changedPaths(a, b, prefix = '') {
  if (isObj(a) && isObj(b) && !FLAT_MAPS.has(prefix)) {
    const out = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...changedPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
    return out;
  }
  return same(a, b) ? [] : [prefix];
}

/** Does `path` sit inside one of `fields` (or the other way round)? */
export const touches = (path, fields) => fields.some((f) => path === f || path.startsWith(`${f}.`) || f.startsWith(`${path}.`));

/**
 * Lay the edits (base → edit) onto a fresh read. Conflicts: fields someone
 * else changed since `base` to a value other than ours (photo dates aside,
 * which are ours to set).
 */
export function mergeForSave(base, edit, fresh) {
  const paths = changedPaths(base, edit);
  const conflicts = paths.filter((p) => !FLAT_MAPS.has(p) && !same(getPath(fresh, p), getPath(base, p)) && !same(getPath(fresh, p), getPath(edit, p)));
  let next = clone(fresh) || {};
  for (const p of paths) {
    if (FLAT_MAPS.has(p)) {
      // Only the entries we changed, over theirs
      const mine = Object.fromEntries(Object.entries(edit?.[p] || {}).filter(([k, v]) => !same(base?.[p]?.[k], v)));
      next = { ...next, [p]: { ...(isObj(fresh?.[p]) ? fresh[p] : {}), ...clone(mine) } };
    } else next = setPath(next, p, clone(getPath(edit, p)));
  }
  return { next, paths, conflicts };
}

/** A photo field's new value, with the date it was chosen (the admin's "chosen N days ago") */
export function withPhoto(doc, path, value, now = new Date().toISOString()) {
  const next = setPath(doc, path, value);
  return { ...next, photoTimestamps: { ...(isObj(doc?.photoTimestamps) ? doc.photoTimestamps : {}), [path]: now } };
}

// ─── Cloudflare image IDs ──────────────────────────────────────────

/** An image ID from an ID or any imagedelivery URL (variant or transforms dropped) */
export function cfIdOf(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  const m = s.match(/imagedelivery(?:\.net)?\/[^/]+\/(.+)$/);
  if (!m) return /^(https?:|\/|blob:|data:)/.test(s) ? '' : s.replace(/\/(public|w=[^/]*)$/, '');
  const parts = m[1].split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return (parts.length > 1 && (last === 'public' || /^[a-z]+=/.test(last)) ? parts.slice(0, -1) : parts).join('/');
}

/** "kids/dex/123-IMG.jpg" → "dex" (photos in a kid's folder) */
export const kidSlugOfImage = (id) => (String(id || '').match(/^kids\/([^/]+)\//) || [])[1] || '';

/** Every photo of a kid as image IDs, the main photo first, no repeats */
export function kidPhotos(kid) {
  if (!kid) return [];
  const out = [];
  const add = (src, alt = '') => { const id = cfIdOf(src); if (id && !out.some((p) => p.id === id)) out.push({ id, alt }); };
  add(kid.heroImage, kid.altTexts?.hero || '');
  for (const p of kid.photos || []) add(p?.url || p, p?.alt || '');
  for (const p of kid.beforeAfterPhotos || []) { add(p?.before?.url || p?.before); add(p?.after?.url || p?.after); }
  return out;
}

// ─── Kids ──────────────────────────────────────────────────────────

/** Kids the public site lists (drafts are left out there) */
export const publishedKids = (kids = []) => kids.filter((k) => k && k.slug && k.publishStatus !== 'draft');
export const kidLabel = (k) => (k ? `${k.name || k.slug}${k.year ? ` (${k.year})` : ''}` : '');
export const kidAge = (k) => (Array.isArray(k?.age) ? `ages ${k.age.join(', ')}` : k?.age ? `age ${k.age}` : '');

// ─── Checks ────────────────────────────────────────────────────────

/** A button or link target: a page here (/…), a section (#…), https, mail or phone */
export function linkProblem(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^\/(?!\/)\S*$/.test(s) || /^#[\w-]+$/.test(s) || /^mailto:\S+@\S+$/.test(s) || /^tel:\+?[\d-]{7,}$/.test(s)) return null;
  if (/^https:\/\/[^\s/]+\.[^\s]+$/i.test(s)) return null;
  if (/^http:\/\//i.test(s)) return 'Use https:// so browsers don’t warn visitors';
  return 'Start with / for a page on this site, # for a section, or https:// for another site';
}
export const urlProblem = (v) => (!String(v || '').trim() || /^https:\/\/[^\s/]+\.[^\s]+$/i.test(String(v).trim()) ? null : 'Use a full link that starts with https://');
export const emailProblem = (v) => (!String(v || '').trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) ? null : 'That doesn’t look like an email address');
export const phoneProblem = (v) => { const d = String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return !String(v || '').trim() || d.length === 10 ? null : 'Use a 10-digit phone number'; };
export const einProblem = (v) => (!String(v || '').trim() || /^\d{2}-\d{7}$/.test(String(v).trim()) ? null : 'Use the form 12-3456789');
export const zipProblem = (v) => (!String(v || '').trim() || /^\d{5}(-\d{4})?$/.test(String(v).trim()) ? null : 'Use a 5-digit ZIP code');
/** The homepage's second button draws its own arrow */
export const endsWithArrow = (s) => /\s*[↓⬇→︎️]+\s*$/.test(String(s || ''));
export const withoutArrow = (s) => String(s || '').replace(/\s*[↓⬇→︎️]+\s*$/, '');
export const plainText = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ─── Financial snapshot (the homepage "81%" and the Financials page) ─

/** Totals and rounded percentages, as the old editor stored them */
export function withPercents(s) {
  const prog = Number(s.programExpenses) || 0;
  const mgmt = Number(s.managementExpenses) || 0;
  const fund = Number(s.fundraisingExpenses) || 0;
  const total = prog + mgmt + fund;
  if (!total) return { ...s, totalExpenses: 0 };
  return { ...s, totalExpenses: total, programPct: Math.round((prog / total) * 100), managementPct: Math.round((mgmt / total) * 100), fundraisingPct: Math.round((fund / total) * 100) };
}
/** about/financials.astro fmtShort */
export const moneyShort = (n) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${Math.round((Number(n) || 0) / 1000)}K`);
export const SNAPSHOT_DEFAULTS = { year: new Date().getFullYear() - 1, totalRevenue: 0, totalExpenses: 0, programExpenses: 0, managementExpenses: 0, fundraisingExpenses: 0, programPct: 0, managementPct: 0, fundraisingPct: 0, contributions: 0, storeRevenue: 0, netAssets: 0, employees: 0, volunteers: 0 };

// ─── FAQs ──────────────────────────────────────────────────────────

/** /about/ shows these two categories by id: they can be renamed, never removed */
export const ABOUT_FAQ_CATEGORIES = { about: 'About SOARD', rooms: 'Room Makeovers' };
export const faqItems = (faq, categoryId) => (faq?.items || []).filter((i) => i.category === categoryId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
/** New order for one category's items (order = position, from 1) */
export function reorderFaq(faq, categoryId, ids) {
  const pos = new Map(ids.map((id, i) => [id, i + 1]));
  return { ...faq, items: (faq.items || []).map((i) => (i.category === categoryId && pos.has(i.id) ? { ...i, order: pos.get(i.id) } : i)) };
}

// ─── Trust badges (src/utils/trust-badges.ts) ──────────────────────

export const DEFAULT_TRUST_BADGES = [
  { name: 'Charity Navigator', detail: '4-Star Rating', url: 'https://www.charitynavigator.org/ein/454773997', image: '/charity-navigator-4-star-2026.png' },
  { name: 'Candid', detail: 'Platinum Transparency 2026', url: 'https://www.guidestar.org/profile/shared/2954b510-8c76-42e4-b589-7e826ca2cc47', image: '/candid-platinum-2026.svg' },
];

// ─── Photos: how each is cropped on its page ───────────────────────
// ratio is width / height; crop 'face' or 'auto' is Cloudflare's gravity, 'center'
// a plain centre crop, null when the page shows the photo whole.
export const PHOTO_SPECS = {
  heroKidPhotoId: { ratio: 4 / 5, crop: 'face', label: 'Hero photo', where: 'Big photo at the top of the homepage', also: 'Also the photo when a page has nothing else to share (link previews, Reveals and Live when idle)' },
  featuredStoryImage: { ratio: null, label: 'Story photo', where: 'Featured Story, cropped to fit with the top kept' },
  'upNext.photo': { ratio: 4 / 3, crop: 'face', label: 'Photo', where: 'Beside the Up Next headline' },
  'sectionPhotos.missionMain': { ratio: null, label: 'Main photo', where: 'Our Mission section, large', also: 'Also on Events when nothing is coming up, and on Resources if its own photo is blank' },
  'sectionPhotos.missionAccent': { ratio: null, label: 'Accent photo', where: 'Our Mission section, small, overlapping' },
  'sectionPhotos.roomBath': { ratio: 4 / 5, crop: 'center', label: '01 Accessible bathroom', fallback: 'kids/griffin/hero' },
  'sectionPhotos.roomBedroom': { ratio: 4 / 5, crop: 'center', label: '02 Dream bedroom', fallback: 'kids/zyah/hero' },
  'sectionPhotos.roomTherapy': { ratio: 4 / 5, crop: 'center', label: '03 Therapy room', fallback: 'kids/jackson/hero' },
  'sectionPhotos.process': { ratio: 10 / 7, crop: 'face', label: 'Reveal day', where: 'The Journey, step 5', fallback: 'kids/oakley/photo-15' },
  'applyPhotos.hero': { ratio: 4 / 5, crop: 'face', label: 'Hero photo', where: 'Top of the Apply page', also: 'Also the Apply page’s link preview', fallback: 'kids/griffin/hero' },
  'applyPhotos.story': { ratio: 5 / 6, crop: 'face', label: 'Small inset photo', where: 'Overlapping the hero photo, on computers only', also: 'Also the photo at the top of the application form', fallback: 'kids/eli/photo-01' },
  'applyPhotos.selection': { ratio: 4 / 3, crop: 'face', label: 'Step 2: home visit', fallback: 'kids/georgia/photo-01' },
  'applyPhotos.build': { ratio: 4 / 3, crop: 'face', label: 'Step 4: build', blankShows: 'the small inset photo' },
  'donatePhotos.hero': { ratio: 4 / 5, crop: null, position: 'center 30%', label: 'Hero photo', where: 'Top of the Donate page', also: 'Also the Donate page’s link preview', fallback: 'kids/oakley/hero' },
  'donatePhotos.story': { ratio: null, label: 'Story photo', where: 'The family story section', fallback: 'kids/amari/hero' },
  'waysToGivePhotos.hero': { ratio: 4 / 5, crop: 'face', label: 'Hero photo', also: 'Also the page’s link preview', fallback: 'kids/summer/hero' },
  'waysToGivePhotos.breakPhoto': { ratio: 3 / 2, crop: 'face', label: 'Full-width break photo', fallback: 'kids/summer/hero' },
  'waysToGivePhotos.legacyPhoto': { ratio: 6 / 5, crop: 'face', label: 'Legacy giving photo', fallback: 'kids/oakley/photo-15' },
  partnerPhoto: { ratio: 4 / 5, crop: 'auto', label: 'Hero photo', where: 'Top of the Partners page', also: 'Also the page’s link preview', fallback: 'kids/oakley/photo-15' },
  'communityPhotos.hero': { ratio: 4 / 5, crop: 'center', label: 'Hero photo', also: 'Also the page’s link preview', fallback: 'community/camp-twin-lakes/hero' },
  'communityPhotos.accent': { ratio: 5 / 6, crop: 'center', label: 'Small inset photo', where: 'On computers only' },
  'resourcesPhotos.hero': { ratio: 4 / 5, crop: 'face', label: 'Hero photo', where: 'Top of /resources/, and of every guide without its own photo', fallback: 'kids/summer/hero' },
  'resourcesPhotos.why': { ratio: 4 / 3, crop: 'center', label: '“Why we wrote these” photo', blankShows: 'the homepage mission photo' },
  'financialsPhotos.hero': { ratio: 4 / 5, crop: null, position: 'center 30%', label: 'Hero photo', where: 'Top of the Financials page', fallback: 'kids/amari/hero' },
  'advisoryBoardPhotos.hero': { ratio: 4 / 5, crop: 'face', label: 'Hero photo', where: 'Top of the Advisory Board page', fallback: 'kids/karter/1774384957640-Karter-Reveal-People-9.jpg' },
  'images.founder': { ratio: null, label: 'Founders photo', where: 'How It Began', also: 'Also the link preview for Our Story, Leadership, Financials and Advisory Board' },
  'images.tripp': { ratio: null, label: 'Turning point photo' },
  'images.gracie': { ratio: null, label: 'Gracie photo' },
  'images.store': { ratio: null, label: 'Store photo' },
};

/** The Cloudflare transforms the page uses, so the admin shows the same crop */
export function cropTransforms(spec, width = 480) {
  if (!spec?.ratio || !spec.crop) return `w=${width},q=75`;
  const h = Math.round(width / spec.ratio);
  return `w=${width},h=${h},fit=cover${spec.crop === 'center' ? '' : `,gravity=${spec.crop}`},q=75`;
}

// ─── Pages ─────────────────────────────────────────────────────────
// Every field lives on exactly one page here (the Featured Story kid also shows
// on the Apply page, which says so). `fields` are document paths; History and
// the unsaved dots use them.

export const PAGES = [
  { key: 'home', title: 'Homepage', url: '/', group: 'pages', docs: ['settings', 'financial-snapshot'],
    blurb: 'Hero, Up Next, featured story, kid strip, section photos',
    fields: { settings: ['homeHero', 'heroKidSlug', 'heroKidPhotoId', 'upNext', 'featuredKidSlug', 'featuredStoryImage', 'featuredStoryHeadline', 'featuredStoryDescription', 'kidShowcase', 'sectionPhotos.missionMain', 'sectionPhotos.missionAccent', 'sectionPhotos.roomBath', 'sectionPhotos.roomBedroom', 'sectionPhotos.roomTherapy'] } },
  { key: 'kids', title: 'Meet the Kids', url: '/kids/', group: 'pages', docs: ['settings'], blurb: 'The line under the page title', fields: { settings: ['kidsPageSummary'] } },
  { key: 'how', title: 'How It Works', url: '/how-it-works/', group: 'pages', docs: ['settings'], blurb: 'The project followed start to finish', fields: { settings: ['howItWorks'] } },
  { key: 'apply', title: 'Apply', url: '/apply/', group: 'pages', docs: ['settings'], blurb: 'Photos, family quote, questions',
    fields: { settings: ['applyPhotos', 'sectionPhotos.process', 'applyTestimonial', 'applyFaqs'] } },
  { key: 'donate', title: 'Donate', url: '/donate/', group: 'pages', docs: ['settings', 'faq'], blurb: 'Hero and family story', fields: { settings: ['donatePhotos'] } },
  { key: 'ways', title: 'Ways to Give', url: '/ways-to-give/', group: 'pages', docs: ['settings'], blurb: 'Three photos', fields: { settings: ['waysToGivePhotos'] } },
  { key: 'partners', title: 'Partners', url: '/partners/', group: 'pages', docs: ['settings'], blurb: 'Hero photo and partner quote', fields: { settings: ['partnerPhoto', 'partnerQuote', 'partnerQuoteName', 'partnerQuoteOrg'] } },
  { key: 'community', title: 'Community Projects', url: '/community/', group: 'pages', docs: ['settings'], blurb: 'Hero photos', fields: { settings: ['communityPhotos'] } },
  { key: 'resources', title: 'Resources', url: '/resources/', group: 'pages', docs: ['settings'], blurb: 'Guide photos', fields: { settings: ['resourcesPhotos'] } },
  { key: 'about', title: 'Our Story', url: '/about/', group: 'pages', docs: ['our-story'], blurb: 'Founders, Tripp, Gracie, the store, timeline', fields: { 'our-story': ['images', 'founders', 'turningPoint', 'mascot', 'store', 'milestones', 'today', 'finale'] } },
  { key: 'financials', title: 'Financials', url: '/about/financials/', group: 'pages', docs: ['settings', 'financial-snapshot', 'financials'], blurb: 'The numbers, 990s, audits, reports',
    fields: { settings: ['financialsPhotos'], 'financial-snapshot': [''], financials: [''] } },
  { key: 'faq', title: 'FAQ', url: '/faq/', group: 'pages', docs: ['faq'], blurb: 'Questions on FAQ, Donate and About', fields: { faq: [''] } },
  { key: 'advisory', title: 'Advisory Board', url: '/advisory-board/', group: 'pages', docs: ['settings'], blurb: 'Hero photo', fields: { settings: ['advisoryBoardPhotos'] } },
  { key: 'store', title: 'Sunny & Ranney', url: '/sunny-and-ranney/', group: 'pages', docs: ['settings'], blurb: 'Room cards', fields: { settings: ['sunnyAndRanneyRooms'] } },
  { key: 'media', title: 'Media Kit', url: '/branding/', group: 'pages', docs: ['media'], blurb: 'Press bio, mission, photos', fields: { media: [''] } },
  { key: 'org', title: 'Organization & contact', url: '/', group: 'site', docs: ['settings'], blurb: 'Name, EIN, phone, email, address', fields: { settings: ['name', 'shortName', 'tagline', 'ein', 'phone', 'email', 'address'] } },
  { key: 'social', title: 'Social links', url: '/', group: 'site', docs: ['settings'], blurb: 'Footer icons', fields: { settings: ['social'] } },
  { key: 'badges', title: 'Trust badges', url: '/about/financials/', group: 'site', docs: ['settings'], blurb: 'Rating seals in the footer', fields: { settings: ['trustBadges'] } },
  { key: 'newsletter', title: 'Newsletter', url: '/', group: 'site', docs: [], blurb: 'Where signups go', fields: {} },
];
export const pageByKey = (key) => PAGES.find((p) => p.key === key) || null;
/** Old Site Config tab names (command palette, links) → pages */
export const OLD_TABS = { 'kids-on-site': 'home', faq: 'faq', ourstory: 'about', mediakit: 'media', snapshot: 'financials', financials: 'financials', settings: 'org' };

/** Changed fields of one page: [{ doc, path }] */
export function pageChanges(page, docs) {
  const out = [];
  for (const [doc, fields] of Object.entries(page.fields || {})) {
    const d = docs[doc];
    if (!d?.base || !d?.edit) continue;
    for (const p of changedPaths(d.base, d.edit)) if (fields.includes('') || touches(p, fields)) out.push({ doc, path: p });
  }
  return out;
}

/** The page a changed field belongs to (photo dates follow their photo) */
export function pageOf(doc, path) {
  if (FLAT_MAPS.has(path)) return null;
  const p = path;
  return PAGES.find((pg) => (pg.fields?.[doc] || []).some((f) => f === '' || p === f || p.startsWith(`${f}.`) || f.startsWith(`${p}.`))) || null;
}
