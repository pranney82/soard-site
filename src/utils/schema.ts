/**
 * schema.ts — Reusable JSON-LD structured data builders
 * 
 * Top 1% SEO: Every page gets rich structured data.
 * These helpers ensure consistent, valid schema.org markup
 * across the entire site.
 */

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
 * Kid profile schema — Article + Person
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
}) {
  const url = `${SITE_URL}/kids/${kid.slug}/`;
  const schemas: Record<string, any>[] = [];

  // Article schema for the profile page
  schemas.push({
    "@type": "Article",
    "@id": `${url}#article`,
    "headline": `${kid.name}'s Story — Sunshine on a Ranney Day`,
    "description": kid.metaDescription || `Meet ${kid.name} — learn how SOARD is transforming their space.`,
    "url": url,
    "isPartOf": { "@id": `${SITE_URL}/#website` },
    "publisher": { "@id": `${SITE_URL}/#organization` },
    "mainEntityOfPage": { "@id": `${url}#webpage` },
    ...(kid.heroImage ? { "image": kid.heroImage } : {}),
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

  return schemas;
}

/**
 * ImageGallery schema — rooms/before-after page
 */
export function getImageGallerySchema(opts: {
  name: string;
  url: string;
  description: string;
  images: { url: string; caption?: string }[];
}) {
  return {
    "@type": "ImageGallery",
    "@id": `${opts.url}#gallery`,
    "name": opts.name,
    "description": opts.description,
    "url": opts.url,
    "about": { "@id": `${SITE_URL}/#organization` },
    "image": opts.images.map(img => ({
      "@type": "ImageObject",
      "url": img.url,
      ...(img.caption ? { "caption": img.caption } : {})
    }))
  };
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
 * Event schema
 */
export function getEventSchema(opts: {
  name: string;
  description: string;
  startDate: string;
  endDate?: string;
  url: string;
  location?: string;
  image?: string;
}) {
  return {
    "@type": "Event",
    "name": opts.name,
    "description": opts.description,
    "startDate": opts.startDate,
    ...(opts.endDate ? { "endDate": opts.endDate } : {}),
    "url": opts.url,
    "organizer": { "@id": `${SITE_URL}/#organization` },
    ...(opts.location ? {
      "location": {
        "@type": "Place",
        "name": opts.location
      }
    } : {}),
    ...(opts.image ? { "image": opts.image } : {}),
    "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode"
  };
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
