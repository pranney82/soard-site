/**
 * team-shared.js — the rules for People (Team, Board & Advisory Board) records,
 * shared by the admin (index.html), the Leadership and Advisory Board page
 * Previews (team-preview.js, advisory-preview.js) and, mirrored line for line,
 * the site build (src/utils/team.ts).
 * scripts/test-page-preview.mjs rebuilds the Leadership page with these and
 * compares it with the real page, so the two copies can't drift unnoticed.
 *
 * A record keeps its original fields (name, title, organization, photo, bio,
 * quote, group, order) plus the structured ones added in Oct 2026:
 *   group        'team' | 'board' | 'advisory' (the Advisory Board, Oct 2026:
 *                ambassadors with no seats, committees or reveal invites)
 *   role         team only: 'founder' | 'staff' | 'honorary'
 *   seat         board only: 'chair' | 'vice-chair' | 'treasurer' | 'secretary' | 'past-chair' | '' (member)
 *   status       'active' | 'alumni' (off the site, kept here) | 'memorial'
 *   since/until  years served (numbers, optional)
 *   committees   board only: string[], names from the board's committee list
 *                (src/content/site/board-committees.json), A to Z
 *   partner      board and advisory: a partner's slug (their company on the partners page)
 *   linkedin     https URL
 *   publishStatus 'draft' hides the person from the site
 *   photoCrop    { x, y, size }: the square crop, as fractions of the
 *                original's width (x, size) and height (y)
 *   photoSize    [width, height] of the original upload, in pixels
 *   photoCutout  true: background removed onto the circle's warm gray
 * Older records carry some of this in text ("In memoriam, Name", a title with
 * "Co-Founder" or "Board Chair"); normalizePerson reads both.
 */

const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
export const CF_ORIGIN = `https://imagedelivery.net/${CF_HASH}`;
export const CF_BASE = `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${CF_HASH}`;
const NAMED_VARIANTS = new Set(['public', 'nav', 'footer', 'og']);
const CF_PROXY_RE = /^https?:\/\/[^/]+\/cdn-cgi\/imagedelivery\/[^/]+\//;

export const SEATS = [
  { id: 'chair', label: 'Chair', title: 'Board Chair' },
  { id: 'vice-chair', label: 'Vice Chair', title: 'Board Vice Chair' },
  { id: 'treasurer', label: 'Treasurer', title: 'Board Treasurer' },
  { id: 'secretary', label: 'Secretary', title: 'Board Secretary' },
  { id: 'past-chair', label: 'Past Chair', title: 'Past Board Chair' },
];
export const MEMBER_TITLE = 'Board Member';
export const ADVISORY_TITLE = 'Advisory Board Member';
/** The three groups, in the order the admin's tabs and the Leadership page show them */
export const GROUPS = [
  { id: 'team', label: 'Our Team', tab: 'Team', noun: 'team member', anchor: 'our-team' },
  { id: 'board', label: 'Board of Directors', tab: 'Board', noun: 'board member', anchor: 'board' },
  { id: 'advisory', label: 'Advisory Board', tab: 'Advisory', noun: 'advisory board member', anchor: 'advisory-board' },
];
export const groupOf = (id) => GROUPS.find((g) => g.id === id) || GROUPS[0];
export const TEAM_ROLES = [
  { id: 'founder', label: 'Founder' },
  { id: 'staff', label: 'Staff' },
  { id: 'honorary', label: 'Honorary crew' },
];
export const STATUSES = [
  { id: 'active', label: 'Active' },
  { id: 'alumni', label: 'Alumni' },
  { id: 'memorial', label: 'In memoriam' },
];

// The circle behind every photo on the Leadership page (--c-warm-gray)
export const CUTOUT_BACKDROP = 'F5F4F0';
// The largest circle on the page is 220px, so 440px covers 2x screens
export const PHOTO_MIN = 440;
// Comfortably sharp at any size the page might grow to
export const PHOTO_GOOD = 800;

const MEMORIAL_PREFIX = /^\s*in memoriam\s*[,:]?\s*/i;
// Older records kept the years served in the title ("Board Member 2024-2025")
const YEARS_IN_TITLE = /[\s,(]*\b((?:19|20)\d{2})\s*(?:[-–—]|to)\s*((?:19|20)\d{2}|present|now)\)?\s*$/i;
const SEAT_IDS = SEATS.map((s) => s.id);
const ROLE_IDS = TEAM_ROLES.map((r) => r.id);
const STATUS_IDS = STATUSES.map((s) => s.id);

/** The seat a free-text title names ("Board Chair" → chair), for older records */
export function seatFromTitle(title) {
  const t = String(title || '');
  if (/\bpast\b.*\b(chair|president)/i.test(t)) return 'past-chair';
  if (/vice[\s-]*chair/i.test(t)) return 'vice-chair';
  if (/\bchair/i.test(t)) return 'chair';
  if (/treasurer/i.test(t)) return 'treasurer';
  if (/secretary/i.test(t)) return 'secretary';
  return '';
}

/** The title a seat shows on the site */
export function seatTitle(seat) {
  return SEATS.find((s) => s.id === seat)?.title || MEMBER_TITLE;
}

/** Years an older record kept in its title become since/until, and the title loses them */
function legacyYears(d) {
  if (d?.since != null || d?.until != null) return {};
  const m = String(d?.title || '').match(YEARS_IN_TITLE);
  if (!m) return {};
  const title = String(d.title).slice(0, m.index).replace(/[\s,·-]+$/, '');
  if (!title) return {};
  return { title, since: Number(m[1]), ...(/^\d/.test(m[2]) ? { until: Number(m[2]) } : {}) };
}

/**
 * The record with every structured field filled in. Explicit fields win;
 * older records fall back to what their name and title say.
 */
export function normalizePerson(d) {
  const rawName = String(d?.name || '');
  const legacyMemorial = MEMORIAL_PREFIX.test(rawName);
  const board = d?.group === 'board';
  const team = !board && d?.group !== 'advisory';
  const status = STATUS_IDS.includes(d?.status) ? d.status : legacyMemorial ? 'memorial' : 'active';
  const role = !team ? null : ROLE_IDS.includes(d?.role) ? d.role : /co-?founder/i.test(d?.title || '') ? 'founder' : 'staff';
  const seat = !board ? '' : (d && 'seat' in d && (d.seat === '' || SEAT_IDS.includes(d.seat))) ? d.seat : seatFromTitle(d?.title);
  return {
    ...d,
    ...legacyYears(d),
    name: legacyMemorial ? rawName.replace(MEMORIAL_PREFIX, '').trim() : rawName,
    status,
    role,
    seat,
    draft: d?.publishStatus === 'draft',
  };
}

/** "2024–2025" for someone whose time has ended (in memory or alumni) with both years known */
export const servedYears = (p) => (p?.status !== 'active' && typeof p?.since === 'number' && typeof p?.until === 'number' ? `${p.since}–${p.until}` : '');
/** A board card's title line: a member in memory shows their years ("Board Member, 2024–2025") */
export const boardTitleLine = (p) => { const y = p?.status === 'memorial' ? servedYears(p) : ''; return y ? `${p.title || ''}, ${y}` : p.title || ''; };

/** On the Leadership page: not a draft, not alumni */
export const isListed = (p) => !p.draft && p.status !== 'alumni';

const ROLE_RANK = { founder: 0, staff: 1, honorary: 2 };
const SEAT_RANK = { chair: 0, 'vice-chair': 1, treasurer: 2, secretary: 3, 'past-chair': 4, '': 5 };
const byOrder = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.name).localeCompare(String(b.name));

/** The site's order: founders, staff, honorary crew; officers, members, then those in memory; advisors as placed, those in memory last */
export function comparePeople(a, b) {
  if (a.group === 'board') {
    return ((a.status === 'memorial') - (b.status === 'memorial'))
      || SEAT_RANK[a.seat || ''] - SEAT_RANK[b.seat || '']
      || byOrder(a, b);
  }
  if (a.group === 'advisory') return ((a.status === 'memorial') - (b.status === 'memorial')) || byOrder(a, b);
  return ROLE_RANK[a.role] - ROLE_RANK[b.role] || byOrder(a, b);
}

/** "Jane Q. Smith" → "JS", for a card with no photo */
export const initials = (name) => {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase() || '?';
};
/** An advisor's title, when it says more than "Advisory Board Member" (the Advisory Board page leaves that one off) */
export const advisoryTitle = (p) => { const t = String(p?.title || '').trim(); return t && t !== ADVISORY_TITLE ? t : ''; };

// ── Photos (URLs mirror src/utils/cf-image.ts) ───────────────────────

export function cfId(src) {
  if (!src) return '';
  if (!src.includes('imagedelivery.net') && !CF_PROXY_RE.test(src)) return src;
  let id = src.replace(`${CF_ORIGIN}/`, '').replace(CF_PROXY_RE, '');
  const lastSlash = id.lastIndexOf('/');
  if (lastSlash > 0) {
    const suffix = id.slice(lastSlash + 1);
    if (NAMED_VARIANTS.has(suffix) || suffix.includes('=')) id = id.slice(0, lastSlash);
  }
  return id;
}

/** A crop the URL can use: inside the photo, and the photo's size known */
export function validCrop(p) {
  const c = p?.photoCrop;
  const s = p?.photoSize;
  if (!c || !Array.isArray(s) || !(s[0] > 0) || !(s[1] > 0)) return null;
  const { x, y, size } = c;
  if (![x, y, size].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [W, H] = s;
  const left = Math.round(x * W);
  const top = Math.round(y * H);
  const side = Math.round(size * W);
  if (left < 0 || top < 0 || side < 16 || left + side > W || top + side > H) return null;
  return { left, top, side, W, H };
}

/** Cloudflare transform for a square photo of `px` pixels */
export function photoTransform(p, px, q = 85) {
  const crop = validCrop(p);
  const parts = [];
  if (crop) parts.push(`trim=${crop.top};${crop.W - crop.left - crop.side};${crop.H - crop.top - crop.side};${crop.left}`);
  parts.push(`w=${px}`, `h=${px}`, 'fit=cover');
  if (!crop) parts.push('gravity=face');
  if (p?.photoCutout) parts.push('segment=foreground', `background=%23${CUTOUT_BACKDROP}`);
  parts.push(`q=${q}`, 'metadata=none');
  return parts.join(',');
}

export function photoUrl(p, px) {
  const id = cfId(p?.photo);
  return id ? `${CF_BASE}/${id}/${photoTransform(p, px)}` : '';
}

export function photoSrcset(p, widths) {
  const id = cfId(p?.photo);
  if (!id) return '';
  return widths.map((w) => `${CF_BASE}/${id}/${photoTransform(p, w)} ${w}w`).join(', ');
}

/** The blurred stand-in shown while the photo loads */
export function photoLqip(p) {
  const id = cfId(p?.photo);
  if (!id) return '';
  const crop = validCrop(p);
  if (!crop && !p?.photoCutout) return `${CF_BASE}/${id}/w=30,q=30,blur=20`;
  const parts = [];
  if (crop) parts.push(`trim=${crop.top};${crop.W - crop.left - crop.side};${crop.H - crop.top - crop.side};${crop.left}`);
  parts.push('w=30', 'h=30', 'fit=cover');
  if (!crop) parts.push('gravity=face');
  if (p.photoCutout) parts.push('segment=foreground', `background=%23${CUTOUT_BACKDROP}`);
  parts.push('q=30', 'blur=20');
  return `${CF_BASE}/${id}/${parts.join(',')}`;
}

/** How many pixels the circle gets from the original: the crop's side, or the short side */
export function photoPixels(p, size = p?.photoSize) {
  if (!Array.isArray(size) || !(size[0] > 0)) return null;
  const crop = validCrop({ ...p, photoSize: size });
  return crop ? crop.side : Math.min(size[0], size[1]);
}

/** 'good' | 'ok' | 'blurry' | null (unknown) */
export function photoQuality(px) {
  if (!px) return null;
  if (px >= PHOTO_GOOD) return 'good';
  if (px >= PHOTO_MIN) return 'ok';
  return 'blurry';
}

// ── Profile pages ────────────────────────────────────────────────────
// Someone on the Leadership page who has a bio gets a page of their own,
// and their card links to it. No bio, no page: nothing thin goes live.

export const hasProfile = (p) => isListed(p) && !!String(p?.bio || '').trim();
export const profilePath = (slug) => `/about/leadership/${slug}/`;

/** The words a profile page uses for the person's group */
export function profileWords(p) {
  const memorial = p?.status === 'memorial';
  if (p?.group === 'board') {
    return { eyebrow: memorial ? 'In memoriam' : 'Board of Directors', meet: 'Meet the Board', group: 'board', back: '/about/leadership/#board',
      company: 'Company', since: 'On the board', statSince: 'on the board<br/>since', statServed: 'served on<br/>the board' };
  }
  if (p?.group === 'advisory') {
    return { eyebrow: memorial ? 'In memoriam' : 'Advisory Board', meet: 'Meet the Advisory Board', group: 'advisory board', back: '/advisory-board/#members',
      company: 'Company', since: 'On the advisory board', statSince: 'on the advisory<br/>board since', statServed: 'served on the<br/>advisory board' };
  }
  return { eyebrow: memorial ? 'In memoriam' : p?.role === 'founder' ? 'Co-Founder' : 'Our Team', meet: 'Meet the Team', group: 'team', back: '/about/leadership/#our-team',
    company: 'Organization', since: 'With SOARD', statSince: 'with SOARD<br/>since', statServed: 'with<br/>SOARD' };
}

/** Bio text as paragraphs: blank lines split them, single line breaks join */
export function bioParagraphs(text) {
  return String(text || '').replace(/\r/g, '').split(/\n\s*\n/)
    .map((s) => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
}

/**
 * The profile portrait (4:5). A square framing from the admin grows into a
 * 4:5 box around the same center, so the face stays where it was put.
 */
export function portraitTransform(p, w, q = 82) {
  const crop = validCrop(p);
  const h = Math.round(w * 1.25);
  const parts = [];
  if (crop) {
    let pw = crop.side;
    let ph = Math.round(pw * 1.25);
    if (ph > crop.H) { ph = crop.H; pw = Math.round(ph / 1.25); }
    const cx = crop.left + crop.side / 2;
    const cy = crop.top + crop.side / 2;
    const left = Math.round(Math.min(Math.max(cx - pw / 2, 0), crop.W - pw));
    const top = Math.round(Math.min(Math.max(cy - ph / 2, 0), crop.H - ph));
    parts.push(`trim=${top};${crop.W - left - pw};${crop.H - top - ph};${left}`);
  }
  parts.push(`w=${w}`, `h=${h}`, 'fit=cover');
  if (!crop) parts.push('gravity=face');
  if (p?.photoCutout) parts.push('segment=foreground', `background=%23${CUTOUT_BACKDROP}`);
  parts.push(`q=${q}`, 'metadata=none');
  return parts.join(',');
}
export function portraitUrl(p, w) {
  const id = cfId(p?.photo);
  return id ? `${CF_BASE}/${id}/${portraitTransform(p, w)}` : '';
}
export function portraitSrcset(p, widths) {
  const id = cfId(p?.photo);
  if (!id) return '';
  return widths.map((w) => `${CF_BASE}/${id}/${portraitTransform(p, w)} ${w}w`).join(', ');
}

// ── Committees ───────────────────────────────────────────────────────
// The board's committees are one list, picked from in the editor and kept
// in src/content/site/board-committees.json ({ committees: [...] }). Until
// it's first saved, the list starts from DEFAULT_COMMITTEES. A name on
// someone's record always counts, so nothing assigned can drop off the list.

export const COMMITTEES_PATH = 'src/content/site/board-committees.json';
export const DEFAULT_COMMITTEES = ['Finance', 'Gala', 'Golf Tournament', 'Governance'];

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
export const sameCommittee = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
/** A typed name, tidied: single spaces, no stray punctuation at the ends */
export const cleanCommittee = (s) => String(s || '').replace(/\s+/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '');

/** Names A to Z, each once (the first spelling wins) */
export function sortCommittees(names) {
  const out = [];
  for (const n of names || []) {
    const c = cleanCommittee(n);
    if (c && !out.some((x) => sameCommittee(x, c))) out.push(c);
  }
  return out.sort(byName);
}

/** Every committee to pick from: the saved list (or the starter one) plus any on a board record */
export function committeeList(saved, people = []) {
  const base = Array.isArray(saved) ? saved : DEFAULT_COMMITTEES;
  const used = people.filter((p) => p?.group === 'board' && Array.isArray(p.committees)).flatMap((p) => p.committees);
  return sortCommittees([...base, ...used]);
}

/** Board members on a committee, by name */
export const committeeMembers = (name, people = []) => people
  .filter((p) => p?.group === 'board' && Array.isArray(p.committees) && p.committees.some((c) => sameCommittee(c, name)));

// ── Profile fields ───────────────────────────────────────────────────

/** "linkedin.com/in/jane" or a full URL → "https://www.linkedin.com/in/jane", else null */
export function normalizeLinkedIn(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  if (!/^\/(in|pub|company)\/[^/]+/i.test(u.pathname)) return null;
  return `https://www.linkedin.com${u.pathname.replace(/\/+$/, '')}`;
}

// ── Adding several people at once (People → Board or Advisory → Paste a list) ──

/** A web address from a name: the admin's slugify */
export const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const EMAIL_IN = /[^\s<>()[\],;:"“”]+@[^\s<>()[\],;:"“”]+\.[^\s<>()[\],;:"“”]+/;
// Something with an @ that isn't a whole address ("jane@", "jane@example"): kept as the email, so the plan flags it
const BROKEN_EMAIL_IN = /[^\s<>()[\],;:"“”]*@[^\s<>()[\],;:"“”]*/;
const EDGE_SEPS = /^[\s:;,|–—-]+|[\s:;,|–—-]+$/g;
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One person per line: a name and, if there is one, an email, in whatever
 * shape an email or a spreadsheet gives them ("Jane Smith: jane@x.org",
 * "Jane Smith <jane@x.org>", a tab between columns, a bullet in front).
 * → [{ line, name, email }], a spreadsheet's header row left out
 */
export function parsePeopleList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim();
    if (!line) continue;
    const m = line.match(EMAIL_IN) || line.match(BROKEN_EMAIL_IN);
    const email = m ? m[0].replace(/[.]+$/, '').toLowerCase() : '';
    const name = (m ? line.replace(m[0], ' ') : line).replace(/mailto:/gi, ' ').replace(/[<>()[\]"“”]/g, ' ')
      .replace(/\s+/g, ' ').replace(EDGE_SEPS, '').trim();
    if (!email && /^name\b.*\bemail\b/i.test(name)) continue;
    out.push({ line, name, email });
  }
  return out;
}

/**
 * What Add does with each pasted person, given everyone saved (team) and the
 * group's private emails (slug → email): act 'add' (a new record), 'email'
 * (already in this group: save their email) or 'skip', with a note saying why.
 */
export function planPeopleList(rows, team, group, emails) {
  const seen = new Set();
  return rows.map((r) => {
    const slug = slugOf(r.name);
    const base = { ...r, slug };
    if (!r.name || !slug) return { ...base, act: 'skip', note: r.email ? 'No name' : 'Not a name' };
    if (r.email && !EMAIL_OK.test(r.email)) return { ...base, act: 'skip', note: 'The email doesn’t look right' };
    if (seen.has(slug)) return { ...base, act: 'skip', note: 'Listed twice' };
    seen.add(slug);
    const there = (team || []).find((t) => t.slug === slug);
    if (!there) return { ...base, act: 'add', note: r.email ? 'Adds them with their email' : 'Adds them, no email yet' };
    if (there.group !== group) return { ...base, act: 'skip', note: `Already in ${groupOf(there.group).label}` };
    const had = emails?.[slug] || '';
    if (!r.email || had === r.email) return { ...base, act: 'skip', note: 'Already here' };
    return { ...base, act: 'email', note: had ? `Already here: replaces ${had}` : 'Already here: adds their email' };
  });
}
