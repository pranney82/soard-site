/**
 * JobTread custom field values, read and written the way JobTread keeps them
 * ===========================================================================
 * A dropdown that takes several choices ("Multiple Options": Makeover Type,
 * Monetary Sponsor, Designed By) comes back as one value node per choice,
 * not one joined string (./_applicants.js reads Makeover Type that way).
 * Reading such a field into a { id: value } map kept only the last node, so
 * a Bedroom + Bathroom room read as "Bathroom" and a room with two sponsors
 * named one. Splitting a joined string instead breaks on a choice that has
 * "&" or "," in its name ("Helen & Jimmy Carlos"). So: lists, matched
 * against the field's own choices, and written back as lists.
 */
import { SOARD_ORG_ID } from './_reveals.js';
import { pave } from './_jt-access.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Two spellings of one choice: case, spacing and curly apostrophes aside */
export const norm = (s) => clean(s).replace(/[’‘]/g, '\'').toLowerCase();

/** A field's choices as plain names (JobTread sends strings, or { name } / { value }) */
export const optionsOf = (o) => (Array.isArray(o) ? o.map((x) => clean(typeof x === 'string' ? x : x?.name ?? x?.value ?? '')).filter(Boolean) : []);

/** "A", "A and B", "A, B and C" */
export function listText(list, joiner = 'and') {
  const xs = (list || []).map(clean).filter(Boolean);
  if (xs.length <= 1) return xs[0] || '';
  return `${xs.slice(0, -1).join(', ')} ${joiner} ${xs[xs.length - 1]}`;
}

/**
 * Every field's values as lists: { [field id]: [value, …] }, in JobTread's order, each once. Each value is
 * exactly as JobTread sent it: a text field's line breaks and spacing are the person's (the reveal invite's
 * details hash them, and a changed hash emails every guest), so nothing here tidies them
 */
export function fieldLists(nodes) {
  const out = {};
  for (const v of nodes || []) {
    const id = v?.customField?.id;
    if (!id) continue;
    const vals = Array.isArray(v.value) ? v.value : [v.value];
    const list = out[id] || (out[id] = []);
    for (const x of vals) {
      if (x == null || (typeof x === 'string' && !x.trim())) continue;
      if (!list.includes(x)) list.push(x);
    }
  }
  return out;
}

/**
 * Every field's value as one thing to show or compare: a field with one
 * value keeps it as JobTread sent it (a date, true/false, a number, text);
 * several become "A, B and C". The shape the reveal and Demo Day invites read.
 */
export function fieldValues(nodes) {
  const out = {};
  for (const [id, list] of Object.entries(fieldLists(nodes))) {
    out[id] = list.length <= 1 ? (list[0] ?? null) : listText(list.map(String));
  }
  return out;
}

/** One dropdown's values as a list of names (a choice's name, trimmed) */
export const fieldList = (nodes, id) => [...new Set((fieldLists(nodes)[id] || []).map((x) => clean(x)).filter(Boolean))];

/**
 * The names a value list holds, matched against the field's choices (case
 * and spacing aside), in the choices' spelling. A value that isn't a choice
 * any more is kept as it was: it's still what the job says.
 */
export function matchChoices(values, options) {
  const byKey = new Map(optionsOf(options).map((o) => [norm(o), o]));
  const out = [];
  for (const v of values || []) {
    const name = byKey.get(norm(v)) || clean(v);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The job custom fields this needs, by name, made when missing:
 * want: [{ key, name, multiple }] → { [key]: { id, name, options, multiple } }.
 * Read fresh each time it's asked (a field deleted or remade in JobTread
 * Settings must stop a run, not be written to by an old id).
 */
export async function jobFields(grantKey, want, { fetchImpl = fetch, make = true } = {}) {
  // Every job field, page by page: one past the first page isn't "missing"
  const nodes = [];
  let page = null;
  for (let i = 0; i < 10; i++) {
    const d = await pave(grantKey, {
      organization: {
        $: { id: SOARD_ORG_ID },
        customFields: { $: { size: 100, where: ['targetType', '=', 'job'], ...(page ? { page } : {}) }, nextPage: {}, nodes: { id: {}, name: {}, type: {}, options: {}, maxValuesAllowed: {} } },
      },
    }, fetchImpl);
    const conn = d?.organization?.customFields;
    if (!Array.isArray(conn?.nodes)) throw new Error('JobTread sent no job fields');
    nodes.push(...conn.nodes);
    page = conn.nextPage || null;
    if (!page) break;
  }
  if (page) throw new Error('JobTread has more job fields than the site reads');
  const out = {};
  for (const w of want) {
    const found = nodes.filter((x) => norm(x.name) === norm(w.name) && x.type === 'option');
    if (found.length > 1) throw new Error(`JobTread has two job fields named “${w.name}”: one of them needs deleting in JobTread`);
    if (found.length) {
      const f = found[0];
      out[w.key] = { id: f.id, name: f.name, options: optionsOf(f.options), multiple: f.maxValuesAllowed == null || f.maxValuesAllowed > 1 };
      continue;
    }
    if (!make || w.make === false) { out[w.key] = null; continue; }
    const made = await pave(grantKey, {
      createCustomField: {
        $: { organizationId: SOARD_ORG_ID, targetType: 'job', type: 'option', name: w.name, minValuesRequired: 0, maxValuesAllowed: w.multiple ? null : 1, options: w.options || [] },
        createdCustomField: { id: {} },
      },
    }, fetchImpl);
    const id = made?.createCustomField?.createdCustomField?.id;
    if (!id) throw new Error(`JobTread didn’t make the job field “${w.name}”`);
    out[w.key] = { id, name: w.name, options: optionsOf(w.options || []), multiple: !!w.multiple, made: true };
  }
  return out;
}

/** A field's choices as JobTread has them right now, as it sent them */
async function readRawChoices(grantKey, fieldId, { fetchImpl = fetch } = {}) {
  const d = await pave(grantKey, { customField: { $: { id: fieldId }, id: {}, name: {}, options: {}, maxValuesAllowed: {} } }, fetchImpl);
  const f = d?.customField;
  if (!f?.id) throw new Error('JobTread has no such field');
  return Array.isArray(f.options) ? f.options : [];
}
/** A field's choices as JobTread has them right now (names) */
export async function readChoices(grantKey, fieldId, { fetchImpl = fetch } = {}) {
  return optionsOf(await readRawChoices(grantKey, fieldId, { fetchImpl }));
}

/**
 * Choices to keep: what the field has, in the order a person may have put it in, with each wanted name it
 * lacks slotted in A to Z among them (nothing already there moves). Only a choice the site itself added, that
 * no job holds and that's no longer wanted, ever goes; a choice a person added in JobTread stays.
 * → { next: [names] | null (nothing to change), added, dropped }
 */
export function planChoices(have, { wanted = [], siteAdded = [], held = [] } = {}) {
  const has = (list, x) => list.some((y) => norm(y) === norm(x));
  const added = wanted.map(clean).filter((x) => x && !has(have, x)).filter((x, i, a) => a.findIndex((y) => norm(y) === norm(x)) === i);
  const dropped = have.filter((x) => has(siteAdded, x) && !has(wanted, x) && !has(held, x));
  if (!added.length && !dropped.length) return { next: null, added, dropped };
  const next = have.filter((x) => !has(dropped, x));
  for (const x of [...added].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))) {
    const at = next.findIndex((y) => y.localeCompare(x, 'en', { sensitivity: 'base' }) > 0);
    next.splice(at < 0 ? next.length : at, 0, x);
  }
  return { next, added, dropped };
}

/**
 * Writes the choices, read again just before so a choice a person added a moment ago isn't lost, and only when
 * a choice is added or goes. Each choice already there is written back exactly as JobTread sent it (its colour
 * or any other setting with it)
 */
export async function keepChoices(grantKey, fieldId, opts, { fetchImpl = fetch } = {}) {
  const raw = await readRawChoices(grantKey, fieldId, { fetchImpl });
  const have = optionsOf(raw);
  const plan = planChoices(have, opts);
  if (plan.next) {
    const byName = new Map(raw.map((o) => [clean(typeof o === 'string' ? o : o?.name ?? o?.value ?? ''), o]));
    await pave(grantKey, { updateCustomField: { $: { id: fieldId, options: plan.next.map((n) => byName.get(n) ?? n) } } }, fetchImpl);
  }
  return { ...plan, have };
}

/** Sets a job's values for these fields: { [field id]: [names] } (an empty list clears it) */
export async function setJobValues(grantKey, jobId, values, { fetchImpl = fetch } = {}) {
  const customFieldValues = Object.fromEntries(Object.entries(values).map(([id, list]) => [id, Array.isArray(list) ? list : list == null ? [] : [list]]));
  await pave(grantKey, { updateJob: { $: { id: jobId, customFieldValues } } }, fetchImpl);
}
