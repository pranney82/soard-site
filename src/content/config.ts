import { defineCollection, z } from 'astro:content';

const kids = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    wpSlug: z.string().optional(),
    wpUrl: z.string().optional(),
    age: z.number().nullable(),
    diagnosis: z.string().nullable(),
    roomTypes: z.array(z.string()).nullable(),
    year: z.number().nullable(),
    status: z.enum(['completed', 'in-progress']).default('completed'),
    bio: z.string().nullable(),
    quote: z.string().nullable(),
    heroImage: z.string().nullable(),
    photos: z.array(z.object({
      wpPath: z.string().optional(),
      url: z.string(),
      alt: z.string().default(''),
    })).default([]),
    photoCount: z.number().default(0),
    videoUrl: z.string().nullable().optional(),
    photographer: z.string().nullable().optional(),
    partnerLogos: z.array(z.object({
      wpPath: z.string().optional(),
      url: z.string(),
    })).default([]),
    shortDescription: z.string().nullable().optional(),
    metaDescription: z.string().nullable().optional(),
    altTexts: z.any().nullable().optional(),
    jsonLd: z.any().nullable().optional(),
    _migration: z.any().optional(),
  }),
});

const partners = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    logo: z.string(),
    website: z.string().optional(),
    tier: z.enum(['top', 'construction', 'design', 'community']),
    featured: z.boolean().default(false),
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

export const collections = { kids, partners, team, articles };
