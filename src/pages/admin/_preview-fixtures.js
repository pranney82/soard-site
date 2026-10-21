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
// past: the recap (photos, then sponsors: a top level, a logo wall with a name-only sponsor, a named moment)
const eventPast = {
  ...eventUpcoming, date: '2020-06-06', streamVideoId: null, videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', status: 'past',
  photographer: 'Template Photographer', photographerUrl: 'https://example.com/photos', recapNote: 'Template note.',
  highlights: [{ value: '100', label: 'Template guests' }],
  sponsors: [
    { tier: 'Template Top', size: 'xl', names: [{ name: 'Template Top Co', logo: 'event-template/sponsor-1' }] },
    { tier: 'Template Gold', size: 'md', names: [{ name: 'Template Gold Co', logo: 'event-template/sponsor-2', website: 'https://example.com/gold' }, { name: 'Template Family' }] },
    { tier: 'Template Moment Sponsor', size: 'md', names: [{ name: 'Template Moment Co', logo: 'event-template/sponsor-3', website: 'https://example.com/moment' }, { name: 'Template Moment Family' }] },
  ],
};

const communityFull = {
  name: 'Template Project', slug: 'community-template', impact: '100', impactLabel: 'Template impact',
  stats: [{ value: '100', label: 'Template impact' }, { value: '2', label: 'Template rooms' }, { value: '3', label: 'Template years' }],
  year: '2026', description: 'Template description.', color: '#373A36', status: 'in-progress', order: 0,
  founded: '1999', story: '<p>Template story.</p>', quote: 'Template quote.', quoteBy: 'Template Person', heroImage: 'community-template/hero',
  imageAlt: 'Template alt', metaDescription: '', videoUrl: null, streamVideoId: 'templatestream',
  photos: [{ url: 'community-template/photo-1', alt: 'Template photo' }, { url: 'community-template/photo-2', alt: '' }],
  partnerLogos: [{ url: 'community-template/partner-1', name: 'Template Partner' }, { url: 'community-template/partner-2', name: '' }],
};
// alt: no photo (the color block), the impact fallback stat, plain-text story, YouTube
const communityAlt = {
  ...communityFull, stats: [], status: 'completed', founded: undefined, story: 'First paragraph.\n\nSecond paragraph.',
  quote: null, quoteBy: null, heroImage: null, streamVideoId: null, videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
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
// archive stories across two years: with and without a link, an archived
// copy, one gone for good, and a draft (never shown)
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
  // Taken down by its outlet: links to the archived copy; and one taken down with no copy
  pressItem('tpl-archive-c', { outlet: 'Template Station', outletLogo: 'none', title: 'Template archived story', date: '2024-06-06', url: 'https://example.com/gone', linkGone: '2026-01-01', archiveUrl: 'https://web.archive.org/web/20240606000000/https://example.com/gone' }),
  pressItem('tpl-archive-d', { outlet: 'Template Station', outletLogo: 'none', title: 'Template story gone for good', date: '2024-05-05', url: 'https://example.com/lost', linkGone: '2026-01-01', category: 'print' }),
  // A draft stays off the page
  pressItem('tpl-archive-e', { outlet: 'Template Station', outletLogo: 'none', title: 'Template draft story', date: '2024-04-04', publishStatus: 'draft' }),
];
const pressFor = (first) => [
  ...Object.entries(pressFeatured).map(([k, item]) => ({ ...item, data: { ...item.data, order: k === first ? 0 : 1 + Object.keys(pressFeatured).indexOf(k) } })),
  ...pressArchive,
];
const pressLogos = [{ id: 'tpl-outlet', data: { name: 'Template Outlet', slug: 'tpl-outlet', logo: 'press-template/outlet-logo', order: 0 } }];

// People: every card on the Leadership page (with and without a photo or an
// organization, a cropped cutout, a memorial), plus a draft and an alumna
// that the page leaves out. The advisors also fill the Advisory Board page
// (advisory-template): with a photo, a custom title and a profile, neither,
// and in memory
const person = (slug, data) => ({ id: slug, data: { slug, order: 0, ...data } });
const teamAll = [
  person('tpl-founder-a', { name: 'Template Founder', title: 'Co-Founder/President', group: 'team', role: 'founder', photo: 'team-template/founder' }),
  person('tpl-founder-b', { name: 'Template Founder Two', title: 'Co-Founder', group: 'team', role: 'founder', order: 1, bio: 'Template bio.' }),
  person('tpl-staff-a', { name: 'Template Staff', title: 'Template Role', organization: 'Template Org', group: 'team', role: 'staff', order: 2,
    photo: 'team-template/staff', photoSize: [1200, 1600], photoCrop: { x: 0.1, y: 0.2, size: 0.7 }, photoCutout: true }),
  person('tpl-staff-b', { name: 'Template Staff Two', title: 'Template Role', group: 'team', role: 'staff', order: 3, bio: 'Template bio.' }),
  person('tpl-honorary', { name: 'Template Greeter', title: 'Chief Greeter', group: 'team', role: 'honorary', photo: 'team-template/honorary' }),
  person('tpl-draft', { name: 'Template Draft', title: 'Template Role', group: 'team', role: 'staff', publishStatus: 'draft' }),
  person('tpl-chair', { name: 'Template Chair', title: 'Board Chair', organization: 'Template Company, CEO', group: 'board', seat: 'chair', order: 4, photo: 'team-template/chair' }),
  // order 0: the seat, not the order, puts the Past Chair after the Chair and ahead of the members
  person('tpl-past-chair', { name: 'Template Past Chair', title: 'Past Board Chair', group: 'board', seat: 'past-chair', order: 0 }),
  person('tpl-member', { name: 'Template Member', title: 'Board Member', group: 'board', seat: '', order: 1 }),
  person('tpl-member-bio', { name: 'Template Profiled', title: 'Board Member', organization: 'Template Company', group: 'board', seat: '', order: 2, photo: 'team-template/profiled',
    bio: 'Template first paragraph.\n\nTemplate second paragraph.', quote: 'Template quote.', linkedin: 'https://www.linkedin.com/in/template', committees: ['Template Committee'], since: 2020 }),
  person('tpl-memorial', { name: 'Template Remembered', title: 'Board Member 2020-2024', organization: 'Template Company', group: 'board', status: 'memorial', photo: 'team-template/memorial', photoCutout: true }),
  person('tpl-alumna', { name: 'Template Alumna', title: 'Board Member', group: 'board', status: 'alumni', until: 2025 }),
  person('tpl-advisor', { name: 'Template Advisor', title: 'Advisory Board Member', organization: 'Template Company, Partner', group: 'advisory', order: 0,
    photo: 'team-template/advisor', photoSize: [1200, 1600], photoCrop: { x: 0.1, y: 0.2, size: 0.7 } }),
  person('tpl-advisor-bio', { name: 'Template Advisor Profiled', title: 'Advisory Board Chair', organization: 'Template Company', group: 'advisory', order: 1,
    bio: 'Template bio.', since: 2026 }),
  person('tpl-advisor-plain', { name: 'Template Advisor Two', title: 'Advisory Board Member', group: 'advisory', order: 2 }),
  person('tpl-advisor-draft', { name: 'Template Advisor Draft', title: 'Advisory Board Member', group: 'advisory', order: 3, publishStatus: 'draft' }),
  person('tpl-advisor-memorial', { name: 'Template Advisor Remembered', title: 'Advisory Board Member', group: 'advisory', order: 4, status: 'memorial' }),
];

// Profile pages (person-template): full has every part (photo with a cutout
// and crop, company logo, years, committees, LinkedIn, quote, two others with
// profiles, one without a photo); plain has none of the optional parts;
// memorial switches the wording
const profileFull = {
  name: 'Template Profile', slug: 'tpl-profile', title: 'Board Chair', seat: 'chair', organization: 'Template Company, CEO', group: 'board', order: 0,
  photo: 'team-template/profile', photoSize: [1200, 1600], photoCrop: { x: 0.1, y: 0.15, size: 0.8 }, photoCutout: true,
  bio: 'Template first paragraph.\n\nTemplate second\nparagraph.', quote: 'Template quote.', linkedin: 'https://www.linkedin.com/in/template',
  committees: ['Template Committee', 'Second Committee'], since: 2019, partner: 'tpl-partner',
};
const profileOthers = [
  { name: 'Template Other', slug: 'tpl-other', title: 'Board Member', group: 'board', order: 1, photo: 'team-template/other', bio: 'Template bio.' },
  { name: 'Template Nophoto', slug: 'tpl-nophoto', title: 'Board Member', group: 'board', order: 2, bio: 'Template bio.' },
  { name: 'Template Hidden', slug: 'tpl-hidden', title: 'Board Member', group: 'board', order: 3, bio: 'Template bio.', publishStatus: 'draft' },
];
const profilePlain = { name: 'Template', slug: 'tpl-plain', title: 'Template Role', group: 'team', role: 'staff', order: 0, bio: 'Only a paragraph.' };
const profileAdvisory = {
  name: 'Template Advisor', slug: 'tpl-advisor', title: 'Advisory Board Member', organization: 'Template Company, Partner', group: 'advisory', order: 0,
  photo: 'team-template/advisor', bio: 'Template bio.', linkedin: 'https://www.linkedin.com/in/template', since: 2026,
};
const advisoryOther = { name: 'Template Advisor Two', slug: 'tpl-advisor-two', title: 'Advisory Board Member', group: 'advisory', order: 1, bio: 'Template bio.' };
const profileMemorial = {
  name: 'Template Remembered', slug: 'tpl-remembered', title: 'Board Member 2015-2024', group: 'board', status: 'memorial', order: 4,
  photo: 'team-template/remembered', bio: 'Template bio.', quote: 'Template words.', linkedin: 'https://www.linkedin.com/in/template', since: 2015, until: 2024,
};
const asEntries = (list) => list.map((d) => ({ id: d.slug, data: d }));
const profilePartners = [{ id: 'tpl-partner', data: { name: 'Template Partner', slug: 'tpl-partner', logo: 'partners-template/logo' } }];

export const FIXTURES = {
  kid: {
    full: { item: kidFull, video: { type: 'stream', id: 'templatestream' } },
    alt: { item: kidAlt, video: { type: 'youtube', id: 'aaaaaaaaaaa' } },
    nophoto: { item: kidNophoto, video: { type: 'youtube', id: 'aaaaaaaaaaa' } },
  },
  event: {
    upcoming: { item: eventUpcoming },
    // before the event with a YouTube video instead of Stream
    youtube: { item: { ...eventUpcoming, streamVideoId: null, videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' } },
    past: { item: eventPast },
    pending: { item: { ...eventPast, body: '', photos: [], videoUrl: null, image: null, sponsors: [], highlights: [], recapNote: '' } },
    // a past event with its poster and a Stream video, its photos not in yet
    poster: { item: { ...eventPast, photos: [], body: '', videoUrl: null, streamVideoId: 'templatestream', photographer: '' } },
  },
  community: {
    full: { item: communityFull, video: { type: 'stream', id: 'templatestream' } },
    alt: { item: communityAlt, video: { type: 'youtube', id: 'aaaaaaaaaaa' } },
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
  team: {
    full: { collection: teamAll },
  },
  // Item pages: the person, with the whole collection (for "More of our board") and partners
  person: {
    full: { item: profileFull, collection: asEntries([profileFull, ...profileOthers]), partners: profilePartners },
    plain: { item: profilePlain, collection: asEntries([profilePlain]), partners: profilePartners },
    memorial: { item: profileMemorial, collection: asEntries([profileFull, profileMemorial]), partners: profilePartners },
    advisory: { item: profileAdvisory, collection: asEntries([profileAdvisory, advisoryOther, profileFull]), partners: profilePartners },
  },
  // The Advisory Board page lists the advisors
  advisory: {
    full: { collection: teamAll },
  },
};
