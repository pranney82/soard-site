/**
 * The board page → Print it all
 * ===========================================================================
 * One print of a meeting, for anyone who wants it on paper: the agenda first
 * (who presents each item, its background, its numbers, the documents that
 * go with it), then each document, page by page, in the agenda's order, each
 * starting on a new sheet with what it is at the top. The browser's print
 * window then prints it, or saves it as one PDF.
 *
 * The pages are the ones the screen shows (./docs.js), so the printed
 * "page 3" is the screen's page 3. Built with the DOM's own text (never a
 * file's HTML), and taken away again once the print window closes.
 */

import { openDoc } from './docs.js';
import {
  meetingName, longDate, timeRange, liveLines, noteBlocks, agendaItems, presentersOf, itemFiles, looseFiles, fileTitle, isDate, MORE,
} from '../board-shared.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; };

function points(text) {
  const blocks = noteBlocks(text);
  if (!blocks.length) return null;
  const wrap = el('div', 'bpp-notes');
  const list = (nodes) => { const ul = el('ul'); for (const n of nodes) { const li = el('li', '', n.text); if (n.children.length) li.append(list(n.children)); ul.append(li); } return ul; };
  let run = [];
  for (const b of blocks) {
    if (b.para) { if (run.length) { wrap.append(list(run)); run = []; } wrap.append(el('p', '', b.text)); } else run.push(b);
  }
  if (run.length) wrap.append(list(run));
  return wrap;
}

/** The agenda as the first pages: the meeting, then each section and item */
function agendaPages(m, { people, numbers, meetings }) {
  const sheet = el('section', 'bpp-agenda');
  const head = el('header', 'bpp-head');
  head.append(el('p', 'bpp-eyebrow', 'Sunshine on a Ranney Day · Board of Directors'), el('h1', 'bpp-title', meetingName(m)));
  const when = [isDate(m.date) ? longDate(m.date) : '', timeRange(m.start, m.end)].filter(Boolean).join(' · ');
  if (when) head.append(el('p', 'bpp-when', when));
  const place = [m.location, m.address].filter(Boolean).join(', ');
  if (place) head.append(el('p', 'bpp-muted', place));
  sheet.append(head);
  const items = agendaItems(m);
  const ol = el('ol', 'bpp-secs');
  m.sections.filter((s) => s.title || s.items.length).forEach((s) => {
    const li = el('li', 'bpp-sec');
    li.append(el('h2', 'bpp-sec__title', s.title || 'Agenda'));
    for (const it of s.items) {
      const row = el('div', 'bpp-item');
      const t = el('h3', 'bpp-item__title');
      const n = items.find((x) => x.id === it.id);
      t.append(el('span', 'bpp-num', n?.label || ''), el('span', '', it.title || 'Item'));
      const who = presentersOf(it, people).map((p) => p.name);
      if (who.length) t.append(el('span', 'bpp-who', who.join(' & ')));
      row.append(t);
      if (it.confidential) row.append(el('p', 'bpp-flag', 'Board only · please don’t share'));
      const notes = points(it.notes);
      if (notes) row.append(notes);
      const lines = it.live && it.live !== 'minutes' ? liveLines(it.live, numbers, { meetingId: m.id }) : [];
      if (lines.length) { const box = el('ul', 'bpp-live'); for (const l of lines) box.append(el('li', '', l)); row.append(box); }
      const files = itemFiles(m, it, meetings);
      if (files.length) row.append(el('p', 'bpp-docs', `With it: ${files.map((f) => fileTitle(f.name)).join(', ')}`));
      li.append(row);
    }
    ol.append(li);
  });
  sheet.append(ol);
  return sheet;
}

/**
 * Print a meeting with every document. `onStep({ done, of, what })` hears how far it has got; `signal` (an
 * AbortSignal) stops it. Resolves once the print window has closed.
 */
export async function printAll(m, { people = [], numbers = null, meetings = [], onStep = () => {}, signal } = {}) {
  const items = agendaItems(m);
  const groups = [
    ...m.sections.flatMap((s) => s.items).map((it) => ({ it, label: items.find((x) => x.id === it.id)?.label || '', files: itemFiles(m, it, meetings) })),
    { it: MORE, label: '', files: looseFiles(m) },
  ].filter((g) => g.files.length);
  const urls = [];
  const root = el('div', 'bpp');
  root.setAttribute('aria-hidden', 'true');
  root.append(agendaPages(m, { people, numbers, meetings }));
  // How many pages, so the progress can say "12 of 40"
  const docs = [];
  for (const g of groups) for (const f of g.files) {
    if (signal?.aborted) return;
    onStep({ done: 0, of: 0, what: fileTitle(f.name) });
    const doc = await openDoc(f).catch(() => null);
    if (doc) docs.push({ g, f, doc });
  }
  const of = docs.reduce((n, x) => n + x.doc.count, 0);
  let done = 0;
  for (const { g, f, doc } of docs) {
    for (let i = 0; i < doc.count; i++) {
      if (signal?.aborted) return;
      onStep({ done, of, what: fileTitle(f.name) });
      const size = doc.size(i);
      const wide = size.w > size.h;
      const page = el('section', `bpp-page ${wide ? 'is-wide' : ''}`);
      if (i === 0) {
        const cap = el('p', 'bpp-cap');
        cap.append(el('b', '', g.label ? `${g.label} ${g.it.title}` : g.it.title), document.createTextNode(` · ${fileTitle(f.name)}${doc.count > 1 ? ` · ${doc.count} pages` : ''}`));
        page.append(cap);
      }
      // Drawn at the printed sheet's width, sharp enough for paper
      const drawn = await doc.draw(i, { width: wide ? 960 : 720, dpr: 2 }).catch(() => null);
      if (drawn) page.append(await asPicture(drawn, urls));
      root.append(page);
      done += 1;
    }
  }
  onStep({ done: of, of, what: '' });
  if (signal?.aborted) return;
  document.body.append(root);
  document.documentElement.classList.add('bp-printing-all');
  await new Promise((resolve) => {
    const finish = () => { removeEventListener('afterprint', finish); resolve(); };
    addEventListener('afterprint', finish);
    // Images drawn from canvases are ready at once; a moment for the layout first
    requestAnimationFrame(() => setTimeout(() => window.print(), 50));
  });
  document.documentElement.classList.remove('bp-printing-all');
  root.remove();
  urls.forEach((u) => URL.revokeObjectURL(u));
}

/** A drawn page with a canvas in it, as a JPEG picture instead (forty pages of canvases would fill a phone's memory) */
async function asPicture(node, urls) {
  const canvas = node instanceof HTMLCanvasElement ? node : node.querySelector?.(':scope > canvas');
  if (!canvas) return node;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) return node;
  const url = URL.createObjectURL(blob);
  urls.push(url);
  const img = el('img', 'bpp-img');
  img.src = url;
  img.alt = '';
  img.style.width = canvas.style.width || `${canvas.clientWidth || 720}px`;
  canvas.width = 0;
  canvas.height = 0;
  if (node === canvas) return img;
  canvas.replaceWith(img);
  return node;
}
