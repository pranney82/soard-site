/**
 * Vendors: who SOARD pays, their W-9 and insurance, and 1099s
 * ===========================================================================
 * One list of vendors joined from three places:
 *   Mercury     recipients (paid by ACH, check or wire) and the tax forms
 *               they uploaded to Mercury
 *   JobTread    vendor accounts, and which open jobs each is on (a purchase
 *               order or a bill on the job)
 *   Spending    card charges and bills on makeovers (spend_charges,
 *               spend_bills) and every Mercury payment (mercury_txns)
 * The same name in two places is one vendor (vendorKey); staff can link two
 * the site didn't, or pull apart two it shouldn't have, and those choices
 * stick (locked).
 *
 * Subs and suppliers. A sub (paid by ACH or check, or on a job's purchase
 * order) needs a W-9 and a certificate of insurance (COI). A supplier SOARD
 * only pays by card (Home Depot, Wayfair) needs neither: card payments are
 * reported by the card network on a 1099-K, never on SOARD's 1099-NEC.
 * Staff can say otherwise for any vendor.
 *
 * W-9s come through Mercury: a recipient invite with requireTaxDocument has
 * Mercury email the vendor its own page for bank details and the form. The
 * site never asks for, types or keeps a tax ID; only the forms themselves
 * (in Mercury, or a file in R2 when a vendor sends one through our page).
 *
 * COIs come through our page (/vendor-documents/#t=<token>): the vendor
 * uploads the certificate and types its end date and insurer. Files live in
 * R2 under vendors/ (VENDOR_FILES when bound, else FILES; the public
 * /files/ route serves only financials/), read back only through the admin.
 *
 * Nothing goes to a vendor until it's switched on in Vendors → Settings
 * (W-9 requests and COI requests each have their own switch). Problems post
 * once per vendor in the Finance channel and turn ✅ when they clear.
 *
 * Tables: vendors, vendor_links. State: spend_state 'vendors'.
 */

import { pave, SOARD_ORG_ID, TZ } from './_reveals.js';
import { slackIssue, slackResolved, slackPost, sendEmails, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { emailShell, paragraphs, button } from './_email-shell.js';
import {
  readState, writeState, mercuryConfigured, listRecipients, listRecipientAttachments, listRecipientInvites, createRecipientInvite,
  uploadRecipientAttachment,
} from './_mercury.js';
import { readTxns } from './_mercury-txns.js';
import { vendorKey, vendorLikeness } from './_spend-match.js';
import { FIELD_CONTACT_EMAIL } from './_reveal-invites.js';

export const STATE_KEY = 'vendors';
export const ADMIN_URL = `${SITE_ORIGIN}/admin/#vendors`;
export const UPLOAD_PAGE = `${SITE_ORIGIN}/vendor-documents/`;

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const RUN_EVERY_MS = 15 * MIN;
const RECIPIENTS_EVERY_MS = 60 * MIN;
const JOBTREAD_EVERY_MS = 4 * 60 * MIN;
export const ASK_AGAIN_DAYS = 7;
export const MAX_ASKS = 3;
export const LINK_DAYS = 30;
export const DEFAULTS = { autoW9: false, autoCoi: false, threshold: 600, coiDays: 30, replyTo: '' };
export const LIMITS = { fileBytes: 15 * 1024 * 1024, insurer: 120, uploads: 20 };

// Mercury kinds: money out to a payee that a 1099-NEC counts, and card spending (a 1099-K, the network's)
export const REPORTABLE_KINDS = new Set(['outgoingPayment']);
export const CARD_KINDS = new Set(['creditCardTransaction', 'debitCardTransaction', 'creditCardCredit', 'debitCardCredit']);
const TAX_FORMS = new Set(['w9', 'w8BEN', 'w8BENE', 'unknown']);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vendors (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, vkey TEXT, mercury_id TEXT, jt_id TEXT, email TEXT, email_set INTEGER DEFAULT 0,
    kind_set TEXT, corp INTEGER DEFAULT 0, coi_needed INTEGER,
    w9_source TEXT, w9_at TEXT, w9_key TEXT, w9_name TEXT,
    coi_key TEXT, coi_name TEXT, coi_expires TEXT, coi_insurer TEXT, coi_at TEXT, coi_by TEXT,
    invite_id TEXT, invite_status TEXT, invite_at TEXT, invites INTEGER DEFAULT 0,
    coi_link_at TEXT, coi_asks INTEGER DEFAULT 0,
    locked INTEGER DEFAULT 0, facts TEXT, created_at TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS vendors_mercury ON vendors (mercury_id)',
  'CREATE INDEX IF NOT EXISTS vendors_jt ON vendors (jt_id)',
  `CREATE TABLE IF NOT EXISTS vendor_links (
    token_hash TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', uploads INTEGER NOT NULL DEFAULT 0, last_upload_at TEXT, by TEXT)`,
  'CREATE INDEX IF NOT EXISTS vendor_links_vendor ON vendor_links (vendor_id)',
];

const _ready = new WeakSet();
export async function ensureVendorSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}

const isoDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const yearOf = (ms) => Number(isoDay(ms).slice(0, 4));
const parseJson = (s, d = {}) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const newId = () => `v_${[...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

export async function readSettings(DB) {
  const st = await readState(DB, STATE_KEY);
  return { ...DEFAULTS, ...(st.settings || {}) };
}

// ─── Rows ───────────────────────────────────────────────────────────

function fromRow(r) {
  return {
    id: r.id, name: r.name, vkey: r.vkey, mercuryId: r.mercury_id, jtId: r.jt_id, email: r.email, emailSet: !!r.email_set,
    kindSet: r.kind_set || null, corp: !!r.corp, coiNeeded: r.coi_needed == null ? null : !!r.coi_needed,
    w9: r.w9_source ? { source: r.w9_source, at: r.w9_at, key: r.w9_key, name: r.w9_name } : null,
    coi: r.coi_key || r.coi_expires ? { key: r.coi_key, name: r.coi_name, expires: r.coi_expires, insurer: r.coi_insurer, at: r.coi_at, by: r.coi_by } : null,
    invite: r.invite_id ? { id: r.invite_id, status: r.invite_status, at: r.invite_at, count: r.invites || 0 } : (r.invites ? { id: null, status: null, at: r.invite_at, count: r.invites } : null),
    coiAsk: r.coi_link_at ? { at: r.coi_link_at, count: r.coi_asks || 0 } : null,
    locked: !!r.locked, facts: parseJson(r.facts), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const COLS = {
  name: 'name', vkey: 'vkey', mercuryId: 'mercury_id', jtId: 'jt_id', email: 'email', emailSet: 'email_set', kindSet: 'kind_set', corp: 'corp', coiNeeded: 'coi_needed',
  w9Source: 'w9_source', w9At: 'w9_at', w9Key: 'w9_key', w9Name: 'w9_name',
  coiKey: 'coi_key', coiName: 'coi_name', coiExpires: 'coi_expires', coiInsurer: 'coi_insurer', coiAt: 'coi_at', coiBy: 'coi_by',
  inviteId: 'invite_id', inviteStatus: 'invite_status', inviteAt: 'invite_at', invites: 'invites', coiLinkAt: 'coi_link_at', coiAsks: 'coi_asks',
  locked: 'locked', facts: 'facts',
};

export async function readVendors(DB) {
  await ensureVendorSchema(DB);
  return ((await DB.prepare('SELECT * FROM vendors ORDER BY name COLLATE NOCASE').all()).results || []).map(fromRow);
}

export async function readVendor(DB, id) {
  await ensureVendorSchema(DB);
  const r = await DB.prepare('SELECT * FROM vendors WHERE id = ?').bind(String(id || '')).first();
  return r ? fromRow(r) : null;
}

/** Change some of a vendor's fields (camelCase keys of COLS) */
export async function patchVendor(DB, id, patch, now = Date.now()) {
  await ensureVendorSchema(DB);
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!COLS[k]) continue;
    sets.push(`${COLS[k]} = ?`);
    args.push(k === 'facts' ? JSON.stringify(v || {}) : typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null);
  }
  if (!sets.length) return readVendor(DB, id);
  await DB.prepare(`UPDATE vendors SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...args, new Date(now).toISOString(), id).run();
  return readVendor(DB, id);
}

async function insertVendor(DB, { name, mercuryId = null, jtId = null, email = null, facts = {}, locked = false }, now = Date.now()) {
  const id = newId();
  const iso = new Date(now).toISOString();
  await DB.prepare('INSERT INTO vendors (id, name, vkey, mercury_id, jt_id, email, locked, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, String(name || 'Vendor').slice(0, 160), vendorKey(name), mercuryId, jtId, isEmail(email) ? String(email).toLowerCase() : null, locked ? 1 : 0, JSON.stringify(facts), iso, iso).run();
  return readVendor(DB, id);
}

// ─── Reading Mercury and JobTread ───────────────────────────────────

/** JobTread's vendor accounts → [{ id, name, email, archived }] */
export async function jobtreadVendors(env, { fetchImpl = fetch } = {}) {
  const out = [];
  let page = null;
  for (let i = 0; i < 40; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: {
        $: { id: SOARD_ORG_ID },
        accounts: {
          $: { size: 25, where: ['type', '=', 'vendor'], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, name: {}, archivedAt: {},
            contacts: { $: { size: 3 }, nodes: { customFieldValues: { $: { size: 1, where: [['customField', 'id'], '=', FIELD_CONTACT_EMAIL] }, nodes: { value: {} } } } },
          },
        },
      },
    }, fetchImpl);
    const conn = data?.organization?.accounts;
    for (const a of conn?.nodes || []) {
      const email = (a.contacts?.nodes || []).map((c) => c.customFieldValues?.nodes?.[0]?.value).find(isEmail) || null;
      out.push({ id: a.id, name: a.name, email: email ? email.toLowerCase() : null, archived: !!a.archivedAt });
    }
    page = conn?.nextPage;
    if (!page) break;
  }
  return out;
}

/**
 * Which vendors are on which open jobs: an order (PO) or a bill on the job.
 * jobs: [{ id, name, status }] → { [jtVendorId]: [{ jobId, jobName, status, order }] }
 */
export async function vendorsOnJobs(env, jobs, { fetchImpl = fetch } = {}) {
  const out = {};
  for (const job of jobs) {
    let page = null;
    for (let i = 0; i < 10; i++) {
      const data = await pave(env.JOBTREAD_GRANT_KEY, {
        job: {
          $: { id: job.id },
          documents: {
            $: { size: 25, where: ['type', 'in', ['vendorBill', 'vendorOrder']], ...(page ? { page } : {}) },
            nextPage: {},
            nodes: { type: {}, status: {}, account: { id: {} } },
          },
        },
      }, fetchImpl);
      const conn = data?.job?.documents;
      for (const d of conn?.nodes || []) {
        const vid = d.account?.id;
        if (!vid || d.status === 'denied') continue;
        const list = (out[vid] ||= []);
        let e = list.find((x) => x.jobId === job.id);
        if (!e) list.push(e = { jobId: job.id, jobName: job.name, status: job.status || null, order: false });
        if (d.type === 'vendorOrder') e.order = true;
      }
      page = conn?.nextPage;
      if (!page) break;
    }
  }
  return out;
}

const addressText = (a) => (a ? [a.address1, a.address2, a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ') : null);

/**
 * Join Mercury recipients, JobTread vendors and the names seen in spending
 * into the vendors table. Staff links (locked) are never undone. → counts
 */
export async function joinVendors(DB, { recipients = null, taxForms = null, jtVendors = null, jobsByVendor = null, spendNames = [] } = {}, { now = Date.now() } = {}) {
  await ensureVendorSchema(DB);
  let rows = await readVendors(DB);
  const counts = { made: 0, linked: 0 };
  const byMercury = new Map(rows.filter((r) => r.mercuryId).map((r) => [r.mercuryId, r]));
  const byJt = new Map(rows.filter((r) => r.jtId).map((r) => [r.jtId, r]));
  // A same-named vendor not yet tied to this system, never one staff pulled apart
  const sameName = (name, field) => rows.find((r) => !r[field] && !r.locked && vendorLikeness(r.name, name) === 1)
    || rows.find((r) => !r[field] && !r.locked && (r.facts.names || []).some((n) => vendorLikeness(n, name) === 1));
  const remember = (r) => { rows = rows.filter((x) => x.id !== r.id).concat(r); };
  const withName = (facts, name) => ({ ...facts, names: [...new Set([...(facts.names || []), name].filter(Boolean))].slice(0, 8) });

  if (recipients) {
    const forms = new Map();
    for (const a of taxForms || []) {
      if (!TAX_FORMS.has(a.formType || 'unknown')) continue;
      const prev = forms.get(a.recipientId);
      if (!prev || String(a.uploadedAt) > String(prev.uploadedAt)) forms.set(a.recipientId, a);
    }
    for (const r of recipients) {
      if (r.status === 'deleted') continue;
      const email = [r.contactEmail, ...(r.emails || [])].find(isEmail) || null;
      const mfacts = { isBusiness: r.isBusiness ?? null, method: r.defaultPaymentMethod || null, lastPaid: r.dateLastPaid || null, address: addressText(r.address || r.defaultAddress), nickname: r.nickname || null };
      // Tax forms come with the recipient too; the list endpoint covers recipients the page missed
      const form = forms.get(r.id) || (r.attachments || []).filter((a) => TAX_FORMS.has(a.formType || 'unknown')).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))[0];
      let row = byMercury.get(r.id);
      if (!row) {
        row = sameName(r.name, 'mercuryId');
        if (row) { row = await patchVendor(DB, row.id, { mercuryId: r.id }, now); counts.linked++; }
        else { row = await insertVendor(DB, { name: r.name, mercuryId: r.id, email }, now); counts.made++; }
        byMercury.set(r.id, row);
      }
      const patch = { facts: withName({ ...row.facts, mercury: mfacts }, r.name) };
      if (email && !row.emailSet && !row.email) patch.email = email.toLowerCase();
      if (form && row.w9?.source !== 'upload') Object.assign(patch, { w9Source: 'mercury', w9At: form.uploadedAt || new Date(now).toISOString(), w9Name: form.fileName || 'W-9', w9Key: form.formType || 'unknown' });
      remember(await patchVendor(DB, row.id, patch, now));
    }
  }

  if (jtVendors) {
    for (const v of jtVendors) {
      if (v.archived) continue;
      let row = byJt.get(v.id);
      if (!row) {
        row = sameName(v.name, 'jtId');
        if (row) { row = await patchVendor(DB, row.id, { jtId: v.id }, now); counts.linked++; }
        else { row = await insertVendor(DB, { name: v.name, jtId: v.id, email: v.email }, now); counts.made++; }
        byJt.set(v.id, row);
      }
      const patch = { facts: withName({ ...row.facts, jobs: jobsByVendor ? (jobsByVendor[v.id] || []) : (row.facts.jobs || []) }, v.name) };
      if (v.email && !row.emailSet && !row.email) patch.email = v.email;
      remember(await patchVendor(DB, row.id, patch, now));
    }
  }

  // Names only seen on charges and bills (suppliers, mostly): one row each
  for (const name of spendNames) {
    if (!vendorKey(name)) continue;
    if (rows.some((r) => vendorLikeness(r.name, name) === 1 || (r.facts.names || []).some((n) => vendorLikeness(n, name) === 1))) continue;
    remember(await insertVendor(DB, { name, facts: { names: [name], seen: 'spending' } }, now));
    counts.made++;
  }
  return counts;
}

// ─── Money ──────────────────────────────────────────────────────────

/**
 * What each vendor was paid, from Mercury: reportable (ACH, check, wire:
 * what a 1099-NEC counts) and by card (the card network's 1099-K), this
 * year and last, and each month. → Map(vendorId → money)
 */
export function vendorMoney(vendors, txns, { now = Date.now() } = {}) {
  const year = yearOf(now);
  const byMercury = new Map(vendors.filter((v) => v.mercuryId).map((v) => [v.mercuryId, v.id]));
  const byKey = new Map();
  for (const v of vendors) for (const n of [v.name, ...(v.facts.names || [])]) { const k = vendorKey(n); if (k && !byKey.has(k)) byKey.set(k, v.id); }
  const out = new Map(vendors.map((v) => [v.id, { reportable: { [year]: 0, [year - 1]: 0 }, card: { [year]: 0, [year - 1]: 0 }, months: {}, lastPaid: null, payments: 0 }]));
  for (const t of txns) {
    if (t.status && t.status !== 'sent') continue;
    const when = t.posted_at || t.created_at;
    if (!when) continue;
    const y = Number(when.slice(0, 4));
    let id = null;
    let kind = null;
    if (REPORTABLE_KINDS.has(t.kind) && t.cents < 0) { id = byMercury.get(t.counterparty_id) || byKey.get(vendorKey(t.counterparty)); kind = 'reportable'; }
    else if (CARD_KINDS.has(t.kind)) { id = byKey.get(vendorKey(t.counterparty)); kind = 'card'; }
    if (!id) continue;
    const m = out.get(id);
    const paid = -t.cents; // refunds on a card come back as money in and take away
    if (y === year || y === year - 1) m[kind][y] += paid;
    if (kind === 'reportable') {
      const month = when.slice(0, 7);
      m.months[month] = (m.months[month] || 0) + paid;
      m.payments++;
      if (!m.lastPaid || when > m.lastPaid) m.lastPaid = when;
    }
  }
  return out;
}

// ─── What each vendor needs ─────────────────────────────────────────

/**
 * kind 'sub' | 'supplier'; needs: { w9, coi, coiOnSite, email }; coiState
 * 'current' | 'expiring' | 'expired' | 'missing' | 'not-needed'
 */
export function vendorStatus(v, money, settings = DEFAULTS, { now = Date.now() } = {}) {
  const year = yearOf(now);
  const jobs = v.facts.jobs || [];
  const paidReportable = (money?.payments || 0) > 0;
  const autoKind = jobs.some((j) => j.order) || paidReportable || !!v.mercuryId ? 'sub' : 'supplier';
  const kind = v.kindSet || autoKind;
  const sub = kind === 'sub';
  const onJob = jobs.length > 0;
  const onSite = jobs.some((j) => j.status === 'Mobilization' || j.status === 'Build');
  const today = isoDay(now);
  const soon = isoDay(now + (settings.coiDays || 30) * DAY);
  const coiNeeded = v.coiNeeded ?? sub;
  const coiState = !coiNeeded ? 'not-needed'
    : !v.coi?.expires ? 'missing'
    : v.coi.expires < today ? 'expired'
    : v.coi.expires <= soon ? 'expiring' : 'current';
  const reportableYtd = money?.reportable?.[year] || 0;
  const w9 = !!v.w9;
  const needsW9 = sub && !w9 && (paidReportable || onJob || reportableYtd >= settings.threshold * 100);
  const needsCoi = coiNeeded && onJob && coiState !== 'current';
  return {
    kind, autoKind, onJob, onSite, coiState, coiNeeded,
    needs: {
      w9: needsW9,
      coi: needsCoi,
      coiOnSite: needsCoi && onSite && (coiState === 'missing' || coiState === 'expired'),
      email: (needsW9 || needsCoi) && !v.email,
    },
    over1099: reportableYtd >= settings.threshold * 100,
  };
}

// ─── Upload links (the vendor's own page) ───────────────────────────

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const hashToken = async (t) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(t))));
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A new link for this vendor's documents (an earlier open one stops working) → { token, url, expiresAt } */
export async function createUploadLink(DB, vendorId, { by = null, now = Date.now() } = {}) {
  await ensureVendorSchema(DB);
  const token = newToken();
  const expiresAt = new Date(now + LINK_DAYS * DAY).toISOString();
  await DB.batch([
    DB.prepare("UPDATE vendor_links SET status = 'replaced' WHERE vendor_id = ? AND status = 'open'").bind(vendorId),
    DB.prepare('INSERT INTO vendor_links (token_hash, vendor_id, created_at, expires_at, by) VALUES (?, ?, ?, ?, ?)')
      .bind(await hashToken(token), vendorId, new Date(now).toISOString(), expiresAt, by),
  ]);
  return { token, url: `${UPLOAD_PAGE}#t=${token}`, expiresAt };
}

/** The link behind a token → { link, vendor, problem: null | 'unknown' | 'expired' | 'closed' } */
export async function findUploadLink(DB, token, now = Date.now()) {
  await ensureVendorSchema(DB);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return { link: null, vendor: null, problem: 'unknown' };
  const link = await DB.prepare('SELECT * FROM vendor_links WHERE token_hash = ?').bind(await hashToken(token)).first();
  if (!link) return { link: null, vendor: null, problem: 'unknown' };
  if (link.status !== 'open') return { link, vendor: null, problem: 'closed' };
  if (Date.parse(link.expires_at) < now) return { link, vendor: null, problem: 'expired' };
  const vendor = await readVendor(DB, link.vendor_id);
  return vendor ? { link, vendor, problem: null } : { link, vendor: null, problem: 'closed' };
}

// ─── Files ──────────────────────────────────────────────────────────

export const vendorFiles = (env) => env?.VENDOR_FILES || env?.FILES || null;
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp' };

/** PDF, JPG, PNG, HEIC or WebP, by the file's own first bytes → its type, or null */
export function documentType(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  const s = (i, str) => [...str].every((c, j) => b[i + j] === c.charCodeAt(0));
  if (s(0, '%PDF-')) return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && s(1, 'PNG')) return 'image/png';
  if (s(0, 'RIFF') && s(8, 'WEBP')) return 'image/webp';
  if (s(4, 'ftyp') && /^(heic|heix|hevc|mif1|msf1|heif)$/.test(String.fromCharCode(...b.slice(8, 12)))) return 'image/heic';
  return null;
}

/**
 * Keep a vendor's COI or W-9 file. file: a File/Blob. → { key, name, type } or
 * throws an Error with .status 400/413/503 and words for the person
 */
export async function storeDocument(env, vendorId, doc, file, { now = Date.now() } = {}) {
  const bucket = vendorFiles(env);
  if (!bucket) throw Object.assign(new Error('Files can’t be received right now. Please email them to SOARD instead.'), { status: 503 });
  if (!file || typeof file !== 'object' || !file.size) throw Object.assign(new Error('Choose the file first.'), { status: 400 });
  if (file.size > LIMITS.fileBytes) throw Object.assign(new Error('That file is over 15 MB. Try a smaller copy or a PDF.'), { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = documentType(bytes.slice(0, 16));
  if (!type) throw Object.assign(new Error('The file should be a PDF or a photo (JPG, PNG or HEIC).'), { status: 400 });
  const key = `vendors/${vendorId}/${doc}-${now}.${EXT[type]}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  return { key, name: `${doc === 'coi' ? 'Certificate of insurance' : 'W-9'}.${EXT[type]}`, type, bytes };
}

/**
 * What a vendor sent through their link (or staff uploaded): a COI with its
 * end date and insurer, and/or a W-9. A W-9 also goes onto their Mercury
 * recipient when there is one. → the vendor
 */
export async function saveDocuments(env, vendor, { coiFile = null, coiExpires = null, coiInsurer = null, w9File = null, by = 'vendor' }, { now = Date.now() } = {}) {
  const patch = {};
  if (coiFile || coiExpires) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(coiExpires || ''))) throw Object.assign(new Error('Add the date the policy ends.'), { status: 400 });
    if (coiExpires < isoDay(now)) throw Object.assign(new Error('That policy has already ended. Send the current certificate.'), { status: 400 });
    if (coiFile) {
      const f = await storeDocument(env, vendor.id, 'coi', coiFile, { now });
      Object.assign(patch, { coiKey: f.key, coiName: f.name });
    } else if (!vendor.coi?.key) {
      throw Object.assign(new Error('Add the certificate itself.'), { status: 400 });
    }
    Object.assign(patch, { coiExpires, coiInsurer: String(coiInsurer || '').trim().slice(0, LIMITS.insurer) || null, coiAt: new Date(now).toISOString(), coiBy: by });
  }
  let w9Mercury = null;
  if (w9File) {
    const f = await storeDocument(env, vendor.id, 'w9', w9File, { now });
    Object.assign(patch, { w9Source: 'upload', w9At: new Date(now).toISOString(), w9Key: f.key, w9Name: f.name });
    if (vendor.mercuryId && mercuryConfigured(env)) {
      w9Mercury = await uploadRecipientAttachment(env, vendor.mercuryId, { bytes: f.bytes, fileName: f.name, type: f.type })
        .then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
    }
  }
  if (!Object.keys(patch).length) throw Object.assign(new Error('Add the certificate or the W-9.'), { status: 400 });
  if (w9Mercury) patch.facts = { ...vendor.facts, w9Mercury: { ...w9Mercury, at: new Date(now).toISOString() } };
  return patchVendor(env.DB, vendor.id, patch, now);
}

// ─── What goes to a vendor ──────────────────────────────────────────

/** The COI request email → { subject, html, text } */
export function coiEmail({ vendorName, url, expires = null, reason = 'missing', jobs = [] }) {
  const renewing = reason === 'expiring' || reason === 'expired';
  const subject = renewing ? 'Your updated certificate of insurance for Sunshine on a Ranney Day' : 'Your certificate of insurance for Sunshine on a Ranney Day';
  const jobLine = jobs.length ? ` for your work on ${jobs.length === 1 ? 'a makeover' : `${jobs.length} makeovers`} with us` : '';
  const lead = renewing
    ? `Thank you for working with us. The certificate of insurance we have for ${vendorName} ${reason === 'expired' ? 'ended' : 'ends'} on ${fmtDate(expires)}, so we need the renewed one${jobLine}.`
    : `Thank you for working with us. Before work starts we keep a current certificate of insurance on file for every company on site${jobLine}, and we don't have one for ${vendorName} yet.`;
  const how = 'It takes a minute: upload the certificate (a PDF or a photo) and type the date the policy ends. You can send your W-9 on the same page if we asked for one.';
  const html = emailShell({
    preheader: 'Upload your certificate of insurance in a minute',
    heading: renewing ? 'Your renewed certificate of insurance' : 'Your certificate of insurance',
    intro: '',
    bodyHtml: `${paragraphs(lead)}${paragraphs(how)}${button('Upload the certificate', url)}${paragraphs('The link is for your company only and works for 30 days. Please name Sunshine on a Ranney Day as certificate holder.', 'font-size:14px;')}`,
  });
  const text = `${lead}\n\n${how}\n\nUpload it here: ${url}\n\nThe link is for your company only and works for 30 days. Please name Sunshine on a Ranney Day as certificate holder.`;
  return { subject, html, text };
}

/** The note Mercury shows the vendor on its W-9 page */
export const W9_NOTE = 'Sunshine on a Ranney Day pays its trade partners through Mercury. Please add your payment details and upload a completed W-9 so we can pay you and send your 1099 in January.';

function fmtDate(d) {
  if (!d) return 'soon';
  const [y, m, day] = String(d).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** Ask one vendor for a W-9 through Mercury now → the vendor */
export async function askW9(env, vendor, { by = 'auto', now = Date.now(), email = null, preview = false } = {}) {
  if (!mercuryConfigured(env)) throw Object.assign(new Error('Mercury isn’t connected yet (MERCURY_API_TOKEN), so W-9s can’t be asked for.'), { status: 503 });
  const to = email || vendor.email;
  if (!isEmail(to)) throw Object.assign(new Error(`There’s no email for ${vendor.name}. Add one first.`), { status: 400 });
  const made = await createRecipientInvite(env, {
    contactEmail: to,
    ...(preview ? { name: `${vendor.name} (preview)` } : vendor.mercuryId ? { recipientId: vendor.mercuryId } : { name: vendor.name }),
    notes: W9_NOTE,
  });
  if (preview) return { invite: made };
  return patchVendor(env.DB, vendor.id, {
    inviteId: made?.id || null, inviteStatus: made?.status || 'created', inviteAt: new Date(now).toISOString(), invites: (vendor.invite?.count || 0) + 1,
    facts: { ...vendor.facts, lastW9Ask: { at: new Date(now).toISOString(), by, onboardingUrl: made?.onboardingUrl || null } },
  }, now);
}

/** Email one vendor their COI link now → { vendor, url } */
export async function askCoi(env, vendor, status, { by = 'auto', now = Date.now(), to = null, preview = false, replyTo = '' } = {}) {
  const address = to || vendor.email;
  if (!isEmail(address)) throw Object.assign(new Error(`There’s no email for ${vendor.name}. Add one first.`), { status: 400 });
  const link = preview ? { url: `${UPLOAD_PAGE}#t=preview-only-this-link-does-not-open` } : await createUploadLink(env.DB, vendor.id, { by, now });
  const mail = coiEmail({ vendorName: vendor.name, url: link.url, expires: vendor.coi?.expires, reason: status.coiState, jobs: vendor.facts.jobs || [] });
  const r = await sendEmails(env, { to: [address], subject: preview ? `Preview: ${mail.subject}` : mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'type', value: 'vendor-coi' }], replyTo: replyTo || null });
  if (!r.sent) throw Object.assign(new Error(r.errors[0] || 'The email didn’t send'), { status: 500 });
  if (preview) return { vendor, url: link.url };
  const next = await patchVendor(env.DB, vendor.id, { coiLinkAt: new Date(now).toISOString(), coiAsks: (vendor.coiAsk?.count || 0) + 1 }, now);
  return { vendor: next, url: link.url };
}

// ─── Slack (Finance channel only) ───────────────────────────────────

const vendorUrl = (v) => `${ADMIN_URL}/${encodeURIComponent(v.id)}`;

function w9Card(v, s, settings) {
  const jobs = (v.facts.jobs || []).map((j) => j.jobName);
  return slackCard({
    icon: '🧾', title: `${v.name} needs a W-9`,
    lead: !v.email ? 'There’s no email for them in Mercury or JobTread, so nobody can ask yet. Add one in Vendors.'
      : settings.autoW9 ? (v.invite?.at ? `Mercury emailed them a page for their bank details and W-9 on ${fmtDate(isoDay(Date.parse(v.invite.at)))}. The site asks again every ${ASK_AGAIN_DAYS} days, ${MAX_ASKS} times at most.` : 'The site asks them through Mercury within 15 minutes.')
      : 'Automatic W-9 requests are off (Vendors → Settings). Ask them from their page in Vendors.',
    facts: [['Why', jobs.length ? `On ${jobs.join(', ')}` : 'Paid by ACH or check'], ...(v.email ? [['Email', v.email]] : [])],
    buttons: [{ label: 'Open the vendor', url: vendorUrl(v) }],
  });
}

function coiCard(v, s) {
  const jobs = (v.facts.jobs || []).filter((j) => j.status === 'Mobilization' || j.status === 'Build').map((j) => j.jobName);
  return slackCard({
    icon: '🦺', title: `${v.name} is on site without a current certificate of insurance`,
    lead: s.coiState === 'expired' ? `Their certificate ended ${fmtDate(v.coi?.expires)}.` : 'There’s no certificate of insurance on file.',
    facts: [['Jobs', jobs.join(', ') || 'An open job'], ['Asked', v.coiAsk?.count ? `${v.coiAsk.count} time${v.coiAsk.count === 1 ? '' : 's'}, last ${fmtDate(isoDay(Date.parse(v.coiAsk.at)))}` : 'Not yet']],
    buttons: [{ label: 'Open the vendor', url: vendorUrl(v) }],
  });
}

// ─── 1099s ──────────────────────────────────────────────────────────

/** Everyone SOARD's 1099-NECs cover for `year` → [{ vendor, total, months, w9, address }] */
export function filings1099(vendors, moneyByYear, year, settings = DEFAULTS) {
  return vendors
    .map((v) => ({ v, m: moneyByYear.get(v.id) }))
    .filter(({ v, m }) => !v.corp && (m?.reportable?.[year] || 0) >= settings.threshold * 100)
    .map(({ v, m }) => ({
      id: v.id, name: v.name, total: m.reportable[year],
      months: Object.fromEntries(Object.entries(m.months).filter(([k]) => k.startsWith(`${year}-`))),
      w9: !!v.w9, address: v.facts.mercury?.address || null, email: v.email,
    }))
    .sort((a, b) => b.total - a.total);
}

const csvCell = (s) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

/** The CPA's 1099 list as CSV */
export function csv1099(rows, year) {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const head = ['Vendor', 'Total paid (ACH, check, wire)', 'W-9 on file', 'Address', 'Email', ...months.map((m) => new Date(`${m}-15`).toLocaleDateString('en-US', { month: 'short' }))];
  const lines = rows.map((r) => [r.name, (r.total / 100).toFixed(2), r.w9 ? 'Yes' : 'No', r.address || '', r.email || '', ...months.map((m) => ((r.months[m] || 0) / 100).toFixed(2))].map(csvCell).join(','));
  return [head.map(csvCell).join(','), ...lines].join('\n');
}

// ─── Everything the admin shows ─────────────────────────────────────

export async function vendorsView(env, { now = Date.now() } = {}) {
  const [vendors, settings, st] = await Promise.all([readVendors(env.DB), readSettings(env.DB), readState(env.DB, STATE_KEY)]);
  const year = yearOf(now);
  const txns = await readTxns(env.DB, { from: `${year - 1}-01-01`, kinds: [...REPORTABLE_KINDS, ...CARD_KINDS] });
  const money = vendorMoney(vendors, txns, { now });
  const list = vendors.map((v) => {
    const m = money.get(v.id);
    const s = vendorStatus(v, m, settings, { now });
    return {
      // coiNeeded is what applies now; coiNeededSet what staff chose (null: subs only)
      ...v, coiNeededSet: v.coiNeeded, ...s,
      paid: { reportable: m.reportable, card: m.card, lastPaid: m.lastPaid, months: m.months },
      facts: { ...v.facts },
    };
  });
  // Two rows that might be one vendor, for staff to link
  const suggestions = [];
  for (let i = 0; i < list.length && suggestions.length < 20; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if ((a.mercuryId && b.mercuryId) || (a.jtId && b.jtId)) continue;
      const l = vendorLikeness(a.name, b.name);
      if (l >= 0.66 && l < 1 && !(st.notSame || []).includes(`${a.id}|${b.id}`)) suggestions.push({ a: a.id, b: b.id, aName: a.name, bName: b.name });
    }
  }
  return {
    vendors: list, suggestions, settings, year,
    filings: { [year]: filings1099(vendors, money, year, settings), [year - 1]: filings1099(vendors, money, year - 1, settings) },
    health: {
      mercury: mercuryConfigured(env), jobtread: !!env.JOBTREAD_GRANT_KEY, email: !!env.RESEND_API_KEY, files: !!vendorFiles(env),
      recipientsAt: st.recipientsAt || null, jobtreadAt: st.jobtreadAt || null, lastRun: st.lastRun || null, lastError: st.lastError || null,
    },
  };
}

// ─── Staff choices ──────────────────────────────────────────────────

/** Make `bId` part of `aId` (staff saw they're one vendor) → the kept vendor */
export async function linkVendors(DB, aId, bId, { now = Date.now() } = {}) {
  const [a, b] = await Promise.all([readVendor(DB, aId), readVendor(DB, bId)]);
  if (!a || !b || a.id === b.id) throw Object.assign(new Error('Pick two different vendors'), { status: 400 });
  if (a.mercuryId && b.mercuryId) throw Object.assign(new Error('Both are Mercury recipients. Merge them in Mercury first.'), { status: 400 });
  if (a.jtId && b.jtId) throw Object.assign(new Error('Both are JobTread vendors. Merge them in JobTread first.'), { status: 400 });
  const patch = {
    mercuryId: a.mercuryId || b.mercuryId, jtId: a.jtId || b.jtId, email: a.email || b.email, locked: true,
    facts: { ...b.facts, ...a.facts, names: [...new Set([...(a.facts.names || [a.name]), ...(b.facts.names || [b.name])])], jobs: a.facts.jobs?.length ? a.facts.jobs : b.facts.jobs || [] },
  };
  if (!a.w9 && b.w9) Object.assign(patch, { w9Source: b.w9.source, w9At: b.w9.at, w9Key: b.w9.key, w9Name: b.w9.name });
  if ((!a.coi || (b.coi?.expires || '') > (a.coi?.expires || '')) && b.coi) Object.assign(patch, { coiKey: b.coi.key, coiName: b.coi.name, coiExpires: b.coi.expires, coiInsurer: b.coi.insurer, coiAt: b.coi.at, coiBy: b.coi.by });
  await DB.prepare('DELETE FROM vendors WHERE id = ?').bind(b.id).run();
  await DB.prepare('UPDATE vendor_links SET vendor_id = ? WHERE vendor_id = ?').bind(a.id, b.id).run();
  return patchVendor(DB, a.id, patch, now);
}

/** Pull the Mercury or JobTread side off a vendor into its own row (both stay apart) → the new vendor */
export async function unlinkVendor(DB, id, part, { now = Date.now() } = {}) {
  const v = await readVendor(DB, id);
  if (!v) throw Object.assign(new Error('That vendor isn’t here'), { status: 404 });
  const field = part === 'mercury' ? 'mercuryId' : part === 'jobtread' ? 'jtId' : null;
  if (!field || !v[field] || !(v.mercuryId && v.jtId)) throw Object.assign(new Error('There’s nothing to pull apart'), { status: 400 });
  const side = part === 'mercury' ? v.facts.mercury : null;
  const name = part === 'mercury' ? (v.facts.mercury?.nickname || v.name) : v.name;
  await patchVendor(DB, id, { [field]: null, locked: true }, now);
  return insertVendor(DB, { name, [field]: v[field], email: v.email, locked: true, facts: part === 'mercury' ? { mercury: side, names: [name] } : { jobs: v.facts.jobs || [], names: [name] } }, now);
}

// ─── The heartbeat ──────────────────────────────────────────────────

/**
 * Read Mercury (hourly) and JobTread (every 4 hours), join, then ask the
 * vendors who need something (when switched on) and post what needs a
 * person. Never throws. → a short report or null
 */
export async function maybeRunVendors(env, { now = Date.now(), fetchImpl = fetch, force = false } = {}) {
  try {
    if (!env.DB) return null;
    await ensureVendorSchema(env.DB);
    const st = await readState(env.DB, STATE_KEY);
    if (!force && now - Date.parse(st.lastRunAt || 0) < RUN_EVERY_MS) return null;
    await writeState(env.DB, STATE_KEY, { lastRunAt: new Date(now).toISOString() });
    const report = { at: new Date(now).toISOString() };
    const input = {};
    const errors = [];

    if (mercuryConfigured(env) && (force || now - Date.parse(st.recipientsAt || 0) > RECIPIENTS_EVERY_MS)) {
      try {
        const [recipients, taxForms, invites] = await Promise.all([
          listRecipients(env, { fetchImpl }), listRecipientAttachments(env, { fetchImpl }).catch(() => []), listRecipientInvites(env, { fetchImpl }).catch(() => []),
        ]);
        Object.assign(input, { recipients, taxForms });
        input.invites = invites;
        await writeState(env.DB, STATE_KEY, { recipientsAt: new Date(now).toISOString() });
        report.recipients = recipients.length;
      } catch (e) { errors.push(`Mercury: ${e.message}`); }
    }
    if (env.JOBTREAD_GRANT_KEY && (force || now - Date.parse(st.jobtreadAt || 0) > JOBTREAD_EVERY_MS)) {
      try {
        const { cachedJobs } = await import('./_spend.js');
        const jobs = await cachedJobs(env, { now });
        input.jtVendors = await jobtreadVendors(env, { fetchImpl });
        input.jobsByVendor = await vendorsOnJobs(env, jobs, { fetchImpl });
        await writeState(env.DB, STATE_KEY, { jobtreadAt: new Date(now).toISOString() });
        report.jobtreadVendors = input.jtVendors.length;
      } catch (e) { errors.push(`JobTread: ${e.message}`); }
    }
    // Names on makeover charges and bills (suppliers) join once a day
    if (force || now - Date.parse(st.namesAt || 0) > DAY) {
      input.spendNames = await spendNames(env.DB).catch(() => []);
      await writeState(env.DB, STATE_KEY, { namesAt: new Date(now).toISOString() });
    }
    if (input.recipients || input.jtVendors || input.spendNames?.length) report.joined = await joinVendors(env.DB, input, { now });
    if (input.invites) await trackInvites(env.DB, input.invites, { now });

    report.asked = await askAndAlert(env, { now }).catch((e) => { errors.push(e.message); return null; });
    report.season = await season1099(env, { now }).catch(() => null);
    await writeState(env.DB, STATE_KEY, { lastRun: report, lastError: errors.length ? { at: report.at, error: errors.join(' · ') } : null });
    return report;
  } catch (e) {
    console.error('[vendors]', e.message);
    return null;
  }
}

async function spendNames(DB) {
  const names = new Set();
  const charges = await DB.prepare("SELECT DISTINCT vendor FROM spend_charges WHERE bucket = 'job' AND vendor IS NOT NULL LIMIT 2000").all().catch(() => ({ results: [] }));
  for (const r of charges.results || []) names.add(r.vendor);
  const bills = await DB.prepare('SELECT DISTINCT vendor FROM spend_bills WHERE vendor IS NOT NULL LIMIT 2000').all().catch(() => ({ results: [] }));
  for (const r of bills.results || []) names.add(r.vendor);
  return [...names];
}

/** Mercury's word on the invites we sent: completed, expired, declined */
export async function trackInvites(DB, invites, { now = Date.now() } = {}) {
  const byId = new Map(invites.map((i) => [i.id, i]));
  for (const v of await readVendors(DB)) {
    const inv = v.invite?.id ? byId.get(v.invite.id) : null;
    if (!inv) continue;
    const patch = {};
    if (inv.status !== v.invite.status) patch.inviteStatus = inv.status;
    if (inv.recipientId && !v.mercuryId) patch.mercuryId = inv.recipientId;
    if (Object.keys(patch).length) await patchVendor(DB, v.id, patch, now);
  }
}

/** Ask who needs asking (when switched on), and post who needs a person → { w9, coi, posted } */
export async function askAndAlert(env, { now = Date.now() } = {}) {
  const view = await vendorsView(env, { now });
  const { settings } = view;
  const st = await readState(env.DB, STATE_KEY);
  const posted = { ...(st.posted || {}) };
  const out = { w9: 0, coi: 0, posted: 0, resolved: 0 };
  const due = (at, count) => count < MAX_ASKS && (!at || now - Date.parse(at) >= ASK_AGAIN_DAYS * DAY);

  for (const v of view.vendors) {
    // W-9: through Mercury, again after a week while Mercury's invite isn't done, three times at most
    if (v.needs.w9 && settings.autoW9 && v.email && mercuryConfigured(env) && v.invite?.status !== 'completed' && v.invite?.status !== 'declined' && due(v.invite?.at, v.invite?.count || 0)) {
      try { await askW9(env, v, { now }); out.w9++; } catch (e) { console.error('[vendors] w9', v.id, e.message); }
    }
    // COI: our page, emailed, again after a week, three times at most
    if (v.needs.coi && settings.autoCoi && v.email && env.RESEND_API_KEY && due(v.coiAsk?.at, v.coiAsk?.count || 0)) {
      try { await askCoi(env, v, v, { now, replyTo: settings.replyTo }); out.coi++; } catch (e) { console.error('[vendors] coi', v.id, e.message); }
    }

    const w9Key = `vendor:w9:${v.id}`;
    if (v.needs.w9 && !posted[w9Key]) {
      const r = await slackIssue(env, w9Key, w9Card(v, v, settings), { title: `${v.name}: W-9`, kind: 'attention', area: 'finance' }).catch(() => null);
      if (r?.ok) { posted[w9Key] = new Date(now).toISOString(); out.posted++; }
    } else if (!v.needs.w9 && posted[w9Key]) {
      await slackResolved(env, w9Key, slackCard({ icon: '✅', title: `${v.name}’s W-9 is on file` }), { summary: v.w9 ? 'Their tax form is on file.' : 'They don’t need one any more.' }).catch(() => null);
      delete posted[w9Key];
      out.resolved++;
    }
    const coiKey = `vendor:coi:${v.id}`;
    if (v.needs.coiOnSite && !posted[coiKey]) {
      const r = await slackIssue(env, coiKey, coiCard(v, v), { title: `${v.name}: insurance`, kind: 'attention', area: 'finance' }).catch(() => null);
      if (r?.ok) { posted[coiKey] = new Date(now).toISOString(); out.posted++; }
    } else if (!v.needs.coiOnSite && posted[coiKey]) {
      await slackResolved(env, coiKey, slackCard({ icon: '✅', title: `${v.name}’s insurance is sorted` }), { summary: v.coi?.expires ? `Certificate on file through ${fmtDate(v.coi.expires)}.` : 'Not on site any more.' }).catch(() => null);
      delete posted[coiKey];
      out.resolved++;
    }
  }
  await writeState(env.DB, STATE_KEY, { posted });
  return out;
}

/** Early January, once: last year's 1099s in the Finance channel */
export async function season1099(env, { now = Date.now() } = {}) {
  const day = isoDay(now);
  const [y, m, d] = day.split('-').map(Number);
  if (m !== 1 || d < 5) return null;
  const st = await readState(env.DB, STATE_KEY);
  if (st.season === y - 1) return null;
  const view = await vendorsView(env, { now });
  const rows = view.filings[y - 1] || [];
  const missing = rows.filter((r) => !r.w9);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const r = await slackPost(env, slackCard({
    icon: '🗂️', title: `1099s for ${y - 1}: ${rows.length} vendor${rows.length === 1 ? '' : 's'}`,
    lead: `Paid $${view.settings.threshold} or more by ACH, check or wire in ${y - 1}. 1099-NECs are due to them and the IRS by January 31. Card payments aren’t on this list: the card network reports those.`,
    facts: [['Total', `$${Math.round(total / 100).toLocaleString('en-US')}`], ['Missing a W-9', missing.length ? missing.map((x) => x.name).join(', ') : 'None']],
    buttons: [{ label: 'Open the 1099 list', url: `${ADMIN_URL}/1099` }],
  }), { kind: 'attention', area: 'finance' }).catch(() => null);
  if (r?.ok) await writeState(env.DB, STATE_KEY, { season: y - 1 });
  return { posted: !!r?.ok, vendors: rows.length };
}
