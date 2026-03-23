/**
 * GET /files/<key>
 * Serves files from R2 with proper caching and content headers.
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

  const object = await FILES.get(key);

  if (!object) {
    return new Response('Not Found', { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('ETag', object.httpEtag);

  // If the browser sent If-None-Match matching the ETag, return 304
  const ifNoneMatch = context.request.headers.get('If-None-Match');
  if (ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
}
