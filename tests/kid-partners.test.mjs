/**
 * Partner logos on kid pages follow JobTread (functions/api/_kid-partners.js):
 * Vendors and Sponsors on a job get their company's logo on the kid's page
 * (or the community project's), saved like an admin save and published; a
 * company with no logo anywhere is emailed to staff once, with its name, the
 * person's name and email, and their role. Plus the admin's Waiting for a logo.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  jobCompanies, findLogo, logoIndex, pageHas, missingLogoEmail, syncKidPartners, maybeSyncKidPartners, recheckWaiting,
  adminView, setAside, saveSettings, readSettings, DEFAULT_EMAILS, SYNC_USER,
} from '../functions/api/_kid-partners.js';
import { onRequestGet, onRequestPost } from '../functions/api/kid-partners-admin.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;
const member = (role, { account = null, name = 'Pat Doe', email = 'pat@example.com', internal = false } = {}) => ({
  membership: { isInternal: internal, role: { name: role }, account: account ? { id: `a-${account}`, name: account } : null, user: { name, emailAddress: email } },
});
const job = (id, name, aces, { closedOn = null } = {}) => ({ id, name, closedOn, aces: { nodes: aces } });

async function world({ kids = [], projects = [], partners = [] } = {}) {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const k of kids) await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(k.slug, k.name, k.year, k.status || 'in-progress', JSON.stringify(k)).run();
  for (const p of projects) await DB.prepare('INSERT INTO community (slug, name, data) VALUES (?, ?, ?)').bind(p.slug, p.name, JSON.stringify(p)).run();
  for (const p of partners) await addPartner(DB, p);
  return DB;
}
const addPartner = (DB, p) => DB.prepare('INSERT OR REPLACE INTO partners (slug, name, level, category, featured, data) VALUES (?, ?, ?, ?, ?, ?)')
  .bind(p.slug, p.name, p.level || 'friend', 'build', 0, JSON.stringify(p)).run();
const kidOf = async (DB, slug, table = 'kids') => JSON.parse((await DB.prepare(`SELECT data FROM ${table} WHERE slug = ?`).bind(slug).first()).data);
const saveKid = (DB, k) => DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(k), k.slug).run();
const rows = async (DB) => (await DB.prepare('SELECT record, company, state, emailed_at FROM kid_partner_logos ORDER BY record, company').all()).results;
/** JobTread: the open jobs page (names only), then who has access, three jobs a request */
const jtFetch = (jobs, seen = []) => async (url, init) => {
  const q = JSON.parse(init.body).query;
  seen.push(q);
  const list = typeof jobs === 'function' ? jobs() : jobs;
  if (q.organization) return Response.json({ organization: { jobs: { nextPage: null, nodes: list.map(({ id, name, closedOn }) => ({ id, name, closedOn })) } } });
  const out = {};
  for (const [alias, part] of Object.entries(q)) if (part?._ === 'job') { const j = list.find((x) => x.id === part.$.id); out[alias] = j ? { id: j.id, aces: j.aces } : null; }
  return Response.json(out);
};
/** Resend and the deploy hook, through global fetch */
function outside(t) {
  const sent = { emails: [], hooks: [] };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const u = new URL(String(url));
    if (u.host === 'api.resend.com') { const batch = JSON.parse(init.body); sent.emails.push(...batch); return Response.json({ data: batch.map((_, i) => ({ id: `em${sent.emails.length}-${i}` })) }); }
    sent.hooks.push(String(url));
    return new Response('ok');
  });
  return sent;
}
const PARTNERS = [
  { slug: 'randall-brothers', name: 'Randall Brothers', logo: img('partners/randall-brothers/1'), website: 'https://randallbrothers.com' },
  { slug: 'bell', name: 'Bell Cabinetry', logo: img('partners/bell/1774386082723'), website: 'https://bellcabinetry.com' },
  { slug: 'therapy-gyms', name: 'Therapy Gyms', logo: img('partners/therapy-gyms/1'), website: 'https://www.therapygyms.com' },
  { slug: 'sherwin', name: 'Sherwin-Williams Store', logo: '', website: '' },
];

test('a job’s Vendors and Sponsors, by company: staff, families and other roles left out', () => {
  const list = jobCompanies(job('j', 'Isla Smith (2026)', [
    member('Vendor', { account: 'Randall Brothers', name: 'Ron Randall', email: 'Ron@RandallBrothers.com' }),
    member('Vendor', { account: 'Randall Brothers', name: 'Rita Randall', email: 'rita@randallbrothers.com' }),
    member('Sponsor', { account: null, name: 'Smith Family Foundation', email: 'give@smithff.org' }),
    member('Makeover Family', { account: 'Smith', name: 'Jo Smith', email: 'jo@example.com' }),
    member('Photographer', { account: 'Snap Co', email: 'snap@example.com' }),
    member('Vendor', { account: 'Staff Co', internal: true }),
  ]));
  assert.deepEqual(list.map((c) => c.name), ['Randall Brothers', 'Smith Family Foundation'], 'the account names the company; without one, the person');
  assert.deepEqual(list[0].people, [{ name: 'Ron Randall', email: 'ron@randallbrothers.com', role: 'Vendor' }, { name: 'Rita Randall', email: 'rita@randallbrothers.com', role: 'Vendor' }]);
  assert.equal(list[1].people[0].role, 'Sponsor');
});

test('finding a company’s logo: Partners by name, by website, then another page; otherwise a hint', () => {
  const records = [{ kind: undefined, slug: 'old', name: 'Old', data: { partnerLogos: [{ url: img('kids/old/partner-cr'), name: 'CR Construction' }] } }];
  const index = logoIndex(PARTNERS, records);
  const c = (name, email = 'x@example.com') => ({ company: name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|inc|llc|co|corp|company|group|and)\b/g, ' ').replace(/\s+/g, ''), name, people: [{ name: 'A', email, role: 'Vendor' }] });
  assert.equal(findLogo(c('Randall Brothers, Inc.'), index).logo.partner, 'randall-brothers', 'same name (Inc. aside)');
  assert.equal(findLogo(c('RB Supply', 'ron@randallbrothers.com'), index).logo.how, 'website', 'the email’s domain is a partner’s website');
  assert.equal(findLogo(c('Ron', 'ron@gmail.com'), index).logo, null, 'a Gmail address is nobody’s website');
  const cr = findLogo(c('CR Construction'), index).logo;
  assert.deepEqual([cr.how, cr.url, cr.partner], ['page', img('kids/old/partner-cr'), null], 'a logo already on another page under that name');
  assert.match(findLogo(c('Sherwin-Williams Store'), index).hint, /in Partners without a logo/);
  assert.match(findLogo(c('Therapy Gym'), index).hint, /Partners has Therapy Gyms: the same company\?/, 'a near miss is named, never used');
  assert.equal(findLogo(c('Brand New Co'), index).hint, null);
});

test('a page already showing the logo: same image, a file uploaded for that partner, or one under the name', () => {
  const bell = { url: PARTNERS[1].logo, partner: 'bell' };
  const co = { company: 'bellcabinetry', name: 'Bell Cabinetry', people: [] };
  assert.ok(pageHas({ partnerLogos: [{ url: PARTNERS[1].logo }] }, co, bell, PARTNERS));
  assert.ok(pageHas({ partnerLogos: [{ url: img('partners/bell/1690000000000') }] }, co, bell, PARTNERS), 'an older file from the same partner folder');
  assert.ok(pageHas({ partnerLogos: [{ url: img('kids/x/partner-1-bell.png'), name: 'Bell Cabinetry' }] }, co, null, PARTNERS), 'uploaded on the page with the name');
  assert.ok(!pageHas({ partnerLogos: [{ url: PARTNERS[0].logo, name: 'Randall Brothers' }] }, co, bell, PARTNERS));
});

test('a sweep puts logos on the page, saved like an admin save and published; no logo, staff hear once', async (t) => {
  const sent = outside(t);
  const DB = await world({
    kids: [
      { slug: 'isla', name: 'Isla', year: 2026, publishStatus: 'published', partnerLogos: [{ url: img('partners/bell/1690000000000'), name: 'Bell' }] },
      { slug: 'max', name: 'Max', year: 2026, publishStatus: 'draft', partnerLogos: [] },
    ],
    partners: PARTNERS,
  });
  let jobs = [
    job('j1', 'Isla Smith (2026)', [
      member('Vendor', { account: 'Randall Brothers', name: 'Ron Randall', email: 'ron@randallbrothers.com' }),
      member('Vendor', { account: 'Bell Cabinetry', email: 'b@bellcabinetry.com' }),
      member('Sponsor', { account: 'Brand New Co', name: 'Nia Nguyen', email: 'nia@brandnew.example' }),
      member('Makeover Family', { account: 'Smith', email: 'jo@example.com' }),
    ]),
    job('j2', 'Max Moore (2026)', [member('Vendor', { account: 'Therapy Gyms', email: 'hi@therapygyms.com' })]),
    job('t1', 'TEST Isla Smith (2026)', [member('Vendor', { account: 'Test Vendor' })]),
  ];
  const env = { DB, JOBTREAD_GRANT_KEY: 'k', RESEND_API_KEY: 'r', CF_PAGES_DEPLOY_HOOK: 'https://hook.example/deploy' };
  const now = Date.parse('2026-10-28T15:00:00Z');
  const out = await syncKidPartners(env, { fetchImpl: jtFetch(() => jobs), now });
  assert.deepEqual(out, [
    { record: 'isla', name: 'Isla', added: ['Randall Brothers'], waiting: ['Brand New Co'] },
    { record: 'max', name: 'Max', added: ['Therapy Gyms'], waiting: [] },
  ]);
  const isla = await kidOf(DB, 'isla');
  assert.deepEqual(isla.partnerLogos, [{ url: img('partners/bell/1690000000000'), name: 'Bell' }, { url: PARTNERS[0].logo, name: 'Randall Brothers' }], 'added at the end; Bell was already there');
  assert.equal((await kidOf(DB, 'max')).partnerLogos[0].name, 'Therapy Gyms', 'a hidden draft gets it too, ready for when it shows');
  assert.deepEqual(await rows(DB), [
    { record: 'isla', company: 'bellcabinetry', state: 'there', emailed_at: null },
    { record: 'isla', company: 'brandnew', state: 'waiting', emailed_at: '2026-10-28T15:00:00.000Z' },
    { record: 'isla', company: 'randallbrothers', state: 'added', emailed_at: null },
    { record: 'max', company: 'therapygyms', state: 'added', emailed_at: null },
  ]);
  const audit = (await DB.prepare("SELECT user_email, entity_slug FROM audit_log WHERE entity_type = 'kids' ORDER BY id").all()).results;
  assert.deepEqual(audit.map((a) => [a.user_email, a.entity_slug]), [[SYNC_USER, 'isla'], [SYNC_USER, 'max']]);
  const versions = (await DB.prepare("SELECT slug FROM content_versions WHERE collection = 'kids' AND user_email = ?").bind(SYNC_USER).all()).results;
  assert.equal(versions.length, 2, 'History keeps each change');
  assert.deepEqual(sent.hooks, ['https://hook.example/deploy'], 'one publish for the lot');

  // The email: to Linzi, with the company, the person's name and email, the role and the page
  assert.equal(sent.emails.length, 1);
  const mail = sent.emails[0];
  assert.deepEqual(mail.to, DEFAULT_EMAILS);
  assert.equal(mail.subject, '[SOARD] Logo needed: Brand New Co on Isla’s page');
  for (const bit of ['Brand New Co', 'Nia Nguyen', 'nia@brandnew.example', 'Sponsor', 'Isla (2026)', '/admin/#kids/isla', 'app.jobtread.com/jobs/j1', '/admin/#partners?waiting']) assert.ok(mail.text.includes(bit), `the email says ${bit}`);
  assert.ok(mail.html.includes('mailto:nia@brandnew.example'));
  assert.ok(!/—/.test(mail.text + mail.subject), 'no em dashes');
  assert.deepEqual(mail.tags, [{ name: 'category', value: 'partner-logo' }]);

  // The next sweep: nothing new, no second email, no publish
  assert.deepEqual(await syncKidPartners(env, { fetchImpl: jtFetch(() => jobs), now: now + 11 * 60e3 }), [{ record: 'isla', name: 'Isla', added: [], waiting: ['Brand New Co'] }]);
  assert.equal(sent.emails.length, 1, 'staff hear once');
  assert.equal(sent.hooks.length, 1);

  // Staff take Randall Brothers off Isla's page: it stays off
  await saveKid(DB, { ...isla, partnerLogos: isla.partnerLogos.slice(0, 1) });
  await syncKidPartners(env, { fetchImpl: jtFetch(() => jobs), now: now + 22 * 60e3 });
  assert.equal((await kidOf(DB, 'isla')).partnerLogos.length, 1, 'a logo staff took off is never put back');

  // Brand New Co's logo goes into Partners: the save re-checks what's waiting and it goes on
  await addPartner(DB, { slug: 'brand-new-co', name: 'Brand New Co', logo: img('partners/brand-new-co/1') });
  const back = await recheckWaiting(env, { now: now + 40 * 60e3 });
  assert.deepEqual(back, [{ record: 'isla', name: 'Isla', added: ['Brand New Co'], waiting: [] }]);
  assert.equal((await kidOf(DB, 'isla')).partnerLogos.at(-1).url, img('partners/brand-new-co/1'));
  assert.equal(sent.hooks.length, 2, 'published (the cooldown had passed)');
  assert.equal((await adminView(DB)).waiting.length, 0);
});

test('waiting: “No logo needed” sets it aside, undo brings it back without a second email, and leaving the job clears it', async (t) => {
  const sent = outside(t);
  const DB = await world({ kids: [{ slug: 'ava', name: 'Ava', year: 2026, publishStatus: 'published', partnerLogos: [] }] });
  let aces = [member('Sponsor', { account: 'Kind Neighbors', name: 'Kim', email: 'kim@kind.example' }), member('Vendor', { account: 'Paint Pros', email: 'p@paintpros.example' })];
  const env = { DB, JOBTREAD_GRANT_KEY: 'k', RESEND_API_KEY: 'r' };
  const jobs = () => [job('j', 'Ava Lee (2026)', aces)];
  const now = Date.parse('2026-10-28T15:00:00Z');
  await syncKidPartners(env, { fetchImpl: jtFetch(jobs), now });
  assert.equal(sent.emails.length, 1);
  assert.equal(sent.emails[0].subject, '[SOARD] 2 logos needed for kid pages', 'one email for the lot');
  assert.ok(sent.emails[0].text.includes('Kind Neighbors') && sent.emails[0].text.includes('Paint Pros'));

  assert.equal(await setAside(DB, { record: 'ava', company: 'kindneighbors', dismiss: true }, 'linzi@example.org'), 'dismissed');
  let view = await adminView(DB);
  assert.deepEqual([view.waiting.map((r) => r.name), view.dismissed.map((r) => [r.name, r.by])], [['Paint Pros'], [['Kind Neighbors', 'linzi@example.org']]]);
  await syncKidPartners(env, { fetchImpl: jtFetch(jobs), now: now + 11 * 60e3 });
  assert.equal((await adminView(DB)).dismissed.length, 1, 'the sweep leaves it set aside');
  assert.equal(await setAside(DB, { record: 'ava', company: 'kindneighbors', dismiss: false }), 'waiting');
  await syncKidPartners(env, { fetchImpl: jtFetch(jobs), now: now + 22 * 60e3 });
  assert.equal(sent.emails.length, 1, 'back to waiting, no second email');

  aces = aces.slice(0, 1);
  await syncKidPartners(env, { fetchImpl: jtFetch(jobs), now: now + 33 * 60e3 });
  view = await adminView(DB);
  assert.deepEqual(view.waiting.map((r) => r.name), ['Kind Neighbors'], 'Paint Pros left the job: nothing to wait for');
  assert.deepEqual(view.waiting[0].page, { slug: 'ava', name: 'Ava', year: 2026, kind: 'kid', draft: false });
  assert.deepEqual(view.waiting[0].people, [{ name: 'Kim', email: 'kim@kind.example', role: 'Sponsor' }]);
});

test('a community project’s page gets its vendors’ logos too', async (t) => {
  outside(t);
  const DB = await world({ projects: [{ slug: 'drake-house', name: 'The Drake House', status: 'in-progress', jobtreadJobId: 'jc', partnerLogos: [] }], partners: PARTNERS });
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  const out = await syncKidPartners(env, { fetchImpl: jtFetch([job('jc', 'Drake House Playroom (2026)', [member('Vendor', { account: 'Randall Brothers' })])]) });
  assert.deepEqual(out, [{ record: 'community/drake-house', name: 'The Drake House', added: ['Randall Brothers'], waiting: [] }]);
  assert.equal((await kidOf(DB, 'drake-house', 'community')).partnerLogos[0].url, PARTNERS[0].logo);
});

test('who hears: the admin’s list, checked; an empty list emails nobody', async (t) => {
  const sent = outside(t);
  const DB = await world({ kids: [{ slug: 'ava', name: 'Ava', year: 2026, partnerLogos: [] }] });
  assert.deepEqual((await readSettings(DB)).emails, DEFAULT_EMAILS, 'Linzi to start with');
  await assert.rejects(saveSettings(DB, { emails: ['nope'] }), /doesn’t look like an email/);
  await saveSettings(DB, { emails: ['Ops@Example.org', 'ops@example.org', 'pm@example.org'] }, 'peter@example.org');
  assert.deepEqual((await readSettings(DB)).emails, ['ops@example.org', 'pm@example.org']);
  const env = { DB, JOBTREAD_GRANT_KEY: 'k', RESEND_API_KEY: 'r' };
  await syncKidPartners(env, { fetchImpl: jtFetch([job('j', 'Ava Lee (2026)', [member('Vendor', { account: 'Paint Pros' })])]) });
  assert.deepEqual(sent.emails.map((e) => e.to[0]), ['ops@example.org', 'pm@example.org']);

  await saveSettings(DB, { emails: [] });
  await syncKidPartners(env, { fetchImpl: jtFetch([job('j', 'Ava Lee (2026)', [member('Vendor', { account: 'Paint Pros' }), member('Vendor', { account: 'Tile Town' })])]) });
  assert.equal(sent.emails.length, 2, 'nobody to tell: no email, still listed in the admin');
  assert.equal((await adminView(DB)).waiting.length, 2);
});

test('the sweep asks JobTread for what it accepts (no 413): open jobs by name, then access three jobs at a time, every 10 minutes', async (t) => {
  outside(t);
  const kids = ['ava', 'bo', 'cy', 'di', 'ed'].map((slug) => ({ slug, name: slug[0].toUpperCase() + slug.slice(1), year: 2026, partnerLogos: [] }));
  const DB = await world({ kids });
  const jobs = [...kids.map((k, i) => job(`j${i}`, `${k.name} Smith (2026)`, [])), job('x', 'Nobody Here (2026)', [])];
  const seen = [];
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  const now = Date.parse('2026-10-28T15:00:00Z');
  await maybeSyncKidPartners(env, { fetchImpl: jtFetch(jobs, seen), now });
  const list = seen[0].organization.jobs;
  assert.deepEqual(list.$.where, ['closedOn', '=', null], 'open jobs only');
  assert.deepEqual(Object.keys(list.nodes), ['id', 'name', 'closedOn'], 'the jobs page carries no lists, so its worst case is the page');
  const reads = seen.slice(1).map((q) => Object.values(q).filter((p) => p?._ === 'job'));
  assert.deepEqual(reads.map((parts) => parts.map((p) => p.$.id)), [['j0', 'j1', 'j2'], ['j3', 'j4']], 'access only for jobs with a page, three a request');
  for (const parts of reads) {
    const worst = parts.reduce((n, p) => n + p.aces.$.size, 0);
    assert.ok(worst <= 150, `worst case ${worst}: within what JobTread takes even without a key`);
    assert.deepEqual(Object.keys(parts[0].aces.nodes.membership.account), ['id', 'name'], 'each login’s company');
  }
  await maybeSyncKidPartners(env, { fetchImpl: jtFetch(jobs, seen), now: now + 5 * 60e3 });
  assert.equal(seen.length, 3, 'not due yet');
  await maybeSyncKidPartners(env, { fetchImpl: jtFetch(jobs, seen), now: now + 10 * 60e3 });
  assert.equal(seen.length, 6);
});

test('a job whose access list doesn’t come back fails the check: nothing waiting is dropped', async (t) => {
  outside(t);
  const DB = await world({ kids: [{ slug: 'ava', name: 'Ava', year: 2026, partnerLogos: [] }] });
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  const jobs = [job('j', 'Ava Lee (2026)', [member('Vendor', { account: 'Paint Pros' })])];
  await syncKidPartners(env, { fetchImpl: jtFetch(jobs) });
  assert.equal((await adminView(DB)).waiting.length, 1);
  const broken = async (url, init) => (JSON.parse(init.body).query.organization ? jtFetch(jobs)(url, init) : Response.json({ j0: null }));
  assert.deepEqual(await syncKidPartners(env, { fetchImpl: broken }), []);
  const view = await adminView(DB);
  assert.equal(view.waiting.length, 1, 'still waiting');
  assert.match(view.lastError.error, /no access list for job j/);
});

test('a JobTread failure is kept for Site → Automations, and the next good run clears it', async (t) => {
  outside(t);
  const DB = await world();
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  assert.deepEqual(await syncKidPartners(env, { fetchImpl: async () => new Response('no', { status: 413 }) }), []);
  assert.match((await adminView(DB)).lastError.error, /413/);
  await syncKidPartners(env, { fetchImpl: jtFetch([]) });
  assert.equal((await adminView(DB)).lastError, null);
});

test('the email names everyone on the company and escapes what JobTread sends', () => {
  const rec = { slug: 'ava', name: 'Ava', data: { year: 2026 } };
  const c = { company: 'x', name: 'A&B <Tile>', people: [{ name: 'Al', email: 'al@ab.example', role: 'Vendor' }, { name: null, email: null, role: 'Sponsor' }] };
  const m = missingLogoEmail([{ rec, c, jobId: 'j9', hint: null }]);
  assert.equal(m.subject, '[SOARD] Logo needed: A&B <Tile> on Ava’s page');
  assert.ok(m.html.includes('A&amp;B &lt;Tile&gt;') && !m.html.includes('<Tile>'));
  assert.ok(m.text.includes('as a vendor and sponsor'));
  assert.ok(m.text.includes('No name in JobTread') && m.text.includes('No email in JobTread'));
  const p = missingLogoEmail([{ rec: { kind: 'community', slug: 'drake', name: 'Drake House', data: {} }, c, jobId: 'j', hint: 'Partners has X' }]);
  assert.ok(p.subject.endsWith('on the Drake House page') && p.text.includes('/admin/#kids/community/drake') && p.text.includes('Note: Partners has X'));
});

test('the admin endpoint: list, set aside, and who hears', async (t) => {
  outside(t);
  const DB = await world({ kids: [{ slug: 'ava', name: 'Ava', year: 2026, partnerLogos: [] }] });
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  await syncKidPartners(env, { fetchImpl: jtFetch([job('j', 'Ava Lee (2026)', [member('Vendor', { account: 'Paint Pros' })])]) });
  const post = (body) => onRequestPost({ env, request: new Request('https://x/api/kid-partners-admin', { method: 'POST', body: JSON.stringify(body) }), data: { userEmail: 'linzi@example.org' } }).then((r) => r.json());
  const got = await (await onRequestGet({ env })).json();
  assert.deepEqual(got.waiting.map((r) => [r.record, r.company, r.name]), [['ava', 'paintpros', 'Paint Pros']]);
  const r = await post({ dismiss: { record: 'ava', company: 'paintpros' } });
  assert.deepEqual([r.success, r.state, r.view.dismissed.length], [true, 'dismissed', 1]);
  assert.equal((await post({ dismiss: { record: '../x', company: 'paintpros' } })).error, 'Bad row');
  assert.equal((await post({ dismiss: { record: 'ava', company: 'nobody' } })).error, 'That one isn’t waiting any more');
  assert.equal((await post({ settings: { emails: ['bad'] } })).success, false);
  assert.deepEqual((await post({ settings: { emails: ['ops@example.org'] } })).settings.emails, ['ops@example.org']);
  const audit = (await DB.prepare("SELECT user_email, entity_name FROM audit_log WHERE entity_type = 'partner-logos' ORDER BY id").all()).results;
  assert.deepEqual(audit.map((a) => a.entity_name), ['No logo needed', 'Who hears about missing logos']);
});

test('“Same as”: a company JobTread names differently is linked once, its logo goes on now and on every job after', async (t) => {
  const sent = outside(t);
  const DB = await world({
    kids: [{ slug: 'ava', name: 'Ava', year: 2026, partnerLogos: [] }, { slug: 'bo', name: 'Bo', year: 2026, partnerLogos: [] }],
    partners: PARTNERS,
  });
  const env = { DB, JOBTREAD_GRANT_KEY: 'k', RESEND_API_KEY: 'r', CF_PAGES_DEPLOY_HOOK: 'https://hook.example/deploy' };
  let jobs = [job('ja', 'Ava Lee (2026)', [member('Vendor', { account: 'Randall Bros. Lumber', email: 'sales@rb-lumber.example' })])];
  const now = Date.parse('2026-10-28T15:00:00Z');
  await syncKidPartners(env, { fetchImpl: jtFetch(() => jobs), now });
  const waiting = (await adminView(DB)).waiting;
  assert.deepEqual(waiting.map((r) => r.name), ['Randall Bros. Lumber'], 'not the same name: waiting, never guessed');
  assert.equal(sent.emails.length, 1);

  const post = (body) => onRequestPost({ env, request: new Request('https://x/api/kid-partners-admin', { method: 'POST', body: JSON.stringify(body) }), data: { userEmail: 'linzi@example.org' } }).then((r) => r.json());
  assert.equal((await post({ link: { company: 'randallbroslumber', partner: 'nobody' } })).error, 'That partner isn’t in Partners any more');
  const r = await post({ link: { company: 'randallbroslumber', partner: 'randall-brothers' } });
  assert.deepEqual(r.added, [{ record: 'ava', name: 'Ava', added: ['Randall Brothers'], waiting: [] }], 'the logo goes on right away');
  assert.deepEqual((await kidOf(DB, 'ava')).partnerLogos, [{ url: PARTNERS[0].logo, name: 'Randall Brothers' }]);
  assert.deepEqual([r.view.waiting.length, r.view.links], [0, [{ company: 'randallbroslumber', partner: 'randall-brothers', name: 'Randall Bros. Lumber' }]]);

  // The next job they're on: no email, the logo goes straight on
  jobs = [...jobs, job('jb', 'Bo Park (2026)', [member('Vendor', { account: 'Randall Bros. Lumber' })])];
  await syncKidPartners(env, { fetchImpl: jtFetch(() => jobs), now: now + 11 * 60e3 });
  assert.equal((await kidOf(DB, 'bo')).partnerLogos[0]?.url, PARTNERS[0].logo);
  assert.equal(sent.emails.length, 1, 'nobody is asked again');

  // Unlinked: the logos already on pages stay; a new job waits again
  const u = await post({ unlink: { company: 'randallbroslumber' } });
  assert.deepEqual(u.view.links, []);
  assert.equal((await kidOf(DB, 'ava')).partnerLogos.length, 1, 'logos already on pages stay');
});

test('linked to a partner who has no logo yet: it waits, and says so', () => {
  const index = logoIndex(PARTNERS, [], { acme: 'sherwin' });
  const out = findLogo({ company: 'acme', name: 'Acme', people: [] }, index);
  assert.deepEqual(out, { logo: null, hint: 'Linked to Sherwin-Williams Store, who has no logo in Partners yet' });
});
