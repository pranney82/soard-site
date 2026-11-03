/**
 * board-md.js — a report's words, kept as Markdown
 * ===========================================================================
 * A committee report (an agenda item's `report`) is written in the editor
 * (./board-report.js, TipTap) and kept as Markdown: headings, paragraphs,
 * points and numbered lists (nested), a callout ("> "), bold, italic and
 * links. The same text is what the board page, the screen, Print it all,
 * search and the server read, so it stays readable as plain text too.
 *
 *   mdBlocks(md)   → the blocks, to draw: [{ t: 'p'|'h', text } | { t: 'quote', blocks } | { t: 'ul'|'ol', start, items: [blocks] } | { t: 'hr' }]
 *                    ("---" alone on a line: a new slide here, on the meeting's screen)
 *   mdInline(text) → a block's words as runs: [{ text, b, i, href } | { br: true }]
 *   mdToDoc(md)    → the editor's document (ProseMirror JSON)
 *   docToMd(doc)   → Markdown from the editor's document
 *   mdPlain(md)    → plain text (search, counts, an email's line)
 *   mdPoints(md)   → a short report that is only its points, for the screen's cards (else null)
 *   mdFigures(t)   → a point's runs with its figures (22, $1,000, 2013) picked out
 *
 * Old notes ("- a point", "  - under it", a line of text) read as they always
 * did. No imports: the server uses it as it is.
 */

const LIST = /^( *)([-*+•]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
// A new slide here: three or more dashes (or * or _) alone on a line
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => !line.trim();

/** A link the board can follow: the web, email, a phone number, or a place on the page */
export function safeHref(href) {
  const h = String(href || '').trim();
  if (/^(https?:\/\/|mailto:|tel:)/i.test(h)) return h;
  if (/^www\.[^\s]+\.[a-z]{2,}/i.test(h)) return `https://${h}`;
  if (/^[/#]/.test(h) && !/^\/\//.test(h)) return h;
  return '';
}

// ─── Reading ────────────────────────────────────────────────────────

/** A run of lines into blocks (the lines already taken out of their list or callout) */
function blocksOf(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    if (RULE.test(line)) { out.push({ t: 'hr' }); i++; continue; }
    let m = line.match(HEADING);
    if (m && indentOf(line) <= 3) { out.push({ t: 'h', text: (m[2] || '').trim() }); i++; continue; }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].match(QUOTE)[1]);
      out.push({ t: 'quote', blocks: blocksOf(inner) });
      continue;
    }
    m = line.match(LIST);
    if (m) { i = listAt(lines, i, out); continue; }
    // A paragraph: its lines until a blank one or another block (each line break kept)
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !(para.length && (RULE.test(lines[i]) || LIST.test(lines[i]) || QUOTE.test(lines[i]) || (HEADING.test(lines[i]) && indentOf(lines[i]) <= 3)))) para.push(lines[i++].trim());
    out.push({ t: 'p', text: para.join('\n') });
  }
  return out;
}

/** A list starting at lines[i]: its items (each with what's indented under it), into `out`. → the next line */
function listAt(lines, i, out) {
  const first = lines[i].match(LIST);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = { t: ordered ? 'ol' : 'ul', start: ordered ? Number.parseInt(first[2], 10) || 1 : 1, items: [] };
  while (i < lines.length) {
    const m = RULE.test(lines[i]) ? null : lines[i].match(LIST);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    // The item's words, then every line indented under it (a blank line inside it, when more of it follows)
    const body = [(m[3] || '').trim()];
    const under = m[1].length + m[2].length + 1;
    i++;
    while (i < lines.length) {
      if (isBlank(lines[i])) {
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) > indent && !(LIST.test(lines[j]) && indentOf(lines[j]) === indent)) { for (; i < j; i++) body.push(''); continue; }
        break;
      }
      if (indentOf(lines[i]) <= indent) break;
      body.push(lines[i].slice(Math.min(indentOf(lines[i]), under)));
      i++;
    }
    list.items.push(blocksOf(body));
    // A blank line between two items of the same list keeps the list going
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j++;
    const next = j < lines.length ? lines[j].match(LIST) : null;
    if (next && next[1].length === indent && /\d/.test(next[2]) === ordered) i = j; else break;
  }
  out.push(list);
  return i;
}

/** Markdown → its blocks, to draw */
export function mdBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
  return blocksOf(lines);
}

/** The closing `**` or `*` (or `__`, `_`) for one opened at `from`: not after a space, not part of a longer run → index or -1 */
function closer(s, from, delim) {
  const ch = delim[0];
  for (let j = s.indexOf(delim, from); j !== -1; j = s.indexOf(delim, j + 1)) {
    if (j <= from || /\s/.test(s[j - 1])) continue;
    // Escaped ("\*") when an odd number of backslashes comes before it ("\\*" is a backslash, then the closer)
    let k = j - 1;
    while (k >= from && s[k] === '\\') k--;
    if ((j - 1 - k) % 2 === 1) continue;
    if (s[j + delim.length] === ch && delim.length === 2) continue; // "***": the last two close the bold
    if (delim.length === 1 && s[j + 1] === ch && s[j - 1] !== ch) continue; // the start of a "**", not this
    if (ch === '_' && /[a-z0-9]/i.test(s[j + delim.length] || '')) continue; // snake_case stays words
    return j;
  }
  return -1;
}

/** "[words](https://…)" at s[i] → { text, href, end } or null */
function linkAt(s, i) {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '[') depth++;
    else if (s[j] === ']' && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== '(') return null;
  let k = j + 2;
  let par = 0;
  for (; k < s.length; k++) {
    if (s[k] === '(') par++;
    else if (s[k] === ')') { if (par === 0) break; par--; } else if (s[k] === '\n') return null;
  }
  if (k >= s.length) return null;
  const href = s.slice(j + 2, k).trim().replace(/^<(.*)>$/, '$1').replace(/\s+"[^"]*"$/, '');
  return { text: s.slice(i + 1, j), href, end: k + 1 };
}

const BARE = /^(?:https?:\/\/|www\.)[^\s<]+/i;
/** A bare web address, without the punctuation after it ("see https://x.org." → https://x.org) */
function bareAt(s, i) {
  const m = s.slice(i).match(BARE);
  if (!m) return null;
  let url = m[0];
  while (/[.,;:!?'"*_]$/.test(url) || (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length)) url = url.slice(0, -1);
  return url.length > 8 ? url : null;
}

/** A block's words as runs: plain text with bold, italic, links and line breaks */
export function mdInline(text, marks = {}) {
  const s = String(text || '');
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ text: buf, ...marks }); buf = ''; } };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\' && /[\\`*_{}[\]()#+\-.!>|~<]/.test(s[i + 1] || '')) { buf += s[i + 1]; i += 2; continue; }
    if (c === '\\' && s[i + 1] === '\n') { flush(); out.push({ br: true }); i += 2; continue; }
    if (c === '\n') { buf = buf.replace(/ +$/, ''); flush(); out.push({ br: true }); i++; continue; }
    if (c === '[' && !marks.href) {
      const l = linkAt(s, i);
      const href = l && safeHref(l.href);
      if (l) { flush(); out.push(...mdInline(l.text, href ? { ...marks, href } : marks)); i = l.end; continue; }
    }
    if (c === '<' && !marks.href) {
      const m = s.slice(i).match(/^<((?:https?:\/\/|mailto:)[^\s>]+)>/i);
      if (m) { flush(); out.push({ text: m[1].replace(/^mailto:/i, ''), ...marks, href: m[1] }); i += m[0].length; continue; }
    }
    if (!marks.href && /[hw]/i.test(c) && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      const url = bareAt(s, i);
      if (url) { flush(); out.push({ text: url, ...marks, href: safeHref(url) }); i += url.length; continue; }
    }
    if (c === '*' || c === '_') {
      const two = s[i + 1] === c;
      const delim = two ? c + c : c;
      const open = s[i + delim.length];
      const intraword = c === '_' && i > 0 && /[a-z0-9]/i.test(s[i - 1]);
      if (open && !/\s/.test(open) && !intraword) {
        const j = closer(s, i + delim.length, delim);
        if (j > i + delim.length - 1 && j !== -1) {
          flush();
          out.push(...mdInline(s.slice(i + delim.length, j), { ...marks, [two ? 'b' : 'i']: true }));
          i = j + delim.length;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// ─── Plain text ─────────────────────────────────────────────────────

const runsText = (runs) => runs.map((r) => (r.br ? '\n' : r.text)).join('');
function plainOf(blocks, depth = 0) {
  const pad = '  '.repeat(depth);
  return blocks.map((b) => {
    if (b.t === 'p' || b.t === 'h') return pad + runsText(mdInline(b.text)).replace(/\n/g, `\n${pad}`);
    if (b.t === 'quote') return plainOf(b.blocks, depth);
    if (b.t === 'hr') return '';
    return b.items.map((it, k) => {
      const [head, ...rest] = it;
      const mark = b.t === 'ol' ? `${b.start + k}.` : '•';
      const first = head && (head.t === 'p' || head.t === 'h') ? runsText(mdInline(head.text)).replace(/\n/g, `\n${pad}  `) : '';
      const more = plainOf(head && (head.t === 'p' || head.t === 'h') ? rest : it, depth + 1);
      return `${pad}${mark} ${first}${more ? `\n${more}` : ''}`;
    }).join('\n');
  }).filter(Boolean).join('\n');
}
/** Plain text: the words as they read, points as "•" (search, word counts, an email's line) */
export const mdPlain = (md) => plainOf(mdBlocks(md));
/** How many words (a list's numbers and points aren't words) */
export const mdWords = (md) => (mdPlain(md).replace(/^\s*(?:•|\d+\.)\s/gm, '').match(/[\p{L}\p{N}][\p{L}\p{N}'’.,-]*/gu) || []).length;

// ─── The editor's document ──────────────────────────────────────────

const LINK_ATTRS = { target: '_blank', rel: 'noopener noreferrer nofollow' };
function pmInline(text) {
  return mdInline(text).flatMap((r) => {
    if (r.br) return [{ type: 'hardBreak' }];
    if (!r.text) return [];
    const marks = [...(r.href ? [{ type: 'link', attrs: { href: r.href, ...LINK_ATTRS } }] : []), ...(r.b ? [{ type: 'bold' }] : []), ...(r.i ? [{ type: 'italic' }] : [])];
    return [{ type: 'text', text: r.text, ...(marks.length ? { marks } : {}) }];
  });
}
function pmBlocks(blocks) {
  return blocks.map((b) => {
    if (b.t === 'p') { const content = pmInline(b.text); return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }; }
    if (b.t === 'h') { const content = pmInline(b.text); return { type: 'heading', attrs: { level: 3 }, ...(content.length ? { content } : {}) }; }
    if (b.t === 'quote') { const content = pmBlocks(b.blocks); return { type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] }; }
    if (b.t === 'hr') return { type: 'horizontalRule' };
    return {
      type: b.t === 'ol' ? 'orderedList' : 'bulletList',
      ...(b.t === 'ol' ? { attrs: { start: b.start } } : {}),
      // An item starts with its words (a paragraph), even one that is only a list under it
      content: b.items.map((it) => { const c = pmBlocks(it); return { type: 'listItem', content: c[0]?.type === 'paragraph' ? c : [{ type: 'paragraph' }, ...c] }; }),
    };
  });
}
/** Markdown → the editor's document (ProseMirror JSON) */
export function mdToDoc(md) {
  const content = pmBlocks(mdBlocks(md));
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

// ─── Writing Markdown ───────────────────────────────────────────────

/** Words that would read as Markdown, made plain: * _ [ ] ` \ anywhere, and what starts a block at a line's start */
function escapeText(t) {
  return t.replace(/[\\*[\]`]/g, '\\$&').replace(/(^|[^a-z0-9])_|_(?=[^a-z0-9]|$)/gi, (m) => m.replace('_', '\\_'));
}
const escapeLineStart = (line) => line.replace(/^(\s*)([#>+-]|\d+(?=[.)]))/, (m, sp, ch) => (/\d/.test(ch) ? `${sp}${ch}\\` : `${sp}\\${ch}`)).replace(/^(\s*\d+)\\([.)])/, '$1\\$2');
const ORDER = ['link', 'bold', 'italic'];
const OPEN = { bold: '**', italic: '*', link: '[' };
const hrefOf = (marks) => marks.find((x) => x.type === 'link')?.attrs?.href || '';
const markKey = (m) => (m.type === 'link' ? `link:${m.attrs?.href || ''}` : m.type);

/** A block's inline content → Markdown (a line break carries the indent of the list it's in) */
function inlineMd(nodes = [], pad = '') {
  let out = '';
  let stack = []; // open marks, outermost first: { type, key, href }
  let pend = ''; // spaces at the end of the last text, written once it's known whether a mark closes first
  // A link whose words are its own address, with nothing else on it, is written bare
  const bare = (n) => n.marks?.length === 1 && n.marks[0].type === 'link' && n.text === n.marks[0].attrs?.href && BARE.test(n.text) && bareAt(n.text, 0) === n.text;
  const close = (to) => {
    while (stack.length > to) {
      const m = stack.pop();
      out += m.type === 'link' ? `](${m.href.replace(/[ ()]/g, (c) => encodeURIComponent(c))})` : m.delim || OPEN[m.type];
    }
  };
  const wantOf = (n) => (n.marks || []).filter((m) => ORDER.includes(m.type) && (m.type !== 'link' || safeHref(m.attrs?.href)))
    .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)).map((m) => ({ type: m.type, key: markKey(m), href: m.type === 'link' ? safeHref(m.attrs.href) : '' }));
  const keys = (list) => list.map((m) => m.key).join('|');
  /**
   * What comes right after an italic run opened at node i (with `outer` the marks outside it): the run goes on while
   * the nodes keep it inside the same marks. Italic at a word's edges is written _so_, so it never runs into the **
   * of bold beside it (*a***b**); inside a word (un*believ*able) it stays *, which _ can't be
   */
  const afterItalic = (i, outer) => {
    const outerKeys = outer ? outer.split('|') : [];
    let last = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const n = nodes[j];
      // A line break closes everything: what follows the italic is a closer or the break
      if (n.type === 'hardBreak') return '\n';
      if (n.type !== 'text' || !n.text) continue;
      const w = wantOf(n);
      const at = w.findIndex((m) => m.type === 'italic');
      if (!bare(n) && at >= 0 && keys(w.slice(0, at)) === outer) { last = n; continue; }
      // The run ends before n: spaces left over come first; else the marks outside it closing, or n's own opening;
      // else n's first letter
      if (/\s$/.test(last.text || '') || /^\s/.test(n.text)) return ' ';
      const goesOn = !bare(n) && keys(w.slice(0, outerKeys.length)) === outer;
      if (outerKeys.length && !goesOn) return '*';
      return !bare(n) && w.length > (goesOn ? outerKeys.length : 0) ? '*' : n.text[0];
    }
    return /\s$/.test(last.text || '') || outerKeys.length ? ' ' : '';
  };
  nodes.forEach((n, i) => {
    if (n.type === 'hardBreak') { close(0); pend = ''; out += `\n${pad}`; return; }
    if (n.type !== 'text' || !n.text) return;
    if (bare(n)) { close(0); out += pend + n.text; pend = ''; return; }
    const want = wantOf(n);
    const [, lead, core, trail] = n.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!core) { pend += lead; return; }
    // Keep what's still wanted, outermost first; close the rest (and all inside it)
    let keep = 0;
    while (keep < stack.length && keep < want.length && stack[keep].key === want[keep].key) keep++;
    close(keep);
    out += pend + lead;
    pend = '';
    for (const m of want.slice(keep)) {
      if (m.type === 'italic') {
        const edge = (c) => !c || !/[\p{L}\p{N}]/u.test(c);
        m.delim = edge(out.slice(-1)) && edge(afterItalic(i, keys(want.slice(0, want.indexOf(m))))) ? '_' : '*';
      }
      out += m.delim || OPEN[m.type];
      stack.push(m);
    }
    out += escapeText(core);
    pend = trail;
  });
  close(0);
  return out + pend.replace(/\s+$/, '');
}

function blockMd(node, pad) {
  switch (node.type) {
    case 'paragraph': return escapeLineStart(inlineMd(node.content, pad).trim());
    case 'heading': return `### ${inlineMd(node.content, pad).trim()}`;
    // A new slide here (the screen starts one at it; ./board-shared.js reportSlides)
    case 'horizontalRule': return '---';
    case 'blockquote': return blocksMd(node.content || [], '').split('\n').map((l) => (l ? `> ${l}` : '>')).join(`\n${pad}`);
    case 'bulletList':
    case 'orderedList': {
      const start = node.type === 'orderedList' ? Number(node.attrs?.start) || 1 : 0;
      return (node.content || []).map((li, k) => {
        const mark = node.type === 'orderedList' ? `${start + k}.` : '-';
        const inner = `${pad}${' '.repeat(mark.length + 1)}`;
        const parts = (li.content || []).map((c) => blockMd(c, inner));
        // The item's first paragraph on its line; what follows indented under it (a blank line before a paragraph)
        const [first = '', ...rest] = (li.content || [])[0]?.type === 'paragraph' ? parts : ['', ...parts];
        let s = `${mark} ${first}`.trimEnd();
        rest.forEach((p, j) => {
          const kind = li.content[(li.content[0]?.type === 'paragraph' ? 1 : 0) + j]?.type;
          s += `${kind === 'paragraph' || kind === 'heading' || kind === 'blockquote' || kind === 'horizontalRule' ? '\n\n' : '\n'}${inner}${p}`;
        });
        return s;
      }).join(`\n${pad}`);
    }
    default: return node.content ? blocksMd(node.content, pad) : '';
  }
}
function blocksMd(nodes, pad = '') {
  const parts = [];
  for (const n of nodes) {
    const md = blockMd(n, pad);
    if (md === '' && n.type === 'paragraph') continue; // an empty paragraph is just space
    parts.push(md);
  }
  return parts.join(`\n\n${pad}`);
}

/** The editor's document → Markdown */
export function docToMd(doc) {
  return blocksMd(doc?.content || []).replace(/\n{3,}/g, '\n\n').trim();
}

// ─── A short report that is only its points ─────────────────────────

/** Most points a slide draws as cards, most words a point may have, and most words in all for one */
export const POINTS_MAX = 6;
export const POINT_WORDS = 32;
export const POINTS_WORDS = 110;

/**
 * A report that is only a few points (2 to 6, each a line or two, nothing under them, no heading), with at most a
 * line before them → { lead, points, numbered, start } for the screen to draw each point as a card; else null (it's
 * drawn as the report it is). `all`: however many points and words in all (each still a line or two), for a report
 * whose presenter chose cards or numbers: the screen gives them as many slides as they take (board-shared.js)
 */
export function mdPoints(md, { all = false } = {}) {
  const blocks = mdBlocks(md);
  const lead = blocks.length === 2 && blocks[0].t === 'p' ? blocks[0] : null;
  const list = blocks[lead ? 1 : 0];
  if (blocks.length !== (lead ? 2 : 1) || !list || (list.t !== 'ul' && list.t !== 'ol')) return null;
  const { items } = list;
  if (items.length < 2 || (!all && items.length > POINTS_MAX)) return null;
  if (!items.every((it) => it.length === 1 && it[0].t === 'p' && it[0].text.trim())) return null;
  const words = (t) => mdWords(t);
  if (items.some((it) => words(it[0].text) > POINT_WORDS) || (lead && words(lead.text) > POINT_WORDS) || (!all && words(md) > POINTS_WORDS)) return null;
  return { lead: lead ? lead.text : '', points: items.map((it) => it[0].text), numbered: list.t === 'ol', start: list.t === 'ol' ? list.start || 1 : 1 };
}

// A quantity: 22, 1,000+, $12,500.50, 40%, $1.2M, 3x, the 15th, 2026–27 (a year's span), 3–5
const NUMBER = /\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:(?<=\b\d{4})[–-]\d{2}(?!\d)|–\d+)?(?:%|\+|[KMB](?![\p{L}\p{N}])|x(?![\p{L}\p{N}])|st|nd|rd|th)?/gu;
const MONTH_BEFORE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+$/i;
/** Whether a number found at [i, j) of `t` is a figure, not part of a name, a time, a date or a phone number */
function isFigure(t, i, j) {
  const before = t[i - 1] || '';
  const after = t[j] || '';
  if (/[\p{L}\p{N}\-–/.,:$]/u.test(before)) return false; // W-9, Q4, 1099, 5:30's 30
  if (/[\p{L}\p{N}\-–/:]/u.test(after) || (/[.,]/.test(after) && /\d/.test(t[j + 1] || ''))) return false; // 20-second, 5:30, Form 1099-NEC
  if (before === '(' && after === ')') return false; // (770) 555-1234
  if (MONTH_BEFORE.test(t.slice(Math.max(0, i - 12), i))) return false; // Nov 5
  return true;
}

/**
 * A point's words as runs, each figure in it a run of its own (22 families, $1,000, since 2013, 40%), so the screen
 * can make the numbers stand out → [{ text, b, i, href, fig } | { br }]. A number inside a name (W-9, Q4, 20-second),
 * a time, a date or a phone number isn't a figure; nor is anything in a link.
 */
export function mdFigures(text) {
  return mdInline(text).flatMap((r) => {
    if (r.br || r.href) return [r];
    const out = [];
    let at = 0;
    for (const m of r.text.matchAll(NUMBER)) {
      const j = m.index + m[0].length;
      if (!isFigure(r.text, m.index, j)) continue;
      if (m.index > at) out.push({ ...r, text: r.text.slice(at, m.index) });
      out.push({ ...r, text: m[0], fig: true });
      at = j;
    }
    if (at < r.text.length) out.push({ ...r, text: r.text.slice(at) });
    return out;
  });
}

/**
 * A point drawn as a big number: its first figure, large, and its words to go under it → { fig, runs, alone }
 * (mdFigures' runs), or null when it has no figure. A figure that starts or ends the point ("38 volunteers built
 * porches", "The gala brought in $412,000.") is said once, large, its words under it without it (`alone`); one in the
 * middle stays in its words too, so they read whole ("We raised $412,000 at the gala")
 */
export function mdNumber(text) {
  const runs = mdFigures(text);
  const k = runs.findIndex((r) => r.fig);
  if (k < 0) return null;
  const fig = runs[k].text;
  const empty = (xs) => xs.every((r) => !r.br && !/[\p{L}\p{N}]/u.test(r.text));
  // The words either side, trimmed where the figure was (and the stop at its end): two words at least, else all of it
  const trim = (xs, at) => {
    const out = xs.map((r) => ({ ...r }));
    if (at === 'start') { while (out.length && !out[0].br && !out[0].text.trim()) out.shift(); if (out[0]?.text) out[0].text = out[0].text.trimStart(); }
    while (out.length && !out.at(-1).br && !out.at(-1).text.trim()) out.pop();
    if (out.length && out.at(-1).text) out.at(-1).text = out.at(-1).text.replace(/[\s,:;–—-]+$/, '').replace(/(?<![.])\.$/, '');
    return out.filter((r) => r.br || r.text);
  };
  const words = (xs) => (xs.map((r) => r.text || ' ').join('').match(/[\p{L}\p{N}]+/gu) || []).length;
  const before = runs.slice(0, k);
  const after = runs.slice(k + 1);
  if (empty(before)) { const rest = trim(after, 'start'); if (words(rest) >= 2) return { fig, runs: rest, alone: true }; }
  if (empty(after)) { const rest = trim(before, 'end'); if (words(rest) >= 2) return { fig, runs: rest, alone: true }; }
  return { fig, runs, alone: false };
}
