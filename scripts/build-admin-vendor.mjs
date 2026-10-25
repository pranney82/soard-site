/**
 * build-admin-vendor.mjs
 * ======================
 * Bundles every third-party module the admin panel (public/admin/index.html)
 * needs into ONE minified ESM file: public/admin/vendor.js.
 *
 * Why: the admin previously imported ~12 modules from esm.sh at runtime —
 * a supply-chain risk (no integrity pinning) and a hard availability
 * dependency (esm.sh down = admin down). Bundling from the exact pinned
 * npm versions removes both.
 *
 * The built vendor.js is COMMITTED to the repo, so deploys need no extra
 * build step. Re-run this script only when bumping a dependency version:
 *
 *   npm run build:admin-vendor
 *
 * The entry re-exports precisely the symbols the admin imports; the admin
 * pulls them all from './vendor.js' with identical names.
 */

import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every symbol public/admin/index.html imports, re-exported under the same name.
// tus-js-client resolves to lib.esm/browser/index.js via its "browser" field
// (the same file the old esm.sh URL pointed at). @tiptap/* packages import
// @tiptap/pm/<subpath> internally; esbuild resolves those from node_modules,
// so the old importmap (and the ?external=@tiptap/pm hack) are unnecessary.
const entry = `
export { h, render, Component } from 'preact';
export { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
export { default as htm } from 'htm';
export * as tus from 'tus-js-client';
export { default as DOMPurify } from 'dompurify';
export { default as Sortable } from 'sortablejs';
export { Editor } from '@tiptap/core';
export { default as StarterKit } from '@tiptap/starter-kit';
export { default as TiptapUnderline } from '@tiptap/extension-underline';
export { default as TiptapLink } from '@tiptap/extension-link';
export { default as Placeholder } from '@tiptap/extension-placeholder';
export { default as CharacterCount } from '@tiptap/extension-character-count';
export { default as qrcode } from 'qrcode-generator';
`;

// Record the exact bundled versions in the banner for auditability.
const pkgVersion = (name) =>
  JSON.parse(readFileSync(join(rootDir, 'node_modules', name, 'package.json'), 'utf8')).version;

const pinned = [
  'preact', 'htm', 'tus-js-client', 'dompurify', 'sortablejs',
  '@tiptap/core', '@tiptap/pm', '@tiptap/starter-kit',
  '@tiptap/extension-underline', '@tiptap/extension-link',
  '@tiptap/extension-placeholder', '@tiptap/extension-character-count',
  'qrcode-generator',
];
const banner = `/*! SOARD admin vendor bundle — built by scripts/build-admin-vendor.mjs
 * ${pinned.map((n) => `${n}@${pkgVersion(n)}`).join(' | ')}
 * All bundled packages are MIT-licensed. Do not edit by hand.
 */`;

const result = await esbuild.build({
  stdin: {
    contents: entry,
    resolveDir: rootDir,
    sourcefile: 'admin-vendor-entry.js',
    loader: 'js',
  },
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2020',
  platform: 'browser',
  outfile: join(rootDir, 'public/admin/vendor.js'),
  banner: { js: banner },
  legalComments: 'none',
  metafile: true,
  logLevel: 'info',
});

const out = result.metafile.outputs['public/admin/vendor.js'];
console.log(`vendor.js written: ${(out.bytes / 1024).toFixed(1)} KB (minified, pre-gzip)`);

// hls.js gets its own file: only the Broadcast control room needs it, and it
// is bigger than everything else combined, so the admin imports it lazily.
// Full build, not hls.light: Stream serves audio as a separate rendition group.
const hls = await esbuild.build({
  stdin: {
    contents: `export { default as Hls } from 'hls.js';`,
    resolveDir: rootDir,
    sourcefile: 'admin-vendor-hls-entry.js',
    loader: 'js',
  },
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2020',
  platform: 'browser',
  outfile: join(rootDir, 'public/admin/vendor-hls.js'),
  banner: { js: `/*! SOARD admin vendor bundle (lazy) — built by scripts/build-admin-vendor.mjs\n * hls.js@${pkgVersion('hls.js')} (Apache-2.0). Do not edit by hand.\n */` },
  legalComments: 'none',
  metafile: true,
  logLevel: 'info',
});
const hlsOut = hls.metafile.outputs['public/admin/vendor-hls.js'];
console.log(`vendor-hls.js written: ${(hlsOut.bytes / 1024).toFixed(1)} KB (minified, pre-gzip)`);

// Leaflet gets its own lazy file too: only the Applicants map
// (public/admin/applicants.js) needs it. Its stylesheet comes along as text
// so the admin can inject it next to the map (no CDN in the admin CSP).
const map = await esbuild.build({
  stdin: {
    contents: `export { default as L } from 'leaflet';\nexport { default as leafletCss } from 'leaflet/dist/leaflet.css';`,
    resolveDir: rootDir,
    sourcefile: 'admin-vendor-map-entry.js',
    loader: 'js',
  },
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2020',
  platform: 'browser',
  loader: { '.css': 'text', '.png': 'empty' },
  outfile: join(rootDir, 'public/admin/vendor-map.js'),
  banner: { js: `/*! SOARD admin vendor bundle (lazy) — built by scripts/build-admin-vendor.mjs\n * leaflet@${pkgVersion('leaflet')} (BSD-2-Clause). Do not edit by hand.\n */` },
  legalComments: 'none',
  metafile: true,
  logLevel: 'info',
});
const mapOut = map.metafile.outputs['public/admin/vendor-map.js'];
console.log(`vendor-map.js written: ${(mapOut.bytes / 1024).toFixed(1)} KB (minified, pre-gzip)`);

// pdf.js (the file viewer's PDFs) is built by its own script: it isn't in package.json
await import('./build-admin-pdf.mjs');
