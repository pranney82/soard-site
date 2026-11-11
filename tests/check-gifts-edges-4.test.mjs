/**
 * A fifth break-it round on Nov 7 2026 (stale-dated checks, addresses read as names, receipts, starved queues), against
 * the spec-faithful fake in tests/lib/check-gifts-harness-2.mjs. Each test failed before its fix. Names are made up.
 * Run: node --test tests/check-gifts-edges-4.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, run, rowOf, post, posted, fakeFetch, hand, read, txn, mirrorTransaction, readState, writeState, noEmailGiver, tagged, slackSaid, approve, card, NOW, MIN, DAY, dayS, TX } = await import('./lib/check-gifts-harness-2.mjs');

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => setup());
const env = () => W.env;
const world = () => W.world;
const addCheck = async (id, o = {}) => {
  world().txns[id] = txn({ id, ...o });
  await mirrorTransaction(env().DB, world().txns[id], { now: NOW });
};
// 3,001 ordinary online card gifts over the 14 months before (the volume F8b already holds the hourly read to)
const busyYear = () => { for (let i = 0; i < 3001; i++) world().payments.push(hand({ id: `online_${i}`, type: 'online', payment_method: { type: 'card' }, amount: 2500, created: dayS('2025-10-01') + i * 3600 * 3 })); };

// ── 1. A check dated a year before it was deposited (last year's date in January, or a stale check) widens every read
//       of Zeffy by that year: past 3,000 payments making its card throws on every run, and that check is first in line ─
test('S1 a check dated a year before its deposit never stops the site: its hand entry links and the next check is read', async () => {
  world().reading = read({ date: '2025-11-03' });        // both readers agree: the donor wrote last year
  busyYear();
  await run(NOW);                                        // read while pending
  assert.equal((await rowOf()).state, 'read');
  post();
  // Staff type it in on Nov 6, as usual
  world().payments.push(hand({ id: 'zp_pine', created: dayS('2026-11-06') }));
  // A second donor's check comes in the next day
  await addCheck('tx_2', { amount: 2500, checkNumber: '2001', createdAt: '2026-11-06T15:00:00Z', status: 'sent', postedAt: '2026-11-07T15:00:00Z' });
  env().AI.run = async () => ({ response: read({ payer: 'Maple Builders', amount: 2500, checkNumber: '2001', date: '2026-11-04' }) });
  for (let i = 1; i <= 24; i++) await CG.maybeRunChecks(env(), { now: NOW + i * 6 * MIN, fetchImpl: fakeFetch });
  const st = await readState(env().DB, 'check-gifts');
  const pine = await rowOf();
  const maple = await rowOf('tx_2');
  assert.deepEqual({ pine: pine.state, maple: maple.state, error: st.lastError?.error || null }, { pine: 'linked', maple: 'person', error: null },
    `two hours on: Pine's check is "${pine.state}", Maple's is "${maple.state}" (tries ${maple.tries}), and every run ends "${st.lastError?.error}"`);
});

// Same thing through the hourly look alone: a waiting check dated a year back makes the read start a year back
test('S1b one waiting check dated a year before its deposit never stops the hourly look for every other check', async () => {
  busyYear();
  // An older check, waiting on its card for a person: the readers agreed it's dated Nov 2025
  await env().DB.prepare(`INSERT INTO check_gifts (id, cents, state, reason, status, payer, check_date, deposited_at, posted_at, final, created_at, updated_at)
    VALUES ('tx_old', 50000, 'person', 'ready', 'sent', 'Oak Trust', '2025-11-01', '2026-10-20T15:00:00Z', '2026-10-22T15:00:00Z', 0, 'x', 'x')`).run();
  await posted();
  assert.equal((await rowOf()).state, 'person');
  world().payments.push(hand({ id: 'zp_pine', created: dayS('2026-11-08') }));
  await CG.maybeRunChecks(env(), { now: NOW + 2 * 60 * MIN, fetchImpl: fakeFetch });
  const st = await readState(env().DB, 'check-gifts');
  assert.deepEqual({ state: (await rowOf()).state, failing: st.matchFailing?.error || null }, { state: 'linked', failing: null });
});

// ── 2. Filed under another contact after all: taking the address off that contact also deletes the only note that the
//       donor's own contact still holds it. One failed read after that, and the address stays on the donor for good ──────
test('S2 when Zeffy files the gift under a second contact, one failed step never leaves the no-mail address on the donor\'s own contact', async () => {
  await noEmailGiver();
  let posted_ = false;
  // Zeffy's find-by-email misses the address it was just given and makes a second contact with it (R6's premise), and the
  // site's next read of Pine's own contact gets a 500 once (any passing fault)
  world().hook = async ({ method, path, body }) => {
    if (method === 'POST' && path === '/payments' && /@nomail\./.test(body?.email || '')) {
      world().contacts.ct_dup = { id: 'ct_dup', email: body.email, first_name: body.first_name, last_name: body.last_name, donation_count: 0 };
      posted_ = true;
    }
  };
  let failed = false;
  world().fail = ({ method, path }) => {
    if (posted_ && !failed && method === 'GET' && path === '/contacts/c_pine') { failed = true; return 500; }
    return null;
  };
  // Make the fake's POST land on the second contact (its by-email lookup finds the newest holder)
  const contacts = world().contacts;
  world().contacts = new Proxy(contacts, { ownKeys: (t) => Reflect.ownKeys(t).reverse() });
  await posted();
  // A person sends it on Pine's own contact
  const sent = await approve(TX, { now: NOW + 10 * MIN }).then((x) => x.result, (e) => e.message);
  assert.ok(posted_, `nothing was filed by the address (Send answered "${sent}")`);
  world().hook = null;
  world().fail = null;
  for (let i = 1; i <= 30; i++) await run(NOW + 10 * MIN + i * 10 * MIN);
  const r = await rowOf();
  const rows = (await env().DB.prepare('SELECT * FROM check_tags').all()).results;
  assert.deepEqual({ pine: world().contacts.c_pine.email || null }, { pine: null },
    `five hours on, Pine Foundation's own contact still has ${world().contacts.c_pine.email} (row "${r.state}", gift on ${world().payments.find((p) => p.id === r.zeffy_id)?.contact}); check_tags holds ${rows.length} rows, so nothing will take it off or tell anyone`);
});

// ── 3. "It's a different gift" trusts the row's current list as what the page showed. The hourly look refreshes that
//       list, so an entry that turned up while the dialog was open is ruled out without anyone seeing it ─────────────
test('S3 "Send a new record" never sends past an entry the hourly look added while the person was answering', async () => {
  await run(NOW);
  post();
  // A hand entry under another name, dated with the check: put to a person
  world().payments.push(hand({ id: 'zp_oak', created: dayS('2026-11-03'), buyer: { first_name: 'Oak', last_name: 'Trust', email: null, is_corporate: false, company_name: null } }));
  await run(NOW + 10 * MIN);
  assert.equal((await rowOf()).reason, 'maybe-double');
  // The person presses Send; the site answers with the one entry it knows, and the page asks "Is this a different gift?"
  const first = await approve(TX, { name: 'Pine Foundation', formId: 'form_home', saw: CG.versionOf(await rowOf()), now: NOW + 70 * MIN }).catch((e) => e);
  assert.deepEqual(first.entries.map((x) => x.id), ['zp_oak']);
  // While the dialog is open, Pine's advisor's hand entry for this very check shows up, and the hourly look runs
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-11-08'), buyer: { first_name: 'Dana', last_name: 'Whitfield', email: null, is_corporate: false, company_name: null } }));
  await run(NOW + 2 * 60 * MIN);
  // The person, who saw only Oak Trust, presses "Send a new record" (the page sends what it showed, and saw = 'person')
  const r = await approve(TX, { name: 'Pine Foundation', formId: 'form_home', notThose: true, shown: ['zp_oak'], saw: 'person', now: NOW + 2 * 60 * MIN + MIN }).catch((e) => e);
  assert.equal(world().posts.length, 0, `a second $10,000 record was saved past Dana Whitfield's entry, which nobody was shown (${r?.result || r?.message}); rejected now ${(await rowOf()).rejected}`);
});

// ── 4. A check Zeffy told to wait gets its turn only when no check needs reading. A pending check with no picture yet
//       (the site waits for Mercury's picture) needs reading on every run, so the waiting one never gets a turn ───────
test('S4 a check Zeffy asked to wait on is sent once Zeffy answers, even while another check waits for its picture', async () => {
  await noEmailGiver();
  // Pine's contact can't be read for the first half hour (Zeffy hiccup), then it can
  let until = NOW + 30 * MIN;
  let clock = NOW;
  world().fail = ({ method, path }) => (clock < until && method === 'GET' && path === '/contacts/c_pine' ? 500 : null);
  post();
  await run(clock);                                      // read
  clock += 6 * MIN; await run(clock);                    // its card: Zeffy didn't answer about this giver
  // While Zeffy can't say who Pine's contact is, the card never starts on a new donor for a giver Zeffy already has
  const early = await card();
  assert.ok(!early.card || early.card.donor !== 'new',
    `with Pine's contact unread, the card is "${early.state}" and starts on donor "${early.card?.donor}" (donors ${JSON.stringify(early.card?.donors)}): Send as filled in makes Pine Foundation a second Zeffy contact`);
  // A second donor's check arrives pending, and Mercury hasn't attached its picture yet
  await addCheck('tx_2', { amount: 2500, checkNumber: '2001', createdAt: '2026-11-10T16:10:00Z', attachments: [] });
  // Three days of heartbeats while tx_2 is pending (Mercury: up to 5 business days)
  for (clock += 6 * MIN; clock < NOW + 3 * DAY; clock += 6 * MIN) await run(clock).catch(() => null);
  // A person sends Pine's card as it's filled in
  const sent = await approve(TX, { now: clock }).then((x) => x.result, (e) => e.message);
  const r = await rowOf();
  const gift = world().payments.find((p) => p.id === r.zeffy_id);
  assert.deepEqual({ saved: !!r.zeffy_id, on: gift?.contact || null }, { saved: true, on: 'c_pine' },
    `three days after Zeffy came back, Pine's posted $10,000 check is "${r.state}" (Send answered "${sent}"), record on ${gift?.contact} (tx_2 is "${(await rowOf('tx_2')).state}")`);
});

// ── 5. "The longer reading holds both": when one reader copies the address block under the name, the address becomes the
//       giver. A known giver's check then makes a new contact named "Pine Foundation 123 Main St Atlanta, GA" "30301" ───────
const [READER_A] = Object.keys((await import('../functions/api/_score-scans.js')).READERS);
test('S5 a reader that copies the printed address under the name never puts the address into Zeffy as the giver', async () => {
  await noEmailGiver();
  env().AI.run = async (model) => ({ response: model === READER_A ? read({ payer: 'PINE FOUNDATION' }) : read({ payer: 'PINE FOUNDATION 100 MAIN ST SPRINGFIELD, GA 30000' }) });
  await posted();
  for (let i = 1; i <= 3; i++) await run(NOW + 10 * MIN + i * 6 * MIN);
  await approve(TX, { now: NOW + 30 * MIN }).catch(() => null);   // a person sends the card as filled in
  const r = await rowOf();
  const gift = world().payments.find((p) => p.id === r.zeffy_id);
  assert.deepEqual({ payer: r.payer, on: gift?.contact || null, names: gift ? `${gift.buyer.first_name} | ${gift.buyer.last_name}` : null },
    { payer: 'Pine Foundation', on: 'c_pine', names: 'Pine | Foundation' },
    `row "${r.state}"; Zeffy record ${gift?.id} on contact ${gift?.contact}`);
});

// ── 6. A reader answering the name as an object (not the schema's string) is read as the giver "[object Object]" ───────
test('S6 suspected: two readers that answer the payer as an object never make a Zeffy record for "[object Object]"', async () => {
  env().AI.run = async () => ({ response: { ...read(), payer: { name: 'Pine Foundation', address: '100 Main St' } } });
  await posted();
  for (let i = 1; i <= 3; i++) await run(NOW + 10 * MIN + i * 6 * MIN);
  await approve(TX, { now: NOW + 30 * MIN }).catch(() => null);   // a person sends the card as filled in
  const r = await rowOf();
  const names = world().posts.map((b) => `${b.first_name} ${b.last_name}`);
  assert.ok(!/object/i.test(r.payer || '') && !names.some((n) => /object/i.test(n)), `payer "${r.payer}", row "${r.state}", Zeffy records saved: ${JSON.stringify(names)}`);
});

// ── 7. Making the card reads pledges 13 months back; the hourly look doesn't. A check asked about a giver's older pledge
//       is made again every hour without it (the pledge isn't in the hourly read), then asked about again: it flaps ──────
test('S7 a check asked about a giver\'s five-month-old pledge stays with the person, not off and on every hour', async () => {
  world().payments.push(hand({ id: 'zp_pledge', type: 'online', status: 'pending', created: dayS('2026-05-20') }));
  await posted();
  assert.equal((await rowOf()).reason, 'pledge');
  const seen = [];
  for (let t = NOW + 10 * MIN + 6 * MIN; t < NOW + 4 * 60 * MIN; t += 6 * MIN) {
    await run(t);
    const r = await rowOf();
    seen.push(`${r.state}${r.reason ? `/${r.reason}` : ''}`);
  }
  const v = await CG.checksView(env());
  assert.deepEqual([...new Set(seen)], ['person/pledge'], `four hours of runs: ${seen.join(' → ')}; Slack said ${world().slack.length} things`);
});

// ── 8. A check Mercury no longer answers for (404) is never marked looked at, so it stays first in the re-read line.
//       Ten of those (they never become final) and no other check is ever re-read: a pending check never posts here ───────
test('S8 suspected: deposits Mercury answers 404 for never crowd the re-read line, so a pending check still posts and gets its card', async () => {
  for (let i = 0; i < 10; i++) {
    const id = `tx_gone_${i}`;
    world().txns[id] = txn({ id, amount: 1000 + i, checkNumber: String(3000 + i), createdAt: `2026-10-${String(10 + i).padStart(2, '0')}T15:00:00Z`, status: 'sent', postedAt: `2026-10-${String(12 + i).padStart(2, '0')}T15:00:00Z` });
    await mirrorTransaction(env().DB, world().txns[id], { now: NOW });
  }
  await run(NOW);
  // Mercury stops answering for those ten (removed, or moved out of the token's reach)
  for (let i = 0; i < 10; i++) delete world().txns[`tx_gone_${i}`];
  // A day and a bit of heartbeats while Pine's check is pending
  let t = NOW + 30 * MIN;
  for (; t < NOW + 26 * 60 * MIN; t += 30 * MIN) await run(t).catch(() => null);
  post();
  for (const end = t + 6 * 60 * MIN; t < end; t += 30 * MIN) await run(t).catch(() => null);
  const r = await rowOf();
  assert.deepEqual({ status: r.status, state: r.state }, { status: 'sent', state: 'person' }, `six hours after Mercury posted it, Pine's check still shows "${r.status}" (looked at ${r.looked_at})`);
});

// ── 9. A check put to a person, sent weeks later, is saved without the look for a late hand entry under another name:
//       staff who typed it by hand meanwhile get a double ─────────────────────────────────────────────────────────────
test('S9 a check sent from its card weeks later is never saved over a hand entry typed for it meanwhile', async () => {
  await run(NOW);
  post();
  // Oak Trust's $10,000 entry, dated with the check: Pine's check is put to a person
  world().payments.push(hand({ id: 'zp_oak', created: dayS('2026-11-04'), contact: 'c_oak', buyer: { first_name: 'Oak', last_name: 'Trust', email: null, is_corporate: false, company_name: null } }));
  await run(NOW + 10 * MIN);
  assert.equal((await rowOf()).reason, 'maybe-double');
  // Five weeks on, nobody has answered on the page; a staffer types Pine's check into Zeffy by hand under the fund's advisor
  const later = Date.parse('2026-12-12T16:00:00Z');
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-12-12'), contact: 'c_dana', buyer: { first_name: 'Dana', last_name: 'Whitfield', email: null, is_corporate: false, company_name: null } }));
  // Oak Trust's own check comes in and takes Oak's entry
  await env().DB.prepare(`INSERT INTO check_gifts (id, cents, state, status, payer, zeffy_id, via, deposited_at, posted_at, final, created_at, updated_at) VALUES ('tx_oak', 1000000, 'linked', 'sent', 'Oak Trust', 'zp_oak', 'hand', '2026-12-10T15:00:00Z', '2026-12-11T15:00:00Z', 0, 'x', 'x')`).run();
  for (let i = 0; i < 4; i++) await run(later + i * 61 * MIN);
  // Someone finally opens the card and presses Send to Zeffy as it's filled in
  const sent = await approve(TX, { now: later + 4 * 61 * MIN }).then((x) => x.result, (e) => e.message);
  const r = await rowOf();
  assert.equal(world().posts.length, 0, `Send answered "${sent}" and saved a second $10,000 record for Pine's check (row "${r.state}", ${r.zeffy_id}) though Dana Whitfield's hand entry for it was typed five weeks after the deposit`);
});

// ── 10. The write test sees whether Zeffy made a tax receipt (receipt_url) and keeps it, but passes either way, and the
//        page then says "Nothing goes to donors" and lets checks be sent. Half the givers have an email Zeffy would send it to
test('S10 a write test whose $1 records come back with a tax receipt never lets a check be sent to Zeffy', async () => {
  // Zeffy makes the receipt anyway (a form setting, or the flag not honored): every POST answers with a receipt link
  const withReceipt = async (input, init = {}) => {
    const res = await fakeFetch(input, init);
    const url = String(typeof input === 'string' ? input : input.url);
    if ((init.method || 'GET') === 'POST' && /\/payments$/.test(url) && res.ok) {
      const p = await res.json();
      p.receipt_url = `https://www.zeffy.com/receipt/${p.id}`;
      const kept = world().payments.find((x) => x.id === p.id);
      if (kept) kept.receipt_url = p.receipt_url;
      return new Response(JSON.stringify(p), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return res;
  };
  await writeState(env().DB, 'check-gifts', { writeTest: null });
  const report = await CG.testWrite(env(), { now: NOW, fetchImpl: withReceipt });
  // Pine's check comes in and gets its card; a person presses Send to Zeffy
  post();
  await run(NOW + MIN);
  await run(NOW + 6 * MIN);
  const before = world().posts.length;
  const send = await approve(TX, { now: NOW + 10 * MIN }).then(() => 'sent', (e) => e.status || e.message);
  const v = await CG.checksView(env());
  assert.deepEqual({ sending: v.sending, send, posts: world().posts.length - before }, { sending: false, send: 409, posts: 0 },
    `the test passed (ok ${report.ok}) with receipts on every record: ${JSON.stringify(report.steps.map((x) => x.receipt))}, email record receipt ${report.email?.receipt}`);
});

// ── 11. A name's last word goes in Zeffy's last-name box, so a suffix becomes the donor's last name ─────────────────────
test('S11 minor: John A. Smith Jr. goes into Zeffy with Smith as the last name, not "Jr."', () => {
  assert.deepEqual(CG.nameParts('John A. Smith Jr.'), { first_name: 'John A.', last_name: 'Smith Jr.' });
});

// ── 12. A person matches a company's check to the owner's own pay-by-check promise (right for that check). From then on
//        every check from the company is filed under the owner's personal contact, by her email, under her name ─────────
test('S12 suspected: matching a company\'s check to its owner\'s promise once never files the company\'s later checks as the owner\'s own gifts', async () => {
  world().contacts.c_dana = { id: 'c_dana', email: 'dana@whitfield.example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 1 };
  world().reading = read({ payer: 'OAKLINE DESIGN BUILD LLC' });
  // Dana promised $10,000 online, to pay by check; the check came from her company
  world().payments.push(hand({ id: 'zp_promise', type: 'online', status: 'pending', created: dayS('2026-10-20'), contact: 'c_dana',
    buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@whitfield.example.com', is_corporate: false, company_name: null } }));
  await posted();
  const r1 = await rowOf();
  assert.equal(r1.state, 'person');               // asked about Dana's promise (another name, by check)
  await CG.personLink(env(), TX, 'zp_promise', { saw: CG.versionOf(r1), by: 'staff@soard', now: NOW + 20 * MIN, fetchImpl: fakeFetch });
  // Next spring the company sponsors again: a $2,500 check, no promise
  world().txns.tx_2 = txn({ id: 'tx_2', amount: 2500, checkNumber: '5521', createdAt: '2027-03-02T15:00:00Z', status: 'sent', postedAt: '2027-03-03T15:00:00Z' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: NOW });
  world().reading = read({ payer: 'OAKLINE DESIGN BUILD LLC', amount: 2500, checkNumber: '5521', date: '2027-02-27' });
  for (let i = 0; i < 4; i++) await run(Date.parse('2027-03-04T16:00:00Z') + i * 10 * MIN);
  // A person sends the company's card as it's filled in
  const result = await approve('tx_2', { now: Date.parse('2027-03-04T16:45:00Z') }).then((x) => x.result, (e) => e.message);
  const sent = world().posts.at(-1);
  assert.deepEqual({ email: sent?.email || null, name: sent ? `${sent.first_name} ${sent.last_name}` : null }, { email: null, name: 'Oakline Design Build LLC' },
    `the company's $2,500 check went into Zeffy as Dana Whitfield's personal gift, by her email (row ${(await rowOf('tx_2')).state}, Send answered "${result}")`);
});

// Same root, through a person's Send: the date written on the check (up to a year back) widens the read the same way, and
// past 3,000 payments the Send is refused as "Zeffy didn't answer" every time, so the person can never send it
test('S1c a person can send a check with the date written on it a year back', async () => {
  busyYear();
  await run(NOW);
  post();
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'unreadable', status = 'sent', posted_at = '2026-11-07T15:00:00Z' WHERE id = ?`).bind(TX).run();
  const r = await approve(TX, { name: 'Pine Foundation', donor: 'new', formId: 'form_home', day: '2025-11-15', now: NOW + 5 * MIN }).then((x) => x.result, (e) => e.message);
  assert.equal(r, 'created');
  assert.equal(world().posts.length, 1);
});

// ── 13. Any donor's pay-by-check promise for the same amount, however old, stops the check's Send. An abandoned $500
//        promise from last winter stops the monthly $500 giver's check every month ──────────────────────────────────────
test('S13 a stranger\'s ten-month-old unpaid $500 pay-by-check promise doesn\'t stop the monthly $500 giver\'s check from being sent', async () => {
  await noEmailGiver();
  world().txns[TX] = txn({ amount: 500 });
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
  world().reading = read({ amount: 500 });
  // Pine's October check, already in Zeffy on its contact
  world().payments.push(hand({ id: 'zp_pine_oct', amount: 50000, created: dayS('2026-10-03'), contact: 'c_pine' }));
  // Last January a stranger promised $500 by check on the form and never mailed it
  world().payments.push(hand({ id: 'zp_stale', type: 'online', status: 'pending', amount: 50000, created: dayS('2026-01-12'), contact: 'c_jane',
    buyer: { first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', is_corporate: false, company_name: null } }));
  await posted();
  const before = await card();
  const sent = await approve(TX, { now: NOW + 15 * MIN }).then((x) => x.result, (e) => e.message);
  const r = await rowOf();
  assert.ok(r.zeffy_id, `Pine's November $500 check is "${r.state}" (${CG.REASONS[r.reason]}), shown with ${r.note}; its card said ${JSON.stringify(before?.card?.notes?.map((n) => n.kind))} and Send answered "${sent}"`);
});
