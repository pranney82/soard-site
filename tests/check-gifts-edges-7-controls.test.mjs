/**
 * Controls for tests/check-gifts-edges-7.test.mjs: the same scenarios with the one detail changed. Names are made up.
 * Run: node --test tests/check-gifts-edges-7-controls.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, run, rowOf, posted, fakeFetch, hand, read, txn, mirrorTransaction, readState, writeState, slackSaid, approve, card, NOW, MIN, DAY, dayS, TX } = await import('./lib/check-gifts-harness-2.mjs');
const { handlePayment } = await import('../functions/api/_zeffy.js');
const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => setup());
const env = () => W.env;
const world = () => W.world;
const person = (first, last, o = {}) => ({ first_name: first, last_name: last, email: null, is_corporate: false, company_name: null, ...o });
const sitePosts = () => world().posts.filter((b) => b.amount > 100);
const moneyCards = () => world().slack.filter((b) => /no check in Mercury/.test(b));
async function depositIs(o, reading = {}) {
  world().txns[TX] = txn(o);
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
  world().reading = read({ amount: o.amount ?? 10000, ...reading });
}
const addCheck = async (id, o = {}) => { world().txns[id] = txn({ id, ...o }); await mirrorTransaction(env().DB, world().txns[id], { now: NOW }); };
async function runEvery(fromIso, toIso, stepMin = 5) { for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += stepMin * MIN) await run(t); }
/** Nov 10: every check waits on a card. A card with nothing to look at first, sent by a person as it is filled in */
async function sendsClean(now, id = TX) {
  const r = await rowOf(id);
  assert.deepEqual({ state: r.state, reason: r.reason, note: r.note }, { state: 'person', reason: 'ready', note: null });
  return approve(id, { now });
}

test('M1c runs before 7 PM Eastern on Monday: one card', async () => {
  world().payments.push(hand({ id: 'zp_loose', amount: 75000, created: dayS('2026-11-10'), buyer: person('Dana', 'Whitfield') }));
  for (const at of ['2026-11-16T14:30:00Z', '2026-11-16T20:00:00Z', '2026-11-16T23:30:00Z']) await run(Date.parse(at));
  assert.equal(moneyCards().length, 1);
});

test('M2c the same check, posted by Mercury Saturday, is linked and not named', async () => {
  await depositIs({ createdAt: '2026-11-13T19:00:00Z', status: 'pending' });
  world().payments.push(hand({ id: 'zp_fri', created: dayS('2026-11-13') }));
  await runEvery('2026-11-13T19:30:00Z', '2026-11-13T21:00:00Z');
  world().txns[TX] = { ...world().txns[TX], status: 'sent', postedAt: '2026-11-14T15:00:00Z' };
  await runEvery('2026-11-14T16:00:00Z', '2026-11-14T17:30:00Z');
  await run(Date.parse('2026-11-16T14:30:00Z'));
  assert.equal((await rowOf()).state, 'linked');
  assert.deepEqual((await readState(env().DB, 'check-gifts')).money.loose, []);
});

test('M3c a United Way check typed as one entry is not named', async () => {
  await depositIs({ amount: 1250, createdAt: '2026-11-10T15:00:00Z', status: 'pending' }, { payer: 'United Way of Lakeview', memo: 'Designations Q3', date: '2026-11-08' });
  world().payments.push(hand({ id: 'zp_uw', amount: 125000, created: dayS('2026-11-10'), buyer: person('United Way of Lakeview', 'United Way of Lakeview') }));
  await runEvery('2026-11-10T15:30:00Z', '2026-11-10T16:00:00Z');
  world().txns[TX] = { ...world().txns[TX], status: 'sent', postedAt: '2026-11-11T15:00:00Z' };
  await runEvery('2026-11-11T16:00:00Z', '2026-11-11T17:30:00Z');
  assert.equal((await rowOf()).state, 'linked');
  await run(Date.parse('2026-11-16T14:30:00Z'));
  assert.deepEqual((await readState(env().DB, 'check-gifts')).money.loose, []);
});

test('C1c the company typed in the name boxes (no contact person) is learned, and its next check lands on its contact', async () => {
  world().contacts.c_oak = { id: 'c_oak', email: null, first_name: 'Oakline Design Build', last_name: 'Oakline Design Build', donation_count: 4 };
  world().reading = read({ payer: 'OAKLINE DESIGN BUILD LLC' });
  world().payments.push(hand({ id: 'zp_oak', created: dayS('2026-11-04'), contact: 'c_oak', buyer: person('Oakline Design Build', 'Oakline Design Build') }));
  await posted();
  await addCheck('tx_2', { amount: 2500, checkNumber: '2001', createdAt: '2026-12-01T15:00:00Z', status: 'sent', postedAt: '2026-12-02T15:00:00Z' });
  world().reading = read({ payer: 'OAKLINE DESIGN BUILD LLC', amount: 2500, checkNumber: '2001', date: '2026-11-28' });
  await runEvery('2026-12-03T16:00:00Z', '2026-12-03T16:30:00Z');
  assert.equal((await card('tx_2'))?.card?.donor, 'c_oak', 'its card starts on the contact it was learned as');
  await approve('tx_2', { now: Date.parse('2026-12-03T17:00:00Z') });
  assert.equal(world().payments.find((p) => p.amount === 250000)?.contact, 'c_oak');
});

// N1c (the same golf entries typed before On) went with On (Nov 10): without an On time it is N1 itself

test('N2c the same re-run, with Zeffy letting the $1 records go: the check is saved', async () => {
  await run(Date.parse('2026-11-02T12:00:00Z'));
  const st = await readState(env().DB, 'check-gifts');
  await writeState(env().DB, 'check-gifts', { writeTest: { ...st.writeTest, id: '2026-11-01' } });
  await run(NOW - 60 * MIN);
  await run(NOW - 55 * MIN);
  await posted();
  await sendsClean(NOW + 15 * MIN);
  assert.equal((await rowOf()).state, 'created');
});

test('P1c the same pledge from ten months ago (inside the 400 days), marked paid: not saved again', async () => {
  const pledge = hand({ id: 'zp_pledge', type: 'online', status: 'pending', created: dayS('2026-01-15'), contact: 'c_pine',
    buyer: { first_name: 'Pine', last_name: 'Foundation', email: 'grants@pine.example.org', is_corporate: false, company_name: null } });
  world().payments.push(pledge);
  pledge.status = 'succeeded';
  await handlePayment(env(), pledge, { via: 'webhook', now: Date.parse('2026-11-04T15:00:00Z') });
  await posted();
  // Its card asks about the paid pledge, and Send as the card says reads Zeffy again and shows it instead of saving
  const r = await rowOf();
  assert.ok(r.state === 'person' && r.reason === 'maybe-double' && /zp_pledge/.test(r.note || ''), `the card is "${r.state}" (${r.reason}) listing ${r.note}`);
  const held = await approve(TX, { now: NOW + 15 * MIN }).then(() => null, (e) => e);
  assert.ok(held?.status === 409 && held.entries?.some((x) => x.id === 'zp_pledge'), `Send ${held ? `was refused (${held.message})` : 'went through'}`);
  assert.equal(sitePosts().length, 0);
});

test('G1c no import: no double cards, and the check is saved', async () => {
  await run(Date.parse('2026-11-02T12:00:00Z'));
  await run(Date.parse('2026-11-09T16:00:00Z'));
  await posted();
  await sendsClean(NOW + 15 * MIN);
  assert.equal(world().slack.filter((b) => /twice/.test(b)).length, 0);
  assert.equal((await rowOf()).state, 'created');
});

test('J1c two strangers\' checks that don\'t add up ($400 + $500): the $1,000 check is saved', async () => {
  await depositIs({ amount: 1000, createdAt: '2026-11-05T15:00:00Z', status: 'pending' }, { payer: 'Pine Foundation', date: '2026-11-03' });
  world().payments.push(
    hand({ id: 'zp_smith', amount: 40000, created: dayS('2026-10-21'), buyer: person('Ruth', 'Smith') }),
    hand({ id: 'zp_jones', amount: 50000, created: dayS('2026-10-29'), buyer: person('Carl', 'Jones') }),
  );
  await posted();
  await sendsClean(NOW + 15 * MIN);
  assert.equal((await rowOf()).state, 'created');
});

test('W1c the same unsent check with nothing that adds up to it: Slack says it is still waiting to be sent', async () => {
  await depositIs({ amount: 1000, createdAt: '2026-11-05T15:00:00Z', status: 'pending' }, { payer: 'Pine Foundation', date: '2026-11-03' });
  world().payments.push(hand({ id: 'zp_smith', amount: 40000, created: dayS('2026-10-21'), buyer: person('Ruth', 'Smith') }));
  await posted();
  for (let d = 1; d <= 12; d++) await run(NOW + d * DAY);
  assert.ok(/still waiting to be sent to Zeffy/.test(slackSaid()));
});

test('K1c the same typo double dated Nov 7 (after checks moved to Mercury): the money check names it', async () => {
  await posted();
  await approve(TX, { now: NOW + 15 * MIN });
  world().payments.push(hand({ id: 'zp_typo', amount: 100000, created: dayS('2026-11-07') }));
  for (let h = 0; h < 4; h++) await run(Date.parse('2026-11-12T16:00:00Z') + h * 61 * MIN);
  await run(Date.parse('2026-11-16T14:30:00Z'));
  assert.ok((await readState(env().DB, 'check-gifts')).money.loose.some((x) => x.id === 'zp_typo'));
});
