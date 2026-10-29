/**
 * The organization application (functions/api/_application-form-org.js): a
 * school, clinic or nonprofit applies for a community project the way a
 * family applies for a makeover. Its own form and versions, its own JobTread
 * account (no child's fields), its own wording, outside the family season's
 * limit, and the rule that tells an organization's account from a family's.
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from './lib/fake-applicant-world.mjs';
import {
  ORG_DEFAULT_DEFINITION, ORG_LOCKED_FIELDS, DEFAULT_DEFINITION, validateDefinition, normalizeDefinition, resolveForm, renderMessage,
  kindOf, rolesFor, formErrors, applicationForm,
} from '../functions/api/_application-form.js';
import {
  getLiveForm, getDraftForm, saveDraftForm, putDraftLive, listFormVersions, restoreFormVersion, saveFormRules, getFormRules, formFor, clearFormCache,
} from '../functions/api/_application-forms.js';
import {
  createDraft, getDraft, saveDraft, setDraftFile, submitDraft, processApplication, getApplication, listApplications, insights,
  accountFields, contactInputs, JT_FIELDS, photoKey, TEST_JPEG, testOrgAnswers, applicantNameOf, isTestAnswers, pickApplication,
} from '../functions/api/_applications.js';
import { countReceived } from '../functions/api/_application-cap.js';
import { accountKindFor, looksLikeOrganization } from '../functions/api/_applicant-comms.js';
import * as applyApi from '../functions/api/apply.js';

const YEAR = '2027';
let w;
let env;
beforeEach(async () => {
  w = fakeApplicantWorld();
  env = { ...w.env, DB: await createD1() };
  globalThis.fetch = w.fetchImpl;
  clearFormCache();
});

const orgAnswers = (over = {}) => ({
  ...testOrgAnswers('director@sunnyside.example', YEAR),
  orgName: 'Sunnyside Academy',
  contactName: { first: 'Jordan', last: 'Lee' }, contactTitle: 'Executive Director',
  contact2Name: { first: 'Sam', last: 'Park' }, contact2Title: 'Therapy Lead', contact2Email: 'sam@sunnyside.example', contact2Phone: '770 555 0199',
  spaceTypes: ['Sensory room', 'Classroom or learning space'],
  ...over,
});

async function readyOrgDraft(answers = orgAnswers()) {
  const id = await createDraft(env.DB, { year: YEAR, ipHash: 'ip', verified: true, kind: 'organization' });
  let draft = await getDraft(env.DB, id);
  await saveDraft(env.DB, draft, { answers, page: 'finish' });
  for (const f of ['photoSpace1', 'photoSpace2']) {
    await env.FILES.put(photoKey(id, f), TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await env.FILES.put(photoKey(id, f, true), TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await setDraftFile(env.DB, id, f, { key: photoKey(id, f), thumbKey: photoKey(id, f, true), type: 'image/jpeg', size: TEST_JPEG.byteLength, name: `${f}.jpg` });
  }
  return getDraft(env.DB, id);
}

// ─── The form ───────────────────────────────────────────────────────

test('the organization form is its own: valid as built, its own questions the site reads, its own wording', () => {
  assert.deepEqual(validateDefinition(normalizeDefinition(ORG_DEFAULT_DEFINITION)), []);
  assert.equal(kindOf(normalizeDefinition(ORG_DEFAULT_DEFINITION)), 'organization', 'the kind survives cleaning');
  assert.equal(kindOf(normalizeDefinition(DEFAULT_DEFINITION)), 'family');
  const form = resolveForm(ORG_DEFAULT_DEFINITION, { year: YEAR });
  assert.equal(form.kind, 'organization');
  assert.match(form.title, /2027 Community Project Application/);
  assert.deepEqual(form.languages, ['en'], 'English only');
  const ids = form.pages.flatMap((p) => p.fields.map((f) => f.id));
  for (const id of Object.keys(ORG_LOCKED_FIELDS)) assert.ok(ids.includes(id), id);
  assert.ok(!ids.some((id) => ['childName', 'birthdate', 'diagnosis', 'video'].includes(id)), 'nothing about a child, and no video');
  // Removing a question the site reads, or the organization's name from a message, can't go live
  const def = normalizeDefinition(ORG_DEFAULT_DEFINITION);
  const noName = { ...def, pages: def.pages.map((p) => ({ ...p, fields: p.fields.filter((f) => f.id !== 'orgName') })) };
  assert.ok(validateDefinition(noName).some((e) => e.where === 'orgName'));
  const childToken = { ...def, messages: { ...def.messages, approved: 'Congratulations, {child}!' } };
  assert.deepEqual(validateDefinition(childToken).filter((e) => e.where === 'messages/approved').map((e) => e.message), ['This message should name the organization with {organization}.']);
  assert.equal(renderMessage(form.messages.approved, { parent: 'Jordan Lee', child: 'Sunnyside Academy' }).split('\n')[0], 'Jordan Lee');
  assert.match(renderMessage(form.messages.approved, { parent: 'Jordan Lee', child: 'Sunnyside Academy' }), /application for \*Sunnyside Academy\* has been approved/);
  assert.doesNotMatch(Object.values(form.messages).join(' '), /your child|your family/i);
  assert.equal(rolesFor('organization').email, 'contactEmail');
});

test('each form has its own versions; organizations share the family form’s service area and keep their own staff list', async () => {
  const org = await getLiveForm(env.DB, { kind: 'organization' });
  assert.equal(org.builtIn, true);
  assert.equal(kindOf(org.definition), 'organization');
  // An organization draft put live leaves the family form alone
  const def = normalizeDefinition(ORG_DEFAULT_DEFINITION);
  def.title = 'Sunnyside test {year}';
  const saved = await saveDraftForm(env.DB, def, { user: 'peter@soardcharity.com', kind: 'organization' });
  assert.deepEqual(saved.errors, []);
  assert.equal((await getDraftForm(env.DB)), null, 'no family draft');
  assert.ok(await getDraftForm(env.DB, { kind: 'organization' }));
  assert.equal((await putDraftLive(env.DB, { user: 'peter@soardcharity.com', kind: 'organization' })).ok, true);
  clearFormCache();
  assert.equal((await getLiveForm(env.DB, { kind: 'organization' })).definition.title, 'Sunnyside test {year}');
  assert.equal((await getLiveForm(env.DB)).builtIn, true, 'families still get the built-in form');
  assert.deepEqual((await listFormVersions(env.DB)).length, 0);
  assert.equal((await listFormVersions(env.DB, { kind: 'organization' })).length, 1);
  // A family version can't be restored into the organization form
  const fam = await saveDraftForm(env.DB, normalizeDefinition(DEFAULT_DEFINITION), { user: 'peter@soardcharity.com' });
  assert.equal((await restoreFormVersion(env.DB, fam.version, { kind: 'organization' })).ok, false);
  // Settings: the service area is one outline for both; the staff list is each form's own
  const polygon = [[34.3, -84.5], [34.2, -84.0], [33.9, -84.1], [33.9, -84.5]];
  await saveFormRules(env.DB, { serviceArea: { polygon } }, { user: 'peter@soardcharity.com' });
  await saveFormRules(env.DB, { staffEmails: ['community@soardcharity.com'] }, { user: 'peter@soardcharity.com', kind: 'organization' });
  clearFormCache();
  const orgForm = await formFor(env.DB, { year: YEAR, kind: 'organization' });
  assert.deepEqual(orgForm.serviceArea.polygon, polygon, 'the family form’s outline');
  assert.deepEqual(orgForm.staffEmails, ['community@soardcharity.com']);
  assert.deepEqual((await formFor(env.DB, { year: YEAR })).staffEmails, ['selection@soardcharity.com'], 'the family list is untouched');
});

test('community projects run on the makeovers’ email timing, and their list until they get their own', async () => {
  clearFormCache();
  const peter = { user: 'peter@soardcharity.com' };
  // Makeovers' settings as staff set them: who hears, and how long status emails wait
  await saveFormRules(env.DB, { staffEmails: ['selection@soardcharity.com', 'jen@soardcharity.com'], notify: { waits: { inReview: 15, decision: 45 } } }, peter);
  clearFormCache();
  let org = await formFor(env.DB, { year: YEAR, kind: 'organization' });
  assert.deepEqual(org.staffEmails, ['selection@soardcharity.com', 'jen@soardcharity.com'], 'never set: the makeovers’ list, not a built-in one');
  assert.equal(org.notify.waits.inReview, 15);
  assert.equal(org.notify.waits.decision, 45, 'the same waits as makeovers');
  // The timing can't be set apart: an organization save only takes its list
  const own = await saveFormRules(env.DB, { staffEmails: ['holly@soardcharity.com'], notify: { waits: { decision: 5 } } }, { ...peter, kind: 'organization' });
  assert.deepEqual(own.changes, [{ field: 'application.staffEmails', from: 'selection@soardcharity.com, jen@soardcharity.com', to: 'holly@soardcharity.com' }]);
  assert.deepEqual((await getFormRules(env.DB, { kind: 'organization' })).rules, { staffEmails: ['holly@soardcharity.com'] });
  clearFormCache();
  org = await formFor(env.DB, { year: YEAR, kind: 'organization' });
  assert.deepEqual(org.staffEmails, ['holly@soardcharity.com']);
  assert.equal(org.notify.waits.decision, 45);
  // Makeovers' timing changes: community projects follow; their own list stays
  await saveFormRules(env.DB, { notify: { waits: { decision: 60 } }, staffEmails: ['selection@soardcharity.com'] }, peter);
  org = await formFor(env.DB, { year: YEAR, kind: 'organization' });
  assert.equal(org.notify.waits.decision, 60);
  assert.deepEqual(org.staffEmails, ['holly@soardcharity.com']);
  // Back to the makeovers' list (null), and it follows that list again
  const back = await saveFormRules(env.DB, { staffEmails: null }, { ...peter, kind: 'organization', base: own.updatedAt });
  assert.deepEqual(back.changes.map((c) => c.field), ['application.staffEmails', 'application.staffEmails.family']);
  assert.deepEqual((await getFormRules(env.DB, { kind: 'organization' })).rules, {}, 'nothing of its own is kept');
  await saveFormRules(env.DB, { staffEmails: ['intake@soardcharity.com'] }, peter);
  org = await formFor(env.DB, { year: YEAR, kind: 'organization' });
  assert.deepEqual(org.staffEmails, ['intake@soardcharity.com']);
  // Already following: a second "back" saves nothing
  assert.deepEqual((await saveFormRules(env.DB, { staffEmails: null }, { ...peter, kind: 'organization' })).changes, []);
});

test('JobTread gets an organization’s account: its name, its contacts, the spaces JobTread knows, nothing of a child’s', () => {
  const app = { id: 'app-x', year: YEAR, kind: 'organization', answers: orgAnswers(), is_test: 0 };
  const f = accountFields(app);
  assert.equal(f[JT_FIELDS.status], 'Applied');
  assert.deepEqual(f[JT_FIELDS.makeoverType], ['Therapy Room'], 'a sensory room is a Therapy Room; a classroom has no JobTread type');
  assert.equal(f[JT_FIELDS.makeoverYear], YEAR);
  for (const k of ['birthday', 'diagnosis', 'gender', 'language', 'verbal', 'mobile']) assert.equal(f[JT_FIELDS[k]], undefined, k);
  assert.deepEqual(contactInputs(app).map((c) => [c.name, c.title]), [['Jordan Lee', 'Executive Director'], ['Sam Park', 'Therapy Lead']]);
  assert.equal(applicantNameOf(app.answers, 'organization'), 'Sunnyside Academy');
  assert.equal(isTestAnswers({ orgName: 'TEST School' }, 'organization'), true);
  assert.equal(isTestAnswers({ orgName: 'Testament Church' }, 'organization'), false);
});

test('submit: an organization’s application reaches JobTread with its wording, and no medical note', async () => {
  const draft = await readyOrgDraft();
  const sub = await submitDraft(env, draft);
  assert.equal(sub.ok, true, JSON.stringify(sub));
  const r = await processApplication(env, sub.id, { fetchImpl: w.fetchImpl });
  assert.equal(r.status, 'done', JSON.stringify(r));
  const [acct] = Object.values(w.world.accounts);
  assert.equal(acct.name, 'Sunnyside Academy');
  assert.equal(acct.org, ORG);
  assert.equal(acct.fields[JT_FIELDS.birthday], undefined);
  assert.deepEqual(acct.contacts.map((c) => [c.name, c.title]), [['Jordan Lee', 'Executive Director'], ['Sam Park', 'Therapy Lead']]);
  assert.deepEqual(acct.files.map((f) => f.name).sort(), ['Sunnyside Academy Space 1.jpg', 'Sunnyside Academy Space 2.jpg', 'Sunnyside Academy_Application.pdf']);
  const welcome = acct.comments.find((c) => c.name === 'Application Status');
  assert.match(welcome.message, /^Jordan Lee and Sam Park\n\nThank you for applying on behalf of \*Sunnyside Academy\*\. Your application is under review\./);
  assert.doesNotMatch(welcome.message, /your child|your family|on-site visit/i, 'no family wording');
  assert.equal(welcome.files.length, 1, 'the PDF copy');
  assert.equal(acct.comments.some((c) => c.name === "Child's Medical Condition"), false);
  // Staff hear it as a community project application
  assert.match(w.world.emails[0].subject, /^New community project application: Sunnyside Academy$/);
  assert.match(w.world.emails[0].html, /Sunnyside Academy applied for a community project/);
  assert.match(w.world.slack[0].text, /^🏫 New community project application: Sunnyside Academy/);
  // The site's record knows what it is
  const app = await getApplication(env.DB, sub.id);
  assert.equal(app.kind, 'organization');
  assert.equal(app.child_name, 'Sunnyside Academy');
  assert.equal(app.parent_email, 'director@sunnyside.example');
  const list = await listApplications(env.DB, { kind: 'organization' });
  assert.deepEqual(list.applications.map((a) => [a.kind, a.checklist.medicalNote]), [['organization', 'none']]);
  assert.equal((await listApplications(env.DB, { kind: 'family' })).applications.length, 0);
  // Insights count each form's own funnel
  const funnel = async (kind) => JSON.stringify(await insights(env.DB, { year: YEAR, kind }));
  assert.notEqual(await funnel('organization'), await funnel('family'), 'the organization funnel is its own');
});

test('the organization form runs on its own switch, all year, outside the family season’s limit', async () => {
  const settings = (application) => env.DB.prepare("INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES ('settings', ?, ?)").bind(JSON.stringify({ application }), new Date().toISOString()).run();
  await env.DB.exec("CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)");
  await settings({ open: false, year: YEAR });
  assert.equal(pickApplication({}).orgOpen, true, 'open unless switched off');
  const call = (body) => applyApi.onRequestPost({ env, request: new Request('https://x/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), waitUntil: () => {} });
  const get = (q) => applyApi.onRequestGet({ env, request: new Request(`https://x/api/apply?config${q}`) });
  // Families closed, organizations open
  assert.equal((await (await get('')).json()).open, false);
  const cfg = await (await get('&kind=organization')).json();
  assert.equal(cfg.open, true);
  assert.equal(cfg.kind, 'organization');
  assert.equal(cfg.definition.kind, 'organization');
  assert.equal((await call({ action: 'start', year: YEAR })).status, 403, 'the family form is closed');
  const started = await (await call({ action: 'start', year: YEAR, kind: 'organization' })).json();
  assert.equal(started.ok, true);
  assert.equal((await getDraft(env.DB, started.token)).kind, 'organization');
  // Switched off: organizations get the closed card too
  await settings({ open: false, year: YEAR, orgOpen: false });
  assert.equal((await call({ action: 'start', year: YEAR, kind: 'organization' })).status, 403);
  // An organization's application never counts toward the family limit
  const draft = await readyOrgDraft();
  await submitDraft(env, draft);
  assert.equal(await countReceived(env.DB, YEAR), 0);
});

test('whose account it is: the form that made it, else an organization only by every sign', () => {
  assert.equal(accountKindFor({ formKind: 'organization', name: 'Max Sample' }), 'organization', 'the form decides');
  assert.equal(accountKindFor({ formKind: 'family', name: 'The Lionheart School' }), 'family', 'the family form decides too');
  assert.equal(accountKindFor({ name: 'The Lionheart School' }), 'organization', 'made by hand: no child’s details and an organization’s name');
  assert.equal(accountKindFor({ name: 'The Lionheart School', birthday: '2016-01-01' }), 'family', 'a birthday is a child’s');
  assert.equal(accountKindFor({ name: 'Perfect Harmony Health', diagnosis: 'Autism' }), 'family', 'so is a diagnosis');
  assert.equal(accountKindFor({ name: 'Max Sample' }), 'family', 'a family not filled in yet stays a family');
  for (const n of ['Children’s Development Academy', 'Camp Twin Lakes', 'Mt. Zion UMC Preschool', 'Murphy-Harpst Children\'s Center', 'Summit Counseling Center']) assert.ok(looksLikeOrganization(n), n);
  for (const n of ['Remi & Nico Powell', 'Grace Wells', 'Declan “Dex” Noel']) assert.ok(!looksLikeOrganization(n), n);
});

test('the built-in organization form: a complete set of answers has no errors', () => {
  const form = applicationForm({ year: YEAR, definition: ORG_DEFAULT_DEFINITION });
  const errors = formErrors(form, orgAnswers(), { photoSpace1: { key: 'k' }, photoSpace2: { key: 'k' } });
  assert.deepEqual(errors, {});
});
