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
    assert.deepEqual(body.view.pending, [], 'and what the sweep will do');
  } finally { globalThis.fetch = realFetch; }
  const off = await onRequestGet({ env: { DB } });
  assert.equal(off.status, 500);
  assert.match((await off.json()).error, /isn’t connected/);
});

// ── Roles that follow levels ─────────────────────────────────────────
import { createD1 } from './lib/d1-shim.mjs';
import {
  planRoles, placePerson, reconcileRoles, rolesView, pickRole, roleMode, _resetEnsured, TRADE_ROLE, DESIGN_ROLE, isPartnerRole,
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
  assert.deepEqual(unplaced.map((u) => u.account), ['acct-x', 'acct-y'], 'their JobTread vendor, so staff can say which partner it is');
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
    { id: 'r-design', name: 'Design Partner', type: 'vendor', permissions: ['readJobPlans'] },
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
    if (q.deleteRole) {
      const r = roles.find((x) => x.id === q.deleteRole.$.id);
      assert.ok(!people.some((m) => m.role === r.name), `nobody has ${r.name} when it’s deleted`);
      roles.splice(roles.indexOf(r), 1);
      return Response.json({});
    }
    throw new Error(`unexpected ${JSON.stringify(q).slice(0, 100)}`);
  };
  const writes = () => calls.filter((q) => q.createRole || q.updateMembership || q.deleteRole);
  return { fetchImpl, calls, roles, writes };
}

test('always on: grants give the level roles, roles change and are logged, and the old roles go once nobody has them', async () => {
  _resetEnsured(); _resetRoleCache();
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  const people = [
    login('m1', 'Vendor', { name: 'Ron', account: vendorAcct('acct-r', 'Randall Bros') }),
    login('m4', 'Vendor', { name: 'Tia', account: vendorAcct('acct-tko', 'TKO Plumbing') }),
    login('m5', 'Vendor', { name: 'Gus', account: vendorAcct('acct-x', 'Mystery Co') }),
    login('m7', 'Makeover Family', { name: 'Mom' }),
  ];
  const jt = rolesJT(people);
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  const mode = await roleMode(env, { fetchImpl: jt.fetchImpl });
  assert.deepEqual([mode.partner(RANDALL), mode.sponsor(ACME), mode.trade], ['Champion', 'Signature', 'Trade Partner'], 'grants give the level roles');
  const made = jt.calls.filter((q) => q.createRole).map((q) => q.createRole.$);
  assert.deepEqual(made.map((m) => m.name), ['Signature', 'Champion', 'Builder', 'Friend', 'Trade Partner']);
  for (const m of made) {
    assert.equal(m.type, 'vendor');
    assert.deepEqual(m.permissions, ['readDailyLogs', 'readJobPlans', 'readJobTaskGroups', 'readJobTasks', 'updateJobToDoProgresses'], 'nobody moved loses anything');
  }
  const r = await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl, now: Date.parse('2026-10-30T12:00:00Z') });
  assert.deepEqual(r, { changed: 2, pending: 0, unplaced: 1 });
  assert.deepEqual(people.map((m) => m.role), ['Champion', 'Trade Partner', 'Vendor', 'Makeover Family']);
  const audit = (await DB.prepare("SELECT changes FROM audit_log WHERE entity_type = 'jobtread-roles'").all()).results;
  assert.match(audit[0].changes, /Ron \(Randall Brothers\): Vendor → Champion/);
  assert.doesNotMatch(audit.map((a) => a.changes).join(' '), /@/, 'names only');
  const view = await rolesView(DB);
  assert.deepEqual(view.recent.map((c) => [c.name, c.to]), [['Tia', 'Trade Partner'], ['Ron', 'Champion']]);
  assert.ok(!('membership' in (view.recent[0] || {})), 'ids stay in D1');
  // Gus still has Vendor: it stays; Monetary Sponsor has nobody: it goes
  assert.deepEqual(jt.roles.map((x) => x.name).filter((n) => ['Vendor', 'Monetary Sponsor'].includes(n)), ['Vendor']);
  assert.deepEqual(Object.keys(view.gone).sort(), ['Monetary Sponsor', 'Sponsor']);

  // The next run: nothing to change, nothing written
  const before = jt.writes().length;
  assert.equal((await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl })).changed, 0);
  assert.equal(jt.writes().length, before);

  // Changed by hand in JobTread: set back
  people[0].role = 'Builder';
  await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl });
  assert.equal(people[0].role, 'Champion');
  assert.equal((await rolesView(DB)).recent[0].why, 'set back');

  // Staff make Gus a Design Partner: Vendor has nobody, so it goes too, and is never given again
  await pickRole(DB, { membership: 'm5', role: DESIGN_ROLE, name: 'Gus' }, 'staff@example.org');
  await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl, now: Date.parse('2026-10-30T12:30:00Z') });
  assert.equal(people[2].role, 'Design Partner');
  assert.ok(!jt.roles.some((x) => x.name === 'Vendor'));
  assert.deepEqual(Object.keys((await rolesView(DB)).gone).sort(), ['Monetary Sponsor', 'Sponsor', 'Vendor']);
  const gone = (await DB.prepare("SELECT changes FROM audit_log WHERE entity_name = 'Old roles in JobTread' ORDER BY id").all()).results.map((a) => a.changes).join(' ');
  assert.match(gone, /Monetary Sponsor/);
  assert.match(gone, /Vendor/);
  const after = jt.writes().length;
  const reads = jt.calls.length;
  await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl });
  assert.equal(jt.writes().length, after, 'nothing more to delete');
  assert.ok(!jt.calls.slice(reads).some((q) => q.organization?.roles), 'and the roles aren’t read again for it');
});

test('staff’s say for someone the site can’t place: Trade Partner, Design Partner, or leave a level (never an old role)', async () => {
  _resetEnsured(); _resetRoleCache();
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  const people = [login('m5', 'Vendor', { name: 'Gus', account: vendorAcct('acct-x', 'Mystery Co') }), login('m6', 'Champion', { name: 'Cal', account: vendorAcct('acct-y', 'Not In Partners') }),
    login('m8', 'Vendor', { name: 'Mel', account: vendorAcct('acct-z', 'Mel OTR/L') })];
  const jt = rolesJT(people);
  const env = { DB, JOBTREAD_GRANT_KEY: 'k' };
  await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl });
  assert.deepEqual((await rolesView(DB)).unplaced.map((u) => [u.name, u.why]), [['Gus', 'unknown'], ['Cal', 'level'], ['Mel', 'unknown']]);
  await pickRole(DB, { membership: 'm5', role: TRADE_ROLE, name: 'Gus' }, 'staff@example.org');
  await pickRole(DB, { membership: 'm6', keep: true, name: 'Cal' }, 'staff@example.org');
  await pickRole(DB, { membership: 'm8', role: DESIGN_ROLE, name: 'Mel' }, 'staff@example.org');
  assert.deepEqual((await rolesView(DB)).unplaced, [], 'off the list at once');
  await assert.rejects(pickRole(DB, { membership: 'm6', role: 'Champion' }), /level comes from Partners/);
  await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl });
  assert.deepEqual(people.map((m) => m.role), ['Trade Partner', 'Champion', 'Design Partner']);
  // "Leave as Vendor" isn't a say: Vendor goes, so they're asked about again
  people.push(login('m9', 'Vendor', { name: 'Val', account: vendorAcct('acct-v', 'Val Co') }));
  await pickRole(DB, { membership: 'm9', keep: true, name: 'Val' }, 'staff@example.org');
  await reconcileRoles(env, ctxOf(), { fetchImpl: jt.fetchImpl });
  assert.deepEqual((await rolesView(DB)).unplaced.map((u) => u.name), ['Val']);
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
