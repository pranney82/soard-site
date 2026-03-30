/**
 * Shared Cloudflare Images utilities for build scripts.
 *
 * Canonical logic lives in src/utils/cf-image.ts — this file mirrors
 * the cfId() implementation in plain JS so Node build scripts can use it
 * without a TypeScript compilation step.
 *
 * If you change cfId() in cf-image.ts, update this file to match.
 */

export const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
export const CF_BASE = `https://imagedelivery.net/${CF_HASH}`;

const NAMED_VARIANTS = new Set(['public', 'nav', 'footer', 'og']);

/**
 * Extract the bare image ID from a full CF Images URL or pass through a bare ID.
 *
 *   cfId("https://imagedelivery.net/.../kids/amari/hero/public") → "kids/amari/hero"
 *   cfId("https://imagedelivery.net/.../brand-logo/w=256,format=auto") → "brand-logo"
 *   cfId("kids/amari/hero") → "kids/amari/hero"
 */
export function cfId(src) {
  if (!src) return '';
  if (!src.includes('imagedelivery.net')) return src;

  let id = src.replace(`${CF_BASE}/`, '');
  const lastSlash = id.lastIndexOf('/');
  if (lastSlash > 0) {
    const suffix = id.slice(lastSlash + 1);
    if (NAMED_VARIANTS.has(suffix) || suffix.includes('=')) {
      id = id.slice(0, lastSlash);
    }
  }
  return id;
}
