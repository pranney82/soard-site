/**
 * A shorter version of a report (the site's model), offered beside it on the board page and in Board: it only comes
 * back saying the same things (every figure and link was there, every figure still is, every heading kept, really
 * shorter), only to who presents the item (or an admin), and only so often. Made-up people only (the repo is public).
 *
 *   node --test tests/board-shorter.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, getMeeting } from '../functions/api/_board.js';
import { shorterReport, shorterFor, cleanAnswer, figuresOf, figureList, linksOf, shorterProblem } from '../functions/api/_board-shorter.js';
import { onRequestPost as portalPost } from '../functions/api/board-portal.js';

const PEOPLE = [
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair' }],
  ['sam-ortiz', { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer' }],
  ['kim-park', { name: 'Kim Park', group: 'board', title: 'Board Member' }],
];
const REPORT = `### Where we are
Cash in the bank is $412,000 at the end of October, which is up 12% on the same time last year, and the reserve fund is fully funded again after the summer. The audit came back clean with no findings at all this year.

### What the board needs to decide
We ask the board to approve moving $150,000 of the reserve into a money market account, as the finance committee recommended at its meeting on October 21. The details are on [the finance page](https://example.org/finance).`;
const SHORT = `### Where we are
- Cash: $412,000 at October's end, up 12% on last year
- Reserve fully funded; the audit is clean

### What the board needs to decide
- Move $150,000 of the reserve to a money market account (finance committee, October 21; [the finance page](https://example.org/finance))`;

let env;
let answer;
let calls;
const fakeAI = () => ({ run: async (model, opts) => { calls.push({ model, opts }); return { response: typeof answer === 'function' ? answer(opts) : answer }; } });

beforeEach(async () => {
  env = { DB: await createD1(), AI: fakeAI() };
  answer = SHORT;
  calls = [];
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  await saveMeeting(env.DB, {
    id: 'm_short1', date: '2099-11-05', start: '08:00', end: '10:00', shared: true,
    sections: [{ id: 's_rep1', title: 'Committee reports', items: [{ id: 'i_fin1', title: 'Financial', who: ['sam-ortiz'], report: REPORT }] }],
  }, { by: 'jane@soardcharity.com' });
});

test('the happy path: shorter, the same figures, links and headings → the proposal, nothing saved', async () => {
  const r = await shorterReport(env, REPORT, { title: 'Financial' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, SHORT);
  assert.ok(r.words[1] < r.words[0] * 0.85, `${r.words}`);
  assert.equal(calls.length, 1);
  assert.match(calls[0].model, /llama-3\.3-70b/);
  assert.equal(calls[0].opts.response_format, undefined, 'plain text, not JSON mode');
  assert.match(calls[0].opts.messages[1].content, /Financial/);
  assert.match(calls[0].opts.messages[1].content, /\$412,000/);
});

test('a figure it made up, or one it changed, is refused: theirs stays', async () => {
  answer = SHORT.replace('up 12%', 'up 12% (about 40 families)');
  assert.deepEqual(await shorterReport(env, REPORT), { ok: false, error: 'A shorter version would have changed the facts, so yours stays as it is.' });
  answer = SHORT.replace('$412,000', '$410,000');
  assert.equal((await shorterReport(env, REPORT)).ok, false);
  // "1.5k" for "1,500" isn't the same figure as written
  const withK = REPORT.replace('$150,000', '$1,500');
  answer = SHORT.replace('$150,000', '$1.5k');
  assert.equal((await shorterReport(env, withK)).ok, false);
});

test('a figure of theirs it left out is refused too (a cut off answer can never pass)', async () => {
  answer = SHORT.replace(', October 21', '');
  const r = await shorterReport(env, REPORT);
  assert.equal(r.ok, false);
  assert.match(r.error, /left out some of your figures/);
});

test('a link that wasn’t in theirs is refused', async () => {
  answer = `${SHORT}\n- More at https://evil.example.com/x`;
  assert.equal((await shorterReport(env, REPORT)).ok, false);
  answer = SHORT.replace('https://example.org/finance', 'https://example.org/finance2');
  assert.equal((await shorterReport(env, REPORT)).ok, false);
});

test('a heading of theirs it lost is refused', async () => {
  answer = SHORT.replace('### What the board needs to decide\n', '');
  const r = await shorterReport(env, REPORT);
  assert.equal(r.ok, false);
  assert.match(r.error, /headings/);
});

test('not really shorter (under 15% less) is refused', async () => {
  answer = REPORT.replace('fully funded again after the summer', 'fully funded again');
  const r = await shorterReport(env, REPORT);
  assert.equal(r.ok, false);
  assert.match(r.error, /couldn’t be made much shorter/);
});

test('a fenced answer, or one with "Here is…" before it and "Let me know…" after, is read as the report alone', async () => {
  answer = `Here is a shorter version of the report:\n\n\`\`\`markdown\n${SHORT}\n\`\`\`\n\nLet me know if you'd like any changes.`;
  const r = await shorterReport(env, REPORT);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, SHORT);
  assert.equal(cleanAnswer(`Sure! Here’s the shortened report:\n${SHORT}`), SHORT);
  assert.equal(cleanAnswer(`\`\`\`\n${SHORT}\n\`\`\``), SHORT);
});

test('empty, already short, too long, no model, or the model failing: a plain reason, never a throw', async () => {
  assert.equal((await shorterReport(env, '')).ok, false);
  assert.match((await shorterReport(env, 'Cash is up.')).error, /already short/);
  assert.match((await shorterReport(env, Array.from({ length: 3100 }, (_, i) => `w${i}`).join(' '))).error, /too long/);
  assert.match((await shorterReport({ DB: env.DB }, REPORT)).error, /aren’t available/);
  env.AI = { run: async () => { throw new Error('5xx'); } };
  assert.match((await shorterReport(env, REPORT)).error, /couldn’t be written just now/);
  answer = '';
  env.AI = fakeAI();
  assert.match((await shorterReport(env, REPORT)).error, /came back empty/);
});

test('the figures and links read as written', () => {
  assert.deepEqual([...figuresOf('1. Cash $412,000 (12%)\n2. 3.50 and 7.0')].sort(), ['$412000', '12%', '3.5', '7']);
  assert.deepEqual(figureList('Net -$4,000, 2025-26, $1.2M, 1.5k, 40 %, $1.2 million'), ['-$4000', '2025', '26', '$1.2M', '1.5K', '40%', '$1.2M']);
  assert.deepEqual([...linksOf('[a](https://a.example/x) and https://b.example/y.')].sort(), ['https://a.example/x', 'https://b.example/y']);
  assert.deepEqual([...linksOf('Go to www.soard.example, <mailto:a@b.example> or tel:+14045551234.')].sort(), ['mailto:a@b.example', 'tel:+14045551234', 'www.soard.example']);
});

test("a shorter version that changes a fact is refused: a sign, a unit, a size, figures swapped or moved, a new link, a new heading", () => {
  const fill = ' The committee met twice this quarter and read every application that came in, and the families were told within a week what the committee decided about their homes.';
  const short = ' The committee met twice and told families within a week.';
  const changed = [
    ['Net -$4,000 this year, and the store made $31,000.', 'Net $4,000; the store $31,000.'],
    ['Attendance was up 40% at the gala.', 'Attendance up $40 at the gala.'],
    ['We raised $1.2 million in the campaign.', 'Raised $1.2 billion in the campaign.'],
    ['Revenue was $500,000 and expenses $300,000 this quarter.', 'Revenue $300,000, expenses $500,000.'],
    ['The gala is Nov 5 with 12 tables sold so far.', 'Gala Nov 12, 5 tables sold.'],
    ['See our page for details on the event.', 'See www.evil-phish.example for details.'],
    ['Email the office for details on the event.', 'Email <mailto:bad@evil.example> for details.'],
    ['### Where we are\n\nWe raised $1.2 million.', '### Where we are\n\nRaised $1.2 million.\n\n### Give now'],
  ];
  for (const [mine, theirs] of changed) assert.match(shorterProblem(mine + fill, theirs + short), /changed the facts/, theirs);
  // The same facts, shorter: kept
  assert.equal(shorterProblem(`Net -$4,000 this year, and the store made $31,000.${fill}`, `Net -$4,000; store $31,000.${short}`), '');
});

test('10 a minute each, then a plain "try again in a minute" (429); another person still can', async () => {
  const admin = { admin: true, adminEmail: 'jane@soardcharity.com' };
  for (let i = 0; i < 10; i++) assert.equal((await shorterFor(env, { text: REPORT, title: 'Financial' }, admin)).ok, true);
  await assert.rejects(shorterFor(env, { text: REPORT }, admin), (e) => e.status === 429 && /in a minute/.test(e.message));
  assert.equal((await shorterFor(env, { text: REPORT }, { admin: true, adminEmail: 'max@soardcharity.com' })).ok, true);
});

const asMember = (slug, body) => portalPost({
  env,
  request: new Request('https://soardcharity.com/api/board-portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  data: { boardMember: { slug, name: PEOPLE.find(([s]) => s === slug)[1].name, email: `${slug}@example.org` }, userEmail: `${slug}@example.org` },
});

test('the board page: who presents the item gets a proposal; another member is refused (403); nothing is saved', async () => {
  const ok = await asMember('sam-ortiz', { action: 'report-shorter', id: 'm_short1', itemId: 'i_fin1', text: REPORT });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.ok, true, j.error);
  assert.equal(j.text, SHORT);
  assert.match(calls[0].opts.messages[1].content, /The agenda item: Financial/);
  const no = await asMember('kim-park', { action: 'report-shorter', meetingId: 'm_short1', itemId: 'i_fin1', text: REPORT });
  assert.equal(no.status, 403);
  assert.equal(calls.length, 1, 'the model never asked for someone not presenting');
  assert.equal((await getMeeting(env.DB, 'm_short1')).sections[0].items[0].report, REPORT);
});
