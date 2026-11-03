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

// ─── Signing electronically ─────────────────────────────────────────

/**
 * What a member agrees to, once, before they first sign electronically (its SHA-256 is kept with each signature):
 * the same as paper, the paper way still there, how to stop, and how to keep a copy (Georgia UETA §10-12-5)
 */
import { CONSENT_TEXT } from '../../public/admin/board-shared.js';
export { CONSENT_TEXT };
import { PROCESS_V, PROCESS_TEXT, dueOn, dueWords } from '../../public/admin/board-shared.js';
export { PROCESS_V, PROCESS_TEXT, dueOn, dueWords };
/** The handwriting a typed signature can take (portal.css @font-face; the signed copy embeds the same) */
import { SIGN_STYLES as STYLES } from '../../public/admin/board-shared.js';
export const SIGN_STYLES = STYLES.map((x) => x.id);

/**
 * A member's adopted signature, checked: { type: 'typed'|'drawn', style, text (their name, as typed), path (drawn:
 * an SVG path of M, L, Q, C commands), initials (1–4 letters) } → the mark, or an Error's message
 */
export function cleanMark(raw = {}) {
  const type = raw.type === 'drawn' ? 'drawn' : raw.type === 'typed' ? 'typed' : '';
  if (!type) return 'Choose how you sign: type your name, or draw it';
  const style = SIGN_STYLES.includes(raw.style) ? raw.style : SIGN_STYLES[0];
  const text = String(raw.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const initials = String(raw.initials || '').replace(/[^\p{L}]/gu, '').slice(0, 4).toUpperCase();
  const path = type === 'drawn' ? String(raw.path || '').trim() : '';
  if (type === 'drawn' && (!/^M[\d.\s,MLQC-]+$/i.test(path) || path.length > 40000 || (path.match(/[LQC]/gi) || []).length < 3)) return 'Draw your signature again: that one didn’t come through';
  return { type, style, text, initials, ...(path ? { path } : {}) };
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

export const EVENT_KINDS = ['asked', 'reminded', 'opened', 'consented', 'signed', 'superseded', 'declined', 'copy-added', 'taken-off', 'receipt-sent', 'void-sent', 'email-changed', 'notice-sent', 'renamed', 'record-failed'];

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

// ─── The signed copy ────────────────────────────────────────────────

import { mdBlocks, mdInline } from '../../public/admin/board-md.js';
import { styleFont } from '../../public/admin/board-shared.js';

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ET = 'America/New_York';
const whenEt = (iso) => (iso ? `${new Date(iso).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: ET })} Eastern` : '');
const dayEt = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: ET }) : '');
const SITE = 'https://sunshineonaranneyday.com';
const HOWS = { typed: 'Typed their name on the board page', drawn: 'Drew their signature on the board page', copy: 'Added a copy they signed on paper', staff: 'A copy they signed on paper, added by SOARD', drive: 'A copy they signed on paper, in SOARD’s Drive' };

/** A block's words as HTML: bold, italic, line breaks; a link as its words (the copy is read, not clicked) */
function inlineHtml(text) {
  return mdInline(text).map((r) => (r.br ? '<br>' : `${r.b ? '<strong>' : ''}${r.i ? '<em>' : ''}${escHtml(r.text)}${r.i ? '</em>' : ''}${r.b ? '</strong>' : ''}`)).join('');
}
/** What a member gave on a marked point, beside it */
function fieldHtml(f, style) {
  if (!f) return '';
  return f.kind === 'initials'
    ? `<p class="fld"><span class="ini" style="font-family:'${escHtml(styleFont(style))}',cursive">${escHtml(f.value)}</span><span class="lbl">Initialed</span></p>`
    : `<p class="fld"><span class="lbl">Answer:</span> <span class="ans">${escHtml(f.value)}</span></p>`;
}
function blocksHtml(blocks, fields, style) {
  return blocks.map((b) => {
    if (b.t === 'p') return `<p>${inlineHtml(b.text)}</p>${b.field ? fieldHtml(fields.find((f) => f.n === b.n), style) : ''}`;
    if (b.t === 'h') return `<h2>${inlineHtml(b.text)}</h2>`;
    if (b.t === 'quote') return `<blockquote>${blocksHtml(b.blocks, fields, style)}</blockquote>`;
    if (b.t === 'hr') return '';
    const tag = b.t === 'ol' ? 'ol' : 'ul';
    return `<${tag}${b.t === 'ol' && b.start !== 1 ? ` start="${Number(b.start) || 1}"` : ''}>${b.items.map((it) => `<li>${blocksHtml(it, fields, style)}</li>`).join('')}</${tag}>`;
  }).join('');
}
/** A drawn signature's path, checked again (it only ever holds M, L, Q, C and numbers) */
const safePath = (p) => (/^M[\d.\s,MLQC-]+$/i.test(String(p || '')) ? String(p) : '');
function markHtml(mark, name) {
  if (mark?.type === 'drawn' && safePath(mark.path)) return `<svg class="drawn" viewBox="0 0 600 200" aria-label="Signature, drawn"><path d="${escHtml(safePath(mark.path))}"/></svg>`;
  if (mark?.text) return `<span class="typed" style="font-family:'${escHtml(styleFont(mark.style))}',cursive">${escHtml(mark.text)}</span>`;
  return `<span class="plain">${escHtml(name)}</span>`;
}

/** The fonts the copy is drawn in, inlined (the page loads nothing from outside): the site's, and the handwritings */
const FONT_FILES = [
  ['Outfit', 'outfit-latin-variable.woff2', '100 900', ''], ['Outfit', 'outfit-latin-ext-variable.woff2', '100 900', 'U+0100-024F, U+1E00-1EFF'],
  ['Libre Baskerville', 'libre-baskerville-latin-400-normal.woff2', '400', ''], ['Libre Baskerville', 'libre-baskerville-latin-ext-variable.woff2', '400 700', 'U+0100-024F, U+1E00-1EFF'],
  ['Dancing Script', 'dancing-script-latin.woff2', '400 700', ''], ['Dancing Script', 'dancing-script-latin-ext.woff2', '400 700', 'U+0100-024F, U+1E00-1EFF'],
  ['Caveat', 'caveat-latin.woff2', '400 700', ''], ['Caveat', 'caveat-latin-ext.woff2', '400 700', 'U+0100-024F, U+1E00-1EFF'],
  ['Great Vibes', 'great-vibes-latin.woff2', '400', ''], ['Great Vibes', 'great-vibes-latin-ext.woff2', '400', 'U+0100-024F, U+1E00-1EFF'],
];
function base64Of(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export async function fontFaces(env) {
  if (!env?.ASSETS?.fetch) return '';
  const out = [];
  for (const [family, file, weight, range] of FONT_FILES) {
    try {
      const res = await env.ASSETS.fetch(new Request(`${SITE}/fonts/${file}`));
      if (!res.ok) continue;
      const b64 = base64Of(new Uint8Array(await res.arrayBuffer()));
      out.push(`@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64}) format('woff2');font-weight:${weight};${range ? `unicode-range:${range};` : ''}}`);
    } catch { /* drawn in the fallback face */ }
  }
  return out.join('\n');
}

/**
 * The paper as signed, then its signing record, as HTML for the server's browser to print: SOARD's name, the words
 * (each initial and answer beside its point), the signature (typed in its handwriting, or drawn) and the date; then
 * who, when, from where, on which wording (its SHA-256), how, and each step. Every value escaped; nothing loaded.
 */
export function recordHtml({ doc, body, sig, member, events = [], fonts = '', fileOnly = false, signedHash = '', consent = null }) {
  const fields = (() => { try { return sig.fields ? JSON.parse(sig.fields) : []; } catch { return []; } })();
  const mark = (() => { try { return sig.mark ? JSON.parse(sig.mark) : null; } catch { return null; } })();
  const year = sig.year;
  const blocks = fileOnly ? [] : mdBlocks(body);
  const keep = blocks.length && blocks[blocks.length - 1].t === 'p' && !blocks[blocks.length - 1].field ? 1 : 0;
  const head = blocks.slice(0, blocks.length - keep);
  const last = blocks.slice(blocks.length - keep);
  const ofKind = (k) => events.filter((e) => e.kind === k);
  // A paper read as its file has no wording number to give (its file's SHA-256 says which)
  const wording = fileOnly || !(Number(sig.version) > 0) ? '' : `wording ${Number(sig.version)}`;
  // Agreeing to sign electronically: once, on whichever paper came first, so it's the member's, not this paper's
  const agreedAt = consent?.at || ofKind('consented')[0]?.at || '';
  const rows = [
    ['Paper', `${escHtml(doc.title)}${fileOnly ? ' (its file)' : wording ? `, ${wording}` : ''}`],
    ['Its SHA-256', `<code>${escHtml(sig.hash || 'not recorded')}</code>`],
    ['Signed by', escHtml(sig.name || member?.name || sig.slug)],
    ['Signed in as', escHtml(sig.signer_email || member?.email || '')],
    ['How', escHtml(HOWS[sig.how] || HOWS.typed)],
    ['Signed', `${escHtml(whenEt(sig.at))}<br><span class="m">${escHtml(sig.at || '')} UTC</span>`],
    ['From', escHtml([sig.ip, sig.device].filter(Boolean).join(' · ') || 'not recorded')],
    ['This sign-in began', escHtml(sig.signin_at ? whenEt(sig.signin_at) : 'not recorded')],
    ...(agreedAt && sig.consent_hash ? [['Agreed to sign electronically', `${escHtml(whenEt(agreedAt))}<br><span class="m">“${escHtml(CONSENT_TEXT)}”</span><br><span class="m">Those words’ SHA-256: <code>${escHtml(sig.consent_hash)}</code></span>`]] : []),
    ...(ofKind('asked').length ? [['Asked by email', escHtml(ofKind('asked').map((e) => whenEt(e.at)).join('; '))]] : []),
    ...(ofKind('opened').length ? [['First opened', escHtml(whenEt(ofKind('opened')[0].at))]] : []),
    ...(fields.length ? [['Initials and answers', fields.map((f) => `${f.kind === 'initials' ? 'Initialed' : 'Answered'} point ${f.n} (“${escHtml(f.text)}”): ${escHtml(f.value)}`).join('<br>')]] : []),
    ['Its event in the record', `<code>${escHtml(signedHash || '')}</code>`],
    ['Document ID', `<code>${escHtml(`${sig.doc_id}/${sig.slug}/${year}/${Number(sig.version) || 0}`)}</code>`],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escHtml(doc.title)}, signed by ${escHtml(sig.name)}</title><style>
${fonts}
@page{size:Letter;margin:0.75in 0.8in}
*{box-sizing:border-box}
body{margin:0;font-family:'Outfit',Helvetica,Arial,sans-serif;font-size:11pt;line-height:1.5;color:#2D2F2C}
.org{margin:0 0 4pt;font-size:8.5pt;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#765C00}
h1{margin:0 0 4pt;font-family:'Libre Baskerville',Georgia,serif;font-size:20pt;line-height:1.2;font-weight:700}
.sub{margin:0 0 16pt;color:#5F615A;font-size:10pt}
h2{margin:14pt 0 4pt;font-family:'Libre Baskerville',Georgia,serif;font-size:12.5pt;break-after:avoid}
p{margin:0 0 6pt}ul,ol{margin:0 0 8pt;padding-left:18pt}li{margin:0 0 2pt}li>p{margin:0 0 2pt}
blockquote{margin:6pt 0;padding:4pt 10pt;border-left:3pt solid #FFDA24;background:#FFFAE0}
.fld{display:flex;align-items:center;gap:8pt;margin:2pt 0 8pt}
.ini{display:inline-block;min-width:34pt;padding:2pt 6pt;border:0.75pt solid #D3D0C7;border-radius:5pt;font-size:16pt;line-height:1.2;text-align:center}
.ans{font-weight:600}.lbl{color:#5F615A;font-size:9.5pt}
.sign{margin:18pt 0 0;padding:12pt 0 0;border-top:0.75pt solid #D3D0C7;break-inside:avoid}
.end{break-inside:avoid}
.sign .agree{margin:0 0 8pt;font-weight:600}
.typed{display:block;font-size:30pt;line-height:1.15}
.drawn{display:block;width:3.2in;height:auto}.drawn path{fill:none;stroke:#2D2F2C;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}
.plain{display:block;font-size:14pt;font-weight:600}
.line{width:3.4in;border-top:0.75pt solid #8C8E86;margin:2pt 0 3pt}
.rec{break-before:page}
.rec table{width:100%;border-collapse:collapse;font-size:9.5pt}
.rec th{width:30%;padding:5pt 8pt 5pt 0;text-align:left;vertical-align:top;color:#5F615A;font-weight:600}
.rec td{padding:5pt 0;vertical-align:top;border-top:0.5pt solid #E7E5DE}
.rec th{border-top:0.5pt solid #E7E5DE}
code{font-family:ui-monospace,Menlo,monospace;font-size:8pt;word-break:break-all}
.m{color:#6C6E67;font-size:8.5pt}
.how{margin:14pt 0 0;color:#5F615A;font-size:8.5pt;line-height:1.45}
</style></head><body>
<p class="org">Sunshine on a Ranney Day · Board of Directors</p>
<h1>${escHtml(doc.title)}</h1>
<p class="sub">Signed for ${escHtml(year)}${wording ? ` · ${wording}` : ''}</p>
${fileOnly ? `<p>${escHtml(doc.title)} is its file: its pages come before this one in this PDF.</p>` : blocksHtml(head, fields, mark?.style)}
<div class="end">${last.length ? blocksHtml(last, fields, mark?.style) : ''}<div class="sign"><p class="agree">I have read and agree to the ${escHtml(doc.title)} for ${escHtml(year)}.</p>
${markHtml(mark, sig.name)}<div class="line"></div><p>${escHtml(sig.name)} · ${escHtml(dayEt(sig.at))}</p></div></div>
<section class="rec"><p class="org">Signing record</p><h1>${escHtml(doc.title)}</h1><p class="sub">Signed by ${escHtml(sig.name)} for ${escHtml(year)}</p>
<table>${rows.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${v}</td></tr>`).join('')}</table>
<p class="how">${escHtml(PROCESS_TEXT)} (How signing works, version ${PROCESS_V}.)</p></section>
</body></html>`;
}

/** HTML → PDF in Cloudflare's browser: no scripts, nothing fetched (only the page's own data: fonts) */
export async function printPdf(env, html, { launch = null } = {}) {
  const { openBrowser, release } = await import('./_press-browser.js');
  const b = await openBrowser(env, launch);
  let page = null;
  try {
    page = await b.browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (r) => { const u = r.url(); if (u.startsWith('data:') || u === 'about:blank') r.continue(); else r.abort(); });
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 });
    await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
    const out = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.7in', bottom: '0.75in', left: '0.8in', right: '0.8in' } });
    return new Uint8Array(out);
  } finally {
    await page?.close().catch(() => {});
    await release(b);
  }
}

/**
 * The PDF printed, finished with pdf-lib: a paper read as its file has its own pages first (a file pdf-lib can't
 * copy, encrypted say, is attached whole instead); the exact words and the evidence attached inside; its title and
 * fingerprint in its properties → bytes
 */
export async function finishPdf(printed, { doc, sig, body = '', source = null, evidence = {} }) {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.load(printed);
  let sourceNote = '';
  if (source) {
    try {
      const src = await PDFDocument.load(source);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p, i) => out.insertPage(i, p));
    } catch (err) {
      sourceNote = /encrypt/i.test(String(err?.message || err)) ? 'encrypted' : 'unreadable';
      await out.attach(source, `${String(doc.title).replace(/[^\w .-]+/g, '').slice(0, 80) || 'paper'}.pdf`, { mimeType: 'application/pdf', description: `The paper's file as signed (${sourceNote}: attached whole)` });
    }
  }
  // Every page, the paper's own too, carries which signature it is and where it falls
  const { StandardFonts, rgb } = await import('pdf-lib');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const id = `${sig.doc_id}/${sig.slug}/${sig.year}/${Number(sig.version) || 0}`;
  const all = out.getPages();
  all.forEach((page, i) => {
    const line = `SOARD board signature ${id} · page ${i + 1} of ${all.length}`;
    const { width } = page.getSize();
    page.drawText(line, { x: (width - font.widthOfTextAtSize(line, 7)) / 2, y: 22, size: 7, font, color: rgb(0.45, 0.46, 0.43) });
  });
  if (body) await out.attach(new TextEncoder().encode(body), 'words.md', { mimeType: 'text/markdown', description: `The exact words signed (SHA-256 ${sig.hash || ''})` });
  await out.attach(new TextEncoder().encode(JSON.stringify({ ...evidence, sourceNote: sourceNote || undefined }, null, 2)), 'evidence.json', { mimeType: 'application/json', description: 'The signature and its record' });
  out.setTitle(`${doc.title}, signed by ${sig.name} for ${sig.year}`);
  out.setSubject(`Signed ${sig.at} · wording ${Number(sig.version) || 0} · SHA-256 ${sig.hash || ''}`);
  out.setKeywords(['SOARD', 'board', 'signature', String(sig.hash || '')]);
  out.setProducer('SOARD board page');
  out.setCreator('SOARD board page');
  try { out.setCreationDate(new Date(sig.at)); } catch { /* fine */ }
  return out.save();
}

// ─── Making the copy, the receipt, the notices ──────────────────────

import { sendEmailOne, EMAIL_FROM } from './_broadcast-notify.js';
import { emailShell, button, esc as escMail, panel } from './_email-shell.js';

const fromBoard = () => EMAIL_FROM.replace(/^[^<]*/, 'SOARD Board ');
const FOOT = 'You’re getting this as a member of the Sunshine on a Ranney Day Board of Directors.';
const keyOf = ({ docId, slug, year }) => [docId, slug, year];
const MAX_ATTACH = 10 * 1024 * 1024;
const TRIES = 3;

/**
 * A signature's signed copy, made once (claimed: two makers never make two): the paper as signed and its record,
 * printed in Cloudflare's browser, finished with its pages and attachments, kept as a 'record' file under the
 * member's slug. `render(html)`: a stand-in printer (tests) → { built, id, hash } | { built: false, error }
 */
export async function buildRecord(env, sigKey, { launch = null, render = null } = {}) {
  const { DB } = env;
  const [docId, slug, year] = keyOf(sigKey);
  // No browser to print with (a test, a preview without the binding): nothing tried, nothing counted against it
  if (!render && !launch && !env.BROWSER) return { built: false, error: 'no browser' };
  const now = new Date();
  const claim = await DB.prepare('UPDATE board_signatures SET record_claim_at = ? WHERE doc_id = ? AND slug = ? AND year = ? AND record_id IS NULL AND (record_claim_at IS NULL OR record_claim_at < ?)')
    .bind(now.toISOString(), docId, slug, year, new Date(now - 3 * 60_000).toISOString()).run();
  if (!claim?.meta?.changes) return { built: false, error: 'claimed' };
  const sig = await DB.prepare('SELECT * FROM board_signatures WHERE doc_id = ? AND slug = ? AND year = ?').bind(docId, slug, year).first();
  try {
    const board = await import('./_board.js');
    const docRow = await DB.prepare('SELECT data FROM board_docs WHERE id = ?').bind(docId).first();
    const doc = { id: docId, title: 'A paper', ...(docRow ? JSON.parse(docRow.data) : {}) };
    // The words of the wording signed (or, a paper read as its file, that file's pages)
    const ver = await DB.prepare('SELECT body, file_id FROM board_doc_versions WHERE doc_id = ? AND version = ?').bind(docId, Number(sig.version) || 0).first();
    const body = ver?.body || (Number(sig.version) === Number(doc.version) ? doc.body || '' : '');
    let source = null;
    if (!body) {
      const fid = ver?.file_id || (await DB.prepare("SELECT id FROM board_files WHERE owner_type = 'doc' AND owner_id = ? ORDER BY at DESC LIMIT 1").bind(docId).first())?.id;
      const f = fid ? await DB.prepare('SELECT r2_key, type FROM board_files WHERE id = ?').bind(fid).first() : null;
      const obj = f?.type === 'application/pdf' ? await board.boardFiles(env)?.get(f.r2_key) : null;
      if (obj) source = new Uint8Array(await new Response(obj.body).arrayBuffer());
    }
    const events = (await eventsOf(DB, { slug, year, docId })).filter((e) => !e.doc_id || e.doc_id === docId);
    const signedEv = [...events].reverse().find((e) => e.kind === 'signed');
    const marks = await DB.prepare('SELECT consent_at FROM board_member_marks WHERE slug = ?').bind(slug).first().catch(() => null);
    const html = recordHtml({ doc, body, sig, events, fonts: await fontFaces(env), fileOnly: !body, signedHash: signedEv?.hash || '', consent: marks?.consent_at ? { at: marks.consent_at } : null });
    const printed = render ? await render(html) : await printPdf(env, html, { launch });
    const { record_id, record_hash, record_claim_at, record_tries, ...kept } = sig;
    const evidence = { signature: { ...kept, fields: sig.fields ? JSON.parse(sig.fields) : null, mark: sig.mark ? JSON.parse(sig.mark) : null }, events: events.map(({ detail, ...e }) => ({ ...e, detail })), consent: CONSENT_TEXT, process: { version: PROCESS_V, text: PROCESS_TEXT } };
    const bytes = await finishPdf(printed, { doc, sig, body, source, evidence });
    const name = `${String(doc.title).replace(/[\\/:*?"<>|]+/g, '').slice(0, 120)}, signed by ${sig.name} ${year}.pdf`;
    const put = await board.putFile(env, { ownerType: 'record', ownerId: docId, file: new File([bytes], name, { type: 'application/pdf' }), by: 'SOARD board page', slug });
    await DB.prepare('UPDATE board_signatures SET record_id = ?, record_hash = ?, record_claim_at = NULL WHERE doc_id = ? AND slug = ? AND year = ? AND record_id IS NULL').bind(put.id, put.sha256, docId, slug, year).run();
    return { built: true, id: put.id, hash: put.sha256 };
  } catch (err) {
    await DB.prepare('UPDATE board_signatures SET record_claim_at = NULL, record_tries = COALESCE(record_tries, 0) + 1 WHERE doc_id = ? AND slug = ? AND year = ?').bind(docId, slug, year).run().catch(() => {});
    await appendEvents(DB, async () => ({ events: [{ kind: 'record-failed', docId, slug, year, version: Number(sig?.version) || 0, detail: { error: String(err?.message || err).slice(0, 300) } }] })).catch(() => {});
    return { built: false, error: String(err?.message || err) };
  }
}

/** The receipt a member gets as they sign: what, when, its fingerprints, their signed copy attached (or linked) */
export function receiptEmail({ doc, sig, attached = false, recordHash = '' }) {
  const year = sig.year;
  const heading = `You signed the ${String(doc.title).replace(/^the\s+/i, '')} for ${year}`;
  const url = `${SITE}/board/${doc.id}`;
  const when = whenEt(sig.at);
  const facts = [
    ['Signed', when],
    ['How', HOWS[sig.how] || HOWS.typed],
    ['From', [sig.ip, sig.device].filter(Boolean).join(' · ')],
    ['The words’ SHA-256', sig.hash || ''],
    ...(recordHash ? [['Your signed copy’s SHA-256', recordHash]] : []),
  ].filter(([, v]) => v);
  const copyLine = attached ? 'Your signed copy is attached: the paper as you signed it, with its signing record. It’s on the board page too.' : 'Your signed copy is on the board page, with its signing record.';
  const notYou = 'If you didn’t sign this, reply to this email now.';
  return {
    subject: heading,
    html: emailShell({
      eyebrow: 'SOARD Board',
      preheader: `${when}. ${copyLine}`,
      heading,
      intro: escMail(copyLine),
      bodyHtml: panel(facts.map(([k, v]) => `<p style="margin:0 0 6px;font-size:14px;line-height:1.45;color:#2D2E33;"><strong>${escMail(k)}:</strong> <span style="word-break:break-all;">${escMail(v)}</span></p>`).join(''))
        + `<div style="margin:18px 0 0;">${button('Open it on the board page', url)}</div>`
        + `<p style="margin:18px 0 0;font-size:14px;line-height:1.5;color:#5A5B61;">${escMail(notYou)}</p>`,
      footerHtml: FOOT,
    }),
    text: [heading, copyLine, ...facts.map(([k, v]) => `${k}: ${v}`), `Open it on the board page: ${url}`, notYou].join('\n\n'),
  };
}

/**
 * A signature's receipt, once (never twice: its own 'receipt-sent' event, and Resend's idempotency key), only for a
 * signature the member gave on the board page under this way of signing, to the address Access checked. Older,
 * staff-added and Drive signatures are never emailed. → { sent, already, why }
 */
export async function sendReceipt(env, sigKey, { replyTo = [] } = {}) {
  const { DB } = env;
  const [docId, slug, year] = keyOf(sigKey);
  const sig = await DB.prepare('SELECT * FROM board_signatures WHERE doc_id = ? AND slug = ? AND year = ?').bind(docId, slug, year).first();
  if (!sig || !(Number(sig.process_v) >= 1) || !['typed', 'drawn'].includes(sig.how) || !sig.signer_email) return { sent: false, why: 'none' };
  const key = `receipt:${docId}:${slug}:${year}:${Number(sig.version) || 0}:${sig.at}`;
  const had = ((await DB.prepare("SELECT detail FROM board_sign_events WHERE kind = 'receipt-sent' AND doc_id = ? AND slug = ? AND year = ?").bind(docId, slug, year).all()).results || [])
    .some((r) => { try { return JSON.parse(r.detail).key === key; } catch { return false; } });
  if (had) return { sent: false, already: true };
  // Its copy attached when it's made and not too big for an email; else (made later, or a copy that failed) a link
  if (!sig.record_id && (Number(sig.record_tries) || 0) < TRIES) return { sent: false, why: 'no copy yet' };
  const board = await import('./_board.js');
  const docRow = await DB.prepare('SELECT data FROM board_docs WHERE id = ?').bind(docId).first();
  const doc = { id: docId, title: 'A paper', ...(docRow ? JSON.parse(docRow.data) : {}) };
  let attachments = [];
  if (sig.record_id) {
    const f = await DB.prepare('SELECT r2_key, name, size FROM board_files WHERE id = ?').bind(sig.record_id).first();
    const obj = f && f.size <= MAX_ATTACH ? await board.boardFiles(env)?.get(f.r2_key) : null;
    if (obj) attachments = [{ filename: f.name, content: base64Of(new Uint8Array(await new Response(obj.body).arrayBuffer())) }];
  }
  const email = receiptEmail({ doc, sig, attached: attachments.length > 0, recordHash: sig.record_hash || '' });
  const r = await sendEmailOne(env, { to: sig.signer_email, ...email, from: fromBoard(), tags: [{ name: 'kind', value: 'board-receipt' }], replyTo, attachments, idempotencyKey: key });
  if (!r.sent && !r.already) return { sent: false, why: r.errors?.[0] || 'not sent' };
  await appendEvents(DB, async () => ({ events: [{ kind: 'receipt-sent', docId, slug, year, version: Number(sig.version) || 0, by: 'SOARD board page', detail: { key, to: sig.signer_email, id: r.id || null, attached: attachments.length > 0, recordHash: sig.record_hash || null } }] }));
  return { sent: true };
}

/** After a member signs on the board page: their copy made, then their receipt (the answer has gone already) */
export async function afterSigning(env, sigKey, opts = {}) {
  try {
    const { getSettings } = await import('./_board.js');
    await buildRecord(env, sigKey, opts);
    await sendReceipt(env, sigKey, { replyTo: (await getSettings(env.DB)).admins });
  } catch (err) { console.error('[board-sign] after signing', err?.message || err); }
}

/**
 * The heartbeat's part (one thing a run, never in another's way): a signature without its copy gets one (3 tries;
 * then the admins are told once and the receipt goes without it), a receipt not sent goes, an email changed on
 * People is told to the old address
 */
export async function maybeRunSigning(env, opts = {}) {
  try {
    if (!env?.DB) return;
    const { ensureSchema, getSettings } = await import('./_board.js');
    await ensureSchema(env.DB);
    const DB = env.DB;
    const stale = new Date(Date.now() - 3 * 60_000).toISOString();
    const canPrint = !!(opts.render || opts.launch || env.BROWSER);
    const due = !canPrint ? null : await DB.prepare(`SELECT doc_id, slug, year FROM board_signatures WHERE record_id IS NULL AND COALESCE(record_tries, 0) < ${TRIES} AND (record_claim_at IS NULL OR record_claim_at < ?) ORDER BY at LIMIT 1`).bind(stale).first();
    const admins = (await getSettings(DB)).admins;
    if (due) {
      const made = await buildRecord(env, { docId: due.doc_id, slug: due.slug, year: due.year }, opts);
      const after = await DB.prepare('SELECT record_tries, name, process_v FROM board_signatures WHERE doc_id = ? AND slug = ? AND year = ?').bind(due.doc_id, due.slug, due.year).first();
      if (!made.built && Number(after?.record_tries) >= TRIES) await tellAdmins(env, admins, { subject: `A signed copy couldn’t be made: ${after?.name || due.slug}`, text: `Board couldn’t make the signed copy (PDF) for ${after?.name || due.slug}’s signature (${due.doc_id}, ${due.year}) after ${TRIES} tries: ${made.error}. The signature and its record are kept; their receipt goes without the PDF.` });
      return;
    }
    // A receipt still to go (its copy made, or given up on)
    const pending = (await DB.prepare(`SELECT doc_id, slug, year FROM board_signatures WHERE process_v >= 1 AND how IN ('typed', 'drawn') AND signer_email IS NOT NULL AND (record_id IS NOT NULL OR COALESCE(record_tries, 0) >= ${TRIES}) ORDER BY at DESC LIMIT 20`).all()).results || [];
    for (const p of pending) {
      const r = await sendReceipt(env, { docId: p.doc_id, slug: p.slug, year: p.year }, { replyTo: admins });
      if (r.sent || (!r.already && r.why !== 'none')) return;
    }
    // Every board member has signed a paper: the admins told, once
    await maybeTellAllSigned(env).catch((err) => console.error('[board-sign] all signed', err?.message || err));
    // An email changed on People: the old address told, once
    const changed = ((await DB.prepare("SELECT seq, slug, detail FROM board_sign_events WHERE kind = 'email-changed' ORDER BY seq DESC LIMIT 20").all()).results || []);
    const told = new Set(((await DB.prepare("SELECT detail FROM board_sign_events WHERE kind = 'notice-sent'").all()).results || []).map((r) => { try { return JSON.parse(r.detail).for; } catch { return null; } }));
    for (const c of changed) {
      if (told.has(c.seq)) continue;
      let d = {};
      try { d = JSON.parse(c.detail); } catch { continue; }
      if (!d.from) continue;
      const r = await sendEmailOne(env, { to: d.from, from: fromBoard(), replyTo: admins, tags: [{ name: 'kind', value: 'board-email-changed' }], idempotencyKey: `email-changed:${c.seq}`, ...emailChangedEmail(d) });
      if (r.sent || r.already) await appendEvents(DB, async () => ({ events: [{ kind: 'notice-sent', slug: c.slug, by: 'SOARD board page', detail: { for: c.seq, to: d.from } }] }));
      return;
    }
  } catch (err) { console.error('[board-sign] heartbeat', err?.message || err); }
}

async function tellAdmins(env, admins, { subject, text }) {
  for (const to of admins || []) await sendEmailOne(env, { to, from: fromBoard(), subject, text, html: emailShell({ eyebrow: 'SOARD Board', heading: subject, intro: escMail(text), bodyHtml: '', footerHtml: 'Sent to the Board area’s admins.' }), tags: [{ name: 'kind', value: 'board-admin-alert' }] });
}

/** The old address told its email on the board page changed (a check after the fact on who can sign in as them) */
export function emailChangedEmail({ to = '', name = '' }) {
  const heading = 'The email SOARD has for you changed';
  const line = `${name ? `${name.split(/\s+/)[0]}, the` : 'The'} address SOARD uses for your board page is now ${to}. If you didn’t ask for this, reply to this email now.`;
  return { subject: heading, html: emailShell({ eyebrow: 'SOARD Board', heading, intro: escMail(line), bodyHtml: '', footerHtml: FOOT }), text: `${heading}\n\n${line}` };
}

/** A member told SOARD took a signature they gave off a paper (their own, typed, drawn or their copy) */
export function voidEmail({ doc, year, reason = '' }) {
  const heading = `Your signature on the ${String(doc.title).replace(/^the\s+/i, '')} was taken off`;
  const line = `SOARD took your ${year} signature off the ${doc.title}${reason ? `: ${reason}` : ''}. It’s kept on record, and the board page asks you to sign it again. Questions? Reply to this email.`;
  return { subject: heading, html: emailShell({ eyebrow: 'SOARD Board', heading, intro: escMail(line), bodyHtml: `<div style="margin:6px 0 0;">${button('Open it on the board page', `${SITE}/board/${doc.id}`)}</div>`, footerHtml: FOOT }), text: `${heading}\n\n${line}\n\n${SITE}/board/${doc.id}` };
}

// ─── Due dates, declining, asking again by itself, the whole board signed ──────────

import { isEmail, emailConfigured } from './_broadcast-notify.js';
import { activeBoard, readState } from './_board-roles.js';
import { todayEastern, welcomeHad } from '../../public/admin/board-shared.js';

const DAY = 24 * 60 * 60 * 1000;
/** Remind by email (Board → Members): off until an admin turns it on; every 3 days or weekly */
export const REMIND_EVERY = { off: 0, 3: 3, 7: 7 };
/** The reminders a member gets for a year at most; and how long past a paper's due date they still go */
export const MAX_REMINDERS = 4;
export const PAST_DUE_DAYS = 7;

const isoDay = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const addDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** The nth weekday (0 Sun … 6 Sat) of a month; n = -1: the last */
function nthWeekday(y, m, wd, n) {
  if (n > 0) { const first = weekdayOf(isoDay(y, m, 1)); return isoDay(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7); }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = weekdayOf(isoDay(y, m, lastDay));
  return isoDay(y, m, lastDay - ((last - wd + 7) % 7));
}
/** A fixed holiday on a weekend is kept on the Friday before or the Monday after */
const observed = (day) => (weekdayOf(day) === 6 ? addDay(day, -1) : weekdayOf(day) === 0 ? addDay(day, 1) : day);
/** The days SOARD sends nothing it can wait with: US federal holidays (as observed), the day after Thanksgiving, Christmas Eve and New Year's Eve */
export function usHolidays(year) {
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  return new Set([
    observed(isoDay(year, 1, 1)), nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), nthWeekday(year, 5, 1, -1),
    observed(isoDay(year, 6, 19)), observed(isoDay(year, 7, 4)), nthWeekday(year, 9, 1, 1), nthWeekday(year, 10, 1, 2),
    observed(isoDay(year, 11, 11)), thanksgiving, addDay(thanksgiving, 1), isoDay(year, 12, 24), observed(isoDay(year, 12, 25)), isoDay(year, 12, 31),
    observed(isoDay(year + 1, 1, 1)),
  ]);
}
const ET_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
/** A weekday that isn't a holiday, 8 AM to 7 PM Eastern: when a reminder can go */
export function businessHours(t = Date.now()) {
  const day = todayEastern(t);
  const hour = Number(ET_HOUR.format(new Date(t)));
  return ![0, 6].includes(weekdayOf(day)) && !usHolidays(Number(day.slice(0, 4))).has(day) && hour >= 8 && hour < 19;
}


/** A renamed member's old slugs → their slug now (events stay under the slug they were written with) */
async function currentSlugs(DB) {
  const to = {};
  for (const r of ((await DB.prepare("SELECT slug, detail FROM board_sign_events WHERE kind = 'renamed' ORDER BY seq").all()).results || [])) {
    try { const from = JSON.parse(r.detail).from; if (from) to[from] = r.slug; } catch { /* not one */ }
  }
  return (s) => { let x = s; for (let i = 0; i < 10 && to[x]; i++) x = to[x]; return x; };
}

/**
 * Who told SOARD they can't sign a paper as written this year, and why: the last word of theirs on it, so a
 * signature after a decline ends it → { docId: { slug: { at, reason } } }
 */
export async function declinedOf(DB, year) {
  const rows = (await DB.prepare("SELECT doc_id, slug, kind, at, detail FROM board_sign_events WHERE year = ? AND doc_id IS NOT NULL AND kind IN ('declined', 'signed', 'copy-added') ORDER BY seq").bind(year).all()).results || [];
  if (!rows.some((r) => r.kind === 'declined')) return {};
  const now = await currentSlugs(DB);
  const out = {};
  for (const r of rows) {
    const by = (out[r.doc_id] ||= {});
    const slug = now(r.slug);
    if (r.kind !== 'declined') { delete by[slug]; continue; }
    let d = {};
    try { d = JSON.parse(r.detail) || {}; } catch { /* no reason kept */ }
    by[slug] = { at: r.at, reason: String(d.reason || '') };
  }
  return out;
}

/** The admins told at once that a member can't sign a paper as written, and why */
export function declineEmail({ doc, name = '', reason = '', year }) {
  const heading = `${name} can’t sign the ${String(doc.title).replace(/^the\s+/i, '')} as written`;
  const line = `${name} told SOARD on the board page that they can’t sign the ${doc.title} for ${year} as it’s written.`;
  const url = `${SITE}/admin/board/#documents`;
  return {
    subject: heading,
    html: emailShell({
      eyebrow: 'SOARD Board', heading, intro: escMail(line),
      bodyHtml: panel(`<p style="margin:0;font-size:15px;line-height:1.5;color:#2D2E33;white-space:pre-wrap;">${escMail(reason)}</p>`)
        + `<p style="margin:16px 0 0;font-size:14px;line-height:1.5;color:#5A5B61;">${escMail('Reply to this email to answer them. They can still sign it later on the board page, and Board → Members shows Declined until they do.')}</p>`
        + `<div style="margin:16px 0 0;">${button('Open Board → Documents', url)}</div>`,
      footerHtml: 'Sent to the Board area’s admins.',
    }),
    text: [heading, line, `Why: ${reason}`, 'Reply to this email to answer them. They can still sign it later on the board page, and Board → Members shows Declined until they do.', url].join('\n\n'),
  };
}

/**
 * A member says they can't sign a paper as written, and why: kept in the chain, the admins emailed (once in ten
 * minutes: a second press only changes the reason kept). They can still sign it later. → { at, reason, tell }
 */
export async function declineDoc(DB, docId, member, { reason = '', evidence = {}, year: pageYear = null } = {}) {
  const board = await import('./_board.js');
  await board.ensureSchema(DB);
  const year = Number(todayEastern().slice(0, 4));
  if (pageYear != null && Number(pageYear) !== year) throw Object.assign(new Error(`It’s ${year} now. Reload the page.`), { status: 409, extra: { newYear: true } });
  const doc = (await board.listDocs(DB)).find((d) => d.id === docId);
  if (!doc?.shared || !doc.sign) throw Object.assign(new Error('That paper isn’t one to sign'), { status: 404 });
  if (doc.signed[member.slug]) throw Object.assign(new Error('You’ve signed it for this year already'), { status: 409 });
  const why = String(reason || '').replace(/\r\n?/g, '\n').trim().slice(0, 1000);
  if (why.length < 3) throw Object.assign(new Error('Say what you can’t agree to, so SOARD can answer'), { status: 400 });
  const at = new Date().toISOString();
  const was = doc.declined?.[member.slug];
  await appendEvents(DB, async () => ({ events: [{ kind: 'declined', docId, slug: member.slug, year, version: doc.version, at, by: evidence.signerEmail || member.email || '', ip: evidence.ip, device: evidence.device, detail: { reason: why } }] }));
  return { at, reason: why, tell: !was || Date.now() - Date.parse(was.at) > 10 * 60 * 1000, doc, year };
}

/** The admins emailed a member's decline (after the answer has gone) */
export async function tellDeclined(env, { doc, member, reason, year }) {
  const { getSettings } = await import('./_board.js');
  const admins = (await getSettings(env.DB)).admins || [];
  const email = declineEmail({ doc, name: member.name, reason, year });
  for (const to of admins) {
    await sendEmailOne(env, { to, from: fromBoard(), replyTo: isEmail(member.email) ? [member.email] : [], tags: [{ name: 'kind', value: 'board-declined' }], ...email });
  }
}

/**
 * Remind by email, when an admin has turned it on: each board member who hasn't signed this year's papers gets one
 * email naming every one they haven't (not one they declined, nor one more than a week past its due date), `every`
 * days after they were last asked (or had the sign-in email), on a weekday 8 AM to 7 PM Eastern that isn't a
 * holiday, at most MAX_REMINDERS times a year. A new year begins with everyone unsigned, so the first weekday of
 * January asks them all. Each send is claimed (two heartbeats never email anyone twice). → { sent, … }
 */
export async function maybeRemindSigners(env, { now = Date.now(), limit = 10 } = {}) {
  const board = await import('./_board.js');
  const { DB } = env;
  const settings = await board.getSettings(DB);
  const every = REMIND_EVERY[settings.remind] || 0;
  if (!every) return { off: true };
  if (!emailConfigured(env)) return { off: true, why: 'email' };
  if (!businessHours(now)) return { waiting: 'hours' };
  const today = todayEastern(now);
  const year = Number(today.slice(0, 4));
  const [members, docs, people] = await Promise.all([activeBoard(DB), board.listDocs(DB, year), board.roster(DB)]);
  const signable = docs.filter((d) => d.shared && d.sign && (d.body || (d.file && !d.file.staffOnly)));
  if (!signable.length) return { sent: 0, none: true };
  const asks = Object.fromEntries((((await DB.prepare('SELECT slug, at, n, reminders FROM board_sign_asks WHERE year = ?').bind(year).all()).results) || []).map((r) => [r.slug, r]));
  const w = await readState(DB, 'welcome');
  const onBoard = members.map((p) => p.slug);
  const inviter = board.staffFor(people, settings.invitesFrom);
  let sent = 0;
  for (const p of members) {
    if (sent >= limit) break;
    if (!isEmail(p.email)) continue;
    const papers = signable.filter((d) => !d.signed[p.slug] && !d.declined?.[p.slug] && !(dueOn(d, year) && today > addDay(dueOn(d, year), PAST_DUE_DAYS)));
    if (!papers.length) continue;
    const a = asks[p.slug];
    if ((Number(a?.reminders) || 0) >= MAX_REMINDERS) continue;
    const welcomed = Date.parse(welcomeHad(w, p, onBoard) || '') || 0;
    const last = Math.max(a ? Date.parse(a.at) || 0 : 0, welcomed);
    if (last && now - last < every * DAY) continue;
    // Claimed: theirs to send only when this heartbeat moved their row
    const at = new Date(now).toISOString();
    const claim = a
      ? await DB.prepare('UPDATE board_sign_asks SET at = ?, by = ?, n = n + 1, reminders = COALESCE(reminders, 0) + 1 WHERE slug = ? AND year = ? AND at = ?').bind(at, 'SOARD board page', p.slug, year, a.at).run()
      : await DB.prepare('INSERT INTO board_sign_asks (slug, year, at, by, n, reminders) VALUES (?, ?, ?, ?, 1, 1) ON CONFLICT(slug, year) DO NOTHING').bind(p.slug, year, at, 'SOARD board page').run();
    if (!claim?.meta?.changes) continue;
    const n = (Number(a?.reminders) || 0) + 1;
    const email = board.signAskEmail({ name: p.name, email: p.email, papers: papers.map((d) => ({ title: d.title, id: d.id, due: dueOn(d, year) })), from: inviter?.name || '', firstTime: !welcomed && !a, reminder: !!a || !!welcomed });
    const r = await sendEmailOne(env, { to: p.email, ...email, replyTo: settings.admins, tags: [{ name: 'kind', value: 'board-sign-reminder' }], idempotencyKey: `remind:${p.slug}:${year}:${n}` });
    if (!r.sent && !r.already) {
      // Not sent: their row as it was, to try on a later heartbeat
      if (a) await DB.prepare('UPDATE board_sign_asks SET at = ?, by = ?, n = n - 1, reminders = COALESCE(reminders, 1) - 1 WHERE slug = ? AND year = ? AND at = ?').bind(a.at, a.by || '', p.slug, year, at).run().catch(() => {});
      else await DB.prepare('DELETE FROM board_sign_asks WHERE slug = ? AND year = ? AND at = ?').bind(p.slug, year, at).run().catch(() => {});
      continue;
    }
    await appendEvents(DB, async () => ({ events: [{ kind: 'reminded', docId: null, slug: p.slug, year, at, by: 'SOARD board page', detail: { to: p.email, papers: papers.map((d) => d.id), n } }] }));
    sent++;
  }
  return { sent };
}

/**
 * The admins told, once a paper and year, when every board member has signed it: the last one within a week (so a
 * board that signed long ago isn't announced again)
 */
export async function maybeTellAllSigned(env, { now = Date.now() } = {}) {
  const board = await import('./_board.js');
  const { DB } = env;
  const year = Number(todayEastern(now).slice(0, 4));
  const [members, docs] = await Promise.all([activeBoard(DB), board.listDocs(DB, year)]);
  if (!members.length) return;
  for (const d of docs.filter((x) => x.shared && x.sign)) {
    const sigs = members.map((p) => d.signed[p.slug]);
    if (sigs.some((s) => !s)) continue;
    const lastAt = Math.max(...sigs.map((s) => Date.parse(s.at) || 0));
    if (now - lastAt > 7 * DAY) continue;
    const key = `all-signed:${d.id}:${year}`;
    if ((await readState(DB, key)).at) continue;
    const claim = await DB.prepare('INSERT INTO board_state (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').bind(key, JSON.stringify({ at: new Date(now).toISOString() }), new Date(now).toISOString()).run();
    if (!claim?.meta?.changes) continue;
    const subject = `Every board member has signed the ${String(d.title).replace(/^the\s+/i, '')} for ${year}`;
    const text = `All ${members.length} board members have signed the ${d.title} for ${year}. Each signature, its signed copy and its record are in Board → Members, and Documents → ${d.title} downloads the year’s record.`;
    await tellAdmins(env, (await board.getSettings(DB)).admins, { subject, text });
  }
}

// ─── The year's record, for an auditor: one ZIP ─────────────────────

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

/** A name in plain letters, for a ZIP tool that only reads those ("José Muñoz-Ångström" → "Jose Munoz-Angstrom") */
const FOLD = { ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ß: 'ss', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', þ: 'th', Þ: 'Th', ð: 'd', Ð: 'D', ı: 'i', '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-' };
export const asciiName = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, (c) => FOLD[c] ?? '_');

/**
 * A ZIP written as it goes (STORE: PDFs and photos don't shrink), one file in memory at a time. Each name is in
 * plain letters, with the name as it is (a member's accented name) in Info-ZIP's Unicode path field, which the
 * Mac's and Windows' own tools read. → { readable, add(name, bytes, at), close() }
 */
export function zipWriter() {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const central = [];
  let offset = 0;
  const dos = (d) => ({ time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() });
  const add = async (name, data, at = new Date()) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
    const nameBytes = enc.encode(asciiName(name));
    // (0x7075: version 1, the plain name's CRC, the name in UTF-8)
    const utf8 = enc.encode(name);
    const extra = asciiName(name) === name ? new Uint8Array(0) : (() => {
      const x = new Uint8Array(9 + utf8.length);
      const xv = new DataView(x.buffer);
      xv.setUint16(0, 0x7075, true); xv.setUint16(2, 5 + utf8.length, true); x[4] = 1; xv.setUint32(5, crc32(nameBytes), true);
      x.set(utf8, 9);
      return x;
    })();
    const crc = crc32(bytes);
    const { time, date } = dos(at instanceof Date && !Number.isNaN(+at) ? at : new Date());
    const head = new Uint8Array(30 + nameBytes.length + extra.length);
    const v = new DataView(head.buffer);
    v.setUint32(0, 0x04034B50, true); v.setUint16(4, 20, true); v.setUint16(6, 0, true); v.setUint16(8, 0, true);
    v.setUint16(10, time, true); v.setUint16(12, date, true); v.setUint32(14, crc, true); v.setUint32(18, bytes.length, true); v.setUint32(22, bytes.length, true);
    v.setUint16(26, nameBytes.length, true); v.setUint16(28, extra.length, true);
    head.set(nameBytes, 30);
    head.set(extra, 30 + nameBytes.length);
    central.push({ nameBytes, extra, crc, size: bytes.length, offset, time, date });
    await w.write(head);
    await w.write(bytes);
    offset += head.length + bytes.length;
  };
  const close = async () => {
    let size = 0;
    for (const e of central) {
      const c = new Uint8Array(46 + e.nameBytes.length + e.extra.length);
      const v = new DataView(c.buffer);
      v.setUint32(0, 0x02014B50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0, true); v.setUint16(10, 0, true);
      v.setUint16(12, e.time, true); v.setUint16(14, e.date, true); v.setUint32(16, e.crc, true); v.setUint32(20, e.size, true); v.setUint32(24, e.size, true);
      v.setUint16(28, e.nameBytes.length, true); v.setUint16(30, e.extra.length, true); v.setUint32(42, e.offset, true);
      c.set(e.nameBytes, 46);
      c.set(e.extra, 46 + e.nameBytes.length);
      await w.write(c);
      size += c.length;
    }
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054B50, true); v.setUint16(8, central.length, true); v.setUint16(10, central.length, true); v.setUint32(12, size, true); v.setUint32(16, offset, true);
    await w.write(end);
    await w.close();
  };
  return { readable, add, close, abort: (err) => w.abort(err).catch(() => {}) };
}

/** A spreadsheet cell: quoted when it needs it, and never a formula (a cell starting = + - @ is read as text) */
export const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fileSafe = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';

/**
 * Everything a paper's signing rests on for a year, for an auditor: each signature (this year's, and earlier ones
 * replaced or taken off), each member's signed copy and record, each copy signed on paper (and an iPhone photo's
 * original), the exact wordings signed, every event in the chain about it with the chain's check, a spreadsheet, a
 * summary, how signing works and what members agreed to. Members who've left the board are in it.
 */
export async function exportYear(env, docId, year, { waitUntil = null } = {}) {
  const board = await import('./_board.js');
  const { DB } = env;
  await board.ensureSchema(DB);
  const docRow = await DB.prepare('SELECT data FROM board_docs WHERE id = ?').bind(docId).first();
  if (!docRow) return Response.json({ ok: false, error: 'That paper is gone' }, { status: 404 });
  const doc = { id: docId, ...JSON.parse(docRow.data) };
  const y = Number(year) || Number(todayEastern().slice(0, 4));
  const [now, earlier, members, docs, events, versions, asks] = await Promise.all([
    DB.prepare('SELECT * FROM board_signatures WHERE doc_id = ? AND year = ? ORDER BY name').bind(docId, y).all().then((r) => r.results || []),
    DB.prepare('SELECT * FROM board_signatures_earlier WHERE doc_id = ? AND year = ? ORDER BY name, at').bind(docId, y).all().then((r) => r.results || []).catch(() => []),
    activeBoard(DB), board.listDocs(DB, y),
    DB.prepare('SELECT * FROM board_sign_events WHERE year = ? AND (doc_id = ? OR doc_id IS NULL) ORDER BY seq').bind(y, docId).all().then((r) => r.results || []),
    DB.prepare('SELECT version, body, at, by, note, hash, file_id FROM board_doc_versions WHERE doc_id = ? ORDER BY version').bind(docId).all().then((r) => r.results || []),
    board.signAsks(DB, y),
  ]);
  const listed = docs.find((d) => d.id === docId) || { declined: {} };
  const chain = await checkChain(DB);
  const rows = [
    ...now.map((s) => ({ ...s, status: 'Signed' })),
    ...earlier.map((s) => ({ ...s, status: 'Earlier signature (replaced or taken off)' })),
    ...members.filter((p) => !now.some((s) => s.slug === p.slug)).map((p) => ({ slug: p.slug, name: p.name, status: listed.declined?.[p.slug] ? 'Declined' : 'Not signed', reason: listed.declined?.[p.slug]?.reason || '' })),
  ];
  const fieldsOf = (s) => { try { return JSON.parse(s.fields || 'null') || []; } catch { return []; } };
  const head = ['Name', 'Status', 'How', 'Signed (Eastern)', 'Signed (UTC)', 'Wording', 'Words or file SHA-256', 'Signed in as', 'IP', 'Device', 'Sign-in began', 'Agreed to sign electronically (SHA-256 of the words)', 'Initials and answers', 'Signed copy SHA-256', 'Added by', 'Asked', 'Declined because'];
  const csv = [head, ...rows.map((s) => [
    s.name || s.slug, s.status, s.how ? (HOWS[s.how] || s.how) : '', s.at ? whenEt(s.at) : '', s.at || '', s.version ?? '', s.hash || '', s.signer_email || '', s.ip || '', s.device || '',
    s.signin_at || '', s.consent_hash || '', fieldsOf(s).map((f) => `${f.kind === 'initials' ? 'Initialed' : 'Answered'} ${f.n}: ${f.value}`).join('; '), s.record_hash || '', s.added_by || '',
    asks[s.slug] ? `${asks[s.slug].n} (last ${whenEt(asks[s.slug].at)})` : '', s.reason || '',
  ])].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const title = String(doc.title || 'Paper');
  const summary = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escHtml(title)}: who signed for ${y}</title><style>${await fontFaces(env)}
body{margin:0;font-family:'Outfit',Helvetica,Arial,sans-serif;font-size:10pt;color:#2D2F2C}h1{font-family:'Libre Baskerville',Georgia,serif;font-size:18pt;margin:0 0 4pt}.org{margin:0 0 4pt;font-size:8pt;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#765C00}.sub{color:#5F615A;margin:0 0 14pt}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:5pt 6pt 5pt 0;border-top:.5pt solid #E7E5DE}th{color:#5F615A;font-weight:600}code{font-family:ui-monospace,Menlo,monospace;font-size:7pt;word-break:break-all}.how{margin:14pt 0 0;color:#5F615A;font-size:8pt}
</style></head><body><p class="org">Sunshine on a Ranney Day · Board of Directors</p><h1>${escHtml(title)}</h1><p class="sub">Who signed for ${y} · made ${escHtml(whenEt(new Date().toISOString()))} · the record’s chain of ${chain.count} events ${chain.ok ? 'checks out' : `is broken at event ${chain.broken}`}</p>
<table><tr><th>Name</th><th>Status</th><th>When</th><th>How</th><th>Signed copy SHA-256</th></tr>${rows.map((s) => `<tr><td>${escHtml(s.name || s.slug)}</td><td>${escHtml(s.status)}${s.reason ? `: ${escHtml(s.reason)}` : ''}</td><td>${escHtml(s.at ? whenEt(s.at) : '')}</td><td>${escHtml(s.how ? HOWS[s.how] || s.how : '')}</td><td><code>${escHtml(s.record_hash || '')}</code></td></tr>`).join('')}</table>
<p class="how">${escHtml(PROCESS_TEXT)} (How signing works, version ${PROCESS_V}.)</p></body></html>`;
  const readme = [
    `${title}: the signing record for ${y}`,
    `Made ${whenEt(new Date().toISOString())} by SOARD's board page.`,
    '',
    'signatures.csv      every signature this year (and earlier ones replaced or taken off), and each board member who hasn’t signed',
    `summary.${env.BROWSER ? 'pdf' : 'html'}         the same, to print`,
    'signed-copies/      each member’s signed copy: the paper as signed, then its signing record page (the words and the evidence are attached inside each PDF)',
    'copies-on-paper/    copies signed on paper, as they came in (an iPhone photo’s original beside its JPEG)',
    'wordings/           the exact words of each wording signed, with their SHA-256 in signatures.csv',
    'events.json         every event about this paper this year, each hashed over the one before (the whole chain checked)',
    '',
    `The chain: ${chain.count} events, ${chain.ok ? 'every hash checks out' : `broken at event ${chain.broken}`}.`,
    '',
    `How signing works (version ${PROCESS_V}): ${PROCESS_TEXT}`,
    '',
    `What each member agreed to before signing electronically: “${CONSENT_TEXT}”`,
  ].join('\r\n');
  const zip = zipWriter();
  const write = (async () => {
    try {
      await zip.add('README.txt', readme);
      await zip.add('signatures.csv', `﻿${csv}`);
      let printed = null;
      if (env.BROWSER) { try { printed = await printPdf(env, summary); } catch { printed = null; } }
      await zip.add(printed ? 'summary.pdf' : 'summary.html', printed || summary);
      const signedVersions = new Set([...now, ...earlier].map((s) => Number(s.version) || 0));
      for (const v of versions.filter((x) => signedVersions.has(Number(x.version)) && x.body)) await zip.add(`wordings/wording ${v.version}.md`, v.body);
      const files = board.boardFiles(env);
      const put = async (folder, id, label) => {
        const f = id ? await DB.prepare('SELECT r2_key, name, at FROM board_files WHERE id = ?').bind(id).first() : null;
        const obj = f && files ? await files.get(f.r2_key) : null;
        if (obj) await zip.add(`${folder}/${fileSafe(label)} - ${fileSafe(f.name)}`, new Uint8Array(await new Response(obj.body).arrayBuffer()), new Date(f.at || Date.now()));
      };
      // A paper read as its file: each file a signature rests on
      for (const v of versions.filter((x) => signedVersions.has(Number(x.version)) && !x.body && x.file_id)) await put('wordings', v.file_id, `wording ${v.version}`);
      for (const s of [...now, ...earlier]) {
        await put('signed-copies', s.record_id, s.name || s.slug);
        await put('copies-on-paper', s.file_id, s.name || s.slug);
      }
      // (every copy kept for them on this paper: replaced, and photos' originals)
      const kept = (await DB.prepare("SELECT id, slug FROM board_files WHERE owner_type = 'signed' AND owner_id = ? AND (superseded_at IS NOT NULL OR id IN (SELECT original_id FROM board_files WHERE original_id IS NOT NULL))").bind(docId).all()).results || [];
      const names = Object.fromEntries([...now, ...earlier].map((s) => [s.slug, s.name]));
      for (const k of kept.filter((x) => names[x.slug])) await put('copies-on-paper', k.id, `${names[k.slug]} (kept)`);
      await zip.add('events.json', JSON.stringify({ paper: { id: docId, title }, year: y, chain, events: events.map((e) => ({ ...e, detail: (() => { try { return e.detail ? JSON.parse(e.detail) : null; } catch { return e.detail; } })() })) }, null, 2));
      await zip.close();
    } catch (err) { console.error('[board-sign] export', err?.message || err); zip.abort(err); }
  })();
  // (written while it downloads: the request stays alive until the last file is in)
  waitUntil?.(write);
  return new Response(zip.readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fileSafe(`${title} ${y} signing record`).replace(/[^\x20-\x7e]/g, '')}.zip"; filename*=UTF-8''${encodeURIComponent(`${fileSafe(`${title} ${y} signing record`)}.zip`)}`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * For Site → Automations: counts, times and on/off only (no names): signed copies made and waiting, receipts and
 * reminders sent this year, Remind by email's setting
 */
export async function signingFacts(env) {
  const board = await import('./_board.js');
  const { DB } = env;
  await board.ensureSchema(DB);
  const year = Number(todayEastern().slice(0, 4));
  const one = async (sql, ...args) => (await DB.prepare(sql).bind(...args).first()) || {};
  const [copies, waiting, failed, receipts, reminders, declines, settings] = await Promise.all([
    one('SELECT COUNT(*) AS n, MAX(at) AS last FROM board_signatures WHERE record_id IS NOT NULL'),
    one(`SELECT COUNT(*) AS n FROM board_signatures WHERE record_id IS NULL AND COALESCE(record_tries, 0) < ${TRIES}`),
    one(`SELECT COUNT(*) AS n FROM board_signatures WHERE record_id IS NULL AND COALESCE(record_tries, 0) >= ${TRIES}`),
    one("SELECT COUNT(*) AS n, MAX(at) AS last FROM board_sign_events WHERE kind = 'receipt-sent' AND year = ?", year),
    one("SELECT COUNT(*) AS n, MAX(at) AS last FROM board_sign_events WHERE kind = 'reminded' AND year = ?", year),
    one("SELECT COUNT(*) AS n FROM board_sign_events WHERE kind = 'declined' AND year = ?", year),
    board.getSettings(DB),
  ]);
  return {
    browser: !!env.BROWSER, remind: settings.remind,
    copies: Number(copies.n) || 0, copiesLast: copies.last || null, waiting: Number(waiting.n) || 0, failed: Number(failed.n) || 0,
    receipts: Number(receipts.n) || 0, receiptsLast: receipts.last || null, reminders: Number(reminders.n) || 0, remindersLast: reminders.last || null, declines: Number(declines.n) || 0,
  };
}
