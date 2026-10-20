/**
 * Where is this home? (service-area check)
 * ===========================================================================
 * The U.S. Census Bureau's geocoder turns a street address into a map point
 * and its county: free, no key, U.S. addresses only. The point is then tested
 * against the service-area boundary (the red outline, as [lat, lng] corners in
 * the form's settings) and, when outside, how far outside in miles.
 *
 * This only informs staff: the family's own answer about the boundary still
 * decides what they see on the form.
 */

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';

/**
 * { lat, lng, county, matched } for a one-line address, or null when the
 * Census can't place it. Throws only on network trouble.
 */
export async function geocode(address, fetchImpl = fetch) {
  const q = String(address || '').trim();
  if (!q) return null;
  const url = `${CENSUS}?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Census geocoder returned ${res.status}`);
  const data = await res.json();
  const m = data?.result?.addressMatches?.[0];
  if (!m?.coordinates) return null;
  const county = m.geographies?.Counties?.[0]?.BASENAME || (m.geographies?.Counties?.[0]?.NAME || '').replace(/ County$/, '') || null;
  return { lat: Number(m.coordinates.y), lng: Number(m.coordinates.x), county, matched: m.matchedAddress || null };
}

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
  const toXY = ([la, ln]) => [ln * 69.172 * Math.cos((lat * Math.PI) / 180), la * 69.0];
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

/**
 * The full check for an address against a boundary:
 * { status: 'inside' | 'outside' | 'unknown', miles?, lat?, lng?, county?, matched?, error? }
 */
export async function checkServiceArea(address, polygon, fetchImpl = fetch) {
  try {
    const g = await geocode(address, fetchImpl);
    if (!g) return { status: 'unknown', error: 'The Census couldn’t find this address.' };
    const inside = insidePolygon([g.lat, g.lng], polygon);
    const miles = Math.round(milesToEdge([g.lat, g.lng], polygon) * 10) / 10;
    return { status: inside ? 'inside' : 'outside', miles: inside ? 0 : miles, edgeMiles: miles, ...g };
  } catch (e) {
    return { status: 'unknown', error: e.message };
  }
}

/** One line for staff: "Inside the service area" / "About 6.2 miles outside the service area" */
export function areaText(area) {
  if (!area) return '';
  if (area.status === 'inside') return area.edgeMiles != null && area.edgeMiles < 1 ? 'Inside the service area (near the edge)' : 'Inside the service area';
  if (area.status === 'outside') return `About ${area.miles} ${area.miles === 1 ? 'mile' : 'miles'} outside the service area`;
  return `Couldn't check the address${area.error ? ` (${area.error})` : ''}`;
}
