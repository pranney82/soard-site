/**
 * SOARD's facts and the check that keeps them true: public/admin/org-facts-shared.js (matching names and addresses,
 * the IRS's line, what doesn't match) and functions/api/_org-facts.js (the IRS's list read as it streams, the W-9's
 * two readings, the check on D1 with Slack once and ✅ after, the board page's facts). The IRS line below is SOARD's
 * own, as the IRS publishes it (public). The screens: scripts/test-org-facts.mjs.
 * Run: node --test tests/org-facts.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../public/admin/org-facts-shared.js';
import { readIrsList, checkOrgFacts, maybeCheckOrgFacts, orgFacts, agreed, orgCheckFacts } from '../functions/api/_org-facts.js';
import { createD1 } from './lib/d1-shim.mjs';

const HEADER = 'EIN,NAME,ICO,STREET,CITY,STATE,ZIP,GROUP,SUBSECTION,AFFILIATION,CLASSIFICATION,RULING,DEDUCTIBILITY,FOUNDATION,ACTIVITY,ORGANIZATION,STATUS,TAX_PERIOD,ASSET_CD,INCOME_CD,FILING_REQ_CD,PF_FILING_REQ_CD,ACCT_PD,ASSET_AMT,INCOME_AMT,REVENUE_AMT,NTEE_CD,SORT_NAME';
const SOARD = '454773997,SUNSHINE ON A RANNEY DAY INCORPORATED,% SUNSHINE ON A RANNEY DAY IN,10800 ALPHARETTA HWY SUITE 208 625,ROSWELL,GA,30076-1417,0000,03,3,1000,201207,1,15,000000000,1,01,202512,5,6,01,0,12,947936,2460929,1867189,G19,';
const QUOTED = '580188650,"CHAMBER OF COMMERCE OF GREATER AUGUSTA GEORGIA,INC",,1 10TH ST STE 120,AUGUSTA,GA,30901-0101,0000,06,3,3000,197311,2,00,200000000,1,01,202512,6,6,01,0,12,2197911,2201163,2201163,,';
const OFFICE = { street: '250 Hembree Park Drive, Suite 106', city: 'Roswell', state: 'GA', zip: '30076' };
const SETTINGS = { name: 'Sunshine on a Ranney Day', shortName: 'SOARD', ein: '45-4773997', tagline: 'Dreams Built Here', phone: '(770) 990-2434', email: 'info@soardcharity.com', address: OFFICE };
const MISSION = 'Sunshine on a Ranney Day renovates homes for children with special needs, at no cost to their families.';
const MANUAL_WORDS = 'Name (print): _ Signature: _ Date: _ MISSION & GOALS MISSION STATEMENT Creating spaces that are fully customizable for children with special needs, each renovation is thoughtfully designed to support the child’s physical, emotional and developmental needs. GOALS AND PURPOSE [Examples of different types of goals are listed below]';

// ─── The shared rules ───────────────────────────────────────────────

test('the IRS’s line: quoted cells, every field by its header', () => {
  assert.deepEqual(S.csvCells(QUOTED).slice(0, 3), ['580188650', 'CHAMBER OF COMMERCE OF GREATER AUGUSTA GEORGIA,INC', '']);
  assert.deepEqual(S.csvCells('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
  const r = S.irsRecord(HEADER, SOARD);
  assert.equal(r.ein, '454773997');
  assert.equal(r.name, 'SUNSHINE ON A RANNEY DAY INCORPORATED');
  assert.equal(r.street, '10800 ALPHARETTA HWY SUITE 208 625');
  assert.equal(r.zip, '30076-1417');
  assert.ok(S.exempt(r));
  assert.equal(S.rulingText(r.ruling), 'July 2012');
  assert.equal(S.PUBLIC_CHARITY[Number(r.foundation)], '509(a)(1) and 170(b)(1)(A)(vi)');
  assert.ok(!S.exempt({ ...r, subsection: '04' }));
  assert.match(S.statusWords({ ...r, subsection: '04', deductibility: '2' }), /501\(c\)\(4\) rather than 501\(c\)\(3\), gifts not listed as deductible/);
  assert.equal(S.rulingText('201213'), '');
});

test('names: case, punctuation and Inc. don’t matter; another company does', () => {
  assert.ok(S.sameName('SunShine on a Ranney Day, Inc.', 'SUNSHINE ON A RANNEY DAY INCORPORATED'));
  assert.ok(S.sameName('Sunshine on a Ranney Day', 'SUNSHINE ON A RANNEY DAY INCORPORATED'), 'the name without Inc. is the same company');
  assert.ok(!S.sameName('Sunny & Ranney LLC', 'SUNSHINE ON A RANNEY DAY INCORPORATED'));
  assert.ok(!S.sameName('', 'X'));
  assert.equal(S.titleCase('SUNSHINE ON A RANNEY DAY INCORPORATED'), 'Sunshine on a Ranney Day Incorporated');
  assert.equal(S.titleCase('10800 ALPHARETTA HWY SUITE 208 625'), '10800 Alpharetta Hwy Suite 208 625');
  assert.equal(S.titleCase('1 10TH ST NE'), '1 10th St NE');
});

test('addresses: the Postal Service’s short words, the ZIP’s first five', () => {
  const irs = S.irsAddress(S.irsRecord(HEADER, SOARD));
  assert.ok(S.sameAddress({ street: '10800 Alpharetta Highway, Suite 208-625', city: 'Roswell', state: 'GA', zip: '30076' }, irs));
  assert.ok(S.sameAddress({ street: '10800 Alpharetta Hwy #208 625', city: 'roswell', state: 'GA', zip: '30076-1417' }, irs));
  assert.ok(!S.sameAddress(OFFICE, irs));
  assert.ok(!S.sameAddress({ street: '10800 Alpharetta Hwy Suite 208 625', city: 'Roswell', state: 'GA', zip: '30075' }, irs), 'another ZIP');
  assert.equal(S.addressLine(OFFICE), '250 Hembree Park Drive, Suite 106, Roswell, GA 30076');
  assert.deepEqual(S.mailingOf(SETTINGS), OFFICE, 'no mailing address: the office');
  assert.deepEqual(S.mailingOf({ ...SETTINGS, mailingAddress: irs }), irs);
  assert.deepEqual(S.mailingOf({ ...SETTINGS, mailingAddress: { street: ' ' } }), OFFICE, 'a blank mailing address is none');
});

test('the Board Manual’s mission statement, out of its words', () => {
  assert.equal(S.manualMission(MANUAL_WORDS), 'Creating spaces that are fully customizable for children with special needs, each renovation is thoughtfully designed to support the child’s physical, emotional and developmental needs.');
  assert.equal(S.manualMission('Summary of Organization Mission & Goals Overview'), '', 'the contents page’s mention isn’t the statement');
  assert.equal(S.missionKey('It’s  a mission!'), S.missionKey('its a mission'));
});

test('what doesn’t match: SOARD as it is today, then each fix put in', () => {
  const record = S.irsRecord(HEADER, SOARD);
  const check = { irs: { ein: '454773997', state: 'GA', found: true, record, date: 'October 13, 2026' }, manual: { mission: S.manualMission(MANUAL_WORDS) } };
  const media = { mission: MISSION };
  let p = S.problemsFor({ settings: SETTINGS, media, check });
  assert.deepEqual(p.map((x) => x.key), ['legal-name', 'mailing', 'mission-manual']);
  assert.equal(p[0].title, 'No legal name yet');
  assert.equal(p[0].other, 'Sunshine on a Ranney Day Incorporated');
  assert.equal(p[1].title, 'The IRS has another address for SOARD');
  assert.equal(p[1].site, '250 Hembree Park Drive, Suite 106, Roswell, GA 30076');
  assert.equal(p[1].other, '10800 Alpharetta Hwy Suite 208 625, Roswell, GA 30076-1417');
  assert.equal(p[2].level, 'note');
  // Each fix as Site Config puts it in
  const docs = { settings: structuredClone(SETTINGS), media: structuredClone(media) };
  for (const x of p) for (const [doc, path, value] of x.fix.set) docs[doc][path] = value;
  p = S.problemsFor({ settings: docs.settings, media: docs.media, check });
  assert.deepEqual(p, [], 'all three fixed');
  assert.equal(docs.settings.legalName, 'Sunshine on a Ranney Day Incorporated');
  // A legal name written another way is still the IRS's; another one isn't
  assert.deepEqual(S.problemsFor({ settings: { ...docs.settings, legalName: 'SunShine on a Ranney Day, Inc.' }, media: docs.media, check }), []);
  assert.equal(S.problemsFor({ settings: { ...docs.settings, legalName: 'SOARD Foundation' }, media: docs.media, check })[0].title, 'The legal name isn’t the one the IRS has');
  // A mailing address typed as it's written, not as the IRS shortens it
  assert.deepEqual(S.problemsFor({ settings: { ...docs.settings, mailingAddress: { street: '10800 Alpharetta Highway, Suite 208-625', city: 'Roswell', state: 'GA', zip: '30076' } }, media: docs.media, check }), []);
});

test('the exemption itself: not on the list, or not a deductible 501(c)(3), is urgent and first', () => {
  const record = S.irsRecord(HEADER, SOARD);
  const settings = { ...SETTINGS, legalName: 'Sunshine on a Ranney Day Incorporated', mailingAddress: S.irsAddress(record) };
  let p = S.problemsFor({ settings, check: { irs: { ein: '454773997', state: 'GA', found: false, record: null, date: 'October 13, 2026' } } });
  assert.deepEqual(p.map((x) => [x.key, x.level]), [['irs-missing', 'urgent']]);
  assert.match(p[0].detail, /45-4773997 isn’t on the IRS’s list for GA \(updated October 13, 2026\)/);
  p = S.problemsFor({ settings, check: { irs: { ein: '454773997', found: true, record: { ...record, status: '12' } } } });
  assert.deepEqual(p.map((x) => [x.key, x.level]), [['irs-status', 'urgent']]);
  // The EIN typed since the check: said, not judged against the old one
  p = S.problemsFor({ settings: { ...settings, ein: '12-3456789' }, check: { irs: { ein: '454773997', found: true, record } } });
  assert.deepEqual(p.map((x) => x.key), ['ein-changed']);
  assert.deepEqual(S.problemsFor({ settings, check: null }), []);
});

test('SOARD’s W-9: another EIN, name or address is flagged; what the two readings didn’t agree on isn’t', () => {
  const record = S.irsRecord(HEADER, SOARD);
  const settings = { ...SETTINGS, legalName: 'Sunshine on a Ranney Day Incorporated', mailingAddress: S.irsAddress(record) };
  const check = { irs: { ein: '454773997', found: true, record } };
  const w9 = (read) => ({ ...check, w9: { title: 'W-9', read } });
  const good = { isW9: true, name: 'SunShine on a Ranney Day, Inc.', ein: '454773997', street: '10800 Alpharetta Hwy Ste 208-625', cityStateZip: 'Roswell, GA 30076', zip: '30076' };
  assert.deepEqual(S.problemsFor({ settings, check: w9(good) }), []);
  const p = S.problemsFor({ settings, check: w9({ ...good, ein: '454773991', name: 'Sunny and Ranney LLC', street: '250 Hembree Park Dr Ste 106', zip: '30076' }) });
  assert.deepEqual(p.map((x) => x.key), ['w9-ein', 'w9-name', 'w9-address']);
  assert.match(p[0].detail, /“W-9” on Board → Documents says 45-4773991/);
  // Unsure fields are blank: nothing to flag
  assert.deepEqual(S.problemsFor({ settings, check: w9({ isW9: true, name: '', ein: '', street: '', cityStateZip: '', zip: '' }) }), []);
  assert.deepEqual(S.problemsFor({ settings, check: w9({ isW9: false }) }), [], 'not a W-9 at all: not judged');
  // Two readings → what both said
  const a = { isW9: true, name: 'Sunshine on a Ranney Day Inc', ein: '45-4773997', street: '10800 Alpharetta Hwy', cityStateZip: 'Roswell GA 30076', signedDate: '2026-02-09' };
  assert.deepEqual(agreed(a, { ...a, ein: '45-4773991', street: '10800 ALPHARETTA HWY.' }), { isW9: true, name: a.name, ein: '', street: a.street, cityStateZip: a.cityStateZip, zip: '30076', signedDate: '2026-02-09' });
  assert.equal(agreed(a, null).ein, '454773997', 'one reading that matches the site is taken as it is');
});

// ─── The IRS's list, as it streams ──────────────────────────────────

/** A list like the IRS's: the header, many others, SOARD's line somewhere in the middle, in small pieces */
function listResponse(lines, { chunk = 7, modified = 'Tue, 13 Oct 2026 19:13:29 GMT', status = 200 } = {}) {
  const bytes = new TextEncoder().encode(`${lines.join('\r\n')}\r\n`);
  let i = 0;
  const body = new ReadableStream({ pull(c) { if (i >= bytes.length) { c.close(); return; } c.enqueue(bytes.subarray(i, i + chunk)); i += chunk; } });
  return new Response(body, { status, headers: { 'last-modified': modified } });
}
const OTHERS = Array.from({ length: 400 }, (_, i) => `${String(100000000 + i * 7919).slice(0, 9)},EXAMPLE ORG ${i},,${i} MAIN ST,ATLANTA,GA,30301,0000,03,3,1000,200001,1,15,0,1,01,202412,0,0,01,0,12,0,0,0,,`);

test('the IRS’s list: SOARD’s line found across the pieces it comes in; not on it → null', async () => {
  for (const chunk of [3, 7, 64, 4096]) {
    const { record, modified } = await readIrsList('454773997', 'GA', { fetchImpl: async (url) => { assert.equal(url, 'https://www.irs.gov/pub/irs-soi/eo_ga.csv'); return listResponse([HEADER, ...OTHERS.slice(0, 200), SOARD, ...OTHERS.slice(200)], { chunk }); } });
    assert.equal(record?.name, 'SUNSHINE ON A RANNEY DAY INCORPORATED', `chunks of ${chunk}`);
    assert.equal(record.zip, '30076-1417', 'no \\r left on the last cell');
    assert.equal(modified, 'Tue, 13 Oct 2026 19:13:29 GMT');
  }
  // The very last line, with no newline after it
  const last = await readIrsList('454773997', 'GA', { fetchImpl: async () => new Response(`${HEADER}\n${OTHERS[0]}\n${SOARD}`) });
  assert.equal(last.record?.ein, '454773997');
  assert.equal((await readIrsList('454773997', 'GA', { fetchImpl: async () => listResponse([HEADER, ...OTHERS]) })).record, null);
  // An EIN that's the start of another one's isn't it
  assert.equal((await readIrsList('45477399', 'GA', { fetchImpl: async () => listResponse([HEADER, SOARD]) })).record, null);
  await assert.rejects(readIrsList('454773997', 'GA', { fetchImpl: async () => new Response('busy', { status: 503 }) }), /answered 503/);
});

test('the IRS’s list: a page that isn’t its CSV, or a read cut short, is never “not on the list”', async () => {
  // irs.gov turning the site away with a 200 page
  await assert.rejects(readIrsList('454773997', 'GA', { fetchImpl: async () => new Response('<html><body>Access Denied</body></html>') }), /didn’t come as its CSV/);
  await assert.rejects(readIrsList('454773997', 'GA', { fetchImpl: async () => new Response('') }), /didn’t come as its CSV/);
  // Cut short: fewer bytes than the IRS said it sent, SOARD's line not reached
  const part = `${HEADER}\n${OTHERS.slice(0, 10).join('\n')}\n`;
  await assert.rejects(readIrsList('454773997', 'GA', { fetchImpl: async () => new Response(part, { headers: { 'content-length': String(part.length + 5000) } }) }), /stopped short/);
  // Sorted by EIN: a bigger one passed proves it isn't there, without reading the rest
  let pulled = 0;
  const big = [HEADER, '100000001,A,,1 ST,X,GA,30301,0000,03,3,1000,200001,1,15,0,1,01,202412,0,0,01,0,12,0,0,0,,', '500000000,Z,,1 ST,X,GA,30301,0000,03,3,1000,200001,1,15,0,1,01,202412,0,0,01,0,12,0,0,0,,', ...Array.from({ length: 2000 }, (_, i) => `${600000000 + i},MORE,,1 ST,X,GA,30301,0000,03,3,1000,200001,1,15,0,1,01,202412,0,0,01,0,12,0,0,0,,`)];
  const bytes = new TextEncoder().encode(`${big.join('\n')}\n`);
  const body = new ReadableStream({ pull(c) { if (pulled * 256 >= bytes.length) { c.close(); return; } c.enqueue(bytes.subarray(pulled * 256, ++pulled * 256)); } });
  assert.equal((await readIrsList('454773997', 'GA', { fetchImpl: async () => new Response(body) })).record, null);
  assert.ok(pulled * 256 < bytes.length / 4, `stopped once past it (${pulled * 256} of ${bytes.length} bytes)`);
});

// ─── The check, on D1 ───────────────────────────────────────────────

class FakeR2 {
  constructor() { this.map = new Map(); }
  async get(key) { const b = this.map.get(key); return b ? { body: b, size: b.length } : null; }
}
// A JPEG's first bytes are enough to be read as a picture (the model is faked)
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const realFetch = globalThis.fetch;
let env; let slack; let irs; let w9Reads; let slackDown = false;

async function seed() {
  const DB = await createD1({ schemaSql: [
    'CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)',
    'CREATE TABLE board_docs (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
    'CREATE TABLE board_files (id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, r2_key TEXT, name TEXT, type TEXT, size INTEGER, kind TEXT, staff_only INTEGER, at TEXT, by TEXT, words TEXT)',
  ] });
  const put = (k, v) => DB.prepare('INSERT OR REPLACE INTO site_config (key, data) VALUES (?, ?)').bind(k, JSON.stringify(v)).run();
  await put('settings', SETTINGS);
  await put('media', { mission: MISSION, bio: { founded: '2012', founders: 'Peter and Holly Ranney', website: 'sunshineonaranneyday.com', boilerplate: 'A short bio.' } });
  await put('slack', { channel: { id: 'C0ALERTS1', name: 'team-everyone', private: false } });
  for (const [id, title] of [['d_w9', 'W-9'], ['d_manual', 'SunShine on a Ranney Day, Inc. Board Manual with Policies']]) await DB.prepare('INSERT INTO board_docs (id, data) VALUES (?, ?)').bind(id, JSON.stringify({ id, title, kind: 'governance' })).run();
  await DB.prepare("INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, at, words) VALUES ('f_w9', 'doc', 'd_w9', 'board/w9.jpg', 'W9.jpg', 'image/jpeg', 22, '2026-02-10T00:00:00Z', '')").run();
  await DB.prepare("INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, at, words) VALUES ('f_man', 'doc', 'd_manual', 'board/manual.pdf', 'Manual.pdf', 'application/pdf', 9, '2026-07-01T00:00:00Z', ?)").bind(MANUAL_WORDS).run();
  const FILES = new FakeR2();
  FILES.map.set('board/w9.jpg', JPEG);
  return { DB, FILES };
}

beforeEach(async () => {
  slack = [];
  irs = { gets: 0, heads: 0, modified: 'Tue, 13 Oct 2026 19:13:29 GMT', down: false };
  w9Reads = [];
  env = { ...(await seed()), SLACK_BOT_TOKEN: 'xoxb-test' };
  // Workers AI reading the W-9's picture: the first reading, and the second when asked again
  env.AI = { run: async (model, input) => {
    const again = /one box at a time/.test(input.messages[0].content);
    w9Reads.push(again ? 'again' : 'first');
    return { response: { isW9: true, name: 'SunShine on a Ranney Day, Inc.', businessName: '', ein: '45-4773997', street: again ? '10800 Alpharetta Hwy Suite 208-625' : '10800 Alpharetta Hwy Suite 208 625', cityStateZip: 'Roswell, GA 30076', signedDate: '2026-02-09' } };
  } };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    if (url.startsWith('https://slack.com/api/')) {
      const method = url.slice('https://slack.com/api/'.length);
      let parsed = body;
      try { parsed = JSON.parse(init.body); } catch { /* form */ }
      if (slackDown) { slack.push({ method, body: parsed, ok: false }); return Response.json({ ok: false, error: 'channel_not_found' }); }
      slack.push({ method, body: parsed });
      return Response.json({ ok: true, channel: parsed.channel || 'C0ALERTS1', ts: `${slack.length}.0001` });
    }
    throw new Error(`no fake for ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const irsFetch = async (url, init = {}) => {
  if (irs.down) return new Response('busy', { status: 503 });
  if (init.method === 'HEAD') { irs.heads++; return new Response(null, { headers: { 'last-modified': irs.modified } }); }
  irs.gets++;
  return listResponse([HEADER, ...OTHERS.slice(0, 50), SOARD, ...OTHERS.slice(50)], { chunk: 1024, modified: irs.modified });
};
const posts = () => slack.filter((s) => s.method === 'chat.postMessage' && s.ok !== false);
const textOf = (p) => JSON.stringify(p.body.blocks || p.body.text);

test('the check: the IRS’s list, the W-9 and the Board Manual read; one Slack post; nothing read again too soon', async () => {
  const now = Date.parse('2026-11-03T15:00:00Z');
  const c = await checkOrgFacts(env, { now, fetchImpl: irsFetch });
  assert.equal(c.irs.found, true);
  assert.equal(c.irs.date, 'October 13, 2026');
  assert.equal(c.w9.read.ein, '454773997');
  assert.equal(c.w9.read.street, '10800 Alpharetta Hwy Suite 208 625', 'the two readings agreed (the dash aside)');
  assert.deepEqual(w9Reads, ['first', 'again'], 'read again: its address isn’t the office');
  assert.equal(c.manual.mission.slice(0, 20), 'Creating spaces that');
  assert.deepEqual(c.problems.map((p) => p.key), ['legal-name', 'mailing', 'w9-address', 'mission-manual']);
  assert.equal(c.level, 'warn');
  assert.equal(posts().length, 1, 'one post');
  assert.match(textOf(posts()[0]), /SOARD’s facts don’t match the IRS or its papers/);
  assert.match(textOf(posts()[0]), /No legal name yet/);

  // Within six hours: nothing at all; after: the list's date looked at (HEAD), not read again; the W-9 not read again
  assert.equal(await maybeCheckOrgFacts(env, { now: now + 3600e3, fetchImpl: irsFetch }), null);
  await maybeCheckOrgFacts(env, { now: now + 7 * 3600e3, fetchImpl: irsFetch });
  assert.deepEqual([irs.gets, irs.heads], [1, 1]);
  assert.equal(w9Reads.length, 2);
  assert.equal(posts().length, 1, 'the same problems aren’t posted again');

  // A new list from the IRS is read
  irs.modified = 'Tue, 10 Nov 2026 19:00:00 GMT';
  await maybeCheckOrgFacts(env, { now: now + 14 * 3600e3, fetchImpl: irsFetch });
  assert.equal(irs.gets, 2);

  // Staff put in the IRS's legal name and address and the Board Manual's mission: ✅
  const st = { ...SETTINGS, legalName: 'Sunshine on a Ranney Day Incorporated', mailingAddress: { street: '10800 Alpharetta Hwy Suite 208 625', city: 'Roswell', state: 'GA', zip: '30076-1417' } };
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify(st)).run();
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'media'").bind(JSON.stringify({ mission: c.manual.mission })).run();
  const after = await checkOrgFacts(env, { now: now + 20 * 3600e3, fetchImpl: irsFetch });
  assert.deepEqual(after.problems, []);
  assert.equal(after.level, 'ok');
  assert.ok(slack.some((s) => s.method === 'chat.update' && /Resolved/.test(JSON.stringify(s.body))), 'the post turned ✅');
  assert.equal(posts().length, 2, 'and one reply saying they match');
  assert.match(textOf(posts()[1]), /match the IRS and its papers/);
});

test('the heartbeat: one slow step a tick (the list, then the W-9), one run at a time, nothing posted till the end', async () => {
  const now = Date.parse('2026-11-03T15:00:00Z');
  // Two ticks at once: one runs
  await Promise.all([maybeCheckOrgFacts(env, { now, fetchImpl: irsFetch }), maybeCheckOrgFacts(env, { now, fetchImpl: irsFetch })]);
  assert.equal(irs.gets, 1, 'the list read once');
  assert.deepEqual(w9Reads, [], 'the W-9 waits for the next tick');
  let c = (await env.DB.prepare("SELECT data FROM site_config WHERE key = 'org-check'").first()).data;
  c = JSON.parse(c);
  assert.equal(c.pending, true);
  assert.equal(c.irs.found, true, 'the list’s reading kept already');
  assert.equal(posts().length, 0, 'nothing posted halfway');
  // A held check (another run within its 3 minutes) is left alone
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'org-check'").bind(JSON.stringify({ ...c, runningUntil: new Date(now + 60e3 + 120e3).toISOString() })).run();
  assert.equal(await maybeCheckOrgFacts(env, { now: now + 60e3, fetchImpl: irsFetch }), null);
  // The next free tick: the W-9, then the end
  const done = await maybeCheckOrgFacts(env, { now: now + 4 * 60e3, fetchImpl: irsFetch });
  assert.equal(done.pending, false);
  assert.ok(w9Reads.length >= 1);
  assert.equal(posts().length, 1, 'posted once, at the end');
  assert.equal(done.runningUntil, undefined, 'and let go');
});

test('Slack: a post that didn’t go is tried again; no ✅ while the list didn’t answer', async () => {
  const now = Date.parse('2026-11-03T15:00:00Z');
  slackDown = true;
  await checkOrgFacts(env, { now, fetchImpl: irsFetch });
  assert.ok(!JSON.parse((await env.DB.prepare("SELECT data FROM site_config WHERE key = 'org-check'").first()).data).slackSig, 'not kept as posted');
  slackDown = false;
  await checkOrgFacts(env, { now: now + 7 * 3600e3, fetchImpl: irsFetch });
  assert.equal(posts().filter((p) => p.ok !== false).length >= 1, true);
  const posted = JSON.parse((await env.DB.prepare("SELECT data FROM site_config WHERE key = 'org-check'").first()).data).slackSig;
  assert.ok(posted, 'posted the second time');
  // Everything fixed, but the list didn't answer this time: no ✅ yet
  const st = { ...SETTINGS, legalName: 'Sunshine on a Ranney Day Incorporated', mailingAddress: { street: '10800 Alpharetta Hwy Suite 208 625', city: 'Roswell', state: 'GA', zip: '30076-1417' } };
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify(st)).run();
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'media'").bind(JSON.stringify({ mission: S.manualMission(MANUAL_WORDS) })).run();
  irs.down = true;
  await checkOrgFacts(env, { now: now + 50 * 86400e3, fetchImpl: irsFetch });
  assert.ok(!slack.some((x) => x.method === 'chat.update'), 'no ✅ while the list didn’t answer');
  irs.down = false;
  await checkOrgFacts(env, { now: now + 50 * 86400e3 + 7 * 3600e3, fetchImpl: irsFetch });
  assert.ok(slack.some((x) => x.method === 'chat.update'), '✅ once it did');
});

test('the light refresh after a save: nothing read, compared with what’s saved', async () => {
  const now = Date.parse('2026-11-03T15:00:00Z');
  await checkOrgFacts(env, { now, fetchImpl: irsFetch, slack: false });
  const gets = irs.gets; const reads = w9Reads.length;
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify({ ...SETTINGS, legalName: 'Sunshine on a Ranney Day Incorporated' })).run();
  const r = await checkOrgFacts(env, { now: now + 60e3, fetchImpl: irsFetch, steps: 0, slack: false });
  assert.equal(irs.gets, gets); assert.equal(w9Reads.length, reads);
  assert.ok(!r.problems.some((p) => p.key === 'legal-name'), 'the saved legal name counts at once');
});

test('the IRS’s list: SOARD not on it once isn’t said; twice is', async () => {
  const now = Date.parse('2026-11-03T15:00:00Z');
  await checkOrgFacts(env, { now, fetchImpl: irsFetch, slack: false });
  const gone = async (url, init = {}) => (init.method === 'HEAD' ? new Response(null, { headers: { 'last-modified': 'Tue, 10 Nov 2026 19:00:00 GMT' } }) : listResponse([HEADER, ...OTHERS], { modified: 'Tue, 10 Nov 2026 19:00:00 GMT' }));
  let c = await checkOrgFacts(env, { now: now + 7 * 3600e3, fetchImpl: gone, slack: false });
  assert.ok(!c.problems.some((p) => p.key === 'irs-missing'), 'once: read again before anything is said');
  assert.equal(c.irs.record.ein, '454773997', 'the last reading stays meanwhile');
  c = await checkOrgFacts(env, { now: now + 14 * 3600e3, fetchImpl: gone, slack: false });
  assert.deepEqual(c.problems.map((p) => [p.key, p.level])[0], ['irs-missing', 'urgent'], 'twice: urgent');
});

test('SOARD’s W-9: a line 1 that isn’t SOARD’s is read a second way before it counts', async () => {
  let n = 0;
  env.AI = { run: async () => { n++; return { response: { isW9: true, name: n === 1 ? 'Sunshine on a Rainy Day, Inc.' : 'Sunshine on a Ranney Day, Inc.', businessName: '', ein: '45-4773997', street: '250 Hembree Park Drive, Suite 106', cityStateZip: 'Roswell, GA 30076', signedDate: '' } }; } };
  const c = await checkOrgFacts(env, { now: Date.now(), fetchImpl: irsFetch, slack: false });
  assert.equal(n, 2, 'read again');
  assert.equal(c.w9.read.name, '', 'the two readings disagreed: unsure, not flagged');
  assert.ok(!c.problems.some((p) => p.key === 'w9-name'));
});

test('the IRS’s list not answering: the last good reading stays, the trouble is kept for Automations', async () => {
  const now = Date.parse('2026-11-03T15:00:00Z');
  await checkOrgFacts(env, { now, fetchImpl: irsFetch });
  irs.down = true;
  const c = await checkOrgFacts(env, { now: now + 40 * 86400e3, fetchImpl: irsFetch });
  assert.equal(c.irs.record.ein, '454773997', 'kept');
  assert.match(c.irs.error, /answered 503/);
  const f = await orgCheckFacts(env.DB);
  assert.match(f.irsError, /503/);
  // Back: read at once (an error is always tried again)
  irs.down = false;
  const back = await checkOrgFacts(env, { now: now + 40 * 86400e3 + 7 * 3600e3, fetchImpl: irsFetch });
  assert.equal(back.irs.error, undefined);
});

test('the board page’s facts: the site’s, as saved, and the IRS’s words only for SOARD’s own EIN', async () => {
  let f = await orgFacts(env);
  assert.equal(f.ein, '45-4773997');
  assert.equal(f.mission, MISSION);
  assert.equal(f.mailing, null, 'no mailing address yet');
  assert.equal(f.irs, null, 'not checked yet');
  assert.equal(f.brand.logos.length, 6);
  assert.equal(f.brand.logos[0].png, '/api/download-logo?id=brand-logo-light-bg-tagline-download');
  assert.equal(f.brand.logos[0].svg, undefined, 'no SVG: the kit’s .svg files hold PNG pictures, not drawings');
  assert.equal(f.brand.colors[0].hex, '#FFDA24');
  assert.equal(f.bio, 'A short bio.');
  await checkOrgFacts(env, { now: Date.now(), fetchImpl: irsFetch, slack: false });
  f = await orgFacts(env);
  assert.deepEqual(f.irs, { exempt: true, since: 'July 2012', publicCharity: '509(a)(1) and 170(b)(1)(A)(vi)', listed: 'October 13, 2026' });
  // A saved change shows at once; another EIN drops the IRS's words until it's checked
  await env.DB.prepare("UPDATE site_config SET data = ? WHERE key = 'settings'").bind(JSON.stringify({ ...SETTINGS, ein: '12-3456789', vision: 'Every child home.', values: [{ name: 'Joy', text: 'We build it in.' }, { name: '' }] })).run();
  f = await orgFacts(env);
  assert.equal(f.irs, null);
  assert.equal(f.vision, 'Every child home.');
  assert.deepEqual(f.values, [{ name: 'Joy', text: 'We build it in.' }]);
});

test('a paper called W-9 keeps its dash on the board page and in the viewer (public/admin/board-shared.js fileTitle)', async () => {
  const { fileTitle, docTitle } = await import('../public/admin/board-shared.js');
  assert.equal(docTitle('W-9'), 'W-9');
  assert.equal(fileTitle('2026_w-9_soard.pdf'), '2026 w-9 soard');
  assert.equal(fileTitle('soard_1099-NEC_2025.pdf'), 'Soard 1099-NEC 2025');
  assert.equal(fileTitle('Form 8822-B.pdf'), 'Form 8822-B');
  // Every other dash is still a space
  assert.equal(fileTitle('budget-final-v2.pdf'), 'Budget final v2');
  assert.equal(fileTitle('q4-2025-statements.xlsx'), 'Q4 2025 statements');
  assert.equal(fileTitle('a-team-roster.pdf'), 'A team roster');
});
