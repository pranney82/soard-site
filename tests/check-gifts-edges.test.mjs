/**
 * The edges of a check becoming its Zeffy record (functions/api/_check-gifts.js), from a break-it round on Nov 7 2026:
 * each test failed before its fix. Since Nov 10 nothing reaches Zeffy without a person pressing Send on the check's card
 * (approve), so a test that once waited for the site to save presses Send instead. Names and amounts are made up.
 * Run: node --test tests/check-gifts-edges.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { W, CG, setup, run, rowOf, post, posted, fakeFetch, hand, read, txn, mirrorTransaction, readState, writeState, approve, dontSend, card, NOW, MIN, DAY, dayS, TX } from './lib/check-gifts-harness.mjs';

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
beforeEach(setup);
const env = () => W.env;
const world = () => W.world;
const forThisCheck = () => world().payments.filter((p) => p.amount === 1000000);
/** What a press of Send answered: its result, or the words it failed with */
const outcome = (p) => p.then((r) => r.result, (e) => e.message);

// ── 1. A hand entry made more than 21 days after the deposit is invisible: never linked, and a person is told
//       "Zeffy has no record of it", and Send makes a second record ───────────────────────────────────────────
test('F1 a hand entry made long after the deposit is put to a person, and the check is never doubled', async () => {
  await posted();                                    // deposited Nov 5, posted Nov 7 → its card waits on a person
  assert.equal((await rowOf()).state, 'person');
  // Staff enter the stack on Dec 5 (30 days after the deposit), not backdated
  world().payments.push(hand({ id: 'zp_late', created: dayS('2026-12-05'), campaign_id: 'form_grant' }));
  await run(Date.parse('2026-12-06T16:00:00Z'));
  const watched = await rowOf();
  // A monthly giver's next check could be it too, so a person says: it's offered on the card, not linked
  assert.equal(watched.state, 'person');
  assert.match(watched.note, /zp_late/);
  await run(Date.parse('2026-12-20T16:00:00Z'));
  const asked = await rowOf();
  assert.notEqual(asked.reason, 'ready', 'never "everything is filled in": the card says Zeffy may have it');
  assert.ok((await card()).card.notes.some((n) => n.kind === 'maybe-double'), 'the card asks about the entry');
  const saved = await outcome(approve(TX, { now: Date.parse('2026-12-20T17:00:00Z') }));
  assert.match(String(saved), /may be this check/, 'Send shows the entry first');
  await CG.personLink(env(), TX, 'zp_late', { now: Date.parse('2026-12-20T17:01:00Z'), fetchImpl: fakeFetch });
  assert.equal((await rowOf()).state, 'linked');
  assert.equal(forThisCheck().length, 1);
});

// ── 2. "Not those" saves past entries the person never saw ──────────────────────────────────────────────────
test('F2 notThose only covers the entries the page showed', async () => {
  await run();
  const shown = hand({ id: 'zp_oak', buyer: { first_name: 'Oak', last_name: 'Trust' } });
  world().payments.push(shown);
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'maybe-double', status = 'sent', note = ? WHERE id = ?`)
    .bind(JSON.stringify([{ id: 'zp_oak', name: 'Oak Trust', cents: 1000000, at: shown.created, form: '' }]), TX).run();
  // After the page loaded, the donor's own pay-by-check promise (under the trustee's name) shows up in Zeffy
  world().payments.push(hand({ id: 'zp_promise', type: 'online', status: 'pending', created: dayS('2026-11-06'), buyer: { first_name: 'Dana', last_name: 'Whitlock' } }));
  // "It's a different gift": with nothing named as shown, and with only Oak Trust's entry named (what the page showed)
  for (const shownIds of [[], ['zp_oak']]) {
    const r = await outcome(approve(TX, { donor: 'new', formId: 'form_grant', notThose: true, shown: shownIds }));
    assert.equal(world().posts.length, 0, `a record was saved past an entry nobody was shown (${r})`);
  }
});

// ── 3. The write test: a POST that times out but saved leaves a $1 record nobody is told about ──────────────
test('F3 write test never leaves an untracked $1 record behind', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: null });
  world().postFails = (n) => (n === 2 ? 'saved-then-lost' : null);
  const r = (await run()).writeTest;
  const left = world().payments.map((p) => p.id);
  assert.equal(r.ok, false, 'a POST with no answer fails the test');
  assert.deepEqual({ inZeffy: left, reportedLeft: r.leftBehind }, { inZeffy: [], reportedLeft: [] }, 'the record that saved anyway is found and removed');
});
test('F3b a write test that keeps failing tries three days, then stops', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: null });
  world().postFails = (n) => (n % 3 === 0 ? 422 : null);   // the one-word name is refused every time
  for (let d = 0; d < 5; d++) await run(NOW + d * (DAY + MIN));
  assert.equal(world().posts.length, 9, `three tries of three records, then none (${world().posts.length})`);
  assert.equal((await readState(env().DB, 'check-gifts')).writeTest.tries, 3);
});

// ── 4. Gifts passing through a DAF sponsor or an IRA custodian teach that sponsor as one donor ──────────────
test('F4 a second National Christian Foundation check never lands on the first donor\'s record', async () => {
  world().contacts.contact_dana = { id: 'contact_dana', email: 'dana@example.com', last_name: 'Lee' };
  world().reading = read({ payer: 'National Christian Foundation' });
  world().payments.push(hand({ id: 'zp_dana', contact: 'contact_dana', created: dayS('2026-11-04'), buyer: { first_name: 'Dana', last_name: 'Lee' } }));
  await posted();                                     // Dana's hand entry, same amount, another name → asked on the card
  assert.equal((await rowOf()).reason, 'maybe-double');
  await CG.personLink(env(), TX, 'zp_dana', { by: 'holly', now: NOW, fetchImpl: fakeFetch });   // "This is the check"
  // A month later, a $2,500 NCF grant recommended by a different donor
  world().txns.tx_2 = txn({ id: 'tx_2', amount: 2500, checkNumber: '2001', createdAt: '2026-12-01T15:00:00Z', status: 'sent', postedAt: '2026-12-02T15:00:00Z' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: NOW });
  world().reading = read({ payer: 'National Christian Foundation', amount: 2500, checkNumber: '2001', date: '2026-11-28' });
  const t = Date.parse('2026-12-03T16:00:00Z');
  for (let i = 0; i < 3; i++) await run(t + i * 10 * MIN);
  assert.notEqual((await card('tx_2')).card.donor, 'contact_dana', 'the card starts on Dana\'s donor');
  await approve('tx_2', { now: t + 31 * MIN });       // Send, as the card is filled in
  const made = world().posts.find((p) => p.amount === 250000);
  assert.ok(made, 'the second check was made');
  assert.notEqual(made.email, 'dana@example.com', 'Bob\'s gift went onto Dana\'s donor record with her email');
});
test('F4b common DAF sponsors and IRA custodians are treated as pass-through (never taught as one donor)', async () => {
  const names = ['National Christian Foundation', 'DAFgiving360', 'Edward Jones', 'Charles Schwab & Co', 'Morgan Stanley', 'Raymond James', 'Merrill Lynch', 'Pershing LLC', 'American Endowment Foundation'];
  const taught = [];
  for (const [i, name] of names.entries()) {
    const id = `t${i}`;
    await env().DB.prepare(`INSERT INTO check_gifts (id, cents, state, status, payer, deposited_at) VALUES (?, 1000000, 'person', 'sent', ?, '2026-11-05T15:00:00Z')`).bind(id, name).run();
    world().payments.push(hand({ id: `zp_${i}`, contact: `c_${i}`, buyer: { first_name: 'Some', last_name: `Donor${i}` } }));
    await CG.personLink(env(), id, `zp_${i}`, { now: NOW, fetchImpl: fakeFetch });
  }
  for (const r of (await env().DB.prepare('SELECT name FROM check_payers').all()).results) taught.push(r.name);
  assert.deepEqual(taught, []);
});

// ── 5. A middle initial C or O goes into Zeffy in lower case ─────────────────────────────────────────────────
test('F5 JOHN C SMITH is John C Smith, not John c Smith', () => {
  const p = (payer) => CG.proveRead([read({ payer }), read({ payer })], { cents: 1000000, checkNumber: '1042' }).payer;
  assert.deepEqual([p('JOHN C SMITH'), p('DANA O MILLER')], ['John C Smith', 'Dana O Miller']);
  assert.equal(CG.nameParts(p('JOHN C SMITH')).first_name, 'John C');
});

// ── 6. An accent on the check vs none in Zeffy is "another name" ─────────────────────────────────────────────
test('F6 José García\'s check finds the hand entry typed Jose Garcia', () => {
  const row = { id: 'x', cents: 1000000, payer: 'José García', check_date: '2026-11-03', deposited_at: '2026-11-05T15:00:00Z' };
  const entry = hand({ buyer: { first_name: 'Jose', last_name: 'Garcia' } });
  assert.equal(CG.sameGiver('José García', 'Jose Garcia'), true);
  assert.equal(CG.notesFor(row, { payments: [entry], forms: [{ id: 'form_home', title: 'Help Build a Brighter Home' }] }).link, entry);
});

// ── 7. A person's action lands on a check whose POST is still out ────────────────────────────────────────────
test('F7 "Don\'t send" pressed while another person\'s Send is in flight is refused, not overwritten', async () => {
  await run();
  post();
  await run(NOW + 10 * MIN);                           // its card
  world().postHook = async () => { world().postHook = null; world().notGift = await outcome(dontSend(TX, 'refund', { by: 'holly', now: NOW + 11 * MIN })); };
  await approve(TX, { by: 'peter', now: NOW + 11 * MIN });
  const r = await rowOf();
  assert.notEqual(world().notGift, 'left-out', `the person was told "left out", and the row ended "${r.state}" with Zeffy record ${r.zeffy_id}`);
});
test('F7b a check whose POST is unsure can\'t be left out or linked by hand, orphaning the record that lands', async () => {
  world().postFails = 'timeout';
  await posted();
  assert.match(await outcome(approve(TX, { now: NOW + 11 * MIN })), /didn’t answer/);
  assert.equal((await rowOf()).state, 'unsure');
  world().postFails = null;
  const notGift = await outcome(dontSend(TX, 'refund', { now: NOW + 12 * MIN }));
  // The POST did land after all
  world().payments.push(hand({ id: 'zeffy_landed', campaign_id: 'form_grant', created: dayS('2026-11-03') }));
  world().slack = [];
  for (let h = 1; h <= 4; h++) await run(NOW + h * 61 * MIN);
  const r = await rowOf();
  assert.ok(notGift !== 'left-out' || r.zeffy_id === 'zeffy_landed' || world().slack.length > 0,
    `left out while unsure; the record it made (zeffy_landed) is unclaimed and nobody was told (state ${r.state})`);
});

// ── 8. Open checks never age out of the hourly match: the oldest 100 hold the line, and their age widens the read ──
test('F8 a new check still links its hand entry when 100 older checks are waiting', async () => {
  for (let i = 0; i < 100; i++) {
    await env().DB.prepare(`INSERT INTO check_gifts (id, cents, state, reason, status, deposited_at, final) VALUES (?, ?, 'person', 'unreadable', 'sent', ?, 1)`)
      .bind(`old_${i}`, 5000 + i, new Date(Date.parse('2026-06-01T15:00:00Z') + i * DAY).toISOString()).run();
  }
  await posted();
  world().payments.push(hand({ campaign_id: 'form_grant' }));
  await run(NOW + 2 * 60 * MIN);
  assert.equal((await rowOf()).state, 'linked');
});
test('F8b one year-old waiting check makes the hourly read start from it, and a big read stops every match', async () => {
  await env().DB.prepare(`INSERT INTO check_gifts (id, cents, state, reason, status, deposited_at, final) VALUES ('old', 5000, 'person', 'unreadable', 'sent', '2025-09-01T15:00:00Z', 1)`).run();
  await posted();
  // 3,001 ordinary online gifts over the last 14 months
  for (let i = 0; i < 3001; i++) world().payments.push(hand({ id: `online_${i}`, type: 'online', payment_method: { type: 'card' }, amount: 2500, created: dayS('2025-10-01') + i * 3600 * 3 }));
  world().payments.push(hand({ campaign_id: 'form_grant' }));
  await CG.maybeRunChecks(env(), { now: NOW + 2 * 60 * MIN, fetchImpl: fakeFetch });
  const st = await readState(env().DB, 'check-gifts');
  assert.deepEqual({ state: (await rowOf()).state, error: st.lastError?.error || null }, { state: 'linked', error: null });
});

// ── 9. In the same hour the site finds its record gone, it also says the check is in Zeffy twice ────────────
test('F9 a record deleted and re-entered by hand is not called a double', async () => {
  await posted();
  await approve(TX, { now: NOW + 11 * MIN });
  assert.equal((await rowOf()).state, 'created');
  // Staff delete the site's record and type it again by hand (Zeffy can't edit a payment)
  world().payments = [hand({ id: 'zp_retyped', created: dayS('2026-11-09'), campaign_id: 'form_grant' })];
  world().slack = [];
  await run(NOW + 2 * 60 * MIN);
  const said = world().slack.join('\n');
  assert.equal(/twice/.test(said), false, 'told to delete "the extra one" when only one record is left');
});

// ── 10. Mercury's name for the payer beats both readers, and a bank read as the payer goes in as the giver ──
test('F10 suspected: a bank never becomes the giver, from Mercury or the readers', () => {
  const cashier = read({ payer: 'Truist Bank', cashiersCheck: true, remitter: 'Dana Lee' });
  const viaHint = CG.proveRead([cashier, cashier], { cents: 1000000, checkNumber: '1042', hint: 'Truist Bank' });
  const both = CG.proveRead([read({ payer: 'Truist Bank' }), read({ payer: 'Truist Bank' })], { cents: 1000000, checkNumber: '1042' });
  const v = CG.notesFor({ id: 'x', cents: 1000000, payer: both.payer, check_date: '2026-11-03', deposited_at: '2026-11-05T15:00:00Z' }, { forms: [{ id: 'form_home', title: 'Help Build a Brighter Home' }] });
  // The readers' bank: its card asks a person who sent it before anything is sent
  const asks = !v.link && v.notes.some((n) => ['bank', 'unreadable'].includes(n));
  assert.deepEqual({ hintPayer: viaHint.payer, readersPayer: asks ? 'person' : v.notes.join(',') || 'nothing to ask' }, { hintPayer: 'Dana Lee', readersPayer: 'person' });
});

// ── 11. A check with no open form, or that Zeffy refused, stays with a person after the cause is gone ───────
test('F11 no-form clears itself off the card once the form is open again', async () => {
  const all = world().forms;
  world().forms = [];
  await posted();
  assert.equal((await rowOf()).reason, 'no-form');
  world().forms = all;
  for (let h = 1; h <= 3; h++) await run(NOW + h * 61 * MIN);
  const c = await card();
  assert.deepEqual({ reason: (await rowOf()).reason, notes: c.card.notes.map((n) => n.kind), form: c.card.formId }, { reason: 'ready', notes: [], form: 'form_grant' });
  await approve(TX, { now: NOW + 4 * 61 * MIN });
  assert.equal((await rowOf()).state, 'created');
});

// ── 12. The write test never sends an email, the one field that can reach a donor ──────────────────────────
test('F12 suspected: the write test exercises the email field before a donor\'s record gets one', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: null });
  await run();
  assert.ok(world().posts.some((p) => 'email' in p), 'no test POST carried an email, but On sends a learned donor\'s email');
});

// ── 13. A new write test that fails leaves sending on ───────────────────────────────────────────────────────
test('F13 a failed re-run of the write test stops sending', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: { id: '2026-01-01', ok: true } });
  world().postFails = 422;
  await run();
  assert.equal((await readState(env().DB, 'check-gifts')).writeTest.ok, false);
  world().postFails = null;
  world().posts = [];
  await run(NOW + 10 * MIN);
  post();
  await run(NOW + 20 * MIN);
  const sent = await outcome(approve(TX, { now: NOW + 21 * MIN }));
  assert.match(sent, /Sending is off/);
  assert.equal(world().posts.length, 0, 'real records were made after the write test failed');
});

// ── 14. A person can save a check Mercury hasn't posted yet ─────────────────────────────────────────────────
// Since Nov 9 a check is saved while Mercury reviews it (Peter): a person's save no longer waits for posting
test('F14 a person\'s save goes in while Mercury reviews the check, and one Mercury turned down never does', async () => {
  await run();
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'unreadable', payer = NULL WHERE id = ?`).bind(TX).run();
  assert.equal((await rowOf()).status, 'pending');
  await approve(TX, { name: 'Pine Foundation', donor: 'new', formId: 'form_grant' });
  assert.equal(world().posts.length, 1);
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'unreadable', status = 'cancelled', zeffy_id = NULL WHERE id = ?`).bind(TX).run();
  // The page shows no card for it any more; a screen still open on the old one presses Send all the same
  const late = await outcome(CG.personSend(env(), TX, { name: 'Pine Foundation', donor: 'new', formId: 'form_grant', by: 'holly@example.com', now: NOW, fetchImpl: fakeFetch }));
  assert.match(late, /Mercury didn’t take this check/);
  assert.equal(world().posts.length, 1);
});

// ── 15. Zeffy's answer without an id at the top is stored as zeffy_id "undefined", and the write test passes ─
test('F15 suspected: a POST answer with no id fails the write test instead of being stored as "undefined"', async () => {
  world().postShape = (p) => ({ data: p });
  const t = await CG.testWrite(env(), { now: NOW, fetchImpl: fakeFetch });
  assert.equal(t.ok, false, 'the write test passed on an answer with no payment id');
});

// ── 16. A reader answering the boolean as text makes every check unreadable ─────────────────────────────────
test('F16 suspected: cashiersCheck "false" (text) is not a cashier\'s check', () => {
  const r = read({ cashiersCheck: 'false' });
  assert.equal(CG.proveRead([r, r], { cents: 1000000, checkNumber: '1042' }).ok, true);
});

// ── Held up in the same round ────────────────────────────────────────────────

test('two heartbeats at once on a read check make one card and POST nothing, and with a Send among them POST once', async () => {
  await run();
  post();
  await Promise.all([run(NOW + 10 * MIN), run(NOW + 10 * MIN), run(NOW + 10 * MIN)]);
  assert.deepEqual({ state: (await rowOf()).state, posts: W.world.posts.length }, { state: 'person', posts: 0 });
  await Promise.all([approve(TX, { now: NOW + 15 * MIN }).catch((e) => e.message), run(NOW + 15 * MIN), run(NOW + 15 * MIN)]);
  assert.equal(W.world.posts.length, 1);
});
test('a double-click on Send POSTs once', async () => {
  await run();
  await W.env.DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'unreadable', status = 'sent', payer = NULL WHERE id = ?`).bind(TX).run();
  const go = () => approve(TX, { name: 'Pine Foundation', donor: 'new', formId: 'form_grant' }).catch((e) => e.message);
  await Promise.all([go(), go()]);
  assert.equal(W.world.posts.length, 1);
});
test('the site by itself writes nothing to Zeffy across reads, cards, hand entries, returns and hours', async () => {
  await posted();
  W.world.payments.push(hand({ id: 'zp_other', buyer: { first_name: 'Oak', last_name: 'Trust' } }));
  for (let h = 1; h <= 30; h++) await run(NOW + h * 61 * MIN);
  W.world.txns[TX] = { ...W.world.txns[TX], status: 'failed' };
  await run(NOW + 40 * DAY);
  assert.equal(W.world.posts.length, 0);
  assert.equal(W.world.deletes.length, 0);
});
test('a late-night Eastern deposit keeps its day on the record', async () => {
  const r = CG.recordFor({ cents: 100, check_date: null, deposited_at: '2026-03-09T03:30:00Z' }, { name: 'A B', form: { id: 'f' } });
  assert.equal(r.payment_date, '2026-03-08T17:00:00.000Z');
});
void dayS;
