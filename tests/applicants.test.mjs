/**
 * Admin → Applications → Applicants (functions/api/_applicants.js): the D1
 * mirror of JobTread's applicant accounts, the history read from JobTread's
 * event log, and actions from the site that write to JobTread first
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from './lib/fake-applicant-world.mjs';
import {
  syncAllApplicants, refreshApplicants, syncEvents, backfillActivity, maybeSyncApplicants, listApplicants, getApplicantRow,
  activityFor, activityFromEvent, setApplicantStatus, previewStatus, updateApplicantFields, messageFamily, addNote, textFamily,
  archiveApplicant, applicantDetail, placeOnArea, replaceBoundary, fieldInput, adminName, FIELDS, syncState,
} from '../functions/api/_applicants.js';
import { handleWorkflowCall, runNotifications, notifyFor } from '../functions/api/_applicant-notify.js';
import { DEFAULT_SERVICE_AREA } from '../functions/api/_application-form.js';

const F = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.id]));
const EMAIL = '22NJw43QvHeJ';
const PHONE = '22NJw43UauSc';
const MARIETTA = { latitude: 33.9767, longitude: -84.5369 };   // inside the boundary
const DOWNTOWN = { latitude: 33.749, longitude: -84.388 };     // outside it

let w;
let env;

function addAccount({ name, type = 'customer', fields = {}, contact = null, home = null, comms = true, createdAt = '2026-10-01T12:00:00.000Z', jobs = [] }) {
  const id = `acct${String(Object.keys(w.world.accounts).length + 1).padStart(8, '0')}`;
  const a = { id, name, type, org: ORG, createdAt, fields, contacts: [], primaryContactId: null, locations: [], files: [], comments: [], jobs };
  if (contact) {
    a.contacts.push({ id: `${id}-c1`, name: contact.name, title: contact.title || 'Mom', fields: { [EMAIL]: contact.email, [PHONE]: contact.phone } });
    a.primaryContactId = `${id}-c1`;
  }
  if (home) a.locations.push({ id: `${id}-l1`, address: home.address || '1 Main St, Marietta, GA 30060', city: 'Marietta', county: 'Cobb County', ...home });
  if (comms) a.comments.push({ id: `${id}-comms`, name: 'Comms Thread', message: 'To send a text…', pinned: true, by: 'JobTread' });
  w.world.accounts[id] = a;
  return a;
}

beforeEach(async () => {
  w = fakeApplicantWorld();
  env = { ...w.env, DB: await createD1(), JOBTREAD_QC_GRANT_KEY: 'qc-grant' };
});

const opts = () => ({ fetchImpl: w.fetchImpl });
// Family emails follow the clock (waits, quiet hours): 11 AM Eastern
const T0 = Date.parse('2026-10-21T15:00:00Z');
const MIN = 60 * 1000;
const tick = async (...times) => { for (const t of times) await runNotifications(env, { fetchImpl: w.fetchImpl, now: t }); };

test('the mirror holds applicants only, with their fields, contact, home and map point', async () => {
  addAccount({ name: 'Avery Stone', fields: { [F.status]: 'Applied', [F.year]: '2027', [F.types]: ['Bedroom', 'Bathroom'], [F.diagnosis]: 'Spina bifida' }, contact: { name: 'Jordan Stone', email: 'jordan@example.com', phone: '+17705550100' }, home: MARIETTA });
  addAccount({ name: 'Downtown Kid', fields: { [F.status]: 'In Review', [F.year]: '2027' }, home: DOWNTOWN });
  addAccount({ name: 'Sunshine Office' });                       // no Status or year: not an applicant
  addAccount({ name: 'Home Depot', type: 'vendor', fields: { [F.status]: 'Applied' } });
  const out = await syncAllApplicants(env, opts());
  assert.equal(out.applicants, 2);
  const list = await listApplicants(env.DB);
  assert.deepEqual(list.map(a => a.name).sort(), ['Avery Stone', 'Downtown Kid']);
  const avery = list.find(a => a.name === 'Avery Stone');
  assert.equal(avery.status, 'Applied');
  assert.deepEqual(avery.types, ['Bedroom', 'Bathroom']);
  assert.equal(avery.fields.diagnosis, 'Spina bifida');
  assert.equal(avery.contact.email, 'jordan@example.com');
  assert.equal(avery.county, 'Cobb');
  assert.equal(avery.area, 'inside');
  assert.ok(avery.commsThreadId);
  const downtown = list.find(a => a.name === 'Downtown Kid');
  assert.equal(downtown.area, 'outside');
  assert.ok(downtown.areaMiles > 3 && downtown.areaMiles < 20, `miles ${downtown.areaMiles}`);
});

test('accounts deleted in JobTread, or no longer applicants, leave the mirror', async () => {
  const a = addAccount({ name: 'Gone Soon', fields: { [F.status]: 'Applied' } });
  const b = addAccount({ name: 'Cleared', fields: { [F.status]: 'Applied' } });
  await syncAllApplicants(env, opts());
  assert.equal((await listApplicants(env.DB)).length, 2);
  delete w.world.accounts[a.id];
  b.fields = {};
  await refreshApplicants(env, [a.id, b.id], opts());
  assert.equal((await listApplicants(env.DB)).length, 0);
});

test('history: JobTread events become readable rows; job chatter and bookkeeping are left out', () => {
  const acct = { id: 'A1', type: 'customer' };
  const status = activityFromEvent({ id: 'e1', createdAt: '2026-10-20T15:17:38Z', type: 'accountUpdated', createdByGrantId: 'g', createdByGrantName: 'JobTread App', createdByUser: { name: 'Linzi' }, data: { next: { custom: { Status: 'In Review' } }, previous: { custom: { Status: 'Applied' } } }, account: acct });
  assert.equal(status.kind, 'status');
  assert.equal(status.title, 'Status: In Review');
  assert.equal(status.body, 'Was Applied');
  assert.equal(status.by_name, 'Linzi');
  assert.equal(status.source, 'jobtread');
  const text = activityFromEvent({ id: 'e2', createdAt: '2026-10-20T15:52:28Z', type: 'commentCreated', createdByGrantId: 'g2', createdByGrantName: 'datax', createdByUser: { name: 'Peter' }, data: { next: { id: 'c', message: 'Company Number: +17709902434\n\nNew incoming _message_\nContact: Natalia\n\nMessage: Box looks good', targetType: 'account', jobId: null } }, account: acct });
  assert.equal(text.kind, 'textIn');
  assert.equal(text.source, 'datax');
  assert.ok(!/Company Number/.test(text.body));
  assert.equal(activityFromEvent({ id: 'e3', createdAt: 'x', type: 'commentCreated', data: { next: { message: 'job talk', jobId: 'J1', targetType: 'job' } }, account: acct }), null);
  assert.equal(activityFromEvent({ id: 'e4', createdAt: 'x', type: 'accountUpdated', data: { next: { custom: { 'Zap Table Record': 'x' } }, previous: { custom: {} } }, account: acct }), null);
  assert.equal(activityFromEvent({ id: 'e5', createdAt: 'x', type: 'accountUpdated', data: { next: { custom: { Status: 'Applied' } } }, account: { id: 'V', type: 'vendor' } }), null);
  const zap = activityFromEvent({ id: 'e6', createdAt: 'x', type: 'commentCreated', createdByGrantId: 'z', createdByGrantName: 'Zapier Integration', createdByUser: { name: 'Qualification Committee' }, data: { next: { name: 'Application In Review', message: 'hi', targetType: 'account' } }, account: acct });
  assert.equal(zap.source, 'zapier');
  const site = activityFromEvent({ id: 'e7', createdAt: 'x', type: 'fileCreated', createdByGrantId: '22PgGhFHkmbz', data: { next: { id: 'f', name: 'Avery_Application.pdf', jobId: null } }, account: acct });
  assert.equal(site.source, 'website');
  assert.equal(site.kind, 'file');
});

test('events since the cursor are stored once and refresh the accounts they touch', async () => {
  const a = addAccount({ name: 'Avery Stone', fields: { [F.status]: 'Applied', [F.year]: '2027' }, contact: { name: 'Jordan', email: 'j@example.com' } });
  await syncAllApplicants(env, opts());
  await syncEvents(env, opts());                       // first run: starts the cursor
  // Someone moves Avery in JobTread
  a.fields[F.status] = 'In Review';
  w.world.events.push({ id: 'evt-jt-1', createdAt: new Date(Date.now() + 1000).toISOString(), type: 'accountUpdated', createdByGrantId: 'app', createdByGrantName: 'JobTread App', createdByUser: { name: 'Linzi' }, data: { next: { custom: { Status: 'In Review' } }, previous: { custom: { Status: 'Applied' } } }, account: { id: a.id, type: 'customer' } });
  const out = await syncEvents(env, opts());
  assert.equal(out.stored, 1);
  assert.equal((await getApplicantRow(env.DB, a.id)).status, 'In Review');
  const again = await syncEvents(env, opts());
  assert.equal(again.stored, 0);
  const history = (await activityFor(env.DB, a.id)).filter(r => r.kind === 'status');
  assert.equal(history.length, 1);
  assert.equal(history[0].by, 'Linzi');
  assert.ok((await listApplicants(env.DB))[0].stageAt);
  // The workflow never called (here): the event log is the backup, so the family's email is still scheduled
  assert.equal((await notifyFor(env.DB, a.id)).kind, 'inReview');
});

test('the history backfill reads older events once, then stops', async () => {
  const a = addAccount({ name: 'Avery Stone', fields: { [F.status]: 'Approved' } });
  for (let i = 0; i < 230; i++) {
    w.world.events.push({ id: `old-${i}`, createdAt: new Date(Date.parse('2025-03-01T00:00:00Z') + i * 60000).toISOString(), type: 'commentCreated', createdByGrantId: 'app', createdByUser: { name: 'Staff' }, data: { next: { id: `c${i}`, message: `note ${i}`, targetType: 'account' } }, account: { id: a.id, type: 'customer' } });
  }
  await syncAllApplicants(env, opts());
  await syncEvents(env, opts());
  let step = await backfillActivity(env, { ...opts(), maxPages: 2 });
  assert.equal(step.done, false);
  step = await backfillActivity(env, { ...opts(), maxPages: 2 });
  assert.equal(step.done, true);
  assert.equal((await activityFor(env.DB, a.id, { limit: 500 })).length, 230);
  assert.equal((await backfillActivity(env, opts())).done, true);
  assert.equal((await syncState(env.DB)).historyDone, true);
});

test('status from the site: JobTread first; the family is emailed once it settles, exactly as from JobTread', async () => {
  const a = addAccount({ name: 'Avery Stone', fields: { [F.status]: 'Applied', [F.year]: '2027' }, contact: { name: 'Jordan Stone', email: 'jordan@example.com' } });
  await syncAllApplicants(env, opts());
  const preview = await previewStatus(env, a.id, 'In Review', opts());
  assert.equal(preview.forward, true);
  assert.equal(preview.message.title, 'Application In Review');
  assert.match(preview.message.message, /Jordan Stone/);
  assert.equal(preview.message.to.email, 'jordan@example.com');
  assert.ok(preview.sendAt > Date.now(), 'the sheet says when it goes');

  const out = await setApplicantStatus(env, a.id, 'In Review', { user: 'linzi@soardcharity.com', ...opts(), now: T0 });
  assert.equal(a.fields[F.status], 'In Review');
  assert.equal(out.email, 'scheduled');
  assert.equal(out.dueAt, T0 + 10 * MIN);
  assert.equal(a.comments.filter(c => c.name === 'Application In Review').length, 0, 'not yet');
  const listed = (await listApplicants(env.DB)).find(x => x.id === a.id);
  assert.equal(listed.notify.kind, 'inReview', 'the board shows it waiting');
  await tick(T0 + 10 * MIN);
  const sent = a.comments.filter(c => c.name === 'Application In Review');
  assert.equal(sent.length, 1, 'site changes skip the staff summary (they were previewed)');
  assert.equal(sent[0].grantKey, 'qc-grant');
  assert.equal(sent[0].assignees[0].emailAddress, 'jordan@example.com');
  // The same move arriving from JobTread's workflow doesn't send it again
  await handleWorkflowCall(env, { accountId: a.id, previousStatus: 'Applied', nextStatus: 'In Review' }, { ...opts(), now: T0 + 11 * MIN });
  await tick(T0 + 60 * MIN);
  assert.equal(a.comments.filter(c => c.name === 'Application In Review').length, 1);
  const history = await activityFor(env.DB, a.id);
  const status = history.find(r => r.kind === 'status');
  assert.equal(status.source, 'website');
  assert.equal(status.by, 'Linzi');
  assert.equal(status.body, 'Was Applied');
  assert.ok(history.some(r => r.kind === 'notify' && /^Email scheduled: In Review/.test(r.title)), 'the email has its own line');
  assert.ok(history.some(r => r.kind === 'notify' && /^Emailed the family: In Review/.test(r.title)));
  assert.equal((await getApplicantRow(env.DB, a.id)).status, 'In Review');
});

test('"Move and email now" skips the wait; "don\'t email" holds even when JobTread moves it later', async () => {
  const a = addAccount({ name: 'Avery Stone', fields: { [F.status]: 'In Review' }, contact: { name: 'Jordan', email: 'jordan@example.com' } });
  const b = addAccount({ name: 'Blake Ray', fields: { [F.status]: 'In Review' }, contact: { name: 'Sam', email: 'sam@example.com' } });
  await syncAllApplicants(env, opts());
  const now = await setApplicantStatus(env, b.id, 'Approved', { emailNow: true, ...opts(), now: T0 });
  assert.equal(now.email, 'sent');
  assert.equal(b.comments.filter(c => c.name === 'Application Decision').length, 1);

  const out = await setApplicantStatus(env, a.id, 'Approved', { notify: false, ...opts(), now: T0 });
  assert.equal(out.email, 'not sent');
  await tick(T0 + 60 * MIN);
  assert.equal(a.comments.filter(c => c.name === 'Application Decision').length, 0);
  a.fields[F.status] = 'In Review';
  await setApplicantStatus(env, a.id, 'In Review', { ...opts(), now: T0 + 70 * MIN });
  await setApplicantStatus(env, a.id, 'Approved', { ...opts(), now: T0 + 80 * MIN });
  await tick(T0 + 200 * MIN);
  assert.equal(a.comments.filter(c => c.name === 'Application Decision').length, 0, 'they already know');
});

test('a move backwards leaves a staff note once it settles, and Denied records the reason', async () => {
  const a = addAccount({ name: 'Avery Stone', fields: { [F.status]: 'In Review' }, contact: { name: 'Jordan', email: 'jordan@example.com' } });
  await syncAllApplicants(env, opts());
  const back = await previewStatus(env, a.id, 'Applied', opts());
  assert.equal(back.forward, false);
  assert.match(back.note, /isn’t emailed/);
  await setApplicantStatus(env, a.id, 'Applied', { ...opts(), now: T0 });
  await tick(T0 + 11 * MIN);
  assert.ok(a.comments.some(c => c.message === 'Moved back to Applied.' && c.internal));
  await setApplicantStatus(env, a.id, 'Denied', { denialReason: 'Outside the service area', ...opts(), now: T0 + 20 * MIN });
  assert.equal(a.fields[F.denialReason], 'Outside the service area');
  await tick(T0 + 49 * MIN);
  assert.ok(!a.comments.some(c => c.name === 'Application Decision'), 'decisions wait 30 minutes');
  await tick(T0 + 51 * MIN);
  assert.ok(a.comments.some(c => c.name === 'Application Decision' && /unable to move forward/.test(c.message)));
});

test('details: options are checked, Makeover type is a list, empty clears', async () => {
  const a = addAccount({ name: 'Avery Stone', fields: { [F.status]: 'Applied', [F.gender]: 'Female' } });
  await syncAllApplicants(env, opts());
  const row = await updateApplicantFields(env, a.id, { types: ['Ramp', 'Bedroom', 'Pool'], gender: '' }, opts());
  assert.deepEqual(a.fields[F.types], ['Ramp', 'Bedroom']);
  assert.equal(a.fields[F.gender], undefined);
  assert.deepEqual(row.types, ['Ramp', 'Bedroom']);
  await assert.rejects(() => updateApplicantFields(env, a.id, { year: '1999' }, opts()), /Makeover year must be one of/);
  assert.equal(fieldInput('birthday', '2018-05-01'), '2018-05-01');
  assert.throws(() => fieldInput('birthday', 'May 1'), /must be a date/);
  assert.equal(adminName('linzi.ranney@soardcharity.com'), 'Linzi');
});

test('message, text and note go to JobTread the way staff would post them', async () => {
  const a = addAccount({ name: 'Avery Stone', fields: { [F.status]: 'Applied' }, contact: { name: 'Jordan Stone', email: 'jordan@example.com', phone: '+17705550100' } });
  await syncAllApplicants(env, opts());
  await messageFamily(env, a.id, { subject: 'Your home visit', message: 'Does Tuesday at 3 work?', user: 'linzi@soardcharity.com', ...opts() });
  const msg = a.comments.find(c => c.name === 'Your home visit');
  assert.equal(msg.assignees[0].emailAddress, 'jordan@example.com');
  assert.equal(msg.grantKey, 'qc-grant');
  await assert.rejects(() => textFamily(env, a.id, { message: 'See you Tuesday!', ...opts() }), /Texting isn’t set up yet/, 'off until the texting service is ready');
  assert.ok(!a.comments.some(c => /^\/text /.test(c.message)), 'and nothing was posted');
  env.APPLICANT_TEXTING = 'on';
  await textFamily(env, a.id, { message: 'See you Tuesday!', ...opts() });
  const text = a.comments.find(c => c.message === '/text See you Tuesday!');
  assert.equal(text.parentCommentId, `${a.id}-comms`);
  assert.equal(text.grantKey, 'site-grant');
  await addNote(env, a.id, { message: 'Mom prefers texts.', user: 'linzi@soardcharity.com', ...opts() });
  const note = a.comments.find(c => /^Mom prefers texts\./.test(c.message));
  assert.ok(note.internal);
  assert.match(note.message, /Linzi, from the website/);
  const kinds = (await activityFor(env.DB, a.id)).map(r => r.kind);
  assert.deepEqual(kinds.sort(), ['note', 'sent', 'textOut']);
  // No email, no thread: clear errors
  const b = addAccount({ name: 'No Email', fields: { [F.status]: 'Applied' }, comms: false });
  await refreshApplicants(env, [b.id], opts());
  await assert.rejects(() => messageFamily(env, b.id, { message: 'hi', ...opts() }), /no email address/);
  await assert.rejects(() => textFamily(env, b.id, { message: 'hi', ...opts() }), /no Comms Thread/);
});

test('archive hides an applicant from the default list; detail reads the thread live', async () => {
  const a = addAccount({ name: 'Avery Stone', fields: { [F.status]: 'Denied' }, contact: { name: 'Jordan', email: 'j@example.com' } });
  await syncAllApplicants(env, opts());
  await archiveApplicant(env, a.id, opts());
  assert.ok(a.archivedAt);
  assert.equal((await listApplicants(env.DB)).length, 0);
  assert.equal((await listApplicants(env.DB, { archived: true })).length, 1);
  const detail = await applicantDetail(env, a.id, opts());
  assert.equal(detail.applicant.name, 'Avery Stone');
  assert.ok(detail.comments.some(c => c.name === 'Comms Thread'));
  assert.ok(detail.activity.some(r => r.kind === 'archived'));
});

test('the boundary: points inside, outside with miles, and a moved boundary re-places everyone', async () => {
  const poly = DEFAULT_SERVICE_AREA.polygon;
  assert.equal(placeOnArea(MARIETTA.latitude, MARIETTA.longitude, poly).area, 'inside');
  assert.equal(placeOnArea(null, null, poly).area, 'unknown');
  const a = addAccount({ name: 'Downtown Kid', fields: { [F.status]: 'Applied' }, home: DOWNTOWN });
  await syncAllApplicants(env, opts());
  assert.equal((await getApplicantRow(env.DB, a.id)).area, 'outside');
  const bigger = [[34.4, -84.8], [34.4, -84.0], [33.6, -84.0], [33.6, -84.8]];
  await replaceBoundary(env.DB, bigger);
  assert.equal((await getApplicantRow(env.DB, a.id)).area, 'inside');
});

test('the sweep keeps the mirror fresh and never throws', async () => {
  addAccount({ name: 'Avery Stone', fields: { [F.status]: 'Applied' } });
  const first = await maybeSyncApplicants(env, { ...opts(), now: Date.now() });
  assert.equal(first.full.applicants, 1);
  const soon = await maybeSyncApplicants(env, { ...opts(), now: Date.now() + 1000 });
  assert.equal(soon.full, undefined);
  assert.equal(soon.events, undefined);
  w.failNext.set('organization', 5);
  const broken = await maybeSyncApplicants(env, { ...opts(), now: Date.now() + 31 * 60 * 1000 });
  assert.match(broken.error, /JobTread returned 500/);
  assert.match((await syncState(env.DB)).lastError, /500/);
});
