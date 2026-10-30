/**
 * build-trade-partners-pdf.mjs
 * ============================
 * pdf.js for the trade-partner page (src/components/trade-partners/files.ts), which draws
 * the first pages of a PDF a vendor adds as pictures, so the reader sees a
 * W-9's signature and the boxes typed into a form the way a person does (a
 * PDF's text has neither). The admin's copy (scripts/build-admin-pdf.mjs)
 * sits behind Cloudflare Access, so the public page gets its own:
 *
 *   node scripts/build-trade-partners-pdf.mjs
 *
 * Writes (all committed, like the admin's):
 *   public/trade-partners/pdf/pdf.js            pdf.js, imported the first time a PDF is added
 *   public/trade-partners/pdf/pdf.worker.js     its worker
 *   public/trade-partners/pdf/standard_fonts/   the fonts a PDF names without embedding them
 *   public/trade-partners/pdf/wasm/             the JavaScript decoders for JPEG 2000 and JBIG2 scans
 *
 * The same pinned version and legacy build as the admin's, for the same reason:
 * older iPhones and Macs. pdfjs-dist is installed into a temporary folder, not package.json.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PDFJS = '6.4.299';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public/trade-partners/pdf');

// What the legacy build still expects from 2024 (Safari 17.4), page and worker
const POLYFILLS = `if (!Promise.withResolvers) Promise.withResolvers = function () { let resolve, reject; const promise = new this((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
if (typeof AbortSignal !== 'undefined' && !AbortSignal.any) AbortSignal.any = function (signals) { const c = new AbortController(); for (const s of signals) { if (s.aborted) { c.abort(s.reason); break; } s.addEventListener('abort', () => c.abort(s.reason), { once: true, signal: c.signal }); } return c.signal; };
`;

const tmp = mkdtempSync(join(tmpdir(), 'soard-pdfjs-'));
try {
  execFileSync('npm', ['install', '--no-save', '--no-package-lock', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', '--prefix', tmp, `pdfjs-dist@${PDFJS}`], { stdio: ['ignore', 'ignore', 'inherit'] });
  const pkg = join(tmp, 'node_modules/pdfjs-dist');
  const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
  if (version !== PDFJS) throw new Error(`expected pdfjs-dist ${PDFJS}, got ${version}`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'wasm'), { recursive: true });
  const head = (file) => `/*! SOARD trade-partner page file (lazy) — copied by scripts/build-trade-partners-pdf.mjs
 * pdfjs-dist@${version} legacy/build/${file} (Apache-2.0), after two small fallbacks. Do not edit by hand.
 */
${POLYFILLS}`;
  for (const [from, to] of [['pdf.min.mjs', 'pdf.js'], ['pdf.worker.min.mjs', 'pdf.worker.js']]) {
    const code = readFileSync(join(pkg, 'legacy/build', from), 'utf8');
    writeFileSync(join(outDir, to), head(from) + code);
    console.log(`${to} written: ${(code.length / 1024).toFixed(1)} KB`);
  }
  cpSync(join(pkg, 'standard_fonts'), join(outDir, 'standard_fonts'), { recursive: true });
  for (const f of readdirSync(join(pkg, 'wasm'))) {
    if (/_nowasm_fallback\.js$|^LICENSE_(PDFJS_)?(JBIG2|OPENJPEG)$/.test(f)) cpSync(join(pkg, 'wasm', f), join(outDir, 'wasm', f));
  }
  cpSync(join(pkg, 'LICENSE'), join(outDir, 'LICENSE'));
  console.log(`fonts and decoders written: ${readdirSync(join(outDir, 'standard_fonts')).length} fonts, ${readdirSync(join(outDir, 'wasm')).length} decoder files`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
