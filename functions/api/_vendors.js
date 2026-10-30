/**
 * Vendors: W-9s and insurance, kept in JobTread
 * ===========================================================================
 * JobTread is the one place a vendor's W-9 and certificate of insurance
 * (COI) live: the files on the vendor's account (folder "W-9 & Insurance",
 * tagged W-9 or COI) and these vendor fields, which the site makes when
 * they're missing:
 *   W-9                     ticked once a W-9 checks out
 *   Liability Expires       general liability's end date
 *   Workers' Comp Expires   workers' compensation's end date
 *   Documents               Current · Expiring soon · Requested · Expired ·
 *                           Missing · Needs a look, kept by the site; or
 *                           W-9 only · Not needed, a person's choice that
 *                           the site never sets or changes
 *   Insurance Check         what the last certificate showed
 * Staff can fill any of these by hand in JobTread; the site trusts them.
 *
 * Who is asked: a vendor whose bill is waiting for approval (a bill, not a
 * card purchase), approved, or held; a vendor on a purchase order for an
 * open job (so it's in before work starts); and, from 30 days before it
 * ends, anyone whose insurance JobTread has dates for. Card-only suppliers never.
 *
 * How: an email from SOARD saying exactly what's missing or out of date,
 * with the vendor's own link to their trade-partner page (vendor-docs.js,
 * ./_trade-partners.js). Each
 * file is read there and then (./_vendor-read.js) and judged against SOARD's
 * minimums (DEFAULTS), so the vendor knows at once.
 * A good one goes into JobTread and fills the fields; a W-9 also goes onto
 * the vendor's Mercury recipient, which files the 1099s. A file nobody could
 * read (or one the vendor sends anyway) goes into JobTread as "Needs a look"
 * and the Finance channel hears once. Reminders follow after 3 and 7 days.
 * Every email is noted on the vendor in JobTread, and an insurance agent's
 * contact never gets a vendor's link (an agent's link adds a certificate only).
 *
 * The stop is in ./_bill-pay.js: an approved bill for a vendor whose W-9 or
 * insurance isn't current is held, says so on the bill in JobTread, and
 * pays itself once the documents check out (releaseVendorHolds, from here).
 * While Ramp still pays bills, ./_ramp.js holds them in Ramp the same way.
 *
 * The site keeps no copy of the documents. D1 holds only the work: links
 * (vendor_links, SHA-256 of each token), who was asked when (vendor_asks),
 * and a cache of JobTread vendors and the open jobs they're on (vendors:
 * jt_id and facts.jobs, which ./_vendor-access.js reads too).
 */

import { pave, SOARD_ORG_ID, TZ } from './_reveals.js';
import { slackIssue, slackResolved, sendEmails, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { emailShell, paragraphs, button, panel, esc } from './_email-shell.js';
import { readState, writeState, mercuryConfigured, uploadRecipientAttachment } from './_mercury.js';
import { vendorKey, dollars } from './_spend-match.js';
import { readDocument, judgeCoiReads, settleDisputes, judgeW9, documentType, requirementLines, longDate } from './_vendor-read.js';
import { releaseVendorHolds, cachedRecipients, recipientFor } from './_bill-pay.js';
import { maybeRunRamp, rampConfigured } from './_ramp.js';

export const STATE_KEY = 'vendors';
export const UPLOAD_PAGE = `${SITE_ORIGIN}/trade-partners/account/`;
export const PARTNERS_PAGE = `${SITE_ORIGIN}/trade-partners/`;
export const FOLDER = 'W-9 & Insurance';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const RUN_EVERY_MS = 15 * MIN;
const CACHE_EVERY_MS = 4 * 60 * MIN;
const RECHECK_MS = 6 * 60 * MIN;     // a vendor's JobTread fields, read again
const READS_PER_RUN = 12;
export const LINK_DAYS = 90;
export const REMIND_AFTER_DAYS = [3, 7];   // then every 7 days
export const MAX_ASKS = 5;
export const LIMITS = { fileBytes: 15 * 1024 * 1024, files: 3, uploads: 30, pages: 3, pageBytes: 4 * 1024 * 1024 };
export const DEFAULTS = { glOccurrence: 1000000, glAggregate: 2000000, workersComp: true, elEachAccident: 100000, renewDays: 30 };

export const FIELDS = {
  w9: { name: 'W-9', type: 'boolean' },
  gl: { name: 'Liability Expires', type: 'date' },
  wc: { name: 'Workers\' Comp Expires', type: 'date' },
  docs: { name: 'Documents', type: 'option' },
  check: { name: 'Insurance Check', type: 'text' },
  trades: { name: 'Trades', type: 'option', multiple: true },
  address: { name: 'Address', type: 'text' },
  license: { name: 'License', type: 'text' },
  materials: { name: 'Materials only', type: 'boolean' },
};
// What a trade partner picks from (the Trades field's options; a person can add more in JobTread)
export const TRADES = ['General contracting', 'Carpentry and framing', 'Drywall', 'Electrical', 'Plumbing', 'HVAC', 'Painting', 'Flooring', 'Tile', 'Cabinets and countertops',
  'Windows and doors', 'Roofing', 'Concrete and masonry', 'Accessibility and lifts', 'Landscaping', 'Cleaning', 'Hauling and dumpsters', 'Design', 'Materials and supplies', 'Other'];
export const DOC_STATES = ['Current', 'Expiring soon', 'Requested', 'Expired', 'Missing', 'Needs a look', 'W-9 only', 'Not needed'];
export const OVERRIDES = new Set(['W-9 only', 'Not needed']);
// The preview: a link to a sample company whose files are checked but never filed
export const PREVIEW_ID = 'preview';
const PREVIEW_VENDOR = { id: PREVIEW_ID, name: 'Your company (a preview)', email: null, w9: false, glExpires: null, wcExpires: null, docs: null, check: null, archived: false };
export const TAGS = { w9: 'W-9', coi: 'COI' };
export const LABEL = { w9: 'W-9', coi: 'Certificate of insurance' };

const isoDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const parseJson = (s, d = {}) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const norm = (s) => String(s || '').replace(/[’‘]/g, '\'').trim().toLowerCase();
export const jtVendorUrl = (id) => `https://app.jobtread.com/vendors/${id}`;
// A contact titled as their insurance agent: never sent the vendor's own link, never a sign-in
export const AGENT_TITLE = /agent|insurance/i;
const notAgent = (c) => c && !AGENT_TITLE.test(c.title || '');
export const jt = (env, q, fetchImpl) => pave(env.JOBTREAD_GRANT_KEY, q, fetchImpl);

// ─── Tables ─────────────────────────────────────────────────────────

const SCHEMA = [
  // The JobTread cache (only jt_id, name, email and facts.jobs are kept up now)
  `CREATE TABLE IF NOT EXISTS vendors (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, vkey TEXT, mercury_id TEXT, jt_id TEXT, email TEXT, email_set INTEGER DEFAULT 0,
    kind_set TEXT, corp INTEGER DEFAULT 0, coi_needed INTEGER,
    w9_source TEXT, w9_at TEXT, w9_key TEXT, w9_name TEXT,
    coi_key TEXT, coi_name TEXT, coi_expires TEXT, coi_insurer TEXT, coi_at TEXT, coi_by TEXT,
    invite_id TEXT, invite_status TEXT, invite_at TEXT, invites INTEGER DEFAULT 0,
    coi_link_at TEXT, coi_asks INTEGER DEFAULT 0,
    locked INTEGER DEFAULT 0, facts TEXT, created_at TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS vendors_jt ON vendors (jt_id)',
  `CREATE TABLE IF NOT EXISTS vendor_links (
    token_hash TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', uploads INTEGER NOT NULL DEFAULT 0, last_upload_at TEXT, by TEXT)`,
  'CREATE INDEX IF NOT EXISTS vendor_links_vendor ON vendor_links (vendor_id)',
  `CREATE TABLE IF NOT EXISTS vendor_asks (
    jt_id TEXT PRIMARY KEY, name TEXT, email TEXT, state TEXT, checked_at TEXT,
    asks INTEGER NOT NULL DEFAULT 0, asked_at TEXT, ask_why TEXT, open INTEGER NOT NULL DEFAULT 0,
    posted TEXT, mercury_w9_at TEXT, updated_at TEXT)`,
];

const _ready = new WeakSet();
export async function ensureVendorSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  // A link's scope: 'vendor' (their whole page) or 'agent' (their insurance agent: a certificate, nothing else)
  const cols = ((await DB.prepare('PRAGMA table_info(vendor_links)').all()).results || []).map((c) => c.name);
  if (!cols.includes('scope')) await DB.prepare("ALTER TABLE vendor_links ADD COLUMN scope TEXT NOT NULL DEFAULT 'vendor'").run();
  // Links from the old Vendors area (its own vendor ids) open nothing now
  await DB.prepare("UPDATE vendor_links SET status = 'replaced' WHERE status = 'open' AND vendor_id LIKE 'v\\_%' ESCAPE '\\'").run();
  _ready.add(DB);
}

const askRow = (r) => r && ({
  jtId: r.jt_id, name: r.name, email: r.email, state: parseJson(r.state, null), checkedAt: r.checked_at,
  asks: r.asks || 0, askedAt: r.asked_at, why: r.ask_why, open: !!r.open, posted: parseJson(r.posted, {}), mercuryW9At: r.mercury_w9_at,
});

export async function readAsk(DB, jtId) {
  await ensureVendorSchema(DB);
  return askRow(await DB.prepare('SELECT * FROM vendor_asks WHERE jt_id = ?').bind(jtId).first());
}

export async function readAsks(DB) {
  await ensureVendorSchema(DB);
  return new Map(((await DB.prepare('SELECT * FROM vendor_asks').all()).results || []).map((r) => [r.jt_id, askRow(r)]));
}

/** Change some of a vendor's ask row (camelCase keys) */
export async function patchAsk(DB, jtId, patch, now = Date.now()) {
  const before = (await readAsk(DB, jtId)) || { jtId, asks: 0, open: false, posted: {} };
  const a = { ...before, ...patch };
  await DB.prepare(`INSERT OR REPLACE INTO vendor_asks (jt_id, name, email, state, checked_at, asks, asked_at, ask_why, open, posted, mercury_w9_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(jtId, a.name || null, a.email || null, a.state ? JSON.stringify(a.state) : null, a.checkedAt || null, a.asks || 0, a.askedAt || null, a.why || null,
      a.open ? 1 : 0, JSON.stringify(a.posted || {}), a.mercuryW9At || null, new Date(now).toISOString()).run();
  return a;
}

// ─── The minimums ───────────────────────────────────────────────────

export async function readDocSettings(DB) {
  const st = await readState(DB, STATE_KEY);
  return { ...DEFAULTS, ...(st.docSettings || {}) };
}

export async function saveDocSettings(DB, patch) {
  const cur = await readDocSettings(DB);
  const dollarsOf = (v, name) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 100000000) throw Object.assign(new Error(`${name} should be a dollar amount`), { status: 400 });
    return n;
  };
  const next = { ...cur };
  if (patch.glOccurrence !== undefined) next.glOccurrence = dollarsOf(patch.glOccurrence, 'Each occurrence');
  if (patch.glAggregate !== undefined) next.glAggregate = dollarsOf(patch.glAggregate, 'Aggregate');
  if (patch.elEachAccident !== undefined) next.elEachAccident = dollarsOf(patch.elEachAccident, 'Employer’s liability');
  if (patch.workersComp !== undefined) next.workersComp = !!patch.workersComp;
  if (patch.renewDays !== undefined) {
    const d = Math.round(Number(patch.renewDays));
    if (!(d >= 7 && d <= 90)) throw Object.assign(new Error('Ask for the renewal 7 to 90 days ahead'), { status: 400 });
    next.renewDays = d;
  }
  await writeState(DB, STATE_KEY, { docSettings: next });
  return next;
}

// ─── JobTread: the fields and tags, made once ───────────────────────

const optionsOf = (o) => (Array.isArray(o) ? o.map((x) => (typeof x === 'string' ? x : x?.name || x?.value || '')).filter(Boolean) : []);

/** The vendor fields and file tags this needs, made when missing → { fields: { key: { id, type, multiple? } }, tags: { w9, coi }, dupes, single } */
export async function jtSetup(env, { fetchImpl = fetch, force = false } = {}) {
  const st = await readState(env.DB, STATE_KEY);
  const have = st.jt;
  if (!force && have?.fields && Object.keys(FIELDS).every((k) => have.fields[k]?.id && (!FIELDS[k].multiple || 'multiple' in have.fields[k])) && have.tags?.w9 && have.tags?.coi && have.contact) return have;
  // One setup at a time: a page reads the company and the vendor side by side, and two
  // setups at once would each make the same missing field
  if (!settingUp.has(env.DB)) settingUp.set(env.DB, makeSetup(env, fetchImpl).finally(() => settingUp.delete(env.DB)));
  return settingUp.get(env.DB);
}
const settingUp = new WeakMap();

async function makeSetup(env, fetchImpl) {
  const d = await jt(env, {
    organization: {
      $: { id: SOARD_ORG_ID },
      customFields: { $: { size: 100, where: ['targetType', '=', 'vendor'] }, nodes: { id: {}, name: {}, type: {}, options: {}, maxValuesAllowed: {} } },
      contactFields: { _: 'customFields', $: { size: 50, where: ['targetType', '=', 'vendorContact'] }, nodes: { id: {}, name: {}, type: {} } },
      fileTags: { $: { size: 100 }, nodes: { id: {}, name: {} } },
    },
  }, fetchImpl);
  const existing = d?.organization?.customFields?.nodes || [];
  const fields = {};
  // Two vendor fields with one of these names: the first is the one used; a person deletes the other in JobTread
  const dupes = Object.values(FIELDS).map((f) => f.name).filter((name) => existing.filter((x) => norm(x.name) === norm(name)).length > 1);
  for (const [k, f] of Object.entries(FIELDS)) {
    const found = existing.find((x) => norm(x.name) === norm(f.name));
    if (found) {
      fields[k] = { id: found.id, type: found.type || f.type };
      const want = k === 'docs' ? DOC_STATES : k === 'trades' ? TRADES : null;
      if (want && found.type === 'option') {
        const opts = optionsOf(found.options);
        const missing = want.filter((s) => !opts.some((o) => norm(o) === norm(s)));
        if (missing.length) await jt(env, { updateCustomField: { $: { id: found.id, options: [...opts, ...missing] } } }, fetchImpl);
      }
      if (f.multiple) {
        // Trades takes as many as a company does (an empty maxValuesAllowed is JobTread's "any number").
        // If JobTread won't open it up, partners' first trade still lands and the admin says so
        fields[k].multiple = true;
        if (found.maxValuesAllowed != null) {
          await jt(env, { updateCustomField: { $: { id: found.id, maxValuesAllowed: null } } }, fetchImpl)
            .catch((e) => { console.error('[vendors] widening', f.name, e.message); fields[k].multiple = false; });
        }
      }
      continue;
    }
    const made = await jt(env, {
      createCustomField: {
        $: {
          organizationId: SOARD_ORG_ID, targetType: 'vendor', type: f.type, name: f.name, minValuesRequired: 0,
          ...(f.type === 'option' ? { maxValuesAllowed: f.multiple ? null : 1 } : {}), ...(k === 'docs' ? { options: DOC_STATES } : {}), ...(k === 'trades' ? { options: TRADES } : {}),
        },
        createdCustomField: { id: {} },
      },
    }, fetchImpl);
    const id = made?.createCustomField?.createdCustomField?.id;
    if (!id) throw new Error(`JobTread didn’t make the vendor field “${f.name}”`);
    fields[k] = { id, type: f.type, ...(f.multiple ? { multiple: true } : {}) };
  }
  const tagNodes = d?.organization?.fileTags?.nodes || [];
  const tags = {};
  for (const [k, name] of Object.entries(TAGS)) {
    const found = tagNodes.find((t) => norm(t.name) === norm(name));
    if (found) { tags[k] = found.id; continue; }
    const made = await jt(env, { createFileTag: { $: { organizationId: SOARD_ORG_ID, name, color: k === 'w9' ? '#2B6CB0' : '#2F7D4F' }, createdFileTag: { id: {} } } }, fetchImpl);
    tags[k] = made?.createFileTag?.createdFileTag?.id;
    if (!tags[k]) throw new Error(`JobTread didn’t make the file tag “${name}”`);
  }
  // A vendor contact's Email and Phone: JobTread's own when it has them, else made (a contact is still saved without them)
  const cf = d?.organization?.contactFields?.nodes || [];
  const contact = {};
  for (const [k, type, name, re] of [['email', 'emailAddress', 'Email', /e-?mail/i], ['phone', 'phoneNumber', 'Phone', /phone|cell|mobile/i]]) {
    const found = cf.find((x) => x.type === type && re.test(x.name || '')) || cf.find((x) => x.type === type) || cf.find((x) => re.test(x.name || ''));
    if (found) { contact[k] = found.id; continue; }
    const made = await jt(env, { createCustomField: { $: { organizationId: SOARD_ORG_ID, targetType: 'vendorContact', type, name, minValuesRequired: 0 }, createdCustomField: { id: {} } } }, fetchImpl)
      .catch((e) => { console.error('[vendors] contact field', name, e.message); return null; });
    contact[k] = made?.createCustomField?.createdCustomField?.id || null;
  }
  const single = Object.entries(FIELDS).filter(([k, f]) => f.multiple && fields[k].multiple === false).map(([, f]) => f.name);
  const out = { fields, tags, contact, dupes, single, at: new Date().toISOString() };
  await writeState(env.DB, STATE_KEY, { jt: out, setupError: null });
  return out;
}

// ─── JobTread: one vendor ───────────────────────────────────────────

const yes = (v) => v === true || /^(true|yes|y|1)$/i.test(String(v ?? '').trim());
const dateOf = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);
// ─── JobTread: a vendor contact's email and phone ───────────────────
// A vendor's contacts have fields of their own in JobTread (target 'vendorContact'), apart from a
// family's ('customerContact', ./_applicant-comms.js), which JobTread refuses on a vendor's contact.
// Reading takes the contact's value that is an email address, whatever field holds it; writing uses
// the vendor contact's own Email and Phone (jtSetup → contact).
export const CONTACT_VALUES = { $: { size: 10 }, nodes: { value: {}, customField: { id: {}, type: {} } } };
const valuesOf = (c) => c?.customFieldValues?.nodes || [];
export function contactEmail(c) {
  const n = valuesOf(c);
  const v = (n.find((x) => x.customField?.type === 'emailAddress' && isEmail(x.value)) || n.find((x) => isEmail(x.value)))?.value;
  return v ? String(v).trim().toLowerCase() : null;
}
export const contactPhone = (c, ids) => valuesOf(c).find((x) => (ids?.contact?.phone && x.customField?.id === ids.contact.phone) || x.customField?.type === 'phoneNumber')?.value || null;
/** A vendor contact's customFieldValues to write */
export const contactFields = (ids, { email, phone } = {}) => ({
  ...(email && ids?.contact?.email ? { [ids.contact.email]: email } : {}), ...(phone && ids?.contact?.phone ? { [ids.contact.phone]: phone } : {}),
});

/** A vendor's W-9 and insurance as JobTread has them now → { id, name, email, w9, glExpires, wcExpires, docs, check, archived } or null */
export async function readJtVendor(env, jtId, { fetchImpl = fetch } = {}) {
  if (jtId === PREVIEW_ID) return { ...PREVIEW_VENDOR };
  const ids = await jtSetup(env, { fetchImpl });
  const d = await jt(env, {
    account: {
      $: { id: jtId },
      id: {}, name: {}, type: {}, archivedAt: {},
      customFieldValues: { $: { size: 25 }, nodes: { value: {}, customField: { id: {} } } },
      primaryContact: { id: {}, title: {}, customFieldValues: CONTACT_VALUES },
      contacts: { $: { size: 8 }, nodes: { id: {}, title: {}, customFieldValues: CONTACT_VALUES } },
    },
  }, fetchImpl);
  const a = d?.account;
  if (!a?.id) return null;
  const val = (k) => (a.customFieldValues?.nodes || []).find((n) => n.customField?.id === ids.fields[k].id)?.value ?? null;
  const email = [a.primaryContact, ...(a.contacts?.nodes || [])].filter(notAgent).map(contactEmail).find(Boolean) || null;
  return {
    id: a.id, name: a.name, archived: !!a.archivedAt, email: email ? email.toLowerCase() : null,
    w9: yes(val('w9')), glExpires: dateOf(val('gl')), wcExpires: dateOf(val('wc')), docs: val('docs') || null, check: val('check') || null,
  };
}

/** Write some of a vendor's fields ({ w9, gl, wc, docs, check }) */
export async function writeFields(env, ids, jtId, patch, fetchImpl = fetch) {
  const values = {};
  for (const [k, v] of Object.entries(patch)) {
    const f = ids.fields[k];
    if (!f || v === undefined) continue;
    values[f.id] = k === 'w9' && f.type !== 'boolean' ? (v ? 'Yes' : 'No') : v;
  }
  if (!Object.keys(values).length) return;
  await jt(env, { updateAccount: { $: { id: jtId, customFieldValues: values } } }, fetchImpl);
}

/** An internal note on the vendor's account, for the record */
export async function vendorNote(env, jtId, name, message, fetchImpl = fetch) {
  await jt(env, {
    createComment: {
      $: { targetType: 'account', targetId: jtId, name, message: message.slice(0, 4000), isVisibleToAll: false, isVisibleToInternalRoles: true, isVisibleToVendorRoles: false, isVisibleToCustomerRoles: false },
      createdComment: { id: {} },
    },
  }, fetchImpl).catch((e) => console.error('[vendors] note', e.message));
}

export async function uploadToJt(env, { bytes, type }, fetchImpl = fetch) {
  const up = await jt(env, { createUploadRequest: { $: { organizationId: SOARD_ORG_ID, size: bytes.byteLength, type }, createdUploadRequest: { id: {}, url: {}, method: {}, headers: {} } } }, fetchImpl);
  const req = up?.createUploadRequest?.createdUploadRequest;
  if (!req?.id || !req?.url) throw new Error('JobTread didn’t give an upload slot');
  const put = await fetchImpl(req.url, { method: req.method || 'PUT', headers: req.headers || {}, body: bytes });
  if (!put.ok) throw new Error(`JobTread’s upload returned ${put.status}`);
  return req.id;
}

// ─── What a vendor needs (pure) ─────────────────────────────────────

/**
 * Where a vendor stands against the minimums. v: readJtVendor's answer.
 * → { ok, expiring, w9, gl, wc ('current'|'expiring'|'expired'|'missing'|'not-needed'),
 *     items: [{ doc, text (to the vendor), staff (to SOARD) }], needs: ['w9'|'coi'], label,
 *     staff ("no W-9, liability ended Sep 30"), send ("a W-9 and a current certificate of insurance"),
 *     detail ("liability ended Sep 30") }
 */
const sendOf = (docs) => [docs.includes('w9') ? 'a W-9' : null, docs.includes('coi') ? 'a current certificate of insurance' : null].filter(Boolean).join(' and ');

export function docsState(v, req = DEFAULTS, { now = Date.now() } = {}) {
  const today = isoDay(now);
  const soon = isoDay(now + (req.renewDays || 30) * DAY);
  const override = OVERRIDES.has(v.docs) ? v.docs : null;
  const dateState = (d) => (!d ? 'missing' : d < today ? 'expired' : d <= soon ? 'expiring' : 'current');
  const w9 = override === 'Not needed' ? 'not-needed' : v.w9 ? 'current' : 'missing';
  const coiNeeded = !override;
  const gl = coiNeeded ? dateState(v.glExpires) : 'not-needed';
  const wc = coiNeeded && req.workersComp ? dateState(v.wcExpires) : 'not-needed';
  const items = [];
  if (w9 === 'missing') items.push({ doc: 'w9', text: 'A W-9: we don’t have one for you yet.', staff: 'no W-9' });
  const line = (s, d, what) => {
    if (s === 'missing') items.push({ doc: 'coi', text: `Proof of your ${what}: it isn’t on a certificate we have.`, staff: `no ${what}` });
    if (s === 'expired') items.push({ doc: 'coi', text: `Your renewed ${what}: the one we have ended ${longDate(d)}.`, staff: `${what} ended ${longDate(d)}` });
    if (s === 'expiring') items.push({ doc: 'coi', text: `Your renewed ${what}: the one we have ends ${longDate(d)}.`, staff: `${what} ends ${longDate(d)}`, soon: true });
  };
  line(gl, v.glExpires, 'general liability insurance');
  line(wc, v.wcExpires, 'workers’ compensation insurance');
  const bad = (s) => s === 'missing' || s === 'expired';
  const ok = ![w9, gl, wc].some(bad);
  const expiring = [gl, wc].includes('expiring');
  const label = override || (ok ? (expiring ? 'Expiring soon' : 'Current') : [w9, gl, wc].includes('missing') ? 'Missing' : 'Expired');
  return {
    ok, expiring, w9, gl, wc, items, override,
    needs: [...new Set(items.map((i) => i.doc))],
    label,
    staff: items.filter((i) => !i.soon || ok).map((i) => i.staff).join(', '),
    send: sendOf(items.filter((i) => !i.soon || ok).map((i) => i.doc)),
    // What "send" leaves out: which insurance, and when it ended
    detail: items.filter((i) => i.doc === 'coi' && (!i.soon || ok)).map((i) => i.staff).join(', '),
  };
}

/** What the Documents field should say (null: leave a person's choice alone) */
export function labelFor(v, state, ask) {
  if (OVERRIDES.has(v.docs)) return null;
  if (!state.ok || state.expiring) {
    if (v.docs === 'Needs a look') return 'Needs a look';
    if (ask?.open) return 'Requested';
  }
  return state.label;
}

// ─── Links ──────────────────────────────────────────────────────────

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const hashToken = async (t) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(t))));
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A new link to the vendor's page (earlier ones keep working until they expire) → { token, url, expiresAt }.
 * scope 'agent': their insurance agent's link, which can add a certificate and nothing else.
 */
export async function createLink(DB, jtId, { by = 'auto', now = Date.now(), scope = 'vendor', step = '' } = {}) {
  await ensureVendorSchema(DB);
  const token = newToken();
  const expiresAt = new Date(now + LINK_DAYS * DAY).toISOString();
  await DB.prepare('INSERT INTO vendor_links (token_hash, vendor_id, created_at, expires_at, by, scope) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await hashToken(token), jtId, new Date(now).toISOString(), expiresAt, by, scope === 'agent' ? 'agent' : 'vendor').run();
  return { token, url: `${UPLOAD_PAGE}#t=${token}${step ? `&step=${encodeURIComponent(step)}` : ''}`, expiresAt };
}

/** The link behind a token → { link, problem: null | 'unknown' | 'expired' | 'closed' } (link.vendor_id is the JobTread vendor) */
export async function findLink(DB, token, now = Date.now()) {
  await ensureVendorSchema(DB);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return { link: null, problem: 'unknown' };
  const link = await DB.prepare('SELECT * FROM vendor_links WHERE token_hash = ?').bind(await hashToken(token)).first();
  if (!link) return { link: null, problem: 'unknown' };
  if (link.status !== 'open') return { link, problem: 'closed' };
  if (Date.parse(link.expires_at) < now) return { link, problem: 'expired' };
  return { link, problem: null };
}

// ─── The email to a vendor ──────────────────────────────────────────

const whatOf = (needs) => (needs.includes('w9') && needs.includes('coi') ? 'W-9 and certificate of insurance' : needs.includes('w9') ? 'W-9' : 'certificate of insurance');

/** The request: what's missing, why, and their link → { subject, html, text } */
export function requestEmail({ vendorName, url, state, req = DEFAULTS, bill = null, reminder = false }) {
  const what = whatOf(state.needs);
  const renewing = state.ok && state.expiring;
  const subject = bill ? `Your payment from Sunshine on a Ranney Day is waiting on your ${what}`
    : renewing ? 'Your renewed certificate of insurance for Sunshine on a Ranney Day'
    : `${reminder ? 'A reminder: your' : 'Your'} ${what} for Sunshine on a Ranney Day`;
  const lead = bill
    ? `Thank you for your work with us. Your invoice${bill.number ? ` #${bill.number}` : ''} for ${dollars(bill.cents)} is approved, and we’ll pay it as soon as we have a current ${what} for ${vendorName} on file.`
    : renewing ? `Thank you for working with us. The insurance we have on file for ${vendorName} ends soon, so we need the renewed certificate to keep paying you without a pause.`
    : `Thank you for working with us. We keep a W-9 and a current certificate of insurance on file for every company we pay, and we’re missing something for ${vendorName}.`;
  const items = state.items.filter((i) => !i.soon || renewing).map((i) => i.text);
  const needsLines = state.needs.includes('coi') ? requirementLines(req) : [];
  const how = 'It takes a minute: open your page, add each file (a PDF or a clear photo), and it’s checked right there, so you’ll know straight away if anything else is needed.';
  const list = (rows) => `<ul style="margin:0 0 14px;padding-left:20px;">${rows.map((r) => `<li class="ink" style="margin:0 0 6px;">${esc(r)}</li>`).join('')}</ul>`;
  const html = emailShell({
    preheader: `Upload your ${what} in a minute`,
    heading: bill ? 'Your payment is ready to go' : renewing ? 'Your renewed insurance certificate' : `Your ${what}`,
    bodyHtml: `${paragraphs(lead)}${paragraphs('What we need:')}${list(items)}`
      + (needsLines.length ? panel(`${paragraphs('The certificate needs to show:', 'font-weight:700;margin-bottom:8px;')}${list(needsLines)}`, { accent: true }) : '')
      + `${paragraphs(how)}${button('Upload your documents', url)}`
      + paragraphs(`The link is for ${vendorName} only. Any time after, sign in at ${PARTNERS_PAGE.replace('https://', '')} with this email address. Questions? Just reply to this email.`, 'font-size:14px;'),
  });
  const text = [lead, '', 'What we need:', ...items.map((i) => `- ${i}`), '',
    ...(needsLines.length ? ['The certificate needs to show:', ...needsLines.map((l) => `- ${l}`), ''] : []),
    how, '', `Upload them here: ${url}`, '', `The link is for ${vendorName} only. Any time after, sign in at ${PARTNERS_PAGE.replace('https://', '')} with this email address. Questions? Just reply to this email.`].join('\n');
  return { subject, html, text };
}

/**
 * Email one vendor their link now. v: readJtVendor; state: docsState.
 * → { ok, url } | { ok: false, noEmail } ; throws when the email doesn't go
 */
export async function askVendor(env, v, state, { why = 'missing', bill = null, now = Date.now(), to = null, preview = false, fetchImpl = fetch } = {}) {
  const address = to || v.email;
  if (!isEmail(address)) return { ok: false, noEmail: true };
  const before = preview ? null : await readAsk(env.DB, v.id);
  const link = await createLink(env.DB, v.id, { by: preview ? 'preview' : 'auto', now });
  const req = await readDocSettings(env.DB);
  const mail = requestEmail({ vendorName: v.name, url: link.url, state, req, bill, reminder: !!before?.open && (before?.asks || 0) > 0 && !bill });
  const r = await sendEmails(env, { to: [address], subject: preview ? `Preview: ${mail.subject}` : mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'type', value: 'vendor-documents' }] });
  if (!r.sent) throw new Error(r.errors[0] || 'The email didn’t send');
  if (!preview) {
    await patchAsk(env.DB, v.id, { name: v.name, email: address, asks: (before?.asks || 0) + 1, askedAt: new Date(now).toISOString(), why, open: true }, now);
    const again = (before?.asks || 0) > 0 && !!before?.open;
    const renewing = state.ok && state.expiring;
    await vendorNote(env, v.id, bill ? 'Emailed: a payment is waiting on documents' : renewing ? 'Emailed for the renewed insurance' : again ? 'Emailed again for documents' : 'Emailed for documents',
      `SOARD emailed ${address} on ${longDate(isoDay(now))}${again ? ' again' : ''} for ${whatOf(state.needs)} (${state.items.map((i) => i.staff).join(', ')})${bill ? `. Invoice${bill.number ? ` #${bill.number}` : ''} for ${dollars(bill.cents)} is approved and waits on it` : ''}. The email has their link to the trade-partner page.`, fetchImpl);
  }
  return { ok: true, url: link.url };
}

/** The request a vendor gets, to a staff member, with a link to the sample company → { url } */
export async function sendPreview(env, to, { now = Date.now() } = {}) {
  const state = docsState(PREVIEW_VENDOR, await readDocSettings(env.DB), { now });
  const r = await askVendor(env, PREVIEW_VENDOR, state, { to, preview: true, now });
  if (!r.ok) throw Object.assign(new Error('There’s no email to send it to'), { status: 400 });
  return { url: r.url };
}

/** When the next reminder is due for an open ask */
export function askDue(ask, now = Date.now()) {
  if (!ask?.open || !ask.askedAt) return true;
  if ((ask.asks || 0) >= MAX_ASKS) return false;
  const wait = REMIND_AFTER_DAYS[Math.min((ask.asks || 1) - 1, REMIND_AFTER_DAYS.length - 1)] ?? 7;
  return now - Date.parse(ask.askedAt) >= wait * DAY;
}

// ─── Slack: only what needs a person ────────────────────────────────

export async function postOnce(env, jtId, key, card, title, now = Date.now()) {
  const a = await readAsk(env.DB, jtId);
  if (a?.posted?.[key]) return;
  const r = await slackIssue(env, `vendor:${key}:${jtId}`, card, { title, kind: 'attention', area: 'finance' }).catch(() => null);
  if (r?.ok) await patchAsk(env.DB, jtId, { posted: { ...(a?.posted || {}), [key]: new Date(now).toISOString() } }, now);
}

export async function resolveAll(env, jtId, summary, now = Date.now()) {
  const a = await readAsk(env.DB, jtId);
  const keys = Object.keys(a?.posted || {});
  if (!keys.length) return;
  for (const key of keys) {
    await slackResolved(env, `vendor:${key}:${jtId}`, slackCard({ icon: '✅', title: `${a.name || 'The vendor'}: documents sorted` }), { summary }).catch(() => null);
  }
  await patchAsk(env.DB, jtId, { posted: {} }, now);
}

// ─── A file from the vendor's page ──────────────────────────────────

const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Check what a vendor uploaded and, when it's good (or nobody could read
 * it, or they send it anyway for a person), file it in JobTread.
 * doc 'w9' | 'coi'; files: File/Blob list; pages: per file, its first pages as pictures the
 * vendor's browser drew (PDFs only; read, never filed); anyway: send it in despite the check.
 * → { accepted, look, problems, lines, needs (still wanted), done } ; throws Error with .status
 */
export async function fileUpload(env, link, { doc, files, pages = [], anyway = false }, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!['w9', 'coi'].includes(doc)) throw Object.assign(new Error('Pick the W-9 or the certificate.'), { status: 400 });
  // An insurance agent's link adds a certificate and nothing else
  if (link.scope === 'agent' && doc !== 'coi') throw Object.assign(new Error('This link is for the certificate of insurance only.'), { status: 403 });
  const isBlob = (f) => f && typeof f === 'object' && f.size > 0;
  const list = (files || []).map((f, i) => ({ f, pics: pages[i] || [] })).filter(({ f }) => isBlob(f)).slice(0, doc === 'w9' ? 1 : LIMITS.files);
  if (!list.length) throw Object.assign(new Error('Choose the file first.'), { status: 400 });
  const parts = [];
  for (const { f, pics } of list) {
    if (f.size > LIMITS.fileBytes) throw Object.assign(new Error(`${f.name || 'That file'} is over 15 MB. Try a smaller copy or a PDF.`), { status: 413 });
    const bytes = new Uint8Array(await f.arrayBuffer());
    const type = documentType(bytes.slice(0, 16));
    // The page turns HEIC into a JPG where the browser can; one that still comes would only land on a person
    if (type === 'image/heic') throw Object.assign(new Error(`${f.name || 'That photo'} is an iPhone photo (HEIC), which we can’t read. Send a PDF or a JPG instead. A screenshot of the photo works too.`), { status: 400 });
    if (!type) throw Object.assign(new Error('The file should be a PDF or a photo (JPG or PNG).'), { status: 400 });
    // A picture that isn't one, or is too big, is left out: the PDF's own text is read instead
    const drawn = [];
    for (const p of type === 'application/pdf' ? pics.filter(isBlob).slice(0, LIMITS.pages) : []) {
      if (p.size > LIMITS.pageBytes) continue;
      const b = new Uint8Array(await p.arrayBuffer());
      if (documentType(b.slice(0, 16)) === 'image/jpeg') drawn.push({ bytes: b, type: 'image/jpeg' });
    }
    parts.push({ bytes, type, name: String(f.name || '').slice(0, 120), pages: drawn });
  }
  const v = await readJtVendor(env, link.vendor_id, { fetchImpl });
  if (!v || v.archived) throw Object.assign(new Error('This link is for a company we no longer have on file. Reply to our email and we’ll sort it out.'), { status: 410 });
  const req = await readDocSettings(env.DB);

  let verdict;
  if (anyway) verdict = { accepted: false, anyway: true, lines: [], problems: [] };
  else {
    const reads = await Promise.all(parts.map((p) => readDocument(env, doc, p)));
    verdict = doc === 'w9' ? judgeW9(reads[0].pictures, { vendorName: v.name }) : judgeCoiReads(reads, req, { vendorName: v.name, now });
    // The two readings split on a number: it's asked once more, on its own, before a person has to
    if (verdict.unsure) {
      const pictures = parts.map((p) => (p.type === 'application/pdf' ? p.pages : [p]));
      verdict = judgeCoiReads(await settleDisputes(env, reads, pictures), req, { vendorName: v.name, now });
    }
  }
  await env.DB.prepare('UPDATE vendor_links SET uploads = uploads + 1, last_upload_at = ? WHERE token_hash = ?').bind(new Date(now).toISOString(), link.token_hash).run();
  // A readable file that falls short goes back to the vendor, not into JobTread
  if (!verdict.unreadable && !verdict.anyway && !verdict.accepted) return { accepted: false, look: false, problems: verdict.problems, lines: verdict.lines || [] };
  if (v.id === PREVIEW_ID) {
    const left = docsState({ ...v, ...(verdict.accepted && doc === 'w9' ? { w9: true } : {}), ...(verdict.accepted && doc === 'coi' ? { glExpires: verdict.gl?.expires, wcExpires: verdict.wc?.expires } : {}) }, req, { now });
    return { accepted: !!verdict.accepted, look: !verdict.accepted, problems: verdict.problems || [], lines: verdict.lines || [], needs: left.needs.filter((d) => d !== doc), done: false, preview: true };
  }

  const look = !verdict.accepted;
  const ids = await jtSetup(env, { fetchImpl });
  const day = isoDay(now);
  for (const [i, p] of parts.entries()) {
    const uploadRequestId = await uploadToJt(env, p, fetchImpl);
    const name = `${TAGS[doc]} ${v.name} ${day}${parts.length > 1 ? ` (${i + 1})` : ''}.${EXT[p.type]}`;
    await jt(env, { createFile: { $: { name, targetType: 'account', targetId: v.id, uploadRequestId, folder: FOLDER, fileTagIds: [ids.tags[doc]] }, createdFile: { id: {} } } }, fetchImpl);
  }
  const after = { ...v };
  const patch = {};
  if (verdict.accepted && doc === 'w9') { patch.w9 = true; after.w9 = true; }
  if (verdict.accepted && doc === 'coi') {
    if (verdict.gl) { patch.gl = verdict.gl.expires; after.glExpires = verdict.gl.expires; }
    if (verdict.wc) { patch.wc = verdict.wc.expires; after.wcExpires = verdict.wc.expires; }
    patch.check = `${verdict.summary} · read ${day}`.slice(0, 250);
  }
  if (look && !OVERRIDES.has(v.docs)) { patch.docs = 'Needs a look'; after.docs = 'Needs a look'; }
  const ask = await readAsk(env.DB, v.id);
  const state = docsState(after, req, { now });
  if (!look && !OVERRIDES.has(v.docs)) {
    // A good file clears "Needs a look" once nothing else is missing
    const label = state.ok ? state.label : v.docs === 'Needs a look' ? 'Needs a look' : ask?.open ? 'Requested' : state.label;
    if (label !== v.docs) patch.docs = label;
  }
  await writeFields(env, ids, v.id, patch, fetchImpl);
  if (verdict.accepted && doc === 'coi') await import('./_coi-backfill.js').then((b) => b.recordUpload(env, { jtId: v.id, insured: v.name, verdict, parts, now })).catch((e) => console.error('[vendors] coverage', e.message));
  const from = link.scope === 'agent' ? `${LABEL[doc]} from ${v.name}’s insurance agent` : `${LABEL[doc]} from ${v.name}`;
  await vendorNote(env, v.id, from, look
    ? `${LABEL[doc]} received through SOARD’s page on ${longDate(day)}. ${verdict.anyway ? 'The vendor sent it anyway after the check didn’t pass' : verdict.unsure ? `The automatic check read it two ways that didn’t agree (${verdict.unsure})` : 'It couldn’t be read automatically'}, so a person needs to open it (folder ${FOLDER}) and fill in ${doc === 'w9' ? 'W-9' : 'Liability Expires and Workers’ Comp Expires'} on this vendor.`
    : `${LABEL[doc]} received through SOARD’s page on ${longDate(day)} and checked: ${verdict.lines.join(' ')}${verdict.notes?.length ? ` Worth a look: ${verdict.notes.join(' ')}` : ''}`, fetchImpl);

  if (look) {
    await postOnce(env, v.id, 'look', slackCard({
      icon: '🔎', title: `Check ${v.name}’s ${LABEL[doc].toLowerCase()}`,
      lead: verdict.anyway ? 'The automatic check didn’t pass, and they sent it anyway for a person to decide.' : verdict.unsure ? `It came in through their page, and the automatic check read it two ways that didn’t agree: ${verdict.unsure}` : 'It came in through their page but couldn’t be read automatically.',
      facts: [['What to do', doc === 'w9' ? 'Open it in JobTread and tick W-9 if it’s right.' : 'Open it in JobTread and fill in Liability Expires and Workers’ Comp Expires.']],
      buttons: [{ label: 'Open in JobTread', url: `${jtVendorUrl(v.id)}/files` }],
    }), `${v.name}: ${LABEL[doc]}`, now);
  }
  // A W-9 goes to Mercury too, which files the 1099s
  if (verdict.accepted && doc === 'w9') await w9ToMercury(env, v, parts[0], { now }).catch((e) => console.error('[vendors] mercury w9', e.message));
  // The trade-partner page's step, and an agent's ask, are done
  if (verdict.accepted) await import('./_trade-partners.js').then((tp) => tp.docArrived(env, v.id, doc, { now })).catch((e) => console.error('[vendors] step', e.message));

  const done = state.ok && !state.expiring;
  await patchAsk(env.DB, v.id, { name: v.name, email: v.email, state: briefState(state), checkedAt: new Date(now).toISOString(), open: !done && !!ask?.open }, now);
  if (state.ok && !look) {
    await resolveAll(env, v.id, `Their ${LABEL[doc].toLowerCase()} came in and checked out.`, now);
    await releaseVendorHolds(env, v.id, { now }).catch((e) => console.error('[vendors] release', e.message));
  }
  return { accepted: !!verdict.accepted, look, problems: verdict.problems || [], lines: verdict.lines || [], needs: state.needs, done: state.ok };
}

export const briefState = (s) => ({ ok: s.ok, expiring: s.expiring, label: s.label, staff: s.staff, needs: s.needs });

/** What the vendor's page shows → { name, needs, items, have, requirements } */
export async function pageView(env, link, { now = Date.now(), fetchImpl = fetch } = {}) {
  const v = await readJtVendor(env, link.vendor_id, { fetchImpl });
  if (!v || v.archived) return null;
  const req = await readDocSettings(env.DB);
  const state = docsState(v, req, { now });
  return {
    name: v.name,
    needs: state.needs,
    items: state.items.map((i) => ({ doc: i.doc, text: i.text })),
    have: { w9: v.w9, glExpires: v.glExpires, wcExpires: v.wcExpires },
    requirements: requirementLines(req),
    w9Only: v.docs === 'W-9 only', notNeeded: v.docs === 'Not needed',
    preview: v.id === PREVIEW_ID,
  };
}

// ─── Mercury: the W-9 for the 1099s ─────────────────────────────────

export async function w9ToMercury(env, v, file, { now = Date.now() } = {}) {
  if (!mercuryConfigured(env)) return false;
  const r = recipientFor(v.name, await cachedRecipients(env, { now }));
  if (!r) return false;
  await uploadRecipientAttachment(env, r.id, { bytes: file.bytes, fileName: `W-9 ${v.name}.${EXT[file.type] || 'pdf'}`, type: file.type });
  await patchAsk(env.DB, v.id, { mercuryW9At: new Date(now).toISOString() }, now);
  return true;
}

/**
 * Daily: a W-9 that's in JobTread (filed here or by hand) onto the vendor's
 * Mercury recipient when Mercury doesn't have one. → number copied
 */
export async function w9sToMercury(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!mercuryConfigured(env)) return 0;
  const ids = await jtSetup(env, { fetchImpl });
  const recipients = await cachedRecipients(env, { now });
  const asks = await readAsks(env.DB);
  let n = 0;
  for (const a of asks.values()) {
    if (a.mercuryW9At || n >= 5) continue;
    const r = recipientFor(a.name || '', recipients);
    if (!r || r.hasW9) continue;
    const d = await jt(env, {
      account: {
        $: { id: a.jtId },
        files: { $: { size: 10, sortBy: [{ field: 'createdAt', order: 'desc' }] }, nodes: { id: {}, name: {}, url: {}, fileTags: { $: { size: 5 }, nodes: { id: {} } } } },
      },
    }, fetchImpl).catch(() => null);
    const f = (d?.account?.files?.nodes || []).find((x) => (x.fileTags?.nodes || []).some((t) => t.id === ids.tags.w9));
    if (!f?.url) continue;
    const res = await fetchImpl(f.url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = documentType(bytes.slice(0, 16)) || 'application/pdf';
    await uploadRecipientAttachment(env, r.id, { bytes, fileName: f.name || `W-9 ${a.name}.pdf`, type });
    await patchAsk(env.DB, a.jtId, { mercuryW9At: new Date(now).toISOString() }, now);
    n++;
  }
  return n;
}

// ─── For bills (./_bill-pay.js) ─────────────────────────────────────

/** A bill's vendor, fresh from JobTread → { ok, vendor, state } (throws when JobTread doesn't answer) */
export async function billDocs(env, accountId, { now = Date.now(), fetchImpl = fetch } = {}) {
  const v = await readJtVendor(env, accountId, { fetchImpl });
  if (!v) throw new Error('JobTread has no such vendor');
  const state = docsState(v, await readDocSettings(env.DB), { now });
  const ask = await readAsk(env.DB, v.id);
  await patchAsk(env.DB, v.id, { name: v.name, email: v.email, state: briefState(state), checkedAt: new Date(now).toISOString() }, now);
  const label = labelFor(v, state, ask);
  if (label && label !== v.docs) await writeFields(env, await jtSetup(env, { fetchImpl }), v.id, { docs: label }, fetchImpl).catch(() => null);
  return { ok: state.ok, vendor: v, state };
}

/** A held bill's email to its vendor, unless they were emailed in the last day → { ok, skipped?, noEmail? } */
export async function askForBill(env, v, state, bill, { now = Date.now() } = {}) {
  const ask = await readAsk(env.DB, v.id);
  if (ask?.open && ask.askedAt && now - Date.parse(ask.askedAt) < DAY) return { ok: true, skipped: true };
  const r = await askVendor(env, v, state, { why: 'bill', bill, now });
  if (r.noEmail) await postNoEmail(env, v, now);
  if (r.ok) await writeFields(env, await jtSetup(env), v.id, OVERRIDES.has(v.docs) ? {} : { docs: 'Requested' }).catch(() => null);
  return r;
}

async function postNoEmail(env, v, now) {
  await postOnce(env, v.id, 'email', slackCard({
    icon: '✉️', title: `No email for ${v.name} in JobTread`,
    lead: 'Their W-9 or insurance is needed, and there’s no one to ask. Add an email to one of their contacts in JobTread; the request goes out within 15 minutes.',
    buttons: [{ label: 'Open in JobTread', url: jtVendorUrl(v.id) }],
  }), `${v.name}: email`, now);
}

// ─── The JobTread cache: vendors and the open jobs they're on ───────

/**
 * JobTread's vendor accounts → [{ id, name, email (the first), emails (every contact's, for signing in), archived,
 *   fields: { w9, gl, wc, docs, materials, trades } (renewals are found from these; null when the fields can't be read) }]
 */
export async function jobtreadVendors(env, { fetchImpl = fetch } = {}) {
  const ids = await jtSetup(env, { fetchImpl }).catch(() => null);
  const out = [];
  let page = null;
  for (let i = 0; i < 40; i++) {
    const data = await jt(env, {
      organization: {
        $: { id: SOARD_ORG_ID },
        accounts: {
          $: { size: 25, where: ['type', '=', 'vendor'], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, name: {}, archivedAt: {},
            customFieldValues: { $: { size: 25 }, nodes: { value: {}, customField: { id: {} } } },
            contacts: { $: { size: 10 }, nodes: { title: {}, customFieldValues: CONTACT_VALUES } },
          },
        },
      },
    }, fetchImpl);
    const conn = data?.organization?.accounts;
    for (const a of conn?.nodes || []) {
      const emails = [...new Set((a.contacts?.nodes || []).filter(notAgent).map(contactEmail).filter(Boolean))];
      const val = (k) => (a.customFieldValues?.nodes || []).find((n) => n.customField?.id === ids?.fields[k]?.id)?.value ?? null;
      const trades = val('trades');
      const fields = ids && {
        w9: yes(val('w9')), gl: dateOf(val('gl')), wc: dateOf(val('wc')), docs: val('docs') || null, materials: yes(val('materials')),
        trades: Array.isArray(trades) ? trades : trades ? String(trades).split(/\s*,\s*/).filter(Boolean) : [],
      };
      out.push({ id: a.id, name: a.name, email: emails[0] || null, emails, archived: !!a.archivedAt, fields });
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
      const data = await jt(env, {
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

/** The vendors table: one row per JobTread vendor, with the open jobs it's on → number of vendors */
export async function refreshCache(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const { cachedJobs } = await import('./_spend.js');
  const jobs = await cachedJobs(env, { now });
  const [vendors, onJobs] = [await jobtreadVendors(env, { fetchImpl }), await vendorsOnJobs(env, jobs, { fetchImpl })];
  const DB = env.DB;
  const iso = new Date(now).toISOString();
  const rows = new Map(((await DB.prepare('SELECT id, jt_id, facts FROM vendors WHERE jt_id IS NOT NULL').all()).results || []).map((r) => [r.jt_id, r]));
  const stmts = [];
  for (const v of vendors) {
    if (v.archived) continue;
    const r = rows.get(v.id);
    const facts = { ...parseJson(r?.facts), jobs: onJobs[v.id] || [], emails: v.emails || (v.email ? [v.email] : []), ...(v.fields ? { fields: v.fields, fieldsAt: iso } : {}) };
    if (r) stmts.push(DB.prepare('UPDATE vendors SET name = ?, vkey = ?, email = ?, facts = ?, updated_at = ? WHERE id = ?').bind(v.name, vendorKey(v.name), v.email, JSON.stringify(facts), iso, r.id));
    else stmts.push(DB.prepare('INSERT INTO vendors (id, name, vkey, jt_id, email, facts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(`jt_${v.id}`, v.name, vendorKey(v.name), v.id, v.email, JSON.stringify(facts), iso, iso));
  }
  // The old join's rows that were never JobTread vendors (Mercury-only, names from spending)
  stmts.push(DB.prepare('DELETE FROM vendors WHERE jt_id IS NULL'));
  for (let i = 0; i < stmts.length; i += 50) await DB.batch(stmts.slice(i, i + 50));
  return vendors.length;
}

// ─── Who needs documents now ────────────────────────────────────────

const RANK = { held: 0, bill: 1, job: 2, renewal: 3 };

/**
 * JobTread vendors that need a current W-9 and insurance now, most urgent
 * first → Map(jtId → { why: 'held'|'bill'|'job'|'renewal', bill? })
 */
export async function vendorsThatNeedDocs(DB, { now = Date.now(), req = DEFAULTS } = {}) {
  const out = new Map();
  const put = (id, why, bill = null) => {
    const cur = out.get(id);
    if (!cur || RANK[why] < RANK[cur.why]) out.set(id, { why, bill });
  };
  const since = new Date(now - 120 * DAY).toISOString();
  const bills = await DB.prepare(`SELECT b.id, b.account_id, b.cents, b.number, b.status, b.balance, b.paid, a.state, a.pay_state
      FROM spend_bills b LEFT JOIN bill_approvals a ON a.bill_id = b.id
      WHERE b.account_id IS NOT NULL AND b.charge_id IS NULL AND b.created_at >= ?`).bind(since).all().then((r) => r.results || [], () => []);
  // Bills Ramp wrote (card buys and Ramp's own bill pay) were paid by Ramp: never a reason to email, unless one comes up for approval here
  const ramp = new Set(await DB.prepare('SELECT bill_id FROM spend_recode').all().then((r) => (r.results || []).map((x) => x.bill_id), () => []));
  for (const b of bills) {
    const owed = b.balance ?? (b.cents - (b.paid || 0));
    if (b.pay_state === 'held') { put(b.account_id, 'held', { id: b.id, number: b.number, cents: owed }); continue; }
    // A bill for SOARD to approve (still pending in JobTread) or one in the approval flow and not paid yet
    const forApproval = b.status === 'pending' ? !ramp.has(b.id) : !!b.state;
    if (forApproval && owed > 0 && b.status !== 'denied' && b.state !== 'rejected' && !['requested', 'sent', 'paid'].includes(b.pay_state)) put(b.account_id, 'bill', { id: b.id, number: b.number, cents: owed });
  }
  // Bills on hold in Ramp (./_ramp.js): reminded and let go like the ones held here
  const rampHeld = await DB.prepare("SELECT account_id, jt_bill_id, invoice, cents FROM ramp_holds WHERE state = 'held' AND account_id IS NOT NULL").all().then((r) => r.results || [], () => []);
  for (const h of rampHeld) put(h.account_id, 'held', { id: h.jt_bill_id, number: h.invoice, cents: h.cents, ramp: true });
  const onJobs = await DB.prepare('SELECT jt_id, facts FROM vendors WHERE jt_id IS NOT NULL').all().then((r) => r.results || [], () => []);
  for (const r of onJobs) if ((parseJson(r.facts).jobs || []).some((j) => j.order)) put(r.jt_id, 'job');
  // Insurance JobTread has dates for, working for SOARD right now or not: asked for from 30 days before it ends, and for a month after if it lapsed
  const from = isoDay(now - 30 * DAY);
  const to = isoDay(now + (req.renewDays || 30) * DAY);
  for (const r of onJobs) {
    const f = parseJson(r.facts).fields;
    if (f && !OVERRIDES.has(f.docs) && [f.gl, f.wc].some((d) => d && d >= from && d <= to)) put(r.jt_id, 'renewal');
  }
  const asks = await DB.prepare('SELECT jt_id, state FROM vendor_asks').all().then((r) => r.results || [], () => []);
  for (const a of asks) if (parseJson(a.state, {}).expiring) put(a.jt_id, 'renewal');
  return new Map([...out.entries()].sort((x, y) => RANK[x[1].why] - RANK[y[1].why]));
}

/**
 * Read each vendor that needs documents (held bills every run, the rest
 * every few hours), keep JobTread's Documents field right, ask and remind,
 * and let held bills go. → { read, asked, released }
 */
export async function sweep(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const req = await readDocSettings(env.DB);
  const who = await vendorsThatNeedDocs(env.DB, { now, req });
  const asks = await readAsks(env.DB);
  const ids = await jtSetup(env, { fetchImpl });
  const out = { read: 0, asked: 0, released: 0 };
  for (const [jtId, w] of who) {
    const a = asks.get(jtId);
    const fresh = !a?.checkedAt || now - Date.parse(a.checkedAt) > RECHECK_MS;
    if (w.why !== 'held' && !fresh && !(a?.open && askDue(a, now))) continue;
    if (out.read >= READS_PER_RUN) break;
    out.read++;
    const v = await readJtVendor(env, jtId, { fetchImpl }).catch(() => null);
    if (!v || v.archived) continue;
    const state = docsState(v, req, { now });
    const settled = state.ok && !state.expiring;
    let ask = await patchAsk(env.DB, v.id, { name: v.name, email: v.email || a?.email || null, state: briefState(state), checkedAt: new Date(now).toISOString(), ...(settled ? { open: false } : {}) }, now);
    if (state.ok) {
      if (settled) await resolveAll(env, v.id, 'Their W-9 and insurance are current in JobTread.', now);
      out.released += await releaseVendorHolds(env, v.id, { now }).catch(() => 0);
    }
    if (!settled && w.why !== 'held') {
      // Held bills email from ./_bill-pay.js the moment they're held; reminders come from here
      if (!v.email) {
        // A renewal with no one to email still reaches their agent, when there is one; nothing else is urgent until a bill is
        if (w.why === 'renewal') await import('./_trade-partners.js').then((tp) => tp.renewalToAgent(env, v.id, state, { now, fetchImpl })).catch((e) => console.error('[vendors] agent', v.id, e.message));
        else await postNoEmail(env, v, now);
      } else if (askDue(ask, now)) {
        try {
          await askVendor(env, v, state, { why: w.why === 'renewal' && !state.ok ? 'missing' : w.why, now, fetchImpl });
          ask = await readAsk(env.DB, v.id);
          out.asked++;
          // Their insurance agent, when the trade-partner page has one, is asked for the certificate directly
          await import('./_trade-partners.js').then((tp) => tp.renewalToAgent(env, v.id, state, { now, fetchImpl })).catch((e) => console.error('[vendors] agent', v.id, e.message));
        } catch (e) { console.error('[vendors] ask', v.id, e.message); }
      }
    } else if (!settled && w.why === 'held') {
      if (!v.email) await postNoEmail(env, v, now);
      else if (askDue(ask, now)) {
        try { await askVendor(env, v, state, { why: 'bill', bill: w.bill, now, fetchImpl }); ask = await readAsk(env.DB, v.id); out.asked++; } catch (e) { console.error('[vendors] remind', v.id, e.message); }
      }
      if ((ask?.asks || 0) >= 3) {
        await postOnce(env, v.id, 'ignored', slackCard({
          icon: '⏳', title: `${v.name} hasn’t sent their documents`,
          lead: `${w.bill?.ramp ? 'A bill on hold in Ramp' : 'An approved bill'} is waiting on ${state.send || 'their documents'}${state.detail ? ` (${state.detail})` : ''}. They’ve been emailed ${ask.asks} times; a call may do it.`,
          facts: [['Waiting', w.bill ? dollars(w.bill.cents) : 'An approved bill'], ['Email', v.email || 'None in JobTread']],
          buttons: [{ label: 'Open in JobTread', url: jtVendorUrl(v.id) }],
        }), `${v.name}: documents`, now);
      }
    }
    const label = labelFor(v, state, ask);
    if (label && label !== v.docs) await writeFields(env, ids, v.id, { docs: label }, fetchImpl).catch((e) => console.error('[vendors] label', e.message));
  }
  return out;
}

// ─── The heartbeat ──────────────────────────────────────────────────

/** Every 15 minutes: JobTread's fields, the cache (4-hourly), the sweep, W-9s to Mercury (daily). Never throws. */
export async function maybeRunVendors(env, { now = Date.now(), fetchImpl = fetch, force = false } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensureVendorSchema(env.DB);
    const st = await readState(env.DB, STATE_KEY);
    if (!force && now - Date.parse(st.lastRunAt || 0) < RUN_EVERY_MS) return null;
    await writeState(env.DB, STATE_KEY, { lastRunAt: new Date(now).toISOString() });
    const report = { at: new Date(now).toISOString() };
    const errors = [];
    try { await jtSetup(env, { fetchImpl }); } catch (e) {
      await writeState(env.DB, STATE_KEY, { setupError: { at: report.at, error: String(e.message).slice(0, 300) }, lastRun: report });
      return report;
    }
    if (force || now - Date.parse(st.cacheAt || 0) > CACHE_EVERY_MS) {
      try {
        report.vendors = await refreshCache(env, { now, fetchImpl });
        await writeState(env.DB, STATE_KEY, { cacheAt: report.at });
      } catch (e) { errors.push(`JobTread vendors: ${e.message}`); }
    }
    try { Object.assign(report, await sweep(env, { now, fetchImpl })); } catch (e) { errors.push(e.message); }
    // Trade partners: unfinished setups and quiet insurance agents nudged (./_trade-partners.js)
    try { report.partners = await (await import('./_trade-partners.js')).partnerNudges(env, { now, fetchImpl }); } catch (e) { errors.push(`Trade partners: ${e.message}`); }
    // While Ramp still pays bills: held there until the vendor's papers are in (./_ramp.js keeps its own errors)
    if (rampConfigured(env)) report.ramp = await maybeRunRamp(env, { now, fetchImpl });
    if (mercuryConfigured(env) && (force || now - Date.parse(st.mercuryAt || 0) > DAY)) {
      try {
        report.toMercury = await w9sToMercury(env, { now, fetchImpl });
        await writeState(env.DB, STATE_KEY, { mercuryAt: report.at });
      } catch (e) { errors.push(`Mercury: ${e.message}`); }
    }
    await writeState(env.DB, STATE_KEY, { lastRun: report, lastError: errors.length ? { at: report.at, error: errors.join(' · ') } : null });
    return report;
  } catch (e) {
    console.error('[vendors]', e.message);
    return null;
  }
}

/** Counts for the automations map */
export async function vendorFacts(DB) {
  await ensureVendorSchema(DB);
  const st = await readState(DB, STATE_KEY);
  const rows = (await DB.prepare('SELECT open, posted FROM vendor_asks').all()).results || [];
  return {
    at: st.lastRun?.at || null, error: st.lastError || null, setupError: st.setupError || null, ready: !!st.jt?.fields,
    open: rows.filter((r) => r.open).length,
    look: rows.filter((r) => parseJson(r.posted, {}).look).length,
  };
}
