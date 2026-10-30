/**
 * Site → Automations → Process: SOARD's process Docs read as they are, the
 * automations pinned to their steps, and who's at each stage right now
 * (public/admin/process-shared.js, functions/api/_process-docs.js).
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { byName, parseProcessHtml, policySections, approvalTiers, retiredMentions, reviewOf, placeNow, mapOf, laneOf, timeOf, pickDoc, docIdOf, pinSteps, lineCounts, ruleTitles, APPLYING, MONEY, MONEY_TRACKS, GOOGLE_DOC } from '../public/admin/process-shared.js';
import { processDocs, processFacts, pipelineNow, policyChecks, setOverride, maybeRefreshProcess, readReviews, markReviewed, maybeTellReviews, cycleTimes, reviewEmail, CHECK_MS, REFRESH_MS } from '../functions/api/_process-docs.js';
import { JT_URL } from '../functions/api/_reveals.js';
import { entries, applyFacts } from '../public/admin/automations.js';

// ─── A Doc the way Drive exports it ───────
// Google writes a nested list as flat lists side by side, one per level
// ("lst-kix_<id>-<level>"), and spells quotes and ampersands as entities.
function exportOf(title, outline) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/’/g, '&rsquo;').replace(/…/g, '&hellip;').replace(/</g, '&lt;');
  let out = `<html><head><style>.c1{color:#000}</style></head><body class="c9 doc-content"><p class="c4"><span style="overflow: hidden; display: inline-block;"><img src="x"></span></p><p class="c4 title"><span class="c7">${esc(title)}</span></p>`;
  let level = null;
  for (const line of outline.trim().split('\n')) {
    const [, lv, t] = line.match(/^(\s*)(.*)$/);
    const l = lv.length / 2;
    if (l !== level) {
      if (level !== null) out += '</ol>';
      out += `<ol class="c3 lst-kix_9xk2abc-${l} start" start="1">`;
      level = l;
    }
    out += `<li class="c2 li-bullet-0"><span class="c0">${esc(t)}</span></li>`;
  }
  return `${out}</ol></body></html>`;
}
// The 2026 Docs' own wording, for the lines the rules read
const MAKEOVER = `
Onsite
  Performed by makeover team
  Designer & PM get digital documentation,
Child’s Approval
  Internal team chooses who moves forward in process based on fit, resources, location & scope
  Phone call to family
  JT sends family message
  Schedule family photo session
  Create webpage
  Project Summary Letter written
    Designer Zoom with family to review
Design Charrette
  Makeover team, Executive Board, Designers & Sponsors can attend
Approval
  External - family signs approval documents
    Scope of Work & Approved Layout
Apply for permit
Mobilization
  PM order building materials
  Schedule trades
  Set start date, tag internal, Sponsor & Board for start date
Demo Day
  Sponsor, Designer & PM attend
Project in Progress
  Keep Sponsor up to date as project progresses
  Set Reveal Day no later than 2 weeks out
    Invite Board, Sponsor, Vendors, local media…
    Set Photographer & Videographer
Reveal Day
Post-Construction
  Designer visit job one week after Reveal
    Bring folder with resources
      Blank Thank You cards
  Director of Development touch base 6 months out`;
const COMMUNITY = `
Referred to us
Fill out online application
  Executive SOARD team review
Onsite
  Designer & PM get digital documentation, scans
Approval
  Phone call to community project team lead
  JT job created
  Create webpage
Approval
  External - community project team lead signs off on selections and budget approval documents
Mobilization
  Schedule trades
  Set start date, tag internal, Sponsor & Board for start date
Demo Day
  SOARD team & community partner team attends`;

// The board's Financial Policy Manual the way Drive exports it: a contents list
// of paragraphs, SECTION headings, and each section a list whose first item is its title
const POLICY_HTML = `<html><body class="doc-content">
<p class="title"><span>Financial Policy Manual</span></p><p><span>Table of Contents</span></p>
<p><span>SECTION I:&nbsp; ACCOUNTING AND FINANCIAL POLICIES&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;2</span></p>
<p><span>A.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Accounting&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;2</span></p>
<p><span>D.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Contributions&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;6</span></p>
<p><span>C.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Expenditures&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;9</span></p>
<p><span>D.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Accounting and Controls of Checks&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;10</span></p>
<p><span>INTRODUCTION</span></p><p><span>It is the responsibility of every employee&hellip;</span></p>
<h1><span>SECTION I:&nbsp; ACCOUNTING AND FINANCIAL POLICIES</span></h1>
<ol class="lst-kix_a-0 start" start="1"><li><span>Accounting</span></li></ol>
<ol class="lst-kix_a-1 start" start="1"><li><span>Quarterly Financial Statements.</span></li></ol>
<ol class="lst-kix_a-2 start" start="1"><li><span>The President will prepare the quarterly financial statements within 30 business days.</span></li><li><span>The bookkeeper will record checks to QuickBooks.</span></li></ol>
<ol class="lst-kix_a-0" start="4"><li><span>Contributions</span></li></ol>
<ol class="lst-kix_a-1 start" start="1"><li><span>Organization will send a written acknowledgement of all contributions.</span></li></ol>
<h1><span>SECTION II:&nbsp; INTERNAL CONTROL AND RISK REDUCTION POLICIES</span></h1>
<ol class="lst-kix_b-0 start" start="3"><li><span>Expenditures</span></li></ol>
<p><span>Tier 1</span></p><p><span>Item cost: Less than or equal to $15,000.00.</span></p><p><span>Required approval: President</span></p>
<p><span>Tier 2</span></p><p><span>Item cost: Greater than $15,000.00</span></p><p><span>Required approval: Board Chair</span></p>
<ol class="lst-kix_b-0" start="4"><li><span>Accounting and Controls of Checks</span></li></ol>
<ol class="lst-kix_b-1 start" start="1"><li><span>Checks received not yet deposited must be kept in a locked drawer.</span></li></ol>
<p><span>Exhibit A</span></p><p><span>Investment Authorization Form</span></p>
</body></html>`;

// The money Docs as written on Oct 29 2026 (enough of each to read its rules)
const PAYABLES = `
Buying for a makeover
  Staff buy on their SOARD cards, within the limit set for each card
  Each charge is sorted onto its makeover, the store or operating
  A charge that looks wrong is flagged: twice in a day, far over the usual, a new monthly charge
Receipts
  A receipt in anyone’s inbox goes to the receipt inbox (ap@) on its own
  Charges still without a receipt after 2 days are listed each weekday morning
Approving a bill
  A sub’s bill lands in JobTread and its approver is asked by email
  Up to $15,000 the President approves; over $15,000 the Board Chair approves too
Paying
  Approved bills are paid from Mercury, and each payment is recorded on its bill
  Bills are paid within 30 days of the invoice
  Card balances are paid before they’re due
Reimbursing staff and volunteers
  Expenses are approved in writing first, with receipts
Year end
  Vendors’ W-9s go to Mercury
  A 1099 for every vendor paid $600 or more`;
const RECEIVABLES = `
Gifts online
  Donors give through Zeffy on the donate page, the live page and the golf page, and during a live reveal
  The team hears about each gift as it comes in, with major gifts called out
  Every gift is acknowledged in writing, with the amount
Checks by mail
  The President opens the mail and each check is recorded
  Checks not yet deposited stay in the locked drawer`;
const BOOKS = `
Budget and cash
  The year’s budget goes to the board for approval
  Cash 13 weeks ahead, with a heads-up when it dips under the floor
Audit or review
  A CPA firm audits or reviews the year’s statements`;

const flat = (steps) => steps.flatMap((s) => [s, ...(function walk(items) { return items.flatMap((i) => [i, ...walk(i.items)]); })(s.items)]);
const line = (steps, text) => flat(steps).find((x) => x.t === text);

// ─── The Doc ──────────────────────────────

test('a Doc’s numbered list becomes its steps, with the work and notes under each', () => {
  const { title, steps } = parseProcessHtml(exportOf('2026 Sunshine Makeover Process', MAKEOVER));
  assert.equal(title, '2026 Sunshine Makeover Process');
  assert.deepEqual(steps.map((s) => s.t), ['Onsite', 'Child’s Approval', 'Design Charrette', 'Approval', 'Apply for permit', 'Mobilization', 'Demo Day', 'Project in Progress', 'Reveal Day', 'Post-Construction']);
  assert.equal(steps[1].items.length, 6);
  assert.equal(steps[1].items[5].t, 'Project Summary Letter written');
  assert.deepEqual(steps[1].items[5].items.map((i) => i.t), ['Designer Zoom with family to review']);
  // Entities read as the characters they are
  assert.equal(steps[0].items[1].t, 'Designer & PM get digital documentation,');
  assert.equal(steps[7].items[1].items[0].t, 'Invite Board, Sponsor, Vendors, local media…');
  // Four levels deep
  assert.equal(steps[9].items[0].items[0].items[0].t, 'Blank Thank You cards');
  assert.deepEqual(steps[4].items, []);
});

test('a skipped level hangs on the line before it; empty items, comments and stray paragraphs aren’t steps', () => {
  const html = `<body><p class="title"><span>Process</span></p>
    <ol class="lst-kix_a-0 start" start="1"><li><span>One</span></li></ol>
    <ol class="lst-kix_a-2 start" start="1"><li><span>Deep note<sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup></span></li><li><span> </span></li></ol>
    <p><span>A paragraph between lists</span></p>
    <ol class="lst-kix_a-0" start="2"><li><span>Two&nbsp;&amp;&#160;three</span></li></ol>
    <ul class="lst-kix_b-1 start"><li><span>Bulleted&#x2019;s line</span></li></ul>
    <div><p><a href="#cmnt_ref1" id="cmnt1">[a]</a><span>A comment</span></p></div></body>`;
  const { title, steps } = parseProcessHtml(html);
  assert.equal(title, 'Process');
  assert.deepEqual(steps, [
    { t: 'One', items: [{ t: 'Deep note', items: [] }] },
    { t: 'Two & three', items: [{ t: 'Bulleted’s line', items: [] }] },
  ]);
  assert.deepEqual(parseProcessHtml('').steps, []);
});

test('the Doc a track follows: the latest year, a Google Doc by that name, never a copy when the real one is there', () => {
  const f = (id, name, extra = {}) => ({ id, name, mimeType: GOOGLE_DOC, modifiedTime: '2026-10-28T12:00:00Z', ...extra });
  const files = [
    f('pdf', '2026 Sunshine Makeover Process.pdf', { mimeType: 'application/pdf' }),
    f('old', '2025 Sunshine Makeover Process', { modifiedTime: '2026-10-29T00:00:00Z' }),
    f('now', '2026 Sunshine Makeover Process'),
    f('copy', 'Copy of 2027 Sunshine Makeover Process'),
    f('graph', 'SOARD Makeover Process Graph'),
    f('expect', 'Makeover Process and Expectations for Families'),
    f('bin', '2027 Sunshine Makeover Process', { trashed: true }),
    f('org', '2026 Sunshine Community Project Process'),
  ];
  assert.equal(pickDoc(files, 'makeover').id, 'now');
  assert.equal(pickDoc(files, 'community').id, 'org');
  assert.equal(pickDoc([files[3]], 'makeover').id, 'copy', 'a copy, when it’s all there is');
  assert.equal(pickDoc([f('a', '2026 Sunshine Makeover Process', { modifiedTime: '2026-01-01T00:00:00Z' }), f('b', '2026 Sunshine Makeover Process')], 'makeover').id, 'b');
  assert.equal(pickDoc(files.slice(0, 2).concat(files.slice(4, 6)), 'community'), null);
});

test('a pasted Doc link gives its id', () => {
  const id = '1GOa57Ut9BjKgM63tujH294P-4kO8TnHnlbiFZdFZonA';
  assert.equal(docIdOf(`https://docs.google.com/document/d/${id}/edit?tab=t.0`), id);
  assert.equal(docIdOf(`https://docs.google.com/document/u/1/d/${id}/mobilebasic`), id);
  assert.equal(docIdOf(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(docIdOf(id), id);
  assert.equal(docIdOf('https://drive.google.com/drive/folders/abc'), '');
  assert.equal(docIdOf('2026 Sunshine Makeover Process'), '');
});

// ─── What runs on its own at each step ────

test('every automation the steps name is on the map, once (under its name, or the one it was renamed to)', () => {
  const names = new Map();
  for (const n of entries) names.set(n.t, (names.get(n.t) || 0) + 1);
  const found = byName(entries);
  for (const t of ruleTitles()) {
    assert.ok(found.has(t), `“${t}” is on Site → Automations`);
    if (names.has(t)) assert.equal(names.get(t), 1, `“${t}” is there once`);
  }
});

test('the makeover Doc’s lines get the automations that do them; the rest is by hand', () => {
  const steps = pinSteps('makeover', parseProcessHtml(exportOf('x', MAKEOVER)).steps);
  // The website's part first, then the Doc's steps with the Doc's numbers
  assert.deepEqual(steps.filter((s) => s.part === 'applying').map((s) => s.t), APPLYING.map((s) => s.t));
  assert.deepEqual(steps.filter((s) => s.part === 'doc').map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(line(steps, 'JT sends family message').autos, ['Status → family message', 'Status change summary']);
  assert.deepEqual(line(steps, 'Create webpage').autos, ['Approved → job and its page', 'Kid and project status follow JobTread']);
  assert.deepEqual(line(steps, 'Internal team chooses who moves forward in process based on fit, resources, location & scope').autos, ['Makeover scoring']);
  assert.deepEqual(line(steps, 'External - family signs approval documents').autos, ['Scope approved → Mobilization']);
  assert.deepEqual(line(steps, 'Set start date, tag internal, Sponsor & Board for start date').autos, ['Demo day invites', 'Demo Day page']);
  assert.ok(line(steps, 'Set Reveal Day no later than 2 weeks out').autos.includes('Reveal date sync'));
  assert.deepEqual(line(steps, 'Invite Board, Sponsor, Vendors, local media…').autos, ['Invite engine', 'New guest check', 'Reveals → Now tracker', 'Invite problem alerts']);
  assert.deepEqual(line(steps, 'Sponsor, Designer & PM attend').autos, ['Demo day invites']);
  // "can attend" at the charrette isn't a demo day
  assert.deepEqual(line(steps, 'Makeover team, Executive Board, Designers & Sponsors can attend').autos, []);
  for (const t of ['Phone call to family', 'Performed by makeover team', 'Director of Development touch base 6 months out']) assert.deepEqual(line(steps, t).autos, [], `${t}: by hand`);
  // A step's own automations leave out what one of its lines already shows
  const mob = steps.find((s) => s.t === 'Mobilization');
  assert.ok(mob.autos.includes('Monetary sponsor ↔ JobTread'));
  assert.ok(!mob.autos.includes('Vendors on their JobTread jobs'), 'already on “Schedule trades”');
  assert.ok(steps.find((s) => s.t === 'Reveal Day').autos.includes('Phone stream (Larix)'));
  assert.deepEqual(steps.find((s) => s.t === 'Apply for permit').autos, []);
  // The website's steps keep their own automations, not the Doc's rules for their names
  assert.deepEqual(steps.filter((s) => s.part === 'applying').flatMap((s) => s.autos), []);
  const c = lineCounts(steps);
  assert.ok(c.auto > 10 && c.auto < c.lines);
});

test('who’s where: each JobTread status lands on the Doc step it means, in either process', () => {
  const now = { applied: { n: 2, names: [] }, inReview: { n: 1, names: [] }, jobs: { 'On Site': { n: 0, names: [] }, 'Awaiting Funding': { n: 1, names: [{ name: 'Amari' }] }, Design: { n: 1, names: [] }, Approval: { n: 1, names: [] }, Mobilization: { n: 1, names: [] }, Build: { n: 3, names: [] } } };
  const at = (track, outline) => {
    const steps = pinSteps(track, parseProcessHtml(exportOf('x', outline)).steps);
    return Object.fromEntries([...placeNow(track, steps, now)].map(([k, v]) => [steps.find((s) => `${s.part}-${s.n}` === k).t + (k.startsWith('doc') ? ` (${k.split('-')[1]})` : ''), v.map((x) => `${x.status} ${x.n}`).join(', ')]));
  };
  assert.deepEqual(at('makeover', MAKEOVER), {
    'Application submitted': 'Applied 2', 'Onsite (1)': 'In Review 1', 'Child’s Approval (2)': 'Awaiting Funding 1', 'Design Charrette (3)': 'Design 1',
    'Approval (4)': 'Approval 1', 'Mobilization (6)': 'Mobilization 1', 'Project in Progress (8)': 'Build 3',
  });
  // Two Approval steps: an approved project waits at the first, the design's approval is the last
  assert.deepEqual(at('community', COMMUNITY), {
    'Fill out online application (2)': 'Applied 2', 'Onsite (3)': 'In Review 1', 'Approval (4)': 'Awaiting Funding 1', 'Approval (5)': 'Approval 1', 'Mobilization (6)': 'Mobilization 1',
  });
  assert.equal(placeNow('makeover', [], now).size, 0);
  assert.equal(placeNow('makeover', pinSteps('makeover'), null).size, 0);
});

test('the map: each task in the lane of who does it, by how the Doc words it', () => {
  assert.deepEqual(laneOf('Designer prepare existing & proposed layouts to present to family'), { lane: 'designer', with: ['family'] });
  assert.deepEqual(laneOf('PMs build budget/schedule, Designer completes selections/budget'), { lane: 'pm', with: ['designer'] });
  assert.deepEqual(laneOf('Review Scope of Work and plan set with Designer, modify as needed', 'PM Review'), { lane: 'pm', with: ['designer'] }, '“with Designer”: the PM does it');
  assert.deepEqual(laneOf('Designer present/upload mood board to kick off approvals'), { lane: 'designer', with: [] }, 'a mood board isn’t the board');
  assert.deepEqual(laneOf('JT sends family message'), { lane: 'auto', with: [] });
  assert.deepEqual(laneOf('Family complete pre-makeover survey'), { lane: 'family', with: [] });
  assert.deepEqual(laneOf('External - family signs approval documents'), { lane: 'family', with: [] });
  assert.deepEqual(laneOf('Phone call to family'), { lane: 'team', with: ['family'] });
  assert.deepEqual(laneOf('Schedule trades'), { lane: 'pm', with: [] });
  assert.deepEqual(laneOf('Keep Sponsor up to date as project progresses'), { lane: 'team', with: ['sponsors'] });
  assert.equal(laneOf('Something new', 'Mobilization').lane, 'pm', 'no clue in the words: the step’s owner');
  assert.equal(laneOf('Something new', 'Child’s Approval').lane, 'team');
  assert.equal(timeOf('Set Reveal Day no later than 2 weeks out'), '≤ 2 weeks out');
  assert.equal(timeOf('Designer visit job one week after Reveal'), '1 week after Reveal');
  assert.equal(timeOf('Director of Development touch base 6 months out'), '6 months out');
  assert.equal(timeOf('Bills are paid within 30 days of the invoice'), '≤ 30 days');
  assert.equal(timeOf('Phone call to family'), null);
});

test('the map: a column per step, a card per task, decisions where the Doc decides, handoffs counted', () => {
  const steps = pinSteps('makeover', parseProcessHtml(exportOf('x', MAKEOVER)).steps);
  const m = mapOf('makeover', steps);
  assert.deepEqual(m.lanes.map((l) => l.label), ['Family', 'SOARD team', 'Designer', 'Project manager', 'Runs on its own']);
  assert.equal(m.columns.length, steps.length);
  const col = (t) => m.columns.find((c) => c.t === t);
  assert.deepEqual(col('Child’s Approval').decision.q, 'Approved?');
  assert.equal(col('Reviewed internally') && m.columns.filter((c) => c.decision).map((c) => c.t).join(', '), 'Reviewed internally, Child’s Approval');
  assert.deepEqual(col('Apply for permit').cards.map((c) => [c.t, c.lane, c.self]), [['Apply for permit', 'pm', true]], 'a step that is its own task gets a card');
  assert.deepEqual(col('Project in Progress').cards.find((c) => /Reveal Day/.test(c.t)).time, '≤ 2 weeks out', 'a time from the line’s own words, or its notes');
  assert.ok(col('Project in Progress').cards.find((c) => /Reveal Day/.test(c.t)).autos.includes('Invite engine'), 'a card carries its notes’ automations');
  assert.ok(col('Mobilization').autos.includes('Monetary sponsor ↔ JobTread'), 'a column carries the step’s own automations');
  assert.ok(m.handoffs >= 8, `handoffs counted (${m.handoffs})`);
  assert.equal(new Set(m.columns.flatMap((c) => c.cards.map((x) => x.order))).size, m.columns.flatMap((c) => c.cards).length, 'every card has its place in the order');
  const cm = mapOf('community', pinSteps('community', parseProcessHtml(exportOf('x', COMMUNITY)).steps));
  assert.equal(cm.lanes[0].label, 'Organization');
  assert.deepEqual(cm.columns.filter((c) => c.decision).map((c) => `${c.t} ${c.n}`), ['Approval 4'], 'the first Approval decides; the second is the design’s');
  assert.deepEqual(cm.columns.find((c) => c.t === 'Fill out online application').cards.map((c) => c.lane), ['family', 'team']);
  const pay = mapOf('payables', pinSteps('payables'));
  assert.deepEqual(pay.lanes.map((l) => l.id), ['outside', 'staff', 'president', 'chair', 'auto']);
  assert.equal(pay.columns.find((c) => c.t === 'Approving a bill').decision.q, 'Over $15,000?');
});

test('a money Doc reads the same way: its lines’ automations and who does them, each step’s policy, the approval decision', () => {
  const steps = pinSteps('payables', parseProcessHtml(exportOf('2026 Sunshine Accounts Payable Process', PAYABLES)).steps);
  assert.ok(steps.every((s) => s.part === 'doc'));
  assert.deepEqual(line(steps, 'Each charge is sorted onto its makeover, the store or operating').autos, ['Charges onto jobs, live']);
  assert.deepEqual(line(steps, 'A receipt in anyone’s inbox goes to the receipt inbox (ap@) on its own').autos, ['Receipts from inboxes']);
  assert.deepEqual(line(steps, 'Card balances are paid before they’re due').autos, [], 'by hand');
  const appr = steps.find((s) => s.t === 'Approving a bill');
  assert.deepEqual([appr.policy, appr.check, appr.decision.q], [['Expenditures', 'Segregation of Duties'], 'approvals', 'Over $15,000?']);
  assert.deepEqual(steps.find((s) => s.t === 'Year end').policy, ['IRS Form 1099']);
  const m = mapOf('payables', steps);
  const lane = (t) => m.columns.flatMap((c) => c.cards).find((c) => c.t === t)?.lane;
  assert.equal(lane('Staff buy on their SOARD cards, within the limit set for each card'), 'staff');
  assert.equal(lane('A sub’s bill lands in JobTread and its approver is asked by email'), 'president');
  assert.equal(lane('Up to $15,000 the President approves; over $15,000 the Board Chair approves too'), 'chair');
  assert.equal(lane('Vendors’ W-9s go to Mercury'), 'auto', 'a vendor named as the object isn’t the one doing it');
  assert.equal(lane('Card balances are paid before they’re due'), 'president');
  assert.equal(m.columns.find((c) => c.t === 'Approving a bill').decision.q, 'Over $15,000?');
  const gifts = mapOf('receivables', pinSteps('receivables', parseProcessHtml(exportOf('x', RECEIVABLES)).steps));
  assert.equal(gifts.columns[0].cards[0].lane, 'outside');
  assert.equal(gifts.columns.find((c) => c.t === 'Checks by mail').cards[0].lane, 'president');
  const books = mapOf('books', pinSteps('books', parseProcessHtml(exportOf('x', BOOKS)).steps));
  assert.deepEqual(books.columns.flatMap((c) => c.cards.map((x) => x.lane)), ['president', 'auto', 'outside']);
  // No money Doc: the built-in steps stand in
  assert.equal(pinSteps('payables', [])[0].part, 'money');
});

test('a community project: the application is the Doc’s own step, and makeover-only automations stay off', () => {
  const steps = pinSteps('community', parseProcessHtml(exportOf('x', COMMUNITY)).steps);
  assert.ok(steps.every((s) => s.part === 'doc'));
  const apply = steps.find((s) => s.t === 'Fill out online application');
  assert.ok(apply.autos.includes('Community project application'));
  assert.ok(!apply.autos.includes('Makeover application'));
  assert.deepEqual(line(steps, 'Executive SOARD team review').autos, ['Admin → Applicants', 'JobTread → Applicants sync', 'Status → family message', 'Family emails → JobTread']);
  assert.deepEqual(line(steps, 'JT job created').autos, ['Approved → job and its page', 'Kid photo as the job’s cover']);
  assert.deepEqual(line(steps, 'External - community project team lead signs off on selections and budget approval documents').autos, ['Scope approved → Mobilization']);
  assert.deepEqual(line(steps, 'SOARD team & community partner team attends').autos, ['Demo day invites']);
  assert.ok(!steps.find((s) => s.t === 'Mobilization').autos.includes('Monetary sponsor ↔ JobTread'), 'sponsors are for kids only');
  assert.ok(!flat(steps).some((x) => x.autos?.includes('Makeover scoring')));
});

test('the manual reads by its contents: each section from its title to the next, exhibits left out', () => {
  const sections = policySections(POLICY_HTML);
  assert.deepEqual(sections.map((x) => x.t), ['Accounting', 'Contributions', 'Expenditures', 'Accounting and Controls of Checks']);
  assert.deepEqual(sections[0].lines.map((l) => l.t), ['Quarterly Financial Statements.', 'The President will prepare the quarterly financial statements within 30 business days.', 'The bookkeeper will record checks to QuickBooks.']);
  assert.deepEqual(retiredMentions(sections), [{ word: 'QuickBooks', now: 'the books are in Mercury Books', sections: ['Accounting'], count: 1 }]);
  assert.deepEqual(retiredMentions([{ t: 'Budget', lines: [{ t: 'Mercury Books is the books.' }] }]), []);
  assert.equal(sections[2].lines.length, 6, 'the tiers are paragraphs in the section');
  assert.ok(!sections.at(-1).lines.some((l) => /Investment Authorization/.test(l.t)), 'an exhibit isn’t part of the last section');
  assert.deepEqual(approvalTiers(sections), [{ over: 0, by: 'President' }, { over: 15000, by: 'Board Chair' }]);
  assert.deepEqual(policySections('<body><p>No contents here</p></body>'), []);
});

test('the money side: each step’s automations are on the map, its policy sections are the manual’s, by-hand lines stay by hand', () => {
  const titles = new Set(entries.map((n) => n.t));
  const manual = ['Accounting', 'Budget', 'Investment Policy', 'Contributions', 'Expense Reimbursements', 'Check Preparation and Mailing', 'Sales Tax Collection', 'Fixed Asset Policy', 'IRS Form 1099', 'Bank Statements', 'Credit Cards', 'Expenditures', 'Accounting and Controls of Checks', 'Reserve Fund Policy', 'Payroll Direct Deposit', 'Segregation of Duties', 'Wire Transfers'];
  for (const t of MONEY_TRACKS) {
    const steps = pinSteps(t);
    assert.ok(steps.length >= 5 && steps.every((s) => s.part === 'money'), t);
    for (const s of steps) {
      for (const p of s.policy || []) assert.ok(manual.includes(p), `${s.t}: “${p}” is a section of the 2025 manual`);
      for (const x of flat([s])) for (const a of x.autos || []) assert.ok(byName(entries).has(a), `${a} is on the map`);
    }
  }
  const pay = pinSteps('payables');
  assert.equal(pay.find((s) => s.t === 'Approving a bill').check, 'approvals');
  assert.deepEqual(line(pay, 'Card balances are paid before they’re due').autos, [], 'by hand');
  assert.deepEqual(line(pinSteps('receivables'), 'Checks are opened, recorded, kept locked and deposited').autos, []);
  assert.equal(MONEY.payables.length, pay.length);
});

test('the yearly review: a year after the Doc last changed or was marked reviewed; a past year’s process Doc is due at once', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const manual = { name: '2025 FINAL- Board Financial Policy Manual with Exhibits', modifiedTime: '2025-11-13T15:00:00.000Z' };
  assert.deepEqual(reviewOf(manual, { now }), { state: 'soon', dueAt: '2026-11-13T15:00:00.000Z', last: '2025-11-13T15:00:00.000Z' });
  assert.equal(reviewOf(manual, { now: Date.parse('2026-12-01T12:00:00Z') }).state, 'due');
  assert.equal(reviewOf(manual, { now: Date.parse('2026-12-01T12:00:00Z'), reviewedAt: '2026-11-20T12:00:00.000Z' }).state, 'ok', 'marked reviewed: due a year on');
  assert.equal(reviewOf(manual, { now: Date.parse('2026-06-01T12:00:00Z') }).state, 'ok');
  assert.equal(reviewOf(manual, { now: Date.parse('2027-01-02T12:00:00Z') }).nextYear, undefined, 'the manual isn’t a yearly Doc');
  const mk = { name: '2026 Sunshine Makeover Process', modifiedTime: '2026-10-28T15:00:00.000Z' };
  assert.equal(reviewOf(mk, { yearly: true, now }).state, 'ok');
  assert.deepEqual(reviewOf(mk, { yearly: true, now: Date.parse('2027-01-05T12:00:00Z') }), { state: 'due', dueAt: '2027-01-01T00:00:00.000Z', last: '2026-10-28T15:00:00.000Z', nextYear: 2027 });
  assert.equal(reviewOf(mk, { yearly: true, now: Date.parse('2027-01-05T12:00:00Z'), reviewedAt: '2027-01-04T12:00:00.000Z' }).state, 'ok', 'kept for the new year on purpose');
  assert.equal(reviewOf({ name: 'x' }), null);
});

// ─── Reading the Docs from Drive ──────────

const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
let env;
let g;
beforeEach(async () => {
  clearTokenCache();
  env = { DB: await createD1(), GOOGLE_CALENDAR_KEY: JSON.stringify({ type: 'service_account', client_email: 'reader@example.iam.gserviceaccount.com', client_id: '1', private_key: SA_PEM }) };
  g = {
    files: {
      mk: { id: 'mk', name: '2026 Sunshine Makeover Process', mimeType: GOOGLE_DOC, modifiedTime: '2026-10-28T15:00:00.000Z', webViewLink: 'https://docs.google.com/document/d/mk/edit', lastModifyingUser: { displayName: 'Clareece Cunningham' }, html: exportOf('2026 Sunshine Makeover Process', MAKEOVER) },
      co: { id: 'co', name: '2026 Sunshine Community Project Process', mimeType: GOOGLE_DOC, modifiedTime: '2026-10-28T16:00:00.000Z', html: exportOf('x', COMMUNITY) },
      pdf: { id: 'pdf', name: '2026 Sunshine Makeover Process.pdf', mimeType: 'application/pdf', modifiedTime: '2026-10-29T00:00:00.000Z' },
      pay: { id: 'pay', name: '2026 Sunshine Accounts Payable Process', mimeType: GOOGLE_DOC, modifiedTime: '2026-10-29T13:00:00.000Z', html: exportOf('2026 Sunshine Accounts Payable Process', PAYABLES) },
      rec: { id: 'rec', name: '2026 Sunshine Gifts & Deposits Process', mimeType: GOOGLE_DOC, modifiedTime: '2026-10-29T13:00:00.000Z', html: exportOf('x', RECEIVABLES) },
      bks: { id: 'bks', name: '2026 Sunshine Books & Reporting Process', mimeType: GOOGLE_DOC, modifiedTime: '2026-10-29T13:00:00.000Z', html: exportOf('x', BOOKS) },
      pol: { id: 'pol', name: '2025 FINAL- Board Financial Policy Manual with Exhibits - 4929-5301-3035 6', mimeType: GOOGLE_DOC, modifiedTime: '2025-11-13T15:00:00.000Z', html: POLICY_HTML },
      polOld: { id: 'polOld', name: 'Board Financial Policy Manual with Exhibits PBP Form 10-2020.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modifiedTime: '2021-02-16T00:00:00.000Z' },
    },
    subs: [], lists: 0, exports: [], noScope: false, down: false, jt: 0, jobs: [],
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(String(init.body)).get('assertion').split('.')[1], 'base64url').toString());
      g.subs.push(claims.sub);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.readonly');
      if (g.noScope) return Response.json({ error: 'unauthorized_client' }, { status: 401 });
      return Response.json({ access_token: `tok-${claims.sub}`, expires_in: 3600 });
    }
    if (url === JT_URL) {
      g.jt++;
      const q = JSON.parse(init.body).query.organization.jobs;
      assert.deepEqual(q.nodes.customFieldValues.$.size, 1, 'each job brings only its Status');
      return Response.json({ organization: { jobs: { nodes: g.jobs, nextPage: null } } });
    }
    const u = new URL(url);
    assert.equal(init.method || 'GET', 'GET', 'Drive is only ever read');
    assert.equal(u.hostname, 'www.googleapis.com');
    if (g.down) return Response.json({ error: { message: 'Backend Error' } }, { status: 503 });
    if (u.pathname === '/drive/v3/files') {
      g.lists++;
      const q = u.searchParams.get('q');
      assert.equal(u.searchParams.get('includeItemsFromAllDrives'), 'true');
      assert.equal(u.searchParams.get('corpora'), 'allDrives');
      const words = [...q.matchAll(/name contains '([^']+)'/g)].map((m) => m[1].toLowerCase());
      const files = Object.values(g.files).filter((f) => words.every((w) => f.name.toLowerCase().includes(w)) && (!q.includes('mimeType =') || f.mimeType === GOOGLE_DOC))
        .map(({ html, ...f }) => f);
      return Response.json({ files });
    }
    const m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    const f = m && g.files[decodeURIComponent(m[1])];
    if (!f) return Response.json({ error: { message: 'File not found: x.' } }, { status: 404 });
    if (m[2]) {
      assert.equal(u.searchParams.get('mimeType'), 'text/html');
      g.exports.push(f.id);
      return new Response(f.html);
    }
    const { html, ...meta } = f;
    return Response.json(meta);
  };
});

test('Process reads each Doc as the staff member looking, through Drive', async () => {
  const docs = await processDocs(env, { user: 'clareece@soardcharity.com' });
  assert.deepEqual(g.subs, ['clareece@soardcharity.com']);
  assert.equal(docs.makeover.doc.name, '2026 Sunshine Makeover Process');
  assert.equal(docs.makeover.doc.modifiedBy, 'Clareece Cunningham');
  assert.equal(docs.makeover.steps.length, 10);
  assert.equal(docs.community.steps[1].t, 'Fill out online application');
  assert.equal(docs.community.doc.url, 'https://docs.google.com/document/d/co/edit', 'a link even when Drive sends none');
  assert.deepEqual(g.exports.sort(), ['bks', 'co', 'mk', 'pay', 'pol', 'rec']);
  assert.equal(docs.payables.doc.name, '2026 Sunshine Accounts Payable Process');
  assert.equal(docs.receivables.steps.length, 2);
  assert.equal(docs.policy.doc.name, '2025 FINAL- Board Financial Policy Manual with Exhibits - 4929-5301-3035 6', 'the Google Doc, never the old Word file');
  assert.deepEqual(docs.policy.sections.map((x) => x.t), ['Accounting', 'Contributions', 'Expenditures', 'Accounting and Controls of Checks']);
  assert.equal(docs.makeover.error, null);
});

test('Drive is asked again after 2 minutes, and a Doc read again only when it changed', async () => {
  const t0 = Date.parse('2026-10-29T15:00:00Z');
  await processDocs(env, { user: 'peter@soardcharity.com', now: t0 });
  assert.equal(g.lists, 6);
  await processDocs(env, { user: 'peter@soardcharity.com', now: t0 + 60e3 });
  assert.equal(g.lists, 6, 'inside 2 minutes the saved copy answers');
  await processDocs(env, { user: 'peter@soardcharity.com', now: t0 + CHECK_MS });
  assert.equal(g.lists, 12);
  assert.equal(g.exports.length, 6, 'unchanged Docs aren’t read again');
  g.files.mk.modifiedTime = '2026-10-29T15:01:00.000Z';
  g.files.mk.html = exportOf('x', `${MAKEOVER}\nCelebrate`);
  const docs = await processDocs(env, { user: 'peter@soardcharity.com', now: t0 + 2 * CHECK_MS });
  assert.equal(g.exports.length, 7);
  assert.equal(g.exports[6], 'mk', 'the changed Doc, read again');
  assert.equal(docs.makeover.steps.at(-1).t, 'Celebrate');
  // Asked for fresh, Drive answers now
  await processDocs(env, { user: 'peter@soardcharity.com', now: t0 + 2 * CHECK_MS + 1, fresh: true });
  assert.equal(g.lists, 24);
});

test('when Drive can’t be read, Process keeps the last copy and says why', async () => {
  const t0 = Date.parse('2026-10-29T15:00:00Z');
  await processDocs(env, { user: 'peter@soardcharity.com', now: t0 });
  g.down = true;
  const docs = await processDocs(env, { user: 'peter@soardcharity.com', now: t0 + CHECK_MS });
  assert.equal(docs.makeover.steps.length, 10, 'the last good copy stays');
  assert.match(docs.makeover.error, /Google Drive: Backend Error/);
  const facts = await processFacts(env.DB);
  assert.equal(facts.makeover.steps, 10);
  assert.match(facts.makeover.error, /Backend Error/);
  // A problem is checked again straight away, and clears once Drive answers
  g.down = false;
  const again = await processDocs(env, { user: 'peter@soardcharity.com', now: t0 + CHECK_MS + 1000 });
  assert.equal(again.makeover.error, null);
});

test('without Drive permission, the steps wait and staff are told what to switch on', async () => {
  g.noScope = true;
  const docs = await processDocs(env, { user: 'peter@soardcharity.com' });
  assert.deepEqual(docs.makeover.steps, []);
  assert.match(docs.makeover.error, /Domain-wide delegation/);
  assert.equal(docs.makeover.doc, null);
});

test('no Doc by that name: Process says so; a pasted link is followed instead, and can be dropped again', async () => {
  delete g.files.co;
  g.files.other = { id: '1O03avY0pTtVY_2QZVujPJG8mALWULR2NBYiZ_NNRuis', name: 'Community projects, how we do them', mimeType: GOOGLE_DOC, modifiedTime: '2026-10-28T16:00:00.000Z', html: exportOf('x', COMMUNITY) };
  g.files[g.files.other.id] = g.files.other;
  let docs = await processDocs(env, { user: 'peter@soardcharity.com' });
  assert.match(docs.community.error, /No Google Doc named like “\d{4} Sunshine Community Project Process”/);
  await assert.rejects(setOverride(env.DB, 'community', 'https://example.com/nope'), /isn’t a link to a Google Doc/);
  await assert.rejects(setOverride(env.DB, 'neither', ''), /Unknown process/);
  await setOverride(env.DB, 'community', `https://docs.google.com/document/d/${g.files.other.id}/edit`);
  docs = await processDocs(env, { user: 'peter@soardcharity.com' });
  assert.equal(docs.community.error, null);
  assert.equal(docs.community.override, true);
  assert.equal(docs.community.doc.name, 'Community projects, how we do them');
  await setOverride(env.DB, 'community', '');
  docs = await processDocs(env, { user: 'peter@soardcharity.com' });
  assert.equal(docs.community.override, false);
  assert.match(docs.community.error, /No Google Doc/);
});

test('a money Doc not written yet is no problem: its built-in steps stand in, and it’s picked up once it exists', async () => {
  delete g.files.rec;
  let docs = await processDocs(env, { user: 'peter@soardcharity.com' });
  assert.equal(docs.receivables.error, null);
  assert.match(docs.receivables.missing, /Sunshine Gifts & Deposits Process$/);
  assert.equal((await processFacts(env.DB)).receivables.error, null, 'nothing amber on the map');
  g.files.rec = { id: 'rec', name: '2026 Sunshine Gifts & Deposits Process', mimeType: GOOGLE_DOC, modifiedTime: '2026-10-30T13:00:00.000Z', html: exportOf('x', RECEIVABLES) };
  docs = await processDocs(env, { user: 'peter@soardcharity.com', fresh: true });
  assert.equal(docs.receivables.missing, undefined);
  assert.equal(docs.receivables.steps.length, 2);
  // Once followed, a Doc that disappears is a problem again
  delete g.files.rec;
  docs = await processDocs(env, { user: 'peter@soardcharity.com', fresh: true });
  assert.match(docs.receivables.error, /No Google Doc named like/);
  assert.equal(docs.receivables.steps.length, 2, 'the last copy stays');
});

test('a sign-in that isn’t staff reads as Board’s admins instead', async () => {
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE board_state (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await env.DB.prepare('INSERT INTO board_state (key, data, updated_at) VALUES (?, ?, ?)').bind('settings', JSON.stringify({ admins: ['holly@soardcharity.com'] }), '2026-10-29').run();
  const docs = await processDocs(env, { user: 'board.member@example.com' });
  assert.deepEqual(g.subs, ['holly@soardcharity.com']);
  assert.equal(docs.makeover.steps.length, 10);
});

// ─── Who's where right now ────────────────

test('right now: families and organizations at Applied and In Review, each linked to its page in Applicants', async () => {
  await env.DB.exec(`CREATE TABLE applicants (account_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, year TEXT, types TEXT, fields TEXT, job_id TEXT, created_at TEXT, archived_at TEXT, synced_at TEXT)`);
  await env.DB.exec('CREATE TABLE applications (id TEXT PRIMARY KEY, jt_account_id TEXT, kind TEXT, is_test INTEGER)');
  const add = (id, name, status, fields = {}, archived = null, job = null) => env.DB.prepare('INSERT INTO applicants (account_id, name, status, fields, job_id, created_at, archived_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, name, status, JSON.stringify(fields), job, `2026-10-0${id.slice(1)}`, archived, 'x').run();
  await add('a1', 'Max Sample', 'Applied', { birthday: '2018-01-01' });
  await add('a2', 'Ava Stone', 'In Review', { diagnosis: 'CP' });
  await add('a3', 'Sunnyside Academy', 'Applied');
  await add('a4', 'TEST Maya Rivera', 'Applied', { birthday: '2019-01-01' });
  await add('a5', 'Old Family', 'Applied', { birthday: '2015-01-01' }, '2026-01-01');
  await add('a6', 'Lee Park', 'Approved', { birthday: '2017-01-01' });
  await add('a7', 'Hope Clinic', 'In Review');
  await env.DB.prepare('INSERT INTO applications (id, jt_account_id, kind, is_test) VALUES (?, ?, ?, ?)').bind('app-1', 'a7', 'organization', 0).run();
  const now = await pipelineNow(env);
  assert.deepEqual(now.makeover.applied, { n: 1, names: [{ name: 'Max Sample', href: '#applications/applicants/a1', since: '2026-10-01' }] }, 'at Applied since it applied');
  assert.deepEqual(now.makeover.inReview.names.map((x) => x.name), ['Ava Stone']);
  assert.deepEqual(now.community.applied.names.map((x) => x.name), ['Sunnyside Academy']);
  assert.deepEqual(now.community.inReview.names.map((x) => x.name), ['Hope Clinic']);
  assert.equal(now.makeover.jobs, null, 'JobTread unread: no job counts rather than zeros');
  assert.equal(g.jt, 0, 'no JobTread key, no JobTread call');
});

test('right now: open jobs by Status, named by their page (else the job) and linked to JobTread; a community project’s on its own track', async () => {
  await env.DB.exec('CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)');
  await env.DB.exec('CREATE TABLE community (slug TEXT PRIMARY KEY, name TEXT, data TEXT)');
  await env.DB.exec(`CREATE TABLE applicants (account_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, year TEXT, types TEXT, fields TEXT, job_id TEXT, created_at TEXT, archived_at TEXT, synced_at TEXT)`);
  await env.DB.prepare('INSERT INTO kids (slug, name, year, data) VALUES (?, ?, ?, ?)').bind('amari', 'Amari', 2026, JSON.stringify({ name: 'Amari', jobtreadJobId: 'j1' })).run();
  await env.DB.prepare('INSERT INTO community (slug, name, data) VALUES (?, ?, ?)').bind('lionheart', 'The Lionheart School', JSON.stringify({ name: 'The Lionheart School', publishStatus: 'draft', jobtreadJobId: 'j3' })).run();
  await env.DB.prepare('INSERT INTO applicants (account_id, name, status, fields, job_id, synced_at) VALUES (?, ?, ?, ?, ?, ?)').bind('o1', 'Hope Clinic', 'Approved', '{}', 'j5', 'x').run();
  const job = (id, name, status) => ({ id, name, customFieldValues: { nodes: status ? [{ value: status }] : [] } });
  g.jobs = [job('j1', 'Amari Jones (2026)', 'Awaiting Funding'), job('j2', 'Axel Brown (2026)', 'Design'), job('j3', 'The Lionheart School (2026)', 'Design'),
    job('j4', 'TEST Maya Rivera (2026)', 'Build'), job('j5', 'Hope Clinic (2026)', 'On Site'), job('j6', 'Office', null), job('j7', 'Old Job (2024)', 'Warranty')];
  env.JOBTREAD_GRANT_KEY = 'grant';
  const t0 = Date.parse('2026-10-29T15:00:00Z');
  const now = await pipelineNow(env, { now: t0 });
  assert.deepEqual(now.makeover.jobs['Awaiting Funding'].names, [{ name: 'Amari', href: 'https://app.jobtread.com/jobs/j1', page: '/kids/amari/' }]);
  assert.deepEqual(now.makeover.jobs.Design.names, [{ name: 'Axel Brown', href: 'https://app.jobtread.com/jobs/j2' }], 'no page yet: the job’s own name, without the year');
  assert.deepEqual(now.community.jobs.Design.names.map((x) => x.name), ['The Lionheart School'], 'a project’s draft still names its job');
  assert.deepEqual(now.community.jobs['On Site'].names.map((x) => x.name), ['Hope Clinic'], 'an organization’s account puts its job on the community track');
  assert.equal(now.makeover.jobs.Build.n, 0, 'TEST jobs are left out');
  assert.deepEqual(Object.keys(now.makeover.jobs), ['On Site', 'Awaiting Funding', 'Design', 'Finalization', 'Approval', 'Mobilization', 'Build']);
  await pipelineNow(env, { now: t0 + 60e3 });
  assert.equal(g.jt, 1, 'JobTread is read at most every 5 minutes');
});

test('the heartbeat checks the Docs hourly as Board’s admins, and only once an hour', async () => {
  await env.DB.exec('CREATE TABLE board_state (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await env.DB.prepare('INSERT INTO board_state (key, data, updated_at) VALUES (?, ?, ?)').bind('settings', JSON.stringify({ admins: ['holly@soardcharity.com'] }), '2026-10-29').run();
  const t0 = Date.parse('2026-10-29T15:00:00Z');
  const docs = await maybeRefreshProcess(env, { now: t0 });
  assert.equal(docs.makeover.steps.length, 10);
  assert.deepEqual(g.subs, ['holly@soardcharity.com']);
  assert.equal(await maybeRefreshProcess(env, { now: t0 + 30 * 60e3 }), null, 'inside the hour: nothing');
  assert.equal(g.lists, 6);
  await maybeRefreshProcess(env, { now: t0 + REFRESH_MS });
  assert.equal(g.lists, 12, 'an hour on, Drive is asked again');
  delete env.GOOGLE_CALENDAR_KEY;
  assert.equal(await maybeRefreshProcess(env, { now: t0 + 3 * REFRESH_MS }), null, 'no Google key: nothing, and no throw');
});

test('bill approvals against the manual: the second-approval amount and the Board Chair', async () => {
  await env.DB.exec('CREATE TABLE spend_state (key TEXT PRIMARY KEY, data TEXT)');
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind('pat-chair', 'Pat Chair', 'board', JSON.stringify({ name: 'Pat Chair', group: 'board', seat: 'chair', status: 'active' })).run();
  await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('pat-chair', 'pat@example.com').run();
  const policy = { sections: policySections(POLICY_HTML) };
  // Out of the box: a second approver from $10,000, but nobody on the second-approval list
  let c = (await policyChecks(env, policy)).approvals;
  assert.equal(c.ok, false);
  assert.match(c.text, /The manual: over \$15,000, the Board Chair approves\. Pat Chair, the Board Chair, isn’t a second approver/);
  assert.ok(!c.text.includes('pat@example.com'), 'never an email');
  await env.DB.prepare("INSERT INTO spend_state (key, data) VALUES ('bill-pay', ?)").bind(JSON.stringify({ bigBillCents: 2000000, bigApprovers: ['PAT@example.com'] })).run();
  c = (await policyChecks(env, policy)).approvals;
  assert.equal(c.ok, false);
  assert.match(c.text, /Bills up to \$20,000 need only one approver/);
  await env.DB.prepare("UPDATE spend_state SET data = ? WHERE key = 'bill-pay'").bind(JSON.stringify({ bigBillCents: 1500000, bigApprovers: ['pat@example.com'] })).run();
  c = (await policyChecks(env, policy)).approvals;
  assert.deepEqual(c, { ok: true, text: 'The manual: over $15,000, the Board Chair approves. Bills over $15,000 need a second approver, and Pat Chair is one.' });
  assert.deepEqual(await policyChecks(env, { sections: [] }), { approvals: null }, 'no tiers in the manual: no check');
});

test('“Reviewed, no changes” is saved per Doc with who and when, and reaches the map’s facts', async () => {
  await processDocs(env, { user: 'peter@soardcharity.com' });
  assert.deepEqual(await readReviews(env.DB), { makeover: null, community: null, payables: null, receivables: null, books: null, policy: null });
  await markReviewed(env.DB, 'policy', 'linzi@soardcharity.com', Date.parse('2026-11-10T15:00:00Z'));
  assert.deepEqual((await readReviews(env.DB)).policy, { at: '2026-11-10T15:00:00.000Z', by: 'linzi@soardcharity.com' });
  await assert.rejects(markReviewed(env.DB, 'nope', 'x'), /Unknown process/);
  const facts = await processFacts(env.DB);
  assert.equal(facts.policy.reviewedAt, '2026-11-10T15:00:00.000Z');
  assert.equal(facts.policy.modifiedTime, '2025-11-13T15:00:00.000Z');
});

test('how long the application steps take, from the applicants’ history over the last year', async () => {
  await env.DB.exec(`CREATE TABLE applicants (account_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, year TEXT, types TEXT, fields TEXT, job_id TEXT, created_at TEXT, archived_at TEXT, synced_at TEXT)`);
  await env.DB.exec('CREATE TABLE applicant_activity (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, by_name TEXT, source TEXT, title TEXT, body TEXT, data TEXT)');
  const now = Date.parse('2026-10-29T12:00:00Z');
  const fam = async (id, name, created, steps, fields = { birthday: '2018-01-01' }) => {
    await env.DB.prepare('INSERT INTO applicants (account_id, name, status, fields, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, 'Approved', JSON.stringify(fields), created, 'x').run();
    for (const [i, [to, at]] of steps.entries()) await env.DB.prepare('INSERT INTO applicant_activity (id, account_id, at, kind, data) VALUES (?, ?, ?, ?, ?)').bind(`${id}-${i}`, id, at, 'status', JSON.stringify({ to })).run();
  };
  await fam('f1', 'A Family', '2026-03-01T00:00:00Z', [['In Review', '2026-03-11T00:00:00Z'], ['Approved', '2026-04-10T00:00:00Z']]);
  await fam('f2', 'B Family', '2026-03-01T00:00:00Z', [['In Review', '2026-03-21T00:00:00Z'], ['Denied', '2026-04-01T00:00:00Z']]);
  await fam('f3', 'C Family', '2026-03-01T00:00:00Z', [['In Review', '2026-03-31T00:00:00Z']]);
  await fam('f4', 'TEST Family', '2026-03-01T00:00:00Z', [['In Review', '2026-03-02T00:00:00Z'], ['Approved', '2026-03-03T00:00:00Z']]);
  await fam('f5', 'Old Family', '2024-01-01T00:00:00Z', [['In Review', '2024-02-01T00:00:00Z'], ['Approved', '2024-05-01T00:00:00Z']]);
  await fam('o1', 'Hope Clinic', '2026-06-01T00:00:00Z', [['In Review', '2026-06-08T00:00:00Z'], ['Approved', '2026-06-15T00:00:00Z']], {});
  const c = await cycleTimes(env.DB, { now });
  assert.deepEqual(c.makeover, { toReview: { days: 20, n: 3 }, toDecision: { days: 21, n: 2 } }, 'medians; tests and decisions over a year old left out');
  assert.deepEqual(c.community, { toReview: { days: 7, n: 1 }, toDecision: { days: 7, n: 1 } });
});

test('a job’s time at its step counts from a status change the site saw, never guessed', async () => {
  await env.DB.exec('CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, year INTEGER, data TEXT)');
  await env.DB.exec('CREATE TABLE community (slug TEXT PRIMARY KEY, name TEXT, data TEXT)');
  env.JOBTREAD_GRANT_KEY = 'grant';
  const job = (id, name, status) => ({ id, name, customFieldValues: { nodes: [{ value: status }] } });
  g.jobs = [job('j1', 'Axel Brown (2026)', 'Design')];
  const t0 = Date.parse('2026-10-29T15:00:00Z');
  let now = await pipelineNow(env, { now: t0 });
  assert.equal(now.makeover.jobs.Design.names[0].since, undefined, 'first seen: when it got there is unknown');
  g.jobs = [job('j1', 'Axel Brown (2026)', 'Finalization')];
  now = await pipelineNow(env, { now: t0 + 6 * 60e3 });
  assert.equal(now.makeover.jobs.Finalization.names[0].since, new Date(t0 + 6 * 60e3).toISOString(), 'a change seen: since then');
  now = await pipelineNow(env, { now: t0 + 20 * 60e3 });
  assert.equal(now.makeover.jobs.Finalization.names[0].since, new Date(t0 + 6 * 60e3).toISOString(), 'and it keeps that date');
});

test('a review coming due is emailed to the founders once, with what to look at', async () => {
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  for (const [slug, name, role] of [['holly', 'Holly Ranney', 'founder'], ['peter', 'Peter Ranney', 'founder'], ['linzi', 'Linzi Berkowitz', 'staff']]) {
    await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, name, 'team', JSON.stringify({ name, group: 'team', role, status: 'active' })).run();
  }
  env.RESEND_API_KEY = 're_test';
  await processDocs(env, { user: 'peter@soardcharity.com', now: Date.parse('2026-10-29T12:00:00Z') });
  const sent = [];
  const send = async (_env, msg) => { sent.push(msg); return { sent: msg.to.length, failed: 0 }; };
  // The manual changed Nov 13 2025: due Nov 13 2026. Sixteen days out, nothing; within two weeks, once
  assert.deepEqual(await maybeTellReviews(env, { now: Date.parse('2026-10-28T12:00:00Z'), send }), []);
  const out = await maybeTellReviews(env, { now: Date.parse('2026-10-31T12:00:00Z'), send });
  assert.deepEqual(out, [{ doc: 'policy', sent: 2 }]);
  assert.deepEqual(sent[0].to.sort(), ['holly@soardcharity.com', 'peter@soardcharity.com'], 'the founders on People → Team');
  assert.match(sent[0].subject, /^Yearly review: “2025 FINAL- Board Financial Policy Manual with Exhibits - 4929-5301-3035 6” is due Nov 13, 2026$/);
  assert.match(sent[0].text, /It names QuickBooks \(Accounting\); the books are in Mercury Books\./);
  assert.match(sent[0].text, /#automations\/process\/payables/);
  assert.ok(!/—/.test(sent[0].text), 'no em dashes');
  assert.deepEqual(await maybeTellReviews(env, { now: Date.parse('2026-11-01T12:00:00Z'), send }), [], 'once per due date');
  // Marked reviewed: the next one is a year on
  await markReviewed(env.DB, 'policy', 'peter@soardcharity.com', Date.parse('2026-11-02T12:00:00Z'));
  assert.deepEqual(await maybeTellReviews(env, { now: Date.parse('2026-11-20T12:00:00Z'), send }), []);
  // A process Doc named for last year is due on New Year’s
  const jan = await maybeTellReviews(env, { now: Date.parse('2027-01-02T12:00:00Z'), send });
  assert.deepEqual(jan.map((x) => x.doc).sort(), ['books', 'community', 'makeover', 'payables', 'receivables'], 'every Doc named for 2026');
  assert.match(sent.at(-1).subject, /is due now: it’s 2027$/);
  const e = reviewEmail('makeover', { name: '2026 Sunshine Makeover Process', modifiedTime: '2026-10-28T15:00:00Z', url: 'https://docs.google.com/document/d/mk/edit' }, { state: 'soon', dueAt: '2027-10-28T15:00:00.000Z' }, { agenda: ['39 of 64 tasks are done by hand.'] });
  assert.match(e.html, /Open it in Process/);
  assert.match(e.text, /Process: https:\/\/sunshineonaranneyday\.com\/admin\/#automations\/process\n/);
});

// ─── On the map ───────────────────────────

test('the map’s “Process from Google Docs” entry follows the Docs’ last read', () => {
  const entry = entries.find((n) => n.t === 'Process from Google Docs');
  applyFacts({ processDocs: { makeover: { name: '2026 Sunshine Makeover Process', readAt: '2026-10-29T15:00:00Z', checkedAt: '2026-10-29T15:05:00Z', steps: 14, error: null }, community: { name: '2026 Sunshine Community Project Process', readAt: '2026-10-29T15:00:00Z', checkedAt: '2026-10-29T15:04:00Z', steps: 16, error: null } } });
  assert.equal(entry.es, 'live');
  assert.match(entry.probe.why, /Following “2026 Sunshine Makeover Process” and “2026 Sunshine Community Project Process”/);
  assert.equal(entry.probe.last, '2026-10-29T15:05:00Z');
  applyFacts({ processDocs: { makeover: { name: '2026 Sunshine Makeover Process', readAt: '2026-10-29T15:00:00Z', error: 'Google Drive: Backend Error', steps: 14 }, community: { readAt: null, error: null } } });
  assert.equal(entry.es, 'attn');
  assert.match(entry.probe.why, /Backend Error.*copy it last read/);
  applyFacts({ processDocs: { makeover: {}, community: {} } });
  assert.equal(entry.es, 'live');
  assert.match(entry.probe.why, /first time Process opens/);
  // A Doc overdue for its yearly review
  applyFacts({ processDocs: { makeover: { name: '2026 Sunshine Makeover Process', modifiedTime: '2026-10-28T15:00:00Z', readAt: '2026-10-29T15:00:00Z', error: null },
    policy: { name: '2025 FINAL- Board Financial Policy Manual', modifiedTime: '2025-01-13T15:00:00Z', readAt: '2026-10-29T15:00:00Z', error: null } } });
  assert.equal(entry.es, 'attn');
  assert.match(entry.probe.why, /“2025 FINAL- Board Financial Policy Manual” is due for its yearly review/);
  applyFacts(null);
});
