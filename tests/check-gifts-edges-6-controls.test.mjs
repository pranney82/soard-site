/**
 * Controls for tests/check-gifts-edges-6.test.mjs: the same scenarios with the one detail changed, so a pass there is for
 * the reason named. Names are made up. Run: node --test tests/check-gifts-edges-6-controls.test.mjs
 */
// Controls for r7: the same scenarios with the one thing changed that the finding blames. All should pass.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
const { W, CG, setup, run, rowOf, posted, fakeFetch, hand, read, approve, card, dayS, NOW, MIN, TX } = await import('./lib/check-gifts-harness-2.mjs');
const { handlePayment } = await import('../functions/api/_zeffy.js');
const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => setup());
const person = (first, last, o = {}) => ({ first_name: first, last_name: last, email: null, is_corporate: false, company_name: null, ...o });
const sitePosts = () => W.world.posts.filter((b) => b.amount > 100);
/**
 * Goes to a person (Nov 10: every check waits on a card; here the card asks about `entry`): its notes say it may be a double,
 * and pressing Send as the card says reads Zeffy again and shows `entry` instead of saving
 */
async function heldOver(entry, note = 'maybe-double') {
  const r = await rowOf();
  const kinds = ((await card())?.card?.notes || []).map((n) => n.kind);
  const listed = r.note?.startsWith('[') ? JSON.parse(r.note).map((x) => x.id) : [];
  assert.deepEqual({ state: r.state, note: kinds.includes(note), listed: listed.includes(entry) }, { state: 'person', note: true, listed: true }, `notes ${JSON.stringify(kinds)}, entries ${JSON.stringify(listed)}`);
  const held = await approve(TX, { now: NOW + 15 * MIN }).then(() => null, (e) => e);
  assert.ok(held?.status === 409 && held.entries?.some((x) => x.id === entry), `Send ${held ? `was refused (${held.status}: ${held.message})` : 'went through'}`);
}

test('C1 (H1 control) the same paid promise under the foundation\'s own name goes to a person', async () => {
  W.world.reading = read({ payer: 'Whitfield Family Foundation' });
  const p = hand({ id: 'zp_promise', type: 'online', status: 'succeeded', created: dayS('2026-09-24'), buyer: person('Whitfield Family Foundation', 'Whitfield Family Foundation') });
  W.world.payments.push(p);
  await handlePayment(W.env, p, { via: 'webhook', now: Date.parse('2026-11-04T15:00:00Z') });
  await posted();
  await heldOver('zp_promise');
  assert.equal(sitePosts().length, 0);
  assert.equal((await rowOf()).state, 'person');
});
test('C1b (H1, after its fix) a promise turned paid since the check was written is held under any name', () => {
  const row = { id: 'x', cents: 1000000, payer: 'Whitfield Family Foundation', check_date: '2026-11-03', deposited_at: '2026-11-05T15:00:00Z' };
  const p = hand({ id: 'zp_promise', type: 'online', created: dayS('2026-09-24'), buyer: person('Dana', 'Whitfield') });
  assert.deepEqual(CG.netOf(row, [p], new Set(), { turnedPaid: new Set(['zp_promise']) }).map((x) => x.id), ['zp_promise']);
  assert.deepEqual(CG.netOf({ ...row, payer: 'Dana Whitfield' }, [p], new Set(), { turnedPaid: new Set(['zp_promise']) }).map((x) => x.id), ['zp_promise']);
});
test('C2 (H2 control) the advisor-name entry with the right year goes to a person', async () => {
  W.world.reading = read({ payer: 'Fidelity Charitable' });
  W.world.payments.push(hand({ id: 'zp_ok', created: dayS('2026-11-03'), buyer: person('Dana', 'Whitfield') }));
  await posted();
  await heldOver('zp_ok');
  assert.equal(sitePosts().length, 0);
});
test('C2b (H2b control) the giver\'s own slipped entry, when the webhook delivers it, goes to a person', async () => {
  const p = hand({ id: 'zp_slip', created: dayS('2025-11-03') });
  W.world.payments.push(p);
  await handlePayment(W.env, p, { via: 'webhook', now: Date.parse('2026-11-04T15:00:00Z') });
  await posted();
  await heldOver('zp_slip');
  assert.equal(sitePosts().length, 0);
});
test('C3 (H3 control) the advisor-name entry with the right amount goes to a person', async () => {
  W.world.reading = read({ payer: 'Fidelity Charitable' });
  W.world.payments.push(hand({ id: 'zp_ok', created: dayS('2026-11-04'), buyer: person('Dana', 'Whitfield') }));
  await posted();
  await heldOver('zp_ok');
  assert.equal(sitePosts().length, 0);
});
