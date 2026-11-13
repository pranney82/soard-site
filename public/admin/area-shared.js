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

// The Postal Service's street types (Publication 28, appendix C1): each standard abbreviation, then the
// ways it's written. "Gold Valley Crossing" and "Gold Valley Xing" are the same street.
const STREET_TYPES = 'aly alley allee ally|anx anex annex annx|arc arcade|ave avenue av aven avenu avn avnue|byu bayou bayoo|bch beach|bnd bend|blf bluff bluf|blfs bluffs|btm bottom bot bottm|blvd boulevard boul boulv|br branch brnch|brg bridge brdge|brk brook|brks brooks|bg burg|bgs burgs|byp bypass bypa bypas byps|cp camp cmp|cyn canyon canyn cnyn|cpe cape|cswy causeway causwa|ctr center cen cent centr centre cnter cntr|ctrs centers|cir circle circ circl crcl crcle|cirs circles|clf cliff|clfs cliffs|clb club|cmn common|cmns commons|cor corner|cors corners|crse course|ct court crt|cts courts|cv cove|cvs coves|crk creek|cres crescent crsent crsnt|crst crest|xing crossing crssng|xrd crossroad|xrds crossroads|curv curve|dl dale|dm dam|dv divide div dvd|dr drive driv drv|drs drives|est estate|ests estates|expy expressway exp expr express expw|ext extension extn extnsn|exts extensions|fls falls|fry ferry frry|fld field|flds fields|flt flat|flts flats|frd ford|frds fords|frst forest forests|frg forge forg|frgs forges|frk fork|frks forks|ft fort frt|fwy freeway freewy frway frwy|gdn garden gardn grden grdn|gdns gardens grdns|gtwy gateway gatewy gatway gtway|gln glen|glns glens|grn green|grns greens|grv grove grov|grvs groves|hbr harbor harb harbr hrbor|hbrs harbors|hvn haven|hts heights ht|hwy highway highwy hiway hiwy hway|hl hill|hls hills|holw hollow hllw hollows holws|inlt inlet|is island islnd|iss islands islnds|jct junction jction jctn junctn juncton|jcts junctions jctns|ky key|kys keys|knl knoll knol|knls knolls|lk lake|lks lakes|lndg landing lndng|ln lane|lgt light|lgts lights|lf loaf|lck lock|lcks locks|ldg lodge ldge lodg|mnr manor|mnrs manors|mdw meadow|mdws meadows medows|ml mill|mls mills|msn mission missn mssn|mtwy motorway|mt mount mnt|mtn mountain mntain mntn mountin mtin|mtns mountains mntns|nck neck|orch orchard orchrd|opas overpass|park parks|pkwy parkway parkwy pkway pky parkways pkwys|psge passage|pne pine|pnes pines|pl place|pln plain|plns plains|plz plaza plza|pt point|pts points|prt port|prts ports|pr prairie prr|radl radial rad radiel|rnch ranch ranches rnchs|rpd rapid|rpds rapids|rst rest|rdg ridge rdge|rdgs ridges|riv river rvr rivr|rd road|rds roads|rte route|shl shoal|shls shoals|shr shore shoar|shrs shores shoars|skwy skyway|spg spring spng sprng|spgs springs spngs sprngs|sq square sqr sqre squ|sqs squares sqrs|sta station statn stn|stra stravenue strav straven stravn strvn strvnue|strm stream streme|st street strt str|sts streets|smt summit sumit sumitt|ter terrace terr|trwy throughway|trce trace traces|trak track tracks trk trks|trfy trafficway|trl trail trails trls|trlr trailer trlrs|tunl tunnel tunel tunls tunnels tunnl|tpke turnpike trnpk turnpk|upas underpass|un union|uns unions|vly valley vally vlly|vlys valleys|via viaduct vdct viadct|vw view|vws views|vlg village vill villag villg villiage|vlgs villages|vl ville|vis vista vist vst vsta|way|ways|wl well|wls wells|loop loops|mall|mews|oval|pass|path paths|pike pikes|ramp|row|rue|run|spur spurs|walk walks|wall|land|isle isles|fall';
const WORDS = {
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw', north: 'n', south: 's', east: 'e', west: 'w',
  saint: 'st',
};
const KINDS_OF_STREET = new Set();
for (const group of STREET_TYPES.split('|')) {
  const [abbr, ...ways] = group.split(' ');
  KINDS_OF_STREET.add(abbr);
  for (const w of ways) WORDS[w] ??= abbr;
}
/** "Lawrence Street Northeast" → "lawrence st ne"; "GA-20" → "ga 20" */
export const streetKey = (s) => String(s || '').toLowerCase().replace(/([a-z])-(\d)/g, '$1 $2').replace(/[.,#]/g, ' ')
  .split(/\s+/).filter(Boolean).map(w => WORDS[w] || w).join(' ');
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
// The apartment or unit on the street line (Publication 28, appendix C2), never part of the street:
// "Pkwy #328", "Dr Apt 4B", "Rd Unit C", "Ln Bldg 2 Ste 100", "St Rear"
const UNIT_WITH_ID = /\s*(?:#|\b(?:apt|apartment|unit|ste|suite|bldg|building|fl|floor|rm|room|lot|spc|space|trlr|dept|hngr|slip|pier|stop|key)\b\.?\s*#?)\s*(?:[a-z]?\d[\w-]*|[a-z])\s*$/i;
const UNIT_ALONE = /\s+\b(?:rear|frnt|front|lowr|lower|uppr|upper|bsmt|basement|ofc|office|ph|penthouse|lbby|lobby|side)\.?\s*$/i;
function withoutUnit(line) {
  let s = String(line || '').trim();
  for (let i = 0; i < 3; i++) {
    const t = s.replace(UNIT_WITH_ID, '').replace(UNIT_ALONE, '').trim();
    if (t === s) break;
    s = t;
  }
  return s;
}
// A numbered highway however it's written: "Highway 20", "Hwy 20", "GA-20", "State Route 20", "SR 20", "US Hwy 19"
const ROUTE = /^(?:(?:ga|us|state|st)\s+)?(?:hwy|rte|rt|sr|state\s+(?:rte|hwy))?\s*(\d+[a-z]?)$/;
const routeOf = (name) => {
  const m = ROUTE.exec(name);
  return m && /\b(?:ga|us|state|hwy|rte|rt|sr)\b/.test(name) ? m[1] : null;
};
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
/** "420 Copper Ridge Dr #3" → { number: '420', words: ['copper', 'rdg', 'dr'], dir: '' } */
function houseParts(line) {
  const words = streetKey(withoutUnit(line)).split(' ').filter(Boolean);
  const number = /^\d+[a-z]?$/.test(words[0] || '') ? words.shift() : '';
  const dirs = words.filter((w, i) => DIRECTIONS.has(w) && (i === 0 || i === words.length - 1));
  const rest = words.filter((w, i) => !(DIRECTIONS.has(w) && (i === 0 || i === words.length - 1)));
  return { number, words: rest, dir: dirs.join(' ') };
}
/**
 * Is `found` (a map service's first line) the house `typed`? The same number on the same street: the
 * street's type and direction may be written another way or left off ("175 Summer Lake Dr" for 175
 * Summer Lake Dr SW, "210 Gold Valley Xing" for 210 Gold Valley Crossing), an apartment or unit doesn't
 * count, and its name may be a letter or two apart ("Holcomb Wood Pkwy" for Holcomb Woods Pkwy), but
 * never another street ("420 Cooper Rd" for 420 Copper Ridge Dr) or another house on it.
 */
export function sameHouse(typed, found) {
  const a = houseParts(typed);
  const b = houseParts(found);
  if (!a.number || a.number !== b.number || !a.words.length || !b.words.length) return false;
  if (a.dir && b.dir && a.dir !== b.dir) return false;
  const all = (p) => p.words.join(' ');
  if (all(a) === all(b)) return true;
  const kindOf = (p) => (p.words.length > 1 && KINDS_OF_STREET.has(p.words.at(-1)) ? p.words.at(-1) : '');
  const nameOf = (p) => (kindOf(p) ? p.words.slice(0, -1) : p.words).join(' ');
  const ka = kindOf(a);
  const kb = kindOf(b);
  const ra = routeOf(nameOf(a)) || routeOf(all(a));
  const rb = routeOf(nameOf(b)) || routeOf(all(b));
  if (ra || rb) return ra === rb && (!ka || !kb || ka === kb);
  // Two types: the same street only when one side's last word is really part of the name, its type
  // left off ("123 Lake Forest" for 123 Lake Forest Dr), never Dr for Ct
  if (ka && kb && ka !== kb) return all(a) === nameOf(b) || nameOf(a) === all(b);
  // The same type, or one side's left off: the names, a letter or two apart at most
  const na = ka ? nameOf(a) : all(a);
  const nb = kb ? nameOf(b) : all(b);
  if (na === nb) return true;
  const longer = Math.max(na.length, nb.length);
  return longer >= 6 && editDistance(na, nb) <= (longer >= 12 ? 2 : 1);
}
