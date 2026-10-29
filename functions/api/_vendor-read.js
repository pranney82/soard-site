/**
 * Reading a W-9 or a certificate of insurance, and judging it
 * ===========================================================================
 * What a vendor uploads on /vendor-documents/ (./_vendors.js files it) is
 * read here by Workers AI: a PDF's text through the converter, a photo by a
 * vision model. The model only reports what the page says (names, dates,
 * limits, whether a tax ID and a signature are there, never the tax ID
 * itself). Judging that against SOARD's minimums is plain code below, so a
 * misread can't argue its way to a pass.
 *
 * A file that can't be read (a scanned PDF with no text, a HEIC photo, the
 * model not answering) comes back unreadable, and ./_vendors.js files it in
 * JobTread for a person to look at.
 */

import { vendorLikeness } from './_spend-match.js';
import { TZ } from './_reveals.js';

const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
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
    policies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['general liability', 'workers compensation', 'auto', 'umbrella', 'other'] },
          insurer: { type: 'string' },
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

async function askModel(env, model, messages, schema) {
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

const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * What one file says. doc 'w9' | 'coi'; file { bytes, type, name }.
 * → the model's answer (COI_SCHEMA / W9_SCHEMA), or null when it can't be read
 */
export async function readDocument(env, doc, file) {
  if (!env.AI?.run) return null;
  const prompt = doc === 'w9' ? W9_PROMPT : COI_PROMPT;
  const schema = doc === 'w9' ? W9_SCHEMA : COI_SCHEMA;
  if (file.type === 'application/pdf') {
    const text = await pdfText(env, file);
    if (text.trim().length < MIN_TEXT) return null;
    return askModel(env, TEXT_MODEL, [
      { role: 'system', content: prompt },
      { role: 'user', content: `The document's text:\n\n${text.slice(0, 14000)}` },
    ], schema);
  }
  if (VISION_TYPES.has(file.type)) {
    return askModel(env, VISION_MODEL, [
      { role: 'system', content: prompt },
      { role: 'user', content: [
        { type: 'text', text: 'Read this document.' },
        { type: 'image_url', image_url: { url: `data:${file.type};base64,${toBase64(file.bytes)}` } },
      ] },
    ], schema);
  }
  return null;
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
    policies: got.flatMap((r) => (r.isCertificate ? r.policies || [] : [])),
  };
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
  const lines = [`W-9 for ${names.join(', ') || 'your company'}${isDate(x.signedDate) ? `, signed ${longDate(x.signedDate)}` : ''}.`];
  return { accepted: !problems.length, problems, lines, notes };
}
