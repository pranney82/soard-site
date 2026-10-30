/**
 * A raw email (RFC 822), in the shape Gmail's API gives one
 * ===========================================================================
 * Ramp keeps the email a vendor sent a bill in as the bill's EMAIL attachment,
 * and that email often carries the vendor's certificate or W-9 beside the
 * invoice. Read here into Gmail's payload shape, so the certificate search
 * (./_coi-backfill.js) picks its files with the same rules as staff email
 * (./_mailbox.js partsOf, filesOf, textOf, bytesOf):
 *
 *   { partId, mimeType, filename, headers: [{ name, value }], body: { size, data (base64url) }, parts }
 *
 * Multipart (nested too), an attached email, base64, quoted-printable, and
 * names written as RFC 2047 words or RFC 2231 parameters.
 */

const MAX_DEPTH = 8;

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const bytesOfLatin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const base64url = (bytes) => btoa(latin1(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unhex = (s, plusSpace = false) => (plusSpace ? s.replace(/_/g, ' ') : s).replace(/[=%]([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);

function charsetText(bytes, charset) {
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

/** "=?utf-8?B?…?=" and "=?iso-8859-1?Q?…?=" words in a header, as text */
export function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (m, cs, enc, text) => {
    try {
      const bytes = /b/i.test(enc) ? bytesOfLatin1(atob(text.replace(/[^A-Za-z0-9+/]/g, ''))) : bytesOfLatin1(unhex(text, true));
      return charsetText(bytes, cs);
    } catch { return m; }
  });
}

function headersOf(block) {
  const out = [];
  for (const line of block.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out;
}

const headerOf = (headers, name) => headers.find((h) => h.name.toLowerCase() === name)?.value || '';

/** A header's value and parameters → { type, params }, RFC 2231 names (name*=utf-8''…, name*0=, name*1=) put together */
function paramsOf(value) {
  const [type, ...rest] = String(value || '').split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params = {};
  const pieces = {};
  for (const p of rest) {
    const m = /^\s*([^=\s]+)\s*=\s*([\s\S]*)$/.exec(p);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"([\s\S]*)"$/, '$1');
    const split = /^([^*]+)\*(?:(\d+)\*?)?$/.exec(key);
    if (split) (pieces[split[1]] ||= []).push({ n: Number(split[2] || 0), val, encoded: key.endsWith('*') });
    else params[key] = val;
  }
  for (const [key, list] of Object.entries(pieces)) {
    const joined = list.sort((a, b) => a.n - b.n).map((x) => x.val).join('');
    const enc = list.some((x) => x.encoded) && /^([^']*)'[^']*'([\s\S]*)$/.exec(joined);
    params[key] = enc ? charsetText(bytesOfLatin1(unhex(enc[2])), enc[1] || 'utf-8') : joined;
  }
  return { type: String(type || '').trim().toLowerCase(), params };
}

function bodyBytes(raw, encoding) {
  const e = String(encoding || '').toLowerCase();
  if (e === 'base64') {
    try { return bytesOfLatin1(atob(raw.replace(/[^A-Za-z0-9+/]/g, ''))); } catch { return new Uint8Array(0); }
  }
  if (e === 'quoted-printable') return bytesOfLatin1(unhex(raw.replace(/=\r?\n/g, '')));
  return bytesOfLatin1(raw);
}

/** A multipart body's parts: from one boundary line to the next, the preamble and what follows the closing one left out */
function splitParts(raw, boundary) {
  const line = new RegExp(`(?:^|\\r?\\n)--${escapeRe(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const out = [];
  let start = null;
  for (let m; (m = line.exec(raw));) {
    if (start !== null) out.push(raw.slice(start, m.index));
    if (m[1]) { start = null; break; }
    start = m.index + m[0].length;
  }
  if (start !== null) out.push(raw.slice(start));
  return out.map((p) => p.replace(/^\r?\n/, '')).filter((p) => p.trim());
}

function partOf(text, partId, depth) {
  const cut = /\r?\n\r?\n/.exec(text);
  const head = cut ? text.slice(0, cut.index) : text;
  const raw = cut ? text.slice(cut.index + cut[0].length) : '';
  const headers = headersOf(head).map((h) => ({ name: h.name, value: decodeWords(h.value) }));
  const ct = paramsOf(headerOf(headers, 'content-type') || 'text/plain');
  const cd = paramsOf(headerOf(headers, 'content-disposition'));
  const filename = cd.params.filename || ct.params.name || '';
  const part = { partId, mimeType: ct.type || 'text/plain', filename, headers, body: { size: 0 } };
  const child = (i) => (partId ? `${partId}.${i}` : String(i));
  if (depth < MAX_DEPTH && ct.type.startsWith('multipart/') && ct.params.boundary) {
    part.parts = splitParts(raw, ct.params.boundary).map((p, i) => partOf(p, child(i), depth + 1));
    return part;
  }
  const bytes = bodyBytes(raw, headerOf(headers, 'content-transfer-encoding'));
  if (depth < MAX_DEPTH && ct.type === 'message/rfc822' && !filename) {
    part.parts = [partOf(latin1(bytes), child(0), depth + 1)];
    return part;
  }
  part.body = { size: bytes.length, data: base64url(bytes) };
  return part;
}

/** A raw email's bytes → Gmail's payload shape (see the top), or null when it isn't an email */
export function parseEmail(bytes) {
  // (an mbox file's own first line, "From someone date", isn't a header)
  const text = latin1(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).replace(/^From [^\n]*\n/, '');
  if (!/^[!-9;-~]+:/.test(text) || !/\r?\n\r?\n/.test(text)) return null;
  const top = partOf(text, '', 0);
  return headerOf(top.headers, 'from') || headerOf(top.headers, 'content-type') ? top : null;
}
