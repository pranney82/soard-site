import { getCollection } from 'astro:content';
import { getPublishedKids } from '../../utils/collections';

export async function GET() {
  const allKids = await getPublishedKids();

  const kids = allKids
    .filter(k => k.data.status === 'completed' && k.data.heroImage)
    .sort((a, b) => (b.data.year || 0) - (a.data.year || 0))
    .map(k => ({
      name: k.data.name as string,
      slug: k.data.slug as string,
      year: k.data.year as number | null,
      diagnosis: k.data.diagnosis as string | null,
      roomTypes: (k.data.roomTypes as string[]) || [],
      // Strip /public suffix so S&R can append its own CF Image transforms
      imageUrl: (k.data.heroImage as string).replace(/\/public$/, ''),
      blurb: (k.data.shortDescription as string | null)
        || truncate(k.data.bio as string | null, 160),
    }));

  return new Response(JSON.stringify(kids), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://www.sunnyandranney.com',
    },
  });
}

function truncate(text: string | null, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}
