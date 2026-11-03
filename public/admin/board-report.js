/**
 * board-report.js — a committee report: written, and read
 * ===========================================================================
 * The presenter of an agenda item writes their report on the board page
 * (./board/portal.js, its own page per item); Board's admins can in the
 * agenda editor (./board-meeting.js). Both use ReportEditor: TipTap, kept as
 * Markdown (./board-md.js). It takes Markdown as it's typed ("### " a
 * heading, "- " a point, "1. " a list, "> " a callout, **bold**, *italic*),
 * cleans what's pasted from Word or Google Docs, and turns pasted Markdown
 * into what it says.
 *
 * Report draws one for reading (the board page, the live room, the screen);
 * reportDom draws one for paper (./board/print.js). A report that is only
 * NOTHING_NEW ("Nothing new to report this time.") reads quietly in both.
 * Motion and motionDom draw what the presenter asks the board to vote on
 * (item.motion), under the report wherever it's read.
 */

import { h, htm, useState, useEffect, useRef, useMemo, Editor, StarterKit, TiptapLink, Placeholder, CharacterCount, DOMPurify } from './vendor.js';
import { mdBlocks, mdInline, mdToDoc, docToMd, mdWords, safeHref } from './board-md.js';
import { LIMITS, NOTHING_NEW, isNothingNew, reportSlides } from './board-shared.js';
import { reportAdvice, reportFitLine, reportLooks, speakTime } from './board-coach.js';

const html = htm.bind(h);

// ─── Reading ────────────────────────────────────────────────────────

const LINK = { target: '_blank', rel: 'noopener noreferrer nofollow' };
function Runs({ text, runs = null }) {
  return (runs || mdInline(text)).map((r, k) => {
    if (r.br) return html`<br key=${k} />`;
    let node = r.text;
    if (r.i) node = html`<em>${node}</em>`;
    if (r.b) node = html`<strong>${node}</strong>`;
    if (r.href) node = html`<a href=${r.href} ...${LINK}>${node}</a>`;
    return node;
  });
}
/** A point that says its own letter ("a. …", "(ii) …", as a paper letters them): it shows the letter, not a bullet */
const lettered = (it) => it[0]?.t === 'p' && /^\(?(?:[a-z]|[ivxlc]{1,5})[.)]\s/i.test(it[0].text || '');
const wordsIn = (b) => (b.t === 'hr' ? 0 : b.t === 'p' || b.t === 'h' ? b.text.split(/\s+/).filter(Boolean).length : b.t === 'quote' ? b.blocks.reduce((n, x) => n + wordsIn(x), 0) : b.items.reduce((n, it) => n + it.reduce((m, x) => m + wordsIn(x), 0), 0));
function Blocks({ blocks, level }) {
  const H = `h${Math.min(6, level)}`;
  return blocks.map((b, k) => {
    // (each block its own direction, as its words have it: Arabic or Hebrew right to left, bullets on the right)
    if (b.t === 'p') return html`<p key=${k} dir="auto"><${Runs} text=${b.text} runs=${b.runs} />${b.cut ? '…' : null}</p>`;
    if (b.t === 'h') return h(H, { key: k, class: 'rp-h', dir: 'auto' }, html`<${Runs} text=${b.text} />`);
    if (b.t === 'quote') return html`<blockquote key=${k} class="rp-callout" dir="auto"><${Blocks} blocks=${b.blocks} level=${level} /></blockquote>`;
    // Where the presenter started a new slide: read as one report here, a quiet rule
    if (b.t === 'hr') return html`<hr key=${k} class="rp-break" />`;
    const items = b.items.map((it, j) => html`<li key=${j} dir="auto" class=${b.t === 'ul' && lettered(it) ? 'rp-li--lettered' : null}><${Blocks} blocks=${it} level=${level} /></li>`);
    // (a start only when it isn't 1: Preact writes a null start as the property, which the browser reads as 0)
    return b.t === 'ol' ? html`<ol key=${k} dir="auto" ...${b.start === 1 ? {} : { start: b.start }}>${items}</ol>` : html`<ul key=${k} dir="auto">${items}</ul>`;
  });
}

/**
 * The first `max` words of some blocks: whole blocks while they fit, then the one that doesn't, cut inside it (a list
 * to its first items, a paragraph at a word, with …). → { blocks, left } (`left`: the words still allowed)
 */
function clip(blocks, max) {
  const out = [];
  let left = max;
  for (const b of blocks) {
    if (left <= 0) break;
    const n = wordsIn(b);
    if (n <= left) { out.push(b); left -= n; continue; }
    if (b.t === 'hr') continue;
    if (b.t === 'p' || b.t === 'h') {
      // Cut on the words themselves (never inside **…**): the runs up to the word that's over
      const runs = [];
      let w = left;
      for (const r of mdInline(b.text)) {
        if (r.br) { runs.push(r); continue; }
        const words = r.text.split(/(\s+)/);
        let kept = '';
        for (const part of words) { if (/\S/.test(part)) { if (w <= 0) break; w--; } kept += part; }
        if (kept) runs.push({ ...r, text: kept.replace(/\s+$/, '') });
        if (w <= 0) break;
      }
      out.push({ ...b, runs, cut: true });
    } else if (b.t === 'quote') {
      out.push({ ...b, blocks: clip(b.blocks, left).blocks });
    } else {
      const items = [];
      let l = left;
      for (const it of b.items) {
        if (l <= 0) break;
        const c = clip(it, l);
        items.push(c.blocks);
        l = c.left;
      }
      out.push({ ...b, items });
    }
    left = 0;
  }
  return { blocks: out, left };
}

/**
 * A report as it reads. `level`: its headings' level (h4 under an item's h3). `clamp`: about how many words show
 * before "Keep reading" (0: all of it), cut wherever that falls, a list or a long paragraph too; "Show less" again.
 */
export function Report({ text, level = 4, clamp = 0, cls = '' }) {
  const [all, setAll] = useState(false);
  // Nothing new this time: said once, quietly
  if (isNothingNew(text)) return html`<div class=${`rp rp--nothing ${cls}`}><p dir="auto">${NOTHING_NEW}</p></div>`;
  const blocks = mdBlocks(text);
  if (!blocks.length) return null;
  const total = blocks.reduce((n, b) => n + wordsIn(b), 0);
  // Cut only when what's left is worth a click (a third more, at least)
  const long = clamp > 0 && total > clamp * 1.35;
  const shown = long && !all ? clip(blocks, clamp).blocks : blocks;
  return html`<div class=${`rp ${cls}`} data-long=${long ? 'true' : null}>
    <${Blocks} blocks=${shown} level=${level} />
    ${long ? html`<button type="button" class="rp-more" aria-expanded=${all ? 'true' : 'false'} onClick=${() => setAll(!all)}>${all ? 'Show less' : html`Keep reading<span class="rp-more__n"> · ${readTime(total)}</span>`}</button>` : null}
  </div>`;
}

/** "2 min read" (200 words a minute, at least 1) */
export const readTime = (words) => `${Math.max(1, Math.round(words / 200))} min read`;
export { speakTime };

/** What the presenter asks the board to vote on (item.motion), as a callout under the report */
export function Motion({ text, cls = '' }) {
  const t = String(text || '').trim();
  if (!t) return null;
  return html`<div class=${`rp-motion ${cls}`}><p class="rp-motion__label">The board votes on</p><p class="rp-motion__text">${t}</p></div>`;
}
/** The same on paper */
export function motionDom(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const box = document.createElement('div');
  box.className = 'rp-motion';
  const label = document.createElement('p');
  label.className = 'rp-motion__label';
  label.textContent = 'The board votes on';
  const what = document.createElement('p');
  what.className = 'rp-motion__text';
  what.textContent = t;
  box.append(label, what);
  return box;
}

/** A report on paper: the same blocks as elements (text only, nothing from it read as HTML) */
export function reportDom(text, { level = 4 } = {}) {
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  if (isNothingNew(text)) { const w = el('div', 'rp rp--nothing'); const p = el('p'); p.textContent = NOTHING_NEW; w.append(p); return w; }
  const blocks = mdBlocks(text);
  if (!blocks.length) return null;
  const runs = (parent, t) => {
    for (const r of mdInline(t)) {
      if (r.br) { parent.append(el('br')); continue; }
      let node = document.createTextNode(r.text);
      if (r.i) { const e = el('em'); e.append(node); node = e; }
      if (r.b) { const e = el('strong'); e.append(node); node = e; }
      if (r.href) { const e = el('a'); e.href = r.href; e.append(node); node = e; }
      parent.append(node);
    }
  };
  const draw = (parent, list) => {
    for (const b of list) {
      if (b.t === 'p' || b.t === 'h') { const e = el(b.t === 'p' ? 'p' : `h${level}`, b.t === 'h' ? 'rp-h' : ''); runs(e, b.text); parent.append(e); continue; }
      if (b.t === 'quote') { const e = el('blockquote', 'rp-callout'); draw(e, b.blocks); parent.append(e); continue; }
      if (b.t === 'hr') { parent.append(el('hr', 'rp-break')); continue; }
      const e = el(b.t);
      if (b.t === 'ol' && b.start !== 1) e.start = b.start;
      for (const it of b.items) { const li = el('li', b.t === 'ul' && lettered(it) ? 'rp-li--lettered' : ''); draw(li, it); e.append(li); }
      parent.append(e);
    }
  };
  const wrap = el('div', 'rp');
  draw(wrap, blocks);
  return wrap;
}

// ─── Writing ────────────────────────────────────────────────────────

const svg = (d) => html`<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  heading: svg(html`<path d="M6 12h12" /><path d="M6 20V4" /><path d="M18 20V4" />`),
  bold: svg(html`<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8" />`),
  italic: svg(html`<line x1="19" x2="10" y1="4" y2="4" /><line x1="14" x2="5" y1="20" y2="20" /><line x1="15" x2="9" y1="4" y2="20" />`),
  bullets: svg(html`<path d="M3 12h.01" /><path d="M3 18h.01" /><path d="M3 6h.01" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M8 6h13" />`),
  numbers: svg(html`<path d="M10 12h11" /><path d="M10 18h11" /><path d="M10 6h11" /><path d="M4 10h2" /><path d="M4 6h1v4" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />`),
  callout: svg(html`<path d="M4 4v16" /><path d="M9 7h11" /><path d="M9 12h11" /><path d="M9 17h7" />`),
  link: svg(html`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />`),
  undo: svg(html`<path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />`),
  redo: svg(html`<path d="m15 14 5-5-5-5" /><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />`),
  slide: svg(html`<rect x="3" y="3" width="18" height="7" rx="1.5" /><rect x="3" y="14" width="18" height="7" rx="1.5" />`),
};
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl+';

// What a pasted page keeps: what a report can hold, nothing else (no styles, no images, no scripts)
const PASTE = { ALLOWED_TAGS: ['p', 'br', 'b', 'strong', 'i', 'em', 'a', 'ul', 'ol', 'li', 'blockquote', 'h3'], ALLOWED_ATTR: ['href', 'start'] };
// The longest a report can be, in letters (its Markdown can run longer: the server keeps LIMITS.report of it)
export const REPORT_LETTERS = 40000;
/** A paper written in Board (Board → Documents): long bylaws run past 70,000 letters, all of it kept */
export const PAPER_LETTERS = 200000;
const BULLET = /^[\s\u00a0]*([·•▪◦‣⁃o§\-–*]|\d{1,3}[.)]|[a-z][.)])[\s\u00a0]+/i;

/**
 * What Google Docs, Word, Pages and a spreadsheet put on the clipboard, as the report's own kinds of thing, read
 * before anything is thrown away: Docs' bold and italic are styles on spans (and the whole paste sits in a <b> that
 * isn't bold); Word's points are paragraphs with a bullet character and an indent level; a table's rows are lines.
 * Then only what a report holds is kept (PASTE)
 */
export function cleanPaste(raw) {
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const body = doc.body;
  const unwrap = (el) => el.replaceWith(...el.childNodes);
  const styleOf = (el) => String(el.getAttribute('style') || '').toLowerCase();
  const wrap = (el, tag) => { const w = doc.createElement(tag); w.append(...el.childNodes); el.append(w); };
  // Bold and italic that are styles
  for (const el of [...body.querySelectorAll('b, strong')]) if (/font-weight:\s*(normal|[1-4]00)\b/.test(styleOf(el))) unwrap(el);
  for (const el of [...body.querySelectorAll('span, font')]) {
    const st = styleOf(el);
    if (/font-weight:\s*(bold|[6-9]00)\b/.test(st)) wrap(el, 'strong');
    if (/font-style:\s*italic/.test(st)) wrap(el, 'em');
  }
  // Headings of any level: the report's one kind
  for (const el of [...body.querySelectorAll('h1, h2, h4, h5, h6')]) { const h3 = doc.createElement('h3'); h3.append(...el.childNodes); el.replaceWith(h3); }
  // A table: each row a line, its cells " · " apart
  for (const t of [...body.querySelectorAll('table')]) {
    const lines = [...t.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ')).filter(Boolean);
    const frag = doc.createDocumentFragment();
    for (const l of lines) { const p = doc.createElement('p'); p.textContent = l; frag.append(p); }
    t.replaceWith(frag);
  }
  // Word's points: paragraphs marked as list items (mso-list, its level) or starting with a bullet; a run of them a list
  const ps = [...body.querySelectorAll('p')];
  let run = null;
  for (const p of ps) {
    const st = styleOf(p);
    const marker = p.querySelector('[style*="mso-list:ignore" i], [style*="mso-list: ignore" i]');
    const text = p.textContent || '';
    const isItem = /mso-list/.test(st) || /MsoListParagraph/i.test(p.className) || (BULLET.test(text) && p.previousElementSibling && run?.last === p.previousElementSibling) || (BULLET.test(text) && /^[\s\u00a0]*[·•▪◦‣⁃§]/.test(text));
    if (!isItem) { run = null; continue; }
    const level = Math.max(1, Number((st.match(/level(\d)/) || [])[1]) || 1);
    const ordered = /^[\s\u00a0]*\d{1,3}[.)]/.test(marker?.textContent || text);
    if (marker) marker.remove();
    else {
      // The bullet typed into the line itself
      const walker = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode();
      if (first) first.nodeValue = first.nodeValue.replace(BULLET, '');
    }
    const li = doc.createElement('li');
    li.append(...p.childNodes);
    if (!run || run.last !== p.previousElementSibling) { run = { stack: [], last: null }; }
    // The list at this level (deeper ones go inside the last item above them)
    while (run.stack.length > level) run.stack.pop();
    while (run.stack.length < level) {
      const list = doc.createElement(ordered ? 'ol' : 'ul');
      if (run.stack.length) (run.stack.at(-1).lastElementChild || run.stack.at(-1)).append(list);
      else p.before(list);
      run.stack.push(list);
    }
    run.stack.at(-1).append(li);
    const placeholder = doc.createElement('span');
    p.replaceWith(placeholder);
    run.last = placeholder;
  }
  for (const el of [...body.querySelectorAll('span:empty')]) el.remove();
  return DOMPurify.sanitize(body.innerHTML, PASTE);
}
// Plain text that's written as Markdown (more than a stray asterisk): read as what it says
const LOOKS_MD = /(^|\n)\s{0,3}(#{1,6}\s|[-*+•]\s|\d{1,3}[.)]\s|>\s)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)/;

/**
 * Where a report is written. `value` is Markdown; `onChange(md)` hears every change. `resetKey`: a new one puts
 * `value` in even while someone's typing (taking a newer version someone else saved). `status`: what saving says,
 * at the foot, beside how long it takes to present. The toolbar stays in view under `stickyTop` while a long report
 * scrolls. `starter`: an empty report offers an outline to fill in (three headings; `onChange(md, { inserted: true })`); `onNothing`: a "Nothing to report
 * this time" at the foot (the page decides what happens, asking first when there are words). `timed`: 'read' for
 * words the board reads (a paper), not presents: "2 min read", with a paper's length (PAPER_LETTERS) and none of
 * the Markdown hint (the admin writing a paper uses the bar above)
 */
export const OUTLINE = ['What we did', 'What the board needs to decide', 'What’s next'];
export function ReportEditor({ value, onChange, label = 'The report', placeholder = 'What happened, what the board needs to decide, and what’s next', autofocus = false, resetKey = 0, status = null, stickyTop = '0px', minHeight = 220, onBlur, starter = false, onNothing = null, coach = null, timed = 'present' }) {
  const paper = timed === 'read';
  const letters = paper ? PAPER_LETTERS : REPORT_LETTERS;
  const ed = useRef(null);
  const last = useRef(value || '');
  const change = useRef(onChange);
  change.current = onChange;
  const blurred = useRef(onBlur);
  blurred.current = onBlur;
  const [, setTick] = useState(0);
  const [linking, setLinking] = useState(null); // the address it had when the box opened, or null when it's shut
  const [badLink, setBadLink] = useState(false);
  const linkBox = useRef(null);
  // Focused (its address selected) the moment it's on the page: a first key typed fast never lands before the select
  const linkRef = useRef((el) => { linkBox.current = el; if (el) { el.focus(); el.select(); } }).current;
  // The words it goes on, kept as the box opens (the editor's selection can't be trusted once the box has the focus)
  const linkAt = useRef(null);
  // What the person sees selected (the page's own selection: the editor's catches up a moment later, so ⌘K pressed
  // right after Shift+⌥← would find nothing selected yet)
  const shownRange = () => {
    const v = ed.current?.view;
    const s = getSelection();
    if (!v || !s?.rangeCount || !v.dom.contains(s.anchorNode)) return null;
    try { const a = v.posAtDOM(s.anchorNode, s.anchorOffset); const b = v.posAtDOM(s.focusNode, s.focusOffset); return { from: Math.min(a, b), to: Math.max(a, b) }; } catch { return null; }
  };
  const openLink = () => {
    const sel = ed.current?.state.selection;
    linkAt.current = shownRange() || (sel ? { from: sel.from, to: sel.to } : null);
    if (linkAt.current && ed.current) ed.current.commands.setTextSelection(linkAt.current);
    setBadLink(false);
    setLinking(ed.current?.getAttributes('link')?.href || '');
  };
  const opener = useRef(openLink);
  opener.current = openLink;

  // Built the moment its box is on the page (a ref, not an effect: an effect waits for the page's view transition,
  // and the first words typed after "Write your report" would go nowhere)
  const mount = useRef((el) => {
    if (!el || ed.current) return;
    const editor = new Editor({
      element: el,
      extensions: [
        StarterKit.configure({ heading: { levels: [3] }, code: false, codeBlock: false, strike: false }),
        TiptapLink.configure({ openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https', HTMLAttributes: LINK, validate: (href) => !!safeHref(href) }),
        Placeholder.configure({ placeholder }),
        CharacterCount.configure({ limit: letters }),
      ],
      content: mdToDoc(value),
      editorProps: {
        attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': label, class: 'rp rp-edit', spellcheck: 'true' },
        transformPastedHTML: cleanPaste,
        handlePaste: (view, e) => {
          const dt = e.clipboardData;
          if (!dt || dt.types.includes('text/html')) return false;
          const text = dt.getData('text/plain');
          if (!LOOKS_MD.test(text)) return false;
          e.preventDefault();
          ed.current?.chain().focus().insertContent(mdToDoc(text).content).run();
          return true;
        },
        handleKeyDown: (view, e) => {
          // ⌘K is the link here, never the page's search
          if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); opener.current(); return true; }
          return false;
        },
        // Words that only look like Markdown as they're typed stay words: "2026. " starts no list (a list starts under
        // 100), and a star with a space just inside it ("2 * 3 * 4") is a star, never italic or bold
        handleTextInput: (view, from, to, text) => {
          const $from = view.state.doc.resolve(from);
          const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
          const plain = (text === ' ' && /^\d{3,}[.)]$/.test(before)) || (text === '*' && /(?:^|\s)\*{1,2}(\s[^*]*|[^*]*\s)\*?$/.test(before));
          if (!plain) return false;
          view.dispatch(view.state.tr.insertText(text, from, to));
          return true;
        },
      },
      onUpdate: ({ editor: x }) => {
        const md = docToMd(x.getJSON());
        if (md === last.current) return;
        last.current = md;
        change.current(md);
      },
      onCreate: () => setTick((n) => n + 1),
      onTransaction: () => setTick((n) => n + 1),
      onBlur: () => blurred.current?.(),
    });
    ed.current = editor;
    // Ready to type now, not a moment later
    if (autofocus) editor.commands.focus('end');
  }).current;
  useEffect(() => () => { ed.current?.destroy(); ed.current = null; }, []);

  // A value from outside (a newer save, a reload): put in when it isn't what's here, unless they're typing
  const lastReset = useRef(resetKey);
  useEffect(() => {
    const editor = ed.current;
    if (!editor) return;
    const forced = resetKey !== lastReset.current;
    lastReset.current = resetKey;
    if ((value || '') === last.current && !forced) return;
    if (editor.isFocused && !forced) return;
    last.current = value || '';
    editor.commands.setContent(mdToDoc(value), false);
  }, [value, resetKey]);

  // The toolbar is one Tab stop; ← → Home End move along it (the last one used is where Tab comes back to)
  const tools = (bar) => [...bar.querySelectorAll('.rp-tool')].filter((b) => !b.disabled && b.offsetParent);
  const rove = (bar, to) => { for (const b of bar.querySelectorAll('.rp-tool')) b.tabIndex = b === to ? 0 : -1; to?.focus(); };
  const roveKeys = (ev) => {
    if (!ev.target.classList?.contains('rp-tool')) return;
    const list = tools(ev.currentTarget);
    const i = list.indexOf(ev.target);
    const to = { ArrowRight: list[(i + 1) % list.length], ArrowLeft: list[(i - 1 + list.length) % list.length], Home: list[0], End: list.at(-1) }[ev.key];
    if (to) { ev.preventDefault(); rove(ev.currentTarget, to); }
  };
  const roveFocus = (ev) => { if (ev.target.classList?.contains('rp-tool')) for (const b of ev.currentTarget.querySelectorAll('.rp-tool')) b.tabIndex = b === ev.target ? 0 : -1; };
  const e = ed.current;
  const on = (name, attrs) => !!e?.isActive(name, attrs);
  const run = (fn) => (ev) => { ev.preventDefault(); if (e) fn(e.chain().focus()).run(); };
  // A new slide goes between the report's own blocks: in a point or a callout, after the whole list or callout (a rule
  // inside one starts no slide), the cursor on a new line after it
  const newSlide = (ed, c) => {
    const { $from } = ed.state.selection;
    if ($from.depth <= 1) return c.setHorizontalRule();
    const at = $from.after(1);
    // (more after it: the rule alone; at the end, a line to go on writing on)
    if (ed.state.doc.resolve(at).nodeAfter) return c.insertContentAt(at, { type: 'horizontalRule' });
    return c.insertContentAt(at, [{ type: 'horizontalRule' }, { type: 'paragraph' }]).setTextSelection(at + 2);
  };
  const btn = (key, title, active, fn, disabled = false) => html`<button type="button" class=${`rp-tool ${active ? 'is-on' : ''}`} tabIndex=${key === 'heading' ? 0 : -1} title=${title} aria-label=${title.replace(/ \(.*\)$/, '')} aria-pressed=${active ? 'true' : 'false'} disabled=${disabled} onMouseDown=${(ev) => ev.preventDefault()} onClick=${run(fn)}>${ICON[key]}</button>`;
  const applyLink = (href, remove = false) => {
    const safe = safeHref(href);
    // Something typed that isn't an address: said, and the box keeps it to fix
    if (!remove && String(href).trim() && !safe) { setBadLink(true); linkBox.current?.focus(); return; }
    const c = e.chain().focus();
    if (linkAt.current) c.setTextSelection(linkAt.current);
    c.extendMarkRange('link');
    (safe ? c.setLink({ href: safe }) : c.unsetLink()).run();
    setLinking(null);
  };
  const words = e ? mdWords(last.current) : 0;
  const full = !!e && e.storage.characterCount.characters() >= letters;
  // The outline: its three headings with a line to write under each, the caret under the first
  const outline = () => {
    if (!e) return;
    const content = OUTLINE.flatMap((t) => [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: t }] }, { type: 'paragraph' }]);
    e.commands.setContent({ type: 'doc', content }, false);
    // Said as a head start put in (the page saves it only once it's changed)
    const md = docToMd(e.getJSON());
    last.current = md;
    change.current(md, { inserted: true });
    e.chain().focus().setTextSelection(e.state.doc.child(0).nodeSize + 1).run();
  };
  const nothing = isNothingNew(last.current);
  // A suggestion taken (ReportCoach): in through the editor itself, so it shows whatever has the focus, Undo takes it
  // back, and the page hears it as it hears typing
  const put = (md) => { e?.chain().setContent(mdToDoc(md), true).run(); };
  return html`<div class="rp-editor" style=${`--rp-sticky:${stickyTop}`}>
    <div class="rp-bar" role="toolbar" aria-label=${`Formatting for ${label.toLowerCase()}`} onKeyDown=${roveKeys} onFocusIn=${roveFocus}>
      ${btn('heading', `Heading (${MOD}Alt+3, or ### then a space)`, on('heading'), (c) => c.toggleHeading({ level: 3 }))}
      ${btn('bold', `Bold (${MOD}B)`, on('bold'), (c) => c.toggleBold())}
      ${btn('italic', `Italic (${MOD}I)`, on('italic'), (c) => c.toggleItalic())}
      <span class="rp-sep" aria-hidden="true"></span>
      ${btn('bullets', 'Points (- then a space)', on('bulletList'), (c) => c.toggleBulletList())}
      ${btn('numbers', 'Numbered list (1. then a space)', on('orderedList'), (c) => c.toggleOrderedList())}
      ${btn('callout', 'Callout, for what the board needs to decide (> then a space)', on('blockquote'), (c) => c.toggleBlockquote())}
      ${paper ? null : btn('slide', 'New slide here (the meeting’s screen starts one; --- on a line of its own)', false, (c) => newSlide(e, c))}
      <span class="rp-sep" aria-hidden="true"></span>
      <button type="button" class=${`rp-tool ${on('link') ? 'is-on' : ''}`} tabIndex="-1" title=${`Link (${MOD}K)`} aria-label="Link" aria-pressed=${on('link') ? 'true' : 'false'} aria-expanded=${linking !== null} onMouseDown=${(ev) => ev.preventDefault()} onClick=${openLink}>${ICON.link}</button>
      <span class="rp-bar__end">
        ${btn('undo', `Undo (${MOD}Z)`, false, (c) => c.undo(), !e?.can().undo())}
        ${btn('redo', `Redo (${MOD}Shift+Z)`, false, (c) => c.redo(), !e?.can().redo())}
      </span>
      ${linking !== null ? html`<form class="rp-link" noValidate onSubmit=${(ev) => { ev.preventDefault(); applyLink(linkBox.current.value); }}>
        <input ref=${linkRef} class="rp-link__box" type="text" inputmode="url" autocomplete="off" spellcheck="false" defaultValue=${linking} placeholder="soard.org, https://… or an email" aria-label="Link to" aria-invalid=${badLink ? 'true' : null} aria-describedby=${badLink ? 'rp-link-bad' : null}
          onInput=${() => setBadLink(false)} onKeyDown=${(ev) => { ev.stopPropagation(); if (ev.key === 'Escape') { ev.preventDefault(); setLinking(null); e?.commands.focus(); } }} />
        <button type="submit" class="rp-link__go">${linking ? 'Change' : 'Link'}</button>
        ${on('link') ? html`<button type="button" class="rp-link__go is-quiet" onClick=${() => applyLink('', true)}>Remove</button>` : null}
        ${badLink ? html`<p class="rp-link__bad" id="rp-link-bad" role="alert">That isn’t a web address or an email</p>` : null}
      </form>` : null}
    </div>
    <div class="rp-page" ref=${mount} style=${`min-height:${minHeight}px`} onClick=${(ev) => { if (ev.target === ev.currentTarget) e?.commands.focus('end'); }}></div>
    <div class="rp-foot">
      <span class="rp-foot__count" aria-live="off">${full ? html`<strong class="rp-full" role="status">${paper ? 'That’s as long as a paper can be' : 'That’s as long as a report can be'}</strong>` : words ? `${words} ${words === 1 ? 'word' : 'words'} · ${timed === 'read' ? readTime(words) : speakTime(words)}` : paper ? '' : html`<span class="rp-hint">Markdown works: <kbd>###</kbd> a heading, <kbd>-</kbd> points, <kbd>1.</kbd> a list, <kbd>**bold**</kbd></span>`}</span>
      ${(starter && !words) || (onNothing && !nothing) ? html`<span class="rp-foot__acts">
        ${starter && !words ? html`<button type="button" class="rp-foot__btn" onMouseDown=${(ev) => ev.preventDefault()} onClick=${outline}>Start with an outline</button>` : null}
        ${onNothing && !nothing ? html`<button type="button" class="rp-foot__btn" onMouseDown=${(ev) => ev.preventDefault()} onClick=${() => onNothing(last.current)}>Nothing to report this time</button>` : null}
      </span>` : null}
      ${status ? html`<span class="rp-foot__status">${status}</span>` : null}
    </div>
  </div>
  ${coach ? html`<${ReportCoach} ...${coach} value=${last.current} onChange=${put} />` : null}`;
}

// ─── A word beside it as it's written ───────────────────────────────

/**
 * Under the editor: how the report will show in the meeting (its slides, how long to present, the part's time), then
 * at most one suggestion (./board-coach.js reportAdvice), each with a button that does it and "Not now". A shorter
 * version is written only when asked, shown in full, and goes in only with "Use this". `part`: ./board-coach.js
 * partFor. `admin`: Board's agenda (asks /api/board-admin), else the board page
 */
export function ReportCoach({ value, onChange, part = null, admin = false, id = '', itemId = '', title = '', confidential = false, look = '', onLook = null }) {
  const text = String(value || '');
  // What it says is worked out a moment after typing stops (cutting a long report into slides is real work), once
  // for each wording
  const [settled, setSettled] = useState(text);
  useEffect(() => { if (text === settled) return undefined; const t = setTimeout(() => setSettled(text), 300); return () => clearTimeout(t); }, [text]);
  const words = useMemo(() => (isNothingNew(settled) ? 0 : mdWords(settled)), [settled]);
  const slides = useMemo(() => (words ? reportSlides(settled, { title, confidential, look }).filter((x) => String(x).trim()).length || 1 : 0), [settled, words, title, confidential, look]);
  const [off, setOff] = useState(() => new Set());
  const [alt, setAlt] = useState(null); // { text, for: the report it shortens } | { busy } | { error }
  // A shorter version is for the words it was written from: typing on puts it away
  const stale = alt?.for !== undefined && alt.for !== text;
  useEffect(() => { if (stale) setAlt(null); }, [stale]);
  const advice = useMemo(() => reportAdvice(settled, { slides, part, look, picks: !!onLook }), [settled, slides, part?.name, part?.minutes, part?.reports, look, !!onLook]);
  const tips = advice.filter((x) => !off.has(x.id));
  const tip = alt ? null : tips[0];
  const fit = reportFitLine({ slides, words, part });
  // How it shows (where it can be chosen): its ways, the one showing, the one that reads best; a choice that wrote its
  // paragraphs as points can be taken back with Paragraphs while nothing's changed since
  const looks = useMemo(() => (onLook && words ? reportLooks(settled, look) : null), [settled, look, words, !!onLook]);
  const [was, setWas] = useState(null); // { from, to }: the words before a choice made them points, and after
  const [why, setWhy] = useState(null); // { id, text }: why a way it can't show isn't one
  useEffect(() => setWhy(null), [settled]);
  const back = !!was && was.to === text;
  const choosing = !!looks && (looks.offered || !!look || back);
  if (!fit && !tip && !alt && !choosing) return null;
  const notNow = (x) => setOff(new Set([...off, x.id]));
  // A new wording at once (not a moment later), so what's chosen shows chosen
  const put = (md) => { onChange(md); setSettled(md); };
  // A way chosen is worked out from the words as they are this moment, never the ones the panel was last drawn from
  // (typed a moment ago, they'd be lost)
  const choose = (picked) => {
    if (picked.id === 'text' && back) { put(was.from); setWas(null); setWhy(null); onLook('list'); return; }
    const o = reportLooks(text, look)?.options.find((x) => x.id === picked.id) || picked;
    // (said again when pressed again: cleared first, so a screen reader hears it each time)
    if (!o.ok) { setWhy(null); requestAnimationFrame(() => setWhy({ id: o.id, text: o.why })); return; }
    setWhy(null);
    if (o.md && o.md !== text) { setWas({ from: text, to: o.md }); put(o.md); }
    onLook(o.look);
  };
  const act = async (x) => {
    if (x.action.look && onLook) {
      const md = x.action.run ? x.action.run(text) : text;
      if (md !== text) { setWas({ from: text, to: md }); put(md); }
      onLook(x.action.look);
      return;
    }
    if (x.action.run) { onChange(x.action.run(text)); return; }
    setAlt({ busy: true, for: text });
    const r = await shorterVersion({ admin, id, itemId, text, title });
    setAlt(r.ok && r.text ? { text: r.text, for: text } : { error: r.error || 'A shorter version couldn’t be written just now.', for: text });
  };
  return html`<div class="rp-coach">
    ${fit ? html`<p class="rp-coach__fit">${fit}</p>` : null}
    ${choosing ? html`<div class="rp-looks" role="group" aria-label="How your report shows in the meeting">
      <p class="rp-looks__h" aria-hidden="true">How it shows in the meeting</p>
      <div class="rp-looks__opts">${looks.options.map((o) => {
        const ok = o.ok || (o.id === 'text' && back);
        const on = looks.on === o.id;
        return html`<button type="button" key=${o.id} class=${`rp-look ${on ? 'is-on' : ''} ${ok ? '' : 'is-off'}`} aria-pressed=${on ? 'true' : 'false'} aria-disabled=${ok ? null : 'true'}
          aria-describedby=${why?.id === o.id ? `rp-looks-why-${itemId}` : null} onClick=${() => choose(o)}>
          ${LOOK_ICON[o.id]}<span class="rp-look__name">${LOOK_NAME[o.id]}</span>${looks.best === o.id && ok ? html`<span class="rp-look__best">Suggested</span>` : null}
        </button>`;
      })}</div>
      <p class="rp-looks__why" id=${`rp-looks-why-${itemId}`} role="status">${why ? why.text : ''}</p>
    </div>` : null}
    ${tip ? html`<div class="rp-coach__tip" role="status">
      <p>${tip.text}</p>
      <span class="rp-coach__acts">
        <button type="button" class="rp-coach__btn is-go" onClick=${() => act(tip)}>${tip.action.label}</button>
        <button type="button" class="rp-coach__btn" onClick=${() => notNow(tip)}>Not now</button>
      </span>
    </div>` : null}
    ${alt?.busy ? html`<p class="rp-coach__tip" role="status">Writing a shorter version…</p>` : null}
    ${alt?.error ? html`<div class="rp-coach__tip" role="alert"><p>${alt.error}</p><span class="rp-coach__acts"><button type="button" class="rp-coach__btn" onClick=${() => { setAlt(null); setOff(new Set([...off, 'shorter'])); }}>OK</button></span></div>` : null}
    ${alt?.text ? html`<div class="rp-coach__alt">
      <p class="rp-coach__alt-h">A shorter version · ${mdWords(alt.text)} words, ${speakTime(mdWords(alt.text))}</p>
      <${Report} text=${alt.text} />
      <span class="rp-coach__acts">
        <button type="button" class="rp-coach__btn is-go" onClick=${() => { const t = alt.text; setAlt(null); setOff(new Set([...off, 'shorter'])); onChange(t); }}>Use this</button>
        <button type="button" class="rp-coach__btn" onClick=${() => { setAlt(null); setOff(new Set([...off, 'shorter'])); }}>Keep mine</button>
      </span>
    </div>` : null}
  </div>`;
}

/** The ways a report shows (./board-coach.js reportLooks), by name and as a picture of each */
const LOOK_NAME = { cards: 'Cards', points: 'Bullet points', text: 'Paragraphs', numbers: 'Big numbers' };
const lookSvg = (d) => html`<svg class="rp-look__pic" viewBox="0 0 36 22" width="36" height="22" aria-hidden="true">${d}</svg>`;
const LOOK_ICON = {
  cards: lookSvg(html`<rect x="1" y="3" width="10" height="16" rx="2.2" /><rect x="13" y="3" width="10" height="16" rx="2.2" /><rect x="25" y="3" width="10" height="16" rx="2.2" />`),
  points: lookSvg(html`<circle cx="4" cy="5" r="2" /><circle cx="4" cy="11" r="2" /><circle cx="4" cy="17" r="2" /><rect x="9" y="4" width="24" height="2.4" rx="1.2" /><rect x="9" y="10" width="20" height="2.4" rx="1.2" /><rect x="9" y="16" width="23" height="2.4" rx="1.2" />`),
  text: lookSvg(html`<rect x="2" y="3" width="32" height="2.4" rx="1.2" /><rect x="2" y="8" width="30" height="2.4" rx="1.2" /><rect x="2" y="13" width="32" height="2.4" rx="1.2" /><rect x="2" y="18" width="18" height="2.4" rx="1.2" />`),
  numbers: lookSvg(html`<rect x="3" y="2" width="30" height="18" rx="2.5" class="rp-look__fill" /><text x="18" y="16" text-anchor="middle" class="rp-look__fig">42</text>`),
};

// ─── How it looks (both pages; each page's own colors where it has them) ───

const CSS = `
.rp { --rp-ink: var(--ink, var(--color-text, #2D2F2C)); --rp-ink-2: var(--ink-2, var(--color-text, #4E504C)); --rp-muted: var(--muted, var(--color-text-secondary, #5F615A));
  --rp-line: var(--line, var(--color-border, #E7E5DE)); --rp-yellow: var(--yellow, var(--color-primary, #FFDA24)); --rp-wash: var(--yellow-wash, #FFFAE0);
  color: var(--rp-ink-2); font-size: 1rem; line-height: 1.65; overflow-wrap: anywhere; }
.rp > :first-child { margin-top: 0; }
.rp > :last-child { margin-bottom: 0; }
.rp p { margin: 0 0 0.75em; }
.rp .rp-h, .rp h3 { margin: 1.15em 0 0.4em; color: var(--rp-ink); font-size: 1.06em; font-weight: 700; line-height: 1.35; letter-spacing: -0.005em; }
.rp ul, .rp ol { margin: 0 0 0.8em; padding-inline-start: 1.35em; }
.rp li { margin: 0.2em 0; padding-inline-start: 0.15em; }
.rp li > p { margin: 0; }
.rp li.rp-li--lettered { list-style: none; }
.rp li > ul, .rp li > ol { margin: 0.2em 0 0.3em; }
.rp ul { list-style-type: disc; }
.rp ul ul { list-style-type: circle; }
.rp ul ul ul { list-style-type: square; }
.rp ol { list-style-type: decimal; }
.rp li::marker { color: var(--rp-muted); }
.rp strong { color: var(--rp-ink); font-weight: 700; }
.rp a { color: var(--rp-ink); text-decoration: underline; text-decoration-color: var(--rp-yellow); text-decoration-thickness: 2px; text-underline-offset: 3px; }
.rp a:hover { text-decoration-color: currentColor; }
.rp .rp-callout, .rp blockquote { margin: 0.4em 0 0.9em; padding: 0.7em 1em; border-left: 4px solid var(--rp-yellow); border-radius: 0 10px 10px 0; background: var(--rp-wash); color: var(--rp-ink); }
.rp blockquote > :last-child { margin-bottom: 0; }
.rp-more { display: inline-flex; align-items: center; margin-top: 0.15rem; padding: 0.35rem 0.75rem; border: 1px solid var(--rp-line); border-radius: 999px; background: var(--card, #fff); color: var(--rp-ink); font: inherit; font-size: 0.88rem; font-weight: 650; cursor: pointer; }
.rp-more:hover { border-color: var(--rp-ink); }
.rp-more__n { color: var(--rp-muted); font-weight: 500; }
.rp--nothing p { margin: 0; color: var(--rp-muted); font-style: italic; }
.rp-motion { margin: 0.8rem 0 0; padding: 0.65rem 0.95rem 0.7rem; border-left: 4px solid var(--yellow, #FFDA24); border-radius: 0 12px 12px 0; background: var(--yellow-wash, #FFFAE0); }
.rp-motion__label { margin: 0 0 0.15rem; font-size: 0.72rem; font-weight: 750; letter-spacing: 0.1em; text-transform: uppercase; color: var(--gold, #765C00); }
.rp-motion__text { margin: 0; color: var(--ink, var(--color-text, #2D2F2C)); font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
.rp-foot__acts { display: inline-flex; flex-wrap: wrap; gap: 0.4rem; }
.rp-foot__btn { min-height: 32px; padding: 0 0.75rem; border: 1px solid var(--line-2, var(--color-border-strong, #D3D0C7)); border-radius: 999px; background: var(--card, #fff); color: var(--ink-2, var(--color-text, #4E504C)); font: inherit; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
.rp-coach { display: grid; gap: 0.5rem; margin-top: 0.6rem; font-size: 0.9rem; color: var(--ink-2, var(--color-text, #4E504C)); }
.rp-coach__fit { margin: 0; color: var(--muted, var(--color-text-secondary, #5F615A)); font-variant-numeric: tabular-nums; }
.rp-coach__tip { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; margin: 0; padding: 0.6rem 0.8rem; border: 1px solid var(--line, var(--color-border, #E7E5DE)); border-left: 4px solid var(--yellow, #FFDA24); border-radius: 10px; background: var(--card, var(--color-bg-card, #fff)); }
.rp-coach__tip > p { flex: 1 1 18rem; margin: 0; line-height: 1.45; }
.rp-coach__acts { display: inline-flex; flex-wrap: wrap; gap: 0.4rem; }
.rp-coach__btn { min-height: 34px; padding: 0 0.85rem; border: 1px solid var(--line-2, var(--color-border-strong, #D3D0C7)); border-radius: 999px; background: var(--card, #fff); color: var(--ink, var(--color-text, #2D2F2C)); font: inherit; font-size: 0.85rem; font-weight: 650; cursor: pointer; }
.rp-coach__btn:hover { border-color: var(--ink, var(--color-text, #2D2F2C)); }
.rp-coach__btn.is-go { border-color: var(--ink, var(--color-text, #2D2F2C)); background: var(--ink, var(--color-text, #2D2F2C)); color: #fff; }
.rp-coach__btn:focus-visible { outline: 2px solid var(--ink, var(--color-text, #2D2F2C)); outline-offset: 2px; }
.rp-coach__alt { display: grid; gap: 0.6rem; padding: 0.8rem 0.95rem; border: 1px solid var(--line, var(--color-border, #E7E5DE)); border-radius: 12px; background: var(--warm, var(--color-bg-subtle, #FAF9F5)); }
.rp-coach__alt-h { margin: 0; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.04em; color: var(--muted, var(--color-text-secondary, #5F615A)); }
/* How it shows: four ways side by side (two by two on a phone), each a picture and its name; the one showing in ink,
   the one that reads best marked; one this report can't take is pale, and says why when it's pressed */
.rp-looks { display: grid; gap: 0.4rem; }
.rp-looks__h { margin: 0; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.04em; color: var(--muted, var(--color-text-secondary, #5F615A)); }
.rp-looks__opts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.4rem; }
@media (max-width: 520px) { .rp-looks__opts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.rp-look { position: relative; display: grid; justify-items: center; align-content: start; gap: 0.3rem; min-height: 72px; padding: 0.6rem 0.35rem 0.5rem; border: 1px solid var(--line-2, var(--color-border-strong, #D3D0C7)); border-radius: 12px; background: var(--card, var(--color-bg-card, #fff)); color: var(--ink, var(--color-text, #2D2F2C)); font: inherit; font-size: 0.82rem; font-weight: 650; line-height: 1.2; text-align: center; cursor: pointer; }
.rp-look:hover { border-color: var(--ink, var(--color-text, #2D2F2C)); }
.rp-look:focus-visible { outline: 2px solid var(--ink, var(--color-text, #2D2F2C)); outline-offset: 2px; }
.rp-look.is-on { border-color: var(--ink, var(--color-text, #2D2F2C)); box-shadow: inset 0 0 0 1px var(--ink, var(--color-text, #2D2F2C)); background: var(--yellow-wash, #FFFAE0); }
.rp-look.is-off { color: var(--muted, var(--color-text-secondary, #5F615A)); border-style: dashed; }
.rp-look.is-off .rp-look__pic { opacity: 0.45; }
.rp-look__pic { fill: currentColor; }
.rp-look__pic .rp-look__fill { fill: none; stroke: currentColor; stroke-width: 1.4; }
.rp-look__fig { font: 700 13px/1 Georgia, 'Times New Roman', serif; fill: currentColor; }
.rp-look.is-on .rp-look__pic { color: var(--ink, var(--color-text, #2D2F2C)); }
.rp-look__best { font-size: 0.68rem; font-weight: 750; letter-spacing: 0.06em; text-transform: uppercase; color: var(--gold, #8A6A00); }
.rp-looks__why:empty { display: block; height: 0; margin-top: -0.4rem; padding: 0; overflow: hidden; }
.rp-looks__why { margin: 0; padding: 0.45rem 0.7rem; border-radius: 10px; background: var(--warm, var(--color-bg-subtle, #FAF9F5)); color: var(--ink-2, var(--color-text, #4E504C)); font-size: 0.85rem; line-height: 1.4; }
.rp-foot__btn:hover { border-color: var(--ink, var(--color-text, #2D2F2C)); color: var(--ink, var(--color-text, #2D2F2C)); }

.rp-editor { --rp-line: var(--line, var(--color-border, #E7E5DE)); position: relative; border: 1px solid var(--line-2, var(--color-border-strong, #D3D0C7)); border-radius: 14px; background: var(--card, var(--color-bg-card, #fff)); }
.rp-editor:focus-within { border-color: var(--ink, var(--color-text, #2D2F2C)); box-shadow: 0 0 0 3px rgba(45,47,44,0.08); }
.rp-bar { position: sticky; top: var(--rp-sticky, 0px); z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 6px; border-bottom: 1px solid var(--rp-line); border-radius: 14px 14px 0 0; background: inherit; background-color: var(--card, var(--color-bg-card, #fff)); }
.rp-tool { display: grid; place-items: center; width: 36px; height: 36px; border: none; border-radius: 9px; background: none; color: var(--muted, var(--color-text-secondary, #5F615A)); cursor: pointer; transition: background 0.12s, color 0.12s; }
.rp-tool:hover:not(:disabled) { background: var(--warm, rgba(45,47,44,0.06)); color: var(--ink, var(--color-text, #2D2F2C)); }
.rp-tool.is-on { background: var(--yellow-soft, #FFF5C2); color: var(--ink, var(--color-text, #2D2F2C)); }
.rp-tool:disabled { opacity: 0.35; cursor: default; }
.rp-tool:focus-visible { outline: 2px solid var(--ink, var(--color-text, #2D2F2C)); outline-offset: 1px; }
.rp-sep { width: 1px; height: 20px; margin: 0 4px; background: var(--rp-line); }
.rp-bar__end { display: flex; gap: 2px; margin-left: auto; }
.rp-link { flex: 1 1 100%; display: flex; gap: 6px; padding: 4px 2px 0; }
.rp-link__box { flex: 1; min-width: 0; height: 36px; padding: 0 0.7rem; border: 1px solid var(--line-2, var(--color-border-strong, #D3D0C7)); border-radius: 9px; font: inherit; font-size: 0.92rem; background: var(--card, #fff); color: inherit; }
.rp-link__box:focus { outline: none; border-color: var(--ink, var(--color-text, #2D2F2C)); }
.rp-link__go { height: 36px; padding: 0 0.9rem; border: none; border-radius: 9px; background: var(--ink, var(--color-text, #2D2F2C)); color: #fff; font: inherit; font-size: 0.88rem; font-weight: 650; cursor: pointer; }
.rp-link__bad { flex: 1 1 100%; margin: 0; padding: 0 0.2rem; font-size: 0.82rem; font-weight: 600; color: var(--warn, var(--tone-warn-fg, #84550C)); }
.rp-full { font-weight: 650; color: var(--warn, var(--tone-warn-fg, #84550C)); }
.rp-link__go.is-quiet { background: none; color: var(--ink, var(--color-text, #2D2F2C)); border: 1px solid var(--rp-line); }
.rp-page { padding: 1rem 1.15rem 0.6rem; cursor: text; }
.rp-edit { outline: none; min-height: inherit; white-space: pre-wrap; word-wrap: break-word; }
.rp-page .ProseMirror { min-height: inherit; }
.rp-edit p.is-editor-empty:first-child::before { content: attr(data-placeholder); float: left; height: 0; color: var(--quiet, var(--color-text-muted, #8C8E86)); pointer-events: none; }
.rp-edit .ProseMirror-selectednode { outline: 2px solid var(--yellow, #FFDA24); }
/* "New slide here": a dashed line, said; read elsewhere, a quiet rule */
.rp .rp-break { height: 0; margin: 1.3em 0; border: none; border-top: 1px solid var(--rp-line); }
.rp-edit hr { position: relative; height: 0; margin: 1.6em 0; border: none; border-top: 2px dashed var(--line-2, var(--color-border-strong, #D3D0C7)); overflow: visible; cursor: default; }
.rp-edit hr::after { content: 'New slide'; position: absolute; top: 0; left: 50%; transform: translate(-50%, -55%); padding: 0 0.6em; background: var(--card, var(--color-bg-card, #fff)); color: var(--muted, var(--color-text-secondary, #5F615A)); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; line-height: 1.4; }
.rp-edit hr.ProseMirror-selectednode { outline-offset: 6px; }
.rp-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.25rem 1rem; padding: 0.45rem 1.15rem 0.6rem; font-size: 0.8rem; color: var(--muted, var(--color-text-secondary, #5F615A)); font-variant-numeric: tabular-nums; }
.rp-hint kbd { display: inline-block; padding: 0 0.3em; border: 1px solid var(--rp-line); border-radius: 5px; background: var(--warm, #F5F4F0); font: inherit; font-size: 0.95em; line-height: 1.5; }
.rp-foot__status { margin-left: auto; }
/* A phone: the tools in one row, a finger's size (its own undo is the phone's: shake, or three fingers) */
@media (max-width: 640px) { .rp-bar { flex-wrap: nowrap; gap: 0; } .rp-tool { width: 40px; height: 40px; flex: none; } .rp-sep { margin: 0 2px; } .rp-bar__end { display: none; } .rp-link { flex-wrap: wrap; } .rp-bar:has(.rp-link) { flex-wrap: wrap; } .rp-page { padding: 0.85rem 0.9rem 0.5rem; } .rp-foot { padding: 0.45rem 0.9rem 0.6rem; } }
@media print { .rp a { text-decoration: none; } .rp .rp-callout, .rp-motion { background: none; } }
`;
if (typeof document !== 'undefined' && !document.getElementById('board-report-css')) {
  const s = document.createElement('style');
  s.id = 'board-report-css';
  s.textContent = CSS;
  document.head.append(s);
}

/**
 * A shorter version of a report, written by the site's model and checked to say the same things (nothing saved): from
 * Board's agenda (admin) or the board page. → { ok: true, text, words: [before, after] } | { ok: false, error }
 */
export async function shorterVersion({ admin = false, id = '', itemId = '', text = '', title = '' } = {}) {
  let r;
  try {
    r = await fetch(admin ? '/api/board-admin' : '/api/board-portal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'report-shorter', id, meetingId: id, itemId, text, title }),
    });
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
  try {
    const j = await r.json();
    return r.ok ? j : { ...j, ok: false, error: j.error || 'A shorter version couldn’t be written just now.' };
  } catch {
    return { ok: false, error: /cloudflareaccess/i.test(r.url || '') ? 'Your session expired. Reload the page and sign in again.' : 'A shorter version couldn’t be written just now.' };
  }
}
