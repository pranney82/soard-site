/**
 * The Advisory Board (People → Advisory): its record rules (public/admin/team-shared.js),
 * the Paste a list reader, and the private reveal emails it keeps beside the
 * board's (functions/api/_reveal-invites.js, reveal-invites-admin.js, _team.js):
 * active advisors join every reveal invite with the board.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { boardRoster, setBoardEmail, fetchBoard, guestGroups } from '../functions/api/_reveal-invites.js';
import { getsRevealInvites, onActiveBoard } from '../functions/api/_team.js';
import { onRequestPost as invitesAdminPost } from '../functions/api/reveal-invites-admin.js';
import {
  normalizePerson, comparePeople, isListed, hasProfile, profileWords, advisoryTitle, initials, groupOf, GROUPS,
  ADVISORY_TITLE, parsePeopleList, planPeopleList, slugOf,
} from '../public/admin/team-shared.js';

test('an advisor has no role or seat, whatever their title says', () => {
  const p = normalizePerson({ name: 'Ada Advisor', title: 'Co-Founder and Board Chair', group: 'advisory' });
  assert.equal(p.role, null, 'roles are for Our Team');
  assert.equal(p.seat, '', 'seats are for the Board of Directors');
  assert.equal(p.status, 'active');
  const staff = normalizePerson({ name: 'Sam Staff', title: 'Project Manager', group: 'team' });
  assert.equal(staff.role, 'staff', 'Our Team still gets its role');
});

test('advisors sort by their place in the list, those in memory last', () => {
  const people = [
    { name: 'Cee', group: 'advisory', order: 0, status: 'memorial' },
    { name: 'Bee', group: 'advisory', order: 2 },
    { name: 'Aye', group: 'advisory', order: 1 },
    { name: 'Dee', group: 'advisory', order: 1 },
  ].map(normalizePerson).sort(comparePeople);
  assert.deepEqual(people.map((p) => p.name), ['Aye', 'Dee', 'Bee', 'Cee']);
});

test('drafts and alumni stay off the site; a bio makes a profile page', () => {
  assert.equal(isListed(normalizePerson({ name: 'A', group: 'advisory', publishStatus: 'draft' })), false);
  assert.equal(isListed(normalizePerson({ name: 'A', group: 'advisory', status: 'alumni' })), false);
  assert.equal(hasProfile(normalizePerson({ name: 'A', group: 'advisory', bio: 'Leads things.' })), true);
});

test('a profile page names the group it belongs to', () => {
  const w = profileWords(normalizePerson({ name: 'A', group: 'advisory' }));
  assert.equal(w.eyebrow, 'Advisory Board');
  assert.equal(w.meet, 'Meet the Advisory Board');
  assert.equal(w.back, '/advisory-board/#members');
  assert.equal(w.group, 'advisory board', '“More of our advisory board”');
  assert.equal(profileWords(normalizePerson({ name: 'A', group: 'advisory', status: 'memorial' })).eyebrow, 'In memoriam');
  assert.equal(profileWords(normalizePerson({ name: 'B', group: 'board' })).back, '/about/leadership/#board');
  assert.equal(profileWords(normalizePerson({ name: 'C', group: 'team', role: 'founder' })).eyebrow, 'Co-Founder');
});

test('the Advisory Board page shows a title only when it says more than the usual one', () => {
  assert.equal(advisoryTitle({ title: ADVISORY_TITLE }), '');
  assert.equal(advisoryTitle({ title: ' Advisory Board Chair ' }), 'Advisory Board Chair');
  assert.equal(advisoryTitle({}), '');
  assert.equal(initials('Jane Q. Smith'), 'JS');
  assert.equal(initials('Cher'), 'C');
  assert.equal(initials(''), '?');
  assert.deepEqual(GROUPS.map((g) => g.id), ['team', 'board', 'advisory']);
  assert.equal(groupOf('advisory').label, 'Advisory Board');
  assert.equal(groupOf('nope').id, 'team');
});

test('Paste a list reads names and emails in the shapes people paste them', () => {
  const rows = parsePeopleList([
    'Name\tEmail',
    'Jane Smith: Jane.Smith@Example.com',
    '  Sam Lee, sam@example.org  ',
    '• Pat Doe <pat.doe@example.net>',
    '3. Lou Ray\tlou@example.com',
    'Kim Park (mailto:kim@example.com)',
    'Ana Only',
    '',
    'Bad Email: nope@',
  ].join('\n'));
  assert.deepEqual(rows.map((r) => [r.name, r.email]), [
    ['Jane Smith', 'jane.smith@example.com'],
    ['Sam Lee', 'sam@example.org'],
    ['Pat Doe', 'pat.doe@example.net'],
    ['Lou Ray', 'lou@example.com'],
    ['Kim Park', 'kim@example.com'],
    ['Ana Only', ''],
    ['Bad Email', 'nope@'],
  ], 'a header row and blank lines are left out; a broken email stays the email, for the plan to flag');
});

test('Paste a list plans each line: add, save an email, or skip with a reason', () => {
  const team = [
    { slug: 'jane-smith', name: 'Jane Smith', group: 'advisory' },
    { slug: 'sam-lee', name: 'Sam Lee', group: 'advisory' },
    { slug: 'pat-doe', name: 'Pat Doe', group: 'board' },
  ];
  const emails = { 'jane-smith': 'jane@example.com' };
  const plan = planPeopleList(parsePeopleList([
    'Jane Smith: jane@example.com',
    'Sam Lee: sam@example.com',
    'Pat Doe: pat@example.com',
    'New Person: new@example.com',
    'new person: again@example.com',
    'No Email Yet',
    ': orphan@example.com',
    'Broken Address: broken@example',
  ].join('\n')), team, 'advisory', emails);
  assert.deepEqual(plan.map((p) => [p.slug, p.act]), [
    ['jane-smith', 'skip'], ['sam-lee', 'email'], ['pat-doe', 'skip'], ['new-person', 'add'], ['new-person', 'skip'], ['no-email-yet', 'add'], ['', 'skip'], ['broken-address', 'skip'],
  ]);
  assert.equal(plan[7].note, 'The email doesn’t look right', 'a broken address is never added as part of a name');
  assert.equal(plan[0].note, 'Already here');
  assert.equal(plan[2].note, 'Already in Board of Directors', 'someone on the board isn’t moved by a paste');
  assert.equal(plan[4].note, 'Listed twice');
  assert.equal(plan[5].note, 'Adds them, no email yet');
  assert.equal(plan[6].note, 'No name');
  const replace = planPeopleList(parsePeopleList('Jane Smith: jane.new@example.com'), team, 'advisory', emails)[0];
  assert.equal(replace.act, 'email');
  assert.match(replace.note, /replaces jane@example\.com/);
  assert.equal(slugOf('Mary-Kate O’Neil'), 'mary-kate-o-neil', 'the same web address the editor would make');
});

async function world() {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  const put = (slug, data) => DB.prepare('INSERT OR REPLACE INTO team (slug, name, "group", order_num, data) VALUES (?, ?, ?, ?, ?)')
    .bind(slug, data.name, data.group, data.order ?? 0, JSON.stringify({ slug, ...data })).run();
  await put('bea-board', { name: 'Bea Board', title: 'Board Member', group: 'board' });
  await put('ava-advisor', { name: 'Ava Advisor', title: ADVISORY_TITLE, group: 'advisory', order: 0 });
  await put('al-advisor', { name: 'Al Advisor', title: ADVISORY_TITLE, group: 'advisory', order: 1 });
  return DB;
}

test('advisors keep private reveal emails beside the board’s, and join every invite with the board', async () => {
  const DB = await world();
  await DB.prepare('INSERT INTO team (slug, name, "group", order_num, data) VALUES (?, ?, ?, ?, ?)')
    .bind('old-advisor', 'Old Advisor', 'advisory', 2, JSON.stringify({ name: 'Old Advisor', group: 'advisory', order: 2, status: 'alumni' })).run();
  await setBoardEmail(DB, 'bea-board', 'bea@example.com');
  await setBoardEmail(DB, 'ava-advisor', ' Ava@Example.com ');
  await setBoardEmail(DB, 'old-advisor', 'old@example.com');
  const advisory = await boardRoster(DB, 'advisory');
  assert.deepEqual(advisory.map((m) => [m.slug, m.email]), [['ava-advisor', 'ava@example.com'], ['al-advisor', null], ['old-advisor', 'old@example.com']]);
  assert.deepEqual((await boardRoster(DB)).map((m) => m.slug), ['bea-board'], 'the board roster is the board only');
  const board = await fetchBoard({ DB });
  assert.deepEqual(board.map((x) => x.email), ['bea@example.com', 'ava@example.com'], 'invites reach the board and active advisors with an email; alumni never');
  const g = guestGroups({ aces: { nodes: [] }, location: { account: { contacts: { nodes: [] } } } }, [], board);
  assert.deepEqual(g.board.map((p) => [p.email, p.kind]), [['bea@example.com', 'board'], ['ava@example.com', 'advisory board']], 'the preview names an advisor as one');
  assert.ok(!('advisory' in g.board[1]), 'the marker stays out of the guest');
});

test('who gets reveal invites: active board and advisory members, drafts too', () => {
  assert.equal(getsRevealInvites({ name: 'A', group: 'advisory' }), true);
  assert.equal(getsRevealInvites({ name: 'A', group: 'advisory', publishStatus: 'draft' }), true);
  assert.equal(getsRevealInvites({ name: 'A', group: 'advisory', status: 'alumni' }), false);
  assert.equal(getsRevealInvites({ name: 'B', group: 'board' }), true);
  assert.equal(getsRevealInvites({ name: 'T', group: 'team' }), false);
  assert.equal(onActiveBoard({ name: 'A', group: 'advisory' }), false, 'the board itself is still the board');
});

test('People → Advisory saves an advisor’s reveal email, and open invites follow', async () => {
  const DB = await world();
  const waits = [];
  const post = (body) => invitesAdminPost({
    env: { DB },
    data: { userEmail: 'staff@soardcharity.com' },
    request: new Request('https://x/api/reveal-invites-admin', { method: 'POST', body: JSON.stringify(body) }),
    waitUntil: (p) => waits.push(p),
  });
  let res = await post({ boardEmail: { slug: 'al-advisor', email: 'al@example.com' } });
  let d = await res.json();
  assert.equal(d.ok, true, d.error);
  assert.equal(waits.length, 1, 'an advisor’s email brings open invites up to date');
  assert.equal((await boardRoster(DB, 'advisory')).find((m) => m.slug === 'al-advisor').email, 'al@example.com');
  const audit = await DB.prepare('SELECT entity_name FROM audit_log ORDER BY id DESC LIMIT 1').first();
  assert.equal(audit.entity_name, 'Reveal invite email for Al Advisor');

  res = await post({ boardEmail: { slug: 'bea-board', email: 'bea@example.com' } });
  d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(waits.length, 2, 'a board member’s too');

  res = await post({ boardEmail: { slug: 'nobody', email: 'x@example.com' } });
  d = await res.json();
  assert.equal(d.ok, false);
  assert.match(d.error, /Advisory Board/);
});
