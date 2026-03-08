import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { generateOgImage } from '../../../utils/og';

export const getStaticPaths: GetStaticPaths = async () => {
  const articles = await getCollection('articles');
  return articles.map(article => ({
    params: { slug: article.data.slug },
    props: { article: article.data },
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const { article } = props as { article: any };
  
  const png = await generateOgImage({
    template: 'article',
    title: article.title,
    tag: article.tag,
    description: article.description,
  });

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
