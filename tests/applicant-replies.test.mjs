/**
 * A family replied: staff hear about it (functions/api/_applicant-replies.js),
 * through the real event sync against the fake JobTread, Slack and Resend.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from './lib/fake-applicant-world.mjs';
import { syncAllApplicants, syncEvents, FIELDS, activityFor, relabelFamilyComments, messageFamily, markReplyHandled, listApplicants } from '../functions/api/_applicants.js';
import { alertFamilyReplies, replyText, replyAlertFacts, waitingReplies } from '../functions/api/_applicant-replies.js';
import * as countRoute from '../functions/api/applicants-count.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';

const F = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.id]));
const EMAIL = '22NJw43QvHeJ';
let w;
let env;
let n = 0;

function family(name, fields = { [F.status]: 'In Review', [F.year]: '2027' }) {
  const id = `acctR${String(++n).padStart(7, '0')}`;
  w.world.accounts[id] = {
    id, name, type: 'customer', org: ORG, createdAt: '2026-10-01T12:00:00Z', fields,
    contacts: [{ id: `${id}-c1`, name: 'Jordan Stone', fields: { [EMAIL]: 'jordan@example.com' } }], primaryContactId: `${id}-c1`,
    locations: [], files: [], comments: [], jobs: [],
  };
  return w.world.accounts[id];
}

/** JobTread's event for a family's email reply landing on their account */
function reply(a, message, at = Date.now() + 1000, by = 'Jordan Stone', thread = 'cm-thread') {
  const id = `evt-reply-${++n}`;
  w.world.events.push({
    id, createdAt: new Date(at).toISOString(), type: 'commentCreated', createdByGrantId: null, createdByUser: { name: by },
    data: { next: { id: `cm-${n}`, name: null, message, targetType: 'account', fromEmailStorageId: `es-${n}`, parentCommentId: thread } },
    account: { id: a.id, type: 'customer' },
  });
  return id;
}

const opts = () => ({ fetchImpl: w.fetchImpl });

beforeEach(async () => {
  w = fakeApplicantWorld();
  env = { ...w.env, DB: await createD1(), JOBTREAD_QC_GRANT_KEY: 'qc-grant' };
  globalThis.fetch = w.fetchImpl; // Slack and Resend go through the global fetch
});

test('a family replies: one Slack card and one email to the staff list, with what they wrote', async () => {
  const a = family('Avery Stone');
  await syncAllApplicants(env, opts());
  await syncEvents(env, opts()); // the first sync: alerts start from here
  reply(a, 'Tuesday at 3 works for us. Thank you!\n\nOn Mon, Oct 20, 2026 at 9:00 AM Qualification Committee wrote:\n> Could we visit on Tuesday?');
  const out = await syncEvents(env, opts());
  assert.equal(out.replyAlerts?.alerted, 1);

  assert.equal(w.world.slack.length, 1);
  const card = JSON.stringify(w.world.slack[0]);
  assert.match(w.world.slack[0].text, /Jordan Stone replied/);
  assert.match(card, /About Avery Stone \(In Review · 2027 season\)/);
  assert.match(card, /Tuesday at 3 works for us/);
  assert.doesNotMatch(card, /Could we visit/, 'the quoted email history is left out');
  assert.match(card, /"Reply".*admin\/#applications\/applicants\/acctR\d+\/reply\/cm-thread/, 'Reply opens the family’s page answering in that JobTread thread');

  const mails = w.world.emails.filter((e) => /replied/.test(e.subject));
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['selection@soardcharity.com'], 'the staff list in Applications → Settings');
  assert.equal(mails[0].subject, 'Jordan Stone replied: Avery Stone');
  assert.match(mails[0].html, /Tuesday at 3 works for us/);
  assert.match(mails[0].text, /Reply: .*\/reply\/cm-thread/);
  assert.match(mails[0].html, />Reply</);

  // Read again, or a second sweep: never twice
  await syncEvents(env, opts());
  const again = await alertFamilyReplies(env, [{ id: w.world.events.at(-1).id, account_id: a.id, at: new Date().toISOString(), kind: 'reply', body: 'x', by_name: 'Jordan Stone' }], { since: '2000-01-01', getApplicant: async () => ({ id: a.id, name: a.name }), now: Date.now() });
  assert.equal(again.alerted, 0);
  assert.equal(w.world.slack.length, 1);
  assert.equal(w.world.emails.filter((e) => /replied/.test(e.subject)).length, 1);
  const facts = await replyAlertFacts(env.DB);
  assert.equal(facts.count, 1);
  assert.equal(facts.last.slack, 'posted');
  assert.equal(facts.last.email, 'sent to 1');
});

test('only new replies: nothing for ones from before alerts started, or for accounts that aren’t applicants', async () => {
  const a = family('Avery Stone');
  const office = family('Sunshine Office', {}); // no Status or year: not an applicant
  await syncAllApplicants(env, opts());
  await syncEvents(env, opts());
  reply(a, 'An old reply', Date.now() - 60 * 1000); // after the cursor, before alerts began
  reply(office, 'Not a family');
  await syncEvents(env, opts());
  assert.equal(w.world.slack.length, 0);
  assert.equal(w.world.emails.filter((e) => /replied/.test(e.subject)).length, 0);
});

test('a TEST family: the card says it’s a test, and the email goes only to the alert address', async () => {
  const a = family('TEST Notify Check');
  await syncAllApplicants(env, opts());
  await syncEvents(env, opts());
  reply(a, 'Got it, thanks', Date.now() + 1000, 'Sam Parent');
  await syncEvents(env, opts());
  assert.equal(w.world.slack.length, 1);
  assert.match(JSON.stringify(w.world.slack[0]), /🧪 \*Test family · not a real family\*/);
  const mail = w.world.emails.find((e) => /replied/.test(e.subject));
  assert.deepEqual(mail.to, ['peter@soardcharity.com']);
  assert.equal(mail.subject, '[TEST] Sam Parent replied: TEST Notify Check');
});

test('Slack or email down: the reply is still claimed once, and the record says what didn’t go', async () => {
  const a = family('Avery Stone');
  await syncAllApplicants(env, opts());
  await syncEvents(env, opts());
  w.world.slackDown = true;
  reply(a, 'Are we still on for Tuesday?');
  await syncEvents(env, opts());
  const facts = await replyAlertFacts(env.DB);
  assert.equal(facts.count, 1);
  assert.match(facts.last.slack, /^not posted/);
  assert.equal(w.world.emails.filter((e) => /replied/.test(e.subject)).length, 1, 'the email still went');
});

test('in the Slack app, more replies in one JobTread thread reply in one Slack thread', async () => {
  env.SLACK_BOT_TOKEN = 'xoxb-test';
  delete env.SLACK_WEBHOOK_URL;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)').run();
  await writeSlackConfig(env.DB, { channel: { id: 'C0ALERTS', name: 'website-alerts' } });
  const a = family('Avery Stone');
  await syncAllApplicants(env, opts());
  await syncEvents(env, opts());
  reply(a, 'Tuesday works', Date.now() + 1000, 'Jordan Stone', 'cm-visit');
  await syncEvents(env, opts());
  reply(a, 'Actually, can we do 4?', Date.now() + 2000, 'Sam Stone', 'cm-visit');
  reply(a, 'A different question', Date.now() + 3000, 'Jordan Stone', 'cm-other');
  await syncEvents(env, opts());
  const posts = w.world.slack;
  assert.equal(posts.length, 3);
  assert.ok(!posts[0].thread_ts, 'the first reply in a thread is a new post');
  assert.ok(posts[1].thread_ts && posts[1].reply_broadcast, 'the next one in the same JobTread thread replies under it, shown in the channel too');
  assert.ok(!posts[2].thread_ts, 'another JobTread thread starts its own');
});

test('a family member writing in JobTread’s family portal is a reply too (matched by their email); staff comments aren’t', async () => {
  const a = family('Avery Stone');
  await syncAllApplicants(env, opts());
  await syncEvents(env, opts());
  const at = new Date(Date.now() + 1000).toISOString();
  w.world.events.push(
    { id: 'evt-portal', createdAt: at, type: 'commentCreated', createdByGrantId: 'g-portal', createdByGrantName: 'JobTread App', createdByUser: { name: 'Jordan Stone', emailAddress: 'Jordan@Example.com' },
      data: { next: { id: 'cm-portal', message: 'We can do Tuesday', targetType: 'account', parentCommentId: 'cm-visit', isVisibleToCustomerRoles: true } }, account: { id: a.id, type: 'customer' } },
    { id: 'evt-staff', createdAt: at, type: 'commentCreated', createdByGrantId: 'g-app', createdByGrantName: 'JobTread App', createdByUser: { name: 'Linzi Berkowitz', emailAddress: 'linzi@soardcharity.com' },
      data: { next: { id: 'cm-staff', message: 'Great, see you then', targetType: 'account', parentCommentId: 'cm-visit' } }, account: { id: a.id, type: 'customer' } });
  await syncEvents(env, opts());
  const kinds = Object.fromEntries((await activityFor(env.DB, a.id)).filter(r => ['evt-portal', 'evt-staff'].includes(r.id)).map(r => [r.id, r.kind]));
  assert.deepEqual(kinds, { 'evt-portal': 'reply', 'evt-staff': 'comment' });
  assert.equal(w.world.slack.length, 1);
  assert.match(w.world.slack[0].text, /Jordan Stone replied/);
});

test('once: past portal messages by a family contact become replies in the history (no alerts)', async () => {
  const a = family('Avery Stone');
  await syncAllApplicants(env, opts());
  await env.DB.prepare("INSERT INTO applicant_activity (id, account_id, at, kind, by_name, source, title, body, data) VALUES ('old-1', ?, '2025-12-15T15:43:06Z', 'comment', 'Jordan Stone', 'jobtread', NULL, 'Thursday works', NULL), ('old-2', ?, '2025-12-15T15:47:00Z', 'comment', 'Linzi Berkowitz', 'jobtread', NULL, 'Great', NULL)").bind(a.id, a.id).run();
  assert.equal(await relabelFamilyComments(env.DB), 1);
  const kinds = Object.fromEntries((await activityFor(env.DB, a.id)).map(r => [r.id, r.kind]));
  assert.equal(kinds['old-1'], 'reply');
  assert.equal(kinds['old-2'], 'comment');
  assert.equal(await relabelFamilyComments(env.DB), 0, 'only once');
  assert.equal(w.world.slack.length, 0);
});

test('waiting on us: a family’s reply until someone answers it (site, a JobTread reply in the thread) or marks it No reply needed', async () => {
  const a = family('Avery Stone');
  const b = family('Blake Ray');
  await syncAllApplicants(env, opts());
  await syncEvents(env, opts());
  reply(a, 'Tuesday works!\n\nOn Mon, Oct 20, 2026 at 9:00 AM SOARD <x@y.org> wrote:\n> Could we visit?', Date.now() + 1000, 'Jordan Stone', 'cm-visit');
  reply(b, 'Thanks so much', Date.now() + 2000, 'Pat Ray', 'cm-hello');
  await syncEvents(env, opts());
  let waiting = await waitingReplies(env.DB);
  assert.deepEqual(waiting.map((x) => x.name), ['Blake Ray', 'Avery Stone'], 'newest first');
  assert.deepEqual({ by: waiting[1].by, snippet: waiting[1].snippet, thread: waiting[1].thread }, { by: 'Jordan Stone', snippet: 'Tuesday works!', thread: 'cm-visit' });
  // The board and the sidebar see the same thing
  assert.equal((await listApplicants(env.DB)).find((x) => x.name === 'Avery Stone').waiting.by, 'Jordan Stone');
  const res = await countRoute.onRequestGet({ env });
  const j = await res.json();
  assert.equal(j.waiting, 2);
  assert.equal(j.replies[0].name, 'Blake Ray');

  // Answered from the site
  a.comments.push({ id: 'cm-visit', name: 'Onsite Scheduling', message: 'Could we visit?', by: 'Qualification Committee', assignees: [{ name: 'Jordan Stone', emailAddress: 'jordan@example.com' }] });
  await messageFamily(env, a.id, { message: 'See you Tuesday at 3!', replyTo: 'cm-visit', user: 'linzi@soardcharity.com', ...opts(), now: Date.now() + 5000 });
  // "Thanks so much" needs no answer
  await markReplyHandled(env, b.id, { user: 'linzi@soardcharity.com', now: Date.now() + 5000 });
  assert.deepEqual(await waitingReplies(env.DB), []);
  assert.equal((await activityFor(env.DB, b.id)).find((r) => r.kind === 'handled').title, 'No reply needed');

  // They write again; Linzi answers in the thread from JobTread
  reply(a, 'Can we make it 4?', Date.now() + 8000, 'Jordan Stone', 'cm-visit');
  await syncEvents(env, opts());
  assert.deepEqual((await waitingReplies(env.DB)).map((x) => x.name), ['Avery Stone']);
  w.world.events.push({ id: 'evt-linzi', createdAt: new Date(Date.now() + 9000).toISOString(), type: 'commentCreated', createdByGrantId: 'g-app', createdByGrantName: 'JobTread App', createdByUser: { name: 'Linzi Berkowitz', emailAddress: 'linzi@soardcharity.com' },
    data: { next: { id: 'cm-linzi', message: '4 works', targetType: 'account', parentCommentId: 'cm-visit' } }, account: { id: a.id, type: 'customer' } });
  await syncEvents(env, opts());
  assert.deepEqual(await waitingReplies(env.DB), [], 'answered in JobTread');
});

test('waiting on us leaves out replies from before alerts began, and archived families', async () => {
  const a = family('Avery Stone');
  const c = family('Casey Archived');
  await syncAllApplicants(env, opts());
  await syncEvents(env, opts());
  reply(a, 'Old one', Date.now() - 60 * 1000);
  reply(c, 'Hello?');
  c.archivedAt = new Date().toISOString();
  await syncEvents(env, opts());
  await syncAllApplicants(env, opts());
  assert.deepEqual(await waitingReplies(env.DB), []);
});

test('what they wrote, without the quoted history mail apps add', () => {
  assert.equal(replyText('Yes please!\n\nOn Tue, Oct 21, 2026 at 3:00 PM SOARD <x@y.com> wrote:\n> old'), 'Yes please!');
  assert.equal(replyText('Line one\nLine two\n> quoted'), 'Line one\nLine two');
  assert.equal(replyText('Thanks\n-----Original Message-----\nFrom: x'), 'Thanks');
  assert.equal(replyText("Okay we just got home!\n\nOn Thu, Oct 22, 2026 at 12:10 PM Qualification Committee <selection@soardcharity.com> wrote:\n> Could we stop by?"), 'Okay we just got home!', 'a long "wrote:" line');
  assert.equal(replyText('See you then\n\nOn Thu, Oct 22, 2026 at 12:10 PM Qualification Committee <\nselection@soardcharity.com> wrote:\n\nCould we stop by?'), 'See you then', 'wrapped over two lines');
  assert.equal(replyText('Works for us\n\nFrom: Qualification Committee <selection@soardcharity.com>\nSent: Thursday, October 22, 2026 12:10 PM\nTo: Erin'), 'Works for us', 'Outlook');
  assert.equal(replyText('On Tuesday we can do 3.\nThanks!'), 'On Tuesday we can do 3.\nThanks!', 'a reply that starts with "On" stays whole');
  assert.equal(replyText(''), '');
});
