/**
 * Break-it round 13 on Checks into Zeffy (Nov 11 2026): sequences across runs and presses, against
 * tests/lib/check-gifts-harness-2.mjs (Zeffy as its spec says: POST /payments finds or makes the contact by email, PATCH
 * changes only what it's given). Each G test failed before its fix, with the bad outcome in its message; each "control:"
 * test is the same steps without the one thing the bug needed, and held all along. A record that only shows in Zeffy's list
 * after the 30 minutes settleUnsure gives it is the premise rounds 10 to 12 (D4, F1, F2) already use. Names, emails and
 * addresses are made up.
 * Run: node --test tests/check-gifts-edges-13.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, run, rowOf, posted, fakeFetch, hand, read, txn, mirrorTransaction, slackSaid, NOW, MIN, DAY, dayS, TX } = await import('./lib/check-gifts-harness-2.mjs');
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

/** POST /payments times out with nothing in Zeffy's list yet; the bodies Zeffy got are kept so each record can show up later */
function postTimesOut(sent = []) {
  world().fail = ({ method, path, body }) => (method === 'POST' && path === '/payments' ? (sent.push(body), 'timeout') : null);
  return sent;
}

/** The record an unanswered POST saved, as Zeffy lists it once it shows: on the contact it was filed under, dated as sent */
function landed(body, contact, id) {
  const p = hand({
    id, amount: body.amount, campaign_id: body.campaign_id, contact, description: world().forms.find((f) => f.id === body.campaign_id)?.title,
    created: Math.floor(Date.parse(body.payment_date) / 1000),
    buyer: { first_name: body.first_name, last_name: body.last_name, email: body.email || null, is_corporate: false, company_name: null, address: null },
  });
  world().payments.push(p);
  return p;
}

/** Where a Zeffy record is named for a person: on the check's page (its to-do) or in Slack */
async function namedAnywhere(id) {
  const rows = (await env().DB.prepare('SELECT * FROM check_gifts').all()).results || [];
  // (a check names every record to delete, a list since the G1 fix)
  const onPage = rows.some((r) => String(r.extra || '').split(',').includes(id) || r.zeffy_id === id);
  return onPage || slackSaid().includes(id);
}

beforeEach(() => setup());

// ── G1. createRecord keeps an earlier unanswered Send's record JSON (`prior`) when a later Send saves or Zeffy turns it away
//        (F2's fix), but not when the later Send is itself unanswered: its claim wrote its own payload over the earlier one,
//        and the 'unsure' path (line 1440, and 1444 for an answer with no id) leaves it there. Zeffy is having a bad day: it
//        saves each POST and times out, and its list lags. The person presses Send; 30 minutes later the card says "If it
//        isn't in Zeffy, send it again", and they do; same again. Then, as the site says when sending doesn't work, they
//        type the check into Zeffy by hand, on the form staff always use, and it links itself within the hour. When Zeffy's
//        list catches up it shows both of the site's records: the second Send's payload finds one, named as a second record
//        to delete; the first Send's record was looked for by nothing (a linked check isn't in the hourly double check), so
//        three $10,000 records sit in Zeffy for one check, and the page and Slack only ever name two of them ──────────────
async function sentTwiceThenTyped({ twice = true } = {}) {
  await posted();
  const sent = [];
  const t1 = NOW + 15 * MIN;
  postTimesOut(sent);
  assert.match(await said(approve(TX, { now: t1 })), /don’t send this one again/);
  world().fail = null;
  await runs(t1 + 5 * MIN, t1 + 40 * MIN);
  let r = await rowOf();
  assert.deepEqual([r.state, r.reason], ['person', 'unsure'], 'the card is back: "If it isn’t in Zeffy, send it again"');
  let t = t1 + 45 * MIN;
  if (twice) {
    postTimesOut(sent);
    assert.match(await said(approve(TX, { now: t })), /don’t send this one again/);
    world().fail = null;
    await runs(t + 5 * MIN, t + 40 * MIN);
    r = await rowOf();
    assert.deepEqual([r.state, r.reason], ['person', 'unsure'], 'the card is back again');
    t += 45 * MIN;
  }
  // Typed by hand on the check's date, on the form staff always use: it links itself within the hour
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-03'), contact: 'ct_typed' }));
  await runs(t, t + 70 * MIN);
  r = await rowOf();
  assert.deepEqual([r.state, r.zeffy_id], ['linked', 'zp_typed'], 'the hand entry is the check\'s record');
  return { sent, t: t + 75 * MIN };
}

test('G1 a second Send that Zeffy also leaves unanswered never makes the site forget the first Send\'s record, which then goes unnamed', async () => {
  const { sent, t } = await sentTwiceThenTyped();
  assert.equal(sent.length, 2);
  // Zeffy's list catches up: both POSTs had saved
  const a = landed(sent[0], 'ct_first', 'zp_first');
  const b = landed(sent[1], 'ct_second', 'zp_second');
  await runs(t, t + DAY, 30 * MIN);
  const r = await rowOf();
  const page = await cardOf(env(), TX);
  const unnamed = [];
  for (const p of [a, b]) if (!(await namedAnywhere(p.id))) unnamed.push(p.id);
  assert.deepEqual(unnamed, [],
    `Zeffy has ${big().length} $10,000 records for the one check (${big().map((p) => p.id).join(', ')}): the hand entry it's linked to and both of the site's Sends. A day later the row names only ${r.extra} (payload ${r.payload ? 'kept' : 'gone'}), its page says "${page.why}", and nothing on the page or in Slack ever names ${unnamed.join(', ')}; once ${r.extra} is deleted as told, the page has nothing left to do`);
});

test('control: G1 with one unanswered Send, its record showing after the hand entry links is named on the check and in Slack', async () => {
  const { sent, t } = await sentTwiceThenTyped({ twice: false });
  const a = landed(sent[0], 'ct_first', 'zp_first');
  await runs(t, t + DAY, 30 * MIN);
  const r = await rowOf();
  assert.equal(r.extra, a.id);
  assert.match(slackSaid(), /second record in Zeffy/);
});

// ── G2. settleFound teaches the name a found record went in as, and its contact: sent.join, else the record's contact when the
//        record's own typed names fit (namesOn(hit)). linkTo, for the very same entry, reads Zeffy's contact and teaches it only
//        when the contact itself carries the giver's name, because a fund's grant typed under the fund's name with its
//        advisor's email sits on the advisor's contact. findSent can return such an entry: it takes any unclaimed check payment
//        under the giver's name, on the sent form, dated within two days and first seen after the press. So: Pine Foundation's
//        Send times out with nothing saved; told "If it isn't in Zeffy, send it again", the person instead types it into
//        Zeffy by hand as staff do, under Pine Foundation with the email the foundation's letters give, Dana Whitfield's
//        (its advisor). Zeffy files it on Dana's own contact. Within the hour findSent takes it for the Send's record and
//        settleFound teaches "Pine Foundation" = Dana's contact. Pine Foundation's next check starts on Dana Whitfield's
//        contact, and Send as filled in records the foundation's gift under Dana Whitfield's name ──────────────────────────
async function pineTypedOnDanasContact({ unanswered = true } = {}) {
  world().contacts.ct_dana = { id: 'ct_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 4 };
  world().payments.push(hand({ id: 'zp_dana_own', amount: 25000, created: dayS('2026-06-02'), type: 'online', payment_method: { type: 'card', brand: 'visa', last4: '4242' }, contact: 'ct_dana',
    buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', is_corporate: false, company_name: null, address: null } }));
  await posted();
  const c0 = await cardOf(env(), TX);
  assert.deepEqual([c0.card.name, c0.card.donor, c0.card.formId], ['Pine Foundation', 'new', 'form_grant'], 'a new donor, on the grant form');
  const t1 = NOW + 15 * MIN;
  if (unanswered) {
    postTimesOut();
    assert.match(await said(approve(TX, { now: t1 })), /don’t send this one again/);
    world().fail = null;
    await runs(t1 + 5 * MIN, t1 + 40 * MIN);
    const r = await rowOf();
    assert.deepEqual([r.state, r.reason, big().length], ['person', 'unsure', 0], 'nothing saved; the card says to send it again if it isn’t in Zeffy');
  }
  // Typed by hand on the card's form and the check's date, under the foundation's name with its advisor's email
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-03'), contact: 'ct_dana', campaign_id: 'form_grant', description: 'Grant Funding 2026',
    buyer: { first_name: 'Pine', last_name: 'Foundation', email: 'dana@example.com', is_corporate: false, company_name: null, address: null } }));
  await runs(t1 + 45 * MIN, t1 + 3 * 60 * MIN);
  return t1;
}

async function pinesNextCheck() {
  world().txns.tx_2 = txn({ id: 'tx_2', checkNumber: '1077', amount: 5000, createdAt: '2026-12-01T15:00:00Z', status: 'sent', postedAt: '2026-12-02T15:00:00Z', dashboardLink: 'https://app.mercury.com/transactions/tx_2' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: NOW });
  env().AI = { run: async () => ({ response: read({ payer: 'Pine Foundation', amount: 5000, checkNumber: '1077', date: '2026-11-30' }) }) };
  const later = Date.parse('2026-12-02T16:00:00Z');
  await runs(later, later + 30 * MIN);
  const k = await cardOf(env(), 'tx_2');
  const sent = k?.card?.donor ? await said(approve('tx_2', { now: later + 35 * MIN })) : 'no donor picked';
  return { k, sent, rec: world().payments.find((p) => p.amount === 500000) };
}

test('G2 a hand entry found as an unanswered Send\'s record never teaches the giver as the contact Zeffy filed it on by someone else\'s email', async () => {
  await pineTypedOnDanasContact();
  const r = await rowOf();
  assert.deepEqual([r.state, r.zeffy_id], ['created', 'zp_typed'], 'the hand entry is the check\'s record');
  const learned = await learnedOf('Pine Foundation');
  const { k, sent, rec } = await pinesNextCheck();
  assert.ok(learned?.contact_id !== 'ct_dana' && rec?.contact !== 'ct_dana',
    `the site learned "Pine Foundation" as contact ${learned?.contact_id} (Dana Whitfield's, who only gave the email). Pine Foundation's $5,000 check on Dec 1 starts on donor ${k?.card?.donor}; Send as filled in answered "${sent}" and the foundation's gift is on ${rec?.contact} as "${rec?.buyer?.first_name} ${rec?.buyer?.last_name}"`);
});

test('control: G2 the same hand entry with no unanswered Send before it is matched, and Pine Foundation is never learned as Dana\'s contact', async () => {
  await pineTypedOnDanasContact({ unanswered: false });
  const r = await rowOf();
  assert.deepEqual([r.state, r.zeffy_id], ['linked', 'zp_typed']);
  assert.notEqual((await learnedOf('Pine Foundation'))?.contact_id, 'ct_dana');
  const { k, rec } = await pinesNextCheck();
  assert.notEqual(k?.card?.donor, 'ct_dana');
  assert.notEqual(rec?.contact, 'ct_dana');
});

// ── G3. settleUnsure takes three rows a run, oldest COALESCE(try_at, updated_at) first, and since a Send's earlier unanswered
//        payload is kept for a week on a check that is created, linked or left out, those rows keep their claim's try_at and
//        never move back in the line. Monday Zeffy times out on every POST and saves nothing; three checks come back "If it
//        isn't in Zeffy, send it again", and the person sends each again, which works: three 'created' rows whose first
//        Send is still looked for, all week, ahead of everything newer. Tuesday a fourth check's Send is saved by Zeffy and
//        times out. Its record is right there in Zeffy, but settleUnsure never reaches the row: for the rest of the week it
//        stays 'unsure', the page says "Zeffy hasn't answered yet ... don't enter this one", every press is refused with
//        "Look again in a few minutes", and no alarm looks at 'unsure' (the 10-day ones look at new, read and person) ────────
const GIVERS = [['tx_a', 'Ash Lane Partners', 250, '201'], ['tx_b', 'Birch Hollow Partners', 300, '202'], ['tx_c', 'Cedar Row Partners', 350, '203'], ['tx_d', 'Dogwood Mill Partners', 400, '204']];
async function fourChecksCarded() {
  delete world().txns[TX];
  await env().DB.prepare('DELETE FROM mercury_txns WHERE id = ?').bind(TX).run();
  for (const [id, name, amount, num] of GIVERS) {
    // Mercury names who paid; the readers' answer isn't this check, so the card goes on Mercury's name
    world().txns[id] = txn({ id, counterpartyName: name, checkNumber: num, amount, status: 'sent', postedAt: '2026-11-06T15:00:00Z', dashboardLink: `https://app.mercury.com/transactions/${id}` });
    await mirrorTransaction(env().DB, world().txns[id], { now: NOW });
  }
  await runs(NOW, NOW + 60 * MIN, 5 * MIN);
  const states = (await env().DB.prepare('SELECT state FROM check_gifts ORDER BY id').all()).results.map((r) => r.state);
  assert.deepEqual(states, ['person', 'person', 'person', 'person'], 'four cards waiting');
}
const savedThenTimeout = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'api.zeffy.com' && (init.method || 'GET') === 'POST' && url.pathname.endsWith('/payments')) { await fakeFetch(input, init); throw new DOMException('timed out', 'TimeoutError'); }
  return fakeFetch(input, init);
};

async function stalledFourth({ earlier = true } = {}) {
  await fourChecksCarded();
  let t = NOW + 70 * MIN;
  if (earlier) {
    postTimesOut();
    for (const [id] of GIVERS.slice(0, 3)) assert.match(await said(approve(id, { now: t })), /don’t send this one again/);
    world().fail = null;
    await runs(t + 5 * MIN, t + 50 * MIN);
    t += 55 * MIN;
    for (const [id] of GIVERS.slice(0, 3)) assert.equal(await said(approve(id, { now: t })), 'created', 'sent again, as the card says');
  }
  const tue = t + DAY;
  await runs(tue - 30 * MIN, tue - 5 * MIN);
  assert.match(await said(approve('tx_d', { now: tue, fetchImpl: savedThenTimeout })), /don’t send this one again/);
  const rec = world().payments.find((p) => p.amount === 40000);
  assert.ok(rec, 'Zeffy saved the fourth check’s record');
  await runs(tue + 5 * MIN, tue + DAY, 10 * MIN);
  return { tue, rec };
}

test('G3 a week of earlier unanswered Sends kept on finished checks never leaves a new unanswered Send stuck where staff can do nothing', async () => {
  const { tue, rec } = await stalledFourth();
  const r = await rowOf('tx_d');
  const page = await cardOf(env(), 'tx_d');
  const press = await said(CG.personDontSend(env(), 'tx_d', { reason: 'already', saw: page?.ver, by: 'staff@example.com', now: tue + DAY, fetchImpl: fakeFetch }));
  await runs(tue + DAY + 10 * MIN, tue + 4 * DAY, 60 * MIN);
  const r4 = await rowOf('tx_d');
  assert.ok(r.state !== 'unsure',
    `the fourth check's record ${rec.id} has been in Zeffy since its Send, yet a day later the check is "${r.state}" (zeffy_id ${r.zeffy_id}), its page says "${page?.why}", Don't send answers "${press}", and four days later it is still "${r4.state}"; settleUnsure spent every run on the three finished checks' week-old payloads`);
});

test('control: G3 with no earlier unanswered Sends, the fourth check\'s record is claimed within the hour', async () => {
  const { rec } = await stalledFourth({ earlier: false });
  const r = await rowOf('tx_d');
  assert.deepEqual([r.state, r.zeffy_id], ['created', rec.id]);
});

// ── G4. proveRead keeps both readers' memos when neither holds the other, joined with " / ". Each memo passed safeMemo on its
//        own; the joined text is never checked again. A memo that starts with a year and ends with a number, read with one
//        reader adding a "#", is stored with "12 / 2026": six digits in a row by hasAccountDigits' own rule (anything between
//        digits that isn't a letter doesn't break a run), which is the rule that says nothing like it is ever kept. The same
//        join keeps any two short runs that meet at the " / " ─────────────────────────────────────────────────────────────────
test('G4 minor: two readers\' memos joined are never stored holding a run hasAccountDigits calls a bank-like number', async () => {
  let n = 0;
  env().AI = { run: async () => ({ response: read({ memo: n++ % 2 ? '2026 Gala Table #12' : '2026 Gala Table 12' }) }) };
  await posted();
  const r = await rowOf();
  assert.ok(r.memo && !CG.hasAccountDigits(r.memo, r.check_number), `the check's stored memo is "${r.memo}", which hasAccountDigits("${r.memo}") says holds a bank-like run of digits`);
});

test('control: G4 one memo as both readers read it is stored as read', async () => {
  env().AI = { run: async () => ({ response: read({ memo: '2026 Gala Table 12' }) }) };
  await posted();
  assert.equal((await rowOf()).memo, '2026 Gala Table 12');
});
