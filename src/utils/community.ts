/**
 * Community project rules the pages share. Mirrors public/admin/community-shared.js
 * (reachedStat, reachedCount, mainPhotoOf), which the admin and its tests use:
 * change both together.
 */
type Stat = { value?: string | null; label?: string | null; reached?: boolean };
type Project = { stats?: Stat[]; impact?: string | null; impactLabel?: string | null; heroImage?: string | null; imageId?: string | null };

/** The stats the page's hero shows: the list, else the single impact pair */
export function heroStats(p: Project): Stat[] {
  return (p.stats?.length ? p.stats : [{ value: p.impact, label: p.impactLabel }]).slice(0, 3);
}

/**
 * The stat added to "children reached through partnerships": the one marked
 * reached in the admin; none when every stat is marked false; else the first.
 */
export function reachedStat(p: Project): Stat | null {
  const stats = heroStats(p);
  const marked = stats.find((s) => s?.reached === true);
  if (marked) return marked;
  if (stats.some((s) => s?.reached === false)) return null;
  return stats[0]?.value ? stats[0] : null;
}

/** Its number: "10,000" → 10000, "200+" → 200 */
export function reachedCount(p: Project): number {
  const n = parseInt(String(reachedStat(p)?.value ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** The photo at the top of the page and on the card (the admin keeps imageId in step with it) */
export function mainPhotoOf(p: Project): string {
  return p.heroImage || p.imageId || '';
}
