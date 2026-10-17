/**
 * page-preview.js — shared parts of the admin's page Previews.
 *
 * Each page type has its own module (kid-preview.js, event-preview.js,
 * community-preview.js, article-preview.js) that rebuilds that page from
 * unsaved edits. The admin frames the real public page with
 * ?admin-preview=<id>; BaseLayout calls parent.__soardPreview(document,
 * window) right after <main> is parsed, before any page script runs, and the
 * type's patch replaces the page's sections with ones cloned from its
 * template pages (/admin/<type>-template/<variant>/: the real template
 * rendered with every optional part on) and filled from the draft.
 *
 * Image URLs mirror src/utils/cf-image.ts. scripts/test-page-preview.mjs
 * rebuilds every item inside another item's page and checks the result
 * against the real page.
 */

// ── Cloudflare Images (mirrors src/utils/cf-image.ts) ─────────────────
const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
export const CF_ORIGIN = `https://imagedelivery.net/${CF_HASH}`;
export const CF_BASE = `https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/${CF_HASH}`;
const NAMED_VARIANTS = new Set(['public', 'nav', 'footer', 'og']);
const CF_PROXY_RE = /^https?:\/\/[^/]+\/cdn-cgi\/imagedelivery\/[^/]+\//;
const ID_ALIASES = {
  'partners/bin-there-dump-that-atlanta/1774627292526': 'partners/bin-there-dump-that',
};

// Photos still uploading are blob: URLs in this tab; show them as-is.
// A blob: URL saved by mistake is dead everywhere, so it's built into a
// Cloudflare URL like the site does and shows broken like the site.
let liveBlobs = new Set();
export const setLiveBlobs = (set) => { liveBlobs = set || new Set(); };
export const isBlob = (src) => /^blob:/.test(src || '');
export const isLocal = (src) => /^data:/.test(src || '') || liveBlobs.has(src);

export function cfId(src) {
  if (!src) return '';
  if (!src.includes('imagedelivery.net') && !CF_PROXY_RE.test(src)) return ID_ALIASES[src] || src;
  let id = src.replace(`${CF_ORIGIN}/`, '').replace(CF_PROXY_RE, '');
  const lastSlash = id.lastIndexOf('/');
  if (lastSlash > 0) {
    const suffix = id.slice(lastSlash + 1);
    if (NAMED_VARIANTS.has(suffix) || suffix.includes('=')) id = id.slice(0, lastSlash);
  }
  return ID_ALIASES[id] || id;
}

export function isCF(src) {
  if (!src) return false;
  if (src.includes('imagedelivery.net') || CF_PROXY_RE.test(src)) return true;
  return !src.startsWith('http') && !src.startsWith('/') && !src.startsWith('data:');
}

function buildTransform(o) {
  const parts = [];
  if (o.w) parts.push(`w=${o.w}`);
  if (o.h) parts.push(`h=${o.h}`);
  if (o.fit) parts.push(`fit=${o.fit}`);
  if (o.gravity) parts.push(`gravity=${o.gravity}`);
  parts.push(`q=${o.q ?? 85}`);
  if (o.sharpen) parts.push(`sharpen=${o.sharpen}`);
  parts.push('metadata=none');
  return parts.join(',');
}

export function cfUrl(src, opts) {
  if (isLocal(src)) return src;
  const id = cfId(src);
  return id ? `${CF_BASE}/${id}/${buildTransform(opts)}` : src;
}

export function cfRaw(src, transforms) {
  if (isLocal(src)) return src;
  const id = cfId(src);
  return id ? `${CF_BASE}/${id}/${transforms}` : src;
}

export function cfSrcset(src, widths, opts) {
  if (isLocal(src)) return '';
  const id = cfId(src);
  if (!id) return '';
  const q = opts?.quality ?? 85;
  return widths.map((w) => {
    const o = { w, q };
    if (opts?.height) o.h = opts.height;
    else if (opts?.aspectRatio) o.h = Math.round(w * opts.aspectRatio);
    if (opts?.fit) o.fit = opts.fit;
    if (opts?.gravity) o.gravity = opts.gravity;
    if (opts?.sharpen) o.sharpen = opts.sharpen;
    return `${CF_BASE}/${id}/${buildTransform(o)} ${w}w`;
  }).join(', ');
}

/** 1x/2x srcset for fixed-size images (cfDensitySrcset in cf-image.ts) */
export function cfDensitySrcset(src, w, h, opts = {}) {
  if (isLocal(src)) return '';
  const id = cfId(src);
  if (!id) return '';
  const q = opts.quality ?? 80;
  const fit = opts.fit ?? 'cover';
  return [1, 2].map((dpr) => {
    const o = { w: w * dpr, h: h * dpr, fit, q };
    if (opts.gravity) o.gravity = opts.gravity;
    return `${CF_BASE}/${id}/${buildTransform(o)} ${dpr}x`;
  }).join(', ');
}

export function cfLqip(src) {
  if (isLocal(src)) return src;
  const id = cfId(src);
  return id ? `${CF_BASE}/${id}/w=30,q=30,blur=20` : '';
}

/** <CFImage>'s src and srcset (src/components/ui/CFImage.astro) */
export function cfImage(src, { widths = [400, 640, 800, 1024, 1600], quality = 85, fit, gravity, aspectRatio } = {}) {
  if (!isCF(src) || isLocal(src)) return { src, srcset: null };
  const so = { quality };
  if (fit) so.fit = fit;
  if (gravity) so.gravity = gravity;
  if (aspectRatio) so.aspectRatio = aspectRatio;
  const fw = widths[widths.length - 2] || widths[widths.length - 1];
  const fo = { w: fw, q: quality };
  if (fit) fo.fit = fit;
  if (gravity) fo.gravity = gravity;
  if (aspectRatio) fo.h = Math.round(fw * aspectRatio);
  return { src: cfUrl(src, fo), srcset: cfSrcset(src, widths, so) };
}

// ── Draft checks the build would make ─────────────────────────────────
// New photos aren't in the build's size manifest yet. Measure them the way
// scripts/generate-dimensions.js will: a 128px copy, ratio reduced by GCD.
const measured = new Map();
export function measure(id) {
  if (!measured.has(id)) {
    measured.set(id, new Promise((resolve) => {
      const img = new Image();
      const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight, d = gcd(w, h);
        resolve(w && h ? [w / d, h / d] : null);
      };
      img.onerror = () => resolve(null);
      img.src = `${CF_ORIGIN}/${id}/w=128,q=1`;
    }));
  }
  return measured.get(id);
}

/** Which blob: URLs are uploads still running in this tab, and how many are dead */
export async function checkBlobs(urls) {
  const blobs = urls.filter(isBlob);
  const alive = new Set();
  await Promise.all([...new Set(blobs)].map((u) => fetch(u).then((r) => { if (r.ok) alive.add(u); }).catch(() => {})));
  const dead = blobs.filter((u) => !alive.has(u)).length;
  return {
    alive,
    notes: [
      alive.size && 'Photos still uploading are shown from this computer.',
      dead && `${dead} ${dead === 1 ? 'photo was' : 'photos were'} saved before ${dead === 1 ? 'its' : 'their'} upload finished, so ${dead === 1 ? 'it shows' : 'they show'} as a broken image on the site. Remove ${dead === 1 ? 'it' : 'them'} and upload again.`,
    ].filter(Boolean),
  };
}

// ── Template pages (fetched once per session) ─────────────────────────
const pages = new Map();
export function loadTemplates(type, variants) {
  const key = `${type}:${variants.join(',')}`;
  if (!pages.has(key)) {
    const parser = new DOMParser();
    const p = Promise.all(variants.map(async (v) => {
      const res = await fetch(`/admin/${type}-template/${v}/`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`The ${type} template page (${v}) returned ${res.status}`);
      return [v, parser.parseFromString(await res.text(), 'text/html')];
    })).then(Object.fromEntries);
    p.catch(() => pages.delete(key));
    pages.set(key, p);
  }
  return pages.get(key);
}

// ── Patch helpers ─────────────────────────────────────────────────────
/** DOM tools bound to the framed document and the type's template pages */
export function tools(doc, templates) {
  return {
    // Template parts arrive without image sources (patches set every one),
    // so the page never requests the template's placeholder images
    take(variant, sel) {
      const el = templates[variant].querySelector(sel)?.cloneNode(true);
      if (!el) return null;
      el.querySelectorAll('img, source').forEach((n) => { n.removeAttribute('src'); n.removeAttribute('srcset'); });
      if (el.matches('img, source')) { el.removeAttribute('src'); el.removeAttribute('srcset'); }
      return doc.importNode(el, true);
    },
    textSwap(el, from, to) {
      if (!el) return;
      const walker = doc.createTreeWalker(el, 4);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.nodeValue.includes(from)) n.nodeValue = n.nodeValue.split(from).join(to);
      }
    },
    // set:html content goes through the parser in the element's parent, like
    // the page: a <div> inside a <p> closes the <p>, as it does live
    setParsedHtml(el, inner) {
      const outer = el.outerHTML;
      el.insertAdjacentHTML('beforebegin', `${outer.slice(0, outer.indexOf('>') + 1)}${inner}</${el.tagName.toLowerCase()}>`);
      el.remove();
    },
    drop(el) { el?.remove(); },
    // Set an attribute, or remove it when the page wouldn't render one
    attr(el, name, value) {
      if (value === null || value === undefined || value === false) el.removeAttribute(name);
      else el.setAttribute(name, value === true ? '' : String(value));
    },
  };
}

/**
 * Keep the preview a preview: links open in a new tab instead of taking
 * the frame somewhere else, and views aren't counted in site analytics.
 */
export function guardFrame(doc, win) {
  doc.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || e.defaultPrevented) return;
    if ((a.getAttribute('href') || '').startsWith('#')) return;
    e.preventDefault();
    win.open(a.href, '_blank', 'noopener');
  });
  doc.addEventListener('submit', (e) => e.preventDefault());
  const analytics = /cloudflareinsights\.com/;
  const nav = win.navigator;
  if (nav.sendBeacon) {
    const send = nav.sendBeacon.bind(nav);
    nav.sendBeacon = (url, data) => (analytics.test(String(url)) ? true : send(url, data));
  }
  const fetchFn = win.fetch.bind(win);
  win.fetch = (input, init) => (analytics.test(String(input?.url || input))
    ? Promise.resolve(new win.Response(null, { status: 204 }))
    : fetchFn(input, init));
  const open = win.XMLHttpRequest.prototype.open;
  win.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return open.call(this, method, analytics.test(String(url)) ? 'data:,' : url, ...rest);
  };
}
