/**
 * Room credits (functions/api/_room-credits.js, _jt-fields.js): who designed a
 * room and who paid for it, picked in JobTread's Designed By and Monetary
 * Sponsor dropdowns (or in Admin → Kids, which writes them). These cover the
 * decisions: the second look, what changed, which partner a value names,
 * a change made to a value list, the dropdown's choices, the website's copy,
 * and reading a field with several choices. Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { look, diff, partnerFor, named, applyChange, wantedChoices, copyOf, onRoom, heldAfter, sameCompany, KINDS, SECOND_LOOK_MS } from '../functions/api/_room-credits.js';
import { nameKey } from '../public/admin/partners-shared.js';
import { fieldLists, fieldValues, fieldList, planChoices, listText, matchChoices } from '../functions/api/_jt-fields.js';

const HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const img = (id) => `https://imagedelivery.net/${HASH}/${id}/public`;
const partners = [
  { slug: 'crosby-design-group', name: 'Crosby Design Group', logo: img('partners/crosby-design-group/1/public'.replace('/public', '')), website: 'https://crosbydesigngroup.com', category: ['design'], level: 'signature' },
  { slug: 'means-interiors', name: 'Means Interiors', logo: img('partners/means-interiors/2'), website: 'https://meansinteriors.com', category: ['design'], level: 'friend' },
  { slug: 'jimmy-helen-carlos', name: 'Jimmy & Helen Carlos', logo: '', website: '', category: ['funding'], level: 'champion' },
  { slug: 'make-a-wish-georgia', name: 'Make A Wish Georgia', logo: img('partners/make-a-wish/3'), website: 'https://wish.org', category: 'community', level: 'friend' },
  { slug: 'acme-supply', name: 'Acme Supply', logo: img('partners/acme/4'), website: '', category: ['build'], level: 'builder' },
];
const at = (min) => new Date(Date.UTC(2026, 10, 10, 12, 0) + min * 60000).toISOString();

test('fieldLists keeps every choice of a several-choice field; fieldValues shows them all', () => {
  const nodes = [
    { customField: { id: 'type' }, value: 'Bedroom' },
    { customField: { id: 'type' }, value: 'Bathroom' },
    { customField: { id: 'status' }, value: 'Build' },
    { customField: { id: 'sponsor' }, value: ['Helen & Jimmy Carlos', 'Beazer'] },
  ];
  assert.deepEqual(fieldLists(nodes).type, ['Bedroom', 'Bathroom']);
  assert.equal(fieldValues(nodes).type, 'Bedroom and Bathroom', 'not only the last choice');
  assert.equal(fieldValues(nodes).status, 'Build', 'a one-value field reads as before');
  assert.deepEqual(fieldList(nodes, 'sponsor'), ['Helen & Jimmy Carlos', 'Beazer'], 'a name with & isn’t split');
  assert.equal(listText(['A', 'B', 'C']), 'A, B and C');
  assert.equal(fieldValues([{ customField: { id: 'd' }, value: true }]).d, true, 'a true/false keeps its type');
  // A text field is exactly as JobTread sent it: the reveal invite hashes its details, and a changed hash emails every guest
  const details = 'Park on Elm.\n\nDoors at 10.  Bring a hat.';
  assert.equal(fieldValues([{ customField: { id: 'x' }, value: details }]).x, details, 'line breaks and spacing kept');
  assert.deepEqual(fieldList([{ customField: { id: 's' }, value: ' Beazer ' }], 's'), ['Beazer'], 'a dropdown’s name is trimmed');
});

test('matchChoices spells a value the way the field’s choice does', () => {
  assert.deepEqual(matchChoices(['crosby design group', 'Gone Co'], ['Crosby Design Group']), ['Crosby Design Group', 'Gone Co']);
});

test('planChoices slots in what’s wanted without moving a person’s order, and only ever drops a choice the site added', () => {
  const have = ['SOARF', 'Make a Wish', 'Beazer'];
  const p = planChoices(have, { wanted: ['Jimmy & Helen Carlos', 'Beazer'], siteAdded: ['Old Name'], held: [] });
  assert.deepEqual(p.added, ['Jimmy & Helen Carlos']);
  assert.deepEqual(p.dropped, [], 'a person’s choices stay even when Partners doesn’t name them');
  assert.deepEqual(p.next.filter((x) => x !== 'Jimmy & Helen Carlos'), have, 'what was there keeps its order');
  assert.equal(planChoices(['B', 'A'], { wanted: ['a', 'B'] }).next, null, 'nothing added: nothing written (no re-sort every run)');
  assert.deepEqual(planChoices(['Apple', 'Cherry'], { wanted: ['Banana'] }).next, ['Apple', 'Banana', 'Cherry'], 'a new one slots in A to Z');
  const q = planChoices(['Old Name', 'New Name'], { wanted: ['New Name'], siteAdded: ['Old Name'], held: ['Old Name'] });
  assert.equal(q.next, null, 'a choice a job still holds isn’t dropped');
  const r = planChoices(['Old Name', 'New Name'], { wanted: ['New Name'], siteAdded: ['Old Name'], held: [] });
  assert.deepEqual(r.dropped, ['Old Name']);
  assert.deepEqual(r.next, ['New Name']);
});

test('partnerFor: Partners’ name, then a Same as link, then the same words in another order, then a former name, then a deleted partner’s slug', () => {
  assert.equal(partnerFor('crosby design group', { partners })?.slug, 'crosby-design-group');
  assert.equal(partnerFor('Helen & Jimmy Carlos', { partners })?.slug, 'jimmy-helen-carlos', 'the same names in another order are one company, as everywhere on the site');
  assert.equal(partnerFor('Carlos Fund', { partners }), null, 'a different name isn’t guessed');
  assert.equal(partnerFor('Carlos Fund', { partners, links: { [partnerKey('Carlos Fund')]: 'jimmy-helen-carlos' } })?.slug, 'jimmy-helen-carlos');
  // Two partners whose words are the same: a question for a person, never a guess
  const twins = [...partners, { slug: 'helen-jimmy-carlos', name: 'Helen Jimmy Carlos', category: ['funding'], level: 'friend' }];
  assert.equal(partnerFor('Carlos, Jimmy & Helen', { partners: twins }), null);
  assert.equal(partnerFor('Jimmy & Helen Carlos', { partners: twins })?.slug, 'jimmy-helen-carlos', 'Partners’ own spelling still finds its partner');
  assert.equal(partnerFor('Means Interiors LLC Old', { partners, former: { [nameKey('Means Interiors LLC Old')]: 'means-interiors' } })?.slug, 'means-interiors', 'a name it had before a rename in Partners');
  assert.equal(partnerFor('SOARF', { partners, known: [{ v: 'SOARF', p: 'means-interiors' }] }), null, 'a match remembered only through a link that’s gone isn’t kept');
  const gone = partnerFor('Old Sponsor', { partners, known: [{ v: 'Old Sponsor', p: 'old-sponsor-gone' }] });
  assert.deepEqual([gone?.slug, gone?.gone], ['old-sponsor-gone', true], 'a partner deleted from Partners keeps its slug, shown as not in Partners');
  assert.equal(partnerFor('', { partners }), null);
});
const partnerKey = nameKey;

test('look: a change counts on the second look, ten minutes on; a slip fixed in time does nothing', () => {
  const ctx = { partners };
  const base = { seen: named(['Crosby Design Group'], ctx), next: null, nextAt: null };
  const picked = named(['Crosby Design Group', 'Means Interiors'], ctx);
  const one = look(base, picked, at(0));
  assert.equal(one.settled, null, 'first look: waits');
  assert.equal(one.row.nextAt, at(0));
  const early = look(one.row, picked, at(SECOND_LOOK_MS / 60000 - 1));
  assert.equal(early.settled, null, 'too soon');
  const two = look(early.row, picked, at(10));
  assert.deepEqual(two.settled.map((x) => x.p), ['crosby-design-group', 'means-interiors']);
  assert.equal(two.row.next, null);
  // A slip: picked then put back before the second look
  const slip = look(look(base, picked, at(0)).row, base.seen, at(5));
  assert.equal(slip.settled, null);
  assert.equal(slip.row.next, null, 'the waiting change is dropped');
  // Couldn't read: nothing changes, the wait is kept
  const down = look(one.row, null, at(20));
  assert.equal(down.settled, null);
  assert.deepEqual(down.row, one.row);
  // A different change before the second look starts the wait again
  const other = look(one.row, named(['Means Interiors'], ctx), at(12));
  assert.equal(other.settled, null);
  assert.equal(other.row.nextAt, at(12));
});

test('look: a settled change says when it was made by at the earliest: the read before it was first seen', () => {
  const ctx = { partners };
  const base = { seen: named(['Crosby Design Group'], ctx), next: null, nextAt: null, readAt: at(0) };
  const picked = named(['Crosby Design Group', 'Means Interiors'], ctx);
  const one = look(base, picked, at(10));
  assert.equal(one.row.nextSince, at(0), 'not there at the read before');
  const two = look({ ...one.row, readAt: at(10) }, picked, at(20));
  assert.equal(two.since, at(0));
  assert.equal(two.row.nextSince, null);
  assert.equal(look({ ...base, readAt: null }, picked, at(10)).row.nextSince, null, 'no read before: not known');
});

test('heldAfter: a change a person made while launch’s question is open joins the website’s answer, and an empty question closes', () => {
  const held = { jobtread: ['robins'], website: ['lizzie'], dismissed: ['robins'] };
  assert.deepEqual(heldAfter(held, { added: [{ p: 'carlos' }] }), { jobtread: ['robins'], website: ['lizzie', 'carlos'], dismissed: ['robins'] }, 'a pick joins the website’s answer');
  assert.deepEqual(heldAfter(held, { removed: [{ p: 'lizzie' }] }), { jobtread: ['robins'], website: [], dismissed: ['robins'] }, 'taken off: off both');
  assert.equal(heldAfter(held, { removed: [{ p: 'robins' }] }), null, 'the name it asked about is gone from JobTread: nothing left to ask');
  assert.equal(heldAfter(held, { added: [{ p: 'robins' }] }), null, 'picked in the admin: the person said so');
  assert.deepEqual(heldAfter(held, { added: [{ v: 'SOARF', p: null }] }), held, 'a name that isn’t a company changes neither list');
  assert.equal(heldAfter(null, { added: [{ p: 'x' }] }), null);
});

test('sameCompany and applyChange: the same names in another order are one company, never written twice', () => {
  assert.ok(sameCompany('Helen & Jimmy Carlos', 'Jimmy & Helen Carlos'));
  assert.ok(sameCompany('Randall Brothers, Inc.', 'Randall Brothers'));
  assert.ok(!sameCompany('Crosby Design Group', 'Means Interiors'));
  assert.deepEqual(applyChange(['Helen & Jimmy Carlos'], { add: ['Jimmy & Helen Carlos'] }), ['Helen & Jimmy Carlos'], 'not added a second time');
  assert.deepEqual(applyChange(['Helen & Jimmy Carlos', 'Beazer'], { remove: ['Jimmy & Helen Carlos'] }), ['Beazer']);
});

test('look: only the spelling changed (a rename) is remembered with nothing to apply', () => {
  const was = [{ v: 'Means Interiors LLC Old', p: 'means-interiors' }];
  const r = look({ seen: was }, [{ v: 'Means Interiors', p: 'means-interiors' }], at(0));
  assert.equal(r.settled, null);
  assert.equal(r.row.seen[0].v, 'Means Interiors');
});

test('diff: by partner when known, by name when not', () => {
  const d = diff([{ v: 'Crosby Design Group', p: 'crosby-design-group' }, { v: 'SOARF', p: null }], [{ v: 'crosby design group', p: 'crosby-design-group' }, { v: 'Beazer', p: null }]);
  assert.deepEqual(d.added.map((x) => x.v), ['Beazer']);
  assert.deepEqual(d.removed.map((x) => x.v), ['SOARF']);
});

test('applyChange: one change, a rename in place, nothing doubled', () => {
  assert.deepEqual(applyChange(['A', 'B'], { add: ['C', 'a'] }), ['A', 'B', 'C']);
  assert.deepEqual(applyChange(['A', 'B', 'C'], { remove: ['b'] }), ['A', 'C']);
  assert.deepEqual(applyChange(['Old', 'B'], { rename: [['Old', 'New']] }), ['New', 'B']);
  assert.deepEqual(applyChange(['Old', 'New'], { rename: [['Old', 'New']] }), ['New'], 'a rename onto a name already there makes one');
  assert.deepEqual(applyChange(['A', 'X'], { add: ['B'], remove: ['A'] }), ['X', 'B'], 'a person’s pick made since the last read stays');
});

test('wantedChoices: the category in Partners, and anyone credited anywhere', () => {
  assert.deepEqual(wantedChoices(KINDS.designed, partners), ['Crosby Design Group', 'Means Interiors']);
  assert.deepEqual(wantedChoices(KINDS.sponsored, partners, ['make-a-wish-georgia']), ['Jimmy & Helen Carlos', 'Make A Wish Georgia'], 'Make A Wish is filed under Community but credited');
});

test('copyOf: the partners the settled values name, unknown names left out', () => {
  assert.deepEqual(copyOf([{ v: 'A', p: 'a' }, { v: 'SOARF', p: null }, { v: 'a again', p: 'a' }]), ['a']);
});

test('onRoom: a logo on the page, or anyone of theirs on the job', () => {
  const rec = { data: { partnerLogos: [{ url: img('partners/acme/4'), name: 'Acme Supply' }] } };
  assert.equal(onRoom(partners[4], rec, { partners }), true, 'their logo');
  assert.equal(onRoom(partners[0], rec, { partners }), false, 'no logo, no job');
  const aces = (m) => ({ nodes: [{ membership: { isInternal: false, account: m.account || null, user: { emailAddress: m.email } } }] });
  assert.equal(onRoom(partners[0], rec, { partners, aces: aces({ email: 'ella@crosbydesigngroup.com' }) }), true, 'their website’s domain');
  assert.equal(onRoom(partners[0], rec, { partners, aces: aces({ email: 'x@gmail.com', account: { id: 'a1', name: 'Crosby Design Group' } }) }), true, 'their JobTread account');
  assert.equal(onRoom(partners[1], rec, { partners, aces: aces({ email: 'angela@gmail.com' }), contacts: [{ email: 'Angela@gmail.com' }] }), true, 'a contact’s email');
  assert.equal(onRoom(partners[1], rec, { partners, aces: { nodes: [{ membership: { isInternal: true, user: { emailAddress: 'angela@meansinteriors.com' } } }] } }), false, 'staff don’t count');
});
