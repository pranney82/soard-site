/**
 * Vendors' W-9s and certificates, kept on the site
 * ===========================================================================
 * Peter, Nov 2 2026: "we should be storing on our site so all vendors can
 * have docs, not just job related vendors, then whatever PM or payment system
 * we are on we will have them". So the site is the record, for every company
 * SOARD pays:
 *
 *   vendor_papers   one row per company: W-9 on file, when general liability
 *                   and workers' comp end, the Documents status (Current ·
 *                   Expiring soon · Requested · Expired · Missing · Needs a
 *                   look, or a person's W-9 only · Not needed) and what the last
 *                   certificate showed. The id is the JobTread vendor
 *                   account's for a company on jobs, or 's_…' for one that's
 *                   only here (the CPA, a law firm: paid, never on a job).
 *   vendor_files    each W-9 and certificate itself, in private storage
 *                   (VENDOR_FILES: soard-vendor-docs, a bucket with no public
 *                   address; never FILES, which files.sunshineonaranneyday.com
 *                   serves to anyone), with what the check read and what the
 *                   file proved when it passed (proves). Never a tax ID.
 *
 * JobTread only shows it. A job vendor's W-9, Liability Expires, Workers' Comp
 * Expires, Documents and Insurance Check fields are written from here after
 * every change (jt_sent remembers what was written), and a field someone
 * changes by hand in JobTread is taken in at the next read, so nothing a
 * person does there is undone (settlePapers). Mercury gets nothing.
 *
 * Files come from the company's own page and their agent's link
 * (./_vendors.js fileUpload), a W-9 signed online (./_trade-partners.js), the
 * certificate search (./_coi-backfill.js), staff in Job Costs → W-9s &
 * insurance (./vendor-papers-admin.js), and the files in JobTread's "W-9 &
 * Insurance" folders (importJobTread, from the heartbeat: copied here, checked
 * byte for byte, then deleted from JobTread, as Peter chose on Nov 2 2026, and
 * looked for again every few hours in case someone files one there by hand).
 * Companies paid outside JobTread are found in Mercury's payees and Ramp's
 * bills (findPayees) and kept as W-9 only.
 */

import { SOARD_ORG_ID, TZ, pave } from './_reveals.js';
import { readState, writeState } from './_mercury.js';

export const STATE_KEY = 'vendor-papers';
export const PREFIX = 'vendor-docs/';
export const FOLDER = 'W-9 & Insurance';
export const FIELD_KEYS = ['w9', 'gl', 'wc', 'docs', 'check'];
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const SOURCES = {
  page: 'their page', agent: 'their insurance agent', signed: 'signed on their page', email: 'a staff email', jobtread: 'JobTread',
  ramp: 'Ramp', staff: 'added by staff', search: 'the certificate search',
};

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const IMPORT_FILES_PER_RUN = 8;
const IMPORT_MS = 8000;
const PASS_EVERY_MS = 6 * 60 * MIN;     // a finished pass over JobTread's vendors starts again after this
const PAYEES_EVERY_MS = DAY;
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

/**
 * Where the files live: their own bucket and nowhere else. A W-9 has a tax ID on it, and FILES (soard-files) is served
 * to anyone at files.sunshineonaranneyday.com, so without VENDOR_FILES nothing is kept at all.
 */
export const vendorBucket = (env) => env?.VENDOR_FILES || null;
/** A company only the site knows (no JobTread vendor account) */
export const isSiteVendor = (id) => /^s_[a-z0-9]{10,}$/.test(String(id || ''));
const isoDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const parseJson = (s, d = {}) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const clean = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
const randomId = (n = 20) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const yes = (v) => v === true || /^(true|yes|y|1)$/i.test(String(v ?? '').trim());
const dateOf = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);

/**
 * A company's name as one key, to know the same company again: accents, case, punctuation, "&"/"and" and a
 * trailing Inc/LLC/Co aside, and initials run together ("A.B.C. Roofing" = "ABC Roofing"). Numbers stay
 * ("84 Lumber" isn't "Lumber Co"); every other word counts ("Studio 9 Design" isn't "Studio 7 Design").
 */
export function nameKeyOf(name) {
  let s = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // Letters of any script count (a name in Japanese or Arabic is still a name), punctuation doesn't
  s = s.replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (let i = 0; i < 6 && /\b([a-z0-9]) ([a-z0-9])\b/.test(s); i++) s = s.replace(/\b([a-z0-9]) (?=[a-z0-9]\b)/g, '$1');
  for (let i = 0; i < 3; i++) {
    const t = s.replace(/\s+(inc|incorporated|llc|llp|lp|ltd|limited|co|corp|corporation|company|pllc|pc|pa)$/, '').trim();
    if (t === s || !t) break;
    s = t;
  }
  return s.replace(/^the\s+/, '');
}

const realDate = (d) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return false; const t = new Date(`${d}T12:00:00Z`); return !Number.isNaN(t) && t.toISOString().slice(0, 10) === d; };
export { realDate };

/** A field's value the one way it's compared: W-9 yes/no, a date, or text (empty is nothing) */
export function fieldValue(k, v) {
  if (k === 'w9') return yes(v);
  if (k === 'gl' || k === 'wc') return dateOf(v);
  const s = clean(v, 250);
  return s || null;
}
const same = (k, a, b) => fieldValue(k, a) === fieldValue(k, b);

// ─── Tables ─────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vendor_papers (
    id TEXT PRIMARY KEY, name TEXT, vkey TEXT, email TEXT, archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT,
    w9 INTEGER NOT NULL DEFAULT 0, gl TEXT, wc TEXT, docs TEXT, docs_by TEXT, hand TEXT, check_text TEXT,
    jt_sent TEXT, payee TEXT, note TEXT, by TEXT, created_at TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS vendor_papers_vkey ON vendor_papers (vkey)',
  `CREATE TABLE IF NOT EXISTS vendor_files (
    id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, doc TEXT NOT NULL, name TEXT, type TEXT, size INTEGER, hash TEXT NOT NULL,
    r2_key TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT, received_at TEXT, added_at TEXT NOT NULL, added_by TEXT,
    status TEXT NOT NULL, prior TEXT, summary TEXT, reading TEXT, proves TEXT)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS vendor_files_hash ON vendor_files (vendor_id, hash)',
  'CREATE INDEX IF NOT EXISTS vendor_files_vendor ON vendor_files (vendor_id, added_at)',
  'CREATE INDEX IF NOT EXISTS vendor_files_ref ON vendor_files (source_ref)',
  // JobTread's copies taken out once the site's was checked against them (importJobTread)
  'CREATE TABLE IF NOT EXISTS vendor_jt_removed (jt_file_id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, file_id TEXT, name TEXT, removed_at TEXT NOT NULL)',
];
const _ready = new WeakSet();
export async function ensurePapersSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  for (const [table, col] of [['vendor_papers', 'archived_at'], ['vendor_papers', 'docs_by'], ['vendor_papers', 'hand'], ['vendor_files', 'prior'], ['vendor_files', 'proves']]) {
    try { await DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`).run(); } catch { /* already there */ }
  }
  _ready.add(DB);
}

const papersRow = (r) => r && ({
  id: r.id, name: r.name || '', email: r.email || null, archived: !!r.archived, archivedAt: r.archived_at || null,
  w9: !!r.w9, glExpires: r.gl || null, wcExpires: r.wc || null, docs: r.docs || null, docsBy: r.docs_by || null, hand: parseJson(r.hand, null), check: r.check_text || null,
  jtSent: parseJson(r.jt_sent, null), payee: parseJson(r.payee, null), note: r.note || null, by: r.by || null,
  createdAt: r.created_at, updatedAt: r.updated_at, site: isSiteVendor(r.id),
});
/** The values in the field keys (w9, gl, wc, docs, check) */
const valuesOf = (p) => ({ w9: !!p.w9, gl: p.glExpires || null, wc: p.wcExpires || null, docs: p.docs || null, check: p.check || null });

export async function readPapers(DB, id) {
  await ensurePapersSchema(DB);
  return papersRow(await DB.prepare('SELECT * FROM vendor_papers WHERE id = ?').bind(String(id)).first());
}

export async function allPapers(DB) {
  await ensurePapersSchema(DB);
  return ((await DB.prepare('SELECT * FROM vendor_papers').all()).results || []).map(papersRow);
}

/**
 * A new row, whole (one made meanwhile is left as it is). Every change after is to its own columns only, so two
 * writes at the same moment (a certificate checked while JobTread's list is read) never undo each other.
 */
function insertStatement(DB, p, now = Date.now()) {
  const iso = new Date(now).toISOString();
  return DB.prepare(`INSERT OR IGNORE INTO vendor_papers (id, name, vkey, email, archived, w9, gl, wc, docs, check_text, jt_sent, payee, note, by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(p.id, clean(p.name, 160) || null, nameKeyOf(p.name || ''), p.email || null, p.archived ? 1 : 0, p.w9 ? 1 : 0, dateOf(p.glExpires), dateOf(p.wcExpires),
      fieldValue('docs', p.docs), fieldValue('check', p.check), p.jtSent ? JSON.stringify(p.jtSent) : null, p.payee ? JSON.stringify(p.payee) : null,
      p.note || null, p.by || null, p.createdAt || iso, iso);
}

/** Set these columns ({ column: value }) on one row → the statement */
function setStatement(DB, id, cols, now = Date.now()) {
  const keys = Object.keys(cols);
  return DB.prepare(`UPDATE vendor_papers SET ${keys.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((c) => cols[c]), new Date(now).toISOString(), String(id));
}

/** The payee facts merged into what's there (aliases added to, never lost) */
const mergedPayee = (had, add) => {
  const aliases = [...new Set([...(had?.aliases || []), ...(add?.aliases || [])])];
  const out = { ...(had || {}), ...Object.fromEntries(Object.entries(add || {}).filter(([, v]) => v != null)) };
  if (aliases.length) out.aliases = aliases; else delete out.aliases;
  return out;
};

const DB_VALUE = (k, v) => (k === 'w9' ? (fieldValue(k, v) ? 1 : 0) : fieldValue(k, v));

/**
 * settleRow's result as statements that change only what it changed: a value taken from JobTread replaces the
 * site's only where the site's is still the one read (a save made meanwhile stands), and what JobTread was sent is
 * set key by key
 */
function settleStatements(DB, row, s, now = Date.now()) {
  if (s.made) return [insertStatement(DB, s.papers, now)];
  const sets = [];
  const args = [];
  const p = s.papers;
  if (p.name !== row.name) { sets.push('name = ?', 'vkey = ?'); args.push(clean(p.name, 160) || null, nameKeyOf(p.name || '')); }
  if ((p.email || null) !== (row.email || null)) { sets.push('email = ?'); args.push(p.email || null); }
  if (!!p.archived !== !!row.archived) { sets.push('archived = ?'); args.push(p.archived ? 1 : 0); }
  const was = valuesOf(row);
  for (const [k, v] of Object.entries(s.took)) {
    const c = COLUMN[k];
    sets.push(`${c} = CASE WHEN ${c} IS ? THEN ? ELSE ${c} END`);
    args.push(DB_VALUE(k, was[k]), DB_VALUE(k, v));
  }
  const sent = Object.keys(p.jtSent || {}).filter((k) => !(k in (row.jtSent || {})) || !same(k, row.jtSent[k], p.jtSent[k]));
  if (sent.length) {
    let expr = "COALESCE(jt_sent, '{}')";
    for (const k of sent) { expr = `json_set(${expr}, '$.${k}', json(?))`; args.push(JSON.stringify(fieldValue(k, p.jtSent[k]))); }
    sets.push(`jt_sent = ${expr}`);
  }
  if (!sets.length) return [];
  return [DB.prepare(`UPDATE vendor_papers SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...args, new Date(now).toISOString(), String(row.id))];
}

const withValues = (p, v) => ({ ...p, w9: !!v.w9, glExpires: v.gl || null, wcExpires: v.wc || null, docs: v.docs || null, check: v.check || null });

/**
 * settlePapers' reckoning, for one row (pure) → { papers, took, toPush, changed, made }.
 * sentBefore: what the site had last written to JobTread when the read began (null: no row yet; undefined: not
 * known). A field the site wrote while JobTread was being read is left alone: that read is older than the write.
 */
export function settleRow(row, id, jt, who = {}, now = Date.now(), { sentBefore } = {}) {
  const raced = (k) => sentBefore !== undefined && !!row && (sentBefore === null ? k in (row.jtSent || {}) : !same(k, (row.jtSent || {})[k], sentBefore[k]));
  const read = Object.fromEntries(FIELD_KEYS.filter((k) => k in (jt || {}) && !raced(k)).map((k) => [k, fieldValue(k, jt[k])]));
  const base = { id, name: who.name ?? row?.name ?? '', email: who.email !== undefined ? who.email : row?.email ?? null, archived: who.archived ?? row?.archived ?? false };
  if (!row) {
    const start = { w9: false, gl: null, wc: null, docs: null, check: null, ...read };
    const papers = { ...withValues({ ...base, jtSent: read, payee: null, createdAt: new Date(now).toISOString() }, start), site: false };
    return { papers, took: read, toPush: {}, changed: true, made: true };
  }
  const values = valuesOf(row);
  const sent = { ...(row.jtSent || {}) };
  const took = {};
  const toPush = {};
  for (const [k, v] of Object.entries(read)) {
    if (!(k in sent) || !same(k, v, sent[k])) {
      // JobTread shows what the site never wrote: a person's edit there, taken in. Unless the site changed it too and
      // that never reached JobTread (the write failed): then the one that keeps more stands (keepOurs)
      const ours = k in sent && !same(k, values[k], sent[k]);
      if (ours && keepOurs(k, values[k], v)) toPush[k] = values[k];
      else if (!same(k, v, values[k])) took[k] = v;
      sent[k] = v;
    } else if (!same(k, values[k], v)) toPush[k] = values[k];
  }
  const papers = withValues({ ...row, ...base, jtSent: sent }, { ...values, ...took });
  const changed = !!Object.keys(took).length || base.name !== row.name || (base.email || null) !== (row.email || null) || !!base.archived !== !!row.archived
    || JSON.stringify(sent) !== JSON.stringify(row.jtSent || {});
  return { papers, took, toPush, changed, made: false };
}

/**
 * Both the site and a person in JobTread changed a field since they last agreed: does the site's stand? The later
 * end date (a certificate's date is never undone by an older hand edit), a W-9 on file, a check's words; a person's
 * W-9 only or Not needed typed in JobTread wins over the site's own status
 */
function keepOurs(k, ours, theirs) {
  if (k === 'gl' || k === 'wc') return !!fieldValue(k, ours) && (!fieldValue(k, theirs) || fieldValue(k, ours) > fieldValue(k, theirs));
  if (k === 'w9') return fieldValue(k, ours);
  if (k === 'docs') return !PERSON_DOCS.has(fieldValue(k, theirs));
  return true;
}
/** Documents values only a person sets */
const PERSON_DOCS = new Set(['W-9 only', 'Not needed']);

/**
 * Every JobTread vendor in a list against its papers, in one read and batched writes (the 4-hourly list:
 * [{ id, name, email, archived, fields: { w9, gl, wc, docs, check } }]) → [{ id, toPush }] the site's values to write there
 */
export async function settleMany(env, list, { now = Date.now(), before = null } = {}) {
  await ensurePapersSchema(env.DB);
  const rows = new Map((await allPapers(env.DB)).map((p) => [p.id, p]));
  const stmts = [];
  const push = [];
  for (const v of list) {
    if (!v?.id || !v.fields || isSiteVendor(v.id)) continue;
    // before: each row's jt_sent when the list began to be read (a Map); a field written since is left alone
    const sentBefore = before ? (before.has(v.id) ? before.get(v.id) || {} : null) : undefined;
    const row = rows.get(v.id) || null;
    const s = settleRow(row, v.id, v.fields, { name: v.name, email: v.email || null, archived: !!v.archived }, now, { sentBefore });
    if (s.changed) stmts.push(...settleStatements(env.DB, row, s, now));
    if (Object.keys(s.toPush).length) push.push({ id: v.id, toPush: s.toPush });
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return push;
}

/**
 * A JobTread vendor's papers against what JobTread's fields say now.
 * jt: the fields as read ({ w9, gl, wc, docs, check }, any of them; a key left out wasn't read);
 * who: { name, email, archived } from JobTread.
 *   - No row yet: JobTread's fields are what SOARD had, so they're the start.
 *   - A field that differs from what the site last wrote there: a person changed it in JobTread. Theirs, taken in.
 *   - A field the site changed that JobTread doesn't show yet (a write that didn't land): written again (toPush).
 * → { papers, took: { key: value }, toPush: { key: value }, made }
 */
export async function settlePapers(env, id, jt, who = {}, { now = Date.now(), sentBefore } = {}) {
  await ensurePapersSchema(env.DB);
  const row = await readPapers(env.DB, id);
  const s = settleRow(row, id, jt, who, now, { sentBefore });
  if (s.changed) for (const st of settleStatements(env.DB, row, s, now)) await st.run();
  // What the row holds now (a save made meanwhile included)
  if (s.changed) s.papers = (await readPapers(env.DB, id)) || s.papers;
  return s;
}

/**
 * Change a company's papers ({ w9, gl, wc, docs, check }, any of them) → the papers after.
 * JobTread's fields follow in ./_vendors.js writePapers; this is only the record.
 */
const COLUMN = { w9: 'w9', gl: 'gl', wc: 'wc', docs: 'docs', check: 'check_text' };

export async function savePapers(env, id, patch, { now = Date.now(), by = null, who = null, forward = false } = {}) {
  await ensurePapersSchema(env.DB);
  const iso = new Date(now).toISOString();
  // A company with no row yet starts with nothing on file (a JobTread vendor's row is normally made by its first read)
  await env.DB.prepare('INSERT OR IGNORE INTO vendor_papers (id, name, vkey, email, archived, w9, jt_sent, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)')
    .bind(String(id), clean(who?.name, 160) || null, nameKeyOf(who?.name || ''), who?.email || null, isSiteVendor(id) ? null : '{}', iso, iso).run();
  // Only the columns changed, in one statement: two saves at the same moment can't undo each other's
  const sets = [];
  const args = [];
  for (const k of FIELD_KEYS) {
    if (patch[k] === undefined) continue;
    const v = fieldValue(k, patch[k]);
    const c = COLUMN[k];
    if (forward && (k === 'gl' || k === 'wc')) {
      // A date from a document only ever moves later (two certificates checked at once, in either order, end the same)
      if (!v) continue;
      sets.push(`${c} = CASE WHEN ${c} IS NULL OR ${c} < ? THEN ? ELSE ${c} END`);
      args.push(v, v);
    } else {
      sets.push(`${c} = ?`);
      args.push(k === 'w9' ? (v ? 1 : 0) : v);
    }
  }
  if (by) { sets.push('by = ?'); args.push(by); }
  // Who made a W-9 only or Not needed call (a person's; the W-9 only a payee starts with has none)
  if (patch.docs !== undefined) { sets.push('docs_by = ?'); args.push(PERSON_DOCS.has(fieldValue('docs', patch.docs)) ? by : null); }
  sets.push('updated_at = ?');
  args.push(iso);
  await env.DB.prepare(`UPDATE vendor_papers SET ${sets.join(', ')} WHERE id = ?`).bind(...args, String(id)).run();
  return readPapers(env.DB, id);
}

/** JobTread now shows these values (they were written there): each key set on its own, so two writes never lose one */
export async function markSent(env, id, patch, { now = Date.now() } = {}) {
  const keys = FIELD_KEYS.filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  let expr = "COALESCE(jt_sent, '{}')";
  const args = [];
  for (const k of keys) {
    expr = `json_set(${expr}, '$.${k}', json(?))`;
    args.push(JSON.stringify(fieldValue(k, patch[k])));
  }
  await env.DB.prepare(`UPDATE vendor_papers SET jt_sent = ${expr}, updated_at = ? WHERE id = ?`).bind(...args, new Date(now).toISOString(), String(id)).run();
}

// ─── The files ──────────────────────────────────────────────────────

const fileRow = (r) => r && ({
  id: r.id, vendorId: r.vendor_id, doc: r.doc, name: r.name || '', type: r.type || '', size: r.size || 0, hash: r.hash, key: r.r2_key,
  source: r.source, sourceRef: r.source_ref || null, receivedAt: r.received_at || null, addedAt: r.added_at, addedBy: r.added_by || null,
  status: r.status, prior: r.prior || null, summary: r.summary || null, reading: parseJson(r.reading, null), proves: parseJson(r.proves, null),
});

/**
 * What a file proves, the part its kind can (a W-9: on file; a certificate: the end dates that met the minimums), as it
 * was when it passed: { w9: true } | { gl, wc } | null. Kept apart from the reading on purpose: a certificate under the
 * minimums, one that failed the check, or a file a person only looked at proves nothing, whatever it says.
 */
const provenBy = (f) => {
  const p = f?.proves;
  if (!p) return {};
  if (f.doc === 'w9') return p.w9 ? { w9: true } : {};
  return Object.fromEntries(['gl', 'wc'].filter((k) => dateOf(p[k])).map((k) => [k, dateOf(p[k])]));
};
/** proves as kept: only what a W-9 or a certificate can prove */
const provesJson = (p) => {
  if (!p) return null;
  const out = { ...(p.w9 ? { w9: true } : {}), ...(dateOf(p.gl) ? { gl: dateOf(p.gl) } : {}), ...(dateOf(p.wc) ? { wc: dateOf(p.wc) } : {}) };
  return Object.keys(out).length ? JSON.stringify(out) : null;
};

/** What a check read, without anything private: a W-9's names and yes/no answers, a certificate's policies and agency */
export function keptReading(doc, x) {
  if (!x) return null;
  if (doc === 'w9') return { name: clean(x.name, 120) || null, business: clean(x.businessName || x.business, 120) || null, signed: x.signed === undefined ? null : !!x.signed, signedDate: dateOf(x.signedDate) };
  const pol = (p) => p && {
    kind: clean(p.kind, 40), insurer: clean(p.insurer, 120) || null, effective: dateOf(p.effective), expires: dateOf(p.expires),
    each: Number(p.eachOccurrence ?? p.occurrence) || null, aggregate: Number(p.aggregate) || null, el: Number(p.employersLiabilityEachAccident ?? p.el) || null,
  };
  return {
    insured: clean(x.insured, 160) || null,
    policies: (x.policies || []).map(pol).filter(Boolean).slice(0, 12),
    exempt: !!x.isWcExemption,
    agency: x.producer ? { name: clean(x.producer.name, 120) || null, email: clean(x.producer.email, 120).toLowerCase() || null } : null,
  };
}

/** A company's files, newest first (one taken off is kept, out of sight, unless `removed`) */
export async function filesOf(DB, vendorId, { removed = false } = {}) {
  await ensurePapersSchema(DB);
  return ((await DB.prepare(`SELECT * FROM vendor_files WHERE vendor_id = ?${removed ? '' : " AND status != 'removed'"} ORDER BY COALESCE(received_at, added_at) DESC, added_at DESC`).bind(String(vendorId)).all()).results || []).map(fileRow);
}

export async function readFile(DB, id) {
  await ensurePapersSchema(DB);
  return fileRow(await DB.prepare('SELECT * FROM vendor_files WHERE id = ?').bind(String(id)).first());
}

/** The stored file itself (an R2 object, with .body), or null */
export async function fileObject(env, f) {
  return f && vendorBucket(env) ? vendorBucket(env).get(f.key) : null;
}

/**
 * One W-9 or certificate into private storage, once per company (the same bytes again is the same file).
 * file: { bytes, type, name }; doc 'w9' | 'coi'; status 'checked' (passed the check) | 'look' (a person needs to
 * open it) | 'kept' (filed before the site checked anything); reading: the check's (keptReading keeps what's safe);
 * proves: what it moved on the record because it passed ({ w9: true } or the dates that met the minimums)
 * → { file, duplicate }
 */
/** Who can bring back a file a person took off by sending it again: a person, or the company itself (never the import or the search) */
const PERSON_SOURCES = new Set(['staff', 'page', 'agent', 'signed']);

/** Is any of these files already kept for the company as the other kind (and still on its list)? → 'w9' | 'coi' | null */
export async function otherKindOf(env, vendorId, doc, bytesList) {
  await ensurePapersSchema(env.DB);
  for (const bytes of bytesList) {
    const r = await env.DB.prepare("SELECT doc FROM vendor_files WHERE vendor_id = ? AND hash = ? AND doc != ? AND status != 'removed'").bind(String(vendorId), await sha256(bytes), doc).first();
    if (r) return r.doc;
  }
  return null;
}

export async function keepFile(env, vendorId, { doc, bytes, type, name = '', source, sourceRef = null, receivedAt = null, by = null, status = 'checked', summary = null, reading = null, proves = null }, { now = Date.now() } = {}) {
  if (!['w9', 'coi'].includes(doc)) throw new Error('A file is a W-9 or a certificate');
  if (!SOURCES[source]) throw new Error('A file needs to say where it came from');
  if (!bytes?.byteLength) throw new Error('The file is empty');
  if (bytes.byteLength > MAX_FILE_BYTES) throw Object.assign(new Error('The file is over 15 MB'), { status: 413 });
  await ensurePapersSchema(env.DB);
  const hash = await sha256(bytes);
  const had = fileRow(await env.DB.prepare('SELECT * FROM vendor_files WHERE vendor_id = ? AND hash = ?').bind(String(vendorId), hash).first());
  if (had && had.doc !== doc && had.status !== 'removed') {
    // Kept as the other kind (a person may have said so): one file is one thing, never a W-9 and a certificate at once
    throw Object.assign(new Error(`That file is already kept as ${had.doc === 'w9' ? 'a W-9' : 'a certificate'}. If it’s really ${doc === 'w9' ? 'a W-9' : 'a certificate'}, use Move on it in the list.`), { status: 409, otherKind: had.doc });
  }
  // A person took it off: found again by the import or the search, it stays off (and moves nothing)
  if (had && had.status === 'removed' && !PERSON_SOURCES.has(source)) return { file: had, duplicate: true };
  if (had) {
    // The same file checked now when it was only waiting on a person before, or sent again after it was taken off
    const next = had.status === 'removed' ? status : status === 'checked' && had.status !== 'checked' ? 'checked' : had.status;
    if (next !== had.status) {
      await env.DB.prepare('UPDATE vendor_files SET status = ?, summary = COALESCE(?, summary), reading = COALESCE(?, reading) WHERE id = ?')
        .bind(next, summary ? clean(summary, 500) : null, reading ? JSON.stringify(keptReading(doc, reading)) : null, had.id).run();
    }
    // Sent again, as the other kind after it was taken off: it's what it was sent as now
    if (had.doc !== doc) await env.DB.prepare('UPDATE vendor_files SET doc = ?, proves = NULL WHERE id = ?').bind(doc, had.id).run();
    // Proving nothing before, and passing now: what it proves is known from here on (a proof once kept stands)
    if (provesJson(proves) && (!had.proves || had.doc !== doc)) await env.DB.prepare('UPDATE vendor_files SET proves = ? WHERE id = ?').bind(provesJson(proves), had.id).run();
    return { file: await readFile(env.DB, had.id), duplicate: true };
  }
  const bucket = vendorBucket(env);
  if (!bucket) throw Object.assign(new Error('The private storage for W-9s and certificates isn’t connected, so nothing can be kept right now.'), { status: 503 });
  const id = `vf_${randomId(20)}`;
  const key = `${PREFIX}${vendorId}/${id}.${EXT[type] || 'bin'}`;
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: type || 'application/octet-stream', cacheControl: 'private, no-store' },
    customMetadata: { vendor: String(vendorId), doc },
  });
  const iso = new Date(now).toISOString();
  await env.DB.prepare(`INSERT INTO vendor_files (id, vendor_id, doc, name, type, size, hash, r2_key, source, source_ref, received_at, added_at, added_by, status, summary, reading, proves)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, String(vendorId), doc, nameFor(name, doc, type), type || null, bytes.byteLength, hash, key,
      source, sourceRef, dateOf(receivedAt) || null, iso, by, status, summary ? clean(summary, 500) : null, reading ? JSON.stringify(keptReading(doc, reading)) : null, provesJson(proves)).run();
  return { file: await readFile(env.DB, id), duplicate: false };
}

/** A file's name with the ending its real type has (a photo saved as "x.pdf" is "x.jpg"), so it opens as what it is */
function nameFor(name, doc, type) {
  const ext = EXT[type] || 'bin';
  const base = clean(name, 150).replace(/\.[a-z0-9]{2,5}$/i, '') || (doc === 'w9' ? 'W-9' : 'Certificate');
  return `${base}.${ext}`;
}

/**
 * A person said what a company's waiting files of one kind show (the W-9 is good, the dates): that's what they prove.
 * A file someone pressed "I looked at it" on first (lookedAt) counts too: the order of the two never matters.
 */
export async function provenByPerson(env, vendorId, doc, patch) {
  const proves = provesJson(doc === 'w9' ? { w9: patch.w9 === true } : { gl: patch.gl, wc: patch.wc });
  if (!proves) return 0;
  const r = await env.DB.prepare(`UPDATE vendor_files SET status = 'checked', proves = ? WHERE vendor_id = ? AND doc = ?
      AND (status = 'look' OR (status = 'checked' AND prior = 'look' AND proves IS NULL))`).bind(proves, String(vendorId), doc).run();
  return r?.meta?.changes ?? 0;
}

/** What a person typed on the record (Job Costs → W-9s & insurance): kept apart, so no file taken off undoes it */
export async function handTyped(env, id, patch) {
  const p = await readPapers(env.DB, id);
  if (!p) return;
  const hand = { ...(p.hand || {}) };
  for (const k of ['w9', 'gl', 'wc']) {
    if (!(k in patch)) continue;
    if (patch[k]) hand[k] = k === 'w9' ? true : dateOf(patch[k]); else delete hand[k];
  }
  await env.DB.prepare('UPDATE vendor_papers SET hand = ? WHERE id = ?').bind(Object.keys(hand).length ? JSON.stringify(hand) : null, String(id)).run();
}

/** A person looked at a file that waited on them (it's remembered, so what they then type about it is what it proves) */
export async function lookedAt(env, fileId) {
  await env.DB.prepare("UPDATE vendor_files SET status = 'checked', prior = 'look' WHERE id = ? AND status = 'look'").bind(String(fileId)).run();
}

/** A person's word on a file: it's right ('checked'), it needs a look, or it's taken off ('removed': kept, out of sight, so it's never lost and never copied in again) */
export async function setFileStatus(env, fileId, status) {
  if (!['checked', 'look', 'kept', 'removed'].includes(status)) throw Object.assign(new Error('Not a file status'), { status: 400 });
  await env.DB.prepare('UPDATE vendor_files SET status = ? WHERE id = ?').bind(status, String(fileId)).run();
}

/** A file taken off its company (kept, out of sight: it may be the only copy anywhere; what it was is remembered) → the file as it was */
export async function removeFile(env, fileId) {
  const f = await readFile(env.DB, fileId);
  if (!f) return null;
  if (f.status !== 'removed') await env.DB.prepare("UPDATE vendor_files SET prior = status, status = 'removed' WHERE id = ?").bind(f.id).run();
  return f;
}

/** A file taken off by mistake, put back as it was → the file */
export async function restoreFile(env, fileId) {
  const f = await readFile(env.DB, fileId);
  if (!f) throw Object.assign(new Error('That file isn’t here any more'), { status: 404 });
  if (f.status === 'removed') await env.DB.prepare('UPDATE vendor_files SET status = COALESCE(prior, \'kept\'), prior = NULL WHERE id = ?').bind(f.id).run();
  return readFile(env.DB, f.id);
}

/**
 * A file kept on the wrong company, moved to the right one (its doc can change too: a W-9 filed as a certificate).
 * What it proved goes with it (moveProof says how each company's papers change) → { file, was }
 */
export async function moveFile(env, fileId, { toId = null, doc = null } = {}) {
  const f = await readFile(env.DB, fileId);
  if (!f) throw Object.assign(new Error('That file isn’t here any more'), { status: 404 });
  if (doc && !['w9', 'coi'].includes(doc)) throw Object.assign(new Error('A file is a W-9 or a certificate'), { status: 400 });
  const to = toId || f.vendorId;
  const status = f.status === 'removed' ? 'kept' : f.status;
  if (to !== f.vendorId) {
    const there = fileRow(await env.DB.prepare('SELECT * FROM vendor_files WHERE vendor_id = ? AND hash = ?').bind(to, f.hash).first());
    if (there) {
      // They have the very same file already: this copy goes, and theirs shows (even one taken off them before)
      await setFileStatus(env, f.id, 'removed');
      if (there.status === 'removed' || (status === 'checked' && there.status !== 'checked')) await setFileStatus(env, there.id, status);
      if (doc && doc !== there.doc) await env.DB.prepare('UPDATE vendor_files SET doc = ? WHERE id = ?').bind(doc, there.id).run();
      // What this copy proved comes with it (their copy may only have been waiting on a person)
      if (f.proves && !there.proves) await env.DB.prepare('UPDATE vendor_files SET proves = ? WHERE id = ?').bind(provesJson(f.proves), there.id).run();
      // A certificate's policies are the company's it's on now (the insurance audit reads them by company)
      await env.DB.prepare('UPDATE coi_coverage SET jt_id = ? WHERE file_hash = ?').bind(to, f.hash).run().catch(() => null);
      return { file: await readFile(env.DB, there.id), was: f };
    }
  }
  await env.DB.prepare('UPDATE vendor_files SET vendor_id = ?, doc = ?, status = ? WHERE id = ?').bind(to, doc || f.doc, status, f.id).run();
  if (to !== f.vendorId) await env.DB.prepare('UPDATE coi_coverage SET jt_id = ? WHERE file_hash = ?').bind(to, f.hash).run().catch(() => null);
  return { file: await readFile(env.DB, f.id), was: f };
}

/**
 * What a file proved, off the company it was on (moved away, taken off, or relabeled) → a patch for writePapers. The
 * company keeps a date or a W-9 another of its own files shows, and one typed by hand or from JobTread (a date this
 * file wasn't the source of); one only this file showed goes (the date another of its certificates shows, else none).
 */
export async function proofOff(env, was) {
  const patch = {};
  const gone = provenBy(was);
  if (!Object.keys(gone).length) return patch;   // it proved nothing: nothing it leaves behind changes
  const had = await readPapers(env.DB, was.vendorId);
  if (!had) return patch;
  const files = (await filesOf(env.DB, was.vendorId)).filter((r) => r.id !== was.id);
  const rest = files.map(provenBy);
  // What a person typed (a W-9 marked on file, a date) is theirs: no file going takes it away (handTyped)
  const hand = had.hand || {};
  if (gone.w9 && had.w9 && !hand.w9 && !rest.some((d) => d.w9)) patch.w9 = false;
  let from = null;   // the certificate whose date the record falls back to
  for (const k of ['gl', 'wc']) {
    const mine = k === 'gl' ? had.glExpires : had.wcExpires;
    if (!gone[k] || mine !== gone[k] || hand[k] === mine || rest.some((d) => d[k] === mine)) continue;
    // Back to the latest date something else still shows: another of their certificates, or what a person typed
    patch[k] = [...rest.map((d) => d[k]), hand[k]].filter((d) => d && d < mine).sort().pop() || null;
    if (patch[k]) from ||= files.find((f, i) => rest[i][k] === patch[k]);
  }
  // The last certificate's words go with its dates (JobTread's Insurance Check): the one the record now stands on
  // (the one it fell back to, else one still showing a date it keeps), or none
  if ('gl' in patch || 'wc' in patch) {
    const kept = (k) => !(k in patch) && (k === 'gl' ? had.glExpires : had.wcExpires);
    from ||= files.find((f, i) => ['gl', 'wc'].some((k) => kept(k) && rest[i][k] === kept(k)));
    patch.check = from ? checkWords(from) : null;
  }
  return patch;
}

/**
 * What a file proves on the company it's on now (moved there, put back, or relabeled back to what it was) → a patch
 * for writePapers, dates forward only: only what it passed with (proves). Saying "it's a W-9" proves nothing about it.
 */
export function proofOn(file) {
  const patch = file && file.status !== 'removed' ? provenBy(file) : {};
  if (patch.gl || patch.wc) patch.check = checkWords(file);
  return patch;
}

/** A certificate in JobTread's Insurance Check: what its check said, or its name, and when it came */
const checkWords = (f) => `${f.summary || f.name}${f.receivedAt || f.addedAt ? ` · ${String(f.receivedAt || f.addedAt).slice(0, 10)}` : ''}`.slice(0, 250);

// ─── Companies only the site knows ──────────────────────────────────

/** The JobTread vendor a site company was moved onto (mergeIntoJobTread keeps its id) → { id, name } or null */
export async function mergedInto(DB, siteId) {
  if (!isSiteVendor(siteId)) return null;
  const rows = ((await DB.prepare('SELECT id, name, payee FROM vendor_papers WHERE payee LIKE ?').bind(`%${siteId}%`).all().catch(() => ({ results: [] }))).results || []);
  const r = rows.find((x) => (parseJson(x.payee).merged || []).includes(siteId));
  return r ? { id: r.id, name: r.name || 'its JobTread vendor' } : null;
}

/** The site company a name means: its name now, or one it had (payee.aliases: renamed) → papers or null */
async function siteNamed(DB, key) {
  const same = ((await DB.prepare('SELECT * FROM vendor_papers WHERE vkey = ?').bind(key).all()).results || []).map(papersRow).find((p) => p.site);
  if (same) return same;
  const aliased = ((await DB.prepare("SELECT * FROM vendor_papers WHERE payee LIKE '%aliases%'").all()).results || []).map(papersRow);
  return aliased.find((p) => p.site && (p.payee?.aliases || []).includes(key)) || null;
}

/**
 * A company SOARD pays that isn't a JobTread vendor (the same name again is the same company) → { id, made, back }.
 * docs: their Documents to start with ('W-9 only': paid, never on a job, so no insurance is asked for).
 * One archived comes back (back: true) when staff add it again, or when the payee search sees a bill dated after
 * it was archived (payee.last).
 */
export async function addSiteVendor(env, { name, email = null, docs = 'W-9 only', payee = null, by = null, note = null }, { now = Date.now() } = {}) {
  await ensurePapersSchema(env.DB);
  const n = clean(name, 120);
  if (n.length < 2) throw Object.assign(new Error('Add the company’s name.'), { status: 400, field: 'name' });
  const e = clean(email, 120).toLowerCase();
  if (e && !isEmail(e)) throw Object.assign(new Error('Check the email address.'), { status: 400, field: 'email' });
  const key = nameKeyOf(n);
  if (!key) throw Object.assign(new Error('Add the company’s name.'), { status: 400, field: 'name' });
  // A JobTread vendor by that name, or one a company was moved onto under this name, is that vendor
  const jt = await jobtreadNamed(env.DB, n);
  if (jt) throw Object.assign(new Error(`That’s ${jt.name} in JobTread. It’s in the list already.`), { status: 409, jtId: jt.jtId });
  const site = await siteNamed(env.DB, key);
  if (site) {
    const cols = {};
    if (e && !site.email) cols.email = e;
    if (payee) cols.payee = JSON.stringify(mergedPayee(site.payee, payee));
    // Paid again after it was archived (a bill dated later), or a person adding it again: it's back on the list
    const paidSince = payee?.last && site.archivedAt && payee.last > site.archivedAt.slice(0, 10);
    const back = site.archived && (by !== 'payees' || paidSince);
    if (back) { cols.archived = 0; cols.archived_at = null; }
    if (Object.keys(cols).length) await setStatement(env.DB, site.id, cols, now).run();
    return { id: site.id, made: false, back: !!back };
  }
  const id = `s_${randomId(14)}`;
  await insertStatement(env.DB, { id, name: n, email: e || null, archived: false, w9: false, docs, jtSent: null, payee, note, by, createdAt: new Date(now).toISOString() }, now).run();
  return { id, made: true, back: false };
}

/** A site company out of the list (SOARD doesn't pay them after all), or back → the papers */
export async function archiveSiteVendor(env, id, archived = true, { now = Date.now() } = {}) {
  if (!isSiteVendor(id)) throw Object.assign(new Error('A JobTread vendor is archived in JobTread'), { status: 400 });
  const p = await readPapers(env.DB, id);
  if (!p) throw Object.assign(new Error('No such company'), { status: 404 });
  // Already so: nothing changes (taking one off again never moves the day it went off, which "paid since" is counted from)
  if (!!archived === p.archived) return p;
  await setStatement(env.DB, id, { archived: archived ? 1 : 0, archived_at: archived ? new Date(now).toISOString() : null }, now).run();
  return readPapers(env.DB, id);
}

/**
 * The JobTread vendor a name means: the same name (nameKeyOf), or one a site company of that name was moved onto
 * (its payee.aliases) → { jtId, name } or null
 */
export async function jobtreadNamed(DB, name) {
  const key = nameKeyOf(name);
  if (!key) return null;
  const rows = (await DB.prepare('SELECT jt_id, name FROM vendors WHERE jt_id IS NOT NULL').all().catch(() => ({ results: [] }))).results || [];
  const hit = rows.find((r) => nameKeyOf(r.name) === key);
  if (hit) return { jtId: hit.jt_id, name: hit.name };
  const aliased = (await DB.prepare("SELECT id, name, payee FROM vendor_papers WHERE payee LIKE '%aliases%'").all().catch(() => ({ results: [] }))).results || [];
  const a = aliased.find((r) => !isSiteVendor(r.id) && (parseJson(r.payee).aliases || []).includes(key));
  return a ? { jtId: a.id, name: a.name } : null;
}

/** A site company's name or email (a JobTread vendor's are JobTread's). The name it had stays its own (the payee search knows it by it) */
export async function editSiteVendor(env, id, { name, email }, { now = Date.now() } = {}) {
  if (!isSiteVendor(id)) throw Object.assign(new Error('Change a JobTread vendor’s name and email in JobTread'), { status: 400 });
  const p = await readPapers(env.DB, id);
  if (!p) throw Object.assign(new Error('No such company'), { status: 404 });
  const n = name === undefined ? p.name : clean(name, 120);
  if (n.length < 2) throw Object.assign(new Error('Add the company’s name.'), { status: 400, field: 'name' });
  const e = email === undefined ? p.email : clean(email, 120).toLowerCase() || null;
  if (e && !isEmail(e)) throw Object.assign(new Error('Check the email address.'), { status: 400, field: 'email' });
  const cols = {};
  if (n !== p.name) {
    const key = nameKeyOf(n);
    if (!key) throw Object.assign(new Error('Add the company’s name.'), { status: 400, field: 'name' });
    const jt = await jobtreadNamed(env.DB, n);
    if (jt) throw Object.assign(new Error(`That’s ${jt.name} in JobTread. Move this company onto it instead.`), { status: 409, jtId: jt.jtId, field: 'name' });
    const other = await siteNamed(env.DB, key);
    if (other && other.id !== id) throw Object.assign(new Error(`${other.name} is in the list already.`), { status: 409, field: 'name' });
    Object.assign(cols, { name: n, vkey: key });
    const old = nameKeyOf(p.name);
    if (old && old !== key) cols.payee = JSON.stringify(mergedPayee(p.payee, { aliases: [old] }));
  }
  if ((e || null) !== (p.email || null)) cols.email = e;
  if (Object.keys(cols).length) await setStatement(env.DB, id, cols, now).run();
  return readPapers(env.DB, id);
}

/**
 * A site company that turns out to be a JobTread vendor: its files, papers, links and asks move onto the JobTread
 * id, the later of each date and a W-9 either had kept, and the certificates the insurance audit read for it
 * → the JobTread vendor's papers (written there, and Documents worked out again, by the caller)
 */
export async function mergeIntoJobTread(env, siteId, jtId, { now = Date.now() } = {}) {
  if (!isSiteVendor(siteId) || isSiteVendor(jtId)) throw Object.assign(new Error('Move a site company onto a JobTread vendor'), { status: 400 });
  const from = await readPapers(env.DB, siteId);
  if (!from) throw Object.assign(new Error('No such company'), { status: 404 });
  const to = await readPapers(env.DB, jtId);
  const later = (a, b) => [dateOf(a), dateOf(b)].filter(Boolean).sort().pop() || null;
  const v = to ? valuesOf(to) : { w9: false, gl: null, wc: null, docs: null, check: null };
  const merged = {
    w9: v.w9 || from.w9, gl: later(v.gl, from.glExpires), wc: later(v.wc, from.wcExpires),
    check: v.check || from.check,
    // The JobTread vendor's own Documents stands: a company on jobs needs its insurance whatever was decided for it
    // when it looked like a company off the jobs ("W-9 only", "Not needed")
    docs: v.docs,
  };
  // Files the JobTread vendor already has (the same bytes) stay theirs, shown if this one was (even one taken off
  // them before); the rest move
  const theirs = new Map(((await env.DB.prepare('SELECT * FROM vendor_files WHERE vendor_id = ?').bind(jtId).all()).results || []).map((r) => [r.hash, fileRow(r)]));
  const mine = ((await env.DB.prepare('SELECT * FROM vendor_files WHERE vendor_id = ?').bind(siteId).all()).results || []).map(fileRow);
  const dupes = [];
  const stmts = [];
  for (const f of mine) {
    const t = theirs.get(f.hash);
    if (!t) { stmts.push(env.DB.prepare('UPDATE vendor_files SET vendor_id = ? WHERE id = ?').bind(jtId, f.id)); continue; }
    if (t.status === 'removed' && f.status !== 'removed') stmts.push(env.DB.prepare('UPDATE vendor_files SET status = ? WHERE id = ?').bind(f.status, t.id));
    // Their copy is the one kept; this one's stored file goes only when theirs is really there
    if (await fileObject(env, t)) { dupes.push(f); stmts.push(env.DB.prepare('DELETE FROM vendor_files WHERE id = ?').bind(f.id)); }
    else stmts.push(env.DB.prepare('UPDATE vendor_files SET r2_key = ? WHERE id = ?').bind(f.key, t.id), env.DB.prepare('DELETE FROM vendor_files WHERE id = ?').bind(f.id));
  }
  // The certificates read for it, and what the certificate search found, are the JobTread vendor's
  stmts.push(env.DB.prepare('UPDATE coi_coverage SET jt_id = ? WHERE jt_id = ?').bind(jtId, siteId));
  stmts.push(env.DB.prepare('UPDATE coi_found SET jt_id = ? WHERE jt_id = ?').bind(jtId, siteId));
  // The site company's links went to whoever SOARD asked for a W-9 (maybe the CPA's bookkeeper): they never become a
  // link to the JobTread vendor's whole page, its invoices and bank details. They stop; the vendor gets its own.
  stmts.push(env.DB.prepare("UPDATE vendor_links SET status = 'replaced' WHERE vendor_id = ?").bind(siteId));
  stmts.push(env.DB.prepare('DELETE FROM vendor_asks WHERE jt_id = ?').bind(siteId));
  stmts.push(env.DB.prepare('DELETE FROM vendor_papers WHERE id = ?').bind(siteId));
  // Their insurance agent and language go with them, unless the vendor has its own
  stmts.push(env.DB.prepare('INSERT OR IGNORE INTO vendor_profiles (jt_id, steps, address, agent, lang, reminders, updated_at) SELECT ?, steps, address, agent, lang, 0, ? FROM vendor_profiles WHERE jt_id = ?').bind(jtId, new Date(now).toISOString(), siteId));
  stmts.push(env.DB.prepare('DELETE FROM vendor_profiles WHERE jt_id = ?').bind(siteId));
  await env.DB.batch(stmts).catch(async () => {
    // vendor_links, vendor_asks, vendor_profiles or the coverage tables may not exist yet on a fresh database
    for (const s of stmts) await s.run().catch(() => null);
  });
  for (const f of dupes) await vendorBucket(env)?.delete(f.key);
  const after = await savePapers(env, jtId, merged, { now, who: to ? null : { name: from.name, email: from.email } });
  // The name it had is this vendor's from now on: the daily payee search never makes it a company of its own again
  const aliases = [...new Set([...(from.payee?.aliases || []), nameKeyOf(from.name)].filter(Boolean))];
  // And its old address (the admin's #job-costs/papers/s_…) says where it went
  const ids = [...new Set([...(after.payee?.merged || []), ...(from.payee?.merged || []), siteId])];
  await setStatement(env.DB, jtId, { payee: JSON.stringify(mergedPayee(after.payee, { ...(from.payee || {}), aliases, merged: ids })) }, now).run();
  return readPapers(env.DB, jtId);
}

// ─── Companies paid outside JobTread ────────────────────────────────

/**
 * The JobTread vendor a payee's name means: the same name (nameKeyOf: "TKO Plumbing LLC" is "TKO Plumbing"), or a
 * name a company was moved onto it under (aliases) → jt id or null. Anything looser is left for a person: the
 * admin shows a company's likely JobTread vendor, and moving it is one click.
 */
export function jobtreadFor(name, vendors, aliases = new Map()) {
  const key = nameKeyOf(name);
  if (!key) return null;
  return vendors.find((v) => nameKeyOf(v.name) === key)?.jtId || aliases.get(key) || null;
}

/** Strong enough to suggest: the same name, or every word of the shorter name (two words at least) in the longer */
export function likelySame(a, b) {
  const ka = nameKeyOf(a);
  const kb = nameKeyOf(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.split(' ').length <= kb.split(' ').length ? [ka, kb] : [kb, ka];
  const words = short.split(' ');
  const set = new Set(long.split(' '));
  return words.length >= 2 && words.every((w) => set.has(w));
}

// Payees that are never asked for a W-9: SOARD itself and the card and banking services it pays through (exact names only)
const NO_W9 = /^(sunshine on a ?ranney day( foundation)?|soard|sunny and ranney|internal revenue service|irs|american express|amex|ramp|ramp business|mercury|mercury technologies)$/;

/**
 * Daily: everyone SOARD pays by bill or transfer (Mercury's payees, Ramp's bills of the last two years) that isn't a
 * JobTread vendor gets a site company (W-9 only), so "anyone we pay has a W-9" covers them too → { made, seen }
 */
export async function findPayees(env, { now = Date.now(), fetchImpl = fetch, force = false } = {}) {
  await ensurePapersSchema(env.DB);
  const st = await readState(env.DB, STATE_KEY);
  if (!force && now - Date.parse(st.payeesAt || 0) < PAYEES_EVERY_MS) return null;
  const vendors = ((await env.DB.prepare('SELECT jt_id, name FROM vendors WHERE jt_id IS NOT NULL').all().catch(() => ({ results: [] }))).results || []).map((v) => ({ jtId: v.jt_id, name: v.name }));
  if (!vendors.length) return null;   // the JobTread list hasn't been read yet: every payee would look new
  const payees = new Map();
  const add = (name, payee, bill = null) => {
    const n = clean(name, 120);
    const k = nameKeyOf(n);
    if (n.length < 2 || !k || NO_W9.test(k)) return;
    const was = payees.get(k);
    const p = { ...(was?.payee || {}), ...Object.fromEntries(Object.entries(payee).filter(([, v]) => v != null)) };
    // What Ramp paid them in the last year, and when last: the admin lists who SOARD pays most first
    if (bill?.cents && bill.at && now - Date.parse(bill.at) < 365 * DAY) p.cents12 = (p.cents12 || 0) + bill.cents;
    if (bill?.at && (!p.last || bill.at > p.last)) p.last = bill.at.slice(0, 10);
    payees.set(k, { name: was?.name || n, payee: p });
  };
  const errors = [];
  const { mercuryConfigured } = await import('./_mercury.js');
  if (mercuryConfigured(env)) {
    try {
      const { cachedRecipients } = await import('./_bill-pay.js');
      // When each was last paid (the copy of Mercury's payments D1 keeps): an archived company paid since comes back
      const last = new Map(((await env.DB.prepare("SELECT counterparty_id AS id, MAX(COALESCE(posted_at, created_at)) AS at FROM mercury_txns WHERE kind = 'outgoingPayment' AND cents < 0 AND LOWER(COALESCE(status, '')) NOT IN ('failed', 'cancelled', 'canceled', 'reversed') GROUP BY counterparty_id")
        .all().catch(() => ({ results: [] }))).results || []).map((r) => [r.id, r.at]));
      for (const r of await cachedRecipients(env, { now })) if (r.status !== 'deleted') add(r.name, { mercury: r.id, email: (r.emails || []).find(isEmail) || null }, last.get(r.id) ? { at: last.get(r.id) } : null);
    } catch (e) { errors.push(`Mercury: ${e.message}`); }
  }
  const { ramp, rampConfigured, billOf } = await import('./_ramp.js');
  if (rampConfigured(env)) {
    try {
      let next = '/bills';
      let query = { from_created_at: new Date(now - 730 * DAY).toISOString(), page_size: 100 };
      for (let i = 0; i < 15 && next; i++) {
        const d = await ramp(env, next, { query, fetchImpl });
        for (const b of d?.data || []) {
          const one = billOf(b);
          // What they were paid counts paid bills only; any bill says when SOARD last dealt with them
          add(one.vendor, { ramp: b.vendor?.id || null }, { cents: one.paid ? one.cents : 0, at: one.issuedAt || b.created_at || null });
        }
        next = d?.page?.next || null;
        query = null;
      }
    } catch (e) { errors.push(`Ramp: ${e.message}`); }
  }
  // Names companies were moved onto JobTread vendors under
  const aliases = new Map();
  for (const r of (await env.DB.prepare("SELECT id, payee FROM vendor_papers WHERE payee LIKE '%aliases%'").all().catch(() => ({ results: [] }))).results || []) {
    if (!isSiteVendor(r.id)) for (const k of parseJson(r.payee).aliases || []) aliases.set(k, r.id);
  }
  let made = 0;
  for (const { name, payee } of payees.values()) {
    if (jobtreadFor(name, vendors, aliases)) continue;
    // One payee that can't be added never stops the rest
    try {
      const r = await addSiteVendor(env, { name, email: payee.email || null, payee: { mercury: payee.mercury || null, ramp: payee.ramp || null, cents12: payee.cents12 || 0, last: payee.last || null }, by: 'payees', note: 'Paid outside JobTread' }, { now });
      if (r.made) made++;
    } catch (e) {
      if (!e.jtId && errors.length < 10) errors.push(`${name}: ${e.message}`);
    }
  }
  await writeState(env.DB, STATE_KEY, { payeesAt: new Date(now).toISOString(), payees: { made, seen: payees.size, errors: errors.length ? errors : null } });
  return { made, seen: payees.size, errors };
}

// ─── Once: the files JobTread already had ───────────────────────────

const inFolder = (f) => String(f.folder || '').toLowerCase() === FOLDER.toLowerCase();

/** What JobTread's file tags and folder say a file is → 'w9' | 'coi' | null */
export function docOfJobTreadFile(f, tags) {
  const ids = (f.fileTags?.nodes || []).map((t) => t.id);
  if (tags?.w9 && ids.includes(tags.w9)) return 'w9';
  if (tags?.coi && ids.includes(tags.coi)) return 'coi';
  if (!inFolder(f)) return null;
  // Names as people save them: fw9.pdf, TKO_W9.pdf, TKOW9.pdf, 2026W9.pdf, COI_2026.pdf, ACORD_25.pdf, GLcert.pdf,
  // WorkersComp.pdf (only what's in this folder is asked, so a "w9" anywhere in the name is the W-9)
  const n = String(f.name || '').toLowerCase();
  if (/w[\s_-]?9(?![0-9])/.test(n)) return 'w9';
  if (/coi|acord|insur|cert|liab|worker|work[\s_-]?comp|(^|[^a-z])(gl|wc)/.test(n)) return 'coi';
  return null;
}

/**
 * JobTread's W-9s and certificates, moved here. A few vendors' files at a time, from the heartbeat: every file in a
 * vendor's "W-9 & Insurance" folder, or tagged W-9 or COI anywhere on the account, is copied here (with what the
 * certificate search read from the same bytes), read back from storage and checked against JobTread's byte for byte,
 * and only then deleted from JobTread (Peter, Nov 2 2026: JobTread keeps no copies). The fields aren't touched:
 * JobTread's were the start (settlePapers). When JobTread refuses a delete, deleting stops and says why (tried again
 * a day later); copying goes on. A pass that's been through every vendor starts again 6 hours later, for a file
 * someone files there by hand. → { files, removed, pages, done } or null when there's nothing to do now
 */
export async function importJobTread(env, { now = Date.now(), fetchImpl = fetch, tags = null } = {}) {
  if (!env.JOBTREAD_GRANT_KEY || !vendorBucket(env)) return null;
  await ensurePapersSchema(env.DB);
  const st = await readState(env.DB, STATE_KEY);
  const s = st.import || {};
  if (!s.page && s.lastPassAt && now - Date.parse(s.lastPassAt) < PASS_EVERY_MS) return null;
  const started = Date.now();
  const { documentType } = await import('./_vendor-read.js');
  const out = { files: 0, removed: 0, skipped: 0, pages: 0 };
  // What a certificate proves is the coverage that meets SOARD's minimums
  const [{ provenDates }, { readDocSettings }] = await Promise.all([import('./_coi-backfill.js'), import('./_vendors.js')]);
  const req = await readDocSettings(env.DB);
  // The files this pass left in JobTread, each once however often its page is read (a pass's count is its own)
  const left = new Set(s.page ? s.left || [] : []);
  const leave = (f) => { out.skipped++; left.add(f.id); };
  let deleteError = s.deleteError && now - Date.parse(s.deleteError.at) < DAY ? s.deleteError : null;
  let page = s.page || null;
  let done = false;
  const budget = () => out.files + out.removed >= IMPORT_FILES_PER_RUN || Date.now() - started > IMPORT_MS;
  // As many pages as the run's share of time allows: most vendors have no such files, so a page is quick
  while (!budget()) {
    const d = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: {
        $: { id: SOARD_ORG_ID },
        accounts: {
          // JobTread sizes a query by its worst case: 5 accounts × 50 files × 5 tags fits (./_coi-backfill.js)
          $: { size: 5, where: ['type', '=', 'vendor'], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: { id: {}, name: {}, archivedAt: {}, files: { $: { size: 50 }, nodes: { id: {}, name: {}, type: {}, size: {}, folder: {}, url: {}, createdAt: {}, fileTags: { $: { size: 5 }, nodes: { id: {} } } } } },
        },
      },
    }, fetchImpl);
    const conn = d?.organization?.accounts;
    let whole = true;
    for (const a of conn?.nodes || []) {
      for (const f of a.files?.nodes || []) {
        const doc = docOfJobTreadFile(f, tags);
        // In the W-9 & Insurance folder but not plainly either (scan0001.pdf): left there for a person, and counted
        if (!doc) { if (inFolder(f)) leave(f); continue; }
        const kept = await env.DB.prepare('SELECT id FROM vendor_files WHERE source_ref = ?').bind(`jt:${f.id}`).first();
        // Kept already and JobTread's copy can't be taken out today: nothing to do with it
        if (kept && deleteError) continue;
        if (budget()) { whole = false; break; }
        if (!f.url || (f.size && f.size > MAX_FILE_BYTES)) { leave(f); continue; }
        const res = await fetchImpl(f.url, { signal: AbortSignal.timeout(30000) }).catch(() => null);
        if (!res?.ok) { leave(f); continue; }
        const bytes = new Uint8Array(await res.arrayBuffer());
        // Only the whole file, and a real PDF or photo, is ever kept (and so ever a reason to delete JobTread's):
        // an error page answering 200, or a download cut short, is left where it is
        const type = documentType(bytes.slice(0, 16));
        if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES || (f.size && bytes.byteLength !== Number(f.size)) || !type) { leave(f); continue; }
        const hash = await sha256(bytes);
        let file = kept ? await readFile(env.DB, kept.id) : null;
        if (!file) {
          // What the certificate search read from these same bytes, when it did
          const cov = doc === 'coi' ? ((await env.DB.prepare('SELECT kind, effective, expires, insurer, each_cents, aggregate_cents FROM coi_coverage WHERE file_hash = ?').bind(hash).all().catch(() => ({ results: [] }))).results || []) : [];
          // Each policy's limits as coi_coverage keeps them: each_cents is each occurrence on liability, employer's
          // liability each accident on workers' comp (./_coi-backfill.js recordCoverage)
          const dollarsOf = (c) => (c ? c / 100 : null);
          const reading = cov.length ? { policies: cov.map((c) => ({
            kind: { gl: 'general liability', wc: 'workers compensation' }[c.kind] || c.kind, effective: c.effective, expires: c.expires, insurer: c.insurer,
            ...(c.kind === 'wc' ? { employersLiabilityEachAccident: dollarsOf(c.each_cents) } : { eachOccurrence: dollarsOf(c.each_cents), aggregate: dollarsOf(c.aggregate_cents) }),
          })) } : null;
          // The same bytes already kept as the other kind (a person said what it is): that copy is the site's
          const asOther = fileRow(await env.DB.prepare("SELECT * FROM vendor_files WHERE vendor_id = ? AND hash = ? AND doc != ? AND status != 'removed'").bind(a.id, hash, doc).first());
          const r = asOther ? { file: asOther, duplicate: true } : await keepFile(env, a.id, {
            doc, bytes, type, name: f.name, source: 'jobtread', sourceRef: `jt:${f.id}`, receivedAt: f.createdAt, by: 'import', status: 'kept',
            summary: `From JobTread’s ${f.folder || 'files'}, where it was before the site kept W-9s and certificates`, reading,
            // A certificate the search read proves its coverage that meets the minimums; a W-9 nobody checked proves nothing
            proves: reading ? provenDates(reading, req) : null,
          }, { now });
          file = r.file;
          if (!r.duplicate) out.files++;
        }
        if (deleteError) continue;
        // JobTread's copy goes only once the site's reads back as the very same bytes
        const back = await fileObject(env, file);
        const same = back && file.hash === hash && (await sha256(new Uint8Array(await back.arrayBuffer()))) === hash;
        if (!same) { leave(f); continue; }
        try {
          const r = await pave(env.JOBTREAD_GRANT_KEY, { deleteFile: { $: { id: f.id } } }, fetchImpl);
          if (r?.errors?.length) throw new Error(r.errors.map((x) => x.message || String(x)).join('; '));
          // Gone only when JobTread no longer has it, whatever its answer said
          const still = await pave(env.JOBTREAD_GRANT_KEY, { file: { $: { id: f.id }, id: {} } }, fetchImpl).then((x) => x?.file?.id, () => null);
          if (still) throw new Error('JobTread still has the file after deleting it');
          await env.DB.prepare('INSERT OR REPLACE INTO vendor_jt_removed (jt_file_id, vendor_id, file_id, name, removed_at) VALUES (?, ?, ?, ?, ?)')
            .bind(f.id, a.id, file.id, clean(f.name, 160), new Date(now).toISOString()).run();
          out.removed++;
        } catch (e) {
          deleteError = { at: new Date(now).toISOString(), error: clean(e.message, 300) };
        }
      }
      if (!whole) break;
    }
    out.pages++;
    // A page cut short is read again next run (what's kept is known by its JobTread id)
    if (!whole) break;
    page = conn?.nextPage || null;
    if (!page) { done = true; break; }
  }
  const iso = new Date(now).toISOString();
  await writeState(env.DB, STATE_KEY, {
    import: {
      files: (s.files || 0) + out.files, removed: (s.removed || 0) + out.removed, page: done ? null : page,
      // What's left in JobTread: the last whole pass's count, or this pass's so far when none has finished
      left: done ? [] : [...left].slice(0, 500), skipped: done ? left.size : s.doneAt ? s.skipped || 0 : left.size,
      doneAt: s.doneAt || (done ? iso : null), lastPassAt: done ? iso : s.lastPassAt || null, deleteError, at: iso,
    },
  });
  return { ...out, done };
}

/** Where the import and the payee search stand, for the admin and the automations map */
export async function papersFacts(env) {
  await ensurePapersSchema(env.DB);
  const st = await readState(env.DB, STATE_KEY);
  const counts = await env.DB.prepare("SELECT COUNT(*) AS files, COUNT(DISTINCT vendor_id) AS vendors FROM vendor_files WHERE status != 'removed'").first();
  const site = await env.DB.prepare("SELECT COUNT(*) AS n FROM vendor_papers WHERE id LIKE 's\\_%' ESCAPE '\\'").first();
  return {
    files: counts?.files || 0, withFiles: counts?.vendors || 0, siteCompanies: site?.n || 0,
    import: st.import || null, payees: st.payees ? { ...st.payees, at: st.payeesAt || null } : null,
    storage: env.VENDOR_FILES ? 'its own private bucket' : null,
  };
}

export const todayIn = (now = Date.now()) => isoDay(now);
