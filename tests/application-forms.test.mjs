/**
 * The editable application form: definition rules (functions/api/_application-form.js),
 * versions in D1 (functions/api/_application-forms.js), and how applications,
 * messages and the public endpoint follow the live version.
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from './lib/fake-applicant-world.mjs';
import {
  DEFAULT_DEFINITION, LOCKED_FIELDS, resolveForm, normalizeDefinition, validateDefinition, sanitizeHtml,
  answerText, allFields, renderMessage,
} from '../functions/api/_application-form.js';
import {
  getLiveForm, saveDraftForm, putDraftLive, discardDraftForm, restoreFormVersion, listFormVersions, formFor, clearFormCache, getDraftForm,
  saveFormRules, getFormRules, diffForm,
} from '../functions/api/_application-forms.js';
import {
  createDraft, getDraft, saveDraft, setDraftFile, submitDraft, processApplication, getApplication, photoKey, TEST_JPEG, testAnswers, accountFields, JT_FIELDS,
} from '../functions/api/_applications.js';
import { handleWorkflowCall, runNotifications } from '../functions/api/_applicant-notify.js';
import * as applyApi from '../functions/api/apply.js';
import * as adminApi from '../functions/api/applications-admin.js';
import * as applicantsApi from '../functions/api/applicants-admin.js';

const YEAR = '2027';
const clone = (o) => JSON.parse(JSON.stringify(o));
const field = (def, id) => def.pages.flatMap(p => p.fields).find(f => f.id === id);
const problems = (def) => validateDefinition(normalizeDefinition(def)).map(e => e.message).join(' | ');

let w;
let env;
beforeEach(async () => {
  w = fakeApplicantWorld();
  env = { ...w.env, DB: await createD1() };
  globalThis.fetch = w.fetchImpl;
  clearFormCache();
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`);
  await env.DB.prepare("INSERT OR REPLACE INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ application: { open: true, year: YEAR } })).run();
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)`);
});

// ── Rules ───────────────────────────────────────────────────────────

test('the built-in form is valid, and {year} fills in everywhere', () => {
  assert.deepEqual(validateDefinition(normalizeDefinition(DEFAULT_DEFINITION)), []);
  const form = resolveForm(DEFAULT_DEFINITION, { year: '2028' });
  assert.equal(form.title, 'Sunshine on a Ranney Day 2028 Application');
  assert.match(field(form, 'ackSeason').label, /2028 makeover season.*spring of 2028/);
  assert.equal(JSON.stringify(form).includes('{year}'), false);
  // Choices become values plus labels and descriptions
  const mt = field(form, 'makeoverTypes');
  assert.deepEqual(mt.options, ['Accessible Bathroom', 'Dream Bedroom', 'In-Home Therapy Room', 'Ramp']);
  assert.match(mt.descriptions['Accessible Bathroom'], /zero-entry shower/);
});

test('questions that feed JobTread can be reworded but not removed or broken', () => {
  const ok = clone(DEFAULT_DEFINITION);
  field(ok, 'birthdate').label = 'When was your child born?';
  field(ok, 'gender').options = [{ value: 'Male', label: 'Boy' }, { value: 'Female', label: 'Girl' }];
  assert.equal(problems(ok), '');

  const gone = clone(DEFAULT_DEFINITION);
  gone.pages[2].fields = gone.pages[2].fields.filter(f => f.id !== 'birthdate');
  assert.match(problems(gone), /"birthdate" feeds JobTread Birthday; it can be reworded or moved, not removed/);

  const retyped = clone(DEFAULT_DEFINITION);
  field(retyped, 'parentEmail').type = 'text';
  assert.match(problems(retyped), /must stay a Email question/);

  const optional = clone(DEFAULT_DEFINITION);
  delete field(optional, 'childName').required;
  assert.match(problems(optional), /must stay required/);

  const newLanguage = clone(DEFAULT_DEFINITION);
  field(newLanguage, 'language').options.push('Klingon');
  assert.match(problems(newLanguage), /JobTread only knows these choices/);

  const fewerGenders = clone(DEFAULT_DEFINITION);
  field(fewerGenders, 'gender').options = ['Male'];
  assert.match(problems(fewerGenders), /Keep all of these choices: Male, Female/);

  // A language can be dropped (JobTread just never gets it)
  const fewerLanguages = clone(DEFAULT_DEFINITION);
  field(fewerLanguages, 'language').options = ['English', 'Spanish'];
  assert.equal(problems(fewerLanguages), '');
});

test('rules for show-when, stop screens, ids and messages', () => {
  const later = clone(DEFAULT_DEFINITION);
  field(later, 'boundaryWhere').showIf = { field: 'ownership', in: ['No, the property is rented.'] };
  assert.match(problems(later), /must point to a question earlier/);

  const missingStop = clone(DEFAULT_DEFINITION);
  field(missingStop, 'ownership').stops = { 'No, the property is rented.': 'nope' };
  assert.match(problems(missingStop), /The stop screen "nope" doesn't exist/);

  const dupe = clone(DEFAULT_DEFINITION);
  dupe.pages[0].fields.push({ id: 'county', type: 'text', label: 'Again' });
  assert.match(problems(dupe), /Two questions have the same id/);

  const msg = clone(DEFAULT_DEFINITION);
  msg.messages = { ...msg.messages, approved: 'Congratulations!' };
  assert.match(problems(msg), /should name the child with \{child\}/);

  const email = clone(DEFAULT_DEFINITION);
  email.staffEmails = ['selection@soardcharity.com', 'not an email'];
  assert.match(problems(email), /"not an email" isn't an email address/);
});

test('text blocks keep simple formatting and lose anything that could run', () => {
  const out = sanitizeHtml('<p class="x" onclick="steal()">Hi <strong>there</strong><script>alert(1)</script></p><a href="javascript:alert(1)">bad</a> <a href="https://soard.org" target="_blank">good</a><img src=x onerror=alert(1)><iframe src="//evil"></iframe> 1 < 2');
  assert.equal(out, '<p>Hi <strong>there</strong></p><a>bad</a> <a href="https://soard.org">good</a> 1 &lt; 2');
  const def = clone(DEFAULT_DEFINITION);
  field(def, 'introText').html = '<p>Hello</p><script>x()</script>';
  assert.equal(field(normalizeDefinition(def), 'introText').html, '<p>Hello</p>');
});

// ── Versions ────────────────────────────────────────────────────────

test('draft → live → history → restore', async () => {
  const live0 = await getLiveForm(env.DB);
  assert.equal(live0.version, 0, 'built in until something is put live');

  const edited = clone(DEFAULT_DEFINITION);
  field(edited, 'interests').label = 'What does your child love?';
  const saved = await saveDraftForm(env.DB, edited, { user: 'peter@soardcharity.com' });
  assert.deepEqual(saved.errors, []);
  assert.equal((await getLiveForm(env.DB, { fresh: true })).version, 0, 'a draft changes nothing for families');

  const put = await putDraftLive(env.DB, { user: 'peter@soardcharity.com' });
  assert.equal(put.ok, true);
  const v1 = put.version;
  assert.equal(field(await formFor(env.DB, { year: YEAR }), 'interests').label, 'What does your child love?');
  assert.equal(await getDraftForm(env.DB), null, 'the draft became the live version');

  const second = clone(edited);
  field(second, 'interests').label = 'Tell us what your child loves.';
  await saveDraftForm(env.DB, second);
  const v2 = (await putDraftLive(env.DB)).version;
  const states = Object.fromEntries((await listFormVersions(env.DB)).map(v => [v.version, v.state]));
  assert.deepEqual(states, { [v1]: 'old', [v2]: 'live' });

  await restoreFormVersion(env.DB, v1);
  assert.equal(field((await getDraftForm(env.DB)).definition, 'interests').label, 'What does your child love?');
  await discardDraftForm(env.DB);
  assert.equal(await getDraftForm(env.DB), null);
  assert.equal(field(await formFor(env.DB, { year: YEAR }), 'interests').label, 'Tell us what your child loves.');
});

test('a draft with problems saves (nothing typed is lost) but cannot go live', async () => {
  const bad = clone(DEFAULT_DEFINITION);
  bad.pages[2].fields = bad.pages[2].fields.filter(f => f.id !== 'gender');
  const saved = await saveDraftForm(env.DB, bad);
  assert.ok(saved.errors.length);
  const put = await putDraftLive(env.DB);
  assert.equal(put.ok, false);
  assert.match(put.errors.map(e => e.message).join(), /"gender"/);
  assert.equal((await getLiveForm(env.DB, { fresh: true })).version, 0);
});

// ── Applications follow the version they were answered on ──────────

async function readyDraft(answers) {
  const id = await createDraft(env.DB, { year: YEAR, ipHash: 'ip', verified: true });
  await saveDraft(env.DB, await getDraft(env.DB, id), { answers, page: 'finish' });
  for (const f of ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2']) {
    await env.FILES.put(photoKey(id, f), TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await setDraftFile(env.DB, id, f, { key: photoKey(id, f), type: 'image/jpeg', size: TEST_JPEG.byteLength, name: `${f}.jpg` });
  }
  w.world.videos.vid1 = { uid: 'vid1', readyToStream: true, status: { state: 'ready' }, duration: 80 };
  w.advanceVideo('vid1', 'mp4');
  await setDraftFile(env.DB, id, 'video', { uid: 'vid1', uploaded: true, size: 1000, name: 'clip.mov' });
  return getDraft(env.DB, id);
}

test('an application keeps the wording it was answered on; relabeled choices still reach JobTread', async () => {
  const v = clone(DEFAULT_DEFINITION);
  field(v, 'gender').options = [{ value: 'Male', label: 'Boy' }, { value: 'Female', label: 'Girl' }];
  field(v, 'interests').label = 'What does your child love?';
  v.staffEmails = ['intake@soardcharity.com'];
  await saveDraftForm(env.DB, v);
  const version = (await putDraftLive(env.DB)).version;

  const answers = { ...testAnswers('mom@example.com', YEAR), childName: { first: 'Avery', last: 'Stone' } };
  const sub = await submitDraft(env, await readyDraft(answers));
  assert.equal(sub.ok, true);
  assert.equal((await getApplication(env.DB, sub.id)).form_version, version);
  assert.equal((await processApplication(env, sub.id, { fetchImpl: w.fetchImpl })).status, 'done');
  const [acct] = Object.values(w.world.accounts);
  assert.equal(acct.fields[JT_FIELDS.gender], 'Female', 'JobTread gets the value, not the new wording');
  assert.deepEqual(w.world.emails.map(e => e.to[0]), ['intake@soardcharity.com'], 'staff email list comes from the form');

  // The form changes again; the application still reads as answered
  const later = clone(v);
  field(later, 'interests').label = 'Something else entirely';
  await saveDraftForm(env.DB, later);
  await putDraftLive(env.DB);
  const res = await adminApi.onRequestGet({ env, request: new Request(`https://x/api/applications-admin?id=${sub.id}`), data: {} });
  const detail = (await res.json()).application;
  assert.equal(detail.formVersion, version);
  const items = detail.sections.flatMap(s => s.items);
  assert.ok(items.some(i => i.label === 'What does your child love?'));
  assert.equal(items.find(i => i.id === 'gender').text, 'Girl');
  const form = resolveForm(v, { year: YEAR });
  assert.equal(answerText(allFields(form).find(f => f.id === 'gender'), 'Female'), 'Girl');
});

test('family messages follow the live form', async () => {
  const v = clone(DEFAULT_DEFINITION);
  v.messages = { ...v.messages, inReview: 'Hi {parent}! Good news for *{child}*: next is the home visit.' };
  await saveDraftForm(env.DB, v);
  await putDraftLive(env.DB);
  const id = 'acctNEW000001';
  w.world.accounts[id] = {
    id, name: 'Riley Park', type: 'customer', org: ORG, createdAt: new Date().toISOString(),
    fields: { [JT_FIELDS.status]: 'In Review' }, contacts: [{ id: 'c1', name: 'Morgan Park', fields: { '22NJw43QvHeJ': 'morgan@example.com' } }],
    primaryContactId: 'c1', locations: [], files: [], comments: [],
  };
  const T0 = Date.parse('2026-10-21T15:00:00Z');
  await handleWorkflowCall(env, { accountId: id, previousStatus: 'Applied', nextStatus: 'In Review' }, { fetchImpl: w.fetchImpl, now: T0 });
  for (const t of [T0 + 4 * 60000, T0 + 11 * 60000]) await runNotifications(env, { fetchImpl: w.fetchImpl, now: t });
  assert.equal(w.world.accounts[id].comments.at(-1).message, 'Hi Morgan Park! Good news for *Riley Park*: next is the home visit.');
  assert.equal(renderMessage('{parent} {child}{copyNote}', { parent: 'A', child: 'B', copyNote: 'Copy.' }), 'A B\n\nCopy.');
});

// ── The public endpoint ─────────────────────────────────────────────

test('the page config carries the live form and nothing internal; drafts are for signed-in staff only', async () => {
  const v = clone(DEFAULT_DEFINITION);
  field(v, 'interests').label = 'Live wording';
  await saveDraftForm(env.DB, v);
  await putDraftLive(env.DB);
  const draft = clone(v);
  field(draft, 'interests').label = 'Draft wording';
  await saveDraftForm(env.DB, draft);

  const get = async (q) => (await applyApi.onRequestGet({ env, request: new Request(`https://x/api/apply${q}`) })).json();
  const cfg = await get('?config');
  assert.equal(field(cfg.form, 'interests').label, 'Live wording');
  assert.equal(cfg.form.messages, undefined);
  assert.equal(cfg.form.staffEmails, undefined);
  assert.equal(JSON.stringify(cfg).includes('selection@soardcharity.com'), false);
  const preview = await get('?config&preview=draft');
  assert.equal(preview.preview, false, 'not signed in: the live form');
  assert.equal(field(preview.form, 'interests').label, 'Live wording');
});

test('admin endpoints: save, problems, put live, restore', async () => {
  const post = async (body) => (await adminApi.onRequestPost({ env, request: new Request('https://x/api/applications-admin', { method: 'POST', body: JSON.stringify(body) }), data: { userEmail: 'peter@soardcharity.com' } })).json();
  const get = async () => (await adminApi.onRequestGet({ env, request: new Request('https://x/api/applications-admin?form=1'), data: {} })).json();
  let state = await get();
  assert.equal(state.live.builtIn, true);
  assert.equal(state.draft, null);
  assert.ok(state.locked.childName);

  const v = clone(state.live.definition);
  v.pages[0].title = 'Welcome to the {year} application';
  const saved = await post({ formSave: v });
  assert.deepEqual(saved.problems, []);
  state = await get();
  assert.equal(state.draft.definition.pages[0].title, 'Welcome to the {year} application');

  const live = await post({ formPutLive: true });
  assert.equal(live.success, true);
  state = await get();
  assert.equal(state.live.version, live.version);
  assert.equal(state.live.liveBy, 'peter@soardcharity.com');
  const audit = await env.DB.prepare('SELECT action, entity_type FROM audit_log').all();
  assert.deepEqual(audit.results.map(r => [r.action, r.entity_type]), [['published', 'application-form']]);

  const none = await post({ formPutLive: true });
  assert.equal(none.success, false);
  const back = await post({ formRestore: 0 });
  assert.equal(back.success, true);
  assert.equal((await get()).draft.definition.pages[0].title, 'Before You Begin');
});

test('the locked list matches what the site reads by id', () => {
  const answers = testAnswers('a@b.co', YEAR);
  const used = Object.keys(accountFields({ id: 'x', year: YEAR, answers })).length;
  assert.ok(used > 5);
  for (const id of ['childName', 'birthdate', 'gender', 'diagnosis', 'language', 'referredBy', 'verbal', 'ambulatory', 'makeoverTypes', 'parentName', 'parentEmail', 'parentPhone', 'parentRelation', 'address', 'county', 'video']) {
    assert.ok(LOCKED_FIELDS[id], `${id} is read by the site and must be locked`);
  }
});

// ─── Settings: they save at once, never through the form's Put live ───
const SQUARE = [[34.4, -84.8], [34.4, -84.0], [33.6, -84.0], [33.6, -84.8]];

test('settings apply at once to the live form, the draft and every version, and leave the wording alone', async () => {
  // A draft with a reworded page is in progress, and an older version is live
  const v1 = clone(DEFAULT_DEFINITION);
  v1.pages[0].title = 'Version one';
  await saveDraftForm(env.DB, v1, { user: 'linzi@soardcharity.com' });
  const one = await putDraftLive(env.DB, { user: 'linzi@soardcharity.com' });
  const wip = clone(v1);
  wip.pages[0].title = 'Half-finished rewording';
  await saveDraftForm(env.DB, wip, { user: 'linzi@soardcharity.com' });

  const out = await saveFormRules(env.DB, { staffEmails: ['selection@soardcharity.com', 'jen@soardcharity.com'], serviceArea: { polygon: SQUARE } }, { user: 'peter@soardcharity.com' });
  assert.equal(out.changes.length, 2);
  const live = await getLiveForm(env.DB, { fresh: true });
  assert.deepEqual(live.definition.staffEmails, ['selection@soardcharity.com', 'jen@soardcharity.com']);
  assert.deepEqual(live.definition.serviceArea.polygon, SQUARE);
  assert.equal(live.definition.pages[0].title, 'Version one', 'the half-finished draft did not go live with them');
  assert.equal(live.version, one.version, 'no new version: settings are not form wording');
  const draft = await getDraftForm(env.DB);
  assert.equal(draft.definition.pages[0].title, 'Half-finished rewording');
  assert.deepEqual(draft.definition.serviceArea.polygon, SQUARE, 'the draft shows the same settings');
  assert.ok(!(await diffForm(env.DB, 'draft')).some(c => c.area === 'Settings'), 'and Put live has no settings to show');
  // An application answered on any version is checked against today's boundary and emails today's list
  const old = await formFor(env.DB, { year: YEAR, version: 0 });
  assert.deepEqual(old.serviceArea.polygon, SQUARE);
  assert.deepEqual(old.staffEmails, ['selection@soardcharity.com', 'jen@soardcharity.com']);
  // Putting the draft live later doesn't bring the old settings back
  await putDraftLive(env.DB, { user: 'linzi@soardcharity.com' });
  const after = await getLiveForm(env.DB, { fresh: true });
  assert.equal(after.definition.pages[0].title, 'Half-finished rewording');
  assert.deepEqual(after.definition.serviceArea.polygon, SQUARE);
});

test('settings: bad addresses, an empty list and a two-corner boundary are refused; part of the timing keeps the rest', async () => {
  assert.match((await saveFormRules(env.DB, { staffEmails: ['not an email'] })).errors[0].message, /isn't an email address/);
  assert.match((await saveFormRules(env.DB, { staffEmails: [] })).errors[0].message, /at least one/);
  assert.match((await saveFormRules(env.DB, { serviceArea: { polygon: [[34, -84], [33, -84]] } })).errors[0].message, /three corners/);
  assert.equal(await getFormRules(env.DB), null, 'nothing was written');
  const t = await saveFormRules(env.DB, { notify: { waits: { decision: 45 } } }, { user: 'peter@soardcharity.com' });
  assert.deepEqual(t.rules.notify, { waits: { welcome: 10, inReview: 10, decision: 45 }, quiet: { start: 20, end: 8 }, summary: true });
  assert.deepEqual(t.changes, [{ field: 'application.notify.waits.decision', from: 30, to: 45 }]);
  const q = await saveFormRules(env.DB, { notify: { quiet: { start: 0, end: 0 } } }, { user: 'peter@soardcharity.com', base: t.updatedAt });
  assert.equal(q.rules.notify.waits.decision, 45, 'the wait stays');
  assert.deepEqual(q.changes, [{ field: 'application.notify.quiet', from: '8 PM to 8 AM', to: 'off' }]);
  const same = await saveFormRules(env.DB, { notify: { quiet: { start: 0, end: 0 } } }, { user: 'peter@soardcharity.com', base: q.updatedAt });
  assert.deepEqual(same.changes, [], 'saving what is already there changes nothing');
});

test('settings: two people at once get a conflict, unless they keep theirs', async () => {
  const a = await saveFormRules(env.DB, { staffEmails: ['a@soardcharity.com'] }, { user: 'linzi@soardcharity.com' });
  const stale = await saveFormRules(env.DB, { staffEmails: ['b@soardcharity.com'] }, { user: 'peter@soardcharity.com', base: '2026-01-01T00:00:00.000Z' });
  assert.equal(stale.conflict.updatedBy, 'linzi@soardcharity.com');
  assert.deepEqual(stale.conflict.rules.staffEmails, ['a@soardcharity.com']);
  const mine = await saveFormRules(env.DB, { staffEmails: ['b@soardcharity.com'] }, { user: 'peter@soardcharity.com', base: '2026-01-01T00:00:00.000Z', force: true });
  assert.deepEqual(mine.rules.staffEmails, ['b@soardcharity.com']);
  const fresh = await saveFormRules(env.DB, { staffEmails: ['c@soardcharity.com'] }, { user: 'peter@soardcharity.com', base: a.updatedAt });
  assert.deepEqual(fresh.rules.staffEmails, ['c@soardcharity.com'], 'their own earlier save is never a conflict');
});

test('settings endpoints: Settings reads them, saving logs Recent changes, the map boundary saves live', async () => {
  const user = 'peter@soardcharity.com';
  const post = async (api, body) => (await api.onRequestPost({ env, request: new Request('https://x/api', { method: 'POST', body: JSON.stringify(body) }), data: { userEmail: user }, waitUntil: () => {} })).json();
  const get = async (q) => (await adminApi.onRequestGet({ env, request: new Request(`https://x/api/applications-admin?${q}`), data: {} })).json();
  const first = await get('settings=1');
  assert.deepEqual(first.rules.values.staffEmails, ['selection@soardcharity.com']);
  assert.equal(first.rules.updatedAt, null);
  const saved = await post(adminApi, { rules: { staffEmails: ['selection@soardcharity.com', 'jen@soardcharity.com'] }, base: null });
  assert.equal(saved.success, true);
  assert.deepEqual(saved.rules.values.staffEmails, ['selection@soardcharity.com', 'jen@soardcharity.com']);
  assert.ok(saved.history.some(h => h.changes.some(c => c.field === 'application.staffEmails')), 'Recent changes lists it');
  const bad = await post(adminApi, { rules: { staffEmails: ['nope'] }, base: saved.rules.updatedAt });
  assert.equal(bad.success, false);
  assert.match(bad.error, /isn't an email address/);
  // The Applicants map: a new boundary is live straight away (no form draft)
  const b = await post(applicantsApi, { boundary: SQUARE });
  assert.equal(b.success, true, b.error);
  assert.equal(b.changed, true);
  assert.deepEqual((await getLiveForm(env.DB, { fresh: true })).definition.serviceArea.polygon, SQUARE);
  assert.equal(await getDraftForm(env.DB), null, 'no draft was made');
  const audit = await env.DB.prepare("SELECT entity_type FROM audit_log WHERE entity_slug = 'rules'").all();
  assert.equal(audit.results.length, 2);
  assert.ok(audit.results.every(r => r.entity_type === 'application-settings'), 'a runtime change: never waits for a Publish');
});
