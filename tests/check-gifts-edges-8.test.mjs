/**
 * A break-it round on the approval rebuild (Nov 10 2026): multi-step sequences across runs and presses, against
 * tests/lib/check-gifts-harness-2.mjs (Zeffy as its spec says: POST /payments finds or makes the contact by email, PATCH
 * changes only what it's given). Each B test failed before its fix; each control is the same steps without the one thing
 * the bug needed, and held all along. Names, emails and addresses are made up. Run: node --test tests/check-gifts-edges-8.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, run, rowOf, post, posted, fakeFetch, hand, read, txn, mirrorTransaction, readState, writeState, noEmailGiver, tagged, slackSaid, NOW, MIN, DAY, dayS, TX } = await import('./lib/check-gifts-harness-2.mjs');
const { approveWith, cardOf } = await import('./lib/check-gifts-approve.mjs');

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
const env = () => W.env;
const world = () => W.world;
const approve = (id, over = {}) => approveWith(env(), over.fetchImpl || fakeFetch, id, { now: NOW, ...over });
const quiet = (now) => run(now).catch((e) => ({ error: e.message }));
async function runs(from, to, step = 6 * MIN) { let t = from; for (; t <= to; t += step) await quiet(t); return t; }
/** Addresses go on donors only once the write test's address step passed */
async function addressesOn() {
  const cfg = await readState(env().DB, 'check-gifts');
  await writeState(env().DB, 'check-gifts', { writeTest: { ...cfg.writeTest, address: { ok: true } } });
}
/** Replace the one deposit with another shape of it (dates, status), mirrored as the webhook would */
async function deposit(o) {
  world().txns[TX] = txn(o);
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
}
const addCheck = async (id, o = {}) => {
  world().txns[id] = txn({ id, ...o });
  await mirrorTransaction(env().DB, world().txns[id], { now: NOW });
};
const OAK = { street: '12 Oak St', city: 'Roswell', state: 'GA', zip: '30075' };
const ELM = { line1: '9 Elm St', city: 'Alpharetta', state: 'GA', postal_code: '30009', country: 'US' };

beforeEach(() => setup());

// ── 1. A date typed a year back (allowed: up to 366 days before the deposit) on a check deposited two months ago, and
//       Zeffy saves it but its answer never comes. settleUnsure reads Zeffy only 400 days back, so it never sees the record
//       it is looking for; the card goes back to the person saying "if it isn't in Zeffy, send it again", and Send's own
//       read is clamped to the same 400 days. The second press makes a second record for one check ──────────────────────
test('B1 a year-back date on an unanswered save never leads to a second record for the same check', async () => {
  await deposit({ createdAt: '2026-09-15T15:00:00Z', status: 'sent', postedAt: '2026-09-17T15:00:00Z' });
  world().reading = read({ date: '2026-09-12' });
  await runs(NOW, NOW + 6 * MIN);
  assert.equal((await rowOf()).state, 'person');
  // The person slips on the year (2025 for 2026); Zeffy saves it, and the answer is lost
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  const first = await approve(TX, { day: '2025-09-16', now: NOW + 10 * MIN }).then((x) => x.result, (e) => e.message);
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  assert.equal(world().payments.filter((p) => p.amount === 1000000).length, 1, 'Zeffy has the record');
  let t = await runs(NOW + 15 * MIN, NOW + 130 * MIN);
  const back = await rowOf();
  // The card is back with the person; they fix the date and press Send, as the card tells them to
  const second = back.state === 'person' ? await approve(TX, { now: t }).then((x) => x.result, (e) => e.message) : `not on a card ("${back.state}")`;
  const records = world().payments.filter((p) => p.amount === 1000000);
  assert.equal(records.length, 1,
    `one $10,000 check, ${records.length} Zeffy records (${records.map((p) => new Date(p.created * 1000).toISOString().slice(0, 10)).join(', ')}): after the lost answer the row went "${back.state}" (${back.reason}), and the second Send answered "${second}"`);
});

// ── 2. What a person chose on Send (the donor, the address) is kept on the row as `send`. When that record is later gone
//       (staff delete and retype it, under the fund's advisor) and the person matches the check to the retyped entry,
//       `send` is still the old plan: writeAddresses trusts it as "the record's donor, by that person's word" and writes
//       Pine Foundation's check address onto the advisor's own contact, over the address she has ───────────────────────
test('B2 an old Send\'s address never goes on the contact of a different entry the check is matched to later', async () => {
  await addressesOn();
  world().reading = read({ ...OAK });
  await posted();
  const c = await cardOf(env(), TX);
  assert.equal(c.card.checkAddress?.line1, '12 Oak St');
  assert.equal((await approve(TX, { now: NOW + 10 * MIN })).result, 'created');
  let t = await runs(NOW + 15 * MIN, NOW + 30 * MIN);
  const sent = await rowOf();
  assert.equal(sent.address_done, 'written', 'Pine\'s address went on Pine\'s new contact');
  // Staff delete the record and type it again under the advisor who recommended the grant: her contact, her own address
  world().payments = world().payments.filter((p) => p.id !== sent.zeffy_id);
  world().contacts.ct_dana = { id: 'ct_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 4, address: { ...ELM } };
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-11-03'), contact: 'ct_dana', buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', is_corporate: false, company_name: null, address: { ...ELM } } }));
  t = await runs(t, t + 130 * MIN);
  const gone = await rowOf();
  assert.equal(gone.state, 'person', `the record is gone, so the check is back on a card (it's "${gone.state}")`);
  const v = await cardOf(env(), TX);
  assert.ok((v.candidates || []).some((x) => x.id === 'zp_dana'), 'the retyped entry is offered');
  // "This is the check"
  await CG.personLink(env(), TX, 'zp_dana', { saw: v.ver, by: 'staff@example.com', now: t, fetchImpl: fakeFetch });
  await runs(t + 6 * MIN, t + 40 * MIN);
  const r = await rowOf();
  assert.deepEqual(world().contacts.ct_dana.address, ELM,
    `Dana Whitfield's own contact now has ${JSON.stringify(world().contacts.ct_dana.address)} (Pine Foundation's check address), written as "${r.address_done}" from the earlier Send's plan ${r.send}`);
});

// ── 3. A send Zeffy saved but never answered, and before settleUnsure finds it, Mercury turns the check down. lookAgain
//       makes it 'came-back' with no record, so settleUnsure (which only looks at 'unsure' and 'creating') never looks for it
//       again: the record for money that never came stays in Zeffy, and Slack and the page say "Nothing to do in Zeffy" ──
test('B3 a check Mercury turns down while its send is unanswered still has its saved record found, and is told to cancel it', async () => {
  // Read and carded while Mercury still has it pending
  await runs(NOW, NOW + 6 * MIN);
  assert.equal((await rowOf()).state, 'person');
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  await approve(TX, { now: NOW + 10 * MIN }).catch(() => null);
  world().fail = null;
  assert.equal((await rowOf()).state, 'unsure');
  const saved = world().payments.find((p) => p.amount === 1000000);
  assert.ok(saved, 'Zeffy saved it');
  // Mercury's review turns the check down
  world().txns[TX] = { ...world().txns[TX], status: 'failed' };
  world().slack = [];
  await runs(NOW + 15 * MIN, NOW + 200 * MIN);
  const r = await rowOf();
  const v = await cardOf(env(), TX);
  assert.deepEqual({ zeffy: r.zeffy_id, toDo: v.toDo }, { zeffy: saved.id, toDo: true },
    `the check is "${r.state}" with no record (zeffy_id ${r.zeffy_id}) while ${saved.id} for ${CG.money(saved.amount)} sits in Zeffy; the page says "${v.why}" and Slack said ${/Nothing to do in Zeffy/.test(slackSaid()) ? '"Nothing to do in Zeffy"' : 'something else'}`);
});

// ── 4. The "same check deposited again" note looks only at check number and amount, never at who wrote it. Check numbers
//       are per checkbook: two donors' $100 checks numbered 1042 a few weeks apart make the second donor's card say
//       "redeposit" first, with Don't send ("The same check deposited again") pre-picked, and Send shows the other donor's
//       record as "may be this check" ───────────────────────────────────────────────────────────────────────────────────
test('B4 another donor\'s check that happens to share a check number and amount is not called a redeposit', async () => {
  // Pine Foundation's $100 check #1042, sent to Zeffy
  await deposit({ amount: 100 });
  world().reading = read({ amount: 100 });
  await posted();
  assert.equal((await approve(TX, { now: NOW + 10 * MIN })).result, 'created');
  // Two weeks on, a different giver's $100 check from her own checkbook, also numbered 1042
  const later = Date.parse('2026-11-24T16:00:00Z');
  await addCheck('tx_2', { amount: 100, createdAt: '2026-11-23T15:00:00Z', status: 'sent', postedAt: '2026-11-24T14:00:00Z' });
  world().reading = read({ payer: 'Marisol Ortega', amount: 100, date: '2026-11-20', street: '5 Birch Ln', city: 'Decatur', state: 'GA', zip: '30030' });
  await runs(later, later + 12 * MIN);
  const c = await cardOf(env(), 'tx_2');
  assert.equal(c.state, 'person');
  const kinds = c.card.notes.map((n) => n.kind);
  const pressed = await approve('tx_2', { now: later + 15 * MIN }).then((x) => x.result, (e) => `${e.message} [${(e.entries || []).map((x) => x.name).join(', ')}]`);
  assert.deepEqual({ first: kinds[0] || null, suggest: c.card.suggest, dont: c.card.dontReason }, { first: null, suggest: 'send', dont: null },
    `Marisol Ortega's own $100 check opens with "${kinds[0]}" (${c.card.notes[0]?.text}) and "${c.card.suggest}" suggested as "${c.card.dontReason}"; Send answers "${pressed}". Pine Foundation wrote the other #1042`);
});

// ── 5. What a person typed as the name is written with the claim (keep), but not as their answer (by). When Zeffy never
//       answers and the check comes back to its card, the next refresh takes the name off the check again: the card now
//       says Pine Foundation, and pressing Send "again" as the card says sends it under a name the person had corrected ──
test('B5 a name a person typed on a send Zeffy never answered stands when the card comes back', async () => {
  world().reading = read({ memo: 'In honor of the Whitfield family' });
  await posted();
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout' : null);
  const first = await approve(TX, { name: 'Dana Whitfield', now: NOW + 10 * MIN }).then((x) => x.result, (e) => e.message);
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  assert.equal(world().payments.length, 0, 'Zeffy saved nothing');
  await runs(NOW + 15 * MIN, NOW + 150 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  assert.equal(r.state, 'person');
  assert.equal(c.card.name, 'Dana Whitfield',
    `the person typed Dana Whitfield and pressed Send; Zeffy never answered, and the card that came back says "${c.card.name}" (row payer "${r.payer}", by ${r.by})`);
});

// ── 6. Race between the run's writeAddresses and a person's Send on the same no-email donor. personSend reads the donor's
//       contact (no email) and decides to file by the no-mail address; before postJoined puts it on, the run writes the
//       email another of this donor's checks was sent with. postJoined never looks again: its PATCH replaces the real email
//       with the no-mail address, and clearTag then empties it. The donor's email is gone, and the row says it was written ─
test('B6 a donor\'s email written by the run while a Send files under the same donor is never wiped', async () => {
  await addressesOn();
  await noEmailGiver();
  // Pine's November check, and its December one
  let k = 0;
  env().AI.run = async () => ({ response: k++ < 2 ? read() : read({ amount: 2500, checkNumber: '1043', date: '2026-11-22' }) });
  post();
  await runs(NOW, NOW + 6 * MIN);
  assert.equal((await rowOf()).state, 'person');
  const dec = Date.parse('2026-11-25T16:00:00Z');
  await addCheck('tx_2', { amount: 2500, checkNumber: '1043', createdAt: '2026-11-24T15:00:00Z', status: 'sent', postedAt: '2026-11-25T14:00:00Z' });
  await runs(dec, dec + 12 * MIN);
  assert.equal((await rowOf('tx_2')).state, 'person');
  // November's is sent on Pine's contact with the email the foundation gave, to go on the donor after
  assert.equal((await approve(TX, { email: 'office@example.com', now: dec + 20 * MIN })).result, 'created');
  // December's Send starts; the run's address step lands between its read of the contact and its filing
  let raced = null;
  const racing = async (input, init = {}) => {
    const res = await fakeFetch(input, init);
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!raced && (init.method || 'GET') === 'GET' && url.pathname.endsWith('/contacts/c_pine')) {
      raced = await CG.writeAddresses(env(), { now: dec + 21 * MIN, fetchImpl: fakeFetch, cfg: await readState(env().DB, 'check-gifts') });
    }
    return res;
  };
  const sent = await approve('tx_2', { now: dec + 21 * MIN, fetchImpl: racing }).then((x) => x.result, (e) => e.message);
  await runs(dec + 27 * MIN, dec + 60 * MIN);
  const nov = await rowOf();
  assert.equal(raced?.result, 'email', 'the run wrote November\'s email onto Pine\'s contact');
  assert.equal(world().contacts.c_pine.email, 'office@example.com',
    `Pine Foundation's contact has email ${world().contacts.c_pine.email} after December's Send ("${sent}"): its email went ${world().patches.filter((x) => x.id === 'c_pine' && 'email' in x).map((x) => x.email).join(' → ')}; November's row says "${nov.address_done}" and nothing writes it again`);
});

// ── 7. Zeffy's contact filter matches "the contact's primary or secondary email address", and Zeffy finds a contact by
//       email the same way (PUT /contacts says so). Send's check for "another donor already has this email" keeps only
//       contacts whose primary email is it, so a household email on another donor's contact as a second address passes,
//       and Zeffy files the new gift under that other donor ────────────────────────────────────────────────────────────
test('B7 an email another donor holds as a second address never files a new donor\'s gift under them', async () => {
  world().reading = read({ payer: 'Dana Whitfield' });
  await posted();
  world().contacts.ct_sam = { id: 'ct_sam', email: 'sam@example.com', secondary: ['whitfields@example.com'], first_name: 'Sam', last_name: 'Whitfield', donation_count: 6 };
  // Zeffy as its spec reads: the filter and the lookup by email match a primary or a secondary address
  const holder = (mail) => Object.values(world().contacts).find((c) => String(c.email || '').toLowerCase() === mail || (c.secondary || []).includes(mail));
  const spec = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    if (url.hostname === 'api.zeffy.com' && method === 'GET' && url.pathname.endsWith('/contacts') && url.searchParams.get('email')) {
      const c = holder(url.searchParams.get('email').toLowerCase());
      return new Response(JSON.stringify({ data: c ? [c] : [], has_more: false, next_cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname === 'api.zeffy.com' && method === 'POST' && url.pathname.endsWith('/payments')) {
      const body = JSON.parse(init.body);
      const c = body.email ? holder(String(body.email).toLowerCase()) : null;
      if (c && c.email !== body.email) return fakeFetch(input, { ...init, body: JSON.stringify({ ...body, email: c.email }) });
    }
    return fakeFetch(input, init);
  };
  const said = await approve(TX, { donor: 'new', email: 'whitfields@example.com', now: NOW + 10 * MIN, fetchImpl: spec }).then((x) => x.result, (e) => e.message);
  const p = world().payments.find((x) => x.amount === 1000000);
  assert.notEqual(p?.contact, 'ct_sam',
    `Dana Whitfield's $10,000 gift was filed under Sam Whitfield's contact (Send answered "${said}"), because Sam holds whitfields@example.com as a second address`);
});

// The readers answer a letter's prompt with world().letter, a check's with world().reading
const LETTER = { fileName: 'letter.jpg', url: 'https://files.mercury.test/letter.jpg', attachmentType: 'other' };
function lettersToo() {
  world().letter = { aboutGift: true, recordAs: 'Dana Whitfield', email: 'dana@example.com', street: '40 Pine Rd', city: 'Marietta', state: 'GA', zip: '30062', amount: 10000 };
  env().AI = {
    run: async (model, input) => {
      world().aiCalls++;
      const isLetter = String(input?.messages?.[0]?.content || '').startsWith('You read one page');
      return { response: isLetter ? world().letter : world().reading };
    },
  };
}
const attach = (...more) => { world().txns[TX] = { ...world().txns[TX], attachments: [...world().txns[TX].attachments, ...more] }; };

// ── 8. A person pressed Send on the card as it was filled in (the check's name) and was shown an entry first: that press
//       writes the name as the person's answer (by). The letter attached in Mercury afterwards, the source of truth for whose
//       gift it is, is read, but the card made again with it keeps the check's name as "who it's from" ───────────────────
test('B8 a letter attached after a person was asked about an entry still decides who the gift is from on the card', async () => {
  lettersToo();
  // Another giver's $10,000 entry the same day: the card asks about it
  world().payments.push(hand({ id: 'zp_other', created: dayS('2026-11-03'), contact: 'ct_oak', buyer: { first_name: 'Oakline', last_name: 'Builders', email: null, is_corporate: false, company_name: null } }));
  // Still pending in Mercury, so each run reads the deposit again (a posted one is read once a day)
  await runs(NOW, NOW + 6 * MIN);
  assert.equal((await rowOf()).reason, 'maybe-double');
  // The person presses Send as the card is filled in; the site shows the entry first
  await assert.rejects(approve(TX, { now: NOW + 10 * MIN }), /may be this check/);
  // Then the team attaches the foundation's letter in Mercury: the gift is Dana Whitfield's, through her family fund
  attach(LETTER);
  await runs(NOW + 15 * MIN, NOW + 150 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  assert.equal(JSON.parse(r.letter).name, 'Dana Whitfield', 'the letter was read');
  assert.equal(c.card.name, 'Dana Whitfield',
    `the letter says the gift is Dana Whitfield's, and the card still says it's from "${c.card.name}" (the name it had when the person was shown the entry, by ${r.by})`);
});

// ── 9. A person fills in the email (and address) on the card and presses Send; Zeffy has had the check typed by hand since
//       the card was made, so Send matches it instead of sending. That's right, but what the person typed goes nowhere: no
//       `send` plan is kept for a match, and the hand entry's donor never gets the email ─────────────────────────────────
test('B9 the email a person typed on Send still goes on the donor when Send finds the check typed by hand and matches it', async () => {
  await addressesOn();
  await posted();
  assert.equal((await rowOf()).state, 'person');
  // Typed by hand in Zeffy a minute ago, under Pine's own contact (no email on it)
  world().contacts.ct_pine = { id: 'ct_pine', email: null, first_name: 'Pine', last_name: 'Foundation', donation_count: 2 };
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-03'), contact: 'ct_pine' }));
  const said = await approve(TX, { email: 'office@example.com', now: NOW + 10 * MIN }).then((x) => x.result, (e) => e.message);
  assert.equal(said, 'linked');
  await runs(NOW + 15 * MIN, NOW + 60 * MIN);
  const r = await rowOf();
  assert.equal(world().contacts.ct_pine.email, 'office@example.com',
    `the person typed office@example.com and pressed Send; the site matched the hand entry ("${said}") and the email never reached Pine's contact (address step "${r.address_done}", send ${r.send})`);
});

// ── 10. postJoined notes the no-mail address before it goes on the donor's contact, so a run cut off anywhere still takes it
//        off (clearTags). But when Zeffy files the record under a new contact after all (the case the code handles: "Filed
//        under a new contact after all"), the new contact holds the address too, and that copy is taken off once, with no
//        note: one Zeffy 503 there, or a run cut off right after the POST, and it stays on that contact for good, unsaid ──
test('B10 the no-mail address never stays on a new contact Zeffy filed the record under', async () => {
  await noEmailGiver();
  await posted();
  let failedOnce = false;
  const json = (b, status) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const lagging = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    if (url.hostname === 'api.zeffy.com' && method === 'POST' && url.pathname.endsWith('/payments') && /@nomail\./.test(JSON.parse(init.body).email || '')) {
      // Zeffy's lookup by email doesn't find the address just put on Pine's contact: it makes a contact holding it
      const held = world().contacts.c_pine.email;
      world().contacts.c_pine.email = null;
      try { return await fakeFetch(input, init); } finally { world().contacts.c_pine.email = held; }
    }
    if (url.hostname === 'api.zeffy.com' && method === 'PATCH' && /\/contacts\/ct_new_/.test(url.pathname) && !failedOnce) { failedOnce = true; return json({ error: { message: 'Service Unavailable' } }, 503); }
    return fakeFetch(input, init);
  };
  const said = await approve(TX, { now: NOW + 10 * MIN, fetchImpl: lagging }).then((x) => x.result, (e) => e.message);
  world().slack = [];
  await runs(NOW + 15 * MIN, NOW + 15 * MIN + DAY + 2 * 60 * MIN, 60 * MIN);
  const left = tagged();
  const notes = (await env().DB.prepare('SELECT COUNT(*) AS n FROM check_tags').first()).n;
  assert.deepEqual(left.map((c) => c.id), [],
    `a day on, ${left.map((c) => `${c.id} holds ${c.email}`).join('; ')} (Send answered "${said}"); check_tags has ${notes} rows and Slack said ${/no-mail/.test(slackSaid()) ? 'so' : 'nothing'}`);
});

// ── 11. A donor-advised fund's check with its letter: the letter says the gift is Dana Whitfield's (her first), and the card
//        says so. But the Zeffy donors offered are looked up under every name, the check writer's too, and "sure" is any
//        contact under any of them: Fidelity Charitable's own contact (from a grant staff typed last spring) is the only
//        sure one, so the card starts on it. Sent as filled in, Dana's gift goes on the fund's contact, under its names ───
test('B11 a letter\'s donor new to Zeffy never starts on the check writer\'s contact as the Zeffy donor', async () => {
  lettersToo();
  world().reading = read({ payer: 'Fidelity Charitable', memo: 'Grant ID per letter' });
  world().contacts.ct_fid = { id: 'ct_fid', email: 'grants@example.com', first_name: 'Fidelity', last_name: 'Charitable', donation_count: 1 };
  world().payments.push(hand({ id: 'zp_spring', amount: 50000, created: dayS('2026-04-20'), contact: 'ct_fid', buyer: { first_name: 'Fidelity', last_name: 'Charitable', email: 'grants@example.com', is_corporate: false, company_name: null } }));
  attach(LETTER);
  await runs(NOW, NOW + 24 * MIN);
  const c = await cardOf(env(), TX);
  assert.equal(c.state, 'person');
  assert.equal(c.card.name, 'Dana Whitfield', 'the letter decides who it is from');
  const said = await approve(TX, { now: NOW + 30 * MIN }).then((x) => x.result, (e) => e.message);
  const p = world().payments.find((x) => x.amount === 1000000);
  assert.ok(c.card.donor !== 'ct_fid' && p?.contact !== 'ct_fid',
    `Dana Whitfield's card starts on donor "${c.card.donor}" (${c.card.donors.map((d) => `${d.id} ${d.name}${d.sure ? ' sure' : ''}`).join(', ')}); sent as filled in ("${said}"), the gift is on ${p?.contact} as ${p?.buyer?.first_name} ${p?.buyer?.last_name}`);
});

// ── 12. A check nobody could read: the name is the person's to type. The first name they try is written as payer with
//        their answer (by); the next refresh takes checkName(row) (drawer, else payer) as "who wrote the check" and saves it
//        as drawer. When they then correct the name, the card shows "Check from <the first name>", and the name list labels
//        it "on the check", though nothing was ever read off the check ──────────────────────────────────────────────────
test('B12 a name a person typed on an unreadable check is never shown as the name on the check', async () => {
  world().reading = read({ payer: '' });
  // Someone else's $10,000 entry near the deposit: each Send asks about it first
  world().payments.push(hand({ id: 'zp_near', created: dayS('2026-11-05'), contact: 'ct_oak', buyer: { first_name: 'Oakline', last_name: 'Builders', email: null, is_corporate: false, company_name: null } }));
  post();
  await runs(NOW, NOW + 30 * MIN);
  const first = await rowOf();
  assert.deepEqual([first.state, first.reason, first.drawer], ['person', 'unreadable', null]);
  await assert.rejects(approve(TX, { name: 'Dana Whitfield', now: NOW + 35 * MIN }), /may be this check/);
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null });
  await runs(NOW + 40 * MIN, NOW + 50 * MIN);
  // On a second look the person corrects it
  await assert.rejects(approve(TX, { name: 'Marcus Lee', now: NOW + 55 * MIN }), /may be this check/);
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null });
  await runs(NOW + 60 * MIN, NOW + 70 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  assert.deepEqual({ drawer: c.drawer, onCheck: c.card.names.filter((n) => n.from === 'check').map((n) => n.name) }, { drawer: null, onCheck: [] },
    `the check was never read, and its card says "Check from ${c.drawer}" with ${JSON.stringify(c.card.names)} (row drawer "${r.drawer}", payer "${r.payer}")`);
});

// ── 13. Most cards wait on a person after Mercury has posted the check. A posted deposit is read from Mercury again only once
//        a day (pull), and the hourly refresh of a waiting card (matchOpen → prepareCard with `shared`) skips the letter
//        look. So a letter the team attaches while the card waits isn't read for up to a day: the card keeps saying the gift
//        is the check writer's, with the check's address, and "Don't send" goes through without the letter being read ─────
test('B13 a letter attached while a posted check\'s card waits is read within the hour, as it is for a pending one', async () => {
  lettersToo();
  await posted();
  assert.equal((await rowOf()).state, 'person');
  attach(LETTER);
  await runs(NOW + 15 * MIN, NOW + 3 * 60 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  const l = JSON.parse(r.letter || '{}');
  assert.equal(c.card.name, 'Dana Whitfield',
    `three hours after the letter was attached, the card still says "${c.card.name}" (letter files ${JSON.stringify(l.files || [])}, pending ${JSON.stringify(l.pending || [])}; Mercury read again at ${r.looked_at})`);
});

// ─── Passing controls: the same sequences with the one condition each finding hinges on taken away. These pass ──────────
test('control: B1 without the 400-day edge: a recent deposit\'s year-back unanswered save is found, never saved twice', async () => {
  world().reading = read({ date: '2026-11-03' });
  await posted();
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  await approve(TX, { day: '2025-11-07', now: NOW + 10 * MIN }).catch(() => null);
  world().fail = null;
  await runs(NOW + 15 * MIN, NOW + 130 * MIN);
  const r = await rowOf();
  assert.equal(r.state, 'created');
  assert.equal(world().payments.filter((p) => p.amount === 1000000).length, 1);
});

test('control: B2 without an earlier Send: matching the check to the advisor\'s entry leaves her address alone', async () => {
  await addressesOn();
  world().reading = read({ ...OAK });
  world().contacts.ct_dana = { id: 'ct_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 4, address: { ...ELM } };
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-11-03'), contact: 'ct_dana', buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', is_corporate: false, company_name: null, address: { ...ELM } } }));
  await posted();
  const v = await cardOf(env(), TX);
  await CG.personLink(env(), TX, 'zp_dana', { saw: v.ver, by: 'staff@example.com', now: NOW + 10 * MIN, fetchImpl: fakeFetch });
  await runs(NOW + 15 * MIN, NOW + 50 * MIN);
  assert.deepEqual(world().contacts.ct_dana.address, ELM);
  assert.equal((await rowOf()).address_done, 'not-theirs');
});

test('control: B4 the same giver\'s same check deposited again is called a redeposit', async () => {
  await deposit({ amount: 100 });
  world().reading = read({ amount: 100 });
  await posted();
  assert.equal((await approve(TX, { now: NOW + 10 * MIN })).result, 'created');
  const later = Date.parse('2026-11-24T16:00:00Z');
  await addCheck('tx_2', { amount: 100, createdAt: '2026-11-23T15:00:00Z', status: 'sent', postedAt: '2026-11-24T14:00:00Z' });
  await runs(later, later + 12 * MIN);
  const c = await cardOf(env(), 'tx_2');
  assert.equal(c.card.notes[0]?.kind, 'redeposit');
  assert.equal(c.card.suggest, 'dont');
});

test('control: B11 with no letter, a fund\'s check starts on the fund\'s own contact', async () => {
  world().reading = read({ payer: 'Fidelity Charitable' });
  world().contacts.ct_fid = { id: 'ct_fid', email: 'grants@example.com', first_name: 'Fidelity', last_name: 'Charitable', donation_count: 1 };
  world().payments.push(hand({ id: 'zp_spring', amount: 50000, created: dayS('2026-04-20'), contact: 'ct_fid', buyer: { first_name: 'Fidelity', last_name: 'Charitable', email: 'grants@example.com', is_corporate: false, company_name: null } }));
  await posted();
  const c = await cardOf(env(), TX);
  assert.equal(c.card.name, 'Fidelity Charitable');
  assert.equal(c.card.donor, 'ct_fid');
});

test('control: B13 on a pending deposit: the letter attached while the card waits is read and the card made again', async () => {
  lettersToo();
  await runs(NOW, NOW + 6 * MIN);
  assert.equal((await rowOf()).state, 'person');
  attach(LETTER);
  await runs(NOW + 15 * MIN, NOW + 60 * MIN);
  assert.equal((await cardOf(env(), TX)).card.name, 'Dana Whitfield');
});
