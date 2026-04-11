/**
 * schema.ts — Reusable JSON-LD structured data builders
 * 
 * Top 1% SEO: Every page gets rich structured data.
 * These helpers ensure consistent, valid schema.org markup
 * across the entire site.
 */

import { cfAbsolute } from './cf-image';

const SITE_URL = 'https://sunshineonaranneyday.com';
const ORG_NAME = 'Sunshine on a Ranney Day';
const ORG_SHORT = 'SOARD';

/**
 * Base Organization schema — included on EVERY page
 * as part of a @graph array so Google sees the entity everywhere.
 */
export function getOrgSchema() {
  return {
    "@type": "NonprofitOrganization",
    "@id": `${SITE_URL}/#organization`,
    "name": ORG_NAME,
    "alternateName": ORG_SHORT,
    "url": SITE_URL,
    "logo": {
      "@type": "ImageObject",
      "@id": `${SITE_URL}/#logo`,
      "url": `${SITE_URL}/icon-512.png`,
      "width": 512,
      "height": 512,
      "caption": ORG_NAME
    },
    "image": { "@id": `${SITE_URL}/#logo` },
    "description": "A 501(c)(3) nonprofit creating life-changing home makeovers — dream bedrooms, accessible bathrooms, and therapy rooms — for children with special needs in the greater Atlanta area, all at no cost to families.",
    "foundingDate": "2012",
    "taxID": "45-4773997",
    "nonprofitStatus": "Nonprofit501c3",
    "areaServed": {
      "@type": "GeoCircle",
      "geoMidpoint": {
        "@type": "GeoCoordinates",
        "latitude": 33.749,
        "longitude": -84.388
      },
      "geoRadius": "80467"
    },
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "250 Hembree Park Drive, Suite 106",
      "addressLocality": "Roswell",
      "addressRegion": "GA",
      "postalCode": "30076",
      "addressCountry": "US"
    },
    "telephone": "+17709902434",
    "email": "info@soardcharity.com",
    "sameAs": [
      "https://www.facebook.com/sunshineonaranneyday",
      "https://www.instagram.com/sunshineonaranneyday",
      "https://www.guidestar.org/profile/shared/2954b510-8c76-42e4-b589-7e826ca2cc47"
    ],
    "knowsAbout": [
      "accessible home design",
      "wheelchair-accessible bathrooms",
      "sensory rooms for children",
      "home modifications for disabilities",
      "pediatric therapy room design",
      "dream bedroom makeovers",
      "nonprofit home renovation"
    ],
    "slogan": "Dreams Built Here"
  };
}

/**
 * WebSite schema — homepage only
 * Enables sitelinks search box in Google
 */
export function getWebSiteSchema() {
  return {
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    "url": SITE_URL,
    "name": ORG_NAME,
    "description": "Creating life-changing home makeovers for children with special needs in the greater Atlanta area.",
    "publisher": { "@id": `${SITE_URL}/#organization` },
    "potentialAction": {
      "@type": "SearchAction",
      "target": {
        "@type": "EntryPoint",
        "urlTemplate": `${SITE_URL}/kids/?q={search_term_string}`
      },
      "query-input": "required name=search_term_string"
    },
    "inLanguage": "en-US"
  };
}

/**
 * WebPage schema — every page
 */
export function getWebPageSchema(opts: {
  url: string;
  title: string;
  description: string;
  datePublished?: string;
  dateModified?: string;
  breadcrumbs?: { name: string; url: string }[];
}) {
  const page: Record<string, any> = {
    "@type": "WebPage",
    "@id": `${opts.url}#webpage`,
    "url": opts.url,
    "name": opts.title,
    "description": opts.description,
    "isPartOf": { "@id": `${SITE_URL}/#website` },
    "about": { "@id": `${SITE_URL}/#organization` },
    "inLanguage": "en-US"
  };
  if (opts.datePublished) page.datePublished = opts.datePublished;
  if (opts.dateModified) page.dateModified = opts.dateModified;
  if (opts.breadcrumbs) {
    page.breadcrumb = { "@id": `${opts.url}#breadcrumb` };
  }
  return page;
}

/**
 * BreadcrumbList schema
 */
export function getBreadcrumbSchema(
  items: { name: string; url: string }[],
  pageUrl: string
) {
  return {
    "@type": "BreadcrumbList",
    "@id": `${pageUrl}#breadcrumb`,
    "itemListElement": items.map((item, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": item.name,
      "item": item.url
    }))
  };
}

/**
 * DonateAction schema — donate page
 */
export function getDonateSchema() {
  return {
    "@type": "DonateAction",
    "@id": `${SITE_URL}/donate/#action`,
    "name": "Donate to Sunshine on a Ranney Day",
    "description": "Every dollar builds accessible bathrooms, dream bedrooms, and therapy rooms for children with special needs — all at no cost to families.",
    "recipient": { "@id": `${SITE_URL}/#organization` },
    "target": {
      "@type": "EntryPoint",
      "urlTemplate": `${SITE_URL}/donate/`,
      "actionPlatform": [
        "http://schema.org/DesktopWebPlatform",
        "http://schema.org/MobileWebPlatform"
      ]
    }
  };
}

/**
 * Kid profile schema — Article + Person + VideoObject + ImageGallery
 */
export function getKidProfileSchema(kid: {
  name: string;
  slug: string;
  age?: number;
  diagnosis?: string;
  bio?: string;
  heroImage?: string;
  metaDescription?: string;
  roomTypes?: string[];
  year?: number;
  videoUrl?: string;
  streamVideoId?: string;
  photos?: { url: string; alt?: string }[];
  photographer?: string;
  status?: string;
}) {
  const url = `${SITE_URL}/kids/${kid.slug}/`;
  const schemas: Record<string, any>[] = [];

  // Person schema for the child
  const person: Record<string, any> = {
    "@type": "Person",
    "@id": `${url}#person`,
    "name": kid.name,
    ...(kid.heroImage ? { "image": cfAbsolute(kid.heroImage) } : {}),
  };
  if (kid.age) person.age = Array.isArray(kid.age) ? kid.age.join(', ') : kid.age;
  if (kid.diagnosis) {
    person.health = {
      "@type": "MedicalCondition",
      "name": kid.diagnosis,
    };
  }
  schemas.push(person);

  // Article schema for the profile page
  schemas.push({
    "@type": "Article",
    "@id": `${url}#article`,
    "headline": `${kid.name}'s Story — Sunshine on a Ranney Day`,
    "description": kid.metaDescription || `Meet ${kid.name}${kid.diagnosis ? `, diagnosed with ${kid.diagnosis}` : ''} — learn how Sunshine on a Ranney Day transformed their space${kid.roomTypes?.length ? ` with ${/^[aeiou]/i.test(kid.roomTypes[0]) ? 'an' : 'a'} ${kid.roomTypes.join(' & ')}` : ''}.`,
    "url": url,
    "isPartOf": { "@id": `${SITE_URL}/#website` },
    "publisher": { "@id": `${SITE_URL}/#organization` },
    "mainEntityOfPage": { "@id": `${url}#webpage` },
    "mainEntity": { "@id": `${url}#person` },
    ...(kid.heroImage ? { "image": cfAbsolute(kid.heroImage) } : {}),
    ...(kid.year ? { "datePublished": `${kid.year}-01-01` } : {}),
    "inLanguage": "en-US",
    "about": [
      ...(kid.roomTypes || []).map(rt => ({
        "@type": "Thing",
        "name": rt
      })),
      {
        "@type": "Thing",
        "name": "children with special needs"
      }
    ]
  });

  // VideoObject schema — prefer CF Stream, fallback to YouTube
  if (kid.streamVideoId || kid.videoUrl) {
    const ytMatch = kid.videoUrl?.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
    const ytId = ytMatch ? ytMatch[1] : null;

    if (kid.streamVideoId) {
      const STREAM = 'customer-cuav5h47lgfe96ql.cloudflarestream.com';
      schemas.push({
        "@type": "VideoObject",
        "@id": `${url}#video`,
        "name": `${kid.name}'s Story — Sunshine on a Ranney Day`,
        "description": kid.metaDescription || `Watch how Sunshine on a Ranney Day transformed ${kid.name}'s space.`,
        "thumbnailUrl": `https://${STREAM}/${kid.streamVideoId}/thumbnails/thumbnail.jpg?width=1280&height=720`,
        "uploadDate": kid.year ? `${kid.year}-01-01` : undefined,
        "contentUrl": `https://${STREAM}/${kid.streamVideoId}/watch`,
        "embedUrl": `https://iframe.videodelivery.net/${kid.streamVideoId}`,
        "publisher": { "@id": `${SITE_URL}/#organization` },
      });
    } else if (ytId) {
      schemas.push({
        "@type": "VideoObject",
        "@id": `${url}#video`,
        "name": `${kid.name}'s Story — Sunshine on a Ranney Day`,
        "description": kid.metaDescription || `Watch how Sunshine on a Ranney Day transformed ${kid.name}'s space.`,
        "thumbnailUrl": `https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`,
        "uploadDate": kid.year ? `${kid.year}-01-01` : undefined,
        "contentUrl": `https://www.youtube.com/watch?v=${ytId}`,
        "embedUrl": `https://www.youtube-nocookie.com/embed/${ytId}`,
        "publisher": { "@id": `${SITE_URL}/#organization` },
      });
    }
  }

  // ImageGallery schema if photos exist
  if (kid.photos && kid.photos.length > 1) {
    schemas.push({
      "@type": "ImageGallery",
      "@id": `${url}#gallery`,
      "name": `${kid.name}'s Room Transformation — Photo Gallery`,
      "description": `Photos of ${kid.name}'s ${kid.roomTypes?.join(' & ') || 'room'} transformation by Sunshine on a Ranney Day.`,
      "url": url,
      "about": { "@id": `${url}#person` },
      ...(kid.photographer ? { "creator": { "@type": "Person", "name": kid.photographer } } : {}),
      "image": kid.photos.slice(0, 20).map((photo, i) => ({
        "@type": "ImageObject",
        "url": cfAbsolute(photo.url),
        "caption": photo.alt || `${kid.name}'s room transformation photo ${i + 1}`,
      })),
    });
  }

  return schemas;
}

/**
 * Reusable VideoObject schema
 * Works with both Cloudflare Stream and YouTube embeds.
 */
export function getVideoSchema(opts: {
  name: string;
  description: string;
  pageUrl: string;
  streamVideoId?: string;
  videoUrl?: string;
  uploadDate?: string;
}) {
  const STREAM = 'customer-cuav5h47lgfe96ql.cloudflarestream.com';

  if (opts.streamVideoId) {
    return {
      "@type": "VideoObject",
      "@id": `${opts.pageUrl}#video`,
      "name": opts.name,
      "description": opts.description,
      "thumbnailUrl": `https://${STREAM}/${opts.streamVideoId}/thumbnails/thumbnail.jpg?width=1280&height=720`,
      "uploadDate": opts.uploadDate,
      "contentUrl": `https://${STREAM}/${opts.streamVideoId}/watch`,
      "embedUrl": `https://iframe.videodelivery.net/${opts.streamVideoId}`,
      "publisher": { "@id": `${SITE_URL}/#organization` },
    };
  }

  // YouTube fallback
  const ytMatch = opts.videoUrl?.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  if (ytMatch) {
    const ytId = ytMatch[1];
    return {
      "@type": "VideoObject",
      "@id": `${opts.pageUrl}#video`,
      "name": opts.name,
      "description": opts.description,
      "thumbnailUrl": `https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`,
      "uploadDate": opts.uploadDate,
      "contentUrl": `https://www.youtube.com/watch?v=${ytId}`,
      "embedUrl": `https://www.youtube-nocookie.com/embed/${ytId}`,
      "publisher": { "@id": `${SITE_URL}/#organization` },
    };
  }

  return null;
}

/**
 * FAQPage schema
 */
export function getFAQSchema(items: { question: string; answer: string }[]) {
  return {
    "@type": "FAQPage",
    "mainEntity": items.map(item => ({
      "@type": "Question",
      "name": item.question,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": item.answer.replace(/<[^>]+>/g, '')
      }
    }))
  };
}

/**
 * SiteNavigationElement schema — homepage only
 * Helps Google understand the site's primary navigation for sitelinks.
 */
export function getSiteNavigationSchema() {
  const navItems = [
    { name: 'Our Story', url: `${SITE_URL}/about/` },
    { name: 'Meet the Kids', url: `${SITE_URL}/kids/` },
    { name: 'Community Projects', url: `${SITE_URL}/community/` },
    { name: 'Donate', url: `${SITE_URL}/donate/` },
    { name: 'Apply', url: `${SITE_URL}/apply/` },
    { name: 'Events', url: `${SITE_URL}/events/` },
    { name: 'Partners', url: `${SITE_URL}/partners/` },
    { name: 'Resources', url: `${SITE_URL}/resources/` },
    { name: 'FAQs', url: `${SITE_URL}/faq/` },
  ];
  return navItems.map((item, i) => ({
    "@type": "SiteNavigationElement",
    "position": i + 1,
    "name": item.name,
    "url": item.url,
  }));
}

/**
 * Master graph builder — wraps all schemas into a single @graph
 * This is the Google-recommended approach for complex pages.
 */
export function buildSchemaGraph(...schemas: (Record<string, any> | Record<string, any>[])[]) {
  const graph: Record<string, any>[] = [];
  for (const s of schemas) {
    if (Array.isArray(s)) {
      graph.push(...s);
    } else {
      graph.push(s);
    }
  }
  return {
    "@context": "https://schema.org",
    "@graph": graph
  };
}
