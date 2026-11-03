/**
 * A shorter version of a report, for the meeting's screen: written by the site's model (Workers AI), offered to the
 * presenter beside their report, never saved here (they take it or keep theirs). It only ever comes back when it says
 * the same things: every figure and link in it was in theirs, every figure in theirs is still in it, every heading kept,
 * and it is really shorter. Else a plain reason, and theirs stays as it is.
 *
 *   shorterReport(env, md, { title })      → { ok: true, text, words: [before, after] } | { ok: false, error }
 *   shorterFor(env, { id, itemId, text, title }, who)  the endpoints': who may ask (the presenter, or an admin) and how
 *                                          often (10 a minute, 60 a day each), then shorterReport
 */
import { mdBlocks, mdPlain, mdWords } from '../../public/admin/board-md.js';
import { presenterGate } from './_board.js';
import { limitAll } from './_rate-limit.js';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
/** About 3,000 words: more than a screen's report ever is, and what the model reads well in one go */
export const SHORTER_MAX_WORDS = 3000;
/** Shorter by at least this much, or it isn't worth offering */
const AT_LEAST = 0.15;

const SYSTEM = `You shorten a committee report for a nonprofit's board meeting, where it is shown on a screen.
Rewrite it shorter. Keep every fact, number, amount, date, name and decision exactly as written, and keep its headings (the lines starting "###") and their order. Prefer short points over long sentences. Add nothing that isn't in it: no new facts, figures, links, opinions or headings.
Write Markdown only, using just: "###" headings, "- " points, "1. " numbered points, **bold**, *italic*, [links](url) from the report, and "---" on a line of its own where the report has one.
Answer with the shorter report alone: no introduction, no notes, no code fences.`;

const err = (message, status) => Object.assign(new Error(message), { status });
const FACTS = 'A shorter version would have changed the facts, so yours stays as it is.';

/** The model's answer as the report alone: no code fence around it, no "Here is…" before it or "Let me know…" after */
export function cleanAnswer(raw) {
  let t = String(raw || '').replace(/\r\n?/g, '\n').trim();
  const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n?```\s*$/);
  if (fence) t = fence[1].trim();
  const lines = t.split('\n');
  const intro = /^(here(’s|'s| is| are)|sure\b|certainly\b|below\b|the (shorter|shortened|condensed|revised) (version|report))[^\n]*[:.!]?\s*$/i;
  while (lines.length && (intro.test(lines[0].trim()) || !lines[0].trim())) lines.shift();
  const outro = /^(let me know|i hope|i('ve| have) (kept|shortened)|note:|this (version|shorter))/i;
  while (lines.length && (outro.test(lines.at(-1).trim()) || !lines.at(-1).trim())) lines.pop();
  t = lines.join('\n').trim();
  const inner = t.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  return (inner ? inner[1] : t).trim();
}

// A figure as written: its sign, $, the number, then % or how big (thousand, million, billion; k, M, B)
const FIGURE = /(?<![\p{L}\p{N}.])([-−](?=\s?\$?\d))?\s?(\$)?\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(%)|\s?(k|K|M|B|thousand|million|billion)(?![\p{L}\p{N}]))?/gu;
const SCALE = { k: 'K', K: 'K', thousand: 'K', M: 'M', million: 'M', B: 'B', billion: 'B' };
/**
 * The figures a report states, in order, each as one token: its sign, $, the number (no commas, no trailing zeros), %
 * or its size ("-$4000", "40%", "$1.2M"). List numbers ("1.") aren't figures
 */
export function figureList(md) {
  const plain = mdPlain(md).replace(/^\s*(?:•|\d+\.)\s/gm, '');
  return [...plain.matchAll(FIGURE)].map((m) => `${m[1] ? '-' : ''}${m[2] || ''}${m[3].replace(/,/g, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}${m[4] || SCALE[m[5]] || ''}`);
}
/** …as a set */
export const figuresOf = (md) => new Set(figureList(md));
/** Whether `sub` is `all` with some taken out (nothing added, nothing moved) */
const inOrder = (sub, all) => { let i = 0; for (const x of all) if (x === sub[i]) i++; return i === sub.length; };
/**
 * The links a report has: its [text](url) ones, <…> ones, and any written out (http(s)://, www., mailto:, tel:), each
 * without what ends a sentence after it
 */
export function linksOf(md) {
  const s = String(md || '');
  const out = new Set();
  const trim = (u) => u.replace(/[.,;:!?]+$/, '').toLowerCase();
  for (const m of s.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.add(trim(m[1]));
  const rest = s.replace(/\]\([^)]*\)/g, ']');
  for (const m of rest.matchAll(/<([^<>\s]+)>/g)) if (/[:.@]/.test(m[1])) out.add(trim(m[1]));
  for (const m of rest.replace(/<[^<>\s]+>/g, ' ').matchAll(/\b(?:https?:\/\/|www\.|mailto:|tel:)[^\s)<>\]]+/gi)) out.add(trim(m[0]));
  return out;
}
/** Its headings, as their words read (marks aside) */
export function headingsOf(md) {
  const out = [];
  const walk = (blocks) => blocks.forEach((b) => {
    if (b.t === 'h') out.push(mdPlain(`### ${b.text}`).replace(/\s+/g, ' ').replace(/[.:\s]+$/, '').trim().toLowerCase());
    else if (b.t === 'quote') walk(b.blocks);
    else if (b.items) b.items.forEach(walk);
  });
  walk(mdBlocks(md));
  return out.filter(Boolean);
}

/** Why `out` can't stand in for `md` ('' when it can) */
export function shorterProblem(md, out) {
  if (!out || !mdBlocks(out).length || !mdWords(out)) return 'The shorter version came back empty, so yours stays as it is.';
  // Its figures are yours, in your order: none added, none moved, none with another sign, unit or size; and every one
  // of yours is still in it
  const had = figureList(md);
  const has = figureList(out);
  if (!inOrder(has, had)) return FACTS;
  if (had.some((n) => !has.includes(n))) return 'A shorter version would have left out some of your figures, so yours stays as it is.';
  const links = linksOf(md);
  if ([...linksOf(out)].some((u) => !links.has(u))) return FACTS;
  const heads = new Set(headingsOf(out));
  if (headingsOf(md).some((x) => !heads.has(x))) return 'A shorter version would have lost one of your headings, so yours stays as it is.';
  const mine = new Set(headingsOf(md));
  if ([...heads].some((x) => !mine.has(x))) return FACTS;
  if (mdWords(out) > mdWords(md) * (1 - AT_LEAST)) return 'It couldn’t be made much shorter without losing something, so yours stays as it is.';
  return '';
}

/** The model's shorter version of `md`, checked (shorterProblem) */
export async function shorterReport(env, md, { title = '' } = {}) {
  const text = String(md || '').replace(/\r\n?/g, '\n').trim();
  const before = mdWords(text);
  if (!before) return { ok: false, error: 'There’s nothing written to shorten yet.' };
  if (before < 30) return { ok: false, error: 'It’s already short.' };
  if (before > SHORTER_MAX_WORDS) return { ok: false, error: `It’s over ${SHORTER_MAX_WORDS.toLocaleString('en-US')} words, too long to shorten in one go. Shorten one part at a time.` };
  if (!env?.AI?.run) return { ok: false, error: 'Shorter versions aren’t available right now.' };
  let raw = '';
  try {
    const out = await Promise.race([
      env.AI.run(MODEL, {
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${title ? `The agenda item: ${title}\n\n` : ''}The report:\n\n${text}` }],
        max_tokens: Math.min(4096, Math.ceil(before * 2) + 200), temperature: 0.2,
      }),
      new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 45000)),
    ]);
    raw = typeof out?.response === 'string' ? out.response : typeof out === 'string' ? out : '';
  } catch (e) {
    console.error('[board-shorter]', e.message);
    return { ok: false, error: 'A shorter version couldn’t be written just now. Try again in a minute.' };
  }
  const short = cleanAnswer(raw);
  const problem = shorterProblem(text, short);
  if (problem) return { ok: false, error: problem };
  return { ok: true, text: short, words: [before, mdWords(short)] };
}

/**
 * The endpoints' way in: on the board page only who presents the item (or an admin) may ask, on a meeting they can
 * write in (presenterGate); in Board any admin, an item not saved yet too. 10 a minute and 60 a day each
 */
export async function shorterFor(env, { id = '', itemId = '', text = '', title = '' } = {}, { member = null, admin = false, adminEmail = '' } = {}) {
  if (typeof text !== 'string') throw err('What does the report say?', 400);
  if (!member && !admin) throw err('The board page is for SOARD’s board members', 403);
  let name = String(title || '').slice(0, 200);
  if (member) {
    const { it } = await presenterGate(env, id, itemId, { member, admin });
    name = it.title || name;
  }
  const key = member?.slug || String(adminEmail || '').toLowerCase() || 'admin';
  const r = await limitAll(env.DB, [[`board-shorter:min:${key}`, 10, 60], [`board-shorter:day:${key}`, 60, 86400]]);
  if (!r.ok) throw err(r.retryAfter > 120 ? 'That’s the most shorter versions for today. Try again tomorrow.' : 'That’s a lot of shorter versions at once. Try again in a minute.', 429);
  return shorterReport(env, text, { title: name });
}
