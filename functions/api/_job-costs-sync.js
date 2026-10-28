/**
 * Job costs on the JobTread job itself
 * ===========================================================================
 * Three job custom fields, kept up to date from each job's ledger so a PM
 * sees them on the job in JobTread without opening the admin:
 *
 *   Spent to date        billed + spent waiting for receipts   "$4,383"
 *   Waiting for receipts card charges with no bill yet        "$219"
 *   Forecast vs budget   forecast, budget and the share        "$5,183 of $6,500 (80%)"
 *   Close-out report     once the job closes: the final numbers and the report's link
 *
 * The fields are found by name, and made (text fields on jobs) the first
 * time they're missing. Each is written only when its value changed, so a
 * rebuild every 15 minutes doesn't touch the job (or its activity feed)
 * unless the money moved. A failure is kept for the admin and never stops
 * the ledger.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';
import { readState, writeState } from './_mercury.js';

export const JOB_FIELDS = { spent: 'Spent to date', pending: 'Waiting for receipts', forecast: 'Forecast vs budget', closeout: 'Close-out report' };
const KEY = 'jt-fields';

const whole = (c) => (Math.round(Number(c || 0) / 100)).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** The three values for a ledger's totals */
export function fieldValues(t) {
  const share = t.budget > 0 ? ` (${Math.round((t.forecast / t.budget) * 100)}%)` : '';
  return {
    spent: whole(t.billed + t.pending),
    pending: whole(t.pending),
    forecast: t.budget > 0 ? `${whole(t.forecast)} of ${whole(t.budget)}${share}` : `${whole(t.forecast)} (no budget yet)`,
  };
}

/** { spent, pending, forecast } → field ids, making any that are missing */
async function fieldIds(env, fetchImpl) {
  const st = await readState(env.DB, KEY);
  if (st.ids && Object.keys(JOB_FIELDS).every((k) => st.ids[k])) return st.ids;
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    organization: { $: { id: SOARD_ORG_ID }, customFields: { $: { size: 100, where: ['targetType', '=', 'job'] }, nodes: { id: {}, name: {} } } },
  }, fetchImpl);
  const have = new Map((data?.organization?.customFields?.nodes || []).map((f) => [String(f.name).trim().toLowerCase(), f.id]));
  const ids = {};
  for (const [k, name] of Object.entries(JOB_FIELDS)) {
    ids[k] = have.get(name.toLowerCase()) || null;
    if (!ids[k]) {
      const made = await pave(env.JOBTREAD_GRANT_KEY, {
        createCustomField: { $: { organizationId: SOARD_ORG_ID, targetType: 'job', type: 'text', name, minValuesRequired: 0 }, createdCustomField: { id: {} } },
      }, fetchImpl);
      ids[k] = made?.createCustomField?.createdCustomField?.id || null;
      if (!ids[k]) throw new Error(`JobTread didn’t make the “${name}” field`);
    }
  }
  await writeState(env.DB, KEY, { ids, at: new Date().toISOString(), error: null });
  return ids;
}

/** Write a job's three fields if they changed since the last write. Never throws. */
export async function syncJobFields(env, jobId, totals, { fetchImpl = fetch } = {}) {
  try {
    const values = fieldValues(totals);
    const st = await readState(env.DB, KEY);
    const last = st.last?.[jobId];
    if (last && Object.keys(values).every((k) => last[k] === values[k])) return false;
    const ids = await fieldIds(env, fetchImpl);
    await pave(env.JOBTREAD_GRANT_KEY, {
      updateJob: { $: { id: jobId, customFieldValues: Object.fromEntries(Object.entries(values).map(([k, v]) => [ids[k], v])) } },
    }, fetchImpl);
    const fresh = await readState(env.DB, KEY);
    await writeState(env.DB, KEY, { last: { ...(fresh.last || {}), [jobId]: values }, error: null });
    return true;
  } catch (e) {
    await writeState(env.DB, KEY, { error: { at: new Date().toISOString(), message: String(e.message).slice(0, 300) } }).catch(() => {});
    return false;
  }
}

/** The job closed: its final numbers and the report's address in "Close-out report". Never throws. */
export async function writeCloseoutField(env, jobId, text, { fetchImpl = fetch } = {}) {
  try {
    const ids = await fieldIds(env, fetchImpl);
    await pave(env.JOBTREAD_GRANT_KEY, { updateJob: { $: { id: jobId, customFieldValues: { [ids.closeout]: String(text).slice(0, 2000) } } } }, fetchImpl);
    return true;
  } catch (e) {
    await writeState(env.DB, KEY, { error: { at: new Date().toISOString(), message: String(e.message).slice(0, 300) } }).catch(() => {});
    return false;
  }
}
