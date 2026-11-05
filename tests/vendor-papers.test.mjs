/**
 * W-9s and certificates kept on the site, for every company SOARD pays
 * (functions/api/_vendor-files.js, _vendors.js readVendor/writePapers/staffUpload,
 * vendor-papers-admin.js, the 'papers' link on the trade-partner page)
 * Run: node --test tests/
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { createR2 } from './lib/r2-shim.mjs';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { ensureSpendSchema } from '../functions/api/_spend.js';
import { ensureBillPaySchema } from '../functions/api/_bill-pay.js';
import { MERCURY_BASE, writeState, readState } from '../functions/api/_mercury.js';
import {
  ensureVendorSchema, jtSetup, readVendor, writePapers, createLink, findLink, refreshCache, requestEmail, docsState, saveDocSettings, DEFAULTS, papersUrl,
} from '../functions/api/_vendors.js';
import {
  settlePapers, readPapers, keepFile, filesOf, addSiteVendor, mergeIntoJobTread, importJobTread, findPayees, isSiteVendor, docOfJobTreadFile, keptReading, settleRow,
  savePapers, readFile, sha256,
} from '../functions/api/_vendor-files.js';
import { partnerView, ensurePartnerSchema } from '../functions/api/_trade-partners.js';
import { onRequestGet as adminGet, onRequestPost as adminPost } from '../functions/api/vendor-papers-admin.js';
import { onRequestPost as pagePost } from '../functions/api/vendor-docs.js';
import { onRequestPost as stepPost } from '../functions/api/trade-partner.js';
import { onRequestGet as serveFile } from '../functions/files/[[path]].js';

const NOW = Date.parse('2026-11-02T15:00:00Z');
const DAY = 86400e3;
const VENDOR = 'ACCTKO1';
const PDF = new TextEncoder().encode('%PDF-1.7 a certificate');
const PDF2 = new TextEncoder().encode('%PDF-1.7 another one');
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

// ─── A pretend JobTread, Resend, Slack, Mercury and Ramp ────────────

let world;
const fresh = () => ({
  fields: [
    { id: 'F-W9', name: 'W-9', type: 'boolean' }, { id: 'F-GL', name: 'Liability Expires', type: 'date' }, { id: 'F-WC', name: 'Workers\' Comp Expires', type: 'date' },
    { id: 'F-DOCS', name: 'Documents', type: 'option', options: [] }, { id: 'F-CHECK', name: 'Insurance Check', type: 'text' }, { id: 'F-TRADES', name: 'Trades', type: 'option', options: [], maxValuesAllowed: null },
    { id: 'F-ADDR', name: 'Address', type: 'text' }, { id: 'F-LIC', name: 'License', type: 'text' }, { id: 'F-MAT', name: 'Materials only', type: 'boolean' },
  ],
  tags: [{ id: 'T-W9', name: 'W-9' }, { id: 'T-COI', name: 'COI' }],
  vendors: { [VENDOR]: { name: 'TKO Plumbing', email: 'office@tko.example', values: {}, files: [] } },
  updates: [], comments: [], created: [], contactsMade: [], emails: [], slack: [], ai: null, refuseWrites: false, recipients: [], rampBills: [],
  fileBytes: {}, deleted: [], refuseDelete: false,
});

function account(id) {
  const v = world.vendors[id];
  if (!v) return null;
  const email = { nodes: v.email ? [{ value: v.email, customField: { id: 'VC-EMAIL', type: 'emailAddress' } }] : [] };
  return {
    id, name: v.name, type: 'vendor', archivedAt: v.archivedAt || null,
    customFieldValues: { nodes: Object.entries(v.values).map(([fid, value]) => ({ value, customField: { id: fid } })) },
    primaryContact: { id: 'CON1', title: 'Owner', customFieldValues: email },
    contacts: { nodes: [{ id: 'CON1', name: 'Tom', title: 'Owner', customFieldValues: email },
      ...(v.agent ? [{ id: 'CON3', name: 'Ann', title: 'Insurance agent', customFieldValues: { nodes: [{ value: v.agent, customField: { id: 'VC-EMAIL', type: 'emailAddress' } }] } }] : [])] },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.customFields) return Response.json({ organization: { customFields: { nodes: world.fields }, contactFields: { nodes: [{ id: 'VC-EMAIL', name: 'Email', type: 'emailAddress' }, { id: 'VC-PHONE', name: 'Phone', type: 'phoneNumber' }] }, fileTags: { nodes: world.tags } } });
    if (query.organization?.accounts) {
      const withFiles = !!query.organization.accounts.nodes.files;
      return Response.json({ organization: { accounts: { nextPage: null, nodes: Object.keys(world.vendors).map((id) => ({
        ...account(id),
        contacts: { nodes: account(id).contacts.nodes },
        ...(withFiles ? { files: { nodes: world.vendors[id].files.map((f) => ({ ...f, url: `https://files.jobtread.example/${f.id}`, fileTags: { nodes: (f.tags || []).map((t) => ({ id: t })) } })) } } : {}),
      })) } } });
    }
    if (query.organization?.jobs) return Response.json({ organization: { jobs: { nextPage: null, nodes: [] } } });
    if (query.updateCustomField) return Response.json({});
    if (query.account) return Response.json({ account: account(query.account.$.id) });
    if (query.updateAccount) {
      if (world.refuseWrites) return Response.json({ errors: [{ message: 'JobTread is down' }] }, { status: 503 });
      const { id, customFieldValues } = query.updateAccount.$;
      world.updates.push(query.updateAccount.$);
      Object.assign(world.vendors[id].values, customFieldValues);
      return Response.json({});
    }
    if (query.createComment) { world.comments.push(query.createComment.$); return Response.json({ createComment: { createdComment: { id: 'C1' } } }); }
    if (query.createContact) {
      const { accountId, customFieldValues } = query.createContact.$;
      world.contactsMade.push(query.createContact.$);
      world.vendors[accountId].email ||= customFieldValues['VC-EMAIL'];
      return Response.json({ createContact: { createdContact: { id: 'CON2' } } });
    }
    if (query.createFile || query.createUploadRequest) { world.created.push(query); return Response.json({}); }
    if (query.deleteFile) {
      if (world.refuseDelete) return Response.json({ errors: [{ message: 'You can’t delete that file' }] }, { status: 400 });
      world.deleted.push(query.deleteFile.$.id);
      for (const v of Object.values(world.vendors)) v.files = v.files.filter((f) => f.id !== query.deleteFile.$.id);
      return Response.json({});
    }
    throw new Error(`JobTread doesn't know ${JSON.stringify(Object.keys(query))}`);
  }
  if (url.host === 'files.jobtread.example') return new Response(world.fileBytes[url.pathname.slice(1)] || PDF, { headers: { 'content-type': 'application/pdf' } });
  if (url.host === 'api.resend.com') { world.emails.push(...JSON.parse(init.body)); return Response.json({ data: [{ id: 'em1' }] }); }
  if (url.host === 'slack.com') { world.slack.push(JSON.parse(init.body)); return Response.json({ ok: true, channel: 'CFIN', ts: `${world.slack.length}.1` }); }
  if (url.origin === MERCURY_BASE) {
    if (url.pathname.endsWith('/recipients')) return Response.json({ recipients: world.recipients });
    throw new Error(`Mercury doesn't know ${url.pathname}`);
  }
  if (url.host === 'api.ramp.com') {
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'ramp-token', expires_in: 864000 });
    if (url.pathname.endsWith('/bills')) return Response.json({ data: world.rampBills, page: { next: null } });
    throw new Error(`Ramp doesn't know ${url.pathname}`);
  }
  throw new Error(`unexpected fetch ${url.href}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
beforeEach(async () => {
  world = fresh();
  const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)', 'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)'] });
  env = {
    DB, FILES: createR2(), VENDOR_FILES: createR2(), JOBTREAD_GRANT_KEY: 'jt', RESEND_API_KEY: 're_test', SLACK_BOT_TOKEN: 'xoxb-test',
    AI: { toMarkdown: async () => ({ format: 'text', data: 'ACORD 25 CERTIFICATE OF LIABILITY INSURANCE '.repeat(5) }), run: async () => ({ response: typeof world.ai === 'function' ? world.ai() : world.ai }) },
  };
  await ensureSpendSchema(DB);
  await ensureBillPaySchema(DB);
  await ensureVendorSchema(DB);
  await ensurePartnerSchema(DB);
  await writeSlackConfig(DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
  await env.DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`jt_${VENDOR}`, 'TKO Plumbing', 'tko plumbing', VENDOR, 'office@tko.example', JSON.stringify({ jobs: [{ jobId: 'J1', jobName: 'The Smiths', order: true }], emails: ['office@tko.example'] }), 'x', 'x').run();
});

const coi = (o = {}) => ({
  isCertificate: true, readable: true, insured: 'TKO Plumbing LLC', certificateHolder: 'Sunshine on a Ranney Day',
  policies: [
    { kind: 'general liability', insurer: 'Hartford', effective: '2025-06-21', expires: '2026-06-21', eachOccurrence: 1000000, aggregate: 2000000 },
    { kind: 'workers compensation', insurer: 'Travelers', effective: '2025-06-21', expires: '2026-06-21', employersLiabilityEachAccident: 1000000 },
  ],
  ...o,
});
// A file action as a page opened just now sends it: the file on the company it's on, as it is (a stale page's says otherwise)
const FILE_ACTIONS = new Set(['file', 'remove-file', 'restore-file', 'move-file']);
const asShown = async (body) => {
  if (body instanceof FormData || !FILE_ACTIONS.has(body.action) || 'shownOn' in body) return body;
  const f = await env.DB.prepare('SELECT vendor_id, status FROM vendor_files WHERE id = ?').bind(String(body.fileId)).first().catch(() => null);
  return f ? { ...body, shownOn: f.vendor_id, shownAs: f.status } : body;
};
const admin = async (body, email = 'holly@soardcharity.org') => {
  const sent = await asShown(body);
  return adminPost({ env, data: { userEmail: email }, request: sent instanceof FormData
    ? new Request('https://x.example/api/vendor-papers-admin', { method: 'POST', body: sent })
    : new Request('https://x.example/api/vendor-papers-admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sent) }) }).then((r) => r.json());
};
const adminRead = (q = '') => adminGet({ env, data: { userEmail: 'holly@soardcharity.org' }, request: new Request(`https://x.example/api/vendor-papers-admin${q}`) });
const jtVals = () => world.vendors[VENDOR].values;

// ─── The record and JobTread's fields ───────────────────────────────

test('the first read starts from JobTread’s fields; a hand edit there is taken in; the site’s own change reaches JobTread', async () => {
  Object.assign(jtVals(), { 'F-W9': true, 'F-GL': '2027-03-01', 'F-WC': '2027-03-01', 'F-DOCS': 'Current' });
  let v = await readVendor(env, VENDOR, { now: NOW });
  assert.deepEqual([v.w9, v.glExpires, v.docs], [true, '2027-03-01', 'Current']);
  assert.equal((await readPapers(env.DB, VENDOR)).name, 'TKO Plumbing');
  assert.equal(world.updates.length, 0, 'nothing to write back on a first read');

  // Someone types a new date into JobTread by hand: theirs
  jtVals()['F-GL'] = '2027-09-01';
  v = await readVendor(env, VENDOR, { now: NOW });
  assert.equal(v.glExpires, '2027-09-01');
  assert.equal((await readPapers(env.DB, VENDOR)).glExpires, '2027-09-01');

  // The site changes the record while JobTread is down: kept here, and written there at the next read
  world.refuseWrites = true;
  await writePapers(env, null, VENDOR, { wc: '2027-12-31' }, fetch, { now: NOW });
  assert.equal((await readPapers(env.DB, VENDOR)).wcExpires, '2027-12-31', 'the record has it');
  assert.equal(jtVals()['F-WC'], '2027-03-01', 'JobTread didn’t take it');
  world.refuseWrites = false;
  v = await readVendor(env, VENDOR, { now: NOW });
  assert.equal(v.wcExpires, '2027-12-31', 'never undone by JobTread’s old value');
  assert.equal(jtVals()['F-WC'], '2027-12-31', 'written there now');
});

test('settleRow: a field JobTread shows the same as the site last wrote is the site’s; one it shows differently is a person’s', () => {
  const row = { id: 'A', name: 'A', w9: true, glExpires: '2027-01-01', wcExpires: null, docs: 'Current', check: null, jtSent: { w9: true, gl: '2026-01-01', wc: null, docs: 'Current' } };
  const s = settleRow(row, 'A', { w9: true, gl: '2026-01-01', wc: '2027-05-05', docs: 'Current' }, { name: 'A' }, NOW);
  assert.deepEqual(s.toPush, { gl: '2027-01-01' }, 'the site moved the date; JobTread hasn’t caught up');
  assert.deepEqual(s.took, { wc: '2027-05-05' }, 'a person typed this one in JobTread');
  assert.equal(s.papers.wcExpires, '2027-05-05');
});

test('the 4-hourly JobTread read settles every vendor at once and never writes a vendor that’s already right', async () => {
  Object.assign(jtVals(), { 'F-W9': true, 'F-DOCS': 'W-9 only' });
  world.vendors.V2 = { name: 'Hope Heating', email: null, values: { 'F-GL': '2027-03-18' }, files: [] };
  await refreshCache(env, { now: NOW });
  assert.equal((await readPapers(env.DB, 'V2')).glExpires, '2027-03-18');
  assert.equal((await readPapers(env.DB, VENDOR)).docs, 'W-9 only', 'a person’s choice in JobTread is the start');
  assert.equal(world.updates.length, 0);
});

// ─── The files ──────────────────────────────────────────────────────

test('a file is kept once per company, under a private name the public /files/ route never serves', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const a = await keepFile(env, VENDOR, { doc: 'coi', bytes: PDF, type: 'application/pdf', name: 'COI.pdf', source: 'staff', by: 'holly' }, { now: NOW });
  const b = await keepFile(env, VENDOR, { doc: 'coi', bytes: PDF, type: 'application/pdf', name: 'COI again.pdf', source: 'email' }, { now: NOW });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.file.id, a.file.id);
  assert.equal((await filesOf(env.DB, VENDOR)).length, 1);
  assert.match(a.file.key, /^vendor-docs\/ACCTKO1\/vf_[a-z0-9]{20}\.pdf$/);
  assert.equal(env.VENDOR_FILES.objects.has(a.file.key), true, 'in their own private bucket');
  assert.equal(env.FILES.objects.has(a.file.key), false, 'never in soard-files, which files.sunshineonaranneyday.com serves to anyone');
  const res = await serveFile({ env: { FILES: env.FILES }, params: { path: a.file.key.split('/') }, request: new Request(`https://sunshineonaranneyday.com/files/${a.file.key}`), waitUntil: () => {} });
  assert.equal(res.status, 404, 'never on the public route');
  assert.deepEqual(keptReading('w9', { name: 'Tom', businessName: 'TKO', hasTaxId: true, tin: '12-3456789', signed: true, signedDate: '2026-01-02' }), { name: 'Tom', business: 'TKO', signed: true, signedDate: '2026-01-02' }, 'never a tax ID');
});

// ─── Companies paid outside JobTread ────────────────────────────────

test('a company only on the site: kept once by name, a W-9-only page, and its W-9 kept without JobTread', async () => {
  const one = await addSiteVendor(env, { name: 'Capin Crouse LLP', email: 'billing@capin.example' }, { now: NOW });
  const again = await addSiteVendor(env, { name: 'Capin Crouse, LLP' }, { now: NOW });
  assert.equal(isSiteVendor(one.id), true);
  assert.equal(again.id, one.id, 'the same name is the same company');
  const p = await readPapers(env.DB, one.id);
  assert.equal(p.docs, 'W-9 only');
  assert.equal(docsState({ ...p }, DEFAULTS, { now: NOW }).needs.join(), 'w9', 'a W-9 and nothing else');

  const link = await createLink(env.DB, one.id, { now: NOW });
  const { link: found } = await findLink(env.DB, link.token, NOW);
  assert.equal(found.scope, 'papers');
  const view = await partnerView(env, found, { now: NOW });
  assert.equal(view.scope, 'papers');
  assert.equal(view.company, undefined, 'no company, bank or invoices');
  assert.equal(view.steps.w9, false);
  assert.equal(view.steps.coi, true, 'insurance isn’t asked of them');

  // Their page can't reach the job vendor's steps
  const refused = await stepPost({ env, request: new Request('https://x.example/api/trade-partner', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'bank', token: link.token }) }) });
  assert.equal(refused.status, 403);

  // A W-9 photo from their page: checked, kept, and no JobTread call at all
  world.ai = { isW9: true, readable: true, name: 'Capin Crouse LLP', hasTaxId: true, signed: true, signedDate: '2026-10-01' };
  const body = new FormData();
  body.set('token', link.token); body.set('doc', 'w9'); body.append('file', new File([JPG], 'w9.jpg', { type: 'image/jpeg' }));
  const d = await (await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) })).json();
  assert.equal(d.accepted, true);
  assert.equal(d.done, true);
  assert.equal((await readPapers(env.DB, one.id)).w9, true);
  assert.equal((await readPapers(env.DB, one.id)).docs, 'W-9 only', 'a person’s choice stays');
  assert.equal((await filesOf(env.DB, one.id))[0].source, 'page');
  assert.equal(world.updates.length + world.comments.length + world.created.length, 0, 'JobTread never hears of them');
});

test('the request to a site company asks for the W-9 alone and doesn’t send them to a sign-in they don’t have', () => {
  const state = docsState({ w9: false, docs: 'W-9 only' }, DEFAULTS, { now: NOW });
  const m = requestEmail({ vendorName: 'Capin Crouse LLP', url: 'https://x.example/trade-partners/account/#t=abc', state, site: true });
  assert.equal(m.subject, 'Your W-9 for Sunshine on a Ranney Day');
  assert.match(m.text, /We keep a W-9 on file for every company we pay/);
  assert.match(m.text, /Send it here: https/);
  assert.doesNotMatch(m.text, /sign in|certificate/i);
});

test('a site company that turns out to be a JobTread vendor: files and the later dates move over; its link stops, never widened', async () => {
  Object.assign(jtVals(), { 'F-GL': '2026-01-01' });
  await readVendor(env, VENDOR, { now: NOW });
  const s = await addSiteVendor(env, { name: 'TKO Plumbing Services' }, { now: NOW });
  await keepFile(env, s.id, { doc: 'w9', bytes: PDF2, type: 'application/pdf', name: 'W9.pdf', source: 'ramp' }, { now: NOW });
  const { savePapers } = await import('../functions/api/_vendor-files.js');
  await savePapers(env, s.id, { w9: true, gl: '2027-02-02' }, { now: NOW });
  const link = await createLink(env.DB, s.id, { now: NOW });
  const merged = await mergeIntoJobTread(env, s.id, VENDOR, { now: NOW });
  assert.equal(merged.w9, true);
  assert.equal(merged.glExpires, '2027-02-02', 'the later date');
  assert.equal((await filesOf(env.DB, VENDOR)).length, 1);
  assert.equal(await readPapers(env.DB, s.id), null);
  const { link: moved, problem } = await findLink(env.DB, link.token, NOW);
  assert.deepEqual([problem, moved.vendor_id, moved.scope], ['closed', s.id, 'papers'], 'the link that went to them stops: it never opens the vendor’s whole page');
  // The name it had is the vendor's now: the payee search never makes it a company again
  const { jobtreadNamed } = await import('../functions/api/_vendor-files.js');
  assert.deepEqual(await jobtreadNamed(env.DB, 'TKO Plumbing Services'), { jtId: VENDOR, name: 'TKO Plumbing' });
});

test('everyone paid through Mercury or Ramp who isn’t a JobTread vendor becomes a W-9-only company, once', async () => {
  env.MERCURY_API_TOKEN = 'secret-token:test';
  env.MERCURY_RELAY_KEY = 'relay';
  env.RAMP_CLIENT_ID = 'id';
  env.RAMP_CLIENT_SECRET = 'secret';
  world.recipients = [
    { id: 'rec1', name: 'Wiggins Childs Pantazis Fisher & Goldfarb', status: 'active', emails: ['ap@wiggins.example'] },
    { id: 'rec2', name: 'TKO Plumbing', status: 'active' },
    { id: 'rec3', name: 'Georgia Department of Revenue', status: 'active' },
  ];
  const amount = (dollars) => ({ amount: dollars * 100, minor_unit_conversion_rate: 100, currency_code: 'USD' });
  world.rampBills = [
    { id: 'b1', vendor: { id: 'rv1', name: 'Adult Big Wheel Club' }, amount: amount(250), issued_at: '2026-09-01', status: 'PAID' },
    { id: 'b3', vendor: { id: 'rv1', name: 'Adult Big Wheel Club' }, amount: amount(400), issued_at: '2026-08-01', status: 'OPEN' },
    { id: 'b0', vendor: { id: 'rv1', name: 'Adult Big Wheel Club' }, amount: amount(100), issued_at: '2025-01-01', status: 'PAID' },
    { id: 'b2', vendor: { id: 'rv2', name: 'TKO Plumbing LLC' }, amount: amount(900), issued_at: '2026-10-01', status: 'PAID' },
  ];
  const r = await findPayees(env, { now: NOW, force: true });
  assert.equal(r.made, 3, 'the state is tracked too (a person marks it Nothing)');
  const site = (await env.DB.prepare("SELECT name, email, docs, payee FROM vendor_papers WHERE id LIKE 's\\_%' ESCAPE '\\' ORDER BY name").all()).results;
  assert.deepEqual(site.map((x) => [x.name, x.email, x.docs]), [['Adult Big Wheel Club', null, 'W-9 only'], ['Georgia Department of Revenue', null, 'W-9 only'], ['Wiggins Childs Pantazis Fisher & Goldfarb', 'ap@wiggins.example', 'W-9 only']]);
  assert.deepEqual(JSON.parse(site[0].payee), { mercury: null, ramp: 'rv1', cents12: 25000, last: '2026-09-01' }, 'what Ramp paid them in the last year (paid bills only), and when last');
  const list = (await (await adminRead()).json()).list;
  assert.deepEqual(list[0].name, 'Adult Big Wheel Club', 'who SOARD pays most comes first');
  assert.equal(list[0].paid, 25000);
  assert.equal(await findPayees(env, { now: NOW + 60e3 }), null, 'daily');
  assert.equal((await findPayees(env, { now: NOW + 2 * DAY })).made, 0, 'never twice');
});

// ─── Once: JobTread's old files ─────────────────────────────────────

test('JobTread’s W-9 & Insurance files are copied here once, with what the certificate search read from the same bytes', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  world.vendors[VENDOR].files = [
    { id: 'F1', name: 'COI TKO 2026.pdf', folder: 'W-9 & Insurance', size: PDF.length, createdAt: '2026-05-22T12:00:00Z', tags: ['T-COI'] },
    { id: 'F2', name: 'W9 2026.pdf', folder: 'W-9 & Insurance', size: PDF2.length, createdAt: '2026-05-22T12:00:00Z', tags: [] },
    { id: 'F3', name: 'kitchen.jpg', folder: null, size: 4000, createdAt: '2026-05-22T12:00:00Z', tags: [] },
  ];
  world.fileBytes = { F1: PDF, F2: PDF2 };
  const { sha256 } = await import('../functions/api/_vendor-files.js');
  const { ensureCoverageSchema, recordCoverage } = await import('../functions/api/_coi-backfill.js');
  await ensureCoverageSchema(env.DB);
  await recordCoverage(env, { jtId: VENDOR, insured: 'TKO', policies: coi().policies, source: 'gmail', fileHash: await sha256(PDF), now: NOW });
  const ids = await jtSetup(env);
  const r = await importJobTread(env, { now: NOW, tags: ids.tags });
  assert.deepEqual([r.files, r.removed, r.done], [2, 2, true]);
  assert.deepEqual(world.deleted.sort(), ['F1', 'F2'], 'JobTread’s copies are taken out once the site’s match them');
  assert.deepEqual(world.vendors[VENDOR].files.map((f) => f.id), ['F3'], 'a file that isn’t a W-9 or certificate stays');
  const files = await filesOf(env.DB, VENDOR);
  assert.deepEqual(files.map((f) => [f.doc, f.source, f.status]).sort(), [['coi', 'jobtread', 'kept'], ['w9', 'jobtread', 'kept']]);
  assert.equal(files.find((f) => f.doc === 'coi').reading.policies[0].expires, '2026-06-21');
  assert.equal(await importJobTread(env, { now: NOW + 60e3, tags: ids.tags }), null, 'a pass is done');
  // Someone files another one in JobTread by hand: the next pass, 6 hours on, moves it too
  world.fileBytes.F4 = new TextEncoder().encode('%PDF-1.7 the renewal');
  world.vendors[VENDOR].files.push({ id: 'F4', name: 'COI 2027.pdf', folder: 'W-9 & Insurance', size: world.fileBytes.F4.length, createdAt: '2026-11-02T12:00:00Z', tags: ['T-COI'] });
  const again = await importJobTread(env, { now: NOW + 7 * 3600e3, tags: ids.tags });
  assert.deepEqual([again.files, again.removed], [1, 1]);
  assert.equal(docOfJobTreadFile({ name: 'ACORD.pdf', folder: 'W-9 & Insurance', fileTags: { nodes: [] } }, ids.tags), 'coi');
  assert.equal(docOfJobTreadFile({ name: 'invoice.pdf', folder: null, fileTags: { nodes: [] } }, ids.tags), null);
});

// ─── Job Costs → W-9s & insurance ───────────────────────────────────

test('the admin lists every company with where it stands, and an expired certificate staff add says Expired', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  await addSiteVendor(env, { name: 'ARTIS Collective' }, { now: NOW });
  let j = await (await adminRead()).json();
  assert.equal(j.success, true);
  assert.deepEqual(j.list.map((r) => [r.name, r.label, r.need, r.site]), [['ARTIS Collective', 'Missing', 'W-9 only', true], ['TKO Plumbing', 'Missing', null, false]], '"W-9 only" with no W-9 yet is still Missing');
  assert.equal(j.list[1].jobs, 1);

  // A certificate that ended in June: kept, and the dates say so
  world.ai = coi();
  const form = new FormData();
  form.set('id', VENDOR); form.set('doc', 'coi'); form.append('file', new File([PDF], 'Stearns COI.pdf', { type: 'application/pdf' }));
  j = await admin(form);
  assert.equal(j.success, true);
  assert.equal(j.result.accepted, false);
  assert.match(j.result.problems.join(' '), /ended June 21, 2026/);
  assert.deepEqual([j.result.changed.gl, j.result.changed.wc], ['2026-06-21', '2026-06-21']);
  assert.equal(j.vendor.label, 'Expired');
  assert.equal(j.vendor.files[0].status, 'kept');
  assert.equal(j.vendor.files[0].addedBy, 'holly@soardcharity.org');
  assert.equal(jtVals()['F-GL'], '2026-06-21', 'JobTread shows it');
  assert.equal(jtVals()['F-DOCS'], 'Expired');

  // The file opens for staff, private and never cached
  const res = await adminRead(`?file=${j.vendor.files[0].id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/pdf');
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PDF]);

  // A person's word: Not needed, then back
  j = await admin({ action: 'set', id: VENDOR, docs: 'Not needed' });
  assert.equal(j.vendor.label, 'Not needed');
  assert.equal(jtVals()['F-DOCS'], 'Not needed');
  j = await admin({ action: 'set', id: VENDOR, docs: null });
  assert.equal(j.vendor.label, 'Expired');
  j = await admin({ action: 'set', id: VENDOR, gl: 'June 2027' });
  assert.equal(j.success, false);
});

test('staff can copy a company’s link and send the request themselves, even while the site’s own asking is off', async () => {
  await saveDocSettings(env.DB, { asking: false });
  await readVendor(env, VENDOR, { now: NOW });
  let j = await admin({ action: 'link', id: VENDOR });
  assert.match(j.url, /\/trade-partners\/account\/#t=/);
  j = await admin({ action: 'ask', id: VENDOR });
  assert.equal(j.success, true);
  assert.equal(j.sent, 'office@tko.example');
  assert.equal(world.emails.length, 1);
  assert.match(world.emails[0].subject, /W-9 and certificate of insurance/);
  j = await admin({ action: 'set', id: VENDOR, w9: true, gl: '2027-06-01', wc: '2027-06-01' });
  assert.equal(j.vendor.label, 'Current');
  j = await admin({ action: 'ask', id: VENDOR });
  assert.equal(j.success, false, 'nothing to ask for');
  assert.match(papersUrl(VENDOR), /#job-costs\/papers\/ACCTKO1$/);
});

test('a file taken off a company is out of sight but never lost; one on the wrong company moves to the right one', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const { file } = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF, type: 'application/pdf', name: 'W9.pdf', source: 'staff' }, { now: NOW });
  const j = await admin({ action: 'remove-file', fileId: file.id });
  assert.equal(j.success, true);
  assert.equal(j.vendor.files.length, 0);
  assert.equal(env.VENDOR_FILES.objects.has(file.key), true, 'the bytes stay: it may be the only copy anywhere');
  const audit = (await env.DB.prepare('SELECT action, entity_type, entity_name FROM audit_log').all()).results;
  assert.deepEqual(audit.map((a) => [a.action, a.entity_type, a.entity_name]), [['updated', 'vendor-file', 'Taken off: W9.pdf']]);
  // It belonged to another company: moved there, as a certificate
  const other = await addSiteVendor(env, { name: 'Wiggins Law Group' }, { now: NOW });
  const m = await admin({ action: 'move-file', fileId: file.id, toId: other.id, doc: 'coi' });
  assert.equal(m.success, true);
  const theirs = (await (await adminRead(`?id=${other.id}`)).json()).vendor.files;
  assert.deepEqual(theirs.map((f) => [f.doc, f.status]), [['coi', 'kept']]);
});

test('JobTread refusing a delete stops the deleting, keeps the copies and says why; a day on it’s tried again', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  world.vendors[VENDOR].files = [{ id: 'F1', name: 'W9.pdf', folder: 'W-9 & Insurance', size: PDF.length, createdAt: '2026-05-22T12:00:00Z', tags: [] }];
  world.fileBytes = { F1: PDF };
  world.refuseDelete = true;
  const ids = await jtSetup(env);
  const r = await importJobTread(env, { now: NOW, tags: ids.tags });
  assert.deepEqual([r.files, r.removed], [1, 0]);
  assert.equal((await filesOf(env.DB, VENDOR)).length, 1, 'kept here all the same');
  const { readState } = await import('../functions/api/_mercury.js');
  assert.match((await readState(env.DB, 'vendor-papers')).import.deleteError.error, /can’t delete/);
  world.refuseDelete = false;
  assert.equal(await importJobTread(env, { now: NOW + 7 * 3600e3, tags: ids.tags }).then((x) => x.removed), 0, 'not before a day has passed');
  assert.equal(await importJobTread(env, { now: NOW + 2 * DAY, tags: ids.tags }).then((x) => x.removed), 1, 'and then it goes');
  assert.equal((await filesOf(env.DB, VENDOR)).length, 1, 'never copied twice');
});

test('a copy that doesn’t read back as the very same bytes is never a reason to delete JobTread’s', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  world.vendors[VENDOR].files = [{ id: 'F1', name: 'W9.pdf', folder: 'W-9 & Insurance', size: PDF.length, createdAt: '2026-05-22T12:00:00Z', tags: [] }];
  world.fileBytes = { F1: PDF };
  const put = env.VENDOR_FILES.put.bind(env.VENDOR_FILES);
  env.VENDOR_FILES.put = (key, bytes, o) => put(key, new TextEncoder().encode('%PDF-1.7 mangled on the way'), o);
  const ids = await jtSetup(env);
  const r = await importJobTread(env, { now: NOW, tags: ids.tags });
  assert.equal(r.removed, 0);
  assert.deepEqual(world.deleted, []);
});

test('without the private bucket nothing is kept (never in soard-files), and a kept W-9 opens, its look logged', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const own = env.VENDOR_FILES;
  delete env.VENDOR_FILES;
  await assert.rejects(keepFile(env, VENDOR, { doc: 'w9', bytes: PDF, type: 'application/pdf', name: 'W9.pdf', source: 'staff' }, { now: NOW }), /private storage/);
  assert.equal(env.FILES.objects.size, 0, 'nothing in the public bucket');
  env.VENDOR_FILES = own;
  const { file } = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF, type: 'application/pdf', name: 'W9.pdf', source: 'staff' }, { now: NOW });
  const res = await adminRead(`?file=${file.id}`);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PDF]);
  const views = (await env.DB.prepare("SELECT action, entity_name FROM audit_log WHERE entity_type = 'vendor-file'").all()).results;
  assert.deepEqual(views.map((v) => v.action), ['viewed'], 'a look at a W-9 is logged (once a minute per person and file)');
});

test('a company found in Mercury or Ramp under a slightly different name shows the JobTread vendor it likely is', async () => {
  const s = await addSiteVendor(env, { name: 'TKO Plumbing Services, LLC' }, { now: NOW });
  const v = (await (await adminRead(`?id=${s.id}`)).json()).vendor;
  assert.deepEqual(v.maybe, [{ id: VENDOR, name: 'TKO Plumbing' }]);
});

// ─── What the first round of testing broke, kept broken-proof ───────

test('a page left open never saves over a date a certificate moved meanwhile: refused, and shown as it is now', async () => {
  Object.assign(jtVals(), { 'F-W9': false, 'F-GL': '2026-01-01', 'F-WC': '2026-01-01' });
  const page = (await (await adminRead(`?id=${VENDOR}`)).json()).vendor;
  await writePapers(env, null, VENDOR, { gl: '2027-09-09', wc: '2027-09-09' }, fetch, { now: NOW, forward: true });
  const base = { w9: page.w9, gl: page.gl, wc: page.wc, docs: page.need };
  // Only the W-9 changed on the page: it goes, the newer dates stay
  let j = await admin({ action: 'set', id: VENDOR, w9: true, base });
  assert.equal(j.success, true);
  assert.equal((await readPapers(env.DB, VENDOR)).glExpires, '2027-09-09');
  // A date typed over the old one: refused, never written over
  j = await admin({ action: 'set', id: VENDOR, gl: '2026-02-02', base });
  assert.equal(j.success, false);
  assert.match(j.error, /changed since you opened it \(liability\)/);
  assert.equal(j.vendor.gl, '2027-09-09');
  assert.equal(jtVals()['F-GL'], '2027-09-09');
});

test('two certificates checked at once, in either order, leave the later dates', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const { staffUpload } = await import('../functions/api/_vendors.js');
  const cert = (end) => coi({ policies: [{ ...coi().policies[0], expires: end }, { ...coi().policies[1], expires: end }] });
  let n = 0;
  world.ai = () => cert(n++ % 2 ? '2027-03-01' : '2027-09-01');
  await Promise.all([
    staffUpload(env, VENDOR, { doc: 'coi', files: [new File([PDF], 'a.pdf', { type: 'application/pdf' })], by: 'a@soardcharity.com' }, { now: NOW }),
    staffUpload(env, VENDOR, { doc: 'coi', files: [new File([PDF2], 'b.pdf', { type: 'application/pdf' })], by: 'b@soardcharity.com' }, { now: NOW }),
  ]);
  const p = await readPapers(env.DB, VENDOR);
  assert.deepEqual([p.glExpires, p.wcExpires], ['2027-09-01', '2027-09-01']);
});

test('a save made while the 4-hourly JobTread list is being read isn’t undone by the older list', async () => {
  Object.assign(jtVals(), { 'F-W9': true, 'F-GL': '2026-01-01', 'F-WC': '2026-01-01' });
  await readVendor(env, VENDOR, { now: NOW });
  // The list's answer comes back with the old date; staff save a new one while it's on its way
  const inner = globalThis.fetch;
  let saved = false;
  globalThis.fetch = async (input, init) => {
    const res = await inner(input, init);
    if (!saved && String(input).includes('api.jobtread.com') && JSON.parse(init.body).query.organization?.accounts) {
      saved = true;
      await writePapers(env, null, VENDOR, { gl: '2027-06-01' }, inner, { now: NOW });
    }
    return res;
  };
  try { await refreshCache(env, { now: NOW }); } finally { globalThis.fetch = inner; }
  assert.equal(saved, true);
  assert.equal((await readPapers(env.DB, VENDOR)).glExpires, '2027-06-01', 'the save stands');
  assert.equal(jtVals()['F-GL'], '2027-06-01');
});

test('JobTread’s copy is never deleted for an error page, a cut-off download, or a delete JobTread didn’t do', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const ids = await jtSetup(env);
  world.vendors[VENDOR].files = [
    { id: 'F1', name: 'W9.pdf', folder: 'W-9 & Insurance', size: 5009, createdAt: '2026-05-22T12:00:00Z', tags: [] },
    { id: 'F2', name: 'COI.pdf', folder: 'W-9 & Insurance', size: 5009, createdAt: '2026-05-22T12:00:00Z', tags: ['T-COI'] },
  ];
  world.fileBytes = { F1: new TextEncoder().encode('<html>Not found</html>'), F2: PDF };   // an error page, and a PDF shorter than JobTread says
  let r = await importJobTread(env, { now: NOW, tags: ids.tags });
  assert.deepEqual([r.files, r.removed], [0, 0]);
  assert.deepEqual(world.deleted, []);
  assert.equal((await filesOf(env.DB, VENDOR)).length, 0);
  // JobTread answers 200 with errors, and still has the file: not counted as taken out
  world.vendors[VENDOR].files = [{ id: 'F3', name: 'W9.pdf', folder: 'W-9 & Insurance', size: PDF.length, createdAt: '2026-05-22T12:00:00Z', tags: [] }];
  world.fileBytes = { F3: PDF };
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('api.jobtread.com')) {
      const q = JSON.parse(init.body).query;
      if (q.deleteFile) return Response.json({ errors: [{ message: 'not allowed' }] });
      if (q.file) return Response.json({ file: { id: 'F3' } });
    }
    return inner(input, init);
  };
  try { r = await importJobTread(env, { now: NOW + 7 * 3600e3, tags: ids.tags }); } finally { globalThis.fetch = inner; }
  assert.deepEqual([r.files, r.removed], [1, 0]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM vendor_jt_removed').first()).n, 0);
});

test('a company is the same company only by its whole name: numbers count, accents and Inc. don’t, and a JobTread vendor’s name is theirs', async () => {
  const a = await addSiteVendor(env, { name: '84 Lumber' }, { now: NOW });
  const b = await addSiteVendor(env, { name: 'Lumber Co' }, { now: NOW });
  assert.notEqual(a.id, b.id);
  const c = await addSiteVendor(env, { name: 'Pérez Painting' }, { now: NOW });
  const d = await addSiteVendor(env, { name: 'Perez Painting, Inc.' }, { now: NOW });
  assert.equal(c.id, d.id);
  const jp = await addSiteVendor(env, { name: '株式会社タナカ' }, { now: NOW });
  assert.equal(jp.made, true, 'a name in any script');
  const j = await admin({ action: 'add', name: 'TKO Plumbing, LLC' });
  assert.equal(j.success, false);
  assert.equal(j.jtId, VENDOR, 'points at the JobTread vendor instead of making a second one');
});

test('a "W-9 only" company’s link takes its W-9 and nothing else', async () => {
  const s = await addSiteVendor(env, { name: 'Capin Crouse LLP', email: 'billing@capin.example' }, { now: NOW });
  const link = await createLink(env.DB, s.id, { now: NOW });
  const body = new FormData();
  body.set('token', link.token); body.set('doc', 'coi'); body.append('file', new File([PDF], 'coi.pdf', { type: 'application/pdf' }));
  const res = await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) });
  assert.equal(res.status, 403);
  assert.equal((await filesOf(env.DB, s.id)).length, 0);
  assert.equal(world.slack.length, 0, 'no one is told to look at a certificate nobody asked for');
});

test('what SOARD paid a company off the jobs counts Mercury’s payments as well as Ramp’s', async () => {
  const { ensureTxnSchema } = await import('../functions/api/_mercury-txns.js');
  await ensureTxnSchema(env.DB);
  const s = await addSiteVendor(env, { name: 'Wiggins Law Group', payee: { mercury: 'rec-w' } }, { now: NOW });
  await env.DB.prepare("INSERT INTO mercury_txns (id, kind, status, cents, counterparty, counterparty_id, created_at, posted_at) VALUES ('t1', 'outgoingPayment', 'sent', -450000, 'Wiggins Law Group', 'rec-w', ?, ?)")
    .bind(new Date(Date.now() - 30 * DAY).toISOString(), new Date(Date.now() - 30 * DAY).toISOString()).run();
  const row = (await (await adminRead()).json()).list.find((r) => r.id === s.id);
  assert.equal(row.paid, 450000);
});

test('"I looked at it" clears Needs a look, and a good W-9 settles the unreadable one before it', async () => {
  Object.assign(jtVals(), { 'F-W9': false, 'F-GL': '2027-06-01', 'F-WC': '2027-06-01' });
  await readVendor(env, VENDOR, { now: NOW });
  const { relabel } = await import('../functions/api/_vendors.js');
  const look = await keepFile(env, VENDOR, { doc: 'coi', bytes: PDF, type: 'application/pdf', name: 'blurry.pdf', source: 'page', status: 'look' }, { now: NOW });
  assert.equal((await relabel(env, VENDOR, { now: NOW })).label, 'Needs a look');
  const j = await admin({ action: 'file', fileId: look.file.id, status: 'checked' });
  assert.equal(j.vendor.label, 'Missing', 'the W-9 is still missing; nothing waits on a person');
  assert.equal(jtVals()['F-DOCS'], 'Missing');
  // An unreadable W-9, then a good one from their page: the first is settled, the company is Current
  await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF2, type: 'application/pdf', name: 'w9 blurry.pdf', source: 'page', status: 'look' }, { now: NOW });
  await relabel(env, VENDOR, { now: NOW });
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  world.ai = { isW9: true, readable: true, name: 'TKO Plumbing LLC', hasTaxId: true, signed: true, signedDate: '2026-10-01' };
  const body = new FormData();
  body.set('token', link.token); body.set('doc', 'w9'); body.append('file', new File([JPG], 'w9.jpg', { type: 'image/jpeg' }));
  const d = await (await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) })).json();
  assert.equal(d.accepted, true);
  assert.equal((await readPapers(env.DB, VENDOR)).docs, 'Current');
  assert.deepEqual((await filesOf(env.DB, VENDOR)).map((f) => f.status).sort(), ['checked', 'checked', 'kept']);
});

test('a photo kept under a .pdf name is saved and served as the photo it is', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const { file } = await keepFile(env, VENDOR, { doc: 'w9', bytes: JPG, type: 'image/jpeg', name: 'scan.pdf', source: 'staff' }, { now: NOW });
  assert.equal(file.name, 'scan.jpg');
  const res = await adminRead(`?file=${file.id}`);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
});

// ─── What the second round of testing broke, kept broken-proof ──────

const siteRows = async () => (await env.DB.prepare("SELECT id, name, archived, docs FROM vendor_papers WHERE id LIKE 's\\_%' ESCAPE '\\' ORDER BY name").all()).results;
const mercuryOn = () => { env.MERCURY_API_TOKEN = 'secret-token:test'; env.MERCURY_RELAY_KEY = 'relay'; };
const addJt = (id, name) => env.DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(`jt_${id}`, name, name.toLowerCase(), id, null, '{}', 'x', 'x').run();

test('a two-letter JobTread vendor that is also a Mercury payee does not stop the daily payee search', async () => {
  mercuryOn();
  await addJt('GE00001', 'GE');
  world.recipients = [{ id: 'r1', name: 'GE', status: 'active' }, { id: 'r2', name: 'Capin Crouse LLP', status: 'active', emails: ['ap@capin.example'] }];
  let err = null;
  try { await findPayees(env, { now: NOW, force: true }); } catch (e) { err = e; }
  assert.equal(err?.message || null, null, 'findPayees threw');
  assert.deepEqual((await siteRows()).map((r) => r.name), ['Capin Crouse LLP'], 'the CPA is found; GE is the JobTread vendor');
});

test('a vendor archived in JobTread leaves the W-9 list (a search still finds it) and comes back when it’s unarchived', async () => {
  const row = async () => (await (await adminRead()).json()).list.find((r) => r.id === VENDOR);
  await refreshCache(env, { now: NOW });
  assert.equal((await row()).archived, false, 'a live vendor is on the list');
  world.vendors[VENDOR].archivedAt = '2026-11-01T00:00:00Z';
  await refreshCache(env, { now: NOW });
  assert.equal((await row()).archived, true, 'archived in JobTread: off the list, found only by its name');
  world.vendors[VENDOR].archivedAt = null;
  await refreshCache(env, { now: NOW });
  assert.equal((await row()).archived, false, 'unarchived in JobTread: back on the list');
});

test('a site company taken off the list comes back when SOARD pays it again (what the archive dialog promises)', async () => {
  mercuryOn();
  const s = await addSiteVendor(env, { name: 'Capin Crouse LLP' }, { now: NOW });
  assert.equal((await admin({ action: 'archive', id: s.id, archived: true })).success, true);
  world.recipients = [{ id: 'r2', name: 'Capin Crouse LLP', status: 'active' }];
  await findPayees(env, { now: NOW, force: true });
  assert.ok((await (await adminRead()).json()).list.some((r) => r.id === s.id && r.archived), 'still a Mercury payee, not paid since: it stays off (found only by its name)');
  const { ensureTxnSchema } = await import('../functions/api/_mercury-txns.js');
  await ensureTxnSchema(env.DB);
  const later = new Date(Date.now() + 2 * DAY).toISOString();
  await env.DB.prepare("INSERT INTO mercury_txns (id, kind, status, cents, counterparty, counterparty_id, created_at, posted_at) VALUES ('tp2', 'outgoingPayment', 'sent', -90000, 'Capin Crouse LLP', 'r2', ?, ?)").bind(later, later).run();
  await findPayees(env, { now: NOW, force: true });
  const list = (await (await adminRead()).json()).list;
  assert.ok(list.some((r) => r.id === s.id && !r.archived), '"it comes back if it’s paid again"');
});

test('renaming a site company found in Mercury does not make the payee search add it again', async () => {
  mercuryOn();
  world.recipients = [{ id: 'r2', name: 'Capin Crouse LLP', status: 'active' }];
  await findPayees(env, { now: NOW, force: true });
  const [one] = await siteRows();
  assert.equal((await admin({ action: 'edit', id: one.id, name: 'CapinCrouse CPAs' })).success, true);
  await findPayees(env, { now: NOW + 2 * DAY });
  assert.deepEqual((await siteRows()).map((r) => r.name), ['CapinCrouse CPAs'], 'one company, not a second "Capin Crouse LLP"');
});

test('moving a file onto a company whose same file was taken off leaves it visible somewhere', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const other = await addSiteVendor(env, { name: 'Wiggins Law Group' }, { now: NOW });
  // Wiggins' copy was taken off earlier; the same certificate later lands on TKO (wrong company)
  const w = await keepFile(env, other.id, { doc: 'coi', bytes: PDF, type: 'application/pdf', name: 'COI.pdf', source: 'staff' }, { now: NOW });
  await admin({ action: 'remove-file', fileId: w.file.id });
  const t = await keepFile(env, VENDOR, { doc: 'coi', bytes: PDF, type: 'application/pdf', name: 'COI.pdf', source: 'email' }, { now: NOW });
  const j = await admin({ action: 'move-file', fileId: t.file.id, toId: other.id });
  assert.equal(j.success, true);
  const theirs = (await (await adminRead(`?id=${other.id}`)).json()).vendor.files;
  const mine = (await (await adminRead(`?id=${VENDOR}`)).json()).vendor.files;
  assert.equal(theirs.length + mine.length, 1, `the moved certificate shows on one company (Wiggins ${theirs.length}, TKO ${mine.length})`);
});

test('a certificate moved off the wrong company takes its dates with it (or at least the wrong company stops looking insured)', async () => {
  // TKO has nothing; a certificate for another company is added to TKO by mistake and moves its dates
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  world.ai = coi({ insured: 'Wiggins Roofing', policies: [
    { kind: 'general liability', insurer: 'Hartford', effective: '2026-06-21', expires: '2027-06-21', eachOccurrence: 1000000, aggregate: 2000000 },
    { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-06-21', expires: '2027-06-21', employersLiabilityEachAccident: 1000000 },
  ] });
  const fd = new FormData();
  fd.set('id', VENDOR); fd.set('doc', 'coi'); fd.append('file', new File([PDF], 'wiggins-coi.pdf', { type: 'application/pdf' }));
  const up = await admin(fd);
  assert.equal(up.success, true);
  assert.equal(up.vendor.label, 'Current', 'TKO now looks insured on Wiggins’ certificate');
  const other = await addSiteVendor(env, { name: 'Wiggins Roofing' }, { now: NOW });
  const j = await admin({ action: 'move-file', fileId: up.vendor.files[0].id, toId: other.id });
  assert.equal(j.success, true);
  assert.notEqual(j.vendor.label, 'Current', `after the move TKO has no certificate yet still says ${j.vendor.label} (liability to ${j.vendor.gl})`);
});

test('moving a site company onto its JobTread vendor recomputes Documents (JobTread’s field too)', async () => {
  Object.assign(jtVals(), { 'F-W9': false, 'F-GL': '2027-06-01', 'F-WC': '2027-06-01', 'F-DOCS': 'Missing' });
  await readVendor(env, VENDOR, { now: NOW });
  const s = await addSiteVendor(env, { name: 'TKO Plumbing Services' }, { now: NOW });
  await savePapers(env, s.id, { w9: true }, { now: NOW });
  const j = await admin({ action: 'merge', id: s.id, jtId: VENDOR });
  assert.equal(j.success, true);
  assert.equal(j.vendor.label, 'Current', 'the page says Current');
  assert.equal((await readPapers(env.DB, VENDOR)).docs, 'Current', 'the record’s Documents');
  assert.equal(jtVals()['F-DOCS'], 'Current', 'JobTread’s Documents field');
});

test('two different companies’ W-9s with the same file name: both views are in the audit log', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const other = await addSiteVendor(env, { name: 'Wiggins Law Group' }, { now: NOW });
  const a = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF, type: 'application/pdf', name: 'W9.pdf', source: 'staff' }, { now: NOW });
  const b = await keepFile(env, other.id, { doc: 'w9', bytes: PDF2, type: 'application/pdf', name: 'W9.pdf', source: 'staff' }, { now: NOW });
  await adminRead(`?file=${a.file.id}`);
  await adminRead(`?file=${b.file.id}`);
  const rows = (await env.DB.prepare("SELECT entity_slug FROM audit_log WHERE entity_type = 'vendor-file'").all()).results;
  assert.deepEqual(rows.map((r) => r.entity_slug).sort(), [VENDOR, other.id].sort(), 'whose W-9 was opened, for each');
});

test('a W-9 viewed and then downloaded within a minute: the download is in the audit log', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const a = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF, type: 'application/pdf', name: 'W9.pdf', source: 'staff' }, { now: NOW });
  await adminRead(`?file=${a.file.id}`);
  await adminRead(`?file=${a.file.id}&download=1`);
  const rows = (await env.DB.prepare("SELECT action FROM audit_log WHERE entity_type = 'vendor-file'").all()).results;
  assert.deepEqual(rows.map((r) => r.action), ['viewed', 'downloaded']);
});

test('the import’s "left in JobTread" count is the files left there, not a running total of every pass', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  world.vendors[VENDOR].files = [{ id: 'BIG', name: 'COI huge.pdf', folder: 'W-9 & Insurance', size: 20 * 1024 * 1024, createdAt: '2026-05-22T12:00:00Z', tags: ['T-COI'] }];
  const ids = await jtSetup(env);
  for (let i = 0; i < 5; i++) await importJobTread(env, { now: NOW + i * 7 * 3600e3, tags: ids.tags });
  const st = (await readState(env.DB, 'vendor-papers')).import;
  assert.equal(st.skipped, 1, `one file is left in JobTread; the admin says ${st.skipped}`);
});

test('randomized: edits in JobTread and on the site in any order end with both showing the last one', async () => {
  const F = { gl: 'F-GL', wc: 'F-WC', check: 'F-CHECK' };
  const dates = ['2026-12-01', '2027-01-15', '2027-03-03', '2027-08-08', null];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const problems = [];
  for (let run = 0; run < 60; run++) {
    world = fresh();
    await env.DB.prepare('DELETE FROM vendor_papers').run().catch(() => null);
    Object.assign(jtVals(), { 'F-W9': true, 'F-GL': '2026-11-30', 'F-WC': '2026-11-30' });
    await readVendor(env, VENDOR, { now: NOW });
    const want = { gl: '2026-11-30', wc: '2026-11-30', check: null };
    const log = [];
    // Per field: the site's value not yet in JobTread (a write while it refused), and a hand edit there since the last read
    const pending = {};
    const handEdit = {};
    const either = {};
    const siteVal = { ...want };
    for (let step = 0; step < 8; step++) {
      const k = ['gl', 'wc', 'check'][rnd(3)];
      const val = k === 'check' ? ['A', 'B', 'C', null][rnd(4)] : dates[rnd(dates.length)];
      const op = rnd(5);
      if (op === 0) { jtVals()[F[k]] = val; want[k] = val; handEdit[k] = true; if (pending[k]) either[k] = true; log.push(`jt ${k}=${val}`); }
      else if (op === 1) { world.refuseWrites = false; await writePapers(env, null, VENDOR, { [k]: val }, fetch, { now: NOW }); want[k] = val; siteVal[k] = val; pending[k] = false; handEdit[k] = false; either[k] = false; log.push(`site ${k}=${val}`); }
      else if (op === 2) {
        world.refuseWrites = true; await writePapers(env, null, VENDOR, { [k]: val }, fetch, { now: NOW }); world.refuseWrites = false;
        // The same value the site has already changes nothing on the site: nothing to send
        if (val !== siteVal[k]) { want[k] = val; siteVal[k] = val; pending[k] = true; if (handEdit[k]) either[k] = true; }
        log.push(`site(jt down) ${k}=${val}`);
      } else {
        world.refuseWrites = false;
        if (op === 3) await readVendor(env, VENDOR, { now: NOW }); else await refreshCache(env, { now: NOW });
        for (const f of Object.keys(F)) { pending[f] = false; handEdit[f] = false; }
        const p0 = await readPapers(env.DB, VENDOR);
        Object.assign(siteVal, { gl: p0.glExpires, wc: p0.wcExpires, check: p0.check });
        for (const f of Object.keys(F)) if (either[f]) { want[f] = siteVal[f]; either[f] = false; }
        log.push(op === 3 ? 'read' : 'list');
      }
    }
    world.refuseWrites = false;
    await readVendor(env, VENDOR, { now: NOW });
    await readVendor(env, VENDOR, { now: NOW });
    const p = await readPapers(env.DB, VENDOR);
    const site = { gl: p.glExpires, wc: p.wcExpires, check: p.check };
    const jtNow = { gl: jtVals()['F-GL'] ?? null, wc: jtVals()['F-WC'] ?? null, check: jtVals()['F-CHECK'] ?? null };
    for (const k of Object.keys(want)) {
      // A true conflict still open at the end: both end on the same value, the one the site's rule keeps
      const ok = either[k] ? site[k] === (jtNow[k] || null) : site[k] === want[k] && (jtNow[k] || null) === want[k];
      if (!ok) problems.push(`${log.join(' → ')} ⇒ ${k}: want ${either[k] ? 'one value both show' : want[k]}, site ${site[k]}, JobTread ${jtNow[k]}`);
    }
  }
  assert.deepEqual(problems.slice(0, 5), []);
});

test('a save that lands while a read is settling the same row is not undone (full-row write race)', async () => {
  Object.assign(jtVals(), { 'F-W9': true, 'F-GL': '2026-01-01', 'F-WC': '2026-01-01' });
  await readVendor(env, VENDOR, { now: NOW });
  jtVals()['F-CHECK'] = 'typed by hand in JobTread';   // so the read has something to write
  // Interleave: right after settlePapers reads the row and before it writes it, a certificate's date lands
  const prep = env.DB.prepare.bind(env.DB);
  let armed = true;
  env.DB.prepare = (sql) => {
    const st = prep(sql);
    if (armed && /^(INSERT INTO vendor_papers \(id, name, vkey|UPDATE vendor_papers SET .*jt_sent = json_set)/s.test(sql.trim())) {
      armed = false;
      const bind = st.bind;
      st.bind = (...a) => { const b = bind(...a); const run = b.run; b.run = async () => { await savePapers(env, VENDOR, { gl: '2027-09-09' }, { now: NOW }); return run(); }; return b; };
    }
    return st;
  };
  try { await readVendor(env, VENDOR, { now: NOW }); } finally { env.DB.prepare = prep; }
  assert.equal((await readPapers(env.DB, VENDOR)).glExpires, '2027-09-09', 'the certificate’s date stands');
});

test('a site-only company’s link: everything but its W-9 (and lang) is refused, and an expired one says something it can act on', async () => {
  const s = await addSiteVendor(env, { name: 'Capin Crouse LLP', email: 'ap@capin.example' }, { now: NOW });
  const link = await createLink(env.DB, s.id, { now: NOW });
  const post = (body) => stepPost({ env, request: new Request('https://x.example/api/trade-partner', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: link.token, ...body }) }) });
  for (const action of ['company', 'agent', 'bank', 'bank-link']) assert.equal((await post({ action })).status, 403, action);
  // Their certificate: refused for a W-9-only company
  const body = new FormData();
  body.set('token', link.token); body.set('doc', 'coi'); body.append('file', new File([PDF], 'coi.pdf', { type: 'application/pdf' }));
  assert.equal((await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) })).status, 403);
  // Signing in: a site company's email gets nothing (only JobTread vendors' emails are looked up)
  world.emails = [];
  const r = await stepPost({ env, request: new Request('https://x.example/api/trade-partner', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify({ action: 'signin', email: 'ap@capin.example' }) }) });
  assert.equal(r.status, 200);
  assert.equal(world.emails.length, 1, 'the expired-link page tells a site company to "sign in again", but signing in never sends them a link');
});

test('randomized, JobTread never down: hand edits, site writes, reads, lists, and site writes landing mid-read', async () => {
  const F = { gl: 'F-GL', wc: 'F-WC', check: 'F-CHECK', w9: 'F-W9' };
  const dates = ['2026-12-01', '2027-01-15', '2027-03-03', '2027-08-08', null];
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const problems = [];
  const inner = globalThis.fetch;
  for (let run = 0; run < 150; run++) {
    world = fresh();
    await env.DB.prepare('DELETE FROM vendor_papers').run().catch(() => null);
    Object.assign(jtVals(), { 'F-W9': true, 'F-GL': '2026-11-30', 'F-WC': '2026-11-30' });
    await readVendor(env, VENDOR, { now: NOW });
    const want = { gl: '2026-11-30', wc: '2026-11-30', check: null, w9: true };
    const log = [];
    for (let step = 0; step < 8; step++) {
      const k = ['gl', 'wc', 'check', 'w9'][rnd(4)];
      const val = k === 'check' ? ['A', 'B', null][rnd(3)] : k === 'w9' ? [true, false][rnd(2)] : dates[rnd(dates.length)];
      const op = rnd(5);
      if (op === 0) { jtVals()[F[k]] = val; want[k] = val; log.push(`jt ${k}=${val}`); }
      else if (op === 1) { await writePapers(env, null, VENDOR, { [k]: val }, inner, { now: NOW }); want[k] = val; log.push(`site ${k}=${val}`); }
      else if (op === 2) { await readVendor(env, VENDOR, { now: NOW }); log.push('read'); }
      else if (op === 3 || op === 4) {
        // A site write lands while JobTread is answering a read (op 3) or the 4-hourly list (op 4)
        let done = false;
        globalThis.fetch = async (input, init) => {
          const res = await inner(input, init);
          const q = String(input).includes('api.jobtread.com') ? JSON.parse(init.body).query : {};
          if (!done && (op === 3 ? q.account : q.organization?.accounts)) { done = true; await writePapers(env, null, VENDOR, { [k]: val }, inner, { now: NOW }); }
          return res;
        };
        try { if (op === 3) await readVendor(env, VENDOR, { now: NOW }); else await refreshCache(env, { now: NOW }); } finally { globalThis.fetch = inner; }
        want[k] = val; log.push(`${op === 3 ? 'read' : 'list'} with site ${k}=${val} landing mid-way`);
      }
    }
    await readVendor(env, VENDOR, { now: NOW });
    await readVendor(env, VENDOR, { now: NOW });
    const p = await readPapers(env.DB, VENDOR);
    const site = { gl: p.glExpires, wc: p.wcExpires, check: p.check, w9: p.w9 };
    const jtNow = { gl: jtVals()['F-GL'] ?? null, wc: jtVals()['F-WC'] ?? null, check: jtVals()['F-CHECK'] ?? null, w9: !!jtVals()['F-W9'] };
    for (const k of Object.keys(want)) {
      const j = k === 'w9' ? jtNow[k] : jtNow[k] || null;
      if (site[k] !== want[k] || j !== want[k]) problems.push(`${log.join(' → ')} ⇒ ${k}: want ${want[k]}, site ${site[k]}, JobTread ${j}`);
    }
  }
  assert.deepEqual(problems.slice(0, 6), []);
});

test('a site-only company that uses "Get started" (the only way forward from its expired link) is not made a second company in JobTread', async () => {
  const s = await addSiteVendor(env, { name: 'Capin Crouse LLP', email: 'ap@capin.example' }, { now: NOW });
  world.created = [];
  const { startPartner } = await import('../functions/api/_trade-partners.js');
  let r = null;
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).includes('api.jobtread.com')) {
      const { query } = JSON.parse(init.body);
      if (query.createAccount) { world.vendors.NEWJT1 = { name: query.createAccount.$.name, email: null, values: {}, files: [] }; return Response.json({ createAccount: { createdAccount: { id: 'NEWJT1', name: query.createAccount.$.name } } }); }
      if (query.createContact) return Response.json({ createContact: { createdContact: { id: 'CX' } } });
    }
    return inner(input, init);
  };
  try { r = await startPartner(env, { company: 'Capin Crouse LLP', name: 'Pat Partner', email: 'ap@capin.example', phone: '4045550188' }, { now: NOW }); } catch (e) { r = { error: e.message }; } finally { globalThis.fetch = inner; }
  const made = Object.keys(world.vendors).filter((id) => id !== VENDOR);
  assert.equal(made.length + (r?.how === 'new' ? 1 : 0), 0, `startPartner → ${JSON.stringify(r)}; JobTread vendors made: ${made.map((id) => world.vendors[id].name).join(', ')}`);
  void s;
});

test('"Email them for it" on a company taken off the list does not send a link that opens "no longer on file"', async () => {
  const s = await addSiteVendor(env, { name: 'Capin Crouse LLP', email: 'ap@capin.example' }, { now: NOW });
  await admin({ action: 'archive', id: s.id, archived: true });
  // Staff re-add it (it opens, with no sign it's archived) and email them
  const again = await admin({ action: 'add', name: 'Capin Crouse LLP' });
  assert.equal(again.made, false);
  world.emails = [];
  const j = await admin({ action: 'ask', id: s.id });
  const url = world.emails[0]?.text?.match(/#t=([A-Za-z0-9_-]+)/)?.[1];
  const view = url ? await (await (await import('../functions/api/vendor-docs.js')).onRequestGet({ env, request: new Request(`https://x.example/api/vendor-docs?token=${url}`) })).json() : null;
  assert.ok(!j.success || view?.ok, `ask → ${j.success ? `sent to ${j.sent}` : j.error}; their link opens: ${JSON.stringify(view)}`);
});

test('the insurance audit and the auditor’s packet still show a certificate the site now keeps (staff-added here)', async () => {
  const IA = await import('../functions/api/_insurance-audit.js');
  const { PDFDocument: PD } = await import('pdf-lib');
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  // A real one-page certificate PDF, added by staff in the admin (kept on the site, as every certificate now is)
  const doc = await PD.create(); doc.addPage([612, 792]);
  const bytes = await doc.save();
  world.ai = coi({ policies: [
    { kind: 'general liability', insurer: 'Hartford', effective: '2026-01-01', expires: '2027-06-21', eachOccurrence: 1000000, aggregate: 2000000 },
    { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-01-01', expires: '2027-06-21', employersLiabilityEachAccident: 1000000 },
  ] });
  const fd = new FormData();
  fd.set('id', VENDOR); fd.set('doc', 'coi'); fd.append('file', new File([bytes], 'tko-coi.pdf', { type: 'application/pdf' }));
  const up = await admin(fd);
  assert.equal(up.success, true, up.error);
  const T = IA.term('2026', 'wc');
  const a = IA.auditFrom({ term: T, payments: [{ key: 'bill:B1', jtId: VENDOR, payee: 'TKO Plumbing', date: '2026-06-05', cents: 300000, source: 'jobtread', method: 'bill', costTypes: ['Subcontractor'] }], vendors: await IA.readVendors(env.DB), sites: await IA.readSites(env.DB), coverage: await IA.readCoverage(env.DB), today: '2026-11-02' });
  const row = a.rows.find((r) => r.jtId === VENDOR);
  assert.equal(row.wc.cents, 0, 'covered by the certificate');
  const pdf = await PD.load(await IA.auditPacket(env, a, { now: NOW }));
  assert.deepEqual({ filesOnAuditPage: row.files.length, packetPages: pdf.getPageCount() }, { filesOnAuditPage: 1, packetPages: 2 }, 'the audit page says "Certificate on file", and the packet has the certificate after the summary');
});

test('moving a site company onto its JobTread vendor carries its certificates’ coverage (the insurance audit reads coverage by vendor)', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  const s = await addSiteVendor(env, { name: 'TKO Plumbing Services' }, { now: NOW });
  await admin({ action: 'set', id: s.id, docs: null });
  world.ai = coi({ insured: 'TKO Plumbing Services', policies: [
    { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-01-01', expires: '2027-06-21', employersLiabilityEachAccident: 1000000 },
    { kind: 'general liability', insurer: 'Hartford', effective: '2026-01-01', expires: '2027-06-21', eachOccurrence: 1000000, aggregate: 2000000 },
  ] });
  const fd = new FormData();
  fd.set('id', s.id); fd.set('doc', 'coi'); fd.append('file', new File([PDF2], 'coi.pdf', { type: 'application/pdf' }));
  assert.equal((await admin(fd)).success, true);
  assert.equal((await admin({ action: 'merge', id: s.id, jtId: VENDOR })).success, true);
  const cov = (await env.DB.prepare('SELECT jt_id, kind FROM coi_coverage').all()).results;
  assert.ok(cov.length && cov.every((c) => c.jt_id === VENDOR), `coverage rows still on the gone site company: ${JSON.stringify(cov)}`);
});

test('a certificate kept for a company paid outside JobTread covers its Mercury payments in the insurance audit', async () => {
  const IA = await import('../functions/api/_insurance-audit.js');
  const s = await addSiteVendor(env, { name: 'Example Framing Co' }, { now: NOW });
  await admin({ action: 'set', id: s.id, docs: null });
  world.ai = coi({ insured: 'Example Framing Co', policies: [
    { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-01-01', expires: '2027-06-21', employersLiabilityEachAccident: 1000000 },
    { kind: 'general liability', insurer: 'Hartford', effective: '2026-01-01', expires: '2027-06-21', eachOccurrence: 1000000, aggregate: 2000000 },
  ] });
  const fd = new FormData();
  fd.set('id', s.id); fd.set('doc', 'coi'); fd.append('file', new File([PDF2], 'coi.pdf', { type: 'application/pdf' }));
  const up = await admin(fd);
  assert.equal(up.vendor.wc, '2027-06-21', 'the site has their workers’ comp');
  const T = IA.term('2026', 'wc');
  const a = IA.auditFrom({ term: T, payments: [{ key: 'mercury:T9', jtId: null, payee: 'Example Framing Co', date: '2026-06-05', cents: 450000, source: 'mercury', method: 'transfer', costTypes: ['Subcontractor'] }], vendors: await IA.readVendors(env.DB), sites: await IA.readSites(env.DB), coverage: await IA.readCoverage(env.DB), today: '2026-11-02' });
  const row = a.rows[0];
  assert.equal(row.wc.cents, 0, `the audit counts $${row.wc.cents / 100} paid to ${row.name} as without workers’ comp`);
});

// ─── What the third round of testing broke, kept broken-proof ───────

const GOOD = (insured = 'TKO Plumbing LLC', end = '2027-06-21') => coi({ insured, policies: [
  { kind: 'general liability', insurer: 'Hartford', effective: '2026-01-01', expires: end, eachOccurrence: 1000000, aggregate: 2000000 },
  { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-01-01', expires: end, employersLiabilityEachAccident: 1000000 },
] });
const JPGn = (n) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, n]);
const W9OK = (name = 'TKO Plumbing LLC') => ({ isW9: true, readable: true, name, hasTaxId: true, signed: true, signedDate: '2026-10-01' });
const upload = (id, doc, bytes, name = 'file.pdf', type = 'application/pdf') => {
  const fd = new FormData();
  fd.set('id', id); fd.set('doc', doc); fd.append('file', new File([bytes], name, { type }));
  return admin(fd);
};
const pdfBytes = async (text) => {
  const { PDFDocument: PD, StandardFonts: SF } = await import('pdf-lib');
  const d = await PD.create(); const p = d.addPage([612, 792]);
  p.drawText(text, { x: 50, y: 700, size: 14, font: await d.embedFont(SF.Helvetica) });
  return d.save();
};
const auditRow = async (jtId, payee = 'TKO Plumbing', date = '2026-06-05') => {
  const IA = await import('../functions/api/_insurance-audit.js');
  const a = IA.auditFrom({ term: IA.term('2026', 'wc'), payments: [{ key: 'bill:B1', jtId, payee, date, cents: 300000, source: 'jobtread', method: 'bill', costTypes: ['Subcontractor'] }], vendors: await IA.readVendors(env.DB), sites: await IA.readSites(env.DB), coverage: await IA.readCoverage(env.DB), today: '2026-11-02' });
  return { IA, a, row: a.rows[0] };
};

// ─── Records: what a file proved, when it goes ─────────────────────

test('a certificate taken off its company no longer counts as their insurance in the insurance audit', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  world.ai = GOOD('Wiggins Roofing');
  const up = await upload(VENDOR, 'coi', await pdfBytes('Wiggins COI'), 'wiggins.pdf');
  assert.equal(up.success, true, up.error);
  assert.equal((await auditRow(VENDOR)).row.wc.cents, 0, 'setup: the audit counts it while it is on TKO');
  const j = await admin({ action: 'remove-file', fileId: up.vendor.files[0].id });
  assert.equal(j.success, true);
  assert.notEqual(j.vendor.wc, '2027-06-21', 'setup: the record lost the date');
  const { row } = await auditRow(VENDOR);
  assert.equal(row.wc.cents, 300000, `after "Take off" the audit still counts the removed certificate as TKO's workers' comp (uninsured $${row.wc.cents / 100}, files ${JSON.stringify(row.files.map((f) => f.fileHash?.slice(0, 8)))})`);
});

test('taking off an unreadable W-9 never un-marks the W-9 JobTread had on file (that file never proved it)', async () => {
  Object.assign(jtVals(), { 'F-W9': true, 'F-GL': '2027-06-01', 'F-WC': '2027-06-01' });
  await readVendor(env, VENDOR, { now: NOW });
  const look = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF2, type: 'application/pdf', name: 'w9 blurry.pdf', source: 'page', status: 'look' }, { now: NOW });
  const j = await admin({ action: 'remove-file', fileId: look.file.id });
  assert.equal(j.success, true);
  assert.deepEqual({ site: j.vendor.w9, jobtread: jtVals()['F-W9'], label: j.vendor.label }, { site: true, jobtread: true, label: 'Current' },
    `removing a W-9 that was only waiting on a person changed: ${JSON.stringify(j.changed)}`);
});

test('taking off the good W-9 does not leave "W-9 on file" standing on a W-9 that failed the check', async () => {
  Object.assign(jtVals(), { 'F-W9': false, 'F-GL': '2027-06-01', 'F-WC': '2027-06-01' });
  await readVendor(env, VENDOR, { now: NOW });
  // An unsigned W-9 staff added: kept, doesn't pass
  world.ai = { isW9: true, readable: true, name: 'TKO Plumbing LLC', hasTaxId: true, signed: false };
  const bad = await upload(VENDOR, 'w9', JPGn(1), 'unsigned.jpg', 'image/jpeg');
  assert.equal(bad.success, true, bad.error);
  assert.equal(bad.vendor.w9, false, 'setup: an unsigned W-9 is not on file');
  world.ai = W9OK();
  const good = await upload(VENDOR, 'w9', JPGn(2), 'signed.jpg', 'image/jpeg');
  assert.equal(good.vendor.w9, true, `setup: the signed one is (${JSON.stringify(good.result)})`);
  const goodId = good.vendor.files.find((f) => f.status === 'checked' && f.doc === 'w9').id;
  const j = await admin({ action: 'remove-file', fileId: goodId });
  assert.equal(j.vendor.w9, false, `only an unsigned W-9 is left (${j.vendor.files.map((f) => `${f.name}:${f.status}`).join(', ')}), yet W-9 still on file; label ${j.vendor.label}`);
});

test('a W-9 relabeled as a certificate and back keeps the company where it was (no W-9 from nowhere, none lost)', async () => {
  Object.assign(jtVals(), { 'F-W9': false, 'F-GL': '2027-06-01', 'F-WC': '2027-06-01' });
  await readVendor(env, VENDOR, { now: NOW });
  // A failed W-9 (unsigned), relabeled as a certificate by mistake and back again
  world.ai = { isW9: true, readable: true, name: 'TKO Plumbing LLC', hasTaxId: true, signed: false };
  const bad = await upload(VENDOR, 'w9', JPGn(3), 'unsigned.jpg', 'image/jpeg');
  assert.equal(bad.vendor.files[0].status, 'kept', `setup: ${bad.vendor.files[0].status}`);
  const fid = bad.vendor.files[0].id;
  await admin({ action: 'move-file', fileId: fid, doc: 'coi' });
  const back = await admin({ action: 'move-file', fileId: fid, doc: 'w9' });
  assert.equal(back.vendor.w9, false, `an unsigned W-9, relabeled there and back, is now "W-9 on file" (changed ${JSON.stringify(back.changed)})`);
});

test('a certificate relabeled as a W-9 (it was a W-9 all along) is out of the insurance audit and the auditor\'s packet', async () => {
  Object.assign(jtVals(), { 'F-W9': false });
  await readVendor(env, VENDOR, { now: NOW });
  world.ai = GOOD();
  const bytes = await pdfBytes('W-9 and COI packet');
  const up = await upload(VENDOR, 'coi', bytes, 'packet.pdf');
  const fid = up.vendor.files[0].id;
  const j = await admin({ action: 'move-file', fileId: fid, doc: 'w9' });
  assert.equal(j.success, true);
  assert.equal((await readFile(env.DB, fid)).doc, 'w9');
  const { IA, a, row } = await auditRow(VENDOR);
  const { PDFDocument: PD } = await import('pdf-lib');
  const pages = (await PD.load(await IA.auditPacket(env, a, { now: NOW }))).getPageCount();
  assert.deepEqual({ coveredBy: row.files.length, packetPages: pages }, { coveredBy: 0, packetPages: 1 },
    'a file staff now say is a W-9 (it has a tax ID) still counts as insurance and goes to the outside auditor in the packet');
});

// ─── The site company merge ─────────────────────────────────────────

test('moving a "Not needed" site company onto a JobTread vendor on jobs does not turn off its insurance (bills would pay)', async () => {
  Object.assign(jtVals(), { 'F-W9': false });
  await readVendor(env, VENDOR, { now: NOW });
  const s = await addSiteVendor(env, { name: 'TKO Plumbing Services' }, { now: NOW });
  await admin({ action: 'set', id: s.id, docs: 'Not needed' });
  const j = await admin({ action: 'merge', id: s.id, jtId: VENDOR });
  assert.equal(j.success, true);
  assert.deepEqual({ docs: j.vendor.docs, ok: j.vendor.ok, jt: jtVals()['F-DOCS'] }, { docs: 'Missing', ok: false, jt: 'Missing' },
    'TKO is on jobs with no W-9 and no insurance, yet after the merge nothing is asked of it');
});

// ─── JobTread down ──────────────────────────────────────────────────

test('a W-9 signed online while JobTread is down is kept (the site is the record; uploads already work then)', async () => {
  Object.assign(jtVals(), { 'F-W9': false });
  await readVendor(env, VENDOR, { now: NOW });
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const { signW9 } = await import('../functions/api/_trade-partners.js');
  const realF = globalThis.fetch;
  globalThis.fetch = async (input, init) => (new URL(typeof input === 'string' ? input : input.url).host === 'api.jobtread.com' ? Response.json({ errors: [{ message: 'down' }] }, { status: 503 }) : realF(input, init));
  let err = null;
  try {
    const found = await findLink(env.DB, link.token, NOW);
    await signW9(env, found.link, { name: 'Tom Kowalski', business: 'TKO Plumbing LLC', taxClass: 'llc', llcClass: 'S', address: '12 Example Lane', cityStateZip: 'Decatur, GA 30030', tinType: 'ein', tin: '12-3456789', certify: true, signature: 'Tom Kowalski' }, { now: NOW });
  } catch (e) { err = e; } finally { globalThis.fetch = realF; }
  const files = await filesOf(env.DB, VENDOR);
  assert.deepEqual({ error: err?.message || null, kept: files.filter((f) => f.doc === 'w9').length }, { error: null, kept: 1 }, 'signing their W-9 fails while JobTread is down');
});

// ─── The JobTread import ────────────────────────────────────────────

test('the import knows a W-9 or certificate in the W-9 & Insurance folder by its usual file names (fw9.pdf, TKO_W9.pdf, COI_2026.pdf)', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const names = ['W-9 2024.pdf', 'Insurance certificate.pdf', 'fw9.pdf', 'TKO_W9.pdf', 'W9_signed.pdf', 'COI_2026.pdf', 'ACORD_25.pdf', 'GL-Cert.pdf'];
  world.vendors[VENDOR].files = names.map((name, i) => ({ id: `F${i}`, name, folder: 'W-9 & Insurance', size: null, createdAt: '2026-05-22T12:00:00Z', tags: [] }));
  for (let i = 0; i < names.length; i++) world.fileBytes[`F${i}`] = new TextEncoder().encode(`%PDF-1.7 file ${i}`);
  const ids = await jtSetup(env);
  for (let i = 0; i < 4; i++) await importJobTread(env, { now: NOW + i * 7 * 3600e3, tags: ids.tags });
  const kept = (await filesOf(env.DB, VENDOR)).map((f) => f.name).sort();
  const st = (await readState(env.DB, 'vendor-papers')).import;
  assert.equal(kept.length, names.length, `kept ${JSON.stringify(kept)}; left in JobTread ${JSON.stringify(world.vendors[VENDOR].files.map((f) => f.name))}; the admin says ${st.skipped} left`);
});

test('a file left in JobTread\'s W-9 & Insurance folder because the import can\'t tell what it is is counted as left there', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  world.vendors[VENDOR].files = [{ id: 'U1', name: 'scan0001.pdf', folder: 'W-9 & Insurance', size: null, createdAt: '2026-05-22T12:00:00Z', tags: [] }];
  const ids = await jtSetup(env);
  await importJobTread(env, { now: NOW, tags: ids.tags });
  const st = (await readState(env.DB, 'vendor-papers')).import;
  assert.equal(st.skipped, 1, `a file is still in JobTread's W-9 & Insurance folder and the admin says ${st.skipped} left`);
});

// ─── The W-9 view log ───────────────────────────────────────────────

test('a W-9 opened by two people within a minute: each is logged; one person opening it twice is logged once', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const a = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF, type: 'application/pdf', name: 'W9.pdf', source: 'staff' }, { now: NOW });
  const open = (email, q = '') => adminGet({ env, data: { userEmail: email }, request: new Request(`https://x.example/api/vendor-papers-admin?file=${a.file.id}${q}`) });
  await open('holly@soardcharity.org'); await open('holly@soardcharity.org'); await open('joe@soardcharity.org');
  const rows = (await env.DB.prepare("SELECT user_email, action FROM audit_log WHERE entity_type = 'vendor-file'").all()).results;
  assert.deepEqual(rows.map((r) => `${r.user_email}:${r.action}`), ['holly@soardcharity.org:viewed', 'joe@soardcharity.org:viewed']);
});

test('a W-9 taken off, then opened from "Taken off", is still logged', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const a = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF, type: 'application/pdf', name: 'W9.pdf', source: 'staff' }, { now: NOW });
  await admin({ action: 'remove-file', fileId: a.file.id });
  const r = await adminRead(`?file=${a.file.id}`);
  assert.equal(r.status, 200);
  const rows = (await env.DB.prepare("SELECT action FROM audit_log WHERE entity_type = 'vendor-file' AND action IN ('viewed', 'downloaded')").all()).results;
  assert.equal(rows.length, 1);
});

test('a W-9 moved to the right company: its view is logged under the company it is on now', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const other = await addSiteVendor(env, { name: 'Wiggins Law Group' }, { now: NOW });
  const a = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF, type: 'application/pdf', name: 'W9.pdf', source: 'staff' }, { now: NOW });
  await admin({ action: 'move-file', fileId: a.file.id, toId: other.id });
  await adminRead(`?file=${a.file.id}`);
  const r = await env.DB.prepare("SELECT entity_slug FROM audit_log WHERE entity_type = 'vendor-file' AND action = 'viewed'").first();
  assert.equal(r?.entity_slug, other.id);
});

// ─── Payee search ───────────────────────────────────────────────────

test('a payee paid through Mercury under a JobTread vendor\'s name with "The" / "Inc." / "&" is not made a site company', async () => {
  env.MERCURY_API_TOKEN = 'secret-token:test'; env.MERCURY_RELAY_KEY = 'relay';
  await env.DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind('jt_HD1', 'The Home Depot', 'the home depot', 'HD1', null, '{}', 'x', 'x').run();
  await env.DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind('jt_BB1', 'B & B Electric', 'b b electric', 'BB1', null, '{}', 'x', 'x').run();
  world.recipients = [{ id: 'r1', name: 'Home Depot Inc', status: 'active' }, { id: 'r2', name: 'B and B Electric, LLC', status: 'active' }, { id: 'r3', name: 'TKO PLUMBING', status: 'active' }];
  await findPayees(env, { now: NOW, force: true });
  const rows = (await env.DB.prepare("SELECT name FROM vendor_papers WHERE id LIKE 's\\_%' ESCAPE '\\'").all()).results;
  assert.deepEqual(rows.map((r) => r.name), []);
});

test('a site company archived, then paid again by Ramp (a bill dated after): it is back on the list', async () => {
  env.RAMP_CLIENT_ID = 'id'; env.RAMP_CLIENT_SECRET = 'secret';
  const s = await addSiteVendor(env, { name: 'Wiggins Law Group' }, { now: NOW - 30 * DAY });
  await admin({ action: 'archive', id: s.id, archived: true });
  world.rampBills = [{ id: 'RB1', vendor: { id: 'rv1', name: 'Wiggins Law Group' }, amount: { amount: 120000, currency_code: 'USD' }, issued_at: new Date(Date.now() + 2 * DAY).toISOString(), created_at: new Date(Date.now() + 2 * DAY).toISOString(), status: 'OPEN' }];
  await findPayees(env, { now: Date.now() + 3 * DAY, force: true });
  const p = await readPapers(env.DB, s.id);
  assert.equal(p.archived, false, `a Ramp bill after archiving: still archived (payee ${JSON.stringify(p.payee)})`);
});

// ─── Concurrency ────────────────────────────────────────────────────

test('two staff moving the same file to two different companies at once: the file is on one, and each company\'s record matches its files', async () => {
  Object.assign(jtVals(), { 'F-W9': false });
  await readVendor(env, VENDOR, { now: NOW });
  const a = await addSiteVendor(env, { name: 'Wiggins Law Group' }, { now: NOW });
  const b = await addSiteVendor(env, { name: 'Capin Crouse LLP' }, { now: NOW });
  world.ai = W9OK();
  const up = await upload(VENDOR, 'w9', JPGn(4), 'w9.jpg', 'image/jpeg');
  assert.equal(up.vendor.w9, true, 'setup');
  const fid = up.vendor.files[0].id;
  const [x, y] = await Promise.all([admin({ action: 'move-file', fileId: fid, toId: a.id }), admin({ action: 'move-file', fileId: fid, toId: b.id })]);
  const where = (await readFile(env.DB, fid)).vendorId;
  const st = { tko: (await readPapers(env.DB, VENDOR)).w9, a: (await readPapers(env.DB, a.id)).w9, b: (await readPapers(env.DB, b.id)).w9 };
  const expect = { tko: false, a: where === a.id, b: where === b.id };
  assert.deepEqual(st, expect, `file on ${where === a.id ? 'A' : 'B'}; moves said ${x.success}/${y.success}`);
});

test('a staff upload and "Take off" of the only certificate at the same moment end with the record matching the files', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  world.ai = GOOD('TKO Plumbing LLC', '2027-03-01');
  const first = await upload(VENDOR, 'coi', await pdfBytes('old cert'), 'old.pdf');
  world.ai = GOOD('TKO Plumbing LLC', '2027-09-09');
  const [, rm] = await Promise.all([upload(VENDOR, 'coi', await pdfBytes('new cert'), 'new.pdf'), admin({ action: 'remove-file', fileId: first.vendor.files[0].id })]);
  const p = await readPapers(env.DB, VENDOR);
  assert.equal(p.glExpires, '2027-09-09', `the new certificate is on file but liability says ${p.glExpires} (take-off changed ${JSON.stringify(rm.changed)})`);
});

// ─── Merge and moves interleaved ────────────────────────────────────

test('a file moved onto a site company while that company is being merged ends on the JobTread vendor', async () => {
  Object.assign(jtVals(), { 'F-W9': false });
  await readVendor(env, VENDOR, { now: NOW });
  const s = await addSiteVendor(env, { name: 'TKO Plumbing Services' }, { now: NOW });
  const other = await addSiteVendor(env, { name: 'Wiggins Law Group' }, { now: NOW });
  const w = await keepFile(env, other.id, { doc: 'w9', bytes: PDF, type: 'application/pdf', name: 'W9.pdf', source: 'staff', status: 'checked' }, { now: NOW });
  await Promise.all([admin({ action: 'merge', id: s.id, jtId: VENDOR }), admin({ action: 'move-file', fileId: w.file.id, toId: s.id })]);
  const f = await readFile(env.DB, w.file.id);
  const orphan = !(await readPapers(env.DB, f.vendorId)) && f.vendorId === s.id;
  assert.equal(orphan, false, 'the W-9 is on a company that no longer exists (merged away): nobody can see it');
});

// ─── Site company page ──────────────────────────────────────────────

test('a site company asked for its W-9 only: the email and page never mention insurance or bank details', async () => {
  const s = await addSiteVendor(env, { name: 'Capin Crouse LLP', email: 'ap@capin.example' }, { now: NOW });
  world.emails = [];
  const j = await admin({ action: 'ask', id: s.id });
  assert.equal(j.success, true, j.error);
  const mail = world.emails[0];
  assert.ok(!/insurance|certificate|bank/i.test(`${mail.subject} ${mail.text}`), `the W-9-only email speaks of insurance or bank details:\n${mail.text}`);
});

test('"W-9 only" set on a JobTread vendor by a person, then a hand edit of Documents in JobTread to "Current": the record follows JobTread', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  await admin({ action: 'set', id: VENDOR, docs: 'W-9 only' });
  assert.equal(jtVals()['F-DOCS'], 'W-9 only');
  jtVals()['F-DOCS'] = 'Missing';
  const v = await readVendor(env, VENDOR, { now: NOW + 1000 });
  assert.equal(v.docs, 'Missing', 'a person changed Documents in JobTread; the site kept "W-9 only"');
});

// ─── Put back / move: only what the file proved on this company ──────

test('"Take off" then "Put back" of a certificate under the minimums leaves the company as it was (not insured)', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  // The certificate search kept it as 'checked'; its $300k liability is under the $1M minimum, so the dates never moved
  const low = { insured: 'TKO Plumbing LLC', policies: [
    { kind: 'general liability', insurer: 'Hartford', effective: '2026-01-01', expires: '2027-06-21', eachOccurrence: 300000, aggregate: 600000 },
    { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-01-01', expires: '2027-06-21', employersLiabilityEachAccident: 1000000 },
  ] };
  const k = await keepFile(env, VENDOR, { doc: 'coi', bytes: PDF, type: 'application/pdf', name: 'COI low.pdf', source: 'search', status: 'checked', summary: 'Found in a staff email', reading: low }, { now: NOW });
  const before = await readPapers(env.DB, VENDOR);
  assert.equal(before.glExpires, null, 'setup: under the minimums, liability is not on file');
  await admin({ action: 'remove-file', fileId: k.file.id });
  const j = await admin({ action: 'restore-file', fileId: k.file.id });
  assert.deepEqual({ gl: j.vendor.gl, label: j.vendor.label }, { gl: null, label: 'Missing' }, `"Put back" made a $300k certificate count as their liability (changed ${JSON.stringify(j.changed)})`);
});

test('"I looked at it" on an unreadable W-9, then Take off and Put back: the W-9 is still not on file (nobody said it was good)', async () => {
  Object.assign(jtVals(), { 'F-W9': false, 'F-GL': '2027-06-01', 'F-WC': '2027-06-01' });
  await readVendor(env, VENDOR, { now: NOW });
  const look = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF2, type: 'application/pdf', name: 'w9 blurry.pdf', source: 'page', status: 'look' }, { now: NOW });
  const seen = await admin({ action: 'file', fileId: look.file.id, status: 'checked' });
  assert.equal(seen.vendor.w9, false, 'setup: looking at it does not mark the W-9 on file');
  await admin({ action: 'remove-file', fileId: look.file.id });
  const j = await admin({ action: 'restore-file', fileId: look.file.id });
  assert.deepEqual({ w9: j.vendor.w9, label: j.vendor.label, jt: jtVals()['F-W9'] }, { w9: false, label: 'Missing', jt: false }, 'Put back marked an unreadable W-9 on file (and in JobTread)');
});

test('a certificate under the minimums moved to the company it belongs to does not make that company insured', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const s = await addSiteVendor(env, { name: 'Wiggins Roofing' }, { now: NOW });
  await admin({ action: 'set', id: s.id, docs: null, w9: true });
  const low = { insured: 'Wiggins Roofing', policies: [
    { kind: 'general liability', insurer: 'Hartford', effective: '2026-01-01', expires: '2027-06-21', eachOccurrence: 300000, aggregate: 600000 },
    { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-01-01', expires: '2027-06-21', employersLiabilityEachAccident: 1000000 },
  ] };
  const k = await keepFile(env, VENDOR, { doc: 'coi', bytes: PDF, type: 'application/pdf', name: 'COI Wiggins.pdf', source: 'search', status: 'checked', reading: low }, { now: NOW });
  const j = await admin({ action: 'move-file', fileId: k.file.id, toId: s.id });
  const p = await readPapers(env.DB, s.id);
  assert.equal(p.glExpires, null, `Wiggins now shows liability to ${p.glExpires} from a $300k certificate (to: ${JSON.stringify(j.changed?.to)})`);
});

// ─── Ramp: a site company's bill is never held ───────────────────────

test('a Ramp bill for a company the payee search keeps as a site company is never matched to (and held on) a JobTread vendor', async () => {
  const { matchRampBill } = await import('../functions/api/_ramp.js');
  env.RAMP_CLIENT_ID = 'id'; env.RAMP_CLIENT_SECRET = 'secret';
  await env.DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind('jt_WG1', 'Wiggins', 'wiggins', 'WG1', 'joe@wiggins-plumbing.example', '{}', 'x', 'x').run();
  world.rampBills = [{ id: 'RB1', vendor: { id: 'rv1', name: 'Wiggins Law Group' }, amount: { amount: 120000, currency_code: 'USD' }, issued_at: new Date(NOW - DAY).toISOString(), created_at: new Date(NOW - DAY).toISOString(), status: 'OPEN' }];
  await findPayees(env, { now: NOW, force: true });
  const site = (await env.DB.prepare("SELECT id, name FROM vendor_papers WHERE id LIKE 's\\_%' ESCAPE '\\'").all()).results;
  assert.deepEqual(site.map((r) => r.name), ['Wiggins Law Group'], 'setup: the payee search says it is not the JobTread vendor "Wiggins"');
  // As the hold run calls it: with the name keys of the companies kept on the site (./_ramp.js runRamp)
  const { nameKeyOf } = await import('../functions/api/_vendor-files.js');
  const siteNames = new Set(site.map((r) => nameKeyOf(r.name)));
  const m = matchRampBill({ id: 'RB1', vendor: 'Wiggins Law Group', cents: 120000, invoice: null }, [], [{ jtId: 'WG1', name: 'Wiggins' }, { jtId: VENDOR, name: 'TKO Plumbing' }], siteNames);
  assert.equal(matchRampBill({ id: 'RB2', vendor: 'Wiggins', cents: 5000, invoice: null }, [], [{ jtId: 'WG1', name: 'Wiggins' }], siteNames)?.accountId, 'WG1', 'the JobTread vendor\'s own bills still match it');
  assert.equal(m, null, `the Ramp hold logic says the bill is JobTread vendor ${m?.accountId}'s: held on Wiggins' papers, and Wiggins emailed about it`);
});

// ─── Slack: a "Check their W-9" card goes once a person deals with it in the admin ───

const openCards = async () => (await env.DB.prepare('SELECT key FROM slack_open_posts').all().catch(() => ({ results: [] }))).results.map((r) => r.key);

test('a site company\'s unreadable W-9 posts "Check its W-9"; staff marking the W-9 on file in the admin resolves that card', async () => {
  const s = await addSiteVendor(env, { name: 'Capin Crouse LLP', email: 'ap@capin.example' }, { now: NOW });
  const link = await createLink(env.DB, s.id, { now: NOW });
  world.ai = { isW9: false, readable: false };
  const body = new FormData();
  body.set('token', link.token); body.set('doc', 'w9'); body.append('file', new File([JPG], 'w9.jpg', { type: 'image/jpeg' }));
  const d = await (await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) })).json();
  assert.equal(d.look, true, `setup: it waits on a person (${JSON.stringify(d)})`);
  assert.ok((await openCards()).some((k) => k.includes(s.id)), `setup: a Slack card is open (${JSON.stringify(await openCards())})`);
  const j = await admin({ action: 'set', id: s.id, w9: true });
  assert.equal(j.vendor.label, 'W-9 only', 'setup: they are done');
  assert.deepEqual((await openCards()).filter((k) => k.includes(s.id)), [], 'the Slack card asking someone to check their W-9 stays open after it was dealt with in the admin');
});

test('a JobTread vendor\'s unreadable certificate: "I looked at it" plus the dates typed in the admin resolves the Slack card', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  world.ai = { isCertificate: false, readable: false };
  const body = new FormData();
  body.set('token', link.token); body.set('doc', 'coi'); body.append('file', new File([PDF], 'coi.pdf', { type: 'application/pdf' }));
  const d = await (await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) })).json();
  assert.equal(d.look, true, `setup: it waits on a person (${JSON.stringify(d)})`);
  const j = await admin({ action: 'set', id: VENDOR, gl: '2027-06-01', wc: '2027-06-01' });
  assert.equal(j.vendor.label, 'Current');
  assert.deepEqual((await openCards()).filter((k) => k.includes(VENDOR)), [], 'still open in Slack');
});

test('after the only certificate is taken off (or moved away), JobTread\'s Insurance Check no longer describes it', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  world.ai = GOOD('Wiggins Roofing');
  const up = await upload(VENDOR, 'coi', await pdfBytes('Wiggins COI 2'), 'wiggins.pdf');
  const check = jtVals()['F-CHECK'];
  assert.ok(check, 'setup: Insurance Check was written');
  const j = await admin({ action: 'remove-file', fileId: up.vendor.files[0].id });
  assert.deepEqual({ gl: jtVals()['F-GL'], check: jtVals()['F-CHECK'] }, { gl: null, check: null }, `JobTread's Insurance Check still reads "${jtVals()['F-CHECK']}" with liability cleared (changed ${JSON.stringify(j.changed)})`);
});

test('a JobTread vendor with no email gets one from its page: onto its JobTread contacts as the main contact, never over one', async () => {
  world.vendors[VENDOR].email = null;
  await env.DB.prepare('UPDATE vendors SET email = NULL WHERE jt_id = ?').bind(VENDOR).run();
  assert.equal((await admin({ action: 'edit', id: VENDOR, email: 'not an email' })).success, false);
  // Their insurance agent's email isn't the company's
  world.vendors[VENDOR].agent = 'ann@agency.example';
  let r = await admin({ action: 'edit', id: VENDOR, email: 'ann@agency.example' });
  assert.deepEqual([r.success, r.error], [false, 'That’s their insurance agent’s email. Add the company’s own.']);
  r = await admin({ action: 'edit', id: VENDOR, email: ' Office@TKO.example ' });
  assert.equal(r.success, true, r.error);
  assert.equal(r.vendor.email, 'office@tko.example');
  assert.deepEqual(world.contactsMade.map((c) => [c.accountId, c.title, c.customFieldValues]), [[VENDOR, 'Main contact', { 'VC-EMAIL': 'office@tko.example' }]]);
  // The list (JobTread's vendors as last read) has it now, not after the next read
  assert.equal((await env.DB.prepare('SELECT email FROM vendors WHERE jt_id = ?').bind(VENDOR).first()).email, 'office@tko.example');
  // One they have is changed in JobTread
  r = await admin({ action: 'edit', id: VENDOR, email: 'new@tko.example' });
  assert.deepEqual([r.success, r.error], [false, 'Their email is office@tko.example, on their JobTread contacts. Change it in JobTread.']);
  assert.equal(world.contactsMade.length, 1);
  // It's in History under who added it
  assert.ok((await env.DB.prepare("SELECT entity_name FROM audit_log WHERE entity_slug = ? AND entity_name LIKE '%added to JobTread'").bind(VENDOR).first()), 'History says who added the email');
});

test('a site company\'s email changed by staff: the old address no longer gets a sign-in link to its W-9 page', async () => {
  const s = await addSiteVendor(env, { name: 'Capin Crouse LLP', email: 'wrong@someone-else.example' }, { now: NOW });
  await admin({ action: 'ask', id: s.id });
  assert.equal((await admin({ action: 'edit', id: s.id, email: 'ap@capin.example' })).success, true);
  world.emails = [];
  const { signIn } = await import('../functions/api/_trade-partners.js');
  await signIn(env, 'wrong@someone-else.example', { now: NOW + 1000 });
  assert.equal(world.emails.length, 0, `the address staff replaced still gets a link: ${world.emails[0]?.subject}`);
});

test('the sample "preview" company is not a company the admin can write a record or file for', async () => {
  const j = await admin({ action: 'set', id: 'preview', w9: true });
  const row = await readPapers(env.DB, 'preview');
  assert.deepEqual({ ok: j.success, row: !!row }, { ok: false, row: false }, `the admin saved papers for the fake sample company: ${JSON.stringify(row && { w9: row.w9, docs: row.docs })}`);
});

test('"Get started" with a site company\'s name and no email on file sends its W-9 link to nobody who only typed the name', async () => {
  const s = await addSiteVendor(env, { name: 'Capin Crouse LLP' }, { now: NOW });
  const { startPartner } = await import('../functions/api/_trade-partners.js');
  world.emails = [];
  await startPartner(env, { company: 'Capin Crouse LLP', name: 'Someone', email: 'anyone@elsewhere.example', phone: '404-555-0100' }, { now: NOW });
  const p = await readPapers(env.DB, s.id);
  assert.deepEqual({ to: world.emails[0]?.to?.[0] || null, saved: p.email }, { to: null, saved: null }, 'a stranger got the W-9 page for the company, and became its email on file');
});

// ─── What the fourth round of testing broke, kept broken-proof ──────

const GOOD4 = (insured = 'TKO Plumbing LLC', end = '2027-06-21') => coi({ insured, policies: [
  { kind: 'general liability', insurer: 'Hartford', effective: '2026-01-01', expires: end, eachOccurrence: 1000000, aggregate: 2000000 },
  { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-01-01', expires: end, employersLiabilityEachAccident: 1000000 },
] });
const JPG4 = (n) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, n, n]);
const up4 = (id, doc, bytes, name = 'file.pdf', type = 'application/pdf', pages = []) => {
  const fd = new FormData();
  fd.set('id', id); fd.set('doc', doc); fd.append('file', new File([bytes], name, { type }));
  pages.forEach((p, i) => fd.append('pages0', new File([p], `page-${i + 1}.jpg`, { type: 'image/jpeg' })));
  return admin(fd);
};
const pdf4 = async (text) => {
  const { PDFDocument: PD, StandardFonts: SF } = await import('pdf-lib');
  const d = await PD.create(); const p = d.addPage([612, 792]);
  p.drawText(text, { x: 50, y: 700, size: 14, font: await d.embedFont(SF.Helvetica) });
  return d.save();
};
const openCards4 = async () => (await env.DB.prepare('SELECT key FROM slack_open_posts').all().catch(() => ({ results: [] }))).results.map((r) => r.key);

// ─── Money and records ──────────────────────────────────────────────

test('a staff-added certificate that fails either way, read two ways that disagree on its end date, never moves the record to the later (generous) reading', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  // Liability only (workers' comp comes on a certificate of its own), so it fails at either reading; the text says it
  // ends 2026-12-01, the page picture says 2027-12-01
  const gl = (end) => ({ isCertificate: true, readable: true, insured: 'TKO Plumbing LLC', certificateHolder: 'Sunshine on a Ranney Day',
    policies: [{ kind: 'general liability', insurer: 'Hartford', effective: '2025-12-01', expires: end, eachOccurrence: 1000000, aggregate: 2000000 }] });
  env.AI.run = async (model, input) => ({ response: JSON.stringify(input?.messages || '').includes('image_url') ? gl('2027-12-01') : gl('2026-12-01') });
  const j = await up4(VENDOR, 'coi', await pdf4('GL only'), 'gl.pdf', 'application/pdf', [JPG4(1)]);
  assert.equal(j.success, true, j.error);
  const f = j.vendor.files[0];
  assert.deepEqual({ gl: j.vendor.gl, jt: jtVals()['F-GL'] ?? null, proves: (await readFile(env.DB, f.id)).proves },
    { gl: '2026-12-01', jt: '2026-12-01', proves: { gl: '2026-12-01' } },
    `a failing certificate's disputed date was recorded at its most generous reading (result ${JSON.stringify(j.result.changed)}, summary "${f.summary}")`);
});

test('a certificate copied in from JobTread proves no workers’ comp when the search read its employer’s liability under the minimum', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const { ensureCoverageSchema, recordCoverage, provenDates } = await import('../functions/api/_coi-backfill.js');
  await ensureCoverageSchema(env.DB);
  const pol = [
    { kind: 'general liability', insurer: 'Hartford', effective: '2026-06-21', expires: '2027-06-21', eachOccurrence: 1000000, aggregate: 2000000 },
    { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-06-21', expires: '2027-06-21', employersLiabilityEachAccident: 50000 },
  ];
  assert.deepEqual(provenDates({ policies: pol }, DEFAULTS), { gl: '2027-06-21' }, 'setup: read as the search reads it, only liability is proven');
  await recordCoverage(env, { jtId: VENDOR, insured: 'TKO', policies: pol, source: 'gmail', fileHash: await sha256(PDF), now: NOW });
  world.vendors[VENDOR].files = [{ id: 'F1', name: 'COI TKO.pdf', folder: 'W-9 & Insurance', size: PDF.length, createdAt: '2026-06-22T12:00:00Z', tags: ['T-COI'] }];
  world.fileBytes = { F1: PDF };
  const ids = await jtSetup(env);
  await importJobTread(env, { now: NOW, tags: ids.tags });
  const f = (await filesOf(env.DB, VENDOR))[0];
  // What that does later: taken off and put back, the company shows workers' comp from it
  await admin({ action: 'remove-file', fileId: f.id });
  const back = await admin({ action: 'restore-file', fileId: f.id });
  assert.deepEqual({ proves: f.proves, wcAfterPutBack: back.vendor.wc }, { proves: { gl: '2027-06-21' }, wcAfterPutBack: null },
    'the import rebuilds the reading from coi_coverage without employer’s liability (each_cents is mapped to eachOccurrence), so an under-minimum workers’ comp is proven');
});

test('the import never widens what a file the search already kept proves (same bytes, its reading rebuilt without employer’s liability)', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  const { ensureCoverageSchema, recordCoverage } = await import('../functions/api/_coi-backfill.js');
  await ensureCoverageSchema(env.DB);
  const pol = [
    { kind: 'general liability', insurer: 'Hartford', effective: '2026-06-21', expires: '2027-06-21', eachOccurrence: 1000000, aggregate: 2000000 },
    { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-06-21', expires: '2027-06-21', employersLiabilityEachAccident: 50000 },
  ];
  // The search found it in JobTread and kept it (its own source_ref), proving liability only
  const k = await keepFile(env, VENDOR, { doc: 'coi', bytes: PDF, type: 'application/pdf', name: 'COI found.pdf', source: 'jobtread', sourceRef: 'jt:row1', status: 'checked', reading: { policies: pol }, proves: { gl: '2027-06-21' } }, { now: NOW });
  await recordCoverage(env, { jtId: VENDOR, insured: 'TKO', policies: pol, source: 'jt', fileHash: await sha256(PDF), now: NOW });
  world.vendors[VENDOR].files = [{ id: 'F1', name: 'COI TKO.pdf', folder: 'W-9 & Insurance', size: PDF.length, createdAt: '2026-06-22T12:00:00Z', tags: ['T-COI'] }];
  world.fileBytes = { F1: PDF };
  const ids = await jtSetup(env);
  await importJobTread(env, { now: NOW, tags: ids.tags });
  assert.deepEqual((await readFile(env.DB, k.file.id)).proves, { gl: '2027-06-21' }, 'the import added workers’ comp to what a checked file proves');
});

test('a Ramp bill for a site company is not matched to a look-alike JobTread vendor that has a JobTread bill of the same amount', async () => {
  const { matchRampBill } = await import('../functions/api/_ramp.js');
  const { nameKeyOf } = await import('../functions/api/_vendor-files.js');
  const siteNames = new Set([nameKeyOf('Wiggins Law Group')]);
  // The plumber "Wiggins" has a $1,200 bill in JobTread; the law firm (a site company) bills $1,200 through Ramp
  const m = matchRampBill({ id: 'RB1', vendor: 'Wiggins Law Group', cents: 120000, invoice: null },
    [{ id: 'JB1', vendor: 'Wiggins', cents: 120000, number: '88', date: '2026-10-01', accountId: 'WG1' }], [{ jtId: 'WG1', name: 'Wiggins' }], siteNames);
  assert.equal(m, null, `the law firm's Ramp bill is matched to JobTread vendor ${m?.accountId} (bill ${m?.jtBillId}): held on the plumber's papers`);
});

test('"Get started" with a site company’s exact name never invites the typist onto a look-alike JobTread vendor (contact added, full page sent)', async () => {
  const s = await addSiteVendor(env, { name: 'Smith Accounting' }, { now: NOW });
  await env.DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('jt_SAG1', 'Smith Accounting Group', 'smith accounting group', 'SAG1', null, '{}', 'x', 'x').run();
  world.vendors.SAG1 = { name: 'Smith Accounting Group', email: null, values: {}, files: [] };
  const contacts = [];
  const f0 = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.host === 'api.jobtread.com') {
      const { query } = JSON.parse(init.body);
      if (query.createContact) { contacts.push(query.createContact.$); return Response.json({ createContact: { createdContact: { id: 'CN9' } } }); }
      if (query.updateContact) { contacts.push(query.updateContact.$); return Response.json({}); }
    }
    return f0(input, init);
  };
  const { startPartner } = await import('../functions/api/_trade-partners.js');
  world.emails = [];
  let r; let err = null;
  try { r = await startPartner(env, { company: 'Smith Accounting', name: 'Someone', email: 'anyone@elsewhere.example', phone: '404-555-0100' }, { now: NOW }); } catch (e) { err = e.message; } finally { globalThis.fetch = f0; }
  assert.deepEqual({ how: r?.how || null, emailed: world.emails.map((e) => `${e.to[0]}: ${e.subject}`), contactsAdded: contacts.length },
    { how: 'staff', emailed: [], contactsAdded: 0 }, `site company ${s.id} "Smith Accounting" (no email) was skipped for the JobTread look-alike "Smith Accounting Group" (${err || ''})`);
});

test('a passing certificate moved onto the company where the same file waits on a person: that company gets the dates (nothing lost)', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  const s = await addSiteVendor(env, { name: 'Wiggins Roofing', email: 'office@wiggins.example' }, { now: NOW });
  await admin({ action: 'set', id: s.id, docs: null, w9: true });
  const bytes = await pdf4('Wiggins COI');
  // Their own page couldn't read it (waiting on a person) …
  await keepFile(env, s.id, { doc: 'coi', bytes, type: 'application/pdf', name: 'COI Wiggins.pdf', source: 'page', status: 'look', summary: 'Couldn’t be read automatically' }, { now: NOW });
  // … and staff added the same file to TKO by mistake, where it passed
  world.ai = GOOD4('Wiggins Roofing');
  const on = await up4(VENDOR, 'coi', bytes, 'wiggins.pdf');
  assert.equal(on.vendor.gl, '2027-06-21', 'setup: it passed on TKO');
  const j = await admin({ action: 'move-file', fileId: on.vendor.files[0].id, toId: s.id });
  assert.equal(j.success, true, j.error);
  const there = (await adminRead(`?id=${s.id}`).then((r) => r.json())).vendor;
  assert.deepEqual({ gl: there.gl, wc: there.wc, label: there.label }, { gl: '2027-06-21', wc: '2027-06-21', label: 'Current' },
    `Wiggins' copy is now ${there.files.map((f) => `${f.status}`).join(',')} (no longer waiting) but proves nothing, and TKO lost the dates: the passing certificate's proof is gone (changed ${JSON.stringify(j.changed)})`);
});

test('a date typed by hand before a certificate showing the same date came in stays when that certificate is taken off', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  // Someone types the dates from the agent's phone call (nothing waiting)
  const typed = await admin({ action: 'set', id: VENDOR, gl: '2027-06-21', wc: '2027-06-21' });
  assert.equal(typed.vendor.label, 'Current');
  // Then a certificate for the wrong company with the same end dates is added and taken off again
  world.ai = GOOD4('Wiggins Roofing');
  const up = await up4(VENDOR, 'coi', await pdf4('Wiggins again'), 'wiggins.pdf');
  const j = await admin({ action: 'remove-file', fileId: up.vendor.files[0].id });
  assert.deepEqual({ gl: j.vendor.gl, wc: j.vendor.wc }, { gl: '2027-06-21', wc: '2027-06-21' }, `taking off a file that set nothing cleared the typed dates (changed ${JSON.stringify(j.changed)})`);
});

test('a certificate relabeled as a W-9 and back gets its Insurance Check words back with its dates', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  world.ai = GOOD4();
  const up = await up4(VENDOR, 'coi', await pdf4('TKO COI'), 'tko.pdf');
  const check = up.vendor.check;
  assert.ok(check, 'setup');
  const fid = up.vendor.files[0].id;
  await admin({ action: 'move-file', fileId: fid, doc: 'w9' });
  const back = await admin({ action: 'move-file', fileId: fid, doc: 'coi' });
  assert.equal(back.vendor.gl, '2027-06-21', 'after the round trip the dates are back');
  assert.match(back.vendor.check || '', /June 21, 2027|2027-06-21/, 'and the Insurance Check describes the certificate again (never left empty)');
});

// ─── Stale pages ────────────────────────────────────────────────────

test('stale pages: no shown*, a file put back meanwhile, "I looked at it" after someone took it off: each refused with the company as it is', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  world.ai = GOOD4();
  const up = await up4(VENDOR, 'coi', await pdf4('stale'), 's.pdf');
  const fid = up.vendor.files[0].id;
  const bare = await adminPost({ env, data: { userEmail: 'a@soardcharity.org' }, request: new Request('https://x.example/api/vendor-papers-admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove-file', fileId: fid }) }) });
  assert.equal(bare.status, 409, 'a file action without shownOn/shownAs');
  await admin({ action: 'remove-file', fileId: fid });
  await admin({ action: 'restore-file', fileId: fid });
  const twice = await admin({ action: 'restore-file', fileId: fid, shownOn: VENDOR, shownAs: 'removed' });
  assert.equal(twice.success, false, 'a second "Put back" from a page that still shows it taken off');
  assert.equal(twice.vendor?.files?.length, 1, 'the 409 carries the company as it is now');
  const look = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF2, type: 'application/pdf', name: 'w9.pdf', source: 'page', status: 'look' }, { now: NOW });
  await admin({ action: 'remove-file', fileId: look.file.id });
  const seen = await admin({ action: 'file', fileId: look.file.id, status: 'checked', shownOn: VENDOR, shownAs: 'look' });
  assert.equal(seen.success, false, '"I looked at it" on a file taken off meanwhile');
  assert.equal((await readFile(env.DB, look.file.id)).status, 'removed');
});

// ─── Private storage only ───────────────────────────────────────────

test('without VENDOR_FILES: staff upload, a vendor’s upload and a signed W-9 each fail without changing the record; the admin says so', async () => {
  Object.assign(jtVals(), { 'F-W9': false, 'F-GL': '2026-01-01', 'F-WC': '2026-01-01' });
  await readVendor(env, VENDOR, { now: NOW });
  delete env.VENDOR_FILES;
  world.updates = [];
  world.ai = W9OK4();
  const staff = await up4(VENDOR, 'w9', JPG4(5), 'w9.jpg', 'image/jpeg');
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const body = new FormData();
  body.set('token', link.token); body.set('doc', 'w9'); body.append('file', new File([JPG4(6)], 'w9.jpg', { type: 'image/jpeg' }));
  const page = await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) });
  const { signW9 } = await import('../functions/api/_trade-partners.js');
  let signed = null;
  try { await signW9(env, (await findLink(env.DB, link.token, NOW)).link, { name: 'Tom Kowalski', business: 'TKO Plumbing LLC', taxClass: 'llc', llcClass: 'S', address: '12 Example Lane', cityStateZip: 'Decatur, GA 30030', tinType: 'ein', tin: '12-3456789', certify: true, signature: 'Tom Kowalski' }, { now: NOW }); signed = 'ok'; } catch (e) { signed = e.message; }
  const p = await readPapers(env.DB, VENDOR);
  const ids = await jtSetup(env);
  assert.deepEqual({ staff: staff.success, page: page.status, w9: p.w9, jtW9: jtVals()['F-W9'], writes: world.updates.length, import: await importJobTread(env, { now: NOW, tags: ids.tags }) },
    { staff: false, page: 500, w9: false, jtW9: false, writes: 0, import: null }, `signW9: ${signed}; staff error: ${staff.error}`);
  assert.notEqual(signed, 'ok');
  console.log('P9 messages:', JSON.stringify({ staff: staff.error, page: await page.json(), signed }));
});

test('a site company’s "Check its W-9" Slack card goes once it is moved onto its JobTread vendor and the W-9 is dealt with there', async () => {
  Object.assign(jtVals(), { 'F-W9': false });
  await readVendor(env, VENDOR, { now: NOW });
  const s = await addSiteVendor(env, { name: 'TKO Plumbing Services', email: 'ap@tko.example' }, { now: NOW });
  const link = await createLink(env.DB, s.id, { now: NOW });
  world.ai = { isW9: false, readable: false };
  const body = new FormData();
  body.set('token', link.token); body.set('doc', 'w9'); body.append('file', new File([JPG4(7)], 'w9.jpg', { type: 'image/jpeg' }));
  await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) });
  assert.ok((await openCards4()).some((k) => k.includes(s.id)), 'setup: a card is open');
  await admin({ action: 'merge', id: s.id, jtId: VENDOR });
  await admin({ action: 'set', id: VENDOR, w9: true });
  assert.deepEqual((await openCards4()).filter((k) => k.includes(s.id)), [], 'the merged company’s card stays open in Slack forever (its vendor_asks row was deleted, so nothing can resolve it)');
});

test('"Get started" for a site company taken off the list sends nothing and posts nothing', async () => {
  const s = await addSiteVendor(env, { name: 'Capin Crouse LLP', email: 'ap@capin.example' }, { now: NOW });
  await admin({ action: 'archive', id: s.id, archived: true });
  const { startPartner } = await import('../functions/api/_trade-partners.js');
  world.emails = []; world.slack = [];
  const r = await startPartner(env, { company: 'Capin Crouse', name: 'Someone', email: 'anyone@elsewhere.example', phone: '404-555-0100' }, { now: NOW });
  assert.deepEqual({ how: r.how, emails: world.emails.length, slack: world.slack.length }, { how: 'off-list', emails: 0, slack: 0 });
});

function W9OK4(name = 'TKO Plumbing LLC') { return { isW9: true, readable: true, name, hasTaxId: true, signed: true, signedDate: '2026-10-01' }; }

// ─── Slack cards: "Check X's W-9" once nothing waits ─────────────────

const lookCard4 = async (doc = 'w9') => {
  Object.assign(jtVals(), { 'F-W9': false });
  await readVendor(env, VENDOR, { now: NOW });
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  world.ai = doc === 'w9' ? { isW9: false, readable: false } : { isCertificate: false, readable: false };
  const body = new FormData();
  body.set('token', link.token); body.set('doc', doc); body.append('file', new File([JPG4(30)], 'x.jpg', { type: 'image/jpeg' }));
  const d = await (await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) })).json();
  assert.equal(d.look, true, 'setup: waiting on a person');
  assert.ok((await openCards4()).some((k) => k === `vendor:look:${VENDOR}`), `setup: card open ${JSON.stringify(await openCards4())}`);
  return link;
};

test('a JobTread vendor’s "Check its W-9" card goes when staff add a good W-9 in the admin (nothing waits any more; insurance still missing)', async () => {
  await lookCard4('w9');
  world.ai = W9OK4();
  const j = await up4(VENDOR, 'w9', JPG4(31), 'w9-good.jpg', 'image/jpeg');
  assert.equal(j.vendor.w9, true, 'setup');
  assert.equal(j.vendor.files.filter((f) => f.status === 'look').length, 0, 'setup: nothing waits on a person');
  assert.deepEqual((await openCards4()).filter((k) => k.includes('look')), [], 'the card asking someone to check the W-9 stays open in Slack after a good W-9 replaced it');
});

test('… and when the vendor sends a good W-9 on their own page', async () => {
  const link = await lookCard4('w9');
  world.ai = W9OK4();
  const body = new FormData();
  body.set('token', link.token); body.set('doc', 'w9'); body.append('file', new File([JPG4(32)], 'w9.jpg', { type: 'image/jpeg' }));
  const d = await (await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body }) })).json();
  assert.equal(d.accepted, true, 'setup');
  assert.deepEqual((await openCards4()).filter((k) => k.includes('look')), [], 'still open after their good W-9 settled the unreadable one');
});

test('"I looked at it" then typing the dates (the order the card suggests) leaves the certificate proving nothing; dates first attaches them', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  const a = await keepFile(env, VENDOR, { doc: 'coi', bytes: PDF, type: 'application/pdf', name: 'COI blurry.pdf', source: 'page', status: 'look' }, { now: NOW });
  await admin({ action: 'file', fileId: a.file.id, status: 'checked' });
  await admin({ action: 'set', id: VENDOR, gl: '2027-06-21', wc: '2027-06-21' });
  const j = await admin({ action: 'remove-file', fileId: a.file.id });
  assert.deepEqual({ gl: j.vendor.gl, proves: (await readFile(env.DB, a.file.id)).proves }, { gl: null, proves: { gl: '2027-06-21', wc: '2027-06-21' } },
    'the only certificate was taken off, yet the dates typed from it stay (it was marked looked-at before the dates were typed, so it proves nothing)');
});

// ─── Randomized: the record is what the files on it prove ───────────

test('randomized: with no hand edits, each company’s W-9 and dates are exactly what its files on the list prove', async () => {
  const pool = [
    { kind: 'coi', gl: '2027-03-01', wc: '2027-03-01', ok: true },
    { kind: 'coi', gl: '2027-09-01', wc: '2027-09-01', ok: true },
    { kind: 'coi', gl: '2027-06-01', wc: null, ok: true },
    { kind: 'coi', gl: '2027-12-01', wc: '2027-12-01', ok: false },   // under the minimums
    { kind: 'w9', ok: true }, { kind: 'w9', ok: false },
  ];
  let seed = Number(process.env.SEED || 7);
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const runs = Number(process.env.RUNS || 6);
  const fails = [];
  for (let run = 0; run < runs && !fails.length; run++) {
    world = fresh();
    const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)', 'CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)'] });
    env.DB = DB; env.VENDOR_FILES = createR2();
    await ensureSpendSchema(DB); await ensureBillPaySchema(DB); await ensureVendorSchema(DB); await ensurePartnerSchema(DB);
    await writeSlackConfig(DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
    await DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(`jt_${VENDOR}`, 'TKO Plumbing', 'tko plumbing', VENDOR, 'office@tko.example', '{}', 'x', 'x').run();
    await readVendor(env, VENDOR, { now: NOW });
    const s = await addSiteVendor(env, { name: 'Wiggins Roofing' }, { now: NOW });
    await admin({ action: 'set', id: s.id, docs: null });
    const ids = [VENDOR, s.id];
    const bytesOf = {};
    const log = [];
    for (let step = 0; step < 18; step++) {
      const all = (await env.DB.prepare('SELECT * FROM vendor_files').all()).results;
      const active = all.filter((f) => f.status !== 'removed');
      const removed = all.filter((f) => f.status === 'removed');
      const pick = rnd(10);
      let what;
      if (pick < 4 || !all.length) {
        const n = rnd(pool.length); const d = pool[n]; const to = ids[rnd(2)];
        bytesOf[n] ||= await pdf4(`doc ${n} run ${run}`);
        // P21 covers the same bytes sent again as the other kind; left out here
        if (process.env.SKIP_CROSS && (await env.DB.prepare('SELECT 1 FROM vendor_files WHERE vendor_id = ? AND hash = ? AND doc != ?').bind(to, await sha256(bytesOf[n]), d.kind).first())) continue;
        world.ai = d.kind === 'w9' ? (d.ok ? W9OK4() : { isW9: true, readable: true, name: 'TKO Plumbing LLC', hasTaxId: true, signed: false })
          : coi({ policies: [
            { kind: 'general liability', insurer: 'H', effective: '2026-01-01', expires: d.gl, eachOccurrence: d.ok ? 1000000 : 300000, aggregate: 2000000 },
            ...(d.wc ? [{ kind: 'workers compensation', insurer: 'T', effective: '2026-01-01', expires: d.wc, employersLiabilityEachAccident: 1000000 }] : []),
          ] });
        const j = await up4(to, d.kind, bytesOf[n], `doc${n}.pdf`);
        what = `upload doc${n}(${d.kind}${d.ok ? '' : ' failing'}) to ${to === VENDOR ? 'TKO' : 'S'} → ${j.success ? (j.result.duplicate ? 'dup' : 'ok') : j.error}`;
      } else if (pick < 6 && active.length) {
        const f = active[rnd(active.length)];
        const j = await admin({ action: 'remove-file', fileId: f.id });
        what = `remove ${f.name}@${f.vendor_id === VENDOR ? 'TKO' : 'S'} → ${j.success}`;
      } else if (pick < 7 && removed.length) {
        const f = removed[rnd(removed.length)];
        const j = await admin({ action: 'restore-file', fileId: f.id });
        what = `restore ${f.name}@${f.vendor_id === VENDOR ? 'TKO' : 'S'} → ${j.success}`;
      } else if (pick < 8 && active.length) {
        const f = active[rnd(active.length)];
        const j = await admin({ action: 'move-file', fileId: f.id, doc: f.doc === 'w9' ? 'coi' : 'w9' });
        what = `relabel ${f.name}(${f.doc})@${f.vendor_id === VENDOR ? 'TKO' : 'S'} → ${j.success}`;
      } else if (active.length) {
        const f = active[rnd(active.length)];
        const to = f.vendor_id === VENDOR ? s.id : VENDOR;
        const j = await admin({ action: 'move-file', fileId: f.id, toId: to });
        what = `move ${f.name}(${f.doc})@${f.vendor_id === VENDOR ? 'TKO' : 'S'} → ${j.success}`;
      } else continue;
      log.push(what);
      for (const id of ids) {
        const files = (await filesOf(env.DB, id)).map((f) => ({ ...f }));
        const proven = (k) => files.filter((f) => f.doc === 'coi').map((f) => f.proves?.[k]).filter(Boolean).sort().pop() || null;
        const want = { w9: files.some((f) => f.doc === 'w9' && f.proves?.w9), gl: proven('gl'), wc: proven('wc') };
        const p = await readPapers(env.DB, id);
        const have = { w9: !!p.w9, gl: p.glExpires || null, wc: p.wcExpires || null };
        if (JSON.stringify(want) !== JSON.stringify(have)) {
          fails.push(`run ${run} step ${step}: ${id === VENDOR ? 'TKO' : 'S'} record ${JSON.stringify(have)} but its files prove ${JSON.stringify(want)}\n  files: ${files.map((f) => `${f.name}:${f.doc}:${f.status}:${JSON.stringify(f.proves)}`).join(' | ')}\n  steps:\n   ${log.join('\n   ')}`);
          break;
        }
      }
      if (fails.length) break;
    }
  }
  assert.deepEqual(fails, []);
});

test('a certificate relabeled as a W-9, then the same file added again as a certificate: refused, and the record never shows dates only a "W-9" holds', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  world.ai = GOOD4();
  const bytes = await pdf4('TKO packet');
  const up = await up4(VENDOR, 'coi', bytes, 'packet.pdf');
  const fid = up.vendor.files[0].id;
  const rel = await admin({ action: 'move-file', fileId: fid, doc: 'w9' });
  assert.equal(rel.vendor.gl, null, 'setup: relabeled as a W-9, its dates come off');
  // The same bytes sent again as a certificate: refused (one file is one thing; Move says what it is), nothing moves
  const again = await up4(VENDOR, 'coi', bytes, 'packet again.pdf');
  assert.equal(again.success, false);
  assert.match(again.error, /already kept as their W-9/);
  const f = await readFile(env.DB, fid);
  assert.equal(f.doc, 'w9');
  assert.equal((await readPapers(env.DB, VENDOR)).glExpires, null, 'no dates only a "W-9" holds');
});

test('a certificate in two files (liability, workers’ comp): taking off the workers’ comp file takes its date off, and the audit stops counting it', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  const base = { isCertificate: true, readable: true, insured: 'TKO Plumbing LLC', certificateHolder: 'Sunshine on a Ranney Day' };
  const GLp = { kind: 'general liability', insurer: 'Hartford', effective: '2026-01-01', expires: '2027-06-21', eachOccurrence: 1000000, aggregate: 2000000 };
  const WCp = { kind: 'workers compensation', insurer: 'Travelers', effective: '2026-01-01', expires: '2027-06-21', employersLiabilityEachAccident: 1000000 };
  env.AI.run = async (model, input) => {
    const url = JSON.stringify(input?.messages || '').match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/)?.[1];
    const b = url ? Buffer.from(url, 'base64') : null;
    return { response: { ...base, policies: b?.[4] === 41 ? [GLp] : [WCp] } };
  };
  const fd = new FormData();
  fd.set('id', VENDOR); fd.set('doc', 'coi');
  fd.append('file', new File([JPG4(41)], 'gl.jpg', { type: 'image/jpeg' }));
  fd.append('file', new File([JPG4(42)], 'wc.jpg', { type: 'image/jpeg' }));
  const up = await admin(fd);
  assert.equal(up.result.accepted, true, `setup: ${JSON.stringify(up.result.problems)}`);
  assert.equal(up.vendor.wc, '2027-06-21', 'setup');
  const wcFile = up.vendor.files.find((f) => f.name === 'wc.jpg');
  const j = await admin({ action: 'remove-file', fileId: wcFile.id });
  const IA = await import('../functions/api/_insurance-audit.js');
  const a = IA.auditFrom({ term: IA.term('2026', 'wc'), payments: [{ key: 'bill:B1', jtId: VENDOR, payee: 'TKO Plumbing', date: '2026-11-01', cents: 300000, source: 'jobtread', method: 'bill', costTypes: ['Subcontractor'] }], vendors: await IA.readVendors(env.DB), sites: await IA.readSites(env.DB), coverage: await IA.readCoverage(env.DB), today: '2026-11-02' });
  assert.deepEqual({ wc: j.vendor.wc, auditUninsuredWc: a.rows[0].wc.cents }, { wc: null, auditUninsuredWc: 300000 },
    `the workers' comp file is off the list, yet the record keeps its date (the liability file "proves" it too) and the audit still counts it (coverage is filed under the first file's hash)`);
});

// ─── What the fifth round of testing broke, kept broken-proof ───────

const J5 = (n) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, n, n]);
const BASE5 = { isCertificate: true, readable: true, insured: 'TKO Plumbing LLC', certificateHolder: 'Sunshine on a Ranney Day' };
const GL5 = (end = '2027-06-21', occ = 1000000) => ({ kind: 'general liability', insurer: 'Hartford', effective: '2026-01-01', expires: end, eachOccurrence: occ, aggregate: 2000000 });
const WC5 = (end = '2027-06-21', el = 1000000) => ({ kind: 'workers compensation', insurer: 'Travelers', effective: '2026-01-01', expires: end, employersLiabilityEachAccident: el });
const marker5 = (input) => {
  const url = JSON.stringify(input?.messages || '').match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/)?.[1];
  return url ? Buffer.from(url, 'base64')[4] : null;
};
const pdf5 = async (text) => {
  const { PDFDocument: PD, StandardFonts: SF } = await import('pdf-lib');
  const d = await PD.create(); const p = d.addPage([612, 792]);
  p.drawText(text, { x: 50, y: 700, size: 14, font: await d.embedFont(SF.Helvetica) });
  return d.save();
};
const upMany5 = (doc, list) => {
  const fd = new FormData();
  fd.set('id', VENDOR); fd.set('doc', doc);
  list.forEach(({ bytes, name, type, pages = [] }, i) => {
    fd.append('file', new File([bytes], name, { type }));
    pages.forEach((p, k) => fd.append(`pages${i}`, new File([p], `page-${k + 1}.jpg`, { type: 'image/jpeg' })));
  });
  return admin(fd);
};
const audit5 = async (policy = 'wc') => {
  const IA = await import('../functions/api/_insurance-audit.js');
  return IA.auditFrom({ term: IA.term('2026', policy), payments: [{ key: 'bill:B1', jtId: VENDOR, payee: 'TKO Plumbing', date: '2026-11-01', cents: 300000, source: 'jobtread', method: 'bill', costTypes: ['Subcontractor'] }], vendors: await IA.readVendors(env.DB), sites: await IA.readSites(env.DB), coverage: await IA.readCoverage(env.DB), today: '2026-11-02' });
};

// ─── 1. Certificates in several files ───────────────────────────────

test('a two-file certificate whose workers’ comp file was read two ways (settled by the one-value question): its date is that file’s, not the liability file’s', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  // File 1: a photo of the liability certificate. File 2: a PDF of the workers' comp one, whose text says it ended
  // 2026-10-01 and whose page picture says 2027-10-01; the one-value question reads 2027-10-01.
  env.AI.run = async (model, input) => {
    const s = JSON.stringify(input?.messages || '');
    if (s.includes('You read one value')) return { response: { value: '2027-10-01' } };
    const m = marker5(input);
    if (m === 51) return { response: { ...BASE5, policies: [GL5()] } };
    if (m === 52) return { response: { ...BASE5, policies: [WC5('2027-10-01')] } };
    return { response: { ...BASE5, policies: [WC5('2026-10-01')] } };   // the WC PDF's text
  };
  const wcPdf = await pdf5('WC only');
  const up = await upMany5('coi', [
    { bytes: J5(51), name: 'gl.jpg', type: 'image/jpeg' },
    { bytes: wcPdf, name: 'wc.pdf', type: 'application/pdf', pages: [J5(52)] },
  ]);
  assert.equal(up.success, true, up.error);
  assert.equal(up.result.accepted, true, `setup: ${JSON.stringify(up.result)}`);
  assert.equal(up.vendor.wc, '2027-10-01', 'setup: the settled date');
  const gl = up.vendor.files.find((f) => f.name === 'gl.jpg');
  const wc = up.vendor.files.find((f) => f.name === 'wc.pdf');
  const proves = { gl: (await readFile(env.DB, gl.id)).proves, wc: (await readFile(env.DB, wc.id)).proves };
  assert.deepEqual(proves, { gl: { gl: '2027-06-21' }, wc: { wc: '2027-10-01' } },
    'the workers’ comp date is filed under the liability photo (partKinds compares the settled verdict with the unsettled readings)');
});

test('… and so taking off the workers’ comp file leaves the company insured for workers’ comp, and the audit still counts it', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  env.AI.run = async (model, input) => {
    const s = JSON.stringify(input?.messages || '');
    if (s.includes('You read one value')) return { response: { value: '2027-10-01' } };
    const m = marker5(input);
    if (m === 51) return { response: { ...BASE5, policies: [GL5()] } };
    if (m === 52) return { response: { ...BASE5, policies: [WC5('2027-10-01')] } };
    return { response: { ...BASE5, policies: [WC5('2026-10-01')] } };
  };
  const up = await upMany5('coi', [
    { bytes: J5(51), name: 'gl.jpg', type: 'image/jpeg' },
    { bytes: await pdf5('WC only'), name: 'wc.pdf', type: 'application/pdf', pages: [J5(52)] },
  ]);
  assert.equal(up.vendor.wc, '2027-10-01', 'setup');
  const wc = up.vendor.files.find((f) => f.name === 'wc.pdf');
  const j = await admin({ action: 'remove-file', fileId: wc.id });
  const a = await audit5('wc');
  assert.deepEqual({ wc: j.vendor.wc, uninsured: a.rows[0].wc.cents }, { wc: null, uninsured: 300000 });
});

test('three files, one with no policies (a cover letter): it proves nothing and shows nothing; taking it off changes nothing; the audit counts both policies', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  env.AI.run = async (model, input) => {
    const m = marker5(input);
    if (m === 61) return { response: { ...BASE5, policies: [GL5()] } };
    if (m === 62) return { response: { ...BASE5, policies: [WC5('2027-03-01')] } };
    return { response: { isCertificate: false, readable: true, insured: '', certificateHolder: '', policies: [] } };
  };
  const up = await upMany5('coi', [
    { bytes: J5(63), name: 'letter.jpg', type: 'image/jpeg' },
    { bytes: J5(61), name: 'gl.jpg', type: 'image/jpeg' },
    { bytes: J5(62), name: 'wc.jpg', type: 'image/jpeg' },
  ]);
  assert.equal(up.result.accepted, true, `setup: ${JSON.stringify(up.result)}`);
  const by = (n) => up.vendor.files.find((f) => f.name === n);
  const p = async (n) => (await readFile(env.DB, by(n).id)).proves;
  assert.deepEqual({ letter: await p('letter.jpg'), gl: await p('gl.jpg'), wc: await p('wc.jpg') }, { letter: null, gl: { gl: '2027-06-21' }, wc: { wc: '2027-03-01' } });
  assert.equal(by('letter.jpg').reading, null, 'the letter shows no policies');
  const j = await admin({ action: 'remove-file', fileId: by('letter.jpg').id });
  assert.deepEqual([j.vendor.gl, j.vendor.wc], ['2027-06-21', '2027-03-01']);
  const a = await audit5('wc');
  assert.equal(a.rows[0].wc.cents, 0, `audit: ${JSON.stringify(a.rows[0].wc)}`);
  // Take off the liability file: liability goes, workers' comp stays; the GL audit counts it uninsured
  const j2 = await admin({ action: 'remove-file', fileId: by('gl.jpg').id });
  assert.deepEqual([j2.vendor.gl, j2.vendor.wc], [null, '2027-03-01']);
  const g = await audit5('gl');
  assert.equal(g.rows[0].gl.cents, 300000, `gl audit: ${JSON.stringify(g.rows[0].gl)}`);
});

test('two copies of one certificate in one upload (same policies on both, both files the same dates): one file holds each date, taking either off keeps it while the other shows it', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  env.AI.run = async () => ({ response: { ...BASE5, policies: [GL5(), WC5()] } });
  const up = await upMany5('coi', [{ bytes: J5(71), name: 'a.jpg', type: 'image/jpeg' }, { bytes: J5(72), name: 'b.jpg', type: 'image/jpeg' }]);
  const b = up.vendor.files.find((f) => f.name === 'b.jpg');
  const a = up.vendor.files.find((f) => f.name === 'a.jpg');
  // Taking off the copy that "holds" the dates (a.jpg, the first): b.jpg shows the same, so the record should stay
  const j = await admin({ action: 'remove-file', fileId: a.id });
  assert.deepEqual([j.vendor.gl, j.vendor.wc], ['2027-06-21', '2027-06-21'], `a second copy that shows the same policies is still on the list (b proves ${JSON.stringify((await readFile(env.DB, b.id)).proves)})`);
});

// ─── 3. One file is one kind ────────────────────────────────────────

test('a vendor sends liability + a file kept as their W-9: refused (409), and nothing of the half-done upload is left proving dates the record doesn’t show', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  // Their W-9 first (a photo), kept
  env.AI.run = async (model, input) => (marker5(input) === 81
    ? { response: { isW9: true, readable: true, name: 'TKO Plumbing LLC', businessName: '', hasTaxId: true, signed: true, signedDate: '2026-10-01', taxClassification: 'LLC' } }
    : { response: { ...BASE5, policies: [GL5(), WC5()] } });
  const w = await upMany5('w9', [{ bytes: J5(81), name: 'w9.jpg', type: 'image/jpeg' }]);
  assert.equal(w.success, true, w.error);
  const link = await createLink(env.DB, VENDOR, { now: NOW });
  const fd = new FormData();
  fd.set('token', link.token); fd.set('doc', 'coi');
  fd.append('file', new File([J5(82)], 'coi.jpg', { type: 'image/jpeg' }));
  fd.append('file', new File([J5(81)], 'w9.jpg', { type: 'image/jpeg' }));
  const r = await pagePost({ env, request: new Request('https://x.example/api/vendor-docs', { method: 'POST', body: fd }) });
  const body = await r.json().catch(() => ({}));
  const files = await filesOf(env.DB, VENDOR);
  const p = await readPapers(env.DB, VENDOR);
  assert.equal(r.status, 409, JSON.stringify(body));
  assert.deepEqual({ coiFiles: files.filter((f) => f.doc === 'coi').map((f) => [f.status, f.proves]), gl: p.glExpires },
    { coiFiles: [], gl: null }, 'the first file of a refused upload is kept as a passing certificate (status checked, proves dates) the record never got');
});

// ─── 9. "I looked at it", typed values, hand-typed ──────────────────

test('a hand-typed liability date, then a later certificate, then that certificate taken off: the company falls back to the date a person typed', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  const t = await admin({ action: 'set', id: VENDOR, gl: '2027-02-01', wc: '2027-02-01' });
  assert.equal(t.success, true, t.error);
  assert.deepEqual((await readPapers(env.DB, VENDOR)).hand, { gl: '2027-02-01', wc: '2027-02-01' }, 'setup: typed by hand');
  env.AI.run = async () => ({ response: { ...BASE5, policies: [GL5('2027-06-21'), WC5('2027-06-21')] } });
  const up = await upMany5('coi', [{ bytes: J5(91), name: 'wrong-company.jpg', type: 'image/jpeg' }]);
  assert.equal(up.vendor.gl, '2027-06-21', 'setup');
  const j = await admin({ action: 'remove-file', fileId: up.vendor.files[0].id });
  assert.deepEqual([j.vendor.gl, j.vendor.wc], ['2027-02-01', '2027-02-01'], 'the record drops to no dates at all, though a person typed dates that still hold (proofOff never falls back to hand)');
});

test('dates typed while a certificate waits attach to it; a W-9 typed at the same time with no W-9 waiting is the person’s own (taking the certificate off leaves the W-9)', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  env.AI.run = async () => ({ response: { isCertificate: true, readable: false, policies: [] } });
  const up = await upMany5('coi', [{ bytes: J5(95), name: 'blurry.jpg', type: 'image/jpeg' }]);
  assert.equal(up.vendor.files[0].status, 'look', 'setup: waits on a person');
  const t = await admin({ action: 'set', id: VENDOR, w9: true, gl: '2027-05-01', wc: '2027-05-01' });
  assert.equal(t.success, true, t.error);
  const p = await readPapers(env.DB, VENDOR);
  assert.deepEqual({ hand: p.hand, proves: (await readFile(env.DB, up.vendor.files[0].id)).proves }, { hand: { w9: true }, proves: { gl: '2027-05-01', wc: '2027-05-01' } });
  const j = await admin({ action: 'remove-file', fileId: up.vendor.files[0].id });
  assert.deepEqual([j.vendor.w9, j.vendor.gl, j.vendor.wc], [true, null, null]);
});

// ─── 11. Insurance Check ────────────────────────────────────────────

test('putting back an older certificate (its dates don’t move) leaves JobTread’s Insurance Check describing the newer one', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  env.AI.run = async (model, input) => ({ response: { ...BASE5, policies: marker5(input) === 101 ? [GL5('2027-01-15'), WC5('2027-01-15')] : [GL5('2027-09-01'), WC5('2027-09-01')] } });
  const old = await upMany5('coi', [{ bytes: J5(101), name: 'old.jpg', type: 'image/jpeg' }]);
  const off = await admin({ action: 'remove-file', fileId: old.vendor.files[0].id });
  assert.equal(off.vendor.gl, null, 'setup');
  const neu = await upMany5('coi', [{ bytes: J5(102), name: 'new.jpg', type: 'image/jpeg' }]);
  const checkNew = jtVals()['F-CHECK'];
  assert.match(String(checkNew), /2027-09-01/, 'setup');
  const back = await admin({ action: 'restore-file', fileId: old.vendor.files[0].id });
  assert.deepEqual({ gl: back.vendor.gl, check: jtVals()['F-CHECK'] }, { gl: '2027-09-01', check: checkNew });
});

test('a two-file certificate whose second file (liability + workers’ comp, a liability limit read two ways) is unsure on its own: workers’ comp is still that file’s', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  // File 1: a clean, newer liability certificate (photo). File 2: a PDF with liability + workers' comp; its text reads
  // liability at $500,000, its picture at $1,000,000. Together they pass (file 1's liability runs longer).
  env.AI.run = async (model, input) => {
    const m = marker5(input);
    if (m === 111) return { response: { ...BASE5, policies: [GL5('2027-08-01')] } };
    if (m === 112) return { response: { ...BASE5, policies: [GL5('2027-01-15'), WC5('2027-01-15')] } };
    return { response: { ...BASE5, policies: [GL5('2027-01-15', 500000), WC5('2027-01-15')] } };
  };
  const up = await upMany5('coi', [
    { bytes: J5(111), name: 'gl-new.jpg', type: 'image/jpeg' },
    { bytes: await pdf5('GL + WC'), name: 'both.pdf', type: 'application/pdf', pages: [J5(112)] },
  ]);
  assert.equal(up.result.accepted, true, `setup: ${JSON.stringify(up.result)}`);
  const by = (n) => up.vendor.files.find((f) => f.name === n);
  const p = async (n) => (await readFile(env.DB, by(n).id)).proves;
  assert.deepEqual({ glNew: await p('gl-new.jpg'), both: await p('both.pdf') }, { glNew: { gl: '2027-08-01' }, both: { wc: '2027-01-15' } });
});

test('the insurance audit, like the Ramp holds, never treats a site company’s Ramp payment as a look-alike JobTread vendor’s paid bill', async () => {
  const IA = await import('../functions/api/_insurance-audit.js');
  const t = IA.term('2026', 'wc');
  const jtBills = [{ id: 'JB1', vendor: 'Wiggins', cents: 50000, number: '7', date: '2026-10-01', accountId: 'ACCWIG', paidCents: 50000, status: 'approved', costTypes: ['Subcontractor'] }];
  const jtPayments = [{ id: 'P1', date: '2026-10-05', cents: 50000, accountId: 'ACCWIG', accountName: 'Wiggins', accountType: 'vendor', bills: [{ billId: 'JB1', cents: 50000 }] }];
  const rampBills = [{ id: 'RB1', vendor: 'Wiggins Law Group', cents: 50000, invoice: 'INV-1', date: '2026-10-06', method: 'ach', categories: [] }];
  // As buildRun calls it: with the name keys of the companies kept on the site
  const out = IA.combinePayments({ term: t, jtBills, jtPayments, rampBills, vendors: [{ jtId: 'ACCWIG', name: 'Wiggins' }], siteNames: new Set(['wiggins law group']) });
  assert.deepEqual(out.map((p) => p.payee).sort(), ['Wiggins', 'Wiggins Law Group'], `two payments to two companies; the audit keeps ${JSON.stringify(out.map((p) => [p.key, p.payee]))}`);
});

test('taking off the workers’ comp certificate while a liability certificate stays leaves JobTread’s Insurance Check describing the liability one, not empty', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  env.AI.run = async (model, input) => ({ response: { ...BASE5, policies: marker5(input) === 121 ? [GL5('2027-06-21')] : [WC5('2027-03-01')] } });
  await upMany5('coi', [{ bytes: J5(121), name: 'gl.jpg', type: 'image/jpeg' }]);
  const w = await upMany5('coi', [{ bytes: J5(122), name: 'wc.jpg', type: 'image/jpeg' }]);
  const wc = w.vendor.files.find((f) => f.name === 'wc.jpg');
  const j = await admin({ action: 'remove-file', fileId: wc.id });
  assert.deepEqual([j.vendor.gl, j.vendor.wc], ['2027-06-21', null], 'setup');
  assert.ok(jtVals()['F-CHECK'], `Insurance Check is ${JSON.stringify(jtVals()['F-CHECK'])}`);
});

test('the import meeting a file a person took off (as the other kind): JobTread’s copy goes only because the site keeps the bytes, still off, one click from back', async () => {
  await readVendor(env, VENDOR, { now: NOW });
  // The bytes were kept as a W-9 on the site, then taken off
  const k = await keepFile(env, VENDOR, { doc: 'w9', bytes: PDF2, type: 'application/pdf', name: 'thing.pdf', source: 'staff', status: 'kept' }, { now: NOW });
  await admin({ action: 'remove-file', fileId: k.file.id });
  world.vendors[VENDOR].files = [{ id: 'F9', name: 'COI TKO.pdf', folder: 'W-9 & Insurance', size: PDF2.length, createdAt: '2026-06-22T12:00:00Z', tags: ['T-COI'] }];
  world.fileBytes = { F9: PDF2 };
  const ids = await jtSetup(env);
  await importJobTread(env, { now: NOW, tags: ids.tags });
  const all = await filesOf(env.DB, VENDOR, { removed: true });
  assert.deepEqual(all.map((f) => [f.id, f.doc, f.status]), [[k.file.id, 'w9', 'removed']], 'it stays as the person left it: off, never a second copy');
  assert.equal(env.VENDOR_FILES.objects.has(k.file.key), true, 'the bytes are kept on the site');
  assert.ok(world.deleted.includes('F9'), 'so JobTread’s copy can go (JobTread keeps no copies)');
});

test('a certificate staff took off (wrong company) stays off when the import meets the same bytes in JobTread; the audit doesn’t count it again', async () => {
  Object.assign(jtVals(), { 'F-W9': true });
  await readVendor(env, VENDOR, { now: NOW });
  env.AI.run = async () => ({ response: { ...BASE5, insured: 'Someone Else LLC', policies: [GL5(), WC5()] } });
  const up = await upMany5('coi', [{ bytes: PDF2, name: 'not-theirs.pdf', type: 'application/pdf' }]);
  assert.equal(up.vendor.wc, '2027-06-21', 'setup');
  const off = await admin({ action: 'remove-file', fileId: up.vendor.files[0].id });
  assert.equal(off.vendor.wc, null, 'setup: taken off');
  world.vendors[VENDOR].files = [{ id: 'F10', name: 'COI.pdf', folder: 'W-9 & Insurance', size: PDF2.length, createdAt: '2026-06-22T12:00:00Z', tags: ['T-COI'] }];
  world.fileBytes = { F10: PDF2 };
  const ids = await jtSetup(env);
  await importJobTread(env, { now: NOW, tags: ids.tags });
  const shown = (await filesOf(env.DB, VENDOR)).map((f) => [f.name, f.status, f.proves]);
  const a = await audit5('wc');
  assert.deepEqual({ shown, uninsured: a.rows[0].wc.cents }, { shown: [], uninsured: 300000 });
});
