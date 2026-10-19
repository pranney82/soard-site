/**
 * kids-shared.js — the rules for kid profiles, shared by the admin's Kids list
 * and editor (index.html), the kid page Preview (kid-preview.js) and the unit
 * tests (tests/kids-admin.test.mjs).
 *
 * The page derivations below mirror the frontmatter of
 * src/pages/kids/[slug].astro and src/pages/kids/index.astro. Preview builds
 * every kid's page with them, and scripts/test-page-preview.mjs compares that
 * with the real page, so a change on one side that misses the other fails
 * the test. Change both together.
 *
 * Fields the editor writes on a kid record (src/content/config.ts):
 *   status        'needs-funding' | 'in-progress' | 'completed'
 *   roomTypes     what was built, e.g. ['Dream Bedroom', 'Wheelchair Ramp']
 *   roomCount     what the profile adds to the site's "rooms built" total:
 *                 every bedroom, bathroom and therapy room, plus a ramp or
 *                 lift when one was built
 *   bedroomCount, bathroomCount, therapyRoomCount   how many of each room
 *   sortOrder     place among the active kids at the top of Meet the Kids
 *   publishStatus 'draft' keeps the profile off the site
 */

// ── Statuses: the order Meet the Kids shows them in ──────────────────
export const STATUSES = [
  { id: 'needs-funding', label: 'Awaiting funding', short: 'Awaiting funding',
    hint: 'First on Meet the Kids. Their page asks visitors to help fund the room.' },
  { id: 'in-progress', label: 'In build', short: 'In build',
    hint: 'Next on Meet the Kids, after families awaiting funding. The first one is the home page’s Now Building feature.' },
  { id: 'completed', label: 'Completed', short: 'Completed',
    hint: 'In the main grid, newest year first.' },
];
export const statusOf = (id) => STATUSES.find((s) => s.id === id) || STATUSES[2];
export const isActive = (k) => k?.status === 'needs-funding' || k?.status === 'in-progress';
export const isListed = (k) => k?.publishStatus !== 'draft';

// ── What was built ───────────────────────────────────────────────────
// Everything here counts toward "rooms built" on the site (Peter, Oct 2026:
// ramps and lifts count too). Rooms can number more than one, each with its
// own count field; a ramp or a lift was built or it wasn't.
export const BUILDS = [
  { id: 'Dream Bedroom', label: 'Dream bedroom', key: 'bedroomCount' },
  { id: 'Accessible Bathroom', label: 'Accessible bathroom', key: 'bathroomCount' },
  { id: 'Therapy Room', label: 'Therapy room', key: 'therapyRoomCount' },
  { id: 'Wheelchair Ramp', label: 'Wheelchair ramp' },
  { id: 'Chair Lift', label: 'Chair lift' },
];
const BUILD_IDS = BUILDS.map((b) => b.id);

/**
 * How many of each thing a record says was built: { 'Dream Bedroom': 1, … }.
 * roomTypes decides which; a room's own count (bedroomCount, …) says how
 * many, else one. Types the editor doesn't know are kept as they are.
 */
export function buildsOf(kid) {
  const types = Array.isArray(kid?.roomTypes) ? kid.roomTypes : [];
  const counts = {};
  for (const b of BUILDS) {
    if (!types.includes(b.id)) { counts[b.id] = 0; continue; }
    const n = b.key ? Number(kid[b.key]) : 0;
    counts[b.id] = b.key && Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 20) : 1;
  }
  return counts;
}
export const roomTotal = (counts) => BUILDS.reduce((sum, b) => sum + (counts[b.id] || 0), 0);

/** The record fields for a set of counts (other types on the record are kept) */
export function buildFields(counts, kid = {}) {
  const extra = (Array.isArray(kid.roomTypes) ? kid.roomTypes : []).filter((t) => !BUILD_IDS.includes(t));
  const roomTypes = [...BUILDS.filter((b) => (counts[b.id] || 0) > 0).map((b) => b.id), ...extra];
  const out = { roomTypes, roomCount: Math.max(1, roomTotal(counts)) };
  for (const b of BUILDS) if (b.key) out[b.key] = counts[b.id] || 0;
  return out;
}
/** "2 dream bedrooms, an accessible bathroom and a wheelchair ramp" */
export function buildSummary(counts) {
  const items = BUILDS.filter((b) => counts[b.id] > 0).map((b) => {
    const name = b.label.toLowerCase();
    return counts[b.id] > 1 ? `${counts[b.id]} ${name}s` : `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
  });
  if (!items.length) return 'Nothing yet';
  const text = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Ages ─────────────────────────────────────────────────────────────
/** "10" → 10, "7, 9" → [7, 9], "" → null; { value, bad } */
export function parseAges(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { value: null, bad: false };
  const parts = raw.split(/[,&]|\band\b/).map((s) => s.trim()).filter(Boolean);
  const nums = parts.map((s) => Number(s));
  const bad = nums.some((n) => !Number.isInteger(n) || n < 0 || n > 40);
  const good = nums.filter((n) => Number.isInteger(n) && n >= 0 && n <= 40);
  return { value: good.length > 1 ? good : good[0] ?? null, bad };
}
export const formatAges = (age) => (Array.isArray(age) ? age.join(', ') : age == null || age === '' ? '' : String(age));

// ── Story (mirrors src/pages/kids/[slug].astro) ──────────────────────
export function splitBio(bio) {
  if (!bio) return [];
  if (bio.includes('<p>')) {
    return [...bio.matchAll(/<p>([\s\S]*?)<\/p>/gi)]
      .map((m) => m[1].replace(/<br\s*\/?>/gi, '').trim())
      .filter(Boolean);
  }
  return bio.split('\n\n').filter((p) => p.trim());
}

export const HERO_SUMMARY_MAX = 220;
export function heroHookOf(raw) {
  if (!raw) return '';
  const sentences = raw.match(/[^.!?]+[.!?]+/g) || [raw];
  const twoSentences = sentences.slice(0, 2).map((s) => s.trim()).join(' ');
  if (twoSentences.length <= 220) return twoSentences;
  const firstSentence = sentences[0]?.trim() || raw;
  if (firstSentence.length <= 180) return firstSentence;
  const truncated = firstSentence.slice(0, 170);
  const clauseBreak = truncated.match(/^.{80,}[,;:—–]\s/)?.[0];
  if (clauseBreak) return clauseBreak.trim() + '...';
  return truncated.replace(/\s+\S*$/, '') + '...';
}
const plain = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The hero's intro line: { text, from: 'summary' | 'story' | null, cut } */
export function heroIntro(kid) {
  const intro = splitBio(kid?.bio || '')[0] || '';
  const raw = kid?.heroSummary || plain(intro);
  // (the page collapses spaces, so "leg.  Featured" reads like "leg. Featured")
  const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
  const text = squash(heroHookOf(raw));
  return { text, from: kid?.heroSummary ? 'summary' : raw ? 'story' : null, cut: !!raw && text !== squash(raw) };
}

/** Whether the pull quote shows, and why not: { shown, reason } */
export function quoteState(kid) {
  const q = kid?.quote;
  if (!q) return { shown: false, reason: null };
  if (q === kid.bio) return { shown: false, reason: 'same-as-story' };
  if (q === (splitBio(kid.bio || '')[0] || '')) return { shown: false, reason: 'same-as-intro' };
  return { shown: true, reason: null };
}

// ── Photos (mirrors the gallery split on the kid page) ───────────────
export const GALLERY_MAX = 30;
export const GALLERY_LARGE = 2;
export const GALLERY_FIRST = 8;
/** Where photo i (0-based) lands on the page */
export function photoZone(i) {
  if (i < GALLERY_LARGE) return 'large';
  if (i < GALLERY_FIRST) return 'gallery';
  if (i < GALLERY_MAX) return 'more';
  return 'off';
}
export const ZONES = {
  large: { label: 'Large, first in the gallery', short: 'Large' },
  gallery: { label: 'In the gallery', short: 'Gallery' },
  more: { label: 'Behind “Show all photos”', short: 'Show all' },
  off: { label: `Not on the page (it shows the first ${GALLERY_MAX})`, short: 'Not shown' },
};
export const needsAlt = (p) => !!(p && p.url && !String(p.alt || '').trim() && !p._tempId && !/^(blob|data):/.test(p.url));

// ── Plans ────────────────────────────────────────────────────────────
// Floor plans carry the designer's title block (with the family's street
// address) along the bottom edge; the page crops it off for these labels
export const TITLE_BLOCK = 0.10;
export const isFloorPlan = (p) => /(before|after|existing|existi|proposed|layout|floor\s*plan)/i.test(p?.label || '');
export const PLANS_SHOWN = 2;
/** A caption that is really a file name ("CompanyCam 2445", "IMG_0042") */
export const looksLikeFileName = (s) => /^\s*(?:companycam|img|dsc|pxl|screenshot|scan|photo|image|untitled)[\s_-]*\d/i.test(String(s || '')) || /^\s*[\d_-]+\s*$/.test(String(s || '')) || /\.(?:jpe?g|png|pdf|heic|webp)\s*$/i.test(String(s || ''));

// ── Video (mirrors src/utils/reveals.ts) ─────────────────────────────
export function youTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
export const STREAM_UID_RE = /^[a-f0-9]{32}$/i;
/** The Stream uid in a watch link or bare uid */
export function streamUid(s) {
  const m = String(s || '').trim().match(/([a-f0-9]{32})/i);
  return m ? m[1].toLowerCase() : null;
}

// ── Search and sharing (mirrors the page's <title> and description) ─
export const SITE_ORIGIN = 'https://sunshineonaranneyday.com';
export const META_MAX = 160;
export function pageTitleOf(kid) {
  const rooms = kid?.roomTypes?.length ? ` — ${kid.roomTypes.join(' & ')}` : '';
  return `${kid?.name || 'Name'}'s Story${rooms} | Sunshine on a Ranney Day`;
}
export function metaDescriptionOf(kid) {
  return kid?.metaDescription
    || kid?.shortDescription
    || `Meet ${kid?.name || ''}${kid?.diagnosis ? `, diagnosed with ${kid.diagnosis}` : ''}. Learn how Sunshine on a Ranney Day transformed their space${kid?.roomTypes?.length ? ` with ${/^[aeiou]/i.test(kid.roomTypes[0]) ? 'an' : 'a'} ${kid.roomTypes.join(' & ')}` : ''}.`;
}
/** Thin pages are kept out of search results (no story, ≤1 photo, no video) */
export const isThinPage = (kid, hasVideo) => !kid?.bio && (kid?.photos || []).length <= 1 && !hasVideo;

// ── Order (mirrors src/pages/kids/index.astro and the home page) ─────
const NO_ORDER = Number.MAX_SAFE_INTEGER;
const statusRank = (s) => (s === 'needs-funding' ? 0 : s === 'in-progress' ? 1 : 2);
/** Meet the Kids order: awaiting funding, in build (by sortOrder), then by year */
export function gridOrder(kids) {
  return [...kids].filter(isListed).sort((a, b) => {
    const sA = statusRank(a.status);
    const sB = statusRank(b.status);
    if (sA !== sB) return sA - sB;
    if (sA < 2) {
      const oA = typeof a.sortOrder === 'number' ? a.sortOrder : NO_ORDER;
      const oB = typeof b.sortOrder === 'number' ? b.sortOrder : NO_ORDER;
      if (oA !== oB) return oA - oB;
    }
    return (b.year || 0) - (a.year || 0);
  });
}
/** The home page's Now Building kid (when it isn't picked by hand in Site Settings) */
export function nowBuilding(kids) {
  return [...kids].filter((k) => isListed(k) && k.status === 'in-progress')
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || String(a.name || '').localeCompare(String(b.name || '')))[0] || null;
}

// ── What a profile is missing ────────────────────────────────────────
/**
 * Things to fix, most important first. tone 'warn' changes what visitors
 * see (Needs attention); 'quiet' is worth doing when there's time.
 * section: the editor section that fixes it.
 */
export function kidIssues(kid) {
  const out = [];
  if (!kid) return out;
  const photos = kid.photos || [];
  const add = (id, tone, label, section, tip) => out.push({ id, tone, label, section, tip });
  if (!kid.heroImage) add('no-hero', 'warn', 'No main photo', 'photos', 'The grid card and the top of the page have no photo');
  if (!plain(kid.bio)) add('no-story', 'warn', 'No story', 'story', 'The page has no story section');
  if (kid.status === 'needs-funding' && !kid.fundraisingUrl) add('no-fund-link', 'warn', 'No fundraising link', 'giving', 'Visitors have no way to give toward this room');
  if (kid.status === 'completed' && photos.length < 3) add('few-photos', 'warn', photos.length ? `Only ${photos.length} photo${photos.length === 1 ? '' : 's'}` : 'No photos', 'photos', 'Completed rooms read best with a full gallery');
  const intro = heroIntro(kid);
  if (kid.heroSummary && intro.cut) add('hook-cut', 'warn', 'Hero summary is cut short', 'story', `The page shows: “${intro.text}”`);
  const unnamed = (kid.partnerLogos || []).filter((p) => !String(p.name || '').trim()).length;
  if (unnamed) add('partner-names', 'quiet', `${unnamed} partner logo${unnamed === 1 ? '' : 's'} unnamed`, 'partners', 'Screen readers hear “Project partner” for these');
  const noAlt = photos.slice(0, GALLERY_MAX).filter(needsAlt).length;
  if (noAlt) add('alt', 'quiet', `${noAlt} photo${noAlt === 1 ? '' : 's'} need${noAlt === 1 ? 's' : ''} alt text`, 'photos', 'Screen readers and image search rely on it');
  if (kid.status === 'in-progress' && !kid.fundraisingUrl) add('no-fund-link', 'quiet', 'No fundraising link', 'giving', 'Their page could ask visitors to help fund the room');
  if (kid.status === 'completed' && !kid.streamVideoId && !kid.videoUrl) add('no-video', 'quiet', 'No reveal video', 'video', 'The page has no Reveal chapter');
  const q = quoteState(kid);
  if (!q.shown && q.reason) add('quote-hidden', 'quiet', 'Quote isn’t shown', 'story', 'It repeats the story, so the page leaves it out');
  if ((kid.plans || []).some((p) => looksLikeFileName(p.label))) add('plan-captions', 'quiet', 'Plans need real captions', 'plans', 'Captions like “CompanyCam 2445” or “4” show when someone opens a plan');
  if (photos.length > GALLERY_MAX) add('over-max', 'quiet', `${photos.length - GALLERY_MAX} photo${photos.length - GALLERY_MAX === 1 ? '' : 's'} past ${GALLERY_MAX} not shown`, 'photos', `The gallery shows the first ${GALLERY_MAX}`);
  return out;
}

// ── Saving ───────────────────────────────────────────────────────────
const clean = (arr) => (arr || []).map(({ _tempId, _key, ...p }) => p);
/** A kid exactly as Save writes it (Preview shows the same record) */
export function kidRecord(data) {
  // (scheduledPublish: an old editor's schedule that nothing ever read)
  const { _ages, scheduledPublish, ...d } = data;
  const ages = _ages !== undefined ? parseAges(_ages).value : d.age;
  return {
    ...d,
    publishStatus: d.publishStatus === 'draft' ? 'draft' : 'published',
    age: Array.isArray(ages) ? (ages.length ? ages : null) : ages ?? null,
    year: d.year ? Number(d.year) : null,
    childCount: Math.max(1, Math.round(Number(d.childCount) || 1)),
    streamVideoId: String(d.streamVideoId || '').trim() || null,
    videoUrl: String(d.videoUrl || '').trim() || null,
    fundraisingUrl: String(d.fundraisingUrl || '').trim() || null,
    revealVideoUrl: String(d.revealVideoUrl || '').trim() || null,
    heroSummary: String(d.heroSummary || '').trim() || null,
    photos: clean(d.photos).filter((p) => p.url && !/^blob:/.test(p.url)),
    partnerLogos: clean(d.partnerLogos).filter((p) => p.url && !/^blob:/.test(p.url)),
    plans: clean(d.plans).filter((p) => p.url && !/^blob:/.test(p.url)).map((p) => ({ ...p, type: p.type === 'proposed' ? 'proposed' : 'as-built' })),
    beforeAfterPhotos: clean(d.beforeAfterPhotos).filter((p) => p.before && p.after && !/^blob:/.test(p.before + p.after)),
    photoCount: clean(d.photos).filter((p) => p.url && !/^blob:/.test(p.url)).length,
  };
}
