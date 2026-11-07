/**
 * The page's first words, so it isn't empty on day one
 * ===========================================================================
 * Written once, from SOARD's own public wording (the overview, /ways-to-give/),
 * with no figures that aren't already public. Everything here is edited in
 * Documents and Members afterwards; deleting one doesn't bring it back.
 */

import { getSettings, saveSettings, saveDoc, addDocOnce, saveWish, saveAsk } from './_advisory.js';

const OVERVIEW_URL = 'https://files.sunshineonaranneyday.com/advisory/SOARD_Advisory%20Board%20Overview.docx.pdf';

const AGREEMENT = `I agree to serve on the Sunshine on a Ranney Day Advisory Board for a one-year term. I understand that:

- I'll attend at least four meetings a year, and help when I can in between.
- We share a goal of raising the funds for one SOARD makeover each year, through gifts, sponsorships, introductions, events, and fundraisers.
- A fundraiser I host needs SOARD's approval before it's announced.
- I'll be a positive ambassador for SOARD and the families it serves.
- What I learn about a child or family stays private unless SOARD has shared it publicly, and a reveal belongs to the family, so I won't share anything about a makeover before SOARD does.
- I'll tell SOARD about any relationship that could create a real or perceived conflict of interest.
- The Advisory Board is advisory and ambassadorial. I hold no fiduciary, governance, operational, budgetary, staffing, or voting authority, and I don't sign or commit anything on SOARD's behalf.`;

const DOCS = [
  { kind: 'agreement', title: 'Advisor agreement', body: AGREEMENT },
  { kind: 'overview', title: 'Advisory Board overview', body: 'What the Advisory Board is, what members do, and what we ask.', url: OVERVIEW_URL },
  { kind: 'pitch', title: 'Your 30-second pitch', body: `Sunshine on a Ranney Day builds life-changing spaces for children with special needs, because every child deserves a space that makes them feel safe, seen, and loved.

I'm on their Advisory Board, and together we're raising the funds for one makeover this year: a real room, for a real child. Can I tell you how you can help?` },
  { kind: 'post', title: 'A post to share', body: `I'm proud to serve on the Advisory Board of Sunshine on a Ranney Day. Every child deserves a space that makes them feel safe, seen, and loved, and this year our group is raising the funds for one makeover for a child with special needs. Will you help?` },
  { kind: 'sponsor', title: 'For a company that wants to help', body: `Companies can sponsor a room makeover, fund an event, or provide in-kind services. Partners receive recognition on SOARD's website, at events, and in media.

Know a company that might be interested? Add them under Introductions, and we'll take it from there.` },
  { kind: 'matching', title: 'Employer matching', body: `Many companies match donations, sometimes 2:1 or even 3:1, so a $500 gift could become $1,500.

1. Ask your HR team or benefits portal whether your company matches gifts.
2. If it does, submit a request after you give. They'll want SOARD's legal name and EIN, which are at the bottom of this page.
3. Tell us when it comes through, so it counts toward the goal.` },
  { kind: 'hosting', title: 'How to host a fundraiser', body: `1. Tell us your idea with the form on this page. It can be small: a dinner, a backyard party, a night at a local restaurant.
2. We'll say yes or suggest a change. Please wait for a yes before announcing it.
3. We'll set up a page for it, so every gift counts toward the goal and every donor gets a receipt.
4. Share your page, host your event, and tell us how it went.` },
];
const WISHES = [
  { title: 'Trade partners', detail: 'Plumbers, electricians, HVAC, flooring, and painters who could donate time or materials.' },
  { title: 'Companies that could sponsor a room', detail: 'A business, or someone who can open the door to one.' },
  { title: 'Places to host a fundraiser', detail: 'A restaurant, a venue, or a neighborhood that would welcome us.' },
];
const FIRST_ASK = { title: 'Who’s one person we should meet?', body: 'Think of one person who would love what SOARD does: a business owner, a builder, a neighbor. An introduction is all it takes. Add them under Introductions, and we’ll do the rest.' };

const SITE = 'https://sunshineonaranneyday.com';
/** Their Documents page on day one: SOARD's own public pages, each edited or deleted like anything else there */
const LIBRARY = [
  ['about', 'Our story', 'How SOARD began and who it serves', '/about/'],
  ['about', 'How a makeover works', 'From an application to the reveal', '/how-it-works/'],
  ['about', 'The kids', 'Every child and every room', '/kids/'],
  ['about', 'Who leads SOARD', 'The team and the board', '/about/leadership/'],
  ['about', 'In the news', 'Stories about SOARD', '/publicity/'],
  ['about', 'Questions people ask', 'Answers to pass along', '/faq/'],
  ['donors', 'Ways to give', 'Every way someone can help', '/ways-to-give/'],
];
/** The four papers SOARD hands any donor, by their exact titles. Anything else of the board's stays off until someone turns it on */
const FOR_DONORS = ['w-9', 'ein letter', 'irs 501(c)(3) determination letter', 'charitable organization permit'];

async function seedLibrary(DB, boardDocs) {
  if ((await getSettings(DB)).library) return false;
  for (const [i, [shelf, title, note, path]] of LIBRARY.entries()) await addDocOnce(DB, `ad_seedlib${'abcdefghijklmnop'[i]}`, { kind: 'library', shelf, title, note, url: `${SITE}${path}`, sort: 100 + i }, { by: 'SOARD' });
  const papers = boardDocs ? await boardDocs() : [];
  // (read last, so a choice someone made while this ran stays as they made it)
  const chosen = !!(await getSettings(DB)).boardDocs;
  await saveSettings(DB, { ...(chosen ? {} : { boardDocs: papers.filter((d) => FOR_DONORS.includes(String(d.title).trim().toLowerCase())).map((d) => d.id) }), library: true });
  return true;
}

/** Fixed ids, and the flag written last: a first load that fails partway finishes on the next, with nothing doubled */
export async function seedOnce(DB, boardDocs = null) {
  await seedFirst(DB);
  return seedLibrary(DB, boardDocs);
}
async function seedFirst(DB) {
  if ((await getSettings(DB)).seeded) return false;
  const docId = { agreement: 'ad_seedagreement', overview: 'ad_seedoverview', pitch: 'ad_seedpitch', post: 'ad_seedpost', sponsor: 'ad_seedsponsor', matching: 'ad_seedmatching', hosting: 'ad_seedhosting' };
  for (const [i, d] of DOCS.entries()) await saveDoc(DB, { ...d, id: docId[d.kind], sort: i }, { by: 'SOARD' });
  for (const [i, w] of WISHES.entries()) await saveWish(DB, { ...w, id: ['w_seedtrades', 'w_seedcompanies', 'w_seedplaces'][i] }, { by: 'SOARD' });
  await saveAsk(DB, { ...FIRST_ASK, id: 'ask_seedfirst' }, { by: 'SOARD' });
  await saveSettings(DB, { seeded: true });
  return true;
}
