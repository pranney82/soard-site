/**
 * Vendors: one list from Mercury, JobTread and spending; W-9s through
 * Mercury, insurance certificates through our own page; 1099s
 * (functions/api/_vendors.js, vendors-admin.js, vendor-docs.js)
 * Run: node --test tests/
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { MERCURY_BASE, writeState } from '../functions/api/_mercury.js';
import { mirrorTransaction } from '../functions/api/_mercury-txns.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import {
  joinVendors, readVendors, vendorsView, maybeRunVendors, unlinkVendor, linkVendors, createUploadLink, csv1099, documentType,
  readVendor, STATE_KEY, season1099,
} from '../functions/api/_vendors.js';
import * as docs from '../functions/api/vendor-docs.js';
import * as admin from '../functions/api/vendors-admin.js';

const RELAY_KEY = 'relay-key:test';
const NOW = Date.parse('2026-10-27T16:00:00Z');
const DAY = 86400e3;
const PDF = new TextEncoder().encode('%PDF-1.7\n% a certificate\n');

let world;
const fresh = () => ({
  recipients: [
    { id: 'r-tko', name: 'TKO Plumbing LLC', status: 'active', emails: [], contactEmail: 'office@tko.example', isBusiness: true, defaultPaymentMethod: 'ach', attachments: [], address: { address1: '1 Pipe St', city: 'Atlanta', region: 'GA', postalCode: '30301', name: 'TKO' } },
    { id: 'r-pwr', name: 'Power Up Electrical', status: 'active', emails: ['billing@powerup.example'], isBusiness: true, defaultPaymentMethod: 'check', attachments: [] },
  ],
  taxForms: [{ id: 'att1', recipientId: 'r-pwr', fileName: 'w9.pdf', url: 'https://mercury.example/w9.pdf', uploadedAt: '2026-03-01T00:00:00Z', formType: 'w9' }],
  invites: [],
  madeInvites: [],
  uploads: [],
  jtVendors: [
    { id: 'jv-tko', name: 'TKO Plumbing', archivedAt: null, contacts: { nodes: [] } },
    { id: 'jv-hd', name: 'The Home Depot', archivedAt: null, contacts: { nodes: [] } },
    { id: 'jv-paint', name: 'Bright Coat Painting', archivedAt: null, contacts: { nodes: [{ customFieldValues: { nodes: [{ value: 'hello@brightcoat.example' }] } }] } },
  ],
  jobs: [{ id: 'J1', name: 'Max Daniel (2026)', status: 'Build' }, { id: 'J2', name: 'Colin Lindsay (2026)', status: 'Approval' }],
  docs: {
    J1: [{ type: 'vendorOrder', status: 'approved', account: { id: 'jv-tko' } }, { type: 'vendorBill', status: 'approved', account: { id: 'jv-hd' } }],
    J2: [{ type: 'vendorOrder', status: 'pending', account: { id: 'jv-paint' } }],
  },
  slack: [],
  emails: [],
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.origin === MERCURY_BASE) {
    if (init.headers?.['X-Relay-Key'] !== RELAY_KEY) return new Response('Forbidden', { status: 403 });
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/recipients') return Response.json({ recipients: world.recipients, page: {} });
    if (p === '/recipients/attachments') return Response.json({ attachments: world.taxForms, page: {} });
    if (p === '/recipients/invites' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const made = { id: `inv${world.madeInvites.length + 1}`, onboardingUrl: 'https://mercury.example/onboard', status: 'created', ...body };
      world.madeInvites.push(made);
      world.invites.push(made);
      return Response.json(made, { status: 201 });
    }
    if (p === '/recipients/invites') return Response.json({ invites: world.invites, page: {} });
    const up = p.match(/^\/recipient\/(.+)\/attachments$/);
    if (up && init.method === 'POST') { world.uploads.push({ recipientId: up[1], file: init.body.get('file') }); return Response.json({ attachmentId: 'a9', downloadUrl: 'x' }); }
    const one = p.match(/^\/recipient\/(.+)$/);
    if (one) return Response.json({ ...world.recipients.find((r) => r.id === one[1]), attachments: world.taxForms.filter((a) => a.recipientId === one[1]) });
    throw new Error(`Mercury doesn't know ${p}`);
  }
  if (url.host === 'api.jobtread.com') {
    const { query } = JSON.parse(init.body);
    if (query.organization?.accounts) return Response.json({ organization: { accounts: { nextPage: null, nodes: world.jtVendors } } });
    if (query.organization?.jobs) {
      return Response.json({ organization: { jobs: { nextPage: null, nodes: world.jobs.map((j) => ({ id: j.id, name: j.name, customFieldValues: { nodes: [{ value: j.status }] }, aces: { nodes: [] } })) } } });
    }
    if (query.job?.documents) return Response.json({ job: { documents: { nextPage: null, nodes: world.docs[query.job.$.id] || [] } } });
    throw new Error(`JobTread doesn't know ${JSON.stringify(Object.keys(query))}`);
  }
  if (url.host === 'slack.com') {
    const body = init.body instanceof URLSearchParams || typeof init.body === 'string' && !init.body.startsWith('{') ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
    world.slack.push({ method: url.pathname.split('/').pop(), ...body });
    return Response.json({ ok: true, channel: body.channel || 'CFIN', ts: `${world.slack.length}.1`, channel_obj: {} });
  }
  if (url.host === 'api.resend.com') {
    const batch = JSON.parse(init.body);
    world.emails.push(...batch);
    return Response.json({ data: batch.map((_, i) => ({ id: `em${i}` })) });
  }
  throw new Error(`unexpected fetch ${url.href}`);
};
after(() => { globalThis.fetch = realFetch; });

function bucket() {
  const files = new Map();
  return {
    files,
    async put(key, bytes, opts) { files.set(key, { bytes, type: opts?.httpMetadata?.contentType }); },
    async get(key) { const f = files.get(key); return f ? { body: f.bytes, size: f.bytes.length, httpMetadata: { contentType: f.type } } : null; },
  };
}

let env;
beforeEach(async () => {
  world = fresh();
  const DB = await createD1({ schemaSql: ['CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)'] });
  env = { DB, MERCURY_API_TOKEN: 'secret-token:test', MERCURY_RELAY_KEY: RELAY_KEY, JOBTREAD_GRANT_KEY: 'jt', SLACK_BOT_TOKEN: 'xoxb-test', RESEND_API_KEY: 're_test', FILES: bucket() };
  await writeSlackConfig(DB, { channel: { id: 'CNEWS', name: 'news' }, finance: { id: 'CFIN', name: 'finance', private: true } });
});

const pay = (id, o) => mirrorTransaction(env.DB, { id, status: 'sent', accountId: 'acc', postedAt: '2026-06-01T12:00:00Z', createdAt: '2026-06-01T12:00:00Z', ...o });
const byName = async (name) => (await vendorsView(env, { now: NOW })).vendors.find((v) => v.name === name);
const posts = () => world.slack.filter((s) => s.method === 'chat.postMessage');

test('one vendor from Mercury, JobTread and a card charge, with what each needs', async () => {
  await pay('t1', { kind: 'outgoingPayment', amount: -4200, counterpartyId: 'r-tko', counterpartyName: 'TKO Plumbing LLC' });
  await pay('t2', { kind: 'creditCardTransaction', amount: -310.55, counterpartyName: 'THE HOME DEPOT #121' });
  await pay('t3', { kind: 'outgoingPayment', amount: -900, counterpartyId: 'r-tko', counterpartyName: 'TKO Plumbing LLC', postedAt: '2025-11-02T12:00:00Z', createdAt: '2025-11-02T12:00:00Z' });
  await maybeRunVendors(env, { now: NOW, force: true });
  const list = await readVendors(env.DB);
  // TKO Plumbing LLC (Mercury) and TKO Plumbing (JobTread) are one vendor
  const tko = list.filter((v) => /tko/i.test(v.name));
  assert.equal(tko.length, 1);
  assert.equal(tko[0].mercuryId, 'r-tko');
  assert.equal(tko[0].jtId, 'jv-tko');
  assert.equal(tko[0].email, 'office@tko.example');

  const t = await byName('TKO Plumbing LLC');
  assert.equal(t.kind, 'sub');
  assert.equal(t.paid.reportable[2026], 420000);
  assert.equal(t.paid.reportable[2025], 90000);
  assert.deepEqual(t.needs, { w9: true, coi: true, coiOnSite: true, email: false });
  // A W-9 Mercury already holds counts
  const p = await byName('Power Up Electrical');
  assert.equal(p.w9.source, 'mercury');
  assert.equal(p.needs.w9, false);
  // Home Depot only takes the card: a supplier, needing nothing; its card spend is the network's 1099-K
  const hd = await byName('The Home Depot');
  assert.equal(hd.kind, 'supplier');
  assert.equal(hd.paid.card[2026], 31055);
  assert.deepEqual(hd.needs, { w9: false, coi: false, coiOnSite: false, email: false });
  // A sub on a job in Approval: insurance asked for, but not an on-site alarm
  const paint = await byName('Bright Coat Painting');
  assert.equal(paint.needs.coi, true);
  assert.equal(paint.needs.coiOnSite, false);
});

test('with requests off: nothing reaches a vendor, the Finance channel hears once, and it clears', async () => {
  await pay('t1', { kind: 'outgoingPayment', amount: -4200, counterpartyId: 'r-tko', counterpartyName: 'TKO Plumbing LLC' });
  await maybeRunVendors(env, { now: NOW, force: true });
  assert.equal(world.madeInvites.length, 0);
  assert.equal(world.emails.length, 0);
  const first = posts();
  assert.ok(first.length >= 2);
  assert.ok(first.every((m) => m.channel === 'CFIN'), 'money posts only in the Finance channel');
  assert.ok(first.some((m) => /TKO Plumbing LLC needs a W-9/.test(m.text)));
  assert.ok(first.some((m) => /on site without a current certificate/.test(m.text)));
  // The next run says nothing new
  await maybeRunVendors(env, { now: NOW + 20 * 60e3, force: true });
  assert.equal(posts().length, first.length);
  // The W-9 lands in Mercury: the post turns ✅
  world.taxForms.push({ id: 'att2', recipientId: 'r-tko', fileName: 'w9.pdf', uploadedAt: '2026-10-28T00:00:00Z', formType: 'w9' });
  await maybeRunVendors(env, { now: NOW + 2 * 3600e3, force: true });
  assert.ok(world.slack.some((m) => m.method === 'chat.update' && /Resolved/.test(m.text)));
});

test('without a Finance channel, money stays in the admin', async () => {
  await writeSlackConfig(env.DB, { channel: { id: 'CNEWS', name: 'news' }, attention: { id: 'CALERT', name: 'alerts' } });
  await pay('t1', { kind: 'outgoingPayment', amount: -4200, counterpartyId: 'r-tko', counterpartyName: 'TKO Plumbing LLC' });
  await maybeRunVendors(env, { now: NOW, force: true });
  assert.equal(posts().length, 0);
});

test('with requests on: Mercury asks for the W-9, our email asks for the certificate, a week apart, three times at most', async () => {
  await writeState(env.DB, STATE_KEY, { settings: { autoW9: true, autoCoi: true, threshold: 600, coiDays: 30, replyTo: '' } });
  await pay('t1', { kind: 'outgoingPayment', amount: -4200, counterpartyId: 'r-tko', counterpartyName: 'TKO Plumbing LLC' });
  await maybeRunVendors(env, { now: NOW, force: true });
  const w9 = world.madeInvites.filter((i) => i.recipientId === 'r-tko');
  assert.equal(w9.length, 1);
  assert.equal(w9[0].requireTaxDocument, true);
  assert.equal(w9[0].sendEmail, true);
  assert.equal(w9[0].contactEmail, 'office@tko.example');
  assert.deepEqual(w9[0].paymentMethods, ['ach']);
  // Bright Coat isn't a Mercury recipient yet: invited by name, from the JobTread contact's email
  assert.ok(world.madeInvites.some((i) => i.name === 'Bright Coat Painting' && i.contactEmail === 'hello@brightcoat.example'));
  const coiMail = world.emails.filter((e) => e.to[0] === 'office@tko.example');
  assert.equal(coiMail.length, 1);
  assert.match(coiMail[0].html, /vendor-documents\/#t=[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(coiMail[0].text, /—/);

  // Within the week: nothing again
  await maybeRunVendors(env, { now: NOW + 3 * DAY, force: true });
  assert.equal(world.madeInvites.filter((i) => i.recipientId === 'r-tko').length, 1);
  // Each week after: again, three times in all
  for (let w = 1; w <= 4; w++) await maybeRunVendors(env, { now: NOW + w * 8 * DAY, force: true });
  assert.equal(world.madeInvites.filter((i) => i.recipientId === 'r-tko').length, 3);
  assert.equal(world.emails.filter((e) => e.to[0] === 'office@tko.example').length, 3);
  // Home Depot (card only) was never asked anything
  assert.ok(!world.emails.some((e) => /depot/i.test(e.subject)));
});

test('the vendor’s page: certificate and W-9 in, private, onto Mercury; bad links and files refused', async () => {
  await maybeRunVendors(env, { now: NOW, force: true });
  const tko = (await readVendors(env.DB)).find((v) => v.mercuryId === 'r-tko');
  const { token } = await createUploadLink(env.DB, tko.id, { now: Date.now() });

  const get = async (t) => docs.onRequestGet({ env, request: new Request(`https://x/api/vendor-docs?token=${t}`) });
  const okGet = await get(token);
  assert.equal(okGet.status, 200);
  assert.deepEqual((await okGet.json()).vendor, { name: tko.name, coi: null, needsW9: true });
  assert.equal((await get('nope-nope-nope-nope-nope')).status, 404);

  const post = (fields) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return docs.onRequestPost({ env, request: new Request('https://x/api/vendor-docs', { method: 'POST', body: form }) });
  };
  const expires = new Date(Date.now() + 200 * DAY).toLocaleDateString('en-CA');
  // A file that isn't a PDF or photo
  let r = await post({ token, coi: new File([new TextEncoder().encode('<svg/>')], 'c.svg', { type: 'image/svg+xml' }), coiExpires: expires });
  assert.equal(r.status, 400);
  // No end date
  r = await post({ token, coi: new File([PDF], 'coi.pdf', { type: 'application/pdf' }) });
  assert.equal(r.status, 400);
  r = await post({ token, coi: new File([PDF], 'coi.pdf', { type: 'application/pdf' }), coiExpires: expires, coiInsurer: 'Acme Mutual', w9: new File([PDF], 'w9.pdf', { type: 'application/pdf' }) });
  assert.equal(r.status, 200, await r.clone().text());
  const after = await readVendor(env.DB, tko.id);
  assert.equal(after.coi.expires, expires);
  assert.equal(after.coi.insurer, 'Acme Mutual');
  assert.ok(after.coi.key.startsWith(`vendors/${tko.id}/coi-`));
  assert.equal(after.w9.source, 'upload');
  assert.equal(world.uploads.length, 1);
  assert.equal(world.uploads[0].recipientId, 'r-tko');
  // Kept under vendors/, which the public /files/ route never serves
  const { onRequestGet: publicFiles } = await import('../functions/files/[[path]].js');
  const pub = await publicFiles({ env, params: { path: after.coi.key.split('/') }, request: new Request(`https://x/files/${after.coi.key}`) });
  assert.equal(pub.status, 404);
  // The admin reads it back
  const file = await admin.onRequestGet({ env, data: {}, request: new Request(`https://x/api/vendors-admin?file=${tko.id}&doc=coi`) });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('Content-Type'), 'application/pdf');
  // A newer link replaces this one
  await createUploadLink(env.DB, tko.id);
  assert.equal((await get(token)).status, 410);
});

test('staff pull two apart, and the next read doesn’t join them again', async () => {
  await maybeRunVendors(env, { now: NOW, force: true });
  const tko = (await readVendors(env.DB)).find((v) => v.mercuryId === 'r-tko');
  const split = await unlinkVendor(env.DB, tko.id, 'jobtread');
  assert.equal(split.jtId, 'jv-tko');
  await maybeRunVendors(env, { now: NOW + 5 * 3600e3, force: true });
  const rows = (await readVendors(env.DB)).filter((v) => v.mercuryId === 'r-tko' || v.jtId === 'jv-tko');
  assert.equal(rows.length, 2);
  // And link them back
  const kept = await linkVendors(env.DB, rows[0].id, rows[1].id);
  assert.ok(kept.mercuryId && kept.jtId);
  assert.equal((await readVendors(env.DB)).filter((v) => v.mercuryId === 'r-tko' || v.jtId === 'jv-tko').length, 1);
});

test('1099s: reportable payees over $600, corporations out, card never counted; CSV and the January card', async () => {
  await pay('a', { kind: 'outgoingPayment', amount: -5000, counterpartyId: 'r-tko', counterpartyName: 'TKO Plumbing LLC', postedAt: '2026-03-02T12:00:00Z' });
  await pay('b', { kind: 'outgoingPayment', amount: -700, counterpartyId: 'r-pwr', counterpartyName: 'Power Up Electrical', postedAt: '2026-05-02T12:00:00Z' });
  await pay('c', { kind: 'outgoingPayment', amount: -500, counterpartyId: 'r-pwr', counterpartyName: 'Power Up Electrical', postedAt: '2026-06-02T12:00:00Z' });
  await pay('d', { kind: 'creditCardTransaction', amount: -9000, counterpartyName: 'THE HOME DEPOT #121', postedAt: '2026-06-02T12:00:00Z' });
  await maybeRunVendors(env, { now: NOW, force: true });
  let view = await vendorsView(env, { now: NOW });
  assert.deepEqual(view.filings[2026].map((r) => [r.name, r.total, r.w9]), [['TKO Plumbing LLC', 500000, false], ['Power Up Electrical', 120000, true]]);
  const csv = csv1099(view.filings[2026], 2026);
  assert.match(csv.split("\n")[0], /^Vendor,"Total paid \(ACH, check, wire\)",W-9 on file/);
  assert.match(csv, /TKO Plumbing LLC,5000\.00,No,"1 Pipe St, Atlanta, GA 30301"/);
  // A corporation (from its W-9) is left off
  const pwr = view.vendors.find((v) => v.mercuryId === 'r-pwr');
  await admin.onRequestPost({ env, data: { userEmail: 'staff@soardcharity.com' }, request: new Request('https://x', { method: 'POST', body: JSON.stringify({ action: 'set', id: pwr.id, corp: true }) }) });
  view = await vendorsView(env, { now: NOW });
  assert.deepEqual(view.filings[2026].map((r) => r.name), ['TKO Plumbing LLC']);
  // January 5th: last year's list in the Finance channel, once
  const jan = Date.parse('2027-01-05T15:00:00Z');
  await season1099(env, { now: jan });
  await season1099(env, { now: jan + DAY });
  const cards = posts().filter((m) => /1099s for 2026/.test(m.text));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].channel, 'CFIN');
});

test('documents are told apart by their own bytes', () => {
  assert.equal(documentType(PDF.slice(0, 16)), 'application/pdf');
  assert.equal(documentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(documentType(new TextEncoder().encode('<svg xmlns=')), null);
  assert.equal(documentType(new TextEncoder().encode('<!doctype html>')), null);
});

test('admin settings: preview goes only to the person asking; bad input refused', async () => {
  const call = (body, email = 'staff@soardcharity.com') => admin.onRequestPost({ env, data: { userEmail: email }, request: new Request('https://x', { method: 'POST', body: JSON.stringify(body) }) });
  let r = await call({ action: 'settings', threshold: -5 });
  assert.equal(r.status, 400);
  r = await call({ action: 'settings', autoCoi: true, replyTo: 'ap@soardcharity.com' });
  assert.equal((await r.json()).settings.autoCoi, true);
  r = await call({ action: 'preview', kind: 'coi' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(world.emails.length, 1);
  assert.deepEqual(world.emails[0].to, ['staff@soardcharity.com']);
  assert.match(world.emails[0].subject, /^Preview: /);
  assert.equal(world.emails[0].reply_to, 'ap@soardcharity.com');
  r = await call({ action: 'preview', kind: 'w9' });
  assert.equal(world.madeInvites.at(-1).contactEmail, 'staff@soardcharity.com');
  assert.match(world.madeInvites.at(-1).name, /\(preview\)$/);
});
