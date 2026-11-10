/**
 * More edges of a check becoming its Zeffy record, from a second break-it round on Nov 7 2026, against a fake Zeffy that
 * behaves the way its spec says (tests/lib/check-gifts-harness-2.mjs). Each B test failed before its fix. Names are made up.
 * Run: node --test tests/check-gifts-edges-2.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { W, CG, admin, setup, run, rowOf, post, posted, fakeFetch, hand, read, txn, mirrorTransaction, readState, writeState, noEmailGiver, tagged, slackSaid, NOW, MIN, DAY, dayS, TX } from './lib/check-gifts-harness-2.mjs';

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => setup());
const env = () => W.env;
const world = () => W.world;
const toPerson = (reason = 'unreadable') => env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = ?, status = 'sent', payer = NULL, posted_at = '2026-11-07T15:00:00Z' WHERE id = ?`).bind(reason, TX).run();

// ── 1. The heartbeat's clearTags takes off an address that a person's save is still using ─────────────────────────
test('B1 a heartbeat during a person\'s save never leaves a Zeffy contact holding the no-mail address', async () => {
  await CG.setMode(env(), 'on');
  await noEmailGiver();
  await run();                       // the row exists
  await toPerson();                  // nobody could read who wrote it; a person says
  // The heartbeat fires while the person's record is on its way to Zeffy (after the address went on the contact)
  world().hook = async ({ method, path }) => {
    if (method === 'POST' && path === '/payments') { world().hook = null; await run(NOW + 6 * MIN); }
  };
  const r = await CG.personCreate(env(), TX, { name: 'Pine Foundation', formId: 'form_home', now: NOW, fetchImpl: fakeFetch });
  assert.equal(r.result, 'created');
  const gift = world().payments.at(-1);
  assert.deepEqual(
    { contactsWithNoMailAddress: tagged().map((c) => `${c.id} ${c.email}`), giftOn: gift.contact, tagsKept: (await env().DB.prepare('SELECT COUNT(*) AS n FROM check_tags').first()).n },
    { contactsWithNoMailAddress: [], giftOn: 'c_pine', tagsKept: 0 },
    'a new contact was made holding the no-mail address, nothing will ever take it off, and the giver is now learned as that contact');
});

// ── 1b. Two saves for one no-email giver at once (the heartbeat's and a person's) ───────────────────────────────────
test('B1b two records filed under one no-email contact at once never leave the no-mail address on a contact', async () => {
  await CG.setMode(env(), 'on');
  await noEmailGiver();
  // Two checks from the same giver: the heartbeat makes one while a person saves the other
  world().txns.tx_2 = txn({ id: 'tx_2', amount: 500, checkNumber: '1043', createdAt: '2026-11-05T15:05:00Z', status: 'sent', postedAt: '2026-11-07T15:00:00Z' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: NOW });
  await posted();                                    // tx_1 read and decided: created (the giver's contact, through the address)
  assert.equal((await rowOf()).state, 'created');
  await run(NOW + 20 * MIN);                         // tx_2 read
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'event', status = 'sent' WHERE id = 'tx_2'`).run();
  // Next: tx_3 decided by the heartbeat while the person saves tx_2
  world().txns.tx_3 = txn({ id: 'tx_3', amount: 750, checkNumber: '1044', createdAt: '2026-11-05T15:10:00Z', status: 'sent', postedAt: '2026-11-07T15:00:00Z' });
  await mirrorTransaction(env().DB, world().txns.tx_3, { now: NOW });
  world().reading = read({ amount: 750, checkNumber: '1044' });
  await run(NOW + 30 * MIN);                         // tx_3 read → 'read'
  assert.equal((await rowOf('tx_3')).state, 'read');
  world().hook = async ({ method, path, body }) => {
    // The heartbeat's address is on the contact and its record is on the way: the person's save goes in between
    if (method === 'POST' && path === '/payments' && body.amount === 75000) {
      world().hook = null;
      world().inBetween = await CG.personCreate(env(), 'tx_2', { name: 'Pine Foundation', formId: 'form_home', now: NOW + 40 * MIN, fetchImpl: fakeFetch }).then((r) => r.result, (e) => e.message);
    }
  };
  await run(NOW + 40 * MIN);                         // decides tx_3
  // One save at a time a contact: the person is asked to try again, and does
  assert.match(world().inBetween, /Try again in a minute/);
  const again = await CG.personCreate(env(), 'tx_2', { name: 'Pine Foundation', formId: 'form_home', now: NOW + 42 * MIN, fetchImpl: fakeFetch });
  assert.equal(again.result, 'created');
  assert.deepEqual(tagged().map((c) => c.id), [], 'a contact keeps the no-mail address for good');
  assert.deepEqual(world().payments.filter((p) => p.created > 0 && [50000, 75000].includes(p.amount)).map((p) => p.contact), ['c_pine', 'c_pine'], 'both gifts on the giver\'s contact');
});

// ── 2. A hand entry made weeks late duplicates the site's record, and nobody is told ───────────────────────────────
test('B2 a hand entry typed weeks after the site saved the check is flagged as a possible double', async () => {
  await CG.setMode(env(), 'on');
  await posted();                                      // deposited Nov 5, posted Nov 7: the site saved it
  assert.equal((await rowOf()).state, 'created');
  // Out of habit, staff enter the stack on Dec 5, not backdated (30 days after the deposit)
  world().payments.push(hand({ id: 'zp_late', created: dayS('2026-12-05'), campaign_id: 'form_grant' }));
  world().slack = [];
  for (let h = 0; h < 3; h++) await run(Date.parse('2026-12-06T16:00:00Z') + h * 61 * MIN);
  assert.match(slackSaid(), /twice/, 'two records for one $10,000 check in Zeffy, and no card says so');
});

test('B2c a donor-advised check the site saved, then typed by hand under the donor\'s own name (backdated), is flagged as a possible double', async () => {
  await CG.setMode(env(), 'on');
  world().reading = read({ payer: 'Fidelity Charitable' });
  await posted();
  assert.equal((await rowOf()).state, 'created');
  // Staff enter DAF checks under the advisor, as they always have, dated the day on the check
  world().payments.push(hand({ id: 'zp_advisor', created: dayS('2026-11-03'), campaign_id: 'form_home', buyer: { first_name: 'Dana', last_name: 'Lee', email: null } }));
  world().slack = [];
  for (let h = 1; h <= 3; h++) await run(NOW + h * 61 * MIN);
  assert.match(slackSaid(), /twice/, 'the same $10,000 is in Zeffy twice (Fidelity Charitable and Dana Lee), and nothing says so');
});

// ── 2b. The same late entry under another name, made while watching: turning On makes a second record ───────────
test('B2b a late hand entry under another name (made in Watch) is asked about before On makes a second record', async () => {
  await posted();                                      // Watch: deposited Nov 5, posted Nov 7 → would
  assert.equal((await rowOf()).state, 'would');
  // Dec 1 (26 days after the deposit), staff enter the Pine Foundation check under its trustee's name, not backdated
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-12-01'), campaign_id: 'form_grant', buyer: { first_name: 'Dana', last_name: 'Lee', email: null } }));
  await run(Date.parse('2026-12-01T18:00:00Z'));
  await CG.setMode(env(), 'on');
  for (let i = 0; i < 3; i++) await run(Date.parse('2026-12-02T16:00:00Z') + i * 10 * MIN);
  const r = await rowOf();
  assert.deepEqual({ posts: world().posts.length, state: r.state }, { posts: 0, state: 'person' }, `a second $10,000 record was made (row ${r.state})`);
});

// ── 3. A cash or in-kind hand entry is taken as this check's record ─────────────────────────────────────────────
test('B3 a company\'s in-kind gift of the same amount is never linked as its check', async () => {
  await CG.setMode(env(), 'on');
  world().txns[TX] = txn({ amount: 500 });
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
  world().reading = read({ payer: 'Brightline Plumbing LLC', amount: 500, memo: 'Donation' });
  // Ten days before the check, staff entered the plumber's donated labor: $500 in kind
  world().payments.push(hand({ id: 'zp_labor', amount: 50000, created: dayS('2026-10-26'), payment_method: { type: 'in_kind', brand: null, last4: null },
    buyer: { first_name: 'Brightline Plumbing', last_name: 'Brightline Plumbing', email: null, is_corporate: true, company_name: 'Brightline Plumbing' } }));
  await posted();
  const r = await rowOf();
  assert.notEqual(r.zeffy_id, 'zp_labor', 'the $500 check was matched to the in-kind entry, so the check itself is never recorded');
});

// ── 4. A blocked check is called "came back", and staff are told to cancel the record ───────────────────────────
test('B4 a check Mercury has only blocked (it may yet be released) never tells staff to cancel its Zeffy record', async () => {
  await CG.setMode(env(), 'on');
  await posted();
  assert.equal((await rowOf()).state, 'created');
  world().txns[TX] = { ...world().txns[TX], status: 'blocked' };
  world().slack = [];
  await run(NOW + 2 * DAY);                            // the daily look at a posted check
  const v = (await CG.checksView(env())).list.find((c) => c.id === TX);
  const said = slackSaid();
  assert.deepEqual({ page: /Cancel the record/i.test(v.why || ''), slack: /cancel it there/i.test(said) }, { page: false, slack: false },
    `blocked → "${v.why}" and Slack: "A check came back… cancel it there. Zeffy tells the donor"`);
});

// ── 5. Fifteen minutes of Mercury not answering sends a readable check to a person as "couldn't read" ──────────────
test('B5 Mercury down for three runs doesn\'t make a check "unreadable"', async () => {
  world().mercuryDown = true;
  for (let i = 0; i < 3; i++) await run(NOW + i * 6 * MIN).catch(() => null);
  world().mercuryDown = false;
  for (let i = 3; i < 6; i++) await run(NOW + i * 6 * MIN).catch(() => null);
  const r = await rowOf();
  // (read, and now decided while Mercury reviews it: 'would' in Watch)
  assert.deepEqual({ state: r.state === 'would' ? 'read' : r.state, reason: r.reason, readers: world().aiCalls }, { state: 'read', reason: null, readers: 2 },
    'the picture was never looked at, and a person is asked who wrote it');
});

// ── 6. An insurance agency's donation is left out as "insurance" even when the memo says Donation ─────────────────
test('B6 a local insurance agency\'s check marked "Donation" is a gift, not left out', async () => {
  await CG.setMode(env(), 'on');
  world().reading = read({ payer: 'Lee Insurance Agency', memo: 'Donation' });
  await posted();
  const r = await rowOf();
  assert.notEqual(r.state, 'left-out', `left out as ${r.reason}: a gift that says Donation, never recorded, and not in Needs you`);
});

// ── 7. Suspected: filed under a donor's contact with other names than the contact's, which Zeffy may copy onto it ──
test('B7 suspected: a person\'s save filed under a no-email contact carries the contact\'s own names, as the site\'s save does', async () => {
  await CG.setMode(env(), 'on');
  await noEmailGiver({ first_name: 'Pine Family', last_name: 'Foundation Inc' });
  await run();
  await toPerson();
  await CG.personCreate(env(), TX, { name: 'Pine Foundation', formId: 'form_home', now: NOW, fetchImpl: fakeFetch });
  const sent = world().posts[0];
  assert.match(sent.email || '', /@nomail\./, 'filed under the contact');
  assert.deepEqual({ first: sent.first_name, last: sent.last_name }, { first: 'Pine Family', last: 'Foundation Inc' },
    'filed by the contact\'s address with the typed names: decideCheck guards against Zeffy renaming the contact, personCreate does not');
});
test('B7b suspected: a learned donor with an email is filed by it under the names read off the check, not the contact\'s', async () => {
  await CG.setMode(env(), 'on');
  await noEmailGiver({ email: 'grants@pine.example.org', first_name: 'Pine Family', last_name: 'Foundation Inc' });
  await posted();
  const sent = world().posts[0];
  assert.equal(sent.email, 'grants@pine.example.org');
  assert.deepEqual({ first: sent.first_name, last: sent.last_name }, { first: 'Pine Family', last: 'Foundation Inc' },
    'if Zeffy\'s find-by-email takes the record\'s names, the donor\'s contact is renamed to how the check was read');
});

// ── 8. The hourly match failing every hour is visible for five minutes an hour, and nobody is told ─────────────────
test('B8 when the hourly match fails every hour, someone is told (or the error stays up)', async () => {
  // A check from June nobody answered (in Watch an unreadable one isn't in Needs you), so the hourly read reaches back to February
  await env().DB.prepare(`INSERT INTO check_gifts (id, cents, state, reason, status, deposited_at, posted_at, final) VALUES ('old', 25000, 'person', 'unreadable', 'sent', '2026-06-23T15:00:00Z', '2026-06-24T15:00:00Z', 0)`).run();
  // February to early July: ordinary online gifts, card, 3,001 of them (spring gala tickets and monthly donors)
  for (let i = 0; i < 3001; i++) world().payments.push(hand({ id: `online_${i}`, type: 'online', payment_method: { type: 'card' }, amount: 2500, created: dayS('2026-02-25') + i * 3600 }));
  let t = NOW;
  for (let i = 0; i < 3; i++, t += 6 * MIN) await CG.maybeRunChecks(env(), { now: t, fetchImpl: fakeFetch });
  post();
  for (let i = 0; i < 3; i++, t += 6 * MIN) await CG.maybeRunChecks(env(), { now: t, fetchImpl: fakeFetch });
  assert.equal((await rowOf()).state, 'would');
  // Staff enter it by hand, as Watch asks
  world().payments.push(hand({ campaign_id: 'form_grant' }));
  world().slack = [];
  for (let i = 0; i < 40; i++, t += 6 * MIN) await CG.maybeRunChecks(env(), { now: t, fetchImpl: fakeFetch });
  const st = await readState(env().DB, 'check-gifts');
  const r = await rowOf();
  assert.ok(r.state === 'linked' || st.lastError || world().slack.length,
    `four hours on, the hand entry isn't linked (row ${r.state}), the page shows no error (lastError ${JSON.stringify(st.lastError)}), and Slack heard nothing`);
});

// ── 9. Suspected: a check posted the morning it was deposited is sent to Zeffy dated later that day ────────────────
test('B9 suspected: the record is never dated in the future', async () => {
  await CG.setMode(env(), 'on');
  world().txns[TX] = txn({ createdAt: '2026-11-05T11:00:00Z' });          // 6 AM Eastern
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
  world().reading = read({ date: '2026-11-05' });
  await run(Date.parse('2026-11-05T11:30:00Z'));
  post(TX, '2026-11-05T14:00:00Z');
  // Nov 10: the site waits for 7 PM Eastern on the deposit day, so a letter attached that day is read first
  await run(Date.parse('2026-11-05T14:05:00Z'));
  assert.equal(world().posts.length, 0, 'nothing is saved the morning it was deposited');
  const at = Date.parse('2026-11-06T00:05:00Z');                               // 7:05 PM Eastern
  await run(at);
  const sent = world().posts[0];
  assert.ok(sent, 'saved');
  assert.ok(Date.parse(sent.payment_date) <= at, `payment_date ${sent.payment_date} is ${(Date.parse(sent.payment_date) - at) / 60000} minutes after the save`);
  // A record made in the morning (a person's save) is never dated in the future either
  const early = Date.parse('2026-11-05T14:05:00Z');
  const rec = CG.recordFor({ cents: 10000, deposited_at: '2026-11-05T11:00:00Z', check_date: '2026-11-05' }, { name: 'Pine Foundation', form: { id: 'form_home' }, now: early });
  assert.ok(Date.parse(rec.payment_date) <= early, `payment_date ${rec.payment_date} is after ${new Date(early).toISOString()}`);
});

// ── 10. On quietly goes back to Watch when a new write test fails, after staff were told to stop entering checks ───
test('B10 when a failed write test turns On back into Watch, someone is told', async () => {
  await CG.setMode(env(), 'on', { by: 'peter' });
  // A new write test (the id changed) and Zeffy refuses writes today
  await writeState(env().DB, 'check-gifts', { writeTest: { id: '2026-11-01', ok: true } });
  world().postFails = 'timeout';
  await run();
  assert.equal((await CG.checksView(env())).mode, 'watch');
  world().postFails = null;
  world().slack = [];
  // The checks keep coming; staff aren't entering them any more
  await run(NOW + 10 * MIN);
  post();
  for (let h = 1; h <= 24; h++) await run(NOW + h * 61 * MIN);
  const r = await rowOf();
  assert.ok(world().slack.length > 0, `a day later the check is "${r.state}", nobody entered it, the switch reads Watch, and Slack heard nothing`);
});

// ── 11. One club's name inside another's: the check links to the other club's entry, and its next check lands on that club ─
test('B11 the Lakeview Rotary Club\'s check never links to the North Lakeview Rotary Club\'s entry, nor files its next gift there', async () => {
  world().contacts.c_north = { id: 'c_north', email: 'treasurer@northlakeview.example.org', first_name: 'North Lakeview Rotary Club', last_name: 'North Lakeview Rotary Club', donation_count: 4 };
  world().txns[TX] = txn({ amount: 1000 });
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
  world().reading = read({ payer: 'Lakeview Rotary Club', amount: 1000 });
  // A week before, staff entered the other club's $1,000 check
  world().payments.push(hand({ id: 'zp_north', amount: 100000, created: dayS('2026-10-28'), contact: 'c_north',
    buyer: { first_name: 'North Lakeview Rotary Club', last_name: 'North Lakeview Rotary Club', email: 'treasurer@northlakeview.example.org' } }));
  await posted();
  const linkedTo = (await rowOf()).zeffy_id;
  // And so the next check from the Atlanta club goes onto the North Atlanta club's contact, by its treasurer's email
  await CG.setMode(env(), 'on');
  world().txns.tx_2 = txn({ id: 'tx_2', amount: 500, checkNumber: '2001', createdAt: '2026-12-01T15:00:00Z', status: 'sent', postedAt: '2026-12-02T15:00:00Z' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: NOW });
  world().reading = read({ payer: 'Lakeview Rotary Club', amount: 500, checkNumber: '2001', date: '2026-11-28' });
  for (let i = 0; i < 3; i++) await run(Date.parse('2026-12-03T16:00:00Z') + i * 10 * MIN);
  assert.deepEqual({ firstCheckLinkedTo: linkedTo, nextGiftFiledBy: world().posts.at(-1)?.email || null }, { firstCheckLinkedTo: null, nextGiftFiledBy: null },
    'the first check took the other club\'s entry, and the next one went in under the other club\'s treasurer\'s email');
});

// ── 12. Two staff on one check at once: one links the hand entry, the other saves; both are told it worked ────────
test('B12 a link and a save on the same check at the same moment: the first wins and the other is told', async () => {
  await CG.setMode(env(), 'on');
  await run();
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'maybe-double', status = 'sent', note = ? WHERE id = ?`)
    .bind(JSON.stringify([{ id: 'zp_dana', name: 'Dana Lee', cents: 1000000, at: dayS('2026-11-04'), form: '' }]), TX).run();
  world().payments.push(hand({ id: 'zp_dana', buyer: { first_name: 'Dana', last_name: 'Lee', email: null } }));
  // Holly presses "This is the check"; Zeffy is slow to hand back that entry. Meanwhile Peter presses Save with "not those"
  let release;
  const held = new Promise((r) => { release = r; });
  let holly = null;
  world().hook = async ({ method, path }) => {
    if (method === 'GET' && path === '/payments/zp_dana') await held;           // Holly's read of the entry, slow
    if (method === 'POST' && path === '/payments') { release(); await holly; }  // Peter's record on its way; Holly's answer lands
  };
  holly = CG.personLink(env(), TX, 'zp_dana', { saw: 'person', by: 'holly', now: NOW, fetchImpl: fakeFetch }).then((r) => r.result, (e) => e.message);
  await new Promise((r) => setTimeout(r, 5));
  const peter = await CG.personCreate(env(), TX, { name: 'Pine Foundation', formId: 'form_grant', notThose: true, shown: ['zp_dana'], saw: 'person', by: 'peter', now: NOW, fetchImpl: fakeFetch }).then((r) => r.result, (e) => e.message);
  assert.equal(peter, 'created');
  assert.match(await holly, /Someone else just saved or matched this check/);
  // Peter said Dana's entry is another gift, and that answer stands: it's never raised against this check again
  world().slack = [];
  await run(NOW + 2 * 61 * MIN);
  assert.equal(world().slack.some((b) => /may be in Zeffy twice/.test(b)), false);
});

// ── 13. A business check with its phone number by the name is "unreadable" ─────────────────────────────────────
test('B13 a payer read with the phone number printed beside it keeps the name, rather than the check going to a person', () => {
  const r = read({ payer: 'Brightline Plumbing LLC (404) 555-0188' });
  const out = CG.proveRead([r, r], { cents: 1000000, checkNumber: '1042' });
  assert.equal(out.ok, true, `both readers agree; the phone number makes the name blank (${out.why})`);
});

// ── 14. Accented capitals come out with a capital in the middle of the name, on the donor's Zeffy record ──────────
test('B14 JOSÉ GARCÍA goes into Zeffy as José García', () => {
  const p = (payer) => CG.proveRead([read({ payer }), read({ payer })], { cents: 1000000, checkNumber: '1042' }).payer;
  assert.deepEqual([p('JOSÉ GARCÍA'), p('BJÖRK ÅSTRÖM')], ['José García', 'Björk Åström']);
});

// ── 15. The giver's own check promise in Zeffy is passed over when the check is for another amount ───────────────
test('B15 a giver\'s unpaid pay-by-check promise for a different amount is asked about, not saved past', async () => {
  await CG.setMode(env(), 'on');
  world().txns[TX] = txn({ amount: 550 });
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
  world().reading = read({ amount: 550 });
  // Pine Foundation promised $500 by check on the form a week before; the check came for $550
  world().payments.push(hand({ id: 'zp_promise', type: 'online', status: 'pending', amount: 50000, created: dayS('2026-10-27') }));
  await posted();
  const r = await rowOf();
  assert.deepEqual({ posts: world().posts.length, state: r.state }, { posts: 0, state: 'person' },
    'saved a $550 record while the giver\'s $500 promise stays open; once staff mark the promise paid, Zeffy counts $1,050');
});
test('B15b a giver\'s promise from five months ago is still seen before the site saves their check', async () => {
  await CG.setMode(env(), 'on');
  // An annual pledge made in May, paid by this check in November
  world().payments.push(hand({ id: 'zp_pledge', type: 'online', status: 'pending', created: dayS('2026-05-20') }));
  await posted();
  const r = await rowOf();
  assert.deepEqual({ posts: world().posts.length, state: r.state, reason: r.reason }, { posts: 0, state: 'person', reason: 'pledge' });
});

// ── 16. Zeffy's rate limit on the address step files the gift under a brand-new contact, and the giver is re-learned as it ─
test('B16 a rate-limited address step waits, instead of filing the gift under a new contact and forgetting the giver\'s own', async () => {
  await CG.setMode(env(), 'on');
  await noEmailGiver();
  // The run has read a lot of Zeffy pages; Zeffy answers the PATCH with 429 (100 requests a minute)
  world().fail = ({ method, body }) => (method === 'PATCH' && body?.email ? 429 : null);
  await posted();
  world().fail = null;
  const learned = await env().DB.prepare('SELECT contact_id FROM check_payers WHERE key = ?').bind('pine foundation').first();
  const gift = world().payments.at(-1);
  assert.deepEqual({ giftOn: gift?.contact || null, learned: learned.contact_id }, { giftOn: gift ? 'c_pine' : null, learned: 'c_pine' },
    'the gift went onto a new contact, and every later check from this giver follows it there');
});

// ── 17. Suspected: an empty entry id from the page links the check to "undefined" ──────────────────────────────
test('B17 suspected: linking with an empty Zeffy id is refused, never stored as the record "undefined"', async () => {
  await run();
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'maybe-double', status = 'sent' WHERE id = ?`).bind(TX).run();
  // Zeffy's API, like most, answers /payments/ (trailing slash) with the list
  const f = async (u, init) => (String(u).endsWith('/payments/') ? new Response(JSON.stringify({ object: 'list', data: [], has_more: false, next_cursor: null }), { status: 200 }) : fakeFetch(u, init));
  const out = await CG.personLink(env(), TX, '', { now: NOW, fetchImpl: f }).then((r) => r.result, (e) => e.message);
  const r = await rowOf();
  assert.notEqual(r.zeffy_id, 'undefined', `answered "${out}", and the row is ${r.state} to Zeffy record "${r.zeffy_id}"`);
});

// ── 5b. The same for Workers AI being down: neither reader answered, and that's taken as "couldn't read it" ─────────
test('B5b fifteen minutes of Workers AI errors don\'t make a check "unreadable"', async () => {
  const ok = env().AI.run;
  env().AI.run = async () => { throw Object.assign(new Error('InferenceUpstreamError: 503 Service Unavailable'), { status: 503 }); };
  for (let i = 0; i < 3; i++) await run(NOW + i * 6 * MIN).catch(() => null);
  env().AI.run = ok;
  for (let i = 3; i < 6; i++) await run(NOW + i * 6 * MIN).catch(() => null);
  const r = await rowOf();
  assert.deepEqual({ state: r.state === 'would' ? 'read' : r.state, reason: r.reason }, { state: 'read', reason: null }, 'both readers errored three runs running, and a person is asked who wrote it');
});

// ── 18. Suspected: the write test never sends a payment_date, so On is the first time backdating is tried ─────────
test('B18 suspected: the write test proves Zeffy keeps the date the site sends', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: null });
  await run();
  assert.ok(world().posts.some((p) => p.payment_date), 'every check record carries payment_date (a December check deposited in January stays in December), and no test record ever did');
});
test('B16b a donor with an email: one failed read of their contact files the gift elsewhere and forgets their contact for good', async () => {
  await CG.setMode(env(), 'on');
  await noEmailGiver({ email: 'grants@pine.example.org' });
  world().fail = ({ method, path }) => (method === 'GET' && path === '/contacts/c_pine' ? 429 : null);
  await posted();
  assert.equal(world().posts.length, 0, 'nothing is saved while Zeffy can\'t say who the giver is');
  world().fail = null;
  await run(NOW + 30 * MIN);
  const learned = await env().DB.prepare('SELECT contact_id FROM check_payers WHERE key = ?').bind('pine foundation').first();
  assert.deepEqual({ filedBy: world().posts[0]?.email || null, learned: learned.contact_id }, { filedBy: 'grants@pine.example.org', learned: 'c_pine' },
    'the gift went in with no email on a new contact, and the giver is now learned as that contact, so their email is never used again');
});

// ── 19. The write test can leave test contacts in Zeffy's CRM that nothing ever mentions ───────────────────────
test('B19 the write test leaves no test contact behind when making its contact times out after Zeffy made it', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: null });
  world().fail = ({ method, path }) => (method === 'POST' && path === '/contacts' ? 'timeout-after' : null);
  const r = (await run()).writeTest;
  world().fail = null;
  assert.equal(r.removed, true, 'it reports everything removed');
  assert.deepEqual(Object.values(world().contacts).map((c) => `${c.first_name} ${c.last_name}`), [], 'a "SOARD WebsiteTest" contact stays in Zeffy');
});
test('B19b once a person removes the $1 records Zeffy wouldn\'t let the site delete, no test contacts are left either', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: null });
  world().fail = ({ method, path }) => (method === 'DELETE' && path.startsWith('/payments/') ? 403 : null);
  await run();
  world().fail = null;
  // a person deleted the five $1 records in Zeffy, as asked, and Zeffy's counts went down with them
  world().payments = [];
  for (const c of Object.values(world().contacts)) c.donation_count = 0;
  await run(NOW + 2 * 61 * MIN);
  assert.deepEqual((await readState(env().DB, 'check-gifts')).writeTest.leftBehind, [], 'the page stops asking');
  assert.deepEqual(Object.values(world().contacts).map((c) => c.email || `${c.first_name} ${c.last_name}`), [], 'test contacts stay in the CRM, and nobody is asked to remove them');
});

// ── 20. A monthly giver's two late hand entries: the newest check takes one of them, and both older checks go to a person ─
test('B20 two months of a $500-a-month giver typed in on one day go to July and August, not to September\'s check', async () => {
  await env().DB.prepare('DELETE FROM check_gifts').run();
  for (const [id, m] of [['jul', '07'], ['aug', '08'], ['sep', '09']]) {
    await env().DB.prepare(`INSERT INTO check_gifts (id, cents, state, status, payer, check_date, deposited_at, posted_at, final, created_at, updated_at) VALUES (?, 50000, 'would', 'sent', 'Oak Family Trust', ?, ?, ?, 0, 'x', 'x')`)
      .bind(id, `2026-${m}-01`, `2026-${m}-05T15:00:00Z`, `2026-${m}-07T15:00:00Z`).run();
  }
  // Sep 10: staff catch up July and August, not backdated (September's check isn't entered yet)
  for (const id of ['zp_jul', 'zp_aug']) world().payments.push(hand({ id, amount: 50000, created: dayS('2026-09-10'), buyer: { first_name: 'Oak Family Trust', last_name: 'Oak Family Trust', email: null } }));
  await env().DB.prepare("UPDATE mercury_txns SET kind = 'x'").run();      // only these three checks
  await run(Date.parse('2026-09-10T18:00:00Z'));
  const got = Object.fromEntries((await env().DB.prepare('SELECT id, state, zeffy_id, reason FROM check_gifts').all()).results.map((r) => [r.id, `${r.state}${r.zeffy_id ? ` ${r.zeffy_id}` : ''}${r.reason ? ` (${r.reason})` : ''}`]));
  assert.equal(/zp_/.test(got.sep), false, `September's check took a July/August entry: ${JSON.stringify(got)}`);
});

// ── 21. A database fault in a run reaches Site → Automations in the database's own words ──────────────────────
test('B21 a run that fails on a database fault says so in plain words on the Automations map', async () => {
  const DB = env().DB;
  const faulty = { ...DB, prepare: (sql) => { if (/final = 0 AND \(status != 'sent'/.test(sql)) throw new Error('D1_ERROR: database disk image is malformed: SQLITE_CORRUPT'); return DB.prepare(sql); } };
  await CG.maybeRunChecks({ ...env(), DB: faulty }, { now: NOW, fetchImpl: fakeFetch });
  const facts = await CG.checksFacts(DB);
  assert.equal(/D1_ERROR|SQLITE/.test(facts.error || ''), false, `the map says: "The last run didn't finish: ${facts.error}."`);
});

// ── Held up in the same round ────────────────────────────────────────────────

const writes = () => world().log.filter((l) => !l.startsWith('GET'));

test('Watch: weeks of reads, decisions, hand entries under other names, a returned check and a blocked one write nothing to Zeffy', async () => {
  await noEmailGiver();
  world().txns.tx_2 = txn({ id: 'tx_2', amount: 500, checkNumber: '7', createdAt: '2026-11-05T16:00:00Z' });
  world().txns.tx_3 = txn({ id: 'tx_3', amount: 750, checkNumber: '8', createdAt: '2026-11-05T17:00:00Z' });
  for (const id of ['tx_2', 'tx_3']) await mirrorTransaction(env().DB, world().txns[id], { now: NOW });
  for (let i = 0; i < 6; i++) await run(NOW + i * 6 * MIN);
  for (const id of [TX, 'tx_2', 'tx_3']) post(id);
  world().payments.push(hand({ id: 'zp_other', buyer: { first_name: 'Oak', last_name: 'Trust' } }));
  for (let h = 1; h <= 30; h++) await run(NOW + h * 61 * MIN);
  world().txns.tx_2 = { ...world().txns.tx_2, status: 'reversed' };
  world().txns.tx_3 = { ...world().txns.tx_3, status: 'blocked' };
  for (let d = 2; d <= 5; d++) await run(NOW + d * DAY);
  assert.deepEqual(writes(), []);
});

test('the write test, against a Zeffy that files by email and counts gifts per contact, leaves no payment, contact or address behind', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: null });
  const r = (await run()).writeTest;
  assert.equal(r.ok, true);
  assert.equal(r.join.ok, true);
  assert.deepEqual({ payments: world().payments, contacts: world().contacts, tags: (await env().DB.prepare('SELECT COUNT(*) AS n FROM check_tags').first()).n }, { payments: [], contacts: {}, tags: 0 });
});

for (const [name, fail] of [
  ['the address step applied but timed out', ({ method, body }) => (method === 'PATCH' && body?.email ? 'timeout-after' : null)],
  ['the joined record saved but timed out', ({ method, path, body }) => (method === 'POST' && path === '/payments' && /@nomail/.test(body?.email || '') ? 'timeout-after' : null)],
  ['the email record saved but timed out', ({ method, path, body }) => (method === 'POST' && path === '/payments' && /write-test/.test(body?.email || '') ? 'timeout-after' : null)],
  ['taking the address off refused', ({ method, body }) => (method === 'PATCH' && body?.email === null ? 422 : null)],
]) {
  test(`the write test still removes every payment when ${name}`, async () => {
    await writeState(env().DB, 'check-gifts', { writeTest: null });
    world().fail = fail;
    await run();
    world().fail = null;
    for (let h = 1; h <= 2; h++) await run(NOW + h * 61 * MIN);
    assert.deepEqual({ payments: world().payments.map((p) => p.id), tagged: tagged().map((c) => c.id) }, { payments: [], tagged: [] });
  });
}

test('one run at a time: the no-email giver\'s gift lands on their contact and the contact ends with no email, through every single-step failure', async () => {
  for (const fail of [
    null,
    ({ method, body }) => (method === 'PATCH' && body?.email ? 'timeout-after' : null),
    ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null),
    ({ method, body }) => (method === 'PATCH' && body?.email === null ? 'timeout' : null),
  ]) {
    await setup();
    await CG.setMode(env(), 'on');
    await noEmailGiver();
    world().fail = fail;
    await posted();
    world().fail = null;
    for (let i = 1; i <= 8; i++) await run(NOW + i * 6 * MIN);
    assert.equal(world().contacts.c_pine.email, null);
    assert.deepEqual(tagged(), []);
    assert.equal(world().posts.length, 1, 'one POST');
  }
});

test('Needs you on the page and the Checks tab\'s count agree across random states, reasons, notes and claims (60 boards)', async () => {
  const states = ['new', 'read', 'would', 'person', 'linked', 'created', 'left-out', 'store', 'came-back', 'creating', 'unsure'];
  const reasons = [null, 'unreadable', 'maybe-double', 'pledge', 'amount-off', 'still-unpaid', 'unsure', 'record-gone', 'event', 'back', 'person', 'told-gift', 'unlinked'];
  for (let trial = 0; trial < 60; trial++) {
    await setup();
    await env().DB.prepare('DELETE FROM check_gifts').run();
    if (trial % 2) await CG.setMode(env(), 'on');
    let seed = trial * 7919 + 1;
    const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
    for (let i = 0; i < 40; i++) {
      const listed = rnd(3) === 0 ? JSON.stringify([{ id: rnd(2) ? `z${rnd(40)}` : 'zfree', name: 'X', cents: 1, at: 1, form: '' }]) : (rnd(4) === 0 ? 'words' : null);
      await env().DB.prepare(`INSERT INTO check_gifts (id, cents, state, reason, note, zeffy_id, status, deposited_at, posted_at) VALUES (?, 100, ?, ?, ?, ?, 'sent', ?, ?)`)
        .bind(`r${i}`, states[rnd(states.length)], reasons[rnd(reasons.length)], listed, rnd(3) === 0 ? `z${i}` : null, new Date(NOW - rnd(200) * DAY).toISOString(), new Date(NOW - rnd(100) * DAY).toISOString()).run().catch(() => null);
    }
    assert.equal((await CG.checksView(env())).waiting, (await CG.checksFacts(env().DB)).waiting, `board ${trial}`);
  }
});

test('the admin API: a stale screen, a replayed save and a database fault each answer in plain words and write nothing more', async () => {
  await CG.setMode(env(), 'on');
  await run();
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'unreadable', status = 'sent', payer = NULL WHERE id = ?`).bind(TX).run();
  const call = (body, e = env()) => admin.onRequestPost({ env: e, request: new Request('https://x/api/checks-admin', { method: 'POST', body: JSON.stringify(body) }), data: { userEmail: 'holly@soardcharity.com' } }).then((r) => r.json().then((j) => ({ status: r.status, ...j })));
  const first = await call({ action: 'create', id: TX, name: 'Pine Foundation', formId: 'form_home', saw: 'person' });
  assert.equal(first.success, true);
  // The same person's save sent again (a browser resends a lost answer): it already went through, and nothing more is written
  const again = await call({ action: 'create', id: TX, name: 'Pine Foundation', formId: 'form_home', saw: 'person' });
  assert.deepEqual({ ok: again.success, again: again.result?.again, posts: world().posts.length }, { ok: true, again: true, posts: 1 });
  const stale = await call({ action: 'not-gift', id: TX, saw: 'person' });
  assert.equal(stale.status, 409);
  const broken = { ...env(), DB: { prepare: () => { throw new Error('D1_ERROR: no such table: check_gifts: SQLITE_ERROR'); } } };
  const fault = await call({ action: 'not-gift', id: TX }, broken);
  assert.equal(/D1_ERROR|SQLITE/.test(fault.error), false);
});

test('a returned check (Mercury links the return) and a cashier\'s check (the bank is never the giver) are handled', async () => {
  await CG.setMode(env(), 'on');
  world().reading = read({ payer: 'Truist Bank', cashiersCheck: true, remitter: '' });
  await posted();
  for (let i = 2; i <= 5; i++) await run(NOW + i * 6 * MIN);
  const c = await rowOf();
  assert.deepEqual({ state: c.state, payer: c.payer, posts: world().posts.length }, { state: 'person', payer: null, posts: 0 });
  await setup();
  await CG.setMode(env(), 'on');
  await posted();
  world().txns[TX] = { ...world().txns[TX], relatedTransactions: [{ id: 'tx_ret', relationKind: 'OriginalTransactionToReturn' }] };
  await run(NOW + 2 * DAY);
  assert.equal((await rowOf()).state, 'came-back');
});
