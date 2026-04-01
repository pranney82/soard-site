import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { generateOgImage } from '../../../utils/og';

export const getStaticPaths: GetStaticPaths = async () => {
  const allProjects = await getCollection('community');
  return allProjects
    .filter(p => p.data.story)
    .map(p => ({
      params: { slug: p.data.slug },
      props: { project: p.data },
    }));
};

export const GET: APIRoute = async ({ props }) => {
  const { project } = props as { project: any };

  const png = await generateOgImage({
    template: 'community',
    title: project.name,
    heroImage: project.imageId || project.photos?.[0]?.cfImageId || null,
    year: project.year,
    impact: project.impact,
    impactLabel: project.impactLabel,
  });

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
