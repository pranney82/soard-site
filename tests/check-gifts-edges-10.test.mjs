/**
 * Break-it round 10 on Checks into Zeffy (Nov 10 2026): multi-step sequences across runs and presses, against
 * tests/lib/check-gifts-harness-2.mjs (Zeffy as its spec says: POST /payments finds or makes the contact by email, PATCH
 * changes only what it's given). Each D test failed before its fix, with the bad outcome in its message; each "control:"
 * test is the same steps without the one thing the bug needed, and held all along. Names, emails and addresses are made up.
 * Run: node --test tests/check-gifts-edges-10.test.mjs
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
const said = (p) => p.then((x) => x.result, (e) => e.message);
const quiet = (now) => run(now).catch((e) => ({ error: e.message }));
async function runs(from, to, step = 6 * MIN) { let t = from; for (; t <= to; t += step) await quiet(t); return t; }
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const isZeffy = (input, init, method, tail) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  return url.hostname === 'api.zeffy.com' && (init.method || 'GET') === method && url.pathname.endsWith(tail);
};
const learnedOf = (name) => env().DB.prepare('SELECT * FROM check_payers WHERE key = ?').bind(CG.payerKey(name)).first();
async function addressesOn() {
  const cfg = await readState(env().DB, 'check-gifts');
  await writeState(env().DB, 'check-gifts', { writeTest: { ...cfg.writeTest, address: { ok: true } } });
}

beforeEach(() => setup());

// ── D1. A fund's grant last spring was typed under "Pine Foundation" with the advisor's email, so Zeffy filed it on Dana
//        Whitfield's own contact. confirmDonors drops that contact from the foundation's next card by reading the contact's own
//        name, but when Zeffy doesn't answer about it (a 503 or 429 while the card is made) it keeps the contact "for" the
//        payment's typed name, and personSend's donor guard trusts the card's `for` (sameName). Zeffy answering again by the
//        time the person presses Send, the guard passes: the foundation's $10,000 goes in under Dana Whitfield, with her names,
//        and the site learns Pine Foundation as her contact ──────────────────────────────────────────────────────────────────
const DANA = { id: 'ct_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 1 };
const springGrant = () => hand({ id: 'zp_spring', amount: 500000, created: dayS('2026-03-02'), contact: 'ct_dana', campaign_id: 'form_grant', description: 'Grant Funding 2026',
  buyer: { first_name: 'Pine', last_name: 'Foundation', email: 'dana@example.com', is_corporate: false, company_name: null, address: null } });

test('D1 a fund\'s check never goes in under its advisor\'s contact because Zeffy was slow while its card was made', async () => {
  world().contacts.ct_dana = { ...DANA };
  world().payments.push(springGrant());
  await run(NOW);
  post();
  // The card is made while Zeffy is slow about this one contact
  world().fail = ({ method, path }) => (method === 'GET' && path === '/contacts/ct_dana' ? 503 : null);
  await run(NOW + 10 * MIN);
  world().fail = null;
  const c = await cardOf(env(), TX);
  assert.equal(c.state, 'person');
  const listed = c.card.donors.find((d) => d.id === 'ct_dana');
  assert.ok(listed, 'the advisor\'s contact is on the card, as Zeffy\'s answer about it never came');
  // The person picks the one Zeffy donor listed under the foundation's name, and Zeffy answers now
  const sent = await said(approve(TX, { donor: 'ct_dana', now: NOW + 20 * MIN }));
  const p = world().payments.find((x) => x.amount === 1000000);
  const learned = await learnedOf('Pine Foundation');
  assert.ok(!p,
    `Pine Foundation's $10,000 check went in under Dana Whitfield's contact: the card listed ct_dana as "${listed.name}" for ${JSON.stringify(listed.for)}, Send answered "${sent}", the record is on ${p?.contact} as ${p?.buyer?.first_name} ${p?.buyer?.last_name}, and the site now learns Pine Foundation as contact ${learned?.contact_id}`);
});

// ── D1b. The same stale "for" through personSend's typed-name lookup: the check couldn't be read, the person types "Pine
//         Foundation" and presses Send with New donor. Zeffy is slow about Dana's contact just then, so it's added to the card
//         `added`, "for" the typed name, as found under the payment's name. prepareCard keeps every added donor its own look
//         doesn't find, so when Zeffy answers again and the hourly look sees whose contact it is, it still stays, still "for"
//         Pine Foundation, and Send files the foundation's gift under Dana Whitfield ──────────────────────────────────────────
test('D1b a contact added to a card while Zeffy was slow is never trusted as the typed name\'s donor once Zeffy says whose it is', async () => {
  world().contacts.ct_dana = { ...DANA };
  world().payments.push(springGrant());
  world().reading = read({ payer: '' });
  await run(NOW);
  post();
  await runs(NOW + 6 * MIN, NOW + 40 * MIN);
  const k = await cardOf(env(), TX);
  assert.deepEqual([k.state, k.card.name], ['person', ''], 'nobody could read who wrote it');
  world().fail = ({ method, path }) => (method === 'GET' && path === '/contacts/ct_dana' ? 503 : null);
  const typed = await said(approve(TX, { name: 'Pine Foundation', donor: 'new', now: NOW + 45 * MIN }));
  world().fail = null;
  assert.match(typed, /Zeffy already has a donor named Pine Foundation/);
  // Hours of hourly looks with Zeffy answering about everyone
  await runs(NOW + 50 * MIN, NOW + 4 * 60 * MIN, 30 * MIN);
  const c = await cardOf(env(), TX);
  const listed = c.card.donors.find((d) => d.id === 'ct_dana');
  const sent = listed ? await said(approve(TX, { name: 'Pine Foundation', donor: 'ct_dana', now: NOW + 4 * 60 * MIN + MIN })) : 'not offered';
  const p = world().payments.find((x) => x.amount === 1000000);
  assert.ok(!p,
    `three hours after Zeffy answered again, the card still offers ct_dana as "${listed?.name}" for ${JSON.stringify(listed?.for)}; Send with it answered "${sent}" and Pine Foundation's $10,000 is on ${p?.contact} as ${p?.buyer?.first_name} ${p?.buyer?.last_name}`);
});

test('control: D1 with Zeffy answering while the card is made, the advisor\'s contact is never offered, and Send refuses it', async () => {
  world().contacts.ct_dana = { ...DANA };
  world().payments.push(springGrant());
  await posted();
  const c = await cardOf(env(), TX);
  assert.ok(!c.card.donors.some((d) => d.id === 'ct_dana'));
  assert.match(await said(approve(TX, { donor: 'ct_dana', now: NOW + 20 * MIN })), /That Zeffy donor is Dana Whitfield/);
  assert.equal(world().payments.filter((x) => x.amount === 1000000).length, 0);
});

// ── D2. A Send cut off while its POST is out (the request killed mid-call) leaves the row 'creating', which settleUnsure takes
//        up only once its updated_at is two minutes old. But a check Mercury still has pending is read from Mercury on every
//        run (pull: final = 0 and status != 'sent'), and lookAgain's last write has no guard and stamps updated_at each time,
//        just before settleUnsure looks. Cards are sent while checks are pending (it takes up to 5 business days), so this
//        one stays 'creating' for as long as Mercury holds it: its saved record is never claimed, nobody can act on the card
//        ("Zeffy hasn't answered"), and for a donor with no email the no-mail address stays on their contact all that time ─
/** Press Send and let the request die once its POST /payments has reached Zeffy (saved: Zeffy kept it) */
async function cutOffSend(id, { saved = true, now } = {}) {
  let reached;
  const atPost = new Promise((r) => { reached = r; });
  const dying = async (input, init = {}) => {
    if (isZeffy(input, init, 'POST', '/payments')) {
      if (saved) await fakeFetch(input, init);
      reached();
      return new Promise(() => {}); // the Worker is gone: no answer ever comes back to it
    }
    return fakeFetch(input, init);
  };
  approve(id, { now, fetchImpl: dying }).catch(() => null);
  await atPost;
}

test('D2 a no-email donor\'s Send cut off mid-POST while Mercury has the check pending is settled, and the no-mail address comes off', async () => {
  await noEmailGiver();
  // Read and carded while Mercury still holds it, the way most checks are
  await runs(NOW, NOW + 6 * MIN);
  assert.equal((await rowOf()).state, 'person');
  await cutOffSend(TX, { now: NOW + 10 * MIN });
  assert.equal((await rowOf()).state, 'creating');
  assert.equal(tagged().map((c) => c.id).join(), 'c_pine', 'the no-mail address is on the donor while the POST is out');
  // Three days of runs, every 30 minutes, Mercury still reviewing it
  await runs(NOW + 15 * MIN, NOW + 3 * DAY, 30 * MIN);
  const r = await rowOf();
  const saved = world().payments.find((p) => p.amount === 1000000);
  // A colleague tries to settle it by hand: Don't send ("already in Zeffy")
  const press = await said(CG.personDontSend(env(), TX, { reason: 'already', by: 'other@example.com', now: NOW + 3 * DAY + MIN }));
  assert.deepEqual({ state: r.state, tagged: tagged().map((c) => c.id) }, { state: 'created', tagged: [] },
    `three days after the cut-off, Zeffy holds ${saved?.id} for it on ${saved?.contact}, yet the check is still "${r.state}" (updated_at ${r.updated_at}, stamped by every run's Mercury look), ${tagged().map((c) => `${c.id} holds ${c.email}`).join('; ') || 'no contact holds the tag'}, a person pressing Don't send is told "${press}", and Slack ${/no-mail/.test(slackSaid()) ? 'was told about the address' : 'said nothing about the address'}`);
});

test('D2b a Send cut off before Zeffy saved anything, on a pending check, comes back to a person within the hour', async () => {
  await runs(NOW, NOW + 6 * MIN);
  assert.equal((await rowOf()).state, 'person');
  await cutOffSend(TX, { saved: false, now: NOW + 10 * MIN });
  await runs(NOW + 15 * MIN, NOW + 6 * 60 * MIN, 30 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  assert.deepEqual([r.state, r.reason], ['person', 'unsure'],
    `six hours after a Send cut off mid-POST (nothing saved), the pending check is "${r.state}" and its page says "${c.why}"`);
});

test('control: D2 the same cut-off Send on a check Mercury has posted is settled, and the no-mail address comes off', async () => {
  await noEmailGiver();
  await posted();
  assert.equal((await rowOf()).state, 'person');
  await cutOffSend(TX, { now: NOW + 20 * MIN });
  await runs(NOW + 25 * MIN, NOW + 3 * 60 * MIN, 30 * MIN);
  assert.equal((await rowOf()).state, 'created');
  assert.deepEqual(tagged().map((c) => c.id), []);
});

// ── D3. Zeffy saves the record and answers 500 with its own error code. createRecord takes that as "nothing saved": it keeps
//        the payload (so the next Send looks for it first) but puts back `undo`, which wipes `send`, the donor, address and
//        email the person chose. The page says "Zeffy is busy, so nothing was sent. Try again in a minute"; the person does,
//        with the same card, findSent finds the record and settles it, and the address they typed is never put on the donor:
//        the second press's own choices are never looked at either ────────────────────────────────────────────────────────────
const TYPED = { line1: '40 Pine Rd', city: 'Marietta', state: 'GA', postal_code: '30062' };
const savedThen500 = async (input, init = {}) => {
  if (isZeffy(input, init, 'POST', '/payments')) {
    await fakeFetch(input, init);
    return json({ error: { code: 'internal_server_error', message: 'Internal server error' } }, 500);
  }
  return fakeFetch(input, init);
};

test('D3 the address a person typed on a Send that Zeffy saved but answered 500 still goes on the donor once the record is found', async () => {
  await addressesOn();
  await posted();
  const first = await said(approve(TX, { address: TYPED, now: NOW + 10 * MIN, fetchImpl: savedThen500 }));
  assert.match(first, /don’t send this one again/); // a 500 may have saved: since Nov 11 the site looks for it, as for no answer
  const between = await rowOf();
  // As the page says: again, a minute later, the same card
  const second = await said(approve(TX, { address: TYPED, now: NOW + 12 * MIN }));
  await runs(NOW + 15 * MIN, NOW + 75 * MIN);
  const r = await rowOf();
  const p = world().payments.find((x) => x.amount === 1000000);
  const onDonor = world().contacts[p?.contact]?.address || null;
  assert.equal(onDonor?.line1, TYPED.line1,
    `the person typed 40 Pine Rd for the donor; the first Send answered "${first}" (row's send after it: ${between.send}), the second "${second}"; the record ${p?.id} is "${r.state}" with send ${r.send} and address_done "${r.address_done}", and the donor's contact ${p?.contact} has address ${JSON.stringify(onDonor)} (PATCHes: ${JSON.stringify(world().patches.filter((x) => x.id === p?.contact))})`);
});

test('control: D3 the same typed address on a Send Zeffy answers at once goes on the donor', async () => {
  await addressesOn();
  await posted();
  assert.equal(await said(approve(TX, { address: TYPED, now: NOW + 10 * MIN })), 'created');
  await runs(NOW + 15 * MIN, NOW + 75 * MIN);
  const p = world().payments.find((x) => x.amount === 1000000);
  assert.equal(world().contacts[p.contact]?.address?.line1, TYPED.line1);
});

// ── D4. A Send Zeffy didn't answer, and whose record only shows up in Zeffy's list after the 30 minutes settleUnsure gives it
//        (the card is back with the person as "unsure", payload and `send` kept). The next look to see it is the hourly one:
//        prepareCard matches it by itself as a hand entry (linkTo, no send, no by), which writes send = null over the
//        person's choices and calls the site's own record "typed by hand". The address the person typed never goes on ──────
test('D4 a Send\'s record that Zeffy shows late is still the person\'s send: its typed address goes on and it isn\'t called a hand entry', async () => {
  await addressesOn();
  await posted();
  let body = null;
  world().fail = ({ method, path, body: b }) => (method === 'POST' && path === '/payments' ? ((body = b), 'timeout') : null);
  const first = await said(approve(TX, { address: TYPED, now: NOW + 10 * MIN }));
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  await runs(NOW + 15 * MIN, NOW + 50 * MIN);
  const waiting = await rowOf();
  assert.deepEqual([waiting.state, waiting.reason], ['person', 'unsure']);
  assert.ok(JSON.parse(waiting.send).address, 'the person\'s choices are kept while the card waits');
  // Zeffy's list now shows the record that POST saved, dated as it was sent
  await fakeFetch('https://api.zeffy.com/api/v1/payments', { method: 'POST', body: JSON.stringify(body) });
  await runs(NOW + 75 * MIN, NOW + 3 * 60 * MIN);
  const r = await rowOf();
  const p = world().payments.find((x) => x.amount === 1000000);
  const onDonor = world().contacts[p?.contact]?.address || null;
  assert.deepEqual({ via: r.via, by: r.by, line1: onDonor?.line1 || null }, { via: 'person', by: 'staff@example.com', line1: TYPED.line1 },
    `the record the person's Send made (${p?.id}) is "${r.state}" via "${r.via}" by ${r.by}, send ${r.send}, address_done "${r.address_done}", and the donor's contact has address ${JSON.stringify(onDonor)}`);
});

test('control: D4 the same unanswered Send whose record shows within the 30 minutes is settled as the person\'s, address and all', async () => {
  await addressesOn();
  await posted();
  let body = null;
  world().fail = ({ method, path, body: b }) => (method === 'POST' && path === '/payments' ? ((body = b), 'timeout') : null);
  await approve(TX, { address: TYPED, now: NOW + 10 * MIN }).catch(() => null);
  world().fail = null;
  await fakeFetch('https://api.zeffy.com/api/v1/payments', { method: 'POST', body: JSON.stringify(body) });
  await runs(NOW + 15 * MIN, NOW + 75 * MIN);
  const r = await rowOf();
  const p = world().payments.find((x) => x.amount === 1000000);
  assert.deepEqual([r.state, r.via, r.by], ['created', 'person', 'staff@example.com']);
  assert.equal(world().contacts[p.contact]?.address?.line1, TYPED.line1);
});

// ── D5. D3 and D4's path on a donor with no email (postJoined). Zeffy's lookup by the no-mail address misses (B10's premise:
//        it makes a contact of its own holding it), saves the record there, and answers 500 with its error code. createRecord
//        says "nothing was sent, try again in a minute". Within the hour prepareCard matches the record by itself (linkTo),
//        which, unlike settleFound and the came-back branch, never takes the no-mail address off a new contact the record
//        landed on; and writeAddresses only reads a contact when there's an address or email to put on. Nothing has a note
//        of that contact, so nothing ever takes it off, and nobody is told ───────────────────────────────────────────────────
test('D5 the no-mail address never stays on the contact Zeffy made for a no-email donor\'s Send it answered with a 500', async () => {
  await addressesOn();
  await noEmailGiver();
  await posted();
  assert.equal((await cardOf(env(), TX)).card.donor, 'c_pine');
  const lagging500 = async (input, init = {}) => {
    if (isZeffy(input, init, 'POST', '/payments') && /@nomail\./.test(JSON.parse(init.body).email || '')) {
      const held = world().contacts.c_pine.email;
      world().contacts.c_pine.email = null;
      try { await fakeFetch(input, init); } finally { world().contacts.c_pine.email = held; }
      return json({ error: { code: 'internal_server_error', message: 'Internal server error' } }, 500);
    }
    return fakeFetch(input, init);
  };
  const first = await said(approve(TX, { now: NOW + 10 * MIN, fetchImpl: lagging500 }));
  assert.match(first, /don’t send this one again/); // a 500 may have saved: since Nov 11 the site looks for it, as for no answer
  const saved = world().payments.find((p) => p.amount === 1000000);
  assert.ok(saved && saved.contact !== 'c_pine', 'Zeffy saved it, under a contact of its own');
  await runs(NOW + 15 * MIN, NOW + 15 * MIN + DAY + 60 * MIN, 30 * MIN);
  const r = await rowOf();
  const notes = (await env().DB.prepare('SELECT COUNT(*) AS n FROM check_tags').first()).n;
  assert.deepEqual(tagged().map((c) => c.id), [],
    `a day on, ${tagged().map((x) => `${x.id} holds ${x.email}`).join('; ')}; the check is "${r.state}" via "${r.via}" holding ${r.zeffy_id}, check_tags has ${notes} rows, and Slack said ${/no-mail/.test(slackSaid()) ? 'so' : 'nothing about it'}`);
});

test('control: D5 the same 500 with the person pressing Send again as told: the record is found and the address comes off', async () => {
  await addressesOn();
  await noEmailGiver();
  await posted();
  const lagging500 = async (input, init = {}) => {
    if (isZeffy(input, init, 'POST', '/payments') && /@nomail\./.test(JSON.parse(init.body).email || '')) {
      const held = world().contacts.c_pine.email;
      world().contacts.c_pine.email = null;
      try { await fakeFetch(input, init); } finally { world().contacts.c_pine.email = held; }
      return json({ error: { code: 'internal_server_error', message: 'Internal server error' } }, 500);
    }
    return fakeFetch(input, init);
  };
  await approve(TX, { now: NOW + 10 * MIN, fetchImpl: lagging500 }).catch(() => null);
  // (since Nov 11 a 500 is looked for, not sent again: a second press waits while the site looks)
  assert.match(await said(approve(TX, { now: NOW + 12 * MIN })), /No card to send|moved on/);
  await runs(NOW + 15 * MIN, NOW + 3 * 60 * MIN, 30 * MIN);
  assert.equal((await rowOf()).state, 'created');
  assert.deepEqual(tagged().map((c) => c.id), []);
  assert.equal(world().payments.filter((p) => p.amount === 1000000).length, 1);
});

// ── D6. Two Pine Foundation checks for $10,000 wait on cards (#1042 dated Nov 3, #1043 dated Nov 4), and staff type one hand
//        entry for $10,000 dated Nov 4. It fits both, so neither card takes it (contestedOf): each shows it as "Zeffy may
//        already have this check". On #1042's card the person says "It's a different gift" (notThose, shown: that entry) and
//        presses Send. personSend never asks whether an entry is contested: matchBoth calls it `same`, and the check is
//        matched to the very entry the person just said is another gift ─────────────────────────────────────────────────────
async function twoPineChecks() {
  world().txns.tx_2 = txn({ id: 'tx_2', checkNumber: '1043', createdAt: '2026-11-05T16:00:00Z', dashboardLink: 'https://app.mercury.com/transactions/tx_2' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: NOW });
  await run(NOW);                                  // #1042 read
  await run(NOW + 6 * MIN);                        // its card
  world().reading = read({ checkNumber: '1043', date: '2026-11-04' });
  await run(NOW + 12 * MIN);                       // #1043 read
  await run(NOW + 18 * MIN);                       // its card
  post(TX); post('tx_2');
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-04'), contact: 'ct_pine' }));
  await runs(NOW + 61 * MIN, NOW + 67 * MIN);      // the hourly look: the entry fits both
}

test('D6 "It\'s a different gift" on an entry two waiting checks fit never matches the check to that entry', async () => {
  await twoPineChecks();
  const a = await cardOf(env(), TX);
  const b = await cardOf(env(), 'tx_2');
  assert.deepEqual([a.state, b.state], ['person', 'person'], 'neither check took the entry by itself');
  assert.ok((a.candidates || []).some((x) => x.id === 'zp_typed') && (b.candidates || []).some((x) => x.id === 'zp_typed'), 'both cards show it');
  const sent = await said(approve(TX, { notThose: true, shown: ['zp_typed'], now: NOW + 70 * MIN }));
  const r = await rowOf();
  assert.notEqual(r.zeffy_id, 'zp_typed',
    `the person said zp_typed is a different gift and pressed Send on #1042; Send answered "${sent}", and #1042 is "${r.state}" holding ${r.zeffy_id} (rejected ${r.rejected}), the entry staff typed for #1043`);
});

test('control: D6 with one waiting check, the entry is its own and matches it by itself', async () => {
  await posted();
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-04'), contact: 'ct_pine' }));
  await runs(NOW + 61 * MIN, NOW + 67 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.zeffy_id], ['linked', 'zp_typed']);
});

// ── D7. minor: Zeffy refuses a Send (4xx) and the card says Zeffy's own reason ("Zeffy wouldn't take this amount."). The next
//        hourly look remakes the card (its notes now lead with the sticky "zeffy-refused") and writes note = null over the
//        refusal words, so the card falls back to "Zeffy didn't take this record when it was sent", with no reason ─────────
test('D7 minor: the reason Zeffy gave for refusing a Send is still on the card after the hourly look', async () => {
  await posted();
  const amountRefusal = async (input, init = {}) => (isZeffy(input, init, 'POST', '/payments')
    ? json({ error: { code: 'invalid_amount', message: 'amount must be positive' } }, 422) : fakeFetch(input, init));
  const first = await said(approve(TX, { now: NOW + 10 * MIN, fetchImpl: amountRefusal }));
  const right = (await cardOf(env(), TX)).why;
  assert.match(right, /wouldn’t take this amount/);
  await runs(NOW + 61 * MIN, NOW + 67 * MIN);
  const c = await cardOf(env(), TX);
  assert.equal(c.why, right, `Send answered "${first}" and the card said "${right}"; after the hourly look it says "${c.why}"`);
});

// ── D8. A check the site sent (record R1) comes back; before staff cancel R1, the same check is deposited again. The new
//        deposit's card matches R1 by itself (notesFor: a came-back twin lets a sure match link), and linkTo takes R1 off the
//        returned deposit and resolves its Slack card with "Don't cancel it". The person says the match isn't this check
//        (personUnlink): R1 comes off the new deposit, but it never goes back to the returned one. Now no check holds R1 and
//        nothing says to cancel it, the new deposit's card is "redeposit-back" (send it), and Send makes a second record ─────
test('D8 taking a redeposit off the returned check\'s record gives that record back, so it is cancelled rather than doubled', async () => {
  await posted();
  assert.equal(await said(approve(TX, { now: NOW + 10 * MIN })), 'created');
  const r1 = (await rowOf()).zeffy_id;
  // Nov 12: the bank returns it
  world().txns[TX] = { ...world().txns[TX], status: 'reversed' };
  let t = Date.parse('2026-11-12T16:00:00Z');
  await quiet(t);
  const back = await rowOf();
  assert.deepEqual([back.state, back.zeffy_id], ['came-back', r1]);
  assert.match((await cardOf(env(), TX)).why, /Cancel the record in Zeffy/);
  // Nov 14: the same paper check goes in again, before anyone cancels R1
  t = Date.parse('2026-11-14T16:00:00Z');
  world().txns.tx_2 = txn({ id: 'tx_2', createdAt: '2026-11-14T15:00:00Z', status: 'sent', postedAt: '2026-11-15T14:00:00Z', dashboardLink: 'https://app.mercury.com/transactions/tx_2' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: t });
  t = await runs(t, t + 20 * MIN);
  const took = await rowOf('tx_2');
  assert.deepEqual([took.state, took.zeffy_id], ['linked', r1], 'the redeposit took the returned check\'s record');
  // The person says that record isn't this deposit's
  await CG.personUnlink(env(), 'tx_2', { saw: (await cardOf(env(), 'tx_2')).ver, by: 'staff@example.com', now: t });
  t = await runs(t + 5 * MIN, t + 30 * MIN);
  const k = await cardOf(env(), 'tx_2');
  const sent = k.card ? await said(approve('tx_2', { now: t })) : `no card (${k.state})`;
  const first = await rowOf();
  const live = world().payments.filter((p) => p.amount === 1000000);
  assert.ok(first.zeffy_id === r1 || live.length === 1,
    `after the unlink the returned deposit holds ${first.zeffy_id} (page: "${(await cardOf(env(), TX)).why}"), the redeposit's card says ${k.card?.notes.map((n) => n.kind).join(', ')}, Send answered "${sent}", and Zeffy has ${live.length} records for the one $10,000 check (${live.map((p) => p.id).join(', ')}) with none of them marked to cancel`);
});

// ── D9. minor: a check deposited to the store's account is never read (state 'store' from its first row). "Send to Zeffy
//        after all" (personReopen) puts it straight to 'read', which readCheck never takes, so its card is made with no name
//        and says "The site couldn't read who wrote this check": the picture was never looked at ─────────────────────────
test('D9 minor: a store-account check brought back with "Send to Zeffy after all" is read before its card says it can\'t be', async () => {
  const { writeConfig } = await import('../functions/api/_spend.js');
  await env().DB.prepare('DELETE FROM check_gifts').run();
  await writeConfig(env().DB, { accountBuckets: { acct_check: 'store' } });
  await run(NOW);
  post();
  await run(NOW + 10 * MIN);
  assert.equal((await rowOf()).state, 'store');
  const before = await cardOf(env(), TX);
  assert.equal((await CG.personReopen(env(), TX, { saw: before.ver, by: 'staff@example.com', now: NOW + 15 * MIN })).result, 'reopened');
  await runs(NOW + 20 * MIN, NOW + 60 * MIN);
  const c = await cardOf(env(), TX);
  assert.equal(c.state, 'person');
  assert.deepEqual({ name: c.card.name, read: world().aiCalls > 0 }, { name: 'Pine Foundation', read: true },
    `the check's picture was read ${world().aiCalls} times; its card has name "${c.card.name}" and says: ${c.card.notes.map((n) => n.text).join(' / ')}`);
});

// ── D10. minor: a letter attached while a Send is unanswered ('unsure') is called "added to a check already in Zeffy"
//         (noteLetters counts 'unsure' as saved): Slack says so, and the file goes on the row's `late` list. Zeffy saved
//         nothing, so the card comes back, the letter is read and used, and the person sends it. `late` is never cleared when
//         the check went back to being decided, so the saved check's page says the file came after it went into Zeffy ──────
test('D10 minor: a letter read before the record was sent is never shown as "added after this check went into Zeffy"', async () => {
  world().letter = { aboutGift: true, recordAs: 'Pine Foundation', email: '', street: '', city: '', state: '', zip: '', amount: 10000 };
  env().AI = { run: async (model, input) => { world().aiCalls++; return { response: String(input?.messages?.[0]?.content || '').startsWith('You read one page') ? world().letter : world().reading }; } };
  // Carded while Mercury still has it pending (read again on every run)
  await runs(NOW, NOW + 6 * MIN);
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout' : null);
  await approve(TX, { now: NOW + 10 * MIN }).catch(() => null);
  world().fail = null;
  assert.equal((await rowOf()).state, 'unsure');
  world().txns[TX] = { ...world().txns[TX], attachments: [...world().txns[TX].attachments, { fileName: 'letter.jpg', url: 'https://files.mercury.test/letter.jpg', attachmentType: 'other' }] };
  // Wait: the record never shows; the card comes back and the letter is read
  await runs(NOW + 30 * MIN, NOW + 2 * 60 * MIN);
  const back = await cardOf(env(), TX);
  assert.equal(back.state, 'person');
  assert.equal(back.letter?.unread, 0, 'the letter was read for the card');
  assert.equal(await said(approve(TX, { now: NOW + 2 * 60 * MIN + MIN })), 'created');
  const c = await cardOf(env(), TX);
  assert.ok(!c.letter?.todo && !/already in Zeffy/.test(slackSaid()),
    `the letter was attached while Zeffy hadn't answered, then read and used before the record was made; the saved check's page says "${c.why}" (letter to-do ${c.letter?.todo}), and Slack said ${/already in Zeffy/.test(slackSaid()) ? '"A letter was added to a check already in Zeffy"' : 'nothing'}`);
});

// ── D11. Pine Foundation's check comes with its cover letter: "please send the acknowledgment to our program officer,
//         dana@example.com". The letter names no other donor (a foundation giving its own money is its own donor), so the
//         card treats the email as the check writer's (emailName = own). Zeffy has that email on Dana Whitfield's personal
//         contact (she gives too). confirmDonors ties her contact to "Pine Foundation" by the email, sure, so the card starts
//         on it by itself, and Send's guard passes it by that tie: the foundation's grant goes in under Dana Whitfield's
//         name, on her contact, and the site learns her contact as the foundation's ─────────────────────────────────────────
test('D11 a foundation\'s letter giving a staff member\'s email never makes that person\'s own Zeffy contact the gift\'s donor', async () => {
  world().letter = { aboutGift: true, recordAs: '', email: 'dana@example.com', street: '', city: '', state: '', zip: '', amount: 10000 };
  env().AI = { run: async (model, input) => { world().aiCalls++; return { response: String(input?.messages?.[0]?.content || '').startsWith('You read one page') ? world().letter : world().reading }; } };
  world().txns[TX] = { ...world().txns[TX], attachments: [...world().txns[TX].attachments, { fileName: 'cover-letter.pdf.jpg', url: 'https://files.mercury.test/letter.jpg', attachmentType: 'other' }] };
  world().contacts.ct_dana = { ...DANA };
  world().payments.push(hand({ id: 'zp_dana', amount: 25000, created: dayS('2026-04-12'), contact: 'ct_dana', type: 'online', payment_method: { type: 'card', brand: 'visa', last4: '4242' },
    buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', is_corporate: false, company_name: null, address: null } }));
  await run(NOW);
  post();
  await runs(NOW + 6 * MIN, NOW + 40 * MIN);
  const c = await cardOf(env(), TX);
  assert.equal(c.state, 'person');
  assert.equal(c.card.name, 'Pine Foundation');
  const sent = await said(approve(TX, { now: NOW + 45 * MIN }));
  const p = world().payments.find((x) => x.amount === 1000000);
  const learned = await learnedOf('Pine Foundation');
  assert.ok(!p || p.contact !== 'ct_dana',
    `the card for Pine Foundation started on donor ${c.card.donor} (${JSON.stringify(c.card.donors.map((d) => ({ id: d.id, name: d.name, for: d.for, sure: d.sure })))}); Send as filled in answered "${sent}" and the foundation's $10,000 is on ${p?.contact} as ${p?.buyer?.first_name} ${p?.buyer?.last_name}; the site now learns Pine Foundation as ${learned?.contact_id}`);
});

// ── D11b. Same root, V4's case (tests/check-gifts-letters.test.mjs: "a letter's email never files a gift on a donor whose name
//          only nearly matches"), with the one difference that the email's holder has given in the last 400 days, so
//          donorsFor finds it from a payment. The letter says the gift is Atlanta Rotary Club's and gives rotary@example.org;
//          North Atlanta Rotary Club's contact holds that email. Tied by the email, it's sure, so the card starts on it and
//          Send as filled in files Atlanta Rotary Club's gift on North Atlanta Rotary Club ────────────────────────────────────
test('D11b a letter\'s email never files a gift on a donor whose name only nearly matches, though that donor gave this year', async () => {
  world().reading = read({ payer: 'Atlanta Rotary Club' });
  world().letter = { aboutGift: true, recordAs: 'Atlanta Rotary Club', email: 'rotary@example.org', street: '', city: '', state: '', zip: '', amount: 10000 };
  env().AI = { run: async (model, input) => { world().aiCalls++; return { response: String(input?.messages?.[0]?.content || '').startsWith('You read one page') ? world().letter : world().reading }; } };
  world().txns[TX] = { ...world().txns[TX], attachments: [...world().txns[TX].attachments, { fileName: 'letter.jpg', url: 'https://files.mercury.test/letter.jpg', attachmentType: 'other' }] };
  world().contacts.ct_nar = { id: 'ct_nar', email: 'rotary@example.org', first_name: 'North Atlanta Rotary', last_name: 'Club', donation_count: 4 };
  world().payments.push(hand({ id: 'zp_nar', amount: 30000, created: dayS('2026-05-20'), contact: 'ct_nar', type: 'online', payment_method: { type: 'card', brand: 'visa', last4: '4242' },
    buyer: { first_name: 'North Atlanta Rotary', last_name: 'Club', email: 'rotary@example.org', is_corporate: false, company_name: null, address: null } }));
  await run(NOW);
  post();
  await runs(NOW + 6 * MIN, NOW + 40 * MIN);
  const c = await cardOf(env(), TX);
  assert.equal(c.card.name, 'Atlanta Rotary Club');
  const sent = await said(approve(TX, { now: NOW + 45 * MIN }));
  const p = world().payments.find((x) => x.amount === 1000000);
  assert.ok(!p || p.contact !== 'ct_nar',
    `the card started on donor ${c.card.donor} (${JSON.stringify(c.card.donors.map((d) => ({ id: d.id, name: d.name, for: d.for, sureFor: d.sureFor })))}); Send as filled in answered "${sent}", and Atlanta Rotary Club's $10,000 is on ${p?.contact} as ${p?.buyer?.first_name} ${p?.buyer?.last_name}`);
});

// ─── More controls: the same sequences with the one condition each finding hinges on taken away. These pass ─────────────
test('control: D8 without the unlink, the redeposit keeps the returned check\'s record and nothing is sent twice', async () => {
  await posted();
  assert.equal(await said(approve(TX, { now: NOW + 10 * MIN })), 'created');
  const r1 = (await rowOf()).zeffy_id;
  world().txns[TX] = { ...world().txns[TX], status: 'reversed' };
  await quiet(Date.parse('2026-11-12T16:00:00Z'));
  let t = Date.parse('2026-11-14T16:00:00Z');
  world().txns.tx_2 = txn({ id: 'tx_2', createdAt: '2026-11-14T15:00:00Z', status: 'sent', postedAt: '2026-11-15T14:00:00Z', dashboardLink: 'https://app.mercury.com/transactions/tx_2' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: t });
  t = await runs(t, t + 60 * MIN);
  assert.deepEqual([(await rowOf('tx_2')).zeffy_id, world().payments.filter((p) => p.amount === 1000000).length], [r1, 1]);
});

test('control: D9 a check a person left out and brought back keeps the name read off it', async () => {
  await posted();
  await CG.personDontSend(env(), TX, { reason: 'refund', saw: (await cardOf(env(), TX)).ver, by: 'staff@example.com', now: NOW + 12 * MIN });
  await CG.personReopen(env(), TX, { saw: (await cardOf(env(), TX)).ver, by: 'staff@example.com', now: NOW + 15 * MIN });
  await runs(NOW + 20 * MIN, NOW + 40 * MIN);
  const c = await cardOf(env(), TX);
  assert.deepEqual([c.state, c.card.name], ['person', 'Pine Foundation']);
});

test('control: D10 a letter attached while the card waits, before any Send, is no to-do once the check is sent', async () => {
  world().letter = { aboutGift: true, recordAs: 'Pine Foundation', email: '', street: '', city: '', state: '', zip: '', amount: 10000 };
  env().AI = { run: async (model, input) => { world().aiCalls++; return { response: String(input?.messages?.[0]?.content || '').startsWith('You read one page') ? world().letter : world().reading }; } };
  await runs(NOW, NOW + 6 * MIN);
  world().txns[TX] = { ...world().txns[TX], attachments: [...world().txns[TX].attachments, { fileName: 'letter.jpg', url: 'https://files.mercury.test/letter.jpg', attachmentType: 'other' }] };
  await runs(NOW + 10 * MIN, NOW + 60 * MIN);
  assert.equal(await said(approve(TX, { now: NOW + 61 * MIN })), 'created');
  const c = await cardOf(env(), TX);
  assert.ok(!c.letter?.todo);
});

test('control: D11b V4 as it stands (the near-name donor has no gift in the last 400 days): the card never starts on it', async () => {
  world().reading = read({ payer: 'Atlanta Rotary Club' });
  world().letter = { aboutGift: true, recordAs: 'Atlanta Rotary Club', email: 'rotary@example.org', street: '', city: '', state: '', zip: '', amount: 10000 };
  env().AI = { run: async (model, input) => { world().aiCalls++; return { response: String(input?.messages?.[0]?.content || '').startsWith('You read one page') ? world().letter : world().reading }; } };
  world().txns[TX] = { ...world().txns[TX], attachments: [...world().txns[TX].attachments, { fileName: 'letter.jpg', url: 'https://files.mercury.test/letter.jpg', attachmentType: 'other' }] };
  world().contacts.ct_nar = { id: 'ct_nar', email: 'rotary@example.org', first_name: 'North Atlanta Rotary', last_name: 'Club', donation_count: 4 };
  await run(NOW);
  post();
  await runs(NOW + 6 * MIN, NOW + 40 * MIN);
  assert.notEqual((await cardOf(env(), TX)).card.donor, 'ct_nar');
});
