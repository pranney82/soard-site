/**
 * Homes from JobTread: the location fields (Zestimate, Living Area, Bed Bath,
 * Year Built…) on a kid's Home card in Admin → Kids and on Applications →
 * Insights (Their homes).
 *  - public/admin/home-shared.js: how each field reads, which leads, how
 *    Insights counts them
 *  - functions/api/_home.js + /api/job-home: a job's home, read live
 *  - functions/api/_applicants.js: the mirror keeps each home's fields and
 *    JobTread's list of fields; insights() hands them to the page
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  homeFields, kindOf, show, homeFacts, homeInsights, placeDots, asNumber, asTime, shortMoney, linkLabel, safeUrl, stripText, endText, isShown, oddWords,
  decisionOf, byDecision, decisionCounts,
} from '../public/admin/home-shared.js';
import { jobHome, locationFields, forgetLocationFields, cleanFields, valuesOf, HOME_VALUES, jobtreadLocationUrl } from '../functions/api/_home.js';
import { onRequestGet as jobHomeGet } from '../functions/api/job-home.js';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld, ORG } from './lib/fake-applicant-world.mjs';
import { syncAllApplicants, refreshApplicants, FIELDS, homeFieldList } from '../functions/api/_applicants.js';
import { insights, ensureSchema as ensureApplicationsSchema } from '../functions/api/_applications.js';

// SOARD's location fields as JobTread lists them (Nov 9 2026), in its order, with the retired number field
const DEFS = [
  { id: 'fZillow', name: 'Zillow URL', type: 'url', position: 'a0' },
  { id: 'fArea', name: 'Living Area', type: 'number', position: 'a1' },
  { id: 'fBedBath', name: 'Bed Bath', type: 'text', position: 'a2' },
  { id: 'fYearOld', name: 'Year Built (old)', type: 'number', position: 'a3' },
  { id: '22PK2MzzJD93', name: 'County', type: 'text', position: 'a4' },
  { id: 'fSewer', name: 'Sewer/Septic', type: 'option', position: 'a5', options: ['Sewer', 'Septic'] },
  { id: 'fPower', name: 'Power Company', type: 'text', position: 'a6' },
  { id: 'fWater', name: 'Water Source', type: 'text', position: 'a7' },
  { id: 'fParcel', name: 'Parcel Number', type: 'text', position: 'a8' },
  { id: 'fPermit', name: 'Permit Number', type: 'text', position: 'a9' },
  { id: 'fZest', name: 'Zestimate', type: 'number', position: 'aA' },
  { id: 'fSale', name: 'Latest Sale Price', type: 'number', position: 'aB' },
  { id: 'fSaleDate', name: 'Latest Sale Date', type: 'date', position: 'aC' },
  { id: 'fYear', name: 'Year Built', type: 'text', position: 'aD' },
  { id: 'fBook', name: '**REQUIRED FIELDS**', type: 'text', position: 'aE' },
];
// Lizzie's home, as DataX filled it (location 22PKGcC6dRFu)
const LIZZIE = {
  fZillow: 'https://www.zillow.com/homedetails/1314-Timuquana-Trl-Woodstock-GA-30188/54837901_zpid/',
  fArea: 1435, fBedBath: '3 bed, 2.5 bath', fYearOld: 2000, fParcel: '15N23D178',
  fZest: 336500, fSale: 128700, fSaleDate: '2001-01-23', fYear: '2000',
};

// ─── How each field reads ───────────────────────────────────────────

test('fields come in JobTread’s order, without bookkeeping or retired ones', () => {
  const names = homeFields([...DEFS].reverse()).map(f => f.name);
  assert.deepEqual(names, ['Zillow URL', 'Living Area', 'Bed Bath', 'County', 'Sewer/Septic', 'Power Company', 'Parcel Number', 'Permit Number', 'Zestimate', 'Latest Sale Price', 'Latest Sale Date', 'Year Built'], 'Water Source isn’t used, so it never shows');
  assert.equal(isShown({ name: 'Water Source' }), false);
  assert.equal(isShown({ name: 'Permitting Municipality' }), true);
  assert.equal(isShown({ name: 'Year Built (old)' }), false);
  assert.equal(isShown({ name: 'Notes (retired)' }), false);
  assert.equal(isShown({ name: '**Reveal Date**' }), false);
  assert.equal(isShown({ name: 'Roof (older side)' }), true);
  // Numbered positions sort as numbers, and a field with no position keeps JobTread's listing order
  assert.deepEqual(homeFields([{ id: 'b', name: 'B', position: '10' }, { id: 'a', name: 'A', position: '9' }]).map(f => f.id), ['a', 'b']);
  assert.deepEqual(homeFields([{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }]).map(f => f.id), ['x', 'y']);
});

test('each field reads by its type, its name and its values', () => {
  const f = Object.fromEntries(DEFS.map(d => [d.id, d]));
  assert.equal(kindOf(f.fZest, [336500]), 'money');
  assert.equal(kindOf(f.fSale, [128700]), 'money');
  assert.equal(kindOf(f.fArea, [1435]), 'area');
  assert.equal(kindOf(f.fYear, ['2000']), 'year');          // text that holds a year
  assert.equal(kindOf(f.fSaleDate, ['2001-01-23']), 'date');
  assert.equal(kindOf(f.fZillow, ['https://x']), 'link');
  assert.equal(kindOf(f.fSewer, ['Septic']), 'choice');
  assert.equal(kindOf(f.fBedBath, ['3 bed, 2.5 bath']), 'bedbath');
  assert.equal(kindOf(f.fParcel, ['15N23D178']), 'text');
  assert.equal(kindOf(f.fParcel, ['123456']), 'text', 'digits that name a parcel aren’t an amount');
  assert.equal(kindOf(f.fPower, ['Georgia Power']), 'text');
  assert.equal(kindOf({ name: 'Lot Size', type: 'number' }, [8000]), 'number');
  assert.equal(kindOf({ name: 'Year Built', type: 'text' }, ['circa 1950']), 'text', 'a year typed in words stays as typed');
  assert.equal(kindOf({ name: 'Roof Replaced', type: 'boolean' }, [true]), 'yesno');
  assert.equal(kindOf({ name: 'Year Built', type: 'number' }, []), 'year', 'with nothing filled in, the name decides');
  // Names that only look like money or area
  assert.equal(kindOf({ name: 'Current Occupants', type: 'number' }, [5]), 'number', '“Current” isn’t rent');
  assert.equal(kindOf({ name: 'People in Home (current)', type: 'number' }, [5]), 'number');
  assert.equal(kindOf({ name: 'Tax ID', type: 'number' }, [15023178]), 'text', 'an ID is shown as typed');
  assert.equal(show(kindOf({ name: 'Tax ID', type: 'number' }, [15023178]), 15023178), '15023178');
  assert.equal(kindOf({ name: 'Tax District', type: 'number' }, [4]), 'number');
  assert.equal(kindOf({ name: 'Tax Rate', type: 'number' }, [1.2]), 'number');
  assert.equal(kindOf({ name: 'Property Tax', type: 'number' }, [3200]), 'money');
  assert.equal(kindOf({ name: 'Lot Area', type: 'number' }, [0.23]), 'number', 'a lot may be in acres, so no sq ft');
  assert.equal(kindOf({ name: 'Number of Stories', type: 'number' }, [2]), 'number', 'a count, not an ID');
  // Most of the values decide: a stray word doesn't turn numbers into text
  assert.equal(kindOf({ name: 'Year Built', type: 'text' }, ['1950s', '2000', '1999', '1987']), 'year');
  assert.equal(kindOf({ name: 'Zestimate', type: 'text' }, ['$336,500', 'N/A', '$285,000', '$410,000']), 'money');
  assert.equal(kindOf({ name: 'Bed Bath', type: 'text' }, ['3 bed, 2 bath', 'Mobile home', '2 bed, 1 bath', '4 bed, 2 bath']), 'bedbath');
});

test('values read the way a person reads them', () => {
  assert.equal(show('money', 336500), '$336,500');
  assert.equal(show('money', '$1,250,000'), '$1,250,000');
  assert.equal(show('area', 1435), '1,435 sq ft');
  assert.equal(show('year', '2000'), '2000');
  assert.equal(show('date', '2001-01-23'), 'Jan 23, 2001', 'a date never slips a day, whatever the time zone');
  assert.equal(show('yesno', true), 'Yes');
  assert.equal(show('yesno', 'false'), 'No');
  assert.equal(show('choice', ['Sewer', 'Septic']), 'Sewer, Septic');
  assert.equal(show('text', '  Georgia Power  '), 'Georgia Power');
  assert.equal(show('text', { street: '1 Main St', city: 'Marietta', zip: null }), '1 Main St, Marietta', 'an address field that comes as an object reads as words');
  assert.equal(show('text', {}), '');
  assert.equal(shortMoney(336500), '$337K');
  assert.equal(shortMoney(1250000), '$1.3M');
  assert.equal(shortMoney(12500000), '$13M');
  assert.equal(shortMoney(999500), '$1M', 'never “$1,000K”');
  assert.equal(shortMoney(-5000), '-$5K');
  assert.equal(show('money', -5), '-$5');
  assert.equal(show('area', 1882.5), '1,883 sq ft', 'square feet are whole');
  assert.equal(show('date', '2026-11-08T23:30:00-05:00'), 'Nov 8, 2026', 'a date and time reads as it was in Georgia');
  assert.equal(stripText('date', Date.parse('2026-01-01T03:00:00Z'), true), '2025', 'a timed value’s year is Georgia’s too');
  assert.equal(oddWords('year'), 'not a year');
  assert.equal(asNumber('1,435 sq ft'), 1435);
  assert.equal(asNumber('3 bed'), null);
  assert.equal(asTime('2001-01-23'), Date.UTC(2001, 0, 23));
  assert.equal(stripText('date', Date.UTC(2009, 5, 1)), '2009');
  assert.equal(endText('money', 160000), '$160K');
  assert.equal(linkLabel({ name: 'Zillow URL' }, 'https://www.zillow.com/x'), 'Zillow');
  assert.equal(linkLabel({ name: 'URL' }, 'https://www.redfin.com/x'), 'redfin.com');
  assert.equal(safeUrl('javascript:alert(1)'), null, 'only web links open');
  assert.equal(safeUrl(' https://zillow.com/a '), 'https://zillow.com/a');
});

test('a kid’s Home card: the Zestimate leads, Zillow is a link, the rest in JobTread’s order, the empty fields named', () => {
  const card = homeFacts(DEFS, { ...LIZZIE, fBook: 'x' });
  assert.equal(card.lead.name, 'Zestimate');
  assert.equal(card.lead.text, '$336,500');
  assert.deepEqual(card.links.map(l => [l.text, l.href]), [['Zillow', LIZZIE.fZillow]]);
  assert.deepEqual(card.rest.map(x => [x.name, x.text]), [
    ['Living Area', '1,435 sq ft'], ['Bed Bath', '3 bed, 2.5 bath'], ['Parcel Number', '15N23D178'],
    ['Latest Sale Price', '$128,700'], ['Latest Sale Date', 'Jan 23, 2001'], ['Year Built', '2000'],
  ]);
  assert.deepEqual(card.blank, ['County', 'Sewer/Septic', 'Power Company', 'Permit Number']);
  assert.ok(!JSON.stringify(card).includes('REQUIRED'), 'bookkeeping never shows');
  assert.ok(!card.rest.some(x => /old/.test(x.name)), 'the retired field never shows');
  // Nothing filled in, a link that isn't a web link, and a home with no Zestimate but a sale price
  assert.deepEqual(homeFacts(DEFS, {}).filled, 0);
  assert.equal(homeFacts(DEFS, { fPower: {} }).filled, 0, 'an empty object is nothing filled in');
  const bad = homeFacts(DEFS, { fZillow: 'javascript:alert(1)' });
  assert.equal(bad.links.length, 0, 'only web links open');
  assert.deepEqual(bad.rest.map(x => [x.name, x.text, x.href]), [['Zillow URL', 'javascript:alert(1)', null]], 'anything else in a link field shows as typed, never dropped');
  const bare = homeFacts(DEFS, { fZillow: 'www.zillow.com/homedetails/1314/54837901_zpid/' });
  assert.deepEqual(bare.links.map(l => [l.text, l.href]), [['Zillow', 'https://www.zillow.com/homedetails/1314/54837901_zpid/']], 'a link typed without https still opens');
  assert.equal(homeFacts(DEFS, { fSale: 90000 }).lead, null, 'only the home’s value leads, never a sale price or anything else');
  // A field staff add later shows up by itself, where JobTread puts it
  const more = homeFacts([...DEFS, { id: 'fRoof', name: 'Roof Replaced', type: 'date', position: 'aF' }], { ...LIZZIE, fRoof: '2019-06-01' });
  assert.deepEqual(more.rest.at(-1), { id: 'fRoof', name: 'Roof Replaced', kind: 'date', value: '2019-06-01', text: 'Jun 1, 2019', href: null });
});

// ─── Insights: their homes ──────────────────────────────────────────

const person = (id, name, home) => ({ id, name, state: 'submitted', accountId: `acct-${id}`, home });
const PEOPLE = [
  person('d1', 'Lizzie Francis', { ...LIZZIE, fSewer: 'Septic', fPower: 'Cobb EMC', fWater: 'Public', '22PK2MzzJD93': 'Cherokee' }),
  person('d2', 'Avery Stone', { fZest: 285000, fArea: 1820, fBedBath: '4 bed, 2 bath', fYear: '1987', fSewer: 'Sewer', fPower: 'Georgia Power', fWater: 'public', fParcel: 'A-1', '22PK2MzzJD93': 'Cobb', fSaleDate: '2015-06-30', fSale: 210000 }),
  person('d3', 'Remi Lane', { fZest: 540000, fArea: 2950, fBedBath: '5 bed, 3 bath', fYear: '2004', fSewer: 'Sewer', fPower: 'Georgia Power', fWater: 'Well', fParcel: 'B-2', '22PK2MzzJD93': 'Cobb' }),
  person('d4', 'Nico Lane', { fZest: 160000, fBedBath: '2 bed, 1 bath', fYear: '1962', fSewer: 'Septic', fPower: 'A cooperative whose long name a family member typed out in full, the way the bill spells it', fParcel: 'C-3' }),
  person('d5', 'Jordan Ray', { '22PK2MzzJD93': 'Fulton' }),   // the form's County only, nothing from Zillow yet
  person('d6', 'Sam Ray', {}),                                // in JobTread, nothing filled in
];

test('Insights: a strip for each number, its homes in order, with the median, the range and who’s missing', () => {
  const sum = homeInsights(DEFS, PEOPLE);
  assert.equal(sum.homes.length, 6);
  assert.deepEqual(sum.strips.map(s => s.name), ['Zestimate', 'Living Area', 'Latest Sale Price', 'Latest Sale Date', 'Year Built'], 'the home’s value leads, the rest in JobTread’s order');
  const zest = sum.strips.find(s => s.name === 'Zestimate');
  assert.equal(zest.kind, 'money');
  assert.deepEqual(zest.points.map(x => x.p.name), ['Nico Lane', 'Avery Stone', 'Lizzie Francis', 'Remi Lane'], 'lowest to highest');
  assert.equal(zest.median, (285000 + 336500) / 2);
  assert.equal(zest.min, 160000);
  assert.equal(zest.max, 540000);
  assert.deepEqual(zest.missing.map(p => p.name), ['Jordan Ray', 'Sam Ray']);
  assert.equal(zest.points[0].text, '$160,000');
  const year = sum.strips.find(s => s.name === 'Year Built');
  assert.equal(year.kind, 'year');
  assert.equal(year.median, (1987 + 2000) / 2);
  assert.equal(stripText('year', year.median), '1994', 'a year’s median reads as a year');
  assert.equal(stripText('area', 1882.5), '1,883 sq ft', 'an area’s median is whole square feet');
  const sold = sum.strips.find(s => s.name === 'Latest Sale Date');
  assert.equal(sold.kind, 'date');
  assert.equal(stripText('date', sold.min), '2001');
});

test('Insights: choices count most first (spellings joined), rooms in number order, and text that names one home stays out', () => {
  const sum = homeInsights(DEFS, PEOPLE);
  assert.deepEqual(sum.groups.map(g => g.name), ['Bedrooms', 'Bathrooms', 'County', 'Sewer/Septic', 'Power Company']);
  const beds = sum.groups.find(g => g.name === 'Bedrooms');
  assert.deepEqual(beds.rows.map(r => [r.label, r.n]), [['2 bedrooms', 1], ['3 bedrooms', 1], ['4 bedrooms', 1], ['5 bedrooms', 1]]);
  assert.equal(beds.from, 'Bed Bath');
  const baths = sum.groups.find(g => g.name === 'Bathrooms');
  assert.deepEqual(baths.rows.map(r => r.label), ['1 bath', '2 baths', '2.5 baths', '3 baths']);
  assert.deepEqual(baths.missing.map(p => p.name), ['Jordan Ray', 'Sam Ray']);
  const heat = homeInsights([{ id: 'h', name: 'Heating', type: 'text' }], ['Gas', 'gas', 'Electric'].map((h, i) => person(`h${i}`, `H${i}`, { h })));
  assert.deepEqual(heat.groups[0].rows.map(r => [r.label, r.n]), [['Gas', 2], ['Electric', 1]], '“gas” and “Gas” are one answer, written the way most wrote it, a capital first on a tie');
  const county = sum.groups.find(g => g.name === 'County');
  assert.deepEqual(county.rows.map(r => [r.label, r.n]), [['Cobb', 2], ['Cherokee', 1], ['Fulton', 1]]);
  const power = sum.groups.find(g => g.name === 'Power Company');
  assert.ok(power.rows.some(r => r.label.length > 60), 'a long answer is kept whole (the page wraps it)');
  assert.ok(!sum.groups.some(g => /Parcel|Permit|Zillow/.test(g.name)), 'numbers and links that belong to one home never get counted');
  // Every row's people add up to the homes with an answer
  for (const g of sum.groups) {
    const counted = new Set(g.rows.flatMap(r => r.list));
    assert.equal(counted.size + g.missing.length, sum.homes.length, g.name);
  }
});

test('Insights: free text where every home answers differently is left out; a field no one filled in is too', () => {
  const defs = [{ id: 'n', name: 'Foundation', type: 'text' }, { id: 'e', name: 'Empty', type: 'number' }];
  const people = [person('a', 'A', { n: 'Left side slab' }), person('b', 'B', { n: 'Crawl space, partly' }), person('c', 'C', { n: 'Ring twice' })];
  const sum = homeInsights(defs, people);
  assert.equal(sum.groups.length, 0);
  assert.equal(sum.strips.length, 0);
  // Two homes the same is a pattern worth counting
  const two = homeInsights(defs, [...people, person('d', 'D', { n: 'Ring twice' })]);
  assert.deepEqual(two.groups[0].rows.map(r => [r.label, r.n]), [['Ring twice', 2], ['Crawl space, partly', 1], ['Left side slab', 1]], 'half the homes share an answer: worth counting');
  // A field named for one home's own words never becomes rows, however the answers fall
  const gate = homeInsights([{ id: 'g', name: 'Gate Instructions', type: 'text' }], [person('a', 'A', { g: 'None' }), person('b', 'B', { g: 'None' }), person('c', 'C', { g: 'Code 4417, then left' })]);
  assert.equal(gate.groups.length, 0);
  // Most homes with their own answer: left on the cards, not counted
  const own = homeInsights(defs, [...people, person('d', 'D', { n: 'Ring twice' }), person('e', 'E', { n: 'Pier and beam' }), person('f', 'F', { n: 'Basement' })]);
  assert.equal(own.groups.length, 0);
});

test('Insights: dots never overlap; a crowd stacks into lanes above and below the line', () => {
  const pts = [100, 101, 102, 103, 104, 300, 900].map((v, i) => ({ v, p: { id: i } }));
  const { dots, lo, hi } = placeDots(pts, { width: 400, pad: 10, gap: 14, min: 100, max: 900 });
  for (const a of dots) for (const b of dots) if (a !== b && a.lane === b.lane) assert.ok(Math.abs(a.x - b.x) >= 14, `${a.v} and ${b.v} touch`);
  assert.equal(dots[0].x, 10);
  assert.equal(dots.at(-1).x, 390);
  assert.ok(lo < 0 && hi > 0, 'lanes go both ways');
  const one = placeDots([{ v: 5, p: {} }], { width: 300, min: 5, max: 5 });
  assert.equal(one.dots[0].x, 150, 'one value sits in the middle');
});

test('Insights: typed values that aren’t numbers are counted apart, never dropped; the field stays a strip', () => {
  const defs = [{ id: 'y', name: 'Year Built', type: 'text' }, { id: 'z', name: 'Zestimate', type: 'text' }];
  const people = Array.from({ length: 20 }, (_, i) => person(`p${i}`, `P${i}`, { y: String(1950 + i * 3), z: `$${(200 + i * 10) * 1000}` }));
  people[3].home.y = '1950s';
  people[7].home.y = 'Unknown';
  people[9].home.z = 'N/A';
  const sum = homeInsights(defs, people);
  const year = sum.strips.find(s => s.name === 'Year Built');
  const zest = sum.strips.find(s => s.name === 'Zestimate');
  assert.ok(year && zest, 'both stay strips');
  assert.equal(sum.strips[0], zest, 'and the Zestimate still leads');
  assert.equal(year.points.length, 18);
  assert.deepEqual(year.odd.map(x => x.text), ['1950s', 'Unknown']);
  assert.deepEqual(zest.odd.map(x => [x.p.name, x.text]), [['P9', 'N/A']]);
  assert.equal(year.points.length + year.odd.length + year.missing.length, 20, 'every home is counted once');
});

test('Insights: a count with a few values reads as rows; a pile of equal values stays a few lanes tall', () => {
  const people = Array.from({ length: 60 }, (_, i) => person(`p${i}`, `P${i}`, { s: i % 3 ? 1 : 2, z: 250000, a: 1435 }));
  const defs = [{ id: 's', name: 'Stories', type: 'number' }, { id: 'z', name: 'Zestimate', type: 'number' }, { id: 'a', name: 'Living Area', type: 'number' }];
  const sum = homeInsights(defs, people);
  const stories = sum.groups.find(g => g.name === 'Stories');
  assert.deepEqual(stories.rows.map(r => [r.label, r.n]), [['1', 40], ['2', 20]], 'Stories: 1 or 2 is two rows, in number order');
  const zest = sum.strips.find(s => s.name === 'Zestimate');
  const placed = placeDots(zest.points, { width: 600, min: zest.min, max: zest.max, low: zest.low, high: zest.high });
  assert.ok(placed.hi - placed.lo + 1 <= 7, `at most 7 lanes (${placed.hi - placed.lo + 1})`);
  assert.equal(placed.dots.length, 60, 'every home still has a dot');
  assert.ok(placed.dots.some(d => d.piled), 'the rest pile up');
});

test('Insights: a home far past the rest sits beyond a break, so the others keep the width', () => {
  const strip = (values) => homeInsights([{ id: 'z', name: 'Zestimate', type: 'number' }], values.map((z, i) => person(`p${i}`, `P${i}`, { z }))).strips[0];
  // 59 homes from $200K to $490K, and one at $25M
  const s = strip([...Array.from({ length: 59 }, (_, i) => 200000 + i * 5000), 25000000]);
  assert.equal(s.min, 200000);
  assert.equal(s.max, 25000000, 'the scale still ends at the real highest');
  assert.equal(s.low, 200000);
  assert.equal(s.high, 490000, 'the main scale ends at the highest of the rest');
  const placed = placeDots(s.points, { width: 600, min: s.min, max: s.max, low: s.low, high: s.high, zone: 30 });
  assert.ok(placed.breaks.after && !placed.breaks.before, 'a break before the far one only');
  const main = placed.dots.filter(d => d.v <= s.high);
  assert.ok(Math.max(...main.map(d => d.x)) - Math.min(...main.map(d => d.x)) > 450, 'the 59 spread across the strip instead of one corner');
  assert.ok(placed.dots.find(d => d.v === 25000000).x > placed.breaks.right, 'the far one sits past the break');
  assert.ok(placed.xOf(s.median) < placed.breaks.right, 'the median is on the main scale');
  // Far below works the same way
  const low = strip([1000, ...Array.from({ length: 59 }, (_, i) => 1000000 + i * 5000)]);
  assert.equal(low.low, 1000000);
  assert.ok(placeDots(low.points, { width: 600, min: low.min, max: low.max, low: low.low, high: low.high }).breaks.before);
  // Spread out but not far out ($1,000 among $200K to $490K): one scale, no break
  const wide = strip([1000, ...Array.from({ length: 59 }, (_, i) => 200000 + i * 5000)]);
  assert.equal(wide.low, 1000);
  // $0 is nobody's home value: counted apart, and the median and scale are the rest's
  const zeros = strip([0, 0, 300000, 320000, 340000]);
  assert.equal(zeros.zero.length, 2);
  assert.equal(zeros.median, 320000);
  assert.equal(zeros.points.length, 3);
  // A handful of homes never gets a break: too few to say what's far out
  assert.equal(strip([100000, 120000, 2000000]).high, 2000000);
});

test('Insights: bedrooms and bathrooms take a studio, and anything else typed is shown as written', () => {
  const people = [person('a', 'A', { b: 'Studio, 1 bath' }), person('b', 'B', { b: '3 bed, 2 bath' }), person('c', 'C', { b: 'Mobile home' }), person('d', 'D', { b: '2 bed, 1 bath' }), person('e', 'E', {})];
  const sum = homeInsights([{ id: 'b', name: 'Bed Bath', type: 'text' }], people);
  const beds = sum.groups.find(g => g.name === 'Bedrooms');
  assert.deepEqual(beds.rows.map(r => [r.label, r.n]), [['Studio', 1], ['2 bedrooms', 1], ['3 bedrooms', 1], ['Written another way', 1]]);
  assert.equal(beds.rows.at(-1).odd, true);
  assert.equal(beds.said.c, 'Mobile home', 'its words go with it');
  assert.deepEqual(beds.missing.map(p => p.id), ['e'], 'only an empty field is “not filled in”');
});

test('Round 2: amounts as people type them, years with typos, the right lead, county spellings, names that aren’t money', () => {
  // Amounts the way staff type them
  assert.deepEqual(['$ 3,100', '$2.1k', '$1.2M', 'about $2,000', '$2,300/yr', '($5,000)', '$1,980.50', '2,450 per year'].map(asNumber), [3100, 2100, 1200000, 2000, 2300, -5000, 1980.5, 2450]);
  assert.equal(asNumber('circa 1950'), null);
  const tax = homeInsights([{ id: 't', name: 'Property Tax', type: 'text' }], ['$2,450', '$1,980.50', '$ 3,100', '3100', '$2.1k', 'about $2,000', '$2,300/yr', '$1,875'].map((t, i) => person(`p${i}`, `P${i}`, { t })));
  assert.equal(tax.strips[0]?.points.length, 8, 'every typed amount is placed');
  // A year field with a typo or a 0: the rest still read as years
  const years = homeInsights([{ id: 'y', name: 'Year Built', type: 'text' }], ['1962', '1984', '1990', '19877', '2001', '2010', '2015', '1999'].map((y, i) => person(`p${i}`, `P${i}`, { y })));
  assert.equal(years.strips[0].kind, 'year');
  assert.deepEqual(years.strips[0].odd.map(x => x.text), ['19877'], 'the typo is counted apart');
  assert.equal(stripText('year', years.strips[0].max), '2015');
  const remodel = homeInsights([{ id: 'r', name: 'Year Remodeled', type: 'number' }], [0, 1991, 2005, 2015, 1988].map((r, i) => person(`p${i}`, `P${i}`, { r })));
  assert.equal(remodel.strips[0].kind, 'year');
  assert.equal(remodel.strips[0].odd.length, 1);
  // The Zestimate leads, wherever JobTread lists it
  const defs = [{ id: 'rz', name: 'Rent Zestimate', type: 'number', position: 'a0' }, { id: 'tv', name: 'Tax Assessed Value', type: 'number', position: 'a1' }, { id: 'z', name: 'Zestimate', type: 'number', position: 'a2' }];
  assert.equal(homeFacts(defs, { rz: 1850, tv: 280000, z: 336500 }).lead.name, 'Zestimate');
  assert.equal(homeFacts(defs, { rz: 1850, tv: 280000 }).lead, null, 'a rent or tax figure never leads');
  assert.equal(homeFacts(defs, { z: 0 }).lead, null, '$0 never leads');
  assert.equal(homeInsights(defs, [person('a', 'A', { rz: 1850, z: 336500 }), person('b', 'B', { rz: 2100, z: 410000 })]).strips[0].name, 'Zestimate');
  // "Cobb County" and "Cobb" are one county
  const counties = homeInsights([{ id: 'c', name: 'County', type: 'text' }], ['Cobb', 'Cobb County', 'Cobb county', 'Cherokee', 'Cherokee County'].map((c, i) => person(`p${i}`, `P${i}`, { c })));
  assert.deepEqual(counties.groups[0].rows.map(r => [r.label, r.n]), [['Cobb', 3], ['Cherokee', 2]]);
  // Money names, and things that are never amounts
  for (const name of ['HOA Fees', 'HOA Dues', 'Monthly Payment', 'Insurance Premium', 'Annual Income', 'Valuation', 'Loan Balance', 'Utility Bill', 'Repair Estimate', 'Budget', 'Sold For']) assert.equal(kindOf({ name, type: 'number' }, [150]), 'money', name);
  for (const name of ['ZIP', 'Postal Code', 'Owner Name', 'Phone']) assert.equal(kindOf({ name, type: 'text' }, ['30188']), 'text', name);
  assert.equal(show(kindOf({ name: 'ZIP', type: 'text' }, ['30188']), '30188'), '30188', 'a ZIP has no comma');
  // A date and time at midnight UTC is a plain date; a real time reads in Georgia
  assert.equal(show('date', '2001-01-23T00:00:00Z'), 'Jan 23, 2001');
  assert.equal(show('date', '2019-06-01T00:00:00.000Z'), 'Jun 1, 2019');
  assert.equal(show('date', '2026-11-09T03:30:00Z'), 'Nov 8, 2026');
  // A date typed into a text field reads as a date
  assert.equal(kindOf({ name: 'Roof Date', type: 'text' }, ['2001-01-23', '2010-04-01']), 'date');
});

test('Round 2: measurements with few homes stay a strip; counts that repeat become rows', () => {
  const few = homeInsights([{ id: 'e', name: 'Elevation (ft)', type: 'number' }], [987, 1040, 1102, 1150, 1200].map((e, i) => person(`p${i}`, `P${i}`, { e })));
  assert.equal(few.strips.length, 1, 'five homes, five different values: a strip');
  const stories = homeInsights([{ id: 's', name: 'Stories', type: 'number' }], [1, 1, 2, 1, 2, 1].map((s2, i) => person(`p${i}`, `P${i}`, { s: s2 })));
  assert.equal(stories.groups.length, 1, 'six homes, two values: rows');
});

test('Round 2: a tiny spread keeps a sensible scale; piles say how many', () => {
  const tight = homeInsights([{ id: 'z', name: 'Zestimate', type: 'number' }], [200000, 201000, 202500, 204000].map((z, i) => person(`p${i}`, `P${i}`, { z }))).strips[0];
  assert.ok(tight.high - tight.low >= 20000, `a $4K spread sits on a scale at least 10% of the median wide (${tight.high - tight.low})`);
  const placed = placeDots(tight.points, { width: 600, min: tight.min, max: tight.max, low: tight.low, high: tight.high });
  const xs = placed.dots.map(d => d.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 300, 'so the dots don’t fill the strip edge to edge');
  const sameYear = homeInsights([{ id: 'd', name: 'Latest Sale Date', type: 'date' }], ['2019-02-01', '2019-06-01', '2019-11-01'].map((d, i) => person(`p${i}`, `P${i}`, { d }))).strips[0];
  assert.ok(sameYear.high - sameYear.low >= 365 * 864e5);
  const pile = Array.from({ length: 30 }, (_, i) => ({ v: 1990, p: { id: i } }));
  const piled = placeDots(pile, { width: 400, min: 1980, max: 2000, low: 1980, high: 2000 });
  assert.equal(piled.piles.length, 1);
  assert.equal(piled.piles[0].list.length, 23, '7 lanes show, 23 more are in the pile');
});

test('Real data: Zillow’s unknowns in Bed Bath are not given; answers that differ by the field’s own words join', () => {
  // As DataX wrote them on SOARD's homes (Nov 9 2026)
  const bb = ['undefined bed, 0 bath', 'undefined bed, 0 bath', '0 bed, 2.5 bath', '4 bed, 0 bath', '3 bed, 2 bath'].map((b, i) => person(`p${i}`, `P${i}`, { b }));
  const sum = homeInsights([{ id: 'b', name: 'Bed Bath', type: 'text' }], bb);
  const beds = sum.groups.find(g => g.name === 'Bedrooms');
  const baths = sum.groups.find(g => g.name === 'Bathrooms');
  assert.deepEqual(beds.rows.map(r => [r.label, r.n]), [['3 bedrooms', 1], ['4 bedrooms', 1], ['No bedrooms given', 3]], 'no studio and no “0 baths” from a zero');
  assert.deepEqual(baths.rows.map(r => [r.label, r.n]), [['2 baths', 1], ['2.5 baths', 1], ['No baths given', 3]]);
  const heat = homeInsights([{ id: 'w', name: 'Heat Source', type: 'text' }], ['Gas', 'Gas', 'Gas Heat', 'Electric', 'electric', 'Heat Pump', 'Oil'].map((w, i) => person(`p${i}`, `P${i}`, { w })));
  assert.deepEqual(heat.groups[0].rows.map(r => [r.label, r.n]), [['Gas', 3], ['Electric', 2], ['Heat Pump', 1], ['Oil', 1]], '“Gas Heat” is “Gas”: the field’s own words don’t make another answer');
  // The permit office is counted across homes ("Permit Number" still names one home)
  const offices = homeInsights([{ id: 'pm', name: 'Permitting Municipality', type: 'text' }, { id: 'pn', name: 'Permit Number', type: 'text' }],
    [['City of Woodstock', 'B-1'], ['Cobb County', 'B-2'], ['Cobb County', 'B-3'], ['City of Marietta', 'B-4']].map(([pm, pn], i) => person(`o${i}`, `O${i}`, { pm, pn })));
  assert.deepEqual(offices.groups.map(g => [g.name, g.rows.map(r => `${r.label} ${r.n}`).join(', ')]), [['Permitting Municipality', 'Cobb County 2, City of Marietta 1, City of Woodstock 1']]);
  const power = homeInsights([{ id: 'c', name: 'Power Company', type: 'text' }], ['Georgia Power', 'Georgia Power Company', 'Cobb EMC'].map((c, i) => person(`p${i}`, `P${i}`, { c })));
  assert.deepEqual(power.groups[0].rows.map(r => [r.label, r.n]), [['Georgia Power', 2], ['Cobb EMC', 1]]);
});

test('Round 2: “3 bed” has no baths given; typed words in Bed Bath stay as written', () => {
  const sum = homeInsights([{ id: 'b', name: 'Bed Bath', type: 'text' }], [person('a', 'A', { b: '3 beds' }), person('b', 'B', { b: '3 bed, 2 bath' }), person('c', 'C', { b: '2 bed, 1 bath' }), person('d', 'D', { b: 'Mobile home' })]);
  const baths = sum.groups.find(g => g.name === 'Bathrooms');
  assert.deepEqual(baths.rows.map(r => [r.label, r.n]), [['1 bath', 1], ['2 baths', 1], ['No baths given', 1], ['Written another way', 1]]);
});

// ─── Reading JobTread ───────────────────────────────────────────────

function fakeJob({ job, fields = DEFS, status = 200, calls = [] } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.query);
    if (status !== 200) return new Response('nope', { status });
    const out = {};
    if (body.query.job) out.job = job;
    if (body.query.organization) out.organization = { customFields: { nodes: fields } };
    return Response.json(out);
  };
}
const JOB = {
  id: '22PKGcC6dRFv', name: 'Lizzie Francis (2026)', organization: { id: ORG },
  location: {
    id: '22PKGcC6dRFu', name: '1314 Timuquana Trail', street: '1314 Timuquana Trail', address: '1314 Timuquana Trail', formattedAddress: '1314 Timuquana Trail, Woodstock, GA 30188, USA',
    city: 'Woodstock', state: 'GA', postalCode: '30188',
    customFieldValues: { nodes: Object.entries(LIZZIE).map(([id, value]) => ({ value, customField: { id } })) },
  },
};

beforeEach(() => forgetLocationFields());

test('a job’s home: its address, a link to it in JobTread, its values by field, and the fields, in one request', async () => {
  const calls = [];
  const r = await jobHome({ JOBTREAD_GRANT_KEY: 'k' }, JOB.id, { fetchImpl: fakeJob({ job: JOB, calls }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].job.location.customFieldValues.$.size, HOME_VALUES);
  assert.ok(HOME_VALUES <= 100, 'JobTread allows up to 100');
  assert.deepEqual(r.job, { id: JOB.id, name: 'Lizzie Francis (2026)' });
  assert.equal(r.home.street, '1314 Timuquana Trail');
  assert.equal(r.home.city, 'Woodstock');
  assert.equal(r.home.url, jobtreadLocationUrl('22PKGcC6dRFu'));
  assert.equal(r.home.url, 'https://app.jobtread.com/locations/22PKGcC6dRFu');
  assert.equal(r.home.values.fZest, 336500);
  assert.equal(r.fields.length, DEFS.length);
  // The fields are remembered for ten minutes, so the next home is one smaller request
  const again = [];
  await jobHome({ JOBTREAD_GRANT_KEY: 'k' }, JOB.id, { fetchImpl: fakeJob({ job: JOB, calls: again }) });
  assert.equal(again.length, 1);
  assert.equal(again[0].organization, undefined);
});

test('a job’s home: no home, no job, another company’s job, a bad id, no key, JobTread down', async () => {
  const env = { JOBTREAD_GRANT_KEY: 'k' };
  const none = await jobHome(env, JOB.id, { fetchImpl: fakeJob({ job: { ...JOB, location: null } }) });
  assert.equal(none.home, null);
  await assert.rejects(jobHome(env, JOB.id, { fetchImpl: fakeJob({ job: null }) }), (e) => e.status === 404);
  await assert.rejects(jobHome(env, JOB.id, { fetchImpl: fakeJob({ job: { ...JOB, organization: { id: 'someoneElse' } } }) }), (e) => e.status === 404);
  await assert.rejects(jobHome(env, 'bad id!', { fetchImpl: fakeJob({ job: JOB }) }), (e) => e.status === 400);
  await assert.rejects(jobHome({}, JOB.id, { fetchImpl: fakeJob({ job: JOB }) }), (e) => e.status === 503);
  await assert.rejects(jobHome(env, JOB.id, { fetchImpl: fakeJob({ status: 500 }) }), (e) => e.status === 500 && e.message === 'JobTread didn’t answer', 'in plain words; the detail goes to the logs');
});

test('/api/job-home answers in JSON, never a 502', async () => {
  const get = (q, env = { JOBTREAD_GRANT_KEY: 'k' }) => jobHomeGet({ env, request: new Request(`https://x/api/job-home?${q}`) });
  const bad = await get('job=../../x');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).success, false);
  const noKey = await get(`job=${JOB.id}`, {});
  assert.equal(noKey.status, 503);
  assert.match((await noKey.json()).error, /JobTread isn’t connected/);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeJob({ status: 500 });
  try {
    const down = await get(`job=${JOB.id}`);
    assert.equal(down.status, 500);
    assert.equal(down.headers.get('Cache-Control'), 'no-store');
  } finally { globalThis.fetch = realFetch; }
});

test('the fields and a home’s values, tidied', async () => {
  assert.deepEqual(cleanFields([{ id: 'a', name: 'A', type: 'number', position: 'a0' }, { id: '', name: 'x' }, { id: 'b' }]), [{ id: 'a', name: 'A', type: 'number', position: 'a0' }]);
  assert.deepEqual(valuesOf({ customFieldValues: { nodes: [{ value: 'Sewer', customField: { id: 's' } }, { value: 'Septic', customField: { id: 's' } }, { value: '', customField: { id: 'e' } }, { value: 3 }] } }), { s: ['Sewer', 'Septic'] });
  const calls = [];
  const fields = await locationFields({ JOBTREAD_GRANT_KEY: 'k' }, { fetchImpl: fakeJob({ calls }) });
  assert.equal(fields.length, DEFS.length);
  assert.deepEqual(calls[0].organization.customFields.$.where, ['targetType', '=', 'location']);
});

// ─── The mirror and Insights ────────────────────────────────────────

let w;
let env;
beforeEach(async () => {
  w = fakeApplicantWorld();
  w.world.customFields = DEFS.map(d => ({ ...d, targetType: 'location' }));
  env = { ...w.env, DB: await createD1() };
});

function addFamily(name, home, { status = 'Applied', year = '2027', types = null } = {}) {
  const id = `acct${String(Object.keys(w.world.accounts).length + 1).padStart(8, '0')}`;
  w.world.accounts[id] = {
    id, name, type: 'customer', org: ORG, createdAt: '2026-11-07T12:00:00.000Z',
    fields: { ...(status ? { [FIELDS.status.id]: status } : {}), [FIELDS.year.id]: year, ...(types ? { [FIELDS.types.id]: types } : {}) }, contacts: [], primaryContactId: null, files: [], comments: [], jobs: [],
    locations: home ? [{ id: `${id}-l1`, address: '1 Main St', city: 'Marietta', county: null, latitude: 33.97, longitude: -84.53, customFieldValues: home }] : [],
  };
  return id;
}

test('the mirror keeps each home’s fields and JobTread’s list of them; a change in JobTread comes through', async () => {
  const lizzie = addFamily('Lizzie Francis', { ...LIZZIE, '22PK2MzzJD93': 'Cherokee' });
  const noHome = addFamily('No Home Yet', null);
  await syncAllApplicants(env, { fetchImpl: w.fetchImpl });
  const row = await env.DB.prepare('SELECT home, county FROM applicants WHERE account_id = ?').bind(lizzie).first();
  assert.equal(JSON.parse(row.home).fZest, 336500);
  assert.equal(row.county, 'Cherokee', 'the home’s County field is read when JobTread’s own county is empty');
  assert.equal((await env.DB.prepare('SELECT home FROM applicants WHERE account_id = ?').bind(noHome).first()).home, null);
  const listed = await homeFieldList(env.DB);
  assert.deepEqual(listed.map(f => f.name), DEFS.map(d => d.name));
  // DataX writes a new Zestimate: the next read of that account has it
  w.world.accounts[lizzie].locations[0].customFieldValues.fZest = 341000;
  await refreshApplicants(env, [lizzie], { fetchImpl: w.fetchImpl });
  assert.equal(JSON.parse((await env.DB.prepare('SELECT home FROM applicants WHERE account_id = ?').bind(lizzie).first()).home).fZest, 341000);
});

test('a failed read of the fields keeps the last good list and never stops the sync', async () => {
  addFamily('Lizzie Francis', LIZZIE);
  await syncAllApplicants(env, { fetchImpl: w.fetchImpl });
  forgetLocationFields();
  const failing = async (url, init) => (JSON.parse(init.body).query.organization?.customFields ? new Response('down', { status: 500 }) : w.fetchImpl(url, init));
  const out = await syncAllApplicants(env, { fetchImpl: failing });
  assert.equal(out.applicants, 1);
  assert.equal((await homeFieldList(env.DB)).length, DEFS.length);
});

test('insights: every family on the Applicants board with its home, every season, by decision; archived, tests and the other kind left out', async () => {
  const { DB } = env;
  await ensureApplicationsSchema(DB);
  const approved = addFamily('Lizzie Francis', LIZZIE, { status: 'Approved', year: '2026' });
  addFamily('Avery Stone', { fZest: 285000 }, { status: 'Denied', year: '2025' });
  addFamily('Remi Lane', { fZest: 540000 }, { status: 'In Review', year: '2027' });
  addFamily('Nico Lane', { fZest: 160000 }, { status: null, year: '2025' });
  const bare = addFamily('Bare Home', {}, { status: 'Applied', year: '2027' });
  addFamily('No Home Yet', null, { status: 'Applied', year: '2027' });
  addFamily('TEST Family', { fZest: 999999 });
  const school = addFamily('Sunnyside Academy', { fZest: 2000000 }, { status: 'Approved', types: ['Community Project'] });
  const gone = addFamily('Archived Family', { fZest: 777000 }, { status: 'Denied' });
  await syncAllApplicants(env, { fetchImpl: w.fetchImpl });
  await DB.prepare("UPDATE applicants SET archived_at = '2026-01-01' WHERE account_id = ?").bind(gone).run();
  const ins = await insights(DB, { year: '2027', now: Date.parse('2026-11-09T12:00:00Z') });
  const names = ins.homes.families.map(f => f.name).sort();
  assert.deepEqual(names, ['Avery Stone', 'Bare Home', 'Lizzie Francis', 'Nico Lane', 'Remi Lane'], 'every season, not just this one; no test, archived or community project');
  assert.deepEqual(ins.homes.noHome.map(f => f.name), ['No Home Yet']);
  const lizzie = ins.homes.families.find(f => f.id === approved);
  assert.deepEqual([lizzie.status, lizzie.year, lizzie.accountId, lizzie.home.fZest], ['Approved', '2026', approved, 336500]);
  assert.deepEqual(ins.homes.families.find(f => f.id === bare).home, {}, 'in JobTread with a home, nothing filled in yet');
  assert.equal(ins.homes.fields.length, DEFS.length);
  const org = await insights(DB, { year: '2027', kind: 'organization', now: Date.parse('2026-11-09T12:00:00Z') });
  assert.deepEqual(org.homes.families.map(f => f.id), [school], 'Community projects see their own');
  // Compared by decision
  const zest = homeInsights(ins.homes.fields, ins.homes.families).strips.find(st => st.name === 'Zestimate');
  const by = Object.fromEntries(byDecision(zest).map(x => [x.key, x]));
  assert.deepEqual(Object.keys(by), ['approved', 'denied', 'deciding', 'none', 'all']);
  assert.deepEqual([by.approved.median, by.denied.median, by.deciding.median, by.none.median], [336500, 285000, 540000, 160000]);
  assert.equal(by.all.median, (285000 + 336500) / 2);
  assert.equal(by.all.mean, (336500 + 285000 + 540000 + 160000) / 4);
});

test('decisions: JobTread’s Status as Insights groups it', () => {
  assert.deepEqual(['Approved', 'Denied', 'Applied', 'In Review', '', null, 'approved'].map(decisionOf), ['approved', 'denied', 'deciding', 'deciding', 'none', 'none', 'approved']);
  assert.deepEqual(decisionCounts([{ status: 'Approved' }, { status: 'Applied' }, { status: 'In Review' }, {}]), { approved: 1, deciding: 2, none: 1 });
  const strip = { points: [{ v: 10, p: { status: 'Approved' } }, { v: 30, p: { status: 'Approved' } }, { v: 20, p: { status: 'Denied' } }] };
  const by = byDecision(strip);
  assert.deepEqual(by.map(x => [x.key, x.median, x.mean, x.points.length]), [['approved', 20, 20, 2], ['denied', 20, 20, 1], ['all', 20, 20, 3]], 'a decision with no homes has no column');
});

test('insights with no families in JobTread sends an empty list', async () => {
  await ensureApplicationsSchema(env.DB);
  const ins = await insights(env.DB, { year: '2027' });
  assert.deepEqual(ins.homes.families, []);
  assert.deepEqual(ins.homes.noHome, []);
});
