/**
 * Homes, from JobTread
 * ===========================================================================
 * A family's home is a JobTread location. Its custom fields (Zestimate, Living
 * Area, Bed Bath, Year Built, County, Sewer/Septic and whatever staff add) are
 * filled by DataX's Zillow lookup and by staff, in JobTread. The site only
 * reads them; JobTread stays the record.
 *
 *  - locationFields: the location fields themselves (id, name, type, order),
 *    cached ten minutes. The applicants mirror (./_applicants.js) keeps a copy
 *    for Insights, so Insights never waits on JobTread.
 *  - jobHome: a makeover job's home and its values, read live for the Home
 *    card in Admin → Kids (/api/job-home).
 *
 * How each field reads (money, years, square feet, which leads) is in
 * public/admin/home-shared.js, shared with the admin.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';

// A home's values: one per field (a multiple-choice field has one per choice). JobTread allows up to 100.
export const HOME_VALUES = 100;
export const FIELDS_QUERY = {
  $: { size: 100, where: ['targetType', '=', 'location'] },
  nodes: { id: {}, name: {}, type: {}, position: {}, options: {} },
};
export const jobtreadLocationUrl = (id) => `https://app.jobtread.com/locations/${encodeURIComponent(id)}`;
const JOB_ID = /^[A-Za-z0-9]{6,40}$/;
// JobTread gets this long to answer the Home card's read (the admin waits a little longer, then offers Try again)
const WAIT_MS = 12000;
/** fetch with a time limit */
const timed = (fetchImpl) => (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(WAIT_MS) });

/** JobTread's field nodes, tidied: { id, name, type, position, options? } */
export function cleanFields(nodes) {
  return (nodes || []).filter((f) => f?.id && f.name).map((f) => ({
    id: f.id, name: String(f.name), type: f.type || 'text', position: f.position ?? null,
    ...(Array.isArray(f.options) ? { options: f.options } : {}),
  }));
}

/** A location's values by field id (a multiple-choice field's become a list) */
export function valuesOf(location) {
  const out = {};
  for (const v of location?.customFieldValues?.nodes || []) {
    const id = v?.customField?.id;
    if (!id || v.value == null || v.value === '') continue;
    out[id] = id in out ? [].concat(out[id], v.value) : v.value;
  }
  return out;
}

let _fields = null; // { at, fields }
/** Every location field in SOARD's JobTread */
export async function locationFields(env, { fetchImpl = fetch, now = Date.now(), fresh = false } = {}) {
  if (!fresh && _fields && now - _fields.at < 10 * 60 * 1000) return _fields.fields;
  const data = await pave(env.JOBTREAD_GRANT_KEY, { organization: { $: { id: SOARD_ORG_ID }, customFields: FIELDS_QUERY } }, fetchImpl);
  const fields = cleanFields(data?.organization?.customFields?.nodes);
  _fields = { at: now, fields };
  return fields;
}
/** For tests: forget the cached fields */
export const forgetLocationFields = () => { _fields = null; };

/**
 * A makeover job's home: { job: { id, name }, home: { id, street, address, city, state, postalCode, url, values } | null, fields }.
 * The fields come in the same request when they aren't cached.
 */
export async function jobHome(env, jobId, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!JOB_ID.test(String(jobId || ''))) throw Object.assign(new Error('That isn’t a JobTread job'), { status: 400 });
  if (!env.JOBTREAD_GRANT_KEY) throw Object.assign(new Error('JobTread isn’t connected'), { status: 503 });
  const cached = _fields && now - _fields.at < 10 * 60 * 1000 ? _fields.fields : null;
  let data;
  try {
    data = await pave(env.JOBTREAD_GRANT_KEY, {
      job: {
        $: { id: jobId },
        id: {}, name: {},
        organization: { id: {} },
        location: {
          id: {}, street: {}, address: {}, formattedAddress: {}, city: {}, state: {}, postalCode: {},
          customFieldValues: { $: { size: HOME_VALUES }, nodes: { value: {}, customField: { id: {} } } },
        },
      },
      ...(cached ? {} : { organization: { $: { id: SOARD_ORG_ID }, customFields: FIELDS_QUERY } }),
    }, timed(fetchImpl));
  } catch (e) {
    // The admin says this in plain words; the detail is for the logs
    console.error('[job-home]', e?.message || e);
    throw Object.assign(new Error('JobTread didn’t answer'), { status: 500 });
  }
  const job = data?.job;
  if (!job?.id || (job.organization?.id && job.organization.id !== SOARD_ORG_ID)) throw Object.assign(new Error('JobTread has no such job'), { status: 404 });
  let fields = cached;
  if (!fields) {
    fields = cleanFields(data?.organization?.customFields?.nodes);
    _fields = { at: now, fields };
  }
  const loc = job.location;
  return {
    job: { id: job.id, name: job.name || '' },
    home: loc?.id ? {
      id: loc.id,
      // The street on one line, the town on the next (or JobTread's whole address when it has no street;
      // never the location's name, which staff can call anything)
      street: loc.street || '',
      address: loc.formattedAddress || loc.address || '',
      city: loc.city || '',
      state: loc.state || '',
      postalCode: loc.postalCode || '',
      url: jobtreadLocationUrl(loc.id),
      values: valuesOf(loc),
    } : null,
    fields,
  };
}
