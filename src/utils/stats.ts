/**
 * Auto-computed site stats from content collections.
 * Every number derived from actual data — no manual overrides.
 */
import { getCollection } from 'astro:content';

export interface SiteStats {
  /** Total individual children served (accounts for sibling profiles via childCount) */
  totalKids: number;
  /** Total makeover projects (kid profile files + community projects) */
  totalProjects: number;
  /** Total room makeover profiles (kid JSON files) */
  totalRoomProfiles: number;
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

  // Sum childCount across all kid profiles (defaults to 1 for single-child profiles)
  const totalKids = kids.reduce((sum, k) => sum + (k.data.childCount || 1), 0);

  const currentYear = new Date().getFullYear();

  _cached = {
    totalKids,
    totalRoomProfiles: kids.length,
    totalProjects: kids.length + community.length,
    communityProjects: community.length,
    years: currentYear - 2012,
  };

  return _cached;
}
