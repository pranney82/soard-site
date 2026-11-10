/**
 * test-advisory-page.mjs — the advisors' page, Run it, and the Board | Advisory switch, in a real browser
 * ============================================================================
 * Serves public/ with the admin's real CSP from public/_headers and answers /api/advisory-* from made-up data kept in
 * memory, per tab (the server's own tests are tests/advisory*.test.mjs). Made-up people only: the repo is public.
 * Walks every page as an advisor, the person who runs the group, a committee member and an admin, empty (launch day)
 * and filled, at 390, 768, 1280 and 1440, and checks each one for:
 *   - nothing past the page's right edge, no console errors, no em dashes in the words on the page
 *   - dollars on Fundraise and Run it only; no email address but the group's and the questions address
 *   - Run it only for who runs the group; answers, signing and introductions only for an advisor
 * Then uses it: answering the ask, an introduction, a fundraiser idea, signing (refused, then right), renewing; running
 * the group (an introduction's status, an ask, a paper from a draft, the emails switch); what a refused save and a
 * page that won't open say; and the switch at the top of Board leaving the tabs exactly where they were.
 * Screenshots land in SHOTS (default: test-results/advisory-page). Exits non-zero on any failure.
 *
 *   node scripts/test-advisory-page.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'public');
const SHOTS = process.env.SHOTS || join(import.meta.dirname, '..', 'test-results', 'advisory-page');
mkdirSync(SHOTS, { recursive: true });
const WIDTHS = (process.env.WIDTHS || '390,768,1280,1440').split(',').map(Number);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CSP = (() => {
  const lines = readFileSync(join(ROOT, '_headers'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith('/admin/*'));
  return lines.slice(at).find((l) => /^\s+Content-Security-Policy:/.test(l)).split(': ').slice(1).join(': ').trim();
})();
const adminStyles = [...readFileSync(join(ROOT, 'admin', 'index.html'), 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

// ─── Made-up data ───────────────────────────────────────────────────
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const later = (days) => new Date(Date.parse(`${TODAY}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const PEOPLE = [
  { slug: 'sam-ortiz', name: 'Sam Ortiz', photo: '', organization: 'Ortiz Building Supply', bio: 'Sam has sold building materials to contractors across north Georgia for twenty years and loves a good job site.', linkedin: 'https://www.linkedin.com/in/made-up' },
  { slug: 'dana-bright', name: 'Dana Bright', photo: '/cdn-cgi/imagedelivery/x/dana/w=240', organization: 'Bright Events', bio: '', linkedin: '' },
  { slug: 'lee-a-very-long-name-hyphenated-person', name: 'Lee Alexandria Montgomery-Featherstonehaugh', photo: '', organization: 'A Company With A Really Rather Long Name And Partners LLC', bio: 'Word '.repeat(90), linkedin: '' },
];
const KINDS = [{ id: 'library', label: 'Document' }, { id: 'agreement', label: 'Advisor agreement', sign: true }, { id: 'overview', label: 'Overview' }, { id: 'pitch', label: '30-second pitch' }, { id: 'post', label: 'Post to share' }, { id: 'sponsor', label: 'Sponsor one-pager' }, { id: 'matching', label: 'Employer matching steps' }, { id: 'hosting', label: 'How to host a fundraiser' }];
const STATUSES = [{ id: 'thanks', label: 'Thanks', sub: 'We have it and we’ll take a look' }, { id: 'talking', label: 'Talking', sub: 'We’re in touch with them' }, { id: 'yes', label: 'Said yes', sub: 'They’re helping SOARD' }, { id: 'not-now', label: 'Not now', sub: 'Not the right time' }];
const HELP = [{ id: 'donor', label: 'Could give' }, { id: 'sponsor', label: 'Could sponsor' }, { id: 'vendor', label: 'Trade or vendor' }, { id: 'volunteer', label: 'Could volunteer' }];
const ME = {
  advisor: { kind: 'advisor', name: 'Sam Ortiz', slug: 'sam-ortiz', runs: false, answers: true },
  lead: { kind: 'lead', name: 'Morgan Lead', slug: 'morgan-lead', runs: true, answers: false },
  committee: { kind: 'committee', name: 'Casey Board', slug: 'casey-board', runs: false, answers: false },
  admin: { kind: 'admin', name: '', slug: '', runs: true, answers: false },
};
const org = { name: 'Sunshine on a Ranney Day', legalName: 'Sunshine on a Ranney Day Incorporated', ein: '00-0000000', website: 'sunshineonaranneyday.com', mission: 'Every child deserves a space that makes them feel safe, seen, and loved.' };
const SHELVES = [{ id: 'about', label: 'About SOARD', sub: 'Who we are' }, { id: 'marketing', label: 'Marketing', sub: 'What to share' }, { id: 'donors', label: 'For donors and sponsors', sub: 'What they ask for' }, { id: 'group', label: 'For the group', sub: '' }];
const BRAND = { logos: [{ key: 'lightTagline', name: 'White background', sub: '', bg: 'light', src: '/cdn-cgi/imagedelivery/x/brand-a/w=560', png: '/api/download-logo?id=a' }, { key: 'darkTagline', name: 'Dark background', sub: '', bg: 'dark', src: '/cdn-cgi/imagedelivery/x/brand-b/w=560', png: '/api/download-logo?id=b' }], kit: '/SOARD-Logo-Kit.zip', kitSize: '2.6 MB', seal: 'https://imagedelivery.net/x/partners/seal/public' };
const emptyPortal = (who) => ({
  ok: true, me: ME[who], today: TODAY, term: who === 'advisor' ? { started: later(-14), ends: later(351), renewedOn: '', left: '', canRenew: false } : null,
  lead: { slug: 'morgan-lead', name: 'Morgan Lead', photo: '' }, groupEmail: 'advisory@soardcharity.com', meetings: [], ask: null, todos: [], makeover: { state: 'open' },
  coming: { reveals: [], events: [], hosted: [] }, rooms: [], wishes: [], intros: [], introStatuses: STATUSES, introHelp: HELP, hosted: [],
  fundraise: { goal: 25000, raised: 0, mine: who === 'advisor' ? 0 : null, gifts: who === 'advisor' ? 0 : null, pageUrl: '', groupUrl: '', ready: false, at: null },
  share: [], people: PEOPLE.slice(0, 2), papers: [], filings: [], org,
  shelves: SHELVES, library: [], fromBoard: [], brand: BRAND, photos: [], impact: null, contact: { name: 'SOARD', email: 'info@soardcharity.com' },
});
const AGREE = { id: 'ad_agreement2', kind: 'agreement', title: 'Advisor Agreement', body: 'As a member of the Advisory Board, I agree to:\n\n- Serve a one-year term\n- Attend four meetings a year', version: 1, files: [], signedByMe: null };
const filledPortal = (who) => ({
  ...emptyPortal(who),
  term: who === 'advisor' ? { started: later(-320), ends: later(40), renewedOn: '', left: '', canRenew: true } : null,
  ask: { id: 'ask_abcdefgh', title: 'Do you know a licensed plumber who’d work with us on Colin’s bathroom?', body: 'We need one for a week in March.', link: 'https://example.com/', mine: null },
  todos: who === 'advisor' ? [{ kind: 'sign', id: AGREE.id, title: 'Sign the Advisor Agreement' }, { kind: 'renew', title: 'Renew for another year', ends: later(40) }] : [],
  meetings: [{ id: 'm_abcdefgh', title: 'Q1 2027 Advisory Board Meeting', date: later(20), start: '18:30', end: '19:30', location: 'SOARD office', address: '250 Hembree Park Dr', inviteNote: '', sections: [{ id: 's1', title: 'Welcome', minutes: 10, items: [{ id: 'i1', title: 'Welcome and introductions', presenter: 'Morgan Lead', docs: [] }] }], files: [], meet: 'https://meet.google.com/aaa-bbbb-ccc', invited: true, myAnswer: '', recap: null }],
  makeover: { state: 'kid', slug: 'made-up-kid', name: 'Jordan', photo: '/cdn-cgi/imagedelivery/x/kid/w=640', url: '/kids/made-up-kid/', stage: 'Being built', demo: later(10), reveal: { date: later(60), window: null, confirmed: true } },
  coming: {
    reveals: [{ date: later(30), time: '', window: null, confirmed: true, name: 'Riley', slug: 'riley', url: '/kids/riley/', photo: '/cdn-cgi/imagedelivery/x/r/w=320' }, { date: '', time: '', window: { part: 'mid', month: later(45).slice(0, 7), label: 'mid month' }, confirmed: false }],
    events: [{ slug: 'evening', title: 'An Evening of Sunshine', date: later(90), endDate: later(90), time: '6:00 PM', location: 'The Foundry', url: '/events/evening/' }],
    hosted: [{ id: 'h_abcdefgh', title: 'Trivia night at Dana’s', date: later(25), where: 'Roswell', giveUrl: 'https://www.zeffy.com/made-up' }],
  },
  rooms: [1, 2, 3, 4, 5].map((n) => ({ date: later(-n * 30), name: `Kid ${n}`, slug: `kid-${n}`, url: `/kids/kid-${n}/`, photo: '/cdn-cgi/imagedelivery/x/k/w=320' })),
  wishes: [{ id: 'w_abcdefgh', title: 'A licensed electrician in Cherokee County', detail: 'We have three makeovers there this spring.' }, { id: 'w_bcdefghi', title: 'A contact at a national paint company', detail: '' }],
  intros: who === 'advisor' ? [{ id: 'in_abcdefgh', name: 'Pat Jones', company: 'Jones Electric', status: 'talking', note: 'We left Pat a message on Tuesday.', at: `${later(-9)}T15:00:00Z`, updatedAt: `${later(-2)}T15:00:00Z` }, { id: 'in_bcdefghi', name: 'Robin Fields', company: '', status: 'yes', at: `${later(-30)}T15:00:00Z`, updatedAt: `${later(-5)}T15:00:00Z` }] : [],
  hosted: who === 'advisor' ? [{ id: 'h_bcdefghi', title: 'Trivia night', status: 'approved', when: 'March', note: 'Holly will send your page.' }] : [],
  fundraise: { goal: 25000, raised: 9150, mine: who === 'advisor' ? 1200 : null, gifts: who === 'advisor' ? 6 : null, pageUrl: who === 'advisor' ? 'https://www.zeffy.com/en-US/peer-to-peer/made-up-sam' : '', groupUrl: 'https://www.zeffy.com/en-US/peer-to-peer/made-up', ready: true, at: new Date().toISOString() },
  share: [
    { id: 'ad_pitch1234', kind: 'pitch', title: 'Your 30-second pitch', body: 'Sunshine on a Ranney Day builds free dream bedrooms for children with special needs in Atlanta.', files: [] },
    { id: 'ad_post12345', kind: 'post', title: 'A post to share', body: 'I’m proud to serve on the Advisory Board.', files: [] },
    { id: 'ad_spons1234', kind: 'sponsor', title: 'Sponsor one-pager', body: 'A sponsorship funds a free makeover.', files: [{ id: 'f_abcdefgh', name: 'Sponsor one-pager.pdf', type: 'application/pdf', size: 204800, at: `${later(-3)}T12:00:00Z` }] },
    { id: 'ad_match1234', kind: 'matching', title: 'Employer matching steps', body: '1. Ask your HR team.\n2. Give through your page.', files: [] },
    { id: 'ad_host12345', kind: 'hosting', title: 'How to host a fundraiser', body: 'Send your idea from this page.', files: [] },
  ],
  people: PEOPLE,
  papers: [AGREE, { id: 'ad_overv1234', kind: 'overview', title: 'Advisory Board Overview', body: 'What the Advisory Board is.', url: 'https://files.example.com/advisory/overview.docx.pdf', version: 1, files: [{ id: 'f_bcdefghi', name: 'Advisory Board Overview.pdf', type: 'application/pdf', size: 247000, at: `${later(-1)}T12:00:00Z` }] }],
  filings: [...Array(9)].map((_, i) => ({ title: `Form 990, ${2024 - i}`, year: 2024 - i, type: '990', url: `/files/financials/990-${2024 - i}.pdf` })),
  impact: { kids: 208, rooms: 295, byYear: [{ year: 2011 }] },
  library: [
    { id: 'ad_about1234', title: 'Our story', note: 'How SOARD began', shelf: 'about', url: 'https://example.com/about/', files: [] },
    { id: 'ad_brand1234', title: 'Brand and media kit', note: 'Logos and colors', shelf: 'marketing', url: 'https://example.com/branding/', files: [] },
    { id: 'ad_flyer1234', title: 'Event flyer', note: 'For a table at an event', shelf: 'marketing', url: '', files: [{ id: 'f_flyerabc', name: 'Flyer.pdf', type: 'application/pdf', size: 90000, at: `${later(-3)}T12:00:00Z` }] },
  ],
  fromBoard: [{ id: 'd_wninexx', title: 'W-9', file: { id: 'f_wninexx', name: 'W-9.pdf', type: 'application/pdf', size: 120000 } }, { id: 'd_irsletr', title: 'IRS 501(c)(3) determination letter', file: { id: 'f_irsletr', name: 'IRS.pdf', type: 'application/pdf', size: 120000 } }],
  photos: [1, 2, 3, 4].map((n) => ({ photo: `/cdn-cgi/imagedelivery/x/p${n}/public`, caption: `A room ${n}`, download: `/api/download-branding-photos?photo=${n}` })),
  org: { ...org, phone: '770-555-0100', email: 'info@soardcharity.com', irs: { exempt: true, since: '2011' }, address: { street: '1 Main St', city: 'Roswell', state: 'GA', zip: '30075' }, tagline: 'Dreams Built Here', bio: 'SOARD builds rooms.', founded: '2011', founders: 'Two people' },
});
const LIB_ADMIN = [{ id: 'ad_about1234', kind: 'library', title: 'Our story', note: 'How SOARD began', shelf: 'about', url: 'https://example.com/about/', shared: true, files: [], updatedAt: `${later(-1)}T12:00:00Z` }];
const emptyAdmin = (who) => ({
  ok: true, me: { kind: who, name: ME[who].name }, settings: { lead: 'morgan-lead', goal: 25000, termStart: later(-14), termEnd: later(351), emails: false, campaignId: '', campaignUrl: '', pages: {}, kid: '', carried: [], boardDocs: ['d_wninexx'] },
  leadName: 'Morgan Lead', groupEmail: 'advisory@soardcharity.com', group: null,
  advisors: PEOPLE.slice(0, 2).map((p) => ({ slug: p.slug, name: p.name, email: `${p.slug}@example.com`, photo: p.photo, organization: p.organization, term: { started: later(-14), ends: later(351), renewedOn: '', left: '' }, lastSeen: '', signed: {} })),
  missing: [], board: [{ slug: 'morgan-lead', name: 'Morgan Lead', committees: ['Advisory Board'] }, { slug: 'casey-board', name: 'Casey Board', committees: ['Advisory Board'] }],
  docs: [], docKinds: KINDS, shelves: SHELVES, boardDocs: [{ id: 'd_wninexx', title: 'W-9', file: { id: 'f_wninexx' } }, { id: 'd_bylawsx', title: 'Bylaws', file: { id: 'f_bylawsx' } }], asks: [], wishes: [], intros: [], introStatuses: STATUSES, introHelp: HELP, hosted: [], hostedStatuses: [{ id: 'new', label: 'New' }, { id: 'approved', label: 'Approved' }, { id: 'not-now', label: 'Not now' }, { id: 'done', label: 'Held' }],
  money: { goal: 25000, raised: 0, carried: [], ready: false, configured: true, at: null, error: null, byAdvisor: [], pages: [], unmatched: [], credits: [] },
  kids: [], makeover: { state: 'open' }, meetings: [], mail: [],
});
const filledAdmin = (who) => ({
  ...emptyAdmin(who),
  settings: { ...emptyAdmin(who).settings, campaignId: 'c-1', campaignUrl: 'https://www.zeffy.com/made-up' },
  group: { group: 'advisory@soardcharity.com', configured: true, ok: true, syncedAt: new Date().toISOString(), current: true, members: 7, missing: [] },
  advisors: PEOPLE.map((p, i) => ({ slug: p.slug, name: p.name, email: `${p.slug.slice(0, 12)}@example.com`, photo: p.photo, organization: p.organization, term: { started: later(-320), ends: i === 2 ? later(-3) : later(40), renewedOn: i ? '' : later(-1), left: '' }, lastSeen: i === 2 ? '' : `${later(-i - 1)}T15:00:00Z`, signed: { [AGREE.id]: i === 1 ? { year: Number(TODAY.slice(0, 4)), name: p.name, at: `${later(-400)}T15:00:00Z`, version: 0 } : i ? null : { year: Number(TODAY.slice(0, 4)), name: p.name, at: `${later(-4)}T15:00:00Z`, version: 1 } } })),
  missing: [{ slug: 'alex-rivera', name: 'Alex Rivera' }],
  docs: [...LIB_ADMIN, { ...AGREE, shared: true, updatedAt: `${later(-4)}T15:00:00Z`, updatedBy: 'x' }, { id: 'ad_overv1234', kind: 'overview', title: 'Advisory Board Overview', body: '', shared: true, version: 1, files: [{ id: 'f_bcdefghi', name: 'Advisory Board Overview.pdf', type: 'application/pdf', size: 247000, at: `${later(-1)}T12:00:00Z` }], updatedAt: `${later(-1)}T15:00:00Z` }, { id: 'ad_post12345', kind: 'post', title: 'A post to share', body: 'I’m proud to serve.', shared: false, version: 1, files: [], updatedAt: `${later(-2)}T15:00:00Z` }],
  asks: [
    { id: 'ask_abcdefgh', title: 'Do you know a licensed plumber?', body: 'A week in March.', link: '', sentAt: `${later(-6)}T15:00:00Z`, closedAt: '', at: `${later(-7)}T15:00:00Z`, by: 'x', answers: [{ slug: 'sam-ortiz', name: 'Sam Ortiz', answer: 'yes', note: 'My cousin does this.', at: `${later(-5)}T15:00:00Z`, via: 'page' }, { slug: 'dana-bright', name: 'Dana Bright', answer: 'no', note: 'Out of town that week.', at: `${later(-5)}T15:00:00Z`, via: 'email' }] },
    { id: 'ask_bcdefghi', title: 'Saved idea for April', body: '', link: '', sentAt: '', closedAt: '', at: `${later(-2)}T15:00:00Z`, by: 'x', answers: [] },
    { id: 'ask_cdefghij', title: 'An older ask', body: '', link: '', sentAt: `${later(-60)}T15:00:00Z`, closedAt: `${later(-30)}T15:00:00Z`, at: `${later(-61)}T15:00:00Z`, by: 'x', answers: [] },
  ],
  wishes: [{ id: 'w_abcdefgh', title: 'A licensed electrician in Cherokee County', detail: 'Three makeovers there this spring.', sort: 1 }],
  intros: [
    { id: 'in_abcdefgh', slug: 'sam-ortiz', by: 'Sam Ortiz', status: 'thanks', name: 'Pat Jones', company: 'Jones Electric', email: 'pat@example.com', phone: '770-555-0100', how: 'We’ve worked on a dozen houses together.', help: ['vendor', 'donor'], wish: '', at: `${later(-1)}T15:00:00Z`, updatedAt: `${later(-1)}T15:00:00Z`, updatedBy: '' },
    { id: 'in_bcdefghi', slug: 'dana-bright', by: 'Dana Bright', status: 'yes', name: 'Robin Fields', company: '', email: '', phone: '', how: '', help: [], wish: '', note: 'Joining in March.', at: `${later(-30)}T15:00:00Z`, updatedAt: `${later(-5)}T15:00:00Z`, updatedBy: 'holly' },
  ],
  hosted: [
    { id: 'h_abcdefgh', slug: 'dana-bright', by: 'Dana Bright', status: 'new', title: 'Trivia night at my office', when: 'A Thursday in March', where: 'Roswell', expected: '$2,000', notes: 'About 60 people.', at: `${later(-2)}T15:00:00Z` },
    { id: 'h_bcdefghi', slug: 'sam-ortiz', by: 'Sam Ortiz', status: 'approved', title: 'Golf outing', when: 'May', where: 'Alpharetta', expected: '', notes: '', date: later(80), giveUrl: 'https://www.zeffy.com/made-up', at: `${later(-40)}T15:00:00Z` },
    { id: 'h_cdefghij', slug: 'sam-ortiz', by: 'Sam Ortiz', status: 'done', title: 'Bake sale, long since held', when: 'Last spring', where: '', expected: '', notes: '', at: `${later(-200)}T15:00:00Z` },
  ],
  money: { goal: 25000, raised: 9150, carried: [], ready: true, configured: true, at: new Date().toISOString(), error: null, byAdvisor: PEOPLE.map((p, i) => ({ slug: p.slug, name: p.name, dollars: 1200 - i * 300, gifts: 6 - i })), pages: [], unmatched: [{ id: 'p-1', title: 'Fundraiser by Sam O.', url: 'https://www.zeffy.com/made-up-2' }], credits: [{ payment_id: 'pay_1', slug: 'dana-bright', dollars: 750, note: 'Gala table', at: `${later(-8)}T15:00:00Z`, by: 'x', who: 'Dana Bright' }] },
  kids: [{ slug: 'jordan-2026', name: 'Jordan', year: 2026, photo: '/cdn-cgi/imagedelivery/x/kid/w=320', url: '/kids/jordan-2026/' }],
  meetings: [],
  mail: [{ what: 'The monthly ask', at: `${later(-6)}T15:00:00Z` }],
});

// ─── The server ─────────────────────────────────────────────────────
const worlds = new Map();
const world = (key) => {
  if (!worlds.has(key)) {
    const [who, state] = key.split('/');
    worlds.set(key, { portal: state === 'filled' ? filledPortal(who) : emptyPortal(who), admin: state === 'filled' ? filledAdmin(who) : emptyAdmin(who), posts: [], refuse: null, down: null });
  }
  return worlds.get(key);
};
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
function portalPost(w, b, res) {
  const p = w.portal;
  if (b.action === 'activity') return json(res, 200, { ok: true });
  if (b.action === 'answer') { const mine = { answer: b.answer, note: b.note || '' }; p.ask = { ...p.ask, mine }; return json(res, 200, { ok: true, mine }); }
  if (b.action === 'intro') { const intro = { id: `in_${Date.now()}`, name: b.name, company: b.company, status: 'thanks', at: new Date().toISOString(), updatedAt: new Date().toISOString() }; p.intros = [intro, ...p.intros]; return json(res, 200, { ok: true, intro }); }
  if (b.action === 'host') { const hosted = { id: `h_${Date.now()}`, title: b.title, status: 'new', when: b.when, note: '' }; p.hosted = [hosted, ...p.hosted]; return json(res, 200, { ok: true, hosted }); }
  if (b.action === 'sign') {
    const paper = p.papers.find((x) => x.id === b.docId);
    if (Number(b.version) !== Number(paper?.version)) return json(res, 409, { ok: false, changed: true, error: 'These words have changed. Read the new version, then sign.' });
    if (b.name !== p.me.name) return json(res, 400, { ok: false, error: `Type your name as ${p.me.name} to sign` });
    const signed = { year: 2026, name: b.name, at: new Date().toISOString() };
    p.todos = p.todos.filter((t) => t.kind !== 'sign'); p.papers = p.papers.map((x) => (x.id === b.docId ? { ...x, signedByMe: signed } : x));
    return json(res, 200, { ok: true, signed });
  }
  if (b.action === 'renew') { p.todos = p.todos.filter((t) => t.kind !== 'renew'); p.term = { ...p.term, canRenew: false, ends: later(405) }; return json(res, 200, { ok: true, term: p.term }); }
  return json(res, 400, { ok: false, error: 'Unknown action' });
}
function adminPost(w, b, res) {
  const a = w.admin;
  if (b.action === 'intro-status') { a.intros = a.intros.map((i) => (i.id === b.id ? { ...i, status: b.status, note: b.note, updatedBy: 'them' } : i)); return json(res, 200, { ok: true }); }
  if (b.action === 'save-ask') { const ask = { id: `ask_${Date.now()}`, ...b.ask, sentAt: '', closedAt: '', answers: [] }; a.asks = [ask, ...a.asks]; return json(res, 200, { ok: true, ask }); }
  if (b.action === 'send-ask' && w.switched && b.emailsOk !== true) { a.settings = { ...a.settings, emails: true }; return json(res, 409, { ok: false, emails: true, error: 'Emails are on, so this will email every advisor.' }); }
  if (b.action === 'send-ask') { w.lastSent = a.settings.emails ? { sent: a.advisors.length, failed: 0 } : { off: true }; a.asks = a.asks.map((x) => (x.id === b.id ? { ...x, sentAt: new Date().toISOString() } : x.sentAt && !x.closedAt ? { ...x, closedAt: new Date().toISOString() } : x)); return json(res, 200, { ok: true, sent: w.lastSent }); }
  if (b.action === 'save-wish') { const wish = { id: `w_${Date.now()}`, ...b.wish }; a.wishes = [...a.wishes, wish]; return json(res, 200, { ok: true, wish }); }
  if (b.action === 'email-ask') return json(res, 200, { ok: true, sent: a.advisors.length, failed: 0 });
  if (b.action === 'save-doc' && b.base && a.docs.find((d) => d.id === b.doc.id)?.updatedAt !== b.base) return json(res, 409, { ok: false, current: a.docs.find((d) => d.id === b.doc.id), error: 'Someone saved this since you opened it.' });
  if (b.action === 'save-doc') { const had = a.docs.find((d) => d.id === b.doc.id); const doc = { id: b.doc.id || `ad_${Date.now()}`, files: [], updatedAt: new Date().toISOString(), version: 1, ...had, ...b.doc, ...(b.doc.url ? { url: /^https:/.test(b.doc.url) ? b.doc.url : `https://${b.doc.url}` } : {}) }; a.docs = [...a.docs.filter((d) => d.id !== doc.id), doc]; return json(res, 200, { ok: true, doc }); }
  if (b.action === 'send-welcome') { const fresh = (b.slugs || []).filter((x) => !a.welcomed?.[x]); a.welcomed = { ...a.welcomed, ...Object.fromEntries(fresh.map((x) => [x, new Date().toISOString()])) }; return json(res, 200, { ok: true, sent: fresh.length, failed: 0 }); }
  if (b.action === 'set-term') { w.terms = [...(w.terms || []), b]; return json(res, 200, { ok: true }); }
  if (b.action === 'save-settings') { if (b.settings.campaignUrl && !/^https:/.test(b.settings.campaignUrl)) b.settings.campaignUrl = `https://${b.settings.campaignUrl}`; a.settings = { ...a.settings, ...b.settings }; return json(res, 200, { ok: true, settings: a.settings }); }
  if (b.action === 'hosted-status') { a.hosted = a.hosted.map((x) => (x.id === b.id ? { ...x, status: b.status, date: b.date, giveUrl: b.giveUrl } : x)); return json(res, 200, { ok: true, hosted: a.hosted.find((x) => x.id === b.id) }); }
  if (b.action === 'pick-kid' && w.pickOk) { const k = a.kids[0]; a.makeover = { state: 'kid', slug: k.slug, name: k.name, photo: k.photo, url: k.url, stage: 'Getting ready' }; return json(res, 200, { ok: true, sync: { problems: ['Couldn’t set Monetary Sponsor in JobTread: not one of its choices'] } }); }
  if (b.action === 'pick-kid') return json(res, 409, { ok: false, error: 'Add SOARD Advisory Board in Partners first, then pick the kid.' });
  if (b.action === 'find-gifts') return json(res, 200, { ok: true, gifts: [{ id: 'pay_9', dollars: 500, at: 1, campaign: 'Evening of Sunshine' }] });
  return json(res, 200, { ok: true });
}
const boardStub = () => ({ ok: true, me: 'founder@soardcharity.com', settings: { admins: ['founder@soardcharity.com'], defaults: {}, template: { sections: [] } }, meetings: [], docs: [], members: [], access: { configured: true, ok: true, current: true, emails: 2, missing: [] }, numbers: {}, calendar: { ok: true }, mail: {}, mailRecent: [], welcome: {}, notesWaiting: [], approvals: {}, group: null, welcomeSending: false, welcomeSendingTo: [], welcomeAt: 1, google: null, people: { board: [], staff: [] }, setup: {}, packetTo: 0 });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const key = req.headers['x-world'] || 'advisor/filled';
  const w = world(key);
  if (p === '/__side.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
    return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${adminStyles}</style></head><body><main id="root" style="padding:24px"></main><script type="module">import { h, render } from '/admin/vendor.js'; import { BoardArea } from '/admin/board-admin.js'; render(h(BoardArea, {}), document.getElementById('root'));</script></body></html>`);
  }
  if (p === '/api/advisory-portal' || p === '/api/advisory-admin') {
    if (w.down?.redirect) { res.writeHead(302, { Location: 'https://soard.cloudflareaccess.com/cdn-cgi/access/login' }); return res.end(); }
    if (w.down?.html && (req.method === 'GET' || w.down.html === 'all')) { await readBody(req); res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Sign in</title>'); }
    if (w.down) return json(res, w.down.status, w.down.body);
    if (req.method === 'GET') return json(res, 200, p.endsWith('portal') ? w.portal : w.admin);
    const raw = await readBody(req);
    let b = {}; try { b = JSON.parse(raw.toString()); } catch { b = { multipart: true }; }
    w.posts.push({ path: p, ...b });
    if (w.refuse && b.action !== 'activity') { w.onRefuse?.(); return json(res, 409, { ok: false, error: w.refuse }); }
    return (p.endsWith('portal') ? portalPost : adminPost)(w, b, res);
  }
  if (p === '/api/board-admin') return json(res, 200, boardStub());
  if (p.startsWith('/api/')) return json(res, 200, { ok: true });
  if (p.startsWith('/cdn-cgi/imagedelivery')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PIXEL); }
  const file = join(ROOT, p.endsWith('/') ? `${p}index.html` : p);
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ...(file.endsWith('.html') ? { 'Content-Security-Policy': CSP } : {}) });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// The top bar holds six tabs, seven for whoever runs the group, at every width between a phone and a wide screen
async function barFits() {
  for (const who of ['advisor', 'admin']) {
    for (const width of [641, 700, 768, 820, 900, 1024, 1100, 1200, 1280, 1366, 1440, 1600]) {
      const page = await tab(`${who}/filled`, width);
      await page.goto(`${ORIGIN}/admin/advisory/`, { waitUntil: 'networkidle0' });
      const r = await page.evaluate(() => {
        const bar = document.querySelector('.bp-bar');
        const links = [...document.querySelectorAll('.bp-nav a')];
        return { over: bar.scrollWidth > bar.clientWidth + 1, page: document.documentElement.scrollWidth > innerWidth, rows: new Set(links.map((a) => Math.round(a.getBoundingClientRect().top))).size };
      });
      check(!r.over && !r.page && r.rows === 1, `the top bar fits: ${who} at ${width} (${JSON.stringify(r)})`);
      await page.close();
    }
  }
}

// ─── The browser ────────────────────────────────────────────────────
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-vsync', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
let passed = 0; const failures = []; const noise = [];
const check = (ok, what) => { if (ok) passed++; else { failures.push(what); console.log(`  ✗ ${what}`); } };
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
async function tab(key, width, { reduce = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  await page.setExtraHTTPHeaders({ 'x-world': key });
  if (reduce) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) noise.push(`${key} ${width}: ${m.text()}`); });
  page.on('pageerror', (e) => noise.push(`${key} ${width}: ${e.message}`));
  return page;
}
const open = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash).catch(() => {});
  await settle(160);
};
const textOf = (page) => page.evaluate(() => document.querySelector('.bp-main')?.innerText || document.body.innerText);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const has = (page, sel) => page.$(sel).then((x) => !!x);
const button = async (page, words) => {
  const hs = await page.$$('button, a.bp-btn');
  for (const b of hs) if ((await b.evaluate((x) => x.textContent.trim())) === words) return b;
  return null;
};
const press = async (page, words) => { const b = await button(page, words); check(!!b, `there's a button: ${words}`); if (b) { await b.evaluate((x) => x.scrollIntoView({ block: 'center' })); await b.click(); await settle(220); } return !!b; };
const allowedEmail = (e) => ['advisory@soardcharity.com', 'info@soardcharity.com'].includes(e);
const PAGES = { home: '#/', intros: '#/introductions', fundraise: '#/fundraise', meetings: '#/meetings', people: '#/people', documents: '#/documents', paper: `#/papers/${AGREE.id}`, meeting: '#/meetings/m_abcdefgh' };

for (const width of WIDTHS) {
  for (const who of ['advisor', 'lead', 'committee', 'admin']) {
    for (const state of ['empty', 'filled']) {
      const key = `${who}/${state}`;
      const page = await tab(key, width);
      await page.goto(`${ORIGIN}/admin/advisory/#/`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.bp-main');
      const tagged = `${who} ${state} ${width}`;
      check((await has(page, 'a[href="#/run"]')) === ME[who].runs, `${tagged}: Run it only for who runs the group`);
      const nav = await page.evaluate(() => {
        const links = [...document.querySelectorAll('.bp-nav a')].map((a) => a.getBoundingClientRect());
        const tools = document.querySelector('.bp-tools')?.getBoundingClientRect();
        const row = links[0].top === links.at(-1).top;
        return { row, right: links.at(-1).right, width: innerWidth, tools: tools?.left ?? 0, bottom: links[0].top > 300, clipped: [...document.querySelectorAll('.bp-nav__label')].filter((l) => l.offsetWidth && l.scrollWidth > l.offsetWidth + 1).length };
      });
      check(nav.row && nav.right <= nav.width && (nav.bottom || nav.right <= nav.tools) && !nav.clipped, `${tagged}: every page in the menu fits (${JSON.stringify(nav)})`);
      for (const [name, hash] of Object.entries(PAGES)) {
        await open(page, hash);
        const text = await textOf(page);
        const over = await overflow(page);
        check(over <= 0, `${tagged} ${name}: nothing past the right edge (${over}px)`);
        check(!text.includes('—'), `${tagged} ${name}: no em dashes`);
        if (name !== 'fundraise') check(!/\$\s?\d/.test(text), `${tagged} ${name}: no dollars here`);
        const emails = (await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('a[href^="mailto:"]')].map((a) => a.href).join(' '))).match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
        check(emails.every(allowedEmail), `${tagged} ${name}: no private email (${emails.filter((e) => !allowedEmail(e)).join(', ')})`);
        if (!ME[who].answers) check(!(await button(page, 'I can help')) && !(await button(page, 'Send the introduction')) && !(await button(page, 'Sign')), `${tagged} ${name}: no answering for someone who isn't an advisor`);
        if (width === 390 || width === 1280 || process.env.ALL_SHOTS) await page.screenshot({ path: join(SHOTS, `${who}-${state}-${width}-${name}.png`), fullPage: true });
      }
      if (ME[who].runs) {
        for (const t of ['members', 'documents', 'meetings']) {
          await open(page, `#/run/${t}`);
          await page.waitForSelector('.ar', { timeout: 4000 }).catch(() => {});
          await settle(260);
          check(await has(page, '.ar-tabs'), `${tagged} run ${t}: its tabs`);
          check((await overflow(page)) <= 0, `${tagged} run ${t}: nothing past the right edge (${await overflow(page)}px)`);
          check(!(await textOf(page)).includes('—'), `${tagged} run ${t}: no em dashes`);
          if (width === 390 || width === 1280 || process.env.ALL_SHOTS) await page.screenshot({ path: join(SHOTS, `${who}-${state}-${width}-run-${t}.png`), fullPage: true });
        }
      } else {
        await open(page, '#/run');
        check(!(await has(page, '.ar')), `${tagged}: Run it's address shows nothing to someone who doesn't run the group`);
      }
      await page.close();
    }
  }
}

// ─── Using it, as an advisor ────────────────────────────────────────
for (const width of [390, 1280]) {
  worlds.delete('advisor/use');
  const key = 'advisor/use';
  worlds.set(key, { portal: filledPortal('advisor'), admin: filledAdmin('advisor'), posts: [] });
  const w = worlds.get(key);
  const page = await tab(key, width, { reduce: width === 390 });
  await page.goto(`${ORIGIN}/admin/advisory/#/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ad-ask');
  await press(page, 'I can help');
  check(w.posts.some((x) => x.action === 'answer' && x.answer === 'yes'), 'the ask: the answer went');
  check((await textOf(page)).includes('You said you can help'), 'the ask: it says so');
  await press(page, 'Change my answer');
  await press(page, 'Not this time');
  check((await textOf(page)).includes('You said not this time'), 'the ask: an answer can change');
  await press(page, 'Renew');
  check(w.posts.some((x) => x.action === 'renew'), 'renewing went');
  check(!(await button(page, 'Renew')), 'renewing: it leaves the list');
  await open(page, PAGES.intros);
  await press(page, 'I know someone');
  check((await textOf(page)).includes('For: A licensed electrician'), 'an introduction: it says who it’s for');
  await page.type('#in-name', 'Morgan Example');
  await page.type('#in-co', 'Example Electric');
  await page.evaluate(() => { [...document.querySelectorAll('.ad-chips label')][2].click(); });
  await press(page, 'Send the introduction');
  const intro = w.posts.find((x) => x.action === 'intro');
  check(intro?.name === 'Morgan Example' && intro.wish === 'w_abcdefgh' && intro.help.includes('vendor'), 'an introduction: all of it went');
  check((await textOf(page)).includes('Morgan Example'), 'an introduction: it shows in their list');
  // Photos first on Home, and Documents like the board's
  await open(page, PAGES.home);
  check(await has(page, '.ad-hero__big'), 'Home: opens with a real room, beside the words');
  check((await page.$eval('.ad-hero__stat', (x) => x.textContent)).includes('208'), 'Home: how many kids');
  const cards = await page.$$eval('.ad-reveal', (x) => x.map((a) => ({ img: !!a.querySelector('.ad-reveal__pic img'), text: a.textContent, wide: a.closest('li').classList.contains('is-next') })));
  check(cards.length >= 2 && cards.every((c) => c.img), `Home: every reveal ahead has a picture (${cards.length})`);
  check(cards[0].wide && cards[0].text.includes('Next'), 'Home: the next reveal is first, and wider');
  check(!(await textOf(page)).includes('$'), 'Home: no dollars');
  check((await page.$$('.ad-rooms img')).length === 5, 'Home: the finished rooms, photo first');
  check(await page.$eval('#kid-h', (x) => x.textContent.length > 0), 'Home: the group’s makeover');
  await open(page, PAGES.documents);
  await page.waitForSelector('.bp-org');
  check((await textOf(page)).includes('SOARD’s facts'), 'Documents: SOARD’s facts, the board’s card');
  check(await page.$eval('.bp-org', (x) => x.textContent.includes('00-0000000')), 'Documents: the EIN is one copy away');
  check((await page.$$('.ad-logo')).length === 3, 'Documents: logos to download, and the group’s seal');
  check((await page.$$('.ad-shot')).length === 4, 'Documents: photos to save');
  const shelves = await page.$$eval('.bp-papers__h', (x) => x.map((h) => h.textContent));
  check(['About SOARD', 'Marketing', 'For donors and sponsors'].every((t) => shelves.some((h) => h.startsWith(t))), `Documents: the shelves (${shelves.join(', ')})`);
  check((await textOf(page)).includes('W-9'), 'Documents: the papers a donor asks for');
  check(await page.$$eval('.bp-papers a[href*="example.com"]', (x) => x.every((a) => a.target === '_blank')), 'Documents: a link opens in a new tab');
  // Print on the facts: that card alone, as on the board's page
  await page.emulateMediaType('print');
  await page.evaluate(() => document.documentElement.classList.add('bp-printing-org'));
  const printed = await page.evaluate(() => ({ org: getComputedStyle(document.querySelector('.bp-org')).display, brand: getComputedStyle(document.querySelector('.ad-brand')).display, w: document.querySelector('.bp-org').offsetWidth }));
  check(printed.org !== 'none' && printed.brand === 'none' && printed.w > 0, `Documents: Print takes SOARD’s facts alone (${JSON.stringify(printed)})`);
  await page.evaluate(() => document.documentElement.classList.remove('bp-printing-org'));
  await page.emulateMediaType('screen');
  // What's on the page can be found on the page
  for (const [word, sel, what] of [['agreement', '.bp-tosign', 'the paper to sign'], ['seal', '.ad-brand', 'the group’s seal'], ['photo', '.ad-brand', 'the photos'], ['w9', '.bp-papers', 'the W-9'], ['facts', '.bp-org', 'SOARD’s facts']]) {
    await page.$eval('.bp-filter input', (x) => { x.value = ''; x.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type('.bp-filter input', word);
    await settle(120);
    check(await has(page, sel), `Documents: “${word}” finds ${what}`);
  }
  await page.$eval('.bp-filter input', (x) => { x.value = ''; x.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.type('.bp-filter input', 'w-9');
  check(await page.waitForFunction(() => !document.body.innerText.includes('Our story'), { timeout: 3000 }).then(() => true, () => false), 'Documents: finding narrows the shelves');
  check((await textOf(page)).includes('W-9'), 'Documents: finding keeps what matches');
  await page.$eval('.bp-filter input', (x) => { x.value = ''; x.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.type('.bp-filter input', 'zzzz');
  check(await page.waitForFunction(() => document.body.innerText.includes('Nothing here matches'), { timeout: 3000 }).then(() => true, () => false), 'Documents: nothing found says so');
  await page.$eval('.bp-filter input', (x) => { x.value = ''; x.dispatchEvent(new Event('input', { bubbles: true })); });
  await open(page, PAGES.fundraise);
  await page.waitForSelector('.ad-qr__c svg');
  check(await has(page, '.ad-thermo'), 'Fundraise: the goal thermometer');
  const level = await page.$eval('.ad-thermo .thermo__level', (x) => Number(x.getAttribute('y')));
  check(Math.abs(level - (226 - (9150 / 25000) * 196)) < 0.01, `Fundraise: the thermometer stands at what's raised (${level})`);
  check((await page.$eval('.ad-thermo', (x) => x.getAttribute('aria-label'))) === '36% of the $25,000 goal', 'Fundraise: a screen reader hears the same level');
  check((await page.$$eval('.ad-thermo text', (x) => x.map((t) => t.textContent))).join() === '$0,$5,000,$10,000,$15,000,$20,000,$25,000', 'Fundraise: the thermometer counts up to the goal');
  check((await textOf(page)).includes('$15,850 to go'), 'Fundraise: what is left to raise');
  await press(page, 'Send an idea');
  await page.type('#h-title', 'A dinner');
  await press(page, 'Send my idea');
  check(w.posts.some((x) => x.action === 'host' && x.title === 'A dinner'), 'a fundraiser idea went');
  check((await textOf(page)).includes('Waiting for an answer'), 'a fundraiser idea: it shows, waiting');
  await open(page, PAGES.paper);
  await page.type('#sign-name', 'Sam Ortez');
  await press(page, 'Sign');
  check((await page.$eval('.bp-toast', (x) => x.textContent)).includes('Type your name as Sam Ortiz'), 'signing: a wrong name says why');
  check((await page.$eval('#sign-name', (x) => x.value)) === 'Sam Ortez', 'signing: what they typed stays');
  await page.$eval('#sign-name', (x) => { x.value = ''; x.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.type('#sign-name', 'Sam Ortiz');
  await press(page, 'Sign');
  check((await textOf(page)).includes('Signed'), 'signing: it says signed');
  // What they read and copy
  // A paper's tab says what it is, and back goes where they came from
  await open(page, PAGES.documents);
  await page.waitForSelector('.bp-papers');
  await page.evaluate(() => { document.querySelector('.bp-papers a[href="#/papers/ad_pitch1234"]').click(); });
  await settle(200);
  check(!!(await button(page, 'Copy the words')), 'a paper: the pitch copies from here too');
  await page.evaluate(() => { document.querySelector('.bp-back').click(); });
  await settle(200);
  check(page.url().endsWith('#/documents'), 'a paper: back returns to Documents');
  await open(page, `#/papers/ad_overv1234`);
  const openBtn = await button(page, 'Open the PDF');
  check(!!openBtn && (await openBtn.evaluate((a) => a.href)).endsWith('overview.docx.pdf'), 'a paper with a link has an Open button');
  await open(page, PAGES.intros);
  check((await textOf(page)).includes('We left Pat a message on Tuesday.'), 'an introduction shows the note left for its advisor');
  await open(page, PAGES.fundraise);
  await page.evaluate(() => { window.__copied = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true }); });
  w.portal.share = w.portal.share.map((d) => (d.kind === 'pitch' ? { ...d, body: 'We build **free** rooms.\n\n- One\n- Two' } : d));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(() => { window.__copied = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true }); });
  await press(page, 'Copy the words');
  const copied = await page.evaluate(() => window.__copied);
  check(copied.includes('We build free rooms.') && !copied.includes('**'), `Copy the words copies plain words (${copied})`);
  // A long pasted link can't push the phone sideways
  const LONG = `https://example.com/${'a-really-long-pasted-link-'.repeat(12)}`;
  w.portal.ask = { ...w.portal.ask, title: LONG.slice(0, 120), body: LONG, mine: { answer: 'yes', note: LONG } };
  w.portal.intros = w.portal.intros.map((i) => ({ ...i, name: LONG.slice(0, 100), company: LONG, note: LONG }));
  w.portal.hosted = w.portal.hosted.map((x) => ({ ...x, title: LONG.slice(0, 120), when: LONG, note: LONG }));
  w.portal.wishes = [{ id: 'w_abcdefgh', title: LONG.slice(0, 120), detail: LONG }];
  w.portal.people = [{ ...PEOPLE[0], organization: LONG, bio: LONG }];
  w.portal.coming.hosted = [{ id: 'h_abcdefgh', title: LONG.slice(0, 120), date: later(25), where: LONG, giveUrl: '' }];
  w.portal.org = { ...org, mission: LONG };
  await page.reload({ waitUntil: 'networkidle0' });
  for (const [name, hash] of Object.entries(PAGES)) { await open(page, hash); const over = await overflow(page); check(over <= 0, `a long pasted link on ${name}: nothing sideways at ${width} (${over}px)`); }
  // A save refused because the ask closed: the page catches up
  w.portal.ask = { ...filledPortal('advisor').ask };
  await page.reload({ waitUntil: 'networkidle0' });
  await open(page, PAGES.home);
  w.refuse = 'That ask has closed';
  w.onRefuse = () => { w.portal.ask = null; };
  await press(page, 'I can help');
  await settle(200);
  check(!(await has(page, '.ad-ask')), 'an ask that closed underneath them comes off the page');
  check((await page.$eval('.bp-toast', (x) => x.textContent)).includes('That ask has closed'), 'and it says why');
  w.onRefuse = null;
  // A refused save leaves what they typed
  await open(page, PAGES.intros);
  await page.type('#in-name', 'Keep Me');
  await press(page, 'Send the introduction');
  check((await page.$eval('.bp-toast', (x) => x.textContent)).includes('That ask has closed'), 'a refusal says why');
  check((await page.$eval('#in-name', (x) => x.value)) === 'Keep Me', 'a refusal leaves what they typed');
  await page.close();
}

// ─── A link from an email or an invite ──────────────────────────────
{
  const page = await tab('lead/filled', 1280);
  await page.goto(`${ORIGIN}/admin/advisory/?meeting=run`, { waitUntil: 'networkidle0' });
  check(page.url().endsWith('/admin/advisory/#/run'), 'a link to Run it survives the sign-in');
  await page.goto(`${ORIGIN}/admin/advisory/?meeting=${AGREE.id}`, { waitUntil: 'networkidle0' });
  check(page.url().endsWith(`#/papers/${AGREE.id}`), 'a link to a paper survives the sign-in');
  await page.goto(`${ORIGIN}/admin/advisory/?meeting=m_abcdefgh`, { waitUntil: 'networkidle0' });
  check(page.url().endsWith('#/meetings/m_abcdefgh'), 'a link to a meeting survives the sign-in');
  await page.close();
}

// ─── A page that won't open ─────────────────────────────────────────
{
  const key = 'advisor/down';
  worlds.set(key, { portal: emptyPortal('advisor'), admin: emptyAdmin('advisor'), posts: [], down: { status: 403, body: { ok: false, error: 'The advisory page is for SOARD’s Advisory Board' } } });
  const page = await tab(key, 390);
  await page.goto(`${ORIGIN}/admin/advisory/`, { waitUntil: 'networkidle0' });
  check((await page.$eval('.bp-fail h1', (x) => x.textContent)).includes('This page is for SOARD’s Advisory Board'), 'refused: it says who the page is for');
  await page.screenshot({ path: join(SHOTS, 'fail-403.png') });
  worlds.get(key).down = { status: 500, body: { ok: false, error: 'Something broke' } };
  await press(page, 'Try again');
  await settle(200);
  check((await page.$eval('.bp-fail h1', (x) => x.textContent)).includes('didn’t open'), 'a failure says it didn’t open');
  worlds.get(key).down = null;
  await press(page, 'Try again');
  await page.waitForSelector('.bp-main');
  check(true, 'Try again opens it');
  await page.close();
}

// ─── A sign-in that ended ───────────────────────────────────────────
{
  const key = 'advisor/gone';
  worlds.set(key, { portal: filledPortal('advisor'), admin: emptyAdmin('advisor'), posts: [], down: { redirect: true } });
  const page = await tab(key, 390);
  await page.goto(`${ORIGIN}/admin/advisory/`, { waitUntil: 'networkidle0' });
  check((await page.$eval('.bp-fail h1', (x) => x.textContent)).includes('Your sign-in ended'), 'a sign-in that ended says so, not No connection');
  check(!!(await button(page, 'Reload')), 'and offers Reload');
  worlds.get(key).down = null;
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.ad-ask');
  worlds.get(key).down = { html: 'all' };
  await press(page, 'I can help');
  check((await page.$eval('.bp-toast', (x) => x.textContent)).includes('Your sign-in ended'), 'a save after the sign-in ended says so');
  check(!!(await button(page, 'Reload')), 'and that note offers Reload');
  await page.close();
}

// ─── Running the group ──────────────────────────────────────────────
for (const width of [390, 1280]) {
  const key = 'lead/run';
  worlds.set(key, { portal: filledPortal('lead'), admin: filledAdmin('lead'), posts: [] });
  const w = worlds.get(key);
  const page = await tab(key, width);
  await page.goto(`${ORIGIN}/admin/advisory/#/run`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ar-card');
  const text = await textOf(page);
  check(text.includes('Pat Jones') && text.includes('Trivia night at my office') && text.includes('Waiting on you'), 'Run it: what’s waiting is there first');
  await press(page, 'Talking');
  check(w.posts.some((x) => x.action === 'intro-status' && x.status === 'talking'), 'Run it: an introduction’s status');
  // An answer's note, held fundraisers, the kid apart from the dollars, an ended term
  check(text.includes('Out of town that week.'), 'Run it: a "not this time" shows its note');
  await page.evaluate(() => [...document.querySelectorAll('.ar-fold > summary')].forEach((x) => x.click()));
  await settle(120);
  const held = await page.evaluate(() => { const r = [...document.querySelectorAll('.ar-row')].find((x) => x.textContent.includes('Bake sale')); return r ? [...r.querySelectorAll('button')].map((b) => b.textContent) : null; });
  check(held && !held.includes('Approve'), 'Run it: a fundraiser that was held offers no Approve');
  const apart = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.ar-card')];
    const kid = cards.find((c) => c.querySelector('h3')?.textContent.includes('makeover')).getBoundingClientRect();
    const goal = cards.find((c) => c.querySelector('h3')?.textContent.includes('The goal')).getBoundingClientRect();
    const wall = cards.find((c) => c.querySelector('h3')?.textContent.startsWith('The Advisory Board')).getBoundingClientRect();
    return { below: kid.top >= goal.bottom, last: kid.top >= wall.bottom };
  });
  check(apart.below && apart.last, 'Run it: the kid sits apart from the dollars, at the foot');
  check((await textOf(page)).includes('Ended'), 'Run it: an ended term says ended');
  check((await textOf(page)).includes('Asked to sign again'), 'Run it: a signature on old words doesn’t read as signed');
  // A note typed on an undecided introduction waits for the status, and says so
  const noted = w.posts.length;
  await page.evaluate(() => { [...document.querySelectorAll('.ar-fold[open] > summary')].forEach((x) => x.click()); });
  // (the first row's already marked Talking above; a fresh undecided one)
  w.admin.intros = [{ ...filledAdmin('lead').intros[0], id: 'in_newnewnew' }, ...w.admin.intros];
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.ar-card');
  await page.evaluate(() => [...document.querySelectorAll('.ar-field')].find((f) => f.textContent.includes('A note for the advisor')).querySelector('input').focus());
  await page.keyboard.type('Called them today');
  await page.keyboard.press('Tab');
  await settle(200);
  check(w.posts.length === noted, 'Run it: clicking away from an undecided note doesn’t decide it');
  check((await textOf(page)).includes('It saves when you pick where this stands.'), 'Run it: the note says when it saves');
  await press(page, 'Talking');
  check(w.posts.some((x) => x.action === 'intro-status' && x.id === 'in_newnewnew' && x.note === 'Called them today'), 'Run it: the note goes with the status');
  await press(page, 'Approve');
  check((await page.evaluate(() => document.querySelector('.ask')?.textContent || '')).includes('Coming up'), 'Run it: approving with no date says it won’t reach Coming up');
  await press(page, 'Approve it anyway');
  check(w.posts.some((x) => x.action === 'hosted-status' && x.status === 'approved'), 'Run it: approving a fundraiser');
  await page.$eval('.ar-card input[placeholder^="Do you know"]', (x) => x.focus());
  await page.keyboard.type('Who knows a roofer?');
  await press(page, 'Put it on the page');
  check(w.posts.filter((x) => ['save-ask', 'send-ask'].includes(x.action)).length === 2, 'Run it: an ask saved and put out');
  // Pressed twice, it goes once
  await page.evaluate(() => [...document.querySelectorAll('.ar-input')].find((x) => (x.placeholder || '').startsWith('A licensed electrician')).focus());
  await page.keyboard.type('A roofer');
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Add to the list'); b.click(); b.click(); });
  await settle(240);
  check(w.posts.filter((x) => x.action === 'save-wish').length === 1, 'Run it: a double click adds once');
  // Saved asks stay editable; Close it asks
  await page.evaluate(() => [...document.querySelectorAll('.ar-fold > summary')].find((x) => x.textContent.startsWith('Saved for later')).click());
  await settle(120);
  await press(page, 'Edit');
  check(await page.evaluate(() => [...document.querySelectorAll('.ar-input')].some((x) => x.value === 'Saved idea for April')), 'Run it: a saved ask can be edited');
  await press(page, 'Keep it as it was');
  await press(page, 'Close it');
  check(!!(await button(page, 'Yes, close it')), 'Run it: Close it asks first');
  await press(page, 'Keep it as it is');
  // The goal: blank is refused; handing it over names who
  await page.evaluate(() => { const d = [...document.querySelectorAll('.ar-fold')].find((x) => x.querySelector('summary').textContent.startsWith('Goal, term')); d.open = true; d.id = 'goal-fold'; });
  await settle(120);
  const before = w.posts.length;
  await page.$eval('input[type="number"]', (x) => { x.value = ''; x.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(60);
  await page.evaluate(() => [...document.querySelectorAll('#goal-fold button')].find((b) => b.textContent === 'Save').click());
  await settle(200);
  check(w.posts.length === before && (await page.$eval('.bp-toast', (x) => x.textContent)).includes('Type the goal'), 'Run it: a blank goal is refused');
  await page.$eval('input[type="number"]', (x) => { x.value = '25000'; x.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(60);
  await press(page, `Pick Jordan`);
  await press(page, 'Yes, pick Jordan');
  check((await page.$eval('.bp-toast', (x) => x.textContent)).includes('Add SOARD Advisory Board in Partners first'), 'Run it: a refused pick shows the server’s words');
  await page.evaluate(() => [...document.querySelectorAll('.ar-toggle')].at(-1).click());
  await settle(220);
  check(w.posts.some((x) => x.action === 'save-settings' && x.settings.emails === true), 'Run it: the emails switch');
  // With the emails on, putting an ask out asks first and says who it reaches
  await page.$eval('.ar-card input[placeholder^="Do you know"]', (x) => x.focus());
  await page.keyboard.type('Half-written ask');
  const beforeSend = w.posts.filter((x) => x.action === 'send-ask').length;
  await press(page, 'Put it out and email advisors');
  check((await page.evaluate(() => document.querySelector('.ask')?.textContent || '')).includes('Email all 3 advisors?'), 'Run it: emails on, it asks before emailing everyone');
  await page.screenshot({ path: join(SHOTS, `ask-dialog-${width}.png`) });
  await press(page, 'Not yet');
  check(w.posts.filter((x) => x.action === 'send-ask').length === beforeSend, 'Run it: Not yet sends nothing');
  // Half-written words: leaving asks first
  await page.evaluate(() => [...document.querySelectorAll('.ar-tabs button')].find((b) => b.textContent === 'Documents').click());
  await settle(240);
  check((await page.evaluate(() => document.querySelector('.ask')?.textContent || '')).includes('Leave without saving?'), 'Run it: leaving a half-written ask asks first');
  await press(page, 'Keep editing');
  check(page.url().endsWith('#/run') || page.url().endsWith('#/run/members'), 'Run it: Keep editing stays');
  check(await page.evaluate(() => [...document.querySelectorAll('.ar-input')].some((x) => x.value === 'Half-written ask')), 'Run it: and the words are still there');
  await page.evaluate(() => [...document.querySelectorAll('.ar-tabs button')].find((b) => b.textContent === 'Documents').click());
  await settle(240);
  await press(page, 'Leave without saving');
  await settle(200);
  check(page.url().endsWith('#/run/documents'), 'Run it: a tab has its own address');
  // New words on a signed paper say what happens; Close asks first
  await press(page, 'Edit');
  await page.waitForSelector('.ar-editor [contenteditable]');
  await page.click('.ar-editor [contenteditable]');
  await page.keyboard.type('New words. ');
  await settle(200);
  await press(page, 'Close');
  check((await page.evaluate(() => document.querySelector('.ask')?.textContent || '')).includes('Leave without saving?'), 'Run it: Close with changed words asks first');
  await press(page, 'Keep editing');
  await press(page, 'Save');
  check((await page.evaluate(() => document.querySelector('.ask')?.textContent || '')).includes('asked to sign again'), 'Run it: changing a signed paper warns of signing again');
  await press(page, 'Keep editing');
  await press(page, 'Close');
  await press(page, 'Leave without saving');
  await press(page, 'Start from a draft');
  await page.waitForSelector('.ar-editor .ProseMirror, .ar-editor [contenteditable]');
  await settle(200);
  check(!(await textOf(page)).includes('Initials'), 'Run it: the editor doesn’t offer a signer’s fields');
  await page.screenshot({ path: join(SHOTS, `run-editor-${width}.png`), fullPage: true });
  await press(page, 'Save');
  check(w.posts.some((x) => x.action === 'save-doc' && x.doc.title), 'Run it: a paper from its draft');
  check((await overflow(page)) <= 0, 'Run it: the editor fits');
  await page.close();
}

// ─── Long pasted words on Run it ────────────────────────────────────
for (const width of [390, 1280]) {
  const LONG = `https://example.com/${'a-really-long-pasted-link-'.repeat(12)}`;
  const key = 'lead/long';
  const a = filledAdmin('lead');
  a.intros = a.intros.map((i) => ({ ...i, name: LONG.slice(0, 100), company: LONG, how: LONG, email: `${LONG.slice(8, 90)}@example.com` }));
  a.hosted = a.hosted.map((x) => ({ ...x, title: LONG.slice(0, 120), when: LONG, where: LONG, notes: LONG, note: LONG }));
  a.asks = a.asks.map((x) => ({ ...x, title: LONG.slice(0, 120), body: LONG, answers: x.answers.map((r) => ({ ...r, note: LONG })) }));
  a.wishes = [{ id: 'w_abcdefgh', title: LONG.slice(0, 120), detail: LONG, sort: 1 }];
  worlds.set(key, { portal: filledPortal('lead'), admin: a, posts: [] });
  const page = await tab(key, width);
  await page.goto(`${ORIGIN}/admin/advisory/#/run/members`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ar-card');
  await page.evaluate(() => document.querySelectorAll('.ar-fold').forEach((d) => { d.open = true; }));
  await settle(120);
  const over = await overflow(page);
  check(over <= 0, `Run it: long pasted words fit at ${width} (${over}px)`);
  await page.close();
}

// ─── Round two ──────────────────────────────────────────────────────
for (const width of [390, 1280]) {
  const key = 'lead/two';
  const a = filledAdmin('lead');
  worlds.set(key, { portal: filledPortal('lead'), admin: a, posts: [], switched: true });
  const w = worlds.get(key);
  const page = await tab(key, width);
  const said = () => page.$eval('.bp-toast', (x) => x.textContent);
  const inAsk = () => page.evaluate(() => document.querySelector('.ask')?.textContent || '');
  await page.goto(`${ORIGIN}/admin/advisory/#/run`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ar-card');
  // Someone turned emails on since this screen looked: it asks, and says what really happened
  await page.$eval('.ar-card input[placeholder^="Do you know"]', (x) => x.focus());
  await page.keyboard.type('Stale switch');
  await press(page, 'Put it on the page');
  await settle(200);
  check((await inAsk()).includes('Email all 3 advisors?'), 'round two: a switch turned on elsewhere asks before anything goes');
  await press(page, 'Put it out and email them');
  await settle(200);
  check(w.posts.some((x) => x.action === 'send-ask' && x.emailsOk === true), 'round two: emailsOk only after they agreed');
  check((await said()).includes('emailed to 3 advisors'), `round two: the note says what happened (${await said()})`);
  // A status emails the advisor: said at the control
  check((await textOf(page)).includes('Changing this emails Sam'), 'round two: the control says it emails them');
  check((await textOf(page)).includes('Got it'), 'round two: Run it says Got it');
  // A note and a status pressed together: both
  await page.evaluate(() => [...document.querySelectorAll('.ar-fold')].find((d) => d.querySelector('summary').textContent.startsWith('All introductions')).setAttribute('open', ''));
  await settle(100);
  w.posts.length = 0;
  const row = await page.evaluateHandle(() => [...document.querySelectorAll('.ar-row')].find((r) => r.textContent.includes('Robin Fields')));
  const input = await row.$('input');
  await input.click({ clickCount: 3 });
  await page.keyboard.type('Joining in April');
  const talking = await page.evaluateHandle((r) => [...r.querySelectorAll('.ar-seg button')].find((b) => b.textContent === 'Talking'), row);
  await talking.click();
  await settle(240);
  const hits = w.posts.filter((x) => x.action === 'intro-status');
  check(hits.length === 1 && hits[0].status === 'talking' && hits[0].note === 'Joining in April', `round two: a note and a status go together (${JSON.stringify(hits.map((x) => [x.status, x.note]))})`);
  // A date cleared clears
  w.posts.length = 0;
  await page.evaluate(() => [...document.querySelectorAll('.ar-fold')].find((d) => d.querySelector('summary').textContent.startsWith('All fundraisers')).setAttribute('open', ''));
  await settle(100);
  const golf = await page.evaluateHandle(() => [...document.querySelectorAll('.ar-row')].find((r) => r.textContent.includes('Golf outing')));
  await (await golf.$('input[type="date"]')).evaluate((x) => { x.value = ''; x.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(60);
  await (await page.evaluateHandle((r) => [...r.querySelectorAll('button')].find((b) => b.textContent === 'Save'), golf)).click();
  await settle(240);
  check(w.posts.some((x) => x.action === 'hosted-status' && x.date === ''), 'round two: clearing a date sends it clear');
  // Tabbing through a term date saves nothing
  await page.evaluate(() => { const i = document.querySelector('.ar-input--date'); i.focus(); i.blur(); });
  await settle(200);
  check(!w.terms?.length, 'round two: tabbing through a term date saves nothing');
  // JobTread's problems, in plain view
  w.pickOk = true;
  await press(page, 'Pick Jordan');
  await press(page, 'Yes, pick Jordan');
  await settle(240);
  check((await textOf(page)).includes('Couldn’t set Monetary Sponsor'), 'round two: what JobTread refused is shown');
  check(await page.evaluate(() => document.querySelector('.ar').textContent.includes('$750')), 'round two: a credit shows its amount');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.ar-fold > summary'), '::before').width === '8px'), 'round two: folds show they open');
  await page.close();
}
{
  // Sign-in emails, with the emails on
  const key = 'lead/welcome';
  const a = filledAdmin('lead');
  a.settings = { ...a.settings, emails: true };
  a.advisors = a.advisors.map((x) => ({ ...x, lastSeen: '' }));
  a.welcomed = { 'sam-ortiz': `${later(-1)}T12:00:00Z` };
  worlds.set(key, { portal: filledPortal('lead'), admin: a, posts: [] });
  const w = worlds.get(key);
  const page = await tab(key, 1280);
  await page.goto(`${ORIGIN}/admin/advisory/#/run`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ar-card');
  await press(page, 'Send the sign-in email to 2');
  await press(page, 'Yes, send it');
  await settle(240);
  check(w.posts.find((x) => x.action === 'send-welcome')?.slugs.length === 2, 'round two: who’s had the sign-in email is left out');
  check((await page.$eval('.bp-toast', (x) => x.textContent)).includes('Sent to 2 advisors'), 'round two: it says how many');
  check(!(await textOf(page)).includes('Send the sign-in email'), 'round two: the button goes once everyone has it');
  await page.close();
}
{
  // A new paper's file doesn't publish it; the web address warning clears; the starter has no dollars
  const key = 'lead/paper';
  worlds.set(key, { portal: filledPortal('lead'), admin: emptyAdmin('lead'), posts: [] });
  const w = worlds.get(key);
  const page = await tab(key, 1280);
  await page.goto(`${ORIGIN}/admin/advisory/#/run/documents`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ar-card');
  await press(page, 'Start from a draft');
  await page.waitForSelector('.ar-editor [contenteditable]');
  await settle(200);
  check(!(await textOf(page)).includes('$'), 'round two: the agreement’s starter has no dollars');
  const input = await page.$('.ar-editor input[type="file"]');
  await page.evaluate(() => { const i = document.querySelector('.ar-editor input[type="file"]'); i.id = 'upl'; });
  const tmp = join(SHOTS, 'a.pdf');
  writeFileSync(tmp, '%PDF-1.4');
  await input.uploadFile(tmp);
  await settle(300);
  check(w.posts.find((x) => x.action === 'save-doc')?.doc.shared === false, 'round two: a file on an unsaved paper keeps it off the page');
  await page.close();
  // A web address without https:// doesn't leave a warning behind
  const page2 = await tab('lead/paper', 1280);
  await page2.goto(`${ORIGIN}/admin/advisory/#/run/members`, { waitUntil: 'networkidle0' });
  await page2.waitForSelector('.ar-card');
  await page2.evaluate(() => { const d = [...document.querySelectorAll('.ar-fold')].find((x) => x.querySelector('summary').textContent.startsWith('Goal, term')); d.open = true; d.id = 'goal-fold'; });
  await page2.type('#goal-fold input[type="url"]', 'zeffy.com/made-up');
  await settle(60);
  await page2.evaluate(() => [...document.querySelectorAll('#goal-fold button')].find((b) => b.textContent === 'Save').click());
  await settle(260);
  await page2.evaluate(() => [...document.querySelectorAll('.ar-tabs button')].find((b) => b.textContent === 'Documents').click());
  await settle(260);
  check(!(await page2.evaluate(() => !!document.querySelector('.ask'))), 'round two: a web address the server finished leaves no unsaved warning');
  await page2.close();
}
{
  // Signing words that changed; a half-typed form survives a tab change; a note doesn't follow to a new ask
  const key = 'advisor/two';
  worlds.set(key, { portal: filledPortal('advisor'), admin: emptyAdmin('advisor'), posts: [] });
  const w = worlds.get(key);
  const page = await tab(key, 390);
  await page.goto(`${ORIGIN}/admin/advisory/#/introductions`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#in-name');
  await page.type('#in-name', 'Half typed');
  await open(page, PAGES.fundraise);
  await press(page, 'Send an idea');
  await page.type('#h-title', 'Half an idea');
  await open(page, PAGES.intros);
  check((await page.$eval('#in-name', (x) => x.value)) === 'Half typed', 'round two: a half-typed introduction survives a tab change');
  await open(page, PAGES.fundraise);
  check((await page.$eval('#h-title', (x) => x.value)) === 'Half an idea', 'round two: a half-typed idea survives a tab change');
  await open(page, PAGES.home);
  await page.type('#ask-note', 'For the old ask');
  w.portal.ask = { id: 'ask_newnewne', title: 'A different ask', body: '', link: '', mine: null };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.evaluate(() => { Date.now = ((n) => () => n() + 60000)(Date.now); window.dispatchEvent(new Event('focus')); });
  await settle(300);
  check((await page.$eval('#ask-note', (x) => x.value)) === '', 'round two: a note doesn’t follow to a new ask');
  await open(page, PAGES.paper);
  await page.type('#sign-name', 'Sam Ortiz');
  w.portal.papers = w.portal.papers.map((x) => (x.id === AGREE.id ? { ...x, version: 2, body: 'The new words.' } : x));
  await press(page, 'Sign');
  await settle(240);
  const body = await textOf(page);
  check(body.includes('These words changed while you had them open') && body.includes('The new words.'), 'round two: changed words show, and say so');
  check((await page.$eval('#sign-name', (x) => x.value)) === '', 'round two: they sign again by choice, after reading');
  await page.type('#sign-name', 'Sam Ortiz');
  await press(page, 'Sign');
  await settle(240);
  check((await textOf(page)).includes('Signed'), 'round two: then signing works');
  await page.close();
}

// ─── Round three ────────────────────────────────────────────────────
for (const width of [390, 1280]) {
  const key = 'lead/three';
  const a = filledAdmin('lead');
  a.settings = { ...a.settings, emails: true };
  a.asks = a.asks.map((x, i) => (i === 0 ? { ...x, mailed: false } : x));
  worlds.set(key, { portal: filledPortal('lead'), admin: a, posts: [] });
  const w = worlds.get(key);
  const page = await tab(key, width);
  const said = () => page.$eval('.bp-toast', (x) => x.textContent);
  const inAsk = () => page.evaluate(() => document.querySelector('.ask')?.textContent || '');
  await page.goto(`${ORIGIN}/admin/advisory/#/run`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ar-card');
  // Someone else saved a goal: this older tab changes only the Zeffy link
  w.admin.settings = { ...w.admin.settings, goal: 30000 };
  await page.evaluate(() => { const d = [...document.querySelectorAll('.ar-fold')].find((x) => x.querySelector('summary').textContent.startsWith('Goal, term')); d.open = true; d.id = 'goal-fold'; });
  await page.$eval('#goal-fold input[type="url"]', (x) => { x.value = 'https://www.zeffy.com/new-link'; x.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(60);
  await page.evaluate(() => [...document.querySelectorAll('#goal-fold button')].find((b) => b.textContent === 'Save').click());
  await settle(260);
  const patch = w.posts.find((x) => x.action === 'save-settings')?.settings || {};
  // The campaign's ID travels with its address (3e86de92), so a changed link sends both; nothing else goes
  check(Object.keys(patch).sort().join() === 'campaignId,campaignUrl', `round three: only what changed is sent, the campaign’s link and its ID (${Object.keys(patch)})`);
  check(w.admin.settings.goal === 30000, 'round three: someone else’s goal survives');
  // Back to the tab: what changed meanwhile
  w.admin.settings = { ...w.admin.settings, goal: 40000 };
  w.admin.money = { ...w.admin.money, goal: 40000 };
  await page.evaluate(() => { const n = Date.now; Date.now = () => n() + 60000; window.dispatchEvent(new Event('focus')); });
  await settle(260);
  check(await page.evaluate(() => document.querySelector('.ar').textContent.includes('$40,000')), 'round three: coming back to the tab refreshes it');
  // A fundraiser's buttons email the advisor
  check((await textOf(page)).includes('Changing this emails Dana'), 'round three: a fundraiser’s row says it emails them');
  // An ask out but never emailed
  await press(page, 'Email it to advisors');
  check((await inAsk()).includes('Email all 3 advisors?'), 'round three: emailing an ask that’s out asks first');
  await press(page, 'Email them');
  await settle(200);
  check(w.posts.some((x) => x.action === 'email-ask'), 'round three: then it goes');
  check((await said()).includes('Emailed to 3 advisors'), 'round three: and it says so');
  // Delete only on an ask that never went out
  await page.evaluate(() => document.querySelectorAll('.ar-fold').forEach((d) => { d.open = true; }));
  await settle(100);
  const past = await page.evaluate(() => { const r = [...document.querySelectorAll('.ar-row')].filter((x) => x.textContent.includes('An older ask') || x.textContent.includes('Do you know a licensed plumber')); return r.flatMap((x) => [...x.querySelectorAll('button')].map((b) => b.textContent)); });
  check(!past.includes('Delete'), 'round three: an ask that went out offers no Delete');
  // What's on their Documents page: a shelf, and which of the board's papers
  await open(page, '#/run/documents');
  await settle(240);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Add a link or file to Marketing').click(); });
  await page.waitForSelector('.ar-editor');
  const lib = await page.$$('.ar-editor .ar-input');
  await lib[0].type('Event flyer'); await lib[1].type('For a table'); await lib[2].type('example.com/flyer');
  await press(page, 'Save');
  await settle(200);
  const shelved = w.posts.filter((x) => x.action === 'save-doc').at(-1)?.doc;
  check(shelved?.kind === 'library' && shelved.shelf === 'marketing' && shelved.url === 'example.com/flyer' && shelved.note === 'For a table', `Documents in Run it: a link goes on its shelf (${JSON.stringify(shelved)})`);
  check(await page.evaluate(() => [...document.querySelectorAll('.ar-toggle')].some((x) => x.textContent.includes('W-9') && x.querySelector('input').checked)), 'Documents in Run it: the board’s W-9 is on');
  await page.evaluate(() => { [...document.querySelectorAll('.ar-toggle')].find((x) => x.textContent.includes('Bylaws')).querySelector('input').click(); });
  await settle(200);
  check(w.posts.some((x) => x.action === 'board-doc' && x.id === 'd_bylawsx' && x.on === true), 'Documents in Run it: turning a board paper on changes that one paper');
  // An entry with nothing to open can't be saved as if it had
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Add a link or file to For the group').click(); });
  await page.waitForSelector('.ar-editor');
  await (await page.$('.ar-editor .ar-input')).type('Just a title');
  await settle(100);
  check(await page.evaluate(() => [...document.querySelectorAll('.ar-editor button')].find((b) => b.textContent === 'Save').disabled), 'Documents in Run it: a title alone can’t be saved');
  // Moving to another paper asks before it drops what's typed
  await press(page, 'Edit');
  await settle(200);
  check(await has(page, '.ask'), 'Documents in Run it: moving to another paper asks first');
  await page.evaluate(() => { document.querySelector('.ask [data-ask="yes"]').click(); });
  await settle(200);
  await press(page, 'Close');
  await settle(120);
  // Two people on one paper
  await open(page, '#/run/documents');
  await settle(240);
  await press(page, 'Edit');
  await page.waitForSelector('.ar-editor [contenteditable]');
  await page.click('.ar-editor [contenteditable]');
  await page.keyboard.type('Mine. ');
  await settle(200);
  w.admin.docs = w.admin.docs.map((d) => (d.id === AGREE.id ? { ...d, body: 'Their words.', updatedAt: new Date().toISOString(), updatedBy: 'Jane' } : d));
  await press(page, 'Save');
  await press(page, 'Save and ask them');
  await settle(260);
  check((await textOf(page)).includes('Jane saved this while you were working'), 'round three: someone else’s save says who');
  check(await page.evaluate(() => document.querySelector('.ar-editor [contenteditable]').textContent.includes('Mine.')), 'round three: their words stay on screen');
  await press(page, 'Load their version');
  await settle(240);
  check(await page.evaluate(() => document.querySelector('.ar-editor [contenteditable]').textContent.includes('Their words.')), 'round three: the latest loads');
  await press(page, 'Close');
  await settle(120);
  check(!(await inAsk()), 'round three: after loading the latest nothing is unsaved');
  await page.close();
}
{
  // A file on a new paper: the switch stays as they set it, the note stays up, Save publishes
  const key = 'lead/three-file';
  worlds.set(key, { portal: filledPortal('lead'), admin: emptyAdmin('lead'), posts: [] });
  const w = worlds.get(key);
  const page = await tab(key, 1280);
  await page.goto(`${ORIGIN}/admin/advisory/#/run/documents`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ar-card');
  await press(page, 'Start from a draft');
  await page.waitForSelector('.ar-editor [contenteditable]');
  const input = await page.$('.ar-editor input[type="file"]');
  const tmp = join(SHOTS, 'b.pdf');
  writeFileSync(tmp, '%PDF-1.4');
  await input.uploadFile(tmp);
  await settle(320);
  check(w.posts.find((x) => x.action === 'save-doc')?.doc.shared === false, 'round three: the first save with a file stays off the page');
  check(await page.$eval('.ar-editor .ar-toggle input', (x) => x.checked), 'round three: the switch stays as they set it');
  check((await textOf(page)).includes('Press Save to put it on the page'), 'round three: and the note stays up');
  await press(page, 'Save');
  await settle(260);
  check(w.posts.filter((x) => x.action === 'save-doc').at(-1)?.doc.shared === true, 'round three: Save puts it on the page');
  await page.close();
}

// ─── Handing the group over: staff only, and it names who ───────────
{
  const key = 'admin/hand';
  worlds.set(key, { portal: filledPortal('admin'), admin: filledAdmin('admin'), posts: [] });
  const page = await tab(key, 1280);
  await page.goto(`${ORIGIN}/admin/advisory/#/run`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ar-card');
  await page.evaluate(() => { const d = [...document.querySelectorAll('.ar-fold')].find((x) => x.querySelector('summary').textContent.startsWith('Goal, term')); d.open = true; d.id = 'goal-fold'; });
  await page.select('#goal-fold select', 'casey-board');
  await settle(60);
  await page.evaluate(() => [...document.querySelectorAll('#goal-fold button')].find((b) => b.textContent === 'Save').click());
  await settle(200);
  check((await page.evaluate(() => document.querySelector('.ask')?.textContent || '')).includes('Hand the group to Casey Board?'), 'Run it: handing the group over names who');
  await press(page, 'Keep it as it is');
  check(!worlds.get(key).posts.some((x) => x.action === 'save-settings'), 'Run it: and saying no saves nothing');
  await page.select('#goal-fold select', 'morgan-lead');
  await settle(60);
  await page.close();
}

// ─── Board | Advisory ───────────────────────────────────────────────
for (const width of [390, 1280]) {
  const page = await tab('admin/filled', width);
  await page.goto(`${ORIGIN}/__side.html#board/members`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.bd-side', { timeout: 6000 }).catch(() => {});
  const where = () => page.evaluate(() => [...document.querySelectorAll('.hub-tab')].map((b) => { const r = b.getBoundingClientRect(); return `${b.textContent.trim()}@${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}`; }).join(' '));
  const board = await where();
  check(board.includes('Members'), `Board's tabs are there (${width})`);
  await page.screenshot({ path: join(SHOTS, `side-board-${width}.png`) });
  await page.evaluate(() => [...document.querySelectorAll('.bd-side button')].find((b) => b.textContent === 'Advisory').click());
  await page.waitForSelector('.ar', { timeout: 6000 }).catch(() => {});
  await settle(300);
  check(page.url().endsWith('#board/advisory/members'), 'the switch has its own address, on the same tab');
  check((await where()) === board, `the tabs don't move when it flips (${width}): ${await where()} vs ${board}`);
  check(await has(page, '.ar-card'), 'the Advisory side opens on Board');
  check(!(await has(page, '.ar-tabs')), 'it uses Board’s tabs there, not a second row');
  check((await overflow(page)) <= 0, `the Advisory side fits (${width})`);
  await page.screenshot({ path: join(SHOTS, `side-advisory-${width}.png`), fullPage: true });
  await page.goto(`${ORIGIN}/__side.html#board`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.ar', { timeout: 6000 }).catch(() => {});
  check(await has(page, '.ar'), 'a plain #board opens on the side this device last had');
  await page.evaluate(() => [...document.querySelectorAll('.bd-side button')].find((b) => b.textContent === 'Board').click());
  await settle(300);
  check(page.url().endsWith('#board/members') || page.url().endsWith('#board'), 'flipping back goes to Board');
  check(!(await has(page, '.ar')), 'Board is Board again');
  await page.close();
}

await barFits();
for (const n of [...new Set(noise)]) check(false, `console: ${n}`);
await browser.close();
server.close();
console.log(`\n${passed} ✓  ${failures.length} ✗`);
process.exit(failures.length ? 1 : 0);
