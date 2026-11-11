/**
 * The donor's address and the letter with a check (Peter, Nov 10 2026): a check waits for 7 PM Eastern on its deposit
 * day, a letter attached in Mercury that day is read first and is the source of truth for who the gift is from and where
 * its receipt goes, and the address (the letter's, else the check's) goes on the donor's Zeffy contact once the record
 * is in. Against the spec-faithful fakes in tests/lib/check-gifts-harness-2.mjs. Names and addresses are made up.
 * Run: node --test tests/check-gifts-letters.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { W, CG, setup, rowOf, fakeFetch, hand, read, txn, mirrorTransaction, writeState, readState, slackSaid, MIN, DAY, TX } from './lib/check-gifts-harness-2.mjs';

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const env = () => W.env;
const world = () => W.world;
const [KIMI, QWEN] = ['@cf/moonshotai/kimi-k2.6', '@cf/qwen/qwen3.8-27b'];

// Deposited at 10 AM Eastern on Nov 10; 7 PM Eastern that day is midnight UTC
const DEPOSIT = '2026-11-10T15:00:00Z';
const T0 = Date.parse('2026-11-10T15:05:00Z');
const EVENING = Date.parse('2026-11-11T00:00:00Z');

const OAK = { street: '12 Oak St', city: 'Roswell', state: 'GA', zip: '30075' };
const PINE = { street: '40 Pine Rd Apt 2', city: 'Marietta', state: 'GA', zip: '30062-1234' };
const LETTER = { fileName: 'letter.jpg', url: 'https://files.mercury.test/letter.jpg', attachmentType: 'receipt' };
const letter = (o = {}) => ({ aboutGift: true, recordAs: 'Dana Whitfield', email: 'dana@example.com', street: PINE.street, city: PINE.city, state: PINE.state, zip: PINE.zip, amount: 10000, ...o });
const answer = (v, model) => (typeof v === 'function' ? v(model) : v);

/** The fakes, with letters: the readers answer a letter's prompt with world.letter, and files can differ by address */
const files = {};
const fetchWithFiles = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (files[url]) return new Response(files[url], { status: 200 });
  return fakeFetch(input, init);
};

async function fresh({ address = true } = {}) {
  await setup();
  globalThis.fetch = fetchWithFiles;
  for (const k of Object.keys(files)) delete files[k];
  world().letter = letter();
  world().reading = read({ ...OAK });
  env().AI = {
    run: async (model, input) => {
      world().aiCalls++;
      const prompt = String(input?.messages?.[0]?.content || '');
      return { response: answer(prompt.startsWith('You read one page') ? world().letter : world().reading, model) };
    },
    toMarkdown: async () => ({ data: world().pdfText ?? '' }),
  };
  const cfg = await readState(env().DB, 'check-gifts');
  await writeState(env().DB, 'check-gifts', { writeTest: { ...cfg.writeTest, ...(address ? { address: { ok: true } } : {}) } });
  await CG.setMode(env(), 'on');
  // Deposited this morning
  world().txns[TX] = txn({ createdAt: DEPOSIT });
  await env().DB.prepare('DELETE FROM mercury_txns').run();
  await mirrorTransaction(env().DB, world().txns[TX], { now: T0 });
}
const run = (now) => CG.runChecks(env(), { now, fetchImpl: fetchWithFiles });
const attach = (...more) => { world().txns[TX] = { ...world().txns[TX], attachments: [...world().txns[TX].attachments, ...more] }; };
const contactOf = (p) => world().contacts[p.contact];
/** Runs every 5 minutes from one time to another */
async function runs(from, to) { for (let t = from; t <= to; t += 5 * MIN) await run(t); }
// Runs that carry on past a run that stopped (Zeffy or Mercury not answering), as the heartbeat does
const runQuiet = (now) => run(now).catch((e) => ({ error: e.message }));
async function quiet(from, to, step = 5 * MIN) { for (let t = from; t <= to; t += step) await runQuiet(t); }
const detachLetters = () => { world().txns[TX] = { ...world().txns[TX], attachments: world().txns[TX].attachments.filter((a) => a.attachmentType === 'checkImage') }; };

beforeEach(() => fresh());

test('7 PM Eastern on the deposit day, in winter and summer; a deposit in the hour before waits a day', () => {
  assert.equal(new Date(CG.saveAt('2026-11-10T15:00:00Z')).toISOString(), '2026-11-11T00:00:00.000Z');
  assert.equal(new Date(CG.saveAt('2026-07-10T15:00:00Z')).toISOString(), '2026-07-10T23:00:00.000Z');
  // 6:30 PM Eastern
  assert.equal(new Date(CG.saveAt('2026-11-10T23:30:00Z')).toISOString(), '2026-11-12T00:00:00.000Z');
  // 9 PM Eastern is still Nov 10 there: the next evening
  assert.equal(new Date(CG.saveAt('2026-11-11T02:00:00Z')).toISOString(), '2026-11-12T00:00:00.000Z');
});

test('a check waits for 7 PM, then goes in with the address printed on it, which goes on the donor', async () => {
  await runs(T0, T0 + 60 * MIN);
  assert.equal((await rowOf()).state, 'read');
  assert.equal(world().posts.length, 0, 'nothing is saved before 7 PM');
  const view = (await CG.checksView(env(), { now: T0 + 60 * MIN })).list[0];
  assert.ok(view.waitsUntil, 'the page says it goes in at 7 PM');
  assert.equal(view.address.line, '12 Oak St, Roswell, GA 30075');
  await runs(EVENING, EVENING + 10 * MIN);
  const p = world().payments.at(-1);
  assert.equal(world().posts.length, 1);
  assert.deepEqual(contactOf(p).address, { line1: '12 Oak St', city: 'Roswell', state: 'GA', postal_code: '30075', country: 'US' });
  assert.equal((await rowOf()).address_done, 'written');
  assert.equal((await CG.checksView(env())).list[0].address.inZeffy, true);
});

test('readers that disagree about the address, or a cashier\'s check, put no address anywhere', async () => {
  world().reading = (m) => read({ ...OAK, street: m === KIMI ? '12 Oak St' : '21 Oak St' });
  await runs(T0, EVENING + 10 * MIN);
  assert.equal((await rowOf()).address, null);
  assert.equal(world().patches.filter((x) => x.address).length, 0);

  await fresh();
  world().reading = read({ ...OAK, payer: 'First Bank', cashiersCheck: true, remitter: 'Dana Whitfield' });
  await runs(T0, T0 + 10 * MIN);
  const r = await rowOf();
  assert.equal(r.payer, 'Dana Whitfield');
  assert.equal(r.address, null, 'a cashier\'s check prints the bank\'s address');
});

test('a street line holding six or more digits in a row never gets through', () => {
  assert.equal(CG.addressOf({ street: '123456789 Main St', city: 'Roswell', state: 'GA', zip: '30075' }), null);
  assert.equal(CG.addressOf({ street: 'Acct 0001234567', city: 'Roswell', state: 'GA', zip: '30075' }), null);
  assert.ok(CG.addressOf({ street: '12 Oak St', city: 'Roswell', state: 'GA', zip: '30075-1234' }));
  // A part missing: Zeffy takes an address only whole
  assert.equal(CG.addressOf({ street: '12 Oak St', city: '', state: 'GA', zip: '30075' }), null);
});

test('a letter attached that day: the gift goes in under the letter\'s name, and its email and address go on that donor', async () => {
  await runs(T0, T0 + 10 * MIN);
  attach(LETTER);
  await runs(T0 + 20 * MIN, T0 + 40 * MIN);
  let v = (await CG.checksView(env())).list[0];
  assert.deepEqual([v.letter.name, v.letter.email, v.payer], ['Dana Whitfield', 'dana@example.com', 'Pine Foundation'], 'read before 7 PM; nothing decided yet');
  assert.equal(world().posts.length, 0);
  await runs(EVENING, EVENING + 10 * MIN);
  const sent = world().posts[0];
  // Filed by name: an email files a record only on a donor already holding it under the giver's name
  assert.deepEqual([sent.first_name, sent.last_name, sent.email, sent.generate_tax_receipt, sent.send_confirmation_email], ['Dana', 'Whitfield', undefined, false, false]);
  const r = await rowOf();
  assert.deepEqual([r.payer, r.drawer], ['Dana Whitfield', 'Pine Foundation'], 'the name on the check is kept beside it');
  const c = contactOf(world().payments.at(-1));
  assert.equal(c.email, 'dana@example.com');
  assert.equal(c.address.line1, '40 Pine Rd Apt 2');
  assert.equal(c.address.postal_code, '30062', 'the first five only: nine digits in a row are never kept');
  v = (await CG.checksView(env())).list[0];
  assert.deepEqual([v.drawer, v.letter.name, v.letter.email, v.mailInZeffy], ['Pine Foundation', 'Dana Whitfield', 'dana@example.com', true]);
});

test('a letter attached a minute before 7 PM is still read before the check goes in', async () => {
  await runs(T0, T0 + 10 * MIN);
  await run(EVENING - 6 * MIN);
  attach(LETTER);
  await runs(EVENING, EVENING + 15 * MIN);
  assert.equal(world().posts[0]?.last_name, 'Whitfield');
});

test('a letter the readers don\'t agree on, or one for another amount, goes to a person, and nothing is saved', async () => {
  world().letter = (m) => letter({ recordAs: m === KIMI ? 'Dana Whitfield' : 'Marcus Lee' });
  await runs(T0, T0 + 10 * MIN);
  attach(LETTER);
  await runs(T0 + 20 * MIN, EVENING + 10 * MIN);
  let r = await rowOf();
  assert.deepEqual([r.state, r.reason, world().posts.length], ['person', 'letter', 0]);

  await fresh();
  world().letter = letter({ amount: 250 });
  await runs(T0, T0 + 10 * MIN);
  attach(LETTER);
  await runs(T0 + 20 * MIN, EVENING + 10 * MIN);
  r = await rowOf();
  assert.deepEqual([r.state, r.reason, world().posts.length], ['person', 'letter-amount', 0]);
  assert.match(slackSaid(), /different amount/);
});

test('a page that isn\'t about the gift (a deposit slip, an envelope) changes nothing', async () => {
  world().letter = letter({ aboutGift: false, recordAs: '' });
  await runs(T0, T0 + 10 * MIN);
  attach(LETTER);
  await runs(T0 + 20 * MIN, EVENING + 10 * MIN);
  assert.equal(world().posts[0].last_name, 'Foundation');
  assert.equal(contactOf(world().payments.at(-1)).address.line1, '12 Oak St');
  assert.equal((await CG.checksView(env())).list[0].drawer, null, 'no "check from" when the gift is the check writer\'s');
});

test('a scanned PDF with no text in it, or a file the readers can\'t open, goes to a person', async () => {
  const pdf = 'https://files.mercury.test/letter.pdf';
  files[pdf] = new TextEncoder().encode('%PDF-1.7 pictures only');
  world().pdfText = '';
  await runs(T0, T0 + 10 * MIN);
  attach({ fileName: 'letter.pdf', url: pdf, attachmentType: 'receipt' });
  await runs(T0 + 20 * MIN, EVENING + 10 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.reason, world().posts.length], ['person', 'letter', 0]);
});

test('a PDF with text is read as text', async () => {
  const pdf = 'https://files.mercury.test/letter.pdf';
  files[pdf] = new TextEncoder().encode('%PDF-1.7 typed');
  world().pdfText = 'Please acknowledge this gift as from Dana Whitfield, 40 Pine Rd Apt 2, Marietta GA 30062. Thank you for your work.';
  await runs(T0, T0 + 10 * MIN);
  attach({ fileName: 'letter.pdf', url: pdf, attachmentType: 'other' });
  await runs(T0 + 20 * MIN, EVENING + 10 * MIN);
  assert.equal(world().posts[0].last_name, 'Whitfield');
});

test('more files beside a check than the site reads go to a person', async () => {
  await runs(T0, T0 + 10 * MIN);
  attach(...[1, 2, 3, 4, 5].map((n) => ({ fileName: `page${n}.jpg`, url: `https://files.mercury.test/p${n}.jpg`, attachmentType: 'receipt' })));
  await runs(T0 + 20 * MIN, EVENING + 10 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.reason, world().posts.length], ['person', 'letter-many', 0]);
});

test('a check nobody could read stays with a person: a letter added then doesn\'t decide it', async () => {
  world().reading = (m) => read({ payer: m === KIMI ? 'Pine Foundation' : 'Oakline Builders' });
  await runs(T0, T0 + 30 * MIN);
  attach(LETTER);
  await runs(T0 + 35 * MIN, EVENING + 10 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.reason, world().posts.length], ['person', 'unreadable', 0]);
});

test('a file added after the record went in changes nothing by itself: a person is told once, and "Looked at it" clears it', async () => {
  await runs(T0, T0 + 10 * MIN);
  await runs(EVENING, EVENING + 10 * MIN);
  const p = world().payments.at(-1);
  const calls = world().aiCalls;
  attach(LETTER);
  await runs(EVENING + 20 * MIN, EVENING + 60 * MIN);
  assert.equal(world().aiCalls, calls, 'not read: a saved record is never changed by itself');
  assert.equal(contactOf(p).address.line1, '12 Oak St');
  assert.equal((await rowOf()).payer, 'Pine Foundation');
  let v = (await CG.checksView(env())).list[0];
  assert.equal(v.needsYou, true);
  assert.match(v.why, /A file was added in Mercury after this check went into Zeffy/);
  assert.equal(world().slack.filter((b) => /added to a check already in Zeffy/.test(b)).length, 1, 'told once');
  await CG.personLetterDone(env(), TX, { saw: v.ver, by: 'staff@example.com', now: EVENING + 65 * MIN });
  v = (await CG.checksView(env())).list[0];
  assert.equal(v.needsYou, false);
  // Another file later is told again
  attach({ fileName: 'page2.jpg', url: 'https://files.mercury.test/page2.jpg', attachmentType: 'receipt' });
  await runs(EVENING + 70 * MIN, EVENING + 80 * MIN);
  assert.equal((await CG.checksView(env())).list[0].needsYou, true);
});

test('a hand entry\'s donor keeps the address staff typed; one with none gets the check\'s', async () => {
  world().contacts.ct_typed = { id: 'ct_typed', email: null, first_name: 'Pine', last_name: 'Foundation', address: { line1: '9 Elm St', city: 'Alpharetta', state: 'GA', postal_code: '30009', country: 'US' } };
  world().payments.push(hand({ id: 'zp_typed', created: Math.floor(Date.parse(DEPOSIT) / 1000), contact: 'ct_typed' }));
  await runs(T0, T0 + 10 * MIN);
  await runs(EVENING, EVENING + 10 * MIN);
  let r = await rowOf();
  assert.deepEqual([r.state, r.address_done], ['linked', 'kept']);
  assert.equal(world().contacts.ct_typed.address.line1, '9 Elm St');

  await fresh();
  world().contacts.ct_typed = { id: 'ct_typed', email: null, first_name: 'Pine', last_name: 'Foundation', address: null };
  world().payments.push(hand({ id: 'zp_typed', created: Math.floor(Date.parse(DEPOSIT) / 1000), contact: 'ct_typed' }));
  await runs(T0, T0 + 10 * MIN);
  await runs(EVENING, EVENING + 10 * MIN);
  r = await rowOf();
  assert.deepEqual([r.state, r.address_done], ['linked', 'written']);
  assert.equal(world().contacts.ct_typed.address.line1, '12 Oak St');
});

test('an address only ever goes on a contact under the giver\'s name', async () => {
  // Matched to an entry typed under a fund advisor's name: that contact isn't the payer's
  world().contacts.ct_adv = { id: 'ct_adv', email: null, first_name: 'Marcus', last_name: 'Lee', address: null };
  world().payments.push(hand({ id: 'zp_adv', created: Math.floor(Date.parse(DEPOSIT) / 1000), contact: 'ct_adv', buyer: { first_name: 'Marcus', last_name: 'Lee', email: null, is_corporate: false, company_name: null } }));
  await runs(T0, T0 + 10 * MIN);
  const r = await rowOf();
  await CG.personLink(env(), TX, 'zp_adv', { saw: CG.versionOf(r), by: 'staff@example.com', now: EVENING, fetchImpl: fetchWithFiles });
  await runs(EVENING + 5 * MIN, EVENING + 15 * MIN);
  assert.equal((await rowOf()).address_done, 'not-theirs');
  assert.equal(world().contacts.ct_adv.address, null);
});

test('Zeffy refusing the address puts it in front of a person, and it clears once the address is there', async () => {
  world().fail = ({ method, path, body }) => (method === 'PATCH' && path.startsWith('/contacts/') && body?.address ? 422 : null);
  await runs(T0, T0 + 10 * MIN);
  await runs(EVENING, EVENING + 10 * MIN);
  let v = (await CG.checksView(env())).list[0];
  assert.equal(v.needsYou, true);
  assert.match(v.why, /Zeffy wouldn’t take the donor’s address\. Add it to Pine Foundation in Zeffy: 12 Oak St, Roswell, GA 30075\./);
  const tried = world().patches.length;
  // Not tried again the next run
  await run(EVENING + 20 * MIN);
  assert.equal(world().patches.length, tried);
  // Staff add it by hand; the next day's look sees it there
  world().fail = null;
  const c = contactOf(world().payments.at(-1));
  c.address = { line1: '12 OAK STREET', city: 'ROSWELL', state: 'GA', postal_code: '30075', country: 'US' };
  await run(EVENING + DAY + 20 * MIN);
  v = (await CG.checksView(env())).list[0];
  assert.equal(v.needsYou, false);
  assert.equal(world().patches.length, tried);
});

test('Zeffy not answering about the address is tried again, and after a day goes to a person', async () => {
  world().fail = ({ method, path }) => (method === 'PATCH' && path.startsWith('/contacts/') ? 503 : null);
  await runs(T0, T0 + 10 * MIN);
  await runs(EVENING, EVENING + 10 * MIN);
  const patches = () => world().log.filter((x) => x.startsWith('PATCH /contacts/')).length;
  const first = patches();
  assert.ok(first >= 1);
  await run(EVENING + 30 * MIN);
  assert.ok(patches() > first, 'tried again after 15 minutes');
  for (let t = EVENING + 45 * MIN; t <= EVENING + DAY + 30 * MIN; t += 15 * MIN) await run(t);
  assert.equal((await rowOf()).address_done, 'refused');
  assert.equal((await CG.checksView(env())).list[0].needsYou, true);
});

test('a letter\'s email that another donor holds in Zeffy never files the gift under them', async () => {
  world().contacts.ct_other = { id: 'ct_other', email: 'dana@example.com', first_name: 'Other', last_name: 'Person' };
  world().letter = letter({ recordAs: 'Pine Foundation' });
  await runs(T0, T0 + 10 * MIN);
  attach(LETTER);
  await runs(T0 + 20 * MIN, T0 + 40 * MIN);
  await runs(EVENING, EVENING + 10 * MIN);
  const p = world().payments.at(-1);
  assert.equal(world().posts[0].email, undefined, 'filed by name, not by the email');
  assert.notEqual(p.contact, 'ct_other');
  assert.equal(contactOf(p).address.line1, '40 Pine Rd Apt 2', 'the letter\'s address still goes on the giver');
  assert.equal(world().contacts.ct_other.address, undefined);
});

test('a letter\'s email fills the giver\'s blank email after the record is in, and never replaces one', async () => {
  world().letter = letter({ recordAs: 'Pine Foundation', street: '', city: '', state: '', zip: '' });
  await runs(T0, T0 + 10 * MIN); attach(LETTER); await runs(T0 + 20 * MIN, T0 + 40 * MIN);
  await runs(EVENING, EVENING + 15 * MIN);
  const c = contactOf(world().payments.at(-1));
  assert.equal(c.email, 'dana@example.com');
  assert.equal(c.address.line1, '12 Oak St', 'no address in the letter: the check\'s');

  await fresh();
  await env().DB.prepare('INSERT INTO check_payers (key, name, contact_id, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?)').bind('pine foundation', 'Pine Foundation', 'c_pine', 'form_home', 'x').run();
  world().contacts.c_pine = { id: 'c_pine', email: 'office@pine.example', first_name: 'Pine', last_name: 'Foundation', donation_count: 3 };
  world().letter = letter({ recordAs: 'Pine Foundation', street: '', city: '', state: '', zip: '' });
  await runs(T0, T0 + 10 * MIN); attach(LETTER); await runs(T0 + 20 * MIN, T0 + 40 * MIN);
  await runs(EVENING, EVENING + 15 * MIN);
  assert.equal(world().payments.at(-1).contact, 'c_pine');
  assert.equal(world().contacts.c_pine.email, 'office@pine.example');
});

test('the write test puts an address on a test contact and removes it; addresses wait until it has', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: { id: '2026-11-07', ok: true, steps: [{ what: 'two names' }], join: { ok: true } } });
  await run(T0);
  const t = (await readState(env().DB, 'check-gifts')).writeTest;
  assert.equal(t.id, CG.WRITE_TEST);
  assert.equal(t.address.ok, true, JSON.stringify(t.address));
  assert.ok(world().patches.some((x) => x.address?.line1 === '1 Test Way'));
  assert.equal(Object.values(world().contacts).filter((c) => /WebsiteTest/.test(`${c.first_name} ${c.last_name}`)).length, 0, 'the test contacts are gone');

  await fresh({ address: false });
  await runs(T0, T0 + 10 * MIN);
  await runs(EVENING, EVENING + 10 * MIN);
  assert.equal(world().posts.length, 1, 'checks still go in');
  assert.equal(world().patches.filter((x) => x.address).length, 0, 'no address before the test proved it');
});

test('a letter the site couldn\'t trust lends a person\'s save nothing', async () => {
  world().letter = (m) => letter({ recordAs: m === KIMI ? 'Dana Whitfield' : 'Marcus Lee' });
  await runs(T0, T0 + 10 * MIN); attach(LETTER); await runs(T0 + 20 * MIN, T0 + 40 * MIN); await runs(EVENING, EVENING + 10 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.reason, r.payer], ['person', 'letter', 'Pine Foundation']);
  await CG.personCreate(env(), TX, { name: 'Dana Whitfield', formId: 'form_home', saw: CG.versionOf(r), by: 'staff@example.com', now: EVENING + 20 * MIN, fetchImpl: fetchWithFiles });
  assert.equal(world().posts[0].email, undefined);
  await runs(EVENING + 25 * MIN, EVENING + 40 * MIN);
  assert.equal(contactOf(world().payments.at(-1)).address ?? null, null, 'the check\'s address is Pine\'s, not Dana\'s');

  await fresh();
  world().letter = letter({ amount: 250 });
  await runs(T0, T0 + 10 * MIN); attach(LETTER); await runs(T0 + 20 * MIN, T0 + 40 * MIN); await runs(EVENING, EVENING + 10 * MIN);
  const r2 = await rowOf();
  assert.equal(r2.reason, 'letter-amount');
  await CG.personCreate(env(), TX, { name: 'Dana Whitfield', formId: 'form_home', saw: CG.versionOf(r2), by: 'staff@example.com', now: EVENING + 20 * MIN, fetchImpl: fetchWithFiles });
  assert.equal(world().posts[0].email, undefined, 'a letter about another amount says nothing about this check');
});

test('R1 a letter naming someone else never hides the check writer\'s open pledge or near entry: no second record', async () => {
  world().payments.push(hand({ id: 'zp_pledge', status: 'pending', created: Math.floor(Date.parse('2026-09-01T16:00:00Z') / 1000), contact: 'ct_pine' }));
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 20 * MIN, T0 + 40 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  assert.equal(world().posts.length, 0);
  assert.equal((await rowOf()).reason, 'pledge');

  await fresh();
  world().payments.push(hand({ id: 'zp_typo', amount: 100000, created: Math.floor(Date.parse(DEPOSIT) / 1000), contact: 'ct_pine' }));
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 20 * MIN, T0 + 40 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  assert.equal(world().posts.length, 0);
  assert.equal((await rowOf()).reason, 'amount-differs');
});

test('R1c a letter attached after a person was asked about a Zeffy entry leaves the question with them', async () => {
  world().payments.push(hand({ id: 'zp_pledge', status: 'pending', created: Math.floor(Date.parse('2026-09-01T16:00:00Z') / 1000), contact: 'ct_pine' }));
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  assert.equal((await rowOf()).reason, 'pledge');
  attach(LETTER); await quiet(EVENING + 720 * MIN, EVENING + 780 * MIN);
  const r = await rowOf();
  assert.deepEqual([world().posts.length, r.state, r.reason, r.payer], [0, 'person', 'pledge', 'Pine Foundation']);
});

test('R1d an insurer\'s check stays out whatever name a letter gives', async () => {
  world().reading = read({ ...OAK, payer: 'State Farm Mutual Automobile Insurance Company' });
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 20 * MIN, T0 + 40 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  assert.equal(world().posts.length, 0);
  assert.equal((await rowOf()).state, 'left-out');
});

test('R2 the address and the letter\'s email never go on an advisor\'s contact that holds a fund\'s entry', async () => {
  world().contacts.ct_adv = { id: 'ct_adv', email: null, first_name: 'Marcus', last_name: 'Lee', address: null };
  world().payments.push(hand({ id: 'zp_fund', created: Math.floor(Date.parse(DEPOSIT) / 1000), contact: 'ct_adv' }));
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 15 * MIN);
  assert.equal((await rowOf()).zeffy_id, 'zp_fund');
  assert.equal(world().contacts.ct_adv.address ?? null, null);

  await fresh();
  world().contacts.ct_adv = { id: 'ct_adv', email: null, first_name: 'Marcus', last_name: 'Lee', address: null };
  world().payments.push(hand({ id: 'zp_fund', created: Math.floor(Date.parse(DEPOSIT) / 1000), contact: 'ct_adv' }));
  world().letter = letter({ recordAs: 'Pine Foundation', email: 'grants@pine.example', street: '', city: '', state: '', zip: '' });
  world().reading = read({ street: '', city: '', state: '', zip: '' });
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 20 * MIN, T0 + 40 * MIN); await quiet(EVENING, EVENING + 15 * MIN);
  assert.equal(world().contacts.ct_adv.email, null);
});

test('R3 an entry a person matched keeps the address staff typed on its donor', async () => {
  world().contacts.ct_typed = { id: 'ct_typed', email: null, first_name: 'Pine', last_name: 'Foundation', address: { line1: '9 Elm St', city: 'Alpharetta', state: 'GA', postal_code: '30009', country: 'US' } };
  world().payments.push(hand({ id: 'zp_typed', created: Math.floor(Date.parse(DEPOSIT) / 1000), contact: 'ct_typed' }));
  await quiet(T0, T0 + 10 * MIN);
  await CG.personLink(env(), TX, 'zp_typed', { saw: CG.versionOf(await rowOf()), by: 'staff@example.com', now: T0 + 15 * MIN, fetchImpl: fetchWithFiles });
  await quiet(T0 + 20 * MIN, T0 + 40 * MIN);
  assert.equal(world().contacts.ct_typed.address.line1, '9 Elm St');
});

test('R4 a file added while Zeffy was still answering: the record that turns up is a to-do', async () => {
  await quiet(T0, T0 + 10 * MIN); world().postFails = 'timeout'; await runQuiet(EVENING); world().postFails = null;
  attach(LETTER); await quiet(EVENING + 5 * MIN, EVENING + 60 * MIN);
  const sent = world().posts[0];
  world().payments = world().payments.filter((x) => x.campaign_id !== sent.campaign_id || x.amount !== sent.amount);
  world().payments.push(hand({ id: 'zp_late', amount: sent.amount, campaign_id: sent.campaign_id, contact: 'ct_x', created: Math.floor(Date.parse(sent.payment_date) / 1000) }));
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null }); await runQuiet(EVENING + 70 * MIN);
  assert.equal((await rowOf()).zeffy_id, 'zp_late');
  const v = (await CG.checksView(env())).list[0];
  assert.ok(v.needsYou);
  assert.match(v.why, /A file was added in Mercury after this check went into Zeffy/);
});

test('R10 a giver Zeffy already knows stays on their one donor; the letter\'s email fills their blank one after', async () => {
  await env().DB.prepare('INSERT INTO check_payers (key, name, contact_id, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?)').bind('pine foundation', 'Pine Foundation', 'c_pine', 'form_home', 'x').run();
  world().contacts.c_pine = { id: 'c_pine', email: null, first_name: 'Pine', last_name: 'Foundation', donation_count: 3 };
  world().letter = letter({ recordAs: 'Pine Foundation', email: 'office@pine.example' });
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 20 * MIN, T0 + 40 * MIN); await quiet(EVENING, EVENING + 15 * MIN);
  assert.equal(world().payments.at(-1).contact, 'c_pine');
  assert.equal(world().contacts.c_pine.email, 'office@pine.example');
});

test('R5 a refused address clears once any address is on the donor, and "Looked at it" clears it too', async () => {
  world().fail = ({ method, path, body }) => (method === 'PATCH' && path.startsWith('/contacts/') && body?.address ? 422 : null);
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  world().fail = null;
  world().contacts[world().payments.at(-1).contact].address = { line1: '12 Oak Ct', city: 'Roswell', state: 'GA', postal_code: '30076', country: 'US' };
  await runQuiet(EVENING + DAY + 20 * MIN);
  assert.equal((await CG.checksView(env())).list[0].needsYou, false);

  await fresh();
  world().fail = ({ method, path, body }) => (method === 'PATCH' && path.startsWith('/contacts/') && body?.address ? 422 : null);
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  let v = (await CG.checksView(env())).list[0];
  assert.equal(v.needsYou, true);
  await CG.personLetterDone(env(), TX, { saw: v.ver, by: 'staff@example.com', now: EVENING + 20 * MIN });
  v = (await CG.checksView(env())).list[0];
  assert.equal(v.needsYou, false);
});

test('R11 a letter\'s email Zeffy won\'t take for a day is a to-do', async () => {
  world().reading = read({ street: '', city: '', state: '', zip: '' });
  world().letter = letter({ recordAs: 'Pine Foundation', street: '', city: '', state: '', zip: '' });
  world().fail = ({ method, path }) => (method === 'PATCH' && path.startsWith('/contacts/') ? 503 : null);
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 20 * MIN, T0 + 40 * MIN);
  for (let t = EVENING; t <= EVENING + DAY + 60 * MIN; t += 20 * MIN) await runQuiet(t);
  const v = (await CG.checksView(env())).list[0];
  assert.equal((await rowOf()).address_done, 'refused');
  assert.ok(v.needsYou);
  assert.match(v.why, /Add it to Pine Foundation in Zeffy: dana@example\.com/);
});

test('R7 a file taken off and another put back under the same name is read', async () => {
  world().letter = letter({ aboutGift: false, recordAs: '', email: '', street: '', city: '', state: '', zip: '', amount: 0 });
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 15 * MIN, T0 + 40 * MIN);
  // Taken off (a look sees it gone), then the real letter put back under the same name
  world().txns[TX] = { ...world().txns[TX], attachments: [world().txns[TX].attachments[0]] };
  await quiet(T0 + 45 * MIN, T0 + 50 * MIN);
  world().txns[TX] = { ...world().txns[TX], attachments: [world().txns[TX].attachments[0], { ...LETTER, url: 'https://files.mercury.test/letter-2.jpg' }] };
  world().letter = letter();
  await quiet(T0 + 60 * MIN, T0 + 90 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  assert.equal(world().posts[0]?.last_name, 'Whitfield');
});

test('R6 a letter attached while the check waited a day for its picture is still read', async () => {
  world().txns[TX] = { ...world().txns[TX], attachments: [] };
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 15 * MIN, T0 + 30 * MIN);
  world().txns[TX] = { ...world().txns[TX], attachments: [{ fileName: 'front.jpg', url: 'https://files.mercury.test/front.jpg', attachmentType: 'checkImage' }, LETTER] };
  await quiet(T0 + 1560 * MIN, T0 + 1680 * MIN, 10 * MIN);
  const l = JSON.parse((await rowOf()).letter);
  assert.notEqual(l.why, 'letter');
  assert.equal(l.name, 'Dana Whitfield');
});

test('R9 Mercury not answering at 7 PM never sends a check to a person as Zeffy\'s fault', async () => {
  await quiet(T0, T0 + 10 * MIN); world().mercuryDown = true;
  await quiet(EVENING, EVENING + 30 * MIN, 10 * MIN);
  assert.equal(world().posts.length, 1, 'it goes in');
  assert.notEqual((await rowOf()).reason, 'zeffy-busy');
});

test('R8 no nine-digit ZIP is ever kept: a bank number read into the ZIP never gets through', () => {
  const a = CG.addressOf({ street: '12 Oak St', city: 'Roswell', state: 'GA', zip: '061000104' });
  assert.ok(!a || !CG.hasAccountDigits(a.postal_code));
  assert.equal(CG.agreeAddress(CG.addressOf({ ...OAK, zip: '30075' }), CG.addressOf({ ...OAK, zip: '300751234' }))?.postal_code, '30075');
});

test('P1 a letter taken off in Mercury before 7 PM stops counting: the check\'s own name and address go in', async () => {
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 15 * MIN, T0 + 40 * MIN);
  assert.equal(JSON.parse((await rowOf()).letter).name, 'Dana Whitfield');
  detachLetters(); await quiet(T0 + 120 * MIN, T0 + 140 * MIN); await quiet(EVENING, EVENING + 20 * MIN);
  const sent = world().posts[0];
  const c = world().contacts[world().payments.at(-1).contact];
  assert.deepEqual([sent.first_name, sent.last_name, c.email ?? null, c.address?.line1], ['Pine', 'Foundation', null, '12 Oak St']);
});

test('P6b a letter swapped for another under the same name between two looks is read again before it goes in', async () => {
  world().letter = letter({ recordAs: 'Marcus Lee', email: 'marcus@example.com' });
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 15 * MIN, T0 + 40 * MIN);
  assert.equal(JSON.parse((await rowOf()).letter).name, 'Marcus Lee');
  world().letter = letter();
  files['https://files.mercury.test/letter-right.jpg'] = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 217, 7]);
  world().txns[TX] = { ...world().txns[TX], attachments: [world().txns[TX].attachments[0], { ...LETTER, url: 'https://files.mercury.test/letter-right.jpg' }] };
  await quiet(T0 + 60 * MIN, T0 + 120 * MIN); await quiet(EVENING, EVENING + 20 * MIN);
  assert.equal(world().posts[0]?.last_name, 'Whitfield');
});

test('P6 two files under one name, the first taken off: the one left is read', async () => {
  world().letter = letter({ aboutGift: false, recordAs: '', email: '', street: '', city: '', state: '', zip: '', amount: 0 });
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 15 * MIN, T0 + 30 * MIN);
  world().letter = letter();
  files['https://files.mercury.test/letter-real.jpg'] = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 217, 9]);
  attach({ ...LETTER, url: 'https://files.mercury.test/letter-real.jpg' });
  world().txns[TX] = { ...world().txns[TX], attachments: [world().txns[TX].attachments[0], world().txns[TX].attachments[2]] };
  await quiet(T0 + 31 * MIN, T0 + 90 * MIN); await quiet(EVENING, EVENING + 20 * MIN);
  assert.equal(world().posts[0]?.last_name, 'Whitfield');
});

test('P3 a file added after a person matched the record is never called someone else\'s: only "look at it"', async () => {
  world().contacts.ct_dana = { id: 'ct_dana', email: null, first_name: 'Dana', last_name: 'Whitfield', address: null };
  world().payments.push(hand({ id: 'zp_dana', created: Math.floor(Date.parse(DEPOSIT) / 1000), contact: 'ct_dana', buyer: { first_name: 'Dana', last_name: 'Whitfield', email: null, is_corporate: false, company_name: null } }));
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  const r = await rowOf();
  await CG.personLink(env(), TX, 'zp_dana', { saw: CG.versionOf(r), by: 'staff@example.com', now: EVENING + 15 * MIN, fetchImpl: fetchWithFiles });
  attach(LETTER); await quiet(EVENING + 20 * MIN, EVENING + 40 * MIN);
  assert.doesNotMatch(slackSaid(), /someone else/);
  assert.match((await CG.checksView(env())).list[0].why, /A file was added/);
});

test('P5 after "Looked at it", a record retyped under another id gets no to-do', async () => {
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  attach(LETTER); await quiet(EVENING + 20 * MIN, EVENING + 40 * MIN);
  const v0 = (await CG.checksView(env())).list[0];
  await CG.personLetterDone(env(), TX, { saw: v0.ver, by: 'staff@example.com', now: EVENING + 45 * MIN });
  const first = world().payments.at(-1);
  world().payments = world().payments.filter((x) => x.id !== first.id);
  world().payments.push(hand({ id: 'zp_pine2', created: first.created, contact: first.contact }));
  await env().DB.prepare("UPDATE check_gifts SET posted_at = '2026-11-12T15:00:00Z', status = 'sent'").run();
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null }); await quiet(EVENING + 70 * MIN, EVENING + 80 * MIN);
  assert.equal((await rowOf()).zeffy_id, 'zp_pine2');
  assert.equal((await CG.checksView(env())).list[0].needsYou, false);
});

test('P4 a person\'s own save that Zeffy answers late is theirs: no "someone else\'s"', async () => {
  world().reading = read({ ...OAK, memo: 'Golf sponsorship' });
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 15 * MIN, T0 + 40 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  const r = await rowOf();
  assert.equal(r.reason, 'event');
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  await assert.rejects(CG.personCreate(env(), TX, { name: 'Pine Foundation', formId: 'form_home', saw: CG.versionOf(r), by: 'staff@example.com', now: EVENING + 20 * MIN, fetchImpl: fetchWithFiles }));
  world().fail = null; await quiet(EVENING + 25 * MIN, EVENING + 40 * MIN);
  const after = await rowOf();
  assert.deepEqual([after.state, after.via, after.by], ['created', 'person', 'staff@example.com']);
  assert.equal((await CG.checksView(env())).list[0].needsYou, false);
});

// ── Round 3 (Nov 10): letters steer only checks the site is still deciding ──────────────────────────────────────────
test('Z2 a check posted over 30 days ago still comes to a person at the switch to On, letter or not', async () => {
  await CG.setMode(env(), 'watch');
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  world().txns[TX] = { ...world().txns[TX], status: 'sent', postedAt: '2026-11-11T15:00:00Z' };
  await quiet(EVENING + DAY, EVENING + DAY + 10 * MIN);
  attach(LETTER);
  await CG.setMode(env(), 'on');
  await quiet(EVENING + 35 * DAY, EVENING + 35 * DAY + 60 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.reason, world().posts.length], ['person', 'old-check', 0]);
});

test('Z9 a 404 from Mercury for a moment while a letter is read doesn\'t lose the letter', async () => {
  await quiet(T0, T0 + 10 * MIN); attach(LETTER);
  let calls = 0;
  const f = async (i, o) => { const u = typeof i === 'string' ? i : i.url; if (u.includes('mercury-relay') && ++calls === 2) return new Response('{}', { status: 404 }); return fetchWithFiles(i, o); };
  await CG.runChecks(env(), { now: T0 + 15 * MIN, fetchImpl: f }).catch(() => null);
  await quiet(T0 + 20 * MIN, EVENING + 30 * MIN);
  assert.equal(world().posts[0]?.last_name, 'Whitfield');
});

test('Z7 Mercury listing the files in another order each time still lets the check go in', async () => {
  await quiet(T0, T0 + 10 * MIN);
  const note = { fileName: 'note.jpg', url: 'https://files.mercury.test/note.jpg', attachmentType: 'other' };
  attach(LETTER, note);
  await quiet(T0 + 15 * MIN, T0 + 60 * MIN);
  const base = world().txns[TX];
  let n = 0;
  Object.defineProperty(world().txns, TX, { configurable: true, enumerable: true, get() { const flip = Math.floor(n++ / 2) % 2; return { ...base, attachments: flip ? [base.attachments[0], LETTER, note] : [base.attachments[0], note, LETTER] }; }, set() {} });
  await quiet(EVENING, EVENING + 60 * MIN);
  assert.equal(world().posts.length, 1);
});

test('Z1 a file added to a saved check never holds up reading the next one, even with Zeffy failing', async () => {
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  const p = world().payments.at(-1);
  world().fail = ({ method, path }) => (method === 'GET' && path === `/payments/${p.id}` ? 503 : null);
  attach(LETTER);
  world().txns.tx_2 = txn({ id: 'tx_2', createdAt: '2026-11-11T14:00:00Z' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: EVENING + 15 * MIN });
  await quiet(EVENING + 20 * MIN, EVENING + 60 * MIN);
  assert.equal((await rowOf('tx_2')).state, 'read');
});

// ── Round 4 (Nov 10) ─────────────────────────────────────────────────────────────────────────────────────────────────
const oakline = () => hand({ id: 'zp_other', created: Math.floor(Date.parse(DEPOSIT) / 1000), contact: 'ct_oak', buyer: { first_name: 'Oakline', last_name: 'Builders', email: null, is_corporate: false, company_name: null } });

test('Q1 a letter attached while a person had the check is read once the site takes the check back', async () => {
  world().payments.push(oakline());
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  assert.equal((await rowOf()).reason, 'maybe-double');
  attach(LETTER); await quiet(EVENING + 15 * MIN, EVENING + 30 * MIN);
  world().payments = world().payments.filter((p) => p.id !== 'zp_other');
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null });
  await quiet(EVENING + 120 * MIN, EVENING + 200 * MIN);
  assert.equal(world().posts[0]?.last_name, 'Whitfield');
});

test('Q2 a letter taken off while a person had the check stops counting', async () => {
  world().payments.push(oakline());
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 15 * MIN, T0 + 40 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  assert.deepEqual([(await rowOf()).reason, (await rowOf()).payer], ['maybe-double', 'Dana Whitfield']);
  detachLetters();
  await quiet(EVENING + 15 * MIN, EVENING + 30 * MIN);
  world().payments = world().payments.filter((p) => p.id !== 'zp_other');
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null }); await quiet(EVENING + 120 * MIN, EVENING + 200 * MIN);
  assert.equal(world().posts[0]?.last_name, 'Foundation');
  const c = contactOf(world().payments.at(-1));
  assert.equal(c.email ?? null, null);
});

test('Q3 "Address in Zeffy" only when an address went on, never for a check with none or a row from before', async () => {
  world().reading = read({ street: '', city: '', state: '', zip: '' });
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 15 * MIN);
  assert.equal((await CG.checksView(env())).list[0].mailInZeffy, false);

  await fresh();
  world().txns[TX] = { ...txn({ createdAt: '2026-11-07T15:00:00Z', status: 'sent', postedAt: '2026-11-08T15:00:00Z' }), attachments: [...txn().attachments, LETTER] };
  await env().DB.prepare(`INSERT INTO check_gifts (id, status, cents, deposited_at, posted_at, check_number, state, payer, zeffy_id, via, created_at, updated_at) VALUES (?, 'sent', 1000000, '2026-11-07T15:00:00Z', '2026-11-08T15:00:00Z', '1042', 'created', 'Pine Foundation', 'zp_old', 'site', 'x', 'x')`).bind(TX).run();
  world().contacts.ct_old = { id: 'ct_old', email: null, first_name: 'Pine', last_name: 'Foundation' };
  world().payments.push(hand({ id: 'zp_old', contact: 'ct_old', created: Math.floor(Date.parse('2026-11-07T17:00:00Z') / 1000) }));
  await quiet(T0, T0 + 30 * MIN);
  const v = (await CG.checksView(env())).list[0];
  assert.deepEqual([v.mailInZeffy, v.needsYou], [false, false], 'a row from before: its file is only noted');
});

test('Q4 a new write test never switches off a step proven before, and a failed address step is tried again the next day', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: { id: '2026-11-07', ok: true, steps: [{ what: 'two names' }], join: { ok: true, onContact: true, cleared: true }, email: { saved: true, receipt: false } } });
  world().fail = ({ method, path, body }) => (method === 'PATCH' && path.startsWith('/contacts/') && body?.address ? 429 : null);
  await run(T0);
  world().fail = null;
  let t = (await readState(env().DB, 'check-gifts')).writeTest;
  assert.deepEqual([t.ok, t.join.ok, t.address.ok], [true, true, false]);
  assert.equal(world().posts.length, 0, 'nothing proven is written again');
  await run(T0 + DAY + 10 * MIN);
  t = (await readState(env().DB, 'check-gifts')).writeTest;
  assert.equal(t.address.ok, true);
});

test('Q5 the address to-do names exactly what Zeffy turned down, on whom', async () => {
  world().letter = letter({ street: '', city: '', state: '', zip: '' });
  world().fail = ({ method, path }) => (method === 'PATCH' && path.startsWith('/contacts/') ? 503 : null);
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 20 * MIN, T0 + 40 * MIN);
  for (let t = EVENING; t <= EVENING + DAY + 60 * MIN; t += 20 * MIN) await runQuiet(t);
  const why = (await CG.checksView(env())).list[0].why;
  assert.doesNotMatch(why, /12 Oak St/);
  assert.match(why, /Add it to Dana Whitfield in Zeffy: dana@example\.com/);
});

test('Q6 a second file after "Looked at it" is told in Slack again', async () => {
  await runs(T0, T0 + 10 * MIN); await runs(EVENING, EVENING + 10 * MIN);
  attach(LETTER); await runs(EVENING + 20 * MIN, EVENING + 40 * MIN);
  const v = (await CG.checksView(env())).list[0];
  await CG.personLetterDone(env(), TX, { saw: v.ver, by: 'staff@example.com', now: EVENING + 45 * MIN });
  attach({ fileName: 'page2.jpg', url: 'https://files.mercury.test/page2.jpg', attachmentType: 'receipt' });
  await runs(EVENING + 50 * MIN, EVENING + 60 * MIN);
  assert.equal(world().slack.filter((b) => /added to a check already in Zeffy/.test(b)).length, 2);
});

// ── Round 5 (Nov 10) ─────────────────────────────────────────────────────────────────────────────────────────────────
test('V2 the daily retry of the address step never switches the site off, whatever Zeffy answers about forms', async () => {
  await writeState(env().DB, 'check-gifts', { writeTest: { id: CG.WRITE_TEST, at: new Date(T0 - 2 * DAY).toISOString(), ok: true, steps: [{ what: 'two names' }], join: { ok: true, onContact: true, cleared: true }, email: { saved: true, receipt: false }, address: { ok: false, tries: 1 }, leftBehind: [] } });
  world().fail = ({ method, path }) => (method === 'GET' && path === '/campaigns' ? 503 : null);
  await runQuiet(T0); world().fail = null;
  const v = await CG.checksView(env());
  assert.equal(v.mode, 'on');
  assert.equal(v.writeTest.address.ok, true);
  assert.doesNotMatch(slackSaid(), /stopped entering checks/);
});

test('V5 a name a person typed stands when the check is decided again', async () => {
  world().payments.push(oakline());
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  const r = await rowOf();
  assert.equal(r.reason, 'maybe-double');
  await assert.rejects(CG.personCreate(env(), TX, { name: 'Dana Whitfield', formId: 'form_home', saw: CG.versionOf(r), by: 'staff@example.com', now: EVENING + 20 * MIN, fetchImpl: fetchWithFiles }), /may be this check/);
  world().payments = world().payments.filter((p) => p.id !== 'zp_other');
  await writeState(env().DB, 'check-gifts', { lastMatchAt: null });
  await quiet(EVENING + 120 * MIN, EVENING + 200 * MIN);
  assert.equal(world().posts[0]?.last_name, 'Whitfield');
});

test('V7 an entry found under the check writer\'s name never teaches the letter\'s giver its form', async () => {
  world().payments.push(hand({ id: 'zp_pine', campaign_id: 'form_grant', description: 'Grant Funding 2026', created: Math.floor(Date.parse(DEPOSIT) / 1000), contact: 'ct_pine' }));
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 15 * MIN, T0 + 40 * MIN); await quiet(EVENING, EVENING + 15 * MIN);
  assert.equal((await rowOf()).zeffy_id, 'zp_pine');
  const dana = await env().DB.prepare("SELECT * FROM check_payers WHERE key = 'dana whitfield'").first();
  assert.equal(dana?.campaign_id ?? null, null);
});

test('V3 "Looked at it" is offered for, and clears, only the to-do the page shows', async () => {
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  world().txns[TX] = { ...world().txns[TX], amount: 150 }; attach(LETTER);
  await quiet(EVENING + 20 * MIN, EVENING + 40 * MIN);
  let v = (await CG.checksView(env())).list[0];
  assert.equal(v.looked, null, 'the amount shows first, and it clears itself');

  await fresh();
  world().fail = ({ method, path, body }) => (method === 'PATCH' && path.startsWith('/contacts/') && body?.address ? 422 : null);
  await quiet(T0, T0 + 10 * MIN); await quiet(EVENING, EVENING + 10 * MIN);
  attach(LETTER); await quiet(EVENING + 20 * MIN, EVENING + 40 * MIN);
  v = (await CG.checksView(env())).list[0];
  assert.equal(v.looked, 'late');
  await CG.personLetterDone(env(), TX, { saw: v.ver, by: 'staff@example.com', now: EVENING + 45 * MIN });
  assert.equal((await rowOf()).address_done, 'refused', 'the address to-do wasn\'t shown, so it stays');
  v = (await CG.checksView(env())).list[0];
  assert.equal(v.looked, 'address');
  assert.match(v.why, /12 Oak St/);
});

test('V4 a letter\'s email never files a gift on a donor whose name only nearly matches', async () => {
  world().contacts.ct_nar = { id: 'ct_nar', email: 'rotary@example.org', first_name: 'North Atlanta Rotary', last_name: 'Club', donation_count: 4 };
  world().letter = letter({ recordAs: 'Atlanta Rotary Club', email: 'rotary@example.org', street: '', city: '', state: '', zip: '' });
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 15 * MIN, T0 + 40 * MIN); await quiet(EVENING, EVENING + 15 * MIN);
  assert.notEqual(world().payments.at(-1).contact, 'ct_nar');
});

test('V6 "Address in Zeffy" stays when only the email was added to a donor who had the address', async () => {
  await env().DB.prepare('INSERT INTO check_payers (key, name, contact_id, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?)').bind('pine foundation', 'Pine Foundation', 'c_pine', 'form_home', 'x').run();
  world().contacts.c_pine = { id: 'c_pine', email: null, first_name: 'Pine', last_name: 'Foundation', donation_count: 3, address: { line1: '12 Oak Street', city: 'Roswell', state: 'GA', postal_code: '30075', country: 'US' } };
  world().letter = letter({ recordAs: '', email: 'office@pine.example', street: '', city: '', state: '', zip: '' });
  await quiet(T0, T0 + 10 * MIN); attach(LETTER); await quiet(T0 + 15 * MIN, T0 + 40 * MIN); await quiet(EVENING, EVENING + 15 * MIN);
  assert.equal((await CG.checksView(env())).list[0].mailInZeffy, true);
});

test('V8 a file that\'s different every time it\'s fetched goes to a person, and never holds up the next check', async () => {
  const pdf = 'https://files.mercury.test/letter.pdf';
  let k = 0;
  Object.defineProperty(files, pdf, { configurable: true, enumerable: true, get() { return new TextEncoder().encode(`%PDF-1.7 typed /CreationDate (D:2026111${k++})`); } });
  world().pdfText = 'Please acknowledge this gift as from Dana Whitfield, 40 Pine Rd Apt 2, Marietta GA 30062. Thank you for your work.';
  await quiet(T0, T0 + 10 * MIN);
  attach({ fileName: 'letter.pdf', url: pdf, attachmentType: 'receipt' });
  world().txns.tx_2 = txn({ id: 'tx_2', checkNumber: '', createdAt: '2026-11-10T16:00:00Z' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: T0 + 20 * MIN });
  await quiet(T0 + 15 * MIN, EVENING + 4 * 60 * MIN, 15 * MIN);
  delete files[pdf];
  const r = await rowOf();
  assert.deepEqual([r.state, r.reason], ['person', 'letter']);
  assert.equal((await rowOf('tx_2')).state, 'created');
});

test('a scanned PDF\'s framing text ("Metadata … Contents") is never taken for a letter\'s words', async () => {
  const pdf = 'https://files.mercury.test/scan.pdf';
  files[pdf] = new TextEncoder().encode('%PDF-1.4 scanned');
  world().pdfText = 'Metadata\nPDFFormatVersion=1.4\nCreator=HP Scan Software Produced by the scanner\nIsLinearized=false\n\nContents\nPage 1';
  await runs(T0, T0 + 10 * MIN);
  attach({ fileName: 'scan.pdf', url: pdf, attachmentType: 'receipt' });
  await runs(T0 + 20 * MIN, EVENING + 10 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.reason, world().posts.length], ['person', 'letter', 0]);
});

// ── Only checks marked as a contribution in Mercury (Peter, Nov 10) ──────────────────────────────────────────────────
const mark = (name) => { world().txns[TX] = { ...world().txns[TX], categoryData: name ? { id: `cat_${name}`, name } : null }; };

test('a check with no Category in Mercury waits, and goes in once it\'s marked a contribution', async () => {
  mark(null);
  await runs(T0, T0 + 10 * MIN); await runs(EVENING, EVENING + 30 * MIN);
  assert.equal(world().posts.length, 0);
  let v = (await CG.checksView(env())).list[0];
  assert.equal(v.needsCategory, true);
  assert.equal((await rowOf()).state, 'read');
  mark('Contribution');
  await runs(EVENING + 35 * MIN, EVENING + 60 * MIN);
  assert.equal(world().posts.length, 1);
  v = (await CG.checksView(env())).list[0];
  assert.equal(v.needsCategory, false);
});

test('a check with another Category stays out of Zeffy, and comes back if it\'s re-marked', async () => {
  mark('Transfer');
  await runs(T0, T0 + 10 * MIN); await runs(EVENING, EVENING + 15 * MIN);
  let r = await rowOf();
  assert.deepEqual([r.state, r.reason, world().posts.length], ['left-out', 'category', 0]);
  mark('Individual Contribution');
  await runs(EVENING + 20 * MIN, EVENING + 60 * MIN);
  r = await rowOf();
  assert.deepEqual([r.state, world().posts.length], ['created', 1]);
});

test('a person can\'t save a check that isn\'t marked a contribution', async () => {
  mark(null);
  world().reading = (m) => read({ payer: m === KIMI ? 'Pine Foundation' : 'Oakline Builders' });
  await runs(T0, T0 + 30 * MIN);
  const r = await rowOf();
  assert.equal(r.reason, 'unreadable');
  await assert.rejects(CG.personCreate(env(), TX, { name: 'Pine Foundation', formId: 'form_home', saw: CG.versionOf(r), by: 'staff@example.com', now: T0 + 40 * MIN, fetchImpl: fetchWithFiles }), /Individual Contribution, Corporate Contribution or Grant/);
  assert.equal(world().posts.length, 0);
});

test('a letter read by an older reader is read again while its check is still being decided', async () => {
  await runs(T0, T0 + 10 * MIN); attach(LETTER); await runs(T0 + 20 * MIN, T0 + 40 * MIN);
  // As the first live letters were stored before the reader's version was kept
  const l = JSON.parse((await rowOf()).letter);
  for (const k of Object.keys(l.reads)) { delete l.reads[k].v; l.reads[k].name = 'Groundswell Charitable Foundation'; }
  await env().DB.prepare('UPDATE check_gifts SET letter = ? WHERE id = ?').bind(JSON.stringify(l), TX).run();
  await runs(T0 + 45 * MIN, T0 + 70 * MIN);
  await runs(EVENING, EVENING + 10 * MIN);
  assert.equal(world().posts[0]?.last_name, 'Whitfield');
});

test('a check marked Grant goes in on the Grant Funding form; Event & Sponsorship stays out', async () => {
  mark('Grant');
  await runs(T0, T0 + 10 * MIN); await runs(EVENING, EVENING + 15 * MIN);
  assert.equal(world().posts[0]?.campaign_id, 'form_grant');

  await fresh();
  mark('Event & Sponsorship');
  await runs(T0, T0 + 10 * MIN); await runs(EVENING, EVENING + 15 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.reason, world().posts.length], ['left-out', 'category', 0]);
});

test('Corporate Contribution goes in', async () => {
  mark('Corporate Contribution');
  await runs(T0, T0 + 10 * MIN); await runs(EVENING, EVENING + 15 * MIN);
  assert.equal(world().posts.length, 1);
});
