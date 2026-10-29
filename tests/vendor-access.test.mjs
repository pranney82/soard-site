/**
 * Vendors on their JobTread jobs (functions/api/_vendor-access.js): each open
 * job's vendors (logos on the page, bills and orders) get JobTread job access
 * as Vendors without JobTread's email; a company on a page with no JobTread
 * vendor account gets one; contacts sync both ways, newest wins. Plus the
 * admin's Partners → JobTread access and what the logo sweep makes of it.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import {
  jobVendors, onJob, personFor, pairAccounts, contactPlan, sameList, syncVendorAccess, maybeSyncVendorAccess, adminView,
} from '../functions/api/_vendor-access.js';
import { knownPeople, jobCompanies } from '../functions/api/_kid-partners.js';
import { readContacts, saveContacts } from '../functions/api/_sponsors.js';
import { _resetRoleCache } from '../functions/api/_jt-access.js';
import { FIELD_CONTACT_EMAIL, FIELD_CONTACT_PHONE } from '../functions/api/_applicant-comms.js';
import { onRequestGet, onRequestPost } from '../functions/api/vendor-access-admin.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;
const ROLES = { Vendor: 'r-vendor', Sponsor: 'r-sponsor', 'Makeover Family': 'r-family' };
const T0 = Date.parse('2026-10-28T12:00:00Z');
const MIN = 60 * 1000;

const RANDALL = { slug: 'randall-brothers', name: 'Randall Brothers', logo: img('partners/randall-brothers/1'), website: 'https://randallbrothers.example' };
const BLYTHE = { slug: 'blythe-creative', name: 'Blythe Creative Co.', logo: img('partners/blythe-creative/1') };
const WYP = { slug: 'walk-your-plans', name: 'Walk Your Plans', logo: img('partners/walk-your-plans/1') };
const ACME = { slug: 'acme-foundation', name: 'Acme Foundation', logo: img('partners/acme/1') };
const logoOf = (p) => ({ url: p.logo, name: p.name });
const ISLA = { slug: 'isla-smith', name: 'Isla Smith', year: 2026, sponsors: ['acme-foundation'], partnerLogos: [RANDALL, BLYTHE, WYP, ACME].map(logoOf) };

/** A small JobTread: open jobs and who has access, vendor accounts and their contacts, SOARD's memberships */
function fakeJT({ jobs, members = [], accounts = [] }) {
  const calls = [];
  let n = 0;
  const people = new Map(members.map((m) => [m.email, { id: m.id || `m${++n}`, createdAt: '2025-01-01T00:00:00Z', role: null, account: null, internal: false, ...m }]));
  const asMembership = (m) => ({ id: m.id, createdAt: m.createdAt, isInternal: m.internal, role: m.role ? { id: ROLES[m.role], name: m.role } : null, account: m.account, user: { name: m.name, emailAddress: m.email } });
  const asContact = (c) => ({
    id: c.id, name: c.name, title: c.title || '', createdAt: c.createdAt || '2025-01-01T00:00:00Z',
    customFieldValues: { nodes: [c.email && { createdAt: c.createdAt || '2025-01-01T00:00:00Z', value: c.email, customField: { id: FIELD_CONTACT_EMAIL } }, c.phone && { createdAt: '2025-01-01T00:00:00Z', value: c.phone, customField: { id: FIELD_CONTACT_PHONE } }].filter(Boolean) },
  });
  const contact = (id) => accounts.flatMap((a) => a.contacts).find((c) => c.id === id);
  const fetchImpl = async (url, init) => {
    const q = JSON.parse(init.body).query;
    calls.push(q);
    const reply = (body) => Response.json(body);
    const o = q.organization;
    if (o?.jobs) return reply({ organization: { jobs: { nextPage: null, nodes: jobs.map(({ id, name }) => ({ id, name, closedOn: null })) } } });
    if (o?.accounts) {
      assert.equal(o.accounts.$.where[2], 'vendor');
      return reply({ organization: { accounts: { nextPage: null, nodes: accounts.map((a) => ({ id: a.id, name: a.name, archivedAt: a.archived ? '2026-01-01' : null, primaryContact: a.primary ? { id: a.primary } : null, contacts: { nodes: a.contacts.map(asContact) } })) } } });
    }
    if (o?.roles) return reply({ organization: { roles: { nodes: Object.entries(ROLES).map(([name, id]) => ({ id, name })) } } });
    if (o?.memberships) { const m = people.get(o.memberships.$.where[2]); return reply({ organization: { memberships: { nodes: m ? [asMembership(m)] : [] } } }); }
    if (q.createAce) {
      const { assignee, targetId, notify } = q.createAce.$;
      assert.equal(notify, false, 'JobTread never emails vendors');
      let m = assignee.membershipId ? [...people.values()].find((x) => x.id === assignee.membershipId) : null;
      if (!m) { m = { id: `m${++n}`, email: assignee.emailAddress, name: assignee.name, role: null, account: null, createdAt: new Date().toISOString(), internal: false }; people.set(m.email, m); }
      jobs.find((x) => x.id === targetId).access.push(m.email);
      return reply({ createAce: { createdAce: { id: `ace${n}`, membership: asMembership(m) } } });
    }
    if (q.updateMembership) { [...people.values()].find((x) => x.id === q.updateMembership.$.id).role = Object.keys(ROLES).find((k) => ROLES[k] === q.updateMembership.$.roleId); return reply({}); }
    if (q.createAccount) {
      assert.equal(q.createAccount.$.type, 'vendor');
      const a = { id: `acct${++n}`, name: q.createAccount.$.name, contacts: [] };
      accounts.push(a);
      return reply({ createAccount: { createdAccount: { id: a.id, name: a.name } } });
    }
    if (q.createContact) {
      const $ = q.createContact.$;
      const c = { id: `c${++n}`, name: $.name, title: $.title || '', email: $.customFieldValues?.[FIELD_CONTACT_EMAIL] || '', phone: $.customFieldValues?.[FIELD_CONTACT_PHONE] || '' };
      accounts.find((a) => a.id === $.accountId).contacts.push(c);
      return reply({ createContact: { createdContact: { id: c.id } } });
    }
    if (q.updateContact) {
      const $ = q.updateContact.$;
      const c = contact($.id);
      if ($.name != null) c.name = $.name;
      if ($.title != null) c.title = $.title;
      if ($.customFieldValues?.[FIELD_CONTACT_EMAIL] != null) c.email = $.customFieldValues[FIELD_CONTACT_EMAIL];
      if ($.customFieldValues?.[FIELD_CONTACT_PHONE] != null) c.phone = $.customFieldValues[FIELD_CONTACT_PHONE];
      return reply({});
    }
    if (q.deleteContact) { for (const a of accounts) a.contacts = a.contacts.filter((c) => c.id !== q.deleteContact.$.id); return reply({}); }
    const out = {};
    for (const [alias, part] of Object.entries(q)) {
      if (part?._ !== 'job') continue;
      const j = jobs.find((x) => x.id === part.$.id);
      out[alias] = j ? { id: j.id, aces: { nodes: j.access.map((e) => ({ membership: asMembership(people.get(e)) })) } } : null;
    }
    if (Object.keys(out).length) return reply(out);
    throw new Error(`unexpected query ${JSON.stringify(q).slice(0, 120)}`);
  };
  const kinds = () => calls.map((q) => Object.keys(q).find((k) => k !== '$'));
  return { fetchImpl, calls, people, jobs, accounts, kinds };
}

async function world({ kids = [ISLA], partners = [RANDALL, BLYTHE, WYP, ACME], bills = [] } = {}) {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const k of kids) await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(k.slug, k.name, k.year, 'in-progress', JSON.stringify(k)).run();
  for (const p of partners) await DB.prepare('INSERT INTO partners (slug, name, level, category, featured, data) VALUES (?, ?, ?, ?, ?, ?)').bind(p.slug, p.name, 'friend', 'build', 0, JSON.stringify(p)).run();
  // The vendors table's JobTread cache: which JobTread vendors have a bill or order on which job
  await DB.prepare('CREATE TABLE IF NOT EXISTS vendors (id TEXT PRIMARY KEY, name TEXT NOT NULL, jt_id TEXT, facts TEXT)').run();
  for (const b of bills) await DB.prepare('INSERT INTO vendors (id, name, jt_id, facts) VALUES (?, ?, ?, ?)').bind(`v_${b.jtId}`, b.name, b.jtId, JSON.stringify({ jobs: b.jobs.map((jobId) => ({ jobId, order: false })) })).run();
  return DB;
}
const env = (DB) => ({ DB, JOBTREAD_GRANT_KEY: 'k' });
const rows = async (DB) => (await DB.prepare('SELECT company, state, reason, why FROM vendor_access ORDER BY company').all()).results;
/** Resend or anyone else: nothing here sends mail */
function noMail(t) {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url) => { sent.push(String(url)); return new Response('ok'); });
  return sent;
}

test('a job’s vendors: logos on the page (by file or name) and bills, never the kid’s monetary sponsor', () => {
  const accounts = [
    { id: 'acct-r', name: 'Randall Brothers, Inc.', contacts: [] },
    { id: 'acct-e', name: 'Ace Electric', contacts: [] },
    { id: 'acct-a', name: 'Acme Foundation', contacts: [] },
    { id: 'acct-cr', name: 'CR Construction', contacts: [] },
  ];
  const partners = [RANDALL, BLYTHE, ACME];
  const pairs = pairAccounts(partners, accounts);
  assert.equal(pairs.get('randall-brothers').id, 'acct-r', 'the same name pairs a partner with its JobTread vendor');
  const rec = { slug: 'isla', name: 'Isla', data: { sponsors: ['acme-foundation'], partnerLogos: [logoOf(RANDALL), { url: img('kids/isla/blythe'), name: 'Blythe Creative Co.' }, logoOf(ACME), { url: img('kids/isla/cr'), name: 'CR Construction' }] } };
  const list = jobVendors(rec, { partners, pairs, accounts, bills: ['acct-e', 'acct-r', 'acct-a'] });
  const by = Object.fromEntries(list.map((v) => [v.name, [...v.why].sort().join(' ')]));
  assert.deepEqual(by, { 'Randall Brothers': 'bill page', 'Blythe Creative Co.': 'page', 'CR Construction': 'page', 'Ace Electric': 'bill' });
  assert.equal(list.find((v) => v.name === 'CR Construction').account.id, 'acct-cr', 'a logo not in Partners still finds its JobTread vendor by name');
});

test('on the job already: their JobTread account, a contact’s email or their website’s domain, in any role', () => {
  const v = { company: 'randallbrothers', name: 'Randall Brothers', account: { id: 'acct-r', contacts: [{ email: 'office@rb-mail.example' }] } };
  const aces = (m) => ({ nodes: [{ membership: { isInternal: false, role: { name: 'Sponsor' }, account: null, user: { name: 'X', emailAddress: 'x@example.com' }, ...m } }] });
  assert.ok(onJob(v, aces({ account: { id: 'acct-r', name: 'RB' } })));
  assert.ok(onJob(v, aces({ account: { id: 'other', name: 'Randall Brothers LLC' } })));
  assert.ok(onJob(v, aces({ user: { emailAddress: 'Office@RB-mail.example' } })));
  assert.ok(onJob(v, aces({ user: { emailAddress: 'ron@randallbrothers.example' } }), { website: 'https://www.randallbrothers.example' }));
  assert.ok(!onJob(v, aces({ user: { emailAddress: 'not-a-real-person@gmail.com' } }), { website: 'https://gmail.com' }), 'a free mail domain is nobody’s company');
  assert.ok(!onJob(v, aces({ isInternal: true, account: { id: 'acct-r' } })), 'staff don’t count');
});

test('who’s added: the account’s primary contact, its first with an email, then Partners’', () => {
  const account = { primary: 'c2', contacts: [{ id: 'c1', name: 'No Email' }, { id: 'c2', name: 'Pri Mary', email: 'pm@rb.example' }, { id: 'c3', name: 'Other', email: 'o@rb.example' }] };
  assert.deepEqual(personFor({ name: 'RB', account }), { name: 'Pri Mary', email: 'pm@rb.example' });
  assert.deepEqual(personFor({ name: 'RB', account: { contacts: [{ name: 'A', email: 'a@rb.example' }] } }), { name: 'A', email: 'a@rb.example' });
  assert.deepEqual(personFor({ name: 'Blythe', account: null }, [{ name: '', email: 'Hi@Blythe.example' }]), { name: 'Blythe', email: 'hi@blythe.example' });
  assert.equal(personFor({ name: 'Blythe', account: null }, [{ name: 'Phone Only', phone: '404' }]), null);
});

test('contacts both ways: put together the first time, then the side that changed wins, the newer when both did', () => {
  const jo = { name: 'Jo Lee', email: 'jo@rb.example', phone: '(404) 555-0100', title: '' };
  const first = contactPlan({ site: [jo], siteAt: '2026-10-01T00:00:00Z', jt: [{ name: 'Jo Lee', email: 'jo@rb.example', phone: '', title: 'Owner', at: '2025-01-01T00:00:00Z' }, { name: 'Sam', email: 'sam@rb.example', phone: '', title: '' }] });
  assert.deepEqual(first.toSite, [{ ...jo, title: 'Owner' }, { name: 'Sam', email: 'sam@rb.example', phone: '', title: '' }], 'the newer side’s details, blanks filled from the other');
  assert.deepEqual(first.toJt, first.toSite);

  const seen = { site: [jo], jt: [jo], at: '2026-10-28T11:00:00Z' };
  assert.deepEqual(contactPlan({ site: [jo], jt: [{ ...jo, phone: '+1 404-555-0100' }], seen }), { toSite: null, toJt: null, winner: null }, 'the same phone written another way is no change');
  const jtEdit = contactPlan({ site: [jo], siteAt: '2026-10-28T10:00:00Z', jt: [{ ...jo, phone: '404 555 0199' }], seen });
  assert.equal(jtEdit.winner, 'jobtread');
  assert.equal(jtEdit.toSite[0].phone, '404 555 0199');
  const siteEdit = contactPlan({ site: [], siteAt: '2026-10-28T11:30:00Z', jt: [jo], seen });
  assert.equal(siteEdit.winner, 'site');
  assert.deepEqual(siteEdit.toJt, [], 'taken off in Partners comes off JobTread');
  // Both changed since the last sync: the website's edit after it beats JobTread's undated one
  const both = contactPlan({ site: [{ ...jo, title: 'Owner' }], siteAt: '2026-10-28T11:30:00Z', jt: [{ ...jo, phone: '404 555 0199' }], seen });
  assert.equal(both.winner, 'site');
  // …but not a JobTread contact made after the website's edit
  const newer = contactPlan({ site: [{ ...jo, title: 'Owner' }], siteAt: '2026-10-28T11:30:00Z', jt: [jo, { name: 'New', email: 'new@rb.example', at: '2026-10-28T11:45:00Z' }], seen });
  assert.equal(newer.winner, 'jobtread');
  assert.ok(sameList([jo], [{ ...jo, name: ' Jo  Lee ', email: 'JO@rb.example' }]));
});

test('a sweep: vendors added quietly as Vendors, a page’s company gets a JobTread account, a near name waits, nobody is emailed', async (t) => {
  _resetRoleCache();
  const sent = noMail(t);
  const DB = await world({ bills: [{ jtId: 'acct-e', name: 'Ace Electric', jobs: ['j1'] }] });
  await saveContacts(DB, 'randall-brothers', [{ name: 'Ron Randall', email: 'ron@randallbrothers.example', phone: '(404) 555-0100' }]);
  await saveContacts(DB, 'acme-foundation', [{ name: 'Ann Acme', email: 'ann@acmefdn.example' }]);
  const jt = fakeJT({
    jobs: [{ id: 'j1', name: 'Isla Smith (2026)', access: ['mom@example.com'] }, { id: 'j9', name: 'TEST Isla Smith (2026)', access: [] }],
    members: [{ email: 'mom@example.com', name: 'Mom Smith', role: 'Makeover Family' }],
    accounts: [
      { id: 'acct-r', name: 'Randall Brothers', contacts: [] },
      { id: 'acct-e', name: 'Ace Electric', primary: 'c-e', contacts: [{ id: 'c-e', name: 'Eve Ace', email: 'eve@aceelectric.example' }] },
      { id: 'acctwyp1', name: 'WYP Construction', contacts: [] },
    ],
  });
  const report = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.added.map((a) => `${a.person} (${a.name})`).sort(), ['Eve Ace (Ace Electric)', 'Ron Randall (Randall Brothers)']);
  for (const email of ['ron@randallbrothers.example', 'eve@aceelectric.example']) assert.equal(jt.people.get(email).role, 'Vendor');
  assert.ok(!jt.jobs[0].access.includes('ann@acmefdn.example'), 'the monetary sponsor is the Sponsor sweep’s');
  assert.deepEqual(jt.jobs[1].access, [], 'a TEST job is left alone');

  // Blythe has no JobTread vendor: one is made, under its Partners name. Walk Your Plans has a near one: it waits
  assert.deepEqual(report.made, [{ partner: 'blythe-creative', name: 'Blythe Creative Co.' }]);
  assert.ok(!jt.accounts.some((a) => a.name === 'Walk Your Plans'));
  const view = await adminView(DB);
  assert.deepEqual(view.near, [{ partner: 'walk-your-plans', name: 'Walk Your Plans', near: [{ id: 'acctwyp1', name: 'WYP Construction', why: view.near[0].near[0].why }] }]);
  // Nobody to add for Blythe or Walk Your Plans yet
  assert.deepEqual(view.waiting.map((w) => [w.name, w.reason, w.jobs.length]), [['Blythe Creative Co.', 'no-email', 1], ['Walk Your Plans', 'no-email', 1]]);
  assert.deepEqual(await rows(DB), [
    { company: 'aceelectric', state: 'added', reason: null, why: 'bill' },
    { company: 'blythecreative', state: 'waiting', reason: 'no-email', why: 'page' },
    { company: 'randallbrothers', state: 'added', reason: null, why: 'page' },
    { company: 'walkyourplans', state: 'waiting', reason: 'no-email', why: 'page' },
  ]);
  // Randall Brothers' contact went into its JobTread account
  assert.deepEqual(jt.accounts.find((a) => a.id === 'acct-r').contacts.map((c) => [c.name, c.email, c.phone]), [['Ron Randall', 'ron@randallbrothers.example', '(404) 555-0100']]);
  // …and Ace Electric isn't a partner, so nothing of it lands in Partners
  assert.deepEqual(Object.keys(await readContacts(DB)).sort(), ['acme-foundation', 'randall-brothers']);
  assert.deepEqual(sent, [], 'no email, from JobTread or the site');
  const audit = (await DB.prepare('SELECT entity_type, changes FROM audit_log ORDER BY id').all()).results;
  assert.deepEqual(audit.map((a) => a.entity_type), ['jobtread-vendor', 'jobtread-access', 'partner-contacts'], 'accounts made, people on jobs, then contacts');
  assert.doesNotMatch(audit.map((a) => a.changes).join(' '), /@/, 'names only in History');

  // The next run: everyone's there, nothing is written to JobTread
  const before = jt.calls.length;
  const again = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.deepEqual([again.added, again.made, again.contacts], [[], [], []]);
  assert.deepEqual(jt.kinds().slice(before).filter((k) => /^(create|update|delete)/.test(k)), []);
});

test('contacts stay in step: an edit in JobTread reaches Partners, one taken off in Partners leaves JobTread', async (t) => {
  _resetRoleCache();
  noMail(t);
  const DB = await world({ kids: [], partners: [RANDALL] });
  await saveContacts(DB, 'randall-brothers', [{ name: 'Ron Randall', email: 'ron@randallbrothers.example' }], { now: T0 - 60 * MIN });
  const jt = fakeJT({ jobs: [], accounts: [{ id: 'acct-r', name: 'Randall Brothers', contacts: [{ id: 'c-rita', name: 'Rita Randall', email: 'rita@randallbrothers.example', title: 'Office' }] }] });
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  const both = ['Ron Randall', 'Rita Randall'];
  assert.deepEqual((await readContacts(DB))['randall-brothers'].map((p) => p.name).sort(), [...both].sort(), 'the first sync puts the two together');
  assert.deepEqual(jt.accounts[0].contacts.map((c) => c.name).sort(), [...both].sort());

  // Rita's phone changes in JobTread
  jt.accounts[0].contacts.find((c) => c.name === 'Rita Randall').phone = '404-555-0142';
  const r1 = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.deepEqual(r1.contacts.map((c) => c.to), ['Partners']);
  assert.equal((await readContacts(DB))['randall-brothers'].find((p) => p.name === 'Rita Randall').phone, '404-555-0142');

  // Staff take Ron off in Partners
  const left = (await readContacts(DB))['randall-brothers'].filter((p) => p.name !== 'Ron Randall');
  await saveContacts(DB, 'randall-brothers', left, { now: T0 + 20 * MIN });
  const r2 = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 30 * MIN });
  assert.deepEqual(r2.contacts.map((c) => c.to), ['JobTread']);
  assert.deepEqual(jt.accounts[0].contacts.map((c) => c.name), ['Rita Randall']);
  assert.ok(jt.kinds().includes('deleteContact'));

  // Then nothing to do
  const r3 = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 45 * MIN });
  assert.deepEqual(r3.contacts, []);
});

test('the admin: “Same company” pairs a near name for good, an email added puts them on the job now, “Not needed” sets one aside', async (t) => {
  _resetRoleCache();
  noMail(t);
  const DB = await world({ partners: [RANDALL, BLYTHE, WYP, ACME] });
  const jt = fakeJT({
    jobs: [{ id: 'j1', name: 'Isla Smith (2026)', access: [] }],
    accounts: [{ id: 'acct-r', name: 'Randall Brothers', contacts: [] }, { id: 'acctwyp1', name: 'WYP Construction', contacts: [{ id: 'c-w', name: 'Walt', email: 'walt@wypconstruction.example' }] }],
  });
  t.mock.method(globalThis, 'fetch', jt.fetchImpl);
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  const req = (body) => ({ env: env(DB), data: { userEmail: 'staff@example.org' }, request: new Request('https://x/api/vendor-access-admin', { method: 'POST', body: JSON.stringify(body) }) });

  const got = await (await onRequestGet({ env: env(DB) })).json();
  assert.ok(got.success);
  assert.deepEqual(got.near.map((n) => n.name), ['Walk Your Plans']);

  // Same company: WYP Construction is Walk Your Plans, so Walt goes on the job
  const same = await (await onRequestPost(req({ settle: { partner: 'walk-your-plans', account: 'acctwyp1' } }))).json();
  assert.ok(same.success, same.error);
  assert.deepEqual(same.report.added.map((a) => a.person), ['Walt']);
  assert.deepEqual(same.view.near, []);
  const links = JSON.parse((await DB.prepare("SELECT value FROM kid_partner_state WHERE key = 'links'").first()).value);
  assert.equal(links.wypconstruction, 'walk-your-plans', 'the logo sweep knows them as one too');

  // An email for Blythe: on the job straight away, and into its new JobTread account
  const saved = await (await onRequestPost(req({ contacts: { partner: 'blythe-creative', people: [{ name: 'Bea Blythe', email: 'bea@blythe.example.com' }] } }))).json();
  assert.ok(saved.success, saved.error);
  assert.deepEqual(saved.report.added.map((a) => a.person), ['Bea Blythe']);
  assert.ok(jt.jobs[0].access.includes('bea@blythe.example.com'));
  assert.deepEqual(jt.accounts.find((a) => a.name === 'Blythe Creative Co.').contacts.map((c) => c.email), ['bea@blythe.example.com']);

  // Randall Brothers: nobody to reach, and staff say it's not needed
  const aside = await (await onRequestPost(req({ setAside: { company: 'randallbrothers' } }))).json();
  assert.deepEqual(aside.view.waiting, []);
  assert.deepEqual(aside.view.setAside.map((s) => s.name), ['Randall Brothers']);
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.deepEqual((await adminView(DB)).waiting, [], 'set aside stays aside');
  const undo = await (await onRequestPost(req({ setAside: { company: 'randallbrothers', undo: true } }))).json();
  assert.deepEqual(undo.view.setAside, []);

  assert.equal((await (await onRequestPost(req({ settle: { partner: '../x', account: 'acctwyp1' } }))).json()).error, 'Bad choice');
  assert.equal((await onRequestPost(req({ recheck: { company: 'Not A Key' } }))).status, 400);
});

test('“Make a new one”: a near name the staff say is someone else gets its own account', async (t) => {
  _resetRoleCache();
  noMail(t);
  const DB = await world({ kids: [{ ...ISLA, partnerLogos: [logoOf(WYP)] }], partners: [WYP] });
  const jt = fakeJT({ jobs: [{ id: 'j1', name: 'Isla Smith (2026)', access: [] }], accounts: [{ id: 'acctwyp1', name: 'WYP Construction', contacts: [] }] });
  t.mock.method(globalThis, 'fetch', jt.fetchImpl);
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  const r = await (await onRequestPost({ env: env(DB), data: {}, request: new Request('https://x', { method: 'POST', body: JSON.stringify({ settle: { partner: 'walk-your-plans', makeNew: true } }) }) })).json();
  assert.deepEqual(r.report.made.map((m) => m.name), ['Walk Your Plans']);
  assert.deepEqual(r.view.near, []);
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.equal(jt.accounts.filter((a) => a.name === 'Walk Your Plans').length, 1, 'made once');
});

test('a same-named vendor JobTread archived: staff choose, the sweep never makes a second one', async (t) => {
  _resetRoleCache();
  noMail(t);
  const DB = await world({ kids: [{ ...ISLA, partnerLogos: [logoOf(BLYTHE)] }], partners: [BLYTHE] });
  const jt = fakeJT({ jobs: [{ id: 'j1', name: 'Isla Smith (2026)', access: [] }], accounts: [{ id: 'acctold01', name: 'Blythe Creative Co', archived: true, contacts: [] }] });
  const r = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  assert.deepEqual(r.made, []);
  assert.deepEqual((await adminView(DB)).near.map((n) => n.near.map((x) => x.name)), [['Blythe Creative Co (archived)']]);
  t.mock.method(globalThis, 'fetch', jt.fetchImpl);
  const res = await (await onRequestPost({ env: env(DB), data: {}, request: new Request('https://x', { method: 'POST', body: JSON.stringify({ settle: { partner: 'blythe-creative', account: 'acctold01' } }) }) })).json();
  assert.ok(res.success, res.error);
  assert.deepEqual(res.view.near, []);
  assert.equal((await DB.prepare("SELECT account_name FROM vendor_accounts WHERE partner = 'blythe-creative'").first()).account_name, 'Blythe Creative Co', 'paired, archived or not');
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.equal(jt.accounts.length, 1, 'still no second account');
});

test('the logo sweep: someone added for a bill alone brings no logo; one added by email is their partner, not their own name', async () => {
  const DB = await world({ partners: [RANDALL] });
  await saveContacts(DB, 'randall-brothers', [{ name: 'Ron Randall', email: 'ron@randallbrothers.example' }]);
  const { ensureSchema } = await import('../functions/api/_vendor-access.js');
  await ensureSchema(DB);
  await DB.prepare("INSERT INTO vendor_access (job_id, company, name, why, state, person) VALUES ('j1', 'aceelectric', 'Ace Electric', 'bill', 'added', ?)").bind(JSON.stringify({ name: 'Eve Ace', email: 'eve@aceelectric.example' })).run();
  const { who, quiet } = await knownPeople(DB, [RANDALL]);
  assert.deepEqual(who.get('ron@randallbrothers.example'), { name: 'Randall Brothers', partner: 'randall-brothers' });
  assert.ok(quiet.has('j1 eve@aceelectric.example'));
  const list = jobCompanies({ aces: { nodes: [{ membership: { isInternal: false, role: { name: 'Vendor' }, account: null, user: { name: 'Ron Randall', emailAddress: 'ron@randallbrothers.example' } } }] } }, who);
  assert.deepEqual(list.map((c) => [c.name, c.partner]), [['Randall Brothers', 'randall-brothers']]);
});

test('every 15 minutes from the heartbeat; a JobTread failure is kept for Site → Automations', async (t) => {
  _resetRoleCache();
  noMail(t);
  const DB = await world();
  let n = 0;
  const failing = async () => { n++; return new Response('nope', { status: 500 }); };
  assert.equal(await maybeSyncVendorAccess({ DB }, { fetchImpl: failing, now: T0 }), null, 'not connected: nothing');
  await maybeSyncVendorAccess(env(DB), { fetchImpl: failing, now: T0 });
  assert.ok(n > 0);
  assert.match((await adminView(DB)).lastError.error, /JobTread/);
  const seen = n;
  await maybeSyncVendorAccess(env(DB), { fetchImpl: failing, now: T0 + 5 * MIN });
  assert.equal(n, seen, 'not again inside 15 minutes');
  const jt = fakeJT({ jobs: [], accounts: [] });
  await maybeSyncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 16 * MIN });
  assert.equal((await adminView(DB)).lastError, null, 'a good run clears it');
});
