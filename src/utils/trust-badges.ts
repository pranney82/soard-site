/**
 * Trust badges (Charity Navigator, Candid, ...) shown in the footer trust bar
 * and the financials page's "Independently verified" row.
 *
 * Admin-managed: Site Settings → Trust Badges writes `trustBadges` into
 * settings.json (D1). Until that key exists, DEFAULT_TRUST_BADGES applies.
 * Keep it in sync with DEFAULT_TRUST_BADGES in public/admin/index.html.
 *
 * `image` is a Cloudflare Images id (or pasted imagedelivery URL) uploaded
 * from the admin, or a site path for the seals that ship in public/. A badge with no
 * image still renders, as a text badge.
 */
import { cfUrl, isCF } from './cf-image';

export interface TrustBadge {
  name: string;
  detail: string;
  url: string;
  image: string;
}

export const DEFAULT_TRUST_BADGES: TrustBadge[] = [
  {
    name: 'Charity Navigator',
    detail: '4-Star Rating',
    url: 'https://www.charitynavigator.org/ein/454773997',
    image: '/charity-navigator-4-star-2026.png',
  },
  {
    name: 'Candid',
    detail: 'Platinum Transparency 2026',
    url: 'https://www.guidestar.org/profile/shared/2954b510-8c76-42e4-b589-7e826ca2cc47',
    image: '/candid-platinum-2026.svg',
  },
];

/** Normalized badge list from site settings, falling back to the defaults. */
export function getTrustBadges(settings: unknown): TrustBadge[] {
  const raw = (settings as { trustBadges?: unknown })?.trustBadges;
  const list = Array.isArray(raw) ? raw : DEFAULT_TRUST_BADGES;
  return list
    .map((b: Partial<TrustBadge>) => ({
      name: String(b?.name || '').trim(),
      detail: String(b?.detail || '').trim(),
      url: String(b?.url || '').trim(),
      image: String(b?.image || '').trim(),
    }))
    .filter(b => b.name);
}

/** "Charity Navigator 4-Star Rating" */
export const badgeTitle = (b: TrustBadge) => [b.name, b.detail].filter(Boolean).join(' ');

/** src + 1x/2x/3x srcset for a badge rendered `px` CSS pixels square. */
export function badgeImage(b: TrustBadge, px: number): { src: string; srcset?: string } {
  if (!b.image) return { src: '' };
  if (!isCF(b.image)) return { src: b.image };
  const at = (n: number) => cfUrl(b.image, { w: px * n, h: px * n, fit: 'contain' });
  return { src: at(2), srcset: `${at(1)} 1x, ${at(2)} 2x, ${at(3)} 3x` };
}
