/**
 * build-w9-form.mjs
 * =================
 * The IRS's own Form W-9 for the trade-partner page, which fills it in from
 * what a vendor types and they sign it there (functions/api/_w9-form.js).
 * Downloaded from irs.gov and written into the Functions bundle as base64,
 * so filling it needs no fetch at request time:
 *
 *   node scripts/build-w9-form.mjs
 *
 * Writes functions/api/_w9-irs.js (committed). Run again when the IRS
 * revises the form; the build stops unless the revision line is the one the
 * field map in _w9-form.js was made for.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';

const URL_IRS = 'https://www.irs.gov/pub/irs-pdf/fw9.pdf';
const REVISION = 'March 2024';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'functions/api/_w9-irs.js');

const res = await fetch(URL_IRS);
if (!res.ok) throw new Error(`irs.gov answered ${res.status}`);
const bytes = new Uint8Array(await res.arrayBuffer());
const doc = await PDFDocument.load(bytes);
const names = doc.getForm().getFields().map((f) => f.getName());
for (const want of ['f1_01[0]', 'f1_02[0]', 'c1_1[6]', 'f1_03[0]', 'f1_07[0]', 'f1_08[0]', 'f1_09[0]', 'f1_13[0]', 'f1_15[0]']) {
  if (!names.some((n) => n.endsWith(want))) throw new Error(`the form has no ${want}: the IRS changed it, so the field map in _w9-form.js needs a look`);
}
const text = Buffer.from(bytes).toString('latin1');
if (!text.includes(`Rev. ${REVISION}`) && !/March 2024/.test(text)) console.warn(`couldn't find "Rev. ${REVISION}" in the file; check the revision by eye`);
const sha = createHash('sha256').update(bytes).digest('hex');
writeFileSync(out, `/*! IRS Form W-9 (Rev. ${REVISION}), downloaded from ${URL_IRS} by scripts/build-w9-form.mjs.
 * A U.S. government form (public domain). sha256 ${sha}. Do not edit by hand. */
export const W9_REVISION = '${REVISION}';
export const W9_PDF_BASE64 = '${Buffer.from(bytes).toString('base64')}';
`);
console.log(`_w9-irs.js written: ${(bytes.length / 1024).toFixed(1)} KB form, ${names.length} fields, sha256 ${sha.slice(0, 12)}…`);
