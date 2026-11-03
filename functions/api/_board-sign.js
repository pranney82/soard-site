/**
 * _board-sign.js — the record of what the board signs
 * ===========================================================================
 * A signature is evidence: who (the name they signed, the address Cloudflare
 * Access checked, their IP and device, when they signed in), what (the
 * wording's or the file's SHA-256), and how. Every step is an event in one
 * append-only chain, each event's hash over the one before it, so an edit to
 * the record afterwards shows (Georgia UETA §10-12-9's "security procedure";
 * FRE 902(14) on hashes). Nothing a signature rests on is deleted: a row
 * replaced or taken off goes into the chain whole.
 *
 * Tables (made in ./_board.js ensureSchema):
 *   board_sign_events  seq, prev (the hash before it, UNIQUE: two writers
 *                      can't both follow it), hash, doc_id (NULL: about every
 *                      paper, an ask), slug, year, version, kind, at, by, ip,
 *                      device, detail (canonical JSON)
 *   board_member_marks a member's adopted signature and initials
 *
 * The signature row's columns are SIG_COLS, the same in board_signatures and
 * board_signatures_earlier, so a row moved between them keeps every one.
 */

const enc = new TextEncoder();
const nowIso = () => new Date().toISOString();

/** SHA-256 of words or bytes, as hex */
export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON with its keys in order, so the same thing always hashes the same */
export function canonical(v) {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

// ─── The signature row ──────────────────────────────────────────────

/** The evidence columns added Nov 2026 (both signature tables) */
export const SIG_EVIDENCE = {
  ip: 'TEXT', device: 'TEXT', signin_at: 'TEXT', signer_email: 'TEXT', hash: 'TEXT', fields: 'TEXT', mark: 'TEXT',
  consent_hash: 'TEXT', process_v: 'INTEGER', record_id: 'TEXT', record_hash: 'TEXT', record_claim_at: 'TEXT', record_tries: 'INTEGER',
};
/** Every column a signature row carries, in one order for both tables */
export const SIG_COLS = ['doc_id', 'slug', 'year', 'version', 'name', 'at', 'how', 'file_id', 'drive_id', 'drive_name', 'added_by', ...Object.keys(SIG_EVIDENCE)];

/** A signature row written whole into `table` (board_signatures or board_signatures_earlier) */
export const putSignature = (DB, table, row, verb = 'INSERT OR REPLACE') => DB.prepare(`${verb} INTO ${table} (${SIG_COLS.join(', ')}) VALUES (${SIG_COLS.map(() => '?').join(', ')})`)
  .bind(...SIG_COLS.map((c) => (row[c] === undefined ? null : row[c])));

/** The columns a table is missing, added once (PRAGMA, not an ALTER tried on every start) */
export async function addColumns(DB, table, cols) {
  const have = new Set((((await DB.prepare(`PRAGMA table_info(${table})`).all()).results) || []).map((c) => c.name));
  for (const [col, type] of Object.entries(cols)) {
    if (have.has(col)) continue;
    try { await DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run(); } catch { /* another isolate added it */ }
  }
}

/** Where a request came from: its IP, device and when this sign-in began (Access's token), and the address Access checked */
export function evidenceOf(context, { deviceOf, accessIat } = {}) {
  const r = context?.request;
  if (!r) return {};
  const iat = accessIat ? accessIat(r) : null;
  return {
    ip: String(r.headers.get('CF-Connecting-IP') || '').slice(0, 64),
    device: deviceOf ? deviceOf(r.headers.get('User-Agent') || '') : '',
    signinAt: iat ? new Date(iat * 1000).toISOString() : '',
    signerEmail: String(context.data?.userEmail || '').toLowerCase().slice(0, 200),
  };
}

// ─── The chain ──────────────────────────────────────────────────────

export const EVENT_KINDS = ['asked', 'reminded', 'opened', 'consented', 'signed', 'superseded', 'declined', 'copy-added', 'taken-off', 'receipt-sent', 'void-sent', 'email-changed', 'renamed', 'record-failed'];

/**
 * Write events (and the statements they go with) in one batch, each event's hash over the one before it.
 * `build()` → { stmts, events, result } is asked again when another writer got to the chain first (a UNIQUE
 * prev), so it decides on what's there then (a second device's signature already in, say); { result } alone
 * writes nothing. → result
 */
export async function appendEvents(DB, build, { tries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const plan = await build();
    if (!plan || (!plan.stmts?.length && !plan.events?.length)) return plan?.result;
    const head = await DB.prepare('SELECT hash FROM board_sign_events ORDER BY seq DESC LIMIT 1').first();
    let prev = head?.hash || 'genesis';
    const inserts = [];
    for (const e of plan.events || []) {
      if (!EVENT_KINDS.includes(e.kind)) throw new Error(`Unknown event: ${e.kind}`);
      const row = {
        doc_id: e.docId ?? null, slug: String(e.slug || ''), year: e.year ?? null, version: e.version ?? null, kind: e.kind,
        at: e.at || nowIso(), by: String(e.by || '').slice(0, 200), ip: String(e.ip || '').slice(0, 64), device: String(e.device || '').slice(0, 80),
        detail: e.detail === undefined ? '' : canonical(e.detail),
      };
      const hash = await sha256Hex(prev + canonical(row));
      inserts.push(DB.prepare('INSERT INTO board_sign_events (prev, hash, doc_id, slug, year, version, kind, at, by, ip, device, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(prev, hash, row.doc_id, row.slug, row.year, row.version, row.kind, row.at, row.by, row.ip, row.device, row.detail));
      prev = hash;
    }
    try {
      await DB.batch([...(plan.stmts || []), ...inserts]);
      return plan.result;
    } catch (err) {
      // Another writer took the same place in the chain: nothing of this batch went in; look again
      if (!/UNIQUE/i.test(String(err?.message || err)) || !/prev|board_sign_events/i.test(String(err?.message || err)) || attempt >= tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 60 * (attempt + 1)));
    }
  }
}

/** Is every event's hash still over the one before it? → { ok, count, broken: seq | null } */
export async function checkChain(DB) {
  const rows = (await DB.prepare('SELECT * FROM board_sign_events ORDER BY seq').all()).results || [];
  let prev = 'genesis';
  for (const r of rows) {
    const row = { doc_id: r.doc_id ?? null, slug: r.slug, year: r.year ?? null, version: r.version ?? null, kind: r.kind, at: r.at, by: r.by, ip: r.ip, device: r.device, detail: r.detail };
    if (r.prev !== prev || r.hash !== (await sha256Hex(prev + canonical(row)))) return { ok: false, count: rows.length, broken: r.seq };
    prev = r.hash;
  }
  return { ok: true, count: rows.length, broken: null };
}

/**
 * The slugs a member has had (a renamed member's events stay under the old slug: never rewritten), so their
 * record follows them → [slug, …older]
 */
export async function slugsOf(DB, slug) {
  const out = [slug];
  for (let i = 0; i < out.length && i < 10; i++) {
    const rows = (await DB.prepare("SELECT detail FROM board_sign_events WHERE kind = 'renamed' AND slug = ?").bind(out[i]).all()).results || [];
    for (const r of rows) { try { const from = JSON.parse(r.detail).from; if (from && !out.includes(from)) out.push(from); } catch { /* not ours */ } }
  }
  return out;
}

/** A member's events on a paper this year (or about every paper: an ask), oldest first */
export async function eventsOf(DB, { slug, year = null, docId = null }) {
  const slugs = await slugsOf(DB, slug);
  const where = [`slug IN (${slugs.map(() => '?').join(', ')})`];
  const args = [...slugs];
  if (year != null) { where.push('year = ?'); args.push(year); }
  if (docId) { where.push('(doc_id = ? OR doc_id IS NULL)'); args.push(docId); }
  return ((await DB.prepare(`SELECT * FROM board_sign_events WHERE ${where.join(' AND ')} ORDER BY seq`).bind(...args).all()).results || [])
    .map((r) => ({ ...r, detail: (() => { try { return r.detail ? JSON.parse(r.detail) : null; } catch { return null; } })() }));
}
