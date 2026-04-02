import { defineCollection, z } from 'astro:content';

const kids = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    age: z.union([z.number(), z.array(z.number())]).nullable(),
    diagnosis: z.string().nullable(),
    roomTypes: z.array(z.string()).nullable(),
    year: z.number().nullable(),
    status: z.enum(['completed', 'in-progress']).default('completed'),
    bio: z.string().nullable(),
    quote: z.string().nullable(),
    heroImage: z.string().nullable(),
    photos: z.array(z.object({
      url: z.string(),
      alt: z.string().default(''),
    })).default([]),
    storyPhotos: z.array(z.object({
      url: z.string(),
      alt: z.string().default(''),
    })).max(4).default([]),
    plans: z.array(z.object({
      url: z.string(),
      label: z.string().default(''),
      type: z.enum(['as-built', 'proposed']),
    })).default([]),
    photoCount: z.number().default(0),
    videoUrl: z.string().nullable().optional(),
    streamVideoId: z.string().nullable().optional(),
    photographer: z.string().nullable().optional(),
    partnerLogos: z.array(z.object({
      url: z.string(),
    })).default([]),
    heroSummary: z.string().nullable().optional(),
    shortDescription: z.string().nullable().optional(),
    metaDescription: z.string().nullable().optional(),
    altTexts: z.any().nullable().optional(),
    jsonLd: z.any().nullable().optional(),
    fundraisingUrl: z.string().nullable().optional(),
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
  }),
});

const partners = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    logo: z.string().optional(),
    website: z.string().optional(),
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

const medialogos = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    logo: z.string(),
    order: z.number().default(0),
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
    group: z.enum(['team', 'board']),
    order: z.number().default(0),
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
    ctaPrimaryLink: z.string().default('/apply/'),
    ctaPrimaryLabel: z.string().default('Apply for a Makeover'),
    ctaSecondaryLink: z.string().default('/donate/'),
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
    body: z.string().optional(),
    image: z.string().nullable().optional(),
    streamVideoId: z.string().nullable().optional(),
    videoUrl: z.string().nullable().optional(),
    photos: z.array(z.object({
      id: z.string(),
      alt: z.string().default(''),
    })).default([]),
    ticketUrl: z.string().optional(),
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
    outletLogo: z.string(),
    category: z.enum(['national-tv', 'local-tv', 'print', 'magazine', 'entertainment']),
    title: z.string(),
    date: z.string(),
    url: z.string(),
    excerpt: z.string(),
    image: z.string().nullable().optional(),
    featured: z.boolean().default(false),
    order: z.number().default(0),
    videoId: z.string().nullable().optional(),
    featuredHeadline: z.string().nullable().optional(),
    featuredDescription: z.string().nullable().optional(),
  }),
});

const communityPartners = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    logo: z.string().optional(),
    website: z.string().optional(),
    description: z.string(),
    category: z.enum(['education', 'health', 'community', 'faith', 'government']).default('community'),
    impact: z.string().optional(),
    impactLabel: z.string().optional(),
    location: z.string().optional(),
    featured: z.boolean().default(false),
    order: z.number().default(0),
  }),
});

const site = defineCollection({
  type: 'data',
  schema: z.record(z.any()),
});

const community = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    impact: z.string(),
    impactLabel: z.string(),
    year: z.string(),
    description: z.string(),
    color: z.string().default('#373A36'),
    imageId: z.string().optional(),
    imageAlt: z.string().optional(),
    badge: z.string().optional(),
    order: z.number().default(0),
    /* ── Detail page fields (optional — omit for summary-only entries) ── */
    founded: z.string().optional(),
    story: z.string().optional(),
    quote: z.string().nullable().optional(),
    heroImage: z.string().nullable().optional(),
    metaDescription: z.string().optional(),
    videoUrl: z.string().nullable().optional(),
    streamVideoId: z.string().nullable().optional(),
    photos: z.array(z.object({
      url: z.string(),
      alt: z.string().default(''),
    })).default([]),
    partnerLogos: z.array(z.object({
      url: z.string(),
      name: z.string().default(''),
    })).default([]),
  }),
});

export const collections = { kids, partners, medialogos, team, articles, press, events, community, community_partners: communityPartners, communityPartners, site };
