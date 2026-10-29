import { defineCollection, z } from 'astro:content';
import { isWebLink, scriptLinks, linkScheme } from '../../functions/api/_collections.js';

// Every link a page renders: an http(s) address, a path on this site or an
// image ID, never javascript:, data: or any other scheme (the same rule
// save-content and the press monitor apply; functions/api/_collections.js).
// One that slips into D1 anyway is left out of the page, with a warning in
// the build log, rather than stopping every deploy until someone fixes it.
const link = () => z.preprocess((v) => {
  if (typeof v !== 'string' || isWebLink(v)) return v;
  console.warn(`  ⚠ content: left out a link that isn't a web address: ${JSON.stringify(v.slice(0, 60))}`);
  return '';
}, z.string().refine(isWebLink, (v) => ({ message: `must be an http(s) address or a path on this site, not ${linkScheme(v)}:` })));

const kids = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    age: z.union([z.number(), z.array(z.number())]).nullable(),
    diagnosis: z.string().nullable(),
    roomTypes: z.array(z.string()).nullable(),
    year: z.number().nullable(),
    status: z.enum(['completed', 'in-progress', 'needs-funding']).default('completed'),
    bio: z.string().nullable(),
    quote: z.string().nullable(),
    heroImage: z.string().nullable(),
    accentImage: z.string().nullable().optional(),
    photos: z.array(z.object({
      url: link(),
      alt: z.string().default(''),
      /** Focal point set in the admin, as fractions across and down: crops center on it */
      focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
    })).default([]),
    storyPhotos: z.array(z.object({
      url: link(),
      alt: z.string().default(''),
    })).max(4).default([]),
    plans: z.array(z.object({
      url: link(),
      label: z.string().default(''),
      type: z.enum(['as-built', 'proposed']),
    })).default([]),
    photoCount: z.number().default(0),
    videoUrl: link().nullable().optional(),
    streamVideoId: z.string().nullable().optional(),
    /** "Watch the live reveal" hero link — written by the FB live auto-archiver */
    revealVideoUrl: link().nullable().optional(),
    photographer: z.string().nullable().optional(),
    // name is the logo's alt text on the kid page (without it every logo read "Project partner")
    partnerLogos: z.array(z.object({
      url: link(),
      name: z.string().nullable().optional(),
    })).default([]),
    // Monetary sponsors, as Partners slugs (Admin → Kids). JobTread's Monetary Sponsor field follows them
    sponsors: z.array(z.string()).default([]),
    heroSummary: z.string().nullable().optional(),
    shortDescription: z.string().nullable().optional(),
    metaDescription: z.string().nullable().optional(),
    altTexts: z.any().nullable().optional(),
    jsonLd: z.any().nullable().optional(),
    fundraisingUrl: link().nullable().optional(),
    childCount: z.number().default(1),
    roomCount: z.number().default(1),
    bedroomCount: z.number().default(0),
    bathroomCount: z.number().default(0),
    therapyRoomCount: z.number().default(0),
    publishStatus: z.enum(['published', 'draft']).default('published'),
    beforeAfterPhotos: z.array(z.object({
      before: z.string(),
      after: z.string(),
      room: z.string().default(''),
      beforeAlt: z.string().default(''),
      afterAlt: z.string().default(''),
    })).default([]),
    galleryFeatured: z.array(z.string()).default([]),
    storyChapters: z.array(z.string()).default([]),
    sortOrder: z.number().nullable().optional(),
  }),
});

const partners = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    logo: z.string().optional(),
    website: link().optional(),
    level: z.enum(['signature', 'champion', 'builder', 'friend']).default('friend'),
    category: z.preprocess(
      (v) => Array.isArray(v) ? v : [v ?? 'build'],
      z.array(z.enum(['build', 'design', 'funding', 'community'])),
    ).default(['build']),
    featured: z.boolean().default(false),
    order: z.number().default(0),
    tagline: z.string().optional(),
  }),
});

// Outlets that covered SOARD (Admin → Press → Outlets). The "As Featured"
// strip shows the ones with a logo and strip not false; press stories point
// at one by slug (press.outletLogo) and show its name.
const medialogos = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    logo: z.string().default(''),
    order: z.number().default(0),
    strip: z.boolean().optional(),
    kind: z.enum(['national-tv', 'local-tv', 'print', 'magazine', 'entertainment']).optional(),
    aliases: z.array(z.string()).optional(),
    domains: z.array(z.string()).optional(),
  }),
});

const team = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string().optional(),
    title: z.string(),
    organization: z.string().optional(),
    photo: z.string().optional(),
    bio: z.string().optional(),
    quote: z.string().optional(),
    group: z.enum(['team', 'board', 'advisory']),
    order: z.number().default(0),
    // Structured fields (Oct 2026). Older records carry these in their name
    // and title text; src/utils/team.ts reads both.
    role: z.enum(['founder', 'staff', 'honorary']).optional(),
    seat: z.enum(['', 'chair', 'vice-chair', 'treasurer', 'secretary', 'past-chair']).optional(),
    status: z.enum(['active', 'alumni', 'memorial']).optional(),
    since: z.number().nullable().optional(),
    until: z.number().nullable().optional(),
    committees: z.array(z.string()).optional(),
    partner: z.string().nullable().optional(),
    linkedin: link().nullable().optional(),
    publishStatus: z.enum(['published', 'draft']).optional(),
    photoCrop: z.object({ x: z.number(), y: z.number(), size: z.number() }).nullable().optional(),
    photoSize: z.tuple([z.number(), z.number()]).nullable().optional(),
    photoCutout: z.boolean().optional(),
  }),
});

const articles = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    tag: z.string().default('Guide'),
    datePublished: z.string(),
    dateModified: z.string().optional(),
    heroImage: z.string().nullable().optional(),
    heroLead: z.string(),
    aboutTopics: z.array(z.string()).default([]),
    body: z.string(),
    faqs: z.array(z.object({
      question: z.string(),
      answer: z.string(),
    })).default([]),
    ctaHeading: z.string().default('Need help with your home?'),
    ctaText: z.string().default('Sunshine on a Ranney Day builds accessible bathrooms, dream bedrooms, and therapy rooms for children with special needs — at no cost to families in the greater Atlanta area.'),
    ctaPrimaryLink: link().default('/apply/'),
    ctaPrimaryLabel: z.string().default('Apply for a Makeover'),
    ctaSecondaryLink: link().default('/donate/'),
    ctaSecondaryLabel: z.string().default('Support Our Mission'),
    featured: z.boolean().default(false),
    order: z.number().default(0),
  }),
});

const events = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    date: z.string(),
    endDate: z.string().optional(),
    time: z.string().optional(),
    location: z.string(),
    address: z.string().optional(),
    description: z.string(),
    shortDescription: z.string().optional(),
    body: z.string().optional(),
    image: z.string().nullable().optional(),
    dressCodeImage: z.string().nullable().optional(),
    streamVideoId: z.string().nullable().optional(),
    videoUrl: link().nullable().optional(),
    photos: z.array(z.object({
      id: z.string(),
      alt: z.string().default(''),
    })).default([]),
    // After the event (public/admin/events-shared.js): the photographer's
    // credit, a thank-you note for the recap, and the sponsors it thanks
    photographer: z.string().optional(),
    photographerUrl: link().optional(),
    recapNote: z.string().optional(),
    // Numbers only staff know ("350" guests), at most four
    highlights: z.array(z.object({ value: z.string().default(''), label: z.string().default('') })).optional(),
    theme: z.string().optional(),
    sponsors: z.array(z.object({
      tier: z.string().default(''),
      size: z.string().optional(),
      names: z.array(z.object({
        name: z.string().default(''),
        logo: z.string().optional(),
        website: link().optional(),
        scale: z.number().optional(),
      })).default([]),
    })).optional(),
    ticketUrl: link().optional(),
    ticketPrice: z.string().optional(),
    category: z.enum(['fundraiser', 'volunteer', 'reveal', 'community', 'other']).default('other'),
    featured: z.boolean().default(false),
    status: z.enum(['upcoming', 'past', 'cancelled']).default('upcoming'),
    order: z.number().default(0),
  }),
});

const press = defineCollection({
  type: 'data',
  schema: z.object({
    outlet: z.string(),
    outletLogo: z.string().default(''),
    category: z.enum(['national-tv', 'local-tv', 'print', 'magazine', 'entertainment']),
    title: z.string(),
    date: z.string(),
    url: link(),
    excerpt: z.string(),
    image: z.string().nullable().optional(),
    featured: z.boolean().default(false),
    order: z.number().default(0),
    videoId: z.string().nullable().optional(),
    featuredHeadline: z.string().nullable().optional(),
    featuredDescription: z.string().nullable().optional(),
    // Kids and partners the story is about (their pages list it under In the news)
    kids: z.array(z.string()).optional(),
    partners: z.array(z.string()).optional(),
    // The press monitor's link check: once the outlet takes the story down,
    // the page links to its Internet Archive copy (or shows it without a link)
    archiveUrl: link().nullable().optional(),
    linkGone: z.string().nullable().optional(),
    publishStatus: z.enum(['published', 'draft']).optional(),
  }),
});

const communityPartners = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    logo: z.string().optional(),
    website: link().optional(),
    description: z.string(),
    category: z.enum(['education', 'health', 'community', 'faith', 'government']).default('community'),
    impact: z.string().optional(),
    impactLabel: z.string().optional(),
    location: z.string().optional(),
    featured: z.boolean().default(false),
    order: z.number().default(0),
  }),
});

// Site docs are free-form, so every link-named field in them (url, href, link,
// website, *Url, *Link...) is checked: none may run script when clicked
const site = defineCollection({
  type: 'data',
  schema: z.record(z.any()).superRefine((doc, ctx) => {
    for (const bad of scriptLinks(doc)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [bad.path], message: `must be an http(s) address or a path on this site, not ${linkScheme(bad.value)}:` });
  }),
});

const community = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    impact: z.string(),
    impactLabel: z.string(),
    /* Up to 3 hero stats; the first mirrors impact/impactLabel */
    stats: z.array(z.object({
      value: z.string(),
      label: z.string(),
      /** Set in the admin: this stat's number is added to "children reached" (all false: none; unset everywhere: the first) */
      reached: z.boolean().optional(),
    })).default([]),
    year: z.string(),
    description: z.string(),
    color: z.string().default('#373A36'),
    imageId: z.string().optional(),
    imageAlt: z.string().optional(),
    /* Set by the admin Status dropdown; 'in-progress' shows the In Progress badge */
    status: z.enum(['completed', 'in-progress']).default('completed'),
    /* 'draft' keeps the project off the site (the admin's "Show on the Community page") */
    publishStatus: z.enum(['draft', 'published']).default('published'),
    order: z.number().default(0),
    /* ── Detail page fields (optional — omit for summary-only entries) ── */
    founded: z.string().optional(),
    story: z.string().optional(),
    quote: z.string().nullable().optional(),
    /** Who said the quote, shown under it */
    quoteBy: z.string().nullable().optional(),
    heroImage: z.string().nullable().optional(),
    metaDescription: z.string().optional(),
    videoUrl: link().nullable().optional(),
    streamVideoId: z.string().nullable().optional(),
    photos: z.array(z.object({
      url: link(),
      alt: z.string().default(''),
      /** Focal point set in the admin, as fractions across and down: crops center on it */
      focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
    })).default([]),
    partnerLogos: z.array(z.object({
      url: link(),
      name: z.string().default(''),
    })).default([]),
  }),
});

export const collections = { kids, partners, medialogos, team, articles, press, events, community, community_partners: communityPartners, communityPartners, site };
