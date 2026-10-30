/**
 * The certificates and W-9s SOARD already had, found and filed in JobTread
 * (functions/api/_coi-backfill.js, with _vendor-read.js)
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { createD1 } from './lib/d1-shim.mjs';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { ensureVendorSchema } from '../functions/api/_vendors.js';
import { W9_PDF_BASE64 } from '../functions/api/_w9-irs.js';
import {
  worthReading, hintsOf, kindOfText, isOwn, namesOf, nameKey, nameScore, candidatesFor, onVendorDomain, laterDates, meetsMinimums, typedW9,
  readingOf, recordCoverage, recordUpload, maybeRunBackfill, backfillStatus, sha256, MAIL_WORDS, STATE_KEY,
} from '../functions/api/_coi-backfill.js';
import { DEFAULTS } from '../functions/api/_vendors.js';

const NOW = Date.parse('2026-10-30T15:00:00Z');
const DAY = 86400e3;
const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1234567890', private_key: SA_PEM });
const PAT = 'pat@soardcharity.com';
const SAM = 'sam@soardcharity.com';
const ACCOUNTS = [{ email: PAT, aliases: [], name: 'Pat Lee', active: true, why: null }, { email: SAM, aliases: [], name: 'Sam Fox', active: true, why: null }];
const TIN = '12-3456789'; // the IRS's own example EIN

// ─── Pure parts ─────────────────────────────────────────────────────

test('the prefilter: PDFs are fetched for their text; photos only when the email speaks of insurance or a W-9; logos never', () => {
  assert.equal(worthReading({ name: 'ACORD Form 20260605.pdf', type: 'application/pdf', size: 90000 }), true);
  assert.equal(worthReading({ name: 'scan.pdf', type: 'application/octet-stream', size: 90000 }), true, 'a PDF Outlook sent as bytes');
  assert.equal(worthReading({ name: 'tiny.pdf', type: 'application/pdf', size: 3000 }), false);
  assert.equal(worthReading({ name: 'big.pdf', type: 'application/pdf', size: 20 * 1024 * 1024 }), false);
  assert.equal(worthReading({ name: 'Proposal.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 90000 }, { hinted: true }), false);
  assert.equal(worthReading({ name: 'IMG_5171.png', type: 'image/png', size: 474000 }), false, 'a photo nothing calls insurance');
  assert.equal(worthReading({ name: 'IMG_5171.png', type: 'image/png', size: 474000 }, { hinted: true }), true);
  assert.equal(worthReading({ name: 'COI photo.jpg', type: 'image/jpeg', size: 300000 }), true, 'its own name says so');
  assert.equal(worthReading({ name: 'image001.png', type: 'image/png', size: 120000 }, { hinted: true }), false, 'a signature logo');
  assert.equal(worthReading({ name: 'photo.jpg', type: 'image/jpeg', size: 150000, inline: true }, { hinted: true }), false, 'a pasted logo');
  assert.equal(worthReading({ name: 'image003.jpg', type: 'image/jpeg', size: 600000, inline: true }, { hinted: true }), true, 'a pasted photo of a page');
  assert.equal(worthReading({ name: 'shot.png', type: 'image/png', size: 30000 }, { hinted: true }), false, 'too small to read');
});

test('what a PDF is, from its own text: certificate, exemption, the W-9 by its title (not a 1099 that names it), a scan', () => {
  assert.equal(kindOfText(`ACORD 25 (2016/03) CERTIFICATE OF LIABILITY INSURANCE DATE ${'x '.repeat(40)}`), 'coi');
  assert.equal(kindOfText(`State of Georgia Workers' Compensation affidavit: the company has fewer than three employees and is exempt. ${'x '.repeat(20)}`), 'coi');
  assert.equal(kindOfText(`Form W-9 (Rev. March 2024) Request for Taxpayer Identification Number and Certification ${'x '.repeat(20)}`), 'w9');
  assert.equal(kindOfText(`Form 1099-K Payment Card and Third Party Network Transactions. Furnish Form W-9 to the payer. ${'x '.repeat(30)}`), null);
  assert.equal(kindOfText(`2026 Volunteer Release Waiver ${'words '.repeat(30)}`), null);
  assert.equal(kindOfText('   \n '), 'scan');
  assert.deepEqual(hintsOf('Re: Renewal COI for Sample Painting'), { coi: true, w9: false });
  assert.deepEqual(hintsOf('Name change, request for COI, W9'), { coi: true, w9: true });
  assert.deepEqual(hintsOf('Subcontractor affidavit, workers comp exemption'), { coi: true, w9: false });
  assert.deepEqual(hintsOf('Board meeting notes'), { coi: false, w9: false });
  assert.match(MAIL_WORDS, /^has:attachment \(/);
});

test('SOARD’s own paperwork is told apart: its name as insured or on a W-9, or its own workers’ comp policy', () => {
  assert.equal(isOwn(['Sunshine on a Ranney Day, Inc.']), true);
  assert.equal(isOwn(['SOARD']), true);
  assert.equal(isOwn(['Sunny and Ranney']), true);
  assert.equal(isOwn(['Sample Painting LLC'], [{ policyNumber: 'WCV-0329463-03' }]), true);
  assert.equal(isOwn(['Sample Painting LLC'], [{ policyNumber: 'GL-555' }]), false);
});

test('names: DBA names apart, legal endings aside, and a one-word vendor never swallows a longer name', () => {
  assert.deepEqual(namesOf('Sample Hauling LLC DBA Bins To Go'), ['Sample Hauling LLC', 'Bins To Go']);
  assert.deepEqual(namesOf('Jane Doe d/b/a Doe Tile'), ['Jane Doe', 'Doe Tile']);
  assert.deepEqual(namesOf('R H & A LLC, DBA: Sample Heating & Air'), ['R H & A LLC', 'Sample Heating & Air'], 'a DBA with a colon');
  assert.equal(nameKey('Pulley & Associates, Inc.'), nameKey('Pulley and Associates'));
  assert.equal(nameScore('ServiceWise Electric', 'Service Wise Electric, LLC'), 1);
  assert.equal(nameScore('Doorsmith, inc.', 'Doorsmith, Inc.'), 1);
  assert.ok(nameScore('Atlanta Plumbing Co', 'Atlanta') < 1);
  const vendors = [
    { jtId: 'V1', name: 'Pulley & Associates, Inc.', jobs: 0 }, { jtId: 'V2', name: 'Pulley and Associates, Inc.', jobs: 3 },
    { jtId: 'V3', name: 'Atlanta', jobs: 9 }, { jtId: 'V4', name: 'Sample Painting LLC', jobs: 1 },
  ];
  assert.deepEqual(candidatesFor(['Pulley and Associates Inc'], vendors).map((c) => c.jtId), ['V2', 'V1'], 'JobTread has it twice: the one on more jobs first');
  assert.deepEqual(candidatesFor(['Atlanta Plumbing Co'], vendors), [], 'a vendor called “Atlanta” isn’t every Atlanta company: a one-word name has to be the same name');
  assert.deepEqual(candidatesFor(['Sample Paint Co'], vendors).map((c) => [c.jtId, c.score]), [['V4', 0.5]]);
});

test('a sender on the vendor’s own domain (not free mail, not SOARD’s)', () => {
  assert.equal(onVendorDomain('office@servicewiseelectric.example', 'ServiceWise Electric LLC'), true);
  assert.equal(onVendorDomain('amy@samplepainting.example', 'Sample Painting LLC'), true);
  assert.equal(onVendorDomain('agent@bigagency.example', 'Sample Painting LLC'), false);
  assert.equal(onVendorDomain('samplepainting@gmail.com', 'Sample Painting LLC'), false);
  assert.equal(onVendorDomain('pat@soardcharity.com', 'Soard Charity'), false);
});

test('JobTread’s dates only move forward, and only for coverage that meets the minimums', () => {
  const gl = (expires, eachOccurrence = 1000000) => ({ kind: 'general liability', expires, eachOccurrence, aggregate: 2000000 });
  const wc = (expires) => ({ kind: 'workers compensation', expires, employersLiabilityEachAccident: 500000 });
  assert.deepEqual(laterDates({ glExpires: null, wcExpires: null }, { policies: [gl('2025-03-01'), wc('2025-04-01')] }, DEFAULTS), { gl: '2025-03-01', glFrom: null, wc: '2025-04-01', wcFrom: null });
  assert.deepEqual(laterDates({ glExpires: '2027-01-01', wcExpires: '2024-01-01' }, { policies: [gl('2026-01-01'), wc('2026-06-01')] }, DEFAULTS), { wc: '2026-06-01', wcFrom: '2024-01-01' }, 'liability stays at its later date');
  assert.deepEqual(laterDates({}, { policies: [gl('2027-01-01', 500000)] }, DEFAULTS), {}, '$500,000 each occurrence is under the minimum');
  assert.equal(meetsMinimums(gl('2027-01-01', null), DEFAULTS), false, 'a limit it doesn’t show can’t be said to meet it');
  assert.equal(meetsMinimums({ kind: 'workers compensation', expires: '2027-01-01' }, DEFAULTS), true);
});

test('two readings of one certificate: where they differ on an end date, the earlier one', () => {
  const r = readingOf({
    text: { isCertificate: true, insured: 'Sample Painting LLC', producer: { name: 'Sample Insurance Agency', email: 'amy@sampleinsure.example' }, policies: [
      { kind: 'general liability', expires: '2027-03-01', eachOccurrence: 1000000, policyNumber: 'GL-1' }, { kind: 'workers compensation', expires: '03/01/2027' }] },
    pictures: { isCertificate: true, insured: 'Sample Painting LLC', policies: [{ kind: 'general liability', expires: '2026-03-01', eachOccurrence: 1000000 }] },
  });
  assert.equal(r.policies.find((p) => p.kind === 'general liability').expires, '2026-03-01');
  assert.equal(r.policies.find((p) => p.kind === 'general liability').policyNumber, 'GL-1');
  assert.equal(r.policies.find((p) => p.kind === 'workers compensation').expires, '2027-03-01');
  assert.equal(r.producer.email, 'amy@sampleinsure.example');
});

test('a W-9 typed into the IRS form: its names and whether a tax ID is there, never the number', async () => {
  const doc = await PDFDocument.load(Buffer.from(W9_PDF_BASE64, 'base64'));
  const form = doc.getForm();
  const field = (re) => form.getFields().find((f) => re.test(f.getName()));
  field(/f1_01\[/).setText('Sam Sample');
  field(/f1_02\[/).setText('Sample Painting LLC');
  field(/f1_14\[/).setText(TIN.slice(0, 2));
  field(/f1_15\[/).setText(TIN.slice(3));
  const typed = await typedW9(await doc.save());
  assert.equal(typed.name, 'Sam Sample');
  assert.equal(typed.business, 'Sample Painting LLC');
  assert.equal(typed.hasTaxId, true);
  assert.doesNotMatch(JSON.stringify(typed), /\d{2}/, 'no digits of the tax ID anywhere in what comes back');
  const blank = await typedW9(Buffer.from(W9_PDF_BASE64, 'base64'));
  assert.equal(blank, null, 'a blank form says nothing');
  assert.equal(await typedW9(new TextEncoder().encode('%PDF-1.4 not really')), null);
});

// ─── The coverage index ─────────────────────────────────────────────

test('the coverage index: each policy once per file (again: replaced), an exemption as its own row, uploads known by their bytes', async () => {
  const env = { DB: await createD1() };
  const policies = [
    { kind: 'general liability', effective: '2025-03-01', expires: '2026-03-01', insurer: 'Sample Mutual', policyNumber: 'GL-1', eachOccurrence: 1000000, aggregate: 2000000 },
    { kind: 'workers compensation', effective: '2025-03-01', expires: '2026-03-01', employersLiabilityEachAccident: 500000 },
  ];
  assert.equal(await recordCoverage(env, { jtId: 'V4', insured: 'Sample Painting LLC', policies, source: 'gmail', sourceRef: 'gmail:x', fileHash: 'a'.repeat(64), now: NOW }), 2);
  await recordCoverage(env, { jtId: 'V4', insured: 'Sample Painting LLC', policies, source: 'gmail', sourceRef: 'gmail:x', fileHash: 'a'.repeat(64), now: NOW });
  await recordCoverage(env, { insured: 'Solo Tile', exempt: true, source: 'jt', fileHash: 'b'.repeat(64), now: NOW });
  const rows = (await env.DB.prepare('SELECT * FROM coi_coverage ORDER BY file_hash, kind').all()).results;
  assert.deepEqual(rows.map((r) => [r.jt_id, r.kind, r.expires, r.each_cents, r.aggregate_cents, r.exempt]), [
    ['V4', 'gl', '2026-03-01', 100000000, 200000000, 0], ['V4', 'wc', '2026-03-01', 50000000, null, 0], [null, 'exemption', null, null, null, 1],
  ]);
  const bytes = new TextEncoder().encode('%PDF-1.7 an uploaded certificate');
  await recordUpload(env, { jtId: 'V4', insured: 'Sample Painting LLC', verdict: { gl: policies[0], wc: policies[1] }, parts: [{ bytes, name: 'coi.pdf' }], now: NOW });
  const h = await sha256(bytes);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM coi_coverage WHERE file_hash = ? AND source = ?').bind(h, 'upload').first()).n, 2);
  assert.equal((await env.DB.prepare("SELECT state FROM coi_found WHERE file_hash = ?").bind(h).first()).state, 'filed', 'the same bytes found in an inbox later are a duplicate');
});

// ─── A whole run: staff email, JobTread and Workers AI pretended ────

const b64u = (s) => Buffer.from(s).toString('base64url');
const pad = (s, n = 9000) => `${s}${' '.repeat(Math.max(0, n - s.length))}`;
const pdfOf = (marker) => new TextEncoder().encode(pad(`%PDF-1.7 MARK:${marker}`));
const jpgOf = (marker) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(pad(`MARK:${marker}`, 70000)), 0xff, 0xd9]);

// What each pretend file's text says, and how Workers AI reads it
const TEXTS = {
  'sample-coi': `CERTIFICATE OF LIABILITY INSURANCE ACORD 25 ${'line '.repeat(30)} MARK:sample-coi`,
  'sample-old': `CERTIFICATE OF LIABILITY INSURANCE ACORD 25 ${'line '.repeat(30)} MARK:sample-old`,
  'own-coi': `CERTIFICATE OF LIABILITY INSURANCE ACORD 25 ${'line '.repeat(30)} MARK:own-coi`,
  'stranger-coi': `CERTIFICATE OF LIABILITY INSURANCE ACORD 25 ${'line '.repeat(30)} MARK:stranger-coi`,
  'close-coi': `CERTIFICATE OF LIABILITY INSURANCE ACORD 25 ${'line '.repeat(30)} MARK:close-coi`,
  'jt-coi': `CERTIFICATE OF LIABILITY INSURANCE ACORD 25 ${'line '.repeat(30)} MARK:jt-coi`,
  waiver: `2026 Volunteer Release Waiver ${'words '.repeat(40)} MARK:waiver`,
  'typed-w9': `Form W-9 (Rev. March 2024) Request for Taxpayer Identification Number and Certification ${'line '.repeat(30)} MARK:typed-w9`,
  'scrambled-coi': `CERTIFICATE OF LIABILITY INSURANCE ${'@#$ '.repeat(40)} MARK:scrambled-coi`,
};
const coi = (insured, gl, wc, producer = null) => ({
  isCertificate: true, readable: true, insured, certificateHolder: 'Sunshine on a Ranney Day', producer,
  policies: [
    { kind: 'general liability', insurer: 'Sample Mutual', effective: `${Number(gl.slice(0, 4)) - 1}${gl.slice(4)}`, expires: gl, eachOccurrence: 1000000, aggregate: 2000000, policyNumber: 'GL-77' },
    ...(wc ? [{ kind: 'workers compensation', insurer: 'Sample Comp', expires: wc, employersLiabilityEachAccident: 500000 }] : []),
  ],
});
const READS = {
  'sample-coi': coi('Sample Painting LLC', '2027-05-01', '2027-05-01', { name: 'Sample Insurance Agency', contact: 'Amy Agent', email: 'amy@sampleinsure.example', phone: '(404) 555-0100' }),
  'sample-old': coi('Sample Painting LLC', '2025-05-01', '2025-05-01', { name: 'Sample Insurance Agency', email: 'amy@sampleinsure.example' }),
  'own-coi': coi('Sunshine on a Ranney Day, Inc.', '2027-01-01', null),
  'stranger-coi': coi('Nobody We Know Roofing', '2027-01-01', '2027-01-01'),
  'close-coi': coi('Sample Tiling Co', '2027-02-01', null),
  'jt-coi': coi('Example Hauling LLC', '2027-08-01', '2027-08-01'),
  'typed-w9-page': { isW9: true, readable: true, name: 'Sam Sample', businessName: 'Sample Painting LLC', hasTaxId: true, signed: true },
  'scrambled-coi-page': coi('Sample Painting LLC', '2027-09-01', '2027-09-01'),
  'w9-photo': { isW9: true, readable: true, name: 'Sam Sample', businessName: 'Sample Painting LLC', hasTaxId: true, signed: true, signedDate: '2024-02-01' },
};
const markerIn = (s) => /MARK:([\w-]+)/.exec(s)?.[1];

let env, world, store;
function mail({ box, at, from, subject, text = '', files = [] }) {
  const n = store.length + 1;
  const parts = [
    { partId: '0', mimeType: 'text/plain', headers: [], body: { data: b64u(text), size: text.length } },
    ...files.map((f, i) => ({ partId: String(i + 1), mimeType: f.type, filename: f.name, headers: [{ name: 'Content-Disposition', value: f.inline ? 'inline' : 'attachment' }], body: { attachmentId: `att-${n}-${i}`, size: f.data.length } })),
  ];
  const m = { box, id: `msg${String(n).padStart(4, '0')}`, threadId: `th${n}`, internalDate: String(at), payload: { partId: '', mimeType: 'multipart/mixed', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }], parts }, files };
  store.push(m);
  return m;
}

function pretendFetch(url, init = {}) {
  // Like Cloudflare's fetch: called as some object's method, it refuses
  if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
  const u = new URL(typeof url === 'string' ? url : url.url);
  if (u.href === 'https://oauth2.googleapis.com/token') {
    const sub = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url')).sub;
    return Response.json({ access_token: `tok:${sub}`, expires_in: 3600 });
  }
  if (u.host === 'gmail.googleapis.com') {
    const box = /tok:(.*)$/.exec(init.headers.Authorization)[1];
    world.gmail.push(u.pathname);
    const mine = store.filter((m) => m.box === box);
    const att = /\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(u.pathname);
    if (att) {
      const m = mine.find((x) => x.id === att[1]);
      const i = Number(decodeURIComponent(att[2]).split('-')[2]);
      return Response.json({ data: Buffer.from(m.files[i].data).toString('base64url') });
    }
    const one = /\/messages\/([^/]+)$/.exec(u.pathname);
    if (one && one[1] !== 'messages') return Response.json(mine.find((x) => x.id === one[1]));
    world.searches.push(u.searchParams.get('q'));
    return Response.json({ messages: mine.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: mine.length });
  }
  if (u.host === 'uploads.jobtread.example') { world.uploads.push(init.body.byteLength); world.lastUpload = init.body; return new Response('', { status: 200 }); }
  if (u.host === 'files.jobtread.example') return new Response(world.jtFileBytes[u.pathname.slice(1)]);
  if (u.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    world.jt.push(Object.keys(query)[0]);
    if (query.organization?.customFields) return Response.json({ organization: { customFields: { nodes: world.fields }, contactFields: { nodes: [{ id: 'VC-EMAIL', name: 'Email', type: 'emailAddress' }, { id: 'VC-PHONE', name: 'Phone', type: 'phoneNumber' }] }, fileTags: { nodes: world.tags } } });
    if (query.organization?.accounts) {
      world.accountPages++;
      return Response.json({ organization: { accounts: { nextPage: null, nodes: Object.entries(world.vendors).map(([id, v]) => ({ id, name: v.name, archivedAt: null, files: { nodes: v.files.map((f) => ({ ...f, fileTags: { nodes: f.tags.map((t) => ({ id: t })) } })) } })) } } });
    }
    if (query.updateCustomField) return Response.json({});
    if (query.file) return Response.json({ file: { id: query.file.$.id, url: `https://files.jobtread.example/${query.file.$.id}` } });
    if (query.account) {
      const id = query.account.$.id;
      const v = world.vendors[id];
      const contact = (c) => ({ id: c.id, name: c.name, title: c.title, customFieldValues: { nodes: [{ value: c.email, customField: { id: 'VC-EMAIL', type: 'emailAddress' } }] } });
      return Response.json({
        account: {
          id, name: v.name, type: 'vendor', archivedAt: null,
          customFieldValues: { nodes: Object.entries(v.values).map(([fid, value]) => ({ value, customField: { id: fid } })) },
          primaryContact: v.primary ? { id: v.primary, customFieldValues: { nodes: [] } } : null,
          contacts: { nodes: v.contacts.map(contact) },
          files: { nodes: v.files.map((f) => ({ ...f, fileTags: { nodes: f.tags.map((t) => ({ id: t })) } })) },
        },
      });
    }
    if (query.updateAccount) {
      const { id, customFieldValues, primaryContactId } = query.updateAccount.$;
      world.updates.push(query.updateAccount.$);
      Object.assign(world.vendors[id].values, customFieldValues || {});
      if (primaryContactId !== undefined) world.vendors[id].primary = primaryContactId;
      return Response.json({});
    }
    if (query.createContact) {
      const { accountId, name, title, customFieldValues } = query.createContact.$;
      // JobTread refuses a family's (customerContact) Email on a vendor's contact
      if ('22NJw43QvHeJ' in customFieldValues) return new Response('A customField isn’t valid for this contact', { status: 400 });
      const c = { id: `CON${++world.seq}`, name, title, email: customFieldValues['VC-EMAIL'], phone: customFieldValues['VC-PHONE'] || null };
      world.vendors[accountId].contacts.push(c);
      if (world.autoPrimary && !world.vendors[accountId].primary) world.vendors[accountId].primary = c.id;
      world.contacts.push({ accountId, ...c });
      return Response.json({ createContact: { createdContact: { id: c.id } } });
    }
    if (query.createComment) { world.notes.push(query.createComment.$); return Response.json({ createComment: { createdComment: { id: 'N1' } } }); }
    if (query.createUploadRequest) return Response.json({ createUploadRequest: { createdUploadRequest: { id: `U${++world.seq}`, url: 'https://uploads.jobtread.example/put', method: 'PUT', headers: {} } } });
    if (query.createFile) {
      const f = query.createFile.$;
      world.created.push(f);
      const id = `FILE${++world.seq}`;
      world.jtFileBytes[id] = world.lastUpload;
      world.vendors[f.targetId].files.push({ id, name: f.name, type: 'application/pdf', size: world.lastUpload?.byteLength, folder: f.folder, tags: f.fileTagIds });
      return Response.json({ createFile: { createdFile: { id } } });
    }
    if (query.updateFile) {
      world.tagged.push(query.updateFile.$);
      for (const v of Object.values(world.vendors)) for (const f of v.files) if (f.id === query.updateFile.$.id) f.tags = query.updateFile.$.fileTagIds;
      return Response.json({});
    }
    throw new Error(`JobTread doesn't know ${JSON.stringify(Object.keys(query))}`);
  }
  throw new Error(`Unexpected ${u.href}`);
}

// Workers AI's JSON mode on the text model leaves out a word the schema doesn't require (Oct 30 2026: every
// certificate's insured came back missing, so none could be matched)
const asJsonMode = (a, rf) => (rf?.json_schema && a ? Object.fromEntries(Object.entries(a).filter(([k]) => rf.json_schema.required?.includes(k) || rf.json_schema.properties?.[k]?.type !== 'string')) : a);

const AI = {
  async toMarkdown({ blob }) {
    world.ai.push('text');
    const marker = markerIn(Buffer.from(await blob.arrayBuffer()).toString('latin1'));
    return { format: 'text', data: TEXTS[marker] || '' };
  },
  async run(model, { messages, response_format }) {
    const user = messages[1].content;
    if (/You match the company/.test(messages[0].content)) {
      world.ai.push('match');
      return { response: typeof world.matchAnswer === 'function' ? world.matchAnswer(user) : world.matchAnswer };
    }
    if (Array.isArray(user)) {
      world.ai.push('vision');
      const marker = markerIn(Buffer.from(user[1].image_url.url.split(',')[1], 'base64').toString('latin1'));
      return { response: /W-9/.test(messages[0].content) ? (READS[marker]?.isW9 ? READS[marker] : { isW9: false, hasTaxId: false }) : (READS[marker]?.isCertificate ? READS[marker] : { isCertificate: false, policies: [] }) };
    }
    world.ai.push('read');
    return { response: asJsonMode(READS[markerIn(user)] || { isCertificate: false, policies: [] }, response_format) };
  },
};

beforeEach(async () => {
  clearTokenCache();
  store = [];
  world = {
    seq: 0, gmail: [], searches: [], jt: [], ai: [], uploads: [], created: [], updates: [], notes: [], contacts: [], tagged: [], accountPages: 0,
    matchAnswer: { pick: 1, sure: true }, autoPrimary: true, jtFileBytes: {}, drawn: [],
    draw: async () => [],
    fields: [
      { id: 'F-W9', name: 'W-9', type: 'boolean' }, { id: 'F-GL', name: 'Liability Expires', type: 'date' }, { id: 'F-WC', name: 'Workers\' Comp Expires', type: 'date' },
      { id: 'F-DOCS', name: 'Documents', type: 'option', options: [] }, { id: 'F-CHECK', name: 'Insurance Check', type: 'text' }, { id: 'F-TRADES', name: 'Trades', type: 'option', options: [], maxValuesAllowed: null },
      { id: 'F-ADDR', name: 'Address', type: 'text' }, { id: 'F-LIC', name: 'License', type: 'text' }, { id: 'F-MAT', name: 'Materials only', type: 'boolean' },
    ],
    tags: [{ id: 'T-W9', name: 'W-9' }, { id: 'T-COI', name: 'COI' }],
    vendors: {
      VSAMPLE: { name: 'Sample Painting LLC', values: {}, contacts: [], files: [], primary: null },
      VTILE: { name: 'Sample Tile', values: {}, contacts: [], files: [], primary: null },
      VHAUL: { name: 'Example Hauling', values: {}, contacts: [], files: [], primary: null },
    },
  };
  env = { DB: await createD1(), GOOGLE_CALENDAR_KEY: SERVICE_ACCOUNT, JOBTREAD_GRANT_KEY: 'grant-main', AI };
  await env.DB.exec('CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ ok: true, accounts: ACCOUNTS })).run();
  await ensureVendorSchema(env.DB);
  for (const [id, v] of Object.entries(world.vendors)) {
    await env.DB.prepare('INSERT INTO vendors (id, name, jt_id, facts) VALUES (?, ?, ?, ?)').bind(`jt_${id}`, v.name, id, JSON.stringify({ jobs: [], emails: [] })).run();
  }
});

/** Runs until there's nothing left to find or read (each a minute apart) */
async function runAll(max = 40) {
  let t = NOW;
  for (let i = 0; i < max; i++) {
    await maybeRunBackfill(env, { now: t, fetchImpl: pretendFetch, draw: world.draw });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM coi_found WHERE state IN ('queued', 'failed', 'working')").first();
    const st = JSON.parse((await env.DB.prepare('SELECT data FROM spend_state WHERE key = ?').bind(STATE_KEY).first()).data);
    if (!left.n && st.busy === false) return st;
    t += 60e3;
  }
  throw new Error('never finished');
}

const rowsByName = async () => Object.fromEntries(((await env.DB.prepare("SELECT name, state, detail, kind, jt_id FROM coi_found WHERE item = 'file'").all()).results || []).map((r) => [r.name, r]));

test('a run finds certificates in staff email, reads each file once, files a match, and leaves SOARD’s own and strangers’ out', async () => {
  const agent = 'Amy Agent <amy@sampleinsure.example>';
  mail({ box: PAT, at: NOW - 30 * DAY, from: agent, subject: 'Renewal COI - Sample Painting LLC', files: [
    { name: 'Sample Painting COI 2026.pdf', type: 'application/pdf', data: pdfOf('sample-coi') },
    { name: 'image001.png', type: 'image/png', data: new Uint8Array(20000), inline: true },
  ] });
  // The same certificate, forwarded to Sam
  mail({ box: SAM, at: NOW - 29 * DAY, from: 'Pat Lee <pat@soardcharity.com>', subject: 'Fwd: Renewal COI - Sample Painting LLC', files: [{ name: 'Sample Painting COI 2026.pdf', type: 'application/pdf', data: pdfOf('sample-coi') }] });
  // Last year's, from the painter's own office
  mail({ box: PAT, at: NOW - 400 * DAY, from: 'Sam Sample <office@samplepainting.example>', subject: 'our COI', files: [{ name: 'COI 2024.pdf', type: 'application/pdf', data: pdfOf('sample-old') }] });
  mail({ box: SAM, at: NOW - 60 * DAY, from: 'Venue <events@venue.example>', subject: 'COI for the gala', files: [{ name: 'SOARD event COI.pdf', type: 'application/pdf', data: pdfOf('own-coi') }] });
  mail({ box: SAM, at: NOW - 61 * DAY, from: 'Roofer <bids@roofer.example>', subject: 'certificate of insurance', files: [{ name: 'roofing coi.pdf', type: 'application/pdf', data: pdfOf('stranger-coi') }] });
  mail({ box: PAT, at: NOW - 62 * DAY, from: 'Volunteer <v@example.org>', subject: 'workers comp waiver', files: [{ name: 'waiver.pdf', type: 'application/pdf', data: pdfOf('waiver') }] });
  mail({ box: PAT, at: NOW - 70 * DAY, from: 'Sam Sample <office@samplepainting.example>', subject: 'W9 attached', files: [{ name: 'IMG_0420.jpg', type: 'image/jpeg', data: jpgOf('w9-photo') }] });

  const st = await runAll();
  assert.equal(st.busy, false);
  assert.ok(world.searches.every((q) => q.startsWith(MAIL_WORDS) && /after:\d+$/.test(q)), 'every inbox searched with the words, since 4 years ago');
  const rows = await rowsByName();
  assert.equal(rows['image001.png'], undefined, 'the signature logo isn’t even fetched');
  const states = ((await env.DB.prepare("SELECT state FROM coi_found WHERE item = 'file'").all()).results || []).map((r) => r.state).sort();
  assert.deepEqual(states, ['duplicate', 'filed', 'filed', 'filed', 'own', 'skipped', 'unmatched'], 'the forwarded copy is a duplicate of the one in Pat’s inbox');
  assert.equal(rows['waiver.pdf'].state, 'skipped');
  assert.match(rows['waiver.pdf'].detail, /its text says so/);
  assert.equal(rows['SOARD event COI.pdf'].state, 'own');
  assert.equal(rows['roofing coi.pdf'].state, 'unmatched');
  assert.equal(world.ai.filter((x) => x === 'read').length, 4, 'four certificates read by the model; the copy and the waiver never');

  // Filed once, tagged, in the folder; the dates are the newer certificate's, whichever was read first
  const coiFiles = world.created.filter((f) => f.fileTagIds.includes('T-COI'));
  assert.equal(coiFiles.length, 2, 'this year’s and last year’s certificates, each once');
  assert.ok(coiFiles.every((f) => f.folder === 'W-9 & Insurance' && f.targetId === 'VSAMPLE'));
  assert.ok(coiFiles.some((f) => f.name === 'COI Sample Painting LLC 2026-05-01 to 2027-05-01.pdf'));
  const v = world.vendors.VSAMPLE.values;
  assert.equal(v['F-GL'], '2027-05-01');
  assert.equal(v['F-WC'], '2027-05-01');
  assert.equal(v['F-W9'], true, 'the W-9 photo checked out and ticked W-9');
  assert.ok(world.created.some((f) => f.fileTagIds.includes('T-W9')));
  assert.ok(!world.updates.some((u) => u.customFieldValues?.['F-GL'] === '2025-05-01'), 'last year’s never moves a date back');

  // The people: the agency for renewals, the painter's office as main contact (never the primary agent)
  const people = world.vendors.VSAMPLE.contacts;
  assert.deepEqual(people.map((c) => [c.title, c.email]).sort(), [['Insurance agent', 'amy@sampleinsure.example'], ['Main contact', 'office@samplepainting.example']]);
  assert.equal(world.vendors.VSAMPLE.primary, people.find((c) => c.title === 'Main contact').id);
  const profile = await env.DB.prepare("SELECT agent FROM vendor_profiles WHERE jt_id = 'VSAMPLE'").first();
  assert.equal(JSON.parse(profile.agent).email, 'amy@sampleinsure.example');
  assert.equal(JSON.parse(profile.agent).open, false, 'not asked yet: renewals ask when it’s time');
  const cache = await env.DB.prepare("SELECT email, facts FROM vendors WHERE jt_id = 'VSAMPLE'").first();
  assert.deepEqual(JSON.parse(cache.facts).emails, ['office@samplepainting.example'], 'the office can sign in now; the agent can’t');

  // Notes say where each was found
  const notes = world.notes.filter((n) => n.targetId === 'VSAMPLE').map((n) => n.message);
  assert.ok(notes.some((m) => /^Certificate of insurance from Sample Insurance Agency, found in Pat Lee’s email from September 2026: general liability \(\$1,000,000 each occurrence\) through May 1, 2027/.test(m)), notes.join('\n'));
  assert.ok(notes.every((m) => !/—/.test(m)), 'no em dashes');

  // The coverage index: matched and not
  const cov = (await env.DB.prepare('SELECT jt_id, insured, kind, expires FROM coi_coverage ORDER BY insured, expires, kind').all()).results;
  assert.deepEqual(cov.map((r) => [r.jt_id, r.kind, r.expires]), [
    [null, 'gl', '2027-01-01'], [null, 'wc', '2027-01-01'],
    ['VSAMPLE', 'gl', '2025-05-01'], ['VSAMPLE', 'wc', '2025-05-01'], ['VSAMPLE', 'gl', '2027-05-01'], ['VSAMPLE', 'wc', '2027-05-01'],
  ]);

  const status = await backfillStatus(env);
  assert.deepEqual({ filed: status.filed, unmatched: status.unmatched, own: status.own }, { filed: { coi: 2, w9: 1, vendors: 1 }, unmatched: 1, own: 1 });

  // Six hours on: only new mail, from a day before the last look
  world.searches = [];
  for (let i = 0; i < 4 && !world.searches.length; i++) await maybeRunBackfill(env, { now: NOW + 7 * 3600e3 + i * 60e3, fetchImpl: pretendFetch });
  const after = Number(/after:(\d+)$/.exec(world.searches[0])[1]) * 1000;
  assert.ok(after > NOW - 2 * DAY && after < NOW, 'the next look starts a day before the first one did');
});

test('a close name is Workers AI’s to pick, and only a sure pick is filed', async () => {
  mail({ box: PAT, at: NOW - DAY, from: 'Tiler <t@tiles.example>', subject: 'COI', files: [{ name: 'tile coi.pdf', type: 'application/pdf', data: pdfOf('close-coi') }] });
  world.matchAnswer = { pick: 1, sure: false };
  await runAll();
  assert.equal((await rowsByName())['tile coi.pdf'].state, 'unmatched');
  assert.equal(world.ai.filter((x) => x === 'match').length, 1);
  assert.equal(world.created.length, 0);

  await env.DB.exec("DELETE FROM coi_found; DELETE FROM coi_coverage; DELETE FROM spend_state");
  // The model is shown each close name, numbered, and picks the tile company
  world.matchAnswer = (u) => ({ pick: u.split('\n').filter((l) => /^\d+\. /.test(l)).findIndex((l) => /Tile/.test(l)) + 1, sure: true });
  await runAll();
  const row = (await rowsByName())['tile coi.pdf'];
  assert.equal(row.state, 'filed');
  assert.equal(row.jt_id, 'VTILE');
  assert.match(row.detail, /\(ai\)$/);
});

test('an untagged file on a JobTread vendor is tagged where it is, never uploaded again; an agent alone never becomes the primary contact', async () => {
  const bytes = pdfOf('jt-coi');
  world.jtFileBytes.FJT1 = bytes;
  world.vendors.VHAUL.files.push({ id: 'FJT1', name: 'insurance cert.pdf', type: 'application/pdf', size: bytes.length, folder: null, tags: [], createdAt: '2025-08-02T12:00:00Z' });
  world.vendors.VHAUL.files.push({ id: 'FJT2', name: 'job photo.jpg', type: 'image/jpeg', size: 400000, folder: null, tags: [], createdAt: '2025-08-02T12:00:00Z' });
  READS['jt-coi'] = coi('Example Hauling LLC', '2027-08-01', '2027-08-01', { name: 'Hauler Insurance', email: 'agent@haulerinsure.example' });
  await runAll();
  assert.deepEqual(world.tagged, [{ id: 'FJT1', fileTagIds: ['T-COI'], folder: 'W-9 & Insurance' }]);
  assert.equal(world.created.length, 0);
  assert.equal(world.uploads.length, 0);
  assert.equal(world.vendors.VHAUL.values['F-GL'], '2027-08-01');
  assert.equal((await rowsByName())['job photo.jpg'], undefined, 'a photo nothing calls insurance isn’t read');
  assert.equal(world.vendors.VHAUL.primary, null, 'JobTread made the agent primary; the site took it back');
  assert.match(world.notes.find((n) => n.targetId === 'VHAUL').message, /found in this vendor’s JobTread files \(insurance cert\.pdf\), where it wasn’t tagged/);
});

test('a W-9 on a vendor’s JobTread account naming its owner, not a vendor, is filed there', async () => {
  world.vendors.VHAUL.files.push({ id: 'FJTW9', name: 'W9.jpg', type: 'image/jpeg', size: 70010, folder: null, tags: [], createdAt: '2025-08-02T12:00:00Z' });
  world.jtFileBytes.FJTW9 = jpgOf('jt-w9');
  READS['jt-w9'] = { isW9: true, readable: true, name: 'Pat Example & Lee Example', businessName: '', hasTaxId: true, signed: true, signedDate: '2025-01-10' };
  await runAll();
  const row = (await rowsByName())['W9.jpg'];
  assert.deepEqual([row.state, row.jt_id, row.kind], ['filed', 'VHAUL', 'w9']);
  assert.ok(world.tagged.some((t) => t.id === 'FJTW9' && t.fileTagIds.includes('T-W9')), 'tagged where it is');
  assert.equal(world.vendors.VHAUL.values['F-W9'], true);
});

test('nothing kept holds a tax ID', async () => {
  mail({ box: PAT, at: NOW - 70 * DAY, from: 'Sam Sample <office@samplepainting.example>', subject: 'W9 attached', files: [{ name: 'IMG_0420.jpg', type: 'image/jpeg', data: jpgOf('w9-photo') }] });
  await runAll();
  const dump = JSON.stringify([
    (await env.DB.prepare('SELECT * FROM coi_found').all()).results, (await env.DB.prepare('SELECT * FROM coi_coverage').all()).results,
    (await env.DB.prepare('SELECT * FROM vendor_profiles').all()).results, (await env.DB.prepare('SELECT * FROM spend_state').all()).results,
  ]);
  assert.doesNotMatch(dump, /12-?3456789/);
  assert.ok(world.notes.every((n) => !/\d{2}-?\d{7}/.test(n.message)));
});

test('an inbox Gmail refuses waits an hour while the others are searched', async () => {
  mail({ box: SAM, at: NOW - DAY, from: 'Amy Agent <amy@sampleinsure.example>', subject: 'COI', files: [{ name: 'Sample Painting COI 2026.pdf', type: 'application/pdf', data: pdfOf('sample-coi') }] });
  const refusing = (url, init) => (String(url).includes('gmail.googleapis.com') && /tok:pat@/.test(init?.headers?.Authorization || '')
    ? Response.json({ error: { message: 'Mail service not enabled' } }, { status: 400 }) : pretendFetch(url, init));
  for (let i = 0; i < 6; i++) await maybeRunBackfill(env, { now: NOW + i * 60e3, fetchImpl: refusing, draw: async () => [] });
  const st = JSON.parse((await env.DB.prepare('SELECT data FROM spend_state WHERE key = ?').bind(STATE_KEY).first()).data);
  assert.ok(st.mail[PAT].failedAt, 'Pat’s inbox is waiting');
  assert.ok(st.mail[SAM].doneAt, 'Sam’s was searched meanwhile');
  assert.equal((await rowsByName())['Sample Painting COI 2026.pdf'].state, 'filed');
  assert.deepEqual((await backfillStatus(env)).refused.map((r) => [r.inbox, r.error]), [['pat', 'Gmail answered 400: Mail service not enabled']], 'said in Automations until it reads again');
});

test('a PDF its text can’t settle is drawn and read by its pictures: a W-9 typed on a computer, a certificate whose text is scrambled', async () => {
  world.draw = async (bytes) => {
    const marker = markerIn(Buffer.from(bytes).toString('latin1'));
    world.drawn.push(marker);
    return [{ bytes: jpgOf(`${marker}-page`), type: 'image/jpeg' }];
  };
  mail({ box: PAT, at: NOW - 3 * DAY, from: 'Sam Sample <office@samplepainting.example>', subject: 'W-9', files: [{ name: 'W9 signed.pdf', type: 'application/pdf', data: pdfOf('typed-w9') }] });
  mail({ box: PAT, at: NOW - 4 * DAY, from: 'Sam Sample <office@samplepainting.example>', subject: 'insurance', files: [{ name: 'acord.pdf', type: 'application/pdf', data: pdfOf('scrambled-coi') }] });
  await runAll();
  assert.deepEqual(world.drawn.sort(), ['scrambled-coi', 'typed-w9']);
  const rows = await rowsByName();
  assert.equal(rows['W9 signed.pdf'].state, 'filed');
  assert.equal(rows['acord.pdf'].state, 'filed');
  assert.equal(world.vendors.VSAMPLE.values['F-W9'], true);
  assert.equal(world.vendors.VSAMPLE.values['F-GL'], '2027-09-01');
});

test('files read before the name was required of the model are read again, once', async () => {
  mail({ box: SAM, at: NOW - 61 * DAY, from: 'Roofer <bids@roofer.example>', subject: 'certificate of insurance', files: [{ name: 'roofing coi.pdf', type: 'application/pdf', data: pdfOf('stranger-coi') }] });
  await runAll();
  const row = () => env.DB.prepare("SELECT state, insured, detail FROM coi_found WHERE name = 'roofing coi.pdf'").first();
  assert.equal((await row()).state, 'unmatched');
  // As the model left it before: no name. The code that reads it again arrives with a deploy
  const nameless = () => env.DB.prepare("UPDATE coi_found SET insured = NULL, detail = 'no company name on it' WHERE name = 'roofing coi.pdf'").run();
  await nameless();
  await env.DB.prepare("UPDATE spend_state SET data = json_remove(data, '$.reread') WHERE key = ?").bind(STATE_KEY).run();
  const reads = world.ai.filter((x) => x === 'read').length;
  await maybeRunBackfill(env, { now: NOW + 3600e3, fetchImpl: pretendFetch, force: true, draw: world.draw });
  assert.equal(world.ai.filter((x) => x === 'read').length, reads + 1, 'read again');
  assert.deepEqual({ ...(await row()) }, { state: 'unmatched', insured: 'Nobody We Know Roofing', detail: 'no JobTread vendor by that name' });
  // Once
  await nameless();
  await maybeRunBackfill(env, { now: NOW + 2 * 3600e3, fetchImpl: pretendFetch, force: true, draw: world.draw });
  assert.equal(world.ai.filter((x) => x === 'read').length, reads + 1);
  assert.equal((await row()).insured, null);
});
