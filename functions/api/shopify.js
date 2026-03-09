/**
 * Shopify Storefront API Proxy — Cloudflare Pages Function
 *
 * Proxies client-side cart operations to Shopify so the
 * Storefront Access Token never touches the browser.
 *
 * ENV VARS (set in CF Pages dashboard):
 *   SHOPIFY_STORE_DOMAIN       — e.g. "your-store.myshopify.com"
 *   SHOPIFY_STOREFRONT_TOKEN   — Storefront API access token
 */

const API_VERSION = '2024-10';

export async function onRequestPost({ request, env }) {
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

  return new Response(data, {
    status: shopifyRes.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
