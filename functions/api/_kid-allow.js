/**
 * Kid items: which allowance something bought on top of a kid's selections is bought under
 * =========================================================================================
 * A makeover's budget sets money aside for kinds of things, its allowances ("Decor: Books, wall art, shelves,
 * decorative objects", "Bedding", "Rug"), in its Selection & Allowance groups. Something ordered for the kid that isn't
 * on their selections gets its own line on their budget, next to the allowance it's bought under, and that allowance
 * goes down by it (./_kid-jt.js); when it's none of them (a door, an appliance, medical equipment), its line is Also
 * bought. Peter, Nov 11 2026: "some items arent yet in JT because we only made an allowance for them in the budget".
 * The site sorts each one once, before its line is made (Workers AI, with that kid's allowances to pick from), and
 * keeps the answer (kid_allow_class). A person's answer (Needs a look, Wrong kid or line) stands over it.
 */

import { viaGateway, aiCapped } from './_ai.js';
import { ensureRecord } from './_kid-record.js';

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const AI_TIMEOUT_MS = 25 * 1000;
// Asked this many times without an answer: Also bought (a person can still put it on an allowance)
export const SORT_TRIES = 3;

export const SORT_PROMPT = [
  'Things were bought for a child\'s room makeover that aren\'t on the room\'s list of selections. The makeover\'s budget sets money aside for kinds of things: its allowances, numbered below.',
  'For each thing, answer the number of the allowance it is bought under, or 0 when it is none of them.',
  'A thing goes under an allowance only when it is plainly that kind of thing: wall art, frames and what hangs them under a decor allowance, sheets and pillows under bedding.',
  'Doors, windows, building materials, tools, appliances, medical or mobility equipment, and anything that fits none: 0. Answer in JSON only.',
].join('\n');
const SORT_SCHEMA = {
  type: 'object',
  properties: { things: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, allowance: { type: 'integer' } }, required: ['n', 'allowance'] } } },
  required: ['things'],
};
const usd = (cents) => (cents ? ` ($${(cents / 100).toFixed(2)})` : '');

/**
 * One kid's things, each to one of their allowances or none → Map of each thing's key → the allowance's line id, or
 * null for none; things the answer left out aren't in it. null: no answer. A spending cap reached throws
 */
export async function aiSort(env, allowances, things, { timeoutMs = AI_TIMEOUT_MS } = {}) {
  if (!env.AI?.run || !allowances.length || !things.length) return null;
  const input = [
    'Allowances:',
    ...allowances.map((a, i) => `${i + 1}. ${a.line}${a.words ? `: ${a.words.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`),
    '',
    'Things:',
    ...things.map((t, i) => `${i + 1}. ${String(t.name).replace(/\s+/g, ' ').slice(0, 160)}${t.order?.store ? `, from ${t.order.store}` : ''}${usd(t.order?.cents ?? t.cents)}`),
  ].join('\n');
  let timer;
  try {
    const out = await Promise.race([
      env.AI.run(AI_MODEL, {
        messages: [{ role: 'system', content: SORT_PROMPT }, { role: 'user', content: input }],
        max_tokens: 800, temperature: 0, response_format: { type: 'json_schema', json_schema: SORT_SCHEMA },
      }, viaGateway('kid-allowances')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    let j = out?.response ?? out;
    if (typeof j === 'string') { try { j = JSON.parse(j.slice(j.indexOf('{'), j.lastIndexOf('}') + 1)); } catch { return null; } }
    if (!Array.isArray(j?.things)) return null;
    const got = new Map();
    for (const a of j.things) {
      const t = things[Number(a.n) - 1];
      const n = Number(a.allowance);
      // An answer that names no allowance on the list is no answer for that thing
      if (!t || !Number.isInteger(n) || n < 0 || n > allowances.length) continue;
      got.set(t.also.key, n ? allowances[n - 1].itemId : null);
    }
    return got;
  } catch (err) {
    if (aiCapped(err)) throw err;
    console.error('[kid-allow]', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Kept: sorted onto an allowance (itemId) or none (null) */
export async function keepSort(DB, key, jobId, itemId, how, now = new Date().toISOString()) {
  await DB.prepare(`INSERT INTO kid_allow_class (key, job_id, item_id, how, tries, at) VALUES (?, ?, ?, ?, 0, ?)
      ON CONFLICT(key) DO UPDATE SET job_id = excluded.job_id, item_id = excluded.item_id, how = excluded.how, at = excluded.at`).bind(key, jobId, itemId, how, now).run();
}

// Asked about this many at a time, so a long list (a kid's first sort) is never an answer cut off
const AT_ONCE = 20;

/**
 * Sort each kid's things waiting to be sorted (also.pending; only: which of them) → { sorted, waiting, capped? }. A
 * thing the answer left out is asked again on the next run; after SORT_TRIES, it's Also bought. It stops at until (the
 * run's time), leaving the rest for the next run. Never throws
 */
export async function sortAllowances(env, kids, { now = new Date().toISOString(), only = () => true, until = Infinity } = {}) {
  await ensureRecord(env.DB);
  const out = { sorted: 0, waiting: 0 };
  const batches = [];
  for (const k of kids) {
    const all = k.items.filter((i) => i.also?.pending && only(k, i));
    for (let i = 0; i < all.length; i += AT_ONCE) batches.push({ k, things: all.slice(i, i + AT_ONCE) });
  }
  for (const { k, things } of batches) {
    // Out of time: the rest wait for the next run (nothing is counted as a try)
    if (out.capped || Date.now() > until - 2000) { out.waiting += things.length; continue; }
    // No AI here (a test, a copy of the site without it): nothing to wait for, so Also bought
    if (!env.AI?.run) {
      for (const it of things) await keepSort(env.DB, it.also.key, k.jobId, null, 'unsorted', now);
      out.sorted += things.length;
      continue;
    }
    let answer = null;
    try {
      answer = await aiSort(env, k.allowances || [], things, { timeoutMs: Math.max(3000, Math.min(AI_TIMEOUT_MS, until - Date.now())) });
    } catch (err) {
      if (aiCapped(err)) { out.capped = true; out.waiting += things.length; continue; }
    }
    for (const it of things) {
      const key = it.also.key;
      if (answer?.has(key)) {
        await keepSort(env.DB, key, k.jobId, answer.get(key), 'site', now);
        out.sorted++;
        continue;
      }
      await env.DB.prepare(`INSERT INTO kid_allow_class (key, job_id, item_id, how, tries, at) VALUES (?, ?, NULL, NULL, 1, ?)
          ON CONFLICT(key) DO UPDATE SET tries = kid_allow_class.tries + 1, at = excluded.at`).bind(key, k.jobId, now).run();
      const r = await env.DB.prepare('SELECT tries FROM kid_allow_class WHERE key = ?').bind(key).first();
      if ((r?.tries || 0) >= SORT_TRIES) { await keepSort(env.DB, key, k.jobId, null, 'unsorted', now); out.sorted++; } else out.waiting++;
    }
  }
  return out;
}
