/**
 * Every check is approved by a person (Peter, Nov 10 2026: "admin wants to approve all entries into zeffy"). The site fills
 * in a card (who it's from, a choice when two names exist, which Zeffy donor, a choice when more than one could be them,
 * form, date, optional email, mailing address) and a person sends it, matches it, or says it isn't for Zeffy. Nothing goes
 * to Zeffy without a press. Against the spec-faithful fakes in tests/lib/check-gifts-harness-2.mjs. Names are made up.
 * Run: node --test tests/check-gifts-approve.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { W, CG, setup, rowOf, fakeFetch, hand, read, txn, mirrorTransaction, writeState, readState, slackSaid, approve, dontSend, card, MIN, DAY, TX, NOW } from './lib/check-gifts-harness-2.mjs';

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });

const env = () => W.env;
const world = () => W.world;
const run = (now) => CG.runChecks(env(), { now, fetchImpl: fakeFetch }).catch((e) => ({ error: e.message }));
async function runs(from, to, step = 5 * MIN) { for (let t = from; t <= to; t += step) await run(t); }
/** A Zeffy donor with gifts, as Zeffy's payments show them */
const gift = (o = {}) => hand({ id: `zp_${Math.random().toString(36).slice(2, 8)}`, amount: 2500, created: Math.floor(Date.parse('2026-06-01T16:00:00Z') / 1000), ...o });
const buyer = (first, last, email = null, address = null) => ({ first_name: first, last_name: last, email, is_corporate: false, company_name: null, address });
const OAK = { line1: '12 Oak St', city: 'Roswell', state: 'GA', postal_code: '30075', country: 'US' };

/** The write test has also proven an address goes on a donor (as it did live, Nov 10 2026) */
async function fresh() {
  await setup();
  const cfg = await readState(W.env.DB, 'check-gifts');
  await writeState(W.env.DB, 'check-gifts', { writeTest: { ...cfg.writeTest, address: { ok: true } } });
}
beforeEach(() => fresh());

test('a deposited check gets a card, Slack says so once, and nothing reaches Zeffy until a person sends it', async () => {
  await runs(NOW, NOW + 60 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.reason], ['person', 'ready']);
  assert.equal(world().posts.length, 0, 'nothing sent without a press');
  assert.equal((slackSaid().match(/ready to send to Zeffy/g) || []).length > 0, true);
  assert.equal(world().slack.filter((b) => /ready to send to Zeffy/.test(b)).length, 1, 'said once');
  const c = await card();
  assert.equal(c.needsYou, true);
  assert.deepEqual([c.card.name, c.card.donor, c.card.formId, c.card.day], ['Pine Foundation', 'new', 'form_grant', '2026-11-03']);
  const v = await CG.checksView(env());
  assert.equal(v.waiting, 1);
  assert.equal((await CG.checksFacts(env().DB)).waiting, 1, 'the Automations count is the page’s');
});

test('Send to Zeffy makes the record with the receipt and email off, and Slack hears it\'s done', async () => {
  await runs(NOW, NOW + 10 * MIN);
  const r = await approve(TX, { now: NOW + 15 * MIN });
  assert.equal(r.result, 'created');
  const sent = world().posts[0];
  assert.deepEqual([sent.first_name, sent.last_name, sent.generate_tax_receipt, sent.send_confirmation_email, sent.campaign_id, sent.amount], ['Pine', 'Foundation', false, false, 'form_grant', 1000000]);
  const row = await rowOf();
  assert.deepEqual([row.state, row.via, row.by], ['created', 'person', 'staff@example.com']);
  assert.equal((await card()).needsYou, false);
  // A second press (a browser resending) never sends twice
  await approve(TX, { now: NOW + 16 * MIN }).catch(() => null);
  assert.equal(world().posts.length, 1);
});

test('two donors in Zeffy who could be the giver: the card asks which, and the gift goes on the one picked', async () => {
  world().payments.push(
    gift({ contact: 'ct_a', buyer: buyer('Pine', 'Foundation', 'office@pine.example', OAK) }),
    gift({ contact: 'ct_b', buyer: buyer('Pine', 'Foundation', 'grants@pine-family.example') }),
  );
  world().contacts.ct_a = { id: 'ct_a', email: 'office@pine.example', first_name: 'Pine', last_name: 'Foundation', donation_count: 1 };
  world().contacts.ct_b = { id: 'ct_b', email: 'grants@pine-family.example', first_name: 'Pine', last_name: 'Foundation', donation_count: 1 };
  await runs(NOW, NOW + 10 * MIN);
  const c = await card();
  assert.equal(c.card.donor, null, 'nobody picked for the person');
  assert.deepEqual(c.card.donors.map((d) => d.id).sort(), ['ct_a', 'ct_b']);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN }), /pick the Zeffy donor/);
  await approve(TX, { now: NOW + 15 * MIN, donor: 'ct_b' });
  const sent = world().posts[0];
  assert.equal(sent.email, 'grants@pine-family.example', 'filed under the donor picked, by their email');
  assert.equal(world().payments.at(-1).contact, 'ct_b');
});

test('the donor this payer was learned as is picked by itself; one without an email is joined, and the no-mail address comes off', async () => {
  await env().DB.prepare('INSERT INTO check_payers (key, name, contact_id, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?)').bind('pine foundation', 'Pine Foundation', 'c_pine', 'form_home', 'x').run();
  world().contacts.c_pine = { id: 'c_pine', email: null, first_name: 'Pine', last_name: 'Foundation', donation_count: 3 };
  await runs(NOW, NOW + 10 * MIN);
  const c = await card();
  assert.equal(c.card.donor, 'c_pine');
  assert.equal(c.card.formId, 'form_home', 'the form this giver used before');
  await approve(TX, { now: NOW + 15 * MIN });
  assert.equal(world().payments.at(-1).contact, 'c_pine');
  assert.equal(world().contacts.c_pine.email, null, 'the no-mail address is off again');
});

test('a new donor with an email another donor holds: refused, and that donor joins the card\'s list to pick', async () => {
  world().contacts.ct_other = { id: 'ct_other', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 2 };
  await runs(NOW, NOW + 10 * MIN);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, email: 'dana@example.com' }), /already has dana@example\.com on Dana Whitfield/);
  assert.equal(world().posts.length, 0);
  const c = await card();
  assert.ok(c.card.donors.some((d) => d.id === 'ct_other'));
  // Sent with no email: a new donor by name
  await approve(TX, { now: NOW + 20 * MIN, email: '' });
  assert.equal(world().posts[0].email, undefined);
});

test('the address and email chosen on the card go on the donor; "keep what Zeffy has" changes nothing', async () => {
  await env().DB.prepare("UPDATE check_gifts SET address = ? WHERE id = ?").bind(JSON.stringify({ ...OAK, from: 'check', for: 'Pine Foundation' }), TX).run().catch(() => null);
  world().reading = read({ street: '12 Oak St', city: 'Roswell', state: 'GA', zip: '30075' });
  await runs(NOW, NOW + 10 * MIN);
  assert.equal((await card()).card.checkAddress?.line1, '12 Oak St');
  await approve(TX, { now: NOW + 15 * MIN, email: 'office@pine.example' });
  await runs(NOW + 20 * MIN, NOW + 30 * MIN);
  const c = world().contacts[world().payments.at(-1).contact];
  assert.equal(c.address?.line1, '12 Oak St');
  assert.equal(c.email, 'office@pine.example');

  await fresh();
  world().contacts.ct_a = { id: 'ct_a', email: 'office@pine.example', first_name: 'Pine', last_name: 'Foundation', address: { line1: '9 Elm St', city: 'Alpharetta', state: 'GA', postal_code: '30009', country: 'US' } };
  world().payments.push(gift({ contact: 'ct_a', buyer: buyer('Pine', 'Foundation', 'office@pine.example', { line1: '9 Elm St', city: 'Alpharetta', state: 'GA', postal_code: '30009', country: 'US' }) }));
  world().reading = read({ street: '12 Oak St', city: 'Roswell', state: 'GA', zip: '30075' });
  await runs(NOW, NOW + 10 * MIN);
  await approve(TX, { now: NOW + 15 * MIN, donor: 'ct_a', address: null });
  await runs(NOW + 20 * MIN, NOW + 30 * MIN);
  assert.equal(world().contacts.ct_a.address.line1, '9 Elm St', 'kept');
});

test('a typed address that isn\'t whole is refused; a typed one that is goes on', async () => {
  await runs(NOW, NOW + 10 * MIN);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, address: { line1: '40 Pine Rd', city: 'Marietta', state: 'Georgia', postal_code: '300' } }), /isn’t right\. GEORGIA isn’t a US state/);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, address: { line1: '123456789 Main St', city: 'Marietta', state: 'GA', postal_code: '30062' } }), /six or more digits in a row/);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, address: { line1: 'One Glenlake Parkway', city: 'Atlanta', state: 'GA', postal_code: '30328' } }), /needs its number/);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, address: { line1: '1 Glenlake Pkwy', city: 'Atlanta', state: 'GQ', postal_code: '30328' } }), /GQ isn’t a US state/);
  assert.equal(world().posts.length, 0);
  await approve(TX, { now: NOW + 16 * MIN, address: { line1: '40 PINE RD', city: 'MARIETTA', state: 'ga', postal_code: '30062' } });
  await runs(NOW + 20 * MIN, NOW + 30 * MIN);
  assert.equal(world().contacts[world().payments.at(-1).contact].address.line1, '40 Pine Rd');
});

test('a check and its letter naming different givers: the card offers both, the letter\'s first', async () => {
  const LETTER = { fileName: 'letter.jpg', url: 'https://files.mercury.test/letter.jpg', attachmentType: 'receipt' };
  world().txns[TX] = { ...world().txns[TX], attachments: [...world().txns[TX].attachments, LETTER] };
  env().AI = { run: async (model, input) => ({ response: String(input?.messages?.[0]?.content || '').startsWith('You read one page')
    ? { aboutGift: true, recordAs: 'Dana Whitfield', email: 'dana@example.com', street: '', city: '', state: '', zip: '', amount: 10000 }
    : world().reading }) };
  await runs(NOW, NOW + 30 * MIN);
  const c = await card();
  assert.deepEqual(c.card.names.map((n) => [n.name, n.from]), [['Dana Whitfield', 'letter'], ['Pine Foundation', 'check']]);
  assert.equal(c.card.name, 'Dana Whitfield');
  assert.equal(c.card.email, 'dana@example.com');
  await approve(TX, { now: NOW + 35 * MIN, name: 'Pine Foundation', email: '' });
  assert.equal(world().posts[0].last_name, 'Foundation', 'the person\'s pick stands');
});

test('Zeffy may already have it: the card lists the entry, Send asks first, and "This is the check" matches it', async () => {
  world().payments.push(hand({ id: 'zp_oak', created: Math.floor(Date.parse('2026-11-04T16:00:00Z') / 1000), contact: 'ct_oak', buyer: buyer('Oakline', 'Builders') }));
  await runs(NOW, NOW + 10 * MIN);
  const c = await card();
  assert.equal(c.reason, 'maybe-double');
  assert.ok(c.card.notes.some((n) => n.kind === 'maybe-double'));
  assert.deepEqual(c.candidates.map((x) => x.id), ['zp_oak']);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN }), (e) => /may be this check/.test(e.message) && e.entries?.[0]?.id === 'zp_oak');
  assert.equal(world().posts.length, 0);
  await CG.personLink(env(), TX, 'zp_oak', { saw: (await card()).ver, by: 'staff@example.com', now: NOW + 20 * MIN, fetchImpl: fakeFetch });
  const r = await rowOf();
  assert.deepEqual([r.state, r.zeffy_id, r.via], ['linked', 'zp_oak', 'person']);
  assert.equal(world().posts.length, 0);
});

test('"It\'s a different gift" sends only past the entries the person was shown', async () => {
  world().payments.push(hand({ id: 'zp_oak', created: Math.floor(Date.parse('2026-11-04T16:00:00Z') / 1000), contact: 'ct_oak', buyer: buyer('Oakline', 'Builders') }));
  await runs(NOW, NOW + 10 * MIN);
  // One more turns up while the person is deciding
  world().payments.push(hand({ id: 'zp_ash', created: Math.floor(Date.parse('2026-11-05T16:00:00Z') / 1000), contact: 'ct_ash', buyer: buyer('Ash', 'Partners') }));
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, notThose: true, shown: ['zp_oak'], saw: 'person' }), (e) => e.entries?.some((x) => x.id === 'zp_ash'));
  assert.equal(world().posts.length, 0);
  await approve(TX, { now: NOW + 16 * MIN, notThose: true, shown: ['zp_oak', 'zp_ash'], saw: 'person' });
  assert.equal(world().posts.length, 1);
});

test('a check someone typed into Zeffy by hand is matched by itself: no card to send', async () => {
  world().payments.push(hand({ id: 'zp_hand', created: Math.floor(Date.parse('2026-11-04T16:00:00Z') / 1000), contact: 'ct_pine' }));
  await runs(NOW, NOW + 10 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.zeffy_id, r.via], ['linked', 'zp_hand', 'hand']);
  assert.equal(world().posts.length, 0);
});

test('a hand entry typed while the card waits matches it within the hour', async () => {
  await runs(NOW, NOW + 10 * MIN);
  assert.equal((await rowOf()).state, 'person');
  world().payments.push(hand({ id: 'zp_late', created: Math.floor(Date.parse('2026-11-04T16:00:00Z') / 1000), contact: 'ct_pine' }));
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null });
  await run(NOW + 70 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.zeffy_id], ['linked', 'zp_late']);
});

test('Don\'t send to Zeffy, with why; "Send to Zeffy after all" brings the card back', async () => {
  await runs(NOW, NOW + 10 * MIN);
  await assert.rejects(dontSend(TX, 'because', { now: NOW + 15 * MIN }), /Say why/);
  await dontSend(TX, 'store', { now: NOW + 15 * MIN });
  let r = await rowOf();
  assert.deepEqual([r.state, r.reason, r.note], ['left-out', 'person', 'store']);
  let c = await card();
  assert.match(c.why, /Not sent to Zeffy: A store sale/);
  assert.equal(c.needsYou, false);
  await CG.personReopen(env(), TX, { saw: c.ver, by: 'staff@example.com', now: NOW + 20 * MIN });
  await runs(NOW + 25 * MIN, NOW + 35 * MIN);
  r = await rowOf();
  assert.equal(r.state, 'person');
  c = await card();
  assert.equal(c.needsYou, true);
  assert.equal(world().posts.length, 0);
});

test('a check that looks like SOARD\'s own money or a refund comes with "Don\'t send" suggested, and the person still decides', async () => {
  world().reading = read({ memo: 'Refund for invoice 88' });
  await runs(NOW, NOW + 10 * MIN);
  let c = await card();
  assert.equal(c.state, 'person');
  assert.deepEqual([c.card.suggest, c.card.dontReason], ['dont', 'refund']);
  assert.ok(c.card.notes.some((n) => n.kind === 'refund'));
  // Sending anyway is the person's call
  await approve(TX, { now: NOW + 15 * MIN });
  assert.equal(world().posts.length, 1);

  await fresh();
  world().txns[TX] = { ...world().txns[TX], categoryData: { id: 'cat_t', name: 'Event & Sponsorship' } };
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
  await runs(NOW, NOW + 10 * MIN);
  c = await card();
  assert.deepEqual([c.card.suggest, c.card.dontReason], ['dont', 'event']);
  assert.match(c.card.notes.find((n) => n.kind === 'category').text, /Event & Sponsorship/);
});

test('sending is off until the write test passes: the card waits, and Send says why', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: { id: CG.WRITE_TEST, ok: false, at: new Date(NOW).toISOString(), tries: 1, leftBehind: [] } });
  await runs(NOW, NOW + 10 * MIN);
  assert.equal((await rowOf()).state, 'person');
  assert.equal((await CG.checksView(env())).sending, false);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN }), /Sending is off/);
  assert.equal(world().posts.length, 0);
});

test('Zeffy not answering the send: the card says so, the record is looked for, and it\'s never sent twice', async () => {
  await runs(NOW, NOW + 10 * MIN);
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN }), /didn’t answer/);
  world().fail = null;
  await runs(NOW + 20 * MIN, NOW + 40 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.via, r.by], ['created', 'person', 'staff@example.com']);
  assert.equal(world().posts.length, 1);
});

test('a name a person typed stands when the card is made again', async () => {
  world().payments.push(hand({ id: 'zp_oak', created: Math.floor(Date.parse('2026-11-04T16:00:00Z') / 1000), contact: 'ct_oak', buyer: buyer('Oakline', 'Builders') }));
  await runs(NOW, NOW + 10 * MIN);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, name: 'Dana Whitfield' }), /may be this check/);
  world().payments = world().payments.filter((p) => p.id !== 'zp_oak');
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null });
  await run(NOW + 70 * MIN);
  const c = await card();
  assert.equal(c.card.name, 'Dana Whitfield');
});

test('a card refreshed with nothing new keeps its version, so a person filling it in is never told it changed', async () => {
  await runs(NOW, NOW + 10 * MIN);
  const before = (await card()).ver;
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null });
  await run(NOW + 70 * MIN);
  assert.equal((await card()).ver, before);
});

test('an older screen never overrules a newer answer', async () => {
  await runs(NOW, NOW + 10 * MIN);
  const old = (await card()).ver;
  const k = (await card()).card;
  await dontSend(TX, 'refund', { now: NOW + 15 * MIN });
  await assert.rejects(CG.personSend(env(), TX, { name: k.name, donor: 'new', formId: k.formId, day: k.day, saw: old, by: 'staff@example.com', now: NOW + 16 * MIN, fetchImpl: fakeFetch }), /changed|moved on/);
  assert.equal(world().posts.length, 0);
});

test('an unreadable check still gets a card, for the person to type who it\'s from', async () => {
  world().reading = (m) => read({ payer: m.includes('kimi') ? 'Pine Foundation' : 'Oakline Builders' });
  world().txns[TX] = { ...world().txns[TX], counterpartyName: 'Check' };
  await runs(NOW, NOW + 40 * MIN);
  const c = await card();
  assert.equal(c.state, 'person');
  assert.equal(c.card.name, '');
  assert.ok(c.card.notes.some((n) => n.kind === 'unreadable'));
  await assert.rejects(approve(TX, { now: NOW + 45 * MIN }), /say who it’s from/);
  await approve(TX, { now: NOW + 45 * MIN, name: 'Pine Foundation' });
  assert.equal(world().posts.length, 1);
});

test('the money Mercury turns down after a send is flagged, and a card for a check Mercury turned down can\'t be sent', async () => {
  await runs(NOW, NOW + 10 * MIN);
  world().txns[TX] = { ...world().txns[TX], status: 'failed' };
  await runs(NOW + 15 * MIN, NOW + 20 * MIN);
  const r = await rowOf();
  assert.equal(r.state, 'came-back');
  await assert.rejects(approve(TX, { now: NOW + 25 * MIN }), /No card to send|moved on|didn’t take/);
  assert.equal(world().posts.length, 0);
});

// ── Donor-advised fund gifts (from a review of the DAF matching, Nov 10) ──────────────────────────────────────────────
const daf = (o = {}) => hand({ type: 'online', payment_method: { type: 'daf', brand: null, last4: null }, ...o });

test('one fund check paying two of its donors\' DAF gifts shows both on the card', async () => {
  world().reading = read({ payer: 'Fidelity Charitable', amount: 2500 });
  world().txns[TX] = { ...world().txns[TX], amount: 2500 };
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: NOW });
  world().payments.push(
    daf({ id: 'zp_d1', amount: 100000, status: 'pending', created: Math.floor(Date.parse('2026-10-20T16:00:00Z') / 1000), contact: 'ct_a', buyer: buyer('Ann', 'Lee') }),
    daf({ id: 'zp_d2', amount: 150000, status: 'pending', created: Math.floor(Date.parse('2026-10-22T16:00:00Z') / 1000), contact: 'ct_b', buyer: buyer('Bo', 'Chen') }),
  );
  await runs(NOW, NOW + 10 * MIN);
  const c = await card();
  assert.ok(c.card.notes.some((n) => n.kind === 'maybe-double'));
  assert.deepEqual(c.candidates.map((x) => x.id).sort(), ['zp_d1', 'zp_d2']);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN }), (e) => e.entries?.length === 2);
  assert.equal(world().posts.length, 0);
});

test('a DAF gift left Due for over a year is abandoned: it never sits on a later check\'s card', async () => {
  world().payments.push(daf({ id: 'zp_old', amount: 1000000, status: 'pending', created: Math.floor(Date.parse('2024-09-01T16:00:00Z') / 1000), contact: 'ct_j', buyer: buyer('Jane', 'Smith') }));
  await runs(NOW, NOW + 10 * MIN);
  const c = await card();
  assert.equal(c.reason, 'ready');
  assert.equal(c.candidates, null);
});

test('a hand entry matched by itself and then deleted in Zeffy: the check gets a card, and the hourly look keeps working', async () => {
  world().payments.push(hand({ id: 'zp_hand', created: Math.floor(Date.parse('2026-11-04T16:00:00Z') / 1000), contact: 'ct_pine' }));
  await runs(NOW, NOW + 10 * MIN);
  assert.equal((await rowOf()).state, 'linked');
  world().payments = world().payments.filter((p) => p.id !== 'zp_hand');
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null });
  await run(NOW + 70 * MIN);
  let r = await rowOf();
  assert.deepEqual([r.state, r.reason], ['person', 'record-gone']);
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null });
  await run(NOW + 140 * MIN);
  assert.equal((await readState(env().DB, 'check-gifts')).matchFailing ?? null, null, 'the hourly look didn’t fail');
  const c = await card();
  assert.ok(c.card.notes.some((n) => n.kind === 'record-gone'));
  assert.equal(c.card.name, 'Pine Foundation');
  await approve(TX, { now: NOW + 145 * MIN });
  assert.equal(world().posts.length, 1);
});

test('each donor on a card says which of its names it is, so the page keeps who it\'s from and the donor agreeing', async () => {
  world().payments.push(gift({ contact: 'ct_a', buyer: buyer('Pine', 'Foundation', 'office@pine.example', OAK) }));
  world().contacts.ct_a = { id: 'ct_a', email: 'office@pine.example', first_name: 'Pine', last_name: 'Foundation', donation_count: 1 };
  await runs(NOW, NOW + 10 * MIN);
  const c = await card();
  assert.deepEqual(c.card.donors.map((d) => [d.id, d.for, d.sureFor]), [['ct_a', ['Pine Foundation'], ['Pine Foundation']]]);
});

test('the Zeffy donor has to be who it\'s from: a gift is never filed under someone else\'s contact', async () => {
  world().contacts.ct_rosa = { id: 'ct_rosa', email: 'rosa.whitfield@example.com', first_name: 'Rosa', last_name: 'Whitfield', donation_count: 2 };
  await runs(NOW, NOW + 10 * MIN);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, donor: 'ct_rosa' }), /That Zeffy donor is Rosa Whitfield, and the gift would go in under their name\. Pick the Zeffy donor for Pine Foundation/);
  assert.equal(world().posts.length, 0);
  // Who it's from said as her: it goes on her
  await approve(TX, { now: NOW + 16 * MIN, donor: 'ct_rosa', name: 'Rosa Whitfield' });
  assert.equal(world().payments.at(-1).contact, 'ct_rosa');
});

test('an email for a donor with none, that another donor holds, is asked about before anything is sent', async () => {
  await env().DB.prepare('INSERT INTO check_payers (key, name, contact_id, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?)').bind('pine foundation', 'Pine Foundation', 'c_pine', 'form_home', 'x').run();
  world().contacts.c_pine = { id: 'c_pine', email: null, first_name: 'Pine', last_name: 'Foundation', donation_count: 3 };
  world().contacts.ct_other = { id: 'ct_other', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 2 };
  await runs(NOW, NOW + 10 * MIN);
  assert.equal((await card()).card.donor, 'c_pine');
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, email: 'dana@example.com' }), /already has dana@example\.com on Dana Whitfield/);
  assert.equal(world().posts.length, 0);
  assert.ok((await card()).card.donors.some((d) => d.id === 'ct_other' && !d.for.length), 'that donor is on the card to pick, tied to no name: an email typed is no proof of who they are');
  // Picked for Pine Foundation, it's refused: the gift would go in under Dana's name
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, donor: 'ct_other', email: '' }), /That Zeffy donor is Dana Whitfield/);
  // Without the email it files under their own contact, which keeps no email
  await approve(TX, { now: NOW + 16 * MIN, email: '' });
  assert.equal(world().payments.at(-1).contact, 'c_pine');
  assert.equal(world().contacts.c_pine.email, null);
});

test('a joint check: the other spouse\'s donor is the joint name\'s, never the letter writer\'s, on the card and at Send', async () => {
  const elena = { id: 'ct_elena', name: 'Elena Abernathy', email: '', gifts: 2, last: 0, address: null, sure: true, for: ['Marcus and Elena Abernathy'], sureFor: ['Marcus and Elena Abernathy'] };
  assert.equal(CG.pickDonor([elena], null, 'Marcus Abernathy'), 'new', 'Marcus starts on a new donor');
  assert.equal(CG.pickDonor([elena], null, 'Marcus and Elena Abernathy'), 'ct_elena', 'the joint name starts on Elena');
  await runs(NOW, NOW + 10 * MIN);
  world().contacts.ct_elena = { id: 'ct_elena', email: null, first_name: 'Elena', last_name: 'Abernathy', donation_count: 2 };
  const row = await rowOf();
  const k = JSON.parse(row.card);
  await env().DB.prepare('UPDATE check_gifts SET card = ? WHERE id = ?').bind(JSON.stringify({ ...k, names: [{ name: 'Marcus Abernathy', from: 'letter' }, { name: 'Marcus and Elena Abernathy', from: 'check' }], name: 'Marcus Abernathy', donors: [elena], donor: 'new' }), TX).run();
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN, name: 'Marcus Abernathy', donor: 'ct_elena' }), /That Zeffy donor is Elena Abernathy/);
  assert.equal(world().posts.length, 0);
  await approve(TX, { now: NOW + 16 * MIN, name: 'Marcus and Elena Abernathy', donor: 'ct_elena' });
  assert.equal(world().payments.at(-1).contact, 'ct_elena');
});

test('a donor Send turned up under a typed name stays on the card, with the name, when the card is made again', async () => {
  world().reading = read({ payer: '', remitter: '' });
  world().contacts.ct_rosa = { id: 'ct_rosa', email: 'rosa.whitfield@example.com', first_name: 'Rosa', last_name: 'Whitfield', donation_count: 2 };
  world().payments.push(gift({ contact: 'ct_rosa', buyer: buyer('Rosa', 'Whitfield', 'rosa.whitfield@example.com') }));
  await runs(NOW, NOW + 40 * MIN);
  assert.equal((await rowOf()).state, 'person', 'its card is made, with nobody read off the check');
  await assert.rejects(approve(TX, { now: NOW + 45 * MIN, name: 'Rosa Whitfield', donor: 'new' }), /already has a donor named Rosa Whitfield/);
  // Hours on, the card is made again
  await runs(NOW + 61 * MIN, NOW + 3 * 61 * MIN, 61 * MIN);
  const c = await card();
  assert.equal(c.card.name, 'Rosa Whitfield', 'the name typed stands');
  assert.ok(c.card.donors.some((d) => d.id === 'ct_rosa'), 'her donor is still there to pick');
  await approve(TX, { now: NOW + 4 * 61 * MIN, donor: 'ct_rosa' });
  assert.equal(world().payments.at(-1).contact, 'ct_rosa');
});

test('the page is told whose the letter\'s email is', async () => {
  await runs(NOW, NOW + 10 * MIN);
  const k = JSON.parse((await rowOf()).card);
  await env().DB.prepare('UPDATE check_gifts SET card = ? WHERE id = ?').bind(JSON.stringify({ ...k, email: 'priyanka@example.com', emailFor: 'Priyanka Holloway' }), TX).run();
  assert.equal((await card()).card.emailFor, 'Priyanka Holloway');
});

test('a send Zeffy never showed, then the check marked not for Zeffy: if its record turns up, the check says to delete it, until it\'s gone', async () => {
  await runs(NOW, NOW + 10 * MIN);
  // Zeffy saves the record but answers nothing, and doesn't show it for an hour
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  await assert.rejects(approve(TX, { now: NOW + 15 * MIN }), /don’t send this one again/);
  world().fail = null;
  const saved = world().payments.find((p) => p.amount === 1000000);
  world().payments = world().payments.filter((p) => p !== saved);
  await runs(NOW + 20 * MIN, NOW + 55 * MIN);
  assert.equal((await rowOf()).state, 'person', 'given up on after half an hour, back on its card');
  await dontSend(TX, 'event', { now: NOW + 60 * MIN });
  assert.equal((await rowOf()).state, 'left-out');
  // The record shows up
  world().payments.push(saved);
  world().slack = [];
  await runs(NOW + 65 * MIN, NOW + 80 * MIN);
  const r = await rowOf();
  assert.equal(r.extra, saved.id);
  const c = await card();
  assert.equal(c.toDo, true);
  assert.match(c.why, /Delete that one in Zeffy/);
  assert.match(slackSaid(), /marked not for Zeffy has a record in Zeffy/);
  // Deleted in Zeffy: the to-do goes at the next hourly look
  world().payments = world().payments.filter((p) => p !== saved);
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null });
  await runs(NOW + 2 * 60 * MIN, NOW + 2 * 60 * MIN + 10 * MIN);
  assert.equal((await rowOf()).extra, null);
  assert.equal((await card()).toDo, false);
});

test('"Send a new record" given on a card that was made again behind the question is refused, not sent', async () => {
  world().payments.push(hand({ id: 'zp_maybe', created: Math.floor(Date.parse('2026-11-03T16:00:00Z') / 1000), buyer: buyer('Oak', 'Trust') }));
  await runs(NOW, NOW + 10 * MIN);
  const asked = await approve(TX, { now: NOW + 15 * MIN }).then(() => null, (e) => e);
  assert.ok(asked?.entries?.length && asked.ver, 'Send asks about the entry, and says which version it asked on');
  // While the question is open, the card is made again with another address from the letter
  const k = JSON.parse((await rowOf()).card);
  await env().DB.prepare('UPDATE check_gifts SET card = ? WHERE id = ?').bind(JSON.stringify({ ...k, letterAddress: { line1: '9 Elm St', city: 'Decatur', state: 'GA', postal_code: '30030', country: 'US' } }), TX).run();
  await assert.rejects(approve(TX, { now: NOW + 16 * MIN, notThose: true, shown: asked.entries.map((x) => x.id), saw: asked.ver }), /just changed/);
  assert.equal(world().posts.length, 0);
  // Answered on the card as it is now, it goes
  const v = (await card()).ver;
  assert.equal((await approve(TX, { now: NOW + 17 * MIN, notThose: true, shown: asked.entries.map((x) => x.id), saw: v })).result, 'created');
});

test('each name on a card comes with the form the site\'s own rule gives it (the memo first), so picking a name never drops it', async () => {
  world().forms.push({ id: 'form_holiday', type: 'donation_form', status: 'active', title: 'Holiday Room Makeovers 2026' });
  world().reading = read({ memo: 'Holiday rooms' });
  await runs(NOW, NOW + 10 * MIN);
  const k = (await card()).card;
  assert.equal(k.formId, 'form_holiday');
  assert.deepEqual(k.formFor, { 'Pine Foundation': 'form_holiday' });
});
