/**
 * Trade partners (functions/api/_trade-partners.js, trade-partner.js, _w9-form.js):
 * signing in, the company step, the W-9 signed on the page, the insurance agent,
 * bank details to Mercury and the hold until a call confirms them (only when one's
 * needed), invoices, "Get started" matching JobTread on its own, every email noted
 * on the vendor, and the nudges. A pretend JobTread,
 * Mercury, Resend and Slack; made-up companies only (12-3456789 is the IRS's
 * own example EIN).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createD1 } from './lib/d1-shim.mjs';
import { MERCURY_BASE } from '../functions/api/_mercury.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { ensureSpendSchema } from '../functions/api/_spend.js';
import { ensureBillPaySchema } from '../functions/api/_bill-pay.js';
import { createLink, findLink, ensureVendorSchema, fileUpload, TRADES } from '../functions/api/_vendors.js';
import {
  partnerView, partnerInvoices, readBank, bankHold, confirmBank, startPartner, matchVendor, invitePartner, partnerNudges,
  readProfileRow, routingOk, phoneOf, holderOf,
} from '../functions/api/_trade-partners.js';
import { checkW9, buildW9, tinProblem } from '../functions/api/_w9-form.js';
import { onRequestPost as post, onRequestGet as get } from '../functions/api/trade-partner.js';
import { onRequestGet as docsGet } from '../functions/api/vendor-docs.js';

const NOW = Date.parse('2026-10-29T15:00:00Z');
const DAY = 864e5;
const VENDOR = 'ACC-TKO';
const EMAIL_F = '22NJw43QvHeJ';
const PHONE_F = '22NJw43UauSc';
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const PDF = new TextEncoder().encode('%PDF-1.7 a certificate');
const W9 = {
  name: 'Tom Kowalski', business: 'TKO Plumbing LLC', taxClass: 'llc', llcClass: 'S', address: '12 Example Lane', cityStateZip: 'Decatur, GA 30030',
  tinType: 'ein', tin: '12-3456789', certify: true, signature: 'Tom Kowalski',
};
const COMPANY = {
  name: 'TKO Plumbing LLC', trades: ['Plumbing', 'Not a trade'], license: 'MP-000000',
  address: { street: '12 Example Lane', unit: 'Suite 4', city: 'Decatur', state: 'ga', zip: '30030' },
  main: { name: 'Tom Kowalski', email: 'Tom@TKO.example', phone: '(404) 555-0134' }, billing: { email: 'billing@tko.example' },
};

// ─── A pretend JobTread, Mercury, Resend and Slack ──────────────────

let world;
const FIELDS = [
  ['F-W9', 'W-9', 'boolean'], ['F-GL', 'Liability Expires', 'date'], ['F-WC', 'Workers\' Comp Expires', 'date'], ['F-DOCS', 'Documents', 'option'],
  ['F-CHECK', 'Insurance Check', 'text'], ['F-TRADES', 'Trades', 'option'], ['F-ADDR', 'Address', 'text'], ['F-LIC', 'License', 'text'], ['F-MAT', 'Materials only', 'boolean'],
].map(([id, name, type]) => ({ id, name, type, options: id === 'F-TRADES' ? TRADES : id === 'F-DOCS' ? ['Current', 'Expiring soon', 'Requested', 'Expired', 'Missing', 'Needs a look', 'W-9 only', 'Not needed'] : null }));
const fresh = () => ({
  accounts: { [VENDOR]: { name: 'TKO Plumbing', values: { 'F-GL': '2027-06-01', 'F-WC': '2027-06-01' }, primary: 'CON1', contacts: [{ id: 'CON1', name: 'Tom', title: '', email: 'tom@tko.example', phone: null }] } },
  made: [], contactsMade: [], contactsUpdated: [], comments: [], files: [], uploads: [], emails: [], slack: [],
  recipients: [{ id: 'rec-tko', name: 'TKO Plumbing', status: 'active' }], mercuryPosts: [], attachments: [], ai: null,
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host === 'uploads.jobtread.example') { world.uploads.push(init.body.byteLength); return new Response('', { status: 200 }); }
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.customFields) return Response.json({ organization: { customFields: { nodes: FIELDS }, fileTags: { nodes: [{ id: 'T-W9', name: 'W-9' }, { id: 'T-COI', name: 'COI' }] } } });
    if (query.account) {
      const a = world.accounts[query.account.$.id];
      if (!a) return Response.json({ account: null });
      const cf = (c) => ({ nodes: c ? [c.email && { value: c.email, customField: { id: EMAIL_F } }, c.phone && { value: c.phone, customField: { id: PHONE_F } }].filter(Boolean) : [] });
      return Response.json({ account: {
        id: query.account.$.id, name: a.name, type: 'vendor', archivedAt: null,
        customFieldValues: { nodes: Object.entries(a.values).map(([id, value]) => ({ value, customField: { id } })) },
        primaryContact: a.primary ? { id: a.primary, customFieldValues: cf(a.contacts.find((c) => c.id === a.primary)) } : null,
        contacts: { nodes: a.contacts.map((c) => ({ id: c.id, name: c.name, title: c.title, customFieldValues: cf(c) })) },
        files: { nodes: (a.files || []).map((f, i) => ({ id: `FILE${i}`, name: f.name, url: `https://files.jobtread.example/${i}`, createdAt: '2026-10-20T15:00:00Z', fileTags: { nodes: f.tags.map((id) => ({ id })) } })) },
      } });
    }
    if (query.updateAccount) {
      const { id, name, customFieldValues } = query.updateAccount.$;
      const a = world.accounts[id];
      if (name) a.name = name;
      Object.assign(a.values, customFieldValues || {});
      return Response.json({});
    }
    if (query.createAccount) {
      const id = `ACC-${Object.keys(world.accounts).length + 1}`;
      world.accounts[id] = { name: query.createAccount.$.name, values: {}, primary: null, contacts: [] };
      world.made.push(query.createAccount.$);
      return Response.json({ createAccount: { createdAccount: { id, name: query.createAccount.$.name } } });
    }
    if (query.createContact) {
      const { accountId, name, title, customFieldValues: v } = query.createContact.$;
      const c = { id: `CON${Math.random().toString(36).slice(2, 7)}`, name, title, email: v?.[EMAIL_F] || null, phone: v?.[PHONE_F] || null };
      world.accounts[accountId].contacts.push(c);
      world.accounts[accountId].primary ||= c.id;
      world.contactsMade.push({ accountId, ...c });
      return Response.json({ createContact: { createdContact: { id: c.id } } });
    }
    if (query.updateContact) {
      const { id, name, title, customFieldValues: v } = query.updateContact.$;
      for (const a of Object.values(world.accounts)) {
        const c = a.contacts.find((x) => x.id === id);
        if (c) Object.assign(c, { name: name ?? c.name, title: title ?? c.title, ...(v?.[EMAIL_F] ? { email: v[EMAIL_F] } : {}), ...(v?.[PHONE_F] ? { phone: v[PHONE_F] } : {}) });
      }
      world.contactsUpdated.push(query.updateContact.$);
      return Response.json({});
    }
    if (query.createComment) { world.comments.push(query.createComment.$); return Response.json({ createComment: { createdComment: { id: `C${world.comments.length}` } } }); }
    if (query.createUploadRequest) return Response.json({ createUploadRequest: { createdUploadRequest: { id: 'U1', url: 'https://uploads.jobtread.example/put', method: 'PUT', headers: {} } } });
    if (query.createFile) { world.files.push(query.createFile.$); return Response.json({ createFile: { createdFile: { id: `FILE${world.files.length}` } } }); }
    if (query.updateComment) return Response.json({});
    throw new Error(`JobTread doesn't know ${JSON.stringify(Object.keys(query))}`);
  }
  if (url.host === 'api.resend.com') { world.emails.push(...JSON.parse(init.body)); return Response.json({ data: [{ id: 'em1' }] }); }
  if (url.host === 'slack.com') { world.slack.push(JSON.parse(init.body)); return Response.json({ ok: true, channel: 'CFIN', ts: `${world.slack.length}.1` }); }
  if (url.origin === MERCURY_BASE) {
    const p = url.pathname.replace('/api/v1', '');
    const method = init.method || 'GET';
    if (p === '/recipients' && method === 'GET') return Response.json({ recipients: world.recipients });
    if (p === '/recipients' && method === 'POST') {
      const body = JSON.parse(init.body);
      const r = { id: `rec-${world.recipients.length + 1}`, status: 'active', ...body };
      world.recipients.push(r); world.mercuryPosts.push({ path: p, body });
      return Response.json(r);
    }
    const one = p.match(/^\/recipient\/([^/]+)$/);
    if (one && method === 'GET') return Response.json(world.recipients.find((r) => r.id === one[1]) || {});
    if (one && method === 'POST') {
      const body = JSON.parse(init.body);
      Object.assign(world.recipients.find((r) => r.id === one[1]), body);
      world.mercuryPosts.push({ path: p, body });
      return Response.json({ id: one[1] });
    }
    if (/^\/recipient\/[^/]+\/attachments$/.test(p)) { world.attachments.push(p); return Response.json({ id: 'att1' }); }
    throw new Error(`Mercury doesn't know ${method} ${p}`);
  }
  throw new Error(`unexpected fetch ${url.href}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
beforeEach(async () => {
  world = fresh();
  const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
  env = {
    DB, JOBTREAD_GRANT_KEY: 'jt', RESEND_API_KEY: 're_test', SLACK_BOT_TOKEN: 'xoxb-test', MERCURY_API_TOKEN: 'secret-token:test', MERCURY_RELAY_KEY: 'relay:test',
    AI: { toMarkdown: async () => ({ format: 'text', data: 'ACORD 25 CERTIFICATE OF LIABILITY INSURANCE '.repeat(5) }), run: async () => ({ response: world.ai }) },
  };
  await ensureSpendSchema(DB);
  await ensureBillPaySchema(DB);
  await ensureVendorSchema(DB);
  await writeSlackConfig(DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance' } });
  await DB.prepare("INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES ('jt_ACC-TKO', 'TKO Plumbing', 'tko plumbing', ?, 'tom@tko.example', '{\"emails\":[\"tom@tko.example\"]}', '', '')").bind(VENDOR).run();
});

const call = async (body, ip = '203.0.113.9') => {
  const res = await post({ env, request: new Request('https://x.example/api/trade-partner', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }) });
  return { status: res.status, ...(await res.json()) };
};
const tokenFor = async (o = {}) => (await createLink(env.DB, o.vendor || VENDOR, { now: o.now ?? Date.now(), scope: o.scope || 'vendor' })).token;
const dumpDb = async () => {
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((t) => t.name);
  let all = '';
  for (const t of tables) all += JSON.stringify((await env.DB.prepare(`SELECT * FROM ${t}`).all()).results);
  return all;
};

// ─── Pure ───────────────────────────────────────────────────────────

test('tax IDs are held to the IRS’s own rules, and the W-9 needs what the form needs', () => {
  assert.equal(tinProblem('ein', '12-3456789'), null);
  assert.match(tinProblem('ein', '00-1234567'), /EIN/);
  assert.match(tinProblem('ssn', '666-12-1234'), /Social Security/);
  assert.equal(tinProblem('ssn', '912-70-1234'), null, 'an ITIN goes in the SSN box');
  assert.match(tinProblem('ssn', '111111111'), /can’t be a real/);
  assert.match(tinProblem('ein', '12345'), /9 digits/);
  const r = checkW9({ taxClass: 'llc', tinType: 'ein', tin: '1' });
  assert.deepEqual(Object.keys(r.problems).sort(), ['address', 'certify', 'cityStateZip', 'llcClass', 'name', 'signature', 'tin']);
  assert.equal(checkW9(W9).ok, true);
  assert.equal(routingOk('021000021'), true);
  assert.equal(routingOk('021000022'), false, 'a routing number’s last digit checks the rest');
  assert.equal(phoneOf('1 (404) 555-0134'), '+14045550134');
  assert.equal(phoneOf('555-0134'), null);
});

test('the signed W-9 is page 1 of the IRS form, flattened', async () => {
  const bytes = await buildW9(checkW9(W9).w9, { signedAt: NOW, email: 'tom@tko.example', ip: '203.0.113.9', requester: { name: 'Sunshine on a Ranney Day', lines: ['250 Example Drive', 'Roswell, GA 30076'] } });
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getForm().getFields().length, 0, 'flattened: nothing left to edit');
  assert.equal(doc.getTitle(), 'Form W-9: TKO Plumbing LLC');
});

test('SOARD as certificate holder comes from Site Config, and today’s address when it can’t be read', async () => {
  assert.deepEqual(await holderOf(env.DB), ['Sunshine on a Ranney Day', '250 Hembree Park Drive, Suite 106', 'Roswell, GA 30076']);
  await env.DB.prepare("INSERT INTO site_config (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ name: 'SOARD', address: { street: '1 New Street', city: 'Atlanta', state: 'GA', zip: '30301' } })).run();
  assert.deepEqual(await holderOf(env.DB), ['SOARD', '1 New Street', 'Atlanta, GA 30301']);
});

// ─── Signing in ─────────────────────────────────────────────────────

test('signing in: a link to any address JobTread has, nothing said about one it doesn’t, three an hour', async () => {
  let r = await call({ action: 'signin', email: 'nobody@else.example' });
  assert.equal(r.ok, true);
  assert.equal(world.emails.length, 0, 'an address nobody has gets nothing, and the page says the same');
  r = await call({ action: 'signin', email: ' Tom@TKO.example ' });
  assert.equal(r.ok, true);
  assert.equal(world.emails.length, 1);
  assert.match(world.emails[0].text, /trade-partners\/account\/#t=/);
  const token = world.emails[0].text.match(/#t=([\w-]+)/)[1];
  assert.equal((await findLink(env.DB, token, Date.now() + 80 * DAY)).problem, null, 'it keeps them signed in for 90 days');
  await call({ action: 'signin', email: 'tom@tko.example' });
  await call({ action: 'signin', email: 'tom@tko.example' });
  r = await call({ action: 'signin', email: 'tom@tko.example' });
  assert.equal(r.status, 429);
  assert.equal(world.emails.length, 3);
  assert.doesNotMatch(await dumpDb(), /tom@tko\.example","[^"]*rate/i, 'the limit’s key isn’t the address');
});

// ─── The company ────────────────────────────────────────────────────

test('the company step: checked, then JobTread gets the name, trades, address, license and people', async () => {
  const token = await tokenFor();
  let r = await call({ action: 'company', token, ...COMPANY, address: { ...COMPANY.address, zip: '300' } });
  assert.equal(r.status, 400);
  assert.equal(r.field, 'zip');
  r = await call({ action: 'company', token, ...COMPANY });
  assert.equal(r.ok, true);
  const a = world.accounts[VENDOR];
  assert.equal(a.name, 'TKO Plumbing LLC');
  assert.deepEqual(a.values['F-TRADES'], ['Plumbing'], 'only trades on the list');
  assert.equal(a.values['F-ADDR'], '12 Example Lane, Suite 4, Decatur, GA 30030');
  assert.equal(a.values['F-LIC'], 'MP-000000');
  assert.deepEqual(world.contactsUpdated[0].customFieldValues, { [EMAIL_F]: 'tom@tko.example', [PHONE_F]: '+14045550134' });
  assert.equal(world.contactsUpdated[0].title, 'Main contact');
  const billing = a.contacts.find((c) => c.title === 'Billing');
  assert.equal(billing.email, 'billing@tko.example');
  assert.match(world.comments.at(-1).message, /name \(was TKO Plumbing\)/);
  assert.equal(world.comments.at(-1).isVisibleToVendorRoles, false);
  assert.equal((await readProfileRow(env.DB, VENDOR)).address.state, 'GA');
  // The billing address can sign in now, before JobTread's 4-hourly read
  await call({ action: 'signin', email: 'billing@tko.example' });
  assert.equal(world.emails.length, 1);
});

// ─── The W-9, signed on the page ────────────────────────────────────

test('a W-9 signed on the page: problems back to the page, then filed, ticked and on the Mercury recipient', async () => {
  const token = await tokenFor();
  let r = await call({ action: 'w9', token, w9: { ...W9, certify: false, tin: '000000000' } });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.problems).sort(), ['certify', 'tin']);
  assert.equal(world.files.length, 0);
  r = await call({ action: 'w9', token, w9: W9 });
  assert.equal(r.ok, true);
  assert.equal(world.files.length, 1);
  assert.match(world.files[0].name, /^W-9 TKO Plumbing \d{4}-\d{2}-\d{2} \(signed online\)\.pdf$/);
  assert.deepEqual(world.files[0].fileTagIds, ['T-W9']);
  assert.equal(world.files[0].folder, 'W-9 & Insurance');
  assert.equal(world.accounts[VENDOR].values['F-W9'], true);
  assert.equal(world.accounts[VENDOR].values['F-DOCS'], 'Current');
  assert.deepEqual(world.attachments, ['/recipient/rec-tko/attachments'], 'onto Mercury for the 1099');
  assert.match(world.comments.at(-1).message, /Tom Kowalski filled in and signed a W-9/);
  assert.doesNotMatch(JSON.stringify(world.comments) + await dumpDb(), /3456789/, 'the tax ID lives only in the PDF');
  assert.ok((await readProfileRow(env.DB, VENDOR)).steps.w9);
});

// ─── Their insurance agent ──────────────────────────────────────────

test('the agent: a contact in JobTread, asked with SOARD as holder, a link that adds a certificate and nothing else', async () => {
  const token = await tokenFor();
  world.accounts[VENDOR].values = {}; // no insurance on file
  const r = await call({ action: 'agent', token, name: 'Ana Agent', email: 'ana@agency.example', agency: 'Example Insurance' });
  assert.equal(r.ok, true);
  assert.ok(world.accounts[VENDOR].contacts.some((c) => c.title === 'Insurance agent' && c.email === 'ana@agency.example'));
  const mail = world.emails.at(-1);
  assert.deepEqual(mail.to, ['ana@agency.example']);
  assert.match(mail.subject, /^Certificate of insurance for TKO Plumbing/);
  assert.match(mail.text, /Certificate holder:\nSunshine on a Ranney Day\n250 Hembree Park Drive, Suite 106\nRoswell, GA 30076/);
  assert.match(mail.text, /at least \$1,000,000 each occurrence/);
  assert.ok(world.comments.some((c) => c.name === 'Insurance agent emailed' && /emailed Ana Agent at Example Insurance \(ana@agency\.example\) for TKO Plumbing’s certificate of insurance/.test(c.message)), 'noted on the vendor in JobTread');
  const agentToken = mail.text.match(/#t=([\w-]+)/)[1];
  // Their link: the certificate part only
  const view = await (await docsGet({ env, request: new Request(`https://x.example/api/vendor-docs?token=${agentToken}`) })).json();
  assert.equal(view.vendor.scope, 'agent');
  assert.equal(view.vendor.bank, undefined);
  assert.equal(view.vendor.invoices, undefined);
  assert.equal(view.vendor.company, undefined);
  assert.equal((await call({ action: 'company', token: agentToken, ...COMPANY })).status, 403);
  const { link } = await findLink(env.DB, agentToken);
  await assert.rejects(() => fileUpload(env, link, { doc: 'w9', files: [new File([PDF], 'w9.pdf')] }), (e) => e.status === 403);
  // Not answered in 3 days: reminded
  const remind = await partnerNudges(env, { now: Date.now() + 3 * DAY + 1000 });
  assert.equal(remind.agents, 1);
  assert.match(world.emails.at(-1).subject, /^A reminder: Certificate of insurance/);
  assert.equal(world.comments.filter((c) => /^Insurance agent emailed/.test(c.name)).length, 2);
  // They add it: the ask is answered
  world.ai = { isCertificate: true, readable: true, insured: 'TKO Plumbing LLC', certificateHolder: 'Sunshine on a Ranney Day', policies: [
    { kind: 'general liability', insurer: 'Hartford', expires: '2027-06-01', eachOccurrence: 1000000, aggregate: 2000000 },
    { kind: 'workers compensation', insurer: 'Travelers', expires: '2027-06-01', employersLiabilityEachAccident: 500000 },
  ] };
  const up = await fileUpload(env, link, { doc: 'coi', files: [new File([PDF], 'coi.pdf', { type: 'application/pdf' })] });
  assert.equal(up.accepted, true);
  assert.match(world.comments.at(-1).name, /insurance agent/);
  assert.equal((await readProfileRow(env.DB, VENDOR)).agent.open, false);
});

// ─── Bank details ───────────────────────────────────────────────────

test('bank details: checked, straight to Mercury, only the last four kept, and a vendor SOARD already had waits for a call', async () => {
  const token = await tokenFor();
  await call({ action: 'company', token, ...COMPANY });
  let r = await call({ action: 'bank', token, routing: '021000022', account: '000123456789', account2: '000123456789', kind: 'businessChecking' });
  assert.equal(r.field, 'routing');
  r = await call({ action: 'bank', token, routing: '021000021', account: '000123456789', account2: '000123456780', kind: 'businessChecking' });
  assert.equal(r.field, 'account2');
  const old = await tokenFor({ now: Date.now() - 8 * DAY });
  r = await call({ action: 'bank', token: old, routing: '021000021', account: '000123456789', account2: '000123456789', kind: 'businessChecking' });
  assert.equal(r.status, 403);
  assert.equal(r.code, 'fresh', 'an older link asks for a fresh one first');
  r = await call({ action: 'bank', token, routing: '021000021', account: '000123456789', account2: '000123456789', kind: 'businessChecking' });
  assert.equal(r.ok, true);
  assert.equal(r.last4, '6789');
  // The name matched a recipient Mercury has: its bank details are edited, with the address the bank needs
  assert.equal(world.mercuryPosts[0].path, '/recipient/rec-tko');
  assert.deepEqual(world.mercuryPosts[0].body.electronicRoutingInfo, {
    accountNumber: '000123456789', routingNumber: '021000021', electronicAccountType: 'businessChecking',
    address: { address1: '12 Example Lane', address2: 'Suite 4', city: 'Decatur', region: 'GA', postalCode: '30030', country: 'US' },
  });
  assert.doesNotMatch(await dumpDb(), /000123456789|0123456789/, 'the account number is in Mercury, not here');
  const bank = await readBank(env.DB, VENDOR);
  assert.equal(bank.status, 'pending');
  assert.equal(bank.mercuryId, 'rec-tko');
  assert.deepEqual(await bankHold(env.DB, VENDOR), { why: 'their new bank account (ending 6789) isn’t confirmed yet', last4: '6789' });
  assert.match(world.emails.at(-1).subject, /We have your bank details/);
  assert.deepEqual(world.emails.at(-1).to, ['tom@tko.example']);
  assert.equal(world.slack.length, 0, 'nobody is asked to do anything until a bill for them is approved');
  assert.match(world.comments.at(-1).message, /Payments to it wait until someone at SOARD calls them on a number SOARD already had/);
  // Confirmed by phone, on the held bill in Job Costs: bills go
  await confirmBank(env, VENDOR, 'Holly');
  assert.equal(await bankHold(env.DB, VENDOR), null);
  assert.match(world.comments.at(-1).message, /Holly confirmed the bank account ending 6789 by phone/);
  // A change: Mercury's recipient edited, the old address told, and it waits again
  r = await call({ action: 'bank', token, routing: '021000021', account: '99887766', account2: '99887766', kind: 'businessSavings' });
  assert.equal(r.changed, true);
  assert.equal((await readBank(env.DB, VENDOR)).previousLast4, '6789');
  assert.equal((await readBank(env.DB, VENDOR)).status, 'pending');
  const told = world.emails.filter((m) => /Your bank account was changed/.test(m.subject));
  assert.deepEqual(told.flatMap((m) => m.to).sort(), ['billing@tko.example', 'tom@tko.example'], 'both addresses on file hear about a change');
  // The account Mercury already paid, given again once it's confirmed: nothing to call about
  await confirmBank(env, VENDOR, 'Holly');
  r = await call({ action: 'bank', token, routing: '021000021', account: '99887766', account2: '99887766', kind: 'businessSavings' });
  assert.equal(r.confirmed, true);
  assert.equal(r.changed, false);
  assert.equal((await readBank(env.DB, VENDOR)).status, 'confirmed');
  assert.match(world.comments.at(-1).message, /No call needed: it’s the same account Mercury already paid/);
});

test('a company new to SOARD, made by its own sign-up and never billed: its first bank account needs no call', async () => {
  world.recipients = [];
  await startPartner(env, { company: 'Rivera Example Roofing', name: 'Maria Rivera', email: 'maria@rivera.example', phone: '4045550100' }, { now: Date.now() });
  const jtId = Object.keys(world.accounts).find((id) => world.accounts[id].name === 'Rivera Example Roofing');
  const token = world.emails.at(-1).text.match(/#t=([\w-]+)/)[1];
  await call({ action: 'company', token, ...COMPANY, name: 'Rivera Example Roofing', main: { name: 'Maria Rivera', email: 'maria@rivera.example', phone: '4045550100' }, billing: {} });
  const r = await call({ action: 'bank', token, routing: '021000021', account: '55556666', account2: '55556666', kind: 'businessChecking' });
  assert.equal(r.confirmed, true);
  assert.equal((await readBank(env.DB, jtId)).status, 'confirmed');
  assert.equal(await bankHold(env.DB, jtId), null);
  assert.match(world.comments.at(-1).message, /No call needed: it’s a new company’s first account/);
  // Once SOARD has billed them, a change waits for a call like anyone's
  await env.DB.prepare("INSERT INTO spend_bills (id, job_id, vendor, cents, date, created_at, status, number, lines, account_id, paid, balance) VALUES ('B7', 'J1', 'Rivera', 1000, '2026-10-01', '', 'approved', '7', '[]', ?, 0, 1000)").bind(jtId).run();
  await call({ action: 'bank', token, routing: '021000021', account: '77778888', account2: '77778888', kind: 'businessChecking' });
  assert.equal((await readBank(env.DB, jtId)).status, 'pending');
});

test('a vendor Mercury doesn’t have yet gets a recipient made for them', async () => {
  world.recipients = [];
  const token = await tokenFor();
  await call({ action: 'company', token, ...COMPANY });
  const r = await call({ action: 'bank', token, routing: '021000021', account: '44445555', account2: '44445555', kind: 'personalChecking' });
  assert.equal(r.ok, true);
  assert.equal(world.mercuryPosts[0].path, '/recipients');
  assert.equal(world.mercuryPosts[0].body.name, 'TKO Plumbing LLC');
  assert.deepEqual(world.mercuryPosts[0].body.emails, ['billing@tko.example', 'tom@tko.example']);
  assert.equal((await readBank(env.DB, VENDOR)).mercuryId, 'rec-1');
});

test('no bank details before the address the bank needs', async () => {
  const r = await call({ action: 'bank', token: await tokenFor(), routing: '021000021', account: '44445555', account2: '44445555', kind: 'businessChecking' });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'address');
  assert.equal(world.mercuryPosts.length, 0);
});

// ─── Their invoices ─────────────────────────────────────────────────

test('invoices in words a vendor uses: waiting, approved, held for documents, on its way, paid', async () => {
  const bill = (id, o) => env.DB.prepare('INSERT INTO spend_bills (id, job_id, vendor, cents, date, created_at, status, number, lines, account_id, paid, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, 'J1', 'TKO Plumbing', 100000, o.date, o.date, o.status || 'approved', id.slice(-1), '[]', VENDOR, o.paid || 0, o.balance ?? 100000).run();
  const appr = (id, o) => env.DB.prepare('INSERT INTO bill_approvals (bill_id, state, pay_state, paid_at) VALUES (?, ?, ?, ?)').bind(id, o.state || 'approved', o.payState || null, o.paidAt || null).run();
  await bill('B1', { date: '2026-10-01', status: 'pending' });
  await bill('B2', { date: '2026-10-02' }); await appr('B2', {});
  await bill('B3', { date: '2026-10-03' }); await appr('B3', { payState: 'held' });
  await bill('B4', { date: '2026-10-04' }); await appr('B4', { payState: 'sent' });
  await bill('B5', { date: '2026-10-05', paid: 100000, balance: 0 }); await appr('B5', { payState: 'paid', paidAt: '2026-10-09T15:00:00Z' });
  await bill('B6', { date: '2026-10-06', status: 'denied' });
  const list = await partnerInvoices(env.DB, VENDOR, { now: NOW });
  assert.deepEqual(list.map((i) => [i.id, i.status]), [['B6', 'declined'], ['B5', 'paid'], ['B4', 'sending'], ['B3', 'held'], ['B2', 'approved'], ['B1', 'review']]);
  assert.equal(list.find((i) => i.id === 'B5').paidAt, '2026-10-09T15:00:00Z');
});

// ─── The page, in one read ──────────────────────────────────────────

test('the page’s read: company, documents, steps, bank (last four only), invoices', async () => {
  const token = await tokenFor();
  await call({ action: 'company', token, ...COMPANY });
  const { link } = await findLink(env.DB, token);
  const v = await partnerView(env, link);
  assert.equal(v.scope, 'vendor');
  assert.equal(v.company.main.email, 'tom@tko.example');
  assert.equal(v.company.billing.email, 'billing@tko.example');
  assert.deepEqual(v.steps, { company: true, w9: false, coi: true, bank: false });
  assert.deepEqual(v.docs.needs, ['w9']);
  assert.equal(v.bank, null);
  assert.equal(v.bankFresh, true);
  assert.deepEqual(v.docs.holder, ['Sunshine on a Ranney Day', '250 Hembree Park Drive, Suite 106', 'Roswell, GA 30076']);
});

// ─── "Work with us" and the admin's decisions ───────────────────────

test('a typed company name means one JobTread vendor, or none', () => {
  const rows = [
    { jt_id: 'A1', name: 'TKO Plumbing, LLC', facts: '{}' }, { jt_id: 'A2', name: 'Lackey Plumbing & Drain', facts: '{}' },
    { jt_id: 'A3', name: 'ABC Electric', facts: '{}' }, { jt_id: 'A4', name: 'ABC Painting', facts: '{}' },
    { jt_id: 'A5', name: 'Sample Tile Co', facts: '{"jobs":[]}' }, { jt_id: 'A6', name: 'Sample Tile Company', facts: '{"jobs":[{"jobId":"J1"}]}' },
  ];
  assert.equal(matchVendor(rows, 'TKO Plumbing')?.jtId, 'A1');
  assert.equal(matchVendor(rows, 'tko plumbing llc')?.jtId, 'A1');
  assert.equal(matchVendor(rows, 'Lackey')?.jtId, 'A2', 'the short name of the only vendor like it');
  assert.equal(matchVendor(rows, 'ABC'), null, 'two vendors like it: neither');
  assert.equal(matchVendor(rows, 'Sample Tile')?.jtId, 'A6', 'JobTread’s doubles: the one on jobs');
  assert.equal(matchVendor(rows, 'Brand New Builders'), null);
  assert.equal(matchVendor(rows, 'Co'), null, 'too short to mean anyone');
});

test('“Get started”: checked, a bot ignored, and an email JobTread has is a sign-in', async () => {
  let r = await call({ action: 'start', company: 'Rivera Example Roofing', name: 'Maria Rivera', email: 'maria@rivera.example', phone: '404' });
  assert.equal(r.field, 'phone');
  r = await call({ action: 'start', company: 'Bot Co', name: 'Bot', email: 'bot@x.example', phone: '4045550100', website2: 'http://spam' });
  assert.equal(r.ok, true);
  assert.equal(world.emails.length, 0, 'the hidden field caught a bot');
  r = await call({ action: 'start', company: 'Whatever They Typed', name: 'Tom', email: 'Tom@TKO.example', phone: '4045550134' });
  assert.equal(r.ok, true);
  assert.equal(r.how, undefined, 'the page never says what JobTread has');
  assert.match(world.emails.at(-1).subject, /^Your sign-in link/);
  assert.deepEqual(world.emails.at(-1).to, ['tom@tko.example']);
  assert.equal(world.made.length, 0);
});

test('“Get started” for a vendor JobTread has with nobody on file: they become its main contact, invited, noted', async () => {
  world.accounts[VENDOR].contacts = [];
  world.accounts[VENDOR].primary = null;
  await env.DB.prepare("UPDATE vendors SET email = NULL, facts = '{}' WHERE jt_id = ?").bind(VENDOR).run();
  const r = await startPartner(env, { company: 'TKO Plumbing LLC', name: 'Tom Kowalski', email: 'tom@tko.example', phone: '(404) 555-0134', lang: 'es' }, { now: NOW });
  assert.equal(r.how, 'matched');
  assert.equal(world.made.length, 0, 'no second vendor in JobTread');
  const c = world.accounts[VENDOR].contacts[0];
  assert.equal(c.email, 'tom@tko.example');
  assert.equal(c.title, 'Main contact');
  assert.match(world.emails.at(-1).subject, /Configure su cuenta/);
  assert.match(world.emails.at(-1).text, /trade-partners\/account\/#t=/);
  const note = world.comments.at(-1);
  assert.equal(note.name, 'Started on the trade-partner page');
  assert.match(note.message, /Tom Kowalski \(tom@tko\.example, \+14045550134\) started TKO Plumbing’s trade-partner account on SOARD’s page on .*typing “TKO Plumbing LLC”, which matched this vendor/);
  assert.equal((await readProfileRow(env.DB, VENDOR)).invitedBy, 'signup');
  // Next time it's a sign-in
  await startPartner(env, { company: 'TKO', name: 'Tom', email: 'tom@tko.example', phone: '4045550134' }, { now: NOW });
  assert.match(world.emails.at(-1).subject, /^Your sign-in link/);
});

test('“Get started” for a vendor that already has people on file: the link goes to them, not the new address', async () => {
  const r = await startPartner(env, { company: 'TKO Plumbing', name: 'Someone', email: 'someone@elsewhere.example', phone: '4045550199' }, { now: NOW });
  assert.equal(r.how, 'theirs');
  assert.deepEqual(world.emails.at(-1).to, ['tom@tko.example']);
  assert.ok(!world.emails.some((m) => m.to.includes('someone@elsewhere.example')));
  assert.equal(world.accounts[VENDOR].contacts.length, 1, 'nobody added');
  assert.match(world.comments.at(-1).message, /JobTread already has tom@tko\.example for them, so the link went there, not to someone@elsewhere\.example/);
});

test('“Get started” for a company new to SOARD: made a vendor in JobTread with its main contact, invited, noted', async () => {
  const r = await startPartner(env, { company: 'Rivera Example Roofing', name: 'Maria Rivera', email: 'Maria@Rivera.example', phone: '404-555-0100' }, { now: NOW });
  assert.equal(r.how, 'new');
  assert.equal(world.made[0].type, 'vendor');
  assert.equal(world.made[0].name, 'Rivera Example Roofing');
  const jtId = Object.keys(world.accounts).find((id) => world.accounts[id].name === 'Rivera Example Roofing');
  const acc = world.accounts[jtId];
  assert.equal(acc.contacts[0].email, 'maria@rivera.example');
  assert.equal(acc.contacts[0].title, 'Main contact');
  assert.match(world.emails.at(-1).subject, /^Set up your account/);
  assert.match(world.comments.at(-1).message, /as a company new to SOARD, so this vendor was made for them/);
  assert.equal((await readProfileRow(env.DB, jtId)).invitedBy, 'signup:new');
  assert.equal(world.slack.length, 0, 'nobody approves anything');
});

test('inviting someone new at a vendor JobTread has: added as a contact, never changing who the main one is', async () => {
  const r = await invitePartner(env, { jtId: VENDOR, name: 'Office Manager', email: 'office@tko.example', by: 'Peter' });
  assert.equal(r.created, false);
  const c = world.accounts[VENDOR].contacts.find((x) => x.email === 'office@tko.example');
  assert.equal(c.title, 'Contact');
  assert.equal(world.accounts[VENDOR].primary, 'CON1');
  assert.match(world.emails.at(-1).subject, /^Set up your account/);
});

test('an unfinished setup is nudged after 2 days, then 5, then left alone', async () => {
  await invitePartner(env, { jtId: VENDOR, name: 'Tom', email: 'tom@tko.example', by: 'Peter' }, { now: NOW });
  world.emails = [];
  assert.equal((await partnerNudges(env, { now: NOW + DAY })).reminded, 0);
  assert.equal((await partnerNudges(env, { now: NOW + 2 * DAY + 1000 })).reminded, 1);
  assert.match(world.emails.at(-1).subject, /^A reminder: set up your account/);
  assert.equal(world.comments.at(-1).name, 'Setup reminder emailed');
  assert.equal((await partnerNudges(env, { now: NOW + 4 * DAY })).reminded, 0);
  assert.equal((await partnerNudges(env, { now: NOW + 5 * DAY + 2000 })).reminded, 1);
  assert.equal((await partnerNudges(env, { now: NOW + 30 * DAY })).reminded, 0);
  assert.equal(world.emails.length, 2);
});

test('the landing page’s config: the trades and whether Turnstile is on', async () => {
  const r = await (await get({ env, request: new Request('https://x.example/api/trade-partner?config') })).json();
  assert.equal(r.ok, true);
  assert.ok(r.trades.includes('Electrical'));
  assert.equal(r.turnstileSiteKey, null);
});
