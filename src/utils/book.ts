/**
 * The anniversary book. Admin → Site Config → Anniversary book saves it to
 * D1 (site_config 'book'); the build writes that to src/content/site/book.json.
 * The reader is src/components/book/, the page src/pages/[book].astro.
 *
 * The page is built only when the book has pages and "On the site" is on,
 * at the address the admin gives it (/15-years/ unless it's changed). An
 * address another page, a Function or a redirect already has is never
 * used: the book keeps the default instead.
 *
 * BOOK_FIXTURE=<a JSON file> builds from that file instead of the saved
 * book, for local tests (scripts/test-book.mjs); nothing in src/content is
 * touched.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const saved = import.meta.glob('../content/site/book.json', { eager: true, import: 'default' }) as Record<string, any>;

export const BOOK_DEFAULT_SLUG = '15-years';
export const BOOK_DEFAULTS = {
  eyebrow: '15th anniversary',
  title: '15 Years of <em>Sunshine</em>',
  description: 'The story of Sunshine on a Ranney Day, from the first room in 2012 to today. Turn the pages here, or download the PDF to keep.',
};

export interface BookLink { x: number; y: number; w: number; h: number; url?: string; page?: number }
export interface BookPage { id: string; src?: string; w: number; h: number; text?: string; links?: BookLink[] }
export interface Book {
  slug: string;
  live: boolean;
  eyebrow: string;
  titleHtml: string;
  titleText: string;
  description: string;
  pages: BookPage[];
  chapters: { title: string; page: number }[];
  pdf: { url: string; name: string; bytes: number } | null;
  textUrl: string | null;
  insetPage: number;
  version: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Every address the site already answers at the top level: pages, Functions, files and redirects */
function takenSlugs(): Set<string> {
  const root = process.cwd();
  const names = new Set<string>();
  const add = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (f.startsWith('[') || f.startsWith('_')) continue;
      names.add(f.replace(/\.(astro|md|mdx|ts|js|html)$/, '').toLowerCase());
    }
  };
  add(join(root, 'src/pages'));
  add(join(root, 'functions'));
  add(join(root, 'public'));
  try {
    for (const line of readFileSync(join(root, 'public/_redirects'), 'utf8').split('\n')) {
      const m = /^\/([^/\s#]+)/.exec(line.trim());
      if (m) names.add(m[1].toLowerCase());
    }
  } catch { /* no redirects file */ }
  return names;
}

/** Only <em> survives from the admin's title (its highlighted words); everything else is text */
export function bookTitleHtml(title: string): string {
  const esc = String(title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc.replace(/&lt;(\/?)em&gt;/gi, '<$1em>').replace(/&amp;(nbsp|amp);/g, '&$1;');
}
export const plainTitle = (title: string) => String(title || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** "84 MB", "960 KB" */
export function bookSize(bytes: number): string {
  const b = Number(bytes) || 0;
  if (b <= 0) return '';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e7) return `${Math.round(b / 1e6)} MB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}

function read(): any {
  const fixture = process.env.BOOK_FIXTURE;
  if (fixture) return JSON.parse(readFileSync(fixture, 'utf8'));
  return Object.values(saved)[0] || null;
}

/** The book as the page uses it, or null when there isn't one to show */
export function getBook(): Book | null {
  const d = read();
  if (!d || typeof d !== 'object') return null;
  // A test book's pictures can come from anywhere (a local server); a saved one's are Cloudflare images
  const test = !!process.env.BOOK_FIXTURE;
  const pages: BookPage[] = (Array.isArray(d.pages) ? d.pages : [])
    .filter((p: any) => p && typeof p.id === 'string' && p.id && Number(p.w) > 0 && Number(p.h) > 0)
    .map((p: any) => ({
      ...(test && typeof p.src === 'string' ? { src: p.src } : {}),
      id: p.id,
      w: Number(p.w),
      h: Number(p.h),
      text: typeof p.text === 'string' ? p.text : '',
      links: (Array.isArray(p.links) ? p.links : []).filter((l: any) => l && [l.x, l.y, l.w, l.h].every((v) => Number.isFinite(v))
        && ((typeof l.url === 'string' && /^(https?:|mailto:)/i.test(l.url)) || Number.isInteger(l.page))),
    }));
  const n = pages.length;
  const wanted = String(d.slug || '').trim().toLowerCase();
  const slug = SLUG.test(wanted) && !takenSlugs().has(wanted) ? wanted : BOOK_DEFAULT_SLUG;
  const title = String(d.title || '').trim() || BOOK_DEFAULTS.title;
  const chapters = (Array.isArray(d.chapters) ? d.chapters : [])
    .filter((c: any) => c && String(c.title || '').trim() && Number.isInteger(c.page) && c.page >= 0 && c.page < n)
    .map((c: any) => ({ title: String(c.title).trim(), page: c.page }))
    .sort((a: any, b: any) => a.page - b.page);
  const pdf = d.pdf && typeof d.pdf.url === 'string' && /^\/files\/books\//.test(d.pdf.url)
    ? { url: d.pdf.url, name: String(d.pdf.name || 'book.pdf'), bytes: Number(d.pdf.bytes) || 0 }
    : null;
  const inset = Number.isInteger(d.insetPage) && d.insetPage > 0 && d.insetPage < n ? d.insetPage : Math.min(n - 1, Math.max(1, Math.round(n / 4)));
  return {
    slug,
    live: d.show === true && n > 0,
    eyebrow: String(d.eyebrow || '').trim() || BOOK_DEFAULTS.eyebrow,
    titleHtml: bookTitleHtml(title),
    titleText: plainTitle(title),
    description: String(d.description || '').trim() || BOOK_DEFAULTS.description,
    pages,
    chapters,
    pdf,
    textUrl: typeof d.textUrl === 'string' && (test || /^\/files\/books\//.test(d.textUrl)) ? d.textUrl : null,
    insetPage: inset,
    version: String(d.version || ''),
  };
}
