import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { generateOgImage } from '../../../utils/og';

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

export const getStaticPaths: GetStaticPaths = async () => {
  const events = await getCollection('events');
  return events
    .filter(e => e.data.body || e.data.photos.length > 0)
    .map(e => ({
      params: { slug: e.data.slug },
      props: { event: e.data },
    }));
};

export const GET: APIRoute = async ({ props }) => {
  const { event } = props as { event: any };

  const png = await generateOgImage({
    template: 'event',
    title: event.title,
    heroImage: event.image || null,
    category: event.category,
    eventDate: event.date ? fmtDate(event.date) : undefined,
    eventLocation: event.location,
  });

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
