import type { APIRoute, GetStaticPaths } from 'astro';
import { generateOgImage } from '../../utils/og';

/**
 * Static page OG image definitions.
 * Add new pages here when creating them.
 */
const pages = [
  { slug: 'home', title: 'Dreams Built Here', subtitle: 'Creating life-changing home makeovers for children with special needs — at no cost to families.' },
  { slug: 'donate', title: 'Help Build a Brighter Home', subtitle: 'Every dollar builds accessible bathrooms, dream bedrooms, and therapy rooms for children with special needs.' },
  { slug: 'about', title: 'Our Story', subtitle: 'Transforming lives since 2012 in the greater Atlanta area.' },
  { slug: 'leadership', title: 'Leadership', subtitle: 'The team and board behind Sunshine on a Ranney Day.' },
  { slug: 'financials', title: 'Financials', subtitle: 'Transparency you can trust. 990 filings and annual reports.' },
  { slug: 'kids', title: 'Meet the Kids', subtitle: '132+ children whose lives have been transformed by a room makeover.' },
  { slug: 'rooms', title: 'Featured Rooms', subtitle: 'Dream bedrooms, accessible bathrooms, and therapy rooms we\'ve built.' },
  { slug: 'before-after', title: 'Before & After', subtitle: 'See the dramatic transformations in our room makeovers.' },
  { slug: 'community', title: 'Community Projects', subtitle: 'Large-scale projects serving thousands of children with special needs.' },
  { slug: 'partners', title: 'Our Partners', subtitle: 'The companies and organizations that make our work possible.' },
  { slug: 'construction', title: 'Construction Partners', subtitle: 'The builders who donate their skills to transform children\'s homes.' },
  { slug: 'design', title: 'Design Partners', subtitle: 'The designers who create beautiful, functional spaces for our kids.' },
  { slug: 'apply', title: 'Apply for a Makeover', subtitle: 'Families of children with special needs can apply for a no-cost home renovation.' },
  { slug: 'faq', title: 'Frequently Asked Questions', subtitle: 'Everything you need to know about donating, volunteering, and applying.' },
  { slug: 'resources', title: 'Resources', subtitle: 'Guides, tools, and information for families of children with special needs.' },
  { slug: 'publicity', title: 'Publicity', subtitle: 'Media coverage and press mentions of Sunshine on a Ranney Day.' },
  { slug: 'privacy-policy', title: 'Privacy Policy', subtitle: undefined },
  { slug: 'terms', title: 'Terms of Service', subtitle: undefined },
  { slug: 'branding', title: 'Brand Guidelines', subtitle: 'Sunshine on a Ranney Day brand assets and usage.' },
];

export const getStaticPaths: GetStaticPaths = async () => {
  return pages.map(p => ({
    params: { page: p.slug },
    props: { page: p },
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const { page } = props as { page: typeof pages[0] };
  
  const png = await generateOgImage({
    template: 'default',
    title: page.title,
    subtitle: page.subtitle,
  });

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
