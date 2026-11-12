/**
 * The service area, as geometry
 * ===========================================================================
 * One copy, used everywhere a home is placed against the area:
 *  - the server (functions/api/_geo.js): the application's address check and
 *    the staff checks at intake;
 *  - the application page's map (src/components/apply/area-map.js);
 *  - the admin: Applications → Settings → Service area, and the Applicants map.
 *
 * The area is a list of [lat, lng] corners (drawn on the Applicants map). A
 * home with a map point lands in one of three bands:
 *   inside  inside the outline
 *   near    outside it, by no more than `nearMiles` ("Close to the area")
 *   far     farther out than that
 * and 'unknown' when there's no map point to place.
 */

export const NEAR_MILES = 15;   // "Close to the area", unless Settings say otherwise
export const NEAR_MAX = 50;
export const BEYOND = ['warn', 'stop']; // families farther out: told and can still apply, or stopped
export const BANDS = ['inside', 'near', 'far'];

const MI_LAT = 69.0;     // miles per degree of latitude
const MI_LNG = 69.172;   // miles per degree of longitude at the equator

/** Is [lat, lng] inside the polygon (list of [lat, lng])? Ray casting. */
export function insidePolygon([lat, lng], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Miles from a point to the nearest edge of the polygon (flat projection; plenty for a metro area) */
export function milesToEdge([lat, lng], polygon) {
  const toXY = ([la, ln]) => [ln * MI_LNG * Math.cos((lat * Math.PI) / 180), la * MI_LAT];
  const [px, py] = toXY([lat, lng]);
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = toXY(polygon[j]);
    const [bx, by] = toXY(polygon[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/** Straight-line miles between two [lat, lng] points */
export function milesBetween([la1, ln1], [la2, ln2]) {
  const k = Math.cos((((la1 + la2) / 2) * Math.PI) / 180);
  return Math.hypot((ln2 - ln1) * MI_LNG * k, (la2 - la1) * MI_LAT);
}

const round1 = (n) => Math.round(n * 10) / 10;

/** A usable polygon: at least three finite [lat, lng] corners, else null */
export function cleanCorners(list) {
  if (!Array.isArray(list)) return null;
  const pts = list.map(p => [Number(p?.[0]), Number(p?.[1])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180);
  return pts.length >= 3 ? pts : null;
}

/** The close distance in whole miles, 0 to NEAR_MAX (0 = no "close" band: outside is far) */
export function cleanNearMiles(v, fallback = NEAR_MILES) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(NEAR_MAX, Math.round(n))) : fallback;
}

/** The area's settings with defaults filled in: { polygon, nearMiles, beyond } */
export function areaRules(sa, fallbackPolygon = null) {
  const o = sa && typeof sa === 'object' ? sa : {};
  return {
    polygon: cleanCorners(o.polygon) || fallbackPolygon,
    nearMiles: cleanNearMiles(o.nearMiles),
    beyond: o.beyond === 'stop' ? 'stop' : 'warn',
  };
}

/**
 * Where a map point sits: { band, miles, edgeMiles }. `miles` is how far
 * outside (0 inside); `edgeMiles` is the distance to the outline either way.
 */
export function placeHome(lat, lng, area) {
  const polygon = area?.polygon;
  if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) || !Array.isArray(polygon) || polygon.length < 3) {
    return { band: 'unknown', miles: null, edgeMiles: null };
  }
  const pt = [Number(lat), Number(lng)];
  const edge = round1(milesToEdge(pt, polygon));
  if (insidePolygon(pt, polygon)) return { band: 'inside', miles: 0, edgeMiles: edge };
  const near = cleanNearMiles(area.nearMiles);
  return { band: edge <= near ? 'near' : 'far', miles: edge, edgeMiles: edge };
}

/** How many points fall in each band: { inside, near, far, unknown } (points: [{ lat, lng }]) */
export function bandCounts(points, area) {
  const out = { inside: 0, near: 0, far: 0, unknown: 0 };
  for (const p of points || []) out[placeHome(p?.lat, p?.lng, area).band]++;
  return out;
}

/**
 * Who changes band when the area changes: [{ id, from, to }] for each point
 * (with an id) whose band differs between `before` and `after`.
 */
export function bandChanges(points, before, after) {
  const out = [];
  for (const p of points || []) {
    const a = placeHome(p?.lat, p?.lng, before).band;
    const b = placeHome(p?.lat, p?.lng, after).band;
    if (a !== b) out.push({ id: p.id, from: a, to: b });
  }
  return out;
}

/** The middle of the outline (the average of its corners, area-weighted) as [lat, lng] */
export function areaCenter(polygon) {
  let a = 0; let cx = 0; let cy = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [y0, x0] = polygon[j];
    const [y1, x1] = polygon[i];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = polygon.length;
    return [polygon.reduce((s, p) => s + p[0], 0) / n, polygon.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cy / (3 * a), cx / (3 * a)];
}

/**
 * The line `miles` outside the outline, as [lat, lng] points: the edge of
 * "Close to the area" on a map. Found along rays from the middle (the outline
 * is one blob, so each ray leaves it once), `steps` of them.
 */
export function nearRing(polygon, miles, steps = 144) {
  if (!Array.isArray(polygon) || polygon.length < 3 || !(miles > 0)) return [];
  const [clat, clng] = areaCenter(polygon);
  const k = Math.cos((clat * Math.PI) / 180);
  const at = (theta, r) => [clat + (r * Math.sin(theta)) / MI_LAT, clng + (r * Math.cos(theta)) / (MI_LNG * k)];
  const reach = Math.max(...polygon.map(p => milesBetween([clat, clng], p))) + 1;
  const ring = [];
  for (let s = 0; s < steps; s++) {
    const theta = (s / steps) * Math.PI * 2;
    // Where the ray leaves the outline
    let lo = 0; let hi = reach;
    for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (insidePolygon(at(theta, mid), polygon)) lo = mid; else hi = mid; }
    // Then how far out until the outline is `miles` away
    let a = hi; let b = hi + miles;
    for (let i = 0; i < 12 && milesToEdge(at(theta, b), polygon) < miles; i++) b += miles;
    for (let i = 0; i < 24; i++) { const mid = (a + b) / 2; if (milesToEdge(at(theta, mid), polygon) < miles) a = mid; else b = mid; }
    const [la, ln] = at(theta, (a + b) / 2);
    ring.push([Math.round(la * 1e5) / 1e5, Math.round(ln * 1e5) / 1e5]);
  }
  return ring;
}

// ── Is it the same house? ──────────────────────────────────────────────
// Map services answer with their nearest guess for a street they don't know; the server keeps a
// place only when it's the house that was typed, and the form says which house it found.

// "Lawrence Street Northeast" and "Lawrence St NE" are the same street
const WORDS = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', circle: 'cir', boulevard: 'blvd', parkway: 'pkwy',
  place: 'pl', trail: 'trl', highway: 'hwy', terrace: 'ter', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  north: 'n', south: 's', east: 'e', west: 'w',
};
export const streetKey = (s) => String(s || '').toLowerCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean).map(w => WORDS[w] || w).join(' ');
// A street's kind and its direction, which a map service may write, drop or spell out
const KINDS_OF_STREET = new Set(['st', 'ave', 'rd', 'dr', 'ln', 'ct', 'cir', 'blvd', 'pkwy', 'pl', 'trl', 'hwy', 'ter', 'way', 'run', 'xing', 'pt', 'cv', 'loop', 'sq', 'path', 'walk', 'row', 'pass', 'bnd', 'cres', 'crk', 'gln', 'hl', 'holw', 'lndg', 'mdw', 'rdg', 'vw', 'vis', 'aly', 'byp', 'cswy', 'ctr', 'expy', 'fwy', 'grn', 'plz', 'tpke', 'trce', 'tunl', 'xrd', 'spur', 'pike', 'circle', 'cove', 'point', 'crossing']);
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
/** Fewest one-letter changes from a to b */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}
/** "420 Copper Ridge Dr" → { number: '420', name: 'copper ridge', kind: 'dr', dir: '' } */
function houseParts(line) {
  const words = streetKey(line).split(' ').filter(Boolean);
  const number = /^\d+[a-z]?$/.test(words[0] || '') ? words.shift() : '';
  const dirs = words.filter((w, i) => DIRECTIONS.has(w) && (i === 0 || i === words.length - 1));
  const rest = words.filter((w, i) => !(DIRECTIONS.has(w) && (i === 0 || i === words.length - 1)));
  const kind = rest.length > 1 && KINDS_OF_STREET.has(rest[rest.length - 1]) ? rest.pop() : '';
  return { number, name: rest.join(' '), kind, dir: dirs.join(' ') };
}
/**
 * Is `found` (a map service's first line) the house `typed`? The same number on the same street: its kind
 * and direction may be left off ("175 Summer Lake Dr" for 175 Summer Lake Dr SW), and its name a letter or
 * two apart ("Holcomb Wood Pkwy" for Holcomb Woods Pkwy), but never another street ("420 Cooper Rd" for
 * 420 Copper Ridge Dr) or another house on it.
 */
export function sameHouse(typed, found) {
  const a = houseParts(typed);
  const b = houseParts(found);
  if (!a.number || a.number !== b.number || !a.name || !b.name) return false;
  if (a.kind && b.kind && a.kind !== b.kind) return false;
  if (a.dir && b.dir && a.dir !== b.dir) return false;
  if (a.name === b.name) return true;
  const longer = Math.max(a.name.length, b.name.length);
  return longer >= 6 && editDistance(a.name, b.name) <= (longer >= 12 ? 2 : 1);
}
