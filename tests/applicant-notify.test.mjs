/**
 * When families are emailed about their status (functions/api/_applicant-notify.js):
 * waits, quiet hours, the staff summary and its one-tap links, pause, corrections,
 * and the patterns from JobTread's real history (screening batches, flip-flops,
 * data cleanup through a temporary status)
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from './lib/fake-applicant-world.mjs';
import {
  handleWorkflowCall, runNotifications, notifyFor, pauseEmails, pauseState, resolveHeld, correctionDraft, sendCorrection,
  linkAction, summaryEmail, outsideQuiet, needsEmail, overdueCount, noteStatus,
} from '../functions/api/_applicant-notify.js';
import { readApplicant } from '../functions/api/_applicant-comms.js';
import * as actionPage from '../functions/api/applicant-email-action.js';

const STATUS = '22P46wDp3NLd';
const LANGUAGE = '22P46u8a49hk';
const EMAIL = '22NJw43QvHeJ';
const T0 = Date.parse('2026-10-21T15:00:00Z'); // 11 AM Eastern
const MIN = 60 * 1000;
const iso = (t) => new Date(t).toISOString();

let w;
let env;
beforeEach(async () => {
  w = fakeApplicantWorld();
  env = { ...w.env, DB: await createD1(), JOBTREAD_QC_GRANT_KEY: 'qc-grant' };
  globalThis.fetch = w.fetchImpl; // the summary email goes through the global fetch (Resend)
});

let n = 0;
function family(name, status, { email = `${name.split(' ')[0].toLowerCase()}@example.com`, comments = [], fields = {} } = {}) {
  const id = `acctN${String(++n).padStart(7, '0')}`;
  w.world.accounts[id] = {
    id, name, type: 'customer', org: ORG, createdAt: '2026-10-19T12:00:00Z',
    fields: { [STATUS]: status, ...fields }, contacts: [{ id: `${id}-c`, name: `${name.split(' ')[0]}'s Mom`, fields: { [EMAIL]: email } }],
    primaryContactId: `${id}-c`, locations: [], files: [], comments, jobs: [],
  };
  return w.world.accounts[id];
}
/** Linzi changes a status in JobTread: the event JobTread logs, then the workflow's call */
async function change(a, to, at, { by = { name: 'Linzi Berkowitz', emailAddress: 'linzi@soardcharity.com' }, grant = 'JobTread App' } = {}) {
  const from = a.fields[STATUS];
  a.fields[STATUS] = to;
  const id = `evt${++n}`;
  w.world.events.push({ id, createdAt: iso(at), type: 'accountUpdated', createdByGrantId: 'g1', createdByGrantName: grant, createdByUser: by, data: { next: { custom: { Status: to } }, previous: { custom: { Status: from } } }, account: { id: a.id, type: 'customer' } });
  return handleWorkflowCall(env, { eventId: id, accountId: a.id, previousStatus: from ?? 'null', nextStatus: to ?? 'null' }, { fetchImpl: w.fetchImpl, now: at });
}
const tick = async (...times) => { for (const t of times) await runNotifications(env, { fetchImpl: w.fetchImpl, now: t }); };
const emailsTo = (addr) => w.world.emails.filter(e => e.to.includes(addr));
const named = (a, name) => a.comments.filter(c => c.name === name);

test('the rule: further along than what the family was told, or a different decision', () => {
  assert.equal(needsEmail('In Review', 'Applied'), true);
  assert.equal(needsEmail('Applied', 'In Review'), false);
  assert.equal(needsEmail('Denied', 'Applied'), true, 'straight from Applied to Denied is normal screening');
  assert.equal(needsEmail('Approved', 'Denied'), true, 'a changed decision is news');
  assert.equal(needsEmail('Denied', 'Denied'), false);
  assert.equal(needsEmail('Create Table Record', 'Applied'), false, 'unknown statuses never email');
  assert.equal(needsEmail('', 'Applied'), false);
  // Quiet hours: 9:30 PM Eastern → 8 AM the next morning; 7 AM → 8 AM the same day; noon unchanged
  assert.equal(iso(outsideQuiet(Date.parse('2026-10-22T01:30:00Z'), { start: 20, end: 8 })), '2026-10-22T12:00:00.000Z');
  assert.equal(iso(outsideQuiet(Date.parse('2026-10-22T11:00:00Z'), { start: 20, end: 8 })), '2026-10-22T12:00:00.000Z');
  assert.equal(outsideQuiet(Date.parse('2026-10-22T16:00:00Z'), { start: 20, end: 8 }), Date.parse('2026-10-22T16:00:00Z'));
  assert.equal(outsideQuiet(123, { start: 8, end: 8 }), 123, 'equal hours turn quiet hours off');
});

test('a screening session: one summary to the person, then each family once', async () => {
  const fams = [family('Avery Stone', 'Applied'), family('Blake Ray', 'Applied'), family('Casey Moore', 'Applied')];
  await change(fams[0], 'In Review', T0);
  await change(fams[1], 'Denied', T0 + 1 * MIN);
  await change(fams[2], 'In Review', T0 + 2 * MIN);
  await tick(T0 + 4 * MIN);
  assert.equal(emailsTo('linzi@soardcharity.com').length, 0, 'still working: no summary mid-session');
  await tick(T0 + 5 * MIN);
  const [summary] = emailsTo('linzi@soardcharity.com');
  assert.ok(summary, 'one summary once she stops for 3 minutes');
  assert.match(summary.subject, /^3 families moved · family emails from /);
  for (const name of ['Avery Stone', 'Blake Ray', 'Casey Moore']) assert.match(summary.html, new RegExp(name));
  assert.match(summary.html, /Move back to Applied/);
  assert.equal((summary.html.match(/applicant-email-action\?t=[0-9a-f]{32}&amp;do=back/g) || []).length, 3);
  await tick(T0 + 9 * MIN);
  assert.equal(named(fams[0], 'Application In Review').length, 0, 'the wait is 10 minutes');
  await tick(T0 + 10 * MIN, T0 + 12 * MIN);
  assert.equal(named(fams[0], 'Application In Review').length, 1);
  assert.equal(named(fams[2], 'Application In Review').length, 1);
  assert.equal(named(fams[1], 'Application Decision').length, 0, 'decisions wait 30 minutes');
  await tick(T0 + 31 * MIN);
  assert.equal(named(fams[1], 'Application Decision').length, 1);
  await tick(T0 + 90 * MIN);
  assert.equal(emailsTo('linzi@soardcharity.com').length, 1, 'never a second summary for the same changes');
  for (const f of fams) assert.equal(f.comments.length, 1, `${f.name}: exactly one email`);
});

test("the summary's links: Move back (nothing sent), Don't email, Send now; each works once", async () => {
  const a = family('Avery Stone', 'In Review');
  const b = family('Blake Ray', 'In Review');
  const c = family('Casey Moore', 'In Review');
  await change(a, 'Denied', T0);
  await change(b, 'Approved', T0);
  await change(c, 'Approved', T0);
  await tick(T0 + 4 * MIN);
  const html = emailsTo('linzi@soardcharity.com')[0].html;
  const link = (name, act) => {
    const block = html.slice(html.indexOf(name));
    return new URL(block.match(new RegExp(`https://[^"]+do=${act}`))[0].replace(/&amp;/g, '&'));
  };
  const req = (u, method = 'GET') => {
    if (method === 'GET') return actionPage.onRequestGet({ request: new Request(u), env });
    const fd = new FormData();
    fd.append('t', u.searchParams.get('t'));
    fd.append('do', u.searchParams.get('do'));
    return actionPage.onRequestPost({ request: new Request(u, { method: 'POST', body: fd }), env });
  };
  // A mail scanner opening the link changes nothing
  const backA = link('Avery Stone', 'back');
  const peek = await req(backA);
  assert.equal(peek.status, 200);
  assert.match(await peek.text(), /Move Avery Stone back to In Review\?/);
  assert.equal(a.fields[STATUS], 'Denied');
  // Pressing the button moves it back in JobTread; the Denied email never goes
  const done = await req(backA, 'POST');
  assert.match(await done.text(), /Avery Stone is back to In Review in JobTread\. No email was sent\./);
  assert.equal(a.fields[STATUS], 'In Review');
  assert.equal((await req(backA, 'POST')).status, 410, 'single use');
  // Don't email: Blake stays Approved, no email
  assert.equal((await req(link('Blake Ray', 'skip'), 'POST')).status, 200);
  // Send now: Casey's goes immediately
  assert.equal((await req(link('Casey Moore', 'send'), 'POST')).status, 200);
  assert.equal(named(c, 'Application Decision').length, 1);
  await tick(T0 + 60 * MIN, T0 + 120 * MIN);
  assert.equal(named(a, 'Application Decision').length, 0);
  assert.equal(named(b, 'Application Decision').length, 0);
  assert.equal(b.fields[STATUS], 'Approved');
  assert.equal(named(c, 'Application Decision').length, 1, 'and not twice');
  assert.equal((await linkAction(env, '0'.repeat(32), 'send')).gone, true);
});

test('data cleanup through a temporary status emails nobody', async () => {
  const fams = [family('Avery Stone', 'Applied', { comments: [{ id: 'w1', name: 'Application Status', message: 'old' }] }), family('Blake Ray', 'Applied', { comments: [{ id: 'w2', name: 'Application Status', message: 'old' }] })];
  for (const f of fams) await change(f, 'Create Table Record', T0, { by: { name: 'Peter Ranney', emailAddress: 'peter@example.com' } });
  for (const f of fams) await change(f, 'Applied', T0 + 2 * MIN, { by: { name: 'Peter Ranney', emailAddress: 'peter@example.com' } });
  await tick(T0 + 10 * MIN, T0 + 60 * MIN);
  for (const f of fams) assert.equal(f.comments.length, 1, `${f.name} heard nothing new`);
  assert.equal(emailsTo('peter@example.com').length, 0, 'nothing to summarize');
});

test('pause: changes made while paused are held; nothing goes unless someone sends them', async () => {
  const a = family('Avery Stone', 'Applied', { comments: [{ id: 'w1', name: 'Application Status', message: 'old' }] });
  const b = family('Blake Ray', 'Applied', { comments: [{ id: 'w2', name: 'Application Status', message: 'old' }] });
  const state = await pauseEmails(env.DB, { minutes: 999, user: 'peter@soardcharity.com', now: T0 });
  assert.equal(state.until, T0 + 120 * MIN, 'two hours at most');
  await change(a, 'In Review', T0 + 1 * MIN);
  await change(b, 'In Review', T0 + 1 * MIN);
  await tick(T0 + 20 * MIN, T0 + 60 * MIN);
  assert.equal(named(a, 'Application In Review').length, 0);
  assert.equal(emailsTo('linzi@soardcharity.com').length, 0, 'no summary for held changes');
  assert.equal((await pauseState(env.DB, T0 + 60 * MIN)).held.length, 2);
  // The pause runs out: the person who started it hears what's held, and nothing is sent
  await tick(T0 + 121 * MIN, T0 + 200 * MIN);
  const [ended] = emailsTo('peter@soardcharity.com');
  assert.match(ended.subject, /Family emails are back on\. 2 emails are held/);
  assert.equal(named(a, 'Application In Review').length, 0);
  // Staff choose: don't send (cleanup) ... a later real move still emails normally
  await resolveHeld(env, { send: false, user: 'Peter', fetchImpl: w.fetchImpl, now: T0 + 210 * MIN });
  assert.equal((await pauseState(env.DB, T0 + 210 * MIN)).held.length, 0);
  await change(a, 'Approved', T0 + 220 * MIN);
  await tick(T0 + 224 * MIN, T0 + 251 * MIN);
  assert.equal(named(a, 'Application Decision').length, 1);
  assert.equal(named(a, 'Application In Review').length, 0);
});

test('pause, then "send these": the held emails go', async () => {
  const a = family('Avery Stone', 'Applied', { comments: [{ id: 'w1', name: 'Application Status', message: 'old' }] });
  await pauseEmails(env.DB, { minutes: 30, user: 'Peter', now: T0 });
  await change(a, 'In Review', T0 + 1 * MIN);
  await resolveHeld(env, { send: true, user: 'Peter', fetchImpl: w.fetchImpl, now: T0 + 2 * MIN });
  assert.equal(named(a, 'Application In Review').length, 1);
});

test('a correction when a family was told something that is no longer true', async () => {
  const a = family('Mateo García', 'In Review', { fields: { [LANGUAGE]: 'Spanish' }, comments: [{ id: 'w1', name: 'Application Status', message: 'old' }] });
  await change(a, 'Denied', T0);
  await tick(T0 + 4 * MIN, T0 + 31 * MIN);
  assert.equal(named(a, 'Decisión sobre la solicitud').length, 1, 'Spanish-speaking families get Spanish');
  await change(a, 'In Review', T0 + 60 * MIN);
  await tick(T0 + 71 * MIN);
  assert.match(a.comments.at(-1).message, /^Moved back to In Review\. The family was emailed the Denied message on .*send them a correction from the site\./);
  assert.equal((await notifyFor(env.DB, a.id)).correction, true);
  const draft = await correctionDraft(env, a.id, { fetchImpl: w.fetchImpl });
  assert.equal(draft.lang, 'es');
  assert.equal(draft.subject, 'Una actualización sobre su solicitud');
  assert.match(draft.message, /Por favor, no tome en cuenta nuestro último mensaje sobre la solicitud de \*Mateo García\*/);
  assert.match(draft.message, /Su solicitud avanza a la visita en persona/);
  await sendCorrection(env, a.id, { subject: draft.subject, message: draft.message, user: 'Linzi', fetchImpl: w.fetchImpl, now: T0 + 80 * MIN });
  const sent = a.comments.at(-1);
  assert.equal(sent.name, 'Una actualización sobre su solicitud');
  assert.equal(sent.assignees[0].emailAddress, 'mateo@example.com');
  assert.equal((await notifyFor(env.DB, a.id)).correction, false);
});

test('a decision that changes is news: Denied, then Approved later, emails both', async () => {
  const a = family('Avery Stone', 'In Review', { comments: [{ id: 'w1', name: 'Application Status', message: 'old' }] });
  await change(a, 'Denied', T0);
  await tick(T0 + 4 * MIN, T0 + 31 * MIN);
  await change(a, 'Approved', T0 + 24 * 60 * MIN);
  await tick(T0 + 24 * 60 * MIN + 4 * MIN, T0 + 24 * 60 * MIN + 31 * MIN);
  const decisions = named(a, 'Application Decision');
  assert.equal(decisions.length, 2);
  assert.match(decisions[1].message, /has been approved/);
});

test("an integration's change is summarized to the staff list, not to a person", async () => {
  const a = family('Avery Stone', 'Applied', { comments: [{ id: 'w1', name: 'Application Status', message: 'old' }] });
  await change(a, 'Denied', T0, { by: { name: 'Qualification Committee', emailAddress: 'qc@example.com' }, grant: 'Zapier Integration' });
  await tick(T0 + 4 * MIN);
  assert.equal(emailsTo('qc@example.com').length, 0);
  const [staff] = emailsTo('selection@soardcharity.com');
  assert.match(staff.html, /through an integration/);
});

test('a change the workflow never reported is still caught; a stalled sweep shows as overdue', async () => {
  const a = family('Avery Stone', 'Applied', { comments: [{ id: 'w1', name: 'Application Status', message: 'old' }] });
  a.fields[STATUS] = 'In Review';
  // What the event-log backup does (./_applicants.js syncEvents → noteStatus)
  await noteStatus(env, await readApplicant(env, a.id, w.fetchImpl), { previous: 'Applied', at: iso(T0), via: 'jobtread', fetchImpl: w.fetchImpl, now: T0 });
  assert.equal(await overdueCount(env.DB, T0 + 20 * MIN), 0, 'waiting on its summary, not overdue');
  assert.equal(await overdueCount(env.DB, T0 + 90 * MIN), 1, 'nobody ran the sweep for an hour and a half');
  await tick(T0 + 90 * MIN);
  assert.equal(named(a, 'Application In Review').length, 1, 'the first run catches up');
  assert.equal(await overdueCount(env.DB, T0 + 91 * MIN), 0);
});

test('the summary email reads well for one family', () => {
  const msg = summaryEmail([{ account_id: 'A1', name: 'Avery Stone', status: 'Denied', previous: 'In Review', kind: 'denied', due_at: T0 + 30 * MIN, token: 'a'.repeat(32), by_name: 'Linzi', via: 'jobtread', since: iso(T0) }], { now: T0 });
  assert.match(msg.subject, /^Avery Stone moved to Denied · family email at 11:30\sAM$/);
  assert.match(msg.html, />In Review<\/span>.*&rarr;.*>Denied<\/span>/s, 'the change, as status pills');
  assert.match(msg.html, /is emailed at <strong[^>]*>11:30\sAM<\/strong>, in 30 minutes\./);
  assert.match(msg.html, /Move back to In Review/);
  assert.match(msg.html, /never emailed between 8&nbsp;PM and 8&nbsp;AM Eastern/);
  assert.match(msg.text, /Avery Stone: In Review -> Denied\. Emailed at 11:30\sAM/);
  // Quiet hours follow the settings
  const late = summaryEmail([{ account_id: 'A1', name: 'Avery Stone', status: 'Denied', previous: 'In Review', kind: 'denied', due_at: T0 + 30 * MIN, token: 'a'.repeat(32) }], { now: T0, quiet: { start: 21, end: 7 } });
  assert.match(late.html, /between 9&nbsp;PM and 7&nbsp;AM Eastern/);
  assert.ok(!/—/.test(msg.html + msg.text), 'no em dashes');
});
