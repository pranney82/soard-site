/**
 * kid-guess.js — whose photos are these?
 * ======================================
 * Admin → Kids → Upload photos and videos guesses the kid for each file it's
 * given, and the person checks the guess before anything uploads. Two signs,
 * strongest first:
 *   1. Where it was taken. A phone writes the spot into each photo (EXIF GPS,
 *      JPEG and HEIC) and video (QuickTime ISO 6709). One taken within
 *      HOME_METERS of a family's home (their JobTread job's location, from
 *      /api/kid-homes) is that kid's.
 *   2. Its name. A photographer's folder ("Summer Reveal/…") or a file name
 *      ("summer-01.jpg") with a kid's name in it. The folder nearest the file
 *      counts first. When a name fits more than one page (Ellie 2022 and 2023,
 *      "Hannah" and "Hannah & Austin"), the kid already chosen wins if it's one
 *      of them; otherwise initials ("Christian V"), a year in the path or the
 *      year it was taken, then which is in build now, and the guess says that
 *      other pages match. A name that's an everyday word too ("Summer 2026
 *      events", "Mason jars") only counts when the rest of that name is filler
 *      ("Summer Reveal", "mason-03").
 * Nothing here leaves the browser: files are read where they are, and the
 * homes are map points only. Pure functions (plus readFacts, which takes a
 * File or Blob), shared with tests/kid-guess.test.mjs.
 */

export const HOME_METERS = 300;
const MAX_HEAD = 256 * 1024;

// ── Names ───────────────────────────────────────────────────────────
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const wordsOf = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
// "Anthony Jr. & Lyric" → anthony, lyric; "Damon (DJ)" → damon, dj; "Glass Family" → glass; "Christian B" → christian (+ initial b)
const NOT_NAMES = new Set(['and', 'jr', 'sr', 'ii', 'iii', 'iv', 'the', 'family', 'kids', 'children', 'siblings', 'twins', 'brothers', 'sisters']);
export const nameWords = (name) => wordsOf(name).filter((w) => w.length >= 2 && !NOT_NAMES.has(w) && !/^\d+$/.test(w));
const initialsOf = (name) => wordsOf(name).filter((w) => w.length === 1 && /[a-z]/.test(w));
// Names that are everyday words too, or places nearby (and SOARD's founder): only trusted when the
// rest of that folder or file name is filler
export const WEAK_NAMES = new Set(['summer', 'max', 'angel', 'mason', 'grace', 'hope', 'faith', 'hunter', 'will', 'rose', 'joy', 'sky', 'river',
  'autumn', 'june', 'may', 'april', 'august', 'dawn', 'ivy', 'lily', 'daisy', 'ruby', 'pearl', 'amber', 'jade', 'star', 'king', 'prince', 'chase',
  'cash', 'mark', 'holly', 'sunny', 'glass', 'peter', 'dj', 'aj', 'love', 'harmony', 'melody', 'destiny', 'trinity', 'journey', 'legend', 'nova',
  'sage', 'true', 'royal', 'major', 'ace', 'blue', 'gray', 'grey', 'brooklyn', 'paris', 'london', 'dallas', 'austin', 'jordan', 'madison',
  'savannah', 'georgia', 'carolina', 'dakota', 'phoenix', 'aspen', 'augusta', 'houston', 'cleveland', 'lincoln', 'kennedy', 'miracle', 'bliss',
  'heaven', 'angelina', 'christian', 'noel', 'carol', 'eve', 'miles', 'reed', 'wade', 'drew', 'gage', 'bishop', 'judge', 'page', 'price', 'bell', 'shepherd']);
// Words a folder or file name has around a kid's name without meaning anyone else
const FILLER = new Set(['reveal', 'reveals', 'room', 'rooms', 'bedroom', 'bathroom', 'makeover', 'makeovers', 'dream', 'accessible', 'therapy',
  'sensory', 'photo', 'photos', 'pics', 'pic', 'pictures', 'picture', 'images', 'image', 'img', 'dsc', 'dscf', 'final', 'finals', 'edit', 'edits',
  'edited', 'web', 'full', 'res', 'high', 'low', 'hi', 'lo', 'print', 'raw', 'jpeg', 'jpg', 'heic', 'png', 'mov', 'mp4', 'day', 'build', 'before',
  'after', 'progress', 'copy', 'export', 'exports', 'soard', 'sunshine', 'ranney', 'selects', 'select', 'favorites', 'favs', 'gallery', 'video',
  'videos', 'clip', 'clips', 'set', 'part', 'of', 'the', 'and', 'by', 'new', 'original', 'originals', 'small', 'large', 'family', 's',
  'resolution', 'size', 'sized', 'proof', 'proofs', 'session', 'sessions', 'shoot', 'shots', 'retouched', 'color', 'bw', 'portraits', 'candids',
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept',
  'september', 'oct', 'october', 'nov', 'november', 'dec', 'december', 'with', 'at', 'in', 'on', 'her', 'his', 'their']);
const ACTIVE = new Set(['in-progress', 'needs-funding']);
// Words around a name that say it isn't a kid's:
//   a credit, and everything after it: "Kyle Thomas Photography - Web", "Axel Reveal - Smith Photography",
//     "Second shooter - Logan", "Photos by Grace Lee"
//   a business or place, with the two words before it: "Ben Franklin Plumbing", "Hartsfield Jackson Airport"
//   a relative or helper, with the word after it: "Brother Jack", "Teacher Ms Grace"
//   and a few phrases: "Jack and Jill Bathroom", "Max Resolution"
const CREDIT = /\b(photography|photographers?|studios?|llc|inc|media|films|productions|creative|imagery|shooter|videography|videographer)\b/i;
const BEFORE = /^(plumbing|electric|electrical|hvac|roofing|construction|contractors?|flooring|painting|cabinets?|company|airport|hospital|church|school|academy|depot|store|stadium|park|mall|restaurant|hotel|university|college|bank)$/i;
const AFTER = /^(brother|sister|mom|dad|mother|father|grandma|grandpa|grandmother|grandfather|aunt|uncle|cousin|friend|teacher|nurse|doctor|dr|mr|mrs|ms|miss|coach|pastor)$/i;
export function nameText(part) {
  const segs = String(part || '')
    .replace(/\bjack\s*(and|&|n)\s*jill\b/gi, ' ')
    .replace(/\bmax(imum)?[\s_-]*(res|resolution|quality|size)\b/gi, ' ')
    .split(/\s+[-–—|]\s+|[()]/);
  const cut = segs.findIndex((seg) => CREDIT.test(seg));
  return (cut < 0 ? segs : segs.slice(0, cut)).map((seg) => {
    const words = seg.split(/\b(?:by|courtesy|credit)\b/i)[0].split(/[\s_]+/);
    const drop = new Set();
    words.forEach((w, i) => {
      const t = w.replace(/[^a-z]/gi, '');
      if (BEFORE.test(t)) [i, i - 1, i - 2].forEach((j) => drop.add(j));
      if (AFTER.test(t)) [i, i + 1].forEach((j) => drop.add(j));
    });
    return words.filter((_, i) => !drop.has(i)).join(' ');
  }).join(' ');
}

// The kids one folder (or file) name names, best first by how fully: [{ k, matched, word, initials, share }]
function namesIn(part, where, kids) {
  const text = nameText(part);
  const list = wordsOf(text);
  const words = new Set(list);
  // "Summer and Axel" names two kids; "Axel Reveal Summer 2026" is Axel's, in the summer
  const joined = /(^|[^a-z0-9])(and|&|\+)([^a-z0-9]|$)/i.test(text);
  const hits = kids.map((k) => {
    // The address counts too ("Junailiz" lives at /kids/junializ/)
    const all = [...new Set([...nameWords(k.name), ...nameWords(String(k.slug || '').replace(/-/g, ' '))])];
    // Two-letter names (AJ, DJ) only from a folder: in a file name they're too often something else
    const names = all.filter((w) => w.length >= 3 || where === 'folder');
    const matched = names.filter((w) => words.has(w));
    if (!matched.length) return null;
    const initials = initialsOf(k.name).filter((w) => words.has(w)).length;
    // An everyday word ("Summer 2026 events", "Angel Tree") counts only with nothing else around it
    const own = new Set([...all, ...initialsOf(k.name)]);
    const plain = !matched.every((w) => WEAK_NAMES.has(w)) || !list.some((w) => !own.has(w) && !FILLER.has(w) && !/^\d+[a-z]{0,2}$/.test(w));
    return { k, matched, word: matched[0], initials, plain, share: Math.min(1, matched.length / Math.max(1, nameWords(k.name).length || 1)) };
  }).filter(Boolean);
  // A part with two names means the kid whose own name has both ("Amanda Caleb Isaac" is the
  // three of them, not Caleb); naming two different kids ("Summer and Axel") can't say which.
  // An everyday word only counts as a second name when it's joined on ("and", "&")
  const counted = hits.filter((h) => h.plain || joined);
  const named = new Set(counted.flatMap((h) => h.matched));
  return (named.size > 1 ? counted.filter((h) => h.matched.length === named.size) : counted).filter((h) => h.plain);
}
const weakOnly = (h) => h.matched.every((w) => WEAK_NAMES.has(w));

/**
 * The kid a path names: { slug, word, where: 'folder' | 'file', part, others, outer, outerPart } or null.
 *   path    "/Summer Reveal 2026/IMG_1.jpg" (a folder drop) or just "summer-01.jpg"
 *   taken   when it was taken (a Date), to tell kids with the same name apart
 *   prefer  the kid already chosen: named anywhere in the path ("Colin Reveal/Bedroom"), as well as
 *           anyone else is in that folder, it's theirs (unless an initial or a year there says otherwise)
 * Otherwise the folder nearest the file is read first, then the ones above it, then the file's own
 * name. others: how many more pages that name fits; outer: a kid a folder further out names instead.
 */
export function guessFromName(path, kids, taken = null, prefer = '') {
  const parts = String(path || '').split('/').filter(Boolean);
  if (!parts.length) return null;
  const file = parts.pop().replace(/\.[^.]+$/, '');
  const order = [...parts.reverse().map((p) => ({ part: p, where: 'folder' })), { part: file, where: 'file' }];
  const pathYears = new Set(wordsOf(path).filter((w) => /^20\d\d$/.test(w)).map(Number));
  const years = new Set(pathYears);
  if (taken instanceof Date && !Number.isNaN(taken.getTime())) years.add(taken.getFullYear());
  const yearOk = (h) => years.has(Number(h.k.year));
  const scans = order.map((o) => ({ ...o, pool: namesIn(o.part, o.where, kids) }));
  if (prefer) {
    for (const { part, where, pool } of scans) {
      if (!pool.length) continue;
      const topInitials = Math.max(...pool.map((h) => h.initials));
      const yearSays = (h) => !pathYears.size || pathYears.has(Number(h.k.year)) || !pool.some((o) => pathYears.has(Number(o.k.year)));
      const hit = pool.find((h) => h.k.slug === prefer && h.initials === topInitials && yearSays(h));
      if (hit) return { slug: prefer, word: hit.word, where, part, others: 0, outer: '', outerPart: '' };
    }
  }
  // A kid's own makeover folder further out ("Leland Reveal/Ben Smith", "Lizzie Reveal/Elizabeth",
  // "Jackson Reveal/Jack's Room") is whose they are: the folders inside it are its people and rooms
  const MAKEOVER = /\b(reveal|reveals|makeover|makeovers|room|bedroom|bathroom|build)\b/i;
  for (let i = scans.length - 1; i >= 0; i--) {
    const { part, where, pool } = scans[i];
    if (where !== 'folder' || !pool.length || !MAKEOVER.test(nameText(part))) continue;
    const strong = pool.filter((h) => !weakOnly(h));
    if (!strong.length || !scans.slice(0, i).some((sc) => sc.pool.some((h) => !strong.some((x) => x.k === h.k)))) continue;
    const best = strong.sort((a, b) => (b.share - a.share) || (b.initials - a.initials) || ((yearOk(b) ? 1 : 0) - (yearOk(a) ? 1 : 0))
      || ((ACTIVE.has(b.k.status) ? 1 : 0) - (ACTIVE.has(a.k.status) ? 1 : 0)) || ((Number(b.k.year) || 0) - (Number(a.k.year) || 0)))[0];
    const others = strong.filter((h) => h !== best && h.matched.includes(best.word) && h.initials === best.initials && !(yearOk(best) && !yearOk(h))).length;
    const inner = scans.slice(0, i).map((sc) => ({ sc, h: sc.pool.find((h) => !weakOnly(h) && h.k !== best.k) })).find((x) => x.h);
    return { slug: best.k.slug, word: best.word, where, part, others, outer: '', outerPart: '', inner: inner?.h.k.slug || '', innerPart: inner?.sc.part || '' };
  }
  // A folder whose only name is an everyday word ("Grace session") counts if nothing further out names a kid
  let fallback = null;
  for (let i = 0; i < scans.length; i++) {
    const { part, where, pool } = scans[i];
    if (!pool.length) continue;
    const best = pool.sort((a, b) => (b.share - a.share) || (b.initials - a.initials)
      || ((yearOk(b) ? 1 : 0) - (yearOk(a) ? 1 : 0))
      || ((ACTIVE.has(b.k.status) ? 1 : 0) - (ACTIVE.has(a.k.status) ? 1 : 0))
      || ((Number(b.k.year) || 0) - (Number(a.k.year) || 0)))[0];
    // Other pages the same name fits, that nothing here (an initial, the year) ruled out: the guess says so
    const others = pool.filter((h) => h !== best && h.matched.includes(best.word) && h.initials === best.initials && !(yearOk(best) && !yearOk(h))).length;
    // A folder further out naming someone else ("Lizzie Reveal/Kyle Thomas"): the guess says so too
    const out = scans.slice(i + 1).map((sc) => ({ sc, h: sc.pool.find((h) => !weakOnly(h) && h.k.slug !== best.k.slug) })).find((x) => x.h);
    const guess = { slug: best.k.slug, word: best.word, where, part, others, outer: out?.h.k.slug || '', outerPart: out?.sc.part || '' };
    if (weakOnly(best)) { fallback ||= guess; continue; }
    return guess;
  }
  return fallback;
}

// ── Homes ───────────────────────────────────────────────────────────
/** Meters between two map points (haversine) */
export function meters(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** The homes a spot is at, within HOME_METERS, nearest first: [{ slug, m }] */
export function homesAt(spot, homes, max = HOME_METERS) {
  if (!spot || typeof spot.lat !== 'number' || typeof spot.lng !== 'number') return [];
  return (homes || []).map((h) => ({ slug: h.slug, m: meters(spot, h) })).filter((h) => h.m <= max).sort((a, b) => a.m - b.m);
}
/** The home a spot is at: { slug, m } within HOME_METERS (the nearest, if two are), or null */
export const homeAt = (spot, homes, max = HOME_METERS) => homesAt(spot, homes, max)[0] || null;
// Two jobs this close are one house (a family back for a second room): the spot can't say which page
const SAME_HOUSE = 75;

/**
 * The guess for one file: { slug, by: 'home' | 'folder' | 'file', word?, part?, others? } or null.
 * Taken at a home wins: it's where the photo was, not what someone typed. prefer: the kid
 * already chosen, which a name that fits several pages goes to.
 */
export function guessKid({ path = '', facts = null } = {}, kids = [], homes = [], prefer = '') {
  const known = new Set(kids.map((k) => k.slug));
  const near = homesAt(facts, homes).filter((h) => known.has(h.slug));
  if (near.length) {
    const house = near.filter((h) => h.m - near[0].m <= SAME_HOUSE);
    // One house, two pages (Lyric, and Anthony Jr. & Lyric): the kid chosen if it's one; else the name, else the nearest
    const pick = house.find((h) => h.slug === prefer)
      || (house.length > 1 && house.find((h) => h.slug === guessFromName(path, kids.filter((k) => house.some((x) => x.slug === k.slug)), facts?.taken || null)?.slug))
      || house[0];
    return { slug: pick.slug, by: 'home', others: pick.slug === prefer ? 0 : house.length - 1 };
  }
  const named = guessFromName(path, kids, facts?.taken || null, prefer);
  return named ? { slug: named.slug, by: named.where, word: named.word, part: named.part, others: named.others || 0,
    outer: named.outer || '', outerPart: named.outerPart || '', inner: named.inner || '', innerPart: named.innerPart || '' } : null;
}

// ── Where and when it was taken ─────────────────────────────────────
const fourcc = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

/** GPS and the time taken from a TIFF block (EXIF), whose header starts at `start` in the view */
export function tiffFacts(v, start) {
  try {
    const order = v.getUint16(start);
    if (order !== 0x4949 && order !== 0x4d4d) return null;
    const le = order === 0x4949;
    const u16 = (o) => v.getUint16(start + o, le);
    const u32 = (o) => v.getUint32(start + o, le);
    if (u16(2) !== 42) return null;
    const ifd = (off) => {
      const tags = new Map();
      if (!off || start + off + 2 > v.byteLength) return tags;
      const n = u16(off);
      for (let i = 0; i < n && i < 400; i++) {
        const e = off + 2 + i * 12;
        if (start + e + 12 > v.byteLength) break;
        tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
      }
      return tags;
    };
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const where = (t) => ((SIZE[t.type] || 1) * t.count <= 4 ? t.at : u32(t.at));
    const ascii = (t) => {
      if (!t) return '';
      const o = where(t);
      let s = '';
      for (let i = 0; i < t.count && start + o + i < v.byteLength; i++) { const c = v.getUint8(start + o + i); if (!c) break; s += String.fromCharCode(c); }
      return s;
    };
    const rationals = (t) => {
      if (!t || t.type !== 5) return null;
      const o = u32(t.at);
      const out = [];
      for (let i = 0; i < t.count; i++) { const d = u32(o + i * 8 + 4); out.push(d ? u32(o + i * 8) / d : 0); }
      return out;
    };
    const ifd0 = ifd(u32(4));
    const facts = {};
    const gps = ifd0.get(0x8825) ? ifd(u32(ifd0.get(0x8825).at)) : new Map();
    const lat = rationals(gps.get(2));
    const lng = rationals(gps.get(4));
    if (lat?.length === 3 && lng?.length === 3) {
      const dms = (x) => x[0] + x[1] / 60 + x[2] / 3600;
      const la = dms(lat) * (/S/i.test(ascii(gps.get(1))) ? -1 : 1);
      const lo = dms(lng) * (/W/i.test(ascii(gps.get(3))) ? -1 : 1);
      if (Math.abs(la) <= 90 && Math.abs(lo) <= 180 && (la || lo)) { facts.lat = la; facts.lng = lo; }
    }
    const exif = ifd0.get(0x8769) ? ifd(u32(ifd0.get(0x8769).at)) : new Map();
    const when = ascii(exif.get(0x9003) || ifd0.get(0x0132)).match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)(?::(\d\d))?/);
    if (when) facts.taken = new Date(+when[1], +when[2] - 1, +when[3], +when[4], +when[5], +(when[6] || 0));
    return facts;
  } catch {
    return null;
  }
}

/** A JPEG's EXIF facts, from its first bytes */
export function jpegFacts(buf) {
  const v = new DataView(buf);
  try {
    if (v.getUint16(0) !== 0xffd8) return null;
    let o = 2;
    while (o + 4 <= v.byteLength) {
      if (v.getUint8(o) !== 0xff) return null;
      const marker = v.getUint8(o + 1);
      const len = v.getUint16(o + 2);
      if (marker === 0xe1 && o + 10 <= v.byteLength && v.getUint32(o + 4) === 0x45786966 && v.getUint16(o + 8) === 0) return tiffFacts(v, o + 10);
      if (marker === 0xda || marker === 0xd9) return null;
      o += 2 + len;
    }
  } catch { /* cut short */ }
  return null;
}

// ISO base media boxes (HEIC, MOV, MP4): [{ type, start, body, end }] from `from` to `to`
function boxes(v, from, to) {
  const out = [];
  let o = from;
  while (o + 8 <= to && out.length < 500) {
    let size = v.getUint32(o);
    let head = 8;
    if (size === 1) { if (o + 16 > to) break; size = Number(v.getBigUint64(o + 8)); head = 16; } else if (size === 0) size = to - o;
    if (size < head) break;
    out.push({ type: fourcc(v, o + 4), start: o, body: o + head, end: Math.min(o + size, to) });
    o += size;
  }
  return out;
}
/** Where a HEIC's Exif item is: { offset, length } in the file, or null (read from its first bytes) */
export function heicExifPlace(buf) {
  const v = new DataView(buf);
  try {
    const meta = boxes(v, 0, v.byteLength).find((b) => b.type === 'meta');
    if (!meta) return null;
    const kids = boxes(v, meta.body + 4, meta.end);
    const iinf = kids.find((b) => b.type === 'iinf');
    const iloc = kids.find((b) => b.type === 'iloc');
    if (!iinf || !iloc) return null;
    // iinf: entries of infe; version 2+ names the item's type
    const iv = v.getUint8(iinf.body);
    let id = null;
    for (const e of boxes(v, iinf.body + 4 + (iv ? 4 : 2), iinf.end)) {
      if (e.type !== 'infe') continue;
      const ev = v.getUint8(e.body);
      if (ev < 2) continue;
      const itemId = ev === 2 ? v.getUint16(e.body + 4) : v.getUint32(e.body + 4);
      const typeAt = e.body + 4 + (ev === 2 ? 2 : 4) + 2;
      if (fourcc(v, typeAt) === 'Exif') { id = itemId; break; }
    }
    if (id === null) return null;
    // iloc: where each item's bytes are
    let p = iloc.body;
    const version = v.getUint8(p);
    p += 4;
    const b1 = v.getUint8(p);
    const b2 = v.getUint8(p + 1);
    p += 2;
    const offSize = b1 >> 4;
    const lenSize = b1 & 15;
    const baseSize = b2 >> 4;
    const idxSize = version >= 1 ? b2 & 15 : 0;
    const read = (size) => {
      let x = 0;
      if (size === 2) x = v.getUint16(p);
      else if (size === 4) x = v.getUint32(p);
      else if (size === 8) x = Number(v.getBigUint64(p));
      p += size;
      return x;
    };
    const count = version < 2 ? read(2) : read(4);
    for (let i = 0; i < count; i++) {
      const itemId = version < 2 ? read(2) : read(4);
      const method = version >= 1 ? read(2) & 15 : 0;
      read(2); // data reference
      const base = read(baseSize);
      const extents = read(2);
      let first = null;
      for (let e = 0; e < extents; e++) {
        if (idxSize) read(idxSize);
        const off = read(offSize);
        const len = read(lenSize);
        if (!first) first = { offset: base + off, length: len };
      }
      if (itemId === id) return method === 0 ? first : null;
    }
  } catch { /* cut short */ }
  return null;
}
/** A HEIC Exif item's facts (its first 4 bytes say where the TIFF header starts) */
export function heicExifFacts(buf) {
  const v = new DataView(buf);
  try {
    const skip = v.getUint32(0);
    return tiffFacts(v, 4 + skip);
  } catch {
    return null;
  }
}
/** A movie's place (ISO 6709, as iPhones and Android phones write it) from its moov box text */
export function movieSpot(buf) {
  const text = new TextDecoder('latin1').decode(buf);
  const m = text.match(/([+-]\d{2}\.\d{3,})([+-]\d{3}\.\d{3,})/);
  if (!m) return {};
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : {};
}

const sliceBuf = (file, a, b) => file.slice(a, b).arrayBuffer();
/**
 * Where and when a File was taken: { lat?, lng?, taken? } ({} when it doesn't say).
 * Reads only the few bytes that hold it, never the whole file.
 */
export async function readFacts(file) {
  try {
    const name = String(file.name || '');
    const type = String(file.type || '').toLowerCase();
    if (/^image\/jpe?g$/.test(type) || /\.jpe?g$/i.test(name)) return jpegFacts(await sliceBuf(file, 0, MAX_HEAD)) || {};
    if (/^image\/hei[cf]$/.test(type) || /\.hei[cf]$/i.test(name)) {
      const place = heicExifPlace(await sliceBuf(file, 0, MAX_HEAD));
      if (!place || !place.length) return {};
      return heicExifFacts(await sliceBuf(file, place.offset, place.offset + Math.min(place.length, MAX_HEAD))) || {};
    }
    if (/^video\//.test(type) || /\.(mov|mp4|m4v)$/i.test(name)) {
      // Walk the top-level boxes (a recording's moov is often after its media) to the moov
      let o = 0;
      for (let i = 0; i < 64 && o + 8 <= file.size; i++) {
        const v = new DataView(await sliceBuf(file, o, o + 16));
        if (v.byteLength < 8) break;
        let size = v.getUint32(0);
        if (size === 1 && v.byteLength >= 16) size = Number(v.getBigUint64(8));
        else if (size === 0) size = file.size - o;
        if (fourcc(v, 4) === 'moov') return movieSpot(await sliceBuf(file, o, o + Math.min(size, 8 * 1024 * 1024)));
        if (size < 8) break;
        o += size;
      }
    }
  } catch { /* unreadable: no facts */ }
  return {};
}
