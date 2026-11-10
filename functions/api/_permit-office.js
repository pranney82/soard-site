/**
 * Who issues the building permits for each home (JobTread's Permitting Municipality)
 * ===========================================================================
 * Two questions, answered apart:
 *
 *  1. Which government is the home under? Inside a city's limits, the city;
 *     outside them, the county. ZIP codes and mailing towns don't say which (a
 *     "Woodstock, GA" address can be in unincorporated Cherokee County), so the
 *     site asks the U.S. Census Bureau's map, by the home's map point (JobTread
 *     geocodes every location): free, no key, and no address is sent. That's
 *     the home's jurisdiction ("City of Woodstock", "Cobb County").
 *  2. Who issues building permits there? Usually the jurisdiction itself, but
 *     some small towns have their county do it. In order:
 *       - what staff taught it: when staff change a home's Permitting
 *         Municipality in JobTread, every other home in that town follows,
 *         now and later (one correction per town; change it back to undo).
 *         Two different corrections in one town teach nothing until they agree.
 *       - VERIFIED: each town and county SOARD has homes in, checked against
 *         its own permit pages, with the source and the date;
 *       - else the jurisdiction itself, and the town shows on Site →
 *         Automations as needing a look, so nothing is guessed silently.
 *
 * The answer goes into JobTread, on the location's Permitting Municipality
 * field (made the first time, after County), so JobTread stays the record and
 * the kid's Home card and Insights show it (public/admin/home-shared.js).
 *
 *  - The site only changes a value it wrote itself. What staff type stays.
 *  - A home whose map point sits within about 35 meters of another
 *    jurisdiction's line (JobTread's point can land on the street, and city
 *    lines often run down streets) is marked: the kid's Home card says which
 *    line and to confirm with the permit office (permitNote, /api/job-home),
 *    and Site → Automations counts them. Four extra points are asked, once.
 *  - A home is looked up again when its map point moves and every 90 days
 *    (cities annex land; the Census redraws city limits once a year).
 *  - permit_offices (D1) remembers, per home, the jurisdiction, the office the
 *    site wrote, the point and when. permit_state keeps the field's id and the
 *    last turn's summary for Site → Automations (permitFacts).
 *  - Runs on the applicant sync (./_applicants.js maybeSyncApplicants), its own
 *    turn every 10 minutes, a few homes a turn, so the Census is asked gently.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';
import { VERIFIED } from './_permit-offices-verified.js';

export { VERIFIED };

export const PERMIT_FIELD_NAME = 'Permitting Municipality';
const COUNTY_FIELD = '22PK2MzzJD93';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';
// Census lookups and JobTread writes, together, in one turn
export const PER_TURN = 20;
const PAGE = 100;
// A point that moved less than this (about 50 meters) is the same home
const SAME_SPOT = 0.0005;
// How long a looked-up answer stands before it's checked again (annexations; the Census's yearly redraw)
export const RECHECK_MS = 90 * 24 * 60 * 60 * 1000;
// How close another jurisdiction's line has to be to mention it (a rooftop sits about this far from the street)
export const NEAR_M = 35;
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
  // The jurisdiction (added with the verified list): rows from before it wrote the jurisdiction itself
  try { await DB.prepare('ALTER TABLE permit_offices ADD COLUMN jurisdiction TEXT').run(); } catch { /* already there */ }
  // Other jurisdictions within NEAR_M (a JSON list; null until checked)
  try { await DB.prepare('ALTER TABLE permit_offices ADD COLUMN near TEXT').run(); } catch { /* already there */ }
  await DB.prepare('UPDATE permit_offices SET jurisdiction = office WHERE jurisdiction IS NULL').run();
  _ready.add(DB);
}
const getState = async (DB, key) => (await DB.prepare('SELECT value FROM permit_state WHERE key = ?').bind(key).first())?.value ?? null;
const setState = (DB, key, value, now = Date.now()) => DB.prepare('INSERT INTO permit_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
  .bind(key, value == null ? null : String(value), iso(now)).run();

/**
 * The jurisdiction from the Census's answer: "City of Woodstock" (a city, town or village with its own
 * government, FUNCSTAT A), "Augusta-Richmond County consolidated government" (a consolidated city-county),
 * else the county ("Cobb County"). null when the point isn't in a U.S. county.
 */
export function jurisdictionFrom(geographies) {
  const place = (geographies?.['Incorporated Places'] || []).find((p) => p?.FUNCSTAT === 'A' && p.NAME);
  if (place) {
    const name = String(place.NAME).replace(/\s*\(balance\)\s*$/i, '').trim();
    const m = name.match(/^(.*\S)\s+(city|town|village)$/i);
    return m ? `${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()} of ${m[1]}` : name;
  }
  const county = (geographies?.Counties || [])[0];
  return county?.NAME ? String(county.NAME).trim() : null;
}
/** The Census's answer for a map point: { jurisdiction } (null outside any county). Throws when the Census can't be asked. */
export async function jurisdictionAt(lat, lng, fetchImpl = fetch) {
  const url = `${CENSUS}?x=${encodeURIComponent(lng)}&y=${encodeURIComponent(lat)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=${encodeURIComponent('Incorporated Places,Counties')}&format=json`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`The Census map returned ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data?.result?.geographies) throw new Error('The Census map didn’t answer');
  return { jurisdiction: jurisdictionFrom(data.result.geographies) };
}

/**
 * Other jurisdictions within NEAR_M of a point: the Census asked about four points that far north, south, east
 * and west. [] when the home sits well inside its own.
 */
export async function nearLines(lat, lng, here, fetchImpl = fetch) {
  const dLat = NEAR_M / 111320;
  const dLng = NEAR_M / (111320 * Math.cos((lat * Math.PI) / 180));
  const around = [[lat + dLat, lng], [lat - dLat, lng], [lat, lng + dLng], [lat, lng - dLng]];
  const found = await Promise.all(around.map(([a, b]) => jurisdictionAt(a, b, fetchImpl).then((r) => r.jurisdiction)));
  return [...new Set(found.filter((j) => j && j !== here))].sort();
}

/**
 * Who issues permits in a jurisdiction: { office, why } where why is 'taught' (staff's correction), 'verified'
 * (VERIFIED), or 'unconfirmed' (the jurisdiction itself, not checked yet).
 */
export function officeFor(jurisdiction, taught = new Map()) {
  const t = taught.get(jurisdiction);
  if (t && !t.conflict) return { office: t.office, why: 'taught' };
  if (VERIFIED[jurisdiction]) return { office: VERIFIED[jurisdiction].office, why: 'verified' };
  return { office: jurisdiction, why: 'unconfirmed' };
}

/**
 * What staff have taught, from JobTread as it is now: in each jurisdiction, homes whose Permitting Municipality
 * staff changed from what the site wrote. One value across them is the town's office; two or more disagree (a
 * conflict, which teaches nothing). Map jurisdiction → { office, homes } | { conflict: [values] }.
 */
export function learnFromStaff(homes, written) {
  const by = new Map();
  for (const h of homes) {
    const w = written.get(h.id);
    if (!w?.jurisdiction || !h.value || h.value === w.office) continue;
    const list = by.get(w.jurisdiction) || [];
    list.push(h.value);
    by.set(w.jurisdiction, list);
  }
  const out = new Map();
  for (const [j, values] of by) {
    const distinct = [...new Set(values)];
    out.set(j, distinct.length === 1 ? { office: distinct[0], homes: values.length } : { conflict: distinct.sort() });
  }
  return out;
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
 * What each home needs this turn: 'lookup' (ask the Census: a blank never looked up, a moved home, or one due
 * its 90-day check), 'write' (the jurisdiction is known and the office it should say changed, e.g. staff taught
 * the town), or nothing. Never a home whose value staff changed. Blanks first.
 */
export function plan(homes, written, taught = new Map(), now = Date.now()) {
  const moved = (w, h) => Math.abs(w.lat - h.lat) > SAME_SPOT || Math.abs(w.lng - h.lng) > SAME_SPOT;
  const due = (w) => !(Date.parse(w.written_at) > now - RECHECK_MS);
  const out = [];
  for (const h of homes) {
    if (h.lat == null || h.lng == null) continue;
    const w = written.get(h.id);
    const ours = !h.value || (w && h.value === w.office);
    if (!ours) continue;
    if (!w || moved(w, h) || due(w)) {
      // Looked up already and the Census put it in no county (a point outside the U.S.): not again until it moves or it's due
      if (w && w.jurisdiction == null && !h.value && !moved(w, h) && !due(w)) continue;
      out.push({ ...h, need: 'lookup' });
      continue;
    }
    if (!w.jurisdiction) continue;
    // Looked up before the near-the-line check existed: once more, for it
    if (w.near == null) { out.push({ ...h, need: 'lookup' }); continue; }
    const want = officeFor(w.jurisdiction, taught).office;
    if (want !== h.value) out.push({ ...h, need: 'write', jurisdiction: w.jurisdiction, office: want });
  }
  return out.sort((a, b) => (a.value ? 1 : 0) - (b.value ? 1 : 0));
}

/**
 * One turn: make sure the field is there, read every home, learn from staff's corrections, then look up and
 * write a few homes. Returns the turn's summary (also kept for Site → Automations). A Census or JobTread failure
 * stops the turn and is kept; the next turn tries again.
 */
export async function fillPermitOffices(env, { fetchImpl = fetch, now = Date.now(), limit = PER_TURN } = {}) {
  const { DB } = env;
  await ensureSchema(DB);
  try {
    const field = await ensurePermitField(env, { fetchImpl, now });
    const homes = await readHomes(env, field.id, fetchImpl);
    const { results } = await DB.prepare('SELECT location_id, lat, lng, office, jurisdiction, near, written_at FROM permit_offices').all();
    const written = new Map((results || []).map((r) => [r.location_id, r]));
    const taught = learnFromStaff(homes, written);
    const todo = plan(homes, written, taught, now);
    let filled = 0;
    const save = (h, jurisdiction, office, near) => DB.prepare(`INSERT INTO permit_offices (location_id, lat, lng, office, jurisdiction, near, written_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(location_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, office = excluded.office, jurisdiction = excluded.jurisdiction, near = excluded.near, written_at = excluded.written_at`)
      .bind(h.id, h.lat, h.lng, office, jurisdiction, near, iso(now)).run();
    for (const h of todo.slice(0, limit)) {
      let { jurisdiction } = h;
      let office = h.office;
      let near = written.get(h.id)?.near ?? null;
      if (h.need === 'lookup') {
        ({ jurisdiction } = await jurisdictionAt(h.lat, h.lng, fetchImpl));
        office = jurisdiction ? officeFor(jurisdiction, taught).office : null;
        near = JSON.stringify(jurisdiction ? await nearLines(h.lat, h.lng, jurisdiction, fetchImpl) : []);
      }
      if (office && office !== h.value) {
        // updateLocation answers with nothing to select
        await pave(env.JOBTREAD_GRANT_KEY, { updateLocation: { $: { id: h.id, customFieldValues: { [field.id]: office } } } }, fetchImpl);
        filled++;
      }
      await save(h, jurisdiction, office, near);
      written.set(h.id, { location_id: h.id, lat: h.lat, lng: h.lng, office, jurisdiction, near, written_at: iso(now) });
    }
    // Each town and county with homes: how many, what they say, and why (counts and names of places only)
    const towns = new Map();
    for (const h of homes) {
      const j = written.get(h.id)?.jurisdiction;
      if (!j) continue;
      const t = towns.get(j) || { jurisdiction: j, homes: 0, ...officeFor(j, taught) };
      t.homes++;
      towns.set(j, t);
    }
    const summary = {
      at: iso(now), homes: homes.length, filled, made: field.made,
      waiting: Math.max(0, todo.length - Math.min(limit, todo.length)),
      withOffice: homes.filter((h) => h.value || written.get(h.id)?.office).length,
      unplaced: homes.filter((h) => h.lat == null || h.lng == null).length,
      towns: [...towns.values()].sort((a, b) => b.homes - a.homes || a.jurisdiction.localeCompare(b.jurisdiction)),
      taught: [...taught].filter(([, t]) => !t.conflict).map(([jurisdiction, t]) => ({ jurisdiction, office: t.office, homes: t.homes })),
      conflicts: [...taught].filter(([, t]) => t.conflict).map(([jurisdiction, t]) => ({ jurisdiction, values: t.conflict })),
      // Homes within NEAR_M of another jurisdiction's line, by place (no addresses)
      nearLine: nearSummary(homes, written),
      nearChecked: homes.filter((h) => written.get(h.id)?.near != null).length,
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

function nearSummary(homes, written) {
  const by = new Map();
  for (const h of homes) {
    const w = written.get(h.id);
    let near = [];
    try { near = JSON.parse(w?.near || '[]') || []; } catch { /* unreadable: none */ }
    if (!w?.jurisdiction || !near.length) continue;
    const key = `${w.jurisdiction}|${near.join('|')}`;
    const row = by.get(key) || { jurisdiction: w.jurisdiction, near, homes: 0 };
    row.homes++;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => b.homes - a.homes || a.jurisdiction.localeCompare(b.jurisdiction));
}

/** For a kid's Home card: the home's jurisdiction and any line within NEAR_M, or null when the site hasn't looked it up */
export async function permitNote(DB, locationId) {
  if (!DB || !locationId) return null;
  await ensureSchema(DB);
  const r = await DB.prepare('SELECT jurisdiction, office, near FROM permit_offices WHERE location_id = ?').bind(locationId).first();
  if (!r) return null;
  let near = [];
  try { near = JSON.parse(r.near || '[]') || []; } catch { /* unreadable: none */ }
  return { jurisdiction: r.jurisdiction, office: r.office, near, meters: NEAR_M };
}

/** For Site → Automations: the last turn's summary, when a home was last filled, and any failure (place names and counts only) */
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
