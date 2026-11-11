/**
 * reveal-design-client.ts — a kid's design, read and drawn in the browser
 * =======================================================================
 * The starting-soon screen (SlateScreen.astro, via slate-design.ts) and the
 * live page's "The design" section (LiveDesign.astro) both ask
 * /api/reveal-design for the before photos, drawings and boards, which it
 * only gives from an hour before the reveal (public/admin/reveal-design.js
 * has the rules). This is the one place that asks, and the one place that
 * turns a slide into a picture address.
 *
 * The family's address: a floor plan that still has its title block is only
 * ever asked of Cloudflare cropped above it (the bottom TITLE_BLOCK), never
 * whole. Its shape is known from the profile, or read off a 96px copy first
 * (too small to read anything on).
 */
import { cfRaw } from './cf-image';

export type DesignKind = 'before' | 'as-built' | 'proposed' | 'board';
export interface DesignSlide {
  kind: DesignKind;
  url: string;
  alt: string;
  /** What it is, in one word, on the picture itself: 'Before', 'Existing', 'Proposed' ('' or missing: a board) */
  badge?: string;
  kicker: string;
  caption: string;
  /** Still has its title block: shown cropped above it */
  crop: boolean;
  w?: number;
  h?: number;
}
export interface DesignAnswer {
  open: boolean;
  /** The reveal has started: the room is "before", not "today" */
  after?: boolean;
  opensAt?: string | null;
  name?: string;
  slides?: DesignSlide[];
}

const TITLE_BLOCK = 0.10;

/** Ask whether a kid's design is open; null when the answer couldn't be had (try again later) */
export async function fetchDesign(kid: string, signal?: AbortSignal): Promise<DesignAnswer | null> {
  if (!kid) return null;
  try {
    const res = await fetch(`/api/reveal-design?kid=${encodeURIComponent(kid)}`, { cache: 'no-store', signal });
    if (res.status === 404) return { open: false, opensAt: null };
    if (!res.ok) return null;
    const d = await res.json();
    return { open: !!d?.open, after: !!d?.after, opensAt: d?.opensAt || null, name: d?.name || '', slides: Array.isArray(d?.slides) ? d.slides.filter(validSlide) : [] };
  } catch {
    return null;
  }
}

const KINDS = new Set(['before', 'as-built', 'proposed', 'board']);
export const validSlide = (s: any): s is DesignSlide => !!s && KINDS.has(s.kind) && typeof s.url === 'string' && !!s.url && !/^(blob|data):/.test(s.url);

/** Same slides, same order: nothing to redraw */
export const designSignature = (slides: DesignSlide[]) => slides.map((s) => `${s.kind}|${s.url}|${s.crop ? 1 : 0}|${s.caption}`).join('\n');

const ratios = new Map<string, Promise<number | null>>();
/** height ÷ width of a picture, read off a tiny copy */
function ratioOf(url: string): Promise<number | null> {
  let p = ratios.get(url);
  if (!p) {
    p = new Promise((done) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => done(img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : null);
      img.onerror = () => done(null);
      img.src = cfRaw(url, 'w=96,fit=scale-down,q=40');
    });
    ratios.set(url, p);
  }
  return p;
}

/**
 * A slide's picture at about w pixels across. Photos and boards as they are;
 * a floor plan with its title block cut off above it. null: a plan whose shape
 * couldn't be read, which is left out rather than shown whole.
 */
export async function slideSrc(slide: DesignSlide, w: number): Promise<string | null> {
  const width = Math.max(64, Math.round(w));
  if (slide.kind === 'before') return cfRaw(slide.url, `w=${width},fit=scale-down,q=85`);
  // Plain white edges trimmed off, so the drawing fills its paper (never on a plan still to be cropped: trimming first
  // would change its shape, and the crop below could then miss the title block)
  if (!slide.crop) return cfRaw(slide.url, `trim=border,w=${width},fit=scale-down,q=90`);
  const r = slide.w && slide.h ? slide.h / slide.w : await ratioOf(slide.url);
  if (!r) return null;
  const h = Math.max(32, Math.round(width * r * (1 - TITLE_BLOCK)));
  return cfRaw(slide.url, `w=${width},h=${h},fit=cover,gravity=top,q=90`);
}

/** Load a picture fully before it's shown; false when it can't be */
export function preload(src: string): Promise<boolean> {
  return new Promise((done) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { (img.decode ? img.decode().catch(() => undefined) : Promise.resolve()).then(() => done(img.naturalWidth > 0)); };
    img.onerror = () => done(false);
    img.src = src;
  });
}
