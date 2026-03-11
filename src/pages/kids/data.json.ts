/**
 * /kids/data.json — Static JSON manifest of all kid cards
 *
 * Built at compile time by Astro. The /kids/ page SSRs only the first
 * batch of cards and fetches this file for "Show More" / search-all.
 * Served from Cloudflare Pages edge cache (immutable after deploy).
 */
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async () => {
  const allKids = await getCollection('kids');
  const kids = allKids
    .sort((a, b) => (b.data.year || 0) - (a.data.year || 0));

  const cards = kids.map(kid => ({
    slug: kid.data.slug,
    name: kid.data.name,
    year: kid.data.year || null,
    diagnosis: kid.data.diagnosis || null,
    status: kid.data.status || 'completed',
    roomTypes: kid.data.roomTypes || [],
    heroImage: kid.data.heroImage || null,
  }));

  return new Response(JSON.stringify(cards), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
};
