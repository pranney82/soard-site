/**
 * Break-it round 12 on Checks into Zeffy (Nov 11 2026): sequences across runs and presses, against
 * tests/lib/check-gifts-harness-2.mjs (Zeffy as its spec says: POST /payments finds or makes the contact by email, PATCH
 * changes only what it's given). Each F test failed before its fix, with the bad outcome in its message; each "control:"
 * test is the same steps without the one thing the bug needed, and held all along. A record that only shows in Zeffy's list
 * after the 30 minutes settleUnsure gives it is the premise round 10 (D4) already used. Names, emails and addresses are made up.
 * Run: node --test tests/check-gifts-edges-12.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, run, rowOf, posted, fakeFetch, hand, read, txn, mirrorTransaction, noEmailGiver, slackSaid, NOW, MIN, DAY, dayS, TX } = await import('./lib/check-gifts-harness-2.mjs');
const { approveWith, cardOf } = await import('./lib/check-gifts-approve.mjs');

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
const env = () => W.env;
const world = () => W.world;
const approve = (id, over = {}) => approveWith(env(), over.fetchImpl || fakeFetch, id, { now: NOW, ...over });
const said = (p) => p.then((x) => x.result, (e) => e.message);
const quiet = (now, o = {}) => run(now, o).catch((e) => ({ error: e.message }));
async function runs(from, to, step = 6 * MIN, o = {}) { let t = from; for (; t <= to; t += step) await quiet(t, o); return t; }
const learnedOf = (name) => env().DB.prepare('SELECT * FROM check_payers WHERE key = ?').bind(CG.payerKey(name)).first();
const big = () => world().payments.filter((p) => p.amount === 1000000);

// The readers answer a letter's prompt with world().letter, a check's with world().reading
const LETTER = { fileName: 'cover-letter.pdf', url: 'https://files.mercury.test/cover-letter.pdf', attachmentType: 'other' };
function lettersToo(letter) {
  world().letter = { aboutGift: true, recordAs: '', email: '', street: '', city: '', state: '', zip: '', amount: 10000, ...letter };
  env().AI = { run: async (model, input) => { world().aiCalls++; return { response: String(input?.messages?.[0]?.content || '').startsWith('You read one page') ? world().letter : world().reading }; } };
}
const attach = (id = TX, ...more) => { world().txns[id] = { ...world().txns[id], attachments: [...world().txns[id].attachments, ...more] }; };
// (the letter's bytes: a picture, so the readers are asked about it as a page)
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 217]);

/** POST /payments times out with nothing saved yet; the body Zeffy got is kept so the record can show up later */
function postTimesOut() {
  const sent = [];
  world().fail = ({ method, path, body }) => (method === 'POST' && path === '/payments' ? (sent.push(body), 'timeout') : null);
  return sent;
}

/** The record an unanswered POST saved, as Zeffy lists it once it shows: on the contact it was filed under, dated as sent */
function landed(body, contact, id = 'zp_late') {
  const p = hand({
    id, amount: body.amount, campaign_id: body.campaign_id, contact, description: world().forms.find((f) => f.id === body.campaign_id)?.title,
    created: Math.floor(Date.parse(body.payment_date) / 1000),
    buyer: { first_name: body.first_name, last_name: body.last_name, email: body.email || null, is_corporate: false, company_name: null, address: null },
  });
  world().payments.push(p);
  if (world().contacts[contact]) world().contacts[contact].donation_count = (world().contacts[contact].donation_count || 0) + 1;
  return p;
}

beforeEach(() => setup());

// ── F1. settleFound teaches row.payer as the contact the record was filed under (sent.join). row.payer is the card's name now,
//        not the name the record went in as: a letter attached in Mercury while the Send was unanswered is read once the card is
//        back with the person, and prepareCard sets payer to the letter's giver (a matching gift: "record as Dana Whitfield").
//        When the record then shows up, settleFound files it as from Dana and teaches "Dana Whitfield" = Pine Foundation's own
//        contact. The record says Pine Foundation, the row says Dana, and Dana's next personal check starts on, and is filed
//        under, Pine Foundation's contact as "Pine Foundation" (E5's outcome, by another road: E5's fix keeps the payer through a
//        500, but nothing keeps it through a card made again) ────────────────────────────────────────────────────────────────
async function pineSentThenDanasLetter() {
  await noEmailGiver();
  world().payments.push(hand({ id: 'zp_march', amount: 500000, created: dayS('2026-03-10'), contact: 'c_pine' }));
  await posted();
  const c0 = await cardOf(env(), TX);
  assert.deepEqual([c0.state, c0.card.name, c0.card.donor], ['person', 'Pine Foundation', 'c_pine'], 'the card starts on Pine Foundation\'s own contact');
  const t1 = NOW + 15 * MIN;
  const sent = postTimesOut();
  const first = await said(approve(TX, { now: t1 }));
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  // A few minutes later the team attaches the matching-gift letter in Mercury
  lettersToo({ recordAs: 'Dana Whitfield' });
  world().picture = JPEG;
  attach(TX, LETTER);
  return { t1, body: sent[0] };
}

test('F1 a record found after a letter changed the card is never taught as the letter\'s giver\'s contact', async () => {
  const { t1, body } = await pineSentThenDanasLetter();
  await runs(t1 + 5 * MIN, t1 + 100 * MIN);
  const waiting = await rowOf();
  assert.deepEqual([waiting.state, waiting.payer, !!waiting.payload], ['person', 'Dana Whitfield', true], 'the card is back, now from the letter\'s giver, still looking for the Send');
  // Zeffy's list now shows the record that POST saved, on Pine Foundation's contact (where the no-mail address filed it)
  const rec = landed(body, 'c_pine');
  await runs(t1 + 106 * MIN, t1 + 4 * 60 * MIN);
  const r = await rowOf();
  const page = await cardOf(env(), TX);
  const dana = await learnedOf('Dana Whitfield');
  // Dana Whitfield's own check, weeks later
  world().txns.tx_2 = txn({ id: 'tx_2', checkNumber: '388', amount: 500, createdAt: '2026-11-24T15:00:00Z', status: 'sent', postedAt: '2026-11-25T15:00:00Z', dashboardLink: 'https://app.mercury.com/transactions/tx_2', attachments: [{ fileName: 'front.jpg', url: 'https://files.mercury.test/front.jpg', attachmentType: 'checkImage' }] });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: NOW });
  env().AI = { run: async () => ({ response: read({ payer: 'Dana Whitfield', amount: 500, checkNumber: '388', date: '2026-11-23' }) }) };
  const later = Date.parse('2026-11-25T16:00:00Z');
  await runs(later, later + 30 * MIN);
  const k = await cardOf(env(), 'tx_2');
  const danaSent = k?.card?.donor ? await said(approve('tx_2', { now: later + 35 * MIN })) : 'no donor picked';
  const hers = world().payments.find((p) => p.amount === 50000);
  assert.ok(dana?.contact_id !== 'c_pine' && hers?.contact !== 'c_pine',
    `the Send went in as Pine Foundation on c_pine (${rec.id}) and the check is "${r.state}" holding ${r.zeffy_id}, its row saying it's from "${r.payer}" (page: "${page.why}"); the site learned "Dana Whitfield" as contact ${dana?.contact_id}. Dana Whitfield's own $500 check starts on donor ${k?.card?.donor}; Send as filled in answered "${danaSent}" and her $500 is on ${hers?.contact} as ${hers?.buyer?.first_name} ${hers?.buyer?.last_name}`);
});

test('control: F1 the same record showing before the letter is read is taught as Pine Foundation\'s, and Dana is never c_pine', async () => {
  const { t1, body } = await pineSentThenDanasLetter();
  landed(body, 'c_pine');
  await runs(t1 + 5 * MIN, t1 + 4 * 60 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.payer], ['created', 'Pine Foundation']);
  assert.equal((await learnedOf('Pine Foundation'))?.contact_id, 'c_pine');
  assert.notEqual((await learnedOf('Dana Whitfield'))?.contact_id, 'c_pine');
});

// ── F2. A Send Zeffy didn't answer keeps its record JSON in `payload`, looked for a week whatever the check becomes (E1/E2's
//        fix). But a second Send's claim writes its own payload over it, and when Zeffy then answers 429 ("Zeffy is busy, so
//        nothing was sent") createRecord puts the row back with payload = null: the first Send's record is no longer looked
//        for anywhere. The person types the check into Zeffy by hand and presses Don't send, "Already in Zeffy another way".
//        When the first Send's record shows up, nothing finds it: settleUnsure takes only rows with a payload, the hourly
//        double check only 'created' ones. Two $10,000 records for one check, the check says "Not sent to Zeffy", and neither
//        the page nor Slack says a word in the day after (only the next Monday's money check could, and not at all while any
//        other check for the same amount waits) ────────────────────────────────────────────────────────────────────────────
async function sentUnansweredThenBusy({ busy = true } = {}) {
  await posted();
  const t1 = NOW + 15 * MIN;
  const sent = postTimesOut();
  assert.match(await said(approve(TX, { now: t1 })), /don’t send this one again/);
  world().fail = null;
  await runs(t1 + 5 * MIN, t1 + 40 * MIN);
  const back = await rowOf();
  assert.deepEqual([back.state, back.reason, !!back.payload], ['person', 'unsure', true], 'the card is back: "If it isn’t in Zeffy, send it again"');
  let second = null;
  if (busy) {
    // As the card says, send it again: Zeffy answers 429 (rate limited)
    world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 429 : null);
    second = await said(approve(TX, { now: t1 + 45 * MIN }));
    world().fail = null;
  }
  return { t1, body: sent[0], second };
}

test('F2 a second Send Zeffy turned away never makes the site forget the first Send\'s record, which then goes unnamed', async () => {
  const { t1, body, second } = await sentUnansweredThenBusy();
  assert.match(second, /Zeffy is busy/);
  const between = await rowOf();
  // Told nothing was sent, the person types it into Zeffy by hand and says so
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-03'), contact: 'ct_typed', buyer: { first_name: 'Pine', last_name: 'Foundation', email: null, is_corporate: false, company_name: null, address: null } }));
  const c = await cardOf(env(), TX);
  const press = await said(CG.personDontSend(env(), TX, { reason: 'already', saw: c.ver, by: 'staff@example.com', now: t1 + 50 * MIN, fetchImpl: fakeFetch }));
  // The first Send's record shows up in Zeffy's list
  const rec = landed(body, 'ct_first');
  await runs(t1 + 55 * MIN, t1 + DAY, 30 * MIN);
  const r = await rowOf();
  const view = await cardOf(env(), TX);
  assert.ok(r.extra === rec.id || r.zeffy_id === rec.id || /twice|no check in Mercury/.test(slackSaid()),
    `Zeffy has ${big().length} $10,000 records for the one check (${big().map((p) => p.id).join(', ')}). After the 429 the row's payload was ${between.payload ? 'kept' : 'gone'}; Don't send answered "${press}"; a day later the check is "${r.state}" (extra ${r.extra}, payload ${r.payload ? 'kept' : 'gone'}), its page says "${view.why}" with ${view.toDo ? 'a to-do' : 'nothing to do'}, and Slack never named ${rec.id}`);
});

test('control: F2 with no second Send, the first Send\'s record showing after Don\'t send is named on the check and in Slack', async () => {
  const { t1, body } = await sentUnansweredThenBusy({ busy: false });
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-03'), contact: 'ct_typed', buyer: { first_name: 'Pine', last_name: 'Foundation', email: null, is_corporate: false, company_name: null, address: null } }));
  const c = await cardOf(env(), TX);
  assert.equal(await said(CG.personDontSend(env(), TX, { reason: 'already', saw: c.ver, by: 'staff@example.com', now: t1 + 50 * MIN, fetchImpl: fakeFetch })), 'left-out');
  const rec = landed(body, 'ct_first');
  await runs(t1 + 55 * MIN, t1 + DAY, 30 * MIN);
  const r = await rowOf();
  assert.equal(r.extra, rec.id);
  assert.match(slackSaid(), /marked not for Zeffy has a record/);
});
