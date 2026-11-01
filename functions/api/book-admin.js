/**
 * POST /api/book-admin (Cloudflare Access) — the anniversary book's files in
 * R2, for Admin → Site Config → Anniversary book (public/admin/book-editor.js).
 *
 * Each upload of the book is a version (a short id the admin makes), and
 * everything from it lives under books/<version>/: the PDF itself, text.json
 * (where each word sits on each page, for the reader's search marks) and
 * manifest.json (its page pictures' Cloudflare Images ids, so a version can
 * be cleared away later). /files/books/... serves them (files/[[path]].js).
 *
 * A print-ready PDF can run to hundreds of megabytes, more than one request
 * may carry, so it goes up in parts (an R2 multipart upload):
 *   { action: 'pdf-start', version, name, bytes }        → { key, uploadId }
 *   POST ?action=pdf-part&key=…&uploadId=…&part=N, body = the part's bytes
 *                                                         → { part, etag }
 *   { action: 'pdf-finish', key, uploadId, parts }       → { url, bytes }
 *   { action: 'pdf-abort', key, uploadId }
 * The first part must start like a PDF ("%PDF-" in its first kilobyte).
 *
 *   { action: 'put-json', version, name: 'text' | 'manifest', data } → { url }
 *   { action: 'old-versions', keep: [version…] } → { versions: [{ version, images }] }
 *       the uploads nothing needs any more, with the pictures to delete through
 *       /api/delete-image. Never one that's kept (the admin sends the live one, the
 *       one on its screen and the one it's making), the saved book's, one that
 *       History can put back, or one from the last day (another tab or another
 *       person may be part way through it). Without the database, none.
 *   { action: 'drop-version', version }          → { deleted } (its R2 files)
 *
 * Env bindings: FILES (R2), DB (D1: the saved book and its History)
 */

const VERSION = /^[a-z0-9]{6,20}$/;
const PART_MAX = 50 * 1024 * 1024;
const JSON_MAX = 8 * 1024 * 1024;
const PDF_MAX = 4 * 1024 * 1024 * 1024;
const FRESH_MS = 24 * 60 * 60 * 1000;

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (error, status = 400) => json({ success: false, error }, status);

/** Every upload a save points to: the saved book's, and each one History can put back (null: can't tell) */
export async function savedVersions(DB) {
  if (!DB) return null;
  const out = new Set();
  const add = (data) => { try { const v = JSON.parse(data || 'null')?.version; if (VERSION.test(String(v || ''))) out.add(v); } catch { /* not a book */ } };
  try {
    add((await DB.prepare("SELECT data FROM site_config WHERE key = 'book'").first())?.data);
  } catch { return null; }
  try {
    const { results = [] } = await DB.prepare("SELECT data FROM content_versions WHERE collection = 'site' AND slug = 'book'").all();
    for (const r of results) add(r.data);
  } catch (e) {
    if (!/no such table/i.test(String(e?.message))) return null;
  }
  return out;
}

/** A file name that's safe in an R2 key and a download: letters, digits, - _ . only, ending .pdf */
export function pdfName(name) {
  const base = String(name || '').replace(/\.pdf$/i, '').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return `${base || 'book'}.pdf`;
}
/** books/<version>/<name>.pdf, or null for anything else */
export function pdfKey(key) {
  const m = /^books\/([a-z0-9]{6,20})\/([\w.-]{1,90}\.pdf)$/.exec(String(key || ''));
  return m && !m[2].startsWith('.') ? key : null;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const { FILES } = env;
  if (!FILES) return bad('File storage isn’t connected', 500);
  const url = new URL(request.url);

  try {
    // A part of the PDF: raw bytes in the body
    if (url.searchParams.get('action') === 'pdf-part') {
      const key = pdfKey(url.searchParams.get('key'));
      const uploadId = url.searchParams.get('uploadId') || '';
      const part = Number(url.searchParams.get('part'));
      if (!key || !uploadId || !Number.isInteger(part) || part < 1 || part > 10000) return bad('That isn’t a part of a book upload');
      const body = await request.arrayBuffer();
      if (!body.byteLength) return bad('The part was empty');
      if (body.byteLength > PART_MAX) return bad('That part is too big', 413);
      if (part === 1 && !looksLikePdf(new Uint8Array(body, 0, Math.min(1024, body.byteLength)))) return bad('That file isn’t a PDF', 415);
      const up = FILES.resumeMultipartUpload(key, uploadId);
      const done = await up.uploadPart(part, body);
      return json({ success: true, part: done.partNumber, etag: done.etag });
    }

    let b;
    try { b = await request.json(); } catch { return bad('Expected JSON'); }
    const action = String(b?.action || '');

    if (action === 'pdf-start') {
      if (!VERSION.test(String(b.version || ''))) return bad('That isn’t a version');
      const bytes = Number(b.bytes);
      if (!(bytes > 0) || bytes > PDF_MAX) return bad('That file is too big to keep');
      const key = `books/${b.version}/${pdfName(b.name)}`;
      const up = await FILES.createMultipartUpload(key, {
        httpMetadata: { contentType: 'application/pdf', cacheControl: 'public, max-age=31536000, immutable' },
      });
      return json({ success: true, key, uploadId: up.uploadId });
    }

    if (action === 'pdf-finish') {
      const key = pdfKey(b.key);
      const parts = Array.isArray(b.parts) ? b.parts.filter((p) => Number.isInteger(p?.part) && typeof p?.etag === 'string') : [];
      if (!key || !b.uploadId || !parts.length) return bad('That isn’t a book upload');
      const up = FILES.resumeMultipartUpload(key, String(b.uploadId));
      const obj = await up.complete(parts.sort((x, y) => x.part - y.part).map((p) => ({ partNumber: p.part, etag: p.etag })));
      return json({ success: true, url: `/files/${key}`, bytes: obj.size });
    }

    if (action === 'pdf-abort') {
      const key = pdfKey(b.key);
      if (!key || !b.uploadId) return bad('That isn’t a book upload');
      try { await FILES.resumeMultipartUpload(key, String(b.uploadId)).abort(); } catch { /* already gone */ }
      return json({ success: true });
    }

    if (action === 'put-json') {
      if (!VERSION.test(String(b.version || ''))) return bad('That isn’t a version');
      if (!['text', 'manifest'].includes(b.name)) return bad('That isn’t one of the book’s files');
      const body = JSON.stringify(b.data ?? null);
      if (body.length > JSON_MAX) return bad('That’s too much to keep', 413);
      const key = `books/${b.version}/${b.name}.json`;
      await FILES.put(key, body, { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' } });
      return json({ success: true, url: `/files/${key}` });
    }

    if (action === 'old-versions') {
      const saved = await savedVersions(env.DB);
      if (!saved) return json({ success: true, versions: [] });
      const keep = new Set([...(Array.isArray(b.keep) ? b.keep : []).filter((v) => VERSION.test(String(v))), ...saved]);
      const versions = [];
      let cursor;
      do {
        const page = await FILES.list({ prefix: 'books/', delimiter: '/', cursor });
        for (const p of page.delimitedPrefixes || []) {
          const v = p.slice('books/'.length, -1);
          if (!VERSION.test(v) || keep.has(v)) continue;
          // Made in the last day: perhaps another tab's, not saved yet
          const files = await FILES.list({ prefix: `books/${v}/` });
          const newest = Math.max(0, ...files.objects.map((o) => new Date(o.uploaded || 0).getTime()));
          if (Date.now() - newest < FRESH_MS) continue;
          let images = [];
          try {
            const m = await FILES.get(`books/${v}/manifest.json`);
            const j = m ? await m.json() : null;
            images = (Array.isArray(j?.images) ? j.images : []).filter((id) => typeof id === 'string' && id.startsWith(`book/${v}/`));
          } catch { images = []; }
          versions.push({ version: v, images });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return json({ success: true, versions });
    }

    if (action === 'drop-version') {
      const v = String(b.version || '');
      if (!VERSION.test(v)) return bad('That isn’t a version');
      let deleted = 0;
      let cursor;
      do {
        const page = await FILES.list({ prefix: `books/${v}/`, cursor });
        const keys = page.objects.map((o) => o.key);
        if (keys.length) { await FILES.delete(keys); deleted += keys.length; }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return json({ success: true, deleted });
    }

    return bad('Unknown action');
  } catch (err) {
    console.error('[book-admin]', err);
    return bad('Something went wrong storing the book. Try again.', 500);
  }
}

/** "%PDF-" anywhere in the first kilobyte, the way PDF readers look for it */
export function looksLikePdf(bytes) {
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let i = 0; i + sig.length <= Math.min(bytes.length, 1024); i++) {
    if (sig.every((c, k) => bytes[i + k] === c)) return true;
  }
  return false;
}
