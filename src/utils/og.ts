/**
 * og.ts — the live reveal's "starting soon" slate (1920×1080 and 1080×1920),
 * drawn at build time with Satori (HTML/CSS → SVG) and Sharp (SVG → PNG).
 *
 * The share cards (the pictures link previews show) moved to og-card.ts.
 */
import satori from 'satori';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CF_HASH, cfId, withFocus } from './cf-image';

// imagedelivery.net works at build time regardless of host (unlike the /cdn-cgi/ proxy)
const CF_DIRECT = `https://imagedelivery.net/${CF_HASH}`;

// Bump when the slate's drawing changes, to invalidate the on-disk cache.
const OG_CACHE_VERSION = 1;
const OG_CACHE_DIR = path.resolve('./src/data/og-cache');

function ogCacheKey(opts: unknown): string {
  const payload = JSON.stringify({ v: OG_CACHE_VERSION, opts });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function ogCacheGet(key: string): Buffer | null {
  const p = path.join(OG_CACHE_DIR, `${key}.png`);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

function ogCacheSet(key: string, png: Buffer): void {
  if (!fs.existsSync(OG_CACHE_DIR)) fs.mkdirSync(OG_CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(OG_CACHE_DIR, `${key}.png`), png);
}

// ── Brand tokens ──────────────────────────────────
const YELLOW = '#FFDA24';

// ── Font cache ────────────────────────────────────
let fontCache: { outfit400: ArrayBuffer; outfit700: ArrayBuffer; libre700: ArrayBuffer } | null = null;

function loadFonts() {
  if (fontCache) return fontCache;
  function read(file: string): ArrayBuffer {
    const buf = fs.readFileSync(path.resolve(`./src/fonts/${file}`));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  fontCache = {
    outfit400: read('outfit-latin-400-normal.woff'),
    outfit700: read('outfit-latin-700-normal.woff'),
    libre700: read('libre-baskerville-latin-700-normal.woff'),
  };
  return fontCache;
}

// ── Logo as base64 ────────────────────────────────
let logoB64: string | null = null;
async function getLogo(): Promise<string> {
  if (logoB64) return logoB64;
  const url = `${CF_DIRECT}/brand-logo-nav-circle/w=256,q=85`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`CF Images responded ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    logoB64 = `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn('⚠ Could not fetch logo from CF Images for OG generation:', e);
    // Return a 1x1 transparent PNG as last resort
    logoB64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  }
  return logoB64;
}

// ── Fetch remote image as base64 ──────────────────
async function fetchImageBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────
function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ═══════════════════════════════════════════════════
// LIVE "STARTING SOON" SLATE — full-frame video overlay
// ═══════════════════════════════════════════════════
// Loaded as an image layer in Larix Broadcaster and shown while the stream
// warms up before a reveal; the crew switches the layer off when the reveal
// starts. Editorial split: brand panel + kid photo. 1920×1080 or 1080×1920.

const CREAM = '#FEFCF5';
const SLATE_TEXT = '#373A36';
const SLATE_MUTED = '#5A5B61';

export type SlateOrientation = 'landscape' | 'portrait';

export interface SlateOptions {
  name: string;
  slug: string;
  heroImage?: string | null;
  orientation: SlateOrientation;
}

/** Full logo (mark + wordmark + tagline) for light backgrounds, trimmed of its square padding. */
let slateLogo: { src: string; w: number; h: number } | null = null;
async function getSlateLogo() {
  if (slateLogo) return slateLogo;
  try {
    const res = await fetch(`${CF_DIRECT}/brand-logo-light-bg-tagline-display/w=1200,q=95`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`CF Images responded ${res.status}`);
    const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).trim().png().toBuffer({ resolveWithObject: true });
    slateLogo = { src: `data:image/png;base64,${data.toString('base64')}`, w: info.width, h: info.height };
  } catch (e) {
    console.warn('⚠ Could not fetch slate logo from CF Images:', e);
    slateLogo = { src: await getLogo(), w: 1, h: 1 };
  }
  return slateLogo;
}

function slateTemplate(o: SlateOptions, logo: { src: string; w: number; h: number }, photoB64: string | null) {
  const portrait = o.orientation === 'portrait';
  const W = portrait ? 1080 : 1920;
  const H = portrait ? 1920 : 1080;
  // Photo takes the right 42% (landscape) or the top 44% (portrait)
  const photoW = portrait ? W : Math.round(W * 0.42);
  const photoH = portrait ? Math.round(H * 0.36) : H;
  const logoH = portrait ? 170 : 180;
  const logoW = Math.round(logoH * (logo.w / logo.h));
  const possessive = /s$/i.test(o.name) ? `${o.name}’` : `${o.name}’s`;
  // Name on its own line(s), then the marker-highlighted "room reveal", like the site hero
  const nameSize = possessive.length > 16 ? (portrait ? 92 : 96) : possessive.length > 10 ? (portrait ? 104 : 112) : (portrait ? 118 : 132);

  const url = `sunshineonaranneyday.com/live/${o.slug}`;
  const urlSize = url.length > 44 ? (portrait ? 30 : 28) : (portrait ? 32 : 34);

  const textPanel = {
    type: 'div',
    props: {
      style: {
        flex: 1, display: 'flex', flexDirection: 'column' as const,
        justifyContent: 'space-between' as const,
        // Portrait keeps clear of Instagram Live's comment overlay (bottom ~20%)
        padding: portrait ? '56px 80px 400px' : '80px 110px 76px',
        background: CREAM,
      },
      children: [
        { type: 'img', props: { src: logo.src, width: logoW, height: logoH, style: { objectFit: 'contain' as const } } },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column' as const, gap: '26px' },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex', alignSelf: 'flex-start' as const, alignItems: 'center', gap: '16px',
                    background: SLATE_TEXT, color: CREAM, borderRadius: '100px',
                    padding: '14px 34px', fontSize: '30px', fontFamily: 'Outfit', fontWeight: 700,
                    letterSpacing: '0.12em', textTransform: 'uppercase' as const,
                  },
                  children: [
                    { type: 'div', props: { style: { width: '16px', height: '16px', borderRadius: '50%', background: YELLOW, display: 'flex' } } },
                    'Starting soon',
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' as const, fontSize: `${nameSize}px`, fontFamily: 'Libre Baskerville', fontWeight: 700, color: SLATE_TEXT, lineHeight: 1.08, letterSpacing: '-0.03em' },
                  children: [
                    { type: 'div', props: { style: { display: 'flex' }, children: truncate(possessive, 30) } },
                    { type: 'div', props: { style: { display: 'flex', alignSelf: 'flex-start' as const, backgroundImage: 'linear-gradient(transparent 58%, rgba(255,218,36,0.45) 58%, rgba(255,218,36,0.45) 92%, transparent 92%)', padding: '0 6px' }, children: 'room reveal' } },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: portrait ? '38px' : '40px', fontFamily: 'Outfit', fontWeight: 400, color: SLATE_MUTED, lineHeight: 1.45, maxWidth: '980px' },
                  children: `Stay right here. ${possessive} family is about to see the finished room for the first time.`,
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex', borderTop: '2px solid #E5E4E0', paddingTop: '30px',
              fontSize: `${urlSize}px`, fontFamily: 'Outfit', fontWeight: 700, color: SLATE_TEXT, letterSpacing: '0.02em',
            },
            children: url,
          },
        },
      ],
    },
  };

  const photoPanel = photoB64 ? {
    type: 'div',
    props: {
      style: { display: 'flex', width: `${photoW}px`, height: `${photoH}px`, position: 'relative' as const, flexShrink: 0 },
      children: [
        { type: 'img', props: { src: photoB64, width: photoW, height: photoH, style: { width: '100%', height: '100%', objectFit: 'cover' as const } } },
        // Yellow seam between photo and panel
        {
          type: 'div',
          props: {
            style: portrait
              ? { position: 'absolute' as const, left: 0, right: 0, bottom: 0, height: '10px', background: YELLOW, display: 'flex' }
              : { position: 'absolute' as const, top: 0, bottom: 0, left: 0, width: '10px', background: YELLOW, display: 'flex' },
          },
        },
      ],
    },
  } : null;

  return {
    type: 'div',
    props: {
      style: {
        width: '100%', height: '100%', display: 'flex',
        flexDirection: (portrait ? 'column' : 'row') as 'column' | 'row',
        background: CREAM,
      },
      children: portrait
        ? [photoPanel, textPanel].filter(Boolean)
        : [textPanel, photoPanel].filter(Boolean),
    },
  };
}

export async function generateSlateImage(o: SlateOptions): Promise<Buffer> {
  const cacheKey = ogCacheKey({ slate: 5, ...o });
  const cached = ogCacheGet(cacheKey);
  if (cached) return cached;

  const fonts = loadFonts();
  const logo = await getSlateLogo();
  const portrait = o.orientation === 'portrait';
  const W = portrait ? 1080 : 1920;
  const H = portrait ? 1920 : 1080;

  let photoB64: string | null = null;
  if (o.heroImage) {
    const pw = portrait ? W : Math.round(W * 0.42);
    const ph = portrait ? Math.round(H * 0.36) : H;
    const id = cfId(o.heroImage);
    photoB64 = await fetchImageBase64(`${CF_DIRECT}/${id}/${withFocus(id, `w=${pw},h=${ph},fit=cover,gravity=face,q=85`)}`);
  }

  const svg = await satori(slateTemplate(o, logo, photoB64) as any, {
    width: W,
    height: H,
    fonts: [
      { name: 'Outfit', data: fonts.outfit400, weight: 400, style: 'normal' as const },
      { name: 'Outfit', data: fonts.outfit700, weight: 700, style: 'normal' as const },
      { name: 'Libre Baskerville', data: fonts.libre700, weight: 700, style: 'normal' as const },
    ],
  });

  // Full-color PNG (no palette quantizing): this goes on video, banding would show
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  ogCacheSet(cacheKey, png);
  return png;
}
