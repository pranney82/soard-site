/**
 * An R2 bucket in memory, with the parts of the binding the site's Functions
 * use: put, get, head, list (prefix, delimiter, cursor), delete, and
 * multipart uploads (createMultipartUpload, resumeMultipartUpload →
 * uploadPart, complete, abort). Parts other than the last must be at least
 * 5 MiB, like R2's own rule. `objects` is the Map behind it, for asserting.
 */
const MIN_PART = 5 * 1024 * 1024;

const bytesOf = async (body) => {
  if (body == null) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new Uint8Array(await new Response(body).arrayBuffer());
};

function objectOf(key, o) {
  return {
    key,
    size: o.bytes.length,
    httpMetadata: o.httpMetadata,
    httpEtag: `"${o.etag}"`,
    etag: o.etag,
    uploaded: o.uploaded,
    get body() { return new Response(o.bytes).body; },
    arrayBuffer: async () => o.bytes.slice().buffer,
    text: async () => new TextDecoder().decode(o.bytes),
    json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
  };
}

export function createR2() {
  const objects = new Map();
  const uploads = new Map();
  let n = 0;
  const store = (key, bytes, httpMetadata = {}) => objects.set(key, { bytes, httpMetadata, etag: `e${++n}`, uploaded: new Date() });

  return {
    objects,
    async put(key, body, opts = {}) { store(key, await bytesOf(body), opts.httpMetadata || {}); return objectOf(key, objects.get(key)); },
    async get(key) { const o = objects.get(key); return o ? objectOf(key, o) : null; },
    async head(key) { const o = objects.get(key); return o ? objectOf(key, o) : null; },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
    async list({ prefix = '', delimiter, cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      if (!delimiter) return { objects: page.map((k) => objectOf(k, objects.get(k))), delimitedPrefixes: [], truncated, cursor: truncated ? String(start + limit) : undefined };
      const prefixes = new Set();
      const direct = [];
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const at = rest.indexOf(delimiter);
        if (at >= 0) prefixes.add(prefix + rest.slice(0, at + 1));
        else direct.push(k);
      }
      return { objects: direct.map((k) => objectOf(k, objects.get(k))), delimitedPrefixes: [...prefixes], truncated: false };
    },
    async createMultipartUpload(key, opts = {}) {
      const uploadId = `u${++n}`;
      uploads.set(uploadId, { key, parts: new Map(), httpMetadata: opts.httpMetadata || {} });
      return this.resumeMultipartUpload(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      const up = () => {
        const u = uploads.get(uploadId);
        if (!u || u.key !== key) throw new Error('NoSuchUpload');
        return u;
      };
      return {
        key,
        uploadId,
        async uploadPart(partNumber, body) {
          const u = up();
          const bytes = await bytesOf(body);
          const etag = `p${++n}`;
          u.parts.set(partNumber, { bytes, etag });
          return { partNumber, etag };
        },
        async complete(parts) {
          const u = up();
          const chunks = parts.map((p, i) => {
            const got = u.parts.get(p.partNumber);
            if (!got || got.etag !== p.etag) throw new Error('InvalidPart');
            if (i < parts.length - 1 && got.bytes.length < MIN_PART) throw new Error('EntityTooSmall');
            return got.bytes;
          });
          const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
          let at = 0;
          for (const c of chunks) { all.set(c, at); at += c.length; }
          store(key, all, u.httpMetadata);
          uploads.delete(uploadId);
          return objectOf(key, objects.get(key));
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
  };
}
