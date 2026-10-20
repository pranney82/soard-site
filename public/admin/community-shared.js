/**
 * community-shared.js — the rules for community projects, shared by the
 * admin's Community Projects list and editor (index.html), the project page
 * Preview (community-preview.js) and the unit tests
 * (tests/community-admin.test.mjs).
 *
 * The page derivations mirror src/pages/community/index.astro and
 * [slug].astro, and reachedCount mirrors src/utils/community.ts (the
 * "children reached through partnerships" total). Preview builds every
 * project's page with them and scripts/test-page-preview.mjs compares that
 * with the real page. Change both sides together.
 *
 * Fields the editor writes on a project (src/content/config.ts):
 *   status         'completed' | 'in-progress' (an In Progress badge)
 *   publishStatus  'draft' keeps the project off the site
 *   stats          up to 3 { value, label, reached }: the first is the card's
 *                  number (mirrored into impact / impactLabel); reached marks
 *                  the one added to "children reached" (all false: none)
 *   heroImage      the main photo, one of photos[]; imageId and imageAlt
 *                  mirror it (and its alt text) for the card and older readers
 *   story          the page: a project gets one only when it has a story
 *   quote, quoteBy a line set large on the page, and who said it
 *   order          place on the Community Projects page
 */
import { youTubeId, streamUid, STREAM_UID_RE, needsAlt, focusCss, focusGravity, META_MAX, SITE_ORIGIN } from './kids-shared.js';

export { youTubeId, streamUid, STREAM_UID_RE, needsAlt, focusCss, focusGravity, META_MAX, SITE_ORIGIN };

// ── Status ───────────────────────────────────────────────────────────
export const STATUSES = [
  { id: 'completed', label: 'Completed', hint: 'Listed with the finished projects.' },
  { id: 'in-progress', label: 'In progress', hint: 'Its card and page carry an “In Progress” badge.' },
];
export const statusOf = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];
export const isListed = (p) => p?.publishStatus !== 'draft';

// ── Text ─────────────────────────────────────────────────────────────
export const plain = (html) => String(html || '').replace(/<\/(p|li|h\d|blockquote)>/gi, ' ').replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’').replace(/\s+/g, ' ').trim();
const words = (s) => (plain(s) ? plain(s).split(/\s+/).length : 0);
/** Rich HTML from the editor, or an older plain-text story (paragraphs split on blank lines) */
export const storyIsHtml = (raw) => /<\/?(p|br|strong|em|b|i|u|ul|ol|li|a|h[1-6]|blockquote)\b/i.test(String(raw || ''));
export const storyParas = (raw) => (storyIsHtml(raw) ? [] : String(raw || '').split('\n\n').filter((p) => p.trim()));
/** The page: only projects with a story get one (the card links to it) */
export const hasPage = (p) => !!p?.story;
export const pagePath = (slug) => `/community/${slug}/`;

// ── Stats ────────────────────────────────────────────────────────────
export const STATS_MAX = 3;
/** The stats the page's hero shows: the list, else the single impact pair */
export function heroStats(p) {
  return (p?.stats?.length ? p.stats : [{ value: p?.impact, label: p?.impactLabel }]).slice(0, STATS_MAX);
}
/**
 * The stat added to "children reached through partnerships" on the
 * Community page: the one marked reached; none when every stat is marked
 * false; the first stat for records saved before the choice existed.
 */
export function reachedStat(p) {
  const stats = heroStats(p);
  const marked = stats.findIndex((s) => s?.reached === true);
  if (marked >= 0) return { ...stats[marked], index: marked };
  if (stats.some((s) => s?.reached === false)) return null;
  return stats[0]?.value ? { ...stats[0], index: 0 } : null;
}
/** Its number: "10,000" → 10000, "200+" → 200 */
export function reachedCount(p) {
  const n = parseInt(String(reachedStat(p)?.value ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}
/** Does a stat's label count people (so it belongs in "children reached")? */
export const PEOPLE_RE = /\b(child|children|kid|kids|student|students|famil(y|ies)|people|person|persons|client|clients|camper|campers|patient|patients|youth|resident|residents|participant|participants|member|members|individual|individuals|served|enrolled|families)\b/i;
export const countsPeople = (label) => PEOPLE_RE.test(String(label || ''));

// ── Photos ───────────────────────────────────────────────────────────
const CF_URL_RE = /^https?:\/\/(?:imagedelivery\.net|[^/]+\/cdn-cgi\/imagedelivery)\/[^/]+\/(.+?)(?:\/(?:public|[^/]*=[^/]*))?$/;
/** A Cloudflare Images id from a stored URL or id ("community/x/1.jpg") */
export function imageIdOf(src) {
  const s = String(src || '').trim();
  if (!s || /^(blob|data):/.test(s)) return '';
  const m = s.match(CF_URL_RE);
  return m ? m[1] : (/^https?:/.test(s) ? '' : s);
}
/** The photo at the top of the page and on the card (the page reads heroImage first) */
export const mainPhotoOf = (p) => p?.heroImage || p?.imageId || '';
/** The main photo's alt text, as both pages write it */
export const heroAltOf = (p) => p?.imageAlt || `${p?.name || ''} project by SOARD`;
/** The page's gallery: every photo, once there are two */
export const galleryShown = (p) => ((p?.photos || []).length > 1 ? p.photos : []);

// ── Search and sharing (mirrors the page's <title> and description) ─
export function pageTitleOf(p) {
  return `${p?.name || 'Project'} — Community Project | Sunshine on a Ranney Day`;
}
export const metaDescriptionOf = (p) => p?.metaDescription || p?.description || '';

// ── Order (mirrors src/pages/community/index.astro) ──────────────────
/** The Community Projects page: by order, then name; drafts left out */
export function listOrder(projects) {
  return [...(projects || [])].filter(isListed)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(String(b.name || '')));
}
/** The admin list: every project in the page's order, drafts where their order puts them */
export function adminOrder(projects) {
  return [...(projects || [])].sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(String(b.name || '')));
}
/** "More Community Projects" on a page: the others with pages, oldest year first */
export function moreProjects(p, projects) {
  return [...(projects || [])].filter((x) => isListed(x) && x.story && x.slug !== p?.slug)
    .sort((a, b) => parseInt(a.year, 10) - parseInt(b.year, 10));
}

// ── What a project is missing ────────────────────────────────────────
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/**
 * Things to fix, most important first. tone 'warn' changes what visitors
 * see (Needs attention); 'quiet' is worth doing when there's time.
 * section: the editor section that fixes it.
 */
export function projectIssues(p) {
  const out = [];
  if (!p) return out;
  const add = (id, tone, label, section, tip) => out.push({ id, tone, label, section, tip });
  const photos = p.photos || [];
  const stats = heroStats(p);
  if (!mainPhotoOf(p)) add('no-hero', 'warn', 'No main photo', 'photos', 'The card shows a color block instead of a photo');
  if (!String(stats[0]?.value ?? '').trim()) add('no-stat', 'warn', 'No impact number', 'basics', 'The card has no number under the name');
  if (!plain(p.description) && !plain(p.metaDescription)) add('no-summary', 'warn', 'No summary', 'basics', 'Search results and shared links have no description');
  const reached = reachedStat(p);
  if (reached && reached.value && !countsPeople(reached.label)) add('reached-not-people', 'warn', 'Counted number isn’t people', 'basics', `“${reached.value} ${reached.label}” is added to “children reached” on the Community page`);
  if (!hasPage(p)) add('no-page', 'quiet', 'No page yet', 'story', 'Add a story to give the project a page; until then its card isn’t a link');
  const noAlt = photos.filter(needsAlt).length;
  if (noAlt) add('alt', 'quiet', `${plural(noAlt, 'photo')} need${noAlt === 1 ? 's' : ''} alt text`, 'photos', 'Screen readers and image search rely on it');
  const unnamed = (p.partnerLogos || []).filter((l) => !String(l.name || '').trim()).length;
  if (unnamed) add('partner-names', 'quiet', `${plural(unnamed, 'partner logo')} unnamed`, 'partners', 'Screen readers hear “Project partner logo” for these');
  if (hasPage(p) && photos.length < 2) add('no-gallery', 'quiet', photos.length ? 'Only 1 photo' : 'No photos', 'photos', 'The page shows a photo gallery from two photos up');
  if (!plain(p.metaDescription) && plain(p.description).length > META_MAX) add('long-summary', 'quiet', 'Summary runs long in Google', 'search', `Google shows about ${META_MAX} characters; a search description fixes it`);
  if (p.quote && !String(p.quoteBy || '').trim()) add('quote-by', 'quiet', 'Quote has no name', 'story', 'The page shows the quote without who said it');
  return out;
}

/** A project whose page would show Google a summary that runs long (or nothing), and has text to write from */
export const needsSearchText = (p) => !!p && hasPage(p) && !plain(p.metaDescription)
  && (plain(p.description).length > META_MAX || !plain(p.description)) && !!(plain(p.story) || plain(p.description));

/**
 * The editor's health checklist: what a finished project has, in page
 * order. Each check: { id, label, done, section, key } (key: essential).
 */
export function projectChecks(p) {
  if (!p) return [];
  const photos = p.photos || [];
  const stats = heroStats(p);
  const reached = reachedStat(p);
  const list = [
    { id: 'hero', label: 'Main photo', done: !!mainPhotoOf(p), section: 'photos', key: true },
    { id: 'stat', label: 'Impact number', done: !!String(stats[0]?.value ?? '').trim(), section: 'basics', key: true },
    { id: 'summary', label: 'Summary', done: !!(plain(p.description) || plain(p.metaDescription)), section: 'basics', key: true },
    reached ? { id: 'reached', label: 'Counted number is people', done: countsPeople(reached.label), section: 'basics', key: !countsPeople(reached.label) } : null,
    { id: 'story', label: 'Story (the project’s page)', done: hasPage(p), section: 'story' },
    hasPage(p) ? { id: 'gallery', label: 'At least 2 photos', done: photos.length >= 2, section: 'photos' } : null,
    photos.length ? { id: 'alt', label: 'Alt text on every photo', done: !photos.some(needsAlt), section: 'photos' } : null,
    p.quote ? { id: 'quote-by', label: 'Who said the quote', done: !!String(p.quoteBy || '').trim(), section: 'story' } : null,
    (p.partnerLogos || []).length ? { id: 'partners', label: 'Partner logos named', done: !(p.partnerLogos || []).some((l) => !String(l.name || '').trim()), section: 'partners' } : null,
    hasPage(p) ? { id: 'meta', label: 'Search description that fits', done: !!plain(p.metaDescription) || (!!plain(p.description) && plain(p.description).length <= META_MAX), section: 'search' } : null,
  ];
  return list.filter(Boolean);
}

// ── History: what a save changed, in words ───────────────────────────
const HISTORY_FIELDS = [
  ['name', 'Name'], ['status', 'Status'], ['publishStatus', 'Shown on the site'], ['year', 'Year'], ['founded', 'Founded'],
  ['stats', 'Impact numbers'], ['description', 'Summary'], ['story', 'Story'], ['quote', 'Quote'], ['quoteBy', 'Quote by'],
  ['heroImage', 'Main photo'], ['photos', 'Photos'], ['color', 'Card color'], ['video', 'Video'],
  ['partnerLogos', 'Partners'], ['metaDescription', 'Search description'],
];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const clip = (s, n = 48) => { const t = plain(s); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

function listChange(before = [], after = [], keyOf = (x) => x.url, extra = () => []) {
  const b = before.map(keyOf);
  const a = after.map(keyOf);
  const added = a.filter((k) => !b.includes(k)).length;
  const removed = b.filter((k) => !a.includes(k)).length;
  const kept = a.filter((k) => b.includes(k));
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  if (kept.join('\n') !== b.filter((k) => a.includes(k)).join('\n')) parts.push('new order');
  parts.push(...extra(before, after).filter(Boolean));
  return parts.join(', ') || 'edited';
}

/** Field names from the server's history (raw record keys) as the editor's labels, once each */
export function changedLabels(fields) {
  const label = (f) => (f === 'impact' || f === 'impactLabel' ? 'Impact numbers'
    : f === 'imageId' || f === 'imageAlt' ? 'Main photo'
    : f === 'streamVideoId' || f === 'videoUrl' ? 'Video'
    : (HISTORY_FIELDS.find(([k]) => k === f) || [])[1] || f.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()));
  return [...new Set((fields || []).map(label))];
}

const statLine = (s) => `${s.value} ${s.label}`.trim();
/** What changed between two versions of a project, for History: [{ field, label, detail }] */
export function describeChanges(rawBefore, rawAfter) {
  if (!rawBefore || !rawAfter) return [];
  // Both as the editor opens them and Save writes them, so an older record's
  // missing defaults (and the alt text moved onto its main photo) don't read as edits
  const before = projectRecord(forEditing(rawBefore));
  const after = projectRecord(forEditing(rawAfter));
  const out = [];
  for (const [field, label] of HISTORY_FIELDS) {
    let detail = null;
    if (field === 'video') {
      if (same(before.streamVideoId, after.streamVideoId) && same(before.videoUrl, after.videoUrl)) continue;
      detail = !same(before.streamVideoId, after.streamVideoId) ? (after.streamVideoId ? (before.streamVideoId ? 'Different uploaded video' : 'Uploaded video added') : 'Uploaded video removed')
        : after.videoUrl ? (before.videoUrl ? 'Different YouTube link' : 'YouTube link added') : 'YouTube link removed';
    } else if (field === 'stats') {
      const [sb, sa] = [heroStats(before), heroStats(after)];
      const rb = reachedStat(before);
      const ra = reachedStat(after);
      const linesSame = same(sb.map(statLine), sa.map(statLine));
      if (linesSame && same(rb?.index ?? null, ra?.index ?? null)) continue;
      detail = linesSame ? `Counted toward children reached: ${ra ? statLine(ra) : 'none'}`
        : sa.length === sb.length ? sa.map((s, i) => (statLine(s) !== statLine(sb[i] || {}) ? `“${statLine(sb[i] || {})}” → “${statLine(s)}”` : null)).filter(Boolean).join('; ')
        : `${plural(sb.length, 'number')} → ${sa.length}`;
    } else {
      const b = before[field];
      const a = after[field];
      if (same(b, a)) continue;
      // Text that only differs in spacing or markup reads the same on the page
      if ((typeof a === 'string' || typeof b === 'string') && !Array.isArray(a) && plain(b) === plain(a) && field !== 'heroImage') continue;
      if (field === 'status') detail = `${statusOf(b).label} → ${statusOf(a).label}`;
      else if (field === 'publishStatus') detail = a === 'draft' ? 'Hidden' : 'Shown';
      else if (field === 'story') detail = !plain(b) ? `Added (${plural(words(a), 'word')}), so the project has a page` : !plain(a) ? 'Removed, so the project has no page' : words(b) === words(a) ? 'Edited' : `${words(b)} → ${plural(words(a), 'word')}`;
      else if (field === 'heroImage') detail = a ? (b ? 'Changed' : 'Added') : 'Removed';
      else if (field === 'photos') {
        detail = listChange(b || [], a || [], (x) => x.url, (bb, aa) => {
          const before1 = new Map(bb.map((x) => [x.url, x]));
          const both = aa.filter((x) => before1.has(x.url));
          const alt = both.filter((x) => (x.alt || '') !== (before1.get(x.url).alt || '')).length;
          const focus = both.filter((x) => !same(x.focus, before1.get(x.url).focus)).length;
          return [alt && `alt text on ${plural(alt, 'photo')}`, focus && `focal point on ${plural(focus, 'photo')}`];
        });
      } else if (field === 'partnerLogos') {
        detail = listChange(b || [], a || [], (x) => x.url, (bb, aa) => {
          const before1 = new Map(bb.map((x) => [x.url, x]));
          const named = aa.filter((x) => before1.has(x.url) && (x.name || '') !== (before1.get(x.url).name || '')).length;
          return [named && `${plural(named, 'name')} changed`];
        });
      } else if (!plain(b)) detail = `Added: “${clip(a)}”`;
      else if (!plain(a)) detail = 'Removed';
      else detail = `“${clip(b, 32)}” → “${clip(a, 32)}”`;
    }
    out.push({ field, label, detail });
  }
  return out;
}

// ── Saving ───────────────────────────────────────────────────────────
const isBlob = (u) => /^(blob|data):/.test(String(u || ''));
const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
const trim = (s) => String(s ?? '').trim();
/** Stats as Save writes them: trimmed, empty rows dropped, three at most, one marked reached at most */
export function cleanStats(list) {
  const rows = (list || []).map((s) => ({ value: trim(s?.value), label: trim(s?.label), ...(typeof s?.reached === 'boolean' ? { reached: s.reached } : {}) }))
    .filter((s) => s.value || s.label).slice(0, STATS_MAX);
  let marked = false;
  return rows.map((s) => {
    if (s.reached !== true) return s;
    if (marked) return { ...s, reached: false };
    marked = true;
    return s;
  });
}
/** A project exactly as Save writes it (Preview shows the same record) */
export function projectRecord(data) {
  const { _key, _tempId, badge: _legacyBadge, ...d } = data || {};
  const stats = cleanStats(d.stats?.length ? d.stats : (d.impact || d.impactLabel) ? [{ value: d.impact, label: d.impactLabel }] : []);
  const photos = (d.photos || []).map(({ _tempId: _t, _key: _k, cfImageId: _c, ...p }) => p).filter((p) => p.url && !isBlob(p.url));
  const partnerLogos = (d.partnerLogos || []).map(({ _tempId: _t, _key: _k, ...l }) => ({ ...l, name: trim(l.name) })).filter((l) => l.url && !isBlob(l.url));
  const hero = isBlob(d.heroImage) ? '' : trim(d.heroImage);
  const heroPhoto = photos.find((p) => p.url === hero);
  const story = plain(d.story) ? String(d.story) : '';
  return {
    ...d,
    name: trim(d.name),
    slug: trim(d.slug),
    year: trim(d.year),
    founded: trim(d.founded),
    status: d.status === 'in-progress' ? 'in-progress' : 'completed',
    publishStatus: d.publishStatus === 'draft' ? 'draft' : 'published',
    order: Number.isFinite(Number(d.order)) ? Number(d.order) : 0,
    color: d.color || '#373A36',
    stats,
    impact: stats[0]?.value ?? '',
    impactLabel: stats[0]?.label ?? '',
    description: trim(d.description),
    story,
    quote: trim(d.quote) || null,
    quoteBy: trim(d.quoteBy) || null,
    heroImage: hero || null,
    // The card and older readers use these: always the main photo's
    imageId: hero ? imageIdOf(hero) : '',
    imageAlt: hero ? trim(heroPhoto?.alt) : '',
    metaDescription: trim(d.metaDescription),
    streamVideoId: trim(d.streamVideoId) || null,
    videoUrl: trim(d.videoUrl) || null,
    photos,
    partnerLogos,
  };
}

/**
 * A stored project as the editor holds it: the older single-image fields
 * become the first photo, and the main photo carries the alt text the page
 * used for it (imageAlt), so it's edited in one place.
 */
export function forEditing(raw, slug) {
  const d = { ...(raw || {}) };
  let photos = (d.photos || []).map((p) => ({ ...p, alt: p.alt || '' }));
  let hero = d.heroImage || '';
  if (!photos.length && d.imageId) {
    photos = [{ url: d.imageId, alt: d.imageAlt || '' }];
    hero = hero || d.imageId;
  }
  // The card showed imageId when it disagreed with heroImage; the page showed heroImage. Keep the page's.
  if (!hero && d.imageId) hero = photos.find((p) => imageIdOf(p.url) === d.imageId)?.url || '';
  if (!hero && photos.length) hero = photos[0].url;
  if (d.imageAlt) photos = photos.map((p) => (p.url === hero && !trim(p.alt) ? { ...p, alt: d.imageAlt } : p));
  // An older plain-text story becomes paragraphs, as the page splits it, so editing it keeps them
  const story = d.story && !storyIsHtml(d.story) ? storyParas(d.story).map((para) => `<p>${escapeHtml(para.trim())}</p>`).join('') : d.story || '';
  const stats = d.stats?.length ? d.stats : (d.impact || d.impactLabel) ? [{ value: d.impact || '', label: d.impactLabel || '' }] : [];
  return {
    ...d,
    slug: d.slug || slug || '',
    status: d.status === 'in-progress' ? 'in-progress' : 'completed',
    publishStatus: d.publishStatus === 'draft' ? 'draft' : 'published',
    stats: stats.map((s) => ({ ...s })),
    story,
    heroImage: hero,
    photos,
    partnerLogos: (d.partnerLogos || []).map((l) => ({ ...l })),
  };
}

/** A new project before anything is filled in */
export const blankProject = (over = {}) => ({
  name: '', slug: '', year: String(new Date().getFullYear()), founded: '', status: 'in-progress', publishStatus: 'published',
  stats: [{ value: '', label: 'children served each year' }], impact: '', impactLabel: '', description: '', story: '',
  quote: '', quoteBy: '', color: '#373A36', heroImage: '', imageId: '', imageAlt: '', photos: [], partnerLogos: [],
  streamVideoId: '', videoUrl: '', metaDescription: '', order: 0, ...over,
});
