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
  answerText, allFields, renderMessage, translationStatus,
} from '../functions/api/_application-form.js';
import {
  getLiveForm, saveDraftForm, putDraftLive, discardDraftForm, restoreFormVersion, listFormVersions, formFor, clearFormCache, getDraftForm,
  saveFormRules, getFormRules, diffForm, addTranslations,
} from '../functions/api/_application-forms.js';
import { spanishToDo, catchUpSpanish } from '../functions/api/_translate.js';
import { familyMessage } from '../functions/api/_applicant-comms.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { renderSlack, slackButtons } from './lib/slack-render.mjs';
import {
  createDraft, getDraft, saveDraft, setDraftFile, submitDraft, processApplication, getApplication, photoKey, TEST_JPEG, testAnswers, accountFields, JT_FIELDS, maybeSweepApplications,
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
  field(later, 'referredBy').showIf = { field: 'ownership', in: ['No, the property is rented.'] };
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
  // JobTread logs the move, and its workflow wakes the site with the event's id
  w.world.events.push({ id: 'evtFORM000001', createdAt: new Date(T0).toISOString(), type: 'accountUpdated', createdByGrantId: 'g1', createdByGrantName: 'JobTread App', createdByUser: { name: 'Linzi Berkowitz', emailAddress: 'linzi@example.com' }, data: { next: { custom: { Status: 'In Review' } }, previous: { custom: { Status: 'Applied' } } }, account: { id, type: 'customer' } });
  await handleWorkflowCall(env, { accountId: id, eventId: 'evtFORM000001' }, { fetchImpl: w.fetchImpl, now: T0 });
  for (const t of [T0 + 4 * 60000, T0 + 11 * 60000]) await runNotifications(env, { fetchImpl: w.fetchImpl, now: t });
  assert.equal(w.world.accounts[id].comments.at(-1).message, 'Hi Morgan Park! Good news for *Riley Park*: next is the home visit.');
  assert.equal(renderMessage('{parent} {child}{copyNote}', { parent: 'A', child: 'B', copyNote: 'Copy.' }), 'A B\n\nCopy.');
});

test('the Spanish follows the English: Put live translates what changed, the sweep finishes what the AI could not', async () => {
  const post = async (body) => (await adminApi.onRequestPost({ env, request: new Request('https://x/api/applications-admin', { method: 'POST', body: JSON.stringify(body) }), data: { userEmail: 'linzi@soardcharity.com' } })).json();
  const liveDef = async () => (await getLiveForm(env.DB, { fresh: true })).definition;
  const toSpanish = async (model, { messages }) => {
    env.AI.prompts.push(messages.at(-1).content);
    const batch = JSON.parse(messages.at(-1).content);
    return { response: JSON.stringify(Object.fromEntries(Object.entries(batch).map(([p, t]) => [p, `ES ${t}`]))) };
  };
  const down = async () => { env.AI.prompts.push('down'); throw new Error('AI unavailable'); };
  env.AI.run = toSpanish;

  // New wording in English; one change already has Spanish someone wrote for it
  const v = clone(DEFAULT_DEFINITION);
  v.messages = { ...v.messages, welcome: 'Hi, {parent}\n\nWe’ve received *{child}*’s application. We’ll be in touch about a Zoom interview.{copyNote}' };
  field(v, 'interests').label = 'What does your child love?';
  field(v, 'diagnosis').label = 'What is the diagnosis?';
  v.i18n.es.strings['field:diagnosis:label'] = '¿Cuál es el diagnóstico?';
  v.i18n.es.sources['field:diagnosis:label'] = 'What is the diagnosis?';
  await post({ formSave: v });
  const live = await post({ formPutLive: true });
  assert.equal(live.success, true);
  assert.deepEqual(live.spanish, { filled: 2, failed: [] });
  const es = resolveForm(await liveDef(), { year: YEAR, lang: 'es' });
  assert.equal(field(es, 'interests').label, 'ES What does your child love?');
  assert.equal(field(es, 'diagnosis').label, '¿Cuál es el diagnóstico?', 'Spanish typed for the current English stays');
  // The email a Spanish-speaking family gets is the new wording
  assert.equal(await familyMessage(env, 'welcome', { parent: 'Ana', child: 'Sofía', lang: 'es' }), 'ES Hi, Ana\n\nWe’ve received *Sofía*’s application. We’ll be in touch about a Zoom interview.');

  // The AI is down at Put live: the form still goes live, and the old Spanish waits for the sweep
  env.AI.run = down;
  const v2 = await liveDef();
  v2.messages.inReview = 'Hi, {parent}\n\nNext is a Zoom call about *{child}*.';
  await post({ formSave: v2 });
  const live2 = await post({ formPutLive: true });
  assert.equal(live2.success, true);
  assert.deepEqual(live2.spanish, { filled: 0, failed: ['message:inReview'] });
  assert.doesNotMatch(await familyMessage(env, 'inReview', { parent: 'Ana', child: 'Sofía', lang: 'es' }), /Zoom/);

  const T0 = Date.parse('2026-10-29T15:00:00Z');
  await maybeSweepApplications(env, { force: true, now: T0 });
  env.AI.run = toSpanish;
  env.AI.prompts.length = 0;
  await maybeSweepApplications(env, { force: true, now: T0 + 5 * 60000 });
  assert.equal(env.AI.prompts.length, 0, 'tried this version minutes ago: waits');
  await maybeSweepApplications(env, { force: true, now: T0 + 16 * 60000 });
  assert.equal(await familyMessage(env, 'inReview', { parent: 'Ana', child: 'Sofía', lang: 'es' }), 'ES Hi, Ana\n\nNext is a Zoom call about *Sofía*.');
  assert.deepEqual(spanishToDo(await liveDef()), {});
  env.AI.prompts.length = 0;
  await maybeSweepApplications(env, { force: true, now: T0 + 60 * 60000 });
  assert.equal(env.AI.prompts.length, 0, 'nothing left to translate');

  // A translation made from English that has since changed is dropped
  const { version } = await getLiveForm(env.DB, { fresh: true });
  assert.equal(await addTranslations(env.DB, version, { 'message:denied': { text: 'ES old', from: 'Some older English' } }), 0);
});

test('the Spanish: batches back in time land, a slow one is left for the sweep', async () => {
  const v = clone(DEFAULT_DEFINITION);
  v.messages = { ...v.messages, approved: `Hi {parent}! ${'Long news. '.repeat(320)}` };
  field(v, 'interests').label = 'What does your child love?';
  await saveDraftForm(env.DB, v);
  const { version } = await getDraftForm(env.DB);
  env.AI.run = async (model, { messages }) => {
    const batch = JSON.parse(messages.at(-1).content);
    if (batch['message:approved']) await new Promise(() => {});
    return { response: Object.fromEntries(Object.entries(batch).map(([p, t]) => [p, `ES ${t}`])) };
  };
  assert.deepEqual(await catchUpSpanish(env, version, { budgetMs: 50 }), { filled: 1, failed: ['message:approved'] });
  assert.deepEqual(Object.keys(spanishToDo((await getDraftForm(env.DB)).definition)), ['message:approved']);
});

test('the Spanish: the built-in Spanish under new English is out of date, even when it was marked current (the live Denied email, Oct 2026)', async () => {
  // What production had: Denied reworded in English, its built-in Spanish marked as made from the new English
  const v = clone(DEFAULT_DEFINITION);
  v.messages = { ...v.messages, denied: 'Hi {parent},\n\nAfter carefully reviewing {child}’s application, we are unable to move forward.' };
  v.i18n.es.sources['message:denied'] = v.messages.denied;
  await saveDraftForm(env.DB, v);
  await putDraftLive(env.DB);
  const { version } = await getLiveForm(env.DB, { fresh: true });
  assert.deepEqual(Object.keys(spanishToDo((await getLiveForm(env.DB, { fresh: true })).definition)), ['message:denied']);

  // The AI is down: it is marked out of date, so the admin shows it too
  env.AI.run = async () => { throw new Error('AI unavailable'); };
  assert.deepEqual(await catchUpSpanish(env, version), { filled: 0, failed: ['message:denied'] });
  const live = (await getLiveForm(env.DB, { fresh: true })).definition;
  assert.equal(live.i18n.es.sources['message:denied'], DEFAULT_DEFINITION.i18n.es.sources['message:denied']);
  assert.equal(translationStatus(live)['message:denied'], 'stale');

  env.AI.run = async (model, { messages }) => ({ response: Object.fromEntries(Object.entries(JSON.parse(messages.at(-1).content)).map(([p, t]) => [p, `ES ${t}`])) });
  assert.deepEqual(await catchUpSpanish(env, version), { filled: 1, failed: [] });
  assert.equal(await familyMessage(env, 'denied', { parent: 'Ana', child: 'Sofía', lang: 'es' }), 'ES Hi Ana,\n\nAfter carefully reviewing Sofía’s application, we are unable to move forward.');
  assert.deepEqual(spanishToDo((await getLiveForm(env.DB, { fresh: true })).definition), {});

  // Built-in Spanish under unchanged English stays as it is
  assert.equal((await getLiveForm(env.DB, { fresh: true })).definition.i18n.es.strings['message:approved'], DEFAULT_DEFINITION.i18n.es.strings['message:approved']);

  // Built-in Spanish someone kept with "The Spanish is still right" stays too
  const k = clone((await getLiveForm(env.DB, { fresh: true })).definition);
  k.messages.approved = 'Hi {parent}! *{child}* has been approved.';
  k.i18n.es.sources['message:approved'] = k.messages.approved;
  k.i18n.es.kept = { 'message:approved': k.messages.approved };
  await saveDraftForm(env.DB, k);
  const kd = (await getDraftForm(env.DB)).definition;
  assert.equal(kd.i18n.es.kept['message:approved'], k.messages.approved, 'kept survives saving');
  assert.deepEqual(spanishToDo(kd), {});
});

test('the Spanish: a batch that comes back broken is translated one string at a time instead', async () => {
  const v = clone(DEFAULT_DEFINITION);
  v.messages = { ...v.messages, inReview: 'Hi, {parent}\n\nNext is a visit.\n\n"{child}" does not have to be there.' };
  field(v, 'interests').label = 'What does your child love?';
  await saveDraftForm(env.DB, v);
  const { version } = await getDraftForm(env.DB);
  const asked = [];
  env.AI.run = async (model, { messages }) => {
    const text = messages.at(-1).content;
    asked.push(messages[0].content.includes('Reply with JSON') ? 'batch' : 'one');
    // The batch: JSON with a raw line break inside a string, which doesn't parse
    if (messages[0].content.includes('Reply with JSON')) return { response: '{"message:inReview": "Hola, {parent}\n\nSigue una visita."' };
    return { response: `  ES ${text}\n` };
  };
  assert.deepEqual(await catchUpSpanish(env, version), { filled: 2, failed: [] });
  assert.deepEqual(asked, ['batch', 'batch', 'one', 'one']);
  const es = (await getDraftForm(env.DB)).definition.i18n.es.strings;
  assert.equal(es['message:inReview'], 'ES Hi, {parent}\n\nNext is a visit.\n\n"{child}" does not have to be there.');
  assert.equal(es['field:interests:label'], 'ES What does your child love?');
});

test('the Spanish: still behind after four tries, Slack hears once, and the post turns ✅ when it catches up', async () => {
  env.SLACK_BOT_TOKEN = 'xoxb-test';
  delete env.SLACK_WEBHOOK_URL;
  await writeSlackConfig(env.DB, { channel: { id: 'C0ALERTS', name: 'website-alerts' } });
  const v = clone(DEFAULT_DEFINITION);
  v.messages = { ...v.messages, denied: 'Hi {parent}, we are unable to move forward with {child}’s application.' };
  await saveDraftForm(env.DB, v);
  env.AI.run = async () => { throw new Error('AI unavailable'); };
  await putDraftLive(env.DB);
  let t = Date.parse('2026-10-29T15:00:00Z');
  for (let i = 0; i < 6; i++) { await maybeSweepApplications(env, { force: true, now: t }); t += 16 * 60000; }
  const posts = w.world.slack.filter(p => /Spanish application is behind/.test(p.text));
  assert.equal(posts.length, 1, 'once, on the fourth try');
  const card = renderSlack(posts[0]);
  assert.match(card, /^⚠️ The Spanish application is behind the English\nThe website couldn’t translate one change to the application after 4 tries, so Spanish-speaking families still get the older Spanish there\./);
  assert.match(card, /Where.*Denied email/s);
  assert.deepEqual(slackButtons(posts[0]).map(b => b.url), ['https://sunshineonaranneyday.com/admin/#applications/form/spanish']);
  const ts = `${w.world.slack.indexOf(posts[0]) + 1}.0001`;

  env.AI.run = async (model, { messages }) => ({ response: Object.fromEntries(Object.entries(JSON.parse(messages.at(-1).content)).map(([p, x]) => [p, `ES ${x}`])) });
  await maybeSweepApplications(env, { force: true, now: t });
  assert.equal(await familyMessage(env, 'denied', { parent: 'Ana', child: 'Sofía', lang: 'es' }), 'ES Hi Ana, we are unable to move forward with Sofía’s application.');
  const edit = (w.world.slackEdits || []).find(e => e.ts === ts);
  assert.equal(renderSlack(edit), '✅ Resolved: The Spanish application was behind the English');
  assert.match(w.world.slack.filter(p => p.thread_ts === ts).at(-1).text, /^✅ The Spanish application caught up/);
  await maybeSweepApplications(env, { force: true, now: t + 60 * 60000 });
  assert.equal(w.world.slack.filter(p => /Spanish application/.test(p.text)).length, 2, 'and nothing more');
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
