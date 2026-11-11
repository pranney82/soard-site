/**
 * A sixth break-it round on Nov 7 2026, against the live code: the wide look before any record is made, unanswered saves,
 * a foundation on its director's contact. Fake Zeffy: tests/lib/check-gifts-harness-2.mjs. Each test failed before its fix.
 * Names are made up. Run: node --test tests/check-gifts-edges-5.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, run, rowOf, post, posted, fakeFetch, hand, read, txn, mirrorTransaction, readState, writeState, noEmailGiver, tagged, slackSaid, approve, NOW, MIN, DAY, dayS, TX } = await import('./lib/check-gifts-harness-2.mjs');
// Send to Zeffy from a card through a test's own Zeffy (the harness's approve uses the shared fake)
const { approveWith } = await import('./lib/check-gifts-approve.mjs');

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
const busyYear = () => { for (let i = 0; i < 3001; i++) world().payments.push(hand({ id: `online_${i}`, type: 'online', payment_method: { type: 'card' }, amount: 2500, created: dayS('2025-10-01') + i * 3600 * 3 })); };

// ── 1. A person's save dated a year back (S1c allows it) whose answer never comes: settleUnsure reads Zeffy from that date
//       minus 120 days, past what it can read whole, and throws before anything else in the run happens. Every run after
//       that stops there: no check is read, carded or matched, and the unsure check never reaches a person ──────────
test('X1 one unanswered save dated a year back never stops every later run', async () => {
  busyYear();
  await run(NOW);
  post();
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'unreadable', status = 'sent', posted_at = '2026-11-07T15:00:00Z' WHERE id = ?`).bind(TX).run();
  // Zeffy takes the save but the answer never comes back
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout' : null);
  const first = await approve(TX, { name: 'Pine Foundation', donor: 'new', formId: 'form_home', day: '2025-11-15', now: NOW + 5 * MIN }).then((x) => x.result, (e) => e.message);
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  // Another donor's check comes in and posts
  await addCheck('tx_2', { amount: 2500, checkNumber: '2001', createdAt: '2026-11-08T15:00:00Z', status: 'sent', postedAt: '2026-11-09T15:00:00Z' });
  env().AI.run = async () => ({ response: read({ payer: 'Maple Builders', amount: 2500, checkNumber: '2001', date: '2026-11-04' }) });
  for (let i = 1; i <= 24; i++) await CG.maybeRunChecks(env(), { now: NOW + 5 * MIN + i * 6 * MIN, fetchImpl: fakeFetch });
  const st = await readState(env().DB, 'check-gifts');
  const pine = await rowOf();
  const maple = await rowOf('tx_2');
  assert.deepEqual({ pineSettled: pine.state !== 'unsure', mapleDone: !!maple.zeffy_id || maple.state === 'person' },
    { pineSettled: true, mapleDone: true },
    `two and a half hours on: Pine's check is still "${pine.state}" (the page says don't enter it), Maple's $25 check is "${maple.state}" and never read; every run ends "${st.lastError?.error}"`);
});
// ── 2. R6b's premise for the PATCH that puts the address on: Zeffy finishes it after the site's 15 seconds ran out. The site
//       takes it as "not answering", finds no address yet, and deletes its only note of it. When the PATCH lands, the donor's
//       own contact holds the no-mail address with nothing to take it off and nobody told ─────────────────────────────
test('X2 a tag PATCH Zeffy finishes after its answer timed out never leaves the donor\'s contact holding the address', async () => {
  await noEmailGiver();
  let late = null;
  world().fail = ({ method, path, body }) => {
    if (method === 'PATCH' && path === '/contacts/c_pine' && /@nomail\./.test(body?.email || '') && !late) { late = body; return 'timeout'; }
    return null;
  };
  await posted();
  // A person sends it on Pine's own contact; Zeffy doesn't answer the address in time, and the page says to try again
  const sent = await approve(TX, { now: NOW + 10 * MIN }).then((x) => x.result, (e) => e.message);
  assert.ok(late, `the site tried to put the address on (Send answered "${sent}")`);
  // Zeffy completes the PATCH it was still working on
  await fakeFetch('https://api.zeffy.com/api/v1/contacts/c_pine', { method: 'PATCH', body: JSON.stringify(late) });
  for (let i = 1; i <= 12; i++) await run(NOW + 10 * MIN + i * 6 * MIN);
  const r = await rowOf();
  const rows = (await env().DB.prepare('SELECT * FROM check_tags').all()).results;
  assert.deepEqual({ pine: world().contacts.c_pine.email || null }, { pine: null },
    `over an hour on, Pine Foundation's own contact has ${world().contacts.c_pine.email} (row "${r.state}", record ${r.zeffy_id}); check_tags holds ${rows.length} rows and Slack said ${/no-mail/.test(slackSaid()) ? 'something' : 'nothing'}`);
});
// The PATCH lands later still, after the site's next runs found no address and let the note go: the next Send on that donor
// finds the site's own address on the contact with no note of it, takes it off, and files the gift under their contact
test('X2b a tag PATCH Zeffy finishes long after the site gave up on it comes off at the next Send, and the gift files under the donor', async () => {
  await noEmailGiver();
  let late = null;
  world().fail = ({ method, path, body }) => {
    if (method === 'PATCH' && path === '/contacts/c_pine' && /@nomail\./.test(body?.email || '') && !late) { late = body; return 'timeout'; }
    return null;
  };
  await posted();
  await assert.rejects(approve(TX, { now: NOW + 10 * MIN }), /busy/);
  for (let i = 1; i <= 3; i++) await run(NOW + 10 * MIN + i * 6 * MIN);
  assert.equal((await env().DB.prepare('SELECT COUNT(*) AS n FROM check_tags').first()).n, 0, 'the note is gone: the address never showed');
  await fakeFetch('https://api.zeffy.com/api/v1/contacts/c_pine', { method: 'PATCH', body: JSON.stringify(late) });
  assert.match(world().contacts.c_pine.email, /@nomail\./);
  const r = await approve(TX, { now: NOW + 40 * MIN });
  assert.equal(r.result, 'created');
  assert.equal(world().payments.at(-1).contact, 'c_pine');
  assert.equal(world().contacts.c_pine.email || null, null);
  assert.equal((await env().DB.prepare('SELECT COUNT(*) AS n FROM check_tags').first()).n, 0);
});
// ── 3. A donor-advised check the readers couldn't date, typed by hand under the donor's own name and backdated to the
//       date on the check (16 days before the deposit). No look ever ties the two (another name, outside 14 days of the
//       deposit), so when its card is sent the site saves it again, and the hourly look never calls it a double ───────
test('X3 a hand entry under the advisor\'s name, backdated to the check\'s own date, is never saved a second time when its card is sent', async () => {
  // Fidelity Charitable's check for Dana Whitfield; the two readers disagree on the date, so none is used
  let n = 0;
  env().AI.run = async () => ({ response: read({ payer: 'Fidelity Charitable', memo: 'Recommended by Dana Whitfield', date: n++ % 2 ? '2026-10-20' : '2026-10-21' }) });
  await posted();                                       // on its card: deposited Nov 5, posted Nov 7
  assert.equal((await rowOf()).state, 'person');
  assert.equal((await rowOf()).check_date, null);
  // Staff type it under Dana Whitfield, backdated to the date on the check (Zeffy stamps it noon UTC)
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-10-20'), buyer: { first_name: 'Dana', last_name: 'Whitfield', email: null, is_corporate: false, company_name: null } }));
  let t = NOW + 30 * MIN;
  for (; t < Date.parse('2026-11-18T16:00:00Z'); t += 61 * MIN) await run(t);
  const before = await rowOf();
  world().slack = [];
  // Someone finally sends its card as it's filled in
  const sent = before.state === 'person' ? await approve(TX, { now: t }).then((x) => x.result, (e) => e.message) : null;
  for (let i = 0; i < 4; i++, t += 6 * MIN) await run(t);
  for (let h = 0; h < 3; h++, t += 61 * MIN) await run(t);
  const r = await rowOf();
  const records = world().payments.filter((p) => p.amount === 1000000);
  assert.deepEqual({ posts: world().posts.length }, { posts: 0 },
    `the check sat "${before.state}"; Send answered "${sent}" and saved a second $10,000 record (row "${r.state}", ${records.length} $10,000 records in Zeffy), and Slack ${/twice/.test(slackSaid()) ? 'flagged' : 'never flagged'} a double`);
});
// Same root, a stale check: both readers agree it's dated Aug 27 (70 days before the deposit, so it goes on the deposit day)
test('X3b a stale check typed by hand under the advisor\'s name with the check\'s own date is never saved a second time when its card is sent', async () => {
  world().reading = read({ payer: 'Fidelity Charitable', memo: 'Recommended by Dana Whitfield', date: '2026-08-27' });
  await posted();
  assert.equal((await rowOf()).state, 'person');
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-08-27'), buyer: { first_name: 'Dana', last_name: 'Whitfield', email: null, is_corporate: false, company_name: null } }));
  let t = NOW + 30 * MIN;
  for (; t < Date.parse('2026-11-18T16:00:00Z'); t += 61 * MIN) await run(t);
  world().slack = [];
  const before = await rowOf();
  const sent = before.state === 'person' ? await approve(TX, { now: t }).then((x) => x.result, (e) => e.message) : null;
  for (let i = 0; i < 4; i++, t += 6 * MIN) await run(t);
  for (let h = 0; h < 3; h++, t += 61 * MIN) await run(t);
  const r = await rowOf();
  assert.deepEqual({ posts: world().posts.length }, { posts: 0 },
    `Send answered "${sent}" and saved a second $10,000 record (row "${r.state}"), and Slack ${/twice/.test(slackSaid()) ? 'flagged' : 'never flagged'} a double`);
});
// ── 4. A first-time no-email giver whose first save's answer never came: settleUnsure finds the record, but never learns
//       the contact it went on (createRecord would have), so their next check makes a second contact for them ─────────
test('X4 a first gift found after an unanswered save still keeps the giver\'s next check on the same Zeffy contact', async () => {
  await posted();
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  await approve(TX, { now: NOW + 10 * MIN }).catch(() => null);
  world().fail = null;
  assert.equal((await rowOf()).state, 'unsure');
  await run(NOW + 20 * MIN);
  const first = await rowOf();
  assert.equal(first.state, 'created');
  // December's check from the same giver
  await addCheck('tx_2', { amount: 10000, checkNumber: '1043', createdAt: '2026-12-05T15:00:00Z', status: 'sent', postedAt: '2026-12-07T15:00:00Z' });
  world().reading = read({ checkNumber: '1043', date: '2026-12-03' });
  const dec = Date.parse('2026-12-08T16:00:00Z');
  for (let i = 0; i < 4; i++) await run(dec + i * 6 * MIN);
  // A person sends December's card as it's filled in
  const sent = await approve('tx_2', { now: dec + 25 * MIN }).then((x) => x.result, (e) => e.message);
  const second = await rowOf('tx_2');
  const on = (id) => world().payments.find((p) => p.id === id)?.contact;
  assert.equal(on(second.zeffy_id), on(first.zeffy_id), `Pine Foundation now has two Zeffy contacts: ${on(first.zeffy_id)} and ${on(second.zeffy_id)} (Dec row "${second.state}", Send answered "${sent}")`);
});
// ── 5. R6b's premise (Zeffy finishes a filed-by-address POST after its answer timed out) with a second check from the same
//       giver in between: clearTags waits for an unsure check, but postJoined's lock only waits for a 'creating' one, so
//       the second save takes the first check's address off before Zeffy uses it ────────────────────────────────────
test('X5 a second check from the same no-email giver never takes the address off while the first check\'s save is unanswered', async () => {
  await noEmailGiver();
  await addCheck('tx_2', { amount: 10000, checkNumber: '1043', createdAt: '2026-11-05T15:10:00Z', status: 'sent', postedAt: '2026-11-07T15:00:00Z' });
  let late = null;
  world().fail = ({ method, path, body }) => {
    if (method === 'POST' && path === '/payments' && /@nomail\./.test(body?.email || '') && !late) { late = body; return 'timeout'; }
    return null;
  };
  // Both read the same way (Pine sends two $100 checks a week apart)
  let k = 0;
  env().AI.run = async () => ({ response: read(k++ < 2 ? {} : { checkNumber: '1043', date: '2026-10-27' }) });
  post();
  for (let i = 0; i < 5; i++) await run(NOW + i * 6 * MIN);
  // A person sends both cards, one after the other: the first one's answer never comes
  const sentA = await approve(TX, { now: NOW + 25 * MIN }).then((x) => x.result, (e) => e.message);
  const sentB = await approve('tx_2', { now: NOW + 26 * MIN }).then((x) => x.result, (e) => e.message);
  const a = await rowOf();
  const b = await rowOf('tx_2');
  assert.ok(late, `the first save went out (Send answered "${sentA}", then "${sentB}")`);
  // Zeffy finishes the first POST now
  world().fail = null;
  await fakeFetch('https://api.zeffy.com/api/v1/payments', { method: 'POST', body: JSON.stringify(late) });
  for (let i = 5; i <= 14; i++) await run(NOW + 26 * MIN + i * 6 * MIN);
  const rows = (await env().DB.prepare('SELECT * FROM check_tags').all()).results;
  assert.deepEqual({ tagged: tagged().map((c) => `${c.id} ${c.email}`) }, { tagged: [] },
    `first check "${a.state}" then "${(await rowOf()).state}", second "${b.state}" then "${(await rowOf('tx_2')).state}"; check_tags holds ${rows.length} rows, so nothing takes it off`);
});
// Same root, once sent: Fidelity Charitable's check went into Zeffy from its card; four weeks later someone catching up types
// it by hand under the donor's own name (not backdated). The hourly look's double check uses the same windows, so nobody hears of it
test('X3c a hand entry typed four weeks after the check was sent to Zeffy, under the advisor\'s name, is flagged as a possible double', async () => {
  world().reading = read({ payer: 'Fidelity Charitable', memo: 'Recommended by Dana Whitfield' });
  await posted();
  await approve(TX, { now: NOW + 10 * MIN }).catch(() => null);
  assert.equal((await rowOf()).state, 'created');
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-12-03'), buyer: { first_name: 'Dana', last_name: 'Whitfield', email: null, is_corporate: false, company_name: null } }));
  world().slack = [];
  for (let h = 0; h < 3; h++) await run(Date.parse('2026-12-03T18:00:00Z') + h * 61 * MIN);
  assert.match(slackSaid(), /twice/, `two $10,000 records for one check in Zeffy, and nothing said so (row "${(await rowOf()).state}")`);
});
// ── 6. The write test's date check can't fail: it dates its record yesterday at noon Eastern and calls the date kept when
//       Zeffy's date is within a day of that, which a record stamped "now" also is. So the live pass says nothing about
//       whether Zeffy keeps payment_date. If it didn't, every unanswered save (looked for within two days of the date it
//       was sent) would go to a person as "save it again": a second record ─────────────────────────────────────────────
test('X6 the write test tells a Zeffy that ignores payment_date from one that keeps it', async () => {
  // Zeffy stamps every new payment with the time it was saved, whatever payment_date says
  const ignoring = async (input, init = {}) => {
    const res = await fakeFetch(input, init);
    const url = String(typeof input === 'string' ? input : input.url);
    if ((init.method || 'GET') === 'POST' && /\/payments$/.test(url) && res.ok) {
      const p = await res.json();
      const stored = world().payments.find((x) => x.id === p.id);
      stored.created = p.created = Math.floor(NOW / 1000);
      return new Response(JSON.stringify(p), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return res;
  };
  await writeState(env().DB, 'check-gifts', { writeTest: null });
  const report = (await CG.runChecks(env(), { now: NOW, fetchImpl: ignoring })).writeTest;
  assert.deepEqual({ dateKept: report.join?.dateKept }, { dateKept: false },
    `Zeffy dated the record when it was saved, and the test says the date was kept (ok ${report.ok}, join ${report.join?.ok})`);
});

// What it would cost: with that Zeffy, a save whose answer never came, of a check dated a week before, is saved twice
test('X6b with a Zeffy that dates records when saved, an unanswered save is found, not saved again', async () => {
  let clock = NOW;
  let lose = true;
  const ignoring = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const isPost = (init.method || 'GET') === 'POST' && /\/payments$/.test(url);
    const res = await fakeFetch(input, init);
    if (isPost && res.ok) {
      const p = await res.json();
      world().payments.find((x) => x.id === p.id).created = Math.floor(clock / 1000);
      if (lose) { lose = false; throw new DOMException('timed out', 'TimeoutError'); }
      return new Response(JSON.stringify({ ...p, created: Math.floor(clock / 1000) }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return res;
  };
  // A person sends the card as soon as it's made; Zeffy saves it and the answer is lost
  let first = null;
  for (let t = NOW; t < NOW + 50 * MIN; t += 6 * MIN) {
    clock = t; if (t > NOW) post(); await CG.runChecks(env(), { now: t, fetchImpl: ignoring });
    if (!first && (await rowOf()).state === 'person') { clock = t + MIN; first = await approveWith(env(), ignoring, TX, { now: t + MIN }).then((x) => x.result, (e) => e.message); }
  }
  assert.match(String(first), /don’t send this one again/);
  const r = await rowOf();
  let again = null;
  if (r.state === 'person') again = await approveWith(env(), ignoring, TX, { name: r.payer, formId: 'form_home', saw: CG.versionOf(r), now: NOW + 55 * MIN }).then((x) => x.result, (e) => e.message);
  assert.equal(world().payments.filter((p) => p.amount === 1000000).length, 1, `row went "${r.state}" (${r.reason}), the person saved it again (${again}): two $10,000 records`);
});
// ── 7. An organization's gift in Zeffy sits on its representative's contact (is_corporate, company_name). A check from that
//       organization links to it and teaches that contact; from then on each of the organization's checks goes in under
//       the contact's own names (B7b), so Zeffy, Slack and the board record a $10,000 foundation grant as the director's
//       personal gift, by her email. Zeffy's API can't mark a record corporate, so the check's own name is all that says
//       who gave ─────────────────────────────────────────────────────────────────────────────────────────────────
test('X7 a foundation\'s check filed on its director\'s contact still goes in under the foundation\'s name', async () => {
  world().contacts.c_dana = { id: 'c_dana', email: 'dana@pinefoundation.example.org', first_name: 'Dana', last_name: 'Whitfield', donation_count: 2 };
  // October's check, typed in by staff as the foundation's gift on its director's contact
  world().payments.push(hand({ id: 'zp_oct', created: dayS('2026-11-04'), contact: 'c_dana',
    buyer: { email: 'dana@pinefoundation.example.org', first_name: 'Dana', last_name: 'Whitfield', is_corporate: true, company_name: 'Pine Foundation', address: null } }));
  await posted();                                       // linked to the hand entry
  assert.equal((await rowOf()).zeffy_id, 'zp_oct');
  // December's check from the foundation
  await addCheck('tx_2', { amount: 10000, checkNumber: '1077', createdAt: '2026-12-04T15:00:00Z', status: 'sent', postedAt: '2026-12-07T15:00:00Z' });
  world().reading = read({ checkNumber: '1077', date: '2026-12-01' });
  for (let i = 0; i < 4; i++) await run(Date.parse('2026-12-08T16:00:00Z') + i * 6 * MIN);
  // A person sends its card as it's filled in
  const result = await approve('tx_2', { now: Date.parse('2026-12-08T16:30:00Z') }).then((x) => x.result, (e) => e.message);
  const sent = world().posts.at(-1);
  const p = world().payments.find((x) => x.id === (sent && world().payments.at(-1).id));
  assert.ok(sent, `nothing was saved (row "${(await rowOf('tx_2')).state}", Send answered "${result}")`);
  assert.match(`${sent.first_name} ${sent.last_name}`, /Pine/,
    `the foundation's $10,000 check went into Zeffy as "${sent.first_name} ${sent.last_name}" by ${sent.email}: Slack says "${p ? 'gift from ' + p.buyer.first_name + ' ' + p.buyer.last_name : ''}"`);
});
// ── 8. A check Mercury sends back while its save is unanswered: lookAgain moves 'unsure' to 'came-back', settleUnsure stops
//       looking, and the record Zeffy did save belongs to nobody. The page shows nothing to do; Slack says "didn't go
//       through" without saying Zeffy has a record ─────────────────────────────────────────────────────────────────
test('X8 a check that comes back while its save is unanswered still gets its Zeffy record found, to cancel', async () => {
  await posted();
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  await approve(TX, { now: NOW + 10 * MIN }).catch(() => null);
  world().fail = null;
  assert.equal((await rowOf()).state, 'unsure');
  // Mercury: the check bounced
  world().txns[TX] = { ...world().txns[TX], status: 'reversed' };
  world().slack = [];
  for (let i = 1; i <= 12; i++) await run(NOW + 10 * MIN + i * 6 * MIN);
  const r = await rowOf();
  const v = (await CG.checksView(env())).list.find((c) => c.id === TX);
  const saved = world().payments.filter((p) => p.amount === 1000000).map((p) => p.id);
  assert.deepEqual({ known: r.zeffy_id }, { known: saved[0] },
    `Zeffy holds ${saved.join(', ')} for a check that bounced; the row is "${r.state}" with no record, the page shows "${v.why}" (needs you: ${v.needsYou}), Slack: ${/Zeffy has a record/.test(slackSaid()) ? 'says Zeffy has one' : 'never says Zeffy has one'}`);
});
// ── 9. B15b's annual pledge (promised online in May, to pay by check), but staff mark it paid in Zeffy when the check comes
//       in the mail, before Mercury posts it. Now it isn't pending, so the 13-month pledge read skips it, and it's older than
//       the 120 days read around the check: its card is sent as a new record, and the hourly look never sees the double ─
test('X9 a pay-by-check promise from May that staff marked paid when the check arrived is never saved a second time', async () => {
  world().payments.push(hand({ id: 'zp_pledge', type: 'online', status: 'succeeded', created: dayS('2026-05-20'), contact: 'c_pine',
    buyer: { first_name: 'Pine', last_name: 'Foundation', email: 'grants@pine.example.org', is_corporate: false, company_name: null } }));
  world().slack = [];
  // Zeffy's list honors ?status= (the spec's filter; the shared fake ignores it)
  const byStatus = async (input, init = {}) => {
    const url = new URL(String(typeof input === 'string' ? input : input.url));
    const status = url.searchParams.get('status');
    if (url.hostname === 'api.zeffy.com' && url.pathname.endsWith('/payments') && (init.method || 'GET') === 'GET' && status) {
      const all = world().payments;
      world().payments = all.filter((p) => String(p.status) === status);
      try { return await fakeFetch(input, init); } finally { world().payments = all; }
    }
    return fakeFetch(input, init);
  };
  const go = (t) => CG.runChecks(env(), { now: t, fetchImpl: byStatus });
  await go(NOW); post(); await go(NOW + 10 * MIN);
  for (let h = 1; h <= 3; h++) await go(NOW + 10 * MIN + h * 61 * MIN);
  // A person sends the card as it's filled in
  const sent = await approveWith(env(), byStatus, TX, { now: NOW + 10 * MIN + 3 * 61 * MIN + MIN }).then((x) => x.result, (e) => e.message);
  const r = await rowOf();
  assert.deepEqual({ posts: world().posts.length }, { posts: 0 },
    `two $10,000 gifts in Zeffy for one check (the paid promise and the record Send made: "${sent}", row "${r.state}"), and Slack ${/twice/.test(slackSaid()) ? 'flagged it' : 'never flagged it'}`);
});
// ── 10. S1b's residual: the hourly look keeps a check waiting on a person for 150 days, and a stale check reaches 180 days
//        before its deposit, plus the 120-day look back: 450 days, past what Zeffy reads whole at F8b's volume ───────────
test('X10 a stale check left with a person since June never stops the hourly look for this week\'s check', async () => {
  busyYear();
  await env().DB.prepare(`INSERT INTO check_gifts (id, cents, state, reason, status, payer, check_date, deposited_at, posted_at, final, created_at, updated_at)
    VALUES ('tx_june', 50000, 'person', 'event', 'sent', 'Oak Trust', '2025-12-01', '2026-06-23T15:00:00Z', '2026-06-25T15:00:00Z', 1, 'x', 'x')`).run();
  await posted();
  assert.equal((await rowOf()).state, 'person');
  world().payments.push(hand({ id: 'zp_pine', created: dayS('2026-11-08') }));
  await CG.maybeRunChecks(env(), { now: NOW + 2 * 60 * MIN, fetchImpl: fakeFetch });
  const st = await readState(env().DB, 'check-gifts');
  assert.deepEqual({ state: (await rowOf()).state, failing: st.matchFailing?.error || null }, { state: 'linked', failing: null });
});

// ── 11. A donor named Chase reads as a bank: the check is a cashier's check with no remitter, so nobody wrote it ─────
test('X11 minor: a personal check from Chase and Lauren Whitfield is read as theirs, not as a bank\'s', () => {
  const r = read({ payer: 'Chase and Lauren Whitfield' });
  const out = CG.proveRead([r, r], { cents: 1000000, checkNumber: '1042' });
  assert.deepEqual({ ok: out.ok, payer: out.payer || null }, { ok: true, payer: 'Chase and Lauren Whitfield' }, `read as ${JSON.stringify(out)}`);
});
