/**
 * The application as a PDF
 * ===========================================================================
 * One file, two readers: it's attached to the family's JobTread account as
 * "{Child}_Application.pdf" (what staff used to download from Jotform by
 * hand) and to the family's confirmation email as their copy.
 *
 * Every answered question in form order, then the photos. Built with pdf-lib's
 * standard Helvetica, so nothing is fetched at runtime; characters Helvetica
 * can't draw (emoji, most non-Latin scripts) are dropped from the PDF only,
 * the full text stays in D1 and in JobTread's fields.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { answerSections, nameText } from './_application-form.js';

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

const DARK = rgb(0x37 / 255, 0x3a / 255, 0x36 / 255);
const MUTED = rgb(0x5a / 255, 0x5b / 255, 0x61 / 255);
const YELLOW = rgb(1, 0xda / 255, 0x24 / 255);
const RULE = rgb(0xe5 / 255, 0xe4 / 255, 0xe0 / 255);

const PHOTO_LABELS = {
  photoChild: 'The child',
  photoFamily: 'The child with their family',
  photoSpace1: 'The space',
  photoSpace2: 'The space (second picture)',
};

/** Drop characters a standard font can't encode (keeps tabs as spaces) */
function sanitizer(font) {
  const ok = new Set(font.getCharacterSet());
  return (s) => {
    let out = '';
    for (const ch of String(s ?? '').replace(/\t/g, ' ').replace(/\r\n?/g, '\n')) {
      if (ch === '\n' || ok.has(ch.codePointAt(0))) out += ch;
    }
    return out;
  };
}

/** Word-wrap one paragraph-ish string to lines that fit `width` */
function wrap(text, font, size, width) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    if (!para.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      // A single word wider than the line (a long URL): hard-break it
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width) {
        let n = rest.length;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * @param {object} p
 * @param {object} p.form        applicationForm({ year })
 * @param {object} p.answers     cleaned answers
 * @param {object} p.files       the application's file records
 * @param {string} p.submittedAt ISO time
 * @param {Record<string, Uint8Array>} [p.photos] JPEG bytes by photo field id (thumbnails)
 * @returns {Promise<Uint8Array>}
 */
export async function buildApplicationPdf({ form, answers, files = {}, submittedAt, photos = {} }) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = sanitizer(regular);
  const childName = clean(nameText(answers.childName)) || 'Application';
  const submitted = new Date(submittedAt || Date.now()).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
  });

  doc.setTitle(`${childName} Application`);
  doc.setAuthor('Sunshine on a Ranney Day');
  doc.setSubject(form.title);
  doc.setCreator('sunshineonaranneyday.com');

  let page;
  let y;
  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const ensure = (h) => { if (y - h < MARGIN + 24) newPage(); };

  // ── Cover header ──
  newPage();
  page.drawRectangle({ x: 0, y: PAGE_H - 132, width: PAGE_W, height: 132, color: YELLOW });
  page.drawText('Sunshine on a Ranney Day', { x: MARGIN, y: PAGE_H - 52, size: 11, font: bold, color: DARK });
  page.drawText(clean(`${form.year} Makeover Application`), { x: MARGIN, y: PAGE_H - 86, size: 24, font: bold, color: DARK });
  page.drawText(clean(`${childName}  ·  Submitted ${submitted}`), { x: MARGIN, y: PAGE_H - 110, size: 10.5, font: regular, color: DARK });
  y = PAGE_H - 132 - 32;

  const sections = answerSections(form, answers, files);
  for (const s of sections) {
    const items = s.items.filter(i => !i.upload);
    if (!items.length) continue;
    ensure(48);
    page.drawText(clean(s.title), { x: MARGIN, y: y - 14, size: 13.5, font: bold, color: DARK });
    y -= 22;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: RULE });
    y -= 14;
    for (const item of items) {
      const labelLines = wrap(clean(item.label), bold, 9, CONTENT_W);
      const textLines = wrap(clean(item.text), regular, 10.5, CONTENT_W);
      ensure(labelLines.length * 12 + Math.min(textLines.length, 4) * 14 + 10);
      for (const l of labelLines) { page.drawText(l, { x: MARGIN, y: y - 9, size: 9, font: bold, color: MUTED }); y -= 12; }
      y -= 3;
      for (const l of textLines) {
        ensure(14);
        page.drawText(l, { x: MARGIN, y: y - 10.5, size: 10.5, font: regular, color: DARK });
        y -= 14;
      }
      y -= 10;
    }
    y -= 8;
  }

  // ── Photos and video ──
  const photoIds = Object.keys(PHOTO_LABELS).filter(id => files[id]);
  if (photoIds.length || files.video) {
    ensure(60);
    page.drawText('Photos and Video', { x: MARGIN, y: y - 14, size: 13.5, font: bold, color: DARK });
    y -= 22;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: RULE });
    y -= 16;
    const cellW = (CONTENT_W - 18) / 2;
    const cellH = 200;
    for (let i = 0; i < photoIds.length; i += 2) {
      ensure(cellH + 30);
      for (let c = 0; c < 2 && i + c < photoIds.length; c++) {
        const id = photoIds[i + c];
        const x = MARGIN + c * (cellW + 18);
        page.drawText(PHOTO_LABELS[id], { x, y: y - 9, size: 9, font: bold, color: MUTED });
        const bytes = photos[id];
        let drawn = false;
        if (bytes) {
          try {
            const img = await doc.embedJpg(bytes);
            const scale = Math.min(cellW / img.width, cellH / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            page.drawImage(img, { x, y: y - 16 - h, width: w, height: h });
            drawn = true;
          } catch { /* not a JPEG we can read: note it instead */ }
        }
        if (!drawn) page.drawText('Photo received (attached separately)', { x, y: y - 30, size: 10, font: regular, color: DARK });
      }
      y -= cellH + 30;
    }
    if (files.video) {
      ensure(30);
      page.drawText('Video', { x: MARGIN, y: y - 9, size: 9, font: bold, color: MUTED });
      y -= 15;
      page.drawText('Video received (sent to SOARD with this application).', { x: MARGIN, y: y - 10.5, size: 10.5, font: regular, color: DARK });
      y -= 20;
    }
  }

  // ── Footer on every page ──
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = clean(`${childName}  ·  ${form.year} Application  ·  Page ${i + 1} of ${pages.length}`);
    p.drawText(label, { x: MARGIN, y: 30, size: 8.5, font: regular, color: MUTED });
  });

  return doc.save();
}
