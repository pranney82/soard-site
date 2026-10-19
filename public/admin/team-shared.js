/**
 * team-shared.js — the rules for People (Team & Board) records, shared by the
 * admin (index.html), the Leadership page Preview (team-preview.js) and,
 * mirrored line for line, the site build (src/utils/team.ts).
 * scripts/test-page-preview.mjs rebuilds the Leadership page with these and
 * compares it with the real page, so the two copies can't drift unnoticed.
 *
 * A record keeps its original fields (name, title, organization, photo, bio,
 * quote, group, order) plus the structured ones added in Oct 2026:
 *   role         team only: 'founder' | 'staff' | 'honorary'
 *   seat         board only: 'chair' | 'vice-chair' | 'treasurer' | 'secretary' | '' (member)
 *   status       'active' | 'alumni' (off the site, kept here) | 'memorial'
 *   since/until  years served (numbers, optional)
 *   committees   board only: string[]
 *   partner      board only: a partner's slug (their company on the partners page)
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
];
export const MEMBER_TITLE = 'Board Member';
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
const SEAT_IDS = SEATS.map((s) => s.id);
const ROLE_IDS = TEAM_ROLES.map((r) => r.id);
const STATUS_IDS = STATUSES.map((s) => s.id);

/** The seat a free-text title names ("Board Chair" → chair), for older records */
export function seatFromTitle(title) {
  const t = String(title || '');
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

/**
 * The record with every structured field filled in. Explicit fields win;
 * older records fall back to what their name and title say.
 */
export function normalizePerson(d) {
  const rawName = String(d?.name || '');
  const legacyMemorial = MEMORIAL_PREFIX.test(rawName);
  const board = d?.group === 'board';
  const status = STATUS_IDS.includes(d?.status) ? d.status : legacyMemorial ? 'memorial' : 'active';
  const role = board ? null : ROLE_IDS.includes(d?.role) ? d.role : /co-?founder/i.test(d?.title || '') ? 'founder' : 'staff';
  const seat = !board ? '' : (d && 'seat' in d && (d.seat === '' || SEAT_IDS.includes(d.seat))) ? d.seat : seatFromTitle(d?.title);
  return {
    ...d,
    name: legacyMemorial ? rawName.replace(MEMORIAL_PREFIX, '').trim() : rawName,
    status,
    role,
    seat,
    draft: d?.publishStatus === 'draft',
  };
}

/** On the Leadership page: not a draft, not alumni */
export const isListed = (p) => !p.draft && p.status !== 'alumni';

const ROLE_RANK = { founder: 0, staff: 1, honorary: 2 };
const SEAT_RANK = { chair: 0, 'vice-chair': 1, treasurer: 2, secretary: 3, '': 4 };
const byOrder = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.name).localeCompare(String(b.name));

/** The site's order: founders, staff, honorary crew; officers, members, then those in memory */
export function comparePeople(a, b) {
  if (a.group === 'board') {
    return ((a.status === 'memorial') - (b.status === 'memorial'))
      || SEAT_RANK[a.seat || ''] - SEAT_RANK[b.seat || '']
      || byOrder(a, b);
  }
  return ROLE_RANK[a.role] - ROLE_RANK[b.role] || byOrder(a, b);
}

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
