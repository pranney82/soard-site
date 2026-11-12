/**
 * Donors & Partners (functions/api/_donor-crm.js): which organization a gift counts for, the same person, Keep
 * anonymous, what needs a person, and following merges (Zeffy's and Partners'). Names, emails and amounts are made up.
 * Run: node --test tests/donor-crm.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import * as D from '../functions/api/_donors.js';
import * as C from '../functions/api/_donor-crm.js';

const DAY = 864e5;
const NOW = Date.parse('2026-11-11T17:00:00Z');
const S = (ms) => Math.floor(ms / 1000);
let db;
let env;
let n = 0;
const pay = (o = {}) => ({
  id: o.id || `pay_${++n}`, object: 'payment', created: o.created ?? S(NOW - DAY), amount: o.amount ?? 10000,
  status: 'succeeded', type: o.type || 'online', refund_status: 'none', refunds: [], description: o.description ?? 'Help Build a Brighter Home',
  contact: o.contact === undefined ? 'ct_jane' : o.contact, payment_method: { type: o.method || 'card' },
  buyer: { email: o.email ?? 'jane@example.com', first_name: o.first ?? 'Jane', last_name: o.last ?? 'Doe', is_corporate: !!o.company, company_name: o.company || null },
  campaign_category: 'donation', items: [{ type: 'donation', amount: o.amount ?? 10000 }],
  buyer_questions: o.anonymous ? [{ question: 'Give anonymously?', answer: true }] : [], recurring: null, metadata: {},
});
const add = async (...ps) => { for (const p of ps) await D.noteDonorPayment(env, p, { now: NOW }); };
const partner = (slug, name, level = 'friend', category = ['funding']) => `INSERT INTO partners VALUES ('${slug}', '${JSON.stringify({ name, level, category }).replace(/'/g, "''")}')`;
const by = 'staff@example.org';
const doIt = (body) => C.act(env, body, by, { now: NOW });
const list = async () => (await C.listView(env, { now: NOW })).people;
const needs = async () => (await C.needsView(env, { now: NOW })).items;

beforeEach(async () => {
  db = await createD1({ schemaSql: [
    'CREATE TABLE kids (slug TEXT, name TEXT, data TEXT)',
    'CREATE TABLE partners (slug TEXT PRIMARY KEY, data TEXT)',
    partner('acme', 'Acme Builders'), partner('pella', 'Pella'), partner('moreno', 'Chris & Dana Moreno', 'champion'),
    partner('beta', 'Beta Corp', 'builder', ['build']),
  ] });
  env = { DB: db };
});

test('a gift for a company with a partner’s exact name counts for the partner; the person who paid shows it as “gave for”', async () => {
  await add(pay({ id: 'p1', company: 'ACME Builders, Inc.', amount: 50000 }), pay({ id: 'p2', amount: 2500 }));
  const people = await list();
  const acme = people.find((p) => p.key === 'p:acme');
  assert.equal(acme.type, 'org');
  assert.equal(acme.name, 'Acme Builders');
  assert.equal(acme.total, 50000);
  assert.equal(acme.onSite, true);
  const jane = people.find((p) => p.type === 'person');
  assert.equal(jane.total, 2500, 'her own gift only');
  const page = await C.personView(env, 'ct_jane', { now: NOW });
  assert.deepEqual(page.gaveFor.map((g) => [g.key, g.cents]), [['p:acme', 50000]]);
});

test('a donor-advised fund’s name never makes the gift the fund’s; a name typed in both boxes that is a partner’s is that partner', async () => {
  await db.prepare(partner('fidelity', 'Fidelity Charitable')).run();
  await add(pay({ id: 'd1', method: 'daf', company: 'Fidelity Charitable', amount: 100000 }));
  await add(pay({ id: 'q1', contact: 'ct_pella', first: 'Pella', last: 'Pella', email: 'ap@pella.example', amount: 300000 }));
  const people = await list();
  assert.equal(people.find((p) => p.key === 'c:ct_jane')?.total, 100000, 'the DAF gift is Jane’s');
  assert.equal(people.find((p) => p.key === 'p:pella')?.total, 300000, 'Pella gave as Pella');
  assert.ok(!people.some((p) => p.key === 'p:fidelity'));
});

test('a near name is asked about; “not this one” stops asking, “yes” links it', async () => {
  await add(pay({ id: 'n1', company: 'Pella Window & Door of Georgia', amount: 80000 }));
  let items = await needs();
  const near = items.find((i) => i.kind === 'near' && i.link === 'company');
  assert.equal(near.org, 'p:pella');
  assert.equal(near.subject, 'Pella Window & Door of Georgia');
  await doIt({ act: 'not', kind: 'company', subject: near.subject, org: 'p:pella' });
  assert.ok(!(await needs()).some((i) => i.kind === 'near' && i.link === 'company'), 'not asked again');
  assert.ok(!(await list()).some((p) => p.key === 'p:pella'));
  await doIt({ act: 'link', kind: 'company', subject: 'Pella Window & Door of Georgia', org: 'p:pella' });
  assert.equal((await list()).find((p) => p.key === 'p:pella')?.total, 80000, 'linked: it counts for Pella');
});

test('a contact whose whole name is in a partner’s is asked about (Chris Moreno and Chris & Dana Moreno)', async () => {
  await add(pay({ id: 'r1', contact: 'ct_chris', first: 'Chris', last: 'Moreno', email: 'chris@example.com', amount: 20000 }));
  const near = (await needs()).find((i) => i.kind === 'near' && i.link === 'contact');
  assert.equal(near.org, 'p:moreno');
  assert.equal(near.subject, 'ct_chris');
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_chris', org: 'p:moreno' });
  assert.equal((await list()).find((p) => p.key === 'p:moreno')?.total, 20000);
});

test('the contact’s organization counts over the company’s, and Needs you asks; an answer for the gift settles it', async () => {
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_jane', org: 'p:beta' });
  await add(pay({ id: 'c1', company: 'Acme Builders', amount: 40000 }));
  assert.equal((await list()).find((p) => p.key === 'p:beta')?.total, 40000, 'counted for her contact’s organization');
  const clash = (await needs()).find((i) => i.kind === 'clash');
  assert.equal(clash.counted, 'p:beta');
  assert.equal(clash.other, 'p:acme');
  await doIt({ act: 'payment', id: 'c1', owner: 'p:acme' });
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 40000);
  assert.ok(!(await needs()).some((i) => i.kind === 'clash'));
});

test('Same donor?: two contacts with one name are asked about; “same” makes one person, “not the same” never asks again', async () => {
  await add(pay({ id: 's1', contact: 'ct_a', first: 'Maria', last: 'Lopez', email: 'maria@example.com', amount: 5000 }));
  await add(pay({ id: 's2', contact: 'ct_b', first: 'Maria J.', last: 'Lopez', email: 'mlopez@example.org', amount: 7000, created: S(NOW - 3 * DAY) }));
  const same = (await needs()).find((i) => i.kind === 'same');
  assert.equal(same.why, 'The same name');
  assert.deepEqual([same.a.key, same.b.key].sort(), ['c:ct_a', 'c:ct_b']);
  await doIt({ act: 'same', a: 'c:ct_a', b: 'c:ct_b', same: true });
  const marias = (await list()).filter((p) => /Maria/.test(p.name));
  assert.equal(marias.length, 1);
  assert.equal(marias[0].total, 12000);
  // Either record's address opens the one person
  assert.equal((await C.personView(env, 'ct_b', { now: NOW })).donor.total, 12000);
  assert.ok(!(await needs()).some((i) => i.kind === 'same'));
  // Not the same: two again, and not asked
  await doIt({ act: 'same', a: 'c:ct_a', b: 'c:ct_b', same: false });
  assert.equal((await list()).filter((p) => /Maria/.test(p.name)).length, 2);
  assert.ok(!(await needs()).some((i) => i.kind === 'same'));
});

test('one email on two Zeffy contacts is asked about too', async () => {
  await add(pay({ id: 'e1', contact: 'ct_x', first: 'Sam', last: 'Lee', email: 'sam@example.com' }), pay({ id: 'e2', contact: 'ct_y', first: 'Samuel', last: 'Lee', email: 'sam@example.com' }));
  const same = (await needs()).find((i) => i.kind === 'same');
  assert.equal(same.why, 'The same email');
});

test('level by giving: a Funding partner below Champion with $10,000 in 12 months is suggested; not for an anonymous giver; “not now” waits a year', async () => {
  await add(pay({ id: 'l1', company: 'Acme Builders', amount: 600000, created: S(NOW - 30 * DAY) }), pay({ id: 'l2', company: 'Acme Builders', amount: 500000, created: S(NOW - 200 * DAY) }));
  // Two years ago doesn't count toward the 12 months
  await add(pay({ id: 'l0', company: 'Beta Corp', amount: 2000000, created: S(NOW - 500 * DAY) }));
  let lv = (await needs()).filter((i) => i.kind === 'level');
  assert.deepEqual(lv.map((i) => [i.org, i.cents12]), [['p:acme', 1100000]]);
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  assert.ok(!(await needs()).some((i) => i.kind === 'level'), 'kept anonymous: never suggested for the website');
  await doIt({ act: 'anon', key: 'p:acme', on: false });
  await doIt({ act: 'level', org: 'p:acme', done: false });
  assert.ok(!(await needs()).some((i) => i.kind === 'level'), 'not now');
  const later = (await C.needsView(env, { now: NOW + 366 * DAY })).items;
  assert.ok(!later.some((i) => i.kind === 'level'), 'a year on, its gifts are older than 12 months too');
});

test('a big giver with no organization here is offered; keeping it as one makes it an organization, its gifts with it', async () => {
  await add(pay({ id: 'b1', contact: 'ct_ann', first: 'Ann', last: 'Ivers', email: 'ann@example.com', company: 'Ivers Foundation', amount: 3000000, created: S(NOW - 40 * DAY) }));
  const big = (await needs()).find((i) => i.kind === 'big');
  assert.equal(big.name, 'Ivers Foundation');
  assert.equal(big.cents12, 3000000);
  const r = await doIt({ act: 'org-new', name: 'Ivers Foundation', links: [{ kind: big.link, subject: big.linkSubject }] });
  assert.match(r.key, /^o:/);
  const org = (await list()).find((p) => p.key === r.key);
  assert.equal(org.onSite, false);
  assert.equal(org.total, 3000000);
  assert.ok(!(await needs()).some((i) => i.kind === 'big'));
  // Its page: who gave, under which names
  const v = await C.orgView(env, r.key, { now: NOW });
  assert.deepEqual(v.names.map((x) => [x.kind, x.name, x.how]), [['company', 'Ivers Foundation', 'linked']]);
  assert.deepEqual(v.people.map((p) => [p.name, p.cents]), [['Ann Ivers', 3000000]]);
  assert.equal(v.gifts[0].by, 'Ann Ivers');
  // Put on the website: the partner card is made, and everything said about it is the partner's
  await db.prepare(partner('ivers-foundation', 'Ivers Foundation')).run();
  const w = await doIt({ act: 'website', key: r.key, slug: 'ivers-foundation' });
  assert.equal(w.key, 'p:ivers-foundation');
  assert.deepEqual(await C.orgView(env, r.key, { now: NOW }), { moved: 'p:ivers-foundation' }, 'its old address leads to the partner');
  assert.equal((await list()).find((p) => p.key === 'p:ivers-foundation')?.total, 3000000);
});

test('an anonymous gift is never offered for the website, and Keep anonymous on a person shows on the list', async () => {
  await add(pay({ id: 'a1', contact: 'ct_q', first: 'Quiet', last: 'Giver', email: 'q@example.com', company: 'Quiet Holdings', amount: 2000000, anonymous: true }));
  assert.ok(!(await needs()).some((i) => i.kind === 'big'));
  await add(pay({ id: 'a2', contact: 'ct_r', first: 'Rae', last: 'Ng', email: 'rae@example.com' }));
  await doIt({ act: 'anon', key: 'c:ct_r', on: true });
  assert.equal((await list()).find((p) => p.key === 'c:ct_r').keepAnonymous, true);
});

test('a deleted partner’s links stop counting; restored, they count again', async () => {
  await add(pay({ id: 'x1', company: 'Acme Builders', amount: 9000 }));
  await db.prepare("DELETE FROM partners WHERE slug = 'acme'").run();
  assert.ok(!(await list()).some((p) => p.key === 'p:acme'));
  assert.equal((await list()).find((p) => p.key === 'c:ct_jane')?.total, 9000, 'Jane’s again meanwhile');
  await db.prepare(partner('acme', 'Acme Builders')).run();
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 9000);
});

test('Partners → Merge into: what was said about the old company is the new one’s', async () => {
  await db.prepare(partner('acme-2', 'Acme Two')).run();
  await doIt({ act: 'link', kind: 'company', subject: 'Acme Construction LLC', org: 'p:acme-2' });
  await doIt({ act: 'anon', key: 'p:acme-2', on: true });
  await add(pay({ id: 'm1', company: 'Acme Construction LLC', amount: 12000 }));
  await C.mergeOrgCalls(db, 'acme-2', 'acme');
  await db.prepare("DELETE FROM partners WHERE slug = 'acme-2'").run();
  const acme = (await list()).find((p) => p.key === 'p:acme');
  assert.equal(acme.total, 12000);
  assert.equal(acme.keepAnonymous, true);
});

test('Zeffy merges two contacts: what was known about the one gone follows its gifts; gone to several, a person decides', async () => {
  await add(pay({ id: 'z1', contact: 'ct_old', first: 'Dana', last: 'Fox', email: 'dana@example.com' }));
  await doIt({ act: 'anon', key: 'c:ct_old', on: true });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_old', org: 'p:beta' });
  // Zeffy now lists the payment under the contact it kept
  await add(pay({ id: 'z1', contact: 'ct_new', first: 'Dana', last: 'Fox', email: 'dana@example.com' }));
  assert.equal((await db.prepare("SELECT was_contact FROM donor_payments WHERE id = 'z1'").first()).was_contact, 'ct_old');
  const r = await C.followMerges(db, { now: NOW });
  assert.equal(r.moved, 1);
  assert.equal((await list()).find((p) => p.key === 'p:beta')?.total, 10000, 'the link went with it');
  const crm = await C.loadCrm(db, { now: NOW });
  assert.equal(crm.calls.yes.get('contact\nct_new'), 'p:beta');
  assert.equal(crm.keepAnonymous('p:beta'), false);
  // Split across two contacts: asked, nothing dropped
  await add(pay({ id: 'y1', contact: 'ct_split', first: 'Lou', last: 'Ray', email: 'lou@example.com' }), pay({ id: 'y2', contact: 'ct_split', first: 'Lou', last: 'Ray', email: 'lou@example.com' }));
  await doIt({ act: 'anon', key: 'c:ct_split', on: true });
  await add(pay({ id: 'y1', contact: 'ct_s1', first: 'Lou', last: 'Ray', email: 'lou@example.com' }), pay({ id: 'y2', contact: 'ct_s2', first: 'Lou', last: 'Ray', email: 'lou2@example.com' }));
  const r2 = await C.followMerges(db, { now: NOW });
  assert.equal(r2.unplaced, 1);
  const moved = (await needs()).find((i) => i.kind === 'moved');
  assert.deepEqual(moved.to.sort(), ['ct_s1', 'ct_s2']);
  await doIt({ act: 'moved-done', contact: 'ct_split' });
  assert.ok(!(await needs()).some((i) => i.kind === 'moved'));
});

test('a gift link from Slack opens the organization it counts for', async () => {
  await add(pay({ id: 'g1', company: 'Acme Builders', amount: 150000 }), pay({ id: 'g2', amount: 150000 }));
  assert.deepEqual(await C.giftOwner(env, 'g1', { now: NOW }), { org: 'p:acme' });
  assert.deepEqual(await C.giftOwner(env, 'g2', { now: NOW }), { ref: 'ct_jane' });
});

test('changes are checked: an organization that isn’t here, a name already taken, a partner renamed here', async () => {
  await assert.rejects(doIt({ act: 'link', kind: 'company', subject: 'X', org: 'p:nobody' }), /isn’t here/);
  await assert.rejects(doIt({ act: 'org-new', name: 'Acme Builders' }), /already here/);
  await assert.rejects(doIt({ act: 'org-rename', key: 'p:acme', name: 'Other' }), /partner card/);
  await assert.rejects(doIt({ act: 'nope' }), /Unknown/);
  const audit = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'donor-crm'").first().catch(() => ({ n: 0 }));
  assert.equal(Number(audit.n), 0, 'nothing written for a change refused');
});

test('finding Zeffy names to link: company names and contacts, with the organization each already counts for', async () => {
  await add(pay({ id: 'f1', company: 'Acme Builders', amount: 9000 }), pay({ id: 'f2', contact: 'ct_k', first: 'Kim', last: 'Acme', email: 'kim@example.com', amount: 3000 }));
  const { names } = await C.findNames(env, 'acme', { now: NOW });
  assert.deepEqual(names.map((x) => [x.kind, x.name, x.orgName]), [['company', 'Acme Builders', 'Acme Builders'], ['contact', 'Kim Acme', null]]);
});

// ─── Review round 5 ─────────────────────────────────────────────────

test('a gift a person counted for an organization follows it onto the website and through a merge; taking the organization out lets it go', async () => {
  await db.prepare(partner('gamma', 'Gamma Co')).run();
  await add(pay({ id: 'o1', amount: 5000 }), pay({ id: 'o2', amount: 6000 }));
  const { key } = await doIt({ act: 'org-new', name: 'Family Fund' });
  await doIt({ act: 'payment', id: 'o1', owner: key });
  await doIt({ act: 'payment', id: 'o2', owner: 'p:gamma' });
  await db.prepare(partner('family-fund', 'Family Fund')).run();
  await doIt({ act: 'website', key, slug: 'family-fund' });
  assert.equal((await list()).find((p) => p.key === 'p:family-fund')?.total, 5000, 'onto the website');
  await C.mergeOrgCalls(db, 'gamma', 'acme');
  await db.prepare("DELETE FROM partners WHERE slug = 'gamma'").run();
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 6000, 'through a merge');
  const { key: k2 } = await doIt({ act: 'org-new', name: 'Short Lived' });
  await doIt({ act: 'payment', id: 'o1', owner: k2 });
  await doIt({ act: 'org-delete', key: k2 });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM donor_calls WHERE kind = 'payment' AND subject = 'o1'").first()).n, 0, 'taken out: the gift counts as the site works it out');
  // Take off a gift's own answer: it goes back to its contact's organization, not to the person by force
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_jane', org: 'p:beta' });
  await doIt({ act: 'payment', id: 'o2', owner: 'p:acme' });
  await doIt({ act: 'payment-clear', id: 'o2' });
  assert.equal((await list()).find((p) => p.key === 'p:beta')?.total, 11000);
});

test('the board hides a giver kept anonymous who has no Zeffy contact, and a loose gift under a kept-anonymous contact’s email', async () => {
  const { giftsNow } = await import('../functions/api/_board-gifts.js');
  const { writeState } = await import('../functions/api/_board-roles.js');
  await add(pay({ id: 'b1', contact: null, email: 'nocontact@example.com', first: 'Nora', last: 'Night', amount: 200000 }));
  await add(pay({ id: 'b2', contact: 'ct_kay', email: 'kay@example.com', first: 'Kay', last: 'Low', amount: 200000, created: S(NOW - 5 * DAY) }));
  await add(pay({ id: 'b3', contact: null, email: 'kay@example.com', first: 'Kay', last: 'Low', amount: 300000 }));
  await add(pay({ id: 'b4', contact: 'ct_pat', email: 'pat@example.com', first: 'Pat', last: 'Open', amount: 200000 }));
  // As the board keeps them (its own read of Zeffy): the contact when Zeffy has one, never an email
  const row = (id, name, contact) => ({ id, at: S(NOW - DAY), cents: 200000, name, company: '', anonymous: false, campaign: 'A gift', every: '', inKind: false, contact: contact || '', method: 'card' });
  const gifts = [row('b1', 'Nora Night'), row('b2', 'Kay Low', 'ct_kay'), row('b3', 'Kay Low'), row('b4', 'Pat Open', 'ct_pat')];
  await writeState(db, 'gifts', { year: 2026, list: gifts, at: new Date(NOW).toISOString(), triedAt: new Date(NOW).toISOString() });
  await doIt({ act: 'anon', key: 'e:nocontact@example.com', on: true });
  await doIt({ act: 'anon', key: 'c:ct_kay', on: true });
  const v = await giftsNow(db, { now: NOW });
  const by = Object.fromEntries(v.list.map((g) => [g.id, g.anonymous]));
  assert.deepEqual(by, { b1: true, b2: true, b3: true, b4: false });
});

test('“Done” on a contact Zeffy split stays done after the next whole read', async () => {
  await add(pay({ id: 'y1', contact: 'ct_split', first: 'Lou', last: 'Ray', email: 'lou@example.com' }), pay({ id: 'y2', contact: 'ct_split', first: 'Lou', last: 'Ray', email: 'lou@example.com' }));
  await doIt({ act: 'anon', key: 'c:ct_split', on: true });
  await add(pay({ id: 'y1', contact: 'ct_s1', first: 'Lou', last: 'Ray', email: 'lou@example.com' }), pay({ id: 'y2', contact: 'ct_s2', first: 'Lou', last: 'Ray', email: 'lou2@example.com' }));
  await C.followMerges(db, { now: NOW });
  await doIt({ act: 'moved-done', contact: 'ct_split' });
  await C.followMerges(db, { now: NOW + 15 * 60e3 });
  assert.ok(!(await needs()).some((i) => i.kind === 'moved'));
});

test('a Zeffy merge keeps the gone contact’s link when the kept one only has a “no” about another organization', async () => {
  await db.prepare(partner('gamma', 'Gamma Co')).run();
  await add(pay({ id: 'z1', contact: 'ct_a', first: 'Al', last: 'Smith', email: 'al@example.com' }), pay({ id: 'z2', contact: 'ct_b', first: 'Al', last: 'Smith', email: 'al2@example.com' }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_a', org: 'p:beta' });
  await doIt({ act: 'not', kind: 'contact', subject: 'ct_b', org: 'p:gamma' });
  await add(pay({ id: 'z1', contact: 'ct_b', first: 'Al', last: 'Smith', email: 'al2@example.com' }));
  await C.followMerges(db, { now: NOW });
  const crm = await C.loadCrm(db, { now: NOW });
  assert.equal(crm.calls.yes.get('contact\nct_b'), 'p:beta');
  assert.ok(crm.calls.no.has('contact\nct_b\np:gamma'));
});

test('Keep anonymous is never lost in a merge, even onto one that once had it turned off', async () => {
  await db.prepare(partner('gamma', 'Gamma Co')).run();
  await doIt({ act: 'anon', key: 'p:gamma', on: true });
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  await doIt({ act: 'anon', key: 'p:acme', on: false });
  await C.mergeOrgCalls(db, 'gamma', 'acme');
  assert.equal((await C.loadCrm(db, { now: NOW })).keepAnonymous('p:acme'), true);
});

test('renaming an organization to another’s name is refused (each would lose the gifts its name links)', async () => {
  const { key } = await doIt({ act: 'org-new', name: 'Quiet Fund' });
  await assert.rejects(doIt({ act: 'org-rename', key, name: 'Acme Builders, Inc.' }), /already has that name/);
  await doIt({ act: 'org-rename', key, name: 'Quiet Family Fund' });
});

test('one record out of a person joined through it: the others stay one person; “not the same” holds whoever leads', async () => {
  await add(pay({ id: 'j1', contact: 'ct_a', first: 'Ann', last: 'Lee', email: 'a@example.com' }), pay({ id: 'j2', contact: 'ct_b', first: 'Ann', last: 'Lee', email: 'b@example.com' }), pay({ id: 'j3', contact: 'ct_c', first: 'Ann', last: 'Lee', email: 'c@example.com' }));
  await doIt({ act: 'same', a: 'c:ct_a', b: 'c:ct_b', same: true });
  await doIt({ act: 'same', a: 'c:ct_b', b: 'c:ct_c', same: true });
  assert.equal((await list()).filter((p) => p.name === 'Ann Lee').length, 1);
  await doIt({ act: 'split', key: 'c:ct_b' });
  const anns = (await list()).filter((p) => p.name === 'Ann Lee').map((p) => p.key).sort();
  assert.deepEqual(anns, ['c:ct_a', 'c:ct_b'], 'A and C one person (led by A), B on its own');
  assert.ok(!(await needs()).some((i) => i.kind === 'same'), 'and B isn’t asked about again');
  // "Not the same" said while D led, still holds when a join makes another record lead
  await add(pay({ id: 'k1', contact: 'ct_d', first: 'Bo', last: 'Kim', email: 'd@example.com' }), pay({ id: 'k2', contact: 'ct_e', first: 'Bo', last: 'Kim', email: 'e@example.com' }), pay({ id: 'k3', contact: 'ct_0', first: 'Bo', last: 'Kim', email: 'zero@example.com' }));
  await doIt({ act: 'same', a: 'c:ct_d', b: 'c:ct_e', same: false });
  await doIt({ act: 'same', a: 'c:ct_0', b: 'c:ct_d', same: true });
  await doIt({ act: 'same', a: 'c:ct_0', b: 'c:ct_e', same: false });
  assert.ok(!(await needs()).some((i) => i.kind === 'same'));
});

test('a partner given for by someone kept anonymous is never suggested as Champion', async () => {
  await add(pay({ id: 'q1', contact: 'ct_q', first: 'Quinn', last: 'Ash', email: 'q@example.com', company: 'Acme Builders', amount: 1500000 }));
  assert.ok((await needs()).some((i) => i.kind === 'level'));
  await doIt({ act: 'anon', key: 'c:ct_q', on: true });
  assert.ok(!(await needs()).some((i) => i.kind === 'level'));
  assert.equal((await C.orgView(env, 'p:acme', { now: NOW })).anonymousGifts, true, 'and Put on the website would ask');
});

test('a donor list table made before was_contact gets the column', async () => {
  const old = await createD1({ schemaSql: [`CREATE TABLE donor_payments (id TEXT PRIMARY KEY, contact TEXT, at INTEGER NOT NULL, cents INTEGER NOT NULL, net INTEGER NOT NULL,
    giving INTEGER NOT NULL, in_kind INTEGER NOT NULL DEFAULT 0, type TEXT, method TEXT, corporate INTEGER NOT NULL DEFAULT 0, company TEXT, first TEXT, last TEXT, email TEXT,
    campaign_id TEXT, campaign TEXT, category TEXT, every TEXT, sub TEXT, anonymous INTEGER NOT NULL DEFAULT 0, refund TEXT, first_seen TEXT NOT NULL, checked_at TEXT NOT NULL)`] });
  await D.noteDonorPayment({ DB: old }, pay({ id: 'w1' }), { now: NOW });
  assert.equal((await D.allRows(old)).length, 1);
});

test('organizations kept here with nothing counted yet are listed, and every organization can be picked', async () => {
  const { key } = await doIt({ act: 'org-new', name: 'Empty Fund' });
  assert.ok((await list()).some((p) => p.key === key && p.type === 'org'));
  const { orgs } = await C.orgsList(env, { now: NOW });
  assert.ok(orgs.some((o) => o.key === key) && orgs.some((o) => o.key === 'p:acme'));
});

// ─── Review round 6 ─────────────────────────────────────────────────

const boardRow = (id, name, contact) => ({ id, at: S(NOW - DAY), cents: 200000, name, company: '', anonymous: false, campaign: 'A gift', every: '', inKind: false, contact: contact || '', method: 'card' });
async function board(gifts) {
  const { giftsNow } = await import('../functions/api/_board-gifts.js');
  const { writeState } = await import('../functions/api/_board-roles.js');
  await writeState(db, 'gifts', { year: 2026, list: gifts, at: new Date(NOW).toISOString(), triedAt: new Date(NOW).toISOString() });
  return Object.fromEntries((await giftsNow(db, { now: NOW })).list.map((g) => [g.id, g.anonymous]));
}

test('the board keeps a kept-anonymous giver’s loose gift hidden among 80 and more others', async () => {
  const gifts = [];
  for (let i = 0; i < 90; i++) { await add(pay({ id: `m${i}`, contact: `ct_m${i}`, email: `m${i}@example.com`, first: 'Many', last: `Giver ${i}` })); gifts.push(boardRow(`m${i}`, `Many Giver ${i}`, `ct_m${i}`)); }
  await add(pay({ id: 'kay1', contact: 'ct_kay', email: 'kay@example.com', first: 'Kay', last: 'Low' }), pay({ id: 'kay2', contact: null, email: 'kay@example.com', first: 'Kay', last: 'Low' }));
  await doIt({ act: 'anon', key: 'c:ct_kay', on: true });
  gifts.push(boardRow('kay2', 'Kay Low'));
  const by = await board(gifts);
  assert.equal(by.kay2, true);
  assert.equal(by.m0, false);
});

test('Keep anonymous by email stays when Zeffy later has a contact with that email, and turning it off clears it', async () => {
  await add(pay({ id: 'n1', contact: null, email: 'nora@example.com', first: 'Nora', last: 'Night', amount: 200000 }));
  await doIt({ act: 'anon', key: 'e:nora@example.com', on: true });
  await add(pay({ id: 'n2', contact: 'ct_nora', email: 'nora@example.com', first: 'Nora', last: 'Night', amount: 200000, created: S(NOW - 2 * 3600e3 / 1000 * 1000) }));
  const nora = (await list()).find((p) => p.name === 'Nora Night');
  assert.equal(nora.keepAnonymous, true, 'the list says so');
  assert.deepEqual(await board([boardRow('n1', 'Nora Night'), boardRow('n2', 'Nora Night', 'ct_nora')]), { n1: true, n2: true });
  await doIt({ act: 'anon', key: nora.key, on: false });
  assert.equal((await list()).find((p) => p.name === 'Nora Night').keepAnonymous, false, 'off is off, the email too');
});

test('a gift with no contact under a linked contact’s email counts for the organization', async () => {
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_ann', org: 'p:beta' });
  await add(pay({ id: 'an1', contact: 'ct_ann', email: 'ann@example.com', first: 'Ann', last: 'Lee', amount: 40000, created: S(NOW - 5 * DAY) }), pay({ id: 'an2', contact: null, email: 'ann@example.com', first: 'Ann', last: 'Lee', amount: 25000 }));
  const people = await list();
  assert.equal(people.find((p) => p.key === 'p:beta')?.total, 65000);
  assert.ok(!people.some((p) => p.name === 'Ann Lee' && p.type === 'person'));
});

test('a partner merge keeps a name linked to the one merged in, over a “no” the other had for it', async () => {
  await db.prepare(partner('acme-2', 'Acme Two')).run();
  await doIt({ act: 'not', kind: 'company', subject: 'Acme Construction LLC', org: 'p:acme' });
  await doIt({ act: 'link', kind: 'company', subject: 'Acme Construction LLC', org: 'p:acme-2' });
  await add(pay({ id: 'mg1', company: 'Acme Construction LLC', amount: 12000 }));
  await C.mergeOrgCalls(db, 'acme-2', 'acme');
  await db.prepare("DELETE FROM partners WHERE slug = 'acme-2'").run();
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 12000);
});

test('taking one record out leaves a “not the same” between the others as it was', async () => {
  await add(pay({ id: 'sa', contact: 'ct_a', first: 'Rae', last: 'Fox', email: 'ra@example.com' }), pay({ id: 'sb', contact: 'ct_b', first: 'Rae', last: 'Fox', email: 'rb@example.com' }), pay({ id: 'sc', contact: 'ct_c', first: 'Rae', last: 'Fox', email: 'rc@example.com' }));
  await doIt({ act: 'same', a: 'c:ct_a', b: 'c:ct_c', same: false });
  await doIt({ act: 'same', a: 'c:ct_a', b: 'c:ct_b', same: true });
  await doIt({ act: 'same', a: 'c:ct_b', b: 'c:ct_c', same: true });
  await doIt({ act: 'split', key: 'c:ct_b' });
  assert.equal((await list()).filter((p) => p.name === 'Rae Fox').length, 3, 'A and C stay apart, as was said');
});

test('a donor with no contact, email or name can be kept anonymous; people to join are found by name, never their own record', async () => {
  await add(pay({ id: 'xx1', contact: null, email: '', first: '', last: '', amount: 5000 }));
  const x = (await list()).find((p) => p.key === 'x:xx1');
  assert.ok(x);
  await doIt({ act: 'anon', key: 'x:xx1', on: true });
  assert.equal((await list()).find((p) => p.key === 'x:xx1').keepAnonymous, true);
  await add(pay({ id: 'fp1', contact: 'ct_fp', first: 'Pat', last: 'Fine', email: 'pat.fine@example.com' }), pay({ id: 'fp2', contact: 'ct_fp2', first: 'Patricia', last: 'Fine', email: 'pf@example.com' }));
  const { people } = await C.findPeople(env, 'fine', { now: NOW, except: 'c:ct_fp' });
  assert.deepEqual(people.map((p) => p.key), ['c:ct_fp2']);
});

// ─── Review round 7 ─────────────────────────────────────────────────

test('the board hides a gift that names a kept-anonymous organization, whoever it counts for', async () => {
  await db.prepare(partner('gamma', 'Gamma Co')).run();
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_ann', org: 'p:beta' });
  await doIt({ act: 'anon', key: 'p:gamma', on: true });
  await add(pay({ id: 'g1', contact: 'ct_ann', email: 'ann@example.com', first: 'Ann', last: 'Lee', company: 'Gamma Co', amount: 200000 }));
  await add(pay({ id: 'g2', contact: 'ct_bo', email: 'bo@example.com', first: 'Bo', last: 'Hart', company: 'Gamma Co', amount: 200000 }));
  await doIt({ act: 'payment', id: 'g2', owner: 'person' });
  const by = await board([boardRow('g1', 'Ann Lee', 'ct_ann'), boardRow('g2', 'Bo Hart', 'ct_bo')]);
  assert.deepEqual(by, { g1: true, g2: true });
});

test('a gift with no contact, for another company than its email’s contact’s organization, is asked about', async () => {
  await db.prepare(partner('gamma', 'Gamma Co')).run();
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_ann', org: 'p:beta' });
  await add(pay({ id: 'l1', contact: 'ct_ann', email: 'ann@example.com', first: 'Ann', last: 'Lee', created: S(NOW - 5 * DAY) }), pay({ id: 'l2', contact: null, email: 'ann@example.com', first: 'Ann', last: 'Lee', company: 'Gamma Co', amount: 25000 }));
  const clash = (await needs()).find((i) => i.kind === 'clash' && i.payment === 'l2');
  assert.ok(clash);
  assert.equal(clash.counted, 'p:beta');
  assert.equal(clash.other, 'p:gamma');
});

test('a joined person’s record with no contact counts for an organization only when all their contacts are linked to it', async () => {
  await add(pay({ id: 'jw', contact: 'ct_a_work', email: 'jo@work.example', first: 'Jo', last: 'Ray', amount: 10000 }), pay({ id: 'jh', contact: 'ct_b_home', email: 'jo@home.example', first: 'Jo', last: 'Ray', amount: 20000 }), pay({ id: 'je', contact: null, email: 'jo.old@example.com', first: 'Jo', last: 'Ray', amount: 70000 }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_a_work', org: 'p:acme' });
  await doIt({ act: 'same', a: 'c:ct_a_work', b: 'c:ct_b_home', same: true });
  await doIt({ act: 'same', a: 'c:ct_a_work', b: 'e:jo.old@example.com', same: true });
  let people = await list();
  assert.equal(people.find((p) => p.key === 'p:acme')?.total, 10000, 'only the work contact’s gift');
  assert.equal(people.find((p) => p.name === 'Jo Ray')?.total, 90000);
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_b_home', org: 'p:acme' });
  people = await list();
  assert.equal(people.find((p) => p.key === 'p:acme')?.total, 100000, 'every contact of theirs is Acme’s: all of it');
});

test('two people sharing an email: one kept anonymous hides only gifts with no contact under it, and the other’s toggle works', async () => {
  await add(pay({ id: 'al1', contact: 'ct_al', email: 'home@example.com', first: 'Al', last: 'Moss', created: S(NOW - 3 * DAY) }), pay({ id: 'be1', contact: 'ct_bea', email: 'home@example.com', first: 'Bea', last: 'Moss', created: S(NOW - 2 * DAY) }),
    pay({ id: 'be2', contact: 'ct_bea', email: 'bea@work.example', first: 'Bea', last: 'Moss' }), pay({ id: 'lo1', contact: null, email: 'home@example.com', first: 'Al', last: 'Moss' }));
  await doIt({ act: 'same', a: 'c:ct_al', b: 'c:ct_bea', same: false });
  await doIt({ act: 'anon', key: 'c:ct_al', on: true });
  const bea = (await list()).find((p) => p.key === 'c:ct_bea');
  assert.equal(bea.keepAnonymous, false, 'Bea isn’t kept by Al’s setting');
  const by = await board([boardRow('al1', 'Al Moss', 'ct_al'), boardRow('be1', 'Bea Moss', 'ct_bea'), boardRow('be2', 'Bea Moss', 'ct_bea'), boardRow('lo1', 'Al Moss')]);
  assert.deepEqual(by, { al1: true, be1: false, be2: false, lo1: true });
});

test('the board places a gift it has before the donor list does with its contact’s records (kept by email)', async () => {
  await add(pay({ id: 'nb1', contact: null, email: 'nb@example.com', first: 'Nell', last: 'Bow' }));
  await doIt({ act: 'anon', key: 'e:nb@example.com', on: true });
  await add(pay({ id: 'nb2', contact: 'ct_nell', email: 'nb@example.com', first: 'Nell', last: 'Bow' }));
  // nb3 reached the board's own read but not the donor list yet
  const by = await board([boardRow('nb3', 'Nell Bow', 'ct_nell')]);
  assert.equal(by.nb3, true);
});

test('turning Keep anonymous off clears it for a person joined with a record that has no email', async () => {
  await add(pay({ id: 'ka', contact: 'ct_ka', email: 'ka@example.com', first: 'Kim', last: 'Ash' }), pay({ id: 'kb', contact: 'ct_kb', email: 'kb@example.com', first: 'Kim', last: 'Ash' }), pay({ id: 'kn', contact: null, email: '', first: 'Kim', last: 'Ash' }));
  await doIt({ act: 'same', a: 'c:ct_ka', b: 'c:ct_kb', same: true });
  await doIt({ act: 'same', a: 'c:ct_ka', b: 'n:kim ash', same: true });
  await doIt({ act: 'anon', key: 'e:kb@example.com', on: true });
  assert.equal((await list()).find((p) => p.key === 'c:ct_ka').keepAnonymous, true);
  await doIt({ act: 'anon', key: 'c:ct_ka', on: false });
  assert.equal((await list()).find((p) => p.key === 'c:ct_ka').keepAnonymous, false);
});

test('a Zeffy merge keeps the gone contact’s link over the kept one’s “no” for the same organization', async () => {
  await add(pay({ id: 'zz1', contact: 'ct_old', first: 'Cy', last: 'Dean', email: 'cy@example.com' }), pay({ id: 'zz2', contact: 'ct_new', first: 'Cy', last: 'Dean', email: 'cy2@example.com' }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_old', org: 'p:beta' });
  await doIt({ act: 'not', kind: 'contact', subject: 'ct_new', org: 'p:beta' });
  await add(pay({ id: 'zz1', contact: 'ct_new', first: 'Cy', last: 'Dean', email: 'cy2@example.com' }));
  await C.followMerges(db, { now: NOW });
  assert.equal((await C.loadCrm(db, { now: NOW })).calls.yes.get('contact\nct_new'), 'p:beta');
});

test('a partner’s level counts what wasn’t given anonymously; Put on the website, asked again after it went through, says where it went', async () => {
  await add(pay({ id: 'c1', contact: 'ct_open', email: 'o@example.com', first: 'Olive', last: 'Open', company: 'Acme Builders', amount: 1200000 }), pay({ id: 'c2', contact: 'ct_quiet', email: 'q@example.com', first: 'Quinn', last: 'Ash', company: 'Acme Builders', amount: 300000 }));
  await doIt({ act: 'anon', key: 'c:ct_quiet', on: true });
  const lv = (await needs()).find((i) => i.kind === 'level');
  assert.equal(lv?.cents12, 1200000, 'suggested on the $12,000 given openly');
  assert.equal((await C.orgSummary(env, 'p:acme', { now: NOW })).suggest, true);
  const { key } = await doIt({ act: 'org-new', name: 'Late Fund' });
  await db.prepare(partner('late-fund', 'Late Fund')).run();
  assert.equal((await doIt({ act: 'website', key, slug: 'late-fund' })).key, 'p:late-fund');
  assert.equal((await doIt({ act: 'website', key, slug: 'late-fund' })).key, 'p:late-fund', 'again: done already');
  // People to join: never a gift with no contact, email or name
  await add(pay({ id: 'nx', contact: null, email: '', first: '', last: '' }));
  assert.ok(!(await C.findPeople(env, 'no', { now: NOW })).people.some((p) => p.key.startsWith('x:')));
});

// ─── Review round 8 ─────────────────────────────────────────────────

test('the board hides a kept giver’s Zeffy duplicate or merged-away record, unless staff said they’re someone else', async () => {
  // Merged: ct_old kept; Zeffy moved one of its gifts to ct_new, which shares its email
  await add(pay({ id: 'o1', contact: 'ct_old', email: 'dup@example.com', first: 'Dee', last: 'Up', created: S(NOW - 200 * DAY) }), pay({ id: 'o2', contact: 'ct_old', email: 'dup@example.com', first: 'Dee', last: 'Up' }), pay({ id: 'n1', contact: 'ct_new', email: 'dup@example.com', first: 'Dee', last: 'Up' }));
  await doIt({ act: 'anon', key: 'c:ct_old', on: true });
  await add(pay({ id: 'o2', contact: 'ct_new', email: 'dup@example.com', first: 'Dee', last: 'Up' }));
  let by = await board([boardRow('o2', 'Dee Up', 'ct_new'), boardRow('n1', 'Dee Up', 'ct_new')]);
  assert.deepEqual(by, { o2: true, n1: true });
  // Said to be someone else: their own gift shows
  await doIt({ act: 'same', a: 'c:ct_old', b: 'c:ct_new', same: false });
  by = await board([boardRow('n1', 'Dee Up', 'ct_new')]);
  assert.equal(by.n1, false);
});

test('the board reads every record of a joined person, so one kept by email hides their other contact’s gift', async () => {
  await add(pay({ id: 'e1', contact: null, email: 'nell@example.com', first: 'Nell', last: 'Bow' }));
  await doIt({ act: 'anon', key: 'e:nell@example.com', on: true });
  await add(pay({ id: 'e2', contact: 'ct_nell', email: 'nell@example.com', first: 'Nell', last: 'Bow' }), pay({ id: 'w1', contact: 'ct_work', email: 'nell@work.example', first: 'Nell', last: 'Bow' }));
  await doIt({ act: 'same', a: 'c:ct_nell', b: 'c:ct_work', same: true });
  assert.equal((await board([boardRow('w1', 'Nell Bow', 'ct_work')])).w1, true);
});

test('a joined record with no contact is hidden when any contact of theirs is a kept organization, by link or by name', async () => {
  await doIt({ act: 'anon', key: 'p:pella', on: true });
  await add(pay({ id: 'pc', contact: 'ct_pella', email: 'ap@pella.example', first: 'Pella', last: 'Pella' }), pay({ id: 'pn', contact: null, email: 'old@pella.example', first: 'Pella', last: 'Pella' }));
  await doIt({ act: 'same', a: 'c:ct_pella', b: 'e:old@pella.example', same: true });
  assert.equal((await board([boardRow('pn', 'Pella')])).pn, true, 'linked by name');
  await db.prepare(partner('gamma', 'Gamma Co')).run();
  await doIt({ act: 'anon', key: 'p:gamma', on: true });
  await add(pay({ id: 'ga', contact: 'ct_ga', email: 'g1@example.com', first: 'Gil', last: 'Ames' }), pay({ id: 'gb', contact: 'ct_gb', email: 'g2@example.com', first: 'Gil', last: 'Ames' }), pay({ id: 'gn', contact: null, email: 'g3@example.com', first: 'Gil', last: 'Ames' }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_ga', org: 'p:gamma' });
  await doIt({ act: 'same', a: 'c:ct_ga', b: 'c:ct_gb', same: true });
  await doIt({ act: 'same', a: 'c:ct_ga', b: 'e:g3@example.com', same: true });
  assert.equal((await board([boardRow('gn', 'Gil Ames')])).gn, true, 'one contact linked to a kept organization');
});

test('a deleted partner kept anonymous still hides the gifts that named it', async () => {
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_lk', org: 'p:acme' });
  await add(pay({ id: 'd1', contact: 'ct_lk', email: 'lk@example.com', first: 'Lin', last: 'Kay' }), pay({ id: 'd2', contact: 'ct_ov', email: 'ov@example.com', first: 'Ova', last: 'Rid' }), pay({ id: 'd3', contact: 'ct_co', email: 'co@example.com', first: 'Cole', last: 'Oak', company: 'Acme Builders' }));
  await doIt({ act: 'link', kind: 'company', subject: 'Acme Builders', org: 'p:acme' });
  await doIt({ act: 'payment', id: 'd2', owner: 'p:acme' });
  await db.prepare("DELETE FROM partners WHERE slug = 'acme'").run();
  assert.deepEqual(await board([boardRow('d1', 'Lin Kay', 'ct_lk'), boardRow('d2', 'Ova Rid', 'ct_ov'), boardRow('d3', 'Cole Oak', 'ct_co')]), { d1: true, d2: true, d3: true });
});

test('turning one person off doesn’t free others an email kept before Zeffy had a contact was keeping', async () => {
  await add(pay({ id: 'h0', contact: null, email: 'home@example.com', first: 'Al', last: 'Moss', created: S(NOW - 9 * DAY) }));
  await doIt({ act: 'anon', key: 'e:home@example.com', on: true });
  await add(pay({ id: 'h1', contact: 'ct_al', email: 'home@example.com', first: 'Al', last: 'Moss', created: S(NOW - 5 * DAY) }), pay({ id: 'h2', contact: 'ct_bea', email: 'home@example.com', first: 'Bea', last: 'Moss', created: S(NOW - 2 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_al', b: 'c:ct_bea', same: false });
  await doIt({ act: 'anon', key: 'c:ct_bea', on: false });
  const people = await list();
  assert.equal(people.find((p) => p.key === 'c:ct_bea').keepAnonymous, false);
  assert.equal(people.find((p) => p.key === 'c:ct_al').keepAnonymous, true, 'Al stays kept');
  assert.equal((await board([boardRow('h1', 'Al Moss', 'ct_al')])).h1, true);
});

test('taking a record out of a person led by a record with no contact gives the page an address', async () => {
  await add(pay({ id: 'l1', contact: null, email: '', first: 'Lou', last: 'Nash' }), pay({ id: 'l2', contact: null, email: 'lou@example.com', first: 'Lou', last: 'Nash' }), pay({ id: 'l3', contact: null, email: 'lou2@example.com', first: 'Lou', last: 'Nash' }));
  await doIt({ act: 'same', a: 'e:lou@example.com', b: 'n:lou nash', same: true });
  await doIt({ act: 'same', a: 'e:lou2@example.com', b: 'n:lou nash', same: true });
  const r = await doIt({ act: 'split', key: 'n:lou nash' });
  assert.match(r.ref, /^g:/);
});

test('a gift still asked about (two organizations) doesn’t count toward Champion yet', async () => {
  await db.prepare(partner('gamma', 'Gamma Co')).run();
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_gx', org: 'p:gamma' });
  await add(pay({ id: 'cx', contact: 'ct_gx', email: 'gx@example.com', first: 'Gus', last: 'Xu', company: 'Acme Builders', amount: 1100000 }));
  const items = await needs();
  assert.ok(items.some((i) => i.kind === 'clash'));
  assert.ok(!items.some((i) => i.kind === 'level'));
});

// ─── Review round 9 ─────────────────────────────────────────────────

const splitRow = (id, name, charges) => ({ ...boardRow(id, name, charges[0].contact), charges: charges.map((c) => ({ id: c.id, contact: c.contact || '', company: c.company || '', name: c.name || name, method: 'card' })) });

test('the board checks every charge of a gift Zeffy took in several', async () => {
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  await doIt({ act: 'anon', key: 'c:ct_rae2', on: true });
  await add(pay({ id: 's1a', contact: 'ct_sam', email: 'sam@example.com', first: 'Sam', last: 'Hill', amount: 400000 }), pay({ id: 's1b', contact: 'ct_sam', email: 'sam@example.com', first: 'Sam', last: 'Hill', company: 'Acme Builders', amount: 400000 }));
  await add(pay({ id: 'r1a', contact: 'ct_rae1', email: 'rae1@example.com', first: 'Rae', last: 'Lin', amount: 300000 }), pay({ id: 'r1b', contact: 'ct_rae2', email: 'rae2@example.com', first: 'Rae', last: 'Lin', amount: 250000 }));
  await doIt({ act: 'same', a: 'c:ct_rae1', b: 'c:ct_rae2', same: false });
  const by = await board([
    splitRow('s1a', 'Sam Hill', [{ id: 's1a', contact: 'ct_sam' }, { id: 's1b', contact: 'ct_sam', company: 'Acme Builders' }]),
    splitRow('r1a', 'Rae Lin', [{ id: 'r1a', contact: 'ct_rae1' }, { id: 'r1b', contact: 'ct_rae2' }]),
  ]);
  assert.deepEqual(by, { s1a: true, r1a: true });
});

test('the board hides by its own read too: a contact or company Zeffy changed since the donor list last read it', async () => {
  await doIt({ act: 'anon', key: 'c:ct_kay', on: true });
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  await add(pay({ id: 'k1', contact: 'ct_kay', email: 'kay@example.com', first: 'Kay', last: 'Low' }), pay({ id: 'd1', contact: 'ct_dup', email: 'dupe@example.com', first: 'Kay', last: 'Low' }), pay({ id: 'c1', contact: 'ct_cy', email: 'cy@example.com', first: 'Cy', last: 'Moe' }));
  const by = await board([boardRow('d1', 'Kay Low', 'ct_kay'), { ...boardRow('c1', 'Cy Moe', 'ct_cy'), company: 'Acme Builders' }]);
  assert.deepEqual(by, { d1: true, c1: true });
});

test('a kept organization’s names keep hiding after it is deleted, merged into another or renamed', async () => {
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  await doIt({ act: 'anon', key: 'p:pella', on: true });
  await add(pay({ id: 'x1', contact: 'ct_x1', email: 'x1@example.com', first: 'Xi', last: 'One', company: 'Acme Builders' }), pay({ id: 'x2', contact: 'ct_pella', email: 'ap@pella.example', first: 'Pella', last: 'Pella' }));
  await db.prepare("DELETE FROM partners WHERE slug IN ('acme', 'pella')").run();
  assert.deepEqual(await board([boardRow('x1', 'Xi One', 'ct_x1'), boardRow('x2', 'Pella', 'ct_pella')]), { x1: true, x2: true }, 'deleted');
  await db.prepare(partner('acme', 'Acme Builders')).run();
  await C.mergeOrgCalls(db, 'acme', 'beta');
  await db.prepare("DELETE FROM partners WHERE slug = 'acme'").run();
  assert.equal((await board([boardRow('x1', 'Xi One', 'ct_x1')])).x1, true, 'merged into Beta, which is kept now');
  const { key } = await doIt({ act: 'org-new', name: 'Quiet Fund' });
  await doIt({ act: 'anon', key, on: true });
  await doIt({ act: 'org-rename', key, name: 'Quiet Family Fund' });
  await add(pay({ id: 'q1', contact: 'ct_q1', email: 'q1@example.com', first: 'Quin', last: 'Ode', company: 'Quiet Fund' }));
  assert.equal((await board([boardRow('q1', 'Quin Ode', 'ct_q1')])).q1, true, 'its old name still hides');
});

test('a gift with no contact placed with a joined contact is checked with all their records', async () => {
  await add(pay({ id: 'mk', contact: null, email: 'mia.old@example.com', first: 'Mia', last: 'Ross' }));
  await doIt({ act: 'anon', key: 'e:mia.old@example.com', on: true });
  await add(pay({ id: 'm1', contact: 'ct_mia1', email: 'mia.old@example.com', first: 'Mia', last: 'Ross', created: S(NOW - 3 * DAY) }), pay({ id: 'm2', contact: 'ct_mia2', email: 'mia@example.com', first: 'Mia', last: 'Ross', created: S(NOW - 2 * DAY) }), pay({ id: 'm3', contact: null, email: 'mia@example.com', first: 'Mia', last: 'Ross' }));
  await doIt({ act: 'same', a: 'c:ct_mia1', b: 'c:ct_mia2', same: true });
  assert.equal((await board([boardRow('m3', 'Mia Ross')])).m3, true);
});

test('a deleted partner a joined record’s contact was linked to still hides that record’s gift', async () => {
  await doIt({ act: 'anon', key: 'p:beta', on: true });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_bz', org: 'p:beta' });
  await add(pay({ id: 'bz1', contact: 'ct_bz', email: 'bz@example.com', first: 'Bo', last: 'Zane' }), pay({ id: 'bz2', contact: null, email: 'bz.old@example.com', first: 'Bo', last: 'Zane' }));
  await doIt({ act: 'same', a: 'c:ct_bz', b: 'e:bz.old@example.com', same: true });
  await db.prepare("DELETE FROM partners WHERE slug = 'beta'").run();
  assert.equal((await board([boardRow('bz2', 'Bo Zane')])).bz2, true);
});

test('turning off someone joined to a kept email keeps the others that email was keeping; a new contact with a kept email is hidden until the list has it', async () => {
  await add(pay({ id: 'f0', contact: null, email: 'fam@example.com', first: 'Al', last: 'Fam', created: S(NOW - 9 * DAY) }), pay({ id: 'fa', contact: 'ct_al', email: 'al@example.com', first: 'Al', last: 'Fam' }), pay({ id: 'fb', contact: 'ct_bea', email: 'fam@example.com', first: 'Bea', last: 'Fam' }));
  await doIt({ act: 'anon', key: 'e:fam@example.com', on: true });
  await doIt({ act: 'same', a: 'c:ct_al', b: 'e:fam@example.com', same: true });
  await doIt({ act: 'anon', key: 'c:ct_al', on: false });
  assert.equal((await list()).find((p) => p.key === 'c:ct_bea').keepAnonymous, true, 'Bea stays kept');
  await doIt({ act: 'anon', key: 'e:zed@example.com', on: true });
  assert.equal((await board([boardRow('zz', 'Zed New', 'ct_brand_new')])).zz, true);
});

test('a person kept only because they share an email with someone kept says so, and “not the same” frees them', async () => {
  await add(pay({ id: 'o1', contact: 'ct_o1', email: 'office@example.com', first: 'Ola', last: 'One' }), pay({ id: 'o2', contact: 'ct_o2', email: 'office@example.com', first: 'Oto', last: 'Two' }));
  await doIt({ act: 'anon', key: 'c:ct_o1', on: true });
  let v = await C.personView(env, 'ct_o2', { now: NOW });
  assert.equal(v.keepAnonymous, true);
  assert.deepEqual([v.keptWhy.kind, v.keptWhy.other, v.keptWhy.otherName], ['shared', 'c:ct_o1', 'Ola One']);
  await doIt({ act: 'same', a: 'c:ct_o1', b: 'c:ct_o2', same: false });
  v = await C.personView(env, 'ct_o2', { now: NOW });
  assert.equal(v.keepAnonymous, false);
});

// ─── Review round 10 ────────────────────────────────────────────────

test('a kept partner renamed in the Partners editor, again and again, stays hidden under every name it had', async () => {
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  await add(pay({ id: 'a1', contact: 'ct_a1', email: 'a1@example.com', first: 'Al', last: 'One', company: 'Acme Builders' }), pay({ id: 'a2', contact: 'ct_a2', email: 'a2@example.com', first: 'Al', last: 'Two', company: 'Acme Homes' }));
  // Renamed in the Partners editor (its record and saved versions), the site seeing each name on the board
  await db.prepare("UPDATE partners SET data = ? WHERE slug = 'acme'").bind(JSON.stringify({ name: 'Acme Homes', level: 'friend', category: ['funding'] })).run();
  await board([boardRow('a1', 'Al One', 'ct_a1')]);
  await db.prepare("UPDATE partners SET data = ? WHERE slug = 'acme'").bind(JSON.stringify({ name: 'Acme Living', level: 'friend', category: ['funding'] })).run();
  assert.deepEqual(await board([boardRow('a1', 'Al One', 'ct_a1'), boardRow('a2', 'Al Two', 'ct_a2')]), { a1: true, a2: true });
  // Off and on again: still every name
  await doIt({ act: 'anon', key: 'p:acme', on: false });
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  assert.deepEqual(await board([boardRow('a1', 'Al One', 'ct_a1'), boardRow('a2', 'Al Two', 'ct_a2')]), { a1: true, a2: true });
  assert.ok((await C.orgView(env, 'p:acme', { now: NOW })).keptNames.length >= 3, 'its page lists the names it’s hidden under');
});

test('a name a kept partner had in its saved versions is hidden, and a kept partner merged away keeps its names', async () => {
  await db.prepare('CREATE TABLE IF NOT EXISTS content_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, slug TEXT NOT NULL, data TEXT NOT NULL, action TEXT NOT NULL DEFAULT \'save\', user_email TEXT, created_at TEXT NOT NULL)').run();
  await db.prepare("INSERT INTO content_versions (collection, slug, data, created_at) VALUES ('partners', 'pella', ?, '2025-01-01')").bind(JSON.stringify({ name: 'Pella Windows of Atlanta' })).run();
  await doIt({ act: 'anon', key: 'p:pella', on: true });
  await add(pay({ id: 'pw', contact: 'ct_pw', email: 'pw@example.com', first: 'Pat', last: 'Wee', company: 'Pella Windows of Atlanta' }));
  assert.equal((await board([boardRow('pw', 'Pat Wee', 'ct_pw')])).pw, true);
  // Unkept Gamma merged into kept Beta: gifts typed "Gamma Co" count for Beta and hide
  await db.prepare(partner('gamma', 'Gamma Co')).run();
  await doIt({ act: 'anon', key: 'p:beta', on: true });
  await add(pay({ id: 'gm', contact: 'ct_gm', email: 'gm@example.com', first: 'Gia', last: 'May', company: 'Gamma Co', amount: 30000 }));
  await C.mergeOrgCalls(db, 'gamma', 'beta');
  await db.prepare("DELETE FROM partners WHERE slug = 'gamma'").run();
  assert.equal((await list()).find((p) => p.key === 'p:beta')?.total, 30000);
  assert.equal((await board([boardRow('gm', 'Gia May', 'ct_gm')])).gm, true);
});

test('a kept organization’s name typed another way is hidden: legal endings, plurals, accents', async () => {
  await db.prepare(partner('cafe', 'Café Noir')).run();
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  await doIt({ act: 'anon', key: 'p:cafe', on: true });
  const names = ['Acme Builders, L.L.C.', 'Acme Builders Corporation', 'Acme Builder', 'ACME BUILDERS LTD.', 'Acme Builders Foundation', 'Cafe Noir'];
  const gifts = [];
  for (const [i, n] of names.entries()) { await add(pay({ id: `v${i}`, contact: `ct_v${i}`, email: `v${i}@example.com`, first: 'Vi', last: `N${i}`, company: n })); gifts.push(boardRow(`v${i}`, `Vi N${i}`, `ct_v${i}`)); }
  await add(pay({ id: 'vx', contact: 'ct_vx', email: 'vx@example.com', first: 'Vic', last: 'Ex', company: 'Zenith Roofing' }));
  gifts.push(boardRow('vx', 'Vic Ex', 'ct_vx'));
  const by = await board(gifts);
  assert.deepEqual(Object.entries(by).filter(([, h]) => !h).map(([id]) => id), ['vx'], 'only the unrelated company shows');
});

test('the board: a kept person’s new Zeffy record not in the list yet is hidden; its own name counts; a hidden gift’s campaign doesn’t name it', async () => {
  await doIt({ act: 'anon', key: 'c:ct_jane', on: true });
  await add(pay({ id: 'rn', contact: 'ct_ron', email: 'ron@example.com', first: 'Ron', last: 'Neal' }));
  await doIt({ act: 'anon', key: 'p:pella', on: true });
  const { giftsNow } = await import('../functions/api/_board-gifts.js');
  const { writeState } = await import('../functions/api/_board-roles.js');
  const rows = [boardRow('dup1', 'Jane Doe', 'ct_jane_dup'), boardRow('rn', 'Pella', 'ct_ron'), { ...boardRow('sp', 'Sam Pell', 'ct_sp'), company: 'Pella', campaign: 'Pella Golf Title Sponsor' },
    { ...boardRow('old', 'Old Two', 'ct_x'), parts: 2 }];
  await add(pay({ id: 'sp', contact: 'ct_sp', email: 'sp@example.com', first: 'Sam', last: 'Pell', company: 'Pella' }), pay({ id: 'old', contact: 'ct_x', email: 'x@example.com', first: 'Old', last: 'Two' }));
  await writeState(db, 'gifts', { year: 2026, list: rows, at: new Date(NOW).toISOString(), triedAt: new Date(NOW).toISOString() });
  const v = await giftsNow(db, { now: NOW });
  const by = Object.fromEntries(v.list.map((g) => [g.id, g]));
  assert.equal(by.dup1.anonymous, true, 'not in the list yet');
  assert.equal(by.rn.anonymous, true, 'Zeffy renamed the contact to a kept name');
  assert.equal(by.sp.anonymous, true);
  assert.equal(by.sp.campaign, 'A gift', 'the campaign named the kept partner');
  assert.equal(by.old.anonymous, true, 'saved before every charge was kept');
});

// ─── Review round 11 ────────────────────────────────────────────────

async function boardList(rows) {
  const { giftsNow } = await import('../functions/api/_board-gifts.js');
  const { writeState } = await import('../functions/api/_board-roles.js');
  await writeState(db, 'gifts', { year: 2026, list: rows, at: new Date(NOW).toISOString(), triedAt: new Date(NOW).toISOString() });
  return Object.fromEntries((await giftsNow(db, { now: NOW })).list.map((g) => [g.id, g]));
}

test('an anonymous gift’s campaign never names the giver or a kept organization, the form’s anonymous box included', async () => {
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  await add(pay({ id: 'fa', contact: 'ct_fa', email: 'fa@example.com', first: 'Fay', last: 'Ann', company: 'Acme Builders', anonymous: true }), pay({ id: 'fb', contact: 'ct_fb', email: 'fb@example.com', first: 'Fib', last: 'Bee', company: 'Acme Builders' }), pay({ id: 'fk', contact: 'ct_kay', email: 'kay@example.com', first: 'Kay', last: 'Low', anonymous: true }));
  const by = await boardList([
    { ...boardRow('fa', '', 'ct_fa'), anonymous: true, company: '', campaign: 'Acme Builders Golf Title Sponsor', charges: [{ id: 'fa', contact: 'ct_fa', company: 'Acme Builders', name: 'Fay Ann', method: 'card' }] },
    { ...boardRow('fb', 'Fib Bee', 'ct_fb'), company: 'Acme Builders', campaign: 'ACME Builder’s Golf Classic' },
    { ...boardRow('fk', '', 'ct_kay'), anonymous: true, campaign: 'Kay Low Family Match', charges: [{ id: 'fk', contact: 'ct_kay', company: '', name: 'Kay Low', method: 'card' }] },
    { ...boardRow('ok', 'Open Gift', 'ct_open'), campaign: 'Evening of Sunshine' },
  ]);
  assert.equal(by.fa.campaign, 'A gift');
  assert.equal(by.fb.campaign, 'A gift');
  assert.equal(by.fk.campaign, 'A gift');
  assert.equal(by.ok.campaign, 'Evening of Sunshine', 'a gift not in the list yet hides its name, but a plain campaign stays');
});

test('a partner renamed, then kept, then merged away still hides under its first name; a fund gift or a contact typed as a kept name is hidden', async () => {
  await db.prepare('CREATE TABLE IF NOT EXISTS content_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, slug TEXT NOT NULL, data TEXT NOT NULL, action TEXT NOT NULL DEFAULT \'save\', user_email TEXT, created_at TEXT NOT NULL)').run();
  await db.prepare(partner('gamma', 'Gamma Homes')).run();
  await db.prepare("INSERT INTO content_versions (collection, slug, data, created_at) VALUES ('partners', 'gamma', ?, '2025-01-01')").bind(JSON.stringify({ name: 'Gamma Co' })).run();
  await doIt({ act: 'anon', key: 'p:gamma', on: true });
  await C.mergeOrgCalls(db, 'gamma', 'beta');
  await db.prepare("DELETE FROM partners WHERE slug = 'gamma'").run();
  await db.prepare("DELETE FROM content_versions WHERE slug = 'gamma'").run();
  await add(pay({ id: 'gc', contact: 'ct_gc', email: 'gc@example.com', first: 'Gil', last: 'Cee', company: 'Gamma Co' }));
  assert.equal((await board([boardRow('gc', 'Gil Cee', 'ct_gc')])).gc, true);
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  await add(pay({ id: 'df', contact: 'ct_df', email: 'df@example.com', first: 'Dee', last: 'Eff', method: 'daf', company: 'Acme Builders' }), pay({ id: 'cn', contact: 'ct_cn', email: 'cn@example.com', first: 'Acme Builders', last: 'LLC' }));
  assert.deepEqual(await board([boardRow('df', 'Dee Eff', 'ct_df'), boardRow('cn', 'Acme Builders LLC', 'ct_cn')]), { df: true, cn: true });
});

test('a kept name hides itself typed another way, never every company that starts with it', async () => {
  await db.prepare(partner('delta', 'Delta')).run();
  await doIt({ act: 'anon', key: 'p:delta', on: true });
  await doIt({ act: 'anon', key: 'p:acme', on: true });
  const names = [['dl', 'Delta Air Lines'], ['df', 'Delta Faucet'], ['ar', 'Acme Roofing'], ['ah', 'Acme Home Builders'], ['d1', 'Delta, Inc.'], ['a1', 'Acme Bulders']];
  const gifts = [];
  for (const [id, n] of names) { await add(pay({ id, contact: `ct_${id}`, email: `${id}@example.com`, first: 'Who', last: id, company: n })); gifts.push(boardRow(id, `Who ${id}`, `ct_${id}`)); }
  const by = await board(gifts);
  assert.deepEqual(by, { dl: false, df: false, ar: false, ah: false, d1: true, a1: true });
});

// ─── Review round 12 ────────────────────────────────────────────────

test('through the board’s own read: a form-anonymous giver’s name in the campaign is replaced; a short kept name counts as a word', async () => {
  const { giftsOf, giftsNow } = await import('../functions/api/_board-gifts.js');
  const { writeState } = await import('../functions/api/_board-roles.js');
  await db.prepare(partner('ups', 'UPS')).run();
  await doIt({ act: 'anon', key: 'p:ups', on: true });
  const zp = (id, o) => ({ ...pay({ id, amount: 200000, ...o }), description: o.description });
  const payments = [zp('pay_fk', { contact: 'ct_kay', email: 'kay@example.com', first: 'Kay', last: 'Low', anonymous: true, description: 'Kay Low Family Match' }),
    zp('pay_fu', { contact: 'ct_u', email: 'u@example.com', first: 'Uma', last: 'Ple', company: 'UPS', description: 'UPS Golf Title Sponsor' }),
    zp('pay_fs', { contact: 'ct_s', email: 's@example.com', first: 'Sol', last: 'Ray', anonymous: true, description: 'Evening of Sunshine' })];
  for (const x of payments) await add(x);
  await writeState(db, 'gifts', { year: 2026, list: giftsOf(payments), at: new Date(NOW).toISOString(), triedAt: new Date(NOW).toISOString() });
  const by = Object.fromEntries((await giftsNow(db, { now: NOW })).list.map((g) => [g.id, g]));
  assert.equal(by.pay_fk.campaign, 'A gift');
  assert.equal(by.pay_fu.anonymous, true);
  assert.equal(by.pay_fu.campaign, 'A gift');
  assert.equal(by.pay_fs.campaign, 'Evening of Sunshine');
  assert.ok(!JSON.stringify(by).includes('Kay'), 'the giver’s name is nowhere in what the board gets');
});

test('a kept person giving from a new Zeffy record with a new email is hidden by their name until staff say it’s someone else', async () => {
  await add(pay({ id: 'k1', contact: 'ct_kay', email: 'kay@example.com', first: 'Kay', last: 'Low' }), pay({ id: 'k2', contact: 'ct_kay_new', email: 'kay.new@example.com', first: 'Kay', last: 'Low' }));
  await doIt({ act: 'anon', key: 'c:ct_kay', on: true });
  assert.equal((await board([boardRow('k2', 'Kay Low', 'ct_kay_new')])).k2, true);
  const v = await C.personView(env, 'ct_kay_new', { now: NOW });
  assert.equal(v.keptWhy.kind, 'name');
  await doIt({ act: 'same', a: 'c:ct_kay', b: 'c:ct_kay_new', same: false });
  assert.equal((await board([boardRow('k2', 'Kay Low', 'ct_kay_new')])).k2, false);
});

test('a contact staff said isn’t a kept partner named for a person is never hidden as it', async () => {
  await db.prepare(partner('jsf', 'John Smith')).run();
  await doIt({ act: 'anon', key: 'p:jsf', on: true });
  await add(pay({ id: 'js', contact: 'ct_js', email: 'js@example.com', first: 'John', last: 'Smith' }));
  await doIt({ act: 'not', kind: 'contact', subject: 'ct_js', org: 'p:jsf' });
  assert.equal((await board([boardRow('js', 'John Smith', 'ct_js')])).js, false);
});

test('a big giver under one name twice (a company typed on gifts, and a Zeffy contact of that name) is asked about once; Not now holds for both', async () => {
  await add(pay({ id: 'bb1', contact: 'ct_vf', first: 'Vale Family', last: 'Foundation', email: 'grants@valefamily.example', company: 'Vale Family Foundation', amount: 3000000, created: S(NOW - 30 * DAY) }));
  const big = (await needs()).filter((x) => x.kind === 'big');
  assert.equal(big.length, 1, 'one question, not two');
  assert.equal(big[0].name, 'Vale Family Foundation');
  assert.deepEqual(big[0].also, ['contact:ct_vf']);
  await doIt({ act: 'big', subject: big[0].subject, also: big[0].also });
  assert.equal((await needs()).filter((x) => x.kind === 'big').length, 0, 'not asked again under its other name');
});

test('three records of one name: one Same person? at a time, the next once that one is answered', async () => {
  await add(pay({ id: 'rv1', contact: 'ct_rv1', first: 'Rita', last: 'Vance', email: 'rita1@example.com', amount: 5000 }));
  await add(pay({ id: 'rv2', contact: 'ct_rv2', first: 'Rita A.', last: 'Vance', email: 'rita2@example.com', amount: 6000 }));
  await add(pay({ id: 'rv3', contact: 'ct_rv3', first: 'RITA', last: 'VANCE', email: 'rita3@example.com', amount: 7000 }));
  let same = (await needs()).filter((x) => x.kind === 'same');
  assert.equal(same.length, 1);
  await doIt({ act: 'same', a: same[0].a.key, b: same[0].b.key, same: true });
  same = (await needs()).filter((x) => x.kind === 'same');
  assert.equal(same.length, 1, 'the third record, asked about next');
  await doIt({ act: 'same', a: same[0].a.key, b: same[0].b.key, same: false });
  assert.equal((await needs()).filter((x) => x.kind === 'same').length, 0);
});
