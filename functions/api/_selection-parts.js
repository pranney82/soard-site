/**
 * Kid items, step 2: each makeover's chosen selections, as the parts to get (watch only)
 * ===========================================================================
 * A designer writes one JobTread budget line per category ("Shower System"),
 * with several products inside it: names, model numbers, links, quantities and
 * prices. Every 30 minutes this reads each open makeover's chosen selection
 * lines (budget lines on no document, `isSelected`) and splits each line into
 * the parts someone has to buy or receive, kept in D1 kid_parts. A line is read
 * again only when its words, cost or quantity change. Nothing is written to
 * JobTread yet: Automations and /api/kid-items-admin show the parts so they can
 * be checked by eye, which is the test the next steps wait on.
 *
 * Where a part comes from:
 *   buy      SOARD buys it (a priced part)
 *   donated  it says donated or donor: it comes to the Office and is checked in
 *   family   the family supplies it
 *   others   the installer or a trade partner brings it, or it's labor; also any
 *            part on a $0 line that doesn't say donated (Peter, Nov 9 2026: "$0
 *            could be supplied by others or donated and we are receiving")
 */

import { pave, SOARD_ORG_ID, FIELD_JOB_STATUS } from './_reveals.js';
import { FIELD_PM } from './_reveal-nudges.js';
import { viaGateway, aiCapped, AI_REST_MS, AI_WAIT_NOTE } from './_ai.js';

const EVERY_MS = 30 * 60 * 1000;
const AI_A_RUN = 8;
const RUN_MS = 10 * 1000;
const LINES_A_PAGE = 20;      // a line's words run to 4,096 characters: small pages keep JobTread under its size limit
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// A line with seven products, their links and prices takes the model 15-20 seconds to write out: 12 seconds cut every
// long line off (Nov 10 2026: 27 lines across all five kids came back empty), so it gets 25 (the heartbeat allows 30)
const AI_TIMEOUT_MS = 25 * 1000;
// One long line at a time: an AI read starts only in a run's first seconds, so it finishes inside the heartbeat
const AI_START_MS = 3 * 1000;
// Lines missed before those limits were raised are read again now, not six hours later
const MISSED_BEFORE = Date.parse('2026-11-10T05:40:00Z');
// Not being worked on: nothing to buy or receive
export const SKIP_STATUSES = new Set(['Closed Done', 'Denied', 'Warranty', 'Awaiting Funding']);
export const SOURCES = ['buy', 'donated', 'family', 'others'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kid_parts (
    job_id TEXT NOT NULL, item_id TEXT NOT NULL, job_name TEXT, group_name TEXT, line_name TEXT, cents INTEGER,
    hash TEXT NOT NULL, parts TEXT NOT NULL, read_by TEXT, read_at TEXT, PRIMARY KEY (job_id, item_id))`,
  'CREATE TABLE IF NOT EXISTS kid_parts_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
];
// Added Nov 9 2026: the line's own words, for matching an order to it, and those words made comparable across
// makeovers (the same generic words on several is a template line, not a product yet)
const COLUMNS = ['words TEXT', 'words_key TEXT'];
const _ready = new WeakSet();
async function ensure(DB) {
  if (_ready.has(DB)) return;
  for (const s of SCHEMA) await DB.prepare(s).run();
  const have = new Set(((await DB.prepare('PRAGMA table_info(kid_parts)').all()).results || []).map((c) => c.name));
  for (const c of COLUMNS) if (!have.has(c.split(' ')[0])) await DB.prepare(`ALTER TABLE kid_parts ADD COLUMN ${c}`).run();
  _ready.add(DB);
}

/** A line's words made comparable: lower case, no links, prices or punctuation */
export function wordsKey(text) {
  return String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/\$\s?[\d,.]+/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 300);
}
async function readState(DB) {
  const row = await DB.prepare("SELECT data FROM kid_parts_state WHERE key = 'state'").first();
  try { return row ? JSON.parse(row.data) || {} : {}; } catch { return {}; }
}
const writeState = (DB, st) => DB.prepare("INSERT OR REPLACE INTO kid_parts_state (key, data, updated_at) VALUES ('state', ?, ?)")
  .bind(JSON.stringify(st), new Date().toISOString()).run();
const iso = (ms) => new Date(ms).toISOString();

/** A line's fingerprint: read again only when this changes */
export function lineHash(line) {
  const s = [line.name, line.description, line.cost, line.quantity].map((x) => String(x ?? '')).join('\u0001');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

const DONATED = /\bdonat(ed|ion)\b|\bdonor\b|\bin[- ]kind\b/i;
const FAMILY = /\bsupplied by (the )?family\b|\bfamily (supplies|supplied|provides|provided|has|owns)\b|\bfrom the family\b|\bfamily['’]s own\b/i;
// "Provided by Echols", "Supplied by Cambria": a partner brings it (the family's own is caught first, above)
const OTHERS = /\b(supplied|provided|installed|furnished|brought) by\b|\blabor\b/i;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const cents = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) : 0);
const centsOf = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const tidy = (s) => String(s || '').replace(/\*+/g, '').replace(/\s+/g, ' ').trim();

/** Where one part comes from, by its words and its line's cost (a $0 line's part is someone else's unless it says donated) */
export function sourceOf(partWords, lineWords, lineCents, said = 'buy') {
  if (DONATED.test(partWords)) return 'donated';
  if (FAMILY.test(partWords)) return 'family';
  if (OTHERS.test(partWords)) return 'others';
  if (!lineCents) return DONATED.test(lineWords) ? 'donated' : 'others';
  return SOURCES.includes(said) ? said : 'buy';
}

/** The line's own link that a written start ("https://www.lowes.com/pd/VEVOR-Sen…") belongs to, else "" */
export function linkFrom(start, words) {
  const head = String(start || '').trim().replace(/…$|\.\.\.$/, '');
  if (head.length < 12) return '';
  return (String(words || '').match(URL_RE) || []).find((u) => u.startsWith(head) || head.startsWith(u)) || '';
}

/** A line the AI couldn't split after its tries: the whole line as one part, so its orders can still be matched by its words */
export function wholeLine(line) {
  const words = tidy(line.description);
  const lineCents = cents(line.cost);
  const p = { name: tidy(line.name), brand: '', model: '', link: (words.match(URL_RE) || [])[0] || '', quantity: Math.max(1, Math.round(Number(line.quantity) || 1)), cents: lineCents || null };
  // whole: the line's products aren't known one by one; each thing ordered for it is tracked as its own (./_kid-checkin.js)
  return [{ ...p, source: sourceOf(words, `${line.name} ${words}`, lineCents), key: partKey(p), whole: true }];
}

/** A part's matching key: its model number, else the store's product id in its link, else its name */
export function partKey(p) {
  const model = tidy(p.model).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (model.length >= 4) return `model:${model}`;
  const link = String(p.link || '');
  const id = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})\b/.exec(link)?.[1] || /[-/](w\d{6,})\.html/i.exec(link)?.[1]?.toLowerCase() || /homedepot\.com\/p\/[^?#]*\/(\d{9})/.exec(link)?.[1];
  if (id) return `link:${id}`;
  if (link) return `url:${link.replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').toLowerCase()}`;
  return `name:${tidy(p.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`;
}

/**
 * A line that needs no reading: no words beyond its name, or words with no link, model or price in them
 * (one thing, "LVP", "Trim, walls & ceiling") → [part] | null (the AI splits it)
 */
export function simpleParts(line) {
  const words = tidy(line.description);
  const lineCents = cents(line.cost);
  const complex = (words.match(URL_RE) || []).length > 1 || /model\s*#|\bqty\b|\$\s?\d|\bsku\b|\n.*\n/i.test(String(line.description || ''));
  if (complex) return null;
  const name = tidy(line.name);
  const link = (words.match(URL_RE) || [])[0] || '';
  const p = { name: words && words !== name ? `${name}: ${words.replace(URL_RE, '').trim()}`.replace(/:\s*$/, '') : name, brand: '', model: '', link, quantity: Number(line.quantity) || 1, cents: lineCents || null };
  return [{ ...p, source: sourceOf(words, `${name} ${words}`, lineCents), key: partKey(p) }];
}

export const PARTS_SCHEMA = {
  type: 'object',
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, brand: { type: 'string' }, model: { type: 'string' }, link: { type: 'string' },
          quantity: { type: 'number' }, price: { type: 'string' }, source: { type: 'string', enum: ['buy', 'donated', 'family', 'others', 'unknown'] },
        },
        required: ['name', 'brand', 'model', 'link', 'quantity', 'price', 'source'],
      },
    },
  },
  required: ['parts'],
};

export const PARTS_PROMPT = [
  'You split one line of a kid\'s room makeover selections into the separate products someone has to get. Answer in JSON only.',
  'Each product: its name as written, kept short; brand; model number or SKU if written (else ""); the first 50 characters of its link if one is given, exactly as written (else ""); quantity (QTY 2 means 2, else 1); its price as written for that product (else ""); and source:',
  'donated if it says donated or donor; family if the family supplies it; others if it is labor or the installer or a trade brings it; else buy.',
  'A finish, color or grout note belongs to its product, not a product of its own. Paint colors for different surfaces are separate products.',
  'Never invent a product the words don\'t name.',
].join('\n');

/** Workers AI splits a line → [part] | null. A cap reached throws */
export async function aiParts(env, line) {
  if (!env.AI?.run) return null;
  const input = [`Line: ${line.name}`, `Line cost: $${Number(line.cost || 0).toFixed(2)}`, `Words:\n${String(line.description || '').slice(0, 4000)}`].join('\n');
  let timer;
  try {
    const out = await Promise.race([
      env.AI.run(AI_MODEL, {
        messages: [{ role: 'system', content: PARTS_PROMPT }, { role: 'user', content: input }],
        max_tokens: 3000, temperature: 0, response_format: { type: 'json_schema', json_schema: PARTS_SCHEMA },
      }, viaGateway('kid-parts')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), AI_TIMEOUT_MS); }),
    ]);
    let j = out?.response ?? out;
    if (typeof j === 'string') { try { j = JSON.parse(j.slice(j.indexOf('{'), j.lastIndexOf('}') + 1)); } catch { return null; } }
    if (!Array.isArray(j?.parts)) return null;
    const lineCents = cents(line.cost);
    const lineWords = `${line.name} ${line.description || ''}`;
    const out2 = [];
    for (const a of j.parts) {
      const name = tidy(a.name);
      if (!name) continue;
      // The model writes only a link's start (whole links made long lines too slow to write out): the line's own
      // link that starts that way is the link; one the line doesn't have is the model's own, and dropped
      const link = linkFrom(a.link, line.description);
      const p = { name, brand: tidy(a.brand), model: tidy(a.model), link, quantity: Math.max(1, Math.round(Number(a.quantity) || 1)), cents: centsOf(a.price) };
      out2.push({ ...p, source: sourceOf(`${name} ${a.price || ''}`, lineWords, lineCents, a.source === 'unknown' ? 'buy' : a.source), key: partKey(p) });
    }
    return out2.length ? out2 : null;
  } catch (err) {
    if (aiCapped(err)) throw err;
    console.error('[selection-parts]', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Open makeovers with their status → [{ id, name, status }] */
async function openJobs(env, fetchImpl) {
  const out = [];
  let page = null;
  for (let i = 0; i < 20; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: {
        $: { id: SOARD_ORG_ID },
        jobs: {
          $: { size: 25, where: ['closedOn', '=', null], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: { id: {}, name: {}, customFieldValues: { $: { size: 5, where: [['customField', 'id'], 'in', [FIELD_JOB_STATUS, FIELD_PM]] }, nodes: { value: {}, customField: { id: {} } } } },
        },
      },
    }, fetchImpl);
    const conn = data?.organization?.jobs;
    for (const j of conn?.nodes || []) {
      const v = (id) => j.customFieldValues?.nodes?.find((n) => n.customField?.id === id)?.value;
      const pm = v(FIELD_PM);
      // The Project Manager (an option, "Christian Nielsen"): their first name, for who loads out (./_kid-checkin.js)
      out.push({ id: j.id, name: j.name, status: v(FIELD_JOB_STATUS) || null, pm: String(Array.isArray(pm) ? pm[0] || '' : pm || '').trim().split(/\s+/)[0] || null });
    }
    page = conn?.nextPage;
    if (!page) break;
  }
  // Rehearsal jobs (TEST…) stay out until the sandbox step
  return out.filter((j) => !SKIP_STATUSES.has(String(j.status || '').trim()) && !/\btest\b/i.test(j.name));
}

// Labor and the job's own costs, never things to buy or receive
const NOT_GOODS = /labor|subcontract|permit|fee|dumpster|disposal|haul|design|engineering|overhead|contingency|insurance/i;
// Budget lines that aren't things to buy and receive at the Office, by their name (they were showing on the check-in
// list as "not ordered yet", Nov 10 2026): the trades' work and the job's own costs
const NOT_GOODS_NAME = /\b(labor|install(ation)?|clean(ing|up)?|dumpster|portalet|port-?a-?potty|permit|protection|agreement|framing|drywall|insulation|demo(lition)?|haul(ing)?|disposal|design|engineering|allowance|fees?|repair|electrical|contingency|overhead|insurance|inspection|survey|uncategorized)\b/i;
const isChoiceGroup = (g) => Boolean(g) && (g.maxSelectionsAllowed != null || g.minSelectionsRequired != null);

/**
 * Whether a budget line is something to buy or receive: a selection the family chose, or a line outside any
 * selection group that isn't labor or a fee. Dylan's therapy table, TV and lights sit on plain budget lines, not in
 * a selection (seen Nov 9 2026), while an option nobody chose sits in a selection group with isSelected false
 */
export function isGoodsLine(c) {
  if (c.isSelected) return true;
  const g = c.costGroup;
  if (isChoiceGroup(g) || isChoiceGroup(g?.parentCostGroup)) return false;
  return !NOT_GOODS.test(c.costType?.name || '') && !NOT_GOODS_NAME.test(c.name || '');
}

/** A line the website made itself: an Also bought line (its globalId, or its group) */
export const isSiteLine = (c) => /^soard-/.test(String(c.globalId || '')) || String(c.costGroup?.name || '').trim() === 'Also bought';

/** One job's lines to buy or receive → [{ id, name, description, cost, quantity, group }] */
async function chosenLines(env, jobId, fetchImpl) {
  const out = [];
  let page = null;
  for (let i = 0; i < 20; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      job: {
        $: { id: jobId },
        costItems: {
          $: { size: LINES_A_PAGE, where: [['document', 'id'], '=', null], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, name: {}, description: {}, cost: {}, quantity: {}, isSelected: {}, globalId: {}, costType: { name: {} },
            costGroup: { name: {}, maxSelectionsAllowed: {}, minSelectionsRequired: {}, parentCostGroup: { maxSelectionsAllowed: {}, minSelectionsRequired: {} } },
          },
        },
      },
    }, fetchImpl);
    const conn = data?.job?.costItems;
    // The site's own Also bought lines (./_kid-jt.js) are what was bought, not selections to buy
    for (const c of conn?.nodes || []) if (isGoodsLine(c) && !isSiteLine(c)) out.push({ id: c.id, name: c.name, description: c.description || '', cost: c.cost, quantity: c.quantity, group: c.costGroup?.name || '' });
    page = conn?.nextPage;
    if (!page) break;
  }
  return out;
}

// A line the AI couldn't split: kept against its words, tried again after a while, a few times, then left until it changes
const MISS_RETRY_MS = 6 * 60 * 60 * 1000;
const MISS_TRIES = 3;
const missTries = (by) => Number((/^none:(\d+)$/.exec(String(by || '')) || [])[1] || 0);

async function run(env, st, { fetchImpl, now }) {
  const started = Date.now();
  const jobs = await openJobs(env, fetchImpl);
  st.jobs = jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, pm: j.pm || null }));
  // A makeover no longer open (finished, closed, put on hold) leaves the list
  const open = new Set(jobs.map((j) => j.id));
  for (const r of (await env.DB.prepare('SELECT DISTINCT job_id FROM kid_parts').all()).results || []) {
    if (!open.has(r.job_id)) await env.DB.prepare('DELETE FROM kid_parts WHERE job_id = ?').bind(r.job_id).run();
  }
  let ai = 0;
  let capped = false;
  let leftWork = false;
  const errors = [];
  const at = jobs.length ? (st.nextJob || 0) % jobs.length : 0;
  // A pass over every open job can take several runs (each stops at RUN_MS): it's counted across them
  if (!(st.passLeft > 0)) st.passLeft = jobs.length;
  st.passLeft = Math.min(st.passLeft, jobs.length);
  // Open jobs in turn, starting where the last run stopped; an unchanged job costs one JobTread read
  for (const job of [...jobs.slice(at), ...jobs.slice(0, at)]) {
    if (st.passLeft <= 0) break;
    if (Date.now() - started > RUN_MS || capped) { leftWork = true; break; }
    const next = (jobs.findIndex((j) => j.id === job.id) + 1) % jobs.length;
    try {
      const lines = await chosenLines(env, job.id, fetchImpl);
      const have = new Map(((await env.DB.prepare('SELECT item_id, hash, read_by, read_at, words_key, cents FROM kid_parts WHERE job_id = ?').bind(job.id).all()).results || []).map((r) => [r.item_id, r]));
      let finished = true;
      for (const line of lines) {
        const hash = lineHash(line);
        const prev = have.get(line.id);
        const missed = prev?.hash === hash ? missTries(prev.read_by) : 0;
        // Read before the line's words were kept: they're added now, with no new reading
        if (prev?.hash === hash && prev.words_key == null) await env.DB.prepare('UPDATE kid_parts SET words = ?, words_key = ? WHERE job_id = ? AND item_id = ?').bind(String(line.description || '').slice(0, 3000), wordsKey(line.description), job.id, line.id).run();
        const missedAt = Date.parse(prev?.read_at || 0);
        // Tried three times: the whole line becomes one part (read_by 'whole'), never left unread
        if (prev?.hash === hash && missed >= MISS_TRIES) {
          await env.DB.prepare("UPDATE kid_parts SET parts = ?, read_by = 'whole', read_at = ? WHERE job_id = ? AND item_id = ?").bind(JSON.stringify(wholeLine(line)), iso(now), job.id, line.id).run();
          continue;
        }
        if (prev?.hash === hash && (!missed || (now - missedAt < MISS_RETRY_MS && missedAt >= MISSED_BEFORE))) continue;
        // Only its amount changed (the site takes what's bought on an allowance off it): the amount kept, its reading stands
        if (prev && prev.hash !== hash && prev.read_by && !String(prev.read_by).startsWith('none') && lineHash({ ...line, cost: (prev.cents ?? 0) / 100 }) === prev.hash) {
          await env.DB.prepare('UPDATE kid_parts SET cents = ?, hash = ? WHERE job_id = ? AND item_id = ?').bind(cents(line.cost), hash, job.id, line.id).run();
          continue;
        }
        let parts = simpleParts(line);
        let by = 'rules';
        if (!parts) {
          // Out of AI turns or time: this job goes on from here next run
          if (ai >= AI_A_RUN || Date.now() - started > (ai ? AI_START_MS : RUN_MS)) { finished = false; break; }
          ai++;
          parts = await aiParts(env, line);
          by = 'ai';
          if (!parts) {
            if (missed + 1 >= MISS_TRIES) { parts = wholeLine(line); by = 'whole'; } else { parts = []; by = `none:${missed + 1}`; }
          }
        }
        await env.DB.prepare(`INSERT OR REPLACE INTO kid_parts (job_id, item_id, job_name, group_name, line_name, cents, hash, parts, read_by, read_at, words, words_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(job.id, line.id, job.name, line.group, line.name, cents(line.cost), hash, JSON.stringify(parts), by, iso(now), String(line.description || '').slice(0, 3000), wordsKey(line.description)).run();
      }
      // A line no longer chosen (or deleted) leaves the list
      const ids = new Set(lines.map((l) => l.id));
      for (const id of have.keys()) if (!ids.has(id)) await env.DB.prepare('DELETE FROM kid_parts WHERE job_id = ? AND item_id = ?').bind(job.id, id).run();
      if (!finished) { leftWork = true; break; }
      st.nextJob = next;
      st.passLeft--;
    } catch (err) {
      if (aiCapped(err)) { capped = true; leftWork = true; break; }
      errors.push(`${job.name}: ${err.message}`);
      st.nextJob = next;
      st.passLeft--;
    }
  }
  if (capped) { st.aiRestUntil = now + AI_REST_MS; errors.push(AI_WAIT_NOTE); }
  // Every open job looked at, over however many runs: a whole pass, and the next one starts in 30 minutes. Until
  // then, back in a minute from where it stopped
  if (st.passLeft <= 0) { st.firstPassDone = true; st.behind = false; } else st.behind = true;
  Object.assign(st, { lastRunAt: now, error: errors.length ? errors.join(' · ').slice(0, 500) : null, runningUntil: 0 });
  return st;
}

/** On the heartbeat, beside the order sweep: every 30 minutes (every minute while lines are waiting to be read). Never throws */
export async function maybeReadSelections(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  if (!env?.DB || !env.JOBTREAD_GRANT_KEY) return null;
  let st = {};
  try {
    await ensure(env.DB);
    st = await readState(env.DB);
    if (st.off && !force) return null;
    const due = st.behind ? 60 * 1000 : EVERY_MS;
    if (!force && now - (st.lastRunAt || 0) < due) return null;
    if (!force && ((st.runningUntil || 0) > now || (st.aiRestUntil || 0) > now)) return null;
    Object.assign(st, { lastRunAt: now, runningUntil: now + 60000 });
    await writeState(env.DB, st);
    // Still working through the jobs for the first time, or a job left half read: back in a minute (run sets behind)
    st = await run(env, st, { fetchImpl, now });
    await writeState(env.DB, st);
    return st;
  } catch (err) {
    console.error('[selection-parts]', err.message);
    await writeState(env.DB, { ...st, error: err.message, runningUntil: 0 }).catch(() => {});
    return null;
  }
}

/** For Automations and the step-2 check: each open job's lines and parts, by where they come from */
export async function selectionPartsStatus(env, { detail = false } = {}) {
  if (!env?.DB) return null;
  await ensure(env.DB);
  const st = await readState(env.DB);
  const rows = (await env.DB.prepare('SELECT job_id, job_name, group_name, line_name, cents, parts, read_by, read_at FROM kid_parts ORDER BY job_name, group_name, line_name').all()).results || [];
  const jobs = new Map();
  for (const r of rows) {
    let parts = [];
    try { parts = JSON.parse(r.parts || '[]'); } catch { /* none */ }
    const j = jobs.get(r.job_id) || { id: r.job_id, name: r.job_name, lines: 0, unread: 0, parts: 0, buy: 0, donated: 0, family: 0, others: 0, ...(detail ? { list: [] } : {}) };
    j.lines++;
    if (String(r.read_by || '').startsWith('none')) j.unread++;
    j.parts += parts.length;
    for (const p of parts) j[p.source] = (j[p.source] || 0) + 1;
    if (detail) j.list.push({ line: r.line_name, group: r.group_name, cents: r.cents, by: r.read_by, parts: parts.map((p) => ({ name: p.name, model: p.model || null, quantity: p.quantity, cents: p.cents, source: p.source, link: Boolean(p.link) })) });
    jobs.set(r.job_id, j);
  }
  return {
    jobtread: Boolean(env.JOBTREAD_GRANT_KEY), ai: Boolean(env.AI?.run), watching: true,
    lastRunAt: st.lastRunAt ? iso(st.lastRunAt) : null, error: st.error || null, firstPassDone: Boolean(st.firstPassDone),
    open: (st.jobs || []).length, jobs: [...jobs.values()],
  };
}
