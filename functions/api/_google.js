/**
 * Google's help with a family's home address, once SOARD has a key (the Cloudflare secret
 * GOOGLE_MAPS_KEY, used only here on the server):
 *   - suggestions as they type their street (Places Autocomplete, homes in the US, near Atlanta)
 *   - the street, city, state and ZIP of the one they pick (Place Details, address parts only)
 *   - what the Postal Service says about the address (Address Validation with USPS CASS)
 * Each stays inside Google's free monthly allowance (counted in D1): past it, without a key, or when
 * Google doesn't answer, callers use the free path (OpenStreetMap suggestions; no Postal Service word).
 * Peter gets an email at 80% of a month's allowance and when it runs out (once each, each month).
 *
 * Google's terms shape what we do with the answers: its places and coordinates are never drawn on our
 * own map (the service-area map and its check stay on the Census, ./_geo.js), nothing it returns is
 * kept except the address a family picks (theirs), and wherever its results show, "Google Maps" is
 * credited beside them.
 */
import { shorten } from './_address.js';
import { sendEmails } from './_broadcast-notify.js';
import { ALERT_EMAILS } from './_applications.js';

const PLACES = 'https://places.googleapis.com/v1';
const VALIDATE = 'https://addressvalidation.googleapis.com/v1:validateAddress';
// Google's free allowance each month is 10,000 suggestions, 10,000 place lookups and 5,000 address
// checks; these stop short of it, so SOARD is never billed
export const GOOGLE_MONTHLY = { suggest: 9000, place: 9000, verify: 4500 };
// Metro Atlanta (Google's widest bias circle, 50 km): homes there come first
const ATLANTA = { latitude: 33.92, longitude: -84.35 };

export const googleOn = (env) => !!env?.GOOGLE_MAPS_KEY;

const usageReady = new WeakSet(); // databases with the count's table
async function usageTable(DB) {
  if (usageReady.has(DB)) return;
  await DB.prepare('CREATE TABLE IF NOT EXISTS google_usage (month TEXT NOT NULL, sku TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (month, sku))').run();
  usageReady.add(DB);
}
const monthOf = (now) => now.toISOString().slice(0, 7);
/** How many of `sku` this month so far */
export async function used(DB, sku, now = new Date()) {
  if (!DB) return 0;
  await usageTable(DB);
  const row = await DB.prepare('SELECT n FROM google_usage WHERE month = ? AND sku = ?').bind(monthOf(now), sku).first();
  return Number(row?.n || 0);
}
/** One more `sku` this month if it's still inside the free allowance (Peter hears at 80% and when it runs out) */
export async function spend(env, sku, now = new Date()) {
  const cap = GOOGLE_MONTHLY[sku];
  const DB = env?.DB;
  if (!DB || !cap) return false;
  await usageTable(DB);
  const row = await DB.prepare('INSERT INTO google_usage (month, sku, n) VALUES (?, ?, 1) ON CONFLICT(month, sku) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(monthOf(now), sku).first();
  const n = Number(row?.n || 0);
  // Each count is reached by exactly one request, so each email goes once a month
  if (n === Math.ceil(cap * 0.8)) await tellPeter(env, sku, 'near', n, now);
  else if (n === cap + 1) await tellPeter(env, sku, 'out', cap, now);
  return n <= cap;
}

// What each kind of lookup does for a family, and what happens once the month's allowance is used
const KINDS = {
  suggest: { what: 'address suggestions as families type', free: 10000, price: '$2.83', after: 'the form suggests addresses from OpenStreetMap instead (free, a little less complete)' },
  place: { what: 'filling in an address a family picks', free: 10000, price: '$5', after: 'the form suggests addresses from OpenStreetMap instead, which fill in without Google' },
  verify: { what: 'Postal Service checks of home addresses', free: 5000, price: '$17', after: 'the map screen leaves out the Postal Service line (the service-area check itself carries on)' },
};
async function tellPeter(env, sku, stage, n, now) {
  const k = KINDS[sku];
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const cap = GOOGLE_MONTHLY[sku];
  const subject = stage === 'near'
    ? `Google address lookups: ${k.what} at 80% of this month's free limit`
    : `Google address lookups: ${k.what} reached this month's free limit`;
  const lines = stage === 'near'
    ? [
      `The application has used ${n.toLocaleString('en-US')} of the ${cap.toLocaleString('en-US')} Google lookups it allows itself this month for ${k.what}. Google's free allowance is ${k.free.toLocaleString('en-US')}, so nothing is billed.`,
      `At ${cap.toLocaleString('en-US')}, ${k.after} until ${nextMonth}. Nothing for you to do.`,
    ]
    : [
      `The application used all ${cap.toLocaleString('en-US')} Google lookups it allows itself this month for ${k.what}, so ${k.after} until ${nextMonth}. Families can still apply as normal, and nothing is billed.`,
      `If this happens often, Google charges about ${k.price} per 1,000 past its free ${k.free.toLocaleString('en-US')} a month; the limit lives in functions/api/_google.js.`,
    ];
  const text = `${lines.join('\n\n')}\n\nSent by sunshineonaranneyday.com`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#373A36">${lines.map(l => `<p>${l}</p>`).join('')}<p style="color:#6B6C70;font-size:13px">Sent by sunshineonaranneyday.com</p></div>`;
  try { await sendEmails(env, { to: ALERT_EMAILS, subject, html, text, tags: [{ name: 'type', value: 'google-usage' }] }); } catch { /* the count goes on; the free path doesn't need the email */ }
}

const ask = (env, url, init = {}, ms = 4000) => fetch(url, {
  ...init,
  headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_KEY, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  signal: AbortSignal.timeout(ms),
});

/** Up to five homes matching what's typed: [{ id, line1, sub }], or null for the free path */
export async function googleSuggest(env, q) {
  const input = String(q || '').trim().slice(0, 120);
  // Only while a pick can still be filled in from Google too
  if (!googleOn(env) || input.length < 4 || (await used(env.DB, 'place')) >= GOOGLE_MONTHLY.place || !(await spend(env, 'suggest'))) return null;
  const res = await ask(env, `${PLACES}/places:autocomplete`, {
    method: 'POST',
    headers: { 'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat' },
    body: JSON.stringify({
      input,
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
      includedRegionCodes: ['us'],
      locationBias: { circle: { center: ATLANTA, radius: 50000 } },
      languageCode: 'en', // street names as the Postal Service writes them, in either language
    }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  // Georgia's only: every family SOARD serves lives there, and "3167 Main St, Dothan, AL" is no help
  return (data.suggestions || []).map(s => s.placePrediction).filter(p => p?.placeId && p.structuredFormat?.mainText?.text)
    .map(p => ({ id: p.placeId, line1: shorten(p.structuredFormat.mainText.text), sub: String(p.structuredFormat.secondaryText?.text || '').replace(/, USA$/, '') }))
    .filter(p => /, GA$/.test(p.sub)).slice(0, 5);
}

/** The address parts of the home they picked: { line1, line2, city, state, zip }, or null */
export async function googlePlace(env, id) {
  if (!googleOn(env) || !/^[\w-]{10,300}$/.test(String(id || '')) || !(await spend(env, 'place'))) return null;
  const res = await ask(env, `${PLACES}/places/${encodeURIComponent(id)}`, { headers: { 'X-Goog-FieldMask': 'addressComponents' } });
  if (!res.ok) return null;
  const parts = (await res.json().catch(() => ({})))?.addressComponents || [];
  const part = (type, short = false) => { const c = parts.find(x => x.types?.includes(type)); return String((c && (short ? c.shortText : c.longText)) || ''); };
  const number = part('street_number');
  const street = part('route', true);
  if (!number || !street) return null;
  const unit = part('subpremise');
  return {
    line1: shorten(`${number} ${street}`),
    line2: unit ? (/^\d+[a-z]?$/i.test(unit) ? `#${unit}` : unit) : '',
    city: part('locality') || part('postal_town') || part('sublocality') || part('administrative_area_level_3'),
    state: part('administrative_area_level_1', true),
    zip: part('postal_code').slice(0, 5),
  };
}

/**
 * What the Postal Service says about an address (Address Validation, USPS CASS): 'confirmed',
 * 'unit' (the building is a delivery address; its apartment or unit number may be missing),
 * 'check' (not a delivery address the Postal Service knows), or null (no answer). Only that word
 * is used, live; nothing else from the answer is kept.
 */
export async function googleVerify(env, a) {
  const line1 = [a?.line1, a?.line2].map(s => String(s || '').trim()).filter(Boolean).join(' ');
  const last = [a?.city, a?.state, a?.zip].map(s => String(s || '').trim()).filter(Boolean).join(' ');
  if (!googleOn(env) || !line1 || !/^\d{5}/.test(String(a?.zip || '').trim()) || !(await spend(env, 'verify'))) return null;
  const res = await ask(env, VALIDATE, {
    method: 'POST',
    body: JSON.stringify({ address: { regionCode: 'US', addressLines: [line1.slice(0, 160), last.slice(0, 120)] }, enableUspsCass: true }),
  }, 5000);
  if (!res.ok) return null;
  const r = (await res.json().catch(() => ({})))?.result;
  const dpv = r?.uspsData?.dpvConfirmation || '';
  const next = r?.verdict?.possibleNextAction || '';
  if (dpv === 'Y') return 'confirmed';
  if (dpv === 'D' || dpv === 'S' || next === 'CONFIRM_ADD_SUBPREMISES') return 'unit';
  if (dpv === 'N' || next === 'FIX') return 'check';
  // Matched no further than the street (a house number that doesn't exist): there was nothing for the
  // Postal Service to confirm, so it doesn't know this address
  const grain = r?.verdict?.validationGranularity || '';
  if (r && !dpv && grain && !['PREMISE', 'SUB_PREMISE'].includes(grain)) return 'check';
  return null;
}
