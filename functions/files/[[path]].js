/**
 * GET /files/<key>
 * Serves files from R2 via Cloudflare's edge Cache API.
 * First request per POP hits R2; subsequent requests are served from edge cache.
 * Uses a catch-all route so /files/financials/2024-990.pdf → R2 key "financials/2024-990.pdf"
 *
 * Env bindings: FILES (R2)
 *
 * These files are served on the site's own origin, where the admin signs in,
 * so nothing here may ever run as a page: a PDF opens in the browser's viewer
 * (application/pdf, whatever type it was stored with), everything else
 * downloads (Content-Disposition: attachment), and every answer carries
 * nosniff and a sandboxing CSP. Pages Functions don't get public/_headers,
 * so the rest of the security headers are set here too.
 */

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Only allow these R2 prefixes to be served publicly
const ALLOWED_PREFIXES = ['financials/'];

// Raster pictures keep their type when downloaded; anything else is plain bytes
const PICTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif']);

export const FILE_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
});

const isPdf = (key, storedType) => /^application\/pdf\b/i.test(storedType || '') || /\.pdf$/i.test(key);

/** The name a download is saved as: the key's last part, quoted safely */
function disposition(kind, key) {
  const name = String(key).split('/').pop() || 'file';
  const ascii = name.replace(/[^\w.\- ]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Content-Type, Content-Disposition and the security headers for a stored file */
export function fileHeaders(key, storedType) {
  const headers = new Headers(FILE_SECURITY_HEADERS);
  const type = String(storedType || '').split(';')[0].trim().toLowerCase();
  if (isPdf(key, type)) {
    headers.set('Content-Type', 'application/pdf');
    headers.set('Content-Disposition', disposition('inline', key));
    // A PDF opens in the browser's own viewer, never as a page on this site
    // (nosniff + the PDF type), and Safari and Firefox won't render one under a sandbox CSP
    headers.delete('Content-Security-Policy');
  } else {
    headers.set('Content-Type', PICTURE_TYPES.has(type) ? type : 'application/octet-stream');
    headers.set('Content-Disposition', disposition('attachment', key));
  }
  return headers;
}

const notFound = () => new Response('Not Found', { status: 404, headers: { ...FILE_SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });

export async function onRequestGet(context) {
  const { FILES } = context.env;
  const key = context.params.path?.join('/');

  if (!key || !ALLOWED_PREFIXES.some(p => key.startsWith(p)) || key.split('/').some(part => part === '..' || part === '.' || part === '')) {
    return notFound();
  }

  // Use Cloudflare's Cache API, keyed on the file's address (a query string
  // doesn't make another copy). v2: copies cached before these headers are never served
  const cache = caches.default;
  const cacheKey = new Request(`${new URL(context.request.url).origin}/files/${key}?v=2`);

  const cached = await cache.match(cacheKey);
  if (cached) {
    // Whatever the cached copy carries, it leaves with today's headers
    const headers = fileHeaders(key, cached.headers.get('Content-Type'));
    for (const name of ['Cache-Control', 'ETag', 'Last-Modified']) if (cached.headers.has(name)) headers.set(name, cached.headers.get(name));
    return new Response(cached.body, { status: cached.status, headers });
  }

  // Cache miss — fetch from R2
  const object = await FILES.get(key);

  if (!object) {
    return notFound();
  }

  const headers = fileHeaders(key, object.httpMetadata?.contentType);
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('ETag', object.httpEtag);

  const response = new Response(object.body, { headers });

  // Store in edge cache (non-blocking)
  context.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}
