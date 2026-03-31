/**
 * Auto-computed site stats from content collections.
 * Every number derived from actual data — no manual overrides.
 */
import { getCollection } from 'astro:content';
import { getPublishedKids } from './collections';

export interface SiteStats {
  /** Total individual children served (accounts for sibling profiles via childCount) */
  totalKids: number;
  /** Total rooms built (sum of roomCount across all kid profiles) */
  totalRooms: number;
  /** Count of rooms by type (e.g. "Dream Bedroom" → 128) */
  roomsByType: Record<string, number>;
  /** Community projects count */
  communityProjects: number;
  /** Total lives impacted across all community projects (sum of impact fields) */
  livesImpacted: number;
  /** Years of impact since 2012 */
  years: number;
}

let _cached: SiteStats | null = null;

export async function getSiteStats(): Promise<SiteStats> {
  if (_cached) return _cached;

  const kids = await getPublishedKids();
  const community = await getCollection('community');

  const totalKids = kids.reduce((sum, k) => sum + (k.data.childCount || 1), 0);
  const totalRooms = kids.reduce((sum, k) => sum + (k.data.roomCount || 1), 0);
  const roomsByType: Record<string, number> = {};
  for (const k of kids) {
    for (const rt of k.data.roomTypes || []) {
      roomsByType[rt] = (roomsByType[rt] || 0) + 1;
    }
  }
  const livesImpacted = community.reduce((sum, c) => {
    const num = parseInt(String(c.data.impact).replace(/[^0-9]/g, ''), 10);
    return sum + (isNaN(num) ? 0 : num);
  }, 0);

  _cached = {
    totalKids,
    totalRooms,
    roomsByType,
    communityProjects: community.length,
    livesImpacted,
    years: new Date().getFullYear() - 2012,
  };

  return _cached;
}
