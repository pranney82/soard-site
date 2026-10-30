/**
 * Vendors' W-9s and insurance, kept in JobTread
 * (functions/api/_vendors.js, _vendor-read.js, vendor-docs.js)
 * Run: node --test tests/
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { MERCURY_BASE } from '../functions/api/_mercury.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { ensureSpendSchema } from '../functions/api/_spend.js';
import { ensureBillPaySchema } from '../functions/api/_bill-pay.js';
import {
  docsState, labelFor, requestEmail, jtSetup, readJtVendor, createLink, findLink, fileUpload, pageView, askDue, sweep,
  refreshCache, ensureVendorSchema, sendPreview, readAsk, saveDocSettings, readDocSettings, vendorsThatNeedDocs, DEFAULTS, FOLDER, PREVIEW_ID, LIMITS, TRADES, DOC_STATES,
} from '../functions/api/_vendors.js';
import { judgeCoi, judgeCoiReads, judgeW9, mergeCoi, documentType, answerOf, scannedPages } from '../functions/api/_vendor-read.js';
import { onRequestGet as pageGet, onRequestPost as pagePost } from '../functions/api/vendor-docs.js';

const NOW = Date.parse('2026-10-28T15:00:00Z');
const DAY = 86400e3;
const RELAY_KEY = 'relay-key:test';
const VENDOR = 'ACC-TKO';
const PDF = new TextEncoder().encode('%PDF-1.7 a certificate');
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const pdfFile = (name = 'coi.pdf') => new File([PDF], name, { type: 'application/pdf' });
// A PDF's page as the vendor's browser draws it
const pagePic = (n = 1) => new File([JPG], `page-${n}.jpg`, { type: 'image/jpeg' });
const isVision = (c) => /scout/.test(c.model);
// A scan as a phone app or scanner makes it: each page a JPEG inside, no text (a logo besides)
const jpeg = (fill) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(fill), 0xff, 0xd9]);
const image = (n, w, h, body, filter = '/DCTDecode') => [
  new TextEncoder().encode(`${n} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter} /Length ${body.length} >>\nstream\n`),
  body, new TextEncoder().encode('\nendstream\nendobj\n'),
];
const SCAN = new Uint8Array([
  ...new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'),
  ...image(4, 120, 40, jpeg(1)).flatMap((p) => [...p]),
  ...image(5, 1700, 2200, jpeg(2)).flatMap((p) => [...p]),
  ...image(6, 1700, 2200, jpeg(3), '[/FlateDecode /DCTDecode]').flatMap((p) => [...p]),
  ...image(7, 1700, 2200, jpeg(4)).flatMap((p) => [...p]),
  ...new TextEncoder().encode('trailer\n<< /Root 1 0 R >>\n%%EOF\n'),
]);

const goodCoi = (o = {}) => ({
  isCertificate: true, readable: true, insured: 'TKO Plumbing LLC', certificateHolder: 'Sunshine on a Ranney Day',
  policies: [
    { kind: 'general liability', insurer: 'Hartford', effective: '2026-03-01', expires: '2027-03-01', eachOccurrence: 1000000, aggregate: 2000000 },
    { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-03-01', expires: '2027-03-01', employersLiabilityEachAccident: 500000 },
  ],
  ...o,
});

// ─── A pretend JobTread, Resend, Slack and Mercury ──────────────────

let world;
const fresh = () => ({
  fields: [{ id: 'F-W9', name: 'W-9', type: 'boolean', options: null }],
  tags: [{ id: 'T-QUOTES', name: '.PricingQuotes' }],
  vendors: { [VENDOR]: { name: 'TKO Plumbing', email: 'office@tko.example', values: {} } },
  made: [], updatedFields: [], madeTags: [], updates: [], comments: [], uploads: [], files: [], emails: [], slack: [],
  recipients: [], mercuryUploads: [], ai: null, pdfText: 'ACORD 25 CERTIFICATE OF LIABILITY INSURANCE '.repeat(5), aiCalls: [],
  jtVendorList: null, jobDocs: {},
});

const fieldId = (name) => world.fields.find((f) => f.name === name)?.id;
function accountOf(id) {
  const v = world.vendors[id];
  if (!v) return null;
  const email = { nodes: v.email ? [{ value: v.email }] : [] };
  const agent = v.agent && { id: 'CON2', title: 'Insurance agent', customFieldValues: { nodes: [{ value: v.agent }] } };
  return {
    id, name: v.name, type: 'vendor', archivedAt: null,
    customFieldValues: { nodes: Object.entries(v.values).map(([fid, value]) => ({ value, customField: { id: fid } })) },
    primaryContact: v.agentFirst ? agent : { id: 'CON1', title: 'Owner', customFieldValues: email },
    contacts: { nodes: [...(v.agentFirst ? [agent] : []), { id: 'CON1', title: 'Owner', customFieldValues: email }, ...(agent && !v.agentFirst ? [agent] : [])] },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'uploads.jobtread.example') { world.uploads.push({ url: url.href, bytes: init.body.byteLength }); return new Response('', { status: 200 }); }
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.customFields) return Response.json({ organization: { customFields: { nodes: world.fields }, fileTags: { nodes: world.tags } } });
    if (query.organization?.accounts) return Response.json({ organization: { accounts: { nextPage: null, nodes: world.jtVendorList || [] } } });
    if (query.organization?.jobs) return Response.json({ organization: { jobs: { nextPage: null, nodes: (world.openJobs || []).map((j) => ({ ...j, customFieldValues: { nodes: [{ value: j.status }] }, aces: { nodes: [] } })) } } });
    if (query.createCustomField) {
      const f = { id: `F-${query.createCustomField.$.name}`, ...query.createCustomField.$ };
      world.fields.push(f); world.made.push(query.createCustomField.$);
      return Response.json({ createCustomField: { createdCustomField: { id: f.id } } });
    }
    if (query.updateCustomField) {
      if (world.refuseWiden && 'maxValuesAllowed' in query.updateCustomField.$) return Response.json({ errors: [{ message: 'not allowed' }] }, { status: 400 });
      world.updatedFields.push(query.updateCustomField.$); return Response.json({});
    }
    if (query.createFileTag) {
      const t = { id: `T-${query.createFileTag.$.name}`, name: query.createFileTag.$.name };
      world.tags.push(t); world.madeTags.push(query.createFileTag.$);
      return Response.json({ createFileTag: { createdFileTag: { id: t.id } } });
    }
    if (query.account?.files) return Response.json({ account: { files: { nodes: world.files.filter((f) => f.targetId === query.account.$.id).map((f, i) => ({ id: `FILE${i}`, name: f.name, url: 'https://files.jobtread.example/w9.pdf', fileTags: { nodes: f.fileTagIds.map((tid) => ({ id: tid })) } })) } } });
    if (query.account) return Response.json({ account: accountOf(query.account.$.id) });
    if (query.updateAccount) {
      const { id, customFieldValues } = query.updateAccount.$;
      world.updates.push(query.updateAccount.$);
      Object.assign(world.vendors[id].values, customFieldValues);
      return Response.json({});
    }
    if (query.createComment) { world.comments.push(query.createComment.$); return Response.json({ createComment: { createdComment: { id: `C${world.comments.length}` } } }); }
    if (query.createUploadRequest) return Response.json({ createUploadRequest: { createdUploadRequest: { id: `U${world.uploads.length + 1}`, url: 'https://uploads.jobtread.example/put', method: 'PUT', headers: {} } } });
    if (query.createFile) { world.files.push(query.createFile.$); return Response.json({ createFile: { createdFile: { id: `FILE${world.files.length}` } } }); }
    if (query.job?.documents) return Response.json({ job: { documents: { nextPage: null, nodes: world.jobDocs[query.job.$.id] || [] } } });
    throw new Error(`JobTread doesn't know ${JSON.stringify(Object.keys(query))}`);
  }
  if (url.host === 'files.jobtread.example') return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
  if (url.host === 'api.resend.com') { world.emails.push(...JSON.parse(init.body)); return Response.json({ data: [{ id: 'em1' }] }); }
  if (url.host === 'slack.com') { world.slack.push(JSON.parse(init.body)); return Response.json({ ok: true, channel: 'CFIN', ts: `${world.slack.length}.1` }); }
  if (url.origin === MERCURY_BASE) {
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/recipients') return Response.json({ recipients: world.recipients });
    const up = p.match(/^\/recipient\/([^/]+)\/attachments$/);
    if (up) { world.mercuryUploads.push(up[1]); return Response.json({ id: 'att1' }); }
    throw new Error(`Mercury doesn't know ${p}`);
  }
  throw new Error(`unexpected fetch ${url.href}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
beforeEach(async () => {
  world = fresh();
  const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
  env = {
    DB, JOBTREAD_GRANT_KEY: 'jt', RESEND_API_KEY: 're_test', SLACK_BOT_TOKEN: 'xoxb-test', MERCURY_API_TOKEN: 'secret-token:test', MERCURY_RELAY_KEY: RELAY_KEY,
    AI: {
      toMarkdown: async () => { world.textReads = (world.textReads || 0) + 1; return { format: 'text', data: world.pdfText }; },
      // world.ai: one answer for every model, or (model) => the answer, to read text and pictures differently
      run: async (model, input) => { world.aiCalls.push({ model, input }); return { response: typeof world.ai === 'function' ? world.ai(model, input) : world.ai }; },
    },
  };
  await ensureSpendSchema(DB);
  await ensureBillPaySchema(DB);
  await ensureVendorSchema(DB);
  await writeSlackConfig(DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
});

const setFields = async (o) => {
  await jtSetup(env);
  const v = world.vendors[VENDOR].values;
  if ('w9' in o) v['F-W9'] = o.w9;
  if ('gl' in o) v[fieldId('Liability Expires')] = o.gl;
  if ('wc' in o) v[fieldId('Workers\' Comp Expires')] = o.wc;
  if ('docs' in o) v[fieldId('Documents')] = o.docs;
};
const pendingBill = (o = {}) => env.DB.prepare('INSERT INTO spend_bills (id, job_id, vendor, cents, date, created_at, status, number, lines, account_id, paid, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .bind(o.id || 'BILL1', 'J1', 'TKO Plumbing', 185000, '2026-10-20', new Date(NOW - 2 * DAY).toISOString(), 'pending', '7', '[]', o.account || VENDOR, 0, o.balance ?? 185000).run();

// ─── Pure ───────────────────────────────────────────────────────────

test('what a vendor needs: W-9, liability and workers’ comp, current, ending soon or not needed', () => {
  const base = { id: 'V', name: 'TKO', w9: true, glExpires: '2027-06-01', wcExpires: '2027-06-01', docs: null };
  let s = docsState(base, DEFAULTS, { now: NOW });
  assert.equal(s.ok, true);
  assert.equal(s.label, 'Current');
  assert.deepEqual(s.needs, []);

  s = docsState({ ...base, w9: false, glExpires: '2026-09-30', wcExpires: null }, DEFAULTS, { now: NOW });
  assert.equal(s.ok, false);
  assert.deepEqual(s.needs, ['w9', 'coi']);
  assert.equal(s.send, 'a W-9 and a current certificate of insurance', 'what to send, said as a thing to send');
  assert.equal(s.detail, 'general liability insurance ended September 30, 2026, no workers’ compensation insurance', 'which insurance, without repeating the W-9');
  assert.equal(s.label, 'Missing');
  assert.match(s.staff, /no W-9, general liability insurance ended September 30, 2026, no workers’ compensation insurance/);
  assert.match(s.items.map((i) => i.text).join(' '), /the one we have ended September 30, 2026/);

  s = docsState({ ...base, glExpires: '2026-11-15' }, DEFAULTS, { now: NOW });
  assert.equal(s.ok, true, 'ending in 18 days still pays');
  assert.equal(s.expiring, true);
  assert.equal(s.label, 'Expiring soon');
  assert.deepEqual(s.needs, ['coi']);

  assert.equal(docsState({ ...base, wcExpires: null }, { ...DEFAULTS, workersComp: false }, { now: NOW }).ok, true, 'workers’ comp can be switched off');
  assert.equal(docsState({ ...base, glExpires: null, wcExpires: null, docs: 'W-9 only' }, DEFAULTS, { now: NOW }).ok, true);
  assert.equal(docsState({ ...base, w9: false, docs: 'W-9 only' }, DEFAULTS, { now: NOW }).ok, false, 'W-9 only still needs the W-9');
  const none = docsState({ ...base, w9: false, glExpires: null, docs: 'Not needed' }, DEFAULTS, { now: NOW });
  assert.equal(none.ok, true);
  assert.equal(labelFor({ docs: 'Not needed' }, none, null), null, 'a person’s choice is never overwritten');
  assert.equal(labelFor({ docs: 'Missing' }, docsState({ ...base, w9: false }, DEFAULTS, { now: NOW }), { open: true }), 'Requested');
});

test('a certificate is held to the minimums by plain code, whatever the model says', () => {
  const ok = judgeCoi(goodCoi(), DEFAULTS, { vendorName: 'TKO Plumbing', now: NOW });
  assert.equal(ok.accepted, true);
  assert.equal(ok.gl.expires, '2027-03-01');
  assert.equal(ok.wc.expires, '2027-03-01');
  assert.match(ok.lines.join(' '), /General liability \$1,000,000 each occurrence, \$2,000,000 aggregate, through March 1, 2027 \(Hartford\)/);
  assert.deepEqual(ok.notes, []);

  const old = judgeCoi(goodCoi({ policies: [{ ...goodCoi().policies[0], expires: '2026-09-30' }, goodCoi().policies[1]] }), DEFAULTS, { now: NOW });
  assert.equal(old.accepted, false);
  assert.match(old.problems.join(' '), /General liability ended September 30, 2026/);

  const thin = judgeCoi(goodCoi({ policies: [{ ...goodCoi().policies[0], eachOccurrence: 500000, aggregate: 1000000 }, goodCoi().policies[1]] }), DEFAULTS, { now: NOW });
  assert.match(thin.problems.join(' '), /\$500,000 each occurrence; we need at least \$1,000,000/);
  assert.match(thin.problems.join(' '), /aggregate is \$1,000,000; we need at least \$2,000,000/);

  const noWc = judgeCoi(goodCoi({ policies: [goodCoi().policies[0]] }), DEFAULTS, { now: NOW });
  assert.match(noWc.problems.join(' '), /Workers’ compensation isn’t on this certificate/);
  // Workers' comp on its own certificate, sent alongside
  const both = mergeCoi([goodCoi({ policies: [goodCoi().policies[0]] }), goodCoi({ policies: [goodCoi().policies[1]] })]);
  assert.equal(judgeCoi(both, DEFAULTS, { now: NOW }).accepted, true);

  assert.equal(judgeCoi(null, DEFAULTS, { now: NOW }).unreadable, true);
  assert.equal(judgeCoi({ readable: false }, DEFAULTS, { now: NOW }).unreadable, true);
  assert.match(judgeCoi({ isCertificate: false, policies: [] }, DEFAULTS, { now: NOW }).problems[0], /doesn’t look like a certificate/);
  const odd = judgeCoi(goodCoi({ insured: 'Somebody Else Roofing', certificateHolder: 'To whom it may concern' }), DEFAULTS, { vendorName: 'TKO Plumbing', now: NOW });
  assert.equal(odd.accepted, true, 'a different name or holder is noted, never a reason to refuse');
  assert.equal(odd.notes.length, 2);
});

test('a W-9 needs a tax ID and a signature, and the number never comes back', () => {
  assert.equal(judgeW9({ isW9: true, name: 'TKO Plumbing LLC', hasTaxId: true, signed: true, signedDate: '2026-10-01' }, { vendorName: 'TKO Plumbing' }).accepted, true);
  assert.match(judgeW9({ isW9: true, name: 'TKO', hasTaxId: false, signed: true }).problems[0], /doesn’t show a tax ID/);
  assert.match(judgeW9({ isW9: true, name: 'TKO', hasTaxId: true, signed: false }).problems[0], /isn’t signed/);
  assert.match(judgeW9({ isW9: true, name: 'Jane Roe', hasTaxId: true, signed: true }, { vendorName: 'TKO Plumbing' }).notes[0], /W-9 is for Jane Roe/);
  assert.equal(judgeW9(null).unreadable, true);
  assert.equal(documentType(PDF.slice(0, 16)), 'application/pdf');
  assert.equal(documentType(JPG), 'image/jpeg');
  assert.equal(documentType(new TextEncoder().encode('hello there friend')), null);
  assert.deepEqual(answerOf({ response: '```json\n{"isW9": true}\n```' }), { isW9: true });
});

test('the email says what’s missing and why, with the minimums and the link', () => {
  const state = docsState({ w9: false, glExpires: '2026-09-30', wcExpires: '2027-06-01' }, DEFAULTS, { now: NOW });
  const m = requestEmail({ vendorName: 'TKO Plumbing', url: 'https://x.example/trade-partners/account/#t=abc', state, req: DEFAULTS });
  assert.equal(m.subject, 'Your W-9 and certificate of insurance for Sunshine on a Ranney Day');
  assert.match(m.text, /A W-9: we don’t have one for you yet/);
  assert.match(m.text, /general liability insurance: the one we have ended September 30, 2026/);
  assert.match(m.text, /at least \$1,000,000 each occurrence and \$2,000,000 aggregate/);
  assert.match(m.html, /#t=abc/);
  assert.doesNotMatch(m.text + m.html, /undefined|null/);
  const held = requestEmail({ vendorName: 'TKO Plumbing', url: 'u', state, bill: { number: '7', cents: 185000 } });
  assert.equal(held.subject, 'Your payment from Sunshine on a Ranney Day is waiting on your W-9 and certificate of insurance');
  assert.match(held.text, /invoice #7 for \$1,850\.00 is approved/);
  const renew = requestEmail({ vendorName: 'TKO', url: 'u', state: docsState({ w9: true, glExpires: '2026-11-10', wcExpires: '2027-06-01' }, DEFAULTS, { now: NOW }) });
  assert.equal(renew.subject, 'Your renewed certificate of insurance for Sunshine on a Ranney Day');
  assert.match(renew.text, /the one we have ends November 10, 2026/);
});

test('reminders after 3 days, then 7, five emails at most', () => {
  assert.equal(askDue(null, NOW), true);
  const a = { open: true, asks: 1, askedAt: new Date(NOW).toISOString() };
  assert.equal(askDue(a, NOW + 2 * DAY), false);
  assert.equal(askDue(a, NOW + 3 * DAY), true);
  assert.equal(askDue({ ...a, asks: 2 }, NOW + 6 * DAY), false);
  assert.equal(askDue({ ...a, asks: 2 }, NOW + 7 * DAY), true);
  assert.equal(askDue({ ...a, asks: 5 }, NOW + 30 * DAY), false);
});

// ─── JobTread ───────────────────────────────────────────────────────

test('JobTread gets its vendor fields and file tags once, reusing what’s there', async () => {
  world.fields.push({ id: 'F-DOCS', name: 'Documents', type: 'option', options: ['Current', 'Missing'] });
  world.fields.push({ id: 'F-WC', name: 'Workers’ Comp Expires', type: 'date', options: null });
  const ids = await jtSetup(env);
  assert.equal(ids.fields.w9.id, 'F-W9', 'the W-9 field SOARD already has');
  assert.equal(ids.fields.wc.id, 'F-WC', 'a curly apostrophe is the same field');
  assert.deepEqual(world.made.map((m) => m.name).sort(), ['Address', 'Insurance Check', 'Liability Expires', 'License', 'Materials only', 'Trades']);
  assert.ok(world.made.find((m) => m.name === 'Trades').options.includes('Electrical'), 'Trades comes with its choices');
  assert.ok(world.made.every((m) => m.targetType === 'vendor' && m.minValuesRequired === 0));
  assert.deepEqual(world.updatedFields[0].options.slice(0, 2), ['Current', 'Missing'], 'Documents keeps its options and gains the rest');
  assert.ok(world.updatedFields[0].options.includes('Not needed'));
  assert.deepEqual(world.madeTags.map((t) => t.name), ['W-9', 'COI']);
  await jtSetup(env);
  assert.equal(world.made.length, 6, 'made once');
});

test('two reads at once set JobTread up once; Trades takes any number of trades; a doubled field is said', async () => {
  const [a, b] = await Promise.all([jtSetup(env), jtSetup(env)]);
  assert.equal(a, b);
  assert.equal(world.made.filter((m) => m.name === 'Trades').length, 1, 'the company and the vendor read side by side make one Trades field, not two');
  assert.equal(world.made.find((m) => m.name === 'Trades').maxValuesAllowed, null, 'any number of trades');
  assert.equal(world.made.find((m) => m.name === 'Documents').maxValuesAllowed, 1, 'one Documents state');
  assert.equal(a.fields.trades.multiple, true);
  assert.deepEqual(a.dupes, []);
  // A Trades field made for one answer is opened up; two fields named Documents are reported
  world = { ...fresh(), fields: [{ id: 'F-TR', name: 'Trades', type: 'option', options: TRADES, maxValuesAllowed: 1 }, { id: 'F-D1', name: 'Documents', type: 'option', options: DOC_STATES }, { id: 'F-D2', name: 'Documents', type: 'option', options: DOC_STATES }] };
  const c = await jtSetup(env, { force: true });
  assert.deepEqual(world.updatedFields.find((u) => u.id === 'F-TR'), { id: 'F-TR', maxValuesAllowed: null });
  assert.equal(c.fields.docs.id, 'F-D1', 'the first one is used');
  assert.deepEqual(c.dupes, ['Documents']);
  assert.deepEqual(c.single, []);
  // JobTread refusing to open it up doesn't stop anything: it's said, kept, and not asked again every read
  world = { ...fresh(), refuseWiden: true, fields: [{ id: 'F-TR', name: 'Trades', type: 'option', options: TRADES, maxValuesAllowed: 1 }] };
  const d = await jtSetup(env, { force: true });
  assert.equal(d.fields.trades.multiple, false);
  assert.deepEqual(d.single, ['Trades']);
  world.fields = [];
  assert.deepEqual(await jtSetup(env), d, 'kept, without reading JobTread again');
});

test('a good certificate goes into JobTread, fills the fields and needs nothing else', async () => {
  await setFields({ w9: true });
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  world.ai = goodCoi();
  const req = new Request('https://x.example/api/vendor-docs', { method: 'POST', body: (() => { const f = new FormData(); f.set('token', link.token); f.set('doc', 'coi'); f.append('file', pdfFile()); return f; })() });
  const res = await pagePost({ env, request: req });
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.accepted, true);
  assert.equal(d.done, true);
  assert.equal(world.files.length, 1);
  assert.equal(world.files[0].folder, FOLDER);
  assert.equal(world.files[0].targetId, VENDOR);
  assert.deepEqual(world.files[0].fileTagIds, ['T-COI']);
  assert.match(world.files[0].name, /^COI TKO Plumbing \d{4}-\d{2}-\d{2}\.pdf$/);
  const v = world.vendors[VENDOR].values;
  assert.equal(v[fieldId('Liability Expires')], '2027-03-01');
  assert.equal(v[fieldId('Workers\' Comp Expires')], '2027-03-01');
  assert.equal(v[fieldId('Documents')], 'Current');
  assert.match(v[fieldId('Insurance Check')], /GL \$1,000,000\/\$2,000,000 to 2027-03-01 \(Hartford\)/);
  assert.match(world.comments.at(-1).message, /checked: General liability/);
  assert.equal(world.comments.at(-1).isVisibleToVendorRoles, false);
  assert.ok(world.aiCalls[0].input.response_format, 'JSON mode first');
  // The page reads JobTread again: nothing left to send
  const page = await (await pageGet({ env, request: new Request(`https://x.example/api/vendor-docs?token=${link.token}`) })).json();
  assert.deepEqual(page.vendor.docs.needs, []);
  assert.equal(page.vendor.docs.have.glExpires, '2027-03-01');
  assert.equal(page.vendor.steps.coi, true, 'the trade-partner page shows the insurance step done');
});

test('an out-of-date certificate goes back to the vendor, not into JobTread', async () => {
  await setFields({ w9: true });
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  world.ai = goodCoi({ policies: [{ ...goodCoi().policies[0], expires: '2026-09-30' }, goodCoi().policies[1]] });
  const r = await fileUpload(env, (await findLink(env.DB, link.token, NOW)).link, { doc: 'coi', files: [pdfFile()] }, { now: NOW });
  assert.equal(r.accepted, false);
  assert.match(r.problems[0], /ended September 30, 2026/);
  assert.equal(world.files.length, 0);
  assert.equal(world.updates.length, 0);
  // They think it's right: it goes in for a person, and the Finance channel hears once
  const again = await fileUpload(env, (await findLink(env.DB, link.token, NOW)).link, { doc: 'coi', files: [pdfFile()], anyway: true }, { now: NOW });
  assert.equal(again.look, true);
  assert.equal(world.files.length, 1);
  assert.equal(world.vendors[VENDOR].values[fieldId('Documents')], 'Needs a look');
  assert.equal(world.vendors[VENDOR].values[fieldId('Liability Expires')], undefined, 'no dates written for a person to check');
  assert.equal(world.slack.filter((s) => /Check TKO Plumbing’s certificate of insurance/.test(JSON.stringify(s))).length, 1);
  assert.match(world.comments.at(-1).message, /sent it anyway/);
});

test('a scan nobody can read goes into JobTread as Needs a look', async () => {
  await setFields({ w9: true });
  world.pdfText = '';
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const r = await fileUpload(env, (await findLink(env.DB, link.token, NOW)).link, { doc: 'coi', files: [pdfFile()] }, { now: NOW });
  assert.equal(r.look, true);
  assert.equal(world.aiCalls.length, 0, 'no text, no guess');
  assert.equal(world.files.length, 1);
  assert.equal(world.vendors[VENDOR].values[fieldId('Documents')], 'Needs a look');
});

test('an iPhone photo (HEIC) is turned away with what to send instead, never filed for a person', async () => {
  await setFields({ w9: true });
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const heic = new File([new Uint8Array([0, 0, 0, 0x24, ...new TextEncoder().encode('ftypheicmif1')])], 'IMG_0412.jpg', { type: 'image/jpeg' });
  const { link: found } = await findLink(env.DB, link.token, NOW);
  await assert.rejects(() => fileUpload(env, found, { doc: 'coi', files: [heic] }, { now: NOW }),
    (e) => e.status === 400 && /^IMG_0412\.jpg is an iPhone photo \(HEIC\), which we can’t read\. Send a PDF or a JPG instead\./.test(e.message));
  assert.equal(world.aiCalls.length, 0);
  assert.equal(world.files.length, 0, 'nothing in JobTread');
  assert.equal(world.vendors[VENDOR].values[fieldId('Documents')], undefined, 'not Needs a look');
});

test('a scanned PDF’s pages are cut out as photos: page-sized JPEGs only, in order', () => {
  const pages = scannedPages(SCAN);
  assert.equal(pages.length, 2, 'the logo and the compressed one are skipped');
  assert.deepEqual([...pages[0].bytes], [...jpeg(2)]);
  assert.deepEqual([...pages[1].bytes], [...jpeg(4)]);
  assert.equal(scannedPages(SCAN, { max: 1 }).length, 1);
  assert.deepEqual(scannedPages(PDF), [], 'a PDF with no photos in it');
});

test('a scanned certificate is read from its page photos, not left for a person', async () => {
  await setFields({ w9: true });
  world.pdfText = '';
  world.ai = goodCoi();
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const r = await fileUpload(env, (await findLink(env.DB, link.token, NOW)).link, { doc: 'coi', files: [new File([SCAN], 'scan.pdf', { type: 'application/pdf' })] }, { now: NOW });
  assert.equal(r.accepted, true);
  assert.equal(r.look, false);
  assert.equal(world.aiCalls.length, 2, 'each page read');
  assert.ok(world.aiCalls.every((c) => /vision|scout/.test(c.model) && c.input.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,/9j/')));
  assert.equal(world.files.length, 1, 'the PDF itself goes into JobTread');
  assert.match(world.files[0].name, /\.pdf$/);
  assert.equal(world.vendors[VENDOR].values[fieldId('Liability Expires')], '2027-03-01');
});

test('a scanned W-9: the first page that is a W-9 answers', async () => {
  await setFields({});
  world.pdfText = '';
  world.ai = { isW9: true, readable: true, name: 'TKO Plumbing LLC', hasTaxId: true, signed: true, signedDate: '2026-10-27' };
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const r = await fileUpload(env, (await findLink(env.DB, link.token, NOW)).link, { doc: 'w9', files: [new File([SCAN], 'w9-scan.pdf')] }, { now: NOW });
  assert.equal(r.accepted, true);
  assert.equal(world.aiCalls.length, 1, 'page one was the W-9, so page two isn’t read');
});

test('a good W-9 ticks the box in JobTread and goes onto the Mercury recipient', async () => {
  await setFields({ gl: '2027-06-01', wc: '2027-06-01' });
  world.recipients = [{ id: 'rec-tko', name: 'TKO Plumbing', status: 'active', attachments: [] }];
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  world.ai = { isW9: true, readable: true, name: 'TKO Plumbing LLC', hasTaxId: true, signed: true, signedDate: '2026-10-27' };
  const r = await fileUpload(env, (await findLink(env.DB, link.token, NOW)).link, { doc: 'w9', files: [new File([PDF], 'w9.pdf')], pages: [[pagePic(1), pagePic(2)]] }, { now: NOW });
  assert.equal(r.accepted, true);
  assert.equal(world.aiCalls.length, 1, 'page one was the W-9');
  assert.ok(isVision(world.aiCalls[0]), 'read from its picture');
  assert.equal(world.textReads, undefined, 'a W-9’s text is never asked: its signature and typed-in boxes aren’t in it');
  assert.equal(world.vendors[VENDOR].values['F-W9'], true);
  assert.equal(world.files.length, 1, 'the PDF is filed, not its pictures');
  assert.match(world.files[0].name, /\.pdf$/);
  assert.deepEqual(world.files[0].fileTagIds, ['T-W-9']);
  assert.deepEqual(world.mercuryUploads, ['rec-tko']);
  assert.doesNotMatch(JSON.stringify(world.comments), /\d{3}-\d{2}-\d{4}|\d{2}-\d{7}/, 'no tax ID anywhere');
});

test('a W-9 PDF the browser couldn’t draw goes to a person, never refused on its text', async () => {
  await setFields({});
  world.ai = { isW9: true, readable: true, name: 'TKO Plumbing LLC', hasTaxId: false, signed: false };
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const r = await fileUpload(env, (await findLink(env.DB, link.token, NOW)).link, { doc: 'w9', files: [new File([PDF], 'w9.pdf')] }, { now: NOW });
  assert.equal(r.look, true);
  assert.equal(world.aiCalls.length, 0);
  assert.equal(world.vendors[VENDOR].values[fieldId('Documents')], 'Needs a look');
});

test('pictures that aren’t JPEGs, are too big, or come with a photo are left out', async () => {
  await setFields({ w9: true });
  world.ai = goodCoi();
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const big = new File([new Uint8Array(LIMITS.pageBytes + 1).fill(0xff)], 'page-2.jpg');
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], 'page-3.jpg');
  const r = await fileUpload(env, (await findLink(env.DB, link.token, NOW)).link, { doc: 'coi', files: [pdfFile(), new File([JPG], 'wc.jpg')], pages: [[pagePic(1), big, png], [pagePic(1)]] }, { now: NOW });
  assert.equal(r.accepted, true);
  // The PDF: its text and its one good picture; the photo: itself
  assert.equal(world.aiCalls.filter(isVision).length, 2);
  assert.equal(world.aiCalls.filter((c) => !isVision(c)).length, 1);
});

test('a certificate read two ways: the browser’s pictures and the text both go through the form post', async () => {
  await setFields({ w9: true });
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  // The text took PRODUCTS-COMP/OP AGG for the aggregate; the picture read GENERAL AGGREGATE right
  world.ai = (model) => goodCoi({ policies: [{ ...goodCoi().policies[0], aggregate: /scout/.test(model) ? 1000000 : 2000000 }, goodCoi().policies[1]] });
  const body = new FormData();
  body.set('token', link.token); body.set('doc', 'coi'); body.append('file', pdfFile()); body.append('pages0', pagePic(1));
  const d = await (await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) })).json();
  assert.equal(d.ok, true);
  assert.equal(d.accepted, false, 'one reading short of the minimum is never a pass');
  assert.equal(d.look, true, 'a person decides');
  assert.equal(world.files.length, 1);
  assert.equal(world.vendors[VENDOR].values[fieldId('Liability Expires')], undefined, 'no dates written for a person to check');
  assert.match(world.comments.at(-1).message, /read it two ways that didn’t agree \(General liability’s aggregate is \$1,000,000; we need at least \$2,000,000\.\)/);
});

test('a split on one number is asked once more, on its own: it settles for or against, or a person decides', async () => {
  await setFields({ w9: true });
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const reading = (agg) => goodCoi({ policies: [{ ...goodCoi().policies[0], aggregate: agg }, goodCoi().policies[1]] });
  const run = async (focused) => {
    world.aiCalls = [];
    world.files = [];
    world.ai = (model, input) => {
      const sys = input?.messages?.[0]?.content || '';
      if (/You read one value/.test(sys)) return { value: focused };
      return /scout/.test(model) ? reading(1000000) : reading(2000000);
    };
    const { link: l } = await findLink(env.DB, link.token, NOW);
    return fileUpload(env, l, { doc: 'coi', files: [pdfFile()], pages: [[pagePic(1)]] }, { now: NOW });
  };
  // The picture, asked only about GENERAL AGGREGATE, says $2,000,000: the text was right
  let r = await run(2000000);
  assert.equal(r.accepted, true);
  const focused = world.aiCalls.find((c) => /You read one value/.test(c.input.messages[0].content));
  assert.match(focused.input.messages[0].content, /GENERAL AGGREGATE limit in dollars \(not PRODUCTS - COMP\/OP AGG/);
  // It says $1,000,000: the picture was right, and the vendor is told
  r = await run('$1,000,000');
  assert.equal(r.accepted, false);
  assert.deepEqual(r.problems, ['General liability’s aggregate is $1,000,000; we need at least $2,000,000.']);
  // Neither: a person decides
  r = await run(3000000);
  assert.equal(r.look, true);
});

test('two readings of a certificate: a pass needs both, and only problems that hold either way go back', () => {
  const req = { glOccurrence: 1000000, glAggregate: 2000000, workersComp: true, elEachAccident: 100000 };
  const opts = { vendorName: 'TKO Plumbing', now: NOW };
  const gl = (o) => ({ ...goodCoi().policies[0], ...o });
  const wc = (o) => ({ ...goodCoi().policies[1], ...o });
  const reading = (...policies) => goodCoi({ policies });
  // Agreed and good: accepted, with the earlier of two end dates kept
  const ok = judgeCoiReads([{ text: reading(gl({ expires: '2027-03-01' }), wc()), pictures: reading(gl({ expires: '2027-03-31' }), wc()) }], req, opts);
  assert.equal(ok.accepted, true);
  assert.equal(ok.gl.expires, '2027-03-01');
  // Live, Oct 29: no workers' comp, and the picture took PERSONAL & ADV INJURY ($1M) for the aggregate
  const noWc = judgeCoiReads([{ text: reading(gl()), pictures: reading(gl({ aggregate: 1000000 })) }], req, opts);
  assert.equal(noWc.accepted, false);
  assert.deepEqual(noWc.problems, ['Workers’ compensation isn’t on this certificate. If it’s on a certificate of its own, add that one too.']);
  // Live, Oct 29: $500,000/$1,000,000, and the text took PRODUCTS-COMP/OP AGG ($2M) for the aggregate
  const low = judgeCoiReads([{ text: reading(gl({ eachOccurrence: 500000 }), wc()), pictures: reading(gl({ eachOccurrence: 500000, aggregate: 1000000 }), wc()) }], req, opts);
  assert.deepEqual(low.problems, ['General liability is $500,000 each occurrence; we need at least $1,000,000.']);
  // A policy only one reading found counts: a fillable form's typed boxes aren't in its text
  const fillable = judgeCoiReads([{ text: reading(gl()), pictures: reading(gl(), wc()) }], req, opts);
  assert.equal(fillable.accepted, true);
  // One reading passes and the other doesn't: a person
  const split = judgeCoiReads([{ text: reading(gl(), wc()), pictures: reading(gl({ expires: '2026-09-30' }), wc()) }], req, opts);
  assert.equal(split.unreadable, true);
  assert.match(split.unsure, /General liability ended September 30, 2026/);
  // A photo is one reading; a file nobody could read is none
  assert.equal(judgeCoiReads([{ text: null, pictures: reading(gl(), wc()) }], req, opts).accepted, true);
  assert.deepEqual(judgeCoiReads([{ text: null, pictures: null }], req, opts), { unreadable: true });
});

test('something else in the W-9 slot is still called something else, not left for a person', async () => {
  await setFields({});
  world.ai = goodCoi({ isW9: false });
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const r = await fileUpload(env, (await findLink(env.DB, link.token, NOW)).link, { doc: 'w9', files: [new File([PDF], 'w9.pdf')], pages: [[pagePic(1), pagePic(2)]] }, { now: NOW });
  assert.equal(r.accepted, false);
  assert.equal(r.look, false);
  assert.match(r.problems[0], /^This doesn’t look like a W-9\./);
  assert.equal(world.aiCalls.length, 2, 'both pages looked at for a W-9');
  assert.equal(world.files.length, 0);
});

test('a reading with a date written the form’s way, or none, still counts for its limits', () => {
  const req = { glOccurrence: 1000000, glAggregate: 2000000, workersComp: true, elEachAccident: 100000 };
  const gl = (o) => ({ ...goodCoi().policies[0], ...o });
  const wc = goodCoi().policies[1];
  const pictures = goodCoi({ policies: [gl(), wc] });
  // The text read $500,000 and wrote 03/01/2027: the two readings disagree, so never a pass
  const slash = judgeCoiReads([{ text: goodCoi({ policies: [gl({ eachOccurrence: 500000, expires: '03/01/2027' }), wc] }), pictures }], req, { now: NOW });
  assert.equal(slash.accepted, undefined);
  assert.equal(slash.unreadable, true);
  assert.match(slash.unsure, /\$500,000 each occurrence/);
  // …and with no usable date at all
  const none = judgeCoiReads([{ text: goodCoi({ policies: [gl({ eachOccurrence: 500000, expires: 'see attached' }), wc] }), pictures }], req, { now: NOW });
  assert.equal(none.unreadable, true);
  // A date written 03/01/2027 by both is still a date
  assert.equal(judgeCoiReads([{ text: null, pictures: goodCoi({ policies: [gl({ expires: '03/01/2027' }), { ...wc, expires: '3/1/27' }] }) }], req, { now: NOW }).accepted, true);
});

test('certificates on separate files are paired file by file', () => {
  const req = { glOccurrence: 1000000, glAggregate: 2000000, workersComp: true, elEachAccident: 100000 };
  const [gl, wc] = goodCoi().policies;
  const old = { ...wc, expires: '2026-01-01' };
  // File 1: liability and last year's workers' comp; file 2: this year's workers' comp, which only its picture showed
  const r = judgeCoiReads([
    { text: goodCoi({ policies: [gl, old] }), pictures: goodCoi({ policies: [gl, old] }) },
    { text: goodCoi({ policies: [] }), pictures: goodCoi({ policies: [wc] }) },
  ], req, { now: NOW });
  assert.equal(r.accepted, true);
  assert.equal(r.wc.expires, '2027-03-01');
});

test('an unsigned W-9 never says when it was signed (its empty date box once read as 1901)', () => {
  const r = judgeW9({ isW9: true, readable: true, name: 'Rivera Example Roofing LLC', hasTaxId: true, signed: false, signedDate: '1901-01-01' });
  assert.deepEqual(r.lines, ['W-9 for Rivera Example Roofing LLC.']);
  assert.match(judgeW9({ isW9: true, name: 'X', hasTaxId: true, signed: true, signedDate: '2026-10-27' }).lines[0], /signed October 27, 2026/);
});

test('links: unknown, expired and the old Vendors area’s links open nothing', async () => {
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  assert.equal((await findLink(env.DB, link.token, NOW)).problem, null);
  assert.equal((await findLink(env.DB, link.token, NOW + 89 * DAY)).problem, null, 'a link lasts 90 days');
  assert.equal((await findLink(env.DB, link.token, NOW + 91 * DAY)).problem, 'expired');
  assert.equal((await findLink(env.DB, 'not-a-real-token-at-all-xyz', NOW)).problem, 'unknown');
  const res = await pageGet({ env, request: new Request('https://x.example/api/vendor-docs?token=nope') });
  assert.equal(res.status, 404);
});

// ─── The heartbeat's sweep ──────────────────────────────────────────

test('a vendor with a bill waiting is asked once, reminded after 3 days, and JobTread says Requested', async () => {
  await setFields({ w9: false, gl: '2027-06-01', wc: '2027-06-01' });
  await pendingBill();
  const one = await sweep(env, { now: NOW });
  assert.equal(one.asked, 1);
  assert.equal(world.emails.length, 1);
  assert.equal(world.emails[0].to[0], 'office@tko.example');
  assert.match(world.emails[0].subject, /Your W-9 for Sunshine on a Ranney Day/);
  assert.match(world.emails[0].text, /trade-partners\/account\/#t=/);
  assert.match(world.emails[0].text, /sign in at sunshineonaranneyday\.com\/trade-partners\/ with this email address/);
  assert.equal(world.vendors[VENDOR].values[fieldId('Documents')], 'Requested');
  assert.equal((await readAsk(env.DB, VENDOR)).open, true);

  await sweep(env, { now: NOW + DAY });
  assert.equal(world.emails.length, 1, 'not the next day');
  await sweep(env, { now: NOW + 3 * DAY + 60000 });
  assert.equal(world.emails.length, 2, 'a reminder after 3 days');
  assert.match(world.emails[1].subject, /^A reminder: your W-9/);

  // It came in: JobTread says Current and the asking stops
  world.vendors[VENDOR].values['F-W9'] = true;
  await env.DB.prepare('UPDATE vendor_asks SET checked_at = ?').bind(new Date(NOW).toISOString()).run();
  await sweep(env, { now: NOW + 4 * DAY });
  assert.equal(world.vendors[VENDOR].values[fieldId('Documents')], 'Current');
  assert.equal((await readAsk(env.DB, VENDOR)).open, false);
  await sweep(env, { now: NOW + 12 * DAY });
  assert.equal(world.emails.length, 2);
});

test('bills Ramp wrote, or already approved and paid outside the flow, never email anyone', async () => {
  await setFields({ w9: false });
  await pendingBill();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS spend_recode (bill_id TEXT PRIMARY KEY, before TEXT NOT NULL, state TEXT NOT NULL)").run();
  await env.DB.prepare("INSERT INTO spend_recode (bill_id, before, state) VALUES ('BILL1', '{}', 'waiting')").run();
  await env.DB.prepare("INSERT INTO spend_bills (id, vendor, cents, created_at, status, account_id, balance) VALUES ('BILL9', 'TKO Plumbing', 5000, ?, 'approved', ?, 5000)").bind(new Date(NOW).toISOString(), VENDOR).run();
  const r = await sweep(env, { now: NOW });
  assert.equal(r.read, 0);
  assert.equal(world.emails.length, 0);
});

test('no email in JobTread: the Finance channel hears once, nobody is emailed', async () => {
  world.vendors[VENDOR].email = null;
  await setFields({ w9: false });
  await pendingBill();
  await sweep(env, { now: NOW });
  await sweep(env, { now: NOW + 7 * DAY });
  assert.equal(world.emails.length, 0);
  assert.equal(world.slack.filter((s) => /No email for TKO Plumbing/.test(JSON.stringify(s))).length, 1);
});

test('insurance JobTread has dates for is asked for from 30 days ahead, on a job or not, and each email is noted in JobTread', async () => {
  const cache = (fields) => env.DB.prepare("INSERT OR REPLACE INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES ('jt_TKO', 'TKO Plumbing', 'tko plumbing', ?, 'office@tko.example', ?, 'x', 'x')")
    .bind(VENDOR, JSON.stringify({ jobs: [], emails: ['office@tko.example'], fields })).run();
  await cache({ w9: true, gl: '2027-06-01', wc: '2027-06-01', docs: null });
  assert.equal((await vendorsThatNeedDocs(env.DB, { now: NOW })).size, 0, 'months away: nothing to ask');
  await cache({ w9: true, gl: '2026-11-20', wc: '2027-06-01', docs: null });
  assert.deepEqual([...(await vendorsThatNeedDocs(env.DB, { now: NOW })).entries()], [[VENDOR, { why: 'renewal', bill: null }]]);
  await cache({ w9: true, gl: '2026-11-20', wc: null, docs: 'Not needed' });
  assert.equal((await vendorsThatNeedDocs(env.DB, { now: NOW })).size, 0, 'a person said Not needed in JobTread');
  await cache({ w9: true, gl: '2025-03-01', wc: null, docs: null });
  assert.equal((await vendorsThatNeedDocs(env.DB, { now: NOW })).size, 0, 'lapsed long ago and not working for SOARD: left alone');
  // Ending in 23 days, no bill and no job: asked, and it's on their JobTread record
  await cache({ w9: true, gl: '2026-11-20', wc: '2027-06-01', docs: null });
  await setFields({ w9: true, gl: '2026-11-20', wc: '2027-06-01' });
  const r = await sweep(env, { now: NOW });
  assert.equal(r.asked, 1);
  assert.match(world.emails[0].subject, /Your renewed certificate of insurance/);
  const note = world.comments.find((c) => c.targetType === 'account');
  assert.equal(note.name, 'Emailed for the renewed insurance');
  assert.match(note.message, /SOARD emailed office@tko\.example on October 28, 2026 for certificate of insurance \(general liability insurance ends November 20, 2026\)/);
});

test('a renewal with nobody to email: their agent is asked, and no Slack post about a missing email', async () => {
  world.vendors[VENDOR].email = null;
  await env.DB.prepare("INSERT OR REPLACE INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES ('jt_TKO', 'TKO Plumbing', 'tko plumbing', ?, NULL, ?, 'x', 'x')")
    .bind(VENDOR, JSON.stringify({ jobs: [], emails: [], fields: { w9: true, gl: '2026-11-20', wc: '2027-06-01', docs: null } })).run();
  await setFields({ w9: true, gl: '2026-11-20', wc: '2027-06-01' });
  const { ensurePartnerSchema, patchProfile } = await import('../functions/api/_trade-partners.js');
  await ensurePartnerSchema(env.DB);
  await patchProfile(env.DB, VENDOR, { agent: { name: 'Ana Agent', email: 'ana@agency.example', agency: 'Example Insurance', asks: 0, open: false } });
  await sweep(env, { now: NOW });
  assert.deepEqual(world.emails.map((m) => m.to[0]), ['ana@agency.example']);
  assert.match(world.emails[0].subject, /Certificate of insurance renewal for TKO Plumbing/);
  assert.equal(world.slack.filter((x) => /No email for/.test(JSON.stringify(x))).length, 0);
});

test('an insurance agent’s contact is never the vendor’s email: not for their link, not for signing in', async () => {
  world.vendors[VENDOR].agent = 'ana@agency.example';
  world.vendors[VENDOR].agentFirst = true;
  await setFields({ w9: false });
  assert.equal((await readJtVendor(env, VENDOR)).email, 'office@tko.example');
  world.vendors[VENDOR].email = null;
  assert.equal((await readJtVendor(env, VENDOR)).email, null, 'only the agent: no vendor email at all');
  world.jtVendorList = [{ id: VENDOR, name: 'TKO Plumbing', archivedAt: null, contacts: { nodes: [
    { title: 'Insurance agent', customFieldValues: { nodes: [{ value: 'ana@agency.example' }] } }, { title: 'Owner', customFieldValues: { nodes: [{ value: 'tom@tko.example' }] } },
  ] } }];
  await refreshCache(env, { now: NOW - 30 * DAY }); // well before the other tests' reads: the open jobs it keeps for a while stay theirs
  const row = await env.DB.prepare('SELECT email, facts FROM vendors WHERE jt_id = ?').bind(VENDOR).first();
  assert.equal(row.email, 'tom@tko.example');
  assert.deepEqual(JSON.parse(row.facts).emails, ['tom@tko.example']);
});

test('“Not needed” in JobTread: never asked', async () => {
  await setFields({ w9: false, docs: 'Not needed' });
  await pendingBill();
  await sweep(env, { now: NOW });
  assert.equal(world.emails.length, 0);
  assert.equal(world.vendors[VENDOR].values[fieldId('Documents')], 'Not needed');
});

test('the JobTread cache keeps jt_id and facts.jobs for the job-access sweep, and a PO gets the vendor asked', async () => {
  world.jtVendorList = [{ id: VENDOR, name: 'TKO Plumbing', archivedAt: null, contacts: { nodes: [] } }];
  world.openJobs = [{ id: 'J1', name: 'Isla 2026', status: 'Build' }];
  world.jobDocs.J1 = [{ type: 'vendorOrder', status: 'approved', account: { id: VENDOR } }];
  await env.DB.prepare("INSERT INTO vendors (id, name, jt_id, facts, created_at, updated_at) VALUES ('v_old', 'Old Mercury-only', NULL, '{}', 'x', 'x')").run();
  assert.equal(await refreshCache(env, { now: NOW }), 1);
  const rows = (await env.DB.prepare('SELECT jt_id, facts FROM vendors').all()).results;
  assert.equal(rows.length, 1, 'only JobTread vendors stay');
  assert.equal(rows[0].jt_id, VENDOR);
  assert.deepEqual(JSON.parse(rows[0].facts).jobs, [{ jobId: 'J1', jobName: 'Isla 2026', status: 'Build', order: true }]);
  // On a purchase order with no W-9 or insurance: asked before work starts
  await setFields({ w9: false });
  const r = await sweep(env, { now: NOW });
  assert.equal(r.asked, 1);
  assert.match(world.emails[0].subject, /W-9 and certificate of insurance/);
});

// ─── "Send it to me" ────────────────────────────────────────────────

test('the preview emails the staff member a page for a sample company; files are checked, never filed', async () => {
  const r = await sendPreview(env, 'staff@example.org', { now: NOW });
  assert.equal(world.emails.length, 1);
  assert.equal(world.emails[0].to[0], 'staff@example.org');
  assert.match(world.emails[0].subject, /^Preview: /);
  const token = r.url.split('#t=')[1];
  const { link } = await findLink(env.DB, token, NOW);
  assert.equal(link.vendor_id, PREVIEW_ID);
  const view = await pageView(env, link, { now: NOW });
  assert.equal(view.preview, true);
  assert.deepEqual(view.needs, ['w9', 'coi']);
  world.ai = goodCoi();
  const up = await fileUpload(env, link, { doc: 'coi', files: [pdfFile()] }, { now: NOW });
  assert.equal(up.accepted, true);
  assert.equal(up.preview, true);
  assert.deepEqual(up.needs, ['w9']);
  assert.equal(world.files.length, 0, 'nothing filed');
  assert.equal(world.updates.length, 0, 'nothing written');
  assert.equal(await readAsk(env.DB, PREVIEW_ID), null);
});

test('the minimums are saved with sane bounds', async () => {
  await saveDocSettings(env.DB, { glOccurrence: '2000000', workersComp: false, renewDays: 45 });
  const s = await readDocSettings(env.DB);
  assert.equal(s.glOccurrence, 2000000);
  assert.equal(s.workersComp, false);
  assert.equal(s.renewDays, 45);
  await assert.rejects(() => saveDocSettings(env.DB, { renewDays: 2 }), /7 to 90 days/);
  await assert.rejects(() => saveDocSettings(env.DB, { glAggregate: -5 }), /dollar amount/);
});

test('readJtVendor reads the fields by id and the first contact email', async () => {
  await setFields({ w9: 'Yes', gl: '2027-06-01T00:00:00Z' });
  const v = await readJtVendor(env, VENDOR);
  assert.equal(v.w9, true);
  assert.equal(v.glExpires, '2027-06-01');
  assert.equal(v.email, 'office@tko.example');
});
