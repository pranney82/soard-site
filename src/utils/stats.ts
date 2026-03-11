/**
 * Auto-computed site stats from content collections.
 * Every number derived from actual data — no manual overrides.
 */
import { getCollection } from 'astro:content';

export interface SiteStats {
  /** Total individual children served (accounts for sibling profiles via childCount) */
  totalKids: number;
  /** Total rooms built (sum of roomCount across all kid profiles) */
  totalRooms: number;
  /** Community projects count */
  communityProjects: number;
  /** Years of impact since 2012 */
  years: number;
}

let _cached: SiteStats | null = null;

export async function getSiteStats(): Promise<SiteStats> {
  if (_cached) return _cached;

  const kids = await getCollection('kids');
  const community = await getCollection('community');

  const totalKids = kids.reduce((sum, k) => sum + (k.data.childCount || 1), 0);
  const totalRooms = kids.reduce((sum, k) => sum + (k.data.roomCount || 1), 0);

  _cached = {
    totalKids,
    totalRooms,
    communityProjects: community.length,
    years: new Date().getFullYear() - 2012,
  };

  return _cached;
}
