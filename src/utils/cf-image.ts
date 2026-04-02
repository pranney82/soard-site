/**
 * Cloudflare Images — URL utilities
 *
 * Single source of truth for image URL construction.
 * imagedelivery.net auto-negotiates AVIF → WebP → JPEG via Accept header,
 * so format=auto is NEVER appended (only needed on /cdn-cgi/image/ URLs).
 *
 * URL anatomy: https://imagedelivery.net/{hash}/{image-id}/{variant-or-transforms}
 * Image IDs can contain slashes (e.g. "kids/amari/hero").
 * Variants are either named ("public", "nav", "og") or flexible transforms ("w=800,q=85").
 */

export const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const CF_ORIGIN = `https://imagedelivery.net/${CF_HASH}`;
export const CF_BASE = `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${CF_HASH}`;

const NAMED_VARIANTS = new Set(['public', 'nav', 'footer', 'og']);

/**
 * Extract the bare image ID from a full CF Images URL or pass through a bare ID.
 *
 *   cfId("https://imagedelivery.net/.../kids/amari/hero/public") → "kids/amari/hero"
 *   cfId("https://imagedelivery.net/.../brand-logo/w=256,format=auto") → "brand-logo"
 *   cfId("kids/amari/hero") → "kids/amari/hero"
 */
export function cfId(src: string): string {
  if (!src) return '';
  if (!src.includes('imagedelivery.net')) return src;

  let id = src.replace(`${CF_ORIGIN}/`, '');
  const lastSlash = id.lastIndexOf('/');
  if (lastSlash > 0) {
    const suffix = id.slice(lastSlash + 1);
    if (NAMED_VARIANTS.has(suffix) || suffix.includes('=')) {
      id = id.slice(0, lastSlash);
    }
  }
  return id;
}

/** Check whether a src string points to Cloudflare Images (full URL or bare image ID) */
export function isCF(src: string): boolean {
  if (!src) return false;
  if (src.includes('imagedelivery.net')) return true;
  // Bare image IDs (e.g. "kids/amari/hero") — not an absolute URL or site-relative path
  return !src.startsWith('http') && !src.startsWith('/') && !src.startsWith('data:');
}

export interface TransformOpts {
  w?: number;
  h?: number;
  fit?: 'cover' | 'contain' | 'crop' | 'scale-down' | 'pad';
  gravity?: 'face' | 'auto' | 'center' | 'top' | 'bottom' | 'left' | 'right';
  q?: number;
  /** Light output sharpening (0–10). 1 = subtle, good for face crops at small sizes. */
  sharpen?: number;
}

function buildTransform(opts: TransformOpts): string {
  const parts: string[] = [];
  if (opts.w) parts.push(`w=${opts.w}`);
  if (opts.h) parts.push(`h=${opts.h}`);
  if (opts.fit) parts.push(`fit=${opts.fit}`);
  if (opts.gravity) parts.push(`gravity=${opts.gravity}`);
  parts.push(`q=${opts.q ?? 85}`);
  if (opts.sharpen) parts.push(`sharpen=${opts.sharpen}`);
  // Strip EXIF/metadata from all transforms — prevents GPS, camera info, timestamps leaking
  parts.push('metadata=none');
  return parts.join(',');
}

/**
 * Build a single CF Images URL with transforms.
 *
 *   cfUrl("kids/amari/hero", { w: 800 })
 *   cfUrl(fullUrl, { w: 600, h: 400, fit: 'cover', gravity: 'face' })
 */
export function cfUrl(src: string, opts: TransformOpts): string {
  const id = cfId(src);
  if (!id) return src;
  return `${CF_BASE}/${id}/${buildTransform(opts)}`;
}

/**
 * Build a raw CF Images URL from an ID and a raw transform string.
 * Use for one-off patterns where TransformOpts is too rigid.
 *
 *   cfRaw("kids/amari/hero", "w=800,h=600,fit=cover,gravity=face,q=80")
 */
export function cfRaw(src: string, transforms: string): string {
  const id = cfId(src);
  if (!id) return src;
  return `${CF_BASE}/${id}/${transforms}`;
}

export interface SrcsetOpts {
  quality?: number;
  fit?: TransformOpts['fit'];
  gravity?: TransformOpts['gravity'];
  /** Fixed aspect ratio (height/width). If set, each width gets a proportional height. */
  aspectRatio?: number;
  /** Fixed height for all widths (overrides aspectRatio). */
  height?: number;
  /** Light output sharpening (0–10). Passed to each transform in the srcset. */
  sharpen?: number;
}

/**
 * Build a srcset string with width descriptors.
 *
 *   cfSrcset("kids/amari/hero", [400, 800, 1200])
 *   cfSrcset(src, [300, 600], { fit: 'cover', gravity: 'face', aspectRatio: 4/3 })
 */
export function cfSrcset(src: string, widths: number[], opts?: SrcsetOpts): string {
  const id = cfId(src);
  if (!id) return '';
  const q = opts?.quality ?? 85;

  return widths
    .map((w) => {
      const o: TransformOpts = { w, q };
      if (opts?.height) o.h = opts.height;
      else if (opts?.aspectRatio) o.h = Math.round(w * opts.aspectRatio);
      if (opts?.fit) o.fit = opts.fit;
      if (opts?.gravity) o.gravity = opts.gravity;
      if (opts?.sharpen) o.sharpen = opts.sharpen;
      return `${CF_BASE}/${id}/${buildTransform(o)} ${w}w`;
    })
    .join(', ');
}

/**
 * Build a density-descriptor srcset (1x, 2x) for fixed-size elements.
 *
 *   cfDensitySrcset("kids/amari/hero", 80, 80, { fit: 'cover', gravity: 'face' })
 *   → ".../w=80,h=80,... 1x, .../w=160,h=160,... 2x"
 */
/**
 * LQIP blur-up placeholder URL — tiny 30px-wide image with server-side blur.
 * Use as CSS background-image on the image wrapper for instant blurred preview.
 *
 *   cfLqip("kids/amari/hero") → "https://imagedelivery.net/.../w=30,q=30,blur=20"
 */
/**
 * Absolute public URL for JSON-LD schema and OG meta tags.
 * Returns the /public named variant which CF Images auto-negotiates format on.
 *
 *   cfAbsolute("kids/amari/hero") → "https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/.../kids/amari/hero/public"
 */
export function cfAbsolute(src: string): string {
  const id = cfId(src);
  if (!id) return src;
  return `${CF_BASE}/${id}/public`;
}

export function cfLqip(src: string): string {
  const id = cfId(src);
  if (!id) return '';
  return `${CF_BASE}/${id}/w=30,q=30,blur=20`;
}

export function cfDensitySrcset(
  src: string,
  w: number,
  h: number,
  opts?: Pick<SrcsetOpts, 'quality' | 'fit' | 'gravity'>,
): string {
  const id = cfId(src);
  if (!id) return '';
  const q = opts?.quality ?? 80;
  const fit = opts?.fit ?? 'cover';
  const gravity = opts?.gravity;

  return [1, 2]
    .map((dpr) => {
      const o: TransformOpts = { w: w * dpr, h: h * dpr, fit, q };
      if (gravity) o.gravity = gravity;
      return `${CF_BASE}/${id}/${buildTransform(o)} ${dpr}x`;
    })
    .join(', ');
}
