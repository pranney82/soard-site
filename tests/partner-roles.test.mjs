/**
 * JobTread roles that follow Partners levels (functions/api/_partner-roles.js):
 * reading SOARD's roles, their kind and permissions, and who has each.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRoles } from '../functions/api/_partner-roles.js';
import { onRequestGet } from '../functions/api/partner-roles-admin.js';

const ROLES = [
  { id: 'r-vendor', name: 'Vendor', type: 'vendor', permissions: ['readJobs', 'readFiles'], createdAt: '2024-01-01T00:00:00Z' },
  { id: 'r-sponsor', name: 'Sponsor', type: 'customer', permissions: ['readJobs'], createdAt: '2026-10-28T00:00:00Z' },
  { id: 'r-admin', name: 'Admin', type: 'internal', permissions: ['all'], createdAt: '2023-01-01T00:00:00Z' },
];
const MEMBERS = [
  ...Array.from({ length: 130 }, (_, i) => ({ isInternal: false, role: { id: 'r-vendor' }, account: i % 2 ? { type: 'vendor' } : null })),
  { isInternal: false, role: { id: 'r-sponsor' }, account: { type: 'customer' } },
  { isInternal: true, role: { id: 'r-admin' }, account: null },
  { isInternal: false, role: null, account: null },
];

function fakeJT() {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const q = JSON.parse(init.body).query;
    calls.push(q);
    const org = q.organization;
    if (org.roles) return Response.json({ organization: { roles: { nodes: ROLES } } });
    const page = Number(org.memberships.$.page || 0);
    const size = org.memberships.$.size;
    const nodes = MEMBERS.slice(page * size, (page + 1) * size);
    return Response.json({ organization: { memberships: { nodes, nextPage: (page + 1) * size < MEMBERS.length ? String(page + 1) : null } } });
  };
  return { calls, fetchImpl };
}

test('reads every role with its kind, permissions and who has it, across pages', async () => {
  const jt = fakeJT();
  const out = await readRoles({ JOBTREAD_GRANT_KEY: 'k' }, { fetchImpl: jt.fetchImpl });
  assert.equal(out.members, 133);
  assert.equal(out.noRole, 1);
  const by = Object.fromEntries(out.roles.map((r) => [r.name, r]));
  assert.deepEqual(by.Vendor, { id: 'r-vendor', name: 'Vendor', type: 'vendor', permissions: ['readFiles', 'readJobs'], createdAt: '2024-01-01T00:00:00Z', members: 130, internal: 0, accounts: { vendor: 65, customer: 0, none: 65 } });
  assert.equal(by.Sponsor.type, 'customer');
  assert.deepEqual(by.Sponsor.accounts, { vendor: 0, customer: 1, none: 0 });
  assert.equal(by.Admin.internal, 1);
  assert.equal(out.roles[0].name, 'Vendor', 'most people first');
  // Reads only: no names or emails asked for, nothing written
  for (const q of jt.calls) {
    assert.ok(q.organization, 'every call is a read');
    assert.ok(!JSON.stringify(q).includes('emailAddress'));
  }
});

test('the admin GET answers the roles, and says when JobTread isn’t connected', async () => {
  const jt = fakeJT();
  const realFetch = globalThis.fetch;
  globalThis.fetch = jt.fetchImpl;
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  try {
    const res = await onRequestGet({ env: { DB, JOBTREAD_GRANT_KEY: 'k' } });
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.roles.length, 3);
    assert.equal(body.view.on, false, 'and what the sweep would do, off until switched on');
  } finally { globalThis.fetch = realFetch; }
  const off = await onRequestGet({ env: { DB } });
  assert.equal(off.status, 500);
  assert.match((await off.json()).error, /isn’t connected/);
});

// ── Roles that follow levels ─────────────────────────────────────────
import { createD1 } from './lib/d1-shim.mjs';
import {
  planRoles, placePerson, reconcileRoles, rolesView, setOn, putBack, pickRole, roleMode, _resetEnsured, TRADE_ROLE, isPartnerRole,
} from '../functions/api/_partner-roles.js';
import { _resetRoleCache } from '../functions/api/_jt-access.js';
import { isTradeVendor, vendorFacts } from '../functions/api/_vendor-access.js';
import { guestGroups } from '../functions/api/_reveal-invites.js';
import { sponsorGuests } from '../functions/api/_demo-invites.js';

const RANDALL = { slug: 'randall-brothers', name: 'Randall Brothers', level: 'champion', website: 'https://randallbrothers.example' };
const BLYTHE = { slug: 'blythe-creative', name: 'Blythe Creative Co.', level: 'builder', website: '' };
const ACME = { slug: 'acme-foundation', name: 'Acme Foundation', level: 'signature', website: 'https://acmefdn.example' };
const ctxOf = () => ({
  bySlug: new Map([RANDALL, BLYTHE, ACME].map((p) => [p.slug, p])),
  accountPartner: new Map([['acct-r', 'randall-brothers']]),
  contactPartner: new Map([['bea@blythe.example', 'blythe-creative']]),
  links: {}, freeMail: new Set(['gmail.com']),
  trade: (id) => id === 'acct-tko',
});
const login = (id, role, { name = id, email = `${id}@x.example`, account = null } = {}) => ({ id, role, name, email, account });
const vendorAcct = (id, name) => ({ id, name, type: 'vendor' });

test('who gets which role: a partner its level, a sub Trade Partner; staff, families, photographers and the board never change', () => {
  const ctx = ctxOf();
  const people = [
    login('m1', 'Vendor', { name: 'Ron', account: vendorAcct('acct-r', 'Randall Bros') }),          // matched vendor account → Champion
    login('m2', 'Vendor', { name: 'Bea', email: 'bea@blythe.example' }),                             // a partner contact's email → Builder
    login('m3', 'Monetary Sponsor', { name: 'Ann', email: 'ann@acmefdn.example', account: { id: 'c1', name: 'Ann Smith', type: 'customer' } }), // website domain → Signature
    login('m4', 'Vendor', { name: 'Tia', account: vendorAcct('acct-tko', 'TKO Plumbing') }),         // a sub not in Partners → Trade Partner
    login('m5', 'Vendor', { name: 'Gus', email: 'gus@gmail.com', account: vendorAcct('acct-x', 'Mystery Co') }), // can't tell
    login('m6', 'Champion', { name: 'Cal', account: vendorAcct('acct-y', 'Not In Partners') }),      // a level by hand, not in Partners
    login('m7', 'Makeover Family', { name: 'Mom', email: 'mom@randallbrothers.example' }),
    login('m8', 'Photographer', { name: 'Pia', email: 'pia@randallbrothers.example' }),
    login('m9', 'Board Member', { name: 'Bo', email: 'bo@acmefdn.example' }),
    login('m10', 'Champion', { name: 'Rae', account: vendorAcct('acct-r', 'Randall Bros') }),       // already right
  ];
  const { changes, unplaced } = planRoles(people, { place: (m) => placePerson(m, ctx), bySlug: ctx.bySlug });
  assert.deepEqual(changes.map((c) => [c.name, c.from, c.to, c.why]), [
    ['Ron', 'Vendor', 'Champion', 'level'],
    ['Bea', 'Vendor', 'Builder', 'level'],
    ['Ann', 'Monetary Sponsor', 'Signature', 'level'],
    ['Tia', 'Vendor', 'Trade Partner', 'trade'],
  ]);
  assert.equal(changes[0].company, 'Randall Brothers', 'named as in Partners');
  assert.deepEqual(unplaced.map((u) => [u.name, u.company, u.role, u.why]), [['Gus', 'Mystery Co', 'Vendor', 'unknown'], ['Cal', 'Not In Partners', 'Champion', 'level']]);
  for (const r of ['Makeover Family', 'Photographer', 'Board Member', 'Admin', 'Designer', 'Design Partner', 'Automation Support']) assert.ok(!isPartnerRole(r), `${r} is never touched`);

  // A role changed by hand in JobTread is set back; staff's say holds
  const again = planRoles([login('m1', 'Vendor', { name: 'Ron', account: vendorAcct('acct-r', 'Randall Bros') }), login('m5', 'Vendor', { name: 'Gus', account: vendorAcct('acct-x', 'Mystery Co') }), login('m6', 'Champion', { name: 'Cal' })],
    { place: (m) => placePerson(m, ctx), bySlug: ctx.bySlug, setTo: { m1: 'Champion' }, picks: { m5: { role: TRADE_ROLE }, m6: { keep: true } } });
  assert.deepEqual(again.changes.map((c) => [c.name, c.to, c.why]), [['Ron', 'Champion', 'set back'], ['Gus', 'Trade Partner', 'staff']]);
  assert.deepEqual(again.unplaced, []);
});

test('a sub is what JobTread’s vendor fields say; a card store or a materials supplier never is', () => {
  const facts = (o) => ({ facts: vendorFacts(Object.entries(o).map(([name, value]) => ({ value, customField: { name } }))) });
  assert.equal(isTradeVendor(facts({})), false, 'Amazon: nothing set');
  assert.equal(isTradeVendor(facts({}), { order: true }), true, 'a purchase order');
  assert.equal(isTradeVendor(facts({ Trades: ['Plumbing'] })), true);
  assert.equal(isTradeVendor(facts({ Trades: '["Materials and supplies"]' })), false, 'only supplies');
  assert.equal(isTradeVendor(facts({ 'W-9': 'true' })), true);
  assert.equal(isTradeVendor(facts({ Documents: 'Requested' })), true);
  assert.equal(isTradeVendor(facts({ Documents: 'Not needed', Trades: ['Plumbing'] }), { order: true }), false, 'staff said not needed');
  assert.equal(isTradeVendor(facts({ 'Materials only': true, 'W-9': true })), false, 'a supplier');
});

/** JobTread with roles and logins, for the sweep's roles part */
function rolesJT(people) {
  const roles = [
    { id: 'r-vendor', name: 'Vendor', type: 'vendor', permissions: ['readJobPlans', 'readJobTasks', 'updateJobToDoProgresses'] },
    { id: 'r-ms', name: 'Monetary Sponsor', type: 'vendor', permissions: ['readDailyLogs', 'readJobTaskGroups'] },
    { id: 'r-family', name: 'Makeover Family', type: 'customer', permissions: ['readJobTasks'] },
  ];
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const q = JSON.parse(init.body).query;
    calls.push(q);
    if (q.organization?.roles) return Response.json({ organization: { roles: { nodes: roles } } });
    if (q.organization?.memberships) {
      return Response.json({ organization: { memberships: { nextPage: null, nodes: people.map((m) => ({
        id: m.id, createdAt: '2025-01-01T00:00:00Z', isInternal: false, role: { id: roles.find((r) => r.name === m.role)?.id, name: m.role },
        account: m.account, user: { name: m.name, emailAddress: m.email },
      })) } } });
    }
    if (q.createRole) { const r = { id: `r-${roles.length}`, ...q.createRole.$ }; roles.push(r); return Response.json({ createRole: { createdRole: { id: r.id, name: r.name } } }); }
    if (q.updateMembership) { const m = people.find((x) => x.id === q.updateMembership.$.id); m.role = roles.find((r) => r.id === q.updateMembership.$.roleId).name; return Response.json({}); }
    throw new Error(`unexpected ${JSON.stringify(q).slice(0, 100)}`);
  };
  const writes = () => calls.filter((q) => q.createRole || q.updateMembership);
  return { fetchImpl, calls, roles, writes };
}

test('off: each run writes down what it would change, and changes nothing in JobTread', async () => {
  _resetEnsured(); _resetRoleCache();
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  const people = [login('m1', 'Vendor', { name: 'Ron', account: vendorAcct('acct-r', 'Randall Bros') }), login('m7', 'Makeover Family', { name: 'Mom' })];
  const jt = rolesJT(people);
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  const r = await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl });
  assert.deepEqual(r, { changed: 0, pending: 1, unplaced: 0 });
  assert.deepEqual(jt.writes(), []);
  const view = await rolesView(DB);
  assert.equal(view.on, false);
  assert.deepEqual(view.pending.map((c) => [c.name, c.from, c.to]), [['Ron', 'Vendor', 'Champion']]);
  assert.ok(!('membership' in view.pending[0]), 'ids stay in D1');
  const mode = await roleMode(env, { fetchImpl: jt.fetchImpl });
  assert.deepEqual([mode.partner(RANDALL), mode.sponsor(ACME), mode.trade], ['Vendor', 'Monetary Sponsor', 'Vendor'], 'grants keep the old roles until it’s on');
});

test('on: the level roles are made (vendor kind, both old roles’ permissions), roles change and are logged; put back undoes it all', async () => {
  _resetEnsured(); _resetRoleCache();
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  const people = [
    login('m1', 'Vendor', { name: 'Ron', account: vendorAcct('acct-r', 'Randall Bros') }),
    login('m4', 'Vendor', { name: 'Tia', account: vendorAcct('acct-tko', 'TKO Plumbing') }),
    login('m7', 'Makeover Family', { name: 'Mom' }),
  ];
  const jt = rolesJT(people);
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  await setOn(DB, true, 'admin@example.org');
  const r = await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl, now: Date.parse('2026-10-30T12:00:00Z') });
  assert.deepEqual(r, { changed: 2, pending: 0, unplaced: 0 });
  const made = jt.calls.filter((q) => q.createRole).map((q) => q.createRole.$);
  assert.deepEqual(made.map((m) => m.name), ['Signature', 'Champion', 'Builder', 'Friend', 'Trade Partner']);
  for (const m of made) {
    assert.equal(m.type, 'vendor');
    assert.deepEqual(m.permissions, ['readDailyLogs', 'readJobPlans', 'readJobTaskGroups', 'readJobTasks', 'updateJobToDoProgresses'], 'nobody moved loses anything');
  }
  assert.deepEqual(people.map((m) => m.role), ['Champion', 'Trade Partner', 'Makeover Family']);
  const audit = (await DB.prepare("SELECT changes FROM audit_log WHERE entity_type = 'jobtread-roles'").all()).results;
  assert.match(audit[0].changes, /Ron \(Randall Brothers\): Vendor → Champion/);
  assert.doesNotMatch(audit.map((a) => a.changes).join(' '), /@/, 'names only');
  const view = await rolesView(DB);
  assert.deepEqual(view.recent.map((c) => [c.name, c.to]), [['Tia', 'Trade Partner'], ['Ron', 'Champion']]);

  // The next run: nothing to change, nothing written
  const before = jt.writes().length;
  assert.equal((await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl })).changed, 0);
  assert.equal(jt.writes().length, before);

  // Changed by hand in JobTread: set back
  people[0].role = 'Vendor';
  await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl });
  assert.equal(people[0].role, 'Champion');
  assert.equal((await rolesView(DB)).recent[0].why, 'set back');

  // Off, and the old roles back: each login gets the role it had before the site
  const back = await putBack(env, 'admin@example.org', { fetchImpl: jt.fetchImpl });
  assert.deepEqual(back.problems, []);
  assert.deepEqual(people.map((m) => m.role), ['Vendor', 'Vendor', 'Makeover Family']);
  assert.equal((await rolesView(DB)).on, false);
  assert.deepEqual((await rolesView(DB)).recent, []);
});

test('staff’s say for someone the site can’t place: Trade Partner, or leave their role', async () => {
  _resetEnsured(); _resetRoleCache();
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  const people = [login('m5', 'Vendor', { name: 'Gus', account: vendorAcct('acct-x', 'Mystery Co') }), login('m6', 'Champion', { name: 'Cal', account: vendorAcct('acct-y', 'Not In Partners') })];
  const jt = rolesJT(people);
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl });
  assert.deepEqual((await rolesView(DB)).unplaced.map((u) => [u.name, u.why]), [['Gus', 'unknown'], ['Cal', 'level']]);
  await pickRole(DB, { membership: 'm5', role: TRADE_ROLE, name: 'Gus' }, 'staff@example.org');
  await pickRole(DB, { membership: 'm6', keep: true, name: 'Cal' }, 'staff@example.org');
  assert.deepEqual((await rolesView(DB)).unplaced, [], 'off the list at once');
  await assert.rejects(pickRole(DB, { membership: 'm6', role: 'Champion' }), /level comes from Partners/);
  await setOn(DB, true);
  await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl });
  assert.deepEqual(people.map((m) => m.role), ['Trade Partner', 'Champion']);
});

test('reveal and Demo Day invites: level roles and Trade Partners are partners on the job; the sponsor is whoever is from the kid’s sponsor', () => {
  const ace = (role, name, email, company = null) => ({ membership: { isInternal: false, role: { name: role }, account: company ? { name: company } : null, user: { name, emailAddress: email } } });
  const job = { aces: { nodes: [ace('Champion', 'Ann', 'ann@acmefdn.example', 'Acme Foundation'), ace('Trade Partner', 'Tia', 'tia@tko.example', 'TKO Plumbing'),
    ace('Vendor', 'Ron', 'ron@randallbrothers.example', 'Randall Bros'), ace('Monetary Sponsor', 'Mo', 'mo@fund.example'), ace('Photographer', 'Pia', 'pia@acmefdn.example')] } };
  const g = guestGroups(job, [], []);
  assert.deepEqual(g.confirmed.map((p) => [p.name, p.kind]), [['Ann', 'partner'], ['Tia', 'trade partner'], ['Ron', 'vendor'], ['Mo', 'sponsor'], ['Pia', 'photographer']]);
  const isSponsor = (p, slug) => slug === 'isla' && /acmefdn/.test(p.email);
  assert.deepEqual(sponsorGuests(g, 'isla', isSponsor).map((p) => p.name), ['Ann', 'Mo'], 'the sponsor’s Champion and JobTread’s own Monetary Sponsor; never the photographer');
  assert.deepEqual(sponsorGuests(g, null, isSponsor).map((p) => p.name), ['Mo']);
});
