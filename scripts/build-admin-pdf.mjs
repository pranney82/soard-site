/**
 * build-admin-pdf.mjs
 * ===================
 * pdf.js for the admin's file viewer (public/admin/file-viewer.js), which
 * shows a PDF inside the admin instead of sending it to a new tab. Run by
 * scripts/build-admin-vendor.mjs, or on its own:
 *
 *   node scripts/build-admin-pdf.mjs
 *
 * Writes (all committed, like the other vendor bundles):
 *   public/admin/vendor-pdf.js         pdf.js + its page viewer + the viewer's CSS, imported lazily
 *   public/admin/vendor-pdf.worker.js  pdf.js's worker, which reads the PDF off the page's thread
 *   public/admin/pdf/standard_fonts/   the fonts a PDF names without embedding them
 *                                      (pdf-lib's Helvetica in our own application PDF)
 *   public/admin/pdf/wasm/             the JavaScript image decoders (JPEG 2000, JBIG2 in scans).
 *                                      The admin's CSP has no 'wasm-unsafe-eval', so
 *                                      pdf.js runs with useWasm: false and imports these instead.
 *
 * pdfjs-dist isn't in package.json: its optional native canvas (for Node)
 * would download into every Pages build for nothing. The exact version is
 * installed into a temporary folder here instead; npm checks it against the
 * registry's integrity hash.
 */

import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PDFJS = '6.4.299';
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const adminDir = join(rootDir, 'public/admin');

// pdf_viewer.css also styles pdf.js's own app (.sidebar, .dialog, .toggle-button…), which would
// restyle the admin. Keep the rules for what the viewer draws: pages, their text and links.
const KEEP = /^(\.pdfViewer|\.page\b(?!:has)|\.canvasWrapper|\.textLayer|\.annotationLayer|:is\(\.annotationLayer|\.hiddenCanvasElement|\.dummyPage|\[data-main-rotation)/;
function cssBlocks(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open < 0) break;
    const semi = s.indexOf(';', i);
    if (semi >= 0 && semi < open) { i = semi + 1; continue; } // a stray @import/@charset line
    let depth = 1;
    let j = open + 1;
    while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
    out.push({ sel: s.slice(i, open).trim(), body: s.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}
function pageRules(css) {
  return cssBlocks(css).map(({ sel, body }) => {
    if (/^@(media|supports)/.test(sel)) { const inner = pageRules(body); return inner.trim() ? `${sel}{${inner}}` : ''; }
    if (sel.startsWith('@')) return /^@(keyframes|property)/.test(sel) ? `${sel}{${body}}` : '';
    if (sel === ':root') return `.fv{${body}}`;
    return sel.split(',').every((x) => KEEP.test(x.trim())) ? `${sel}{${body}}` : '';
  }).join('');
}

const tmp = mkdtempSync(join(tmpdir(), 'soard-pdfjs-'));
try {
  execFileSync('npm', ['install', '--no-save', '--no-package-lock', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', '--prefix', tmp, `pdfjs-dist@${PDFJS}`], { stdio: ['ignore', 'ignore', 'inherit'] });
  const pkg = join(tmp, 'node_modules/pdfjs-dist');
  const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
  if (version !== PDFJS) throw new Error(`expected pdfjs-dist ${PDFJS}, got ${version}`);

  // The page viewer's stylesheet, minified: only the pages, text and links (the admin draws its own
  // controls), and its variables on the viewer instead of :root, so nothing else in the admin changes
  const rawCss = readFileSync(join(pkg, 'web/pdf_viewer.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\((?!["']?data:)[^)]*\)/g, 'none');
  const { code: css } = await esbuild.transform(pageRules(rawCss), { loader: 'css', minify: true, logLevel: 'warning' });

  // web/pdf_viewer.mjs reads pdf.js from globalThis.pdfjsLib, so that's set first
  writeFileSync(join(tmp, 'global.js'), `import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor-pdf.worker.js', import.meta.url).href;
export { pdfjsLib };
`);
  writeFileSync(join(tmp, 'entry.js'), `export { pdfjsLib } from './global.js';
export { PDFViewer, EventBus, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
export const pdfCss = ${JSON.stringify(css)};
`);
  const banner = `/*! SOARD admin vendor bundle (lazy) — built by scripts/build-admin-pdf.mjs
 * pdfjs-dist@${version} (Apache-2.0). Do not edit by hand.
 */`;
  const built = await esbuild.build({
    entryPoints: [join(tmp, 'entry.js')],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    outfile: join(adminDir, 'vendor-pdf.js'),
    banner: { js: banner },
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
  });
  const out = Object.values(built.metafile.outputs)[0];
  console.log(`vendor-pdf.js written: ${(out.bytes / 1024).toFixed(1)} KB (minified, pre-gzip)`);

  const worker = readFileSync(join(pkg, 'build/pdf.worker.min.mjs'), 'utf8');
  writeFileSync(join(adminDir, 'vendor-pdf.worker.js'), `/*! SOARD admin vendor file (lazy) — copied by scripts/build-admin-pdf.mjs
 * pdfjs-dist@${version} build/pdf.worker.min.mjs (Apache-2.0). Do not edit by hand.
 */
${worker}`);
  console.log(`vendor-pdf.worker.js written: ${(worker.length / 1024).toFixed(1)} KB`);

  const assets = join(adminDir, 'pdf');
  rmSync(assets, { recursive: true, force: true });
  cpSync(join(pkg, 'standard_fonts'), join(assets, 'standard_fonts'), { recursive: true });
  mkdirSync(join(assets, 'wasm'), { recursive: true });
  for (const f of readdirSync(join(pkg, 'wasm'))) {
    if (/_nowasm_fallback\.js$|^LICENSE_(PDFJS_)?(JBIG2|OPENJPEG)$/.test(f)) cpSync(join(pkg, 'wasm', f), join(assets, 'wasm', f));
  }
  cpSync(join(pkg, 'LICENSE'), join(assets, 'LICENSE'));
  console.log(`pdf/ written: ${readdirSync(join(assets, 'standard_fonts')).length} standard fonts, ${readdirSync(join(assets, 'wasm')).length} decoder files`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
