/**
 * og.ts — Best-in-class OG image generator
 * Uses Satori (HTML/CSS → SVG) + Sharp (SVG → PNG)
 * Generated at build time as Astro static endpoints
 * 
 * Design system:
 * - Dark background (#2D2E33) with subtle texture
 * - Yellow accent bars (#FFD500)
 * - Outfit (body) + Libre Baskerville (display) fonts
 * - SOARD branding on every image
 */
import satori from 'satori';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const YELLOW = '#FFD500';
const DARK = '#2D2E33';
const DARK_DEEP = '#1A1B1F';
const CREAM = '#FEFCF5';
const MUTED = 'rgba(255,255,255,0.55)';
const WHITE = '#FFFFFF';

// ── Font Loading ─────────────────────────────────
// Cache fonts across calls during the same build
let fontCache: { outfit400: ArrayBuffer; outfit700: ArrayBuffer; libre700: ArrayBuffer } | null = null;

async function loadFonts() {
  if (fontCache) return fontCache;

  // Load woff fonts from @fontsource packages (satori supports woff, not woff2)
  function readFont(pkgPath: string): ArrayBuffer {
    const fullPath = path.resolve(`./node_modules/${pkgPath}`);
    const buf = fs.readFileSync(fullPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  fontCache = {
    outfit400: readFont('@fontsource/outfit/files/outfit-latin-400-normal.woff'),
    outfit700: readFont('@fontsource/outfit/files/outfit-latin-700-normal.woff'),
    libre700: readFont('@fontsource/libre-baskerville/files/libre-baskerville-latin-700-normal.woff'),
  };
  return fontCache;
}

// ── Logo as base64 ───────────────────────────────
let logoBase64Cache: string | null = null;

function getLogoBase64(): string {
  if (logoBase64Cache) return logoBase64Cache;
  const logoPath = path.resolve('./public/images/logos/sunny-pig-transparent.png');
  const buf = fs.readFileSync(logoPath);
  logoBase64Cache = `data:image/png;base64,${buf.toString('base64')}`;
  return logoBase64Cache;
}

// ── Shared layout elements ───────────────────────
function topBar() {
  return {
    type: 'div',
    props: {
      style: { width: '100%', height: '6px', background: YELLOW, flexShrink: 0, display: 'flex' as const },
    },
  };
}

function bottomBar() {
  return {
    type: 'div',
    props: {
      style: { width: '100%', height: '6px', background: YELLOW, flexShrink: 0, display: 'flex' as const },
    },
  };
}

function brandingRow() {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
      },
      children: [
        {
          type: 'img',
          props: {
            src: getLogoBase64(),
            width: 52,
            height: 18,
            style: { objectFit: 'contain' as const },
          },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize: '16px',
              fontFamily: 'Outfit',
              fontWeight: 700,
              color: YELLOW,
              letterSpacing: '0.06em',
              textTransform: 'uppercase' as const,
            },
            children: 'Sunshine on a Ranney Day',
          },
        },
      ],
    },
  };
}

function urlFooter() {
  return {
    type: 'div',
    props: {
      style: {
        fontSize: '16px',
        fontFamily: 'Outfit',
        fontWeight: 400,
        color: MUTED,
        letterSpacing: '0.02em',
      },
      children: 'sunshineonaranneyday.com',
    },
  };
}

function tagBadge(text: string) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        background: YELLOW,
        color: DARK,
        fontSize: '14px',
        fontFamily: 'Outfit',
        fontWeight: 700,
        padding: '5px 16px',
        borderRadius: '100px',
        textTransform: 'uppercase' as const,
        letterSpacing: '0.08em',
      },
      children: text,
    },
  };
}

// ── Templates ────────────────────────────────────

/** Default page template — clean, branded, bold title */
function defaultTemplate(title: string, subtitle?: string) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column' as const,
        background: DARK,
        color: WHITE,
      },
      children: [
        topBar(),
        {
          type: 'div',
          props: {
            style: {
              flex: 1,
              display: 'flex',
              flexDirection: 'column' as const,
              justifyContent: 'space-between' as const,
              padding: '48px 64px 40px',
            },
            children: [
              brandingRow(),
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' as const, gap: '16px' },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '52px',
                          fontFamily: 'Libre Baskerville',
                          fontWeight: 700,
                          lineHeight: 1.15,
                          color: WHITE,
                          maxWidth: '900px',
                        },
                        children: truncate(title, 80),
                      },
                    },
                    ...(subtitle ? [{
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '22px',
                          fontFamily: 'Outfit',
                          fontWeight: 400,
                          color: MUTED,
                          maxWidth: '800px',
                          lineHeight: 1.4,
                        },
                        children: truncate(subtitle, 120),
                      },
                    }] : []),
                  ],
                },
              },
              urlFooter(),
            ],
          },
        },
        bottomBar(),
      ],
    },
  };
}

/** Kid profile template — name hero, diagnosis, room types */
function kidTemplate(name: string, age?: number | null, diagnosis?: string | null, roomTypes?: string[] | null) {
  const metaParts: string[] = [];
  if (age) metaParts.push(`Age ${age}`);
  if (diagnosis) metaParts.push(truncate(diagnosis, 60));
  const meta = metaParts.join('  ·  ');
  const rooms = (roomTypes || []).join('  ·  ');

  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column' as const,
        background: DARK,
        color: WHITE,
      },
      children: [
        topBar(),
        {
          type: 'div',
          props: {
            style: {
              flex: 1,
              display: 'flex',
              flexDirection: 'column' as const,
              justifyContent: 'space-between' as const,
              padding: '48px 64px 40px',
            },
            children: [
              // Top: branding + "Meet the Kids" tag
              {
                type: 'div',
                props: {
                  style: { display: 'flex', justifyContent: 'space-between' as const, alignItems: 'center' },
                  children: [
                    brandingRow(),
                    tagBadge('Meet the Kids'),
                  ],
                },
              },
              // Center: Name + meta
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' as const, gap: '12px' },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '18px',
                          fontFamily: 'Outfit',
                          fontWeight: 600,
                          color: YELLOW,
                          letterSpacing: '0.12em',
                          textTransform: 'uppercase' as const,
                        },
                        children: 'Meet',
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '64px',
                          fontFamily: 'Libre Baskerville',
                          fontWeight: 700,
                          lineHeight: 1.1,
                          color: WHITE,
                        },
                        children: truncate(name, 30),
                      },
                    },
                    ...(meta ? [{
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '20px',
                          fontFamily: 'Outfit',
                          fontWeight: 400,
                          color: MUTED,
                          lineHeight: 1.4,
                        },
                        children: meta,
                      },
                    }] : []),
                    ...(rooms ? [{
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '18px',
                          fontFamily: 'Outfit',
                          fontWeight: 600,
                          color: YELLOW,
                          marginTop: '4px',
                        },
                        children: rooms,
                      },
                    }] : []),
                  ],
                },
              },
              urlFooter(),
            ],
          },
        },
        bottomBar(),
      ],
    },
  };
}

/** Article/resource guide template */
function articleTemplate(title: string, tag: string, description?: string) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column' as const,
        background: DARK,
        color: WHITE,
      },
      children: [
        topBar(),
        {
          type: 'div',
          props: {
            style: {
              flex: 1,
              display: 'flex',
              flexDirection: 'column' as const,
              justifyContent: 'space-between' as const,
              padding: '48px 64px 40px',
            },
            children: [
              // Top: branding
              brandingRow(),
              // Center: tag + title + description
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' as const, gap: '16px' },
                  children: [
                    tagBadge(tag || 'Resource Guide'),
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '44px',
                          fontFamily: 'Libre Baskerville',
                          fontWeight: 700,
                          lineHeight: 1.2,
                          color: WHITE,
                          maxWidth: '1000px',
                        },
                        children: truncate(title, 100),
                      },
                    },
                    ...(description ? [{
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '20px',
                          fontFamily: 'Outfit',
                          fontWeight: 400,
                          color: MUTED,
                          maxWidth: '900px',
                          lineHeight: 1.4,
                        },
                        children: truncate(description, 140),
                      },
                    }] : []),
                  ],
                },
              },
              urlFooter(),
            ],
          },
        },
        bottomBar(),
      ],
    },
  };
}

// ── Helpers ───────────────────────────────────────
function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// ── Generator ────────────────────────────────────
export type OgTemplate = 'default' | 'kid' | 'article';

export interface OgOptions {
  template: OgTemplate;
  title: string;
  subtitle?: string;
  // Kid-specific
  age?: number | null;
  diagnosis?: string | null;
  roomTypes?: string[] | null;
  // Article-specific
  tag?: string;
  description?: string;
}

export async function generateOgImage(opts: OgOptions): Promise<Buffer> {
  const fonts = await loadFonts();

  let element: any;
  switch (opts.template) {
    case 'kid':
      element = kidTemplate(opts.title, opts.age, opts.diagnosis, opts.roomTypes);
      break;
    case 'article':
      element = articleTemplate(opts.title, opts.tag || 'Guide', opts.description);
      break;
    default:
      element = defaultTemplate(opts.title, opts.subtitle);
  }

  const svg = await satori(element, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Outfit', data: fonts.outfit400, weight: 400, style: 'normal' },
      { name: 'Outfit', data: fonts.outfit700, weight: 700, style: 'normal' },
      { name: 'Libre Baskerville', data: fonts.libre700, weight: 700, style: 'normal' },
    ],
  });

  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true })
    .toBuffer();

  return png;
}
