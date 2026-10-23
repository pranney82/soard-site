/**
 * Makeover applications: the form definition (functions/api/_application-form.js),
 * drafts → submit → JobTread (functions/api/_applications.js), the public
 * endpoint (functions/api/apply.js), the PDF, and the applicant messages that
 * replace the Zapier Zaps (functions/api/_applicant-comms.js)
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from './lib/fake-applicant-world.mjs';
import { renderSlack, slackButtons } from './lib/slack-render.mjs';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import {
  applicationForm, formErrors, stopFor, cleanAnswers, isVisible, allFields, answerSections, toE164,
} from '../functions/api/_application-form.js';
import {
  createDraft, getDraft, saveDraft, setDraftFile, submitDraft, processApplication, getApplication,
  maybeSweepApplications, expireDrafts, accountFields, contactInputs, JT_FIELDS, photoKey, TEST_JPEG,
  testAnswers, createTestApplication, listApplications, applicationUrl, DRAFT_TTL_DAYS, reminderEmail,
} from '../functions/api/_applications.js';
import { handleApplicantEvent, QC_USER_ID } from '../functions/api/_applicant-comms.js';
import { handleWorkflowCall, runNotifications } from '../functions/api/_applicant-notify.js';
import { DEFAULT_MESSAGES, DEFAULT_DEFINITION, renderMessage } from '../functions/api/_application-form.js';
import { buildApplicationPdf } from '../functions/api/_application-pdf.js';
import * as applyApi from '../functions/api/apply.js';

const YEAR = '2027';
const form = applicationForm({ year: YEAR });
const PHOTOS = ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2'];

function fullAnswers(over = {}) {
  return {
    ...testAnswers('mom@example.com', YEAR),
    childName: { first: 'Avery', last: 'Stone' },
    parentName: { first: 'Jordan', last: 'Stone' },
    parent2Name: { first: 'Sam', last: 'Stone' }, parent2Relation: 'Father', parent2Email: 'dad@example.com', parent2Phone: '770 555 0199',
    makeoverTypes: ['Accessible Bathroom', 'Dream Bedroom'],
    diagnosis: 'Spina bifida',
    ...over,
  };
}

let w;
let env;
beforeEach(async () => {
  w = fakeApplicantWorld();
  env = { ...w.env, DB: await createD1() };
  globalThis.fetch = w.fetchImpl; // sendEmails and the endpoint use the global fetch
});

/**
 * A draft with every answer, four photos and an uploaded video. video:
 * 'processing' (Stream still working), 'ready' (MP4 downloadable), false (none)
 */
async function readyDraft(answers = fullAnswers(), { video = 'processing' } = {}) {
  const id = await createDraft(env.DB, { year: YEAR, ipHash: 'ip', verified: true });
  let draft = await getDraft(env.DB, id);
  await saveDraft(env.DB, draft, { answers, page: 'finish' });
  for (const f of PHOTOS) {
    await env.FILES.put(photoKey(id, f), TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await env.FILES.put(photoKey(id, f, true), TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await setDraftFile(env.DB, id, f, { key: photoKey(id, f), thumbKey: photoKey(id, f, true), type: 'image/jpeg', size: TEST_JPEG.byteLength, name: `${f}.jpg` });
  }
  if (video) {
    w.world.videos.vid1 = { uid: 'vid1', readyToStream: false, status: { state: 'inprogress' }, duration: -1 };
    if (video === 'ready') { w.advanceVideo('vid1', 'ready'); w.advanceVideo('vid1', 'mp4'); }
    await setDraftFile(env.DB, id, 'video', { uid: 'vid1', uploaded: true, size: 1000, name: 'clip.mov' });
  }
  return getDraft(env.DB, id);
}

const run = (id, now) => processApplication(env, id, { fetchImpl: w.fetchImpl, ...(now ? { now } : {}) });

// ── The form definition ─────────────────────────────────────────────

test('every field id is unique and every showIf points at a real choice', () => {
  const fields = allFields(form);
  const ids = fields.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length);
  const byId = Object.fromEntries(fields.map(f => [f.id, f]));
  for (const f of fields.filter(x => x.showIf)) {
    const parent = byId[f.showIf.field];
    assert.ok(parent, `${f.id} depends on a missing field`);
    for (const v of f.showIf.in) assert.ok(parent.options.includes(v), `${f.id}: "${v}" is not an option of ${parent.id}`);
  }
  for (const f of fields.filter(x => x.stops)) {
    for (const v of Object.keys(f.stops)) assert.ok(f.options.includes(v), `${f.id} stop on a missing option`);
  }
});

test('the season year flows into the wording', () => {
  assert.equal(form.title, 'Sunshine on a Ranney Day 2027 Application');
  assert.match(allFields(form).find(f => f.id === 'ackSeason').label, /2027 makeover season.*spring of 2027/);
});

test('follow-up questions show only for the answer that asks for them', () => {
  const byId = Object.fromEntries(allFields(form).map(f => [f.id, f]));
  assert.equal(isVisible(byId.sensoryDetail, { sensory: 'No' }, byId), false);
  assert.equal(isVisible(byId.sensoryDetail, { sensory: 'Yes' }, byId), true);
  assert.equal(isVisible(byId.permitsDetail, { permits: 'Yes' }, byId), true);
  // As in Jotform, the "please explain" follow-ups are optional
  const withYes = formErrors(form, fullAnswers({ sensory: 'Yes' }), {}, ['diagnosis']);
  assert.equal(withYes.sensoryDetail, undefined);
  assert.ok(formErrors(form, fullAnswers({ county: 'Clayton' }), {}, ['service-area']).county, 'county comes from the list');
});

test('renters get the stop screen; homes far outside the area do only when Settings say to stop them', () => {
  const FAR = 'No, it is not within the boundary nor is it close.';
  assert.equal(stopFor(form, { ownership: 'No, the property is rented.' }).key, 'rental');
  assert.equal(stopFor(form, { boundary: FAR }), null, 'built in: families far out are told, and can still apply');
  assert.equal(stopFor(form, { boundary: 'No, but it is close to the boundary.' }), null);
  const stopping = applicationForm({ year: YEAR, definition: { ...DEFAULT_DEFINITION, serviceArea: { ...DEFAULT_DEFINITION.serviceArea, beyond: 'stop' } } });
  assert.equal(stopFor(stopping, { boundary: FAR }).key, 'outside');
  assert.equal(stopFor(stopping, { boundary: 'No, but it is close to the boundary.' }), null, 'close is never stopped');
});

test('a complete application has no errors; formats are checked', () => {
  const files = { ...Object.fromEntries(PHOTOS.map(f => [f, { key: 'k' }])), video: { uid: 'v', uploaded: true } };
  assert.deepEqual(formErrors(form, fullAnswers(), files), {});
  const bad = formErrors(form, fullAnswers({ parentEmail: 'nope', parentPhone: '123', makeoverTypes: ['Accessible Bathroom', 'Dream Bedroom', 'Ramp'], birthdate: '2099-01-01' }), files);
  assert.ok(bad.parentEmail && bad.parentPhone && bad.makeoverTypes && bad.birthdate);
  assert.match(formErrors(form, fullAnswers(), { ...files, video: { uid: 'v', uploaded: false } }).video, /still uploading/);
  assert.match(formErrors(form, fullAnswers(), { video: { uid: 'v', uploaded: true } }).photoChild, /add a photo/);
});

test('cleanAnswers keeps only known questions and caps their length', () => {
  const out = cleanAnswers(form, { childName: { first: ' Avery ', last: 'Stone', extra: 'x' }, interests: 'x'.repeat(10000), hacker: 'drop me', makeoverTypes: ['Ramp', 'Pool'] });
  assert.deepEqual(out.childName, { first: 'Avery', last: 'Stone' });
  assert.equal(out.interests.length, 6000);
  assert.equal(out.hacker, undefined);
  assert.deepEqual(out.makeoverTypes, ['Ramp']);
  assert.equal(toE164('(404) 555-0100'), '+14045550100');
});

// ── JobTread mapping ────────────────────────────────────────────────

test('the account carries every field the Zap used to fill', () => {
  const f = accountFields({ id: 'app-x', year: YEAR, answers: fullAnswers() });
  assert.equal(f[JT_FIELDS.status], 'Applied');
  assert.equal(f[JT_FIELDS.diagnosis], 'Spina bifida');
  assert.equal(f[JT_FIELDS.birthday], `${Number(YEAR) - 9}-05-01`);
  assert.equal(f[JT_FIELDS.verbal], 'Yes');
  assert.equal(f[JT_FIELDS.mobile], 'No');
  assert.equal(f[JT_FIELDS.makeoverYear], '2027');
  assert.deepEqual(f[JT_FIELDS.makeoverType], ['Bathroom', 'Bedroom']);
  assert.equal(f[JT_FIELDS.applicationUrl], applicationUrl('app-x'));
  const contacts = contactInputs({ answers: fullAnswers() });
  assert.equal(contacts.length, 2);
  assert.deepEqual(contacts[0], { name: 'Jordan Stone', title: 'Mother', customFieldValues: { [JT_FIELDS.contactEmail]: 'mom@example.com', [JT_FIELDS.contactPhone]: '+14045550100' } });
});

// ── Submit → JobTread ───────────────────────────────────────────────

test('submit loads everything into JobTread; the video follows once Stream is done', async () => {
  const draft = await readyDraft();
  const sub = await submitDraft(env, draft);
  assert.equal(sub.ok, true);
  const first = await run(sub.id);
  assert.equal(first.status, 'waiting', 'waiting on the video');

  const [acct] = Object.values(w.world.accounts);
  assert.equal(acct.name, 'Avery Stone');
  assert.equal(acct.org, ORG);
  assert.equal(acct.fields[JT_FIELDS.status], 'Applied');
  assert.deepEqual(acct.contacts.map(c => [c.name, c.title]), [['Jordan Stone', 'Mother'], ['Sam Stone', 'Father']]);
  assert.equal(acct.primaryContactId, acct.contacts[0].id);
  assert.equal(acct.locations[0].address, '1 Test Way, Marietta, GA 30067');
  assert.equal(acct.locations[0].customFieldValues[JT_FIELDS.county], 'Cobb');
  assert.deepEqual(acct.files.map(f => f.name).sort(), ['Avery Stone Family.jpg', 'Avery Stone Space 1.jpg', 'Avery Stone Space 2.jpg', 'Avery Stone.jpg', 'Avery Stone_Application.pdf']);

  // The family's confirmation is the JobTread "Application Status" message, with the PDF
  const welcome = acct.comments.find(c => c.name === 'Application Status');
  // Both parents from the form get the welcome
  assert.deepEqual(welcome.assignees, [{ name: 'Jordan Stone', emailAddress: 'mom@example.com', accountType: 'customer' }, { name: 'Sam Stone', emailAddress: 'dad@example.com', accountType: 'customer' }]);
  assert.equal(welcome.files.length, 1);
  assert.equal(welcome.files[0].name, 'Avery Stone_Application.pdf');
  assert.match(welcome.message, /^Jordan and Sam Stone\n\nThe application for \*Avery Stone\* is under review\./);
  assert.match(welcome.message, /copy of your application is attached/);
  const medical = acct.comments.find(c => c.name === "Child's Medical Condition");
  assert.equal(medical.internal, true);
  assert.match(medical.message, /^\*Diagnosis\*: Spina bifida\n\n\*Summary:\* A plain summary\.\n\n\*Description:\* A longer description\.$/);
  // Staff heads-up, by email and in Slack (Slack never gets the diagnosis or contact details)
  assert.equal(w.world.emails.length, 1);
  assert.deepEqual(w.world.emails[0].to, ['selection@soardcharity.com']);
  assert.match(w.world.emails[0].subject, /New makeover application: Avery/);
  assert.match(w.world.emails[0].html, new RegExp(`href="https://sunshineonaranneyday\\.com/admin/#applications/applicants/${acct.id}"[^>]*>Open in Applicants<`));
  assert.match(w.world.emails[0].html, new RegExp(`href="https://app\\.jobtread\\.com/customers/${acct.id}"[^>]*>Open in JobTread<`));
  assert.match(w.world.emails[0].html, />Spina bifida</, 'staff email carries the diagnosis (Slack never does)');
  assert.equal(w.world.slack.length, 1);
  const post = JSON.stringify(w.world.slack[0]);
  assert.match(w.world.slack[0].text, /^📝 New application: Avery, age \d+\nAccessible Bathroom and Dream Bedroom · /, 'the phone notification: who and what, no link');
  const card = renderSlack(w.world.slack[0]);
  for (const fact of ['Applied before: No', 'Sent: a video and ', 'Diagnosis and contact details stay in the application.']) assert.ok(card.includes(fact), `${fact}\n${card}`);
  const facts = w.world.slack[0].blocks.find((b) => b.type === 'section' && /^\*Service area:\* /.test(b.text?.text || ''));
  assert.ok(facts && !w.world.slack[0].blocks.some((b) => b.fields), 'one line per fact, never Slack’s two-column fields (they stack in a thread or on a phone)');
  assert.match(card, /\nService area: /);
  assert.deepEqual(slackButtons(w.world.slack[0]), [
    { label: 'Open the application', url: `https://sunshineonaranneyday.com/admin/#applications/${sub.id}` },
    { label: 'Open in JobTread', url: `https://app.jobtread.com/customers/${acct.id}` },
  ]);
  assert.doesNotMatch(post, /Spina bifida|mom@example\.com/);

  // Not ready yet: nothing more happens
  const app = await getApplication(env.DB, sub.id);
  assert.equal(app.jt_account_id, acct.id);
  w.advanceVideo('vid1', 'ready');
  assert.equal((await run(sub.id, Date.now() + 3 * 60 * 1000)).status, 'waiting', 'Stream still making the MP4');
  w.advanceVideo('vid1', 'mp4');
  assert.equal((await run(sub.id, Date.now() + 6 * 60 * 1000)).status, 'done');
  const mp4 = acct.files.find(f => f.name === 'Avery Stone_Application.mp4');
  assert.equal(mp4.fromUrl, 'https://customer-x.cloudflarestream.com/signed-vid1/downloads/default.mp4', 'signed URL, not the raw uid');
  assert.equal(w.world.streamMeta.vid1.application, sub.id);

  // Nothing was made twice
  assert.equal(Object.keys(w.world.accounts).length, 1);
  assert.equal(acct.comments.filter(c => c.name === 'Application Status').length, 1);
  assert.equal(w.world.emails.length, 1);
  assert.equal(w.world.slack.length, 1);
  const done = (await listApplications(env.DB)).applications[0].checklist;
  assert.equal(done.staffEmail, true);
  assert.equal(done.staffSlack, true);
});

test('a Slack or email outage holds up neither heads-up, and only the one that failed is retried', async () => {
  const sub = await submitDraft(env, await readyDraft(fullAnswers(), { video: 'ready' }));
  w.world.slackDown = true;
  const first = await run(sub.id);
  assert.equal(first.status, 'error');
  assert.match(first.error, /^staff heads-up: Slack: invalid_token/);
  assert.equal(w.world.emails.length, 1, 'the email still went');
  assert.equal(w.world.slack.length, 0);

  w.world.slackDown = false;
  w.world.emailDown = true; // must not matter: the email is already done
  assert.equal((await run(sub.id, Date.now() + 10 * 60 * 1000)).status, 'done');
  assert.equal(w.world.emails.length, 1, 'no second email');
  assert.equal(w.world.slack.length, 1);

  const other = await submitDraft(env, await readyDraft(fullAnswers({ childName: { first: 'Blake', last: 'Stone' } }), { video: 'ready' }));
  const failed = await run(other.id);
  assert.match(failed.error, /^staff heads-up: email: Resend 500/);
  assert.equal(w.world.slack.length, 2, 'Slack still posted');
  w.world.emailDown = false;
  assert.equal((await run(other.id, Date.now() + 10 * 60 * 1000)).status, 'done');
  assert.equal(w.world.emails.filter(e => /Blake/.test(e.subject)).length, 1);
  assert.equal(w.world.slack.length, 2, 'no second Slack post');
});

test('without a Slack webhook the heads-up is email only, and the checklist says so', async () => {
  delete env.SLACK_WEBHOOK_URL;
  const sub = await submitDraft(env, await readyDraft(fullAnswers(), { video: 'ready' }));
  assert.equal((await run(sub.id)).status, 'done');
  assert.equal(w.world.emails.length, 1);
  assert.equal(w.world.slack.length, 0);
  assert.equal((await listApplications(env.DB)).applications[0].checklist.staffSlack, 'none');
});

test('a failed step is retried without duplicating anything', async () => {
  const sub = await submitDraft(env, await readyDraft(fullAnswers(), { video: 'ready' }));
  w.failNext.set('createContact', 1);
  const first = await run(sub.id);
  assert.equal(first.status, 'error');
  assert.match(first.error, /^contacts:/);
  const row = await getApplication(env.DB, sub.id);
  assert.equal(row.attempts, 1);
  assert.ok(row.next_try_at > Date.now());
  assert.equal((await run(sub.id, Date.now() + 10 * 60 * 1000)).status, 'done');
  const [acct] = Object.values(w.world.accounts);
  assert.equal(Object.keys(w.world.accounts).length, 1);
  assert.equal(acct.contacts.length, 2);
  assert.equal(acct.files.length, 6, 'PDF, four photos, video');
});

test('an account whose create response was lost is found again, not made twice', async () => {
  const sub = await submitDraft(env, await readyDraft(fullAnswers(), { video: 'ready' }));
  w.loseNext.add('createAccount');
  assert.equal((await run(sub.id)).status, 'error');
  assert.equal((await run(sub.id, Date.now() + 10 * 60 * 1000)).status, 'done');
  assert.equal(Object.keys(w.world.accounts).length, 1);
  assert.equal((await getApplication(env.DB, sub.id)).jt_state.account.adopted, true);
});

test('two overlapping runs: the second backs off', async () => {
  const sub = await submitDraft(env, await readyDraft(fullAnswers(), { video: 'ready' }));
  const [a, b] = await Promise.all([run(sub.id), run(sub.id)]);
  assert.ok([a.status, b.status].includes('busy'));
  assert.equal(Object.keys(w.world.accounts).length, 1);
});

test('submitting twice gives the same application; stops and gaps are refused', async () => {
  const draft = await readyDraft();
  const one = await submitDraft(env, draft);
  const two = await submitDraft(env, await getDraft(env.DB, draft.id));
  assert.equal(two.id, one.id);
  assert.equal(two.duplicate, true);

  const renter = await readyDraft(fullAnswers({ ownership: 'No, the property is rented.' }));
  assert.deepEqual(await submitDraft(env, renter), { ok: false, error: 'stopped', stop: 'rental' });
  const noVideo = await readyDraft(fullAnswers(), { video: false });
  assert.ok((await submitDraft(env, noVideo)).errors.video);
});

test('a sample application goes only to whoever sent it, is marked TEST, and archives itself', async () => {
  const made = await createTestApplication(env, { email: 'linzi@soardcharity.com', year: YEAR });
  assert.equal(made.ok, true);
  assert.equal((await run(made.id)).status, 'done');
  const [acct] = Object.values(w.world.accounts);
  assert.equal(acct.name, 'TEST Applicant');
  // The sender gets what a family gets (the welcome, through JobTread) and what staff get (the heads-up)
  assert.deepEqual(acct.comments.find(c => c.name === 'Application Status').assignees.map(a => a.emailAddress), ['linzi@soardcharity.com']);
  assert.deepEqual(w.world.emails.map(e => e.to), [['linzi@soardcharity.com']]);
  assert.match(w.world.emails[0].html, /Test application · not a real family/);
  assert.ok(acct.archivedAt, 'no TEST account left on the board to clean up');
  assert.match(w.world.slack[0].text, /^🧪 Test · 📝 New application: TEST/);
  assert.match(renderSlack(w.world.slack[0]), /^📝 New application: TEST, age \d+\n🧪 \*Test application · not a real family\*\n/);
  const list = await listApplications(env.DB);
  assert.equal(list.applications[0].isTest, true);
  assert.equal(list.applications[0].checklist.familyMessage, true);
  assert.equal(list.applications[0].checklist.video, 'none');
});

test('a stuck application alerts Peter once per new problem', async () => {
  const sub = await submitDraft(env, await readyDraft(fullAnswers(), { video: 'ready' }));
  let t = Date.now();
  for (let i = 0; i < 6; i++) {
    w.failNext.set('createAccount', 1);
    t += 7 * 3600 * 1000;
    await run(sub.id, t);
  }
  const alerts = w.world.emails.filter(e => /is stuck/.test(e.subject));
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].to, ['peter@soardcharity.com']);
  const posts = w.world.slack.filter(p => /Stuck: /.test(p.text));
  assert.equal(posts.length, 1, 'and once in Slack');
  assert.match(posts[0].text, /^⚠️ Stuck: Avery Stone’s application\nThe website couldn’t finish loading it into JobTread after 4 tries\.$/);
  assert.match(renderSlack(posts[0]), /\*What to do\*\nNothing, usually: it keeps retrying on its own/);
});

test('in the Slack app, a stuck application is one thread that turns ✅ when it gets through on its own', async () => {
  env.SLACK_BOT_TOKEN = 'xoxb-test';
  delete env.SLACK_WEBHOOK_URL;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)').run();
  await writeSlackConfig(env.DB, { channel: { id: 'C0ALERTS', name: 'website-alerts' } });
  const sub = await submitDraft(env, await readyDraft(fullAnswers(), { video: 'ready' }));
  let t = Date.now();
  for (let i = 0; i < 4; i++) {
    w.failNext.set('createAccount', 1);
    t += 7 * 3600 * 1000;
    await run(sub.id, t);
  }
  const stuck = w.world.slack.filter(p => /Stuck: /.test(p.text));
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].thread_ts, undefined, 'the first report is its own post');
  const ts = `${w.world.slack.indexOf(stuck[0]) + 1}.0001`;
  // Then it gets through
  t += 7 * 3600 * 1000;
  await run(sub.id, t);
  const edit = (w.world.slackEdits || []).find(e => e.ts === ts);
  assert.ok(edit, 'the stuck post was edited');
  assert.equal(renderSlack(edit), '✅ Resolved: Avery Stone’s application was stuck\nIt got through on its own.', 'a short ✅, never a copy of the reply');
  const reply = w.world.slack.filter(p => p.thread_ts === ts).at(-1);
  assert.equal(reply.reply_broadcast, true);
  assert.match(reply.text, /^✅ Unstuck/);
  const app = await getApplication(env.DB, sub.id);
  assert.equal(app.jt_state.stuckSlack, undefined, 'forgotten once it cleared');
});

test('the sweep runs at most every two minutes and clears old drafts with their files', async () => {
  const sub = await submitDraft(env, await readyDraft(fullAnswers(), { video: 'ready' }));
  const t0 = Date.now();
  const first = await maybeSweepApplications(env, { fetchImpl: w.fetchImpl, now: t0 });
  assert.equal(first.processed[0].id, sub.id);
  assert.equal(await maybeSweepApplications(env, { fetchImpl: w.fetchImpl, now: t0 + 30 * 1000 }), null);

  const stale = await readyDraft();
  const later = Date.now() + (DRAFT_TTL_DAYS + 1) * 24 * 3600 * 1000;
  assert.equal(await expireDrafts(env, { now: later, fetchImpl: w.fetchImpl }), 1);
  assert.equal(await getDraft(env.DB, stale.id), null);
  assert.equal(w.env.FILES.objects.has(photoKey(stale.id, 'photoChild')), false);
  assert.deepEqual(w.world.deletedVideos, ['vid1']);
  assert.ok(await getApplication(env.DB, sub.id), 'submitted applications are never cleared');
});

// ── PDF ─────────────────────────────────────────────────────────────

test('the PDF builds with photos, long answers and characters Helvetica lacks', async () => {
  const answers = fullAnswers({ interests: 'Loves 🦖 dinosaurs, señor Rex and https://example.com/' + 'x'.repeat(200) + '\n\nAnd music.'.repeat(30) });
  const files = Object.fromEntries(PHOTOS.map(f => [f, { key: 'k', thumbKey: 't' }]));
  files.video = { uid: 'v', uploaded: true };
  const bytes = await buildApplicationPdf({ form, answers, files, submittedAt: '2026-10-19T15:00:00Z', photos: Object.fromEntries(PHOTOS.map(f => [f, TEST_JPEG])) });
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  assert.ok(bytes.byteLength > 3000);
  const sections = answerSections(form, answers, files);
  assert.ok(sections.find(s => s.id === 'basic').items.some(i => i.text === 'Avery Stone'));
});

// ── The public endpoint ─────────────────────────────────────────────

function ctx(body, { method = 'POST', headers = {} } = {}) {
  const waits = [];
  const request = new Request('https://sunshineonaranneyday.com/api/apply', {
    method, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', origin: 'https://sunshineonaranneyday.com', ...headers },
    body: method === 'POST' ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
  });
  if (body instanceof FormData) request.headers.delete('content-type');
  return { env, request: body instanceof FormData ? new Request(request.url, { method: 'POST', body, headers: { 'CF-Connecting-IP': '1.2.3.4' } }) : request, waitUntil: (p) => waits.push(p), waits, data: {} };
}
const call = async (body) => { const c = ctx(body); const res = await applyApi.onRequestPost(c); await Promise.all(c.waits); return { status: res.status, body: await res.json() }; };

async function openApplications(open = true) {
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`);
  await env.DB.prepare("INSERT OR REPLACE INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ application: { open, year: YEAR } })).run();
}

test('start is refused while applications are closed; the honeypot gets a dud token', async () => {
  await openApplications(false);
  assert.equal((await call({ action: 'start', year: YEAR })).status, 403);
  await openApplications(true);
  const bot = await call({ action: 'start', year: YEAR, website: 'spam.biz' });
  assert.equal(bot.body.token, '0'.repeat(32));
  assert.equal((await call({ action: 'resume', token: bot.body.token })).status, 404);
});

test('Turnstile is enforced once both keys are set', async () => {
  await openApplications(true);
  env.TURNSTILE_SITE_KEY = 'site';
  env.TURNSTILE_SECRET_KEY = 'secret';
  w.world.turnstile = false;
  assert.equal((await call({ action: 'start', year: YEAR, turnstileToken: 'bad' })).body.code, 'turnstile');
  w.world.turnstile = true;
  assert.equal((await call({ action: 'start', year: YEAR, turnstileToken: 'good' })).status, 200);
});

test('the whole flow over HTTP: start, save, photo, video, resume, submit', async () => {
  await openApplications(true);
  const { body: { token } } = await call({ action: 'start', year: YEAR });
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal((await call({ action: 'save', token, answers: fullAnswers(), page: 'finish' })).status, 200);
  for (const field of PHOTOS) {
    const fd = new FormData();
    fd.append('token', token);
    fd.append('field', field);
    fd.append('file', new File([TEST_JPEG], 'IMG_0001.jpg', { type: 'image/jpeg' }));
    fd.append('thumb', new File([TEST_JPEG], 'thumb.jpg', { type: 'image/jpeg' }));
    const c = ctx(fd);
    const res = await applyApi.onRequestPost(c);
    assert.equal(res.status, 200, field);
  }
  const v = await call({ action: 'video-url', token, size: 5_000_000, name: 'clip.mov' });
  assert.match(v.body.uploadUrl, /^https:\/\/upload\.fake\/tus\//);
  const uid = Object.keys(w.world.videos)[0];
  assert.match(w.world.videos[uid].meta, /requiresignedurls/);
  assert.equal((await call({ action: 'video-done', token })).body.uploaded, false, 'tus not finished yet');
  w.advanceVideo(uid, 'uploaded');
  assert.equal((await call({ action: 'video-done', token })).body.uploaded, true);

  const resumed = (await call({ action: 'resume', token })).body;
  assert.equal(resumed.answers.childName.first, 'Avery');
  assert.deepEqual(resumed.files.video, { uploaded: true, name: 'clip.mov', size: 5_000_000 });
  assert.equal(JSON.stringify(resumed).includes(uid), false, 'never hands out the Stream id');
  assert.equal(JSON.stringify(resumed).includes('applications/'), false, 'never hands out R2 keys');

  const sub = await call({ action: 'submit', token });
  assert.equal(sub.status, 200);
  assert.ok(Object.values(w.world.accounts)[0], 'loaded into JobTread right away');
  assert.equal((await call({ action: 'save', token, answers: {} })).body.code, 'submitted');
  assert.equal((await call({ action: 'submit', token })).body.id, sub.body.id);
});

test('a replaced video deletes the old one; uploads need a real photo type', async () => {
  await openApplications(true);
  const { body: { token } } = await call({ action: 'start', year: YEAR });
  await call({ action: 'video-url', token, size: 10, name: 'a.mov' });
  const firstUid = Object.keys(w.world.videos)[0];
  await call({ action: 'video-url', token, size: 10, name: 'b.mov' });
  assert.deepEqual(w.world.deletedVideos, [firstUid]);
  const fd = new FormData();
  fd.append('token', token);
  fd.append('field', 'photoChild');
  fd.append('file', new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }));
  const res = await applyApi.onRequestPost(ctx(fd));
  assert.equal(res.status, 400);
});

// ── Applicant messages (the Zap replacement) ────────────────────────

/** An account made by hand or in the Zap era */
function seedAccount({ status = 'Applied', diagnosis = 'Autism', comments = [], createdAt = new Date().toISOString() } = {}) {
  const id = 'acctZAP00001';
  w.world.accounts[id] = {
    id, name: 'Riley Park', type: 'customer', org: ORG, createdAt,
    fields: { [JT_FIELDS.status]: status, [JT_FIELDS.diagnosis]: diagnosis },
    contacts: [{ id: 'ctcP', name: 'Morgan Park', fields: { [JT_FIELDS.contactEmail]: 'morgan@example.com' } }],
    primaryContactId: 'ctcP', locations: [], files: [], comments: comments.map((c, i) => ({ id: `old${i}`, ...c })),
  };
  return w.world.accounts[id];
}
// Status emails wait for the status to settle (./_applicant-notify.js), so these
// run on a fixed clock: 11 AM Eastern, well clear of quiet hours
const T0 = Date.parse('2026-10-21T15:00:00Z');
const MIN = 60 * 1000;
/**
 * JobTread logs the change, then its workflow wakes the site with the event's
 * id. The site reads the status before the change from that event (never the
 * body), so each call logs the event the payload describes: a new account
 * (previousStatus "null", no nextStatus), a Status move, or a Diagnosis edit
 * (nextStatus "null").
 */
let hookSeq = 0;
const hook = (payload, now = T0) => {
  const status = (s) => (s == null || s === 'null' ? null : s);
  const next = payload.nextStatus !== undefined ? status(payload.nextStatus) : status(payload.status);
  const created = payload.previousStatus === 'null' && payload.nextStatus === undefined;
  const id = `evtZAP${String(++hookSeq).padStart(6, '0')}`;
  w.world.events.push({
    id, createdAt: new Date(now).toISOString(), type: created ? 'accountCreated' : 'accountUpdated',
    createdByGrantId: 'g1', createdByGrantName: 'JobTread App', createdByUser: { name: 'Linzi Berkowitz', emailAddress: 'linzi@example.com' },
    data: next == null ? { next: { custom: { Diagnosis: 'Autism' } }, previous: { custom: { Diagnosis: null } } }
      : created ? { next: { custom: { Status: next } }, previous: null }
      : { next: { custom: { Status: next } }, previous: { custom: { Status: status(payload.previousStatus) } } },
    account: { id: 'acctZAP00001', type: 'customer' },
  });
  return handleWorkflowCall(env, { accountId: 'acctZAP00001', eventId: id }, { fetchImpl: w.fetchImpl, now });
};
/** The sweep at a few points in time (the summary goes ~4 min in, emails after the wait) */
const tick = async (...times) => { for (const t of times) await runNotifications(env, { fetchImpl: w.fetchImpl, now: t }); };

test('a hand-made Applied account: the medical note now, the welcome once the status settles', async () => {
  env.JOBTREAD_QC_GRANT_KEY = 'qc-grant';
  const acct = seedAccount();
  const r = await hook({ previousStatus: 'null', status: 'Applied' });
  assert.equal(r.actions.medical, 'sent');
  assert.match(r.actions.welcome, /^scheduled/);
  assert.deepEqual(acct.comments.map(c => c.name), ["Child's Medical Condition"], 'no welcome yet');
  await tick(T0 + 4 * MIN, T0 + 10 * MIN);
  const welcome = acct.comments.find(c => c.name === 'Application Status');
  assert.equal(welcome.grantKey, 'qc-grant');
  assert.equal(welcome.message, renderMessage(DEFAULT_MESSAGES.welcome, { parent: 'Morgan Park', child: 'Riley Park' }));
  await hook({ previousStatus: 'Applied', status: 'Applied' }, T0 + 11 * MIN);
  await tick(T0 + 60 * MIN);
  assert.equal(acct.comments.length, 2, 'never twice');
});

test('status emails go once the status settles; a flip-flop sends one email or none', async () => {
  const acct = seedAccount({ status: 'In Review', comments: [{ name: 'Application Status', message: 'old' }, { name: "Child's Medical Condition", message: 'old' }] });
  const set = (s) => { acct.fields[JT_FIELDS.status] = s; };
  const reviews = () => acct.comments.filter(c => c.name === 'Application In Review');
  const decisions = () => acct.comments.filter(c => c.name === 'Application Decision');
  const r = await hook({ previousStatus: 'Applied', status: 'In Review' });
  assert.deepEqual(Object.keys(r.actions).sort(), ['inReview', 'medical']);
  assert.equal(reviews().length, 0, 'nothing goes straight away');
  await tick(T0 + 4 * MIN, T0 + 9 * MIN);
  assert.equal(reviews().length, 0, 'still inside the 10 minutes');
  await tick(T0 + 10 * MIN);
  assert.equal(reviews().length, 1);
  assert.equal(reviews()[0].assignees[0].emailAddress, 'morgan@example.com');
  assert.match(reviews()[0].message, /^Morgan Park\n\nCongratulations, the application for \*Riley Park\* has moved to the next stage/);
  await hook({ previousStatus: 'Applied', status: 'In Review' }, T0 + 11 * MIN); // JobTread retried the webhook
  await tick(T0 + 30 * MIN);
  assert.equal(reviews().length, 1);

  // An accident: Denied, then straight back to In Review. Nothing is sent.
  set('Denied');
  assert.match((await hook({ previousStatus: 'In Review', status: 'Denied' }, T0 + 40 * MIN)).actions.denied, /^scheduled/);
  set('In Review');
  assert.equal((await hook({ previousStatus: 'Denied', status: 'In Review' }, T0 + 41 * MIN)).actions.cancelled, 'denied');
  await tick(T0 + 45 * MIN, T0 + 80 * MIN, T0 + 200 * MIN);
  assert.equal(decisions().length, 0);
  assert.equal(reviews().length, 1, 'and In Review is not sent again');

  // Back below what the family was told: one staff note once it settles
  set('Applied');
  await hook({ previousStatus: 'In Review', status: 'Applied' }, T0 + 210 * MIN);
  await tick(T0 + 215 * MIN);
  assert.ok(!acct.comments.some(c => /^Moved back/.test(c.message)), 'not before it settles');
  await tick(T0 + 221 * MIN);
  const note = acct.comments.at(-1);
  assert.match(note.message, /^Moved back to Applied\. The family was emailed the In Review message on/);
  assert.equal(note.internal, true);

  // A decision waits 30 minutes
  set('Approved');
  await hook({ previousStatus: 'Applied', status: 'Approved' }, T0 + 230 * MIN);
  await tick(T0 + 234 * MIN, T0 + 250 * MIN);
  assert.equal(decisions().length, 0);
  await tick(T0 + 261 * MIN);
  assert.equal(decisions().length, 1);
  assert.match(decisions()[0].message, /has been approved!\n\nYour child's makeover is now on our official makeover waitlist/);
});

test('family emails never go out overnight: a change at 11 PM goes at 8 AM Eastern', async () => {
  const acct = seedAccount({ status: 'In Review', comments: [{ name: 'Application Status', message: 'old' }] });
  const night = Date.parse('2026-10-21T03:00:00Z'); // 11 PM EDT on Oct 20
  await hook({ previousStatus: 'Applied', status: 'In Review' }, night);
  await tick(night + 5 * MIN, night + 30 * MIN, Date.parse('2026-10-21T11:59:00Z'));
  assert.equal(acct.comments.filter(c => c.name === 'Application In Review').length, 0);
  await tick(Date.parse('2026-10-21T12:01:00Z')); // 8:01 AM EDT
  assert.equal(acct.comments.filter(c => c.name === 'Application In Review').length, 1);
});

test('a Diagnosis edit never sends a status message', async () => {
  const acct = seedAccount({ status: 'In Review', comments: [{ name: 'Application Status', message: 'old' }] });
  const r = await hook({ previousStatus: 'null', nextStatus: 'null', status: 'In Review' });
  assert.equal(r.actions.inReview, undefined);
  assert.equal(acct.comments.filter(c => c.name === 'Application In Review').length, 0);
  assert.equal(r.actions.medical, 'sent', 'the medical note is what a Diagnosis edit is for');
});

test('a decision already sent in the Zap era is not sent again', async () => {
  const acct = seedAccount({ status: 'Denied', createdAt: '2026-01-10T12:00:00Z', comments: [{ name: 'Application Decision', message: 'Pat\n\nAfter careful consideration of the application for *Riley* we are unable to move forward with your family’s request.' }] });
  const before = acct.comments.length;
  const r = await hook({ previousStatus: 'In Review', status: 'Denied' });
  assert.equal(r.actions.denied, undefined, 'the family already knows');
  await tick(T0 + 5 * MIN, T0 + 60 * MIN);
  assert.equal(acct.comments.length, before, 'and no after-the-fact medical note on a Zap-era account');
  acct.fields[JT_FIELDS.status] = 'Applied';
  await hook({ previousStatus: 'Denied', status: 'Applied' }, T0 + 70 * MIN);
  await tick(T0 + 81 * MIN);
  assert.deepEqual(acct.comments.slice(before).map(c => c.message), ['Moved back to Applied.'], 'no welcome for an old account moved back, just the staff note');
});

test("accounts the form made are left to the form's own intake", async () => {
  const sub = await submitDraft(env, await readyDraft(fullAnswers(), { video: 'ready' }));
  await run(sub.id);
  const [acct] = Object.values(w.world.accounts);
  const before = acct.comments.length;
  const r = await handleWorkflowCall(env, { accountId: acct.id, previousStatus: 'null', status: 'Applied' }, { fetchImpl: w.fetchImpl, now: T0 });
  assert.deepEqual(r.actions, {});
  await tick(T0 + 5 * MIN, T0 + 60 * MIN);
  assert.equal(acct.comments.length, before);
});

test('no QC key yet: messages fall back to the site grant; a vendor account is ignored', async () => {
  const acct = seedAccount();
  await hook({ previousStatus: 'null', status: 'Applied' });
  assert.equal(acct.comments[0].grantKey, 'site-grant');
  acct.type = 'vendor';
  assert.equal((await hook({})).actions.skipped, 'not a SOARD customer account');
  assert.equal((await handleApplicantEvent(env, { accountId: 'x' }, { fetchImpl: w.fetchImpl })).error, 'bad accountId');
});

test("the model down: a hand-made applicant still gets a note in the family's own words", async () => {
  env.AI.available = false;
  const acct = seedAccount();
  const r = await hook({ previousStatus: 'null', status: 'Applied' });
  assert.match(r.actions.welcome, /^scheduled/);
  assert.equal(r.actions.medical, 'sent');
  const note = acct.comments.find(c => c.name === "Child's Medical Condition");
  assert.equal(note.internal, true);
  assert.match(note.message, /^\*Diagnosis\*: Autism\n\n_No plain-language summary this time \(the model failed \(AI unavailable\)\)\. Please look the condition up before meeting the family\._$/);
  env.AI.available = true;
  acct.fields[JT_FIELDS.diagnosis] = 'Autism, epilepsy';
  assert.equal((await hook({ previousStatus: 'Applied', status: 'Applied' }, T0 + MIN)).actions.medical, 'already', 'one note per family');
  assert.equal(QC_USER_ID, '22P5r2x8FPiK');
});

test('the model answers loosely (line breaks and quotes inside its JSON): the note is still read', async () => {
  env.AI.run = async (model, input) => {
    assert.deepEqual(input.response_format?.type, 'json_schema', 'JSON mode first');
    return { response: 'Here you go:\n{"summary": "A condition of the brain.\nIt affects movement.", "description": "Children may need "extra" support."}' };
  };
  const acct = seedAccount();
  assert.equal((await hook({ previousStatus: 'null', status: 'Applied' })).actions.medical, 'sent');
  const note = acct.comments.find(c => c.name === "Child's Medical Condition");
  assert.match(note.message, /^\*Diagnosis\*: Autism\n\n\*Summary:\* A condition of the brain\.\nIt affects movement\.\n\n\*Description:\* Children may need "extra" support\.$/);
});

test('JSON mode hands back an object: read as is', async () => {
  env.AI.run = async () => ({ response: { summary: 'Plain words.', description: 'More words.' } });
  const acct = seedAccount();
  await hook({ previousStatus: 'null', status: 'Applied' });
  assert.match(acct.comments.find(c => c.name === "Child's Medical Condition").message, /\*Summary:\* Plain words\.\n\n\*Description:\* More words\.$/);
});

test('a form application retries the medical note, then posts the diagnosis on the last try', async () => {
  env.AI.available = false;
  const sub = await submitDraft(env, await readyDraft(fullAnswers(), { video: 'ready' }));
  const t = Date.parse('2026-10-21T15:00:00Z');
  await run(sub.id, t);
  const [acct] = Object.values(w.world.accounts);
  const notes = () => acct.comments.filter(c => c.name === "Child's Medical Condition");
  assert.equal(notes().length, 0, 'not on the first try');
  assert.ok(acct.comments.some(c => c.name === 'Application Status'), 'the welcome does not wait for it');
  assert.match((await getApplication(env.DB, sub.id)).jt_state.intake.medical, /^skipped: nothing to say \(the model failed \(AI unavailable\)\)$/, 'the admin sees why');
  for (let i = 1; i <= 3; i++) await run(sub.id, t + i * 5 * 60 * 1000);
  assert.equal(notes().length, 1, 'the last try posts the diagnosis');
  assert.match(notes()[0].message, /^\*Diagnosis\*: Spina bifida\n\n_No plain-language summary this time/);
  await run(sub.id, t + 30 * 60 * 1000);
  assert.equal(notes().length, 1);
});

test('the reminder email: their words, progress, one button, a way to stop, in their language', () => {
  const draft = { answers: { parentName: { first: 'Jordan' }, childName: { first: 'Avery' } }, lang: 'en' };
  const en = reminderEmail({ form, draft, link: 'https://example.org/apply/form/?resume=abc', stopLink: 'https://example.org/stop', percent: 62 });
  assert.match(en.html, /<html lang="en">/);
  assert.match(en.html, /Hi Jordan,/);
  assert.match(en.html, /application for Avery/);
  assert.match(en.html, /62% done/);
  assert.match(en.html, /width="62%"/, 'the progress bar');
  assert.match(en.html, /href="https:\/\/example\.org\/apply\/form\/\?resume=abc"[^>]*>Finish my application</);
  assert.match(en.html, /href="https:\/\/example\.org\/stop"[^>]*>Stop these reminders</);
  assert.match(en.text, /Finish my application: https:\/\/example\.org\/apply\/form\/\?resume=abc/);
  const esForm = { year: YEAR, reminders: { subject: 'Su solicitud de SOARD le está esperando', body: 'Hola, {parent}:\n\nYa completó aproximadamente el {percent}%.' } };
  const es = reminderEmail({ form: esForm, draft: { ...draft, lang: 'es' }, link: 'https://example.org/r', stopLink: 'https://example.org/s', percent: 35 });
  assert.match(es.html, /<html lang="es">/);
  assert.match(es.html, />Terminar mi solicitud</);
  assert.match(es.html, />No quiero más recordatorios</);
  assert.match(es.html, /Su solicitud está guardada/);
  assert.ok(!/—/.test(en.html + es.html), 'no em dashes');
});
