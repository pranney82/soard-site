/**
 * Where is this home? (service-area check)
 * ===========================================================================
 * The family enters their address (Google's suggestions and the Postal Service's check make it a real
 * one); this only finds where that house is, and never changes the address. The house is then placed
 * against the service area (Admin → Applications → Settings → Service area): inside it, close to it
 * (within the "close" distance) or farther out (../../public/admin/area-shared.js holds the geometry).
 *
 * Who's asked, in order, and only for the house typed (the same number on the same street; anything
 * else is no answer, never a stand-in):
 *   1. Esri, when SOARD's credentials are set (./_esri.js): it has the houses
 *   2. the U.S. Census Bureau's geocoder: free, but it misses newer streets
 *   3. OpenStreetMap: only where it has the house itself
 * Google isn't one: its terms forbid using its places to decide whether a home is inside an area.
 * When none has the house, the family answers the question themselves and staff are told.
 *
 * The application asks this as the family types their address (POST /api/apply action 'area'), so the
 * form answers the service-area question itself, and checks it again on submit. Intake runs it once
 * more for staff when the form didn't (an application made before the check existed).
 */

import { insidePolygon, milesToEdge, placeHome, areaRules, cleanCorners, NEAR_MILES, sameHouse, streetKey } from '../../public/admin/area-shared.js';

export { insidePolygon, milesToEdge, sameHouse };

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
// OpenStreetMap's search (the same Photon that suggests addresses as families type, ./_address.js)
const PHOTON = 'https://photon.komoot.io/api/';
const UA = 'SunshineOnARanneyDay-application/1.0 (sunshineonaranneyday.com)';

/**
 * { lat, lng, county, matched, source } for a one-line address, or null when no one asked has that house.
 * `esri` is ./_esri.js's lookup (null without credentials). Throws only when no one could be asked (the
 * check is tried again later), never because a house wasn't found.
 */
export async function geocode(address, fetchImpl = fetch, { esri = null } = {}) {
  const q = String(address || '').trim();
  if (!q) return null;
  let failed = null;
  let answered = false; // Esri or the Census said they don't have it (OpenStreetMap's maps are too patchy for its "no" to count)
  const asks = [[esri, true], [(x) => censusGeocode(x, fetchImpl), true], [(x) => osmGeocode(x, fetchImpl), false]];
  for (const [ask, full] of asks) {
    if (!ask) continue;
    try {
      const g = await ask(q);
      if (g) return g;
      if (full) answered = true;
    } catch (e) { failed ||= e; }
  }
  if (!answered && failed) throw failed;
  return null;
}

async function censusGeocode(q, fetchImpl) {
  const url = `${CENSUS}?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Census geocoder returned ${res.status}`);
  const data = await res.json();
  // The Census answers with its nearest guess when it doesn't know a street ("420 Cooper Rd" for 420 Copper Ridge Dr,
  // ten miles off): only the house that was typed counts
  const typed = q.split(',')[0];
  const m = (data?.result?.addressMatches || []).find(x => x?.coordinates && sameHouse(typed, String(x.matchedAddress || '').split(',')[0]));
  if (!m) return null;
  const county = m.geographies?.Counties?.[0]?.BASENAME || (m.geographies?.Counties?.[0]?.NAME || '').replace(/ County$/, '') || null;
  return { lat: Number(m.coordinates.y), lng: Number(m.coordinates.x), county, matched: m.matchedAddress || null, source: 'census' };
}



/**
 * The same from OpenStreetMap: only where it has the house itself (the same number on the same street,
 * in the same ZIP or town), never a neighbor or the street. null when it doesn't.
 * `address` is addressText's "line1[, line2], City, ST 12345".
 */
async function osmGeocode(address, fetchImpl) {
  const parts = address.split(',').map(s => s.trim()).filter(Boolean);
  const m = /^(\d+[a-z]?)\s+(.+)$/i.exec(parts[0] || '');
  if (!m || parts.length < 3) return null;
  const last = parts[parts.length - 1];
  const city = parts[parts.length - 2];
  const zip = (/\b(\d{5})\b/.exec(last) || [])[1] || '';
  const state = (/^([a-z]{2})\b/i.exec(last) || [])[1]?.toUpperCase() || '';
  const res = await fetchImpl(`${PHOTON}?q=${encodeURIComponent([parts[0], city, last].join(', '))}&limit=6&lang=en`, {
    signal: AbortSignal.timeout(5000), headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`OpenStreetMap search returned ${res.status}`);
  const data = await res.json();
  const want = streetKey(m[2]);
  const onStreet = (p) => {
    const s = streetKey(p.street || p.name);
    return s.length >= 3 && (s === want || s.includes(want) || want.includes(s));
  };
  const near = (p) => (zip && String(p.postcode || '').slice(0, 5) === zip)
    || [p.city, p.town, p.village, p.district].some(c => c && String(c).toLowerCase() === city.toLowerCase());
  const found = (data.features || []).filter(f => f?.geometry?.coordinates?.length === 2 && (!f.properties?.countrycode || f.properties.countrycode === 'US'));
  const best = found.find(f => onStreet(f.properties) && near(f.properties) && String(f.properties.housenumber || '').toLowerCase() === m[1].toLowerCase());
  if (!best) return null;
  const [lng, lat] = best.geometry.coordinates.map(Number);
  return {
    lat, lng,
    county: String(best.properties.county || '').replace(/ County$/, '') || null,
    matched: [parts[0], city, state, zip].filter(Boolean).join(', ').toUpperCase(),
    source: 'openstreetmap',
  };
}

/**
 * The address as one comparable line ("12 oak st, marietta, ga 30060"): the
 * key a check is stored under, so a changed address is checked again.
 */
export function addressKey(a) {
  if (!a || typeof a !== 'object') return '';
  const parts = [a.line1, a.line2, a.city, [a.state, String(a.zip || '').slice(0, 5)].filter(Boolean).join(' ')];
  return parts.map(s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean).join(', ');
}

/** Enough of an address for the Census to place: street, city or ZIP, and state */
export function checkableAddress(a) {
  return !!(a && String(a.line1 || '').trim().length >= 3 && /\d/.test(String(a.line1 || ''))
    && String(a.state || '').trim() && (String(a.city || '').trim() || /^\d{5}/.test(String(a.zip || '').trim())));
}

/**
 * The full check for an address against the area ({ polygon, nearMiles } or just the corners):
 * { status: 'inside' | 'outside' | 'unknown', band: 'inside' | 'near' | 'far' | 'unknown',
 *   miles?, edgeMiles?, nearMiles?, lat?, lng?, county?, matched?, source?, accuracy?, reason?, error? }
 * reason is 'no-match' (no one asked has the house) or 'error' (no one could be asked); either way the
 * family answers for themselves. `esri`: ./_esri.js's esriLocator(env), when the caller has it.
 */
export async function checkServiceArea(address, area, fetchImpl = fetch, { esri = null } = {}) {
  const rules = Array.isArray(area) ? { polygon: cleanCorners(area), nearMiles: NEAR_MILES } : areaRules(area);
  try {
    const g = await geocode(address, fetchImpl, { esri });
    if (!g) return { status: 'unknown', band: 'unknown', reason: 'no-match', error: 'The address lookup couldn’t find this house.', ...(esri ? { withEsri: true } : {}) };
    const p = placeHome(g.lat, g.lng, rules);
    return { status: p.band === 'inside' ? 'inside' : p.band === 'unknown' ? 'unknown' : 'outside', band: p.band, miles: p.miles, edgeMiles: p.edgeMiles, nearMiles: rules.nearMiles, ...g };
  } catch (e) {
    return { status: 'unknown', band: 'unknown', reason: 'error', error: e.message };
  }
}

/** Who found the house, in a sentence: "Esri", "the Census", "OpenStreetMap" (older checks: the Census) */
export function sourceName(area) {
  return { esri: 'Esri', census: 'the Census', openstreetmap: 'OpenStreetMap' }[area?.source] || 'the Census';
}

/** The band of a stored check (older checks only said inside / outside) */
export function bandOf(area) {
  if (!area) return 'unknown';
  if (area.band) return area.band;
  if (area.status === 'inside') return 'inside';
  if (area.status === 'outside') return area.miles != null && area.miles <= NEAR_MILES ? 'near' : 'far';
  return 'unknown';
}

/** One line for staff: "Inside the service area" / "About 6.2 miles outside the service area (close to it)" */
export function areaText(area) {
  if (!area) return '';
  if (area.status === 'inside') return area.edgeMiles != null && area.edgeMiles < 1 ? 'Inside the service area (near the edge)' : 'Inside the service area';
  if (area.status === 'outside') return `About ${area.miles} ${area.miles === 1 ? 'mile' : 'miles'} outside the service area${bandOf(area) === 'near' ? ' (close to it)' : ''}`;
  return `Couldn't check the address${area.error ? ` (${area.error})` : ''}`;
}
