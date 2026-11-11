/**
 * Which share card each page has (see og-card.ts for the cards themselves).
 *
 * BaseLayout calls registerCard() as it builds a page: the page's card is
 * written down here with its key (everything its pixels depend on), and the
 * page links /og/<its path>.jpg?v=<key>. After the pages are built,
 * src/integrations/og-cards.mjs draws every card written down and puts each
 * one's own fingerprint in place of the key in the pages, so a page can never
 * point at a card that wasn't made, and an address changes exactly when its
 * picture does (Facebook, LinkedIn, Slack and the rest then fetch it again).
 *
 * Each build or dev server keeps its list in its own folder (by process), so
 * two builds sharing node_modules can't wipe or mix each other's lists.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cardKey, cardAlt, type CardSpec } from './og-card';

export type { CardSpec, CardPhoto, Look } from './og-card';

/** Where this process's pages write their cards down for the build (Astro's own cache folder) */
export const OG_SPEC_ROOT = path.resolve(process.env.SOARD_OG_SPEC_DIR || './node_modules/.astro/og-cards');
export const OG_SPEC_DIR = path.join(OG_SPEC_ROOT, String(process.pid));

export interface CardEntry {
  page: string;      // the page's path, "/kids/amari/"
  file: string;      // "/og/kids/amari.jpg"
  key: string;       // everything the picture depends on
  url: string;       // file + "?v=" + key, until the build puts the picture's fingerprint there
  alt: string;
  spec: CardSpec;
}

/** "/" → "/og/home.jpg", "/kids/amari/" → "/og/kids/amari.jpg" */
export function cardFile(page: string): string {
  const clean = page.replace(/\/index\.html$/, '/').replace(/\.html$/, '').replace(/^\/+|\/+$/g, '');
  return `/og/${clean || 'home'}.jpg`;
}

/** A page's path as its address ends: always with one "/" */
export function pagePath(pathname: string): string {
  const p = `/${String(pathname || '/').replace(/^\/+|\/+$/g, '')}/`;
  return p === '//' ? '/' : p;
}

const specFile = (page: string) => path.join(OG_SPEC_DIR, `${crypto.createHash('sha1').update(page).digest('hex')}.json`);

/** Writes down a page's card and gives back its entry (the address the page shows) */
export async function registerCard(pathname: string, spec: CardSpec): Promise<CardEntry> {
  const page = pagePath(pathname);
  const key = await cardKey(spec);
  const file = cardFile(page);
  const entry: CardEntry = { page, file, key, url: `${file}?v=${key}`, alt: cardAlt(spec), spec };
  fs.mkdirSync(OG_SPEC_DIR, { recursive: true });
  fs.writeFileSync(specFile(page), JSON.stringify(entry));
  return entry;
}

/** Every card this process has written down */
export function readCards(): CardEntry[] {
  if (!fs.existsSync(OG_SPEC_DIR)) return [];
  return fs.readdirSync(OG_SPEC_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(OG_SPEC_DIR, f), 'utf8')) as CardEntry);
}

/** A process still running (a build or dev server whose list this is) */
function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** Starts a build with nothing written down, and clears lists left by builds and dev servers that have ended */
export function clearCards(): void {
  fs.rmSync(OG_SPEC_DIR, { recursive: true, force: true });
  if (!fs.existsSync(OG_SPEC_ROOT)) return;
  for (const d of fs.readdirSync(OG_SPEC_ROOT)) {
    const pid = Number(d);
    if (!Number.isInteger(pid) || pid === process.pid || running(pid)) continue;
    fs.rmSync(path.join(OG_SPEC_ROOT, d), { recursive: true, force: true });
  }
}
