/**
 * Break-it round 14 on Checks into Zeffy (Nov 11 2026): sequences across runs and presses, against
 * tests/lib/check-gifts-harness-2.mjs (Zeffy as its spec says: POST /payments finds or makes the contact by email, PATCH
 * changes only what it's given). Each H test failed before its fix, with the bad outcome in its message; each
 * "control:" test is the same steps without the one thing the bug needs, and held all along. Names, emails and addresses are made up.
 * Run: node --test tests/check-gifts-edges-14.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, run, rowOf, fakeFetch, txn, mirrorTransaction, slackSaid, readState, writeState, NOW, MIN, DAY, TX } = await import('./lib/check-gifts-harness-2.mjs');
const { approveWith, cardOf } = await import('./lib/check-gifts-approve.mjs');

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
const env = () => W.env;
const world = () => W.world;
const approve = (id, over = {}) => approveWith(env(), over.fetchImpl || fakeFetch, id, { now: NOW, ...over });
const said = (p) => p.then((x) => x.result, (e) => e.message);
const quiet = (now, o = {}) => run(now, o).catch((e) => ({ error: e.message }));
async function runs(from, to, step = 6 * MIN, o = {}) { let t = from; for (; t <= to; t += step) await quiet(t, o); return t; }
const tick = () => new Promise((r) => setImmediate(r));

/** POST /payments times out with nothing in Zeffy (its bad spell) */
function postTimesOut() {
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout' : null);
}

beforeEach(() => setup());

// Two checks whose readers' answer isn't them: Mercury names who paid, and the cards go on that name
const TWO = [['tx_a', 'Ash Lane Partners', 250, '201'], ['tx_b', 'Birch Hollow Partners', 300, '202']];
async function twoCarded() {
  delete world().txns[TX];
  await env().DB.prepare('DELETE FROM mercury_txns WHERE id = ?').bind(TX).run();
  for (const [id, name, amount, num] of TWO) {
    world().txns[id] = txn({ id, counterpartyName: name, checkNumber: num, amount, status: 'sent', postedAt: '2026-11-06T15:00:00Z', dashboardLink: `https://app.mercury.com/transactions/${id}` });
    await mirrorTransaction(env().DB, world().txns[id], { now: NOW });
  }
  await runs(NOW, NOW + 60 * MIN, 5 * MIN);
  const states = (await env().DB.prepare('SELECT state FROM check_gifts ORDER BY id').all()).results.map((r) => r.state);
  assert.deepEqual(states, ['person', 'person'], 'two cards waiting');
}

// ── H1. settleUnsure reads its rows once (unsure ones first), then works through them one by one, each with its own reads of
//        Zeffy. A row it read as 'person' (a card that came back "If it isn't in Zeffy, send it again", so its payload is
//        set) can be claimed by a person's Send while the run is still on the rows before it. When the run reaches it, it
//        reads it again: now 'creating', its POST still out. Nothing checks that the claim is older than CLAIM_MS (the
//        SELECT's own rule for 'creating'): findSent doesn't see the record yet, `waited` is false (the run has just stamped
//        try_at), and line 1641 turns the row 'unsure' under the live POST. When Zeffy answers 201, createRecord's update
//        only moves 'creating' to 'created' (line 1455), so the row stays 'unsure' with zeffy_id set and payload NULL. Every
//        later settleUnsure skips it (no payload), mustRow refuses every button, nothing alarms on 'unsure', writeAddresses
//        never takes it (created/linked only), and clearTags never clears a tag noted for it.
//        The sequence: Zeffy is slow and times out a Send; Ash Lane's card comes back. The person sends Birch Hollow, which
//        also times out ('unsure'). Five minutes later they press Ash Lane's "send it again" while the run is looking for
//        Birch Hollow's record, and this time Zeffy saves it and answers (slowly) ─────────────────────────────────────────
const ADDR = { line1: '12 Oak St', city: 'Roswell', state: 'GA', postal_code: '30075' };
async function sendAgainDuringALook({ overlap = true } = {}) {
  // (the address step is on, as it is live once its write test passed)
  const cfg = await readState(env().DB, 'check-gifts');
  await writeState(env().DB, 'check-gifts', { writeTest: { ...cfg.writeTest, address: { ok: true } } });
  await twoCarded();
  const t1 = NOW + 70 * MIN;
  postTimesOut();
  assert.match(await said(approve('tx_a', { now: t1 })), /don’t send this one again/);
  world().fail = null;
  await runs(t1 + 5 * MIN, t1 + 40 * MIN);
  let a = await rowOf('tx_a');
  assert.deepEqual([a.state, a.reason, !!a.payload], ['person', 'unsure', true], 'Ash Lane’s card is back: "If it isn’t in Zeffy, send it again"');
  const t2 = t1 + 45 * MIN;
  postTimesOut();
  assert.match(await said(approve('tx_b', { now: t2 })), /don’t send this one again/);
  world().fail = null;
  assert.equal((await rowOf('tx_b')).state, 'unsure', 'Birch Hollow’s Send is waiting on Zeffy');

  // Zeffy saves Ash Lane's next POST, and answers it a few seconds later
  let release;
  const gate = new Promise((r) => { release = r; });
  const personFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'api.zeffy.com' && (init.method || 'GET') === 'POST' && url.pathname.endsWith('/payments')) await gate;
    return fakeFetch(input, init);
  };
  const t3 = t2 + 5 * MIN;
  let press = null;
  // The run: while it reads Zeffy for Birch Hollow's record, the person presses Ash Lane's Send
  const runFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (overlap && !press && url.hostname === 'api.zeffy.com' && (init.method || 'GET') === 'GET' && url.pathname.endsWith('/payments') && url.searchParams.get('campaign')) {
      let done = false;
      press = approve('tx_a', { now: t3, fetchImpl: personFetch, address: ADDR }).then((x) => x, (e) => ({ error: e.message })).finally(() => { done = true; });
      while (!done && (await rowOf('tx_a')).state !== 'creating') await tick();
    }
    return fakeFetch(input, init);
  };
  await quiet(t3, { fetchImpl: runFetch });
  if (overlap) {
    release();
    press = await press;
  } else {
    // (the control: pressed once that run is done, before the next)
    let done = false;
    press = approve('tx_a', { now: t3 + 2 * MIN, fetchImpl: personFetch, address: ADDR }).then((x) => x, (e) => ({ error: e.message })).finally(() => { done = true; });
    while (!done && (await rowOf('tx_a')).state !== 'creating') await tick();
    release();
    press = await press;
  }
  const rec = world().payments.find((p) => p.amount === 25000);
  await runs(t3 + 5 * MIN, t3 + 2 * DAY, 30 * MIN);
  return { press, rec, t: t3 + 2 * DAY };
}

test('H1 a Send pressed while a run is looking at other unanswered sends never leaves its check stuck as "Zeffy hasn’t answered" for good', async () => {
  const { press, rec, t } = await sendAgainDuringALook();
  assert.equal(press?.result, 'created', `the person was told ${JSON.stringify(press)}`);
  assert.ok(rec, 'Zeffy saved Ash Lane’s record');
  const a = await rowOf('tx_a');
  const page = await cardOf(env(), 'tx_a');
  const dont = await said(CG.personDontSend(env(), 'tx_a', { reason: 'already', saw: page?.ver, by: 'staff@example.com', now: t, fetchImpl: fakeFetch }));
  const link = await said(CG.personLink(env(), 'tx_a', rec.id, { saw: page?.ver, by: 'staff@example.com', now: t, fetchImpl: fakeFetch }));
  const donor = world().contacts[rec.contact];
  assert.ok(!['unsure', 'creating'].includes(a.state),
    `two days after the Send, whose record ${rec.id} has been in Zeffy since and which the person was told "created", the check is still "${a.state}" (zeffy_id ${a.zeffy_id}, payload ${a.payload ? 'set' : 'NULL'}): its page says "${page?.why}" and is ${page?.needsYou ? '' : 'not '}in Needs you, Don't send answers "${dont}", This is the check answers "${link}", and the address the person typed is ${donor?.address ? 'on' : 'still not on'} the donor's contact ${rec.contact} (address_done ${a.address_done})`);
});

// ── H1b. The same race on a giver with no email (filed under their contact by the no-mail address, postJoined). Zeffy saves
//         and answers; the no-mail address's clean-up read times out once (Zeffy is having its slow spell). That note would
//         be cleared by the next run's clearTags, but clearTags never touches a note whose check is 'unsure', and H1 leaves
//         the check 'unsure' for good. So the address stays on Pine Foundation's contact, no alarm is ever raised (the
//         alarm is inside clearTags' loop), and the note is also the contact's lock: every later Pine Foundation check is
//         refused at Send ───────────────────────────────────────────────────────────────────────────────────────────────
async function pineSendCaught({ overlap = true } = {}) {
  const { noEmailGiver } = await import('./lib/check-gifts-harness-2.mjs');
  await noEmailGiver();
  TWO[0] = ['tx_a', 'Pine Foundation', 250, '201'];
  try {
    await twoCarded();
    const k = await cardOf(env(), 'tx_a');
    assert.equal(k.card.donor, 'c_pine', 'the card starts on Pine Foundation’s own contact, which has no email');
    const t1 = NOW + 70 * MIN;
    postTimesOut();
    assert.match(await said(approve('tx_a', { now: t1 })), /don’t send this one again/);
    world().fail = null;
    await runs(t1 + 5 * MIN, t1 + 40 * MIN);
    assert.deepEqual([(await rowOf('tx_a')).state, (await rowOf('tx_a')).reason], ['person', 'unsure']);
    const t2 = t1 + 45 * MIN;
    postTimesOut();
    assert.match(await said(approve('tx_b', { now: t2 })), /don’t send this one again/);
    world().fail = null;
    let release;
    const gate = new Promise((r) => { release = r; });
    let answered = false;
    let missed = false;
    const personFetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = init.method || 'GET';
      if (url.hostname === 'api.zeffy.com' && method === 'POST' && url.pathname.endsWith('/payments')) { await gate; const r = await fakeFetch(input, init); answered = true; return r; }
      // The clean-up's read of the contact, straight after: Zeffy's slow spell times it out once
      if (answered && !missed && url.hostname === 'api.zeffy.com' && method === 'GET' && url.pathname.endsWith('/contacts/c_pine')) { missed = true; throw new DOMException('timed out', 'TimeoutError'); }
      return fakeFetch(input, init);
    };
    const t3 = t2 + 5 * MIN;
    let press = null;
    const runFetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (overlap && !press && url.hostname === 'api.zeffy.com' && (init.method || 'GET') === 'GET' && url.pathname.endsWith('/payments') && url.searchParams.get('campaign')) {
        let done = false;
        press = approve('tx_a', { now: t3, fetchImpl: personFetch }).then((x) => x, (e) => ({ error: e.message })).finally(() => { done = true; });
        while (!done && (await rowOf('tx_a')).state !== 'creating') await tick();
      }
      return fakeFetch(input, init);
    };
    await quiet(t3, { fetchImpl: runFetch });
    if (overlap) {
      release();
      press = await press;
    } else {
      let done = false;
      press = approve('tx_a', { now: t3 + 2 * MIN, fetchImpl: personFetch }).then((x) => x, (e) => ({ error: e.message })).finally(() => { done = true; });
      while (!done && (await rowOf('tx_a')).state !== 'creating') await tick();
      release();
      press = await press;
    }
    assert.equal(press?.result, 'created', JSON.stringify(press));
    assert.ok(missed, 'the clean-up read timed out once');
    const rec = world().payments.find((p) => p.amount === 25000);
    assert.equal(rec?.contact, 'c_pine', 'the gift is on Pine Foundation’s contact');
    await runs(t3 + 5 * MIN, t3 + 2 * DAY, 30 * MIN);
    // Pine Foundation's next check
    world().txns.tx_c = txn({ id: 'tx_c', counterpartyName: 'Pine Foundation', checkNumber: '305', amount: 400, status: 'sent', postedAt: '2026-11-12T15:00:00Z', createdAt: '2026-11-11T15:00:00Z', dashboardLink: 'https://app.mercury.com/transactions/tx_c' });
    await mirrorTransaction(env().DB, world().txns.tx_c, { now: t3 + 2 * DAY });
    const t4 = await runs(t3 + 2 * DAY + 5 * MIN, t3 + 2 * DAY + 60 * MIN, 5 * MIN);
    const kc = await cardOf(env(), 'tx_c');
    const next = kc?.card?.donor ? await said(approve('tx_c', { now: t4 })) : `no card (${kc?.state})`;
    const left = Object.values(world().contacts).filter((c) => /@nomail\.soardcharity\.com$/i.test(c.email || ''));
    const notes = (await env().DB.prepare('SELECT * FROM check_tags').all()).results;
    return { kc, next, left, notes };
  } finally {
    TWO[0] = ['tx_a', 'Ash Lane Partners', 250, '201'];
  }
}

test('H1b a no-email giver\'s Send caught by H1 never leaves the no-mail address on their contact, nor locks their later checks out', async () => {
  const { kc, next, left, notes } = await pineSendCaught();
  assert.ok(!left.length && next === 'created',
    `two days on, ${left.map((c) => `${c.id} still holds ${c.email}`).join('; ') || 'no contact holds the address'} (check_tags: ${JSON.stringify(notes.map((t) => [t.contact, t.check_id, t.alerted]))}; Slack ${/no-mail address/.test(slackSaid()) ? 'said so' : 'never said so'}); Pine Foundation's next check, on donor ${kc?.card?.donor}, answered Send with "${next}"`);
});

test('control: H1b the same Send and the same timed-out clean-up between runs: the next run takes the address off, and the next check sends', async () => {
  const { next, left } = await pineSendCaught({ overlap: false });
  assert.deepEqual(left, []);
  assert.equal(next, 'created');
});

test('control: H1 the same Send pressed between runs is saved and the check is in Zeffy', async () => {
  const { press, rec } = await sendAgainDuringALook({ overlap: false });
  assert.equal(press?.result, 'created');
  const a = await rowOf('tx_a');
  assert.deepEqual([a.state, a.zeffy_id], ['created', rec.id]);
  assert.equal(world().contacts[rec.contact]?.address?.line1, '12 Oak St', 'the address the person typed went on the donor');
});
