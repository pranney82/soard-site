#!/usr/bin/env node
/**
 * Generate Low-Quality Image Placeholders (LQIP) for kid hero images.
 *
 * Fetches a tiny (20px wide) version of each hero image from Cloudflare Images,
 * converts to base64 data URIs, and writes a JSON manifest that the Astro build
 * can inline as blurred background-image placeholders.
 *
 * Run: node scripts/generate-lqip.js
 * Output: src/data/lqip-kids.json  →  { "kids/alex/hero": "data:image/jpeg;base64,..." }
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { cfId, CF_BASE } from './cf-image-shared.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const KIDS_DIR = join(ROOT, 'src', 'content', 'kids');
const OUT_DIR = join(ROOT, 'src', 'data');
const OUT_FILE = join(OUT_DIR, 'lqip-kids.json');

// Tiny placeholder dimensions — 20px wide is ~100-300 bytes
const LQIP_WIDTH = 20;
const LQIP_QUALITY = 15;

async function fetchLqip(imageId) {
  const url = `${CF_BASE}/${imageId}/w=${LQIP_WIDTH},q=${LQIP_QUALITY},fit=cover,gravity=face`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  return `data:${contentType};base64,${buf.toString('base64')}`;
}

async function main() {
  if (!existsSync(KIDS_DIR)) {
    console.error('No kids content directory found. Run prebuild first.');
    process.exit(1);
  }

  // Load existing manifest to avoid re-fetching unchanged images
  let existing = {};
  if (existsSync(OUT_FILE)) {
    try {
      existing = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    } catch { /* start fresh */ }
  }

  const files = readdirSync(KIDS_DIR).filter(f => f.endsWith('.json'));
  console.log(`LQIP: processing ${files.length} kids...\n`);

  const manifest = {};
  let fetched = 0;
  let cached = 0;
  let skipped = 0;

  // Process in batches of 10 to avoid overwhelming CF
  const BATCH = 10;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    await Promise.all(batch.map(async (file) => {
      try {
        const data = JSON.parse(readFileSync(join(KIDS_DIR, file), 'utf8'));
        if (!data.heroImage) {
          skipped++;
          return;
        }

        const id = cfId(data.heroImage);
        if (!id) {
          skipped++;
          return;
        }

        // Use cached version if available
        if (existing[id]) {
          manifest[id] = existing[id];
          cached++;
          return;
        }

        const dataUri = await fetchLqip(id);
        if (dataUri) {
          manifest[id] = dataUri;
          fetched++;
        } else {
          console.warn(`  ⚠ Failed to fetch LQIP for ${id}`);
          skipped++;
        }
      } catch (err) {
        console.warn(`  ⚠ Error processing ${file}: ${err.message}`);
        skipped++;
      }
    }));
    // Progress
    const done = Math.min(i + BATCH, files.length);
    process.stdout.write(`  ${done}/${files.length} processed\r`);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`\nLQIP complete: ${fetched} fetched, ${cached} cached, ${skipped} skipped`);
  console.log(`  Manifest: ${Object.keys(manifest).length} entries → ${OUT_FILE}\n`);
}

main().catch(err => {
  console.error('LQIP generation failed:', err);
  process.exit(1);
});
