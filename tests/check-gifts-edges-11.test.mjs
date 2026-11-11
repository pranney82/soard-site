/**
 * Break-it round 11 on Checks into Zeffy (Nov 11 2026): multi-step sequences across runs and presses, against
 * tests/lib/check-gifts-harness-2.mjs (Zeffy as its spec says: POST /payments finds or makes the contact by email, PATCH
 * changes only what it's given). Each E test failed before its fix, with the bad outcome in its message; each "control:"
 * test is the same steps without the one thing the bug needed, and held all along. Since the fix, a 500 with Zeffy's own
 * error code is looked for like no answer at all (it may have saved), so the steps that pressed again after it now wait. Names, emails and addresses are made up.
 * Run: node --test tests/check-gifts-edges-11.test.mjs
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
const quiet = (now, o = {}) => run(now, o).catch((e) => ({ error: e.message }));
async function runs(from, to, step = 6 * MIN, o = {}) { let t = from; for (; t <= to; t += step) await quiet(t, o); return t; }
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
const big = () => world().payments.filter((p) => p.amount === 1000000);

/** Zeffy saves the record, then answers 500 with its own error code (the answer createRecord takes as "nothing saved") */
const savedThen500 = async (input, init = {}) => {
  if (isZeffy(input, init, 'POST', '/payments')) {
    await fakeFetch(input, init);
    return json({ error: { type: 'api_error', code: 'internal_server_error', message: 'Internal server error' } }, 500);
  }
  return fakeFetch(input, init);
};
/** Zeffy answers 500 with its error code and saves nothing */
const failed500 = async (input, init = {}) => (isZeffy(input, init, 'POST', '/payments')
  ? json({ error: { type: 'api_error', code: 'internal_server_error', message: 'Internal server error' } }, 500)
  : fakeFetch(input, init));

// The readers answer a letter's prompt with world().letter, a check's with world().reading
const LETTER = { fileName: 'letter.jpg', url: 'https://files.mercury.test/letter.jpg', attachmentType: 'other' };
function lettersToo(letter) {
  world().letter = { aboutGift: true, recordAs: '', email: '', street: '', city: '', state: '', zip: '', amount: 10000, ...letter };
  env().AI = { run: async (model, input) => { world().aiCalls++; return { response: String(input?.messages?.[0]?.content || '').startsWith('You read one page') ? world().letter : world().reading }; } };
}
const attach = (id = TX, ...more) => { world().txns[id] = { ...world().txns[id], attachments: [...world().txns[id].attachments, ...more] }; };

beforeEach(() => setup());

// ── E1. Zeffy saves a Send's record and answers 500 with its error code. createRecord keeps the payload, so the next Send or the
//        hourly look finds the record (C2/D3), but puts the card back with nothing on it to say Zeffy may have it: the page
//        says "Zeffy is busy, so nothing was sent". The person does what SOARD does when sending doesn't work: types the
//        check into Zeffy by hand and presses Don't send, "Already in Zeffy another way (entered by hand)". personDontSend
//        never looks for the record the payload says may be there (personSend does), and once a check is left out nothing
//        does: settleUnsure takes 'unsure', 'creating' and 'came-back' rows, prepareCard 'read' and 'person'. Zeffy keeps two
//        $10,000 records for one check, the check says "Not sent to Zeffy", and the hourly double check looks only at
//        'created' rows ─────────────────────────────────────────────────────────────────────────────────────────────────
test('E1 Don\'t send after a Send Zeffy saved but answered 500 never leaves the site\'s record in Zeffy unclaimed and unsaid', async () => {
  await posted();
  const first = await said(approve(TX, { now: NOW + 10 * MIN, fetchImpl: savedThen500 }));
  assert.match(first, /don’t send this one again/); // a 500 may have saved: since Nov 11 the site looks for it, as for no answer
  const r1 = big()[0];
  assert.ok(r1, 'Zeffy saved the record');
  // Told nothing was sent, the person types it by hand and says so
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-03'), contact: 'ct_typed' }));
  const press = await said(CG.personDontSend(env(), TX, { reason: 'already', saw: (await cardOf(env(), TX)).ver, by: 'staff@example.com', now: NOW + 14 * MIN }));
  await runs(NOW + 20 * MIN, NOW + DAY, 30 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  assert.ok(r.zeffy_id === r1.id || /twice|isn’t claimed|no check in Mercury/.test(slackSaid()),
    `Zeffy has ${big().length} records for the one $10,000 check (${big().map((p) => p.id).join(', ')}): the site's own ${r1.id} from the Send it was told saved nothing, and the hand entry. Don't send answered "${press}"; a day later the check is "${r.state}" holding ${r.zeffy_id} (payload ${r.payload ? 'still kept' : 'gone'}), its page says "${c.why}", and Slack said nothing about ${r1.id}`);
});

// ── E2. The same 500, then "This is the check". The card lists Dana Whitfield's hand entry beside the Whitfields' joint check;
//        the person says it's a different gift and sends a new record. Zeffy saves it and answers 500: "nothing was sent". On a
//        second look they decide Dana's entry was this check after all and press "This is the check". personLink never looks
//        for the payload's record, links Dana's entry, and leaves the payload on the linked row. Zeffy has two $10,000 records
//        for the one check, the second claimed by nothing, and the hourly double check never looks at a linked row ──────────
test('E2 "This is the check" after a Send Zeffy saved but answered 500 never leaves a second record for the check unsaid', async () => {
  world().reading = read({ payer: 'Sam and Dana Whitfield' });
  world().contacts.ct_dana = { id: 'ct_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 3 };
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-11-03'), contact: 'ct_dana', buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', is_corporate: false, company_name: null } }));
  await posted();
  const c0 = await cardOf(env(), TX);
  assert.ok((c0.candidates || []).some((x) => x.id === 'zp_dana'), 'Dana\'s entry is shown as one that may be this check');
  const first = await said(approve(TX, { donor: 'new', notThose: true, shown: ['zp_dana'], now: NOW + 10 * MIN, fetchImpl: savedThen500 }));
  assert.match(first, /don’t send this one again/); // a 500 may have saved: since Nov 11 the site looks for it, as for no answer
  const mine = big().find((p) => p.id !== 'zp_dana');
  assert.ok(mine, 'Zeffy saved the joint check\'s record');
  const linked = await said(CG.personLink(env(), TX, 'zp_dana', { saw: (await cardOf(env(), TX)).ver, by: 'staff@example.com', now: NOW + 13 * MIN }));
  await runs(NOW + 20 * MIN, NOW + DAY, 30 * MIN);
  const r = await rowOf();
  assert.ok(!(r.zeffy_id === 'zp_dana' && !/twice/.test(slackSaid())),
    `"This is the check" answered "${linked}": the check holds zp_dana, Zeffy also has ${mine.id} that its Send made (told "${first}"), ${big().length} records for one check, payload ${r.payload ? 'still on the row' : 'gone'}, and Slack never said it may be in Zeffy twice`);
});

// ── E3. D4 again, through a Zeffy rate limit. prepareCard's new first step looks for an unanswered Send's record (findSent) and
//        settles it as the person's. When that one read fails (a 429 on the hourly look, which reads Zeffy for every waiting
//        card and their donors), the error is swallowed and the card is made as if there were no payload: the Send's own
//        record matches as a sure hand entry and linkTo takes it, writing send = null over the person's choices and via
//        'hand'. The address the person typed never goes on the donor, the site's record is called typed by hand, and the
//        payload stays on the linked row ─────────────────────────────────────────────────────────────────────────────────
const TYPED = { line1: '40 Pine Rd', city: 'Marietta', state: 'GA', postal_code: '30062' };
test('E3 a Send\'s record Zeffy shows late is still the person\'s send when Zeffy rate-limits the one read that looks for it', async () => {
  await addressesOn();
  await posted();
  let body = null;
  world().fail = ({ method, path, body: b }) => (method === 'POST' && path === '/payments' ? ((body = b), 'timeout') : null);
  const first = await said(approve(TX, { address: TYPED, now: NOW + 10 * MIN }));
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  await runs(NOW + 15 * MIN, NOW + 70 * MIN);
  const waiting = await rowOf();
  assert.deepEqual([waiting.state, waiting.reason], ['person', 'unsure']);
  // Zeffy's list now shows the record that POST saved
  await fakeFetch('https://api.zeffy.com/api/v1/payments', { method: 'POST', body: JSON.stringify(body) });
  // The next hourly look: Zeffy answers 429 to the one read by form and date (findSent's)
  const limited = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'api.zeffy.com' && (init.method || 'GET') === 'GET' && url.pathname.endsWith('/payments') && url.searchParams.has('campaign')) {
      return json({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Too many requests' } }, 429);
    }
    return fakeFetch(input, init);
  };
  await runs(NOW + 76 * MIN, NOW + 130 * MIN, 6 * MIN, { fetchImpl: limited });
  await runs(NOW + 136 * MIN, NOW + 4 * 60 * MIN);
  const r = await rowOf();
  const p = big()[0];
  const onDonor = world().contacts[p?.contact]?.address || null;
  assert.deepEqual({ via: r.via, by: r.by, line1: onDonor?.line1 || null }, { via: 'person', by: 'staff@example.com', line1: TYPED.line1 },
    `the record the person's Send made (${p?.id}) is "${r.state}" via "${r.via}" by ${r.by}, send ${r.send}, payload ${r.payload ? 'still on the row' : 'gone'}, address_done "${r.address_done}", and the donor's contact has address ${JSON.stringify(onDonor)}`);
});

test('control: E3 with Zeffy answering that read, the late record is settled as the person\'s, address and all', async () => {
  await addressesOn();
  await posted();
  let body = null;
  world().fail = ({ method, path, body: b }) => (method === 'POST' && path === '/payments' ? ((body = b), 'timeout') : null);
  await approve(TX, { address: TYPED, now: NOW + 10 * MIN }).catch(() => null);
  world().fail = null;
  await runs(NOW + 15 * MIN, NOW + 70 * MIN);
  await fakeFetch('https://api.zeffy.com/api/v1/payments', { method: 'POST', body: JSON.stringify(body) });
  await runs(NOW + 76 * MIN, NOW + 4 * 60 * MIN);
  const r = await rowOf();
  const p = big()[0];
  assert.deepEqual([r.state, r.via, r.by], ['created', 'person', 'staff@example.com']);
  assert.equal(world().contacts[p.contact]?.address?.line1, TYPED.line1);
});

// ── E4. C1 again, through the 500. createRecord's 500-with-code path keeps the payload but puts back everything else the
//        claim wrote (`rest`): `rejected` too, the entries the person had just said are other gifts. findSent's two guards
//        are `before` (payments the site saw at least a minute before the press) and `rejected`. Dana Whitfield's own $10,000
//        hand entry is typed while the joint check's card waits; Send shows it ("Zeffy has an entry that may be this check")
//        and the person answers "Send a new record" within the minute. Zeffy answers 500 and saved nothing. The person
//        presses Send again, as told, and findSent files the joint check as Dana's own gift ─────────────────────────────────
async function danaTypedWhileCardWaits() {
  world().reading = read({ payer: 'Sam and Dana Whitfield' });
  world().contacts.ct_dana = { id: 'ct_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 3 };
  // Her card gift last spring: the card lists her contact, for the joint name, to pick or not
  world().payments.push(hand({ id: 'zp_spring', amount: 25000, created: dayS('2026-04-12'), type: 'online', payment_method: { type: 'card', brand: 'visa', last4: '4242' }, contact: 'ct_dana',
    buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', is_corporate: false, company_name: null } }));
  await posted();
  const c = await cardOf(env(), TX);
  assert.deepEqual([c.state, c.card.donor, c.card.donors.map((d) => d.id).join()], ['person', null, 'ct_dana']);
  // Typed in Zeffy by a colleague a moment ago: Dana's own check, the same day and amount
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-11-03'), contact: 'ct_dana', buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', is_corporate: false, company_name: null } }));
  const t1 = NOW + 10 * MIN;
  const asked = await said(approve(TX, { donor: 'new', now: t1 }));
  assert.match(asked, /may be this check/);
  return t1;
}

test('E4 a Send Zeffy answered 500 never makes the next Send claim the entry the person had just said is a different gift', async () => {
  const t1 = await danaTypedWhileCardWaits();
  // "Send a new record", 20 seconds later; Zeffy answers 500 and saves nothing
  const second = await said(approve(TX, { donor: 'new', notThose: true, shown: ['zp_dana'], saw: 'person', now: t1 + 20e3, fetchImpl: failed500 }));
  assert.match(second, /don’t send this one again/); // as above
  assert.equal(big().length, 1, 'Zeffy saved nothing for the joint check');
  const between = await rowOf();
  // As the page says: try again in a minute
  const third = await said(approve(TX, { donor: 'new', now: t1 + 80e3 }));
  const r = await rowOf();
  const learned = await learnedOf('Sam and Dana Whitfield');
  assert.notEqual(r.zeffy_id, 'zp_dana',
    `the person said zp_dana (Dana Whitfield's own check) is a different gift and sent a new record; Zeffy answered 500 and saved nothing, and the row's rejected went back to ${between.rejected}. Pressing Send again answered "${third}": the joint check is "${r.state}" holding zp_dana as its record (via ${r.via}), and the site now files "Sam and Dana Whitfield" on ${learned?.contact_id}`);
});

test('control: E4 the same "Send a new record" unanswered (timeout) never claims Dana\'s entry: the person\'s word is kept', async () => {
  const t1 = await danaTypedWhileCardWaits();
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout' : null);
  await approve(TX, { donor: 'new', notThose: true, shown: ['zp_dana'], saw: 'person', now: t1 + 20e3 }).catch(() => null);
  world().fail = null;
  await runs(t1 + 5 * MIN, t1 + 70 * MIN);
  assert.notEqual((await rowOf()).zeffy_id, 'zp_dana');
});

// ── E5. The 500 path again: `rest` puts back the row's payer (the card's name) while the payload keeps who the record went in
//        as. Pine Foundation's check comes with a letter saying to record it from Dana Whitfield, so the card starts on Dana.
//        The person picks the check's own name instead, Pine Foundation, and its contact (no email: filed under it with the
//        no-mail address). Zeffy saves it there and answers 500. Within the hour prepareCard finds the record and settleFound
//        teaches row.payer, which is Dana Whitfield again, as Pine Foundation's contact (sent.join). The check's page says it's
//        from Dana Whitfield, and Dana's next personal check starts on, and is filed under, Pine Foundation's contact ───────
async function pineSentOnDanasCard(fetchImpl) {
  lettersToo({ recordAs: 'Dana Whitfield' });
  attach(TX, LETTER);
  world().contacts.c_pine = { id: 'c_pine', email: null, first_name: 'Pine', last_name: 'Foundation', donation_count: 2 };
  world().payments.push(hand({ id: 'zp_march', amount: 500000, created: dayS('2026-03-10'), contact: 'c_pine' }));
  await run(NOW);
  post();
  await runs(NOW + 6 * MIN, NOW + 40 * MIN);
  const c = await cardOf(env(), TX);
  assert.deepEqual([c.state, c.card.name, c.card.names.map((n) => n.name).join(' / ')], ['person', 'Dana Whitfield', 'Dana Whitfield / Pine Foundation']);
  assert.ok(c.card.donors.some((d) => d.id === 'c_pine' && d.for.includes('Pine Foundation')));
  return said(approve(TX, { name: 'Pine Foundation', donor: 'c_pine', email: '', address: null, now: NOW + 45 * MIN, fetchImpl }));
}

test('E5 a Send Zeffy saved but answered 500 never teaches the card\'s other name as the contact the record went on', async () => {
  const first = await pineSentOnDanasCard(savedThen500);
  assert.match(first, /don’t send this one again/); // a 500 may have saved: since Nov 11 the site looks for it, as for no answer
  const rec = big()[0];
  assert.equal(rec?.contact, 'c_pine', 'Zeffy filed it on Pine Foundation\'s contact');
  await runs(NOW + 50 * MIN, NOW + 130 * MIN);
  const r = await rowOf();
  const dana = await learnedOf('Dana Whitfield');
  // Dana's own check, weeks later
  world().txns.tx_2 = txn({ id: 'tx_2', checkNumber: '388', amount: 500, createdAt: '2026-11-20T15:00:00Z', status: 'sent', postedAt: '2026-11-21T15:00:00Z', dashboardLink: 'https://app.mercury.com/transactions/tx_2' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: NOW });
  env().AI = { run: async () => ({ response: read({ payer: 'Dana Whitfield', amount: 500, checkNumber: '388', date: '2026-11-19' }) }) };
  const later = Date.parse('2026-11-21T16:00:00Z');
  await runs(later, later + 30 * MIN);
  const k = await cardOf(env(), 'tx_2');
  // Sent as filled in
  const danaSent = k?.card?.donor ? await said(approve('tx_2', { now: later + 35 * MIN })) : 'no donor picked';
  const hers = world().payments.find((p) => p.amount === 50000);
  assert.ok(dana?.contact_id !== 'c_pine' && r.payer === 'Pine Foundation' && hers?.contact !== 'c_pine',
    `the record ${rec.id} went in as Pine Foundation on c_pine and the check is "${r.state}" holding ${r.zeffy_id}, yet its row says it's from "${r.payer}", and the site learned "Dana Whitfield" as contact ${dana?.contact_id}. Dana Whitfield's own $500 check on Nov 20 starts on donor ${k?.card?.donor} (${JSON.stringify(k?.card?.donors?.map((d) => ({ id: d.id, name: d.name, for: d.for })))}); Send as filled in answered "${danaSent}" and her $500 is on ${hers?.contact} as ${hers?.buyer?.first_name} ${hers?.buyer?.last_name}`);
});

// ── E5b. The same root at the next press. The joint check's card lists both spouses' contacts for the joint name (neither sure,
//         so the person picks). They pick Sam Whitfield's and press Send; Zeffy saves it on Sam's contact and answers 500,
//         "nothing was sent". Seeing the check is from Dana's account, they pick Dana's contact and press Send again. The
//         before-path runs ahead of everything the press says (donor, name, form): it finds the first record and answers
//         "created", as if this press had gone in. The gift stays on Sam's contact, with nothing said, the plan stored (Dana)
//         never applies to it, and the site learns the joint name as Sam's contact ─────────────────────────────────────────
test('E5b a second press that changes the donor is never answered "created" for the first press\'s record on the other donor, unsaid', async () => {
  world().reading = read({ payer: 'Sam and Dana Whitfield' });
  world().contacts.ct_sam = { id: 'ct_sam', email: 'sam@example.com', first_name: 'Sam', last_name: 'Whitfield', donation_count: 2 };
  world().contacts.ct_dana = { id: 'ct_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 3 };
  const card = (id, contact, first, email, day) => hand({ id, amount: 25000, created: dayS(day), type: 'online', payment_method: { type: 'card', brand: 'visa', last4: '4242' }, contact,
    buyer: { first_name: first, last_name: 'Whitfield', email, is_corporate: false, company_name: null } });
  world().payments.push(card('zp_sam', 'ct_sam', 'Sam', 'sam@example.com', '2026-05-01'), card('zp_dana', 'ct_dana', 'Dana', 'dana@example.com', '2026-04-12'));
  await posted();
  const c = await cardOf(env(), TX);
  assert.deepEqual([c.card.donor, c.card.donors.map((d) => d.id).sort().join()], [null, 'ct_dana,ct_sam'], 'the person picks between the spouses');
  const first = await said(approve(TX, { donor: 'ct_sam', now: NOW + 10 * MIN, fetchImpl: savedThen500 }));
  assert.match(first, /don’t send this one again/); // a 500 may have saved: since Nov 11 the site looks for it, as for no answer
  const second = await said(approve(TX, { donor: 'ct_dana', now: NOW + 12 * MIN }));
  const rec = big()[0];
  const r = await rowOf();
  const learned = await learnedOf('Sam and Dana Whitfield');
  assert.ok(!(second === 'created' && rec?.contact !== 'ct_dana'),
    `the second press picked Dana's contact and was answered "${second}"; Zeffy holds ${big().length} record(s), ${rec?.id} on ${rec?.contact} as ${rec?.buyer?.first_name} ${rec?.buyer?.last_name} (the first press's), the row's send says donor ${JSON.parse(r.send || '{}').donor}, and the site learned the joint name as ${learned?.contact_id}`);
});

test('control: E5b the same second press with the same donor finds the first record and answers "created"', async () => {
  world().reading = read({ payer: 'Sam and Dana Whitfield' });
  world().contacts.ct_sam = { id: 'ct_sam', email: 'sam@example.com', first_name: 'Sam', last_name: 'Whitfield', donation_count: 2 };
  world().payments.push(hand({ id: 'zp_sam', amount: 25000, created: dayS('2026-05-01'), type: 'online', payment_method: { type: 'card', brand: 'visa', last4: '4242' }, contact: 'ct_sam',
    buyer: { first_name: 'Sam', last_name: 'Whitfield', email: 'sam@example.com', is_corporate: false, company_name: null } }));
  await posted();
  await approve(TX, { donor: 'ct_sam', now: NOW + 10 * MIN, fetchImpl: savedThen500 }).catch(() => null);
  // (since Nov 11 a 500 is looked for, not sent again: a second press waits while the site looks, and the look finds it)
  assert.match(await said(approve(TX, { donor: 'ct_sam', now: NOW + 12 * MIN })), /No card to send|moved on/);
  await runs(NOW + 15 * MIN, NOW + 45 * MIN);
  assert.equal((await rowOf()).state, 'created');
  assert.equal(big().length, 1);
  assert.equal(big()[0].contact, 'ct_sam');
});

test('control: E1 with no Don\'t send, the hourly look claims the site\'s record and Slack says the hand entry may be a second one', async () => {
  await posted();
  await approve(TX, { now: NOW + 10 * MIN, fetchImpl: savedThen500 }).catch(() => null);
  const r1 = big()[0];
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-03'), contact: 'ct_typed' }));
  await runs(NOW + 20 * MIN, NOW + 3 * 60 * MIN, 30 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.zeffy_id], ['created', r1.id]);
  assert.match(slackSaid(), /in Zeffy twice/);
});

test('control: E2 with no "This is the check", the hourly look claims the site\'s record and Dana\'s entry stays hers', async () => {
  world().reading = read({ payer: 'Sam and Dana Whitfield' });
  world().contacts.ct_dana = { id: 'ct_dana', email: 'dana@example.com', first_name: 'Dana', last_name: 'Whitfield', donation_count: 3 };
  world().payments.push(hand({ id: 'zp_dana', created: dayS('2026-11-03'), contact: 'ct_dana', buyer: { first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', is_corporate: false, company_name: null } }));
  await posted();
  await approve(TX, { donor: 'new', notThose: true, shown: ['zp_dana'], now: NOW + 10 * MIN, fetchImpl: savedThen500 }).catch(() => null);
  const mine = big().find((p) => p.id !== 'zp_dana');
  await runs(NOW + 20 * MIN, NOW + 3 * 60 * MIN, 30 * MIN);
  const r = await rowOf();
  assert.deepEqual([r.state, r.zeffy_id], ['created', mine.id]);
});

test('control: E5 the same Send answered at once teaches Pine Foundation, not Dana Whitfield, as c_pine', async () => {
  assert.equal(await pineSentOnDanasCard(fakeFetch), 'created');
  await runs(NOW + 50 * MIN, NOW + 130 * MIN);
  assert.equal((await learnedOf('Pine Foundation'))?.contact_id, 'c_pine');
  assert.notEqual((await learnedOf('Dana Whitfield'))?.contact_id, 'c_pine');
  assert.equal((await rowOf()).payer, 'Pine Foundation');
});

// ── E6. Mercury corrects a check's amount while its Send is unanswered (a pending check, the way most are sent). lookAgain
//        writes the new cents and, as the row has no zeffy_id yet, says nothing ('amount-off' is set only for a check that
//        has its record). settleUnsure then finds the record by the payload's amount and settleFound sets reason = null. Zeffy
//        keeps $10,000 for a check Mercury says brought in $1,000, the page shows it saved with nothing to do, and no later
//        look notices: the amount was already "corrected" on the row ────────────────────────────────────────────────────
test('E6 a check whose amount Mercury corrects while its Send is unanswered is never settled as right in Zeffy', async () => {
  await runs(NOW, NOW + 6 * MIN);
  assert.equal((await rowOf()).state, 'person');
  world().fail = ({ method, path }) => (method === 'POST' && path === '/payments' ? 'timeout-after' : null);
  const first = await said(approve(TX, { now: NOW + 10 * MIN }));
  world().fail = null;
  assert.match(first, /don’t send this one again/);
  // Mercury's review: it posts, for $1,000
  world().txns[TX] = { ...world().txns[TX], status: 'sent', postedAt: '2026-11-10T16:12:00Z', amount: 1000 };
  await runs(NOW + 15 * MIN, NOW + 3 * 60 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  const rec = big()[0];
  assert.ok(r.reason === 'amount-off' || /changed a check’s amount/.test(slackSaid()),
    `Zeffy has ${rec?.id} for $${rec?.amount / 100} and Mercury says $${r.cents / 100} came in; the check is "${r.state}" holding ${r.zeffy_id} with reason ${r.reason}, its page shows ${c.toDo ? 'a to-do' : 'nothing to do'} ("${c.why}"), and Slack never said the amount changed`);
});

test('control: E6 the same correction once the record is in is flagged as amount-off', async () => {
  await runs(NOW, NOW + 6 * MIN);
  assert.equal(await said(approve(TX, { now: NOW + 10 * MIN })), 'created');
  world().txns[TX] = { ...world().txns[TX], status: 'sent', postedAt: '2026-11-10T16:12:00Z', amount: 1000 };
  await runs(NOW + 15 * MIN, NOW + 60 * MIN);
  assert.equal((await rowOf()).reason, 'amount-off');
});

// ── E7 minor. A store-account check brought back with "Send to Zeffy after all" now goes to 'new' to be read (D9's fix), with
//         reason 'store-account' so its card keeps saying so. When the picture can't be read, readCheck's giveUp (and the
//         run's `unread`) write reason = the read's why over it: the card says only that the name couldn't be read, and
//         nothing says the money went into the store's account ────────────────────────────────────────────────────────────
async function storeCheckBack(reading) {
  const { writeConfig } = await import('../functions/api/_spend.js');
  await env().DB.prepare('DELETE FROM check_gifts').run();
  await writeConfig(env().DB, { accountBuckets: { acct_check: 'store' } });
  world().reading = reading;
  await run(NOW);
  post();
  await run(NOW + 10 * MIN);
  assert.equal((await rowOf()).state, 'store');
  assert.equal((await CG.personReopen(env(), TX, { saw: (await cardOf(env(), TX)).ver, by: 'staff@example.com', now: NOW + 15 * MIN })).result, 'reopened');
  await runs(NOW + 20 * MIN, NOW + 90 * MIN);
  return cardOf(env(), TX);
}

test('E7 minor: a store-account check brought back whose picture can\'t be read still says it went into the store\'s account', async () => {
  const c = await storeCheckBack(read({ payer: '', remitter: '' }));
  assert.equal(c.state, 'person');
  const kinds = c.card.notes.map((n) => n.kind);
  assert.ok(kinds.includes('store-account'),
    `the store's check, brought back and unreadable, has a card whose notes are only ${JSON.stringify(kinds)} ("${c.card.notes.map((n) => n.text).join(' / ')}"), reason ${c.reason}`);
});

test('control: E7 a store-account check brought back whose picture reads says so on its card', async () => {
  const c = await storeCheckBack(read());
  assert.ok(c.card.notes.map((n) => n.kind).includes('store-account'));
});

// ── E1b. E1 on a donor with no email: worse, as it leaves the no-mail address behind. The Send files under Pine's contact by the
//         no-mail address; Zeffy's lookup misses it (B10/D5's premise), makes a contact of its own holding it, saves the record
//         there and answers 500. "Nothing was sent", so the person enters it by hand and presses Don't send. settleFound's
//         newContactTagOff is what takes the address off a contact Zeffy made, and nothing calls it for a left-out check:
//         that contact keeps the site's no-mail address for good, with no note of it and nobody told ──────────────────────
test('E1b Don\'t send after a no-email donor\'s Send Zeffy saved under a contact of its own never leaves the no-mail address there', async () => {
  await noEmailGiver();
  await posted();
  assert.equal((await cardOf(env(), TX)).card.donor, 'c_pine');
  const lagging500 = async (input, init = {}) => {
    if (isZeffy(input, init, 'POST', '/payments') && /@nomail\./.test(JSON.parse(init.body).email || '')) {
      const held = world().contacts.c_pine.email;
      world().contacts.c_pine.email = null;
      try { await fakeFetch(input, init); } finally { world().contacts.c_pine.email = held; }
      return json({ error: { type: 'api_error', code: 'internal_server_error', message: 'Internal server error' } }, 500);
    }
    return fakeFetch(input, init);
  };
  const first = await said(approve(TX, { now: NOW + 10 * MIN, fetchImpl: lagging500 }));
  assert.match(first, /don’t send this one again/); // a 500 may have saved: since Nov 11 the site looks for it, as for no answer
  const saved = big()[0];
  assert.ok(saved && saved.contact !== 'c_pine', 'Zeffy saved it, under a contact of its own');
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-03'), contact: 'c_pine' }));
  const press = await said(CG.personDontSend(env(), TX, { reason: 'already', saw: (await cardOf(env(), TX)).ver, by: 'staff@example.com', now: NOW + 14 * MIN }));
  await runs(NOW + 20 * MIN, NOW + 20 * MIN + DAY + 60 * MIN, 30 * MIN);
  const r = await rowOf();
  const notes = (await env().DB.prepare('SELECT COUNT(*) AS n FROM check_tags').first()).n;
  assert.deepEqual(tagged().map((c) => c.id), [],
    `a day after Don't send ("${press}"), ${tagged().map((x) => `${x.id} holds ${x.email}`).join('; ')}; the check is "${r.state}" holding ${r.zeffy_id}, Zeffy has ${big().length} $10,000 records (${big().map((p) => `${p.id} on ${p.contact}`).join(', ')}), check_tags has ${notes} rows, and Slack said ${/no-mail/.test(slackSaid()) ? 'so' : 'nothing about it'}`);
});

// ── E8. A file attached in Mercury while a Send's POST is out ('creating') is noted as one of the check's files but is neither
//         read (noteLetters reads only while deciding: 'new', 'read', 'person') nor late (only 'created' and 'linked' count as
//         saved). When the POST then answers, createRecord makes the check 'created' without looking at the files the payload
//         was sent with (settleFound does, through payload.files), and from then on the file is "known": the letter is never
//         read, never put to a person, and Slack never hears of it ──────────────────────────────────────────────────────
test('E8 a letter attached in Mercury while a Send\'s POST is out is still put to a person once the record is in', async () => {
  lettersToo({ recordAs: 'Dana Whitfield', email: 'dana@example.com' });
  // Carded while Mercury still has it pending, the way most checks are sent (Mercury is read on every run)
  await runs(NOW, NOW + 6 * MIN);
  assert.equal((await rowOf()).state, 'person');
  let once = false;
  world().hook = async ({ method, path }) => {
    if (once || method !== 'POST' || path !== '/payments') return;
    once = true;
    // While Zeffy is saving it: the team attaches the donor's letter, and the 5-minute run looks at Mercury
    attach(TX, LETTER);
    await quiet(NOW + 10 * MIN + 20e3);
  };
  assert.equal(await said(approve(TX, { now: NOW + 10 * MIN })), 'created');
  world().hook = null;
  await runs(NOW + 15 * MIN, NOW + 4 * 60 * MIN);
  const r = await rowOf();
  const c = await cardOf(env(), TX);
  const l = JSON.parse(r.letter || '{}');
  assert.ok(c.letter?.todo === 'late' || /letter was added/.test(slackSaid()) || (l.reads || {})[l.files?.[0]],
    `the letter (Dana Whitfield's) is one of the check's files (${JSON.stringify(l.files)}), read ${JSON.stringify(Object.keys(l.reads || {}))}, late ${JSON.stringify(l.late)}; the saved check's page says "${c.why}" with letter to-do ${c.letter?.todo}, and Slack ${/letter was added/.test(slackSaid()) ? 'heard' : 'never heard'} of it`);
});

test('control: E8 a letter attached a moment after the record is in is put to a person', async () => {
  lettersToo({ recordAs: 'Dana Whitfield', email: 'dana@example.com' });
  await runs(NOW, NOW + 6 * MIN);
  assert.equal(await said(approve(TX, { now: NOW + 10 * MIN })), 'created');
  attach(TX, LETTER);
  await runs(NOW + 15 * MIN, NOW + 60 * MIN);
  assert.equal((await cardOf(env(), TX)).letter?.todo, 'late');
});

// ── E9. D8's fix depends on a note linkTo writes last. linkTo takes the returned deposit's record (clears its zeffy_id), links
//         the redeposit with taught = '', tells Slack the returned check's record "now belongs to that deposit. Don't cancel
//         it", then reads the entry's contact from Zeffy, maybe takes a stray tag off, teaches, and only then writes taught
//         { tookFrom }. A run cut off in those Zeffy calls (Cloudflare's 30 seconds, a hung read) leaves the link with no
//         tookFrom. The person then says the match isn't this deposit, as in D8: personUnlink has nothing to give the record
//         back to, the returned deposit holds nothing and says only "The check came back", the redeposit's card says to send
//         it, and Send makes a second record for the one paper check, with the first never marked to cancel ──────────────────
test('E9 a redeposit\'s match cut off before its note is written still gives the record back when the match is taken off', async () => {
  await posted();
  assert.equal(await said(approve(TX, { now: NOW + 10 * MIN })), 'created');
  const r1 = (await rowOf()).zeffy_id;
  const r1Contact = big()[0].contact;
  world().txns[TX] = { ...world().txns[TX], status: 'reversed' };
  let t = Date.parse('2026-11-12T16:00:00Z');
  await quiet(t);
  assert.deepEqual([(await rowOf()).state, (await rowOf()).zeffy_id], ['came-back', r1]);
  t = Date.parse('2026-11-14T16:00:00Z');
  world().txns.tx_2 = txn({ id: 'tx_2', createdAt: '2026-11-14T15:00:00Z', status: 'sent', postedAt: '2026-11-15T14:00:00Z', dashboardLink: 'https://app.mercury.com/transactions/tx_2' });
  await mirrorTransaction(env().DB, world().txns.tx_2, { now: t });
  // The redeposit is read; on the next run its card matches the returned check's record, and the run is cut off while it
  // reads that record's contact from Zeffy
  let i = 0;
  let cut = false;
  for (; i < 6 && !cut; i++) {
    t += 6 * MIN;
    let reached;
    const atRead = new Promise((r) => { reached = r; });
    const hung = async (input, init = {}) => {
      if (isZeffy(input, init, 'GET', `/contacts/${r1Contact}`)) { cut = true; reached(); return new Promise(() => {}); }
      return fakeFetch(input, init);
    };
    const done = run(t, { fetchImpl: hung }).catch(() => null);
    await Promise.race([atRead, done]);
  }
  assert.ok(cut, 'the run reached the contact read');
  const took = await rowOf('tx_2');
  assert.deepEqual([took.state, took.zeffy_id, (await rowOf()).zeffy_id], ['linked', r1, null], 'the redeposit took the returned check\'s record');
  // The person says that record isn't this deposit's
  await CG.personUnlink(env(), 'tx_2', { saw: (await cardOf(env(), 'tx_2')).ver, by: 'staff@example.com', now: t + 5 * MIN });
  t = await runs(t + 10 * MIN, t + 40 * MIN);
  const k = await cardOf(env(), 'tx_2');
  const sent = k.card ? await said(approve('tx_2', { now: t })) : `no card (${k.state})`;
  const first = await rowOf();
  assert.ok(first.zeffy_id === r1 || big().length === 1,
    `after the unlink the returned deposit holds ${first.zeffy_id} (page: "${(await cardOf(env(), TX)).why}"; Slack told "${/Don’t cancel it/.test(slackSaid()) ? 'Don’t cancel it' : '?'}"), the redeposit's taught was ${JSON.stringify(took.taught)}, its card says ${k.card?.notes.map((n) => n.kind).join(', ')}, Send answered "${sent}", and Zeffy has ${big().length} records for the one $10,000 check (${big().map((p) => p.id).join(', ')}) with none marked to cancel`);
});

// ── E7b minor. The same note, lost another way: every sticky note lives only in row.reason, and Send's "Zeffy has an entry
//          that may be this check" (personSend) writes reason = 'pledge' or 'maybe-double' over it. A store-account check
//          brought back to send, with a giver's open pledge in Zeffy: the person presses Send, is asked about the pledge, and
//          from the next hourly look the card no longer says the money went into the store's account ───────────────────────
test('E7b minor: a store-account check\'s card still says so after Send asked about an entry that may be it', async () => {
  world().payments.push(hand({ id: 'zp_pledge', status: 'pending', type: 'online', created: dayS('2026-10-01'), contact: 'ct_pine', payment_method: { type: 'cheque', brand: null, last4: null } }));
  const c0 = await storeCheckBack(read());
  assert.ok(c0.card.notes.map((n) => n.kind).includes('store-account'));
  const asked = await said(approve(TX, { donor: 'new', now: NOW + 95 * MIN }));
  assert.match(asked, /may be this check/);
  await runs(NOW + 100 * MIN, NOW + 3 * 60 * MIN, 30 * MIN);
  const c = await cardOf(env(), TX);
  const kinds = c.card.notes.map((n) => n.kind);
  assert.ok(kinds.includes('store-account'), `after Send asked about the pledge, the store's check's card notes are ${JSON.stringify(kinds)}, reason ${c.reason}`);
});

// ── E5c minor. E5's root on the form: the 500 path puts back the row's form_id and form_title, and settleFound never writes the
//          record's own form, so a foundation's check the person sent on Help Build a Brighter Home (the card had Grant
//          Funding 2026) shows the grant form once the hourly look finds its record ────────────────────────────────────────────────────────────────────────────
test('E5c minor: a Send Zeffy saved but answered 500 on another form shows the form the record is on once it\'s found', async () => {
  await posted();
  assert.equal((await cardOf(env(), TX)).card.formId, 'form_grant');
  const first = await said(approve(TX, { formId: 'form_home', now: NOW + 10 * MIN, fetchImpl: savedThen500 }));
  assert.match(first, /don’t send this one again/); // a 500 may have saved: since Nov 11 the site looks for it, as for no answer
  await runs(NOW + 15 * MIN, NOW + 75 * MIN);
  const c = await cardOf(env(), TX);
  const rec = big()[0];
  assert.deepEqual([c.state, rec.campaign_id, c.formId], ['created', 'form_home', 'form_home'],
    `the record ${rec.id} is on ${rec.campaign_id} and the check is "${c.state}" holding ${c.zeffyId}, but its page says it went on ${c.formId} ("${c.formTitle}")`);
});

// ── E1c. E1's race, with no hand entry and no wrong word: the hourly look is finding the record (prepareCard → findSent) when a
//         colleague, reading "Zeffy is busy, so nothing was sent", presses Don't send (say, "Event tickets or a sponsorship,
//         entered in Zeffy by hand", to enter it on the gala's form themselves). settleFound's guard (state 'person') fails,
//         prepareCard answers 'moved', and the record it had in hand is dropped: the site's $10,000 donation record stays in
//         Zeffy under a check that says "Not sent to Zeffy", and no one hears of it ─────────────────────────────────────────
test('E1c a Don\'t send pressed while the hourly look is finding a 500\'d Send\'s record never leaves that record unclaimed and unsaid', async () => {
  await posted();
  const first = await said(approve(TX, { now: NOW + 10 * MIN, fetchImpl: savedThen500 }));
  assert.match(first, /don’t send this one again/); // a 500 may have saved: since Nov 11 the site looks for it, as for no answer
  const r1 = big()[0];
  // (since Nov 11 a 500 is looked for at once: for the race, Zeffy shows the record only after the check is back on its card)
  world().payments = world().payments.filter((p) => p.id !== r1.id);
  await runs(NOW + 15 * MIN, NOW + 50 * MIN, 6 * MIN);
  assert.equal((await rowOf()).state, 'person', 'given up on after half an hour, back on its card');
  world().payments.push(r1);
  let press = null;
  const racing = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!press && url.hostname === 'api.zeffy.com' && (init.method || 'GET') === 'GET' && url.pathname.endsWith('/payments') && url.searchParams.has('campaign')) {
      press = await said(CG.personDontSend(env(), TX, { reason: 'event', saw: (await cardOf(env(), TX)).ver, by: 'other@example.com', now: NOW + 61 * MIN }));
    }
    return fakeFetch(input, init);
  };
  await runs(NOW + 60 * MIN, NOW + 66 * MIN, 6 * MIN, { fetchImpl: racing });
  assert.ok(press === 'left-out' || /saved the earlier send/.test(press), `the colleague's Don't send landed, or was told the record is in Zeffy, while the look was reading Zeffy ("${press}")`);
  await runs(NOW + 72 * MIN, NOW + DAY, 60 * MIN);
  const r = await rowOf();
  assert.ok(r.zeffy_id === r1.id || r.extra === r1.id || /in Zeffy twice|no check in Mercury/.test(slackSaid()),
    `the hourly look found ${r1.id} for the check as Don't send landed; a day later the check is "${r.state}" (${r.note}) holding ${r.zeffy_id}, payload ${r.payload ? 'still kept' : 'gone'}, and ${r1.id} sits in Zeffy as a $10,000 donation nobody was told about`);
});
