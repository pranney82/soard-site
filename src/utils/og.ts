/**
 * og.ts — Top 1% OG image generator
 * 
 * Kid profiles: Hero photo as full-bleed background + gradient overlay + name
 * Static pages: Bold editorial typography with yellow accents + mascot
 * Articles: Category badge + strong title hierarchy + description
 * 
 * Uses Satori (HTML/CSS → SVG) + Sharp (SVG → PNG)
 * All generated at build time — zero runtime cost.
 */
import satori from 'satori';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { CF_HASH } from './cf-image';

// imagedelivery.net works at build time regardless of host (unlike the /cdn-cgi/ proxy)
const CF_DIRECT = `https://imagedelivery.net/${CF_HASH}`;

// ── Brand tokens ──────────────────────────────────
const YELLOW = '#FFDA24';
const DARK = '#2D2E33';
const DARK_DEEP = '#1A1B1F';
const WHITE = '#FFFFFF';
const MUTED = 'rgba(255,255,255,0.6)';

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

// ── Shared components ─────────────────────────────
function brandBadge() {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
      },
      children: [
        {
          type: 'img',
          props: { src: logoB64!, width: 48, height: 17, style: { objectFit: 'contain' as const } },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize: '15px', fontFamily: 'Outfit', fontWeight: 700,
              color: YELLOW, letterSpacing: '0.08em', textTransform: 'uppercase' as const,
            },
            children: 'Sunshine on a Ranney Day',
          },
        },
      ],
    },
  };
}

function siteUrl() {
  return {
    type: 'div',
    props: {
      style: { fontSize: '15px', fontFamily: 'Outfit', fontWeight: 400, color: MUTED },
      children: 'sunshineonaranneyday.com',
    },
  };
}

function pill(text: string, bg = YELLOW, fg = DARK) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex', alignItems: 'center',
        background: bg, color: fg,
        fontSize: '13px', fontFamily: 'Outfit', fontWeight: 700,
        padding: '5px 16px', borderRadius: '100px',
        textTransform: 'uppercase' as const, letterSpacing: '0.1em',
      },
      children: text,
    },
  };
}

// ═══════════════════════════════════════════════════
// TEMPLATE: KID PROFILE — Photo hero with overlay
// ═══════════════════════════════════════════════════
function kidWithPhoto(name: string, photoB64: string, age?: number | number[] | null, diagnosis?: string | null, roomTypes?: string[] | null) {
  const ageStr = age ? (Array.isArray(age) && age.length > 1 ? `Ages ${age.join(', ')}` : `Age ${Array.isArray(age) ? age[0] : age}`) : null;
  const meta = [ageStr, diagnosis ? truncate(diagnosis, 55) : null].filter(Boolean).join('  ·  ');
  const rooms = (roomTypes || []).join('  ·  ');

  return {
    type: 'div',
    props: {
      style: {
        width: '100%', height: '100%',
        display: 'flex', position: 'relative' as const,
        overflow: 'hidden' as const, background: DARK,
      },
      children: [
        // Background photo — fills entire frame
        {
          type: 'img',
          props: {
            src: photoB64,
            width: 1200, height: 630,
            style: {
              position: 'absolute' as const, top: 0, left: 0,
              width: '100%', height: '100%',
              objectFit: 'cover' as const,
            },
          },
        },
        // Gradient overlay — dark from bottom for text readability
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, bottom: 0, left: 0, right: 0,
              height: '75%',
              background: 'linear-gradient(to top, rgba(26,27,31,0.95) 0%, rgba(26,27,31,0.85) 35%, rgba(26,27,31,0.4) 70%, transparent 100%)',
              display: 'flex',
            },
          },
        },
        // Yellow top accent bar
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, top: 0, left: 0, right: 0,
              height: '5px', background: YELLOW, display: 'flex',
            },
          },
        },
        // Content overlay
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, bottom: 0, left: 0, right: 0,
              display: 'flex', flexDirection: 'column' as const,
              padding: '0 60px 40px',
              gap: '8px',
            },
            children: [
              // "MEET" label
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '16px', fontFamily: 'Outfit', fontWeight: 700,
                    color: YELLOW, letterSpacing: '0.15em', textTransform: 'uppercase' as const,
                  },
                  children: 'Meet',
                },
              },
              // Name — large serif
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '62px', fontFamily: 'Libre Baskerville', fontWeight: 700,
                    color: WHITE, lineHeight: 1.05,
                  },
                  children: truncate(name, 28),
                },
              },
              // Meta line
              ...(meta ? [{
                type: 'div',
                props: {
                  style: {
                    fontSize: '19px', fontFamily: 'Outfit', fontWeight: 400,
                    color: 'rgba(255,255,255,0.75)', lineHeight: 1.4, marginTop: '4px',
                  },
                  children: meta,
                },
              }] : []),
              // Room types in yellow
              ...(rooms ? [{
                type: 'div',
                props: {
                  style: {
                    fontSize: '17px', fontFamily: 'Outfit', fontWeight: 600,
                    color: YELLOW, marginTop: '2px',
                  },
                  children: rooms,
                },
              }] : []),
              // Bottom bar: URL + branding
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex', justifyContent: 'space-between' as const,
                    alignItems: 'center', marginTop: '16px',
                    borderTop: '1px solid rgba(255,255,255,0.15)',
                    paddingTop: '14px',
                  },
                  children: [siteUrl(), pill('Meet the Kids')],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

// ═══════════════════════════════════════════════════
// TEMPLATE: KID PROFILE — Text fallback (no photo)
// ═══════════════════════════════════════════════════
function kidTextOnly(name: string, age?: number | number[] | null, diagnosis?: string | null, roomTypes?: string[] | null) {
  const ageStr = age ? (Array.isArray(age) && age.length > 1 ? `Ages ${age.join(', ')}` : `Age ${Array.isArray(age) ? age[0] : age}`) : null;
  const meta = [ageStr, diagnosis ? truncate(diagnosis, 55) : null].filter(Boolean).join('  ·  ');
  const rooms = (roomTypes || []).join('  ·  ');

  return {
    type: 'div',
    props: {
      style: {
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column' as const,
        background: DARK_DEEP,
      },
      children: [
        // Yellow top bar
        { type: 'div', props: { style: { width: '100%', height: '5px', background: YELLOW, display: 'flex' } } },
        {
          type: 'div',
          props: {
            style: {
              flex: 1, display: 'flex', flexDirection: 'column' as const,
              justifyContent: 'space-between' as const,
              padding: '44px 60px 36px',
            },
            children: [
              // Top: branding + pill
              {
                type: 'div',
                props: {
                  style: { display: 'flex', justifyContent: 'space-between' as const, alignItems: 'center' },
                  children: [brandBadge(), pill('Meet the Kids')],
                },
              },
              // Center: name + details
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' as const, gap: '10px' },
                  children: [
                    { type: 'div', props: { style: { fontSize: '16px', fontFamily: 'Outfit', fontWeight: 700, color: YELLOW, letterSpacing: '0.15em', textTransform: 'uppercase' as const }, children: 'Meet' } },
                    { type: 'div', props: { style: { fontSize: '62px', fontFamily: 'Libre Baskerville', fontWeight: 700, color: WHITE, lineHeight: 1.05 }, children: truncate(name, 28) } },
                    ...(meta ? [{ type: 'div', props: { style: { fontSize: '20px', fontFamily: 'Outfit', fontWeight: 400, color: MUTED, lineHeight: 1.4 }, children: meta } }] : []),
                    ...(rooms ? [{ type: 'div', props: { style: { fontSize: '17px', fontFamily: 'Outfit', fontWeight: 600, color: YELLOW }, children: rooms } }] : []),
                  ],
                },
              },
              siteUrl(),
            ],
          },
        },
        // Yellow bottom bar
        { type: 'div', props: { style: { width: '100%', height: '5px', background: YELLOW, display: 'flex' } } },
      ],
    },
  };
}

// ═══════════════════════════════════════════════════
// TEMPLATE: DEFAULT PAGE — Photo hero with overlay
// ═══════════════════════════════════════════════════
function defaultWithPhoto(title: string, photoB64: string, subtitle?: string) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%', height: '100%',
        display: 'flex', position: 'relative' as const,
        overflow: 'hidden' as const, background: DARK,
      },
      children: [
        // Background photo — fills entire frame
        {
          type: 'img',
          props: {
            src: photoB64,
            width: 1200, height: 630,
            style: {
              position: 'absolute' as const, top: 0, left: 0,
              width: '100%', height: '100%',
              objectFit: 'cover' as const,
            },
          },
        },
        // Gradient overlay — dark from bottom for text readability
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, bottom: 0, left: 0, right: 0,
              height: '80%',
              background: 'linear-gradient(to top, rgba(26,27,31,0.95) 0%, rgba(26,27,31,0.85) 40%, rgba(26,27,31,0.4) 75%, transparent 100%)',
              display: 'flex',
            },
          },
        },
        // Yellow top accent bar
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, top: 0, left: 0, right: 0,
              height: '5px', background: YELLOW, display: 'flex',
            },
          },
        },
        // Content overlay
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, bottom: 0, left: 0, right: 0,
              display: 'flex', flexDirection: 'column' as const,
              padding: '0 60px 40px',
              gap: '12px',
            },
            children: [
              // Yellow accent line
              { type: 'div', props: { style: { width: '64px', height: '4px', background: YELLOW, borderRadius: '2px', display: 'flex' } } },
              // Title
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '54px', fontFamily: 'Libre Baskerville', fontWeight: 700,
                    color: WHITE, lineHeight: 1.12, maxWidth: '920px',
                  },
                  children: truncate(title, 70),
                },
              },
              ...(subtitle ? [{
                type: 'div',
                props: {
                  style: {
                    fontSize: '21px', fontFamily: 'Outfit', fontWeight: 400,
                    color: 'rgba(255,255,255,0.8)', maxWidth: '800px', lineHeight: 1.45,
                  },
                  children: truncate(subtitle, 120),
                },
              }] : []),
              // Bottom bar: URL + branding
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex', justifyContent: 'space-between' as const,
                    alignItems: 'center', marginTop: '10px',
                    borderTop: '1px solid rgba(255,255,255,0.15)',
                    paddingTop: '14px',
                  },
                  children: [siteUrl(), brandBadge()],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

// ═══════════════════════════════════════════════════
// TEMPLATE: DEFAULT PAGE — Text fallback (no photo)
// ═══════════════════════════════════════════════════
function defaultTextOnly(title: string, subtitle?: string) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column' as const,
        background: DARK_DEEP,
        position: 'relative' as const,
      },
      children: [
        // Yellow top accent
        { type: 'div', props: { style: { width: '100%', height: '5px', background: YELLOW, display: 'flex' } } },
        // Large decorative yellow circle (top-right corner, partially clipped)
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, top: '-120px', right: '-80px',
              width: '360px', height: '360px', borderRadius: '50%',
              background: 'rgba(255,218,36,0.07)', display: 'flex',
            },
          },
        },
        // Content
        {
          type: 'div',
          props: {
            style: {
              flex: 1, display: 'flex', flexDirection: 'column' as const,
              justifyContent: 'space-between' as const,
              padding: '44px 60px 36px',
            },
            children: [
              brandBadge(),
              // Title block
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' as const, gap: '16px' },
                  children: [
                    // Yellow accent line
                    { type: 'div', props: { style: { width: '64px', height: '4px', background: YELLOW, borderRadius: '2px', display: 'flex' } } },
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '54px', fontFamily: 'Libre Baskerville', fontWeight: 700,
                          color: WHITE, lineHeight: 1.12, maxWidth: '920px',
                        },
                        children: truncate(title, 70),
                      },
                    },
                    ...(subtitle ? [{
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '21px', fontFamily: 'Outfit', fontWeight: 400,
                          color: MUTED, maxWidth: '800px', lineHeight: 1.45,
                        },
                        children: truncate(subtitle, 120),
                      },
                    }] : []),
                  ],
                },
              },
              siteUrl(),
            ],
          },
        },
        // Yellow bottom bar
        { type: 'div', props: { style: { width: '100%', height: '5px', background: YELLOW, display: 'flex' } } },
      ],
    },
  };
}

// ═══════════════════════════════════════════════════
// TEMPLATE: ARTICLE — Photo hero with tag badge
// ═══════════════════════════════════════════════════
function articleWithPhoto(title: string, tag: string, photoB64: string, description?: string) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%', height: '100%',
        display: 'flex', position: 'relative' as const,
        overflow: 'hidden' as const, background: DARK,
      },
      children: [
        // Background photo
        {
          type: 'img',
          props: {
            src: photoB64,
            width: 1200, height: 630,
            style: {
              position: 'absolute' as const, top: 0, left: 0,
              width: '100%', height: '100%',
              objectFit: 'cover' as const,
            },
          },
        },
        // Gradient overlay
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, bottom: 0, left: 0, right: 0,
              height: '85%',
              background: 'linear-gradient(to top, rgba(26,27,31,0.95) 0%, rgba(26,27,31,0.88) 40%, rgba(26,27,31,0.4) 75%, transparent 100%)',
              display: 'flex',
            },
          },
        },
        // Yellow top accent bar
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, top: 0, left: 0, right: 0,
              height: '5px', background: YELLOW, display: 'flex',
            },
          },
        },
        // Left accent stripe
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, top: '5px', left: 0, bottom: 0,
              width: '6px', background: YELLOW, display: 'flex',
            },
          },
        },
        // Content overlay
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, bottom: 0, left: 0, right: 0,
              display: 'flex', flexDirection: 'column' as const,
              padding: '0 60px 40px 72px',
              gap: '12px',
            },
            children: [
              pill(tag || 'Resource Guide'),
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '46px', fontFamily: 'Libre Baskerville', fontWeight: 700,
                    color: WHITE, lineHeight: 1.18, maxWidth: '1000px',
                  },
                  children: truncate(title, 90),
                },
              },
              ...(description ? [{
                type: 'div',
                props: {
                  style: {
                    fontSize: '20px', fontFamily: 'Outfit', fontWeight: 400,
                    color: 'rgba(255,255,255,0.8)', maxWidth: '900px', lineHeight: 1.4,
                  },
                  children: truncate(description, 130),
                },
              }] : []),
              // Bottom bar
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex', justifyContent: 'space-between' as const,
                    alignItems: 'center', marginTop: '10px',
                    borderTop: '1px solid rgba(255,255,255,0.15)',
                    paddingTop: '14px',
                  },
                  children: [siteUrl(), brandBadge()],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

// ═══════════════════════════════════════════════════
// TEMPLATE: ARTICLE — Text fallback (no photo)
// ═══════════════════════════════════════════════════
function articleTextOnly(title: string, tag: string, description?: string) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column' as const,
        background: DARK_DEEP,
        position: 'relative' as const,
      },
      children: [
        // Yellow top accent
        { type: 'div', props: { style: { width: '100%', height: '5px', background: YELLOW, display: 'flex' } } },
        // Left accent stripe (editorial feel)
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const, top: '5px', left: 0, bottom: '5px',
              width: '6px', background: YELLOW, display: 'flex',
            },
          },
        },
        // Content
        {
          type: 'div',
          props: {
            style: {
              flex: 1, display: 'flex', flexDirection: 'column' as const,
              justifyContent: 'space-between' as const,
              padding: '44px 60px 36px 72px',
            },
            children: [
              brandBadge(),
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' as const, gap: '16px' },
                  children: [
                    pill(tag || 'Resource Guide'),
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '46px', fontFamily: 'Libre Baskerville', fontWeight: 700,
                          color: WHITE, lineHeight: 1.18, maxWidth: '1000px',
                        },
                        children: truncate(title, 90),
                      },
                    },
                    ...(description ? [{
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '20px', fontFamily: 'Outfit', fontWeight: 400,
                          color: MUTED, maxWidth: '900px', lineHeight: 1.4,
                        },
                        children: truncate(description, 130),
                      },
                    }] : []),
                  ],
                },
              },
              siteUrl(),
            ],
          },
        },
        // Yellow bottom bar
        { type: 'div', props: { style: { width: '100%', height: '5px', background: YELLOW, display: 'flex' } } },
      ],
    },
  };
}

// ═══════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════
export type OgTemplate = 'default' | 'kid' | 'article';

export interface OgOptions {
  template: OgTemplate;
  title: string;
  subtitle?: string;
  age?: number | number[] | null;
  diagnosis?: string | null;
  roomTypes?: string[] | null;
  heroImage?: string | null;
  tag?: string;
  description?: string;
}

export async function generateOgImage(opts: OgOptions): Promise<Buffer> {
  const fonts = loadFonts();
  await getLogo();

  let element: any;
  switch (opts.template) {
    case 'kid': {
      // Try to fetch the hero photo for a photo-backed OG image
      let photoB64: string | null = null;
      if (opts.heroImage) {
        // heroImage is a bare CF image ID (e.g. "kids/zyah/photo-18") — build a full URL
        const imgUrl = opts.heroImage.startsWith('http')
          ? opts.heroImage
          : `${CF_DIRECT}/${opts.heroImage}/w=1200,h=630,fit=cover,gravity=face,q=80`;
        photoB64 = await fetchImageBase64(imgUrl);
      }
      if (photoB64) {
        element = kidWithPhoto(opts.title, photoB64, opts.age, opts.diagnosis, opts.roomTypes);
      } else {
        element = kidTextOnly(opts.title, opts.age, opts.diagnosis, opts.roomTypes);
      }
      break;
    }
    case 'article': {
      let photoB64: string | null = null;
      if (opts.heroImage) {
        const imgUrl = opts.heroImage.startsWith('http')
          ? opts.heroImage
          : `${CF_DIRECT}/${opts.heroImage}/w=1200,h=630,fit=cover,gravity=auto,q=80`;
        photoB64 = await fetchImageBase64(imgUrl);
      }
      if (photoB64) {
        element = articleWithPhoto(opts.title, opts.tag || 'Guide', photoB64, opts.description);
      } else {
        element = articleTextOnly(opts.title, opts.tag || 'Guide', opts.description);
      }
      break;
    }
    default: {
      // Try to fetch the hero photo for a photo-backed OG image
      let photoB64: string | null = null;
      if (opts.heroImage) {
        const imgUrl = opts.heroImage.startsWith('http')
          ? opts.heroImage
          : `${CF_DIRECT}/${opts.heroImage}/w=1200,h=630,fit=cover,gravity=auto,q=80`;
        photoB64 = await fetchImageBase64(imgUrl);
      }
      if (photoB64) {
        element = defaultWithPhoto(opts.title, photoB64, opts.subtitle);
      } else {
        element = defaultTextOnly(opts.title, opts.subtitle);
      }
      break;
    }
  }

  const svg = await satori(element, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Outfit', data: fonts.outfit400, weight: 400, style: 'normal' as const },
      { name: 'Outfit', data: fonts.outfit700, weight: 700, style: 'normal' as const },
      { name: 'Libre Baskerville', data: fonts.libre700, weight: 700, style: 'normal' as const },
    ],
  });

  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true })
    .toBuffer();

  return png;
}
