/**
 * A kid's photo full size in the lightbox (src/pages/kids/[slug].astro): one rule for the page and its lightbox script.
 *
 * A gallery cell carries just its own picture; the lightbox makes the bigger copy from that picture's address, so the
 * page doesn't spell out every photo's full-size addresses (and its description) a second time: up to 1.1 KB
 * compressed on a 30-photo gallery. A design plan is cropped on the page (planUrl, planSrcset there), so its hidden
 * lightbox entry still names its own addresses, at these same widths.
 */
import { cfRaw, cfSrcset } from './cf-image';

/** The lightbox's widths, and the one a browser without srcset gets */
export const LIGHTBOX_WIDTHS = [800, 1200, 1600, 2400];
export const LIGHTBOX_WIDTH = 1600;

/** The full-size copy of a photo, from any of its Cloudflare addresses (the gallery's thumbnail) or its ID */
export function lightboxPhoto(photo: string): { src: string; srcset: string } {
  return { src: cfRaw(photo, `w=${LIGHTBOX_WIDTH},q=85`), srcset: cfSrcset(photo, LIGHTBOX_WIDTHS) };
}
