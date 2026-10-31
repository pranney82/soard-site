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
  jobVendors, onJob, personFor, pairAccounts, contactPlan, sameList, syncVendorAccess, maybeSyncVendorAccess, adminView, sameWords,
} from '../functions/api/_vendor-access.js';
import { knownPeople, jobCompanies } from '../functions/api/_kid-partners.js';
import { readContacts, saveContacts } from '../functions/api/_sponsors.js';
import { _resetRoleCache } from '../functions/api/_jt-access.js';
import { FIELD_CONTACT_EMAIL } from '../functions/api/_applicant-comms.js';
import { onRequestGet, onRequestPost } from '../functions/api/vendor-access-admin.js';
import { onRequestPost as logoAdminPost } from '../functions/api/kid-partners-admin.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;
// A vendor contact's own Email and Phone fields (not a family's, which JobTread refuses on a vendor)
const VC_EMAIL = 'vc-email';
const VC_PHONE = 'vc-phone';
const ROLES = { Vendor: 'r-vendor', 'Monetary Sponsor': 'r-sponsor', 'Makeover Family': 'r-family' };
const PERMS = { Vendor: ['readJobPlans', 'readJobTasks', 'updateJobToDoProgresses'], 'Monetary Sponsor': ['readDailyLogs', 'readJobTaskGroups'] };
const T0 = Date.parse('2026-10-28T12:00:00Z');
const MIN = 60 * 1000;

const RANDALL = { slug: 'randall-brothers', name: 'Randall Brothers', logo: img('partners/randall-brothers/1'), website: 'https://randallbrothers.example' };
const BLYTHE = { slug: 'blythe-creative', name: 'Blythe Creative Co.', logo: img('partners/blythe-creative/1') };
const WYP = { slug: 'walk-your-plans', name: 'Walk Your Plans', logo: img('partners/walk-your-plans/1') };
const ACME = { slug: 'acme-foundation', name: 'Acme Foundation', logo: img('partners/acme/1') };
const logoOf = (p) => ({ url: p.logo, name: p.name });
const ISLA = { slug: 'isla-smith', name: 'Isla Smith', year: 2026, sponsors: ['acme-foundation'], partnerLogos: [RANDALL, BLYTHE, WYP, ACME].map(logoOf) };

/**
 * A small JobTread: open jobs and who has access, vendor accounts (with what they hold:
 * documents, files, aces, or aceList: [{ internal, name }]) and their contacts, SOARD's memberships
 */
function fakeJT({ jobs, members = [], accounts = [] }) {
  const calls = [];
  const made = [];
  let n = 0;
  const people = new Map(members.map((m) => [m.email, { id: m.id || `m${++n}`, createdAt: '2025-01-01T00:00:00Z', role: null, account: null, internal: false, ...m }]));
  const asMembership = (m) => ({ id: m.id, createdAt: m.createdAt, isInternal: m.internal, role: m.role ? { id: ROLES[m.role], name: m.role } : null, account: m.account, user: { name: m.name, emailAddress: m.email } });
  const asContact = (c) => ({
    id: c.id, name: c.name, title: c.title || '', createdAt: c.createdAt || '2025-01-01T00:00:00Z',
    customFieldValues: { nodes: [c.email && { createdAt: c.createdAt || '2025-01-01T00:00:00Z', value: c.email, customField: { id: VC_EMAIL } }, c.phone && { createdAt: '2025-01-01T00:00:00Z', value: c.phone, customField: { id: VC_PHONE } }].filter(Boolean) },
  });
  const contact = (id) => accounts.flatMap((a) => a.contacts).find((c) => c.id === id);
  const fetchImpl = async (url, init) => {
    const q = JSON.parse(init.body).query;
    calls.push(q);
    const reply = (body) => Response.json(body);
    const o = q.organization;
    if (o?.customFields) {
      assert.equal(o.customFields.$.where[2], 'vendorContact');
      return reply({ organization: { customFields: { nodes: [{ id: VC_EMAIL, name: 'Email', type: 'emailAddress' }, { id: VC_PHONE, name: 'Phone', type: 'phoneNumber' }] } } });
    }
    if (o?.jobs) return reply({ organization: { jobs: { nextPage: null, nodes: jobs.map(({ id, name }) => ({ id, name, closedOn: null })) } } });
    if (o?.accounts) {
      assert.equal(o.accounts.$.where[2], 'vendor');
      assert.deepEqual(o.accounts.nodes.contacts.nodes.customFieldValues.$.where[2], [VC_EMAIL, VC_PHONE], 'a vendor contact’s own fields');
      return reply({ organization: { accounts: { nextPage: null, nodes: accounts.map((a) => ({ id: a.id, name: a.name, archivedAt: a.archived ? '2026-01-01' : null, createdAt: a.createdAt || '2025-06-01T00:00:00Z', primaryContact: a.primary ? { id: a.primary } : null, contacts: { nodes: a.contacts.map(asContact) },
        customFieldValues: { nodes: Object.entries(a.fields || {}).map(([name, value]) => ({ value, customField: { name } })) } })) } } });
    }
    if (o?.roles) return reply({ organization: { roles: { nodes: Object.entries(ROLES).map(([name, id]) => ({ id, name, type: name === 'Makeover Family' ? 'customer' : 'vendor', permissions: PERMS[name] || [] })) } } });
    if (o?.memberships && !o.memberships.$.where) return reply({ organization: { memberships: { nextPage: null, nodes: [...people.values()].map(asMembership) } } });
    if (o?.memberships) { const m = people.get(o.memberships.$.where[2]); return reply({ organization: { memberships: { nodes: m ? [asMembership(m)] : [] } } }); }
    if (q.createRole) { const { name, type, permissions } = q.createRole.$; ROLES[name] = `r-${name.toLowerCase().replace(/\s+/g, '-')}`; PERMS[name] = permissions; made.push({ name, type, permissions }); return reply({ createRole: { createdRole: { id: ROLES[name], name } } }); }
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
      assert.ok(!$.customFieldValues?.[FIELD_CONTACT_EMAIL], 'never a family’s field on a vendor contact');
      const c = { id: `c${++n}`, name: $.name, title: $.title || '', email: $.customFieldValues?.[VC_EMAIL] || '', phone: $.customFieldValues?.[VC_PHONE] || '' };
      accounts.find((a) => a.id === $.accountId).contacts.push(c);
      return reply({ createContact: { createdContact: { id: c.id } } });
    }
    if (q.updateContact) {
      const $ = q.updateContact.$;
      const c = contact($.id);
      if ($.name != null) c.name = $.name;
      if ($.title != null) c.title = $.title;
      if ($.customFieldValues?.[VC_EMAIL] != null) c.email = $.customFieldValues[VC_EMAIL];
      if ($.customFieldValues?.[VC_PHONE] != null) c.phone = $.customFieldValues[VC_PHONE];
      return reply({});
    }
    if (q.job) { const j = jobs.find((x) => x.id === q.job.$.id); return reply({ job: j ? { id: j.id, aces: { nodes: j.access.map((e) => ({ id: `ace:${j.id}:${e}`, membership: asMembership(people.get(e)) })) } } : null }); }
    if (q.deleteAce) { const [, jobId, email] = q.deleteAce.$.id.split(':'); const j = jobs.find((x) => x.id === jobId); j.access = j.access.filter((e) => e !== email); return reply({}); }
    if (q.updateAccount) {
      const { id, name, archive } = q.updateAccount.$;
      const a = accounts.find((x) => x.id === id);
      if (name != null) a.name = name;
      if (archive != null) { assert.equal(q.updateAccount.$.notify, false); a.archived = archive; }
      return reply({});
    }
    if (q.deleteContact) { for (const a of accounts) a.contacts = a.contacts.filter((c) => c.id !== q.deleteContact.$.id); return reply({}); }
    if (q.deleteRole) { const name = Object.keys(ROLES).find((k) => ROLES[k] === q.deleteRole.$.id); assert.ok(![...people.values()].some((m) => m.role === name), `nobody has ${name}`); delete ROLES[name]; return reply({}); }
    if (q.account) {
      const a = accounts.find((x) => x.id === q.account.$.id);
      return reply({ account: a ? { id: a.id, name: a.name, type: a.type || 'vendor', archivedAt: a.archived ? '2026-01-01' : null } : null });
    }
    const out = {};
    for (const [alias, part] of Object.entries(q)) {
      if (part?._ === 'account') {
        const a = accounts.find((x) => x.id === part.$.id);
        const aces = a?.aceList || Array.from({ length: a?.aces || 0 }, () => ({ internal: false, name: 'Someone' }));
        if (part.aces.nodes) { out[alias] = a ? { id: a.id, aces: { nodes: aces.slice(0, part.aces.$.size).map((x) => ({ membership: { isInternal: x.internal, user: { name: x.name } } })) } } : null; continue; }
        out[alias] = a ? { id: a.id, contacts: { count: a.contacts.length }, documents: { count: a.documents || 0 }, files: { count: a.files || 0 }, aces: { count: aces.length } } : null;
        continue;
      }
      if (part?._ !== 'job') continue;
      const j = jobs.find((x) => x.id === part.$.id);
      out[alias] = j ? { id: j.id, aces: { nodes: j.access.map((e) => ({ membership: asMembership(people.get(e)) })) } } : null;
    }
    if (Object.keys(out).length) return reply(out);
    throw new Error(`unexpected query ${JSON.stringify(q).slice(0, 120)}`);
  };
  const kinds = () => calls.map((q) => Object.keys(q).find((k) => k !== '$'));
  return { fetchImpl, calls, people, jobs, accounts, kinds, made };
}

async function world({ kids = [ISLA], partners = [RANDALL, BLYTHE, WYP, ACME], bills = [] } = {}) {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const k of kids) await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(k.slug, k.name, k.year, 'in-progress', JSON.stringify(k)).run();
  for (const p of partners) await DB.prepare('INSERT INTO partners (slug, name, level, category, featured, data) VALUES (?, ?, ?, ?, ?, ?)').bind(p.slug, p.name, 'friend', 'build', 0, JSON.stringify(p)).run();
  // The vendors table's JobTread cache: which JobTread vendors have a bill or order on which job
  await DB.prepare('CREATE TABLE IF NOT EXISTS vendors (id TEXT PRIMARY KEY, name TEXT NOT NULL, jt_id TEXT, facts TEXT)').run();
  for (const b of bills) await DB.prepare('INSERT INTO vendors (id, name, jt_id, facts) VALUES (?, ?, ?, ?)').bind(`v_${b.jtId}`, b.name, b.jtId, JSON.stringify({ jobs: b.jobs.map((jobId) => ({ jobId, order: !!b.order })) })).run();
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

test('a sweep: vendors added quietly with their level or Trade Partner, a page partner gets its JobTread account with nobody in it yet, a near name waits, nobody is emailed', async (t) => {
  _resetRoleCache();
  const sent = noMail(t);
  const DB = await world({ bills: [{ jtId: 'acct-e', name: 'Ace Electric', jobs: ['j1'] }, { jtId: 'acct-store', name: 'Corner Store', jobs: ['j1'] }, { jtId: 'acct-tile', name: 'Tile Depot', jobs: ['j1'] }] });
  await saveContacts(DB, 'randall-brothers', [{ name: 'Ron Randall', email: 'ron@randallbrothers.example', phone: '(404) 555-0100' }]);
  await saveContacts(DB, 'acme-foundation', [{ name: 'Ann Acme', email: 'ann@acmefdn.example' }]);
  const jt = fakeJT({
    jobs: [{ id: 'j1', name: 'Isla Smith (2026)', access: ['mom@example.com'] }, { id: 'j9', name: 'TEST Isla Smith (2026)', access: [] }],
    members: [{ email: 'mom@example.com', name: 'Mom Smith', role: 'Makeover Family' }],
    accounts: [
      { id: 'acct-r', name: 'Randall Brothers', contacts: [] },
      // A sub (JobTread's Trades field says so); its insurance agent is listed first and never goes on the job
      { id: 'acct-e', name: 'Ace Electric', primary: 'c-e', fields: { Trades: ['Electrical'], Documents: 'Requested' },
        contacts: [{ id: 'c-agent', name: 'Al Agent', title: 'Insurance agent', email: 'al@insure.example' }, { id: 'c-e', name: 'Eve Ace', email: 'eve@aceelectric.example' }] },
      // Bought from by card: no trade, W-9 or Documents. And a materials supplier
      { id: 'acct-store', name: 'Corner Store', contacts: [{ id: 'c-s', name: 'Store Desk', email: 'desk@cornerstore.example' }] },
      { id: 'acct-tile', name: 'Tile Depot', fields: { 'Materials only': true, Trades: ['Tile'] }, contacts: [{ id: 'c-t', name: 'Tia Tile', email: 'tia@tiledepot.example' }] },
      { id: 'acctwyp1', name: 'WYP Construction', contacts: [] },
    ],
  });
  const report = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.added.map((a) => `${a.person} (${a.name})`).sort(), ['Eve Ace (Ace Electric)', 'Ron Randall (Randall Brothers)']);
  assert.deepEqual(['ron@randallbrothers.example', 'eve@aceelectric.example'].map((e) => jt.people.get(e).role), ['Friend', 'Trade Partner'], 'a partner’s level, a sub’s Trade Partner');
  for (const email of ['al@insure.example', 'desk@cornerstore.example', 'tia@tiledepot.example']) assert.ok(!jt.jobs[0].access.includes(email), `${email} isn’t put on the job`);
  assert.ok(!jt.jobs[0].access.includes('ann@acmefdn.example'), 'the monetary sponsor is the Sponsor sweep’s');
  assert.deepEqual(jt.jobs[1].access, [], 'a TEST job is left alone');

  // Blythe has no JobTread vendor: it gets one, nobody in it yet (staff don't make vendors in JobTread), and so does every partner, the pages' first.
  // Walk Your Plans has a near one: it waits
  assert.deepEqual(report.made, [{ partner: 'blythe-creative', name: 'Blythe Creative Co.' }, { partner: 'acme-foundation', name: 'Acme Foundation' }]);
  assert.deepEqual(jt.accounts.find((a) => a.name === 'Blythe Creative Co.').contacts, []);
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
  // Randall Brothers' contact went into its JobTread account, in the vendor contact's own fields (the phone as +1 and ten digits)
  assert.deepEqual(jt.accounts.find((a) => a.id === 'acct-r').contacts.map((c) => [c.name, c.email, c.phone]), [['Ron Randall', 'ron@randallbrothers.example', '+14045550100']]);
  // …and Ace Electric isn't a partner, so nothing of it lands in Partners
  assert.deepEqual(Object.keys(await readContacts(DB)).sort(), ['acme-foundation', 'randall-brothers']);
  assert.deepEqual(sent, [], 'no email, from JobTread or the site');
  const audit = (await DB.prepare('SELECT entity_type, changes FROM audit_log ORDER BY id').all()).results;
  assert.deepEqual(audit.map((a) => a.entity_type), ['jobtread-vendor', 'jobtread-access', 'partner-contacts', 'jobtread-roles'], 'accounts made, people on jobs, contacts, then the old roles nobody has deleted');
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

  // An email for Blythe: on the job straight away, and into the JobTread account the first run made
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
  await saveContacts(DB, 'walk-your-plans', [{ name: 'Pat Plans', email: 'pat@walkyourplans.example' }]);
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

test('a vendor contact’s email is read from its own JobTread field, and each partner’s lists are put together afresh once', async (t) => {
  _resetRoleCache();
  noMail(t);
  const DB = await world({ kids: [], partners: [RANDALL] });
  // As the old sweep left it: it read a family's email field, so it saw Rita with no email
  const { ensureSchema } = await import('../functions/api/_vendor-access.js');
  await ensureSchema(DB);
  await DB.prepare("INSERT INTO vendor_accounts (partner, account_id, account_name, how, jt_seen, site_seen, synced_at) VALUES ('randall-brothers', 'acct-r', 'Randall Brothers', 'name', ?, '[]', ?)")
    .bind(JSON.stringify([{ name: 'Rita Randall', email: '', phone: '', title: 'Office' }]), new Date(T0 - 120 * MIN).toISOString()).run();
  // Staff added Ron in Partners since
  await saveContacts(DB, 'randall-brothers', [{ name: 'Ron Randall', email: 'ron@randallbrothers.example' }], { now: T0 - 60 * MIN });
  const jt = fakeJT({ jobs: [], accounts: [{ id: 'acct-r', name: 'Randall Brothers', contacts: [{ id: 'c-rita', name: 'Rita Randall', email: 'rita@randallbrothers.example', title: 'Office' }] }] });
  const r = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  assert.deepEqual(r.problems, []);
  // Both sides changed, and Partners' change is newer: without putting them together afresh, Rita's email would never reach Partners
  assert.deepEqual((await readContacts(DB))['randall-brothers'].map((p) => [p.name, p.email]).sort(), [['Rita Randall', 'rita@randallbrothers.example'], ['Ron Randall', 'ron@randallbrothers.example']]);
  assert.deepEqual(jt.accounts[0].contacts.map((c) => c.email).sort(), ['rita@randallbrothers.example', 'ron@randallbrothers.example']);
  // Once only: then the side that changed wins again
  const again = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.deepEqual(again.contacts, []);
  // An email JobTread has is never blanked by a Partners list without it
  await saveContacts(DB, 'randall-brothers', [{ name: 'Rita Randall', email: '' }, { name: 'Ron Randall', email: 'ron@randallbrothers.example' }], { now: T0 + 20 * MIN });
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 30 * MIN });
  assert.equal(jt.accounts[0].contacts.find((c) => c.name === 'Rita Randall').email, 'rita@randallbrothers.example');
});

const MSI = { slug: 'msi', name: 'Msi', logo: img('partners/msi/1') };
test('a partner on a page with no JobTread vendor gets one, email or not, and a name starting another vendor’s is asked, never made', async (t) => {
  _resetRoleCache();
  noMail(t);
  const DB = await world({ kids: [{ ...ISLA, partnerLogos: [logoOf(MSI), logoOf(BLYTHE)] }], partners: [MSI, BLYTHE] });
  await saveContacts(DB, 'msi', [{ name: 'Mia Stone', email: 'mia@msisurfaces.example' }]);
  const jt = fakeJT({ jobs: [{ id: 'j1', name: 'Isla Smith (2026)', access: [] }], accounts: [{ id: 'acctmsi', name: 'MSI Surfaces', contacts: [{ id: 'c-sam', name: 'Sam', email: 'sam@msisurfaces.example' }] }] });
  const r = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  assert.deepEqual(r.made.map((m) => m.name), ['Blythe Creative Co.'], 'Blythe is made with nobody in it yet; Msi may be MSI Surfaces');
  assert.equal(jt.accounts.length, 2);
  const view = await adminView(DB);
  assert.deepEqual(view.near.map((n) => [n.name, n.near.map((x) => [x.name, x.why])]), [['Msi', [['MSI Surfaces', 'Starts with the name']]]]);
  assert.deepEqual(view.waiting.map((w) => w.name), ['Blythe Creative Co.'], 'Blythe waits for someone to put on the job');
  // An email for Blythe: on the job, and into the account
  await saveContacts(DB, 'blythe-creative', [{ name: 'Bea Blythe', email: 'bea@blythe.example.com' }]);
  const r2 = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.deepEqual(r2.made, [], 'made once');
  assert.deepEqual(r2.added.map((a) => a.person), ['Bea Blythe']);
  assert.deepEqual(jt.accounts.find((a) => a.name === 'Blythe Creative Co.').contacts.map((c) => c.email), ['bea@blythe.example.com']);
});

test('one company twice in JobTread: an empty account is archived and its partner moves, nobody asked; two that hold something, or another kind of organization, are listed', async (t) => {
  _resetRoleCache();
  noMail(t);
  const GPF = { slug: 'georgia-power-foundation', name: 'Georgia Power Foundation', logo: img('partners/gpf/1') };
  const HOPE = { slug: 'hope', name: 'Hope', logo: img('partners/hope/1') };
  const SUM = { slug: 'summit', name: 'Summit', website: 'https://summitroofing.example', logo: img('partners/summit/1') };
  const DB = await world({ kids: [], partners: [MSI, GPF, HOPE, SUM] });
  await saveContacts(DB, 'msi', [{ name: 'Mia Stone', email: 'mia@msisurfaces.example' }]);
  const { ensureSchema } = await import('../functions/api/_vendor-access.js');
  await ensureSchema(DB);
  // Accounts the old sweep made, empty, while staff made the real ones
  for (const [slug, id, name] of [['msi', 'acctmsimade', 'Msi'], ['georgia-power-foundation', 'acctgpf', 'Georgia Power Foundation'], ['hope', 'accthope', 'Hope'], ['summit', 'acctsummade', 'Summit']]) {
    await DB.prepare("INSERT INTO vendor_accounts (partner, account_id, account_name, how, made_at) VALUES (?, ?, ?, 'made', '2026-10-20T14:35:00Z')").bind(slug, id, name).run();
  }
  const old = '2026-10-20T14:35:00Z';
  const jt = fakeJT({ jobs: [], accounts: [
    // Made by the site: its one access entry is SOARD's own JobTread user (live, Oct 30: "Msi" and "Pella"), so it's empty still
    { id: 'acctmsimade', name: 'Msi', createdAt: old, contacts: [], aceList: [{ internal: true, name: 'SOARD Site' }] },
    { id: 'acctmsi', name: 'MSI Surfaces', createdAt: '2026-10-16T12:00:00Z', contacts: [{ id: 'c-sam', name: 'Sam', email: 'sam@msisurfaces.example' }] },
    // Both hold something: listed, nothing moved
    { id: 'acctp1', name: 'Pella', contacts: [{ id: 'c-p', name: 'Pat', email: 'pat@pella.example' }] },
    { id: 'acctp2', name: 'Pella Windows and Doors of Georgia', documents: 2, contacts: [] },
    // Made 10 minutes ago: someone may still be setting it up
    { id: 'acctae', name: 'Ace Electric', contacts: [{ id: 'c-e', name: 'Eve', email: 'eve@aceelectric.example' }] },
    { id: 'acctae2', name: 'Ace Electric LLC', createdAt: new Date(T0 - 10 * MIN).toISOString(), contacts: [] },
    // The foundation isn't the utility, and a church isn't just "Hope": staff say
    { id: 'acctgpf', name: 'Georgia Power Foundation', createdAt: old, contacts: [] },
    { id: 'acctgp', name: 'Georgia Power', documents: 3, contacts: [] },
    { id: 'accthope', name: 'Hope', createdAt: old, contacts: [] },
    { id: 'accthc', name: 'Hope Church', files: 1, contacts: [] },
    // A partner whose website isn't the other company's emails: staff say
    { id: 'acctsummade', name: 'Summit', createdAt: old, contacts: [] },
    { id: 'acctse', name: 'Summit Electric', contacts: [{ id: 'c-g', name: 'Gil', email: 'gil@summitelectric.example' }] },
    // A place isn't a company, and a name that only ends with another's isn't it (live, Oct 30: "Atlanta" took Blu Site Solutions of Atlanta)
    { id: 'acctatl', name: 'Atlanta', documents: 1, contacts: [] },
    { id: 'acctblu', name: 'Blu Site Solutions of Atlanta', createdAt: old, contacts: [] },
    { id: 'acctsca', name: 'Suspended Ceilings Atlanta', files: 2, contacts: [] },
    { id: 'acctagl', name: 'Atlanta Gas Light', createdAt: old, contacts: [] },
    // Two empty ones nobody goes by: the newer goes
    { id: 'acctb1', name: 'Bin There', createdAt: '2025-01-05T00:00:00Z', contacts: [] },
    { id: 'acctb2', name: 'Bin There Dumpsters', createdAt: '2025-09-05T00:00:00Z', contacts: [] },
  ] });
  t.mock.method(globalThis, 'fetch', jt.fetchImpl);
  const acct = (id) => jt.accounts.find((a) => a.id === id);
  const r = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.combined.map((c) => [c.archived, c.kept, c.partner]).sort(), [['Bin There Dumpsters', 'Bin There', null], ['Msi', 'MSI Surfaces', 'Msi']]);
  assert.deepEqual(jt.accounts.filter((a) => a.archived).map((a) => a.id).sort(), ['acctb2', 'acctmsimade']);
  const view = await adminView(DB);
  assert.deepEqual(view.matched.find((m) => m.partner === 'msi').accountName, 'MSI Surfaces', 'the partner moved to the account staff made');
  assert.deepEqual(view.twins.map((x) => [x.a.name, x.b.name, x.why, x.canCombine]).sort(), [
    ['Georgia Power Foundation', 'Georgia Power', 'check', true], ['Hope', 'Hope Church', 'check', true], ['Pella', 'Pella Windows and Doors of Georgia', 'full', false], ['Summit', 'Summit Electric', 'check', true],
  ]);
  assert.deepEqual(view.twins.find((x) => x.why === 'full').b.holds, { contacts: 0, documents: 2, files: 0, access: 0, bills: 0 });
  assert.deepEqual(view.combined.map((c) => c.drop.name).sort(), ['Bin There Dumpsters', 'Msi']);
  assert.deepEqual(JSON.parse((await DB.prepare("SELECT value FROM vendor_access_state WHERE key = 'combined'").first()).value)['acctmsi acctmsimade'].staff, ['SOARD Site'], 'whose access it had, kept');
  // The two lists came together on the account the partner moved to
  assert.deepEqual((await readContacts(DB)).msi.map((p) => p.name).sort(), ['Mia Stone', 'Sam']);
  assert.deepEqual(acct('acctmsi').contacts.map((c) => c.name).sort(), ['Mia Stone', 'Sam']);
  const log = (await DB.prepare("SELECT changes FROM audit_log WHERE entity_name = 'One company twice in JobTread'").first()).changes;
  assert.match(log, /Msi \(the same as MSI Surfaces\)/);
  assert.doesNotMatch(log, /@/);

  const req = (body) => ({ env: env(DB), data: { userEmail: 'staff@example.org' }, request: new Request('https://x/api/vendor-access-admin', { method: 'POST', body: JSON.stringify(body) }) });
  // Not the same: never listed again
  const gp = await (await onRequestPost(req({ twins: { a: 'acctgpf', b: 'acctgp', same: false } }))).json();
  assert.ok(gp.success, gp.error);
  assert.deepEqual(gp.view.twins.map((x) => x.a.name).sort(), ['Hope', 'Pella', 'Summit']);
  // Same company: the empty one goes, and its partner moves
  const hope = await (await onRequestPost(req({ twins: { a: 'accthc', b: 'accthope', same: true } }))).json();
  assert.ok(hope.success, hope.error);
  assert.equal(acct('accthope').archived, true);
  assert.equal(hope.view.matched.find((m) => m.partner === 'hope').accountName, 'Hope Church');
  // Two that both hold something can't be put together here
  const pella = await (await onRequestPost(req({ twins: { a: 'acctp1', b: 'acctp2', same: true } }))).json();
  assert.match(pella.error, /both have something in them/);
  // Not the same, for one the site archived: it's back, with its partner
  const back = await (await onRequestPost(req({ twins: { a: 'acctmsimade', b: 'acctmsi', same: false } }))).json();
  assert.ok(back.success, back.error);
  assert.equal(acct('acctmsimade').archived, false);
  assert.equal(back.view.matched.find((m) => m.partner === 'msi').accountName, 'Msi');

  const r2 = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.deepEqual(r2.combined, [], 'nothing staff said no to is put together again');
  assert.equal(acct('acctmsimade').archived, false);
  assert.deepEqual((await adminView(DB)).twins.map((x) => x.a.name).sort(), ['Pella', 'Summit']);
  assert.equal(acct('acctae2').archived, undefined, 'one made in the last hour stays');
  // An hour on, it's empty still: it goes
  const r3 = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 60 * MIN });
  assert.deepEqual(r3.combined.map((c) => c.archived), ['Ace Electric LLC']);
  assert.equal((await onRequestPost(req({ twins: { a: 'acctp1', b: 'acctp1' } }))).status, 400);
});

test('one name for another: it starts with every word of the other, in order, and a place alone is no company', () => {
  for (const [a, b] of [['Msi', 'MSI Surfaces'], ['Pella', 'Pella Windows and Doors of Georgia'], ['Bin There Dump That', 'Bin There Dump That East ATL'],
    ['Sherwin-Williams', 'Sherwin Williams - Lawrenceville'], ['Home Depot', 'The Home Depot'], ['ServiceWise', 'ServiceWise Electric, LLC']]) assert.ok(sameWords(a, b), `${a} / ${b}`);
  for (const [a, b] of [['Atlanta', 'Blu Site Solutions of Atlanta'], ['Atlanta', 'Suspended Ceilings Atlanta'], ['Atlanta', 'Atlanta Gas Light'],
    ['Georgia', 'Georgia Power'], ['Surfaces', 'MSI Surfaces'], ['Electric', 'Ace Electric']]) assert.ok(!sameWords(a, b), `${a} / ${b}`);
});

test('every partner gets its JobTread vendor, on a page or not: the pages’ first, 25 a run, a near name asked', async (t) => {
  _resetRoleCache();
  noMail(t);
  const many = Array.from({ length: 30 }, (_, i) => ({ slug: `donor-${i + 1}`, name: `Donor Number ${String(i + 1).padStart(2, '0')}`, logo: img(`partners/donor-${i + 1}/1`) }));
  const GPC = { slug: 'gp-company', name: 'Georgia Pacific', logo: img('partners/gpc/1') };
  // JobTread has a vendor called only "Atlanta" (live, Oct 30): never offered as the same as Atlanta Falcons
  const FALCONS = { slug: 'atlanta-falcons', name: 'Atlanta Falcons', logo: img('partners/falcons/1') };
  const DB = await world({ kids: [{ ...ISLA, partnerLogos: [logoOf(BLYTHE)] }], partners: [...many, GPC, FALCONS, BLYTHE] });
  const jt = fakeJT({ jobs: [{ id: 'j1', name: 'Isla Smith (2026)', access: [] }], accounts: [{ id: 'acctgp1', name: 'Georgia Pacific Gypsum', contacts: [] }, { id: 'acctatl9', name: 'Atlanta', documents: 1, contacts: [] }] });
  const r = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  assert.deepEqual(r.problems, []);
  assert.equal(r.made.length, 25);
  assert.equal(r.made[0].name, 'Blythe Creative Co.', 'the one on a page first');
  assert.equal(r.more, true);
  assert.deepEqual((await adminView(DB)).near.map((n) => [n.name, n.near.map((x) => x.name)]), [['Georgia Pacific', ['Georgia Pacific Gypsum']]], 'a name JobTread starts another with is asked, never made');
  const r2 = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.equal(r2.made.length, 7);
  assert.ok(r2.made.some((m) => m.name === 'Atlanta Falcons'), 'made, not asked about “Atlanta”');
  assert.equal(new Set(jt.accounts.map((a) => a.name)).size, jt.accounts.length, 'each made once');
  assert.equal(jt.accounts.length, 2 + 32);
  const r3 = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 30 * MIN });
  assert.deepEqual(r3.made, []);
  // A partner added since: made when staff act on it, before the next full run
  await DB.prepare('INSERT INTO partners (slug, name, level, category, featured, data) VALUES (?, ?, ?, ?, ?, ?)').bind('roswell-firelabs', 'Roswell Firelabs', 'friend', 'build', 0, JSON.stringify({ slug: 'roswell-firelabs', name: 'Roswell Firelabs' })).run();
  const one = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 35 * MIN, only: 'roswellfirelabs' });
  assert.deepEqual(one.made.map((m) => m.name), ['Roswell Firelabs']);
});

test('“Same as a partner” for someone’s JobTread company: any vendor account can be a partner, and the empty one the site had made goes', async (t) => {
  _resetRoleCache();
  noMail(t);
  const MEANS = { slug: 'angela-means-design', name: 'Angela Means Design', logo: img('partners/means/1') };
  const CHATT = { slug: 'chattahoochee-tech-design-program', name: 'Chattahoochee Tech Design Program', logo: img('partners/chatt/1') };
  const DB = await world({ kids: [], partners: [MEANS, CHATT, RANDALL] });
  const { ensureSchema } = await import('../functions/api/_vendor-access.js');
  await ensureSchema(DB);
  await DB.prepare("INSERT INTO vendor_accounts (partner, account_id, account_name, how, made_at) VALUES (?, 'acctctmade', ?, 'made', '2026-10-20T14:35:00Z')").bind(CHATT.slug, CHATT.name).run();
  await DB.prepare("INSERT INTO vendor_accounts (partner, account_id, account_name, how) VALUES ('randall-brothers', 'acctrb', 'Randall Brothers', 'name')").run();
  const jt = fakeJT({
    jobs: [],
    members: [{ email: 'angela@meansinteriors.example', name: 'Angela Means', role: 'Vendor', account: { id: 'acctmeans', name: 'Means Interiors', type: 'vendor' } }],
    accounts: [
      { id: 'acctctmade', name: CHATT.name, createdAt: '2026-10-20T14:35:00Z', contacts: [], aceList: [{ internal: true, name: 'SOARD Site' }] },
      { id: 'acctctc', name: 'Chattahoochee Technical College', contacts: [{ id: 'c-ab', name: 'Abigail', email: 'abigail@chattahoocheetech.example' }] },
      { id: 'acctmeans', name: 'Means Interiors', contacts: [] },
      { id: 'acctmc', name: 'Means & Carney Interiors', contacts: [] },
      { id: 'acctrb', name: 'Randall Brothers', contacts: [] },
      { id: 'acctgone', name: 'Old Vendor', archived: true, contacts: [] },
    ],
  });
  t.mock.method(globalThis, 'fetch', jt.fetchImpl);
  const acct = (id) => jt.accounts.find((a) => a.id === id);
  const req = (body) => ({ env: env(DB), data: { userEmail: 'staff@example.org' }, request: new Request('https://x/api/vendor-access-admin', { method: 'POST', body: JSON.stringify(body) }) });
  const link = async (partner, account) => (await onRequestPost(req({ link: { partner, account } }))).json();

  // A partner with no JobTread vendor yet, by another name
  const means = await link(MEANS.slug, 'acctmeans');
  assert.ok(means.success, means.error);
  assert.deepEqual(means.linked, { partner: MEANS.slug, name: MEANS.name, account: { id: 'acctmeans', name: 'Means Interiors' }, archived: null });
  assert.deepEqual(means.view.matched.find((m) => m.partner === MEANS.slug), { partner: MEANS.slug, name: MEANS.name, account: 'acctmeans', accountName: 'Means Interiors', how: 'linked' });
  const links = JSON.parse((await DB.prepare("SELECT value FROM kid_partner_state WHERE key = 'links'").first()).value);
  assert.equal(links.meansinteriors, MEANS.slug, 'its logos and its people go by it too');
  assert.equal(acct('acctmc').archived, undefined, 'the other Means is left alone');

  // One the site made an empty account for: that one goes (SOARD's own access entry aside), and the partner is the college
  const chatt = await link(CHATT.slug, 'acctctc');
  assert.ok(chatt.success, chatt.error);
  assert.equal(chatt.linked.archived, CHATT.name);
  assert.equal(acct('acctctmade').archived, true);
  assert.equal(chatt.view.matched.find((m) => m.partner === CHATT.slug).accountName, 'Chattahoochee Technical College');
  assert.deepEqual(chatt.view.combined.map((c) => [c.drop.name, c.keep.name]), [[CHATT.name, 'Chattahoochee Technical College']]);
  assert.deepEqual((await readContacts(DB))[CHATT.slug].map((p) => p.name), ['Abigail'], 'the college’s contact reaches Partners');
  const log = (await DB.prepare("SELECT changes FROM audit_log WHERE entity_slug = ? AND entity_name = 'Same as a JobTread vendor'").bind(CHATT.slug).first()).changes;
  assert.match(log, /Chattahoochee Technical College/);

  // Not what staff can link: another partner's vendor, an archived one, or none at all
  assert.match((await link(MEANS.slug, 'acctrb')).error, /Randall Brothers is Randall Brothers in Partners already/);
  assert.match((await link(MEANS.slug, 'acctgone')).error, /archived/);
  assert.match((await link(MEANS.slug, 'acctnone99')).error, /no vendor by that id/);
  assert.equal((await onRequestPost(req({ link: { partner: '../x', account: 'acctctc' } }))).status, 400);
  // The same again changes nothing
  assert.equal((await link(CHATT.slug, 'acctctc')).linked.archived, null);

  // "Not the same" on the archived one takes it all back
  const back = await (await onRequestPost(req({ twins: { a: 'acctctmade', b: 'acctctc', same: false } }))).json();
  assert.ok(back.success, back.error);
  assert.equal(acct('acctctmade').archived, false);
  assert.equal(back.view.matched.find((m) => m.partner === CHATT.slug).accountName, CHATT.name);
});

test('pairs: one staff said is “Not the same” never pairs again, by a saved pair, a link or the same name', () => {
  const accounts = [{ id: 'a1', name: 'Walk Your Plans', contacts: [] }, { id: 'a2', name: 'WYP Construction', contacts: [] }];
  const notSame = { 'walk-your-plans': { a1: { name: 'Walk Your Plans' } } };
  assert.equal(pairAccounts([WYP], accounts).get('walk-your-plans').id, 'a1', 'the same name, before');
  assert.equal(pairAccounts([WYP], accounts, { notSame }).get('walk-your-plans'), undefined);
  assert.equal(pairAccounts([WYP], accounts, { saved: { 'walk-your-plans': 'a1' }, links: { walkyourplans: 'walk-your-plans' }, notSame }).get('walk-your-plans'), undefined);
  assert.equal(pairAccounts([WYP], accounts, { links: { wypconstruction: 'walk-your-plans' }, notSame }).get('walk-your-plans').id, 'a2', 'another one still can');
});

test('“Not the same”: what the wrong match did is taken back, it waits for staff, and “Same as … after all” puts it back', async (t) => {
  _resetRoleCache();
  noMail(t);
  const DB = await world({ kids: [{ ...ISLA, partnerLogos: [logoOf(WYP)] }], partners: [WYP] });
  await saveContacts(DB, 'walk-your-plans', [{ name: 'Pat Plans', email: 'pat@walkyourplans.example' }]);
  // JobTread has another company by the same name; the real one is WYP Construction
  const jt = fakeJT({
    jobs: [{ id: 'j1', name: 'Isla Smith (2026)', access: [] }],
    accounts: [{ id: 'acctother1', name: 'Walk Your Plans', primary: 'c-o', contacts: [{ id: 'c-o', name: 'Otto', email: 'otto@other.example' }] }, { id: 'acctwyp1', name: 'WYP Construction', primary: 'c-w', contacts: [{ id: 'c-w', name: 'Walt', email: 'walt@wypconstruction.example' }] }],
  });
  t.mock.method(globalThis, 'fetch', jt.fetchImpl);
  const other = () => jt.accounts.find((a) => a.id === 'acctother1');
  const wyp = () => jt.accounts.find((a) => a.id === 'acctwyp1');
  const partnersPeople = async () => ((await readContacts(DB))['walk-your-plans'] || []).map((p) => p.name).sort();
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  const req = (body) => ({ env: env(DB), data: { userEmail: 'staff@example.org' }, request: new Request('https://x/api/vendor-access-admin', { method: 'POST', body: JSON.stringify(body) }) });
  const first = await adminView(DB);
  assert.deepEqual(first.matched, [{ partner: 'walk-your-plans', name: 'Walk Your Plans', account: 'acctother1', accountName: 'Walk Your Plans', how: 'name' }]);
  assert.ok(!JSON.stringify(first.matched).includes('@'), 'names and ids only');
  // The wrong match did three things: Otto on Isla's job, Otto in Partners, Pat in the other company's JobTread
  assert.deepEqual(jt.jobs[0].access, ['otto@other.example']);
  assert.deepEqual(await partnersPeople(), ['Otto', 'Pat Plans']);
  assert.deepEqual(other().contacts.map((c) => c.name).sort(), ['Otto', 'Pat Plans']);

  const un = await (await onRequestPost(req({ unmatch: { partner: 'walk-your-plans' } }))).json();
  assert.ok(un.success, un.error);
  assert.deepEqual([un.unmatched.offJobs.map((o) => o.person), un.unmatched.fromPartners, un.unmatched.fromJobTread, un.unmatched.untracked], [['Otto'], ['Otto'], ['Pat Plans'], false]);
  assert.deepEqual(jt.jobs[0].access.filter((e) => e === 'otto@other.example'), [], 'Otto is off the job');
  assert.deepEqual(await partnersPeople(), ['Pat Plans'], 'staff’s own person stays in Partners');
  assert.deepEqual(other().contacts.map((c) => c.name), ['Otto'], 'their JobTread vendor keeps its own');
  assert.deepEqual(un.view.matched, []);
  assert.deepEqual(un.view.near.map((n) => [n.name, n.was.map((x) => x.name), n.near.map((x) => x.name)]), [['Walk Your Plans', ['Walk Your Plans'], ['WYP Construction']]], 'it asks again, with the near name');
  assert.deepEqual(un.report.made, [], 'no account made by itself');
  assert.deepEqual(un.report.added.map((a) => a.person), ['Pat Plans'], 'their own person goes on the job instead, straight away');
  const log = (await DB.prepare("SELECT changes FROM audit_log WHERE entity_name = 'Not the same as a JobTread vendor'").first()).changes;
  assert.ok(!log.includes('@'), 'the log has names, not emails');
  // A run that was mid-way wrote the pair back: the next one drops it, and still makes nothing
  await DB.prepare("INSERT INTO vendor_accounts (partner, account_id, account_name, how) VALUES ('walk-your-plans', 'acctother1', 'Walk Your Plans', 'name')").run();
  const r2 = await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.deepEqual(r2.made, []);
  assert.deepEqual((await adminView(DB)).matched, []);
  assert.equal((await adminView(DB)).near.length, 1, 'still waiting for staff');
  assert.ok(!jt.jobs[0].access.includes('otto@other.example'), 'and Otto isn’t put back');

  // The right one: WYP Construction
  const same = await (await onRequestPost(req({ settle: { partner: 'walk-your-plans', account: 'acctwyp1' } }))).json();
  assert.ok(same.success, same.error);
  assert.deepEqual(same.view.matched.map((m) => [m.accountName, m.how]), [['WYP Construction', 'linked']]);
  assert.deepEqual(same.report.added, [], 'Pat is on the job already');
  assert.deepEqual(await partnersPeople(), ['Pat Plans', 'Walt'], 'and the contacts come together');
  // Not the same again, for a pair synced before the site kept track: nothing it can't tell apart is touched
  await DB.prepare("DELETE FROM vendor_access_state WHERE key = 'copied'").run();
  const un2 = await (await onRequestPost(req({ unmatch: { partner: 'walk-your-plans' } }))).json();
  assert.ok(un2.success, un2.error);
  assert.deepEqual([un2.unmatched.offJobs, un2.unmatched.fromPartners, un2.unmatched.untracked], [[], [], true]);
  assert.deepEqual(await partnersPeople(), ['Pat Plans', 'Walt']);
  const links = JSON.parse((await DB.prepare("SELECT value FROM kid_partner_state WHERE key = 'links'").first()).value);
  assert.equal(links.wypconstruction, undefined, 'the “Same as” link logos and sponsors use goes too');
  // Same as WYP Construction after all
  const near = (await adminView(DB)).near[0];
  assert.deepEqual(near.was.map((x) => x.id).sort(), ['acctother1', 'acctwyp1'], 'both it was told aren’t it');
  const after = await (await onRequestPost(req({ settle: { partner: 'walk-your-plans', account: 'acctwyp1' } }))).json();
  assert.ok(after.success, after.error);
  assert.deepEqual(after.view.matched.map((m) => m.accountName), ['WYP Construction']);
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 30 * MIN });
  assert.deepEqual((await adminView(DB)).matched.map((m) => m.accountName), ['WYP Construction'], 'and it holds');
  assert.ok(wyp().contacts.some((c) => c.name === 'Pat Plans'));

  assert.equal((await onRequestPost(req({ unmatch: { partner: 'nobody-here' } }))).status, 404);
  assert.equal((await onRequestPost(req({ unmatch: { partner: '../x' } }))).status, 400);
});

test('a wrong name in JobTread: the vendor takes the Partners name, staff pressing it, and Undo gives the old one back', async (t) => {
  _resetRoleCache();
  noMail(t);
  const DB = await world({ kids: [{ ...ISLA, partnerLogos: [logoOf(RANDALL)] }], partners: [RANDALL] });
  const jt = fakeJT({ jobs: [{ id: 'j1', name: 'Isla Smith (2026)', access: [] }], accounts: [{ id: 'acctrb01', name: 'Randall Bros', contacts: [] }] });
  t.mock.method(globalThis, 'fetch', jt.fetchImpl);
  await DB.prepare("CREATE TABLE IF NOT EXISTS kid_partner_state (key TEXT PRIMARY KEY, value TEXT)").run();
  await DB.prepare("INSERT OR REPLACE INTO kid_partner_state (key, value) VALUES ('links', ?)").bind(JSON.stringify({ randallbros: 'randall-brothers' })).run();
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  assert.deepEqual((await adminView(DB)).matched.map((m) => [m.name, m.accountName]), [['Randall Brothers', 'Randall Bros']]);
  assert.ok(!jt.kinds().includes('updateAccount'), 'the sweep never renames');
  const req = (body) => ({ env: env(DB), data: { userEmail: 'staff@example.org' }, request: new Request('https://x/api/vendor-access-admin', { method: 'POST', body: JSON.stringify(body) }) });

  const r = await (await onRequestPost(req({ rename: { partner: 'randall-brothers' } }))).json();
  assert.ok(r.success, r.error);
  assert.deepEqual([r.renamed.from, r.renamed.to], ['Randall Bros', 'Randall Brothers']);
  assert.equal(jt.accounts[0].name, 'Randall Brothers');
  assert.deepEqual(r.view.matched.map((m) => m.accountName), ['Randall Brothers']);
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.deepEqual((await adminView(DB)).matched.map((m) => [m.account, m.accountName]), [['acctrb01', 'Randall Brothers']], 'still paired after');
  const log = (await DB.prepare("SELECT entity_name, changes FROM audit_log WHERE entity_type = 'jobtread-vendor'").all()).results;
  assert.deepEqual(log.map((l) => l.entity_name), ['Renamed in JobTread']);

  const undo = await (await onRequestPost(req({ rename: { partner: 'randall-brothers', name: 'Randall Bros' } }))).json();
  assert.ok(undo.success, undo.error);
  assert.equal(jt.accounts[0].name, 'Randall Bros');
  assert.equal((await (await onRequestPost(req({ rename: { partner: 'randall-brothers', name: '  ' } }))).json()).error, 'Bad name');
  assert.equal((await onRequestPost(req({ rename: { partner: 'nobody-here' } }))).status, 404);
});

test('Unlink in “JobTread, no logo” undoes the vendor match its link made', async (t) => {
  _resetRoleCache();
  noMail(t);
  const DB = await world({ kids: [{ ...ISLA, partnerLogos: [logoOf(WYP)] }], partners: [WYP] });
  const jt = fakeJT({ jobs: [{ id: 'j1', name: 'Isla Smith (2026)', access: [] }], accounts: [{ id: 'acctwyp1', name: 'WYP Construction', contacts: [] }] });
  t.mock.method(globalThis, 'fetch', jt.fetchImpl);
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 });
  await onRequestPost({ env: env(DB), data: {}, request: new Request('https://x', { method: 'POST', body: JSON.stringify({ settle: { partner: 'walk-your-plans', account: 'acctwyp1' } }) }) });
  assert.equal((await adminView(DB)).matched.length, 1);
  const res = await logoAdminPost({ env: env(DB), data: { userEmail: 'staff@example.org' }, request: new Request('https://x/api/kid-partners-admin', { method: 'POST', body: JSON.stringify({ unlink: { company: 'wypconstruction' } }) }) });
  assert.ok((await res.json()).success);
  assert.deepEqual((await adminView(DB)).matched, []);
  await syncVendorAccess(env(DB), { fetchImpl: jt.fetchImpl, now: T0 + 15 * MIN });
  assert.deepEqual((await adminView(DB)).matched, [], 'not paired back by the next run');
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
