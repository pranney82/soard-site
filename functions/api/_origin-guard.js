/**
 * Cross-site request guard for the admin API (used by _middleware.js).
 *
 * Signed-in admins carry the Cloudflare Access cookie, which a browser sends
 * with any request to this site, including a form or fetch fired from another
 * website. So a change (POST, PUT, PATCH, DELETE) to an admin route must come
 * from the admin itself: its Origin is this site (or another allowed one), or,
 * when a browser sends no Origin, its Sec-Fetch-Site isn't cross-site. A
 * request with neither header isn't from a browser page (a script with a
 * service token) and can't ride a visitor's cookie, so it passes to the
 * Access check as before. Reads (GET, HEAD) are untouched.
 *
 * Returns why a request is refused, or null.
 */
const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function crossSiteChange(request, allowedOrigins = []) {
  if (!CHANGES.has(String(request.method || '').toUpperCase())) return null;
  const self = new URL(request.url).origin;
  const origin = request.headers.get('Origin');
  if (origin && origin !== 'null') {
    if (origin === self || allowedOrigins.includes(origin)) return null;
    try {
      const host = new URL(origin).hostname;
      if (host === 'localhost' || host === '127.0.0.1') return null;
    } catch {}
    return `from ${origin}`;
  }
  if (origin === 'null') return 'from an opaque origin';
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site') return 'from another site';
  return null;
}
