/**
 * A W-9 a vendor fills in and signs on SOARD's trade-partner page
 * ===========================================================================
 * The page asks what the IRS form asks, in the same order; this checks the
 * answers (checkW9) and writes them onto the IRS's own Form W-9 (Rev. March
 * 2024, ./_w9-irs.js), page 1 only, flattened, with the typed signature, the
 * date and a line saying how and when it was signed electronically. That PDF
 * is the W-9: it goes into JobTread and onto the Mercury recipient like an
 * uploaded one, and the tax ID lives only inside it (never in D1, a log or a
 * JobTread field).
 *
 * The IRS accepts an electronic W-9 when the system makes sure it comes from
 * the person named, keeps the penalties-of-perjury wording, and can produce a
 * copy: the vendor reaches the page from a link sent to their own email,
 * ticks the certification shown word for word, types their name as a
 * signature, and the PDF is the copy.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { W9_PDF_BASE64 } from './_w9-irs.js';

// Line 3a, in the form's order → the checkbox's index on the form
export const TAX_CLASSES = ['individual', 'ccorp', 'scorp', 'partnership', 'trust', 'llc', 'other'];
const FIELD = (n) => `topmostSubform[0].Page1[0].${n}`;
const BOX = (n) => FIELD(`Boxes3a-b_ReadOrder[0].${n}`);

// EIN prefixes the IRS assigns (its "valid EIN prefixes" list)
const EIN_PREFIX = /^(0[1-6]|1[0-6]|2[0-7]|3\d|4[0-8]|5\d|6[0-8]|7[1-7]|8[0-8]|9[0-5]|9[89])/;
const digits = (s) => String(s || '').replace(/\D/g, '');
const clean = (s, max = 120) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Why a tax ID can't be right, or null. type 'ssn' (an SSN or an ITIN) | 'ein' */
export function tinProblem(type, value) {
  const d = digits(value);
  if (d.length !== 9) return 'A tax ID has 9 digits.';
  if (/^(\d)\1{8}$/.test(d)) return 'That number can’t be a real tax ID.';
  if (type === 'ein') return EIN_PREFIX.test(d) ? null : 'That isn’t a number the IRS gives as an EIN. Check the first two digits.';
  const [area, group, serial] = [d.slice(0, 3), d.slice(3, 5), d.slice(5)];
  if (area[0] === '9') {
    // An ITIN goes in the same box: 9XX-(50–65, 70–88, 90–92, 94–99)-XXXX
    const g = Number(group);
    return (g >= 50 && g <= 65) || (g >= 70 && g <= 88) || (g >= 90 && g <= 92) || (g >= 94 && g <= 99) ? null : 'That isn’t a Social Security number or an ITIN. Check the first five digits.';
  }
  if (area === '000' || area === '666' || group === '00' || serial === '0000') return 'That isn’t a Social Security number. Check the digits.';
  return null;
}

/**
 * What the vendor typed → { ok, problems: { field: words }, w9 } where w9 is the cleaned answers.
 * a: { name, business, taxClass, llcClass, otherClass, foreignPartners, exemptPayee, fatca,
 *      address, cityStateZip, tinType, tin, backupWithholding, certify, signature }
 */
export function checkW9(a = {}) {
  const w9 = {
    name: clean(a.name), business: clean(a.business),
    taxClass: TAX_CLASSES.includes(a.taxClass) ? a.taxClass : '',
    llcClass: ['C', 'S', 'P'].includes(String(a.llcClass || '').toUpperCase()) ? String(a.llcClass).toUpperCase() : '',
    otherClass: clean(a.otherClass, 60),
    foreignPartners: a.foreignPartners === true,
    exemptPayee: clean(a.exemptPayee, 4), fatca: clean(a.fatca, 4),
    address: clean(a.address, 80), cityStateZip: clean(a.cityStateZip, 80),
    tinType: a.tinType === 'ein' ? 'ein' : 'ssn', tin: digits(a.tin),
    backupWithholding: a.backupWithholding === true,
    certify: a.certify === true,
    signature: clean(a.signature, 80),
  };
  const problems = {};
  if (w9.name.length < 2) problems.name = 'Line 1 needs the name on your tax return.';
  if (!w9.taxClass) problems.taxClass = 'Pick how your business is taxed.';
  if (w9.taxClass === 'llc' && !w9.llcClass) problems.llcClass = 'Pick C, S or P for the LLC.';
  if (w9.taxClass === 'other' && !w9.otherClass) problems.otherClass = 'Say what kind of entity it is.';
  if (!w9.address) problems.address = 'Add the street address.';
  if (!/\d{5}/.test(w9.cityStateZip)) problems.cityStateZip = 'Add the city, state and ZIP code.';
  const tin = tinProblem(w9.tinType, w9.tin);
  if (tin) problems.tin = tin;
  if (!w9.certify) problems.certify = 'Tick the box to certify the form.';
  if (w9.signature.split(' ').filter(Boolean).length < 2) problems.signature = 'Type your full name to sign.';
  if (!['partnership', 'trust', 'llc'].includes(w9.taxClass) || (w9.taxClass === 'llc' && w9.llcClass !== 'P')) w9.foreignPartners = false;
  return { ok: !Object.keys(problems).length, problems, w9 };
}

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let formBytes = null;

/** Text a standard PDF font can write: accents it can't encode are dropped from the letter, anything else from the line */
function writable(font, s) {
  try { font.encodeText(s); return s; } catch {
    const plain = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    return [...plain].filter((c) => { try { font.encodeText(c); return true; } catch { return false; } }).join('');
  }
}

/**
 * The signed W-9 as PDF bytes (page 1 of the IRS form).
 * w9: checkW9's answers; signedAt: ms; email: who signed (the link's address); ip; tz: for the date;
 * requester: { name, lines: [street, "City, ST ZIP"] } for the form's requester box.
 */
export async function buildW9(w9, { signedAt = Date.now(), email = '', ip = '', tz = 'America/New_York', requester = null } = {}) {
  formBytes ||= b64(W9_PDF_BASE64);
  const doc = await PDFDocument.load(formBytes);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const script = await doc.embedFont(StandardFonts.HelveticaOblique);
  const set = (name, v) => { if (v) form.getTextField(name).setText(writable(font, v)); };
  set(FIELD('f1_01[0]'), w9.name);
  set(FIELD('f1_02[0]'), w9.business);
  form.getCheckBox(BOX(`c1_1[${TAX_CLASSES.indexOf(w9.taxClass)}]`)).check();
  if (w9.taxClass === 'llc') set(BOX('f1_03[0]'), w9.llcClass);
  if (w9.taxClass === 'other') set(BOX('f1_04[0]'), w9.otherClass);
  if (w9.foreignPartners) form.getCheckBox(BOX('c1_2[0]')).check();
  set(FIELD('f1_05[0]'), w9.exemptPayee);
  set(FIELD('f1_06[0]'), w9.fatca);
  set(FIELD('Address_ReadOrder[0].f1_07[0]'), w9.address);
  set(FIELD('Address_ReadOrder[0].f1_08[0]'), w9.cityStateZip);
  if (requester) {
    const box = form.getTextField(FIELD('f1_09[0]'));
    box.enableMultiline();
    box.setText([requester.name, ...(requester.lines || [])].map((l) => writable(font, l)).join('\n'));
  }
  if (w9.tinType === 'ssn') {
    set(FIELD('f1_11[0]'), w9.tin.slice(0, 3)); set(FIELD('f1_12[0]'), w9.tin.slice(3, 5)); set(FIELD('f1_13[0]'), w9.tin.slice(5));
  } else {
    set(FIELD('f1_14[0]'), w9.tin.slice(0, 2)); set(FIELD('f1_15[0]'), w9.tin.slice(2));
  }
  form.updateFieldAppearances(font);
  form.flatten();
  for (let i = doc.getPageCount() - 1; i > 0; i--) doc.removePage(i);
  const page = doc.getPage(0);
  const ink = rgb(0.1, 0.12, 0.4);
  // Certification item 2, crossed out when the IRS has said they're subject to backup withholding
  if (w9.backupWithholding) for (const [y, end] of [[305.5, 574], [296, 574], [286.5, 208]]) page.drawLine({ start: { x: 58, y }, end: { x: end, y }, thickness: 0.8, color: ink });
  const day = new Date(signedAt).toLocaleDateString('en-US', { timeZone: tz, month: '2-digit', day: '2-digit', year: 'numeric' });
  page.drawText(writable(script, w9.signature), { x: 140, y: 197, size: 14, font: script, color: ink });
  page.drawText(day, { x: 400, y: 198, size: 11, font, color: ink });
  const when = new Date(signedAt).toLocaleString('en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const record = `Signed electronically by ${w9.signature}${email ? ` (${email})` : ''} on ${when} at sunshineonaranneyday.com${ip ? ` from ${ip}` : ''}.`;
  page.drawText(writable(font, record).slice(0, 190), { x: 36, y: 10, size: 6.5, font, color: rgb(0.35, 0.35, 0.35) });
  doc.setTitle(`Form W-9: ${writable(font, w9.business || w9.name)}`);
  doc.setProducer('Sunshine on a Ranney Day');
  return doc.save();
}
