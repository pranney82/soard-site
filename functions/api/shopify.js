/**
 * Shopify Storefront API Proxy — Cloudflare Pages Function
 *
 * Proxies client-side requests to Shopify so the Storefront Access
 * Token never touches the browser.
 *
 * CACHING STRATEGY:
 *   - Read queries (products, collections): cached at the edge for 5 min
 *     with stale-while-revalidate for 1 hour. Sub-5ms for cached hits.
 *   - Mutations (cart ops): never cached.
 *
 * ENV VARS (set in CF Pages dashboard):
 *   SHOPIFY_STORE_DOMAIN       — e.g. "sunnyandranney.myshopify.com"
 *   SHOPIFY_STOREFRONT_TOKEN   — Storefront API access token
 */

const API_VERSION = '2024-10';
const CACHE_TTL = 300;            // 5 min fresh
const STALE_REVALIDATE = 3600;    // serve stale up to 1 hr while revalidating

/** Returns true for cart mutations that must never be cached */
function isMutation(query) {
  const trimmed = (query || '').trim().toLowerCase();
  return trimmed.startsWith('mutation');
}

export async function onRequestPost({ request, env, waitUntil }) {
  const domain = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_STOREFRONT_TOKEN;

  if (!domain || !token) {
    return new Response(JSON.stringify({ error: 'Shopify not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { query, variables } = body;
  if (!query) {
    return new Response(JSON.stringify({ error: 'Missing query' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Block GraphQL introspection queries
  if (/__schema|__type/i.test(query)) {
    return new Response(JSON.stringify({ error: 'Introspection not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Mutations: pass through, no cache ──
  if (isMutation(query)) {
    return proxyToShopify(domain, token, query, variables, false);
  }

  // ── Queries: check edge cache first ──
  const cache = caches.default;
  // Build a deterministic cache key from the query + variables
  const cacheKeyData = JSON.stringify({ query: query.replace(/\s+/g, ' ').trim(), variables });
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = '/api/shopify/__cache/' + await hashString(cacheKeyData);
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  // Try cache
  let cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  // Cache miss — fetch from Shopify
  const response = await proxyToShopify(domain, token, query, variables, true);

  // Only cache successful responses
  if (response.status === 200) {
    const cloned = response.clone();
    // waitUntil keeps the function alive to write to cache without blocking the response
    if (waitUntil) {
      waitUntil(cache.put(cacheKey, cloned));
    } else {
      // Fallback if waitUntil not available
      await cache.put(cacheKey, cloned);
    }
  }

  return response;
}

async function proxyToShopify(domain, token, query, variables, cacheable) {
  const shopifyRes = await fetch(
    `https://${domain}/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await shopifyRes.text();

  const headers = {
    'Content-Type': 'application/json',
  };

  if (cacheable && shopifyRes.status === 200) {
    headers['Cache-Control'] = `public, max-age=${CACHE_TTL}, stale-while-revalidate=${STALE_REVALIDATE}`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }

  return new Response(data, {
    status: shopifyRes.status,
    headers,
  });
}

/** Simple SHA-256 hash for cache keys */
async function hashString(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
