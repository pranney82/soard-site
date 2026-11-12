/**
 * Where a home is, from Esri (ArcGIS Location Platform's geocoding)
 * ===========================================================================
 * The family enters their address (Google's suggestions, the Postal Service's check); this only
 * finds where that house is, so the service-area check can measure it. Esri has the houses the
 * Census doesn't (the Census knows no Copper Ridge Dr in Loganville at all, and answered with a
 * different street ten miles away). Google has them too, but its terms forbid using its places
 * to decide whether a point is inside an area; Esri's allow it.
 *
 * Credentials: the Cloudflare secrets ESRI_CLIENT_ID and ESRI_CLIENT_SECRET ("SOARD website", OAuth
 * 2.0 credentials for app authentication, in SOARD's ArcGIS Location Platform account). The server
 * signs in with them for a two-week pass and gets a new one by itself, so nothing ever expires
 * for a person to replace.
 *
 * Esri's terms shape the request: forStorage=true (only stored results may be kept and used for the
 * check; about $4 per 1,000, billed to SOARD's pay-as-you-go), one result per address, and "Powered
 * by Esri" wherever its answer shows. A monthly limit keeps the bill small; past it, and whenever
 * Esri can't be asked, the Census and OpenStreetMap carry on (./_geo.js), for the house typed only.
 */
import { sameHouse } from '../../public/admin/area-shared.js';
import { sendEmails } from './_broadcast-notify.js';
import { ALERT_EMAILS } from './_applications.js';

const TOKEN_URL = 'https://www.arcgis.com/sharing/rest/oauth2/token';
const GEOCODE_URL = 'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
export const ESRI_MONTHLY = 1000; // stored lookups a month: about $4 at most
const TWO_WEEKS_MINUTES = 20160;
// The house itself (its point, or its unit), or its place along its own street from the street's numbers
const HOUSE_TYPES = new Set(['PointAddress', 'Subaddress', 'StreetAddress']);
const MIN_SCORE = 80;

export const esriOn = (env) => !!(env?.ESRI_CLIENT_ID && env?.ESRI_CLIENT_SECRET);

// ── The pass (an access token, two weeks) ────────────────────────────────

let memo = null; // { id, token, exp } for this worker
const ready = new WeakSet();
async function tables(DB) {
  if (!DB || ready.has(DB)) return;
  await DB.batch([
    DB.prepare('CREATE TABLE IF NOT EXISTS esri_pass (id TEXT PRIMARY KEY, token TEXT NOT NULL, exp INTEGER NOT NULL)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS esri_usage (month TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)'),
  ]);
  ready.add(DB);
}

/** A pass good for at least another hour: this worker's, the database's, else a new one from Esri */
async function esriToken(env, fetchImpl, { fresh = false, now = Date.now() } = {}) {
  const id = String(env.ESRI_CLIENT_ID);
  const good = (p) => p && p.id === id && p.exp - now > 3600e3;
  if (!fresh && good(memo)) return memo.token;
  if (!fresh && env.DB) {
    await tables(env.DB);
    const row = await env.DB.prepare('SELECT id, token, exp FROM esri_pass WHERE id = ?').bind(id).first();
    if (good(row)) { memo = row; return row.token; }
  }
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: id, client_secret: String(env.ESRI_CLIENT_SECRET), grant_type: 'client_credentials', expiration: String(TWO_WEEKS_MINUTES), f: 'json' }),
    signal: AbortSignal.timeout(6000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) throw new Error(`Esri sign-in failed${j?.error?.message ? `: ${j.error.message}` : ` (${res.status})`}`);
  memo = { id, token: String(j.access_token), exp: now + Math.max(60, Number(j.expires_in) || 7200) * 1000 };
  if (env.DB) {
    await tables(env.DB);
    await env.DB.prepare('INSERT OR REPLACE INTO esri_pass (id, token, exp) VALUES (?, ?, ?)').bind(memo.id, memo.token, memo.exp).run();
  }
  return memo.token;
}

/** Forget the pass (Esri turned it down: replaced, or the credentials changed) */
async function dropToken(env) {
  memo = null;
  if (env.DB) await env.DB.prepare('DELETE FROM esri_pass').run().catch(() => {});
}

// ── The monthly limit ───────────────────────────────────────────────────

const monthOf = (d) => d.toISOString().slice(0, 7);
/** One more lookup this month if it's inside the limit (Peter hears at 80% and when it runs out) */
export async function spendEsri(env, now = new Date()) {
  if (!env?.DB) return true;
  await tables(env.DB);
  const row = await env.DB.prepare('INSERT INTO esri_usage (month, n) VALUES (?, 1) ON CONFLICT(month) DO UPDATE SET n = n + 1 RETURNING n').bind(monthOf(now)).first();
  const n = Number(row?.n || 0);
  if (n === Math.ceil(ESRI_MONTHLY * 0.8)) await tellPeter(env, 'near', n, now);
  else if (n === ESRI_MONTHLY + 1) await tellPeter(env, 'out', ESRI_MONTHLY, now);
  return n <= ESRI_MONTHLY;
}
/** This month's lookups so far */
export async function usedEsri(DB, now = new Date()) {
  if (!DB) return 0;
  await tables(DB);
  return Number((await DB.prepare('SELECT n FROM esri_usage WHERE month = ?').bind(monthOf(now)).first())?.n || 0);
}

async function tellPeter(env, stage, n, now) {
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const cap = ESRI_MONTHLY.toLocaleString('en-US');
  const subject = stage === 'near'
    ? 'Esri home lookups: 80% of this month’s limit'
    : 'Esri home lookups: this month’s limit reached';
  const lines = stage === 'near'
    ? [
      `The application has used ${n.toLocaleString('en-US')} of the ${cap} Esri lookups it allows itself this month to find where families’ homes are. Each costs about $0.004, so the most a month can cost is about $4.`,
      `At ${cap}, the Census finds homes instead until ${nextMonth} (free, but it doesn’t know every house; a home it can’t find is answered by the family). Nothing for you to do.`,
    ]
    : [
      `The application used all ${cap} Esri lookups it allows itself this month, so the Census finds homes instead until ${nextMonth}. Families can still apply as normal.`,
      `If this happens often, the limit (ESRI_MONTHLY) lives in functions/api/_esri.js; each 1,000 more costs about $4.`,
    ];
  const text = `${lines.join('\n\n')}\n\nSent by sunshineonaranneyday.com`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#373A36">${lines.map(l => `<p>${l}</p>`).join('')}<p style="color:#6B6C70;font-size:13px">Sent by sunshineonaranneyday.com</p></div>`;
  try { await sendEmails(env, { to: ALERT_EMAILS, subject, html, text, tags: [{ name: 'type', value: 'esri-usage' }] }); } catch { /* the count goes on */ }
}

// ── The lookup ──────────────────────────────────────────────────────────

/**
 * A lookup for ./_geo.js's geocode(): (one-line address) → { lat, lng, county, matched, source:
 * 'esri', accuracy } for the house typed, null when Esri doesn't have that house (only the street,
 * the town, or another number), and a throw when Esri can't be asked (so the Census is asked
 * instead). null without credentials: Esri isn't part of the check yet.
 */
export function esriLocator(env, fetchImpl = fetch) {
  if (!esriOn(env)) return null;
  return async (oneLine, notes = {}) => {
    const q = String(oneLine || '').trim().slice(0, 300);
    if (!q) return null;
    if (!(await spendEsri(env))) throw new Error('This month’s Esri lookups are used');
    const ask = async (token) => {
      const u = new URL(GEOCODE_URL);
      u.search = new URLSearchParams({
        SingleLine: q, countryCode: 'USA', forStorage: 'true', maxLocations: '1',
        outFields: 'Addr_type,StAddr,Subregion,Score', f: 'json',
      }).toString();
      const r = await fetchImpl(u.href, { headers: { 'X-Esri-Authorization': `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
      const body = await r.text();
      let j = null;
      try { j = JSON.parse(body); } catch { /* not JSON */ }
      if (!r.ok && !j?.error) throw new Error(`Esri returned ${r.status}${body ? `: ${body.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
      return j || {};
    };
    let j = await ask(await esriToken(env, fetchImpl));
    // A pass Esri no longer takes (498 invalid, 499 missing): a new one, once
    if ([498, 499].includes(Number(j?.error?.code))) {
      await dropToken(env);
      j = await ask(await esriToken(env, fetchImpl, { fresh: true }));
    }
    if (j?.error) throw new Error(`Esri: ${[j.error.message || j.error.code, ...(Array.isArray(j.error.details) ? j.error.details : [])].filter(Boolean).join(' ')}`);
    const c = (j?.candidates || [])[0];
    const at = c?.attributes || {};
    const lat = Number(c?.location?.y);
    const lng = Number(c?.location?.x);
    if (!c || !Number.isFinite(lat) || !Number.isFinite(lng)) { notes.esri = 'Esri found nothing for this address'; return null; }
    // Only the house typed: its own point, or its place along its own street, at the same number
    const found = `${at.Addr_type || 'a place'}${at.StAddr || c.address ? ` (${at.StAddr || c.address})` : ''}`;
    if (!HOUSE_TYPES.has(at.Addr_type) || Number(at.Score ?? c.score) < MIN_SCORE) { notes.esri = `Esri found only ${found}`; return null; }
    if (!sameHouse(q.split(',')[0], at.StAddr || String(c.address || '').split(',')[0])) { notes.esri = `Esri found another house: ${found}`; return null; }
    return {
      lat, lng,
      county: String(at.Subregion || '').replace(/\s+County$/i, '').trim() || null,
      matched: String(c.address || '').toUpperCase() || null,
      source: 'esri',
      accuracy: at.Addr_type,
    };
  };
}

/** Forget this worker's pass (tests) */
export function resetEsri() { memo = null; }
