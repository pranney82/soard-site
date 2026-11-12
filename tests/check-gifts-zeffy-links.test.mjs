/**
 * Checks links to the Zeffy record itself (Peter, Nov 11 2026: "i see you can link to mercury for the check but cant link
 * to zeffy for the check?"). Zeffy opens one payment from ?transactionId=<the API's payment id> and one donor from
 * ?contactId=<the API's contact id> (checked in SOARD's Zeffy on a record the site made), so every place Checks names a
 * Zeffy record (a check's own, a second one to delete, an entry that may be the check, the Monday money check's, the
 * write test's leftovers, a donor's contact) opens that record, never a list to search. Names are made up.
 * Run: node --test tests/check-gifts-zeffy-links.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zeffyPaymentUrl, zeffyContactUrl, ZEFFY_PAYMENTS, ZEFFY_CONTACTS } from '../public/admin/zeffy-links.js';
const { W, CG, setup, run, rowOf, posted, fakeFetch, hand, slackSaid, NOW, MIN, DAY, dayS, TX } = await import('./lib/check-gifts-harness-2.mjs');
const { approveWith, cardOf } = await import('./lib/check-gifts-approve.mjs');

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
const env = () => W.env;
const world = () => W.world;
const quiet = (now) => run(now).catch((e) => ({ error: e.message }));
const page = readFileSync(new URL('../public/admin/checks.js', import.meta.url), 'utf8');

beforeEach(() => setup());

test('a payment and a donor each have a link straight to them in Zeffy, and no id means the list', () => {
  assert.equal(zeffyPaymentUrl('801cb76f-d6a1-4f17-8cc1-f33d1eea72bc'), 'https://www.zeffy.com/en-US/o/all-payments?transactionId=801cb76f-d6a1-4f17-8cc1-f33d1eea72bc');
  assert.equal(zeffyContactUrl('69803a61-1c9f-4579-845a-c8ccd73ab3cc'), 'https://www.zeffy.com/en-US/o/crm/contacts?contactId=69803a61-1c9f-4579-845a-c8ccd73ab3cc');
  assert.equal(zeffyPaymentUrl(null), ZEFFY_PAYMENTS);
  assert.equal(zeffyContactUrl(''), ZEFFY_CONTACTS);
  assert.equal(zeffyPaymentUrl('a b&c'), `${ZEFFY_PAYMENTS}?transactionId=a%20b%26c`);
});

test('a check sent to Zeffy carries its record, and the page links it beside Mercury', async () => {
  await posted();
  const sent = await approveWith(env(), fakeFetch, TX, { now: NOW + 10 * MIN });
  assert.ok(sent.result, 'the check was sent');
  const r = await rowOf();
  assert.ok(r.zeffy_id, 'the check holds its Zeffy record');
  const v = (await CG.checksView(env(), { now: NOW + 11 * MIN })).list.find((c) => c.id === TX);
  assert.equal(v.zeffyId, r.zeffy_id);
  assert.ok(page.includes('${c.zeffyId ? html`<a class="link" href=${zeffyPaymentUrl(c.zeffyId)} target="_blank" rel="noopener" aria-label=${`Open in Zeffy: ${whoFor(c)}`}>Open in Zeffy</a>` : \'\'}'), 'the row links "Open in Zeffy" to the record');
  assert.doesNotMatch(page, /ZEFFY_URL/, 'no button opens the bare payments list where a record is known');
});

test('a check that may be in Zeffy twice: Slack links both records, the one from Checks and the other entry', async () => {
  await posted();
  await approveWith(env(), fakeFetch, TX, { now: NOW + 10 * MIN });
  const r = await rowOf();
  // Someone types the same check in by hand too
  world().payments.push(hand({ id: 'zp_typed', created: dayS('2026-11-03') }));
  for (let t = NOW + 70 * MIN; t <= NOW + DAY; t += 60 * MIN) await quiet(t);
  const s = slackSaid();
  assert.match(s, /twice/, 'Slack says the check may be in Zeffy twice');
  assert.ok(s.includes(`transactionId=${r.zeffy_id}`), 'a button opens the record Checks made');
  assert.ok(s.includes('transactionId=zp_typed'), 'a button opens the other entry');
});

test('a second record for a check is listed by id for the page to link, and its words no longer spell the id out', async () => {
  await posted();
  await approveWith(env(), fakeFetch, TX, { now: NOW + 10 * MIN });
  await env().DB.prepare('UPDATE check_gifts SET extra = ? WHERE id = ?').bind('zp_extra_1', TX).run();
  const v = (await CG.checksView(env(), { now: NOW + 11 * MIN })).list.find((c) => c.id === TX);
  assert.deepEqual(v.extras, ['zp_extra_1']);
  assert.match(v.why, /second record/);
  assert.doesNotMatch(v.why, /zp_extra_1/, 'the page links the record instead of printing its id');
  assert.match(page, /\(c\.extras \|\| \[\]\)\.map\(\(id, i\) => html`<a key=\$\{id\} class="btn btn-ghost btn-sm" href=\$\{zeffyPaymentUrl\(id\)\}/, 'each extra record has a button straight to it');
  assert.match(page, /'Open its record to cancel'/, 'a check that came back links its own record to cancel, beside any second one');
});

test('entries that may be the check, the money check\'s entries and the write test\'s leftovers each open their record', () => {
  assert.match(page, /href=\$\{zeffyPaymentUrl\(x\.id\)\}[^>]*aria-label=\$\{`See it in Zeffy:/, 'a card\'s possible entries');
  assert.match(page, /v\.money\.loose\.slice\(0, 10\)\.map\(\(x, i\) => html`\$\{i \? '; ' : ''\}<a class="link" href=\$\{zeffyPaymentUrl\(x\.id\)\}/, 'the money check\'s entries');
  assert.match(page, /test\.leftBehind\.slice\(0, 3\)\.map\(\(id, i\) => html`<a key=\$\{id\} class="btn btn-ghost" href=\$\{zeffyPaymentUrl\(id\)\}/, 'the write test\'s leftover records');
});

test('the server links the donor whose contact still has the no-mail address, and every card about one record links it', () => {
  const src = readFileSync(new URL('../functions/api/_check-gifts.js', import.meta.url), 'utf8');
  assert.match(src, /label: 'Open the donor in Zeffy', url: zeffyContactUrl\(tag\.contact\)/);
  assert.ok(src.includes("zeffy = row.zeffy_id && !GONE_KINDS.has(kind) ? [{ label: 'Open in Zeffy', id: row.zeffy_id }] : []"), 'a card about a check with a record links it by default');
  assert.match(src, /zeffy: \[\{ label: 'Open the record to delete', id: hit\.id \}\]/);
  assert.match(src, /zeffy: \[\{ label: 'Open the record to cancel', id: hit\.id \}\]/);
  assert.doesNotMatch(src, /const ZEFFY_(PAYMENTS|CONTACTS) = /, 'one place builds Zeffy links: public/admin/zeffy-links.js');
});

test('a card about a record Zeffy no longer has never links it', () => {
  const src = readFileSync(new URL('../functions/api/_check-gifts.js', import.meta.url), 'utf8');
  assert.match(src, /const GONE_KINDS = new Set\(\['record-gone'\]\)/);
  assert.ok(src.includes('zeffy = row.zeffy_id && !GONE_KINDS.has(kind)'));
  assert.ok(src.includes('...result.loose.slice(0, 4).map((x, i) => ({ label:') && src.includes('url: zeffyPaymentUrl(x.id) }))'), 'the Monday money card links the gifts it names');
});

test('a record deleted in Zeffy: the card that says so has no button to it', async () => {
  await posted();
  await approveWith(env(), fakeFetch, TX, { now: NOW + 10 * MIN });
  const r = await rowOf();
  world().slack.length = 0;
  world().payments = world().payments.filter((p) => p.id !== r.zeffy_id);
  for (let t = NOW + 70 * MIN; t <= NOW + 5 * 60 * MIN; t += 60 * MIN) await quiet(t);
  const s = slackSaid();
  assert.match(s, /record is gone|isn’t in Zeffy|gone/i, 'Slack says the record is gone');
  assert.ok(!s.includes(`transactionId=${r.zeffy_id}`), 'and never links the record that isn’t there');
});
