/**
 * Canonical defaults for site settings.
 *
 * Every field that pages rely on MUST appear here.  During prebuild the D1
 * payload is deep-merged on top of these defaults, so the Astro build always
 * receives a complete, crash-proof settings object — no per-page || {} needed.
 *
 * To add a new settings section:
 *   1. Add the default here.
 *   2. Use it in the page — no fallback logic required.
 *   3. (Optional) Add an admin UI control.
 */
export const SETTINGS_DEFAULTS = {
  /* ── Identity ── */
  name: 'Sunshine on a Ranney Day',
  shortName: 'SOARD',
  tagline: 'Dreams Built Here',
  ein: '45-4773997',
  address: {
    street: '250 Hembree Park Drive, Suite 106',
    city: 'Roswell',
    state: 'GA',
    zip: '30076',
  },
  phone: '770.990.2434',
  email: 'info@soardcharity.com',

  /* ── Social ── */
  social: {
    facebook: 'https://www.facebook.com/sunshineonaranneyday',
    instagram: 'https://www.instagram.com/sunshineonaranneyday',
    youtube: 'https://www.youtube.com/@sunshineonaranneyday',
    tiktok: 'https://www.tiktok.com/@sunshineonaranneyday',
  },

  /* ── Home Hero ── */
  homeHero: {
    eyebrow: '501(c)(3) Nonprofit · Atlanta, GA · Since 2012',
    headlineLine1: 'Building <em>dreams</em>,',
    headlineLine2: 'one room at a time',
    lead: 'We create life-changing spaces for children with special needs — dream bedrooms, accessible bathrooms, and therapy rooms — all at <strong>no cost to families</strong>.',
    cta1Label: 'Give Today',
    cta1Link: '/donate',
    cta2Label: 'See Our Work ↓',
    cta2Link: '#stories',
  },

  /* ── Featured / Showcase ── */
  featuredKidSlug: 'zyah',
  heroKidSlug: '',
  kidShowcase: [],

  /* ── Section Photos ── */
  sectionPhotos: {
    missionMain: 'kids/eli/photo-01',
    missionAccent: 'kids/georgia/photo-01',
    storyPhoto: 'kids/zyah/hero',
    roomBedroom: 'kids/griffin/hero',
    roomBath: 'kids/zyah/hero',
    roomTherapy: 'kids/jackson/hero',
    process: 'kids/oakley/photo-15',
  },

  /* ── Partner Logos ── */
  partnerLogos: [],

  /* ── Donate Page ── */
  donatePhotos: {
    hero: 'kids/oakley/hero',
    heroKidName: 'Oakley',
    story: 'kids/amari/hero',
    storyKidName: 'Amari',
  },

  /* ── Apply Page ── */
  application: {
    open: false,
    year: '2026',
    formUrl: '',
    closedMessage: '',
  },
  applyPhotos: {
    hero: 'kids/griffin/hero',
    story: 'kids/eli/photo-01',
    selection: 'kids/georgia/photo-01',
  },

  /* ── Newsletter ── */
  newsletter: {
    listId: '',
  },

  /* ── Sunny & Ranney ── */
  sunnyAndRanneyRooms: [],

  /* ── Photo Timestamps (admin bookkeeping) ── */
  photoTimestamps: {},
};
