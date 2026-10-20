import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { generateOgImage } from '../../../utils/og';
import { CF_HASH, cfId } from '../../../utils/cf-image';
import { normalizePerson, hasProfile, portraitTransform, profileWords } from '../../../utils/team';
import type { PersonData } from '../../../utils/team';

// One share image per Leadership profile (the same people who get a page)
export const getStaticPaths: GetStaticPaths = async () => {
  const team = await getCollection('team');
  return team
    .map((t) => ({ id: t.id, person: normalizePerson(t.data as PersonData) }))
    .filter((t) => hasProfile(t.person))
    .map((t) => ({ params: { slug: t.id }, props: { person: t.person } }));
};

export const GET: APIRoute = async ({ props }) => {
  const { person: p } = props as { person: ReturnType<typeof normalizePerson> };
  // imagedelivery.net directly: the /cdn-cgi/ proxy isn't reachable at build time
  const id = cfId(p.photo || '');
  const heroImage = id ? `https://imagedelivery.net/${CF_HASH}/${id}/${portraitTransform(p, 800)},f=jpeg` : null;
  const role = p.role === 'founder' ? (p.title.replace(/Co-Founder\/?/i, '').trim() || p.title) : p.title;
  const png = await generateOgImage({
    template: 'person',
    title: p.name,
    eyebrow: profileWords(p).eyebrow,
    subtitle: role,
    organization: p.organization || undefined,
    heroImage,
  });
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
};
