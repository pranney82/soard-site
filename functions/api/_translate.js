/**
 * Spanish for the application (Admin → Applications → Spanish)
 * ===========================================================================
 * The Spanish follows the English. Put live translates, with Workers AI,
 * every string whose Spanish is missing or was made from older English, and
 * the application sweep does the same to the live form for anything the AI
 * couldn't do then. Spanish someone typed (or marked still right) for the
 * current English is never touched. "Fill missing with AI" in the admin
 * drafts the same translations early, to read over before putting it live.
 * Placeholders ({year}, {parent}, {child}, {copyNote}, {percent}), HTML tags
 * and *bold* markers must come back untouched, and anything that doesn't is
 * left out rather than saved broken.
 */

import { englishStrings, translationStatus, builtInSpanishBehind } from './_application-form.js';
import { getFormVersion, addTranslations, reopenTranslations } from './_application-forms.js';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const BATCH = 12;
// A batch's English, in characters: the emails are long, and a full batch of them would run past max_tokens
const BATCH_CHARS = 3000;
const AT_ONCE = 4;

const BRIEF = `You translate a children's charity's makeover application from English into Spanish for families in the United States (many from Mexico and Central America).
Write warm, plain, respectful Spanish using "usted". Say "su hijo o hija" for "your child" and "el niño o la niña" for "the child".
Keep these exactly as they are: anything in curly braces like {year} {parent} {child} {copyNote} {percent} {status}; HTML tags and their attributes; *asterisks* used for bold; line breaks; the names "Sunshine on a Ranney Day", "SOARD", "JobTread", county and city names.`;
const PROMPT = `${BRIEF}
Reply with JSON only: an object with the same keys as the input and the Spanish as each value.`;
// One string on its own, for what a batch didn't bring back: no JSON to get wrong
const ONE_PROMPT = `${BRIEF}
Reply with the Spanish only: no quotes, no notes, nothing before or after it.`;

const tokens = (s) => [...String(s).matchAll(/\{[a-zA-Z]+\}|<\/?[a-z0-9]+[^>]*>|\*/g)].map(m => m[0].replace(/\s+/g, ' ')).sort().join('|');

/** The entries in batches of at most BATCH strings and about BATCH_CHARS of English (a longer string goes alone) */
function batches(entries) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const e of entries) {
    if (cur.length && (cur.length >= BATCH || size + e[1].length > BATCH_CHARS)) { out.push(cur); cur = []; size = 0; }
    cur.push(e);
    size += e[1].length;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function translateBatch(env, batch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await env.AI.run(MODEL, {
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: JSON.stringify(batch) }],
        max_tokens: 4000,
        temperature: 0.2,
      });
      const r = typeof res === 'string' ? res : (res?.response ?? res);
      if (r && typeof r === 'object') return r;
      const m = String(r).match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
    } catch { /* try again */ }
  }
  return null;
}

async function translateOne(env, en) {
  try {
    const res = await env.AI.run(MODEL, {
      messages: [{ role: 'system', content: ONE_PROMPT }, { role: 'user', content: en }],
      max_tokens: 4000,
      temperature: 0.2,
    });
    const r = typeof res === 'string' ? res : res?.response;
    return typeof r === 'string' ? r.trim() : null;
  } catch {
    return null;
  }
}

/**
 * { path: spanish } for the given { path: english }. Leaves out anything the
 * model mangled. `into` fills as each batch comes back, for a caller that
 * stops waiting.
 */
export async function translateStrings(env, strings, { lang = 'es', into = {} } = {}) {
  if (lang !== 'es') throw new Error('Only Spanish is set up');
  if (!env.AI) throw new Error('Workers AI isn’t bound to the site');
  const queue = batches(Object.entries(strings).filter(([, v]) => String(v || '').trim()).map(([p, v]) => [p, String(v)]));
  const out = into;
  const failed = [];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const batch = Object.fromEntries(b);
      const parsed = await translateBatch(env, batch);
      for (const [path, en] of b) {
        let es = parsed?.[path];
        if (!(typeof es === 'string' && es.trim() && tokens(es) === tokens(en))) es = await translateOne(env, en);
        if (typeof es === 'string' && es.trim() && tokens(es) === tokens(en)) out[path] = es.trim();
        else failed.push(path);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));
  return { strings: out, failed };
}

/** { path: english } for each string whose Spanish is missing or older than its English; none for a form without Spanish */
export function spanishToDo(def) {
  if (!Object.keys(def?.i18n?.es?.strings || {}).length) return {};
  const en = englishStrings(def);
  const status = translationStatus(def, 'es');
  const behind = builtInSpanishBehind(def);
  return Object.fromEntries(Object.keys(status).filter(p => status[p] !== 'done' || behind[p]).map(p => [p, en[p]]));
}

/**
 * Bring one stored version's Spanish up to date with its English. Stops
 * waiting after `budgetMs`; the batches back by then land, the rest stays as
 * it was.
 * → { filled, failed } (failed: paths still missing or out of date)
 */
export async function catchUpSpanish(env, version, { budgetMs = 25000 } = {}) {
  let row = await getFormVersion(env.DB, version);
  if (row?.version !== version) return { filled: 0, failed: [] };
  // Built-in Spanish marked current under new English: out of date, in the admin too
  const behind = builtInSpanishBehind(row.definition);
  const es = row.definition.i18n?.es?.strings || {};
  if (await reopenTranslations(env.DB, version, Object.fromEntries(Object.entries(behind).map(([p, from]) => [p, { text: es[p], from }])))) row = await getFormVersion(env.DB, version);
  const todo = spanishToDo(row.definition);
  const paths = Object.keys(todo);
  if (!paths.length) return { filled: 0, failed: [] };
  const got = {};
  let timer;
  await Promise.race([
    translateStrings(env, todo, { into: got }).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); }),
  ]);
  clearTimeout(timer);
  const strings = { ...got };
  const filled = await addTranslations(env.DB, version, Object.fromEntries(Object.entries(strings).map(([p, text]) => [p, { text, from: todo[p] }])));
  return { filled, failed: paths.filter(p => !strings[p]) };
}
