/**
 * The insurance audits: subcontractors paid in a policy term (workers' comp from April 11, liability from
 * November 21) and the insurance that covered them (functions/api/_insurance-audit.js, insurance-audit-admin.js)
 * Run: node --test tests/
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createD1 } from './lib/d1-shim.mjs';
import { asksOn } from './lib/vendor-asks.mjs';
import { ensureSpendSchema } from '../functions/api/_spend.js';
import { ensureVendorSchema, saveDocSettings } from '../functions/api/_vendors.js';
import { forgetRampToken } from '../functions/api/_ramp.js';
import {
  term, termOf, termsShown, monthsText, isSubcontractor, codedAs, coverageFor, coverageOn, combinePayments, auditFrom, buildRun, auditFor, readRun, runIsStale,
  askForGaps, askEmail, auditCsv, auditPacket, saveCall, maybeRunInsuranceAudit, rampPaymentOf, mercuryPaymentOf, jtBillOf, jtPaymentOf, ensureAuditSchema,
} from '../functions/api/_insurance-audit.js';
import { onRequestGet, onRequestPost } from '../functions/api/insurance-audit-admin.js';

const NOW = Date.parse('2026-10-30T15:00:00Z');
const DAY = 86400e3;
const T = term(2026);
const G = term('gl-2025');

// ─── Terms and words ────────────────────────────────────────────────

test('workers’ comp runs April 11 to April 11, liability November 21 to November 21; each one’s current term and the two before are shown', () => {
  assert.deepEqual([T.id, T.policy, T.start, T.end], ['wc-2026', 'wc', '2026-04-11', '2027-04-11']);
  assert.equal(T.label, 'April 11, 2026 to April 11, 2027');
  assert.equal(termOf('2026-10-30').id, 'wc-2026');
  assert.equal(termOf('2026-04-10').id, 'wc-2025');
  assert.equal(termOf('2026-04-11').id, 'wc-2026');
  assert.deepEqual([G.id, G.policy, G.start, G.end, G.name], ['gl-2025', 'gl', '2025-11-21', '2026-11-21', 'general liability']);
  assert.equal(G.label, 'November 21, 2025 to November 21, 2026');
  assert.equal(G.short, 'Nov 2025 to Nov 2026');
  assert.equal(termOf('2026-10-30', 'gl').id, 'gl-2025');
  assert.equal(termOf('2026-11-20', 'gl').id, 'gl-2025', 'the day before it renews');
  assert.equal(termOf('2026-11-21', 'gl').id, 'gl-2026', 'the day it renews');
  assert.equal(termOf('2026-01-05', 'gl').id, 'gl-2025', 'January belongs to the term that began the November before');
  assert.equal(term('2026').id, 'wc-2026', 'a bare year is workers’ comp');
  assert.equal(term('../2026'), null);
  assert.deepEqual(termsShown(NOW).map((t) => t.id), ['wc-2026', 'wc-2025', 'wc-2024', 'gl-2025', 'gl-2024', 'gl-2023']);
  assert.deepEqual(termsShown(NOW, 'gl').map((t) => t.id), ['gl-2025', 'gl-2024', 'gl-2023']);
  assert.equal(monthsText(['2026-03']), 'March 2026');
  assert.equal(monthsText(['2026-04', '2026-03']), 'March and April 2026');
  assert.equal(monthsText(['2025-12', '2026-01']), 'December 2025 and January 2026');
});

test('subcontractor or supplier: each answer says why', () => {
  assert.deepEqual(isSubcontractor({ name: 'Sample Cabinets', call: { reason: 'off-site', by: 'holly@example.org' } }), { sub: false, why: 'Works off site (holly)', sure: true });
  assert.equal(isSubcontractor({ name: 'X', call: { reason: 'sub' }, materials: true }).sub, true, 'a person’s call wins');
  assert.equal(isSubcontractor({ name: 'X', docs: 'Not needed' }).why, 'Marked “Not needed” in JobTread');
  assert.equal(isSubcontractor({ name: 'X', docs: 'W-9 only' }).sub, false);
  assert.equal(isSubcontractor({ name: 'X', materials: true }).sub, false);
  assert.deepEqual(isSubcontractor({ name: 'X', trades: ['Plumbing', 'Tile'] }), { sub: true, why: 'Does plumbing, tile (JobTread’s Trades)', sure: true });
  assert.equal(isSubcontractor({ name: 'X', trades: ['Materials and supplies'] }).sub, false);
  assert.deepEqual(isSubcontractor({ name: 'X', costTypes: ['Materials', 'Subcontractor'] }), { sub: true, why: 'Billed as “Subcontractor”', sure: true });
  assert.equal(isSubcontractor({ name: 'X', categories: ['Contract Labor'] }).sub, true);
  assert.equal(isSubcontractor({ name: 'Example Builders', hasCertificate: true }).why, 'SOARD has their certificate of insurance');
  assert.deepEqual(isSubcontractor({ name: 'The Home Depot' }), { sub: false, why: 'A store or supplier, by its name', sure: false });
  assert.equal(isSubcontractor({ name: 'Example Lumber Yard' }).sub, false);
  assert.equal(isSubcontractor({ name: 'Mystery Co', paidBy: ['card'] }).why, 'Paid by card only, like a store');
  assert.equal(isSubcontractor({ name: 'Mystery Co', costTypes: ['Materials'] }).sub, false);
  assert.deepEqual(isSubcontractor({ name: 'Sample Imports LLC', paidBy: ['ach'] }), { sub: true, why: 'Paid by bill, and nothing marks them as a supplier', sure: false });
});

test('how a payee was coded in Ramp: overhead is never subcontracted work, job costs leave it to the rest', () => {
  const pay = (cents, ...categories) => ({ cents, categories });
  // The store's goods, the rent, an event, marketing: left out, sure (a person coded it)
  assert.deepEqual(isSubcontractor({ name: 'Example Furniture Makers', paidBy: ['ach'], coded: codedAs([pay(500000, 'Store COGS', 'Fundraising'), pay(20000, 'Store COGS')]) }),
    { sub: false, why: 'Billed to Store COGS (Ramp)', sure: true });
  assert.equal(isSubcontractor({ name: 'Sample Landlord LLC', coded: codedAs([pay(800000, 'Building Expense:Rent Expense')]) }).why, 'Billed to Rent Expense (Ramp)', 'the account, not its parent');
  assert.equal(isSubcontractor({ name: 'Sample Club', coded: codedAs([pay(280000, 'Various Fundraising Expense', 'Fundraising')]) }).sub, false);
  // Mostly the store's, a little for a makeover: left out, as a guess
  assert.deepEqual(isSubcontractor({ name: 'Example Wholesale Beds', coded: codedAs([pay(300000, 'Store COGS'), pay(10000, 'Makeover COGS', 'Makeovers')]) }),
    { sub: false, why: 'Mostly billed to Store COGS (Ramp)', sure: false });
  // Makeover costs and repairs can be labor: the rest decides
  assert.equal(isSubcontractor({ name: 'Sample Electric', paidBy: ['ach'], coded: codedAs([pay(270000, 'Makeover COGS', 'Makeovers', 'Sample Kid')]) }).sub, true);
  assert.equal(isSubcontractor({ name: 'Sample Air', paidBy: ['check'], coded: codedAs([pay(38000, 'Building Expense:Repairs and Maintenance Expense', 'Fundraising')]) }).sub, true);
  // The class (Fundraising, Makeovers) alone says nothing
  assert.deepEqual(codedAs([pay(1000, 'Fundraising'), pay(2000, 'Makeovers')]), { overheadCents: 0, jobCents: 0, overhead: [] });
});

test('shops, services and government offices by their names are left out as guesses', () => {
  for (const name of ['Etsy', 'Example Wallpaper.com', 'Sample Lighting Store', 'Example Blinds', 'Sample Sporting Goods']) assert.deepEqual(isSubcontractor({ name, paidBy: ['bill'] }), { sub: false, why: 'A store or supplier, by its name', sure: false }, name);
  for (const name of ['Bin There Dump That Sample', 'Sample Courier Service, LLC', 'Example Permitting', 'Sample I.T. Solutions, LLC', 'Example Media LLC', 'Sample Bagels']) assert.deepEqual(isSubcontractor({ name, paidBy: ['bill'] }), { sub: false, why: 'A service, not construction work, by its name', sure: false }, name);
  for (const name of ['Alpharetta, GA', 'City of Roswell', 'Sample County']) assert.equal(isSubcontractor({ name, paidBy: ['bill'] }).sub, name === 'Sample County', name);
  assert.equal(isSubcontractor({ name: 'Alpharetta, GA' }).why, 'A government office, by its name');
  // A trade on file beats any name
  assert.equal(isSubcontractor({ name: 'Example Lighting & Electric', trades: ['Electrical'] }).sub, true);
});

test('a Ramp bill with no JobTread copy still belongs to the JobTread vendor of that name, so the payee is one row', () => {
  const out = combinePayments({ term: term('wc-2026'), rampBills: [{ id: 'R1', vendor: 'Sample Electric LLC', cents: 50000, invoice: '9', date: '2026-05-02', method: 'ach', categories: [] }], vendors: [{ jtId: 'V7', name: 'Sample Electric' }, { jtId: 'V8', name: 'Other Example Co' }], rampOk: true });
  assert.equal(out[0].jtId, 'V7');
  // A near-twin in JobTread: the very name decides
  const twins = combinePayments({ term: term('wc-2026'), rampBills: [{ id: 'R2', vendor: 'Sample Electric', cents: 50000, invoice: '10', date: '2026-05-02', method: 'ach', categories: [] }], vendors: [{ jtId: 'V6', name: 'Sample' }, { jtId: 'V7', name: 'Sample Electric' }], rampOk: true });
  assert.equal(twins[0].jtId, 'V7');
});

test('one person with no employees is left out of workers’ comp only: liability still counts them', () => {
  const solo = { name: 'Solo Painter', trades: ['Painting'], call: { reason: 'no-employees', by: 'holly@example.org' } };
  assert.deepEqual(isSubcontractor(solo, 'wc'), { sub: false, why: 'One person, no employees (holly)', sure: true });
  assert.deepEqual(isSubcontractor(solo), isSubcontractor(solo, 'wc'), 'workers’ comp unless said');
  assert.deepEqual(isSubcontractor(solo, 'gl'), { sub: true, why: 'Does painting (JobTread’s Trades) · one person, no employees, still counted for general liability', sure: true });
  assert.equal(isSubcontractor({ ...solo, trades: [], materials: true }, 'gl').sub, false, 'the rest still decides: materials only');
  assert.equal(isSubcontractor({ name: 'X', call: { reason: 'off-site' } }, 'gl').sub, false, 'off site leaves them out of both');
  assert.equal(isSubcontractor({ name: 'X', call: { reason: 'materials' } }, 'gl').sub, false);
  assert.equal(isSubcontractor({ name: 'X', call: { reason: 'sub' }, materials: true }, 'gl').sub, true);
});

test('coverage on a day: a certificate’s dates, JobTread’s end date (a year assumed), an exemption for workers’ comp only', () => {
  const rows = [
    { jt_id: 'V1', insured: 'Sample Tile LLC', kind: 'gl', effective: '2025-06-01', expires: '2026-06-01', insurer: 'Example Mutual', policy_no: 'GL-1', source: 'gmail', file_hash: 'h1', jt_file_id: 'F1' },
    { jt_id: null, insured: 'Sample Tile, LLC', kind: 'wc', effective: '2026-02-01', expires: '2027-02-01', insurer: 'Example Comp', source: 'gmail', file_hash: 'h2' },
    { jt_id: 'V9', insured: 'Someone Else', kind: 'wc', effective: '2026-01-01', expires: '2027-01-01', source: 'gmail', file_hash: 'h3' },
  ];
  const certs = coverageFor({ jtId: 'V1', name: 'Sample Tile', fields: { gl: '2027-06-01', wc: '2027-02-01' } }, rows);
  assert.equal(certs.length, 3, 'its own, one by name, and JobTread’s GL end date (its WC date is the certificate’s)');
  assert.deepEqual(coverageOn(certs, '2026-03-15', 'wc'), { ok: true, exempt: false, assumed: false, insurer: 'Example Comp', policyNo: null, effective: '2026-02-01', expires: '2027-02-01', source: 'gmail', jtFileId: null });
  assert.equal(coverageOn(certs, '2026-01-15', 'wc').ok, false, 'before the policy began');
  assert.equal(coverageOn(certs, '2026-03-15', 'gl').insurer, 'Example Mutual', 'a certificate beats an assumed date');
  const later = coverageOn(certs, '2026-09-01', 'gl');
  assert.equal(later.ok && later.assumed && later.source, 'jobtread', 'JobTread’s end date covers the year before it, said so');
  const ex = [{ kind: 'exemption', exempt: 1, insured: 'Solo Painter', source: 'gmail', file_hash: 'h4' }];
  assert.equal(coverageOn(coverageFor({ name: 'Solo Painter' }, ex), '2026-05-01', 'wc').exempt, true);
  assert.equal(coverageOn(coverageFor({ name: 'Solo Painter' }, ex), '2026-05-01', 'gl').ok, false);
});

// ─── Payments, once each ────────────────────────────────────────────

const vendors = [
  { jtId: 'V1', name: 'Sample Tile', email: 'office@tile.example', emails: ['office@tile.example'], fields: { trades: ['Tile'], gl: null, wc: null } },
  { jtId: 'V2', name: 'Example Framing Co', email: null, emails: [], fields: { trades: [] } },
  { jtId: 'V3', name: 'Example Supply', email: 'sales@supply.example', emails: [], fields: { materials: true } },
];
const bill = (id, accountId, vendor, cents, paidCents, date, o = {}) => ({ id, accountId, vendor, number: id.slice(1), date, cents, paidCents, status: 'approved', costTypes: [], codes: [], ...o });

test('every payment counted once: JobTread’s, Ramp’s copy of a bill, Mercury’s recorded or same-amount payments', () => {
  const jtBills = [
    bill('B1', 'V1', 'Sample Tile', 120000, 120000, '2026-05-01', { costTypes: ['Subcontractor'] }),
    bill('B2', 'V2', 'Example Framing Co', 300000, 300000, '2026-06-01'),
    bill('B3', 'V3', 'Example Supply', 50000, 50000, '2026-07-01'),
    bill('B4', 'V2', 'Example Framing Co', 80000, 80000, '2026-03-01'),     // paid before the term
    bill('B5', 'V1', 'Sample Tile', 40000, 40000, '2026-08-01'),
  ];
  const jtPayments = [{ id: 'P1', date: '2026-05-10', cents: 120000, accountId: 'V1', accountName: 'Sample Tile', accountType: 'vendor', bills: [{ billId: 'B1', cents: 120000 }] }];
  const rampBills = [
    { id: 'R1', vendor: 'Sample Tile LLC', cents: 120000, invoice: '1', date: '2026-05-11', method: 'ach', categories: [] },               // B1 again: JobTread has its payment
    { id: 'R2', vendor: 'Example Framing Co.', cents: 300000, invoice: '2', date: '2026-06-05', method: 'check', categories: ['Contract Labor'] }, // B2, paid by Ramp
    { id: 'R3', vendor: 'Sample Haulers', cents: 25000, invoice: 'H-9', date: '2026-06-20', method: 'ach', categories: [] },                // not in JobTread
    { id: 'R4', vendor: 'Sample Haulers', cents: 25000, invoice: 'H-1', date: '2026-04-01', method: 'ach', categories: [] },                // before the term
  ];
  const mercury = [
    { id: 'T1', payee: 'Example Supply', cents: 50000, date: '2026-07-02', method: 'ach' },        // recorded on B3 by bill pay
    { id: 'T2', payee: 'Sample Haulers', cents: 25000, date: '2026-06-24', method: 'ach' },        // Ramp's R3 again, 4 days on
    { id: 'T3', payee: 'Ramp Business Corporation', cents: 900000, date: '2026-06-30', method: 'ach' },
    { id: 'T4', payee: 'Example Framing Co', cents: 60000, date: '2026-09-15', method: 'check' },  // a payment of its own
  ].map((t) => t);
  const out = combinePayments({ term: T, jtBills, jtPayments, rampBills, mercury, txnBills: new Map([['T1', 'B3']]), vendors });
  const keys = out.map((p) => p.key);
  assert.deepEqual(keys, ['jt:P1:B1', 'bill:B2', 'ramp:R3', 'bill:B3', 'bill:B5', 'mercury:T4']);
  const b2 = out.find((p) => p.key === 'bill:B2');
  assert.equal(b2.date, '2026-06-05', 'Ramp’s payment date, not the bill’s');
  assert.deepEqual([b2.jtId, b2.method, b2.categories], ['V2', 'check', ['Contract Labor']]);
  assert.equal(out.find((p) => p.key === 'bill:B3').source, 'mercury', 'bill pay’s payment of B3 is B3');
  assert.equal(out.find((p) => p.key === 'bill:B5').dateFrom, 'bill', 'marked paid in JobTread with no payment: dated by the bill');
  assert.equal(out.find((p) => p.key === 'mercury:T4').jtId, 'V2', 'a payee found by name');
});

test('a bill Ramp wrote and its bill pay never paid is a card buy, said only when Ramp answered', () => {
  const jtBills = [
    bill('B1', 'V2', 'Example Framing Co', 300000, 300000, '2026-06-01', { number: '7' }),     // Ramp's bill pay paid it
    bill('B2', 'V8', 'Example Toy Shop', 4500, 4500, '2026-06-02'),                          // a Ramp card receipt
  ];
  const rampBills = [{ id: 'R1', vendor: 'Example Framing Co', cents: 300000, invoice: '7', date: '2026-06-05', method: 'ach', categories: [] }];
  const jtPayments = [{ id: 'P1', date: '2026-06-05', cents: 300000, accountId: 'V2', accountName: 'Example Framing Co', accountType: 'vendor', bills: [{ billId: 'B1', cents: 300000 }] }];
  const rampWrote = new Set(['B1', 'B2']);
  const out = combinePayments({ term: T, jtBills, jtPayments, rampBills, vendors, rampWrote, rampOk: true });
  assert.deepEqual(out.map((p) => [p.key, p.method]), [['bill:B2', 'card'], ['jt:P1:B1', 'ach']], 'JobTread’s payment of B1 is known as Ramp’s ACH');
  assert.equal(isSubcontractor({ name: 'Example Toy Shop', paidBy: ['card'] }).sub, false);
  const blind = combinePayments({ term: T, jtBills, jtPayments, rampBills: [], vendors, rampWrote, rampOk: false });
  assert.deepEqual(blind.map((p) => p.method), ['bill', 'bill'], 'Ramp unread: nothing is called a card buy, so no sub is hidden');
});

test('the shapes read from JobTread, Ramp and Mercury', () => {
  assert.deepEqual(jtBillOf({ id: 'B1', account: { id: 'V1', name: 'Sample Tile' }, number: '7', issueDate: '2026-05-01', cost: 1200, amountPaid: 1200, status: 'approved', costItems: { nodes: [{ costType: { name: 'Subcontractor' }, costCode: { name: '19 TILE' } }] } }),
    { id: 'B1', accountId: 'V1', vendor: 'Sample Tile', number: '7', date: '2026-05-01', cents: 120000, paidCents: 120000, status: 'approved', costTypes: ['Subcontractor'], codes: ['19 TILE'] });
  assert.deepEqual(jtPaymentOf({ id: 'P1', amount: -1200, paidAt: '2026-05-10T16:00:00Z', account: { id: 'V1', name: 'Sample Tile', type: 'vendor' }, documentPayments: { nodes: [{ amount: 1200, document: { id: 'B1', type: 'vendorBill' } }, { amount: 5, document: { id: 'I1', type: 'customerInvoice' } }] } }).bills, [{ billId: 'B1', cents: 120000 }]);
  const r = rampPaymentOf({ id: 'R1', vendor: { name: 'Sample Tile' }, amount: { amount: 120000, minor_unit_conversion_rate: 100 }, invoice_number: 'INV-1', paid_at: '2026-05-11T03:00:00Z', payment: { payment_method: 'CHECK' }, line_items: [{ accounting_field_selections: [{ name: 'Subcontractors' }] }] });
  assert.deepEqual(r, { id: 'R1', vendor: 'Sample Tile', cents: 120000, invoice: 'INV-1', date: '2026-05-10', method: 'check', categories: ['Subcontractors'] }, 'a payment late at night is that day in Atlanta');
  assert.equal(mercuryPaymentOf({ id: 'T', kind: 'outgoingPayment', cents: -5000, status: 'sent', counterparty: 'Sample Tile', posted_at: '2026-05-12T14:00:00Z' }).cents, 5000);
  assert.equal(mercuryPaymentOf({ id: 'T', kind: 'outgoingPayment', cents: -5000, status: 'failed' }), null);
  assert.equal(mercuryPaymentOf({ id: 'T', kind: 'debitCardTransaction', cents: -5000, status: 'sent' }), null);
});

test('the audit: who counts, what was paid without workers’ comp, and the headline', () => {
  const payments = [
    { key: 'a', source: 'jobtread', jtId: 'V1', payee: 'Sample Tile', cents: 100000, date: '2026-05-10', method: 'bill' },
    { key: 'b', source: 'ramp', jtId: 'V1', payee: 'Sample Tile', cents: 50000, date: '2026-09-10', method: 'ach' },
    { key: 'c', source: 'ramp', jtId: 'V2', payee: 'Example Framing Co', cents: 300000, date: '2026-06-05', method: 'check' },
    { key: 'd', source: 'mercury', jtId: 'V3', payee: 'Example Supply', cents: 50000, date: '2026-07-02', method: 'ach' },
    { key: 'e', source: 'ramp', jtId: null, payee: 'Sample Haulers', cents: 25000, date: '2026-06-20', method: 'ach' },
  ];
  const coverage = [
    { jt_id: 'V1', insured: 'Sample Tile', kind: 'wc', effective: '2026-06-01', expires: '2027-06-01', insurer: 'Example Comp', source: 'gmail', file_hash: 'h1', jt_file_id: 'F1' },
    { jt_id: 'V1', insured: 'Sample Tile', kind: 'gl', effective: '2026-01-01', expires: '2027-01-01', insurer: 'Example Mutual', source: 'gmail', file_hash: 'h1', jt_file_id: 'F1' },
  ];
  const a = auditFrom({ term: T, payments, vendors, coverage, calls: new Map([['name:sample haulers', { reason: 'off-site', by: 'holly@example.org' }]]), today: '2026-10-30' });
  assert.deepEqual(a.rows.map((r) => [r.name, r.sub]), [['Example Framing Co', true], ['Sample Tile', true], ['Example Supply', false], ['Sample Haulers', false]], 'subs first, the biggest gap first');
  const tile = a.rows.find((r) => r.name === 'Sample Tile');
  assert.deepEqual([tile.wc.cents, tile.wc.months, tile.gl.cents], [100000, ['2026-05'], 0], 'May’s payment came before their workers’ comp began');
  assert.equal(tile.files.length, 1, 'one certificate file, both kinds on it');
  assert.equal(a.rows.find((r) => r.name === 'Sample Haulers').why, 'Works off site (holly)');
  assert.deepEqual(a.totals, {
    subs: 2, paidToSubs: 450000, uninsuredCents: 400000, uninsuredSubs: 2, insuredCents: 50000, insuredSubs: 1,
    leftOut: 2, leftOutCents: 75000, notInJobTread: 1, asked: 0, payments: 5,
  });
  assert.equal(a.policy.id, 'wc');
  // The same payments in the liability audit: the tile sub had their own liability all along
  const g = auditFrom({ term: G, payments, vendors, coverage, calls: new Map([['name:sample haulers', { reason: 'off-site', by: 'holly@example.org' }]]), today: '2026-10-30' });
  assert.deepEqual([g.policy.id, g.totals.uninsuredCents, g.totals.uninsuredSubs, g.totals.insuredCents], ['gl', 300000, 1, 150000]);
  assert.deepEqual(g.rows.filter((r) => r.sub).map((r) => [r.name, r.gl.cents]), [['Example Framing Co', 300000], ['Sample Tile', 0]]);
});

// ─── Read, kept, shown, asked ───────────────────────────────────────

let world;
let DB;
let env;
const realFetch = globalThis.fetch;
const certPdf = async () => { const d = await PDFDocument.create(); d.addPage([612, 792]).drawText('ACORD 25'); return d.save(); };
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    world.jt.push(Object.keys(query).filter((k) => k !== '$')[0]);
    if (query.organization?.documents) return Response.json({ organization: { documents: { nextPage: null, nodes: world.jtBills } } });
    if (query.organization?.payments) return world.refusePayments ? Response.json({ errors: [{ message: 'paidAt can’t be filtered' }] }) : Response.json({ organization: { payments: { nextPage: null, nodes: world.jtPayments } } });
    if (query.file) return Response.json({ file: { id: query.file.$.id, name: 'COI Sample Tile.pdf', url: 'https://files.jobtread.example/coi.pdf' } });
    if (query.createComment) { world.comments.push(query.createComment.$); return Response.json({ createComment: { createdComment: { id: 'C1' } } }); }
    throw new Error(`JobTread doesn’t know ${Object.keys(query)}`);
  }
  if (url.host === 'files.jobtread.example') return new Response(await certPdf(), { headers: { 'content-type': 'application/pdf' } });
  if (url.host === 'api.ramp.com') {
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    world.rampQueries.push(Object.fromEntries(url.searchParams));
    return Response.json({ data: world.rampBills, page: { next: null } });
  }
  if (url.host === 'mercury-relay.sunshineonaranneyday.com') return Response.json({ transactions: world.mercury, page: {} });
  if (url.host === 'api.resend.com') { world.emails.push(...JSON.parse(init.body)); return Response.json({ data: JSON.parse(init.body).map((_, i) => ({ id: `em${i}` })) }); }
  return realFetch(input, init);
};
after(() => { globalThis.fetch = realFetch; });

beforeEach(async () => {
  forgetRampToken();
  world = {
    jt: [], comments: [], emails: [], rampQueries: [],
    jtBills: [
      { id: 'B1', account: { id: 'V1', name: 'Sample Tile' }, number: '1', issueDate: '2026-05-01', cost: 1000, amountPaid: 1000, status: 'approved', costItems: { nodes: [{ costType: { name: 'Subcontractor' } }] } },
      { id: 'B2', account: { id: 'V2', name: 'Example Framing Co' }, number: '2', issueDate: '2026-06-01', cost: 3000, amountPaid: 3000, status: 'approved', costItems: { nodes: [] } },
    ],
    jtPayments: [{ id: 'P1', amount: 1000, paidAt: '2026-05-10', account: { id: 'V1', name: 'Sample Tile', type: 'vendor' }, documentPayments: { nodes: [{ amount: 1000, document: { id: 'B1', type: 'vendorBill' } }] } }],
    rampBills: [{ id: 'R2', vendor: { name: 'Example Framing Co' }, amount: { amount: 300000, minor_unit_conversion_rate: 100 }, invoice_number: '2', paid_at: '2026-06-05T15:00:00Z', payment: { payment_method: 'ACH' }, line_items: [] }],
    mercury: [{ id: 'T9', kind: 'outgoingPayment', amount: -450, status: 'sent', counterpartyName: 'Example Framing Co', postedAt: '2026-09-15T15:00:00Z' }],
  };
  DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
  env = { DB, JOBTREAD_GRANT_KEY: 'jt', RAMP_CLIENT_ID: 'id', RAMP_CLIENT_SECRET: 'secret', MERCURY_API_TOKEN: 'secret-token:test', MERCURY_RELAY_KEY: 'relay', RESEND_API_KEY: 're_test' };
  await ensureSpendSchema(DB);
  await ensureVendorSchema(DB);
  await ensureAuditSchema(DB);
  await asksOn(DB);
  for (const v of vendors) {
    await DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`jt_${v.jtId}`, v.name, v.name.toLowerCase(), v.jtId, v.email, JSON.stringify({ emails: v.emails, fields: v.fields }), '', '').run();
  }
});

const coverageTable = async (rows, foundAt = new Date(NOW - 10 * DAY).toISOString()) => {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS coi_coverage (id TEXT PRIMARY KEY, jt_id TEXT, insured TEXT NOT NULL, kind TEXT NOT NULL, effective TEXT, expires TEXT, insurer TEXT, policy_no TEXT,
    each_cents INTEGER, aggregate_cents INTEGER, exempt INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, source_ref TEXT, file_hash TEXT NOT NULL, jt_file_id TEXT, found_at TEXT NOT NULL)`).run();
  for (const [i, r] of rows.entries()) {
    await DB.prepare('INSERT INTO coi_coverage (id, jt_id, insured, kind, effective, expires, insurer, policy_no, exempt, source, file_hash, jt_file_id, found_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`c${i}`, r.jt_id ?? null, r.insured, r.kind, r.effective ?? null, r.expires ?? null, r.insurer ?? null, r.policy_no ?? null, r.exempt ? 1 : 0, r.source || 'gmail', r.file_hash || `h${i}`, r.jt_file_id ?? null, foundAt).run();
  }
};

test('the term is read from every source, kept, and shown with the coverage found since', async () => {
  const run = await buildRun(env, T, { now: NOW });
  assert.deepEqual(Object.fromEntries(Object.entries(run.sources).map(([k, v]) => [k, v.ok && v.count])), { jobtread: 2, jobtreadPayments: 1, ramp: 1, mercury: 1 });
  assert.deepEqual(world.rampQueries[0], { payment_status: 'PAID', from_paid_at: '2026-04-10T00:00:00Z', to_paid_at: '2027-04-12T00:00:00Z', page_size: '100' });
  assert.deepEqual(run.payments.map((p) => [p.key, p.cents]), [['jt:P1:B1', 100000], ['bill:B2', 300000], ['mercury:T9', 45000]]);
  // No certificates yet: the search hasn't made its table
  let a = await auditFor(env, '2026', { now: NOW });
  assert.equal(a.totals.uninsuredCents, 445000);
  await coverageTable([{ jt_id: 'V2', insured: 'Example Framing Co', kind: 'wc', effective: '2026-01-01', expires: '2027-01-01', insurer: 'Example Comp', jt_file_id: 'F2' }]);
  a = await auditFor(env, '2026', { now: NOW });
  assert.equal(a.totals.uninsuredCents, 100000, 'the framer’s certificate covers both their payments');
  assert.equal(world.jt.length, 2, 'shown from the kept run, nothing read again');
  // A source that refuses is said, the rest still counted
  world.refusePayments = true;
  const again = await buildRun(env, T, { now: NOW });
  assert.equal(again.sources.jobtreadPayments.ok, false);
  assert.match(again.sources.jobtreadPayments.error, /paidAt/);
  assert.equal(runIsStale(again, T, Date.parse(again.builtAt) + 2 * 3600e3), false);
  assert.equal(runIsStale({ ...run, version: undefined }, T, Date.parse(run.builtAt) + 60e3), true, 'a run kept by older code is read again');
  assert.equal(runIsStale(again, T, Date.parse(again.builtAt) + 3 * 3600e3 + 60e3), true, 'a read where a source failed is tried again in 3 hours, not tomorrow');
  assert.deepEqual(again.payments.map((p) => p.key), ['bill:B1', 'bill:B2', 'mercury:T9'], 'B1 dated by its bill when its payment can’t be read');
});

test('a person’s call, the spreadsheet and the auditor’s packet', async () => {
  await coverageTable([{ jt_id: 'V2', insured: 'Example Framing Co', kind: 'wc', effective: '2026-01-01', expires: '2027-01-01', insurer: 'Example Comp', jt_file_id: 'F2' }]);
  await saveCall(DB, { key: 'jt:V1', jtId: 'V1', name: 'Sample Tile', reason: 'no-employees', by: 'holly@example.org' });
  await assert.rejects(saveCall(DB, { key: 'jt:V1', reason: 'because' }), /Pick why/);
  const a = await auditFor(env, '2026', { now: NOW });
  const tile = a.rows.find((r) => r.jtId === 'V1');
  assert.deepEqual([tile.sub, tile.why], [false, 'One person, no employees (holly)']);
  const csv = auditCsv(a);
  assert.match(csv.split('\r\n')[0], /^Payee,In JobTread,Counts for the audit,Why/);
  assert.match(csv, /Example Framing Co,Yes,Yes,.*,3450\.00,2,2026-06-05,2026-09-15,0\.00/);
  assert.match(csv, /Sample Tile,Yes,No,"One person, no employees \(holly\)"/);
  const pdf = await PDFDocument.load(await auditPacket(env, a, { now: NOW }));
  assert.equal(pdf.getPageCount(), 2, 'the summary, then the framer’s certificate');
  assert.equal(pdf.getTitle(), 'Workers’ compensation audit: subcontractors and their insurance, Apr 2026 to Apr 2027');
  // The liability audit: the same call doesn't leave the tile sub out, and the framer's workers' comp certificate isn't theirs to show
  const g = await auditFor(env, 'gl-2025', { now: NOW });
  const gTile = g.rows.find((r) => r.jtId === 'V1');
  assert.deepEqual([gTile.sub, gTile.why], [true, 'Does tile (JobTread’s Trades) · one person, no employees, still counted for general liability']);
  assert.equal(g.rows.find((r) => r.jtId === 'V2').files.length, 0, 'a workers’ comp certificate isn’t in the liability audit');
  const gCsv = auditCsv(g);
  assert.equal(gCsv.split('\r\n')[0], 'Payee,In JobTread,Counts for the audit,Why,Work,Paid in the term,Payments,First paid,Last paid,Paid without general liability,Months without general liability,General liability on file,Asked for the certificate,Each payment');
  assert.match(gCsv, /Example Framing Co,Yes,Yes,.*,3450\.00,2,2026-06-05,2026-09-15,3450\.00,June 2026; September 2026,None on file,,2026-06-05 3000\.00 no general liability; 2026-09-15 450\.00 no general liability/);
  assert.doesNotMatch(gCsv, /workers comp/);
  const gPdf = await PDFDocument.load(await auditPacket(env, g, { now: NOW }));
  assert.equal(gPdf.getTitle(), 'General liability audit: subcontractors and their insurance, Nov 2025 to Nov 2026');
  assert.equal(gPdf.getPageCount(), 1, 'the summary alone: no liability certificate on file');
  await saveCall(DB, { key: 'jt:V1', reason: 'clear' });
  assert.equal((await auditFor(env, '2026', { now: NOW })).rows.find((r) => r.jtId === 'V1').sub, true);
});

const bothAudits = async (now = NOW) => [await auditFor(env, 'wc-2026', { now }), await auditFor(env, 'gl-2025', { now })];

test('asking for the certificate that covered past work: once for both audits, to the agent first, noted in JobTread', async () => {
  await buildRun(env, T, { now: NOW });
  let a = await bothAudits();
  assert.deepEqual(await askForGaps(env, a, { now: NOW }), { asked: 0, waiting: 'the certificate search' }, 'nothing until the search has run');
  await coverageTable([{ jt_id: 'V9', insured: 'Unrelated Co', kind: 'gl', expires: '2027-01-01' }], new Date(NOW - DAY).toISOString());
  assert.equal((await askForGaps(env, a, { now: NOW })).waiting, 'the certificate search', 'and has had a few days');
  await DB.prepare('UPDATE coi_coverage SET found_at = ?').bind(new Date(NOW - 5 * DAY).toISOString()).run();
  await DB.prepare("CREATE TABLE IF NOT EXISTS vendor_profiles (jt_id TEXT PRIMARY KEY, agent TEXT)").run();
  await DB.prepare("INSERT INTO vendor_profiles (jt_id, agent) VALUES ('V1', ?)").bind(JSON.stringify({ name: 'Pat Agent', email: 'pat@agency.example' })).run();
  a = await bothAudits();
  const r = await askForGaps(env, a, { now: NOW });
  assert.equal(r.asked, 1, 'Sample Tile’s agent, once for both audits; the framer has no email on file');
  assert.equal(world.emails.length, 1);
  const m = world.emails[0];
  assert.deepEqual(m.to, ['pat@agency.example']);
  assert.equal(m.reply_to, 'info@soardcharity.com');
  assert.equal(m.subject, 'The certificate of insurance that covered Sample Tile’s work in May 2026');
  assert.match(m.text, /workers’ compensation and general liability/);
  assert.doesNotMatch(m.text + m.html, /—/);
  assert.equal(world.comments.length, 1);
  assert.match(world.comments[0].message, /their insurance agent pat@agency\.example .* Sample Tile’s work in May 2026: \$1,000\.00 was paid to them then with no workers’ compensation and general liability on file, for SOARD’s workers’ compensation audit \(policy term April 11, 2026 to April 11, 2027\) and general liability audit \(policy term November 21, 2025 to November 21, 2026\)/);
  assert.equal(world.comments[0].isVisibleToVendorRoles, false);
  a = await bothAudits();
  assert.equal(a[0].rows.find((x) => x.jtId === 'V1').asked.toEmail, 'pat@agency.example');
  assert.equal(a[1].rows.find((x) => x.jtId === 'V1').asked.toEmail, 'pat@agency.example', 'May is in both terms');
  assert.equal((await auditFor(env, 'gl-2024', { now: NOW })).rows.find((x) => x.jtId === 'V1')?.asked ?? null, null, 'not in a term May isn’t in');
  assert.equal((await askForGaps(env, a, { now: NOW + DAY })).asked, 0, 'never twice for the same months');
  // The documents sweep emailing them this week: the audit waits
  await DB.prepare("UPDATE vendors SET email = 'office@framing.example' WHERE jt_id = 'V2'").run();
  await DB.prepare("INSERT INTO vendor_asks (jt_id, name, open, asks, asked_at) VALUES ('V2', 'Example Framing Co', 1, 1, ?)").bind(new Date(NOW - DAY).toISOString()).run();
  a = await bothAudits();
  assert.equal((await askForGaps(env, a, { now: NOW })).asked, 0);
  await DB.prepare("UPDATE vendor_asks SET asked_at = ? WHERE jt_id = 'V2'").bind(new Date(NOW - 9 * DAY).toISOString()).run();
  assert.equal((await askForGaps(env, a, { now: NOW })).asked, 1);
  assert.equal(world.emails.at(-1).subject, 'The certificate of insurance that covered your work in June and September 2026', 'the vendor themselves, with no agent on file');
  assert.equal(world.emails.length, 2, 'one email to each sub, never one per audit');
});

test('one audit asks, and the other never asks again for the same months', async () => {
  await coverageTable([
    { jt_id: 'V1', insured: 'Sample Tile', kind: 'gl', effective: '2026-01-01', expires: '2027-01-01', insurer: 'Example Mutual' },
  ], new Date(NOW - 5 * DAY).toISOString());
  const [wc, gl] = await bothAudits();
  // Workers' comp alone first: the tile sub had liability, so it asks for workers' comp only
  assert.equal((await askForGaps(env, wc, { now: NOW })).asked, 1);
  assert.deepEqual(world.emails[0].to, ['office@tile.example']);
  assert.match(world.emails[0].text, /certificate \(workers’ compensation\) that was in force then/);
  assert.match(world.comments[0].message, /for SOARD’s workers’ compensation audit \(policy term April 11, 2026 to April 11, 2027\)\. Replies/);
  // Their liability lapses on paper (the certificate taken back): May is asked about already, so the liability audit doesn't ask again
  await DB.prepare("DELETE FROM coi_coverage WHERE jt_id = 'V1'").run();
  const gl2 = await auditFor(env, 'gl-2025', { now: NOW });
  assert.equal(gl2.rows.find((r) => r.jtId === 'V1').gl.cents, 100000);
  assert.equal((await askForGaps(env, gl2, { now: NOW + DAY })).asked, 0);
  assert.equal(world.emails.length, 1);
  assert.ok(gl, 'both audits read');
});

test('the vendor’s own ask, and its words for one kind of insurance', () => {
  const m = askEmail({ vendorName: 'Sample Tile', months: ['2026-03'], kinds: ['wc'] });
  assert.equal(m.subject, 'The certificate of insurance that covered your work in March 2026');
  assert.match(m.text, /certificate \(workers’ compensation\) that was in force then/);
  assert.match(m.text, /If you had no employees/);
  assert.doesNotMatch(m.text, /policy term/, 'one email serves both audits, so it names neither term');
  const g = askEmail({ vendorName: 'Sample Tile', months: ['2026-03'], kinds: ['gl'] });
  assert.match(g.text, /certificate \(general liability\) that was in force then/);
  assert.doesNotMatch(g.text, /no employees/, 'liability: no workers’ comp way out');
});

test('the heartbeat reads each policy’s current term about daily, one per heartbeat, then asks over both', async () => {
  const first = await maybeRunInsuranceAudit(env, { now: NOW });
  assert.deepEqual(first, { term: 'wc-2026', waiting: 'the other audit’s payments' });
  const second = await maybeRunInsuranceAudit(env, { now: NOW + 60e3 });
  assert.deepEqual(second, { term: 'gl-2025', payments: 3, asked: 0, waiting: 'the certificate search' });
  assert.equal(await maybeRunInsuranceAudit(env, { now: NOW + 3600e3 }), null, 'not again within the day');
  assert.equal((await maybeRunInsuranceAudit(env, { now: NOW + DAY })).term, 'wc-2026');
  assert.equal((await maybeRunInsuranceAudit(env, { now: NOW + DAY + 60e3 })).term, 'gl-2025');
  assert.equal((await readRun(DB, 'wc-2026')).builtAt, new Date(NOW + DAY).toISOString());
});

test('a policy that just renewed is still asked about, so a payment in its last week isn’t missed', async () => {
  // Paid November 18, 2026, three days before the liability policy renews: workers' comp covered it, liability didn't
  world.jtPayments.push({ id: 'P9', amount: 500, paidAt: '2026-11-18', account: { id: 'V1', name: 'Sample Tile', type: 'vendor' }, documentPayments: { nodes: [] } });
  await coverageTable([{ jt_id: 'V1', insured: 'Sample Tile', kind: 'wc', effective: '2026-01-01', expires: '2027-12-01', insurer: 'Example Mutual' }]);
  await maybeRunInsuranceAudit(env, { now: NOW });
  await maybeRunInsuranceAudit(env, { now: NOW + 60e3 });
  const LATER = Date.parse('2026-11-30T15:00:00Z');
  await maybeRunInsuranceAudit(env, { now: LATER });
  const r = await maybeRunInsuranceAudit(env, { now: LATER + 60e3 });
  assert.equal(r.term, 'gl-2026', 'the new liability term read');
  assert.ok(r.asked >= 1);
  assert.ok(world.emails.some((e) => /November 2026/.test(e.subject)), 'the old term’s last week, asked about after it renewed');
});

test('the admin route: the audit, its downloads, a call, and only the terms shown', async () => {
  const ctx = (url, init) => ({ env, request: new Request(`https://x.example/api/insurance-audit-admin${url}`, init), data: { userEmail: 'holly@example.org' }, waitUntil: () => {} });
  let r = await onRequestGet(ctx('?term=2026'));
  let j = await r.json();
  assert.equal(j.success, true);
  assert.equal(j.audit.term.id, 'wc-2026', 'a bare year is workers’ comp');
  assert.equal(j.terms.length, 6, 'three terms for each audit');
  assert.equal((await (await onRequestGet(ctx(''))).json()).audit.term.id, 'wc-2026');
  j = await (await onRequestGet(ctx('?policy=gl'))).json();
  assert.deepEqual([j.audit.term.id, j.audit.policy.id, j.audit.policy.tab], ['gl-2025', 'gl', 'Liability']);
  assert.equal((await (await onRequestGet(ctx('?term=2019'))).json()).error, 'Pick one of the terms shown');
  assert.equal((await (await onRequestGet(ctx('?term=gl-2019'))).json()).error, 'Pick one of the terms shown');
  r = await onRequestGet(ctx('?term=wc-2026&download=csv'));
  assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="SOARD workers comp audit 2026-04-11 to 2027-04-11\.csv"/);
  r = await onRequestGet(ctx('?term=gl-2025&download=csv'));
  assert.match(r.headers.get('content-disposition'), /attachment; filename="SOARD liability audit 2025-11-21 to 2026-11-21\.csv"/);
  assert.match(await r.text(), /^Payee,.*Paid without general liability/);
  r = await onRequestGet(ctx('?term=gl-2025&download=packet'));
  assert.match(r.headers.get('content-disposition'), /filename="SOARD liability audit 2025-11-21 to 2026-11-21\.pdf"/);
  r = await onRequestGet(ctx('?term=2026&download=packet'));
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.ok((await r.arrayBuffer()).byteLength > 500);
  r = await onRequestPost(ctx('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'call', term: '2026', key: 'jt:V2', jtId: 'V2', name: 'Example Framing Co', reason: 'off-site' }) }));
  j = await r.json();
  assert.equal(j.audit.rows.find((x) => x.jtId === 'V2').why, 'Works off site (holly)');
  r = await onRequestPost(ctx('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'call', term: '2026', key: '../x', reason: 'off-site' }) }));
  assert.equal(r.status, 400);
});

test('with asking off, the audits ask nobody for a certificate', async () => {
  await saveDocSettings(env.DB, { asking: false, by: 'pat@example.org' });
  const r = await askForGaps(env, [], { now: Date.parse('2026-10-30T15:00:00Z') });
  assert.deepEqual(r, { asked: 0, waiting: 'Emails asking for W-9s and certificates are off' });
});
