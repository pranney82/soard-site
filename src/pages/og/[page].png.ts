import type { APIRoute, GetStaticPaths } from 'astro';
import { generateOgImage } from '../../utils/og';
import { getSiteStats } from '../../utils/stats';
import siteSettings from '../../content/site/settings.json';

/**
 * Static page OG image definitions.
 * Each page gets a hero photo from site settings for the photo-backed OG style.
 * Falls back to text-only if no heroImage is set or the fetch fails at build time.
 */
const getPages = async () => {
  const stats = await getSiteStats();
  const s = siteSettings as any;

  // Reusable photo IDs from site settings
  const heroKid = s.heroKidPhotoId || 'kids/braxton/photo-18';
  const donateHero = s.donatePhotos?.hero || 'kids/oakley/hero';
  const storyPhoto = s.sectionPhotos?.storyPhoto || 'kids/zyah/hero';
  const missionPhoto = s.sectionPhotos?.missionMain || 'kids/emery/photo-17';
  const processPhoto = s.sectionPhotos?.process || 'kids/oakley/photo-15';
  const partnerPhoto = s.partnerPhoto || 'kids/bryce/photo-22';
  const applyHero = s.applyPhotos?.hero || 'kids/adrian/hero';
  const communityHero = s.communityPhotos?.hero || 'kids/camp-twin-lakes/hero';
  const waysToGiveHero = s.waysToGivePhotos?.hero || 'kids/oakley/photo-15';
  const roomBedroom = s.sectionPhotos?.roomBedroom || 'kids/bryce/photo-22';

  return [
  { slug: 'home', title: 'Dreams Built Here', subtitle: 'Creating life-changing home makeovers for children with special needs — at no cost to families.', heroImage: heroKid },
  { slug: 'donate', title: 'Help Build a Brighter Home', subtitle: 'Every dollar builds accessible bathrooms, dream bedrooms, and therapy rooms for children with special needs.', heroImage: donateHero },
  { slug: 'about', title: 'Our Story', subtitle: 'Transforming lives since 2012 in the greater Atlanta area.', heroImage: storyPhoto },
  { slug: 'leadership', title: 'Leadership', subtitle: 'The team and board behind Sunshine on a Ranney Day.', heroImage: missionPhoto },
  { slug: 'financials', title: 'Financials', subtitle: 'Transparency you can trust. 990 filings and annual reports.', heroImage: missionPhoto },
  { slug: 'kids', title: 'Meet the Kids', subtitle: `${stats.totalKids}+ children whose lives have been transformed by a room makeover.`, heroImage: heroKid },
  { slug: 'rooms', title: 'Featured Rooms', subtitle: 'Dream bedrooms, accessible bathrooms, and therapy rooms we\'ve built.', heroImage: roomBedroom },
  { slug: 'before-after', title: 'Before & After', subtitle: 'See the dramatic transformations in our room makeovers.', heroImage: roomBedroom },
  { slug: 'community', title: 'Community Projects', subtitle: 'Large-scale projects serving thousands of children with special needs.', heroImage: communityHero },
  { slug: 'partners', title: 'Our Partners', subtitle: 'The companies and organizations that make our work possible.', heroImage: partnerPhoto },
  { slug: 'construction', title: 'Construction Partners', subtitle: 'The builders who donate their skills to transform children\'s homes.', heroImage: processPhoto },
  { slug: 'design', title: 'Design Partners', subtitle: 'The designers who create beautiful, functional spaces for our kids.', heroImage: processPhoto },
  { slug: 'apply', title: 'Apply for a Makeover', subtitle: 'Families of children with special needs can apply for a no-cost home renovation.', heroImage: applyHero },
  { slug: 'faq', title: 'Frequently Asked Questions', subtitle: 'Everything you need to know about donating, volunteering, and applying.', heroImage: storyPhoto },
  { slug: 'resources', title: 'Resources', subtitle: 'Guides, tools, and information for families of children with special needs.', heroImage: storyPhoto },
  { slug: 'publicity', title: 'Publicity', subtitle: 'Media coverage and press mentions of Sunshine on a Ranney Day.', heroImage: heroKid },
  { slug: 'ways-to-give', title: 'Ways to Give', subtitle: 'Donate, volunteer, or partner with us to transform children\'s lives.', heroImage: waysToGiveHero },
  { slug: 'privacy-policy', title: 'Privacy Policy', subtitle: 'How we protect your information.', heroImage: heroKid },
  { slug: 'terms', title: 'Terms of Service', subtitle: 'Usage terms for sunshineonaranneyday.com.', heroImage: heroKid },
  { slug: 'branding', title: 'Brand Guidelines', subtitle: 'Sunshine on a Ranney Day brand assets and usage.', heroImage: heroKid },
  { slug: 'events', title: 'Events', subtitle: 'Fundraisers, tournaments, and community gatherings supporting children with special needs.', heroImage: waysToGiveHero },
  { slug: 'golf', title: 'Sunshine on a Ranney Fairway', subtitle: 'Annual charity golf tournament funding dream room makeovers.', heroImage: processPhoto },
  { slug: 'sunny-and-ranney', title: 'Sunny & Ranney', subtitle: 'Meet the mascots of Sunshine on a Ranney Day.', heroImage: heroKid },
  ];
};

export const getStaticPaths: GetStaticPaths = async () => {
  const pages = await getPages();
  return pages.map(p => ({
    params: { page: p.slug },
    props: { page: p },
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const { page } = props as { page: { slug: string; title: string; subtitle?: string; heroImage?: string } };

  const png = await generateOgImage({
    template: 'default',
    title: page.title,
    subtitle: page.subtitle,
    heroImage: page.heroImage,
  });

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
