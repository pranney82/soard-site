/**
 * Where is this home? (service-area check)
 * ===========================================================================
 * The U.S. Census Bureau's geocoder turns a street address into a map point
 * and its county: free, no key, U.S. addresses only. The point is then placed
 * against the service area (Admin → Applications → Settings → Service area):
 * inside it, close to it (within the "close" distance) or farther out
 * (../../public/admin/area-shared.js holds the geometry).
 *
 * The application asks this as the family types their address (POST /api/apply
 * action 'area'), so the form answers the service-area question itself, and
 * checks it again on submit. Intake runs it once more for staff when the form
 * didn't (an application made before the check existed).
 */

import { insidePolygon, milesToEdge, placeHome, areaRules, cleanCorners, NEAR_MILES } from '../../public/admin/area-shared.js';

export { insidePolygon, milesToEdge };

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
// OpenStreetMap's search (the same Photon that suggests addresses as families type, ./_address.js)
const PHOTON = 'https://photon.komoot.io/api/';
const UA = 'SunshineOnARanneyDay-application/1.0 (sunshineonaranneyday.com)';

/**
 * { lat, lng, county, matched } for a one-line address, or null when it can't be placed. The
 * Census first; it has outages (a 502 after ten seconds, for hours), so when it can't be asked,
 * OpenStreetMap places the home instead. Throws only when neither can place it.
 */
export async function geocode(address, fetchImpl = fetch) {
  const q = String(address || '').trim();
  if (!q) return null;
  try {
    return await censusGeocode(q, fetchImpl);
  } catch (e) {
    const alt = await osmGeocode(q, fetchImpl).catch(() => null);
    if (alt) return alt;
    throw e;
  }
}

async function censusGeocode(q, fetchImpl) {
  const url = `${CENSUS}?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Census geocoder returned ${res.status}`);
  const data = await res.json();
  const m = data?.result?.addressMatches?.[0];
  if (!m?.coordinates) return null;
  const county = m.geographies?.Counties?.[0]?.BASENAME || (m.geographies?.Counties?.[0]?.NAME || '').replace(/ County$/, '') || null;
  return { lat: Number(m.coordinates.y), lng: Number(m.coordinates.x), county, matched: m.matchedAddress || null };
}

// "Lawrence Street Northeast" and "Lawrence St NE" are the same street
const WORDS = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', circle: 'cir', boulevard: 'blvd', parkway: 'pkwy',
  place: 'pl', trail: 'trl', highway: 'hwy', terrace: 'ter', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  north: 'n', south: 's', east: 'e', west: 'w',
};
const streetKey = (s) => String(s || '').toLowerCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean).map(w => WORDS[w] || w).join(' ');

/**
 * The same from OpenStreetMap, for a Census outage: the home itself where it's mapped, else a place
 * on the same street in the same ZIP or town (close enough to put it on the service-area map).
 * null when nothing on that street turns up. `address` is addressText's "line1[, line2], City, ST 12345".
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
  const home = found.find(f => onStreet(f.properties) && near(f.properties) && String(f.properties.housenumber || '').toLowerCase() === m[1].toLowerCase());
  const best = home || found.find(f => onStreet(f.properties) && near(f.properties));
  if (!best) return null;
  const [lng, lat] = best.geometry.coordinates.map(Number);
  return {
    lat, lng,
    county: String(best.properties.county || '').replace(/ County$/, '') || null,
    matched: [parts[0], city, state, zip].filter(Boolean).join(', ').toUpperCase(),
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
 * The full check for an address against the area ({ polygon, nearMiles } or
 * just the corners):
 * { status: 'inside' | 'outside' | 'unknown', band: 'inside' | 'near' | 'far' | 'unknown',
 *   miles?, edgeMiles?, nearMiles?, lat?, lng?, county?, matched?, reason?, error? }
 * reason is 'no-match' (the Census doesn't know the address) or 'error' (it
 * couldn't be asked); either way the family answers for themselves.
 */
export async function checkServiceArea(address, area, fetchImpl = fetch) {
  const rules = Array.isArray(area) ? { polygon: cleanCorners(area), nearMiles: NEAR_MILES } : areaRules(area);
  try {
    const g = await geocode(address, fetchImpl);
    if (!g) return { status: 'unknown', band: 'unknown', reason: 'no-match', error: 'The Census couldn’t find this address.' };
    const p = placeHome(g.lat, g.lng, rules);
    return { status: p.band === 'inside' ? 'inside' : p.band === 'unknown' ? 'unknown' : 'outside', band: p.band, miles: p.miles, edgeMiles: p.edgeMiles, nearMiles: rules.nearMiles, ...g };
  } catch (e) {
    return { status: 'unknown', band: 'unknown', reason: 'error', error: e.message };
  }
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
