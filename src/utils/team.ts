/**
 * People (Team & Board) rules for the site build: who shows on the Leadership
 * page, in what order, and each photo's URL. Mirrors public/admin/team-shared.js
 * (the admin and its Preview use that copy); scripts/test-page-preview.mjs
 * rebuilds the page with the admin's copy and compares it with this one's
 * output, so keep the two in step. Field reference: see team-shared.js.
 */
import { CF_BASE, cfId } from './cf-image';

export interface PhotoCrop { x: number; y: number; size: number }
export interface PersonData {
  name: string;
  title: string;
  group: 'team' | 'board';
  order?: number;
  organization?: string;
  photo?: string;
  bio?: string;
  quote?: string;
  role?: 'founder' | 'staff' | 'honorary';
  seat?: '' | 'chair' | 'vice-chair' | 'treasurer' | 'secretary';
  status?: 'active' | 'alumni' | 'memorial';
  since?: number | null;
  until?: number | null;
  committees?: string[];
  partner?: string | null;
  linkedin?: string | null;
  publishStatus?: 'published' | 'draft';
  photoCrop?: PhotoCrop | null;
  photoSize?: [number, number] | null;
  photoCutout?: boolean;
  [key: string]: unknown;
}
export interface Person extends PersonData {
  status: 'active' | 'alumni' | 'memorial';
  role: 'founder' | 'staff' | 'honorary' | null;
  seat: '' | 'chair' | 'vice-chair' | 'treasurer' | 'secretary';
  draft: boolean;
}

// The circle behind every photo on the Leadership page (--c-warm-gray)
export const CUTOUT_BACKDROP = 'F5F4F0';

const MEMORIAL_PREFIX = /^\s*in memoriam\s*[,:]?\s*/i;
const SEAT_IDS = ['chair', 'vice-chair', 'treasurer', 'secretary'];
const ROLE_IDS = ['founder', 'staff', 'honorary'];
const STATUS_IDS = ['active', 'alumni', 'memorial'];

export function seatFromTitle(title: string | undefined): Person['seat'] {
  const t = String(title || '');
  if (/vice[\s-]*chair/i.test(t)) return 'vice-chair';
  if (/\bchair/i.test(t)) return 'chair';
  if (/treasurer/i.test(t)) return 'treasurer';
  if (/secretary/i.test(t)) return 'secretary';
  return '';
}

export function normalizePerson(d: PersonData): Person {
  const rawName = String(d?.name || '');
  const legacyMemorial = MEMORIAL_PREFIX.test(rawName);
  const board = d?.group === 'board';
  const status = (STATUS_IDS.includes(d?.status as string) ? d.status : legacyMemorial ? 'memorial' : 'active') as Person['status'];
  const role = (board ? null : ROLE_IDS.includes(d?.role as string) ? d.role : /co-?founder/i.test(d?.title || '') ? 'founder' : 'staff') as Person['role'];
  const seat = (!board ? '' : (d && 'seat' in d && (d.seat === '' || SEAT_IDS.includes(d.seat as string))) ? d.seat : seatFromTitle(d?.title)) as Person['seat'];
  return {
    ...d,
    name: legacyMemorial ? rawName.replace(MEMORIAL_PREFIX, '').trim() : rawName,
    status,
    role,
    seat,
    draft: d?.publishStatus === 'draft',
  };
}

export const isListed = (p: Person) => !p.draft && p.status !== 'alumni';

const ROLE_RANK: Record<string, number> = { founder: 0, staff: 1, honorary: 2 };
const SEAT_RANK: Record<string, number> = { chair: 0, 'vice-chair': 1, treasurer: 2, secretary: 3, '': 4 };
const byOrder = (a: Person, b: Person) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.name).localeCompare(String(b.name));

export function comparePeople(a: Person, b: Person): number {
  if (a.group === 'board') {
    return (Number(a.status === 'memorial') - Number(b.status === 'memorial'))
      || SEAT_RANK[a.seat || ''] - SEAT_RANK[b.seat || '']
      || byOrder(a, b);
  }
  return ROLE_RANK[a.role as string] - ROLE_RANK[b.role as string] || byOrder(a, b);
}

// ── Photos ──

function validCrop(p: PersonData) {
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

export function photoTransform(p: PersonData, px: number, q = 85): string {
  const crop = validCrop(p);
  const parts: string[] = [];
  if (crop) parts.push(`trim=${crop.top};${crop.W - crop.left - crop.side};${crop.H - crop.top - crop.side};${crop.left}`);
  parts.push(`w=${px}`, `h=${px}`, 'fit=cover');
  if (!crop) parts.push('gravity=face');
  if (p?.photoCutout) parts.push('segment=foreground', `background=%23${CUTOUT_BACKDROP}`);
  parts.push(`q=${q}`, 'metadata=none');
  return parts.join(',');
}

export function photoUrl(p: PersonData, px: number): string {
  const id = cfId(p?.photo || '');
  return id ? `${CF_BASE}/${id}/${photoTransform(p, px)}` : '';
}

export function photoSrcset(p: PersonData, widths: number[]): string {
  const id = cfId(p?.photo || '');
  if (!id) return '';
  return widths.map((w) => `${CF_BASE}/${id}/${photoTransform(p, w)} ${w}w`).join(', ');
}

export function photoLqip(p: PersonData): string {
  const id = cfId(p?.photo || '');
  if (!id) return '';
  const crop = validCrop(p);
  if (!crop && !p?.photoCutout) return `${CF_BASE}/${id}/w=30,q=30,blur=20`;
  const parts: string[] = [];
  if (crop) parts.push(`trim=${crop.top};${crop.W - crop.left - crop.side};${crop.H - crop.top - crop.side};${crop.left}`);
  parts.push('w=30', 'h=30', 'fit=cover');
  if (!crop) parts.push('gravity=face');
  if (p.photoCutout) parts.push('segment=foreground', `background=%23${CUTOUT_BACKDROP}`);
  parts.push('q=30', 'blur=20');
  return `${CF_BASE}/${id}/${parts.join(',')}`;
}

// ── Profile pages ──
// Someone on the Leadership page who has a bio gets a page of their own, and
// their card links to it. No bio, no page.

export const hasProfile = (p: Person) => isListed(p) && !!String(p?.bio || '').trim();
export const profilePath = (slug: string) => `/about/leadership/${slug}/`;

export function bioParagraphs(text: string | undefined): string[] {
  return String(text || '').replace(/\r/g, '').split(/\n\s*\n/)
    .map((s) => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
}

export function portraitTransform(p: PersonData, w: number, q = 82): string {
  const crop = validCrop(p);
  const h = Math.round(w * 1.25);
  const parts: string[] = [];
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
export function portraitUrl(p: PersonData, w: number): string {
  const id = cfId(p?.photo || '');
  return id ? `${CF_BASE}/${id}/${portraitTransform(p, w)}` : '';
}
export function portraitSrcset(p: PersonData, widths: number[]): string {
  const id = cfId(p?.photo || '');
  if (!id) return '';
  return widths.map((w) => `${CF_BASE}/${id}/${portraitTransform(p, w)} ${w}w`).join(', ');
}
