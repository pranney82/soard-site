/**
 * Reading a W-9 or a certificate of insurance, and judging it
 * ===========================================================================
 * What a vendor uploads on their trade-partner page (./_vendors.js files it) is
 * read here by Workers AI. A photo, and a PDF's pages as pictures (the
 * vendor's browser draws them; a scan's own page photos when it couldn't),
 * go to a vision model; a PDF's text goes to a text model too. The model
 * only reports what the page says (names, dates,
 * limits, whether a tax ID and a signature are there, never the tax ID
 * itself). Judging that against SOARD's minimums is plain code below, so a
 * misread can't argue its way to a pass.
 *
 * The pictures are trusted to be the PDF's: a hand-made request could send
 * other ones, but it could as easily send a doctored photo, which is filed as
 * it is. What's filed is always what the vendor sent, for a person to open.
 *
 * A W-9 is read from its pictures alone: its signature and the boxes typed
 * into the IRS form aren't in its text (checked on live: the text read said
 * "not signed, no tax ID" of a good W-9 that the pictures read right). A
 * certificate is read both ways, and each number can be misread by one of
 * them (each took a neighbouring line for the aggregate once), so it passes
 * only when it passes at the less generous of the two readings, see judgeCoiReads.
 *
 * The certificates and W-9s SOARD already had (staff email, JobTread, Ramp)
 * are read here too (./_coi-backfill.js), their pages drawn in Cloudflare's
 * Browser Rendering instead of a vendor's browser. The agency in the PRODUCER
 * box comes along, so renewals can go to the agent; and with no browser at
 * all, a W-9 filled in on a computer is read from its text and the boxes
 * typed into the form (readW9Text).
 *
 * A file that can't be read (no pictures and no text, the model not
 * answering) comes back unreadable, and ./_vendors.js files it in JobTread
 * for a person to look at. A HEIC photo never gets here: the page sends it
 * as a JPG, and ./_vendors.js turns away one that comes as HEIC.
 */

import { vendorLikeness } from './_spend-match.js';
import { TZ } from './_reveals.js';

export const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const AI_TIMEOUT_MS = 45000;
const MIN_TEXT = 80;          // a PDF with less text than this is a scan
const VISION_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const isoDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
export function longDate(d) {
  if (!isDate(d)) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// ─── What the model is asked ────────────────────────────────────────

const COI_PROMPT = `You read certificates of liability insurance (usually the ACORD 25 form) for a nonprofit that hires contractors.
Report only what the document says; never guess.
- Dates as YYYY-MM-DD (a date written 03/01/2027 is 2027-03-01).
- Limits as whole dollars (1,000,000 is 1000000). Leave a limit out if the certificate doesn't show it.
- One entry in "policies" for each line of coverage shown: kind is "general liability" (commercial general liability), "workers compensation" (workers compensation and employers' liability), "auto", "umbrella" or "other".
- insurer: the insurance company for that line (match the INSR LTR letter to the INSURER A, B, C list).
- For general liability: eachOccurrence (EACH OCCURRENCE) and aggregate (GENERAL AGGREGATE).
- For workers compensation: employersLiabilityEachAccident (E.L. EACH ACCIDENT).
- insured: the company name in the INSURED box. certificateHolder: the name in the CERTIFICATE HOLDER box.
- producer: the PRODUCER box (the insurance agency): its name, the CONTACT NAME, the E-MAIL ADDRESS and the PHONE. Leave out what isn't there.
- policyNumber: that line's POLICY NUMBER.
- isWcExemption: true when this is a workers' compensation exemption instead of a certificate (an affidavit or certificate saying the company needs no workers' compensation, for example in Georgia because it has fewer than three employees). insured is then the company it's for, and policies is empty.
- isCertificate is false when this isn't a certificate of insurance. readable is false when the text is too garbled to read the dates.`;

const W9_PROMPT = `You check IRS Form W-9 (Request for Taxpayer Identification Number and Certification) for a nonprofit that pays contractors.
Report only what the form says; never guess.
- name: line 1. businessName: line 2 (empty when blank).
- hasTaxId: true only when a complete Social Security number or Employer Identification Number is filled in Part I. NEVER write the number itself anywhere.
- signed: true when the "Signature of U.S. person" line is signed (an electronic signature counts). signedDate: that line's date as YYYY-MM-DD, when there is one.
- isW9 is false when this isn't a W-9. readable is false when the text is too garbled to tell.`;

const COI_SCHEMA = {
  type: 'object',
  properties: {
    isCertificate: { type: 'boolean' },
    readable: { type: 'boolean' },
    insured: { type: 'string' },
    certificateHolder: { type: 'string' },
    isWcExemption: { type: 'boolean' },
    producer: {
      type: 'object',
      properties: { name: { type: 'string' }, contact: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } },
    },
    policies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['general liability', 'workers compensation', 'auto', 'umbrella', 'other'] },
          insurer: { type: 'string' },
          policyNumber: { type: 'string' },
          effective: { type: 'string' },
          expires: { type: 'string' },
          eachOccurrence: { type: 'number' },
          aggregate: { type: 'number' },
          employersLiabilityEachAccident: { type: 'number' },
        },
        required: ['kind', 'expires'],
      },
    },
  },
  required: ['isCertificate', 'policies'],
};

const W9_SCHEMA = {
  type: 'object',
  properties: {
    isW9: { type: 'boolean' },
    readable: { type: 'boolean' },
    name: { type: 'string' },
    businessName: { type: 'string' },
    hasTaxId: { type: 'boolean' },
    signed: { type: 'boolean' },
    signedDate: { type: 'string' },
  },
  required: ['isW9', 'hasTaxId'],
};

// ─── Reading ────────────────────────────────────────────────────────

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

/** A PDF's text through Workers AI's converter; '' when it has none (a scan) or can't be read */
export async function pdfText(env, { bytes, name = 'document.pdf' }) {
  if (!env.AI?.toMarkdown) return '';
  try {
    const r = await env.AI.toMarkdown({ name, blob: new Blob([bytes], { type: 'application/pdf' }) }, { conversionOptions: { output: { format: 'text' } } });
    const one = Array.isArray(r) ? r[0] : r;
    return one?.format === 'error' ? '' : String(one?.data || '');
  } catch (err) {
    console.error('[vendor-read] pdf', err.message);
    return '';
  }
}

function withTimeout(p, ms) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

/** The model's answer as an object, whichever shape it came back in */
export function answerOf(out) {
  const r = out?.response ?? out?.choices?.[0]?.message?.content ?? out;
  if (r && typeof r === 'object' && !Array.isArray(r)) return r;
  const m = String(r || '').match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

export async function askModel(env, model, messages, schema) {
  for (const json of [true, false]) {
    try {
      const out = await withTimeout(env.AI.run(model, {
        messages, max_tokens: 900, temperature: 0,
        ...(json ? { response_format: { type: 'json_schema', json_schema: schema } } : {}),
      }), AI_TIMEOUT_MS);
      const a = answerOf(out);
      if (a) return a;
    } catch (err) {
      console.error('[vendor-read]', model, err.message);
    }
  }
  return null;
}

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const toBase64 = (bytes) => btoa(latin1(bytes));

/**
 * A scanned PDF's pages as photos: scanners and phone scan apps wrap each page
 * as a JPEG, which is cut out as it is (nothing to render). Page-sized images
 * only (a logo is skipped), in page order, at most `max`.
 * → [{ bytes, type: 'image/jpeg' }]; [] when the scan isn't JPEG (JBIG2, fax, JPEG 2000)
 */
export function scannedPages(bytes, { max = 3, minSide = 500, maxBytes = 4 * 1024 * 1024 } = {}) {
  const s = latin1(bytes);
  const pages = [];
  const find = /\/DCTDecode/g;
  for (let m; (m = find.exec(s)) && pages.length < max;) {
    // The image's own dictionary: from its "obj" to its "stream"
    const start = s.lastIndexOf(' obj', m.index);
    const streamAt = s.indexOf('stream', m.index);
    if (start < 0 || streamAt < 0) break;
    const dict = s.slice(start, streamAt);
    find.lastIndex = streamAt;
    if (!/\/Subtype\s*\/Image/.test(dict) || /\/(?:Flate|LZW|ASCII85|ASCIIHex|RunLength)Decode/.test(dict)) continue;
    const w = Number(dict.match(/\/Width\s+(\d+)/)?.[1] || 0);
    const h = Number(dict.match(/\/Height\s+(\d+)/)?.[1] || 0);
    if (Math.min(w, h) < minSide) continue;
    const from = streamAt + 6 + (s[streamAt + 6] === '\r' ? 2 : 1);
    const end = s.indexOf('endstream', from);
    const last = end < 0 ? -1 : s.lastIndexOf('\xff\xd9', end);
    if (last < from || s.slice(from, from + 3) !== '\xff\xd8\xff') continue;
    if (last + 2 - from > maxBytes) continue;
    pages.push({ bytes: bytes.slice(from, last + 2), type: 'image/jpeg' });
  }
  return pages;
}

const askVision = (env, prompt, schema, image) => askModel(env, VISION_MODEL, [
  { role: 'system', content: prompt },
  { role: 'user', content: [
    { type: 'text', text: 'Read this document.' },
    { type: 'image_url', image_url: { url: `data:${image.type};base64,${toBase64(image.bytes)}` } },
  ] },
], schema);

/** Pages as pictures → one reading: a certificate's pages together, a W-9's first page that is one */
async function readPictures(env, doc, pages) {
  const prompt = doc === 'w9' ? W9_PROMPT : COI_PROMPT;
  const schema = doc === 'w9' ? W9_SCHEMA : COI_SCHEMA;
  if (doc === 'coi') return pages.length ? mergeCoi(await Promise.all(pages.map((p) => askVision(env, prompt, schema, p)))) : null;
  let first = null;
  for (const p of pages) {
    const a = await askVision(env, prompt, schema, p);
    if (a?.isW9) return a;
    first ||= a;
  }
  return first; // no page is a W-9: the first answer, so judgeW9 says what it is instead
}

/**
 * What one file says, read each way it can be. doc 'w9' | 'coi';
 * file { bytes, type, name, pages? } (pages: a PDF's first pages as JPEGs, drawn by the vendor's browser).
 * known.text: the PDF's text when it was already read (./_coi-backfill.js reads it first to see what the file is).
 * → { text, pictures }: each the model's answer (COI_SCHEMA / W9_SCHEMA), or null when not read that way
 */
export async function readDocument(env, doc, file, known = {}) {
  if (!env.AI?.run) return { text: null, pictures: null };
  if (VISION_TYPES.has(file.type)) return { text: null, pictures: await readPictures(env, doc, [file]) };
  if (file.type !== 'application/pdf') return { text: null, pictures: null };
  const drawn = file.pages?.length ? readPictures(env, doc, file.pages) : null;
  // A W-9's text never answers (see the top), so it isn't asked
  const text = doc === 'coi' ? (typeof known.text === 'string' ? known.text : await pdfText(env, file)) : '';
  const hasText = text.trim().length >= MIN_TEXT;
  const [fromText, pictures] = await Promise.all([
    hasText ? askModel(env, TEXT_MODEL, [
      { role: 'system', content: COI_PROMPT },
      { role: 'user', content: `The document's text:\n\n${text.slice(0, 14000)}` },
    ], COI_SCHEMA) : null,
    // No pictures from the browser: a scan's own page photos, which are cut out as they are
    drawn || (doc === 'w9' || !hasText ? readPictures(env, doc, scannedPages(file.bytes)) : null),
  ]);
  return { text: fromText, pictures };
}

/** A date as YYYY-MM-DD: the model is asked for that, and sometimes writes the form's 03/01/2027 */
export function isoDate(s) {
  const t = String(s || '').trim();
  if (isDate(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return t;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Several certificate files (liability and workers' comp often come apart) as one reading */
export function mergeCoi(reads) {
  const got = reads.filter(Boolean);
  if (!got.length) return null;
  return {
    isCertificate: got.some((r) => r.isCertificate),
    readable: got.some((r) => r.readable !== false),
    insured: got.map((r) => r.insured).find((s) => String(s || '').trim()) || '',
    certificateHolder: got.map((r) => r.certificateHolder).find((s) => String(s || '').trim()) || '',
    policies: got.flatMap((r) => (r.isCertificate ? r.policies || [] : [])).map((p) => ({ ...p, expires: isoDate(p.expires) })),
    producer: got.map((r) => r.producer).find((p) => p && (String(p.email || '').trim() || String(p.name || '').trim())) || null,
    isWcExemption: got.some((r) => r.isWcExemption === true),
  };
}

/**
 * A W-9 that's a PDF of its own rather than a scan (filled in on a computer): its text, and what was typed
 * into the IRS form's boxes, which its text leaves out. typed: words only (never the tax ID itself), e.g.
 * "Line 1: Sample Painting LLC. A tax ID is typed in Part I (an EIN)." → W9_SCHEMA's answer, or null
 */
export async function readW9Text(env, text, typed = '') {
  if (!env.AI?.run || String(text || '').trim().length < MIN_TEXT) return null;
  return askModel(env, TEXT_MODEL, [
    { role: 'system', content: W9_PROMPT },
    { role: 'user', content: `The form's text:\n\n${String(text).slice(0, 8000)}${typed ? `\n\nTyped into the form's boxes: ${typed}` : ''}` },
  ], W9_SCHEMA);
}

// ─── Judging (pure) ─────────────────────────────────────────────────

const num = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null);

/** The policy of a kind that runs the longest */
function latest(policies, kind) {
  return (policies || [])
    .filter((p) => p.kind === kind && isDate(p.expires))
    .sort((a, b) => b.expires.localeCompare(a.expires))[0] || null;
}

/** The minimums a certificate is held to, in words for the vendor */
export function requirementLines(req) {
  const out = [`General liability: at least ${money(req.glOccurrence)} each occurrence and ${money(req.glAggregate)} aggregate`];
  if (req.workersComp) out.push(`Workers’ compensation${req.elEachAccident ? `, with employer’s liability of at least ${money(req.elEachAccident)} each accident` : ''}`);
  out.push('Policies in force today, with Sunshine on a Ranney Day as certificate holder');
  return out;
}

/**
 * A certificate against the minimums.
 * x: mergeCoi's reading; req: { glOccurrence, glAggregate, workersComp, elEachAccident }
 * → { unreadable } | { accepted, problems: [words], lines: [words], gl, wc, summary, notes }
 */
export function judgeCoi(x, req, { vendorName = '', now = Date.now() } = {}) {
  if (!x || x.readable === false) return { unreadable: true };
  if (!x.isCertificate) return { accepted: false, problems: ['This doesn’t look like a certificate of insurance. Upload the certificate itself (an ACORD 25 from your insurance agent).'], lines: [] };
  const today = isoDay(now);
  const gl = latest(x.policies, 'general liability');
  const wc = latest(x.policies, 'workers compensation');
  const problems = [];
  const lines = [];
  if (!gl) problems.push('General liability isn’t on this certificate.');
  else {
    const occ = num(gl.eachOccurrence);
    const agg = num(gl.aggregate);
    if (gl.expires < today) problems.push(`General liability ended ${longDate(gl.expires)}.`);
    if (req.glOccurrence && !occ) problems.push('The certificate doesn’t show general liability’s each-occurrence limit.');
    else if (req.glOccurrence && occ < req.glOccurrence) problems.push(`General liability is ${money(occ)} each occurrence; we need at least ${money(req.glOccurrence)}.`);
    if (req.glAggregate && agg && agg < req.glAggregate) problems.push(`General liability’s aggregate is ${money(agg)}; we need at least ${money(req.glAggregate)}.`);
    const limits = [occ && `${money(occ)} each occurrence`, agg && `${money(agg)} aggregate`].filter(Boolean).join(', ');
    lines.push(`General liability${limits ? ` ${limits}` : ''}, through ${longDate(gl.expires)}${gl.insurer ? ` (${gl.insurer})` : ''}.`);
  }
  if (req.workersComp) {
    if (!wc) problems.push('Workers’ compensation isn’t on this certificate. If it’s on a certificate of its own, add that one too.');
    else {
      const el = num(wc.employersLiabilityEachAccident);
      if (wc.expires < today) problems.push(`Workers’ compensation ended ${longDate(wc.expires)}.`);
      if (req.elEachAccident && el && el < req.elEachAccident) problems.push(`Employer’s liability is ${money(el)} each accident; we need at least ${money(req.elEachAccident)}.`);
      lines.push(`Workers’ compensation through ${longDate(wc.expires)}${el ? `, employer’s liability ${money(el)} each accident` : ''}${wc.insurer ? ` (${wc.insurer})` : ''}.`);
    }
  } else if (wc) {
    lines.push(`Workers’ compensation through ${longDate(wc.expires)}${wc.insurer ? ` (${wc.insurer})` : ''}.`);
  }
  // Worth a person's glance, never a reason to refuse
  const notes = [];
  if (x.insured && vendorName && vendorLikeness(vendorName, x.insured) < 0.5) notes.push(`The certificate names ${x.insured} as insured.`);
  if (!/ranney/i.test(String(x.certificateHolder || ''))) notes.push('Sunshine on a Ranney Day isn’t the certificate holder.');
  const summary = [
    gl ? `GL ${num(gl.eachOccurrence) ? money(gl.eachOccurrence) : '?'}${num(gl.aggregate) ? `/${money(gl.aggregate)}` : ''} to ${gl.expires}${gl.insurer ? ` (${gl.insurer})` : ''}` : null,
    wc ? `WC to ${wc.expires}${wc.insurer ? ` (${wc.insurer})` : ''}` : null,
    ...notes,
  ].filter(Boolean).join(' · ');
  return { accepted: !problems.length, problems, lines, gl, wc, notes, summary };
}

/**
 * A certificate read two ways (each file's { text, pictures } from readDocument) against the minimums.
 * Each file's policies are judged at their least and their most generous reading: limits lowest/highest
 * and end dates earliest/latest where its two readings disagree; a policy only one of them found counts
 * (readers miss far more than they invent), and one seen without a usable date still counts for its limits.
 * Across files, the policy that runs longest stands, as in judgeCoi.
 * Passes at the least generous → accepted, with the earlier dates.
 * Fails even at the most generous → only the problems that hold either way go back to the vendor.
 * Otherwise one misread number decides it, so a person does: { unreadable, unsure: what one reading found }.
 */
export function judgeCoiReads(reads, req, opts = {}) {
  const files = reads.map((r) => [mergeCoi([r?.text || r?.pictures]), mergeCoi([r?.pictures || r?.text])]).filter(([a]) => a);
  if (!files.length) return { unreadable: true };
  const pick = (a, b, kind, worse) => {
    const p = latest(a.policies, kind);
    const q = latest(b.policies, kind);
    if (!p && !q) return null;
    const loose = [p ? null : a, q ? null : b].filter(Boolean).flatMap((r) => (r.policies || []).filter((x) => x.kind === kind && !isDate(x.expires)));
    const seen = [p, q, ...loose].filter(Boolean);
    const lim = (k) => {
      const v = seen.map((x) => num(x[k])).filter(Boolean);
      return v.length ? (worse ? Math.min(...v) : Math.max(...v)) : undefined;
    };
    const expires = !p || !q ? (p || q).expires : (p.expires < q.expires) === worse ? p.expires : q.expires;
    return { ...(p || q), insurer: p?.insurer || q?.insurer, expires, eachOccurrence: lim('eachOccurrence'), aggregate: lim('aggregate'), employersLiabilityEachAccident: lim('employersLiabilityEachAccident') };
  };
  const both = (worse) => ({
    isCertificate: files.some(([a, b]) => a.isCertificate || b.isCertificate),
    readable: files.some(([a, b]) => a.readable !== false || b.readable !== false),
    insured: files.map(([a, b]) => a.insured || b.insured).find(Boolean) || '',
    certificateHolder: files.map(([a, b]) => a.certificateHolder || b.certificateHolder).find(Boolean) || '',
    policies: files.flatMap(([a, b]) => [pick(a, b, 'general liability', worse), pick(a, b, 'workers compensation', worse)]).filter(Boolean),
  });
  const low = judgeCoi(both(true), req, opts);
  if (low.unreadable || low.accepted) return low;
  const high = judgeCoi(both(false), req, opts);
  if (!high.accepted) return high;
  return { unreadable: true, unsure: low.problems.join(' ') };
}

// ─── Settling a disagreement: one focused question ──────────────────

const FIELD_ASK = {
  expires: { words: 'the POLICY EXP (expiration) date', shape: '"YYYY-MM-DD"' },
  eachOccurrence: { words: 'the EACH OCCURRENCE limit in dollars', shape: 'a whole number' },
  aggregate: { words: 'the GENERAL AGGREGATE limit in dollars (not PRODUCTS - COMP/OP AGG, not PERSONAL & ADV INJURY)', shape: 'a whole number' },
  employersLiabilityEachAccident: { words: 'the E.L. EACH ACCIDENT limit in dollars', shape: 'a whole number' },
};
const ROW = { 'general liability': 'COMMERCIAL GENERAL LIABILITY', 'workers compensation': 'WORKERS COMPENSATION AND EMPLOYERS’ LIABILITY' };

/** Where a file's two readings disagree → [{ file, kind, key, text, pictures }] */
export function disputesOf(reads) {
  const out = [];
  reads.forEach((r, file) => {
    if (!r?.text || !r?.pictures) return;
    const [a, b] = [mergeCoi([r.text]), mergeCoi([r.pictures])];
    if (!a || !b) return;
    for (const kind of ['general liability', 'workers compensation']) {
      const p = latest(a.policies, kind);
      const q = latest(b.policies, kind);
      if (!p || !q) continue;
      for (const key of ['expires', 'eachOccurrence', 'aggregate', 'employersLiabilityEachAccident']) {
        const [x, y] = key === 'expires' ? [p.expires, q.expires] : [num(p[key]), num(q[key])];
        if (x && y && x !== y) out.push({ file, kind, key, text: x, pictures: y });
      }
    }
  });
  return out;
}

/**
 * Two readings that disagree (judgeCoiReads said unsure): each number in dispute is asked once more
 * of the file's first picture, on its own. An answer that matches one reading settles it for both.
 * reads: readDocument's per file; pictures: per file, its page pictures (or the photo itself) → new reads
 */
export async function settleDisputes(env, reads, pictures, { max = 4 } = {}) {
  const disputes = disputesOf(reads).slice(0, max);
  if (!disputes.length || !env.AI?.run) return reads;
  const out = reads.map((r) => r && { text: r.text && structuredClone(r.text), pictures: r.pictures && structuredClone(r.pictures) });
  for (const d of disputes) {
    const image = pictures[d.file]?.[0];
    if (!image) continue;
    const ask = FIELD_ASK[d.key];
    const prompt = `You read one value from a certificate of liability insurance (ACORD 25). In the ${ROW[d.kind]} row, find ${ask.words}. Report it as JSON {"value": ${ask.shape}}, or {"value": null} when that row doesn't show it. Never guess.`;
    const a = await askModel(env, VISION_MODEL, [
      { role: 'system', content: prompt },
      { role: 'user', content: [{ type: 'text', text: 'Read that one value.' }, { type: 'image_url', image_url: { url: `data:${image.type};base64,${toBase64(image.bytes)}` } }] },
    ], { type: 'object', properties: { value: { type: ['string', 'number', 'null'] } }, required: ['value'] });
    const got = d.key === 'expires' ? isoDate(a?.value) : num(String(a?.value ?? '').replace(/[$,\s]/g, ''));
    if (!got || (got !== d.text && got !== d.pictures)) continue;
    for (const side of ['text', 'pictures']) {
      for (const p of out[d.file][side]?.policies || []) {
        if (p.kind !== d.kind) continue;
        const now = d.key === 'expires' ? isoDate(p.expires) : num(p[d.key]);
        if (now === d.text || now === d.pictures) p[d.key] = got;
      }
    }
  }
  return out;
}

/** A W-9 → { unreadable } | { accepted, problems, lines, notes } */
export function judgeW9(x, { vendorName = '' } = {}) {
  if (!x || x.readable === false) return { unreadable: true };
  if (!x.isW9) return { accepted: false, problems: ['This doesn’t look like a W-9. Upload IRS Form W-9, filled in and signed.'], lines: [] };
  const problems = [];
  if (!x.hasTaxId) problems.push('The W-9 doesn’t show a tax ID (a Social Security number or an EIN) in Part I.');
  if (x.signed === false) problems.push('The W-9 isn’t signed. Sign and date it at the bottom of the first page.');
  const notes = [];
  const names = [x.name, x.businessName].filter((s) => String(s || '').trim());
  if (vendorName && names.length && !names.some((n) => vendorLikeness(vendorName, n) >= 0.5)) notes.push(`The W-9 is for ${names.join(' / ')}.`);
  // An unsigned form's date box is often read as a placeholder (1901-01-01 once): only a signed one's is said
  const signedOn = x.signed !== false && isDate(x.signedDate) && x.signedDate >= '2000-01-01' ? `, signed ${longDate(x.signedDate)}` : '';
  const lines = [`W-9 for ${names.join(', ') || 'your company'}${signedOn}.`];
  return { accepted: !problems.length, problems, lines, notes };
}
