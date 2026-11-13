/**
 * Kit Signals on a donor's page (functions/api/_donor-signals.js): only the facts the page shows, never for the team or
 * an organization, and why there's nothing when Kit has nothing. Names, addresses and values are made up.
 * Run: node --test tests/donor-signals.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import * as D from '../functions/api/_donors.js';
import { signalsOf, signalsFor, planWords, SHOWN } from '../functions/api/_donor-signals.js';

const NOW = Date.now();
const DAY = 864e5;
let env;
let kit;
let asked;
const realFetch = globalThis.fetch;

test('only the facts the page shows: work, LinkedIn, social reach and profiles, income, home; never age, gender, children', () => {
  const s = signalsOf({
    job_title: 'Chief Financial Officer', household_income: '$250K+', home_ownership: 'Homeowner', social_reach: '12,400',
    linkedin_username: 'jane-sample', linkedin_connections: 500, linkedin_bio: 'Finance leader in Atlanta', instagram_username: '@jane.sample', instagram_followers: 1200,
    twitter_username: 'bad user/../x', age: '45-54', gender: 'Female', marital_status: 'Married', presence_of_children: 'Yes', education_level: 'Graduate',
  });
  assert.equal(s.jobTitle, 'Chief Financial Officer');
  assert.equal(s.income, '$250K+');
  assert.equal(s.homeOwnership, 'Homeowner');
  assert.equal(s.socialReach, 12400);
  assert.deepEqual(s.social.map((x) => [x.label, x.url, x.count, x.countWord]), [
    ['LinkedIn', 'https://www.linkedin.com/in/jane-sample', 500, 'connections'],
    ['Instagram', 'https://www.instagram.com/jane.sample', 1200, 'followers'],
  ], 'a handle that isn’t a handle is never made a link');
  assert.ok(!JSON.stringify(s).match(/45-54|Female|Married|Graduate/), 'Kit’s other household facts never reach the page');
  for (const k of ['age', 'gender', 'marital_status', 'presence_of_children', 'education_level', 'household_size']) assert.ok(!SHOWN.includes(k));
  assert.deepEqual(signalsOf({ linkedin_followers: 900 }).social.map((x) => [x.count, x.countWord]), [[900, 'followers']], 'LinkedIn followers when Kit has no connections');
  assert.equal(signalsOf({ age: '35-44' }), null, 'nothing the page shows: nothing');
  assert.equal(signalsOf(null), null);
  assert.equal(planWords('creator_pro'), 'Creator Pro');
});

beforeEach(async () => {
  env = { DB: await createD1({ schemaSql: [
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, data TEXT)',
    'CREATE TABLE partners (slug TEXT PRIMARY KEY, data TEXT)',
    'CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
    'CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)',
  ] }), KIT_API_KEY: 'kit' };
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ ok: true, accounts: [{ email: 'robin@soardcharity.com', aliases: [], name: 'Robin Sample', active: true }] })).run();
  await env.DB.prepare('INSERT INTO partners VALUES (?, ?)').bind('acme', JSON.stringify({ name: 'Acme Builders', level: 'friend', category: ['funding'] })).run();
  const pay = (id, contact, email, first, last, company = null) => ({ id, object: 'payment', created: Math.floor((NOW - DAY) / 1000), amount: 50000, status: 'succeeded', type: 'online', refund_status: 'none', refunds: [], description: 'Gala', contact,
    payment_method: { type: 'card' }, buyer: { email, first_name: first, last_name: last, is_corporate: !!company, company_name: company }, campaign_category: 'donation', items: [{ type: 'donation', amount: 50000 }], buyer_questions: [], recurring: null, metadata: {} });
  for (const p of [pay('p1', 'ct_jane', 'jane@example.com', 'Jane', 'Doe'), pay('p2', 'ct_robin', 'robin.home@example.net', 'Robin', 'Sample'), pay('p3', 'ct_lee', 'lee@acme.example', 'Lee', 'Sample', 'Acme Builders')]) await D.noteDonorPayment(env, p, { now: NOW, thanks: false });
  kit = { fields: { job_title: 'Teacher', household_income: '$100K-$150K' }, plan: 'creator_pro', status: 200, inKit: true };
  asked = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    asked.push(`${u.pathname}${u.search}`);
    if (u.hostname !== 'api.kit.com') throw new Error(`unexpected ${u}`);
    if (u.pathname === '/v4/subscribers') return Response.json({ subscribers: kit.inKit ? u.searchParams.get('email_address').split(',').map((e, i) => ({ id: 70 + i, email_address: e, state: 'active' })) : [] });
    if (/^\/v4\/subscribers\/\d+$/.test(u.pathname)) return kit.status === 200 ? Response.json({ subscriber: { id: 70, kit_fields: kit.fields } }) : Response.json({ errors: ['no'] }, { status: kit.status });
    if (u.pathname === '/v4/account') return Response.json({ account: { plan: { plan_type: kit.plan } } });
    throw new Error(`unexpected ${u}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test('a donor Kit has Signals for: what the page shows, asked with kit_fields', async () => {
  const v = await signalsFor(env, 'ct_jane', { now: NOW });
  assert.equal(v.state, 'ok');
  assert.equal(v.signals.jobTitle, 'Teacher');
  assert.ok(asked.some((a) => /\/v4\/subscribers\/70\?include=kit_fields$/.test(a)));
});

test('nothing from Kit says why: SOARD’s plan hasn’t Signals, Kit found nothing, or they aren’t in Kit', async () => {
  kit.fields = {};
  kit.plan = 'creator';
  const a = await signalsFor(env, 'ct_jane', { now: NOW + 2 * 3600e3 });
  assert.equal(a.state, 'plan');
  assert.match(a.note, /Creator Pro plan\. SOARD’s Kit is on Creator\./);
  kit.plan = 'creator_pro';
  const b = await signalsFor(env, 'ct_jane', { now: NOW + 4 * 3600e3 });
  assert.equal(b.state, 'none');
  assert.match(b.note, /found nothing/);
  kit.status = 422;
  const c = await signalsFor(env, 'ct_jane', { now: NOW + 6 * 3600e3 });
  assert.match(c.note, /didn’t give/);
  kit.inKit = false;
  assert.match((await signalsFor(env, 'ct_jane', { now: NOW })).note, /aren’t in Kit/);
});

test('never for the team (a staff member who gives), an organization, or with Kit not connected', async () => {
  assert.equal((await signalsFor(env, 'ct_robin', { now: NOW })).state, 'skipped');
  assert.equal((await signalsFor(env, 'p:acme', { now: NOW })).state, 'skipped');
  assert.ok(!asked.length, 'Kit isn’t asked about them');
  assert.equal((await signalsFor({ ...env, KIT_API_KEY: '' }, 'ct_jane', { now: NOW })).state, 'off');
  await assert.rejects(signalsFor(env, 'ct_nobody', { now: NOW }), (e) => e.status === 404);
});
