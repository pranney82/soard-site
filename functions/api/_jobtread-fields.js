/**
 * JobTread fields a new application question can fill (Admin → Applications → Form)
 * ===========================================================================
 * The SOARD customer (account) and location custom fields, minus the ones
 * the site already fills from the built-in questions. Cached for ten minutes.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';

// Filled by the site already (./_applications.js accountFields, the location's
// County) or by other automations (DataX Zillow)
const RESERVED = new Set([
  '22P46wDp3NLd', '22P46st8HNPY', '22P46syd4j6E', '22P46u8a49hk', '22P4VnkCXPSY', '22P4VnmXcjjy', '22P4v2gNtdFR',
  '22PJxPDbM5Rr', '22PJxPF6vCpk', '22P52xmCz3cx', '22P5KVgrLeXK', '22PK2MzzJD93',
  '22P3cqMfrQEp', '22P3cqVyzwhr', '22P3cqW68zuR', '22P3cqWFSzge',
]);

let _cache = null; // { at, fields }

/** [{ fieldId, name, target, type, options?, multiple }] */
export async function jobtreadFields(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (_cache && now - _cache.at < 10 * 60 * 1000) return _cache.fields;
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    organization: {
      $: { id: SOARD_ORG_ID },
      customFields: {
        $: { size: 100, where: ['targetType', 'in', ['customer', 'location']] },
        nodes: { id: {}, name: {}, targetType: {}, type: {}, options: {}, maxValuesAllowed: {} },
      },
    },
  }, fetchImpl);
  const fields = (data?.organization?.customFields?.nodes || [])
    .filter(f => !RESERVED.has(f.id) && !/^\*\*/.test(f.name))
    .map(f => ({
      fieldId: f.id,
      name: f.name.replace(/^\*+|\*+$/g, ''),
      target: f.targetType === 'location' ? 'location' : 'account',
      type: f.type,
      ...(Array.isArray(f.options) ? { options: f.options } : {}),
      multiple: f.type === 'option' && f.maxValuesAllowed == null,
    }))
    .sort((a, b) => a.target.localeCompare(b.target) || a.name.localeCompare(b.name));
  _cache = { at: now, fields };
  return fields;
}
