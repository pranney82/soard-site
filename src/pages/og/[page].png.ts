import type { APIRoute, GetStaticPaths } from 'astro';
import { generateOgImage } from '../../utils/og';
import { getSiteStats } from '../../utils/stats';
import { getPublishedKids } from '../../utils/collections';
import siteSettings from '../../content/site/settings.json';
import ourStory from '../../content/site/our-story.json';

/**
 * Static page OG image definitions.
 * Every page uses the actual hero/primary image from that page.
 * Pages with no images fall back to the site hero kid photo.
 */
const getPages = async () => {
  const stats = await getSiteStats();
  const s = siteSettings as any;

  // ── Images pulled from the actual pages ──
  // Home: hero kid photo (index.astro line 78)
  const homeHero = s.heroKidPhotoId || 'kids/braxton/photo-18';
  // Donate: donate hero (donate.astro line 33)
  const donateHero = s.donatePhotos?.hero || 'kids/oakley/hero';
  // About/Our Story: founders photo (about/index.astro line 26, from our-story.json)
  const foundersPhoto = (ourStory as any).images?.founder || 'about/founders-reunion-2026';
  // Leadership: founders photo (same org page, no unique hero)
  // Financials: founders photo (about sub-page, no images)
  // Kids index: hero kid
  // Rooms: first featured kid's hero image
  const allKids = await getPublishedKids();
  const firstFeatured = allKids.find(k => k.data.featured && k.data.caseStudy && k.data.heroImage);
  const roomsHero = firstFeatured?.data.heroImage || s.sectionPhotos?.roomBedroom || 'kids/bryce/photo-22';
  // Before & After: same as rooms
  // Community index: community hero (community/index.astro line 45)
  const communityHero = s.communityPhotos?.hero || 'community/summit-counseling-center/hero';
  // Partners: partner photo (partners/index.astro line 37)
  const partnerPhoto = s.partnerPhoto || 'kids/bryce/photo-22';
  // Construction/Design: process photo (used on those pages)
  const processPhoto = s.sectionPhotos?.process || 'kids/oakley/photo-15';
  // Apply: apply hero (apply.astro line 41)
  const applyHero = s.applyPhotos?.hero || 'kids/griffin/hero';
  // Ways to Give: ways-to-give hero (ways-to-give.astro line 34)
  const waysToGiveHero = s.waysToGivePhotos?.hero || 'kids/summer/hero';
  // Events index: fallback photo (events/index.astro line 132)
  const eventsHero = s.sectionPhotos?.missionMain || 'kids/emery/photo-17';
  // Sunny & Ranney: storefront photo (sunny-and-ranney.astro line 18)
  const sunnyStore = 'about/sunny-ranney-storefront';
  return [
  { slug: 'home', title: 'Dreams Built Here', subtitle: 'Creating life-changing home makeovers for children with special needs — at no cost to families.', heroImage: homeHero },
  { slug: 'donate', title: 'Help Build a Brighter Home', subtitle: 'Every dollar builds accessible bathrooms, dream bedrooms, and therapy rooms for children with special needs.', heroImage: donateHero },
  { slug: 'about', title: 'Our Story', subtitle: 'Transforming lives since 2012 in the greater Atlanta area.', heroImage: foundersPhoto },
  { slug: 'leadership', title: 'Leadership', subtitle: 'The team and board behind Sunshine on a Ranney Day.', heroImage: foundersPhoto },
  { slug: 'financials', title: 'Financials', subtitle: 'Transparency you can trust. 990 filings and annual reports.', heroImage: foundersPhoto },
  { slug: 'kids', title: 'Meet the Kids', subtitle: `${stats.totalKids}+ children whose lives have been transformed by a room makeover.`, heroImage: homeHero },
  { slug: 'rooms', title: 'Featured Rooms', subtitle: 'Dream bedrooms, accessible bathrooms, and therapy rooms we\'ve built.', heroImage: roomsHero },
  { slug: 'before-after', title: 'Before & After', subtitle: 'See the dramatic transformations in our room makeovers.', heroImage: roomsHero },
  { slug: 'community', title: 'Community Projects', subtitle: 'Large-scale projects serving thousands of children with special needs.', heroImage: communityHero },
  { slug: 'partners', title: 'Our Partners', subtitle: 'The companies and organizations that make our work possible.', heroImage: partnerPhoto },
  { slug: 'construction', title: 'Construction Partners', subtitle: 'The builders who donate their skills to transform children\'s homes.', heroImage: processPhoto },
  { slug: 'design', title: 'Design Partners', subtitle: 'The designers who create beautiful, functional spaces for our kids.', heroImage: processPhoto },
  { slug: 'apply', title: 'Apply for a Makeover', subtitle: 'Families of children with special needs can apply for a no-cost home renovation.', heroImage: applyHero },
  { slug: 'faq', title: 'Frequently Asked Questions', subtitle: 'Everything you need to know about donating, volunteering, and applying.', heroImage: homeHero },
  { slug: 'resources', title: 'Resources', subtitle: 'Guides, tools, and information for families of children with special needs.', heroImage: homeHero },
  { slug: 'publicity', title: 'Publicity', subtitle: 'Media coverage and press mentions of Sunshine on a Ranney Day.', heroImage: 'press-braves-community-heroes' },
  { slug: 'ways-to-give', title: 'Ways to Give', subtitle: 'Donate, volunteer, or partner with us to transform children\'s lives.', heroImage: waysToGiveHero },
  { slug: 'privacy-policy', title: 'Privacy Policy', subtitle: 'How we protect your information.', heroImage: homeHero },
  { slug: 'terms', title: 'Terms of Service', subtitle: 'Usage terms for sunshineonaranneyday.com.', heroImage: homeHero },
  { slug: 'branding', title: 'Brand Guidelines', subtitle: 'Sunshine on a Ranney Day brand assets and usage.', heroImage: homeHero },
  { slug: 'events', title: 'Events', subtitle: 'Fundraisers, tournaments, and community gatherings supporting children with special needs.', heroImage: eventsHero },
  { slug: 'golf', title: 'Sunshine on a Ranney Fairway', subtitle: 'Annual charity golf tournament funding dream room makeovers.', heroImage: 'golf-logo-dark', template: 'golf' as const, golfDate: 'Monday, May 18th, 2026', golfLocation: 'Indian Hills Country Club · Marietta, GA' },
  { slug: 'sunny-and-ranney', title: 'Sunny & Ranney', subtitle: 'Meet the mascots of Sunshine on a Ranney Day.', heroImage: sunnyStore },
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
  const { page } = props as { page: { slug: string; title: string; subtitle?: string; heroImage?: string; template?: string; golfDate?: string; golfLocation?: string } };

  const png = await generateOgImage({
    template: (page.template || 'default') as any,
    title: page.title,
    subtitle: page.subtitle,
    heroImage: page.heroImage,
    golfDate: page.golfDate,
    golfLocation: page.golfLocation,
  });

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
