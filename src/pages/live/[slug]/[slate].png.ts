/**
 * /live/<kid>/starting-soon.png and /live/<kid>/starting-soon-portrait.png
 * "Starting soon" slate for the reveal stream. The crew adds it as a
 * full-frame image layer in Larix, streams it while things warm up, and
 * switches the layer off when the reveal begins. See docs/live-runbook.md.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { getPublishedKids } from '../../../utils/collections';
import { generateSlateImage } from '../../../utils/og';

const SLATES = { 'starting-soon': 'landscape', 'starting-soon-portrait': 'portrait' } as const;

export const getStaticPaths: GetStaticPaths = async () => {
  const kids = await getPublishedKids();
  return kids.flatMap(kid => Object.keys(SLATES).map(slate => ({
    params: { slug: kid.data.slug, slate },
    props: { kid: kid.data, orientation: SLATES[slate as keyof typeof SLATES] },
  })));
};

export const GET: APIRoute = async ({ props }) => {
  const { kid, orientation } = props as { kid: any; orientation: 'landscape' | 'portrait' };
  const png = await generateSlateImage({ name: kid.name, slug: kid.slug, heroImage: kid.heroImage, orientation });
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
  });
};
