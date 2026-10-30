/**
 * The certificates and W-9s SOARD already had, found and filed in JobTread
 * ===========================================================================
 * For years before the trade-partner page, insurance certificates and W-9s
 * came in by email (agents and contractors writing to Joe, Holly, Christian,
 * Nicole, Peter), were dropped on JobTread vendor accounts without a tag, or
 * rode along on Ramp bills. This finds them in the background and files each
 * one where the trade-partner work reads it. Nobody clicks anything:
 *
 *   1. Finding. Every active staff mailbox (the read-only access in
 *      ./_mailbox.js) is searched for email with a file and insurance or W-9
 *      words, the last 4 years first and new mail after; JobTread vendor
 *      accounts' untagged files and Ramp bills' supporting files are listed.
 *      Each candidate file is queued once (coi_found).
 *   2. Reading. A file's bytes are hashed before anything else, so a
 *      certificate forwarded to three inboxes is read once. A PDF's own text
 *      says what it is without any model (most attachments are logos,
 *      waivers and invoices and stop there); a certificate, a W-9, or a scan
 *      or photo the email calls one, is read by ./_vendor-read.js, which
 *      finds the agency in the PRODUCER box too.
 *   3. Matching. The insured's name against JobTread's vendors: the same name
 *      ("Inc.", "LLC", "&" and "and" aside) counts, the one on the most jobs
 *      when JobTread has it twice; otherwise Workers AI picks among close
 *      names, and only a sure pick counts. SOARD's own certificates and W-9
 *      (it's the insured on its events' and policies' paperwork) are left out.
 *   4. Filing, for a match only. The file goes in the vendor's "W-9 &
 *      Insurance" folder tagged COI or W-9, once: a copy JobTread already has
 *      is tagged where it is. Liability Expires and Workers' Comp Expires only
 *      move forward, and only for coverage that meets the minimums; a W-9
 *      that checks out by the upload rules ticks W-9; an internal note says
 *      where it was found. The agency's email becomes the vendor's "Insurance
 *      agent" contact and their trade-partner agent, so renewals are asked of
 *      the agent; a sender on the vendor's own domain becomes their main
 *      contact when they have no one.
 *   5. The coverage index (coi_coverage). Every policy on every certificate,
 *      matched or not, with its dates and limits, so the insurance audit
 *      (./_insurance-audit.js) can tell what covered each payment. Files
 *      checked on the trade-partner page are added too (recordUpload).
 *
 * Tax IDs are never kept: a W-9's reading has only names and yes/no answers.
 * The site keeps no copy of the files (JobTread has them); D1 keeps the queue,
 * each file's hash and what it said.
 */

import { PDFDocument } from 'pdf-lib';
import { accessToken, GMAIL_READ_SCOPE } from './_google-calendar.js';
import { mailboxes, gmail, header, textOf, filesOf, partsOf, bytesOf } from './_mailbox.js';
import { isStaffEmail } from './_board-roles.js';
import { readState, writeState } from './_mercury.js';
import { FREE_MAIL } from './_kid-partners.js';
import { ramp, rampConfigured } from './_ramp.js';
import { SOARD_ORG_ID, TZ } from './_reveals.js';
import { SITE_ORIGIN } from './_broadcast-notify.js';
import { readDocument, readW9Text, pdfText, documentType, judgeW9, mergeCoi, longDate, askModel, scannedPages, money, TEXT_MODEL } from './_vendor-read.js';
import { jt, jtSetup, readJtVendor, writeFields, vendorNote, uploadToJt, readDocSettings, docsState, labelFor, readAsk, FOLDER, TAGS, CONTACT_VALUES, contactEmail, contactFields } from './_vendors.js';

export const STATE_KEY = 'coi-backfill';
const REREAD = 2;            // raised when files already read need reading again (2: matching a W-9 to the JobTread account it's on)
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const BUSY_MS = MIN;                 // while there's anything to find or read
const IDLE_MS = 6 * 60 * MIN;        // then new mail, files and bills every few hours
export const LOOK_BACK_DAYS = 4 * 365;
const OVERLAP_MS = DAY;              // a new look starts a day before the last one did
const FIND_MS = 6 * 1000;            // the heartbeat's other jobs share its ~30 seconds
const WORK_MS = 12 * 1000;           // no new file is started after this (one can take a browser and Workers AI ~15 seconds)
export const READS_PER_RUN = 3;      // files Workers AI reads, each run
const ROWS_PER_RUN = 25;
const MAX_TRIES = 3;
const RETRY_MS = 15 * MIN;
const STUCK_MS = 10 * MIN;           // a row a heartbeat dropped halfway
const LOCK_MS = 50 * 1000;
const PAGE = 100;
export const MAX_BYTES = 10 * 1024 * 1024;
const MIN_PDF_BYTES = 8 * 1024;      // a real certificate is more than this
const MIN_IMAGE_BYTES = 60 * 1024;   // a readable photo of a page is more than this
const LOGO_BYTES = 250 * 1024;       // a pasted picture smaller than this, or one named like a signature, is a logo
const MIN_TEXT = 80;                 // a PDF with less text than this is a scan

// Gmail's search words: email with a file and insurance or W-9 words (the text gate below decides)
export const MAIL_WORDS = 'has:attachment ("certificate of liability insurance" OR "certificate of insurance" OR ACORD OR COI OR COIs OR "proof of insurance" OR "evidence of insurance" OR "workers compensation" OR "workers comp" OR affidavit OR filename:coi OR filename:acord OR filename:insurance OR filename:certificate OR "form w-9" OR "w-9 form" OR "request for taxpayer" OR filename:w9 OR filename:w-9 OR subject:w9 OR subject:w-9)';

const COI_WORDS = /\b(coi'?s?|acord|sbwc|certificates? of (liability )?insurance|insurance certificates?|proof of insurance|evidence of insurance|workers'?\s*comp(ensation)?|general liability|additional insured|certificate holder|liability insurance)\b/i;
const EXEMPT_WORDS = /\b(affidavit|exempt(ion)?)\b/i;
const W9_WORDS = /\bw-?\s?9s?\b|request for taxpayer/i;
const COI_TEXT = /certificate of (liability )?insurance|acord\s*25|evidence of (commercial |property )?(liability )?insurance|certificate of workers'? compensation/i;
const EXEMPT_TEXT = /workers'?\s*compensation[\s\S]{0,400}\b(affidavit|exempt)|\b(affidavit|exempt)[\s\S]{0,400}workers'?\s*compensation/i;
// The W-9's own title: a 1099 or an instruction sheet says "Form W-9" too
const W9_TEXT = /request\s+for\s+taxpayer\s+identification\s+number\s+and\s+certification/i;
const LOGO_NAME = /^(image\d*|outlook-|signature|logo|icon|banner|facebook|linkedin|instagram|twitter|x-logo)/i;
// SOARD's own paperwork: it's the insured on its events' certificates, its policies and its own W-9
const OWN_NAME = /sunshine on a ?ranney|\bsoard\b|sunny (and|&) ranney|partly sunny/i;
const OWN_POLICIES = ['WCV0329463'];
const AGENT_TITLE = /agent|insurance/i;
const KINDS = { 'general liability': 'gl', 'workers compensation': 'wc', auto: 'auto', umbrella: 'umbrella', other: 'other' };
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const isoDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const monthYear = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: TZ });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const parseJson = (s, d = {}) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const clean = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';
const addressOf = (from) => (String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '')).trim().toLowerCase();
const displayName = (from) => clean(String(from || '').replace(/<[^>]*>/, '').replace(/"/g, ''), 80);

// ─── Tables ─────────────────────────────────────────────────────────

const SCHEMA = [
  // Every policy on every certificate found or checked, matched to a vendor or not (./_insurance-audit.js reads it)
  `CREATE TABLE IF NOT EXISTS coi_coverage (id TEXT PRIMARY KEY, jt_id TEXT, insured TEXT NOT NULL, kind TEXT NOT NULL, effective TEXT, expires TEXT,
    insurer TEXT, policy_no TEXT, each_cents INTEGER, aggregate_cents INTEGER, exempt INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, source_ref TEXT,
    file_hash TEXT NOT NULL, jt_file_id TEXT, found_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS coi_coverage_jt ON coi_coverage (jt_id)',
  'CREATE INDEX IF NOT EXISTS coi_coverage_hash ON coi_coverage (file_hash)',
  // The work: an email to open (item 'message') or a file to read (item 'file'), and what came of it
  `CREATE TABLE IF NOT EXISTS coi_found (id TEXT PRIMARY KEY, source TEXT NOT NULL, item TEXT NOT NULL, name TEXT, size INTEGER, sent_at TEXT, hint TEXT,
    state TEXT NOT NULL, kind TEXT, file_hash TEXT, jt_id TEXT, insured TEXT, detail TEXT, tries INTEGER NOT NULL DEFAULT 0, found_at TEXT NOT NULL, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS coi_found_state ON coi_found (state, item, sent_at)',
  'CREATE INDEX IF NOT EXISTS coi_found_hash ON coi_found (file_hash)',
  // The trade-partner work row (./_trade-partners.js makes it the same way): only its agent is written here
  `CREATE TABLE IF NOT EXISTS vendor_profiles (
    jt_id TEXT PRIMARY KEY, invited_at TEXT, invited_by TEXT, started_at TEXT, done_at TEXT, steps TEXT,
    address TEXT, agent TEXT, lang TEXT, reminders INTEGER NOT NULL DEFAULT 0, reminded_at TEXT, updated_at TEXT)`,
];
const _ready = new WeakSet();
export async function ensureCoverageSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}

// Outcomes that came from the file's own content: a later copy of the same bytes ends the same way
const SETTLED = ['filed', 'unmatched', 'own', 'skipped'];

// ─── The coverage index ─────────────────────────────────────────────

const centsOf = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n) * 100) : null);

/**
 * Each policy on one certificate, into coi_coverage (again for the same file: replaced, never doubled).
 * policies: the reader's ({ kind: 'general liability' …, effective, expires, insurer, policyNumber, eachOccurrence,
 * aggregate, employersLiabilityEachAccident }) or short kinds (gl · wc · auto · umbrella · other); exempt: a workers'
 * comp exemption instead of a policy → number of rows
 */
export async function recordCoverage(env, { jtId = null, insured = '', policies = [], exempt = false, source, sourceRef = null, fileHash, jtFileId = null, now = Date.now() }) {
  if (!fileHash || !source) throw new Error('A coverage row needs its file and where it came from');
  await ensureCoverageSchema(env.DB);
  const iso = new Date(now).toISOString();
  const rows = (policies || []).filter(Boolean).map((p) => {
    const kind = KINDS[p.kind] || (Object.values(KINDS).includes(p.kind) ? p.kind : 'other');
    return {
      kind, effective: isDate(p.effective) ? p.effective : null, expires: isDate(p.expires) ? p.expires : null,
      insurer: clean(p.insurer, 120) || null, policyNo: clean(p.policyNumber, 60) || null,
      each: centsOf(kind === 'wc' ? p.employersLiabilityEachAccident : p.eachOccurrence), aggregate: centsOf(p.aggregate),
    };
  });
  if (exempt) rows.push({ kind: 'exemption', effective: null, expires: null, insurer: null, policyNo: null, each: null, aggregate: null });
  const stmts = [env.DB.prepare('DELETE FROM coi_coverage WHERE file_hash = ?').bind(fileHash)];
  rows.forEach((r, i) => stmts.push(env.DB.prepare(`INSERT INTO coi_coverage (id, jt_id, insured, kind, effective, expires, insurer, policy_no, each_cents, aggregate_cents, exempt, source, source_ref, file_hash, jt_file_id, found_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(`${fileHash.slice(0, 24)}:${i}`, jtId, clean(insured, 160) || 'Unknown', r.kind, r.effective, r.expires,
    r.insurer, r.policyNo, r.each, r.aggregate, r.kind === 'exemption' ? 1 : 0, source, sourceRef, fileHash, jtFileId, iso)));
  await env.DB.batch(stmts);
  return rows.length;
}

/** A certificate that checked out on the trade-partner page (./_vendors.js fileUpload): its policies indexed, its files known */
export async function recordUpload(env, { jtId, insured, verdict, parts, now = Date.now() }) {
  await ensureCoverageSchema(env.DB);
  const hashes = await Promise.all((parts || []).map((p) => sha256(p.bytes)));
  if (!hashes.length) return 0;
  const iso = new Date(now).toISOString();
  await env.DB.batch(hashes.map((h, i) => env.DB.prepare(`INSERT OR IGNORE INTO coi_found (id, source, item, name, size, sent_at, state, kind, file_hash, jt_id, insured, found_at, updated_at)
      VALUES (?, 'upload', 'file', ?, ?, ?, 'filed', 'coi', ?, ?, ?, ?, ?)`).bind(`upload:${h.slice(0, 32)}`, clean(parts[i].name, 120) || null, parts[i].bytes.byteLength, iso, h, jtId, clean(insured, 160), iso, iso)));
  return recordCoverage(env, { jtId, insured, policies: [verdict.gl, verdict.wc], source: 'upload', sourceRef: `upload:${hashes[0].slice(0, 32)}`, fileHash: hashes[0], now });
}

// ─── What a file is (pure) ──────────────────────────────────────────

/** Words that say an email or a file is about insurance or a W-9 → { coi, w9 } */
export function hintsOf(words) {
  const s = String(words || '');
  return { coi: COI_WORDS.test(s) || (EXEMPT_WORDS.test(s) && /\bcomp/i.test(s)), w9: W9_WORDS.test(s) };
}

/** A PDF's text → 'coi' (a certificate, or a workers' comp exemption) | 'w9' | 'scan' (no text to tell) | null (something else) */
export function kindOfText(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (t.trim().length < MIN_TEXT) return 'scan';
  if (COI_TEXT.test(t) || EXEMPT_TEXT.test(t)) return 'coi';
  if (W9_TEXT.test(t)) return 'w9';
  return null;
}

/**
 * An email's file worth fetching: a PDF (its text decides), or a photo when the email or the file's name speaks of
 * insurance or a W-9. f: filesOf's { name, type, size, inline }
 */
export function worthReading(f, { hinted = false } = {}) {
  const type = String(f.type || '').toLowerCase();
  const name = String(f.name || '');
  const pdf = type === 'application/pdf' || (/\.pdf$/i.test(name) && (!type || type === 'application/octet-stream'));
  const photo = /^image\/(jpe?g|png|webp)$/.test(type);
  if ((!pdf && !photo) || !f.size || f.size > MAX_BYTES) return false;
  if (pdf) return f.size >= MIN_PDF_BYTES;
  if (f.size < MIN_IMAGE_BYTES || ((f.inline || LOGO_NAME.test(name)) && f.size < LOGO_BYTES)) return false;
  return hinted || hintsOf(name).coi || hintsOf(name).w9;
}

/** SOARD's own certificate or W-9 (names: the insured, a W-9's names) */
export function isOwn(names, policies = []) {
  if ((names || []).some((n) => OWN_NAME.test(String(n || '')))) return true;
  return (policies || []).some((p) => OWN_POLICIES.some((x) => String(p?.policyNumber || '').replace(/[^a-z0-9]/gi, '').toUpperCase().includes(x)));
}

/** A company name and its "DBA" names, apart */
export function namesOf(s) {
  return String(s || '').split(/,?\s+(?:d\s*\/\s*b\s*\/\s*a|dba|t\s*\/\s*a|aka|a\s*\/\s*k\s*\/\s*a)[.:]?\s+|\n/i).map((x) => clean(x, 120)).filter((x) => x.length > 1);
}

const LEGAL = new Set(['the', 'inc', 'incorporated', 'llc', 'l', 'c', 'co', 'corp', 'corporation', 'company', 'ltd', 'limited', 'pllc', 'lp', 'llp', 'and', 'of', 'a', 'dba']);
/** A company name as a key: "Pulley & Associates, Inc." and "Pulley and Associates" → "pulley associates" */
export function nameKey(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]s\b/g, 's').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter((w) => w && !LEGAL.has(w)).join(' ');
}

/** How alike two company names are, 0..1: 1 the same name; else the words they share over the longer name's words */
export function nameScore(a, b) {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb || ka.replace(/ /g, '') === kb.replace(/ /g, '')) return 1;
  const wa = new Set(ka.split(' '));
  const wb = new Set(kb.split(' '));
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size);
}

/**
 * JobTread vendors named like any of names, best first (on more jobs first when equal) → [{ jtId, name, jobs, score }].
 * A one-word name ("Atlanta", "Dovetail") has to be the same name: half of "Atlanta Plumbing" is no reason to ask
 */
export function candidatesFor(names, vendors) {
  const best = new Map();
  const words = (s) => nameKey(s).split(' ').filter(Boolean).length;
  for (const n of names) {
    for (const v of vendors) {
      const score = nameScore(n, v.name);
      if (score < 1 && (words(n) < 2 || words(v.name) < 2)) continue;
      if (score >= 0.5 && score > (best.get(v.jtId)?.score || 0)) best.set(v.jtId, { ...v, score });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || (b.jobs || 0) - (a.jobs || 0) || a.name.localeCompare(b.name));
}

/** An email address on the vendor's own domain: "office@servicewiseelectric.com" for ServiceWise Electric */
export function onVendorDomain(email, vendorName) {
  const d = domainOf(email);
  if (!d || FREE_MAIL.has(d) || d.endsWith('soardcharity.com')) return false;
  const label = d.split('.').slice(-2, -1)[0] || '';
  const key = nameKey(vendorName).replace(/ /g, '');
  if (label.length < 4 || key.length < 4) return false;
  return label === key || (label.length >= 5 && key.startsWith(label)) || (key.length >= 5 && label.startsWith(key));
}

/** A certificate's two readings (text and pictures) as one: where they differ on when a policy ends, the earlier end */
export function readingOf(reads) {
  const a = mergeCoi([reads?.text || reads?.pictures]);
  const b = mergeCoi([reads?.pictures || reads?.text]);
  if (!a) return null;
  const latest = (r, kind) => (r.policies || []).filter((p) => p.kind === kind && isDate(p.expires)).sort((x, y) => y.expires.localeCompare(x.expires))[0] || null;
  const policies = [];
  for (const kind of ['general liability', 'workers compensation', 'auto', 'umbrella']) {
    const p = latest(a, kind);
    const q = latest(b, kind);
    if (!p && !q) continue;
    const pick = !p ? q : !q ? p : p.expires <= q.expires ? p : q;
    const other = pick === p ? q : p;
    policies.push({ ...other, ...pick, insurer: pick.insurer || other?.insurer, policyNumber: pick.policyNumber || other?.policyNumber });
  }
  policies.push(...(a.policies || []).filter((p) => p.kind === 'other' && isDate(p.expires)));
  return {
    isCertificate: a.isCertificate || b.isCertificate, isWcExemption: a.isWcExemption || b.isWcExemption, readable: a.readable !== false || b.readable !== false,
    insured: a.insured || b.insured || '', certificateHolder: a.certificateHolder || b.certificateHolder || '', producer: a.producer || b.producer || null, policies,
  };
}

/** Coverage that meets the minimums (whatever its dates): only that moves Liability Expires and Workers' Comp Expires */
export function meetsMinimums(p, req) {
  if (!p) return false;
  const num = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null);
  if (p.kind === 'general liability') {
    const occ = num(p.eachOccurrence);
    const agg = num(p.aggregate);
    if (req.glOccurrence && (!occ || occ < req.glOccurrence)) return false;
    return !(req.glAggregate && agg && agg < req.glAggregate);
  }
  if (p.kind === 'workers compensation') {
    const el = num(p.employersLiabilityEachAccident);
    return !(req.elEachAccident && el && el < req.elEachAccident);
  }
  return false;
}

/** What JobTread's fields become: end dates only move forward → { gl?, wc?, glFrom?, wcFrom? } */
export function laterDates(v, reading, req) {
  const out = {};
  for (const [key, kind, have] of [['gl', 'general liability', v.glExpires], ['wc', 'workers compensation', v.wcExpires]]) {
    const p = (reading?.policies || []).find((x) => x.kind === kind && isDate(x.expires));
    if (p && meetsMinimums(p, req) && (!have || p.expires > have)) { out[key] = p.expires; out[`${key}From`] = have || null; }
  }
  return out;
}

/**
 * What was typed into a W-9 that's a fillable IRS form: names, and whether a tax ID is in Part I, never the number
 * → { name, business, hasTaxId, words } or null (not a form, or nothing typed)
 */
export async function typedW9(bytes) {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const fields = doc.getForm().getFields().filter((f) => typeof f.getText === 'function');
    if (!fields.length) return null;
    const text = (f) => { try { return String(f.getText() || ''); } catch { return ''; } };
    const named = (re) => clean(text(fields.find((f) => re.test(f.getName())) || { getText: () => '' }), 120);
    const name = named(/f1_0?1\[/);
    const business = named(/f1_0?2\[/);
    // The SSN's three boxes or the EIN's two, or a whole number typed in one box
    const digits = fields.filter((f) => /ssn|ein|employer|identification|f1_1[1-5]\[/i.test(f.getName())).map((f) => text(f).replace(/\D/g, '')).join('');
    const hasTaxId = digits.length >= 9 || fields.some((f) => /^\d{3}-?\d{2}-?\d{4}$|^\d{2}-?\d{7}$/.test(text(f).trim()));
    if (!name && !business && !hasTaxId) return null;
    const words = [name && `Line 1: ${name}.`, business && `Line 2: ${business}.`, hasTaxId ? 'A tax ID is typed in Part I.' : 'No tax ID is typed in Part I.'].filter(Boolean).join(' ');
    return { name, business, hasTaxId, words };
  } catch {
    return null;
  }
}

// ─── Drawing a PDF's pages ──────────────────────────────────────────

const PDF_BASE = '/trade-partners/pdf/';
const DRAW_PAGES = 2;
const PAGE_SIDE = 2000;              // as the trade-partner page draws them (src/components/trade-partners/files.ts)

/**
 * A PDF's first pages as JPEG pictures, drawn by pdf.js in Cloudflare's Browser Rendering on the site's own
 * address, the way a vendor's browser draws them on the trade-partner page: a fax-style scan, a PDF whose
 * words are only shapes, and a W-9 typed into the IRS form all come out as the page looks.
 * ctx.browser is opened once a run and let go at its end (closeBrowser). → [{ bytes, type: 'image/jpeg' }] ([] when it can't)
 */
export async function drawPages(env, ctx, bytes, { max = DRAW_PAGES } = {}) {
  if (!env.BROWSER && !ctx.launch) return [];
  try {
    if (!ctx.browser) {
      // ctx.launch: a local Puppeteer (scripts and tests); here, Cloudflare's
      const { default: puppeteer } = ctx.launch ? { default: null } : await import('@cloudflare/puppeteer');
      ctx.browser = ctx.launch ? await ctx.launch() : await puppeteer.launch(env.BROWSER, { keep_alive: 60000 });
    }
    const page = await ctx.browser.newPage();
    try {
      // Only pdf.js runs here, on the site's own address
      await page.setBypassCSP(true).catch(() => {});
      await page.goto(`${SITE_ORIGIN}${PDF_BASE}pdf.js`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const b64 = toBase64(bytes);
      const pics = await page.evaluate(async (data, base, n, side) => {
        const lib = await import(`${location.origin}${base}pdf.js`);
        lib.GlobalWorkerOptions.workerSrc = `${location.origin}${base}pdf.worker.js`;
        const task = lib.getDocument({ data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, useWasm: false, enableXfa: false });
        const out = [];
        try {
          const doc = await task.promise;
          for (let i = 1; i <= Math.min(n, doc.numPages); i++) {
            const p = await doc.getPage(i);
            const one = p.getViewport({ scale: 1 });
            const viewport = p.getViewport({ scale: side / Math.max(one.width, one.height) });
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(viewport.width);
            canvas.height = Math.round(viewport.height);
            await p.render({ canvas, viewport, background: 'white', annotationMode: lib.AnnotationMode.ENABLE_STORAGE }).promise;
            out.push(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
          }
        } finally {
          task.destroy();
        }
        return out;
      }, b64, PDF_BASE, max, PAGE_SIDE);
      return (pics || []).map((p) => ({ bytes: bytesOf(p), type: 'image/jpeg' })).filter((p) => documentType(p.bytes.slice(0, 16)) === 'image/jpeg');
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    console.error('[coi-backfill] drawing', err.message);
    return [];
  }
}

export async function closeBrowser(ctx) {
  if (!ctx.browser) return;
  try { await ctx.browser.close(); } catch { /* gone already */ }
  ctx.browser = null;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ─── Reading one file ───────────────────────────────────────────────

/**
 * What one file is and says. file { bytes, type, name }; hints { coi, w9 } from its email or folder;
 * draw: (bytes) → a PDF's pages as pictures (drawPages), for a PDF whose text can't say.
 * A certificate made on a computer is read from its text (no drawing); a W-9 from its pictures, as on the
 * trade-partner page, since what's typed into it and its signature aren't in its text.
 * → { kind: 'coi' | 'w9' | null, read: boolean (Workers AI was asked), why?, hintless?, reading?, w9? }
 */
export async function readFound(env, file, hints = {}, { draw = async () => [] } = {}) {
  let text = '';
  let kind;
  if (file.type === 'application/pdf') {
    text = await pdfText(env, file);
    kind = kindOfText(text);
    if (kind === 'scan' && !hints.coi && !hints.w9) return { kind: null, read: false, why: 'a scan nothing says is insurance or a W-9', hintless: true };
    if (!kind) return { kind: null, read: false, why: 'not a certificate or a W-9 (its text says so)' };
  } else if (!hints.coi && !hints.w9) {
    return { kind: null, read: false, why: 'a photo nothing says is insurance or a W-9', hintless: true };
  }
  const scan = kind === 'scan';
  if (scan || !kind) kind = hints.coi ? 'coi' : 'w9';
  // Pictures of a PDF's pages: a scan's own JPEGs as they are, else drawn
  let pages = [];
  if (file.type === 'application/pdf' && (scan || kind === 'w9')) {
    pages = scannedPages(file.bytes, { max: DRAW_PAGES });
    if (!pages.length) pages = await draw(file.bytes);
    if (scan && !pages.length) return { kind: null, read: false, why: 'a scan that couldn’t be drawn to read' };
  }
  const pdf = { ...file, pages };
  if (kind === 'coi') {
    let reading = readingOf(await readDocument(env, 'coi', pdf, { text }));
    // Its text says certificate but didn't read as one (some PDFs' text comes out scrambled): its pages, drawn
    if (!(reading?.isCertificate || reading?.isWcExemption) && file.type === 'application/pdf' && !pages.length) {
      const drawn = await draw(file.bytes);
      if (drawn.length) reading = readingOf(await readDocument(env, 'coi', { ...file, pages: drawn }, { text: '' })) || reading;
    }
    if (reading?.isCertificate || reading?.isWcExemption) return { kind: 'coi', read: true, reading };
    // A scan or photo its email calls both: maybe it's the W-9
    if (!(hints.w9 && (scan || file.type !== 'application/pdf'))) return { kind: null, read: true, why: reading ? 'read: not a certificate of insurance' : 'couldn’t be read' };
  }
  let w9 = file.type !== 'application/pdf' || pages.length ? (await readDocument(env, 'w9', pdf)).pictures : null;
  // No pictures of a W-9 made on a computer (no browser here): its text, and what's typed in its boxes
  if (!w9 && file.type === 'application/pdf' && !scan) w9 = await readW9Text(env, text, (await typedW9(file.bytes))?.words || '');
  if (!w9?.isW9) return { kind: null, read: true, why: w9 ? 'read: not a certificate or a W-9' : 'couldn’t be read' };
  return { kind: 'w9', read: true, w9 };
}

// ─── Which vendor ───────────────────────────────────────────────────

const MATCH_SCHEMA = { type: 'object', properties: { pick: { type: 'integer' }, sure: { type: 'boolean' } }, required: ['pick', 'sure'] };

/** names: the insured and its DBA names. → { jtId, name, how: 'name' | 'ai' } or null */
export async function matchVendor(env, names, vendors, { context = '' } = {}) {
  const cands = candidatesFor(names, vendors);
  if (!cands.length) return null;
  if (cands[0].score === 1) return { jtId: cands[0].jtId, name: cands[0].name, how: 'name' };
  if (!env.AI?.run) return null;
  const top = cands.slice(0, 5);
  const a = await askModel(env, TEXT_MODEL, [
    { role: 'system', content: 'You match the company on an insurance certificate or W-9 to a nonprofit\'s list of vendors. The same company means the same business under a slightly different name (a DBA, "Inc." or "LLC" or not, "&" or "and", an abbreviation). A different business that shares a word, a parent company or a different trade is not the same. Reply with JSON {"pick": <the number of the vendor that is the same company, or 0 for none>, "sure": true|false}.' },
    { role: 'user', content: `The company: ${names.join(' / ')}${context ? `\n${context}` : ''}\n\nThe vendors:\n${top.map((c, i) => `${i + 1}. ${c.name}`).join('\n')}` },
  ], MATCH_SCHEMA);
  const i = Number(a?.pick);
  if (a?.sure === true && Number.isInteger(i) && i >= 1 && i <= top.length) return { jtId: top[i - 1].jtId, name: top[i - 1].name, how: 'ai' };
  return null;
}

/** JobTread's vendors as the 4-hourly cache has them → [{ jtId, name, jobs }] */
async function cachedVendors(DB) {
  const rows = (await DB.prepare('SELECT jt_id, name, facts FROM vendors WHERE jt_id IS NOT NULL').all().catch(() => ({ results: [] }))).results || [];
  return rows.map((r) => ({ jtId: r.jt_id, name: r.name, jobs: (parseJson(r.facts).jobs || []).length }));
}

// ─── Filing in JobTread ─────────────────────────────────────────────

// JobTread's phone fields take a number as +1 and 10 digits
const e164 = (s) => { const d = String(s || '').replace(/\D/g, ''); const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d; return /^[2-9]\d{9}$/.test(t) ? `+1${t}` : null; };

/** A vendor's people and files → { primaryId, contacts: [{ id, name, title, email }], files: [{ id, name, type, size, folder, tags }] } */
async function accountOf(env, jtId, fetchImpl) {
  const d = await jt(env, {
    account: {
      $: { id: jtId },
      id: {}, primaryContact: { id: {} },
      contacts: { $: { size: 25 }, nodes: { id: {}, name: {}, title: {}, customFieldValues: CONTACT_VALUES } },
      files: { $: { size: 100 }, nodes: { id: {}, name: {}, type: {}, size: {}, folder: {}, fileTags: { $: { size: 10 }, nodes: { id: {} } } } },
    },
  }, fetchImpl);
  const a = d?.account;
  return {
    primaryId: a?.primaryContact?.id || null,
    contacts: (a?.contacts?.nodes || []).map((c) => ({ id: c.id, name: c.name || '', title: c.title || '', email: contactEmail(c) })),
    files: (a?.files?.nodes || []).map((f) => ({ id: f.id, name: f.name || '', type: String(f.type || '').toLowerCase(), size: f.size || 0, folder: f.folder || null, tags: (f.fileTags?.nodes || []).map((t) => t.id) })),
  };
}

/** One of a vendor's JobTread files with these very bytes (only one the same size is fetched to compare), or null */
async function sameFile(env, ctx, files, bytes, hash) {
  for (const f of files.filter((x) => x.size === bytes.byteLength).slice(0, 3)) {
    const d = await jt(env, { file: { $: { id: f.id }, id: {}, url: {} } }, ctx.fetchImpl);
    if (!d?.file?.url) continue;
    const res = await ctx.fetchImpl(d.file.url, { signal: AbortSignal.timeout(30000) });
    if (res.ok && (await sha256(new Uint8Array(await res.arrayBuffer()))) === hash) return f;
  }
  return null;
}

async function createContact(env, jtId, { name, title, email, phone }, fetchImpl) {
  const fields = contactFields(await jtSetup(env, { fetchImpl }), { email, phone: e164(phone) });
  const made = await jt(env, { createContact: { $: { accountId: jtId, name: clean(name, 80) || email, title, customFieldValues: fields }, createdContact: { id: {} } } }, fetchImpl);
  return made?.createContact?.createdContact?.id || null;
}

/** The trade-partner agent, when the vendor hasn't named one: renewals are asked of them (./_trade-partners.js) */
async function rememberAgent(DB, jtId, agent, now) {
  const iso = new Date(now).toISOString();
  const r = await DB.prepare('SELECT agent FROM vendor_profiles WHERE jt_id = ?').bind(jtId).first();
  if (r?.agent) return false;
  const value = JSON.stringify({ ...agent, asks: 0, askedAt: null, open: false, found: true });
  if (r) await DB.prepare('UPDATE vendor_profiles SET agent = ?, updated_at = ? WHERE jt_id = ? AND agent IS NULL').bind(value, iso, jtId).run();
  else await DB.prepare("INSERT OR IGNORE INTO vendor_profiles (jt_id, steps, agent, lang, reminders, updated_at) VALUES (?, '{}', ?, 'en', 0, ?)").bind(jtId, value, iso).run();
  return true;
}

/** A main contact's email on the vendors cache, so they can sign in now rather than after the 4-hourly read */
async function rememberEmail(DB, jtId, email) {
  const r = await DB.prepare('SELECT id, facts FROM vendors WHERE jt_id = ?').bind(jtId).first();
  if (!r) return;
  const facts = parseJson(r.facts);
  facts.emails = [...new Set([...(facts.emails || []), email])];
  await DB.prepare('UPDATE vendors SET email = COALESCE(email, ?), facts = ? WHERE id = ?').bind(email, JSON.stringify(facts), r.id).run();
}

/**
 * The agency and the vendor's own people from a certificate's email, onto JobTread when they aren't there.
 * agent: { name, email, agency, phone } from the PRODUCER box; main: { name, email } a sender on the vendor's domain
 * → ['agent', 'main'] what was added
 */
async function addPeople(env, ctx, jtId, acct, { agent, main }) {
  const added = [];
  const has = (email) => acct.contacts.some((c) => c.email === email);
  let mainId = acct.contacts.find((c) => c.email && !AGENT_TITLE.test(c.title))?.id || null;
  if (main && !mainId && !has(main.email)) {
    mainId = await createContact(env, jtId, { name: main.name || main.email, title: 'Main contact', email: main.email }, ctx.fetchImpl);
    if (mainId && !acct.primaryId) await jt(env, { updateAccount: { $: { id: jtId, primaryContactId: mainId } } }, ctx.fetchImpl);
    await rememberEmail(env.DB, jtId, main.email);
    added.push('main');
  }
  if (agent && !has(agent.email)) {
    const name = [agent.name || agent.email, agent.agency && `(${agent.agency})`].filter(Boolean).join(' ');
    const agentId = await createContact(env, jtId, { name, title: 'Insurance agent', email: agent.email, phone: agent.phone }, ctx.fetchImpl);
    // JobTread may make a vendor's first contact its primary one; the agent never is
    if (agentId && !mainId && !acct.primaryId) {
      const d = await jt(env, { account: { $: { id: jtId }, primaryContact: { id: {} } } }, ctx.fetchImpl).catch(() => null);
      if (d?.account?.primaryContact?.id === agentId) await jt(env, { updateAccount: { $: { id: jtId, primaryContactId: null } } }, ctx.fetchImpl);
    }
    added.push('agent');
  }
  if (agent && await rememberAgent(env.DB, jtId, agent, ctx.now)) added.push('renewals');
  return added;
}

/** Where a file was found, in words for the note: "Joe Lane’s email from March 2025" */
function whereFound(row, h, jtId) {
  if (row.source === 'gmail') return `${h.owner ? `${h.owner}’s` : 'a staff'} email from ${monthYear(row.sent_at)}`;
  if (row.source === 'ramp') return `a Ramp bill${h.invoice ? ` (invoice ${h.invoice})` : ''} from ${monthYear(row.sent_at)}`;
  return `${h.jtId === jtId ? 'this vendor’s' : `${h.accountName || 'another vendor'}’s`} JobTread files${h.fileName ? ` (${h.fileName})` : ''}, where it wasn’t tagged`;
}

const coverageWords = (reading) => {
  if (reading.isWcExemption && !reading.policies.length) return 'a workers’ compensation exemption';
  const bits = reading.policies.filter((p) => KINDS[p.kind] === 'gl' || KINDS[p.kind] === 'wc').map((p) => {
    const limit = KINDS[p.kind] === 'gl' && p.eachOccurrence ? ` (${money(p.eachOccurrence)} each occurrence)` : '';
    return `${KINDS[p.kind] === 'gl' ? 'general liability' : 'workers’ comp'}${limit} through ${longDate(p.expires)}`;
  });
  return bits.length ? bits.join(', ') : 'no general liability or workers’ comp on it';
};

/**
 * One found file into JobTread for its vendor. doc 'coi' | 'w9'; got: readFound's; file { bytes, type, name }
 * → { jtFileId, detail }
 */
async function fileFound(env, ctx, row, h, { jtId, doc, got, file, hash }) {
  const ids = await jtSetup(env, { fetchImpl: ctx.fetchImpl });
  const v = await readJtVendor(env, jtId, { fetchImpl: ctx.fetchImpl });
  if (!v || v.archived) return null;
  const acct = await accountOf(env, jtId, ctx.fetchImpl);
  const tag = ids.tags[doc];
  const reading = got.reading;
  const day = isoDay(Date.parse(row.sent_at) || ctx.now);
  // Once: the file where JobTread already has it on this account (the same bytes), tagged there
  const there = row.source === 'jt' && h.jtId === jtId ? acct.files.find((f) => f.id === h.fileId) : await sameFile(env, ctx, acct.files, file.bytes, hash);
  let jtFileId;
  if (there) {
    jtFileId = there.id;
    if (!there.tags.includes(tag)) await jt(env, { updateFile: { $: { id: there.id, fileTagIds: [...there.tags, tag].slice(0, 10), ...(there.folder ? {} : { folder: FOLDER }) } } }, ctx.fetchImpl);
  } else {
    const p = reading?.policies.find((x) => KINDS[x.kind] === 'gl') || reading?.policies[0];
    const name = doc === 'w9' ? `W-9 ${v.name} ${day}` : reading.isWcExemption && !reading.policies.length ? `WC exemption ${v.name} ${day}`
      : `COI ${v.name} ${isDate(p?.effective) ? `${p.effective} to ` : ''}${p?.expires || day}`;
    const target = { name: `${name}.${EXT[file.type] || 'pdf'}`, targetType: 'account', targetId: jtId, folder: FOLDER, fileTagIds: [tag] };
    const made = row.source === 'jt'
      ? await jt(env, { createFile: { $: { ...target, copyFromFileId: h.fileId }, createdFile: { id: {} } } }, ctx.fetchImpl)
      : await jt(env, { createFile: { $: { ...target, uploadRequestId: await uploadToJt(env, file, ctx.fetchImpl) }, createdFile: { id: {} } } }, ctx.fetchImpl);
    jtFileId = made?.createFile?.createdFile?.id || null;
  }

  const req = await readDocSettings(env.DB);
  const patch = {};
  const after = { ...v };
  let said;
  if (doc === 'coi') {
    const later = laterDates(v, reading, req);
    if (later.gl) { patch.gl = later.gl; after.glExpires = later.gl; }
    if (later.wc) { patch.wc = later.wc; after.wcExpires = later.wc; }
    if (later.gl || later.wc) patch.check = `${reading.policies.map((x) => `${(KINDS[x.kind] || x.kind).toUpperCase()} to ${x.expires}${x.insurer ? ` (${x.insurer})` : ''}`).join(' · ')} · found ${isoDay(ctx.now)}`.slice(0, 250);
    const moved = [later.gl && `Liability Expires is now ${longDate(later.gl)}`, later.wc && `Workers’ Comp Expires is now ${longDate(later.wc)}`].filter(Boolean);
    said = `Certificate of insurance${reading.producer?.name ? ` from ${clean(reading.producer.name, 80)}` : ''}, found in ${whereFound(row, h, jtId)}: ${coverageWords(reading)}. `
      + (moved.length ? `${moved.join(', and ')}.` : 'JobTread already had later dates (or this coverage is under the minimums), so the dates stay as they were.');
  } else {
    if (!v.w9) { patch.w9 = true; after.w9 = true; }
    said = `W-9 for ${[got.w9.name, got.w9.businessName].filter(Boolean).join(' / ') || v.name}, found in ${whereFound(row, h, jtId)} and checked: it has a tax ID${got.w9.signed ? ' and it’s signed' : ''}.${v.w9 ? '' : ' W-9 is ticked.'}`;
  }
  const state = docsState(after, req, { now: ctx.now });
  const label = labelFor(after, state, await readAsk(env.DB, jtId));
  if (label && label !== v.docs) patch.docs = label;
  if (Object.keys(patch).length) await writeFields(env, ids, jtId, patch, ctx.fetchImpl);

  // The people: the agency (for renewals) and a sender on the vendor's own domain
  let added = [];
  if (doc === 'coi') {
    const pe = clean(reading.producer?.email, 120).toLowerCase();
    const agent = isEmail(pe) && !isStaffEmail(pe) && !onVendorDomain(pe, v.name)
      ? { name: clean(reading.producer.contact, 80), email: pe, agency: clean(reading.producer.name, 80), phone: clean(reading.producer.phone, 30) } : null;
    const from = row.source === 'gmail' ? addressOf(h.from) : '';
    const main = isEmail(from) && !isStaffEmail(from) && domainOf(from) !== domainOf(pe) && onVendorDomain(from, v.name) ? { name: displayName(h.from), email: from } : null;
    added = await addPeople(env, ctx, jtId, acct, { agent, main });
    if (added.includes('agent')) said += ` ${agent.name || agent.email}${agent.agency ? ` at ${agent.agency}` : ''} is added as their insurance agent${added.includes('renewals') ? ', and SOARD asks them for renewals' : ''}.`;
    if (added.includes('main')) said += ` ${main.name || main.email} (${main.email}), who sent it, is added as their main contact.`;
  }
  await vendorNote(env, jtId, doc === 'w9' ? 'W-9 found' : 'Certificate of insurance found', said, ctx.fetchImpl);
  if (doc === 'coi') await recordCoverage(env, { jtId, insured: reading.insured || v.name, policies: reading.policies, exempt: reading.isWcExemption, source: row.source, sourceRef: row.id, fileHash: hash, jtFileId, now: ctx.now });
  return { jtFileId, detail: `${doc === 'w9' ? 'W-9' : 'certificate'} filed on ${v.name}${patch.gl || patch.wc ? ', dates moved' : ''}${added.length ? `, added ${added.join(' and ')}` : ''}` };
}

// ─── Fetching a file ────────────────────────────────────────────────

async function bytesFor(env, ctx, row, h) {
  if (row.source === 'gmail') {
    const token = await ctx.token(h.mailbox);
    const msg = await gmail(token, `/messages/${h.id}?format=full`, ctx.fetchImpl);
    const p = partsOf(msg.payload).find((x) => x.partId === h.part);
    if (!p) return null;
    const data = p.body?.data || (await gmail(token, `/messages/${h.id}/attachments/${encodeURIComponent(p.body.attachmentId)}`, ctx.fetchImpl)).data;
    return { bytes: bytesOf(data), name: p.filename || row.name };
  }
  let url;
  if (row.source === 'jt') {
    const d = await jt(env, { file: { $: { id: h.fileId }, id: {}, url: {} } }, ctx.fetchImpl);
    url = d?.file?.url;
  } else {
    const bill = await ramp(env, `/bills/${encodeURIComponent(h.billId)}`, { fetchImpl: ctx.fetchImpl });
    url = (bill?.attachments || []).find((a) => a.id === h.attachmentId)?.url;
  }
  if (!url) return null;
  const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`The file answered ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return { bytes: new Uint8Array(0), name: row.name, tooBig: true };
  return { bytes: new Uint8Array(await res.arrayBuffer()), name: row.name };
}

// ─── Handling one row ───────────────────────────────────────────────

/** An email from the search: its files worth reading become rows of their own */
async function openEmail(env, ctx, row) {
  const h = parseJson(row.hint);
  const token = await ctx.token(h.mailbox);
  const msg = await gmail(token, `/messages/${h.id}?format=full`, ctx.fetchImpl);
  const hd = msg.payload?.headers;
  const subject = header(hd, 'Subject');
  const from = header(hd, 'From');
  const hints = hintsOf(`${subject}\n${textOf(msg.payload).slice(0, 4000)}`);
  const sentAt = new Date(Number(msg.internalDate) || ctx.now).toISOString();
  const files = filesOf(msg.payload).filter((f) => worthReading(f, { hinted: hints.coi || hints.w9 }));
  const iso = new Date(ctx.now).toISOString();
  if (files.length) {
    await env.DB.batch(files.map((f) => {
      const own = hintsOf(f.name);
      const hint = { mailbox: h.mailbox, owner: h.owner || '', id: h.id, part: f.part, subject: clean(subject, 160), from: clean(from, 160), coi: hints.coi || own.coi, w9: hints.w9 || own.w9 };
      return env.DB.prepare(`INSERT OR IGNORE INTO coi_found (id, source, item, name, size, sent_at, hint, state, found_at, updated_at) VALUES (?, 'gmail', 'file', ?, ?, ?, ?, 'queued', ?, ?)`)
        .bind(`${row.id}:${f.part}`, clean(f.name, 160), f.size, sentAt, JSON.stringify(hint), iso, iso);
    }));
  }
  return { state: 'opened', detail: `${files.length} file${files.length === 1 ? '' : 's'} to read`, sentAt };
}

async function seenBefore(DB, hash, id) {
  const r = await DB.prepare(`SELECT id FROM coi_found WHERE file_hash = ? AND id != ? AND state IN (${SETTLED.map(() => '?').join(', ')}) LIMIT 1`).bind(hash, id, ...SETTLED).first();
  return r?.id || null;
}

/** A file: fetched, hashed, read, matched and filed → the row's outcome */
async function readFile(env, ctx, row) {
  const h = parseJson(row.hint);
  const got = await bytesFor(env, ctx, row, h);
  if (!got) return { state: 'skipped', detail: 'the file isn’t there any more' };
  if (got.tooBig || got.bytes.byteLength > MAX_BYTES) return { state: 'skipped', detail: 'over 10 MB' };
  const type = documentType(got.bytes.slice(0, 16));
  if (!type || type === 'image/heic') return { state: 'skipped', detail: 'not a PDF or a photo' };
  const hash = await sha256(got.bytes);
  const twin = await seenBefore(env.DB, hash, row.id);
  if (twin) return { state: 'duplicate', hash, detail: `the same file as ${twin}` };
  const file = { bytes: got.bytes, type, name: got.name || 'document' };
  const found = await readFound(env, file, { coi: !!h.coi, w9: !!h.w9 }, { draw: ctx.draw });
  if (found.read) ctx.reads++;
  if (!found.kind) return { state: found.hintless ? 'passed' : 'skipped', hash, detail: found.why };
  const names = found.kind === 'w9' ? [found.w9.name, found.w9.businessName].filter(Boolean).flatMap(namesOf) : namesOf(found.reading.insured);
  const insured = names.join(' / ');
  if (isOwn(names, found.reading?.policies)) return { state: 'own', hash, kind: found.kind, insured, detail: 'SOARD’s own' };
  if (found.kind === 'w9') {
    const verdict = judgeW9(found.w9);
    if (!verdict.accepted) return { state: 'skipped', hash, kind: 'w9', insured, detail: `a W-9 that doesn’t check out: ${(verdict.problems || ['unreadable']).join(' ')}` };
  }
  // A file on a vendor's JobTread account is theirs when it names them; anything else is matched by name
  let match = null;
  if (row.source === 'jt' && names.some((n) => nameScore(n, h.accountName) >= 0.5)) match = { jtId: h.jtId, name: h.accountName, how: 'account' };
  if (!match) {
    ctx.vendors ||= await cachedVendors(env.DB);
    const context = [h.from && `Sent by: ${clean(h.from, 120)}`, h.subject && `Email subject: ${h.subject}`, h.vendor && `Ramp's vendor: ${h.vendor}`].filter(Boolean).join('\n');
    match = names.length ? await matchVendor(env, names, ctx.vendors, { context }) : null;
  }
  // A W-9 on a vendor's JobTread account that names no vendor is still theirs: line 1 is often the owner ("Pat & Lee Example" on Example Builders)
  if (!match && row.source === 'jt' && found.kind === 'w9' && h.jtId) match = { jtId: h.jtId, name: h.accountName, how: 'account' };
  if (!match) {
    if (found.kind === 'coi') await recordCoverage(env, { insured: insured || 'Unknown', policies: found.reading.policies, exempt: found.reading.isWcExemption, source: row.source, sourceRef: row.id, fileHash: hash, now: ctx.now });
    return { state: 'unmatched', hash, kind: found.kind, insured, detail: names.length ? 'no JobTread vendor by that name' : 'no company name on it' };
  }
  const filed = await fileFound(env, ctx, row, h, { jtId: match.jtId, doc: found.kind, got: found, file, hash });
  if (!filed) return { state: 'unmatched', hash, kind: found.kind, insured, detail: 'its JobTread vendor is archived' };
  return { state: 'filed', hash, kind: found.kind, insured, jtId: match.jtId, detail: `${filed.detail} (${match.how})` };
}

async function handle(env, ctx, row) {
  const iso = () => new Date(ctx.now).toISOString();
  await env.DB.prepare("UPDATE coi_found SET state = 'working', updated_at = ? WHERE id = ?").bind(iso(), row.id).run();
  try {
    const r = row.item === 'message' ? await openEmail(env, ctx, row) : await readFile(env, ctx, row);
    await env.DB.prepare('UPDATE coi_found SET state = ?, detail = ?, file_hash = COALESCE(?, file_hash), kind = COALESCE(?, kind), insured = COALESCE(?, insured), jt_id = COALESCE(?, jt_id), sent_at = COALESCE(?, sent_at), updated_at = ? WHERE id = ?')
      .bind(r.state, clean(r.detail, 300) || null, r.hash || null, r.kind || null, clean(r.insured, 160) || null, r.jtId || null, r.sentAt || null, iso(), row.id).run();
    if (r.state === 'filed') ctx.out.filed++;
    return r;
  } catch (err) {
    const tries = (row.tries || 0) + 1;
    await env.DB.prepare('UPDATE coi_found SET state = ?, tries = ?, detail = ?, updated_at = ? WHERE id = ?')
      .bind(tries >= MAX_TRIES ? 'given-up' : 'failed', tries, clean(err.message, 300), iso(), row.id).run();
    ctx.errors.push(err.message);
    return { state: 'failed' };
  }
}

// ─── Finding ────────────────────────────────────────────────────────

const due = (s, now) => !s?.doneAt || now - (s.lastPassAt || 0) > IDLE_MS;

async function queueRows(DB, rows, now) {
  if (!rows.length) return 0;
  const iso = new Date(now).toISOString();
  const res = await DB.batch(rows.map((r) => DB.prepare(`INSERT OR IGNORE INTO coi_found (id, source, item, name, size, sent_at, hint, state, found_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
    .bind(r.id, r.source, r.item, r.name || null, r.size || null, r.sentAt || null, JSON.stringify(r.hint || {}), iso, iso)));
  return res.reduce((n, x) => n + (x?.meta?.changes || 0), 0);
}

/** One page of one mailbox's search: the emails are queued, opened later */
async function findMail(env, ctx, st) {
  const boxes = await mailboxes(env);
  st.mail ||= {};
  // A mailbox Gmail refused waits an hour, so the others go on meanwhile
  const box = boxes.find((b) => due(st.mail[b.email], ctx.now) && !(ctx.now - (st.mail[b.email]?.failedAt || 0) < 60 * MIN));
  if (!box) return false;
  const s = (st.mail[box.email] ||= {});
  // A pass keeps one search from its first page to its last (Gmail's page token belongs to it)
  if (!s.pageToken) Object.assign(s, { passAt: ctx.now, since: s.doneAt ? (s.lastPassAt || ctx.now) - OVERLAP_MS : ctx.now - LOOK_BACK_DAYS * DAY });
  const q = `${MAIL_WORDS} after:${Math.floor(s.since / 1000)}`;
  let list;
  try {
    list = await gmail(await ctx.token(box.email), `/messages?maxResults=${PAGE}&q=${encodeURIComponent(q)}${s.pageToken ? `&pageToken=${encodeURIComponent(s.pageToken)}` : ''}`, ctx.fetchImpl);
  } catch (err) {
    Object.assign(s, { failedAt: ctx.now, error: clean(err.message, 200) });
    throw Object.assign(err, { message: `${box.email.split('@')[0]}’s inbox: ${err.message}` });
  }
  delete s.failedAt;
  delete s.error;
  ctx.out.found += await queueRows(env.DB, (list.messages || []).map((m) => ({ id: `gmail:${box.email}:${m.id}`, source: 'gmail', item: 'message', hint: { mailbox: box.email, owner: box.name || '', id: m.id } })), ctx.now);
  s.pageToken = list.nextPageToken || null;
  if (!s.pageToken) Object.assign(s, { doneAt: s.doneAt || ctx.now, lastPassAt: s.passAt || ctx.now });
  return true;
}

/** A few JobTread vendor accounts at a time: their untagged PDFs and photos are queued */
async function findJobTread(env, ctx, st) {
  const s = (st.jt ||= {});
  if (!due(s, ctx.now) && !s.page) return false;
  const ids = await jtSetup(env, { fetchImpl: ctx.fetchImpl });
  const tagged = new Set([ids.tags.w9, ids.tags.coi]);
  const d = await jt(env, {
    organization: {
      $: { id: SOARD_ORG_ID },
      accounts: {
        // JobTread sizes a query by its worst case: 5 accounts × 50 files × 5 tags fits, 10 × 50 doesn't (checked Oct 30 2026)
        $: { size: 5, where: ['type', '=', 'vendor'], ...(s.page ? { page: s.page } : {}) },
        nextPage: {},
        nodes: { id: {}, name: {}, archivedAt: {}, files: { $: { size: 50 }, nodes: { id: {}, name: {}, type: {}, size: {}, folder: {}, createdAt: {}, fileTags: { $: { size: 5 }, nodes: { id: {} } } } } },
      },
    },
  }, ctx.fetchImpl);
  const conn = d?.organization?.accounts;
  const rows = [];
  for (const a of conn?.nodes || []) {
    if (a.archivedAt) continue;
    for (const f of a.files?.nodes || []) {
      if ((f.fileTags?.nodes || []).some((t) => tagged.has(t.id))) continue;
      const inFolder = String(f.folder || '').toLowerCase() === FOLDER.toLowerCase();
      const hints = hintsOf(`${f.name} ${f.folder || ''}`);
      if (!worthReading({ name: f.name, type: f.type, size: f.size }, { hinted: inFolder || hints.coi || hints.w9 })) continue;
      rows.push({ id: `jt:${f.id}`, source: 'jt', item: 'file', name: clean(f.name, 160), size: f.size, sentAt: f.createdAt || null,
        hint: { jtId: a.id, accountName: a.name, fileId: f.id, fileName: clean(f.name, 120), coi: hints.coi || (inFolder && !hints.w9), w9: hints.w9 } });
    }
  }
  ctx.out.found += await queueRows(env.DB, rows, ctx.now);
  s.page = conn?.nextPage || null;
  if (!s.page) Object.assign(s, { doneAt: s.doneAt || ctx.now, lastPassAt: ctx.now });
  return true;
}

const fileNameOfUrl = (url) => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { return ''; } };

/** One page of Ramp bills: their supporting files (not the invoice itself) are queued */
async function findRamp(env, ctx, st) {
  if (!rampConfigured(env)) return false;
  const s = (st.ramp ||= {});
  if (!due(s, ctx.now) && !s.next) return false;
  const since = s.doneAt ? new Date((s.lastPassAt || ctx.now) - OVERLAP_MS).toISOString() : new Date(ctx.now - LOOK_BACK_DAYS * DAY).toISOString();
  if (!s.next) s.passAt = ctx.now;
  const d = await ramp(env, s.next || '/bills', { query: s.next ? null : { from_created_at: since, page_size: PAGE }, fetchImpl: ctx.fetchImpl });
  const rows = [];
  for (const b of d?.data || []) {
    for (const a of b.attachments || []) {
      if (a.attachment_type !== 'FILE' || !a.id) continue;
      const name = fileNameOfUrl(a.url);
      const hints = hintsOf(name);
      rows.push({ id: `ramp:${b.id}:${a.id}`, source: 'ramp', item: 'file', name: clean(name, 160), sentAt: b.issued_at || b.created_at || null,
        hint: { billId: b.id, attachmentId: a.id, vendor: clean(b.vendor?.name || b.vendor?.remote_name, 120), invoice: clean(b.invoice_number, 40), coi: hints.coi, w9: hints.w9 } });
    }
  }
  ctx.out.found += await queueRows(env.DB, rows, ctx.now);
  s.next = d?.page?.next || null;
  if (!s.next) Object.assign(s, { doneAt: s.doneAt || ctx.now, lastPassAt: s.passAt || ctx.now });
  return true;
}

// ─── The heartbeat ──────────────────────────────────────────────────

/** One run: a page of finding, then emails opened and files read until the run's share of time is up */
export async function runBackfill(env, st, { now = Date.now(), fetchImpl = fetch, draw = null } = {}) {
  await ensureCoverageSchema(env.DB);
  const started = Date.now();
  const tokens = new Map();
  const ctx = {
    // Called as ctx.fetchImpl(…): Cloudflare's fetch refuses to be some object's method ("Illegal invocation")
    now, fetchImpl: (url, init) => fetchImpl(url, init), reads: 0, vendors: null, browser: null, errors: [], out: { found: 0, opened: 0, read: 0, filed: 0 },
    draw: draw || ((bytes) => drawPages(env, ctx, bytes)),
    token: async (mailbox) => {
      if (!tokens.has(mailbox)) tokens.set(mailbox, await accessToken(env, mailbox, { fetchImpl, now, scope: GMAIL_READ_SCOPE }));
      return tokens.get(mailbox);
    },
  };
  // Finding takes turns: staff email, JobTread's files, Ramp's bills
  const finders = [['mail', findMail, () => !!env.GOOGLE_CALENDAR_KEY], ['jt', findJobTread, () => !!env.JOBTREAD_GRANT_KEY], ['ramp', findRamp, () => rampConfigured(env)]];
  for (let i = 0; i < finders.length && Date.now() - started < FIND_MS; i++) {
    const [name, find, on] = finders[(st.turn || 0) % finders.length];
    st.turn = ((st.turn || 0) + 1) % finders.length;
    if (!on()) continue;
    try { if (await find(env, ctx, st)) break; } catch (err) { ctx.errors.push(`${name}: ${err.message}`); }
  }
  const iso = new Date(now).toISOString();
  await env.DB.prepare("UPDATE coi_found SET state = 'failed', tries = tries + 1 WHERE state = 'working' AND updated_at < ?").bind(new Date(now - STUCK_MS).toISOString()).run();
  await env.DB.prepare("UPDATE coi_found SET state = 'given-up' WHERE state = 'failed' AND tries >= ?").bind(MAX_TRIES).run();
  // Read again, once each time REREAD is raised: what matched no vendor, and certificates and W-9s the model gave no name for
  if ((st.reread || 0) < REREAD) {
    await env.DB.prepare("UPDATE coi_found SET state = 'queued', tries = 0, updated_at = ? WHERE item = 'file' AND (state = 'unmatched' OR (state = 'skipped' AND kind IN ('coi', 'w9') AND (insured IS NULL OR insured = '')))").bind(iso).run();
    st.reread = REREAD;
  }
  // Emails first (each makes file rows), newest first: the newest certificate names the agent who's theirs now
  try {
    for (let n = 0; n < ROWS_PER_RUN && Date.now() - started < WORK_MS && ctx.reads < READS_PER_RUN; n++) {
      const row = await env.DB.prepare(`SELECT * FROM coi_found WHERE (state = 'queued' OR (state = 'failed' AND updated_at < ?))
          ORDER BY CASE item WHEN 'message' THEN 0 ELSE 1 END, sent_at DESC LIMIT 1`).bind(new Date(now - RETRY_MS).toISOString()).first();
      if (!row) break;
      const r = await handle(env, ctx, row);
      if (row.item === 'message' && r.state === 'opened') ctx.out.opened++;
      if (row.item === 'file' && r.state !== 'failed') ctx.out.read++;
    }
  } finally {
    await closeBrowser(ctx);
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM coi_found WHERE state IN ('queued', 'failed')").first();
  // Still finding: a pass under way, or one that's due (every few hours)
  const pending = (s) => due(s, now) || Boolean(s?.page || s?.next || s?.pageToken);
  const boxes = env.GOOGLE_CALENDAR_KEY ? await mailboxes(env).catch(() => []) : [];
  const finding = boxes.some((b) => pending(st.mail?.[b.email])) || (!!env.JOBTREAD_GRANT_KEY && pending(st.jt)) || (rampConfigured(env) && pending(st.ramp));
  Object.assign(st, { busy: Boolean(left?.n) || finding, lastRunAt: now, lastRun: { at: iso, ...ctx.out }, error: ctx.errors.length ? clean(ctx.errors.join(' · '), 500) : null, errorAt: ctx.errors.length ? iso : null });
  return st;
}

/** On the live hub's heartbeat: every minute while there's anything to find or read, then every few hours. Never throws */
export async function maybeRunBackfill(env, { now = Date.now(), fetchImpl = fetch, force = false, draw = null } = {}) {
  if (!env?.DB || !env.JOBTREAD_GRANT_KEY) return null;
  let st = {};
  try {
    st = await readState(env.DB, STATE_KEY);
    if (!force && now - (st.lastRunAt || 0) < (st.busy === false ? IDLE_MS : BUSY_MS)) return null;
    if (!force && (st.runningUntil || 0) > now) return null;
    await writeState(env.DB, STATE_KEY, { runningUntil: now + LOCK_MS });
    st = await runBackfill(env, st, { now, fetchImpl, draw });
    await writeState(env.DB, STATE_KEY, { ...st, runningUntil: 0 });
    return st;
  } catch (err) {
    console.error('[coi-backfill]', err.message);
    await writeState(env.DB, STATE_KEY, { error: clean(err.message, 500), errorAt: new Date(now).toISOString(), runningUntil: 0, lastRunAt: now }).catch(() => {});
    return null;
  }
}

/** For Site → Automations: where finding stands and what came of it. Counts and times only */
export async function backfillStatus(env) {
  if (!env?.DB) return null;
  await ensureCoverageSchema(env.DB);
  const st = await readState(env.DB, STATE_KEY);
  const rows = (await env.DB.prepare("SELECT state, kind, COUNT(*) AS n FROM coi_found WHERE item = 'file' AND source != 'upload' GROUP BY state, kind").all()).results || [];
  const count = (state, kind = null) => rows.filter((r) => r.state === state && (!kind || r.kind === kind)).reduce((n, r) => n + r.n, 0);
  const emails = await env.DB.prepare("SELECT COUNT(*) AS n FROM coi_found WHERE item = 'message' AND state IN ('queued', 'failed', 'working')").first();
  const vendors = await env.DB.prepare("SELECT COUNT(DISTINCT jt_id) AS n FROM coi_found WHERE state = 'filed' AND source != 'upload'").first();
  const mail = Object.values(st.mail || {});
  return {
    at: st.lastRun?.at || null, error: st.error || null, errorAt: st.errorAt || null,
    firstPass: { mail: mail.length > 0 && mail.every((s) => s.doneAt), jt: !!st.jt?.doneAt, ramp: !!st.ramp?.doneAt },
    // An inbox Gmail refused at its last look (it's tried again hourly)
    refused: Object.entries(st.mail || {}).filter(([, s]) => s.failedAt).map(([box, s]) => ({ inbox: box.split('@')[0], error: s.error || null, at: new Date(s.failedAt).toISOString() })),
    waiting: count('queued') + count('failed') + (emails?.n || 0),
    filed: { coi: count('filed', 'coi'), w9: count('filed', 'w9'), vendors: vendors?.n || 0 },
    unmatched: count('unmatched'), own: count('own'), givenUp: count('given-up'),
  };
}
