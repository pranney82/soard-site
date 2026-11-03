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
 *   reportFitLine({ slides, words, part }) → "Fits on one slide. Committee reports has 20 minutes for 4 reports."
 *   reportAdvice(md, { slides, part })     → [{ id, text, action: { label, run(md) | shorter: true } }], best first
 *   partFor(m, itemId)                     → { name, minutes, reports }: the part the item is in, for the line above
 *   sentencesOf(text)                      → a paragraph's sentences (never at "1.5", "Dr." or "U.S.")
 *
 * No imports from the page: the tests read it as it is.
 */

import { mdBlocks, mdToDoc, docToMd, mdWords, mdPlain } from './board-md.js';
import { sectionPlan, agendaItems, reportsOn, isNothingNew } from './board-shared.js';

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
export function reportFitLine({ slides = 1, words = 0, part = null } = {}) {
  if (!words) return '';
  const fit = slides > 1 ? `${slides} slides in the meeting, ${speakTime(words)}.` : 'Fits on one slide.';
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

/** A paragraph's sentences, in its own words: never split at a number ("1.5"), "Dr.", "U.S." or inside **bold** */
export function sentencesOf(text) {
  const t = String(text || '').replace(/\s*\n\s*/g, ' ').trim();
  const raw = [];
  let start = 0;
  const END = /[.!?]+["”’)\]*_]*\s+/g;
  for (let m = END.exec(t); m; m = END.exec(t)) {
    const end = m.index + m[0].trimEnd().length;
    const next = t[m.index + m[0].length];
    if (!next || !/[\p{Lu}\p{N}"“‘([*_$]/u.test(next)) continue;
    const word = t.slice(start, end).match(/(\S+)$/)?.[1] || '';
    if (m[0][0] === '.' && isAbbr(word.replace(/[”’"')\]*_]+$/, ''))) continue;
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
      return { from: i, to, text: b.text };
    }
    if (ASK.test(plainOf(b))) return { from: i, to: i + 1, text: '' };
  }
  return null;
}

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

/** A heading with nothing under it (the next is a heading, a new slide, or the end) → its index */
const emptyHeading = (blocks) => blocks.findIndex((b, i) => b.t === 'h' && (!blocks[i + 1] || blocks[i + 1].t === 'h' || blocks[i + 1].t === 'hr'));

/**
 * What would make the report read better on the screen, best first: a shorter version when it runs long (the page
 * asks for one: `action.shorter`), the board's ask moved to the top, a long paragraph made points, a heading with
 * nothing under it taken off. Each `action.run(md)` gives the report with it done
 */
export function reportAdvice(md, { slides = 1, part = null } = {}) {
  const text = String(md || '');
  if (!text.trim() || isNothingNew(text)) return [];
  const out = [];
  const words = mdWords(text);
  const { blocks } = parts(text);
  // Long for the meeting: more than one slide, or more than its share of the part's time
  const share = part?.minutes && part.reports ? part.minutes / part.reports : 0;
  if (slides >= 2 || (share && words / 130 > share * 1.1 && words > 120)) {
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
  const long = longParagraph(blocks);
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
