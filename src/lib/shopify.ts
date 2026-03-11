/**
 * Shopify Storefront API — Config & Helpers
 *
 * SETUP: Set these environment variables before building:
 *   SHOPIFY_STORE_DOMAIN  — e.g. "your-store.myshopify.com"
 *   SHOPIFY_STOREFRONT_TOKEN — public Storefront API access token
 *
 * These are used at BUILD TIME by Astro (SSG) to fetch products.
 * At RUNTIME, the client calls /api/shopify (CF Functions proxy).
 */

const SHOPIFY_STORE_DOMAIN = import.meta.env.SHOPIFY_STORE_DOMAIN || '';
const SHOPIFY_STOREFRONT_TOKEN = import.meta.env.SHOPIFY_STOREFRONT_TOKEN || '';
const API_VERSION = '2024-10';

export function getStorefrontEndpoint(): string {
  return `https://${SHOPIFY_STORE_DOMAIN}/api/${API_VERSION}/graphql.json`;
}

export function isShopifyConfigured(): boolean {
  return !!(SHOPIFY_STORE_DOMAIN && SHOPIFY_STOREFRONT_TOKEN);
}

/** Build-time GraphQL fetch against Shopify Storefront API */
export async function storefrontFetch<T = any>(query: string, variables: Record<string, any> = {}): Promise<T> {
  const res = await fetch(getStorefrontEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Shopify Storefront API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

/* ─── Queries ─────────────────────────────── */

const PRODUCT_CARD_FRAGMENT = `
  fragment ProductCard on Product {
    id
    handle
    title
    description
    availableForSale
    priceRange {
      minVariantPrice { amount currencyCode }
      maxVariantPrice { amount currencyCode }
    }
    compareAtPriceRange {
      minVariantPrice { amount currencyCode }
      maxVariantPrice { amount currencyCode }
    }
    featuredImage {
      url
      altText
      width
      height
    }
    images(first: 1) {
      edges {
        node { url altText width height }
      }
    }
    tags
  }
`;

const PRODUCT_DETAIL_FRAGMENT = `
  fragment ProductDetail on Product {
    id
    handle
    title
    descriptionHtml
    description
    availableForSale
    priceRange {
      minVariantPrice { amount currencyCode }
      maxVariantPrice { amount currencyCode }
    }
    compareAtPriceRange {
      minVariantPrice { amount currencyCode }
    }
    featuredImage {
      url altText width height
    }
    images(first: 10) {
      edges {
        node { url altText width height }
      }
    }
    options {
      id name values
    }
    variants(first: 100) {
      edges {
        node {
          id
          title
          availableForSale
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
          selectedOptions { name value }
          image { url altText width height }
        }
      }
    }
    tags
    seo { title description }
  }
`;

export async function fetchAllProducts() {
  const query = `
    ${PRODUCT_CARD_FRAGMENT}
    query AllProducts {
      products(first: 50, sortKey: BEST_SELLING) {
        edges {
          node { ...ProductCard }
        }
      }
    }
  `;
  const data = await storefrontFetch<{ products: { edges: { node: any }[] } }>(query);
  return data.products.edges.map((e) => e.node);
}

export async function fetchProductByHandle(handle: string) {
  const query = `
    ${PRODUCT_DETAIL_FRAGMENT}
    query ProductByHandle($handle: String!) {
      product(handle: $handle) { ...ProductDetail }
    }
  `;
  const data = await storefrontFetch<{ product: any }>(query, { handle });
  return data.product;
}

export async function fetchAllProductHandles() {
  const query = `
    query ProductHandles {
      products(first: 250) {
        edges { node { handle } }
      }
    }
  `;
  const data = await storefrontFetch<{ products: { edges: { node: { handle: string } }[] } }>(query);
  return data.products.edges.map((e) => e.node.handle);
}

/* ─── Price formatting ────────────────────── */

export function formatPrice(amount: string, currencyCode: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
  }).format(parseFloat(amount));
}

/* ─── Collections (build-time SSG) ─────────── */

const COLLECTION_WITH_PRODUCTS_FRAGMENT = `
  fragment CollectionFull on Collection {
    id
    handle
    title
    description
    image { url altText width height }
    products(first: 100, sortKey: BEST_SELLING) {
      edges {
        node {
          id
          handle
          title
          description
          descriptionHtml
          availableForSale
          priceRange {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          compareAtPriceRange {
            minVariantPrice { amount currencyCode }
          }
          featuredImage { url altText width height }
          images(first: 10) {
            edges { node { url altText width height } }
          }
          options { id name values }
          variants(first: 100) {
            edges {
              node {
                id
                title
                availableForSale
                price { amount currencyCode }
                compareAtPrice { amount currencyCode }
                selectedOptions { name value }
                image { url altText width height }
              }
            }
          }
          tags
        }
      }
    }
  }
`;

export async function fetchAllCollections() {
  const query = `
    ${COLLECTION_WITH_PRODUCTS_FRAGMENT}
    query AllCollections {
      collections(first: 50) {
        edges {
          node { ...CollectionFull }
        }
      }
    }
  `;
  const data = await storefrontFetch<{ collections: { edges: { node: any }[] } }>(query);
  // Filter out empty collections
  return data.collections.edges
    .map((e) => e.node)
    .filter((c) => c.products.edges.length > 0);
}
