/**
 * An eighth break-it round on Nov 9 2026: the site's own record of Zeffy payments, the weekly money check, checks deposited
 * twice, a check paying several gifts. Fake Zeffy: tests/lib/check-gifts-harness-2.mjs. Each test failed before its fix.
 * Two findings are left as they are and not here: a company typed with its contact person isn't learned (a duplicate
 * contact, never a wrong gift), and a pledge older than 400 days marked paid isn't seen (the money check names that double).
 * Names are made up. Run: node --test tests/check-gifts-edges-7.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, run, rowOf, post, posted, fakeFetch, hand, read, txn, mirrorTransaction, readState, writeState, slackSaid, NOW, MIN, DAY, dayS, TX } = await import('./lib/check-gifts-harness-2.mjs');
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
/** Replace the harness's one deposit with this one */
async function depositIs(o, reading = {}) {
  world().txns[TX] = txn(o);
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
  world().reading = read({ amount: o.amount ?? 10000, ...reading });
}
const addCheck = async (id, o = {}) => {
  world().txns[id] = txn({ id, ...o });
  await mirrorTransaction(env().DB, world().txns[id], { now: NOW });
};
/** Runs every 5 minutes from `from` to `to` (ISO) */
async function runEvery(fromIso, toIso, stepMin = 5) {
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += stepMin * MIN) await run(t);
}

// ── M1. moneyDue compares the UTC date of the last run with today's UTC date, but "Monday" is Eastern. From 7 PM Eastern
//        (8 PM in summer) Monday is already Tuesday in UTC, so the money check runs a second time that evening and posts a
//        second Slack card under a new key (checks:money:<Tuesday>) ──────────────────────────────────────────────────────────
test('M1 the weekly money check posts once a Monday, not again Monday evening', async () => {
  world().payments.push(hand({ id: 'zp_loose', amount: 75000, created: dayS('2026-11-10'), buyer: person('Dana', 'Whitfield') }));
  await run(Date.parse('2026-11-16T14:30:00Z'));                 // Mon 9:30 AM EST
  const first = (await readState(env().DB, 'check-gifts')).money?.at;
  for (const at of ['2026-11-16T20:00:00Z', '2026-11-17T00:30:00Z', '2026-11-17T03:30:00Z']) await run(Date.parse(at)); // 3 PM, 7:30 PM, 10:30 PM EST Monday
  const last = (await readState(env().DB, 'check-gifts')).money?.at;
  assert.deepEqual({ cards: moneyCards().length, runs: first === last ? 1 : 2 }, { cards: 1, runs: 1 },
    `Monday Nov 16 had ${moneyCards().length} money-check cards in Slack; first run ${first}, last ${last}`);
});

// ── M2. A Mercury check still pending on Monday morning: its row is "read", not in the hourly look's list, so the hand
//        entry staff typed for it (as Watch asks) is never linked, and the money check names it "no check in Mercury" ────
test('M2 a check typed by hand Friday whose Mercury deposit is still pending Monday is not named by the money check', async () => {
  await depositIs({ createdAt: '2026-11-13T19:00:00Z', status: 'pending' });
  world().payments.push(hand({ id: 'zp_fri', created: dayS('2026-11-13') }));   // Pine Foundation, $10,000, typed Friday
  await runEvery('2026-11-13T19:30:00Z', '2026-11-13T21:00:00Z');                 // read Friday
  await run(Date.parse('2026-11-14T15:00:00Z'));
  await run(Date.parse('2026-11-15T15:00:00Z'));
  await run(Date.parse('2026-11-16T14:30:00Z'));                                  // Mon 9:30 AM EST, still pending in Mercury
  const m = (await readState(env().DB, 'check-gifts')).money;
  const r = await rowOf();
  assert.deepEqual(m.loose.map((x) => x.id), [], `the money check named ${m.loose.map((x) => `${x.name} ${x.cents / 100}`).join(', ')} while its Mercury check ${r.id} is "${r.state}" / ${r.status}; Slack: ${moneyCards().length} card(s)`);
});

// ── M3. One check, several Zeffy entries (United Way's designations, a table plus a gift): the site asks (netOf's parts),
//        a person matches it to one entry (all the page allows), and the others are named every Monday for 45 days as
//        check gifts with no check in Mercury, with "delete the extra one" as the fix ──────────────────────────────────────
test('M3 a United Way check matched to one of its three designations is not named by the money check each Monday', async () => {
  await CG.setMode(env(), 'on');
  await depositIs({ amount: 1250, createdAt: '2026-11-10T15:00:00Z', status: 'pending' }, { payer: 'United Way of Lakeview', memo: 'Designations Q3', date: '2026-11-08' });
  for (const [id, cents, first, last] of [['zp_uw1', 50000, 'Lee', 'Park'], ['zp_uw2', 50000, 'Ana', 'Ruiz'], ['zp_uw3', 25000, 'Sam', 'Ortiz']]) {
    world().payments.push(hand({ id, amount: cents, created: dayS('2026-11-10'), buyer: person(first, last) }));
  }
  await runEvery('2026-11-10T15:30:00Z', '2026-11-10T16:00:00Z');
  world().txns[TX] = { ...world().txns[TX], status: 'sent', postedAt: '2026-11-11T15:00:00Z' };
  await runEvery('2026-11-11T16:00:00Z', '2026-11-11T16:30:00Z');
  const asked = await rowOf();
  assert.equal(asked.state, 'person', 'the site asks first (H4)');
  await CG.personLink(env(), TX, 'zp_uw1', { saw: 'person', by: 'staff@soard.test', now: Date.parse('2026-11-12T15:00:00Z'), fetchImpl: fakeFetch });
  await run(Date.parse('2026-11-16T14:30:00Z'));
  await run(Date.parse('2026-11-23T14:30:00Z'));
  const m = (await readState(env().DB, 'check-gifts')).money;
  assert.deepEqual({ named: m.loose.map((x) => x.id), cards: moneyCards().length }, { named: [], cards: 0 },
    `after the person matched the check, the money check names ${m.loose.map((x) => `${x.name} $${x.cents / 100}`).join(', ')}; ${moneyCards().length} Slack cards over two Mondays telling staff to delete "the extra one"`);
});
// ── N1. "Since On, any hand-typed check entry counts, whatever its amount." A sponsor's golf check, split by staff into a
//        table and a sponsorship (Zeffy takes events only by hand, REASONS.event), is never linked to its check, so from the
//        moment it's typed every check written before it and decided after goes to a person, Slack and all, with the
//        sponsor's entries (another name, another amount) as the "maybe double" ───────────────────────────────────────────
test('N1 a sponsor\'s split golf entries typed after On never send an unrelated $10,000 foundation check to a person', async () => {
  await CG.setMode(env(), 'on', { now: Date.parse('2026-11-01T12:00:00Z') });
  await run(Date.parse('2026-11-02T12:00:00Z'));    // the first fill, before the golf entries exist
  world().payments.push(
    hand({ id: 'zp_golf_table', amount: 200000, created: dayS('2026-11-06'), description: 'Golf Classic 2026', campaign_id: 'golf', buyer: person('Acme', 'Builders') }),
    hand({ id: 'zp_golf_spons', amount: 100000, created: dayS('2026-11-06'), description: 'Golf Classic 2026', campaign_id: 'golf', buyer: person('Acme', 'Builders') }),
  );
  await run(Date.parse('2026-11-06T18:00:00Z'));    // the hourly look sees them
  await posted();                                    // Pine Foundation $10,000, dated Nov 3, posted Nov 7, decided Nov 10
  const r = await rowOf();
  assert.deepEqual({ state: r.state, posts: sitePosts().length }, { state: 'created', posts: 1 },
    `Pine's $10,000 check is "${r.state}" (${r.reason}) asking about ${r.note}; Slack: ${/needs a look/.test(slackSaid()) ? 'told' : 'quiet'}`);
});

// ── N2. Same rule, the site's own $1 test records. A new WRITE_TEST while On runs the test again; when Zeffy won't let
//        the site delete them (anticipated: "asks a person to take the $1 records out by hand"), they're hand-typed check
//        entries first seen since On, and every check in flight goes to a person over a "$1 SOARD WebsiteTest" entry.
//        netOf doesn't leave out test records (moneyCheck does) ──────────────────────────────────────────────────────────
test('N2 the write test\'s $1 records left in Zeffy never send a real check to a person', async () => {
  await CG.setMode(env(), 'on', { now: Date.parse('2026-11-01T12:00:00Z') });
  await run(Date.parse('2026-11-02T12:00:00Z'));
  // A later deploy changes WRITE_TEST: the test runs again while On, and Zeffy refuses the DELETEs
  const st = await readState(env().DB, 'check-gifts');
  await writeState(env().DB, 'check-gifts', { writeTest: { ...st.writeTest, id: '2026-11-01' } });
  world().fail = ({ method, path }) => (method === 'DELETE' && path.startsWith('/payments/') ? 403 : null);
  const report = await run(NOW - 60 * MIN);         // Nov 10, 3 PM UTC (the fake dates an undated POST at NOW)
  world().fail = null;
  assert.ok(report.writeTest?.ok && report.writeTest.leftBehind.length, 'the test passed and left its $1 records');
  await run(NOW - 55 * MIN);                         // the hourly look sees them
  await posted();
  const r = await rowOf();
  assert.deepEqual({ state: r.state, posts: sitePosts().length }, { state: 'created', posts: 1 },
    `Pine's $10,000 check is "${r.state}" (${r.reason}), asked about ${r.note}`);
});
// ── P2. H8's pledge (older than 400 days, still open) sends the check to a person; the hourly look reads only 400 days,
//        so the entry it asked about isn't "standing", and the check is sent back to "read" every hour. With an older
//        check ahead in line it sits out of Needs you, and Save refuses it (H7's symptom, for H8's case) ─────────────────
test('P2 minor: a check asked about a 14-month-old open pledge stays with the person through the hourly look', async () => {
  await CG.setMode(env(), 'on');
  world().payments.push(hand({ id: 'zp_old_promise', type: 'online', status: 'pending', created: dayS('2025-09-15'), contact: 'c_pine',
    buyer: { first_name: 'Pine', last_name: 'Foundation', email: 'grants@pine.example.org', is_corporate: false, company_name: null } }));
  await posted();
  const asked = await rowOf();
  assert.equal(asked.state, 'person');
  // Another check, deposited the day before, posts as the hourly look runs: it takes that run's one decision
  await env().DB.prepare(`INSERT INTO check_gifts (id, account_id, status, cents, deposited_at, posted_at, check_number, state, payer, check_date, created_at, updated_at)
    VALUES ('tx_b', 'acct_check', 'sent', 250000, '2026-11-04T15:00:00Z', '2026-11-10T16:30:00Z', '77', 'read', 'Oak Hollow Garden Club', '2026-11-02', 'x', 'x')`).run();
  world().txns.tx_b = txn({ id: 'tx_b', amount: 2500, checkNumber: '77', createdAt: '2026-11-04T15:00:00Z', status: 'sent', postedAt: '2026-11-10T16:30:00Z' });
  const t = NOW + 62 * MIN;
  await run(t);
  const r = await rowOf();
  let save = 'saved';
  try { await CG.personCreate(env(), TX, { name: 'Pine Foundation', formId: 'form_home', notThose: true, shown: ['zp_old_promise'], saw: 'person', by: 'staff@soard.test', now: t + MIN, fetchImpl: fakeFetch }); } catch (e) { save = `${e.status}: ${e.message}`; }
  assert.deepEqual({ state: r.state }, { state: 'person' }, `right after the hourly look the check is "${r.state}"; the person's Save: ${save}`);
});

// ── G1. Suspected (needs an import to happen): payments Zeffy imports in bulk (type "imported", which madeByHand counts,
//        and which the gift alert already expects: "a bulk import would flood the channel") are all first seen at once, so
//        every one is "typed since" for every check in flight. Here: last year's 40 offline check gifts from a spreadsheet,
//        imported Nov 9. The site's saved checks of the last weeks get "may be in Zeffy twice" in Slack, and the next
//        check goes to a person over strangers' 2025 gifts ─────────────────────────────────────────────────────────────────
test('G1 suspected: importing last year\'s offline check gifts never makes the site\'s saved checks look doubled', async () => {
  await CG.setMode(env(), 'on', { now: Date.parse('2026-10-01T12:00:00Z') });
  // Three checks the site saved in October (rows with their records), and the first fill
  const saved = [['tx_a', 50000, 'Lee Park', '2026-10-12'], ['tx_b', 100000, 'Ana Ruiz', '2026-10-20'], ['tx_c', 25000, 'Sam Ortiz', '2026-10-27']];
  for (const [id, cents, name, day] of saved) {
    const [first, last] = name.split(' ');
    world().payments.push(hand({ id: `zp_${id}`, amount: cents, created: dayS(day), buyer: person(first, last) }));
    world().txns[id] = txn({ id, amount: cents / 100, checkNumber: '1', createdAt: `${day}T15:00:00Z`, status: 'sent', postedAt: `${day}T18:00:00Z` });
    await env().DB.prepare(`INSERT INTO check_gifts (id, account_id, status, cents, deposited_at, posted_at, check_number, state, payer, check_date, zeffy_id, via, created_at, updated_at)
      VALUES (?, 'acct_check', 'sent', ?, ?, ?, '1', 'created', ?, ?, ?, 'site', 'x', 'x')`).bind(id, cents, `${day}T15:00:00Z`, `${day}T18:00:00Z`, name, day, `zp_${id}`).run();
  }
  await run(Date.parse('2026-11-02T12:00:00Z'));
  // Nov 9: 40 offline check gifts from Nov 2025 to Oct 2026 imported from a spreadsheet, the usual amounts
  const amounts = [10000, 25000, 50000, 100000, 25000, 50000, 10000, 250000];
  for (let i = 0; i < 40; i++) {
    world().payments.push(hand({ id: `zp_imp_${i}`, type: 'imported', amount: amounts[i % amounts.length], created: dayS('2025-11-15') + i * 8 * 86400, buyer: person('Donor', `Number${i}`) }));
  }
  await run(Date.parse('2026-11-09T16:00:00Z'));
  await run(Date.parse('2026-11-09T17:05:00Z'));
  const doubles = world().slack.filter((b) => /twice/.test(b)).length;
  await posted();
  const r = await rowOf();
  assert.deepEqual({ doubles, state: r.state }, { doubles: 0, state: 'created' },
    `${doubles} "may be in Zeffy twice" cards for the site's October checks; Pine's new check is "${r.state}" (${r.reason}) over ${(JSON.parse(r.note || '[]') || []).length} entries`);
});

// ── J1. netOf's "entries that add up to the check": any 2 to 4 unclaimed paid hand or check entries since the check was
//        written. Until about January, that pool holds every check typed by hand before Nov 6 (deposited at the old bank, so
//        no Mercury check will ever claim them). Two strangers' $500 checks from late October make a foundation's $1,000
//        check "maybe a double" ──────────────────────────────────────────────────────────────────────────────────────────
test('J1 two strangers\' $500 checks typed before Nov 6 never make a $1,000 foundation check look like their sum', async () => {
  await CG.setMode(env(), 'on');
  await depositIs({ amount: 1000, createdAt: '2026-11-05T15:00:00Z', status: 'pending' }, { payer: 'Pine Foundation', date: '2026-11-03' });
  world().payments.push(
    hand({ id: 'zp_smith', amount: 50000, created: dayS('2026-10-21'), buyer: person('Ruth', 'Smith') }),
    hand({ id: 'zp_jones', amount: 50000, created: dayS('2026-10-29'), buyer: person('Carl', 'Jones') }),
  );
  await posted();
  const r = await rowOf();
  assert.deepEqual({ state: r.state, posts: sitePosts().length }, { state: 'created', posts: 1 }, `Pine's $1,000 check is "${r.state}" (${r.reason}) asking about ${r.note}`);
});

// ── W1. In Watch the only signal for a cleared check nobody entered is Slack's "A check isn't in Zeffy" at 10 days. Before
//        saying it, matchOpen runs the wide look, and anything it finds (here: two strangers' pre-Nov-6 checks that add up
//        to it) turns the check into a page question with no Slack, for good: the next hours see the question "standing" ──
test('W1 in Watch, a $1,000 check nobody entered still gets "isn\'t in Zeffy" in Slack after 10 days', async () => {
  await depositIs({ amount: 1000, createdAt: '2026-11-05T15:00:00Z', status: 'pending' }, { payer: 'Pine Foundation', date: '2026-11-03' });
  world().payments.push(
    hand({ id: 'zp_smith', amount: 50000, created: dayS('2026-10-21'), buyer: person('Ruth', 'Smith') }),
    hand({ id: 'zp_jones', amount: 50000, created: dayS('2026-10-29'), buyer: person('Carl', 'Jones') }),
  );
  await posted();
  assert.equal((await rowOf()).state, 'would');
  for (let d = 1; d <= 12; d++) await run(NOW + d * DAY);
  const r = await rowOf();
  assert.ok(/isn’t in Zeffy/.test(slackSaid()), `12 days after it posted, nobody typed Pine's $1,000 check and Slack never said so; the row is "${r.state}" (${r.reason}) asking about ${r.note}`);
});

// ── R1. The same paper check deposited twice (H5b): the second goes to a person as "redeposit", listing the first one's
//        record. That record is claimed by the first deposit, so the page filters it out and, with nothing left, says "The
//        Zeffy entry that might have been this check is now another check's. Save this one in Zeffy." with Save beside it.
//        personCreate has no redeposit check and the wide look skips claimed records: Save makes the second record ───────
test('R1 the page never tells a person to save a duplicate deposit, and Save doesn\'t make a second record for it', async () => {
  await CG.setMode(env(), 'on');
  await posted();
  assert.equal((await rowOf()).state, 'created');
  await addCheck('tx_dup', { createdAt: '2026-11-06T15:00:00Z', status: 'sent', postedAt: '2026-11-08T15:00:00Z' });
  let t = NOW + 30 * MIN;
  for (let i = 0; i < 5; i++, t += 6 * MIN) await run(t);
  const dup = await rowOf('tx_dup');
  assert.equal(dup.reason, 'redeposit');
  const v = (await CG.checksView(env())).list.find((c) => c.id === 'tx_dup');
  let save = 'refused';
  try { save = (await CG.personCreate(env(), 'tx_dup', { name: 'Pine Foundation', formId: 'form_home', day: '2026-11-03', saw: v.ver, by: 'staff@soard.test', now: t + MIN, fetchImpl: fakeFetch })).result; } catch (e) { save = `${e.status}: ${e.message}`; }
  assert.deepEqual({ says: /Save this one/.test(v.why || ''), records: sitePosts().length }, { says: false, records: 1 },
    `the page said "${v.why}"; pressing Save: ${save}; Zeffy has ${sitePosts().length} records for one paper check`);
});

// ── K1. The money check is the backstop for doubles the hourly look can't see. The hourly look on a saved check takes
//        only m.same, m.maybe and netOf (all same amount); a hand entry for the same giver and a mistyped amount is m.other,
//        left out. The money check would name it, but it only reads entries dated since Nov 6, by the date typed in: a check
//        written before then (most of November's) slips past both ─────────────────────────────────────────────────────
test('K1 a check the site saved, typed again by hand with a mistyped amount and the check\'s own date (Nov 3), is named somewhere', async () => {
  await CG.setMode(env(), 'on');
  await posted();                                   // Pine Foundation, $10,000, dated Nov 3, saved by the site
  assert.equal((await rowOf()).state, 'created');
  world().payments.push(hand({ id: 'zp_typo', amount: 100000, created: dayS('2026-11-03') }));   // typed Nov 12 as $1,000, dated Nov 3
  for (let h = 0; h < 4; h++) await run(Date.parse('2026-11-12T16:00:00Z') + h * 61 * MIN);
  await run(Date.parse('2026-11-16T14:30:00Z'));    // Monday's money check
  const m = (await readState(env().DB, 'check-gifts')).money;
  assert.ok(/twice/.test(slackSaid()) || m.loose.some((x) => x.id === 'zp_typo'),
    `Zeffy has $11,000 for Pine's $10,000 check (the site's record and a $1,000 hand entry dated Nov 3), and neither the hourly look nor the money check (named: ${JSON.stringify(m.loose.map((x) => x.id))}) said so`);
});

// ── G2. The hourly double check on a saved check counts any pay-by-check entry first seen since it posted (`since`, now
//        fed by zeffy_seen), so a stranger's new online promise to pay $10,000 by check, unpaid, made a week after the site
//        saved Pine's check, is posted to Slack as "Zeffy has a hand entry for the same amount ... It may be the same check" ─
test('G2 a stranger\'s new, unpaid pay-by-check promise made after the site saved a check is not called a double of it', async () => {
  await CG.setMode(env(), 'on');
  await posted();
  assert.equal((await rowOf()).state, 'created');
  world().payments.push(hand({ id: 'zp_promise', type: 'online', status: 'pending', created: dayS('2026-11-17'), contact: 'c_lee', buyer: person('Lee', 'Park', { email: 'lee@example.com' }) }));
  for (let h = 0; h < 3; h++) await run(Date.parse('2026-11-17T18:00:00Z') + h * 61 * MIN);
  assert.ok(!/twice/.test(slackSaid()), `Slack: ${(slackSaid().match(/This check may be in Zeffy twice[^"]*"[^"]*"[^"]*/) || [''])[0].slice(0, 300)}`);
});

// ── N3. N1's rule meets the 10-day look. An event check (Zeffy takes those only by hand, so the page offers no Save)
//        that staff haven't typed after 10 days is put through the wide look; another sponsor's golf entry (typed since On,
//        under its team captain's name, another amount) turns it into "maybe-double", and the page now offers "Save in
//        Zeffy" on a donation form for a golf check, with no Slack about it ────────────────────────────────────────────────
test('N3 an event check stays an event check (no Save button) when another sponsor\'s golf entry is typed', async () => {
  await CG.setMode(env(), 'on', { now: Date.parse('2026-11-01T12:00:00Z') });
  world().reading = read({ payer: 'Acme Builders', memo: 'Golf Classic sponsor' });
  await posted();
  assert.equal((await rowOf()).reason, 'event');
  world().payments.push(hand({ id: 'zp_foursome', amount: 150000, created: dayS('2026-11-12'), description: 'Golf Classic 2026', campaign_id: 'golf', buyer: person('Tom', 'Reyes') }));
  for (let d = 1; d <= 9; d++) await run(NOW + d * DAY);
  const r = await rowOf();
  const v = (await CG.checksView(env())).list.find((c) => c.id === TX);
  assert.deepEqual({ reason: r.reason }, { reason: 'event' }, `the golf check is now "${r.reason}" asking about ${r.note}; the page says "${v.why}" and shows Save (reason no longer event)`);
});

// ── R2. A bounced check's Slack card says "If it's in Zeffy, cancel it there. Zeffy tells the donor when you do." When the
//        check is deposited again and takes that record over (linkTo), the page drops the to-do, but the card is never
//        resolved: staff who held off while it went through again (H5's premise) and then act on the card cancel the good
//        record, and Zeffy tells the donor ─────────────────────────────────────────────────────────────────────────────────
test('R2 once a redeposit takes over the bounced check\'s record, the "cancel it in Zeffy" card is resolved', async () => {
  await CG.setMode(env(), 'on');
  await posted();
  world().txns[TX] = { ...world().txns[TX], status: 'reversed' };
  await run(Date.parse('2026-11-12T16:00:00Z'));
  assert.equal((await rowOf()).state, 'came-back');
  assert.match(slackSaid(), /Cancel the record in Zeffy/);
  await addCheck('tx_2', { createdAt: '2026-11-20T15:00:00Z', status: 'pending' });
  let t = Date.parse('2026-11-20T16:00:00Z');
  for (let i = 0; i < 3; i++, t += 6 * MIN) await run(t);
  world().txns.tx_2 = { ...world().txns.tx_2, status: 'sent', postedAt: '2026-11-22T15:00:00Z' };
  for (let i = 0; i < 4; i++) await run(Date.parse('2026-11-22T16:00:00Z') + i * 6 * MIN);
  const again = await rowOf('tx_2');
  const first = await rowOf();
  assert.equal(again.zeffy_id, first.zeffy_id === null ? again.zeffy_id : 'held by the bounced row', 'the redeposit took the record over');
  const resolved = world().slack.some((b) => /Resolved/.test(b) && /came back|cancel/i.test(b));
  const open = (await env().DB.prepare("SELECT key FROM slack_open_posts WHERE key = ?").bind(`check:${TX}`).first().catch(() => null));
  assert.ok(resolved || !open, `the redeposit ${again.id} is "${again.state}" on ${again.zeffy_id}; the bounced check's card (check:${TX}) is still open telling staff to cancel that record`);
});
