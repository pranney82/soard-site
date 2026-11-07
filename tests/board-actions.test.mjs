/**
 * Action item reminders (functions/api/_board-actions.js): off until turned on, one email a person with all of theirs,
 * and ticked done stops it. Made-up people only (the repo is public).
 * Run: node --test tests/board-actions.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, ensureSchema, saveSettings, setActionDone, portalData } from '../functions/api/_board.js';
import { stageFor, actionReminderEmail, maybeRemindActions } from '../functions/api/_board-actions.js';
import { businessHours } from '../functions/api/_board-sign.js';

// A Tuesday, 10 AM Eastern
const NOW = Date.parse('2026-11-24T15:00:00Z');
const DAY = 864e5;

let env;
let sent;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  sent = [];
  const DB = await createD1();
  env = { DB, RESEND_API_KEY: 'test-key' };
  await ensureSchema(DB);
  await DB.prepare('CREATE TABLE IF NOT EXISTS team (slug TEXT PRIMARY KEY, data TEXT)').run().catch(() => {});
  for (const [slug, name, group] of [['sam-ortiz', 'Sam Ortiz', 'board'], ['kim-park', 'Kim Park', 'board'], ['jane-doe', 'Jane Doe', 'staff']]) await DB.prepare('INSERT OR REPLACE INTO team (slug, data) VALUES (?, ?)').bind(slug, JSON.stringify({ name, group, status: 'active' })).run();
  await DB.prepare('CREATE TABLE IF NOT EXISTS reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT)').run();
  await DB.prepare('INSERT OR REPLACE INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('sam-ortiz', 'sam@example.com').run();
  await saveMeeting(DB, {
    id: 'm_act000001', date: '2026-11-05', shared: true,
    sections: [{ id: 's_a', title: 'Business', items: [{ id: 'i_open', title: 'Open' }, { id: 'i_secret', title: 'A settlement', confidential: true }] }],
    actions: [
      { id: 'a_soon', text: 'Confirm the venue', owner: 'sam-ortiz', ownerName: 'Sam Ortiz', due: '2026-11-30' },
      { id: 'a_far', text: 'Call the sponsors', owner: 'sam-ortiz', ownerName: 'Sam Ortiz', due: '2027-03-01' },
      { id: 'a_hush', text: 'Secret words', owner: 'sam-ortiz', ownerName: 'Sam Ortiz', due: '2027-03-02', from: 'i_secret' },
      { id: 'a_none', text: 'Nobody’s', owner: '', ownerName: '', due: '2026-11-30' },
      { id: 'a_noaddr', text: 'No address', owner: 'kim-park', ownerName: 'Kim Park', due: '2026-11-30' },
    ],
  }, { by: 'x' });
  await saveMeeting(DB, { id: 'm_next00001', date: '2027-01-14', shared: true, sections: [] }, { by: 'x' });
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('resend')) { const body = JSON.parse(opts.body); sent.push(body); return new Response(JSON.stringify({ id: `e_${sent.length}` }), { status: 200 }); }
    return realFetch(url, opts);
  };
});
afterEach(() => { env = null; globalThis.fetch = realFetch; });
const on = () => saveSettings(env.DB, { actionRemind: 'on' }, 'jane@soardcharity.com');

test('when a to-do reminds: a week out, the day before, weekly for three weeks late, then never', () => {
  const stage = (daysAway, opts) => stageFor(new Date(Date.parse('2026-06-15T12:00:00Z') + daysAway * DAY).toISOString().slice(0, 10), '2026-06-15', opts);
  assert.equal(stage(30), '');
  assert.equal(stage(8), '');
  assert.equal(stage(7), 'week');
  assert.equal(stage(2), 'week');
  assert.equal(stage(1), 'day');
  assert.equal(stage(0), 'day');
  assert.equal(stage(-1), 'late1');
  assert.equal(stage(-7), 'late1');
  assert.equal(stage(-8), 'late8');
  assert.equal(stage(-14), 'late8');
  assert.equal(stage(-15), 'late15');
  assert.equal(stage(-21), 'late15');
  assert.equal(stage(-22), '');
  assert.equal(stageFor('', '2026-06-15'), '');
  // Only the next meeting's date: reminded before it, never after
  assert.equal(stage(3, { soft: true }), 'week');
  assert.equal(stage(-1, { soft: true }), '');
});

test('off until an admin turns it on', async () => {
  assert.deepEqual(await maybeRemindActions(env, { now: NOW }), { off: true });
  assert.equal(sent.length, 0);
});

test('never outside business hours', async () => {
  await on();
  const sunday = Date.parse('2026-11-22T15:00:00Z');
  assert.equal(businessHours(sunday), false);
  assert.deepEqual(await maybeRemindActions(env, { now: sunday }), { waiting: 'hours' });
  assert.equal(sent.length, 0);
});

test('one email a person, all of theirs, and each reminder only once', async () => {
  await on();
  const r = await maybeRemindActions(env, { now: NOW });
  assert.deepEqual(r, { sent: 1 });
  assert.equal(sent.length, 1);
  assert.deepEqual([].concat(sent[0].to), ['sam@example.com']);
  assert.match(sent[0].text, /Confirm the venue \(due Nov 30\)/);
  assert.match(sent[0].text, /Call the sponsors \(due Mar 1\)/);
  // A board-only item's to-do is counted, never quoted
  assert.doesNotMatch(`${sent[0].text}${sent[0].html}`, /Secret words/);
  assert.match(sent[0].text, /A to-do from a board-only item/);
  // An hour later, nothing new; and the same reminder isn't sent again
  assert.deepEqual(await maybeRemindActions(env, { now: NOW + 3600e3 + 1000 }), { sent: 0 });
  assert.equal(sent.length, 1);
  // The day before: its next reminder
  const dayBefore = Date.parse('2026-11-27T15:00:00Z');
  assert.equal(businessHours(dayBefore), false, 'the day after Thanksgiving waits');
  await maybeRemindActions(env, { now: Date.parse('2026-11-30T15:00:00Z') });
  assert.equal(sent.length, 2);
});

test('a to-do caught under a part with a board-only item isn’t quoted, and one given a new date is reminded of it', async () => {
  await saveMeeting(env.DB, {
    id: 'm_act000004', date: '2026-11-06', shared: true,
    sections: [{ id: 's_hush', title: 'Closed session', items: [{ id: 'i_hush', title: 'Settlement', confidential: true }] }],
    actions: [{ id: 'a_part', text: 'Call the lawyer', owner: 'sam-ortiz', ownerName: 'Sam Ortiz', due: '2026-11-30', from: 's_hush' }],
  }, { by: 'x' });
  await on();
  await maybeRemindActions(env, { now: NOW });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(`${sent[0].text}${sent[0].html}${sent[0].subject}`, /Call the lawyer/);
  // The date moves three weeks: a week before the new one, it's reminded again
  const m = (await portalData(env, { admin: true, adminEmail: 'jane@example.com' })).meetings.find((x) => x.id === 'm_act000001');
  await saveMeeting(env.DB, { ...(await (await import('../functions/api/_board.js')).getMeeting(env.DB, m.id)), actions: [{ id: 'a_soon', text: 'Confirm the venue', owner: 'sam-ortiz', ownerName: 'Sam Ortiz', due: '2026-12-21' }] }, { by: 'x' });
  await maybeRemindActions(env, { now: Date.parse('2026-12-15T15:00:00Z') });
  assert.ok(sent.slice(1).some((x) => /Confirm the venue/.test(x.text)));
});

test('ticked done stops it', async () => {
  await on();
  await setActionDone(env.DB, 'a_soon', true, { by: 'sam@example.com', slug: 'sam-ortiz' });
  assert.deepEqual(await maybeRemindActions(env, { now: NOW }), { sent: 0 });
  assert.equal(sent.length, 0);
});

test('an email that doesn’t go is tried again, never lost', async () => {
  await on();
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  assert.deepEqual(await maybeRemindActions(env, { now: NOW }), { sent: 0 });
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM board_action_reminders').first()).n, 0);
});

test('no date: due by the next meeting, and said that way', async () => {
  await saveMeeting(env.DB, { id: 'm_act000002', date: '2027-01-07', shared: true, sections: [], actions: [{ id: 'a_nodate', text: 'Bring the plan', owner: 'sam-ortiz', ownerName: 'Sam Ortiz', due: '' }] }, { by: 'x' });
  await on();
  // (a week before Jan 14, a Thursday)
  await maybeRemindActions(env, { now: Date.parse('2027-01-08T15:00:00Z') });
  const mail = sent.find((m) => /Bring the plan/.test(m.text));
  assert.ok(mail);
  assert.match(mail.text, /Bring the plan \(before the Jan 14 meeting\)/);
});

test('the email itself: late ones said plainly, soonest first, and the owner’s name', () => {
  const rows = [{ text: 'Later', date: '2026-12-20' }, { text: 'Late', date: '2026-11-20' }, { text: 'Tomorrow', date: '2026-11-25' }, { text: 'Today', date: '2026-11-24' }];
  const m = actionReminderEmail({ name: 'Sam Ortiz', rows, today: '2026-11-24' });
  assert.match(m.subject, /Your board to-dos: 4 open/);
  assert.match(m.text, /^Sam, you have 4 to-dos from the board, one past its date\./);
  assert.ok(m.text.indexOf('Late') < m.text.indexOf('Today'));
  assert.ok(m.text.indexOf('Today') < m.text.indexOf('Tomorrow'));
  assert.match(m.text, /Late \(was due Nov 20\)/);
  assert.match(m.text, /Today \(due today\)/);
  assert.match(m.text, /Tomorrow \(due tomorrow\)/);
  assert.match(actionReminderEmail({ rows: [{ text: 'One', date: '2026-11-30' }], today: '2026-11-24', test: true }).subject, /^\[Preview\] Your board to-dos: due Nov 30/);
  assert.match(actionReminderEmail({ name: '<b>', rows: [{ text: 'a <script>', date: '' }], today: '2026-11-24' }).html, /a &lt;script&gt;/);
});

test('a founder’s own to-dos reach their board page, a member’s stay theirs', async () => {
  await saveMeeting(env.DB, { id: 'm_act000003', date: '2026-11-06', shared: true, sections: [], actions: [{ id: 'a_jane', text: 'Send the link', owner: 'jane-doe', ownerName: 'Jane Doe', due: '' }] }, { by: 'x' });
  const asAdmin = await portalData(env, { admin: true, adminEmail: 'jane@example.com' });
  assert.equal(asAdmin.actions.find((a) => a.id === 'a_jane').mine, true);
  assert.equal(asAdmin.actions.find((a) => a.id === 'a_soon').mine, false);
  const asMember = await portalData(env, { member: { slug: 'sam-ortiz', name: 'Sam Ortiz', email: 'sam@example.com' } });
  assert.equal(asMember.actions.find((a) => a.id === 'a_soon').mine, true);
  assert.equal(asMember.actions.find((a) => a.id === 'a_jane').mine, false);
});
