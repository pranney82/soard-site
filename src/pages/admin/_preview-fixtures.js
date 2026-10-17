/**
 * Made-up items for the admin Preview's template pages
 * (src/pages/admin/<type>-template/[variant].astro). Each variant switches on
 * a different set of optional parts so that, between them, every part of the
 * page exists for public/admin/<type>-preview.js to clone.
 * scripts/test-page-preview.mjs also rebuilds each one with the preview and
 * checks it against its template page, so every variant stays covered.
 */

const kidImg = (n) => `kid-template/${n}`;
const kidFull = {
  name: 'Template', slug: 'kid-template', age: 9, diagnosis: 'Template diagnosis',
  roomTypes: ['Dream Bedroom', 'Accessible Bathroom'], year: 2026, status: 'in-progress',
  bio: '<p>First paragraph. It has two sentences.</p><p>Second paragraph.</p><p>Third paragraph.</p>',
  quote: 'Template quote.', heroImage: kidImg('hero'), accentImage: kidImg('photo-1'),
  photos: Array.from({ length: 10 }, (_, i) => ({ url: kidImg(`photo-${i + 1}`), alt: `Template photo ${i + 1}` })),
  photoCount: 10, photographer: 'Template Photographer',
  videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', streamVideoId: 'templatestream',
  revealVideoUrl: 'https://example.com/live/templatestream',
  fundraisingUrl: 'https://example.com/give', heroSummary: '',
  partnerLogos: [{ url: kidImg('partner'), name: 'Template Partner' }],
  plans: [
    { url: kidImg('plan-1'), label: 'Existing floor plan', type: 'as-built' },
    { url: kidImg('plan-2'), label: 'Proposed floor plan', type: 'proposed' },
    { url: kidImg('plan-3'), label: 'Board', type: 'proposed' },
  ],
  beforeAfterPhotos: [{ before: kidImg('before'), after: kidImg('after'), room: 'Bedroom', beforeAlt: '', afterAlt: '' }],
  roomCount: 2, childCount: 1,
};
// alt: the other badge, the YouTube player and the general closing ask
const kidAlt = { ...kidFull, status: 'needs-funding', accentImage: '', fundraisingUrl: '', revealVideoUrl: '' };
// nophoto: the name placeholder shown when there's no hero photo
const kidNophoto = { ...kidAlt, status: 'completed', heroImage: '' };

const eventPhotos = [{ id: 'event-template/photo-1', alt: 'Template photo 1' }, { id: 'event-template/photo-2', alt: '' }];
const eventUpcoming = {
  title: 'Template Event', slug: 'event-template', date: '2099-06-06', endDate: '', time: 'Template time',
  location: 'Template location', address: '', description: 'Template description.', shortDescription: 'Template recap.',
  body: '<p>Template body.</p>', image: 'event-template/hero', streamVideoId: 'templatestream', videoUrl: null,
  photos: eventPhotos, ticketUrl: 'https://example.com/tickets', ticketPrice: '$100', category: 'fundraiser',
  featured: false, status: 'upcoming', order: 0,
};
const eventPast = { ...eventUpcoming, date: '2020-06-06', streamVideoId: null, videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', status: 'past' };

const communityFull = {
  name: 'Template Project', slug: 'community-template', impact: '100', impactLabel: 'Template impact',
  stats: [{ value: '100', label: 'Template impact' }, { value: '2', label: 'Template rooms' }, { value: '3', label: 'Template years' }],
  year: '2026', description: 'Template description.', color: '#373A36', status: 'in-progress', order: 0,
  founded: '1999', story: '<p>Template story.</p>', quote: 'Template quote.', heroImage: 'community-template/hero',
  imageAlt: 'Template alt', metaDescription: '', videoUrl: null, streamVideoId: 'templatestream',
  photos: [{ url: 'community-template/photo-1', alt: 'Template photo' }, { url: 'community-template/photo-2', alt: '' }],
  partnerLogos: [{ url: 'community-template/partner-1', name: 'Template Partner' }, { url: 'community-template/partner-2', name: '' }],
};
// alt: no photo (the color block), the impact fallback stat, plain-text story, YouTube
const communityAlt = {
  ...communityFull, stats: [], status: 'completed', founded: undefined, story: 'First paragraph.\n\nSecond paragraph.',
  quote: null, heroImage: null, streamVideoId: null, videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  photos: [{ url: 'community-template/photo-1', alt: '' }], partnerLogos: [],
};

const articleFull = {
  title: 'Template <em>Guide</em>', slug: 'article-template', description: 'Template description.', tag: 'Accessibility',
  datePublished: '2026-01-01', heroImage: 'article-template/hero', heroLead: 'Template lead.', aboutTopics: [],
  body: '<p>Intro.</p><h2>First part</h2><p>One.</p><h2>Second part</h2><p>Two.</p><h2>First part</h2><p>Three.</p>',
  faqs: [{ question: 'Template question?', answer: 'Template <strong>answer</strong>.' }, { question: 'Second?', answer: 'Yes.' }],
  ctaHeading: 'Template heading', ctaText: 'Template text.', ctaPrimaryLink: '/apply/', ctaPrimaryLabel: 'Template primary',
  ctaSecondaryLink: '/donate/', ctaSecondaryLabel: 'Template secondary', featured: false, order: 0,
};
// nohero: the site's fallback photo, no table of contents, no questions
const articleNohero = { ...articleFull, heroImage: null, body: '<p>Only a paragraph.</p>', faqs: [] };

// Partners: each card layout, linked or not, with or without logo and tagline
const partner = (slug, data) => ({ id: slug, data: { slug, category: ['build'], featured: false, order: 0, ...data } });
const partnersAll = [
  partner('tpl-sig-a', { name: 'Template Signature A', level: 'signature', website: 'https://example.com/a', logo: 'partners-template/sig-a', tagline: 'Template tagline' }),
  partner('tpl-sig-b', { name: 'Template Signature B', level: 'signature', order: 1 }),
  partner('tpl-champ-a', { name: 'Template Champion A', level: 'champion', website: 'https://example.com/c', logo: 'partners-template/champ-a' }),
  partner('tpl-champ-b', { name: 'Template Champion B', level: 'champion', order: 1 }),
  partner('tpl-builder', { name: 'Template Builder', level: 'builder', website: 'https://example.com/b', logo: 'partners-template/builder', tagline: 'Template tagline', category: ['build', 'design'], featured: true }),
  partner('tpl-friend', { name: 'Template Friend', level: 'friend', category: ['funding'], order: 1 }),
];

// Press: four featured layouts (video, photo, outlet logo, outlet name) and
// archive stories across two years, with and without a link
const pressItem = (id, data) => ({ id, data: { featured: false, order: 0, image: null, videoId: null, url: 'https://example.com/story', excerpt: 'Template excerpt.', category: 'local-tv', ...data } });
const pressFeatured = {
  video: pressItem('tpl-video', { outlet: 'Template TV', outletLogo: 'none', title: 'Template video story', date: '2025-05-01', featured: true, videoId: 'aaaaaaaaaaa', featuredHeadline: 'Template headline', featuredDescription: 'Template <b>description</b>.', category: 'national-tv' }),
  image: pressItem('tpl-image', { outlet: 'Template Paper', outletLogo: 'none', title: 'Template photo story', date: '2024-03-01', featured: true, image: 'press-template/photo', category: 'print' }),
  logo: pressItem('tpl-logo', { outlet: 'Template Outlet', outletLogo: 'tpl-outlet', title: 'Template logo story', date: '2024-02-01', featured: true, category: 'magazine' }),
  text: pressItem('tpl-text', { outlet: 'Template Name Only', outletLogo: 'none', title: 'Template text story', date: '2023-01-01', featured: true, category: 'entertainment' }),
};
const pressArchive = [
  pressItem('tpl-archive-a', { outlet: 'Template Station', outletLogo: 'none', title: 'Template archive story', date: '2025-07-04', excerpt: '<p>Template <a href="#">excerpt</a>&nbsp;with markup.</p>' }),
  pressItem('tpl-archive-b', { outlet: 'Template Station', outletLogo: 'none', title: 'Template story without a link', date: '2024-09-09', url: '', category: 'print' }),
];
const pressFor = (first) => [
  ...Object.entries(pressFeatured).map(([k, item]) => ({ ...item, data: { ...item.data, order: k === first ? 0 : 1 + Object.keys(pressFeatured).indexOf(k) } })),
  ...pressArchive,
];
const pressLogos = [{ id: 'tpl-outlet', data: { name: 'Template Outlet', slug: 'tpl-outlet', logo: 'press-template/outlet-logo', order: 0 } }];

export const FIXTURES = {
  kid: {
    full: { item: kidFull, video: { type: 'stream', id: 'templatestream' } },
    alt: { item: kidAlt, video: { type: 'youtube', id: 'aaaaaaaaaaa' } },
    nophoto: { item: kidNophoto, video: { type: 'youtube', id: 'aaaaaaaaaaa' } },
  },
  event: {
    upcoming: { item: eventUpcoming },
    past: { item: eventPast },
    pending: { item: { ...eventPast, body: '', photos: [], videoUrl: null, image: null } },
  },
  community: {
    full: { item: communityFull },
    alt: { item: communityAlt },
  },
  article: {
    full: { item: articleFull },
    nohero: { item: articleNohero },
  },
  // List pages: the whole collection is the input
  partner: {
    full: { collection: partnersAll },
  },
  press: Object.fromEntries(Object.keys(pressFeatured).map((first) => [first, { collection: pressFor(first), mediaLogos: pressLogos }])),
};
