import type { APIRoute, GetStaticPaths } from 'astro';
import { generateOgImage } from '../../../utils/og';
import { getPublishedCommunity } from '../../../utils/collections';
import { mainPhotoOf } from '../../../utils/community';
import { cfId } from '../../../utils/cf-image';

export const getStaticPaths: GetStaticPaths = async () => {
  const allProjects = await getPublishedCommunity();
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
    // The page's main photo, as an image id so the crop follows its focal point
    heroImage: cfId(mainPhotoOf(project) || project.photos?.[0]?.url || '') || null,
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
