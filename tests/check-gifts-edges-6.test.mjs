/**
 * A seventh break-it round on Nov 7 2026, aimed at the wide look: a promise paid by a different payer, a check typed with
 * the wrong year or amount, a check split into its donors' gifts, a bounced check deposited again, a fund's grant on its
 * advisor's contact. Fake Zeffy: tests/lib/check-gifts-harness-2.mjs. Each test failed before its fix. Names are made up.
 * Run: node --test tests/check-gifts-edges-6.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, run, rowOf, post, posted, fakeFetch, hand, read, txn, mirrorTransaction, slackSaid, approve, card, NOW, MIN, DAY, dayS, TX } = await import('./lib/check-gifts-harness-2.mjs');
const { handlePayment, runSweep } = await import('../functions/api/_zeffy.js');

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => setup());
const env = () => W.env;
const world = () => W.world;
const person = (first, last, o = {}) => ({ first_name: first, last_name: last, email: null, is_corporate: false, company_name: null, ...o });
const DANA = person('Dana', 'Whitfield', { email: 'dana@example.com' });
const sitePosts = () => world().posts.filter((b) => b.amount > 100);
/** One amount for the whole test: Mercury's deposit and both readings */
async function amountIs(dollars, reading = {}) {
  world().txns[TX] = txn({ amount: dollars });
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
  world().reading = read({ amount: dollars, ...reading });
}
/** The gift alert seeing a payment the way Zeffy's webhook would deliver it */
const alertSees = (p, at) => handlePayment(env(), p, { via: 'webhook', now: Date.parse(at) });
/**
 * What a check's card asks about (Nov 10: every check waits on a card for a person to send): its notes (REASONS keys) and the
 * Zeffy entries it lists for "This is the check"
 */
async function asked(id = TX) {
  const r = await rowOf(id);
  const c = await card(id);
  return { state: r.state, reason: r.reason, notes: (c?.card?.notes || []).map((n) => n.kind), entries: r.note?.startsWith('[') ? JSON.parse(r.note).map((x) => x.id) : [] };
}
/** A person pressing Send to Zeffy as the card says → the error it was refused with, or null when it went through */
const pressSend = (id = TX, over = {}) => approve(id, over).then(() => null, (e) => e);
/** The card asks about `entry` as a maybe-double, and pressing Send re-reads Zeffy and shows it instead of saving */
async function heldOver(entry, now, note = 'maybe-double') {
  const q = await asked();
  assert.deepEqual({ state: q.state, note: q.notes.includes(note), listed: q.entries.includes(entry) }, { state: 'person', note: true, listed: true },
    `the card is "${q.state}" with notes ${JSON.stringify(q.notes)} listing ${JSON.stringify(q.entries)}`);
  const held = await pressSend(TX, { now });
  assert.ok(held?.status === 409 && held.entries?.some((x) => x.id === entry), `Send ${held ? `was refused (${held.status}: ${held.message})` : 'went through'} without showing ${entry}`);
}

// ── 1. The rule that is meant to catch "a pledge marked paid since the check was written" (netOf's turnedPaid) only counts
//       the giver's own name. Dana Whitfield promised $10,000 on the online form on Sep 24, to pay by check. The check comes
//       from her family foundation, dated Nov 3. Staff mark the promise paid on Nov 4 when the check arrives in the mail,
//       and the gift alert sees it turn paid that day. The promise is 40 days older than the check (matchZeffy's other-name
//       promise window is 30 days, netOf's "since written" is 14), and its name isn't the foundation's: the site saves a
//       second $10,000 record, and the hourly double check only looks at hand entries, so nobody hears ─────────────────────
test('H1 a promise staff marked paid when the family foundation\'s check arrived is never saved a second time', async () => {
  world().reading = read({ payer: 'Whitfield Family Foundation' });
  const promise = hand({ id: 'zp_promise', type: 'online', status: 'pending', created: dayS('2026-09-24'), contact: 'c_dana', buyer: DANA });
  world().payments.push(promise);
  // Nov 4: the check is in the mail pile, staff mark the promise paid; Zeffy's alert reaches the site
  promise.status = 'succeeded';
  await alertSees(promise, '2026-11-04T15:00:00Z');
  await posted();
  for (let h = 1; h <= 3; h++) await run(NOW + 10 * MIN + h * 61 * MIN);
  await heldOver('zp_promise', NOW + 10 * MIN + 4 * 61 * MIN);
  const r = await rowOf();
  const tp = (await env().DB.prepare('SELECT payment_id, updated_at FROM zeffy_gifts').all()).results;
  assert.deepEqual({ posts: sitePosts().length }, { posts: 0 },
    `Zeffy holds the paid $10,000 promise and the site's new $10,000 record for one check (row "${r.state}"); the alerts saw zp_promise turn paid at ${tp.find((x) => x.payment_id === 'zp_promise')?.updated_at}, after the check was written; Slack ${/twice/.test(slackSaid()) ? 'flagged' : 'never flagged'} a double`);
});

// ── 2. Same root: an entry typed after the check was written but dated before it. In the Zeffy dashboard staff type a
//       Fidelity grant under the advisor's name on Nov 4 and pick the wrong year (Nov 3 2025: the January slip, here in
//       November). netOf's first rule goes by `created` (the backdated day), its turnedPaid rule (which knows the alert saw
//       it on Nov 4) only by the giver's own name ──────────────────────────────────────────────────────────────────────────
test('H2 a hand entry under the advisor\'s name, typed after the check came but dated a year back by a slip, is never saved again', async () => {
  world().reading = read({ payer: 'Fidelity Charitable', memo: 'Recommended by Dana Whitfield' });
  const typed = hand({ id: 'zp_slip', created: dayS('2025-11-03'), buyer: person('Dana', 'Whitfield') });
  world().payments.push(typed);
  await alertSees(typed, '2026-11-04T15:00:00Z');
  await posted();
  await heldOver('zp_slip', NOW + 15 * MIN);
  const r = await rowOf();
  assert.deepEqual({ posts: sitePosts().length }, { posts: 0 },
    `two $10,000 records for one check (Zeffy's zp_slip, typed Nov 4 2026 but dated Nov 3 2025, and the site's), row "${r.state}"`);
});

// ── 2b. The giver's own name, same slip, but Zeffy's webhook never delivered it (an outage longer than its 3 days of
//        retries, or the event not ticked). turnedPaid then has nothing: the 15-minute catch-up lists only payments
//        *created* in the last 2 days, and a backdated entry's `created` is its backdated day ────────────────────────────
test('H2b the giver\'s own entry dated a year back by a slip, missed by the webhook, is never saved again', async () => {
  await run(Date.parse('2026-11-02T12:00:00Z'));   // the site has been reading Zeffy since it went live, before the slip was typed
  world().payments.push(hand({ id: 'zp_slip', created: dayS('2025-11-03') }));   // Pine Foundation, typed Nov 4 2026
  // The catch-up sweeps run all along (here: Nov 4 and Nov 5); they never list it
  await runSweep(env(), { now: Date.parse('2026-11-04T16:00:00Z'), fetchImpl: fakeFetch });
  await runSweep(env(), { now: Date.parse('2026-11-05T16:00:00Z'), fetchImpl: fakeFetch });
  const seen = await env().DB.prepare("SELECT 1 FROM zeffy_gifts WHERE payment_id = 'zp_slip'").first().catch(() => null);
  await posted();
  await heldOver('zp_slip', NOW + 15 * MIN);
  const r = await rowOf();
  assert.deepEqual({ posts: sitePosts().length }, { posts: 0 },
    `the site saved Pine Foundation's $10,000 a second time (row "${r.state}"); the sweep ${seen ? 'saw' : 'never saw'} zp_slip`);
});

// ── 3. An amount typo under another name. Staff type the Fidelity grant under Dana Whitfield on Nov 4, $1,000 for
//       $10,000. netOf drops every entry whose amount isn't the check's to the cent; matchZeffy's "other amount" is only
//       for the giver's own name. Zeffy ends with $11,000 for a $10,000 check ────────────────────────────────────────────
// After round 8: asking a person about every hand entry typed since On, whatever its amount, sent most checks to a person
// (the golf table, a check from another bank). The weekly money check names a mistyped entry like this one instead
test('H3 a hand entry under the advisor\'s name with a mistyped amount is named by the Monday money check', async () => {
  await run(Date.parse('2026-11-02T12:00:00Z'));   // the site has been reading Zeffy since it went live, before the typo was typed
  world().reading = read({ payer: 'Fidelity Charitable', memo: 'Recommended by Dana Whitfield' });
  world().payments.push(hand({ id: 'zp_typo', amount: 100000, created: dayS('2026-11-04'), buyer: person('Dana', 'Whitfield') }));
  await posted();
  assert.equal((await approve(TX, { now: NOW + 15 * MIN })).result, 'created', 'a person sends the card as it is filled in');
  for (let h = 1; h <= 3; h++) await run(NOW + 10 * MIN + h * 61 * MIN);
  const m = await CG.moneyCheck(env(), { now: NOW + 2 * DAY, fetchImpl: fakeFetch });
  assert.deepEqual(m.loose.map((x) => x.id), ['zp_typo'], 'the $1,000 entry with no check behind it is named');
  assert.match(slackSaid(), /no check in Mercury/);
});

// ── 4. One check, several gifts. United Way's $1,250 designation check pays three workplace donors; staff type each from
//       the remittance sheet the day it arrives ($500 + $500 + $250, by check, under the donors' names) so each is thanked.
//       No entry is $1,250, so the wide look finds nothing and the site saves the whole $1,250 on top: $2,500 in Zeffy.
//       The site already calls United Way "money that passes through for someone else" (PASS_THROUGH), but only uses that
//       to not learn a contact ──────────────────────────────────────────────────────────────────────────────────────────────
test('H4 a United Way check that staff already split into its donors\' gifts is never saved again as one more gift', async () => {
  await run(Date.parse('2026-11-02T12:00:00Z'));   // the site has been reading Zeffy since it went live
  await amountIs(1250, { payer: 'United Way of Lakeview', memo: 'Designations Q3' });
  for (const [id, cents, first, last] of [['zp_uw1', 50000, 'Lee', 'Park'], ['zp_uw2', 50000, 'Ana', 'Ruiz'], ['zp_uw3', 25000, 'Sam', 'Ortiz']]) {
    world().payments.push(hand({ id, amount: cents, created: dayS('2026-11-04'), buyer: person(first, last) }));
  }
  await posted();
  await heldOver('zp_uw1', NOW + 15 * MIN);
  const q = await asked();
  assert.deepEqual(['zp_uw1', 'zp_uw2', 'zp_uw3'].filter((id) => q.entries.includes(id)), ['zp_uw1', 'zp_uw2', 'zp_uw3'], 'the card lists all three designations');
  const r = await rowOf();
  assert.deepEqual({ posts: sitePosts().length }, { posts: 0 },
    `Zeffy has the three designations ($1,250 in all) and the site's $1,250 record for the same check; row "${r.state}"`);
});

// ── 5. A check that bounced (NSF) and is deposited again. The first deposit posted, the site saved it, then Mercury sent it
//       back: the row is "came-back" and keeps its zeffy_id, so that record stays "claimed". The same check (same number,
//       same amount) is deposited again on Nov 20 and posts: the wide look leaves out the first record (claimed), and the
//       site saves a second one. Staff were told to cancel the first ("Zeffy tells the donor when you do"), which is just
//       what they'd hold off on while the check goes through again ───────────────────────────────────────────────────────
test('H5 a bounced check deposited again, whose first record still stands, is matched to it or asked about, not saved twice', async () => {
  await posted();
  await approve(TX, { now: NOW + 15 * MIN });
  const first = await rowOf();
  assert.equal(first.state, 'created');
  // Nov 12: Mercury returns it
  world().txns[TX] = { ...world().txns[TX], status: 'reversed' };
  await run(Date.parse('2026-11-12T16:00:00Z'));
  assert.equal((await rowOf()).state, 'came-back');
  // Nov 20: the same paper check goes in again
  world().txns.tx_2 = txn({ id: 'tx_2', createdAt: '2026-11-20T15:00:00Z', status: 'pending' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: Date.parse('2026-11-20T16:00:00Z') });
  let t = Date.parse('2026-11-20T16:00:00Z');
  for (let i = 0; i < 3; i++, t += 6 * MIN) await run(t);
  world().txns.tx_2 = { ...world().txns.tx_2, status: 'sent', postedAt: '2026-11-22T15:00:00Z' };
  for (let i = 0; i < 4; i++, t += 6 * MIN) await run(Date.parse('2026-11-22T16:00:00Z') + i * 6 * MIN);
  const q = await asked('tx_2');
  assert.ok(q.state === 'linked' || (q.state === 'person' && q.notes.includes('redeposit')), `the redeposit is "${q.state}" with notes ${JSON.stringify(q.notes)}`);
  // A person pressing Send on the redeposit's card as it is: Zeffy is read again first, and the first record is matched or shown
  if (q.state === 'person') await pressSend('tx_2', { now: Date.parse('2026-11-22T17:00:00Z') });
  const again = await rowOf('tx_2');
  const records = world().payments.filter((p) => p.amount === 1000000).map((p) => p.id);
  assert.deepEqual({ posts: sitePosts().length }, { posts: 1 },
    `one paper check, ${records.length} records in Zeffy (${records.join(', ')}); the redeposit is "${again.state}"${again.reason ? ` (${again.reason})` : ''}`);
});

// ── 6. Six or more entries the wide look can't rule out: "Send a new record" can never go through. Only 5 were ever shown
//       (entriesToShow sliced to 5), and personCreate (now personSend) insisted every one it found was shown. A $500 check written in
//       January with last year's date makes the look span a year of unclaimed $500 hand entries (all hand-entered before
//       Mercury). Here: 7 of them, under other names ─────────────────────────────────────────────────────────────────────
test('H6 a person can save a check the wide look found six entries for, after saying each one shown is a different gift', async () => {
  await amountIs(500, { payer: 'Oak Hollow Garden Club', date: '2025-11-03' });
  const names = [['Ann', 'Bell'], ['Raj', 'Mehta'], ['Kim', 'Lowe'], ['Tom', 'Reyes'], ['Eve', 'Cho'], ['Bo', 'Grant'], ['Liz', 'Hart']];
  names.forEach(([f, l], i) => world().payments.push(hand({ id: `zp_old_${i}`, amount: 50000, created: dayS('2025-12-10') + i * 40 * 86400, buyer: person(f, l) })));
  await posted();
  const r0 = await rowOf();
  assert.equal(r0.state, 'person');
  // The page's own loop (public/admin/checks.js send): Send, then "Send a new record" with what it was shown, again and again
  let shown = [];
  let out = null;
  let rounds = 0;
  for (; rounds < 4 && !out; rounds++) {
    try {
      out = await approve(TX, { name: 'Oak Hollow Garden Club', formId: 'form_home', day: '2026-11-05', notThose: rounds > 0, shown, by: 'staff@soard.test', now: NOW + 20 * MIN + rounds * MIN });
    } catch (e) {
      if (!e.entries) throw e;
      shown = [...shown, ...e.entries.map((x) => x.id)];
    }
  }
  assert.ok(out?.result === 'created', `after ${rounds} rounds of "Send a new record" nothing was saved; the page was shown ${new Set(shown).size} distinct entries of the 7 the site holds against it`);
});

// ── 7. Nuisance: a question only the wide look raised is taken back every hour. matchOpen re-asks with matchZeffy's
//       windows only, finds nothing, and sends the check back to "read" ("what it was asked about has gone"). It's re-decided
//       one check a run, oldest deposit first, so while another check holds the run it sits out of Needs you and Save refuses it
test('H7 minor: a check the wide look sent to a person stays with the person through the hourly look', async () => {
  // Dana Whitfield's entry, dated a week before the Fidelity check's date: inside the wide look, outside matchZeffy's 3 days
  world().reading = read({ payer: 'Fidelity Charitable', memo: 'Recommended by Dana Whitfield' });
  world().payments.push(hand({ id: 'zp_wk', created: dayS('2026-10-27'), buyer: person('Dana', 'Whitfield') }));
  await posted();
  const first = await asked();
  assert.equal(first.state, 'person');
  assert.ok(first.notes.includes('maybe-double') && first.entries.includes('zp_wk'), `the card asks ${JSON.stringify(first)}`);
  // Another check, deposited the day before, posts just as the hourly look runs: it takes that run's one decision
  world().txns.tx_b = txn({ id: 'tx_b', amount: 2500, checkNumber: '77', createdAt: '2026-11-04T15:00:00Z', status: 'sent', postedAt: '2026-11-10T16:30:00Z' });
  await mirrorTransaction(env().DB, world().txns.tx_b, { now: NOW });
  await env().DB.prepare(`INSERT INTO check_gifts (id, account_id, status, cents, deposited_at, posted_at, check_number, state, payer, check_date, created_at, updated_at)
    VALUES ('tx_b', 'acct_check', 'sent', 250000, '2026-11-04T15:00:00Z', '2026-11-10T16:30:00Z', '77', 'read', 'Oak Hollow Garden Club', '2026-11-02', 'x', 'x')`).run();
  const t = NOW + 62 * MIN;
  await run(t);
  const r = await rowOf();
  const still = await asked();
  const v = await card();
  let save = 'saved';
  try { await approve(TX, { name: 'Fidelity Charitable', formId: 'form_home', day: '2026-11-03', notThose: true, shown: ['zp_wk'], by: 'staff@soard.test', now: t + MIN }); } catch (e) { save = `${e.status}: ${e.message}`; }
  assert.deepEqual({ state: r.state, listed: still.entries.includes('zp_wk'), needsYou: v.needsYou }, { state: 'person', listed: true, needsYou: true },
    `right after the hourly look the check is "${r.state}" (note ${r.note}); Needs you: ${v.needsYou}; the person's Send: ${save}`);
});
// ── 1b. H1 while the promise is still open (S13 chose not to ask about other names' open promises past 30 days). The
//        site saves past Dana's open $10,000 promise; when staff mark it paid a week later (the usual "check came in" step),
//        Zeffy has $20,000, and the hourly double check never looks at a promise (it takes hand entries only) ────────────
test('H1b a donor\'s open promise, paid by her foundation\'s check 40 days later, never ends up as a second $10,000 nobody hears about', async () => {
  world().reading = read({ payer: 'Whitfield Family Foundation' });
  const promise = hand({ id: 'zp_promise', type: 'online', status: 'pending', created: dayS('2026-09-24'), contact: 'c_dana', buyer: DANA });
  world().payments.push(promise);
  await posted();
  // A person sends the card as it is filled in (the site doesn't ask about another name's promise older than 30 days)
  const held = await pressSend(TX, { now: NOW + 15 * MIN });
  const saved = (await rowOf()).state;
  promise.status = 'succeeded';
  await alertSees(promise, '2026-11-12T15:00:00Z');
  for (let h = 1; h <= 4; h++) await run(Date.parse('2026-11-12T16:00:00Z') + h * 61 * MIN);
  const flagged = /twice|double/i.test(slackSaid());
  assert.ok(!sitePosts().length || flagged, `the site ${sitePosts().length ? 'saved' : `didn't save (${held?.message})`} the check (row "${saved}"), staff then marked the promise paid, and nobody was told Zeffy has $20,000 for it`);
});

// ── 8. Minor: the giver's own open promise older than the 400 days read is never seen ──────────────────────────────────
test('H8 minor: a giver\'s own pay-by-check promise from 14 months ago, still open, is asked about before the check is saved', async () => {
  world().payments.push(hand({ id: 'zp_old_promise', type: 'online', status: 'pending', created: dayS('2025-09-15'), contact: 'c_pine',
    buyer: { first_name: 'Pine', last_name: 'Foundation', email: 'grants@pine.example.org', is_corporate: false, company_name: null } }));
  await posted();
  await heldOver('zp_old_promise', NOW + 15 * MIN, 'pledge');
  const r = await rowOf();
  assert.deepEqual({ posts: sitePosts().length }, { posts: 0 }, `saved past Pine's open $10,000 promise from Sep 15 2025 (row "${r.state}")`);
});
// ── 5b. Same root as H5: one paper check deposited twice (a second mobile deposit of the same picture, which the bank
//        returns days later as a duplicate). Both post; the second has the same check number, amount and giver as a check
//        that already has its record, and the site saves it again ───────────────────────────────────────────────────────
test('H5b the same check number, amount and giver deposited twice is asked about before a second record is saved', async () => {
  await posted();
  await approve(TX, { now: NOW + 15 * MIN });
  assert.equal((await rowOf()).state, 'created');
  world().txns.tx_dup = txn({ id: 'tx_dup', createdAt: '2026-11-06T15:00:00Z', status: 'sent', postedAt: '2026-11-08T15:00:00Z' });
  await mirrorTransaction(env().DB, world().txns.tx_dup, { now: NOW });
  let t = NOW + 30 * MIN;
  for (let i = 0; i < 5; i++, t += 6 * MIN) await run(t);
  const q = await asked('tx_dup');
  assert.ok(q.state === 'person' && q.notes.includes('redeposit'), `the second deposit's card is "${q.state}" with notes ${JSON.stringify(q.notes)}`);
  // Pressing Send on it as it is: the first deposit's record is shown first, nothing sent
  const held = await pressSend('tx_dup', { now: t + MIN });
  assert.ok(held?.status === 409, `Send on the second deposit ${held ? `was refused (${held.status}: ${held.message})` : 'went through'}`);
  const dup = await rowOf('tx_dup');
  assert.deepEqual({ posts: sitePosts().length }, { posts: 1 }, `check #1042 for $10,000 from Pine Foundation, deposited twice, has ${sitePosts().length} records; the second deposit is "${dup.state}"`);
});
// ── 9. Wrong donor, F4's pattern through a sponsor the pass-through list doesn't name. Staff type the first Daffy grant the
//       way that credits the advisor: the sponsor's name in the name boxes, Dana's email (Zeffy files it on Dana's contact).
//       It links by name, and since the names are the check's, linkTo teaches Dana's contact as "Daffy Charitable Fund".
//       The next Daffy grant, recommended by someone else, is filed on Dana's contact by her email, under her names.
//       The same with "National Christian Foundation" (on the list) is safe ────────────────────────────────────────────────
for (const sponsor of ['Daffy Charitable Fund', 'Ayco Charitable Foundation', 'DonorsTrust', 'Lakeview Community Federation', 'National Christian Foundation']) {
  test(`H9 minor: a second ${sponsor} grant never lands on the first grant's advisor (${sponsor === 'National Christian Foundation' ? 'control' : 'not on the list'})`, async () => {
    world().contacts.c_dana = { id: 'c_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 2 };
    world().reading = read({ payer: sponsor });
    world().payments.push(hand({ id: 'zp_first', created: dayS('2026-11-04'), contact: 'c_dana', buyer: { first_name: sponsor, last_name: sponsor, email: 'dana@example.com', is_corporate: false, company_name: null } }));
    await posted();
    assert.equal((await rowOf()).state, 'linked');
    world().txns.tx_2 = txn({ id: 'tx_2', amount: 2500, checkNumber: '2001', createdAt: '2026-12-01T15:00:00Z', status: 'sent', postedAt: '2026-12-02T15:00:00Z' });
    await mirrorTransaction(env().DB, world().txns.tx_2, { now: NOW });
    world().reading = read({ payer: sponsor, amount: 2500, checkNumber: '2001', date: '2026-11-28', memo: 'Recommended by Bob Tran' });
    for (let i = 0; i < 3; i++) await run(Date.parse('2026-12-03T16:00:00Z') + i * 10 * MIN);
    // A person sends the card as it is filled in (a card that leaves the donor to the person is sent as a New donor)
    const k = (await card('tx_2'))?.card;
    await approve('tx_2', { now: Date.parse('2026-12-03T17:00:00Z'), ...(k && !k.donor ? { donor: 'new' } : {}) });
    const made = world().posts.find((p) => p.amount === 250000);
    assert.ok(made, 'the second grant was saved');
    assert.deepEqual({ email: made.email || null, dana: `${made.first_name} ${made.last_name}` === 'Dana Whitfield' }, { email: null, dana: false },
      `Bob Tran's $2,500 grant went into Zeffy on Dana Whitfield's contact (email ${made.email}) as "${made.first_name} ${made.last_name}"; the card had picked donor ${k?.donor} of ${JSON.stringify((k?.donors || []).map((d) => [d.id, d.name, d.email]))}`);
  });
}
