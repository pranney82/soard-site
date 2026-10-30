/**
 * Address suggestions for the application's home address
 * ===========================================================================
 * As a family types their street address, the form offers matching homes,
 * and picking one fills in city, state, ZIP and county (Jotform's
 * "Autocompleted Address" did the same). Suggestions come from Photon, a free
 * OpenStreetMap search (photon.komoot.io), asked from our server so the page
 * talks only to our own site. Results lean toward metro Atlanta.
 */

const PHOTON = 'https://photon.komoot.io/api/';
// Metro Atlanta, a little past the service area on every side (lon/lat box)
const BBOX = '-85.2,33.4,-83.6,34.6';
const STATES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

// Street words people type short, so "Lawrence Street Northeast" reads "Lawrence St NE"
const SHORT = [[/\bNortheast\b/g, 'NE'], [/\bNorthwest\b/g, 'NW'], [/\bSoutheast\b/g, 'SE'], [/\bSouthwest\b/g, 'SW'],
  [/\bStreet\b/g, 'St'], [/\bAvenue\b/g, 'Ave'], [/\bRoad\b/g, 'Rd'], [/\bDrive\b/g, 'Dr'], [/\bLane\b/g, 'Ln'], [/\bCourt\b/g, 'Ct'],
  [/\bCircle\b/g, 'Cir'], [/\bBoulevard\b/g, 'Blvd'], [/\bParkway\b/g, 'Pkwy'], [/\bPlace\b/g, 'Pl'], [/\bTrail\b/g, 'Trl'], [/\bHighway\b/g, 'Hwy']];
export const shorten = (s) => SHORT.reduce((t, [re, w]) => t.replace(re, w), String(s || ''));

/** Up to five homes matching what the family typed: [{ line1, city, state, zip, county, label }] */
export async function suggestAddresses(q, fetchImpl = fetch) {
  const query = String(q || '').trim().slice(0, 120);
  if (query.length < 4 || !/\d/.test(query)) return [];
  const url = `${PHOTON}?q=${encodeURIComponent(query)}&limit=8&lang=en&bbox=${BBOX}&layer=house`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'SunshineOnARanneyDay-application/1.0 (sunshineonaranneyday.com)', Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const seen = new Set();
  const out = [];
  for (const f of data.features || []) {
    const p = f.properties || {};
    if (p.countrycode && p.countrycode !== 'US') continue;
    if (!p.housenumber || !p.street) continue;
    const line1 = `${p.housenumber} ${shorten(p.street)}`;
    const state = STATES[p.state] || p.state || '';
    const zip = String(p.postcode || '').slice(0, 5);
    const city = p.city || p.town || p.village || p.district || '';
    const key = `${line1}|${city}|${zip}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line1, city, state, zip, county: String(p.county || '').replace(/ County$/, ''), label: [line1, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') });
    if (out.length === 5) break;
  }
  return out;
}
