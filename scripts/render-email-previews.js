/**
 * Renders sample email broadcasts that exercise every block type.
 * Outputs three preview files at the repo root, used as visual regression
 * snapshots when the email template engine changes.
 *
 *   node scripts/render-email-previews.js
 */

import { customTemplate, BLOCK_TYPES } from '../functions/api/_email-templates.js';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const adrianBlocks = [
  { type: 'heroPortrait',
    src: 'kids/adrian/photo-18',
    alt: 'Adrian in their dream room',
    name: 'Adrian',
    age: '19',
    link: 'https://sunshineonaranneyday.com/kids/adrian-2025',
  },
  { type: 'detailChips', items: [
    { label: 'Diagnosis', value: 'Cerebral Palsy' },
    { label: 'Rooms', value: 'Accessible Bathroom + Dream Bedroom' },
    { label: 'Year', value: '2025' },
  ]},
  { type: 'sectionLabel', text: 'Project Complete · 2025', variant: 'dark' },
  { type: 'headline', text: 'Meet Adrian — our little *miracle*', size: 'large', align: 'left' },
  { type: 'paragraph', style: 'lede', text: "Adrian's story is one of perseverance, love, and joy in the face of incredible challenges. Born prematurely at just 27 weeks during Hurricane Katrina, doctors said Adrian wouldn't survive an hour. He fought through those early days on the strongest ventilator available, and though doctors said he would never speak, today he talks nonstop." },
  { type: 'photoGrid', items: [
    { src: 'kids/adrian/1774454540229-Adrian-SRD--33.jpg', alt: 'Adrian smiling' },
    { src: 'kids/adrian/photo-23', alt: 'Adrian in his new room' },
  ]},
  { type: 'paragraph', text: "Adrian is 19 now, full of personality and light. He adores zebras, trains, graduations, sushi, and Chips Ahoy cookies. His mom, a dedicated Spanish and cooking teacher, lovingly calls him her *little miracle*." },
  { type: 'paragraph', text: "Adrian requires total physical care, and their previous bathroom setup was both unsafe and exhausting. Mom could only bathe Adrian twice a week because of how difficult and physically taxing it was." },
  { type: 'quote', text: "I want a new shower so Mommy doesn't have to step over the side.", cite: 'Adrian' },
  { type: 'transitionLine', text: 'That all *changed*.' },
  { type: 'stats', items: [
    { value: '2', label: 'Rooms Built' },
    { value: '20', label: 'Partners' },
    { value: '1', label: 'Dream' },
  ]},
  { type: 'sectionLabel', text: 'What We Built', variant: 'yellow' },
  { type: 'headline', text: 'Two rooms, one *purpose*', size: 'medium' },
  { type: 'paragraph', text: 'Safety, independence, and joy — at the center of every decision.', muted: true },
  { type: 'numberedCard', number: '01', title: 'Accessible Bathroom', body: 'A fully redesigned, wheelchair-accessible bathroom — roll-in shower, safe maneuvering space, and features built for independence and dignity.' },
  { type: 'numberedCard', number: '02', title: 'Dream Bedroom', body: "A one-of-a-kind bedroom designed around Adrian's personality, interests, and unique needs — his own space to dream big." },
  { type: 'sectionLabel', text: 'The Transformation', variant: 'dark' },
  { type: 'headline', text: 'From struggle to *sunshine*', size: 'medium' },
  { type: 'beforeAfter',
    before: { src: 'kids/adrian/1774454536082-Adrian-SRD--27.jpg', alt: "Adrian's space before renovation" },
    after: { src: 'kids/adrian/photo-24', alt: "Adrian's beautiful new space" },
  },
  { type: 'photo', src: 'kids/adrian/photo-12', alt: "Adrian seeing their new room for the first time", caption: 'The big reveal — the moment everything changed', variant: 'reveal' },
  { type: 'button', label: "See Adrian's Full Story", href: 'https://sunshineonaranneyday.com/kids/adrian-2025', variant: 'primary' },
  { type: 'partnersList',
    label: 'Our Partners',
    headline: 'Made possible by *incredible* partners',
    intro: "This project wouldn't exist without the generosity of partners who show up, project after project, with heart and hands ready to build.",
    partners: ['Spirit Of Life Walkathon Tommy Meo Jr', 'WYP Construction', 'Pella', 'Roswell Womens Club', 'Jimmy & Helen Carlos', 'Kids R Kids Foundation', 'Real Floors Commercial', 'Randall Brothers', 'MSI', 'Top Knobs', 'Pulley & Associates', 'Sherwin Williams', 'TKO Plumbing Services', 'ServiceWise Electric', 'Carmen Mari Photography', 'Jim Van Epps', 'Lee Hainer', 'Fine Lines Environments', 'Firefly Forts'],
  },
  { type: 'sectionLabel', text: 'Your Impact', variant: 'yellow' },
  { type: 'headline', text: 'Every dollar has a *purpose*', size: 'medium' },
  { type: 'paragraph', text: 'Families are on our waitlist right now. Your gift brings us closer to saying *yes* to the next child.', muted: true },
  { type: 'donationTiers',
    featured: { amount: '500', label: 'Furniture & Flooring', description: "Adaptive furniture or accessible flooring — the structural pieces that change a child's daily life.", badge: 'Most Popular' },
    small: [
      { amount: '60', label: 'Paint & Supplies', description: "Transforms walls into a child's dream canvas." },
      { amount: '125', label: 'Bedding & Decor', description: 'The details that make a room feel like home.' },
    ],
  },
  { type: 'trustSignals' },
  { type: 'signature', note: "Adrian reminded us why we started SOARD. Every room we build is a promise that these kids and their families aren't alone. Thank you for making this possible." },
  { type: 'button', label: 'Donate Now', href: 'https://sunshineonaranneyday.com/donate', variant: 'dark' },
  { type: 'spacer', height: 16 },
];

const axelBlocks = [
  { type: 'heroPortrait',
    src: 'kids/axel/1774377856789-Axel.jpg',
    alt: 'Axel',
    name: 'Axel',
    age: '11',
    badge: 'Coming Soon',
    badgeVariant: 'yellow',
    link: 'https://sunshineonaranneyday.com/kids/axel',
  },
  { type: 'detailChips', items: [
    { label: 'Diagnosis', value: 'Cerebral Palsy with Dystonia' },
    { label: 'Rooms', value: 'Accessible Bathroom + Dream Bedroom' },
    { label: 'Year', value: '2026' },
  ]},
  { type: 'sectionLabel', text: 'Introducing · 2026', variant: 'dark' },
  { type: 'headline', text: 'Meet Axel', size: 'large' },
  { type: 'paragraph', style: 'lede', text: 'Born prematurely at just 28 weeks, Axel was later diagnosed with cerebral palsy with dystonia, a neurological movement disorder that causes painful, involuntary muscle contractions. Axel lives with ongoing pain, and recently underwent major hip surgery. His parents take opposite shifts in the housekeeping department at Northside hospital, to make sure one is home with Axel at all times.' },
  { type: 'paragraph', text: "Despite everything, Axel is bright-eyed, curious, and full of wonder. He loves cars, music, and being read to. His family pours everything they have into making sure he feels seen and loved." },
  { type: 'sectionLabel', text: 'The Plan', variant: 'yellow' },
  { type: 'headline', text: "What we're *building*", size: 'medium' },
  { type: 'paragraph', text: "Here's what Axel's renovation will include:", muted: true },
  { type: 'numberedCard', number: '01', title: 'Accessible Bathroom', body: 'A roll-in shower with the right turning radius, a wheelchair-friendly sink at the right height, and a safe space for daily care that protects both Axel and his mom.' },
  { type: 'numberedCard', number: '02', title: 'Dream Bedroom', body: "A safe, calming, beautiful space designed entirely around Axel's interests — somewhere he can rest, recover, and dream." },
  { type: 'sectionLabel', text: 'How You Can Help', variant: 'yellow' },
  { type: 'headline', text: "Help us build Axel's *dream*", size: 'medium' },
  { type: 'paragraph', text: 'Every dollar goes directly to materials, labor, and design for Axel’s new space. Zero platform fees.', muted: true },
  { type: 'donationTiers',
    featured: { amount: '500', label: 'Furniture & Flooring', description: "Adaptive furniture or accessible flooring — the structural pieces that change Axel's daily life.", badge: 'Most Popular' },
    small: [
      { amount: '60', label: 'Paint & Supplies', description: 'Transforms walls into a dream canvas.' },
      { amount: '125', label: 'Bedding & Decor', description: 'The details that make a room feel like home.' },
    ],
  },
  { type: 'trustSignals' },
  { type: 'signature', note: "We can't wait to share what we're building for Axel. Stay tuned for the reveal." },
  { type: 'button', label: "See Axel's Story", href: 'https://sunshineonaranneyday.com/kids/axel', variant: 'dark' },
  { type: 'spacer', height: 16 },
];

const monthlyBlocks = [
  { type: 'sectionLabel', text: 'March 2026 Update', variant: 'dark' },
  { type: 'headline', text: 'Building dreams, changing *lives*', size: 'large' },
  { type: 'paragraph', style: 'lede', text: "Here's what your support made possible this month." },
  { type: 'sectionLabel', text: 'Impact So Far', variant: 'yellow' },
  { type: 'stats', items: [
    { value: '187+', label: 'Rooms Built' },
    { value: '108+', label: 'Kids Served' },
    { value: '14', label: 'Years of Impact' },
  ]},
  { type: 'divider' },
  { type: 'sectionLabel', text: 'Recently Completed', variant: 'yellow' },
  { type: 'kidCard',
    label: 'Just Completed',
    kid: { name: 'Adrian', slug: 'adrian-2025', age: '19', diagnosis: 'Cerebral Palsy', heroImage: 'kids/adrian/photo-18', roomTypes: ['Accessible Bathroom', 'Dream Bedroom'], status: 'completed' },
    linkLabel: "Read Adrian's story",
  },
  { type: 'sectionLabel', text: 'In Progress', variant: 'dark' },
  { type: 'kidCard',
    label: 'Coming Soon',
    kid: { name: 'Axel', slug: 'axel', age: '11', diagnosis: 'Cerebral Palsy with Dystonia', heroImage: 'kids/axel/1774377856789-Axel.jpg', roomTypes: ['Accessible Bathroom', 'Dream Bedroom'], status: 'upcoming' },
    linkLabel: 'Meet Axel',
  },
  { type: 'sectionLabel', text: 'Upcoming Events', variant: 'dark' },
  { type: 'eventCard',
    name: 'SOARD Annual Golf Tournament',
    date: 'May 12, 2026 · TPC Sugarloaf',
    url: 'https://sunshineonaranneyday.com/events/golf',
  },
  { type: 'divider', size: 'large' },
  { type: 'headline', text: 'Help us build the *next* dream room', size: 'medium', align: 'center' },
  { type: 'paragraph', text: 'Every dollar goes directly to building life-changing spaces — at no cost to families.', muted: true, align: 'center' },
  { type: 'button', label: 'Donate Now', href: 'https://sunshineonaranneyday.com/donate', variant: 'primary' },
  { type: 'trustSignals' },
  { type: 'signature', note: "March was a big month — Adrian's reveal brought us to tears, and we're already deep into planning Axel's project. Thank you for making every single room possible." },
];

const revealInviteBlocks = [
  { type: 'revealInvite',
    label: 'Save the Date',
    kid: { name: 'Adrian', slug: 'adrian-2025', heroImage: 'kids/adrian/photo-18' },
    headline: "You're invited to Adrian's *reveal day*",
    intro: "We're thrilled to invite you to a special reveal of Adrian's newly renovated accessible bathroom and dream bedroom.",
    date: '2026-06-15',
    time: '3:00 PM',
    endTime: '5:00 PM',
    location: 'The Ramirez Family Home',
    address: '1234 Sunshine Lane, Roswell, GA 30076',
    profileLabel: "See Adrian's Story",
  },
  { type: 'sectionLabel', text: 'About Adrian', variant: 'yellow' },
  { type: 'paragraph', text: "Adrian was born prematurely at 27 weeks during Hurricane Katrina. Today, at 19, he requires total physical care — and his current bathroom is unsafe and exhausting for him and his mom. His new spaces will bring safety, dignity, and joy to daily life." },
  { type: 'sectionLabel', text: 'Made Possible By', variant: 'yellow' },
  { type: 'paragraph', text: "**The Myfifident Foundation** and our in-kind partners — including new partner **Bell Cabinets**, plus WYP Construction, Pella, Real Floors, MSI, Sherwin Williams, and so many more. Thank you for changing the lives of Atlanta's children." },
  { type: 'sectionLabel', text: 'A Few Details', variant: 'dark' },
  { type: 'numberedCard', number: '01', title: 'Hold your photos until after', body: "The family hasn't seen the finished room yet. Please hold all reveal photos until we say it's safe to share." },
  { type: 'numberedCard', number: '02', title: 'Arrive 15 minutes early', body: "We want everyone in place before Adrian arrives. Park along the street — we'll have signs." },
  { type: 'numberedCard', number: '03', title: 'Bring your tissues', body: 'No really. These reveals are emotional in the best way.' },
  { type: 'signature', note: "We hope you'll join us to celebrate Adrian and his new space." },
  { type: 'spacer', height: 16 },
];

const fixtures = [
  { file: 'email-preview-adrian-2025.html',     subject: "Adrian's Dream Room is Complete", preheader: "Adrian's story is one of perseverance, love, and joy. See the transformation.", blocks: adrianBlocks },
  { file: 'email-preview-kickoff-axel.html',    subject: 'Meet Axel — Our Next Project',     preheader: "Meet Axel — our next dream room project. Here's their story and how you can help.", blocks: axelBlocks },
  { file: 'email-preview-monthly-march.html',   subject: 'SOARD March 2026 Update',          preheader: "Your March 2026 SOARD update: 187+ rooms built, 108+ kids served, and we're just getting started.", blocks: monthlyBlocks },
  { file: 'email-preview-reveal-invite.html',   subject: "You're invited to Adrian's reveal day", preheader: "Save the date — Sunday, June 15, 2026 · 3:00 PM. Come celebrate Adrian.", blocks: revealInviteBlocks },
];

console.log(`Rendering ${fixtures.length} previews · ${BLOCK_TYPES.length} block types available`);

let usedTypes = new Set();
for (const fx of fixtures) {
  const tpl = customTemplate({ blocks: fx.blocks }, { subject: fx.subject, preheader: fx.preheader });
  if (!tpl.html || tpl.html.length < 1000) {
    throw new Error(`Render too short for ${fx.file}: ${tpl.html.length} chars`);
  }
  for (const b of fx.blocks) usedTypes.add(b.type);
  writeFileSync(resolve(root, fx.file), tpl.html);
  console.log(`  ✓ ${fx.file} — ${tpl.html.length.toLocaleString()} chars`);
}

const unused = BLOCK_TYPES.filter(t => !usedTypes.has(t));
if (unused.length) {
  console.log(`\nUnused blocks (not in any preview): ${unused.join(', ')}`);
}
console.log('\nDone.');
