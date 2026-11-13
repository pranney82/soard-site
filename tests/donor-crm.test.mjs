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
  // (followed as the gift came in, not at the next whole read: nothing left for it to do)
  const r = await C.followMerges(db, { now: NOW });
  assert.equal(r.moved, 0);
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

test('a record whose name reads as an organization’s is asked about at any amount; “It’s a person” ends it for good', async () => {
  await db.prepare('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)').run();
  await add(pay({ id: 'nf1', contact: 'ct_lark', first: 'Lark & Wren', last: 'Foundation', email: 'office@larkwren.example', amount: 100000, created: S(NOW - 200 * DAY) }));
  await add(pay({ id: 'nf2', contact: 'ct_sc', first: 'Sara', last: 'Church', email: 'sara@example.com', amount: 5000 }));
  let named = (await needs()).filter((x) => x.kind === 'named');
  assert.deepEqual(named.map((x) => [x.name, x.cents, x.person]), [['Lark & Wren Foundation', 100000, true], ['Sara Church', 5000, true]], 'most first, by all it gave');
  // A person whose name has one of the words in it
  await doIt({ act: 'big', subject: named[1].subject, also: named[1].also, person: true });
  named = (await needs()).filter((x) => x.kind === 'named');
  assert.deepEqual(named.map((x) => x.name), ['Lark & Wren Foundation']);
  const v = await C.personView(env, 'ct_sc', { now: NOW });
  assert.match(v.history[0]?.what || '', /person, not an organization/, 'in their History');
  // For good: even giving Champion's amount later, they aren't asked about as a big giver either
  await add(pay({ id: 'nf3', contact: 'ct_sc', first: 'Sara', last: 'Church', email: 'sara@example.com', amount: 2000000 }));
  assert.ok(!(await needs()).some((x) => x.subject === 'contact:ct_sc'));
  // Kept as an organization: its gifts are the organization's, and it isn't asked about again
  const r = await doIt({ act: 'org-new', name: named[0].name, links: [{ kind: named[0].link, subject: named[0].linkSubject }] });
  assert.equal((await list()).find((p) => p.key === r.key)?.total, 100000);
  assert.ok(!(await needs()).some((x) => x.kind === 'named' || x.kind === 'big'));
});

test('a name that reads as an organization’s and gave Champion’s amount is a big giver, and can be said to be a person', async () => {
  await add(pay({ id: 'nb1', contact: 'ct_hb', first: 'Harbor', last: 'Trust', email: 'trust@harbor.example', amount: 1500000, created: S(NOW - 20 * DAY) }));
  const it = (await needs()).find((x) => x.subject === 'contact:ct_hb');
  assert.equal(it.kind, 'big');
  assert.equal(it.person, true);
  await doIt({ act: 'big', subject: it.subject, also: it.also, person: true });
  assert.ok(!(await C.needsView(env, { now: NOW + 400 * DAY })).items.some((x) => x.subject === 'contact:ct_hb'), 'not asked again, a year on either');
});

test('Not now on a big giver holds a year; once under Champion’s amount, a name answered once isn’t asked about again', async () => {
  await add(pay({ id: 'nn1', contact: 'ct_ob', first: 'Oak Bay', last: 'Holdings', email: 'ob@example.com', amount: 1200000, created: S(NOW - 10 * DAY) }));
  const it = (await needs()).find((x) => x.subject === 'contact:ct_ob');
  assert.equal(it.kind, 'big');
  await doIt({ act: 'big', subject: it.subject, also: it.also });
  assert.ok(!(await needs()).some((x) => x.subject === 'contact:ct_ob'));
  // A year on its gift is older than 12 months: not a big giver, and already answered
  assert.ok(!(await C.needsView(env, { now: NOW + 366 * DAY })).items.some((x) => x.subject === 'contact:ct_ob'));
});

test('a record that reads as an organization’s but was said to be the same as a person isn’t asked about', async () => {
  await add(pay({ id: 'sj1', contact: 'ct_pf', first: 'Pine', last: 'Foundation', email: 'pine@example.com', amount: 30000 }));
  await add(pay({ id: 'sj2', contact: 'ct_pp', first: 'Pat', last: 'Pine', email: 'pat@example.com', amount: 20000 }));
  assert.ok((await needs()).some((x) => x.kind === 'named' && x.subject === 'contact:ct_pf'));
  await doIt({ act: 'same', a: 'c:ct_pf', b: 'c:ct_pp', same: true });
  assert.ok(!(await needs()).some((x) => x.kind === 'named'));
});

test('which names read as an organization’s', () => {
  for (const n of ['Lark Foundation', 'Smith & Co.', 'Smith & Co', 'Acme Co. Builders', 'Peachtree Rotary Club', 'Vale Homes', 'River LLC', 'North Group']) assert.ok(C.ORG_WORDS.test(n), n);
  for (const n of ['Coco Smith', 'Corey Coleman', 'Jane Doe', 'Fundy Clark', 'Trusty Lee', 'Cole Homeson']) assert.ok(!C.ORG_WORDS.test(n), n);
});

// ─── Found in review, Nov 12: Needs you, merges, History, the To thank pill ───

const withTeam = async () => {
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)',
    'CREATE TABLE IF NOT EXISTS staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
    `INSERT OR REPLACE INTO staff_state (key, data) VALUES ('directory', '${JSON.stringify({ ok: true, accounts: [{ email: 'alex@soardcharity.com', aliases: [], name: 'Alex Rivera', active: true }, { email: 'jordan@soardcharity.com', aliases: [], name: 'Jordan Hale', active: true }] })}')`,
  ]) await db.prepare(sql).run();
};

test('a contact whose gifts count for a partner already (its company is linked) is never asked “is it an organization?”', async () => {
  await add(pay({ id: 'sc1', contact: 'ct_smith', first: 'Smith', last: 'Construction', email: 'ap@smithc.example', company: 'Smith Construction Co LLC', amount: 50000 }));
  await doIt({ act: 'link', kind: 'company', subject: 'Smith Construction Co LLC', org: 'p:acme' });
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 50000);
  assert.ok(!(await needs()).some((i) => i.kind === 'named' || i.kind === 'big'), 'keeping it as another organization would take Acme’s gifts');
});

test('one question about a contact at a time: “is it that partner?” before “is it an organization?”', async () => {
  await db.prepare(partner('rotary', 'Peachtree Rotary Club')).run();
  await add(pay({ id: 'rc1', contact: 'ct_rc', first: 'Rotary', last: 'Club', email: 'treasurer@rc.example', amount: 30000 }));
  assert.deepEqual((await needs()).filter((i) => i.subject === 'ct_rc' || i.linkSubject === 'ct_rc').map((i) => i.kind), ['near']);
  await doIt({ act: 'not', kind: 'contact', subject: 'ct_rc', org: 'p:rotary' });
  assert.deepEqual((await needs()).filter((i) => i.linkSubject === 'ct_rc').map((i) => i.kind), ['named'], 'answered: the next question');
});

test('“It’s a person” is the contact’s alone: a $10,000 company of that name typed on others’ gifts is still asked about', async () => {
  await add(pay({ id: 'sf1', contact: 'ct_sff', first: 'Smith Family', last: 'Foundation', email: 'sff@example.com', amount: 50000 }));
  const it = (await needs()).find((i) => i.kind === 'named');
  await doIt({ act: 'big', subject: it.subject, also: it.also, person: true });
  await add(pay({ id: 'sf2', contact: 'ct_tr', first: 'Tina', last: 'Trustee', email: 'tina@example.com', company: 'Smith Family Foundation', amount: 1500000 }));
  const big = (await needs()).find((i) => i.kind === 'big');
  assert.match(big?.subject || '', /^company:/);
  assert.deepEqual(big.also, [], 'the contact said to be a person isn’t part of it');
});

test('a contact with no name is never asked about by its email (billing@peach-construction…)', async () => {
  await add(pay({ id: 'ne1', contact: 'ct_ne', first: '', last: '', email: 'billing@peach-construction.example', amount: 50000 }));
  assert.ok(!(await needs()).some((i) => i.kind === 'named'));
});

test('a Needs you answer someone gave first stands: a second tab’s answer changes nothing and says so', async () => {
  await withTeam();
  await add(pay({ id: 'q1', contact: 'ct_q1', first: 'Rae', last: 'Quinn', email: 'rae1@example.com' }), pay({ id: 'q2', contact: 'ct_q2', first: 'Rae', last: 'Quinn', email: 'rae2@example.com' }));
  const same = (await needs()).find((i) => i.kind === 'same');
  await doIt({ act: 'same', a: same.a.key, b: same.b.key, same: true, asked: true });
  await assert.rejects(C.act(env, { act: 'same', a: same.a.key, b: same.b.key, same: false, asked: true }, 'jordan@soardcharity.com', { now: NOW }), (e) => e.status === 409 && /Staff answered this already/.test(e.message));
  assert.equal((await C.loadCrm(db, { now: NOW })).canon('c:ct_q1'), (await C.loadCrm(db, { now: NOW })).canon('c:ct_q2'), 'still one person');
  // Not now holds a year: asked again after it, an answer counts
  await add(pay({ id: 'bg', contact: 'ct_bg', first: 'Birch', last: 'Holdings', email: 'birch@example.com', amount: 1500000 }));
  const big = (await needs()).find((i) => i.kind === 'big');
  await doIt({ act: 'big', subject: big.subject, asked: true });
  // The same answer again (sent twice, its answer lost): done already; another answer: refused
  assert.equal((await doIt({ act: 'big', subject: big.subject, asked: true })).same, true);
  await assert.rejects(doIt({ act: 'big', subject: big.subject, person: true, asked: true }), (e) => e.status === 409);
  await C.act(env, { act: 'big', subject: big.subject, asked: true }, by, { now: NOW + 400 * DAY });
});

test('Zeffy merges a contact known only for its owner, notes and History: all of it follows its gifts', async () => {
  await withTeam();
  await add(pay({ id: 'm1', contact: 'ct_old', first: 'Pat', last: 'Lee', email: 'pat@example.com', amount: 5000 }));
  await doIt({ act: 'owner', key: 'c:ct_old', email: 'alex@soardcharity.com' });
  await doIt({ act: 'note-add', key: 'c:ct_old', body: 'Prefers a call' });
  await add(pay({ id: 'm1', contact: 'ct_new', first: 'Pat', last: 'Lee', email: 'pat@example.com', amount: 5000 }));
  // (followed as the gift came in: the page shows all of it at once)
  const page = await C.personView(env, 'ct_new', { now: NOW });
  assert.equal(page.owner, 'alex@soardcharity.com');
  assert.deepEqual(page.notes.map((n) => n.body), ['Prefers a call']);
  assert.ok(page.history.some((h) => /Looked after by Alex Rivera/.test(h.what)) && page.history.some((h) => /Note added/.test(h.what)));
});

test('History stays with the donor: a record split off, an organization put on the website', async () => {
  await withTeam();
  await add(pay({ id: 's1', amount: 5000 }), pay({ id: 's2', amount: 5000, contact: 'ct_other', first: 'Jane', last: 'Doe', email: 'other@example.com' }));
  await doIt({ act: 'same', a: 'c:ct_jane', b: 'c:ct_other', same: true });
  const lead = (await C.loadCrm(db, { now: NOW })).canon('c:ct_other');
  await doIt({ act: 'note-add', key: lead, body: 'Keep' });
  const r = await doIt({ act: 'split', key: lead });
  const person = await C.personView(env, r.ref, { now: NOW });
  assert.ok(person.history.some((h) => /Note added/.test(h.what)), 'with the person, like the note');
  assert.ok(!(await C.personView(env, lead.slice(2), { now: NOW })).history.some((h) => /Note added/.test(h.what)), 'not the record split off');
  await add(pay({ id: 'o1', amount: 5000, company: 'Bright Futures LLC', contact: 'ct_bf', first: 'Kim', last: 'Ng', email: 'kim@example.com' }));
  const { key } = await doIt({ act: 'org-new', name: 'Bright Futures', links: [{ kind: 'company', subject: 'Bright Futures LLC' }] });
  await doIt({ act: 'note-add', key, body: 'Board member’s company' });
  await db.prepare(partner('bright-futures', 'Bright Futures')).run();
  await doIt({ act: 'website', key, slug: 'bright-futures' });
  assert.ok((await C.orgView(env, 'p:bright-futures', { now: NOW })).history.some((h) => /Note added/.test(h.what)));
});

test('a giver known by email, then given a Zeffy contact: their notes and owner go to it the moment the gift arrives', async () => {
  await withTeam();
  await add(pay({ id: 'nc1', contact: null, first: 'Lou', last: 'Park', email: 'lou@example.com', amount: 5000 }));
  const ref = (await list()).find((p) => p.name === 'Lou Park').ref;
  const key = (await C.personView(env, ref, { now: NOW })).key;
  assert.match(key, /^e:/);
  await doIt({ act: 'note-add', key, body: 'Met at the gala' });
  await doIt({ act: 'owner', key, email: 'jordan@soardcharity.com' });
  await add(pay({ id: 'nc2', contact: 'ct_lou', first: 'Lou', last: 'Park', email: 'lou@example.com', amount: 5000 }));
  let page = await C.personView(env, 'ct_lou', { now: NOW });
  assert.deepEqual([page.notes.length, page.owner, (await list()).find((p) => p.key === 'c:ct_lou')?.owner], [1, 'jordan@soardcharity.com', 'jordan@soardcharity.com'], 'at once, on the page and the list');
  await C.followMerges(db, { now: NOW });
  page = await C.personView(env, 'ct_lou', { now: NOW });
  assert.equal(await db.prepare("SELECT subject FROM donor_notes").first('subject'), 'c:ct_lou');
  assert.deepEqual([page.notes.length, page.owner, (await list()).find((p) => p.key === 'c:ct_lou')?.owner], [1, 'jordan@soardcharity.com', 'jordan@soardcharity.com'], 'for good, on the list too');
});

test('the list says who looks after each gift to thank, so the To thank pill can follow the Owner filter', async () => {
  await withTeam();
  const { syncThanks } = await import('../functions/api/_donor-thanks.js');
  await syncThanks(env, { now: NOW - 2 * DAY });
  await add(pay({ id: 'ck1', method: 'cheque', type: 'manual', amount: 50000 }), pay({ id: 'ck2', method: 'cheque', type: 'manual', amount: 50000, contact: 'ct_b', first: 'Bo', last: 'Banks', email: 'bo@example.com' }));
  await doIt({ act: 'owner', key: 'c:ct_jane', email: 'alex@soardcharity.com' });
  const v = await C.listView(env, { now: NOW });
  assert.equal(v.thanks, 2);
  assert.deepEqual(v.thanksOwners.slice().sort(), ['', 'alex@soardcharity.com']);
  assert.deepEqual((await C.thanksView(env, { now: NOW })).items.map((t) => t.owner || '').sort(), ['', 'alex@soardcharity.com']);
});

test('“same person” said of a giver known by email holds once Zeffy gives them a contact', async () => {
  await add(pay({ id: 'lp1', contact: 'ct_lp', first: 'Lou', last: 'Park', email: 'lou.work@example.com', amount: 5000 }));
  await add(pay({ id: 'lh1', contact: null, first: 'Lou', last: 'Park', email: 'lou.home@example.com', amount: 7000 }));
  await doIt({ act: 'same', a: 'c:ct_lp', b: 'e:lou.home@example.com', same: true });
  assert.equal((await list()).filter((p) => p.name === 'Lou Park').length, 1);
  await add(pay({ id: 'lh2', contact: 'ct_lou2', first: 'Lou', last: 'Park', email: 'lou.home@example.com', amount: 2000 }));
  await C.followMerges(db, { now: NOW });
  const lou = (await list()).filter((p) => p.name === 'Lou Park');
  assert.deepEqual(lou.map((p) => p.total), [14000], 'still one person, all three gifts');
  assert.ok(!(await needs()).some((i) => i.kind === 'same'), 'not asked again');
});

test('Partners → Merge into: a Zeffy contact that counted for the old partner by its own name counts for the one it went into', async () => {
  await db.prepare(partner('pella-wd', 'Pella Window & Door')).run();
  await add(pay({ id: 'pz', contact: 'ct_pella', first: 'Pella', last: '', email: 'ap@pella.example', amount: 300000 }));
  assert.equal((await list()).find((p) => p.key === 'p:pella')?.total, 300000);
  await C.mergeOrgCalls(db, 'pella', 'pella-wd');
  await db.prepare("DELETE FROM partners WHERE slug = 'pella'").run();
  assert.equal((await list()).find((p) => p.key === 'p:pella-wd')?.total, 300000);
});

test('“Keep it as an organization” never takes a name someone linked since the page was read', async () => {
  await add(pay({ id: 'bf', contact: 'ct_bf2', first: 'Bo', last: 'Fox', email: 'bo@example.com', company: 'BF Holdings', amount: 1500000 }));
  const big = (await needs()).find((i) => i.kind === 'big');
  await doIt({ act: 'link', kind: 'company', subject: 'BF Holdings', org: 'p:acme' });
  await assert.rejects(doIt({ act: 'org-new', name: big.name, links: [{ kind: big.link, subject: big.linkSubject }] }), (e) => e.status === 409 && /counts for Acme Builders already/.test(e.message));
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 1500000, 'Acme keeps it');
  assert.ok(!(await list()).some((p) => p.key.startsWith('o:')), 'and nothing was made');
});

// ─── Found in the third review ──────────────────────────────────────

test('an organization kept here by a name never takes, by that name alone, a gift that counts for a partner', async () => {
  await add(pay({ id: 'sf1', contact: 'ct_sff', first: 'Smith Family', last: 'Foundation', email: 'sff@example.com', company: 'Acme Builders', amount: 50000 }));
  await add(pay({ id: 'sf2', contact: 'ct_tt', first: 'Tia', last: 'Trust', email: 'tia@example.com', company: 'Smith Family Foundation', amount: 1500000 }));
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 50000);
  const big = (await needs()).find((i) => i.kind === 'big');
  const r = await doIt({ act: 'org-new', name: big.name, links: [{ kind: big.link, subject: big.linkSubject }] });
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 50000, 'Acme keeps its $500');
  assert.equal((await list()).find((p) => p.key === r.key)?.total, 1500000);
});

test('one question about a record at a time, whatever the kind: same person before “is it an organization?”, a partner before same person', async () => {
  await add(pay({ id: 'h1', contact: 'ct_h1', first: 'Harbor', last: 'Holdings', email: 'h1@example.com', amount: 50000 }), pay({ id: 'h2', contact: 'ct_h2', first: 'Harbor', last: 'Holdings', email: 'h2@example.com', amount: 60000 }));
  let items = await needs();
  assert.deepEqual(items.filter((i) => /ct_h/.test(JSON.stringify(i))).map((i) => i.kind), ['same']);
  await add(pay({ id: 'cm1', contact: 'ct_cm1', first: 'Chris', last: 'Moreno', email: 'cm1@example.com', amount: 5000 }), pay({ id: 'cm2', contact: 'ct_cm2', first: 'Chris', last: 'Moreno', email: 'cm2@example.com', amount: 6000 }));
  items = await needs();
  assert.deepEqual(items.filter((i) => /ct_cm/.test(JSON.stringify(i))).map((i) => i.kind).sort(), ['near', 'near'], 'each asked about the partner first; same person waits');
});

test('a contact linked to a partner since deleted can be kept as an organization', async () => {
  await db.prepare(partner('smithff', 'Smith FF')).run();
  await add(pay({ id: 'dl', contact: 'ct_dl', first: 'Delta Lake', last: 'Foundation', email: 'dl@example.com', amount: 50000 }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_dl', org: 'p:smithff' });
  await db.prepare("DELETE FROM partners WHERE slug = 'smithff'").run();
  const it = (await needs()).find((i) => i.kind === 'named');
  assert.ok(it, 'asked: its link counts for nothing now');
  const r = await doIt({ act: 'org-new', name: it.name, links: [{ kind: it.link, subject: it.linkSubject }], asked: true, subject: it.subject });
  assert.equal((await list()).find((p) => p.key === r.key)?.total, 50000);
  assert.ok(!(await needs()).some((i) => i.kind === 'named'));
});

test('Move to Champion is an upgrade only: a card read before the partner moved to Signature (or Champion) changes nothing', async () => {
  await add(pay({ id: 'lv', company: 'Acme Builders', amount: 1100000 }));
  const lv = (await needs()).find((i) => i.kind === 'level');
  assert.ok(lv);
  await db.prepare("UPDATE partners SET data = json_set(data, '$.level', 'signature') WHERE slug = 'acme'").run();
  await assert.rejects(doIt({ act: 'level', org: 'p:acme', done: true, was: 'Friend', asked: true }), (e) => e.status === 409 && /Signature partner/.test(e.message));
});

// ─── Found in the fourth review ─────────────────────────────────────

test('an owner said under an email that reaches two Zeffy contacts in one read looks after both; one at a time, the first, and a join shares it', async () => {
  await withTeam();
  await add(pay({ id: 'pe', contact: null, first: 'Pat', last: 'Lane', email: 'pat@example.com' }));
  await doIt({ act: 'owner', key: 'e:pat@example.com', email: 'alex@soardcharity.com' });
  // One read brings both (no webhook between them)
  const rows = [pay({ id: 'pp1', contact: 'ct_p1', first: 'Pat', last: 'Lane', email: 'pat@example.com' }), pay({ id: 'pp2', contact: 'ct_p2', first: 'Sam', last: 'Lane', email: 'pat@example.com' })].map((p) => D.rowFromPayment(p, new Date(NOW).toISOString()));
  for (const r of rows) { const k = Object.keys(r); await db.prepare(`INSERT INTO donor_payments (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`).bind(...k.map((x) => r[x])).run(); }
  await C.followMerges(db, { now: NOW });
  assert.deepEqual((await list()).filter((p) => ['c:ct_p1', 'c:ct_p2'].includes(p.key)).map((p) => p.owner), ['alex@soardcharity.com', 'alex@soardcharity.com']);
  // One at a time (gift webhooks): the first contact takes it; the second, same email, is asked "Same person?", and joined shares it
  await add(pay({ id: 'qe', contact: null, first: 'Quin', last: 'Lee', email: 'quin@example.com' }));
  await doIt({ act: 'owner', key: 'e:quin@example.com', email: 'jordan@soardcharity.com' });
  await add(pay({ id: 'qq1', contact: 'ct_q1', first: 'Quin', last: 'Lee', email: 'quin@example.com' }));
  await add(pay({ id: 'qq2', contact: 'ct_q2', first: 'Quinn', last: 'Lee', email: 'quin@example.com' }));
  const same = (await needs()).find((i) => i.kind === 'same' && [i.a.key, i.b.key].includes('c:ct_q2'));
  assert.ok(same, 'asked');
  await doIt({ act: 'same', a: same.a.key, b: same.b.key, same: true });
  assert.equal((await C.personView(env, 'ct_q2', { now: NOW })).owner, 'jordan@soardcharity.com');
});

test('renaming an organization kept here keeps the gifts its old name counted by itself', async () => {
  await add(pay({ id: 'rb', contact: 'ct_rb', first: 'Bright', last: 'Futures', email: 'bf@example.com', amount: 500000 }));
  const { key } = await doIt({ act: 'org-new', name: 'Bright Futures', links: [] });
  assert.equal((await list()).find((p) => p.key === key)?.total, 500000, 'by its name');
  await doIt({ act: 'org-rename', key, name: 'Bright Futures Foundation' });
  assert.equal((await list()).find((p) => p.key === key)?.total, 500000, 'still, renamed');
});

test('Keep it as an organization for a contact whose gifts count for a partner now: refused, nothing made', async () => {
  await add(pay({ id: 'kz', contact: 'ct_kz', first: 'Kite', last: 'Foundation', email: 'kite@example.com', company: 'Zed Corp', amount: 50000 }));
  const it = (await needs()).find((i) => i.kind === 'named');
  await doIt({ act: 'link', kind: 'company', subject: 'Zed Corp', org: 'p:acme' });
  await assert.rejects(doIt({ act: 'org-new', name: it.name, links: [{ kind: it.link, subject: it.linkSubject }], asked: true, subject: it.subject }), (e) => e.status === 409);
  assert.ok(!(await list()).some((p) => p.key.startsWith('o:')));
});

test('“It’s X” for a company once linked to a partner since deleted is an answer, not a 409', async () => {
  await db.prepare(partner('zeta', 'Zeta Old')).run();
  await add(pay({ id: 'zt', company: 'Zeta Builders Atlanta', amount: 50000 }));
  await doIt({ act: 'link', kind: 'company', subject: 'Zeta Builders Atlanta', org: 'p:zeta' });
  await db.prepare("DELETE FROM partners WHERE slug = 'zeta'").run();
  await db.prepare(partner('zb', 'Zeta Builders')).run();
  await doIt({ act: 'link', kind: 'company', subject: 'Zeta Builders Atlanta', org: 'p:zb', asked: true });
  assert.equal((await list()).find((p) => p.key === 'p:zb')?.total, 50000);
});

test('a contact that is an organization opens as it; a person split off a joined donor leaves the owner with the person', async () => {
  await withTeam();
  await add(pay({ id: 'co', contact: 'ct_co', first: 'Acme', last: 'Builders', email: 'ap@acme.example', amount: 10000 }));
  assert.deepEqual(await C.personView(env, 'ct_co', { now: NOW }), { org: 'p:acme' });
  await add(pay({ id: 'sa', contact: 'ct_a', first: 'Ann', last: 'Ash', email: 'a1@example.com' }), pay({ id: 'sb', contact: 'ct_b', first: 'Ann', last: 'Ash', email: 'a2@example.com' }));
  await doIt({ act: 'owner', key: 'c:ct_b', email: 'jordan@soardcharity.com' });
  await doIt({ act: 'same', a: 'c:ct_a', b: 'c:ct_b', same: true });
  await doIt({ act: 'owner', key: 'c:ct_a', email: 'alex@soardcharity.com' });
  const r = await doIt({ act: 'split', key: 'c:ct_a' });
  assert.equal((await C.personView(env, r.ref, { now: NOW })).owner, 'alex@soardcharity.com', 'the person keeps the owner they showed');
  assert.equal((await C.personView(env, 'ct_a', { now: NOW })).owner, null, 'the record split off starts with none');
});

test('Take it out on an organization kept from a Zeffy contact gives its owner, notes and History back to that contact', async () => {
  await withTeam();
  await add(pay({ id: 'gt', contact: 'ct_gt', first: 'Grace Tower', last: 'Foundation', email: 'grace@example.com', amount: 50000 }));
  await doIt({ act: 'owner', key: 'c:ct_gt', email: 'alex@soardcharity.com' });
  await doIt({ act: 'note-add', key: 'c:ct_gt', body: 'Board member’s family' });
  const it = (await needs()).find((i) => i.kind === 'named');
  const { key } = await doIt({ act: 'org-new', name: it.name, links: [{ kind: it.link, subject: it.linkSubject }] });
  assert.equal((await C.orgView(env, key, { now: NOW })).owner, 'alex@soardcharity.com');
  await doIt({ act: 'org-delete', key });
  const page = await C.personView(env, 'ct_gt', { now: NOW });
  assert.deepEqual([page.owner, page.notes.map((n) => n.body)], ['alex@soardcharity.com', ['Board member’s family']]);
  assert.ok(page.history.some((h) => /Note added/.test(h.what)));
});

// ─── Found in the fifth review ──────────────────────────────────────

test('Take it out gives back only to the contact the organization was made from, and all of it (not the same person too)', async () => {
  await withTeam();
  // Kept from a company name: nothing to give back to; Bob's contact linked later gets nothing of it
  await add(pay({ id: 'tk', company: 'Tilt Holdings', amount: 50000 }));
  const { key } = await doIt({ act: 'org-new', name: 'Tilt Holdings', links: [{ kind: 'company', subject: 'Tilt Holdings' }] });
  await doIt({ act: 'note-add', key, body: 'Org note' });
  await doIt({ act: 'anon', key, on: true });
  await add(pay({ id: 'bb', contact: 'ct_bob', first: 'Bob', last: 'Bee', email: 'bob@example.com' }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_bob', org: key });
  await doIt({ act: 'org-delete', key });
  const bob = await C.personView(env, 'ct_bob', { now: NOW });
  assert.deepEqual([bob.notes.length, bob.keepAnonymous], [0, false]);
  // Made from a contact that was "not the same" as another: that answer comes back with it
  await add(pay({ id: 'x1', contact: 'ct_x', first: 'Xeno', last: 'Fund', email: 'x@example.com', amount: 50000 }), pay({ id: 'y1', contact: 'ct_y', first: 'Xeno', last: 'Fund', email: 'y@example.com', amount: 60000 }));
  await doIt({ act: 'same', a: 'c:ct_x', b: 'c:ct_y', same: false });
  const { key: k2 } = await doIt({ act: 'org-new', name: 'Xeno Fund', links: [{ kind: 'contact', subject: 'ct_x' }] });
  await doIt({ act: 'org-delete', key: k2 });
  assert.ok(!(await needs()).some((i) => i.kind === 'same'), 'not asked again');
});

test('a Zeffy merge of two joined records keeps the owner the person showed', async () => {
  await withTeam();
  await add(pay({ id: 'ma', contact: 'ct_ma', first: 'Mo', last: 'Ash', email: 'mo1@example.com' }), pay({ id: 'mb', contact: 'ct_mb', first: 'Mo', last: 'Ash', email: 'mo2@example.com' }));
  await C.act(env, { act: 'owner', key: 'c:ct_ma', email: 'alex@soardcharity.com' }, by, { now: NOW });
  await C.act(env, { act: 'owner', key: 'c:ct_mb', email: 'jordan@soardcharity.com' }, by, { now: NOW + 1000 });
  await doIt({ act: 'same', a: 'c:ct_ma', b: 'c:ct_mb', same: true });
  await add(pay({ id: 'mb', contact: 'ct_ma', first: 'Mo', last: 'Ash', email: 'mo2@example.com' }));
  await C.followMerges(db, { now: NOW });
  assert.equal((await C.personView(env, 'ct_ma', { now: NOW })).owner, 'jordan@soardcharity.com');
});

test('a gift with no Zeffy contact is never taken, nor dropped, by an organization’s name alone', async () => {
  await add(pay({ id: 'lc', contact: 'ct_lx', first: 'Lia', last: 'Ex', email: 'lia@example.com' }));
  await add(pay({ id: 'lg', contact: null, first: 'Smith Family', last: 'Foundation', email: 'lia@example.com', company: 'Acme Builders', amount: 70000 }));
  const before = await C.giftOwner(env, 'lg', { now: NOW });
  assert.deepEqual(before, { org: 'p:acme' });
  await doIt({ act: 'org-new', name: 'Smith Family Foundation', links: [] });
  assert.deepEqual(await C.giftOwner(env, 'lg', { now: NOW }), { org: 'p:acme' }, 'kept');
  await add(pay({ id: 'lh', contact: null, first: 'Rho', last: 'Trust', email: 'lia@example.com', amount: 40000 }));
  const { key } = await doIt({ act: 'org-new', name: 'Rho Trust', links: [] });
  assert.deepEqual(await C.giftOwner(env, 'lh', { now: NOW }), { org: key }, 'by its name');
  await doIt({ act: 'org-rename', key, name: 'Rho Family Trust' });
  assert.deepEqual(await C.giftOwner(env, 'lh', { now: NOW }), { org: key }, 'still, renamed');
});

// ─── Found in the fifth QA round ────────────────────────────────────

test('a gift with no Zeffy contact under an email two contacts share is the one whose name it gives, and never renames the other', async () => {
  await add(pay({ id: 'pc', contact: 'ct_chris', first: 'Chris', last: 'Pair', email: 'family@pair.example', created: S(NOW - 3 * DAY) }));
  await add(pay({ id: 'pj', contact: 'ct_jamie', first: 'Jamie', last: 'Pair', email: 'family@pair.example', created: S(NOW - 5 * DAY) }));
  await add(pay({ id: 'pl', contact: null, first: 'Jamie', last: 'Pair', email: 'family@pair.example', amount: 120000, created: S(NOW - DAY) }));
  const people = await list();
  assert.equal(people.find((p) => p.key === 'c:ct_chris')?.name, 'Chris Pair');
  assert.equal(people.find((p) => p.key === 'c:ct_jamie')?.total, 10000 + 120000);
});

test('a Zeffy contact counted for an organization: its owner and notes show on the organization’s page, and come back when the link is taken off', async () => {
  await withTeam();
  await add(pay({ id: 'ok', contact: 'ct_oak', first: 'Oak', last: 'Stone', email: 'oak@example.com' }));
  await doIt({ act: 'owner', key: 'c:ct_oak', email: 'jordan@soardcharity.com' });
  await doIt({ act: 'note-add', key: 'c:ct_oak', body: 'Met at the gala' });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_oak', org: 'p:pella' });
  const pella = await C.orgView(env, 'p:pella', { now: NOW });
  assert.deepEqual([pella.owner, pella.notes.map((n) => n.body)], ['jordan@soardcharity.com', ['Met at the gala']]);
  assert.equal((await list()).find((p) => p.key === 'p:pella')?.owner, 'jordan@soardcharity.com', 'the list says the same');
  await doIt({ act: 'not', kind: 'contact', subject: 'ct_oak', org: 'p:pella' });
  const oak = await C.personView(env, 'ct_oak', { now: NOW });
  assert.deepEqual([oak.owner, oak.notes.length], ['jordan@soardcharity.com', 1]);
});

test('put on the website twice (another tab): the second is told where it is, never a second organization', async () => {
  await add(pay({ id: 'lw', contact: 'ct_lw', first: 'Lark & Wren', last: 'Foundation', email: 'lw@example.com', amount: 50000 }));
  const { key } = await doIt({ act: 'org-new', name: 'Lark & Wren Foundation', links: [{ kind: 'contact', subject: 'ct_lw' }] });
  await db.prepare(partner('lark-wren', 'Lark & Wren Foundation')).run();
  await doIt({ act: 'website', key, slug: 'lark-wren' });
  await db.prepare(partner('the-lark-wren', 'The Lark & Wren Foundation')).run();
  await assert.rejects(doIt({ act: 'website', key, slug: 'the-lark-wren' }), (e) => e.status === 409 && /on the website already as Lark & Wren Foundation/.test(e.message));
});

// ─── Found in the sixth review ──────────────────────────────────────

test('a contact that is an organization by its exact name: its owner and notes are the organization’s to show; "No one" there is said', async () => {
  await withTeam();
  await add(pay({ id: 'rh', contact: 'ct_rho', first: 'Rho', last: 'Trust', email: 'rho@example.com', amount: 5000 }));
  await doIt({ act: 'owner', key: 'c:ct_rho', email: 'jordan@soardcharity.com' });
  await doIt({ act: 'note-add', key: 'c:ct_rho', body: 'A friend of the board chair' });
  await add(pay({ id: 'rt', contact: 'ct_ann6', first: 'Ann', last: 'Six', email: 'ann6@example.com', company: 'Rho Trust', amount: 1200000 }));
  const big = (await needs()).find((i) => i.kind === 'big');
  const { key } = await doIt({ act: 'org-new', name: big.name, links: [{ kind: big.link, subject: big.linkSubject }] });
  const org = await C.orgView(env, key, { now: NOW });
  assert.deepEqual([org.owner, org.notes.map((n) => n.body)], ['jordan@soardcharity.com', ['A friend of the board chair']]);
  await doIt({ act: 'owner', key, email: '' });
  assert.equal((await C.orgView(env, key, { now: NOW })).owner, null, '"No one" holds');
  assert.equal((await list()).find((p) => p.key === key)?.owner, null);
});

test('one question about one giver at a time: two gifts that could each count for two organizations, one asked first', async () => {
  await db.prepare(partner('zed', 'Zed Works')).run();
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_jane', org: 'p:beta' });
  await add(pay({ id: 'cl1', company: 'Acme Builders', amount: 5000 }), pay({ id: 'cl2', company: 'Acme Builders', amount: 6000, created: S(NOW - 3 * DAY) }));
  assert.equal((await needs()).filter((i) => i.kind === 'clash').length, 1);
});

// ─── Found in the sixth QA round ────────────────────────────────────

test('Move to Champion is one step on the site: done, or nothing said (refused when moved meanwhile)', async () => {
  const real = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await real.exec('CREATE TABLE IF NOT EXISTS kids (slug TEXT, name TEXT, data TEXT)').catch(() => {});
  const putP = (slug, name, level) => real.prepare('INSERT INTO partners (slug, name, level, category, data) VALUES (?, ?, ?, ?, ?)').bind(slug, name, level, 'funding', JSON.stringify({ name, slug, level, category: ['funding'] })).run();
  await putP('acme', 'Acme Builders', 'friend');
  await putP('sigco', 'Sig Co', 'signature');
  const renv = { DB: real };
  // (giving that makes them Champion: $12,000 in the last 12 months)
  await D.noteDonorPayment(renv, pay({ id: 'ch1', company: 'Acme Builders', amount: 1200000, created: S(NOW - 20 * DAY) }), { now: NOW });
  const act = (body) => C.act(renv, body, by, { now: NOW });
  await act({ act: 'level', org: 'p:acme', done: true, was: 'Friend', asked: true, move: true });
  assert.equal(JSON.parse((await real.prepare("SELECT data FROM partners WHERE slug = 'acme'").first()).data).level, 'champion');
  await assert.rejects(act({ act: 'level', org: 'p:sigco', done: true, was: 'Friend', asked: true, move: true }), (e) => e.status === 409);
  assert.equal(await real.prepare("SELECT 1 AS y FROM donor_calls WHERE kind = 'level' AND subject = 'p:sigco'").first(), null, 'nothing said');
  assert.equal(JSON.parse((await real.prepare("SELECT data FROM partners WHERE slug = 'sigco'").first()).data).level, 'signature');
});

test('edits say what they saw: an owner, a note and a name changed by someone since are refused, never written over; a note saved twice is one', async () => {
  await withTeam();
  await add(pay({ id: 'ed', contact: 'ct_ed', first: 'Ed', last: 'Ito', email: 'ed@example.com' }));
  await C.act(env, { act: 'owner', key: 'c:ct_ed', email: 'jordan@soardcharity.com', was: '' }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(doIt({ act: 'owner', key: 'c:ct_ed', email: 'alex@soardcharity.com', was: '' }), (e) => e.status === 409);
  const { id } = await doIt({ act: 'note-add', key: 'c:ct_ed', body: 'First words', id: 'note-ed-1' });
  await doIt({ act: 'note-add', key: 'c:ct_ed', body: 'First words', id: 'note-ed-1' });
  assert.equal((await C.personView(env, 'ct_ed', { now: NOW })).notes.length, 1, 'a save tried again is the same note');
  await C.act(env, { act: 'note-edit', id, body: 'Jordan’s words', was: 'First words' }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(doIt({ act: 'note-edit', id, body: 'Alex’s words', was: 'First words' }), (e) => e.status === 409 && /Jordan changed this note/.test(e.message));
  assert.equal((await C.personView(env, 'ct_ed', { now: NOW })).notes[0].body, 'Jordan’s words');
  const { key } = await doIt({ act: 'org-new', name: 'Ed Co', links: [] });
  await C.act(env, { act: 'org-rename', key, name: 'Ed Company', was: 'Ed Co' }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(doIt({ act: 'org-rename', key, name: 'Ed & Co', was: 'Ed Co' }), (e) => e.status === 409);
});

test('a gift in kind Zeffy has no value for: its giver is in the list', async () => {
  await add(pay({ id: 'zk', contact: 'ct_zane', first: 'Zane', last: 'Nought', email: 'zane@example.com', method: 'in_kind', amount: 0, items: [{ type: 'donation', amount: 0 }] }));
  assert.ok((await list()).some((p) => p.key === 'c:ct_zane'));
});

// ─── Found in the seventh round ─────────────────────────────────────

/** env.DB with `hook` run once, just before the first batch (or the first statement matching `match`): a teammate's change landing in between */
const racing = (DB, hook, match = null) => {
  let done = false;
  return new Proxy(DB, {
    get(t, k) {
      if (k === 'batch' && !match) return async (stmts) => { if (!done) { done = true; await hook(); } return t.batch(stmts); };
      if (k === 'prepare' && match) {
        return (sql) => {
          const st = t.prepare(sql);
          if (!match.test(sql)) return st;
          return { ...st, bind: (...a) => { const b = st.bind(...a); return { ...b, run: async () => { if (!done) { done = true; await hook(); } return b.run(); } }; } };
        };
      }
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
};

test('an organization’s owner, taken from a contact that is it by name, is the same in a change as on its page (no false “someone changed”)', async () => {
  await withTeam();
  await add(pay({ id: 'bn1', contact: 'ct_acmeco', first: 'Acme', last: 'Builders', email: 'office@acme.example', amount: 20000 }));
  await db.prepare("INSERT INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES ('owner', 'c:ct_acmeco', '', 1, 'jordan@soardcharity.com', ?, ?)").bind(by, new Date(NOW - DAY).toISOString()).run();
  assert.equal((await C.orgView(env, 'p:acme', { now: NOW })).owner, 'jordan@soardcharity.com', 'its page shows Jordan');
  await doIt({ act: 'owner', key: 'p:acme', email: 'alex@soardcharity.com', was: 'jordan@soardcharity.com' });
  assert.equal((await C.orgView(env, 'p:acme', { now: NOW })).owner, 'alex@soardcharity.com');
});

test('a gift with no contact that borrows one by email never lends that person’s owner to an organization of its name', async () => {
  await withTeam();
  await add(pay({ id: 'lo1', contact: 'ct_lee', first: 'Lee', last: 'Sample', email: 'lee@example.com', amount: 5000 }));
  await add(pay({ id: 'lo2', contact: null, first: 'Acme', last: 'Builders', email: 'lee@example.com', amount: 7000 }));
  await doIt({ act: 'owner', key: 'c:ct_lee', email: 'jordan@soardcharity.com', was: '' });
  assert.equal((await C.orgView(env, 'p:acme', { now: NOW })).owner || null, null, 'Lee’s owner is Lee’s, not Acme’s');
});

test('the same owner picked twice (an answer lost, then picked again; two teammates picking the same) is no conflict', async () => {
  await withTeam();
  await add(pay({ id: 'tb', contact: 'ct_tom', first: 'Tom', last: 'Banks', email: 'tom@example.com' }));
  await doIt({ act: 'owner', key: 'c:ct_tom', email: 'jordan@soardcharity.com', was: '' });
  const again = await doIt({ act: 'owner', key: 'c:ct_tom', email: 'jordan@soardcharity.com', was: '' });
  assert.equal(again.same, true);
  assert.equal((await C.personView(env, 'ct_tom', { now: NOW })).owner, 'jordan@soardcharity.com');
});

test('an owner changed by a teammate between the read and the write is never written over', async () => {
  await withTeam();
  await add(pay({ id: 'rc', contact: 'ct_rae', first: 'Rae', last: 'Cole', email: 'rae@example.com' }));
  const teammate = () => db.prepare("INSERT INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES ('owner', 'c:ct_rae', '', 1, 'jordan@soardcharity.com', 'jordan@soardcharity.com', ?)").bind(new Date(NOW).toISOString()).run();
  const renv = { DB: racing(db, teammate) };
  await assert.rejects(C.act(renv, { act: 'owner', key: 'c:ct_rae', email: 'alex@soardcharity.com', was: '' }, by, { now: NOW }), (e) => e.status === 409 && /Jordan now/.test(e.message));
  assert.equal((await C.personView(env, 'ct_rae', { now: NOW })).owner, 'jordan@soardcharity.com', 'Jordan’s answer stands');
});

test('a note or a name changed by a teammate between the read and the write is never written over', async () => {
  await withTeam();
  await add(pay({ id: 'nr', contact: 'ct_nia', first: 'Nia', last: 'Ross', email: 'nia@example.com' }));
  const { id } = await doIt({ act: 'note-add', key: 'c:ct_nia', body: 'Called in May', id: 'note-nia-1' });
  const theirs = () => db.prepare("UPDATE donor_notes SET body = 'Called in May; sends a check each June', edited_by = 'jordan@soardcharity.com' WHERE id = ?").bind(id).run();
  const nenv = { DB: racing(db, theirs, /^UPDATE donor_notes SET body/) };
  await assert.rejects(C.act(nenv, { act: 'note-edit', id, body: 'Called in May and June', was: 'Called in May' }, by, { now: NOW }), (e) => e.status === 409 && /Jordan changed this note/.test(e.message));
  assert.equal((await C.personView(env, 'ct_nia', { now: NOW })).notes[0].body, 'Called in May; sends a check each June');
  // Deleted meanwhile: said so (404), not "changed"
  await db.prepare('DELETE FROM donor_notes WHERE id = ?').bind(id).run();
  await assert.rejects(doIt({ act: 'note-edit', id, body: 'x', was: 'Called in May' }), (e) => e.status === 404);
  const { key } = await doIt({ act: 'org-new', name: 'Ross Family Fund', links: [] });
  const renamed = () => db.prepare("UPDATE donor_orgs SET name = 'The Ross Family Fund' WHERE key = ?").bind(key).run();
  const oenv = { DB: racing(db, renamed) };
  await assert.rejects(C.act(oenv, { act: 'org-rename', key, name: 'Ross Fund', was: 'Ross Family Fund' }, by, { now: NOW }), (e) => e.status === 409 && /The Ross Family Fund/.test(e.message));
  const names = (await db.prepare("SELECT note FROM donor_calls WHERE kind = 'kept-name' AND target = ?").bind(key).all()).results.map((r) => r.note);
  assert.ok(!names.includes('Ross Fund'), 'nothing of the refused rename was written');
  assert.equal((await db.prepare('SELECT name FROM donor_orgs WHERE key = ?').bind(key).first()).name, 'The Ross Family Fund');
});

test('a partner card renamed (or added under an organization’s name) in the Partners editor keeps the gifts names counted by themselves', async () => {
  await add(pay({ id: 'pr1', contact: 'ct_acmeco', first: 'Acme', last: 'Builders', email: 'office@acme.example', amount: 20000 }));
  await add(pay({ id: 'pr2', company: 'Acme Builders', amount: 30000 }));
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 50000);
  // Renamed: both gifts stay with it
  await C.keepGiftsForPartnerName(db, { slug: 'acme', name: 'Acme Builders Group', by, now: NOW });
  await db.prepare("UPDATE partners SET data = ? WHERE slug = 'acme'").bind(JSON.stringify({ name: 'Acme Builders Group', level: 'friend', category: ['funding'] })).run();
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 50000, 'still Acme’s after the rename');
  // A new card named as an organization kept here: that organization keeps what its name counted
  await add(pay({ id: 'pr3', contact: 'ct_ivers', first: 'Ivers', last: 'Foundation', email: 'grants@ivers.example', amount: 40000 }));
  const { key } = await doIt({ act: 'org-new', name: 'Ivers Foundation', links: [] });
  assert.equal((await list()).find((p) => p.key === key)?.total, 40000);
  await C.keepGiftsForPartnerName(db, { slug: 'ivers', name: 'Ivers Foundation', by, now: NOW });
  await db.prepare(partner('ivers', 'Ivers Foundation')).run();
  assert.equal((await list()).find((p) => p.key === key)?.total, 40000, 'the kept one still has its gift');
  // Nothing changed (the same name): nothing written
  assert.equal(await C.keepGiftsForPartnerName(db, { slug: 'pella', name: 'Pella', by, now: NOW }), 0);
});

test('save-content: renaming a partner card keeps the gifts its old name counted', async () => {
  const real = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await real.exec('CREATE TABLE IF NOT EXISTS kids (slug TEXT, name TEXT, data TEXT)').catch(() => {});
  const { onRequestPost: saveContent } = await import('../functions/api/save-content.js');
  const save = (content, sha = null) => saveContent({ env: { DB: real }, data: { userEmail: by }, waitUntil: () => {},
    request: new Request('https://admin.test/api/save-content', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'src/content/partners/zeta.json', content: JSON.stringify(content), message: 'Partner', ...(sha ? { sha } : {}) }) }) });
  assert.equal((await save({ name: 'Zeta Works', slug: 'zeta', level: 'friend', category: ['funding'] })).status, 200);
  await D.noteDonorPayment({ DB: real }, pay({ id: 'zw', contact: 'ct_zeta', first: 'Zeta', last: 'Works', email: 'hello@zeta.example', amount: 25000 }), { now: NOW });
  const total = async () => (await C.listView({ DB: real }, { now: NOW })).people.find((p) => p.key === 'p:zeta')?.total;
  assert.equal(await total(), 25000);
  assert.equal((await save({ name: 'Zeta Works Studio', slug: 'zeta', level: 'friend', category: ['funding'] })).status, 200);
  assert.equal(await total(), 25000, 'the gift stays with the renamed card');
});

test('Needs you asks about a person once at a time: a big company gift waits while its giver is asked “same person?”', async () => {
  await add(pay({ id: 'bg1', contact: 'ct_lee1', first: 'Lee', last: 'Sample', email: 'lee@example.com', company: 'Sample Holdings', amount: 1500000 }));
  await add(pay({ id: 'bg2', contact: 'ct_lee2', first: 'Lee', last: 'Sample', email: 'lee@example.com', amount: 5000, created: S(NOW - 3 * DAY) }));
  let items = await needs();
  assert.ok(items.some((i) => i.kind === 'same'), 'asked: the same person?');
  assert.ok(!items.some((i) => i.kind === 'big'), 'the company waits');
  await doIt({ act: 'same', a: 'c:ct_lee1', b: 'c:ct_lee2', same: true });
  items = await needs();
  assert.ok(items.some((i) => i.kind === 'big' && /Sample Holdings/.test(i.name)), 'then asked about the company');
});

test('a company linked to an organization shows by the name it was typed, never its key', async () => {
  await add(pay({ id: 'cn1', contact: 'ct_lee', first: 'Lee', last: 'Sample', email: 'lee@example.com', company: 'Pella Window & Door of Georgia', amount: 30000 }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_lee', org: 'p:pella' });
  await doIt({ act: 'link', kind: 'company', subject: 'Pella Window & Door of Georgia', org: 'p:pella' });
  const names = (await C.orgView(env, 'p:pella', { now: NOW })).names.map((x) => x.name);
  assert.ok(names.includes('Pella Window & Door of Georgia'), names.join(', '));
  assert.ok(!names.includes('pellawindowdoorofgeorgia'));
});

test('someone whose every gift counts for an organization is found in the list by their own name and email', async () => {
  await add(pay({ id: 'gv1', contact: 'ct_dana', first: 'Dana', last: 'Whitfield', email: 'dana@example.com', amount: 30000 }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_dana', org: 'p:acme' });
  const people = await list();
  assert.ok(!people.some((p) => p.key === 'c:ct_dana'), 'no row of her own');
  const acme = people.find((p) => p.key === 'p:acme');
  assert.deepEqual(acme.givers, [{ name: 'Dana Whitfield', emails: ['dana@example.com'] }]);
});

// ─── Found in the eighth round ──────────────────────────────────────

test('a person who once typed a partner’s name: that gift is the partner’s, the rest theirs, and they keep a page of their own', async () => {
  await add(pay({ id: 'mx1', contact: 'ct_bob', first: 'Acme', last: 'Builders', email: 'bob@example.com', amount: 50000, created: S(NOW - 30 * DAY) }));
  await add(pay({ id: 'mx2', contact: 'ct_bob', first: 'Bob', last: 'Smith', email: 'bob@example.com', amount: 50000, created: S(NOW - 10 * DAY) }));
  const totals = async () => Object.fromEntries((await list()).filter((p) => ['c:ct_bob', 'p:acme'].includes(p.key)).map((p) => [p.key, p.total]));
  assert.deepEqual(await totals(), { 'c:ct_bob': 50000, 'p:acme': 50000 });
  const page = await C.personView(env, 'ct_bob', { now: NOW });
  assert.ok(!page.org, 'his page is his, not Acme’s');
  assert.equal(page.donor.total, 50000);
  assert.deepEqual((await C.orgView(env, 'p:acme', { now: NOW })).people.map((p) => p.name), ['Bob Smith'], 'named as himself on Acme’s page');
});

test('renaming or merging a partner keeps only the gifts its name counted: a person’s own gifts stay theirs', async () => {
  const real = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await real.exec('CREATE TABLE IF NOT EXISTS kids (slug TEXT, name TEXT, data TEXT)').catch(() => {});
  const putP = (slug, name) => real.prepare('INSERT INTO partners (slug, name, level, category, data) VALUES (?, ?, ?, ?, ?)').bind(slug, name, 'friend', 'funding', JSON.stringify({ name, slug, level: 'friend', category: ['funding'] })).run();
  await putP('acme', 'Acme Builders');
  await putP('acme-homes', 'Acme Homes');
  const renv = { DB: real };
  for (const p of [pay({ id: 'rm1', contact: 'ct_bob', first: 'Acme', last: 'Builders', email: 'bob@example.com', amount: 50000 }), pay({ id: 'rm2', contact: 'ct_bob', first: 'Bob', last: 'Smith', email: 'bob@example.com', amount: 30000, created: S(NOW - 2 * DAY) }),
    pay({ id: 'rm3', contact: 'ct_acmeco', first: 'Acme', last: 'Builders', email: 'office@acme.example', amount: 20000 })]) await D.noteDonorPayment(renv, p, { now: NOW });
  const totals = async () => Object.fromEntries((await C.listView(renv, { now: NOW })).people.filter((p) => ['c:ct_bob', 'p:acme', 'p:acme-homes'].includes(p.key)).map((p) => [p.key, p.total]));
  assert.deepEqual(await totals(), { 'c:ct_bob': 30000, 'p:acme': 70000 });
  await C.keepGiftsForPartnerName(real, { slug: 'acme', name: 'Acme Group', by, now: NOW });
  await real.prepare("UPDATE partners SET name = 'Acme Group', data = ? WHERE slug = 'acme'").bind(JSON.stringify({ name: 'Acme Group', slug: 'acme', level: 'friend', category: ['funding'] })).run();
  assert.deepEqual(await totals(), { 'c:ct_bob': 30000, 'p:acme': 70000 }, 'renamed: the same split');
  const link = await real.prepare("SELECT target FROM donor_calls WHERE kind = 'contact' AND subject = 'ct_acmeco' AND answer = 1").first();
  assert.equal(link?.target, 'p:acme', 'the company’s own Zeffy record (every name of it Acme’s) is linked whole');
  assert.equal(await real.prepare("SELECT 1 AS y FROM donor_calls WHERE kind = 'contact' AND subject = 'ct_bob' AND answer = 1").first(), null, 'Bob is never linked whole');
  await C.mergeOrgCalls(real, 'acme', 'acme-homes');
  await real.prepare("DELETE FROM partners WHERE slug = 'acme'").run();
  assert.deepEqual(await totals(), { 'c:ct_bob': 30000, 'p:acme-homes': 70000 }, 'merged: the same split');
});

test('two “Keep as an organization” of one name at the same moment: one is made, the other refused', async () => {
  await add(pay({ id: 'hf', contact: 'ct_hope', first: 'Hope', last: 'Fund', email: 'grants@hope.example', amount: 40000 }));
  const both = await Promise.allSettled([doIt({ act: 'org-new', name: 'Hope Fund', links: [] }), doIt({ act: 'org-new', name: 'Hope Fund', links: [] })]);
  assert.deepEqual(both.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(both.find((x) => x.status === 'rejected').reason.status, 409);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM donor_orgs WHERE name = 'Hope Fund'").first()).n, 1);
  const key = both.find((x) => x.status === 'fulfilled').value.key;
  assert.equal((await list()).find((p) => p.key === key)?.total, 40000, 'its gift counts for the one made');
  // A rename onto a name another organization took meanwhile is refused too
  const { key: other } = await doIt({ act: 'org-new', name: 'Birch Society', links: [] });
  const { nameKey } = await import('../public/admin/partners-shared.js');
  const renv = { DB: racing(db, () => db.prepare("INSERT INTO donor_orgs (key, name, created_at, name_key) VALUES ('o:late', 'Maple Society', ?, ?)").bind(new Date(NOW).toISOString(), nameKey('Maple Society')).run()) };
  await assert.rejects(C.act(renv, { act: 'org-rename', key: other, name: 'Maple Society', was: 'Birch Society' }, by, { now: NOW }), (e) => e.status === 409 && /took the name/.test(e.message));
});

test('an organization with more than 100 Zeffy contacts counted for it: its page reads (notes and History 80 at a time)', async () => {
  for (let i = 0; i < 105; i++) await add(pay({ id: `big_${i}`, contact: `ct_m${i}`, first: `Member`, last: `No ${i}`, email: `m${i}@example.com`, company: 'Acme Builders', amount: 1000 }));
  for (let i = 0; i < 105; i++) await db.prepare("INSERT INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES ('contact', ?, 'p:acme', 1, NULL, ?, ?)").bind(`ct_m${i}`, by, new Date(NOW).toISOString()).run();
  const page = await C.orgView(env, 'p:acme', { now: NOW });
  assert.equal(page.gifts.length, 105);
});

// ─── Found in the eighth QA round ───────────────────────────────────

test('kept as an organization by a teammate: a stale “It’s a person” or “Not now” on that card is refused', async () => {
  await add(pay({ id: 'gc', contact: 'ct_grace', first: 'Grace Community', last: 'Church', email: 'office@grace.example', amount: 40000 }));
  const q = (await needs()).find((i) => i.kind === 'named' || i.kind === 'big');
  assert.ok(q, 'asked: is it an organization?');
  await C.act(env, { act: 'org-new', key: 'o:0123456789abcdef', name: 'Grace Community Church', links: [{ kind: 'contact', subject: 'ct_grace' }], asked: true, subject: q.subject, also: q.also || [] }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(doIt({ act: 'big', subject: q.subject, also: q.also || [], person: true, asked: true }), (e) => e.status === 409);
  await assert.rejects(doIt({ act: 'big', subject: q.subject, also: q.also || [], asked: true }), (e) => e.status === 409);
  assert.equal(await db.prepare("SELECT 1 AS y FROM donor_calls WHERE kind = 'big' AND note = 'person'").first(), null, 'nothing said over it');
});

test('every change sent twice (its answer lost) is made once and says so', async () => {
  await withTeam();
  await add(pay({ id: 'tw', contact: 'ct_twice', first: 'Hope', last: 'Fund', email: 'grants@hope.example', amount: 40000 }));
  const k = 'o:aaaabbbbccccdddd';
  const body = { act: 'org-new', key: k, name: 'Hope Fund', links: [{ kind: 'contact', subject: 'ct_twice' }] };
  assert.equal((await doIt(body)).key, k);
  const again = await doIt(body);
  assert.deepEqual([again.key, again.same], [k, true]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM donor_orgs').first()).n, 1);
  // Take it out, twice
  await doIt({ act: 'org-delete', key: k, was: { notes: [], owner: '' } });
  assert.equal((await doIt({ act: 'org-delete', key: k, was: { notes: [], owner: '' } })).same, true);
});

test('Take it out from a page read before a teammate added a note: refused, and the note stays', async () => {
  await withTeam();
  const { key } = await doIt({ act: 'org-new', name: 'Oak Society', links: [] });
  await C.act(env, { act: 'note-add', key, body: 'Gives every spring', id: 'note-oak-1' }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(doIt({ act: 'org-delete', key, was: { notes: [], owner: '' } }), (e) => e.status === 409 && /Jordan added a note/.test(e.message));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM donor_notes WHERE subject = ?').bind(key).first()).n, 1);
  // With the note seen, it goes
  await doIt({ act: 'org-delete', key, was: { notes: ['note-oak-1'], owner: '' } });
  assert.equal(await db.prepare('SELECT 1 AS y FROM donor_orgs WHERE key = ?').bind(key).first(), null);
});

test('a note deleted from a page read before a teammate changed it: refused, and their words stay', async () => {
  await add(pay({ id: 'nd', contact: 'ct_tom', first: 'Tom', last: 'Banks', email: 'tom@example.com' }));
  const { id } = await doIt({ act: 'note-add', key: 'c:ct_tom', body: 'Call in December', id: 'note-tom-1' });
  await C.act(env, { act: 'note-edit', id, body: 'Call in December. Pledged $5,000.', was: 'Call in December' }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(doIt({ act: 'note-delete', id, was: 'Call in December' }), (e) => e.status === 409);
  assert.equal((await C.personView(env, 'ct_tom', { now: NOW })).notes[0].body, 'Call in December. Pledged $5,000.');
});

test('a join undone: each record keeps the owner it had', async () => {
  await withTeam();
  await add(pay({ id: 'ml1', contact: 'ct_ml1', first: 'Maria', last: 'Lopez', email: 'maria@example.com' }), pay({ id: 'ml2', contact: 'ct_ml2', first: 'Maria J.', last: 'Lopez', email: 'mlopez@example.org', created: S(NOW - 3 * DAY) }));
  await doIt({ act: 'owner', key: 'c:ct_ml1', email: 'jordan@soardcharity.com', was: '' });
  await doIt({ act: 'owner', key: 'c:ct_ml2', email: 'alex@soardcharity.com', was: '' });
  await doIt({ act: 'same', a: 'c:ct_ml1', b: 'c:ct_ml2', same: true });
  const crm = await C.loadCrm(db, { now: NOW });
  const other = crm.canon('c:ct_ml1') === 'c:ct_ml1' ? 'c:ct_ml2' : 'c:ct_ml1';
  await doIt({ act: 'split', key: other });
  assert.equal((await C.personView(env, 'ct_ml1', { now: NOW })).owner, 'jordan@soardcharity.com');
  assert.equal((await C.personView(env, 'ct_ml2', { now: NOW })).owner, 'alex@soardcharity.com');
  assert.equal((await doIt({ act: 'split', key: other })).same, true, 'sent again: done already');
});

test('a person joined from two Zeffy contacts, counted for an organization: both in one step', async () => {
  await add(pay({ id: 'j1', contact: 'ct_j1', first: 'Kim', last: 'Ng', email: 'kim@example.com', amount: 5000 }), pay({ id: 'j2', contact: 'ct_j2', first: 'Kim', last: 'Ng', email: 'kim@example.org', amount: 4000, created: S(NOW - 3 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_j1', b: 'c:ct_j2', same: true });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_j1', subjects: ['ct_j1', 'ct_j2'], org: 'p:pella' });
  assert.equal((await list()).find((p) => p.key === 'p:pella')?.total, 9000);
});

test('a contact Zeffy split: its notes and owner go to the contact a person picks, never left where no one sees them', async () => {
  await withTeam();
  const st = { unplaced: [{ contact: 'ct_mover', to: ['ct_a1', 'ct_a2'], at: new Date(NOW).toISOString() }] };
  await add(pay({ id: 'mv1', contact: 'ct_a1', first: 'Mel', last: 'Mover', email: 'mel@example.com' }), pay({ id: 'mv2', contact: 'ct_a2', first: 'Mel', last: 'Mover', email: 'mel2@example.com' }));
  await db.prepare("INSERT OR REPLACE INTO donor_state (key, value) VALUES ('crm', ?)").bind(JSON.stringify(st)).run();
  await db.prepare("INSERT INTO donor_notes (id, subject, body, by, at) VALUES ('note-mel', 'c:ct_mover', 'Met at the gala', ?, ?)").bind(by, new Date(NOW).toISOString()).run();
  await db.prepare("INSERT INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES ('owner', 'c:ct_mover', '', 1, 'jordan@soardcharity.com', ?, ?)").bind(by, new Date(NOW).toISOString()).run();
  const card = (await needs()).find((i) => i.kind === 'moved');
  assert.deepEqual([card.notes, card.owner, card.names], [1, 'jordan@soardcharity.com', ['Mel Mover', 'Mel Mover']]);
  await doIt({ act: 'moved-done', contact: 'ct_mover', to: 'ct_a2', asked: true });
  const page = await C.personView(env, 'ct_a2', { now: NOW });
  assert.deepEqual([page.notes.map((n) => n.body), page.owner], [['Met at the gala'], 'jordan@soardcharity.com']);
  assert.ok(!(await needs()).some((i) => i.kind === 'moved'));
});

// ─── Found in the ninth round ───────────────────────────────────────

/** env.DB whose first batch fails (a D1 hiccup): the change must leave everything as it was */
const failingOnce = (DB) => { let done = false; return new Proxy(DB, { get(t, k) { if (k === 'batch') return async (st) => { if (!done) { done = true; throw new Error('D1 hiccup'); } return t.batch(st); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } }); };

test('kept from a contact and taken out: one step each, so a failure and the page sending it again never lose the contact’s notes or Keep anonymous', async () => {
  await add(pay({ id: 'gt', contact: 'ct_gt', first: 'Grace Tower', last: 'Foundation', email: 'office@gt.example', amount: 30000 }));
  await doIt({ act: 'anon', key: 'c:ct_gt', on: true });
  await doIt({ act: 'note-add', key: 'c:ct_gt', body: 'Board chair’s family', id: 'note-gt-1' });
  const body = { act: 'org-new', key: 'o:1111222233334444', name: 'Grace Tower Foundation', links: [{ kind: 'contact', subject: 'ct_gt' }] };
  await assert.rejects(C.act({ DB: failingOnce(db) }, body, by, { now: NOW }));
  assert.equal(await db.prepare("SELECT 1 AS y FROM donor_orgs WHERE key = 'o:1111222233334444'").first(), null, 'nothing made');
  assert.equal((await db.prepare("SELECT subject FROM donor_notes WHERE id = 'note-gt-1'").first()).subject, 'c:ct_gt', 'the note still the contact’s');
  await doIt(body);
  assert.equal((await db.prepare("SELECT subject FROM donor_notes WHERE id = 'note-gt-1'").first()).subject, 'o:1111222233334444');
  assert.ok(await db.prepare("SELECT 1 AS y FROM donor_calls WHERE kind = 'made-from' AND subject = 'o:1111222233334444'").first(), 'made from the contact, in the same step');
  const out = { act: 'org-delete', key: 'o:1111222233334444', was: { notes: ['note-gt-1'], owner: '' } };
  await assert.rejects(C.act({ DB: failingOnce(db) }, out, by, { now: NOW }));
  assert.ok(await db.prepare("SELECT 1 AS y FROM donor_orgs WHERE key = 'o:1111222233334444'").first(), 'a failure takes nothing out');
  await doIt(out);
  assert.equal((await doIt(out)).same, true, 'sent again: done already');
  const page = await C.personView(env, 'ct_gt', { now: NOW });
  assert.deepEqual([page.notes.map((n) => n.id), page.keepAnonymous], [['note-gt-1'], true], 'back with the contact');
});

test('Move to Champion sent again after the partner moved: done (its answer written), never “nothing was changed”', async () => {
  const real = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await real.exec('CREATE TABLE IF NOT EXISTS kids (slug TEXT, name TEXT, data TEXT)').catch(() => {});
  await real.prepare('INSERT INTO partners (slug, name, level, category, data) VALUES (?, ?, ?, ?, ?)').bind('acme', 'Acme Builders', 'champion', 'funding', JSON.stringify({ name: 'Acme Builders', slug: 'acme', level: 'champion', category: ['funding'] })).run();
  const r = await C.act({ DB: real }, { act: 'level', org: 'p:acme', done: true, was: 'Friend', move: true }, by, { now: NOW });
  assert.equal(r.same, true);
  assert.ok(await real.prepare("SELECT 1 AS y FROM donor_calls WHERE kind = 'level' AND subject = 'p:acme' AND answer = 1").first());
});

test('a kept-anonymous contact Zeffy split between two: both kept at once; a stale pick of where its notes go is refused', async () => {
  await withTeam();
  await add(pay({ id: 'k1', contact: 'ct_kold', first: 'Ivy', last: 'Kept', email: 'ivy@example.com' }), pay({ id: 'k2', contact: 'ct_kold', first: 'Ivy', last: 'Kept', email: 'ivy@example.com' }));
  await doIt({ act: 'anon', key: 'c:ct_kold', on: true });
  await doIt({ act: 'note-add', key: 'c:ct_kold', body: 'Gives quietly', id: 'note-ivy' });
  await add(pay({ id: 'k1', contact: 'ct_ka', first: 'Ivy', last: 'Kept', email: 'ivy@example.com' }), pay({ id: 'k2', contact: 'ct_kb', first: 'Ivy', last: 'Kept', email: 'ivy2@example.com' }));
  await C.followMerges(db, { now: NOW });
  const crm = await C.loadCrm(db, { now: NOW });
  assert.deepEqual([crm.keptKey('c:ct_ka'), crm.keptKey('c:ct_kb')], [true, true], 'privacy first: both kept');
  const card = (await needs()).find((i) => i.kind === 'moved');
  assert.equal(card.anon, true);
  assert.deepEqual(card.who.map((w) => w.email).sort(), ['ivy2@example.com', 'ivy@example.com'], 'told apart by email');
  await C.act(env, { act: 'moved-done', contact: 'ct_kold', to: 'ct_kb', asked: true }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(doIt({ act: 'moved-done', contact: 'ct_kold', to: 'ct_ka', asked: true }), (e) => e.status === 409);
  assert.equal((await doIt({ act: 'moved-done', contact: 'ct_kold', to: 'ct_kb', asked: true })).same, true);
});

test('a link sent again (its answer lost) is done already, with one History entry', async () => {
  await withTeam();
  await add(pay({ id: 'hl', company: 'Bright Futures LLC', amount: 20000 }));
  await doIt({ act: 'link', kind: 'company', subject: 'Bright Futures LLC', org: 'p:pella' });
  assert.equal((await doIt({ act: 'link', kind: 'company', subject: 'Bright Futures LLC', org: 'p:pella' })).same, true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'donor-crm' AND entity_name LIKE 'Linked%'").first()).n, 1);
});

test('a person joined from two records is named as they gave last, whichever record leads', async () => {
  await add(pay({ id: 'nm1', contact: 'ct_aa', first: 'Filler', last: 'Donor', email: 'f@example.com', created: S(NOW - 300 * DAY) }), pay({ id: 'nm2', contact: 'ct_zz', first: 'Uma', last: 'Small', email: 'uma@example.com', created: S(NOW - DAY) }));
  await doIt({ act: 'same', a: 'c:ct_aa', b: 'c:ct_zz', same: true });
  assert.ok((await list()).some((p) => p.name === 'Uma Small' && p.gifts === 2));
});

// ─── Found in the tenth round ───────────────────────────────────────

test('a record taken out of a person, sent again: done, and the answer says where the person is, as the first did', async () => {
  await add(pay({ id: 'sa1', contact: 'ct_sa', first: 'Rae', last: 'Lin', email: 'rae@example.com' }), pay({ id: 'sa2', contact: 'ct_sb', first: 'Rae', last: 'Lin', email: 'rae.lin@example.org', created: S(NOW - 3 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_sa', b: 'c:ct_sb', same: true });
  const first = await doIt({ act: 'split', key: 'c:ct_sa' });
  const again = await doIt({ act: 'split', key: 'c:ct_sa' });
  assert.deepEqual([again.same, again.key, again.ref], [true, first.key, first.ref]);
});

test('Take it out from a page read before a teammate set an owner: refused in the same step, and the owner stays', async () => {
  await withTeam();
  const { key } = await doIt({ act: 'org-new', name: 'Elm Trust', links: [] });
  const teammate = () => db.prepare("INSERT INTO donor_calls (kind, subject, target, answer, note, by, at) VALUES ('owner', ?, '', 1, 'jordan@soardcharity.com', 'jordan@soardcharity.com', ?)").bind(key, new Date(NOW).toISOString()).run();
  await assert.rejects(C.act({ DB: racing(db, teammate) }, { act: 'org-delete', key, was: { notes: [], owner: '' } }, by, { now: NOW }), (e) => e.status === 409);
  assert.ok(await db.prepare('SELECT 1 AS y FROM donor_orgs WHERE key = ?').bind(key).first(), 'still here');
  assert.equal((await C.orgView(env, key, { now: NOW })).owner, 'jordan@soardcharity.com');
});

test('Keep anonymous turned off, sent again: done already, one History entry', async () => {
  await withTeam();
  await add(pay({ id: 'ko', contact: 'ct_ko', first: 'Ko', last: 'Quiet', email: 'ko@example.com' }));
  await doIt({ act: 'anon', key: 'c:ct_ko', on: true });
  await doIt({ act: 'anon', key: 'c:ct_ko', on: false });
  assert.equal((await doIt({ act: 'anon', key: 'c:ct_ko', on: false })).same, true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_name LIKE 'No longer kept anonymous%'").first()).n, 1);
});

test('organizations named in another script can each be kept (their names told apart by their own letters)', async () => {
  const a = await doIt({ act: 'org-new', name: '한인교회', links: [] });
  const b = await doIt({ act: 'org-new', name: '日本財団', links: [] });
  assert.notEqual(a.key, b.key);
  await assert.rejects(doIt({ act: 'org-new', name: '日本財団', links: [] }), (e) => e.status === 409, 'the same one twice is still one');
});

test('a joined person counted for an organization is one name there; Take off takes all their records', async () => {
  await add(pay({ id: 'dw1', contact: 'ct_dw1', first: 'Dana', last: 'Whitfield', email: 'dana@example.com', amount: 5000 }), pay({ id: 'dw2', contact: 'ct_dw2', first: 'Dana', last: 'Whitfield', email: 'dana@example.org', amount: 4000, created: S(NOW - 3 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_dw1', b: 'c:ct_dw2', same: true });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_dw1', subjects: ['ct_dw1', 'ct_dw2'], org: 'p:pella' });
  const names = (await C.orgView(env, 'p:pella', { now: NOW })).names.filter((n) => n.kind === 'contact');
  assert.equal(names.length, 1);
  assert.deepEqual(names[0].subjects.sort(), ['ct_dw1', 'ct_dw2']);
  await doIt({ act: 'not', kind: 'contact', subject: names[0].subject, subjects: names[0].subjects, org: 'p:pella' });
  assert.ok(!(await list()).some((p) => p.key === 'p:pella'), 'nothing of hers counts for Pella');
});

// ─── Found in the eleventh round ────────────────────────────────────

test('Keep as an organization looks at the contact’s own gifts, never another contact’s that shares its email', async () => {
  await add(pay({ id: 'hc1', contact: 'ct_hc', first: 'Hope', last: 'Church', email: 'office@hopechurch.example', amount: 250000 }));
  await add(pay({ id: 'jd1', contact: 'ct_jd', first: 'John', last: 'Doe', email: 'office@hopechurch.example', amount: 5000, company: 'Acme Builders' }));
  const { key } = await doIt({ act: 'org-new', name: 'Hope Church', links: [{ kind: 'contact', subject: 'ct_hc' }] });
  assert.equal((await list()).find((p) => p.key === key)?.total, 250000);
});

test('a gift with no contact under the email of a contact that is an organization counts for that organization', async () => {
  await db.prepare(partner('ivers', 'Ivers Foundation')).run();
  await add(pay({ id: 'iv1', contact: 'ct_iv', first: 'Ivers', last: 'Foundation', email: 'info@ivers.example', amount: 500000 }));
  await add(pay({ id: 'iv2', contact: null, first: 'Mary', last: 'Ivers', email: 'info@ivers.example', amount: 300000, method: 'cheque', type: 'manual' }));
  const people = await list();
  assert.equal(people.find((p) => p.key === 'p:ivers')?.total, 800000, 'both gifts are the foundation’s');
  assert.ok(!people.some((p) => p.type === 'person' && /Mary Ivers|info@ivers/.test(p.name)));
  assert.deepEqual((await C.orgView(env, 'p:ivers', { now: NOW })).gifts.map((g) => g.id).sort(), ['iv1', 'iv2']);
});

test('Take it out from a page read before a teammate kept it anonymous: refused, and it stays kept', async () => {
  const { key } = await doIt({ act: 'org-new', name: 'Quiet Society', links: [] });
  await doIt({ act: 'anon', key, on: true });
  await assert.rejects(doIt({ act: 'org-delete', key, was: { notes: [], owner: '', kept: false } }), (e) => e.status === 409 && /kept it anonymous/.test(e.message));
  assert.ok((await C.loadCrm(db, { now: NOW })).keptKey(key));
});

test('a joined person’s one Zeffy record linked from an organization’s page links all of theirs', async () => {
  await add(pay({ id: 'jp1', contact: 'ct_jp1', first: 'Pat', last: 'Joined', email: 'pat@example.com', amount: 5000 }), pay({ id: 'jp2', contact: 'ct_jp2', first: 'Pat', last: 'Joined', email: 'pat@example.org', amount: 4000, created: S(NOW - 3 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_jp1', b: 'c:ct_jp2', same: true });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_jp2', org: 'p:pella' });
  assert.equal((await list()).find((p) => p.key === 'p:pella')?.total, 9000);
});

// ─── Found in the twelfth round ─────────────────────────────────────

test('Link to… from a page read before a teammate linked it elsewhere is refused; moving it from where the person saw it is theirs', async () => {
  await add(pay({ id: 'sl', contact: 'ct_lee', first: 'Lee', last: 'Sample', email: 'lee@example.com', company: 'Sample Builders', amount: 30000 }));
  await C.act(env, { act: 'link', kind: 'company', subject: 'Sample Builders', org: 'p:acme' }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(doIt({ act: 'link', kind: 'company', subject: 'Sample Builders', org: 'p:pella' }), (e) => e.status === 409 && /Acme Builders already/.test(e.message));
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 30000, 'Jordan’s link stands');
  await doIt({ act: 'link', kind: 'company', subject: 'Sample Builders', org: 'p:pella', from: 'p:acme' });
  assert.equal((await list()).find((p) => p.key === 'p:pella')?.total, 30000, 'moved, seeing where it was');
});

test('a rename keeps the organization’s own Zeffy contact its own (never told “not this one”)', async () => {
  await add(pay({ id: 'oc1', contact: 'ct_bw', first: 'Birchwood', last: 'Homes', email: 'office@birchwood.example', company: 'Birchwood', amount: 50000 }));
  const { key } = await doIt({ act: 'org-new', name: 'Birchwood', links: [{ kind: 'company', subject: 'Birchwood' }] });
  await doIt({ act: 'org-rename', key, name: 'Birchwood Homes', was: 'Birchwood' });
  assert.equal(await db.prepare("SELECT 1 AS y FROM donor_calls WHERE kind = 'contact' AND subject = 'ct_bw' AND answer = 0").first(), null);
  await add(pay({ id: 'oc2', contact: 'ct_bw', first: 'Birchwood', last: 'Homes', email: 'office@birchwood.example', amount: 70000, created: S(NOW - 2 * DAY) }));
  assert.equal((await list()).find((p) => p.key === key)?.total, 120000, 'its later gift counts for it too');
});

// ─── Found in the thirteenth round ──────────────────────────────────

test('a Needs you Yes about one of a joined person’s records never takes their other record from another organization', async () => {
  await add(pay({ id: 'cw', contact: 'ct_work', first: 'Chris', last: 'Moreno', email: 'chris@work.example', amount: 90000 }), pay({ id: 'chm', contact: 'ct_home', first: 'Chris', last: 'Moreno', email: 'chris@home.example', amount: 5000, created: S(NOW - 3 * DAY) }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_work', org: 'p:acme' });
  await doIt({ act: 'same', a: 'c:ct_work', b: 'c:ct_home', same: true });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_home', org: 'p:moreno', asked: true });
  assert.equal((await list()).find((p) => p.key === 'p:acme')?.total, 90000, 'Acme keeps the record counted for it');
  assert.equal((await list()).find((p) => p.key === 'p:moreno')?.total, 5000, 'the one asked about counts for the Morenos');
});

test('“Not the same person” on a record that led before another joined: the person keeps what was said about them', async () => {
  await withTeam();
  await add(pay({ id: 'mm', contact: 'ct_m', first: 'Maria', last: 'Lopez', email: 'maria@example.com', created: S(NOW - 10 * DAY) }), pay({ id: 'mz', contact: 'ct_z', first: 'Maria', last: 'Lopez', email: 'maria.l@example.org', created: S(NOW - 9 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_m', b: 'c:ct_z', same: true });
  const lead1 = (await C.loadCrm(db, { now: NOW })).canon('c:ct_m');
  await doIt({ act: 'owner', key: lead1, email: 'alex@soardcharity.com', was: '' });
  await doIt({ act: 'note-add', key: lead1, body: 'Wants to sponsor a room', id: 'note-maria' });
  await add(pay({ id: 'ma', contact: 'ct_a', first: 'Maria', last: 'Lopez', email: 'm.lopez@example.net', created: S(NOW - 8 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_a', b: lead1, same: true });
  const crm = await C.loadCrm(db, { now: NOW });
  const lead2 = crm.canon(lead1);
  assert.notEqual(lead2, lead1, 'another record leads now');
  await doIt({ act: 'split', key: lead1 });
  const page = await C.personView(env, lead2.slice(2), { now: NOW });
  assert.deepEqual([page.owner, page.notes.map((n) => n.id)], ['alex@soardcharity.com', ['note-maria']]);
});

test('Keep as an organization, then Take it out: a year on, the question can be answered again', async () => {
  await add(pay({ id: 'bk', contact: 'ct_bk', first: 'Ann', last: 'Ivers', email: 'ann@example.com', company: 'Ivers Foundation', amount: 1500000, created: S(NOW - 30 * DAY) }));
  const q = (await needs()).find((i) => i.kind === 'big');
  const { key } = await doIt({ act: 'org-new', name: 'Ivers Foundation', links: [{ kind: 'company', subject: 'Ivers Foundation' }], asked: true, subject: q.subject, also: q.also || [] });
  await doIt({ act: 'org-delete', key, was: { notes: [], owner: '', kept: false } });
  assert.equal(await db.prepare("SELECT 1 AS y FROM donor_calls WHERE kind = 'big' AND note = 'org'").first(), null, 'its answer went with it');
});

// ─── Found in the fourteenth round ──────────────────────────────────

test('a contact kept as an organization and taken out: its question can be answered again', async () => {
  await add(pay({ id: 'kx', contact: 'ct_x', first: 'Ivers Family', last: 'Foundation', email: 'ivers@example.org', amount: 1500000, created: S(NOW - 30 * DAY) }));
  const q = (await needs()).find((i) => i.kind === 'big' || i.kind === 'named');
  const { key } = await doIt({ act: 'org-new', name: 'Ivers Family Foundation', links: [{ kind: 'contact', subject: 'ct_x' }], asked: true, subject: q.subject, also: q.also || [] });
  await doIt({ act: 'org-delete', key, was: { notes: [], owner: '', kept: false } });
  assert.equal(await db.prepare("SELECT 1 AS y FROM donor_calls WHERE kind = 'big' AND note = 'org'").first(), null, 'its answer went with it, never moved to the contact');
  const again = (await needs()).find((i) => i.subject === q.subject);
  assert.ok(again, 'asked again');
  assert.equal((await doIt({ act: 'big', subject: again.subject, also: again.also || [], asked: true })).ok, true, 'and it can be answered');
});

test('two staff answering at the same moment: the first stands, the second is told, never a quiet replacement', async () => {
  await add(pay({ id: 'cc', company: 'Sample Builders', amount: 300000 }));
  const jordan = () => C.act(env, { act: 'link', kind: 'company', subject: 'Sample Builders', org: 'p:pella' }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(C.act({ DB: racing(db, jordan) }, { act: 'link', kind: 'company', subject: 'Sample Builders', org: 'p:acme' }, by, { now: NOW }), (e) => e.status === 409);
  assert.equal((await list()).find((p) => p.key === 'p:pella')?.total, 300000, 'Jordan’s answer stands');
  await add(pay({ id: 'sm1', contact: 'ct_m1', first: 'Maria', last: 'Lopez', email: 'maria@example.com' }), pay({ id: 'sm2', contact: 'ct_m2', first: 'Maria', last: 'Lopez', email: 'mlopez@example.org', created: S(NOW - 3 * DAY) }));
  const notSame = () => C.act(env, { act: 'same', a: 'c:ct_m1', b: 'c:ct_m2', same: false }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(C.act({ DB: racing(db, notSame) }, { act: 'same', a: 'c:ct_m1', b: 'c:ct_m2', same: true }, by, { now: NOW }), (e) => e.status === 409);
  const crm = await C.loadCrm(db, { now: NOW });
  assert.notEqual(crm.canon('c:ct_m1'), crm.canon('c:ct_m2'), 'still two donors, as Jordan said');
});

test('Put it on the website at the same moment a teammate adds a Zeffy name to it: refused, and the name is never left behind', async () => {
  await add(pay({ id: 'wb', contact: 'ct_bob', first: 'Bob', last: 'Ivers', email: 'bob@example.com', amount: 500000 }));
  const { key } = await doIt({ act: 'org-new', name: 'Ivers Fund', links: [] });
  await db.prepare(partner('ivers-fund', 'Ivers Fund')).run();
  const jordan = () => C.act(env, { act: 'link', kind: 'contact', subject: 'ct_bob', org: key }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(C.act({ DB: racing(db, jordan) }, { act: 'website', key, slug: 'ivers-fund', was: { kept: false } }, by, { now: NOW }), (e) => e.status === 409);
  assert.ok(await db.prepare('SELECT 1 AS y FROM donor_orgs WHERE key = ?').bind(key).first(), 'still kept here, with Bob linked to it');
  await doIt({ act: 'website', key, slug: 'ivers-fund', was: { kept: false } });
  assert.equal((await list()).find((p) => p.key === 'p:ivers-fund')?.total, 500000, 'Bob’s gift goes with it');
});

// ─── Found in the fifteenth round ───────────────────────────────────

test('Keep as an organization on a company named after its giver (“Jane Doe LLC”): the gifts for the company only', async () => {
  await add(pay({ id: 'jl1', contact: 'ct_jd', first: 'Jane', last: 'Doe', email: 'jd@example.com', company: 'Jane Doe LLC', amount: 25000 }),
    pay({ id: 'jl2', contact: 'ct_jd', first: 'Jane', last: 'Doe', email: 'jd@example.com', amount: 5000, created: S(NOW - 2 * DAY) }));
  const { key } = await doIt({ act: 'org-new', name: 'Jane Doe LLC', links: [{ kind: 'company', subject: 'Jane Doe LLC' }] });
  assert.equal((await list()).find((p) => p.key === key)?.total, 25000);
  const page = await C.personView(env, 'ct_jd', { now: NOW });
  assert.ok(!page.org, 'she keeps her page');
  assert.equal(page.donor.total, 5000, 'and her own gift');
});

test('at the same moment as a teammate: Keep as an organization, Not the same person and a split card’s pick are each refused, never written over theirs', async () => {
  await add(pay({ id: 'rc1', contact: 'ct_chris', first: 'Chris', last: 'Hale', email: 'chris@example.com', amount: 50000 }));
  const linkIt = () => C.act(env, { act: 'link', kind: 'contact', subject: 'ct_chris', org: 'p:pella' }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(C.act({ DB: racing(db, linkIt) }, { act: 'org-new', name: 'Chris Hale Fund', links: [{ kind: 'contact', subject: 'ct_chris' }] }, by, { now: NOW }), (e) => e.status === 409);
  assert.equal((await list()).find((p) => p.key === 'p:pella')?.total, 50000, 'Jordan’s link stands');
  await add(pay({ id: 'ra', contact: 'ct_ra', first: 'Rae', last: 'Joy', email: 'r1@example.com' }), pay({ id: 'rb2', contact: 'ct_rb', first: 'Rae', last: 'Joy', email: 'r2@example.com', created: S(NOW - 2 * DAY) }), pay({ id: 'rcc', contact: 'ct_rc', first: 'Rae', last: 'Joy', email: 'r3@example.com', created: S(NOW - 3 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_ra', b: 'c:ct_rb', same: true });
  await doIt({ act: 'same', a: 'c:ct_ra', b: 'c:ct_rc', same: true });
  const splitB = () => C.act(env, { act: 'split', key: 'c:ct_rb' }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(C.act({ DB: racing(db, splitB) }, { act: 'split', key: 'c:ct_ra' }, by, { now: NOW }), (e) => e.status === 409);
  const crm = await C.loadCrm(db, { now: NOW });
  assert.equal(crm.keysOf(crm.canon('c:ct_rb')).length, 1, 'the record Jordan took out stays its own');
});

test('a contact Zeffy split, picked by two staff at once: the first stands', async () => {
  await withTeam();
  await add(pay({ id: 'my1', contact: 'ct_x', first: 'Mo', last: 'Ray', email: 'mo@example.com' }), pay({ id: 'my2', contact: 'ct_y', first: 'Mo', last: 'Ray', email: 'mo2@example.com' }));
  await db.prepare("INSERT OR REPLACE INTO donor_state (key, value) VALUES ('crm', ?)").bind(JSON.stringify({ unplaced: [{ contact: 'ct_old', to: ['ct_x', 'ct_y'], at: new Date(NOW).toISOString() }] })).run();
  await db.prepare("INSERT INTO donor_notes (id, subject, body, by, at) VALUES ('note-mo', 'c:ct_old', 'Prefers email', ?, ?)").bind(by, new Date(NOW).toISOString()).run();
  const jordan = () => C.act(env, { act: 'moved-done', contact: 'ct_old', to: 'ct_y' }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(C.act({ DB: racing(db, jordan) }, { act: 'moved-done', contact: 'ct_old', to: 'ct_x' }, by, { now: NOW }), (e) => e.status === 409);
  assert.equal((await db.prepare("SELECT subject FROM donor_notes WHERE id = 'note-mo'").first()).subject, 'c:ct_y');
  assert.equal((await db.prepare("SELECT note FROM donor_calls WHERE kind = 'moved' AND subject = 'ct_old'").first()).note, 'ct_y');
});

test('a joined person’s page counts their own records for an organization; one already counted for another stays there', async () => {
  await add(pay({ id: 'pj1', contact: 'ct_p1', first: 'Pat', last: 'Lane', email: 'pat@example.com', amount: 5000 }), pay({ id: 'pj2', contact: 'ct_p2', first: 'Pat', last: 'Lane', email: 'pat@example.org', amount: 7000, created: S(NOW - 3 * DAY) }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_p2', org: 'p:acme' });
  await doIt({ act: 'same', a: 'c:ct_p1', b: 'c:ct_p2', same: true });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_p1', subjects: ['ct_p1', 'ct_p2'], org: 'p:pella' });
  const people = await list();
  assert.deepEqual([people.find((p) => p.key === 'p:pella')?.total, people.find((p) => p.key === 'p:acme')?.total], [5000, 7000]);
});

// ─── Found in the sixteenth round ───────────────────────────────────

test('Move to Champion from a card read before the partner was kept anonymous: refused, its level unchanged', async () => {
  const real = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await real.exec('CREATE TABLE IF NOT EXISTS kids (slug TEXT, name TEXT, data TEXT)').catch(() => {});
  await real.prepare('INSERT INTO partners (slug, name, level, category, data) VALUES (?, ?, ?, ?, ?)').bind('acme', 'Acme Builders', 'friend', 'funding', JSON.stringify({ name: 'Acme Builders', slug: 'acme', level: 'friend', category: ['funding'] })).run();
  const renv = { DB: real };
  await D.noteDonorPayment(renv, pay({ id: 'ck1', company: 'Acme Builders', amount: 1200000, created: S(NOW - 20 * DAY) }), { now: NOW });
  await C.act(renv, { act: 'anon', key: 'p:acme', on: true }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(C.act(renv, { act: 'level', org: 'p:acme', done: true, was: 'Friend', asked: true, move: true }, by, { now: NOW }), (e) => e.status === 409 && /kept anonymous/.test(e.message));
  assert.equal(JSON.parse((await real.prepare("SELECT data FROM partners WHERE slug = 'acme'").first()).data).level, 'friend');
});

test('Not the same person at the same moment as a teammate’s join or owner change: refused, theirs stands', async () => {
  await withTeam();
  await add(pay({ id: 'sz1', contact: 'ct_m', first: 'Zed', last: 'Ray', email: 'z1@example.com' }), pay({ id: 'sz2', contact: 'ct_z', first: 'Zed', last: 'Ray', email: 'z2@example.com', created: S(NOW - 2 * DAY) }), pay({ id: 'sz3', contact: 'ct_a', first: 'Zed', last: 'Ray', email: 'z3@example.com', created: S(NOW - 3 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_m', b: 'c:ct_z', same: true });
  const join = () => C.act(env, { act: 'same', a: 'c:ct_a', b: 'c:ct_z', same: true }, 'jordan@soardcharity.com', { now: NOW });
  await assert.rejects(C.act({ DB: racing(db, join) }, { act: 'split', key: 'c:ct_z' }, by, { now: NOW }), (e) => e.status === 409);
  const crm = await C.loadCrm(db, { now: NOW });
  assert.equal(crm.canon('c:ct_a'), crm.canon('c:ct_z'), 'Jordan’s join stands');
});

test('the organization’s “Who gave for it” counts a gift Zeffy took in three charges as one gift', async () => {
  for (const [i, c] of [[1, 400000], [2, 400000], [3, 200000]]) await add(pay({ id: `tc${i}`, company: 'Acme Builders', amount: c, created: S(NOW - 5 * DAY) + i * 60 }));
  const p = (await C.orgView(env, 'p:acme', { now: NOW })).people[0];
  assert.deepEqual([p.cents, p.gifts], [1000000, 1]);
});

test('Keep anonymous turned off for someone still kept by a shared name: said so', async () => {
  await add(pay({ id: 'kp1', contact: 'ct_kp1', first: 'Kim', last: 'Park', email: 'kim1@example.com' }), pay({ id: 'kp2', contact: 'ct_kp2', first: 'Kim', last: 'Park', email: 'kim2@example.com' }));
  await doIt({ act: 'anon', key: 'c:ct_kp1', on: true });
  await doIt({ act: 'anon', key: 'c:ct_kp2', on: true });
  assert.equal((await doIt({ act: 'anon', key: 'c:ct_kp2', on: false })).still, true);
});

// ─── Found in the seventeenth round ─────────────────────────────────

test('Not the same person on a record Zeffy has since merged into someone else: that record comes out, the lead keeps her notes and owner', async () => {
  await withTeam();
  await add(pay({ id: 'ja1', contact: 'ct_ja', first: 'Jane', last: 'Doe', email: 'jane@example.com' }),
    pay({ id: 'jx1', contact: 'ct_jx', first: 'Jane', last: 'Doe', email: 'jane3@example.com' }),
    pay({ id: 'jy1', contact: 'ct_jy', first: 'Joan', last: 'Roe', email: 'joan@example.com' }));
  await doIt({ act: 'same', a: 'c:ct_ja', b: 'c:ct_jx', same: true });
  await doIt({ act: 'note-add', key: 'c:ct_ja', body: 'Jane: prefers a call', id: 'note-ja-1' });
  await doIt({ act: 'owner', key: 'c:ct_ja', email: 'alex@soardcharity.com' });
  // Zeffy merges ct_jx into Joan's record before anyone reads again
  await add(pay({ id: 'jx1', contact: 'ct_jy', first: 'Jane', last: 'Doe', email: 'jane3@example.com' }));
  await doIt({ act: 'split', key: 'c:ct_jx' });
  const jane = await C.personView(env, 'ct_ja', { now: NOW });
  const joan = await C.personView(env, 'ct_jy', { now: NOW });
  assert.deepEqual([jane.owner, jane.notes.map((n) => n.body)], ['alex@soardcharity.com', ['Jane: prefers a call']]);
  assert.deepEqual([joan.owner, joan.notes.length], [null, 0]);
  const crm = await C.loadCrm(db, { now: NOW });
  assert.notEqual(crm.canon('c:ct_ja'), crm.canon('c:ct_jy'), 'the merged record is out of Jane’s group');
});

test('an organization’s page says which notes and owner are its own (a linked contact’s stay theirs when it’s taken out)', async () => {
  await withTeam();
  await add(pay({ id: 'kw1', contact: 'ct_kw', first: 'Ken', last: 'Wu', email: 'ken@example.com', amount: 50000 }));
  await doIt({ act: 'note-add', key: 'c:ct_kw', body: 'Ken: a makeover in 2019', id: 'note-kw-1' });
  await doIt({ act: 'owner', key: 'c:ct_kw', email: 'alex@soardcharity.com' });
  const made = await doIt({ act: 'org-new', name: 'Wu Family Trust', key: 'o:0123456789abcdef' });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_kw', org: made.key });
  let page = await C.orgView(env, made.key, { now: NOW });
  assert.deepEqual(page.notes.map((n) => n.subject), ['c:ct_kw']);
  assert.equal(page.ownOwner, null);
  await doIt({ act: 'note-add', key: made.key, body: 'Trust: call in March', id: 'note-wt-1' });
  await doIt({ act: 'owner', key: made.key, email: 'jordan@soardcharity.com' });
  page = await C.orgView(env, made.key, { now: NOW });
  assert.deepEqual(page.notes.filter((n) => n.subject === made.key).map((n) => n.body), ['Trust: call in March']);
  assert.equal(page.ownOwner, 'jordan@soardcharity.com');
  await doIt({ act: 'org-delete', key: made.key });
  const ken = await C.personView(env, 'ct_kw', { now: NOW });
  assert.deepEqual([ken.owner, ken.notes.map((n) => n.body)], ['alex@soardcharity.com', ['Ken: a makeover in 2019']]);
});

// ─── Found in the seventeenth round's QA ────────────────────────────

test('Count it for an organization on a record Zeffy moved since the page was read: it counts where the gifts are now', async () => {
  await add(pay({ id: 'mm1', contact: 'ct_mia', first: 'Mia', last: 'Mover', email: 'mia@example.com', amount: 50000 }));
  await add(pay({ id: 'mm1', contact: 'ct_mia_new', first: 'Mia', last: 'Mover', email: 'mia@example.com', amount: 50000 }));
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_mia', subjects: ['ct_mia'], org: 'p:acme' });
  const crm = await C.loadCrm(db, { now: NOW });
  assert.equal(crm.calls.yes.get('contact\nct_mia_new'), 'p:acme');
  assert.ok(!(await list()).some((p) => p.key === 'c:ct_mia_new'), 'she counts for Acme, not as a person');
});

test('Same person as a record Zeffy moved since the page was read: the two are one donor at once', async () => {
  await add(pay({ id: 'nl1', contact: 'ct_nellie', first: 'Nellie', last: 'Bly', email: 'nellie@example.com', amount: 3000 }),
    pay({ id: 'nl2', contact: 'ct_nell', first: 'Nell', last: 'Bly', email: 'nell@example.com', amount: 20000 }));
  await add(pay({ id: 'nl2', contact: 'ct_nell_new', first: 'Nell', last: 'Bly', email: 'nell@example.com', amount: 20000 }));
  await doIt({ act: 'same', a: 'c:ct_nellie', b: 'c:ct_nell', same: true });
  const crm = await C.loadCrm(db, { now: NOW });
  assert.equal(crm.canon('c:ct_nellie'), crm.canon('c:ct_nell_new'));
  const one = (await list()).find((p) => p.key === crm.canon('c:ct_nellie'));
  assert.equal(one.total, 23000);
});

test('a donor address Zeffy merged into another opens that one', async () => {
  await add(pay({ id: 'ad1', contact: 'ct_adr', first: 'Ada', last: 'Ray', email: 'ada@example.com' }));
  await add(pay({ id: 'ad1', contact: 'ct_adr_new', first: 'Ada', last: 'Ray', email: 'ada@example.com' }));
  assert.equal(await C.personView(env, 'ct_adr', { now: NOW }), null);
  assert.equal(await C.movedTo(env, 'ct_adr'), 'ct_adr_new');
  assert.equal(await C.movedTo(env, 'ct_adr_new'), null, 'a record with gifts of its own is where it is');
  assert.equal(await C.movedTo(env, 'ct_nobody'), null);
});

test('a donor page names the record it shows as theirs (a lost Same person answer checks against it too)', async () => {
  await add(pay({ id: 'bo1', contact: 'ct_bea_old', first: 'Bea', last: 'Older', email: 'bea@example.com', created: S(NOW - 100 * DAY) }),
    pay({ id: 'bo2', contact: 'ct_bea_new', first: 'Beatrice', last: 'Older', email: 'beatrice@example.com', created: S(NOW - 2 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_bea_old', b: 'c:ct_bea_new', same: true });
  const v = await C.personView(env, 'ct_bea_old', { now: NOW });
  assert.deepEqual([v.shownAs, ...v.also.map((x) => x.key)].sort(), ['c:ct_bea_new', 'c:ct_bea_old']);
});

test('every change names the mark it moved the lists to, refusals too (the tab knows its own)', async () => {
  await add(pay({ id: 'rv1', contact: 'ct_rv', first: 'Rae', last: 'Vee', email: 'rae@example.com' }));
  const a = await doIt({ act: 'owner', key: 'c:ct_rv', email: 'alex@soardcharity.com' });
  const b = await doIt({ act: 'note-add', key: 'c:ct_rv', body: 'Hello', id: 'note-rv-1' });
  assert.ok(Number.isFinite(a.rev) && b.rev === a.rev + 1);
  const e = await doIt({ act: 'owner', key: 'c:ct_rv', email: 'jordan@soardcharity.com', was: 'nobody@example.com' }).catch((x) => x);
  assert.equal(e.status, 409);
  assert.equal(e.rev, b.rev + 1);
});

// ─── Found in the eighteenth round ──────────────────────────────────

test('a joined person whose lead record Zeffy split: what was said about it is theirs at once (never asked), and every page of theirs works', async () => {
  await withTeam();
  await add(pay({ id: 'ja', contact: 'ct_jane', first: 'Jane', last: 'Doe', email: 'jane@example.com', amount: 10000 }),
    pay({ id: 'jb1', contact: 'ct_0ld', first: 'Jane', last: 'Doe', email: 'jd@example.com', amount: 2000 }),
    pay({ id: 'jb2', contact: 'ct_0ld', first: 'Jane', last: 'Doe', email: 'jd@example.com', amount: 3000, created: S(NOW - 400 * DAY) }));
  await doIt({ act: 'same', a: 'c:ct_jane', b: 'c:ct_0ld', same: true });
  assert.equal((await C.loadCrm(db, { now: NOW })).canon('c:ct_jane'), 'c:ct_0ld', 'the record that sorts first leads');
  await doIt({ act: 'note-add', key: 'c:ct_0ld', body: 'Jane: met at the gala', id: 'note-jd-1' });
  await doIt({ act: 'owner', key: 'c:ct_0ld', email: 'alex@soardcharity.com' });
  // Zeffy splits ct_0ld's two gifts between two contacts; a change on a page read before comes in before the whole read
  await add(pay({ id: 'jb1', contact: 'ct_x', first: 'Jane', last: 'Doe', email: 'jd@example.com', amount: 2000 }),
    pay({ id: 'jb2', contact: 'ct_y', first: 'Jane', last: 'Doe', email: 'jd@example.com', amount: 3000, created: S(NOW - 400 * DAY) }));
  await doIt({ act: 'note-add', key: 'c:ct_0ld', body: 'From a page read before', id: 'note-jd-2' });
  // Nothing asked: it was part of Jane, so it's Jane's
  assert.ok(!(await needs()).some((x) => x.kind === 'moved'));
  const page = await C.personView(env, 'ct_jane', { now: NOW });
  assert.equal(page.key, 'c:ct_jane');
  assert.deepEqual(page.notes.map((n) => n.body).sort(), ['From a page read before', 'Jane: met at the gala']);
  assert.equal(page.owner, 'alex@soardcharity.com');
  assert.ok(page.formerly.includes('c:ct_0ld'), 'her page names the record that was hers, so a note written on it comes here');
  // Not the same person on the emptied record, from a page read before: it's hers now, said so
  await assert.rejects(doIt({ act: 'split', key: 'c:ct_0ld' }), (e) => e.status === 409 && /split that record’s gifts between other records/.test(e.message));
  // Its address leads to her, as a merge's does
  assert.equal(await C.movedTo(env, 'ct_0ld'), 'ct_jane');
  // And the contacts its gifts went to don't claim it (only she does)
  assert.deepEqual((await C.personView(env, 'ct_x', { now: NOW })).formerly, []);
  // Where a note is now: her page; a deleted one, nowhere
  assert.equal((await C.noteWhere(env, 'note-jd-1', { now: NOW }))?.donor, 'ct_jane');
  assert.equal(await C.noteWhere(env, 'note-nope', { now: NOW }), null);
});

test('a lone record Zeffy split: Needs you asks, and the answer moves its notes and History, its owner only to one with none, never who it is or what it counts for', async () => {
  await withTeam();
  await add(pay({ id: 'lo1', contact: 'ct_lone', first: 'Kay', last: 'Lone', email: 'kay@example.com', amount: 2000 }),
    pay({ id: 'lo2', contact: 'ct_lone', first: 'Kay', last: 'Lone', email: 'kay@example.com', amount: 3000, created: S(NOW - 400 * DAY) }),
    pay({ id: 'kp1', contact: 'ct_kp', first: 'Kay', last: 'Lone', email: 'kay2@example.com', amount: 1000 }),
    pay({ id: 'kb1', contact: 'ct_kb', first: 'Kim', last: 'Lane', email: 'kim@example.com', amount: 500 }));
  await doIt({ act: 'note-add', key: 'c:ct_lone', body: 'Kay: a gala table', id: 'note-kl-1' });
  await doIt({ act: 'owner', key: 'c:ct_lone', email: 'jordan@soardcharity.com' });
  await doIt({ act: 'link', kind: 'contact', subject: 'ct_lone', org: 'p:acme' });
  await doIt({ act: 'owner', key: 'c:ct_kb', email: 'alex@soardcharity.com' });
  await add(pay({ id: 'lo1', contact: 'ct_ka', first: 'Kay', last: 'Lone', email: 'kay@example.com', amount: 2000 }),
    pay({ id: 'lo2', contact: 'ct_kb', first: 'Kay', last: 'Lone', email: 'kay@example.com', amount: 3000, created: S(NOW - 400 * DAY) }));
  // A change on it before the whole read: Zeffy's split is followed now, so Needs you has the question it names
  await assert.rejects(doIt({ act: 'note-add', key: 'c:ct_lone', body: 'More', id: 'note-kl-2' }), (e) => e.status === 409 && /Needs you asks/.test(e.message));
  assert.ok((await needs()).some((x) => x.kind === 'moved' && x.contact === 'ct_lone'));
  await doIt({ act: 'moved-done', contact: 'ct_lone', to: 'ct_kb' });
  const crm = await C.loadCrm(db, { now: NOW });
  const kim = await C.personView(env, 'ct_kb', { now: NOW });
  assert.deepEqual(kim.notes.map((n) => n.body), ['Kay: a gala table'], 'its note went to the one picked');
  assert.equal(kim.owner, 'alex@soardcharity.com', 'the one picked keeps its own owner');
  assert.notEqual(crm.calls.yes.get('contact\nct_kb'), 'p:acme', 'what it counted for isn’t carried over: said again on the right one');
  assert.notEqual(crm.canon('c:ct_kb'), crm.canon('c:ct_kp'), 'nor who it was said to be');
});

test('Same person on two records Zeffy has merged since: one donor already; Not the same is refused, saying why', async () => {
  await add(pay({ id: 'sk1', contact: 'ct_old', first: 'Kay', last: 'Ess', email: 'kay@example.com' }),
    pay({ id: 'sk2', contact: 'ct_keep', first: 'Kay', last: 'Ess', email: 'kay2@example.com' }));
  await add(pay({ id: 'sk1', contact: 'ct_keep', first: 'Kay', last: 'Ess', email: 'kay@example.com' }));
  const r = await doIt({ act: 'same', a: 'c:ct_old', b: 'c:ct_keep', same: true });
  assert.deepEqual([r.ok, r.same, r.key], [true, true, 'c:ct_keep']);
  await assert.rejects(doIt({ act: 'same', a: 'c:ct_old', b: 'c:ct_keep', same: false }), (e) => e.status === 409 && /merged these two records into one/.test(e.message));
});

test('Not the same person on a record Zeffy merged into the person’s own since: refused, saying so (never “done”)', async () => {
  await add(pay({ id: 'na1', contact: 'ct_na', first: 'Nan', last: 'Aye', email: 'nan@example.com' }),
    pay({ id: 'nb1', contact: 'ct_nb', first: 'Nan', last: 'Aye', email: 'nan2@example.com' }));
  await doIt({ act: 'same', a: 'c:ct_na', b: 'c:ct_nb', same: true });
  await add(pay({ id: 'nb1', contact: 'ct_na', first: 'Nan', last: 'Aye', email: 'nan2@example.com' }));
  // (the page names the records it showed as theirs: the one it went into is one of them)
  await assert.rejects(doIt({ act: 'split', key: 'c:ct_nb', others: ['c:ct_na'] }), (e) => e.status === 409 && /merged that record into one of theirs/.test(e.message));
});

test('a Zeffy split comes in a gift at a time: never taken for a merge into the first record its gifts reach', async () => {
  await add(pay({ id: 'sp1', contact: 'ct_sp', first: 'Lou', last: 'Ray', email: 'lou@example.com' }), pay({ id: 'sp2', contact: 'ct_sp', first: 'Lou', last: 'Ray', email: 'lou@example.com' }));
  await doIt({ act: 'note-add', key: 'c:ct_sp', body: 'Lou: board member’s friend', id: 'note-sp-1' });
  await add(pay({ id: 'sp1', contact: 'ct_sp1', first: 'Lou', last: 'Ray', email: 'lou@example.com' }));
  // (half way: the old record still has a gift, so nothing follows yet)
  assert.deepEqual((await C.personView(env, 'ct_sp1', { now: NOW })).notes, []);
  await add(pay({ id: 'sp2', contact: 'ct_sp2', first: 'Lou', last: 'Ray', email: 'lou2@example.com' }));
  assert.ok((await needs()).some((x) => x.kind === 'moved' && x.contact === 'ct_sp'), 'split between two: asked about');
});

test('Count it for an organization on a record Zeffy merged into someone else’s since: the answer names whose it is now', async () => {
  await add(pay({ id: 'ya1', contact: 'ct_yael', first: 'Yael', last: 'Ash', email: 'yael@example.com' }),
    pay({ id: 'yu1', contact: 'ct_yuri', first: 'Yuri', last: 'Ash', email: 'yuri@example.com' }));
  await add(pay({ id: 'ya1', contact: 'ct_yuri', first: 'Yael', last: 'Ash', email: 'yael@example.com' }));
  const r = await doIt({ act: 'link', kind: 'contact', subject: 'ct_yael', subjects: ['ct_yael'], org: 'p:acme' });
  assert.equal(typeof r.followed, 'string');
  assert.ok(/Ash/.test(r.followed));
  const plain = await doIt({ act: 'link', kind: 'contact', subject: 'ct_yuri', org: 'p:pella' }).catch((e) => e);
  assert.ok(!plain.followed, 'a record that wasn’t moved names no one');
});
