/**
 * The Advisory Board's page and the tools that run it (functions/api/_advisory*.js, advisory-*.js)
 * Run: node --test tests/advisory.test.mjs
 *
 * The first block is the one that matters most: what an advisor's sign-in can reach. Everything an advisor gets is
 * built from an allow-list, and these tests seed the board's private things and prove they don't come through.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  ensureAdvisory, whoIs, getSettings, saveSettings, saveAsk, putAskOut, currentAsk, answerAsk, addIntro, introsBy, setIntroStatus, requestHost, setHosted,
  saveDoc, signDoc, termOf, renew, canRenew, moveSlug,
} from '../functions/api/_advisory.js';
import { advisoryPortalData } from '../functions/api/_advisory-portal.js';
import { seedOnce } from '../functions/api/_advisory-seed.js';
import { sharableBoardDocs } from '../functions/api/_board.js';
import { routesFor, advisorFor, boardMemberFor, BOARD_ROUTES, ADVISORY_ROUTES, isGroupInbox, writeState } from '../functions/api/_board-roles.js';
import { everyoneSignIns, boardSignIns } from '../functions/api/_board-access.js';
import { staffStanding } from '../functions/api/_staff-access.js';
import { centsOf, tally, readMoney, goalNow, moneyView, advisorIn, maybeReadMoney } from '../functions/api/_advisory-money.js';
import { kidCard, pickableKids, keepPledge, ADVISORY_PARTNER } from '../functions/api/_advisory-sponsor.js';
import { linkFrom, answerFromLink, askEmail, sendAsk, sendWelcome, mailLog } from '../functions/api/_advisory-mail.js';
import { advisoryFileFor } from '../functions/api/advisory-file.js';
import { onRequestGet as actionGet, onRequestPost as actionPost } from '../functions/api/advisory-action.js';
import { onRequestPost as pledgePost } from '../functions/api/sponsors-admin.js';
import { guestGroups, NO_REVEAL_INVITE, NOT_STAFF } from '../functions/api/_reveal-invites.js';
import { countedPledges } from '../functions/api/_makeover-costs.js';
import { listPeople } from '../functions/api/_demo-invites.js';
import { pickKid, clearKid } from '../functions/api/_advisory-sponsor.js';
import { onRequestPost as adminPost } from '../functions/api/advisory-admin.js';

const NOW = Date.parse('2026-11-05T16:00:00Z');
const PEOPLE = [
  ['ada-advisor', { name: 'Ada Advisor', group: 'advisory', title: 'Advisory Board Member', organization: 'Ada Co', bio: 'Builds things.' }],
  ['ben-advisor', { name: 'Ben Advisor', group: 'advisory', title: 'Advisory Board Member' }],
  ['dee-draft', { name: 'Dee Draft', group: 'advisory', title: 'Advisory Board Member', publishStatus: 'draft' }],
  ['old-advisor', { name: 'Old Advisor', group: 'advisory', title: 'Advisory Board Member', status: 'alumni' }],
  ['mary-atchley', { name: 'Mary Atchley', group: 'board', title: 'Board Member', committees: ['Advisory Board'] }],
  ['travis-couick', { name: 'Travis Couick', group: 'board', title: 'Board Member', committees: ['Advisory Board', 'Governance'] }],
  ['bo-kim', { name: 'Bo Kim', group: 'board', title: 'Treasurer', committees: ['Finance'] }],
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', role: 'founder' }],
];
const EMAILS = { 'ada-advisor': 'ada@private.example', 'ben-advisor': 'ben.secret@private.example', 'dee-draft': 'dee@private.example', 'old-advisor': 'old@private.example', 'mary-atchley': 'mary@private.example', 'travis-couick': 'travis@private.example', 'bo-kim': 'bo@private.example' };
const KIDS = [
  ['pat-2026', { name: 'Pat Sample', status: 'needs-funding', year: 2026, heroImage: '/cdn-cgi/imagedelivery/x/kids/pat/w=640', jobtreadJobId: '' }],
  ['hidden-kid', { name: 'Zelda Secretname', status: 'needs-funding', publishStatus: 'draft', year: 2026 }],
  ['built-kid', { name: 'Remy Built', status: 'in-progress', year: 2026 }],
];

let env;
const ctx = (data) => ({ env, data });
const advisor = async (slug = 'ada-advisor') => whoIs(ctx({ advisor: { slug, name: PEOPLE.find(([s]) => s === slug)[1].name, email: EMAILS[slug] } }));

beforeEach(async () => {
  env = { DB: await createD1() };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, status TEXT, featured INTEGER, child_count INTEGER, room_count INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE partners (slug TEXT PRIMARY KEY, name TEXT, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE events (slug TEXT PRIMARY KEY, data TEXT NOT NULL)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  for (const [slug, email] of Object.entries(EMAILS)) await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  for (const [slug, d] of KIDS) await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.year, JSON.stringify(d)).run();
  await ensureAdvisory(env.DB);
});

// ─── What an advisor can reach ──────────────────────────────────────

test('an advisor reaches only the advisors’ routes; a stranger reaches nothing', () => {
  const routes = routesFor({ advisor: { slug: 'a' } });
  assert.deepEqual(routes, [...ADVISORY_ROUTES]);
  for (const r of BOARD_ROUTES) assert.ok(!routes.includes(r), r);
  assert.ok(!routes.includes('/api/board-admin'));
  assert.deepEqual(routesFor({}), []);
});

test('only active, published advisors can sign in, and a board member is never taken for one', async () => {
  assert.equal((await advisorFor(env.DB, 'ADA@private.example')).slug, 'ada-advisor');
  assert.equal(await advisorFor(env.DB, EMAILS['dee-draft']), null, 'a draft');
  assert.equal(await advisorFor(env.DB, EMAILS['old-advisor']), null, 'someone who left');
  assert.equal(await advisorFor(env.DB, EMAILS['bo-kim']), null, 'a board member');
  assert.equal(await boardMemberFor(env.DB, EMAILS['ada-advisor']), null, 'an advisor is not a board member');
});

test('the Access list holds the board and advisors; the board count stays the board’s', async () => {
  const all = (await everyoneSignIns(env.DB)).emails;
  assert.ok(all.includes(EMAILS['ada-advisor']) && all.includes(EMAILS['bo-kim']));
  assert.ok(!all.includes(EMAILS['dee-draft']) && !all.includes(EMAILS['old-advisor']));
  assert.ok(!(await boardSignIns(env.DB)).emails.includes(EMAILS['ada-advisor']));
});

test('who is who: the lead runs it, the committee reads it, other board members get nothing', async () => {
  const mary = await whoIs(ctx({ boardMember: { slug: 'mary-atchley', name: 'Mary Atchley', committees: ['Advisory Board'] } }));
  assert.equal(mary.kind, 'lead'); assert.ok(mary.runs); assert.ok(!mary.answers);
  const travis = await whoIs(ctx({ boardMember: { slug: 'travis-couick', name: 'Travis Couick', committees: ['Advisory Board'] } }));
  assert.equal(travis.kind, 'committee'); assert.ok(!travis.runs);
  assert.equal(await whoIs(ctx({ boardMember: { slug: 'bo-kim', name: 'Bo Kim', committees: ['Finance'] } })), null);
  const ada = await advisor();
  assert.ok(ada.answers); assert.ok(!ada.runs);
  assert.equal(await whoIs(ctx({ userEmail: 'stranger@example.com' })), null);
});

test('nothing private reaches an advisor’s page', async () => {
  // The board's private things, seeded so they could leak
  await writeState(env.DB, 'gifts', { list: [{ name: 'Secret Donor', cents: 900000 }] });
  await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('fam-2026', 'Fam', 2026, JSON.stringify({ name: 'Fam Hidden', publishStatus: 'draft', status: 'needs-funding', diagnosis: 'private diagnosis' })).run();
  const intro = await addIntro(env.DB, 'ben-advisor', { name: 'Bens Contact', email: 'contact@private.example', phone: '770-555-0100', how: 'my brother' });
  await requestHost(env.DB, 'ben-advisor', { title: 'Bens Party', notes: 'private notes' });
  const page = await advisoryPortalData(env, await advisor(), { now: NOW });
  const text = JSON.stringify(page);
  for (const secret of ['Secret Donor', 'private diagnosis', 'Fam Hidden', 'Zelda', 'Secretname', 'ben.secret@private.example', 'mary@private.example', 'dee@', 'Bens Contact', 'contact@private', '770-555', 'Bens Party', intro.id]) {
    assert.ok(!text.includes(secret), `leaked: ${secret}`);
  }
  for (const key of ['numbers', 'cashHistory', 'gifts', 'snapshot', 'actions', 'nextPending', 'quorum', 'minutes', 'approvals', 'costs']) {
    assert.ok(!(key in page), `board key on the page: ${key}`);
  }
  assert.ok(page.people.every((p) => !('email' in p)), 'no email on a card');
  assert.deepEqual(page.people.map((p) => p.name), ['Ada Advisor', 'Ben Advisor'], 'active and published only');
});

test('dollars are only under fundraise, and an advisor sees only their own', async () => {
  await saveSettings(env.DB, { campaignId: 'camp', pages: { p1: 'ada-advisor', p2: 'ben-advisor' } });
  await writeState(env.DB, 'advisory-money', { at: new Date(NOW).toISOString(), cents: 1500000, byAdvisor: { 'ada-advisor': 500000, 'ben-advisor': 1000000 }, counts: {}, pages: [] });
  const page = await advisoryPortalData(env, await advisor(), { now: NOW });
  assert.equal(page.fundraise.raised, 15000);
  assert.equal(page.fundraise.mine, 5000);
  const { fundraise, ...rest } = page;
  assert.ok(!/15000|10000|\b5000\b/.test(JSON.stringify(rest)), 'a figure outside fundraise');
  assert.ok(!JSON.stringify(fundraise).includes('10000'), 'another advisor’s number');
});

// ─── Documents ──────────────────────────────────────────────────────

const boardPaper = async (id, title, { sign = false, shared = true, body = '', staff = 0, file = `f_${id.slice(2)}` } = {}) => {
  await sharableBoardDocs(env.DB);
  await env.DB.prepare('INSERT INTO board_docs (id, data) VALUES (?, ?)').bind(id, JSON.stringify({ id, title, kind: 'governance', sign, shared, body })).run();
  await env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, staff_only, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(file, 'doc', id, `board/${file}`, `${title}.pdf`, 'application/pdf', 1000, staff, new Date(NOW).toISOString()).run();
};

test('a board paper reaches advisors only when it’s turned on, and only its current file', async () => {
  await boardPaper('d_wnine', 'W-9');
  await boardPaper('d_bylaw', 'Bylaws');
  const ada = await advisor();
  assert.deepEqual((await advisoryPortalData(env, ada, { now: NOW })).fromBoard.filter((d) => d.id === 'd_bylaw'), [], 'off until someone turns it on');
  assert.equal(await advisoryFileFor(env.DB, 'f_bylaw', ada), null);
  await saveSettings(env.DB, { boardDocs: ['d_wnine'] });
  const page = await advisoryPortalData(env, ada, { now: NOW });
  assert.deepEqual(page.fromBoard, [{ id: 'd_wnine', title: 'W-9', file: { id: 'f_wnine', name: 'W-9.pdf', type: 'application/pdf', size: 1000 } }]);
  assert.ok(await advisoryFileFor(env.DB, 'f_wnine', ada));
  assert.equal(await advisoryFileFor(env.DB, 'f_bylaw', ada), null, 'its neighbor stays closed');
  // A new copy replaces it: the old one closes
  await env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, staff_only, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind('f_wnine2', 'doc', 'd_wnine', 'board/f_wnine2', 'W-9.pdf', 'application/pdf', 1000, 0, new Date(NOW + 1000).toISOString()).run();
  assert.ok(await advisoryFileFor(env.DB, 'f_wnine2', ada));
  assert.equal(await advisoryFileFor(env.DB, 'f_wnine', ada), null);
  // Turned off: gone the same moment
  await saveSettings(env.DB, { boardDocs: [] });
  assert.equal(await advisoryFileFor(env.DB, 'f_wnine2', ada), null);
  assert.deepEqual((await advisoryPortalData(env, ada, { now: NOW })).fromBoard, []);
});

test('a paper the board signs, a written paper, a staff-only file or a hidden one can’t be turned on', async () => {
  await boardPaper('d_oktoo', 'Charity permit');
  await boardPaper('d_signs', 'Conflict of interest', { sign: true });
  await boardPaper('d_words', 'Written here', { body: 'Words' });
  await boardPaper('d_staff', 'Staff copy', { staff: 1 });
  await boardPaper('d_hides', 'Hidden', { shared: false });
  assert.deepEqual((await sharableBoardDocs(env.DB)).map((d) => d.id), ['d_oktoo']);
  await saveSettings(env.DB, { boardDocs: [] });
  for (const id of ['d_signs', 'd_words', 'd_staff', 'd_hides', 'd_nope1']) assert.equal((await runIt({ action: 'board-doc', id, on: true })).status, 400, id);
  assert.equal((await runIt({ action: 'board-doc', id: 'd_oktoo', on: true })).status, 200);
  assert.deepEqual((await getSettings(env.DB)).boardDocs, ['d_oktoo']);
  await runIt({ action: 'save-settings', settings: { boardDocs: ['d_signs'] } });
  assert.deepEqual((await getSettings(env.DB)).boardDocs, ['d_oktoo'], 'only its own switch changes this');
  // Even written straight in, the page and the file route still refuse
  await saveSettings(env.DB, { boardDocs: ['d_signs', 'd_staff'] });
  assert.deepEqual((await advisoryPortalData(env, await advisor(), { now: NOW })).fromBoard, []);
  for (const f of ['f_signs', 'f_staff']) assert.equal(await advisoryFileFor(env.DB, f, await advisor()), null, f);
});

test('Documents start with SOARD’s own pages and the four papers any donor gets, once', async () => {
  await boardPaper('d_wnine', 'W-9'); await boardPaper('d_einlt', 'EIN letter'); await boardPaper('d_irsdl', 'IRS 501(c)(3) determination letter');
  await boardPaper('d_permi', 'Charitable Organization Permit'); await boardPaper('d_bylaw', 'Signed Amended Bylaws'); await boardPaper('d_dando', 'D&O insurance');
  // Close to those titles, and none of them
  await boardPaper('d_nearx', 'Determination of Executive Compensation 2025'); await boardPaper('d_neary', 'Building permit, a family’s home'); await boardPaper('d_nearz', 'Invoice 15012 reconciliation'); await boardPaper('d_nearw', 'W-9 for a person');
  await seedOnce(env.DB, () => sharableBoardDocs(env.DB));
  assert.deepEqual([...(await getSettings(env.DB)).boardDocs].sort(), ['d_einlt', 'd_irsdl', 'd_permi', 'd_wnine']);
  const page = await advisoryPortalData(env, await advisor(), { now: NOW });
  assert.ok(page.library.length === 7 && page.library.every((d) => page.shelves.some((s) => s.id === d.shelf) && /^https:\/\/sunshineonaranneyday\.com\//.test(d.url)));
  assert.ok(!JSON.stringify(page.library).includes('—'), 'no em dashes');
  // Someone turns one off and deletes a link: neither comes back
  await saveSettings(env.DB, { boardDocs: ['d_wnine'] });
  const { deleteDoc, listDocs } = await import('../functions/api/_advisory.js');
  const gone = page.library[0].id;
  await deleteDoc(env.DB, gone);
  await seedOnce(env.DB, () => sharableBoardDocs(env.DB));
  assert.deepEqual((await getSettings(env.DB)).boardDocs, ['d_wnine']);
  assert.ok(!(await listDocs(env.DB)).some((d) => d.id === gone));
});

test('a shelf holds a link or a file: a draft or an empty one stays off, and no staff fields come through', async () => {
  await assert.rejects(saveDoc(env.DB, { kind: 'library', title: 'Nowhere' }), /shelf/);
  await assert.rejects(saveDoc(env.DB, { kind: 'library', title: 'Bad', shelf: 'secret' }), /shelf/);
  await assert.rejects(saveDoc(env.DB, { kind: 'library', title: 'Bad link', shelf: 'about', url: 'javascript:alert(1)' }), /web address/);
  const link = await saveDoc(env.DB, { kind: 'library', title: 'A link', note: 'Why', shelf: 'marketing', url: 'example.com/x' });
  assert.equal(link.url, 'https://example.com/x');
  await saveDoc(env.DB, { kind: 'library', title: 'Empty', shelf: 'about' });
  await saveDoc(env.DB, { kind: 'library', title: 'Draft', shelf: 'about', url: 'https://example.com/d', shared: false });
  const titles = (await advisoryPortalData(env, await advisor(), { now: NOW })).library.map((d) => d.title);
  assert.ok(titles.includes('A link'));
  assert.ok(!titles.includes('Empty') && !titles.includes('Draft'));
  const row = (await advisoryPortalData(env, await advisor(), { now: NOW })).library.find((d) => d.title === 'A link');
  assert.deepEqual(Object.keys(row).sort(), ['files', 'id', 'note', 'shelf', 'title', 'url']);
  assert.ok(!(await advisoryPortalData(env, await advisor(), { now: NOW })).papers.some((d) => d.kind === 'library'));
});

test('photos come only from a child whose page is public, and keep their place in SOARD’s list', async () => {
  await env.DB.prepare('INSERT INTO site_config (key, data) VALUES (?, ?)').bind('media', JSON.stringify({ brandingPhotos: [
    { kidSlug: 'hidden-kid', cfId: 'kids/zelda/1', caption: 'Zelda Secretname' }, { kidSlug: 'pat-2026', cfId: 'kids/pat/2', caption: 'Pat — Spina Bifida & Hydrocephalus' }, { kidSlug: 'pat-2026', cfId: '', caption: 'No picture' },
  ] })).run();
  const { photos } = await advisoryPortalData(env, await advisor(), { now: NOW });
  assert.equal(photos.length, 1);
  assert.equal(photos[0].download, '/api/download-branding-photos?photo=1');
  assert.ok(photos[0].photo.includes('kids/pat/2'));
  assert.ok(!JSON.stringify(photos).includes('Zelda'));
  assert.equal(photos[0].caption, 'Pat Sample', 'their name from their page, never the caption');
  assert.ok(!JSON.stringify(photos).includes('Spina'));
});

test('official logos only, and the group’s seal once it’s a Partner', async () => {
  await env.DB.exec('CREATE TABLE IF NOT EXISTS partners (slug TEXT PRIMARY KEY, data TEXT NOT NULL)');
  let { brand } = await advisoryPortalData(env, await advisor(), { now: NOW });
  assert.ok(brand.logos.length >= 3 && brand.logos.every((l) => l.png.startsWith('/api/download-logo?id=')));
  assert.equal(brand.seal, '');
  await env.DB.prepare('INSERT OR REPLACE INTO partners (slug, data) VALUES (?, ?)').bind('soard-advisory-board', JSON.stringify({ logo: 'https://imagedelivery.net/x/partners/seal/public' })).run();
  ({ brand } = await advisoryPortalData(env, await advisor(), { now: NOW }));
  assert.ok(brand.seal.includes('partners/seal'));
});

test('a board paper that stops being sharable needs someone to turn it on again', async () => {
  await boardPaper('d_wnine', 'W-9');
  await saveSettings(env.DB, { boardDocs: ['d_wnine'], library: true });
  const ada = await advisor();
  assert.equal((await advisoryPortalData(env, ada, { now: NOW })).fromBoard.length, 1);
  await env.DB.prepare('UPDATE board_docs SET data = ? WHERE id = ?').bind(JSON.stringify({ id: 'd_wnine', title: 'W-9', kind: 'governance', shared: false }), 'd_wnine').run();
  assert.equal((await advisoryPortalData(env, ada, { now: NOW })).fromBoard.length, 0);
  await env.DB.prepare('UPDATE board_docs SET data = ? WHERE id = ?').bind(JSON.stringify({ id: 'd_wnine', title: 'W-9', kind: 'governance', shared: true }), 'd_wnine').run();
  assert.equal((await advisoryPortalData(env, ada, { now: NOW })).fromBoard.length, 0);
  assert.deepEqual((await getSettings(env.DB)).boardDocs, []);
});

test('a paper the board takes back is off at once, whoever visits next, and doesn’t come back when it changes back', async () => {
  const { saveDoc: saveBoardDoc, updateFile } = await import('../functions/api/_board.js');
  await boardPaper('d_wnine', 'W-9');
  await boardPaper('d_einlt', 'EIN letter');
  await saveSettings(env.DB, { boardDocs: ['d_wnine', 'd_einlt'], library: true });
  // No advisor loads the page anywhere in here
  await saveBoardDoc(env.DB, { id: 'd_wnine', title: 'W-9', kind: 'governance', sign: true, shared: true }, { by: 'x' });
  assert.deepEqual((await getSettings(env.DB)).boardDocs, ['d_einlt']);
  await saveBoardDoc(env.DB, { id: 'd_wnine', title: 'W-9', kind: 'governance', sign: false, shared: true }, { by: 'x' });
  assert.deepEqual((await getSettings(env.DB)).boardDocs, ['d_einlt'], 'changing it back doesn’t turn it back on');
  await updateFile(env.DB, 'f_einlt', { staffOnly: true });
  assert.deepEqual((await getSettings(env.DB)).boardDocs, []);
  await updateFile(env.DB, 'f_einlt', { staffOnly: false });
  assert.deepEqual((await advisoryPortalData(env, await advisor(), { now: NOW })).fromBoard, []);
});

test('deleting a paper takes its file, and a tab left open can’t bring either back', async () => {
  await seedOnce(env.DB);
  const doc = await saveDoc(env.DB, { kind: 'library', title: 'Wrong upload', shelf: 'marketing' });
  await sharableBoardDocs(env.DB);
  await env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key) VALUES (?, ?, ?, ?)').bind('f_wrongone', 'advisory-doc', doc.id, 'board/f_wrongone').run();
  env.BOARD_FILES = { delete: async () => {}, get: async () => null };
  env.FILES = env.BOARD_FILES;
  const del = await runIt({ action: 'delete-doc', id: doc.id });
  assert.equal(del.status, 200);
  assert.equal(await env.DB.prepare('SELECT id FROM board_files WHERE id = ?').bind('f_wrongone').first(), null);
  const stale = await runIt({ action: 'save-doc', base: doc.updatedAt, doc: { id: doc.id, kind: 'library', title: 'Wrong upload', shelf: 'marketing' } });
  assert.equal(stale.status, 410);
  const { listDocs } = await import('../functions/api/_advisory.js');
  assert.ok(!(await listDocs(env.DB)).some((d) => d.id === doc.id));
});

test('first-day papers never write over one that’s already there', async () => {
  await saveDoc(env.DB, { id: 'ad_seedliba', kind: 'library', shelf: 'marketing', title: 'Mine now', url: 'https://example.com/mine' });
  await seedOnce(env.DB);
  const { listDocs } = await import('../functions/api/_advisory.js');
  assert.equal((await listDocs(env.DB)).find((d) => d.id === 'ad_seedliba').title, 'Mine now');
});

test('a group inbox can never open the staff admin, even with Google unreadable or a +tag', async () => {
  for (const e of ['advisory@soardcharity.com', 'board@soardcharity.com', 'Advisory+x@soardcharity.com', 'advisory+anything@soardcharity.com']) {
    assert.ok(isGroupInbox(e), e);
    assert.equal((await staffStanding({ DB: null }, e)).staff, false, e);
  }
  assert.ok(!isGroupInbox('peter@soardcharity.com'));
});

test('advisory-file serves only the advisors’ own files on shared papers', async () => {
  await env.DB.exec('CREATE TABLE IF NOT EXISTS board_files (id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, r2_key TEXT NOT NULL, name TEXT, type TEXT, size INTEGER, kind TEXT, staff_only INTEGER DEFAULT 0, at TEXT, by TEXT)');
  const open = await saveDoc(env.DB, { kind: 'overview', title: 'Overview' });
  const closed = await saveDoc(env.DB, { kind: 'overview', title: 'Draft', shared: false });
  const add = (id, type, owner, staff = 0) => env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, staff_only) VALUES (?, ?, ?, ?, ?)').bind(id, type, owner, `board/${id}`, staff).run();
  await add('f_open', 'advisory-doc', open.id); await add('f_closed', 'advisory-doc', closed.id); await add('f_staff', 'advisory-doc', open.id, 1); await add('f_board', 'doc', 'd_x'); await add('f_meeting', 'meeting', 'm_x');
  const ada = await advisor();
  assert.ok(await advisoryFileFor(env.DB, 'f_open', ada));
  for (const id of ['f_closed', 'f_staff', 'f_board', 'f_meeting']) assert.equal(await advisoryFileFor(env.DB, id, ada), null, id);
  assert.equal(await advisoryFileFor(env.DB, 'f_board', { runs: true }), null, 'even whoever runs it can’t open a board file here');
});

test('whoever runs the group can’t delete a board file through the advisors’ route', async () => {
  const { onRequestPost } = await import('../functions/api/advisory-admin.js');
  await env.DB.exec('CREATE TABLE IF NOT EXISTS board_files (id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, r2_key TEXT NOT NULL, name TEXT, type TEXT, size INTEGER, kind TEXT, staff_only INTEGER DEFAULT 0, at TEXT, by TEXT)');
  await env.DB.prepare("INSERT INTO board_files (id, owner_type, owner_id, r2_key) VALUES ('f_board1', 'doc', 'd_x', 'board/f')").run();
  const res = await onRequestPost({ env, data: { boardMember: { slug: 'mary-atchley', name: 'Mary Atchley', email: EMAILS['mary-atchley'], committees: ['Advisory Board'] } }, request: new Request('https://x/api/advisory-admin', { method: 'POST', body: JSON.stringify({ action: 'delete-file', id: 'f_board1' }) }) });
  assert.equal(res.status, 404);
  assert.ok(await env.DB.prepare("SELECT id FROM board_files WHERE id = 'f_board1'").first(), 'the board file is still there');
});

// ─── The ask, introductions, hosting, signing, renewing ─────────────

test('one ask is out at a time, and an answer is theirs to change', async () => {
  const a = await saveAsk(env.DB, { title: 'First' }); const b = await saveAsk(env.DB, { title: 'Second' });
  await putAskOut(env.DB, a.id, { now: NOW });
  await putAskOut(env.DB, b.id, { now: NOW + 1000 });
  assert.equal((await currentAsk(env.DB)).id, b.id);
  await assert.rejects(answerAsk(env.DB, a.id, 'ada-advisor', { answer: 'yes' }), /closed/);
  await answerAsk(env.DB, b.id, 'ada-advisor', { answer: 'no' });
  assert.equal((await answerAsk(env.DB, b.id, 'ada-advisor', { answer: 'yes', note: 'changed my mind' })).note, 'changed my mind');
  await assert.rejects(answerAsk(env.DB, b.id, 'ada-advisor', { answer: 'maybe' }), /Choose/);
});

test('an advisor sees only their own introductions, and status changes are told once', async () => {
  const i = await addIntro(env.DB, 'ada-advisor', { name: 'Sam Trades', company: 'Sam Plumbing', help: ['vendor', 'nonsense'] });
  await addIntro(env.DB, 'ben-advisor', { name: 'Someone Else' });
  assert.deepEqual((await introsBy(env.DB, 'ada-advisor')).map((x) => x.name), ['Sam Trades']);
  assert.deepEqual(i.help, ['vendor']);
  assert.equal((await setIntroStatus(env.DB, i.id, { status: 'talking' })).changed, true);
  assert.equal((await setIntroStatus(env.DB, i.id, { status: 'talking', note: 'called' })).changed, false);
  await assert.rejects(setIntroStatus(env.DB, i.id, { status: 'other' }), /stands/);
  await assert.rejects(addIntro(env.DB, 'ada-advisor', { name: 'X', email: 'nope' }), /email/);
});

test('a hosted fundraiser appears on Coming up only once approved, with a date ahead', async () => {
  const h = await requestHost(env.DB, 'ada-advisor', { title: 'Backyard BBQ' });
  const look = async () => (await advisoryPortalData(env, await advisor(), { now: NOW })).coming.hosted;
  assert.equal((await look()).length, 0);
  await setHosted(env.DB, h.id, { status: 'approved', date: '2026-12-01' });
  assert.equal((await look())[0].title, 'Backyard BBQ');
  await setHosted(env.DB, h.id, { status: 'approved', date: '2026-01-01' });
  assert.equal((await look()).length, 0, 'a day gone by');
});

test('the first words are written once, no em dashes, and a deleted one stays gone', async () => {
  const { seedOnce } = await import('../functions/api/_advisory-seed.js');
  assert.equal(await seedOnce(env.DB), true);
  assert.equal(await seedOnce(env.DB), false);
  const { listDocs, listWishes, listAsks, deleteDoc } = await import('../functions/api/_advisory.js');
  const docs = (await listDocs(env.DB)).filter((d) => d.kind !== 'library');
  assert.equal(docs.length, 7);
  assert.ok(!JSON.stringify([docs, await listWishes(env.DB), await listAsks(env.DB)]).includes('—'), 'no em dashes');
  assert.equal((await currentAsk(env.DB)), null, 'the first ask waits for a person');
  await deleteDoc(env.DB, docs[0].id);
  await seedOnce(env.DB);
  assert.equal((await listDocs(env.DB)).filter((d) => d.kind !== 'library').length, 6);
});

test('signing takes their own name, and the to-do clears', async () => {
  const { seedOnce } = await import('../functions/api/_advisory-seed.js'); await seedOnce(env.DB);
  const { listDocs } = await import('../functions/api/_advisory.js');
  const d = (await listDocs(env.DB)).find((x) => x.kind === 'agreement');
  const ada = await advisor();
  assert.equal((await advisoryPortalData(env, ada, { now: NOW })).todos[0].kind, 'sign');
  await assert.rejects(signDoc(env.DB, d.id, ada, 'Someone Else', { now: NOW, version: d.version }), /Type your name/);
  await assert.rejects(signDoc(env.DB, d.id, ada, 'Ada Advisor', { now: NOW, version: 99 }), /changed/);
  await signDoc(env.DB, d.id, ada, 'ada advisor', { now: NOW, version: d.version });
  assert.ok(!(await advisoryPortalData(env, ada, { now: NOW })).todos.some((t) => t.kind === 'sign'));
  // New words: sign again
  await saveDoc(env.DB, { id: d.id, kind: 'agreement', title: d.title, body: 'New words' });
  assert.equal((await advisoryPortalData(env, ada, { now: NOW })).todos[0].kind, 'sign');
});

test('the agreement lasts the term: no second signature in January, one after renewing', async () => {
  const { seedOnce } = await import('../functions/api/_advisory-seed.js'); await seedOnce(env.DB);
  const { listDocs } = await import('../functions/api/_advisory.js');
  const d = (await listDocs(env.DB)).find((x) => x.kind === 'agreement');
  const ada = await advisor();
  await signDoc(env.DB, d.id, ada, 'Ada Advisor', { now: NOW, version: d.version });
  assert.ok(!(await advisoryPortalData(env, ada, { now: Date.parse('2027-01-02T16:00:00Z') })).todos.some((t) => t.kind === 'sign'));
  const s = await getSettings(env.DB);
  await renew(env.DB, 'ada-advisor', s, { now: Date.parse('2027-09-15T16:00:00Z') });
  assert.equal((await advisoryPortalData(env, ada, { now: Date.parse('2027-09-16T16:00:00Z') })).todos[0].kind, 'sign');
});

test('renewing opens near the end of a term and adds a year', async () => {
  const s = await getSettings(env.DB);
  await assert.rejects(renew(env.DB, 'ada-advisor', s, { now: NOW }), /closer/);
  const late = Date.parse('2027-09-15T16:00:00Z');
  assert.ok(canRenew(await termOf(env.DB, 'ada-advisor', s), '2027-09-15'));
  assert.equal((await renew(env.DB, 'ada-advisor', s, { now: late })).ends, '2028-10-22');
  assert.equal((await termOf(env.DB, 'ben-advisor', s)).ends, '2027-10-22', 'others keep theirs');
});

test('a renamed advisor keeps their records', async () => {
  await addIntro(env.DB, 'ada-advisor', { name: 'Sam' });
  await saveSettings(env.DB, { pages: { p1: 'ada-advisor' } });
  await moveSlug(env.DB, 'ada-advisor', 'ada-new');
  assert.equal((await introsBy(env.DB, 'ada-new')).length, 1);
  assert.equal((await getSettings(env.DB)).pages.p1, 'ada-new');
});

// ─── Money ──────────────────────────────────────────────────────────

const pay = (o) => ({ id: 'p', status: 'succeeded', amount: 10000, campaign_id: 'camp', refunds: [], ...o });

test('a refund, pending or done, or a lost dispute comes off; a failed refund doesn’t', () => {
  assert.equal(centsOf(pay({})), 10000);
  assert.equal(centsOf(pay({ refunds: [{ status: 'succeeded', amount: 2500 }] })), 7500);
  assert.equal(centsOf(pay({ refunds: [{ status: 'pending', amount: 2500 }] })), 7500);
  assert.equal(centsOf(pay({ refunds: [{ status: 'failed', amount: 2500 }] })), 10000);
  assert.equal(centsOf(pay({ refund_status: 'full' })), 0);
  assert.equal(centsOf(pay({ dispute: { status: 'lost' } })), 0);
  assert.equal(centsOf(pay({ dispute: { status: 'won' } })), 10000);
  assert.equal(centsOf(pay({ status: 'failed' })), 0);
  assert.equal(centsOf(pay({ metadata: { soardSelfTest: true } })), 0);
  assert.equal(centsOf(pay({ type: 'manual' })), 10000, 'a check entered in Zeffy counts');
});

test('tally: pages credit their advisor, the main page credits nobody, a credited gift counts once', () => {
  const advisors = [{ slug: 'ada', name: 'Ada Advisor' }, { slug: 'ben', name: 'Ben Advisor' }];
  const payments = [
    pay({ id: 'a', campaign_id: 'page-ada', parent_campaign_id: 'camp', amount: 5000 }),
    pay({ id: 'a', campaign_id: 'page-ada', parent_campaign_id: 'camp', amount: 5000 }),
    pay({ id: 'b', campaign_id: 'camp', parent_campaign_id: 'camp', amount: 2000 }),
    pay({ id: 'c', campaign_id: 'page-ben', parent_campaign_id: 'camp', amount: 3000 }),
    pay({ id: 'd', campaign_id: 'gala', amount: 7000 }),
    pay({ id: 'e', campaign_id: 'gala', amount: 9000 }),
  ];
  const r = tally({ campaignId: 'camp', payments, pages: { 'page-ada': 'ada' }, credits: [{ payment_id: 'd', slug: 'ben' }], advisors, titles: { 'page-ben': 'Ben Advisor’s Page' } });
  assert.equal(r.cents, 17000, 'd is credited; e is another campaign’s');
  assert.deepEqual(r.byAdvisor, { ada: 5000, ben: 10000 });
});

test('with no campaign set nothing counts but a credited gift, and a pasted link matches however it’s written', async () => {
  const { sameLink } = await import('../functions/api/_advisory-money.js');
  const r = tally({ campaignId: '', payments: [pay({ id: 'x', campaign_id: '' }), pay({ id: 'y', campaign_id: 'gala' })], pages: {}, credits: [], advisors: [] });
  assert.equal(r.cents, 0);
  assert.ok(sameLink('https://www.zeffy.com/en-US/page/', 'http://zeffy.com/en-us/page?x=1'));
  assert.ok(!sameLink('', ''));
});

test('a page’s title names its advisor only when it names exactly one', () => {
  const a = [{ slug: 'x', name: 'Ada Advisor' }, { slug: 'y', name: 'Ben Advisor' }];
  assert.equal(advisorIn('Ada Advisor fundraises for SOARD', a), 'x');
  assert.equal(advisorIn('Ada Advisor and Ben Advisor', a), '');
  assert.equal(advisorIn('The Advisory Board', a), '');
});

test('readMoney reads the term’s gifts, keeps the last whole sum when any step fails, and says who got new gifts', async () => {
  env.ZEFFY_API_KEY = 'k';
  await saveSettings(env.DB, { campaignId: 'camp', pages: { 'page-ada': 'ada-advisor' } });
  const s = await getSettings(env.DB);
  const seen = [];
  let list = [pay({ id: 'one', campaign_id: 'page-ada', parent_campaign_id: 'camp', amount: 40000 }), pay({ id: 'gala', campaign_id: 'gala', amount: 99900 })];
  const zeffy = async (url) => {
    const u = new URL(url); seen.push(u.pathname + u.search);
    const data = u.pathname.endsWith('/payments') ? list : u.pathname.endsWith('/campaigns') ? [{ id: 'page-ada', title: 'Ada Advisor', url: 'https://zeffy.example/ada' }] : [];
    return new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
  };
  const first = await readMoney(env, s, { fetchImpl: zeffy, now: NOW });
  assert.equal(first.state.cents, 40000, 'another campaign’s gift isn’t ours');
  assert.deepEqual(first.fresh, {}, 'the first read tells nobody');
  assert.ok(seen.some((x) => x.includes('created%5Blte%5D') || x.includes('created[lte]')), 'bounded by the term’s end');
  list = [...list, pay({ id: 'two', campaign_id: 'page-ada', parent_campaign_id: 'camp', amount: 10000 })];
  const second = await readMoney(env, s, { fetchImpl: zeffy, now: NOW + 1000 });
  assert.deepEqual(second.fresh, { 'ada-advisor': 1 });
  assert.equal((await goalNow(env, s, { slug: 'ada-advisor' })).pageUrl, 'https://zeffy.example/ada');
  // Any step failing leaves the last whole sum, and a recovery tells nobody twice
  for (const failing of ['/campaigns', '/payments']) {
    const partly = async (url) => (new URL(url).pathname.endsWith(failing) ? new Response('{}', { status: 429 }) : zeffy(url));
    const r = await readMoney(env, s, { fetchImpl: partly, now: NOW + 2000 });
    assert.equal(r.state.cents, 50000, `${failing} failing keeps the sum`);
    assert.deepEqual(r.fresh, {});
  }
  assert.ok((await moneyView(env, s)).error);
  assert.deepEqual((await readMoney(env, s, { fetchImpl: zeffy, now: NOW + 3000 })).fresh, {}, 'no second note after a recovery');
});

test('a gift credited from outside the term isn’t counted, and a failed read waits its turn', async () => {
  env.ZEFFY_API_KEY = 'k';
  await saveSettings(env.DB, { campaignId: 'camp' });
  await env.DB.prepare("INSERT INTO advisory_credits (payment_id, slug, at) VALUES ('old2023', 'ada-advisor', 'x')").run();
  let calls = 0;
  const zeffy = async () => { calls += 1; return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 }); };
  const s = await getSettings(env.DB);
  assert.equal((await readMoney(env, s, { fetchImpl: zeffy, now: NOW })).state.cents, 0);
  assert.equal(calls, 2, 'no separate read of the credited gift');
  await writeState(env.DB, 'advisory-money', { failedAt: new Date(NOW).toISOString(), error: 'down' });
  calls = 0;
  assert.equal(await maybeReadMoney(env, { fetchImpl: zeffy, now: NOW + 60000 }), null);
  assert.equal(calls, 0);
});

test('the goal is told once', async () => {
  env.ZEFFY_API_KEY = 'k';
  await saveSettings(env.DB, { campaignId: 'camp', goal: 100 });
  const zeffy = async (url) => new Response(JSON.stringify({ data: new URL(url).pathname.endsWith('/payments') ? [pay({ id: 'x', amount: 20000 })] : [], has_more: false }), { status: 200 });
  assert.equal((await maybeReadMoney(env, { fetchImpl: zeffy, now: NOW })).reachedGoal, true);
  assert.equal((await maybeReadMoney(env, { fetchImpl: zeffy, now: NOW + 20 * 60000 })).reachedGoal, false);
});

// ─── The kid ────────────────────────────────────────────────────────

test('only a waiting kid with a public page can be picked', async () => {
  assert.deepEqual((await pickableKids(env)).map((k) => k.slug), ['pat-2026']);
});

test('the card follows the public page: a kid drafted later drops off, and no dollar figure sits on it', async () => {
  const bits = { published: new Map([['pat-2026', { heroImage: 'x' }]]), reveals: [] };
  await saveSettings(env.DB, { kid: 'pat-2026' });
  const s = await getSettings(env.DB);
  const card = await kidCard(env, s, bits);
  assert.equal(card.state, 'kid'); assert.equal(card.name, 'Pat'); assert.equal(card.stage, 'Getting ready');
  assert.ok(!/\d{4,}/.test(JSON.stringify({ ...card, slug: '', url: '', photo: '' })), 'no figures');
  assert.equal((await kidCard(env, s, { ...bits, published: new Map() })).state, 'open', 'drafted later');
  assert.equal((await kidCard(env, await saveSettings(env.DB, { kid: '' }), bits)).state, 'open');
});

test('the pledge follows what’s raised, and staff can’t type over it', async () => {
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...KIDS[0][1], sponsors: [ADVISORY_PARTNER] }), 'pat-2026').run();
  await keepPledge(env, await saveSettings(env.DB, { kid: 'pat-2026' }), 9000, { now: NOW });
  const row = await env.DB.prepare('SELECT pledged, received FROM sponsor_pledges WHERE kid = ?').bind('pat-2026').first();
  assert.deepEqual([row.pledged, row.received], [9000, 9000]);
  const res = await pledgePost({ env, data: { userEmail: 'peter@soardcharity.com' }, request: new Request('https://x/api/sponsors-admin', { method: 'POST', body: JSON.stringify({ pledge: { kid: 'pat-2026', partner: ADVISORY_PARTNER, pledged: 1 } }) }) });
  assert.equal(res.status, 409);
});

test('the group’s raised money isn’t taken off a family’s cost twice; other sponsors’ pledges still are', () => {
  assert.deepEqual(countedPledges([{ slug: ADVISORY_PARTNER, pledged: 9000 }, { slug: 'acme', pledged: 500 }]).map((p) => p.slug), ['acme']);
});

test('with the emails switch off the group’s address isn’t on a Demo Day invite', async () => {
  assert.deepEqual((await listPeople(env.DB)).skip, ['advisory@soardcharity.com']);
  await saveSettings(env.DB, { emails: true });
  assert.deepEqual((await listPeople(env.DB)).skip, []);
});

const runIt = (body) => adminPost({ env, data: { boardMember: { slug: 'mary-atchley', name: 'Mary Atchley', email: EMAILS['mary-atchley'], committees: ['Advisory Board'] } }, request: new Request('https://x/api/advisory-admin', { method: 'POST', body: JSON.stringify(body) }) });

test('Run it saves only what a person sets: not the kid, the Zeffy pages, or who runs it', async () => {
  const res = await runIt({ action: 'save-settings', settings: { goal: 30000, kid: 'hidden-kid', seeded: true, pages: { x: 'y' }, carried: [{ amount: -500 }] } });
  assert.equal(res.status, 200);
  const s = await getSettings(env.DB);
  assert.equal(s.goal, 30000);
  assert.equal(s.kid, ''); assert.equal(s.seeded, undefined); assert.deepEqual(s.pages, {}); assert.deepEqual(s.carried, []);
  assert.equal((await runIt({ action: 'save-settings', settings: { lead: 'bo-kim' } })).status, 403);
});

test('picking a kid: last term’s finished makeover keeps its sponsor; one still open moves; a failure leaves nothing half done', async () => {
  await env.DB.prepare("INSERT INTO partners (slug, name, data) VALUES (?, 'SOARD Advisory Board', '{}')").bind(ADVISORY_PARTNER).run();
  const put = (slug, d) => env.DB.prepare('INSERT OR REPLACE INTO kids (slug, name, year, data) VALUES (?, ?, 2026, ?)').bind(slug, d.name, JSON.stringify(d)).run();
  await put('next-kid', { name: 'Noor Next', status: 'needs-funding', sponsors: [] });
  await pickKid(env, await getSettings(env.DB), 'pat-2026', { raised: 100, now: NOW });
  assert.equal((await getSettings(env.DB)).kid, 'pat-2026');
  const sponsorsOf = async (slug) => JSON.parse((await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first()).data).sponsors;
  assert.deepEqual(await sponsorsOf('pat-2026'), [ADVISORY_PARTNER]);
  assert.equal((await env.DB.prepare('SELECT partner, people FROM partner_contacts').first()).partner, ADVISORY_PARTNER);
  // An open one moves
  await pickKid(env, await getSettings(env.DB), 'next-kid', { raised: 100, now: NOW });
  assert.deepEqual(await sponsorsOf('pat-2026'), []);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM sponsor_pledges WHERE kid = ?').bind('pat-2026').first()).n, 0);
  // A finished one stays
  const noor = JSON.parse((await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind('next-kid').first()).data);
  await put('next-kid', { ...noor, status: 'completed' });
  await pickKid(env, await getSettings(env.DB), 'pat-2026', { raised: 0, now: NOW });
  assert.deepEqual(await sponsorsOf('next-kid'), [ADVISORY_PARTNER]);
  const out = await clearKid(env, await getSettings(env.DB), { now: NOW });
  assert.equal(out.settings.kid, '');
  // Choosing another after a finished makeover leaves it its sponsor and pledge, and a new term leaves the pledge alone
  await pickKid(env, await getSettings(env.DB), 'pat-2026', { raised: 25000, now: NOW });
  const pat = JSON.parse((await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind('pat-2026').first()).data);
  await put('pat-2026', { ...pat, status: 'completed' });
  await keepPledge(env, await getSettings(env.DB), 0, { now: NOW });
  assert.equal((await env.DB.prepare('SELECT pledged FROM sponsor_pledges WHERE kid = ?').bind('pat-2026').first()).pledged, 25000);
  await clearKid(env, await getSettings(env.DB), { now: NOW });
  assert.deepEqual(await sponsorsOf('pat-2026'), [ADVISORY_PARTNER]);
  await assert.rejects(pickKid(env, await getSettings(env.DB), 'hidden-kid', { now: NOW }), /public page/);
  assert.equal((await getSettings(env.DB)).kid, '');
});

test('an old email can’t answer for someone who left the group, or an ask that isn’t out', async () => {
  const draft = await saveAsk(env.DB, { title: 'Not out' });
  await assert.rejects(answerAsk(env.DB, draft.id, 'ada-advisor', { answer: 'yes' }), /isn’t out/);
});

test('a link gets its https://, and one that isn’t a link is refused out loud', async () => {
  const { webLink } = await import('../functions/api/_advisory.js');
  assert.equal(webLink('zeffy.com/x'), 'https://zeffy.com/x');
  assert.equal(webLink('http://zeffy.com/x'), 'https://zeffy.com/x');
  assert.equal(webLink(''), '');
  assert.throws(() => webLink('not a link'), /web address/);
  await assert.rejects(saveAsk(env.DB, { title: 'T', link: 'nope' }), /web address/);
  await assert.rejects(saveSettings(env.DB, { goal: '' }), /goal/);
});

test('a signature is their name, with no tricks', async () => {
  const d = await saveDoc(env.DB, { kind: 'agreement', title: 'A' });
  const ada = await advisor();
  await assert.rejects(signDoc(env.DB, d.id, ada, 'a d a advisor 123', { now: NOW, version: d.version }), /Type your name/);
  await signDoc(env.DB, d.id, ada, '  ADA   advisor ', { now: NOW, version: d.version });
});

test('the note on an introduction reaches the advisor, on the page', async () => {
  const i = await addIntro(env.DB, 'ada-advisor', { name: 'Sam' });
  await setIntroStatus(env.DB, i.id, { status: 'talking', note: 'Met for coffee' });
  assert.equal((await advisoryPortalData(env, await advisor(), { now: NOW })).intros[0].note, 'Met for coffee');
});

test('putting an ask out checks the switch as it stands now, whatever the screen thought', async () => {
  const { onRequestPost } = await import('../functions/api/advisory-admin.js');
  const ask = await saveAsk(env.DB, { title: 'A question' });
  await saveSettings(env.DB, { emails: true });
  const post = (body) => onRequestPost({ env, data: { boardMember: { slug: 'mary-atchley', name: 'Mary Atchley', email: EMAILS['mary-atchley'], committees: ['Advisory Board'] } }, request: new Request('https://x/api/advisory-admin', { method: 'POST', body: JSON.stringify(body) }) });
  const res = await post({ action: 'send-ask', id: ask.id });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).emails, true);
  assert.equal(await currentAsk(env.DB), null, 'nothing went out');
});

test('two people on one paper: the second is told, and an ask that went out can’t be deleted', async () => {
  const { deleteAsk } = await import('../functions/api/_advisory.js');
  const d = await saveDoc(env.DB, { kind: 'pitch', title: 'Pitch', body: 'One' }, { by: 'morgan', now: NOW });
  await saveDoc(env.DB, { id: d.id, kind: 'pitch', title: 'Pitch', body: 'Two' }, { by: 'jane', now: NOW + 1000, base: d.updatedAt });
  await assert.rejects(saveDoc(env.DB, { id: d.id, kind: 'pitch', title: 'Pitch', body: 'Three' }, { by: 'morgan', now: NOW + 2000, base: d.updatedAt }), /jane saved/);
  const ask = await putAskOut(env.DB, (await saveAsk(env.DB, { title: 'Out' })).id, { now: NOW });
  await assert.rejects(deleteAsk(env.DB, ask.id), /Close it/);
  const draft = await saveAsk(env.DB, { title: 'Draft' });
  await deleteAsk(env.DB, draft.id);
});

test('a kid’s finished room shows all year, from their public page', async () => {
  await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('done-kid', 'Dee', 2026, JSON.stringify({ name: 'Dee Done', status: 'completed', year: 2026, publishStatus: 'published' })).run();
  await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('old-kid', 'Old', 2019, JSON.stringify({ name: 'Old Done', status: 'completed', year: 2019 })).run();
  await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('draft-kid', 'Dot', 2026, JSON.stringify({ name: 'Dot Draft', status: 'completed', year: 2026, publishStatus: 'draft' })).run();
  const year = String(new Date().getFullYear());
  await env.DB.prepare('UPDATE kids SET year = ?, data = ? WHERE slug = ?').bind(Number(year), JSON.stringify({ name: 'Dee Done', status: 'completed', year: Number(year) }), 'done-kid').run();
  await env.DB.prepare('UPDATE kids SET year = ?, data = ? WHERE slug = ?').bind(Number(year), JSON.stringify({ name: 'Dot Draft', status: 'completed', year: Number(year), publishStatus: 'draft' }), 'draft-kid').run();
  const rooms = (await advisoryPortalData(env, await advisor())).rooms.map((r) => r.slug);
  assert.deepEqual(rooms, ['done-kid']);
});

test('emails have one font: nothing nested in the shell’s own paragraph', () => {
  const m = askEmail({ title: 'T', body: 'B' }, 'Ada', { yes: 'https://y', no: 'https://n' });
  assert.ok(!/<p[^>]*>\s*<p/.test(m.html));
});

test('a Zeffy address that isn’t SOARD’s is refused out loud, and a new one replaces the old id', async () => {
  const { onRequestPost } = await import('../functions/api/advisory-admin.js');
  env.ZEFFY_API_KEY = 'k';
  await saveSettings(env.DB, { campaignId: 'old', campaignUrl: 'https://zeffy.example/old' });
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'newone', url: 'https://www.zeffy.example/new/' }], has_more: false }), { status: 200 });
  try {
    const post = (settings) => onRequestPost({ env, data: { boardMember: { slug: 'mary-atchley', name: 'Mary Atchley', email: EMAILS['mary-atchley'], committees: ['Advisory Board'] } }, request: new Request('https://x/api/advisory-admin', { method: 'POST', body: JSON.stringify({ action: 'save-settings', settings }) }) });
    assert.equal((await post({ campaignUrl: 'https://zeffy.example/nope' })).status, 400);
    assert.equal((await getSettings(env.DB)).campaignId, 'old');
    assert.equal((await post({ campaignUrl: 'zeffy.example/new' })).status, 200);
    assert.equal((await getSettings(env.DB)).campaignId, 'newone');
  } finally { globalThis.fetch = real; }
});

test('advisory@ stays as it is until emails are on', async () => {
  const { maybeRunAdvisory } = await import('../functions/api/_advisory-heartbeat.js');
  env.GOOGLE_CALENDAR_KEY = 'x';
  await maybeRunAdvisory(env, { fetchImpl: async () => { throw new Error('nothing should be asked'); }, now: NOW });
  const { readState } = await import('../functions/api/_board-roles.js');
  assert.deepEqual(await readState(env.DB, 'advisory-group-runs'), {}, 'it didn’t even look');
});

test('editing a paper keeps its link and its place', async () => {
  const d = await saveDoc(env.DB, { kind: 'overview', title: 'Overview', url: 'https://files.example/o.pdf', sort: 3 });
  const e = await saveDoc(env.DB, { id: d.id, kind: 'overview', title: 'Overview', body: 'New words' });
  assert.equal(e.url, 'https://files.example/o.pdf'); assert.equal(e.sort, 3);
});

test('the group’s address gets Demo Day but no reveal invite: reveals keep their own list', () => {
  assert.ok(NO_REVEAL_INVITE.has('advisory@soardcharity.com'));
  assert.ok(!NOT_STAFF.has('advisory@soardcharity.com'), 'Demo Day shares NOT_STAFF, so it must stay off that list');
  const job = { aces: { nodes: [{ membership: { isInternal: false, role: { name: 'Monetary Sponsor' }, user: { name: 'SOARD Advisory Board', emailAddress: 'advisory@soardcharity.com' } } }] } };
  assert.equal(guestGroups(job).confirmed[0].kind, 'sponsor', 'seen as the sponsor');
});

// ─── The ask's email ────────────────────────────────────────────────

test('sendAsk does nothing with the switch off, and goes once with it on', async () => {
  const ask = await putAskOut(env.DB, (await saveAsk(env.DB, { title: 'Know a plumber?' })).id, { now: NOW });
  assert.deepEqual(await sendAsk(env, ask, { now: NOW }), { off: true });
  await saveSettings(env.DB, { emails: true });
  env.RESEND_API_KEY = 're_x';
  const realFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (u, o) => { sent.push(JSON.parse(o.body)); return new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 }); };
  try {
    const r = await sendAsk(env, ask, { now: NOW });
    assert.equal(r.sent, 2);
    assert.deepEqual(await sendAsk(env, ask, { now: NOW }), { already: true });
    assert.equal((await mailLog(env.DB))[0].kind, 'ask');
    const body = JSON.stringify(sent);
    assert.ok(!body.includes('ben.secret') || !JSON.stringify(sent[0]).match(/"to":\s*\[[^\]]*,/), 'no shared To line');
  } finally { globalThis.fetch = realFetch; }
});

test('replies go to whoever runs the group, and to info@ while nobody does', async () => {
  await saveSettings(env.DB, { emails: true, lead: '' });
  env.RESEND_API_KEY = 're_x';
  const realFetch = globalThis.fetch; let sent = [];
  globalThis.fetch = async (u, o) => { sent.push(...[JSON.parse(o.body)].flat()); return new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 }); };
  const replies = () => [...new Set(sent.map((m) => [m.reply_to].flat().join()))];
  try {
    await sendAsk(env, await putAskOut(env.DB, (await saveAsk(env.DB, { title: 'Know a plumber?' })).id, { now: NOW }), { now: NOW });
    assert.ok(sent.length > 0, 'it sent');
    assert.deepEqual(replies(), ['info@soardcharity.com'], 'nobody runs it: info@');
    await saveSettings(env.DB, { lead: 'mary-atchley' });
    sent = [];
    await sendAsk(env, await putAskOut(env.DB, (await saveAsk(env.DB, { title: 'Know a painter?' })).id, { now: NOW + 1 }), { now: NOW + 1 });
    await sendWelcome(env, { now: NOW });
    assert.ok(sent.length > 2, 'the ask and the welcome both sent');
    assert.deepEqual(replies(), ['mary@private.example'], 'every reply goes to Mary');
  } finally { globalThis.fetch = realFetch; }
});

test('a mail scanner opening the link answers nothing; a person’s press does, and an old link says so', async () => {
  const ask = await putAskOut(env.DB, (await saveAsk(env.DB, { title: 'Know a plumber?', body: 'Details' })).id, { now: NOW });
  await saveSettings(env.DB, { emails: true }); env.RESEND_API_KEY = 're_x';
  const realFetch = globalThis.fetch; let token = '';
  globalThis.fetch = async (u, o) => { token ||= decodeURIComponent(o.body.match(/advisory-action\?t=([^&"\\]+)/)[1]); return new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 }); };
  await sendAsk(env, ask);
  globalThis.fetch = realFetch;
  const url = `https://x/api/advisory-action?t=${encodeURIComponent(token)}&do=yes`;
  const shown = await actionGet({ env, request: new Request(url) });
  assert.match(await shown.text(), /Know a plumber/);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM advisory_answers').first()).n, 0, 'GET answered nothing');
  const form = new FormData(); form.set('t', token); form.set('do', 'yes'); form.set('note', 'My cousin');
  const done = await actionPost({ env, request: new Request(url, { method: 'POST', body: form }) });
  assert.equal(done.status, 200);
  assert.equal((await env.DB.prepare('SELECT note FROM advisory_answers').first()).note, 'My cousin');
  assert.equal((await actionGet({ env, request: new Request('https://x/api/advisory-action?t=nope&do=yes') })).status, 410);
  assert.equal(await linkFrom(env.DB, token, { now: Date.now() + 40 * 86_400_000 }), null, 'older than 30 days');
  await assert.rejects(answerFromLink(env.DB, 'nope', { answer: 'yes' }), /expired/);
});

test('the ask’s email has the two buttons', () => {
  const m = askEmail({ title: 'T', body: 'B' }, 'Ada', { yes: 'https://y', no: 'https://n' });
  assert.ok(m.html.includes('https://y') && m.html.includes('https://n') && m.text.includes('Hi Ada'));
});

test('the Zeffy form dropdowns: whoever runs the group gets SOARD’s forms through Run it’s own route; committee members and advisors don’t', async () => {
  const { onRequestGet } = await import('../functions/api/advisory-admin.js');
  env.ZEFFY_API_KEY = 'k';
  const real = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ object: 'list', has_more: false, next_cursor: null, data: [
    { id: 'p2p', created: 2, deleted_at: null, type: 'donation_form', category: 'peer_to_peer', status: 'active', title: 'Advisory Board 2026', url: 'https://www.zeffy.com/en-US/peer-to-peer/advisory-board-2026', is_archived: false },
  ] });
  try {
    const get = (data) => onRequestGet({ env, data, request: new Request('https://x/api/advisory-admin?zeffyForms=1') });
    const mary = await get({ boardMember: { slug: 'mary-atchley', name: 'Mary Atchley', email: EMAILS['mary-atchley'], committees: ['Advisory Board'] } });
    assert.equal(mary.status, 200);
    const j = await mary.json();
    assert.deepEqual(j.forms.map((f) => [f.id, f.kind, f.url]), [['p2p', 'peer', 'https://www.zeffy.com/en-US/peer-to-peer/advisory-board-2026']]);
    assert.equal((await get({ boardMember: { slug: 'travis-couick', name: 'Travis Couick', committees: ['Advisory Board'] } })).status, 403);
    assert.equal((await get({ advisor: { slug: 'ada-advisor', name: 'Ada Advisor', email: EMAILS['ada-advisor'] } })).status, 403);
  } finally {
    globalThis.fetch = real;
  }
});
