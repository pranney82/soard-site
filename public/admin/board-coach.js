/**
 * board-coach.js — a word beside a report as it's written
 * ===========================================================================
 * Under the report editor (the presenter's report page, ./board/portal.js, and
 * Board's agenda editor, ./board-meeting.js): how it will show in the meeting
 * (how many slides, how long to present, the part's time), then at most one
 * suggestion at a time, each with a button that does it (./board-report.js
 * ReportCoach draws them). Nothing here changes a report by itself: each
 * suggestion's `run(md)` gives the new Markdown, and the page puts it in only
 * when the person presses its button.
 *
 *   reportFitLine({ slides, words, part }) → "Your report fits on one slide. Committee reports has 20 minutes for 4 reports."
 *   reportLooks(md, look)                 → { options, on, best, offered }: the ways it can show (cards, bullet points…)
 *   asBullets(md)                         → its paragraphs made bullet points, every word kept
 *   reportAdvice(md, { slides, part })     → [{ id, text, action: { label, run(md) | shorter: true } }], best first
 *   partFor(m, itemId)                     → { name, minutes, reports }: the part the item is in, for the line above
 *   sentencesOf(text)                      → a paragraph's sentences (never at "1.5", "Dr." or "U.S.")
 *
 * No imports from the page: the tests read it as it is.
 */

import { mdBlocks, mdToDoc, docToMd, mdWords, mdPlain, mdPoints, mdNumber, POINT_WORDS } from './board-md.js';
import { sectionPlan, agendaItems, reportsOn, isNothingNew, shownLook, CARDS_PER_SLIDE } from './board-shared.js';

/** "about 2 minutes to present" (read aloud, about 130 words a minute) */
export const speakTime = (words) => {
  const n = Math.round(words / 130);
  return n < 1 ? 'under a minute to present' : `about ${n} ${n === 1 ? 'minute' : 'minutes'} to present`;
};

/** The part an item is in: its name (or "Part 3"), its minutes (sectionPlan), and how many of its items report */
export function partFor(m, itemId) {
  const at = m ? agendaItems(m).find((x) => x.id === itemId) : null;
  const sec = at ? m.sections[at.si] : null;
  if (!sec) return null;
  const minutes = sectionPlan(m).get(sec.id)?.minutes || 0;
  const reports = sec.items.filter((x) => String(x.report || '').trim() || reportsOn(x)).length;
  return { name: String(sec.title || '').trim() || `Part ${at.si + 1}`, minutes, reports };
}

/** How it will show: its slides, how long to present them, and the part's time (only parts have one) */
export function reportFitLine({ slides = 1, words = 0, part = null, whose = 'Your' } = {}) {
  if (!words) return '';
  const fit = slides > 1 ? `${whose} report: ${slides} slides, ${speakTime(words)}.` : `${whose} report fits on one slide.`;
  const share = part?.minutes && part.reports > 1 ? ` ${part.name} has ${part.minutes} minutes for ${part.reports} reports.`
    : part?.minutes ? ` ${part.name} has ${part.minutes} minutes.` : '';
  return fit + share;
}

// ─── Sentences ──────────────────────────────────────────────────────

// Words a period ends without ending the sentence: titles, "etc.", months, and initials ("J.", "U.S.", "e.g.")
const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'inc', 'ltd', 'co', 'corp', 'no', 'vs', 'etc', 'approx', 'dept', 'est', 'mt', 'ave', 'blvd', 'rd', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'fig', 'p', 'pp']);
const isAbbr = (word) => {
  const w = word.replace(/^[*_("“‘[]+/, '');
  if (/^(?:\p{L}\.){2,}\p{L}?\.?$/u.test(w) || /^\p{Lu}\.$/u.test(w)) return true; // U.S., e.g., J.
  return ABBR.has(w.replace(/\.$/, '').toLowerCase());
};
// Each "**", and each lone * or _ that opens or closes emphasis, and links' brackets: a sentence that leaves one open
// isn't one yet
const balanced = (s) => {
  const t = s.replace(/\\./g, '');
  const bold = (t.match(/\*\*/g) || []).length;
  const lone = (t.replace(/\*\*/g, '').match(/(?<![\p{L}\p{N}])[*_]|[*_](?![\p{L}\p{N}])/gu) || []).length;
  return bold % 2 === 0 && lone % 2 === 0 && (t.match(/\[/g) || []).length === (t.match(/\]/g) || []).length && (t.match(/\(/g) || []).length === (t.match(/\)/g) || []).length;
};

/** Whether a quotation opened in `s` is still open at its end ("…, or “… without its ”) */
const quoteOpen = (s) => (s.match(/"/g) || []).length % 2 === 1 || (s.match(/“/g) || []).length > (s.match(/”/g) || []).length;

/** A paragraph's sentences, in its own words: never split at a number ("1.5"), "Dr.", "U.S." or inside **bold** */
export function sentencesOf(text) {
  const t = String(text || '').replace(/\s*\n\s*/g, ' ').trim();
  const raw = [];
  let start = 0;
  const END = /[.!?]+["”’)\]*_]*\s+/g;
  for (let m = END.exec(t); m; m = END.exec(t)) {
    const end = m.index + m[0].trimEnd().length;
    const next = t[m.index + m[0].length];
    if (!next || !/[\p{Lu}\p{Lo}\p{N}"“‘([*_$¿¡]/u.test(next)) continue;
    const word = t.slice(start, end).match(/(\S+)$/)?.[1] || '';
    if (m[0][0] === '.' && isAbbr(word.replace(/[”’"')\]*_]+$/, ''))) continue;
    // Never inside a quotation: She said "We love it. Thank you." is one sentence
    if (quoteOpen(t.slice(start, end))) continue;
    raw.push(t.slice(start, end));
    start = m.index + m[0].length;
  }
  raw.push(t.slice(start));
  // Joined again where a sentence would leave emphasis or a link open
  const out = [];
  for (const s of raw.map((x) => x.trim()).filter(Boolean)) {
    if (out.length && !balanced(out.at(-1))) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out;
}

// ─── Suggestions ────────────────────────────────────────────────────

// What the board is asked: to decide, approve or vote; "what we need from the board"; the outline's own heading
const ASK = /\b(?:needs?\s+(?:from\s+)?the\s+board|need\s+from\s+the\s+board|ask(?:ing)?\s+the\s+board|for\s+the\s+board\s+to|the\s+board\s+(?:needs\s+to\s+|to\s+)?(?:decide|approve|vote|consider|act)|(?:decision|vote|approval)s?\s+(?:needed|we\s+need|requested)|what\s+we\s+need|we\s+ask|please\s+(?:approve|vote|decide)|board\s+action)\b/i;
// A block's words as plain text (a list's points one after another)
const plainOf = (b) => (b.t === 'hr' ? '' : b.t === 'p' || b.t === 'h' ? mdPlain(b.text) : b.t === 'quote' ? b.blocks.map(plainOf).join(' ') : b.items.map((it) => it.map(plainOf).join(' ')).join(' '));
const wordsOfBlock = (b) => (b.t === 'hr' ? 0 : b.t === 'p' || b.t === 'h' ? mdWords(b.text) : (plainOf(b).match(/[\p{L}\p{N}][\p{L}\p{N}'’.,-]*/gu) || []).length);

/** The report's top blocks with the editor's document beside them (the same order: mdToDoc keeps it), to move or change */
function parts(md) {
  const blocks = mdBlocks(md);
  const doc = mdToDoc(md);
  return { blocks, doc, nodes: blocks.length ? doc.content : [] };
}
const withNodes = (doc, nodes) => docToMd({ ...doc, content: nodes.length ? nodes : [{ type: 'paragraph' }] });

/** Where the board's ask is, when it's in the second half: { from, to, text } (a heading with what's under it, or one block) */
function askLate(blocks) {
  const total = blocks.reduce((n, b) => n + wordsOfBlock(b), 0);
  if (total < 40) return null;
  let before = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const late = before >= total / 2;
    before += wordsOfBlock(b);
    if (!late || b.t === 'hr') continue;
    if (b.t === 'h') {
      if (!ASK.test(b.text)) continue;
      let to = i + 1;
      while (to < blocks.length && blocks[to].t !== 'h' && blocks[to].t !== 'hr') to++;
      if (to === i + 1) continue; // nothing under it to move
      return joins(blocks, i, to) ? null : { from: i, to, text: b.text };
    }
    if (ASK.test(plainOf(b))) return joins(blocks, i, i + 1) ? null : { from: i, to: i + 1, text: '' };
  }
  return null;
}
/** Whether moving blocks [from, to) to the top would run two lists into one: its last against the first block, or
 *  the blocks either side of where it was (two lists of the same kind side by side are read as one) */
const sameList = (a, b) => !!a && !!b && (a.t === 'ul' || a.t === 'ol') && a.t === b.t;
const joins = (blocks, from, to) => sameList(blocks[to - 1], blocks[0]) || sameList(blocks[from - 1], blocks[to]);

/** A paragraph long for a screen, with sentences to make points of → { at, points } (none when the report has a list) */
function longParagraph(blocks) {
  if (blocks.some((b) => b.t === 'ul' || b.t === 'ol')) return null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.t !== 'p') continue;
    const words = mdWords(b.text);
    const points = sentencesOf(b.text);
    if (points.length < 2 || (words <= 60 && points.length < 3)) continue;
    // Each point a paragraph of its own words, and every word kept: else it isn't offered
    const ok = points.every((s) => { const x = mdBlocks(s); return x.length === 1 && x[0].t === 'p'; })
      && points.reduce((n, s) => n + mdWords(s), 0) === words;
    if (ok) return { at: i, points };
  }
  return null;
}

// ─── How it shows ───────────────────────────────────────────────────

const isList = (b) => b?.t === 'ul' || b?.t === 'ol';
/** A paragraph that is only what leads into the list after it: a report's points' first line (mdPoints' lead), or
 *  one sentence ending in a colon ("Two changes come to the board in February:") */
const leadsIn = (blocks, i) => isList(blocks[i + 1]) && ((i === 0 && blocks.length === 2 && mdWords(blocks[0].text) <= POINT_WORDS) || (/:\s*$/.test(blocks[i].text) && sentencesOf(blocks[i].text).length === 1));
/** A paragraph that isn't only what leads into a list */
const hasProse = (blocks) => blocks.some((b, i) => b.t === 'p' && !leadsIn(blocks, i));
/** A paragraph's sentences, when every word of it is in them, each a paragraph of its own; else null. A line it breaks
 *  onto (Shift+Enter, a pasted list) starts a sentence of its own: lines are never run together */
const wholeSentences = (text) => {
  const said = String(text).split('\n').map((l) => l.trim()).filter(Boolean).flatMap((l) => sentencesOf(l));
  const ok = said.every((s) => { const x = mdBlocks(s); return x.length === 1 && x[0].t === 'p'; }) && said.reduce((n, s) => n + mdWords(s), 0) === mdWords(text);
  return ok ? said : null;
};

/**
 * The report with its paragraphs made bullet points, each sentence one (a paragraph that can't be cut into whole
 * sentences, one point), joined to a list of points beside them; what leads into a list stays a line over it ("Two
 * changes come to the board in February:"); headings, callouts and numbered lists as they were. Every word kept, else
 * null
 */
export function asBullets(md) {
  const p = parts(md);
  const out = [];
  const push = (n) => { const prev = out.at(-1); if (n.type === 'bulletList' && prev?.type === 'bulletList') out[out.length - 1] = { ...prev, content: [...prev.content, ...n.content] }; else out.push(n); };
  const points = (nodes) => { if (nodes.length) push({ type: 'bulletList', content: nodes.map((x) => ({ type: 'listItem', content: [x] })) }); };
  p.blocks.forEach((b, i) => {
    if (b.t !== 'p' || leadsIn(p.blocks, i)) { push(p.nodes[i]); return; }
    const said = wholeSentences(b.text);
    if (!said || said.length < 2) { points([p.nodes[i]]); return; }
    // (its last sentence leading into the list after it: that stays the line over the list)
    const intro = isList(p.blocks[i + 1]) && /:\s*$/.test(said.at(-1)) ? said.pop() : null;
    points(said.map((s) => mdToDoc(s).content[0]));
    if (intro) out.push(mdToDoc(intro).content[0]);
  });
  const next = withNodes(p.doc, out);
  return mdWords(next) === mdWords(md) ? next : null;
}

/** Why a report (its paragraphs made points) can't be cards: '' when it can */
function cardsWhy(md) {
  if (!md) return 'Cards are for a report of points only.';
  if (mdPoints(md, { all: true })) return '';
  const blocks = mdBlocks(md);
  const lists = blocks.filter(isList);
  if (blocks.some((b) => b.t === 'h' || b.t === 'quote' || b.t === 'hr') || lists.length !== 1) return 'Cards are for a report of points only, without headings or callouts.';
  const items = lists[0].items;
  if (blocks[0].t === 'p' && blocks.length === 2 && mdWords(blocks[0].text) > POINT_WORDS) return 'Cards have room for a line or two above them. A shorter opening, or that paragraph as points, can be cards.';
  if (items.length < 2) return 'Cards need two points or more.';
  if (items.some((it) => it.length !== 1 || it[0].t !== 'p')) return 'Cards are for points with nothing under them.';
  return 'Each card holds a line or two, and a point here is longer. Shorter points can be cards.';
}

/**
 * The ways a report can show on the meeting's screen, for the choice beside the editor → { options, on, best, offered },
 * or null when it has no words. Each option { id, look, md, ok, why }: `id` cards | points | text | numbers (Cards,
 * Bullet points, Paragraphs, Big numbers); `look` the item's reportLook it saves (./board-shared.js shownLook); `md`
 * the report as it has to be written for it (its paragraphs made points: asBullets), or null when it stays as it is;
 * `ok` whether this report can show that way, `why` not, when it can't. `on`: the one showing now, with the item's
 * `look`; `best`: the one that reads best (big numbers for a few points that each start or end with one; cards for a
 * few short points, or a paragraph of a few short sentences; bullet points for a long paragraph; else as written);
 * `offered`: more than one way to choose from
 */
export function reportLooks(md, look = '') {
  const text = String(md || '').trim();
  if (!text || isNothingNew(text) || !/[\p{L}\p{N}]/u.test(mdPlain(text))) return null;
  const blocks = mdBlocks(text);
  const prose = hasProse(blocks);
  const bullets = prose ? asBullets(text) : text;
  const change = prose ? bullets : null;
  const pts = bullets ? mdPoints(bullets, { all: true }) : null;
  const nums = pts ? pts.points.map((t) => mdNumber(t)) : [];
  const numbers = !!pts && nums.every(Boolean);
  // Bullet points, from paragraphs: when they'd be two or more (one sentence as a point is the sentence)
  const listed = !!bullets && (!prose || mdBlocks(bullets).some((b) => b.t === 'ul' && b.items.length >= 2));
  const cards = pts ? '' : cardsWhy(bullets);
  const options = [
    { id: 'cards', look: 'cards', md: change, ok: !!pts, why: cards },
    { id: 'points', look: 'list', md: change, ok: listed, why: listed ? '' : 'One sentence makes one point. Write a few to show them as points.' },
    { id: 'text', look: 'list', md: null, ok: prose, why: prose ? '' : 'It’s all points. A paragraph written in it shows as one.' },
    { id: 'numbers', look: 'numbers', md: change, ok: numbers, why: numbers ? '' : pts ? 'Big numbers need a number in every point.' : cards },
  ];
  const shown = shownLook(text, look);
  const on = shown === 'cards' ? 'cards' : shown === 'numbers' ? 'numbers' : prose ? 'text' : 'points';
  const few = !!pts && pts.points.length <= CARDS_PER_SLIDE;
  const sentences = blocks.filter((b) => b.t === 'p').reduce((n, b) => n + sentencesOf(b.text).length, 0);
  const best = numbers && few && nums.every((x) => x.alone) ? 'numbers'
    : !prose ? (mdPoints(text) ? 'cards' : 'points')
    : pts && mdPoints(bullets) && sentences >= 3 ? 'cards'
    : listed && blocks.some((b) => b.t === 'p' && (mdWords(b.text) > 60 || sentencesOf(b.text).length >= 3)) ? 'points'
    : 'text';
  return { options, on, best: options.some((o) => o.id === best && o.ok) ? best : on, offered: options.filter((o) => o.ok).length > 1 };
}

/** A heading with nothing under it (the next is a heading, a new slide, or the end) → its index */
const emptyHeading = (blocks) => blocks.findIndex((b, i) => b.t === 'h' && (!blocks[i + 1] || blocks[i + 1].t === 'h' || blocks[i + 1].t === 'hr'));

/**
 * What would make the report read better on the screen, best first: a shorter version when it runs long (the page
 * asks for one: `action.shorter`), the board's ask moved to the top, how it shows (cards for a few short sentences,
 * big numbers for points that each start or end with one: `action.look`, the reportLook it sets, where the page `picks`
 * one and none is chosen), a long paragraph made points (none once a way is chosen: it's theirs), a heading with nothing
 * under it taken off. Each `action.run(md)` gives the report
 * with it done
 */
export function reportAdvice(md, { slides = 1, part = null, look = '', picks = false } = {}) {
  const text = String(md || '');
  if (!text.trim() || isNothingNew(text)) return [];
  const out = [];
  const words = mdWords(text);
  const { blocks } = parts(text);
  // Long for the meeting: more than one slide, or more than its share of the part's time
  const share = part?.minutes && part.reports ? part.minutes / part.reports : 0;
  // (cards or big numbers across slides were chosen as that: their slides are the points, not too many words)
  if ((slides >= 2 && shownLook(text, look) === 'words') || (share && words / 130 > share * 1.1 && words > 120)) {
    out.push({
      id: 'shorter',
      text: slides >= 2 ? `It runs to ${slides} slides. A shorter version keeps every fact and figure.` : `It’s long for its share of ${part.name}’s time. A shorter version keeps every fact and figure.`,
      action: { label: 'Write a shorter version', shorter: true },
    });
  }
  const ask = askLate(blocks);
  if (ask) {
    out.push({
      id: `first:${ask.text || plainOf(blocks[ask.from]).slice(0, 40)}`,
      text: 'Put what you need from the board first? The board reads the ask before the details.',
      action: {
        label: 'Move it to the top',
        run: (cur) => {
          const p = parts(cur);
          const a = askLate(p.blocks);
          if (!a) return cur;
          const moved = p.nodes.slice(a.from, a.to);
          return withNodes(p.doc, [...moved, ...p.nodes.slice(0, a.from), ...p.nodes.slice(a.to)]);
        },
      },
    });
  }
  // How it shows, while its writer hasn't chosen: what reads best when it isn't what shows (reportLooks)
  const looks = !picks || look ? null : reportLooks(text);
  if (looks && looks.best !== looks.on && (looks.best === 'cards' || looks.best === 'numbers')) {
    const best = looks.best;
    const o = looks.options.find((x) => x.id === best);
    const n = mdPoints(o.md || text, { all: true })?.points.length || 0;
    out.push({
      id: `look:${best}`,
      text: best === 'numbers' ? 'Each point starts or ends with a number. Show the numbers big, one to a card?' : `These sentences read as ${n} short points. Show each on a card?`,
      action: { label: best === 'numbers' ? 'Show the numbers big' : 'Show as cards', look: o.look, run: o.md ? (cur) => reportLooks(cur)?.options.find((x) => x.id === best)?.md || cur : null },
    });
  }
  const long = look ? null : longParagraph(blocks);
  if (long) {
    out.push({
      id: `points:${long.points[0].slice(0, 40)}`,
      text: 'This paragraph is long for a screen. Make it points? Each sentence becomes one.',
      action: {
        label: 'Make it points',
        run: (cur) => {
          const p = parts(cur);
          const l = longParagraph(p.blocks);
          if (!l) return cur;
          const list = { type: 'bulletList', content: l.points.map((s) => ({ type: 'listItem', content: [mdToDoc(s).content[0]] })) };
          return withNodes(p.doc, [...p.nodes.slice(0, l.at), list, ...p.nodes.slice(l.at + 1)]);
        },
      },
    });
  }
  const empty = emptyHeading(blocks);
  if (empty >= 0) {
    const name = mdPlain(blocks[empty].text).trim();
    out.push({
      id: `empty:${name}`,
      text: name ? `“${name}” has nothing under it.` : 'A heading has nothing under it.',
      action: {
        label: 'Take the heading off',
        run: (cur) => {
          const p = parts(cur);
          const at = emptyHeading(p.blocks);
          return at < 0 ? cur : withNodes(p.doc, [...p.nodes.slice(0, at), ...p.nodes.slice(at + 1)]);
        },
      },
    });
  }
  return out;
}
