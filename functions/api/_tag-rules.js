/**
 * Which of JobTread's tags a file gets: the rules the sorter and the move share
 * ===========================================================================
 * Photos and videos get Before, During or After by when they were taken
 * (./_photo-stages.js). Everything else by these rules, in this order:
 *   1. A private paper (a family's or anyone's: letters, consents,
 *      summaries, agreements, scopes, applications, releases, medical,
 *      waivers, W-9s, insurance) gets no sharing tag, ever.
 *   2. Costs (staff only): what QuickBooks sends, a file on a bill, an order
 *      or a bid request, and files named like a quote, estimate, bill,
 *      invoice or receipt.
 *   3. Design: layouts, presentations, inspiration, 3Ds, renderings,
 *      elevations, mood boards.
 *   4. Plans: plan sets, construction sets, specs, templates (not a letter
 *      template).
 *   5. An old tag's own meaning, when the file's name says nothing:
 *      .FinalPlans and .BuildSpecDocs → Plans; .WorkingPlans and Design
 *      Documents → Design; .PricingQuotes → Costs.
 * A file nothing places gets no tag (staff only) and is listed.
 *
 * The old tags retire once their files have moved (Peter, Nov 11 2026: "can
 * you migrate these over too?"). In Kind, COI and W-9 stay. _MakeoverFamily
 * stays on family papers only (families see their papers, never photos or
 * design) until those become JobTread documents.
 */

export const STAGE_TAGS = ['Before', 'During', 'After'];
export const KEPT = new Set(['in kind', 'coi', 'w-9']);
export const FAMILY_TAG = '_MakeoverFamily';

const low = (s) => String(s || '').trim().toLowerCase();
const words = (name) => ` ${String(name || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[_\-.()[\]]+/g, ' ')} `;

/** A private paper: never on a sharing tag */
export const PRIVATE = /\b(letters?|consents?|summary|summaries|agreements?|scope|application|release|medical|waiver|w ?9|insurance|coi|diagnos\w*|contract|signed)\b/;
/** A family paper: stays on _MakeoverFamily (families see their papers) */
export const FAMILY_PAPER = /\b(letters?|consents?|summary|agreements?|scope|application|release|medical|waiver|contract|signed|invite|invitation|welcome)\b/;
const COSTS = /\b(quotes?|quotation|estimates?|bills?|invoices?|receipts?|pricing|price ?sheet|po)\b/;
const DESIGN = /\b(layouts?|presentation|inspiration|3d|renders?|renderings?|elevations?|mood ?boards?|design boards?)\b/;
const PLANS = /\b(plans?|plan set|construction set|specs?|spec sheet|specifications?|templates?)\b/;

/** What an old tag's files go to when nothing else places them, and whether its photos count as Before or During */
export const OLD_MEANING = {
  '.beforepics': { photos: 'Before' },
  'progress photos': { photos: 'During' },
  '.finalplans': { docs: 'Plans' },
  '.buildspecdocs': { docs: 'Plans' },
  '.workingplans': { docs: 'Design' },
  'design documents': { docs: 'Design' },
  '.pricingquotes': { docs: 'Costs' },
  '_sponsor': {},
  [low(FAMILY_TAG)]: {},
};
/** Every old tag that retires: the ones above and the ":" construction tags (their photos During) */
export const isRetiring = (name) => low(name) in OLD_MEANING || /^:/.test(String(name || '').trim());
const meaningOf = (name) => OLD_MEANING[low(name)] || (/^:/.test(String(name || '').trim()) ? { photos: 'During' } : null);

/**
 * The tag for a file that isn't a dated photo: 'Costs' | 'Design' | 'Plans' | null, with why.
 * file: { name, createdBy, documentType }; oldTags: the names of the retiring tags it carries
 */
export function docPick(file, oldTags = []) {
  const w = words(file.name);
  if (PRIVATE.test(w) && !/\bletter template\b/.test(w)) return { tag: null, why: 'a private paper' };
  if (/quickbooks/i.test(file.createdBy || '')) return { tag: 'Costs', why: 'sent by QuickBooks' };
  if (['vendorBill', 'vendorOrder', 'bidRequest'].includes(file.documentType)) return { tag: 'Costs', why: 'on a bill, order or bid request' };
  if (COSTS.test(w)) return { tag: 'Costs', why: 'named like a quote, bill or receipt' };
  if (DESIGN.test(w)) return { tag: 'Design', why: 'named like a design' };
  if (PLANS.test(w)) return { tag: 'Plans', why: 'named like plans' };
  for (const t of oldTags) { const m = meaningOf(t); if (m?.docs) return { tag: m.docs, why: `was on ${t}` }; }
  return { tag: null, why: 'nothing places it' };
}

/** For a photo or video the sorter couldn't date: the stage its old tag means, if any */
export function oldStage(oldTags = []) {
  for (const t of oldTags) { const m = meaningOf(t); if (m?.photos) return { tag: m.photos, why: `was on ${t}` }; }
  return { tag: null, why: 'no time taken, and no old tag says' };
}

/**
 * The move for one file: which of its tags come off and which goes on.
 * file: { name, kind: 'photo' | 'video' | 'doc', tags: [{ id, name }] }; pick: { tag, why } (tag name or null)
 * → { add: tag name | null, remove: [tag ids], keepFamily }
 */
export function moveFor(file, pick) {
  const retiring = file.tags.filter((t) => isRetiring(t.name));
  const isFamily = (t) => low(t.name) === low(FAMILY_TAG);
  const w = words(file.name);
  // A family paper stays the family's, a PDF or a picture of one ("Signed Layout.jpg")
  const familyPaper = FAMILY_PAPER.test(w);
  // Off the family's tag: a photo or video that isn't a paper, and anything placed in Design, Plans or Costs.
  // A document nothing places keeps the family's access (it may be theirs), and is listed.
  const offFamily = !familyPaper && (file.kind !== 'doc' || ['Design', 'Plans', 'Costs'].includes(pick.tag));
  const remove = retiring.filter((t) => (isFamily(t) ? offFamily : !!pick.tag || PRIVATE.test(w))).map((t) => t.id);
  return { add: pick.tag || null, remove, keepFamily: !offFamily };
}

/** A photo or video named like a paper ("Signed Layout.jpg", "Consent.heic"): never on a sharing tag */
export const isPrivateName = (name) => PRIVATE.test(words(name));
