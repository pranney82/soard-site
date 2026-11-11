/**
 * Break-it round 9 on Checks into Zeffy (Nov 10 2026): multi-step sequences across runs and presses, against
 * tests/lib/check-gifts-harness-2.mjs (Zeffy as its spec says: POST /payments finds or makes the contact by email, PATCH
 * changes only what it's given). Each C test failed before its fix, with the bad outcome in its message; each "control:"
 * test is the same steps without the one thing the bug needed, and held all along. Names, emails and addresses are made up.
 * Run: node --test tests/check-gifts-edges-9.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, createD1, freshWorld, setup, run, rowOf, post, posted, fakeFetch, hand, read, txn, mirrorTransaction, readState, writeState, noEmailGiver, tagged, slackSaid, NOW, MIN, DAY, dayS, TX } = await import('./lib/check-gifts-harness-2.mjs');
const { writeSlackConfig } = await import('../functions/api/_broadcast-notify.js');
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
const addCheck = async (id, o = {}) => {
  world().txns[id] = txn({ id, ...o });
  await mirrorTransaction(env().DB, world().txns[id], { now: NOW });
};

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
const attach = (id = TX, ...more) => { world().txns[id] = { ...world().txns[id], attachments: [...world().txns[id].attachments, ...more] }; };

beforeEach(() => setup());

// ── C1. findSent looks for an unanswered send's record by amount, form, date and a name that is loosely the giver's, and
//        never asks which entries the person ruled out. A joint check from Sam and Dana Whitfield; Dana's own $10,000 check
//        gift is typed in Zeffy for the same day. The card shows Dana's entry; the person says it's a different gift and
//        sends. Zeffy never answers and saved nothing. settleUnsure then finds Dana's entry "where the record would be" and
//        files this check as it: the couple's gift has no record, Dana's has this check's, and the site learns the couple
//        as Dana's contact ────────────────────────────────────────────────────────────────────────────────────────────────
test('C1 an unanswered send never claims the very entry the person said was a different gift', async () => {
  world().reading = read({ payer: 'Sam and Dana Whitfield' });
  world().contacts.ct_dana = { id: 'ct_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 3 };
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-11-03'), contact: 'ct_dana', buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', is_corporate: false, company_name: null } }));
  await posted();
  const c = await cardOf(env(), TX);
  assert.equal(c.state, 'person');
  assert.ok((c.candidates || []).some((x) => x.id === 'zp_dana'), 'Dana\'s own entry is shown as one that may be this check');
  // "It's a different gift": sent as a new donor, past the entry the person was shown. Zeffy never answers, saves nothing
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout' : null);
  const first = await said(approve(TX, { donor: 'new', notThose: true, shown: ['zp_dana'], now: NOW + 10 * MIN }));
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  assert.equal(world().payments.length, 1, 'Zeffy saved nothing for the joint check');
  await runs(NOW + 15 * MIN, NOW + 70 * MIN);
  const r = await rowOf();
  const learned = await env().DB.prepare('SELECT * FROM check_payers WHERE key = ?').bind(CG.payerKey('Sam and Dana Whitfield')).first();
  assert.notEqual(r.zeffy_id, 'zp_dana',
    `the person said Dana Whitfield's entry is a different gift (rejected ${r.rejected}); after the send went unanswered the check is "${r.state}" holding zp_dana as its record, and the site now files "Sam and Dana Whitfield" on contact ${learned?.contact_id}`);
});

// ── control (C2, held up). createRecord treats a 500 that carries an error code as "Zeffy saved nothing" (payload null,
//        "try again in a minute"), while postJoined treats the same answer as "Zeffy may still be saving it". Suspected a
//        second record; it holds because the second Send reads Zeffy again first and matches the record the first one made ─
test('control: C2 a 500 from Zeffy after it saved the record never leads to a second record for the same check', async () => {
  await posted();
  const savedThen500 = async (input, init = {}) => {
    if (isZeffy(input, init, 'POST', '/payments')) {
      await fakeFetch(input, init);
      return json({ error: { code: 'internal_server_error', message: 'Internal server error' } }, 500);
    }
    return fakeFetch(input, init);
  };
  const first = await said(approve(TX, { now: NOW + 10 * MIN, fetchImpl: savedThen500 }));
  // As the page says: try again in a minute
  await runs(NOW + 11 * MIN, NOW + 11 * MIN);
  const second = await said(approve(TX, { now: NOW + 12 * MIN }));
  const records = world().payments.filter((p) => p.amount === 1000000);
  assert.equal(records.length, 1,
    `one $10,000 check, ${records.length} Zeffy records: the first Send answered "${first}" though Zeffy had saved ${records[0]?.id}, and the second answered "${second}"`);
});

// ── C3. A no-email giver's Send files by the no-mail address, Zeffy's lookup misses it and makes a second contact holding
//        it (B10/R6's premise), and the answer is lost. Before settleUnsure looks, Mercury turns the check down. The
//        came-back branch of settleUnsure finds the record and keeps it to cancel, but never does what settleFound does for
//        a record found under a new contact: that contact keeps the no-mail address, with no note, for good ──────────────
test('C3 a check turned down while its no-email send is unanswered never leaves the no-mail address on the contact Zeffy made', async () => {
  await noEmailGiver();
  // Read and carded while Mercury still has it pending
  await runs(NOW, NOW + 6 * MIN);
  assert.equal((await rowOf()).state, 'person');
  const lagging = async (input, init = {}) => {
    if (isZeffy(input, init, 'POST', '/payments') && /@nomail\./.test(JSON.parse(init.body).email || '')) {
      const held = world().contacts.c_pine.email;
      world().contacts.c_pine.email = null;
      try { return await fakeFetch(input, init); } finally { world().contacts.c_pine.email = held; }
    }
    return fakeFetch(input, init);
  };
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  const first = await said(approve(TX, { now: NOW + 10 * MIN, fetchImpl: lagging }));
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  const saved = world().payments.find((p) => p.amount === 1000000);
  assert.ok(saved && saved.contact !== 'c_pine', 'Zeffy saved it, under a contact of its own');
  // Mercury's review turns the check down before the next run
  world().txns[TX] = { ...world().txns[TX], status: 'failed' };
  await runs(NOW + 15 * MIN, NOW + 15 * MIN + DAY + 60 * MIN, 30 * MIN);
  const r = await rowOf();
  const notes = (await env().DB.prepare('SELECT COUNT(*) AS n FROM check_tags').first()).n;
  assert.deepEqual(tagged().map((c) => c.id), [],
    `a day on, ${tagged().map((x) => `${x.id} holds ${x.email}`).join('; ')}; the check is "${r.state}" holding ${r.zeffy_id}, check_tags has ${notes} rows, and Slack said ${/no-mail/.test(slackSaid()) ? 'so' : 'nothing about it'}`);
});

// ── C4. personUnlink forgets what the wrong match taught by deleting the payer's whole check_payers row: what Pine
//        Foundation's earlier gifts taught (its own contact, which has no email and has been quiet past the 400-day read)
//        goes too, though the code says "what earlier gifts taught about it stays". The card made again starts on New donor,
//        and Send as filled in makes Pine a second contact ───────────────────────────────────────────────────────────────
test('C4 taking a wrong match off a check never forgets the donor the giver\'s earlier gifts went to', async () => {
  await noEmailGiver();
  // A hand entry under Pine's name, near the check: matched by itself
  world().payments.push(hand({ id: 'zp_wrong', created: dayS('2026-11-04'), contact: 'ct_typed' }));
  await posted();
  const linked = await rowOf();
  assert.equal(linked.state, 'linked');
  // It's another gift: the person takes it off
  await CG.personUnlink(env(), TX, { saw: (await cardOf(env(), TX)).ver, by: 'staff@example.com', now: NOW + 15 * MIN });
  await runs(NOW + 20 * MIN, NOW + 40 * MIN);
  const c = await cardOf(env(), TX);
  assert.equal(c.state, 'person');
  const sent = c.card.donor ? await said(approve(TX, { now: NOW + 45 * MIN })) : 'no donor picked';
  const p = world().payments.find((x) => x.amount === 1000000 && x.id !== 'zp_wrong');
  const learned = await env().DB.prepare('SELECT * FROM check_payers WHERE key = ?').bind('pine foundation').first();
  assert.equal(p?.contact, 'c_pine',
    `Pine Foundation's earlier gifts are on c_pine; after the wrong match came off, the card starts on donor "${c.card.donor}" (${c.card.donors.map((d) => d.id).join(', ') || 'none listed'}), Send answered "${sent}" and the gift is on ${p?.contact}; check_payers for Pine is ${learned ? JSON.stringify(learned) : 'gone'}`);
});

// ── C5. personUnlink sets payer to null so the name is "worked out again from the check and its letter", but leaves
//        name_by. The next card takes the check's name, and from then on name_by + payer says "a person gave this name", so
//        the letter attached afterwards (the source of truth for whose gift it is) is read and ignored ─────────────────
test('C5 a letter attached after a wrong match came off still decides who the gift is from', async () => {
  lettersToo();
  await posted();
  assert.equal((await cardOf(env(), TX)).card.name, 'Pine Foundation');
  // Typed in Zeffy a minute ago; the person sends with the name written out in full, and Send matches the entry
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-04'), contact: 'ct_typed' }));
  assert.equal(await said(approve(TX, { name: 'Pine Family Foundation', now: NOW + 10 * MIN })), 'linked');
  // It isn't this check: taken off
  await CG.personUnlink(env(), TX, { saw: (await cardOf(env(), TX)).ver, by: 'staff@example.com', now: NOW + 12 * MIN });
  await runs(NOW + 15 * MIN, NOW + 30 * MIN);
  const back = await cardOf(env(), TX);
  assert.equal(back.card.name, 'Pine Foundation', 'worked out again from the check');
  // The foundation's letter is attached in Mercury: the gift is Dana Whitfield's, through her family's foundation
  attach(TX, LETTER);
  await runs(NOW + 36 * MIN, NOW + 3 * 60 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  assert.equal(JSON.parse(r.letter).name, 'Dana Whitfield', 'the letter was read');
  assert.equal(c.card.name, 'Dana Whitfield',
    `the letter says the gift is Dana Whitfield's and nobody typed "${c.card.name}" (it was worked out from the check after the unlink), yet the card keeps it: name_by ${r.name_by}, payer ${r.payer}`);
});

// ─── Rows already in production, through the new migrations ───────────────────────────────────────────────────────────
// The table as the live site (HEAD, before the approval rebuild) has it: no card, send, taught or name_by. Every row the live
// site looked at since the letter reading went live has a letter note, even with no files: noteLetters writes one on a
// check's first look
const LIVE_COLUMNS = ['letter TEXT', 'address TEXT', 'drawer TEXT', 'address_done TEXT', 'address_at TEXT', 'address_tried TEXT'];
const NO_FILES = JSON.stringify({ files: [], reads: {}, pending: [], since: null, late: [], about: false, name: '', email: '', address: null, why: null });
const liveRow = (o = {}) => ({
  id: TX, account_id: 'acct_check', status: 'sent', cents: 1000000, deposited_at: '2026-11-05T15:00:00Z', posted_at: '2026-11-07T15:00:00Z',
  check_number: '1042', link: 'https://app.mercury.com/transactions/tx_1', state: 'person', reason: 'maybe-double', note: null,
  payer: 'Pine Foundation', check_date: '2026-11-03', memo: null, form_id: 'form_home', form_title: 'Help Build a Brighter Home',
  tries: 1, looked_at: '2026-11-10T12:00:00Z', final: 0, by: null, letter: NO_FILES, drawer: null,
  created_at: '2026-11-08T15:00:00Z', updated_at: '2026-11-10T12:00:00Z', ...o,
});
/** A live database with these rows, then the new code's first run (ensureChecks migrates it) */
async function fromLive(rows, txns = {}) {
  W.world = freshWorld();
  Object.assign(W.world.txns, txns);
  const DB = await createD1();
  await DB.prepare(`CREATE TABLE check_gifts (
    id TEXT PRIMARY KEY, account_id TEXT, status TEXT, cents INTEGER NOT NULL, deposited_at TEXT, posted_at TEXT,
    check_number TEXT, link TEXT, state TEXT NOT NULL, reason TEXT, note TEXT,
    payer TEXT, check_date TEXT, memo TEXT, form_id TEXT, form_title TEXT, guess TEXT, score TEXT, shape TEXT,
    zeffy_id TEXT, via TEXT, rejected TEXT, payload TEXT, tries INTEGER NOT NULL DEFAULT 0, try_at TEXT, looked_at TEXT,
    final INTEGER NOT NULL DEFAULT 0, alerted TEXT, by TEXT, created_at TEXT, updated_at TEXT)`).run();
  for (const col of LIVE_COLUMNS) await DB.prepare(`ALTER TABLE check_gifts ADD COLUMN ${col}`).run();
  for (const r of rows) {
    const keys = Object.keys(r);
    await DB.prepare(`INSERT INTO check_gifts (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map((k) => r[k])).run();
  }
  W.env = {
    DB, MERCURY_API_TOKEN: 'm', MERCURY_RELAY_KEY: 'r', ZEFFY_API_KEY: 'z', SLACK_BOT_TOKEN: 'xoxb',
    AI: { run: async () => { W.world.aiCalls++; return { response: W.world.reading }; } },
  };
  await CG.ensureChecks(DB);
  await DB.prepare('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)').run();
  await writeSlackConfig(DB, { attention: { id: 'C_ALERTS', name: 'website-alerts', private: false } });
  await writeState(DB, 'check-gifts', { writeTest: { id: CG.WRITE_TEST, ok: true, join: { ok: true } } });
  for (const t of Object.values(W.world.txns)) await mirrorTransaction(DB, t, { now: NOW });
}
const sentTxn = (o = {}) => txn({ status: 'sent', postedAt: '2026-11-07T15:00:00Z', ...o });

// ── C6. The drawer migration copies payer into drawer only where `letter IS NULL`, to leave a name a letter gave alone. But
//        the live site writes a letter note on every check's first look, files or not, so every check read before drawer
//        existed (Nov 6-10) and still waiting keeps drawer NULL. checkName is now drawer only: the card made from it has no
//        name, writes payer NULL over the name read off the check, and says the site couldn't read who wrote it ─────────
test('C6 a check read before Nov 10 and waiting on a person keeps the name read off it through the migration', async () => {
  await fromLive([liveRow()], { [TX]: sentTxn() });
  await runs(NOW, NOW + 12 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  assert.equal(c.state, 'person');
  assert.deepEqual({ name: c.card.name, unreadable: c.card.notes.some((n) => n.kind === 'unreadable') }, { name: 'Pine Foundation', unreadable: false },
    `the live row had payer "Pine Foundation" read off the check; after the migration (drawer ${r.drawer}) its card's name is "${c.card.name}", the row's payer is ${r.payer}, and the card says: ${c.card.notes.map((n) => n.text).join(' / ')}`);
});

// ── C7. The name_by migration copies `by` into name_by for every waiting row with a payer. On the live site `by` on a
//        waiting row is also who pressed "It's a gift" (told-gift) or took a wrong match off (unlink): neither gave the name,
//        which was read off the check. Migrated, the check's name stands as a person's answer, and the letter attached
//        afterwards is read and ignored ─────────────────────────────────────────────────────────────────────────────────
test('C7 a live check a person said is a gift still takes its letter\'s giver once the letter is attached', async () => {
  await fromLive([liveRow({ reason: 'told-gift', by: 'staff@example.com', drawer: 'Pine Foundation' })], { [TX]: sentTxn() });
  lettersToo();
  await runs(NOW, NOW + 12 * MIN);
  assert.equal((await cardOf(env(), TX)).card.name, 'Pine Foundation');
  attach(TX, LETTER);
  await runs(NOW + 15 * MIN, NOW + 3 * 60 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  assert.equal(JSON.parse(r.letter).name, 'Dana Whitfield', 'the letter was read');
  assert.equal(c.card.name, 'Dana Whitfield',
    `the letter says the gift is Dana Whitfield's; the card keeps "${c.card.name}" because the migration made ${r.by} (who pressed "It's a gift") its name's author (name_by ${r.name_by})`);
});

// ── C8. The live site left some checks out by itself (SOARD's own money, a refund memo, an insurer's name), and its Slack
//        note said "Nothing to do unless it's really a gift. Then say so on Checks" (personIsGift). The rebuild removed that:
//        "Send to Zeffy after all" (personReopen, and the page's button) is only for a person's own Don't send, and the
//        migration gives cards only to 'would' and 'person' rows. A real gift the live site left out can never be sent ────
test('C8 a gift the live site left out by itself can still be brought back and sent by a person', async () => {
  await fromLive([liveRow({ state: 'left-out', reason: 'refund', memo: 'refund of overpayment, keep as donation', drawer: 'Pine Foundation' })], { [TX]: sentTxn() });
  await runs(NOW, NOW + 12 * MIN);
  const before = await cardOf(env(), TX);
  const back = await said(CG.personReopen(env(), TX, { saw: before.ver, by: 'staff@example.com', now: NOW + 15 * MIN }));
  await runs(NOW + 20 * MIN, NOW + 30 * MIN);
  const c = await cardOf(env(), TX);
  assert.ok(c.state === 'person' && c.card,
    `the live site left this $10,000 check out by itself ("${before.why}"), never a person; "Send to Zeffy after all" answers "${back}" and it stays "${c.state}" with no card to send`);
});

// ── C9. A check that came back, whose record staff then cancelled in Zeffy as the page told them, is deposited again: the
//        good deposit of the one gift. twinOf counts any earlier deposit of the number and amount, whatever became of it, so
//        the new card opens on "redeposit" with Don't send pre-picked as "The same check deposited again", and the site
//        knows the first deposit came back. Following the card leaves the gift out of Zeffy altogether ─────────────────────
test('C9 a check deposited again after it came back (its record cancelled) is not suggested as "the same check deposited again"', async () => {
  await posted();
  assert.equal(await said(approve(TX, { now: NOW + 10 * MIN })), 'created');
  const first = await rowOf();
  // Nov 12: the bank returns it; staff cancel its record in Zeffy, as Checks says
  world().txns[TX] = { ...world().txns[TX], status: 'reversed' };
  let t = Date.parse('2026-11-12T16:00:00Z');
  await quiet(t);
  assert.equal((await rowOf()).state, 'came-back');
  world().payments = world().payments.filter((p) => p.id !== first.zeffy_id);
  t = await runs(t + 70 * MIN, t + 80 * MIN);
  assert.equal((await rowOf()).zeffy_id, null, 'the cancelled record is off the returned check');
  // Nov 20: the donor's bank says try again, and the same paper check goes in again
  const later = Date.parse('2026-11-20T16:00:00Z');
  await addCheck('tx_2', { createdAt: '2026-11-20T15:00:00Z', status: 'sent', postedAt: '2026-11-21T14:00:00Z' });
  await runs(later, later + 20 * MIN);
  const c = await cardOf(env(), 'tx_2');
  assert.equal(c.state, 'person');
  assert.deepEqual({ suggest: c.card.suggest, dont: c.card.dontReason }, { suggest: 'send', dont: null },
    `the first deposit came back and its record is cancelled, so this deposit is the gift; its card says ${c.card.notes.map((n) => `"${n.text}"`).join(', ')} and pre-picks "${c.card.suggest}"${c.card.dontReason ? ` as "${CG.DONT_REASONS[c.card.dontReason]}"` : ''}`);
});

// ── C10. createRecord writes what the person chose with the claim (keep: the name, the form, the donor, the email and
//         address to add), "as the record may be made from here on". When Zeffy never answers and the record never shows,
//         the card comes back saying "If it isn't in Zeffy, send it again", but prepareCard fills it in from scratch: the
//         name stands (name_by, B5's fix), and the form, donor and email the person chose are gone. Sent again as the card
//         says, the gift goes on the form the person had changed away from ──────────────────────────────────────────────
test('C10 the form and email a person chose on a send Zeffy never answered are still on the card when it comes back', async () => {
  await posted();
  const k = (await cardOf(env(), TX)).card;
  assert.equal(k.formId, 'form_grant', 'a foundation starts on the grant form');
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout' : null);
  const first = await said(approve(TX, { formId: 'form_home', email: 'office@example.com', now: NOW + 10 * MIN }));
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  assert.equal(world().payments.length, 0, 'Zeffy saved nothing');
  const t = await runs(NOW + 15 * MIN, NOW + 150 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  assert.equal(c.state, 'person');
  // Pressed again as the card now says
  const again = await said(approve(TX, { now: t }));
  const p = world().payments.find((x) => x.amount === 1000000);
  assert.deepEqual({ form: c.card.formId, email: c.card.email }, { form: 'form_home', email: 'office@example.com' },
    `the person changed the form to Help Build a Brighter Home and typed office@example.com; Zeffy never answered, and the card that came back (${c.card.notes[0]?.kind}) says form ${c.card.formId} and email "${c.card.email}" (the row kept ${r.send}); pressed again as shown ("${again}"), the gift went on ${p?.campaign_id} with email ${p?.buyer?.email}`);
});

// ── C11. minor: the site keeps a ZIP to its five digits so no nine-digit run is ever stored (addressOf), but a card's Zeffy
//         donors keep Zeffy's address as Zeffy has it: a ZIP+4 saved on the card is a nine-digit run (hasAccountDigits) ───
test('C11 minor: a donor\'s ZIP+4 from Zeffy is never stored on the card as a nine-digit run', async () => {
  world().contacts.ct_pine = { id: 'ct_pine', email: 'office@example.com', first_name: 'Pine', last_name: 'Foundation', donation_count: 2, address: { line1: '12 Oak St', city: 'Roswell', state: 'GA', postal_code: '30075-1234', country: 'US' } };
  world().payments.push(hand({ id: 'zp_spring', amount: 50000, created: dayS('2026-05-04'), contact: 'ct_pine', buyer: { first_name: 'Pine', last_name: 'Foundation', email: 'office@example.com', is_corporate: false, company_name: null, address: { line1: '12 Oak St', city: 'Roswell', state: 'GA', postal_code: '30075-1234', country: 'US' } } }));
  await posted();
  const r = await rowOf();
  assert.equal(r.state, 'person');
  const zips = (r.card.match(/"postal_code":"[^"]*"/g) || []).map((x) => x.slice(15, -1));
  assert.ok(zips.length && zips.every((z) => !CG.hasAccountDigits(z)), `the saved card holds the ZIPs ${zips.join(', ')}`);
});

// ─── Passing controls: the same sequences with the one condition each finding hinges on taken away. These pass ──────────
test('control: C1 with Dana\'s entry three days before the check\'s date (outside where the record would be), the unanswered send claims nothing', async () => {
  world().reading = read({ payer: 'Sam and Dana Whitfield' });
  world().contacts.ct_dana = { id: 'ct_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 3 };
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-10-31'), contact: 'ct_dana', buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', is_corporate: false, company_name: null } }));
  await posted();
  assert.ok(((await cardOf(env(), TX)).candidates || []).some((x) => x.id === 'zp_dana'));
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout' : null);
  await approve(TX, { donor: 'new', notThose: true, shown: ['zp_dana'], now: NOW + 10 * MIN }).catch(() => null);
  world().fail = null;
  await runs(NOW + 15 * MIN, NOW + 70 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.reason, r.zeffy_id], ['person', 'unsure', null]);
});

test('control: C3 the same unanswered no-email send under a new contact, the check not turned down: the address comes off that contact', async () => {
  await noEmailGiver();
  await runs(NOW, NOW + 6 * MIN);
  const lagging = async (input, init = {}) => {
    if (isZeffy(input, init, 'POST', '/payments') && /@nomail\./.test(JSON.parse(init.body).email || '')) {
      const held = world().contacts.c_pine.email;
      world().contacts.c_pine.email = null;
      try { return await fakeFetch(input, init); } finally { world().contacts.c_pine.email = held; }
    }
    return fakeFetch(input, init);
  };
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  await approve(TX, { now: NOW + 10 * MIN, fetchImpl: lagging }).catch(() => null);
  world().fail = null;
  await runs(NOW + 15 * MIN, NOW + 15 * MIN + DAY + 60 * MIN, 30 * MIN);
  assert.equal((await rowOf()).state, 'created');
  assert.deepEqual(tagged().map((c) => c.id), []);
});

test('control: C4 with no wrong match, Pine\'s check starts on and lands on the contact its earlier gifts went to', async () => {
  await noEmailGiver();
  await posted();
  const c = await cardOf(env(), TX);
  assert.equal(c.card.donor, 'c_pine');
  assert.equal(await said(approve(TX, { now: NOW + 15 * MIN })), 'created');
  assert.equal(world().payments.find((x) => x.amount === 1000000)?.contact, 'c_pine');
});

test('control: C5 the same match sent under the card\'s own name and taken off: the letter attached afterwards decides', async () => {
  lettersToo();
  await posted();
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-04'), contact: 'ct_typed' }));
  assert.equal(await said(approve(TX, { now: NOW + 10 * MIN })), 'linked');
  await CG.personUnlink(env(), TX, { saw: (await cardOf(env(), TX)).ver, by: 'staff@example.com', now: NOW + 12 * MIN });
  await runs(NOW + 15 * MIN, NOW + 30 * MIN);
  attach(TX, LETTER);
  await runs(NOW + 36 * MIN, NOW + 3 * 60 * MIN);
  assert.equal((await cardOf(env(), TX)).card.name, 'Dana Whitfield');
});

test('control: C6 a live waiting check read after drawer was kept (Nov 10) keeps its name through the migration', async () => {
  await fromLive([liveRow({ drawer: 'Pine Foundation' })], { [TX]: sentTxn() });
  await runs(NOW, NOW + 12 * MIN);
  const c = await cardOf(env(), TX);
  assert.equal(c.card.name, 'Pine Foundation');
  assert.ok(!c.card.notes.some((n) => n.kind === 'unreadable'));
});

test('control: C7 a live waiting check with no `by` takes its letter\'s giver once the letter is attached', async () => {
  await fromLive([liveRow({ drawer: 'Pine Foundation' })], { [TX]: sentTxn() });
  lettersToo();
  await runs(NOW, NOW + 12 * MIN);
  attach(TX, LETTER);
  await runs(NOW + 15 * MIN, NOW + 3 * 60 * MIN);
  assert.equal((await cardOf(env(), TX)).card.name, 'Dana Whitfield');
});

test('control: C8 a live check a person left out comes back with "Send to Zeffy after all"', async () => {
  await fromLive([liveRow({ state: 'left-out', reason: 'person', by: 'staff@example.com', drawer: 'Pine Foundation' })], { [TX]: sentTxn() });
  await runs(NOW, NOW + 12 * MIN);
  const before = await cardOf(env(), TX);
  assert.equal((await CG.personReopen(env(), TX, { saw: before.ver, by: 'staff@example.com', now: NOW + 15 * MIN })).result, 'reopened');
  await runs(NOW + 20 * MIN, NOW + 30 * MIN);
  const c = await cardOf(env(), TX);
  assert.ok(c.state === 'person' && c.card);
});

test('control: C9 the same check deposited twice, the first deposit standing in Zeffy: "redeposit" with Don\'t send suggested', async () => {
  await posted();
  assert.equal(await said(approve(TX, { now: NOW + 10 * MIN })), 'created');
  const later = Date.parse('2026-11-20T16:00:00Z');
  await addCheck('tx_2', { createdAt: '2026-11-20T15:00:00Z', status: 'sent', postedAt: '2026-11-21T14:00:00Z' });
  await runs(later, later + 20 * MIN);
  const c = await cardOf(env(), 'tx_2');
  assert.equal(c.card.notes[0]?.kind, 'redeposit');
  assert.deepEqual([c.card.suggest, c.card.dontReason], ['dont', 'repeat']);
});

test('control: C11 a five-digit ZIP from Zeffy on a card\'s donor holds no long run of digits', async () => {
  world().contacts.ct_pine = { id: 'ct_pine', email: 'office@example.com', first_name: 'Pine', last_name: 'Foundation', donation_count: 2, address: { line1: '12 Oak St', city: 'Roswell', state: 'GA', postal_code: '30075', country: 'US' } };
  world().payments.push(hand({ id: 'zp_spring', amount: 50000, created: dayS('2026-05-04'), contact: 'ct_pine', buyer: { first_name: 'Pine', last_name: 'Foundation', email: 'office@example.com', is_corporate: false, company_name: null, address: { line1: '12 Oak St', city: 'Roswell', state: 'GA', postal_code: '30075', country: 'US' } } }));
  await posted();
  const zips = ((await rowOf()).card.match(/"postal_code":"[^"]*"/g) || []).map((x) => x.slice(15, -1));
  assert.ok(zips.length && zips.every((z) => !CG.hasAccountDigits(z)));
});
