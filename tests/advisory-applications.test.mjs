/**
 * The Advisory Board application (/advisory-board/apply/): the form's rules
 * (functions/api/_advisory-form.js), the public endpoint, the emails, the
 * admin's actions, and the Jotform applications brought in once
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { checkAnswers, ADVISORY_FIELDS, ADVISORY_STEPS, normalizeLink, answerSections } from '../functions/api/_advisory-form.js';
import { applicantEmail, staffEmail, staffSlack, fromJotform, importJotformApplications, listAdvisoryApplications, getAdvisorySettings } from '../functions/api/_advisory-applications.js';
import * as publicApi from '../functions/api/advisory-apply.js';
import * as adminApi from '../functions/api/advisory-applications-admin.js';

/** A complete, made-up application */
export const GOOD = {
  fullName: 'Jordan Avery', preferredName: 'Jo', email: 'Jordan@Example.org', phone: '(770) 555-0142', address: '12 Maple Dr\nMarietta, GA 30062',
  company: 'Peachtree Builders', jobTitle: 'Director of Partnerships', link: 'linkedin.com/in/jordan-avery',
  heardFrom: 'A friend on the board', why: 'I have watched what a room can do for a child.', connection: 'My nephew uses a wheelchair.',
  involved: 'Yes', involvedHow: 'Volunteered at the 2025 gala.',
  strengths: 'Corporate partnerships and event planning.', fundraising: 'An employer match and a team golf foursome.',
  introductions: 'Yes', networks: 'Maybe', networksMore: 'Our local builders association.', conflict: 'No',
  hostEvent: 'Maybe', meetings: 'Yes', ambassador: 'Yes', meetingTimes: 'Weekday evenings',
  hopeToGain: 'Purpose and friendships.', anythingElse: '',
  refName: 'Sam Lee', refRelationship: 'Former manager', refEmail: 'sam@example.org', refPhone: '',
  acknowledge: true, signature: 'Jordan Avery',
};

let env;
let sent;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  env = { DB: await createD1(), RESEND_API_KEY: 'resend', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/T0/B0/x' };
  sent = { emails: [], slack: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host === 'api.resend.com') { const batch = JSON.parse(init.body); sent.emails.push(...batch); return Response.json({ data: batch.map((_, i) => ({ id: `em${i}` })) }); }
    if (url.host === 'hooks.slack.test') { sent.slack.push(JSON.parse(init.body)); return new Response('ok'); }
    if (url.host === 'challenges.cloudflare.com') return Response.json({ success: true });
    throw new Error(`no route for ${url.href}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const ctx = (method, body, { ip = '203.0.113.7', url = 'https://site.test/api/advisory-apply' } = {}) => {
  const waits = [];
  return {
    env,
    request: new Request(url, { method, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip }, body: body ? JSON.stringify(body) : undefined }),
    waitUntil: (p) => waits.push(p),
    data: { userEmail: 'linzi@soardcharity.com' },
    waits,
  };
};
const apply = async (answers, extra = {}, opts = {}) => {
  const c = ctx('POST', { answers, website: '', startedAt: Date.now() - 10 * 60 * 1000, ...extra }, opts);
  const res = await publicApi.onRequestPost(c);
  await Promise.all(c.waits);
  return { res, body: await res.json() };
};
const admin = async (method, body, query = '') => {
  const res = method === 'GET' ? await adminApi.onRequestGet(ctx('GET', null, { url: `https://site.test/api/advisory-applications-admin${query}` })) : await adminApi.onRequestPost(ctx('POST', body, { url: 'https://site.test/api/advisory-applications-admin' }));
  return res.json();
};

test('the rules: what has to be answered, follow-ups only when they apply, and clean values', () => {
  const ok = checkAnswers(GOOD);
  assert.deepEqual(ok.problems, {});
  assert.equal(ok.answers.email, 'jordan@example.org', 'emails are kept in lower case');
  assert.equal(ok.answers.link, 'https://linkedin.com/in/jordan-avery', 'a link without https:// works');
  assert.equal(ok.answers.anythingElse, undefined, 'empty answers are left out');

  const bad = checkAnswers({ ...GOOD, email: 'jordan@', phone: '123', meetings: 'Sometimes', acknowledge: false, conflict: 'Yes', conflictMore: '', why: '   ', link: 'not a link', surprise: 'x' });
  assert.deepEqual(Object.keys(bad.problems).sort(), ['acknowledge', 'conflictMore', 'email', 'link', 'meetings', 'phone', 'why']);
  assert.equal(bad.problems.conflictMore, 'Please fill this in.', 'a Yes on conflicts asks for the reason');
  assert.equal(bad.answers.surprise, undefined, 'unknown fields are dropped');

  // The phone: ten digits, as the family application asks (a work extension and a + number from abroad are fine)
  for (const [phone, ok2] of [['404555012', false], ['404-555-01', false], ['(770) 555-0142', true], ['1 770 555 0142', true], ['404.555.0188 x12', true], ['404 555 0188 ext. 7', true], ['+44 20 7946 0958', true]]) {
    assert.equal(!checkAnswers({ ...GOOD, phone }).problems.phone, ok2, phone);
  }
  const no = checkAnswers({ ...GOOD, involved: 'No', involvedHow: 'left over from a Yes' });
  assert.equal(no.answers.involvedHow, undefined, 'a follow-up that no longer applies isn’t kept');
  const one = checkAnswers({ fullName: 'A B' }, { step: 'you' });
  assert.deepEqual(Object.keys(one.problems).sort(), ['email', 'phone'], 'one step at a time');
  assert.equal(normalizeLink('www.example.org'), 'https://www.example.org');
  assert.equal(ADVISORY_STEPS.length, 5);
  assert.ok(ADVISORY_FIELDS.every((f) => !/[—–]/.test(`${f.label} ${f.hint || ''}`)), 'no em or en dashes in the questions');
});

test('applying: stored, the applicant gets a copy, staff get an email and a Slack post', async () => {
  const { res, body } = await apply(GOOD);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, first: 'Jo' }, 'thanks by their preferred name');
  const [app] = await listAdvisoryApplications(env.DB);
  assert.equal(app.name, 'Jordan Avery');
  assert.equal(app.status, 'new');
  assert.equal(app.company, 'Peachtree Builders');

  const copy = sent.emails.find((e) => e.to[0] === 'jordan@example.org');
  assert.equal(copy.subject, 'We have your Advisory Board application');
  assert.match(copy.html, /Thank you, Jo/);
  assert.match(copy.html, /Corporate partnerships and event planning/, 'their answers, as a copy');
  const staff = sent.emails.find((e) => e.to[0] === 'info@soardcharity.com');
  assert.equal(staff.subject, 'New Advisory Board application: Jordan Avery');
  assert.match(staff.html, /#advisory-applications\/adv-/, 'links straight to the application in the admin');
  assert.equal(sent.slack.length, 1);
  const slack = JSON.stringify(sent.slack[0]);
  assert.match(slack, /Advisory Board application: Jordan Avery/);
  assert.equal(/jordan@example\.org|770/.test(slack), false, 'no contact details in Slack');
  for (const e of sent.emails) assert.equal(/—/.test(e.text), false, 'no em dashes in the emails');

  // A double tap is the same application
  await apply(GOOD);
  assert.equal((await listAdvisoryApplications(env.DB)).length, 1);
  assert.equal(sent.emails.length, 2, 'and nobody is emailed twice');
});

test('answers that need a look come back by field; bots are answered and dropped', async () => {
  const { res, body } = await apply({ ...GOOD, email: 'nope', meetings: '' });
  assert.equal(res.status, 422);
  assert.deepEqual(Object.keys(body.problems).sort(), ['email', 'meetings']);
  assert.equal((await apply(GOOD, { website: 'spam.example' })).body.ok, true, 'the honeypot looks like a success');
  assert.equal((await apply(GOOD, { startedAt: Date.now() - 3000 })).body.ok, true, 'so does a five-step form filled in three seconds');
  assert.equal((await listAdvisoryApplications(env.DB)).length, 0, 'none of them stored');
  assert.equal(sent.emails.length, 0);
});

test('Turnstile, once it’s set up, and a daily limit per address', async () => {
  env.TURNSTILE_SECRET_KEY = 'secret';
  const get = await (await publicApi.onRequestGet({ env })).json();
  assert.match(get.turnstileSiteKey, /^0x/);
  const noToken = await apply(GOOD);
  assert.equal(noToken.res.status, 400);
  assert.equal(noToken.body.code, 'turnstile');
  delete env.TURNSTILE_SECRET_KEY;
  assert.equal((await (await publicApi.onRequestGet({ env })).json()).turnstileSiteKey, null, 'no key: the page shows no widget');
  for (let i = 0; i < 5; i++) assert.equal((await apply({ ...GOOD, why: `Reason ${i}` }, {}, { ip: '198.51.100.9' })).res.status, 200);
  const sixth = await apply({ ...GOOD, why: 'Reason 6' }, {}, { ip: '198.51.100.9' });
  assert.equal(sixth.res.status, 429);
  assert.match(sixth.body.error, /info@soardcharity\.com/);
});

test('the admin: read it, move it along, notes, Joined when they’re on People, who hears, delete', async () => {
  await apply(GOOD);
  const list = await admin('GET');
  assert.equal(list.applications.length, 1);
  assert.deepEqual(list.statuses.map((s) => s.id), ['new', 'talking', 'joined', 'not-now']);
  assert.equal((await admin('GET', null, '?count=1')).new, 1);
  const id = list.applications[0].id;
  const one = (await admin('GET', null, `?id=${id}`)).application;
  assert.deepEqual(one.sections.map((s) => s.id), ['you', 'interest', 'bring', 'commitment', 'reference']);
  assert.equal(one.sections.flatMap((s) => s.items).some((i) => i.id === 'acknowledge'), false, 'the checkbox isn’t shown as an answer');

  assert.equal((await admin('POST', { status: { id, status: 'talking' } })).application.status, 'talking');
  assert.equal((await admin('POST', { status: { id, status: 'maybe' } })).success, false);
  const noted = (await admin('POST', { note: { id, text: 'Called Monday, coffee next week.' } })).application;
  assert.equal(noted.notes[0].by, 'linzi@soardcharity.com');
  const joined = (await admin('POST', { person: { id, slug: 'jordan-avery' } })).application;
  assert.equal(joined.status, 'joined');
  assert.equal(joined.personSlug, 'jordan-avery');
  assert.equal((await admin('GET', null, '?count=1')).new, 0);

  assert.equal((await admin('POST', { settings: { staffEmails: 'peter@example.org\nnot-an-email' } })).problems.staffEmails, 'not-an-email isn’t an email address.');
  assert.deepEqual((await admin('POST', { settings: { staffEmails: 'Peter@Example.org, linzi@example.org' } })).settings.staffEmails, ['peter@example.org', 'linzi@example.org']);
  sent.emails.length = 0;
  await apply({ ...GOOD, why: 'A second applicant', fullName: 'Casey Reed', email: 'casey@example.org', signature: 'Casey Reed' });
  assert.deepEqual(sent.emails.filter((e) => /New Advisory/.test(e.subject)).map((e) => e.to[0]).sort(), ['linzi@example.org', 'peter@example.org']);

  assert.equal((await admin('POST', { remove: { id } })).removed, id);
  assert.equal((await admin('GET', null, `?id=${id}`)).success, false);
  assert.equal((await admin('POST', { remove: { id: '../x' } })).success, false, 'ids are checked');
});

test('the Jotform applications come in once; anyone already on People → Advisory is Joined', async () => {
  await env.DB.exec('CREATE TABLE jotform_backfill (submission_id TEXT PRIMARY KEY, form_id TEXT, kind TEXT, name TEXT, submitted_at TEXT, answers TEXT)');
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, data TEXT)');
  await env.DB.prepare('INSERT INTO team (slug, data) VALUES (?, ?)').bind('casey-reed', JSON.stringify({ name: 'Casey Reed', group: 'advisory' })).run();
  const sub = (first, last, extra = {}) => JSON.stringify({ formId: '261805783731058', createdAt: '2026-07-08 14:20:00', answers: {
    3: { type: 'control_fullname', text: 'Full Name', answer: { first, last } },
    5: { type: 'control_email', text: 'Email Address', answer: `${first.toLowerCase()}@example.org` },
    6: { type: 'control_phone', text: 'Phone Number', answer: { full: '(404) 555-0100' } },
    7: { type: 'control_address', text: 'Home Address', answer: { addr_line1: '1 Elm St', city: 'Roswell', state: 'GA', postal: '30075' } },
    9: { type: 'control_textbox', text: 'Employer / Company', answer: 'Acme' },
    14: { type: 'control_radio', text: 'Are you able to commit to attending at least four meetings per year?', answer: 'yes' },
    20: { type: 'control_checkbox', text: 'I have read and understand the Advisory Board expectations', answer: ['I agree'] },
    21: { type: 'control_signature', text: 'Applicant Signature', answer: 'https://www.jotform.com/uploads/sig.png' },
    22: { type: 'control_textarea', text: 'A question added later', answer: 'Something new' },
    1: { type: 'control_head', text: 'Applicant Information' },
    ...extra,
  } });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO jotform_backfill VALUES ('6261000000000000001', '261805783731058', 'advisory', 'Casey Reed', '2026-07-08 14:20:00', ?)").bind(sub('Casey', 'Reed')),
    env.DB.prepare("INSERT INTO jotform_backfill VALUES ('6261000000000000002', '261805783731058', 'advisory', 'Riley Stone', '2026-07-09 09:00:00', ?)").bind(sub('Riley', 'Stone')),
    env.DB.prepare("INSERT INTO jotform_backfill VALUES ('6380000000000000003', '252326779451161', 'makeover', 'A Child', null, '{}')"),
  ]);
  const first = await admin('GET');
  assert.equal(first.imported, 2, 'the makeover form’s aren’t advisory applications');
  const byName = Object.fromEntries(first.applications.map((a) => [a.name, a]));
  assert.equal(byName['Casey Reed'].status, 'joined');
  assert.equal(byName['Casey Reed'].personSlug, 'casey-reed');
  assert.equal(byName['Riley Stone'].status, 'new');
  assert.equal(byName['Riley Stone'].source, 'jotform');
  assert.equal(byName['Riley Stone'].createdAt, '2026-07-08T14:20:00.000Z', 'dated when they applied');
  const riley = (await admin('GET', null, `?id=${byName['Riley Stone'].id}`)).application;
  assert.equal(riley.answers.phone, '(404) 555-0100');
  assert.equal(riley.answers.address, '1 Elm St\nRoswell, GA\n30075');
  assert.equal(riley.answers.meetings, 'Yes', 'a choice reads like the site’s');
  assert.equal(riley.answers.acknowledge, true);
  assert.match(riley.answers.anythingElse, /A question added later\nSomething new/, 'a question this form doesn’t ask is kept');
  assert.equal((await admin('GET')).imported, 0, 'once');
  assert.equal(sent.emails.length + sent.slack.length, 0, 'bringing them in emails nobody');
});

test('a fixable answer never spends the Turnstile check; a TEST application reaches only the tester', async () => {
  env.TURNSTILE_SECRET_KEY = 'secret';
  let verifies = 0;
  const base = globalThis.fetch;
  globalThis.fetch = async (input, init) => { if (String(input).includes('challenges.cloudflare.com')) verifies++; return base(input, init); };
  const typo = await apply({ ...GOOD, email: 'jordan@' }, { turnstileToken: 'tok' });
  assert.equal(typo.res.status, 422);
  assert.equal(verifies, 0, 'answers are checked first, so the token is still good for the fixed send');
  const good = await apply({ ...GOOD, fullName: 'TEST Advisory Check', email: 'tester@example.org', signature: 'TEST Advisory Check' }, { turnstileToken: 'tok' });
  assert.equal(good.res.status, 200);
  assert.equal(verifies, 1);
  delete env.TURNSTILE_SECRET_KEY;
  assert.deepEqual(sent.emails.map((e) => e.to[0]).sort(), ['tester@example.org', 'tester@example.org'], 'the copy and the staff email both go to the tester, never the staff list');
  assert.match(sent.emails.find((e) => /New Advisory/.test(e.subject)).subject, /^\[TEST\] /);
  assert.match(JSON.stringify(sent.slack[0]), /Test application · not a real applicant/, 'Slack marks it 🧪');
  const list = await admin('GET');
  assert.equal(list.applications[0].isTest, true, 'the admin tags it');
  assert.equal((await admin('GET', null, '?count=1')).new, 0, 'and it never counts as New');
});

test('who hears: the saved emails, and whoever People → Board puts on the committee, read when each email goes', async () => {
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, data TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  const board = (slug, name, extra) => env.DB.prepare('INSERT OR REPLACE INTO team (slug, data) VALUES (?, ?)').bind(slug, JSON.stringify({ name, group: 'board', ...extra })).run();
  await board('pat-chair', 'Pat Chair', { committees: ['Finance'] });
  await env.DB.prepare("INSERT INTO reveal_board_emails VALUES ('pat-chair', 'pat@example.org', null), ('lee-lead', 'lee@example.org', null)").run();

  let st = (await admin('GET')).settings;
  assert.equal(st.committee, 'Advisory Board', 'the Advisory Board committee unless someone picks another');
  assert.deepEqual(st.committeeMembers, [], 'nobody is on it yet');
  assert.ok(st.committees.includes('Advisory Board') && st.committees.includes('Finance'), 'the pick lists the board’s committees');

  const saved = await admin('POST', { settings: { staffEmails: 'holly@example.org\nlinzi@example.org', committee: 'Advisory Board' } });
  assert.deepEqual(saved.settings.staffEmails, ['holly@example.org', 'linzi@example.org']);
  // Someone takes the committee on in People → Board: no change here
  await board('lee-lead', 'Lee Lead', { committees: ['Advisory Board', 'Gala'] });
  await board('old-hand', 'Old Hand', { committees: ['advisory board'], status: 'alumni' });
  await board('new-face', 'New Face', { committees: ['Advisory Board'] });
  st = (await admin('GET')).settings;
  assert.deepEqual(st.committeeMembers, [{ name: 'Lee Lead', hasEmail: true }, { name: 'New Face', hasEmail: false }], 'active members only, and who has no email yet');
  await apply(GOOD);
  assert.deepEqual(sent.emails.filter((e) => /^New Advisory/.test(e.subject)).map((e) => e.to[0]).sort(), ['holly@example.org', 'lee@example.org', 'linzi@example.org']);

  assert.equal((await admin('POST', { settings: { staffEmails: '', committee: '' } })).problems.staffEmails, 'Add at least one email or pick a committee, or nobody hears about new applications.');
  assert.deepEqual((await admin('POST', { settings: { staffEmails: '', committee: 'Advisory Board' } })).settings.staffEmails, [], 'the committee alone is enough');
});

test('the emails read well without the site: plain text and the staff list default', async () => {
  const app = { id: 'adv-test-0001', answers: checkAnswers(GOOD).answers };
  const mine = applicantEmail(app);
  assert.match(mine.text, /^Thank you, Jo\./);
  assert.match(mine.text, /YOUR INTEREST/);
  const staff = staffEmail(app);
  assert.match(staff.text, /Read the application: https:\/\/sunshineonaranneyday\.com\/admin\/#advisory-applications\/adv-test-0001/);
  assert.ok(staffSlack(app).blocks.length >= 3);
  assert.deepEqual((await getAdvisorySettings(env.DB)).staffEmails, ['info@soardcharity.com']);
  assert.deepEqual(answerSections({}), []);
  assert.deepEqual(fromJotform({}), {});
});
