/**
 * The flip book with no screen: which pages make each spread, how big the
 * book draws in a space, where a turning page folds, and the page picture
 * addresses. ./flipbook.js draws it; tests/book.test.mjs checks it.
 *
 * Units are CSS pixels. A sheet's own coordinates put the spine at x = 0 and
 * the page's top at y = 0, so a right-hand page covers [0, W] × [0, H] and
 * the page opposite it [-W, 0] × [0, H].
 */

// Cloudflare Images on the site's own address, like src/utils/cf-image.ts CF_BASE:
// same-origin on the site, and sent with CORS everywhere else (WebGL needs that)
const CF_BASE = 'https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ';

// ─── Spreads ───────────────────────────────────────────────────────

/**
 * The spreads of an n-page book. Two-up: the cover alone on the right, then
 * pairs, and the back cover alone on the left when the count is even (a real
 * book's last page faces nothing). One-up: every page alone, on the right.
 */
export function spreadsOf(n, twoUp) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (!twoUp) return Array.from({ length: count }, (_, i) => ({ left: null, right: i }));
  if (!count) return [];
  const out = [{ left: null, right: 0 }];
  for (let i = 1; i < count; i += 2) out.push({ left: i, right: i + 1 < count ? i + 1 : null });
  return out;
}

/** The spread a page (0-based) sits in */
export function spreadOfPage(page, twoUp, n) {
  const i = Math.min(Math.max(0, Math.floor(Number(page) || 0)), Math.max(0, n - 1));
  return twoUp ? (i === 0 ? 0 : Math.floor((i + 1) / 2)) : i;
}

/** The pages a spread shows, in reading order */
export const pagesOf = (spread) => (spread ? [spread.left, spread.right].filter((p) => p != null) : []);

/** "Pages 4–5 of 96", "Page 1 of 96": 1-based, for people */
export function pageLabel(spread, n) {
  const ps = pagesOf(spread).map((p) => p + 1);
  if (!ps.length) return '';
  return ps.length > 1 ? `Pages ${ps[0]}–${ps[1]} of ${n}` : `Page ${ps[0]} of ${n}`;
}

/**
 * What turns between two spreads: one sheet, whatever the distance. Forward,
 * the right-hand page lifts and turns over to the left: its front is
 * `from`'s right page, its back `to`'s left, `to`'s right page is uncovered
 * under it, and `from`'s left page lies beside it. Back, two up, the
 * left-hand page lifts the same way mirrored (mirror: the sheet's own
 * coordinates run right to left), so its corner curls like the right's.
 * One up there's no facing page: back is the forward turn of the earlier
 * page played in reverse, and the sheet's back is paper with the front's
 * ink showing through.
 */
export function sheetFor(spreads, from, to, twoUp) {
  const fwd = to > from;
  const a = spreads[from];
  const b = spreads[to];
  if (!a || !b || from === to) return null;
  if (!twoUp) {
    const [lo, hi] = fwd ? [a, b] : [b, a];
    return { forward: fwd, mirror: false, front: lo.right, back: null, under: hi.right, beside: null };
  }
  if (fwd) return { forward: true, mirror: false, front: a.right, back: b.left, under: b.right, beside: a.left };
  return { forward: false, mirror: true, front: a.left, back: b.right, under: b.left, beside: a.right };
}

// ─── Fitting the book into a space ─────────────────────────────────

/**
 * Two pages side by side, or one at a time: a spread when it keeps the
 * pages at least ~62% of the size they'd be alone and there's room for it.
 */
export function chooseTwoUp(spaceW, spaceH, aspect) {
  if (!(spaceW > 0 && spaceH > 0 && aspect > 0) || spaceW < 600) return false;
  const one = Math.min(spaceW / aspect, spaceH);
  const two = Math.min(spaceW / (2 * aspect), spaceH);
  return two >= one * 0.62;
}

/**
 * The page size and where the spine goes in a space, whole pixels so the
 * pictures land on the pixel grid. offset: how far the spine sits from the
 * middle (the cover, alone, is centred, so the spine is half a page left).
 */
export function fitBook({ spaceW, spaceH, aspect, twoUp, padX = 0, padY = 0 }) {
  const w = Math.max(0, spaceW - 2 * padX);
  const h = Math.max(0, spaceH - 2 * padY);
  const across = twoUp ? 2 : 1;
  let H = Math.min(h, w / (across * aspect));
  let W = H * aspect;
  W = Math.max(1, Math.floor(W));
  H = Math.max(1, Math.floor(W / aspect));
  const spineX = Math.round(twoUp ? spaceW / 2 : (spaceW - W) / 2);
  const top = Math.round((spaceH - H) / 2);
  return { W, H, spineX, top };
}

/** How far the spine moves so what's showing is centred: a lone cover, a lone back cover, or neither */
export function spreadOffset(spread, W, twoUp) {
  if (!twoUp || !spread) return 0;
  if (spread.left == null && spread.right != null) return -W / 2;
  if (spread.right == null && spread.left != null) return W / 2;
  return 0;
}

// ─── The fold ──────────────────────────────────────────────────────

/** A sheet's corner can't leave the page's reach: it stays within W of the spine end beside it, and the diagonal of the far one */
export function clampCorner({ W, H, from, at }) {
  const near = { x: 0, y: from.y };
  const far = { x: 0, y: from.y < H / 2 ? H : 0 };
  let p = { x: at.x, y: at.y };
  for (let i = 0; i < 3; i++) {
    p = within(p, near, W);
    p = within(p, far, Math.hypot(W, H));
  }
  return p;
}
function within(p, c, r) {
  const dx = p.x - c.x, dy = p.y - c.y, d = Math.hypot(dx, dy);
  return d <= r ? p : { x: c.x + (dx * r) / d, y: c.y + (dy * r) / d };
}

/**
 * How far round the paper the corner is from the fold, when it shows at a
 * distance D from where it started: on the curl, e − R·sin(e/R) = D; past
 * it, lying back on top, 2e − πR = D. Flat paper (R = 0) folds at D/2.
 */
export function cornerArc(D, R) {
  if (!(D > 0)) return 0;
  if (!(R > 1e-6)) return D / 2;
  if (D >= Math.PI * R) return (D + Math.PI * R) / 2;
  // Newton's method from the small-angle answer, e³/6R² = D
  let e = Math.min(Math.PI * R, Math.cbrt(6 * D * R * R));
  for (let i = 0; i < 16; i++) {
    const f = e - R * Math.sin(e / R) - D;
    const slope = 1 - Math.cos(e / R);
    if (slope < 1e-12) break;
    const next = Math.min(Math.PI * R, Math.max(1e-9, e - f / slope));
    if (Math.abs(next - e) < 1e-7) { e = next; break; }
    e = next;
  }
  return e;
}

/** How far a sheet has turned, 0 (flat on the right) to 1 (flat on the left), from its corner */
export const turnProgress = (W, at) => Math.min(1, Math.max(0, (W - at.x) / (2 * W)));

/**
 * The fold for a sheet whose corner `from` (on the page's outer edge, x = W)
 * now shows at `at`: a point on the fold line (ax, ay), the unit normal
 * toward the free edge (nx, ny), and the radius the paper bends round. The
 * corner lands exactly under `at`. Paper can't fold across the spine, so a
 * curl that would is pulled tighter until it doesn't.
 */
export function foldOf({ W, H, from, at, R }) {
  const dx = from.x - at.x, dy = from.y - at.y;
  const D = Math.hypot(dx, dy);
  if (D < 1e-3) return { ax: from.x + 1, ay: from.y, nx: 1, ny: 0, R: 0, still: true };
  const nx = dx / D, ny = dy / D;
  let r = Math.max(0, R || 0);
  for (let k = 0; ; k++) {
    const e = cornerArc(D, r);
    const ax = from.x - e * nx, ay = from.y - e * ny;
    // Both spine ends stay on the flat side
    const past = Math.max(-ax * nx - ay * ny, -ax * nx + (H - ay) * ny);
    if (past <= 0.5 || r === 0) return { ax, ay, nx, ny, R: r, still: false };
    r = k >= 6 ? 0 : r * 0.6;
  }
}

/** The radius the paper bends round at a point in the turn: none when it lies flat, most mid-turn */
export function curlRadius(W, progress, stiff = false) {
  const max = W * (stiff ? 0.32 : 0.14);
  return max * Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, progress)))), 0.7);
}

/** The corner's path in a turn played for you (a click, a key): across and up a little, then down */
export function turnPath(W, H, t, cornerY, lift = 0.16) {
  const up = cornerY > H / 2 ? -1 : 1;
  return { x: W - 2 * W * t, y: cornerY + up * lift * H * Math.sin(Math.PI * t) };
}

// ─── Easing ────────────────────────────────────────────────────────

/** A CSS cubic-bezier as a function of time 0..1 */
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dsx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-6) break;
      const d = dsx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-4) {
      let lo = 0, hi = 1;
      t = x;
      for (let i = 0; i < 30; i++) { if (sx(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    }
    return sy(t);
  };
}

// ─── Page pictures ─────────────────────────────────────────────────

/** Widths the pictures are asked for in, so the CDN caches a few sizes instead of every one */
export const PAGE_WIDTHS = [240, 360, 480, 640, 800, 1000, 1200, 1400, 1600, 2000, 2400, 3000, 3600];
export const widthFor = (px) => PAGE_WIDTHS.find((w) => w >= px) || PAGE_WIDTHS[PAGE_WIDTHS.length - 1];

/** A page's picture at least `px` wide (Cloudflare Images picks AVIF or WebP itself) */
export function pageSrc(page, px) {
  if (!page) return '';
  const w = Math.min(widthFor(Math.ceil(px)), page.w || Infinity);
  const ask = page.w && w >= page.w ? page.w : w;
  if (page.src) return page.src.replace('{w}', String(ask));
  return `${CF_BASE}/${String(page.id).split('/').map(encodeURIComponent).join('/')}/w=${ask},q=85`;
}

// ─── Search ────────────────────────────────────────────────────────

/** Lower case, accents off: "Café" finds "cafe" */
export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Where `word` starts a word in `low` (folded text), from `from`; -1 when it doesn't */
export function wordAt(low, word, from = 0) {
  for (let i = low.indexOf(word, from); i >= 0; i = low.indexOf(word, i + 1)) {
    if (i === 0 || !/[\p{L}\p{N}]/u.test(low[i - 1])) return i;
  }
  return -1;
}

/**
 * Pages whose text has every word of the query at the start of a word
 * ("anders" finds Anderson; "the" doesn't find Mathew), best first: the
 * whole phrase beats scattered words, more hits beat fewer, earlier pages
 * break ties. Each result has a snippet around its first hit.
 */
export function searchPages(texts, query, { limit = 60, around = 60 } = {}) {
  const q = fold(query).replace(/\s+/g, ' ').trim();
  if (q.length < 2) return [];
  const words = q.split(' ').filter(Boolean);
  const out = [];
  texts.forEach((raw, page) => {
    const text = String(raw || '').replace(/\s+/g, ' ');
    const low = fold(text);
    if (!words.every((w) => wordAt(low, w) >= 0)) return;
    const phraseAt = wordAt(low, q);
    const at = phraseAt >= 0 ? phraseAt : wordAt(low, words[0]);
    const len = phraseAt >= 0 ? q.length : words[0].length;
    let hits = 0;
    for (const w of words) for (let i = wordAt(low, w); i >= 0; i = wordAt(low, w, i + w.length)) hits++;
    const start = Math.max(0, at - around);
    const end = Math.min(text.length, at + len + around);
    out.push({
      page,
      score: (phraseAt >= 0 ? 1000 : 0) + hits,
      before: (start > 0 ? '…' : '') + text.slice(start, at).trimStart(),
      match: text.slice(at, at + len),
      after: text.slice(at + len, end).trimEnd() + (end < text.length ? '…' : ''),
    });
  });
  return out.sort((a, b) => b.score - a.score || a.page - b.page).slice(0, limit);
}

/**
 * Where the query sits on a page, from its words and their places ([word,
 * x, y, w, h], fractions of the page; the admin measures each word): a box
 * for each word that starts with a word of the query, as wide as the part
 * that matched. Older files with whole runs of text work the same way,
 * each hit placed by its share of the run's letters.
 */
export function hitBoxes(items, query) {
  const words = fold(query).split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length || !Array.isArray(items)) return [];
  const boxes = [];
  for (const it of items) {
    if (!Array.isArray(it) || it.length < 5) continue;
    const [str, x, y, w, h] = it;
    const low = fold(str);
    if (!low.length) continue;
    for (const word of words) {
      for (let i = wordAt(low, word); i >= 0; i = wordAt(low, word, i + word.length)) {
        boxes.push({ x: x + (w * i) / low.length, y, w: (w * Math.min(word.length, low.length - i)) / low.length, h });
      }
    }
  }
  return boxes;
}

// ─── Addresses ─────────────────────────────────────────────────────

/** ?page=12 (1-based) → a 0-based page, or null */
export function pageFromSearch(search, n) {
  const m = /[?&]page=(\d{1,4})\b/.exec(String(search || ''));
  if (!m) return null;
  const p = Number(m[1]) - 1;
  return p >= 0 && p < n ? p : null;
}
