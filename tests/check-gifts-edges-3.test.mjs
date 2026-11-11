/**
 * Races, a stuck queue, stale checks and a slow Zeffy: a fourth break-it round on Nov 7 2026, against the spec-faithful fake
 * in tests/lib/check-gifts-harness-2.mjs. Each test failed before its fix. Names are made up.
 * Run: node --test tests/check-gifts-edges-3.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { W, CG, setup, run, rowOf, post, posted, fakeFetch, hand, read, txn, mirrorTransaction, readState, writeState, noEmailGiver, tagged, slackSaid, approve, card, NOW, MIN, DAY, dayS, TX } from './lib/check-gifts-harness-2.mjs';
import { READERS } from '../functions/api/_score-scans.js';

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

// ── 1. One giver's contact that Zeffy won't clear holds up every other donor's check, silently ────────────────────
test('R1 a no-mail address Zeffy won\'t take off one giver\'s contact never stops other donors\' checks', async () => {
  await noEmailGiver();
  // A save last week left the address on Pine's contact, and Zeffy refuses to clear it (any lasting refusal does this)
  const stuck = CG.tagFor('old', NOW - 7 * DAY);
  world().contacts.c_pine.email = stuck;
  await env().DB.prepare('INSERT INTO check_tags (contact, email, check_id, at) VALUES (?, ?, ?, ?)').bind('c_pine', stuck, 'old', new Date(NOW - 7 * DAY).toISOString()).run();
  world().fail = ({ method, path, body }) => (method === 'PATCH' && path === '/contacts/c_pine' && body?.email === null ? 400 : null);
  // Pine's check (the oldest) and, a few minutes later, a first-time giver's $2,500 check, both posted
  post();
  await addCheck('tx_2', { amount: 2500, checkNumber: '2001', createdAt: '2026-11-05T15:30:00Z', status: 'sent', postedAt: '2026-11-07T15:00:00Z' });
  const readings = { tx_1: read(), tx_2: read({ payer: 'Maple Builders', amount: 2500, checkNumber: '2001' }) };
  let reading = 'tx_1';
  env().AI.run = async () => ({ response: readings[reading] });
  await run(NOW);                         // tx_1 read
  reading = 'tx_2';
  // Twelve days of heartbeats, one run every 30 minutes
  for (let t = NOW + 30 * MIN; t < NOW + 12 * DAY; t += 30 * MIN) await run(t).catch(() => null);
  const end = NOW + 12 * DAY;
  // A person sends both cards: Pine's can't go in while its contact holds the address, and Maple's goes in all the same
  const pineSend = await approve(TX, { now: end }).then((x) => x.result, (e) => e.message);
  const mapleSend = await approve('tx_2', { now: end + MIN }).then((x) => x.result, (e) => e.message);
  const maple = await rowOf('tx_2');
  const said = slackSaid();
  assert.ok(maple.zeffy_id || /2,500/.test(said),
    `twelve days on, Maple Builders' $2,500 check is "${maple.state}" with no record (its Send answered "${mapleSend}"; Pine's "${pineSend}") and nothing in Slack about it; Pine's is "${(await rowOf()).state}"`);
});

// ── 1b. The same with Zeffy failing reads of one contact: the check stays 'read' forever, no alarm ───────────────
test('R1b a check whose giver\'s contact Zeffy keeps failing to read reaches a person, and doesn\'t hold up the others', async () => {
  await noEmailGiver();
  world().fail = ({ method, path }) => (method === 'GET' && path === '/contacts/c_pine' ? 500 : null);
  post();
  await addCheck('tx_2', { amount: 2500, checkNumber: '2001', createdAt: '2026-11-05T15:30:00Z', status: 'sent', postedAt: '2026-11-07T15:00:00Z' });
  const readings = { tx_1: read(), tx_2: read({ payer: 'Maple Builders', amount: 2500, checkNumber: '2001' }) };
  let reading = 'tx_1';
  env().AI.run = async () => ({ response: readings[reading] });
  await run(NOW);
  reading = 'tx_2';
  for (let t = NOW + 30 * MIN; t < NOW + 12 * DAY; t += 30 * MIN) await run(t).catch(() => null);
  const pine = await rowOf();
  // A person sends Maple's card: Pine's check never holds it up
  await approve('tx_2', { now: NOW + 12 * DAY }).catch(() => null);
  const maple = await rowOf('tx_2');
  const st = await readState(env().DB, 'check-gifts');
  assert.deepEqual({ pineSeen: pine.state === 'person' || /10,000/.test(slackSaid()) || !!st.lastError, mapleDone: !!maple.zeffy_id },
    { pineSeen: true, mapleDone: true },
    `12 days: Pine "${pine.state}" (no person, no Slack, lastError ${JSON.stringify(st.lastError)}), Maple "${maple.state}"`);
});

// ── 2. The write test's backdated record, when its POST times out after saving, is left in Zeffy in the afternoon ─
async function joinTestTimesOut(at) {
  await writeState(env().DB, 'check-gifts', { writeTest: { id: 'older', ok: true, steps: [{ what: 'two names' }], sameContact: true, provenAt: 'x' } });
  // Zeffy saves the record filed by the address, but the answer never comes back
  world().fail = ({ method, path, body }) => (method === 'POST' && path === '/payments' && /@nomail\./.test(body?.email || '') ? 'timeout-after' : null);
  const r = await run(at);
  return { report: r.writeTest, left: world().payments.filter((p) => p.amount === 100).map((p) => p.id), contacts: Object.values(world().contacts).filter((c) => c.last_name === 'WebsiteTest').length };
}
test('R2 control: a write test run at 10 AM Eastern finds and removes its timed-out record', async () => {
  const { left } = await joinTestTimesOut(Date.parse('2026-11-10T15:00:00Z'));
  assert.deepEqual(left, []);
});
test('R2 a write test run at 3 PM Eastern whose filed-by-address POST times out after saving leaves nothing, or says so', async () => {
  const { report, left, contacts } = await joinTestTimesOut(Date.parse('2026-11-10T20:00:00Z'));
  assert.ok(!left.length || report.leftBehind?.length,
    `a $1 SOARD WebsiteTest record (${left.join(', ')}) and ${contacts} test contact stay in Zeffy, and the report says removed=${report.removed}, leftBehind=${JSON.stringify(report.leftBehind)}: the page shows no notice`);
});

// ── 3. "Don't send to Zeffy" pressed while a heartbeat is making the check's card: the card overwrote it ─────────────
test('R3 a person\'s "Don\'t send to Zeffy" made while the site makes the check\'s card stands, and nothing is ever sent', async () => {
  await run(NOW);                                     // read while pending
  post();
  let pressed = null;
  world().hook = async ({ method, path }) => {
    if (method === 'GET' && path === '/payments') {
      world().hook = null;
      pressed = await CG.personDontSend(env(), TX, { reason: 'refund', saw: 'read', by: 'staff@soard', now: NOW + 10 * MIN }).then((r) => r.result, (e) => e.message);
    }
  };
  await run(NOW + 10 * MIN);                          // makes its card, the press lands mid-way
  assert.equal(pressed, 'left-out');
  const mid = await rowOf();
  for (let i = 1; i <= 3; i++) await run(NOW + 10 * MIN + i * 10 * MIN);
  const r = await rowOf();
  assert.deepEqual({ state: r.state, posts: world().posts.length }, { state: 'left-out', posts: 0 },
    `the press was answered "Left out", then the row became "${mid.state}" and ${world().posts.length} record(s) were made for a check a person said isn't for Zeffy`);
});

// ── 4. "This is the check" pressed while the hourly look runs: the link is overwritten and a second record is made ──
test('R4 a person matching a check to its entry while the hourly look runs never ends with two records for it', async () => {
  await run(NOW);
  post();
  // The trustee's hand entry, typed the day the check was dated: a possible double, put to a person
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-11-03'), buyer: { first_name: 'Dana', last_name: 'Lee', email: null, is_corporate: false, company_name: null } }));
  await run(NOW + 10 * MIN);
  const asked = await rowOf();
  assert.deepEqual({ state: asked.state, reason: asked.reason }, { state: 'person', reason: 'maybe-double' });
  // The card as a second screen still shows it
  const open = await card();
  // The hourly look starts; while it reads Zeffy the person presses "This is the check"
  let linked = null;
  world().hook = async ({ method, path }) => {
    if (method === 'GET' && path === '/payments') {
      world().hook = null;
      linked = await CG.personLink(env(), TX, 'zp_dana', { saw: 'person', by: 'staff@soard', now: NOW + 70 * MIN, fetchImpl: fakeFetch }).then((r) => r.result, (e) => e.message);
    }
  };
  await run(NOW + 70 * MIN);
  assert.equal(linked, 'linked');
  for (let i = 1; i <= 3; i++) await run(NOW + 70 * MIN + i * 10 * MIN);
  // Someone on the screen opened before the match presses Send to Zeffy on the card it still shows
  const stale = await CG.personSend(env(), TX, { name: open.card.name, donor: open.card.donor || 'new', formId: open.card.formId, day: open.card.day, saw: open.ver, by: 'other@soard', now: NOW + 2 * 60 * MIN, fetchImpl: fakeFetch }).then((x) => x.result, (e) => e.status);
  assert.equal(stale, 409);
  const r = await rowOf();
  assert.deepEqual({ state: r.state, zeffy: r.zeffy_id, posts: world().posts.length }, { state: 'linked', zeffy: 'zp_dana', posts: 0 },
    `the person's match was answered "linked", then the check ended "${r.state}" on ${r.zeffy_id} with ${world().posts.length} new record(s): the hand entry and a second record for one check`);
});

// ── 3b. "Don't send to Zeffy" pressed on a new deposit while the readers look at it (about 20 seconds) ─────────────
test('R3b a person\'s "Don\'t send to Zeffy" on a new deposit, pressed while its picture is being read, stands', async () => {
  post();
  let pressed = null;
  let first = true;
  env().AI.run = async () => {
    if (first) {
      first = false;
      pressed = await CG.personDontSend(env(), TX, { reason: 'refund', saw: 'new', by: 'staff@soard', now: NOW }).then((r) => r.result, (e) => e.message);
    }
    return { response: world().reading };
  };
  await run(NOW);                                     // reads it; the press lands while the readers work
  assert.equal(pressed, 'left-out');
  const mid = await rowOf();
  for (let i = 1; i <= 3; i++) await run(NOW + i * 10 * MIN);
  const r = await rowOf();
  assert.deepEqual({ state: r.state, posts: world().posts.length }, { state: 'left-out', posts: 0 },
    `the press was answered "Left out", the read then set the row to "${mid.state}", and ${world().posts.length} record(s) were made for a check a person said isn't for Zeffy`);
});

// ── 5. A sure hand entry isn't linked because another donor's check of the same amount could also be it ─────────
test('R5 a hand entry typed under the check\'s own name links itself, even when another donor\'s check that week has the same amount', async () => {
  // Two $10,000 checks deposited the same morning: Pine Foundation's and Oak Trust's, both dated Nov 3
  await addCheck('tx_2', { checkNumber: '2001', createdAt: '2026-11-05T15:05:00Z' });
  const readings = { tx_1: read(), tx_2: read({ payer: 'Oak Trust', checkNumber: '2001' }) };
  let reading = 'tx_1';
  env().AI.run = async () => ({ response: readings[reading] });
  await run(NOW);
  reading = 'tx_2';
  await run(NOW + 10 * MIN);
  post(); post('tx_2');
  await run(NOW + 20 * MIN);
  await run(NOW + 30 * MIN);
  // Both read, and each on its card for a person
  assert.deepEqual([(await rowOf()).state, (await rowOf('tx_2')).state], ['person', 'person']);
  // Staff type Pine's check by hand, under Pine Foundation, dated the day on the check
  world().payments.push(hand({ id: 'zp_pine', created: dayS('2026-11-03') }));
  await run(NOW + 90 * MIN);                          // the hourly look
  const pine = await rowOf();
  const oak = await rowOf('tx_2');
  const v = await CG.checksView(env());
  assert.deepEqual({ pine: pine.state, pineOn: pine.zeffy_id }, { pine: 'linked', pineOn: 'zp_pine' },
    `Pine's own entry, under Pine's own name, wasn't linked: Pine is "${pine.state}" (${pine.reason}), Oak is "${oak.state}" (${oak.reason}), ${v.waiting} in Needs you`);
});

// ── 6. Suspected: Zeffy files the gift under a new contact holding the address; nothing takes it off that one ──────
test('R6 suspected: if Zeffy files the gift under a new contact holding the no-mail address, the address doesn\'t stay there', async () => {
  await noEmailGiver();
  // Zeffy's find-by-email misses the address it was just given (a second contact gets it), the way a lagging index would
  world().hook = async ({ method, path, body }) => {
    if (method === 'POST' && path === '/payments' && /@nomail\./.test(body?.email || '')) {
      world().hook = null;
      world().contacts.ct_dup = { id: 'ct_dup', email: body.email, first_name: body.first_name, last_name: body.last_name, donation_count: 0 };
      world().contacts.c_pine.email = null;
    }
  };
  await posted();
  const sent = await approve(TX, { now: NOW + 15 * MIN }).then((x) => x.result, (e) => e.message);   // a person sends it, on Pine's own contact
  assert.equal(sent, 'created');
  const r = await rowOf();
  const learned = await env().DB.prepare("SELECT contact_id FROM check_payers WHERE key = 'pine foundation'").first();
  assert.deepEqual({ tagged: tagged().map((c) => c.id), learned: learned.contact_id }, { tagged: [], learned: 'c_pine' },
    `row ${r.state}; a contact keeps the no-mail address with no row to take it off, and the giver is learned as that new contact`);
});

// ── 4b. The entry on the card is another check's; the person sends it while the hourly look remakes the card: two records
test('R4b a person\'s Send made while the hourly look runs never leads to the same check saved again', async () => {
  await run(NOW);
  post();
  // A hand entry under another name, dated with the check: put to a person
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-11-03'), buyer: { first_name: 'Dana', last_name: 'Lee', email: null, is_corporate: false, company_name: null } }));
  await run(NOW + 10 * MIN);
  assert.equal((await rowOf()).reason, 'maybe-double');
  // That entry turns out to be another check's (Dana Lee's own $10,000 check, matched by a person)
  await env().DB.prepare(`INSERT INTO check_gifts (id, cents, state, status, payer, zeffy_id, deposited_at, posted_at, final, created_at, updated_at) VALUES ('tx_dana', 1000000, 'linked', 'sent', 'Dana Lee', 'zp_dana', '2026-11-04T15:00:00Z', '2026-11-06T15:00:00Z', 0, 'x', 'x')`).run();
  const v = await card();
  assert.ok(v.card, 'the check waits on its card');
  // The person sends it, while the hourly look is reading Zeffy
  let saved = null;
  world().hook = async ({ method, path }) => {
    if (method === 'GET' && path === '/payments') {
      world().hook = null;
      saved = await approve(TX, { name: 'Pine Foundation', formId: 'form_home', by: 'staff@soard', now: NOW + 70 * MIN }).then((r) => r.result, (e) => e.message);
    }
  };
  await run(NOW + 70 * MIN);
  assert.equal(saved, 'created');
  for (let i = 1; i <= 3; i++) await run(NOW + 70 * MIN + i * 10 * MIN);
  const mine = world().payments.filter((p) => p.amount === 1000000 && p.id !== 'zp_dana');
  assert.deepEqual(mine.map((p) => p.id).length, 1,
    `one $10,000 check, ${mine.length} records the site made: ${mine.map((p) => p.id).join(', ')}; the row holds ${(await rowOf()).zeffy_id}, so the other is nobody's`);
});

// ── 7. "Not this entry" on an unread check forgets a different giver's contact ────────────────────────────────────
test('R7 taking a wrong entry off a check nobody could read never forgets what the site knew about that entry\'s giver', async () => {
  // Pine Foundation is known: its contact, from earlier checks
  await noEmailGiver();
  await run(NOW);
  post();
  // This check couldn't be read; a person matched it to a Pine Foundation entry, then saw it was wrong
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'unreadable', status = 'sent', payer = NULL, drawer = NULL, posted_at = '2026-11-07T15:00:00Z' WHERE id = ?`).bind(TX).run();
  world().payments.push(hand({ id: 'zp_pine_other', created: dayS('2026-11-04'), contact: 'c_pine' }));
  await CG.personLink(env(), TX, 'zp_pine_other', { saw: 'person', now: NOW + 5 * MIN, fetchImpl: fakeFetch });
  await CG.personUnlink(env(), TX, { saw: 'linked', now: NOW + 6 * MIN });
  const learned = await env().DB.prepare("SELECT contact_id FROM check_payers WHERE key = 'pine foundation'").first();
  assert.equal(learned?.contact_id, 'c_pine', 'Pine Foundation\'s contact is forgotten, so its next check makes a second Pine contact');
});

// ── 8. A person's save dated with an old check's own date, whose answer never came, is saved twice ──────────────────
test('R8 a person\'s save dated five months back (the date on a stale check) whose answer never came is found, not asked for again', async () => {
  await run(NOW);
  post();
  // A check written in June and mailed in November; its memo says gala, so it waits for a person, who saves it
  await env().DB.prepare(`UPDATE check_gifts SET state = 'person', reason = 'event', status = 'sent', payer = 'Pine Foundation', check_date = '2026-06-01', posted_at = '2026-11-07T15:00:00Z' WHERE id = ?`).bind(TX).run();
  // The page fills in the date on the check (it's before the deposit), and Zeffy saves it but its answer never comes
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  const first = await approve(TX, { name: 'Pine Foundation', donor: 'new', formId: 'form_home', day: '2026-06-01', now: NOW }).then((r) => r.result, (e) => e.message);
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  for (let t = NOW + 6 * MIN; t <= NOW + 50 * MIN; t += 6 * MIN) await run(t);
  const r = await rowOf();
  // The page then says: "the record hasn't shown up. If it isn't in Zeffy, send it again", and the person does
  let second = null;
  if (r.state === 'person') second = await approve(TX, { name: 'Pine Foundation', donor: 'new', formId: 'form_home', day: '2026-06-01', now: NOW + 55 * MIN }).then((x) => x.result, (e) => e.message);
  assert.equal(world().payments.filter((p) => p.amount === 1000000).length, 1,
    `the first save is in Zeffy, the row went to "${r.state}" (${r.reason}) and the second save answered "${second}": two $10,000 records for one check`);
});

// ── 10. A picture both readers fail on (every time) keeps its check "Not read yet" forever ─────────────────────────
test('R10 a check whose picture makes both readers fail every time reaches a person, while the other checks go on', async () => {
  post();
  await addCheck('tx_2', { amount: 2500, checkNumber: '2001', createdAt: '2026-11-05T15:30:00Z', status: 'sent', postedAt: '2026-11-07T15:00:00Z',
    attachments: [{ fileName: 'front.jpg', url: 'https://files.mercury.test/maple.jpg', attachmentType: 'checkImage' }] });
  // tx_1's picture is one both models choke on (too large for them, or they time out on it); Maple's reads fine
  const BIG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 2, 3, 255, 217]);
  const fetchImpl = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url === 'https://files.mercury.test/front.jpg') return new Response(BIG, { status: 200 });
    return fakeFetch(input, init);
  };
  const bigImage = `data:image/jpeg;base64,${Buffer.from(BIG).toString('base64')}`;
  env().AI.run = async (model, args) => {
    const img = args.messages[1].content[1].image_url.url;
    if (img === bigImage) throw new Error('image too large');
    return { response: read({ payer: 'Maple Builders', amount: 2500, checkNumber: '2001' }) };
  };
  for (let t = NOW; t < NOW + 8 * DAY; t += 30 * MIN) await CG.runChecks(env(), { now: t, fetchImpl }).catch(() => null);
  // Maple's card is sent by a person: the check Pine's picture holds up still goes on
  await approve('tx_2', { now: NOW + 8 * DAY }).catch(() => null);
  const pine = await rowOf();
  const maple = await rowOf('tx_2');
  const v = (await CG.checksView(env())).list.find((c) => c.id === TX);
  assert.deepEqual({ pine: pine.state, needsYou: v.needsYou, maple: maple.state }, { pine: 'person', needsYou: true, maple: 'created' },
    `eight days on, the $10,000 check is "${pine.state}" (tries ${pine.tries}), shown as "${v.why || 'Not read yet'}"; nobody is asked and nothing can be sent from the page; Maple's is "${maple.state}"`);
});

// ── 11. A person says "a different gift" about an entry, saves, and an hour later Slack asks about that same entry ──
test('R11 an entry a person called a different gift when sending is never raised as a double of that check', async () => {
  await run(NOW);
  post();
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-11-03'), buyer: { first_name: 'Dana', last_name: 'Lee', email: null, is_corporate: false, company_name: null } }));
  await run(NOW + 10 * MIN);
  const asked = await rowOf();
  assert.equal(asked.reason, 'maybe-double');
  // The person looks at Dana Lee's entry and says this check is a different gift
  const r = await approve(TX, { name: 'Pine Foundation', formId: 'form_home', notThose: true, shown: ['zp_dana'], now: NOW + 20 * MIN });
  assert.equal(r.result, 'created');
  world().slack = [];
  for (let h = 1; h <= 3; h++) await run(NOW + 20 * MIN + h * 61 * MIN);
  assert.doesNotMatch(slackSaid(), /twice/, 'Slack: "This check may be in Zeffy twice ... under Dana Lee", about the entry the person just said is another gift');
});

// ── 6b. A slow POST that Zeffy finishes after the site already took the address off: a new contact keeps it ───────
test('R6b a filed-by-address POST that Zeffy finishes after its answer timed out never leaves a contact holding the address', async () => {
  await noEmailGiver();
  let late = null;
  // Zeffy is slow: the site gives up on the POST at 15 seconds, takes the address off, and Zeffy finishes the POST after that
  world().fail = ({ method, path, body }) => {
    if (method === 'POST' && path === '/payments' && /@nomail\./.test(body?.email || '') && !late) { late = body; return 'timeout'; }
    return null;
  };
  await posted();
  const sent = await approve(TX, { now: NOW + 10 * MIN }).then((x) => x.result, (e) => e.message);
  assert.match(sent, /don’t send this one again/);
  assert.equal((await rowOf()).state, 'unsure');
  // (the site leaves the address on while Zeffy may still be saving)
  // Zeffy completes the POST it was still working on
  world().fail = null;
  await fakeFetch('https://api.zeffy.com/api/v1/payments', { method: 'POST', body: JSON.stringify(late) });
  for (let i = 1; i <= 8; i++) await run(NOW + 10 * MIN + i * 6 * MIN);
  const r = await rowOf();
  const gift = world().payments.find((p) => p.id === r.zeffy_id);
  assert.deepEqual({ tagged: tagged().map((c) => `${c.id} ${c.email}`), on: gift?.contact }, { tagged: [], on: 'c_pine' },
    `row ${r.state}: the gift went onto a new contact made for the address, which keeps it for good`);
});

// ── 12. One of the two readers gone for good (a model retired): every check is "couldn't read", nobody told why ───
test('R12 one reader that errors on every call is said as a reader outage, not as checks nobody could read', async () => {
  post();
  const [gone] = Object.keys(CG ? READERS : {});
  env().AI.run = async (model) => {
    if (model === gone) throw new Error('5007: No such model');
    return { response: world().reading };
  };
  for (let i = 0; i < 6; i++) await run(NOW + i * 6 * MIN).catch(() => null);
  const r = await rowOf();
  const st = await readState(env().DB, 'check-gifts');
  assert.ok(r.state !== 'person' || r.reason !== 'unreadable' || st.lastError,
    `a clear $10,000 check from Pine Foundation went to a person as "${CG.REASONS[r.reason]}" after ${r.tries} tries, and nothing says a reader is down (lastError ${JSON.stringify(st.lastError)})`);
});

// ── 8b. A stale check (written in June, deposited in November) typed by hand with the date on the check ────────────
test('R8b a stale check staff typed by hand with the date written on it is matched, never saved a second time when its card is sent', async () => {
  world().reading = read({ date: '2026-06-01' });
  await posted();                                      // read, posted Nov 7: on its card
  assert.equal((await rowOf()).state, 'person');
  // Staff enter it as they always do, backdated to the check's date (Zeffy stamps it noon UTC)
  world().payments.push(hand({ id: 'zp_pine_june', created: dayS('2026-06-01') }));
  world().slack = [];
  let t = NOW + 30 * MIN;
  for (; t < Date.parse('2026-11-19T16:00:00Z'); t += 61 * MIN) await run(t);
  const before = await rowOf();
  const said = slackSaid();
  // A person who never saw it link presses Send to Zeffy on its card
  const sent = before.state === 'person' ? await approve(TX, { now: t }).then((x) => x.result, (e) => e.message) : null;
  for (let i = 0; i < 4; i++, t += 6 * MIN) await run(t);
  const r = await rowOf();
  assert.deepEqual({ linked: r.zeffy_id, posts: world().posts.length }, { linked: 'zp_pine_june', posts: 0 },
    `the hand entry was never matched (row "${before.state}"${/still waiting/.test(said) ? ', and Slack said "This check posted more than 10 days ago and its card is still waiting"' : ''}); Send answered "${sent}" and saved a second $10,000 record (row "${r.state}")`);
});
