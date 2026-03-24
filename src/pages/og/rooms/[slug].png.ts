import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { generateOgImage } from '../../../utils/og';

export const getStaticPaths: GetStaticPaths = async () => {
  const kids = await getCollection('kids');
  const featured = kids.filter(k => k.data.featured && k.data.caseStudy);
  return featured.map(entry => ({
    params: { slug: entry.data.slug },
    props: { kid: entry.data },
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const { kid } = props as { kid: any };
  const cs = kid.caseStudy;
  const title = cs?.projectTitle || `${kid.name}'s Room Makeover`;

  const png = await generateOgImage({
    template: 'kid',
    title: kid.name,
    age: kid.age,
    diagnosis: kid.diagnosis,
    roomTypes: kid.roomTypes,
    heroImage: kid.heroImage,
  });

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
