/**
 * GET /files/<key>
 * Serves files from R2 via Cloudflare's edge Cache API.
 * First request per POP hits R2; subsequent requests are served from edge cache.
 * Uses a catch-all route so /files/financials/2024-990.pdf → R2 key "financials/2024-990.pdf"
 *
 * Env bindings: FILES (R2)
 */

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Only allow these R2 prefixes to be served publicly
const ALLOWED_PREFIXES = ['financials/'];

export async function onRequestGet(context) {
  const { FILES } = context.env;
  const key = context.params.path?.join('/');

  if (!key || !ALLOWED_PREFIXES.some(p => key.startsWith(p))) {
    return new Response('Not Found', { status: 404 });
  }

  // Use Cloudflare's Cache API — keyed on the full request URL
  const cache = caches.default;
  const cacheKey = context.request;

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Cache miss — fetch from R2
  const object = await FILES.get(key);

  if (!object) {
    return new Response('Not Found', { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('ETag', object.httpEtag);

  const response = new Response(object.body, { headers });

  // Store in edge cache (non-blocking)
  context.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}
