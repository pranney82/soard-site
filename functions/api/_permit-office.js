/**
 * Who issues the building permits for each home (JobTread's Permitting Municipality)
 * ===========================================================================
 * In Georgia a city issues building permits inside its city limits; outside
 * them, the county does. ZIP codes and mailing towns don't say which (a
 * "Woodstock, GA" address can be in unincorporated Cherokee County), so the
 * site asks the U.S. Census Bureau's map, by the home's map point (JobTread
 * geocodes every location), which city limits and county it's in. Free, no
 * key, and no address is sent: only the point.
 *
 *  - The answer goes into JobTread, on the location's "Permitting
 *    Municipality" field ("City of Woodstock", or "Cobb County" outside any
 *    city), so JobTread stays the record and the kid's Home card and Insights
 *    show it like any other home field (public/admin/home-shared.js).
 *  - The field is made in JobTread the first time (right after County) and
 *    found again by the id kept in D1, or by its name.
 *  - Only blanks are filled. A value staff typed is never changed. A value
 *    the site wrote is looked up again when the home's map point moves (an
 *    address fixed) and every 90 days, since cities annex land and the
 *    Census redraws city limits once a year; one staff changed is left
 *    alone. permit_offices (D1) remembers what the site wrote, for which
 *    point and when.
 *  - Runs on the applicant sync (./_applicants.js maybeSyncApplicants), its
 *    own turn every 10 minutes, a few homes a turn, so the Census is asked
 *    gently. Site → Automations shows how it's going (permitFacts).
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';

export const PERMIT_FIELD_NAME = 'Permitting Municipality';
const COUNTY_FIELD = '22PK2MzzJD93';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';
export const PER_TURN = 20;
const PAGE = 100;
// A point that moved less than this (about 50 meters) is the same home
const SAME_SPOT = 0.0005;
// How long a looked-up answer stands before it's checked again (annexations; the Census's yearly redraw)
export const RECHECK_MS = 90 * 24 * 60 * 60 * 1000;
const iso = (t = Date.now()) => new Date(t).toISOString();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS permit_offices (
    location_id TEXT PRIMARY KEY, lat REAL, lng REAL, office TEXT, written_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS permit_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)`,
];
const _ready = new WeakSet();
async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  _ready.add(DB);
}
const getState = async (DB, key) => (await DB.prepare('SELECT value FROM permit_state WHERE key = ?').bind(key).first())?.value ?? null;
const setState = (DB, key, value, now = Date.now()) => DB.prepare('INSERT INTO permit_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
  .bind(key, value == null ? null : String(value), iso(now)).run();

/**
 * The permitting office from the Census's answer: "City of Woodstock" (a city, town or village with its own
 * government, FUNCSTAT A), "Augusta-Richmond County consolidated government" (a consolidated city-county),
 * else the county ("Cobb County"). null when the point isn't in a U.S. county.
 */
export function officeFrom(geographies) {
  const place = (geographies?.['Incorporated Places'] || []).find((p) => p?.FUNCSTAT === 'A' && p.NAME);
  if (place) {
    const name = String(place.NAME).replace(/\s*\(balance\)\s*$/i, '').trim();
    const m = name.match(/^(.*\S)\s+(city|town|village)$/i);
    return m ? `${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()} of ${m[1]}` : name;
  }
  const county = (geographies?.Counties || [])[0];
  return county?.NAME ? String(county.NAME).trim() : null;
}

/** The Census's answer for a map point: { office } (null office outside any county). Throws when the Census can't be asked. */
export async function permitOfficeAt(lat, lng, fetchImpl = fetch) {
  const url = `${CENSUS}?x=${encodeURIComponent(lng)}&y=${encodeURIComponent(lat)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=${encodeURIComponent('Incorporated Places,Counties')}&format=json`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`The Census map returned ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data?.result?.geographies) throw new Error('The Census map didn’t answer');
  return { office: officeFrom(data.result.geographies) };
}

/**
 * The field's id in JobTread: the one the site made (kept in D1) if it's still there, else one named
 * Permitting Municipality, else a new text field right after County.
 */
export async function ensurePermitField(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    organization: { $: { id: SOARD_ORG_ID }, customFields: { $: { size: 100, where: ['targetType', '=', 'location'] }, nodes: { id: {}, name: {} } } },
  }, fetchImpl);
  const fields = data?.organization?.customFields?.nodes || [];
  const kept = await getState(DB, 'field_id');
  const found = fields.find((f) => f.id === kept) || fields.find((f) => String(f.name || '').trim().toLowerCase() === PERMIT_FIELD_NAME.toLowerCase());
  if (found) {
    if (found.id !== kept) await setState(DB, 'field_id', found.id, now);
    return { id: found.id, made: false };
  }
  const made = await pave(env.JOBTREAD_GRANT_KEY, {
    createCustomField: {
      $: {
        organizationId: SOARD_ORG_ID, name: PERMIT_FIELD_NAME, targetType: 'location', type: 'text', minValuesRequired: 0, maxValuesAllowed: 1,
        ...(fields.some((f) => f.id === COUNTY_FIELD) ? { positionAfterCustomFieldId: COUNTY_FIELD } : {}),
      },
      createdCustomField: { id: {} },
    },
  }, fetchImpl);
  const id = made?.createCustomField?.createdCustomField?.id;
  if (!id) throw new Error('JobTread didn’t make the Permitting Municipality field');
  await setState(DB, 'field_id', id, now);
  return { id, made: true };
}

/** Every customer home in JobTread with its map point and its Permitting Municipality value (TEST accounts left out) */
async function readHomes(env, fieldId, fetchImpl) {
  const out = [];
  let page = null;
  for (let i = 0; i < 20; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: {
        $: { id: SOARD_ORG_ID },
        locations: {
          $: { size: PAGE, where: [['account', 'type'], '=', 'customer'], sortBy: [{ field: 'createdAt', order: 'desc' }], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, latitude: {}, longitude: {}, account: { name: {} },
            customFieldValues: { $: { size: 1, where: [['customField', 'id'], '=', fieldId] }, nodes: { value: {} } },
          },
        },
      },
    }, fetchImpl);
    const conn = data?.organization?.locations;
    for (const l of conn?.nodes || []) {
      if (/^\s*test\b/i.test(l.account?.name || '')) continue;
      const lat = Number(l.latitude);
      const lng = Number(l.longitude);
      out.push({ id: l.id, lat: l.latitude == null || !Number.isFinite(lat) ? null : lat, lng: l.longitude == null || !Number.isFinite(lng) ? null : lng, value: String(l.customFieldValues?.nodes?.[0]?.value ?? '').trim() });
    }
    page = conn?.nextPage || null;
    if (!page) break;
  }
  return out;
}

/**
 * Which homes need a lookup: a blank one with a map point, or one whose value the site wrote for a point
 * that has since moved. A value staff typed (different from what the site wrote) is left alone.
 */
export function homesToLookUp(homes, written, now = Date.now()) {
  const moved = (w, h) => Math.abs(w.lat - h.lat) > SAME_SPOT || Math.abs(w.lng - h.lng) > SAME_SPOT;
  const due = (w) => !(Date.parse(w.written_at) > now - RECHECK_MS);
  const order = (h) => (!h.value ? 0 : 1); // blanks first, then re-checks
  return homes.filter((h) => {
    if (h.lat == null || h.lng == null) return false;
    const w = written.get(h.id);
    // Looked up already and the Census put it in no county (a point outside the U.S.): not again until it moves or it's due
    if (!h.value) return !(w && w.office == null && !moved(w, h) && !due(w));
    if (!w || w.office !== h.value) return false;
    return moved(w, h) || due(w);
  }).sort((a, b) => order(a) - order(b));
}

/**
 * One turn: make sure the field is there, read every home, look up a few that need it and write each
 * answer to JobTread. Returns { homes, filled, waiting, unplaced, made }. A Census or JobTread failure
 * stops the turn and is kept for Site → Automations; the next turn tries again.
 */
export async function fillPermitOffices(env, { fetchImpl = fetch, now = Date.now(), limit = PER_TURN } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  try {
    const field = await ensurePermitField(env, { fetchImpl, now });
    const homes = await readHomes(env, field.id, fetchImpl);
    const { results } = await DB.prepare('SELECT location_id, lat, lng, office, written_at FROM permit_offices').all();
    const written = new Map((results || []).map((r) => [r.location_id, r]));
    const todo = homesToLookUp(homes, written, now);
    let filled = 0;
    for (const h of todo.slice(0, limit)) {
      const { office } = await permitOfficeAt(h.lat, h.lng, fetchImpl);
      if (office && office !== h.value) {
        // updateLocation answers with nothing to select
        await pave(env.JOBTREAD_GRANT_KEY, { updateLocation: { $: { id: h.id, customFieldValues: { [field.id]: office } } } }, fetchImpl);
        filled++;
      }
      await DB.prepare('INSERT INTO permit_offices (location_id, lat, lng, office, written_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, office = excluded.office, written_at = excluded.written_at')
        .bind(h.id, h.lat, h.lng, office, iso(now)).run();
    }
    const summary = {
      at: iso(now), homes: homes.length, filled, made: field.made,
      waiting: Math.max(0, todo.length - Math.min(limit, todo.length)),
      withOffice: homes.filter((h) => h.value).length + filled,
      unplaced: homes.filter((h) => h.lat == null || h.lng == null).length,
    };
    await setState(DB, 'last_run', JSON.stringify(summary), now);
    if (filled) await setState(DB, 'last_filled_at', iso(now), now);
    await DB.prepare("DELETE FROM permit_state WHERE key = 'last_error'").run();
    return summary;
  } catch (e) {
    await setState(DB, 'last_error', `${iso(now)} ${String(e.message || e).slice(0, 300)}`, now).catch(() => {});
    return { error: e.message };
  }
}

/** For Site → Automations: the last turn's counts, when a home was last filled, and any failure (counts and times only) */
export async function permitFacts(DB) {
  await ensureSchema(DB);
  const { results } = await DB.prepare("SELECT key, value, updated_at FROM permit_state WHERE key IN ('last_run', 'last_filled_at', 'last_error', 'field_id')").all();
  const m = Object.fromEntries((results || []).map((r) => [r.key, r]));
  let run = null;
  try { run = m.last_run?.value ? JSON.parse(m.last_run.value) : null; } catch { /* unreadable: treated as never run */ }
  const err = m.last_error?.value || '';
  return {
    run,
    fieldId: m.field_id?.value || null,
    lastFilledAt: m.last_filled_at?.value || null,
    error: err ? { at: err.split(' ')[0], message: err.split(' ').slice(1).join(' ') } : null,
  };
}
