/**
 * The email design's version. Drafts waiting in Kit remember the EMAIL_DESIGN
 * they were written in, and the site rebuilds any untouched draft from an
 * older one by itself. So a change to how the emails look has to change
 * EMAIL_DESIGN too, or the drafts already in Kit keep the old look.
 *
 * If this fails after you changed the emails on purpose:
 *   1. set EMAIL_DESIGN in functions/api/_reveal-invite-email.js to today's date
 *      (add a letter for a second change on the same day: '2026-11-09b'),
 *   2. put that design and the hash this test prints into RECORDED below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { revealInviteEmail, EMAIL_DESIGN } from '../functions/api/_reveal-invite-email.js';
import { projectKickoffEmail, projectRevealEmail } from '../functions/api/_project-email.js';

const RECORDED = { design: '2026-11-09f', hash: '4eb3e39ff53059ea' };

const CF = 'https://imagedelivery.net/abc123';
const KID = {
  slug: 'rowan-test',
  name: 'Rowan',
  year: 2027,
  ages: [8],
  status: 'completed',
  heroSummary: 'Rowan loves trains, the color green and his big sister. SOARD is building a therapy room and an accessible bathroom so he can grow up at home.',
  bio: 'Rowan is eight. He has cerebral palsy, and the family’s home has no room for his therapy.',
  roomTypes: ['Therapy Room', 'Accessible Bathroom'],
  photos: Array.from({ length: 6 }, (_, i) => ({ url: `${CF}/kids/rowan-${i}/public`, alt: `Rowan ${i}` })),
  beforeAfterPhotos: [{ before: `${CF}/kids/rowan-before/public`, after: `${CF}/kids/rowan-after/public` }],
  revealVideo: '0123456789abcdef0123456789abcdef',
  revealQuote: '“He hasn’t stopped smiling since,” said Mom.',
  partnerLogos: [
    { name: 'Stilwell Casting', url: `${CF}/partners/stilwell/public` },
    { name: 'Fine Lines Painting', url: `${CF}/partners/fine-lines/public` },
    { name: 'Bin There Dump That', url: `${CF}/partners/bin-there/public` },
  ],
  zeffyUrl: 'https://www.zeffy.com/en-US/donation-form/rowan',
};

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

test('a change to how the emails look changes EMAIL_DESIGN too, so drafts in Kit get the new look', () => {
  const html = [
    revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '100 Example Way, Atlanta, GA 30301', notes: 'Park on the street.' }).html,
    projectKickoffEmail({ kid: KID }).html,
    projectRevealEmail({ kid: KID }).html,
  ].join('\n');
  const now = { design: EMAIL_DESIGN, hash: sha(html) };
  assert.deepEqual(now, RECORDED,
    `The emails look different from design ${RECORDED.design}. If that's on purpose, set EMAIL_DESIGN to a new value and RECORDED to { design: '<it>', hash: '${now.hash}' } (see the top of this file).`);
});
